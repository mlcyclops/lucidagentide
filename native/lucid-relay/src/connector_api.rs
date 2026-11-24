// Contract API-1 revision 5 (phase 1c), sections 5.3 and 7.1 to 7.6: the connector's REST routes under
// C = `<origin>/api/orgs/<org>` (the origin only from this connector's `connectors[]` entry, never a Host header),
// their pipeline "Connector resource" (5.3 checks 0 to 14, adapted from `api_resource::authorize`), the RFC 9728
// documents of C and CM, the OpenAPI 3.1 document of this route table, idempotent posts and content events.
//
// Checks, in order: 0 the source limiter (before any JWT or DPoP work); 1 has no license step here (the map's
// edition is the console's); 2 the map (`api_issue::closed`), then 503 `connector-stale` when the last full sync is
// older than `stale_s`, then 403 `suspended` (the connector's `state` or `connector_suspend`); 3 the console-profile
// token (`aud` C, DPoP `htu` = origin + path, the connector's owner rule), 401 `expired` when every app the client
// may use is past its certificate's end, and 503 `connector-stale` without the client's id key (5.5, R5-20); 4 adds
// the local Stop list and `person_revoke` (403 `person`); 5 the client limiter; 6 scope; 7 reach R1; 8 the
// visibility of 5.2 (404 `not-found`, the same body as an unknown cid); 9 the route's class against the ceiling (a
// conversation's own class is step 7 of 5.2, so it is 404 too); 10 the client's networks and every `client_limit`,
// `connectors[].networks` and `connector_limit` (403 `network`), hours, `mtls_required` (this listener takes no
// client certificate: 403 `mtls`); 11 the client's rate; then for a post 12 the post rate, 13 the approval caps and
// 14 the approval (`connector_approvals`).
//
// 9.4: every decision is in the connector's chain before its answer: `api.call` or `api.refusal` with `resource` =
// the connector id and the 12.2 fields `person`, `app`, `conv`, `items`, `approval`; never text, file names, search
// queries or conversation names. An append that fails answers 503 `audit-unavailable`.

use crate::api_cjournal as cj;
use crate::api_delegated::{connector_mcp_resource, connector_metadata, connector_resource, www_authenticate};
use crate::api_issue::{self, Limit};
use crate::api_resource::{self as res, AuditLog, Reply};
use crate::api_token::{self as tok, Grant, JtiCache, Profile};
use crate::codec::{hex, sha256};
use crate::connector::Connector;
use crate::connector_approvals::{self as appr, Approvals, Ask};
use crate::connector_events::{ContentEvents, Noted, WAIT_MAX_S};
use crate::connector_mcp as cm;
use crate::connector_notice::Notices;
use crate::connector_seal::{names, SecretKey};
use crate::connector_session::{AppSession, ContentKind, NOT_KEPT, NO_SUCH_FILE, STOP_EXPIRED};
use crate::connector_store::{StoreError, StoredMessage, DAY_MS};
use crate::connector_sync::SyncState;
use crate::connector_view::{self as view, Faces, Ground, Shown, Who};
use crate::mcp;
use crate::meet::log_warn;
use crate::meet_org_policy::{lp, Obj};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The largest request body the listener reads.
pub const BODY_MAX: usize = 32 * 1024;
/// 7.1: the largest file served (larger: 413 `file-too-large`).
pub const FILE_MAX: u64 = 25 << 20;
/// 7.1: a post's text, in characters.
pub const TEXT_MAX: usize = 4000;
/// 7.1: `Idempotency-Key` results are kept this long.
pub const IDEMPOTENCY_MS: i64 = DAY_MS;
/// 5.3 check 12: posts per client and conversation in a minute (and at most one a second).
pub const POSTS_PER_MINUTE: usize = 30;
/// Records one listing reads at most before it answers with `next`.
const SCAN_MAX: usize = 2000;
const PAGE: usize = 200;
const KEYS_MAX: usize = 10_000;
const READ: &str = "content.read";
const POST: &str = "content.post";
const NOT_FOUND: &str = "Nothing is here.";
const STALE_WHY: &str = "This connector has not synced with the console recently enough to answer; try again later.";
const PAGE_WORDS: &str = "Approve this in Meeting Hub or on your iPhone";

/// One request as the listener read it.
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    /// The body as read (None for GET); Err("too-large") past BODY_MAX, any other Err a body that could not be read.
    pub body: Option<Result<&'a [u8], &'static str>>,
    pub source: IpAddr,
    pub now_ms: i64,
}

/// One answer; `headers` include `Content-Type`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[cfg(test)]
impl Answer {
    /// The first header named `name` (any case).
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// The body as JSON (Null when it is not).
    pub(crate) fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

fn answer_of(r: Reply) -> Answer {
    let mut headers = vec![("Content-Type".to_string(), r.ctype.to_string())];
    headers.extend(r.headers.iter().map(|(k, v)| (k.to_string(), v.clone())));
    Answer { status: r.status, headers, body: r.bytes() }
}

fn json_answer(status: u16, body: &Value) -> Answer {
    answer_of(Reply::json(status, body.clone()))
}

// ── the route table (7.1) ────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RouteId {
    Metadata,
    McpMetadata,
    OpenApi,
    Health,
    Conversations,
    Conversation,
    Messages,
    Post,
    Files,
    File,
    Search,
    Mentions,
    Approval,
    ApprovalPage,
    Events,
    /// Revision 5 8.2: `POST CM`, never a row of `ROUTES` (its decisions are audited under `MCP_ROUTES`).
    Mcp,
    /// Revision 6 7.2.2: the RFC 9728 metadata of A = C/a2a.
    A2aMetadata,
    /// Revision 6 7.3: an A2A route under A (a row of `A2A_ROUTES`, served by `connector_a2a`).
    A2a,
}

/// One route: method, path pattern (`{org}`, `{cid}`, `{fid}`, `{id}` one segment each), scope (empty: public),
/// the route's own data class (empty: the class of each conversation, 5.2 step 7) and summary.
struct Route {
    id: RouteId,
    method: &'static str,
    path: &'static str,
    scope: &'static str,
    class: &'static str,
    summary: &'static str,
}

const fn route(id: RouteId, method: &'static str, path: &'static str, scope: &'static str, class: &'static str, summary: &'static str) -> Route {
    Route { id, method, path, scope, class, summary }
}

static ROUTES: [Route; 16] = [
    route(RouteId::Metadata, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}", "", "public", "RFC 9728 metadata of this connector's REST resource (C)."),
    route(RouteId::McpMetadata, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}/mcp", "", "public", "RFC 9728 metadata of this connector's MCP resource (CM)."),
    route(RouteId::A2aMetadata, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}/a2a", "", "public", "RFC 9728 metadata of this connector's A2A resource (A)."),
    route(RouteId::OpenApi, "GET", "/api/orgs/{org}/v1/openapi.json", "", "public", "This document."),
    route(RouteId::Health, "GET", "/api/orgs/{org}/v1/health", READ, "internal", "The connector, its last sync and its apps."),
    route(RouteId::Conversations, "GET", "/api/orgs/{org}/v1/content/conversations", READ, "", "The visible conversations."),
    route(RouteId::Conversation, "GET", "/api/orgs/{org}/v1/content/conversations/{cid}", READ, "", "One visible conversation."),
    route(RouteId::Messages, "GET", "/api/orgs/{org}/v1/content/conversations/{cid}/messages", READ, "", "Messages of a visible conversation, newest first."),
    route(RouteId::Post, "POST", "/api/orgs/{org}/v1/content/conversations/{cid}/messages", POST, "", "Post as the API app (or ask the person to approve it first)."),
    route(RouteId::Files, "GET", "/api/orgs/{org}/v1/content/conversations/{cid}/files", READ, "", "Files of a visible conversation."),
    route(RouteId::File, "GET", "/api/orgs/{org}/v1/content/conversations/{cid}/files/{fid}", READ, "", "A file's bytes (at most 25 MiB)."),
    route(RouteId::Search, "GET", "/api/orgs/{org}/v1/content/search", READ, "", "Keyword search over the visible conversations."),
    route(RouteId::Mentions, "GET", "/api/orgs/{org}/v1/content/mentions", READ, "", "Messages that mention the delegated person or the app."),
    route(RouteId::Approval, "GET", "/api/orgs/{org}/v1/content/approvals/{id}", POST, "", "An approval this client and person asked for."),
    route(RouteId::ApprovalPage, "GET", "/api/orgs/{org}/v1/content/approvals/{id}/page", "", "public", "A page that tells the person where to approve."),
    route(RouteId::Events, "GET", "/api/orgs/{org}/v1/content/events", READ, "", "Content events of visible conversations (long poll)."),
];

/// Revision 5 8.2: the rows CM's decisions are audited under, one per scope (checks 6 and 9 judge that scope).
static MCP_ROUTES: [Route; 2] = [
    route(RouteId::Mcp, "POST", "/api/orgs/{org}/mcp", READ, "", "Connector MCP (content.read)."),
    route(RouteId::Mcp, "POST", "/api/orgs/{org}/mcp", POST, "", "Connector MCP (content.post)."),
];

/// Revision 6 7.3: the A2A rows of A = C/a2a (`connector_a2a` serves them after checks 0 to 11 here). Scope
/// `spokes.tasks.submit`, reach R1, data class the task class (judged per task, 7.4 A6, so the row's own is empty).
const A2A: &str = crate::connector_a2a_wire::SCOPE;
const A2A_TASK: &str = "/api/orgs/{org}/a2a/{agent}/tasks/{id}";
static A2A_ROUTES: [Route; 12] = [
    route(RouteId::A2a, "POST", "/api/orgs/{org}/a2a/{agent}/message:send", A2A, "", "SendMessage (A2A 1.0): a new task held for a person's approval, or a follow-up turn."),
    route(RouteId::A2a, "POST", "/api/orgs/{org}/a2a/{agent}/message:stream", A2A, "", "SendStreamingMessage: as message:send, answered as an SSE stream of StreamResponse."),
    route(RouteId::A2a, "GET", A2A_TASK, A2A, "", "GetTask: the task with its artifacts and history."),
    route(RouteId::A2a, "GET", "/api/orgs/{org}/a2a/{agent}/tasks", A2A, "", "ListTasks: this client's tasks of this agent, newest status first."),
    route(RouteId::A2a, "POST", "/api/orgs/{org}/a2a/{agent}/tasks/{id}:cancel", A2A, "", "CancelTask."),
    route(RouteId::A2a, "GET", "/api/orgs/{org}/a2a/{agent}/tasks/{id}:subscribe", A2A, "", "SubscribeToTask (the proto binding): an SSE stream."),
    route(RouteId::A2a, "POST", "/api/orgs/{org}/a2a/{agent}/tasks/{id}:subscribe", A2A, "", "SubscribeToTask (the prose binding): an SSE stream."),
    route(RouteId::A2a, "POST", "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs", A2A, "", "CreateTaskPushNotificationConfig."),
    route(RouteId::A2a, "GET", "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs", A2A, "", "ListTaskPushNotificationConfigs."),
    route(RouteId::A2a, "GET", "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs/{config}", A2A, "", "GetTaskPushNotificationConfig (credentials never returned)."),
    route(RouteId::A2a, "DELETE", "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs/{config}", A2A, "", "DeleteTaskPushNotificationConfig."),
    route(RouteId::A2a, "GET", "/api/orgs/{org}/a2a/{agent}/extendedAgentCard", A2A, "", "GetExtendedAgentCard: UnsupportedOperationError (no extended card in 1d)."),
];

/// The A2A 1.0 object each A2A row answers (OpenAPI `x-a2a-response`).
fn a2a_object(method: &str, path: &str) -> &'static str {
    match (method, path.rsplit('/').next().unwrap_or_default()) {
        (_, "message:send") => "SendMessageResponse",
        (_, "message:stream" | "{id}:subscribe") => "StreamResponse (text/event-stream)",
        ("GET", "tasks") => "ListTasksResponse",
        ("GET", "{id}") | (_, "{id}:cancel") => "Task",
        ("GET", "pushNotificationConfigs") => "ListTaskPushNotificationConfigsResponse",
        ("DELETE", _) => "google.protobuf.Empty",
        (_, "pushNotificationConfigs" | "{config}") => "TaskPushNotificationConfig",
        _ => "AgentCard",
    }
}

#[derive(Default)]
struct Params {
    org: String,
    cid: String,
    fid: String,
    id: String,
    /// Revision 5 9.4: the route runs for an MCP tool at CM (never set by a REST path), so a post's key is kept
    /// `cm::POST_WINDOW_MS` from its first request.
    mcp: bool,
}

fn fit(pattern: &str, path: &str) -> Option<Params> {
    let mut out = Params::default();
    let (mut p, mut s) = (pattern.split('/'), path.split('/'));
    loop {
        match (p.next(), s.next()) {
            (None, None) => return (!out.org.is_empty()).then_some(out),
            (Some(slot @ ("{org}" | "{cid}" | "{fid}" | "{id}")), Some(x)) if !x.is_empty() => {
                let v = api_issue::unescape(x)?;
                match slot {
                    "{org}" => out.org = v,
                    "{cid}" => out.cid = v,
                    "{fid}" => out.fid = v,
                    _ => out.id = v,
                }
            }
            (Some(a), Some(b)) if a == b => {}
            _ => return None,
        }
    }
}

fn route_of(method: &str, path: &str) -> Option<(&'static Route, Params)> {
    ROUTES.iter().filter(|r| r.method == method).find_map(|r| fit(r.path, path).map(|p| (r, p)))
}

/// A query parameter (the first), form-decoded; None when absent or not decodable.
fn param(query: &str, k: &str) -> Option<String> {
    query.split('&').filter_map(|p| p.split_once('=')).find(|(a, _)| *a == k).and_then(|(_, v)| api_issue::unescape(v))
}

fn ip_of(source: IpAddr) -> String {
    crate::console_source::canonical(source).to_string()
}

fn hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ── refusals and the chain ───────────────────────────────────────────────────────────────────────────────────

/// A refusal before it is audited and answered.
struct No {
    status: u16,
    code: &'static str,
    why: String,
    retry: Option<i64>,
    /// A member added to the problem body (`check` of `approval-refused`).
    extra: Option<(&'static str, Value)>,
}

fn no(status: u16, code: &'static str, why: impl Into<String>) -> No {
    No { status, code, why: why.into(), retry: None, extra: None }
}

impl No {
    fn retry(self, s: i64) -> No {
        No { retry: Some(s.max(1)), ..self }
    }
}

fn not_found() -> No {
    no(404, "not-found", NOT_FOUND)
}

fn wait_of(l: Limit) -> i64 {
    match l {
        Limit::Wait(s) => s,
        Limit::Full => 60,
    }
}

fn store_no(e: StoreError) -> No {
    match e {
        StoreError::Stopped(_) => not_found(),
        StoreError::Invalid(_) => no(400, "bad-request", "That is not a valid request."),
        StoreError::Io(m) => {
            log_warn(&format!("connector_store_read_failed error={m}"));
            no(503, "unavailable", "The content store cannot answer now; try again later.")
        }
    }
}

fn limit_of(query: &str, default: usize, max: usize) -> Result<usize, No> {
    match param(query, "limit") {
        None => Ok(default),
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=max).contains(n)).ok_or_else(|| no(400, "bad-request", format!("limit must be a number from 1 to {max}."))),
    }
}

fn ms_param(query: &str, k: &str) -> Result<Option<i64>, No> {
    match param(query, k) {
        None => Ok(None),
        Some(v) => v.parse::<i64>().map(Some).map_err(|_| no(400, "bad-request", format!("{k} must be a time in ms."))),
    }
}

/// What an allowed call or refusal adds to its entry (12.2).
#[derive(Default)]
struct Facts {
    conv: Option<String>,
    app: Option<String>,
    items: Option<usize>,
    approval: Option<String>,
    replayed: bool,
    /// Revision 5 12.2: the MCP tool (or `resource:` name) of a call at CM.
    tool: Option<&'static str>,
}

/// The authenticated caller.
struct Caller {
    grant: Grant,
    client: Obj,
    kind: String,
    name: String,
    key: [u8; 32],
}

impl Caller {
    fn who(&self) -> Who<'_> {
        Who { id: &self.grant.client, client: &self.client, kind: &self.kind, person: self.grant.person.as_deref(), ceiling: &self.grant.ceiling }
    }

    /// The token's `sub`: the delegated person, else the client.
    fn sub(&self) -> &str {
        self.grant.person.as_deref().unwrap_or(&self.grant.client)
    }

    fn faces<'g>(&'g self, g: &'g Ground) -> Faces<'g> {
        Faces { key: self.key, person: self.grant.person.as_deref(), ground: g }
    }
}

/// One request's context.
struct Ctx<'a> {
    req: &'a Request<'a>,
    route: &'static Route,
    p: Params,
    rid: String,
    now_s: i64,
    /// C, from this connector's `connectors[]` entry.
    resource: Option<String>,
}

impl Ctx<'_> {
    fn route_name(&self) -> String {
        format!("{} {}", self.route.method, self.route.path.replace("{org}", &self.p.org))
    }

    fn entry(&self, action: &str) -> Map<String, Value> {
        let mut e = Map::new();
        e.insert("rid".into(), json!(self.rid));
        e.insert("action".into(), json!(action));
        e.insert("route".into(), json!(self.route_name()));
        e.insert("ip".into(), json!(ip_of(self.req.source)));
        e
    }
}

fn add_facts(e: &mut Map<String, Value>, caller: Option<&Caller>, f: &Facts) {
    if let Some(p) = caller.and_then(|c| c.grant.person.as_deref()) {
        e.insert("person".into(), json!(p));
    }
    if let Some(v) = &f.app {
        e.insert("app".into(), json!(v));
    }
    if let Some(v) = &f.conv {
        e.insert("conv".into(), json!(v));
    }
    if let Some(v) = f.items {
        e.insert("items".into(), json!(v));
    }
    if let Some(v) = &f.approval {
        e.insert("approval".into(), json!(v));
    }
    if let Some(v) = f.tool {
        e.insert("tool".into(), json!(v));
    }
}

// ── limiters (6.5, 5.3 check 12) ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Limiters {
    sources: Mutex<HashMap<String, VecDeque<i64>>>,
    public: Mutex<HashMap<String, VecDeque<i64>>>,
    clients: Mutex<HashMap<String, VecDeque<i64>>>,
    rate: Mutex<HashMap<String, VecDeque<i64>>>,
    daily: Mutex<HashMap<String, VecDeque<(i64, u64)>>>,
    /// Post times (ms) per client and conversation.
    posts: Mutex<HashMap<String, VecDeque<i64>>>,
}

impl Limiters {
    /// 5.3 check 12: at most one post a second and 30 a minute; Err is `Retry-After` seconds.
    fn post(&self, key: &str, now_ms: i64) -> Result<(), i64> {
        let mut m = self.posts.lock();
        if m.len() >= KEYS_MAX && !m.contains_key(key) {
            m.retain(|_, q| q.back().is_some_and(|t| now_ms - t < 60_000));
            if m.len() >= KEYS_MAX {
                return Err(60);
            }
        }
        let q = m.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now_ms - t >= 60_000) {
            q.pop_front();
        }
        if q.back().is_some_and(|t| now_ms - t < 1000) {
            return Err(1);
        }
        if q.len() >= POSTS_PER_MINUTE {
            return Err(q.front().map_or(60, |f| (f + 60_000 - now_ms).div_euclid(1000)).max(1));
        }
        q.push_back(now_ms);
        Ok(())
    }
}

// ── idempotency (7.1) ────────────────────────────────────────────────────────────────────────────────────────

/// One `Idempotency-Key` result: hashes and ids only.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Idem {
    /// Hex SHA-256 of lp(client, sub, key).
    key: String,
    /// Hex SHA-256 of lp(cid, thread, text).
    body: String,
    at: i64,
    status: u16,
    conv: String,
    mid: Option<String>,
    approval: Option<String>,
}

impl Idem {
    fn to_value(&self) -> Value {
        json!({"key": self.key, "body": self.body, "at": self.at, "status": self.status, "conv": self.conv, "mid": self.mid, "approval": self.approval})
    }

    fn from_value(v: &Value) -> Option<Idem> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Idem {
            key: s("key")?,
            body: s("body")?,
            at: v.get("at").and_then(Value::as_i64)?,
            status: v.get("status").and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok())?,
            conv: s("conv")?,
            mid: s("mid"),
            approval: s("approval"),
        })
    }
}

fn digest(parts: &[&str]) -> String {
    let bytes: Vec<&[u8]> = parts.iter().map(|p| p.as_bytes()).collect();
    hex(&sha256(&lp(&bytes)))
}

// ── the API ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The connector's REST routes (7.1) behind the "Connector resource" pipeline (5.3).
pub struct ConnectorApi {
    conn: Arc<Connector>,
    sync: Arc<SyncState>,
    audit: Arc<dyn AuditLog>,
    approvals: Arc<Approvals>,
    events: Arc<ContentEvents>,
    /// Revision 5 6.3: the delegation notices (`dlgn`), queued after a delegated token passes checks 0 to 11 and sent
    /// by their own worker (`start_notices`).
    notices: Arc<Notices>,
    lim: Limiters,
    dpop: Mutex<JtiCache>,
    idem: Mutex<Vec<Idem>>,
    inflight: Mutex<HashSet<String>>,
    /// Revision 5 8.4: the sealed MCP state key, read or made on first use.
    mcp_key: Mutex<Option<crate::connector_seal::SecretKey>>,
    /// Revision 5 8.4: approvals sealed `posting` when this process started (`interrupted_posts`).
    interrupted: HashSet<String>,
    /// Revision 6 7.2: the A2A server under A (set once by `serve`).
    a2a: std::sync::OnceLock<Arc<crate::connector_a2a::A2aServer>>,
}

impl ConnectorApi {
    pub fn new(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<dyn AuditLog>, approvals: Arc<Approvals>, events: Arc<ContentEvents>) -> ConnectorApi {
        let idem = match conn.shared.sealed.get(names::IDEMPOTENCY) {
            Ok(v) => v.as_ref().and_then(|v| v.get("records")).and_then(Value::as_array).into_iter().flatten().filter_map(Idem::from_value).collect(),
            Err(e) => {
                log_warn(&format!("connector_idempotency_not_read error={e}"));
                Vec::new()
            }
        };
        let interrupted = interrupted_posts(&conn);
        let notices = Arc::new(Notices::new(conn.clone(), audit.clone()));
        ConnectorApi {
            conn,
            sync,
            audit,
            approvals,
            events,
            notices,
            lim: Limiters::default(),
            dpop: Mutex::new(JtiCache::dpop()),
            idem: Mutex::new(idem),
            inflight: Mutex::new(HashSet::new()),
            mcp_key: Mutex::new(None),
            interrupted,
            a2a: std::sync::OnceLock::new(),
        }
    }

    /// Revision 5 6.3: start the delegation notices' worker (`clock` gives the time in ms).
    pub fn start_notices(&self, clock: Box<dyn Fn() -> i64 + Send>) -> Result<(), String> {
        self.notices.start(clock)
    }

    /// The delegation notices (tests run their worker's step themselves).
    #[cfg(test)]
    pub(crate) fn notices(&self) -> &Arc<Notices> {
        &self.notices
    }

    /// One request, blocking (audit fsync, store reads, relay sends, long polls up to 30 s).
    pub fn answer(&self, req: &Request) -> Answer {
        let rid = res::rid();
        let mut a = self.dispatch(req, &rid);
        a.headers.push(("X-Lucid-Request-Id".into(), rid));
        a
    }

    fn dispatch(&self, req: &Request, rid: &str) -> Answer {
        let org = self.sync.org().to_string();
        let now_s = req.now_ms.div_euclid(1000);
        let Some((route, p)) = route_of(req.method, req.path) else {
            let reply = res::problem(404, "not-found", NOT_FOUND);
            if res::org_of(req.path) != Some(org.as_str()) {
                return answer_of(reply);
            }
            let name = res::namespace_route(req.method, &org);
            return answer_of(res::public_refused(Some(&*self.audit), &org, &name, rid, req.source, reply, now_s));
        };
        if p.org != org {
            return answer_of(res::problem(404, "not-found", NOT_FOUND));
        }
        let resource = self.sync.connector().and_then(|e| e.get("origin").and_then(Value::as_str).map(|o| connector_resource(o, &org)));
        let c = Ctx { req, route, p, rid: rid.to_string(), now_s, resource };
        if route.scope.is_empty() {
            return self.public(&c);
        }
        self.resource(&c)
    }

    // ── public routes ────────────────────────────────────────────────────────────────────────────────────────

    fn public(&self, c: &Ctx) -> Answer {
        let org = &c.p.org;
        let charged = api_issue::take(&self.lim.public, &crate::console_source::source_key(c.req.source), res::PUBLIC_PER_MINUTE, c.now_s);
        if let Err(l) = charged {
            let mut r = res::problem(429, "abuse", "Too many requests from this address; try again later.");
            r.headers.push(("Retry-After", wait_of(l).to_string()));
            return answer_of(res::public_refused(Some(&*self.audit), org, &c.route_name(), &c.rid, c.req.source, r, c.now_s));
        }
        match c.route.id {
            RouteId::Metadata | RouteId::McpMetadata | RouteId::A2aMetadata => {
                let store = self.sync.store();
                let issuer = store.get(org, "").and_then(|m| m.map().get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).map(str::to_string));
                let entry = self.sync.connector();
                let (Some(issuer), Some(entry)) = (issuer, entry) else { return answer_of(res::problem(404, "not-found", NOT_FOUND)) };
                let origin = entry.get("origin").and_then(Value::as_str).unwrap_or_default();
                let label = self.conn.trust().own_pin().and_then(|p| p.policy.get("label").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| org.clone());
                let name = entry.get("name").and_then(Value::as_str).unwrap_or_default();
                let doc = match c.route.id {
                    RouteId::Metadata => connector_metadata(&issuer, &connector_resource(origin, org), &label, name),
                    RouteId::McpMetadata => connector_metadata(&issuer, &connector_mcp_resource(origin, org), &label, name),
                    _ => crate::api_delegated::a2a_metadata(&issuer, &crate::api_delegated::connector_a2a_resource(origin, org), &label, name),
                };
                let mut r = Reply::json(200, doc);
                r.headers = vec![("Cache-Control", "max-age=300".into())];
                answer_of(r)
            }
            RouteId::OpenApi => {
                let store = self.sync.store();
                let issuer = store.get(org, "").and_then(|m| m.map().get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
                let mut r = Reply::json(200, openapi(org, c.resource.as_deref().unwrap_or_default(), &issuer));
                r.headers = vec![("Cache-Control", "max-age=300".into())];
                answer_of(r)
            }
            _ => {
                let id = &c.p.id;
                let word = match self.approvals.get(id).filter(|_| hex32(id)) {
                    None => "expired",
                    Some(a) => match a.state_at(c.req.now_ms) {
                        appr::state::WAITING => "waiting",
                        appr::state::EXPIRED => "expired",
                        _ => "done",
                    },
                };
                let html = format!(
                    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Lucid approval</title></head>\n<body><p>{PAGE_WORDS}</p><p>{word}</p></body></html>\n"
                );
                Answer {
                    status: 200,
                    headers: vec![
                        ("Content-Type".into(), "text/html; charset=utf-8".into()),
                        ("Content-Security-Policy".into(), "default-src 'none'; frame-ancestors 'none'".into()),
                        ("Cache-Control".into(), "no-store".into()),
                        ("X-Content-Type-Options".into(), "nosniff".into()),
                    ],
                    body: html.into_bytes(),
                }
            }
        }
    }

    // ── the chain ────────────────────────────────────────────────────────────────────────────────────────────

    /// 9.4: the refusal into the connector's refusal summaries, then its answer; 503 `audit-unavailable` when it
    /// cannot be recorded.
    fn refuse(&self, c: &Ctx, caller: Option<&Caller>, claimed: Option<&str>, f: &Facts, n: No) -> Answer {
        let mut e = c.entry("api.refusal");
        e.insert("result".into(), json!("refused"));
        e.insert("check".into(), json!(n.code));
        e.insert("status".into(), json!(n.status));
        e.insert("count".into(), json!(1));
        e.insert("scope".into(), json!(c.route.scope));
        e.insert("resource".into(), json!(self.sync.connector_id()));
        let client = caller.map(|x| x.grant.client.as_str()).or(claimed);
        if let Some(cl) = client {
            e.insert("client".into(), json!(cl));
        }
        if let Some(x) = caller {
            e.insert("jti".into(), json!(x.grant.jti));
        }
        add_facts(&mut e, caller, f);
        let key = client.map_or_else(|| format!("ip:{}", crate::console_source::source_key(c.req.source)), str::to_string);
        if self.audit.refusal(&c.p.org, &key, n.code, &c.route_name(), Value::Object(e), c.now_s).is_err() {
            return answer_of(res::audit_unavailable());
        }
        crate::api_catalog::counters::connector_request(&c.p.org, "refused");
        let mut r = res::problem(n.status, n.code, &n.why);
        if let Some((k, v)) = n.extra {
            r.body[k] = v;
        }
        if let Some(s) = n.retry {
            r.headers.push(("Retry-After", s.to_string()));
        }
        if n.status == 401 || n.code == "scope" {
            let resource = c.resource.clone().unwrap_or_default();
            let error = match (n.status, c.req.authorization.is_some()) {
                (401, true) => Some("invalid_token"),
                (401, false) => None,
                _ => Some("insufficient_scope"),
            };
            r.headers.push(("WWW-Authenticate", www_authenticate(&resource, &[c.route.scope], error)));
        }
        answer_of(r)
    }

    /// 9.4: the allowed call is appended before the answer leaves; 503 otherwise.
    fn finish(&self, c: &Ctx, caller: &Caller, f: &Facts, a: Answer) -> Answer {
        if !self.audit.allowed_ok() {
            return answer_of(res::audit_unavailable());
        }
        let mut e = c.entry("api.call");
        e.insert("client".into(), json!(caller.grant.client));
        e.insert("scope".into(), json!(c.route.scope));
        e.insert("resource".into(), json!(self.sync.connector_id()));
        e.insert("result".into(), json!(if f.replayed { "replayed" } else { "ok" }));
        e.insert("check".into(), json!("none"));
        e.insert("status".into(), json!(a.status));
        e.insert("bytes_out".into(), json!(a.body.len()));
        e.insert("count".into(), json!(1));
        e.insert("jti".into(), json!(caller.grant.jti));
        add_facts(&mut e, Some(caller), f);
        if self.audit.record(&c.p.org, Value::Object(e), c.now_s).is_err() {
            return answer_of(res::audit_unavailable());
        }
        crate::api_catalog::counters::connector_request(&c.p.org, if f.replayed { "replayed" } else { "ok" });
        a
    }

    // ── 5.3 checks 0 to 11 ───────────────────────────────────────────────────────────────────────────────────

    fn authorize(&self, c: &Ctx, g: &Ground, target: &Target) -> Result<(Caller, Option<Arc<AppSession>>), Answer> {
        self.charge(c)?;
        self.checked(c, g, target)
    }

    /// 5.3 check 0, before any JWT or DPoP work: the source limiter.
    fn charge(&self, c: &Ctx) -> Result<(), Answer> {
        match api_issue::take(&self.lim.sources, &crate::console_source::source_key(c.req.source), res::RESOURCE_PER_MINUTE, c.now_s) {
            Ok(_) => Ok(()),
            Err(l) => Err(self.refuse(c, None, None, &Facts::default(), no(429, "abuse", "Too many requests from this address; try again later.").retry(wait_of(l)))),
        }
    }

    /// 5.3 checks 1 to 11 after `charge`.
    fn checked(&self, c: &Ctx, g: &Ground, target: &Target) -> Result<(Caller, Option<Arc<AppSession>>), Answer> {
        let (org, now) = (c.p.org.as_str(), c.now_s);
        let none = Facts::default();
        let refuse0 = |n: No| self.refuse(c, None, None, &none, n);
        // 2
        if let Some(code) = api_issue::closed(&g.store, org, now) {
            let status = if matches!(code, "map-expired" | "journal-unknown") { 401 } else { 403 };
            return Err(refuse0(no(status, code, api_issue::closed_why(code))));
        }
        let (Some(resource), true) = (c.resource.as_deref(), self.sync.fresh(c.req.now_ms)) else {
            return Err(refuse0(no(503, "connector-stale", STALE_WHY)));
        };
        if !g.connector_active() {
            return Err(refuse0(no(403, "suspended", "This connector is suspended.")));
        }
        // 3
        let Some(token) = access_token(c.req.authorization) else {
            return Err(refuse0(no(401, "token", "The request carries no access token.")));
        };
        let claimed = tok::parse_jws(token).and_then(|j| j.claims.get("client_id").and_then(Value::as_str).map(str::to_string));
        let Some(profile) = Profile::console(&g.store, org) else {
            return Err(refuse0(no(401, "token", "The organization's api map names no issuer.")));
        };
        // the origin of C or CM (revision 5 8.2: CM = C/mcp, its own `aud`)
        let origin = resource.split_once(&format!("/api/orgs/{org}")).map_or(resource, |(o, _)| o);
        let htu = format!("{origin}{}", c.req.path);
        let dpop = c.req.dpop.map(|p| (p, c.route.method, htu.as_str()));
        let owner_ok = |p: &str| g.owner_active(p);
        let pin = self.conn.trust().own_pin();
        let verdict = tok::validate_access_token(token, &profile, resource, now, &g.store, org, pin.as_ref().map(|p| &p.policy), &owner_ok, None, dpop, &mut self.dpop.lock());
        let grant = match verdict {
            Ok(gr) => gr,
            Err(e) => {
                let (status, code) = token_refusal(e.code);
                let who = claimed.as_deref().filter(|_| matches!(code, "suspended" | "owner" | "person"));
                return Err(self.refuse(c, None, who, &none, no(status, code, api_issue::sentence(&e.message))));
            }
        };
        let Some(client) = g.client(&grant.client).cloned() else {
            return Err(self.refuse(c, None, Some(&grant.client), &none, no(403, "suspended", "That client is not registered.")));
        };
        let kind = client.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
        let name = client.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut caller = Caller { grant, client, kind, name, key: [0; 32] };
        let apps = view::client_apps(&self.conn, g, &caller.who());
        if !apps.is_empty() && apps.iter().all(|s| s.serving() == Err(STOP_EXPIRED)) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(401, "expired", "The API app's certificate is past its end.")));
        }
        let Some(key) = self.sync.client_key(&caller.grant.client) else {
            return Err(self.refuse(c, Some(&caller), None, &none, no(503, "connector-stale", STALE_WHY)));
        };
        caller.key = key;
        // 4: the person's own Stop and person_revoke (the token pipeline also judged denied and the published list)
        if let Some(p) = caller.grant.person.clone() {
            if self.sync.locally_denied(&caller.grant.client, &p) || cj::person_revoked(&g.console, &caller.grant.client, &p) {
                return Err(self.refuse(c, Some(&caller), None, &none, no(403, "person", "That person no longer delegates to this client.")));
            }
        }
        // 5
        let ckey = format!("{org} {}", caller.grant.client);
        if let Err(l) = api_issue::take(&self.lim.clients, &ckey, res::CLIENT_PER_MINUTE, now) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(429, "abuse", "This client sent too many requests; try again later.").retry(wait_of(l))));
        }
        // 6
        if !caller.grant.scopes.iter().any(|s| s == c.route.scope) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "scope", format!("This route needs the {} scope.", c.route.scope))));
        }
        // 7
        if caller.grant.reach != "R1" {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "reach", "This route is outside the client's reach.")));
        }
        // 8
        let session = match target {
            Target::None => None,
            Target::Cid(cid) => {
                let f = Facts { conv: Some(cid.to_string()).filter(|c| !c.is_empty()), ..Facts::default() };
                match view::visible(&self.conn, g, &caller.who(), cid) {
                    Ok(s) => Some(s),
                    Err(_) => return Err(self.refuse(c, Some(&caller), None, &f, not_found())),
                }
            }
        };
        // 9: the route's own class (a conversation's is 5.2 step 7)
        let rank = tok::rank(&caller.grant.ceiling).unwrap_or(0);
        if rank == 0 || (!c.route.class.is_empty() && rank < tok::rank(c.route.class).unwrap_or(0)) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "ceiling", "The data of this route is above the client's ceiling.")));
        }
        // 10
        let source = c.req.source;
        let inside = |list: &[String]| list.iter().filter_map(|n| crate::console_source::parse_cidr(n).ok()).any(|x| x.contains(source));
        let own: Vec<String> = g.entry.as_ref().map(|e| tok::names(e, "networks").map(str::to_string).collect()).unwrap_or_default();
        let network_ok = tok::source_allowed(&caller.client, g.active(), &caller.grant.client, source)
            && (own.is_empty() || inside(own.as_slice()))
            && cj::connector_networks(&g.console, &g.connector_id).iter().all(|l| inside(l.as_slice()));
        if !network_ok {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "network", "This client may not call from that address.")));
        }
        if caller.client.get("hours").is_some_and(|h| !api_issue::inside_hours(h, now)) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "hours", "This client may not call at this time.")));
        }
        if caller.client.get("mtls_required").and_then(Value::as_bool) == Some(true) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(403, "mtls", "This client must present its certificate, which this connector does not take.")));
        }
        // 11
        let per = |k: &str| tok::rate_of(&caller.client, g.active(), &caller.grant.client, k);
        let (per_minute, per_day) = (per("per_minute_each"), per("per_day_each"));
        if let Err(l) = api_issue::take(&self.lim.rate, &ckey, usize::try_from(per_minute).unwrap_or(usize::MAX), now) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(429, "rate", "This client is over its rate; see Retry-After.").retry(wait_of(l))));
        }
        if let Err(l) = api_issue::take_daily(&self.lim.daily, &ckey, per_day, now) {
            return Err(self.refuse(c, Some(&caller), None, &none, no(429, "rate", "This client is over its daily rate; see Retry-After.").retry(wait_of(l))));
        }
        // 6.3: the person's delegation notice, the first time a token of theirs for this client passes here; only
        // queued (its worker posts it), so it never slows or refuses the request
        if caller.kind == "agent_delegated" {
            if let Some(p) = caller.grant.person.as_deref() {
                self.notices.first_use(org, &caller.grant.client, &caller.name, p, &caller.grant.scopes, &caller.grant.jti, &apps);
            }
        }
        Ok((caller, session))
    }

    fn resource(&self, c: &Ctx) -> Answer {
        let g = Ground::of(&self.conn, &self.sync, c.req.now_ms);
        // the approval a GET names: only the client and person that asked know it exists
        let mut approval = None;
        let target = match c.route.id {
            RouteId::Conversation | RouteId::Messages | RouteId::Post | RouteId::Files | RouteId::File => Target::Cid(c.p.cid.clone()),
            RouteId::Approval => match self.approvals.get(&c.p.id) {
                Some(a) => {
                    let conv = a.conv.clone();
                    approval = Some(a);
                    Target::Cid(conv)
                }
                None => Target::Cid(String::new()),
            },
            _ => Target::None,
        };
        let (caller, session) = match self.authorize(c, &g, &target) {
            Ok(x) => x,
            Err(a) => return a,
        };
        let mut f = Facts::default();
        if let Target::Cid(cid) = &target {
            f.conv = Some(cid.clone()).filter(|c| !c.is_empty());
        }
        if let Some(s) = &session {
            f.app = Some(s.principal().0);
        }
        let served = self.serve_route(c, &g, &caller, session, approval, &mut f);
        match served {
            Ok(a) => self.finish(c, &caller, &f, a),
            Err(n) => self.refuse(c, Some(&caller), None, &f, n),
        }
    }

    /// The route handler of `c.route` after its checks (the REST routes, and the one route of an MCP tool).
    fn serve_route(&self, c: &Ctx, g: &Ground, caller: &Caller, session: Option<Arc<AppSession>>, approval: Option<appr::Approval>, f: &mut Facts) -> Result<Answer, No> {
        match (c.route.id, session) {
            (RouteId::Health, _) => Ok(json_answer(200, &self.health(c))),
            (RouteId::Conversations, _) => self.conversations(c, g, caller, f),
            (RouteId::Search, _) => self.search(c, g, caller, f),
            (RouteId::Mentions, _) => self.mentions(c, g, caller, f),
            (RouteId::Events, _) => self.events_poll(c, g, caller, f),
            (RouteId::Conversation, Some(s)) => Ok(json_answer(200, &json!({"conversation": view::conversation(g, &s, &c.p.cid)}))),
            (RouteId::Messages, Some(s)) => self.messages(c, g, caller, &s, f),
            (RouteId::Files, Some(s)) => self.files(c, g, caller, &s, f),
            (RouteId::File, Some(s)) => self.file(c, caller, &s, f),
            (RouteId::Post, Some(s)) => self.post(c, g, caller, &s, f),
            (RouteId::Approval, Some(s)) => match approval.filter(|a| a.client == caller.grant.client && a.sub == caller.sub()) {
                Some(a) => self.approval(c, g, caller, &s, &a, f),
                None => Err(not_found()),
            },
            _ => Err(not_found()),
        }
    }

    // ── the routes ───────────────────────────────────────────────────────────────────────────────────────────

    fn health(&self, c: &Ctx) -> Value {
        let (seq, tseq, _) = self.sync.heads();
        let last = self.sync.last_sync_ms();
        let age = if last > 0 { (c.req.now_ms - last).div_euclid(1000).max(0) } else { -1 };
        let apps: Vec<Value> = self
            .conn
            .sessions
            .values()
            .map(|s| {
                let st = s.status();
                let end = st.get("certificate_end").and_then(Value::as_i64).unwrap_or(0);
                json!({"principal": st.get("principal").cloned().unwrap_or(Value::Null), "state": st.get("serving").cloned().unwrap_or(Value::Null),
                       "cert_days": (end - c.req.now_ms).div_euclid(DAY_MS)})
            })
            .collect();
        json!({"ok": true, "connector": {"id": self.sync.connector_id(), "version": env!("CARGO_PKG_VERSION")}, "sync": {"age_s": age, "seq": seq, "tseq": tseq}, "apps": apps})
    }

    /// The visible conversations of every app (5.2), each cid once.
    fn visible_all(&self, g: &Ground, caller: &Caller) -> BTreeMap<String, Arc<AppSession>> {
        let who = caller.who();
        let mut out = BTreeMap::new();
        for s in self.conn.sessions.values() {
            for info in s.conversations() {
                if out.contains_key(&info.cid) {
                    continue;
                }
                if let Ok(v) = view::visible(&self.conn, g, &who, &info.cid) {
                    out.insert(info.cid, v);
                }
            }
        }
        out
    }

    fn conversations(&self, c: &Ctx, g: &Ground, caller: &Caller, f: &mut Facts) -> Result<Answer, No> {
        let limit = limit_of(c.req.query, 100, 1000)?;
        let after = param(c.req.query, "next").unwrap_or_default();
        let all = self.visible_all(g, caller);
        let rest: Vec<(&String, &Arc<AppSession>)> = all.iter().filter(|(cid, _)| after.is_empty() || cid.as_str() > after.as_str()).collect();
        let page: Vec<Value> = rest.iter().take(limit).map(|(cid, s)| view::conversation(g, s, cid)).collect();
        let next = if rest.len() > limit { json!(rest[limit - 1].0) } else { Value::Null };
        f.items = Some(page.len());
        Ok(json_answer(200, &json!({"conversations": page, "next": next})))
    }

    /// A message cursor from a message id or a time in ms.
    fn cursor(&self, s: &AppSession, cid: &str, v: Option<String>) -> Result<Option<(i64, String)>, No> {
        let Some(v) = v else { return Ok(None) };
        if let Ok(t) = v.parse::<i64>() {
            return Ok(Some((t, String::new())));
        }
        match self.conn.store().get(&s.app, cid, &v).map_err(store_no)? {
            Some(m) => Ok(Some((m.ts, m.mid))),
            None => Err(no(400, "bad-request", "That cursor is not a message of this conversation.")),
        }
    }

    /// Walk a conversation newest first from `before`, at most `SCAN_MAX` records, handing each shown message to
    /// `take` until it says stop. Ok is the cursor to continue from when the walk stopped early.
    fn walk(&self, s: &AppSession, cid: &str, before: Option<(i64, String)>, shown: &Shown, mut take: impl FnMut(&StoredMessage) -> bool) -> Result<Option<String>, No> {
        let store = self.conn.store();
        let mut cursor = before;
        let mut scanned = 0usize;
        loop {
            let page = store.page(&s.app, cid, cursor.as_ref().map(|(t, m)| (*t, m.as_str())), PAGE).map_err(store_no)?;
            for m in &page {
                scanned += 1;
                cursor = Some((m.ts, m.mid.clone()));
                if shown.shows(m) && !take(m) {
                    return Ok(None);
                }
                if scanned >= SCAN_MAX {
                    return Ok(Some(m.mid.clone()));
                }
            }
            if page.len() < PAGE {
                return Ok(None);
            }
        }
    }

    fn messages(&self, c: &Ctx, g: &Ground, caller: &Caller, s: &Arc<AppSession>, f: &mut Facts) -> Result<Answer, No> {
        let q = c.req.query;
        let cid = c.p.cid.as_str();
        let limit = limit_of(q, 50, 200)?;
        let before = self.cursor(s, cid, param(q, "before"))?;
        let after = self.cursor(s, cid, param(q, "after"))?;
        let thread = param(q, "thread").filter(|t| !t.is_empty());
        let shown = Shown::of(s, cid, caller.grant.person.as_deref());
        let faces = caller.faces(g);
        let mut out: Vec<Value> = Vec::new();
        let mut last = String::new();
        let mut full = false;
        let past = |m: &StoredMessage| after.as_ref().is_some_and(|(t, mid)| m.ts < *t || (m.ts == *t && (mid.is_empty() || m.mid.as_str() <= mid.as_str())));
        let early = self.walk(s, cid, before, &shown, |m| {
            if past(m) {
                return false;
            }
            if thread.as_ref().is_some_and(|t| m.thread.as_deref() != Some(t.as_str()) && m.mid != *t) {
                return true;
            }
            out.push(faces.message(cid, m));
            last = m.mid.clone();
            full = out.len() >= limit;
            !full
        })?;
        let next = if full { json!(last) } else { early.map_or(Value::Null, Value::from) };
        f.items = Some(out.len());
        Ok(json_answer(200, &json!({"messages": out, "withheld": s.withheld(), "next": next})))
    }

    fn files(&self, c: &Ctx, g: &Ground, caller: &Caller, s: &Arc<AppSession>, f: &mut Facts) -> Result<Answer, No> {
        let _ = g;
        let q = c.req.query;
        let cid = c.p.cid.as_str();
        let limit = limit_of(q, 50, 200)?;
        let before = self.cursor(s, cid, param(q, "next"))?;
        let shown = Shown::of(s, cid, caller.grant.person.as_deref());
        let mut out: Vec<Value> = Vec::new();
        let mut last = String::new();
        let mut full = false;
        let early = self.walk(s, cid, before, &shown, |m| {
            for d in &m.files {
                out.push(json!({"id": d.get("fid").cloned().unwrap_or(Value::Null), "name": d.get("name").and_then(Value::as_str).unwrap_or_default(),
                                "size": d.get("size").and_then(Value::as_u64).unwrap_or(0), "mime": d.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream"),
                                "message": m.mid, "ts": m.ts}));
            }
            last = m.mid.clone();
            full = out.len() >= limit;
            !full
        })?;
        let next = if full { json!(last) } else { early.map_or(Value::Null, Value::from) };
        f.items = Some(out.len());
        Ok(json_answer(200, &json!({"files": out, "next": next})))
    }

    fn file(&self, c: &Ctx, caller: &Caller, s: &Arc<AppSession>, f: &mut Facts) -> Result<Answer, No> {
        let (cid, fid) = (c.p.cid.as_str(), c.p.fid.as_str());
        let store = self.conn.store();
        let mid = store.holder_of(&s.app, cid, fid).map_err(store_no)?.ok_or_else(not_found)?;
        let m = store.get(&s.app, cid, &mid).map_err(store_no)?.ok_or_else(not_found)?;
        if !Shown::of(s, cid, caller.grant.person.as_deref()).shows(&m) {
            return Err(not_found());
        }
        let desc = m.files.iter().find(|d| d.get("fid").and_then(Value::as_str) == Some(fid)).ok_or_else(not_found)?;
        let too_large = || no(413, "file-too-large", "That file is larger than 25 MiB.");
        if desc.get("size").and_then(Value::as_u64).unwrap_or(0) > FILE_MAX {
            return Err(too_large());
        }
        let bytes = match s.file(cid, &mid, fid, c.req.now_ms) {
            Ok(b) => b,
            Err(e) if e == NOT_KEPT || e == NO_SUCH_FILE => return Err(not_found()),
            Err(e) => {
                log_warn(&format!("connector_file_not_read error={e}"));
                return Err(no(503, "unavailable", "That file cannot be read now; try again later."));
            }
        };
        if bytes.len() as u64 > FILE_MAX {
            return Err(too_large());
        }
        let mime = desc.get("mime").and_then(Value::as_str).filter(|m| !m.is_empty() && m.len() <= 128 && m.bytes().all(|b| (0x21..=0x7e).contains(&b) || b == b' ')).unwrap_or("application/octet-stream");
        f.items = Some(1);
        Ok(Answer {
            status: 200,
            headers: vec![
                ("Content-Type".into(), mime.into()),
                ("Cache-Control".into(), "no-store".into()),
                ("X-Content-Type-Options".into(), "nosniff".into()),
                ("Content-Disposition".into(), "attachment".into()),
            ],
            body: bytes,
        })
    }

    /// The visible conversations a search or mentions call reads: the one `conv` names (404 when it is not
    /// visible), else every visible one.
    fn scope_of(&self, c: &Ctx, g: &Ground, caller: &Caller, f: &mut Facts) -> Result<BTreeMap<String, Arc<AppSession>>, No> {
        match param(c.req.query, "conv") {
            Some(cid) => {
                f.conv = Some(cid.clone());
                let s = view::visible(&self.conn, g, &caller.who(), &cid).map_err(|_| not_found())?;
                Ok(BTreeMap::from([(cid, s)]))
            }
            None => Ok(self.visible_all(g, caller)),
        }
    }

    fn search(&self, c: &Ctx, g: &Ground, caller: &Caller, f: &mut Facts) -> Result<Answer, No> {
        let q = c.req.query;
        let text = param(q, "q").filter(|t| (1..=256).contains(&t.chars().count())).ok_or_else(|| no(400, "bad-request", "q must be 1 to 256 characters."))?;
        let (since, until) = (ms_param(q, "since")?, ms_param(q, "until")?);
        let limit = limit_of(q, 20, 50)?;
        let convs = self.scope_of(c, g, caller, f)?;
        let mut by_app: BTreeMap<String, (Arc<AppSession>, Vec<String>)> = BTreeMap::new();
        for (cid, s) in &convs {
            by_app.entry(s.app.clone()).or_insert_with(|| (s.clone(), Vec::new())).1.push(cid.clone());
        }
        let person = caller.grant.person.as_deref();
        let mut shown: HashMap<String, Shown> = HashMap::new();
        let mut hits: Vec<(String, StoredMessage)> = Vec::new();
        for (app, (s, cids)) in &by_app {
            for (cid, m) in self.conn.store().search(app, cids, &text, SCAN_MAX).map_err(store_no)? {
                if since.is_some_and(|t| m.ts < t) || until.is_some_and(|t| m.ts >= t) {
                    continue;
                }
                if shown.entry(cid.clone()).or_insert_with(|| Shown::of(s, &cid, person)).shows(&m) {
                    hits.push((cid, m));
                }
            }
        }
        hits.sort_by(|a, b| (b.1.ts, &b.1.mid).cmp(&(a.1.ts, &a.1.mid)));
        let more = hits.len() > limit;
        hits.truncate(limit);
        let faces = caller.faces(g);
        let out: Vec<Value> = hits.iter().map(|(cid, m)| json!({"message": faces.message(cid, m), "score": 1.0})).collect();
        let next = if more { hits.last().map_or(Value::Null, |(_, m)| json!(m.ts.to_string())) } else { Value::Null };
        f.items = Some(out.len());
        let withheld: u64 = by_app.values().map(|(s, _)| s.withheld()).sum();
        Ok(json_answer(200, &json!({"hits": out, "withheld": withheld, "next": next})))
    }

    fn mentions(&self, c: &Ctx, g: &Ground, caller: &Caller, f: &mut Facts) -> Result<Answer, No> {
        let q = c.req.query;
        let since = ms_param(q, "since")?;
        let limit = limit_of(q, 50, 200)?;
        let convs = self.scope_of(c, g, caller, f)?;
        let person = caller.grant.person.as_deref();
        let mut found: Vec<(String, StoredMessage)> = Vec::new();
        for (cid, s) in &convs {
            let target = person.map_or_else(|| s.principal().0, str::to_string);
            let shown = Shown::of(s, cid, person);
            let mut n = 0usize;
            self.walk(s, cid, None, &shown, |m| {
                if since.is_some_and(|t| m.ts < t) {
                    return false;
                }
                if m.mentions.iter().any(|p| *p == target) {
                    found.push((cid.clone(), m.clone()));
                    n += 1;
                }
                n < limit
            })?;
        }
        found.sort_by(|a, b| (b.1.ts, &b.1.mid).cmp(&(a.1.ts, &a.1.mid)));
        found.truncate(limit);
        let faces = caller.faces(g);
        let out: Vec<Value> = found.iter().map(|(cid, m)| faces.message(cid, m)).collect();
        f.items = Some(out.len());
        Ok(json_answer(200, &json!({"messages": out, "next": Value::Null})))
    }

    // ── posts, idempotency and approvals (7.1, 7.5) ──────────────────────────────────────────────────────────

    /// A kept result of `key` within `window_ms` of its first request (`at` is the first request's time: replays
    /// never move it).
    fn idem_find(&self, key: &str, now_ms: i64, window_ms: i64) -> Option<Idem> {
        self.idem.lock().iter().find(|r| r.key == key && now_ms - r.at < window_ms).cloned()
    }

    fn idem_keep(&self, r: Idem, now_ms: i64) {
        let mut all = self.idem.lock();
        all.retain(|x| now_ms - x.at < IDEMPOTENCY_MS && x.key != r.key);
        all.push(r);
        let v = json!({"records": all.iter().map(Idem::to_value).collect::<Vec<_>>()});
        if let Err(e) = self.conn.shared.sealed.put(names::IDEMPOTENCY, &v) {
            log_warn(&format!("connector_idempotency_not_sealed error={e}"));
        }
    }

    /// The answer of a kept `Idempotency-Key` result.
    fn replay(&self, g: &Ground, caller: &Caller, s: &AppSession, r: &Idem, now_ms: i64) -> Answer {
        if let Some(id) = &r.approval {
            let state = self.approvals.get(id).map(|a| (a.state_at(now_ms).to_string(), a.exp)).unwrap_or_else(|| (appr::state::EXPIRED.into(), 0));
            return json_answer(202, &json!({"approval": {"id": id, "state": state.0, "expires": state.1}}));
        }
        let mid = r.mid.clone().unwrap_or_default();
        let msg = match self.conn.store().get(&s.app, &r.conv, &mid) {
            Ok(Some(m)) => caller.faces(g).message(&r.conv, &m),
            _ => json!({"id": mid, "conv": r.conv}),
        };
        json_answer(r.status, &json!({"message": msg}))
    }

    /// 7.5: a post needs the person's (or owner's) approval: every `agent_delegated` post, `content.post` in the
    /// client's `confirm` or a `client_confirm`, and an `agent` holding both content scopes (O21).
    fn needs_approval(g: &Ground, caller: &Caller) -> bool {
        let id = &caller.grant.client;
        let confirm = tok::names(&caller.client, "confirm").any(|s| s == POST) || cj::confirm_scopes(&g.console, id).iter().any(|s| s == POST);
        let both = tok::names(&caller.client, "scopes").filter(|s| *s == READ || *s == POST).count() == 2;
        caller.kind == "agent_delegated" || confirm || (caller.kind == "agent" && both)
    }

    fn post(&self, c: &Ctx, g: &Ground, caller: &Caller, s: &Arc<AppSession>, f: &mut Facts) -> Result<Answer, No> {
        let cid = c.p.cid.as_str();
        let key = c.req.idempotency_key.filter(|k| (1..=64).contains(&k.len()) && k.bytes().all(|b| (0x20..=0x7e).contains(&b)));
        let key = key.ok_or_else(|| no(400, "bad-request", "Idempotency-Key must be 1 to 64 printable ASCII characters."))?;
        let (text, thread) = post_body(c.req.body)?;
        if !thread.is_empty() && !matches!(self.conn.store().get(&s.app, cid, &thread), Ok(Some(_))) {
            return Err(no(400, "bad-request", "thread must be a message of this conversation."));
        }
        // revision 5 9.4: an MCP post's key (the hash of its arguments) is its own key space, kept 10 minutes from the
        // first request; a REST key is kept a day
        let (ikey, window) = if c.p.mcp {
            (digest(&[caller.grant.client.as_str(), caller.sub(), "mcp", key]), cm::POST_WINDOW_MS)
        } else {
            (digest(&[caller.grant.client.as_str(), caller.sub(), key]), IDEMPOTENCY_MS)
        };
        let body = digest(&[cid, thread.as_str(), text.as_str()]);
        let now_ms = c.req.now_ms;
        if let Some(r) = self.idem_find(&ikey, now_ms, window) {
            if r.body != body {
                return Err(no(409, "idempotency", "That Idempotency-Key was used with another request."));
            }
            f.replayed = true;
            f.approval = r.approval.clone();
            return Ok(self.replay(g, caller, s, &r, now_ms));
        }
        if !self.inflight.lock().insert(ikey.clone()) {
            return Err(no(409, "idempotency", "A request with that Idempotency-Key is still being answered."));
        }
        let done = self.post_new(c, g, caller, s, &text, &thread, &ikey, &body, f);
        self.inflight.lock().remove(&ikey);
        done
    }

    #[allow(clippy::too_many_arguments)]
    fn post_new(&self, c: &Ctx, g: &Ground, caller: &Caller, s: &Arc<AppSession>, text: &str, thread: &str, ikey: &str, body: &str, f: &mut Facts) -> Result<Answer, No> {
        let (cid, now_ms) = (c.p.cid.as_str(), c.req.now_ms);
        // 12
        if let Err(w) = self.lim.post(&format!("{} {cid}", caller.grant.client), now_ms) {
            return Err(no(429, "rate", "This client posts too often in this conversation; see Retry-After.").retry(w));
        }
        let keep = |status: u16, mid: Option<String>, approval: Option<String>| {
            self.idem_keep(Idem { key: ikey.into(), body: body.into(), at: now_ms, status, conv: cid.into(), mid, approval }, now_ms);
        };
        // 13 and 14
        if ConnectorApi::needs_approval(g, caller) {
            let person = match caller.grant.person.as_deref() {
                Some(p) => p.to_string(),
                None => caller.client.get("owner").and_then(Value::as_str).unwrap_or_default().to_string(),
            };
            let ask = Ask {
                client: &caller.grant.client,
                client_name: &caller.name,
                sub: caller.sub(),
                person: &person,
                delegated: caller.grant.person.is_some(),
                session: s,
                conv: cid,
                thread,
                text,
                ceiling: &caller.grant.ceiling,
            };
            let a = self.approvals.request(&ask, now_ms).map_err(|r| No { status: r.status, code: r.code, why: r.why.into(), retry: r.retry, extra: None })?;
            f.approval = Some(a.id.clone());
            keep(202, None, Some(a.id.clone()));
            return Ok(json_answer(202, &json!({"approval": {"id": a.id, "state": appr::state::WAITING, "expires": a.exp}})));
        }
        if !self.audit.allowed_ok() {
            return Err(no(503, "audit-unavailable", "The audit log cannot record this request now; try again later."));
        }
        let sent = s.post_dlg(cid, text, thread, &json!({"client": caller.name}), now_ms).map_err(|e| {
            log_warn(&format!("connector_post_failed error={e}"));
            no(503, "unavailable", "The post could not be sent now; try again later.")
        })?;
        let mid = sent.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        keep(201, Some(mid.clone()), None);
        let msg = match self.conn.store().get(&s.app, cid, &mid) {
            Ok(Some(m)) => caller.faces(g).message(cid, &m),
            _ => json!({"id": mid, "conv": cid}),
        };
        f.items = Some(1);
        Ok(json_answer(201, &json!({"message": msg})))
    }

    fn approval(&self, c: &Ctx, g: &Ground, caller: &Caller, s: &Arc<AppSession>, a: &appr::Approval, f: &mut Facts) -> Result<Answer, No> {
        f.approval = Some(a.id.clone());
        match a.state_at(c.req.now_ms) {
            appr::state::DECLINED => Err(no(403, "approval-declined", "The person declined this post.")),
            appr::state::EXPIRED => Err(no(410, "approval-expired", "This approval expired.")),
            appr::state::REFUSED => {
                let check = a.check.clone().unwrap_or_default();
                Err(No { extra: Some(("check", json!(check))), ..no(409, "approval-refused", "The post was approved, but the client may no longer post there.") })
            }
            appr::state::POSTED => {
                let mid = a.mid.clone().unwrap_or_default();
                let msg = match self.conn.store().get(&s.app, &a.conv, &mid) {
                    Ok(Some(m)) => caller.faces(g).message(&a.conv, &m),
                    _ => json!({"id": mid, "conv": a.conv}),
                };
                Ok(json_answer(200, &json!({"id": a.id, "state": appr::state::POSTED, "message": msg})))
            }
            appr::state::WAITING => Ok(json_answer(200, &json!({"id": a.id, "state": appr::state::WAITING, "expires": a.exp}))),
            _ => Ok(json_answer(200, &json!({"id": a.id, "state": appr::state::APPROVED}))),
        }
    }

    // ── content events (7.6) ─────────────────────────────────────────────────────────────────────────────────

    /// One event as this caller may see it now (5.2 at delivery; the message read from the store), None to skip.
    fn deliver(&self, g: &Ground, caller: &Caller, n: &Noted) -> Option<Value> {
        let who = caller.who();
        let session = self.conn.session(&n.app)?;
        let mut ev = json!({"id": n.id.to_string(), "type": n.kind.name(), "conv": n.conv});
        if n.kind == ContentKind::ConversationRemoved {
            let mine = view::client_apps(&self.conn, g, &who).iter().any(|s| s.app == n.app);
            let shown = mine && view::reaches_connector(g, &who) && crate::ce_device::cid_kind(&n.conv).ok() == Some("ch") && view::in_channels(g, &who, &n.conv);
            return shown.then_some(ev);
        }
        view::visible(&self.conn, g, &who, &n.conv).ok()?;
        match n.kind {
            ContentKind::MessageCreated | ContentKind::MessageEdited => {
                let m = self.conn.store().get(&n.app, &n.conv, n.mid.as_deref()?).ok()??;
                if !Shown::of(session, &n.conv, who.person).shows(&m) {
                    return None;
                }
                ev["message"] = caller.faces(g).message(&n.conv, &m);
            }
            ContentKind::MessageDeleted => ev["message"] = json!({"id": n.mid}),
            _ => {}
        }
        Some(ev)
    }

    fn events_poll(&self, c: &Ctx, g: &Ground, caller: &Caller, f: &mut Facts) -> Result<Answer, No> {
        let q = c.req.query;
        let key = format!("{} {}", caller.grant.client, caller.sub());
        let after = match param(q, "after") {
            Some(a) => a.parse::<u64>().map_err(|_| no(400, "bad-request", "after must be a cursor this route gave."))?,
            None => self.events.cursor(&key).unwrap_or_else(|| self.events.head()),
        };
        let wait = match param(q, "wait") {
            None => 0,
            Some(w) => w.parse::<u64>().ok().filter(|w| *w <= WAIT_MAX_S).ok_or_else(|| no(400, "bad-request", "wait must be 0 to 30 seconds."))?,
        };
        let deadline = Instant::now() + Duration::from_secs(wait);
        let mut cursor = after;
        let mut out: Vec<Value> = Vec::new();
        loop {
            let batch = self.events.after(cursor, PAGE, deadline.saturating_duration_since(Instant::now()));
            if batch.is_empty() {
                break;
            }
            for n in &batch {
                cursor = n.id;
                if let Some(e) = self.deliver(g, caller, n) {
                    out.push(e);
                }
            }
            if !out.is_empty() || Instant::now() >= deadline {
                break;
            }
        }
        self.events.set_cursor(&key, cursor);
        f.items = Some(out.len());
        Ok(json_answer(200, &json!({"events": out, "next": cursor.to_string()})))
    }
}

// ── CM = C/mcp (revision 5 8.2, 8.4, 9.2; slice 1c5) ────────────────────────────────────────────────────────

/// Revision 5 8.3: the scope of the REST route `method path` (the MCP tool table's check).
// Used only by the `connector_mcp` tests, which pin every tool to a row of the private `ROUTES`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn route_scope(method: &str, path: &str) -> Option<&'static str> {
    ROUTES.iter().find(|r| r.method == method && r.path == path).map(|r| r.scope)
}

/// After `ConnectorApi::mcp_head`: the answer, or what `mcp_body` needs once the body is read.
pub(crate) enum McpStep {
    Done(Answer),
    Read(Box<McpPass>),
}

/// A request at CM that passed checks 0 to 11 on its request line and headers.
pub(crate) struct McpPass {
    head: mcp::Head,
    want: mcp::Want,
    pick: cm::Pick,
    scope: &'static str,
    caller: Caller,
    rid: String,
    source: IpAddr,
}

/// Revision 5 8.4: the approvals sealed `posting` when this process started. Their CE-1 post was cut off by the stop
/// and carries no key the relay would dedupe on, so it is never sent again (an approval posts at most once): an MCP
/// retry ends with a tool error instead of waiting for a post that will not come. A `posting` approval of this
/// process is a post in flight, and its retry waits.
fn interrupted_posts(conn: &Connector) -> HashSet<String> {
    let held = match conn.shared.sealed.get(names::APPROVALS) {
        Ok(v) => v,
        Err(e) => {
            log_warn(&format!("connector_approvals_not_read error={e}"));
            None
        }
    };
    held.as_ref()
        .and_then(|v| v.get("approvals"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|a| a.get("state").and_then(Value::as_str) == Some(appr::state::POSTING))
        .filter_map(|a| a.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn audit_down(a: &Answer) -> bool {
    a.status == 503 && serde_json::from_slice::<Value>(&a.body).ok().and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string)).as_deref() == Some("audit-unavailable")
}

/// r5 13.1: whether the tool a CM request's `Mcp-Name` names posts.
fn mcp_writes(head: &mcp::Head) -> bool {
    head.name.as_deref().and_then(mcp::decode_name).is_some_and(|n| cm::TOOLS.iter().any(|t| t.name == n && t.write))
}

/// r5 13.1: one decided CM request in `lucid_mcp_requests_total` (server `connector`, reported in the acks).
fn mcp_count(org: &str, method: Option<mcp::Method>, write: bool, a: &Answer) {
    let body = if a.status == 200 { serde_json::from_slice::<Value>(&a.body).unwrap_or_default() } else { Value::Null };
    mcp::count(org, "connector", method, write, a.status, &body);
}

fn with_rid(mut a: Answer, rid: &str) -> Answer {
    a.headers.push(("X-Lucid-Request-Id".into(), rid.into()));
    a
}

impl ConnectorApi {
    fn mcp_req(head: &mcp::Head, source: IpAddr, now_ms: i64) -> Request<'_> {
        Request { method: "POST", path: &head.path, query: "", authorization: head.authorization.as_deref(), dpop: head.dpop.as_deref(), idempotency_key: None, body: None, source, now_ms }
    }

    /// The context of a CM decision: route `POST CM` under `scope`, resource CM (its own `aud`, R5 18).
    fn mcp_ctx<'a>(&self, req: &'a Request<'a>, scope: &str, rid: &str) -> Ctx<'a> {
        let org = self.sync.org().to_string();
        let resource = self.sync.connector().and_then(|e| e.get("origin").and_then(Value::as_str).map(|o| connector_mcp_resource(o, &org)));
        let route = MCP_ROUTES.iter().find(|r| r.scope == scope).unwrap_or(&MCP_ROUTES[0]);
        Ctx { req, route, p: Params { org, ..Params::default() }, rid: rid.to_string(), now_s: req.now_ms.div_euclid(1000), resource }
    }

    /// A protocol refusal: audited, then its JSON-RPC error.
    fn mcp_fault(&self, c: &Ctx, caller: Option<&Caller>, f: &mcp::Fault, id: Option<&Value>, facts: &Facts) -> Answer {
        let a = self.refuse(c, caller, None, facts, no(f.status, f.check, f.message.clone()));
        if audit_down(&a) {
            return a;
        }
        answer_of(f.reply(id))
    }

    /// A refusal inside a tool: audited, then a tool error with `why` (8.5).
    fn mcp_tool_no(&self, c: &Ctx, caller: &Caller, f: &Facts, n: No, why: &str, id: &Value) -> Answer {
        let a = self.refuse(c, Some(caller), None, f, n);
        if audit_down(&a) {
            return a;
        }
        answer_of(mcp::ok(id, mcp::tool_error(why), cm::SERVER))
    }

    /// 8.4: the sealed MCP state key (`names::MCP_STATE_KEY`), made on first use.
    fn mcp_key(&self) -> Option<SecretKey> {
        let mut held = self.mcp_key.lock();
        if let Some(k) = held.as_ref() {
            return Some(k.clone());
        }
        let sealed = &self.conn.shared.sealed;
        let k = match sealed.get_bytes(names::MCP_STATE_KEY) {
            Ok(Some(b)) => SecretKey::from_slice(&b)?,
            Ok(None) => {
                let k = SecretKey::random().ok()?;
                if let Err(e) = sealed.put_bytes(names::MCP_STATE_KEY, k.bytes()) {
                    log_warn(&format!("connector_mcp_state_key_not_sealed error={e}"));
                    return None;
                }
                k
            }
            Err(e) => {
                log_warn(&format!("connector_mcp_state_key_not_read error={e}"));
                return None;
            }
        };
        *held = Some(k.clone());
        Some(k)
    }

    /// 8.2 steps 1 to 4 for CM, before the body: the source limiter, the request line and headers, the scope of the
    /// tool or resource they name (a listing: a scope the token claims), and checks 1 to 11 of 5.3 for that scope
    /// (check 8, the conversation, is judged with the arguments).
    pub(crate) fn mcp_head(&self, head: &mcp::Head, source: IpAddr, now_ms: i64) -> McpStep {
        let step = self.mcp_head_step(head, source, now_ms);
        if let McpStep::Done(a) = &step {
            mcp_count(self.sync.org(), head.method.as_deref().and_then(mcp::Method::of), mcp_writes(head), a);
        }
        step
    }

    fn mcp_head_step(&self, head: &mcp::Head, source: IpAddr, now_ms: i64) -> McpStep {
        let rid = res::rid();
        let org = self.sync.org().to_string();
        if mcp::endpoint_org(&head.path) != Some(org.as_str()) {
            return McpStep::Done(with_rid(answer_of(res::problem(404, "not-found", NOT_FOUND)), &rid));
        }
        let req = ConnectorApi::mcp_req(head, source, now_ms);
        let c = self.mcp_ctx(&req, READ, &rid);
        if let Err(a) = self.charge(&c) {
            return McpStep::Done(with_rid(a, &rid));
        }
        // no resource (no connector entry): no Origin matches, and the checks answer `connector-stale`
        let own = c.resource.as_deref().unwrap_or_default();
        let want = match mcp::check_head(head, own) {
            Ok(w) => w,
            Err(f) => return McpStep::Done(with_rid(self.mcp_fault(&c, None, &f, None, &Facts::default()), &rid)),
        };
        let pick = cm::pick(&want, &org);
        let scope = match &pick {
            cm::Pick::Tool(t) => t.scope,
            cm::Pick::Res(_) => READ,
            cm::Pick::List | cm::Pick::Unknown => cm::claimed_scope(head.authorization.as_deref()),
        };
        let c = self.mcp_ctx(&req, scope, &rid);
        let g = Ground::of(&self.conn, &self.sync, now_ms);
        match self.checked(&c, &g, &Target::None) {
            Ok((caller, _)) => McpStep::Read(Box::new(McpPass { head: head.clone(), want, pick, scope, caller, rid, source })),
            Err(a) => McpStep::Done(with_rid(a, &rid)),
        }
    }

    /// 8.2 steps 5 and 6 for CM: the body (as read, at most 64 KiB), then the method; every decision in the chain
    /// before its answer.
    pub(crate) fn mcp_body(&self, pass: McpPass, raw: Result<&[u8], &'static str>, now_ms: i64) -> Answer {
        let req = ConnectorApi::mcp_req(&pass.head, pass.source, now_ms);
        let c = self.mcp_ctx(&req, pass.scope, &pass.rid);
        let g = Ground::of(&self.conn, &self.sync, now_ms);
        let a = match mcp::parse_body(raw, &pass.want) {
            Err((f, id)) => self.mcp_fault(&c, Some(&pass.caller), &f, id.as_ref(), &Facts::default()),
            Ok(rpc) => self.mcp_run(&c, &g, &pass.caller, &pass.pick, &rpc),
        };
        mcp_count(&c.p.org, Some(pass.want.method), matches!(pass.pick, cm::Pick::Tool(t) if t.write), &a);
        with_rid(a, &pass.rid)
    }

    fn mcp_run(&self, c: &Ctx, g: &Ground, caller: &Caller, pick: &cm::Pick, rpc: &mcp::Rpc) -> Answer {
        let id = &rpc.id;
        let has = |s: &str| caller.grant.scopes.iter().any(|x| x == s);
        let listed = |result: Value| self.finish(c, caller, &Facts::default(), answer_of(mcp::ok(id, result, cm::SERVER)));
        match (rpc.method, pick) {
            (mcp::Method::Discover, _) => listed(mcp::discover(cm::INSTRUCTIONS)),
            (mcp::Method::ToolsList, _) => listed(mcp::listing("tools", cm::TOOLS.iter().filter(|t| has(t.scope)).map(cm::Tool::entry).collect(), None)),
            (mcp::Method::TemplatesList, _) => listed(mcp::listing("resourceTemplates", if has(READ) { cm::templates(&c.p.org) } else { Vec::new() }, None)),
            (mcp::Method::ResourcesList, _) => self.mcp_resources(c, g, caller, rpc),
            (mcp::Method::ToolsCall, cm::Pick::Tool(t)) => self.mcp_tool(c, g, caller, *t, rpc),
            (mcp::Method::ResourcesRead, cm::Pick::Res(r)) => self.mcp_read(c, g, caller, r, rpc),
            (mcp::Method::ToolsCall, _) => self.mcp_fault(c, Some(caller), &mcp::Fault::params(200, "Unknown tool"), Some(id), &Facts::default()),
            (mcp::Method::ResourcesRead, _) => self.mcp_fault(c, Some(caller), &mcp::Fault::params(200, cm::UNKNOWN_RESOURCE), Some(id), &Facts::default()),
        }
    }

    /// The one route of a tool or resource (8.2 step 6): check 8 for the conversation it names (not visible: 404,
    /// as an unknown one), then that route's handler, with the token's caller.
    fn mcp_route(&self, c: &Ctx, g: &Ground, caller: &Caller, rest: &cm::RestCall, f: &mut Facts) -> Result<Answer, No> {
        let route = ROUTES.iter().find(|r| r.method == rest.method && r.path == rest.pattern).ok_or_else(not_found)?;
        let mut approval = None;
        let cid = if route.id == RouteId::Approval {
            let a = self.approvals.get(&rest.id).filter(|a| a.client == caller.grant.client && a.sub == caller.sub()).ok_or_else(not_found)?;
            let conv = a.conv.clone();
            approval = Some(a);
            conv
        } else {
            rest.cid.clone()
        };
        f.conv = Some(cid.clone()).filter(|x| !x.is_empty());
        let session = if route.path.contains("{cid}") || route.id == RouteId::Approval {
            let s = view::visible(&self.conn, g, &caller.who(), &cid).map_err(|_| not_found())?;
            f.app = Some(s.principal().0);
            Some(s)
        } else {
            None
        };
        let path = route.path.replace("{org}", &c.p.org).replace("{cid}", &mcp::form_escape(&rest.cid)).replace("{fid}", &mcp::form_escape(&rest.fid)).replace("{id}", &rest.id);
        let req = Request {
            method: route.method,
            path: &path,
            query: &rest.query,
            authorization: c.req.authorization,
            dpop: None,
            idempotency_key: rest.key.as_deref(),
            body: rest.body.as_deref().map(Ok),
            source: c.req.source,
            now_ms: c.req.now_ms,
        };
        let resource = c.resource.as_deref().and_then(|r| r.strip_suffix("/mcp")).map(str::to_string);
        let rc = Ctx { req: &req, route, p: Params { org: c.p.org.clone(), cid: rest.cid.clone(), fid: rest.fid.clone(), id: rest.id.clone(), mcp: true }, rid: c.rid.clone(), now_s: c.now_s, resource };
        self.serve_route(&rc, g, caller, session, approval, f)
    }

    /// 8.4: `input_required` for an approval still open: a fresh state bound to the client, `sub`, tool and
    /// arguments, and the elicitation the client's capabilities allow (the page names no text).
    #[allow(clippy::too_many_arguments)]
    fn mcp_wait(&self, c: &Ctx, caller: &Caller, tool: &str, args_sha: &str, a: &appr::Approval, key: &SecretKey, caps: &Value) -> Option<Value> {
        let exp = a.exp.div_euclid(1000).max(c.now_s + 60);
        let st = mcp::State { approval: a.id.clone(), client: caller.grant.client.clone(), sub: caller.sub().to_string(), tool: tool.to_string(), args_sha256: args_sha.to_string(), exp };
        let sealed = mcp::seal_state(key, &st)?;
        let rest = c.resource.as_deref()?.strip_suffix("/mcp")?;
        let url = format!("{rest}/v1/content/approvals/{}/page", a.id);
        Some(mcp::input_required(mcp::approval_request(caps, &url), sealed))
    }

    fn mcp_tool(&self, c: &Ctx, g: &Ground, caller: &Caller, t: &'static cm::Tool, rpc: &mcp::Rpc) -> Answer {
        let id = &rpc.id;
        let mut f = Facts { tool: Some(t.name), ..Facts::default() };
        let mut rest = match cm::rest_of(t, &rpc.arguments) {
            Ok(r) => r,
            Err(why) => return self.mcp_tool_no(c, caller, &f, no(400, "bad-request", why.clone()), &why, id),
        };
        let args_sha = mcp::args_sha256(&rpc.arguments);
        let key = if t.write {
            match self.mcp_key() {
                Some(k) => Some(k),
                None => {
                    let why = "Lucid cannot ask for approvals right now; try again later.";
                    return self.mcp_tool_no(c, caller, &f, no(503, "unavailable", why), why, id);
                }
            }
        } else {
            None
        };
        // 8.4: a retry presents the state of its approval, bound to this client, person, tool and arguments
        if let Some(text) = rpc.state.as_deref() {
            let fits = key.as_ref().and_then(|k| mcp::open_state(k, text)).filter(|s| s.fits(&caller.grant.client, caller.sub(), t.name, &args_sha, c.now_s));
            match fits {
                Some(s) => rest = cm::RestCall::approval(&s.approval),
                None => return self.mcp_fault(c, Some(caller), &mcp::Fault::params(200, "The requestState does not fit this request."), Some(id), &f),
            }
        }
        let answer = match self.mcp_route(c, g, caller, &rest, &mut f) {
            Ok(a) => a,
            Err(n) => {
                let person = self.approvals.get(&rest.id).map(|a| a.person).filter(|p| !p.is_empty()).unwrap_or_else(|| "The person".into());
                let why = match n.code {
                    "approval-declined" => cm::declined(&person),
                    "approval-expired" => cm::EXPIRED.to_string(),
                    _ => n.why.clone(),
                };
                return self.mcp_tool_no(c, caller, &f, n, &why, id);
            }
        };
        let mut v: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
        let waiting = if rest.is_approval() { Some(rest.id.clone()) } else { v.get("approval").and_then(|a| a.get("id")).and_then(Value::as_str).map(str::to_string) };
        let result = match (waiting, key) {
            (Some(aid), Some(key)) => {
                let Some(a) = self.approvals.get(&aid) else { return self.finish(c, caller, &f, answer_of(mcp::ok(id, mcp::tool_error(cm::EXPIRED), cm::SERVER))) };
                match a.state_at(c.req.now_ms) {
                    appr::state::POSTED if rest.is_approval() => cm::result_of(t, json!({"message": v.get("message").cloned().unwrap_or(Value::Null)})),
                    appr::state::POSTED => cm::result_of(t, json!({"approval": {"id": a.id, "state": appr::state::POSTED}})),
                    appr::state::DECLINED => mcp::tool_error(&cm::declined(&a.person)),
                    appr::state::EXPIRED => mcp::tool_error(cm::EXPIRED),
                    appr::state::REFUSED => mcp::tool_error("The post was approved, but the client may no longer post there."),
                    // cut off by a stop: terminal, never a fresh input_required
                    appr::state::POSTING if self.interrupted.contains(&a.id) => mcp::tool_error(cm::INTERRUPTED),
                    // waiting, approved, or a post in flight in this process: ask again
                    _ => match self.mcp_wait(c, caller, t.name, &args_sha, &a, &key, &rpc.caps) {
                        Some(w) => w,
                        None => {
                            let why = "Lucid cannot ask for approvals right now; try again later.";
                            return self.mcp_tool_no(c, caller, &f, no(503, "unavailable", why), why, id);
                        }
                    },
                }
            }
            _ => {
                if let Some((needle, limit)) = &rest.filter {
                    cm::filter_conversations(&mut v, needle, *limit);
                    f.items = v.get("conversations").and_then(Value::as_array).map(Vec::len);
                }
                cm::result_of(t, v)
            }
        };
        self.finish(c, caller, &f, answer_of(mcp::ok(id, result, cm::SERVER)))
    }

    /// `resources/read` (9.2): a conversation's latest 50 messages (content fenced) or one file, the result within
    /// `mcp::RESULT_MAX` (8.1).
    fn mcp_read(&self, c: &Ctx, g: &Ground, caller: &Caller, r: &cm::Res, rpc: &mcp::Rpc) -> Answer {
        let id = &rpc.id;
        let uri = rpc.name.clone().unwrap_or_default();
        let mut f = Facts { tool: Some(r.name()), ..Facts::default() };
        let rest = match r {
            cm::Res::Conv(cid) => cm::conv_read(cid),
            cm::Res::File(cid, fid) => cm::file_read(cid, fid),
        };
        let refused = |f: &Facts, n: No, msg: &str| {
            let a = self.refuse(c, Some(caller), None, f, n);
            if audit_down(&a) {
                a
            } else {
                answer_of(mcp::Fault::params(200, msg).reply(Some(id)))
            }
        };
        let answer = match self.mcp_route(c, g, caller, &rest, &mut f) {
            Ok(a) => a,
            Err(n) => return refused(&f, n, cm::UNKNOWN_RESOURCE),
        };
        // 8.1: the result stays within 1 MiB: messages are cut at an item boundary, a file too large is refused
        let contents = match r {
            cm::Res::Conv(_) => cm::conv_contents(&uri, serde_json::from_slice(&answer.body).unwrap_or(Value::Null)),
            cm::Res::File(..) => {
                let mime = answer.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.clone()).unwrap_or_default();
                match cm::file_contents(&uri, &mime, &answer.body) {
                    Some(blob) => blob,
                    None => return refused(&f, no(413, "file-too-large", cm::FILE_TOO_LARGE), cm::FILE_TOO_LARGE),
                }
            }
        };
        self.finish(c, caller, &f, answer_of(mcp::ok(id, cm::resource_result(contents), cm::SERVER)))
    }

    /// `resources/list` (9.2): one resource per visible conversation, its name fenced.
    fn mcp_resources(&self, c: &Ctx, g: &Ground, caller: &Caller, rpc: &mcp::Rpc) -> Answer {
        let id = &rpc.id;
        let mut f = Facts::default();
        if !caller.grant.scopes.iter().any(|s| s == READ) {
            return self.finish(c, caller, &f, answer_of(mcp::ok(id, mcp::listing("resources", Vec::new(), None), cm::SERVER)));
        }
        let answer = match self.mcp_route(c, g, caller, &cm::convs_read(rpc.cursor.as_deref()), &mut f) {
            Ok(a) => a,
            Err(n) => {
                let a = self.refuse(c, Some(caller), None, &f, n);
                return if audit_down(&a) { a } else { answer_of(mcp::Fault::params(400, "cursor is not a cursor of this list.").reply(Some(id))) };
            }
        };
        let mut v: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
        cm::fence_content(&mut v);
        let items: Vec<Value> = v
            .get("conversations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|cv| {
                let cid = cv.get("cid").and_then(Value::as_str)?;
                Some(json!({"uri": cm::conv_uri(&c.p.org, cid), "name": cid, "title": cv.get("name").cloned().unwrap_or(Value::Null), "mimeType": "application/json"}))
            })
            .collect();
        let next = v.get("next").and_then(Value::as_str).map(str::to_string);
        self.finish(c, caller, &f, answer_of(mcp::ok(id, mcp::listing("resources", items, next), cm::SERVER)))
    }
}

// ── A = C/a2a (revision 6 7.2.2, 7.3, 7.4; slice 1d4) ──────────────────────────────────────────────────────────

/// A caller that passed checks 0 to 11 of the connector resource pipeline at A (`connector_a2a` runs 7.4 next).
pub(crate) struct A2aGate {
    caller: Caller,
}

impl A2aGate {
    pub(crate) fn client(&self) -> &str {
        &self.caller.grant.client
    }

    /// Its pinned map entry.
    pub(crate) fn entry(&self) -> &Obj {
        &self.caller.client
    }

    pub(crate) fn name(&self) -> &str {
        &self.caller.name
    }

    pub(crate) fn jti(&self) -> &str {
        &self.caller.grant.jti
    }

    /// The token's end (s): a stream closes then (7.9).
    pub(crate) fn exp(&self) -> i64 {
        self.caller.grant.exp
    }

    /// The effective ceiling (the token's, lowered by the journal).
    pub(crate) fn ceiling(&self) -> &str {
        &self.caller.grant.ceiling
    }
}

impl ConnectorApi {
    /// Revision 6 7.2.1: the A2A server of this connector, once `serve` set it.
    pub(crate) fn a2a(&self) -> Option<&Arc<crate::connector_a2a::A2aServer>> {
        self.a2a.get()
    }

    pub(crate) fn set_a2a(&self, server: Arc<crate::connector_a2a::A2aServer>) {
        let _ = self.a2a.set(server);
    }

    /// A = C/a2a of this connector's `connectors[]` entry.
    pub(crate) fn a2a_resource(&self) -> Option<String> {
        let org = self.sync.org().to_string();
        self.sync.connector().and_then(|e| e.get("origin").and_then(Value::as_str).map(|o| crate::api_delegated::connector_a2a_resource(o, &org)))
    }

    /// The context of an A2A row (`method` and `pattern` as `connector_a2a_wire::Op` names them).
    fn a2a_ctx<'a>(&self, req: &'a Request<'a>, pattern: &str, rid: &str) -> Ctx<'a> {
        let route = A2A_ROUTES.iter().find(|r| r.method == req.method && r.path == pattern).unwrap_or(&A2A_ROUTES[0]);
        Ctx { req, route, p: Params { org: self.sync.org().to_string(), ..Params::default() }, rid: rid.to_string(), now_s: req.now_ms.div_euclid(1000), resource: self.a2a_resource() }
    }

    /// 7.3: checks 0 to 11 of the connector resource pipeline for an A2A row, A as the token's `aud` (7.2.2). Err is
    /// the audited refusal in the 1a problem shape (`connector_a2a` answers it in the A2A shape).
    pub(crate) fn a2a_gate(&self, req: &Request, pattern: &str, rid: &str) -> Result<A2aGate, Answer> {
        let c = self.a2a_ctx(req, pattern, rid);
        let g = Ground::of(&self.conn, &self.sync, req.now_ms);
        self.authorize(&c, &g, &Target::None).map(|(caller, _)| A2aGate { caller })
    }

    /// 9.4 for an A2A refusal after (or without) the pipeline: `api.refusal` with the 7.11 code in `check` and the
    /// row's route, before the answer. Err is 503 `audit-unavailable`.
    pub(crate) fn a2a_refused(&self, req: &Request, pattern: &str, rid: &str, gate: Option<&A2aGate>, status: u16, check: &str) -> Result<(), Answer> {
        let c = self.a2a_ctx(req, pattern, rid);
        let mut e = c.entry("api.refusal");
        e.insert("result".into(), json!("refused"));
        e.insert("check".into(), json!(check));
        e.insert("status".into(), json!(status));
        e.insert("count".into(), json!(1));
        e.insert("scope".into(), json!(c.route.scope));
        e.insert("resource".into(), json!(self.sync.connector_id()));
        if let Some(g) = gate {
            e.insert("client".into(), json!(g.client()));
            e.insert("jti".into(), json!(g.jti()));
        }
        let key = gate.map_or_else(|| format!("ip:{}", crate::console_source::source_key(req.source)), |g| g.client().to_string());
        self.audit.refusal(&c.p.org, &key, check, &c.route_name(), Value::Object(e), c.now_s).map_err(|_| answer_of(res::audit_unavailable()))
    }

    /// The route name an A2A row is audited under (`a2a.task`'s `route`).
    pub(crate) fn a2a_route(&self, method: &str, pattern: &str) -> String {
        format!("{method} {}", pattern.replace("{org}", self.sync.org()))
    }

    /// A path under A that no A2A row takes: summarized under the org's namespace (as an unknown path of C).
    pub(crate) fn a2a_unknown(&self, method: &str, source: IpAddr, rid: &str, now_s: i64) -> Answer {
        let org = self.sync.org().to_string();
        let reply = res::problem(404, "not-found", NOT_FOUND);
        answer_of(res::public_refused(Some(&*self.audit), &org, &res::namespace_route(method, &org), rid, source, reply, now_s))
    }
}

/// What 5.3 check 8 judges.
enum Target {
    None,
    Cid(String),
}

/// The token of an `Authorization: DPoP <token>` or `Bearer <token>` header.
fn access_token(header: Option<&str>) -> Option<&str> {
    let (scheme, rest) = header?.trim().split_once(' ')?;
    let token = rest.trim();
    ((scheme.eq_ignore_ascii_case("DPoP") || scheme.eq_ignore_ascii_case("Bearer")) && !token.is_empty()).then_some(token)
}

/// 5.3 check 3: the status and code of a validation refusal (1a 5.4, r5 6.6).
fn token_refusal(code: &str) -> (u16, &'static str) {
    match code {
        "map-expired" => (401, "map-expired"),
        "api-off" => (403, "api-off"),
        "expired" => (401, "expired"),
        "map-behind" => (401, "map-behind"),
        "suspended" => (403, "suspended"),
        "owner" => (403, "owner"),
        "person" => (403, "person"),
        "abuse" => (429, "abuse"),
        _ => (401, "token"),
    }
}

/// 7.1 POST body: `{"text": 1 to 4000 characters, "thread"?: a message id}`, nothing else.
fn post_body(body: Option<Result<&[u8], &'static str>>) -> Result<(String, String), No> {
    let bad = || no(400, "bad-request", "The body must be {\"text\": 1 to 4000 characters, \"thread\": a message id (optional)}.");
    let raw = match body {
        None => return Err(bad()),
        Some(Err("too-large")) => return Err(no(413, "too-large", "The request body is too large.")),
        Some(Err(_)) => return Err(no(400, "bad-request", "The request body could not be read.")),
        Some(Ok(b)) => b,
    };
    let v: Value = serde_json::from_slice(raw).map_err(|_| bad())?;
    let o = v.as_object().ok_or_else(bad)?;
    if o.keys().any(|k| k != "text" && k != "thread") {
        return Err(bad());
    }
    let text = o.get("text").and_then(Value::as_str).filter(|t| (1..=TEXT_MAX).contains(&t.chars().count())).ok_or_else(bad)?;
    let thread = match o.get("thread") {
        None => "",
        Some(t) => t.as_str().filter(|t| t.is_empty() || hex32(t)).ok_or_else(bad)?,
    };
    Ok((text.to_string(), thread.to_string()))
}

/// 7.1 `v1/openapi.json`: OpenAPI 3.1 of this route table (server: C's origin, paths with the org filled in, the
/// token endpoint of the console issuer `issuer`).
fn openapi(org: &str, resource: &str, issuer: &str) -> Value {
    let origin = resource.strip_suffix(&format!("/api/orgs/{org}")).unwrap_or(resource);
    let q = |name: &str, schema: Value, description: &str| json!({"name": name, "in": "query", "required": false, "schema": schema, "description": description});
    let int = |min: i64, max: i64, default: i64| json!({"type": "integer", "minimum": min, "maximum": max, "default": default});
    let mut paths = Map::new();
    for r in ROUTES.iter() {
        let mut op = Map::new();
        op.insert("operationId".into(), json!(format!("{:?}", r.id)));
        op.insert("summary".into(), json!(r.summary));
        op.insert("x-lucid-pipeline".into(), json!(if r.scope.is_empty() { "public" } else { "connector-resource" }));
        if r.scope.is_empty() {
            op.insert("security".into(), json!([]));
        } else {
            op.insert("security".into(), json!([{"oauth": [r.scope]}]));
            op.insert("x-lucid-scope".into(), json!(r.scope));
            op.insert("x-lucid-reach".into(), json!("R1"));
            op.insert("x-lucid-class".into(), json!(if r.class.is_empty() { "per conversation" } else { r.class }));
        }
        // revision 5 8.3: the connector MCP tools that call this route (one name, or a list when several do)
        match crate::connector_mcp::tools_of(r.method, r.path).as_slice() {
            [] => {}
            [one] => {
                op.insert("x-mcp-tool".into(), json!(one));
            }
            many => {
                op.insert("x-mcp-tool".into(), json!(many));
            }
        }
        let mut params = Vec::new();
        for (slot, what) in [("{cid}", "A conversation id (ch:<id>)."), ("{fid}", "A file id."), ("{id}", "An approval id (32 hex).")] {
            if r.path.contains(slot) {
                params.push(json!({"name": slot.trim_matches(|c| c == '{' || c == '}'), "in": "path", "required": true, "schema": {"type": "string"}, "description": what}));
            }
        }
        match r.id {
            RouteId::Conversations => {
                params.push(q("limit", int(1, 1000, 100), "Items per page."));
                params.push(q("next", json!({"type": "string"}), "The previous page's next."));
            }
            RouteId::Messages => {
                params.push(q("limit", int(1, 200, 50), "Messages per page."));
                for k in ["before", "after"] {
                    params.push(q(k, json!({"type": "string"}), "A message id or a time in ms."));
                }
                params.push(q("thread", json!({"type": "string"}), "Only this thread (its root's message id)."));
            }
            RouteId::Files => {
                params.push(q("limit", int(1, 200, 50), "Files per page (whole messages)."));
                params.push(q("next", json!({"type": "string"}), "The previous page's next."));
            }
            RouteId::Search => {
                params.push(json!({"name": "q", "in": "query", "required": true, "schema": {"type": "string", "minLength": 1, "maxLength": 256}, "description": "Keywords."}));
                params.push(q("conv", json!({"type": "string"}), "One conversation."));
                params.push(q("since", json!({"type": "integer"}), "From this time (ms)."));
                params.push(q("until", json!({"type": "integer"}), "Before this time (ms)."));
                params.push(q("limit", int(1, 50, 20), "Hits."));
            }
            RouteId::Mentions => {
                params.push(q("since", json!({"type": "integer"}), "From this time (ms)."));
                params.push(q("conv", json!({"type": "string"}), "One conversation."));
                params.push(q("limit", int(1, 200, 50), "Messages."));
            }
            RouteId::Events => {
                params.push(q("after", json!({"type": "string"}), "The cursor of the previous answer's next."));
                params.push(q("wait", int(0, WAIT_MAX_S as i64, 0), "Seconds to hold the request while nothing is new."));
            }
            RouteId::Post => params.push(json!({"name": "Idempotency-Key", "in": "header", "required": true, "schema": {"type": "string", "minLength": 1, "maxLength": 64}, "description": "1 to 64 printable ASCII characters."})),
            _ => {}
        }
        if !params.is_empty() {
            op.insert("parameters".into(), json!(params));
        }
        if r.id == RouteId::Post {
            op.insert("requestBody".into(), json!({"required": true, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": false, "required": ["text"],
                "properties": {"text": {"type": "string", "minLength": 1, "maxLength": TEXT_MAX}, "thread": {"type": "string"}}}}}}));
        }
        let (status, ctype) = match r.id {
            RouteId::Post => ("201", "application/json"),
            RouteId::File => ("200", "application/octet-stream"),
            RouteId::ApprovalPage => ("200", "text/html"),
            _ => ("200", "application/json"),
        };
        let mut responses = json!({status: {"description": "OK", "content": {ctype: {}}},
                                   "default": {"description": "A refusal (RFC 9457)", "content": {"application/problem+json": {}}}});
        if r.id == RouteId::Post {
            responses["202"] = json!({"description": "The person approves the post first (7.5)", "content": {"application/json": {}}});
        }
        op.insert("responses".into(), responses);
        let item = paths.entry(r.path.replace("{org}", org)).or_insert_with(|| json!({}));
        if let Some(o) = item.as_object_mut() {
            o.insert(r.method.to_ascii_lowercase(), Value::Object(op));
        }
    }
    // revision 6 7.3: the A2A rows under A (A2A 1.0 HTTP+JSON objects by name; errors in the A2A 11.6 shape)
    for r in A2A_ROUTES.iter() {
        let mut params = vec![json!({"name": "agent", "in": "path", "required": true, "schema": {"type": "string"}, "description": "An agent id (a_ and 16 hex)."}),
                              json!({"name": "A2A-Version", "in": "header", "required": true, "schema": {"type": "string", "enum": [crate::connector_a2a_wire::VERSION]}})];
        if r.path.contains("{id}") {
            params.push(json!({"name": "id", "in": "path", "required": true, "schema": {"type": "string"}, "description": "A task id (t2_ and 22 base64url)."}));
        }
        if r.path.contains("{config}") {
            params.push(json!({"name": "config", "in": "path", "required": true, "schema": {"type": "string"}, "description": "A push config id."}));
        }
        let object = a2a_object(r.method, r.path);
        let a2a_ct = crate::connector_a2a_wire::CONTENT_TYPE;
        let ctype = if object.contains("event-stream") { "text/event-stream" } else { a2a_ct };
        let op = json!({
            "operationId": format!("A2a{}{}", r.method.to_ascii_lowercase(), r.path.rsplit('/').next().unwrap_or_default().replace(['{', '}', ':'], "_")),
            "summary": r.summary, "x-lucid-pipeline": "connector-resource", "security": [{"oauth": [r.scope]}], "x-lucid-scope": r.scope, "x-lucid-reach": "R1",
            "x-lucid-class": "task class", "x-a2a-response": object, "parameters": params,
            "responses": {"200": {"description": "OK", "content": {ctype: {}}},
                          "default": {"description": "An error (A2A 11.6, google.rpc.Status with an ErrorInfo)", "content": {a2a_ct: {}}}},
        });
        let item = paths.entry(r.path.replace("{org}", org)).or_insert_with(|| json!({}));
        if let Some(o) = item.as_object_mut() {
            o.insert(r.method.to_ascii_lowercase(), op);
        }
    }
    json!({
        "openapi": "3.1.0",
        "info": {"title": format!("Lucid connector content API ({org})"), "version": "1"},
        "servers": [{"url": origin}],
        "paths": paths,
        "components": {"securitySchemes": {"oauth": {"type": "oauth2", "description": "A console-issued token for this resource, bound by DPoP or mTLS.",
                                                       "flows": {"clientCredentials": {"tokenUrl": format!("{issuer}/oauth/token"), "scopes": {READ: "r5 5.1 content.read", POST: "r5 5.1 content.post", A2A: "r6 9 spokes.tasks.submit (resource A = C/a2a)"}}}}}},
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::api_audit::{AuditError, Repr};
    use crate::api_cjournal::{ConsoleEntry, Reach};
    use crate::api_map::{api_map_hash, ApiMapStore, VerifiedApiMap};
    use crate::api_token::{Cnf, Delegation};
    use crate::ce_device::{Head, ZERO_HASH};
    use crate::ce_device_log as cl;
    use crate::codec::b64u;
    use crate::connector_session::tests::{World, APP, M1, M2};
    use crate::connector_session::{ContentEvent, ContentHooks};
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    pub(crate) const K: &str = "k_7a1b2c3d4e5f6a7b";
    pub(crate) const ORIGIN: &str = "https://connector.acme.test:9445";
    const ISSUER: &str = "https://console.acme.test:9443/api/orgs/acme";
    const KID: &str = "k-test";
    /// An `agent_delegated` client (Ann and Ben delegate to it).
    pub(crate) const DELEGATED: &str = "c_00000000000000d1";
    /// An `agent` with both content scopes, owned by Olga (who is in no conversation).
    pub(crate) const AGENT: &str = "c_00000000000000a1";
    /// An `app` client owned by Ann, posting without approval.
    pub(crate) const APPC: &str = "c_00000000000000b1";
    /// An `agent` whose ceiling is `internal`.
    pub(crate) const INTERNAL: &str = "c_00000000000000c1";
    pub(crate) const BEN: &str = "ben@acme.test";
    pub(crate) const OLGA: &str = "olga@acme.test";
    const VECTORS: &str = include_str!("../tests/chat_e2ee_v1.json");

    /// The connector's chain as a list; `fail` makes every append fail (a full audit disk).
    #[derive(Default)]
    pub(crate) struct Chain {
        pub(crate) entries: Mutex<Vec<Value>>,
        pub(crate) fail: AtomicBool,
    }

    impl Chain {
        fn push(&self, entry: Value) -> Result<u64, AuditError> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(AuditError::unavailable("the audit volume is full"));
            }
            let mut e = self.entries.lock();
            e.push(entry);
            Ok(e.len() as u64)
        }

        pub(crate) fn actions(&self) -> Vec<String> {
            self.entries.lock().iter().filter_map(|e| e.get("action").and_then(Value::as_str).map(str::to_string)).collect()
        }

        /// No entry holds `canary` in any value, and none has a value equal to `exact`.
        pub(crate) fn clean_of(&self, canary: &str, exact: &str) -> bool {
            self.entries.lock().iter().all(|e| !e.to_string().contains(canary) && e.as_object().is_none_or(|o| o.values().all(|v| v.as_str() != Some(exact))))
        }
    }

    impl AuditLog for Chain {
        fn record(&self, _org: &str, entry: Value, _now: i64) -> Result<u64, AuditError> {
            self.push(entry)
        }
        fn refusal(&self, _org: &str, _key: &str, _check: &str, _route: &str, entry: Value, _now: i64) -> Result<(), AuditError> {
            self.push(entry).map(|_| ())
        }
        fn allowed_ok(&self) -> bool {
            !self.fail.load(Ordering::SeqCst)
        }
        fn read(&self, _org: &str, _source: &str, _repr: Repr, _after: u64, _limit: usize) -> Result<Value, AuditError> {
            Ok(Value::Null)
        }
        fn keys(&self, _org: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    /// The listener glue's `event` forwarding (approval answers are handed to `Approvals` directly by the tests).
    struct Glue(Arc<ContentEvents>);

    impl ContentHooks for Glue {
        fn approval_answer(&self, _app: &str, _person: &str, _mid: &str, _apra: &Value) {}
        fn person_stop(&self, _app: &str, _person: &str, _client: &str, _mid: &str) {}
        fn event(&self, app: &str, ev: &ContentEvent) {
            self.0.push(app, ev);
        }
    }

    fn client(id: &str, name: &str, kind: &str, ceiling: &str, owner: &str, app: &str, now_s: i64) -> Value {
        let mut c = json!({"id": id, "name": name, "principal": format!("{name}@apps.acme.test"), "kind": kind, "owner": owner, "reach": "R1",
                           "scopes": [READ, POST], "ceiling": ceiling, "relays": ["*"], "networks": [], "mtls_required": false,
                           "rate": {"per_minute_each": 600, "per_day_each": 100000}, "credentials": [], "created": now_s - 86_400,
                           "expires": now_s + 300 * 86_400, "state": "active", "connectors": [K], "apps": [app], "channels": ["*"]});
        if kind != "app" {
            c["confirm"] = json!([POST]);
        }
        if kind == "agent_delegated" {
            c["delegation"] = json!({"groups": [], "principals": ["ann@acme.test", BEN], "idps": [], "consent_days": 7, "denied": []});
        }
        c
    }

    pub(crate) fn store_of(map: &Value) -> ApiMapStore {
        let wire = json!({"map": map, "sig": "", "chain": []});
        let vm = VerifiedApiMap {
            wire: wire.as_object().unwrap().clone(),
            org: "acme".into(),
            seq: map["seq"].as_i64().unwrap(),
            expires: map["expires"].as_i64().unwrap(),
            hash: api_map_hash(map),
            signer: "root".into(),
        };
        let mut s = ApiMapStore::load(None);
        s.pin(vm).unwrap();
        s
    }

    pub(crate) fn centry(action: &str, target: Value) -> ConsoleEntry {
        ConsoleEntry { id: "k_acme_000001".into(), org: "acme".into(), cseq: 1, ts: 1, action: action.into(), target, reach: Reach::Connector, prev_cseq: Some(0) }
    }

    pub(crate) fn path(rest: &str) -> String {
        format!("/api/orgs/acme/v1/{rest}")
    }

    /// A connector serving the CE-1 vector world's Helpdesk app, synced with a test map of four content clients.
    pub(crate) struct Fx {
        pub(crate) w: World,
        pub(crate) conn: Arc<Connector>,
        pub(crate) chain: Arc<Chain>,
        pub(crate) events: Arc<ContentEvents>,
        pub(crate) sync: Arc<SyncState>,
        pub(crate) approvals: Arc<Approvals>,
        pub(crate) api: ConnectorApi,
        pub(crate) map: Value,
        issuer: EcdsaKeyPair,
        dpop: EcdsaKeyPair,
        dpop_jwk: Value,
        n: AtomicU64,
    }

    impl Fx {
        pub(crate) fn new() -> Fx {
            let w = World::new();
            let v: Value = serde_json::from_str(VECTORS).unwrap();
            w.fake.devices.lock().push(v["bundles"]["ben1"].clone());
            let now_s = w.now / 1000;
            let conn = Arc::new(Connector::for_test(&w.dir, w.session.shared().clone(), BTreeMap::from([(APP.to_string(), w.session.clone())])));
            let issuer = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
            let mut ijwk = api_issue::ec_public_jwk(&issuer, KID);
            ijwk["nbf"] = json!(now_s - 86_400);
            ijwk["exp"] = json!(now_s + 90 * 86_400);
            let dpop = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
            let dpop_jwk = api_issue::ec_public_jwk(&dpop, "d1");
            let app = w.app_p.clone();
            let map = json!({"v": 1, "org": "acme", "seq": 7, "issued": now_s - 86_400, "expires": now_s + 30 * 86_400,
                             "issuer": {"url": ISSUER, "jwks": [ijwk]}, "grace": {"person": 0, "app": 24, "connector": 0, "relay": 0},
                             "failover_after_s": 300, "folded": [], "cleared": [], "relay_origins": {},
                             "connectors": [{"id": K, "name": "helpdesk", "origin": ORIGIN, "apps": [app], "networks": [], "stale_s": 60, "state": "active"}],
                             "clients": [client(DELEGATED, "claude-ops", "agent_delegated", "confidential", "ann@acme.test", &app, now_s),
                                         client(AGENT, "ops-agent", "agent", "confidential", OLGA, &app, now_s),
                                         client(APPC, "ops-app", "app", "confidential", "ann@acme.test", &app, now_s),
                                         client(INTERNAL, "int-agent", "agent", "internal", "ann@acme.test", &app, now_s)]});
            let chain = Arc::new(Chain::default());
            let events = Arc::new(ContentEvents::new());
            *w.hooks.1.write() = Some(Arc::new(Glue(events.clone())));
            let sync = Arc::new(SyncState::for_test("acme", K, store_of(&map), Vec::new(), Fx::keys(&[DELEGATED, AGENT, APPC, INTERNAL]), w.now));
            let approvals = Arc::new(Approvals::open(conn.clone(), sync.clone(), chain.clone()).unwrap());
            let api = ConnectorApi::new(conn.clone(), sync.clone(), chain.clone(), approvals.clone(), events.clone());
            Fx { w, conn, chain, events, sync, approvals, api, map, issuer, dpop, dpop_jwk, n: AtomicU64::new(0) }
        }

        pub(crate) fn keys(clients: &[&str]) -> BTreeMap<String, [u8; 32]> {
            clients.iter().enumerate().map(|(i, c)| (c.to_string(), [i as u8 + 1; 32])).collect()
        }

        /// A new sync answer: the map, the active 4b entries, the client keys and the sync time (the approvals reopen
        /// from their sealed records).
        pub(crate) fn resync(&mut self, map: Value, console: Vec<ConsoleEntry>, keys: BTreeMap<String, [u8; 32]>, synced_ms: i64) {
            self.sync = Arc::new(SyncState::for_test("acme", K, store_of(&map), console, keys, synced_ms));
            self.approvals = Arc::new(Approvals::open(self.conn.clone(), self.sync.clone(), self.chain.clone()).unwrap());
            self.api = ConnectorApi::new(self.conn.clone(), self.sync.clone(), self.chain.clone(), self.approvals.clone(), self.events.clone());
            self.map = map;
        }

        pub(crate) fn console(&mut self, console: Vec<ConsoleEntry>) {
            let map = self.map.clone();
            self.resync(map, console, Fx::keys(&[DELEGATED, AGENT, APPC, INTERNAL]), self.w.now);
        }

        fn jkt(&self) -> String {
            tok::jwk_thumbprint(&tok::parse_jwk(&self.dpop_jwk, tok::CLIENT_RSA_MIN_BITS).unwrap())
        }

        /// A token for C: delegated for `person`, else the client's own.
        pub(crate) fn token(&self, client: &str, person: Option<&str>) -> String {
            let now_s = self.w.now / 1000;
            let aud = connector_resource(ORIGIN, "acme");
            let scopes = vec![READ.to_string(), POST.to_string()];
            let c = self.map["clients"].as_array().unwrap().iter().find(|c| c["id"] == client).unwrap();
            let ceiling = c["ceiling"].as_str().unwrap();
            let cnf = Cnf::Jkt(self.jkt());
            let minted = match person {
                Some(p) => {
                    let act = json!({"sub": client});
                    let d = Delegation { person: p, grant: "jwt_bearer", idp: None, auth_time: now_s - 10, act: &act };
                    tok::mint_delegated_token(&self.issuer, KID, ISSUER, &aud, client, "acme", &scopes, "R1", ceiling, 7, &cnf, &d, now_s, now_s + 600)
                }
                None => tok::mint_access_token(&self.issuer, KID, ISSUER, &aud, client, "acme", &scopes, "R1", ceiling, 7, &cnf, now_s, now_s + 600),
            };
            minted.unwrap().token
        }

        /// Revision 6 (slice 1d4 tests): the client's own token for `aud` with `scopes`.
        pub(crate) fn mint(&self, client: &str, aud: &str, scopes: &[&str]) -> String {
            let now_s = self.w.now / 1000;
            let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
            let c = self.map["clients"].as_array().unwrap().iter().find(|c| c["id"] == client).unwrap();
            let ceiling = c["ceiling"].as_str().unwrap();
            tok::mint_access_token(&self.issuer, KID, ISSUER, aud, client, "acme", &scopes, "R1", ceiling, 7, &Cnf::Jkt(self.jkt()), now_s, now_s + 600).unwrap().token
        }

        pub(crate) fn proof(&self, method: &str, p: &str, token: &str, at: i64) -> String {
            let jti = format!("p{}", self.n.fetch_add(1, Ordering::SeqCst));
            let claims = json!({"jti": jti, "htm": method, "htu": format!("{ORIGIN}{p}"), "iat": at / 1000, "ath": b64u(&sha256(token.as_bytes()))});
            tok::sign_es256(&self.dpop, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": self.dpop_jwk}), &claims).unwrap()
        }

        #[allow(clippy::too_many_arguments)]
        pub(crate) fn call(&self, method: &str, p: &str, query: &str, token: Option<&str>, body: Option<&[u8]>, key: Option<&str>, at: i64) -> Answer {
            let auth = token.map(|t| format!("DPoP {t}"));
            let proof = token.map(|t| self.proof(method, p, t, at));
            let req = Request {
                method,
                path: p,
                query,
                authorization: auth.as_deref(),
                dpop: proof.as_deref(),
                idempotency_key: key,
                body: body.map(Ok),
                source: "10.40.0.9".parse().unwrap(),
                now_ms: at,
            };
            self.api.answer(&req)
        }

        pub(crate) fn get(&self, token: &str, rest: &str, query: &str) -> Answer {
            self.call("GET", &path(rest), query, Some(token), None, None, self.w.now)
        }

        pub(crate) fn post(&self, token: &str, cid: &str, text: &str, key: &str, at: i64) -> Answer {
            let body = json!({"text": text}).to_string();
            self.call("POST", &path(&format!("content/conversations/{cid}/messages")), "", Some(token), Some(body.as_bytes()), Some(key), at)
        }

        /// A group chat Ann made, then `ops` (op, who, time) on its member log; when the app is a member at the end,
        /// Ann's epoch key `key` is wrapped to it at the last head.
        pub(crate) fn chat(&self, channel: &str, ops: &[(&str, &str, i64)], key: &[u8; 32]) -> (String, Head) {
            let w = &self.w;
            let cid = format!("ch:{channel}");
            let first = w.entry(&cid, 1, "create", &w.ann_p, w.now - 5000, &ZERO_HASH, "group");
            let mut prev = cl::entry_hash(&cid, &first).unwrap();
            let mut entries = vec![first];
            let mut app_in = false;
            for (op, who, ts) in ops {
                let e = w.entry(&cid, entries.len() as i64 + 1, op, who, *ts, &prev, "");
                prev = cl::entry_hash(&cid, &e).unwrap();
                entries.push(e);
                if *who == w.app_p {
                    app_in = *op == "add";
                }
            }
            let head = Head { seq: entries.len() as i64, hash: prev };
            w.fake.logs.lock().insert(cid.clone(), entries);
            if app_in {
                let mut pds = vec![(w.ann_p.clone(), w.ann_d.clone()), (w.app_p.clone(), w.app_d.clone())];
                crate::ce_device::sort_pds(&mut pds);
                let members = crate::ce_device::set_hash(&pds).unwrap();
                let mut wrap = crate::ce_device::make_wrap(&w.ann, &cid, &w.ann_p, &w.ann_d, &w.ann_serial, 1, key, &w.app_vb, &members, head, w.now - 3000, None, None, None).unwrap();
                wrap["seq"] = json!(w.seq());
                w.fake.wraps.lock().push(wrap);
            }
            (cid, head)
        }

        /// The app reads the logs of `cids` and its new keys.
        pub(crate) fn sync_chats(&self, cids: &[&str]) {
            let w = &self.w;
            let mut evs: Vec<Value> = cids.iter().map(|c| json!({"seq": w.seq(), "type": "chat_log", "channel": &c[3..]})).collect();
            evs.push(json!({"seq": w.seq(), "type": "chat_keys"}));
            w.session.deliver(&evs, w.now).unwrap();
        }

        /// A chat with Ann, the app (and Ben when `ben`), read by the app.
        pub(crate) fn room(&self, channel: &str, ben: bool) -> (String, Head, [u8; 32]) {
            let key = [channel.len() as u8 + 40; 32];
            let w = &self.w;
            let mut ops = vec![("add", w.app_p.as_str(), w.now - 4000)];
            if ben {
                ops.push(("add", BEN, w.now - 3500));
            }
            let (cid, head) = self.chat(channel, &ops, &key);
            self.sync_chats(&[cid.as_str()]);
            (cid, head, key)
        }

        /// Ann posts `text` as message `mid` (counter `n`, time now - 2000 + n).
        pub(crate) fn say(&self, cid: &str, head: Head, key: &[u8; 32], mid: &str, n: i64, text: &str) {
            let w = &self.w;
            let env = w.envelope(cid, mid, n, "post", "", json!({"t": text, "m": []}), head, key);
            w.session.deliver(&[w.post_event(w.seq(), cid, mid, env)], w.now).unwrap();
        }

        pub(crate) fn channel_posts(&self) -> usize {
            self.w.fake.sent.lock().iter().filter(|(r, _)| r == "/v1/channels/post").count()
        }

        pub(crate) fn dm_posts(&self) -> usize {
            self.w.fake.sent.lock().iter().filter(|(r, _)| r == "/v1/dm").count()
        }
    }

    fn cids(a: &Answer) -> Vec<String> {
        a.json()["conversations"].as_array().unwrap().iter().map(|c| c["cid"].as_str().unwrap().to_string()).collect()
    }

    /// r5 18 acceptance: channels A (app added, person member), B (app never added), C (app added then removed),
    /// D (app added, person not a member): the person's client lists exactly A, and B, C and D answer `not-found`
    /// with the same body as an unknown cid.
    #[test]
    fn the_acceptance_channels_list_only_a() {
        let fx = Fx::new();
        let w = &fx.w;
        let key = [21u8; 32];
        let app = w.app_p.as_str();
        let (a, _) = fx.chat("acc-a", &[("add", app, w.now - 4000), ("add", BEN, w.now - 3500)], &key);
        let (b, _) = fx.chat("acc-b", &[("add", BEN, w.now - 3500)], &key);
        let (c, _) = fx.chat("acc-c", &[("add", app, w.now - 4000), ("add", BEN, w.now - 3500), ("remove", app, w.now - 3000)], &key);
        let (d, _) = fx.chat("acc-d", &[("add", app, w.now - 4000)], &key);
        fx.sync_chats(&[a.as_str(), b.as_str(), c.as_str(), d.as_str()]);
        let ben = fx.token(DELEGATED, Some(BEN));
        let list = fx.get(&ben, "content/conversations", "");
        assert_eq!(list.status, 200, "{:?}", list.json());
        assert_eq!(cids(&list), vec![a.clone()]);
        assert_eq!(fx.get(&ben, &format!("content/conversations/{a}"), "").status, 200);
        let unknown = fx.get(&ben, "content/conversations/ch:acc-unknown", "");
        assert_eq!(unknown.status, 404);
        for x in [&b, &c, &d] {
            let got = fx.get(&ben, &format!("content/conversations/{x}"), "");
            assert_eq!((got.status, &got.body), (404, &unknown.body), "{x} answers exactly as an unknown cid");
            let msgs = fx.get(&ben, &format!("content/conversations/{x}/messages"), "");
            assert_eq!((msgs.status, &msgs.body), (404, &unknown.body));
        }
        // every call is in the chain before its answer
        let rid = unknown.header("X-Lucid-Request-Id").unwrap().to_string();
        assert!(fx.chain.entries.lock().iter().any(|e| e["rid"] == rid.as_str() && e["action"] == "api.refusal" && e["check"] == "not-found"));
        let rid = list.header("X-Lucid-Request-Id").unwrap().to_string();
        assert!(fx.chain.entries.lock().iter().any(|e| e["rid"] == rid.as_str() && e["action"] == "api.call" && e["resource"] == K && e["items"] == 1));
    }

    /// 5.2: a delegated person who joined after the app sees only messages from their join; the app's own client sees
    /// all; `from` follows 5.5.
    #[test]
    fn a_person_who_joined_later_sees_only_messages_from_their_join() {
        let fx = Fx::new();
        let w = &fx.w;
        let key = [22u8; 32];
        let (a, head) = fx.chat("late", &[("add", w.app_p.as_str(), w.now - 4000), ("add", BEN, w.now - 1500)], &key);
        fx.sync_chats(&[a.as_str()]);
        fx.say(&a, head, &key, M1, 1, "before ben");
        fx.say(&a, head, &key, M2, 1000, "after ben");
        let ids = |ans: &Answer| ans.json()["messages"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let ben = fx.get(&fx.token(DELEGATED, Some(BEN)), &format!("content/conversations/{a}/messages"), "");
        assert_eq!(ben.status, 200, "{:?}", ben.json());
        assert_eq!(ids(&ben), vec![M2.to_string()]);
        let from = &ben.json()["messages"][0]["from"];
        assert_eq!(from["email"], w.ann_p.as_str());
        assert!(from.get("self").is_none());
        assert_eq!(from["id"], view::face_id(&Fx::keys(&[DELEGATED])[DELEGATED], &w.ann_p));
        let ann = fx.get(&fx.token(DELEGATED, Some(&w.ann_p)), &format!("content/conversations/{a}/messages"), "");
        assert_eq!(ids(&ann), vec![M2.to_string(), M1.to_string()]);
        assert_eq!(ann.json()["messages"][0]["from"]["self"], true);
        let app = fx.get(&fx.token(APPC, None), &format!("content/conversations/{a}/messages"), "limit=1");
        assert_eq!((ids(&app), app.json()["next"].clone()), (vec![M2.to_string()], json!(M2)));
        let rest = fx.get(&fx.token(APPC, None), &format!("content/conversations/{a}/messages"), &format!("before={M2}"));
        assert_eq!(ids(&rest), vec![M1.to_string()]);
    }

    /// 5.2 step 7 and 5.4: a policy without `ai` makes every conversation confidential, invisible to an internal
    /// client; O4: a DM cid never appears.
    #[test]
    fn confidential_is_invisible_to_an_internal_client_and_dms_never_appear() {
        let fx = Fx::new();
        let (a, _, _) = fx.room("cls", false);
        let internal = fx.token(INTERNAL, None);
        assert!(cids(&fx.get(&internal, "content/conversations", "")).is_empty());
        assert_eq!(fx.get(&internal, &format!("content/conversations/{a}"), "").status, 404);
        let agent = fx.token(AGENT, None);
        assert_eq!(cids(&fx.get(&agent, "content/conversations", "")), vec![a.clone()]);
        let dm = crate::ce_device::dm_cid(&fx.w.ann_p, &fx.w.app_p).unwrap();
        assert_eq!(fx.get(&agent, &format!("content/conversations/{dm}"), "").status, 404);
    }

    /// r5 18 tightening: `client_limit_channels`, `client_drop_app`, `connector_suspend` and `person_revoke` apply at
    /// the connector from its sync.
    #[test]
    fn console_journal_tightenings_apply() {
        let mut fx = Fx::new();
        let (a, _, _) = fx.room("tight", true);
        let ann = fx.w.ann_p.clone();
        let app = fx.w.app_p.clone();
        let conv = format!("content/conversations/{a}");
        fx.console(vec![centry("client_limit_channels", json!({"client": DELEGATED, "channels": ["ch:elsewhere"]}))]);
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(&ann)), &conv, "").status, 404);
        assert_eq!(fx.get(&fx.token(APPC, None), &conv, "").status, 200, "another client is not limited");
        fx.console(vec![centry("client_drop_app", json!({"client": DELEGATED, "app": app}))]);
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(&ann)), &conv, "").status, 404);
        fx.console(vec![centry("person_revoke", json!({"client": DELEGATED, "principal": BEN}))]);
        let ben = fx.get(&fx.token(DELEGATED, Some(BEN)), &conv, "");
        assert_eq!((ben.status, ben.json()["code"].clone()), (403, json!("person")));
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(&ann)), &conv, "").status, 200, "only the revoked person");
        fx.console(vec![centry("connector_suspend", json!(K))]);
        let s = fx.get(&fx.token(APPC, None), &conv, "");
        assert_eq!((s.status, s.json()["code"].clone()), (403, json!("suspended")));
    }

    /// 2.8, 5.5: not fresh, or no id key for the client: every content call answers 503 `connector-stale`.
    #[test]
    fn a_stale_connector_answers_connector_stale() {
        let mut fx = Fx::new();
        let (a, _, _) = fx.room("stale", false);
        let map = fx.map.clone();
        let now = fx.w.now;
        fx.resync(map.clone(), Vec::new(), Fx::keys(&[DELEGATED, AGENT, APPC, INTERNAL]), now - 61_000);
        let got = fx.get(&fx.token(APPC, None), &format!("content/conversations/{a}"), "");
        assert_eq!((got.status, got.json()["code"].clone()), (503, json!("connector-stale")));
        fx.resync(map, Vec::new(), Fx::keys(&[DELEGATED]), now);
        let got = fx.get(&fx.token(APPC, None), "content/conversations", "");
        assert_eq!((got.status, got.json()["code"].clone()), (503, json!("connector-stale")), "no id key for the client");
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(&fx.w.ann_p)), "content/conversations", "").status, 200);
    }

    /// 9.4: with the audit disk full every content call answers 503 `audit-unavailable`.
    #[test]
    fn an_audit_append_failure_answers_audit_unavailable() {
        let fx = Fx::new();
        fx.room("audit", false);
        fx.chain.fail.store(true, Ordering::SeqCst);
        let got = fx.get(&fx.token(APPC, None), "content/conversations", "");
        assert_eq!((got.status, got.json()["code"].clone()), (503, json!("audit-unavailable")));
        let got = fx.get(&fx.token(APPC, None), "content/conversations/ch:nothing", "");
        assert_eq!((got.status, got.json()["code"].clone()), (503, json!("audit-unavailable")));
    }

    /// 12.2: no entry holds message text, search text or a conversation name.
    #[test]
    fn no_audit_entry_holds_content_canaries() {
        let fx = Fx::new();
        let (a, head, key) = fx.room("canary", false);
        fx.say(&a, head, &key, M1, 1, "canary-text-7731 lunch");
        let t = fx.token(APPC, None);
        assert_eq!(fx.get(&t, &format!("content/conversations/{a}/messages"), "").status, 200);
        let hits = fx.get(&t, "content/search", "q=canary-text-7731");
        assert_eq!(hits.status, 200, "{:?}", hits.json());
        assert_eq!(hits.json()["hits"].as_array().unwrap().len(), 1);
        assert_eq!(fx.get(&t, "content/search", "q=canary-query-5512").json()["hits"], json!([]));
        let posted = fx.post(&t, &a, "canary-post-9910", "k-canary", fx.w.now);
        assert_eq!(posted.status, 201, "{:?}", posted.json());
        assert_eq!(posted.json()["message"]["via"]["client"], "ops-app");
        assert_eq!(fx.get(&t, &format!("content/conversations/{a}"), "").json()["conversation"]["name"], "ops");
        assert!(fx.chain.actions().iter().filter(|x| *x == "api.call").count() >= 5);
        for canary in ["canary-text-7731", "canary-query-5512", "canary-post-9910"] {
            assert!(fx.chain.clean_of(canary, "ops"), "{canary} or the conversation name in the chain");
        }
    }

    /// 7.1: the public routes: RFC 9728 documents from the connector's own entry, OpenAPI from the route table, and
    /// the approval page with its exact words and CSP.
    #[test]
    fn the_public_routes() {
        let fx = Fx::new();
        let get = |p: &str| fx.call("GET", p, "", None, None, None, fx.w.now);
        let meta = get("/.well-known/oauth-protected-resource/api/orgs/acme");
        assert_eq!(meta.status, 200);
        assert_eq!(meta.json()["resource"], connector_resource(ORIGIN, "acme"));
        assert_eq!(get("/.well-known/oauth-protected-resource/api/orgs/acme/mcp").json()["resource"], connector_mcp_resource(ORIGIN, "acme"));
        let doc = get(&path("openapi.json")).json();
        assert_eq!(doc["openapi"], "3.1.0");
        assert_eq!(doc["servers"][0]["url"], ORIGIN);
        assert!(doc["paths"]["/api/orgs/acme/v1/content/conversations/{cid}/messages"]["post"]["x-lucid-scope"] == POST);
        let page = get(&path(&format!("content/approvals/{}/page", "0".repeat(32))));
        assert_eq!(page.status, 200);
        assert_eq!(page.header("Content-Security-Policy"), Some("default-src 'none'; frame-ancestors 'none'"));
        let html = String::from_utf8(page.body.clone()).unwrap();
        assert!(html.contains(PAGE_WORDS) && html.contains("<p>expired</p>"), "an unknown id shows expired");
        let none = get(&path("content/conversations"));
        assert_eq!(none.status, 401);
        assert!(none.header("WWW-Authenticate").unwrap().contains("resource_metadata="));
        assert_eq!(get("/api/orgs/other/v1/health").status, 404);
    }

    /// 7.6: events of visible conversations only, the message read at delivery (a deleted one is never revealed),
    /// cursors per client.
    #[test]
    fn content_events_are_judged_at_delivery() {
        let fx = Fx::new();
        let (a, head, key) = fx.room("events", false);
        let agent = fx.token(AGENT, None);
        let first = fx.get(&agent, "content/events", "after=0");
        assert_eq!(first.status, 200);
        let types: Vec<String> = first.json()["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap().to_string()).collect();
        assert!(types.contains(&"conversation.added".to_string()));
        let next = first.json()["next"].as_str().unwrap().to_string();
        fx.say(&a, head, &key, M1, 1, "event text");
        let got = fx.get(&agent, "content/events", &format!("after={next}"));
        let evs = got.json()["events"].clone();
        assert_eq!(evs[0]["type"], "message.created");
        assert_eq!(evs[0]["message"]["text"], "event text");
        // the cursor is kept per client: a poll without `after` starts after it
        assert_eq!(fx.get(&agent, "content/events", "").json()["events"], json!([]));
        // an internal client sees none of it
        assert_eq!(fx.get(&fx.token(INTERNAL, None), "content/events", "after=0").json()["events"], json!([]));
        // a deleted message is never revealed
        fx.w.store.delete(APP, &a, M1).unwrap();
        let again = fx.get(&agent, "content/events", &format!("after={next}"));
        assert!(again.json()["events"].as_array().unwrap().iter().all(|e| e["type"] != "message.created"));
    }

    #[test]
    fn post_bodies_and_keys_are_checked() {
        let ok = |s: &str| post_body(Some(Ok(s.as_bytes()))).is_ok();
        assert!(ok(r#"{"text": "hi"}"#));
        assert!(!ok(r#"{"text": ""}"#));
        assert!(!ok(r#"{"text": "hi", "x": 1}"#));
        assert!(ok(&json!({"text": "hi", "thread": M1}).to_string()));
        assert!(!ok(r#"{"text": "hi", "thread": "nope"}"#));
        assert_eq!(post_body(Some(Err("too-large"))).err().map(|n| n.status), Some(413));
        assert_eq!(post_body(Some(Err("request"))).err().map(|n| n.status), Some(400));
        let long = json!({"text": "x".repeat(TEXT_MAX + 1)}).to_string();
        assert!(post_body(Some(Ok(long.as_bytes()))).is_err());
        let fx = Fx::new();
        let (a, _, _) = fx.room("keys", false);
        let t = fx.token(APPC, None);
        let body = json!({"text": "hi"}).to_string();
        let p = path(&format!("content/conversations/{a}/messages"));
        let long = "k".repeat(65);
        assert_eq!(fx.call("POST", &p, "", Some(t.as_str()), Some(body.as_bytes()), None, fx.w.now).status, 400, "Idempotency-Key is required");
        assert_eq!(fx.call("POST", &p, "", Some(t.as_str()), Some(body.as_bytes()), Some(long.as_str()), fx.w.now).status, 400);
    }

    #[test]
    fn routes_match_their_patterns() {
        let (r, p) = route_of("GET", "/api/orgs/acme/v1/content/conversations/ch%3Aops/files/f1").unwrap();
        assert_eq!((r.id, p.org.as_str(), p.cid.as_str(), p.fid.as_str()), (RouteId::File, "acme", "ch:ops", "f1"));
        assert_eq!(route_of("POST", "/api/orgs/acme/v1/content/conversations/ch:ops/messages").unwrap().0.id, RouteId::Post);
        assert_eq!(route_of("GET", "/api/orgs/acme/v1/content/approvals/ab/page").unwrap().0.id, RouteId::ApprovalPage);
        assert!(route_of("DELETE", "/api/orgs/acme/v1/health").is_none());
        assert!(route_of("GET", "/api/orgs/acme/v1/content/conversations/").is_none());
    }
}
