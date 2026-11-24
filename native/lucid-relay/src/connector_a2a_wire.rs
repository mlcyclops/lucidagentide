// Contract API-1 revision 6 (phase 1d), 7.3 to 7.12 (slice 1d4): the A2A 1.0 HTTP+JSON shapes the connector's A2A
// server reads and writes, with no state of its own.
//
//   paths        `A/<agent id>/...` of 7.3 (`A` = `<connector origin>/api/orgs/<org>/a2a`), each to an `Op`; the
//                `/{tenant}/...` bindings of the proto are not served.
//   intake       7.5: a `SendMessageRequest` with text parts only (`raw`, `url`, `data` refused), the Lucid extension's
//                `{"skill"}`, the configuration (`acceptedOutputModes`, `taskPushNotificationConfig`, `historyLength`,
//                `returnImmediately`).
//   lifecycle    7.6: a spoke task's state (`spoke.ts` TaskState) to an A2A `TaskState` and Lucid's own status sentence,
//                never the spoke's words (R6-13).
//   artifacts    7.8: `turn-<n>` (text/markdown) and `handoff` (application/json).
//   errors       7.11: the A2A HTTP+JSON error (`google.rpc.Status` with an `ErrorInfo`), domain `a2a-protocol.org` for
//                A2A errors (A2A 5.4 statuses) and `lucid.emertins.com` for Lucid refusals.
//   push         7.10: a `TaskPushNotificationConfig` checked (https URL, Bearer credentials, token).

use crate::codec::{b64u, iso_time, str_of, utf16_len};
use serde_json::{json, Map, Value};
use std::time::Duration;

/// 7.4 A1: the only `A2A-Version` served (decision 19.10).
pub const VERSION: &str = "1.0";
/// The Lucid extension (7.1.1): the message metadata key that selects the skill, and the task metadata key.
pub const EXT: &str = "https://lucid.emertins.com/a2a/ext/spokes-task/v1";
/// Section 9: the one scope of every A2A route.
pub const SCOPE: &str = "spokes.tasks.submit";
/// 7.11: every A2A answer except SSE.
pub const CONTENT_TYPE: &str = "application/a2a+json";
pub const A2A_DOMAIN: &str = "a2a-protocol.org";
pub const LUCID_DOMAIN: &str = "lucid.emertins.com";
/// 7.12 limits.
pub const BODY_MAX: usize = 64 * 1024;
pub const PARTS_MAX: usize = 16;
pub const MESSAGE_ID_MAX: usize = 128;
/// 7.5: a `messageId` is unique per client for 24 hours.
pub const MESSAGE_ID_MS: i64 = 86_400_000;
pub const PAGE_DEFAULT: usize = 50;
pub const PAGE_MAX: usize = 100;
pub const OPEN_PER_AGENT: usize = 256;
pub const STREAMS_PER_CLIENT: usize = 4;
pub const STREAMS_MAX: usize = 512;
pub const PUSH_CONFIGS_MAX: usize = 2;
pub const ARTIFACTS_MAX: usize = 64;
pub const ARTIFACT_BYTES_MAX: usize = 1 << 20;
pub const HISTORY_KEPT: usize = 20;
/// 7.6: terminal task records are kept 14 days, at most 1000 per agent.
pub const ENDED_KEPT_MS: i64 = 14 * 86_400_000;
pub const ENDED_PER_AGENT: usize = 1000;
/// 7.5 and decision 19.13: `returnImmediately: false` waits at most this long.
pub const WAIT_MAX: Duration = Duration::from_secs(300);
/// 7.9: a stream closes after an hour; a comment line every 15 s.
pub const STREAM_MAX: Duration = Duration::from_secs(3600);
pub const KEEPALIVE: Duration = Duration::from_secs(15);
/// 7.8: results are read every 10 s while a task works.
pub const RECALL_EVERY_MS: i64 = 10_000;
/// 7.6: past the spokes mailbox TTL with the connector stale, an open task fails.
pub const MAILBOX_TTL_MS: i64 = 72 * 3_600_000;
/// 7.10: push credentials and tokens are deleted this long after the task is terminal.
pub const PUSH_KEEP_MS: i64 = 86_400_000;
/// 7.10: credentials 1 to 4096 characters, token 1 to 256.
pub const CREDENTIALS_MAX: usize = 4096;
pub const TOKEN_MAX: usize = 256;

// ── task states (A2A 4.1.3) ─────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    AuthRequired,
    Completed,
    Canceled,
    Failed,
    Rejected,
}

impl TaskState {
    pub const ALL: [TaskState; 8] =
        [TaskState::Submitted, TaskState::Working, TaskState::InputRequired, TaskState::AuthRequired, TaskState::Completed, TaskState::Canceled, TaskState::Failed, TaskState::Rejected];

    /// The proto JSON name.
    pub fn name(self) -> &'static str {
        match self {
            TaskState::Submitted => "TASK_STATE_SUBMITTED",
            TaskState::Working => "TASK_STATE_WORKING",
            TaskState::InputRequired => "TASK_STATE_INPUT_REQUIRED",
            TaskState::AuthRequired => "TASK_STATE_AUTH_REQUIRED",
            TaskState::Completed => "TASK_STATE_COMPLETED",
            TaskState::Canceled => "TASK_STATE_CANCELED",
            TaskState::Failed => "TASK_STATE_FAILED",
            TaskState::Rejected => "TASK_STATE_REJECTED",
        }
    }

    /// The short word of audit `state`, the metric label and the A2A 11.5 query form (`status=working`).
    pub fn label(self) -> &'static str {
        match self {
            TaskState::Submitted => "submitted",
            TaskState::Working => "working",
            TaskState::InputRequired => "input_required",
            TaskState::AuthRequired => "auth_required",
            TaskState::Completed => "completed",
            TaskState::Canceled => "canceled",
            TaskState::Failed => "failed",
            TaskState::Rejected => "rejected",
        }
    }

    /// Either form (`TASK_STATE_WORKING`, `working`; `-` read as `_`).
    pub fn of(s: &str) -> Option<TaskState> {
        let low = s.to_ascii_lowercase().replace('-', "_");
        TaskState::ALL.into_iter().find(|t| t.name() == s || t.label() == low)
    }

    /// Completed, canceled, failed or rejected.
    pub fn terminal(self) -> bool {
        matches!(self, TaskState::Completed | TaskState::Canceled | TaskState::Failed | TaskState::Rejected)
    }

    /// Input or auth required (A2A 3.2.2: `returnImmediately: false` answers at these too).
    pub fn interrupted(self) -> bool {
        matches!(self, TaskState::InputRequired | TaskState::AuthRequired)
    }
}

// ── Lucid's status sentences (7.6) ──────────────────────────────────────────────────────────────────────────

/// Why a task is in its state, as Lucid words it (never task content).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    StartWait,
    TurnWait,
    ActionWait,
    TurnDeclined,
    TurnExpired,
    TurnDone,
    /// Closed after this many minutes without a message.
    IdleClosed(i64),
    TaskDeclined,
    TaskExpired,
    Paused,
    CannotRun,
    NoSpoke,
    Failed,
    Stopped,
    Expired,
}

impl Why {
    /// The sentence, `org` the org's label.
    pub fn sentence(self, org: &str) -> String {
        match self {
            Why::StartWait => format!("Waiting for a person at {org} to approve this task."),
            Why::TurnWait => format!("Waiting for a person at {org} to approve your message."),
            Why::ActionWait => format!("Waiting for a person at {org} to approve an action."),
            Why::TurnDeclined => format!("A person at {org} declined your last message."),
            Why::TurnExpired => "Nobody approved your last message in time.".into(),
            Why::TurnDone => "Turn finished; send a message to continue.".into(),
            Why::IdleClosed(n) => format!("Closed after {n} minutes without a message."),
            Why::TaskDeclined => format!("A person at {org} declined the task."),
            Why::TaskExpired => "Nobody approved the task in time.".into(),
            Why::Paused => "The spoke is paused.".into(),
            Why::CannotRun => "The spoke cannot run this skill now.".into(),
            Why::NoSpoke => "No spoke is available for this skill.".into(),
            Why::Failed => "The task failed on the spoke.".into(),
            Why::Stopped => "The spoke's engine stopped the task.".into(),
            Why::Expired => "The task's messages expired.".into(),
        }
    }

    pub fn code(self) -> String {
        match self {
            Why::StartWait => "start_wait".into(),
            Why::TurnWait => "turn_wait".into(),
            Why::ActionWait => "action_wait".into(),
            Why::TurnDeclined => "turn_declined".into(),
            Why::TurnExpired => "turn_expired".into(),
            Why::TurnDone => "turn_done".into(),
            Why::IdleClosed(n) => format!("idle_closed:{n}"),
            Why::TaskDeclined => "task_declined".into(),
            Why::TaskExpired => "task_expired".into(),
            Why::Paused => "paused".into(),
            Why::CannotRun => "cannot_run".into(),
            Why::NoSpoke => "no_spoke".into(),
            Why::Failed => "failed".into(),
            Why::Stopped => "stopped".into(),
            Why::Expired => "expired".into(),
        }
    }

    pub fn of_code(s: &str) -> Option<Why> {
        if let Some(n) = s.strip_prefix("idle_closed:") {
            return n.parse().ok().map(Why::IdleClosed);
        }
        Some(match s {
            "start_wait" => Why::StartWait,
            "turn_wait" => Why::TurnWait,
            "action_wait" => Why::ActionWait,
            "turn_declined" => Why::TurnDeclined,
            "turn_expired" => Why::TurnExpired,
            "turn_done" => Why::TurnDone,
            "task_declined" => Why::TaskDeclined,
            "task_expired" => Why::TaskExpired,
            "paused" => Why::Paused,
            "cannot_run" => Why::CannotRun,
            "no_spoke" => Why::NoSpoke,
            "failed" => Why::Failed,
            "stopped" => Why::Stopped,
            "expired" => Why::Expired,
            _ => return None,
        })
    }
}

/// A turn the spoke did not run (5.5, R6-3): a person declined it, or nobody decided in time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnRefused {
    Declined,
    Expired,
}

/// What a spoke reports of one task (the service hub's book).
#[derive(Clone, Copy, Debug)]
pub struct SpokeView<'a> {
    pub state: &'a str,
    pub awaiting: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub turns: i64,
}

/// spoke.ts: the reason a lane the engine refused closes its task with.
const ENGINE_REFUSED: &str = "engine refused the lane";

/// 7.6: the A2A state and sentence of a spoke task, and whether the connector closes it now (`turns: one` after its
/// turn). `many` is the skill's `turns: many`; `refused` the last turn's refusal while the task is idle.
pub fn lifecycle(v: &SpokeView, many: bool, refused: Option<TurnRefused>) -> (TaskState, Option<Why>, bool) {
    match v.state {
        "awaiting_approval" => {
            let why = match v.awaiting {
                Some("task.start") => Why::StartWait,
                Some("task.turn") => Why::TurnWait,
                _ => Why::ActionWait,
            };
            (TaskState::AuthRequired, Some(why), false)
        }
        "working" => (TaskState::Working, None, false),
        "idle" => match refused {
            Some(TurnRefused::Declined) => (TaskState::InputRequired, Some(Why::TurnDeclined), false),
            Some(TurnRefused::Expired) => (TaskState::InputRequired, Some(Why::TurnExpired), false),
            None if !many && v.turns >= 1 => (TaskState::Completed, None, true),
            None => (TaskState::InputRequired, Some(Why::TurnDone), false),
        },
        "closed" => match v.reason {
            Some("denied") => (TaskState::Rejected, Some(Why::TaskDeclined), false),
            Some("approval expired") => (TaskState::Rejected, Some(Why::TaskExpired), false),
            Some(r) if r.starts_with(ENGINE_REFUSED) => (TaskState::Rejected, Some(Why::CannotRun), false),
            // closed at the spoke by its owner or a human hub (as-built 1d4): canceled, no sentence
            _ => (TaskState::Canceled, None, false),
        },
        "error" => (TaskState::Failed, Some(Why::Failed), false),
        "stopped" => (TaskState::Failed, Some(Why::Stopped), false),
        _ => (TaskState::Working, None, false),
    }
}

// ── errors (7.11) ───────────────────────────────────────────────────────────────────────────────────────────

/// A refusal before it is audited and answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fault {
    pub status: u16,
    /// The A2A reason (`TASK_NOT_FOUND`, ...) or the Lucid code (`skill`, ...).
    pub reason: String,
    pub lucid: bool,
    pub message: String,
    /// `Retry-After` seconds.
    pub retry: Option<i64>,
}

impl Fault {
    /// An A2A error of A2A 5.4.
    pub fn a2a(status: u16, reason: &str, message: impl Into<String>) -> Fault {
        Fault { status, reason: reason.into(), lucid: false, message: message.into(), retry: None }
    }

    /// A Lucid refusal (1a 6.2, r5 and 7.11 codes).
    pub fn lucid(status: u16, code: &str, message: impl Into<String>) -> Fault {
        Fault { status, reason: code.into(), lucid: true, message: message.into(), retry: None }
    }

    pub fn retry(self, s: i64) -> Fault {
        Fault { retry: Some(s.max(1)), ..self }
    }

    pub fn not_found() -> Fault {
        Fault::a2a(404, "TASK_NOT_FOUND", "The task does not exist or is not accessible.")
    }

    pub fn invalid(message: impl Into<String>) -> Fault {
        Fault::a2a(400, "INVALID_PARAMS", message)
    }

    pub fn content_type(message: impl Into<String>) -> Fault {
        Fault::a2a(400, "CONTENT_TYPE_NOT_SUPPORTED", message)
    }

    pub fn unsupported(message: impl Into<String>) -> Fault {
        Fault::a2a(400, "UNSUPPORTED_OPERATION", message)
    }

    /// The `check` of its `api.refusal` entry: the Lucid code, or the A2A reason in lower case with dashes.
    pub fn check(&self) -> String {
        if self.lucid {
            self.reason.clone()
        } else {
            self.reason.to_ascii_lowercase().replace('_', "-")
        }
    }

    /// The `google.rpc.Status` name: A2A 5.4 for A2A errors, the HTTP mapping of `google.rpc.Code` otherwise.
    pub fn rpc_status(&self) -> &'static str {
        if !self.lucid {
            return match self.reason.as_str() {
                "TASK_NOT_FOUND" => "NOT_FOUND",
                "CONTENT_TYPE_NOT_SUPPORTED" | "INVALID_PARAMS" => "INVALID_ARGUMENT",
                _ => "FAILED_PRECONDITION",
            };
        }
        match self.status {
            400 | 413 => "INVALID_ARGUMENT",
            401 => "UNAUTHENTICATED",
            403 => "PERMISSION_DENIED",
            404 => "NOT_FOUND",
            409 => "ABORTED",
            429 => "RESOURCE_EXHAUSTED",
            503 => "UNAVAILABLE",
            _ => "INTERNAL",
        }
    }

    /// The A2A 11.6 body.
    pub fn body(&self, rid: &str) -> Value {
        let domain = if self.lucid { LUCID_DOMAIN } else { A2A_DOMAIN };
        json!({"error": {"code": self.status, "status": self.rpc_status(), "message": self.message,
                          "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": self.reason,
                                       "domain": domain, "metadata": {"requestId": rid}}]}})
    }
}

// ── paths (7.3) ─────────────────────────────────────────────────────────────────────────────────────────────

/// One A2A operation under `A/<agent id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Send,
    Stream,
    Get(String),
    List,
    Cancel(String),
    Subscribe(String),
    PushCreate(String),
    PushGet(String, String),
    PushList(String),
    PushDelete(String, String),
    ExtendedCard,
}

impl Op {
    /// The route table row's path pattern (`connector_api` A2A rows).
    pub fn pattern(&self) -> &'static str {
        match self {
            Op::Send => "/api/orgs/{org}/a2a/{agent}/message:send",
            Op::Stream => "/api/orgs/{org}/a2a/{agent}/message:stream",
            Op::Get(_) => "/api/orgs/{org}/a2a/{agent}/tasks/{id}",
            Op::List => "/api/orgs/{org}/a2a/{agent}/tasks",
            Op::Cancel(_) => "/api/orgs/{org}/a2a/{agent}/tasks/{id}:cancel",
            Op::Subscribe(_) => "/api/orgs/{org}/a2a/{agent}/tasks/{id}:subscribe",
            Op::PushCreate(_) | Op::PushList(_) => "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs",
            Op::PushGet(..) | Op::PushDelete(..) => "/api/orgs/{org}/a2a/{agent}/tasks/{id}/pushNotificationConfigs/{config}",
            Op::ExtendedCard => "/api/orgs/{org}/a2a/{agent}/extendedAgentCard",
        }
    }

    /// The task the path names (7.4 A3).
    pub fn task(&self) -> Option<&str> {
        match self {
            Op::Get(t) | Op::Cancel(t) | Op::Subscribe(t) | Op::PushCreate(t) | Op::PushList(t) | Op::PushGet(t, _) | Op::PushDelete(t, _) => Some(t),
            _ => None,
        }
    }

    /// An SSE answer (7.9).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn streams(&self) -> bool {
        matches!(self, Op::Stream | Op::Subscribe(_))
    }

    /// The A2A operation name (audit `op`).
    pub fn name(&self) -> &'static str {
        match self {
            Op::Send => "SendMessage",
            Op::Stream => "SendStreamingMessage",
            Op::Get(_) => "GetTask",
            Op::List => "ListTasks",
            Op::Cancel(_) => "CancelTask",
            Op::Subscribe(_) => "SubscribeToTask",
            Op::PushCreate(_) => "CreateTaskPushNotificationConfig",
            Op::PushGet(..) => "GetTaskPushNotificationConfig",
            Op::PushList(_) => "ListTaskPushNotificationConfigs",
            Op::PushDelete(..) => "DeleteTaskPushNotificationConfig",
            Op::ExtendedCard => "GetExtendedAgentCard",
        }
    }
}

/// The org of a path under some `A`: `/api/orgs/<org>/a2a` or below it.
pub fn a2a_org(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/api/orgs/")?;
    let (org, tail) = rest.split_once('/')?;
    (tail == "a2a" || tail.starts_with("a2a/")).then_some(org)
}

/// `(org, agent, op)` of an A2A route; None for any other method or path under `A` (404).
pub fn parse_path(method: &str, path: &str) -> Option<(String, String, Op)> {
    let org = a2a_org(path)?;
    let rest = path.strip_prefix(&format!("/api/orgs/{org}/a2a/"))?;
    let seg: Vec<&str> = rest.split('/').collect();
    if seg.iter().any(|s| s.is_empty()) {
        return None;
    }
    let agent = seg[0].to_string();
    let own = |s: &str| s.to_string();
    let op = match (method, &seg[1..]) {
        ("POST", ["message:send"]) => Op::Send,
        ("POST", ["message:stream"]) => Op::Stream,
        ("GET", ["tasks"]) => Op::List,
        ("GET", ["extendedAgentCard"]) => Op::ExtendedCard,
        ("POST", ["tasks", t]) => match t.rsplit_once(':') {
            Some((id, "cancel")) if !id.is_empty() => Op::Cancel(own(id)),
            Some((id, "subscribe")) if !id.is_empty() => Op::Subscribe(own(id)),
            _ => return None,
        },
        ("GET", ["tasks", t]) => match t.rsplit_once(':') {
            Some((id, "subscribe")) if !id.is_empty() => Op::Subscribe(own(id)),
            Some(_) => return None,
            None => Op::Get(own(t)),
        },
        ("POST", ["tasks", t, "pushNotificationConfigs"]) => Op::PushCreate(own(t)),
        ("GET", ["tasks", t, "pushNotificationConfigs"]) => Op::PushList(own(t)),
        ("GET", ["tasks", t, "pushNotificationConfigs", c]) => Op::PushGet(own(t), own(c)),
        ("DELETE", ["tasks", t, "pushNotificationConfigs", c]) => Op::PushDelete(own(t), own(c)),
        _ => return None,
    };
    Some((org.to_string(), agent, op))
}

/// A query parameter (the first), form-decoded.
pub fn query_param(query: &str, k: &str) -> Option<String> {
    query.split('&').filter_map(|p| p.split_once('=')).find(|(a, _)| *a == k).and_then(|(_, v)| crate::api_issue::unescape(v))
}

// ── ids (A2A 3.4) ───────────────────────────────────────────────────────────────────────────────────────────

/// `prefix` and 22 base64url characters of 16 random bytes: task `t2_`, context `x_`, push config `p_`, message `m_`.
pub fn new_id(prefix: &str) -> Option<String> {
    let mut b = [0u8; 16];
    aws_lc_rs::rand::fill(&mut b).ok()?;
    Some(format!("{prefix}{}", b64u(&b)))
}

/// An id `new_id(prefix)` could have made.
#[cfg_attr(not(test), allow(dead_code))]
pub fn id_ok(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix).is_some_and(|r| r.len() == 22 && r.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
}

/// An ISO 8601 UTC time (`2026-11-23T10:00:00Z`, fractions allowed) in ms.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' || !matches!(b[b.len() - 1], b'Z' | b'z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r).filter(|x| x.bytes().all(|c| c.is_ascii_digit())).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let frac = &s[19..s.len() - 1];
    let ms = match frac.strip_prefix('.') {
        None if frac.is_empty() => 0,
        Some(f) if !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit()) => format!("{:0<3}", &f[..f.len().min(3)]).parse::<i64>().ok()?,
        _ => return None,
    };
    // Howard Hinnant's days_from_civil
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + se) * 1000) + ms)
}

// ── intake (7.5) ────────────────────────────────────────────────────────────────────────────────────────────

/// A `SendMessageRequest` as 7.5 takes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Intake {
    pub message_id: String,
    pub context_id: Option<String>,
    pub task_id: Option<String>,
    /// The text parts joined by a line break.
    pub text: String,
    /// The Lucid extension's skill.
    pub skill: Option<String>,
    pub push: Option<Value>,
    pub history_length: Option<usize>,
    pub return_immediately: bool,
}

fn history_of(v: Option<&Value>) -> Result<Option<usize>, Fault> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(n) => n.as_u64().and_then(|n| usize::try_from(n).ok()).map(Some).ok_or_else(|| Fault::invalid("historyLength must be a whole number of 0 or more.")),
    }
}

/// `historyLength` of a query (None absent).
pub fn history_param(query: &str) -> Result<Option<usize>, Fault> {
    match query_param(query, "historyLength") {
        None => Ok(None),
        Some(s) => s.parse::<usize>().map(Some).map_err(|_| Fault::invalid("historyLength must be a whole number of 0 or more.")),
    }
}

/// 7.5: the body of `message:send` or `message:stream`.
pub fn intake(body: &[u8]) -> Result<Intake, Fault> {
    let v: Value = serde_json::from_slice(body).map_err(|_| Fault::invalid("The body must be a SendMessageRequest (JSON)."))?;
    let o = v.as_object().ok_or_else(|| Fault::invalid("The body must be a SendMessageRequest object."))?;
    if o.keys().any(|k| !matches!(k.as_str(), "message" | "configuration" | "metadata" | "tenant")) {
        return Err(Fault::invalid("A SendMessageRequest has message, configuration and metadata only."));
    }
    if o.get("tenant").is_some_and(|t| t.as_str() != Some("")) {
        return Err(Fault::invalid("This agent takes no tenant."));
    }
    let m = o.get("message").and_then(Value::as_object).ok_or_else(|| Fault::invalid("message is required."))?;
    if str_of(m.get("role")) != Some("ROLE_USER") {
        return Err(Fault::invalid("message.role must be ROLE_USER."));
    }
    let message_id = str_of(m.get("messageId")).filter(|s| (1..=MESSAGE_ID_MAX).contains(&s.chars().count())).ok_or_else(|| Fault::invalid("messageId must be 1 to 128 characters."))?;
    let opt = |k: &str| -> Result<Option<String>, Fault> {
        match m.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if s.is_empty() => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(Fault::invalid(format!("{k} must be a string."))),
        }
    };
    let (context_id, task_id) = (opt("contextId")?, opt("taskId")?);
    let parts = m.get("parts").and_then(Value::as_array).filter(|p| (1..=PARTS_MAX).contains(&p.len())).ok_or_else(|| Fault::invalid("parts must list 1 to 16 parts."))?;
    let mut texts = Vec::with_capacity(parts.len());
    for p in parts {
        let p = p.as_object().ok_or_else(|| Fault::invalid("Each part is an object."))?;
        if ["raw", "url", "data"].iter().any(|k| p.contains_key(*k)) {
            return Err(Fault::content_type("This agent takes text parts only (text/plain or text/markdown)."));
        }
        let text = str_of(p.get("text")).ok_or_else(|| Fault::invalid("Each part needs text."))?;
        match str_of(p.get("mediaType")) {
            None | Some("") | Some("text/plain") | Some("text/markdown") => {}
            Some(_) => return Err(Fault::content_type("This agent takes text/plain and text/markdown parts only.")),
        }
        if p.keys().any(|k| !matches!(k.as_str(), "text" | "mediaType" | "metadata" | "filename")) {
            return Err(Fault::invalid("A text part has text, mediaType, metadata and filename only."));
        }
        texts.push(text);
    }
    let text = texts.join("\n");
    if text.trim().is_empty() {
        return Err(Fault::invalid("The message has no text."));
    }
    if utf16_len(&text) > crate::connector_spokes_wire::MAX_TEXT {
        return Err(Fault::invalid("The message text is over 32000 characters."));
    }
    let skill = match m.get("metadata").and_then(|md| md.get(EXT)) {
        None => None,
        Some(x) => {
            let e = x.as_object().filter(|e| e.len() == 1).ok_or_else(|| Fault::invalid(format!("metadata[\"{EXT}\"] is {{\"skill\": <skill id>}} only.")))?;
            Some(str_of(e.get("skill")).filter(|s| !s.is_empty()).ok_or_else(|| Fault::invalid("skill must be a skill id."))?.to_string())
        }
    };
    let (mut push, mut history_length, mut return_immediately) = (None, None, false);
    if let Some(c) = o.get("configuration").filter(|c| !c.is_null()) {
        let c = c.as_object().ok_or_else(|| Fault::invalid("configuration must be an object."))?;
        if let Some(modes) = c.get("acceptedOutputModes").filter(|x| !x.is_null()) {
            let list = modes.as_array().ok_or_else(|| Fault::invalid("acceptedOutputModes must be a list."))?;
            let has = |want: &str| list.iter().any(|x| x.as_str() == Some(want));
            if !list.is_empty() && !has("text/markdown") && !has("application/json") {
                return Err(Fault::content_type("This agent answers text/markdown and application/json; acceptedOutputModes names neither."));
            }
        }
        push = c.get("taskPushNotificationConfig").filter(|x| !x.is_null()).cloned();
        history_length = history_of(c.get("historyLength"))?;
        return_immediately = match c.get("returnImmediately") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(Fault::invalid("returnImmediately must be true or false.")),
        };
    }
    Ok(Intake { message_id: message_id.to_string(), context_id, task_id, text, skill, push, history_length, return_immediately })
}

/// The partner's message as kept in the task history (its own text, never the connector's header).
pub fn user_message(message_id: &str, task: &str, context: &str, text: &str) -> Value {
    json!({"messageId": message_id, "taskId": task, "contextId": context, "role": "ROLE_USER", "parts": [{"text": text}]})
}

// ── push configs (7.10) ─────────────────────────────────────────────────────────────────────────────────────

/// A push config as the partner asked for it (checked against the client's origins by the server).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushAsk {
    pub url: String,
    pub origin: String,
    pub token: Option<String>,
    pub credentials: Option<String>,
}

/// `https://host[:port]` of an https URL, the host lower case and the default port left out; None for anything else.
pub fn origin_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(&['/', '?', '#'][..]).next().filter(|a| !a.is_empty() && !a.contains('@'))?;
    let (host, port) = crate::ai_gateway::host_port(&format!("https://{authority}"))?;
    if host.is_empty() || port == 0 {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let host = if host.contains(':') { format!("[{host}]") } else { host };
    Some(if port == 443 { format!("https://{host}") } else { format!("https://{host}:{port}") })
}

/// A `TaskPushNotificationConfig` body (or the one inside a `SendMessageConfiguration`).
pub fn push_ask(v: &Value) -> Result<PushAsk, Fault> {
    let bad = |why: &str| Fault::invalid(why.to_string());
    let o = v.as_object().ok_or_else(|| bad("A push config is an object."))?;
    if o.keys().any(|k| !matches!(k.as_str(), "url" | "token" | "authentication" | "id" | "taskId" | "tenant")) {
        return Err(bad("A push config has url, token and authentication only."));
    }
    if o.get("tenant").is_some_and(|t| t.as_str() != Some("")) {
        return Err(bad("This agent takes no tenant."));
    }
    let url = str_of(o.get("url")).filter(|u| u.len() <= crate::api_fetch::MAX_URL).ok_or_else(|| bad("url must be an https URL of at most 512 characters."))?;
    let origin = origin_of(url).ok_or_else(|| Fault::lucid(400, "push-origin", "url must be an https URL under one of this client's push origins."))?;
    let token = match o.get("token") {
        None | Some(Value::Null) => None,
        Some(t) => Some(t.as_str().filter(|t| (1..=TOKEN_MAX).contains(&t.chars().count()) && header_safe(t)).ok_or_else(|| bad("token must be 1 to 256 printable characters."))?.to_string()),
    };
    let credentials = match o.get("authentication").filter(|a| !a.is_null()) {
        None => None,
        Some(a) => {
            let a = a.as_object().ok_or_else(|| bad("authentication must be an object."))?;
            if !str_of(a.get("scheme")).is_some_and(|s| s.eq_ignore_ascii_case("bearer")) || a.keys().any(|k| k != "scheme" && k != "credentials") {
                return Err(bad("authentication must be {\"scheme\": \"Bearer\", \"credentials\": <1 to 4096 characters>}."));
            }
            Some(
                str_of(a.get("credentials"))
                    .filter(|c| (1..=CREDENTIALS_MAX).contains(&c.chars().count()) && header_safe(c))
                    .ok_or_else(|| bad("credentials must be 1 to 4096 printable characters."))?
                    .to_string(),
            )
        }
    };
    Ok(PushAsk { url: url.to_string(), origin, token, credentials })
}

/// Printable ASCII without line breaks (a header value).
fn header_safe(s: &str) -> bool {
    s.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// The config as Get and List answer it: `credentials` never returned (7.10).
pub fn push_view(id: &str, task: &str, url: &str, token: Option<&str>, has_credentials: bool) -> Value {
    let mut v = json!({"id": id, "taskId": task, "url": url});
    if let Some(t) = token {
        v["token"] = json!(t);
    }
    if has_credentials {
        v["authentication"] = json!({"scheme": "Bearer", "credentials": "<set>"});
    }
    v
}

// ── tasks, events, artifacts (7.8, 7.9) ─────────────────────────────────────────────────────────────────────

/// A `TaskStatus`: the state, Lucid's sentence as an agent message, the time.
pub fn status_json(state: TaskState, sentence: Option<&str>, task: &str, context: &str, at_ms: i64) -> Value {
    let mut s = json!({"state": state.name(), "timestamp": iso_time(at_ms)});
    if let Some(text) = sentence {
        s["message"] = json!({"messageId": format!("m_{task}_{at_ms}"), "taskId": task, "contextId": context, "role": "ROLE_AGENT", "parts": [{"text": text, "mediaType": "text/plain"}]});
    }
    s
}

/// `StreamResponse.statusUpdate` (also the only payload of a push, 7.10).
pub fn status_update(task: &str, context: &str, status: &Value) -> Value {
    json!({"statusUpdate": {"taskId": task, "contextId": context, "status": status}})
}

/// `StreamResponse.artifactUpdate` (turns are not chunked: `append` false, `lastChunk` true).
pub fn artifact_update(task: &str, context: &str, artifact: &Value) -> Value {
    json!({"artifactUpdate": {"taskId": task, "contextId": context, "artifact": artifact, "append": false, "lastChunk": true}})
}

/// One SSE event.
pub fn sse(v: &Value) -> String {
    format!("data: {v}\n\n")
}

/// 7.8: the artifact of a `task.turn` journal entry (`n` from 1).
pub fn turn_artifact(n: i64, text: &str) -> Value {
    json!({"artifactId": format!("turn-{n}"), "name": format!("Turn {n}"), "parts": [{"text": text, "mediaType": "text/markdown"}]})
}

/// 7.8: the review branch and handoff commit.
pub fn handoff_artifact(branch: &str, commit: &str) -> Value {
    json!({"artifactId": "handoff", "name": "Review branch", "parts": [{"data": {"reviewBranch": branch, "commit": commit}, "mediaType": "application/json"}]})
}

/// The Lucid extension's task metadata (7.8 `truncated`, the pending ask's end while a person decides).
pub fn task_metadata(truncated: bool, ask_expires_ms: Option<i64>) -> Option<Value> {
    let mut m = Map::new();
    if truncated {
        m.insert("truncated".into(), Value::Bool(true));
    }
    if let Some(at) = ask_expires_ms.filter(|a| *a > 0) {
        m.insert("approvalExpires".into(), json!(iso_time(at)));
    }
    (!m.is_empty()).then(|| json!({EXT: m}))
}

/// The last `n` of a history (all when None).
pub fn last_of(history: &[Value], n: Option<usize>) -> Vec<Value> {
    let keep = n.unwrap_or(history.len()).min(history.len());
    history[history.len() - keep..].to_vec()
}

/// A list page token: the position after the last task of the page.
pub fn page_token(status_ms: i64, task: &str) -> String {
    b64u(format!("{status_ms}:{task}").as_bytes())
}

pub fn page_after(token: &str) -> Option<(i64, String)> {
    let raw = crate::codec::unb64u(token)?;
    let text = String::from_utf8(raw).ok()?;
    let (ms, id) = text.split_once(':')?;
    Some((ms.parse().ok()?, id.to_string()))
}
