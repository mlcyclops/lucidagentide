// Contract API-1 revision 6 (phase 1d), 7.2 to 7.12, 11 and 12 (slice 1d4): the A2A server on the connector.
//
// A = `C/a2a`; every route of 7.3 lives under `A/<agent id>` and runs, in order: the enclave refusal (7.2.1, 503
// `enclave`), checks 0 to 11 of the connector resource pipeline with A as the token's `aud` (`ConnectorApi::a2a_gate`,
// which also answers 503 `connector-stale`), then 7.4: A1 `A2A-Version` 1.0, A2 the agent (pinned, not `agent_off`,
// served by this connector's service hub, in the client's `a2a.agents`, not `client_drop_agent`; otherwise 404
// `TASK_NOT_FOUND` with no existence leak), A3 the task is this client's for this agent, A4 the skill, A5 the open task
// limit, A6 the task class against the effective ceiling, A7 the body, A8 the audit. Errors use the A2A 11.6 shape
// (`connector_a2a_wire::Fault`); every answer carries `X-Lucid-Request-Id`.
//
// Tasks (7.6): `t2_` ids mapped 1:1 to the service hub's spoke tasks (`connector_spokes::ServiceHub`, never shown to
// the partner). A record per task in the connector's sealed store: `a2a-m-<hex id>` (metadata, push configs with
// their sealed credentials) and `a2a-c-<hex id>` (history and artifacts, task content), written before an answer or an
// event leaves; `a2a-index` lists them. The hub's inbox loop calls `HubEvents`; a worker thread then reads the task's
// verified spoke journal (`recall`, 7.8) for turns (`turn-<n>` artifacts), the handoff commit, the approvals
// (`a2a.approval`) and the close reason, and maps the spoke state to the A2A state with Lucid's sentence
// (`connector_a2a_wire::lifecycle`). A held ask whose digest is not the one of the input this connector sent is denied
// and the task fails (the approver must sign what the partner sent, R6-6).
//
// The worker also runs every 10 s: results of working tasks, `idle_close_s`, the journal's `agent_off`,
// `client_drop_agent` and suspended or deleted clients (open tasks canceled), the 72 hour mailbox TTL, retention (14
// days, 1000 terminal tasks per agent), push configs dropped by `push_off`, `push_drop_origin` or 24 hours after the
// task ended, and the open streams' standing (7.9).
//
// Streams (7.9) are SSE bodies fed by a channel per stream; pushes (7.10) are `connector_a2a_push`'s. Audit (11):
// `a2a.task` for each A2A call and each state change, `a2a.approval` from the spoke journal, `a2a.push` per attempt;
// refusals are `api.refusal` with the 7.11 code. Telemetry (12): the `lucid_a2a_*` families, reported in the sync ack.

use crate::api_catalog::counters;
use crate::api_cjournal as cj;
use crate::api_resource::{self as res, AuditLog};
use crate::api_token as tok;
use crate::codec::{hex, now_ms, str_of};
use crate::connector::Connector;
use crate::connector_a2a_push::{NetPoster, Outcome, Poster, Pusher, Target};
use crate::connector_a2a_wire::{self as w, Fault, Intake, Op, TaskState, TurnRefused, Why};
use crate::connector_api::{A2aGate, Answer, ConnectorApi, Request};
use crate::connector_seal::SealedStore;
use crate::connector_spokes::{HubError, HubEvents, HubTask, Rejected, ServiceHub, Submit, SubmitError};
use crate::connector_spokes_wire::{ask_digest, held_text, task_name, Partner};
use crate::connector_sync::SyncState;
use crate::connector_view::Ground;
use crate::meet::{log_error, log_info, log_warn};
use crate::meet_org_policy::Obj;
use bytes::Bytes;
use http_body_util::{BodyExt, Either, Full, Limited};
use hyper::body::Incoming;
use hyper::Response;
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

/// The listener's body: whole answers, or an SSE stream.
pub type Body = Either<Full<Bytes>, SseBody>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

const INDEX: &str = "a2a-index";
/// The worker's housekeeping period.
pub const TICK: Duration = Duration::from_secs(10);
/// Pages of one task's journal read in one sync at most.
const RECALL_PAGES: usize = 16;
const STREAM_QUEUE: usize = 64;
/// Announced asks kept for the worker: spoke tasks, and asks per task.
const ASKS_MAX: usize = 4096;
const ASKS_PER_TASK: usize = 16;
const UNAVAILABLE: &str = "This connector's agents cannot take requests now; try again later.";
const SPOKE_DOWN: &str = "The spoke could not be reached; try again later.";

// ── records ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A push config of a task (7.10); `credentials` and `token` are sealed with the record.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PushConfig {
    id: String,
    url: String,
    origin: String,
    token: Option<String>,
    credentials: Option<String>,
}

impl PushConfig {
    fn to_json(&self) -> Value {
        json!({"id": self.id, "url": self.url, "origin": self.origin, "token": self.token, "credentials": self.credentials})
    }

    fn of(v: &Value) -> Option<PushConfig> {
        let s = |k: &str| str_of(v.get(k)).map(str::to_string);
        Some(PushConfig { id: s("id")?, url: s("url")?, origin: s("origin")?, token: s("token"), credentials: s("credentials") })
    }
}

/// A task's metadata (no task text).
#[derive(Clone, Debug, PartialEq)]
struct Meta {
    id: String,
    agent: String,
    client: String,
    skill: String,
    context: String,
    spoke_task: Option<String>,
    spoke: Option<String>,
    state: TaskState,
    why: Option<Why>,
    status_ms: i64,
    created_ms: i64,
    many: bool,
    idle_close_s: i64,
    /// The spoke journal seq read so far.
    seen_seq: i64,
    /// Turn artifacts made so far.
    turns: i64,
    refused: Option<TurnRefused>,
    closed_reason: Option<String>,
    ask_expires: Option<i64>,
    /// The digest the next held ask of `expect_kind` must carry (`ask_digest` of what this connector sent), kept
    /// until an ask of that kind has been compared with it.
    expect: Option<String>,
    expect_kind: Option<String>,
    /// The last held ask whose digest matched (its id), so the hub's view of it is not compared again.
    verified_ask: Option<String>,
    /// The task class (r6 1) of its spoke, from the spoke's certificate when the task was made (7.4 A6).
    class: Option<String>,
    /// A state decided but not yet audited (`a2a.task`): it is announced only once its entry is in.
    pending: Option<(TaskState, Option<Why>)>,
    /// A follow-up sealed before it was sent (its `messageId`), until the spoke answered.
    pending_turn: Option<String>,
    artifacts: usize,
    artifact_bytes: usize,
    truncated: bool,
    /// `messageId`s with their times (24 hours, 7.5).
    messages: Vec<(String, i64)>,
    push: Vec<PushConfig>,
    ended_ms: Option<i64>,
    idle_ms: Option<i64>,
    recall_ms: i64,
}

impl Meta {
    fn to_json(&self) -> Value {
        json!({
            "v": 1, "id": self.id, "agent": self.agent, "client": self.client, "skill": self.skill, "context": self.context,
            "spoke_task": self.spoke_task, "spoke": self.spoke, "state": self.state.label(), "why": self.why.map(|x| x.code()),
            "status_ms": self.status_ms, "created_ms": self.created_ms, "many": self.many, "idle_close_s": self.idle_close_s,
            "seen_seq": self.seen_seq, "turns": self.turns,
            "refused": self.refused.map(|r| if r == TurnRefused::Declined { "declined" } else { "expired" }),
            "closed_reason": self.closed_reason, "ask_expires": self.ask_expires, "expect": self.expect, "expect_kind": self.expect_kind,
            "class": self.class, "pending": self.pending.map(|(s, w)| json!({"state": s.label(), "why": w.map(|x| x.code())})),
            "pending_turn": self.pending_turn, "verified_ask": self.verified_ask,
            "artifacts": self.artifacts, "artifact_bytes": self.artifact_bytes, "truncated": self.truncated,
            "messages": self.messages.iter().map(|(m, at)| json!([m, at])).collect::<Vec<_>>(),
            "push": self.push.iter().map(PushConfig::to_json).collect::<Vec<_>>(),
            "ended_ms": self.ended_ms, "idle_ms": self.idle_ms, "recall_ms": self.recall_ms,
        })
    }

    fn of(v: &Value) -> Option<Meta> {
        let s = |k: &str| str_of(v.get(k)).map(str::to_string);
        let i = |k: &str| v.get(k).and_then(Value::as_i64);
        Some(Meta {
            id: s("id")?,
            agent: s("agent")?,
            client: s("client")?,
            skill: s("skill")?,
            context: s("context")?,
            spoke_task: s("spoke_task"),
            spoke: s("spoke"),
            state: TaskState::of(str_of(v.get("state"))?)?,
            why: str_of(v.get("why")).and_then(Why::of_code),
            status_ms: i("status_ms").unwrap_or(0),
            created_ms: i("created_ms").unwrap_or(0),
            many: v.get("many") == Some(&Value::Bool(true)),
            idle_close_s: i("idle_close_s").unwrap_or(0),
            seen_seq: i("seen_seq").unwrap_or(0),
            turns: i("turns").unwrap_or(0),
            refused: match str_of(v.get("refused")) {
                Some("declined") => Some(TurnRefused::Declined),
                Some("expired") => Some(TurnRefused::Expired),
                _ => None,
            },
            closed_reason: s("closed_reason"),
            ask_expires: i("ask_expires"),
            expect: s("expect"),
            expect_kind: s("expect_kind"),
            class: s("class"),
            pending: v.get("pending").and_then(|p| Some((TaskState::of(str_of(p.get("state"))?)?, str_of(p.get("why")).and_then(Why::of_code)))),
            pending_turn: s("pending_turn"),
            verified_ask: s("verified_ask"),
            artifacts: i("artifacts").unwrap_or(0) as usize,
            artifact_bytes: i("artifact_bytes").unwrap_or(0) as usize,
            truncated: v.get("truncated") == Some(&Value::Bool(true)),
            messages: v.get("messages").and_then(Value::as_array).into_iter().flatten().filter_map(|m| Some((str_of(m.get(0))?.to_string(), m.get(1)?.as_i64()?))).collect(),
            push: v.get("push").and_then(Value::as_array).into_iter().flatten().filter_map(PushConfig::of).collect(),
            ended_ms: i("ended_ms"),
            idle_ms: i("idle_ms"),
            recall_ms: i("recall_ms").unwrap_or(0),
        })
    }
}

/// A task's content: the partner's messages (the last 20) and the artifacts.
#[derive(Clone, Debug, Default, PartialEq)]
struct Content {
    history: Vec<Value>,
    artifacts: Vec<Value>,
}

fn meta_name(id: &str) -> String {
    format!("a2a-m-{}", hex(id.as_bytes()))
}

fn content_name(id: &str) -> String {
    format!("a2a-c-{}", hex(id.as_bytes()))
}

// ── streams (7.9) ───────────────────────────────────────────────────────────────────────────────────────────

/// One open SSE stream.
pub struct Sub {
    id: u64,
    client: String,
    agent: String,
    task: String,
    /// The token's end (s).
    exp_s: i64,
    /// The rank of the task's class: the stream closes once the client's ceiling falls below it.
    class_rank: usize,
    opened: Instant,
    tx: Mutex<Option<tokio::sync::mpsc::Sender<Bytes>>>,
    closed: AtomicBool,
}

impl Sub {
    fn send(&self, text: String) -> bool {
        self.tx.lock().as_ref().is_some_and(|tx| tx.try_send(Bytes::from(text)).is_ok())
    }
}

#[derive(Default)]
struct Streams {
    by_task: HashMap<String, Vec<Arc<Sub>>>,
    per_client: HashMap<String, usize>,
    total: usize,
    next: u64,
}

/// The SSE body of one stream; dropping it (the partner went away) closes the stream.
pub struct SseBody {
    rx: tokio::sync::mpsc::Receiver<Bytes>,
    server: Arc<A2aServer>,
    sub: Arc<Sub>,
}

impl hyper::body::Body for SseBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(b)) => Poll::Ready(Some(Ok(hyper::body::Frame::data(b)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for SseBody {
    fn drop(&mut self) {
        self.server.close_sub(&self.sub);
    }
}

/// What a request comes to: a whole answer, or a stream already holding its first events.
pub enum Handled {
    Answer(Answer),
    Stream { sub: Arc<Sub>, rx: tokio::sync::mpsc::Receiver<Bytes>, rid: String },
}

/// One A2A call past the gate: what its audit entries and refusals name.
struct Call<'a> {
    api: &'a ConnectorApi,
    req: &'a Request<'a>,
    op: &'a Op,
    rid: &'a str,
    gate: &'a A2aGate,
    /// The agent id as a metric label (`none` when it is not one).
    label: &'a str,
}

// ── the server ──────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct State {
    metas: BTreeMap<String, Meta>,
    /// Spoke task id to A2A task id.
    by_spoke: HashMap<String, String>,
}

pub struct A2aServer {
    conn: Arc<Connector>,
    sync: Arc<SyncState>,
    audit: Arc<dyn AuditLog>,
    hub: Option<Arc<ServiceHub>>,
    sealed: Arc<SealedStore>,
    clock: Clock,
    st: Mutex<State>,
    changed: Condvar,
    /// Spoke task ids waiting for a sync.
    work: Mutex<VecDeque<String>>,
    work_cv: Condvar,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    streams: Mutex<Streams>,
    pusher: Arc<Pusher>,
    /// Asks the spoke announced (as sent), per spoke task, until the worker compared them (R6-6).
    asks: Mutex<HashMap<String, Vec<Value>>>,
    /// Held while the index is rewritten with a new record, so no new task is lost from it.
    index_lock: Mutex<()>,
    /// Admissions between the 7.4 A5 check and the new task's durable record.
    admission: Mutex<Admission>,
    /// Tests: writes made to fail (`content`, `index`, `state` for the state audit).
    #[cfg(test)]
    pub(crate) faults: Mutex<std::collections::HashSet<&'static str>>,
}

/// New tasks admitted but not yet recorded, per client and per agent (7.4 A5).
#[derive(Default)]
struct Admission {
    client: HashMap<String, usize>,
    agent: HashMap<String, usize>,
}

/// One admission; dropping it (the task recorded, or not made) releases it.
pub(crate) struct Admit<'a> {
    server: &'a A2aServer,
    client: String,
    agent: String,
}

impl Drop for Admit<'_> {
    fn drop(&mut self) {
        let mut a = self.server.admission.lock();
        if let Some(n) = a.client.get_mut(&self.client) {
            *n = n.saturating_sub(1);
        }
        if let Some(n) = a.agent.get_mut(&self.agent) {
            *n = n.saturating_sub(1);
        }
    }
}

/// The hub's hook: each change queues a sync of the task on the worker (hub ops never run on the inbox loop); an
/// announced ask is kept with it, so the worker compares its digest even when the hub's view has moved on.
struct Hook(Weak<A2aServer>);

impl HubEvents for Hook {
    fn task_changed(&self, t: &HubTask) {
        if let Some(s) = self.0.upgrade() {
            s.queue(&t.id);
        }
    }

    fn approval_asked(&self, t: &HubTask, ask: &Value) {
        if let Some(s) = self.0.upgrade() {
            if let Some(id) = s.st.lock().by_spoke.get(&t.id).cloned() {
                log_info(&format!("connector_a2a_ask task={id} kind={}", str_of(ask.get("kind")).unwrap_or("?")));
            }
            {
                let mut asks = s.asks.lock();
                if asks.len() >= ASKS_MAX && !asks.contains_key(&t.id) {
                    // fail closed: an ask dropped here is caught when its approval comes before it was compared
                    log_warn("connector_a2a_asks_full (queued asks dropped)");
                    asks.clear();
                }
                let list = asks.entry(t.id.clone()).or_default();
                if list.len() >= ASKS_PER_TASK {
                    list.remove(0);
                }
                list.push(ask.clone());
            }
            s.queue(&t.id);
        }
    }
}

/// The org's `a2a.agents[]` entry `id` in the pinned map.
fn agent_of(g: &Ground, id: &str) -> Option<Obj> {
    let m = g.store.get(&g.org, "")?;
    m.map().get("a2a")?.get("agents")?.as_array()?.iter().filter_map(Value::as_object).find(|a| str_of(a.get("id")) == Some(id)).cloned()
}

fn skill_of<'a>(agent: &'a Obj, id: &str) -> Option<&'a Obj> {
    agent.get("skills")?.as_array()?.iter().filter_map(Value::as_object).find(|s| str_of(s.get("id")) == Some(id))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn a2a_of(client: &Obj) -> Option<&Value> {
    client.get("a2a")
}

/// The client is in the pinned map, `active`, and no `client_suspend` holds it.
fn client_standing(g: &Ground, client: &str) -> bool {
    g.client(client).is_some_and(|c| str_of(c.get("state")) == Some("active")) && tok::client_entries(g.active(), "client_suspend", client).next().is_none()
}

impl A2aServer {
    /// The server over the connector (records reloaded from the sealed store) and its service hub, its hook set.
    pub fn new(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<dyn AuditLog>, hub: Option<Arc<ServiceHub>>, poster: Arc<dyn Poster>, clock: Clock) -> Arc<A2aServer> {
        let sealed = conn.shared.sealed.clone();
        let mut st = State::default();
        let ids = sealed.get(INDEX).ok().flatten().map(|v| strings(v.get("tasks"))).unwrap_or_default();
        for id in ids {
            match sealed.get(&meta_name(&id)) {
                Ok(Some(v)) => {
                    if let Some(m) = Meta::of(&v) {
                        if let Some(sp) = &m.spoke_task {
                            st.by_spoke.insert(sp.clone(), m.id.clone());
                        }
                        st.metas.insert(m.id.clone(), m);
                    }
                }
                Ok(None) => {}
                Err(e) => log_error(&format!("connector_a2a_record_unreadable task={id} error={e}")),
            }
        }
        let (org, outcome_audit, push_clock) = (sync.org().to_string(), audit.clone(), clock.clone());
        let outcomes = Arc::new(move |o: &Outcome| {
            let e = json!({"action": "a2a.push", "client": o.client, "task": o.task, "origin": o.origin, "result": o.result, "attempt": o.attempt, "status": o.status});
            if let Err(err) = outcome_audit.record(&org, e, push_clock().div_euclid(1000)) {
                log_error(&format!("api.audit-failed org={org} action=a2a.push why={}", err.message));
            }
            counters::a2a_push(&org, o.result);
        });
        let pusher = Arc::new(Pusher::new(poster, outcomes, clock.clone()));
        let server = Arc::new(A2aServer {
            conn,
            sync,
            audit,
            hub,
            sealed,
            clock,
            st: Mutex::new(st),
            changed: Condvar::new(),
            work: Mutex::new(VecDeque::new()),
            work_cv: Condvar::new(),
            locks: Mutex::new(HashMap::new()),
            streams: Mutex::new(Streams::default()),
            pusher,
            asks: Mutex::new(HashMap::new()),
            index_lock: Mutex::new(()),
            admission: Mutex::new(Admission::default()),
            #[cfg(test)]
            faults: Mutex::new(std::collections::HashSet::new()),
        });
        if let Some(h) = &server.hub {
            h.set_events(Arc::new(Hook(Arc::downgrade(&server))));
        }
        server
    }

    /// `connector serve`: the network poster, the worker and the push threads; the records reconciled first.
    pub fn start(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<dyn AuditLog>, hub: Option<Arc<ServiceHub>>) -> Result<Arc<A2aServer>, String> {
        let s = A2aServer::new(conn, sync, audit, hub, Arc::new(NetPoster), Arc::new(now_ms));
        let (w, p) = (s.clone(), s.pusher.clone());
        std::thread::Builder::new().name("connector-a2a".into()).spawn(move || w.run()).map_err(|e| format!("cannot start the A2A worker: {e}"))?;
        std::thread::Builder::new().name("connector-a2a-push".into()).spawn(move || p.run()).map_err(|e| format!("cannot start the A2A pushes: {e}"))?;
        log_info(&format!(
            "connector_a2a org={} hub={} key_store={} tasks={}",
            s.sync.org(),
            s.hub.as_ref().map_or("none", |h| h.node()),
            s.hub.as_ref().map_or("none", |h| h.key_store()),
            s.st.lock().metas.len()
        ));
        Ok(s)
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn org(&self) -> String {
        self.sync.org().to_string()
    }

    /// The org's label (the pinned policy's), for Lucid's sentences.
    fn org_label(&self) -> String {
        self.conn.trust().own_pin().and_then(|p| p.policy.get("label").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| self.org())
    }

    fn lock_of(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().entry(id.to_string()).or_default().clone()
    }

    fn meta(&self, id: &str) -> Option<Meta> {
        self.st.lock().metas.get(id).cloned()
    }

    /// Tests: a write named in `faults` fails.
    #[cfg(test)]
    fn fault(&self, what: &str) -> Result<(), String> {
        if self.faults.lock().contains(what) {
            return Err(format!("the {what} write failed (test)"));
        }
        Ok(())
    }

    #[cfg(not(test))]
    fn fault(&self, _what: &str) -> Result<(), String> {
        Ok(())
    }

    /// The index of every record, plus `with` (a record about to be taken), sealed; call under `index_lock`.
    fn save_index(&self, with: Option<&str>) -> Result<(), String> {
        self.fault("index")?;
        let mut ids: Vec<String> = self.st.lock().metas.keys().cloned().collect();
        if let Some(id) = with.filter(|id| !ids.iter().any(|x| x == id)) {
            ids.push(id.to_string());
        }
        self.sealed.put(INDEX, &json!({"v": 1, "tasks": ids}))
    }

    /// The record sealed (fsynced) and, for a new task, the index with it; only then is the record taken. Err leaves
    /// nothing taken (a new record whose index could not be written is deleted again).
    fn put_meta(&self, m: Meta) -> Result<(), String> {
        let fresh = !self.st.lock().metas.contains_key(&m.id);
        let _index = fresh.then(|| self.index_lock.lock());
        self.sealed.put(&meta_name(&m.id), &m.to_json())?;
        if fresh {
            if let Err(e) = self.save_index(Some(&m.id)) {
                if let Err(d) = self.sealed.delete(&meta_name(&m.id)) {
                    log_error(&format!("connector_a2a_record_not_deleted task={} error={d}", m.id));
                }
                return Err(format!("the task index could not be written: {e}"));
            }
        }
        {
            let mut st = self.st.lock();
            if let Some(sp) = &m.spoke_task {
                st.by_spoke.insert(sp.clone(), m.id.clone());
            }
            st.metas.insert(m.id.clone(), m);
        }
        self.changed.notify_all();
        Ok(())
    }

    fn content(&self, id: &str) -> Content {
        match self.sealed.get(&content_name(id)) {
            Ok(Some(v)) => Content {
                history: v.get("history").and_then(Value::as_array).cloned().unwrap_or_default(),
                artifacts: v.get("artifacts").and_then(Value::as_array).cloned().unwrap_or_default(),
            },
            Ok(None) => Content::default(),
            Err(e) => {
                log_error(&format!("connector_a2a_content_unreadable task={id} error={e}"));
                Content::default()
            }
        }
    }

    fn put_content(&self, id: &str, c: &Content) -> Result<(), String> {
        self.fault("content")?;
        self.sealed.put(&content_name(id), &json!({"history": c.history, "artifacts": c.artifacts}))
    }

    fn forget(&self, id: &str) {
        let gone = {
            let mut st = self.st.lock();
            let m = st.metas.remove(id);
            if let Some(sp) = m.as_ref().and_then(|m| m.spoke_task.clone()) {
                st.by_spoke.remove(&sp);
            }
            m.is_some()
        };
        for name in [meta_name(id), content_name(id)] {
            if let Err(e) = self.sealed.delete(&name) {
                log_warn(&format!("connector_a2a_record_not_deleted task={id} error={e}"));
            }
        }
        self.pusher.drop_task(id);
        self.locks.lock().remove(id);
        if gone {
            // a stale index entry only names a record that no longer reads; the next write drops it
            let _index = self.index_lock.lock();
            if let Err(e) = self.save_index(None) {
                log_warn(&format!("connector_a2a_index_unsaved error={e}"));
            }
        }
    }

    // ── audit and telemetry (11, 12) ────────────────────────────────────────────────────────────────────────

    /// `a2a.task` for a state change into `state` (no route; the worker or an op's side effect). Err: not recorded,
    /// so the change is not announced (it stays pending and is tried again).
    fn audit_state(&self, m: &Meta, state: TaskState) -> Result<(), String> {
        self.fault("state")?;
        let mut e = json!({"action": "a2a.task", "result": "ok", "client": m.client, "agent": m.agent, "skill": m.skill, "task": m.id, "state": state.label()});
        if let Some(s) = &m.spoke {
            e["spoke"] = json!(s);
        }
        self.audit.record(&self.org(), e, self.now().div_euclid(1000)).map(|_| ()).map_err(|err| {
            log_error(&format!("api.audit-failed org={} action=a2a.task why={}", self.org(), err.message));
            err.message
        })
    }

    fn set_open_gauge(&self, agent: &str) {
        let n = self.st.lock().metas.values().filter(|m| m.agent == agent && !m.state.terminal()).count();
        counters::set_a2a_tasks_open(&self.org(), agent, n as u64);
    }

    fn set_streams_gauge(&self) {
        let n = self.streams.lock().total;
        counters::set_a2a_streams_open(&self.org(), n as u64);
    }

    // ── announcing a change ─────────────────────────────────────────────────────────────────────────────────

    /// A task's new state (and new artifacts) out, once sealed and audited: counted, streamed, pushed.
    fn announce(&self, m: &Meta, new_artifacts: &[Value], state_changed: bool) {
        if state_changed {
            counters::a2a_task_state(&self.org(), &m.agent, m.state.label());
            self.set_open_gauge(&m.agent);
        }
        for a in new_artifacts {
            self.emit(&m.id, &w::artifact_update(&m.id, &m.context, a), false);
        }
        if state_changed {
            let label = self.org_label();
            let sentence = m.why.map(|x| x.sentence(&label));
            let status = w::status_json(m.state, sentence.as_deref(), &m.id, &m.context, m.status_ms);
            let update = w::status_update(&m.id, &m.context, &status);
            self.emit(&m.id, &update, m.state.terminal() || m.state == TaskState::InputRequired);
            self.push_all(m, &update);
        }
        self.changed.notify_all();
    }

    /// 7.10: the status update to every push config of the task the journal still allows.
    fn push_all(&self, m: &Meta, update: &Value) {
        if m.push.is_empty() {
            return;
        }
        let g = Ground::of(&self.conn, &self.sync, self.now());
        let Some(client) = g.client(&m.client) else { return };
        if cj::push_off(&g.console, &m.client) {
            return;
        }
        // the pinned private CIDRs a `push_private_off` (whole, or narrowed to `keep`) still leaves reachable
        let pinned = strings(a2a_of(client).and_then(|a| a.get("push")).and_then(|p| p.get("private_cidrs")));
        let within: Vec<crate::console_source::Cidr> = cj::push_private_within(&g.console, &m.client, &pinned).iter().filter_map(|c| crate::console_source::parse_cidr(c).ok()).collect();
        for p in m.push.iter().filter(|p| !cj::push_origin_dropped(&g.console, &m.client, &p.origin)) {
            let target = Target {
                task: m.id.clone(),
                config: p.id.clone(),
                client: m.client.clone(),
                url: p.url.clone(),
                origin: p.origin.clone(),
                token: p.token.clone(),
                credentials: p.credentials.clone(),
                within: within.clone(),
            };
            self.pusher.enqueue(target, update.clone());
        }
    }

    /// An event to every stream of the task; `closes` ends them after it.
    fn emit(&self, task: &str, event: &Value, closes: bool) {
        let subs: Vec<Arc<Sub>> = self.streams.lock().by_task.get(task).cloned().unwrap_or_default();
        let text = w::sse(event);
        for s in subs {
            if !s.send(text.clone()) || closes {
                self.close_sub(&s);
            }
        }
    }

    /// A stream closed (once): its sender dropped (the body ends) and its slot freed.
    fn close_sub(&self, sub: &Sub) {
        if sub.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        sub.tx.lock().take();
        {
            let mut s = self.streams.lock();
            if let Some(list) = s.by_task.get_mut(&sub.task) {
                list.retain(|x| x.id != sub.id);
                if list.is_empty() {
                    s.by_task.remove(&sub.task);
                }
            }
            if let Some(n) = s.per_client.get_mut(&sub.client) {
                *n = n.saturating_sub(1);
            }
            s.total = s.total.saturating_sub(1);
        }
        self.set_streams_gauge();
    }

    /// 7.9: a stream slot for the client (4 each, 512 in all), or 429 `streams`.
    fn reserve_stream(&self, client: &str) -> Result<(), Fault> {
        let mut s = self.streams.lock();
        if s.total >= w::STREAMS_MAX || s.per_client.get(client).copied().unwrap_or(0) >= w::STREAMS_PER_CLIENT {
            return Err(Fault::lucid(429, "streams", "This client has too many open streams; close one or poll.").retry(60));
        }
        s.total += 1;
        *s.per_client.entry(client.to_string()).or_default() += 1;
        Ok(())
    }

    fn release_stream(&self, client: &str) {
        let mut s = self.streams.lock();
        if let Some(n) = s.per_client.get_mut(client) {
            *n = n.saturating_sub(1);
        }
        s.total = s.total.saturating_sub(1);
    }

    /// A reserved slot made into a stream on `task`, its first events queued.
    fn open_sub(&self, gate: &A2aGate, agent: &str, task: &str, first: &[Value], close_now: bool, class_rank: usize) -> (Arc<Sub>, tokio::sync::mpsc::Receiver<Bytes>) {
        let (tx, rx) = tokio::sync::mpsc::channel(STREAM_QUEUE);
        let sub = {
            let mut s = self.streams.lock();
            s.next += 1;
            let sub = Arc::new(Sub {
                id: s.next,
                client: gate.client().to_string(),
                agent: agent.to_string(),
                task: task.to_string(),
                exp_s: gate.exp(),
                class_rank,
                opened: Instant::now(),
                tx: Mutex::new(Some(tx)),
                closed: AtomicBool::new(false),
            });
            s.by_task.entry(task.to_string()).or_default().push(sub.clone());
            sub
        };
        self.set_streams_gauge();
        for e in first {
            sub.send(w::sse(e));
        }
        if close_now {
            self.close_sub(&sub);
        }
        (sub, rx)
    }

    /// 7.9: a stream may stay open: its token in date, under an hour, the client and agent still standing, the
    /// client's ceiling (lowered by the journal) still at or above the task's class, the connector fresh.
    pub fn stream_ok(&self, sub: &Sub) -> bool {
        let now = self.now();
        if sub.closed.load(Ordering::SeqCst) || now.div_euclid(1000) >= sub.exp_s || sub.opened.elapsed() >= w::STREAM_MAX || !self.sync.fresh(now) {
            return false;
        }
        let g = Ground::of(&self.conn, &self.sync, now);
        let ceiling = g.client(&sub.client).map(|c| crate::connector_view::client_ceiling(&g, &sub.client, c)).and_then(tok::rank).unwrap_or(0);
        client_standing(&g, &sub.client) && sub.class_rank <= ceiling && !cj::agent_off(&g.console, &sub.agent) && !cj::client_agent_dropped(&g.console, &sub.client, &sub.agent)
    }

    /// The rank of a task's class (`usize::MAX` when it cannot be known while a spoke holds the task).
    fn class_rank(&self, m: &Meta) -> usize {
        let class = m.class.clone().or_else(|| m.spoke.as_deref().and_then(|s| self.hub.as_ref()?.spoke_class(s)).map(str::to_string));
        match class {
            Some(c) => tok::rank(&c).unwrap_or(usize::MAX),
            None if m.spoke.is_none() => 0,
            None => usize::MAX,
        }
    }

    /// The keepalive of one stream: a comment line every 15 s; closes it when it may not stay open.
    pub async fn keepalive(self: Arc<Self>, sub: Arc<Sub>) {
        loop {
            tokio::time::sleep(w::KEEPALIVE).await;
            if sub.closed.load(Ordering::SeqCst) {
                return;
            }
            if !self.stream_ok(&sub) || !sub.send(":\n\n".into()) {
                self.close_sub(&sub);
                return;
            }
        }
    }

    // ── the worker ──────────────────────────────────────────────────────────────────────────────────────────

    fn queue(&self, spoke_task: &str) {
        let mut q = self.work.lock();
        if !q.iter().any(|x| x == spoke_task) {
            q.push_back(spoke_task.to_string());
        }
        drop(q);
        self.work_cv.notify_all();
    }

    /// Every queued sync, on the calling thread (the worker, or a test).
    pub fn drain(&self) -> usize {
        let mut n = 0;
        loop {
            let next = self.work.lock().pop_front();
            let Some(sp) = next else { return n };
            let id = self.st.lock().by_spoke.get(&sp).cloned();
            if let Some(id) = id {
                self.sync_task(&id);
            }
            n += 1;
        }
    }

    fn run(&self) {
        self.reconcile();
        let mut last = Instant::now() - TICK;
        loop {
            self.drain();
            if last.elapsed() >= TICK {
                last = Instant::now();
                self.tick();
            }
            let mut q = self.work.lock();
            if q.is_empty() {
                self.work_cv.wait_for(&mut q, TICK);
            }
        }
    }

    /// After a restart: the hub's open tasks this server has no record of are canceled (a submit cut off before its
    /// record was sealed), each spoke lists its own tasks again (`hello`; a task it no longer has fails), the pending
    /// asks' ends are read (`approvals`), and every open task is synced.
    pub fn reconcile(&self) {
        let Some(hub) = self.hub.clone() else { return };
        let known: HashMap<String, String> = self.st.lock().by_spoke.clone();
        for t in hub.tasks().into_iter().filter(|t| t.open() && !known.contains_key(&t.id)) {
            log_warn(&format!("connector_a2a_orphan_canceled spoke_task={} spoke={}", t.id, t.spoke));
            if let Err(e) = hub.cancel(&t.id) {
                log_warn(&format!("connector_a2a_orphan_cancel_failed spoke_task={} error={e}", t.id));
            }
        }
        let open: Vec<Meta> = self.st.lock().metas.values().filter(|m| !m.state.terminal() && m.spoke_task.is_some()).cloned().collect();
        let mut spokes: BTreeMap<String, Vec<Meta>> = BTreeMap::new();
        for m in open {
            spokes.entry(m.spoke.clone().unwrap_or_default()).or_default().push(m);
        }
        for (spoke, metas) in spokes {
            let listed: Option<Vec<String>> = match hub.hello(&spoke) {
                Ok(v) => Some(v.get("tasks").and_then(Value::as_array).into_iter().flatten().filter_map(|t| str_of(t.get("id")).map(str::to_string)).collect()),
                Err(e) => {
                    log_warn(&format!("connector_a2a_hello_failed spoke={spoke} error={e}"));
                    None
                }
            };
            for m in metas {
                let sp = m.spoke_task.clone().unwrap_or_default();
                if listed.as_ref().is_some_and(|l| !l.contains(&sp)) {
                    self.finish(&m.id, TaskState::Failed, Some(Why::Failed));
                    continue;
                }
                if m.state == TaskState::AuthRequired {
                    if let Ok(asks) = hub.approvals(&sp) {
                        let end = asks.iter().filter_map(|a| a.get("expiresAt").and_then(Value::as_i64)).max();
                        if let Some(mut fresh) = self.meta(&m.id).filter(|x| x.ask_expires != end) {
                            fresh.ask_expires = end;
                            if let Err(e) = self.put_meta(fresh) {
                                log_error(&format!("connector_a2a_record_unsaved task={} error={e}", m.id));
                            }
                        }
                    }
                }
                let _ = hub.status(&sp);
                self.queue(&sp);
            }
        }
    }

    /// The periodic housekeeping (7.6, 7.8, 7.9, 7.10).
    pub fn tick(&self) {
        let now = self.now();
        let g = Ground::of(&self.conn, &self.sync, now);
        let metas: Vec<Meta> = self.st.lock().metas.values().cloned().collect();
        let stale_long = self.sync.last_sync_ms() > 0 && now - self.sync.last_sync_ms() > w::MAILBOX_TTL_MS;
        let mut ended_by_agent: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        let pending = |id: &str, r: Result<(), String>| {
            if let Err(e) = r {
                log_warn(&format!("connector_a2a_state_pending task={id} error={e}"));
            }
        };
        for m in &metas {
            // 9.4: a change whose audit failed is audited again before it is announced
            if m.pending.is_some() {
                self.retry_pending(&m.id);
            }
            if m.state.terminal() {
                let ended = m.ended_ms.unwrap_or(m.status_ms);
                if now - ended > w::ENDED_KEPT_MS {
                    self.forget(&m.id);
                    continue;
                }
                ended_by_agent.entry(m.agent.clone()).or_default().push((ended, m.id.clone()));
                // credentials and tokens go 24 hours after the end (7.10)
                if !m.push.is_empty() && now - ended > w::PUSH_KEEP_MS {
                    self.edit(&m.id, |x| x.push.clear());
                    self.pusher.drop_task(&m.id);
                }
                // an end that did not reach the spoke is sent again
                if let (Some(hub), Some(sp)) = (&self.hub, &m.spoke_task) {
                    end_spoke_task(hub, sp);
                }
                continue;
            }
            // the journal and the client's standing (7.6): canceled
            if cj::agent_off(&g.console, &m.agent) || cj::client_agent_dropped(&g.console, &m.client, &m.agent) || !client_standing(&g, &m.client) {
                pending(&m.id, self.cancel_task(&m.id, TaskState::Canceled, None));
                continue;
            }
            if stale_long {
                pending(&m.id, self.cancel_task(&m.id, TaskState::Failed, Some(Why::Expired)));
                continue;
            }
            // push configs the journal dropped (7.10)
            let dropped: Vec<String> = m.push.iter().filter(|p| cj::push_off(&g.console, &m.client) || cj::push_origin_dropped(&g.console, &m.client, &p.origin)).map(|p| p.id.clone()).collect();
            if !dropped.is_empty() {
                self.edit(&m.id, |x| x.push.retain(|p| !dropped.contains(&p.id)));
                for c in &dropped {
                    self.pusher.drop_config(&m.id, c);
                }
            }
            if m.state == TaskState::Working && now - m.recall_ms >= w::RECALL_EVERY_MS {
                self.sync_task(&m.id);
            }
            if m.state == TaskState::InputRequired && m.many && m.idle_ms.is_some_and(|at| now - at >= m.idle_close_s * 1000) {
                pending(&m.id, self.cancel_task(&m.id, TaskState::Completed, Some(Why::IdleClosed((m.idle_close_s / 60).max(1)))));
            }
        }
        for (_, mut list) in ended_by_agent {
            if list.len() > w::ENDED_PER_AGENT {
                list.sort();
                for (_, id) in list.iter().take(list.len() - w::ENDED_PER_AGENT) {
                    self.forget(id);
                }
            }
        }
        let subs: Vec<Arc<Sub>> = self.streams.lock().by_task.values().flatten().cloned().collect();
        for s in subs {
            if !self.stream_ok(&s) {
                self.close_sub(&s);
            }
        }
    }

    /// A small change to a record (no state change).
    fn edit(&self, id: &str, f: impl FnOnce(&mut Meta)) {
        let l = self.lock_of(id);
        let _g = l.lock();
        if let Some(mut m) = self.meta(id) {
            f(&mut m);
            if let Err(e) = self.put_meta(m) {
                log_error(&format!("connector_a2a_record_unsaved task={id} error={e}"));
            }
        }
    }

    /// A task to a state the connector decided (terminal ones end the spoke task: `deny` while a start or turn is
    /// held, `cancel` while it works, then `close`). Err: the state stays pending (the tick audits it again).
    fn cancel_task(&self, id: &str, state: TaskState, why: Option<Why>) -> Result<(), String> {
        let l = self.lock_of(id);
        let _g = l.lock();
        let Some(m) = self.meta(id).filter(|m| !m.state.terminal()) else { return Ok(()) };
        if let (Some(hub), Some(sp)) = (&self.hub, &m.spoke_task) {
            end_spoke_task(hub, sp);
        }
        self.set(m, state, why, &[])
    }

    /// A terminal state with no spoke op (the spoke no longer has the task).
    fn finish(&self, id: &str, state: TaskState, why: Option<Why>) {
        let l = self.lock_of(id);
        let _g = l.lock();
        if let Some(m) = self.meta(id).filter(|m| !m.state.terminal()) {
            if let Err(e) = self.set(m, state, why, &[]) {
                log_error(&format!("connector_a2a_state_pending task={id} error={e}"));
            }
        }
    }

    /// The record moved to `state`; call under the task's lock. A change is sealed as pending, its `a2a.task` entry
    /// appended, and only then applied, sealed and announced (11, 9.4). Err leaves the change pending and nothing
    /// announced; `retry_pending` tries it again.
    fn set(&self, mut m: Meta, state: TaskState, why: Option<Why>, new_artifacts: &[Value]) -> Result<(), String> {
        if m.state == state && m.why == why {
            m.pending = None;
            self.put_meta(m.clone())?;
            self.announce(&m, new_artifacts, false);
            return Ok(());
        }
        m.pending = Some((state, why));
        self.put_meta(m.clone())?;
        self.audit_state(&m, state)?;
        self.apply(m, new_artifacts)
    }

    /// An audited pending change applied: sealed, then announced.
    fn apply(&self, mut m: Meta, new_artifacts: &[Value]) -> Result<(), String> {
        let Some((state, why)) = m.pending.take() else { return Ok(()) };
        let now = self.now();
        m.state = state;
        m.why = why;
        m.status_ms = now;
        m.idle_ms = (state == TaskState::InputRequired).then_some(now);
        if state.terminal() {
            m.ended_ms = Some(now);
            m.ask_expires = None;
        }
        self.put_meta(m.clone())?;
        self.announce(&m, new_artifacts, true);
        Ok(())
    }

    /// A pending change whose audit failed: audited again and, once in, applied and announced.
    fn retry_pending(&self, id: &str) {
        let l = self.lock_of(id);
        let _g = l.lock();
        let Some(m) = self.meta(id) else { return };
        let Some((state, _)) = m.pending else { return };
        if let Err(e) = self.audit_state(&m, state).and_then(|()| self.apply(m, &[])) {
            log_warn(&format!("connector_a2a_state_pending task={id} error={e}"));
        }
    }

    /// 7.6, 7.8: the spoke's view of the task taken (its journal read, its state mapped); call off the hub's loop.
    pub fn sync_task(&self, id: &str) {
        let Some(hub) = self.hub.clone() else { return };
        let l = self.lock_of(id);
        let _g = l.lock();
        let Some(mut m) = self.meta(id).filter(|m| !m.state.terminal()) else { return };
        let Some(sp) = m.spoke_task.clone() else { return };
        let Some(ht) = hub.task(&sp) else { return };
        let now = self.now();
        let org = self.org();
        // R6-6: every held ask the spoke announced (queued from the hook, and the one the hub's view still holds) is
        // compared with the digest of what this connector sent before anything else is read
        let mut asks: Vec<(String, String, String)> = self
            .asks
            .lock()
            .remove(&sp)
            .unwrap_or_default()
            .iter()
            .filter_map(|a| Some((str_of(a.get("id"))?.to_string(), str_of(a.get("kind"))?.to_string(), str_of(a.get("digest")).unwrap_or_default().to_string())))
            .collect();
        // the hub's view holds an empty digest until the spoke's announcement came (that announcement is queued above)
        if let Some(a) = ht.ask.as_ref().filter(|a| !a.digest.is_empty()) {
            asks.push((a.id.clone(), a.kind.clone(), a.digest.clone()));
        }
        for (ask, kind, digest) in asks {
            if !matches!(kind.as_str(), "task.start" | "task.turn") || m.verified_ask.as_deref() == Some(ask.as_str()) {
                continue;
            }
            let fits = m.expect_kind.as_deref() == Some(kind.as_str()) && m.expect.as_deref().is_some_and(|want| !digest.is_empty() && digest == want);
            if !fits {
                log_error(&format!("connector_a2a_ask_digest_mismatch org={org} task={id} spoke={} ask={ask} kind={kind}", ht.spoke));
                self.refuse_ask(&hub, &sp, &ask, m);
                return;
            }
            m.verified_ask = Some(ask);
            m.expect = None;
            m.expect_kind = None;
        }
        // a follow-up the spoke now holds is no longer pending
        if m.pending_turn.is_some() && ht.state != "idle" {
            m.pending_turn = None;
        }
        let mut content: Option<Content> = None;
        let mut fresh_artifacts: Vec<Value> = Vec::new();
        for _ in 0..RECALL_PAGES {
            let page = match hub.recall(&sp, m.seen_seq) {
                Ok(p) => p,
                Err(e) => {
                    log_warn(&format!("connector_a2a_recall_failed task={id} error={e}"));
                    break;
                }
            };
            for e in &page.entries {
                m.seen_seq = m.seen_seq.max(e.seq);
                let kind = str_of(e.data.get("kind"));
                match e.kind.as_str() {
                    "approval.decided" if matches!(kind, Some("task.start" | "task.turn")) => {
                        let allow = e.data.get("allow") == Some(&Value::Bool(true));
                        let expired = str_of(e.data.get("reason")) == Some("approval expired");
                        let result = if allow { "allowed" } else if expired { "expired" } else { "denied" };
                        self.audit_approval(&m, kind.unwrap_or_default(), result, str_of(e.data.get("by")).filter(|_| !expired));
                        // R6-6: an instruction approved before its ask was compared with what this connector sent
                        if allow && m.expect.is_some() && m.expect_kind.as_deref() == kind {
                            log_error(&format!("connector_a2a_ask_unverified org={org} task={id} spoke={}", ht.spoke));
                            let ask = str_of(e.data.get("ask")).unwrap_or_default().to_string();
                            self.refuse_ask(&hub, &sp, &ask, m);
                            return;
                        }
                        if kind == Some("task.turn") && !allow {
                            m.refused = Some(if expired { TurnRefused::Expired } else { TurnRefused::Declined });
                        }
                        if allow {
                            m.refused = None;
                        }
                        // a refused instruction will never be asked again: nothing is expected for it any more
                        if !allow && m.expect_kind.as_deref() == kind {
                            m.expect = None;
                            m.expect_kind = None;
                        }
                    }
                    "task.turn-expired" => {
                        self.audit_approval(&m, "task.turn", "expired", None);
                        m.refused = Some(TurnRefused::Expired);
                        if m.expect_kind.as_deref() == Some("task.turn") {
                            m.expect = None;
                            m.expect_kind = None;
                        }
                    }
                    "task.turn" => {
                        let n = e.data.get("index").and_then(Value::as_i64).map_or(m.turns + 1, |i| i + 1);
                        let text = str_of(e.data.get("text")).unwrap_or_default();
                        fresh_artifacts.push(w::turn_artifact(n, text));
                        m.turns = m.turns.max(n);
                        m.refused = None;
                    }
                    "task.handoff" => {
                        if let (Some(b), Some(c)) = (str_of(e.data.get("branch")), str_of(e.data.get("commit"))) {
                            fresh_artifacts.push(w::handoff_artifact(b, c));
                        }
                    }
                    "task.closed" => m.closed_reason = str_of(e.data.get("reason")).map(str::to_string),
                    _ => {}
                }
            }
            if !page.more || page.entries.is_empty() || m.seen_seq >= page.head {
                break;
            }
        }
        m.recall_ms = now;
        if !fresh_artifacts.is_empty() {
            let c = content.get_or_insert_with(|| self.content(id));
            for a in &fresh_artifacts {
                let aid = str_of(a.get("artifactId")).unwrap_or_default().to_string();
                c.artifacts.retain(|x| str_of(x.get("artifactId")) != Some(aid.as_str()));
                c.artifacts.push(a.clone());
            }
            // 7.8: at most 64 artifacts and 1 MiB; the oldest turns go first
            let size = |c: &Content| c.artifacts.iter().map(|a| a.to_string().len()).sum::<usize>();
            while c.artifacts.len() > w::ARTIFACTS_MAX || size(&*c) > w::ARTIFACT_BYTES_MAX {
                let Some(i) = c.artifacts.iter().position(|a| str_of(a.get("artifactId")).is_some_and(|x| x.starts_with("turn-"))) else { break };
                c.artifacts.remove(i);
                m.truncated = true;
            }
            m.artifacts = c.artifacts.len();
            m.artifact_bytes = size(&*c);
            if let Err(e) = self.put_content(id, &*c) {
                log_error(&format!("connector_a2a_content_unsaved task={id} error={e}"));
                return;
            }
        }
        if ht.state == "awaiting_approval" {
            m.ask_expires = ht.ask.as_ref().map(|a| a.expires_at).filter(|e| *e > 0).or(m.ask_expires);
        }
        let view = w::SpokeView { state: &ht.state, awaiting: ht.awaiting.as_deref(), reason: m.closed_reason.as_deref().or(ht.reason.as_deref()), turns: m.turns };
        let (state, why, close) = w::lifecycle(&view, m.many, m.refused);
        if close {
            if let Err(e) = hub.close(&sp) {
                log_warn(&format!("connector_a2a_close_failed task={id} error={e} (sent again by the tick)"));
            }
        }
        if let Err(e) = self.set(m, state, why, &fresh_artifacts) {
            log_warn(&format!("connector_a2a_state_pending task={id} error={e}"));
        }
    }

    /// R6-6: a held ask that does not carry the digest of what this connector sent (or carries none, or was
    /// approved before it could be compared) is denied, the spoke task ended, and the task fails.
    fn refuse_ask(&self, hub: &ServiceHub, sp: &str, ask: &str, m: Meta) {
        if !ask.is_empty() {
            if let Err(e) = hub.deny(sp, ask) {
                log_warn(&format!("connector_a2a_deny_failed task={} error={e}", m.id));
            }
        }
        end_spoke_task(hub, sp);
        let id = m.id.clone();
        if let Err(e) = self.set(m, TaskState::Failed, Some(Why::Failed), &[]) {
            log_warn(&format!("connector_a2a_state_pending task={id} error={e}"));
        }
    }

    fn audit_approval(&self, m: &Meta, kind: &str, result: &str, approver: Option<&str>) {
        let mut e = json!({"action": "a2a.approval", "task": m.id, "kind": kind, "result": result, "client": m.client, "agent": m.agent});
        if let Some(a) = approver {
            e["approver"] = json!(a);
        }
        if let Err(err) = self.audit.record(&self.org(), e, self.now().div_euclid(1000)) {
            log_error(&format!("api.audit-failed org={} action=a2a.approval why={}", self.org(), err.message));
        }
        if kind == "task.start" {
            counters::a2a_approval(&self.org(), result);
        }
    }

    // ── the task as A2A shows it ────────────────────────────────────────────────────────────────────────────

    fn task_json(&self, m: &Meta, history: Option<usize>, artifacts: bool) -> Value {
        let label = self.org_label();
        let sentence = m.why.map(|x| x.sentence(&label));
        let mut t = json!({"id": m.id, "contextId": m.context, "status": w::status_json(m.state, sentence.as_deref(), &m.id, &m.context, m.status_ms)});
        let need_content = artifacts || history != Some(0);
        let c = if need_content { self.content(&m.id) } else { Content::default() };
        if artifacts {
            t["artifacts"] = json!(c.artifacts);
        }
        if history != Some(0) {
            t["history"] = json!(w::last_of(&c.history, history));
        }
        let asking = (m.state == TaskState::AuthRequired).then_some(m.ask_expires).flatten();
        if let Some(md) = w::task_metadata(m.truncated, asking) {
            t["metadata"] = md;
        }
        t
    }

    // ── requests (7.3) ──────────────────────────────────────────────────────────────────────────────────────

    fn answer_json(status: u16, v: &Value, rid: &str) -> Answer {
        Answer {
            status,
            headers: vec![
                ("Content-Type".into(), w::CONTENT_TYPE.into()),
                ("Cache-Control".into(), "no-store".into()),
                ("X-Lucid-Request-Id".into(), rid.into()),
            ],
            body: serde_json::to_vec(v).unwrap_or_default(),
        }
    }

    fn fault_answer(f: &Fault, rid: &str, extra: Vec<(String, String)>) -> Answer {
        let mut a = A2aServer::answer_json(f.status, &f.body(rid), rid);
        if let Some(s) = f.retry {
            a.headers.push(("Retry-After".into(), s.to_string()));
        }
        a.headers.extend(extra);
        a
    }

    /// A 1a problem answer of the pipeline (already audited) in the A2A shape, its `WWW-Authenticate` and
    /// `Retry-After` kept.
    fn of_problem(a: Answer, rid: &str) -> Answer {
        let v: Value = serde_json::from_slice(&a.body).unwrap_or(Value::Null);
        let code = str_of(v.get("code")).unwrap_or("refused").to_string();
        let why = str_of(v.get("error")).unwrap_or("The request was refused.").to_string();
        let f = Fault::lucid(a.status, &code, why);
        let extra = a.headers.into_iter().filter(|(k, _)| k.eq_ignore_ascii_case("www-authenticate") || k.eq_ignore_ascii_case("retry-after")).collect();
        A2aServer::fault_answer(&f, rid, extra)
    }

    /// A refusal after the gate (or before it): `api.refusal` first, then the A2A error.
    fn refuse(&self, api: &ConnectorApi, req: &Request, op: &Op, rid: &str, gate: Option<&A2aGate>, agent: &str, f: Fault) -> Answer {
        counters::a2a_request(&self.org(), agent, "refused");
        match api.a2a_refused(req, op.pattern(), rid, gate, f.status, &f.check()) {
            Ok(()) => A2aServer::fault_answer(&f, rid, Vec::new()),
            Err(a) => A2aServer::of_problem(a, rid),
        }
    }

    /// 9.4 and D15: the `a2a.task` entry of an allowed call, appended before its answer leaves (a read, with
    /// `bytes_out`) or before its side effect (a write: send, follow-up, cancel, push config changes). Err is 503
    /// `audit-unavailable`, and the caller does nothing.
    fn audit_call(&self, c: &Call, m: Option<&Meta>, status: u16, bytes_out: Option<usize>) -> Result<(), Fault> {
        let mut e = Map::new();
        e.insert("rid".into(), json!(c.rid));
        e.insert("action".into(), json!("a2a.task"));
        e.insert("route".into(), json!(c.api.a2a_route(c.req.method, c.op.pattern())));
        e.insert("op".into(), json!(c.op.name()));
        e.insert("ip".into(), json!(crate::console_source::canonical(c.req.source).to_string()));
        e.insert("scope".into(), json!(w::SCOPE));
        e.insert("resource".into(), json!(self.sync.connector_id()));
        e.insert("result".into(), json!("ok"));
        e.insert("status".into(), json!(status));
        e.insert("client".into(), json!(c.gate.client()));
        e.insert("jti".into(), json!(c.gate.jti()));
        e.insert("agent".into(), json!(c.label));
        e.insert("bytes_in".into(), json!(c.req.body.and_then(|b| b.ok()).map_or(0, <[u8]>::len)));
        if let Some(n) = bytes_out {
            e.insert("bytes_out".into(), json!(n));
        }
        if let Some(m) = m {
            e.insert("task".into(), json!(m.id));
            e.insert("skill".into(), json!(m.skill));
            e.insert("state".into(), json!(m.state.label()));
            if let Some(s) = &m.spoke {
                e.insert("spoke".into(), json!(s));
            }
        }
        if !self.audit.allowed_ok() || self.audit.record(&self.org(), Value::Object(e), c.req.now_ms.div_euclid(1000)).is_err() {
            return Err(Fault::lucid(503, "audit-unavailable", "The audit log cannot record this request now; try again later.").retry(30));
        }
        Ok(())
    }

    /// A read's answer after its `a2a.task` entry (`audit_call`); 503 `audit-unavailable` otherwise.
    fn called(&self, c: &Call, m: Option<&Meta>, a: Answer) -> Result<Handled, Fault> {
        self.audit_call(c, m, a.status, Some(a.body.len()))?;
        counters::a2a_request(&self.org(), c.label, "ok");
        Ok(Handled::Answer(a))
    }

    /// A write's answer, its `a2a.task` entry already in.
    fn done(&self, c: &Call, a: Answer) -> Result<Handled, Fault> {
        counters::a2a_request(&self.org(), c.label, "ok");
        Ok(Handled::Answer(a))
    }

    /// One request at A (blocking: hub ops, audit fsyncs, `returnImmediately: false` waits).
    pub fn handle(self: &Arc<Self>, api: &ConnectorApi, req: &Request, version: Option<&str>) -> Handled {
        let rid = res::rid();
        let org = self.org();
        let Some((path_org, agent, op)) = w::parse_path(req.method, req.path) else {
            if w::a2a_org(req.path) == Some(org.as_str()) {
                return Handled::Answer(A2aServer::of_problem(api.a2a_unknown(req.method, req.source, &rid, req.now_ms.div_euclid(1000)), &rid));
            }
            return Handled::Answer(A2aServer::fault_answer(&Fault::lucid(404, "not-found", "Nothing is here."), &rid, Vec::new()));
        };
        if path_org != org {
            return Handled::Answer(A2aServer::fault_answer(&Fault::lucid(404, "not-found", "Nothing is here."), &rid, Vec::new()));
        }
        let label = if agent.len() <= 32 && agent.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') { agent.clone() } else { "none".to_string() };
        // 7.2.1: an enclave connector serves no A2A
        if self.conn.cfg.enclave.on {
            let f = Fault::lucid(503, "enclave", "This connector runs in an enclave and serves no A2A agent.").retry(3600);
            return Handled::Answer(self.refuse(api, req, &op, &rid, None, "none", f));
        }
        let gate = match api.a2a_gate(req, op.pattern(), &rid) {
            Ok(g) => g,
            Err(a) => {
                counters::a2a_request(&org, "none", "refused");
                return Handled::Answer(A2aServer::of_problem(a, &rid));
            }
        };
        let call = Call { api, req, op: &op, rid: &rid, gate: &gate, label: &label };
        match self.checked(&call, &agent, version) {
            Ok(h) => h,
            Err(f) => Handled::Answer(self.refuse(api, req, &op, &rid, Some(&gate), &label, f)),
        }
    }

    /// 7.4 A6 for a task the path names or a list holds: its spoke's class at or below `ceiling` (a lowered
    /// ceiling hides higher-class tasks; a task whose spoke's class is unknown is hidden, one with no spoke shown).
    fn within(&self, m: &Meta, ceiling: &str) -> bool {
        self.class_rank(m) <= tok::rank(ceiling).unwrap_or(0)
    }

    /// 7.4 A1 to A3 (with A6 for a named task) then the operation.
    fn checked(self: &Arc<Self>, c: &Call, agent_id: &str, version: Option<&str>) -> Result<Handled, Fault> {
        let (req, op, rid, gate) = (c.req, c.op, c.rid, c.gate);
        // A1
        if version.map(str::trim) != Some(w::VERSION) {
            return Err(Fault::a2a(400, "VERSION_NOT_SUPPORTED", "This agent speaks A2A 1.0; send A2A-Version: 1.0."));
        }
        let hub = match &self.hub {
            Some(h) if h.stopped().is_none() => h.clone(),
            _ => return Err(Fault::lucid(503, "unavailable", UNAVAILABLE).retry(60)),
        };
        // A2
        let g = Ground::of(&self.conn, &self.sync, req.now_ms);
        let agent = agent_of(&g, agent_id)
            .filter(|a| str_of(a.get("connector")) == Some(g.connector_id.as_str()) && str_of(a.get("hub")) == Some(hub.client()))
            .filter(|_| !cj::agent_off(&g.console, agent_id))
            .filter(|_| a2a_of(gate.entry()).is_some_and(|x| strings(x.get("agents")).iter().any(|a| a == agent_id)))
            .filter(|_| !cj::client_agent_dropped(&g.console, gate.client(), agent_id))
            .ok_or_else(Fault::not_found)?;
        // A3, and A6 for the task it names: another client's task, or one above the effective ceiling, is not found
        let task = match op.task() {
            Some(t) => Some(self.meta(t).filter(|m| m.client == gate.client() && m.agent == agent_id && self.within(m, gate.ceiling())).ok_or_else(Fault::not_found)?),
            None => None,
        };
        match op {
            Op::Send | Op::Stream => self.send(c, &g, &agent, agent_id, &hub),
            Op::Get(_) => {
                let m = task.ok_or_else(Fault::not_found)?;
                let history = w::history_param(req.query)?;
                let a = A2aServer::answer_json(200, &self.task_json(&m, history, true), rid);
                self.called(c, Some(&m), a)
            }
            Op::List => {
                let a = A2aServer::answer_json(200, &self.list(req.query, gate.client(), agent_id, gate.ceiling())?, rid);
                self.called(c, None, a)
            }
            Op::Cancel(_) => {
                let m = task.ok_or_else(Fault::not_found)?;
                if m.state.terminal() {
                    return Err(Fault::a2a(400, "TASK_NOT_CANCELABLE", "The task has already ended."));
                }
                self.audit_call(c, Some(&m), 200, None)?;
                self.cancel_task(&m.id, TaskState::Canceled, None).map_err(|_| Fault::lucid(503, "unavailable", UNAVAILABLE).retry(30))?;
                let m = self.meta(&m.id).unwrap_or(m);
                self.done(c, A2aServer::answer_json(200, &self.task_json(&m, None, true), rid))
            }
            Op::Subscribe(_) => {
                let m = task.ok_or_else(Fault::not_found)?;
                if m.state.terminal() {
                    return Err(Fault::unsupported("The task has ended; read it with GetTask."));
                }
                if agent.get("streaming") != Some(&Value::Bool(true)) {
                    return Err(Fault::unsupported("This agent does not stream."));
                }
                self.reserve_stream(gate.client())?;
                let first = json!({"task": self.task_json(&m, None, true)});
                let a = A2aServer::answer_json(200, &first, rid);
                if let Err(f) = self.called(c, Some(&m), a) {
                    self.release_stream(gate.client());
                    return Err(f);
                }
                let closes = m.state == TaskState::InputRequired;
                let (sub, rx) = self.open_sub(gate, agent_id, &m.id, &[first], closes, self.class_rank(&m));
                Ok(Handled::Stream { sub, rx, rid: rid.to_string() })
            }
            Op::PushCreate(_) => {
                let m = task.ok_or_else(Fault::not_found)?;
                let body = body_value(req)?;
                let cfg = self.push_config(&g, gate, &agent, &m, &body)?;
                let view = w::push_view(&cfg.id, &m.id, &cfg.url, cfg.token.as_deref(), cfg.credentials.is_some());
                let l = self.lock_of(&m.id);
                let _lk = l.lock();
                let mut fresh = self.meta(&m.id).unwrap_or(m);
                if fresh.push.len() >= w::PUSH_CONFIGS_MAX {
                    return Err(Fault::invalid("A task has at most 2 push configs."));
                }
                // D15: the call is in the chain before the config exists
                self.audit_call(c, Some(&fresh), 200, None)?;
                fresh.push.push(cfg);
                self.put_meta(fresh).map_err(|_| Fault::lucid(503, "unavailable", UNAVAILABLE).retry(30))?;
                self.done(c, A2aServer::answer_json(200, &view, rid))
            }
            Op::PushGet(_, cfg) => {
                let m = task.ok_or_else(Fault::not_found)?;
                let p = m.push.iter().find(|p| &p.id == cfg).ok_or_else(|| Fault::lucid(404, "not-found", "That push config does not exist."))?;
                let a = A2aServer::answer_json(200, &w::push_view(&p.id, &m.id, &p.url, p.token.as_deref(), p.credentials.is_some()), rid);
                self.called(c, Some(&m), a)
            }
            Op::PushList(_) => {
                let m = task.ok_or_else(Fault::not_found)?;
                let configs: Vec<Value> = m.push.iter().map(|p| w::push_view(&p.id, &m.id, &p.url, p.token.as_deref(), p.credentials.is_some())).collect();
                let a = A2aServer::answer_json(200, &json!({"configs": configs, "nextPageToken": ""}), rid);
                self.called(c, Some(&m), a)
            }
            Op::PushDelete(_, cfg) => {
                let m = task.ok_or_else(Fault::not_found)?;
                self.audit_call(c, Some(&m), 200, None)?;
                if m.push.iter().any(|p| &p.id == cfg) {
                    let l = self.lock_of(&m.id);
                    let _lk = l.lock();
                    if let Some(mut fresh) = self.meta(&m.id) {
                        fresh.push.retain(|p| &p.id != cfg);
                        self.put_meta(fresh).map_err(|_| Fault::lucid(503, "unavailable", UNAVAILABLE).retry(30))?;
                    }
                    self.pusher.drop_config(&m.id, cfg);
                }
                self.done(c, A2aServer::answer_json(200, &json!({}), rid))
            }
            Op::ExtendedCard => Err(Fault::unsupported("This agent has no extended card.")),
        }
    }

    /// 7.10: a push config of the task, when the agent and client allow pushes and the URL is under one of the
    /// client's origins (and no `push_drop_origin` dropped it).
    fn push_config(&self, g: &Ground, gate: &A2aGate, agent: &Obj, m: &Meta, body: &Value) -> Result<PushConfig, Fault> {
        let push = a2a_of(gate.entry()).and_then(|a| a.get("push"));
        if agent.get("push") != Some(&Value::Bool(true)) || push.is_none() || cj::push_off(&g.console, gate.client()) {
            return Err(Fault::a2a(400, "PUSH_NOTIFICATION_NOT_SUPPORTED", "Push notifications are not enabled for this client and agent."));
        }
        let ask = w::push_ask(body)?;
        let origins = strings(push.and_then(|p| p.get("origins")));
        let allowed = origins.iter().any(|o| w::origin_of(o).as_deref() == Some(ask.origin.as_str())) && !cj::push_origin_dropped(&g.console, gate.client(), &ask.origin);
        if !allowed {
            return Err(Fault::lucid(400, "push-origin", "url must be under one of this client's push origins."));
        }
        if m.state.terminal() {
            return Err(Fault::unsupported("The task has ended."));
        }
        let id = w::new_id("p_").ok_or_else(|| Fault::lucid(503, "unavailable", UNAVAILABLE))?;
        Ok(PushConfig { id, url: ask.url, origin: ask.origin, token: ask.token, credentials: ask.credentials })
    }

    /// `GET tasks` (7.3, A2A 3.1.4): the client's tasks of the agent within its effective ceiling (A6), newest status
    /// first.
    fn list(&self, query: &str, client: &str, agent: &str, ceiling: &str) -> Result<Value, Fault> {
        let context = w::query_param(query, "contextId");
        let status = match w::query_param(query, "status") {
            None => None,
            Some(s) if s.is_empty() => None,
            Some(s) => Some(TaskState::of(&s).ok_or_else(|| Fault::invalid("status must be a TaskState."))?),
        };
        let page = match w::query_param(query, "pageSize") {
            None => w::PAGE_DEFAULT,
            Some(s) => s.parse::<usize>().ok().filter(|n| (1..=w::PAGE_MAX).contains(n)).ok_or_else(|| Fault::invalid("pageSize must be 1 to 100."))?,
        };
        let after_ts = match w::query_param(query, "statusTimestampAfter") {
            None => None,
            Some(s) => Some(w::parse_iso(&s).ok_or_else(|| Fault::invalid("statusTimestampAfter must be an ISO 8601 time."))?),
        };
        let token = match w::query_param(query, "pageToken").filter(|t| !t.is_empty()) {
            None => None,
            Some(t) => Some(w::page_after(&t).ok_or_else(|| Fault::invalid("pageToken is not a token of this list."))?),
        };
        let artifacts = match w::query_param(query, "includeArtifacts").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => return Err(Fault::invalid("includeArtifacts must be true or false.")),
        };
        let history = w::history_param(query)?;
        let mut all: Vec<Meta> = self
            .st
            .lock()
            .metas
            .values()
            .filter(|m| m.client == client && m.agent == agent)
            .filter(|m| context.as_ref().is_none_or(|c| &m.context == c))
            .filter(|m| status.is_none_or(|s| m.state == s))
            .filter(|m| after_ts.is_none_or(|t| m.status_ms >= t))
            .cloned()
            .collect();
        all.retain(|m| self.within(m, ceiling));
        all.sort_by(|a, b| b.status_ms.cmp(&a.status_ms).then_with(|| b.id.cmp(&a.id)));
        let total = all.len();
        let start = match &token {
            None => 0,
            Some((ms, id)) => all.iter().position(|m| (m.status_ms, &m.id) < (*ms, id)).unwrap_or(all.len()),
        };
        let slice: Vec<&Meta> = all.iter().skip(start).take(page).collect();
        let next = if start + slice.len() < all.len() { slice.last().map(|m| w::page_token(m.status_ms, &m.id)).unwrap_or_default() } else { String::new() };
        let tasks: Vec<Value> = slice
            .iter()
            .map(|m| {
                let mut t = self.task_json(m, history, artifacts);
                if !artifacts {
                    if let Some(o) = t.as_object_mut() {
                        o.remove("artifacts");
                    }
                }
                t
            })
            .collect();
        Ok(json!({"tasks": tasks, "nextPageToken": next, "pageSize": page, "totalSize": total}))
    }

    /// `message:send` and `message:stream` (7.5). A new task or a follow-up appends its call entry before anything is
    /// sent to the spoke (D15); a repeated `messageId` is a read and is audited as one.
    fn send(self: &Arc<Self>, c: &Call, g: &Ground, agent: &Obj, agent_id: &str, hub: &Arc<ServiceHub>) -> Result<Handled, Fault> {
        let (req, op, rid, gate) = (c.req, c.op, c.rid, c.gate);
        let streaming = *op == Op::Stream;
        if streaming && agent.get("streaming") != Some(&Value::Bool(true)) {
            return Err(Fault::unsupported("This agent does not stream; use message:send."));
        }
        let raw = match req.body {
            None => return Err(Fault::invalid("The body must be a SendMessageRequest.")),
            Some(Err("too-large")) => return Err(Fault::lucid(413, "too-large", "The request body is over 64 KiB.")),
            Some(Err(_)) => return Err(Fault::invalid("The request body could not be read.")),
            Some(Ok(b)) => b,
        };
        let intake = w::intake(raw)?;
        let now = req.now_ms;
        // 7.5: a repeated messageId answers the task it made or continued (24 hours)
        let repeat = self
            .st
            .lock()
            .metas
            .values()
            .find(|m| m.client == gate.client() && m.agent == agent_id && m.messages.iter().any(|(id, at)| *id == intake.message_id && now - at < w::MESSAGE_ID_MS))
            .cloned();
        // A6: a repeat naming a task above the effective ceiling is not found (never made again)
        if repeat.as_ref().is_some_and(|m| !self.within(m, gate.ceiling())) {
            return Err(Fault::not_found());
        }
        if streaming {
            self.reserve_stream(gate.client())?;
        }
        let audited = repeat.is_none();
        let made = match repeat {
            Some(m) => Ok(m),
            None => match intake.task_id.clone() {
                Some(t) => self.follow_up(c, g, agent, agent_id, &t, &intake, hub, now),
                None => self.new_task(c, g, agent, agent_id, &intake, hub, now),
            },
        };
        let m = match made {
            Ok(m) => m,
            Err(f) => {
                if streaming {
                    self.release_stream(gate.client());
                }
                return Err(f);
            }
        };
        if !streaming && !intake.return_immediately {
            self.wait_settled(&m.id, Instant::now() + w::WAIT_MAX);
        }
        let m = self.meta(&m.id).unwrap_or(m);
        let task = self.task_json(&m, intake.history_length, true);
        let body = json!({"task": task});
        let answer = A2aServer::answer_json(200, &body, rid);
        let answered = if audited { self.done(c, answer) } else { self.called(c, Some(&m), answer) };
        if !streaming {
            return answered;
        }
        if let Err(f) = answered {
            self.release_stream(gate.client());
            return Err(f);
        }
        let closes = m.state.terminal() || m.state == TaskState::InputRequired;
        let (sub, rx) = self.open_sub(gate, agent_id, &m.id, &[body], closes, self.class_rank(&m));
        Ok(Handled::Stream { sub, rx, rid: rid.to_string() })
    }

    /// 7.4 A5 with a reservation: the client's and agent's open tasks plus those admitted but not yet recorded stay
    /// under their limits; the reservation lasts until the new task's record is durable (or the task is not made).
    pub(crate) fn admit(&self, client: &str, agent: &str, limit: usize) -> Result<Admit<'_>, Fault> {
        let mut a = self.admission.lock();
        let (open_client, open_agent) = {
            let st = self.st.lock();
            (st.metas.values().filter(|m| m.client == client && !m.state.terminal()).count(), st.metas.values().filter(|m| m.agent == agent && !m.state.terminal()).count())
        };
        let (rc, ra) = (a.client.get(client).copied().unwrap_or(0), a.agent.get(agent).copied().unwrap_or(0));
        if open_client + rc >= limit || open_agent + ra >= w::OPEN_PER_AGENT {
            return Err(Fault::lucid(429, "tasks", "This client has as many open tasks as it may; wait for one to end.").retry(60));
        }
        *a.client.entry(client.to_string()).or_default() += 1;
        *a.agent.entry(agent.to_string()).or_default() += 1;
        Ok(Admit { server: self, client: client.to_string(), agent: agent.to_string() })
    }

    /// `returnImmediately: false` (7.5, decision 19.13): until terminal or interrupted, at most 300 s.
    fn wait_settled(&self, id: &str, until: Instant) {
        let mut st = self.st.lock();
        loop {
            let settled = st.metas.get(id).is_none_or(|m| m.state.terminal() || m.state.interrupted());
            let left = until.saturating_duration_since(Instant::now());
            if settled || left.is_zero() {
                return;
            }
            self.changed.wait_for(&mut st, left.min(Duration::from_secs(5)));
        }
    }

    fn partner(gate: &A2aGate, agent: &Obj, agent_id: &str, skill: &str) -> Partner {
        Partner {
            client_name: str_of(gate.entry().get("name")).unwrap_or(gate.name()).to_string(),
            client_id: gate.client().to_string(),
            owner: str_of(gate.entry().get("owner")).unwrap_or_default().to_string(),
            agent_name: str_of(agent.get("name")).unwrap_or_default().to_string(),
            agent_id: agent_id.to_string(),
            skill: skill.to_string(),
        }
    }

    /// A new task (7.4 A4 to A6, 7.5, 7.6): held on the first present target within the ceiling. Its call is audited
    /// before the submit; its history and record are durable before it is announced or indexed, else the spoke task
    /// is ended and the answer is 503.
    #[allow(clippy::too_many_arguments)]
    fn new_task(self: &Arc<Self>, c: &Call, g: &Ground, agent: &Obj, agent_id: &str, intake: &Intake, hub: &Arc<ServiceHub>, now: i64) -> Result<Meta, Fault> {
        let gate = c.gate;
        let client = gate.client();
        // A2A 3.4.1: a contextId must be one this connector made for this client
        let context = match &intake.context_id {
            Some(c) => {
                let ours = self.st.lock().metas.values().any(|m| m.client == client && &m.context == c);
                if !ours {
                    return Err(Fault::invalid("contextId is not one this agent made for this client."));
                }
                c.clone()
            }
            None => w::new_id("x_").ok_or_else(|| Fault::lucid(503, "unavailable", UNAVAILABLE))?,
        };
        // the skill: named, or the agent's only one
        let skills: Vec<&Obj> = agent.get("skills").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect();
        let skill_id = match &intake.skill {
            Some(s) => s.clone(),
            None if skills.len() == 1 => str_of(skills[0].get("id")).unwrap_or_default().to_string(),
            None => return Err(Fault::invalid(format!("Name the skill in metadata[\"{}\"] {{\"skill\": <id>}}.", w::EXT))),
        };
        // A4
        let granted = strings(a2a_of(gate.entry()).and_then(|a| a.get("skills")));
        let pair = format!("{agent_id}/{skill_id}");
        let skill = skill_of(agent, &skill_id)
            .filter(|_| !cj::agent_skill_dropped(&g.console, agent_id, &skill_id))
            .filter(|_| granted.iter().any(|s| s == "*" || *s == pair) && !cj::client_skill_dropped(&g.console, client, &pair))
            .ok_or_else(|| Fault::lucid(403, "skill", "This client may not use that skill."))?;
        // A5, reserved until the record is durable
        let pinned = a2a_of(gate.entry()).and_then(|a| a.get("max_open_tasks")).and_then(Value::as_i64).unwrap_or(1);
        let limit = cj::client_a2a_limit(&g.console, client).map_or(pinned, |l| l.min(pinned)).max(0) as usize;
        let _admitted = self.admit(client, agent_id, limit)?;
        // A6: only targets whose class is within the effective ceiling
        let ceiling = tok::rank(gate.ceiling()).unwrap_or(0);
        let targets = strings(skill.get("targets"));
        let within: Vec<String> = targets.iter().filter(|t| hub.spoke_class(t).is_none_or(|c| tok::rank(c).unwrap_or(usize::MAX) <= ceiling)).cloned().collect();
        if !targets.is_empty() && within.is_empty() {
            return Err(Fault::lucid(403, "ceiling", "This skill's spokes are above this client's ceiling."));
        }
        // 7.10: a push config asked with the message
        let push = match &intake.push {
            Some(p) => {
                let draft = Meta { state: TaskState::Submitted, ..self.blank(agent_id, client, &skill_id, &context, now) };
                Some(self.push_config(g, gate, agent, &draft, p)?)
            }
            None => None,
        };
        // 7.5, R6-6: the connector's header inside the signed input; the task name is the skill id
        let name = task_name(&skill_id).ok_or_else(|| Fault::lucid(403, "skill", "This skill id cannot name a spoke task."))?;
        let text = held_text(&A2aServer::partner(gate, agent, agent_id, &skill_id), &intake.text).map_err(|e| Fault::invalid(e))?;
        let within_s = skill.get("approve_within_s").and_then(Value::as_i64).unwrap_or(3600);
        let model = str_of(skill.get("model")).map(str::to_string);
        let id = w::new_id("t2_").ok_or_else(|| Fault::lucid(503, "unavailable", UNAVAILABLE))?;
        let mut m = Meta { id: id.clone(), ..self.blank(agent_id, client, &skill_id, &context, now) };
        m.many = str_of(skill.get("turns")) == Some("many");
        m.idle_close_s = skill.get("idle_close_s").and_then(Value::as_i64).unwrap_or(3600);
        m.messages.push((intake.message_id.clone(), now));
        m.push.extend(push);
        // D15: the call is in the chain before anything reaches a spoke
        self.audit_call(c, Some(&m), 200, None)?;
        let submitted = hub.submit(&Submit { targets: within, name: name.clone(), text: text.clone(), within_s, model });
        let (state, why) = match submitted {
            Ok(ht) => {
                m.spoke_task = Some(ht.id.clone());
                m.spoke = Some(ht.spoke.clone());
                // the class of the spoke that took it (unknown: the highest, so a lower ceiling never sees it)
                m.class = Some(hub.spoke_class(&ht.spoke).unwrap_or("cui").to_string());
                m.expect = Some(ask_digest("task.start", &name, &text));
                m.expect_kind = Some("task.start".to_string());
                (TaskState::AuthRequired, Some(Why::StartWait))
            }
            Err(SubmitError::Rejected(r)) => (
                TaskState::Rejected,
                Some(match r {
                    Rejected::Paused => Why::Paused,
                    Rejected::CannotRun => Why::CannotRun,
                    Rejected::NoSpoke => Why::NoSpoke,
                }),
            ),
            Err(SubmitError::Hub(HubError::Invalid(why))) => return Err(Fault::invalid(why)),
            Err(SubmitError::Hub(e)) => {
                log_warn(&format!("connector_a2a_submit_unavailable agent={agent_id} error={e}"));
                return Err(Fault::lucid(503, "unavailable", SPOKE_DOWN).retry(60));
            }
        };
        let content = Content { history: vec![w::user_message(&intake.message_id, &id, &context, &intake.text)], artifacts: Vec::new() };
        let l = self.lock_of(&id);
        let _lk = l.lock();
        let spoke_task = m.spoke_task.clone();
        // the history, then the record (indexed) and its audited state: any of them failing ends the spoke task
        let recorded = self.put_content(&id, &content).and_then(|()| self.set(m, state, why, &[]));
        if let Err(e) = recorded {
            log_error(&format!("connector_a2a_task_unrecorded task={id} error={e}"));
            if let Some(sp) = &spoke_task {
                end_spoke_task(hub, sp);
            }
            // nothing of it stays: no record, history or index entry, so nothing is ever announced
            self.forget(&id);
            return Err(Fault::lucid(503, "unavailable", UNAVAILABLE).retry(30));
        }
        if let Some(sp) = spoke_task {
            self.queue(&sp);
        }
        self.meta(&id).ok_or_else(|| Fault::lucid(503, "unavailable", UNAVAILABLE))
    }

    fn blank(&self, agent: &str, client: &str, skill: &str, context: &str, now: i64) -> Meta {
        Meta {
            id: String::new(),
            agent: agent.to_string(),
            client: client.to_string(),
            skill: skill.to_string(),
            context: context.to_string(),
            spoke_task: None,
            spoke: None,
            state: TaskState::Submitted,
            why: None,
            status_ms: now,
            created_ms: now,
            many: false,
            idle_close_s: 0,
            seen_seq: 0,
            turns: 0,
            refused: None,
            closed_reason: None,
            ask_expires: None,
            expect: None,
            expect_kind: None,
            verified_ask: None,
            class: None,
            pending: None,
            pending_turn: None,
            artifacts: 0,
            artifact_bytes: 0,
            truncated: false,
            messages: Vec::new(),
            push: Vec::new(),
            ended_ms: None,
            idle_ms: None,
            recall_ms: now,
        }
    }

    /// A message to an existing task (7.5, R6-3): only while it is `INPUT_REQUIRED`; it becomes a held `task.turn`.
    /// Its call is audited first; the turn (history, `messageId`, expected digest) is sealed before it is sent and
    /// rolled back when the spoke does not take it; if the record cannot be moved on afterwards, the held ask is denied
    /// and the spoke task closed.
    #[allow(clippy::too_many_arguments)]
    fn follow_up(&self, c: &Call, g: &Ground, agent: &Obj, agent_id: &str, task: &str, intake: &Intake, hub: &Arc<ServiceHub>, now: i64) -> Result<Meta, Fault> {
        let gate = c.gate;
        let l = self.lock_of(task);
        let _lk = l.lock();
        let m = self.meta(task).filter(|m| m.client == gate.client() && m.agent == agent_id && self.within(m, gate.ceiling())).ok_or_else(Fault::not_found)?;
        if intake.context_id.as_ref().is_some_and(|c| *c != m.context) {
            return Err(Fault::invalid("contextId is not this task's."));
        }
        if m.state.terminal() {
            return Err(Fault::unsupported("The task has ended; start a new one."));
        }
        if m.state != TaskState::InputRequired {
            return Err(Fault::lucid(409, "task-busy", "The task is working or waiting for a person; send your message when it asks for input."));
        }
        // the skill may have been dropped since (A4 again for each instruction)
        let pair = format!("{agent_id}/{}", m.skill);
        if cj::agent_skill_dropped(&g.console, agent_id, &m.skill) || cj::client_skill_dropped(&g.console, gate.client(), &pair) {
            return Err(Fault::lucid(403, "skill", "This client may no longer use that skill."));
        }
        let push = match &intake.push {
            Some(p) => {
                if m.push.len() >= w::PUSH_CONFIGS_MAX {
                    return Err(Fault::invalid("A task has at most 2 push configs."));
                }
                Some(self.push_config(g, gate, agent, &m, p)?)
            }
            None => None,
        };
        let sp = m.spoke_task.clone().ok_or_else(|| Fault::unsupported("The task has no spoke task."))?;
        let name = task_name(&m.skill).unwrap_or_default();
        let text = held_text(&A2aServer::partner(gate, agent, agent_id, &m.skill), &intake.text).map_err(|e| Fault::invalid(e))?;
        // D15: the call is in the chain before anything changes or is sent
        self.audit_call(c, Some(&m), 200, None)?;
        // the turn sealed before it is sent: its digest, its messageId, its history line, the push config
        let unavailable = || Fault::lucid(503, "unavailable", UNAVAILABLE).retry(30);
        let before = self.content(task);
        let mut turn = m.clone();
        turn.expect = Some(ask_digest("task.turn", &name, &text));
        turn.expect_kind = Some("task.turn".to_string());
        turn.refused = None;
        turn.pending_turn = Some(intake.message_id.clone());
        turn.messages.retain(|(_, at)| now - at < w::MESSAGE_ID_MS);
        turn.messages.push((intake.message_id.clone(), now));
        turn.push.extend(push);
        let mut with = before.clone();
        with.history.push(w::user_message(&intake.message_id, task, &m.context, &intake.text));
        if with.history.len() > w::HISTORY_KEPT {
            let cut = with.history.len() - w::HISTORY_KEPT;
            with.history.drain(..cut);
        }
        self.put_meta(turn.clone()).map_err(|_| unavailable())?;
        if self.put_content(task, &with).is_err() {
            self.restore(&m, &before);
            return Err(unavailable());
        }
        let refused = match hub.followup(&sp, &text) {
            Ok(_) => None,
            Err(HubError::Busy) => Some(Fault::lucid(409, "task-busy", "The task is working or waiting for a person; send your message when it asks for input.")),
            Err(HubError::NotOwn) => Some(Fault::not_found()),
            Err(HubError::Invalid(why)) => Some(Fault::invalid(why)),
            Err(HubError::Refused(why)) if why == crate::connector_spokes::WAIT => Some(Fault::lucid(409, "task-busy", "The task is busy on the spoke; try again when it asks for input.")),
            Err(HubError::Timeout) => {
                // the request still waits in the relay: the turn stays sealed (its digest is checked if it arrives)
                log_warn(&format!("connector_a2a_followup_timeout task={task}"));
                self.queue(&sp);
                return Err(Fault::lucid(503, "unavailable", SPOKE_DOWN).retry(30));
            }
            Err(e) => {
                log_warn(&format!("connector_a2a_followup_failed task={task} error={e}"));
                Some(Fault::lucid(503, "unavailable", SPOKE_DOWN).retry(30))
            }
        };
        if let Some(f) = refused {
            // the spoke did not take it: the turn is undone
            self.restore(&m, &before);
            return Err(f);
        }
        turn.pending_turn = None;
        if let Err(e) = self.set(turn, TaskState::AuthRequired, Some(Why::TurnWait), &[]) {
            // the spoke holds a turn this connector cannot record: it is denied and the task closed
            log_error(&format!("connector_a2a_turn_unrecorded task={task} error={e}"));
            end_spoke_task(hub, &sp);
            return Err(unavailable());
        }
        self.queue(&sp);
        self.meta(task).ok_or_else(unavailable)
    }

    /// A turn the spoke did not take, undone: the record and history as they were before it (each tried on its own,
    /// so a history that cannot be written still frees the `messageId` and the expected digest).
    fn restore(&self, m: &Meta, content: &Content) {
        for r in [self.put_content(&m.id, content), self.put_meta(m.clone())] {
            if let Err(e) = r {
                log_error(&format!("connector_a2a_turn_not_undone task={} error={e}", m.id));
            }
        }
    }

    /// Streams open now (tests).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn streams_open(&self) -> usize {
        self.streams.lock().total
    }

    /// The push queues (tests drive their attempts).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pusher(&self) -> &Arc<Pusher> {
        &self.pusher
    }

    /// The spoke task behind an A2A task (tests; never shown to partners).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn spoke_task_of(&self, id: &str) -> Option<String> {
        self.meta(id).and_then(|m| m.spoke_task)
    }
}

/// End a spoke task the connector gives up on: a held ask denied (unsigned refusals are always safe), a working task
/// canceled, then closed. Failures are logged; the tick closes it again.
fn end_spoke_task(hub: &ServiceHub, sp: &str) {
    let Some(t) = hub.task(sp).filter(HubTask::open) else { return };
    let result = match (t.awaiting.as_deref(), t.ask.as_ref()) {
        (Some("task.start"), _) => hub.cancel(sp).map(|_| ()),
        (Some("task.turn"), Some(ask)) => hub.deny(sp, &ask.id).and_then(|_| hub.close(sp)).map(|_| ()),
        _ if t.state == "working" || t.state == "awaiting_approval" => hub.cancel(sp).and_then(|_| hub.close(sp)).map(|_| ()),
        _ => hub.close(sp).map(|_| ()),
    };
    if let Err(e) = result {
        log_warn(&format!("connector_a2a_end_failed spoke_task={sp} error={e}"));
    }
}

/// A JSON body of a POST.
fn body_value(req: &Request) -> Result<Value, Fault> {
    match req.body {
        Some(Ok(b)) => serde_json::from_slice(b).map_err(|_| Fault::invalid("The body must be JSON.")),
        Some(Err("too-large")) => Err(Fault::lucid(413, "too-large", "The request body is over 64 KiB.")),
        _ => Err(Fault::invalid("The body could not be read.")),
    }
}

// ── the listener glue ───────────────────────────────────────────────────────────────────────────────────────

/// A body of at most 64 KiB (7.12): Err `too-large` past it, `request` when it could not be read in 30 s.
async fn read_body(req: hyper::Request<Incoming>) -> Result<Vec<u8>, &'static str> {
    match tokio::time::timeout(Duration::from_secs(30), Limited::new(req.into_body(), w::BODY_MAX).collect()).await {
        Ok(Ok(c)) => Ok(c.to_bytes().to_vec()),
        Ok(Err(e)) if e.is::<http_body_util::LengthLimitError>() => Err("too-large"),
        _ => Err("request"),
    }
}

fn response_of(a: Answer) -> Response<Body> {
    let mut b = Response::builder().status(a.status);
    for (k, v) in &a.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    b.body(Either::Left(Full::new(Bytes::from(a.body)))).unwrap_or_else(|_| Response::new(Either::Left(Full::new(Bytes::new()))))
}

/// One request under A from the connector's listener: read (64 KiB), answered on a blocking thread, a stream
/// handed to hyper with its keepalive.
pub async fn handle(server: Arc<A2aServer>, api: Arc<ConnectorApi>, ip: IpAddr, req: hyper::Request<Incoming>) -> Response<Body> {
    let method = req.method().as_str().to_owned();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let header = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (authorization, dpop) = (header("authorization"), header("dpop"));
    let version = header("a2a-version").or_else(|| w::query_param(&query, "A2A-Version"));
    let body = if matches!(method.as_str(), "GET" | "HEAD" | "DELETE") { None } else { Some(read_body(req).await) };
    let s = server.clone();
    let handled = tokio::task::spawn_blocking(move || {
        let request = Request {
            method: &method,
            path: &path,
            query: &query,
            authorization: authorization.as_deref(),
            dpop: dpop.as_deref(),
            idempotency_key: None,
            body: body.as_ref().map(|b| b.as_deref().map_err(|e| *e)),
            source: ip,
            now_ms: now_ms(),
        };
        s.handle(&api, &request, version.as_deref())
    })
    .await;
    match handled {
        Ok(Handled::Answer(a)) => response_of(a),
        Ok(Handled::Stream { sub, rx, rid }) => {
            tokio::spawn(server.clone().keepalive(sub.clone()));
            let body = SseBody { rx, server, sub };
            Response::builder()
                .status(200)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-store")
                .header("X-Lucid-Request-Id", rid)
                .body(Either::Right(body))
                .unwrap_or_else(|_| Response::new(Either::Left(Full::new(Bytes::new()))))
        }
        Err(_) => {
            let rid = res::rid();
            response_of(A2aServer::fault_answer(&Fault::lucid(503, "unavailable", "The request failed; try again."), &rid, Vec::new()))
        }
    }
}
