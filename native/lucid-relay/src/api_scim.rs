// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 6.3 and 6.7 on a relay: `POST /v1/sso/c/api-check`, the
// relay's decision on every SCIM request the org's SSO service receives, and the relay-local record of owners the SSO
// service deprovisioned, with the `api-person` records the relay owes the console.
//
// Governed form: the resource pipeline of revision 3 6.1 and 6.2 (checks 0 to 11, `api_resource::scim_authorize`) on
// a route row of its own (scope `directory.read` for GET, `directory.write` otherwise; reach R0; class
// `confidential`), with the token's `aud` and the DPoP `htu` taken from the SCIM resource `S` the SSO service serves
// and the limiters kept per SSO service. Legacy form: allowed only while the relay serves every listed org and none of
// them is governed in its pinned map. Every decision is in the org's chain (route `scim`, never the authorization
// value: only the token's `jti` and client, or the legacy token id) before the answer leaves; when it cannot be
// recorded the answer is 503 `audit-unavailable` and nothing is allowed.
//
// Owner deprovisioning (6.7): `/v1/sso/c/suspend` writes `api-owners-inactive/<org>.json` (flushed) before it
// answers; from then on the token pipeline (`api_issue::standing`), the resource pipeline and `api-check` refuse
// every client whose `owner` is listed (403 `owner`), without the console. `/v1/sso/c/unsuspend` clears the entry.
// Each change is queued as an `api-person` record in `api-people-outbox/<org>.jsonl` (flushed), which the fleet
// channel sends in order after reconnect sync and deletes line by line as the console acknowledges.

use crate::api_audit::{AuditError, Repr};
use crate::api_issue::ClientCert;
use crate::api_map::ApiMapStore;
use crate::api_resource::{self as res, ApiRoute, AuditLog, Call, Data, Pipeline, RelayInfo, ResourceState, RouteId, Side, Site};
use crate::api_token as tok;
use crate::fleet_wire::Refusal;
use crate::meet::{Identity, Relay, E, R};
use crate::meet_json::Obj;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// 6.3: the largest `api-check` body.
pub const BODY_MAX: usize = 32 * 1024;
/// 6.7: the relay-local owner-inactive records, one file per org.
pub const OWNERS_DIR: &str = "api-owners-inactive";
/// 2.5: the `api-person` records not yet acknowledged by the console, one JSON line each, per org.
pub const OUTBOX_DIR: &str = "api-people-outbox";
/// 2.5 `api-person` `source`.
pub const SOURCES: [&str; 3] = ["scim", "directory", "signin"];
/// Lines an org's outbox holds at most (a full outbox refuses the suspension, which the SSO service sends again).
const OUTBOX_MAX: usize = 10_000;
/// The audit route of every SCIM decision.
const ROUTE: &str = "scim";
const ORGS_MAX: usize = 64;
const PATH_MAX: usize = 2048;
const RESOURCE_MAX: usize = 512;
/// The largest forwarded client certificate (DER bytes); its base64 still fits `BODY_MAX` with the rest of the body.
const CERT_MAX: usize = 8 * 1024;
const PROVIDER_MAX: usize = 64;
const TOKEN_ID_MAX: usize = 128;
const READ: &str = "directory.read";
const WRITE: &str = "directory.write";
const REGISTERED: &str = "the sign-in service may only check SCIM requests of providers registered to it";
const AUDIT_WHY: &str = "The audit log cannot record this request now; try again later.";
const NOT_SERVED_WHY: &str = "This relay does not serve that organization.";
const GOVERNED_WHY: &str = "An organization of this token is governed by its api map; use governed SCIM.";

// ── the route rows (9.3) ─────────────────────────────────────────────────────────────────────────────────────────

/// A SCIM route row for the pipeline. These rows are never in `api_resource::ROUTES` (no listener dispatches them),
/// so `id` is a placeholder the pipeline does not read; what it reads is the method (DPoP `htm`), scope, reach, class.
const fn row(method: &'static str, scope: &'static str) -> ApiRoute {
    ApiRoute {
        id: RouteId::Health,
        side: Side::Relay,
        method,
        path: ROUTE,
        pipeline: Pipeline::Resource,
        scrape: false,
        scope,
        reach: "R0",
        class: "confidential",
        request: "",
        response: "",
        summary: "A SCIM request the SSO service asks the relay to decide (revision 4 6.3)",
    }
}

static ROWS: [ApiRoute; 5] = [row("GET", READ), row("POST", WRITE), row("PUT", WRITE), row("PATCH", WRITE), row("DELETE", WRITE)];

fn row_of(method: &str) -> Option<&'static ApiRoute> {
    ROWS.iter().find(|r| r.method == method)
}

/// Revision 4 12 `lucid_scim_requests_total` `op`.
fn op_of(method: &str) -> &'static str {
    match method {
        "POST" => "create",
        "GET" => "read",
        "DELETE" => "delete",
        _ => "update",
    }
}

// ── what the check reads of the relay ────────────────────────────────────────────────────────────────────────────

/// The relay as `api-check` sees it (the hub and fleet link in production, fixed values in tests).
pub trait CheckSide {
    /// This relay's fleet id, None while not enrolled.
    fn relay_id(&self) -> Option<String>;
    /// A read-only copy of the org's api state, None when this relay does not serve the org.
    fn snapshot(&self, org: &str) -> Option<ApiMapStore>;
    /// The 1a2 owner rule (unknown means active).
    fn owner_active(&self, principal: &str) -> bool;
    /// 6.2 check 1: the relay serves people under its license.
    fn licensed(&self) -> bool;
    /// This relay's audit chains, None before enrollment.
    fn audit(&self) -> Option<Arc<dyn AuditLog>>;
    /// The state folder holding the owner-inactive records.
    fn dir(&self) -> Option<&Path>;
    /// The facts of the client certificate (leaf DER) the SSO service forwarded, verified as this relay verifies an
    /// API client certificate (4.2): issued directly by a Meet root of the client CA, within its validity at `now`, and
    /// not listed on a current CRL. None for anything else (unparsable, other issuer, expired, revoked, no current CRL).
    fn client_cert(&self, der: &[u8], now: i64) -> Option<ClientCert>;
}

struct RelaySide<'a> {
    relay: &'a Relay,
    dir: Option<PathBuf>,
}

impl CheckSide for RelaySide<'_> {
    fn relay_id(&self) -> Option<String> {
        let map = crate::fleet_agent::load_link_json(self.dir.as_deref()?).ok().flatten()?;
        Some(crate::fleet_agent::Link { map }.relay_id().to_string()).filter(|id| !id.is_empty())
    }

    fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
        self.relay.hub.api_org_snapshot(org)
    }

    fn owner_active(&self, principal: &str) -> bool {
        self.relay.hub.api_owner_active(principal)
    }

    fn licensed(&self) -> bool {
        use crate::meet_license::Service;
        self.relay.hub.gate().is_some_and(|g| matches!(g.service(), Service::On | Service::Grace))
    }

    fn audit(&self) -> Option<Arc<dyn AuditLog>> {
        self.relay.api_audit().map(|a| a as Arc<dyn AuditLog>)
    }

    fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    fn client_cert(&self, der: &[u8], now: i64) -> Option<ClientCert> {
        let s = &self.relay.settings;
        let leaf = crate::meet_x509::Cert::from_der(der)?;
        let roots = crate::meet_tls::self_signed_roots(Path::new(&s.client_ca));
        // directly issued by a Meet root valid now, the leaf within its own validity (no grace on this path)
        if !roots.iter().any(|r| leaf.issued_by(r) && r.not_before <= now && now <= r.not_after) || leaf.not_before > now || leaf.not_after < now {
            return None;
        }
        // revocation as the relay API listener checks it: a current CRL in force that does not list the leaf
        if !crate::meet_tls::api_cert_revocation_checked(s, der, &[], now) {
            return None;
        }
        ClientCert::of_leaf(der, true)
    }
}

/// The relay's state folder, None when it keeps none (no fleet link, no API).
pub fn state_dir(state_dir: &str) -> Option<PathBuf> {
    (!state_dir.is_empty()).then(|| PathBuf::from(state_dir))
}

/// The pipeline's view of the fleet: `api-check` releases no fleet data.
struct NoFleet;

impl Data for NoFleet {
    fn relays(&self, _: &str, _: i64) -> Vec<RelayInfo> {
        Vec::new()
    }
    fn ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn exposition(&self, _: &str, _: &[String], _: i64) -> String {
        String::new()
    }
    fn console(&self) -> Value {
        Value::Null
    }
}

/// The org chains as the pipeline writes them for a SCIM request: every entry under route `scim` with the request's
/// method, `op` and resource.
struct ScimAudit<'a> {
    inner: &'a dyn AuditLog,
    method: &'a str,
    resource: &'a str,
}

impl ScimAudit<'_> {
    fn tagged(&self, entry: Value) -> Value {
        let Value::Object(mut e) = entry else { return entry };
        e.insert("route".into(), json!(ROUTE));
        e.insert("method".into(), json!(self.method));
        e.insert("op".into(), json!(op_of(self.method)));
        e.entry("resource").or_insert_with(|| json!(self.resource));
        Value::Object(e)
    }
}

impl AuditLog for ScimAudit<'_> {
    fn record(&self, org: &str, entry: Value, now: i64) -> Result<u64, AuditError> {
        self.inner.record(org, self.tagged(entry), now)
    }
    fn refusal(&self, org: &str, key: &str, check: &str, _: &str, entry: Value, now: i64) -> Result<(), AuditError> {
        self.inner.refusal(org, key, check, ROUTE, self.tagged(entry), now)
    }
    fn allowed_ok(&self) -> bool {
        self.inner.allowed_ok()
    }
    fn read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Result<Value, AuditError> {
        self.inner.read(org, source, repr, after, limit)
    }
    fn keys(&self, org: &str) -> Vec<Value> {
        self.inner.keys(org)
    }
}

/// 6.3 "its limiters keyed per SSO service": one pipeline state (source and client limiters, DPoP `jti` cache) per
/// SSO service certificate serial.
static STATES: LazyLock<Mutex<HashMap<String, Arc<ResourceState>>>> = LazyLock::new(Mutex::default);

fn state_of(service: &str) -> Arc<ResourceState> {
    STATES.lock().entry(service.to_string()).or_insert_with(|| Arc::new(ResourceState::new())).clone()
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────────────────────────

/// An `api-check` answer: 200 (allowed, or a pipeline refusal with its own `status`), 403 (`org-not-served`,
/// `scim-governed`) or 503 (`audit-unavailable`).
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub status: u16,
    pub body: Obj,
}

fn unavailable() -> Decision {
    Decision { status: 503, body: obj(json!({"code": "audit-unavailable", "error": AUDIT_WHY})) }
}

fn obj(v: Value) -> Obj {
    match v {
        Value::Object(o) => o,
        _ => Obj::new(),
    }
}

/// A refusal answered with HTTP 200: the SSO service returns `status` with a SCIM error body and `X-Lucid-Code`.
fn refused(status: u16, code: &str, why: &str, retry_after: Option<i64>) -> Decision {
    let mut body = obj(json!({"allow": false, "status": status, "code": code, "error": why}));
    if let Some(s) = retry_after {
        body.insert("retry_after".into(), json!(s));
    }
    Decision { status: 200, body }
}

/// A pipeline refusal (already audited) as the answer.
fn of_reply(reply: &res::Reply) -> Decision {
    let code = reply.body.get("code").and_then(Value::as_str).unwrap_or("token");
    if code == "audit-unavailable" {
        return unavailable();
    }
    let why = reply.body.get("error").and_then(Value::as_str).unwrap_or_default();
    let retry = reply.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("Retry-After")).and_then(|(_, v)| v.parse::<i64>().ok());
    refused(reply.status, code, why, retry)
}

fn text<'b>(b: &'b Obj, k: &str) -> Option<&'b str> {
    b.get(k).and_then(Value::as_str)
}

fn org_ok(org: &str) -> bool {
    res::org_of(&format!("/api/orgs/{org}")) == Some(org)
}

fn method_of(b: &Obj) -> Result<&'static str, String> {
    let m = text(b, "method").unwrap_or_default();
    row_of(m).map(|r| r.method).ok_or_else(|| "method must be GET, POST, PUT, PATCH or DELETE".to_string())
}

/// The SCIM path without its query (the DPoP `htu` excludes it, RFC 9449 4.3).
fn path_of(b: &Obj) -> Result<&str, String> {
    let p = text(b, "path").filter(|p| p.starts_with('/') && p.len() <= PATH_MAX && !p.contains(char::is_whitespace));
    let p = p.ok_or_else(|| "path must be the SCIM path under the resource, starting with /".to_string())?;
    Ok(p.split(['?', '#']).next().unwrap_or(p))
}

fn ip_of(b: &Obj) -> Result<IpAddr, String> {
    text(b, "ip").and_then(|s| s.parse::<IpAddr>().ok()).ok_or_else(|| "ip must be the caller's address".to_string())
}

fn provider_of(b: &Obj) -> Result<&str, String> {
    text(b, "provider").filter(|p| !p.is_empty() && p.len() <= PROVIDER_MAX).ok_or_else(|| "provider must name the identity provider".to_string())
}

fn directory_of(c: &Value) -> Option<&Obj> {
    c.get("directory").and_then(Value::as_object)
}

/// 6.3: an org is governed when its pinned map holds a client with `directory.write` (no pinned map: not governed).
pub fn governed(store: &ApiMapStore, org: &str) -> bool {
    store.clients(org).iter().any(|c| c.get("scopes").and_then(Value::as_array).is_some_and(|s| s.iter().any(|x| x.as_str() == Some(WRITE))))
}

fn governed_entry(store: &ApiMapStore, org: &str) -> Value {
    json!({"governed": governed(store, org), "seq": store.get(org, "").map_or(0, |p| p.seq)})
}

fn ip_text(ip: IpAddr) -> String {
    crate::console_source::canonical(ip).to_string()
}

fn counted(org: &str, method: &str, client: &str, refused: Option<&str>) {
    use crate::api_catalog::counters;
    counters::scim_request(org, op_of(method), if refused.is_some() { "refused" } else { "ok" });
    match refused {
        None => counters::api_request(org, client, "ok"),
        Some(check) => {
            counters::api_request(org, client, "refused");
            counters::api_refusal(org, check);
        }
    }
}

/// `POST /v1/sso/c/api-check` (6.3) from the SSO service `service` (its certificate serial, checked against the
/// registry by the caller): the governed form, or the legacy form when the body carries `legacy`. Err is a malformed
/// body (400, nothing audited).
pub fn check(side: &dyn CheckSide, service: &str, b: &Obj, now: i64) -> Result<Decision, String> {
    if b.contains_key("legacy") {
        legacy(side, b, now)
    } else {
        check_governed(side, service, b, now)
    }
}

/// The governed form: checks 0 to 11 for a token with `aud` = `resource`, then the client's directory block names
/// that resource and the provider the SSO service is registered for; the decision is in the chain before the answer.
fn check_governed(side: &dyn CheckSide, service: &str, b: &Obj, now: i64) -> Result<Decision, String> {
    let org = text(b, "org").filter(|o| org_ok(o)).ok_or_else(|| "org must be an organization id".to_string())?;
    let provider = provider_of(b)?;
    let resource = text(b, "resource").filter(|r| r.starts_with("https://") && r.len() <= RESOURCE_MAX).ok_or_else(|| "resource must be the SCIM base URI".to_string())?;
    let method = method_of(b)?;
    let path = path_of(b)?;
    let ip = ip_of(b)?;
    let authorization = text(b, "authorization").filter(|s| !s.is_empty());
    let dpop = text(b, "dpop").filter(|s| !s.is_empty());
    let Some(store) = side.snapshot(org) else {
        return Ok(Decision { status: 403, body: obj(json!({"allow": false, "code": "org-not-served", "error": NOT_SERVED_WHY})) });
    };
    let cert = forwarded_cert(side, b, now)?;
    let (Some(audit), Some(relay)) = (side.audit(), side.relay_id()) else {
        counted(org, method, "", Some("audit-unavailable"));
        return Ok(unavailable());
    };
    let route = row_of(method).ok_or_else(|| "method must be GET, POST, PUT, PATCH or DELETE".to_string())?;
    let tagged = ScimAudit { inner: &*audit, method, resource };
    let rid = res::rid();
    let owner = |p: &str| side.owner_active(p) && !side.dir().is_some_and(|d| owner_inactive_in(d, org, p));
    let state = state_of(service);
    let site = Site { side: Side::Relay, relay: &relay, resource, local: None, store: &store, owner_active: &owner, licensed: side.licensed(), audit: &tagged, state: &state, data: &NoFleet, now };
    let call = Call { org, route, id: None, path, query: "", authorization, dpop, cert: cert.as_ref(), source: ip, rid: &rid };
    // the resource is a directory client's of the pinned map (the SSO service sends the one it serves, never Host)
    if !store.clients(org).iter().filter_map(directory_of).any(|d| d.get("resource").and_then(Value::as_str) == Some(resource)) {
        return Ok(refuse(&tagged, org, method, &rid, ip, None, route.scope, (404, "not-found", "That SCIM resource is not in the organization's api map."), now));
    }
    let ok = match res::scim_authorize(&site, &call) {
        Ok(a) => a,
        Err(reply) => {
            // the pipeline audited and counted it as an API decision already
            crate::api_catalog::counters::scim_request(org, op_of(method), "refused");
            return Ok(of_reply(&reply));
        }
    };
    let jti = ok.jti.clone().unwrap_or_default();
    let who = Some((ok.client.as_str(), Some(jti.as_str())));
    let block = tok::find_client(&store, org, &ok.client)
        .and_then(|c| c.get("directory"))
        .and_then(Value::as_object)
        .filter(|d| d.get("resource").and_then(Value::as_str) == Some(resource) && d.get("provider").and_then(Value::as_str) == Some(provider));
    let Some(block) = block else {
        return Ok(refuse(&tagged, org, method, &rid, ip, who, route.scope, (403, "scope", "This client does not provision that directory."), now));
    };
    // a certificate-bound token stands only while the certificate it is bound to (checked against the hash in check 3)
    // still authenticates the client now: an `mtls` credential of the pinned map with exactly its serial and SPKI, not
    // dropped by the journal, the certificate verified, in date and not revoked (`forwarded_cert`)
    let token = authorization.and_then(|a| a.trim().split_once(' ')).map(|(_, t)| t.trim()).unwrap_or_default();
    let jws = tok::parse_jws(token);
    let cert_bound = jws.as_ref().is_some_and(|j| j.claims.get("cnf").and_then(|c| c.get("x5t#S256")).is_some());
    if cert_bound {
        let client = tok::find_client(&store, org, &ok.client);
        let current = client.is_some_and(|c| cert.as_ref().is_some_and(|x| x.authenticates(c, org, &tok::usable_credentials(c, store.active(org)))));
        if !current {
            return Ok(refuse(&tagged, org, method, &rid, ip, who, route.scope, (403, "mtls", "This client's certificate does not match a usable mtls credential."), now));
        }
    }
    let mut e = Map::new();
    e.insert("rid".into(), json!(rid));
    e.insert("action".into(), json!("api.call"));
    e.insert("ip".into(), json!(ip_text(ip)));
    e.insert("client".into(), json!(ok.client));
    e.insert("jti".into(), json!(jti));
    e.insert("scope".into(), json!(route.scope));
    e.insert("result".into(), json!("ok"));
    e.insert("check".into(), json!("none"));
    e.insert("status".into(), json!(200));
    e.insert("count".into(), json!(1));
    if tagged.record(org, Value::Object(e), now).is_err() {
        counted(org, method, &ok.client, Some("audit-unavailable"));
        return Ok(unavailable());
    }
    counted(org, method, &ok.client, None);
    let scopes = ok.grant.as_ref().map(|g| g.scopes.clone()).unwrap_or_default();
    // an `entra_wif` token carries no sender constraint (6.5 limits what it may do)
    let unbound = jws.as_ref().is_some_and(|j| j.claims.get("cnf").is_none());
    let mut gov = Map::new();
    gov.insert(org.to_string(), governed_entry(&store, org));
    let body = json!({
        "allow": true, "client": ok.client, "scopes": scopes,
        "directory": {"provider": block.get("provider").cloned().unwrap_or(Value::Null), "domains": block.get("domains").cloned().unwrap_or_else(|| json!([]))},
        "rid": rid, "unbound": unbound, "governed": gov,
    });
    Ok(Decision { status: 200, body: obj(body) })
}

/// The client certificate the SSO service saw on its own TLS connection: `client_cert` (standard base64 of the leaf's
/// DER, at most `CERT_MAX` bytes) and `client_cert_sha256` (its base64url SHA-256; when both are sent they must agree).
/// The leaf is verified here as the relay verifies an API client certificate (`CheckSide::client_cert`); its facts
/// (serial, SPKI, kind, principal, orgs) are then what check 10 and the certificate-bound token rule match against the
/// exact `mtls` credential of the pinned map. A hash alone, or a leaf that does not verify (another issuer, expired,
/// revoked), still binds a token by its hash (check 3) but never authenticates the client (`mtls`). Err: malformed.
fn forwarded_cert(side: &dyn CheckSide, b: &Obj, now: i64) -> Result<Option<ClientCert>, String> {
    let hash = text(b, "client_cert_sha256").filter(|s| !s.is_empty());
    let unverified = |sha256_b64u: String| ClientCert {
        sha256_b64u,
        serial: String::new(),
        spki_sha256: String::new(),
        not_after: 0,
        chain_ok: false,
        kind: String::new(),
        principal: String::new(),
        orgs: Vec::new(),
    };
    let Some(encoded) = b.get("client_cert") else {
        return Ok(hash.map(|h| unverified(h.to_string())));
    };
    let bad = || format!("client_cert must be the standard base64 of a certificate of at most {CERT_MAX} bytes");
    let encoded = encoded.as_str().filter(|s| !s.is_empty() && s.len() <= CERT_MAX.div_ceil(3) * 4).ok_or_else(bad)?;
    let body = encoded.trim_end_matches('=');
    if encoded.len() - body.len() > 2 || !body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') {
        return Err(bad());
    }
    let der = crate::codec::b64_decode_lenient(body);
    if der.is_empty() || der.len() > CERT_MAX {
        return Err(bad());
    }
    let sha = crate::codec::b64u(&crate::codec::sha256(&der));
    if hash.is_some_and(|h| h != sha) {
        return Err("client_cert_sha256 must be the hash of client_cert".into());
    }
    Ok(Some(side.client_cert(&der, now).filter(|c| c.sha256_b64u == sha).unwrap_or_else(|| unverified(sha))))
}

/// A governed refusal decided outside the pipeline, into the org's refusal summaries (key: the client once
/// identified, else the caller's address), then its answer; 503 when it cannot be recorded.
#[allow(clippy::too_many_arguments)]
fn refuse(audit: &dyn AuditLog, org: &str, method: &str, rid: &str, ip: IpAddr, who: Option<(&str, Option<&str>)>, scope: &str, (status, code, why): (u16, &'static str, &str), now: i64) -> Decision {
    let mut e = Map::new();
    e.insert("rid".into(), json!(rid));
    e.insert("action".into(), json!("api.refusal"));
    e.insert("ip".into(), json!(ip_text(ip)));
    e.insert("result".into(), json!("refused"));
    e.insert("check".into(), json!(code));
    e.insert("status".into(), json!(status));
    e.insert("count".into(), json!(1));
    e.insert("scope".into(), json!(scope));
    if let Some((client, jti)) = who {
        e.insert("client".into(), json!(client));
        if let Some(j) = jti.filter(|j| !j.is_empty()) {
            e.insert("jti".into(), json!(j));
        }
    }
    let key = who.map_or_else(|| format!("ip:{}", crate::console_source::source_key(ip)), |(c, _)| c.to_string());
    let client = who.map_or("", |(c, _)| c);
    if audit.refusal(org, &key, code, ROUTE, Value::Object(e), now).is_err() {
        counted(org, method, client, Some("audit-unavailable"));
        return unavailable();
    }
    counted(org, method, client, Some(code));
    refused(status, code, why, None)
}

/// The legacy form (Rev4Review R4-3): allowed only when this relay serves every listed org and none is governed in its
/// pinned map; the decision (`api.call`, `auth` `legacy`, the token id) is in the chain of every listed org with a
/// pinned map before the answer.
fn legacy(side: &dyn CheckSide, b: &Obj, now: i64) -> Result<Decision, String> {
    let list = b.get("orgs").and_then(Value::as_array).filter(|l| (1..=ORGS_MAX).contains(&l.len()));
    let list = list.ok_or_else(|| format!("orgs must list 1 to {ORGS_MAX} organizations"))?;
    let mut orgs: Vec<&str> = Vec::with_capacity(list.len());
    for o in list {
        let o = o.as_str().filter(|o| org_ok(o)).ok_or_else(|| "orgs must list organization ids".to_string())?;
        if orgs.contains(&o) {
            return Err("orgs must list each organization once".into());
        }
        orgs.push(o);
    }
    provider_of(b)?;
    let token_id = b.get("legacy").and_then(|l| l.get("token_id")).and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= TOKEN_ID_MAX);
    let token_id = token_id.ok_or_else(|| "legacy.token_id must name the sso.json token".to_string())?;
    let method = method_of(b)?;
    path_of(b)?;
    let ip = ip_of(b)?;
    let mut gov = Map::new();
    let (mut missing, mut any_governed) = (false, false);
    let mut chains: Vec<&str> = Vec::new();
    for &org in &orgs {
        match side.snapshot(org) {
            None => missing = true,
            Some(store) => {
                let entry = governed_entry(&store, org);
                any_governed |= entry["governed"] == json!(true);
                gov.insert(org.to_string(), entry);
                if store.get(org, "").is_some() {
                    chains.push(org);
                }
            }
        }
    }
    let code = if any_governed {
        Some(("scim-governed", GOVERNED_WHY))
    } else if missing {
        Some(("org-not-served", NOT_SERVED_WHY))
    } else {
        None
    };
    if !chains.is_empty() {
        let Some(audit) = side.audit() else {
            for &org in &chains {
                crate::api_catalog::counters::scim_request(org, op_of(method), "refused");
            }
            return Ok(unavailable());
        };
        let rid = res::rid();
        for &org in &chains {
            let e = json!({
                "rid": rid, "action": "api.call", "route": ROUTE, "ip": ip_text(ip), "method": method, "op": op_of(method),
                "auth": "legacy", "token_id": token_id, "result": if code.is_some() { "refused" } else { "ok" },
                "check": code.map_or("none", |(c, _)| c), "status": if code.is_some() { 403 } else { 200 }, "count": 1,
            });
            if audit.record(org, e, now).is_err() {
                crate::api_catalog::counters::scim_request(org, op_of(method), "refused");
                return Ok(unavailable());
            }
        }
    }
    for org in gov.keys() {
        crate::api_catalog::counters::scim_request(org, op_of(method), if code.is_some() { "refused" } else { "ok" });
    }
    Ok(match code {
        None => Decision { status: 200, body: obj(json!({"allow": true, "governed": gov})) },
        Some((c, why)) => Decision { status: 403, body: obj(json!({"allow": false, "code": c, "governed": gov, "error": why})) },
    })
}

/// The route: the caller is the SSO service the registry names for (`org`, `provider`) of the governed form, or for
/// every listed org of the legacy form (403 otherwise, as every `/v1/sso/c/*` route), then `check`.
pub fn api_check(relay: &Relay, who: &Identity, b: &Obj) -> R<Obj> {
    let provider = text(b, "provider").unwrap_or_default();
    if b.contains_key("legacy") {
        let orgs: Vec<&str> = b.get("orgs").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if orgs.is_empty() {
            return crate::meet::bad(format!("orgs must list 1 to {ORGS_MAX} organizations"));
        }
        for org in orgs {
            relay.hub.pc_check_registered(who, org, provider, REGISTERED)?;
        }
    } else {
        relay.hub.pc_check_registered(who, text(b, "org").unwrap_or_default(), provider, REGISTERED)?;
    }
    let side = RelaySide { relay, dir: state_dir(&relay.settings.state_dir) };
    let d = check(&side, &crate::meet::serial(&who.serial), b, crate::meet_json::now() as i64).map_err(E::Bad)?;
    match d.status {
        200 => Ok(d.body),
        503 => Err(E::Coded(503, "audit-unavailable", AUDIT_WHY.into())),
        _ => {
            let mut body = d.body;
            let why = body.remove("error").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            Err(E::Held(why, body))
        }
    }
}

// ── the owner-inactive record (6.7) ──────────────────────────────────────────────────────────────────────────────

/// One org's record as held in memory: the listed principals (lower case) with `{at, provider, source}`, or a file
/// that exists but cannot be read, which counts every owner of the org inactive (fail closed).
#[derive(Clone)]
enum Owners {
    Listed(BTreeMap<String, Value>),
    Unreadable,
}

/// The records of each state folder, read once per org and kept in step with every write (only this file writes them).
static OWNERS: LazyLock<Mutex<HashMap<PathBuf, HashMap<String, Owners>>>> = LazyLock::new(Mutex::default);

fn owners_path(dir: &Path, org: &str) -> PathBuf {
    dir.join(OWNERS_DIR).join(format!("{org}.json"))
}

fn owners_load(dir: &Path, org: &str) -> Owners {
    let path = owners_path(dir, org);
    match std::fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Owners::Listed(BTreeMap::new()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("owners").and_then(Value::as_object).cloned()) {
            Some(o) => Owners::Listed(o.into_iter().collect()),
            None => {
                owners_unreadable(&path);
                Owners::Unreadable
            }
        },
        Err(_) => {
            owners_unreadable(&path);
            Owners::Unreadable
        }
    }
}

fn owners_unreadable(path: &Path) {
    let f = crate::log::Fields::new().with("file", path.display().to_string());
    crate::console_meet::logger().security("api.owners.unreadable", &f, crate::log::Level::Error);
}

fn principal_key(principal: &str) -> String {
    principal.trim().to_lowercase()
}

/// Whether `principal` is listed in the owner-inactive record of `org` under the state folder `dir`.
pub fn owner_inactive_in(dir: &Path, org: &str, principal: &str) -> bool {
    let p = principal_key(principal);
    if p.is_empty() || !org_ok(org) {
        return false;
    }
    let mut all = OWNERS.lock();
    let o = all.entry(dir.to_path_buf()).or_default().entry(org.to_string()).or_insert_with(|| owners_load(dir, org));
    match o {
        Owners::Listed(l) => l.contains_key(&p),
        Owners::Unreadable => true,
    }
}

/// 6.7 check 4 on this relay: `principal` is listed in the owner-inactive record of `org` of a Meeting Hub relay of
/// this process (its state folder, as registered with the fleet agent). Nothing is listed on a console.
pub fn owner_inactive(org: &str, principal: &str) -> bool {
    crate::fleet_agent::meet_state_dirs().iter().any(|d| owner_inactive_in(d, org, principal))
}

/// Change one org's record under the lock and flush it before Ok; an empty record removes the file.
fn owners_update(dir: &Path, org: &str, f: impl FnOnce(&mut BTreeMap<String, Value>)) -> Result<(), String> {
    if !org_ok(org) {
        return Err(format!("{org} is not an organization id"));
    }
    let mut all = OWNERS.lock();
    let held = all.entry(dir.to_path_buf()).or_default().entry(org.to_string()).or_insert_with(|| owners_load(dir, org));
    let mut list = match held {
        Owners::Listed(l) => l.clone(),
        Owners::Unreadable => BTreeMap::new(),
    };
    f(&mut list);
    let path = owners_path(dir, org);
    if list.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    } else {
        crate::store::make_dir(&dir.join(OWNERS_DIR)).map_err(|e| format!("{}: {e}", dir.join(OWNERS_DIR).display()))?;
        let body = json!({"org": org, "owners": Value::Object(list.clone().into_iter().collect())});
        crate::fleet_local::write_durable(&path, body.to_string().as_bytes())?;
    }
    *held = Owners::Listed(list);
    Ok(())
}

/// 6.7: the SSO service suspended `principal` in `org`: listed (flushed) before the suspension is answered. A later
/// `at` already listed is kept.
pub fn owner_deprovisioned(dir: &Path, org: &str, principal: &str, at: i64, provider: &str, source: &str) -> Result<(), String> {
    let p = principal_key(principal);
    owners_update(dir, org, |l| {
        if !l.get(&p).and_then(|e| e.get("at")).and_then(Value::as_i64).is_some_and(|old| old > at) {
            l.insert(p.clone(), json!({"at": at, "provider": provider, "source": source}));
        }
    })
}

/// 6.7: the SSO service lifted the suspension (or the signer refused a new one): the entry goes.
pub fn owner_reactivated(dir: &Path, org: &str, principal: &str) -> Result<(), String> {
    let p = principal_key(principal);
    owners_update(dir, org, |l| {
        l.remove(&p);
    })
}

/// 2.5 `api-person` `source` from a suspend body (`directory` when absent or unknown).
pub fn person_source(v: Option<&Value>) -> &'static str {
    let s = v.and_then(Value::as_str).unwrap_or_default();
    SOURCES.iter().copied().find(|x| *x == s).unwrap_or("directory")
}

/// `/v1/sso/c/suspend`: the owner is listed (flushed) before the certificate server is asked, so this relay's API
/// refuses the owner's clients at once; 500 when it cannot be written (the SSO service sends the suspension again).
/// Nothing on a relay without a state folder (it serves no API).
pub fn on_suspend(dir: Option<&Path>, org: &str, principal: &str, at: i64, provider: &str, source: &str) -> R<()> {
    let Some(dir) = dir else { return Ok(()) };
    owner_deprovisioned(dir, org, principal, at, provider, source).map_err(|e| E::Internal(format!("the API owner record could not be written: {e}")))
}

/// The certificate server refused a new suspension, which is undone: so is its owner entry.
pub fn on_suspend_undone(dir: Option<&Path>, org: &str, principal: &str) {
    let Some(dir) = dir else { return };
    if let Err(e) = owner_reactivated(dir, org, principal) {
        let f = crate::log::Fields::new().with("org", org).with("why", e);
        crate::console_meet::logger().security("api.owners.unsaved", &f, crate::log::Level::Error);
    }
}

/// Queue the `api-person` record of a suspension (`deprovisioned`) or a lift (`active`) for the console; 500 when the
/// outbox cannot take it (the SSO service sends it again).
pub fn on_person(dir: Option<&Path>, org: &str, principal: &str, deprovisioned: bool, at: i64, provider: &str, source: &str) -> R<()> {
    let Some(dir) = dir else { return Ok(()) };
    queue_person(dir, &person_record(org, principal, deprovisioned, at, provider, source)).map_err(|e| E::Internal(format!("the api-person record could not be queued: {e}")))
}

/// `/v1/sso/c/unsuspend` once the certificate server agreed: the owner entry goes and `active` is queued.
pub fn on_lift(dir: Option<&Path>, org: &str, principal: &str, at: i64, provider: &str, source: &str) -> R<()> {
    let Some(d) = dir else { return Ok(()) };
    owner_reactivated(d, org, principal).map_err(|e| E::Internal(format!("the API owner record could not be written: {e}")))?;
    on_person(dir, org, principal, false, at, provider, source)
}

// ── the `api-person` outbox (2.5) ────────────────────────────────────────────────────────────────────────────────

/// Appends and removals of the outboxes, one at a time.
static OUTBOX: LazyLock<Mutex<()>> = LazyLock::new(Mutex::default);

fn outbox_path(dir: &Path, org: &str) -> PathBuf {
    dir.join(OUTBOX_DIR).join(format!("{org}.jsonl"))
}

/// The 2.5 `api-person` body.
pub fn person_record(org: &str, principal: &str, deprovisioned: bool, at: i64, provider: &str, source: &str) -> Value {
    let state = if deprovisioned { "deprovisioned" } else { "active" };
    json!({"org": org, "principal": principal_key(principal), "state": state, "at": at, "provider": provider, "source": source})
}

/// Queue an `api-person` record: one line appended to the org's outbox and flushed before Ok.
pub fn queue_person(dir: &Path, record: &Value) -> Result<(), String> {
    let org = record.get("org").and_then(Value::as_str).filter(|o| org_ok(o)).ok_or_else(|| "an api-person record names its org".to_string())?;
    let line = record.to_string();
    let _one = OUTBOX.lock();
    let folder = dir.join(OUTBOX_DIR);
    crate::store::make_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let path = outbox_path(dir, org);
    let held = std::fs::read_to_string(&path).map(|t| t.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0);
    if held >= OUTBOX_MAX {
        return Err(format!("the api-person outbox of {org} is full"));
    }
    let mut o = std::fs::OpenOptions::new();
    o.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let r = (|| -> std::io::Result<()> {
        let mut f = o.open(&path)?;
        f.write_all(format!("{line}\n").as_bytes())?;
        f.sync_all()?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(&folder) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    r.map_err(|e| format!("{}: {e}", path.display()))
}

/// The oldest queued line of the first org (by name) that has one, with its org. A line that is no JSON object (a
/// torn append) is dropped on the way.
fn outbox_head(dir: &Path) -> Option<(String, String)> {
    let _one = OUTBOX.lock();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir.join(OUTBOX_DIR)).ok()?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    files.sort();
    for path in files {
        let Some(org) = path.file_stem().and_then(|s| s.to_str()).filter(|o| org_ok(o)).map(str::to_string) else { continue };
        let Ok(t) = std::fs::read_to_string(&path) else { continue };
        let lines: Vec<&str> = t.lines().filter(|l| !l.trim().is_empty()).collect();
        let good = lines.iter().position(|l| serde_json::from_str::<Value>(l).is_ok_and(|v| v.is_object()));
        if good != Some(0) {
            let rest: Vec<&str> = good.map_or_else(Vec::new, |g| lines[g..].to_vec());
            let _ = outbox_write(&path, &rest);
        }
        if let Some(g) = good {
            return Some((org, lines[g].to_string()));
        }
    }
    None
}

fn outbox_write(path: &Path, lines: &[&str]) -> Result<(), String> {
    if lines.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        };
    }
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    crate::fleet_local::write_durable(path, text.as_bytes())
}

/// The console acknowledged `line`: it leaves the org's outbox (only when it is still the oldest).
fn outbox_pop(dir: &Path, org: &str, line: &str) -> Result<(), String> {
    let _one = OUTBOX.lock();
    let path = outbox_path(dir, org);
    let t = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let lines: Vec<&str> = t.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.first() != Some(&line) {
        return Ok(());
    }
    outbox_write(&path, &lines[1..])
}

/// What the channel does after the console's answer to an `api-person` request.
#[derive(Debug, PartialEq, Eq)]
pub enum PersonStep {
    /// Acknowledged and removed: the next may go at once.
    Acked,
    /// Not taken now (a 5xx, a busy console, a removal that failed): the same record goes again on a later tick.
    Retry,
    /// Refused for good (400 `invalid`, 403 `org-not-served`): removed so it cannot hold the queue, with the code for
    /// the security log.
    Dropped(String),
    /// The console does not know `api-person`: nothing more until reconnect.
    Off,
}

/// One channel's `api-person` sender: one record in flight at a time, oldest first per org, only once the console's
/// reconnect catch-up ended with an accepted `api-synced`. A new channel starts a new sender, so a record whose
/// answer never came is sent again (the console ignores a record that is not newer than the one it holds).
#[derive(Default)]
pub struct PeopleShip {
    in_flight: Option<(u32, String, String, Instant)>,
    off: bool,
}

impl PeopleShip {
    /// The next `(org, line, body)` to send now, if any; an answer older than `timeout` is given up.
    pub fn next(&mut self, dir: &Path, caught_up: bool, timeout: Duration) -> Option<(String, String, Value)> {
        if self.in_flight.as_ref().is_some_and(|(_, _, _, at)| at.elapsed() > timeout) {
            self.in_flight = None;
        }
        if self.off || !caught_up || self.in_flight.is_some() {
            return None;
        }
        let (org, line) = outbox_head(dir)?;
        let body = serde_json::from_str::<Value>(&line).ok()?;
        Some((org, line, body))
    }

    /// The request `id` carries `line` of `org`.
    pub fn sent(&mut self, id: u32, org: String, line: String) {
        self.in_flight = Some((id, org, line, Instant::now()));
    }

    /// `id` is the request in flight.
    pub fn owns(&self, id: u32) -> bool {
        self.in_flight.as_ref().is_some_and(|(i, _, _, _)| *i == id)
    }

    /// The console's answer to the request in flight.
    pub fn answered(&mut self, dir: &Path, answer: Result<Value, Refusal>) -> PersonStep {
        let Some((_, org, line, _)) = self.in_flight.take() else { return PersonStep::Retry };
        match answer {
            Ok(_) => match outbox_pop(dir, &org, &line) {
                Ok(()) => PersonStep::Acked,
                Err(_) => PersonStep::Retry,
            },
            Err(r) if r.code == "fleet-op" => {
                self.off = true;
                PersonStep::Off
            }
            Err(r) if r.status == 400 || r.code == "org-not-served" => {
                let _ = outbox_pop(dir, &org, &line);
                PersonStep::Dropped(r.code)
            }
            Err(_) => PersonStep::Retry,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::{ApiAudit, CheckpointSigner, PseudonymKeys};
    use crate::api_map::VerifiedApiMap;
    use crate::api_token::Cnf;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    const NOW: i64 = 1_795_000_000;
    const I: &str = "https://console.acme.example:7443/api/orgs/acme";
    const S: &str = "https://sso.acme.example:8443/api/orgs/acme/scim/v2";
    /// The certificate-bound directory client's own SCIM resource (resources are unique across clients).
    const S2: &str = "https://sso2.acme.example:8443/api/orgs/acme/scim/v2";
    /// The `mtls_required` directory client's SCIM resource.
    const S3: &str = "https://sso3.acme.example:8443/api/orgs/acme/scim/v2";
    const MTLS: &str = "c_4e5f607182930415";
    const R1: &str = "r_00000000000000a1";
    const ENTRA: &str = "c_2c3d4e5f60718293";
    const BOUND: &str = "c_3d4e5f6071829304";
    const MAP_EXPIRES: i64 = NOW + 30 * 86_400;
    /// Fake leaf DER: the `mtls_required` client's two certificates (credentials A and B) and the bound client's.
    const CERT_A: &[u8] = b"test leaf A of c_4e5f607182930415";
    const CERT_B: &[u8] = b"test leaf B of c_4e5f607182930415";
    const CERT_BOB: &[u8] = b"test leaf of c_3d4e5f6071829304";
    const SPKI_A: &str = "abababababababababababababababababababababababababababababababab";
    const SPKI_B: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    const SPKI_BOB: &str = "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef";

    struct NoSigner;
    impl CheckpointSigner for NoSigner {
        fn kid(&self, _: &str) -> Option<String> {
            None
        }
        fn sign(&self, _: &str, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Keys;
    impl PseudonymKeys for Keys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![9; 32]))
        }
    }

    /// An audit log that cannot append.
    struct Broken;
    impl AuditLog for Broken {
        fn record(&self, _: &str, _: Value, _: i64) -> Result<u64, AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn refusal(&self, _: &str, _: &str, _: &str, _: &str, _: Value, _: i64) -> Result<(), AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn allowed_ok(&self) -> bool {
            true
        }
        fn read(&self, _: &str, _: &str, _: Repr, _: u64, _: usize) -> Result<Value, AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn keys(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp() -> Tmp {
        let d = std::env::temp_dir().join(format!("lucid-api-scim-{}", res::rid()));
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }

    fn client(id: &str, owner: &str, scopes: &[&str], resource: &str) -> Value {
        json!({"id": id, "name": "scim", "principal": format!("{id}@apps.acme.example"), "kind": "integration", "owner": owner,
               "reach": "R0", "scopes": scopes, "ceiling": "confidential", "relays": [R1], "networks": ["20.190.128.0/18"],
               "mtls_required": false, "rate": {"per_minute_each": 600, "per_day_each": 500_000}, "credentials": [],
               "directory": {"provider": "entra", "resource": resource, "domains": ["acme.example"]},
               "created": NOW - 86_400, "expires": NOW + 300 * 86_400, "state": "active"})
    }

    fn pin(store: &mut ApiMapStore, org: &str, issuer: &str, jwks: &[Value], clients: Value) {
        let map = json!({"v": 2, "org": org, "seq": 7, "issued": NOW - 60, "expires": MAP_EXPIRES,
                         "issuer": {"url": issuer, "jwks": jwks}, "relay_origins": {}, "clients": clients, "scrape_tokens": []});
        let hash = crate::api_map::api_map_hash(&map);
        let wire = json!({ "map": map }).as_object().unwrap().clone();
        store.pin(VerifiedApiMap { wire, org: org.into(), seq: 7, expires: MAP_EXPIRES, hash, signer: "root".into() }).unwrap();
    }

    /// `acme` governed (its Entra client and a certificate-bound client), `beta` with a read-only directory client
    /// (not governed), `gamma` served without a map, `delta` not served.
    struct Fx {
        key: EcdsaKeyPair,
        store: ApiMapStore,
        audit: Arc<ApiAudit>,
        broken: bool,
        owner: bool,
        service: String,
        dir: Tmp,
        /// Leaf certificates (fake DER) this relay would verify, with their facts.
        certs: Vec<(Vec<u8>, ClientCert)>,
        /// Leaves that no longer verify (revoked, expired, another issuer).
        untrusted: Vec<Vec<u8>>,
    }

    /// The base64url SHA-256 of a leaf (`x5t#S256`).
    fn thumb(der: &[u8]) -> String {
        crate::codec::b64u(&crate::codec::sha256(der))
    }

    /// Standard base64 of a leaf, as the SSO service forwards it.
    fn std64(der: &[u8]) -> String {
        let mut s: String = crate::codec::b64u(der).chars().map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        }).collect();
        while s.len() % 4 != 0 {
            s.push('=');
        }
        s
    }

    /// The facts of a verified app certificate of `client` with `serial` and SPKI hash `spki`.
    fn leaf(der: &[u8], client: &str, serial: &str, spki: &str) -> ClientCert {
        ClientCert {
            sha256_b64u: thumb(der),
            serial: serial.into(),
            spki_sha256: spki.into(),
            not_after: NOW + 86_400,
            chain_ok: true,
            kind: "app".into(),
            principal: format!("{client}@apps.acme.example"),
            orgs: vec!["acme".into()],
        }
    }

    impl Fx {
        fn new() -> Fx {
            Fx::with(|_| {})
        }

        /// The fixture with `edit` applied to acme's clients before they are pinned.
        fn with(edit: impl Fn(&mut Vec<Value>)) -> Fx {
            let key = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
            let jwks = vec![crate::api_issue::ec_public_jwk(&key, "k1")];
            let mut store = ApiMapStore::load(None);
            let mut mtls = client(MTLS, "dee@acme.example", &[READ, WRITE], S3);
            mtls["mtls_required"] = json!(true);
            mtls["credentials"] = json!([{"type": "mtls", "serial": "0a1b2c", "spki": SPKI_A}, {"type": "mtls", "serial": "0a1b2d", "spki": SPKI_B}]);
            let mut bound = client(BOUND, "bob@acme.example", &[READ, WRITE], S2);
            bound["credentials"] = json!([{"type": "mtls", "serial": "0b0b01", "spki": SPKI_BOB}]);
            let mut acme = vec![client(ENTRA, "ann@acme.example", &[READ, WRITE], S), bound, mtls];
            edit(&mut acme);
            pin(&mut store, "acme", I, &jwks, Value::Array(acme));
            let beta_s = "https://sso.beta.example:8443/api/orgs/beta/scim/v2";
            pin(&mut store, "beta", "https://console.beta.example:7443/api/orgs/beta", &jwks, json!([client("c_0000000000000b01", "cy@beta.example", &[READ], beta_s)]));
            let dir = tmp();
            let audit = Arc::new(ApiAudit::open(Some(dir.0.as_path()), R1, Arc::new(NoSigner), Arc::new(Keys), NOW));
            let certs = vec![
                (CERT_A.to_vec(), leaf(CERT_A, MTLS, "0a1b2c", SPKI_A)),
                (CERT_B.to_vec(), leaf(CERT_B, MTLS, "0a1b2d", SPKI_B)),
                (CERT_BOB.to_vec(), leaf(CERT_BOB, BOUND, "0b0b01", SPKI_BOB)),
            ];
            Fx { key, store, audit, broken: false, owner: true, service: format!("sso-{}", res::rid()), dir, certs, untrusted: Vec::new() }
        }

        /// A body for `resource` forwarding the leaf `der` as the SSO service does (both fields).
        fn with_leaf(&self, resource: &str, method: &str, authorization: &str, der: &[u8]) -> Obj {
            let mut b = self.body_at(resource, method, authorization);
            b.insert("client_cert".into(), json!(std64(der)));
            b.insert("client_cert_sha256".into(), json!(thumb(der)));
            b
        }

        /// A console token of `client` for its own SCIM resource.
        fn token(&self, client: &str, scopes: &[&str], cnf: Cnf) -> String {
            let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
            let aud = match client {
                BOUND => S2,
                MTLS => S3,
                _ => S,
            };
            let t = tok::mint_access_token(&self.key, "k1", I, aud, client, "acme", &scopes, "R0", "confidential", 7, &cnf, NOW - 10, NOW + 590).unwrap();
            format!("Bearer {}", t.token)
        }

        fn body(&self, method: &str, authorization: &str) -> Obj {
            self.body_at(S, method, authorization)
        }

        fn body_at(&self, resource: &str, method: &str, authorization: &str) -> Obj {
            obj(json!({"org": "acme", "provider": "entra", "resource": resource, "method": method, "path": "/Users/5e1c0f2a9b8d7e6f?x=1",
                       "authorization": authorization, "ip": "20.190.129.10"}))
        }

        fn run(&self, b: &Obj) -> Decision {
            check(self, &self.service, b, NOW).unwrap()
        }

        fn entries(&self, org: &str) -> Vec<Value> {
            let mut all = Vec::new();
            for repr in Repr::ALL {
                all.extend(self.audit.read(org, R1, repr, 0, 1000).map(|p| p["entries"].as_array().cloned().unwrap_or_default()).unwrap_or_default());
            }
            all
        }

        fn as_is(&self, org: &str) -> Vec<Value> {
            self.audit.read(org, R1, Repr::AsIs, 0, 1000).map(|p| p["entries"].as_array().cloned().unwrap_or_default()).unwrap_or_default()
        }
    }

    impl CheckSide for Fx {
        fn relay_id(&self) -> Option<String> {
            Some(R1.into())
        }
        fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
            ["acme", "beta", "gamma"].contains(&org).then(|| self.store.org_snapshot(org))
        }
        fn owner_active(&self, _: &str) -> bool {
            self.owner
        }
        fn licensed(&self) -> bool {
            true
        }
        fn audit(&self) -> Option<Arc<dyn AuditLog>> {
            if self.broken {
                Some(Arc::new(Broken))
            } else {
                Some(self.audit.clone() as Arc<dyn AuditLog>)
            }
        }
        fn dir(&self) -> Option<&Path> {
            Some(&self.dir.0)
        }
        fn client_cert(&self, der: &[u8], _: i64) -> Option<ClientCert> {
            if self.untrusted.iter().any(|u| u == der) {
                return None;
            }
            self.certs.iter().find(|(d, _)| d == der).map(|(_, c)| c.clone())
        }
    }

    fn code(d: &Decision) -> (u16, Option<bool>, u64, String) {
        (d.status, d.body.get("allow").and_then(Value::as_bool), d.body.get("status").and_then(Value::as_u64).unwrap_or(0), d.body.get("code").and_then(Value::as_str).unwrap_or("ok").to_string())
    }

    #[test]
    fn a_governed_request_is_allowed_and_audited_before_the_answer() {
        let fx = Fx::new();
        let auth = fx.token(ENTRA, &[READ, WRITE], Cnf::None);
        let d = fx.run(&fx.body("PATCH", &auth));
        assert_eq!(code(&d), (200, Some(true), 0, "ok".into()), "{:?}", d.body);
        assert_eq!(d.body["client"], json!(ENTRA));
        assert_eq!(d.body["scopes"], json!([READ, WRITE]));
        assert_eq!(d.body["directory"], json!({"provider": "entra", "domains": ["acme.example"]}));
        assert_eq!(d.body["unbound"], json!(true));
        assert_eq!(d.body["governed"], json!({"acme": {"governed": true, "seq": 7}}));
        let calls: Vec<Value> = fx.as_is("acme").into_iter().filter(|e| e["action"] == "api.call").collect();
        assert_eq!(calls.len(), 1);
        let e = &calls[0];
        assert_eq!((e["route"].as_str(), e["method"].as_str(), e["op"].as_str(), e["client"].as_str()), (Some("scim"), Some("PATCH"), Some("update"), Some(ENTRA)));
        assert_eq!((e["rid"].as_str(), e["scope"].as_str(), e["resource"].as_str()), (d.body["rid"].as_str(), Some(WRITE), Some(S)));
        assert!(e["jti"].as_str().is_some_and(|j| !j.is_empty()));
    }

    #[test]
    fn each_governed_refusal_carries_its_status_and_code() {
        let fx = Fx::new();
        // a resource no client of the map names
        let mut b = fx.body("GET", &fx.token(ENTRA, &[READ, WRITE], Cnf::None));
        b.insert("resource".into(), json!("https://evil.example:8443/api/orgs/acme/scim/v2"));
        assert_eq!(code(&fx.run(&b)), (200, Some(false), 404, "not-found".into()));
        // a write with a read-only token
        assert_eq!(code(&fx.run(&fx.body("POST", &fx.token(ENTRA, &[READ], Cnf::None)))), (200, Some(false), 403, "scope".into()));
        // a DPoP-bound token without its proof
        assert_eq!(code(&fx.run(&fx.body_at(S2, "GET", &fx.token(BOUND, &[READ], Cnf::Jkt("AAAA".into()))))), (200, Some(false), 401, "token".into()));
        // a token of another directory client presented at this resource
        assert_eq!(code(&fx.run(&fx.body("GET", &fx.token(BOUND, &[READ], Cnf::None)))), (200, Some(false), 401, "token".into()));
        // a caller outside the client's networks
        let mut b = fx.body("GET", &fx.token(ENTRA, &[READ], Cnf::None));
        b.insert("ip".into(), json!("198.51.100.9"));
        assert_eq!(code(&fx.run(&b)), (200, Some(false), 403, "network".into()));
        // a token for another resource
        let other = tok::mint_access_token(&fx.key, "k1", I, I, ENTRA, "acme", &[READ.to_string()], "R0", "confidential", 7, &Cnf::None, NOW, NOW + 300).unwrap();
        assert_eq!(code(&fx.run(&fx.body("GET", &format!("Bearer {}", other.token)))), (200, Some(false), 401, "token".into()));
        // no allowed decision was recorded
        assert!(fx.as_is("acme").iter().all(|e| e["action"] != "api.call"));
    }

    #[test]
    fn an_owner_the_sso_service_suspended_is_refused_at_once_without_the_console() {
        let fx = Fx::new();
        let auth = fx.token(ENTRA, &[READ, WRITE], Cnf::None);
        assert_eq!(code(&fx.run(&fx.body("GET", &auth))).1, Some(true));
        owner_deprovisioned(&fx.dir.0, "acme", "Ann@acme.example", NOW, "entra", "scim").unwrap();
        // flushed to its file before the suspension is answered
        let file: Value = serde_json::from_slice(&std::fs::read(owners_path(&fx.dir.0, "acme")).unwrap()).unwrap();
        assert_eq!(file["owners"]["ann@acme.example"], json!({"at": NOW, "provider": "entra", "source": "scim"}));
        assert_eq!(code(&fx.run(&fx.body("GET", &auth))), (200, Some(false), 403, "owner".into()));
        let refusal = fx.as_is("acme").into_iter().find(|e| e["action"] == "api.refusal" && e["check"] == "owner").expect("the owner refusal is in the chain");
        assert_eq!((refusal["route"].as_str(), refusal["client"].as_str()), (Some("scim"), Some(ENTRA)));
        // another owner's client still works; a lift clears the entry
        let other = fx.with_leaf(S2, "GET", &fx.token(BOUND, &[READ], Cnf::X5t(thumb(CERT_BOB))), CERT_BOB);
        assert_eq!(code(&fx.run(&other)).1, Some(true));
        owner_reactivated(&fx.dir.0, "acme", "ann@acme.example").unwrap();
        assert!(!owner_inactive_in(&fx.dir.0, "acme", "ann@acme.example"));
        assert!(!owners_path(&fx.dir.0, "acme").exists());
        assert_eq!(code(&fx.run(&fx.body("GET", &auth))).1, Some(true));
    }

    #[test]
    fn an_older_suspension_never_replaces_a_newer_one() {
        let dir = tmp();
        owner_deprovisioned(&dir.0, "acme", "ann@acme.example", NOW, "entra", "directory").unwrap();
        owner_deprovisioned(&dir.0, "acme", "ann@acme.example", NOW - 100, "entra", "scim").unwrap();
        let file: Value = serde_json::from_slice(&std::fs::read(owners_path(&dir.0, "acme")).unwrap()).unwrap();
        assert_eq!(file["owners"]["ann@acme.example"]["at"], json!(NOW));
        assert!(owner_deprovisioned(&dir.0, "../x", "ann@acme.example", NOW, "entra", "scim").is_err(), "an org id names the file");
    }

    #[test]
    fn audit_failure_answers_503_and_allows_nothing() {
        let mut fx = Fx::new();
        fx.broken = true;
        let d = fx.run(&fx.body("PATCH", &fx.token(ENTRA, &[READ, WRITE], Cnf::None)));
        assert_eq!(d.status, 503);
        assert_eq!(d.body.get("code").and_then(Value::as_str), Some("audit-unavailable"));
        assert!(d.body.get("allow").is_none());
        // a refusal that cannot be recorded is 503 too
        let d = fx.run(&fx.body("POST", &fx.token(ENTRA, &[READ], Cnf::None)));
        assert_eq!((d.status, d.body.get("allow").is_none()), (503, true));
        // and a legacy decision for an org with a map
        let d = fx.run(&obj(json!({"orgs": ["beta"], "provider": "okta", "legacy": {"token_id": "okta-acme"}, "method": "GET", "path": "/Users", "ip": "198.51.100.1"})));
        assert_eq!(d.status, 503);
    }

    #[test]
    fn the_authorization_value_is_never_in_the_chain() {
        let fx = Fx::new();
        let auth = fx.token(ENTRA, &[READ, WRITE], Cnf::None);
        fx.run(&fx.body("PATCH", &auth));
        owner_deprovisioned(&fx.dir.0, "acme", "ann@acme.example", NOW, "entra", "scim").unwrap();
        fx.run(&fx.body("PATCH", &auth));
        let token = auth.trim_start_matches("Bearer ");
        let signature = token.rsplit('.').next().unwrap();
        let all = fx.entries("acme");
        assert!(all.len() >= 2);
        for e in all {
            let s = e.to_string();
            assert!(!s.contains(token) && !s.contains(signature), "{s}");
            assert!(e.get("authorization").is_none());
        }
    }

    #[test]
    fn legacy_tokens_are_refused_for_any_governed_or_unserved_org() {
        let fx = Fx::new();
        let legacy = |orgs: Value| obj(json!({"orgs": orgs, "provider": "okta", "legacy": {"token_id": "okta-tok"}, "method": "GET", "path": "/Users?filter=x", "ip": "198.51.100.1"}));
        // not governed: a map without directory.write, and an org without a map
        let d = fx.run(&legacy(json!(["beta", "gamma"])));
        assert_eq!(d.status, 200);
        assert_eq!(d.body, obj(json!({"allow": true, "governed": {"beta": {"governed": false, "seq": 7}, "gamma": {"governed": false, "seq": 0}}})));
        // a token bound to a governed and a non-governed org is refused for every request
        let d = fx.run(&legacy(json!(["beta", "acme"])));
        assert_eq!((d.status, d.body["code"].as_str(), d.body["allow"].as_bool()), (403, Some("scim-governed"), Some(false)));
        assert_eq!(d.body["governed"]["acme"], json!({"governed": true, "seq": 7}));
        // an org this relay does not serve
        let d = fx.run(&legacy(json!(["beta", "delta"])));
        assert_eq!((d.status, d.body["code"].as_str()), (403, Some("org-not-served")));
        // each decision is in the chain of every listed org with a map, with the token id and never a token
        let beta: Vec<Value> = fx.as_is("beta").into_iter().filter(|e| e["auth"] == "legacy").collect();
        assert_eq!(beta.len(), 3);
        assert_eq!((beta[0]["result"].as_str(), beta[0]["token_id"].as_str(), beta[0]["route"].as_str(), beta[0]["op"].as_str()), (Some("ok"), Some("okta-tok"), Some("scim"), Some("read")));
        assert_eq!((beta[1]["result"].as_str(), beta[1]["check"].as_str(), beta[1]["status"].as_u64()), (Some("refused"), Some("scim-governed"), Some(403)));
        assert_eq!(beta[2]["check"].as_str(), Some("org-not-served"));
        assert_eq!(fx.as_is("acme").iter().filter(|e| e["auth"] == "legacy").count(), 1);
        assert!(fx.as_is("gamma").is_empty(), "an org without a map has no chain entry");
        // malformed bodies are 400
        assert!(check(&fx, &fx.service, &legacy(json!([])), NOW).is_err());
        assert!(check(&fx, &fx.service, &legacy(json!(["beta", "beta"])), NOW).is_err());
    }

    /// Revision 4 15 and 19.2 catastrophe: with the console off the relay still decides for a sender-constrained
    /// client holding a console token issued before the outage (nothing here reaches the console).
    #[test]
    fn a_certificate_bound_client_is_decided_with_the_console_off() {
        let fx = Fx::new();
        let auth = fx.token(BOUND, &[READ, WRITE], Cnf::X5t(thumb(CERT_BOB)));
        let d = fx.run(&fx.with_leaf(S2, "DELETE", &auth, CERT_BOB));
        assert_eq!(code(&d), (200, Some(true), 0, "ok".into()), "{:?}", d.body);
        assert_eq!(d.body["unbound"], json!(false));
        assert_eq!(d.body["client"], json!(BOUND));
        // without the certificate the bound token is refused
        assert_eq!(code(&fx.run(&fx.body_at(S2, "DELETE", &auth))), (200, Some(false), 401, "token".into()));
    }

    /// An `mtls_required` directory client passes only with the forwarded certificate verified and matching an `mtls`
    /// credential exactly; a hash alone never authenticates it.
    #[test]
    fn an_mtls_required_client_needs_its_verified_certificate() {
        let fx = Fx::new();
        let hash_only = |auth: &str, der: &[u8]| {
            let mut b = fx.body_at(S3, "PATCH", auth);
            b.insert("client_cert_sha256".into(), json!(thumb(der)));
            b
        };
        let bound = fx.token(MTLS, &[READ, WRITE], Cnf::X5t(thumb(CERT_A)));
        let d = fx.run(&fx.with_leaf(S3, "PATCH", &bound, CERT_A));
        assert_eq!(code(&d), (200, Some(true), 0, "ok".into()), "{:?}", d.body);
        assert_eq!((d.body["client"].as_str(), d.body["unbound"].as_bool()), (Some(MTLS), Some(false)));
        // the hash alone binds the token but never stands for the certificate
        assert_eq!(code(&fx.run(&hash_only(&bound, CERT_A))), (200, Some(false), 403, "mtls".into()));
        // a token not bound to a certificate, with only the hash or with nothing
        let unbound = fx.token(MTLS, &[READ, WRITE], Cnf::None);
        assert_eq!(code(&fx.run(&hash_only(&unbound, CERT_A))), (200, Some(false), 403, "mtls".into()));
        assert_eq!(code(&fx.run(&fx.body_at(S3, "PATCH", &unbound))), (200, Some(false), 403, "mtls".into()));
        // a DPoP-bound token never stands for the certificate (refused at its binding first)
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &fx.token(MTLS, &[READ, WRITE], Cnf::Jkt("AAAA".into())), CERT_A))).3, "token");
        // the bound token with the client's other certificate, or none
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &bound, CERT_B))), (200, Some(false), 401, "token".into()));
        assert_eq!(code(&fx.run(&fx.body_at(S3, "PATCH", &bound))), (200, Some(false), 401, "token".into()));
        // a forwarded leaf whose hash disagrees, or that is not base64, is a malformed body
        let mut b = fx.with_leaf(S3, "PATCH", &bound, CERT_A);
        b.insert("client_cert_sha256".into(), json!(thumb(CERT_B)));
        assert!(check(&fx, &fx.service, &b, NOW).is_err());
        b.insert("client_cert".into(), json!("not base64!"));
        b.remove("client_cert_sha256");
        assert!(check(&fx, &fx.service, &b, NOW).is_err());
    }

    /// The token is matched to the exact credential of its certificate: with two `mtls` credentials, a token bound to
    /// credential A's certificate is refused once A is gone from the pinned map while B stays usable, once every `mtls`
    /// credential is dropped by the journal, and once A's certificate is revoked or expired; B's own token still works.
    #[test]
    fn a_token_whose_own_mtls_credential_is_gone_is_refused_while_another_stays_usable() {
        let token_a = |fx: &Fx| fx.token(MTLS, &[READ, WRITE], Cnf::X5t(thumb(CERT_A)));
        let token_b = |fx: &Fx| fx.token(MTLS, &[READ, WRITE], Cnf::X5t(thumb(CERT_B)));
        // A removed from the signed map, B kept
        let fx = Fx::with(|clients| {
            for c in clients.iter_mut().filter(|c| c["id"] == MTLS) {
                c["credentials"] = json!([{"type": "mtls", "serial": "0a1b2d", "spki": SPKI_B}]);
            }
        });
        let d = fx.run(&fx.with_leaf(S3, "PATCH", &token_a(&fx), CERT_A));
        assert_eq!(code(&d), (200, Some(false), 403, "mtls".into()), "{:?}", d.body);
        let refusal = fx.as_is("acme").into_iter().find(|e| e["action"] == "api.refusal" && e["check"] == "mtls").expect("the refusal is in the chain");
        assert_eq!((refusal["route"].as_str(), refusal["client"].as_str()), (Some("scim"), Some(MTLS)));
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_b(&fx), CERT_B))).1, Some(true));
        // the same certificate of A presented with a token bound to B's certificate: refused at the binding
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_b(&fx), CERT_A))).3, "token");
        // every mtls credential dropped by the journal (drops of mtls credentials go by type)
        let mut fx = Fx::new();
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_a(&fx), CERT_A))).1, Some(true));
        let drop = json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW - 10, "action": "client_drop_credential", "target": {"client": MTLS, "type": "mtls"}});
        fx.store.apply_tighten("acme", &drop).unwrap();
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_a(&fx), CERT_A))), (200, Some(false), 403, "mtls".into()));
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_b(&fx), CERT_B))), (200, Some(false), 403, "mtls".into()));
        // A's certificate revoked or expired (it no longer verifies): A refused, B still works
        let mut fx = Fx::new();
        fx.untrusted.push(CERT_A.to_vec());
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_a(&fx), CERT_A))), (200, Some(false), 403, "mtls".into()));
        assert_eq!(code(&fx.run(&fx.with_leaf(S3, "PATCH", &token_b(&fx), CERT_B))).1, Some(true));
        // a client that is not mtls_required gets the same rule for its certificate-bound tokens
        fx.untrusted.push(CERT_BOB.to_vec());
        let bob = fx.token(BOUND, &[READ], Cnf::X5t(thumb(CERT_BOB)));
        assert_eq!(code(&fx.run(&fx.with_leaf(S2, "GET", &bob, CERT_BOB))), (200, Some(false), 403, "mtls".into()));
    }

    #[test]
    fn api_person_records_reach_the_console_in_order_across_reconnects() {
        let dir = tmp();
        for (i, p) in ["a@acme.example", "b@acme.example", "c@acme.example"].iter().enumerate() {
            queue_person(&dir.0, &person_record("acme", p, i != 1, NOW + i as i64, "entra", "scim")).unwrap();
        }
        queue_person(&dir.0, &person_record("beta", "d@beta.example", true, NOW, "entra", "directory")).unwrap();
        let wait = Duration::from_secs(30);
        // nothing before reconnect sync
        let mut ship = PeopleShip::default();
        assert!(ship.next(&dir.0, false, wait).is_none());
        // the first goes; the channel drops before the answer
        let (org, line, body) = ship.next(&dir.0, true, wait).unwrap();
        assert_eq!((org.as_str(), body["principal"].as_str(), body["state"].as_str()), ("acme", Some("a@acme.example"), Some("deprovisioned")));
        ship.sent(1, org, line);
        assert!(ship.next(&dir.0, true, wait).is_none(), "one in flight at a time");
        // a new channel sends the same record again, then the rest in order
        let mut ship = PeopleShip::default();
        let mut got = Vec::new();
        let mut id = 10;
        while let Some((org, line, body)) = ship.next(&dir.0, true, wait) {
            got.push(format!("{} {} {}", org, body["principal"].as_str().unwrap(), body["state"].as_str().unwrap()));
            ship.sent(id, org, line);
            assert!(ship.owns(id) && !ship.owns(id + 1));
            assert_eq!(ship.answered(&dir.0, Ok(json!({"ok": true}))), PersonStep::Acked);
            id += 1;
        }
        assert_eq!(got, ["acme a@acme.example deprovisioned", "acme b@acme.example active", "acme c@acme.example deprovisioned", "beta d@beta.example deprovisioned"]);
        assert!(!outbox_path(&dir.0, "acme").exists() && !outbox_path(&dir.0, "beta").exists());
    }

    #[test]
    fn a_console_without_the_op_or_failing_keeps_the_outbox() {
        let dir = tmp();
        queue_person(&dir.0, &person_record("acme", "a@acme.example", true, NOW, "entra", "scim")).unwrap();
        let wait = Duration::from_secs(30);
        let mut ship = PeopleShip::default();
        let (org, line, _) = ship.next(&dir.0, true, wait).unwrap();
        ship.sent(1, org, line);
        assert_eq!(ship.answered(&dir.0, Err(Refusal::new(503, "console-busy", "later"))), PersonStep::Retry);
        let (org, line, _) = ship.next(&dir.0, true, wait).unwrap();
        ship.sent(2, org, line);
        assert_eq!(ship.answered(&dir.0, Err(Refusal::of("fleet-op"))), PersonStep::Off);
        assert!(ship.next(&dir.0, true, wait).is_none());
        assert!(outbox_path(&dir.0, "acme").exists());
        // a torn last line is dropped, the good one before it stays
        std::fs::OpenOptions::new().append(true).open(outbox_path(&dir.0, "acme")).unwrap().write_all(b"{\"org\": \"acme\", \"princ").unwrap();
        let mut ship = PeopleShip::default();
        let (_, _, body) = ship.next(&dir.0, true, wait).unwrap();
        assert_eq!(body["principal"].as_str(), Some("a@acme.example"));
    }

    #[test]
    fn person_sources_default_to_directory() {
        assert_eq!(person_source(Some(&json!("scim"))), "scim");
        assert_eq!(person_source(Some(&json!("signin"))), "signin");
        assert_eq!(person_source(Some(&json!("other"))), "directory");
        assert_eq!(person_source(None), "directory");
    }

    #[test]
    fn op_follows_the_method() {
        assert_eq!(["POST", "GET", "PUT", "PATCH", "DELETE"].map(op_of), ["create", "read", "update", "update", "delete"]);
        assert_eq!(ROWS.iter().filter(|r| r.scope == READ).map(|r| r.method).collect::<Vec<_>>(), ["GET"]);
        assert!(ROWS.iter().all(|r| r.reach == "R0" && r.class == "confidential" && r.pipeline == Pipeline::Resource));
    }
}
