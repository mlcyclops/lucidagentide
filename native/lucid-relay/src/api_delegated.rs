// API-1 revision 5 (docs/api/contract-r5-1c.md) 4.4 to 4.6 and 6.1 to 6.6: person-delegated OAuth at the console
// issuer I (`agent_delegated` clients).
//
// - 4.4 metadata: the AS metadata additions, protected resource metadata for M (served by the front door) and for C
//   and CM (functions the connector serves in 1c4), and the `resource` rule: I and relay resources (1a), M for reach
//   R0, C or CM of a connector in the client's `connectors` for reach R1 (absent is `target`; a suspended connector
//   gets no tokens).
// - 4.1 CIMD: a `client_id` URL is looked up only among the pinned `cimd` URLs; its document is fetched under 1a 8.1.
// - 6.2 client authentication for the delegated grants: `tls_client_auth`, `private_key_jwt` (registered or CIMD keys)
//   or none (a public client, with PKCE and DPoP; R1 loopback-only public clients need `loopback_ok`).
// - 6.4 EMA (`jwt-bearer` with an ID-JAG), closed until gate G-EMA-OKTA-SUB is verified; `jwt-dpop` is refused (O11).
// - 6.5 the authorization code path: `GET I/oauth/authorize`, the SSO `api/begin` round trip bound to the browser by
//   the `__Host-lucid-authz` cookie (R5-2), `POST I/oauth/sso-return`, the consent page, codes, and refresh token
//   families kept hashed in the sealed console state `api-consent/<org>.json`.
// - 6.1 who may delegate, at every issuance and refresh, from SSO-signed person records (`api_subject`, R5-1) under
//   the org's policy (`api-org-policy`, verified under the Meet CA root: `domains`, `ai.who.groups`, `identity`).
// - 6.6 the delegated access token (`api_token::mint_delegated_token`, `api_token::delegated_subject`).
// - 4.2 `person_revoke`: the process-wide copy of each org's active entries (`publish_revokes`), read by offline
//   validation, and the families it ends.

use crate::api_cjournal::{self as cj, ConsoleEntry};
use crate::api_fetch::{check_url, FetchCache, Limits};
use crate::api_issue::{self as issue, no, Answer, IssueCtx, Refusal, TokenHttp};
use crate::api_map::{effective_end, ApiMapStore, TightenEntry, CEILINGS};
use crate::api_resource::Reply;
use crate::api_subject::{self as subject, Ask, PersonRecord};
use crate::api_token::{self as tok, Alg, Cnf, JtiCache, Lifetime};
use crate::codec::{b64u, hex, parse_json, sha256, stringify, unb64u};
use crate::fleet_ca::{vault_do, VaultLock};
use crate::meet_org_policy::{self as op, IdentityProvider};
use crate::meet_x509::{ecdsa_sha256_verified, Cert, Crl};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

type Obj = Map<String, Value>;

pub const GRANT_JWT_BEARER: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/// ID-JAG draft 06; refused `grant` in 1c (O11).
pub const GRANT_JWT_DPOP: &str = "urn:ietf:params:oauth:grant-type:jwt-dpop";
pub const GRANT_CODE: &str = "authorization_code";
pub const GRANT_REFRESH: &str = "refresh_token";
/// The ID-JAG header `typ`.
pub const ID_JAG_TYP: &str = "oauth-id-jag+jwt";
pub const ID_JAG_PROFILE: &str = "urn:ietf:params:oauth:grant-profile:id-jag";
/// EMA stays closed until this gate is in `meet_org_policy::RELAY_GATES` (contract file; `api_federation` pattern).
pub const EMA_GATE: &str = "G-EMA-OKTA-SUB";
/// R5-21: the largest ID-JAG `act` (canonical JSON bytes).
pub const ACT_MAX: usize = 1024;
/// 6.5: a code lives 60 s; a waiting request 10 minutes.
pub const CODE_LIFE: i64 = 60;
pub const REQUEST_LIFE: i64 = 600;
/// 4.3: verified person records are reused at most this long.
pub const RECORD_CACHE: i64 = 60;
/// 6.1: a verified org policy is reused at most this long.
pub const POLICY_CACHE: i64 = 60;
/// R5-6: delegated tokens issued this recently count as live access for `drop_delegation`.
pub const TRACK_WINDOW: i64 = 600;
/// 14.1: each person's use of a delegated grant is remembered this long for the delegations list.
pub const USE_WINDOW: i64 = 86_400;
/// R5-6: `Retry-After` of a delegated grant refused because the issuance tracker is full (503 `journal`).
pub const TRACK_RETRY_S: i64 = 60;
/// R5-6: the sentence of that refusal.
pub const TRACK_FULL: &str = "The console tracks too many delegated tokens to issue another now; try again later.";
/// 3.2, O19: `idps[].auth_max_s` default.
pub const AUTH_MAX_DEFAULT: i64 = 43_200;
/// 3.2: `idps[].max_age_s` when a map omits it (the console judges widenings and narrowings on it too).
pub const MAX_AGE_DEFAULT: i64 = 300;
/// O2: `delegation.consent_days` default.
pub const CONSENT_DAYS_DEFAULT: i64 = 7;
/// 6.5 step 2 (R5-2): the browser binding cookie.
pub const COOKIE: &str = "__Host-lucid-authz";
pub const REFRESH_PREFIX: &str = "lrt_";
/// 4.1: the largest CIMD document.
pub const CIMD_MAX: usize = 256 * 1024;
/// 6.5 step 2: the attestation label (`meet_org_policy.sso_api_att_bytes` in Python).
pub const ATT_LABEL: &str = "lucid-meet-sso-api-v1";
/// 6.5 step 2: an attestation is good at most 120 s after signing (60 s of clock skew allowed here).
const ATT_SPAN_MAX: i64 = 180;
/// The ID-JAG `jti` cache window: `iat` at most 60 s ahead and `exp - iat` at most 600, so an entry outlives `exp`.
pub const JAG_JTI_WINDOW: i64 = 720;
/// The sealed consent store, under the console's state folder.
pub const CONSENT_DIR: &str = "api-consent";
/// 6.1 last paragraph: the reach R0 scopes a delegated client may hold, each also gated by the person's console role.
pub const R0_SCOPES: [&str; 4] = ["monitor.read", "fleet.read", "audit.read", "events.subscribe"];
const SKEW: i64 = 60;
const DAY: i64 = 86_400;
/// Waiting requests, codes, cached records and tracked issuances held at once (per console).
const HELD_MAX: usize = 10_000;
/// Rotated refresh token hashes kept per family to detect reuse.
const USED_MAX: usize = 256;

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// A refusal with its contract code (4.5) and a sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fail {
    pub code: &'static str,
    pub why: String,
}

impl Fail {
    pub fn new(code: &'static str, why: impl Into<String>) -> Fail {
        Fail { code, why: why.into() }
    }
}

fn fail<T>(code: &'static str, why: impl Into<String>) -> Result<T, Fail> {
    Err(Fail::new(code, why))
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn random(n: usize) -> Result<Vec<u8>, Fail> {
    crate::console_auth::random(n).ok_or_else(|| Fail::new("sign", "The console could not draw random bytes."))
}

/// The SHA-256 (hex) under which codes, refresh tokens and cookies are kept.
pub fn token_hash(t: &str) -> String {
    hex(&sha256(t.as_bytes()))
}

fn same(a: &str, b: &str) -> bool {
    aws_lc_rs::constant_time::verify_slices_are_equal(a.as_bytes(), b.as_bytes()).is_ok()
}

/// 6.4: EMA is open only once gate G-EMA-OKTA-SUB is verified (`meet_org_policy::RELAY_GATES`).
pub fn ema_open() -> bool {
    op::RELAY_GATES.contains(&EMA_GATE)
}

/// The client is of kind `agent_delegated`.
pub fn is_delegated(client: &Obj) -> bool {
    client.get("kind").and_then(Value::as_str) == Some("agent_delegated")
}

// ── resources and metadata (4.4) ─────────────────────────────────────────────────────────────────────────────────

/// M = `I/mcp`.
pub fn mcp_resource(issuer: &str) -> String {
    format!("{}/mcp", issuer.trim_end_matches('/'))
}

/// C = `<origin>/api/orgs/<org>` (also the form of a relay resource).
pub fn connector_resource(origin: &str, org: &str) -> String {
    format!("{}/api/orgs/{org}", origin.trim_end_matches('/'))
}

/// CM = `C/mcp`.
pub fn connector_mcp_resource(origin: &str, org: &str) -> String {
    format!("{}/mcp", connector_resource(origin, org))
}

/// Revision 6 7.2.2: A = `C/a2a`, the connector's A2A resource.
pub fn connector_a2a_resource(origin: &str, org: &str) -> String {
    format!("{}/a2a", connector_resource(origin, org))
}

/// What a `resource` names in the pinned map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Issuer,
    Relay(String),
    Mcp,
    Connector(String),
    ConnectorMcp(String),
    /// Revision 6 7.2.2: A of a connector.
    ConnectorA2a(String),
}

fn issuer_of(map: &Obj) -> &str {
    map.get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).unwrap_or_default()
}

fn connectors(map: &Obj) -> impl Iterator<Item = &Value> {
    map.get("connectors").and_then(Value::as_array).into_iter().flatten()
}

/// The target of `resource` in `map` (the pinned map object), from the map only.
pub fn target_of(map: &Obj, org: &str, resource: &str) -> Option<Target> {
    let issuer = issuer_of(map);
    if !issuer.is_empty() && resource == issuer {
        return Some(Target::Issuer);
    }
    if !issuer.is_empty() && resource == mcp_resource(issuer) {
        return Some(Target::Mcp);
    }
    for c in connectors(map) {
        let (Some(id), Some(origin)) = (s(c, "id"), s(c, "origin")) else { continue };
        if resource == connector_resource(origin, org) {
            return Some(Target::Connector(id.to_string()));
        }
        if resource == connector_mcp_resource(origin, org) {
            return Some(Target::ConnectorMcp(id.to_string()));
        }
        if resource == connector_a2a_resource(origin, org) {
            return Some(Target::ConnectorA2a(id.to_string()));
        }
    }
    map.get("relay_origins")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .find(|(_, o)| o.as_str().is_some_and(|o| connector_resource(o, org) == resource))
        .map(|(id, _)| Target::Relay(id.clone()))
}

/// 4.4's decision on a `resource`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// 1a rules apply (I or a relay resource, absent meaning I).
    Legacy,
    /// The token's `aud` (M, C or CM) and what it names.
    Chosen(String, Target),
}

/// 4.4: a delegated client of reach R0 gets M only (absent `resource` means M); a client of reach R1 with
/// `connectors` (any delegated R1 client) gets C or CM of a listed, active, unsuspended connector it was not dropped
/// from (absent is `target`); any other client gets M with reach R0, and 1a's I or relay resources otherwise.
pub fn resolve_resource(map: &Obj, org: &str, client: &Obj, id: &str, asked: Option<&str>, console: &[ConsoleEntry]) -> Result<Resolved, Fail> {
    let issuer = issuer_of(map);
    let reach = client.get("reach").and_then(Value::as_str).unwrap_or_default();
    let listed: Vec<&str> = tok::names(client, "connectors").collect();
    let delegated = is_delegated(client);
    if reach == "R1" && (delegated || !listed.is_empty()) {
        let Some(r) = asked else { return fail("target", "This client must name the resource it wants (resource).") };
        let target = target_of(map, org, r);
        let k = match &target {
            Some(Target::Connector(k) | Target::ConnectorMcp(k)) => k.clone(),
            // revision 6 7.2.2: A only for a kind `agent` client holding `spokes.tasks.submit`
            Some(Target::ConnectorA2a(k)) => {
                let a2a = client.get("kind").and_then(Value::as_str) == Some("agent") && tok::names(client, "scopes").any(|s| s == "spokes.tasks.submit");
                if !a2a {
                    return fail("target", "Only an agent client with spokes.tasks.submit gets tokens for a connector's A2A resource.");
                }
                k.clone()
            }
            _ => return fail("target", "That resource is not a connector of this organization this client may use."),
        };
        if !listed.contains(&k.as_str()) || cj::client_connector_dropped(console, id, &k) {
            return fail("target", "This client may not use that connector.");
        }
        let active = connectors(map).any(|c| s(c, "id") == Some(k.as_str()) && s(c, "state") == Some("active"));
        if !active || cj::connector_suspended(console, &k) {
            return fail("target", "That connector is suspended, so the console issues no tokens for it.");
        }
        return Ok(Resolved::Chosen(r.to_string(), target.unwrap_or(Target::Connector(k))));
    }
    let m = mcp_resource(issuer);
    if delegated {
        return match asked {
            None => Ok(Resolved::Chosen(m, Target::Mcp)),
            Some(r) if r == m && !issuer.is_empty() => Ok(Resolved::Chosen(m, Target::Mcp)),
            _ => fail("target", "A delegated client of reach R0 gets tokens for the console MCP endpoint only."),
        };
    }
    match asked {
        Some(r) if r == m && reach == "R0" && !issuer.is_empty() => Ok(Resolved::Chosen(m, Target::Mcp)),
        Some(r) if matches!(target_of(map, org, r), Some(Target::Mcp | Target::Connector(_) | Target::ConnectorMcp(_) | Target::ConnectorA2a(_))) => fail("target", "This client may not use that resource."),
        _ => Ok(Resolved::Legacy),
    }
}

/// 4.4: the RFC 8414 additions of the console issuer I.
pub fn extend_as_metadata(v: &mut Value, issuer: &str) {
    let push = |v: &mut Value, k: &str, add: &[&str]| {
        let mut list = strings(v.get(k));
        list.extend(add.iter().map(|x| x.to_string()));
        v[k] = json!(list);
    };
    v["authorization_endpoint"] = json!(format!("{issuer}/oauth/authorize"));
    v["response_types_supported"] = json!(["code"]);
    v["code_challenge_methods_supported"] = json!(["S256"]);
    push(v, "grant_types_supported", &[GRANT_CODE, GRANT_REFRESH, GRANT_JWT_BEARER]);
    push(v, "token_endpoint_auth_methods_supported", &["none"]);
    v["token_endpoint_auth_signing_alg_values_supported"] = json!(["ES256", "RS256", "PS256"]);
    v["authorization_grant_profiles_supported"] = json!([ID_JAG_PROFILE]);
    v["client_id_metadata_document_supported"] = json!(true);
}

fn bound_metadata(resource: &str, issuer: &str, scopes: &[&str], name: String) -> Value {
    json!({"resource": resource, "authorization_servers": [issuer], "scopes_supported": scopes, "bearer_methods_supported": ["header"],
           "dpop_signing_alg_values_supported": ["ES256"], "tls_client_certificate_bound_access_tokens": true, "resource_name": name})
}

/// 4.4: RFC 9728 metadata of M (`/.well-known/oauth-protected-resource/api/orgs/<org>/mcp` on the front door).
pub fn mcp_metadata(issuer: &str, org_label: &str) -> Value {
    bound_metadata(&mcp_resource(issuer), issuer, &R0_SCOPES, format!("{org_label} fleet (MCP)"))
}

/// 4.4: RFC 9728 metadata of a connector's C or CM (`resource` exactly as the client calls it), served by 1c4.
#[cfg_attr(not(test), allow(dead_code))]
pub fn connector_metadata(issuer: &str, resource: &str, org_label: &str, connector_name: &str) -> Value {
    bound_metadata(resource, issuer, &["content.read", "content.post"], format!("{org_label} {connector_name} (Lucid connector)"))
}

/// Revision 6 7.2.2: RFC 9728 metadata of a connector's A (`resource` exactly as partners call it), scope
/// `spokes.tasks.submit`, header bearer only.
pub fn a2a_metadata(issuer: &str, resource: &str, org_label: &str, connector_name: &str) -> Value {
    bound_metadata(resource, issuer, &["spokes.tasks.submit"], format!("{org_label} {connector_name} (Lucid A2A agents)"))
}

/// RFC 9728 3.1: the path-inserted well-known URL of a resource's metadata.
#[cfg_attr(not(test), allow(dead_code))]
pub fn metadata_url(resource: &str) -> Option<String> {
    let rest = resource.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    Some(format!("https://{host}/.well-known/oauth-protected-resource/{path}").trim_end_matches('/').to_string())
}

/// 4.4: the `WWW-Authenticate` of a 401 (or, with `insufficient_scope`, a 403) from M, C or CM (served in 1c4, 1c5).
#[cfg_attr(not(test), allow(dead_code))]
pub fn www_authenticate(resource: &str, scopes: &[&str], error: Option<&str>) -> String {
    let mut out = format!("Bearer resource_metadata=\"{}\"", metadata_url(resource).unwrap_or_default());
    if !scopes.is_empty() {
        out.push_str(&format!(", scope=\"{}\"", scopes.join(" ")));
    }
    if let Some(e) = error {
        out.push_str(&format!(", error=\"{e}\""));
    }
    out
}

// ── PKCE (RFC 7636) and redirect URIs (3.2, RFC 8252) ───────────────────────────────────────────────────────────

fn unreserved(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b'~')
}

/// A `code_verifier`: 43 to 128 unreserved characters.
pub fn verifier_ok(v: &str) -> bool {
    (43..=128).contains(&v.len()) && v.bytes().all(unreserved)
}

/// An S256 `code_challenge`: the base64url of 32 bytes.
pub fn challenge_ok(c: &str) -> bool {
    c.len() == 43 && tok::b64u_strict(c).is_some_and(|b| b.len() == 32)
}

pub fn s256(verifier: &str) -> String {
    b64u(&sha256(verifier.as_bytes()))
}

/// The verifier is well formed and its S256 is the challenge.
pub fn pkce_matches(verifier: &str, challenge: &str) -> bool {
    verifier_ok(verifier) && same(&s256(verifier), challenge)
}

/// A loopback IP literal redirect `http://127.0.0.1[:port]/path` or `http://[::1][:port]/path`: (host, port, path).
pub fn loopback_parts(uri: &str) -> Option<(&'static str, Option<u16>, &str)> {
    let rest = uri.strip_prefix("http://")?;
    let (host, after) = if let Some(r) = rest.strip_prefix("127.0.0.1") {
        ("127.0.0.1", r)
    } else if let Some(r) = rest.strip_prefix("[::1]") {
        ("[::1]", r)
    } else {
        return None;
    };
    match after.strip_prefix(':') {
        Some(p) => {
            let end = p.find('/')?;
            let port = p[..end].parse::<u16>().ok().filter(|n| *n > 0)?;
            Some((host, Some(port), &p[end..]))
        }
        None if after.starts_with('/') => Some((host, None, after)),
        None => None,
    }
}

pub fn is_loopback(uri: &str) -> bool {
    loopback_parts(uri).is_some()
}

/// 3.2: a redirect URI is `https://` (no fragment, at most 512 characters, never `localhost`) or a loopback IP literal.
pub fn redirect_uri_ok(uri: &str) -> bool {
    if uri.len() > 512 || uri.contains('#') {
        return false;
    }
    if is_loopback(uri) {
        return true;
    }
    let Some(rest) = uri.strip_prefix("https://") else { return false };
    let host = redirect_host(&format!("https://{rest}")).to_ascii_lowercase();
    !host.is_empty() && host != "localhost" && !host.ends_with(".localhost")
}

/// The host of a redirect URI (6.5 step 4 shows it).
pub fn redirect_host(uri: &str) -> String {
    let rest = uri.split_once("://").map_or(uri, |(_, r)| r);
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if authority.starts_with('[') {
        authority.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default().to_string()
    }
}

/// RFC 8252 7.3: a loopback redirect matches whatever its port; any other only exactly.
pub fn redirect_matches(registered: &str, presented: &str) -> bool {
    match (loopback_parts(registered), loopback_parts(presented)) {
        (Some((h1, _, p1)), Some((h2, _, p2))) => h1 == h2 && p1 == p2,
        (None, None) => registered == presented,
        _ => false,
    }
}

/// The redirect URIs a client may use now: the map's (or its CIMD document's) less every `client_drop_redirect`.
pub fn registered_redirects(client: &Obj, id: &str, cimd: Option<&Cimd>, console: &[ConsoleEntry]) -> Vec<String> {
    let list = match cimd {
        Some(d) => d.redirect_uris.clone(),
        None => strings(client.get("redirect_uris")),
    };
    list.into_iter().filter(|u| redirect_uri_ok(u) && !cj::redirect_dropped(console, id, u)).collect()
}

/// R5-11: a public client of reach R1 whose every redirect URI is loopback needs `loopback_ok`.
pub fn loopback_refused(client: &Obj, public: bool, redirects: &[String]) -> bool {
    public
        && client.get("reach").and_then(Value::as_str) == Some("R1")
        && !redirects.is_empty()
        && redirects.iter().all(|u| is_loopback(u))
        && client.get("loopback_ok").and_then(Value::as_bool) != Some(true)
}

// ── CIMD (4.1) ───────────────────────────────────────────────────────────────────────────────────────────────────

/// A checked Client ID Metadata Document.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Cimd {
    pub url: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    /// `token_endpoint_auth_method` `none`.
    pub public: bool,
    /// Inline `jwks` keys (`private_key_jwt`).
    pub jwks: Vec<Value>,
    pub jwks_uri: Option<String>,
    /// The credential's `private_ok` (the `jwks_uri` fetch).
    pub private_ok: bool,
}

/// 4.1: `client_id` equal to the URL exactly, `client_name`, `redirect_uris` (each a 3.2 redirect, no `localhost`),
/// `token_endpoint_auth_method` `none` or `private_key_jwt`, and for `private_key_jwt` keys in `jwks` (each a public
/// key with a `kid`) or a `jwks_uri`.
pub fn check_cimd(url: &str, doc: &Value, private_ok: bool) -> Result<Cimd, String> {
    if !doc.is_object() {
        return Err("the document is not a JSON object".into());
    }
    if s(doc, "client_id") != Some(url) {
        return Err("its client_id is not its own URL".into());
    }
    let name = s(doc, "client_name").filter(|n| (1..=256).contains(&n.chars().count())).ok_or("it has no client_name")?;
    let uris = doc.get("redirect_uris").and_then(Value::as_array).filter(|a| (1..=8).contains(&a.len())).ok_or("it lists no redirect_uris")?;
    let redirect_uris: Vec<String> = uris.iter().map(|u| u.as_str().filter(|u| redirect_uri_ok(u)).map(str::to_string)).collect::<Option<_>>().ok_or("a redirect URI is not https or a loopback IP literal")?;
    let public = match s(doc, "token_endpoint_auth_method") {
        Some("none") => true,
        Some("private_key_jwt") => false,
        _ => return Err("token_endpoint_auth_method must be none or private_key_jwt".into()),
    };
    let mut jwks = Vec::new();
    let mut jwks_uri = None;
    if !public {
        if let Some(keys) = doc.get("jwks").and_then(|j| j.get("keys")).and_then(Value::as_array) {
            if keys.is_empty() || !keys.iter().all(|k| s(k, "kid").is_some() && tok::parse_jwk(k, tok::CLIENT_RSA_MIN_BITS).is_some()) {
                return Err("a jwks key is not a public key with a kid".into());
            }
            jwks = keys.clone();
        }
        jwks_uri = s(doc, "jwks_uri").map(str::to_string);
        if jwks_uri.as_deref().is_some_and(|u| check_url(u).is_err()) {
            return Err("its jwks_uri cannot be fetched".into());
        }
        if jwks.is_empty() && jwks_uri.is_none() {
            return Err("private_key_jwt needs jwks or jwks_uri".into());
        }
    }
    Ok(Cimd { url: url.to_string(), client_name: name.to_string(), redirect_uris, public, jwks, jwks_uri, private_ok })
}

/// 4.1: the client whose usable `cimd` credential names `url` exactly, with that credential.
pub fn cimd_client<'a>(clients: &'a [Value], url: &str, active: &[TightenEntry]) -> Option<(&'a Obj, &'a Value)> {
    clients.iter().filter_map(Value::as_object).find_map(|c| {
        let cred = tok::usable_credentials(c, active).into_iter().find(|cr| s(cr, "type") == Some("cimd") && s(cr, "url") == Some(url))?;
        Some((c, cred))
    })
}

/// 4.1: a failed CIMD document raises `ApiCimdBroken`. There is no attention hook for issuer events in this slice, so
/// it is the security line `api.cimd.broken` (the console's attention list picks it up in 1c7).
fn cimd_broken(url: &str, why: &str) {
    let f = crate::log::Fields::new().with("url", url).with("why", why);
    crate::console_meet::logger().security("api.cimd.broken", &f, crate::log::Level::Warn);
}

/// 4.1: the document of a `cimd` credential, fetched under 1a 8.1 (no redirects, address checks, 256 KiB, cached at
/// most an hour by the console's fetch cache) and checked; any failure is `client`.
pub fn cimd_document(fetch: &FetchCache, url: &str, private_ok: bool) -> Result<Cimd, Fail> {
    let got = check_url(url).map_err(|e| e.to_string()).and_then(|u| fetch.fetch_json_blocking(&u, private_ok, CIMD_MAX, Limits::default()).map_err(|e| e.to_string()));
    let doc = got.map_err(|why| {
        cimd_broken(url, &why);
        Fail::new("client", "The client's metadata document could not be fetched.")
    })?;
    check_cimd(url, &doc, private_ok).map_err(|why| {
        cimd_broken(url, &why);
        Fail::new("client", format!("The client's metadata document is not usable: {why}."))
    })
}

/// A client named by a request: its map entry, its `c_` id, the id as presented (the CIMD URL for a CIMD client), its
/// document, and whether it is public (no key: CIMD `none`, or no key credential in the map).
pub struct Named<'a> {
    pub client: &'a Obj,
    pub id: String,
    pub presented: String,
    pub cimd: Option<Cimd>,
    /// The `cimd` credential's `expires` (the key end of 5.3); None without one.
    pub cimd_expires: Option<i64>,
    pub public: bool,
}

/// 4.1, 6.2: the client a `client_id` names: a CIMD URL only among the pinned `cimd` URLs (its document fetched), else a
/// `c_` id of the map; a client with a `cimd` credential is named by its URL only. Unknown is `client`.
pub fn named_client<'a>(store: &'a ApiMapStore, org: &str, presented: &str, fetch: &FetchCache, now: i64) -> Result<Named<'a>, Fail> {
    let active = store.active(org);
    if presented.starts_with("https://") {
        let Some((client, cred)) = cimd_client(store.clients(org), presented, active) else { return fail("client", "That client is not registered for this organization.") };
        let expires = cred.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
        if now > expires {
            return fail("expired", "That client's metadata document registration has expired.");
        }
        let doc = cimd_document(fetch, presented, cred.get("private_ok").and_then(Value::as_bool).unwrap_or(false))?;
        let id = client.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        return Ok(Named { client, id, presented: presented.to_string(), public: doc.public, cimd: Some(doc), cimd_expires: Some(expires) });
    }
    let Some(client) = tok::find_client(store, org, presented) else { return fail("client", "That client is not registered for this organization.") };
    let creds = tok::usable_credentials(client, active);
    if creds.iter().any(|c| s(c, "type") == Some("cimd")) {
        return fail("client", "This client is named by its metadata document URL.");
    }
    let public = !creds.iter().any(|c| matches!(s(c, "type"), Some("private_key_jwt" | "mtls" | "client_secret" | "entra_wif" | "federated")));
    Ok(Named { client, id: presented.to_string(), presented: presented.to_string(), cimd: None, cimd_expires: None, public })
}

// ── the ID-JAG (6.4) ─────────────────────────────────────────────────────────────────────────────────────────────

/// The claims of a verified ID-JAG.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct IdJag {
    pub iss: String,
    pub sub: String,
    pub client_id: String,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
    pub auth_time: Option<i64>,
    pub resource: String,
    pub scope: Option<String>,
    pub act: Option<Value>,
    pub acr: Option<String>,
    pub amr: Vec<String>,
}

/// 6.4 step 4: a compact JWS whose header `typ` is exactly `oauth-id-jag+jwt` (`assertion`).
pub fn id_jag_parse(token: &str) -> Result<tok::Jws<'_>, Fail> {
    let jws = tok::parse_jws(token).ok_or_else(|| Fail::new("assertion", "The assertion is not a compact JWS."))?;
    if jws.header.get("typ").and_then(Value::as_str) != Some(ID_JAG_TYP) {
        return fail("assertion", "The assertion's typ is not oauth-id-jag+jwt.");
    }
    Ok(jws)
}

/// The `idps[]` entry whose `issuer` is `iss` exactly, with every active `idp_limit` applied.
pub fn idp_of(map: &Obj, iss: &str, console: &[ConsoleEntry]) -> Option<Value> {
    let idp = map.get("idps").and_then(Value::as_array)?.iter().find(|i| s(i, "issuer") == Some(iss))?;
    Some(cj::idp_effective(idp, console))
}

/// 6.4: `alg` in the IdP's effective `algs` (ES256, RS256 or PS256 when the IdP is unknown); never `none` or HMAC.
pub fn id_jag_alg(jws: &tok::Jws, idp: Option<&Value>) -> Result<Alg, Fail> {
    let name = jws.header.get("alg").and_then(Value::as_str).unwrap_or_default();
    let listed = idp.is_none_or(|i| strings(i.get("algs")).iter().any(|a| a == name));
    match Alg::of(name) {
        Some(a) if listed => Ok(a),
        _ => fail("assertion", "The assertion's alg is not one this IdP may use."),
    }
}

/// 6.4: the IdP is known, `active`, under no `idp_suspend`, in the client's `delegation.idps` and not dropped from it
/// (`idp`). Ok is its id.
pub fn idp_usable(idp: Option<&Value>, client: &Obj, id: &str, console: &[ConsoleEntry]) -> Result<String, Fail> {
    let Some(idp) = idp else { return fail("idp", "No IdP of this organization issues that assertion.") };
    let idp_id = s(idp, "id").unwrap_or_default();
    if s(idp, "state") != Some("active") || cj::idp_suspended(console, idp_id) {
        return fail("idp", "That IdP is suspended.");
    }
    let listed = client.get("delegation").and_then(|d| d.get("idps")).map(|v| strings(Some(v))).unwrap_or_default();
    if !listed.iter().any(|x| x == idp_id) || cj::delegation_dropped(console, id, "idp", idp_id) {
        return fail("idp", "This client does not take assertions from that IdP.");
    }
    Ok(idp_id.to_string())
}

/// The key that proves the access token: a DPoP key's thumbprint or the TLS client certificate's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binding<'a> {
    Jkt(&'a str),
    X5t(&'a str),
}

/// 6.4 (R5-8, every client): an ID-JAG `cnf` must be one `jkt` equal to the DPoP proof's key, or one `x5t#S256` equal to
/// the TLS certificate's; any other method, or one the request does not prove, is `assertion`.
pub fn cnf_ok(cnf: Option<&Value>, binding: &Binding) -> Result<(), Fail> {
    let Some(cnf) = cnf else { return Ok(()) };
    let o = cnf.as_object().filter(|o| o.len() == 1);
    let ok = match (o.and_then(|o| o.iter().next()), binding) {
        (Some((k, v)), Binding::Jkt(j)) if k == "jkt" => v.as_str().is_some_and(|v| same(v, j)),
        (Some((k, v)), Binding::X5t(x)) if k == "x5t#S256" => v.as_str().is_some_and(|v| same(v, x)),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        fail("assertion", "The assertion's cnf does not name the key or certificate of this request.")
    }
}

/// What `verify_id_jag` checks against.
pub struct IdJagCheck<'a> {
    /// I: the only accepted `aud`.
    pub issuer: &'a str,
    /// The authenticated client's `c_` id and the id it presented (its CIMD URL).
    pub client_names: &'a [&'a str],
    pub binding: Binding<'a>,
    pub now: i64,
}

/// 6.4 step 4 after the IdP: the signature by a key of the IdP's JWKS (`kid`, or the only key), `aud` I exactly (a
/// string or a one-element array), `client_id` the authenticated client, `cnf`, `exp` in the future, `iat` at most
/// 60 s ahead, `exp - iat` at most the IdP's `max_age_s`, the `jti` unseen for this IdP until `exp`, `tenant`, one
/// `resource`, a non-empty `sub`. Every refusal is `assertion` (a full replay cache is `abuse`).
pub fn verify_id_jag(jws: &tok::Jws, alg: Alg, keys: &[Value], idp: &Value, c: &IdJagCheck, cache: &mut JtiCache) -> Result<IdJag, Fail> {
    let bad = |m: &str| Fail::new("assertion", m);
    let claim = |k: &str| jws.claims.get(k);
    let text = |k: &str| claim(k).and_then(Value::as_str);
    let jwk = match jws.header.get("kid").and_then(Value::as_str) {
        Some(kid) => keys.iter().find(|k| s(k, "kid") == Some(kid)),
        None if keys.len() == 1 => keys.first(),
        None => None,
    };
    let key = jwk.and_then(|k| tok::parse_jwk(k, tok::ISSUER_RSA_MIN_BITS)).ok_or_else(|| bad("The assertion's key is not in the IdP's JWKS."))?;
    if !tok::verify_signature(&key, alg, jws.signing_input.as_bytes(), &jws.signature) {
        return Err(bad("The assertion's signature does not verify."));
    }
    let iss = text("iss").unwrap_or_default();
    let aud_ok = match claim("aud") {
        Some(Value::String(a)) => a == c.issuer,
        Some(Value::Array(a)) => a.len() == 1 && a[0].as_str() == Some(c.issuer),
        _ => false,
    };
    if !aud_ok {
        return Err(bad("The assertion's aud is not this issuer."));
    }
    let client_id = text("client_id").unwrap_or_default();
    if client_id.is_empty() || !c.client_names.contains(&client_id) {
        return Err(bad("The assertion's client_id is not the authenticated client."));
    }
    cnf_ok(claim("cnf"), &c.binding)?;
    let (Some(exp), Some(iat)) = (claim("exp").and_then(Value::as_i64), claim("iat").and_then(Value::as_i64)) else { return Err(bad("The assertion needs exp and iat.")) };
    if exp <= c.now {
        return Err(bad("The assertion has expired."));
    }
    if iat > c.now + SKEW {
        return Err(bad("The assertion is from the future."));
    }
    let max_age = idp.get("max_age_s").and_then(Value::as_i64).unwrap_or(MAX_AGE_DEFAULT);
    if exp - iat > max_age {
        return Err(bad("The assertion lasts longer than this IdP's max_age_s."));
    }
    let jti = text("jti").unwrap_or_default();
    match tok::admit_jti(cache, s(idp, "id").unwrap_or_default(), jti, c.now) {
        Ok(()) => {}
        Err("full") => return fail("abuse", "Too many assertions from this IdP; try again later."),
        Err(_) => return Err(bad("The assertion was already used (jti).")),
    }
    match (s(idp, "tenant"), claim("tenant")) {
        (Some(t), Some(v)) if v.as_str() == Some(t) => {}
        (None, None) => {}
        _ => return Err(bad("The assertion's tenant is not this IdP's tenant.")),
    }
    let resource = match claim("resource") {
        Some(Value::String(r)) => r.clone(),
        Some(Value::Array(a)) if a.len() == 1 && a[0].is_string() => a[0].as_str().unwrap_or_default().to_string(),
        _ => return Err(bad("The assertion must name exactly one resource.")),
    };
    let sub = text("sub").filter(|s| !s.is_empty()).ok_or_else(|| bad("The assertion names no subject."))?;
    let auth_time = match claim("auth_time") {
        None => None,
        Some(v) => Some(v.as_i64().ok_or_else(|| bad("The assertion's auth_time is not a time."))?),
    };
    Ok(IdJag {
        iss: iss.to_string(),
        sub: sub.to_string(),
        client_id: client_id.to_string(),
        jti: jti.to_string(),
        iat,
        exp,
        auth_time,
        resource,
        scope: text("scope").map(str::to_string),
        act: claim("act").cloned(),
        acr: text("acr").map(str::to_string),
        amr: strings(claim("amr")),
    })
}

/// R5-10: the evidence `method_matches` reads from an ID-JAG: each `amr` value and `acr:<acr>`.
pub fn evidence(acr: Option<&str>, amr: &[String]) -> Vec<String> {
    let mut out: Vec<String> = amr.to_vec();
    if let Some(a) = acr {
        out.push(format!("acr:{a}"));
    }
    out
}

/// 6.4 sign-in strength (R5-10): with the org policy's `identity.require_phishing_resistant`, the ID-JAG's `acr` and
/// `amr` must pass `method_matches` against one of the provider's `phr_values`; in every org `auth_time` must be
/// present, not ahead, and not older than the IdP's `auth_max_s`. `identity` is the org policy's `identity` object.
pub fn strength_ok(identity: Option<&Value>, provider: &str, jag: &IdJag, auth_max_s: i64, now: i64) -> Result<(), Fail> {
    if identity.and_then(|i| i.get("require_phishing_resistant")).and_then(Value::as_bool) == Some(true) {
        let phr = identity.and_then(|i| i.get("providers")).and_then(Value::as_array).into_iter().flatten().find(|p| s(p, "id") == Some(provider)).map(|p| strings(p.get("phr_values"))).unwrap_or_default();
        let ev = evidence(jag.acr.as_deref(), &jag.amr);
        if !phr.iter().any(|r| op::method_matches(r, &ev)) {
            return fail("assertion", "The sign-in behind the assertion is not phishing resistant.");
        }
    }
    let Some(t) = jag.auth_time else { return fail("assertion", "The assertion names no auth_time.") };
    if t > now + SKEW || now - t > auth_max_s {
        return fail("assertion", "The sign-in behind the assertion is too old.");
    }
    Ok(())
}

/// R5-21: the token's `act`: the client, with an ID-JAG actor (an object of at most 1 KiB) nested as information.
pub fn nested_act(client_id: &str, act: Option<&Value>) -> Result<Value, Fail> {
    match act {
        None => Ok(json!({"sub": client_id})),
        Some(a) if a.is_object() && stringify(a).len() <= ACT_MAX => Ok(json!({"sub": client_id, "act": a})),
        Some(_) => fail("assertion", "The assertion's act must be an object of at most 1 KiB."),
    }
}

/// 6.1 last paragraph: whether a console role (`admin`, `user-manager`, `viewer`; None: no active console person)
/// lets a delegated R0 token carry `scope`.
pub fn role_allows(role: Option<&str>, scope: &str) -> bool {
    match scope {
        "monitor.read" | "fleet.read" | "events.subscribe" => role.is_some(),
        "audit.read" => role == Some("admin"),
        _ => false,
    }
}

// ── who may delegate (6.1) ───────────────────────────────────────────────────────────────────────────────────────

/// 6.1: the ways the record's person may delegate to the client now (`principal:<p>`, `group:<id>`): the record says
/// `active`; the principal is not in `delegation.denied` and under no `person_revoke`; and it is listed in
/// `delegation.principals`, or the record's groups meet `delegation.groups`, through a way not dropped by
/// `client_drop_delegation`. Else `person`.
pub fn ways_in(client: &Obj, id: &str, record: &PersonRecord, console: &[ConsoleEntry]) -> Result<Vec<String>, Fail> {
    let p = record.principal.as_str();
    if !record.active {
        return fail("person", "That person is not active.");
    }
    let d = client.get("delegation");
    let list = |k: &str| d.map(|d| strings(d.get(k))).unwrap_or_default();
    if list("denied").iter().any(|x| x.eq_ignore_ascii_case(p)) || cj::person_revoked(console, id, p) {
        return fail("person", "That person may no longer delegate to this client.");
    }
    let mut ways = Vec::new();
    if list("principals").iter().any(|x| x.eq_ignore_ascii_case(p)) && !cj::delegation_dropped(console, id, "principal", p) {
        ways.push(format!("principal:{p}"));
    }
    for g in list("groups") {
        if record.groups.contains(&g) && !cj::delegation_dropped(console, id, "group", &g) {
            ways.push(format!("group:{g}"));
        }
    }
    if ways.is_empty() {
        return fail("person", "That person is not among the people who may delegate to this client.");
    }
    Ok(ways)
}

/// R5-6: whether a principal with these record groups is still allowed by a listed principal or group after a drop.
pub fn still_allowed(client: &Obj, id: &str, principal: &str, groups: &[String], console: &[ConsoleEntry]) -> bool {
    let record = PersonRecord {
        org: String::new(),
        provider: String::new(),
        iss: String::new(),
        sub: String::new(),
        principal: principal.to_string(),
        active: true,
        stale_at: 0,
        groups: groups.to_vec(),
        ts: 0,
    };
    ways_in(client, id, &record, console).is_ok()
}

/// 6.1 under the org's verified policy, at every issuance: `ways_in`, the principal of one of the policy's `domains`
/// (6.6), and a group way only through a group of the policy's `ai.who.groups` (3.2: the groups the SSO service signs
/// come from that list). Else `person`.
pub fn ways_under(policy: &Obj, client: &Obj, id: &str, record: &PersonRecord, console: &[ConsoleEntry]) -> Result<Vec<String>, Fail> {
    if !op::covers(policy, &record.principal) {
        return fail("person", "That person is not of the organization's domains.");
    }
    let who = strings(policy.get("ai").and_then(|a| a.get("who")).and_then(|w| w.get("groups")));
    let ways: Vec<String> = ways_in(client, id, record, console)?
        .into_iter()
        .filter(|w| match w.strip_prefix("group:") {
            Some(g) => who.iter().any(|x| x == g),
            None => true,
        })
        .collect();
    if ways.is_empty() {
        return fail("person", "That person is not among the people who may delegate to this client.");
    }
    Ok(ways)
}

// ── the org policy (6.1, 6.4) ────────────────────────────────────────────────────────────────────────────────────

/// The org Meet CA root SSO certificates and org policies are checked under, with its CRL when it has signed one.
pub struct Root {
    pub cert: Cert,
    pub crl: Option<Crl>,
}

impl Root {
    /// The CA certificate (DER) and its newest CRL (PEM, when the CA has signed one). A CRL that is not the root's
    /// leaves no usable root (fail closed).
    pub fn of(der: &[u8], crl_pem: Option<&str>) -> Option<Root> {
        let cert = Cert::from_der(der)?;
        let crl = match crl_pem {
            None => None,
            Some(p) => Some(Crl::from_pem(p.as_bytes()).filter(|c| c.issuer == cert.subject && c.signature_valid(&cert.spki))?),
        };
        Some(Root { cert, crl })
    }

    /// The certificate (PEM) is listed in the root's CRL (never without a CRL).
    pub fn revoked(&self, cert_pem: Option<&str>) -> bool {
        let Some(crl) = &self.crl else { return false };
        cert_pem.and_then(Cert::from_pem).is_some_and(|c| crl.serials.contains(&c.serial))
    }
}

/// The relay's `api-org-policy` answer: `{"signed": <the org's current signed policy>, "signer_policy": <root-signed
/// signer policy>}`, or `{"signed": null}` when it holds none.
pub fn org_policy_answer(wire: Option<Obj>, signer_policy: Value) -> Value {
    match wire {
        Some(w) => json!({"signed": w, "signer_policy": signer_policy}),
        None => json!({"signed": null}),
    }
}

/// The console's check of an `api-org-policy` answer: the signer policy signed by the root, the policy verified under
/// it (`meet_org_policy::verify`, the root's CRL when present), of `org` and not expired. Ok(None): the relay holds no
/// policy for the org.
pub fn verify_org_policy(answer: &Value, root: &Root, org: &str, now: i64) -> Result<Option<Obj>, String> {
    let signed = answer.get("signed").ok_or("the answer carries no signed policy")?;
    if signed.is_null() {
        return Ok(None);
    }
    let signer_policy = answer.get("signer_policy").and_then(Value::as_object).ok_or("the answer carries no signer policy")?;
    let v = op::verify(signed, &root.cert, signer_policy, root.crl.as_ref(), "", now as f64).map_err(|e| format!("the org policy does not verify: {e}"))?;
    if v.org != org {
        return Err(format!("the relay sent the policy of {}, not {org}", v.org));
    }
    if op::expired(&v.policy, now as f64) {
        return Err("the org policy has expired".into());
    }
    Ok(Some(v.policy))
}

/// 6.1, 6.4: the org's policy from the `api-org-policy` answers of its relays (`(relay, answer)`, asked lazily in
/// order): each answer is checked with `verify_org_policy` under `root` as it arrives, and one that fails (transport,
/// or verification with the security line `api.policy.unverified`) passes to the next relay. Ok(Some) is the first
/// verified policy; Ok(None) when no relay holds one but at least one answered so; Err (the last failure) otherwise.
pub fn first_verified_policy(answers: impl IntoIterator<Item = (String, Result<Value, String>)>, root: &Root, org: &str, now: i64) -> Result<Option<Obj>, String> {
    let mut last = "no relay of the organization is connected".to_string();
    let mut none = false;
    for (relay, answer) in answers {
        match answer.and_then(|a| verify_org_policy(&a, root, org, now).map_err(|why| {
            let f = crate::log::Fields::new().with("org", org).with("relay", relay.as_str()).with("why", why.as_str());
            crate::console_meet::logger().security("api.policy.unverified", &f, crate::log::Level::Error);
            why
        })) {
            Ok(Some(p)) => return Ok(Some(p)),
            Ok(None) => none = true,
            Err(e) => last = format!("{relay}: {e}"),
        }
    }
    if none {
        Ok(None)
    } else {
        Err(last)
    }
}

// ── the person_revoke registry (4.2, 6.6) ────────────────────────────────────────────────────────────────────────

/// Each org's active `person_revoke` entries, as the console (or a connector) last published them.
static REVOKES: LazyLock<RwLock<HashMap<String, Vec<ConsoleEntry>>>> = LazyLock::new(Default::default);

/// Publish the org's active console journal entries (only `person_revoke` is kept), after every append, fold or load.
pub fn publish_revokes(org: &str, active: &[ConsoleEntry]) {
    let list: Vec<ConsoleEntry> = active.iter().filter(|e| e.action == "person_revoke").cloned().collect();
    let mut all = REVOKES.write();
    if list.is_empty() {
        all.remove(org);
    } else {
        all.insert(org.to_string(), list);
    }
}

/// 6.6 step 5: an active `person_revoke` covers (`client` or `*`, `principal`) in `org`.
pub fn person_revoked_now(org: &str, client: &str, principal: &str) -> bool {
    REVOKES.read().get(org).is_some_and(|l| cj::person_revoked(l, client, principal))
}

// ── what the issuer needs of the console ─────────────────────────────────────────────────────────────────────────

/// The console as the delegated grants and the Authorize pipeline see it (the fleet console in production, a fake in
/// tests).
pub trait DelegatedHost {
    /// 4.3: `api-subject` (`request` from `api_subject::subject_request`) to a connected relay of the org; Err when
    /// none is connected or answered.
    fn api_subject(&self, org: &str, request: &Value) -> Result<Value, String>;
    /// The org Meet CA SSO service certificates and org policies are issued under, whenever the CA is usable, with its
    /// CRL when it has signed one.
    fn root(&self) -> Option<Root>;
    /// The org's registry entries from the newest root-verified signer policy the console holds.
    fn providers(&self, org: &str) -> Vec<IdentityProvider>;
    /// 6.1, 6.4: `api-org-policy {org}` to the connected relays of the org in turn, each answer (`org_policy_answer`)
    /// verified under `root` before it is taken (`first_verified_policy`); Ok(None) when the relays hold no policy, Err
    /// when none is connected or none answered with one that verifies.
    fn org_policy(&self, org: &str, root: &Root, now: i64) -> Result<Option<Obj>, String>;
    /// 6.1 last paragraph: the role (`admin`, `user-manager`, `viewer`) of the active console person with this email.
    fn console_role(&self, email: &str) -> Option<String>;
    /// The org's active console journal entries.
    fn console_active(&self, org: &str) -> Vec<ConsoleEntry>;
    /// The public URL of the org's SSO service for `provider` (6.5 step 2); None when not configured.
    fn sso_url(&self, org: &str, provider: &str) -> Option<String>;
    /// Append an entry to the org's console audit chain, durable before Ok.
    fn audit(&self, org: &str, entry: Value) -> Result<(), String>;
    /// 6.3 (reach R0): queue the console mail `fleet.mail.delegation` (`console_mail`) to the person `to` with
    /// `args`; true once the mailer took it (mail on, the address and the words mailable).
    fn mail_notice(&self, to: &str, args: &[(&str, String)]) -> bool;
    /// 6.4: gate G-EMA-OKTA-SUB is verified (`ema_open`); a test host passes it in as open.
    fn ema_gate_open(&self) -> bool {
        ema_open()
    }
}

/// The delegated part of an issuer: its host and state.
pub struct Delegated<'a> {
    pub host: &'a dyn DelegatedHost,
    pub state: &'a DelegatedState,
}

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// A person signed in through the SSO attestation (6.5 step 3).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct SignedIn {
    pub principal: String,
    pub auth_time: i64,
    pub ways: Vec<String>,
    pub groups: Vec<String>,
}

/// A waiting authorization request (6.5 step 2): `req` to it, single use per step.
#[derive(Clone, Debug, PartialEq)]
pub struct Waiting {
    pub org: String,
    /// As presented (`c_` id or CIMD URL).
    pub client: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub challenge: String,
    pub resource: String,
    pub scopes: Vec<String>,
    pub state: Option<String>,
    pub dpop_jkt: Option<String>,
    /// SHA-256 (hex) of the binding cookie.
    pub cookie: String,
    pub provider: String,
    pub at: i64,
    pub person: Option<SignedIn>,
    pub csrf: Option<String>,
}

/// An authorization code (6.5 step 5), kept under its SHA-256.
#[derive(Clone, Debug, PartialEq)]
pub struct Code {
    pub org: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub challenge: String,
    pub resource: String,
    pub scopes: Vec<String>,
    pub principal: String,
    pub provider: String,
    pub auth_time: i64,
    pub dpop_jkt: Option<String>,
    pub at: i64,
    pub used: bool,
    /// The family the first use made.
    pub family: Option<String>,
}

/// A refresh token family (6.5), kept hashed in the sealed consent store.
#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    /// 16 hex.
    pub id: String,
    pub client: String,
    pub person: String,
    pub provider: String,
    pub scopes: Vec<String>,
    pub resource: String,
    /// `jkt` or `x5t#S256`, and the value of the first token's binding.
    pub cnf: (String, String),
    pub consent_at: i64,
    /// `consent_at + consent_days` when made (a later `client_limit_delegation` can only shorten it).
    pub ends: i64,
    pub auth_time: i64,
    pub ways: Vec<String>,
    pub groups: Vec<String>,
    /// SHA-256 (hex) of the live refresh token.
    pub current: String,
    /// Hashes of rotated tokens (presenting one revokes the family).
    pub used: Vec<String>,
    pub ended: Option<String>,
}

impl Family {
    fn to_json(&self) -> Value {
        json!({"id": self.id, "client": self.client, "person": self.person, "provider": self.provider, "scopes": self.scopes, "resource": self.resource,
               "cnf": [self.cnf.0, self.cnf.1], "consent_at": self.consent_at, "ends": self.ends, "auth_time": self.auth_time, "ways": self.ways,
               "groups": self.groups, "current": self.current, "used": self.used, "ended": self.ended})
    }

    fn from_json(v: &Value) -> Option<Family> {
        let t = |k: &str| s(v, k).map(str::to_string);
        let i = |k: &str| v.get(k).and_then(Value::as_i64);
        let cnf = strings(v.get("cnf"));
        Some(Family {
            id: t("id")?,
            client: t("client")?,
            person: t("person")?,
            provider: t("provider")?,
            scopes: strings(v.get("scopes")),
            resource: t("resource")?,
            cnf: (cnf.first()?.clone(), cnf.get(1)?.clone()),
            consent_at: i("consent_at")?,
            ends: i("ends")?,
            auth_time: i("auth_time")?,
            ways: strings(v.get("ways")),
            groups: strings(v.get("groups")),
            current: t("current")?,
            used: strings(v.get("used")),
            ended: t("ended"),
        })
    }

    /// The family's end now: `consent_at` plus the effective `consent_days`, never past `ends`.
    pub fn end_at(&self, consent_days: i64) -> i64 {
        self.ends.min(self.consent_at.saturating_add(consent_days.saturating_mul(DAY)))
    }
}

/// What presenting a refresh token did (`DelegatedState::redeem_refresh`).
#[derive(Clone, Debug, PartialEq)]
pub enum Redeemed {
    /// The token is the live family's current one; with `Some(next)` the family rotated to `next`.
    Live(Family, Option<String>),
    /// A rotated token of the client's family: the family is now ended (`reuse`); the flag is whether this use ended it.
    Reused(Family, bool),
    Unknown,
}

/// A person's delegated tokens of one client and grant (R5-6, 14.1): the first and the last issuance within
/// `USE_WINDOW`, and the ways and groups of the last.
#[derive(Clone, Debug, PartialEq)]
struct Track {
    first: i64,
    at: i64,
    ways: Vec<String>,
    groups: Vec<String>,
}

/// 14.1: one person's use of a client's delegated grant in the last 24 hours, or a live refresh family of it
/// (`ends` its end; a family without a token in that window is listed with grant `authorization_code` and its consent
/// time as first and last use).
#[derive(Clone, Debug, PartialEq)]
pub struct Use {
    pub client: String,
    pub person: String,
    /// `jwt_bearer`, `authorization_code` or `refresh_token`.
    pub grant: String,
    pub first: i64,
    pub last: i64,
    pub ends: Option<i64>,
}

/// What a code's first use found.
#[derive(Clone, Debug, PartialEq)]
pub enum Taken {
    Fresh(Code),
    /// Used before: the family its first use made.
    Used(Option<String>),
    Unknown,
}

/// The console's delegated state: waiting requests, codes, verified person records (60 s), recent issuances, the
/// ID-JAG `jti` cache, and the refresh families of each org (sealed `api-consent/<org>.json`, its key the sealed value
/// `api-consent-<org>`).
pub struct DelegatedState {
    dir: Option<PathBuf>,
    vault: Arc<dyn VaultLock>,
    waiting: Mutex<HashMap<String, Waiting>>,
    codes: Mutex<HashMap<String, Code>>,
    records: Mutex<HashMap<String, (PersonRecord, i64)>>,
    /// Each org's last verified policy and when it was verified (reused for issuance at most `POLICY_CACHE`; offline
    /// validation reads it while it has not expired, `verified_policy`).
    policies: Mutex<HashMap<String, (Obj, i64)>>,
    /// (org, client, person, grant) -> its uses in the last `USE_WINDOW`.
    issued: Mutex<HashMap<(String, String, String, String), Track>>,
    families: Mutex<HashMap<String, Vec<Family>>>,
    /// 6.3 (reach R0): per org, the "<client> <person>" pairs whose delegation notice the mailer took (sealed
    /// `api-consent/<org>.notices.json`, read on first use).
    notified: Mutex<HashMap<String, BTreeSet<String>>>,
    pub(crate) jtis: Mutex<JtiCache>,
}

fn consent_name(org: &str) -> String {
    format!("{CONSENT_DIR}/{org}.json")
}

fn notices_name(org: &str) -> String {
    format!("{CONSENT_DIR}/{org}.notices.json")
}

impl DelegatedState {
    /// `dir` is the console's state folder (None: memory only).
    pub fn new(dir: Option<&Path>, vault: Arc<dyn VaultLock>) -> DelegatedState {
        DelegatedState {
            dir: dir.map(Path::to_path_buf),
            vault,
            waiting: Mutex::default(),
            codes: Mutex::default(),
            records: Mutex::default(),
            policies: Mutex::default(),
            issued: Mutex::default(),
            families: Mutex::default(),
            notified: Mutex::default(),
            jtis: Mutex::new(JtiCache::new(JAG_JTI_WINDOW)),
        }
    }

    // waiting requests

    fn put_waiting(&self, req: &str, w: Waiting, now: i64) -> Result<(), Fail> {
        let mut m = self.waiting.lock();
        m.retain(|_, w| w.at + REQUEST_LIFE > now);
        if m.len() >= HELD_MAX {
            return fail("abuse", "Too many sign-ins are waiting; try again later.");
        }
        m.insert(req.to_string(), w);
        Ok(())
    }

    fn get_waiting(&self, req: &str, now: i64) -> Option<Waiting> {
        self.waiting.lock().get(req).filter(|w| w.at + REQUEST_LIFE > now).cloned()
    }

    fn take_waiting(&self, req: &str) -> Option<Waiting> {
        self.waiting.lock().remove(req)
    }

    // codes

    fn put_code(&self, hash: String, c: Code, now: i64) -> Result<(), Fail> {
        let mut m = self.codes.lock();
        m.retain(|_, c| c.at + CODE_LIFE * 10 > now);
        if m.len() >= HELD_MAX {
            return fail("abuse", "Too many codes are waiting; try again later.");
        }
        m.insert(hash, c);
        Ok(())
    }

    /// The code's first use takes it (single use); a later use answers the family the first made.
    pub fn take_code(&self, hash: &str) -> Taken {
        let mut m = self.codes.lock();
        match m.get_mut(hash) {
            None => Taken::Unknown,
            Some(c) if c.used => Taken::Used(c.family.clone()),
            Some(c) => {
                c.used = true;
                Taken::Fresh(c.clone())
            }
        }
    }

    fn code_family(&self, hash: &str, family: &str) {
        if let Some(c) = self.codes.lock().get_mut(hash) {
            c.family = Some(family.to_string());
        }
    }

    // person records

    fn cached(&self, key: &str, now: i64) -> Option<PersonRecord> {
        self.records.lock().get(key).filter(|(r, at)| now - at < RECORD_CACHE && r.stale_at > now).map(|(r, _)| r.clone())
    }

    fn cache(&self, key: String, r: PersonRecord, now: i64) {
        let mut m = self.records.lock();
        m.retain(|_, (_, at)| now - *at < RECORD_CACHE);
        if m.len() < HELD_MAX {
            m.insert(key, (r, now));
        }
    }

    // the org policy (6.6)

    /// The org's last verified policy (`Delegated::policy`) while it has not expired: what the console's offline
    /// validation checks a delegated token's `sub` against (`api_token::validate_access_token`).
    pub fn verified_policy(&self, org: &str, now: i64) -> Option<Obj> {
        self.policies.lock().get(org).filter(|(p, _)| !op::expired(p, now as f64)).map(|(p, _)| p.clone())
    }

    // recent issuances (R5-6)

    /// The tracker key of (org, client, person, grant), its last use now: an existing key is refreshed, a new one is
    /// inserted with no ways yet. Err (`journal`, `TRACK_FULL`) when the tracker holds `HELD_MAX` keys used within 24
    /// hours and this is a new one.
    fn slot<'a>(m: &'a mut HashMap<(String, String, String, String), Track>, org: &str, client: &str, person: &str, grant: &str, now: i64) -> Result<&'a mut Track, Fail> {
        let key = (org.to_string(), client.to_string(), person.to_string(), grant.to_string());
        if !m.contains_key(&key) {
            if m.len() >= HELD_MAX {
                m.retain(|_, t| now - t.at < USE_WINDOW);
            }
            if m.len() >= HELD_MAX {
                return fail("journal", TRACK_FULL);
            }
            m.insert(key.clone(), Track { first: now, at: now, ways: Vec::new(), groups: Vec::new() });
        }
        let t = m.get_mut(&key).expect("the key just held");
        if now - t.at >= USE_WINDOW {
            t.first = now;
        }
        t.at = now;
        Ok(t)
    }

    /// R5-6: reserve the tracker key of a delegated grant before any refresh family is made or rotated and before the
    /// token is minted (`code_grant`, `refresh_grant`, `issue_delegated`). Err (`journal`; the grant is refused 503
    /// `temporarily_unavailable` with `Retry-After`, `track_refusal`) when the tracker is full and this key is new, so
    /// no token is ever issued untracked and a refused grant changes no family.
    pub fn reserve_track(&self, org: &str, client: &str, person: &str, grant: &str, now: i64) -> Result<(), Fail> {
        Self::slot(&mut self.issued.lock(), org, client, person, grant, now).map(|_| ())
    }

    /// Remember a delegated token of `client` for `person` by `grant` (`jwt_bearer`, `authorization_code` or
    /// `refresh_token`) through `ways`: its first and last use within 24 hours (14.1), the ways and groups of the last
    /// (R5-6). Called before the token is minted; after `reserve_track` it never fails.
    #[allow(clippy::too_many_arguments)]
    pub fn track(&self, org: &str, client: &str, person: &str, grant: &str, ways: &[String], groups: &[String], now: i64) -> Result<(), Fail> {
        let mut m = self.issued.lock();
        let t = Self::slot(&mut m, org, client, person, grant, now)?;
        t.ways = ways.to_vec();
        t.groups = groups.to_vec();
        Ok(())
    }

    /// 14.1: each person's use of the org's delegated grants in the last 24 hours (of `client` only, when given), with
    /// the end of their live refresh families of that client (a family without such a use is listed on its own), the
    /// newest last use first.
    pub fn uses(&self, org: &str, client: Option<&str>, now: i64) -> Result<Vec<Use>, Fail> {
        let mut out: Vec<Use> = {
            let m = self.issued.lock();
            m.iter()
                .filter(|((o, c, _, _), t)| o == org && client.is_none_or(|x| x == c) && now - t.at < USE_WINDOW)
                .map(|((_, c, p, g), t)| Use { client: c.clone(), person: p.clone(), grant: g.clone(), first: t.first, last: t.at, ends: None })
                .collect()
        };
        for f in self.live_families(org, now)? {
            if client.is_some_and(|x| x != f.client) {
                continue;
            }
            let mut held = false;
            for u in out.iter_mut().filter(|u| u.client == f.client && u.person == f.person && matches!(u.grant.as_str(), GRANT_CODE | GRANT_REFRESH)) {
                u.ends = Some(u.ends.map_or(f.ends, |e| e.max(f.ends)));
                held = true;
            }
            if !held {
                out.push(Use { client: f.client.clone(), person: f.person.clone(), grant: GRANT_CODE.to_string(), first: f.consent_at, last: f.consent_at, ends: Some(f.ends) });
            }
        }
        out.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| (&a.client, &a.person, &a.grant).cmp(&(&b.client, &b.person, &b.grant))));
        Ok(out)
    }

    /// R5-6: the principals with a live refresh family of `client`, or a delegated token of it in the last 10
    /// minutes, through `way` (`group:<id>`, `principal:<p>` or `idp:<id>`), each with the groups of their newest
    /// record: the newest tracked issuance of the client to them (any grant, within 24 hours), else their newest live
    /// family of it. Sorted by principal.
    pub fn through(&self, org: &str, client: &str, way: &str, now: i64) -> Result<Vec<(String, Vec<String>)>, Fail> {
        let families: Vec<Family> = self.live_families(org, now)?.into_iter().filter(|f| f.client == client).collect();
        let m = self.issued.lock();
        let tracks: Vec<(&String, &Track)> = m.iter().filter(|((o, c, _, _), t)| o == org && c == client && now - t.at < USE_WINDOW).map(|((_, _, p, _), t)| (p, t)).collect();
        let mut people: Vec<String> = tracks.iter().filter(|(_, t)| now - t.at < TRACK_WINDOW && t.ways.iter().any(|w| w == way)).map(|(p, _)| (*p).clone()).collect();
        people.extend(families.iter().filter(|f| f.ways.iter().any(|w| w == way)).map(|f| f.person.clone()));
        people.sort();
        people.dedup();
        let newest = |p: &str| -> Vec<String> {
            let tracked = tracks.iter().filter(|(x, _)| x.as_str() == p).max_by_key(|(_, t)| t.at).map(|(_, t)| t.groups.clone());
            tracked.or_else(|| families.iter().filter(|f| f.person == p).max_by_key(|f| f.consent_at).map(|f| f.groups.clone())).unwrap_or_default()
        };
        Ok(people.into_iter().map(|p| {
            let groups = newest(&p);
            (p, groups)
        }).collect())
    }

    // refresh families

    fn key(&self, org: &str) -> Result<[u8; 32], Fail> {
        let name = format!("api-consent-{org}");
        let unusable = || Fail::new("journal", "The consent store's key cannot be used.");
        vault_do(&*self.vault, |v| {
            if let Some(k) = v.get(&name) {
                return <[u8; 32]>::try_from(k.as_slice()).map_err(|_| unusable());
            }
            let k = crate::console_auth::random(32).ok_or_else(unusable)?;
            v.put(&name, &k).map_err(|_| unusable())?;
            <[u8; 32]>::try_from(k.as_slice()).map_err(|_| unusable())
        })
    }

    /// The plain JSON of one of the org's sealed files (`name` its path under the state folder and its AAD): None when
    /// there is no state folder or no file; a file that does not open counts as none, with the security line
    /// `api.consent.unreadable`.
    fn open_sealed(&self, org: &str, name: &str) -> Option<Value> {
        let dir = self.dir.as_ref()?;
        let path = dir.join(name);
        let bytes = std::fs::read(&path).ok()?;
        let opened = std::str::from_utf8(&bytes)
            .ok()
            .and_then(parse_json)
            .and_then(|v| v.get("sealed").and_then(Value::as_str).and_then(unb64u))
            .and_then(|sealed| self.key(org).ok().and_then(|k| crate::console_seal::open_state(&k, name.as_bytes(), &sealed)))
            .and_then(|plain| String::from_utf8(plain).ok())
            .and_then(|t| parse_json(&t));
        if opened.is_none() {
            let f = crate::log::Fields::new().with("org", org).with("file", path.display().to_string());
            crate::console_meet::logger().security("api.consent.unreadable", &f, crate::log::Level::Error);
        }
        opened
    }

    /// Seal `plain` into the org's file `name` (written durably); nothing without a state folder.
    fn write_sealed(&self, org: &str, name: &str, plain: &Value) -> Result<(), Fail> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let unwritable = |e: String| Fail::new("journal", format!("The consent store cannot be written ({e})."));
        let key = self.key(org)?;
        let sealed = crate::console_seal::seal_state(&key, name.as_bytes(), stringify(plain).as_bytes()).map_err(unwritable)?;
        let folder = dir.join(CONSENT_DIR);
        crate::store::make_dir(&folder).map_err(|e| unwritable(e.to_string()))?;
        let body = stringify(&json!({"v": 1, "sealed": b64u(&sealed)}));
        crate::fleet_local::write_durable(&dir.join(name), body.as_bytes()).map_err(unwritable)
    }

    /// The org's families from its sealed file; a file that does not open counts as none (every refresh token of it
    /// is then unknown, `consent`).
    fn load(&self, org: &str) -> Vec<Family> {
        self.open_sealed(org, &consent_name(org)).map_or_else(Vec::new, |v| v.get("families").and_then(Value::as_array).into_iter().flatten().filter_map(Family::from_json).collect())
    }

    fn save(&self, org: &str, families: &[Family]) -> Result<(), Fail> {
        self.write_sealed(org, &consent_name(org), &json!({"v": 1, "org": org, "families": families.iter().map(Family::to_json).collect::<Vec<_>>()}))
    }

    // delegation notices (6.3, reach R0)

    /// 6.3 for reach R0: the first delegated token of `client` (its `c_` id) for `person` sends the person the
    /// console's notice through `mail` (true once the mailer took it). The pair is marked (sealed, durable) only after
    /// the mailer took the mail; one it did not take is tried again with the next token. True when this call mailed.
    pub fn notify_once(&self, org: &str, client: &str, person: &str, mail: impl FnOnce() -> bool) -> bool {
        let key = format!("{client} {person}");
        let mut all = self.notified.lock();
        if !all.contains_key(org) {
            let marks: BTreeSet<String> = self.open_sealed(org, &notices_name(org)).map(|v| strings(v.get("notified")).into_iter().collect()).unwrap_or_default();
            all.insert(org.to_string(), marks);
        }
        let held = all.get(org).cloned().unwrap_or_default();
        if held.contains(&key) || !mail() {
            return false;
        }
        let mut next = held;
        next.insert(key);
        // the mail is queued: a mark that cannot be written is kept in memory (no second mail from this process)
        if let Err(f) = self.write_sealed(org, &notices_name(org), &json!({"v": 1, "org": org, "notified": next})) {
            let fields = crate::log::Fields::new().with("org", org).with("why", f.why.clone());
            crate::console_meet::logger().security("api.notice.unsaved", &fields, crate::log::Level::Error);
        }
        all.insert(org.to_string(), next);
        true
    }

    /// Run `f` on the org's families (ended past `ends` dropped first); when it reports a change, the store is written
    /// durably before the change is kept.
    fn with_families<R>(&self, org: &str, now: i64, f: impl FnOnce(&mut Vec<Family>) -> Result<(R, bool), Fail>) -> Result<R, Fail> {
        let mut all = self.families.lock();
        if !all.contains_key(org) {
            let loaded = self.load(org);
            all.insert(org.to_string(), loaded);
        }
        let mut next = all.get(org).cloned().unwrap_or_default();
        let before = next.len();
        next.retain(|f| f.ends > now);
        let (r, changed) = f(&mut next)?;
        if changed || next.len() != before {
            self.save(org, &next)?;
        }
        all.insert(org.to_string(), next);
        Ok(r)
    }

    /// A new family with its first refresh token (`lrt_` + 32 random bytes), durable before Ok.
    pub fn new_family(&self, org: &str, mut family: Family, now: i64) -> Result<String, Fail> {
        let token = format!("{REFRESH_PREFIX}{}", b64u(&random(32)?));
        family.current = token_hash(&token);
        self.with_families(org, now, |all| {
            all.push(family);
            Ok(((), true))
        })?;
        Ok(token)
    }

    /// Present `client`'s refresh token in one transaction of the org's families: the lookup, the current-hash
    /// comparison, the replay handling (a used token ends its family, `reuse`, durable before Ok) and, when `rotate`
    /// is given, the rotation. `rotate` runs on the family before the rotation is kept (the `api.refresh` audit line,
    /// 9.4); its error keeps nothing. Two uses of one token can therefore never both rotate: the second finds the
    /// token used and ends the family.
    pub fn redeem_refresh(&self, org: &str, token: &str, client: &str, now: i64, rotate: Option<&dyn Fn(&Family) -> Result<(), Fail>>) -> Result<Redeemed, Fail> {
        let h = token_hash(token);
        let next = match rotate {
            Some(_) => Some(format!("{REFRESH_PREFIX}{}", b64u(&random(32)?))),
            None => None,
        };
        self.with_families(org, now, |all| {
            if let Some(f) = all.iter_mut().find(|f| same(&f.current, &h)) {
                if f.ended.is_some() || f.client != client {
                    return Ok((Redeemed::Unknown, false));
                }
                let (Some(hook), Some(token)) = (rotate, next) else { return Ok((Redeemed::Live(f.clone(), None), false)) };
                hook(f)?;
                let was = f.clone();
                let old = std::mem::replace(&mut f.current, token_hash(&token));
                f.used.push(old);
                if f.used.len() > USED_MAX {
                    f.used.remove(0);
                }
                return Ok((Redeemed::Live(was, Some(token)), true));
            }
            if let Some(f) = all.iter_mut().find(|f| f.used.iter().any(|u| same(u, &h))) {
                if f.client != client {
                    return Ok((Redeemed::Unknown, false));
                }
                let ending = f.ended.is_none();
                if ending {
                    f.ended = Some("reuse".to_string());
                }
                return Ok((Redeemed::Reused(f.clone(), ending), ending));
            }
            Ok((Redeemed::Unknown, false))
        })
    }

    /// End every live family `pred` selects (`why` kept with it), durable before Ok; Ok is how many ended.
    pub fn end_families(&self, org: &str, now: i64, pred: &dyn Fn(&Family) -> bool, why: &str) -> Result<usize, Fail> {
        self.with_families(org, now, |all| {
            let mut n = 0;
            for f in all.iter_mut().filter(|f| f.ended.is_none() && pred(f)) {
                f.ended = Some(why.to_string());
                n += 1;
            }
            Ok((n, n > 0))
        })
    }

    pub fn end_family(&self, org: &str, family: &str, why: &str, now: i64) -> Result<(), Fail> {
        self.end_families(org, now, &|f| f.id == family, why).map(|_| ())
    }

    /// The org's families not ended.
    pub fn live_families(&self, org: &str, now: i64) -> Result<Vec<Family>, Fail> {
        self.with_families(org, now, |all| Ok((all.iter().filter(|f| f.ended.is_none()).cloned().collect(), false)))
    }
}

// ── person records (4.3, R5-1) ───────────────────────────────────────────────────────────────────────────────────

impl Delegated<'_> {
    /// 4.3: the SSO-signed person record for `ask` under the registry entry: `api-subject` to a connected relay (none:
    /// `subject-unreachable`), verified by `api_subject::verify_answer` and audited as `api.person.record` with its
    /// result (`verified`, `missing`, `bad-signature`, `stale`) before it is used; a record that does not verify is
    /// `person`. Verified records are reused at most 60 s.
    pub fn person(&self, org: &str, entry: &IdentityProvider, ask: Ask, now: i64) -> Result<PersonRecord, Fail> {
        let key = match ask {
            Ask::Sub(x) => format!("{org}\n{}\nsub\n{x}", entry.id),
            Ask::Principal(x) => format!("{org}\n{}\nprincipal\n{x}", entry.id),
        };
        if let Some(r) = self.state.cached(&key, now) {
            return Ok(r);
        }
        let request = subject::subject_request(org, &entry.id, &ask);
        let answer = self.host.api_subject(org, &request).map_err(|_| Fail::new("subject-unreachable", "No relay of the organization could answer for the person now; try again later."))?;
        let verdict = match self.host.root() {
            Some(root) if root.revoked(answer.get("cert_pem").and_then(Value::as_str)) => Err("bad-signature"),
            Some(root) => subject::verify_answer(&answer, &root.cert, entry, org, &ask, now),
            None => Err("bad-signature"),
        };
        let mut e = json!({"action": "api.person.record", "provider": entry.id, "result": verdict.as_ref().map_or_else(|w| *w, |_| "verified")});
        match (&verdict, ask) {
            (Ok(r), _) => e["person"] = json!(r.principal),
            (Err(_), Ask::Principal(p)) => e["person"] = json!(p),
            (Err(_), Ask::Sub(_)) => {}
        }
        self.host.audit(org, e).map_err(|_| Fail::new("audit-unavailable", "The audit log cannot record this request now; try again later."))?;
        match verdict {
            Ok(r) => {
                self.state.cache(key, r.clone(), now);
                Ok(r)
            }
            Err(word) => fail("person", format!("There is no valid SSO-signed record for that person ({word}).")),
        }
    }

    fn provider(&self, org: &str, id: &str) -> Option<IdentityProvider> {
        self.host.providers(org).into_iter().find(|p| p.org == org && p.id == id)
    }

    /// 6.1, 6.4: the org's current policy: `api-org-policy` to the connected relays, each answer verified under the
    /// Meet CA root (`first_verified_policy`, a relay whose answer does not verify passes to the next), reused at most
    /// 60 s and kept as the org's last verified policy (`DelegatedState::verified_policy`). No usable root, or no relay
    /// answering with a policy that verifies, is `subject-unreachable`; no policy is `person` (nobody may delegate in
    /// an org without one), and drops the kept one.
    pub fn policy(&self, org: &str, now: i64) -> Result<Obj, Fail> {
        if let Some((p, _)) = self.state.policies.lock().get(org).filter(|(_, at)| now - at < POLICY_CACHE && *at <= now) {
            return Ok(p.clone());
        }
        let unreachable = || Fail::new("subject-unreachable", "The organization's policy cannot be read now; try again later.");
        let root = self.host.root().ok_or_else(unreachable)?;
        match self.host.org_policy(org, &root, now) {
            Ok(Some(p)) => {
                self.state.policies.lock().insert(org.to_string(), (p.clone(), now));
                Ok(p)
            }
            Ok(None) => {
                self.state.policies.lock().remove(org);
                fail("person", "The organization has no signed policy, so nobody may delegate there.")
            }
            Err(_) => Err(unreachable()),
        }
    }

    /// 6.1 at an issuance: the verified org policy, then `ways_under` it.
    fn ways(&self, org: &str, client: &Obj, id: &str, record: &PersonRecord, console: &[ConsoleEntry], now: i64) -> Result<(Obj, Vec<String>), Fail> {
        let policy = self.policy(org, now)?;
        let ways = ways_under(&policy, client, id, record, console)?;
        Ok((policy, ways))
    }
}

// ── the SSO attestation (6.5 steps 2 and 3, R5-2) ────────────────────────────────────────────────────────────────

/// A verified SSO `lucid-meet-sso-api-v1` attestation.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Attestation {
    pub org: String,
    pub provider: String,
    pub iss: String,
    pub sub: String,
    pub principal: String,
    pub auth_time: i64,
    pub methods: Vec<String>,
    pub req: String,
    pub return_url: String,
    pub exp: i64,
}

const ATT_KEYS: [&str; 10] = ["org", "provider", "iss", "sub", "principal", "auth_time", "methods", "req", "return", "exp"];

/// `lp("lucid-meet-sso-api-v1", canonical_json(att))`.
pub fn att_bytes(att: &Value) -> Option<Vec<u8>> {
    op::canonical_json(att).ok().map(|j| op::lp(&[ATT_LABEL.as_bytes(), &j]))
}

/// The `req` an `att` form value names, before it is verified (to find the waiting request and its cookie).
pub fn att_req(att: &str) -> Option<String> {
    let wire = unb64u(att).and_then(|b| String::from_utf8(b).ok()).and_then(|t| parse_json(&t))?;
    wire.get("att").and_then(|a| s(a, "req")).map(str::to_string)
}

/// The certificate PEM an `att` form value carries, before it is verified (to check it against the root's CRL).
fn att_cert(att: &str) -> Option<String> {
    let wire = unb64u(att).and_then(|b| String::from_utf8(b).ok()).and_then(|t| parse_json(&t))?;
    s(&wire, "cert_pem").map(str::to_string)
}

/// 6.5 step 3: the `att` form value (base64url of `{att, sig, cert_pem}`): a certificate issued directly by `root`,
/// kind `sso`, P-256, naming the org, valid now, whose serial is the registry entry's `sso_serial`; the signature over
/// `att_bytes(att)`; `org`, `provider` (the entry's id), `iss` (the entry's), `return` (this console's own
/// `I/oauth/sso-return`), `req` (the waiting request) all equal; `exp` in the future and at most 180 s ahead. Every
/// refusal is `assertion`.
pub fn verify_attestation(att: &str, root: &Cert, entry: &IdentityProvider, org: &str, return_url: &str, req: &str, now: i64) -> Result<Attestation, Fail> {
    let bad = |m: &str| Fail::new("assertion", format!("The sign-in attestation is not valid: {m}."));
    let wire = unb64u(att).and_then(|b| String::from_utf8(b).ok()).and_then(|t| parse_json(&t)).ok_or_else(|| bad("it does not read"))?;
    let w = wire.as_object().filter(|o| o.len() == 3 && ["att", "sig", "cert_pem"].iter().all(|k| o.contains_key(*k))).ok_or_else(|| bad("it is not {att, sig, cert_pem}"))?;
    let a = w["att"].as_object().filter(|o| o.len() == ATT_KEYS.len() && ATT_KEYS.iter().all(|k| o.contains_key(*k))).ok_or_else(|| bad("its fields are not the attestation's"))?;
    let cert = w["cert_pem"].as_str().and_then(Cert::from_pem).ok_or_else(|| bad("its certificate does not read"))?;
    let (kind, orgs) = crate::meet_hub::pc::cert_kind(&cert.names.uris).map_err(|_| bad("its certificate is not an SSO certificate"))?;
    let cert_ok = cert.issued_directly_by_root(root)
        && kind == "sso"
        && crate::fleet_x509::is_p256_spki(&cert.spki)
        && cert.not_before <= now
        && now <= cert.not_after
        && orgs.iter().any(|o| o == org)
        && !entry.sso_serial.is_empty()
        && crate::meet::serial(&cert.serial) == crate::meet::serial(&entry.sso_serial);
    if !cert_ok {
        return Err(bad("it is not signed by the registered sign-in service"));
    }
    let sig = w["sig"].as_str().and_then(crate::meet_json::b64_strict).ok_or_else(|| bad("its signature does not read"))?;
    let data = att_bytes(&w["att"]).ok_or_else(|| bad("it cannot be encoded"))?;
    if !ecdsa_sha256_verified(&cert.spki, &data, &sig) {
        return Err(bad("its signature does not verify"));
    }
    let t = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let n = |k: &str| a.get(k).and_then(Value::as_i64);
    let (Some(auth_time), Some(exp)) = (n("auth_time"), n("exp")) else { return Err(bad("auth_time and exp must be times")) };
    let methods = a.get("methods").and_then(Value::as_array).filter(|m| m.iter().all(Value::is_string)).ok_or_else(|| bad("methods must be a list of strings"))?;
    let out = Attestation {
        org: t("org"),
        provider: t("provider"),
        iss: t("iss"),
        sub: t("sub"),
        principal: t("principal"),
        auth_time,
        methods: methods.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        req: t("req"),
        return_url: t("return"),
        exp,
    };
    if out.org != org || out.provider != entry.id || out.iss != entry.iss {
        return Err(bad("it names another organization or identity provider"));
    }
    if out.return_url != return_url {
        return Err(bad("it was made for another console"));
    }
    if out.req != req {
        return Err(bad("it is for another sign-in request"));
    }
    if exp <= now || exp > now + ATT_SPAN_MAX {
        return Err(bad("it has expired"));
    }
    if out.sub.is_empty() || op::split_principal(&out.principal).is_err() {
        return Err(bad("it names no person"));
    }
    Ok(out)
}

// ── the delegated grants (6.2, 6.4, 6.5) ─────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthMethod {
    Mtls,
    Jwt,
    None,
}

impl AuthMethod {
    fn name(self) -> &'static str {
        match self {
            AuthMethod::Mtls => "tls_client_auth",
            AuthMethod::Jwt => "private_key_jwt",
            AuthMethod::None => "none",
        }
    }
}

/// An authenticated delegated client.
struct DAuth<'a> {
    named: Named<'a>,
    method: AuthMethod,
    /// The end of the key credential used (5.3).
    key_end: Option<i64>,
    /// `x5t#S256` and `notAfter` of a certificate that authenticated the client.
    cert: Option<(String, i64)>,
}

/// 6.2: exactly one of `tls_client_auth`, `private_key_jwt` (registered keys, or the CIMD document's) or none (a public
/// client); never a client secret or HTTP Basic.
fn d_authenticate<'a>(ctx: &IssueCtx<'a>, http: &TokenHttp, form: &HashMap<String, String>, who: &mut Option<String>) -> Result<DAuth<'a>, Refusal> {
    let f = |k: &str| form.get(k).map(String::as_str);
    if http.authorization.is_some() || form.contains_key("client_secret") {
        return Err(no("client-auth", "Delegated grants take tls_client_auth, private_key_jwt or none, never a client secret."));
    }
    let assertion = f("client_assertion");
    match (assertion, f("client_assertion_type")) {
        (Some(_), Some(t)) if t != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" => return Err(no("client-auth", "That client_assertion_type is not supported.")),
        (Some(_), None) | (None, Some(_)) => return Err(no("request", "client_assertion and client_assertion_type go together.")),
        _ => {}
    }
    let asserted = assertion.and_then(tok::parse_jws).and_then(|j| j.claims.get("sub").and_then(Value::as_str).map(str::to_string));
    let presented = match (f("client_id"), asserted.as_deref()) {
        (Some(a), Some(b)) if a != b => return Err(no("client-auth", "The request names more than one client.")),
        (Some(a), _) => a.to_string(),
        (None, Some(b)) => b.to_string(),
        (None, None) => return Err(no("request", "The request names no client (client_id).")),
    };
    let named = named_client(ctx.store, ctx.org, &presented, ctx.fetch, ctx.now)?;
    *who = Some(named.id.clone());
    // revision 6 4.1: whatever grant it names
    issue::not_spokes_hub(named.client)?;
    if !is_delegated(named.client) {
        return Err(no("grant", "Only a delegated client uses this grant."));
    }
    let creds = tok::usable_credentials(named.client, ctx.store.active(ctx.org));
    let cert = http.client_cert.filter(|c| named.cimd.is_none() && c.authenticates(named.client, ctx.org, &creds));
    if let Some(c) = cert {
        if ctx.now > effective_end(c.not_after, &[ctx.store.grace_hours(ctx.org, "app", ctx.now)]) {
            return Err(no("expired", "The client certificate has expired."));
        }
    }
    let (method, key_end) = match (cert.is_some(), assertion) {
        (true, None) => (AuthMethod::Mtls, None),
        (false, Some(a)) => {
            let end = match &named.cimd {
                Some(doc) => cimd_assertion(ctx, a, &presented, doc, named.cimd_expires.unwrap_or(i64::MIN))?,
                None => issue::assertion_auth(ctx, a, &presented, &creds)?,
            };
            (AuthMethod::Jwt, Some(end))
        }
        (false, None) if named.public => (AuthMethod::None, named.cimd_expires),
        (false, None) => return Err(no("client-auth", "This client must authenticate (tls_client_auth or private_key_jwt).")),
        (true, Some(_)) => return Err(no("client-auth", "The request carries more than one client authentication.")),
    };
    let cert = cert.map(|c| (c.sha256_b64u.clone(), c.not_after));
    Ok(DAuth { named, method, key_end, cert })
}

/// 6.2 `private_key_jwt` with the CIMD document's keys (`jwks`, or its `jwks_uri` under 8.1); `iss` = `sub` = the URL.
fn cimd_assertion(ctx: &IssueCtx, assertion: &str, url: &str, doc: &Cimd, expires: i64) -> Result<i64, Refusal> {
    if doc.public {
        return Err(no("client-auth", "This client's metadata document names no key."));
    }
    let mut creds: Vec<Value> = doc.jwks.iter().filter_map(|k| Some(json!({"type": "private_key_jwt", "kid": s(k, "kid")?, "jwk": k, "expires": expires}))).collect();
    let mut fetched_keys = Vec::new();
    if let Some(u) = &doc.jwks_uri {
        creds.push(json!({"type": "private_key_jwt", "jwks_uri": u, "expires": expires}));
        fetched_keys = issue::keys_of(&issue::fetch_doc(ctx.fetch, u, doc.private_ok)?);
    }
    let refs: Vec<&Value> = creds.iter().collect();
    let fetched: Vec<(&str, &[Value])> = doc.jwks_uri.as_deref().map(|u| (u, fetched_keys.as_slice())).into_iter().collect();
    tok::verify_client_assertion(assertion, url, ctx.issuer, &refs, &fetched, ctx.now, &mut ctx.state.assertions.lock()).map_err(Refusal::from)
}

/// 6.1 Token pipeline for a delegated client: network, hours, `mtls_required`, issuance rate (standing is the caller's).
fn pipeline(ctx: &IssueCtx, http: &TokenHttp, auth: &DAuth) -> Result<(), Refusal> {
    let (client, id) = (auth.named.client, auth.named.id.as_str());
    let active = ctx.store.active(ctx.org);
    if !tok::source_allowed(client, active, id, http.source) {
        return Err(no("network", "This client may not ask from that address."));
    }
    if client.get("hours").is_some_and(|h| !issue::inside_hours(h, ctx.now)) {
        return Err(no("hours", "This client may not ask at this time."));
    }
    if client.get("mtls_required").and_then(Value::as_bool) == Some(true) && auth.method != AuthMethod::Mtls {
        return Err(no("mtls", "This client must authenticate with its certificate."));
    }
    let rate = |k: &str| tok::rate_of(client, active, id, k);
    ctx.state.issue_ok(ctx.org, id, usize::try_from(rate("per_minute_each")).unwrap_or(usize::MAX), rate("per_day_each"), ctx.now)
}

/// O1: every delegated token is bound: the authenticating certificate, else a DPoP proof (`dpop-required`).
fn binding(ctx: &IssueCtx, http: &TokenHttp, auth: &DAuth) -> Result<Cnf, Refusal> {
    if let Some((x5t, _)) = &auth.cert {
        return Ok(Cnf::X5t(x5t.clone()));
    }
    match http.dpop {
        Some(p) => Ok(Cnf::Jkt(tok::verify_dpop(p, "POST", ctx.token_endpoint, None, ctx.now, &mut ctx.state.dpop.lock(), &auth.named.id)?)),
        None => Err(no("dpop-required", "A delegated token request needs a DPoP proof or the client's certificate.")),
    }
}

fn cnf_pair(cnf: &Cnf) -> (String, String) {
    match cnf {
        Cnf::Jkt(j) => ("jkt".into(), j.clone()),
        Cnf::X5t(x) => ("x5t#S256".into(), x.clone()),
        Cnf::None => (String::new(), String::new()),
    }
}

/// The scopes of a delegated token: the client's current scopes (less journaled drops) within every list given, and
/// for reach R0 those the person's console role allows; none is `scope`.
fn scopes_for(ctx: &IssueCtx, d: &Delegated, client: &Obj, id: &str, lists: &[Option<&str>], person: &str) -> Result<Vec<String>, Refusal> {
    let active = ctx.store.active(ctx.org);
    let dropped: Vec<&str> = tok::client_entries(active, "client_drop_scope", id).map(|e| tok::target_field(e, "scope")).collect();
    let mut out: Vec<String> = tok::names(client, "scopes").filter(|x| !dropped.contains(x)).map(str::to_string).collect();
    for l in lists.iter().flatten() {
        let l: Vec<&str> = l.split(' ').filter(|x| !x.is_empty()).collect();
        out.retain(|x| l.contains(&x.as_str()));
    }
    if client.get("reach").and_then(Value::as_str) == Some("R0") {
        let role = d.host.console_role(person);
        out.retain(|x| role_allows(role.as_deref(), x));
    }
    out.sort();
    out.dedup();
    if out.is_empty() {
        return Err(no("scope", "No scope is left for this person and client."));
    }
    Ok(out)
}

/// What one delegated issuance carries.
struct Issue {
    person: String,
    grant: &'static str,
    idp: Option<String>,
    auth_time: i64,
    act: Value,
    aud: String,
    scopes: Vec<String>,
    cnf: Cnf,
    ways: Vec<String>,
    groups: Vec<String>,
    family_end: Option<i64>,
    /// (refresh token, family id) of the code and refresh grants.
    refresh: Option<(String, String)>,
}

/// R5-6: a full issuance tracker's refusal: `journal`, 503 `temporarily_unavailable`, `Retry-After: 60`.
fn track_refusal(f: Fail) -> Refusal {
    Refusal { retry: Some(TRACK_RETRY_S), ..no(f.code, f.why) }
}

/// 6.6: mint the delegated token (`exp` the minimum of `iat + 600`, the registration's and credential's effective
/// ends, the map's `expires` and the family's end), remember it for R5-6, and answer with the `api.delegated` event.
fn issue_delegated(ctx: &IssueCtx, d: &Delegated, http: &TokenHttp, auth: &DAuth, i: Issue) -> Result<Answer, Refusal> {
    let (client, id) = (auth.named.client, auth.named.id.as_str());
    let now = ctx.now;
    let pinned = ctx.store.get(ctx.org, "").ok_or_else(|| no("map-expired", issue::closed_why("map-expired")))?;
    let lifetime = Lifetime {
        iat: now,
        unbound: false,
        registration_end: client.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN),
        grace_hours: ctx.store.grace_hours(ctx.org, "app", now).unwrap_or(0),
        cert_end: auth.cert.as_ref().map(|c| c.1),
        key_end: auth.key_end,
        subject_exp: None,
        assertion_exp: None,
        map_expires: pinned.expires,
    };
    let exp = tok::token_exp(&lifetime).min(i.family_end.unwrap_or(i64::MAX));
    if exp <= now {
        return Err(no("expired", "A credential or the consent of this client ends now."));
    }
    let active = ctx.store.active(ctx.org);
    let current = client.get("ceiling").and_then(Value::as_str).and_then(tok::rank).unwrap_or(0);
    let lowered = tok::client_entries(active, "client_lower_ceiling", id).filter_map(|e| tok::rank(tok::target_field(e, "ceiling")));
    let ceiling = CEILINGS[lowered.fold(current, usize::min)];
    let reach = client.get("reach").and_then(Value::as_str).unwrap_or_default();
    let mut ways = i.ways.clone();
    if let Some(idp) = &i.idp {
        ways.push(format!("idp:{idp}"));
    }
    // R5-6: no delegated token is issued untracked (a later drop must find it); the code and refresh grants reserved
    // the key before their family changed, and a full tracker refuses a new key (503 `journal`)
    d.state.track(ctx.org, id, &i.person, i.grant, &ways, &i.groups, now).map_err(track_refusal)?;
    let dl = tok::Delegation { person: &i.person, grant: i.grant, idp: i.idp.as_deref(), auth_time: i.auth_time, act: &i.act };
    let minted = tok::mint_delegated_token(ctx.key, ctx.kid, ctx.issuer, &i.aud, id, ctx.org, &i.scopes, reach, ceiling, pinned.seq, &i.cnf, &dl, now, exp)?;
    // 6.3: the first token of this client for this person mails the person (reach R0; for R1 the connector posts
    // the CE-1 `dlgn` when the token reaches it)
    if reach == "R0" {
        let name = client.get("name").and_then(Value::as_str).unwrap_or(id);
        let args = [("client", name.to_string()), ("scopes", i.scopes.join(", ")), ("date and time", crate::license_reminders::when(now.saturating_mul(1000)))];
        d.state.notify_once(ctx.org, id, &i.person, || d.host.mail_notice(&i.person, &args));
    }
    let (token_type, cnf_kind) = match &i.cnf {
        Cnf::X5t(_) => ("Bearer", "x5t#S256"),
        _ => ("DPoP", "jkt"),
    };
    let scope = i.scopes.join(" ");
    let mut body = json!({"access_token": minted.token, "token_type": token_type, "expires_in": exp - now, "scope": scope});
    let mut event = json!({"org": ctx.org, "client": id, "person": i.person, "grant": i.grant, "scope": scope, "resource": i.aud, "aud": i.aud,
                           "jti": minted.jti, "exp": exp, "cnf": cnf_kind, "auth": auth.method.name(), "source": http.source.to_string(),
                           "map_seq": pinned.seq, "auth_time": i.auth_time});
    if let Some(idp) = &i.idp {
        event["idp"] = json!(idp);
    }
    // R5-21, flattened for the audit (its values are strings): `actor` the IdP actor's `sub`, `actor_profile` its
    // `sub_profile`
    if let Some(inner) = i.act.get("act") {
        if let Some(x) = s(inner, "sub") {
            event["actor"] = json!(x);
        }
        if let Some(x) = s(inner, "sub_profile") {
            event["actor_profile"] = json!(x);
        }
    }
    if let Some((token, family)) = i.refresh {
        body["refresh_token"] = json!(token);
        event["family"] = json!(family);
    }
    Ok(Answer { status: 200, body, headers: issue::no_store(), event: Some(("api.delegated", event)) })
}

/// `POST I/oauth/token` for `jwt-bearer`, `jwt-dpop`, `authorization_code` and `refresh_token` (6.2, 6.4, 6.5).
pub(crate) fn grant(ctx: &IssueCtx, http: &TokenHttp, form: &HashMap<String, String>, grant: &str, who: &mut Option<String>) -> Result<Answer, Refusal> {
    let Some(d) = ctx.delegated else { return Err(no("grant", "This issuer issues no delegated tokens.")) };
    if grant == GRANT_JWT_DPOP {
        return Err(no("grant", "The jwt-dpop grant is not supported; use jwt-bearer with client authentication."));
    }
    let done = if grant == GRANT_JWT_BEARER && !d.host.ema_gate_open() {
        Err(no("grant", "Enterprise-managed authorization (jwt-bearer) stays closed until gate G-EMA-OKTA-SUB is verified."))
    } else {
        d_authenticate(ctx, http, form, who).and_then(|auth| match grant {
            GRANT_JWT_BEARER => ema(ctx, d, http, form, auth),
            GRANT_CODE => code_grant(ctx, d, http, form, auth),
            _ => refresh_grant(ctx, d, http, form, auth),
        })
    };
    // r5 13.1: `lucid_api_delegated_tokens_total{grant, result}`
    let label = match grant {
        GRANT_JWT_BEARER => "jwt_bearer",
        GRANT_CODE => "authorization_code",
        _ => "refresh_token",
    };
    crate::api_catalog::counters::delegated_token(ctx.org, label, if done.is_ok() { "ok" } else { "refused" });
    done
}

/// The IdP's keys: its discovery (`<iss>/.well-known/openid-configuration`, else
/// `<iss>/.well-known/oauth-authorization-server`, naming `iss` as its issuer), then its `jwks_uri`, under 8.1.
fn idp_keys(ctx: &IssueCtx, iss: &str, private_ok: bool) -> Result<Vec<Value>, Refusal> {
    let base = iss.trim_end_matches('/');
    let mut last = no("fetch", "The IdP's discovery document could not be fetched.");
    for path in ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"] {
        match issue::fetch_doc(ctx.fetch, &format!("{base}{path}"), private_ok) {
            Ok(doc) => {
                let Some(uri) = s(&doc, "jwks_uri").filter(|_| s(&doc, "issuer") == Some(iss)) else {
                    last = no("assertion", "The IdP's discovery document names another issuer or no jwks_uri.");
                    continue;
                };
                return Ok(issue::keys_of(&issue::fetch_doc(ctx.fetch, uri, private_ok)?));
            }
            Err(r) => last = r,
        }
    }
    Err(last)
}

/// 6.4 steps 3 to 5: EMA (`jwt-bearer`), every check in the contract's order.
fn ema(ctx: &IssueCtx, d: &Delegated, http: &TokenHttp, form: &HashMap<String, String>, auth: DAuth) -> Result<Answer, Refusal> {
    let (client, id) = (auth.named.client, auth.named.id.clone());
    // R5-8, O17: client authentication is required
    if auth.method == AuthMethod::None {
        return Err(no("client-auth", "Enterprise-managed authorization needs client authentication; a public client cannot use it."));
    }
    issue::standing(ctx, client, &id)?;
    pipeline(ctx, http, &auth)?;
    let cnf = binding(ctx, http, &auth)?;
    let Some(assertion) = form.get("assertion") else { return Err(no("request", "The request carries no assertion.")) };
    let pinned = ctx.store.get(ctx.org, "").ok_or_else(|| no("map-expired", issue::closed_why("map-expired")))?;
    let map = pinned.map();
    let console = d.host.console_active(ctx.org);
    let jws = id_jag_parse(assertion)?;
    let iss = jws.claims.get("iss").and_then(Value::as_str).unwrap_or_default().to_string();
    let idp = idp_of(map, &iss, &console);
    let alg = id_jag_alg(&jws, idp.as_ref())?;
    let idp_id = idp_usable(idp.as_ref(), client, &id, &console)?;
    let idp = idp.unwrap_or_default();
    let keys = idp_keys(ctx, &iss, idp.get("private_ok").and_then(Value::as_bool).unwrap_or(false))?;
    let names = [id.as_str(), auth.named.presented.as_str()];
    let b = match &cnf {
        Cnf::Jkt(j) => Binding::Jkt(j),
        Cnf::X5t(x) => Binding::X5t(x),
        Cnf::None => return Err(no("dpop-required", "A delegated token request needs a DPoP proof or the client's certificate.")),
    };
    let check = IdJagCheck { issuer: ctx.issuer, client_names: &names, binding: b, now: ctx.now };
    let jag = verify_id_jag(&jws, alg, &keys, &idp, &check, &mut d.state.jtis.lock())?;
    let Resolved::Chosen(aud, target) = resolve_resource(map, ctx.org, client, &id, Some(&jag.resource), &console)? else {
        return Err(no("target", "That resource is not one a delegated token is for."));
    };
    if target == Target::Mcp && !issue::relay_allowed(client, ctx.store.active(ctx.org), &id, "console") {
        return Err(no("target", "This client may not reach that resource."));
    }
    let provider = s(&idp, "provider").unwrap_or_default();
    let Some(entry) = d.provider(ctx.org, provider) else { return Err(no("idp", "That IdP's identity provider is not in the organization's registry.")) };
    let record = d.person(ctx.org, &entry, Ask::Sub(&jag.sub), ctx.now)?;
    let (policy, ways) = d.ways(ctx.org, client, &id, &record, &console, ctx.now)?;
    let auth_max = idp.get("auth_max_s").and_then(Value::as_i64).unwrap_or(AUTH_MAX_DEFAULT);
    strength_ok(policy.get("identity"), &entry.id, &jag, auth_max, ctx.now)?;
    let act = nested_act(&id, jag.act.as_ref())?;
    let scopes = scopes_for(ctx, d, client, &id, &[jag.scope.as_deref(), form.get("scope").map(String::as_str)], &record.principal)?;
    let i = Issue {
        person: record.principal.clone(),
        grant: "jwt_bearer",
        idp: Some(idp_id),
        auth_time: jag.auth_time.unwrap_or(ctx.now),
        act,
        aud,
        scopes,
        cnf,
        ways,
        groups: record.groups.clone(),
        family_end: None,
        refresh: None,
    };
    issue_delegated(ctx, d, http, &auth, i)
}

/// 6.5 step 6: `authorization_code`: the code (single use; a second use revokes its family), its client, redirect URI,
/// S256 verifier (`pkce`), DPoP key, resource; 6.1 again; then the family and its first refresh token, and the token.
fn code_grant(ctx: &IssueCtx, d: &Delegated, http: &TokenHttp, form: &HashMap<String, String>, auth: DAuth) -> Result<Answer, Refusal> {
    let (client, id) = (auth.named.client, auth.named.id.clone());
    let now = ctx.now;
    issue::standing(ctx, client, &id)?;
    pipeline(ctx, http, &auth)?;
    let console = d.host.console_active(ctx.org);
    let redirects = registered_redirects(client, &id, auth.named.cimd.as_ref(), &console);
    if loopback_refused(client, auth.named.public, &redirects) {
        return Err(no("client", "A public loopback client of reach R1 needs loopback_ok."));
    }
    let cnf = binding(ctx, http, &auth)?;
    let Some(code) = form.get("code") else { return Err(no("request", "The request carries no code.")) };
    let hash = token_hash(code);
    let c = match d.state.take_code(&hash) {
        Taken::Fresh(c) => c,
        Taken::Used(family) => {
            if let Some(f) = family {
                d.state.end_family(ctx.org, &f, "code-reuse", now)?;
            }
            return Err(no("consent", "That code was already used; the tokens it gave are revoked."));
        }
        Taken::Unknown => return Err(no("consent", "That code is not valid.")),
    };
    if c.at + CODE_LIFE <= now || c.org != ctx.org || c.client_id != id || form.get("redirect_uri") != Some(&c.redirect_uri) {
        return Err(no("consent", "That code is not valid for this client and redirect URI."));
    }
    if !form.get("code_verifier").is_some_and(|v| pkce_matches(v, &c.challenge)) {
        return Err(no("pkce", "The code_verifier does not match the code's challenge."));
    }
    if c.dpop_jkt.as_deref().is_some_and(|j| !matches!(&cnf, Cnf::Jkt(k) if same(k, j))) {
        return Err(no("consent", "That code is bound to another DPoP key."));
    }
    if cj::redirect_dropped(&console, &id, &c.redirect_uri) {
        return Err(no("consent", "That code's redirect URI was dropped."));
    }
    let pinned = ctx.store.get(ctx.org, "").ok_or_else(|| no("map-expired", issue::closed_why("map-expired")))?;
    let Resolved::Chosen(aud, _) = resolve_resource(pinned.map(), ctx.org, client, &id, Some(&c.resource), &console)? else {
        return Err(no("target", "That resource is not one a delegated token is for."));
    };
    let Some(entry) = d.provider(ctx.org, &c.provider) else { return Err(no("person", "The person's identity provider is no longer registered.")) };
    let record = d.person(ctx.org, &entry, Ask::Principal(&c.principal), now)?;
    let (_, ways) = d.ways(ctx.org, client, &id, &record, &console, now)?;
    let granted = c.scopes.join(" ");
    let scopes = scopes_for(ctx, d, client, &id, &[Some(granted.as_str())], &record.principal)?;
    let pinned_days = client.get("delegation").and_then(|x| x.get("consent_days")).and_then(Value::as_i64).unwrap_or(CONSENT_DAYS_DEFAULT);
    let days = cj::consent_days(pinned_days, &console, &id);
    // R5-6: the tracker key first, so a full tracker refuses before any family exists
    d.state.reserve_track(ctx.org, &id, &record.principal, GRANT_CODE, now).map_err(track_refusal)?;
    let family = Family {
        id: hex(&random(8)?),
        client: id.clone(),
        person: record.principal.clone(),
        provider: entry.id.clone(),
        scopes: scopes.clone(),
        resource: aud.clone(),
        cnf: cnf_pair(&cnf),
        consent_at: now,
        ends: now + days * DAY,
        auth_time: c.auth_time,
        ways: ways.clone(),
        groups: record.groups.clone(),
        current: String::new(),
        used: Vec::new(),
        ended: None,
    };
    let fid = family.id.clone();
    let ends = family.ends;
    let token = d.state.new_family(ctx.org, family, now)?;
    d.state.code_family(&hash, &fid);
    let i = Issue {
        person: record.principal.clone(),
        grant: "authorization_code",
        idp: None,
        auth_time: c.auth_time,
        act: json!({"sub": id}),
        aud,
        scopes,
        cnf,
        ways,
        groups: record.groups.clone(),
        family_end: Some(ends),
        refresh: Some((token, fid)),
    };
    issue_delegated(ctx, d, http, &auth, i)
}

/// 6.5 refresh tokens: rotation with the same key or certificate; a used token revokes the family (`consent`); every
/// refresh re-runs 6.1 with a fresh record and the current map and journal; the family ends at its consent end,
/// `person_revoke`, `client_suspend`, a dropped way in, or an inactive person.
fn refresh_grant(ctx: &IssueCtx, d: &Delegated, http: &TokenHttp, form: &HashMap<String, String>, auth: DAuth) -> Result<Answer, Refusal> {
    let (client, id) = (auth.named.client, auth.named.id.clone());
    let now = ctx.now;
    let Some(token) = form.get("refresh_token") else { return Err(no("request", "The request carries no refresh_token.")) };
    let reused = |f: &Family| -> Refusal {
        let e = json!({"action": "api.refresh", "client": id, "person": f.person, "family": f.id, "result": "reuse-revoked"});
        match d.host.audit(ctx.org, e) {
            Ok(_) => no("consent", "That refresh token was already used; its family is revoked."),
            Err(_) => no("audit-unavailable", "The audit log cannot record this request now; try again later."),
        }
    };
    // the checks below read the family; the rotation at the end compares the presented token again in the same
    // transaction that rotates it, so a concurrent use of the token cannot rotate it twice
    let f = match d.state.redeem_refresh(ctx.org, token, &id, now, None)? {
        Redeemed::Live(f, _) => f,
        Redeemed::Reused(f, _) => return Err(reused(&f)),
        Redeemed::Unknown => return Err(no("consent", "That refresh token is not valid.")),
    };
    let end_with = |why: &str, r: Refusal| -> Refusal {
        match d.state.end_family(ctx.org, &f.id, why, now) {
            Ok(()) => r,
            Err(e) => e.into(),
        }
    };
    if let Err(r) = issue::standing(ctx, client, &id) {
        return Err(if r.code == "suspended" { end_with("client_suspend", r) } else { r });
    }
    pipeline(ctx, http, &auth)?;
    let cnf = binding(ctx, http, &auth)?;
    let pair = cnf_pair(&cnf);
    if pair.0 != f.cnf.0 || !same(&pair.1, &f.cnf.1) {
        return Err(no("consent", "That refresh token is bound to another key or certificate."));
    }
    let console = d.host.console_active(ctx.org);
    let pinned_days = client.get("delegation").and_then(|x| x.get("consent_days")).and_then(Value::as_i64).unwrap_or(CONSENT_DAYS_DEFAULT);
    let end = f.end_at(cj::consent_days(pinned_days, &console, &id));
    if now >= end {
        return Err(end_with("consent_days", no("consent", "The person's consent for this client has ended; sign in again.")));
    }
    let Some(entry) = d.provider(ctx.org, &f.provider) else { return Err(end_with("person", no("person", "The person's identity provider is no longer registered."))) };
    let record = match d.person(ctx.org, &entry, Ask::Principal(&f.person), now) {
        Ok(r) => r,
        Err(e) if e.code == "person" => return Err(end_with("person", e.into())),
        Err(e) => return Err(e.into()),
    };
    let ways = match d.ways(ctx.org, client, &id, &record, &console, now) {
        Ok((_, w)) => w,
        Err(e) if e.code == "person" => return Err(end_with("person", e.into())),
        Err(e) => return Err(e.into()),
    };
    let pinned = ctx.store.get(ctx.org, "").ok_or_else(|| no("map-expired", issue::closed_why("map-expired")))?;
    let Resolved::Chosen(aud, _) = resolve_resource(pinned.map(), ctx.org, client, &id, Some(&f.resource), &console)? else {
        return Err(no("target", "That resource is not one a delegated token is for."));
    };
    let granted = f.scopes.join(" ");
    let scopes = scopes_for(ctx, d, client, &id, &[Some(granted.as_str()), form.get("scope").map(String::as_str)], &record.principal)?;
    // 9.4: the rotation is in the chain before the new token leaves (written inside the rotating transaction, so a
    // lost race leaves no `rotated` line)
    let audit_rotated = |g: &Family| -> Result<(), Fail> {
        let e = json!({"action": "api.refresh", "client": id, "person": g.person, "family": g.id, "result": "rotated"});
        d.host.audit(ctx.org, e).map_err(|_| Fail::new("audit-unavailable", "The audit log cannot record this request now; try again later."))
    };
    // R5-6: the tracker key first, so a full tracker refuses before the family rotates (the token stays redeemable)
    d.state.reserve_track(ctx.org, &id, &f.person, GRANT_REFRESH, now).map_err(track_refusal)?;
    let next = match d.state.redeem_refresh(ctx.org, token, &id, now, Some(&audit_rotated))? {
        Redeemed::Live(g, Some(next)) if g.id == f.id => next,
        Redeemed::Reused(g, _) => return Err(reused(&g)),
        _ => return Err(no("consent", "That refresh token is not valid.")),
    };
    let i = Issue {
        person: f.person.clone(),
        grant: "refresh_token",
        idp: None,
        auth_time: f.auth_time,
        act: json!({"sub": id}),
        aud,
        scopes,
        cnf,
        ways,
        groups: record.groups.clone(),
        family_end: Some(end),
        refresh: Some((next, f.id.clone())),
    };
    issue_delegated(ctx, d, http, &auth, i)
}

// ── the Authorize pipeline (4.6, 6.5) ────────────────────────────────────────────────────────────────────────────

/// One of the Authorize pipeline's routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthzRoute {
    /// `GET I/oauth/authorize`.
    Authorize,
    /// `POST I/oauth/sso-return`.
    SsoReturn,
    /// `GET I/oauth/consent`.
    Consent,
    /// `POST I/oauth/consent`.
    ConsentPost,
}

/// What the Authorize pipeline runs on.
pub struct AuthzCtx<'a> {
    pub org: &'a str,
    pub store: &'a ApiMapStore,
    pub d: &'a Delegated<'a>,
    pub fetch: &'a FetchCache,
    /// The front door's source limiter (Err: seconds to wait).
    pub limiter: &'a dyn Fn(IpAddr) -> Result<(), i64>,
    pub owner_active: &'a dyn Fn(&str) -> bool,
    pub licensed: bool,
    pub now: i64,
}

/// The request as the pipeline sees it.
pub struct AuthzHttp<'a> {
    pub query: &'a str,
    pub form: &'a [u8],
    /// The `Cookie` header.
    pub cookie: Option<&'a str>,
    pub source: IpAddr,
}

/// R5-22: the headers of every Authorize answer, with the page's content security policy.
pub fn authz_headers(csp: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Content-Security-Policy", csp.to_string()),
        ("X-Frame-Options", "DENY".into()),
        ("Cache-Control", "no-store".into()),
        ("Referrer-Policy", "no-referrer".into()),
    ]
}

const PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

fn esc(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn enc(t: &str) -> String {
    t.bytes().map(|b| if unreserved(b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn html(status: u16, title: &str, inner: &str, csp: &str) -> Reply {
    let page = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{}</title>\
<style>body{{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}}.warn{{border:2px solid #b45309;background:#fffbeb;padding:.75rem;margin:1rem 0}}button{{font-size:1rem;padding:.5rem 1.25rem;margin-right:.5rem}}</style>\
</head><body><h1>{}</h1>{inner}</body></html>",
        esc(title),
        esc(title)
    );
    Reply { ctype: "text/html; charset=utf-8", headers: authz_headers(csp), text: Some(page), ..Reply::json(status, Value::Null) }
}

fn error_page(status: u16, why: &str) -> Reply {
    html(status, "Sign-in stopped", &format!("<p>{}</p>", esc(why)), PAGE_CSP)
}

fn redirect(location: String, mut extra: Vec<(&'static str, String)>) -> Reply {
    let mut headers = authz_headers(PAGE_CSP);
    headers.push(("Location", location));
    headers.append(&mut extra);
    Reply { ctype: "text/html; charset=utf-8", headers, text: Some(String::new()), ..Reply::json(302, Value::Null) }
}

/// The redirect back to the client with RFC 6749 4.1.2 parameters and RFC 9207 `iss`.
fn back(uri: &str, params: &[(&str, &str)], state: Option<&str>, issuer: &str) -> String {
    let mut q: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect();
    if let Some(st) = state {
        q.push(format!("state={}", enc(st)));
    }
    q.push(format!("iss={}", enc(issuer)));
    let sep = if uri.contains('?') { '&' } else { '?' };
    format!("{uri}{sep}{}", q.join("&"))
}

/// A form or query string: strict escapes, each parameter once, empty values absent.
fn pairs(text: &str) -> Option<HashMap<String, String>> {
    let mut out = HashMap::new();
    for pair in text.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (issue::unescape(k)?, issue::unescape(v)?);
        if v.is_empty() {
            continue;
        }
        if out.insert(k, v).is_some() {
            return None;
        }
    }
    Some(out)
}

/// The binding cookie's value in a `Cookie` header.
pub fn cookie_value(header: Option<&str>) -> Option<&str> {
    header?.split(';').map(str::trim).find_map(|c| c.strip_prefix(COOKIE).and_then(|r| r.strip_prefix('='))).filter(|v| !v.is_empty())
}

/// How a step stops: a page (never a redirect, before the redirect URI is known good) or an error back to the client.
enum Stop {
    Page(u16, &'static str, String),
    Back { uri: String, error: &'static str, code: &'static str, why: String, state: Option<String> },
}

fn page_of(f: Fail) -> Stop {
    Stop::Page(issue::shape(f.code).0, f.code, f.why)
}

fn page_r(r: Refusal) -> Stop {
    Stop::Page(issue::shape(r.code).0, r.code, r.why)
}

/// 4.6: the Authorize pipeline. Every answer carries the R5-22 headers; every refusal and decision is `api.authorize`
/// in the org's chain before it is answered (a redirect carrying a code only after its entry is durable).
pub fn authorize(ctx: &AuthzCtx, route: AuthzRoute, http: &AuthzHttp) -> Reply {
    let mut who: (Option<String>, Option<String>) = (None, None);
    let out = match route {
        AuthzRoute::Authorize => authorize_get(ctx, http, &mut who),
        AuthzRoute::SsoReturn => sso_return(ctx, http, &mut who),
        AuthzRoute::Consent => consent_get(ctx, http, &mut who),
        AuthzRoute::ConsentPost => consent_post(ctx, http, &mut who),
    };
    match out {
        Ok(r) => r,
        Err(stop) => stopped(ctx, http, who, stop),
    }
}

fn authz_audit(ctx: &AuthzCtx, http: &AuthzHttp, result: &str, check: Option<&str>, who: &(Option<String>, Option<String>)) -> Result<(), String> {
    let mut e = json!({"action": "api.authorize", "result": result, "ip": crate::console_source::canonical(http.source).to_string()});
    if let Some(c) = check {
        e["check"] = json!(c);
    }
    if let Some(c) = &who.0 {
        e["client"] = json!(c);
    }
    if let Some(p) = &who.1 {
        e["person"] = json!(p);
    }
    ctx.d.host.audit(ctx.org, e)
}

fn stopped(ctx: &AuthzCtx, http: &AuthzHttp, who: (Option<String>, Option<String>), stop: Stop) -> Reply {
    let code = match &stop {
        Stop::Page(_, c, _) => *c,
        Stop::Back { code, .. } => *code,
    };
    if code != "abuse" && authz_audit(ctx, http, "refused", Some(code), &who).is_err() {
        return error_page(503, "The audit log cannot record this request now; try again later.");
    }
    match stop {
        Stop::Page(status, _, why) => error_page(status, &why),
        Stop::Back { uri, error, why, state, .. } => {
            let issuer = ctx.store.get(ctx.org, "").map(|m| issuer_of(m.map()).to_string()).unwrap_or_default();
            redirect(back(&uri, &[("error", error), ("error_description", &why)], state.as_deref(), &issuer), Vec::new())
        }
    }
}

/// The opening of every Authorize route: the source limiter, the license, the map pinned and unexpired, the org on.
fn opening(ctx: &AuthzCtx, http: &AuthzHttp) -> Result<String, Stop> {
    if let Err(s) = (ctx.limiter)(http.source) {
        return Err(Stop::Page(429, "abuse", format!("Too many requests from this address; try again in {s} seconds.")));
    }
    if !ctx.licensed {
        return Err(Stop::Page(403, "license", issue::LICENSE_WHY.into()));
    }
    if let Some(code) = issue::closed(ctx.store, ctx.org, ctx.now) {
        return Err(Stop::Page(issue::shape(code).0, code, issue::closed_why(code).into()));
    }
    Ok(ctx.store.get(ctx.org, "").map(|m| issuer_of(m.map()).to_string()).unwrap_or_default())
}

/// The client of a request, delegated, in good standing.
fn delegated_client<'a>(ctx: &AuthzCtx<'a>, presented: &str) -> Result<Named<'a>, Stop> {
    let named = named_client(ctx.store, ctx.org, presented, ctx.fetch, ctx.now).map_err(page_of)?;
    if !is_delegated(named.client) {
        return Err(Stop::Page(400, "client", "That client does not act for people.".into()));
    }
    issue::standing_of(ctx.store, ctx.org, named.client, &named.id, ctx.owner_active, ctx.now).map_err(page_r)?;
    Ok(named)
}

/// 6.5 steps 1 and 2: `GET I/oauth/authorize`.
fn authorize_get(ctx: &AuthzCtx, http: &AuthzHttp, who: &mut (Option<String>, Option<String>)) -> Result<Reply, Stop> {
    let issuer = opening(ctx, http)?;
    let q = pairs(http.query).ok_or_else(|| Stop::Page(400, "request", "The request is not a valid query.".into()))?;
    let get = |k: &str| q.get(k).map(String::as_str);
    let presented = get("client_id").ok_or_else(|| Stop::Page(400, "request", "The request names no client (client_id).".into()))?;
    let named = delegated_client(ctx, presented)?;
    who.0 = Some(named.id.clone());
    let console = ctx.d.host.console_active(ctx.org);
    let redirects = registered_redirects(named.client, &named.id, named.cimd.as_ref(), &console);
    let uri = get("redirect_uri").filter(|u| redirects.iter().any(|r| redirect_matches(r, u))).ok_or_else(|| Stop::Page(400, "redirect", "That redirect URI is not registered for this client.".into()))?;
    let state = get("state").map(str::to_string);
    let back_err = |error: &'static str, code: &'static str, why: &str| Stop::Back { uri: uri.to_string(), error, code, why: why.to_string(), state: state.clone() };
    if get("response_type") != Some("code") {
        return Err(back_err("unsupported_response_type", "request", "Only response_type=code is supported."));
    }
    if get("code_challenge_method") != Some("S256") || !get("code_challenge").is_some_and(challenge_ok) {
        return Err(back_err("invalid_request", "pkce", "PKCE with S256 is required."));
    }
    if loopback_refused(named.client, named.public, &redirects) {
        return Err(back_err("unauthorized_client", "client", "This app runs on a computer and is not allowed to act for people here."));
    }
    let pinned = ctx.store.get(ctx.org, "").ok_or_else(|| Stop::Page(401, "map-expired", issue::closed_why("map-expired").into()))?;
    let aud = match resolve_resource(pinned.map(), ctx.org, named.client, &named.id, get("resource"), &console) {
        Ok(Resolved::Chosen(aud, target)) => {
            if target == Target::Mcp && !issue::relay_allowed(named.client, ctx.store.active(ctx.org), &named.id, "console") {
                return Err(back_err("invalid_target", "target", "This client may not reach that resource."));
            }
            aud
        }
        Ok(Resolved::Legacy) => return Err(back_err("invalid_target", "target", "That resource is not one a delegated token is for.")),
        Err(f) => return Err(back_err("invalid_target", "target", &f.why)),
    };
    let active = ctx.store.active(ctx.org);
    let dropped: Vec<&str> = tok::client_entries(active, "client_drop_scope", &named.id).map(|e| tok::target_field(e, "scope")).collect();
    let grantable: Vec<String> = tok::names(named.client, "scopes").filter(|x| !dropped.contains(x)).map(str::to_string).collect();
    let mut scopes: Vec<String> = match get("scope") {
        None => grantable.clone(),
        Some(asked) => {
            let asked: Vec<String> = asked.split(' ').filter(|x| !x.is_empty()).map(str::to_string).collect();
            if asked.iter().any(|a| !grantable.contains(a)) {
                return Err(back_err("invalid_scope", "scope", "That scope is not granted to this client."));
            }
            asked
        }
    };
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        return Err(back_err("invalid_scope", "scope", "This client holds no scope."));
    }
    let dpop_jkt = match get("dpop_jkt") {
        None => None,
        Some(j) if j.len() == 43 && tok::b64u_strict(j).is_some() => Some(j.to_string()),
        Some(_) => return Err(back_err("invalid_request", "request", "dpop_jkt is not a key thumbprint.")),
    };
    // O16: the person signs in through one of the org's registered ID-1 providers
    let providers = ctx.d.host.providers(ctx.org);
    if providers.is_empty() {
        return Err(back_err("access_denied", "person", "This organization has no single sign-on, so people cannot delegate here."));
    }
    let provider = match get("provider") {
        Some(p) => providers.iter().find(|x| x.id == p).ok_or_else(|| back_err("invalid_request", "request", "That sign-in provider is not one of this organization's."))?,
        None if providers.len() == 1 => &providers[0],
        None => return Ok(chooser(http.query, &providers)),
    };
    let Some(sso) = ctx.d.host.sso_url(ctx.org, &provider.id) else {
        return Err(Stop::Page(503, "subject-unreachable", "This organization's sign-in service is not set up for apps yet.".into()));
    };
    let req = hex(&random(16).map_err(page_of)?);
    let cookie = b64u(&random(32).map_err(page_of)?);
    let w = Waiting {
        org: ctx.org.to_string(),
        client: presented.to_string(),
        client_id: named.id.clone(),
        redirect_uri: uri.to_string(),
        challenge: get("code_challenge").unwrap_or_default().to_string(),
        resource: aud,
        scopes,
        state,
        dpop_jkt,
        cookie: token_hash(&cookie),
        provider: provider.id.clone(),
        at: ctx.now,
        person: None,
        csrf: None,
    };
    ctx.d.state.put_waiting(&req, w, ctx.now).map_err(page_of)?;
    let ret = format!("{issuer}/oauth/sso-return");
    let location = format!("{}/v1/sso/api/begin?org={}&provider={}&req={req}&return={}", sso.trim_end_matches('/'), enc(ctx.org), enc(&provider.id), enc(&ret));
    let set = format!("{COOKIE}={cookie}; Secure; HttpOnly; SameSite=None; Path=/; Max-Age={REQUEST_LIFE}");
    Ok(redirect(location, vec![("Set-Cookie", set)]))
}

/// 6.5 step 2: several providers: the person picks one (each link repeats the request with `provider`).
fn chooser(query: &str, providers: &[IdentityProvider]) -> Reply {
    let links: String = providers.iter().map(|p| format!("<li><a href=\"authorize?{}&amp;provider={}\">{}</a></li>", esc(query), enc(&p.id), esc(&p.id))).collect();
    html(200, "Choose how to sign in", &format!("<p>Pick your organization's sign-in:</p><ul>{links}</ul>"), PAGE_CSP)
}

/// The waiting request this browser holds: known, unexpired, and bound to the browser's cookie (R5-2).
fn bound_waiting(ctx: &AuthzCtx, http: &AuthzHttp, req: &str) -> Result<Waiting, Stop> {
    let w = ctx.d.state.get_waiting(req, ctx.now).filter(|w| w.org == ctx.org).ok_or_else(|| Stop::Page(400, "consent", "This sign-in request is unknown or has expired. Start again from your app.".into()))?;
    let held = cookie_value(http.cookie).map(token_hash);
    if !held.is_some_and(|h| same(&h, &w.cookie)) {
        return Err(Stop::Page(400, "consent", "This browser did not start this sign-in. Start again from your app.".into()));
    }
    Ok(w)
}

/// 6.5 step 3: `POST I/oauth/sso-return`.
fn sso_return(ctx: &AuthzCtx, http: &AuthzHttp, who: &mut (Option<String>, Option<String>)) -> Result<Reply, Stop> {
    let issuer = opening(ctx, http)?;
    let form = std::str::from_utf8(http.form).ok().and_then(pairs).ok_or_else(|| Stop::Page(400, "request", "The request is not a valid form.".into()))?;
    let att = form.get("att").ok_or_else(|| Stop::Page(400, "request", "The request carries no attestation.".into()))?;
    let req = att_req(att).ok_or_else(|| Stop::Page(400, "assertion", "The sign-in attestation does not read.".into()))?;
    let w = bound_waiting(ctx, http, &req)?;
    who.0 = Some(w.client_id.clone());
    if w.person.is_some() {
        return Err(Stop::Page(400, "consent", "This sign-in was already returned. Start again from your app.".into()));
    }
    // single use from here on
    ctx.d.state.take_waiting(&req);
    let state = w.state.clone();
    let back_err = |code: &'static str, why: &str| Stop::Back { uri: w.redirect_uri.clone(), error: "access_denied", code, why: why.to_string(), state: state.clone() };
    let entry = ctx.d.provider(ctx.org, &w.provider).ok_or_else(|| Stop::Page(400, "assertion", "That sign-in provider is no longer registered.".into()))?;
    let root = ctx.d.host.root().ok_or_else(|| Stop::Page(503, "subject-unreachable", "The console holds no organization certificate authority.".into()))?;
    if root.revoked(att_cert(att).as_deref()) {
        return Err(page_of(Fail::new("assertion", "The sign-in attestation is not valid: its certificate was revoked.")));
    }
    let a = verify_attestation(att, &root.cert, &entry, ctx.org, &format!("{issuer}/oauth/sso-return"), &req, ctx.now).map_err(page_of)?;
    who.1 = Some(a.principal.clone());
    let named = delegated_client(ctx, &w.client)?;
    let record = match ctx.d.person(ctx.org, &entry, Ask::Principal(&a.principal), ctx.now) {
        Ok(r) => r,
        Err(f) if f.code == "person" => return Err(back_err("person", &f.why)),
        Err(f) => return Err(page_of(f)),
    };
    if record.sub != a.sub {
        return Err(back_err("person", "The sign-in and the person's record name different accounts."));
    }
    let console = ctx.d.host.console_active(ctx.org);
    let ways = match ctx.d.ways(ctx.org, named.client, &named.id, &record, &console, ctx.now) {
        Ok((_, w)) => w,
        Err(f) if f.code == "person" => return Err(back_err("person", &f.why)),
        Err(f) => return Err(page_of(f)),
    };
    let mut scopes = w.scopes.clone();
    if named.client.get("reach").and_then(Value::as_str) == Some("R0") {
        let role = ctx.d.host.console_role(&record.principal);
        scopes.retain(|x| role_allows(role.as_deref(), x));
    }
    if scopes.is_empty() {
        return Err(back_err("scope", "Your role in the organization allows none of what this app asks for."));
    }
    let csrf = b64u(&random(32).map_err(page_of)?);
    let next = Waiting { scopes, person: Some(SignedIn { principal: record.principal.clone(), auth_time: a.auth_time, ways, groups: record.groups.clone() }), csrf: Some(csrf), ..w };
    ctx.d.state.put_waiting(&req, next, ctx.now).map_err(page_of)?;
    let mut r = redirect(format!("{issuer}/oauth/consent?req={req}"), Vec::new());
    r.status = 303;
    Ok(r)
}

/// The waiting request a consent step works on: signed in, bound to the browser.
fn signed_waiting(ctx: &AuthzCtx, http: &AuthzHttp, req: Option<&String>, who: &mut (Option<String>, Option<String>)) -> Result<(Waiting, SignedIn), Stop> {
    let req = req.ok_or_else(|| Stop::Page(400, "request", "The request names no sign-in (req).".into()))?;
    let w = bound_waiting(ctx, http, req)?;
    who.0 = Some(w.client_id.clone());
    let p = w.person.clone().ok_or_else(|| Stop::Page(400, "consent", "This sign-in has not finished. Start again from your app.".into()))?;
    who.1 = Some(p.principal.clone());
    Ok((w, p))
}

fn scope_words(client: &Obj, scope: &str) -> String {
    let apps: Vec<String> = tok::names(client, "apps").map(|a| a.split('@').next().unwrap_or(a).to_string()).collect();
    match scope {
        "content.read" => format!("read conversations {} {} in that you are in", if apps.is_empty() { "its apps".to_string() } else { apps.join(", ") }, if apps.len() == 1 { "is" } else { "are" }),
        "content.post" => "post there after you approve each post on your Lucid device".into(),
        "monitor.read" => "see the health and metrics of your organization's relays".into(),
        "fleet.read" => "list your organization's relays".into(),
        "audit.read" => "read your organization's API audit log".into(),
        "events.subscribe" => "receive your organization's API events".into(),
        other => format!("use {other}"),
    }
}

/// The CSP `form-action` source of a redirect URI (Chrome applies `form-action` to the redirect after a form post).
fn form_target(uri: &str) -> String {
    match loopback_parts(uri) {
        Some((host, _, _)) => format!("http://{host}:*"),
        None => {
            let rest = uri.strip_prefix("https://").unwrap_or(uri);
            format!("https://{}", rest.split(['/', '?']).next().unwrap_or_default())
        }
    }
}

/// 6.5 step 4: `GET I/oauth/consent?req=`: the consent page.
fn consent_get(ctx: &AuthzCtx, http: &AuthzHttp, who: &mut (Option<String>, Option<String>)) -> Result<Reply, Stop> {
    opening(ctx, http)?;
    let q = pairs(http.query).ok_or_else(|| Stop::Page(400, "request", "The request is not a valid query.".into()))?;
    let (w, _p) = signed_waiting(ctx, http, q.get("req"), who)?;
    let named = delegated_client(ctx, &w.client)?;
    let client = named.client;
    let name = named.cimd.as_ref().map(|c| c.client_name.clone()).unwrap_or_else(|| client.get("name").and_then(Value::as_str).unwrap_or(named.id.as_str()).to_string());
    let owner = client.get("owner").and_then(Value::as_str).unwrap_or_default();
    let console = ctx.d.host.console_active(ctx.org);
    let pinned_days = client.get("delegation").and_then(|x| x.get("consent_days")).and_then(Value::as_i64).unwrap_or(CONSENT_DAYS_DEFAULT);
    let until = crate::meet_json::iso_date(ctx.now + cj::consent_days(pinned_days, &console, &named.id) * DAY);
    let does: Vec<String> = w.scopes.iter().map(|x| scope_words(client, x)).collect();
    let host = redirect_host(&w.redirect_uri);
    let warning = if is_loopback(&w.redirect_uri) {
        "<div class=\"warn\">This app runs on your own computer. Lucid cannot check which program on this computer receives access. Allow only if you just started this sign-in from Claude.</div>"
            .replace("Claude", &esc(&name))
    } else {
        String::new()
    };
    let inner = format!(
        "<p>{} (registered by {}, owner {}) wants to act as you: {}. Until {}.</p><p>After you allow, Lucid sends you back to {}.</p>{warning}\
<form method=\"post\" action=\"consent\"><input type=\"hidden\" name=\"req\" value=\"{}\"><input type=\"hidden\" name=\"csrf\" value=\"{}\">\
<button type=\"submit\" name=\"decision\" value=\"allow\">Allow</button><button type=\"submit\" name=\"decision\" value=\"deny\">Deny</button></form>",
        esc(&name),
        esc(ctx.org),
        esc(owner),
        esc(&does.join("; ")),
        esc(&until),
        esc(&host),
        esc(q.get("req").map(String::as_str).unwrap_or_default()),
        esc(w.csrf.as_deref().unwrap_or_default()),
    );
    let csp = format!("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' {}; frame-ancestors 'none'", form_target(&w.redirect_uri));
    Ok(html(200, "Allow access?", &inner, &csp))
}

/// 6.5 steps 4 and 5: `POST I/oauth/consent`: the CSRF token bound to the request and the cookie; Deny redirects with
/// `error=access_denied`, `state`, `iss`; Allow audits `api.authorize` and redirects with `code`, `state`, `iss`.
fn consent_post(ctx: &AuthzCtx, http: &AuthzHttp, who: &mut (Option<String>, Option<String>)) -> Result<Reply, Stop> {
    let issuer = opening(ctx, http)?;
    let form = std::str::from_utf8(http.form).ok().and_then(pairs).ok_or_else(|| Stop::Page(400, "request", "The request is not a valid form.".into()))?;
    let (w, p) = signed_waiting(ctx, http, form.get("req"), who)?;
    let csrf_ok = matches!((form.get("csrf"), &w.csrf), (Some(a), Some(b)) if same(a, b));
    if !csrf_ok {
        return Err(Stop::Page(400, "consent", "This page has expired. Start again from your app.".into()));
    }
    if let Some(req) = form.get("req") {
        ctx.d.state.take_waiting(req);
    }
    let state = w.state.clone();
    if form.get("decision").map(String::as_str) != Some("allow") {
        authz_audit(ctx, http, "denied", None, who).map_err(|_| Stop::Page(503, "audit-unavailable", "The audit log cannot record this request now; try again later.".into()))?;
        return Ok(redirect(back(&w.redirect_uri, &[("error", "access_denied")], state.as_deref(), &issuer), Vec::new()));
    }
    let named = delegated_client(ctx, &w.client)?;
    let console = ctx.d.host.console_active(ctx.org);
    if cj::person_revoked(&console, &named.id, &p.principal) || person_revoked_now(ctx.org, &named.id, &p.principal) {
        return Err(Stop::Back { uri: w.redirect_uri.clone(), error: "access_denied", code: "person", why: "You may no longer delegate to this app.".into(), state });
    }
    if cj::redirect_dropped(&console, &named.id, &w.redirect_uri) {
        return Err(Stop::Page(400, "redirect", "That redirect URI is no longer registered for this client.".into()));
    }
    let code = b64u(&random(32).map_err(page_of)?);
    let c = Code {
        org: ctx.org.to_string(),
        client_id: named.id.clone(),
        redirect_uri: w.redirect_uri.clone(),
        challenge: w.challenge.clone(),
        resource: w.resource.clone(),
        scopes: w.scopes.clone(),
        principal: p.principal.clone(),
        provider: w.provider.clone(),
        auth_time: p.auth_time,
        dpop_jkt: w.dpop_jkt.clone(),
        at: ctx.now,
        used: false,
        family: None,
    };
    // 4.6: audited before any redirect carrying a code
    authz_audit(ctx, http, "allowed", None, who).map_err(|_| Stop::Page(503, "audit-unavailable", "The audit log cannot record this request now; try again later.".into()))?;
    ctx.d.state.put_code(token_hash(&code), c, ctx.now).map_err(page_of)?;
    Ok(redirect(back(&w.redirect_uri, &[("code", &code)], state.as_deref(), &issuer), Vec::new()))
}

#[cfg(test)]
#[path = "api_delegated_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "api_delegated_e2e_tests.rs"]
mod e2e_tests;
