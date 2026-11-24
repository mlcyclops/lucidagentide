// Contract API-1 revision 5 (phase 1c), sections 6.3, 7.4 and 2.9: the delegation notice (`dlgn`) for reach R1.
//
// The connector never sees a delegated token being issued; it sees each token when the client uses it here (a
// delegated R1 token's audience is one connector, 4.4). The first time a token of (client, person) passes the checks
// of 5.3, an API app the client may use posts CE-1 `dlgn {client, scopes, since}` in its DM with the person
// (`AppSession::send_dlgn`).
//
// The request only queues the notice (`first_use`, no disk or relay work) and a worker thread (`start`) does the rest,
// so a notice never slows or refuses a request. Every step is sealed (`names::NOTICES`) before its effect:
// - post: an outbox record (`posting`) with the notice's message id and payload is sealed before the first post, and
//   that same id is posted again until the relay keeps it; a repeat after a lost answer or a crash is refused by the
//   relay (CE-1 ids are unique per conversation, `connector_device::ID_KEPT`) and counts as kept. Then `sent`.
// - skip: r5 opens a DM only for `apr` (7.5), so a notice never opens one. When no app the client may use has a DM
//   with the person, a pending record (`skipping`) is sealed, then `content.notice.skipped {client, person, app,
//   check: "no-dm"}` is written, then the mark `skipped`. A pending record found by a later run (a stop between the
//   two) is marked `skipped` without a second entry, so the entry is written at most once per (client, person); an
//   entry that could not be written drops the pending record, and the next token tries again.
// A pair that is `skipped` (or whose post failed before its outbox record was sealed) is tried again with the
// client's next token for that person (a new `jti`), never twice with one token.

use crate::api_resource::AuditLog;
use crate::ce_device as ce;
use crate::connector::Connector;
use crate::connector_device::ID_KEPT;
use crate::connector_seal::names;
use crate::connector_session::AppSession;
use crate::meet::{log_error, log_info, log_warn};
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

/// The `check` of a skipped notice: no API app the client may use has a DM with the person.
pub const CHECK_NO_DM: &str = "no-dm";
/// The worker also wakes this often, to post again what is still in the outbox.
pub const RETRY_EVERY: Duration = Duration::from_secs(60);
/// Notices waiting for the worker, at most (one per (client, person); when full, the next token tries again).
const QUEUE_MAX: usize = 1000;
/// (client, person) pairs whose last tried token is remembered in memory, at most.
const TRIED_MAX: usize = 10_000;

/// The states of a (client, person) record.
mod state {
    pub const SENT: &str = "sent";
    pub const SKIPPED: &str = "skipped";
    /// The outbox: the notice's id and payload, posted (again, under that id) until the relay keeps it.
    pub const POSTING: &str = "posting";
    /// Sealed before the skip entry is written.
    pub const SKIPPING: &str = "skipping";
}
use state::{POSTING, SENT, SKIPPED, SKIPPING};

/// One sealed record: its state, `since` (ms, when the notice was first tried) and, while `posting`, the message id,
/// the app (its config name) that posts and the notice's client name and scopes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Rec {
    state: String,
    since: i64,
    mid: String,
    app: String,
    name: String,
    scopes: Vec<String>,
}

impl Rec {
    fn done(state: &str, since: i64) -> Rec {
        Rec { state: state.to_string(), since, ..Rec::default() }
    }

    fn to_value(&self) -> Value {
        let mut v = json!({"state": self.state, "since": self.since});
        if self.state == POSTING {
            v["mid"] = json!(self.mid);
            v["app"] = json!(self.app);
            v["name"] = json!(self.name);
            v["scopes"] = json!(self.scopes);
        }
        v
    }

    fn from_value(v: &Value) -> Option<Rec> {
        let state = v.get("state").and_then(Value::as_str).filter(|s| [SENT, SKIPPED, POSTING, SKIPPING].contains(s))?;
        let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let scopes = v.get("scopes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let rec = Rec { state: state.to_string(), since: v.get("since").and_then(Value::as_i64)?, mid: text("mid"), app: text("app"), name: text("name"), scopes };
        (rec.state != POSTING || !(rec.mid.is_empty() || rec.app.is_empty() || rec.name.is_empty())).then_some(rec)
    }
}

/// A notice the request path queued.
struct Job {
    org: String,
    client: String,
    /// The client's map `name`.
    name: String,
    person: String,
    scopes: Vec<String>,
    jti: String,
    /// The config names of the apps the client may use (5.2 step 2), in order.
    apps: Vec<String>,
}

fn key_of(client: &str, person: &str) -> String {
    format!("{client} {person}")
}

/// The delegation notices of one connector.
pub struct Notices {
    conn: Arc<Connector>,
    audit: Arc<dyn AuditLog>,
    /// "<client> <person>" -> its record, read from the sealed store by the worker (None until read).
    marks: Mutex<Option<BTreeMap<String, Rec>>>,
    queue: Mutex<VecDeque<Job>>,
    wake: Condvar,
    /// "<client> <person>" -> the `jti` of the last token a notice was tried with.
    tried: Mutex<HashMap<String, String>>,
    /// One run of the worker at a time.
    one: Mutex<()>,
}

impl Notices {
    pub fn new(conn: Arc<Connector>, audit: Arc<dyn AuditLog>) -> Notices {
        Notices { conn, audit, marks: Mutex::new(None), queue: Mutex::new(VecDeque::new()), wake: Condvar::new(), tried: Mutex::new(HashMap::new()), one: Mutex::new(()) }
    }

    /// The worker thread: a run whenever a notice is queued, and at least every `RETRY_EVERY`; `clock` gives the
    /// time (ms). It ends once these notices are dropped.
    pub fn start(self: &Arc<Self>, clock: Box<dyn Fn() -> i64 + Send>) -> Result<(), String> {
        let weak = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("connector-notices".into())
            .spawn(move || {
                while let Some(n) = weak.upgrade() {
                    {
                        let mut q = n.queue.lock();
                        if q.is_empty() {
                            n.wake.wait_for(&mut q, RETRY_EVERY);
                        }
                    }
                    n.work(clock());
                }
            })
            .map(|_| ())
            .map_err(|e| format!("cannot start the delegation notices: {e}"))
    }

    /// r5 6.3, on the request path, for a delegated token of `client` (`name` its map `name`) for `person` that passed
    /// the checks of 5.3, with its `scopes` and `jti`; `apps` the sessions of the apps the client may use (5.2 step
    /// 2), in order. It only queues the notice for the worker (true when queued).
    #[allow(clippy::too_many_arguments)]
    pub fn first_use(&self, org: &str, client: &str, name: &str, person: &str, scopes: &[String], jti: &str, apps: &[Arc<AppSession>]) -> bool {
        let key = key_of(client, person);
        if self.marks.lock().as_ref().and_then(|m| m.get(&key)).is_some_and(|r| r.state == SENT) {
            return false;
        }
        let job = Job {
            org: org.to_string(),
            client: client.to_string(),
            name: name.to_string(),
            person: person.to_string(),
            scopes: scopes.to_vec(),
            jti: jti.to_string(),
            apps: apps.iter().map(|s| s.app.clone()).collect(),
        };
        {
            let mut q = self.queue.lock();
            if let Some(i) = q.iter().position(|j| j.client == client && j.person == person) {
                q[i] = job;
            } else if q.len() >= QUEUE_MAX {
                log_warn(&format!("connector_dlgn_not_queued client={client} (the queue is full; the next token tries again)"));
                return false;
            } else {
                q.push_back(job);
            }
        }
        self.wake.notify_one();
        true
    }

    /// The records, read from the sealed store when not yet read; None when it cannot be read now.
    fn marks(&self) -> Option<BTreeMap<String, Rec>> {
        let mut held = self.marks.lock();
        if held.is_none() {
            let read = match self.conn.shared.sealed.get(names::NOTICES) {
                Ok(v) => v,
                Err(e) => {
                    log_warn(&format!("connector_notices_not_read error={e}"));
                    return None;
                }
            };
            let recs = read.as_ref().and_then(|v| v.get("notices")).and_then(Value::as_object).into_iter().flatten().filter_map(|(k, r)| Some((k.clone(), Rec::from_value(r)?)));
            *held = Some(recs.collect());
        }
        held.clone()
    }

    /// Seal `key`'s new record (None removes it); kept only once sealed.
    fn put(&self, key: &str, rec: Option<Rec>) -> bool {
        let mut held = self.marks.lock();
        let mut next = held.clone().unwrap_or_default();
        match rec {
            Some(r) => next.insert(key.to_string(), r),
            None => next.remove(key),
        };
        let v: Map<String, Value> = next.iter().map(|(k, r)| (k.clone(), r.to_value())).collect();
        match self.conn.shared.sealed.put(names::NOTICES, &json!({"notices": v})) {
            Ok(()) => {
                *held = Some(next);
                true
            }
            Err(e) => {
                log_error(&format!("connector_notice_not_sealed error={e}"));
                false
            }
        }
    }

    /// One run: the outbox posted again, pending skips found from an earlier run marked (no second entry), then the
    /// queued notices in order.
    pub fn work(&self, now_ms: i64) {
        let _one = self.one.lock();
        let Some(marks) = self.marks() else { return };
        for (key, rec) in &marks {
            match rec.state.as_str() {
                POSTING => self.post(key, rec, now_ms),
                SKIPPING => {
                    log_info("connector_dlgn_skip_marked (its entry was written before a stop)");
                    self.put(key, Some(Rec::done(SKIPPED, rec.since)));
                }
                _ => {}
            }
        }
        let jobs: Vec<Job> = self.queue.lock().drain(..).collect();
        for job in jobs {
            self.take(&job, now_ms);
        }
    }

    fn take(&self, job: &Job, now_ms: i64) {
        let key = key_of(&job.client, &job.person);
        {
            let mut tried = self.tried.lock();
            if tried.get(&key).is_some_and(|j| *j == job.jti) {
                return;
            }
            if tried.len() >= TRIED_MAX && !tried.contains_key(&key) {
                tried.clear();
            }
            tried.insert(key.clone(), job.jti.clone());
        }
        let prior = self.marks.lock().as_ref().and_then(|m| m.get(&key)).cloned();
        // sent, or in the outbox (posted again by every run)
        if prior.as_ref().is_some_and(|r| r.state != SKIPPED) {
            return;
        }
        let since = prior.as_ref().map_or(now_ms, |r| r.since);
        let sessions: Vec<Arc<AppSession>> = job.apps.iter().filter_map(|a| self.conn.sessions.get(a).cloned()).collect();
        let serving: Vec<&Arc<AppSession>> = sessions.iter().filter(|s| s.serving().is_ok()).collect();
        let Some(s) = serving.iter().find(|s| s.has_dm(&job.person)) else {
            if prior.is_none() {
                self.skip(&key, job, serving.first().copied().or(sessions.first()), since, now_ms);
            }
            return;
        };
        let rec = Rec { state: POSTING.into(), since, mid: ce::new_mid(), app: s.app.clone(), name: job.name.clone(), scopes: job.scopes.clone() };
        if self.put(&key, Some(rec.clone())) {
            self.post(&key, &rec, now_ms);
        }
    }

    /// The pending record, the entry, then the mark (see the module comment).
    fn skip(&self, key: &str, job: &Job, app: Option<&Arc<AppSession>>, since: i64, now_ms: i64) {
        if !self.put(key, Some(Rec::done(SKIPPING, since))) {
            return;
        }
        let mut e = json!({"action": "content.notice.skipped", "client": job.client, "person": job.person, "check": CHECK_NO_DM});
        let app = app.map(|s| s.principal().0).unwrap_or_default();
        if !app.is_empty() {
            e["app"] = json!(app);
        }
        if let Err(err) = self.audit.record(&job.org, e, now_ms.div_euclid(1000)) {
            log_warn(&format!("connector_notice_skip_not_audited client={} error={}", job.client, err.message));
            // not written: without the pending record the next token writes it
            self.put(key, None);
            return;
        }
        log_info(&format!("connector_dlgn_skipped client={} check={CHECK_NO_DM}", job.client));
        self.put(key, Some(Rec::done(SKIPPED, since)));
    }

    /// Post the outbox record `rec` under its own id; `sent` once the relay keeps it (now, or from an earlier try).
    fn post(&self, key: &str, rec: &Rec, now_ms: i64) {
        let person = key.split_once(' ').map(|(_, p)| p).unwrap_or_default();
        let Some(s) = self.conn.sessions.get(&rec.app) else {
            log_warn(&format!("connector_dlgn_not_sent app={} (no such app here)", rec.app));
            return;
        };
        let dlgn = json!({"client": rec.name, "scopes": rec.scopes, "since": rec.since});
        match s.send_dlgn(person, &dlgn, &rec.mid, now_ms) {
            Ok(_) => {}
            Err(e) if e == ID_KEPT => log_info(&format!("connector_dlgn_kept app={} (an earlier try reached the relay)", rec.app)),
            Err(e) => {
                log_warn(&format!("connector_dlgn_not_sent app={} error={e}", rec.app));
                return;
            }
        }
        self.put(key, Some(Rec::done(SENT, rec.since)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector_api::tests::{path, Fx, BEN, DELEGATED};
    use std::sync::atomic::Ordering::SeqCst;

    fn skips(fx: &Fx) -> Vec<Value> {
        fx.chain.entries.lock().iter().filter(|e| e["action"] == "content.notice.skipped").cloned().collect()
    }

    fn rec(fx: &Fx, person: &str) -> Value {
        fx.w.session.shared().sealed.get(names::NOTICES).unwrap().unwrap_or(Value::Null)["notices"][key_of(DELEGATED, person)].clone()
    }

    fn work(fx: &Fx) {
        fx.api.notices().work(fx.w.now);
    }

    /// Review P1: the request only queues the notice (no relay call, even with the relay away); the worker posts it.
    #[test]
    fn the_request_only_queues_the_notice_and_the_worker_posts_it() {
        let fx = Fx::new();
        fx.room("dlgn0", false);
        let ann = fx.w.ann_p.clone();
        fx.w.session.open_dm(&ann, fx.w.now).unwrap();
        fx.w.fake.refuse_dm.store(true, SeqCst);
        let t = fx.token(DELEGATED, Some(ann.as_str()));
        assert_eq!(fx.get(&t, "content/conversations", "").status, 200);
        assert_eq!(fx.w.fake.dm_tries.load(SeqCst), 0, "nothing is posted on the request path");
        assert!(rec(&fx, &ann).is_null(), "nothing is sealed on the request path");
        // the worker's try fails: the outbox keeps the notice and its id
        work(&fx);
        assert_eq!(fx.w.fake.dm_tries.load(SeqCst), 1);
        let pending = rec(&fx, &ann);
        assert_eq!(pending["state"], "posting");
        let mid = pending["mid"].as_str().unwrap().to_string();
        // the started worker posts the same id once the relay is back
        fx.w.fake.refuse_dm.store(false, SeqCst);
        let now = fx.w.now;
        fx.api.start_notices(Box::new(move || now)).unwrap();
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(ann.as_str())), "content/conversations", "").status, 200);
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while rec(&fx, &ann)["state"] != "sent" && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(rec(&fx, &ann)["state"], "sent");
        let posted: Vec<Value> = fx.w.fake.sent.lock().iter().filter(|(r, _)| r == "/v1/dm").map(|(_, b)| b.clone()).collect();
        assert_eq!(posted.len(), 1);
        assert_eq!((posted[0]["id"].as_str(), posted[0]["to"].as_str()), (Some(mid.as_str()), Some(ann.as_str())));
    }

    /// Review P2 (outbox): the relay keeps the notice but its answer is lost (as with a stop right after the post): a
    /// later run, here after a restart, posts the same id, the relay refuses the repeat, and the notice counts as sent;
    /// the person has one notice.
    #[test]
    fn a_notice_whose_answer_was_lost_is_never_posted_twice() {
        let fx = Fx::new();
        let ann = fx.w.ann_p.clone();
        fx.w.session.open_dm(&ann, fx.w.now).unwrap();
        fx.w.fake.lose_dm_answer.store(true, SeqCst);
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(ann.as_str())), "content/conversations", "").status, 200);
        work(&fx);
        assert_eq!(rec(&fx, &ann)["state"], "posting", "kept in the outbox: the relay's answer never came");
        let mid = rec(&fx, &ann)["mid"].as_str().unwrap().to_string();
        fx.w.fake.lose_dm_answer.store(false, SeqCst);
        // a new process: the outbox is read back from the sealed store
        let restarted = Notices::new(fx.conn.clone(), fx.chain.clone());
        restarted.work(fx.w.now);
        assert_eq!(fx.w.fake.dm_tries.load(SeqCst), 2, "the same id once more");
        assert_eq!(rec(&fx, &ann)["state"], "sent");
        let posted: Vec<Value> = fx.w.fake.sent.lock().iter().filter(|(r, _)| r == "/v1/dm").map(|(_, b)| b.clone()).collect();
        assert_eq!(posted.len(), 1, "the person has one notice");
        assert_eq!(posted[0]["id"].as_str(), Some(mid.as_str()));
        restarted.work(fx.w.now);
        assert_eq!(fx.w.fake.dm_tries.load(SeqCst), 2, "a sent notice is never posted again");
    }

    /// Review P2 (skip): no DM: one entry per (client, person) however many tokens; a pending skip left by a stop is
    /// marked without a second entry; an entry that could not be written is written with the next token; once a DM
    /// exists the next token posts the notice, `since` kept from the first try.
    #[test]
    fn a_skip_is_audited_once_and_the_notice_follows_a_dm() {
        let fx = Fx::new();
        fx.room("dlgn1", false);
        let ann = fx.w.ann_p.clone();
        let now = fx.w.now;
        let list = |t: &str| assert_eq!(fx.call("GET", &path("content/conversations"), "", Some(t), None, None, now).status, 200);
        let t1 = fx.token(DELEGATED, Some(ann.as_str()));
        list(&t1);
        work(&fx);
        list(&t1);
        list(&fx.token(DELEGATED, Some(ann.as_str())));
        work(&fx);
        let s = skips(&fx);
        assert_eq!(s.len(), 1, "one skip entry per (client, person)");
        assert_eq!((s[0]["client"].as_str(), s[0]["person"].as_str(), s[0]["app"].as_str(), s[0]["check"].as_str()), (Some(DELEGATED), Some(ann.as_str()), Some(fx.w.app_p.as_str()), Some(CHECK_NO_DM)));
        assert_eq!(rec(&fx, &ann)["state"], "skipped");
        // a stop between the sealed pending skip and its mark: the next run marks it, with no second entry
        let mut v = fx.w.session.shared().sealed.get(names::NOTICES).unwrap().unwrap();
        v["notices"][key_of(DELEGATED, BEN)] = json!({"state": "skipping", "since": now});
        fx.w.session.shared().sealed.put(names::NOTICES, &v).unwrap();
        let restarted = Notices::new(fx.conn.clone(), fx.chain.clone());
        restarted.work(now);
        assert_eq!(rec(&fx, BEN)["state"], "skipped");
        assert_eq!(skips(&fx).len(), 1, "no second entry for the pending skip");
        // an entry that cannot be written leaves nothing behind; the next token writes it
        let carl = "carl@acme.test";
        fx.chain.fail.store(true, SeqCst);
        let apps = vec![fx.w.session.clone()];
        let scopes = vec!["content.read".to_string()];
        restarted.first_use("acme", DELEGATED, "claude-ops", carl, &scopes, "j1", &apps);
        restarted.work(now);
        assert!(rec(&fx, carl).is_null());
        fx.chain.fail.store(false, SeqCst);
        restarted.first_use("acme", DELEGATED, "claude-ops", carl, &scopes, "j2", &apps);
        restarted.work(now);
        assert_eq!(rec(&fx, carl)["state"], "skipped");
        assert_eq!(skips(&fx).len(), 2);
        // a DM with Ann now: her next token posts the notice once, `since` from her first try
        fx.w.session.open_dm(&ann, now).unwrap();
        list(&fx.token(DELEGATED, Some(ann.as_str())));
        work(&fx);
        let m = rec(&fx, &ann);
        assert_eq!((m["state"].as_str(), m["since"].as_i64()), (Some("sent"), Some(now)));
        list(&fx.token(DELEGATED, Some(ann.as_str())));
        work(&fx);
        assert_eq!(fx.dm_posts(), 1, "never a second notice");
        assert_eq!(skips(&fx).len(), 2);
    }
}
