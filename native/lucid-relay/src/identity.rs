// Node identity as the relay checks it, rule for rule from the add-on's src/identity.ts (and presencePublicKey from
// src/presence.ts): the compact signed token, the node certificate (root-signed, or delegate-signed carrying its
// root-signed delegation), the CRL (newer only, nextUpdate kept once seen) and the relay directory. Every reason
// string is the one the Bun relay logs.

use crate::codec::{as_object, exact_keys, is_int, num_is, parse_json, sha256_hex, str_of, unb64u, utf16_len, utf8_lossy};
use crate::der::{ecdsa_verify, p256_from_spki, p256_spki_der, parse_spki, PublicKey};
use p256::ecdsa::VerifyingKey;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const ROLES: [&str; 2] = ["hub", "spoke"];
pub const SCOPES: [&str; 3] = ["recall", "drive", "approve"];
pub const CLASSIFICATIONS: [&str; 3] = ["private", "shareable", "cui"];
pub const DELEGATE_POWERS: [&str; 4] = ["users", "spokes", "custody", "enroll"];
const PRESENCE_KINDS: [&str; 3] = ["password", "windows-hello", "macos-secure-enclave"];
const CLOCK_SKEW_SEC: i64 = 120;
const MAX_DELEGATED_CERT_DAYS: i64 = 30;
const MAX_DELEGATION_DAYS: i64 = 90;
const ENROLL_MAX_CERT_DAYS: i64 = 7;
const MAX_ENROLL_DELEGATION_DAYS: i64 = 30;
const MAX_DIRECTORY_TOKEN: usize = 64 * 1024;
const MAX_DIRECTORY_RELAYS: usize = 32;
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
const CERT_KEYS: [&str; 17] = [
    "v", "typ", "serial", "root", "node", "role", "label", "spki", "scopes", "iat", "exp", "user", "classification", "region", "issuer", "delegation", "presence",
];

// ── The patterns identity.ts checks with regular expressions ─────────────────────────────────────────────────

fn is_hex_lower(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// /^n_[0-9a-f]{32}$/
pub fn is_node_id(s: &str) -> bool {
    s.len() == 34 && s.starts_with("n_") && is_hex_lower(&s[2..])
}

/// /^[0-9a-f]{32}$/
pub fn is_serial(s: &str) -> bool {
    s.len() == 32 && is_hex_lower(s)
}

/// /^[\x20-\x7e]{1,64}$/
pub fn is_label(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| (0x20..=0x7e).contains(&c))
}

/// /^[a-z0-9][a-z0-9-]{0,31}$/
pub fn is_region(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// One DNS label of DOMAIN_RE: [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?
fn is_domain_label(l: &str) -> bool {
    let b = l.as_bytes();
    let edge = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (1..=63).contains(&b.len()) && edge(&b[0]) && edge(&b[b.len() - 1]) && b.iter().all(|c| edge(c) || *c == b'-')
}

/// DOMAIN_RE: 1 to 190 characters, two or more labels.
pub fn is_domain(s: &str) -> bool {
    (1..=190).contains(&s.len()) && s.split('.').count() >= 2 && s.split('.').all(is_domain_label)
}

/// EMAIL_RE: a plain lower-case local part (1 to 64 of [a-z0-9._%+-]) and a DOMAIN_RE domain.
pub fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    (1..=64).contains(&local.len()) && local.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._%+-".contains(&c)) && is_domain(domain)
}

/// /^[A-Za-z0-9_-]{43}$/
pub fn is_spki_pin(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `n_` and the first 32 hex of sha256 of the public key bytes.
pub fn node_id_of(spki: &[u8]) -> String {
    format!("n_{}", &sha256_hex(spki)[..32])
}

/// `u_` and the first 32 hex of sha256(lower-cased, trimmed email).
pub fn user_id_of(email: &str) -> String {
    format!("u_{}", &sha256_hex(crate::codec::js_trim(email).to_lowercase().as_bytes())[..32])
}

// ── The compact signed token ─────────────────────────────────────────────────────────────────────────────────

/// Verify a compact token and return its payload object, or None. Signature first, parse second.
pub fn open_compact(token: Option<&Value>, key: &VerifyingKey, max_len: usize) -> Option<Map<String, Value>> {
    let token = token?.as_str()?;
    if utf16_len(token) > max_len {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return None;
    }
    let (body, sig) = (unb64u(parts[0])?, unb64u(parts[1])?);
    if sig.is_empty() || !ecdsa_verify(key, &body, &sig) {
        return None;
    }
    match parse_json(&utf8_lossy(&body))? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

/// The payload of a compact token WITHOUT verifying it.
pub fn peek_compact(token: &str) -> Option<Map<String, Value>> {
    let body = unb64u(token.split('.').next().unwrap_or(""))?;
    match parse_json(&utf8_lossy(&body))? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

/// A P-256 key from base64url SPKI (identity.ts importPublicSpki).
pub fn import_public_spki(spki_b64u: &str) -> Option<VerifyingKey> {
    p256_from_spki(&unb64u(spki_b64u)?)
}

// ── Certificates ─────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct UserClaim {
    pub id: String,
    pub email: String,
    pub clearances: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct NodeCert {
    pub serial: String,
    pub node: String,
    pub role: String,
    pub label: String,
    pub scopes: Vec<String>,
    pub iat: i64,
    pub exp: i64,
    pub user: Option<UserClaim>,
    pub classification: Option<String>,
    pub region: Option<String>,
}

#[derive(Clone, Debug)]
struct Limits {
    max_days: i64,
    roles: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    label_prefix: Option<String>,
    email_domains: Option<Vec<String>>,
    users: Option<Vec<String>>,
    classifications: Option<Vec<String>>,
    regions: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
struct Delegation {
    serial: String,
    id: String,
    may: Vec<String>,
    limits: Limits,
    iat: i64,
    exp: i64,
}

fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    v?.as_array()?.iter().map(|s| s.as_str().map(str::to_owned)).collect()
}

fn distinct(list: &[String]) -> bool {
    list.iter().collect::<HashSet<_>>().len() == list.len()
}

fn user_problem(v: &Value) -> Option<String> {
    let Some(u) = as_object(v).filter(|u| exact_keys(u, &["id", "email", "name", "clearances"], &["id", "email"])) else {
        return Some("a user claim is { id, email, name?, clearances? }".into());
    };
    let Some(email) = str_of(u.get("email")).filter(|e| is_email(e)) else { return Some("user email must be one lower-case address".into()) };
    if str_of(u.get("id")) != Some(user_id_of(email).as_str()) {
        return Some("user id must be u_ and the first 32 hex of sha256(email)".into());
    }
    if let Some(name) = u.get("name") {
        if !name.as_str().is_some_and(is_label) {
            return Some("user name must be 1 to 64 printable ASCII characters".into());
        }
    }
    if let Some(c) = u.get("clearances") {
        let ok = strings(Some(c)).is_some_and(|l| !l.is_empty() && distinct(&l) && l.iter().all(|x| CLASSIFICATIONS.contains(&x.as_str())));
        if !ok {
            return Some(format!("clearances must be a list of distinct values from {}", CLASSIFICATIONS.join(", ")));
        }
    }
    None
}

fn user_claim(v: &Value) -> Option<UserClaim> {
    let u = v.as_object()?;
    Some(UserClaim { id: str_of(u.get("id"))?.into(), email: str_of(u.get("email"))?.into(), clearances: strings(u.get("clearances")) })
}

/// presence.ts presencePublicKey, as a yes or no.
fn presence_ok(v: &Value) -> bool {
    let Some(o) = as_object(v).filter(|o| exact_keys(o, &["kind", "spki"], &["kind", "spki"])) else { return false };
    let Some(kind) = str_of(o.get("kind")).filter(|k| PRESENCE_KINDS.contains(k)) else { return false };
    let Some(spki) = str_of(o.get("spki")) else { return false };
    if !(40..=1200).contains(&spki.len()) || !spki.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return false;
    }
    match (kind, unb64u(spki).as_deref().and_then(parse_spki)) {
        ("windows-hello", Some(PublicKey::Rsa { bits })) => bits >= 2048,
        ("windows-hello", _) => false,
        (_, Some(PublicKey::P256(_))) => true,
        _ => false,
    }
}

const LIMIT_LISTS: [&str; 6] = ["roles", "scopes", "emailDomains", "users", "regions", "classifications"];

fn limit_value_ok(list: &str, s: &str) -> bool {
    match list {
        "roles" => ROLES.contains(&s),
        "scopes" => SCOPES.contains(&s),
        "emailDomains" => is_domain(s),
        "users" => is_email(s),
        "regions" => is_region(s),
        _ => CLASSIFICATIONS.contains(&s),
    }
}

fn limits_problem(v: Option<&Value>) -> Option<String> {
    let mut allowed = vec!["maxDays", "labelPrefix"];
    allowed.extend(LIMIT_LISTS);
    let Some(l) = v.and_then(as_object).filter(|l| exact_keys(l, &allowed, &["maxDays"])) else {
        return Some("limits are { maxDays, roles?, scopes?, labelPrefix?, emailDomains?, users?, regions?, classifications? }".into());
    };
    if !is_int(l.get("maxDays")).is_some_and(|d| (1..=MAX_DELEGATED_CERT_DAYS).contains(&d)) {
        return Some(format!("limits.maxDays must be 1 to {MAX_DELEGATED_CERT_DAYS}"));
    }
    for name in LIMIT_LISTS {
        let Some(list) = l.get(name) else { continue };
        let ok = strings(Some(list)).is_some_and(|s| !s.is_empty() && s.len() <= 32 && distinct(&s) && s.iter().all(|x| limit_value_ok(name, x)));
        if !ok {
            return Some(format!("limits.{name} must be a non-empty list of distinct valid values"));
        }
    }
    if let Some(p) = l.get("labelPrefix") {
        if !p.as_str().is_some_and(|p| utf16_len(p) <= 32 && is_label(p)) {
            return Some("limits.labelPrefix must be 1 to 32 printable ASCII characters".into());
        }
    }
    None
}

fn powers_problem(may: Option<&Value>, limits: &Map<String, Value>) -> Option<String> {
    let list = strings(may).filter(|m| !m.is_empty() && distinct(m) && m.iter().all(|x| DELEGATE_POWERS.contains(&x.as_str())));
    let Some(may) = list else { return Some(format!("may must be a non-empty list from {}", DELEGATE_POWERS.join(", "))) };
    let enroll = may.iter().any(|m| m == "enroll");
    let roles = strings(limits.get("roles")).unwrap_or_default();
    if enroll && (may.iter().any(|m| m == "users") || limits.contains_key("scopes") || roles.iter().any(|r| r != "spoke")) {
        return Some("a delegation with the enroll power certifies spokes only: no users power, no scopes, roles only spoke".into());
    }
    let max_days = is_int(limits.get("maxDays")).unwrap_or(0);
    if enroll && (!limits.contains_key("labelPrefix") || max_days > ENROLL_MAX_CERT_DAYS) {
        return Some(format!("a delegation with the enroll power needs a labelPrefix and maxDays of at most {ENROLL_MAX_CERT_DAYS}"));
    }
    None
}

fn delegation_problem(p: &Map<String, Value>, root_id: &str) -> Option<String> {
    let keys = ["v", "typ", "root", "serial", "id", "label", "spki", "may", "limits", "iat", "exp"];
    if !exact_keys(p, &keys, &keys) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-delegation") || str_of(p.get("root")) != Some(root_id) {
        return Some("wrong fields, type or root".into());
    }
    if !str_of(p.get("serial")).is_some_and(is_serial) || !str_of(p.get("id")).is_some_and(is_node_id) || !str_of(p.get("label")).is_some_and(is_label) || str_of(p.get("spki")).is_none() {
        return Some("bad serial, id, label or key".into());
    }
    let (iat, exp) = (is_int(p.get("iat")), is_int(p.get("exp")));
    let (Some(iat), Some(exp)) = (iat, exp) else { return Some(format!("a delegation lasts at most {MAX_DELEGATION_DAYS} days")) };
    if exp <= iat || exp - iat > MAX_DELEGATION_DAYS * 86_400 {
        return Some(format!("a delegation lasts at most {MAX_DELEGATION_DAYS} days"));
    }
    if let Some(problem) = limits_problem(p.get("limits")) {
        return Some(problem);
    }
    let limits = p.get("limits").and_then(Value::as_object)?;
    if let Some(problem) = powers_problem(p.get("may"), limits) {
        return Some(problem);
    }
    let enroll = strings(p.get("may")).unwrap_or_default().iter().any(|m| m == "enroll");
    if enroll && exp - iat > MAX_ENROLL_DELEGATION_DAYS * 86_400 {
        return Some(format!("a delegation with the enroll power lasts at most {MAX_ENROLL_DELEGATION_DAYS} days"));
    }
    None
}

fn delegation_of(p: &Map<String, Value>) -> Option<Delegation> {
    let l = p.get("limits")?.as_object()?;
    Some(Delegation {
        serial: str_of(p.get("serial"))?.into(),
        id: str_of(p.get("id"))?.into(),
        may: strings(p.get("may"))?,
        limits: Limits {
            max_days: is_int(l.get("maxDays"))?,
            roles: strings(l.get("roles")),
            scopes: strings(l.get("scopes")),
            label_prefix: str_of(l.get("labelPrefix")).map(str::to_owned),
            email_domains: strings(l.get("emailDomains")),
            users: strings(l.get("users")),
            classifications: strings(l.get("classifications")),
            regions: strings(l.get("regions")),
        },
        iat: is_int(p.get("iat"))?,
        exp: is_int(p.get("exp"))?,
    })
}

fn spoke_outside_delegation(d: &Delegation, c: &NodeCert) -> Option<String> {
    let l = &d.limits;
    if let Some(prefix) = &l.label_prefix {
        if !c.label.starts_with(prefix.as_str()) {
            return Some(format!("spoke labels must start with \"{prefix}\""));
        }
    }
    if let Some(regions) = &l.regions {
        if !c.region.as_ref().is_some_and(|r| regions.contains(r)) {
            return Some(format!("spokes must be in {}", regions.join(", ")));
        }
    }
    if let Some(cls) = &l.classifications {
        if !c.classification.as_ref().is_some_and(|x| cls.contains(x)) {
            return Some(format!("spokes must be classified {}", cls.join(" or ")));
        }
    }
    None
}

fn leaf_problem(d: &Delegation, c: &NodeCert) -> Option<String> {
    let l = &d.limits;
    let may = |p: &str| d.may.iter().any(|m| m == p);
    if c.role == "hub" && !may("users") {
        return Some("this delegation may not certify hubs (no users power)".into());
    }
    if c.role == "spoke" && !may("spokes") && !may("enroll") {
        return Some("this delegation may not certify spokes".into());
    }
    if let Some(roles) = &l.roles {
        if !roles.contains(&c.role) {
            return Some(format!("this delegation certifies only {}", roles.join(", ")));
        }
    }
    if let Some(allowed) = &l.scopes {
        let extra: Vec<&str> = c.scopes.iter().filter(|s| !allowed.contains(s)).map(String::as_str).collect();
        if !extra.is_empty() {
            return Some(format!("scope {} is outside this delegation", extra.join(", ")));
        }
    }
    if c.exp - c.iat > l.max_days * 86_400 {
        return Some(format!("a delegated certificate lasts at most {} days", l.max_days));
    }
    if c.iat + CLOCK_SKEW_SEC < d.iat || c.exp > d.exp {
        return Some("a delegated certificate must sit inside its delegation's lifetime".into());
    }
    if let Some(prefix) = &l.label_prefix {
        if !c.label.starts_with(prefix.as_str()) {
            return Some(format!("labels must start with \"{prefix}\""));
        }
    }
    if c.role == "hub" && c.user.is_none() {
        return Some("a delegated hub certificate must name its user".into());
    }
    if let Some(u) = &c.user {
        let domain = &u.email[u.email.rfind('@').map_or(0, |i| i + 1)..];
        if let Some(domains) = &l.email_domains {
            if !domains.iter().any(|x| x == domain) {
                return Some(format!("user {} is outside {}", u.email, domains.join(", ")));
            }
        }
        if let Some(users) = &l.users {
            if !users.contains(&u.email) {
                return Some(format!("user {} is outside this delegation's users", u.email));
            }
        }
        if let (Some(cleared), Some(cl)) = (&l.classifications, &u.clearances) {
            let over: Vec<&str> = cl.iter().filter(|x| !cleared.contains(x)).map(String::as_str).collect();
            if !over.is_empty() {
                return Some(format!("clearance {} is outside this delegation", over.join(", ")));
            }
        }
    }
    if c.role == "spoke" {
        spoke_outside_delegation(d, c)
    } else {
        None
    }
}

/// A verified certificate and its public key.
pub struct CertOk {
    pub cert: NodeCert,
    pub key: VerifyingKey,
}

/// The CRL fields the store keeps.
struct HeldCrl {
    version: i64,
    next_update: Option<i64>,
}

/// The root public key and the newest CRL seen.
pub struct TrustStore {
    root: VerifyingKey,
    pub root_id: String,
    crl: Option<HeldCrl>,
    crl_token: Option<String>,
    revoked: HashSet<String>,
}

impl TrustStore {
    pub fn new(root: VerifyingKey) -> TrustStore {
        let root_id = node_id_of(&p256_spki_der(&root));
        TrustStore { root, root_id, crl: None, crl_token: None, revoked: HashSet::new() }
    }

    pub fn root_key(&self) -> &VerifyingKey {
        &self.root
    }

    pub fn crl_version(&self) -> i64 {
        self.crl.as_ref().map_or(0, |c| c.version)
    }

    pub fn crl_token(&self) -> Option<&str> {
        self.crl_token.as_deref()
    }

    pub fn is_revoked(&self, serial: &str) -> bool {
        self.revoked.contains(serial)
    }

    /// Take a CRL only if the root signed it and it is NEWER than the one held; once a held list carries a
    /// nextUpdate, a newer one without it is refused. Ok(changed) or Err(reason).
    pub fn accept_crl(&mut self, token: &str) -> Result<bool, String> {
        let tv = Value::String(token.to_owned());
        let Some(p) = open_compact(Some(&tv), &self.root, 8192) else { return Err("CRL is not signed by this root".into()) };
        let malformed = || Err("malformed CRL".to_string());
        if !exact_keys(&p, &["v", "typ", "root", "version", "serials", "iat", "nextUpdate"], &["v", "typ", "root", "version", "serials", "iat"])
            || !num_is(p.get("v"), 1.0)
            || str_of(p.get("typ")) != Some("lucid-crl")
            || str_of(p.get("root")) != Some(self.root_id.as_str())
        {
            return malformed();
        }
        let (Some(version), Some(iat)) = (is_int(p.get("version")), is_int(p.get("iat"))) else { return malformed() };
        let Some(serials) = strings(p.get("serials")).filter(|s| s.iter().all(|x| is_serial(x))) else { return malformed() };
        let next_update = match p.get("nextUpdate") {
            None => None,
            Some(v) => match is_int(Some(v)) {
                Some(n) if n > iat => Some(n),
                _ => return malformed(),
            },
        };
        let held = self.crl_version();
        if version < held {
            return Err(format!("CRL version {version} is older than {held}"));
        }
        if version == held {
            return Ok(false);
        }
        if next_update.is_none() && self.crl.as_ref().is_some_and(|c| c.next_update.is_some()) {
            return Err(format!("CRL version {version} has no nextUpdate, and this node already holds one that expires"));
        }
        self.crl = Some(HeldCrl { version, next_update });
        self.crl_token = Some(token.to_owned());
        self.revoked = serials.into_iter().collect();
        Ok(true)
    }

    fn verify_delegation(&self, token: Option<&Value>, now: i64) -> Result<(Delegation, VerifyingKey), String> {
        let Some(p) = open_compact(token, &self.root, 8192) else { return Err("delegation is not signed by this root".into()) };
        if let Some(problem) = delegation_problem(&p, &self.root_id) {
            return Err(format!("malformed delegation: {problem}"));
        }
        let d = delegation_of(&p).ok_or("malformed delegation: wrong fields, type or root")?;
        if d.iat > now + CLOCK_SKEW_SEC {
            return Err("delegation is not valid yet".into());
        }
        if d.exp <= now {
            return Err("delegation expired".into());
        }
        if self.revoked.contains(&d.serial) {
            return Err("delegation revoked".into());
        }
        let spki = str_of(p.get("spki")).unwrap_or("");
        match import_public_spki(spki) {
            Some(k) if node_id_of(&unb64u(spki).unwrap_or_default()) == d.id => Ok((d, k)),
            _ => Err("delegation key does not match its id".into()),
        }
    }

    /// A certificate is good only when this root (or a delegation this root signed) signed it, it is in date, its
    /// key hashes to its node id, and its serial is not revoked.
    pub fn verify_cert(&self, token: Option<&Value>, now: i64) -> Result<CertOk, String> {
        let malformed = || Err("malformed certificate".to_string());
        let mut del = None;
        let p = match open_compact(token, &self.root, 8192) {
            Some(p) => {
                if p.contains_key("issuer") || p.contains_key("delegation") {
                    return malformed();
                }
                p
            }
            None => {
                let peek = token.and_then(Value::as_str).and_then(peek_compact);
                let Some(peek) = peek.filter(|p| p.get("issuer").is_some_and(Value::is_string) && p.get("delegation").is_some_and(Value::is_string)) else {
                    return Err("certificate is not signed by this root".into());
                };
                let (d, key) = self.verify_delegation(peek.get("delegation"), now).map_err(|r| format!("certificate issuer: {r}"))?;
                let Some(p) = open_compact(token, &key, 8192) else { return Err("certificate is not signed by its delegation's key".into()) };
                if str_of(p.get("issuer")) != Some(d.id.as_str()) {
                    return Err("certificate names another issuer than its delegation".into());
                }
                del = Some(d);
                p
            }
        };
        if !exact_keys(&p, &CERT_KEYS, &CERT_KEYS[..11]) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-node-cert") {
            return malformed();
        }
        if str_of(p.get("root")) != Some(self.root_id.as_str()) || !str_of(p.get("serial")).is_some_and(is_serial) || !str_of(p.get("node")).is_some_and(is_node_id) {
            return malformed();
        }
        let role = str_of(p.get("role")).filter(|r| ROLES.contains(r));
        let label = str_of(p.get("label")).filter(|l| is_label(l));
        let (Some(role), Some(label), Some(iat), Some(exp)) = (role, label, is_int(p.get("iat")), is_int(p.get("exp"))) else { return malformed() };
        let Some(scopes) = strings(p.get("scopes")).filter(|s| s.iter().all(|x| SCOPES.contains(&x.as_str()))) else { return malformed() };
        if let Some(u) = p.get("user") {
            if role != "hub" || user_problem(u).is_some() {
                return malformed();
            }
        }
        if (p.contains_key("classification") || p.contains_key("region")) && role != "spoke" {
            return malformed();
        }
        if let Some(c) = p.get("classification") {
            if !c.as_str().is_some_and(|c| CLASSIFICATIONS.contains(&c)) {
                return malformed();
            }
        }
        if let Some(r) = p.get("region") {
            if !r.as_str().is_some_and(is_region) {
                return malformed();
            }
        }
        if let Some(pr) = p.get("presence") {
            if role != "hub" || !presence_ok(pr) {
                return malformed();
            }
        }
        if iat > now + CLOCK_SKEW_SEC {
            return Err("certificate is not valid yet".into());
        }
        if exp <= now {
            return Err("certificate expired".into());
        }
        let serial = str_of(p.get("serial")).unwrap_or_default().to_owned();
        if self.revoked.contains(&serial) {
            return Err("certificate revoked".into());
        }
        let node = str_of(p.get("node")).unwrap_or_default().to_owned();
        let spki = str_of(p.get("spki"));
        let key = spki.and_then(import_public_spki);
        let Some(key) = key.filter(|_| node_id_of(&unb64u(spki.unwrap_or("")).unwrap_or_default()) == node) else {
            return Err("certificate key does not match its node id".into());
        };
        let cert = NodeCert {
            serial,
            node,
            role: role.into(),
            label: label.into(),
            scopes,
            iat,
            exp,
            user: p.get("user").and_then(user_claim),
            classification: str_of(p.get("classification")).map(str::to_owned),
            region: str_of(p.get("region")).map(str::to_owned),
        };
        if let Some(d) = &del {
            if let Some(outside) = leaf_problem(d, &cert) {
                return Err(format!("certificate is outside its delegation: {outside}"));
            }
        }
        Ok(CertOk { cert, key })
    }
}

// ── The relay directory ──────────────────────────────────────────────────────────────────────────────────────

/// Whether a URL string is exactly its own origin, as `new URL(url).origin === url` decides it: a scheme, a
/// canonical host and a port that is not the scheme's default, nothing else.
fn origin_only(url: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (host, port) = if rest.starts_with('[') {
        let end = rest.find(']')?;
        let after = &rest[end + 1..];
        (&rest[..=end], if after.is_empty() { None } else { Some(after.strip_prefix(':')?) })
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        }
    };
    if let Some(p) = port {
        let default = if scheme == "https" { "443" } else { "80" };
        if p.is_empty() || p == default || !p.bytes().all(|c| c.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) || p.parse::<u32>().ok()? > 65_535 {
            return None;
        }
    }
    if host.is_empty() {
        return None;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        let ip: std::net::Ipv6Addr = inner.parse().ok()?;
        return (crate::server::whatwg_ipv6(&ip) == inner).then_some((scheme, host));
    }
    // Only characters a canonical WHATWG host keeps: lower-case ASCII, no forbidden host code points.
    if !host.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-._~!$&'()*+,;=".contains(&c)) {
        return None;
    }
    // A host ending in a number is an IPv4 address and must be written as WHATWG serializes one.
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    let numeric = !last.is_empty() && (last.bytes().all(|c| c.is_ascii_digit()) || last.starts_with("0x"));
    if numeric {
        let ip: std::net::Ipv4Addr = host.parse().ok()?;
        return (ip.to_string() == host).then_some((scheme, host));
    }
    Some((scheme, host))
}

fn relay_entry_ok(v: &Value) -> bool {
    let Some(e) = as_object(v).filter(|e| exact_keys(e, &["url", "region", "priority", "ca", "spki"], &["url", "region", "priority"])) else { return false };
    let Some(url) = str_of(e.get("url")) else { return false };
    let Some((scheme, host)) = origin_only(url) else { return false };
    if scheme == "http" && !LOOPBACK_HOSTS.contains(&host) {
        return false;
    }
    if !str_of(e.get("region")).is_some_and(is_region) || !is_int(e.get("priority")).is_some_and(|p| p <= 1000) {
        return false;
    }
    if let Some(ca) = e.get("ca") {
        if !ca.as_str().is_some_and(|c| c.contains("-----BEGIN CERTIFICATE-----") && utf16_len(c) <= 8192) {
            return false;
        }
    }
    if let Some(s) = e.get("spki") {
        if !s.as_str().is_some_and(is_spki_pin) {
            return false;
        }
    }
    true
}

/// The newest relay directory seen.
#[derive(Default)]
pub struct DirectoryHolder {
    version: i64,
    token: Option<String>,
    urls: Vec<String>,
}

impl DirectoryHolder {
    pub fn version(&self) -> i64 {
        self.version
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// The relay URLs of the held directory.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    /// Take a directory only if this root signed it, it is in date, and it is not older than the one held.
    pub fn accept(&mut self, trust: &TrustStore, token: &str, now: i64) -> Result<bool, String> {
        let tv = Value::String(token.to_owned());
        let Some(p) = open_compact(Some(&tv), trust.root_key(), MAX_DIRECTORY_TOKEN) else { return Err("relay directory is not signed by this root".into()) };
        let malformed = || Err("malformed relay directory".to_string());
        let keys = ["v", "typ", "root", "version", "relays", "iat", "exp"];
        if !exact_keys(&p, &keys, &keys) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-relay-directory") || str_of(p.get("root")) != Some(trust.root_id.as_str()) {
            return malformed();
        }
        let (Some(version), Some(iat), Some(exp)) = (is_int(p.get("version")), is_int(p.get("iat")), is_int(p.get("exp"))) else { return malformed() };
        if version < 1 || exp <= iat {
            return malformed();
        }
        let Some(relays) = p.get("relays").and_then(Value::as_array).filter(|r| (1..=MAX_DIRECTORY_RELAYS).contains(&r.len()) && r.iter().all(relay_entry_ok)) else {
            return malformed();
        };
        if iat > now + CLOCK_SKEW_SEC {
            return Err("relay directory is not valid yet".into());
        }
        if exp <= now {
            return Err("relay directory expired".into());
        }
        if version < self.version {
            return Err(format!("relay directory version {version} is older than {}", self.version));
        }
        if version == self.version {
            return Ok(false);
        }
        self.version = version;
        self.token = Some(token.to_owned());
        self.urls = relays.iter().filter_map(|r| str_of(r.get("url")).map(str::to_owned)).collect();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_the_typescript_regexes() {
        assert!(is_email("alice@acme.example"));
        assert!(!is_email("Alice@acme.example"));
        assert!(!is_email("alice@localhost"));
        assert!(!is_email("alice@-acme.example"));
        assert!(is_region("eu-west"));
        assert!(!is_region("-eu"));
        assert!(is_label("Desk"));
        assert!(!is_label(""));
        assert!(!is_label("tab\there"));
        assert!(is_node_id("n_0123456789abcdef0123456789abcdef"));
        assert!(!is_node_id("n_0123456789ABCDEF0123456789abcdef"));
    }

    #[test]
    fn relay_urls_must_be_bare_origins() {
        for good in ["https://relay-eu.example", "https://own.relay.example:8443", "http://127.0.0.1:9", "https://[2001:db8::1]:8443", "https://10.0.0.5"] {
            assert!(origin_only(good).is_some(), "{good}");
        }
        for bad in ["https://relay.example/", "https://Relay.example", "https://relay.example:443", "https://relay.example:08443", "https://010.0.0.5", "ftp://relay.example", "https://"] {
            assert!(origin_only(bad).is_none(), "{bad}");
        }
    }
}
