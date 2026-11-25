// ID-1 for Remote Spokes, as the relay (and any Rust verifier) reads it, rule for rule from the add-on's
// src/identity.ts and src/orgrules.ts: the CRL anchors (5.4), the ordinary rules token and the lowering wire (3.8) and
// the current-rules selection, the identity map (5.3), the signed-in request envelope (5.1), and the nine checks on a
// renewed (`idp-renew`) leaf with its anchor, status token and PIV OCSP response (5.5). Every word is the add-on's.
//
// All of it runs only behind release gate G-ENGINE, which this build never holds (G-RUST is off, contract 2.12): the
// relay's TrustStore starts with RELAY_GATES, empty. Shape-only checks of the rules skip the provider registry.

use crate::codec::{as_object, b64u, exact_keys, is_int, num_is, parse_json, sha256_hex, str_of, unb64u, utf16_len, utf8_lossy};
use crate::der::{ecdsa_verify, P256Key};
use crate::identity::{
    import_public_spki, is_email, is_node_id, is_serial, leaf_problem, node_id_of, open_compact, user_problem, Delegation, NodeCert, TrustStore, CLASSIFICATIONS,
    IDP_CERT_MAX_SEC, LEAF_TOKEN_MAX, SCOPES,
};
use crate::meet_org_policy::{canonical_json, identity_shape, lp, method_matches};
use crate::presence::{presence_public_key_ok, presence_words};
use crate::x509::{cert_signed_by, has_digital_signature, parse_cert, piv_key_problem, valid_at, verify_ocsp, X509Info};
use serde_json::{Map, Value};

// ── Size budget (5.5): the longest compact token each parser reads, in characters ────────────────────────────

pub const TOKEN_LIMITS_LEAF: usize = LEAF_TOKEN_MAX;
pub const TOKEN_LIMITS_MAP: usize = 59_392;
pub const TOKEN_LIMITS_RULES: usize = 38_912;
pub const TOKEN_LIMITS_LOWERING: usize = 38_912;
pub const TOKEN_LIMITS_STATUS: usize = 16_896;
pub const TOKEN_LIMITS_ANCHOR: usize = 12_288;
pub const TOKEN_LIMITS_OTHER: usize = 8_192;
/// The spoke's local `engine.decide` body (carriers row 9): computed maximum 227,528 bytes.
pub const MAX_DECISION_BYTES: usize = 262_144;
/// The Remote Spokes password baseline `B` (presence.ts PASSWORD_BASELINE; owner decision 1 open, #251).
pub const RS_PASSWORD_BASELINE: i64 = 12;
const ENVELOPE_MAX_SKEW_SEC: i64 = 300;
const ANCHOR_MAX_DAYS: i64 = 90;
const PIV_CERT_MAX_BYTES: usize = 4_096;
const MAX_RULES_DAYS: i64 = 90;
const LOWERING_NOTICE: i64 = 86_400;
const DAY: i64 = 86_400;

/// A refusal with its 6.9 audit event and exact words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeafRefusal {
    pub event: &'static str,
    pub reason: String,
}

fn no(event: &'static str, reason: impl Into<String>) -> LeafRefusal {
    LeafRefusal { event, reason: reason.into() }
}

// ── Small patterns ───────────────────────────────────────────────────────────────────────────────────────────

/// Printable ASCII without `"` or `\` (5.5: every Remote Spokes token string, so JSON adds no escapes).
pub fn plain_ascii(s: &str) -> bool {
    s.bytes().all(|c| c == 0x20 || c == 0x21 || (0x23..=0x5b).contains(&c) || (0x5d..=0x7e).contains(&c))
}

/// identity.ts `plain`: a string of `min` to `max` characters, printable ASCII without `"` or `\`.
fn plain(v: Option<&Value>, min: usize, max: usize) -> Option<&str> {
    str_of(v).filter(|s| (min..=max).contains(&utf16_len(s)) && plain_ascii(s))
}

/// /^[a-z0-9-]{1,32}$/
fn is_provider_id(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// /^[0-9a-f]{64}$/
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// A lower-case UUID.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(c) })
}

/// /^[0-2](?:\.(?:0|[1-9][0-9]*))+$/
fn is_oid(s: &str) -> bool {
    let mut parts = s.split('.');
    let first_ok = parts.next().is_some_and(|f| matches!(f, "0" | "1" | "2"));
    let rest: Vec<&str> = parts.collect();
    first_ok && !rest.is_empty() && rest.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0')))
}

/// A canonical string list (section 0): sorted by UTF-8 bytes, unique, at most `max`, each passing `ok`.
fn sorted_list(v: Option<&Value>, max: usize, ok: impl Fn(&str) -> bool) -> Option<Vec<String>> {
    let a = v?.as_array().filter(|a| a.len() <= max)?;
    let list: Vec<String> = a.iter().map(|s| s.as_str().filter(|s| ok(s)).map(str::to_owned)).collect::<Option<_>>()?;
    list.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes()).then_some(list)
}

const METHOD_PREFIXES: [&str; 5] = ["acr:", "acrs:", "aal:", "saml:", "saml-amr:"];

/// orgrules.ts `methodsWellFormed`: a canonical string list of at most `max` entries of 1 to `len` printable
/// characters; a value with ":" carries one of the prefixes.
pub fn methods_well_formed(v: Option<&Value>, max: usize, len: usize) -> bool {
    let Some(a) = v.and_then(Value::as_array).filter(|a| a.len() <= max) else { return false };
    let mut prev: Option<&str> = None;
    for m in a {
        let Some(m) = m.as_str().filter(|m| (1..=len).contains(&utf16_len(m)) && crate::meet_json::printable(m)) else { return false };
        if m.contains(':') && !METHOD_PREFIXES.iter().any(|p| m.starts_with(p) && m.len() > p.len()) {
            return false;
        }
        if prev.is_some_and(|p| p.as_bytes() >= m.as_bytes()) {
            return false;
        }
        prev = Some(m);
    }
    true
}

/// Any requirement matches (`phr_values` passes on one match).
fn methods_pass(requirements: &[String], evidence: &[String]) -> bool {
    requirements.iter().any(|r| method_matches(r, evidence))
}

fn strings_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// codec.ts `canonical` equality of two optional values (an absent one is `null`).
fn same_json(x: Option<&Value>, y: Option<&Value>) -> bool {
    let canon = |v: Option<&Value>| v.map(|v| canonical_json(v).unwrap_or_default());
    canon(x) == canon(y)
}

// ── Words (6.9) ──────────────────────────────────────────────────────────────────────────────────────────────

pub mod rules_words {
    use crate::meet_json::iso_date;

    pub fn crl_missing(org: &str) -> String {
        format!("This hub has no current revocation list from {org}'s root, so it cannot apply {org}'s rules yet.")
    }
    pub fn missing(org: &str) -> String {
        format!("{org}'s current org rules are not available here, so renewed sign-in certificates cannot be checked")
    }
    pub fn expired(org: &str, signed: i64) -> String {
        format!("{org}'s org rules are out of date (last signed {}); ask the root holder to sign them again.", iso_date(signed))
    }
    pub fn conflict(org: &str) -> String {
        format!("Two different signed versions of {org}'s org rules exist. Enforcement of new rules stopped; tell the root holder.")
    }
    pub fn unanchored(org: &str) -> String {
        format!("{org}'s lowered rules are not named by the current revocation list; the earlier rules still apply")
    }
    pub fn lowering_expired(org: &str, exp: i64) -> String {
        format!("{org}'s lowered rules expired on {}; ask the root holder to sign new rules", iso_date(exp))
    }
}

/// The 6.9 words of a renewed-leaf refusal. `rule` names the failed rule (rs_renewal_rule).
pub fn leaf_words(event: &str, org: &str, rule: &str) -> String {
    match event {
        "rs_renewal_bad" => "this renewed certificate does not carry valid sign-in evidence; it is not accepted".into(),
        "rs_renewal_wrong_power" => format!("only {org}'s renewal authority may renew sign-in certificates; it is not accepted"),
        "rs_anchor_bad" => format!("this hub's sign-in anchor is expired, revoked or not from {org}'s root; approve the hub again with a fresh sign-in"),
        "rs_renewal_rule" => format!("this renewed certificate does not meet {org}'s current rules ({rule}); it is not accepted"),
        "rs_renewal_piv_status" => "this renewed certificate carries no current PIV status for its card; it is not accepted".into(),
        _ => presence_words(event, Some(org), None),
    }
}

pub fn leaf_refusal(event: &'static str, org: &str, rule: &str) -> LeafRefusal {
    no(event, leaf_words(event, org, rule))
}

// ── The CRL anchors (5.4) ────────────────────────────────────────────────────────────────────────────────────

/// The anchors a CRL carries once the root has a map or rules: the version and SHA-256 (hex, of the token's UTF-8) of
/// the current rules carrier and identity map, and the pending lowering (`""`/`0` when none).
#[derive(Clone, Debug)]
pub struct Anchors {
    pub org_rules_version: i64,
    pub org_rules_sha256: String,
    pub idp_map_version: i64,
    pub idp_map_sha256: String,
    pub org_rules_pending_sha256: String,
    pub org_rules_pending_version: i64,
    pub org_rules_pending_effective_at: i64,
    pub org_rules_pending_exp: i64,
}

pub const CRL_ANCHOR_KEYS: [&str; 8] = [
    "org_rules_version", "org_rules_sha256", "idp_map_version", "idp_map_sha256", "org_rules_pending_sha256", "org_rules_pending_version", "org_rules_pending_effective_at",
    "org_rules_pending_exp",
];

/// The anchors of a CRL payload: Ok(None) without any anchor field, Err(problem) when they are not well formed (all
/// eight or none; `""`/`0` for an absent item).
pub fn anchors_of(p: &Map<String, Value>) -> Result<Option<Anchors>, String> {
    let present = CRL_ANCHOR_KEYS.iter().filter(|k| p.contains_key(**k)).count();
    if present == 0 {
        return Ok(None);
    }
    if present != CRL_ANCHOR_KEYS.len() {
        return Err("all eight anchor fields or none".into());
    }
    let int = |k: &str| is_int(p.get(k));
    let (Some(rv), Some(mv), Some(pv), Some(pe), Some(px)) =
        (int("org_rules_version"), int("idp_map_version"), int("org_rules_pending_version"), int("org_rules_pending_effective_at"), int("org_rules_pending_exp"))
    else {
        return Err("versions and times are whole numbers".into());
    };
    let hex = |k: &str| str_of(p.get(k)).filter(|s| s.is_empty() || is_hex64(s)).map(str::to_owned);
    let (Some(rs), Some(ms), Some(ps)) = (hex("org_rules_sha256"), hex("idp_map_sha256"), hex("org_rules_pending_sha256")) else {
        return Err("hashes are 64 lower-case hex or empty".into());
    };
    if (rv == 0) != rs.is_empty() || (mv == 0) != ms.is_empty() {
        return Err("a version and its hash are set together".into());
    }
    let pending = [!ps.is_empty(), pv != 0, pe != 0, px != 0];
    if pending.iter().any(|x| *x != pending[0]) {
        return Err("the four pending fields are set together".into());
    }
    if pending[0] && (rv == 0 || pv != rv + 1 || px <= pe) {
        return Err("a pending lowering is the next version after the anchored rules and expires after it takes effect".into());
    }
    Ok(Some(Anchors {
        org_rules_version: rv,
        org_rules_sha256: rs,
        idp_map_version: mv,
        idp_map_sha256: ms,
        org_rules_pending_sha256: ps,
        org_rules_pending_version: pv,
        org_rules_pending_effective_at: pe,
        org_rules_pending_exp: px,
    }))
}

// ── The rules carriers (3.8, 5.4) ────────────────────────────────────────────────────────────────────────────

const FEATURES: [&str; 3] = ["cert-idp-v1", "presence-piv-v1", "presence-fido2-v1"];

fn features_ok(v: Option<&Value>) -> bool {
    sorted_list(v, 16, |f| (1..=32).contains(&f.len()) && FEATURES.contains(&f)).is_some()
}

fn invalid(field: &str) -> String {
    format!("the identity rules are not valid: {field}")
}

/// The IR-1 shape of `rules` (3.1, no registry, no gates), or the refusal.
fn rules_problem(rules: Option<&Value>, issued: i64) -> Option<String> {
    let null = Value::Null;
    match identity_shape(rules.unwrap_or(&null), RS_PASSWORD_BASELINE, issued) {
        Ok(()) => None,
        Err(crate::meet_org_policy::PolicyError::Refused(s) | crate::meet_org_policy::PolicyError::Bad(s)) => Some(s),
    }
}

/// Why a `lucid-org-rules` payload is not well formed (shape only; the signature is the caller's), or None.
pub fn org_rules_problem(p: &Map<String, Value>, root_id: &str) -> Option<String> {
    let keys = ["v", "typ", "root", "version", "rules", "features", "iat", "exp"];
    if !exact_keys(p, &keys, &keys) || !num_is(p.get("v"), 2.0) || str_of(p.get("typ")) != Some("lucid-org-rules") || str_of(p.get("root")) != Some(root_id) {
        return Some("wrong fields, type or root".into());
    }
    let (version, iat, exp) = (is_int(p.get("version")), is_int(p.get("iat")), is_int(p.get("exp")));
    let ok = matches!((version, iat, exp), (Some(v), Some(i), Some(x)) if v >= 1 && x > i && x - i <= MAX_RULES_DAYS * DAY);
    if !ok {
        return Some(format!("org rules last at most {MAX_RULES_DAYS} days"));
    }
    if !features_ok(p.get("features")) {
        return Some(invalid("features"));
    }
    rules_problem(p.get("rules"), iat.unwrap_or(0))
}

/// Open an ordinary rules token: root signature, exact keys, IR-1 shape, at most 38,912 characters.
pub fn read_org_rules(token: &str, root: &P256Key, root_id: &str) -> Option<Map<String, Value>> {
    let p = open_compact(Some(&Value::from(token)), root, TOKEN_LIMITS_RULES)?;
    org_rules_problem(&p, root_id).is_none().then_some(p)
}

const LOWERING_KEYS: [&str; 13] =
    ["v", "typ", "root", "base_rules_version", "base_rules_sha256", "next_rules_version", "rules", "features", "reason", "signed_at", "effective_at", "exp", "signers"];

fn is_proof(s: &str) -> bool {
    (8..=200).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Why a lowering object is not well formed (3.8), or None. A payload carrying `seq` is refused by the exact keys.
pub fn rules_lowering_problem(p: &Map<String, Value>, root_id: &str) -> Option<String> {
    if !exact_keys(p, &LOWERING_KEYS, &LOWERING_KEYS) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-rs-rules-lowering-v1") || str_of(p.get("root")) != Some(root_id) {
        return Some("wrong fields, type or root".into());
    }
    let (base, next) = (is_int(p.get("base_rules_version")), is_int(p.get("next_rules_version")));
    if !matches!((base, next), (Some(b), Some(n)) if b >= 1 && n >= 2 && n == b + 1) {
        return Some("next_rules_version must be base_rules_version plus one".into());
    }
    if !str_of(p.get("base_rules_sha256")).is_some_and(is_hex64) {
        return Some("bad base_rules_sha256".into());
    }
    if !str_of(p.get("reason")).is_some_and(|r| (1..=500).contains(&utf16_len(r)) && plain_ascii(r)) {
        return Some("the reason is 1 to 500 printable ASCII characters without quotes or backslashes".into());
    }
    let (Some(s), Some(e), Some(x)) = (is_int(p.get("signed_at")), is_int(p.get("effective_at")), is_int(p.get("exp"))) else { return Some("bad times".into()) };
    if e < s + LOWERING_NOTICE {
        return Some("effective_at must be at least 24 hours after signed_at".into());
    }
    if !(e < x && x <= s + MAX_RULES_DAYS * DAY) {
        return Some("exp must be after effective_at and at most 90 days after signed_at".into());
    }
    if !features_ok(p.get("features")) {
        return Some(invalid("features"));
    }
    let Some(signers) = p.get("signers").and_then(Value::as_array).filter(|a| a.len() == 2) else { return Some("exactly two signers".into()) };
    let mut read: Vec<(&str, &str)> = Vec::new();
    for g in signers {
        let g = g.as_object().filter(|g| exact_keys(g, &["principal", "cert_sha256", "proof"], &["principal", "cert_sha256", "proof"]));
        let fields = g.and_then(|g| Some((str_of(g.get("principal")).filter(|x| is_node_id(x))?, str_of(g.get("cert_sha256")).filter(|x| is_hex64(x))?, str_of(g.get("proof")).filter(|x| is_proof(x))?)));
        let Some((principal, cert, _)) = fields else { return Some("a signer is {principal, cert_sha256, proof}".into()) };
        read.push((principal, cert));
    }
    if read[0].0.as_bytes() >= read[1].0.as_bytes() || read[0].1 == read[1].1 {
        return Some("signers sorted by principal, distinct principals and certificates".into());
    }
    if !read.iter().any(|(principal, _)| *principal == root_id) {
        return Some("the root is one of the two signers".into());
    }
    rules_problem(p.get("rules"), s)
}

/// Open a lowering wire: at most 38,912 characters, the payload exactly its CE-1 bytes, the root signature over
/// lp("lucid-rs-rules-lowering-v1", canonical_json(object)), and the 3.8 shape.
pub fn read_rules_lowering(wire: &str, root: &P256Key, root_id: &str) -> Option<Map<String, Value>> {
    if utf16_len(wire) > TOKEN_LIMITS_LOWERING {
        return None;
    }
    let (p, canon, sig) = canonical_part(wire)?;
    if !ecdsa_verify(root, &lp(&[b"lucid-rs-rules-lowering-v1", &canon]), &sig) || rules_lowering_problem(&p, root_id).is_some() {
        return None;
    }
    Some(p)
}

type CanonicalPart = (Map<String, Value>, Vec<u8>, Vec<u8>);

/// The two parts of a `base64url(canonical JSON).base64url(signature)` carrier: the object, its CE-1 bytes (equal to
/// the payload bytes) and the signature; None when anything differs.
fn canonical_part(token: &str) -> Option<CanonicalPart> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return None;
    }
    let (body, sig) = (unb64u(parts[0])?, unb64u(parts[1])?);
    if sig.is_empty() {
        return None;
    }
    let text = utf8_lossy(&body);
    let p = match parse_json(&text)? {
        Value::Object(o) => o,
        _ => return None,
    };
    let canon = canonical_json(&Value::Object(p.clone())).ok()?;
    (canon == text.as_bytes()).then_some((p, canon, sig))
}

/// Whether a lowering wire is anchored by these CRL anchors, and how (3.8, 5.4): "pending", "settled" or None.
pub fn lowering_anchored(a: &Anchors, sha: &str, w: &Map<String, Value>) -> Option<&'static str> {
    let int = |k: &str| is_int(w.get(k));
    let next = int("next_rules_version");
    if a.org_rules_pending_version != 0
        && sha == a.org_rules_pending_sha256
        && next == Some(a.org_rules_pending_version)
        && int("effective_at") == Some(a.org_rules_pending_effective_at)
        && int("exp") == Some(a.org_rules_pending_exp)
        && int("base_rules_version") == Some(a.org_rules_version)
        && str_of(w.get("base_rules_sha256")) == Some(a.org_rules_sha256.as_str())
    {
        return Some("pending");
    }
    (sha == a.org_rules_sha256 && next == Some(a.org_rules_version)).then_some("settled")
}

/// The rules in force: the IR-1 object, its version, the end of the carrier, which carrier, and a pending lowering's
/// effective time. The relay reads the rules and their ends; `version` and `carrier` are what the vectors check.
#[cfg_attr(not(test), allow(dead_code))]
pub struct CurrentRules {
    pub rules: Value,
    pub version: i64,
    pub exp: i64,
    pub carrier: &'static str,
    pub pending_effective_at: Option<i64>,
}

/// The rules every consumer applies now (5.4 order): (a) a pending lowering the CRL anchors, once `now >=
/// effective_at`; (b) otherwise the carrier the CRL's rules anchor names (an ordinary token, or the settled lowering
/// wire). The selected carrier applies only while `now < exp`. Anything not held fails closed.
pub fn current_rules(trust: &TrustStore, now: i64) -> Result<CurrentRules, LeafRefusal> {
    let org = trust.org_name.as_str();
    if trust.crl_token().is_none() || trust.crl_stale(now) {
        return Err(no("rs_crl_missing", rules_words::crl_missing(org)));
    }
    if trust.rules_conflict() {
        return Err(no("rs_rules_conflict", rules_words::conflict(org)));
    }
    let missing = || no("rs_rules_missing", rules_words::missing(org));
    let Some(a) = trust.crl_anchors().filter(|a| a.org_rules_version != 0) else { return Err(missing()) };
    let ordinary = trust.org_rules();
    let lowering = trust.rules_lowering();
    let lowering_sha = lowering.map(|w| sha256_hex(w.token.as_bytes())).unwrap_or_default();
    let int = |p: &Map<String, Value>, k: &str| is_int(p.get(k)).unwrap_or(0);
    let from_lowering = |w: &Map<String, Value>| {
        let exp = int(w, "exp");
        if now >= exp {
            return Err(no("rs_lowering_expired", rules_words::lowering_expired(org, exp)));
        }
        Ok(CurrentRules { rules: w.get("rules").cloned().unwrap_or(Value::Null), version: int(w, "next_rules_version"), exp, carrier: "lowering", pending_effective_at: None })
    };
    if a.org_rules_pending_version != 0 && now >= a.org_rules_pending_effective_at {
        return match lowering.filter(|_| lowering_sha == a.org_rules_pending_sha256) {
            Some(w) => from_lowering(&w.payload),
            None => Err(missing()),
        };
    }
    let mut selected = match (lowering, ordinary) {
        (Some(w), _) if lowering_sha == a.org_rules_sha256 && is_int(w.payload.get("next_rules_version")) == Some(a.org_rules_version) => from_lowering(&w.payload)?,
        (_, Some(r)) if sha256_hex(r.token.as_bytes()) == a.org_rules_sha256 && is_int(r.payload.get("version")) == Some(a.org_rules_version) => {
            let exp = int(&r.payload, "exp");
            if now >= exp {
                return Err(no("rs_rules_expired", rules_words::expired(org, int(&r.payload, "iat"))));
            }
            CurrentRules { rules: r.payload.get("rules").cloned().unwrap_or(Value::Null), version: int(&r.payload, "version"), exp, carrier: "ordinary", pending_effective_at: None }
        }
        _ => return Err(missing()),
    };
    if let Some(w) = lowering.filter(|_| a.org_rules_pending_version != 0 && lowering_sha == a.org_rules_pending_sha256) {
        selected.pending_effective_at = Some(int(&w.payload, "effective_at"));
    }
    Ok(selected)
}

// ── The identity map (5.3) ───────────────────────────────────────────────────────────────────────────────────

const PROVIDER_KINDS: [&str; 9] = ["entra", "logingov", "okta", "google", "keycloak", "authentik", "jumpcloud", "ping", "saml"];
const ENTRA_CLOUDS: [&str; 3] = ["global", "usgov-high", "usgov-dod"];
const MAP_MAX_PROVIDERS: usize = 4;
const MAP_MAX_GROUPS: usize = 64;
const MAP_MAX_TRUST_CERTS: usize = 4;
const MAP_CERT_MAX_BYTES: usize = 2_048;
pub const MAP_NAME_WORDS: &str = "group names can be renamed at the identity provider; map group ids";

/// Why a `lucid-idp-map` payload is not well formed (5.3 bounds, owner decision 31), or None.
pub fn idp_map_problem(p: &Map<String, Value>, root_id: &str) -> Option<String> {
    let keys = ["v", "typ", "root", "version", "iat", "providers", "piv_issuers", "piv_policy_oids", "fido2_roots", "fido2_aaguids"];
    if !exact_keys(p, &keys, &keys) || !num_is(p.get("v"), 2.0) || str_of(p.get("typ")) != Some("lucid-idp-map") || str_of(p.get("root")) != Some(root_id) {
        return Some("wrong fields, type or root (labels live only in map-labels.json)".into());
    }
    if !is_int(p.get("version")).is_some_and(|v| v >= 1) || is_int(p.get("iat")).is_none() {
        return Some("bad version or iat".into());
    }
    let Some(providers) = p.get("providers").and_then(Value::as_array).filter(|a| (1..=MAP_MAX_PROVIDERS).contains(&a.len())) else {
        return Some(format!("1 to {MAP_MAX_PROVIDERS} providers"));
    };
    let mut groups = 0;
    let (mut ids, mut isses): (Vec<Value>, Vec<String>) = (Vec::new(), Vec::new());
    for raw in providers {
        let required = ["id", "kind", "iss", "service", "poll_minutes", "outage_minutes", "groups"];
        let allowed = ["id", "kind", "cloud", "iss", "service", "poll_minutes", "outage_minutes", "groups"];
        let Some(e) = as_object(raw).filter(|e| exact_keys(e, &allowed, &required)) else {
            return Some("a provider is { id, kind, cloud?, iss, service, poll_minutes, outage_minutes, groups }".into());
        };
        let kind = str_of(e.get("kind")).unwrap_or_default();
        if !str_of(e.get("id")).is_some_and(is_provider_id) || !PROVIDER_KINDS.contains(&kind) {
            return Some("bad provider id or kind".into());
        }
        if let Some(cloud) = e.get("cloud") {
            if kind != "entra" || !cloud.as_str().is_some_and(|c| ENTRA_CLOUDS.contains(&c)) {
                return Some("cloud is only for entra: global, usgov-high or usgov-dod".into());
            }
        }
        if plain(e.get("iss"), 1, 1024).is_none() || !str_of(e.get("service")).is_some_and(|s| import_public_spki(s).is_some()) {
            return Some("bad iss or service key".into());
        }
        let poll = is_int(e.get("poll_minutes")).filter(|m| (1..=1440).contains(m));
        let outage = is_int(e.get("outage_minutes")).filter(|m| *m <= 1440);
        if poll.is_none() || outage.is_none() {
            return Some("poll_minutes 1 to 1440, outage_minutes 0 to 1440".into());
        }
        let Some(g) = e.get("groups").and_then(Value::as_object) else { return Some("groups maps immutable group ids to { clearances, scopes }".into()) };
        for (gid, grant) in g {
            if gid.starts_with("name:") {
                return Some(MAP_NAME_WORDS.into());
            }
            if !(1..=128).contains(&utf16_len(gid)) || !plain_ascii(gid) {
                return Some("a group id is 1 to 128 printable ASCII characters without quotes or backslashes".into());
            }
            let Some(grant) = as_object(grant).filter(|x| exact_keys(x, &["clearances", "scopes"], &["clearances", "scopes"])) else {
                return Some("a group maps to { clearances, scopes }".into());
            };
            let good = sorted_list(grant.get("clearances"), 3, |c| CLASSIFICATIONS.contains(&c)).is_some() && sorted_list(grant.get("scopes"), 3, |s| SCOPES.contains(&s)).is_some();
            if !good {
                return Some("clearances and scopes are sorted lists of at most 3".into());
            }
            groups += 1;
        }
        ids.push(e["id"].clone());
        let iss = str_of(e.get("iss")).unwrap_or_default().to_owned();
        if isses.contains(&iss) {
            return Some("each provider iss once".into());
        }
        isses.push(iss);
    }
    if groups > MAP_MAX_GROUPS {
        return Some(format!("at most {MAP_MAX_GROUPS} group ids in the whole map"));
    }
    if sorted_list(Some(&Value::Array(ids)), MAP_MAX_PROVIDERS, |_| true).is_none() {
        return Some("providers sorted by id, each id once".into());
    }
    let cert_ok = |s: &str| unb64u(s).is_some_and(|b| !b.is_empty() && b.len() <= MAP_CERT_MAX_BYTES);
    if sorted_list(p.get("piv_issuers"), MAP_MAX_TRUST_CERTS, cert_ok).is_none() || sorted_list(p.get("fido2_roots"), MAP_MAX_TRUST_CERTS, cert_ok).is_none() {
        return Some(format!("at most {MAP_MAX_TRUST_CERTS} piv_issuers and fido2_roots, each base64url DER of at most {MAP_CERT_MAX_BYTES} bytes"));
    }
    if sorted_list(p.get("piv_policy_oids"), 8, |s| s.len() <= 64 && is_oid(s)).is_none() {
        return Some("at most 8 piv_policy_oids of at most 64 characters".into());
    }
    if sorted_list(p.get("fido2_aaguids"), 32, is_uuid).is_none() {
        return Some("at most 32 fido2_aaguids (lower-case UUIDs)".into());
    }
    None
}

/// The map entry with this id and issuer.
fn map_provider<'a>(map: &'a Map<String, Value>, id: &str, iss: &str) -> Option<&'a Map<String, Value>> {
    map.get("providers")?.as_array()?.iter().filter_map(Value::as_object).find(|e| str_of(e.get("id")) == Some(id) && str_of(e.get("iss")) == Some(iss))
}

/// What a person gets from the groups the status names (5.3): the union over mapped groups, sorted.
pub fn grants_for(provider: &Map<String, Value>, groups: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut scopes, mut clearances): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mapped = provider.get("groups").and_then(Value::as_object);
    for g in groups {
        let Some(grant) = mapped.and_then(|m| m.get(g)) else { continue };
        scopes.extend(strings_of(grant.get("scopes")));
        clearances.extend(strings_of(grant.get("clearances")));
    }
    for l in [&mut scopes, &mut clearances] {
        l.sort();
        l.dedup();
    }
    (scopes, clearances)
}

// ── The signed-in request envelope (5.1) ─────────────────────────────────────────────────────────────────────

const ENVELOPE_KEYS: [&str; 18] = [
    "v", "typ", "request", "request_sha256", "org", "provider", "service", "iss", "sub", "email", "name", "auth_time", "methods", "groups", "groups_read_at", "active",
    "issued_at", "attestation",
];

pub fn envelope_bad_words(org: &str) -> String {
    format!("this sign-in was not attested by {org}'s identity service for this request. Nothing signed.")
}

/// True when the JSON text has an object with the same key twice (a verifier must never read a different value than
/// the signer saw).
pub fn json_has_duplicate_keys(text: &str) -> bool {
    // One frame per open object (its keys so far) or array (None); a string right after `{` or after `,` inside an
    // object is a key. Strings are skipped whole, so braces inside them never count.
    let b = text.as_bytes();
    let mut stack: Vec<Option<Vec<String>>> = Vec::new();
    let mut key_next = false;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => {
                stack.push(Some(Vec::new()));
                key_next = true;
            }
            b'[' => {
                stack.push(None);
                key_next = false;
            }
            b'}' | b']' => {
                stack.pop();
                key_next = false;
            }
            b',' => key_next = matches!(stack.last(), Some(Some(_))),
            b'"' => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                if key_next {
                    if let Some(Some(keys)) = stack.last_mut() {
                        let end = (j + 1).min(b.len());
                        let key = text.get(i..end).and_then(parse_json);
                        let Some(Value::String(key)) = key else { return true };
                        if keys.contains(&key) {
                            return true;
                        }
                        keys.push(key);
                    }
                }
                key_next = false;
                i = j;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// identity.ts `readRequest`, as far as the envelope reader needs it: a node request signed by its own P-256 key,
/// well formed (version 2 exactly for a hub's `piv` or `fido2` presence). Err is the reason.
pub fn read_request(token: &str, gates: &[String]) -> Result<Map<String, Value>, String> {
    let peek = crate::identity::peek_compact(token);
    let Some(key) = peek.as_ref().and_then(|p| str_of(p.get("spki"))).and_then(import_public_spki) else {
        return Err("request carries no P-256 public key".into());
    };
    // A version 2 request carries a PIV certificate (4,096 bytes) or a FIDO2 attestation (8,192 bytes): 16 KiB covers both.
    let Some(p) = open_compact(Some(&Value::from(token)), &key, 16_384) else { return Err("request signature does not match its key".into()) };
    let malformed = || Err("malformed request".to_string());
    let allowed = ["v", "typ", "role", "label", "spki", "iat", "enroll", "presence"];
    let v1 = num_is(p.get("v"), 1.0);
    if !exact_keys(&p, &allowed, &allowed[..6]) || !(v1 || num_is(p.get("v"), 2.0)) || str_of(p.get("typ")) != Some("lucid-node-request") {
        return malformed();
    }
    if v1 && utf16_len(token) > TOKEN_LIMITS_OTHER {
        return malformed();
    }
    let role = str_of(p.get("role")).unwrap_or_default();
    if !["hub", "spoke", "delegate"].contains(&role) || !str_of(p.get("label")).is_some_and(crate::identity::is_label) || is_int(p.get("iat")).is_none() {
        return malformed();
    }
    if let Some(e) = p.get("enroll") {
        if !e.as_str().is_some_and(|e| (1..=128).contains(&e.len()) && e.bytes().all(|c| (0x21..=0x7e).contains(&c))) {
            return malformed();
        }
    }
    if !v1 {
        // 4.2: version 2 exactly when the presence is piv or fido2, and only from a hub.
        let Some(presence) = p.get("presence").filter(|_| role == "hub") else {
            return Err("malformed request: a version 2 request is a hub's with a piv or fido2 presence".into());
        };
        crate::presence::read_request_presence(presence, None, gates).map_err(|r| r.reason)?;
    } else if let Some(presence) = p.get("presence") {
        let kind = presence.as_object().and_then(|o| str_of(o.get("kind")));
        if matches!(kind, Some("piv" | "fido2")) {
            return Err("malformed request: a piv or fido2 presence needs a version 2 request".into());
        }
        if role != "hub" || !presence_public_key_ok(presence, gates) {
            return Err("malformed request: only a hub carries a presence key, and it must be well formed".into());
        }
    }
    Ok(p)
}

/// 5.1, in this order: `read_request(request)`; the envelope's exact keys (no duplicates); the service signature with
/// the `service` key of the map entry whose `id` and `iss` match; `request_sha256`; `active == true`; `issued_at`
/// within 300 seconds of now. Every identity value comes from inside the signed envelope. The root reads envelopes
/// (`root approve --signin`); the relay runs this only on the shared vectors.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_idp_envelope(text: &str, map: &Map<String, Value>, now: i64, org: &str, gates: &[String]) -> Result<Map<String, Value>, LeafRefusal> {
    let bad = || no("rs_envelope_bad", envelope_bad_words(org));
    if utf16_len(text) > TOKEN_LIMITS_LEAF || json_has_duplicate_keys(text) {
        return Err(bad());
    }
    let Some(Value::Object(e)) = parse_json(text) else { return Err(bad()) };
    let request = str_of(e.get("request")).unwrap_or_default();
    if str_of(e.get("request")).is_none() || read_request(request, gates).is_err() {
        return Err(bad());
    }
    if !exact_keys(&e, &ENVELOPE_KEYS, &ENVELOPE_KEYS) || !num_is(e.get("v"), 1.0) || str_of(e.get("typ")) != Some("lucid-idp-node-request") || e.get("org") != map.get("root") {
        return Err(bad());
    }
    let (Some(pid), Some(iss)) = (str_of(e.get("provider")), str_of(e.get("iss"))) else { return Err(bad()) };
    let Some(provider) = map_provider(map, pid, iss).filter(|p| p.get("service") == e.get("service")) else { return Err(bad()) };
    let key = str_of(provider.get("service")).and_then(import_public_spki);
    let att = str_of(e.get("attestation")).filter(|a| {
        let t = a.trim_end_matches('=');
        !t.is_empty() && a.len() - t.len() <= 2 && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    });
    let sig = att.map(crate::codec::b64_decode_lenient);
    let mut unsigned = e.clone();
    unsigned.remove("attestation");
    let good = match (key, sig, canonical_json(&Value::Object(unsigned))) {
        (Some(k), Some(s), Ok(canon)) => ecdsa_verify(&k, &lp(&[b"lucid-rs-idp-attest-v2", &canon]), &s),
        _ => false,
    };
    if !good || str_of(e.get("request_sha256")) != Some(sha256_hex(request.as_bytes()).as_str()) {
        return Err(bad());
    }
    let sub_ok = str_of(e.get("sub")).is_some_and(|s| (1..=255).contains(&utf16_len(s)));
    let email_ok = str_of(e.get("email")).is_some_and(is_email);
    let name_ok = str_of(e.get("name")).is_some_and(|n| utf16_len(n) <= 128);
    if !sub_ok || !email_ok || !name_ok {
        return Err(bad());
    }
    let ints = ["auth_time", "groups_read_at", "issued_at"].iter().all(|k| is_int(e.get(*k)).is_some());
    if !ints || !methods_well_formed(e.get("methods"), 32, 256) || sorted_list(e.get("groups"), 200, |g| (1..=256).contains(&utf16_len(g))).is_none() {
        return Err(bad());
    }
    match e.get("active") {
        Some(Value::Bool(true)) => {}
        Some(Value::Bool(false)) => return Err(no("rs_account_off", "this account is turned off at the identity provider; nothing signed")),
        _ => return Err(bad()),
    }
    if (now - is_int(e.get("issued_at")).unwrap_or(0)).abs() > ENVELOPE_MAX_SKEW_SEC {
        return Err(bad());
    }
    Ok(e)
}

// ── The renewal anchor, the status token and the nine checks (5.5) ───────────────────────────────────────────

/// Why a certificate's `idp` claim is not well formed, or None.
pub fn idp_claim_problem(v: &Value) -> Option<String> {
    let keys = ["provider", "iss", "sub", "auth_time", "map_version"];
    let Some(o) = as_object(v).filter(|o| exact_keys(o, &keys, &keys)) else { return Some("an idp claim is { provider, iss, sub, auth_time, map_version }".into()) };
    if !str_of(o.get("provider")).is_some_and(is_provider_id) {
        return Some("bad provider".into());
    }
    if plain(o.get("iss"), 1, 1024).is_none() || plain(o.get("sub"), 1, 255).is_none() {
        return Some("bad iss or sub".into());
    }
    if is_int(o.get("auth_time")).is_none() || !is_int(o.get("map_version")).is_some_and(|v| v >= 1) {
        return Some("bad auth_time or map_version".into());
    }
    None
}

/// Why a leaf's `renewal` is not `{ anchor, status, piv_ocsp? }`, or None.
pub fn renewal_shape_problem(v: &Value) -> Option<String> {
    let Some(o) = as_object(v).filter(|o| exact_keys(o, &["anchor", "status", "piv_ocsp"], &["anchor", "status"])) else {
        return Some("renewal is { anchor, status, piv_ocsp? }".into());
    };
    if !o["anchor"].is_string() || !o["status"].is_string() {
        return Some("bad anchor or status".into());
    }
    if let Some(ocsp) = o.get("piv_ocsp") {
        if !ocsp.as_str().is_some_and(|s| (1..=8192).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')) {
            return Some("bad piv_ocsp".into());
        }
    }
    None
}

fn anchor_problem(p: &Map<String, Value>, root_id: &str, gates: &[String]) -> Option<&'static str> {
    let required = ["v", "typ", "root", "serial", "node", "spki", "user", "idp", "map_version", "iat", "exp"];
    let allowed = ["v", "typ", "root", "serial", "node", "spki", "user", "idp", "map_version", "iat", "exp", "presence", "piv_cert"];
    if !exact_keys(p, &allowed, &required) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-idp-renew-anchor") || str_of(p.get("root")) != Some(root_id) {
        return Some("wrong fields, type or root");
    }
    let (Some(_), Some(node), Some(spki)) = (str_of(p.get("serial")).filter(|s| is_serial(s)), str_of(p.get("node")), str_of(p.get("spki"))) else {
        return Some("bad serial, node or key");
    };
    if !unb64u(spki).is_some_and(|der| import_public_spki(spki).is_some() && node_id_of(&der) == node) {
        return Some("the anchor's key does not match its node");
    }
    if !matches!((is_int(p.get("iat")), is_int(p.get("exp"))), (Some(i), Some(x)) if x > i && x - i <= ANCHOR_MAX_DAYS * DAY) {
        return Some("an anchor lasts at most 90 days");
    }
    if p.get("presence").is_some_and(|pr| !presence_public_key_ok(pr, gates)) {
        return Some("bad presence");
    }
    if p.get("user").is_none_or(|u| user_problem(u).is_some()) {
        return Some("bad user");
    }
    let idp = p.get("idp").and_then(Value::as_object).filter(|o| exact_keys(o, &["provider", "iss", "sub"], &["provider", "iss", "sub"]));
    if !idp.is_some_and(|o| str_of(o.get("provider")).is_some_and(is_provider_id) && plain(o.get("iss"), 1, 1024).is_some() && plain(o.get("sub"), 1, 255).is_some()) {
        return Some("bad idp");
    }
    if !is_int(p.get("map_version")).is_some_and(|v| v >= 1) {
        return Some("bad map_version");
    }
    let piv = presence_kind(p.get("presence")) == Some("piv");
    if piv != p.contains_key("piv_cert") {
        return Some("piv_cert is present exactly when the presence is piv");
    }
    if piv {
        let cert = str_of(p.get("piv_cert")).unwrap_or_default();
        if !unb64u(cert).is_some_and(|der| !der.is_empty() && der.len() <= PIV_CERT_MAX_BYTES && b64u(&der) == cert) {
            return Some("piv_cert is base64url DER of at most 4,096 bytes");
        }
    }
    None
}

fn presence_kind(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_object).and_then(|o| str_of(o.get("kind")))
}

/// A verified anchor: its payload and, for a `piv` presence, the card certificate and its issuer.
type Anchor = (Map<String, Value>, Option<(X509Info, X509Info)>);

/// 5.5 `verifyRenewAnchor`: root signature; exact keys and `typ`; the pinned root; `node` is the key's id; `iat <=
/// leaf_iat <= exp`; serial not revoked; presence well formed; for `piv`, the card certificate bound to the presence
/// (hash and SPKI), issued by a `piv_issuers` certificate, digital-signature key usage, an allowed policy OID, RSA
/// 2048 to 4096 or P-256, and both certificates valid at `leaf_iat`. Err is the 6.9 event.
fn verify_renew_anchor(trust: &TrustStore, token: Option<&Value>, leaf_iat: i64, map: &Map<String, Value>) -> Result<Anchor, &'static str> {
    let Some(p) = open_compact(token, trust.root_key(), TOKEN_LIMITS_ANCHOR) else { return Err("rs_anchor_bad") };
    if anchor_problem(&p, &trust.root_id, trust.gates()).is_some() {
        // A card key over RSA 4096 makes the presence itself unreadable; name the size, as 6.9 does (rs_piv_key_size).
        let card = str_of(p.get("piv_cert")).map(|c| parse_cert(&unb64u(c).unwrap_or_default()));
        let size = card.flatten().is_some_and(|c| piv_key_problem(&c.spki_der) == Some("size"));
        return Err(if size { "rs_piv_key_size" } else { "rs_anchor_bad" });
    }
    let (iat, exp) = (is_int(p.get("iat")).unwrap_or(0), is_int(p.get("exp")).unwrap_or(0));
    if leaf_iat < iat || leaf_iat > exp || trust.is_revoked(str_of(p.get("serial")).unwrap_or_default()) {
        return Err("rs_anchor_bad");
    }
    if presence_kind(p.get("presence")) != Some("piv") {
        return Ok((p, None));
    }
    let presence = p.get("presence").and_then(Value::as_object).cloned().unwrap_or_default();
    let der = unb64u(str_of(p.get("piv_cert")).unwrap_or_default()).unwrap_or_default();
    let spki = unb64u(str_of(presence.get("spki")).unwrap_or_default()).unwrap_or_default();
    let Some(card) = parse_cert(&der).filter(|c| str_of(presence.get("cert_sha256")) == Some(sha256_hex(&der).as_str()) && c.spki_der == spki) else {
        return Err("rs_anchor_bad");
    };
    let issuers = strings_of(map.get("piv_issuers"));
    let issuer = issuers.iter().filter_map(|s| parse_cert(&unb64u(s).unwrap_or_default())).find(|i| cert_signed_by(&card, i));
    let oids = strings_of(map.get("piv_policy_oids"));
    let Some(issuer) = issuer.filter(|_| has_digital_signature(&card) && card.policy_oids.iter().any(|o| oids.contains(o))) else { return Err("rs_anchor_bad") };
    match piv_key_problem(&card.spki_der) {
        Some("size") => return Err("rs_piv_key_size"),
        Some(_) => return Err("rs_anchor_bad"),
        None => {}
    }
    if !valid_at(&card, leaf_iat) || !valid_at(&issuer, leaf_iat) {
        return Err("rs_piv_cert_expired");
    }
    Ok((p, Some((card, issuer))))
}

const STATUS_KEYS: [&str; 14] =
    ["v", "typ", "org", "provider", "iss", "sub", "node", "request_sha256", "methods", "groups", "groups_read_at", "auth_time", "active", "issued_at"];

/// Open a status token with the map's service key: at most 16,896 characters, payload exactly its CE-1 bytes, the
/// service signature over lp("lucid-idp-renew-status-v1", canonical_json(payload)), exact keys, every string printable
/// ASCII without `"` or `\`, at most 16 methods and 64 groups of 128. `active` is returned as read.
fn read_renew_status(token: Option<&Value>, service_spki: &str) -> Option<Map<String, Value>> {
    let token = token?.as_str().filter(|t| utf16_len(t) <= TOKEN_LIMITS_STATUS)?;
    let key = import_public_spki(service_spki)?;
    let (p, canon, sig) = canonical_part(token)?;
    if !ecdsa_verify(&key, &lp(&[b"lucid-idp-renew-status-v1", &canon]), &sig) {
        return None;
    }
    if !exact_keys(&p, &STATUS_KEYS, &STATUS_KEYS) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some("lucid-idp-renew-status") {
        return None;
    }
    if plain(p.get("org"), 1, 64).is_none() || !str_of(p.get("provider")).is_some_and(is_provider_id) || plain(p.get("iss"), 1, 1024).is_none() || plain(p.get("sub"), 1, 255).is_none() {
        return None;
    }
    if !str_of(p.get("node")).is_some_and(is_node_id) || !str_of(p.get("request_sha256")).is_some_and(is_hex64) {
        return None;
    }
    let short = |s: &str| (1..=128).contains(&utf16_len(s)) && plain_ascii(s);
    if sorted_list(p.get("methods"), 16, short).is_none() || !methods_well_formed(p.get("methods"), 16, 128) || sorted_list(p.get("groups"), 64, short).is_none() {
        return None;
    }
    if ["groups_read_at", "auth_time", "issued_at"].iter().any(|k| is_int(p.get(*k)).is_none()) || !p.get("active").is_some_and(Value::is_boolean) {
        return None;
    }
    Some(p)
}

/// ID-1 5.5 "Independent rule enforcement": the renewed leaf `c` (payload `p`) signed by the idp-renew delegation `d`,
/// judged against the map and current rules the held CRL anchors, by this verifier alone. The first failing check
/// decides the words. Ok is `valid_until`, the earliest end of every input (the relay cache bound).
pub fn check_renewed_leaf(trust: &TrustStore, c: &NodeCert, p: &Map<String, Value>, d: &Delegation, now: i64) -> Result<i64, LeafRefusal> {
    let org = trust.org_name.as_str();
    let refuse = |event: &'static str| leaf_refusal(event, org, "");
    let rule = |name: &str| leaf_refusal("rs_renewal_rule", org, name);
    // Before check 1: the anchored map and rules must be held and current.
    let rules = current_rules(trust, now)?;
    let Some(held) = trust.idp_map() else { return Err(no("rs_rules_missing", rules_words::missing(org))) };
    let map = &held.payload;
    // 1. The delegation is exactly idp-renew; the leaf lasts at most 24 hours and sits inside the delegation.
    if d.may.len() != 1 || d.may[0] != "idp-renew" {
        return Err(refuse("rs_renewal_wrong_power"));
    }
    let (idp, renewal) = (p.get("idp").and_then(Value::as_object), p.get("renewal").and_then(Value::as_object));
    let (Some(idp), Some(renewal), Some(user)) = (idp, renewal, c.user.as_ref()) else { return Err(refuse("rs_renewal_bad")) };
    if c.exp - c.iat > IDP_CERT_MAX_SEC || c.role != "hub" || leaf_problem(d, c, true).is_some() {
        return Err(refuse("rs_renewal_bad"));
    }
    // 2. The anchor, and the leaf's node, key, presence, user and sign-in equal to the anchor's.
    let (a, piv) = verify_renew_anchor(trust, renewal.get("anchor"), c.iat, map).map_err(refuse)?;
    let a_exp = is_int(a.get("exp")).unwrap_or(0);
    // The anchor also ends the leaf it backs: past its exp now, the leaf is refused even inside its 24 hours.
    if now >= a_exp {
        return Err(refuse("rs_anchor_bad"));
    }
    let a_idp = a.get("idp").and_then(Value::as_object).cloned().unwrap_or_default();
    let a_email = a.get("user").and_then(Value::as_object).and_then(|u| str_of(u.get("email")));
    let same = |k: &str| str_of(idp.get(k)) == str_of(a_idp.get(k));
    if str_of(a.get("node")) != Some(c.node.as_str())
        || p.get("spki") != a.get("spki")
        || !same_json(p.get("presence"), a.get("presence"))
        || a_email != Some(user.email.as_str())
        || !same("provider")
        || !same("iss")
        || !same("sub")
    {
        return Err(refuse("rs_renewal_bad"));
    }
    // 3. The status token, by the held map's service key for this provider (map version equal to the leaf's).
    let (pid, iss) = (str_of(idp.get("provider")).unwrap_or_default(), str_of(idp.get("iss")).unwrap_or_default());
    let Some(provider) = map_provider(map, pid, iss).filter(|_| is_int(idp.get("map_version")) == is_int(map.get("version"))) else {
        return Err(refuse("rs_renewal_bad"));
    };
    let status = read_renew_status(renewal.get("status"), str_of(provider.get("service")).unwrap_or_default());
    let Some(s) = status.filter(|s| {
        str_of(s.get("org")) == Some(trust.root_id.as_str())
            && str_of(s.get("node")) == Some(c.node.as_str())
            && s.get("active") == Some(&Value::Bool(true))
            && ["provider", "iss", "sub"].iter().all(|k| str_of(s.get(*k)) == str_of(a_idp.get(*k)))
    }) else {
        return Err(refuse("rs_renewal_bad"));
    };
    let int = |k: &str| is_int(s.get(k)).unwrap_or(0);
    let (issued_at, groups_read_at, auth_time) = (int("issued_at"), int("groups_read_at"), int("auth_time"));
    if c.iat < issued_at || c.iat - issued_at > ENVELOPE_MAX_SKEW_SEC {
        return Err(refuse("rs_renewal_bad"));
    }
    let window = (is_int(provider.get("poll_minutes")).unwrap_or(0) + is_int(provider.get("outage_minutes")).unwrap_or(0)) * 60;
    if groups_read_at > c.iat || c.iat - groups_read_at > window {
        return Err(refuse("rs_renewal_bad"));
    }
    // 4. Scopes and clearances exactly what the map gives for the status groups (each one mapped).
    let groups = strings_of(s.get("groups"));
    let mapped = provider.get("groups").and_then(Value::as_object);
    if groups.iter().any(|g| !mapped.is_some_and(|m| m.contains_key(g))) {
        return Err(refuse("rs_renewal_bad"));
    }
    let (scopes, clearances) = grants_for(provider, &groups);
    let mut have_scopes = c.scopes.clone();
    have_scopes.sort();
    let mut have_clearances = user.clearances.clone().unwrap_or_default();
    have_clearances.sort();
    if scopes.is_empty() || have_scopes != scopes || have_clearances != clearances {
        return Err(refuse("rs_renewal_bad"));
    }
    // 5. The provider is in the rules' effective set (an absent list: every provider the map registers).
    let r = rules.rules.as_object().cloned().unwrap_or_default();
    let effective: Vec<(String, String, Vec<String>)> = match r.get("providers").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(Value::as_object)
            .map(|e| (str_of(e.get("id")).unwrap_or_default().to_owned(), str_of(e.get("iss")).unwrap_or_default().to_owned(), strings_of(e.get("phr_values"))))
            .collect(),
        None => map
            .get("providers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|e| (str_of(e.get("id")).unwrap_or_default().to_owned(), str_of(e.get("iss")).unwrap_or_default().to_owned(), Vec::new()))
            .collect(),
    };
    let Some((_, _, phr)) = effective.iter().find(|(id, i, _)| id == pid && i == iss) else { return Err(rule("providers")) };
    // 6. Phishing-resistant evidence.
    if r.get("require_phishing_resistant") == Some(&Value::Bool(true)) && !methods_pass(phr, &strings_of(s.get("methods"))) {
        return Err(rule("require_phishing_resistant"));
    }
    // 7. The last interactive sign-in.
    if let Some(days) = r.get("signin_max_days").and_then(Value::as_i64) {
        if c.iat - auth_time > days * DAY {
            return Err(rule("signin_max_days"));
        }
    }
    // 8. Passwordless presence after enforce_at, unless an exception names this node past leaf.iat.
    if let Some(u) = r.get("passwordless_unlock").and_then(Value::as_object) {
        let enforce = u.get("enforce_at").and_then(Value::as_i64);
        if u.get("required") == Some(&Value::Bool(true)) && enforce.is_some_and(|e| c.iat >= e) {
            let kind = presence_kind(p.get("presence"));
            let excepted = u
                .get("exceptions")
                .and_then(Value::as_array)
                .is_some_and(|l| l.iter().any(|e| str_of(e.get("device")) == Some(c.node.as_str()) && e.get("until").and_then(Value::as_i64).is_some_and(|t| t > c.iat)));
            if matches!(kind, None | Some("password")) && !excepted {
                return Err(rule("passwordless_unlock"));
            }
            if let Some(kinds) = u.get("kinds") {
                let listed = kind.is_some_and(|k| strings_of(Some(kinds)).iter().any(|x| x == k));
                if trust.gate("G-KIND") && !listed && !excepted {
                    return Err(rule("passwordless_unlock"));
                }
            }
        }
    }
    // 9. PIV status: the issuer's OCSP response for exactly the anchor's card, judged at leaf.iat.
    let mut valid_until = c.exp.min(a_exp).min(rules.exp);
    if let Some(at) = rules.pending_effective_at.filter(|at| *at > now) {
        valid_until = valid_until.min(at);
    }
    let ocsp = str_of(renewal.get("piv_ocsp"));
    match piv {
        Some((card, issuer)) => {
            let Some(der) = ocsp.and_then(unb64u).filter(|der| ocsp == Some(b64u(der).as_str())) else { return Err(refuse("rs_renewal_piv_status")) };
            let st = verify_ocsp(&der, &card, &issuer, c.iat, 0).map_err(|why| refuse(if why == "certid" { "rs_piv_certid" } else { "rs_renewal_piv_status" }))?;
            valid_until = valid_until.min(st.produced_at + DAY).min(card.not_after).min(issuer.not_after);
            if let Some(n) = st.next_update {
                valid_until = valid_until.min(n);
            }
        }
        None if renewal.contains_key("piv_ocsp") => return Err(refuse("rs_renewal_bad")),
        None => {}
    }
    Ok(valid_until)
}

/// The spoke's `engine.decide` body bound (carriers row 9): the 6.9 refusal for a body over MAX_DECISION_BYTES. The
/// relay never decides; it runs this only on the shared vectors.
#[cfg_attr(not(test), allow(dead_code))]
pub fn decision_size_problem(body: &str) -> Option<LeafRefusal> {
    (body.len() > MAX_DECISION_BYTES).then(|| no("rs_decision_too_large", "this decision is larger than Lucid accepts"))
}
