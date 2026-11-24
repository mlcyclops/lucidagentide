// Contract API-1 revision 6 (phase 1d), 7.10 (slice 1d4): the connector's A2A push notifications.
//
// A push carries only a `statusUpdate` with Lucid's own status sentence (never a task, a message or an artifact), so no
// task content leaves through a webhook. Each push config of a task has its own queue: `POST <url>` with
// `Content-Type: application/a2a+json`, `Authorization: Bearer <credentials>` and `X-A2A-Notification-Token: <token>`
// when set, under 1a 8.1 (no redirects, the address checked at every connect, a private address only inside the
// client's `push.private_cidrs`, web PKI with the name check), 10 s per attempt; at least once, in order per config
// (only the head of a queue is tried); a 2xx is delivered; anything else is retried with backoff from 1 s to 5 minutes
// with jitter and given up after 24 hours or 100 attempts (`dropped`). At most 256 events wait per config; past that
// only the latest state is kept. Every attempt's outcome goes to `Outcomes` (the server's `a2a.push` audit and metric).

use crate::api_export_wire::{hook_post_within, Credential};
use crate::connector_a2a_wire::CONTENT_TYPE;
use crate::console_source::Cidr;
use crate::meet::log_warn;
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

/// 7.10 limits.
pub const QUEUE_MAX: usize = 256;
pub const ATTEMPTS_MAX: u32 = 100;
pub const GIVE_UP_MS: i64 = 86_400_000;
pub const BACKOFF_MIN_MS: i64 = 1000;
pub const BACKOFF_MAX_MS: i64 = 300_000;
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);

/// One push config of a task, as the queue delivers to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub task: String,
    pub config: String,
    pub client: String,
    pub url: String,
    pub origin: String,
    pub token: Option<String>,
    pub credentials: Option<String>,
    pub within: Vec<Cidr>,
}

/// Sends one push: Ok is the receiver's status (any), Err a request that got no answer.
pub trait Poster: Send + Sync {
    fn post(&self, target: &Target, body: &[u8]) -> Result<u16, String>;
}

/// The network poster (`api_export_wire::hook_post_within`).
pub struct NetPoster;

impl Poster for NetPoster {
    fn post(&self, t: &Target, body: &[u8]) -> Result<u16, String> {
        let dest = json!({"kind": "webhook", "endpoint": t.url, "private_ok": false});
        let credential = t.credentials.clone().map_or(Credential::None, Credential::Token);
        let post = hook_post_within(&dest, credential, t.within.clone(), ATTEMPT_TIMEOUT).map_err(|e| e.to_string())?;
        let mut headers = vec![("Content-Type".to_string(), CONTENT_TYPE.to_string()), ("User-Agent".to_string(), format!("Lucid/{}", env!("CARGO_PKG_VERSION")))];
        if let Some(tok) = &t.token {
            headers.push(("X-A2A-Notification-Token".to_string(), tok.clone()));
        }
        post.post(&headers, body).map(|a| a.status).map_err(|e| e.to_string())
    }
}

/// One attempt's outcome (the `a2a.push` entry's fields).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub client: String,
    pub task: String,
    pub origin: String,
    /// `delivered`, `failed` or `dropped`.
    pub result: &'static str,
    pub attempt: u32,
    /// The receiver's status, 0 without an answer.
    pub status: u16,
}

pub type Outcomes = Arc<dyn Fn(&Outcome) + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Queue {
    target: Target,
    events: VecDeque<Value>,
    /// Attempts of the head event, the time it may be tried, and when it was first tried.
    attempt: u32,
    next_at: i64,
    first_at: Option<i64>,
}

/// The push queues of every config, keyed by (task, config).
pub struct Pusher {
    queues: Mutex<BTreeMap<(String, String), Queue>>,
    wake: Condvar,
    poster: Arc<dyn Poster>,
    outcomes: Outcomes,
    clock: Clock,
}

fn jitter(ms: i64) -> i64 {
    let mut b = [0u8; 2];
    let _ = aws_lc_rs::rand::fill(&mut b);
    // 80 % to 120 %
    ms * (80 + i64::from(u16::from_le_bytes(b) % 41)) / 100
}

/// The wait after the `attempt`th failure: 1 s doubling to 5 minutes, with jitter.
pub fn backoff_ms(attempt: u32) -> i64 {
    let base = BACKOFF_MIN_MS.saturating_mul(1i64 << attempt.saturating_sub(1).min(20)).min(BACKOFF_MAX_MS);
    jitter(base).clamp(BACKOFF_MIN_MS, BACKOFF_MAX_MS)
}

impl Pusher {
    pub fn new(poster: Arc<dyn Poster>, outcomes: Outcomes, clock: Clock) -> Pusher {
        Pusher { queues: Mutex::new(BTreeMap::new()), wake: Condvar::new(), poster, outcomes, clock }
    }

    /// Queue one `statusUpdate` for a config (past `QUEUE_MAX` only the latest state stays).
    pub fn enqueue(&self, target: Target, event: Value) {
        let now = (self.clock)();
        let mut q = self.queues.lock();
        let e = q.entry((target.task.clone(), target.config.clone())).or_insert_with(|| Queue { target: target.clone(), events: VecDeque::new(), attempt: 0, next_at: now, first_at: None });
        e.target = target;
        if e.events.len() >= QUEUE_MAX {
            e.events.clear();
            e.attempt = 0;
            e.first_at = None;
            e.next_at = now;
        }
        e.events.push_back(event);
        drop(q);
        self.wake.notify_all();
    }

    /// Stop every delivery of a config (deleted, its origin dropped).
    pub fn drop_config(&self, task: &str, config: &str) {
        self.queues.lock().remove(&(task.to_string(), config.to_string()));
    }

    /// Stop every delivery of a task (its configs deleted).
    pub fn drop_task(&self, task: &str) {
        self.queues.lock().retain(|(t, _), _| t != task);
    }

    /// Events waiting for a config (tests).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn waiting(&self, task: &str, config: &str) -> usize {
        self.queues.lock().get(&(task.to_string(), config.to_string())).map_or(0, |q| q.events.len())
    }

    /// One pass: every queue whose head is due is tried once. Returns the attempts made.
    pub fn tick(&self) -> usize {
        let now = (self.clock)();
        let due: Vec<(String, String, Target, Value, u32)> = self
            .queues
            .lock()
            .iter_mut()
            .filter(|(_, q)| q.next_at <= now && !q.events.is_empty())
            .map(|((t, c), q)| {
                q.attempt += 1;
                q.first_at.get_or_insert(now);
                // no second attempt of the same head before this one settles
                q.next_at = i64::MAX;
                (t.clone(), c.clone(), q.target.clone(), q.events[0].clone(), q.attempt)
            })
            .collect();
        for (task, config, target, event, attempt) in &due {
            let body = serde_json::to_vec(event).unwrap_or_default();
            let sent = self.poster.post(target, &body);
            let status = *sent.as_ref().unwrap_or(&0);
            let ok = (200..300).contains(&status);
            let now = (self.clock)();
            let mut result = if ok { "delivered" } else { "failed" };
            {
                let mut q = self.queues.lock();
                if let Some(e) = q.get_mut(&(task.clone(), config.clone())) {
                    let gave_up = !ok && (*attempt >= ATTEMPTS_MAX || e.first_at.is_some_and(|f| now - f >= GIVE_UP_MS));
                    if ok || gave_up {
                        e.events.pop_front();
                        e.attempt = 0;
                        e.first_at = None;
                        e.next_at = now;
                        if gave_up {
                            result = "dropped";
                        }
                    } else {
                        e.next_at = now + backoff_ms(*attempt);
                    }
                    if e.events.is_empty() {
                        q.remove(&(task.clone(), config.clone()));
                    }
                }
            }
            if let Err(why) = &sent {
                log_warn(&format!("connector_a2a_push_failed task={task} origin={} attempt={attempt} why={why}", target.origin));
            }
            (self.outcomes)(&Outcome { client: target.client.clone(), task: task.clone(), origin: target.origin.clone(), result, attempt: *attempt, status });
        }
        due.len()
    }

    /// The delivery loop on its own thread: due queues tried, then a wait until the next is due (an enqueue wakes it).
    pub fn run(&self) {
        loop {
            self.tick();
            let now = (self.clock)();
            let mut q = self.queues.lock();
            let next = q.values().filter(|x| !x.events.is_empty()).map(|x| x.next_at).min().unwrap_or(i64::MAX);
            let wait = if next == i64::MAX { 60_000 } else { (next - now).clamp(0, 60_000) };
            if wait > 0 {
                self.wake.wait_for(&mut q, Duration::from_millis(wait as u64));
            }
        }
    }
}
