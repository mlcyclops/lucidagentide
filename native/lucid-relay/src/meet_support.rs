// SE-1 (MeetingHubaddon docs/support/contract.md 7; workspace ADR-0345): Meeting Hub support tickets kept by the
// org's relay for its Lucid Meet Admin Console. The Hub's built-in support engineer helps the person first; when the
// case needs a person, the Hub files it here with its device certificate (`POST /v1/support/tickets`), and reads the
// admins' answers on its own tickets (`GET /v1/support/tickets`). The console's Support page (`meet/support`, Admin;
// through the fleet proxy as every `meet/*` route) lists the tickets, answers and closes them.
//
// The record is API-1e 2.1 in small (docs/api/contract-r7-1e.md): plain text only, the person's own words, which the
// Hub's engineer redacted and the person read before sending; never chat or meeting content. One file per relay state
// folder, `support-tickets.json`, owner-only. Limits: 20 open tickets per person, 30 filings an hour per person,
// 200 messages and 20,000 characters per message, 1000 tickets kept (closed ones first out, and every closed ticket
// after 90 days).

use crate::console::{ApiError, SectionAnswer, SectionCall};
use crate::meet::{self as m, Identity, Relay, E, R};
use crate::meet_json::{self as pj, obj, Obj};
use crate::store::{read_text, write_private};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub const SUPPORT_FILE: &str = "support-tickets.json";
const TITLE_MAX: usize = 200;
const TEXT_MAX: usize = 20_000;
const VERSION_MAX: usize = 40;
const OPEN_PER_PERSON: usize = 20;
const FILED_PER_HOUR: usize = 30;
const MESSAGES_MAX: usize = 200;
const KEPT_MAX: usize = 1000;
const LIST_MAX: usize = 200;
const HOUR_MS: i64 = 3_600_000;
const KEEP_CLOSED_MS: i64 = 90 * 24 * HOUR_MS;
pub const STATES: [&str; 3] = ["open", "answered", "closed"];

const NO_TICKET: &str = "There is no such ticket.";
const NOT_A_PERSON: &str = "Only a person's own device files support tickets.";

/// The tickets of one relay state folder.
#[derive(Default)]
pub struct Store {
    path: Option<PathBuf>,
    loaded: bool,
    tickets: Vec<Obj>,
}

static STORES: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<Store>>>>> = std::sync::LazyLock::new(Default::default);

/// The store of this relay's state folder (shared by the main port's device routes and its console section).
pub fn store(relay: &Relay) -> Arc<Mutex<Store>> {
    let dir = relay.settings.state_dir.clone();
    STORES
        .lock()
        .entry(dir)
        .or_insert_with(|| Arc::new(Mutex::new(Store::at(m::state_file(&relay.settings, SUPPORT_FILE)))))
        .clone()
}

fn now_ms() -> i64 {
    (pj::now() * 1000.0) as i64
}

fn s<'a>(o: &'a Obj, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn i(o: &Obj, k: &str) -> i64 {
    o.get(k).and_then(Value::as_i64).unwrap_or_default()
}

fn case_ok(c: &str) -> bool {
    c.len() == 14 && c.starts_with("c_") && c[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn ticket_id_ok(c: &str) -> bool {
    c.len() == 18 && c.starts_with("q_") && c[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Plain text of 1 to `max` characters (counted as chars), trimmed; `one_line` refuses line breaks.
fn text(v: Option<&Value>, what: &str, max: usize, one_line: bool) -> Result<String, String> {
    let t = v.and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if t.is_empty() {
        return Err(format!("{what} is required."));
    }
    if t.chars().count() > max {
        return Err(format!("{what} is at most {max} characters."));
    }
    if t.chars().any(|c| c.is_control() && c != '\n' && c != '\t') || (one_line && t.contains('\n')) {
        return Err(format!("{what} is plain text{}.", if one_line { " on one line" } else { "" }));
    }
    Ok(t.to_string())
}

fn message(seq: usize, by: &str, who: &str, txt: &str, t: i64) -> Value {
    json!({"seq": seq, "ts": t, "by": by, "who": who, "text": txt})
}

impl Store {
    pub fn at(path: Option<PathBuf>) -> Store {
        Store { path, loaded: false, tickets: Vec::new() }
    }

    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        if let Some(text) = self.path.as_deref().and_then(read_text) {
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
                self.tickets = o.get("tickets").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_object().cloned()).collect()).unwrap_or_default();
            }
        }
    }

    fn save(&mut self, t: i64) -> Result<(), String> {
        self.sweep(t);
        let Some(path) = self.path.as_deref() else { return Ok(()) };
        let doc = json!({"v": 1, "tickets": self.tickets});
        write_private(path, format!("{doc}\n").as_bytes()).map_err(|e| format!("{SUPPORT_FILE} cannot be written: {e}"))
    }

    /// Closed tickets go after 90 days; past `KEPT_MAX` the oldest closed ones go first, then the oldest of any.
    fn sweep(&mut self, t: i64) {
        self.tickets.retain(|x| !(s(x, "state") == "closed" && t - i(x, "updated") > KEEP_CLOSED_MS));
        while self.tickets.len() > KEPT_MAX {
            let closed = self.tickets.iter().enumerate().filter(|(_, x)| s(x, "state") == "closed").min_by_key(|(_, x)| i(x, "updated")).map(|(n, _)| n);
            let at = closed.or_else(|| self.tickets.iter().enumerate().min_by_key(|(_, x)| i(x, "updated")).map(|(n, _)| n));
            match at {
                Some(n) => {
                    self.tickets.remove(n);
                }
                None => break,
            }
        }
    }

    /// A person's filing: a new ticket, or, for a case they filed before and did not see closed, its text added to
    /// that ticket (which reopens it). `{ok, id, appended}`.
    pub fn file(&mut self, principal: &str, name: &str, device: &str, b: &Obj, t: i64) -> Result<Obj, (u16, String)> {
        self.load();
        let bad = |w: String| (400u16, w);
        let case = b.get("case").and_then(Value::as_str).filter(|c| case_ok(c)).ok_or_else(|| bad("case is a support case id (c_ and 12 hex digits).".into()))?;
        let title = text(b.get("title"), "title", TITLE_MAX, true).map_err(bad)?;
        let body = text(b.get("body"), "body", TEXT_MAX, false).map_err(bad)?;
        let version = match b.get("version") {
            None | Some(Value::Null) => String::new(),
            v => text(v, "version", VERSION_MAX, true).map_err(bad)?,
        };
        let mine = |x: &&Obj| s(x, "principal") == principal;
        let recent: usize = self
            .tickets
            .iter()
            .filter(mine)
            .flat_map(|x| x.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
            .filter(|msg| msg.get("by").and_then(Value::as_str) == Some("member") && t - msg.get("ts").and_then(Value::as_i64).unwrap_or_default() < HOUR_MS)
            .count();
        if recent >= FILED_PER_HOUR {
            return Err((429, "Too many support filings in the last hour. Try again later.".into()));
        }
        if let Some(x) = self.tickets.iter_mut().find(|x| s(x, "principal") == principal && s(x, "case") == case && s(x, "state") != "closed") {
            let msgs = x.entry("messages").or_insert_with(|| json!([])).as_array_mut().ok_or_else(|| (500u16, "malformed ticket".to_string()))?;
            if msgs.len() >= MESSAGES_MAX {
                return Err((409, "This ticket is full. Close it and open a new case.".into()));
            }
            let seq = msgs.len() + 1;
            msgs.push(message(seq, "member", principal, &body, t));
            x.insert("state".into(), Value::from("open"));
            x.insert("updated".into(), Value::from(t));
            let id = s(x, "id").to_string();
            self.save(t).map_err(|e| (500u16, e))?;
            return Ok(obj([("ok", Value::Bool(true)), ("id", Value::from(id)), ("appended", Value::Bool(true))]));
        }
        if self.tickets.iter().filter(mine).filter(|x| s(x, "state") != "closed").count() >= OPEN_PER_PERSON {
            return Err((409, format!("You already have {OPEN_PER_PERSON} open support tickets. Wait for answers, or close some.")));
        }
        let id = format!("q_{}", pj::token_hex(8));
        let mut x = Obj::new();
        for (k, v) in [
            ("id", Value::from(id.as_str())),
            ("product", Value::from("meeting-hub")),
            ("principal", Value::from(principal)),
            ("name", Value::from(name)),
            ("device", Value::from(device)),
            ("case", Value::from(case)),
            ("title", Value::from(title)),
            ("version", Value::from(version)),
            ("state", Value::from("open")),
            ("created", Value::from(t)),
            ("updated", Value::from(t)),
            ("messages", json!([message(1, "member", principal, &body, t)])),
        ] {
            x.insert(k.into(), v);
        }
        self.tickets.push(x);
        self.save(t).map_err(|e| (500u16, e))?;
        Ok(obj([("ok", Value::Bool(true)), ("id", Value::from(id)), ("appended", Value::Bool(false))]))
    }

    /// The person's own tickets (one case's when `case` is set), newest first, with every message.
    pub fn mine(&mut self, principal: &str, case: &str) -> Obj {
        self.load();
        let mut list: Vec<Value> = self
            .tickets
            .iter()
            .filter(|x| s(x, "principal") == principal && (case.is_empty() || s(x, "case") == case))
            .map(|x| Value::Object(x.clone()))
            .collect();
        list.sort_by_key(|x| -x.get("updated").and_then(Value::as_i64).unwrap_or_default());
        obj([("ok", Value::Bool(true)), ("tickets", Value::Array(list))])
    }

    /// The console's list: `state` one of STATES or "all" (default: open and answered), newest first, at most 200.
    pub fn list(&mut self, state: &str) -> Result<Value, String> {
        self.load();
        if !state.is_empty() && state != "all" && !STATES.contains(&state) {
            return Err("state is open, answered, closed or all.".into());
        }
        let mut list: Vec<&Obj> = self
            .tickets
            .iter()
            .filter(|x| match state {
                "" => s(x, "state") != "closed",
                "all" => true,
                st => s(x, "state") == st,
            })
            .collect();
        list.sort_by_key(|x| -i(x, "updated"));
        let open = self.tickets.iter().filter(|x| s(x, "state") == "open").count();
        Ok(json!({"ok": true, "open": open, "tickets": list.into_iter().take(LIST_MAX).cloned().collect::<Vec<_>>()}))
    }

    /// Tickets waiting for an admin (state open).
    pub fn waiting(&mut self) -> usize {
        self.load();
        self.tickets.iter().filter(|x| s(x, "state") == "open").count()
    }

    /// An admin's answer: the ticket turns `answered` (the person's next filing on the case reopens it).
    pub fn answer(&mut self, id: &str, admin: &str, body: Option<&Value>, t: i64) -> Result<(), (u16, String)> {
        self.load();
        let txt = text(body, "text", TEXT_MAX, false).map_err(|w| (400u16, w))?;
        let x = self.tickets.iter_mut().find(|x| s(x, "id") == id).ok_or_else(|| (404u16, NO_TICKET.to_string()))?;
        if s(x, "state") == "closed" {
            return Err((409, "This ticket is closed.".into()));
        }
        let msgs = x.entry("messages").or_insert_with(|| json!([])).as_array_mut().ok_or_else(|| (500u16, "malformed ticket".to_string()))?;
        if msgs.len() >= MESSAGES_MAX {
            return Err((409, "This ticket is full.".into()));
        }
        let seq = msgs.len() + 1;
        msgs.push(message(seq, "admin", admin, &txt, t));
        x.insert("state".into(), Value::from("answered"));
        x.insert("updated".into(), Value::from(t));
        self.save(t).map_err(|e| (500u16, e))
    }

    /// An admin closes the ticket (the person sees it closed; a new filing on the case starts a new ticket).
    pub fn close(&mut self, id: &str, admin: &str, t: i64) -> Result<(), (u16, String)> {
        self.load();
        let x = self.tickets.iter_mut().find(|x| s(x, "id") == id).ok_or_else(|| (404u16, NO_TICKET.to_string()))?;
        if s(x, "state") == "closed" {
            return Err((409, "This ticket is already closed.".into()));
        }
        x.insert("state".into(), Value::from("closed"));
        x.insert("updated".into(), Value::from(t));
        x.insert("closed_by".into(), Value::from(admin));
        self.save(t).map_err(|e| (500u16, e))
    }
}

fn meet_e((code, words): (u16, String)) -> E {
    match code {
        400 => E::Bad(words),
        404 => E::NotFound(words),
        409 => E::Conflict(words),
        429 => E::Busy(words, 3600),
        _ => E::Internal(words),
    }
}

fn console_e((code, words): (u16, String)) -> ApiError {
    match code {
        400 => ApiError::with("invalid", words),
        404 => ApiError::with("not-found", words),
        409 => ApiError::with("conflict", words),
        _ => ApiError::with("write-failed", words),
    }
}

/// A person's own device: never a guest, a connector, an app, an archive or a sign-in service.
fn person(who: &Identity) -> R<()> {
    if who.guest || who.connector || !(who.kind.is_empty() || who.kind == "person") {
        return Err(E::Forbidden(NOT_A_PERSON.into()));
    }
    Ok(())
}

// ── the main port (device certificate) ─────────────────────────────────────────────────────────────────────────

/// `POST /v1/support/tickets {case, title, body, version?}`: file, or add to the same case's open ticket.
pub fn device_file(relay: &Relay, who: &Identity, b: &Obj) -> R<Obj> {
    person(who)?;
    let st = store(relay);
    let mut st = st.lock();
    st.file(&who.principal, &who.name, &who.serial, b, now_ms()).map_err(meet_e)
}

/// `GET /v1/support/tickets?case=`: the caller's own tickets.
pub fn device_mine(relay: &Relay, who: &Identity, case: &str) -> R<Obj> {
    person(who)?;
    if !case.is_empty() && !case_ok(case) {
        return Err(E::Bad("case is a support case id (c_ and 12 hex digits).".into()));
    }
    let st = store(relay);
    let mut st = st.lock();
    Ok(st.mine(&who.principal, case))
}

// ── the console section (Admin) ────────────────────────────────────────────────────────────────────────────────

/// `GET meet/support?state=` (the section checked the filters).
pub fn console_list(relay: &Relay, state: &str) -> Result<Value, ApiError> {
    let st = store(relay);
    let mut st = st.lock();
    st.list(state).map_err(|w| ApiError::with("invalid", w))
}

fn console_id(call: &SectionCall) -> Result<String, ApiError> {
    call.body.get("id").and_then(Value::as_str).filter(|x| ticket_id_ok(x)).map(str::to_string).ok_or_else(|| ApiError::with("invalid", "id is a ticket id (q_ and 16 hex digits)."))
}

/// `POST meet/support/answer {id, text}`.
pub fn console_answer(relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
    let id = console_id(call)?;
    let st = store(relay);
    let mut st = st.lock();
    st.answer(&id, &call.caller.email, call.body.get("text"), call.t).map_err(console_e)?;
    let chars = call.body.get("text").and_then(Value::as_str).map(|x| x.trim().chars().count()).unwrap_or_default();
    Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: id, detail: json!({"chars": chars}) })
}

/// `POST meet/support/close {id}`.
pub fn console_close(relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
    let id = console_id(call)?;
    let st = store(relay);
    let mut st = st.lock();
    st.close(&id, &call.caller.email, call.t).map_err(console_e)?;
    Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: id, detail: json!({}) })
}

/// Tickets waiting for an admin, for the attention list.
pub fn waiting(relay: &Relay) -> usize {
    store(relay).lock().waiting()
}

/// The store of a test folder (tests only).
#[cfg(test)]
pub fn test_store(dir: &std::path::Path) -> Store {
    Store::at(Some(dir.join(SUPPORT_FILE)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_795_000_000_000;

    fn filing(case: &str, body: &str) -> Obj {
        obj([("case", Value::from(case)), ("title", Value::from("Calls drop")), ("body", Value::from(body)), ("version", Value::from("0.98.7"))])
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-support-test-{}", pj::token_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_filing_opens_a_ticket_and_the_same_case_adds_to_it_until_closed() {
        let dir = tmp();
        let mut st = test_store(&dir);
        let first = st.file("ann@acme.example", "Ann", "0a1b", &filing("c_0123456789ab", "nobody is online"), T).unwrap();
        assert_eq!(first["appended"], false);
        let id = first["id"].as_str().unwrap().to_string();
        assert!(ticket_id_ok(&id));
        let again = st.file("ann@acme.example", "Ann", "0a1b", &filing("c_0123456789ab", "still offline"), T + 1).unwrap();
        assert_eq!((again["id"].as_str().unwrap(), again["appended"].as_bool().unwrap()), (id.as_str(), true));
        st.answer(&id, "admin@acme.example", Some(&Value::from("Import the invite again.")), T + 2).unwrap();
        let mine = st.mine("ann@acme.example", "c_0123456789ab");
        let t0 = &mine["tickets"][0];
        assert_eq!(t0["state"], "answered");
        assert_eq!(t0["messages"].as_array().unwrap().len(), 3);
        assert_eq!(t0["messages"][2]["by"], "admin");
        // another person never sees it
        assert!(st.mine("bob@acme.example", "").get("tickets").and_then(Value::as_array).unwrap().is_empty());
        // kept on disk, owner-only
        let mut back = test_store(&dir);
        assert_eq!(back.list("all").unwrap()["tickets"].as_array().unwrap().len(), 1);
        st.close(&id, "admin@acme.example", T + 3).unwrap();
        let fresh = st.file("ann@acme.example", "Ann", "0a1b", &filing("c_0123456789ab", "it is back"), T + 4).unwrap();
        assert_ne!(fresh["id"].as_str().unwrap(), id);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn filings_are_checked_and_limited() {
        let dir = tmp();
        let mut st = test_store(&dir);
        let bad = |b: Obj, st: &mut Store| st.file("ann@acme.example", "Ann", "0a1b", &b, T).unwrap_err().0;
        assert_eq!(bad(filing("../x", "a"), &mut st), 400);
        assert_eq!(bad(filing("c_0123456789ab", ""), &mut st), 400);
        let mut long_title = filing("c_0123456789ab", "a");
        long_title.insert("title".into(), Value::from("x".repeat(201)));
        assert_eq!(bad(long_title, &mut st), 400);
        let mut two_lines = filing("c_0123456789ab", "a");
        two_lines.insert("title".into(), Value::from("one\ntwo"));
        assert_eq!(bad(two_lines, &mut st), 400);
        for n in 0..OPEN_PER_PERSON {
            st.file("ann@acme.example", "Ann", "0a1b", &filing(&format!("c_{n:012x}"), "a"), T + n as i64).unwrap();
        }
        assert_eq!(st.file("ann@acme.example", "Ann", "0a1b", &filing("c_ffffffffffff", "a"), T + 100).unwrap_err().0, 409);
        // 30 filings an hour: 20 above, then 10 more on the same open case, then refused
        for n in 0..(FILED_PER_HOUR - OPEN_PER_PERSON) {
            st.file("ann@acme.example", "Ann", "0a1b", &filing("c_000000000000", "more"), T + 200 + n as i64).unwrap();
        }
        assert_eq!(st.file("ann@acme.example", "Ann", "0a1b", &filing("c_000000000000", "more"), T + 300).unwrap_err().0, 429);
        assert_eq!(st.waiting(), OPEN_PER_PERSON);
        assert_eq!(st.list("bogus").unwrap_err(), "state is open, answered, closed or all.");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn closed_tickets_leave_after_90_days() {
        let dir = tmp();
        let mut st = test_store(&dir);
        let id = st.file("ann@acme.example", "Ann", "0a1b", &filing("c_0123456789ab", "a"), T).unwrap()["id"].as_str().unwrap().to_string();
        st.close(&id, "admin@acme.example", T + 1).unwrap();
        st.file("bob@acme.example", "Bob", "0c1d", &filing("c_0123456789ab", "b"), T + KEEP_CLOSED_MS + 2).unwrap();
        let all = st.list("all").unwrap();
        assert_eq!(all["tickets"].as_array().unwrap().len(), 1);
        assert_eq!(all["tickets"][0]["principal"], "bob@acme.example");
        std::fs::remove_dir_all(dir).ok();
    }
}
