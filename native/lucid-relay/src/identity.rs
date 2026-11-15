// Node identity as the relay checks it, rule for rule from the add-on's src/identity.ts (and presencePublicKey from
// src/presence.ts): the compact signed token, the node certificate (root-signed, or delegate-signed carrying its
// root-signed delegation), the CRL (newer only, nextUpdate kept once seen) and the relay directory. Every reason
// string is the one the Bun relay logs.

use crate::codec::{as_object, exact_keys, is_int, num_is, parse_json, sha256_hex, str_of, unb64u, utf16_len, utf8_lossy};
use crate::der::{ecdsa_verify, p256_from_spki, p256_spki_der, P256Key};
use crate::idp::{
    anchors_of, check_renewed_leaf, idp_claim_problem, idp_map_problem, lowering_anchored, read_org_rules, read_rules_lowering, renewal_shape_problem, rules_words, Anchors,
    LeafRefusal, TOKEN_LIMITS_LEAF, TOKEN_LIMITS_MAP, TOKEN_LIMITS_OTHER,
};
use crate::presence::{presence_kind_enabled, presence_public_key_ok, presence_words};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const ROLES: [&str; 2] = ["hub", "spoke"];
pub const SCOPES: [&str; 3] = ["recall", "drive", "approve"];
pub const CLASSIFICATIONS: [&str; 3] = ["private", "shareable", "cui"];
/// idp-renew (ID-1 5.5): the renewal authority, which renews IdP-bound hub certificates a day at a time and signs
/// nothing else; exclusive.
pub const DELEGATE_POWERS: [&str; 5] = ["users", "spokes", "custody", "enroll", "idp-renew"];
pub(crate) const CLOCK_SKEW_SEC: i64 = 120;
/// IdP-bound certificates last at most 24 hours (5.5).
pub(crate) const IDP_CERT_MAX_SEC: i64 = 86_400;
const MAX_DELEGATED_CERT_DAYS: i64 = 30;
const MAX_DELEGATION_DAYS: i64 = 90;
const ENROLL_MAX_CERT_DAYS: i64 = 7;
const MAX_ENROLL_DELEGATION_DAYS: i64 = 30;
const MAX_DIRECTORY_TOKEN: usize = 64 * 1024;
const MAX_DIRECTORY_RELAYS: usize = 32;
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
/// `idp` and `renewal` (ID-1 5.1) are read only with G-ENGINE (verify_cert refuses them otherwise).
const CERT_KEYS: [&str; 19] = [
    "v", "typ", "serial", "root", "node", "role", "label", "spki", "scopes", "iat", "exp", "user", "classification", "region", "issuer", "delegation", "presence", "idp",
    "renewal",
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
pub fn open_compact(token: Option<&Value>, key: &P256Key, max_len: usize) -> Option<Map<String, Value>> {
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
pub fn import_public_spki(spki_b64u: &str) -> Option<P256Key> {
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
pub(crate) struct Limits {
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
pub(crate) struct Delegation {
    serial: String,
    id: String,
    pub(crate) may: Vec<String>,
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

pub(crate) fn user_problem(v: &Value) -> Option<String> {
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
    let max_days = is_int(limits.get("maxDays")).unwrap_or(0);
    // ID-1 5.5: the renewal authority's power is exclusive, a day at a time, for hubs only.
    if may.iter().any(|m| m == "idp-renew") && (may.len() != 1 || max_days != 1 || roles.iter().any(|r| r != "hub")) {
        return Some("the idp-renew power is exclusive (no other power), with maxDays 1 and roles only hub".into());
    }
    if enroll && (may.iter().any(|m| m == "users") || limits.contains_key("scopes") || roles.iter().any(|r| r != "spoke")) {
        return Some("a delegation with the enroll power certifies spokes only: no users power, no scopes, roles only spoke".into());
    }
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

/// Why a delegate may not sign this certificate, or None. `signed_in`: the certificate carries `idp` or `renewal`.
pub(crate) fn leaf_problem(d: &Delegation, c: &NodeCert, signed_in: bool) -> Option<String> {
    let l = &d.limits;
    let may = |p: &str| d.may.iter().any(|m| m == p);
    if c.role == "hub" && !may("users") && !may("idp-renew") {
        return Some("this delegation may not certify hubs (no users power)".into());
    }
    // ID-1 5.5: a users delegate never signs sign-in evidence, and the renewal authority signs nothing without it.
    if signed_in != may("idp-renew") {
        return Some("only the renewal authority (idp-renew) signs renewed sign-in certificates, and it signs nothing else".into());
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

/// A verified certificate and its public key. `valid_until` (seconds): until when a cache may reuse this verdict
/// (ID-1 5.5 "Cache"); the caller still checks the certificate's own `exp` on every use.
pub struct CertOk {
    pub cert: NodeCert,
    pub key: P256Key,
    pub valid_until: i64,
}

/// A refusal: the reason (the words) and, when it is one of the 6.9 cases, its audit event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: String,
    pub event: Option<&'static str>,
}

impl Refusal {
    pub fn new(reason: impl Into<String>) -> Refusal {
        Refusal { reason: reason.into(), event: None }
    }

    pub fn with(event: &'static str, reason: impl Into<String>) -> Refusal {
        Refusal { reason: reason.into(), event: Some(event) }
    }
}

impl From<LeafRefusal> for Refusal {
    fn from(r: LeafRefusal) -> Refusal {
        Refusal { reason: r.reason, event: Some(r.event) }
    }
}

/// The CRL fields the store keeps. `anchors`: ID-1 5.4, None for a CRL without them.
#[derive(Clone)]
struct HeldCrl {
    version: i64,
    next_update: Option<i64>,
    anchors: Option<Anchors>,
}

/// A CRL-anchored item as accepted: its token and payload.
#[derive(Clone)]
pub(crate) struct Item {
    pub(crate) token: String,
    pub(crate) payload: Map<String, Value>,
}

const ITEMS_DISABLED: &str = "this Lucid release does not accept org identity rules yet (release gate G-ENGINE)";
const MAP_TOO_LARGE: &str = "this identity map is larger than Lucid accepts; nothing signed";
const TOKEN_TOO_LARGE: &str = "this certificate is larger than Lucid accepts; nothing signed";

/// A CRL that passed every check, ready to be held.
struct CheckedCrl {
    held: HeldCrl,
    body: String,
    serials: Vec<String>,
}

// ── ID-1 5.4 and 5.5 (identity.ts): the CRL bundle and the relay header limits ───────────────────────────────

/// The legacy relay `Authorization` form carries the certificate itself; longer ones register (5.5).
pub const LEGACY_HEADER_CERT_MAX: usize = 8_192;
/// A certificate token at most (a renewed sign-in leaf, TOKEN_LIMITS.leaf).
pub const LEAF_TOKEN_MAX: usize = 65_536;
/// A CRL bundle (5.4): 8,192 + 59,392 + 38,912 + 38,912 + 200 bytes of keys and punctuation.
pub const MAX_BUNDLE_BYTES: usize = 145_608;
/// How long past its nextUpdate a CRL still counts as fresh.
pub const CRL_GRACE_SEC: i64 = 3 * 86_400;
/// The bundle items beside the CRL (identity.ts BUNDLE_FILES): body key and state-directory file.
pub const BUNDLE_ITEMS: [(&str, &str); 3] = [("idpMap", "idp-map"), ("orgRules", "org-rules"), ("rulesLowering", "rules-lowering")];

/// A bundle body (identity.ts parseBundle): exact keys, string items, at most MAX_BUNDLE_BYTES as JSON. The pre-ID-1
/// `{crl}` is a bundle. `items` holds the present items in BUNDLE_ITEMS order.
pub struct Bundle {
    pub crl: String,
    pub items: Vec<(&'static str, String)>,
}

pub fn parse_bundle(v: Option<&Value>) -> Option<Bundle> {
    let o = v?.as_object()?;
    const KEYS: [&str; 4] = ["crl", "idpMap", "orgRules", "rulesLowering"];
    if !exact_keys(o, &KEYS, &["crl"]) || !o.values().all(Value::is_string) || crate::codec::stringify(v?).len() > MAX_BUNDLE_BYTES {
        return None;
    }
    let items = BUNDLE_ITEMS.iter().filter_map(|(k, _)| str_of(o.get(*k)).map(|s| (*k, s.to_owned()))).collect();
    Some(Bundle { crl: str_of(o.get("crl"))?.to_owned(), items })
}

/// Decision 34 and the relay's legacy header (5.5): is this a renewed (`idp-renew`) leaf? Read without verifying.
pub fn is_renewed_leaf(token: &str) -> bool {
    peek_compact(token).is_some_and(|p| str_of(p.get("typ")) == Some("lucid-node-cert") && p.contains_key("renewal"))
}

/// The root public key, the newest CRL seen and (ID-1 5.4) the identity map, org rules and rules lowering it anchors.
///
/// `gates`: the release gates this build holds `verified` (contract 2.12). The relay starts with RELAY_GATES, empty
/// until G-RUST is verified: then, as identity.ts without G-ENGINE, a CRL carrying the anchor fields is malformed, a
/// bundle carrying items is refused, and a certificate carrying `idp` or `renewal` is malformed.
#[derive(Clone)]
pub struct TrustStore {
    root: P256Key,
    pub root_id: String,
    /// The organization's name in the 6.9 words; display only.
    pub org_name: String,
    gates: Vec<String>,
    crl: Option<HeldCrl>,
    crl_token: Option<String>,
    /// The held CRL's payload part: an equal version with another body is the two-versions alarm (5.4).
    crl_body: Option<String>,
    revoked: HashSet<String>,
    // Each item is kept as accepted; the accessors hand one out only while it matches the anchors of the CRL held
    // now, so a newer CRL naming other items leaves them "not held" (fail closed).
    map: Option<Item>,
    rules: Option<Item>,
    lowering: Option<Item>,
    /// Two different signed items with one version were seen: enforcement of new rules stops (5.4 alarm).
    conflict: bool,
}

impl TrustStore {
    pub fn new(root: P256Key) -> TrustStore {
        let root_id = node_id_of(&p256_spki_der(&root));
        TrustStore {
            root,
            root_id,
            org_name: "Your organization".into(),
            gates: crate::meet_org_policy::RELAY_GATES.iter().map(|g| (*g).to_owned()).collect(),
            crl: None,
            crl_token: None,
            crl_body: None,
            revoked: HashSet::new(),
            map: None,
            rules: None,
            lowering: None,
            conflict: false,
        }
    }

    /// The verified release gates (tests and vectors only; the relay runs with RELAY_GATES).
    #[cfg(test)]
    pub fn set_gates(&mut self, gates: &[&str]) {
        self.gates = gates.iter().map(|g| (*g).to_owned()).collect();
    }

    /// Whether this release gate is held `verified`.
    pub fn gate(&self, name: &str) -> bool {
        self.gates.iter().any(|g| g == name)
    }

    pub(crate) fn gates(&self) -> &[String] {
        &self.gates
    }

    /// The held CRL's nextUpdate (seconds), or None for none held or a legacy CRL without one.
    pub fn crl_next_update(&self) -> Option<i64> {
        self.crl.as_ref().and_then(|c| c.next_update)
    }

    /// RS-CRL-01: the held CRL is past its nextUpdate plus the grace. A legacy CRL (no nextUpdate) never is.
    pub fn crl_stale(&self, now: i64) -> bool {
        self.crl_next_update().is_some_and(|n| now > n + CRL_GRACE_SEC)
    }

    /// The held CRL's anchors (5.4), or None for none held or a CRL without them.
    pub(crate) fn crl_anchors(&self) -> Option<&Anchors> {
        self.crl.as_ref().and_then(|c| c.anchors.as_ref())
    }

    pub(crate) fn rules_conflict(&self) -> bool {
        self.conflict
    }

    /// The held identity map, only while it is the one the held CRL anchors.
    pub(crate) fn idp_map(&self) -> Option<&Item> {
        let (a, m) = (self.crl_anchors()?, self.map.as_ref()?);
        (is_int(m.payload.get("version")) == Some(a.idp_map_version) && sha256_hex(m.token.as_bytes()) == a.idp_map_sha256).then_some(m)
    }

    /// The held ordinary rules token, only while the held CRL's rules anchor names it.
    pub(crate) fn org_rules(&self) -> Option<&Item> {
        let (a, r) = (self.crl_anchors()?, self.rules.as_ref()?);
        (is_int(r.payload.get("version")) == Some(a.org_rules_version) && sha256_hex(r.token.as_bytes()) == a.org_rules_sha256).then_some(r)
    }

    /// The held lowering wire, only while the held CRL anchors it, pending or settled (3.8).
    pub(crate) fn rules_lowering(&self) -> Option<&Item> {
        let (a, w) = (self.crl_anchors()?, self.lowering.as_ref()?);
        lowering_anchored(a, &sha256_hex(w.token.as_bytes()), &w.payload).map(|_| w)
    }

    /// What the held CRL anchors that this store does not hold.
    fn missing_items(&self) -> Vec<&'static str> {
        let Some(a) = self.crl_anchors() else { return Vec::new() };
        let mut out = Vec::new();
        if a.idp_map_version != 0 && self.idp_map().is_none() {
            out.push("idpMap");
        }
        let lowering_sha = self.rules_lowering().map(|w| sha256_hex(w.token.as_bytes())).unwrap_or_default();
        // The rules anchor names either an ordinary token or a settled lowering wire; "orgRules" means its carrier.
        if a.org_rules_version != 0 && self.org_rules().is_none() && lowering_sha != a.org_rules_sha256 {
            out.push("orgRules");
        }
        if a.org_rules_pending_version != 0 && lowering_sha != a.org_rules_pending_sha256 {
            out.push("rulesLowering");
        }
        out
    }

    /// The held CRL and the held items it anchors: what GET /v1/crl answers and what the relay persists, or None.
    pub fn bundle(&self) -> Option<Value> {
        let crl = self.crl_token.as_deref()?;
        let mut o = Map::new();
        o.insert("crl".into(), Value::from(crl));
        for (key, item) in [("idpMap", self.idp_map()), ("orgRules", self.org_rules()), ("rulesLowering", self.rules_lowering())] {
            if let Some(i) = item {
                o.insert(key.into(), Value::from(i.token.as_str()));
            }
        }
        Some(Value::Object(o))
    }

    /// The key a relay caches a verdict under (5.5 "Cache"): the CRL version, the anchored rules carriers and map, and
    /// which of them are held (so adopting a missing item also changes it).
    pub fn cache_key(&self) -> String {
        let a = self.crl_anchors();
        let held = format!(
            "{}{}{}",
            if self.idp_map().is_some() { "m" } else { "" },
            if self.org_rules().is_some() { "r" } else { "" },
            if self.rules_lowering().is_some() { "l" } else { "" }
        );
        let rules = a.map(|a| format!("{}/{}", a.org_rules_sha256, a.org_rules_pending_sha256)).unwrap_or_default();
        format!("{}:{rules}:{}:{held}", self.crl_version(), a.map(|a| a.idp_map_sha256.as_str()).unwrap_or_default())
    }

    /// The 5.4 acceptance rule for a versioned item against its CRL anchor: Ok(changed).
    fn anchored(&mut self, what: &str, version: i64, token: &str, anchor_version: i64, anchor_sha: &str, held: Option<&str>) -> Result<bool, Refusal> {
        if anchor_version == 0 {
            return Err(Refusal::with("rs_rules_missing", format!("the held revocation list names no {what}")));
        }
        if version < anchor_version {
            return Err(Refusal::new(format!("{what} version {version} is older than version {anchor_version}, which the revocation list names")));
        }
        if version > anchor_version {
            return Err(Refusal::new(format!("{what} version {version} is not named by the held revocation list (version {anchor_version})")));
        }
        if sha256_hex(token.as_bytes()) != anchor_sha {
            self.conflict = true;
            return Err(Refusal::with("rs_rules_conflict", rules_words::conflict(&self.org_name)));
        }
        Ok(held != Some(token))
    }

    /// ID-1 5.4: the root-signed identity map, accepted only when its version and SHA-256 are the held CRL's anchors.
    pub fn accept_idp_map(&mut self, token: &str) -> Result<bool, Refusal> {
        if !self.gate("G-ENGINE") {
            return Err(Refusal::new(ITEMS_DISABLED));
        }
        if utf16_len(token) > TOKEN_LIMITS_MAP {
            return Err(Refusal::with("rs_map_too_large", MAP_TOO_LARGE));
        }
        let tv = Value::from(token);
        let Some(p) = open_compact(Some(&tv), &self.root, TOKEN_LIMITS_MAP) else { return Err(Refusal::new("the identity map is not signed by this root")) };
        if let Some(problem) = idp_map_problem(&p, &self.root_id) {
            return Err(Refusal::new(format!("malformed identity map: {problem}")));
        }
        let (av, asha) = self.crl_anchors().map_or((0, String::new()), |a| (a.idp_map_version, a.idp_map_sha256.clone()));
        let held = self.map.as_ref().map(|m| m.token.clone());
        let changed = self.anchored("identity map", is_int(p.get("version")).unwrap_or(0), token, av, &asha, held.as_deref())?;
        if changed {
            self.map = Some(Item { token: token.to_owned(), payload: p });
        }
        Ok(changed)
    }

    /// ID-1 5.4: the ordinary `lucid-org-rules` token, under the same anchor rule.
    pub fn accept_org_rules(&mut self, token: &str) -> Result<bool, Refusal> {
        if !self.gate("G-ENGINE") {
            return Err(Refusal::new(ITEMS_DISABLED));
        }
        let Some(p) = read_org_rules(token, &self.root, &self.root_id) else {
            return Err(Refusal::new("the org rules are not signed by this root, too large or malformed"));
        };
        let (av, asha) = self.crl_anchors().map_or((0, String::new()), |a| (a.org_rules_version, a.org_rules_sha256.clone()));
        let held = self.rules.as_ref().map(|r| r.token.clone());
        let changed = self.anchored("org rules", is_int(p.get("version")).unwrap_or(0), token, av, &asha, held.as_deref())?;
        if changed {
            self.rules = Some(Item { token: token.to_owned(), payload: p });
        }
        Ok(changed)
    }

    /// ID-1 3.8: the lowering wire, accepted only when the held CRL anchors it as pending or as the settled carrier.
    pub fn accept_rules_lowering(&mut self, wire: &str) -> Result<bool, Refusal> {
        if !self.gate("G-ENGINE") {
            return Err(Refusal::new(ITEMS_DISABLED));
        }
        let Some(p) = read_rules_lowering(wire, &self.root, &self.root_id) else {
            return Err(Refusal::new("the lowering is not signed by this root, too large or malformed"));
        };
        let sha = sha256_hex(wire.as_bytes());
        let next = is_int(p.get("next_rules_version")).unwrap_or(0);
        if let Some(a) = self.crl_anchors() {
            if lowering_anchored(a, &sha, &p).is_some() {
                if self.lowering.as_ref().is_some_and(|w| w.token == wire) {
                    return Ok(false);
                }
                self.lowering = Some(Item { token: wire.to_owned(), payload: p });
                return Ok(true);
            }
            if (a.org_rules_pending_version != 0 && next == a.org_rules_pending_version) || next == a.org_rules_version {
                self.conflict = true;
                return Err(Refusal::with("rs_rules_conflict", rules_words::conflict(&self.org_name)));
            }
        }
        Err(Refusal::with("rs_lowering_unanchored", rules_words::unanchored(&self.org_name)))
    }

    /// ID-1 5.4: a whole bundle, all or nothing: the CRL first (newer or equal), then every item against that CRL's
    /// anchors. With anchors the bundle must carry what they name; without anchors it carries nothing else. Nothing
    /// held changes on a refusal (except the conflict alarm, which stays raised).
    pub fn accept_bundle(&mut self, b: &Bundle) -> Result<bool, Refusal> {
        let mut stage = self.clone();
        let mut changed = match stage.accept_crl_checked(&b.crl) {
            Ok(c) => c,
            Err(r) => {
                self.conflict |= stage.conflict;
                return Err(r);
            }
        };
        let item = |k: &str| b.items.iter().find(|(name, _)| *name == k).map(|(_, t)| t.as_str());
        match stage.crl_anchors().cloned() {
            None if !b.items.is_empty() => return Err(Refusal::new("the bundle carries items its revocation list does not name")),
            None => {}
            Some(a) => {
                if a.idp_map_version != 0 && item("idpMap").is_none() {
                    return Err(Refusal::with("rs_rules_missing", "the bundle lacks the identity map its revocation list names"));
                }
                for key in ["idpMap", "orgRules", "rulesLowering"] {
                    let Some(t) = item(key) else { continue };
                    let r = match key {
                        "idpMap" => stage.accept_idp_map(t),
                        "orgRules" => stage.accept_org_rules(t),
                        _ => stage.accept_rules_lowering(t),
                    };
                    match r {
                        Ok(c) => changed |= c,
                        Err(r) => {
                            self.conflict |= stage.conflict;
                            return Err(r);
                        }
                    }
                }
                let missing = stage.missing_items();
                if !missing.is_empty() {
                    return Err(Refusal::with("rs_rules_missing", format!("the bundle lacks {} its revocation list names", missing.join(" and "))));
                }
            }
        }
        *self = stage;
        Ok(changed)
    }

    pub fn root_key(&self) -> &P256Key {
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

    /// Every serial the held CRL revokes.
    pub fn revoked_serials(&self) -> &HashSet<String> {
        &self.revoked
    }

    /// Take a CRL only if the root signed it and it is NEWER than the one held; once a held list carries a
    /// nextUpdate, a newer one without it is refused. Ok(changed) or Err(reason).
    pub fn accept_crl(&mut self, token: &str) -> Result<bool, String> {
        self.accept_crl_checked(token).map_err(|r| r.reason)
    }

    /// accept_crl with the refusal's 6.9 event; the two-versions alarm raises the conflict flag (the held one stays).
    pub fn accept_crl_checked(&mut self, token: &str) -> Result<bool, Refusal> {
        match self.check_crl(token) {
            Ok(checked) => Ok(self.hold_crl(token, checked)),
            Err(r) => {
                if r.event == Some("rs_rules_conflict") {
                    self.conflict = true;
                }
                Err(r)
            }
        }
    }

    /// Hold a CRL check_crl passed (None: the one held already); Ok(changed).
    fn hold_crl(&mut self, token: &str, checked: Option<CheckedCrl>) -> bool {
        let Some(c) = checked else { return false };
        self.crl = Some(c.held);
        self.crl_token = Some(token.to_owned());
        self.crl_body = Some(c.body);
        self.revoked = c.serials.into_iter().collect();
        true
    }

    /// Every acceptCrl check without holding anything: Ok(None) for the CRL held already. ID-1 5.4: an equal version
    /// with another body is the two-versions alarm and the held one stays.
    fn check_crl(&self, token: &str) -> Result<Option<CheckedCrl>, Refusal> {
        let tv = Value::String(token.to_owned());
        let Some(p) = open_compact(Some(&tv), &self.root, TOKEN_LIMITS_OTHER) else { return Err(Refusal::new("CRL is not signed by this root")) };
        let malformed = || Err(Refusal::new("malformed CRL"));
        const KEYS: [&str; 15] = [
            "v", "typ", "root", "version", "serials", "iat", "nextUpdate", "org_rules_version", "org_rules_sha256", "idp_map_version", "idp_map_sha256",
            "org_rules_pending_sha256", "org_rules_pending_version", "org_rules_pending_effective_at", "org_rules_pending_exp",
        ];
        if !exact_keys(&p, &KEYS, &["v", "typ", "root", "version", "serials", "iat"])
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
        // ID-1 5.4: the anchor fields are read only with G-ENGINE, all eight or none, and only beside a nextUpdate.
        let anchors = match anchors_of(&p) {
            Ok(None) => None,
            Ok(Some(a)) if self.gate("G-ENGINE") && next_update.is_some() => Some(a),
            _ => return malformed(),
        };
        let held = self.crl_version();
        if version < held {
            return Err(Refusal::new(format!("CRL version {version} is older than {held}")));
        }
        let body = token.split('.').next().unwrap_or("").to_owned();
        if version == held {
            if self.crl_body.as_deref().is_none_or(|b| b == body) {
                return Ok(None);
            }
            return Err(Refusal::with("rs_rules_conflict", format!("two different revocation lists carry version {version}; the one held stays. Tell the root holder.")));
        }
        if next_update.is_none() && self.crl.as_ref().is_some_and(|c| c.next_update.is_some()) {
            return Err(Refusal::new(format!("CRL version {version} has no nextUpdate, and this node already holds one that expires")));
        }
        Ok(Some(CheckedCrl { held: HeldCrl { version, next_update, anchors }, body, serials }))
    }

    fn verify_delegation(&self, token: Option<&Value>, now: i64) -> Result<(Delegation, P256Key), String> {
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
        self.check_cert(token, now).map_err(|r| r.reason)
    }

    /// verify_cert with the refusal's 6.9 event. ID-1 5.5: a leaf an `idp-renew` delegate signed passes only the nine
    /// checks of check_renewed_leaf, against the map and rules this store holds.
    pub fn check_cert(&self, token: Option<&Value>, now: i64) -> Result<CertOk, Refusal> {
        let malformed = || Err(Refusal::new("malformed certificate"));
        let org = self.org_name.as_str();
        let mut del = None;
        let p = match open_compact(token, &self.root, TOKEN_LIMITS_OTHER) {
            Some(p) => {
                if p.contains_key("issuer") || p.contains_key("delegation") {
                    return malformed();
                }
                p
            }
            None => {
                // Not root-signed: it may be a leaf a delegate signed, carrying its root-signed delegation.
                let text = token.and_then(Value::as_str);
                let peek = text.and_then(peek_compact);
                let Some(peek) = peek.filter(|p| p.get("issuer").is_some_and(Value::is_string) && p.get("delegation").is_some_and(Value::is_string)) else {
                    return Err(Refusal::new("certificate is not signed by this root"));
                };
                // ID-1 5.5: a leaf carrying sign-in evidence is refused with the 6.9 words, whatever is wrong with its issuer.
                let signed_in = (peek.contains_key("idp") || peek.contains_key("renewal")) && self.gate("G-ENGINE");
                let (d, key) = match self.verify_delegation(peek.get("delegation"), now) {
                    Ok(dk) => dk,
                    Err(r) if !signed_in => return Err(Refusal::new(format!("certificate issuer: {r}"))),
                    Err(_) => {
                        let may = str_of(peek.get("delegation")).and_then(peek_compact).and_then(|d| d.get("may").cloned());
                        let only_renew = may.as_ref().and_then(Value::as_array).is_some_and(|m| m.len() == 1 && m[0].as_str() == Some("idp-renew"));
                        let event = if may.as_ref().is_some_and(Value::is_array) && !only_renew { "rs_renewal_wrong_power" } else { "rs_renewal_bad" };
                        return Err(crate::idp::leaf_refusal(event, org, "").into());
                    }
                };
                let renewing = d.may.iter().any(|m| m == "idp-renew");
                // A users (or any other) delegate never signs sign-in evidence: say so before anything else about the leaf.
                if signed_in && !renewing {
                    return Err(crate::idp::leaf_refusal("rs_renewal_wrong_power", org, "").into());
                }
                let limit = if renewing { TOKEN_LIMITS_LEAF } else { TOKEN_LIMITS_OTHER };
                if text.is_some_and(|t| utf16_len(t) > limit) {
                    return Err(Refusal::with("rs_token_too_large", TOKEN_TOO_LARGE));
                }
                let Some(p) = open_compact(token, &key, limit) else { return Err(Refusal::new("certificate is not signed by its delegation's key")) };
                if str_of(p.get("issuer")) != Some(d.id.as_str()) {
                    return Err(Refusal::new("certificate names another issuer than its delegation"));
                }
                del = Some(d);
                p
            }
        };
        if !exact_keys(&p, &CERT_KEYS, &CERT_KEYS[..11]) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-node-cert") {
            return malformed();
        }
        // ID-1: the new certificate keys exist only behind G-ENGINE (5.6); without it such a certificate is malformed.
        let signed_in = p.contains_key("idp") || p.contains_key("renewal");
        if signed_in && !self.gate("G-ENGINE") {
            return malformed();
        }
        if let Some(idp) = p.get("idp") {
            if str_of(p.get("role")) != Some("hub") || idp_claim_problem(idp).is_some() {
                return malformed();
            }
        }
        if let Some(r) = p.get("renewal") {
            if del.is_none() || renewal_shape_problem(r).is_some() {
                return if del.is_some() { Err(crate::idp::leaf_refusal("rs_renewal_bad", org, "").into()) } else { malformed() };
            }
        }
        if del.is_none() && p.contains_key("idp") {
            if let (Some(iat), Some(exp)) = (is_int(p.get("iat")), is_int(p.get("exp"))) {
                if exp - iat > IDP_CERT_MAX_SEC {
                    return Err(Refusal::new("malformed certificate: a sign-in certificate lasts at most 24 hours"));
                }
            }
        }
        let kind = p.get("presence").and_then(Value::as_object).and_then(|o| str_of(o.get("kind")));
        if matches!(kind, Some("piv" | "fido2")) && !presence_kind_enabled(kind.unwrap_or_default(), &self.gates) {
            return Err(Refusal::with("rs_kind_disabled", presence_words("rs_kind_disabled", Some(org), None)));
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
            if role != "hub" || !presence_public_key_ok(pr, &self.gates) {
                return malformed();
            }
        }
        if iat > now + CLOCK_SKEW_SEC {
            return Err(Refusal::new("certificate is not valid yet"));
        }
        if exp <= now {
            return Err(Refusal::new("certificate expired"));
        }
        let serial = str_of(p.get("serial")).unwrap_or_default().to_owned();
        if self.revoked.contains(&serial) {
            return Err(Refusal::new("certificate revoked"));
        }
        let node = str_of(p.get("node")).unwrap_or_default().to_owned();
        let spki = str_of(p.get("spki"));
        let key = spki.and_then(import_public_spki);
        let Some(key) = key.filter(|_| node_id_of(&unb64u(spki.unwrap_or("")).unwrap_or_default()) == node) else {
            return Err(Refusal::new("certificate key does not match its node id"));
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
        // The cache bound (5.5 "Cache"): the leaf's own end and the CRL's staleness, then the evidence's for a renewed leaf.
        let mut valid_until = self.crl_next_update().map_or(cert.exp, |n| cert.exp.min(n + CRL_GRACE_SEC));
        match &del {
            // The nine 5.5 checks (they include the delegation limits, as check 1).
            Some(d) if d.may.iter().any(|m| m == "idp-renew") => valid_until = valid_until.min(check_renewed_leaf(self, &cert, &p, d, now)?),
            // Every verifier re-checks the limits, so a delegate that skips its own checks still cannot exceed them.
            Some(d) => {
                if let Some(outside) = leaf_problem(d, &cert, signed_in) {
                    return Err(Refusal::new(format!("certificate is outside its delegation: {outside}")));
                }
            }
            None => {}
        }
        Ok(CertOk { cert, key, valid_until })
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
