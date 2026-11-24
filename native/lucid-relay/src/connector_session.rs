// Contract API-1 revision 5 (phase 1c), sections 2.2 to 2.8, 5.5, 7.5 and 7.6: one API app's relay session and its
// verified replay into the content store.
//
// Each API app holds an mTLS relay session as a PC-1 app (`POST /v1/apps/c/hello` with its app certificate and sealed
// key) and uses only the PC-1 app routes: bundles, wraps, member logs, history, files, the `GET /v1/apps/c/events`
// long poll and `POST /v1/apps/c/ack`. It stops when the relay's `enclave` differs from the config's (2.2). The org
// policy and AI map are verified and pinned here (`OrgTrust`, the checks of `ai_gateway_policy::verify_pair` without
// its "this gateway is listed in the AI map" rule, which an API app never meets, and with the AI map optional for a
// policy without an `ai` key, 5.4), refreshed on `org_policy` and `org_ai` events and at least every 5 minutes; the
// relay's CRLs at least hourly, and an expired list means "cannot verify": the app stops serving (2.6).
//
// Replay (2.5, 2.7): every member-log entry, wrap and envelope is verified by the app's CE-1 member device
// (`connector_device`) and every message authorized (`ce_device::authorize`, with the `api` apps of the pinned
// policies) before anything reaches the content store or a hook. Group chats and channels are stored; the app's own
// DMs are read only for the person's approval answers and Stop (7.5, 7.6). An event is acknowledged only after it is
// durably applied: stored, erased (a verified `delete` erases the record first), or kept sealed in the device state
// as a row waiting for its key. While the policy or the revocation lists cannot be verified, the batch stops
// unacknowledged at the first row (`EVENTS_HELD`) and the relay delivers it again. A verified log entry removing the
// app (or its leave) stops that conversation at once and schedules its purge within 1 hour (O5), and is
// acknowledged only after that stop mark is written; a revoked app certificate counts as removal from every
// conversation; a policy without the app, or a certificate past its end, stops serving and purges after 24 hours
// unless the app returns (`connector_store` marks).
//
// For slice 1c4 (REST, MCP, approvals, audit), see `ContentHooks` and the `AppSession` accessors.

use crate::ai_gateway_policy::AiMap;
use crate::ce_device::{self as ce, AuthorizeContext, CeCert, DeviceKey, OpenedMessage, Revocation};
use crate::ce_device_log::{self as cl, PolicyView};
use crate::codec::now_ms;
use crate::connector::Enclave;
use crate::connector_device::{revoked_now, DeviceId, MemberDevice, Opened, Policies};
use crate::connector_enroll::{AppIdentity, Enroll, RENEW_ROUTE};
use crate::connector_seal::{names, wipe, SealedStore};
use crate::connector_store::{ContentStore, Purged, StopReason, StoreError, StoredMessage};
use crate::meet::{log_error, log_info, log_warn};
use crate::meet_org_policy::{self as op, Obj};
use crate::meet_x509::{pem_blocks, Cert, Crl};
use parking_lot::{Mutex, RwLock};
use rustls::pki_types::PrivateKeyDer;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Routes of a person that a service session carries `session` on (as the Hub does).
pub const SESSION_ROUTES: [&str; 6] = ["/v1/chat/", "/v1/dm", "/v1/channels/", "/v1/files/", "/v1/apps/c/events", "/v1/apps/c/ack"];
/// The events long poll holds this long (the relay holds at most 30 s).
pub const EVENTS_WAIT_S: u64 = 25;
pub const CRL_EVERY_MS: i64 = 3_600_000;
const CRL_RETRY_MS: i64 = 60_000;
pub const POLICY_EVERY_MS: i64 = 300_000;
const POLICY_RETRY_MS: i64 = 30_000;
const RENEW_CHECK_MS: i64 = 3_600_000;
const HISTORY_LIMIT: usize = 500;
/// DM history read back after a new session (approval answers and Stops sent while the session was away).
const DM_BACKFILL_MS: i64 = 3_600_000;
pub const ENCLAVE_IS: &str = "this relay is an enclave; set enclave in the connector config";
pub const ENCLAVE_NOT: &str = "this relay is not an enclave; remove enclave from the connector config";
pub const NOT_PERSON: &str = "an API app opens a DM only with a person";
pub const NOT_KEPT: &str = "that message is not kept here";
pub const NO_SUCH_FILE: &str = "that message has no such file";
/// A row came while the policy, the certificate lists or the CRLs cannot be verified: the batch stops before it, so
/// nothing after it is acknowledged, and the relay delivers it again once verification works (2.6, 2.7).
pub const EVENTS_HELD: &str = "events held: the policy or the revocation lists cannot be verified now";

/// Why an app (or one of its conversations) is not serving.
pub const STOP_STARTING: &str = "starting";
pub const STOP_NO_CERTIFICATE: &str = "no-certificate";
pub const STOP_ENCLAVE: &str = "enclave";
/// No verified, unexpired org policy is pinned: nothing can be judged.
pub const STOP_UNVERIFIED: &str = "unverified";
/// The pinned policy does not list the app as type `api` with its device.
pub const STOP_POLICY: &str = "policy";
pub const STOP_EXPIRED: &str = "expired";
pub const STOP_REVOKED: &str = "revoked";
/// No fresh revocation list for the app's chain: cannot verify.
pub const STOP_CRL: &str = "crl";
/// By the verified replay, the app is not a current member of that group chat or channel (or it is not one).
pub const STOP_NOT_MEMBER: &str = "not-member";

// ── the relay ───────────────────────────────────────────────────────────────────────────────────────────────

/// A relay call that did not answer 200: `status` 0 when the relay could not be reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayError {
    pub status: u16,
    pub message: String,
}

impl RelayError {
    pub fn new(status: u16, message: impl Into<String>) -> RelayError {
        RelayError { status, message: message.into() }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            f.write_str(&self.message)
        } else {
            write!(f, "the relay answered {}: {}", self.status, self.message)
        }
    }
}

/// The relay as one API app sees it (blocking calls, run off the async workers). Tests feed recorded member logs,
/// wraps and envelopes through their own implementation.
pub trait AppRelay: Send + Sync {
    /// `POST /v1/apps/c/hello {}`: `{principal, kind, org, enclave, min_client, session, signer_policy,
    /// org_policies}`; the session it opens is carried on the session routes from then on.
    fn hello(&self) -> Result<Value, RelayError>;
    /// One PC-1 app route; Ok is the 200 answer's body.
    fn call(&self, method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Vec<u8>, RelayError>;
}

pub fn get_json(relay: &dyn AppRelay, path: &str, query: &[(&str, String)]) -> Result<Value, RelayError> {
    let data = relay.call("GET", path, query, None)?;
    serde_json::from_slice(&data).map_err(|_| RelayError::new(0, "the relay's answer is not JSON"))
}

pub fn get_bytes(relay: &dyn AppRelay, path: &str, query: &[(&str, String)]) -> Result<Vec<u8>, RelayError> {
    relay.call("GET", path, query, None)
}

pub fn post_json(relay: &dyn AppRelay, path: &str, body: &Value) -> Result<Value, RelayError> {
    let data = relay.call("POST", path, &[], Some(body))?;
    if data.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&data).map_err(|_| RelayError::new(0, "the relay's answer is not JSON"))
}

fn error_text(data: &[u8]) -> String {
    serde_json::from_slice::<Value>(data).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| "refused".to_string())
}

/// The real relay: mTLS with the app certificate (`AppIdentity::client_config`), every connection's address checked
/// against `enclave_networks` first when the connector is an enclave.
pub struct RelayLink {
    cfg: RwLock<Arc<rustls::ClientConfig>>,
    host: String,
    port: u16,
    enclave: Enclave,
    session: Mutex<String>,
}

impl RelayLink {
    pub fn new(relay_url: &str, cfg: Arc<rustls::ClientConfig>, enclave: Enclave) -> Result<RelayLink, String> {
        let (host, port) = crate::ai_gateway::host_port(relay_url).ok_or("relay must be an https:// URL")?;
        Ok(RelayLink { cfg: RwLock::new(cfg), host, port, enclave, session: Mutex::new(String::new()) })
    }

    /// A renewed certificate: new connections use it, and the next call needs a new hello.
    pub fn set_client(&self, cfg: Arc<rustls::ClientConfig>) {
        *self.cfg.write() = cfg;
        self.session.lock().clear();
    }

    fn raw(&self, method: &str, target: &str, body: Option<&Value>, timeout: f64) -> Result<(u16, Vec<u8>), RelayError> {
        self.enclave.check_host(&self.host, self.port).map_err(|m| RelayError::new(0, m))?;
        let cfg = self.cfg.read().clone();
        let bytes = body.map(|b| b.to_string().into_bytes());
        let headers: Vec<(&str, String)> = if bytes.is_some() { vec![("Content-Type", "application/json".to_string())] } else { Vec::new() };
        match crate::meet_tls::https_request(&cfg, &self.host, self.port, timeout, method, target, &headers, bytes.as_deref(), &|_| Ok(())) {
            Ok(r) => Ok((r.status, r.body)),
            Err(Ok(m)) | Err(Err(m)) => Err(RelayError::new(0, format!("the relay cannot be reached ({m})"))),
        }
    }
}

impl AppRelay for RelayLink {
    fn hello(&self) -> Result<Value, RelayError> {
        let (status, data) = self.raw("POST", "/v1/apps/c/hello", Some(&json!({})), 20.0)?;
        if status != 200 {
            return Err(RelayError::new(status, error_text(&data)));
        }
        let v: Value = serde_json::from_slice(&data).map_err(|_| RelayError::new(0, "the relay's answer is not JSON"))?;
        let session = v.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| RelayError::new(0, "the relay opened no session"))?;
        *self.session.lock() = session.to_string();
        Ok(v)
    }

    fn call(&self, method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Vec<u8>, RelayError> {
        let session = self.session.lock().clone();
        let mut q: Vec<(&str, String)> = query.to_vec();
        let mut b = body.cloned();
        if !session.is_empty() && SESSION_ROUTES.iter().any(|r| path.starts_with(r)) {
            if method == "GET" {
                q.push(("session", session));
            } else if let Some(Value::Object(o)) = b.as_mut() {
                o.insert("session".to_string(), Value::String(session));
            }
        }
        let target = if q.is_empty() { path.to_string() } else { format!("{path}?{}", q.iter().map(|(k, v)| format!("{k}={}", crate::ai_gateway_backend::uri_encode(v))).collect::<Vec<_>>().join("&")) };
        let timeout = if path == "/v1/apps/c/events" { (EVENTS_WAIT_S + 15) as f64 } else { 30.0 };
        let (status, data) = self.raw(method, &target, b.as_ref(), timeout)?;
        if status == 410 {
            // the session ended (replaced or expired): the app says hello again and syncs
            self.session.lock().clear();
        }
        if status != 200 {
            return Err(RelayError::new(status, error_text(&data)));
        }
        Ok(data)
    }
}

/// The relay's `enclave` must equal the config's (PC-1 invariant 4).
pub fn check_enclave(hello: &Value, enclave: bool) -> Result<(), &'static str> {
    let relay = hello.get("enclave") == Some(&Value::Bool(true));
    if relay && !enclave {
        return Err(ENCLAVE_IS);
    }
    if enclave && !relay {
        return Err(ENCLAVE_NOT);
    }
    Ok(())
}

// ── the org policy, AI map and revocation lists ─────────────────────────────────────────────────────────────

/// A verified signed org policy pinned for its org.
#[derive(Clone, Debug)]
pub struct Pin {
    pub org: String,
    pub hash: String,
    pub seq: i64,
    pub expires: i64,
    pub policy: Obj,
    pub wire: Value,
}

/// The own org's verified AI map, the one its pinned policy names.
#[derive(Clone, Debug)]
pub struct MapPin {
    pub hash: String,
    pub seq: i64,
    pub map: AiMap,
    pub wire: Value,
}

/// What the pinned policy says of an app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyState {
    /// Listed as type `api` with its device.
    Listed,
    /// The verified policy does not list it so.
    NotListed,
    /// No verified, unexpired policy is pinned.
    Unverified,
}

impl PolicyState {
    pub fn code(self) -> &'static str {
        match self {
            PolicyState::Listed => "listed",
            PolicyState::NotListed => "not-listed",
            PolicyState::Unverified => "unverified",
        }
    }
}

#[derive(Default)]
struct TrustState {
    signer_policy: Option<Obj>,
    chains: Vec<String>,
    crls: Vec<Crl>,
    revocation: Option<Revocation>,
    by_hash: BTreeMap<String, Value>,
    pins: BTreeMap<String, Pin>,
    map: Option<MapPin>,
}

const PINS_FILE: &str = "pins.json";
const CRL_FILE: &str = "relay-crl.der";

/// The org policies, AI map and revocation lists this connector verified against the Meet CA (`client_ca`), never
/// trusting the relay: a policy verifies as a device verifies it (`meet_org_policy::verify`), is kept by hash for
/// log entries and wraps that name it, and is pinned per org (a lower or equal `seq` with other bytes is refused).
/// The pins and the relay's lists are kept in `state_dir` (`pins.json`, `relay-crl.der`; R0, nothing secret) and
/// verified again at start.
pub struct OrgTrust {
    org: String,
    ca_pem: String,
    roots: Vec<Cert>,
    dir: Option<PathBuf>,
    require_crl: bool,
    st: RwLock<TrustState>,
}

impl OrgTrust {
    pub fn open(org: &str, ca_pem: &str, dir: Option<PathBuf>, require_crl: bool, now_ms: i64) -> Result<OrgTrust, String> {
        let roots: Vec<Cert> = pem_blocks(ca_pem.as_bytes(), "CERTIFICATE").into_iter().filter_map(|(_, d)| Cert::from_der(&d)).filter(|c| c.subject == c.issuer).collect();
        if roots.is_empty() {
            return Err("client_ca holds no root certificate".to_string());
        }
        let trust = OrgTrust { org: org.to_string(), ca_pem: ca_pem.to_string(), roots, dir, require_crl, st: RwLock::new(TrustState::default()) };
        if let Some(d) = trust.dir.clone() {
            if let Ok(der) = std::fs::read(d.join(CRL_FILE)) {
                trust.take_crls(&der, false);
            }
            if let Some(v) = std::fs::read(d.join(PINS_FILE)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                trust.take_signer_policy(v.get("signer_policy"));
                let mut st = trust.st.write();
                for wire in v.get("policies").and_then(Value::as_array).into_iter().flatten() {
                    if let Err(e) = trust.take_policy_locked(&mut st, wire, now_ms) {
                        log_warn(&format!("connector_pin_dropped error={e}"));
                    }
                }
                if let Some(m) = v.get("map").filter(|m| m.is_object()) {
                    if let Err(e) = trust.take_map_locked(&mut st, m, now_ms) {
                        log_warn(&format!("connector_map_pin_dropped error={e}"));
                    }
                }
            }
        }
        Ok(trust)
    }

    fn save(&self, st: &TrustState) {
        let Some(d) = &self.dir else { return };
        let v = json!({
            "signer_policy": st.signer_policy,
            "policies": st.pins.values().map(|p| p.wire.clone()).collect::<Vec<_>>(),
            "map": st.map.as_ref().map(|m| m.wire.clone()),
        });
        if let Err(e) = crate::meet_tls::write_atomic(&d.join(PINS_FILE), v.to_string().as_bytes()) {
            log_warn(&format!("connector_pins_not_written error={e}"));
        }
    }

    fn root_of(&self, sp: &Obj) -> Option<&Cert> {
        self.roots.iter().find(|r| op::verify_signer_policy(r, sp))
    }

    fn root_crl<'a>(crls: &'a [Crl], root: &Cert) -> Option<&'a Crl> {
        crls.iter().filter(|c| c.issuer == root.subject && c.signature_valid(&root.spki)).max_by_key(|c| c.this_update)
    }

    /// A signer policy signed by the org's root replaces the one held.
    pub fn take_signer_policy(&self, v: Option<&Value>) -> bool {
        let Some(sp) = v.and_then(Value::as_object).filter(|o| !o.is_empty()) else { return false };
        if self.root_of(sp).is_none() {
            return false;
        }
        let mut st = self.st.write();
        if st.signer_policy.as_ref() == Some(sp) {
            return false;
        }
        st.signer_policy = Some(sp.clone());
        true
    }

    fn take_policy_locked(&self, st: &mut TrustState, wire: &Value, now_ms: i64) -> Result<bool, String> {
        let sp = st.signer_policy.clone().ok_or("the relay has sent no signer policy yet")?;
        let root = self.root_of(&sp).ok_or("the signer policy is not signed by this organization's root")?;
        let crl = OrgTrust::root_crl(&st.crls, root);
        let v = op::verify(wire, root, &sp, crl, "", now_ms as f64 / 1000.0).map_err(|e| format!("an org policy does not verify: {e}"))?;
        st.by_hash.insert(v.hash.clone(), Value::Object(v.policy.clone()));
        match st.pins.get(&v.org) {
            Some(p) if p.hash == v.hash => return Ok(false),
            Some(p) if v.seq <= p.seq => return Err(format!("the relay's policy seq {} for {} is not higher than the pinned {}", v.seq, v.org, p.seq)),
            _ => {}
        }
        let expires = v.policy.get("expires").and_then(Value::as_i64).unwrap_or(0);
        st.pins.insert(v.org.clone(), Pin { org: v.org.clone(), hash: v.hash, seq: v.seq, expires, policy: v.policy, wire: wire.clone() });
        Ok(true)
    }

    fn take_map_locked(&self, st: &mut TrustState, wire: &Value, now_ms: i64) -> Result<bool, String> {
        let pin = st.pins.get(&self.org).cloned().ok_or("no org policy is pinned")?;
        let sp = st.signer_policy.clone().ok_or("the relay has sent no signer policy yet")?;
        let root = self.root_of(&sp).ok_or("the signer policy is not signed by this organization's root")?;
        let crl = OrgTrust::root_crl(&st.crls, root);
        let m = op::verify_ai_map(wire, root, &sp, crl, "", now_ms as f64 / 1000.0, Some(&pin.policy)).map_err(|e| format!("the AI map does not verify: {e}"))?;
        op::check_ai_map_named(&pin.policy, &m.hash).map_err(|e| format!("the AI map is not the one the policy names: {e}"))?;
        if let Some(cur) = &st.map {
            if cur.hash == m.hash {
                return Ok(false);
            }
            if m.seq < cur.seq {
                return Err(format!("the relay's AI map seq {} is lower than the pinned {}", m.seq, cur.seq));
            }
        }
        let map = m.wire.get("map").cloned().unwrap_or(Value::Null);
        st.map = Some(MapPin { hash: m.hash, seq: m.seq, map: AiMap::read(&map), wire: wire.clone() });
        Ok(true)
    }

    /// A signed policy from the relay: verified, kept by hash, pinned when newer.
    pub fn take_policy(&self, wire: &Value, now_ms: i64) -> Result<bool, String> {
        let mut st = self.st.write();
        let changed = self.take_policy_locked(&mut st, wire, now_ms)?;
        if changed {
            self.save(&st);
        }
        Ok(changed)
    }

    /// The hello's `signer_policy` and `org_policies`.
    pub fn take_hello(&self, hello: &Value, now_ms: i64) {
        self.take_signer_policy(hello.get("signer_policy"));
        for wire in hello.get("org_policies").and_then(Value::as_array).into_iter().flatten() {
            if let Err(e) = self.take_policy(wire, now_ms) {
                log_info(&format!("connector_policy_not_taken error={e}"));
            }
        }
    }

    /// `GET /v1/org/policy?org=` and, when the policy names one, `GET /v1/org/ai?org=&sha256=`: verified and pinned.
    /// True when either pin changed.
    pub fn refresh(&self, relay: &dyn AppRelay, now_ms: i64) -> Result<bool, String> {
        let got = get_json(relay, "/v1/org/policy", &[("org", self.org.clone())]).map_err(|e| e.to_string())?;
        self.take_signer_policy(got.get("signer_policy"));
        let mut changed = match self.take_policy(got.get("signed").unwrap_or(&Value::Null), now_ms) {
            Ok(c) => c,
            Err(e) => {
                log_warn(&format!("connector_policy_refused org={} error={e}", self.org));
                false
            }
        };
        let (named, held) = {
            let st = self.st.read();
            let Some(pin) = st.pins.get(&self.org) else { return Err(format!("the relay sent no verified policy for {}", self.org)) };
            let named = pin.policy.get("ai").and_then(|a| a.get("map_sha256")).and_then(Value::as_str).map(str::to_string);
            (named, st.map.as_ref().map(|m| m.hash.clone()))
        };
        match named {
            None => {
                let mut st = self.st.write();
                if st.map.take().is_some() {
                    changed = true;
                    self.save(&st);
                }
            }
            Some(sha) if held.as_deref() == Some(sha.as_str()) => {}
            Some(sha) => {
                let m = get_json(relay, "/v1/org/ai", &[("org", self.org.clone()), ("sha256", sha)]).map_err(|e| e.to_string())?;
                let mut st = self.st.write();
                if self.take_map_locked(&mut st, m.get("signed").unwrap_or(&Value::Null), now_ms)? {
                    changed = true;
                    self.save(&st);
                }
            }
        }
        Ok(changed)
    }

    /// An app's certificate chain: its issuers need fresh lists too.
    pub fn note_chain(&self, chain_pem: &str) {
        let mut st = self.st.write();
        if !chain_pem.trim().is_empty() && !st.chains.iter().any(|c| c == chain_pem) {
            st.chains.push(chain_pem.to_string());
        }
    }

    fn take_crls(&self, der: &[u8], keep: bool) -> bool {
        let chains = self.st.read().chains.concat();
        let fresh = Revocation::parse(der, &self.ca_pem, &chains).ok().filter(Revocation::usable);
        let lists = crate::ai_gateway::crls_of(der);
        if fresh.is_none() && lists.is_empty() {
            return false;
        }
        let mut st = self.st.write();
        if let Some(r) = fresh {
            st.revocation = Some(r.merge(st.revocation.as_ref()));
        }
        for c in lists {
            match st.crls.iter().position(|o| o.issuer == c.issuer) {
                Some(i) => {
                    if c.this_update > st.crls[i].this_update {
                        st.crls[i] = c;
                    }
                }
                None => st.crls.push(c),
            }
        }
        if keep {
            if let Some(d) = &self.dir {
                if let Err(e) = crate::meet_tls::write_atomic(&d.join(CRL_FILE), der) {
                    log_warn(&format!("connector_crl_not_written error={e}"));
                }
            }
        }
        true
    }

    /// The relay's `GET /v1/crl` (DER, back to back): each list verified against the Meet CA or an app's chain;
    /// per issuer the newer list is kept. False when none of them verifies.
    pub fn set_crls(&self, der: &[u8]) -> bool {
        self.take_crls(der, true)
    }

    /// Every issuer of `chain_pem` (and the Meet CA) has a fresh verified list (always true without `require_crl`).
    pub fn crl_fresh(&self, chain_pem: &str, now_ms: i64) -> bool {
        if !self.require_crl {
            return true;
        }
        let st = self.st.read();
        let Some(rev) = st.revocation.as_ref() else { return false };
        let Ok(ca) = CeCert::from_pem(&self.ca_pem) else { return false };
        let mut issuers = vec![ca];
        issuers.extend(CeCert::chain(chain_pem));
        issuers.iter().all(|i| rev.crls.iter().any(|(who, l)| who.x.subject == i.x.subject && who.x.spki == i.x.spki && l.fresh(now_ms)))
    }

    pub fn revocation(&self) -> Option<Revocation> {
        self.st.read().revocation.clone()
    }

    pub fn require_crl(&self) -> bool {
        self.require_crl
    }

    /// The own org's pinned policy.
    pub fn own_pin(&self) -> Option<Pin> {
        self.st.read().pins.get(&self.org).cloned()
    }

    /// The own org's verified AI map (None when the policy names none, or it has not verified yet).
    pub fn ai_map(&self) -> Option<MapPin> {
        self.st.read().map.clone()
    }

    /// 2.3, 5.2 step 3: the pinned, unexpired policy lists `principal` as an `api` app with `device`.
    pub fn app_state(&self, principal: &str, device: &str, now_ms: i64) -> PolicyState {
        let st = self.st.read();
        let Some(pin) = st.pins.get(&self.org) else { return PolicyState::Unverified };
        if pin.expires.saturating_mul(1000) <= now_ms {
            return PolicyState::Unverified;
        }
        let listed = pin.policy.get("apps").and_then(Value::as_array).into_iter().flatten().any(|a| {
            a.get("type").and_then(Value::as_str) == Some(op::API_APP_TYPE) && a.get("principal").and_then(Value::as_str) == Some(principal) && a.get("device").and_then(Value::as_str) == Some(device)
        });
        if listed {
            PolicyState::Listed
        } else {
            PolicyState::NotListed
        }
    }

    /// The pinned policy's `retention` (kind to days) for the store's daily retention.
    pub fn retention_days(&self) -> BTreeMap<String, u32> {
        let st = self.st.read();
        let Some(r) = st.pins.get(&self.org).and_then(|p| p.policy.get("retention")).and_then(Value::as_object) else { return BTreeMap::new() };
        r.iter().filter_map(|(k, v)| v.as_u64().and_then(|d| u32::try_from(d).ok()).map(|d| (k.clone(), d))).collect()
    }

    /// The `api` app principals of the in-force policies (`authorize`'s `api_apps`).
    pub fn api_apps(&self, now_ms: i64) -> Vec<String> {
        ce::api_app_principals(&self.view(now_ms))
    }

    /// Slice 1c4 (r5 2.8): what the connector checks a signed api map against, exactly as a relay does: the Meet CA
    /// root that signed the held signer policy, that signer policy, and the root's newest verified CRL. None while no
    /// signer policy signed by a root of `client_ca` is held.
    pub fn map_trust(&self) -> Option<(Cert, Obj, Option<Crl>)> {
        let st = self.st.read();
        let sp = st.signer_policy.clone()?;
        let root = self.root_of(&sp)?.clone();
        let crl = OrgTrust::root_crl(&st.crls, &root).cloned();
        Some((root, sp, crl))
    }

    /// Slice 1c4 (r5 2.8): the own org's pinned policy object, which a received api map is checked against.
    pub fn own_policy(&self) -> Option<Obj> {
        self.st.read().pins.get(&self.org).map(|p| p.policy.clone())
    }

    /// A verified policy for the tests: pinned as if the relay had served it signed.
    #[cfg(test)]
    pub(crate) fn pin_for_test(&self, policy: Value) {
        let obj = policy.as_object().cloned().unwrap_or_default();
        let hash = cl::org_policy_hash(&obj);
        let org = obj.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut st = self.st.write();
        st.by_hash.insert(hash.clone(), policy.clone());
        let (seq, expires) = (obj.get("seq").and_then(Value::as_i64).unwrap_or(0), obj.get("expires").and_then(Value::as_i64).unwrap_or(0));
        st.pins.insert(org.clone(), Pin { org, hash, seq, expires, policy: obj, wire: Value::Null });
    }
}

impl Policies for OrgTrust {
    fn view(&self, now_ms: i64) -> PolicyView {
        let st = self.st.read();
        PolicyView { by_hash: st.by_hash.clone(), newest: st.pins.iter().map(|(o, p)| (o.clone(), p.hash.clone())).collect(), now_s: now_ms.div_euclid(1000), own_org: String::new() }
    }

    fn fetch_by_hash(&self, relay: &dyn AppRelay, sha256: &str, now_ms: i64) {
        match get_json(relay, "/v1/org/policy", &[("sha256", sha256.to_string())]) {
            Ok(got) => {
                self.take_signer_policy(got.get("signer_policy"));
                if let Err(e) = self.take_policy(got.get("signed").unwrap_or(&Value::Null), now_ms) {
                    log_info(&format!("connector_policy_by_hash error={e}"));
                }
            }
            Err(e) => log_info(&format!("connector_policy_not_fetched status={}", e.status)),
        }
    }
}

// ── what slice 1c4 hooks into ───────────────────────────────────────────────────────────────────────────────

/// The five content event types of r5 7.6.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentKind {
    MessageCreated,
    MessageEdited,
    MessageDeleted,
    ConversationAdded,
    ConversationRemoved,
}

impl ContentKind {
    /// The `type` of the event (`message.created`, ...).
    pub fn name(self) -> &'static str {
        match self {
            ContentKind::MessageCreated => "message.created",
            ContentKind::MessageEdited => "message.edited",
            ContentKind::MessageDeleted => "message.deleted",
            ContentKind::ConversationAdded => "conversation.added",
            ContentKind::ConversationRemoved => "conversation.removed",
        }
    }
}

/// One content event, in the order the connector verified it. `mid` names the message for the three message types;
/// the message itself is read from the store at delivery (r5 2.9).
#[derive(Clone, Debug, PartialEq)]
pub struct ContentEvent {
    pub kind: ContentKind,
    pub conv: String,
    pub mid: Option<String>,
}

/// What slice 1c4 hooks into. Every call is made only for verified, authorized messages, on the app session's own
/// thread, in verified order, and before the relay event that carried it is acknowledged (a hook that must not lose
/// the call records it durably before it returns; it must not block for long).
///
/// - `approval_answer`: a CE-1 `post` with `apra` (7.4, 7.5 step 3) signed by one of `person`'s own devices, in the
///   app's DM with `person`; `mid` is its message id. Matching `id` and `h` against the waiting approval is 1c4's.
/// - `person_stop`: a `stop {client}` from `person` likewise (7.6).
/// - `event`: every content event of the app's group chats and channels (7.6; 5.2 visibility is judged by 1c4 at
///   delivery).
/// - `purged`: a store purge done (12.2 `connector.store.purged`); `principal` is the app's ("" before its
///   certificate loads).
pub trait ContentHooks: Send + Sync {
    fn approval_answer(&self, app: &str, person: &str, mid: &str, apra: &Value);
    fn person_stop(&self, app: &str, person: &str, client: &str, mid: &str);
    fn event(&self, app: &str, ev: &ContentEvent);
    fn purged(&self, _principal: &str, _p: &Purged, _now_ms: i64) {}
}

/// One conversation an app is a verified member of (2.8 `conversations` of the sync acknowledgment).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationInfo {
    pub cid: String,
    pub app: String,
    /// `channel` or `group`.
    pub kind: &'static str,
    /// The relay's channel name (R0, for pickers and counts only; "" when not seen yet).
    pub name: String,
    /// When the app's current membership began (the verified `add` entry's time, ms).
    pub since: i64,
}

impl ConversationInfo {
    pub fn to_json(&self) -> Value {
        json!({"cid": self.cid, "app": self.app, "kind": self.kind, "name": self.name, "since": self.since})
    }
}

// ── one API app's session ───────────────────────────────────────────────────────────────────────────────────

/// What every app session of the connector shares.
pub struct Shared {
    /// The Meet CA (`client_ca`) PEM.
    pub ca_pem: String,
    pub trust: OrgTrust,
    pub store: Arc<ContentStore>,
    pub sealed: Arc<SealedStore>,
    pub hooks: Arc<dyn ContentHooks>,
    pub enclave: bool,
}

struct State {
    device: Option<MemberDevice>,
    not_after_ms: i64,
    enclave_mismatch: bool,
    stop: Option<&'static str>,
    connected: bool,
    last_crl_ms: i64,
    last_policy_ms: i64,
    withheld: u64,
}

fn text_at<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// One API app: its relay session, its member device, and its verified replay into the content store.
pub struct AppSession {
    pub app: String,
    shared: Arc<Shared>,
    relay: Arc<dyn AppRelay>,
    st: Mutex<State>,
}

impl AppSession {
    pub fn new(app: &str, shared: Arc<Shared>, relay: Arc<dyn AppRelay>) -> AppSession {
        AppSession {
            app: app.to_string(),
            shared,
            relay,
            st: Mutex::new(State { device: None, not_after_ms: 0, enclave_mismatch: false, stop: Some(STOP_STARTING), connected: false, last_crl_ms: 0, last_policy_ms: 0, withheld: 0 }),
        }
    }

    // Test-only: the connector, REST, A2A, view and end-to-end tests build a `Connector` around a test session.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    fn save(&self, d: &MemberDevice) -> Result<(), String> {
        self.shared.sealed.put(&names::chat_keys(&self.app), &d.to_value())
    }

    /// The app's certificate and key (at start, and after a renewal): the sealed device state is loaded the first
    /// time.
    pub fn attach(&self, id: DeviceId, not_after_ms: i64) -> Result<(), String> {
        self.shared.trust.note_chain(&id.chain_pem);
        let mut st = self.st.lock();
        match st.device.as_mut() {
            Some(d) => d.set_id(id)?,
            None => {
                let require = self.shared.trust.require_crl();
                let d = match self.shared.sealed.get(&names::chat_keys(&self.app))? {
                    Some(v) => MemberDevice::load(id, &self.shared.ca_pem, require, &v)?,
                    None => MemberDevice::new(id, &self.shared.ca_pem, require)?,
                };
                st.device = Some(d);
            }
        }
        let rev = self.shared.trust.revocation();
        if let Some(d) = st.device.as_mut() {
            d.set_revocation(rev);
        }
        st.not_after_ms = not_after_ms;
        Ok(())
    }

    pub fn connected(&self) -> bool {
        self.st.lock().connected
    }

    /// The session ended (a relay error, a renewal): the next round says hello again and syncs.
    pub fn disconnect(&self) {
        self.st.lock().connected = false;
    }

    /// The relay's `enclave` differed from the config's: this app stays stopped.
    pub fn enclave_stopped(&self) -> bool {
        self.st.lock().enclave_mismatch
    }

    pub fn set_stop(&self, why: &'static str) {
        self.st.lock().stop = Some(why);
    }

    /// `POST /v1/apps/c/hello`, the enclave check, the policy and lists, the bundle, then a sync of wraps, logs and
    /// history (the relay drops a replaced session's events, so whatever happened meanwhile is read back).
    pub fn connect(&self, now_ms: i64) -> Result<(), String> {
        let hello = self.relay.hello().map_err(|e| e.to_string())?;
        let mut st = self.st.lock();
        if let Err(e) = check_enclave(&hello, self.shared.enclave) {
            st.enclave_mismatch = true;
            st.stop = Some(STOP_ENCLAVE);
            log_error(&format!("connector_app_stopped app={} reason={e}", self.app));
            return Err(e.to_string());
        }
        self.shared.trust.take_hello(&hello, now_ms);
        self.refresh_crl_locked(&mut st, now_ms);
        self.refresh_policy_locked(&mut st, now_ms);
        self.health_locked(&mut st, now_ms);
        self.publish_bundle_locked(&mut st, now_ms)?;
        self.sync_locked(&mut st, now_ms)?;
        st.connected = true;
        log_info(&format!("connector_app_connected app={} serving={}", self.app, st.stop.unwrap_or("yes")));
        Ok(())
    }

    fn refresh_crl_locked(&self, st: &mut State, now_ms: i64) {
        match get_bytes(&*self.relay, "/v1/crl", &[]) {
            Ok(der) => {
                if !self.shared.trust.set_crls(&der) {
                    log_warn(&format!("connector_crl_unverified app={}", self.app));
                }
                st.last_crl_ms = now_ms;
            }
            Err(e) => {
                log_warn(&format!("connector_crl_refresh_failed app={} error={e}", self.app));
                st.last_crl_ms = now_ms - CRL_EVERY_MS + CRL_RETRY_MS;
            }
        }
        let rev = self.shared.trust.revocation();
        if let Some(d) = st.device.as_mut() {
            d.revoked = d.id.cert().is_some_and(|c| revoked_now(rev.as_ref(), &c, now_ms));
            if d.revoked {
                log_error(&format!("connector_app_revoked app={}", self.app));
            }
            d.set_revocation(rev);
        }
    }

    fn refresh_policy_locked(&self, st: &mut State, now_ms: i64) {
        match self.shared.trust.refresh(&*self.relay, now_ms) {
            Ok(changed) => {
                if changed {
                    if let Some(p) = self.shared.trust.own_pin() {
                        log_info(&format!("connector_policy_pinned org={} seq={} hash={}", p.org, p.seq, p.hash));
                    }
                }
                st.last_policy_ms = now_ms;
            }
            Err(e) => {
                log_warn(&format!("connector_policy_refresh_failed app={} error={e}", self.app));
                st.last_policy_ms = now_ms - POLICY_EVERY_MS + POLICY_RETRY_MS;
            }
        }
    }

    /// Whether the app serves now, applying the store's stop marks (2.4, 2.6, 2.7): revoked (purge within 1 hour),
    /// past its certificate's end or not listed in the policy (purge after 24 hours unless it comes back); no
    /// verified policy or no fresh lists stop serving without a purge. None is serving.
    pub fn health(&self, now_ms: i64) -> Option<&'static str> {
        let mut st = self.st.lock();
        self.health_locked(&mut st, now_ms)
    }

    fn health_locked(&self, st: &mut State, now_ms: i64) -> Option<&'static str> {
        let trust = &self.shared.trust;
        let mut purge: Option<StopReason> = None;
        let stop = if st.enclave_mismatch {
            Some(STOP_ENCLAVE)
        } else if let Some(d) = st.device.as_ref() {
            if d.revoked {
                purge = Some(StopReason::Revoked);
                Some(STOP_REVOKED)
            } else if now_ms > st.not_after_ms {
                purge = Some(StopReason::Expired);
                Some(STOP_EXPIRED)
            } else {
                match trust.app_state(&d.id.principal, &d.id.device, now_ms) {
                    PolicyState::NotListed => {
                        purge = Some(StopReason::Policy);
                        Some(STOP_POLICY)
                    }
                    PolicyState::Unverified => Some(STOP_UNVERIFIED),
                    PolicyState::Listed if !trust.crl_fresh(&d.id.chain_pem, now_ms) => Some(STOP_CRL),
                    PolicyState::Listed => None,
                }
            }
        } else {
            Some(STOP_NO_CERTIFICATE)
        };
        let store = &self.shared.store;
        match purge {
            Some(r) => {
                if let Err(e) = store.stop_app(&self.app, r, now_ms) {
                    log_error(&format!("connector_store_stop_failed app={} error={e}", self.app));
                }
            }
            None if stop.is_none() => match store.resume_app(&self.app, now_ms) {
                Ok(Some(p)) => {
                    log_info(&format!("connector.store.purged app={} reason={} records={}", p.app, p.reason, p.records));
                    let principal = st.device.as_ref().map(|d| d.id.principal.clone()).unwrap_or_default();
                    self.shared.hooks.purged(&principal, &p, now_ms);
                }
                Ok(None) => {}
                Err(e) => log_error(&format!("connector_store_resume_failed app={} error={e}", self.app)),
            },
            None => {}
        }
        if stop != st.stop {
            log_info(&format!("connector_app_serving app={} state={}", self.app, stop.unwrap_or("serving")));
        }
        st.stop = stop;
        stop
    }

    /// A new chat key bundle when due (sealed before it leaves), published with `POST /v1/chat/devices`.
    fn publish_bundle_locked(&self, st: &mut State, now_ms: i64) -> Result<(), String> {
        let Some(d) = st.device.as_mut() else { return Err(STOP_NO_CERTIFICATE.to_string()) };
        if d.revoked {
            return Ok(());
        }
        if d.ensure_bundle(now_ms)? {
            self.save(d)?;
        }
        if let Some(b) = d.bundle().cloned() {
            post_json(&*self.relay, "/v1/chat/devices", &json!({"bundle": b})).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Hourly CRLs, the policy every 5 minutes, the bundle when due, then `health`.
    pub fn tick(&self, now_ms: i64) {
        let mut st = self.st.lock();
        if now_ms - st.last_crl_ms >= CRL_EVERY_MS {
            self.refresh_crl_locked(&mut st, now_ms);
        }
        if now_ms - st.last_policy_ms >= POLICY_EVERY_MS {
            self.refresh_policy_locked(&mut st, now_ms);
        }
        let due = st.device.as_ref().is_some_and(|d| d.bundle().is_none() || ce::bundle_due(d.my_bundle().as_ref(), &d.id.serial, now_ms.div_euclid(1000)));
        if due && st.connected {
            if let Err(e) = self.publish_bundle_locked(&mut st, now_ms) {
                log_warn(&format!("connector_bundle_not_published app={} error={e}", self.app));
            }
        }
        let before = st.stop;
        if self.health_locked(&mut st, now_ms).is_none() && before.is_some() && st.connected {
            // rows kept while nothing could be verified are read now
            let mut done = self.retry_pending(&mut st, now_ms);
            if done.is_ok() {
                done = self.after_changes(&mut st, now_ms);
            }
            let saved = st.device.as_ref().map_or(Ok(()), |d| self.save(d));
            if let Err(e) = done.and(saved) {
                log_warn(&format!("connector_pending_not_applied app={} error={e}", self.app));
            }
        }
    }

    // ── replay ──────────────────────────────────────────────────────────────────────────────────────────────

    fn sync_locked(&self, st: &mut State, now_ms: i64) -> Result<(), String> {
        let Some(d) = st.device.as_mut() else { return Err(STOP_NO_CERTIFICATE.to_string()) };
        let (relay, trust) = (&*self.relay, &self.shared.trust);
        d.fetch_wraps(relay, trust, now_ms);
        for cid in d.log_cids() {
            if let Err(code) = d.refresh_log(relay, trust, &cid, now_ms) {
                log_info(&format!("connector_log_waiting cid={cid} code={code}"));
            }
        }
        self.after_changes(st, now_ms)?;
        let (members, dms) = match st.device.as_ref() {
            Some(d) => (d.member_cids(), d.dms()),
            None => return Ok(()),
        };
        for cid in members {
            self.backfill_channel(st, &cid, now_ms)?;
        }
        for (cid, other) in dms {
            self.backfill_dm(st, &cid, &other, now_ms)?;
        }
        self.retry_pending(st, now_ms)?;
        self.after_changes(st, now_ms)?;
        if let Some(d) = st.device.as_mut() {
            d.last_sync = now_ms;
            self.save(d)?;
        }
        Ok(())
    }

    /// One long poll of `GET /v1/apps/c/events`, every event applied, then acknowledged. Ok is how many came.
    pub fn poll(&self, wait_s: u64) -> Result<usize, String> {
        let after = self.st.lock().device.as_ref().map_or(0, |d| d.events_cursor);
        let got = get_json(&*self.relay, "/v1/apps/c/events", &[("after", after.to_string()), ("wait", wait_s.to_string())]).map_err(|e| e.to_string())?;
        let events: Vec<Value> = got.get("events").and_then(Value::as_array).into_iter().flatten().filter(|e| e.is_object()).cloned().collect();
        self.deliver(&events, now_ms())?;
        Ok(events.len())
    }

    /// Apply `events` in order and acknowledge (`POST /v1/apps/c/ack`) up to the last one durably applied: the
    /// device state is sealed and every store change written before the ack goes out.
    ///
    /// When the batch stopped early (`EVENTS_HELD`, or a store write such as a removal's stop mark failed), the
    /// events before the stop are acknowledged and the error is returned, so the caller backs off and the relay
    /// delivers the rest again: nothing at or after the stop is acknowledged or passed by the cursor.
    pub fn deliver(&self, events: &[Value], now_ms: i64) -> Result<Option<i64>, String> {
        let (acked, stopped) = self.apply_events(events, now_ms)?;
        if let Some(seq) = acked {
            post_json(&*self.relay, "/v1/apps/c/ack", &json!({"seq": seq})).map_err(|e| e.to_string())?;
            let mut st = self.st.lock();
            if let Some(d) = st.device.as_mut() {
                d.last_sync = now_ms;
            }
        }
        match stopped {
            Some(e) => Err(e),
            None => Ok(acked),
        }
    }

    /// Apply events in order; Ok is the last `seq` durably applied (None when none) and, when the batch stopped
    /// early, why. An event that could not be applied durably (a store write failed, or verification is unavailable
    /// now) stops the batch before the cursor passes it: it and the ones after it come again.
    pub fn apply_events(&self, events: &[Value], now_ms: i64) -> Result<(Option<i64>, Option<String>), String> {
        let mut st = self.st.lock();
        if st.device.is_none() {
            return Err(STOP_NO_CERTIFICATE.to_string());
        }
        let mut acked: Option<i64> = None;
        let mut stopped: Option<String> = None;
        for ev in events {
            let mut applied = self.apply_event(&mut st, ev, now_ms);
            if applied.is_ok() {
                applied = self.after_changes(&mut st, now_ms);
            }
            if let Err(e) = applied {
                if e == EVENTS_HELD {
                    log_info(&format!("connector_events_held app={} stop={}", self.app, st.stop.unwrap_or("serving")));
                } else {
                    log_warn(&format!("connector_event_not_applied app={} error={e}", self.app));
                }
                stopped = Some(e);
                break;
            }
            if let Some(seq) = ev.get("seq").and_then(ce::int_of) {
                acked = Some(acked.map_or(seq, |a| a.max(seq)));
            }
        }
        if let Some(d) = st.device.as_mut() {
            if let Some(seq) = acked {
                d.events_cursor = d.events_cursor.max(seq);
            }
            self.save(d)?;
        }
        Ok((acked, stopped))
    }

    fn apply_event(&self, st: &mut State, ev: &Value, now_ms: i64) -> Result<(), String> {
        let (relay, trust) = (&*self.relay, &self.shared.trust);
        let me = match st.device.as_ref() {
            Some(d) => d.id.principal.clone(),
            None => return Ok(()),
        };
        match text_at(ev, "type") {
            "org_policy" | "org_ai" => {
                self.refresh_policy_locked(st, now_ms);
                self.health_locked(st, now_ms);
            }
            "chat_keys" => {
                let opened = st.device.as_mut().is_some_and(|d| d.fetch_wraps(relay, trust, now_ms));
                if opened {
                    self.retry_pending(st, now_ms)?;
                }
            }
            "chat_devices" => {
                if let Some(d) = st.device.as_mut() {
                    d.forget_devices(text_at(ev, "principal"));
                }
            }
            "chat_log" => {
                let Ok(cid) = ce::channel_cid(text_at(ev, "channel")) else { return Ok(()) };
                if let Some(d) = st.device.as_mut() {
                    if let Err(code) = d.refresh_log(relay, trust, &cid, now_ms) {
                        log_info(&format!("connector_log_waiting cid={cid} code={code}"));
                    }
                }
                self.after_changes(st, now_ms)?;
                self.retry_pending(st, now_ms)?;
            }
            "dm" => {
                let author = text_at(ev, "from").trim().to_lowercase();
                if author.is_empty() || author == me {
                    return Ok(());
                }
                let Some(cid) = st.device.as_mut().and_then(|d| d.note_pair(&me, &author).ok()) else { return Ok(()) };
                self.handle_row(st, &cid, ev, &author, true, now_ms)?;
            }
            "channel_message" => {
                let Some(row) = ev.get("message").filter(|m| m.is_object()) else { return Ok(()) };
                let Ok(cid) = ce::channel_cid(text_at(row, "channel")) else { return Ok(()) };
                self.handle_row(st, &cid, row, text_at(row, "from"), true, now_ms)?;
            }
            "chat_event" => {
                let Some(inner) = ev.get("event").filter(|e| e.is_object()) else { return Ok(()) };
                let from = text_at(inner, "from").trim().to_lowercase();
                let cid = match text_at(ev, "scope") {
                    "dm" => {
                        if from.is_empty() || from == me {
                            return Ok(());
                        }
                        match st.device.as_mut().and_then(|d| d.note_pair(&me, &from).ok()) {
                            Some(c) => c,
                            None => return Ok(()),
                        }
                    }
                    "channel" => match ce::channel_cid(text_at(ev, "channel")) {
                        Ok(c) => c,
                        Err(_) => return Ok(()),
                    },
                    _ => return Ok(()),
                };
                let row = json!({"id": inner.get("id"), "enc": inner.get("enc"), "rts": inner.get("rts")});
                self.handle_row(st, &cid, &row, &from, true, now_ms)?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Membership changes of the app by the verified replay: an `add` resumes the conversation (a removed one's old
    /// store is purged first) and reads its history; a `remove` or `leave` stops it at once and schedules its purge
    /// within 1 hour (O5).
    ///
    /// Err when a store mark could not be written: that change and the ones after it go back to the device's queue
    /// (sealed with the device state, so a restart retries them) and the caller stops before acknowledging, so a
    /// removal is never acknowledged without its durable stop mark.
    fn after_changes(&self, st: &mut State, now_ms: i64) -> Result<(), String> {
        loop {
            let changes = match st.device.as_mut() {
                Some(d) => d.drain_changes(),
                None => return Ok(()),
            };
            if changes.is_empty() {
                return Ok(());
            }
            let mut rest = changes.into_iter();
            while let Some((cid, member)) = rest.next() {
                let store = &self.shared.store;
                if member {
                    match store.resume(&self.app, &cid, now_ms) {
                        Ok(Some(p)) => {
                            log_info(&format!("connector.store.purged app={} cid={cid} reason={} records={}", p.app, p.reason, p.records));
                            let principal = st.device.as_ref().map(|d| d.id.principal.clone()).unwrap_or_default();
                            self.shared.hooks.purged(&principal, &p, now_ms);
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log_error(&format!("connector_store_resume_failed app={} cid={cid} error={e}", self.app));
                            if let Some(d) = st.device.as_mut() {
                                d.requeue_changes(std::iter::once((cid.clone(), member)).chain(rest).collect());
                            }
                            return Err(format!("the store could not resume {cid} ({e})"));
                        }
                    }
                    log_info(&format!("connector_conversation_added app={} cid={cid}", self.app));
                    self.shared.hooks.event(&self.app, &ContentEvent { kind: ContentKind::ConversationAdded, conv: cid.clone(), mid: None });
                    if let Err(e) = self.backfill_channel(st, &cid, now_ms) {
                        log_warn(&format!("connector_history_not_read app={} cid={cid} error={e}", self.app));
                    }
                } else {
                    if let Err(e) = store.stop(&self.app, &cid, StopReason::Removed, now_ms) {
                        log_error(&format!("connector_store_stop_failed app={} cid={cid} error={e}", self.app));
                        if let Some(d) = st.device.as_mut() {
                            d.requeue_changes(std::iter::once((cid.clone(), member)).chain(rest).collect());
                        }
                        return Err(format!("the store could not mark {cid} removed ({e})"));
                    }
                    // r5 2.7: removal drops every key held for the conversation; a re-add starts from the new
                    // epoch's wraps (its history backfill reads only the new membership, `backfill_channel`)
                    if let Some(d) = st.device.as_mut() {
                        d.sender.forget(&cid);
                        d.keys.forget(&cid);
                    }
                    log_info(&format!("connector_conversation_removed app={} cid={cid}", self.app));
                    self.shared.hooks.event(&self.app, &ContentEvent { kind: ContentKind::ConversationRemoved, conv: cid.clone(), mid: None });
                }
            }
        }
    }

    fn take_history_row(&self, st: &mut State, cid: &str, row: &Value, now_ms: i64) -> Result<(), String> {
        let author = text_at(row, "from").to_string();
        if row.get("enc").is_some_and(Value::is_object) {
            self.handle_row(st, cid, row, &author, false, now_ms)?;
        }
        for ev in row.get("events").and_then(Value::as_array).into_iter().flatten() {
            let evrow = json!({"id": ev.get("id"), "enc": ev.get("enc"), "rts": ev.get("rts")});
            if evrow.get("enc").is_some_and(Value::is_object) {
                self.handle_row(st, cid, &evrow, text_at(ev, "from"), false, now_ms)?;
            }
        }
        Ok(())
    }

    /// The channel's history since the app's current membership began (or the last row taken):
    /// `GET /v1/channels/history` (the newest 500 rows after that point; thread replies by their root).
    fn backfill_channel(&self, st: &mut State, cid: &str, now_ms: i64) -> Result<(), String> {
        let Some(d) = st.device.as_ref() else { return Ok(()) };
        let since_ms = d.log(cid).and_then(|l| l.member_intervals(&d.id.principal).last().map(|i| i.0)).unwrap_or(now_ms);
        let floor = (since_ms - ce::SKEW_MS).max(0) as f64 / 1000.0;
        let after = d.synced.get(cid).copied().unwrap_or(floor).max(floor);
        let channel = cid[3..].to_string();
        let got = match get_json(&*self.relay, "/v1/channels/history", &[("id", channel.clone()), ("after", format!("{after}")), ("limit", HISTORY_LIMIT.to_string())]) {
            Ok(v) => v,
            Err(e) => {
                log_info(&format!("connector_history_not_fetched cid={cid} status={}", e.status));
                return Ok(());
            }
        };
        if let Some(name) = got.get("channel").and_then(|c| c.get("name")).and_then(Value::as_str) {
            if let Some(d) = st.device.as_mut() {
                d.names.insert(cid.to_string(), name.to_string());
            }
        }
        let rows: Vec<Value> = got.get("messages").and_then(Value::as_array).into_iter().flatten().filter(|r| r.is_object()).cloned().collect();
        if rows.len() >= HISTORY_LIMIT {
            log_warn(&format!("connector_history_window app={} cid={cid} (older rows after the last sync are not served)", self.app));
        }
        let mut newest = after;
        for row in &rows {
            self.take_history_row(st, cid, row, now_ms)?;
            newest = newest.max(row.get("ts").and_then(Value::as_f64).unwrap_or(0.0));
            if row.get("replies").and_then(Value::as_i64).unwrap_or(0) > 0 {
                let q = [("id", channel.clone()), ("after", format!("{after}")), ("thread", text_at(row, "id").to_string()), ("limit", HISTORY_LIMIT.to_string())];
                if let Ok(t) = get_json(&*self.relay, "/v1/channels/history", &q) {
                    for reply in t.get("messages").and_then(Value::as_array).into_iter().flatten().skip(1) {
                        self.take_history_row(st, cid, reply, now_ms)?;
                        newest = newest.max(reply.get("ts").and_then(Value::as_f64).unwrap_or(0.0));
                    }
                }
            }
        }
        if let Some(d) = st.device.as_mut() {
            d.synced.insert(cid.to_string(), newest);
        }
        Ok(())
    }

    /// The app's DM with a person since the last row taken, at most the last hour (approval answers and Stops).
    fn backfill_dm(&self, st: &mut State, cid: &str, other: &str, now_ms: i64) -> Result<(), String> {
        let Some(d) = st.device.as_ref() else { return Ok(()) };
        let floor = (now_ms - DM_BACKFILL_MS) as f64 / 1000.0;
        let after = d.synced.get(cid).copied().unwrap_or(floor).max(floor);
        let got = match get_json(&*self.relay, "/v1/dm/history", &[("with", other.to_string()), ("after", format!("{after}")), ("limit", HISTORY_LIMIT.to_string())]) {
            Ok(v) => v,
            Err(e) => {
                log_info(&format!("connector_dm_history_not_fetched status={}", e.status));
                return Ok(());
            }
        };
        let mut newest = after;
        for row in got.get("messages").and_then(Value::as_array).into_iter().flatten().filter(|r| r.is_object()) {
            self.take_history_row(st, cid, row, now_ms)?;
            newest = newest.max(row.get("ts").and_then(Value::as_f64).unwrap_or(0.0));
        }
        if let Some(d) = st.device.as_mut() {
            d.synced.insert(cid.to_string(), newest);
        }
        Ok(())
    }

    /// Rows that waited for a key or a member log, tried again.
    fn retry_pending(&self, st: &mut State, now_ms: i64) -> Result<(), String> {
        let waiting = match st.device.as_mut() {
            Some(d) => d.take_pending(),
            None => return Ok(()),
        };
        let mut rest = waiting.into_iter();
        while let Some(p) = rest.next() {
            if let Err(e) = self.handle_row(st, &p.cid, &p.row, &p.author, false, now_ms) {
                if let Some(d) = st.device.as_mut() {
                    d.push_pending(&p.cid, &p.row, &p.author);
                    for q in rest {
                        d.push_pending(&q.cid, &q.row, &q.author);
                    }
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// One relay row: opened and verified by the device, then authorized and applied. Err only when it could not be
    /// applied durably.
    fn handle_row(&self, st: &mut State, cid: &str, row: &Value, author: &str, live: bool, now_ms: i64) -> Result<(), String> {
        let (relay, trust) = (&*self.relay, &self.shared.trust);
        let Ok(kind) = ce::cid_kind(cid) else { return Ok(()) };
        let temporary = matches!(st.stop, Some(STOP_STARTING | STOP_UNVERIFIED | STOP_CRL));
        let Some(d) = st.device.as_mut() else { return Ok(()) };
        let me = d.id.principal.clone();
        if temporary && matches!(kind, "ch" | "dm") {
            // cannot verify now: the batch stops here unacknowledged (never parked in the bounded pending queue, so
            // a delete cannot be evicted or acknowledged before it erases); the relay delivers it again
            return Err(EVENTS_HELD.to_string());
        }
        match kind {
            "ch" => {
                if d.log(cid).is_none() {
                    let code = match d.refresh_log(relay, trust, cid, now_ms) {
                        Err(code) => code,
                        // not fetched (the relay away) or refused: no verified log yet, so the row is kept
                        Ok(()) if d.log(cid).is_none() => "log_unavailable".to_string(),
                        Ok(()) => String::new(),
                    };
                    if !code.is_empty() {
                        d.push_pending(cid, row, author);
                        log_info(&format!("connector_row_waiting cid={cid} code={code}"));
                        return Ok(());
                    }
                }
                if !d.members(cid, None).contains(&me) {
                    return Ok(());
                }
            }
            "dm" => {
                let other = d.dm_other(cid);
                if other.is_empty() || ce::principal_kind(&other).ok() != Some("person") {
                    return Ok(());
                }
            }
            _ => return Ok(()),
        }
        match d.open(relay, trust, cid, row, author, live, now_ms) {
            Opened::Waiting(code) => {
                d.push_pending(cid, row, author);
                log_info(&format!("connector_row_waiting cid={cid} code={code}"));
                Ok(())
            }
            Opened::Refused(e) => {
                st.withheld += 1;
                log_info(&format!("connector_row_refused app={} code={}", self.app, e.code));
                Ok(())
            }
            Opened::Message(msg) => self.apply_message(st, msg, now_ms),
        }
    }

    /// A verified message, authorized (CE-1 6 table, revision 11 with the pinned `api` apps), then applied: group chat
    /// and channel content to the store and `event`; the person's `apra` and `stop` in the app's DM to the hooks.
    fn apply_message(&self, st: &mut State, msg: OpenedMessage, now_ms: i64) -> Result<(), String> {
        let store = &self.shared.store;
        let cid = msg.cid.clone();
        let Some(d) = st.device.as_ref() else { return Ok(()) };
        let members: Vec<String> = d.members(&cid, Some(&msg.head)).into_iter().collect();
        let admins: Vec<String> = d.log(&cid).map(|l| l.admins.iter().cloned().collect()).unwrap_or_default();
        let other = d.dm_other(&cid);
        let dm = ce::cid_kind(&cid).ok() == Some("dm");
        let api_apps = self.shared.trust.api_apps(now_ms);
        let target = if !dm && matches!(msg.kind.as_str(), "edit" | "delete" | "react") { Some(store.get(&self.app, &cid, &msg.ref_)) } else { None };
        if msg.kind == "delete" && matches!(target, Some(Err(StoreError::Stopped(_)))) {
            // serving stopped: the author cannot be read back, and a verified delete only ever erases
            store.delete(&self.app, &cid, &msg.ref_).map_err(|e| e.to_string())?;
            return Ok(());
        }
        let held = match &target {
            Some(Ok(Some(m))) => Some(m.clone()),
            _ => None,
        };
        let ctx = AuthorizeContext { admins: &admins, target_author: held.as_ref().map(|m| m.from.as_str()), target_kind: held.as_ref().map(|m| m.kind.as_str()), api_apps: &api_apps, ..Default::default() };
        if let Err(e) = ce::authorize(&msg, &members, &ctx) {
            st.withheld += 1;
            log_info(&format!("connector_message_unauthorized app={} code={}", self.app, e.code));
            return Ok(());
        }
        let payload = &msg.payload;
        if dm {
            if msg.kind != "post" || msg.from_p != other {
                return Ok(());
            }
            if let Some(apra) = payload.get("apra") {
                self.shared.hooks.approval_answer(&self.app, &other, &msg.mid, apra);
            } else if let Some(stop) = payload.get("stop") {
                self.shared.hooks.person_stop(&self.app, &other, text_at(stop, "client"), &msg.mid);
            }
            return Ok(());
        }
        if st.stop.is_some() && msg.kind != "delete" {
            return Ok(());
        }
        let ev = |kind: ContentKind| ContentEvent { kind, conv: cid.clone(), mid: Some(if kind == ContentKind::MessageCreated { msg.mid.clone() } else { msg.ref_.clone() }) };
        let opt = |s: &str| if s.is_empty() { None } else { Some(s.to_string()) };
        let applied = match msg.kind.as_str() {
            "post" => {
                let log_kind = d.log(&cid).map(|l| l.kind.clone()).unwrap_or_default();
                let conv_kind = ce::retention_kind(&cid, &log_kind).map_err(|e| e.to_string())?;
                let m = StoredMessage {
                    mid: msg.mid.clone(),
                    from: msg.from_p.clone(),
                    device: msg.from_d.clone(),
                    ts: msg.s,
                    thread: opt(&msg.t),
                    reply: opt(&msg.q),
                    kind: msg.kind.clone(),
                    text: text_at(payload, "t").to_string(),
                    edited: None,
                    files: payload.get("f").and_then(Value::as_array).cloned().unwrap_or_default(),
                    reactions: Vec::new(),
                    mentions: payload.get("m").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
                    dlg: payload.get("dlg").filter(|v| v.is_object()).cloned(),
                };
                store.put(&self.app, &cid, conv_kind, &m).map(|new| new.then(|| ev(ContentKind::MessageCreated)))
            }
            "edit" => store.edit(&self.app, &cid, &msg.ref_, text_at(payload, "t"), msg.s).map(|changed| changed.then(|| ev(ContentKind::MessageEdited))),
            "delete" => store.delete(&self.app, &cid, &msg.ref_).map(|gone| gone.then(|| ev(ContentKind::MessageDeleted))),
            "react" => {
                let on = payload.get("on").and_then(Value::as_bool).unwrap_or(false);
                store.react(&self.app, &cid, &msg.ref_, text_at(payload, "emoji"), &msg.from_p, on, msg.s).map(|_| None)
            }
            _ => Ok(None),
        };
        match applied {
            Ok(Some(e)) => self.shared.hooks.event(&self.app, &e),
            Ok(None) | Err(StoreError::Stopped(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(())
    }

    // ── what slice 1c4 reads ────────────────────────────────────────────────────────────────────────────────

    /// The app's own serving state: Ok, or why it stopped (`STOP_*`).
    pub fn serving(&self) -> Result<(), &'static str> {
        self.st.lock().stop.map_or(Ok(()), Err)
    }

    /// A group chat or channel the app serves now: the app serves and, by the verified replay, is a current member
    /// (5.2 steps 3 to 5; the store's own marks are checked again on every read).
    pub fn conversation_serving(&self, cid: &str) -> Result<(), &'static str> {
        let st = self.st.lock();
        if let Some(why) = st.stop {
            return Err(why);
        }
        let member = st.device.as_ref().is_some_and(|d| ce::cid_kind(cid).ok() == Some("ch") && d.log(cid).is_some_and(|l| l.members.contains(&d.id.principal)));
        if member {
            Ok(())
        } else {
            Err(STOP_NOT_MEMBER)
        }
    }

    /// The group chats and channels the app is a verified member of while it serves (2.8 ack `conversations`).
    pub fn conversations(&self) -> Vec<ConversationInfo> {
        let st = self.st.lock();
        let Some(d) = st.device.as_ref().filter(|_| st.stop.is_none()) else { return Vec::new() };
        d.member_cids()
            .into_iter()
            .filter_map(|cid| {
                let l = d.log(&cid)?;
                let since = l.member_intervals(&d.id.principal).last().map(|i| i.0).unwrap_or(0);
                let kind = if l.kind == "group" { "group" } else { "channel" };
                Some(ConversationInfo { name: d.names.get(&cid).cloned().unwrap_or_default(), app: self.app.clone(), kind, since, cid })
            })
            .collect()
    }

    /// R5-19 and 5.2 step 9: `principal` is a current member of `cid` by the app's verified replay (never the relay's
    /// member list).
    pub fn is_member(&self, cid: &str, principal: &str) -> bool {
        self.st.lock().device.as_ref().and_then(|d| d.log(cid).map(|l| l.members.contains(principal))).unwrap_or(false)
    }

    /// 5.2: the intervals (ms, `to` 0 while still a member) `principal` was a member of `cid`, by the replay
    /// (`ce_device_log::in_intervals` checks a message time against them).
    pub fn member_intervals(&self, cid: &str, principal: &str) -> Vec<(i64, i64)> {
        self.st.lock().device.as_ref().and_then(|d| d.log(cid).map(|l| l.member_intervals(principal))).unwrap_or_default()
    }

    /// r5 7.2 conversation `members`: how many current members `cid` has by the verified replay (0 without its log).
    pub fn member_count(&self, cid: &str) -> usize {
        self.st.lock().device.as_ref().and_then(|d| d.log(cid).map(|l| l.members.len())).unwrap_or(0)
    }

    /// Messages refused since start (5.2 `withheld`).
    pub fn withheld(&self) -> u64 {
        self.st.lock().withheld
    }

    /// The app's principal and device ("" before its certificate loads).
    pub fn principal(&self) -> (String, String) {
        self.st.lock().device.as_ref().map(|d| (d.id.principal.clone(), d.id.device.clone())).unwrap_or_default()
    }

    /// `connector apps` and health: state, conversations, last sync, certificate end.
    pub fn status(&self) -> Value {
        let n = self.conversations().len();
        let st = self.st.lock();
        let d = st.device.as_ref();
        json!({
            "app": self.app, "principal": d.map(|d| d.id.principal.clone()), "device": d.map(|d| d.id.device.clone()),
            "serving": st.stop.unwrap_or("serving"), "certificate_end": st.not_after_ms, "conversations": n,
            "last_sync": d.map(|d| d.last_sync).filter(|t| *t > 0), "pending": d.map_or(0, |d| d.pending.len()), "withheld": st.withheld,
        })
    }

    /// A file of a stored message, decrypted and checked here (`GET /v1/files/get`, `decrypt_bytes`), cached 24 hours.
    pub fn file(&self, cid: &str, mid: &str, fid: &str, now_ms: i64) -> Result<Vec<u8>, String> {
        self.conversation_serving(cid).map_err(str::to_string)?;
        let store = &self.shared.store;
        if let Some(b) = store.cached_file(&self.app, cid, fid, now_ms).map_err(|e| e.to_string())? {
            return Ok(b);
        }
        let msg = store.get(&self.app, cid, mid).map_err(|e| e.to_string())?.ok_or(NOT_KEPT)?;
        let desc = msg.files.iter().find(|f| f.get("fid").and_then(Value::as_str) == Some(fid)).ok_or(NO_SUCH_FILE)?;
        let id = desc.get("id").and_then(Value::as_str).ok_or(NO_SUCH_FILE)?;
        let data = get_bytes(&*self.relay, "/v1/files/get", &[("id", id.to_string())]).map_err(|e| e.to_string())?;
        let plain = crate::ce_device_files::decrypt_bytes(&data, desc).map_err(|e| e.to_string())?;
        store.cache_file(&self.app, cid, fid, &plain, now_ms).map_err(|e| e.to_string())?;
        Ok(plain)
    }

    // ── sending as the app (for 1c4) ────────────────────────────────────────────────────────────────────────

    /// Send `kind` (`post`, `edit`, `delete`, `react`, ...) in a group chat, channel or the app's DM with a person:
    /// the epoch planned and wrapped to the current verified members (`SenderKeys`), sealed, and posted through
    /// `/v1/channels/post`, `/v1/dm` or `/v1/chat/{edit,delete,event}`. Channel content the app sends is applied to
    /// its own store as received content is. Ok is `{"id": mid, "row": the relay's answer}`.
    pub fn send(&self, cid: &str, kind: &str, ref_: &str, payload: Value, t: &str, now_ms: i64) -> Result<Value, String> {
        self.send_as(cid, kind, ref_, payload, t, None, now_ms)
    }

    /// `send` under `mid` when given (chosen and sealed by the caller before, so a retry is the same message; Err
    /// `connector_device::ID_KEPT` when the relay already keeps it).
    #[allow(clippy::too_many_arguments)]
    fn send_as(&self, cid: &str, kind: &str, ref_: &str, payload: Value, t: &str, mid: Option<&str>, now_ms: i64) -> Result<Value, String> {
        self.serving().map_err(str::to_string)?;
        let dm = ce::cid_kind(cid).ok() == Some("dm");
        if !dm {
            self.conversation_serving(cid).map_err(str::to_string)?;
        }
        let mut st = self.st.lock();
        let (sealed, name) = (self.shared.sealed.clone(), names::chat_keys(&self.app));
        let mut save = |d: &MemberDevice| sealed.put(&name, &d.to_value());
        let Some(d) = st.device.as_mut() else { return Err(STOP_NO_CERTIFICATE.to_string()) };
        let (mid, row, m) = d.send(&*self.relay, &self.shared.trust, cid, kind, ref_, payload, t, mid, now_ms, &mut save)?;
        self.save(d)?;
        if !dm {
            self.apply_message(&mut st, m, now_ms)?;
        }
        Ok(json!({"id": mid, "row": row}))
    }

    /// The app's DM with a person (7.5 step 1): its cid, once the person has a verified device. The relay opens the
    /// DM with the first `POST /v1/dm`.
    pub fn open_dm(&self, person: &str, now_ms: i64) -> Result<String, String> {
        let person = person.trim().to_lowercase();
        if ce::principal_kind(&person).ok() != Some("person") {
            return Err(NOT_PERSON.to_string());
        }
        let mut st = self.st.lock();
        let Some(d) = st.device.as_mut() else { return Err(STOP_NO_CERTIFICATE.to_string()) };
        let me = d.id.principal.clone();
        let cid = d.note_pair(&me, &person).map_err(|e| e.to_string())?;
        d.bundles(&*self.relay, std::slice::from_ref(&person), false, now_ms);
        if d.devices_of(std::slice::from_ref(&person), now_ms).is_empty() {
            return Err(format!("{person} has no verified device yet"));
        }
        self.save(d)?;
        Ok(cid)
    }

    /// Revision 11 `apr` in the app's DM with `person` (`t` "", `m` []).
    pub fn send_apr(&self, person: &str, apr: &Value, now_ms: i64) -> Result<Value, String> {
        ce::check_apr(apr).map_err(|e| e.to_string())?;
        let cid = self.open_dm(person, now_ms)?;
        self.send(&cid, "post", "", json!({"t": "", "m": [], "apr": apr}), "", now_ms)
    }

    /// Revision 11 delegated or program post: `text` with `dlg` in a group chat or channel, in `thread` ("" for none).
    pub fn post_dlg(&self, cid: &str, text: &str, thread: &str, dlg: &Value, now_ms: i64) -> Result<Value, String> {
        self.send(cid, "post", "", json!({"t": text, "m": [], "dlg": dlg}), thread, now_ms)
    }

    /// True when this app holds its DM with `person` (noted from a verified row of the person's or from the app's own
    /// send to them). A delegation notice goes only into a DM that exists (r5 2.9, `connector_notice`).
    pub fn has_dm(&self, person: &str) -> bool {
        let person = person.trim().to_lowercase();
        let st = self.st.lock();
        st.device.as_ref().is_some_and(|d| ce::dm_cid(&d.id.principal, &person).is_ok_and(|cid| !d.pair(&cid).is_empty()))
    }

    /// Revision 11 delegation notice in the app's DM with `person` under `mid`, the id `connector_notice` sealed in its
    /// outbox first (r5 6.3): a retry is the same message, and Err `connector_device::ID_KEPT` means the relay keeps it.
    pub fn send_dlgn(&self, person: &str, dlgn: &Value, mid: &str, now_ms: i64) -> Result<Value, String> {
        let cid = self.open_dm(person, now_ms)?;
        self.send_as(&cid, "post", "", json!({"t": "", "m": [], "dlgn": dlgn}), "", Some(mid), now_ms)
    }

    #[cfg(test)]
    fn force_revoked(&self) {
        if let Some(d) = self.st.lock().device.as_mut() {
            d.revoked = true;
        }
    }
}

/// What `connector apps` reads offline from an app's sealed device state: the conversations its verified logs make
/// it a member of, and the last sync (ms).
pub fn stored_status(sealed: &SealedStore, app: &str, principal: &str) -> Result<(usize, Option<i64>), String> {
    let Some(v) = sealed.get(&names::chat_keys(app))? else { return Ok((0, None)) };
    let st = v.get("state").cloned().unwrap_or(Value::Null);
    let members = st
        .get("logs")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(cid, l)| cl::LogState::from_value(cid, l).is_ok_and(|l| l.members.contains(principal)))
        .count();
    Ok((members, st.get("last_sync").and_then(Value::as_i64).filter(|t| *t > 0)))
}

// ── the production loop ─────────────────────────────────────────────────────────────────────────────────────

/// The app's device identity from its enrollment (the sealed P-256 key, PKCS#8).
pub fn device_id_of(ident: &AppIdentity) -> Result<DeviceId, String> {
    let (_, key) = ident.client_auth();
    let mut der = match key {
        PrivateKeyDer::Pkcs8(k) => k.secret_pkcs8_der().to_vec(),
        _ => return Err("the app key is not PKCS#8".to_string()),
    };
    let dk = DeviceKey::from_der(&der).map_err(|e| e.to_string());
    wipe(&mut der);
    DeviceId::new(dk?, &ident.cert_pem(), &ident.chain_pem())
}

/// One app's thread: identity, session, renewal at 30 days left (`POST /v1/apps/c/renew`, `connector_enroll`), the
/// events long poll, with backoff while the relay is away. Returns only when the enclave check stops the app.
pub struct Runner {
    pub session: Arc<AppSession>,
    pub link: Arc<RelayLink>,
    pub enroll: Arc<Enroll>,
    pub client_ca_pem: String,
    pub relay_ca_pem: String,
}

impl Runner {
    fn load_identity(&self) -> Result<AppIdentity, String> {
        let ident = self.enroll.load(&self.session.app)?;
        self.link.set_client(ident.client_config(&self.relay_ca_pem)?);
        self.session.attach(device_id_of(&ident)?, ident.not_after_ms)?;
        Ok(ident)
    }

    fn renew(&self, now_ms: i64) -> Result<AppIdentity, String> {
        let app = &self.session.app;
        let body = self.enroll.renew_request(app, now_ms)?;
        let answer = post_json(&*self.link, RENEW_ROUTE, &body).map_err(|e| e.to_string())?;
        let next = self.enroll.renew_install(app, &answer, &self.client_ca_pem, now_ms)?;
        self.link.set_client(next.client_config(&self.relay_ca_pem)?);
        self.session.attach(device_id_of(&next)?, next.not_after_ms)?;
        self.session.disconnect();
        log_info(&format!("connector_app_renewed app={app} until_ms={}", next.not_after_ms));
        Ok(next)
    }

    pub fn run(self) {
        let app = self.session.app.clone();
        let mut ident: Option<AppIdentity> = None;
        let (mut backoff, mut renew_at) = (1u64, 0i64);
        let pause = |s: u64| std::thread::sleep(Duration::from_secs(s));
        loop {
            let now = now_ms();
            if ident.is_none() {
                match self.load_identity() {
                    Ok(i) => ident = Some(i),
                    Err(e) => {
                        log_error(&format!("connector_app_not_loaded app={app} error={e}"));
                        self.session.set_stop(STOP_NO_CERTIFICATE);
                        pause(300);
                        continue;
                    }
                }
            }
            if !self.session.connected() {
                if let Err(e) = self.session.connect(now) {
                    if self.session.enclave_stopped() {
                        return;
                    }
                    log_warn(&format!("connector_app_session app={app} error={e}"));
                    pause(backoff);
                    backoff = (backoff * 2).min(60);
                    continue;
                }
            }
            if now >= renew_at {
                renew_at = now + RENEW_CHECK_MS;
                if ident.as_ref().is_some_and(|i| i.renew_due(now) && !i.expired(now)) {
                    match self.renew(now) {
                        Ok(next) => ident = Some(next),
                        Err(e) => log_warn(&format!("connector_app_renewal_failed app={app} error={e}")),
                    }
                }
            }
            self.session.tick(now);
            match self.session.poll(EVENTS_WAIT_S) {
                Ok(_) => backoff = 1,
                Err(e) => {
                    log_warn(&format!("connector_app_events app={app} error={e}"));
                    self.session.disconnect();
                    pause(backoff);
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    }
}

/// The recorded relay and the CE-1 vector world of these tests, also used by the connector's REST, approval and
/// end-to-end tests (slice 1c4).
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ce_device::{DckKey, Head, VerifiedBundle, ZERO_HASH};
    use crate::connector_seal::{FixedSource, Sealer};
    use crate::connector_store::STORE_MAX_DEFAULT;

    const VECTORS: &str = include_str!("../tests/chat_e2ee_v1.json");
    pub(crate) const APP: &str = "helpdesk";

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    /// The recorded relay: bundles, member logs and wraps it serves, and what the app posts and acknowledges.
    #[derive(Default)]
    pub(crate) struct Fake {
        pub(crate) devices: Mutex<Vec<Value>>,
        pub(crate) logs: Mutex<BTreeMap<String, Vec<Value>>>,
        pub(crate) wraps: Mutex<Vec<Value>>,
        pub(crate) posted_bundles: Mutex<Vec<Value>>,
        /// (seq, whether the watched record was already gone from the store when the ack came)
        pub(crate) acks: Mutex<Vec<(i64, bool)>>,
        pub(crate) watch: Mutex<Option<(Arc<ContentStore>, String, String)>>,
        /// What the app sent: (route, body) of `POST /v1/chat/keys`, `/v1/channels/post` and `/v1/dm`.
        pub(crate) sent: Mutex<Vec<(String, Value)>>,
        /// `POST /v1/dm` answers 503 while set (a relay that is away).
        pub(crate) refuse_dm: std::sync::atomic::AtomicBool,
        /// `POST /v1/dm` keeps the message but its answer is lost (503) while set.
        pub(crate) lose_dm_answer: std::sync::atomic::AtomicBool,
        /// Every `POST /v1/dm` that reached the relay, kept or not.
        pub(crate) dm_tries: std::sync::atomic::AtomicUsize,
    }

    impl AppRelay for Fake {
        fn hello(&self) -> Result<Value, RelayError> {
            Ok(json!({"session": "s1", "enclave": false}))
        }

        fn call(&self, method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Vec<u8>, RelayError> {
            let q = |k: &str| query.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap_or_default();
            let after = q("after").parse::<i64>().unwrap_or(0);
            let seq = |v: &Value| v.get("seq").and_then(Value::as_i64).unwrap_or(0);
            let v = match (method, path) {
                ("GET", "/v1/chat/devices") => {
                    let wanted: Vec<String> = q("p").split(',').map(str::to_string).collect();
                    json!({"devices": self.devices.lock().iter().filter(|b| wanted.iter().any(|w| Some(w.as_str()) == b["principal"].as_str())).cloned().collect::<Vec<_>>()})
                }
                ("GET", "/v1/chat/log") => json!({"entries": self.logs.lock().get(&q("cid")).cloned().unwrap_or_default().into_iter().filter(|e| seq(e) > after).collect::<Vec<_>>()}),
                ("GET", "/v1/chat/keys") => json!({"wraps": self.wraps.lock().iter().filter(|w| seq(w) > after).cloned().collect::<Vec<_>>()}),
                ("GET", "/v1/channels/history") => json!({"channel": {"name": "ops"}, "messages": []}),
                ("POST", "/v1/chat/devices") => {
                    self.posted_bundles.lock().push(body.and_then(|b| b.get("bundle")).cloned().unwrap_or(Value::Null));
                    json!({"ok": true})
                }
                ("POST", route @ ("/v1/chat/keys" | "/v1/channels/post" | "/v1/dm")) => {
                    use std::sync::atomic::Ordering::SeqCst;
                    let b = body.cloned().unwrap_or(Value::Null);
                    if route == "/v1/dm" {
                        self.dm_tries.fetch_add(1, SeqCst);
                        if self.refuse_dm.load(SeqCst) {
                            return Err(RelayError::new(503, "the relay is away"));
                        }
                        // the relay keeps one message per id (CE-1 `ce_post`)
                        if self.sent.lock().iter().any(|(r, x)| r == route && x.get("id") == b.get("id")) {
                            return Err(RelayError::new(409, crate::connector_device::ID_KEPT));
                        }
                    }
                    self.sent.lock().push((route.to_string(), b.clone()));
                    if route == "/v1/dm" && self.lose_dm_answer.load(SeqCst) {
                        return Err(RelayError::new(503, "the answer was lost"));
                    }
                    json!({"ok": true, "id": b.get("id")})
                }
                ("GET", "/v1/dm/history") => json!({"messages": []}),
                ("POST", "/v1/apps/c/ack") => {
                    let gone = self.watch.lock().as_ref().map_or(false, |(store, cid, mid)| matches!(store.get(APP, cid, mid), Ok(None)));
                    self.acks.lock().push((body.and_then(|b| b.get("seq")).and_then(Value::as_i64).unwrap_or(0), gone));
                    json!({"ok": true})
                }
                _ => return Err(RelayError::new(404, "not in this test")),
            };
            Ok(v.to_string().into_bytes())
        }
    }

    /// The hook calls as lines, each then handed to `next` when a test set one (the connector's own hooks).
    #[derive(Default)]
    pub(crate) struct Rec(pub(crate) Mutex<Vec<String>>, pub(crate) RwLock<Option<Arc<dyn ContentHooks>>>);

    impl ContentHooks for Rec {
        fn approval_answer(&self, app: &str, person: &str, mid: &str, apra: &Value) {
            self.0.lock().push(format!("apra {person}"));
            if let Some(h) = self.1.read().clone() {
                h.approval_answer(app, person, mid, apra);
            }
        }
        fn person_stop(&self, app: &str, person: &str, client: &str, mid: &str) {
            self.0.lock().push(format!("stop {person} {client}"));
            if let Some(h) = self.1.read().clone() {
                h.person_stop(app, person, client, mid);
            }
        }
        fn event(&self, app: &str, ev: &ContentEvent) {
            self.0.lock().push(format!("{} {}", ev.kind.name(), ev.conv));
            if let Some(h) = self.1.read().clone() {
                h.event(app, ev);
            }
        }
        fn purged(&self, principal: &str, p: &Purged, now_ms: i64) {
            self.0.lock().push(format!("purged {} {}", p.app, p.reason));
            if let Some(h) = self.1.read().clone() {
                h.purged(principal, p, now_ms);
            }
        }
    }

    /// Ann (a person of acme.test) and the Helpdesk API app of the CE-1 vectors, a recorded relay and a session.
    pub(crate) struct World {
        pub(crate) now: i64,
        pub(crate) ann: DeviceKey,
        pub(crate) ann_p: String,
        pub(crate) ann_d: String,
        pub(crate) ann_serial: String,
        pub(crate) app_p: String,
        pub(crate) app_d: String,
        pub(crate) app_vb: VerifiedBundle,
        pub(crate) fake: Arc<Fake>,
        pub(crate) hooks: Arc<Rec>,
        pub(crate) store: Arc<ContentStore>,
        pub(crate) session: Arc<AppSession>,
        pub(crate) next_seq: Mutex<i64>,
        pub(crate) dir: PathBuf,
    }

    impl World {
        pub(crate) fn new() -> World {
            let v: Value = serde_json::from_str(VECTORS).unwrap();
            let now = v["now_ms"].as_i64().unwrap();
            let dev = |n: &str| v["devices"][n].clone();
            let (ann, app) = (dev("ann1"), dev("app1"));
            let ann_key = DeviceKey::from_pem(v["keys"]["ann1"]["pem"].as_str().unwrap()).unwrap();
            let ann_dck = DckKey::from_scalar(&unhex(v["keys"]["ann1.dck"]["d"].as_str().unwrap())).unwrap();
            let app_key = DeviceKey::from_pem(v["keys"]["app1"]["pem"].as_str().unwrap()).unwrap();
            let ca = v["ca"].as_str().unwrap().to_string();
            let dir = crate::meet_tls::testpki::dir("connector-session");
            let sealed = Arc::new(SealedStore::open(Sealer::from_source(&FixedSource([7; 32])).unwrap(), dir.join("sealed")).unwrap());
            let store = Arc::new(ContentStore::open(&dir, sealed.clone()).unwrap());
            let trust = OrgTrust::open("acme", &ca, None, false, now).unwrap();
            let now_s = now / 1000;
            trust.pin_for_test(json!({
                "v": 1, "org": "acme", "label": "Acme", "domains": ["acme.test"], "seq": 1, "issued": now_s - 100, "expires": now_s + 30 * 86_400,
                "apps": [{"name": "Helpdesk", "type": "api", "principal": app["principal"], "device": app["device"], "scope": "all", "host": "connector.acme.test"}],
            }));
            let hooks = Arc::new(Rec::default());
            let shared = Arc::new(Shared { ca_pem: ca, trust, store: store.clone(), sealed, hooks: hooks.clone(), enclave: false });
            let fake = Arc::new(Fake::default());
            let session = Arc::new(AppSession::new(APP, shared, fake.clone()));
            let id = DeviceId::new(app_key, app["cert"].as_str().unwrap(), "").unwrap();
            session.attach(id, now + 300 * 86_400_000).unwrap();
            assert_eq!(session.health(now), None, "the listed app serves");
            session.publish_bundle_locked(&mut session.st.lock(), now).unwrap();
            let app_vb = VerifiedBundle::from_value(&fake.posted_bundles.lock()[0]).unwrap();
            let ann_bundle = ce::make_bundle(&ann_key, ann["cert"].as_str().unwrap(), "", &ann_dck, now_s - 60, None).unwrap();
            fake.devices.lock().push(ann_bundle);
            World {
                now,
                ann: ann_key,
                ann_p: ann["principal"].as_str().unwrap().into(),
                ann_d: ann["device"].as_str().unwrap().into(),
                ann_serial: ann["serial"].as_str().unwrap().into(),
                app_p: app["principal"].as_str().unwrap().into(),
                app_d: app["device"].as_str().unwrap().into(),
                app_vb,
                fake,
                hooks,
                store,
                session,
                next_seq: Mutex::new(0),
                dir,
            }
        }

        pub(crate) fn seq(&self) -> i64 {
            let mut s = self.next_seq.lock();
            *s += 1;
            *s
        }

        /// A member-log entry Ann signs: `op` on `who` at `ts` after `prev`.
        #[allow(clippy::too_many_arguments)]
        pub(crate) fn entry(&self, cid: &str, seq: i64, op: &str, who: &str, ts: i64, prev: &[u8], kind: &str) -> Value {
            let admins: Vec<String> = if op == "create" { vec![self.ann_p.clone()] } else { Vec::new() };
            cl::make_entry(&self.ann, cid, seq, op, &self.ann_p, &self.ann_d, &[who.to_string()], ts, prev, kind, false, &admins, "").unwrap()
        }

        /// Ann makes a group chat and adds the app; Ann's epoch key wrapped to the app. Ok is the cid and the head.
        pub(crate) fn conversation(&self, channel: &str, key: &[u8; 32]) -> (String, Head) {
            let cid = format!("ch:{channel}");
            let e1 = self.entry(&cid, 1, "create", &self.ann_p, self.now - 5000, &ZERO_HASH, "group");
            let h1 = cl::entry_hash(&cid, &e1).unwrap();
            let e2 = self.entry(&cid, 2, "add", &self.app_p, self.now - 4000, &h1, "");
            let head = Head { seq: 2, hash: cl::entry_hash(&cid, &e2).unwrap() };
            self.fake.logs.lock().insert(cid.clone(), vec![e1, e2]);
            let mut pds = vec![(self.ann_p.clone(), self.ann_d.clone()), (self.app_p.clone(), self.app_d.clone())];
            ce::sort_pds(&mut pds);
            let members = ce::set_hash(&pds).unwrap();
            let mut wrap = ce::make_wrap(&self.ann, &cid, &self.ann_p, &self.ann_d, &self.ann_serial, 1, key, &self.app_vb, &members, head, self.now - 3000, None, None, None).unwrap();
            wrap["seq"] = json!(self.seq());
            self.fake.wraps.lock().push(wrap);
            (cid, head)
        }

        /// One envelope from Ann.
        #[allow(clippy::too_many_arguments)]
        pub(crate) fn envelope(&self, cid: &str, mid: &str, counter: i64, kind: &str, ref_: &str, payload: Value, head: Head, key: &[u8; 32]) -> Value {
            self.envelope_in((1, 0, 0), cid, mid, counter, self.now - 2000 + counter, kind, ref_, payload, head, key)
        }

        /// One envelope from Ann in epoch `(epoch, pe, pc)` at time `s`.
        #[allow(clippy::too_many_arguments)]
        pub(crate) fn envelope_in(&self, (epoch, pe, pc): (i64, i64, i64), cid: &str, mid: &str, counter: i64, s: i64, kind: &str, ref_: &str, payload: Value, head: Head, key: &[u8; 32]) -> Value {
            let m = OpenedMessage {
                cid: cid.into(),
                mid: mid.into(),
                from_p: self.ann_p.clone(),
                from_d: self.ann_d.clone(),
                serial: self.ann_serial.clone(),
                epoch,
                counter,
                pe,
                pc,
                kind: kind.into(),
                ref_: ref_.into(),
                payload,
                s,
                t: String::new(),
                q: String::new(),
                a: false,
                head,
            };
            ce::seal(&self.ann, key, &m, None).unwrap()
        }

        pub(crate) fn post_event(&self, seq: i64, cid: &str, mid: &str, env: Value) -> Value {
            json!({"seq": seq, "type": "channel_message", "message": {"id": mid, "from": self.ann_p, "channel": &cid[3..], "enc": env, "rts": self.now - 2000, "ts": (self.now - 2000) as f64 / 1000.0}})
        }

        pub(crate) fn chat_event(&self, seq: i64, cid: &str, target: &str, mid: &str, env: Value) -> Value {
            json!({"seq": seq, "type": "chat_event", "scope": "channel", "channel": &cid[3..], "id": target, "event": {"id": mid, "from": self.ann_p, "enc": env, "rts": self.now - 1000}})
        }
    }

    pub(crate) const M1: &str = "0123456789abcdef0123456789abcdef";
    pub(crate) const M2: &str = "fedcba9876543210fedcba9876543210";
    pub(crate) const M3: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn a_message_is_stored_only_after_it_verifies() {
        let w = World::new();
        let key = [9u8; 32];
        let (cid, head) = w.conversation("ops1", &key);
        let good = w.envelope(&cid, M1, 1, "post", "", json!({"t": "hello ops", "m": []}), head, &key);
        let mut forged = w.envelope(&cid, M2, 2, "post", "", json!({"t": "forged", "m": []}), head, &key);
        forged["g"] = good["g"].clone();
        // the key has not been fetched yet: the row waits, nothing is stored, the event is still acknowledged
        let acked = w.session.deliver(&[w.post_event(1, &cid, M1, good)], w.now).unwrap();
        assert_eq!(acked, Some(1));
        assert_eq!(w.store.get(APP, &cid, M1), Ok(None));
        assert!(w.hooks.0.lock().contains(&format!("conversation.added {cid}")));
        // the wrap arrives: the waiting row opens, verifies and is stored; the forged one never is
        w.session.deliver(&[json!({"seq": 2, "type": "chat_keys"}), w.post_event(3, &cid, M2, forged)], w.now).unwrap();
        let kept = w.store.get(APP, &cid, M1).unwrap().expect("the verified message is stored");
        assert_eq!((kept.text.as_str(), kept.from.as_str()), ("hello ops", w.ann_p.as_str()));
        assert_eq!(w.store.get(APP, &cid, M2), Ok(None));
        assert_eq!(w.session.withheld(), 1);
        assert!(w.hooks.0.lock().contains(&format!("message.created {cid}")));
        assert_eq!(w.session.conversations().iter().map(|c| (c.cid.clone(), c.kind)).collect::<Vec<_>>(), vec![(cid.clone(), "group")]);
        assert!(w.session.is_member(&cid, &w.ann_p));
    }

    #[test]
    fn a_verified_delete_erases_before_the_ack() {
        let w = World::new();
        let key = [5u8; 32];
        let (cid, head) = w.conversation("ops2", &key);
        let post = w.envelope(&cid, M1, 1, "post", "", json!({"t": "to be deleted", "m": []}), head, &key);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, post)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some());
        *w.fake.watch.lock() = Some((w.store.clone(), cid.clone(), M1.to_string()));
        let delete = w.envelope(&cid, M2, 2, "delete", M1, json!({"n": 1}), head, &key);
        w.session.deliver(&[w.chat_event(3, &cid, M1, M2, delete)], w.now).unwrap();
        assert_eq!(w.fake.acks.lock().last(), Some(&(3, true)), "the record was gone when the ack went out");
        assert!(w.hooks.0.lock().contains(&format!("message.deleted {cid}")));
    }

    #[test]
    fn a_delete_that_cannot_be_verified_now_holds_the_batch_unacknowledged() {
        let w = World::new();
        let key = [6u8; 32];
        let (cid, head) = w.conversation("ops6", &key);
        let post = w.envelope(&cid, M1, 1, "post", "", json!({"t": "to be deleted later", "m": []}), head, &key);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, post)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some());
        *w.fake.watch.lock() = Some((w.store.clone(), cid.clone(), M1.to_string()));
        let delete = w.envelope(&cid, M2, 2, "delete", M1, json!({"n": 1}), head, &key);
        let ev = w.chat_event(3, &cid, M1, M2, delete);
        // the policy or the lists cannot be verified: the delete is neither parked nor acknowledged
        w.session.set_stop(STOP_UNVERIFIED);
        assert_eq!(w.session.deliver(&[ev.clone()], w.now), Err(EVENTS_HELD.to_string()));
        assert!(!w.fake.acks.lock().iter().any(|(s, _)| *s == 3), "a held event is never acknowledged");
        assert!(w.session.shared().sealed.get(&names::chat_keys(APP)).unwrap().unwrap()["state"]["pending"].as_array().map_or(true, |p| p.is_empty()), "nothing parked in the pending queue");
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some(), "not erased yet");
        // verification works again: the relay delivers it again, it erases, then it is acknowledged
        assert_eq!(w.session.health(w.now), None);
        assert_eq!(w.session.deliver(&[ev], w.now), Ok(Some(3)));
        assert_eq!(w.fake.acks.lock().last(), Some(&(3, true)), "the record was gone when the ack went out");
    }

    #[test]
    fn a_removal_whose_stop_mark_fails_is_not_acknowledged_and_is_retried() {
        let w = World::new();
        let key = [8u8; 32];
        let (cid, head) = w.conversation("ops7", &key);
        let post = w.envelope(&cid, M1, 1, "post", "", json!({"t": "kept until removal", "m": []}), head, &key);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, post)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some());
        // the conversation's sealed index cannot be replaced (a folder in its place), so the stop mark cannot be written
        let app_dir = w.dir.join("store").join(APP);
        let conv_dir = std::fs::read_dir(&app_dir).unwrap().flatten().map(|e| e.path()).find(|p| p.is_dir()).unwrap();
        let index = conv_dir.join("index.bin");
        std::fs::remove_file(&index).unwrap();
        std::fs::create_dir(&index).unwrap();
        std::fs::write(index.join("blocker"), b"x").unwrap();
        let e3 = w.entry(&cid, 3, "remove", &w.app_p, w.now - 500, &head.hash, "");
        w.fake.logs.lock().get_mut(&cid).unwrap().push(e3);
        let ev = json!({"seq": 3, "type": "chat_log", "channel": &cid[3..]});
        let t = w.now;
        assert!(w.session.deliver(&[ev.clone()], t).is_err(), "the batch stops on the failed mark");
        assert!(!w.fake.acks.lock().iter().any(|(s, _)| *s == 3), "the removal is not acknowledged");
        assert_eq!(w.store.get(APP, &cid, M1), Err(StoreError::Stopped("removed")), "reads stop at once all the same");
        let sealed = w.session.shared().sealed.get(&names::chat_keys(APP)).unwrap().unwrap();
        assert_eq!(sealed["state"]["changes"], json!([[cid.clone(), false]]), "the change is sealed, so a restart retries it");
        assert!(!w.hooks.0.lock().contains(&format!("conversation.removed {cid}")));
        // the store can write again: the relay delivers the event again, the mark is written, then the ack goes out
        std::fs::remove_dir_all(&index).unwrap();
        assert_eq!(w.session.deliver(&[ev], t), Ok(Some(3)));
        assert!(w.fake.acks.lock().iter().any(|(s, _)| *s == 3));
        let sealed = w.session.shared().sealed.get(&names::chat_keys(APP)).unwrap().unwrap();
        assert_eq!(sealed["state"]["changes"], json!([]));
        assert!(w.hooks.0.lock().contains(&format!("conversation.removed {cid}")));
        let report = w.store.maintenance(t + crate::connector::MAINTENANCE_EVERY.as_millis() as i64, &BTreeMap::new(), STORE_MAX_DEFAULT);
        assert_eq!(report.purged.iter().map(|p| (p.cid.clone(), p.reason)).collect::<Vec<_>>(), vec![(Some(cid.clone()), "removed")]);
    }

    #[test]
    fn a_log_entry_removing_the_app_stops_reads_and_purges_within_the_hour() {
        let w = World::new();
        let key = [3u8; 32];
        let (cid, head) = w.conversation("ops3", &key);
        let post = w.envelope(&cid, M1, 1, "post", "", json!({"t": "kept until removal", "m": []}), head, &key);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, post)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some());
        let e3 = w.entry(&cid, 3, "remove", &w.app_p, w.now - 500, &head.hash, "");
        w.fake.logs.lock().get_mut(&cid).unwrap().push(e3);
        let t = w.now;
        w.session.deliver(&[json!({"seq": 3, "type": "chat_log", "channel": &cid[3..]})], t).unwrap();
        assert_eq!(w.store.get(APP, &cid, M1), Err(StoreError::Stopped("removed")), "reads stop at once");
        assert_eq!(w.session.conversation_serving(&cid), Err(STOP_NOT_MEMBER));
        assert!(w.session.conversations().is_empty());
        assert!(w.hooks.0.lock().contains(&format!("conversation.removed {cid}")));
        // O5: the purge is due at once, so the next maintenance (the connector runs one at least every 5 minutes)
        // deletes it, well within the hour.
        let every = crate::connector::MAINTENANCE_EVERY.as_millis() as i64;
        assert!(every <= 5 * 60_000);
        let report = w.store.maintenance(t + every, &BTreeMap::new(), STORE_MAX_DEFAULT);
        assert_eq!(report.purged.iter().map(|p| (p.cid.clone(), p.reason)).collect::<Vec<_>>(), vec![(Some(cid.clone()), "removed")]);
        assert!(w.store.conversations(APP).is_empty());
    }

    /// r5 2.7: a verified removal drops every epoch key held for the conversation (in memory and sealed); after a
    /// re-add, the new epoch's wrap opens new messages.
    #[test]
    fn a_removal_forgets_the_epoch_keys_and_a_re_add_opens_the_new_epoch() {
        let w = World::new();
        let (k1, k2) = ([21u8; 32], [22u8; 32]);
        let (cid, head) = w.conversation("ops8", &k1);
        let post = w.envelope(&cid, M1, 1, "post", "", json!({"t": "before the removal", "m": []}), head, &k1);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, post)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some());
        let held = |epoch: i64| w.session.st.lock().device.as_ref().unwrap().keys.get_key(&cid, &w.ann_p, &w.ann_d, epoch);
        let sealed_keys = || {
            let v = w.session.shared().sealed.get(&names::chat_keys(APP)).unwrap().unwrap();
            v["keys"]["keys"].as_array().cloned().unwrap_or_default().into_iter().filter(|k| k[0] == json!(cid)).count()
        };
        assert_eq!(held(1), Some(k1.to_vec()));
        assert_eq!(sealed_keys(), 1);
        // the verified removal
        let e3 = w.entry(&cid, 3, "remove", &w.app_p, w.now - 1500, &head.hash, "");
        let h3 = cl::entry_hash(&cid, &e3).unwrap();
        w.fake.logs.lock().get_mut(&cid).unwrap().push(e3);
        w.session.deliver(&[json!({"seq": 3, "type": "chat_log", "channel": &cid[3..]})], w.now).unwrap();
        assert_eq!(held(1), None, "the removal forgets the conversation's epoch keys");
        assert_eq!(sealed_keys(), 0, "and the sealed state holds none of them");
        // Ann adds the app again and wraps her new epoch's key to it
        let e4 = w.entry(&cid, 4, "add", &w.app_p, w.now - 1200, &h3, "");
        let head4 = Head { seq: 4, hash: cl::entry_hash(&cid, &e4).unwrap() };
        w.fake.logs.lock().get_mut(&cid).unwrap().push(e4);
        w.session.deliver(&[json!({"seq": 4, "type": "chat_log", "channel": &cid[3..]})], w.now).unwrap();
        assert!(w.session.is_member(&cid, &w.app_p));
        let mut pds = vec![(w.ann_p.clone(), w.ann_d.clone()), (w.app_p.clone(), w.app_d.clone())];
        ce::sort_pds(&mut pds);
        let members = ce::set_hash(&pds).unwrap();
        let mut wrap = ce::make_wrap(&w.ann, &cid, &w.ann_p, &w.ann_d, &w.ann_serial, 2, &k2, &w.app_vb, &members, head4, w.now - 1100, None, None, None).unwrap();
        wrap["seq"] = json!(w.seq());
        w.fake.wraps.lock().push(wrap);
        let post = w.envelope_in((2, 1, 1), &cid, M2, 1, w.now - 1000, "post", "", json!({"t": "after the re-add", "m": []}), head4, &k2);
        w.session.deliver(&[json!({"seq": 5, "type": "chat_keys"}), w.post_event(6, &cid, M2, post)], w.now).unwrap();
        assert_eq!(held(2), Some(k2.to_vec()));
        assert_eq!(held(1), None);
        let kept = w.store.get(APP, &cid, M2).unwrap().expect("the new epoch's message opens");
        assert_eq!(kept.text, "after the re-add");
    }

    /// r5 2.5, PC-1 1: a service member's device gets the app's wrap only when its org policy names that device.
    #[test]
    fn a_service_member_gets_a_wrap_only_on_the_device_its_policy_names() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let arc = v["devices"]["arc1"].clone();
        let (arc_p, arc_d) = (arc["principal"].as_str().unwrap().to_string(), arc["device"].as_str().unwrap().to_string());
        let arc_key = DeviceKey::from_pem(v["keys"]["arc1"]["pem"].as_str().unwrap()).unwrap();
        let arc_dck = DckKey::from_scalar(&unhex(v["keys"]["arc1.dck"]["d"].as_str().unwrap())).unwrap();
        for (named, wrapped) in [(arc_d.clone(), true), ("7b7b7b7b7b7b7b7b".to_string(), false)] {
            let w = World::new();
            let now_s = w.now / 1000;
            let policy = json!({
                "v": 1, "org": "acme", "label": "Acme", "domains": ["acme.test"], "seq": 2, "issued": now_s - 100, "expires": now_s + 30 * 86_400,
                "apps": [{"name": "Helpdesk", "type": "api", "principal": w.app_p, "device": w.app_d, "scope": "all", "host": "connector.acme.test"}],
                "archive": {"principal": arc_p, "device": named, "host": "archive.acme.test", "since": now_s - 100},
            });
            w.session.shared().trust.pin_for_test(policy.clone());
            let hash = cl::org_policy_hash(policy.as_object().unwrap());
            w.fake.devices.lock().push(ce::make_bundle(&arc_key, arc["cert"].as_str().unwrap(), "", &arc_dck, now_s - 60, None).unwrap());
            let (cid, head) = w.conversation("svc1", &[23u8; 32]);
            let e3 = cl::make_entry(&w.ann, &cid, 3, "archive", &w.ann_p, &w.ann_d, std::slice::from_ref(&arc_p), w.now - 2500, &head.hash, "", false, &[], &hash).unwrap();
            w.fake.logs.lock().get_mut(&cid).unwrap().push(e3);
            w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), json!({"seq": 2, "type": "chat_log", "channel": &cid[3..]})], w.now).unwrap();
            assert!(w.session.is_member(&cid, &arc_p), "the archive is a verified member");
            w.session.send(&cid, "post", "", json!({"t": "to the members", "m": []}), "", w.now).unwrap();
            let to: Vec<(String, String)> = w.fake.sent.lock().iter().filter(|(r, _)| r == "/v1/chat/keys").flat_map(|(_, b)| b["wraps"].as_array().cloned().unwrap_or_default()).map(|x| (x["to"]["principal"].as_str().unwrap().to_string(), x["to"]["device"].as_str().unwrap().to_string())).collect();
            assert!(to.contains(&(w.ann_p.clone(), w.ann_d.clone())), "a person always gets the wrap");
            assert_eq!(to.contains(&(arc_p.clone(), arc_d.clone())), wrapped, "the archive's device {arc_d} with the policy naming {named}");
        }
    }

    #[test]
    fn a_revoked_app_certificate_purges_every_conversation() {
        let w = World::new();
        let (k1, k2) = ([1u8; 32], [2u8; 32]);
        let (c1, h1) = w.conversation("ops4", &k1);
        let (c2, h2) = w.conversation("ops5", &k2);
        let p1 = w.envelope(&c1, M1, 1, "post", "", json!({"t": "one", "m": []}), h1, &k1);
        let p2 = w.envelope(&c2, M3, 1, "post", "", json!({"t": "two", "m": []}), h2, &k2);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &c1, M1, p1), w.post_event(3, &c2, M3, p2)], w.now).unwrap();
        assert!(w.store.get(APP, &c1, M1).unwrap().is_some() && w.store.get(APP, &c2, M3).unwrap().is_some());
        w.session.force_revoked();
        let t = w.now;
        assert_eq!(w.session.health(t), Some(STOP_REVOKED));
        assert_eq!(w.store.get(APP, &c1, M1), Err(StoreError::Stopped("revoked")));
        assert_eq!(w.store.get(APP, &c2, M3), Err(StoreError::Stopped("revoked")));
        assert!(w.session.conversations().is_empty());
        // a revocation counts as removal: purged at the next maintenance, at most 5 minutes later (O5)
        let report = w.store.maintenance(t + crate::connector::MAINTENANCE_EVERY.as_millis() as i64, &BTreeMap::new(), STORE_MAX_DEFAULT);
        assert_eq!(report.purged.iter().map(|p| (p.cid.clone(), p.reason, p.records)).collect::<Vec<_>>(), vec![(None, "revoked", 2)]);
        assert!(w.store.conversations(APP).is_empty());
    }

    #[test]
    fn a_policy_without_the_app_stops_serving() {
        let w = World::new();
        let now_s = w.now / 1000;
        w.session.shared().trust.pin_for_test(json!({"v": 1, "org": "acme", "label": "Acme", "domains": ["acme.test"], "seq": 2, "issued": now_s - 10, "expires": now_s + 86_400, "apps": []}));
        assert_eq!(w.session.health(w.now), Some(STOP_POLICY));
        assert_eq!(w.session.serving(), Err(STOP_POLICY));
    }

    #[test]
    fn the_enclave_must_match_the_relay() {
        assert_eq!(check_enclave(&json!({"enclave": true}), false), Err(ENCLAVE_IS));
        assert_eq!(check_enclave(&json!({"enclave": false}), true), Err(ENCLAVE_NOT));
        assert_eq!(check_enclave(&json!({}), false), Ok(()));
        assert_eq!(check_enclave(&json!({"enclave": true}), true), Ok(()));
    }
}
