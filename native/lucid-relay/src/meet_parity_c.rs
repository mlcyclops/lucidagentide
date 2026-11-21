// Parity wave C (contract PC-1), the relay's part (meet_relay._ParityC): the org policy store (`/v1/org/policy`, hello
// `org_policies` and `signer_policy`), app and archive sessions (`/v1/apps/c/*`), the apps directory and its icons,
// the member-log ops `archive`, `unarchive`, `link_app` and `unlink_app`, the DM device set with archives, retention
// from the signed policies, legal holds (`/v1/admin/holds`, the hold store and its hash-chained audit), the SSO
// service's asks and pending adds, and the enclave. A child module of meet_hub: it shares the hub's one lock. Persisted
// in state.json as the Python keeps it: `ext["pc"]` = {v, policies: [signed], holds, kept, sso, adds, docs,
// signer_policy, audit}; the hold store is state_dir/holds (a temporary folder without a state folder), app icons
// state_dir/app-icons/<sha256>.png (in memory without a state folder).

use super::*;
use crate::meet_org_policy as op;
use crate::meet_tls::{crl_parts, crl_path, read_bytes, write_atomic};
use crate::meet_x509::Crl;
use std::net::IpAddr;
use std::path::Path;

// ── words and limits (contract PC-1, exact) ──────────────────────────────────────────────────────────────────

/// The PC-1 releases: service entries wait until the relay's minimums reach them.
const PC1_CLIENTS: [(&str, &str); 2] = [("hub", "0.95.0"), ("ios", "0.95.0")];
pub(crate) const APP_ROUTES_ONLY: &str = "apps use the app routes only";
pub(crate) const SSO_ROUTES_ONLY: &str = "the SSO service uses the SSO routes only";
pub(crate) const APPS_ONLY: &str = "only an app or archive certificate can use the app routes";
pub(crate) const SSO_ONLY: &str = "only the SSO service's certificate can use the SSO routes";
pub(crate) const APPS_EMAIL: &str = "app and archive certificates, and only they, have an email under apps.";
const ONE_KIND: &str = "a certificate has one kind";
const ONE_ORG: &str = "an app or archive certificate names exactly one organization";
const SSO_ORGS: &str = "the SSO service's certificate names the organizations it serves";
pub(crate) const ENCLAVE_BRIDGES: &str = "bridges to outside services are off in an enclave";
pub(crate) const ENCLAVE_BRIDGEABLE: &str = "conversations that can be linked to outside services are off in an enclave";
pub(crate) const ENCLAVE_NETS: &str = "this relay takes service connections only from its enclave networks";
const ENCLAVE_ON: &str = "this relay's signer policy says enclave; set enclave in relay.json";
const ENCLAVE_OFF: &str = "this relay's signer policy does not say enclave; remove enclave from relay.json";
const UPDATE_APPS: &str = "update every app before adding apps";
pub(crate) const SHARE_PEOPLE: &str = "history share is for people only";
const NO_ARCHIVE_DM: &str = "an archive never takes part in a direct message";
const APP_DMS: &str = "an app takes part only in its direct messages with people";
const NO_SERVICE_JOIN: &str = "apps and archives never join a conversation; add them";
pub(crate) const NO_SERVICE_ADMIN: &str = "apps and archives are never admins of a conversation";
pub(crate) const ARCHIVE_STAYS: &str = "nobody can remove an archive; it leaves when its organization turns it off";
const ADD_NAMES: &str = "an add or link_app entry must name an app or a person";
const NOT_ARCHIVE: &str = "an archive or unarchive entry must name an archive";
const LINK_MENTIONS: &str = "an app that reads only mentions is linked (link_app), not added";
const ADD_ALL: &str = "an app that reads every message is added, not linked";
const NO_ROOM_SERVICES: &str = "call chat never includes apps or archives";
const LEAVE_ROUTE: &str = "people leave with /v1/channels/leave";
const LEAVE_SELF: &str = "a service leaves only by itself";
const NO_POLICY: &str = "no such policy";
const ARCHIVE_POLICY: &str = "that policy does not name this archive";
const ARCHIVE_THERE: &str = "that archive is already in this conversation";
const ARCHIVE_NOT_THERE: &str = "that archive is not in this conversation";
const APP_THERE: &str = "that app is already in this conversation";
const APP_NOT_LINKED: &str = "that app is not linked to this conversation";
pub(crate) const POLS_UNKNOWN: &str = "pols names a policy this relay does not hold";
const NO_SIGNER_POLICY: &str = "this relay has no signer policy yet";
const SIGNER_POLICY_FROM_SIGNER: &str = "this relay takes its signer policy from its certificate server";
const SIGNER_POLICY_BAD: &str = "that signer policy is not signed by this relay's root";
const NO_POLICIES: &str = "this relay cannot check organization policies (python3-cryptography or meet_org_policy.py is missing)";
const HOLDS_OFF: &str = "legal holds are off on this relay";
const HOLD_WHO: &str = "only an organization admin or a relay admin can do that";
const HOLD_ORG_ONLY: &str = "an organization admin holds only people that organization's policy covers";
const HOLD_RELAY_ONLY: &str = "a relay admin holds conversations only";
const NO_HOLD: &str = "there is no such hold";
const HOLD_REASON_MAX: usize = 500;
/// Principals or cids one hold names.
const HOLD_ITEMS_MAX: usize = 200;
pub(crate) const SIGNER_CRL_OLD: &str = "The certificate server has not issued a revocation list for 6 hours. Sending stops in conversations that need new keys after 24 hours.";
/// The signer re-signs its CRL at least this often (seconds).
pub(crate) const SIGNER_CRL_AGE: f64 = 6.0 * 3600.0;
pub(crate) const CRL_CHECK_EVERY: f64 = 3600.0;
/// A 64 KB signed policy and its request.
pub(crate) const POLICY_BODY_MAX: usize = 128 * 1024;
/// AI-1 2: a 256 KB signed AI map and its request (`/v1/org/ai`, `/v1/org/ai/sign`).
pub(crate) const AI_MAP_BODY_MAX: usize = 320 * 1024;
/// Every refused or missing `GET /v1/org/ai` and `GET /v1/ai/allowed?principal=`.
pub(crate) const AI_NOT_FOUND: &str = "not found";
pub(crate) const ICON_MAX: usize = 64 * 1024;
const ICON_DIR: &str = "app-icons";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
const ICON_CACHE: &str = "public, max-age=31536000, immutable";
/// BG-1 section 3: a team background is a JPEG of at most 1.5 MB, its request body at most 2.2 MB.
pub(crate) const BACKGROUND_MAX: usize = 1_572_864;
pub(crate) const BACKGROUND_BODY_MAX: usize = 2_200_000;
const BACKGROUND_DIR: &str = "org-backgrounds";
const JPEG: &[u8] = b"\xff\xd8\xff";
const BACKGROUND_BAD: &str = "a team background is a JPEG of at most 1.5 MB";
/// `GET /v1/apps/c/events` holds at most this long.
pub(crate) const EVENTS_WAIT: f64 = 30.0;
const POLS_MAX: usize = 64;
const SSO_ASK_KINDS: [&str; 3] = ["sso", "sso_bind", "sso_revoke"];
const SSO_ASKS_MAX: usize = 100;
pub(crate) const SSO_OPS: [&str; 3] = ["sign_sso_enrollment", "sso_bind", "sso_log"];
/// An approval proof's window.
const SSO_APPROVAL_TTL: f64 = 300.0;
const SSO_ADDS_MAX: usize = 1000;
pub(crate) const NOT_YOURS: &str = "cert_pem must be your own certificate";
const NO_ASK: &str = "there is no such request";
const NOT_SERVED: &str = "that organization is not one this SSO service serves";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// Member-log entries that name a policy_hash (CE-1 revision 6).
pub(crate) const POLICY_OPS: [&str; 2] = ["archive", "unarchive"];

// ── certificate kinds and the route allow-list (PC-1 section 1) ─────────────────────────────────────────────

pub(crate) const APP_URI: &str = "urn:lucid-meet:app";
pub(crate) const ARCHIVE_URI: &str = "urn:lucid-meet:archive";
pub(crate) const SSO_URI: &str = "urn:lucid-meet:sso";
/// + org id: the org a service belongs to.
pub(crate) const ORG_URI_PREFIX: &str = "urn:lucid-meet:org:";
const KIND_URIS: [(&str, &str); 5] = [("connector", m::CONNECTOR_URI), ("app", APP_URI), ("archive", ARCHIVE_URI), ("sso", SSO_URI), ("console", m::CONSOLE_URI)];
/// Service principals are `<name>@apps.<domain>`.
const APPS_PREFIX: &str = "apps.";
const APP_GET: [&str; 14] = ["/v1/whoami", "/v1/crl", "/v1/org/policy", "/v1/chat/devices", "/v1/chat/keys", "/v1/chat/log", "/v1/channels/history", "/v1/dm/history", "/v1/files/get", "/v1/files/list", "/v1/apps/c/events", "/v1/org/ai", "/v1/ai/allowed", "/v1/ai/history"];
const APP_POST: [&str; 15] = [
    "/v1/chat/devices", "/v1/chat/keys", "/v1/chat/log", "/v1/dm", "/v1/channels/post", "/v1/chat/edit", "/v1/chat/delete", "/v1/chat/event", "/v1/files/start", "/v1/files/chunk", "/v1/files/finish", "/v1/files/delete", "/v1/apps/c/hello",
    "/v1/apps/c/ack", "/v1/apps/c/renew",
];
const ARCHIVE_POST: [&str; 5] = ["/v1/chat/devices", "/v1/chat/log", "/v1/apps/c/hello", "/v1/apps/c/ack", "/v1/apps/c/renew"];
const SSO_GET: [&str; 1] = ["/v1/crl"];
const SSO_POST: [&str; 6] = ["/v1/sso/c/hello", "/v1/sso/c/sign", "/v1/sso/c/revoke", "/v1/sso/c/org-member", "/v1/sso/c/pending-add", "/v1/sso/c/ai-groups"];
/// Person routes that make bridges, refused in an enclave like every /v1/bridge/c/* route.
pub(crate) const ENCLAVE_BRIDGE_ROUTES: [&str; 2] = ["/v1/bridge/code", "/v1/bridge/dm-code"];

/// PC_ROUTES_ONLY: what a service certificate of `kind` hears outside its routes.
pub(crate) fn routes_only(kind: &str) -> &'static str {
    match kind {
        "sso" => SSO_ROUTES_ONLY,
        "connector" => bridge::ROUTES_ONLY,
        _ => APP_ROUTES_ONLY,
    }
}

/// _service_confined: "" when a certificate of `kind` may use `method path`, else the 403 words. People and the
/// console (confined by its own routes) are not confined here.
pub(crate) fn service_confined(kind: &str, method: &str, path: &str) -> &'static str {
    let ok = |allowed: &[&str]| (method == "GET" || method == "POST") && allowed.contains(&path);
    match kind {
        "connector" => {
            if path.starts_with(bridge::C_PREFIX) {
                ""
            } else {
                bridge::ROUTES_ONLY
            }
        }
        "app" | "archive" => {
            let allowed: &[&str] = if method == "GET" {
                &APP_GET
            } else if kind == "app" {
                &APP_POST
            } else {
                &ARCHIVE_POST
            };
            if ok(allowed) {
                ""
            } else {
                APP_ROUTES_ONLY
            }
        }
        "sso" => {
            let allowed: &[&str] = if method == "GET" { &SSO_GET } else { &SSO_POST };
            if ok(allowed) {
                ""
            } else {
                SSO_ROUTES_ONLY
            }
        }
        _ => "",
    }
}

/// _pc_cert_kind: `(kind, orgs)` of a certificate from its SAN URIs only: "person" without a kind URI; 403 for two
/// kinds, an app or archive without exactly one org URI, or an SSO service without one.
pub(crate) fn cert_kind(uris: &[String]) -> R<(String, Vec<String>)> {
    let kinds: Vec<&str> = KIND_URIS.iter().filter(|(_, u)| uris.iter().any(|x| x == u)).map(|(k, _)| *k).collect();
    if kinds.len() > 1 {
        return forbidden(ONE_KIND);
    }
    let kind = kinds.first().copied().unwrap_or("person");
    let mut orgs: Vec<String> = uris.iter().filter_map(|u| u.strip_prefix(ORG_URI_PREFIX)).filter(|o| !o.is_empty()).map(str::to_string).collect();
    orgs.sort();
    orgs.dedup();
    if (kind == "app" || kind == "archive") && orgs.len() != 1 {
        return forbidden(ONE_ORG);
    }
    if kind == "sso" && orgs.is_empty() {
        return forbidden(SSO_ORGS);
    }
    Ok((kind.to_string(), orgs))
}

/// _pc_service_kind: "app" or "archive" for a service principal (`<name>@apps.<domain>`; the archive's name is always
/// `archive`), "" for anyone else.
pub(crate) fn service_kind(principal: &str) -> &'static str {
    let Some((local, domain)) = principal.split_once('@') else { return "" };
    if local.is_empty() || !domain.starts_with(APPS_PREFIX) {
        return "";
    }
    if local == "archive" {
        "archive"
    } else {
        "app"
    }
}

/// One network (CIDR): its address with the host bits cleared and its prefix length.
fn network_of(text: &str) -> Option<(IpAddr, u8)> {
    let (addr, prefix) = match text.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (text, None),
    };
    let ip: IpAddr = addr.parse().ok()?;
    let most: u8 = if ip.is_ipv4() { 32 } else { 128 };
    let bits = match prefix {
        None => most,
        Some(p) if !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) && p.len() <= 3 => p.parse::<u8>().ok().filter(|b| *b <= most)?,
        Some(_) => return None,
    };
    Some((masked(ip, bits), bits))
}

fn masked(ip: IpAddr, bits: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - u32::from(bits)) };
            IpAddr::V4((u32::from(v4) & mask).into())
        }
        IpAddr::V6(v6) => {
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - u32::from(bits)) };
            IpAddr::V6((u128::from(v6) & mask).into())
        }
    }
}

/// _pc_networks: relay.json `enclave_networks`, CIDR networks only with `enclave` true ([] when absent).
pub(crate) fn networks(v: Option<&Value>, enclave: bool) -> Result<Vec<String>, String> {
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.is_empty() => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a,
        Some(_) => return Err("enclave_networks must be a list of networks (CIDR)".into()),
    };
    if !enclave {
        return Err("enclave_networks needs enclave true".into());
    }
    let mut out = Vec::new();
    for v in list {
        let text = v.as_str().unwrap_or_default();
        let Some((ip, bits)) = network_of(text.trim()) else { return Err(format!("enclave_networks: {text} is not a network (CIDR)")) };
        out.push(format!("{ip}/{bits}"));
    }
    Ok(out)
}

/// _pc_inside: `address` (an IPv4-mapped address as IPv4) is inside one of `nets`.
pub(crate) fn inside(address: &str, nets: &[String]) -> bool {
    let Ok(ip) = address.parse::<IpAddr>() else { return false };
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    nets.iter().filter_map(|n| network_of(n.as_str())).any(|(net, bits)| net.is_ipv4() == ip.is_ipv4() && masked(ip, bits) == net)
}

/// _pc_int: an int that is not a bool, else 0.
pub(crate) fn pc_int(v: Option<&Value>) -> i64 {
    pj::as_int(v).unwrap_or(0)
}

/// _pc_covering with the policies given: the first one whose domains cover `principal`.
pub(crate) fn covering<'a>(policies: &'a [Obj], principal: &str) -> Option<&'a Obj> {
    policies.iter().find(|p| op::covers(p, principal))
}

/// _ai_app: the policy names `who` (principal and device) as an app of type `ai`.
pub(crate) fn ai_app_of(policy: &Obj, who: &Identity) -> bool {
    who.kind == "app"
        && policy.get("apps").and_then(Value::as_array).into_iter().flatten().any(|a| {
            a.get("type").and_then(Value::as_str) == Some("ai")
                && a.get("principal").and_then(Value::as_str) == Some(who.principal.as_str())
                && a.get("device").and_then(Value::as_str) == Some(who.device.as_str())
        })
}

/// CE_HASH_RE: 64 lower-case hex.
fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// FILES_ID_RE: 32 lower-case hex.
fn hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn string_list(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::from).collect())
}

/// _pc_pols: a DM wrap's `pols`: the sorted policy hashes its sender used (each once).
pub(crate) fn pols(v: Option<&Value>) -> R<Vec<String>> {
    let Some(Value::Array(list)) = v.filter(|v| v.as_array().map(|a| a.len() <= POLS_MAX).unwrap_or(false)) else {
        return bad(format!("pols must be a list of at most {POLS_MAX} policy hashes"));
    };
    let mut out = Vec::new();
    for h in list {
        match h.as_str() {
            Some(s) if hex64(s) => out.push(s.to_string()),
            _ => return bad("pols must be a hash (64 hex)"),
        }
    }
    let mut sorted = out.clone();
    sorted.sort();
    sorted.dedup();
    if out != sorted {
        return bad("pols must be sorted, each hash once");
    }
    Ok(out)
}

/// _pc_reason: a hold's reason, 1 to HOLD_REASON_MAX printable characters.
fn reason_of(v: Option<&Value>) -> R<String> {
    let text = match v {
        Some(Value::String(s)) => pj::squash(s),
        _ => String::new(),
    };
    if !(1..=HOLD_REASON_MAX).contains(&pj::char_len(&text)) || !pj::printable(&text) {
        return bad(format!("reason must be 1 to {HOLD_REASON_MAX} characters"));
    }
    Ok(text)
}

/// _pc_short: an optional short printable text field of an SSO ask.
fn short(v: Option<&Value>, what: &str, most: usize, empty: bool) -> R<String> {
    let text = match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return bad(format!("{what} must be a text of at most {most} characters")),
    };
    if pj::char_len(&text) > most || !pj::printable(&text) || (!empty && text.is_empty()) {
        return bad(format!("{what} must be a text of at most {most} characters"));
    }
    Ok(text)
}

/// _pc_asks: the SSO service's waiting requests (`/v1/sso/c/hello {asks}`), checked.
fn asks_of(v: Option<&Value>) -> R<Vec<Obj>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.len() <= SSO_ASKS_MAX => a,
        Some(_) => return bad(format!("asks must be a list of at most {SSO_ASKS_MAX}")),
    };
    let mut out = Vec::new();
    for ask in list {
        let Some(ask) = ask.as_object() else { return bad("each ask must be an object") };
        let kind = match ask.get("kind") {
            Some(Value::String(k)) if SSO_ASK_KINDS.contains(&k.as_str()) => k.clone(),
            _ => return bad("ask kind must be sso, sso_bind or sso_revoke"),
        };
        let principals = match ask.get("principals") {
            v if !pj::truthy(v) => Vec::new(),
            Some(Value::Array(a)) if a.len() <= HOLD_ITEMS_MAX => a.clone(),
            _ => return bad("ask principals must be a list"),
        };
        let buttons = match ask.get("buttons") {
            v if !pj::truthy(v) => vec![Value::from("Approve"), Value::from("Stop")],
            Some(Value::Array(a)) if a.len() <= 4 => a.clone(),
            _ => return bad("ask buttons must be a list"),
        };
        let lower = |s: String| s.trim().to_lowercase();
        let id = short(ask.get("id"), "ask id", 128, false)?;
        let subject = short(ask.get("subject"), "ask subject", 512, true)?;
        let principal = lower(short(ask.get("principal"), "ask principal", 254, true)?);
        let mut named = Vec::new();
        for p in &principals {
            named.push(Value::from(lower(short(Some(p), "ask principals", 254, true)?)));
        }
        let label = short(ask.get("label"), "ask label", m::LABEL_MAX, true)?;
        let check_code = short(ask.get("check_code"), "ask check_code", 16, true)?;
        let idp = short(ask.get("idp"), "ask idp", 64, true)?;
        let prompt = short(ask.get("prompt"), "ask prompt", m::REASON_MAX, true)?;
        let mut shown = Vec::new();
        for b in &buttons {
            shown.push(Value::from(short(Some(b), "ask buttons", 40, true)?));
        }
        out.push(obj([
            ("id", Value::from(id)),
            ("kind", Value::from(kind)),
            ("subject", Value::from(subject)),
            ("principal", Value::from(principal)),
            ("principals", Value::Array(named)),
            ("label", Value::from(label)),
            ("check_code", Value::from(check_code)),
            ("idp", Value::from(idp)),
            ("prompt", Value::from(prompt)),
            ("buttons", Value::Array(shown)),
        ]));
    }
    Ok(out)
}

/// A value with every object's keys sorted, for `json.dumps(..., sort_keys=True)`.
fn sorted_keys(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted_keys(&o[k]))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted_keys).collect()),
        other => other.clone(),
    }
}

pub(crate) fn policy_error(e: op::PolicyError) -> E {
    match e {
        op::PolicyError::Refused(m) => E::Forbidden(m),
        op::PolicyError::Bad(m) => E::Bad(m),
    }
}

fn policy_words(e: &op::PolicyError) -> &str {
    match e {
        op::PolicyError::Refused(m) | op::PolicyError::Bad(m) => m,
    }
}

// ── in memory ────────────────────────────────────────────────────────────────────────────────────────────────

/// RelayServer.minimums: per app the version the relay requires now (relay.json and the release).
pub type Minimums = Arc<dyn Fn() -> Obj + Send + Sync>;

/// An admin's answer waiting for the SSO service's next hello.
#[derive(Default)]
struct SsoOut {
    /// ask id -> ({cert_pem, kind, id, proof, ts}, when).
    approvals: IndexMap<String, (Obj, f64)>,
    stops: Vec<String>,
}

/// In memory: this wave's relay.json settings, the verified org policy store (rebuilt from `ext["pc"]` after a start
/// or a new root or signer policy), the SSO service's pending answers and app icons without a state folder.
pub struct Pc {
    enclave: bool,
    holds: bool,
    /// AI-1 1.5: relay.json `license_edition`, the organization size while no license is installed ("": none).
    license_edition: String,
    /// The root org policies are checked against (relay.json client_ca).
    ca_file: String,
    /// Where the root's CRL is.
    crl_files: Vec<PathBuf>,
    minimums: Option<Minimums>,
    store: Option<op::Store>,
    /// AI-1 2: the org AI maps (rebuilt from `ext["ai"]["maps"]` like the policy store).
    ai_maps: Option<op::AiMapStore>,
    signer: Option<Arc<SignerClient>>,
    sso_out: IndexMap<String, SsoOut>,
    sso_answered: HashMap<(String, String), f64>,
    icons_mem: HashMap<String, Vec<u8>>,
    backgrounds_mem: HashMap<String, Vec<u8>>,
    state_dir: Option<PathBuf>,
    /// Without a state folder: the hold store's temporary folder.
    tmp: Option<PathBuf>,
}

impl Pc {
    pub fn new(state_dir: Option<&Path>) -> Pc {
        Pc {
            enclave: false,
            holds: false,
            license_edition: String::new(),
            ca_file: String::new(),
            crl_files: Vec::new(),
            minimums: None,
            store: None,
            ai_maps: None,
            signer: None,
            sso_out: IndexMap::new(),
            sso_answered: HashMap::new(),
            icons_mem: HashMap::new(),
            backgrounds_mem: HashMap::new(),
            state_dir: state_dir.map(Path::to_path_buf),
            tmp: None,
        }
    }
}

impl Hub {
    /// _pc_configure: relay.json `enclave`, `legal_holds`, the root and its CRL's places, once at start (before the
    /// slices: the bridge reads the enclave).
    pub fn pc_configure(&self, s: &m::Settings) {
        let mut st = self.st.lock();
        st.pc.enclave = s.enclave;
        st.pc.holds = s.legal_holds;
        st.pc.license_edition = s.license_edition.clone();
        st.pc.ca_file = s.client_ca.clone();
        let root_part = crl_parts(s).map(|(root, _)| root);
        st.pc.crl_files = [(!s.crl.is_empty()).then(|| PathBuf::from(&s.crl)), root_part, crl_path(s)].into_iter().flatten().collect();
        st.pc.store = None;
        st.pc.ai_maps = None;
        st.pc.signer = self.signer.clone();
    }

    /// AI-1 1.5: the organization size: the installed license's `edition`, else relay.json `license_edition`; None
    /// (a big organization) with neither. A dev-license (test) build lets relay.json `license_edition` override the
    /// license, as the test-only Python relay reads it.
    pub fn ai_edition(&self) -> Option<String> {
        let configured = Some(self.st.lock().pc.license_edition.clone()).filter(|e| !e.is_empty());
        if cfg!(feature = "dev-license") && configured.is_some() {
            return configured;
        }
        if let Some((l, _)) = self.gate().and_then(|g| g.license()) {
            return Some(l.edition);
        }
        configured
    }

    /// The relay server's version minimums, for the service gate.
    pub fn pc_set_minimums(&self, minimums: Minimums) {
        self.st.lock().pc.minimums = Some(minimums);
    }
}

impl State {
    // ── setup ──

    /// _pc_enclave: an enclave relay (bridges, bridgeable conversations and push are off).
    pub(crate) fn pc_enclave(&self) -> bool {
        self.pc.enclave
    }

    /// _pc_refuse_enclave: 403 with the enclave words for anything that makes a bridge.
    pub(crate) fn pc_refuse_enclave(&self) -> R<()> {
        if self.pc.enclave {
            return forbidden(ENCLAVE_BRIDGES);
        }
        Ok(())
    }

    /// _pc_part: `ext["pc"]`, made sound.
    pub(crate) fn pc_part(&mut self) -> &mut Obj {
        let sound = matches!(self.ext.get("pc"), Some(Value::Object(o)) if pj::as_int(o.get("v")) == Some(1));
        if !sound {
            self.ext.insert("pc".into(), Value::Object(obj([("v", Value::from(1))])));
        }
        let part = self.ext.get_mut("pc").and_then(Value::as_object_mut).expect("ext pc");
        for (key, list) in [("policies", true), ("holds", true), ("kept", false), ("sso", false), ("adds", true), ("docs", false)] {
            let ok = match part.get(key) {
                Some(Value::Array(_)) => list,
                Some(Value::Object(_)) => !list,
                _ => false,
            };
            if !ok {
                part.insert(key.into(), if list { Value::Array(Vec::new()) } else { Value::Object(Obj::new()) });
            }
        }
        if !matches!(part.get("signer_policy"), Some(Value::Object(_))) {
            part.insert("signer_policy".into(), Value::Null);
        }
        part
    }

    fn pc_list(&mut self, key: &str) -> &mut Vec<Value> {
        self.pc_part().get_mut(key).and_then(Value::as_array_mut).expect("a pc list")
    }

    fn pc_map(&mut self, key: &str) -> &mut Obj {
        self.pc_part().get_mut(key).and_then(Value::as_object_mut).expect("a pc map")
    }

    fn pc_signer_policy(&mut self) -> Option<Obj> {
        self.pc_part().get("signer_policy").and_then(Value::as_object).cloned()
    }

    /// Every principal with a live session.
    fn pc_everyone(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in self.sessions.values() {
            if !out.contains(&s.who.principal) {
                out.push(s.who.principal.clone());
            }
        }
        out
    }

    // ── org policies ──

    fn pc_root(&self) -> Option<Cert> {
        if self.pc.ca_file.is_empty() {
            return None;
        }
        Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(&self.pc.ca_file))))
    }

    fn pc_root_crl(&self, root: &Cert) -> Option<Crl> {
        for path in &self.pc.crl_files {
            for (_, der) in pem_blocks(&read_bytes(path), "X509 CRL") {
                let Some(crl) = Crl::from_der(&der) else { continue };
                if crl.issuer == root.subject && crl.signature_valid(&root.spki) {
                    return Some(crl);
                }
            }
        }
        None
    }

    /// _pc_verify_args: (root, signer policy, root CRL, previous intermediate serial) for the policy checks.
    fn pc_verify_args(&mut self) -> R<(Cert, Obj, Option<Crl>, String)> {
        let Some(root) = self.pc_root() else { return Err(E::Unavailable(NO_POLICIES.into())) };
        let Some(signer_policy) = self.pc_signer_policy() else { return forbidden(NO_SIGNER_POLICY) };
        let previous = self.pc.signer.as_ref().and_then(|s| s.snapshot()).map(|s| pj::s(&s, "previous_serial")).unwrap_or_default();
        let crl = self.pc_root_crl(&root);
        Ok((root, signer_policy, crl, previous))
    }

    /// _pc_store: the org policy store; the first time after a start or a new root or signer policy it is rebuilt from
    /// `ext["pc"]` and every policy is verified again. None before the relay knows its root (nothing yet).
    pub(crate) fn pc_store(&mut self) -> Option<&mut op::Store> {
        if self.pc.store.is_none() && !self.pc.ca_file.is_empty() {
            self.pc.store = Some(op::Store::default());
            let wires: Vec<Obj> = self.pc_list("policies").iter().filter_map(Value::as_object).filter(|w| w.get("policy").map(Value::is_object).unwrap_or(false)).cloned().collect();
            if !wires.is_empty() {
                match self.pc_verify_args() {
                    // kept in ext["pc"]; loaded again with the next root or signer policy
                    Err(e) => log_warn(&format!("org policies not loaded: {}", e.message())),
                    Ok((root, signer_policy, crl, previous)) => {
                        let key = |w: &Obj| {
                            let p = w.get("policy").and_then(Value::as_object);
                            let org = p.and_then(|p| p.get("org")).map(pj::py_str).unwrap_or_else(|| "None".into());
                            (org, pc_int(p.and_then(|p| p.get("seq"))))
                        };
                        let mut sorted = wires;
                        sorted.sort_by_key(key);
                        let store = self.pc.store.as_mut().expect("the store");
                        for w in sorted {
                            if let Err(e) = store.accept(&Value::Object(w.clone()), &root, &signer_policy, crl.as_ref(), &previous) {
                                let p = w.get("policy").and_then(Value::as_object);
                                log_warn(&format!("org policy org={} seq={} dropped: {}", kv_of(p.and_then(|p| p.get("org"))), pc_int(p.and_then(|p| p.get("seq"))), policy_words(&e)));
                            }
                        }
                        let kept: Vec<Value> = store.by_hash.values().cloned().map(Value::Object).collect();
                        self.pc_part().insert("policies".into(), Value::Array(kept));
                    }
                }
            }
        }
        self.pc.store.as_mut()
    }

    /// _pc_terms: the PC-1 terms of the signer policy (empty without one).
    pub(crate) fn pc_terms(&mut self) -> op::SignerTerms {
        self.pc_signer_policy().map(|sp| op::signer_terms(&sp).unwrap_or_default()).unwrap_or_default()
    }

    /// _pc_current: every org's newest policy that has not expired.
    pub(crate) fn pc_current(&mut self) -> Vec<Obj> {
        let now = pj::now();
        match self.pc_store() {
            None => Vec::new(),
            Some(store) => store.newest.values().filter(|v| !op::expired(&v.policy, now)).map(|v| v.policy.clone()).collect(),
        }
    }

    /// _pc_policy_app: the app entry (plus `org` and `label`) a current policy gives `principal`.
    pub(crate) fn pc_policy_app(&mut self, principal: &str) -> Option<Obj> {
        for policy in self.pc_current() {
            for app in policy.get("apps").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
                if app.get("principal").and_then(Value::as_str) == Some(principal) {
                    return Some(with(app, obj([("org", policy.get("org").cloned().unwrap_or(Value::Null)), ("label", policy.get("label").cloned().unwrap_or(Value::Null))])));
                }
            }
        }
        None
    }

    /// _pc_policy_service: a current policy names `principal` as its app or archive.
    pub(crate) fn pc_policy_service(&mut self, principal: &str) -> bool {
        self.pc_current().iter().any(|p| op::services(p).iter().any(|s| s.principal == principal))
    }

    fn pc_policy_by_hash(&mut self, digest: &str) -> Option<Obj> {
        self.pc_store()?.get_sha256(digest)?.get("policy").and_then(Value::as_object).cloned()
    }

    /// _pc_set_signer_policy: take a root-signed signer policy (the signer's, or an issuer-PC upload). Ok(true) when it
    /// replaced the one held; a bad one is refused (`strict`) or logged.
    fn pc_set_signer_policy(&mut self, policy: Option<&Value>, strict: bool) -> R<bool> {
        let held = self.pc_part().get("signer_policy").cloned().unwrap_or(Value::Null);
        let policy = match policy {
            Some(Value::Object(o)) if held.as_object() != Some(o) => o.clone(),
            Some(Value::Object(_)) => return Ok(false),
            _ if strict => return bad("signer_policy must be the root-signed signer policy"),
            _ => return Ok(false),
        };
        let Some(root) = self.pc_root() else { return Err(E::Unavailable(NO_POLICIES.into())) };
        if !op::verify_signer_policy(&root, &policy) {
            if strict {
                return forbidden(SIGNER_POLICY_BAD);
            }
            log_warn("the signer's policy is not signed by this relay's root; ignored");
            return Ok(false);
        }
        if pj::as_num(policy.get("v")) == Some(2.0) && pj::truthy(policy.get("enclave")) != self.pc.enclave {
            // invariant 4: the root's word on the enclave and relay.json must agree
            let words = if self.pc.enclave { ENCLAVE_OFF } else { ENCLAVE_ON };
            if strict {
                return forbidden(words);
            }
            m::log_error(&format!("signer policy not taken: {words}"));
            return Ok(false);
        }
        log_info(&format!("signer policy taken v={} issued={}", kv_of(policy.get("v")), kv_of(policy.get("issued"))));
        self.pc_part().insert("signer_policy".into(), Value::Object(policy));
        self.pc.store = None;
        self.pc.ai_maps = None; // and every AI map
        self.dirty = true;
        Ok(true)
    }

    /// _pc_accept: check and store one signed policy: (verified, new). 403 for a refusal (its words), 400 for its
    /// shape. Everyone hears `org_policy` about a new one.
    fn pc_accept(&mut self, wire: Option<&Value>) -> R<(op::Verified, bool)> {
        if self.pc_store().is_none() {
            return Err(E::Unavailable(NO_POLICIES.into()));
        }
        let (root, signer_policy, crl, previous) = self.pc_verify_args()?;
        let wire = wire.cloned().unwrap_or(Value::Null);
        let store = self.pc.store.as_mut().expect("the store");
        let known: HashSet<String> = store.by_hash.keys().cloned().collect();
        let v = store.accept(&wire, &root, &signer_policy, crl.as_ref(), &previous).map_err(policy_error)?;
        if known.contains(&v.hash) {
            return Ok((v, false));
        }
        let kept: Vec<Value> = store.by_hash.values().cloned().map(Value::Object).collect();
        self.pc_part().insert("policies".into(), Value::Array(kept));
        // AI-1 2: the org's AI maps are its newest and the one this policy names
        if self.pc.ai_maps.as_ref().is_some_and(|m| m.kept.contains_key(&v.org)) {
            let named = self.ai_named(&v.org);
            if let Some(maps) = self.pc.ai_maps.as_mut() {
                maps.prune(&v.org, &named);
            }
            self.ai_keep_maps();
        }
        self.dirty = true;
        let everyone = self.pc_everyone();
        self.tell(&everyone, &obj([("type", Value::from("org_policy")), ("org", Value::from(v.org.clone())), ("seq", Value::from(v.seq)), ("hash", Value::from(v.hash.clone()))]), None);
        log_info(&format!("org_policy org={} seq={} hash={} signer={}", v.org, v.seq, v.hash, v.signer));
        Ok((v, true))
    }

    // ── AI-1: org AI maps (docs/ai/contract.md 2) ──

    /// _ai_named: `ai.map_sha256` of the org's newest policy ("" when none).
    pub(crate) fn ai_named(&mut self, org: &str) -> String {
        let policy = self.pc_store().and_then(|s| s.newest.get(org)).map(|v| v.policy.clone());
        policy.and_then(|p| p.get("ai").and_then(Value::as_object).map(|a| pj::s(a, "map_sha256"))).unwrap_or_default()
    }

    /// _ai_maps: the AI map store; rebuilt from `ext["ai"]["maps"]` (by org and seq) the first time after a start
    /// or a new root or signer policy. None before the relay knows its root.
    pub(crate) fn ai_maps(&mut self) -> Option<&mut op::AiMapStore> {
        if self.pc.ai_maps.is_none() && !self.pc.ca_file.is_empty() {
            self.pc.ai_maps = Some(op::AiMapStore::default());
            let wires: Vec<Obj> = self.ext.get("ai").and_then(|a| a.get("maps")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).cloned().collect();
            if !wires.is_empty() {
                match self.pc_verify_args() {
                    Err(e) => log_warn(&format!("AI maps not loaded: {}", e.message())),
                    Ok((root, signer_policy, crl, previous)) => {
                        let key = |w: &Obj| {
                            let m = w.get("map").and_then(Value::as_object);
                            (m.map(|m| pj::text_of(m, "org")).unwrap_or_default(), pc_int(m.and_then(|m| m.get("seq"))))
                        };
                        let mut sorted = wires;
                        sorted.sort_by_key(key);
                        let mut named: HashMap<String, String> = HashMap::new();
                        for w in &sorted {
                            let org = key(w).0;
                            if !named.contains_key(&org) {
                                let digest = self.ai_named(&org);
                                named.insert(org, digest);
                            }
                        }
                        let now = pj::now();
                        let maps = self.pc.ai_maps.as_mut().expect("the AI maps");
                        for w in sorted {
                            let digest = named.get(&key(&w).0).cloned().unwrap_or_default();
                            if let Err(e) = maps.accept_at(&Value::Object(w), &root, &signer_policy, crl.as_ref(), &previous, now, &digest) {
                                log_warn(&format!("org AI map dropped: {}", policy_words(&e)));
                            }
                        }
                    }
                }
            }
        }
        self.pc.ai_maps.as_mut()
    }

    /// The AI maps were loaded since the last start or new root or signer policy.
    pub(crate) fn pc_ai_maps_loaded(&self) -> bool {
        self.pc.ai_maps.is_some()
    }

    /// _ai_policy_gates (AI-1 1.3 and 1.5) before a policy is stored: 409 with the contract's words while the relay's
    /// minimum apps are older than AI-1a, or when the organization's size (the license `edition`; None: no license,
    /// a big organization) needs an archive or reviewers the policy lacks.
    pub(crate) fn ai_policy_gates(&self, policy: Option<&Value>, edition: Option<&str>) -> R<()> {
        let mins = self.pc.minimums.as_ref().map(|f| f()).unwrap_or_default();
        op::ai_gate(policy, &mins).map_err(E::Conflict)?;
        if let Some(p) = policy.and_then(Value::as_object) {
            op::ai_edition_gate(p, edition).map_err(E::Conflict)?;
        }
        Ok(())
    }

    /// `ext["ai"]["maps"]` = the kept maps.
    fn ai_keep_maps(&mut self) {
        let kept = self.pc.ai_maps.as_ref().map(op::AiMapStore::persisted).unwrap_or_default();
        self.ai_part().insert("maps".into(), Value::Array(kept));
        self.dirty = true;
    }

    /// _ai_accept: check and keep one signed AI map (403 for a refusal, 400 for its shape).
    pub(crate) fn ai_accept(&mut self, wire: Option<&Value>) -> R<op::VerifiedAiMap> {
        if self.ai_maps().is_none() {
            return Err(E::Unavailable(NO_POLICIES.into()));
        }
        let (root, signer_policy, crl, previous) = self.pc_verify_args()?;
        let wire = wire.cloned().unwrap_or(Value::Null);
        let org = wire.get("map").and_then(|m| m.get("org")).and_then(Value::as_str).unwrap_or_default().to_string();
        let named = self.ai_named(&org);
        let maps = self.pc.ai_maps.as_mut().expect("the AI maps");
        let vm = maps.accept_at(&wire, &root, &signer_policy, crl.as_ref(), &previous, pj::now(), &named).map_err(policy_error)?;
        self.ai_keep_maps();
        log_info(&format!("org_ai org={} seq={} hash={} signer={}", vm.org, vm.seq, vm.hash, vm.signer));
        Ok(vm)
    }

    /// The AI map the org's current policy names (the one devices and the gateway use), if the relay holds it.
    pub(crate) fn ai_current_map(&mut self, org: &str) -> Option<Obj> {
        let named = self.ai_named(org);
        if named.is_empty() {
            return None;
        }
        self.ai_maps()?.get(org, &named).and_then(|v| v.wire.get("map")).and_then(Value::as_object).cloned()
    }

    /// _pc_hello: what `/v1/hello` adds: the signer policy, every org's newest policy, whether legal holds are on,
    /// whether this relay is an enclave, and (AI-1 7.6) that it keeps AI history.
    pub(crate) fn pc_hello(&mut self) -> Obj {
        let policies = self.pc_store().map(|s| s.current()).unwrap_or_default();
        let signer_policy = self.pc_part().get("signer_policy").cloned().unwrap_or(Value::Null);
        obj([("signer_policy", signer_policy), ("org_policies", Value::Array(policies)), ("holds", Value::Bool(self.pc.holds)), ("enclave", Value::Bool(self.pc.enclave)), ("ai_history", Value::Bool(true))])
    }

    // ── app and archive sessions ──

    /// _pc_linked: the mentions apps linked to a conversation, replayed from its log.
    fn pc_linked(&mut self, cid: &str) -> Vec<String> {
        let mut linked: Vec<String> = Vec::new();
        for e in self.ce_log(cid).iter().filter_map(Value::as_object) {
            let named = strings(e.get("who"));
            match pj::text_of(e, "op").as_str() {
                "link_app" => {
                    for p in named {
                        if !linked.contains(&p) {
                            linked.push(p);
                        }
                    }
                }
                "unlink_app" | "remove" => linked.retain(|p| !named.contains(p)),
                _ => {}
            }
        }
        linked
    }

    /// _pc_linked_reader: a linked (mentions) app may read only the member log of a conversation that links it.
    pub(crate) fn pc_linked_reader(&mut self, cid: &str, who: &Identity) -> bool {
        who.kind == "app" && self.pc_linked(cid).contains(&who.principal)
    }

    /// _pc_service_member: a service reads only its member conversations, and a linked app only the log (404
    /// otherwise, as for a stranger).
    pub(crate) fn pc_service_member(&mut self, cid: &str, who: &Identity, log_only: bool) -> R<()> {
        if !who.is_service() || channels::members_of(self.channel(cid)).contains(&who.principal) {
            return Ok(());
        }
        if log_only && self.pc_linked_reader(cid, who) {
            return Ok(());
        }
        Err(E::NotFound(channels::NO_CHANNEL.into()))
    }

    // ── member-log ops (CE-1 revision 6) ──

    /// _pc_clients_ready: the relay's minimums are at the PC-1 releases of the Hub and iPhone.
    fn pc_clients_ready(&self) -> bool {
        let mins = self.pc.minimums.as_ref().map(|f| f()).unwrap_or_default();
        PC1_CLIENTS.iter().all(|(app, least)| mins.get(*app).and_then(Value::as_str).map(|v| m::version_key(v) >= m::version_key(least)).unwrap_or(false))
    }

    fn pc_gate(&self, services: &[String]) -> R<()> {
        if !services.is_empty() && !self.pc_clients_ready() {
            return Err(E::Conflict(UPDATE_APPS.into()));
        }
        Ok(())
    }

    /// _pc_check_add: an `add` (or a create) names people, or apps an org's current policy lists to read every
    /// message; never an archive; no service ever `join`s. Service entries wait for the PC-1 minimums (409).
    pub(crate) fn pc_check_add(&mut self, people: &[String], op_name: &str) -> R<()> {
        let services: Vec<String> = people.iter().filter(|p| !service_kind(p).is_empty()).cloned().collect();
        if services.is_empty() {
            return Ok(());
        }
        if op_name == "join" {
            return forbidden(NO_SERVICE_JOIN);
        }
        for p in &services {
            if service_kind(p) == "archive" {
                return bad(ADD_NAMES);
            }
            let Some(app) = self.pc_policy_app(p) else { return forbidden(format!("{p} is not an app in a current organization policy")) };
            if pj::text_of(&app, "type") == "ai" {
                return forbidden(super::ai::AI_APP_NEVER); // AI-1 6.1
            }
            if pj::text_of(&app, "scope") != "all" && pj::text_of(&app, "type") == "bot" {
                return bad(LINK_MENTIONS);
            }
        }
        self.pc_gate(&services)
    }

    fn pc_members_people(&self, cid: &str) -> Vec<String> {
        channels::members_of(self.channel(cid)).into_iter().filter(|p| service_kind(p).is_empty()).collect()
    }

    /// _pc_log_op: check and apply `archive`, `unarchive`, `link_app`, `unlink_app` (any member) or a service's own
    /// `leave`. The archive is a member from its `archive` entry to its `unarchive`; linked apps are replayed from the
    /// log.
    pub(crate) fn pc_log_op(&mut self, cid: &str, who: &Identity, e: Obj) -> R<()> {
        let op_name = pj::text_of(&e, "op");
        let people = strings(e.get("who"));
        let what = if POLICY_OPS.contains(&op_name.as_str()) {
            "archive"
        } else if op_name == "leave" {
            "service"
        } else {
            "app"
        };
        if people.len() != 1 {
            return bad(format!("a {op_name} entry names one {what}"));
        }
        let target = people[0].clone();
        let kind = service_kind(&target);
        if op_name == "leave" {
            if !who.is_service() {
                return bad(LEAVE_ROUTE);
            }
            if target != who.principal {
                return forbidden(LEAVE_SELF);
            }
            self.pc_member_change(cid, who, e, &target, false, "left");
            return Ok(());
        }
        if POLICY_OPS.contains(&op_name.as_str()) {
            if kind != "archive" {
                return bad(NOT_ARCHIVE);
            }
            let digest = pj::text_of(&e, "policy");
            let Some(policy) = self.pc_policy_by_hash(&digest) else { return Err(E::NotFound(NO_POLICY.into())) };
            if op_name == "archive" {
                self.pc_archive_ok(cid, who, &digest, &target, &policy)?;
                self.pc_gate(std::slice::from_ref(&target))?;
                self.pc_member_change(cid, who, e, &target, true, "invited");
            } else {
                self.pc_unarchive_ok(cid, &digest, &target, &policy)?;
                self.pc_member_change(cid, who, e, &target, false, "removed");
            }
            return Ok(());
        }
        if kind != "app" {
            return bad(ADD_NAMES);
        }
        let linked = self.pc_linked(cid);
        if op_name == "link_app" {
            let Some(app) = self.pc_policy_app(&target) else { return forbidden(format!("{target} is not an app in a current organization policy")) };
            if pj::text_of(&app, "type") == "ai" {
                return forbidden(super::ai::AI_APP_NEVER); // AI-1 6.1
            }
            if pj::text_of(&app, "scope") != "mentions" {
                return bad(ADD_ALL);
            }
            if channels::members_of(self.channel(cid)).contains(&target) || linked.contains(&target) {
                return Err(E::Conflict(APP_THERE.into()));
            }
            self.pc_gate(std::slice::from_ref(&target))?;
        } else if !linked.contains(&target) {
            return bad(APP_NOT_LINKED);
        }
        self.ce_keep(cid, e);
        let log_seq = self.ce_log(cid).len();
        self.tell(std::slice::from_ref(&target), &obj([("type", Value::from("chat_log")), ("channel", Value::from(cid)), ("log_seq", Value::from(log_seq))]), None);
        Ok(())
    }

    fn pc_archive_ok(&mut self, cid: &str, who: &Identity, digest: &str, target: &str, policy: &Obj) -> R<()> {
        let archive = policy.get("archive").and_then(Value::as_object);
        if archive.and_then(|a| a.get("principal")).and_then(Value::as_str) != Some(target) {
            return bad(ARCHIVE_POLICY);
        }
        let label = pj::s(policy, "label");
        let org = pj::text_of(policy, "org");
        let newest = self.pc_store().and_then(|s| s.newest.get(&org)).map(|v| v.hash.clone());
        if newest.as_deref() != Some(digest) || op::expired(policy, pj::now()) {
            return Err(E::Conflict(format!("that is not {label}'s newest policy; fetch it and sign again")));
        }
        if !op::covers(policy, &who.principal) {
            return forbidden(format!("only a member covered by {label}'s policy adds its archive"));
        }
        if channels::members_of(self.channel(cid)).iter().any(|p| p == target) {
            return Err(E::Conflict(ARCHIVE_THERE.into()));
        }
        Ok(())
    }

    /// _pc_unarchive_ok: allowed when no covered member remains (`policy` = the one the archive was added under), or
    /// with a higher-`seq` policy of that org without an archive.
    fn pc_unarchive_ok(&mut self, cid: &str, digest: &str, target: &str, policy: &Obj) -> R<()> {
        if !channels::members_of(self.channel(cid)).iter().any(|p| p == target) {
            return bad(ARCHIVE_NOT_THERE);
        }
        let mut added = String::new();
        for entry in self.ce_log(cid).iter().filter_map(Value::as_object) {
            if pj::text_of(entry, "op") == "archive" && strings(entry.get("who")) == [target] {
                added = pj::s(entry, "policy");
            }
        }
        let label = pj::s(policy, "label");
        if digest == added {
            if self.pc_members_people(cid).iter().any(|p| op::covers(policy, p)) {
                return forbidden(format!("a member covered by {label}'s policy is still here"));
            }
            return Ok(());
        }
        let before = if added.is_empty() { None } else { self.pc_policy_by_hash(&added) };
        let refused = match &before {
            None => true,
            Some(b) => policy.get("org") != b.get("org") || pc_int(policy.get("seq")) <= pc_int(b.get("seq")) || pj::truthy(policy.get("archive")),
        };
        if refused {
            return forbidden(format!("that policy does not turn {label}'s archive off"));
        }
        Ok(())
    }

    /// _pc_member_change: a service comes into (`archive`) or leaves (`unarchive`, its `leave`) the relay's member list
    /// of the conversation, with its entry; everyone in it hears `channel`.
    fn pc_member_change(&mut self, cid: &str, who: &Identity, e: Obj, target: &str, joining: bool, why: &str) {
        let mut members = channels::members_of(self.channel(cid));
        let mut told = members.clone();
        if joining {
            members.push(target.to_string());
            self.channel_mut(cid).insert("members".into(), string_list(&members));
            let last = self.last_ts(cid);
            self.mark_read(&[target.to_string()], cid, last);
            told = members;
        } else {
            members.retain(|p| p != target);
            if let Some(marks) = self.channel_read.get_mut(target).and_then(Value::as_object_mut) {
                marks.shift_remove(cid);
            }
            let ch = self.channel_mut(cid);
            ch.insert("members".into(), string_list(&members));
            if members.is_empty() && pj::text_of(ch, "kind") != "public" && !pj::truthy(ch.get("archived")) {
                ch.insert("archived".into(), f(pj::now()));
            }
        }
        self.ce_keep(cid, e);
        self.dirty = true;
        let view = self.channel(cid).cloned().unwrap_or_default();
        self.tell(&told, &obj([("type", Value::from("channel")), ("why", Value::from(why)), ("channel", Value::Object(view)), ("by", Value::from(who.principal.clone()))]), None);
        self.bridge_recheck("relay", Some(cid), None);
    }

    // ── the DM device set and call chat ──

    /// _pc_wrap_in_conv: both ends of a wrap are in `cid`: call chat never has a service; a DM's device set also has
    /// the archive of every policy in `pols` that covers one of the two.
    pub(crate) fn pc_wrap_in_conv(&mut self, cid: &str, sender: &str, to: &Obj, pols: &[String]) -> R<()> {
        let target = pj::text_of(to, "principal");
        let kind = service_kind(&target);
        let scope = cid.split_once(':').map(|(s, _)| s).unwrap_or(cid);
        if self.ai_is_ai_app(&target) || self.ai_is_ai_app(sender) {
            return forbidden(super::ai::AI_APP_NEVER); // AI-1 6.1
        }
        if scope == "ai" {
            return self.ai_wrap_ok(cid, sender, to, pols); // AI-1 7.1
        }
        if scope == "room" && (!kind.is_empty() || !service_kind(sender).is_empty()) {
            return forbidden(NO_ROOM_SERVICES);
        }
        if scope == "dm" {
            if !pols.is_empty() {
                let unknown = match self.pc_store() {
                    None => true,
                    Some(store) => pols.iter().any(|h| store.get_sha256(h).is_none()),
                };
                if unknown {
                    return bad(POLS_UNKNOWN);
                }
            }
            if kind == "archive" {
                if !self.pc_dm_archive(cid, sender, to, pols) {
                    return forbidden(ce::NOT_IN);
                }
                return Ok(());
            }
        }
        self.ce_in_conv(cid, sender, &target)
    }

    fn pc_dm_archive(&mut self, cid: &str, sender: &str, to: &Obj, pols: &[String]) -> bool {
        let mut candidates: Vec<String> = self.directory.keys().cloned().collect();
        candidates.push(sender.to_string());
        for policy in self.pc_current() {
            candidates.extend(op::services(&policy).into_iter().map(|s| s.principal));
        }
        candidates.sort();
        candidates.dedup();
        for digest in pols {
            let Some(policy) = self.pc_policy_by_hash(digest) else { continue };
            let archive = policy.get("archive").and_then(Value::as_object).cloned().unwrap_or_default();
            if archive.get("principal") != to.get("principal") || archive.get("device") != to.get("device") {
                continue;
            }
            for other in &candidates {
                if cid == ce::dm_cid(sender, other) && (op::covers(&policy, sender) || op::covers(&policy, other)) {
                    return true;
                }
            }
        }
        false
    }

    /// _pc_dm_peer: the directory entry of a DM's other side that is not a person: an app of a current policy (a
    /// person's own DM with an app). Never an archive; an app takes part only in DMs with people.
    pub(crate) fn pc_dm_peer(&mut self, who: &Identity, other: &str) -> R<Option<Obj>> {
        let kind = service_kind(other);
        if kind == "archive" {
            return forbidden(NO_ARCHIVE_DM);
        }
        if self.ai_is_ai_app(other) || self.ai_is_ai_app(&who.principal) {
            return forbidden(super::ai::AI_APP_NEVER); // AI-1 6.1
        }
        match kind {
            "app" => {
                if who.is_service() {
                    return forbidden(APP_DMS);
                }
                Ok(self.pc_policy_app(other).map(|app| obj([("name", app.get("name").cloned().unwrap_or(Value::Null))])))
            }
            _ => Ok(None),
        }
    }

    /// _pc_archive_reads: an archive reads a DM when its org's newest policy names it (principal and device) and covers
    /// one of the two people.
    pub(crate) fn pc_archive_reads(&mut self, who: &Identity, pair: &[String]) -> bool {
        if who.kind != "archive" || who.orgs.is_empty() {
            return false;
        }
        let org = who.orgs[0].clone();
        let Some(newest) = self.pc_store().and_then(|s| s.newest.get(&org)).map(|v| v.policy.clone()) else { return false };
        if !op::names_service(&newest, "archive", &who.principal, &who.device) {
            return false;
        }
        pair.iter().any(|p| op::covers(&newest, p))
    }

    /// _pc_tell_archives: a DM event to the archives that read that DM (with `pair`). Callers wake the polls.
    pub(crate) fn pc_tell_archives(&mut self, a: &str, b: &str, event: &Obj) {
        let archives: Vec<(String, Identity)> = self.sessions.values().filter(|s| s.who.kind == "archive").map(|s| (s.session_id.clone(), s.who.clone())).collect();
        if archives.is_empty() {
            return;
        }
        let mut pair = vec![a.to_string(), b.to_string()];
        pair.sort();
        let told = with(event, obj([("pair", string_list(&pair))]));
        for (id, who) in archives {
            if !pair.contains(&who.principal) && self.pc_archive_reads(&who, &pair) {
                if let Some(s) = self.sessions.get_mut(&id) {
                    push(&mut s.seq, &mut s.events, &told);
                }
            }
        }
    }

    // ── retention (PC-1 section 3) ──

    /// _pc_retention_s: how long a conversation's `kind` (dm, group, channel, files) is kept: the longest of its
    /// people's signed org retention (a person no current policy covers, or a policy without that kind: the relay's
    /// setting), never longer than the relay's `cap`.
    pub(crate) fn pc_retention_s(&mut self, kind: &str, people: &[String], cap: f64) -> f64 {
        let policies = self.pc_current();
        if policies.is_empty() {
            return cap;
        }
        let (mut best, mut anyone) = (0.0f64, false);
        for p in people {
            if !service_kind(p).is_empty() {
                continue;
            }
            anyone = true;
            let days = covering(&policies, p).and_then(|policy| policy.get("retention")).and_then(Value::as_object).and_then(|r| pj::as_num(r.get(kind))).filter(|d| *d != 0.0);
            best = best.max(match days {
                Some(d) => cap.min(d * 86400.0),
                None => cap,
            });
            if best >= cap {
                return cap;
            }
        }
        if anyone {
            best
        } else {
            cap
        }
    }

    /// _pc_conv_retention of a DM (`key`: "a b"): (hold cid, people, seconds kept).
    fn pc_dm_retention(&mut self, key: &str, kind: &str) -> (String, Vec<String>, f64) {
        let people: Vec<String> = key.split(' ').map(str::to_string).collect();
        let cid = if people.len() == 2 { ce::dm_cid(&people[0], &people[1]) } else { String::new() };
        let cap = self.mail_s;
        let keep = self.pc_retention_s(if kind.is_empty() { "dm" } else { kind }, &people, cap);
        (cid, people, keep)
    }

    /// _pc_conv_retention of a channel or group chat.
    fn pc_channel_retention(&mut self, channel: &str, kind: &str) -> (String, Vec<String>, f64) {
        let ch = self.channel(channel);
        let people = channels::members_of(ch);
        let what = if !kind.is_empty() {
            kind.to_string()
        } else if ch.map(|c| pj::text_of(c, "kind") == "group").unwrap_or(false) {
            "group".into()
        } else {
            "channel".into()
        };
        let cap = self.channel_s;
        let keep = self.pc_retention_s(&what, &people, cap);
        (format!("ch:{channel}"), people, keep)
    }

    /// _pc_prune_rows: the rows of a DM (`dm_key`) or channel still within its retention; the rest go to the hold store
    /// when the conversation is held.
    pub(crate) fn pc_prune_rows(&mut self, rows: Vec<Obj>, now: f64, dm_key: Option<&str>, channel: Option<&str>) -> Vec<Obj> {
        let (cid, people, keep) = match dm_key {
            Some(key) => self.pc_dm_retention(key, ""),
            None => self.pc_channel_retention(channel.unwrap_or_default(), ""),
        };
        let cut = now - keep;
        let (kept, gone): (Vec<Obj>, Vec<Obj>) = rows.into_iter().partition(|m| pj::num(m, "ts") >= cut);
        if !gone.is_empty() {
            self.pc_hold_items(&cid, "row", &gone, None, Some(&people));
        }
        kept
    }

    /// _pc_file_keep_s: how long a kept file lives by its conversation's signed `files` retention.
    pub(crate) fn pc_file_keep_s(&mut self, meta: &Obj) -> f64 {
        match pj::text_of(meta, "scope").as_str() {
            "dm" => {
                let pair = strings(meta.get("pair"));
                let cap = self.mail_s;
                self.pc_retention_s("files", &pair, cap)
            }
            "channel" => {
                let members = channels::members_of(self.channel(&pj::s(meta, "channel")));
                let cap = self.channel_s;
                self.pc_retention_s("files", &members, cap)
            }
            _ => self.history_s,
        }
    }

    /// _pc_dm_pairs: {dm cid: [a, b]} of the DMs with kept messages (only when policies or holds are in play).
    pub(crate) fn pc_dm_pairs(&mut self) -> IndexMap<String, Vec<String>> {
        let mut out = IndexMap::new();
        if self.pc_current().is_empty() && self.pc_active().is_empty() {
            return out;
        }
        for key in self.dms.keys() {
            let pair: Vec<String> = key.split(' ').map(str::to_string).collect();
            if pair.len() == 2 {
                out.insert(ce::dm_cid(&pair[0], &pair[1]), pair);
            }
        }
        out
    }

    /// _pc_wrap_cut: the signed retention's cut (ms) of a wrap's conversation (0: none known).
    pub(crate) fn pc_wrap_cut(&mut self, r: &Obj, pairs: &IndexMap<String, Vec<String>>, now: f64) -> f64 {
        let cid = pj::text_of(r, "cid");
        let (scope, rest) = cid.split_once(':').unwrap_or((cid.as_str(), ""));
        if scope == "ch" && self.channels.contains_key(rest) {
            return (now - self.pc_channel_retention(rest, "").2) * 1000.0;
        }
        if scope == "dm" {
            if let Some(pair) = pairs.get(&cid) {
                let cap = self.mail_s;
                return (now - self.pc_retention_s("dm", pair, cap)) * 1000.0;
            }
        }
        if scope == "ai" {
            // AI-1 7.4: retention.ai
            let mut owner = self.ai_owner(&cid);
            if owner.is_empty() {
                owner = r.get("from").and_then(|f| f.get("principal")).and_then(Value::as_str).unwrap_or_default().to_string();
            }
            if !owner.is_empty() {
                return (now - self.ai_keep_s(&owner)) * 1000.0;
            }
        }
        0.0
    }

    // ── legal holds (PC-1 section 3) ──

    fn pc_active(&mut self) -> Vec<Obj> {
        self.pc_list("holds").iter().filter_map(Value::as_object).filter(|h| !pj::truthy(h.get("released"))).cloned().collect()
    }

    fn pc_held(&mut self, cid: &str, people: &[String]) -> bool {
        for h in self.pc_active() {
            let on = pj::text_of(&h, "on");
            if on == "conversations" && strings(h.get("cids")).iter().any(|c| c == cid) {
                return true;
            }
            if on == "people" && strings(h.get("principals")).iter().any(|p| people.contains(p)) {
                return true;
            }
        }
        false
    }

    /// _pc_hold_dir: state_dir/holds (a temporary folder without a state folder), with its `files` folder.
    fn pc_hold_dir(&mut self) -> PathBuf {
        let folder = if let Some(dir) = &self.pc.state_dir {
            dir.join("holds")
        } else if let Some(tmp) = &self.pc.tmp {
            tmp.clone()
        } else {
            let tmp = std::env::temp_dir().join(format!("lucid-relay-holds-{}", pj::token_hex(8)));
            self.pc.tmp = Some(tmp.clone());
            tmp
        };
        let files = folder.join("files");
        let _ = std::fs::create_dir_all(&files);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700));
            let _ = std::fs::set_permissions(&files, std::fs::Permissions::from_mode(0o700));
        }
        folder
    }

    /// _pc_people_of: who a held item's conversation has (or had): its members, the DM's two people, and whoever the
    /// items name.
    fn pc_people_of(&mut self, cid: &str, items: &[Obj], pairs: Option<&IndexMap<String, Vec<String>>>) -> Vec<String> {
        let (scope, rest) = cid.split_once(':').unwrap_or((cid, ""));
        let mut people: Vec<String> = Vec::new();
        if scope == "ch" && self.channels.contains_key(rest) {
            people.extend(channels::members_of(self.channel(rest)));
        } else if scope == "dm" {
            let pair = match pairs.and_then(|p| p.get(cid)) {
                Some(p) => Some(p.clone()),
                None => self.pc_dm_pairs().get(cid).cloned(),
            };
            people.extend(pair.unwrap_or_default());
        } else if scope == "ai" {
            // AI-1 7.6: people holds cover ai:
            let owner = self.ai_owner(cid);
            if !owner.is_empty() {
                people.push(owner);
            }
        }
        for item in items {
            for key in ["by", "from", "to"] {
                match item.get(key) {
                    Some(Value::String(s)) => people.push(s.clone()),
                    Some(Value::Object(o)) => {
                        if let Some(Value::String(p)) = o.get("principal") {
                            people.push(p.clone());
                        }
                    }
                    _ => {}
                }
            }
            if let Some(Value::Array(who)) = item.get("who") {
                people.extend(who.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
        people.sort();
        people.dedup();
        people
    }

    /// _pc_hold_items: keep what the relay is about to prune or remove (rows, deletes, logs, wraps, documents) in the
    /// hold store, as the ciphertext it is, when `cid` is held. Call chat is never held. True when kept.
    pub(crate) fn pc_hold_items(&mut self, cid: &str, kind: &str, items: &[Obj], pairs: Option<&IndexMap<String, Vec<String>>>, people: Option<&[String]>) -> bool {
        if items.is_empty() || cid.is_empty() || cid.starts_with("room:") || self.pc_active().is_empty() {
            return false;
        }
        let people = match people {
            Some(p) => p.to_vec(),
            None => self.pc_people_of(cid, items, pairs),
        };
        if !self.pc_held(cid, &people) {
            return false;
        }
        let records: Vec<Obj> = items.iter().map(|item| obj([("kind", Value::from(kind)), ("item", Value::Object(item.clone()))])).collect();
        self.pc_keep(cid, &people, records);
        true
    }

    fn pc_keep(&mut self, cid: &str, people: &[String], records: Vec<Obj>) {
        let name = format!("{}.jsonl", pj::clip(&crate::codec::sha256_hex(cid.as_bytes()), 32));
        let ts = (pj::now() * 1000.0) as i64;
        let path = self.pc_hold_dir().join(&name);
        let mut text = String::new();
        for record in &records {
            text.push_str(&pj::dumps(&Value::Object(with(record, obj([("cid", Value::from(cid)), ("ts", Value::from(ts))])))));
            text.push('\n');
        }
        let written = std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut fh| fh.write_all(text.as_bytes()));
        if let Err(e) = written {
            m::log_error(&format!("hold store write failed cid={cid}: {e}"));
            return;
        }
        let kept = self.pc_map("kept");
        let row = kept.entry(cid.to_string()).or_insert_with(|| Value::Object(obj([("file", Value::from(name.clone())), ("people", Value::Array(Vec::new())), ("count", Value::from(0))])));
        if !row.is_object() {
            *row = Value::Object(obj([("file", Value::from(name)), ("people", Value::Array(Vec::new())), ("count", Value::from(0))]));
        }
        let row = row.as_object_mut().expect("a kept row");
        let mut all = strings(row.get("people"));
        all.extend(people.iter().cloned());
        all.sort();
        all.dedup();
        row.insert("people".into(), string_list(&all));
        let count = pc_int(row.get("count")) + records.len() as i64;
        row.insert("count".into(), Value::from(count));
        self.dirty = true;
    }

    /// _pc_hold_deleted: a message about to be deleted, kept as it is when its conversation is held (the delete still
    /// hides it from members). `channel`: the channel's id, else the DM with `other`.
    pub(crate) fn pc_hold_deleted(&mut self, principal: &str, other: &str, channel: Option<&str>, target: &Obj) {
        let (cid, people) = match channel {
            Some(c) => (format!("ch:{c}"), channels::members_of(self.channel(c))),
            None if !other.is_empty() => (ce::dm_cid(principal, other), vec![principal.to_string(), other.to_string()]),
            None => return,
        };
        self.pc_hold_items(&cid, "deleted", std::slice::from_ref(target), None, Some(&people));
    }

    /// _pc_hold_file: a file about to be removed: its bytes move to the hold store when its conversation is held.
    pub(crate) fn pc_hold_file(&mut self, fid: &str, meta: &Obj) {
        let pair = strings(meta.get("pair"));
        let (cid, people) = match pj::text_of(meta, "scope").as_str() {
            "dm" if pair.len() == 2 => (ce::dm_cid(&pair[0], &pair[1]), pair),
            "channel" => {
                let channel = pj::py_str(meta.get("channel").unwrap_or(&Value::Null));
                let people = match self.channel(&channel) {
                    Some(ch) => channels::members_of(Some(ch)),
                    None => vec![pj::s(meta, "from")],
                };
                (format!("ch:{channel}"), people)
            }
            _ => return,
        };
        if self.pc_active().is_empty() || !self.pc_held(&cid, &people) {
            return;
        }
        let dst = self.pc_hold_dir().join("files").join(fid);
        let Ok(src) = self.files.path(fid, false) else { return };
        if std::fs::rename(&src, &dst).is_err() {
            if let Err(e) = std::fs::read(&src).and_then(|data| std::fs::write(&dst, data)) {
                m::log_error(&format!("hold store could not keep file id={fid}: {e}"));
                return;
            }
        }
        let item = with(meta, obj([("id", Value::from(fid))]));
        self.pc_keep(&cid, &people, vec![obj([("kind", Value::from("file")), ("item", Value::Object(item))])]);
    }

    /// _pc_unkeep: after a release, what no active hold covers any more leaves the hold store.
    fn pc_unkeep(&mut self) {
        let folder = self.pc_hold_dir();
        let kept: Vec<(String, Value)> = self.pc_map("kept").iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (cid, row) in kept {
            let Some(row) = row.as_object() else { continue };
            if self.pc_held(&cid, &strings(row.get("people"))) {
                continue;
            }
            let name = pj::s(row, "file");
            if name.len() == 38 && name.ends_with(".jsonl") && name.get(..32).map(hex32).unwrap_or(false) {
                let path = folder.join(&name);
                for line in read_bytes(&path).split(|b| *b == b'\n') {
                    let Ok(Value::Object(record)) = serde_json::from_slice::<Value>(line) else { continue };
                    if pj::text_of(&record, "kind") != "file" {
                        continue;
                    }
                    let fid = record.get("item").and_then(Value::as_object).map(|i| pj::text_of(i, "id")).unwrap_or_default();
                    if hex32(&fid) {
                        let _ = std::fs::remove_file(folder.join("files").join(&fid));
                    }
                }
                let _ = std::fs::remove_file(&path);
            }
            self.pc_map("kept").shift_remove(&cid);
        }
        self.dirty = true;
    }

    /// _pc_audit: one line of the hold audit log (holds/audit.jsonl, hash-chained) and the relay log.
    fn pc_audit(&mut self, who: &str, action: &str, detail: Obj) {
        let head = self.pc_part().get("audit").and_then(Value::as_object).cloned().unwrap_or_default();
        let seq = pc_int(head.get("seq")) + 1;
        let prev = match pj::s(&head, "hash") {
            h if h.is_empty() => ZERO.to_string(),
            h => h,
        };
        let line = obj([
            ("seq", Value::from(seq)),
            ("ts", Value::from(pj::now() as i64)),
            ("who", Value::from(who)),
            ("action", Value::from(action)),
            ("detail", Value::Object(detail.clone())),
            ("prev", Value::from(prev)),
        ]);
        let data = pj::dumps_compact(&sorted_keys(&Value::Object(line)));
        let path = self.pc_hold_dir().join("audit.jsonl");
        let written = std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut fh| fh.write_all(format!("{data}\n").as_bytes()));
        if let Err(e) = written {
            m::log_error(&format!("hold audit write failed: {e}"));
        }
        self.pc_part().insert("audit".into(), Value::Object(obj([("seq", Value::from(seq)), ("hash", Value::from(crate::codec::sha256_hex(data.as_bytes())))])));
        self.dirty = true;
        log_info(&format!("legal_hold action={action} by={who} detail={}", kv(&pj::dumps(&sorted_keys(&Value::Object(detail))))));
    }

    fn pc_org_admin_of(&mut self, principal: &str) -> Vec<Obj> {
        self.pc_current().into_iter().filter(|p| strings(p.get("admins")).iter().any(|a| a == principal)).collect()
    }

    fn pc_hold_visible(&self, who: &Identity, hold: &Obj, mine: &[Obj]) -> bool {
        self.admins.contains(&who.principal) || (pj::text_of(hold, "on") == "people" && mine.iter().any(|p| p.get("org") == hold.get("org")))
    }

    // ── the SSO service (identity.md section 5) ──

    fn pc_ask_org(&mut self, ask: &Obj, orgs: &[String]) -> String {
        let terms = self.pc_terms();
        let mut principal = pj::text_of(ask, "principal");
        if principal.is_empty() {
            principal = strings(ask.get("principals")).into_iter().next().unwrap_or_default();
        }
        let domain = principal.split_once('@').map(|(_, d)| d).unwrap_or("");
        let org = terms.org_of(domain);
        if orgs.contains(&org) {
            org
        } else {
            String::new()
        }
    }

    /// _pc_ask_visible: signer policy admins and the ask's org's `org_admins` see it.
    fn pc_ask_visible(&mut self, principal: &str, ask: &Obj) -> bool {
        let admins = self.pc_signer_policy().map(|sp| strings(sp.get("admins"))).unwrap_or_default();
        let terms = self.pc_terms();
        admins.iter().any(|a| a == principal) || terms.org_admins.get(&pj::text_of(ask, "org")).map(|l| l.iter().any(|a| a == principal)).unwrap_or(false)
    }

    fn pc_add_visible(&mut self, principal: &str, add: &Obj) -> bool {
        let cid = pj::py_str(add.get("cid").unwrap_or(&Value::Null));
        let Some(ch) = self.channel(&cid) else { return false };
        let members = channels::members_of(Some(ch));
        let created_by = pj::text_of(ch, "created_by");
        let mut admins = self.ce_admins(&cid);
        if admins.is_empty() {
            admins.insert(created_by);
        }
        admins.contains(principal) && members.iter().any(|p| p == principal)
    }

    /// _pc_sso_domain: the org (one the service serves) whose root-assigned domains hold `principal`.
    fn pc_sso_domain(&mut self, who: &Identity, principal: &str) -> R<String> {
        let terms = self.pc_terms();
        let domain = principal.split_once('@').map(|(_, d)| d).unwrap_or("");
        let org = if domain.is_empty() { String::new() } else { terms.org_of(domain) };
        if org.is_empty() || !who.orgs.contains(&org) {
            return forbidden(op::DOMAIN_REFUSED);
        }
        Ok(org)
    }

    // ── upkeep ──

    /// _pc_prune: older policies no log entry or DM wrap names, documents past their retention, SSO answers and
    /// pending adds that are done, and idle rate counters.
    pub(crate) fn pc_prune(&mut self, now: f64) {
        if !self.pc.ca_file.is_empty() && self.pc_store().map(|s| !s.by_hash.is_empty()).unwrap_or(false) {
            let mut named: HashSet<String> = HashSet::new();
            for log in self.ce_part("logs").values() {
                for e in log.as_array().into_iter().flatten().filter_map(Value::as_object) {
                    if POLICY_OPS.contains(&pj::text_of(e, "op").as_str()) {
                        if let Some(Value::String(h)) = e.get("policy") {
                            named.insert(h.to_lowercase());
                        }
                    }
                }
            }
            for rows in self.ce_part("wraps").values() {
                for r in rows.as_array().into_iter().flatten() {
                    named.extend(strings(r.get("pols")).into_iter().map(|h| h.to_lowercase()));
                }
            }
            let store = self.pc.store.as_mut().expect("the store");
            store.prune(&named);
            let kept: Vec<Value> = store.by_hash.values().cloned().map(Value::Object).collect();
            if self.pc_list("policies").len() != kept.len() {
                self.pc_part().insert("policies".into(), Value::Array(kept));
                self.dirty = true;
            }
        }
        self.pc_docs_prune(now);
        let channel_s = self.channel_s;
        let adds: Vec<Value> = std::mem::take(self.pc_list("adds"));
        let kept: Vec<Value> = adds
            .into_iter()
            .filter(|a| {
                let Some(a) = a.as_object() else { return false };
                let cid = pj::py_str(a.get("cid").unwrap_or(&Value::Null));
                let Some(ch) = self.channel(&cid) else { return false };
                let principal = a.get("principal").and_then(Value::as_str).unwrap_or_default();
                !channels::members_of(Some(ch)).iter().any(|p| p == principal) && now - (pc_int(a.get("ts")) as f64) < channel_s
            })
            .collect();
        *self.pc_list("adds") = kept;
        for out in self.pc.sso_out.values_mut() {
            out.approvals.retain(|_, (_, at)| now - *at < SSO_APPROVAL_TTL);
        }
        self.pc.sso_out.retain(|_, out| !out.approvals.is_empty() || !out.stops.is_empty());
    }
}

impl Hub {
    // ── org policies ──

    /// The signer's `org_policies` answer (pulled at every upkeep and after a signing): its root-signed signer policy
    /// and every org's current policy. Answers how many policies were new.
    pub fn pc_take_policies(&self, wires: Option<&Value>, signer_policy: Option<&Value>) -> usize {
        let mut st = self.st.lock();
        if let Err(E::Unavailable(_)) = st.pc_set_signer_policy(signer_policy, false) {
            return 0;
        }
        let mut new = 0;
        for wire in wires.and_then(Value::as_array).into_iter().flatten() {
            match st.pc_accept(Some(wire)) {
                Ok((_, true)) => new += 1,
                Ok(_) => {}
                Err(e) => log_warn(&format!("org policy from the signer not taken: {}", e.message())),
            }
        }
        drop(st);
        self.wake();
        new
    }

    /// A policy the signer just signed: `{org, seq, hash, signed}`.
    pub fn pc_take_signed(&self, wire: Option<&Value>) -> R<Obj> {
        let mut st = self.st.lock();
        let r = st.pc_accept(wire);
        drop(st);
        self.wake();
        let (v, _) = r?;
        Ok(obj([("org", Value::from(v.org)), ("seq", Value::from(v.seq)), ("hash", Value::from(v.hash)), ("signed", Value::Object(v.wire))]))
    }

    /// `POST /v1/org/policy {signed, signer_policy?}`: the issuer PC's upload (a relay admin). `signer_policy` (the
    /// root-signed v2 policy of the issuer-PC path) is taken only by a relay without a signer.
    pub fn pc_policy_upload(&self, session: &str, who: &Identity, signed: Body, signer_policy: Body) -> R<Obj> {
        let edition = self.ai_edition();
        let mut st = self.st.lock();
        let r = (|| -> R<op::Verified> {
            st.check_admin(session, who)?;
            if let Some(sp) = signer_policy.filter(|v| !v.is_null()) {
                if self.signer.is_some() {
                    return bad(SIGNER_POLICY_FROM_SIGNER);
                }
                st.pc_set_signer_policy(Some(sp), true)?;
            }
            st.ai_policy_gates(signed.and_then(|s| s.get("policy")), edition.as_deref())?; // AI-1 1.3 and 1.5
            Ok(st.pc_accept(signed)?.0)
        })();
        drop(st);
        self.wake();
        let v = r?;
        log_info(&format!("org_policy_upload org={} seq={} by={}", v.org, v.seq, who.principal));
        Ok(obj([("org", Value::from(v.org)), ("seq", Value::from(v.seq)), ("hash", Value::from(v.hash))]))
    }

    /// `GET /v1/org/policy?org=|sha256=` -> `{signed, signer_policy}`: an org's newest, or any kept policy a log entry
    /// or DM wrap names.
    pub fn pc_policy_get(&self, org: &str, sha256: &str) -> R<Obj> {
        if org.is_empty() && sha256.is_empty() {
            return bad("say which policy (org or sha256)");
        }
        let mut st = self.st.lock();
        let wire = st.pc_store().and_then(|s| if !org.is_empty() { s.get_org(org) } else { s.get_sha256(sha256) }).cloned();
        let Some(wire) = wire else { return Err(E::NotFound(NO_POLICY.into())) };
        let signer_policy = st.pc_part().get("signer_policy").cloned().unwrap_or(Value::Null);
        Ok(obj([("signed", Value::Object(wire)), ("signer_policy", signer_policy)]))
    }

    // ── AI-1: org AI maps (docs/ai/contract.md 2) ──

    /// `POST /v1/org/ai {session, signed}`: the issuer PC's upload (a relay admin, as `POST /v1/org/policy`) ->
    /// `{org, seq, hash}`.
    pub fn pc_ai_upload(&self, session: &str, who: &Identity, signed: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<op::VerifiedAiMap> {
            st.check_admin(session, who)?;
            st.ai_accept(signed)
        })();
        drop(st);
        self.wake();
        let vm = r?;
        log_info(&format!("org_ai_upload org={} seq={} by={}", vm.org, vm.seq, who.principal));
        Ok(obj([("org", Value::from(vm.org)), ("seq", Value::from(vm.seq)), ("hash", Value::from(vm.hash))]))
    }

    /// A map the signer just signed (`POST /v1/org/ai/sign`): `{org, seq, hash, signed}`.
    pub fn pc_ai_take_signed(&self, wire: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = st.ai_accept(wire);
        drop(st);
        self.wake();
        let vm = r?;
        Ok(obj([("org", Value::from(vm.org)), ("seq", Value::from(vm.seq)), ("hash", Value::from(vm.hash)), ("signed", Value::Object(vm.wire))]))
    }

    /// The org's newest AI map, or that exact kept map, with the signer policy: `{signed, signer_policy}` (no
    /// membership check: the console's in-process read). 404 `not found` when the relay does not hold it.
    pub fn pc_ai_get(&self, org: &str, sha256: &str) -> R<Obj> {
        let mut st = self.st.lock();
        let wire = st.ai_maps().and_then(|m| m.get(org, sha256)).map(|v| v.wire.clone());
        let Some(wire) = wire else { return Err(E::NotFound(AI_NOT_FOUND.into())) };
        let signer_policy = st.pc_part().get("signer_policy").cloned().unwrap_or(Value::Null);
        Ok(obj([("signed", Value::Object(wire)), ("signer_policy", signer_policy)]))
    }

    /// `GET /v1/org/ai?org=<id>[&sha256=<hex>]`: only to a person the org's current policy covers, or that org's `ai`
    /// app; anyone else, and a map the relay does not hold, get the same 404 `{"error": "not found"}`.
    pub fn pc_ai_get_for(&self, who: &Identity, org: &str, sha256: &str) -> R<Obj> {
        let allowed = {
            let mut st = self.st.lock();
            let policy = st.ai_newest(org);
            policy.as_ref().is_some_and(|p| (super::ai::ai_person(who) && op::covers(p, &who.principal)) || State::ai_app_of(who, Some(p)))
        };
        if !allowed {
            return Err(E::NotFound(AI_NOT_FOUND.into()));
        }
        self.pc_ai_get(org, sha256)
    }

    // ── apps directory ──

    /// `GET /v1/apps` -> `{apps}`: every app of every current signed policy (display only; devices check the policies
    /// themselves).
    pub fn pc_apps(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mut policies = st.pc_current();
        policies.sort_by_key(|p| pj::s(p, "org"));
        let mut apps = Vec::new();
        for policy in &policies {
            for app in policy.get("apps").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
                apps.push(Value::Object(with(app, obj([("org", policy.get("org").cloned().unwrap_or(Value::Null)), ("label", policy.get("label").cloned().unwrap_or(Value::Null))]))));
            }
        }
        Ok(obj([("apps", Value::Array(apps))]))
    }

    fn pc_icon_path(st: &State, digest: &str) -> Option<PathBuf> {
        st.pc.state_dir.as_ref().map(|d| d.join(ICON_DIR).join(format!("{digest}.png")))
    }

    /// `GET /v1/apps/icon?sha256=`: the PNG named `icon_sha256` by a current policy's app (404 otherwise), with the
    /// answer's headers.
    pub fn pc_icon_get(&self, digest: &str) -> R<parity::EmojiFile> {
        let digest = digest.to_lowercase();
        let gone = || E::NotFound("no such icon".into());
        let data = {
            let mut st = self.st.lock();
            let named = st.pc_current().iter().any(|p| p.get("apps").and_then(Value::as_array).into_iter().flatten().any(|a| a.get("icon_sha256").and_then(Value::as_str) == Some(digest.as_str())));
            if !hex64(&digest) || !named {
                return Err(gone());
            }
            match Self::pc_icon_path(&st, &digest) {
                Some(path) => read_bytes(&path),
                None => st.pc.icons_mem.get(&digest).cloned().unwrap_or_default(),
            }
        };
        if data.is_empty() || crate::codec::sha256_hex(&data) != digest {
            return Err(gone());
        }
        let headers = vec![
            ("Content-Type", "image/png".to_string()),
            ("Content-Length", data.len().to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Content-Security-Policy", "default-src 'none'".to_string()),
            ("Cache-Control", ICON_CACHE.to_string()),
        ];
        Ok((headers, data))
    }

    /// `POST /v1/apps/icon {png}` (base64, at most 64 KB): a relay admin, or an admin of an org whose policy names that
    /// icon.
    pub fn pc_icon_put(&self, session: &str, who: &Identity, png: Body) -> R<Obj> {
        let Some(data) = pj::b64_strict(&pj::str_or(png)) else { return bad("png must be base64") };
        if data.is_empty() || data.len() > ICON_MAX || !data.starts_with(PNG) {
            return bad("an app icon is a PNG of at most 64 KB");
        }
        let digest = crate::codec::sha256_hex(&data);
        {
            let mut st = self.st.lock();
            st.session(session, who)?;
            let mine = st.pc_current().iter().any(|p| strings(p.get("admins")).contains(&who.principal) && p.get("apps").and_then(Value::as_array).into_iter().flatten().any(|a| a.get("icon_sha256").and_then(Value::as_str) == Some(digest.as_str())));
            if !st.admins.contains(&who.principal) && !mine {
                return forbidden(HOLD_WHO);
            }
            match Self::pc_icon_path(&st, &digest) {
                Some(path) => write_atomic(&path, &data).map_err(|e| E::Internal(e.to_string()))?,
                None => {
                    st.pc.icons_mem.insert(digest.clone(), data.clone());
                }
            }
        }
        log_info(&format!("app_icon sha256={digest} by={} bytes={}", who.principal, data.len()));
        Ok(obj([("sha256", Value::from(digest))]))
    }

    fn pc_background_path(st: &State, digest: &str) -> Option<PathBuf> {
        st.pc.state_dir.as_ref().map(|d| d.join(BACKGROUND_DIR).join(format!("{digest}.jpg")))
    }

    fn pc_team_image(policy: &Obj) -> Option<&str> {
        policy.get("video").and_then(|v| v.get("team_image")).and_then(Value::as_str)
    }

    /// BG-1 section 3, `GET /v1/org/background?sha256=`: the JPEG a current policy's `video.team_image` names (404
    /// otherwise), with the answer's headers.
    pub fn pc_background_get(&self, digest: &str) -> R<parity::EmojiFile> {
        let digest = digest.to_lowercase();
        let gone = || E::NotFound("no such background".into());
        let data = {
            let mut st = self.st.lock();
            let named = st.pc_current().iter().any(|p| Self::pc_team_image(p) == Some(digest.as_str()));
            if !hex64(&digest) || !named {
                return Err(gone());
            }
            match Self::pc_background_path(&st, &digest) {
                Some(path) => read_bytes(&path),
                None => st.pc.backgrounds_mem.get(&digest).cloned().unwrap_or_default(),
            }
        };
        if data.is_empty() || crate::codec::sha256_hex(&data) != digest {
            return Err(gone());
        }
        let headers = vec![
            ("Content-Type", "image/jpeg".to_string()),
            ("Content-Length", data.len().to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Content-Security-Policy", "default-src 'none'".to_string()),
            ("Cache-Control", ICON_CACHE.to_string()),
        ];
        Ok((headers, data))
    }

    /// BG-1 section 3, `POST /v1/org/background {jpeg}` (base64, a JPEG of at most 1.5 MB): a relay admin, or an
    /// admin (policy `admins` or signer `org_admins`) of an org whose current policy names that digest.
    pub fn pc_background_put(&self, session: &str, who: &Identity, jpeg: Body) -> R<Obj> {
        let Some(data) = pj::b64_strict(&pj::str_or(jpeg)) else { return bad(BACKGROUND_BAD) };
        if data.is_empty() || data.len() > BACKGROUND_MAX || !data.starts_with(JPEG) {
            return bad(BACKGROUND_BAD);
        }
        let digest = crate::codec::sha256_hex(&data);
        {
            let mut st = self.st.lock();
            st.session(session, who)?;
            let terms = st.pc_terms();
            let mine = st.pc_current().iter().any(|p| {
                Self::pc_team_image(p) == Some(digest.as_str())
                    && (strings(p.get("admins")).contains(&who.principal)
                        || terms.org_admins.get(&pj::text_of(p, "org")).is_some_and(|l| l.contains(&who.principal)))
            });
            if !st.admins.contains(&who.principal) && !mine {
                return forbidden(HOLD_WHO);
            }
            match Self::pc_background_path(&st, &digest) {
                Some(path) => write_atomic(&path, &data).map_err(|e| E::Internal(e.to_string()))?,
                None => {
                    st.pc.backgrounds_mem.insert(digest.clone(), data.clone());
                }
            }
        }
        log_info(&format!("org_background sha256={digest} by={} bytes={}", who.principal, data.len()));
        Ok(obj([("sha256", Value::from(digest))]))
    }

    // ── app and archive sessions ──

    /// `POST /v1/apps/c/hello {}`: an app's or archive's session (its person routes take it as `session`; it is never
    /// in the directory or presence) and `{principal, kind, org, enclave, min_client, session, signer_policy,
    /// org_policies}`.
    pub fn pc_apps_hello(&self, who: &Identity, address: &str, min_client: Obj) -> R<Obj> {
        if who.kind != "app" && who.kind != "archive" {
            return forbidden(APPS_ONLY);
        }
        if !who.own_device() {
            return forbidden(ce::DEVICE_ONLY);
        }
        let org = who.orgs.first().cloned().unwrap_or_default();
        let mut st = self.st.lock();
        let old: Vec<String> = st.sessions.values().filter(|s| s.who.principal == who.principal && s.who.device == who.device).map(|s| s.session_id.clone()).collect();
        for id in old {
            st.end_session(&id, "replaced", false);
        }
        let session = Session {
            session_id: pj::token_urlsafe(12),
            who: who.clone(),
            since: pj::now(),
            last_seen: pj::mono(),
            seq: 0,
            events: VecDeque::new(),
            address: address.to_string(),
            client: obj([("app", Value::from("service"))]),
            waiters: 0,
            active: true,
        };
        let sid = session.session_id.clone();
        st.sessions.insert(sid.clone(), session);
        let hello = st.pc_hello();
        let reply = obj([
            ("principal", Value::from(who.principal.clone())),
            ("kind", Value::from(who.kind.clone())),
            ("org", Value::from(org.clone())),
            ("enclave", Value::Bool(st.pc.enclave)),
            ("min_client", Value::Object(min_client)),
            ("session", Value::from(sid.clone())),
            ("signer_policy", hello.get("signer_policy").cloned().unwrap_or(Value::Null)),
            ("org_policies", hello.get("org_policies").cloned().unwrap_or(Value::Array(Vec::new()))),
        ]);
        drop(st);
        // a replaced session's waiting poll ends now
        self.wake();
        log_info(&format!("apps_hello principal={} kind={} org={org} session={sid} device={}", who.principal, who.kind, who.device));
        Ok(reply)
    }

    /// `GET /v1/apps/c/events?session=&after=&wait=`: the inbox of the service's session, held at most 30 s.
    pub fn pc_apps_events(&self, session: &str, who: &Identity, after: &str, wait: &str) -> R<Obj> {
        if who.kind != "app" && who.kind != "archive" {
            return forbidden(APPS_ONLY);
        }
        let after = m::number(Some(&Value::from(after)), "after")?.trunc() as i64;
        let wait = m::number(Some(&Value::from(wait)), "wait")?.clamp(0.0, EVENTS_WAIT);
        self.inbox(session, who, after, wait)
    }

    /// `POST /v1/apps/c/ack {seq}`: events up to `seq` were handled (they go).
    pub fn pc_apps_ack(&self, session: &str, who: &Identity, seq: Body) -> R<Obj> {
        if who.kind != "app" && who.kind != "archive" {
            return forbidden(APPS_ONLY);
        }
        let mark = m::number(seq, "seq")?.trunc() as i64;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let s = st.sessions.get_mut(session).expect("session");
        s.last_seen = pj::mono();
        while s.events.front().map(|e| seq_of(e) <= mark).unwrap_or(false) {
            s.events.pop_front();
        }
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `GET /v1/dm/history?a=&b=` for an archive: a DM of a person its org covers.
    pub fn pc_archive_dm_history(&self, session: &str, who: &Identity, a: &str, b: &str, after: &str, limit: &str) -> R<Obj> {
        let (a, b) = (a.trim().to_lowercase(), b.trim().to_lowercase());
        let after = m::number(Some(&Value::from(after)), "after")?;
        let most = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, DM_LIMIT_MAX) as usize;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let pair = vec![a.clone(), b.clone()];
        if a.is_empty() || b.is_empty() || !st.pc_archive_reads(who, &pair) {
            return Err(E::NotFound("nothing of that conversation is yours to read".into()));
        }
        let msgs: Vec<&Obj> = st.dms.get(&conv(&a, &b)).into_iter().flatten().filter(|m| pj::num(m, "ts") > after).collect();
        let from = msgs.len().saturating_sub(most);
        let messages: Vec<Value> = msgs[from..].iter().map(|m| Value::Object((*m).clone())).collect();
        let mut sorted = pair;
        sorted.sort();
        let mut out = obj([("messages", Value::Array(messages)), ("pair", string_list(&sorted))]);
        out.extend(st.ce_dm_view());
        Ok(out)
    }

    // ── legal holds ──

    fn pc_holds_check(&self) -> R<()> {
        if !self.st.lock().pc.holds {
            return Err(E::Conflict(HOLDS_OFF.into()));
        }
        Ok(())
    }

    /// `POST /v1/admin/holds {on, principals|cids, reason}` -> `{id}`: an org admin holds people its policy covers; a
    /// relay admin holds conversations.
    pub fn pc_holds_place(&self, session: &str, who: &Identity, on: Body, principals: Body, cids: Body, reason: Body) -> R<Obj> {
        self.pc_holds_check()?;
        let reason = reason_of(reason)?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mine = st.pc_org_admin_of(&who.principal);
        let admin = st.admins.contains(&who.principal);
        let mut hold = obj([
            ("id", Value::from(pj::token_hex(8))),
            ("on", on.cloned().unwrap_or(Value::Null)),
            ("reason", Value::from(reason.clone())),
            ("by", Value::from(who.principal.clone())),
            ("placed", Value::from(pj::now() as i64)),
            ("released", Value::Null),
        ]);
        let items = match on.and_then(Value::as_str) {
            Some("people") => {
                let people = channels::people(principals, "principals", HOLD_ITEMS_MAX)?;
                if people.is_empty() {
                    return bad(format!("principals must name 1 to {HOLD_ITEMS_MAX} people"));
                }
                if mine.is_empty() {
                    return forbidden(if admin { HOLD_ORG_ONLY } else { HOLD_WHO });
                }
                let Some(policy) = mine.iter().find(|p| people.iter().all(|x| op::covers(p, x))) else { return forbidden(HOLD_ORG_ONLY) };
                hold.insert("principals".into(), string_list(&people));
                hold.insert("org".into(), policy.get("org").cloned().unwrap_or(Value::Null));
                string_list(&people)
            }
            Some("conversations") => {
                if !admin {
                    return forbidden(if mine.is_empty() { HOLD_WHO } else { HOLD_RELAY_ONLY });
                }
                let Some(list) = cids.and_then(Value::as_array).filter(|l| (1..=HOLD_ITEMS_MAX).contains(&l.len())) else {
                    return bad(format!("cids must name 1 to {HOLD_ITEMS_MAX} conversations"));
                };
                let mut named: Vec<String> = Vec::new();
                for cid in list {
                    let ok = match cid.as_str() {
                        Some(c) => c.strip_prefix("dm:").map(hex64).unwrap_or(false) || c.strip_prefix("ch:").map(|id| st.channels.contains_key(id)).unwrap_or(false),
                        None => false,
                    };
                    if !ok {
                        return bad("each cid must be ch:<channel id> or dm:<64 hex>");
                    }
                    named.push(cid.as_str().unwrap_or_default().to_string());
                }
                named.sort();
                named.dedup();
                hold.insert("cids".into(), string_list(&named));
                hold.insert("org".into(), Value::from(""));
                string_list(&named)
            }
            _ => return bad("on must be people or conversations"),
        };
        let id = pj::s(&hold, "id");
        st.pc_list("holds").push(Value::Object(hold.clone()));
        st.pc_audit(&who.principal, "hold", obj([("id", Value::from(id.clone())), ("on", hold.get("on").cloned().unwrap_or(Value::Null)), ("items", items), ("reason", Value::from(reason))]));
        Ok(obj([("id", Value::from(id))]))
    }

    /// AC-1 3.7 (M10): whether `principal` may hold these people (an org admin whose policy covers all of them), the
    /// rule an approver of a people hold must meet as its requester did.
    pub fn pc_may_hold_people(&self, principal: &str, people: &[String]) -> bool {
        let mut st = self.st.lock();
        let mine = st.pc_org_admin_of(principal);
        !people.is_empty() && mine.iter().any(|p| people.iter().all(|x| op::covers(p, x)))
    }

    /// AC-1 4.9: how many `org_admins` the signer's policy names for an organization.
    pub fn pc_org_admin_count(&self, org: &str) -> usize {
        let mut st = self.st.lock();
        st.pc_terms().org_admins.get(org).map(Vec::len).unwrap_or(0)
    }

    /// `GET /v1/admin/holds` -> `{holds, on}` (relay admins: all; org admins: their org's).
    pub fn pc_holds_list(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mine = st.pc_org_admin_of(&who.principal);
        if !st.admins.contains(&who.principal) && mine.is_empty() {
            return forbidden(HOLD_WHO);
        }
        let all: Vec<Obj> = st.pc_list("holds").iter().filter_map(Value::as_object).cloned().collect();
        let holds: Vec<Value> = all.into_iter().filter(|h| st.pc_hold_visible(who, h, &mine)).map(Value::Object).collect();
        Ok(obj([("holds", Value::Array(holds)), ("on", Value::Bool(st.pc.holds))]))
    }

    /// `POST /v1/admin/holds/release {id, reason}`: whoever may place that kind of hold releases it; what no hold covers
    /// any more leaves the hold store.
    pub fn pc_holds_release(&self, session: &str, who: &Identity, hold_id: Body, reason: Body) -> R<Obj> {
        self.pc_holds_check()?;
        let reason = reason_of(reason)?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mine = st.pc_org_admin_of(&who.principal);
        let wanted = hold_id.cloned().unwrap_or(Value::Null);
        let found = st.pc_list("holds").iter().position(|h| h.as_object().map(|h| h.get("id") == Some(&wanted)).unwrap_or(false));
        let Some(i) = found else { return Err(E::NotFound(NO_HOLD.into())) };
        let hold = st.pc_list("holds")[i].as_object().cloned().unwrap_or_default();
        if !st.pc_hold_visible(who, &hold, &mine) {
            return Err(E::NotFound(NO_HOLD.into()));
        }
        let on = pj::text_of(&hold, "on");
        if on == "conversations" && !st.admins.contains(&who.principal) {
            return forbidden(HOLD_RELAY_ONLY);
        }
        if on == "people" && !mine.iter().any(|p| p.get("org") == hold.get("org")) {
            return forbidden(HOLD_ORG_ONLY);
        }
        let id = hold.get("id").cloned().unwrap_or(Value::Null);
        if !pj::truthy(hold.get("released")) {
            let released = Value::from(pj::now() as i64);
            if let Some(h) = st.pc_list("holds")[i].as_object_mut() {
                h.insert("released".into(), released);
                h.insert("release_reason".into(), Value::from(reason.clone()));
                h.insert("released_by".into(), Value::from(who.principal.clone()));
            }
            st.pc_audit(&who.principal, "release", obj([("id", id.clone()), ("reason", Value::from(reason))]));
            st.pc_unkeep();
        }
        let released = st.pc_list("holds")[i].get("released").cloned().unwrap_or(Value::Null);
        Ok(obj([("id", id), ("released", released)]))
    }

    // ── the SSO service and its admins ──

    /// `POST /v1/sso/c/hello {asks}` -> `{enclave, signer_policy, min_client, approvals, stops}`: the service's waiting
    /// requests are kept for the admins; the admins' answers since its last hello go back (each once).
    pub fn pc_sso_hello(&self, who: &Identity, asks: Body, min_client: Obj) -> R<Obj> {
        if who.kind != "sso" {
            return forbidden(SSO_ONLY);
        }
        let mut checked = asks_of(asks)?;
        let mut st = self.st.lock();
        for ask in checked.iter_mut() {
            let org = st.pc_ask_org(ask, &who.orgs);
            ask.insert("org".into(), Value::from(org));
        }
        let before = st.pc_map("sso").get(&who.serial).and_then(Value::as_object).cloned().unwrap_or_default();
        let old: Vec<Value> = before.get("asks").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).map(|a| a.get("id").cloned().unwrap_or(Value::Null)).collect();
        let row = obj([("orgs", string_list(&who.orgs)), ("asks", Value::Array(checked.iter().cloned().map(Value::Object).collect())), ("ts", Value::from(pj::now() as i64))]);
        st.pc_map("sso").insert(who.serial.clone(), Value::Object(row));
        let ids: Vec<String> = checked.iter().map(|a| pj::text_of(a, "id")).collect();
        st.pc.sso_answered.retain(|(serial, id), _| *serial != who.serial || ids.contains(id));
        let fresh: Vec<Obj> = checked.iter().filter(|a| !old.contains(a.get("id").unwrap_or(&Value::Null))).cloned().collect();
        if !fresh.is_empty() {
            st.dirty = true;
            let mut admins: Vec<String> = Vec::new();
            for p in st.pc_everyone() {
                if fresh.iter().any(|a| st.pc_ask_visible(&p, a)) {
                    admins.push(p);
                }
            }
            st.tell(&admins, &obj([("type", Value::from("sso_ask")), ("count", Value::from(fresh.len()))]), None);
        }
        let out = st.pc.sso_out.shift_remove(&who.serial).unwrap_or_default();
        let now = pj::now();
        let approvals: Obj = out.approvals.into_iter().filter(|(_, (_, at))| now - at < SSO_APPROVAL_TTL).map(|(k, (row, _))| (k, Value::Object(row))).collect();
        let signer_policy = st.pc_part().get("signer_policy").cloned().unwrap_or(Value::Null);
        let reply = obj([
            ("enclave", Value::Bool(st.pc.enclave)),
            ("signer_policy", signer_policy),
            ("min_client", Value::Object(min_client)),
            ("approvals", Value::Object(approvals)),
            ("stops", string_list(&out.stops)),
        ]);
        drop(st);
        self.wake();
        Ok(reply)
    }

    /// `GET /v1/sso/asks` -> `{asks, adds}`: the SSO requests this admin may answer and the pending adds of channels it
    /// is an admin of.
    pub fn pc_sso_asks(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mut rows: Vec<(String, Obj)> = st.pc_map("sso").iter().filter_map(|(k, v)| v.as_object().map(|o| (k.clone(), o.clone()))).collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let mut asks = Vec::new();
        for (serial, row) in rows {
            for a in row.get("asks").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
                let answered = st.pc.sso_answered.contains_key(&(serial.clone(), pj::text_of(a, "id")));
                if !answered && st.pc_ask_visible(&who.principal, a) {
                    asks.push(Value::Object(with(a, obj([("service", Value::from(serial.clone()))]))));
                }
            }
        }
        let all: Vec<Obj> = st.pc_list("adds").iter().filter_map(Value::as_object).cloned().collect();
        let adds: Vec<Value> = all.into_iter().filter(|a| st.pc_add_visible(&who.principal, a)).map(Value::Object).collect();
        Ok(obj([("asks", Value::Array(asks)), ("adds", Value::Array(adds))]))
    }

    /// `POST /v1/sso/answer {id, answer, proof?, ts?, service?}`: `approve` (the admin's device proof over
    /// `approve_subject(kind, id, subject, "approve")`) or `stop` an SSO request, or `done` with a pending add.
    #[allow(clippy::too_many_arguments)]
    pub fn pc_sso_answer(&self, session: &str, who: &Identity, ask_id: Body, answer: Body, proof: Body, ts: Body, service: Body) -> R<Obj> {
        let ask_id = pj::str_or(ask_id);
        let answer = pj::str_or(answer);
        let service = pj::str_or(service);
        let mut st = self.st.lock();
        st.session(session, who)?;
        if answer == "done" {
            let all: Vec<Obj> = st.pc_list("adds").iter().filter_map(Value::as_object).cloned().collect();
            let Some(add) = all.into_iter().find(|a| pj::text_of(a, "id") == ask_id) else { return Err(E::NotFound(NO_ASK.into())) };
            if !st.pc_add_visible(&who.principal, &add) {
                return Err(E::NotFound(NO_ASK.into()));
            }
            st.pc_list("adds").retain(|a| a.as_object() != Some(&add));
            st.dirty = true;
            return Ok(obj([("ok", Value::Bool(true))]));
        }
        let rows: Vec<(String, Value)> = st.pc_map("sso").iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut found: Option<(String, Obj)> = None;
        for (serial, row) in rows {
            if !service.is_empty() && serial != service {
                continue;
            }
            for ask in row.get("asks").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
                if pj::text_of(ask, "id") == ask_id && st.pc_ask_visible(&who.principal, ask) {
                    found = Some((serial.clone(), ask.clone()));
                }
            }
        }
        let Some((serial, ask)) = found.filter(|(serial, _)| !st.pc.sso_answered.contains_key(&(serial.clone(), ask_id.clone()))) else {
            return Err(E::NotFound(NO_ASK.into()));
        };
        let out = st.pc.sso_out.entry(serial.clone()).or_default();
        match answer.as_str() {
            "approve" => {
                if !pj::truthy(proof) {
                    return bad("approve needs your device's proof");
                }
                if who.cert_pem.is_empty() {
                    return forbidden("approve from one of your devices");
                }
                let row = obj([
                    ("cert_pem", Value::from(who.cert_pem.clone())),
                    ("kind", ask.get("kind").cloned().unwrap_or(Value::Null)),
                    ("id", Value::from(ask_id.clone())),
                    ("proof", Value::from(pj::py_str(proof.unwrap_or(&Value::Null)))),
                    ("ts", proof_ts(ts)),
                ]);
                out.approvals.insert(ask_id.clone(), (row, pj::now()));
            }
            "stop" => {
                if !out.stops.contains(&ask_id) {
                    out.stops.push(ask_id.clone());
                }
            }
            _ => return bad("answer must be approve, stop or done"),
        }
        st.pc.sso_answered.insert((serial, ask_id.clone()), pj::now());
        drop(st);
        log_info(&format!("sso_answer id={} kind={} answer={answer} by={}", kv(&ask_id), pj::s(&ask, "kind"), who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `POST /v1/sso/c/org-member {principal, org, on}`: the relay's directory only (coverage never comes from it).
    pub fn pc_sso_org_member(&self, who: &Identity, principal: Body, org: Body, on: Body) -> R<Obj> {
        if who.kind != "sso" {
            return forbidden(SSO_ONLY);
        }
        let principal = m::principal(principal);
        let org = pj::str_or(org);
        let Some(Value::Bool(on)) = on else { return bad("on must be true or false") };
        if !who.orgs.contains(&org) {
            return forbidden(NOT_SERVED);
        }
        {
            let mut st = self.st.lock();
            if st.pc_sso_domain(who, &principal)? != org {
                return forbidden(NOT_SERVED);
            }
            let label = st.pc_store().and_then(|s| s.newest.get(&org)).map(|v| v.label.clone()).unwrap_or_else(|| org.clone());
            let entry = if *on { Value::Object(obj([("id", Value::from(org.clone())), ("label", Value::from(label))])) } else { Value::Null };
            st.org_edits.insert(principal.clone(), entry);
            st.dirty = true;
        }
        log_info(&format!("sso_org_member principal={principal} org={org} on={}", if *on { "True" } else { "False" }));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `POST /v1/sso/c/pending-add {principal, cid, idp, group}`: a bridgeable channel takes the person at once; an
    /// encrypted one queues an add its admins' devices sign (the relay never writes membership of an encrypted
    /// conversation).
    pub fn pc_sso_pending_add(&self, who: &Identity, principal: Body, cid: Body, idp: Body, group: Body) -> R<Obj> {
        if who.kind != "sso" {
            return forbidden(SSO_ONLY);
        }
        let principal = m::principal(principal);
        let cid = pj::str_or(cid);
        let cid = cid.strip_prefix("ch:").map(str::to_string).unwrap_or(cid);
        let idp = short(idp, "idp", 64, true)?;
        let group = short(group, "group", 200, true)?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.pc_sso_domain(who, &principal)?;
            let Some(ch) = st.channel(&cid).cloned() else { return Err(E::NotFound(channels::NO_CHANNEL.into())) };
            let mut members = channels::members_of(Some(&ch));
            if members.contains(&principal) {
                return Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("member"))]));
            }
            if pj::truthy(ch.get("bridgeable")) {
                if pj::truthy(ch.get("archived")) {
                    return bad("this channel is archived");
                }
                let cap = st.ce_cap(&cid);
                if members.len() >= cap {
                    return bad(format!("this channel is full ({cap} people)"));
                }
                members.push(principal.clone());
                st.channel_mut(&cid).insert("members".into(), string_list(&members));
                let last = st.last_ts(&cid);
                st.mark_read(std::slice::from_ref(&principal), &cid, last);
                st.dirty = true;
                let view = st.channel(&cid).cloned().unwrap_or_default();
                st.tell(&members, &obj([("type", Value::from("channel")), ("why", Value::from("invited")), ("channel", Value::Object(view)), ("by", Value::from(who.principal.clone()))]), None);
                st.bridge_recheck("relay", Some(&cid), None);
                log_info(&format!("sso_pending_add channel={cid} principal={principal} state=added"));
                return Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("added"))]));
            }
            let queued = st.pc_list("adds").iter().filter_map(Value::as_object).find(|a| a.get("principal").and_then(Value::as_str) == Some(principal.as_str()) && a.get("cid").and_then(Value::as_str) == Some(cid.as_str())).map(|a| a.get("id").cloned().unwrap_or(Value::Null));
            if let Some(id) = queued {
                return Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("queued")), ("id", id)]));
            }
            let name = st.directory.get(&principal).and_then(Value::as_object).map(|e| pj::s(e, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| principal.clone());
            let conv_name = match pj::s(&ch, "name") {
                n if n.is_empty() => "this group chat".to_string(),
                n => format!("#{n}"),
            };
            let shown = if idp.is_empty() { "Your sign-in service" } else { idp.as_str() };
            let id = pj::token_hex(8);
            let add = obj([
                ("id", Value::from(id.clone())),
                ("principal", Value::from(principal.clone())),
                ("cid", Value::from(cid.clone())),
                ("idp", Value::from(idp.clone())),
                ("group", Value::from(group.clone())),
                ("ts", Value::from(pj::now() as i64)),
                ("prompt", Value::from(format!("{shown} asks to add {name} to {conv_name}. Add?"))),
            ]);
            let adds = st.pc_list("adds");
            adds.push(Value::Object(add.clone()));
            if adds.len() > SSO_ADDS_MAX {
                let cut = adds.len() - SSO_ADDS_MAX;
                adds.drain(..cut);
            }
            st.dirty = true;
            let mut admins = Vec::new();
            for p in &members {
                if st.pc_add_visible(p, &add) {
                    admins.push(p.clone());
                }
            }
            st.tell(&admins, &obj([("type", Value::from("sso_add")), ("id", Value::from(id.clone())), ("channel", Value::from(cid.clone()))]), None);
            log_info(&format!("sso_pending_add channel={cid} principal={principal} state=queued"));
            Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("queued")), ("id", Value::from(id))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// Every session hears `crl`: fetch the revocation list now. NT-1 section 3.4: each registered iPhone that is
    /// not live for push gets one background push about it (`this_update`: the new CRL's thisUpdate, seconds).
    pub fn pc_tell_crl(&self, this_update: i64) {
        let mut st = self.st.lock();
        let everyone = st.pc_everyone();
        st.tell(&everyone, &obj([("type", Value::from("crl"))]), None);
        st.nt_crl(this_update);
        drop(st);
        self.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_route_allow_list_confines_each_service_kind() {
        assert_eq!(service_confined("app", "GET", "/v1/whoami"), "");
        assert_eq!(service_confined("app", "POST", "/v1/hello"), APP_ROUTES_ONLY);
        assert_eq!(service_confined("archive", "POST", "/v1/dm"), APP_ROUTES_ONLY);
        assert_eq!(service_confined("archive", "POST", "/v1/chat/log"), "");
        assert_eq!(service_confined("sso", "GET", "/v1/crl"), "");
        assert_eq!(service_confined("sso", "GET", "/v1/whoami"), SSO_ROUTES_ONLY);
        assert_eq!(service_confined("connector", "GET", "/healthz"), bridge::ROUTES_ONLY);
        assert_eq!(service_confined("connector", "POST", "/v1/bridge/c/hello"), "");
        assert_eq!(service_confined("person", "POST", "/v1/anything"), "");
        assert_eq!(service_confined("app", "PUT", "/v1/whoami"), APP_ROUTES_ONLY);
    }

    #[test]
    fn certificate_kinds_come_from_the_uris() {
        let uris = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(cert_kind(&uris(&[])).unwrap(), ("person".to_string(), Vec::new()));
        assert_eq!(cert_kind(&uris(&[APP_URI, "urn:lucid-meet:org:meet"])).unwrap(), ("app".to_string(), vec!["meet".to_string()]));
        assert!(matches!(cert_kind(&uris(&[APP_URI])), Err(E::Forbidden(m)) if m == ONE_ORG));
        assert!(matches!(cert_kind(&uris(&[APP_URI, SSO_URI, "urn:lucid-meet:org:a"])), Err(E::Forbidden(m)) if m == ONE_KIND));
        assert!(matches!(cert_kind(&uris(&[SSO_URI])), Err(E::Forbidden(m)) if m == SSO_ORGS));
        assert_eq!(service_kind("helpdesk@apps.meet.test"), "app");
        assert_eq!(service_kind("archive@apps.meet.test"), "archive");
        assert_eq!(service_kind("ann@meet.test"), "");
    }

    #[test]
    fn enclave_networks_are_cidrs_and_hold_their_addresses() {
        let nets = networks(Some(&json!(["10.99.1.2/16", " 192.168.1.7 "])), true).unwrap();
        assert_eq!(nets, vec!["10.99.0.0/16".to_string(), "192.168.1.7/32".to_string()]);
        assert!(inside("10.99.200.1", &nets) && inside("::ffff:10.99.0.9", &nets) && !inside("127.0.0.1", &nets));
        assert_eq!(networks(Some(&json!(["10.0.0.0/8"])), false).unwrap_err(), "enclave_networks needs enclave true");
        assert_eq!(networks(Some(&json!(["nope"])), true).unwrap_err(), "enclave_networks: nope is not a network (CIDR)");
        assert_eq!(networks(Some(&json!("10.0.0.0/8")), true).unwrap_err(), "enclave_networks must be a list of networks (CIDR)");
        assert!(networks(Some(&json!([])), false).unwrap().is_empty());
    }

    #[test]
    fn pols_are_sorted_hashes_each_once() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert_eq!(pols(Some(&json!([a, b]))).unwrap().len(), 2);
        assert!(pols(Some(&json!([b, a]))).is_err());
        assert!(pols(Some(&json!(["x"]))).is_err());
    }
}
