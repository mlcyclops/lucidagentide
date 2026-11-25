// Contract API-1 revision 5 (phase 1c), section 7.5 (the person approves a write first), 5.3 check 13 (R5-13),
// R5-12 (the grant re-check), R5-19 (an owner who must approve is a current member) and 7.6 (Stop).
//
// An approval is created only after every check of 5.3 passed (the caller's checks 0 to 12): check 13 caps the
// waiting and requested approvals, the approver must be a current member of the target conversation by the app's
// verified replay (else 403 `approval-unavailable` and no `apr`), then the record (id 32 random hex, the exact text,
// thread, conversation, client, person, `exp` = now + 600 s) is sealed (`names::APPROVALS`, written durably by
// `SealedStore`), `content.approval.requested` is in the chain, and only then the `apr` goes to the person's DM with
// the app (`AppSession::send_apr`).
//
// An answer counts only when it is a verified `apra` from that person in that app's DM (`ContentHooks`), for a known
// waiting id, with `h` equal to `ce_device::apr_hash` of the `apr` sent, before `exp`; anything else is ignored.
// `content.approval.answered` is written before the record changes. An approval is then settled off the app
// session's thread (the hook runs under the session's lock, and posting takes it again): the grant re-check
// against the current synced state (R5-12), then `content.approval.posted` (or `.refused` with the failed check),
// then exactly one `AppSession::post_dlg` with `dlg {client, person?, approval}`, its message id recorded. The
// `posting` state is sealed before the post, so a crash never posts twice: an approval posts at most once.

use crate::api_catalog::counters;
use crate::api_cjournal as cj;
use crate::api_map::effective_end;
use crate::api_resource::AuditLog;
use crate::api_token as tok;
use crate::ce_device as ce;
use crate::codec::hex;
use crate::connector::Connector;
use crate::connector_seal::names;
use crate::connector_session::AppSession;
use crate::connector_store::DAY_MS;
use crate::connector_sync::SyncState;
use crate::connector_view::{self as view, Ground, Who};
use crate::meet::{log_info, log_warn};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

/// 7.5: an approval waits this long.
pub const APPROVAL_LIFE_MS: i64 = 600_000;
/// 5.3 check 13 (R5-13): waiting approvals per (client, person).
pub const WAITING_PER_PERSON: usize = 3;
/// 5.3 check 13: waiting approvals per (client, conversation).
pub const WAITING_PER_CONV: usize = 1;
/// 5.3 check 13: approvals requested per (client, person) in a day.
pub const REQUESTED_PER_DAY: usize = 20;
/// 7.4 `apr.conv_name` is at most 100 characters.
const CONV_NAME_MAX: usize = 100;
/// The `check` of a re-check that found the approver outside the conversation (R5-19 at the re-check).
pub const CHECK_OWNER_MEMBER: &str = "approval-unavailable";

/// The states of an approval. `posting` is sealed just before the post, so it is never sent twice.
pub mod state {
    pub const WAITING: &str = "waiting";
    pub const APPROVED: &str = "approved";
    pub const DECLINED: &str = "declined";
    pub const EXPIRED: &str = "expired";
    pub const POSTING: &str = "posting";
    pub const POSTED: &str = "posted";
    pub const REFUSED: &str = "refused";
}

/// One approval (7.5). Sealed with the others; it names the text only inside the sealed store.
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub id: String,
    /// The client id (`c_`).
    pub client: String,
    /// The client's map `name` (the `apr` and `dlg` `client`).
    pub client_name: String,
    /// The token's `sub` (the person of a delegated token, else the client id): only that caller reads it back.
    pub sub: String,
    /// Who approves: the delegated person, or the client's `owner`.
    pub person: String,
    /// The post is for the delegated person (`dlg.person`).
    pub delegated: bool,
    /// The app (its config name) whose DM carries the `apr` and that posts.
    pub app: String,
    pub conv: String,
    pub thread: String,
    pub text: String,
    /// The effective ceiling of the asking token (the re-check never goes above it).
    pub ceiling: String,
    pub requested: i64,
    pub exp: i64,
    /// The `apr` as sent (its hash is what the answer must name).
    pub apr: Value,
    pub state: String,
    pub mid: Option<String>,
    /// The failed check of a `refused` approval (409 `approval-refused`).
    pub check: Option<String>,
}

impl Approval {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id, "client": self.client, "client_name": self.client_name, "sub": self.sub, "person": self.person, "delegated": self.delegated,
            "app": self.app, "conv": self.conv, "thread": self.thread, "text": self.text, "ceiling": self.ceiling, "requested": self.requested,
            "exp": self.exp, "apr": self.apr, "state": self.state, "mid": self.mid, "check": self.check,
        })
    }

    fn from_value(v: &Value) -> Option<Approval> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Approval {
            id: s("id")?,
            client: s("client")?,
            client_name: s("client_name")?,
            sub: s("sub")?,
            person: s("person")?,
            delegated: v.get("delegated").and_then(Value::as_bool)?,
            app: s("app")?,
            conv: s("conv")?,
            thread: s("thread").unwrap_or_default(),
            text: s("text")?,
            ceiling: s("ceiling")?,
            requested: v.get("requested").and_then(Value::as_i64)?,
            exp: v.get("exp").and_then(Value::as_i64)?,
            apr: v.get("apr").filter(|a| a.is_object()).cloned()?,
            state: s("state")?,
            mid: s("mid"),
            check: s("check"),
        })
    }

    /// The state a caller sees: a waiting approval past `exp` is expired.
    pub fn state_at(&self, now_ms: i64) -> &str {
        if self.state == state::WAITING && now_ms >= self.exp {
            state::EXPIRED
        } else {
            &self.state
        }
    }
}

/// What asks for an approval (the caller passed 5.3 checks 0 to 12).
pub struct Ask<'a> {
    pub client: &'a str,
    pub client_name: &'a str,
    pub sub: &'a str,
    pub person: &'a str,
    pub delegated: bool,
    /// The session that serves the conversation (5.2).
    pub session: &'a AppSession,
    pub conv: &'a str,
    pub thread: &'a str,
    pub text: &'a str,
    pub ceiling: &'a str,
}

/// A request the approvals refused: status, `code`, sentence and, for check 13, `Retry-After` seconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub why: &'static str,
    pub retry: Option<i64>,
}

fn refusal(status: u16, code: &'static str, why: &'static str) -> Refusal {
    Refusal { status, code, why, retry: None }
}

struct Inner {
    conn: Arc<Connector>,
    sync: Arc<SyncState>,
    audit: Arc<dyn AuditLog>,
    recs: Mutex<Vec<Approval>>,
    /// Settling runs one at a time (whichever thread comes first posts; the others find it done).
    settling: Mutex<()>,
}

/// The connector's approvals (7.5).
pub struct Approvals {
    inner: Arc<Inner>,
}

fn random_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    aws_lc_rs::rand::fill(&mut b).map_err(|_| "no random bytes for an approval id".to_string())?;
    Ok(hex(&b))
}

impl Inner {
    fn org(&self) -> String {
        self.sync.org().to_string()
    }

    fn save(&self, recs: &[Approval]) -> Result<(), String> {
        let v = json!({"approvals": recs.iter().map(Approval::to_value).collect::<Vec<_>>()});
        self.conn.shared.sealed.put(names::APPROVALS, &v)
    }

    fn record(&self, action: &str, a: &Approval, extra: &[(&str, Value)], now_ms: i64) -> bool {
        let mut e = json!({"action": action, "client": a.client, "person": a.person, "conv": a.conv, "approval": a.id});
        for (k, v) in extra {
            e[*k] = v.clone();
        }
        match self.audit.record(&self.org(), e, now_ms.div_euclid(1000)) {
            Ok(_) => true,
            Err(err) => {
                log_warn(&format!("connector_approval_not_audited action={action} error={err}"));
                false
            }
        }
    }

    /// Set the state of `id` (and its mid or check) and seal the list. False when it could not be sealed.
    fn set(&self, id: &str, f: impl FnOnce(&mut Approval)) -> bool {
        let mut recs = self.recs.lock();
        let Some(i) = recs.iter().position(|a| a.id == id) else { return false };
        let before = recs[i].clone();
        f(&mut recs[i]);
        if let Err(e) = self.save(&recs) {
            log_warn(&format!("connector_approval_not_sealed error={e}"));
            recs[i] = before;
            return false;
        }
        true
    }

    /// R5-12: the grant re-check against the current synced state; Ok is the session that posts, Err the failed check.
    fn recheck(&self, a: &Approval, now_ms: i64) -> Result<Arc<AppSession>, String> {
        if !self.sync.fresh(now_ms) {
            return Err("connector-stale".into());
        }
        let g = Ground::of(&self.conn, &self.sync, now_ms);
        let now_s = now_ms.div_euclid(1000);
        let Some(c) = g.client(&a.client) else { return Err("client".into()) };
        let suspended = c.get("state").and_then(Value::as_str) != Some("active") || g.active().iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(a.client.as_str()));
        if suspended {
            return Err("suspended".into());
        }
        let end = effective_end(c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN), &[g.store.grace_hours(&g.org, "app", now_s)]);
        if now_s > end {
            return Err("expired".into());
        }
        if !g.owner_active(c.get("owner").and_then(Value::as_str).unwrap_or_default()) {
            return Err("owner".into());
        }
        let dropped = tok::client_entries(g.active(), "client_drop_scope", &a.client).any(|e| tok::target_field(e, "scope") == "content.post");
        if dropped || !tok::names(c, "scopes").any(|s| s == "content.post") {
            return Err("scope".into());
        }
        let kind = c.get("kind").and_then(Value::as_str).unwrap_or_default();
        if a.delegated {
            let denied = c.get("delegation").and_then(|d| d.get("denied")).and_then(Value::as_array).into_iter().flatten().any(|p| p.as_str().is_some_and(|p| p.eq_ignore_ascii_case(&a.person)));
            if denied || cj::person_revoked(&g.console, &a.client, &a.person) || self.sync.locally_denied(&a.client, &a.person) {
                return Err("person".into());
            }
        }
        let lowered = view::client_ceiling(&g, &a.client, c);
        let ceiling = if tok::rank(lowered) < tok::rank(&a.ceiling) { lowered } else { a.ceiling.as_str() };
        let who = Who { id: &a.client, client: c, kind, person: a.delegated.then_some(a.person.as_str()), ceiling };
        let s = view::visible(&self.conn, &g, &who, &a.conv).map_err(str::to_string)?;
        if !a.delegated && !s.is_member(&a.conv, &a.person) {
            return Err(CHECK_OWNER_MEMBER.into());
        }
        Ok(s)
    }

    /// Settle every approved approval: re-check, audit, then post once.
    fn settle(&self, now_ms: i64) {
        let _one = self.settling.lock();
        let due: Vec<Approval> = self.recs.lock().iter().filter(|a| a.state == state::APPROVED).cloned().collect();
        for a in due {
            match self.recheck(&a, now_ms) {
                Err(check) => {
                    if self.record("content.approval.refused", &a, &[("check", json!(check))], now_ms) {
                        self.set(&a.id, |r| {
                            r.state = state::REFUSED.into();
                            r.check = Some(check.clone());
                        });
                    }
                }
                Ok(s) => {
                    if !self.record("content.approval.posted", &a, &[], now_ms) || !self.set(&a.id, |r| r.state = state::POSTING.into()) {
                        continue;
                    }
                    let mut dlg = json!({"client": a.client_name, "approval": a.id});
                    if a.delegated {
                        dlg["person"] = json!(a.person);
                    }
                    match s.post_dlg(&a.conv, &a.text, &a.thread, &dlg, now_ms) {
                        Ok(v) => {
                            let mid = v.get("id").and_then(Value::as_str).map(str::to_string);
                            self.set(&a.id, |r| {
                                r.state = state::POSTED.into();
                                r.mid = mid;
                            });
                        }
                        Err(e) => {
                            log_warn(&format!("connector_approval_post_failed approval={} error={e}", a.id));
                            self.set(&a.id, |r| {
                                r.state = state::REFUSED.into();
                                r.check = Some("post".into());
                            });
                        }
                    }
                }
            }
        }
    }
}

impl Approvals {
    pub fn open(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<dyn AuditLog>) -> Result<Approvals, String> {
        let held = conn.shared.sealed.get(names::APPROVALS)?;
        let recs: Vec<Approval> = held.as_ref().and_then(|v| v.get("approvals")).and_then(Value::as_array).into_iter().flatten().filter_map(Approval::from_value).collect();
        Ok(Approvals { inner: Arc::new(Inner { conn, sync, audit, recs: Mutex::new(recs), settling: Mutex::new(()) }) })
    }

    /// One approval by id.
    pub fn get(&self, id: &str) -> Option<Approval> {
        self.inner.recs.lock().iter().find(|a| a.id == id).cloned()
    }

    /// 5.3 check 13 for (client, person, conversation): Err is `Retry-After` seconds.
    fn caps(recs: &[Approval], client: &str, person: &str, conv: &str, now_ms: i64) -> Result<(), i64> {
        let waiting: Vec<&Approval> = recs.iter().filter(|a| a.client == client && a.state == state::WAITING && a.exp > now_ms).collect();
        let wait_of = |list: Vec<&&Approval>| list.iter().map(|a| a.exp).min().map_or(1, |e| (e - now_ms).div_euclid(1000).max(1));
        let mine: Vec<&&Approval> = waiting.iter().filter(|a| a.person == person).collect();
        if mine.len() >= WAITING_PER_PERSON {
            return Err(wait_of(mine));
        }
        let here: Vec<&&Approval> = waiting.iter().filter(|a| a.conv == conv).collect();
        if here.len() >= WAITING_PER_CONV {
            return Err(wait_of(here));
        }
        let day: Vec<i64> = recs.iter().filter(|a| a.client == client && a.person == person && now_ms - a.requested < DAY_MS).map(|a| a.requested).collect();
        if day.len() >= REQUESTED_PER_DAY {
            let oldest = day.iter().copied().min().unwrap_or(now_ms);
            return Err((oldest + DAY_MS - now_ms).div_euclid(1000).max(1));
        }
        Ok(())
    }

    /// 7.5 step 1 after 5.3 checks 0 to 12: check 13 (429 `approvals`), R5-19 (403 `approval-unavailable`, no
    /// `apr`), then the sealed record, `content.approval.requested` and the `apr`.
    pub fn request(&self, ask: &Ask, now_ms: i64) -> Result<Approval, Refusal> {
        let inner = &self.inner;
        // the session is read before the records are locked: the hooks take the records under the session's lock
        let member = ask.session.is_member(ask.conv, ask.person);
        let conv_name: String = ask.session.conversations().into_iter().find(|c| c.cid == ask.conv).map(|c| c.name).filter(|n| !n.is_empty()).unwrap_or_else(|| "a conversation".into());
        let mut recs = inner.recs.lock();
        if let Err(s) = Approvals::caps(&recs, ask.client, ask.person, ask.conv, now_ms) {
            return Err(Refusal { retry: Some(s), ..refusal(429, "approvals", "Too many approvals are waiting or were asked for; see Retry-After.") });
        }
        if !member {
            return Err(refusal(403, "approval-unavailable", "The person who must approve this post is not a member of that conversation."));
        }
        let id = random_id().map_err(|_| refusal(503, "unavailable", "The approval could not be made now; try again later."))?;
        let exp = now_ms + APPROVAL_LIFE_MS;
        let apr = json!({"id": id, "client": ask.client_name, "agent": ask.client_name, "action": "post", "conv": ask.conv,
                         "conv_name": conv_name.chars().take(CONV_NAME_MAX).collect::<String>(), "thread": ask.thread, "text": ask.text, "exp": exp});
        if ce::check_apr(&apr).is_err() {
            return Err(refusal(400, "bad-request", "That post cannot be put to an approval."));
        }
        let a = Approval {
            id: id.clone(),
            client: ask.client.into(),
            client_name: ask.client_name.into(),
            sub: ask.sub.into(),
            person: ask.person.into(),
            delegated: ask.delegated,
            app: ask.session.app.clone(),
            conv: ask.conv.into(),
            thread: ask.thread.into(),
            text: ask.text.into(),
            ceiling: ask.ceiling.into(),
            requested: now_ms,
            exp,
            apr: apr.clone(),
            state: state::WAITING.into(),
            mid: None,
            check: None,
        };
        recs.push(a.clone());
        if let Err(e) = inner.save(&recs) {
            recs.pop();
            log_warn(&format!("connector_approval_not_sealed error={e}"));
            return Err(refusal(503, "unavailable", "The approval could not be kept now; try again later."));
        }
        if !inner.record("content.approval.requested", &a, &[], now_ms) {
            recs.pop();
            let _ = inner.save(&recs);
            return Err(refusal(503, "audit-unavailable", "The audit log cannot record this request now; try again later."));
        }
        drop(recs);
        counters::content_approval(&inner.org(), "requested");
        if let Err(e) = ask.session.send_apr(ask.person, &apr, now_ms) {
            log_warn(&format!("connector_apr_not_sent approval={id} error={e}"));
            inner.set(&id, |r| r.state = state::EXPIRED.into());
            counters::content_approval(&inner.org(), "expired");
            return Err(refusal(503, "unavailable", "The approval request could not reach the person's devices; try again later."));
        }
        Ok(a)
    }

    /// The `ContentHooks::approval_answer` call (verified apra from `person` in the app's DM).
    pub fn answer(&self, app: &str, person: &str, mid: &str, apra: &Value, now_ms: i64) {
        let inner = &self.inner;
        let id = apra.get("id").and_then(Value::as_str).unwrap_or_default();
        let ok = apra.get("ok").and_then(Value::as_bool);
        let h = apra.get("h").and_then(Value::as_str).unwrap_or_default();
        let found = inner.recs.lock().iter().find(|a| a.id == id).cloned();
        let matches = found.as_ref().is_some_and(|a| {
            a.state == state::WAITING && a.app == app && a.person.eq_ignore_ascii_case(person) && now_ms < a.exp && ce::apr_hash(&a.apr).is_ok_and(|want| want == h)
        });
        let (Some(a), Some(ok), true) = (found, ok, matches) else {
            log_info(&format!("connector_apra_ignored app={app} mid={mid}"));
            return;
        };
        let result = if ok { "approved" } else { "declined" };
        if !inner.record("content.approval.answered", &a, &[("result", json!(result))], now_ms) {
            return;
        }
        counters::content_approval(&inner.org(), result);
        if !inner.set(&a.id, |r| r.state = if ok { state::APPROVED.into() } else { state::DECLINED.into() }) || !ok {
            return;
        }
        // off the session's thread: the hook holds the session, and posting takes it again
        let worker = inner.clone();
        if let Err(e) = std::thread::Builder::new().name("connector-approval".into()).spawn(move || worker.settle(now_ms)) {
            log_warn(&format!("connector_approval_not_settled error={e}"));
        }
    }

    /// Settle every approved approval now (the worker `answer` starts does the same; `tick` catches up); tests use it
    /// to wait for that worker.
    #[cfg(test)]
    pub(crate) fn settle(&self, now_ms: i64) {
        self.inner.settle(now_ms);
    }

    /// The `ContentHooks::person_stop` call (`client` is the client name the `stop` carries).
    pub fn person_stop(&self, app: &str, person: &str, client: &str, mid: &str, now_ms: i64) {
        let inner = &self.inner;
        let store = inner.sync.store();
        let org = inner.org();
        let id = store.clients(&org).iter().find(|c| c.get("name").and_then(Value::as_str) == Some(client)).and_then(|c| c.get("id")).and_then(Value::as_str).map(str::to_string);
        let Some(id) = id else {
            log_info(&format!("connector_stop_unknown_client app={app} client={client}"));
            return;
        };
        if let Err(e) = inner.sync.person_stopped(&id, person, mid) {
            log_warn(&format!("connector_stop_not_kept client={id} error={e}"));
            return;
        }
        let e = json!({"action": "content.person.stopped", "client": id, "person": person});
        if let Err(err) = inner.audit.record(&org, e, now_ms.div_euclid(1000)) {
            log_warn(&format!("connector_stop_not_audited error={err}"));
        }
    }

    /// Expiry (at least every 30 s, by the listener glue): waiting approvals past `exp` expire
    /// (`content.approval.answered` result `expired`), approved ones not yet settled are settled, and finished ones
    /// leave a day after their `exp`.
    pub fn tick(&self, now_ms: i64) {
        let inner = &self.inner;
        let due: Vec<Approval> = inner.recs.lock().iter().filter(|a| a.state == state::WAITING && now_ms >= a.exp).cloned().collect();
        for a in due {
            if inner.record("content.approval.answered", &a, &[("result", json!("expired"))], now_ms) {
                counters::content_approval(&inner.org(), "expired");
                inner.set(&a.id, |r| r.state = state::EXPIRED.into());
            }
        }
        inner.settle(now_ms);
        let mut recs = inner.recs.lock();
        let before = recs.len();
        recs.retain(|a| a.state == state::WAITING || a.state == state::APPROVED || now_ms < a.exp + DAY_MS);
        if recs.len() != before {
            if let Err(e) = inner.save(&recs) {
                log_warn(&format!("connector_approvals_not_sealed error={e}"));
            }
        }
    }

    /// The exact `apr` sent for approval `id` (tests build the person's `apra` from it).
    #[cfg(test)]
    pub(crate) fn apr_for_test(&self, id: &str) -> Option<Value> {
        self.get(id).map(|a| a.apr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector_api::tests::{path, Fx, AGENT, APPC, BEN, DELEGATED, INTERNAL};
    use crate::connector_session::tests::APP;

    fn apra(apr: &Value, ok: bool) -> Value {
        ce::make_apra(apr, ok).unwrap()["apra"].clone()
    }

    fn ask(fx: &Fx, token: &str, cid: &str, text: &str, key: &str, at: i64) -> String {
        let got = fx.post(token, cid, text, key, at);
        assert_eq!(got.status, 202, "{:?}", got.json());
        assert_eq!(got.json()["approval"]["state"], "waiting");
        got.json()["approval"]["id"].as_str().unwrap().to_string()
    }

    fn get_approval(fx: &Fx, token: &str, id: &str, at: i64) -> crate::connector_api::Answer {
        fx.call("GET", &path(&format!("content/approvals/{id}")), "", Some(token), None, None, at)
    }

    /// r5 18 approvals: an `apra` from another person, from the person's DM with another app, with a wrong `h` (a
    /// changed text), after `exp`, or a second time does not post; the person's own answer posts exactly once with
    /// the `dlg` label and the retry returns the message.
    #[test]
    fn only_the_persons_matching_answer_before_exp_posts_once() {
        let fx = Fx::new();
        let (a, _, _) = fx.room("apr1", true);
        let ann = fx.w.ann_p.clone();
        let now = fx.w.now;
        let t = fx.token(DELEGATED, Some(ann.as_str()));
        let dms = fx.dm_posts();
        let id = ask(&fx, &t, &a, "Ship it", "k1", now);
        assert_eq!(fx.dm_posts(), dms + 1, "the apr went to the person's DM");
        let apr = fx.approvals.apr_for_test(&id).unwrap();
        assert_eq!((apr["text"].as_str(), apr["client"].as_str(), apr["conv"].as_str()), (Some("Ship it"), Some("claude-ops"), Some(a.as_str())));
        assert_eq!(apr["exp"], json!(now + APPROVAL_LIFE_MS));
        fx.approvals.answer(APP, BEN, "m1", &apra(&apr, true), now);
        fx.approvals.answer("other-app", &ann, "m2", &apra(&apr, true), now);
        let mut changed = apr.clone();
        changed["text"] = json!("Ship it now");
        fx.approvals.answer(APP, &ann, "m3", &apra(&changed, true), now);
        fx.approvals.answer(APP, &ann, "m4", &apra(&apr, true), now + APPROVAL_LIFE_MS);
        fx.approvals.settle(now);
        assert_eq!(fx.approvals.get(&id).unwrap().state, state::WAITING);
        assert_eq!(fx.channel_posts(), 0);
        assert_eq!(get_approval(&fx, &t, &id, now).json()["state"], "waiting");
        fx.approvals.answer(APP, &ann, "m5", &apra(&apr, true), now + 1000);
        fx.approvals.settle(now + 1000);
        assert_eq!(fx.approvals.get(&id).unwrap().state, state::POSTED);
        assert_eq!(fx.channel_posts(), 1);
        fx.approvals.answer(APP, &ann, "m6", &apra(&apr, true), now + 2000);
        fx.approvals.settle(now + 2000);
        fx.approvals.tick(now + 2000);
        assert_eq!(fx.channel_posts(), 1, "an approval posts at most once");
        let got = get_approval(&fx, &t, &id, now + 3000);
        assert_eq!(got.status, 200, "{:?}", got.json());
        let m = &got.json()["message"];
        assert_eq!((got.json()["state"].as_str(), m["text"].as_str(), m["via"]["client"].as_str()), (Some("posted"), Some("Ship it"), Some("claude-ops")));
        assert_eq!(m["via"]["person"], crate::connector_view::face_id(&Fx::keys(&[DELEGATED])[DELEGATED], &ann));
        assert_eq!(get_approval(&fx, &fx.token(DELEGATED, Some(BEN)), &id, now + 3000).status, 404, "only the person that asked");
        assert_eq!(get_approval(&fx, &fx.token(APPC, None), &id, now + 3000).status, 404, "only the client that asked");
        let page = fx.call("GET", &path(&format!("content/approvals/{id}/page")), "", None, None, None, now + 3000);
        assert!(String::from_utf8(page.body).unwrap().contains("<p>done</p>"));
        let actions = fx.chain.actions();
        for x in ["content.approval.requested", "content.approval.answered", "content.approval.posted"] {
            assert_eq!(actions.iter().filter(|y| *y == x).count(), 1, "{x}");
        }
        assert!(fx.chain.clean_of("Ship it", "ops"), "no text in the chain");
        // O4: the app's DM with the person never appears
        let list = fx.get(&t, "content/conversations", "");
        assert!(list.json()["conversations"].as_array().unwrap().iter().all(|c| c["cid"].as_str().unwrap().starts_with("ch:")));
    }

    #[test]
    fn declined_and_expired_approvals_answer_their_codes() {
        let fx = Fx::new();
        let (a, _, _) = fx.room("apr2", false);
        let (b, _, _) = fx.room("apr3", false);
        let ann = fx.w.ann_p.clone();
        let now = fx.w.now;
        let t = fx.token(DELEGATED, Some(ann.as_str()));
        // r5 13.1: `lucid_content_approvals_total` by result (other tests count in parallel: at least ours)
        let org = fx.approvals.inner.org();
        let count = |result: &str| {
            counters::rows(Some(&org), 0).into_iter().find(|r| r.prom == "lucid_content_approvals_total" && r.labels == [("result".to_string(), result.to_string())]).map_or(0.0, |r| r.value)
        };
        let before = ["requested", "declined", "expired"].map(count);
        let declined = ask(&fx, &t, &a, "no thanks", "k1", now);
        fx.approvals.answer(APP, &ann, "m1", &apra(&fx.approvals.apr_for_test(&declined).unwrap(), false), now);
        let got = get_approval(&fx, &t, &declined, now + 1000);
        assert_eq!((got.status, got.json()["code"].clone()), (403, json!("approval-declined")));
        let expired = ask(&fx, &t, &b, "too late", "k2", now);
        fx.approvals.tick(now + APPROVAL_LIFE_MS);
        let got = get_approval(&fx, &t, &expired, now + 1000);
        assert_eq!((got.status, got.json()["code"].clone()), (410, json!("approval-expired")));
        assert!(fx.chain.entries.lock().iter().any(|e| e["action"] == "content.approval.answered" && e["result"] == "expired"));
        assert_eq!(fx.channel_posts(), 0);
        let after = ["requested", "declined", "expired"].map(count);
        assert!(after[0] >= before[0] + 2.0 && after[1] >= before[1] + 1.0 && after[2] >= before[2] + 1.0, "{before:?} {after:?}");
    }

    /// R5-12: an approval answered after the client lost `content.post` is refused with `content.approval.refused`.
    #[test]
    fn the_grant_recheck_refuses_after_the_client_lost_content_post() {
        let mut fx = Fx::new();
        let (a, _, _) = fx.room("r512", false);
        let ann = fx.w.ann_p.clone();
        let now = fx.w.now;
        let id = ask(&fx, &fx.token(DELEGATED, Some(ann.as_str())), &a, "post later", "k1", now);
        let mut map = fx.map.clone();
        map["clients"][0]["scopes"] = json!(["content.read"]);
        fx.resync(map, Vec::new(), Fx::keys(&[DELEGATED, AGENT, APPC, INTERNAL]), now);
        let apr = fx.approvals.apr_for_test(&id).unwrap();
        fx.approvals.answer(APP, &ann, "m1", &apra(&apr, true), now + 1000);
        fx.approvals.settle(now + 1000);
        let got = fx.approvals.get(&id).unwrap();
        assert_eq!((got.state.as_str(), got.check.as_deref()), (state::REFUSED, Some("scope")));
        assert_eq!(fx.channel_posts(), 0);
        assert!(fx.chain.entries.lock().iter().any(|e| e["action"] == "content.approval.refused" && e["check"] == "scope"));
    }

    /// R5-13: a fourth waiting approval for the same person and client answers 429 `approvals` with `Retry-After`.
    #[test]
    fn a_fourth_waiting_approval_is_refused() {
        let fx = Fx::new();
        let rooms: Vec<String> = (0..4).map(|i| fx.room(&format!("cap{i}"), false).0).collect();
        let now = fx.w.now;
        let t = fx.token(DELEGATED, Some(fx.w.ann_p.as_str()));
        for (i, r) in rooms.iter().take(3).enumerate() {
            ask(&fx, &t, r, "please", &format!("k{i}"), now);
        }
        let dms = fx.dm_posts();
        let fourth = fx.post(&t, &rooms[3], "please", "k3", now);
        assert_eq!((fourth.status, fourth.json()["code"].clone()), (429, json!("approvals")));
        assert!(fourth.header("Retry-After").is_some_and(|s| s.parse::<i64>().unwrap() > 0));
        assert_eq!(fx.dm_posts(), dms, "no apr for a refused request");
        let second_here = fx.post(&t, &rooms[0], "again", "k4", now + 2000);
        assert_eq!(second_here.status, 429);
    }

    /// R5-19: a machine client's post into a conversation its owner is not in answers `approval-unavailable` and no
    /// `apr` is sent.
    #[test]
    fn an_owner_outside_the_conversation_gets_no_apr() {
        let fx = Fx::new();
        let (a, _, _) = fx.room("own", false);
        let dms = fx.dm_posts();
        let got = fx.post(&fx.token(AGENT, None), &a, "machine words", "k1", fx.w.now);
        assert_eq!((got.status, got.json()["code"].clone()), (403, json!("approval-unavailable")));
        assert_eq!(fx.dm_posts(), dms);
        assert!(fx.chain.entries.lock().iter().any(|e| e["action"] == "api.refusal" && e["check"] == "approval-unavailable"));
        assert!(!fx.chain.actions().contains(&"content.approval.requested".to_string()));
    }

    /// R5-25: two people using one client with the same `Idempotency-Key` both post; each replay is the person's own.
    #[test]
    fn two_people_with_one_key_both_post() {
        let fx = Fx::new();
        let (a, _, _) = fx.room("r525", true);
        let ann = fx.w.ann_p.clone();
        let now = fx.w.now;
        let (ta, tb) = (fx.token(DELEGATED, Some(ann.as_str())), fx.token(DELEGATED, Some(BEN)));
        let first = ask(&fx, &ta, &a, "same words", "same-key", now);
        fx.approvals.answer(APP, &ann, "m1", &apra(&fx.approvals.apr_for_test(&first).unwrap(), true), now + 500);
        fx.approvals.settle(now + 500);
        let second = ask(&fx, &tb, &a, "same words", "same-key", now + 1500);
        assert_ne!(first, second, "another person's request is never a replay");
        fx.approvals.answer(APP, BEN, "m2", &apra(&fx.approvals.apr_for_test(&second).unwrap(), true), now + 2000);
        fx.approvals.settle(now + 2000);
        assert_eq!(fx.channel_posts(), 2);
        let again = fx.post(&ta, &a, "same words", "same-key", now + 3000);
        assert_eq!((again.status, again.json()["approval"]["id"].as_str(), again.json()["approval"]["state"].as_str()), (202, Some(first.as_str()), Some("posted")));
        assert_eq!(fx.channel_posts(), 2, "a replay posts nothing");
        let other = fx.post(&ta, &a, "other words", "same-key", now + 4000);
        assert_eq!((other.status, other.json()["code"].clone()), (409, json!("idempotency")));
        assert!(fx.chain.entries.lock().iter().any(|e| e["action"] == "api.call" && e["result"] == "replayed"));
    }

    /// 7.6: the person's Stop denies the client at once and is audited.
    #[test]
    fn a_stop_denies_the_person_at_once() {
        let fx = Fx::new();
        fx.room("stop", true);
        fx.approvals.person_stop(APP, BEN, "claude-ops", "m1", fx.w.now);
        assert!(fx.sync.locally_denied(DELEGATED, BEN));
        assert!(fx.chain.entries.lock().iter().any(|e| e["action"] == "content.person.stopped" && e["client"] == DELEGATED && e["person"] == BEN));
        let got = fx.get(&fx.token(DELEGATED, Some(BEN)), "content/conversations", "");
        assert_eq!((got.status, got.json()["code"].clone()), (403, json!("person")));
        assert_eq!(fx.get(&fx.token(DELEGATED, Some(fx.w.ann_p.as_str())), "content/conversations", "").status, 200);
    }

    #[test]
    fn records_round_trip_and_caps_count() {
        let a = Approval {
            id: "ab".repeat(16),
            client: DELEGATED.into(),
            client_name: "claude-ops".into(),
            sub: "ann@acme.test".into(),
            person: "ann@acme.test".into(),
            delegated: true,
            app: APP.into(),
            conv: "ch:x".into(),
            thread: String::new(),
            text: "t".into(),
            ceiling: "internal".into(),
            requested: 10,
            exp: 10 + APPROVAL_LIFE_MS,
            apr: json!({"id": "ab".repeat(16)}),
            state: state::WAITING.into(),
            mid: None,
            check: None,
        };
        assert_eq!(Approval::from_value(&a.to_value()), Some(a.clone()));
        assert_eq!(a.state_at(a.exp), state::EXPIRED);
        let recs: Vec<Approval> = (0..3).map(|i| Approval { id: format!("{i}"), conv: format!("ch:{i}"), ..a.clone() }).collect();
        assert!(Approvals::caps(&recs, DELEGATED, "ann@acme.test", "ch:9", 20).is_err(), "three waiting for the person");
        assert!(Approvals::caps(&recs[..1], DELEGATED, "ben@acme.test", "ch:0", 20).is_err(), "one waiting in the conversation");
        assert!(Approvals::caps(&recs[..1], DELEGATED, "ben@acme.test", "ch:1", 20).is_ok());
        let day: Vec<Approval> = (0..REQUESTED_PER_DAY).map(|i| Approval { id: format!("{i}"), state: state::POSTED.into(), ..a.clone() }).collect();
        assert!(Approvals::caps(&day, DELEGATED, "ann@acme.test", "ch:9", 20).is_err(), "twenty a day");
    }
}
