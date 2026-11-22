// Contract API-1 (docs/api/contract.md) 4.2, 4.3, 5.1 to 5.6 and the 6.1 Token pipeline: the OAuth token endpoint
// (client credentials and RFC 8693 token exchange) and the RFC 7009 revocation endpoint shared by the console's front
// door (issuer I) and every relay's local issuer (L), and the RFC 8414, RFC 9728 and JWKS documents both serve.
//
// The caller selects the org from the request path (never by searching maps), hands over a read-only snapshot of
// that org's store (a JWKS or discovery fetch may block, so no store lock is held across a call), the issuer's
// signing key, and appends `Answer.event` (`api.token`, `api.revoke`, `api.refusal`) to the org's 9.4 audit chain
// before it releases the answer (`api_resource::token_audited`; a revocation is audited inside its journal call).

use crate::api_fetch::{check_url, FetchCache, Limits};
use crate::api_map::{effective_end, ApiMapStore, TightenEntry, CEILINGS};
use crate::api_token::{self as tok, Cnf, JtiCache, Lifetime, SubjectClaims, TokenError};
use crate::codec::{b64_decode_lenient, b64u, hex, sha256};
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;

type Obj = Map<String, Value>;

/// The largest token or revocation request body (5.2).
pub const FORM_MAX: usize = 16 * 1024;
/// 6.5: requests per source address and minute on the public and token pipelines.
pub const SOURCE_PER_MINUTE: usize = 120;
/// 8.1: the largest discovery or JWKS body.
pub const FETCH_MAX: usize = 256 * 1024;
const MINUTE: i64 = 60;
const DAY: i64 = 86_400;
/// The sentence of a `license` refusal.
pub const LICENSE_WHY: &str = "The product license of this server is not active, so it issues no tokens.";
/// Window keys held before the stale ones are swept.
const WINDOW_KEYS: usize = 4096;
const GRANT_CLIENT_CREDENTIALS: &str = "client_credentials";
const GRANT_TOKEN_EXCHANGE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const JWT_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:jwt";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const AUTH_METHODS: [&str; 3] = ["tls_client_auth", "private_key_jwt", "client_secret_basic"];

// ---- state --------------------------------------------------------------------------------------------------------

/// One listener's issuer state (6.5): the client assertion and DPoP `jti` caches, the per-source request windows and
/// the per-client issuance windows (a minute of instants; a day of per-minute counts).
pub struct IssueState {
    assertions: Mutex<JtiCache>,
    dpop: Mutex<JtiCache>,
    sources: Mutex<HashMap<String, VecDeque<i64>>>,
    issued: Mutex<HashMap<String, VecDeque<i64>>>,
    issued_daily: Mutex<HashMap<String, VecDeque<(i64, u64)>>>,
}

impl Default for IssueState {
    fn default() -> IssueState {
        IssueState {
            assertions: Mutex::new(JtiCache::assertion()),
            dpop: Mutex::new(JtiCache::dpop()),
            sources: Mutex::default(),
            issued: Mutex::default(),
            issued_daily: Mutex::default(),
        }
    }
}

impl IssueState {
    pub fn new() -> IssueState {
        IssueState::default()
    }

    /// 6.5 source limiter: count one request of `ip` (an IPv6 address by its /64) at `now`, at most 120 a minute. Err
    /// is the seconds until the oldest request leaves the window (`Retry-After`). `token` and `revoke` charge it
    /// themselves; the public documents call it after the org is known.
    pub fn source_ok(&self, ip: IpAddr, now: i64) -> Result<(), i64> {
        take(&self.sources, &crate::console_source::source_key(ip), SOURCE_PER_MINUTE, now).map(|_| ()).map_err(|l| match l {
            Limit::Wait(s) => s,
            Limit::Full => MINUTE,
        })
    }

    /// The client's issuance windows on this listener (API1-R20): `rate.per_minute_each` over the last minute, then
    /// `rate.per_day_each` over the last day (`rate`); a window map already full of live clients refuses a new one
    /// (`abuse`).
    fn issue_ok(&self, org: &str, client: &str, per_minute: usize, per_day: u64, now: i64) -> Result<(), Refusal> {
        let key = format!("{org} {client}");
        let refuse = |l: Limit| match l {
            Limit::Wait(s) => Refusal { retry: Some(s), ..no("rate", "This client asked for too many tokens; see Retry-After.") },
            Limit::Full => Refusal { retry: Some(MINUTE), ..no("abuse", "Too many clients are asking at once; try again later.") },
        };
        take(&self.issued, &key, per_minute, now).map_err(refuse)?;
        take_daily(&self.issued_daily, &key, per_day, now).map_err(refuse)
    }
}

/// Why a window refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Limit {
    /// The key's window is full: the seconds until a place frees.
    Wait(i64),
    /// The map already holds `WINDOW_KEYS` live keys after the stale ones were swept: a new key is refused, so a flood
    /// of new sources or clients cannot grow it without bound.
    Full,
}

/// Take one place in a one-day sliding window kept as per-minute counts (at most 1440 per key); a minute's count
/// leaves once its minute began a day ago.
pub(crate) fn take_daily(windows: &Mutex<HashMap<String, VecDeque<(i64, u64)>>>, key: &str, n: u64, now: i64) -> Result<(), Limit> {
    let gone = |minute: i64| now - minute * MINUTE >= DAY;
    let mut m = windows.lock();
    if m.len() >= WINDOW_KEYS && !m.contains_key(key) {
        m.retain(|_, q| q.back().is_some_and(|(b, _)| !gone(*b)));
        if m.len() >= WINDOW_KEYS {
            return Err(Limit::Full);
        }
    }
    let q = m.entry(key.to_string()).or_default();
    while q.front().is_some_and(|(b, _)| gone(*b)) {
        q.pop_front();
    }
    if q.iter().map(|(_, c)| c).sum::<u64>() >= n {
        return Err(Limit::Wait(q.front().map_or(DAY, |(b, _)| b * MINUTE + DAY - now).max(1)));
    }
    let minute = now.div_euclid(MINUTE);
    match q.back_mut() {
        Some((b, c)) if *b == minute => *c += 1,
        _ => q.push_back((minute, 1)),
    }
    Ok(())
}

/// Take one place in a one-minute sliding window of `n`: Ok is (places used now, seconds until the oldest leaves).
pub(crate) fn take(windows: &Mutex<HashMap<String, VecDeque<i64>>>, key: &str, n: usize, now: i64) -> Result<(usize, i64), Limit> {
    let mut m = windows.lock();
    if m.len() >= WINDOW_KEYS && !m.contains_key(key) {
        m.retain(|_, q| q.back().is_some_and(|t| now - t < MINUTE));
        if m.len() >= WINDOW_KEYS {
            return Err(Limit::Full);
        }
    }
    let q = m.entry(key.to_string()).or_default();
    while q.front().is_some_and(|t| now - t >= MINUTE) {
        q.pop_front();
    }
    if q.len() >= n {
        return Err(Limit::Wait(q.front().map_or(MINUTE, |f| f + MINUTE - now).max(1)));
    }
    q.push_back(now);
    Ok((q.len(), q.front().map_or(MINUTE, |f| f + MINUTE - now).max(1)))
}

// ---- the interface ------------------------------------------------------------------------------------------------

/// A client certificate presented on the connection (`tls_client_auth`, 4.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientCert {
    /// `x5t#S256`: the base64url SHA-256 of the leaf's DER.
    pub sha256_b64u: String,
    /// The leaf's serial, lowercase hex without leading zeros.
    pub serial: String,
    /// The SHA-256 of the leaf's SubjectPublicKeyInfo, lowercase hex (an `mtls` credential's `spki`).
    pub spki_sha256: String,
    /// The leaf's `notAfter` (seconds).
    pub not_after: i64,
    /// Verified by the TLS layer against the org Meet CA, its CRL and the `app` grace (3.3).
    pub chain_ok: bool,
    /// The certificate's kind from its SAN URIs (`meet_hub::pc::cert_kind`: `person`, `app`, `archive`, `sso`, ...;
    /// `relay` for a relay certificate; empty when the URIs are refused).
    pub kind: String,
    /// The first SAN email, lower case (an app's `<name>@apps.<domain>`); empty without one.
    pub principal: String,
    /// The org ids of its `urn:lucid-meet:org:<id>` SAN URIs.
    pub orgs: Vec<String>,
}

impl ClientCert {
    /// The facts of a leaf certificate (DER); None when it does not parse.
    pub fn of_leaf(der: &[u8], chain_ok: bool) -> Option<ClientCert> {
        let c = crate::meet_x509::Cert::from_der(der)?;
        let uris = &c.names.uris;
        let (kind, orgs) = if uris.iter().any(|u| u == crate::meet::RELAY_URI) {
            ("relay".to_string(), Vec::new())
        } else {
            crate::meet_hub::pc::cert_kind(uris).unwrap_or_default()
        };
        let principal = c.names.emails.first().map(|e| e.trim().to_lowercase()).unwrap_or_default();
        Some(ClientCert { sha256_b64u: b64u(&sha256(der)), serial: c.serial, spki_sha256: hex(&sha256(&c.spki)), not_after: c.not_after, chain_ok, kind, principal, orgs })
    }

    /// 4.2 `tls_client_auth`: an app certificate (kind `app`, a `<name>@apps.<domain>` email) of this client's
    /// `principal`, naming `org`, verified by the TLS layer, whose serial and SPKI match one of `credentials`.
    pub(crate) fn authenticates(&self, client: &Obj, org: &str, credentials: &[&Value]) -> bool {
        let principal = client.get("principal").and_then(Value::as_str).unwrap_or_default();
        self.chain_ok
            && self.kind == "app"
            && crate::meet_hub::pc::service_kind(&self.principal) == "app"
            && !principal.is_empty()
            && self.principal.eq_ignore_ascii_case(principal)
            && self.orgs.iter().any(|o| o == org)
            && credentials.iter().any(|cr| mtls_matches(cr, self))
    }
}

/// What one issuer brings to a token or revocation request.
pub struct IssueCtx<'a> {
    pub org: &'a str,
    /// I (console) or L (relay-local).
    pub issuer: &'a str,
    /// `issuer` + `/oauth/token`: the client assertion `aud` and the DPoP `htu`.
    pub token_endpoint: &'a str,
    /// The `aud` values this issuer mints, the default (no `resource`) first: the console's I plus every relay
    /// resource of the map; a relay's RR.
    pub resources: &'a [String],
    /// The only scopes this issuer grants (relay-local, 5.6); None for the console.
    pub local_scopes: Option<&'a [&'static str]>,
    pub key: &'a EcdsaKeyPair,
    pub kid: &'a str,
    /// A snapshot of the org's store (pinned map and active journal).
    pub store: &'a ApiMapStore,
    /// 4.3: the owner principal is an active person of the org.
    pub owner_active: &'a dyn Fn(&str) -> bool,
    pub fetch: &'a FetchCache,
    pub state: &'a IssueState,
    /// 6.1 `license`: the listener's product license lets it serve (false refuses every token request, 403).
    pub licensed: bool,
    pub now: i64,
}

/// The HTTP request as the endpoint sees it.
pub struct TokenHttp<'a> {
    pub form: &'a [u8],
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
    pub client_cert: Option<&'a ClientCert>,
    pub source: IpAddr,
}

/// An answer: status, JSON body, headers, and the decision the caller appends to the org's audit chain (9.4).
#[derive(Clone, Debug)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub headers: Vec<(&'static str, String)>,
    pub event: Option<(&'static str, Value)>,
}

// ---- answers ------------------------------------------------------------------------------------------------------

/// A refusal before it becomes an answer: the contract code, a sentence, `Retry-After` seconds.
struct Refusal {
    code: &'static str,
    why: String,
    retry: Option<i64>,
}

fn no(code: &'static str, why: impl Into<String>) -> Refusal {
    Refusal { code, why: why.into(), retry: None }
}

/// "the key is unknown" as "The key is unknown."
pub(crate) fn sentence(s: &str) -> String {
    let mut c = s.chars();
    let mut out: String = c.next().map(|f| f.to_uppercase().collect()).unwrap_or_default();
    out.push_str(c.as_str());
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

impl From<TokenError> for Refusal {
    fn from(e: TokenError) -> Refusal {
        no(e.code, sentence(&e.message))
    }
}

/// The HTTP status and RFC 6749 5.2 `error` (RFC 8707 `invalid_target`, RFC 9449 `invalid_dpop_proof`) of a code.
fn shape(code: &str) -> (u16, &'static str) {
    match code {
        "abuse" | "rate" => (429, "invalid_request"),
        "map-expired" | "client" | "client-auth" | "expired" => (401, "invalid_client"),
        "license" | "map-edition" | "api-off" | "suspended" | "owner" | "network" | "hours" | "mtls" => (403, "unauthorized_client"),
        "grant" => (400, "unsupported_grant_type"),
        "scope" => (400, "invalid_scope"),
        "target" => (400, "invalid_target"),
        "subject" => (400, "invalid_grant"),
        "dpop" | "dpop-replay" | "dpop-required" => (400, "invalid_dpop_proof"),
        "too-large" => (413, "invalid_request"),
        "fetch" | "sign" | "journal" | "issuer-key-unlisted" | "audit-unavailable" => (503, "temporarily_unavailable"),
        _ => (400, "invalid_request"),
    }
}

fn no_store() -> Vec<(&'static str, String)> {
    vec![("Cache-Control", "no-store".into()), ("Pragma", "no-cache".into())]
}

/// An OAuth error answer (RFC 6749 5.2: `error`, `error_description`, plus the contract's `code`), never cached, with
/// its `api.refusal` line. `retry_after` adds `Retry-After`.
pub fn refusal(org: &str, source: IpAddr, client: Option<&str>, code: &'static str, why: &str, retry_after: Option<i64>) -> Answer {
    let (status, error) = shape(code);
    let mut headers = no_store();
    if let Some(s) = retry_after {
        headers.push(("Retry-After", s.max(1).to_string()));
    }
    let mut event = json!({"org": org, "code": code, "source": source.to_string(), "why": why});
    if let Some(c) = client {
        event["client"] = json!(c);
    }
    Answer { status, body: json!({"error": error, "error_description": why, "code": code}), headers, event: Some(("api.refusal", event)) }
}

/// An RFC 9457 problem answer under `/api/orgs/` (8.2), for the public documents (404 `not-found`, 429 `abuse`).
pub fn problem(status: u16, code: &str, detail: &str) -> Answer {
    let title = match status {
        404 => "Not found",
        429 => "Too many requests",
        503 => "Unavailable",
        _ => "Refused",
    };
    let body = json!({"ok": false, "code": code, "error": detail, "type": format!("https://lucid.emertins.com/problems/{code}"),
                      "title": title, "status": status, "detail": detail});
    Answer { status, body, headers: vec![("Content-Type", "application/problem+json".into()), ("Cache-Control", "no-store".into())], event: None }
}

/// A public document (5.1), cacheable for five minutes.
pub fn document(body: Value) -> Answer {
    Answer { status: 200, body, headers: vec![("Cache-Control", "max-age=300".into())], event: None }
}

/// The 6.1 token pipeline's map checks: `map-edition` while the pinned map is set aside for the license edition (13),
/// `map-expired` without a pinned unexpired map, then `api-off`.
pub fn closed(store: &ApiMapStore, org: &str, now: i64) -> Option<&'static str> {
    if store.is_set_aside(org) {
        return Some("map-edition");
    }
    if !store.get(org, "").is_some_and(|m| m.expires > now) {
        return Some("map-expired");
    }
    store.is_off(org).then_some("api-off")
}

/// The sentence of a `closed` code.
pub fn closed_why(code: &str) -> &'static str {
    match code {
        "api-off" => "The API is off for this organization.",
        "map-edition" => "The organization's api map exceeds what the license edition allows, or the edition is not known.",
        _ => "The organization has no unexpired api map.",
    }
}

// ---- documents (5.1, 5.6) -----------------------------------------------------------------------------------------

/// RFC 8414 authorization server metadata (5.1; 5.6 for a relay-local issuer, which has no revocation endpoint).
pub fn as_metadata(issuer: &str, token_endpoint: &str, revocation_endpoint: Option<&str>, jwks_uri: &str) -> Value {
    let mut v = json!({
        "issuer": issuer,
        "token_endpoint": token_endpoint,
        "jwks_uri": jwks_uri,
        "grant_types_supported": [GRANT_CLIENT_CREDENTIALS, GRANT_TOKEN_EXCHANGE],
        "token_endpoint_auth_methods_supported": AUTH_METHODS,
        "tls_client_certificate_bound_access_tokens": true,
        "dpop_signing_alg_values_supported": ["ES256"],
        "authorization_response_iss_parameter_supported": true,
    });
    if let Some(r) = revocation_endpoint {
        v["revocation_endpoint"] = json!(r);
    }
    v
}

/// RFC 9728 protected resource metadata.
pub fn resource_metadata(resource: &str, authorization_servers: &[&str], scopes: &[&str]) -> Value {
    json!({"resource": resource, "authorization_servers": authorization_servers, "scopes_supported": scopes, "bearer_methods_supported": ["header"]})
}

/// A JWKS document.
pub fn jwks(keys: &[Value]) -> Value {
    json!({ "keys": keys })
}

/// The public JWK of a P-256 signing key under `kid` (`use` sig, `alg` ES256).
pub fn ec_public_jwk(key: &EcdsaKeyPair, kid: &str) -> Value {
    let p = key.public_key().as_ref();
    json!({"kty": "EC", "crv": "P-256", "kid": kid, "x": b64u(p.get(1..33).unwrap_or_default()), "y": b64u(p.get(33..65).unwrap_or_default()),
           "use": "sig", "alg": "ES256"})
}

// ---- request parsing ----------------------------------------------------------------------------------------------

/// Form decoding: `+` is a space, `%XX` two hex digits, the result UTF-8.
fn unescape(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let h = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit))?;
                out.push(u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()?);
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// An `application/x-www-form-urlencoded` body (5.2): at most 16 KiB, UTF-8, strict escapes, no parameter twice
/// (RFC 6749 3.2); a parameter without a value counts as absent.
fn form_of(body: &[u8]) -> Result<HashMap<String, String>, Refusal> {
    if body.len() > FORM_MAX {
        return Err(no("too-large", "The request body is larger than 16 KiB."));
    }
    let text = std::str::from_utf8(body).map_err(|_| no("request", "The request body is not UTF-8."))?;
    let mut out = HashMap::new();
    for pair in text.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (Some(k), Some(v)) = (unescape(k), unescape(v)) else { return Err(no("request", "The request body is not a valid form.")) };
        if v.is_empty() {
            continue;
        }
        if out.insert(k, v).is_some() {
            return Err(no("request", "A parameter appears more than once."));
        }
    }
    Ok(out)
}

/// HTTP Basic client credentials (RFC 6749 2.3.1: the id and secret form-encoded, then base64).
fn basic_of(header: &str) -> Option<(String, String)> {
    let (scheme, value) = header.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let v = value.trim();
    if v.is_empty() || !v.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')) {
        return None;
    }
    let raw = String::from_utf8(b64_decode_lenient(v)).ok()?;
    let (id, secret) = raw.split_once(':')?;
    Some((unescape(id)?, unescape(secret)?))
}

fn kind_of(c: &Value) -> &str {
    c.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn private_ok(c: &Value) -> bool {
    c.get("private_ok").and_then(Value::as_bool).unwrap_or(false)
}

fn keys_of(doc: &Value) -> Vec<Value> {
    doc.get("keys").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A discovery or JWKS document under 8.1 (cached by the listener's `FetchCache`).
fn fetch_doc(cache: &FetchCache, url: &str, private_ok: bool) -> Result<Value, Refusal> {
    let u = check_url(url).map_err(|e| no("fetch", format!("The configured URL cannot be fetched ({e}).")))?;
    cache.fetch_json_blocking(&u, private_ok, FETCH_MAX, Limits::default()).map_err(|e| no("fetch", format!("{} could not be fetched ({e}).", u.url)))
}

/// Serials compared as numbers written in hex.
fn serial_eq(a: &str, b: &str) -> bool {
    let n = |s: &str| s.trim_start_matches('0').to_ascii_lowercase();
    n(a) == n(b)
}

/// An `mtls` credential naming this certificate's serial and SPKI hash (4.2).
fn mtls_matches(cr: &Value, cert: &ClientCert) -> bool {
    let s = |k: &str| cr.get(k).and_then(Value::as_str);
    kind_of(cr) == "mtls" && s("serial").is_some_and(|x| serial_eq(x, &cert.serial)) && s("spki").is_some_and(|x| x.eq_ignore_ascii_case(&cert.spki_sha256))
}

fn minutes_of(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// API1-R10 `hours`: `now` falls from `from` up to (not including) `to` in the zone `tz`, on one of `days` (1 Monday
/// to 7 Sunday). A window past midnight belongs to the day it starts; `from` equal to `to` is the whole day; an
/// unknown zone is outside.
pub(crate) fn inside_hours(h: &Value, now: i64) -> bool {
    use chrono::{Datelike, Timelike};
    let s = |k: &str| h.get(k).and_then(Value::as_str);
    let zone = s("tz").and_then(|z| z.parse::<chrono_tz::Tz>().ok());
    let (Some(zone), Some(from), Some(to)) = (zone, s("from").and_then(minutes_of), s("to").and_then(minutes_of)) else { return false };
    let Some(utc) = chrono::DateTime::<chrono::Utc>::from_timestamp(now, 0) else { return false };
    let local = utc.with_timezone(&zone);
    let minute = local.hour() * 60 + local.minute();
    let day = local.weekday().number_from_monday();
    let start_day = if from == to || (from < to && (from..to).contains(&minute)) || (from > to && minute >= from) {
        day
    } else if from > to && minute < to {
        if day == 1 {
            7
        } else {
            day - 1
        }
    } else {
        return false;
    };
    h.get("days").and_then(Value::as_array).is_some_and(|d| d.iter().any(|x| x.as_u64() == Some(u64::from(start_day))))
}

/// The relay id of a resource: `console` for the map's issuer I, else the relay whose `relay_origins` entry makes it.
fn relay_of(store: &ApiMapStore, org: &str, resource: &str) -> Option<String> {
    let map = store.get(org, "")?.map();
    if map.get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str) == Some(resource) {
        return Some("console".into());
    }
    store.relay_origins(org)?.iter().find(|(_, o)| o.as_str().is_some_and(|o| format!("{}/api/orgs/{org}", o.trim_end_matches('/')) == resource)).map(|(id, _)| id.clone())
}

/// The client's `relays` (less journaled drops) include `relay`.
fn relay_allowed(client: &Obj, active: &[TightenEntry], id: &str, relay: &str) -> bool {
    !tok::client_entries(active, "client_drop_relay", id).any(|e| tok::target_field(e, "relay") == relay) && tok::names(client, "relays").any(|r| r == "*" || r == relay)
}

// ---- client authentication (5.2) ----------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Mtls,
    Assertion,
    Secret,
    Subject,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Method::Mtls => "tls_client_auth",
            Method::Assertion => "private_key_jwt",
            Method::Secret => "client_secret_basic",
            Method::Subject => "token_exchange",
        }
    }
}

/// An authenticated client.
struct Authed<'a> {
    client: &'a Obj,
    id: String,
    method: Method,
    /// The end of the `private_key_jwt` key or `client_secret` used (5.3).
    key_end: Option<i64>,
    subject: Option<SubjectClaims>,
    /// `x5t#S256` and `notAfter` of a client certificate that matched an `mtls` credential.
    cert: Option<(String, i64)>,
}

/// 5.2: the client the request names (`client_id`, the Basic user, the assertion's `sub`; all the same), known in the
/// org's map (`client`), and exactly one client authentication over its usable credentials (`client-auth`): the
/// verified certificate matching an `mtls` credential, a `private_key_jwt` assertion, or a `client_secret` by HTTP
/// Basic; a token exchange authenticates with its subject token alone (a matching certificate then only binds).
fn authenticate<'a>(ctx: &IssueCtx<'a>, http: &TokenHttp, form: &HashMap<String, String>, exchange: bool, who: &mut Option<String>) -> Result<Authed<'a>, Refusal> {
    let s = |k: &str| form.get(k).map(String::as_str);
    let basic = match http.authorization {
        None => None,
        Some(h) => Some(basic_of(h).ok_or_else(|| no("client-auth", "The Authorization header is not HTTP Basic client credentials."))?),
    };
    let assertion = s("client_assertion");
    match (assertion, s("client_assertion_type")) {
        (Some(_), Some(t)) if t != ASSERTION_TYPE => return Err(no("client-auth", "That client_assertion_type is not supported.")),
        (Some(_), None) | (None, Some(_)) => return Err(no("request", "client_assertion and client_assertion_type go together.")),
        _ => {}
    }
    if form.contains_key("client_secret") {
        return Err(no("client-auth", "Send the client secret with HTTP Basic, not in the body."));
    }
    let asserted = assertion.and_then(tok::parse_jws).and_then(|j| j.claims.get("sub").and_then(Value::as_str).map(str::to_string));
    let mut named = [s("client_id").map(str::to_string), basic.as_ref().map(|b| b.0.clone()), asserted].into_iter().flatten();
    let Some(id) = named.next() else { return Err(no("request", "The request names no client (client_id).")) };
    if named.any(|other| other != id) {
        return Err(no("client-auth", "The request names more than one client."));
    }
    *who = Some(id.clone());
    let client = tok::find_client(ctx.store, ctx.org, &id).ok_or_else(|| no("client", "That client is not registered for this organization."))?;
    let creds = tok::usable_credentials(client, ctx.store.active(ctx.org));
    let cert = http.client_cert.filter(|c| c.authenticates(client, ctx.org, &creds));
    if let Some(c) = cert {
        if ctx.now > effective_end(c.not_after, &[ctx.store.grace_hours(ctx.org, "app", ctx.now)]) {
            return Err(no("expired", "The client certificate has expired."));
        }
    }
    let bound = cert.map(|c| (c.sha256_b64u.clone(), c.not_after));
    if exchange {
        if assertion.is_some() || basic.is_some() {
            return Err(no("client-auth", "A token exchange authenticates with its subject token only."));
        }
        let claims = exchange_subject(ctx, form, &creds)?;
        return Ok(Authed { client, id, method: Method::Subject, key_end: None, subject: Some(claims), cert: bound });
    }
    let (method, key_end) = match (bound.is_some(), assertion, &basic) {
        (true, None, None) => (Method::Mtls, None),
        (false, Some(a), None) => (Method::Assertion, Some(assertion_auth(ctx, a, &id, &creds)?)),
        (false, None, Some((_, secret))) => (Method::Secret, Some(secret_auth(ctx, secret, &creds)?)),
        (false, None, None) => return Err(no("client-auth", "The request carries no client authentication.")),
        _ => return Err(no("client-auth", "The request carries more than one client authentication.")),
    };
    Ok(Authed { client, id, method, key_end, subject: None, cert: bound })
}

/// `private_key_jwt`: an inline key named by the assertion's `kid`, else the keys of every live `jwks_uri` credential,
/// fetched under 8.1 with the credential's `private_ok` (at most hourly through the listener's cache). A failed fetch
/// with no verifying key answers `fetch` (503) rather than blaming the client.
fn assertion_auth(ctx: &IssueCtx, assertion: &str, id: &str, creds: &[&Value]) -> Result<i64, Refusal> {
    let kid = tok::parse_jws(assertion).and_then(|j| j.header.get("kid").and_then(Value::as_str).map(str::to_string));
    let inline = kid.is_some() && creds.iter().any(|c| kind_of(c) == "private_key_jwt" && c.get("jwk").is_some() && c.get("kid").and_then(Value::as_str) == kid.as_deref());
    let mut docs: Vec<(String, Vec<Value>)> = Vec::new();
    let mut failed = None;
    if !inline {
        for c in creds.iter().filter(|c| kind_of(c) == "private_key_jwt") {
            let Some(uri) = c.get("jwks_uri").and_then(Value::as_str) else { continue };
            if c.get("expires").and_then(Value::as_i64).is_none_or(|e| ctx.now > e) {
                continue;
            }
            match fetch_doc(ctx.fetch, uri, private_ok(c)) {
                Ok(doc) => docs.push((uri.to_string(), keys_of(&doc))),
                Err(r) => failed = Some(r),
            }
        }
    }
    let fetched: Vec<(&str, &[Value])> = docs.iter().map(|(u, k)| (u.as_str(), k.as_slice())).collect();
    let verdict = tok::verify_client_assertion(assertion, id, ctx.token_endpoint, creds, &fetched, ctx.now, &mut ctx.state.assertions.lock());
    match (verdict, failed) {
        (Ok(end), _) => Ok(end),
        (Err(e), Some(f)) if e.code == "client-auth" => Err(f),
        (Err(e), _) => Err(e.into()),
    }
}

/// D11 `client_secret` by HTTP Basic: a usable secret credential whose hash matches, not past its `expires`.
fn secret_auth(ctx: &IssueCtx, secret: &str, creds: &[&Value]) -> Result<i64, Refusal> {
    let matched = creds.iter().find(|c| kind_of(c) == "client_secret" && c.get("sha256").and_then(Value::as_str).is_some_and(|h| tok::verify_client_secret(secret, h)));
    let Some(c) = matched else { return Err(no("client-auth", "That client secret is not valid for this client.")) };
    let end = c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
    if ctx.now > end {
        return Err(no("expired", "That client secret has expired."));
    }
    Ok(end)
}

/// RFC 8693 token exchange (API1-R12): a JWT subject token whose `iss` names a usable `federated` credential; that
/// issuer's discovery `<issuer>/.well-known/openid-configuration`, then its `jwks_uri`, both fetched under 8.1 with
/// the credential's `private_ok`; then `verify_subject_token`.
fn exchange_subject(ctx: &IssueCtx, form: &HashMap<String, String>, creds: &[&Value]) -> Result<SubjectClaims, Refusal> {
    let s = |k: &str| form.get(k).map(String::as_str);
    if s("subject_token_type") != Some(JWT_TOKEN_TYPE) {
        return Err(no("request", "subject_token_type must be urn:ietf:params:oauth:token-type:jwt."));
    }
    if s("requested_token_type").is_some_and(|t| t != ACCESS_TOKEN_TYPE) {
        return Err(no("request", "Only access tokens are issued."));
    }
    if form.contains_key("actor_token") {
        return Err(no("request", "Delegation (actor_token) is not supported."));
    }
    let Some(token) = s("subject_token") else { return Err(no("request", "The request carries no subject_token.")) };
    let iss = tok::parse_jws(token).and_then(|j| j.claims.get("iss").and_then(Value::as_str).map(str::to_string));
    let Some(iss) = iss else { return Err(no("subject", "The subject token is not a JWT with an issuer.")) };
    let mut last = no("subject", "No federated credential of this client names that issuer.");
    for c in creds.iter().filter(|c| kind_of(c) == "federated" && c.get("issuer").and_then(Value::as_str) == Some(iss.as_str())) {
        let discovery = match fetch_doc(ctx.fetch, &format!("{}/.well-known/openid-configuration", iss.trim_end_matches('/')), private_ok(c)) {
            Ok(d) => d,
            Err(r) => {
                last = r;
                continue;
            }
        };
        let Some(jwks_uri) = discovery.get("jwks_uri").and_then(Value::as_str) else {
            last = no("subject", "The issuer's discovery document names no jwks_uri.");
            continue;
        };
        let keys = match fetch_doc(ctx.fetch, jwks_uri, private_ok(c)) {
            Ok(d) => keys_of(&d),
            Err(r) => {
                last = r;
                continue;
            }
        };
        let named = discovery.get("issuer").and_then(Value::as_str).unwrap_or_default();
        match tok::verify_subject_token(token, c, &keys, named, ctx.now) {
            Ok(claims) => return Ok(claims),
            Err(e) => last = e.into(),
        }
    }
    Err(last)
}

/// 6.1: the client active (`suspended`), its registration within its effective end with the `app` grace (`expired`),
/// its owner an active person (`owner`).
fn standing(ctx: &IssueCtx, client: &Obj, id: &str) -> Result<(), Refusal> {
    let active = ctx.store.active(ctx.org);
    if client.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(id)) {
        return Err(no("suspended", "That client is suspended."));
    }
    let end = effective_end(client.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN), &[ctx.store.grace_hours(ctx.org, "app", ctx.now)]);
    if ctx.now > end {
        return Err(no("expired", "That client's registration has expired."));
    }
    if !(ctx.owner_active)(client.get("owner").and_then(Value::as_str).unwrap_or_default()) {
        return Err(no("owner", "That client's owner is not an active person of the organization."));
    }
    Ok(())
}

// ---- the token endpoint (5.2, 5.3, 6.1) ---------------------------------------------------------------------------

/// `POST <issuer>/oauth/token` (5.2) through the 6.1 Token pipeline, in order: the source limiter (`abuse`), the map
/// pinned and unexpired (`map-expired`), the org not off (`api-off`), the form (16 KiB; `grant_type`
/// `client_credentials` or token exchange), the client known (`client`), its authentication (`client-auth`), the
/// client active, registered and owned (`suspended`, `expired`, `owner`), source network, hours and mTLS (`network`,
/// `hours`, `mtls`), the issuance rate (`rate`); then the scopes (`invalid_scope`), the resource (`invalid_target`),
/// the sender constraint (mTLS `x5t#S256`; else a DPoP proof's `jkt`; a D11 secret client without DPoP gets an
/// unbound 300 s token, inside its networks only; otherwise `dpop-required`), the 5.3 lifetime, and the token.
pub fn token(ctx: &IssueCtx, http: &TokenHttp) -> Answer {
    let mut who = None;
    issue(ctx, http, &mut who).unwrap_or_else(|r| refused(ctx, http, who.as_deref(), r))
}

fn refused(ctx: &IssueCtx, http: &TokenHttp, client: Option<&str>, r: Refusal) -> Answer {
    let mut a = refusal(ctx.org, http.source, client, r.code, &r.why, r.retry);
    if a.status == 401 && http.authorization.is_some() {
        a.headers.push(("WWW-Authenticate", format!("Basic realm=\"{}\"", ctx.issuer)));
    }
    a
}

/// The checks every endpoint of the pipeline starts with: the source limiter, the license, the map, the form.
fn opening(ctx: &IssueCtx, http: &TokenHttp) -> Result<HashMap<String, String>, Refusal> {
    ctx.state.source_ok(http.source, ctx.now).map_err(|s| Refusal { retry: Some(s), ..no("abuse", "Too many requests from this address.") })?;
    if !ctx.licensed {
        return Err(no("license", LICENSE_WHY));
    }
    if let Some(code) = closed(ctx.store, ctx.org, ctx.now) {
        return Err(no(code, closed_why(code)));
    }
    form_of(http.form)
}

fn issue(ctx: &IssueCtx, http: &TokenHttp, who: &mut Option<String>) -> Result<Answer, Refusal> {
    let now = ctx.now;
    let form = opening(ctx, http)?;
    let exchange = match form.get("grant_type").map(String::as_str) {
        Some(GRANT_CLIENT_CREDENTIALS) => false,
        Some(GRANT_TOKEN_EXCHANGE) => true,
        Some(_) => return Err(no("grant", "That grant_type is not supported.")),
        None => return Err(no("request", "The request carries no grant_type.")),
    };
    let auth = authenticate(ctx, http, &form, exchange, who)?;
    let (client, id) = (auth.client, auth.id.as_str());
    let active = ctx.store.active(ctx.org);
    standing(ctx, client, id)?;
    let networks: Vec<&str> = tok::names(client, "networks").collect();
    if !networks.is_empty() && !networks.iter().filter_map(|n| crate::console_source::parse_cidr(n).ok()).any(|c| c.contains(http.source)) {
        return Err(no("network", "This client may not ask from that address."));
    }
    if client.get("hours").is_some_and(|h| !inside_hours(h, now)) {
        return Err(no("hours", "This client may not ask at this time."));
    }
    if client.get("mtls_required").and_then(Value::as_bool) == Some(true) && auth.method != Method::Mtls {
        return Err(no("mtls", "This client must authenticate with its certificate."));
    }
    let rate = |k: &str| client.get("rate").and_then(|r| r.get(k)).and_then(Value::as_u64).unwrap_or(0);
    ctx.state.issue_ok(ctx.org, id, usize::try_from(rate("per_minute_each")).unwrap_or(usize::MAX), rate("per_day_each"), now)?;
    // scopes: the client's less journaled drops, within the local issuer's
    let dropped: Vec<&str> = tok::client_entries(active, "client_drop_scope", id).map(|e| tok::target_field(e, "scope")).collect();
    let grantable: Vec<&str> = tok::names(client, "scopes").filter(|s| !dropped.contains(s) && ctx.local_scopes.is_none_or(|l| l.iter().any(|x| x == s))).collect();
    let mut scopes: Vec<String> = match form.get("scope") {
        None => grantable.iter().map(|s| s.to_string()).collect(),
        Some(asked) => {
            let asked: Vec<&str> = asked.split(' ').filter(|s| !s.is_empty()).collect();
            if asked.is_empty() || asked.iter().any(|a| !grantable.contains(a)) {
                return Err(no("scope", "That scope is not granted to this client here."));
            }
            asked.iter().map(|s| s.to_string()).collect()
        }
    };
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        return Err(no("scope", "This client holds no scope this issuer grants."));
    }
    // the resource (RFC 8707): one this issuer mints for, and a relay (or the console) in the client's relays
    let resource = match form.get("resource") {
        Some(r) => r.as_str(),
        None => ctx.resources.first().map_or(ctx.issuer, String::as_str),
    };
    if !ctx.resources.iter().any(|r| r == resource) {
        return Err(no("target", "That resource is not served by this issuer."));
    }
    let Some(relay) = relay_of(ctx.store, ctx.org, resource) else { return Err(no("target", "That resource is not part of this organization.")) };
    if !relay_allowed(client, active, id, &relay) {
        return Err(no("target", "This client may not reach that resource."));
    }
    // the sender constraint
    let cnf = if let Some((x5t, _)) = &auth.cert {
        Cnf::X5t(x5t.clone())
    } else if let Some(proof) = http.dpop {
        Cnf::Jkt(tok::verify_dpop(proof, "POST", ctx.token_endpoint, None, now, &mut ctx.state.dpop.lock(), id)?)
    } else if auth.method == Method::Secret && !networks.is_empty() {
        Cnf::None
    } else {
        return Err(no("dpop-required", "This token request needs a DPoP proof."));
    };
    // 5.3
    let Some(pinned) = ctx.store.get(ctx.org, "") else { return Err(no("map-expired", closed_why("map-expired"))) };
    let lifetime = Lifetime {
        iat: now,
        unbound: cnf == Cnf::None,
        registration_end: client.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN),
        grace_hours: ctx.store.grace_hours(ctx.org, "app", now).unwrap_or(0),
        cert_end: auth.cert.as_ref().map(|c| c.1),
        key_end: auth.key_end,
        subject_exp: auth.subject.as_ref().map(|s| s.exp),
        map_expires: pinned.expires,
    };
    let exp = tok::token_exp(&lifetime);
    if exp <= now {
        return Err(no("expired", "A credential of this client ends now."));
    }
    let current = client.get("ceiling").and_then(Value::as_str).and_then(tok::rank).unwrap_or(0);
    let lowered = tok::client_entries(active, "client_lower_ceiling", id).filter_map(|e| tok::rank(tok::target_field(e, "ceiling")));
    let ceiling = CEILINGS[lowered.fold(current, usize::min)];
    let reach = client.get("reach").and_then(Value::as_str).unwrap_or_default();
    let minted = tok::mint_access_token(ctx.key, ctx.kid, ctx.issuer, resource, id, ctx.org, &scopes, reach, ceiling, pinned.seq, &cnf, now, exp)?;
    let (token_type, cnf_kind) = match &cnf {
        Cnf::X5t(_) => ("Bearer", "x5t#S256"),
        Cnf::Jkt(_) => ("DPoP", "jkt"),
        Cnf::None => ("Bearer", "none"),
    };
    let scope = scopes.join(" ");
    let mut body = json!({"access_token": minted.token, "token_type": token_type, "expires_in": exp - now, "scope": scope});
    if exchange {
        body["issued_token_type"] = json!(ACCESS_TOKEN_TYPE);
    }
    let mut event = json!({"org": ctx.org, "client": id, "scope": scope, "aud": resource, "jti": minted.jti, "exp": minted.exp, "cnf": cnf_kind,
                           "auth": auth.method.name(), "source": http.source.to_string(), "map_seq": pinned.seq});
    if let Some(s) = &auth.subject {
        event["subject_iss"] = json!(s.iss);
        event["subject_sub"] = json!(s.sub);
    }
    Ok(Answer { status: 200, body, headers: no_store(), event: Some(("api.token", event)) })
}

// ---- revocation (5.5) ---------------------------------------------------------------------------------------------

/// `POST <issuer>/oauth/revoke` (RFC 7009): the source limiter, the map and the org, the client authenticated as for
/// `client_credentials`, then a token this issuer signed for that client (its signature checked with the issuer's
/// key, or at the console any key of the map's `issuer.jwks`) is journaled through `journal(client, jti, until =
/// exp)` once (not when expired or already denied). Every other token answers 200 too (RFC 7009 2.2). The journal
/// call audits the revocation first (9.4); its Err is (`audit-unavailable` or `journal`, why), both 503. A revocation
/// that journals nothing carries an `api.revoke` event without `jti` for the caller to audit.
pub fn revoke(ctx: &IssueCtx, http: &TokenHttp, journal: &dyn Fn(&str, &str, i64) -> Result<(), (&'static str, String)>) -> Answer {
    let mut who = None;
    revoke_inner(ctx, http, journal, &mut who).unwrap_or_else(|r| refused(ctx, http, who.as_deref(), r))
}

fn revoke_inner(ctx: &IssueCtx, http: &TokenHttp, journal: &dyn Fn(&str, &str, i64) -> Result<(), (&'static str, String)>, who: &mut Option<String>) -> Result<Answer, Refusal> {
    let form = opening(ctx, http)?;
    let Some(token) = form.get("token") else { return Err(no("request", "The request carries no token.")) };
    let auth = authenticate(ctx, http, &form, false, who)?;
    let noop = json!({"org": ctx.org, "client": auth.id, "source": http.source.to_string()});
    let done = Answer { status: 200, body: json!({}), headers: no_store(), event: Some(("api.revoke", noop)) };
    let Some((jti, exp)) = own_token(ctx, token, &auth.id) else { return Ok(done) };
    let denied = ctx.store.active(ctx.org).iter().any(|e| e.action == "token_deny" && e.target.get("jti").and_then(Value::as_str) == Some(jti.as_str()));
    if exp <= ctx.now || denied {
        return Ok(done);
    }
    journal(&auth.id, &jti, exp).map_err(|(code, e)| match code {
        "audit-unavailable" => no("audit-unavailable", format!("The revocation could not be audited ({e}).")),
        _ => no("journal", format!("The revocation could not be recorded ({e}).")),
    })?;
    let event = json!({"org": ctx.org, "client": auth.id, "jti": jti, "until": exp, "source": http.source.to_string()});
    Ok(Answer { event: Some(("api.revoke", event)), ..done })
}

/// `(jti, exp)` of an access token this issuer signed for `client`: ES256 by `ctx.key` under `ctx.kid`, or (when this
/// issuer is the map's `issuer.url`) by another key of its `issuer.jwks`; `iss` this issuer, `client_id` the client.
fn own_token(ctx: &IssueCtx, token: &str, client: &str) -> Option<(String, i64)> {
    let jws = tok::parse_jws(token)?;
    let h = |k: &str| jws.header.get(k).and_then(Value::as_str);
    if h("alg") != Some("ES256") {
        return None;
    }
    let kid = h("kid")?;
    let key = if kid == ctx.kid {
        let p = ctx.key.public_key().as_ref();
        tok::PublicKey::Ec { x: p.get(1..33)?.try_into().ok()?, y: p.get(33..65)?.try_into().ok()? }
    } else {
        let issuer = ctx.store.get(ctx.org, "")?.map().get("issuer")?;
        if issuer.get("url").and_then(Value::as_str) != Some(ctx.issuer) {
            return None;
        }
        let jwk = issuer.get("jwks")?.as_array()?.iter().find(|k| k.get("kid").and_then(Value::as_str) == Some(kid))?;
        tok::parse_jwk(jwk, tok::CLIENT_RSA_MIN_BITS)?
    };
    if !tok::verify_signature(&key, tok::Alg::Es256, jws.signing_input.as_bytes(), &jws.signature) {
        return None;
    }
    let c = |k: &str| jws.claims.get(k);
    if c("iss").and_then(Value::as_str) != Some(ctx.issuer) || c("client_id").and_then(Value::as_str) != Some(client) {
        return None;
    }
    Some((c("jti")?.as_str()?.to_string(), c("exp")?.as_i64()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_map::{api_map_hash, VerifiedApiMap};
    use aws_lc_rs::signature::ECDSA_P256_SHA256_FIXED_SIGNING;
    use std::cell::{Cell, RefCell};
    use std::time::Duration;

    /// 2026-11-18 11:06:40 UTC.
    const NOW: i64 = 1_795_000_000;
    const DAY: i64 = 86_400;
    const ORG: &str = "acme";
    const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
    const ENDPOINT: &str = "https://console.acme.example:7443/api/orgs/acme/oauth/token";
    const RR1: &str = "https://relay1.acme.example:9443/api/orgs/acme";
    const RR2: &str = "https://relay2.acme.example:9443/api/orgs/acme";
    const KID: &str = "k-2026-11";
    const CLIENT: &str = "c_5f1a2b3c4d5e6f70";
    const OWNER: &str = "ann@acme.example";
    const SECRET: &str = "lcs_0123456789abcdef";

    fn key(kid: &str) -> (EcdsaKeyPair, Value) {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
        let jwk = ec_public_jwk(&pair, kid);
        (pair, jwk)
    }

    struct Fx {
        issuer: EcdsaKeyPair,
        issuer_jwk: Value,
        client: EcdsaKeyPair,
        client_jwk: Value,
        dpop: EcdsaKeyPair,
        dpop_jwk: Value,
        state: IssueState,
        fetch: FetchCache,
        resources: Vec<String>,
    }

    fn fx() -> Fx {
        let (issuer, issuer_jwk) = key(KID);
        let (client, client_jwk) = key("k1");
        let (dpop, dpop_jwk) = key("d1");
        Fx { issuer, issuer_jwk, client, client_jwk, dpop, dpop_jwk, state: IssueState::new(), fetch: FetchCache::new(Duration::from_secs(3600)), resources: vec![ISSUER.into(), RR1.into(), RR2.into()] }
    }

    fn client_with(credentials: Value) -> Value {
        json!({"id": CLIENT, "name": "splunk-scrape", "principal": "splunk-scrape@apps.acme.example", "kind": "monitoring",
               "owner": OWNER, "reach": "R0", "scopes": ["monitor.read", "audit.read"], "ceiling": "internal",
               "relays": ["*"], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 120, "per_day_each": 100000},
               "credentials": credentials, "created": NOW - DAY, "expires": NOW + 10 * DAY, "state": "active"})
    }

    fn jwt_credential(fx: &Fx) -> Value {
        json!([{"type": "private_key_jwt", "kid": "k1", "jwk": fx.client_jwk, "expires": NOW + 90 * DAY}])
    }

    fn map_with(fx: &Fx, client: Value) -> Value {
        let mut ik = fx.issuer_jwk.clone();
        ik["nbf"] = json!(NOW - DAY);
        ik["exp"] = json!(NOW + 90 * DAY);
        json!({"v": 1, "org": ORG, "seq": 7, "issued": NOW - DAY, "expires": NOW + 30 * DAY,
               "issuer": {"url": ISSUER, "jwks": [ik]},
               "grace": {"person": 0, "app": 24, "connector": 0, "relay": 0},
               "failover_after_s": 300, "folded": [], "cleared": [],
               "relay_origins": {"r_01": "https://relay1.acme.example:9443", "r_02": "https://relay2.acme.example:9443"},
               "clients": [client]})
    }

    /// An in-memory store holding `map` and the journal entries (renumbered from tseq 1).
    fn store_of(map: &Value, journal: &[Value]) -> ApiMapStore {
        let wire = json!({"map": map, "sig": "", "chain": []});
        let vm = VerifiedApiMap {
            wire: wire.as_object().unwrap().clone(),
            org: ORG.into(),
            seq: map["seq"].as_i64().unwrap(),
            expires: map["expires"].as_i64().unwrap(),
            hash: api_map_hash(map),
            signer: "root".into(),
        };
        let mut s = ApiMapStore::load(None);
        s.pin(vm).unwrap();
        for (i, e) in journal.iter().enumerate() {
            let tseq = i as u64 + 1;
            let mut e = e.clone();
            e["tseq"] = json!(tseq);
            e["id"] = json!(format!("t_{ORG}_{tseq:06}"));
            s.apply_tighten(ORG, &e).unwrap();
        }
        s
    }

    fn entry(action: &str, target: Value) -> Value {
        json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW - 10, "action": action, "target": target})
    }

    fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
        let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
        pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&").into_bytes()
    }

    fn assertion(fx: &Fx, jti: &str) -> String {
        tok::sign_es256(&fx.client, &json!({"alg": "ES256", "kid": "k1"}), &json!({"iss": CLIENT, "sub": CLIENT, "aud": ENDPOINT, "iat": NOW, "exp": NOW + 300, "jti": jti})).unwrap()
    }

    fn proof(fx: &Fx, jti: &str) -> String {
        tok::sign_es256(&fx.dpop, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": fx.dpop_jwk}), &json!({"jti": jti, "htm": "POST", "htu": ENDPOINT, "iat": NOW})).unwrap()
    }

    fn jwt_form(fx: &Fx, jti: &str, extra: &[(&str, &str)]) -> Vec<u8> {
        let a = assertion(fx, jti);
        let mut p = vec![("grant_type", "client_credentials"), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", a.as_str())];
        p.extend_from_slice(extra);
        form(&p)
    }

    fn basic(id: &str, secret: &str) -> String {
        format!("Basic {}", crate::meet_json::b64(format!("{id}:{secret}").as_bytes()))
    }

    fn source() -> IpAddr {
        "10.40.0.9".parse().unwrap()
    }

    fn http<'a>(body: &'a [u8], dpop: Option<&'a str>) -> TokenHttp<'a> {
        TokenHttp { form: body, authorization: None, dpop, client_cert: None, source: source() }
    }

    fn owners(p: &str) -> bool {
        p == OWNER
    }

    fn ctx_of<'a>(fx: &'a Fx, store: &'a ApiMapStore, owner_active: &'a dyn Fn(&str) -> bool, local: Option<&'a [&'static str]>) -> IssueCtx<'a> {
        IssueCtx {
            org: ORG,
            issuer: ISSUER,
            token_endpoint: ENDPOINT,
            resources: &fx.resources,
            local_scopes: local,
            key: &fx.issuer,
            kid: KID,
            store,
            owner_active,
            fetch: &fx.fetch,
            state: &fx.state,
            licensed: true,
            now: NOW,
        }
    }

    fn issue_as(fx: &Fx, store: &ApiMapStore, h: &TokenHttp, owner_active: &dyn Fn(&str) -> bool, local: Option<&[&'static str]>) -> Answer {
        token(&ctx_of(fx, store, owner_active, local), h)
    }

    fn ask(fx: &Fx, store: &ApiMapStore, h: &TokenHttp) -> Answer {
        issue_as(fx, store, h, &owners, None)
    }

    fn code(a: &Answer) -> String {
        if a.status == 200 {
            "ok".into()
        } else {
            a.body["code"].as_str().unwrap_or_default().into()
        }
    }

    fn claims(a: &Answer) -> Value {
        Value::Object(tok::parse_jws(a.body["access_token"].as_str().unwrap()).unwrap().claims)
    }

    fn cert() -> ClientCert {
        ClientCert {
            sha256_b64u: "q".repeat(43),
            serial: "1a2b".into(),
            spki_sha256: "ab".repeat(32),
            not_after: NOW + DAY,
            chain_ok: true,
            kind: "app".into(),
            principal: "splunk-scrape@apps.acme.example".into(),
            orgs: vec![ORG.into()],
        }
    }

    #[test]
    fn client_credentials_with_private_key_jwt_and_dpop() {
        let fx = fx();
        let s = store_of(&map_with(&fx, client_with(jwt_credential(&fx))), &[]);
        let body = jwt_form(&fx, "a1", &[]);
        let p = proof(&fx, "p1");
        let a = ask(&fx, &s, &http(&body, Some(&p)));
        assert_eq!(code(&a), "ok", "{}", a.body);
        assert_eq!((a.body["token_type"].as_str(), a.body["expires_in"].as_i64(), a.body["scope"].as_str()), (Some("DPoP"), Some(600), Some("audit.read monitor.read")));
        assert!(a.headers.iter().any(|(k, v)| *k == "Cache-Control" && v == "no-store"));
        let c = claims(&a);
        let jkt = tok::jwk_thumbprint(&tok::parse_jwk(&fx.dpop_jwk, tok::CLIENT_RSA_MIN_BITS).unwrap());
        assert_eq!(
            (c["aud"].as_str(), c["iss"].as_str(), c["cnf"]["jkt"].as_str(), c["ceiling"].as_str(), c["map_seq"].as_i64()),
            (Some(ISSUER), Some(ISSUER), Some(jkt.as_str()), Some("internal"), Some(7))
        );
        let (name, event) = a.event.clone().unwrap();
        assert_eq!((name, event["auth"].as_str(), event["cnf"].as_str()), ("api.token", Some("private_key_jwt"), Some("jkt")));
        // a relay resource and a narrower scope
        let body = jwt_form(&fx, "a2", &[("scope", "monitor.read"), ("resource", RR1)]);
        let p = proof(&fx, "p2");
        let a = ask(&fx, &s, &http(&body, Some(&p)));
        assert_eq!((claims(&a)["aud"].as_str(), a.body["scope"].as_str()), (Some(RR1), Some("monitor.read")));
        // a replayed assertion, then a replayed proof
        let p3 = proof(&fx, "p3");
        assert_eq!(code(&ask(&fx, &s, &http(&body, Some(&p3)))), "client-auth");
        let body = jwt_form(&fx, "a3", &[]);
        assert_eq!(code(&ask(&fx, &s, &http(&body, Some(&p)))), "dpop-replay");
        // a jwks_uri credential: its JWKS fetched (here put in the cache)
        let uri = "https://keys.acme.example/jwks";
        let s2 = store_of(&map_with(&fx, client_with(json!([{"type": "private_key_jwt", "jwks_uri": uri, "private_ok": false, "expires": NOW + 300}]))), &[]);
        fx.fetch.put(&check_url(uri).unwrap(), false, json!({"keys": [fx.client_jwk]}));
        let body = jwt_form(&fx, "a4", &[]);
        let p = proof(&fx, "p4");
        let a = ask(&fx, &s2, &http(&body, Some(&p)));
        assert_eq!(code(&a), "ok", "{}", a.body);
        assert_eq!(a.body["expires_in"].as_i64(), Some(300), "the key's end bounds the token");
    }

    #[test]
    fn client_credentials_with_mtls_bind_the_certificate() {
        let fx = fx();
        let mut c = client_with(json!([{"type": "mtls", "serial": "001A2B", "spki": "AB".repeat(32)}]));
        c["mtls_required"] = json!(true);
        let s = store_of(&map_with(&fx, c), &[]);
        let body = form(&[("grant_type", "client_credentials"), ("client_id", CLIENT)]);
        let (good, unverified, other, old, graced) = (
            cert(),
            ClientCert { chain_ok: false, ..cert() },
            ClientCert { spki_sha256: "cd".repeat(32), ..cert() },
            ClientCert { not_after: NOW - 25 * 3600, ..cert() },
            ClientCert { not_after: NOW - 23 * 3600, ..cert() },
        );
        let with = |c: &ClientCert| {
            let mut h = http(&body, None);
            h.client_cert = Some(c);
            ask(&fx, &s, &h)
        };
        let a = with(&good);
        assert_eq!(code(&a), "ok", "{}", a.body);
        assert_eq!(a.body["token_type"], "Bearer");
        assert_eq!(claims(&a)["cnf"]["x5t#S256"].as_str(), Some("q".repeat(43).as_str()));
        assert_eq!(code(&with(&unverified)), "client-auth");
        assert_eq!(code(&with(&other)), "client-auth");
        assert_eq!(code(&with(&old)), "expired", "past notAfter and the 24 hour app grace");
        assert_eq!(with(&graced).body["expires_in"].as_i64(), Some(600), "inside the grace");
        // the serial and SPKI match, but the certificate is not this client's app certificate for this org
        let person = ClientCert { kind: "person".into(), principal: "ann@acme.example".into(), orgs: Vec::new(), ..cert() };
        let person_named = ClientCert { kind: "person".into(), ..cert() };
        let another_app = ClientCert { principal: "other-app@apps.acme.example".into(), ..cert() };
        let another_org = ClientCert { orgs: vec!["zeta".into()], ..cert() };
        let archive = ClientCert { kind: "archive".into(), ..cert() };
        for (c, why) in [(&person, "a person"), (&person_named, "a person with the app's email"), (&another_app, "another principal"), (&another_org, "another org"), (&archive, "an archive")] {
            assert_eq!(code(&with(c)), "client-auth", "{why}");
        }
        assert_eq!(code(&with(&ClientCert { principal: "SPLUNK-SCRAPE@apps.acme.example".into(), ..cert() })), "ok", "emails compare without case");
        // mtls_required refuses any other method
        let mut c = client_with(jwt_credential(&fx));
        c["mtls_required"] = json!(true);
        let s = store_of(&map_with(&fx, c), &[]);
        let body = jwt_form(&fx, "m1", &[]);
        let p = proof(&fx, "mp1");
        assert_eq!(code(&ask(&fx, &s, &http(&body, Some(&p)))), "mtls");
    }

    #[test]
    fn d11_client_secret_without_dpop_is_unbound_for_300_seconds_inside_its_networks() {
        let fx = fx();
        let mut c = client_with(json!([{"type": "client_secret", "sha256": hex(&sha256(SECRET.as_bytes())), "hint": "lcs_0123", "expires": NOW + 30 * DAY}]));
        c["networks"] = json!(["10.40.0.0/23"]);
        let s = store_of(&map_with(&fx, c), &[]);
        let body = form(&[("grant_type", "client_credentials")]);
        let (right, wrong) = (basic(CLIENT, SECRET), basic(CLIENT, "lcs_wrong"));
        let p = proof(&fx, "s1");
        let with = |auth: &str, from: &str, dpop: Option<&str>| {
            let mut h = http(&body, dpop);
            h.authorization = Some(auth);
            h.source = from.parse().unwrap();
            ask(&fx, &s, &h)
        };
        let a = with(&right, "10.40.1.5", None);
        assert_eq!(code(&a), "ok", "{}", a.body);
        assert_eq!((a.body["token_type"].as_str(), a.body["expires_in"].as_i64()), (Some("Bearer"), Some(300)));
        assert!(claims(&a).get("cnf").is_none());
        assert_eq!(a.event.as_ref().unwrap().1["cnf"], "none");
        assert_eq!(code(&with(&right, "192.0.2.7", None)), "network");
        let a = with(&wrong, "10.40.1.5", None);
        assert_eq!((a.status, code(&a).as_str()), (401, "client-auth"));
        assert!(a.headers.iter().any(|(k, _)| *k == "WWW-Authenticate"));
        // with a DPoP proof the token is bound and lives 600 s
        let a = with(&right, "10.40.1.5", Some(&p));
        assert_eq!((a.body["token_type"].as_str(), a.body["expires_in"].as_i64()), (Some("DPoP"), Some(600)));
    }

    #[test]
    fn token_exchange_reads_the_issuer_discovery_and_jwks() {
        let fx = fx();
        let iss = "https://login.example/tenant/v2.0";
        let (fed, fed_jwk) = key("f1");
        let c = client_with(json!([{"type": "federated", "issuer": iss, "audience": "api://lucid", "subject": "sp-123", "algs": ["ES256"], "private_ok": false, "expires": NOW + DAY}]));
        let s = store_of(&map_with(&fx, c), &[]);
        fx.fetch.put(&check_url(&format!("{iss}/.well-known/openid-configuration")).unwrap(), false, json!({"issuer": iss, "jwks_uri": "https://login.example/tenant/keys"}));
        fx.fetch.put(&check_url("https://login.example/tenant/keys").unwrap(), false, json!({"keys": [fed_jwk]}));
        let subject = |sub: &str| tok::sign_es256(&fed, &json!({"alg": "ES256", "kid": "f1"}), &json!({"iss": iss, "aud": "api://lucid", "sub": sub, "iat": NOW, "exp": NOW + 120})).unwrap();
        let exchange = |t: &str| form(&[("grant_type", GRANT_TOKEN_EXCHANGE), ("client_id", CLIENT), ("subject_token", t), ("subject_token_type", JWT_TOKEN_TYPE)]);
        let body = exchange(&subject("sp-123"));
        let p = proof(&fx, "x1");
        let a = ask(&fx, &s, &http(&body, Some(&p)));
        assert_eq!(code(&a), "ok", "{}", a.body);
        assert_eq!(
            (a.body["expires_in"].as_i64(), a.body["issued_token_type"].as_str(), a.body["token_type"].as_str()),
            (Some(120), Some(ACCESS_TOKEN_TYPE), Some("DPoP")),
            "the subject token's exp bounds the token"
        );
        assert_eq!(a.event.as_ref().unwrap().1["subject_sub"], "sp-123");
        let body = exchange(&subject("sp-999"));
        let p = proof(&fx, "x2");
        assert_eq!(code(&ask(&fx, &s, &http(&body, Some(&p)))), "subject");
        let body = exchange(&subject("sp-123"));
        assert_eq!(code(&ask(&fx, &s, &http(&body, None))), "dpop-required");
    }

    #[test]
    fn each_refusal_of_the_token_row_has_its_code() {
        let fx = fx();
        let base = map_with(&fx, client_with(jwt_credential(&fx)));
        let ok = store_of(&base, &[]);
        let n = Cell::new(0);
        let try_with = |s: &ApiMapStore, owner_active: &dyn Fn(&str) -> bool| {
            n.set(n.get() + 1);
            let body = jwt_form(&fx, &format!("r{}", n.get()), &[]);
            let p = proof(&fx, &format!("rp{}", n.get()));
            issue_as(&fx, s, &http(&body, Some(&p)), owner_active, None)
        };
        let try_on = |s: &ApiMapStore| try_with(s, &owners);
        let changed = |f: &dyn Fn(&mut Value)| {
            let mut m = base.clone();
            f(&mut m);
            store_of(&m, &[])
        };
        assert_eq!(code(&try_on(&ok)), "ok");
        let a = try_on(&changed(&|m| m["expires"] = json!(NOW - 1)));
        assert_eq!((a.status, code(&a).as_str()), (401, "map-expired"));
        let a = try_on(&store_of(&base, &[entry("api_off", json!(ORG))]));
        assert_eq!((a.status, code(&a).as_str()), (403, "api-off"));
        let mut aside = store_of(&base, &[]);
        assert_eq!(aside.revalidate(None), [ORG], "an unknown edition sets the map aside");
        let a = try_on(&aside);
        assert_eq!((a.status, code(&a).as_str()), (403, "map-edition"));
        // the form
        assert_eq!(code(&ask(&fx, &ok, &http(b"grant_type=%zz", None))), "request");
        assert_eq!(code(&ask(&fx, &ok, &http(b"grant_type=client_credentials&client_id=a&client_id=b", None))), "request");
        assert_eq!(code(&ask(&fx, &ok, &http(b"client_id=x", None))), "request", "no grant_type");
        let a = ask(&fx, &ok, &http(b"grant_type=password&client_id=x", None));
        assert_eq!((a.body["error"].as_str(), code(&a).as_str()), (Some("unsupported_grant_type"), "grant"));
        assert_eq!(a.event.as_ref().map(|e| e.0), Some("api.refusal"));
        let big = vec![b'a'; FORM_MAX + 1];
        assert_eq!(code(&ask(&fx, &ok, &http(&big, None))), "too-large");
        // the client, then its authentication
        let a = ask(&fx, &ok, &http(&form(&[("grant_type", "client_credentials"), ("client_id", "c_0000000000000000")]), None));
        assert_eq!((a.status, code(&a).as_str()), (401, "client"));
        assert_eq!(code(&ask(&fx, &ok, &http(&form(&[("grant_type", "client_credentials"), ("client_id", CLIENT)]), None))), "client-auth", "none");
        let (other, _) = key("k1");
        let forged = tok::sign_es256(&other, &json!({"alg": "ES256", "kid": "k1"}), &json!({"iss": CLIENT, "sub": CLIENT, "aud": ENDPOINT, "iat": NOW, "exp": NOW + 300, "jti": "f1"})).unwrap();
        let body = form(&[("grant_type", "client_credentials"), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", forged.as_str())]);
        assert_eq!(code(&ask(&fx, &ok, &http(&body, None))), "client-auth", "another key");
        let body = jwt_form(&fx, "two", &[]);
        let both = basic(CLIENT, SECRET);
        let mut h = http(&body, None);
        h.authorization = Some(&both);
        assert_eq!(code(&ask(&fx, &ok, &h)), "client-auth", "two methods");
        // the client's standing
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["state"] = json!("suspended")))), "suspended");
        assert_eq!(code(&try_on(&store_of(&base, &[entry("client_suspend", json!(CLIENT))]))), "suspended");
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["expires"] = json!(NOW - 25 * 3600)))), "expired");
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["expires"] = json!(NOW - 23 * 3600)))), "ok", "inside the app grace");
        assert_eq!(code(&try_with(&ok, &|_: &str| false)), "owner");
        // network, hours, mTLS
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["networks"] = json!(["192.0.2.0/24"])))), "network");
        let hours = |tz: &str, from: &str, to: &str| json!({"tz": tz, "from": from, "to": to, "days": [1, 2, 3, 4, 5, 6, 7]});
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["hours"] = hours("UTC", "00:00", "01:00")))), "hours");
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["hours"] = hours("Europe/Paris", "09:00", "17:00")))), "ok");
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["hours"] = hours("UTC", "22:00", "12:00")))), "ok", "past midnight");
        assert_eq!(code(&try_on(&changed(&|m| m["clients"][0]["mtls_required"] = json!(true)))), "mtls");
        // scope and the DPoP requirement
        let body = jwt_form(&fx, "sc", &[("scope", "fleet.read")]);
        let p = proof(&fx, "scp");
        let a = ask(&fx, &ok, &http(&body, Some(&p)));
        assert_eq!((a.body["error"].as_str(), code(&a).as_str()), (Some("invalid_scope"), "scope"));
        let body = jwt_form(&fx, "nd", &[]);
        assert_eq!(code(&ask(&fx, &ok, &http(&body, None))), "dpop-required");
    }

    #[test]
    fn the_issuance_rate_and_the_source_limiter_answer_429() {
        let fx = fx();
        let mut m = map_with(&fx, client_with(jwt_credential(&fx)));
        m["clients"][0]["rate"]["per_minute_each"] = json!(1);
        let s = store_of(&m, &[]);
        let run = |jti: &str| {
            let body = jwt_form(&fx, jti, &[]);
            let p = proof(&fx, &format!("p{jti}"));
            ask(&fx, &s, &http(&body, Some(&p)))
        };
        assert_eq!(code(&run("q1")), "ok");
        let a = run("q2");
        assert_eq!((a.status, code(&a).as_str()), (429, "rate"));
        assert_eq!(a.headers.iter().find(|(k, _)| *k == "Retry-After").map(|(_, v)| v.as_str()), Some("60"));
        // 120 requests a minute from one address, whatever they ask
        for _ in 2..SOURCE_PER_MINUTE {
            assert_eq!(code(&ask(&fx, &s, &http(b"x=1", None))), "request");
        }
        let a = ask(&fx, &s, &http(b"x=1", None));
        assert_eq!((a.status, code(&a).as_str()), (429, "abuse"));
    }

    #[test]
    fn the_daily_issuance_rate_answers_429_until_a_day_has_passed() {
        let fx = fx();
        let mut m = map_with(&fx, client_with(jwt_credential(&fx)));
        m["clients"][0]["rate"]["per_day_each"] = json!(2);
        let s = store_of(&m, &[]);
        let run = |jti: &str| {
            let body = jwt_form(&fx, jti, &[]);
            let p = proof(&fx, &format!("p{jti}"));
            ask(&fx, &s, &http(&body, Some(&p)))
        };
        assert_eq!(code(&run("d1")), "ok");
        assert_eq!(code(&run("d2")), "ok");
        let a = run("d3");
        assert_eq!((a.status, code(&a).as_str()), (429, "rate"));
        // both tokens fell in the minute that began at NOW - NOW % 60; that minute leaves the window a day later
        let retry = (NOW.div_euclid(60) * 60 + DAY - NOW).to_string();
        assert_eq!(a.headers.iter().find(|(k, _)| *k == "Retry-After").map(|(_, v)| v.as_str()), Some(retry.as_str()));
        // the window slides: a day after that minute began, the client may ask again
        let later = NOW.div_euclid(60) * 60 + DAY;
        let key = format!("{ORG} {CLIENT}");
        assert_eq!(take_daily(&fx.state.issued_daily, &key, 2, later - 1), Err(Limit::Wait(1)));
        assert_eq!(take_daily(&fx.state.issued_daily, &key, 2, later), Ok(()));
    }

    #[test]
    fn a_full_window_map_refuses_a_new_key_with_abuse() {
        let state = IssueState::new();
        let held = |i: usize| IpAddr::from([10, (i >> 16) as u8, (i >> 8) as u8, i as u8]);
        for i in 0..WINDOW_KEYS {
            assert_eq!(state.source_ok(held(i), NOW), Ok(()));
        }
        let newcomer = IpAddr::from([192, 0, 2, 1]);
        assert_eq!(state.source_ok(newcomer, NOW + 59), Err(MINUTE), "the map is full of live sources");
        assert_eq!(state.source_ok(held(1), NOW + 59), Ok(()), "a held source still counts");
        assert_eq!(state.source_ok(newcomer, NOW + 60), Ok(()), "once the others are stale, room is made");
        // the issuance windows: a new client is refused `abuse` while the map is full of live clients
        for i in 0..WINDOW_KEYS {
            assert_eq!(take(&state.issued, &format!("acme c{i}"), 120, NOW), Ok((1, MINUTE)));
        }
        let r = state.issue_ok(ORG, CLIENT, 120, 1000, NOW + 1).err().unwrap();
        assert_eq!((r.code, r.retry), ("abuse", Some(MINUTE)));
        assert_eq!(take(&state.issued, "acme c7", 120, NOW + 1), Ok((2, MINUTE - 1)), "a held client still counts");
        for i in 0..WINDOW_KEYS {
            assert_eq!(take_daily(&state.issued_daily, &format!("acme c{i}"), 1000, NOW), Ok(()));
        }
        assert_eq!(take_daily(&state.issued_daily, "acme new", 1000, NOW + 1), Err(Limit::Full));
        let r = state.issue_ok(ORG, CLIENT, 120, 1000, NOW + 61).err().unwrap();
        assert_eq!(r.code, "abuse", "the minute window has room again; the day window is still full");
    }

    #[test]
    fn an_unlicensed_listener_refuses_right_after_the_source_limiter() {
        let fx = fx();
        let mut m = map_with(&fx, client_with(jwt_credential(&fx)));
        m["expires"] = json!(NOW - 1);
        let expired = store_of(&m, &[]);
        let ok = store_of(&map_with(&fx, client_with(jwt_credential(&fx))), &[]);
        let body = jwt_form(&fx, "u1", &[]);
        let p = proof(&fx, "up1");
        let unlicensed = |s: &ApiMapStore, revoking: bool| {
            let mut ctx = ctx_of(&fx, s, &owners, None);
            ctx.licensed = false;
            let h = http(&body, Some(&p));
            if revoking {
                revoke(&ctx, &h, &|_: &str, _: &str, _: i64| Err(("journal", "not journaled".to_string())))
            } else {
                token(&ctx, &h)
            }
        };
        let a = unlicensed(&ok, false);
        assert_eq!((a.status, code(&a).as_str(), a.body["error"].as_str()), (403, "license", Some("unauthorized_client")));
        assert_eq!(code(&unlicensed(&expired, false)), "license", "before map-expired");
        assert_eq!(code(&unlicensed(&ok, true)), "license", "revocation too");
        assert_eq!(code(&ask(&fx, &ok, &http(&body, Some(&p)))), "ok", "licensed, the same request issues");
    }

    #[test]
    fn a_resource_outside_the_clients_relays_is_invalid_target() {
        let fx = fx();
        let mut c = client_with(jwt_credential(&fx));
        c["relays"] = json!(["r_01"]);
        let m = map_with(&fx, c);
        let run = |s: &ApiMapStore, jti: &str, resource: Option<&str>| {
            let extra: Vec<(&str, &str)> = resource.map(|r| ("resource", r)).into_iter().collect();
            let body = jwt_form(&fx, jti, &extra);
            let p = proof(&fx, &format!("p{jti}"));
            ask(&fx, s, &http(&body, Some(&p)))
        };
        let s = store_of(&m, &[]);
        assert_eq!(code(&run(&s, "t1", Some(RR1))), "ok");
        let a = run(&s, "t2", Some(RR2));
        assert_eq!((a.status, a.body["error"].as_str(), code(&a).as_str()), (400, Some("invalid_target"), "target"));
        assert_eq!(code(&run(&s, "t3", None)), "target", "I is the console, not in relays");
        assert_eq!(code(&run(&s, "t4", Some("https://evil.example/api/orgs/acme"))), "target");
        let dropped = store_of(&m, &[entry("client_drop_relay", json!({"client": CLIENT, "relay": "r_01"}))]);
        assert_eq!(code(&run(&dropped, "t5", Some(RR1))), "target");
    }

    #[test]
    fn the_local_issuer_grants_only_its_scopes() {
        let fx = fx();
        let s = store_of(&map_with(&fx, client_with(jwt_credential(&fx))), &[]);
        let only: &[&'static str] = &["monitor.read"];
        let body = jwt_form(&fx, "l1", &[]);
        let p = proof(&fx, "lp1");
        let a = issue_as(&fx, &s, &http(&body, Some(&p)), &owners, Some(only));
        assert_eq!(a.body["scope"].as_str(), Some("monitor.read"));
        let body = jwt_form(&fx, "l2", &[("scope", "audit.read")]);
        let p = proof(&fx, "lp2");
        assert_eq!(code(&issue_as(&fx, &s, &http(&body, Some(&p)), &owners, Some(only))), "scope");
    }

    #[test]
    fn revoke_journals_its_own_token_once() {
        let fx = fx();
        let m = map_with(&fx, client_with(jwt_credential(&fx)));
        let s = store_of(&m, &[]);
        let body = jwt_form(&fx, "v1", &[]);
        let p = proof(&fx, "vp1");
        let t = ask(&fx, &s, &http(&body, Some(&p)));
        let token_text = t.body["access_token"].as_str().unwrap().to_string();
        let c = claims(&t);
        let calls = RefCell::new(Vec::new());
        let journal = |client: &str, jti: &str, until: i64| {
            calls.borrow_mut().push((client.to_string(), jti.to_string(), until));
            Ok::<(), (&'static str, String)>(())
        };
        let rev = |s: &ApiMapStore, jti: &str, token: &str| {
            let a = assertion(&fx, jti);
            let body = form(&[("token", token), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", a.as_str())]);
            revoke(&ctx_of(&fx, s, &owners, None), &http(&body, None), &journal)
        };
        let a = rev(&s, "v2", &token_text);
        assert_eq!((a.status, a.event.as_ref().map(|e| e.0)), (200, Some("api.revoke")));
        assert_eq!(*calls.borrow(), vec![(CLIENT.to_string(), c["jti"].as_str().unwrap().to_string(), c["exp"].as_i64().unwrap())]);
        // once journaled the token is denied: revoking it again journals nothing
        let denied = store_of(&m, &[json!({"ts": NOW, "action": "token_deny", "target": {"client": CLIENT, "jti": c["jti"]}, "until": c["exp"]})]);
        assert_eq!(rev(&denied, "v3", &token_text).status, 200);
        // a token of another key, or no token at all: 200, nothing journaled
        let (other, _) = key(KID);
        let forged = tok::mint_access_token(&other, KID, ISSUER, ISSUER, CLIENT, ORG, &["monitor.read".to_string()], "R0", "internal", 7, &Cnf::None, NOW, NOW + 600).unwrap().token;
        assert_eq!(rev(&s, "v4", &forged).status, 200);
        assert_eq!(rev(&s, "v5", "not-a-token").status, 200);
        assert_eq!(calls.borrow().len(), 1);
        // the client must authenticate
        let body = form(&[("token", token_text.as_str()), ("client_id", CLIENT)]);
        assert_eq!(code(&revoke(&ctx_of(&fx, &s, &owners, None), &http(&body, None), &journal)), "client-auth");
        assert_eq!(calls.borrow().len(), 1);
        // a revocation journaling nothing still carries its event (without a jti) for the caller to audit
        let a = rev(&s, "v6", "not-a-token");
        assert_eq!(a.event.as_ref().map(|(n, e)| (*n, e.get("jti").is_none())), Some(("api.revoke", true)));
        // 9.4: the audit before the journal failed: 503 audit-unavailable, nothing journaled
        let unaudited = |_: &str, _: &str, _: i64| Err::<(), _>(("audit-unavailable", "disk full".to_string()));
        let a = assertion(&fx, "v7");
        let body = form(&[("token", token_text.as_str()), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", a.as_str())]);
        let r = revoke(&ctx_of(&fx, &s, &owners, None), &http(&body, None), &unaudited);
        assert_eq!((r.status, code(&r).as_str()), (503, "audit-unavailable"));
    }

    #[test]
    fn documents_follow_rfc_8414_and_9728() {
        let revoke_at = format!("{ISSUER}/oauth/revoke");
        let m = as_metadata(ISSUER, ENDPOINT, Some(&revoke_at), &format!("{ISSUER}/jwks.json"));
        assert_eq!((m["issuer"].as_str(), m["token_endpoint"].as_str(), m["revocation_endpoint"].as_str()), (Some(ISSUER), Some(ENDPOINT), Some(revoke_at.as_str())));
        assert_eq!(m["grant_types_supported"], json!(["client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"]));
        assert_eq!(m["token_endpoint_auth_methods_supported"], json!(["tls_client_auth", "private_key_jwt", "client_secret_basic"]));
        assert_eq!((m["tls_client_certificate_bound_access_tokens"].as_bool(), m["dpop_signing_alg_values_supported"].clone()), (Some(true), json!(["ES256"])));
        assert!(as_metadata(ISSUER, ENDPOINT, None, "x").get("revocation_endpoint").is_none());
        assert_eq!(
            resource_metadata(RR1, &[ISSUER, "l"], &["monitor.read"]),
            json!({"resource": RR1, "authorization_servers": [ISSUER, "l"], "scopes_supported": ["monitor.read"], "bearer_methods_supported": ["header"]})
        );
        let (_, jwk) = key("k9");
        assert!(tok::parse_jwk(&jwk, tok::CLIENT_RSA_MIN_BITS).is_some());
        assert_eq!((jwk["kid"].as_str(), jwk["alg"].as_str()), (Some("k9"), Some("ES256")));
        assert_eq!(jwks(std::slice::from_ref(&jwk)), json!({"keys": [jwk]}));
    }
}
