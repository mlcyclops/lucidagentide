// Contract API-1 2 and 3.2: the org `api` map (signed envelope `{map, sig, chain}`, bytes
// `lp("lucid-meet-org-api-v1", canonical JSON of map)`), its field rules (2.2) and edition limits (13), seq pinning
// (2.4), the tightening journal and folding (2.5), and the effective end of a credential under the admin grace (3.2).
// Mirrors the AI map of meet_org_policy.rs (check_ai_map, verify_ai_map, AiMapStore). A relay keeps per org the
// pinned map and the previous one in `api-maps/<org>.json` and its applied journal in `api-journal/<org>.json`, both
// flushed to disk before it answers.

use crate::codec::sha256_hex;
use crate::meet_json as pj;
use crate::meet_org_policy::{self as op, canonical_json, lp, Obj};
use crate::meet_x509::{ecdsa_sha256_verified, Cert, Crl};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

pub const API_MAP_LABEL: &str = "lucid-meet-org-api-v1";
/// The canonical JSON of a map (2.2 "whole map").
pub const API_MAP_MAX: usize = 256 * 1024;
/// A signed envelope: the map plus its signature and chain.
const API_WIRE_MAX: usize = API_MAP_MAX + 64 * 1024;
/// Orgs whose maps one relay holds (2.4).
pub const API_MAP_ORGS_MAX: usize = 64;
pub const GRACE_KINDS: [&str; 4] = ["person", "app", "connector", "relay"];
/// D15: at most 7 days.
pub const GRACE_MAX_HOURS: i64 = 168;
const SKEW: i64 = 300;
const MAX_INT: i64 = (1 << 53) - 1;
const DAY: i64 = 86400;

const WIRE_KEYS: &[&str] = &["map", "sig", "chain"];
const MAP_KEYS: &[&str] = &[
    "v",
    "org",
    "seq",
    "issued",
    "expires",
    "issuer",
    "grace",
    "failover_after_s",
    "folded",
    "cleared",
    "relay_origins",
    "clients",
    "scrape_tokens",
    "destinations",
];
const MAP_REQUIRED: &[&str] = &["v", "org", "seq", "issued", "expires", "issuer", "grace", "failover_after_s"];
const ISSUER_KEYS: &[&str] = &["url", "jwks"];
const JWK_KEYS: &[&str] = &["kty", "crv", "kid", "x", "y", "use", "alg", "nbf", "exp"];
const CLIENT_KEYS: &[&str] = &[
    "id",
    "name",
    "principal",
    "kind",
    "owner",
    "reach",
    "scopes",
    "ceiling",
    "relays",
    "networks",
    "hours",
    "mtls_required",
    "rate",
    "credentials",
    "created",
    "expires",
    "state",
];
const CLIENT_REQUIRED: &[&str] = &[
    "id",
    "name",
    "principal",
    "kind",
    "owner",
    "reach",
    "scopes",
    "ceiling",
    "relays",
    "networks",
    "mtls_required",
    "rate",
    "credentials",
    "created",
    "expires",
    "state",
];
const HOURS_KEYS: &[&str] = &["tz", "from", "to", "days"];
const RATE_KEYS: &[&str] = &["per_minute_each", "per_day_each"];
const SCRAPE_KEYS: &[&str] = &["sha256", "hint", "label", "relays", "expires"];
const DEST_KEYS: &[&str] = &[
    "id",
    "name",
    "kind",
    "preset",
    "signals",
    "ceiling",
    "identities",
    "failover",
    "private_ok",
    "endpoint",
    "settings",
    "credential",
    "queue",
];
const DEST_REQUIRED: &[&str] = &["id", "name", "kind", "preset", "signals", "ceiling", "identities", "failover", "private_ok", "credential", "queue"];
const QUEUE_KEYS: &[&str] = &["max_bytes", "max_age_s"];

/// Section 6.3.
pub const SCOPES: [&str; 4] = ["monitor.read", "fleet.read", "audit.read", "events.subscribe"];
const STANDARD_SCOPES: [&str; 3] = ["monitor.read", "fleet.read", "audit.read"];
const SECRET_SCOPES: [&str; 3] = ["monitor.read", "audit.read", "events.subscribe"];
/// Lowest first.
pub const CEILINGS: [&str; 4] = ["public", "internal", "confidential", "cui"];
const KINDS: [&str; 7] = ["monitoring", "compliance", "integration", "app", "agent", "agent_delegated", "spokes_hub"];
const KINDS_1A: [&str; 2] = ["monitoring", "integration"];
/// Least strict first.
pub const IDENTITIES: [&str; 3] = ["as_is", "pseudonymized", "removed"];
const SIGNALS: [&str; 4] = ["metrics", "logs", "traces", "audit"];
const CRED_TYPES: [&str; 4] = ["mtls", "private_key_jwt", "federated", "client_secret"];
const FED_ALGS: [&str; 3] = ["ES256", "RS256", "PS256"];
const OTLP_PRESETS: [&str; 14] = [
    "azure_monitor",
    "azure_monitor_gov",
    "splunk_observability",
    "datadog",
    "elastic",
    "dynatrace",
    "new_relic",
    "grafana_cloud",
    "honeycomb",
    "sumo_logic",
    "cloudwatch",
    "cloudwatch_gov",
    "google_cloud",
    "otlp_generic",
];
const TOKEN_PRESETS: [&str; 10] =
    ["splunk_hec", "splunk_cloud_gov", "datadog", "new_relic", "dynatrace", "elastic", "grafana_cloud", "honeycomb", "sumo_logic", "splunk_observability"];
const SECRET_DAYS_MAX: i64 = 90;
const JWKS_SPAN_MAX: i64 = 400 * DAY;
const CLIENT_SPAN_MAX: i64 = 31_622_400;
const URL_MAX: usize = 2048;

// ---- errors -----------------------------------------------------------------------------------------------------

/// A refusal: `code` is the shared word of the contract (`bad-map`, `grace-limit`, `license`, `issuer-taken`,
/// `fold-mismatch`, `signature`, `seq-not-higher`, `conflict`, `map-expired`, `tseq-gap`, `not-tightening`, and
/// `io` when the relay cannot flush its store).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiMapError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ApiMapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiMapError {}

impl ApiMapError {
    pub fn new(code: &'static str, message: impl Into<String>) -> ApiMapError {
        ApiMapError { code, message: message.into() }
    }
}

type Res<T> = Result<T, ApiMapError>;

fn fail<T>(code: &'static str, message: impl Into<String>) -> Res<T> {
    Err(ApiMapError::new(code, message))
}

fn bad<T>(message: impl Into<String>) -> Res<T> {
    fail("bad-map", message)
}

fn bad_e(message: impl Into<String>) -> ApiMapError {
    ApiMapError::new("bad-map", message)
}

fn sig_e(message: impl Into<String>) -> ApiMapError {
    ApiMapError::new("signature", message)
}

/// Section 13: the relay license's `edition`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Standard,
    Enterprise,
}

impl Edition {
    /// "standard" is Standard; anything else (and no license edition) is Enterprise.
    pub fn of(edition: Option<&str>) -> Edition {
        if edition == Some("standard") {
            Edition::Standard
        } else {
            Edition::Enterprise
        }
    }
}

// ---- small checks -----------------------------------------------------------------------------------------------

fn obj_of<'a>(v: &'a Value, allowed: &[&str], required: &[&str], what: &str) -> Res<&'a Obj> {
    let Some(o) = v.as_object() else { return bad(format!("{what} must be an object")) };
    if let Some(k) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
        return bad(format!("{what} has an unknown field {k}"));
    }
    if let Some(k) = required.iter().find(|k| !o.contains_key(**k)) {
        return bad(format!("{what} needs {k}"));
    }
    Ok(o)
}

/// A JSON integer (never a boolean or a float).
fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

fn int_in(v: Option<&Value>, what: &str, low: i64, high: i64) -> Res<i64> {
    v.and_then(int_of).filter(|n| (low..=high).contains(n)).ok_or_else(|| bad_e(format!("{what} must be a whole number from {low} to {high}")))
}

fn bool_of(v: Option<&Value>, what: &str) -> Res<bool> {
    v.and_then(Value::as_bool).ok_or_else(|| bad_e(format!("{what} must be true or false")))
}

/// `low` to `high` printable ASCII characters (space to `~`).
fn ascii_text(s: &str, low: usize, high: usize) -> bool {
    (low..=high).contains(&s.len()) && s.bytes().all(|b| (b' '..=b'~').contains(&b))
}

fn text<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize) -> Res<&'a str> {
    v.and_then(Value::as_str)
        .filter(|s| ascii_text(s, low, high))
        .ok_or_else(|| bad_e(format!("{what} must be printable text of {low} to {high} characters")))
}

fn one_of<'a>(v: Option<&'a Value>, set: &[&str], what: &str) -> Res<&'a str> {
    v.and_then(Value::as_str).filter(|s| set.contains(s)).ok_or_else(|| bad_e(format!("{what} must be one of {}", set.join(", "))))
}

fn hex_n(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `[a-z0-9-]{1,max}`.
fn slug(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `[A-Za-z0-9._-]{1,max}`.
fn token(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Base64url without padding.
fn b64u(s: &str, low: usize, high: usize) -> bool {
    (low..=high).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<prefix>` plus 16 lowercase hex.
fn prefixed_id(v: &Value, prefix: &str) -> bool {
    v.as_str().and_then(|s| s.strip_prefix(prefix)).is_some_and(|h| hex_n(h, 16))
}

/// `host:port`: a DNS name, IPv4 address or bracketed IPv6 address, and a port 1 to 65535 without a leading zero.
fn authority_ok(a: &str) -> bool {
    let Some((host, port)) = a.rsplit_once(':') else { return false };
    let port_ok = (1..=5).contains(&port.len())
        && port.bytes().all(|b| b.is_ascii_digit())
        && !port.starts_with('0')
        && port.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
    if !port_ok {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().is_ok();
    }
    op::is_domain(host) || host.parse::<Ipv4Addr>().is_ok()
}

/// `https://<host>:<port>` and nothing after it.
fn origin_ok(s: &str) -> bool {
    s.len() <= 256 && s.strip_prefix("https://").is_some_and(|a| !a.contains('/') && authority_ok(a))
}

/// `https://` + a DNS name, IPv4 or bracketed IPv6 address, an optional `:port` and an optional path; printable
/// ASCII without spaces, at most 2048 characters, no user info, query or fragment.
fn https_url_ok(s: &str) -> bool {
    if s.len() > URL_MAX || !s.bytes().all(|b| b.is_ascii_graphic()) || s.contains(['@', '?', '#']) {
        return false;
    }
    let Some(rest) = s.strip_prefix("https://") else { return false };
    let auth = rest.split_once('/').map_or(rest, |(a, _)| a);
    if auth.rsplit(']').next().unwrap_or_default().contains(':') {
        return origin_ok(&format!("https://{auth}"));
    }
    if let Some(inner) = auth.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().is_ok();
    }
    op::is_domain(auth) || auth.parse::<Ipv4Addr>().is_ok()
}

/// Python `ipaddress.ip_network(s)` (strict): an address and a prefix length with no host bits set.
fn cidr_ok(s: &str) -> bool {
    let Some((addr, len)) = s.split_once('/') else { return false };
    if len.is_empty() || len.len() > 3 || !len.bytes().all(|b| b.is_ascii_digit()) || (len.len() > 1 && len.starts_with('0')) {
        return false;
    }
    let Ok(len) = len.parse::<u32>() else { return false };
    if let Ok(a) = addr.parse::<Ipv4Addr>() {
        let bits = u32::from(a);
        return len <= 32 && (len == 32 || bits & (u32::MAX >> len) == 0);
    }
    if let Ok(a) = addr.parse::<Ipv6Addr>() {
        let bits = u128::from(a);
        return len <= 128 && (len == 128 || bits & (u128::MAX >> len) == 0);
    }
    false
}

/// An IANA zone name: `[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}`, at most 64 characters.
fn tz_ok(s: &str) -> bool {
    let part = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'));
    let parts: Vec<&str> = s.split('/').collect();
    s.len() <= 64 && parts.len() <= 3 && parts.iter().all(|p| part(p)) && s.as_bytes()[0].is_ascii_alphabetic()
}

/// `HH:MM`, 00:00 to 23:59.
fn hhmm_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()) && s[..2] < *"24" && s[3..] < *"60"
}

/// A list of `low..=high` items, each passing `ok`, no two equal.
fn list<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize) -> Res<&'a [Value]> {
    let empty: &'a [Value] = &[];
    let Some(a) = v.map_or(Some(empty), |v| v.as_array().map(Vec::as_slice)) else {
        return bad(format!("{what} must be a list"));
    };
    if !(low..=high).contains(&a.len()) {
        return bad(format!("{what} must list {low} to {high} entries"));
    }
    Ok(a)
}

fn unique<T: Ord>(items: impl IntoIterator<Item = T>) -> bool {
    let mut seen = BTreeSet::new();
    items.into_iter().all(|i| seen.insert(i))
}

fn strings<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize, ok: impl Fn(&str) -> bool) -> Res<Vec<&'a str>> {
    let a = list(v, what, low, high)?;
    let out: Vec<&str> = a.iter().filter_map(Value::as_str).filter(|s| ok(s)).collect();
    if out.len() != a.len() || !unique(out.iter()) {
        return bad(format!("{what} lists a bad or repeated entry"));
    }
    Ok(out)
}

/// `["*"]` or 1 to 64 relay ids of the org: `console` or a `relay_origins` key.
fn relays_ok(v: Option<&Value>, what: &str, origins: &Obj) -> Res<()> {
    if v.and_then(Value::as_array).is_some_and(|a| a.len() == 1 && a[0] == "*") {
        return Ok(());
    }
    strings(v, what, 1, 64, |s| s == "console" || origins.contains_key(s)).map(|_| ())
}

/// A tightening id of `org` a map may list: `t_<org>_<6 digits>`, not 000000.
fn tighten_id_ok(s: &str, org: &str) -> bool {
    tighten_id_parts(s).is_some_and(|(o, n)| o == org && n > 0)
}

/// `(org, tseq)` of `t_<org>_<tseq as 6 digits>`.
fn tighten_id_parts(s: &str) -> Option<(&str, u64)> {
    let (org, digits) = s.strip_prefix("t_")?.rsplit_once('_')?;
    if !slug(org, 32) || digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((org, digits.parse().ok()?))
}

fn rank(set: &[&str], v: &str) -> Option<usize> {
    set.iter().position(|s| *s == v)
}

fn policy_domains(policy: &Obj) -> Vec<&str> {
    policy.get("domains").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

/// The names (principal local parts) of the policy's `ai` apps.
fn ai_app_names(policy: &Obj) -> Vec<&str> {
    let apps = policy.get("apps").and_then(Value::as_array).into_iter().flatten();
    apps.filter(|a| a.get("type").and_then(Value::as_str) == Some("ai"))
        .filter_map(|a| a.get("principal").and_then(Value::as_str))
        .map(|p| p.split('@').next().unwrap_or_default())
        .collect()
}

// ---- 2.2: the map's fields ----------------------------------------------------------------------------------------

/// Contract 2.2 and 13: every field rule of the map at `now`, with the org's pinned `policy` when the relay holds one
/// (the map's org, `domains` for principals and owners, `ai` app names), the license `edition`, and the issuer URLs of
/// the maps held for each org (`held_issuers`; this map's own org is skipped).
pub fn check_api_map(map: &Value, now: i64, policy: Option<&Obj>, edition: Edition, held_issuers: &BTreeMap<String, String>) -> Result<(), ApiMapError> {
    let m = obj_of(map, MAP_KEYS, MAP_REQUIRED, "the api map")?;
    let size = canonical_json(map).map_err(|e| bad_e(format!("the api map: {e}")))?.len();
    if size > API_MAP_MAX {
        return bad("the api map is larger than 256 KiB");
    }
    if m.get("v").and_then(int_of) != Some(1) {
        return bad("the api map must be version 1");
    }
    let Some(org) = m.get("org").and_then(Value::as_str).filter(|o| slug(o, 32)) else {
        return bad("the api map's org must be 1 to 32 of a-z, 0-9 and -");
    };
    if policy.is_some_and(|p| p.get("org").and_then(Value::as_str) != Some(org)) {
        return bad("the api map is for another organization");
    }
    int_in(m.get("seq"), "seq", 1, MAX_INT)?;
    let issued = int_in(m.get("issued"), "issued", 1, MAX_INT)?;
    if issued > now + SKEW {
        return bad("the api map is dated in the future");
    }
    let expires = int_in(m.get("expires"), "expires", 1, MAX_INT)?;
    if !(DAY..=90 * DAY).contains(&(expires - issued)) {
        return bad("the api map must last 1 to 90 days");
    }
    check_grace(m.get("grace").unwrap_or(&Value::Null))?;
    let url = check_issuer(m.get("issuer").unwrap_or(&Value::Null), org)?;
    int_in(m.get("failover_after_s"), "failover_after_s", 60, 3600)?;
    let folded = strings(m.get("folded"), "folded", 0, 1000, |s| tighten_id_ok(s, org))?;
    let cleared = strings(m.get("cleared"), "cleared", 0, 1000, |s| tighten_id_ok(s, org))?;
    let empty_obj = Value::Object(Obj::new());
    let Some(origins) = m.get("relay_origins").unwrap_or(&empty_obj).as_object().filter(|o| o.len() <= 256) else {
        return bad("relay_origins must map up to 256 relay ids to origins");
    };
    if !origins.iter().all(|(k, v)| token(k, 64) && k != "console" && v.as_str().is_some_and(origin_ok)) || !unique(origins.values().filter_map(Value::as_str)) {
        return bad("relay_origins must map relay ids to distinct https://<host>:<port> origins");
    }
    let clients = list(m.get("clients"), "clients", 0, 500)?;
    for c in clients {
        check_client(c, policy, origins, issued)?;
    }
    if !unique(clients.iter().filter_map(|c| c.get("id").and_then(Value::as_str))) || !unique(clients.iter().filter_map(|c| c.get("name").and_then(Value::as_str))) {
        return bad("two clients have the same id or name");
    }
    let tokens = list(m.get("scrape_tokens"), "scrape_tokens", 0, 10)?;
    for t in tokens {
        let t = obj_of(t, SCRAPE_KEYS, SCRAPE_KEYS, "a scrape token")?;
        if !t.get("sha256").and_then(Value::as_str).is_some_and(|h| hex_n(h, 64)) {
            return bad("a scrape token's sha256 must be 64 lowercase hex");
        }
        if text(t.get("hint"), "a scrape token's hint", 8, 8).is_err() {
            return bad("a scrape token's hint must be 8 characters");
        }
        text(t.get("label"), "a scrape token's label", 1, 64)?;
        relays_ok(t.get("relays"), "a scrape token's relays", origins)?;
        let exp = int_in(t.get("expires"), "a scrape token's expires", 1, MAX_INT)?;
        if exp > issued + 90 * DAY {
            return bad("a scrape token lasts at most 90 days after it was first signed");
        }
    }
    if !unique(tokens.iter().filter_map(|t| t.get("sha256").and_then(Value::as_str))) {
        return bad("two scrape tokens have the same sha256");
    }
    let dests = list(m.get("destinations"), "destinations", 0, 32)?;
    for d in dests {
        check_destination(d)?;
    }
    if !unique(dests.iter().filter_map(|d| d.get("id").and_then(Value::as_str))) || !unique(dests.iter().filter_map(|d| d.get("name").and_then(Value::as_str))) {
        return bad("two destinations have the same id or name");
    }
    if folded.iter().any(|f| cleared.contains(f)) {
        return fail("fold-mismatch", "an id is both folded and cleared");
    }
    if edition == Edition::Standard {
        check_standard(clients, dests)?;
    }
    if held_issuers.iter().any(|(o, u)| o != org && *u == url) {
        return fail("issuer-taken", "another organization's api map has that issuer url");
    }
    Ok(())
}

/// `issuer`: the url for this org and 1 to 3 ES256 keys. Returns the url.
fn check_issuer(v: &Value, org: &str) -> Res<String> {
    let i = obj_of(v, ISSUER_KEYS, ISSUER_KEYS, "issuer")?;
    let url = i.get("url").and_then(Value::as_str).unwrap_or_default();
    let ok = url
        .strip_prefix("https://")
        .and_then(|r| r.strip_suffix(&format!("/api/orgs/{org}")))
        .is_some_and(|a| !a.contains('/') && authority_ok(a));
    if !ok || url.len() > 512 {
        return bad("issuer.url must be https://<host>:<port>/api/orgs/<org>");
    }
    let keys = list(i.get("jwks"), "issuer.jwks", 1, 3)?;
    for k in keys {
        let k = obj_of(k, JWK_KEYS, JWK_KEYS, "an issuer key")?;
        let fixed = [("kty", "EC"), ("crv", "P-256"), ("alg", "ES256")].iter().all(|(f, want)| k.get(*f).and_then(Value::as_str) == Some(*want));
        let use_ok = k.get("use").and_then(Value::as_str) == Some("sig");
        let xy = ["x", "y"].iter().all(|f| k.get(*f).and_then(Value::as_str).is_some_and(|s| b64u(s, 43, 43)));
        let kid = k.get("kid").and_then(Value::as_str).is_some_and(|s| token(s, 64));
        if !(fixed && use_ok && xy && kid) {
            return bad("an issuer key must be an EC P-256 ES256 key with a kid of [A-Za-z0-9._-]{1,64}");
        }
        let nbf = int_in(k.get("nbf"), "an issuer key's nbf", 0, MAX_INT)?;
        let exp = int_in(k.get("exp"), "an issuer key's exp", 0, MAX_INT)?;
        if nbf >= exp || exp - nbf > JWKS_SPAN_MAX {
            return bad("an issuer key's nbf must be before its exp, at most 400 days apart");
        }
    }
    if !unique(keys.iter().filter_map(|k| k.get("kid").and_then(Value::as_str))) {
        return bad("two issuer keys have the same kid");
    }
    Ok(url.to_string())
}

/// `grace`: exactly the four kinds, each 0 to 168 hours (D15), else `grace-limit`.
fn check_grace(v: &Value) -> Res<()> {
    let Some(g) = v.as_object() else { return bad("grace must be an object") };
    let ok = g.len() == GRACE_KINDS.len()
        && GRACE_KINDS.iter().all(|k| g.get(*k).and_then(int_of).is_some_and(|h| (0..=GRACE_MAX_HOURS).contains(&h)));
    if !ok {
        return fail("grace-limit", "grace must give person, app, connector and relay each 0 to 168 hours");
    }
    Ok(())
}

fn check_client(v: &Value, policy: Option<&Obj>, origins: &Obj, issued: i64) -> Res<()> {
    let c = obj_of(v, CLIENT_KEYS, CLIENT_REQUIRED, "a client")?;
    if !prefixed_id(&c["id"], "c_") {
        return bad("a client id must be c_ and 16 lowercase hex");
    }
    let Some(name) = c["name"].as_str().filter(|n| slug(n, 32) && *n != "archive") else {
        return bad("a client name must be 1 to 32 of a-z, 0-9 and -, not archive");
    };
    let domain = c["principal"].as_str().and_then(|p| p.strip_prefix(name)).and_then(|r| r.strip_prefix("@apps.")).filter(|d| op::is_domain(d));
    let Some(domain) = domain else { return bad("a client principal must be <name>@apps.<domain>") };
    let kind = one_of(c.get("kind"), &KINDS, "a client kind")?;
    if !KINDS_1A.contains(&kind) {
        return bad("API-1a accepts only monitoring and integration clients");
    }
    let owner = c["owner"].as_str().and_then(|o| op::split_principal(o).ok()).filter(|(_, d)| !d.starts_with("apps."));
    let Some((_, owner_domain)) = owner else { return bad("a client owner must be a person principal") };
    one_of(c.get("reach"), &["R0"], "a client reach")?;
    let scopes = strings(c.get("scopes"), "a client's scopes", 1, 32, |s| SCOPES.contains(&s))?;
    let ceiling = one_of(c.get("ceiling"), &CEILINGS, "a client ceiling")?;
    relays_ok(c.get("relays"), "a client's relays", origins)?;
    let networks = strings(c.get("networks"), "a client's networks", 0, 32, cidr_ok)?;
    if let Some(h) = c.get("hours") {
        let h = obj_of(h, HOURS_KEYS, HOURS_KEYS, "a client's hours")?;
        let tz = h["tz"].as_str().is_some_and(tz_ok);
        let times = ["from", "to"].iter().all(|f| h[*f].as_str().is_some_and(hhmm_ok));
        let days = h["days"].as_array().is_some_and(|d| {
            (1..=7).contains(&d.len()) && d.iter().all(|x| int_of(x).is_some_and(|n| (1..=7).contains(&n))) && unique(d.iter().filter_map(int_of))
        });
        if !(tz && times && days) {
            return bad("a client's hours must be {tz, from: HH:MM, to: HH:MM, days: [1..7]}");
        }
    }
    let mtls_required = bool_of(c.get("mtls_required"), "mtls_required")?;
    if ceiling == "cui" && !mtls_required {
        return bad("a cui client must set mtls_required");
    }
    let rate = obj_of(&c["rate"], RATE_KEYS, RATE_KEYS, "a client's rate")?;
    int_in(rate.get("per_minute_each"), "per_minute_each", 1, 6000)?;
    int_in(rate.get("per_day_each"), "per_day_each", 1, 10_000_000)?;
    let creds = list(c.get("credentials"), "a client's credentials", 1, 4)?;
    for cr in creds {
        let ty = check_credential(cr)?;
        if mtls_required && ty != "mtls" {
            return bad("a client with mtls_required takes mtls credentials only");
        }
        if ty == "client_secret" {
            if kind != "monitoring" || networks.is_empty() || !scopes.iter().all(|s| SECRET_SCOPES.contains(s)) {
                return bad("a client_secret needs a monitoring client with networks and read scopes only (D11)");
            }
            int_in(cr.get("expires"), "a client_secret's expires", 1, issued + SECRET_DAYS_MAX * DAY)?;
        }
    }
    if !unique(creds.iter().filter_map(|cr| cr.get("kid").and_then(Value::as_str))) {
        return bad("a client lists a credential kid twice");
    }
    let created = int_in(c.get("created"), "a client's created", 1, MAX_INT)?;
    let expires = int_in(c.get("expires"), "a client's expires", 1, MAX_INT)?;
    if expires <= created || expires - created > CLIENT_SPAN_MAX {
        return bad("a client lasts at most 366 days");
    }
    one_of(c.get("state"), &["active", "suspended"], "a client state")?;
    if let Some(p) = policy {
        let domains = policy_domains(p);
        if !domains.contains(&domain) {
            return bad("a client principal must be on one of the policy's domains");
        }
        if !domains.contains(&owner_domain) {
            return bad("a client owner must be a person of the org");
        }
        if ai_app_names(p).contains(&name) {
            return bad("a client name must not be an ai app's name");
        }
    }
    Ok(())
}

/// Section 4.2; returns the credential's type.
fn check_credential(v: &Value) -> Res<&str> {
    let ty = one_of(v.get("type"), &CRED_TYPES, "a credential type")?;
    let c: &Obj = match ty {
        "mtls" => {
            let c = obj_of(v, &["type", "serial", "spki"], &["type", "serial", "spki"], "an mtls credential")?;
            let serial = c["serial"].as_str().is_some_and(|s| (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            if !serial || !c["spki"].as_str().is_some_and(|s| hex_n(s, 64)) {
                return bad("an mtls credential needs a hex serial and a 64 hex spki");
            }
            return Ok(ty);
        }
        "private_key_jwt" if v.get("jwks_uri").is_some() => {
            let c = obj_of(v, &["type", "jwks_uri", "private_ok", "expires"], &["type", "jwks_uri", "private_ok", "expires"], "a private_key_jwt credential")?;
            if !c["jwks_uri"].as_str().is_some_and(https_url_ok) {
                return bad("jwks_uri must be an https URL");
            }
            bool_of(c.get("private_ok"), "private_ok")?;
            c
        }
        "private_key_jwt" => {
            let c = obj_of(v, &["type", "kid", "jwk", "expires"], &["type", "kid", "jwk", "expires"], "a private_key_jwt credential")?;
            if !c["kid"].as_str().is_some_and(|k| token(k, 64)) || !jwk_ok(&c["jwk"]) {
                return bad("a private_key_jwt credential needs a kid and an EC P-256 or RSA 3072+ public key");
            }
            c
        }
        "federated" => {
            let k = &["type", "issuer", "audience", "subject", "algs", "private_ok", "expires"];
            let c = obj_of(v, k, k, "a federated credential")?;
            if !c["issuer"].as_str().is_some_and(https_url_ok) {
                return bad("a federated issuer must be an https URL");
            }
            text(c.get("audience"), "audience", 1, 256)?;
            text(c.get("subject"), "subject", 1, 256)?;
            strings(c.get("algs"), "algs", 1, 3, |a| FED_ALGS.contains(&a))?;
            bool_of(c.get("private_ok"), "private_ok")?;
            c
        }
        _ => {
            let k = &["type", "sha256", "hint", "expires"];
            let c = obj_of(v, k, k, "a client_secret credential")?;
            if !c["sha256"].as_str().is_some_and(|h| hex_n(h, 64)) || text(c.get("hint"), "hint", 8, 8).is_err() {
                return bad("a client_secret needs a 64 hex sha256 and an 8 character hint");
            }
            c
        }
    };
    int_in(c.get("expires"), "a credential's expires", 1, MAX_INT)?;
    Ok(ty)
}

fn jwk_ok(v: &Value) -> bool {
    let Some(k) = v.as_object() else { return false };
    let s = |f: &str| k.get(f).and_then(Value::as_str);
    match s("kty") {
        Some("EC") => k.len() == 4 && s("crv") == Some("P-256") && s("x").is_some_and(|x| b64u(x, 43, 43)) && s("y").is_some_and(|y| b64u(y, 43, 43)),
        Some("RSA") => k.len() == 3 && s("n").is_some_and(|n| b64u(n, 512, usize::MAX) && n.len() % 4 != 1) && s("e").is_some_and(|e| b64u(e, 2, 11) && e.len() % 4 != 1),
        _ => false,
    }
}

fn check_destination(v: &Value) -> Res<()> {
    let d = obj_of(v, DEST_KEYS, DEST_REQUIRED, "a destination")?;
    if !prefixed_id(&d["id"], "d_") {
        return bad("a destination id must be d_ and 16 lowercase hex");
    }
    text(d.get("name"), "a destination name", 1, 64)?;
    let kind = one_of(d.get("kind"), &["otlp", "splunk_hec", "azure_logs", "syslog_cef"], "a destination kind")?;
    let presets: &[&str] = match kind {
        "otlp" => &OTLP_PRESETS,
        "splunk_hec" => &["splunk_hec", "splunk_cloud_gov"],
        "azure_logs" => &["sentinel", "sentinel_gov"],
        _ => &["syslog_cef"],
    };
    let preset = one_of(d.get("preset"), presets, "a destination preset")?;
    let carried: &[&str] = if kind == "otlp" { &SIGNALS } else { &["logs", "audit"] };
    strings(d.get("signals"), "a destination's signals", 1, 4, |s| carried.contains(&s))?;
    one_of(d.get("ceiling"), &CEILINGS, "a destination ceiling")?;
    one_of(d.get("identities"), &IDENTITIES, "a destination's identities")?;
    bool_of(d.get("failover"), "failover")?;
    bool_of(d.get("private_ok"), "private_ok")?;
    if d.get("endpoint").is_some_and(|e| !e.as_str().is_some_and(https_url_ok)) {
        return bad("a destination endpoint must be an https URL");
    }
    if let Some(s) = d.get("settings") {
        check_settings(kind, s)?;
    }
    if let Some(cr) = d.get("credential") {
        let ty = one_of(cr.get("type"), &["entra_certificate", "aws_roles_anywhere", "gcp_service_account_key", "mtls", "token"], "a destination credential type")?;
        let (allowed, fields): (bool, &[&str]) = match ty {
            "entra_certificate" => (preset.starts_with("azure_monitor") || preset.starts_with("sentinel"), &["tenant", "client_id", "cloud"]),
            "aws_roles_anywhere" => (preset.starts_with("cloudwatch"), &["trust_anchor_arn", "profile_arn", "role_arn", "region"]),
            "gcp_service_account_key" => (preset == "google_cloud", &[]),
            "mtls" => (matches!(preset, "syslog_cef" | "otlp_generic"), &[]),
            _ => (TOKEN_PRESETS.contains(&preset), &[]),
        };
        let keys: Vec<&str> = ["type", "ref"].into_iter().chain(fields.iter().copied()).collect();
        let c = obj_of(cr, &keys, &keys, "a destination credential")?;
        let want_ref = format!("secret:{}", d["id"].as_str().unwrap_or_default());
        if !allowed || c["ref"].as_str() != Some(want_ref.as_str()) {
            return bad("a destination credential must fit its preset and be referenced as secret:<id>");
        }
        for f in fields {
            text(c.get(*f), f, 1, 256)?;
        }
        if ty == "entra_certificate" {
            one_of(c.get("cloud"), &["public", "usgov"], "cloud")?;
        }
    }
    let q = obj_of(&d["queue"], QUEUE_KEYS, QUEUE_KEYS, "a destination queue")?;
    int_in(q.get("max_bytes"), "queue.max_bytes", 64 << 20, 64 << 30)?;
    int_in(q.get("max_age_s"), "queue.max_age_s", 3600, 2_592_000)?;
    Ok(())
}

/// Section 11.1 `settings` per kind (values are checked by type).
fn check_settings(kind: &str, v: &Value) -> Res<()> {
    let keys: &[&str] = match kind {
        "otlp" => &["endpoints", "temporality", "headers", "sampling"],
        "splunk_hec" => &["index", "sourcetypes", "ack"],
        "azure_logs" => &["dce", "dcr_immutable_id", "stream"],
        _ => &["host", "port", "caPem", "clientCertPem", "events", "includeReasons"],
    };
    let s = obj_of(v, keys, &[], "a destination's settings")?;
    for (k, val) in s {
        let ok = match k.as_str() {
            "endpoints" => {
                obj_of(val, &["traces", "metrics", "logs"], &[], "endpoints")?;
                val.as_object().is_some_and(|e| e.values().all(|u| u.as_str().is_some_and(https_url_ok)))
            }
            "temporality" => matches!(val.as_str(), Some("delta" | "cumulative")),
            "headers" | "sourcetypes" | "events" => val.as_array().is_some_and(|a| {
                a.len() <= 32 && a.iter().all(|x| x.as_str().is_some_and(|x| ascii_text(x, 1, 128))) && unique(a.iter().filter_map(Value::as_str))
            }),
            // parts per million (no floats)
            "sampling" => int_of(val).is_some_and(|n| (0..=1_000_000).contains(&n)),
            "ack" => val.as_bool() == Some(true),
            "includeReasons" => val.is_boolean(),
            "port" => int_of(val).is_some_and(|n| (1..=65535).contains(&n)),
            "dce" => val.as_str().is_some_and(https_url_ok),
            "caPem" | "clientCertPem" => val.as_str().is_some_and(|p| ascii_text(&p.replace('\n', " "), 1, 16384)),
            _ => val.as_str().is_some_and(|x| ascii_text(x, 1, 256)),
        };
        if !ok {
            return bad(format!("a destination setting {k} is not valid"));
        }
    }
    Ok(())
}

/// Section 13: the `standard` edition's limits (`license`).
fn check_standard(clients: &[Value], dests: &[Value]) -> Res<()> {
    if clients.len() > 5 {
        return fail("license", "the standard edition allows at most 5 API clients");
    }
    let wide = clients.iter().flat_map(|c| c["scopes"].as_array().into_iter().flatten()).any(|s| !s.as_str().is_some_and(|s| STANDARD_SCOPES.contains(&s)));
    if wide {
        return fail("license", "the standard edition allows the scopes monitor.read, fleet.read and audit.read only");
    }
    let count = |k: &str| dests.iter().filter(|d| d["kind"].as_str() == Some(k)).count();
    if count("otlp") > 1 || count("splunk_hec") > 0 || count("azure_logs") > 0 {
        return fail("license", "the standard edition allows one otlp destination plus syslog_cef");
    }
    if dests.iter().any(|d| d["identities"].as_str() == Some("pseudonymized") || d["failover"].as_bool() == Some(true)) {
        return fail("license", "the standard edition has no pseudonymized identities and no failover");
    }
    Ok(())
}

// ---- 2.3 and 2.4: signing and pinning ---------------------------------------------------------------------------

/// `lp("lucid-meet-org-api-v1", canonical JSON of the map)` (empty JSON for a map canonical JSON refuses: every
/// caller checks the map first).
pub fn api_map_bytes(map: &Value) -> Vec<u8> {
    let json = canonical_json(map).unwrap_or_default();
    lp(&[API_MAP_LABEL.as_bytes(), &json])
}

/// Hex SHA-256 of the map's signed bytes.
pub fn api_map_hash(map: &Value) -> String {
    sha256_hex(&api_map_bytes(map))
}

/// A verified signed api map.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedApiMap {
    /// `{map, sig, chain}` as signed.
    pub wire: Obj,
    pub org: String,
    pub seq: i64,
    pub expires: i64,
    pub hash: String,
    /// "root" or the intermediate's serial (hex).
    pub signer: String,
}

impl VerifiedApiMap {
    /// The map a relay already verified (from its store).
    fn of_wire(wire: Obj, signer: String) -> Option<VerifiedApiMap> {
        let m = wire.get("map")?.as_object()?;
        let org = m.get("org")?.as_str()?.to_string();
        let (seq, expires) = (int_of(m.get("seq")?)?, int_of(m.get("expires")?)?);
        let hash = api_map_hash(&wire["map"]);
        Some(VerifiedApiMap { wire, org, seq, expires, hash, signer })
    }

    pub fn map(&self) -> &Obj {
        self.wire.get("map").and_then(Value::as_object).expect("a verified map")
    }

    fn issuer_url(&self) -> &str {
        self.map().get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).unwrap_or_default()
    }
}

/// What a relay checks a signed map against (meet_org_policy::verify's inputs).
pub struct ApiTrust<'a> {
    pub root: &'a Cert,
    pub signer_policy: &'a Obj,
    pub root_crl: Option<&'a Crl>,
    pub previous_serial: &'a str,
}

/// A relay's check of a signed api map, as `verify_ai_map`: the root-signed signer policy, the signature by the root
/// or the signer's current (or previous) intermediate valid at `issued` and not in the root's CRL (`signature`), every
/// field rule (`check_api_map`), an org the root assigned domains to (`signature`), then `expires > now`
/// (`map-expired`). The caller pins with `pin_verdict`.
#[allow(clippy::too_many_arguments)]
pub fn verify_api_map(
    wire: &Value,
    root: &Cert,
    signer_policy: &Obj,
    root_crl: Option<&Crl>,
    previous_serial: &str,
    now: i64,
    policy: Option<&Obj>,
    edition: Edition,
    held_issuers: &BTreeMap<String, String>,
) -> Result<VerifiedApiMap, ApiMapError> {
    let w = obj_of(wire, WIRE_KEYS, WIRE_KEYS, "the signed api map")?;
    if canonical_json(wire).map_err(|e| bad_e(format!("the signed api map: {e}")))?.len() > API_WIRE_MAX {
        return bad("the signed api map is larger than 256 KiB");
    }
    let Some(issued) = w["map"].get("issued").and_then(int_of).filter(|n| (1..=MAX_INT).contains(n)) else {
        return bad("the api map needs issued");
    };
    if !op::verify_signer_policy(root, signer_policy) {
        return Err(sig_e("the signer policy is not signed by the root"));
    }
    let terms = op::signer_terms(signer_policy).map_err(sig_e)?;
    let sig = w["sig"].as_str().and_then(pj::b64_strict).ok_or_else(|| sig_e("sig must be base64"))?;
    let chain = match &w["chain"] {
        Value::Array(c) if c.len() <= 1 && c.iter().all(Value::is_string) => c,
        _ => return Err(sig_e("chain must be [] or [one intermediate PEM]")),
    };
    let inter = match chain.first().and_then(Value::as_str) {
        Some(pem) => Some(Some(pem).filter(|p| p.is_ascii()).and_then(Cert::from_pem).ok_or_else(|| sig_e("the chain is not a certificate"))?),
        None => None,
    };
    let signer = match &inter {
        Some(c) => op::check_intermediate(c, root, &terms, previous_serial, issued, root_crl).map_err(|e| sig_e(e.to_string()))?,
        None => "root".to_string(),
    };
    canonical_json(&w["map"]).map_err(|e| bad_e(format!("the api map: {e}")))?;
    let data = api_map_bytes(&w["map"]);
    let spki = inter.as_ref().map_or(&root.spki, |c| &c.spki);
    if !ecdsa_sha256_verified(spki, &data, &sig) {
        return Err(sig_e("the api map's signature does not verify"));
    }
    if !w["map"].get("org").and_then(Value::as_str).is_some_and(|o| terms.org_domains.contains_key(o)) {
        return Err(sig_e(op::DOMAIN_REFUSED));
    }
    check_api_map(&w["map"], now, policy, edition, held_issuers)?;
    let vm = VerifiedApiMap::of_wire(w.clone(), signer).ok_or_else(|| bad_e("the api map is not readable"))?;
    if vm.expires <= now {
        return fail("map-expired", "the api map has expired");
    }
    Ok(vm)
}

/// 2.4 rollback: `ok` with no pin or a higher seq; `seq-not-higher` for a lower or equal seq with the same hash;
/// `conflict` for the pinned seq with another hash (alarm `api.map.conflict`).
pub fn pin_verdict(seq: i64, hash: &str, pinned_seq: i64, pinned_hash: &str) -> &'static str {
    if pinned_seq == 0 || seq > pinned_seq {
        "ok"
    } else if seq == pinned_seq && !hash.eq_ignore_ascii_case(pinned_hash) {
        "conflict"
    } else {
        "seq-not-higher"
    }
}

// ---- 2.5: the tightening journal --------------------------------------------------------------------------------

const ENTRY_KEYS: &[&str] = &["id", "tseq", "ts", "action", "target", "until"];
const ENTRY_REQUIRED: &[&str] = &["id", "tseq", "ts", "action", "target"];
const DENY_ACTIONS: [&str; 2] = ["token_deny", "scrape_deny"];

/// One journal entry.
#[derive(Clone, Debug, PartialEq)]
pub struct TightenEntry {
    pub id: String,
    pub org: String,
    pub tseq: u64,
    pub ts: i64,
    pub action: String,
    pub target: Value,
    /// `token_deny` only.
    pub until: Option<i64>,
}

fn not_tightening<T>(message: impl Into<String>) -> Res<T> {
    fail("not-tightening", message)
}

impl TightenEntry {
    /// Shape, action and target (`not-tightening` for anything else, including an entry that would widen).
    pub fn parse(v: &Value) -> Result<TightenEntry, ApiMapError> {
        let Ok(e) = obj_of(v, ENTRY_KEYS, ENTRY_REQUIRED, "a journal entry") else { return not_tightening("a journal entry must be {id, tseq, ts, action, target}") };
        let Some(tseq) = e["tseq"].as_u64().filter(|n| (1..=MAX_INT as u64).contains(n)) else { return not_tightening("tseq must be a whole number from 1") };
        let Some(ts) = int_of(&e["ts"]).filter(|n| (1..=MAX_INT).contains(n)) else { return not_tightening("ts must be a time") };
        let Some((org, n)) = e["id"].as_str().and_then(tighten_id_parts) else { return not_tightening("id must be t_<org>_<tseq as 6 digits>") };
        if n != tseq {
            return not_tightening("id must end with the entry's tseq");
        }
        let action = e["action"].as_str().unwrap_or_default();
        let t = &e["target"];
        let pair = |a: &str, b: &str| t.as_object().filter(|o| o.len() == 2 && o.contains_key(a) && o.contains_key(b));
        let client = |o: &Obj| prefixed_id(&o["client"], "c_");
        let dest = |o: &Obj| prefixed_id(&o["destination"], "d_");
        let s = |o: &Obj, k: &str, set: &[&str]| o[k].as_str().is_some_and(|x| set.contains(&x));
        let ok = match action {
            "client_suspend" => prefixed_id(t, "c_"),
            "client_drop_scope" => pair("client", "scope").is_some_and(|o| client(o) && s(o, "scope", &SCOPES)),
            "client_drop_relay" => pair("client", "relay").is_some_and(|o| client(o) && o["relay"].as_str().is_some_and(|r| token(r, 64) && r != "*")),
            // cui is the top: never a lowering target
            "client_lower_ceiling" => pair("client", "ceiling").is_some_and(|o| client(o) && s(o, "ceiling", &CEILINGS[..3])),
            "client_drop_credential" => {
                pair("client", "kid").is_some_and(|o| client(o) && o["kid"].as_str().is_some_and(|k| token(k, 64)))
                    || pair("client", "type").is_some_and(|o| client(o) && s(o, "type", &CRED_TYPES))
            }
            "token_deny" => pair("client", "jti").is_some_and(|o| client(o) && o["jti"].as_str().is_some_and(|j| ascii_text(j, 1, 128))),
            "scrape_deny" => t.as_str().is_some_and(|h| hex_n(h, 64)),
            "destination_suspend" | "destination_delete" | "destination_disable_failover" => prefixed_id(t, "d_"),
            "destination_drop_signal" => pair("destination", "signal").is_some_and(|o| dest(o) && s(o, "signal", &SIGNALS)),
            "destination_lower_ceiling" => pair("destination", "ceiling").is_some_and(|o| dest(o) && s(o, "ceiling", &CEILINGS[..3])),
            // only to a stricter form: never as_is
            "destination_identities" => pair("destination", "identities").is_some_and(|o| dest(o) && s(o, "identities", &IDENTITIES[1..])),
            // 168 lowers nothing
            "grace_lower" => pair("kind", "hours").is_some_and(|o| s(o, "kind", &GRACE_KINDS) && int_of(&o["hours"]).is_some_and(|h| (0..GRACE_MAX_HOURS).contains(&h))),
            "api_off" => t.as_str() == Some(org),
            _ => return not_tightening(format!("{action:?} is not a tightening")),
        };
        if !ok {
            return not_tightening(format!("the target of {action} is not valid"));
        }
        let until = match (action, e.get("until")) {
            ("token_deny", Some(u)) => Some(int_of(u).filter(|n| (ts + 1..=MAX_INT).contains(n)).ok_or_else(|| ApiMapError::new("not-tightening", "until must be a time"))?),
            ("token_deny", None) => return not_tightening("token_deny needs until"),
            (_, Some(_)) => return not_tightening("only token_deny has until"),
            (_, None) => None,
        };
        Ok(TightenEntry { id: e["id"].as_str().unwrap_or_default().to_string(), org: org.to_string(), tseq, ts, action: action.to_string(), target: t.clone(), until })
    }

    pub fn to_value(&self) -> Value {
        let mut o = pj::obj([
            ("id", Value::from(self.id.clone())),
            ("tseq", Value::from(self.tseq)),
            ("ts", Value::from(self.ts)),
            ("action", Value::from(self.action.clone())),
            ("target", self.target.clone()),
        ]);
        if let Some(u) = self.until {
            o.insert("until".into(), Value::from(u));
        }
        Value::Object(o)
    }

    fn field(&self, k: &str) -> &str {
        self.target.get(k).and_then(Value::as_str).unwrap_or_default()
    }
}

/// 2.5 delivery: the entry, applied only when its `tseq` is exactly `applied_tseq + 1` (`tseq-gap`).
/// The tseq is checked first (`not-tightening` when it is not a whole number), then the rest.
pub fn check_tighten(entry: &Value, applied_tseq: u64) -> Result<TightenEntry, ApiMapError> {
    let Some(tseq) = entry.get("tseq").and_then(Value::as_u64).filter(|n| (1..=MAX_INT as u64).contains(n)) else {
        return not_tightening("tseq must be a whole number from 1");
    };
    if tseq != applied_tseq + 1 {
        return fail("tseq-gap", format!("expected tseq {}, got {tseq}", applied_tseq + 1));
    }
    TightenEntry::parse(entry)
}

fn find_by_id<'a>(map: &'a Obj, list: &str, id: &str) -> Option<&'a Obj> {
    map.get(list).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|o| o.get("id").and_then(Value::as_str) == Some(id))
}

fn lists(o: &Obj, k: &str, v: &str) -> bool {
    o.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(v)))
}

/// Whether the map still contains the entry's restriction (2.5 folding).
fn contains(map: &Obj, e: &TightenEntry) -> bool {
    let client = |id: &str| find_by_id(map, "clients", id);
    let dest = |id: &str| find_by_id(map, "destinations", id);
    let at_or_below = |set: &[&str], have: Option<&str>, limit: &str| rank(set, have.unwrap_or_default()).zip(rank(set, limit)).is_some_and(|(h, l)| h <= l);
    match e.action.as_str() {
        "client_suspend" => client(e.target.as_str().unwrap_or_default()).is_none_or(|c| c.get("state").and_then(Value::as_str) == Some("suspended")),
        "client_drop_scope" => client(e.field("client")).is_none_or(|c| !lists(c, "scopes", e.field("scope"))),
        "client_drop_relay" => client(e.field("client")).is_none_or(|c| !lists(c, "relays", e.field("relay")) && !lists(c, "relays", "*")),
        "client_lower_ceiling" => client(e.field("client")).is_none_or(|c| at_or_below(&CEILINGS, c.get("ceiling").and_then(Value::as_str), e.field("ceiling"))),
        "client_drop_credential" => client(e.field("client")).is_none_or(|c| {
            let (k, want) = if e.target.get("kid").is_some() { ("kid", e.field("kid")) } else { ("type", e.field("type")) };
            !c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|cr| cr.get(k).and_then(Value::as_str) == Some(want))
        }),
        "destination_suspend" | "destination_delete" => dest(e.target.as_str().unwrap_or_default()).is_none(),
        "destination_disable_failover" => dest(e.target.as_str().unwrap_or_default()).is_none_or(|d| d.get("failover").and_then(Value::as_bool) != Some(true)),
        "destination_drop_signal" => dest(e.field("destination")).is_none_or(|d| !lists(d, "signals", e.field("signal"))),
        "destination_lower_ceiling" => dest(e.field("destination")).is_none_or(|d| at_or_below(&CEILINGS, d.get("ceiling").and_then(Value::as_str), e.field("ceiling"))),
        "destination_identities" => dest(e.field("destination")).is_none_or(|d| {
            rank(&IDENTITIES, d.get("identities").and_then(Value::as_str).unwrap_or_default()).zip(rank(&IDENTITIES, e.field("identities"))).is_some_and(|(h, w)| h >= w)
        }),
        "grace_lower" => {
            let have = map.get("grace").and_then(|g| g.get(e.field("kind"))).and_then(int_of);
            have.zip(e.target.get("hours").and_then(int_of)).is_some_and(|(h, w)| h <= w)
        }
        // no client and no scrape token left
        "api_off" => ["clients", "scrape_tokens"].iter().all(|k| map.get(*k).and_then(Value::as_array).is_none_or(Vec::is_empty)),
        // token_deny and scrape_deny are never folded: they last until they expire
        _ => false,
    }
}

/// 2.5 folding and clearing for a newly pinned map: `fold-mismatch` when it folds an active id whose restriction it
/// does not contain, folds or clears a `token_deny` or `scrape_deny`, clears an entry not older than its `issued`, or
/// lists an id both ways. Returns the active ids that remain, sorted.
pub fn fold(active: &[TightenEntry], new_map: &Value) -> Result<Vec<String>, ApiMapError> {
    let Some(m) = new_map.as_object() else { return bad("the api map must be an object") };
    let ids = |k: &str| m.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect::<Vec<&str>>();
    let (folded, cleared) = (ids("folded"), ids("cleared"));
    if folded.iter().any(|f| cleared.contains(f)) {
        return fail("fold-mismatch", "an id is both folded and cleared");
    }
    let issued = m.get("issued").and_then(int_of).unwrap_or(0);
    let mut remaining: Vec<String> = Vec::new();
    for e in active {
        let deny = DENY_ACTIONS.contains(&e.action.as_str());
        if folded.contains(&e.id.as_str()) {
            if deny || !contains(m, e) {
                return fail("fold-mismatch", format!("the map folds {} but does not contain it", e.id));
            }
        } else if cleared.contains(&e.id.as_str()) {
            if deny || e.ts >= issued {
                return fail("fold-mismatch", format!("the map cannot clear {}", e.id));
            }
        } else {
            remaining.push(e.id.clone());
        }
    }
    remaining.sort();
    Ok(remaining)
}

// ---- 3.2: the effective end ---------------------------------------------------------------------------------------

/// `raw_end + hours * 3600` with the applicable grace: the minimum over the orgs that bind the credential, an org with
/// no pinned or an expired map (None) counting 0; no org at all is 0.
pub fn effective_end(raw_end: i64, hours: &[Option<u32>]) -> i64 {
    let h = hours.iter().map(|h| h.unwrap_or(0)).min().unwrap_or(0);
    raw_end.saturating_add(i64::from(h) * 3600)
}

// ---- the relay's store --------------------------------------------------------------------------------------------

/// One org's api state on a relay.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrgApi {
    pub pinned: Option<VerifiedApiMap>,
    pub previous: Option<VerifiedApiMap>,
    /// The last applied journal `tseq` (0: none).
    pub applied: u64,
    /// Journal entries not yet folded or cleared, in `tseq` order.
    pub active: Vec<TightenEntry>,
}

/// What `accept` did.
#[derive(Clone, Debug, PartialEq)]
pub enum AcceptOutcome {
    /// Newly pinned (flushed to disk).
    Pinned(VerifiedApiMap),
    /// The pinned map again.
    Unchanged(VerifiedApiMap),
    /// The pinned seq with another hash: nothing changed; raise `api.map.conflict` (audit plus alert).
    Conflict { org: String, seq: i64, pinned_hash: String, offered_hash: String },
}

/// The relay's api maps and journals (2.4, 2.5): `<dir>/api-maps/<org>.json` = `{"pinned": {signed, signer},
/// "previous": {signed, signer}}` and `<dir>/api-journal/<org>.json` = `{"applied": tseq, "active": [entries]}`,
/// each written owner-only and flushed before the relay answers. Without a folder (tests, no state folder) it lives
/// in memory.
#[derive(Debug, Default)]
pub struct ApiMapStore {
    dir: Option<PathBuf>,
    orgs: BTreeMap<String, OrgApi>,
}

const MAPS_DIR: &str = "api-maps";
const JOURNAL_DIR: &str = "api-journal";

fn held_of(v: Option<&Value>) -> Option<VerifiedApiMap> {
    let v = v?.as_object()?;
    let signer = v.get("signer").and_then(Value::as_str).unwrap_or("root").to_string();
    VerifiedApiMap::of_wire(v.get("signed")?.as_object()?.clone(), signer)
}

fn held_value(vm: &VerifiedApiMap) -> Value {
    json!({"signed": Value::Object(vm.wire.clone()), "signer": vm.signer})
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            crate::meet::log_warn(&format!("api store file unreadable path={} why={e}", path.display()));
            None
        }
    }
}

fn write_flushed(path: &Path, v: &Value) -> Res<()> {
    if let Some(parent) = path.parent() {
        crate::store::make_dir(parent).map_err(|e| ApiMapError::new("io", format!("{}: {e}", parent.display())))?;
    }
    let data = serde_json::to_vec(v).map_err(|e| ApiMapError::new("io", e.to_string()))?;
    crate::fleet_local::write_durable(path, &data).map_err(|e| ApiMapError::new("io", e))
}

impl ApiMapStore {
    /// The store kept under `dir` (every org file found), or an empty one in memory without a folder.
    pub fn load(dir: Option<&Path>) -> ApiMapStore {
        let mut store = ApiMapStore { dir: dir.map(Path::to_path_buf), orgs: BTreeMap::new() };
        let Some(dir) = dir else { return store };
        for (sub, is_map) in [(MAPS_DIR, true), (JOURNAL_DIR, false)] {
            let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(org) = name.strip_suffix(".json").filter(|o| slug(o, 32)) else { continue };
                let Some(v) = read_json(&entry.path()) else { continue };
                let o = store.orgs.entry(org.to_string()).or_default();
                if is_map {
                    o.pinned = held_of(v.get("pinned")).filter(|m| m.org == org);
                    o.previous = held_of(v.get("previous")).filter(|m| m.org == org);
                } else {
                    o.applied = v.get("applied").and_then(Value::as_u64).unwrap_or(0);
                    o.active = v.get("active").and_then(Value::as_array).into_iter().flatten().filter_map(|e| TightenEntry::parse(e).ok()).collect();
                }
            }
        }
        store
    }

    fn path(&self, sub: &str, org: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(sub).join(format!("{org}.json")))
    }

    fn save_map(&self, org: &str, o: &OrgApi) -> Res<()> {
        let Some(path) = self.path(MAPS_DIR, org) else { return Ok(()) };
        let mut v = Obj::new();
        if let Some(p) = &o.pinned {
            v.insert("pinned".into(), held_value(p));
        }
        if let Some(p) = &o.previous {
            v.insert("previous".into(), held_value(p));
        }
        write_flushed(&path, &Value::Object(v))
    }

    fn save_journal(&self, org: &str, o: &OrgApi) -> Res<()> {
        let Some(path) = self.path(JOURNAL_DIR, org) else { return Ok(()) };
        let active: Vec<Value> = o.active.iter().map(TightenEntry::to_value).collect();
        write_flushed(&path, &json!({"applied": o.applied, "active": active}))
    }

    fn room_for(&self, org: &str) -> Res<()> {
        if !self.orgs.contains_key(org) && self.orgs.len() >= API_MAP_ORGS_MAX {
            return bad("this relay already holds the api maps of 64 organizations");
        }
        Ok(())
    }

    /// 2.4: verify a signed map (with the issuers held for other orgs), check its seq against the pin, fold the
    /// journal into it (2.5), and pin it durably before Ok.
    pub fn accept(&mut self, signed: &Value, trust: &ApiTrust, now: i64, policy: Option<&Obj>, edition: Edition) -> Result<AcceptOutcome, ApiMapError> {
        let held = self.issuers();
        let vm = verify_api_map(signed, trust.root, trust.signer_policy, trust.root_crl, trust.previous_serial, now, policy, edition, &held)?;
        self.pin(vm)
    }

    /// Pin a map already verified.
    pub fn pin(&mut self, vm: VerifiedApiMap) -> Result<AcceptOutcome, ApiMapError> {
        self.room_for(&vm.org)?;
        let cur = self.orgs.get(&vm.org).cloned().unwrap_or_default();
        let (pseq, phash) = cur.pinned.as_ref().map_or((0, ""), |p| (p.seq, p.hash.as_str()));
        // the pinned map sent again (a reconnect or a retried upload) changes nothing
        if let Some(p) = cur.pinned.as_ref().filter(|p| p.hash == vm.hash) {
            return Ok(AcceptOutcome::Unchanged(p.clone()));
        }
        match pin_verdict(vm.seq, &vm.hash, pseq, phash) {
            "seq-not-higher" => return fail("seq-not-higher", format!("that api map's seq is not higher than {pseq}")),
            "conflict" => return Ok(AcceptOutcome::Conflict { org: vm.org.clone(), seq: vm.seq, pinned_hash: phash.to_string(), offered_hash: vm.hash }),
            _ => {}
        }
        let remaining = fold(&cur.active, &vm.wire["map"])?;
        let mut next = cur.clone();
        next.previous = cur.pinned.clone();
        next.pinned = Some(vm.clone());
        next.active.retain(|e| remaining.contains(&e.id));
        if next.active != cur.active {
            self.save_journal(&vm.org, &next)?;
        }
        self.save_map(&vm.org, &next)?;
        self.orgs.insert(vm.org.clone(), next);
        Ok(AcceptOutcome::Pinned(vm))
    }

    /// 2.5 rebase: after pinning a map that came with the console's pruned `base`, an applied tseq below it moves up
    /// to it (the pinned map holds the pruned entries' effect), flushed before Ok(Some(previous)). A base at or below
    /// the applied tseq changes nothing (Ok(None)).
    pub fn rebase(&mut self, org: &str, base: u64) -> Result<Option<u64>, ApiMapError> {
        let cur = self.orgs.get(org).cloned().unwrap_or_default();
        if base <= cur.applied || cur.pinned.is_none() {
            return Ok(None);
        }
        let from = cur.applied;
        let mut next = cur;
        next.applied = base;
        self.save_journal(org, &next)?;
        self.orgs.insert(org.to_string(), next);
        Ok(Some(from))
    }

    /// 2.5: apply one journal entry for `org` (its tseq exactly the next) and flush the journal before Ok(tseq).
    pub fn apply_tighten(&mut self, org: &str, entry: &Value) -> Result<u64, ApiMapError> {
        self.room_for(org)?;
        let cur = self.orgs.get(org).cloned().unwrap_or_default();
        let e = check_tighten(entry, cur.applied)?;
        if e.org != org {
            return not_tightening("that entry is for another organization");
        }
        let mut next = cur;
        next.applied = e.tseq;
        next.active.push(e);
        self.save_journal(org, &next)?;
        let tseq = next.applied;
        self.orgs.insert(org.to_string(), next);
        Ok(tseq)
    }
}

// Read by the fleet channel (api-tighten, hello), the TLS verifiers (grace) and the API listener, which build on this.
#[cfg_attr(not(test), allow(dead_code))]
impl ApiMapStore {
    /// The org's pinned map when it has not expired at `now`.
    fn live(&self, org: &str, now: i64) -> Option<&VerifiedApiMap> {
        self.orgs.get(org)?.pinned.as_ref().filter(|p| p.expires > now)
    }

    /// 3.3: the org's grace for `kind` (hours, lowered by journaled `grace_lower`), None without a pinned unexpired
    /// map (which counts 0).
    pub fn grace_hours(&self, org: &str, kind: &str, now: i64) -> Option<u32> {
        let p = self.live(org, now)?;
        let base = p.map().get("grace").and_then(|g| g.get(kind)).and_then(int_of)?;
        let lowered = self.orgs[org].active.iter().filter(|e| e.action == "grace_lower" && e.field("kind") == kind).filter_map(|e| e.target.get("hours").and_then(int_of));
        let h = lowered.fold(base, i64::min);
        u32::try_from(h.clamp(0, GRACE_MAX_HOURS)).ok()
    }

    /// `issuer.url` of every pinned map, by org.
    pub fn issuers(&self) -> BTreeMap<String, String> {
        self.orgs.iter().filter_map(|(o, a)| a.pinned.as_ref().map(|p| (o.clone(), p.issuer_url().to_string()))).collect()
    }

    /// `(pinned seq, last applied tseq)`, what `hello` reports per org (0 for none).
    pub fn head(&self, org: &str) -> (i64, u64) {
        self.orgs.get(org).map_or((0, 0), |o| (o.pinned.as_ref().map_or(0, |p| p.seq), o.applied))
    }

    /// An active `api_off` (2.5).
    pub fn is_off(&self, org: &str) -> bool {
        self.orgs.get(org).is_some_and(|o| o.active.iter().any(|e| e.action == "api_off"))
    }

    /// `GET /v1/org/api?org=` (the pinned map) or `&sha256=` (the pinned or previous map with that hash).
    pub fn get(&self, org: &str, sha256: &str) -> Option<&VerifiedApiMap> {
        let o = self.orgs.get(org)?;
        if sha256.is_empty() {
            return o.pinned.as_ref();
        }
        let want = sha256.to_lowercase();
        [o.pinned.as_ref(), o.previous.as_ref()].into_iter().flatten().find(|m| m.hash == want)
    }

    fn pinned_list(&self, org: &str, k: &str) -> &[Value] {
        self.orgs.get(org).and_then(|o| o.pinned.as_ref()).and_then(|p| p.map().get(k)).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
    }

    /// The pinned map's `clients`.
    pub fn clients(&self, org: &str) -> &[Value] {
        self.pinned_list(org, "clients")
    }

    /// The pinned map's `scrape_tokens`.
    pub fn scrape_tokens(&self, org: &str) -> &[Value] {
        self.pinned_list(org, "scrape_tokens")
    }

    /// The pinned map's `relay_origins`.
    pub fn relay_origins(&self, org: &str) -> Option<&Obj> {
        self.orgs.get(org)?.pinned.as_ref()?.map().get("relay_origins").and_then(Value::as_object)
    }

    /// Journal entries still active for the org.
    pub fn active(&self, org: &str) -> &[TightenEntry] {
        self.orgs.get(org).map_or(&[][..], |o| o.active.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../tests/api_map_v1.json");
    const NOW: i64 = 1_795_000_000;
    /// A 43 character base64url coordinate (32 bytes).
    fn x() -> String {
        "A".repeat(43)
    }

    fn policy() -> Obj {
        json!({"org": "acme", "domains": ["acme.example"], "apps": [{"type": "ai", "principal": "lucid-ai@apps.acme.example", "name": "lucid-ai"}]})
            .as_object()
            .unwrap()
            .clone()
    }

    fn client(id: &str, name: &str) -> Value {
        json!({"id": id, "name": name, "principal": format!("{name}@apps.acme.example"), "kind": "monitoring",
               "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read", "audit.read"], "ceiling": "internal",
               "relays": ["*"], "networks": ["10.40.0.0/23"], "mtls_required": false,
               "rate": {"per_minute_each": 120, "per_day_each": 100000},
               "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": x(), "y": x()}, "expires": NOW + 90 * DAY}],
               "created": NOW, "expires": NOW + 300 * DAY, "state": "active"})
    }

    fn good_map(seq: i64) -> Value {
        json!({"v": 1, "org": "acme", "seq": seq, "issued": NOW, "expires": NOW + 30 * DAY,
               "issuer": {"url": "https://console.acme.example:7443/api/orgs/acme",
                          "jwks": [{"kty": "EC", "crv": "P-256", "kid": "k-2026-11", "x": x(), "y": x(), "use": "sig", "alg": "ES256", "nbf": NOW, "exp": NOW + 90 * DAY}]},
               "grace": {"person": 0, "app": 24, "connector": 0, "relay": 12},
               "failover_after_s": 300, "folded": [], "cleared": [],
               "relay_origins": {"r_01": "https://relay1.acme.example:9443"},
               "clients": [client("c_5f1a2b3c4d5e6f70", "splunk-scrape")],
               "scrape_tokens": [{"sha256": "a".repeat(64), "hint": "lme_ab12", "label": "prometheus-dc1", "relays": ["*"], "expires": NOW + 60 * DAY}],
               "destinations": [{"id": "d_9a8b7c6d5e4f3a2b", "name": "Splunk HEC", "kind": "splunk_hec", "preset": "splunk_hec",
                                 "signals": ["audit", "logs"], "ceiling": "internal", "identities": "pseudonymized", "failover": false,
                                 "private_ok": false, "endpoint": "https://hec.acme.example:8088/services/collector/event",
                                 "settings": {"index": "lucid", "ack": true},
                                 "credential": {"type": "token", "ref": "secret:d_9a8b7c6d5e4f3a2b"},
                                 "queue": {"max_bytes": 1073741824, "max_age_s": 259200}}]})
    }

    fn verified(map: Value) -> VerifiedApiMap {
        let wire = json!({"map": map, "sig": "", "chain": []});
        VerifiedApiMap::of_wire(wire.as_object().unwrap().clone(), "root".into()).unwrap()
    }

    fn entry(tseq: u64, action: &str, target: Value) -> Value {
        json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW - 100, "action": action, "target": target})
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-map-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn code<T>(r: Result<T, ApiMapError>) -> &'static str {
        r.err().map_or("ok", |e| e.code)
    }

    #[test]
    fn api_map_field_rules_and_edition_limits() {
        let p = policy();
        let none = BTreeMap::new();
        let check = |m: &Value, ed: Edition| code(check_api_map(m, NOW, Some(&p), ed, &none));
        assert_eq!(check(&good_map(1), Edition::Enterprise), "ok");
        let mut m = good_map(1);
        m["grace"]["app"] = json!(169);
        assert_eq!(check(&m, Edition::Enterprise), "grace-limit");
        let mut m = good_map(1);
        m["grace"]["guest"] = json!(1);
        assert_eq!(check(&m, Edition::Enterprise), "grace-limit");
        let mut m = good_map(1);
        m["clients"][0]["nickname"] = json!("x");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["clients"][0]["ceiling"] = json!("cui");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["failover_after_s"] = Value::Null;
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["clients"][0]["name"] = json!("lucid-ai");
        m["clients"][0]["principal"] = json!("lucid-ai@apps.acme.example");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        // standard: no splunk_hec
        assert_eq!(check(&good_map(1), Edition::Standard), "license");
        let held = BTreeMap::from([("other".to_string(), "https://console.acme.example:7443/api/orgs/acme".to_string())]);
        assert_eq!(code(check_api_map(&good_map(1), NOW, Some(&p), Edition::Enterprise, &held)), "issuer-taken");
    }

    #[test]
    fn api_map_store_persists_across_reload_and_alarms_on_conflict() {
        let dir = temp("persist");
        let mut s = ApiMapStore::load(Some(&dir));
        let first = verified(good_map(1));
        assert!(matches!(s.pin(first.clone()), Ok(AcceptOutcome::Pinned(_))));
        let mut m2 = good_map(2);
        m2["grace"]["app"] = json!(48);
        let second = verified(m2.clone());
        assert!(matches!(s.pin(second.clone()), Ok(AcceptOutcome::Pinned(_))));
        assert!(matches!(s.pin(second.clone()), Ok(AcceptOutcome::Unchanged(_))));
        assert_eq!(code(s.pin(first.clone())), "seq-not-higher");
        m2["grace"]["app"] = json!(1);
        let other = verified(m2);
        match s.pin(other.clone()) {
            Ok(AcceptOutcome::Conflict { seq, pinned_hash, offered_hash, .. }) => {
                assert_eq!((seq, pinned_hash, offered_hash), (2, second.hash.clone(), other.hash.clone()));
            }
            r => panic!("expected a conflict, got {r:?}"),
        }
        assert_eq!(s.apply_tighten("acme", &entry(1, "grace_lower", json!({"kind": "app", "hours": 6}))), Ok(1));
        let back = ApiMapStore::load(Some(&dir));
        assert_eq!(back.head("acme"), (2, 1));
        assert_eq!(back.get("acme", "").map(|m| m.hash.clone()), Some(second.hash.clone()));
        assert_eq!(back.get("acme", &first.hash.to_uppercase()).map(|m| m.seq), Some(1));
        assert_eq!(back.grace_hours("acme", "app", NOW), Some(6));
        assert_eq!(back.grace_hours("acme", "relay", NOW), Some(12));
        assert_eq!(back.grace_hours("acme", "app", NOW + 31 * DAY), None);
        assert_eq!(back.issuers().get("acme").map(String::as_str), Some("https://console.acme.example:7443/api/orgs/acme"));
        assert_eq!(back.clients("acme").len(), 1);
        assert_eq!(back.scrape_tokens("acme").len(), 1);
        assert!(back.relay_origins("acme").is_some_and(|o| o.contains_key("r_01")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_journal_refuses_gaps_and_widening() {
        let mut s = ApiMapStore::load(None);
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "client_suspend", json!("c_5f1a2b3c4d5e6f70")))), "tseq-gap");
        assert_eq!(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))), Ok(1));
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "client_resume", json!("c_5f1a2b3c4d5e6f70")))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "destination_identities", json!({"destination": "d_9a8b7c6d5e4f3a2b", "identities": "as_is"})))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "grace_lower", json!({"kind": "app", "hours": 169})))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70")))), "tseq-gap");
        assert_eq!(s.apply_tighten("acme", &entry(2, "api_off", json!("acme"))), Ok(2));
        assert!(s.is_off("acme"));
        assert_eq!(s.head("acme"), (0, 2));
    }

    #[test]
    fn api_maps_fold_and_clear_journal_entries() {
        let active: Vec<TightenEntry> = [
            entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70")),
            entry(2, "destination_disable_failover", json!("d_9a8b7c6d5e4f3a2b")),
            entry(3, "scrape_deny", json!("a".repeat(64))),
        ]
        .iter()
        .map(|e| TightenEntry::parse(e).unwrap())
        .collect();
        // folds a suspension the map does not contain
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000001"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // contains it
        m["clients"][0]["state"] = json!("suspended");
        m["folded"] = json!(["t_acme_000001", "t_acme_000002"]);
        assert_eq!(fold(&active, &m), Ok(vec!["t_acme_000003".to_string()]));
        // clears the suspension (signed widening after the entry), folds failover off
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000002"]);
        m["cleared"] = json!(["t_acme_000001"]);
        assert_eq!(fold(&active, &m), Ok(vec!["t_acme_000003".to_string()]));
        // a deny is never cleared; a clear needs a later map
        m["cleared"] = json!(["t_acme_000003"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        let mut m = good_map(2);
        m["issued"] = json!(NOW - 200);
        m["cleared"] = json!(["t_acme_000001"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // both ways
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000002"]);
        m["cleared"] = json!(["t_acme_000002"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // pinning folds the store's journal
        let mut s = ApiMapStore::load(None);
        s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))).unwrap();
        let mut m = good_map(1);
        m["cleared"] = json!(["t_acme_000001"]);
        assert!(matches!(s.pin(verified(m)), Ok(AcceptOutcome::Pinned(_))));
        assert!(s.active("acme").is_empty());
    }

    #[test]
    fn api_grace_effective_end_takes_the_minimum() {
        assert_eq!(effective_end(1000, &[]), 1000);
        assert_eq!(effective_end(1000, &[Some(2), Some(5)]), 1000 + 2 * 3600);
        assert_eq!(effective_end(1000, &[Some(2), None]), 1000);
        assert_eq!(effective_end(1000, &[Some(168)]), 1000 + 168 * 3600);
    }

    #[test]
    fn the_api_map_vectors_give_the_expected_verdicts() {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(doc["v"], 1);
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap();
        assert!(op::verify_signer_policy(&root, sp));
        let now = doc["now"].as_i64().unwrap();
        let policy = doc["policy"].as_object();
        let none = BTreeMap::new();
        let mut seen = 0;
        let mut codes: BTreeSet<&str> = BTreeSet::new();
        for c in doc["maps"].as_array().unwrap() {
            let edition = Edition::of(c["edition"].as_str());
            let held: BTreeMap<String, String> = c["held_issuers"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
            let got = code(check_api_map(&c["map"], now, policy, edition, &held));
            assert_eq!(got, c["expect"].as_str().unwrap(), "maps/{}", c["name"]);
            codes.insert(got);
            seen += 1;
        }
        for c in doc["signed"].as_array().unwrap() {
            let got = (|| -> Result<String, ApiMapError> {
                let vm = verify_api_map(&c["signed"], &root, sp, None, "", now, policy, Edition::Enterprise, &none)?;
                match pin_verdict(vm.seq, &vm.hash, c["pinned_seq"].as_i64().unwrap(), c["pinned_hash"].as_str().unwrap()) {
                    "ok" => Ok(vm.hash),
                    v => Err(ApiMapError::new(v, v)),
                }
            })();
            match got {
                Ok(hash) => {
                    assert_eq!(c["expect"], "ok", "signed/{}", c["name"]);
                    assert_eq!(c["hash"].as_str().unwrap(), hash, "signed/{}", c["name"]);
                }
                Err(e) => {
                    assert_eq!(e.code, c["expect"].as_str().unwrap(), "signed/{}: {}", c["name"], e.message);
                    codes.insert(e.code);
                }
            }
            seen += 1;
        }
        for c in doc["journal"].as_array().unwrap() {
            let got = code(check_tighten(&c["entry"], c["applied_tseq"].as_u64().unwrap()));
            assert_eq!(got, c["expect"].as_str().unwrap(), "journal/{}", c["name"]);
            codes.insert(got);
            seen += 1;
        }
        for c in doc["fold"].as_array().unwrap() {
            let active: Vec<TightenEntry> = c["active"].as_array().unwrap().iter().map(|e| TightenEntry::parse(e).unwrap()).collect();
            match (fold(&active, &c["map"]), &c["expect"]) {
                (Ok(remaining), Value::Object(want)) => assert_eq!(json!(remaining), want["remaining"], "fold/{}", c["name"]),
                (Err(e), Value::String(want)) => assert_eq!(e.code, want.as_str(), "fold/{}", c["name"]),
                (got, want) => panic!("fold/{}: got {got:?}, want {want}", c["name"]),
            }
            seen += 1;
        }
        for c in doc["grace"].as_array().unwrap() {
            let hours: Vec<Option<u32>> = c["org_graces"].as_array().unwrap().iter().map(|h| h.as_u64().map(|h| h as u32)).collect();
            let end = effective_end(c["raw_end"].as_i64().unwrap(), &hours);
            let admit = c["now"].as_i64().unwrap() <= end;
            assert_eq!(json!({"effective_end": end, "admit": admit}), c["expect"], "grace/{}", c["name"]);
            seen += 1;
        }
        assert!(seen >= 60, "only {seen} cases");
        for want in ["bad-map", "grace-limit", "license", "issuer-taken", "fold-mismatch", "signature", "seq-not-higher", "conflict", "map-expired", "tseq-gap", "not-tightening"] {
            assert!(codes.contains(want), "no vector refuses with {want}");
        }
        assert!(doc["api_max_bytes"].as_u64().unwrap() as usize <= API_MAP_MAX);
    }
}
