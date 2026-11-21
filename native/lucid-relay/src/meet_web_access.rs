// Contract WA-1 (web access), the relay's part (meet_relay._WebAccess): verified guests and guest rules (sections 2.6,
// 3), guests inside encryption (4.2 to 4.4, relay side), captions of and for guests (5.1 to 5.4) and the web port's
// sessions for members' browsers (7.2 to 7.4). The relay checks shapes and the SSO service's signature and listing;
// member apps check admissions themselves. A child module of meet_hub: it shares the one lock. Persisted under
// ext["wa"]: {log_caps: [{room, start, end, hours}]}. The web port itself (TLS without client certificates) is
// meet_web_port.

use super::*;
use crate::meet_org_policy as op;
use crate::meet_x509::{der_to_pem, ecdsa_sha256_verified, Crl};
use serde_json::json;
use std::time::SystemTime;

const METHODS: [&str; 4] = ["none", "sso", "sso_phr", "piv"];
const CLASSES: [&str; 3] = ["unverified", "verified", "us-gov"];
const GOV_SUFFIXES: [&str; 3] = ["gov", "mil", "fed.us"];
const VERIFIED: [&str; 14] = ["v", "room", "key_sha256", "email", "domain", "method", "idp", "idp_label", "aal", "ocsp", "at", "exp", "cert", "sig"];
const VERIFIED_VIEW: [&str; 5] = ["email", "domain", "method", "idp_label", "aal"];
const BUNDLE: [&str; 7] = ["principal", "device", "dck", "created", "expires", "key", "sig"];
const ADMISSION: [&str; 5] = ["by", "peer", "cert", "ts", "sig"];
/// A guest's member row adds these for certificate holders only (guests never receive them).
pub(crate) const ROW_KEYS: [&str; 5] = ["key", "dck", "verified", "admission", "rules"];
const KEY_MAX: usize = 200;
const CLOCK_MS: f64 = 120.0 * 1000.0;
const CONFLICT_SHOW: f64 = 60.0;
const CAPS: [&str; 4] = ["caption_others", "guest_admit", "peer_identity", "self_captions"];
const CAPTION_MAX: i64 = 8;
const LINK_MAX: i64 = 1440;
const CHALLENGE_TTL: f64 = 60.0;
const CHALLENGES_MAX: usize = 10000;
const SESSION_IDLE: f64 = 15.0 * 60.0;
const SESSION_MAX: f64 = 12.0 * 3600.0;
const SESSIONS_MAX: usize = 5000;
const WEB_ORGS_MAX: usize = 64;
const PEM_MAX: usize = 8192;
const CHAIN_MAX: usize = 16384;
const BUSY: &str = "too many tries from this address; wait a minute";
const SIGN_INS_BUSY: &str = "too many sign-ins right now; try again later";

// words (exact, contract sections 2.6, 3, 4, 5, 7)
pub(super) const RELOAD: &str = "the page is out of date; reload it";
pub(super) const CLOCK: &str = "the page's clock is wrong";
pub(super) const NOT_YOURS: &str = "that key is not yours";
const UNCHECKED: &str = "that sign-in could not be checked";
const NEEDS_VERIFIED: &str = "this link needs a verified sign-in";
const GOV_WORDS: &str = "people with a government address must sign in with a PIV or CAC card or a phishing-resistant sign-in";
const NO_GUESTS: &str = "this organization does not allow guests";
pub(super) const LINKS_OFF: &str = "your organization does not allow guest links";
pub(super) const RECORD_REFUSED: &str = "this guest's rules do not allow recording";
const RECORD_ON: &str = "recording is on, and this guest's rules do not allow recording";
const CONFLICT: &str = "this call has a guest your organization's rules do not allow";
pub(super) const ADMIT_EACH: &str = "admit each guest from the Lucid app";
const NOT_CAPTIONING: &str = "you are not captioning that person";
pub(super) const ID_USED: &str = "this guest id is in use; reload the page";
const CAPTIONER_REMOVED: &str = "the host removed the captioner from this call";
const CHALLENGE_USED: &str = "that challenge was used";
const CHALLENGE_OLD: &str = "that challenge has expired; ask for a new one";
const NOT_WEB: &str = "this is not a Lucid Meet on the web certificate";
const REVOKED: &str = "this certificate was revoked";
pub(crate) const SIGN_IN: &str = "sign in again";
pub(super) const SIGN_IN_CHAT: &str = "sign in to use encrypted chat";

/// One web port session (section 7.3).
struct WebSession {
    who: Identity,
    cert: Cert,
    chain: Vec<Cert>,
    expires: f64,
    /// Monotonic: its last request.
    seen: f64,
}

/// In memory: the WA-1 settings (checked at start), the web port's challenges and sessions, the guest conflicts the
/// hosts see, and the CRLs parsed once per change of their files.
pub struct Wa {
    verify_url: String,
    rules: Vec<Value>,
    gov_baseline: bool,
    gov_domains: Vec<String>,
    captioner: String,
    web_host: String,
    web_config: Obj,
    /// challenge -> (expiry, monotonic; used)
    challenges: HashMap<String, (f64, bool)>,
    /// SHA-256 (hex) of the session token -> session
    sessions: HashMap<String, WebSession>,
    /// room -> (guests a joiner's org would refuse, monotonic)
    conflicts: HashMap<String, (i64, f64)>,
    crl_cache: HashMap<PathBuf, (Option<SystemTime>, Vec<Crl>)>,
}

impl Wa {
    pub(super) fn new() -> Wa {
        Wa {
            verify_url: String::new(),
            rules: Vec::new(),
            gov_baseline: true,
            gov_domains: Vec::new(),
            captioner: String::new(),
            web_host: String::new(),
            web_config: obj([("sso", Value::from("")), ("orgs", Value::Array(Vec::new()))]),
            challenges: HashMap::new(),
            sessions: HashMap::new(),
            conflicts: HashMap::new(),
            crl_cache: HashMap::new(),
        }
    }
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────

/// `lp()` of text (UTF-8) and raw byte fields.
fn lp(fields: &[&[u8]]) -> Vec<u8> {
    op::lp(fields)
}

fn u64b(n: i64) -> [u8; 8] {
    (n as u64).to_be_bytes()
}

/// _wa_sig_ok: `sig` (standard base64 DER ECDSA) is the key's (SPKI DER) over `data`.
fn sig_ok(spki: &[u8], data: &[u8], sig: Option<&Value>) -> bool {
    let Some(Value::String(s)) = sig else { return false };
    if s.is_empty() || s.len() > 400 {
        return false;
    }
    pj::b64_strict(s).is_some_and(|raw| ecdsa_sha256_verified(spki, data, &raw))
}

/// _wa_guest_key: the SPKI DER of a guest page's P-256 identity key (400 otherwise).
fn guest_key(key: Option<&Value>) -> R<Vec<u8>> {
    let Some(Value::String(k)) = key else { return bad(RELOAD) };
    if k.is_empty() || k.chars().count() > KEY_MAX {
        return bad(RELOAD);
    }
    match pj::b64_strict(k) {
        Some(spki) if crate::der::p256_from_spki(&spki).is_some() => Ok(spki),
        _ => bad(RELOAD),
    }
}

fn label_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 63 && alnum(&b[0]) && alnum(&b[b.len() - 1]) && b.iter().all(|c| alnum(c) || *c == b'-')
}

/// WA_DOMAIN_RE: one or more lower-case DNS labels, at most 253 characters.
fn domain_ok(s: &str) -> bool {
    (1..=253).contains(&s.len()) && s.split('.').all(label_ok)
}

/// WA_ORG_RE: an org id (a v2 guest link's `o`, a web_orgs entry).
pub(super) fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// `(netloc, hostname)` of an https origin (no path but "/", no query, fragment or user), as urlparse reads it.
pub(crate) fn https_origin(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (netloc, tail) = rest.split_at(end);
    if !(tail.is_empty() || tail == "/" || tail == "?" || tail == "#") || netloc.contains('@') {
        return None;
    }
    let host = match netloc.strip_prefix('[') {
        Some(h) => h.split(']').next().unwrap_or_default(),
        None => netloc.split(':').next().unwrap_or_default(),
    }
    .to_lowercase();
    (!host.is_empty()).then(|| (netloc.to_string(), host))
}

/// `scheme://netloc` of a URL ("" without both).
fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return String::new() };
    let netloc = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if scheme.is_empty() || netloc.is_empty() || !scheme.bytes().all(|c| c.is_ascii_alphanumeric() || b"+-.".contains(&c)) {
        return String::new();
    }
    format!("{}://{netloc}", scheme.to_lowercase())
}

/// page_csp: the guest and web pages' CSP: no inline script or style, nothing from another origin but the media
/// server's and the SSO service's (WA-1 6), workers from the relay only (LiveKit's E2EE worker), no framing.
pub(crate) fn page_csp(sfu_url: &str, sso_url: &str) -> String {
    let mut connect = vec!["'self'".to_string()];
    for url in [sfu_url, sso_url] {
        let o = origin_of(url);
        if !o.is_empty() {
            connect.push(o);
        }
    }
    format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src {}; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'",
        connect.join(" ")
    )
}

/// The value of a text setting (`str(value or "").strip()`).
fn setting_text(v: &Value) -> String {
    if pj::truthy(Some(v)) {
        pj::py_str(v).trim().to_string()
    } else {
        String::new()
    }
}

/// _wa_sso_origin: `https://host[:port]` of an SSO setting ("" stays "").
fn sso_origin(v: &Value, name: &str) -> Result<String, String> {
    let url = setting_text(v);
    if url.is_empty() {
        return Ok(url);
    }
    https_origin(&url).map(|(netloc, _)| format!("https://{netloc}")).ok_or_else(|| format!("relay settings: {name} must be the SSO service's https origin, such as https://sso.example.gov"))
}

fn defaults() -> Obj {
    obj([
        ("allow", Value::Bool(true)),
        ("verify", json!(METHODS)),
        ("lobby", Value::from("always")),
        ("large_calls", Value::from("allow")),
        ("record", Value::from("consent")),
        ("chat", Value::from("any")),
        ("third_party_text", Value::from("allow")),
        ("ai", Value::from("any")),
        ("captions", Value::from("on")),
        ("ocsp", Value::from("best_effort")),
        ("link_max_minutes", Value::from(LINK_MAX)),
        ("log_hours", Value::from(168)),
    ])
}

/// A field's values, least to most restrictive (section 3.3): the rank of `v`.
fn rank(name: &str, v: &Value) -> usize {
    let order: &[&str] = match name {
        "allow" => return usize::from(v == &Value::Bool(false)),
        "lobby" => &["verified_bypass", "always"],
        "large_calls" => &["allow", "refuse"],
        "record" => &["consent", "refuse"],
        "chat" => &["any", "e2ee"],
        "third_party_text" => &["allow", "refuse"],
        "ai" => &["any", "local", "off"],
        "captions" => &["on", "off"],
        "ocsp" => &["best_effort", "required"],
        _ => &[],
    };
    v.as_str().and_then(|s| order.iter().position(|o| *o == s)).unwrap_or(0)
}

fn match_list(rule: &Obj) -> Vec<String> {
    let got: Vec<String> = rule.get("match").and_then(Value::as_array).map(|a| a.iter().map(pj::py_str).collect()).unwrap_or_default();
    if got.is_empty() {
        vec!["*".into()]
    } else {
        got
    }
}

fn matches(rule: &Obj, cls: &str, domain: &str) -> bool {
    match_list(rule).iter().any(|m| m == "*" || m == cls || (!CLASSES.contains(&m.as_str()) && !domain.is_empty() && (domain == m || domain.ends_with(&format!(".{m}")))))
}

type Sources = Vec<(String, Vec<Value>)>;

/// _wa_resolve: the resolved rule object: every field but `match` with the defaults filled, the most restrictive value
/// of every matching rule of every source (`verify` lists intersect, numbers take the smallest), plus `class` and `by`
/// (per field the source that set its value). `star`: only rules whose `match` has "*" (a link's life at creation).
fn resolve(sources: &Sources, cls: &str, domain: &str, star: bool) -> Obj {
    let mut out = defaults();
    let mut by = Obj::new();
    for (label, rules) in sources {
        for rule in rules.iter().filter_map(Value::as_object) {
            if star {
                if !match_list(rule).iter().any(|m| m == "*") {
                    continue;
                }
            } else if !matches(rule, cls, domain) {
                continue;
            }
            for (name, value) in rule {
                if name == "match" {
                    continue;
                }
                let cur = out.get(name).cloned().unwrap_or(Value::Null);
                let new = match name.as_str() {
                    "verify" => {
                        let allowed = value.as_array().cloned().unwrap_or_default();
                        Value::Array(cur.as_array().cloned().unwrap_or_default().into_iter().filter(|m| allowed.contains(m)).collect())
                    }
                    "link_max_minutes" | "log_hours" => Value::from(pj::as_int(Some(&cur)).unwrap_or(0).min(pj::as_int(Some(value)).unwrap_or(0))),
                    "lobby" => {
                        if value == "always" || (cur == "always" && by.contains_key("lobby")) {
                            Value::from("always")
                        } else {
                            value.clone()
                        }
                    }
                    _ => {
                        if rank(name, value) > rank(name, &cur) {
                            value.clone()
                        } else {
                            cur.clone()
                        }
                    }
                };
                if new != cur {
                    out.insert(name.clone(), new);
                    by.insert(name.clone(), Value::from(label.clone()));
                }
            }
        }
    }
    out.insert("class".into(), Value::from(cls));
    out.insert("by".into(), Value::Object(by));
    out
}

/// _wa_caps: `(caps, caption_others_max)` of a join body (caps None when it sent none).
pub(super) fn caps(ext: &Obj) -> R<(Option<Vec<String>>, i64)> {
    let most = match ext.get("caption_others_max") {
        None => 4,
        Some(v) => match pj::as_int(Some(v)) {
            Some(n) if (1..=CAPTION_MAX).contains(&n) => n,
            _ => return bad(format!("caption_others_max must be a whole number from 1 to {CAPTION_MAX}")),
        },
    };
    let caps = match ext.get("caps") {
        None | Some(Value::Null) => return Ok((None, most)),
        Some(Value::Array(a)) => a,
        Some(_) => return bad(format!("caps must list {}", CAPS.join(", "))),
    };
    let names: Vec<String> = caps.iter().filter_map(|c| c.as_str().filter(|c| CAPS.contains(c)).map(str::to_string)).collect();
    if names.len() != caps.len() || names.iter().collect::<HashSet<_>>().len() != names.len() {
        return bad(format!("caps must list {}", CAPS.join(", ")));
    }
    Ok((Some(names), most))
}

fn gov_baseline() -> Value {
    json!({"match": ["us-gov"], "verify": ["sso_phr", "piv"], "chat": "e2ee", "third_party_text": "refuse", "ai": "local", "ocsp": "required", "log_hours": 24})
}

fn profile(name: &str) -> Vec<Value> {
    if name != "us-gov" {
        return Vec::new();
    }
    vec![
        json!({"match": ["*"], "verify": ["sso", "sso_phr", "piv"], "lobby": "always", "chat": "e2ee", "third_party_text": "refuse", "ai": "local", "ocsp": "required", "link_max_minutes": 480, "log_hours": 24}),
        json!({"match": ["us-gov"], "verify": ["sso_phr", "piv"]}),
    ]
}

fn rule_of<'a>(rec: &'a guests::Rec, key: &str) -> Option<&'a Value> {
    rec.rules.as_ref().and_then(|r| r.get(key))
}

/// _wa_chat_guest: a guest inside encrypted call chat (4.4 revision 3): a valid sign-in at its knock and an admission
/// from the host's app.
pub(super) fn chat_guest(rec: Option<&guests::Rec>) -> bool {
    rec.is_some_and(|r| !r.key.is_empty() && !r.verified.is_null() && !r.admission.is_null())
}

// ── State: settings, rules, verification, admissions, captions ───────────────────────────────────────────────

impl State {
    /// _wa_configure: the WA-1 settings (Err: the one the relay cannot use).
    pub(super) fn wa_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        let url = sso_origin(&s.guest_verify_url, "guest_verify_url")?;
        let web_sso = sso_origin(&s.web_sso_url, "web_sso_url")?;
        let orgs_bad = "relay settings: web_orgs must list each organization once as {\"org\": id, \"label\": name}";
        let Value::Array(orgs) = &s.web_orgs else { return Err(orgs_bad.into()) };
        let mut kept: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for o in orgs {
            let ok = o.as_object().is_some_and(|o| {
                o.len() == 2
                    && o.get("org").and_then(Value::as_str).is_some_and(org_ok)
                    && o.get("label").and_then(Value::as_str).is_some_and(|l| (1..=64).contains(&l.trim().chars().count()) && pj::printable(l))
            });
            if !ok || orgs.len() > WEB_ORGS_MAX || !seen.insert(pj::py_str(&o["org"])) {
                return Err(orgs_bad.into());
            }
            kept.push(json!({"org": o["org"], "label": pj::py_str(&o["label"]).trim()}));
        }
        let rules = &s.guest_rules;
        if pj::truthy(Some(rules)) {
            op::check_guest_rules(rules, "guest_rules").map_err(|e| format!("relay settings: {e}"))?;
        } else if !rules.is_array() {
            return Err("relay settings: guest_rules must be a list of rules".into());
        }
        let Value::Bool(baseline) = s.gov_baseline else { return Err("relay settings: gov_baseline must be true or false".into()) };
        let domains: Option<Vec<String>> = s.gov_domains.as_array().and_then(|a| a.iter().map(|d| d.as_str().filter(|d| domain_ok(d)).map(str::to_string)).collect());
        let Some(domains) = domains else { return Err("relay settings: gov_domains must list lower-case domain names".into()) };
        let captioner = setting_text(&s.captioner_principal).to_lowercase();
        if !captioner.is_empty() && pc::service_kind(&captioner) != "app" {
            return Err("relay settings: captioner_principal must be the captioner's <name>@apps.<domain>".into());
        }
        let port = match pj::as_int(Some(&s.web_port)) {
            Some(p) if (0..65536).contains(&p) => p,
            _ => return Err("relay settings: web_port must be a port number, or 0 for no web port".into()),
        };
        let mut host = String::new();
        if port != 0 {
            if port == i64::from(s.port) || pj::as_int(Some(&s.guest_port)) == Some(port) {
                return Err("relay settings: web_port must not be the relay's port or the guest port".into());
            }
            let Some((_, h)) = https_origin(&setting_text(&s.web_public)) else {
                return Err("relay settings: web_public must be the https origin of the web port, such as https://meet.example.gov".into());
            };
            host = h;
        }
        let wa = &mut self.wa;
        wa.web_config = obj([("sso", Value::from(if web_sso.is_empty() { url.clone() } else { web_sso })), ("orgs", Value::Array(kept))]);
        wa.verify_url = url;
        wa.rules = rules.as_array().cloned().unwrap_or_default();
        wa.gov_baseline = baseline;
        wa.gov_domains = domains;
        wa.captioner = captioner;
        wa.web_host = host;
        Ok(())
    }

    /// _wa_store: `ext["wa"]` as checked: `{log_caps: [{room, start, end, hours}]}`.
    fn wa_caps_mut(&mut self) -> &mut Vec<Value> {
        let raw = self.ext.get("wa").and_then(Value::as_object).cloned();
        let caps = raw.as_ref().and_then(|r| r.get("log_caps")).and_then(Value::as_array).cloned().unwrap_or_default();
        let good: Vec<Value> = caps
            .iter()
            .filter(|c| {
                c.as_object().is_some_and(|c| {
                    c.get("room").is_some_and(Value::is_string) && pj::as_num(c.get("start")).is_some() && pj::as_int(c.get("hours")).is_some() && (c.get("end").is_none_or(Value::is_null) || pj::as_num(c.get("end")).is_some())
                })
            })
            .cloned()
            .collect();
        let sound = raw.as_ref().and_then(|r| r.get("log_caps")).and_then(Value::as_array).is_some_and(|c| *c == good);
        if !sound {
            self.ext.insert("wa".into(), json!({"log_caps": good}));
        }
        self.ext.get_mut("wa").and_then(|w| w.get_mut("log_caps")).and_then(Value::as_array_mut).expect("wa log_caps")
    }

    // ── guest rules (section 3) ──

    /// _wa_policy: `org`'s newest signed policy that has not expired.
    pub(super) fn wa_policy(&mut self, org: &str) -> Option<Obj> {
        if org.is_empty() {
            return None;
        }
        let now = pj::now();
        let v = self.pc_store()?.newest.get(org)?;
        (!op::expired(&v.policy, now)).then(|| v.policy.clone())
    }

    pub(super) fn wa_guests_key(&mut self, org: &str) -> Obj {
        self.wa_policy(org).and_then(|p| p.get("guests").and_then(Value::as_object).cloned()).unwrap_or_default()
    }

    /// _wa_org_of: the org whose current policy covers this person ("" when none).
    pub(super) fn wa_org_of(&mut self, principal: &str) -> String {
        if principal.is_empty() || principal.ends_with(m::GUEST_DOMAIN) {
            return String::new();
        }
        let policies = self.pc_current();
        pc::covering(&policies, principal).map(|p| pj::s(p, "org")).unwrap_or_default()
    }

    /// _wa_present: the orgs of every person seated in this stay so far (section 3.1).
    fn wa_present(&mut self, room: &str) -> Vec<String> {
        let mut people: HashSet<String> = self.stays.get(room).map(|s| s.seen.keys().cloned().collect()).unwrap_or_default();
        people.extend(self.peers.values().filter(|p| p.room == room).map(|p| p.who.principal.clone()));
        let mut orgs: Vec<String> = people.iter().map(|p| self.wa_org_of(p)).filter(|o| !o.is_empty()).collect();
        orgs.sort();
        orgs.dedup();
        orgs
    }

    /// _wa_sources: every rule source, in order: the relay's, the US government baseline, the host organization's (its
    /// profile, then its rules), each present organization's.
    fn wa_sources(&mut self, host_org: &str, present: &[String]) -> Sources {
        let mut out: Sources = Vec::new();
        if !self.wa.rules.is_empty() {
            out.push(("relay".into(), self.wa.rules.clone()));
        }
        if self.wa.gov_baseline {
            out.push(("gov-baseline".into(), vec![gov_baseline()]));
        }
        let mut orgs = vec![host_org.to_string()];
        orgs.extend(present.iter().filter(|o| *o != host_org).cloned());
        for org in orgs.into_iter().filter(|o| !o.is_empty()) {
            let g = self.wa_guests_key(&org);
            let mut rules = profile(g.get("profile").and_then(Value::as_str).unwrap_or("standard"));
            rules.extend(g.get("rules").and_then(Value::as_array).cloned().unwrap_or_default());
            if !rules.is_empty() {
                out.push((format!("org:{org}"), rules));
            }
        }
        out
    }

    fn wa_class(&self, verified: &Value) -> String {
        let Some(domain) = verified.get("domain").and_then(Value::as_str) else { return "unverified".into() };
        let gov = GOV_SUFFIXES.iter().map(|s| s.to_string()).chain(self.wa.gov_domains.iter().cloned()).any(|s| domain == s || domain.ends_with(&format!(".{s}")));
        if gov { "us-gov" } else { "verified" }.into()
    }

    /// _wa_rules_for: a guest's resolved rules now (`extra`: an org about to be present).
    pub(super) fn wa_rules_for(&mut self, room: &str, host_org: &str, verified: &Value, extra: Option<&str>) -> Obj {
        let mut present = self.wa_present(room);
        if let Some(e) = extra {
            if !present.iter().any(|o| o == e) {
                present.push(e.to_string());
                present.sort();
            }
        }
        let sources = self.wa_sources(host_org, &present);
        let domain = verified.get("domain").and_then(Value::as_str).unwrap_or_default().to_string();
        resolve(&sources, &self.wa_class(verified), &domain, false)
    }

    /// _wa_guest_view: the guest's own copy: `by` says only `host` or `other`.
    pub(super) fn wa_guest_view(rules: &Obj, host_org: &str) -> Obj {
        let host = ["relay".to_string(), "gov-baseline".to_string(), format!("org:{host_org}")];
        let by: Obj = rules.get("by").and_then(Value::as_object).map(|b| b.iter().map(|(k, v)| (k.clone(), Value::from(if host.contains(&pj::py_str(v)) { "host" } else { "other" }))).collect()).unwrap_or_default();
        with(rules, obj([("by", Value::Object(by))]))
    }

    /// _wa_link_cap: the "*" rules' `link_max_minutes` for a link to `room`.
    pub(super) fn wa_link_cap(&mut self, room: &str, host_org: &str) -> i64 {
        let present = self.wa_present(room);
        let sources = self.wa_sources(host_org, &present);
        pj::as_int(resolve(&sources, "unverified", "", true).get("link_max_minutes")).unwrap_or(LINK_MAX)
    }

    /// `GET /g/v1/verify`: the methods the link's "*" and `unverified` rules accept that this relay can offer, and
    /// the SSO service's origin.
    pub(super) fn wa_verify_view(&mut self, room: &str, host_org: &str) -> Obj {
        let present = self.wa_present(room);
        let sources = self.wa_sources(host_org, &present);
        let rules = resolve(&sources, "unverified", "", false);
        let url = self.wa.verify_url.clone();
        let methods: Vec<Value> = rules.get("verify").and_then(Value::as_array).into_iter().flatten().filter(|m| !url.is_empty() || *m == "none").cloned().collect();
        obj([("methods", Value::Array(methods)), ("verify_url", Value::from(url))])
    }

    pub(super) fn wa_recording(&self, room: &str) -> bool {
        self.peers.values().any(|p| p.room == room && (p.recording || !p.recording_request.is_empty()))
    }

    /// _wa_refusal: why a guest with these rules may not be here (None: it may).
    pub(super) fn wa_refusal(&self, rules: &Obj, verified: &Value, unchecked: bool, room: &str, recording: bool) -> Option<E> {
        let domain = verified.get("domain").and_then(Value::as_str);
        if rules.get("allow") == Some(&Value::Bool(false)) {
            return Some(E::Forbidden(match domain {
                Some(d) => format!("guests from {d} are not allowed in this meeting"),
                None => NO_GUESTS.into(),
            }));
        }
        let method = verified.get("method").and_then(Value::as_str).unwrap_or("none");
        let verify = rules.get("verify").and_then(Value::as_array).cloned().unwrap_or_default();
        if !verify.iter().any(|m| m == method) {
            let words = if verify.is_empty() {
                NO_GUESTS
            } else if rules.get("class").and_then(Value::as_str) == Some("us-gov") {
                GOV_WORDS
            } else if unchecked {
                UNCHECKED
            } else {
                NEEDS_VERIFIED
            };
            return Some(E::Forbidden(words.into()));
        }
        if method == "piv" && verified.get("ocsp").and_then(Value::as_str) == Some("unknown") && rules.get("ocsp").and_then(Value::as_str) == Some("required") {
            return Some(E::Forbidden(UNCHECKED.into()));
        }
        if self.sfu_encrypted(room) && (rules.get("large_calls").and_then(Value::as_str) == Some("refuse") || self.sfu_legacy(room)) {
            return Some(E::Forbidden(sfu::E2EE_GUESTS.into()));
        }
        if recording && rules.get("record").and_then(Value::as_str) == Some("refuse") && self.wa_recording(room) {
            return Some(E::Conflict(RECORD_ON.into()));
        }
        None
    }

    /// _wa_plain_guests: for each seated guest outside encrypted call chat (no sign-in or no admission; a seat without
    /// a row counts too), whether its rules say chat "e2ee".
    pub(super) fn wa_plain_guests(&self, room: &str) -> Vec<bool> {
        self.peers
            .values()
            .filter(|p| p.room == room && p.who.guest && !p.admission_pending)
            .map(|p| self.guests.rec.get(&guests::guest_id(&p.who.principal)))
            .filter(|r| !chat_guest(*r))
            .map(|r| r.and_then(|r| rule_of(r, "chat")).and_then(Value::as_str) == Some("e2ee"))
            .collect()
    }

    /// _wa_guest_recs: the ids of the room's guest rows in these states that have rules.
    pub(super) fn wa_guest_recs(&self, room: &str, states: &[&str]) -> Vec<String> {
        self.guests.rec.values().filter(|r| r.kind == "guest" && r.room == room && states.contains(&r.state) && r.rules.is_some()).map(|r| r.id.clone()).collect()
    }

    /// Some seated (admitted or in) guest's rules say `key` is `value`.
    pub(super) fn wa_any_rule(&self, room: &str, key: &str, value: &str) -> bool {
        self.wa_guest_recs(room, &["admitted", "in"]).iter().any(|id| self.guests.rec.get(id).and_then(|r| rule_of(r, key)).and_then(Value::as_str) == Some(value))
    }

    // ── the SSO service's result (section 2.6) ──

    /// _wa_intermediates: the signer's current and previous intermediates (issued by the root directly).
    fn wa_intermediates(&self) -> Vec<Cert> {
        let Some(root) = self.pc_root() else { return Vec::new() };
        let snap = self.pc.signer.as_ref().and_then(|s| s.snapshot()).unwrap_or_default();
        ["intermediate_pem", "previous_pem"].iter().filter_map(|k| Cert::from_pem(&pj::s(&snap, k))).filter(|c| c.issued_directly_by_root(&root)).collect()
    }

    /// _wa_crls: every CRL the relay checks against (its files, parsed once per change).
    fn wa_crls(&mut self) -> Vec<Crl> {
        let mut out = Vec::new();
        let mut paths = self.pc.crl_files.clone();
        paths.dedup();
        for path in paths {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let mtime = meta.modified().ok();
            let fresh = self.wa.crl_cache.get(&path).is_some_and(|(t, _)| *t == mtime && mtime.is_some());
            if !fresh {
                let crls = crate::meet_tls::crls_in(&crate::meet_tls::read_bytes(&path));
                self.wa.crl_cache.insert(path.clone(), (mtime, crls));
            }
            out.extend(self.wa.crl_cache[&path].1.iter().cloned());
        }
        out
    }

    /// _wa_revoked: on the deny list, or on a CRL of its issuer that the relay holds.
    fn wa_revoked(&mut self, cert: &Cert) -> bool {
        if self.denied.contains_key(&m::serial(&cert.serial)) {
            return true;
        }
        self.wa_crls().iter().any(|c| c.issuer == cert.issuer && c.serials.contains(&cert.serial))
    }

    /// _wa_chain_ok: chains to the Meet CA root, directly or through an intermediate (presented or the signer's), none
    /// of it revoked.
    fn wa_chain_ok(&mut self, cert: &Cert, presented: &[Cert]) -> bool {
        let Some(root) = self.pc_root() else { return false };
        let mut inters: Vec<Cert> = presented.to_vec();
        inters.extend(self.wa_intermediates());
        if !cert.verify_chain(&inters, &root, pj::now() as i64) {
            return false;
        }
        let issuer = inters.iter().find(|c| c.subject == cert.issuer).cloned();
        !self.wa_revoked(cert) && !issuer.is_some_and(|i| self.wa_revoked(&i))
    }

    /// _wa_verified: the guest's `verified` when every check of section 2.6 passes, else None (it counts as absent).
    pub(super) fn wa_verified(&mut self, value: Option<&Value>, room: &str, key_sha: &str) -> Option<Obj> {
        let v = value?.as_object()?;
        if v.len() != VERIFIED.len() || !VERIFIED.iter().all(|k| v.contains_key(*k)) {
            return None;
        }
        let text = |k: &str| v.get(k).and_then(Value::as_str);
        if pj::as_int(v.get("v")) != Some(1) || !VERIFIED.iter().filter(|k| !["v", "at", "exp"].contains(k)).all(|k| text(k).is_some()) {
            return None;
        }
        let (at, exp) = (pj::as_int(v.get("at"))?, pj::as_int(v.get("exp"))?);
        let (email, domain, method) = (text("email")?, text("domain")?, text("method")?);
        if !METHODS[1..].contains(&method) || !domain_ok(domain) || email.rsplit_once('@').map(|(_, d)| d).unwrap_or(email) != domain || email.chars().count() > 320 || text("idp_label")?.chars().count() > 100 || text("cert")?.chars().count() > PEM_MAX {
            return None;
        }
        if !(1..=600).contains(&(exp - at)) || exp as f64 <= pj::now() {
            return None;
        }
        if text("room")? != room || aws_lc_rs::constant_time::verify_slices_are_equal(text("key_sha256")?.as_bytes(), key_sha.as_bytes()).is_err() {
            return None;
        }
        let cert = Cert::from_pem(text("cert")?)?;
        if pc::cert_kind(&cert.names.uris).ok()?.0 != "sso" || !self.wa_chain_ok(&cert, &[]) {
            return None;
        }
        if !self.pc_terms().guest_verifier(&cert.serial) {
            return None;
        }
        let data = op::guest_verify_bytes(room, key_sha, email, domain, method, text("idp")?, text("aal")?, text("ocsp")?, at, exp);
        sig_ok(&cert.spki, &data, v.get("sig")).then(|| v.clone())
    }

    /// _wa_bundle: the guest chat bundle of a knock (section 4.4), signed by the page's key: the guest id it names
    /// (`guest-<id>@guest.invalid`, device `<id>`).
    pub(super) fn wa_bundle(dck: Option<&Value>, key: &str, spki: &[u8], key_sha: &str) -> R<String> {
        let shape = format!("dck must be {{{}}}", BUNDLE.join(", "));
        let d = match dck {
            None | Some(Value::Null) => return bad(RELOAD),
            Some(Value::Object(d)) if d.len() == BUNDLE.len() && BUNDLE.iter().all(|k| d.contains_key(*k)) => d,
            Some(_) => return bad(shape),
        };
        let principal = d.get("principal").and_then(Value::as_str).unwrap_or_default();
        let gid = guests::guest_id(principal);
        if gid.is_empty() || !principal.starts_with("guest-") || d.get("device").and_then(Value::as_str) != Some(gid.as_str()) {
            return bad("dck must name guest-<16 hex>@guest.invalid and that device");
        }
        let point = "dck must be an uncompressed P-384 point (base64)";
        let raw = sfu::e2ee_b64(d.get("dck"), 97, 97, point)?;
        if raw[0] != 4 {
            return bad(point);
        }
        let created = ce_int(d.get("created"), "dck created")?;
        let expires = ce_int(d.get("expires"), "dck expires")?;
        if d.get("key").and_then(Value::as_str) != Some(key) {
            return bad("dck must carry the page's key");
        }
        let data = lp(&[b"lucid-meet-chat-guest-dck-v1", principal.as_bytes(), gid.as_bytes(), &raw, &u64b(created), &u64b(expires), key_sha.as_bytes()]);
        if !sig_ok(spki, &data, d.get("sig")) {
            return forbidden(NOT_YOURS);
        }
        Ok(gid)
    }

    /// _wa_admission: an admission's shape (section 4.2): the caller's own principal, seat and seat certificate;
    /// members check the signature.
    pub(super) fn wa_admission(&self, value: &Value, peer_id: &str, exp: f64) -> R<Obj> {
        let shape = format!("admission must be {{{}}}", ADMISSION.join(", "));
        let Some(a) = value.as_object().filter(|a| ADMISSION.iter().all(|k| a.contains_key(*k)) && a.keys().all(|k| ADMISSION.contains(&k.as_str()) || k == "expires")) else {
            return bad(shape);
        };
        let peer = &self.peers[peer_id];
        if a.get("by").and_then(Value::as_str) != Some(peer.who.principal.as_str()) {
            return bad("admission by must be your address");
        }
        if a.get("peer").and_then(Value::as_str) != Some(peer_id) {
            return bad("admission peer must be your seat");
        }
        let cert_ok = a.get("cert").and_then(Value::as_str).is_some_and(|c| (1..=PEM_MAX).contains(&c.chars().count()) && c.contains("-----BEGIN CERTIFICATE-----") && (peer.cert.is_empty() || c.trim() == peer.cert.trim()));
        if !cert_ok {
            return bad("admission cert must be your seat's certificate");
        }
        ce_int(a.get("ts"), "admission ts")?;
        sfu::e2ee_b64(a.get("sig"), 8, 139, "admission sig must be a signature (base64)")?;
        if let Some(e) = a.get("expires") {
            if pj::as_int(Some(e)) != Some(exp as i64) {
                return bad("admission expires must be the guest's pass end");
            }
        }
        Ok(a.clone())
    }

    /// _wa_admit_check: a guest admitted into a large call needs its key, an admission and rules that allow large
    /// calls; into a recorded stay, rules that allow recording.
    pub(super) fn wa_admit_check(&self, id: &str, admission: &Value) -> R<()> {
        let r = &self.guests.rec[id];
        if self.sfu_encrypted(&r.room) && (r.key.is_empty() || admission.is_null() || rule_of(r, "large_calls").and_then(Value::as_str) == Some("refuse") || self.sfu_legacy(&r.room)) {
            return forbidden(sfu::E2EE_GUESTS);
        }
        if rule_of(r, "record").and_then(Value::as_str) == Some("refuse") && self.wa_recording(&r.room) {
            return Err(E::Conflict(RECORD_ON.into()));
        }
        Ok(())
    }

    /// _wa_bypass: `verified_bypass`: the host's seat only hears `guest_admit_request`.
    pub(super) fn wa_bypass(&mut self, id: &str) {
        let r = &self.guests.rec[id];
        if rule_of(r, "lobby").and_then(Value::as_str) != Some("verified_bypass") || r.verified.is_null() {
            return;
        }
        let room = r.room.clone();
        let Some(host) = self.stage_host(&room) else { return };
        // an app seat only: a web seat never admits (no app host: the guest waits)
        let ok = self.peers.get(&host).is_some_and(|h| !h.who.guest && h.who.kind != "web" && !h.admission_pending);
        if !ok {
            return;
        }
        let event = obj([("type", Value::from("guest_admit_request")), ("target", Value::from(id)), ("guest", Value::Object(self.guests_entry(id))), ("stay", Value::from(self.wa_stay_id(&room)))]);
        self.push_peer(&host, &event);
    }

    /// _wa_member: a guest's member row adds its key, chat bundle, verification, admission and rules.
    pub(super) fn wa_member(&self, peer: &Peer, row: &mut Obj) {
        if !peer.who.guest {
            return;
        }
        if let Some(r) = self.guests.rec.get(&guests::guest_id(&peer.who.principal)).filter(|r| !r.key.is_empty()) {
            row.insert("key".into(), Value::from(r.key.clone()));
            row.insert("dck".into(), r.dck.clone());
            row.insert("verified".into(), r.verified.clone());
            row.insert("admission".into(), r.admission.clone());
            row.insert("rules".into(), r.rules.clone().map(Value::Object).unwrap_or(Value::Null));
        }
    }

    // ── present organizations joining later (section 3.6) ──

    /// _wa_may_join: the captioner's own rules; a person whose org is not yet present is refused when a seated guest's
    /// rules would refuse that guest with the org added (409 with `guest_conflict`).
    pub(super) fn wa_may_join(&mut self, room: &str, who: &Identity, ext: &Obj) -> R<()> {
        caps(ext)?;
        if who.kind == "captioner" {
            if self.wa.captioner.is_empty() || who.principal != self.wa.captioner {
                return forbidden(pc::CAPTIONER_ONLY);
            }
            if self.stays.get(room).is_some_and(|s| s.captioner_removed) {
                return forbidden(CAPTIONER_REMOVED);
            }
            return Ok(());
        }
        if who.guest || who.is_service() || who.connector || who.console {
            return Ok(());
        }
        let org = self.wa_org_of(&who.principal);
        if org.is_empty() || self.wa_present(room).contains(&org) {
            return Ok(());
        }
        let recording = self.wa_recording(room);
        let mut n = 0;
        for id in self.wa_guest_recs(room, &["admitted", "in"]) {
            let (host_org, verified) = {
                let r = &self.guests.rec[&id];
                (r.host_org.clone(), r.verified.clone())
            };
            let rules = self.wa_rules_for(room, &host_org, &verified, Some(&org));
            if self.wa_refusal(&rules, &verified, false, room, recording).is_some() {
                n += 1;
            }
        }
        if n == 0 {
            return Ok(());
        }
        self.wa.conflicts.insert(room.to_string(), (n, pj::mono()));
        self.guests_lobby_event(room, "");
        log_info(&format!("guest_conflict room={room} principal={} guests={n}", who.principal));
        Err(E::ConflictInfo(CONFLICT.into(), obj([("guest_conflict", Value::from(n))])))
    }

    /// _wa_joined: after a join: seated guests' rules tighten with a new org, and the captioners are assigned again.
    pub(super) fn wa_joined(&mut self, room: &str, peer_id: &str) {
        if !self.peers.get(peer_id).is_some_and(|p| p.who.guest) {
            self.wa_retighten(room);
        }
        self.wa_recaption(room);
    }

    fn wa_retighten(&mut self, room: &str) {
        for id in self.wa_guest_recs(room, &["waiting", "admitted", "in"]) {
            let (host_org, verified, old, guest) = {
                let r = &self.guests.rec[&id];
                (r.host_org.clone(), r.verified.clone(), r.rules.clone(), r.peer.clone())
            };
            let rules = self.wa_rules_for(room, &host_org, &verified, None);
            if old.as_ref() == Some(&rules) {
                continue;
            }
            if let Some(r) = self.guests.rec.get_mut(&id) {
                r.rules = Some(rules.clone());
            }
            let seated = self.peers.contains_key(&guest);
            let ids: Vec<(String, bool)> = self.peers.values().filter(|p| p.room == room && !p.admission_pending).map(|p| (p.peer_id.clone(), p.who.guest)).collect();
            for (p, is_guest) in ids {
                if seated && p == guest {
                    self.push_peer(&p, &obj([("type", Value::from("rules")), ("rules", Value::Object(Self::wa_guest_view(&rules, &host_org)))]));
                } else if !is_guest && seated {
                    self.push_peer(&p, &obj([("type", Value::from("guest_rules")), ("peer", Value::from(guest.clone())), ("rules", Value::Object(rules.clone()))]));
                }
            }
            if seated {
                if let Some(h) = pj::as_int(rules.get("log_hours")) {
                    self.wa_log_cap(room, h);
                }
            }
        }
    }

    // ── log_hours: the stay's captions and call chat, once a guest was seated ──

    pub(super) fn wa_log_cap(&mut self, room: &str, hours: i64) {
        let Some(start) = self.stays.get(room).map(|s| s.start) else { return };
        let caps = self.wa_caps_mut();
        let found = caps.iter_mut().find(|c| c.get("room").and_then(Value::as_str) == Some(room) && pj::as_num(c.get("start")) == Some(start));
        match found {
            None => caps.push(json!({"room": room, "start": f(start), "end": null, "hours": hours})),
            Some(c) if pj::as_int(c.get("hours")).unwrap_or(0) > hours => {
                c["hours"] = Value::from(hours);
            }
            Some(_) => return,
        }
        self.dirty = true;
    }

    pub(super) fn wa_room_empty(&mut self, room: &str) {
        self.wa.conflicts.remove(room);
        let start = self.stays.get(room).map(|s| s.start);
        let now = pj::now();
        let mut changed = false;
        for c in self.wa_caps_mut() {
            if c.get("room").and_then(Value::as_str) == Some(room) && c.get("end").is_none_or(Value::is_null) && start.is_none_or(|s| pj::as_num(c.get("start")) == Some(s)) {
                c["end"] = f(now);
                changed = true;
            }
        }
        self.dirty |= changed;
    }

    /// _wa_tick (every reap): drop the stay lines past their log_hours; forget old challenges and sessions.
    pub(super) fn wa_tick(&mut self, now: f64) {
        let caps = self.wa_caps_mut().clone();
        let mut kept = Vec::new();
        for c in &caps {
            let (room, start, hours) = (pj::s(c.as_object().expect("a cap"), "room"), pj::as_num(c.get("start")).unwrap_or(0.0), pj::as_int(c.get("hours")).unwrap_or(0));
            let end = pj::as_num(c.get("end"));
            let cut = now - hours as f64 * 3600.0;
            if let Some(lines) = self.rooms.get_mut(&room) {
                let last = end.unwrap_or(now);
                let n = lines.len();
                lines.retain(|l| {
                    let ts = pj::num(l, "ts");
                    !(matches!(pj::text_of(l, "kind").as_str(), "chat" | "caption") && start <= ts && ts <= last && ts < cut)
                });
                if lines.len() != n {
                    self.dirty = true;
                }
            }
            if end.is_none_or(|e| e >= cut) {
                kept.push(c.clone());
            }
        }
        if kept.len() != caps.len() {
            *self.wa_caps_mut() = kept;
            self.dirty = true;
        }
        let mono = pj::mono();
        self.wa.challenges.retain(|_, (exp, _)| *exp > mono);
        self.wa.sessions.retain(|_, s| mono - s.seen <= SESSION_IDLE && s.expires > now);
    }

    // ── captions of others (section 5.1) ──

    /// _wa_needs_captioner: None: nobody captions it (it captions itself, or is the captioner); else whether its rules
    /// allow captions.
    fn wa_needs_captioner(&self, p: &Peer) -> Option<bool> {
        if p.who.guest {
            let on = self.guests.rec.get(&guests::guest_id(&p.who.principal)).and_then(|r| rule_of(r, "captions")).and_then(Value::as_str).unwrap_or("on") == "on";
            return Some(on);
        }
        if p.who.kind == "captioner" || p.caps.as_ref().is_none_or(|c| c.iter().any(|x| x == "self_captions")) {
            return None;
        }
        Some(true)
    }

    /// _wa_captioner_ok: the captioner service may caption `target`: no present organization refuses it, and a web
    /// member's own organization allows it.
    fn wa_captioner_ok(&mut self, room: &str, target: &str) -> bool {
        let mut orgs: HashSet<String> = self.wa_present(room).into_iter().collect();
        for id in self.wa_guest_recs(room, &["admitted", "in"]) {
            orgs.insert(self.guests.rec[&id].host_org.clone());
        }
        for o in orgs.into_iter().filter(|o| !o.is_empty()) {
            if self.wa_policy(&o).is_some() && self.wa_guests_key(&o).get("captioner").and_then(Value::as_str).unwrap_or("refuse") == "refuse" {
                return false;
            }
        }
        let Some(t) = self.peers.get(target) else { return true };
        if t.who.kind == "web" {
            let principal = t.who.principal.clone();
            let own = self.wa_org_of(&principal);
            return !own.is_empty() && self.wa_guests_key(&own).get("captioner").and_then(Value::as_str) == Some("allow");
        }
        true
    }

    /// _wa_recaption: assign every seat that needs one a captioner (section 5.1), keeping assignments that still hold;
    /// tell captioners what changed and the room the new map.
    pub(super) fn wa_recaption(&mut self, room: &str) {
        let Some(old) = self.stays.get(room).map(|s| s.captioning.clone()) else { return };
        let mut seats: Vec<&Peer> = self.peers.values().filter(|p| p.room == room && !p.admission_pending).collect();
        seats.sort_by(|a, b| a.joined.partial_cmp(&b.joined).unwrap_or(std::cmp::Ordering::Equal));
        let has_others = |p: &Peer| p.caps.as_ref().is_some_and(|c| c.iter().any(|x| x == "caption_others"));
        let mut people: Vec<String> = seats.iter().filter(|p| !p.who.guest && p.who.kind != "captioner" && has_others(p)).map(|p| p.peer_id.clone()).collect();
        if let Some(host) = self.stage_host(room) {
            if let Some(i) = people.iter().position(|p| *p == host) {
                let h = people.remove(i);
                people.insert(0, h);
            }
        }
        let services: Vec<String> = seats.iter().filter(|p| p.who.kind == "captioner" && has_others(p)).map(|p| p.peer_id.clone()).collect();
        let candidates: Vec<String> = people.iter().chain(services.iter()).cloned().collect();
        let mut load: HashMap<String, i64> = candidates.iter().map(|c| (c.clone(), 0)).collect();
        let most: HashMap<String, i64> = candidates.iter().map(|c| (c.clone(), self.peers[c].cap_max)).collect();
        let targets: Vec<(String, bool)> = seats.iter().filter_map(|p| self.wa_needs_captioner(p).map(|on| (p.peer_id.clone(), on))).collect();
        let is_service = |c: &str, st: &State| st.peers.get(c).is_some_and(|p| p.who.kind == "captioner");
        let mut plan = Obj::new();
        for (t, on) in &targets {
            let c = old.get(t).and_then(Value::as_str).unwrap_or_default().to_string();
            if *on && load.contains_key(&c) && c != *t && load[&c] < most[&c] && (!is_service(&c, self) || self.wa_captioner_ok(room, t)) {
                plan.insert(t.clone(), Value::from(c.clone()));
                *load.get_mut(&c).expect("a candidate") += 1;
            }
        }
        let mut want_service = false;
        for (t, on) in &targets {
            if plan.contains_key(t) {
                continue;
            }
            plan.insert(t.clone(), Value::Null);
            if !*on {
                continue;
            }
            let mut found = None;
            for c in &candidates {
                if c != t && load[c] < most[c] && (!is_service(c, self) || self.wa_captioner_ok(room, t)) {
                    found = Some(c.clone());
                    break;
                }
            }
            match found {
                Some(c) => {
                    plan.insert(t.clone(), Value::from(c.clone()));
                    *load.get_mut(&c).expect("a candidate") += 1;
                }
                None => want_service = want_service || (!self.wa.captioner.is_empty() && services.is_empty() && self.wa_captioner_ok(room, t)),
            }
        }
        let stay = self.stays.get_mut(room).expect("the stay");
        if want_service && !stay.caption_requested && !stay.captioner_removed {
            stay.caption_requested = true;
            let captioner = self.wa.captioner.clone();
            self.tell(&[captioner], &obj([("type", Value::from("caption_request")), ("room", Value::from(room))]), None);
            log_info(&format!("caption_request room={room}"));
        }
        if plan == old {
            return;
        }
        if let Some(stay) = self.stays.get_mut(room) {
            stay.captioning = plan.clone();
        }
        let mut changed: Vec<String> = old.keys().cloned().collect();
        changed.extend(plan.keys().filter(|k| !old.contains_key(*k)).cloned());
        for target in changed {
            let (before, after) = (old.get(&target).cloned().unwrap_or(Value::Null), plan.get(&target).cloned().unwrap_or(Value::Null));
            if before == after {
                continue;
            }
            for (captioner, on) in [(before, false), (after, true)] {
                let c = pj::str_or(Some(&captioner));
                if self.peers.get(&c).is_some_and(|s| s.room == room) {
                    self.push_peer(&c, &obj([("type", Value::from("caption_assign")), ("peer", Value::from(target.clone())), ("on", Value::Bool(on))]));
                }
            }
        }
        self.stage_event(room, "captioning", "", None);
    }

    pub(super) fn wa_left(&mut self, peer: &Peer, why: &str) {
        if peer.who.kind == "captioner" && why == "removed" {
            if let Some(stay) = self.stays.get_mut(&peer.room) {
                stay.captioner_removed = true;
            }
        }
        if self.peers.values().any(|p| p.room == peer.room) {
            self.wa_recaption(&peer.room);
        }
    }

    /// _wa_caption_for: the seat a `for` line captions: only from its assigned captioner (403).
    pub(super) fn wa_caption_for(&self, peer_id: &str, target: &Value) -> R<String> {
        let room = &self.peers[peer_id].room;
        let t = target.as_str().unwrap_or_default();
        let ok = self.peers.get(t).is_some_and(|s| s.room == *room) && self.stays.get(room).and_then(|s| s.captioning.get(t)).and_then(Value::as_str) == Some(peer_id);
        if !ok {
            return forbidden(NOT_CAPTIONING);
        }
        Ok(t.to_string())
    }

    pub(super) fn wa_stage_view(&mut self, room: &str, view: &mut Obj) {
        if let Some(c) = self.stays.get(room).map(|s| s.captioning.clone()).filter(|c| !c.is_empty()) {
            view.insert("captioning".into(), Value::Object(c));
        }
        let host = self.stage_host(room).and_then(|h| self.peers.get(&h)).map(|p| p.who.principal.clone()).unwrap_or_default();
        let org = self.wa_org_of(&host);
        let cap = self.wa_link_cap(room, &org);
        if cap < LINK_MAX {
            view.insert("guest_link_max_minutes".into(), Value::from(cap));
        }
    }

    /// _wa_host_view: what only hosts see: how many people a guest kept out (section 3.6), for 60 s.
    pub(super) fn wa_host_view(&self, room: &str, view: &mut Obj) {
        if let Some((n, at)) = self.wa.conflicts.get(room) {
            if pj::mono() - at < CONFLICT_SHOW {
                view.insert("guest_conflicts".into(), Value::from(*n));
            }
        }
    }

    pub(super) fn wa_join_extra(&self, room: &str) -> Obj {
        obj([("stay", Value::from(self.wa_stay_id(room)))])
    }

    /// _wa_stay_id: the stay an admission binds (4.2): the call chat's stay (in a large call its E2EE stay).
    pub(super) fn wa_stay_id(&self, room: &str) -> String {
        self.stays.get(room).map(|s| s.chat_stay.clone()).unwrap_or_default()
    }

    pub(super) fn wa_drop_serials(&mut self, serials: &HashSet<String>) {
        self.wa.sessions.retain(|_, s| !serials.contains(&m::serial(&s.who.serial)));
    }

}

/// _ce_int: a JSON whole number from 1 to 2**53-1.
fn ce_int(v: Option<&Value>, what: &str) -> R<i64> {
    const MAX: i64 = (1 << 53) - 1;
    match pj::as_int(v) {
        Some(n) if (1..=MAX).contains(&n) => Ok(n),
        _ => bad(format!("{what} must be a whole number from 1 to {MAX}")),
    }
}

/// The view of a checked verification a guest gets back.
pub(super) fn verified_view(v: &Obj) -> Value {
    Value::Object(VERIFIED_VIEW.iter().map(|k| (k.to_string(), v.get(*k).cloned().unwrap_or(Value::Null))).collect())
}

/// What a knock checks of the page (section 2.6): its key, its proof over this link and its chat bundle; the guest id
/// and the key's SHA-256.
pub(super) fn knock_page(body: &Obj, room: &str, nonce: &str) -> R<(String, String, String)> {
    let spki = guest_key(body.get("key"))?;
    let key = pj::s(body, "key");
    let key_sha = op::key_sha256(&spki);
    let pop_ts = match body.get("pop_ts") {
        Some(v) if pj::as_int(Some(v)).is_some() && pj::truthy(body.get("pop")) => pj::as_int(Some(v)).unwrap_or(0),
        _ => return bad(RELOAD),
    };
    if (pj::now() * 1000.0 - pop_ts as f64).abs() > CLOCK_MS {
        return bad(CLOCK);
    }
    let data = lp(&[b"lucid-meet-guest-knock-v1", room.as_bytes(), nonce.as_bytes(), key_sha.as_bytes(), &u64b(pop_ts)]);
    if !sig_ok(&spki, &data, body.get("pop")) {
        return forbidden(NOT_YOURS);
    }
    let gid = State::wa_bundle(body.get("dck"), &key, &spki, &key_sha)?;
    Ok((gid, key, key_sha))
}

// ── the web port's sessions (section 7.3) ──────────────────────────────────────────────────────────────────

impl Hub {
    /// `GET /w/v1/config` (no session) -> `{sso, orgs}`.
    pub fn wa_web_config(&self) -> Obj {
        self.st.lock().wa.web_config.clone()
    }

    /// `POST /w/v1/session/challenge {}` -> `{challenge}` (60 s, one use).
    pub fn wa_challenge(&self, address: &str) -> R<Obj> {
        let mut st = self.st.lock();
        st.guests.limit("webchal", &guests::addr_key(address), 30, BUSY)?;
        if st.wa.challenges.len() >= CHALLENGES_MAX {
            return Err(E::Busy(SIGN_INS_BUSY.into(), 60));
        }
        let challenge = pj::b64(&pj::random_bytes(32));
        st.wa.challenges.insert(challenge.clone(), (pj::mono() + CHALLENGE_TTL, false));
        Ok(obj([("challenge", Value::from(challenge))]))
    }

    /// `POST /w/v1/session {cert, chain, challenge, ts, sig}` -> `{session, expires}`: the mutual TLS checks on a web
    /// device certificate, and its key's signature over the one-use challenge.
    pub fn wa_session_open(&self, body: &Obj, address: &str) -> R<Obj> {
        let challenge = body.get("challenge").and_then(Value::as_str).unwrap_or_default().to_string();
        {
            let mut st = self.st.lock();
            st.guests.limit("websess", &guests::addr_key(address), 12, BUSY)?;
            let Some(entry) = st.wa.challenges.get_mut(&challenge).filter(|e| e.0 > pj::mono()) else { return forbidden(CHALLENGE_OLD) };
            if entry.1 {
                return forbidden(CHALLENGE_USED);
            }
            entry.1 = true;
        }
        let Some(ts) = pj::as_int(body.get("ts")) else { return bad("ts must be the page's clock (ms)") };
        if (pj::now() * 1000.0 - ts as f64).abs() > CLOCK_MS {
            return bad(CLOCK);
        }
        let pem_bad = "cert and chain must be PEM";
        let cert_pem = match body.get("cert") {
            Some(Value::String(c)) if (1..=PEM_MAX).contains(&c.chars().count()) => c.clone(),
            _ => return bad(pem_bad),
        };
        let chain_pem = match body.get("chain") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(c)) if c.chars().count() <= CHAIN_MAX => c.clone(),
            Some(v) if !pj::truthy(Some(v)) => String::new(),
            _ => return bad(pem_bad),
        };
        let Some((_, der)) = pem_blocks(cert_pem.as_bytes(), "CERTIFICATE").into_iter().next() else { return bad(pem_bad) };
        let Some(cert) = Cert::from_der(&der) else { return bad(pem_bad) };
        let chain: Option<Vec<Cert>> = pem_blocks(chain_pem.as_bytes(), "CERTIFICATE").iter().map(|(_, d)| Cert::from_der(d)).collect();
        let Some(chain) = chain else { return bad(pem_bad) };
        let mut who = m::identity_from_cert(Some(&der))?;
        if who.kind != "web" || !who.own_device() {
            return forbidden(NOT_WEB);
        }
        let host = {
            let mut st = self.st.lock();
            if !st.wa_chain_ok(&cert, &chain) {
                return forbidden(if st.wa_revoked(&cert) { REVOKED } else { "this certificate is not one of this relay's" });
            }
            st.wa.web_host.clone()
        };
        let data = lp(&[b"lucid-meet-web-session-v1", host.as_bytes(), challenge.as_bytes(), &u64b(ts)]);
        if !sig_ok(&cert.spki, &data, body.get("sig")) {
            return forbidden(NOT_YOURS);
        }
        who.cert_pem = der_to_pem(&der);
        let token = crate::codec::b64u(&pj::random_bytes(32));
        let expires = (cert.not_after as f64).min(pj::now() + SESSION_MAX);
        let mut st = self.st.lock();
        if st.wa.sessions.len() >= SESSIONS_MAX {
            return Err(E::Busy(SIGN_INS_BUSY.into(), 60));
        }
        log_info(&format!("web_session principal={} device={}", who.principal, who.device));
        st.wa.sessions.insert(crate::codec::sha256_hex(token.as_bytes()), WebSession { who, cert, chain, expires, seen: pj::mono() });
        Ok(obj([("session", Value::from(token)), ("expires", Value::from(expires as i64))]))
    }

    /// The identity of `Authorization: LucidWeb <session>` (Err: the 401 words); its certificate is checked against
    /// the deny list and the CRLs on every request.
    pub fn wa_session(&self, header: &str) -> Result<Identity, String> {
        let h = header.trim();
        let (scheme, token) = h.split_once(' ').unwrap_or((h, ""));
        if scheme != "LucidWeb" || token.is_empty() || token.chars().count() > 100 {
            return Err(SIGN_IN.into());
        }
        let digest = crate::codec::sha256_hex(token.trim().as_bytes());
        let mut st = self.st.lock();
        let mono = pj::mono();
        let Some(s) = st.wa.sessions.get(&digest).filter(|s| mono - s.seen <= SESSION_IDLE && s.expires > pj::now()) else {
            st.wa.sessions.remove(&digest);
            return Err(SIGN_IN.into());
        };
        let (cert, chain) = (s.cert.clone(), s.chain.clone());
        if st.wa_revoked(&cert) || chain.iter().any(|c| st.wa_revoked(c)) {
            st.wa.sessions.remove(&digest);
            return Err(REVOKED.into());
        }
        let s = st.wa.sessions.get_mut(&digest).expect("a session");
        s.seen = mono;
        Ok(s.who.clone())
    }

    /// True when the caller's seat `peer_id` is its call's host (a web seat's lobby actions, 7.4).
    pub fn wa_seat_hosts(&self, peer_id: &str, who: &Identity) -> bool {
        let st = self.st.lock();
        st.peers.get(peer_id).is_some_and(|p| p.who.principal == who.principal && st.stage_host(&p.room).as_deref() == Some(peer_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_resolve_most_restrictive_with_by() {
        let sources: Sources = vec![("relay".into(), vec![json!({"match": ["*"], "ai": "local"})]), ("gov-baseline".into(), vec![gov_baseline()]), ("org:meet".into(), vec![json!({"match": ["*"], "chat": "e2ee", "link_max_minutes": 120}), json!({"match": ["verified"], "lobby": "verified_bypass"})])];
        let r = resolve(&sources, "unverified", "", false);
        assert_eq!(r["ai"], "local");
        assert_eq!(r["chat"], "e2ee");
        assert_eq!(r["link_max_minutes"], 120);
        assert_eq!(r["lobby"], "always");
        assert_eq!(r["by"], json!({"ai": "relay", "chat": "org:meet", "link_max_minutes": "org:meet"}));
        let g = resolve(&sources, "us-gov", "agency.gov", false);
        assert_eq!(g["verify"], json!(["sso_phr", "piv"]));
        assert_eq!(g["log_hours"], 24);
        let v = resolve(&sources, "verified", "x.example", false);
        assert_eq!(v["lobby"], "verified_bypass");
        assert_eq!(resolve(&vec![("relay".into(), vec![json!({"match": ["x.example"], "allow": false})])], "verified", "a.x.example", false)["allow"], false);
    }

    #[test]
    fn caps_and_origins() {
        let o = |v: Value| v.as_object().cloned().unwrap();
        assert_eq!(caps(&o(json!({}))).unwrap(), (None, 4));
        assert!(caps(&o(json!({"caps": ["sing"]}))).is_err());
        assert!(caps(&o(json!({"caption_others_max": 9}))).is_err());
        assert_eq!(https_origin("https://127.0.0.1:8443/"), Some(("127.0.0.1:8443".into(), "127.0.0.1".into())));
        assert!(https_origin("http://x").is_none() && https_origin("https://x/p").is_none());
        assert!(page_csp("http://127.0.0.1:7880", "https://sso.example.test").contains("connect-src 'self' http://127.0.0.1:7880 https://sso.example.test;"));
    }
}
