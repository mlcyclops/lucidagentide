// The relay side of every console request (contract AC-2a revision 3.2, 4.8 steps 3 to 8, F5): the scope the
// relay computes itself from its own table, the projection it serves (the `read-health` allowlists and the viewer-safe
// attention), the write gates (bootstrap, read only, profile), the WebAuthn assertions it verifies against its own
// roster over its own single-use nonces, confirm-here, and the run through the same `route` and `execute` as the
// local console (`Console::fleet_route`); then the relay's own audit (7.2): one `fleet.call` per write and refused
// write (60 a minute, then a summary), one `fleet.reads.summary` a minute. It also keeps the link's trust state live:
// running time and holds, the relay's attestation verdicts, device endorsements (F20), roster, policy and scope
// frames, the `state`, `attention` and `audit` events, and the operator's one-shot commands (fleet_local.rs).

use crate::codec::{exact_keys, is_int, str_of};
use crate::console::{AdminRule, ApiError, Caller, Console, Role, SectionAnswer, SectionCall};
use crate::console_audit::{canonical_json, Record};
use crate::fleet_local::{self, Effects, Outcome};
use crate::fleet_trust::{self as ft, EndorseCtx, EndorseRefusal, Link, Note, Projection, Refused};
use crate::fleet_wire::{Events, RelayFrames, Refusal};
use crate::license::Product;
use crate::log::{Fields, Level};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant};

/// What the relay's policy says when a section answers `Second` (4.7), for `Console::fleet_route`.
pub enum FleetSecond<'a> {
    /// Policy on and no second admin: `fleet-second`.
    Refuse,
    /// One admin's word is enough: "single-admin-setting" (policy off) or "sole-admin".
    Single(&'static str),
    /// A verified approver (mode two).
    Approved { approver: &'a str, approval_id: &'a str },
}

/// What `Console::fleet_route` ran.
pub struct FleetRan {
    pub status: u16,
    pub body: Value,
    pub target: Option<String>,
    pub result: &'static str,
    pub approval: Option<String>,
}

/// Own refusal entries a minute before the summary (7.2).
const REFUSALS_PER_MINUTE: u64 = 60;
/// Unsent audit entries kept for the `audit` push (7.2).
const AUDIT_PUSH_MAX: usize = 10_000;
const TICK: Duration = Duration::from_secs(5);

static LIVE: LazyLock<Mutex<HashMap<PathBuf, Weak<Frames>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn key_of(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned())
}

/// The running relay's frames for `state_dir`, when it is enrolled and running in this process.
pub fn live(state_dir: &Path) -> Option<Arc<Frames>> {
    LIVE.lock().get(&key_of(state_dir)).and_then(Weak::upgrade)
}

fn refusal(r: Refused) -> Refusal {
    Refusal { status: r.status, code: r.code.to_owned(), error: r.error }
}

fn api(e: ApiError) -> Refused {
    Refused { status: e.status, code: e.code, error: e.message }
}

#[derive(Default)]
struct Reads {
    minute: i64,
    count: u64,
    routes: BTreeMap<String, u64>,
    people: BTreeSet<String>,
}

#[derive(Default)]
struct Refusals {
    minute: i64,
    count: u64,
    codes: BTreeMap<String, u64>,
}

/// The operator's standing settings as last read (4.2).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct LocalView {
    pub read_only: bool,
    pub confirm: Vec<String>,
    /// `fleet-local.json` or the journal did not read: read only, no command applied.
    pub unreadable: bool,
}

struct Live {
    link: Option<Link>,
    nonces: ft::Nonces,
    base_running: i64,
    local: LocalView,
    local_seen: bool,
    mds_seen: Option<(u64, String)>,
    reads: Reads,
    refusals: Refusals,
    last_state: Option<Value>,
    last_attention: Option<Value>,
    audit_pushed: u64,
    last_high: Option<bool>,
}

/// The relay's frames for one link (F5).
pub struct Frames {
    console: Arc<Console>,
    state_dir: PathBuf,
    product: Product,
    events: Events,
    st: Mutex<Live>,
    started: Instant,
}

/// F5: the frames of an enrolled relay, built at every start after apply. Pending one-shot commands are completed
/// first (4.2), then the relay's own verdicts, ceremony B and the bootstrap rule are applied.
pub fn frames(console: Arc<Console>, state_dir: PathBuf, product: Product, events: Events) -> Arc<dyn RelayFrames> {
    open(console, state_dir, product, events)
}

/// `frames` with its concrete type (tests, and the registry).
pub fn open(console: Arc<Console>, state_dir: PathBuf, product: Product, events: Events) -> Arc<Frames> {
    let t = crate::codec::now_ms();
    let link = match crate::fleet_agent::load_link_json(&state_dir) {
        Ok(Some(m)) => match Link::from_map(&m) {
            Ok(l) => Some(l),
            Err(e) => {
                console.logger.security("fleet.state-unreadable", &Fields::new().with("why", e), Level::Error);
                None
            }
        },
        Ok(None) => None,
        Err(e) => {
            console.logger.security("fleet.state-unreadable", &Fields::new().with("why", e), Level::Error);
            None
        }
    };
    let base_running = link.as_ref().map_or(0, |l| l.running_ms);
    let audit_pushed = console.audit.lock().head().0;
    let f = Arc::new(Frames {
        console,
        state_dir,
        product,
        events,
        st: Mutex::new(Live {
            link,
            nonces: ft::Nonces::default(),
            base_running,
            local: LocalView { read_only: true, confirm: Vec::new(), unreadable: false },
            local_seen: false,
            mds_seen: None,
            reads: Reads::default(),
            refusals: Refusals::default(),
            last_state: None,
            last_attention: None,
            audit_pushed,
            last_high: None,
        }),
        started: Instant::now(),
    });
    LIVE.lock().insert(key_of(&f.state_dir), Arc::downgrade(&f));
    // 4.2: before anything else, confirmations a crash left `running` are closed `unknown`, then pending journal
    // entries complete and the control file is read.
    f.close_running(t);
    f.poll(t);
    f.settle_all(t, true);
    let weak = Arc::downgrade(&f);
    let _ = std::thread::Builder::new().name("fleet-trust".into()).spawn(move || {
        let mut n: u64 = 0;
        loop {
            std::thread::sleep(TICK);
            let Some(f) = weak.upgrade() else { return };
            let t = crate::codec::now_ms();
            f.poll(t);
            n += 1;
            if n.is_multiple_of(12) {
                f.minute(t);
            }
        }
    });
    f
}

impl Drop for Frames {
    fn drop(&mut self) {
        let running = self.running();
        let mut st = self.st.lock();
        if let Some(link) = st.link.as_mut() {
            link.running_ms = running;
            let link = link.clone();
            drop(st);
            let _ = self.save(&link);
        }
    }
}

impl Frames {
    /// The relay's own running time (4.4): the persisted count plus this process's monotonic time.
    pub fn running(&self) -> i64 {
        let base = self.st.lock().base_running;
        base + self.started.elapsed().as_millis() as i64
    }

    /// The relay's local profile (its own book's, set from `--console-profile` or `console_profile`).
    fn high(&self) -> bool {
        self.console.inner.lock().book.settings.high()
    }

    fn mds(&self) -> Option<crate::console_mds::Snapshot> {
        self.console.mds.lock().current.clone()
    }

    fn audit(&self, mut r: Record, t: i64) {
        if r.detail.is_null() {
            r.detail = json!({});
        }
        self.console.record(r, t);
    }

    fn relay_actor(&self, action: &str, detail: Value, t: i64) {
        let mut r = Record::new("relay", action, "ok");
        r.detail = detail;
        self.audit(r, t);
    }

    /// Write the keys f-trust owns, only into the link they belong to.
    fn save(&self, link: &Link) -> Result<(), String> {
        crate::fleet_agent::update_link(&self.state_dir, |m| {
            if str_of(m.get("consoleId")) != Some(link.console_id.as_str()) || str_of(m.get("relayId")) != Some(link.relay_id.as_str()) {
                return Err("the link changed".into());
            }
            link.write_into(m);
            Ok(())
        })
    }

    fn save_live(&self, st: &mut Live) {
        let running = st.base_running + self.started.elapsed().as_millis() as i64;
        if let Some(link) = st.link.as_mut() {
            link.running_ms = running;
            if let Err(e) = self.save(link) {
                self.console.logger.ops("fleet.write-failed", &Fields::new().with("why", e), Level::Error);
            }
        }
    }

    /// Notes about keys, entered in the audit and the log.
    fn notes(&self, notes: Vec<Note>, t: i64) {
        for n in notes {
            match n {
                Note::Held { hint, why } => {
                    self.console.logger.security("fleet.roster-held", &Fields::new().with("hint", hint.as_str()).with("why", why).with("needMs", ft::HOLD_MS), Level::Warn);
                    self.relay_actor("fleet.roster-held", json!({ "hint": hint, "needMs": ft::HOLD_MS, "why": why }), t);
                }
                Note::Active { hint } => self.relay_actor("fleet.roster-active", json!({ "hint": hint }), t),
                Note::Anchor { hint, via, by, email } => {
                    let mut r = Record::new(&email, "fleet.bootstrap-anchor", "ok");
                    r.detail = json!({ "hint": hint, "via": via, "by": by, "result": "ok", "why": null });
                    self.audit(r, t);
                }
                Note::Refused { hint } => self.relay_actor("fleet.roster-refused", json!({ "hint": hint }), t),
            }
        }
    }

    /// Verdicts, ceremony B, the bootstrap rule and the holds, then a save and a `state` event when anything moved.
    fn settle_all(&self, t: i64, start: bool) {
        let high = self.high();
        let mds = self.mds();
        let running = self.running();
        let mut st = self.st.lock();
        let seen = mds.as_ref().map(|s| (s.no, s.sha256.clone()));
        let mds_changed = st.mds_seen != seen;
        st.mds_seen = seen;
        let high_changed = st.last_high.is_some_and(|h| h != high);
        st.last_high = Some(high);
        let Some(link) = st.link.as_mut() else { return };
        let before = format!("{:?}", link.roster.iter().map(|e| (e.state, e.attested, e.anchor.is_some())).collect::<Vec<_>>());
        let mut notes = Vec::new();
        let mut boot = None;
        if start || mds_changed {
            link.attest_all(mds.as_ref(), t);
        }
        if start {
            notes.extend(link.apply_admin_keys());
            if let Some(b) = link.complete_same_process(running) {
                boot = Some(("same-process", b));
            }
        }
        if boot.is_none() {
            if let Some(b) = link.try_complete_bootstrap(high, running) {
                boot = Some(("anchors", b));
            }
        }
        notes.extend(link.settle(high, running));
        link.sweep(t);
        let after = format!("{:?}", link.roster.iter().map(|e| (e.state, e.attested, e.anchor.is_some())).collect::<Vec<_>>());
        let hash = link.bootstrap.hash.clone();
        let anchors: Vec<Value> = link.roster.iter().filter_map(|e| e.anchor.as_ref().map(|a| json!({ "hint": e.hint, "via": a.via }))).collect();
        let changed = start || before != after || boot.is_some() || high_changed;
        if changed {
            self.save_live(&mut st);
        }
        drop(st);
        self.notes(notes, t);
        if let Some((via, (activated, unattested, more))) = boot {
            self.notes(more, t);
            let n = activated.len();
            self.relay_actor("fleet.bootstrap", json!({ "via": via, "bootstrapRosterHash": hash, "activated": activated, "unattested": unattested, "result": "ok", "anchors": anchors }), t);
            let held = self.st.lock().link.as_ref().map_or(0, |l| l.hints_in(ft::KeyState::Held).len());
            self.console.logger.ops("fleet.bootstrap", &Fields::new().with("activated", n).with("held", held).with("via", via), Level::Info);
        }
        if changed {
            self.push_state(t);
        }
    }

    /// Once a minute: running time persisted, holds settled, confirmations expired, summaries flushed, the
    /// attention and audit pushes.
    fn minute(&self, t: i64) {
        self.settle_all(t, false);
        {
            let mut st = self.st.lock();
            self.save_live(&mut st);
        }
        self.expire_confirmations(t);
        self.flush_summaries(t, false);
        self.push_attention(t);
        self.push_audit();
        self.push_state(t);
    }

    // ── Local controls (4.2) ────────────────────────────────────────────────────────────────────────────────

    /// The operator's control file and journal, read and applied (every 5 s and at once after a local console
    /// command).
    pub fn poll(&self, t: i64) {
        let before = self.st.lock().local.clone();
        if let Err(why) = fleet_local::poll(self, &self.state_dir, t) {
            if !before.unreadable {
                self.console.logger.security("fleet.local-unreadable", &Fields::new().with("why", why), Level::Error);
            }
            let mut st = self.st.lock();
            st.local.read_only = true;
            st.local.unreadable = true;
        }
        if self.st.lock().local != before {
            self.push_state(t);
        }
    }

    /// The settings as just read (4.2): changes the operator made are audited `fleet.read-only` and
    /// `fleet.confirm-scopes` (the first read at start only sets them).
    fn take_settings(&self, read_only: bool, confirm: &[String], t: i64) {
        let mut st = self.st.lock();
        let before = st.local.clone();
        let seen = st.local_seen;
        st.local = LocalView { read_only, confirm: confirm.to_vec(), unreadable: false };
        st.local_seen = true;
        drop(st);
        if !seen || before.unreadable {
            return;
        }
        if read_only != before.read_only {
            let mut r = Record::new("operator", "fleet.read-only", "ok");
            r.detail = json!({ "on": read_only });
            self.audit(r, t);
        }
        if confirm != before.confirm.as_slice() {
            let mut r = Record::new("operator", "fleet.confirm-scopes", "ok");
            r.detail = json!({ "scopes": confirm });
            self.audit(r, t);
        }
    }

    /// A setting the local console just wrote and audited itself (so the poll does not enter it again).
    pub fn note_settings(&self, read_only: bool, confirm: Vec<String>) {
        let mut st = self.st.lock();
        st.local.read_only = read_only;
        st.local.confirm = confirm;
    }

    // ── Events ──────────────────────────────────────────────────────────────────────────────────────────────

    /// The 5.6 `state` body.
    pub fn state_body(&self, t: i64) -> Value {
        let high = self.high();
        let lic = self.console.license_view(t);
        let chan = crate::fleet_agent::load_link_json(&self.state_dir).ok().flatten().unwrap_or_default();
        let st = self.st.lock();
        let Some(link) = st.link.as_ref() else { return Value::Null };
        json!({
            "readOnly": st.local.read_only || st.local.unreadable || !link.bootstrap.done, "confirm": st.local.confirm,
            "scopes": link.scopes, "scopeGeneration": link.scope_generation, "scopeRequest": link.scope_request.as_ref().map(ft::ScopeRequest::view),
            "profile": if high { "high" } else { "standard" }, "bootstrap": if link.bootstrap.done { "done" } else { "pending" },
            "held": link.hints_in(ft::KeyState::Held), "unattested": link.hints_in(ft::KeyState::Unattested),
            "pins": chan.get("pins").cloned().unwrap_or(Value::Null), "trustSeq": chan.get("trust").and_then(|x| x.get("seq")).cloned().unwrap_or(Value::Null),
            "version": env!("CARGO_PKG_VERSION"),
            // AC-2a 5.6 (R42-6, R7-L1): what the fleet's reminders need; `exp` in ms.
            "license": {
                "state": lic.state.as_str(), "daysLeft": lic.license.get("daysLeft").cloned().unwrap_or(Value::Null),
                "id": lic.service.license_id, "exp": lic.service.exp, "service": lic.service.to_value(),
            },
        })
    }

    fn push_state(&self, t: i64) {
        let body = self.state_body(t);
        if body.is_null() {
            return;
        }
        let mut st = self.st.lock();
        if st.last_state.as_ref() == Some(&body) {
            return;
        }
        st.last_state = Some(body.clone());
        drop(st);
        self.events.send("state", body);
    }

    /// The relay's attention list for its projection (4.11), pushed when it changes.
    fn push_attention(&self, t: i64) {
        let full = self.st.lock().link.as_ref().is_some_and(|l| l.has("people"));
        let mut items = self.console.section().map(|s| s.attention(full, t)).unwrap_or_default();
        for (kind, args) in self.console.audit.lock().attention(t) {
            items.push(json!({ "kind": kind, "severity": "bad", "args": args }));
        }
        let items = ft::attention_for(&items, if full { Projection::Full } else { Projection::Viewer });
        let body = json!({ "items": items });
        let mut st = self.st.lock();
        if st.last_attention.as_ref() == Some(&body) {
            return;
        }
        st.last_attention = Some(body.clone());
        drop(st);
        self.events.send("attention", body);
    }

    /// With `read-logs` (and `people`): the relay's new audit entries, in sequence order (7.2, 10.2).
    fn push_audit(&self) {
        let (on, from) = {
            let st = self.st.lock();
            (st.link.as_ref().is_some_and(|l| l.has("read-logs") && l.has("people")), st.audit_pushed)
        };
        let entries = self.console.audit.lock().entries();
        let head = entries.last().and_then(|e| e.get("seq")).and_then(Value::as_u64).unwrap_or(from);
        if !on {
            self.st.lock().audit_pushed = head;
            return;
        }
        let mut new: Vec<Value> = entries.into_iter().filter(|e| e.get("seq").and_then(Value::as_u64).is_some_and(|s| s > from)).map(Value::Object).collect();
        let dropped = new.len().saturating_sub(AUDIT_PUSH_MAX);
        if dropped > 0 {
            new.drain(..dropped);
        }
        self.st.lock().audit_pushed = head;
        if dropped > 0 {
            self.console.logger.ops("fleet.audit-dropped", &Fields::new().with("dropped", dropped as u64), Level::Warn);
        }
        if !new.is_empty() {
            // AC-2a 9.3: `{entries}` only (any other key makes the console refuse the frame).
            self.events.send("audit", json!({ "entries": new }));
        }
    }

    // ── Audit summaries (7.2) ───────────────────────────────────────────────────────────────────────────────

    fn console_actor(&self) -> String {
        let id = self.st.lock().link.as_ref().map(|l| l.console_id.clone()).unwrap_or_default();
        format!("console {id}")
    }

    fn note_read(&self, path: &str, email: &str, t: i64) {
        self.flush_summaries(t, false);
        let mut st = self.st.lock();
        st.reads.minute = t.div_euclid(60_000);
        st.reads.count += 1;
        *st.reads.routes.entry(path.to_owned()).or_insert(0) += 1;
        if !email.is_empty() {
            st.reads.people.insert(email.to_owned());
        }
    }

    fn flush_summaries(&self, t: i64, force: bool) {
        let minute = t.div_euclid(60_000);
        let (reads, refusals) = {
            let mut st = self.st.lock();
            let reads = (st.reads.count > 0 && (force || st.reads.minute < minute)).then(|| std::mem::take(&mut st.reads));
            let ended = st.refusals.count > 0 && (force || st.refusals.minute < minute);
            let refusals = ended.then(|| std::mem::take(&mut st.refusals));
            (reads, refusals.filter(|r| r.count > REFUSALS_PER_MINUTE))
        };
        let actor = self.console_actor();
        if let Some(r) = reads {
            let mut rec = Record::new(&actor, "fleet.reads.summary", "ok");
            rec.detail = json!({ "count": r.count, "routes": r.routes, "people": r.people });
            self.audit(rec, t);
        }
        if let Some(r) = refusals {
            let mut rec = Record::new(&actor, "fleet.refusals.summary", "refused");
            rec.detail = json!({ "count": r.count, "own": REFUSALS_PER_MINUTE, "codes": r.codes });
            self.audit(rec, t);
        }
    }

    /// A refused write frame: its own entry (60 a minute), then counted into the summary.
    fn note_refusal(&self, email: &str, role: Option<&str>, action: &str, target: Option<&str>, code: &str, t: i64) {
        self.flush_summaries(t, false);
        let own = {
            let mut st = self.st.lock();
            let minute = t.div_euclid(60_000);
            if st.refusals.minute != minute {
                st.refusals = Refusals { minute, ..Refusals::default() };
            }
            st.refusals.count += 1;
            *st.refusals.codes.entry(code.to_owned()).or_insert(0) += 1;
            st.refusals.count <= REFUSALS_PER_MINUTE
        };
        if own {
            let consoleid = self.console_actor();
            let mut r = Record::new(if email.is_empty() { &consoleid } else { email }, "fleet.call", "refused");
            r.role = role.map(str::to_owned);
            r.target = target.map(str::to_owned);
            r.stepup = true;
            r.detail = json!({ "action": action, "code": code, "consoleId": consoleid.trim_start_matches("console ") });
            self.audit(r, t);
        }
    }

    // ── Requests (F5) ───────────────────────────────────────────────────────────────────────────────────────

    fn relay_admin(&self, email: &str) -> bool {
        match self.product {
            Product::Meet => self.console.section().is_some_and(|s| s.admin_rule(email, "") != AdminRule::NotRelayAdmin),
            Product::Spokes => true,
        }
    }

    /// 4.8 step 4: the write gates.
    fn write_gates(&self) -> Result<(), Refused> {
        let high = self.high();
        let st = self.st.lock();
        let link = st.link.as_ref().ok_or_else(Refused::op)?;
        if !link.bootstrap.done {
            return Err(Refused::of("fleet-bootstrap"));
        }
        if st.local.read_only || st.local.unreadable {
            return Err(Refused::of("fleet-read-only"));
        }
        if high && !link.policy.high {
            return Err(Refused::of("fleet-profile"));
        }
        Ok(())
    }

    fn nonce(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let o = body.as_object().ok_or_else(Refused::op)?;
        if !exact_keys(o, &["n"], &["n"]) {
            return Err(Refused::op());
        }
        let n = is_int(o.get("n")).ok_or_else(Refused::op)? as usize;
        let mut st = self.st.lock();
        let Live { link, nonces, .. } = &mut *st;
        let link = link.as_ref().ok_or_else(Refused::op)?;
        if !link.has_write_scope() {
            return Err(Refused::scope("people"));
        }
        let list = nonces.draw(n, t).ok_or_else(Refused::op)?;
        Ok(json!({ "nonces": list, "ttl": ft::NONCE_MS / 1000 }))
    }

    /// The second-admin decision for a verified write (4.7).
    fn second_of(&self, wa: &ft::WriteAuth) -> String {
        let st = self.st.lock();
        let Some(link) = st.link.as_ref() else { return "refuse".into() };
        if wa.mode == "two" {
            "approved".into()
        } else if !link.policy.two_person {
            "single-admin-setting".into()
        } else if link.active_admin_emails().len() == 1 {
            "sole-admin".into()
        } else {
            "refuse".into()
        }
    }

    fn call(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let o = body.as_object().ok_or_else(Refused::op)?;
        let keys = ["method", "path", "query", "body", "caller", "auth"];
        if !exact_keys(o, &keys, &keys) {
            return Err(Refused::op());
        }
        let method = str_of(o.get("method")).filter(|m| matches!(*m, "GET" | "POST")).ok_or_else(Refused::op)?;
        let path = str_of(o.get("path")).filter(|p| (1..=200).contains(&p.len())).ok_or_else(Refused::op)?;
        let query = str_of(o.get("query")).filter(|q| q.len() <= 2048).ok_or_else(Refused::op)?;
        let params = o.get("body").filter(|b| b.is_object()).ok_or_else(Refused::op)?;
        let caller = o.get("caller").and_then(Value::as_object).ok_or_else(Refused::op)?;
        if !exact_keys(caller, &["email", "role"], &["email", "role"]) {
            return Err(Refused::op());
        }
        let email = str_of(caller.get("email")).ok_or_else(Refused::op)?.to_owned();
        let role = str_of(caller.get("role")).filter(|r| matches!(*r, "admin" | "user-manager" | "viewer")).ok_or_else(Refused::op)?;
        let row = ft::scope_row(method, path).ok_or_else(|| Refused::of("fleet-route"))?;
        let scopes = self.st.lock().link.as_ref().map(|l| l.scopes.clone()).ok_or_else(Refused::op)?;
        if method == "GET" {
            if !o.get("auth").is_some_and(Value::is_null) || params.as_object().is_some_and(|m| !m.is_empty()) {
                return Err(Refused::op());
            }
            let projection = ft::read_projection(row, &scopes)?;
            let answer = self.read(path, query, &email, role, projection, t)?;
            self.note_read(path, &email, t);
            return Ok(json!({ "status": 200, "body": answer }));
        }
        if row.health != ft::Health::Write {
            return self.export_read(row, path, params, o.get("auth"), &scopes, t);
        }
        let auth = o.get("auth").filter(|a| a.is_object()).ok_or_else(|| Refused::of("fleet-stepup"));
        let attempt = |r: Refused| {
            self.note_refusal(&email, None, path, None, r.code, t);
            r
        };
        ft::write_scopes_ok(row, &scopes).map_err(attempt)?;
        self.write_gates().map_err(attempt)?;
        let auth = auth.map_err(attempt)?;
        if params.get("stepup").is_some() {
            return Err(attempt(Refused::op()));
        }
        let spec = self.console.fleet_route_spec("POST", path).ok_or_else(|| attempt(Refused::of("fleet-route")))?;
        let target = crate::console::target_of(spec, params);
        let wa = {
            let mut st = self.st.lock();
            let Live { link, nonces, .. } = &mut *st;
            let link = link.as_mut().ok_or_else(Refused::op)?;
            let r = ft::authorize(link, nonces, auth, spec.action, &target, params, t);
            // Counters and used approvals are on disk before anything runs.
            self.save_live(&mut st);
            r
        };
        let wa = match wa {
            Ok(w) => w,
            Err(r) => {
                if r.code == "fleet-counter" {
                    self.console.logger.security("fleet.counter", &Fields::new().with("action", spec.action), Level::Error);
                }
                self.note_refusal(&email, None, spec.action, Some(&target), r.code, t);
                return Err(r);
            }
        };
        let refuse = |r: Refused| {
            self.note_refusal(&wa.email, Some(&wa.role), spec.action, Some(&target), r.code, t);
            r
        };
        let manager_ok = spec.role == Role::Manager || (path == "requests/new" && str_of(params.get("kind")) == Some("meet.invite"));
        let is_admin = wa.role == "admin";
        if !manager_ok && !is_admin {
            return Err(refuse(api(ApiError::of("role"))));
        }
        if !manager_ok && !self.relay_admin(&wa.email) {
            return Err(refuse(api(ApiError::of("not-relay-admin"))));
        }
        if let Some((_, approver)) = &wa.approver {
            let ok = self.console.section().is_none_or(|s| s.may_approve(spec.action, params, approver)) && self.relay_admin(approver);
            if !ok {
                return Err(refuse(Refused::of("fleet-stepup")));
            }
        }
        let run = json!({
            "kind": "call", "path": path, "params": params, "action": spec.action, "target": target,
            "email": wa.email, "role": wa.role, "hint": wa.hint, "admin": is_admin && self.relay_admin(&wa.email),
            "approverHint": wa.approver.as_ref().map(|a| a.0.clone()), "approver": wa.approver.as_ref().map(|a| a.1.clone()),
            "approvalId": wa.approval_id, "mode": wa.mode, "second": self.second_of(&wa),
        });
        if let Some(id) = self.queue_if_confirm(row.scopes, &run, &format!("{} {}", spec.action, target), &wa, t)? {
            return Ok(json!({ "status": 202, "body": { "ok": false, "code": "fleet-confirm", "error": Refused::of("fleet-confirm").error, "confirm": id } }));
        }
        self.execute(&run, None, t)
    }

    /// A POST read (`logs/export`, `audit/export`): the full scopes, and, as AC-1 asks a step-up for an export, an
    /// active admin's verified fleet step-up over this relay's nonce; counted with the reads, never a write.
    fn export_read(&self, row: &ft::ScopeRow, path: &str, params: &Value, auth: Option<&Value>, scopes: &[String], t: i64) -> Result<Value, Refused> {
        if ft::read_projection(row, scopes)? != Projection::Full {
            return Err(Refused::scope("people"));
        }
        let spec = self.console.fleet_route_spec("POST", path).ok_or_else(|| Refused::of("fleet-route"))?;
        let target = crate::console::target_of(spec, params);
        let auth = auth.filter(|a| a.is_object()).ok_or_else(|| Refused::of("fleet-stepup"))?;
        let wa = {
            let mut st = self.st.lock();
            let Live { link, nonces, .. } = &mut *st;
            let link = link.as_mut().ok_or_else(Refused::op)?;
            let r = ft::authorize(link, nonces, auth, spec.action, &target, params, t);
            self.save_live(&mut st);
            r?
        };
        if wa.role != "admin" || !self.relay_admin(&wa.email) {
            return Err(api(ApiError::of("role")));
        }
        let caller = Caller { email: wa.email.clone(), admin: true, manager: true, ip: self.console_actor() };
        let ran = self.console.fleet_route("POST", path, "", params, &caller, FleetSecond::Refuse, t).map_err(api)?;
        self.note_read(path, &wa.email, t);
        Ok(json!({ "status": ran.status, "body": ran.body }))
    }

    /// A read (4.8 step 7) with the rights of the projection: the viewer allowlist under `read-health` alone,
    /// otherwise the stated role (Meeting Hub admin rights only for a principal in `admins`).
    fn read(&self, path: &str, query: &str, email: &str, role: &str, projection: Projection, t: i64) -> Result<Value, Refused> {
        let ip = self.console_actor();
        let caller = match projection {
            Projection::Viewer => Caller { email: email.to_owned(), admin: false, manager: false, ip },
            Projection::Full => Caller { email: email.to_owned(), admin: role == "admin" && self.relay_admin(email), manager: role != "viewer", ip },
        };
        let answer = if matches!(path, "spokes/counts" | "meet/counts") {
            let spec = match self.product {
                Product::Spokes => crate::console_spokes::FLEET_ROUTES.iter().find(|r| r.path == path),
                Product::Meet => crate::console_meet::FLEET_ROUTES.iter().find(|r| r.path == path),
            }
            .ok_or_else(|| Refused::of("fleet-route"))?;
            let section = self.console.section().ok_or_else(|| Refused::of("fleet-route"))?;
            let empty = Value::Object(Map::new());
            let call = SectionCall { spec, query, body: &empty, caller: &caller, license: self.console.license_view(t).state, t };
            match section.route(&call).map_err(api)? {
                SectionAnswer::Read(v) => v,
                _ => return Err(Refused::op()),
            }
        } else {
            self.console.fleet_route("GET", path, query, &Value::Object(Map::new()), &caller, FleetSecond::Refuse, t).map_err(api)?.body
        };
        match projection {
            Projection::Full => Ok(answer),
            Projection::Viewer => ft::project("GET", path, &answer).ok_or_else(|| Refused::scope("people")),
        }
    }

    /// Confirm here (4.2): a write in a listed scope waits for the operator.
    fn queue_if_confirm(&self, scopes: &[&str], run: &Value, summary: &str, wa: &ft::WriteAuth, t: i64) -> Result<Option<String>, Refused> {
        let confirm = self.st.lock().local.confirm.clone();
        if !scopes.iter().any(|s| confirm.iter().any(|c| c == s)) {
            return Ok(None);
        }
        let id = fleet_local::queue_confirm(&self.state_dir, run, summary, &wa.email, t).map_err(|e| {
            self.console.logger.ops("fleet.write-failed", &Fields::new().with("why", e), Level::Error);
            Refused::with("fleet-op", "The relay could not save the waiting change.")
        })?;
        let mut r = Record::new(&wa.email, "fleet.call", "waiting");
        r.role = Some(wa.role.clone());
        r.target = str_of(run.get("target")).map(str::to_owned);
        r.stepup = true;
        r.approval = wa.approval_id.clone();
        r.detail = json!({ "action": run.get("action"), "consoleId": self.console_actor().trim_start_matches("console "), "hint": wa.hint, "approverHint": run.get("approverHint"), "mode": wa.mode, "confirm": id });
        self.audit(r, t);
        Ok(Some(id))
    }

    /// Run a verified write (now, or after the operator's confirm) and enter its 7.2 `fleet.call`.
    fn execute(&self, run: &Value, confirm: Option<&str>, t: i64) -> Result<Value, Refused> {
        if str_of(run.get("kind")) == Some("people") {
            return self.execute_people(run, confirm, t);
        }
        let path = str_of(run.get("path")).unwrap_or("");
        let params = run.get("params").cloned().unwrap_or(Value::Null);
        let email = str_of(run.get("email")).unwrap_or("").to_owned();
        let role = str_of(run.get("role")).unwrap_or("").to_owned();
        let caller = Caller { email: email.clone(), admin: run.get("admin").and_then(Value::as_bool).unwrap_or(false), manager: true, ip: self.console_actor() };
        let approver = str_of(run.get("approver")).unwrap_or("").to_owned();
        let approval_id = str_of(run.get("approvalId")).unwrap_or("").to_owned();
        let second = match str_of(run.get("second")) {
            Some("approved") => FleetSecond::Approved { approver: &approver, approval_id: &approval_id },
            Some("single-admin-setting") => FleetSecond::Single("single-admin-setting"),
            Some("sole-admin") => FleetSecond::Single("sole-admin"),
            _ => FleetSecond::Refuse,
        };
        let action = str_of(run.get("action")).unwrap_or("").to_owned();
        let target = str_of(run.get("target")).unwrap_or("").to_owned();
        let consoleid = self.console_actor();
        let detail = |code: Option<&str>| json!({ "action": action, "consoleId": consoleid.trim_start_matches("console "), "hint": run.get("hint"), "approverHint": run.get("approverHint"), "mode": run.get("mode"), "confirm": confirm, "code": code });
        match self.console.fleet_route("POST", path, "", &params, &caller, second, t) {
            Ok(ran) => {
                let mut r = Record::new(&email, "fleet.call", ran.result);
                r.role = Some(role);
                r.target = ran.target.clone().or(Some(target.clone()));
                r.stepup = true;
                r.approval = ran.approval.clone().or_else(|| (!approval_id.is_empty()).then(|| approval_id.clone()));
                r.detail = detail(None);
                self.audit(r, t);
                Ok(json!({ "status": ran.status, "body": ran.body }))
            }
            Err(e) => {
                let mut r = Record::new(&email, "fleet.call", "refused");
                r.role = Some(role);
                r.target = Some(target.clone());
                r.stepup = true;
                r.detail = detail(Some(e.code));
                self.audit(r, t);
                Err(api(e))
            }
        }
    }

    /// The 11.2 `people` op: one verified step-up for every item; each item its own AC-1 action and answer.
    fn people(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let o = body.as_object().ok_or_else(Refused::op)?;
        let keys = ["action", "subject", "params", "auth"];
        if !exact_keys(o, &keys, &keys) {
            return Err(Refused::op());
        }
        let op = str_of(o.get("action")).filter(|a| matches!(*a, "suspend" | "unsuspend" | "remove")).ok_or_else(Refused::op)?;
        let subject = o.get("subject").and_then(Value::as_object).ok_or_else(Refused::op)?;
        let target = match (str_of(subject.get("principal")), str_of(subject.get("node"))) {
            (Some(p), None) if subject.len() == 1 => p.to_owned(),
            (None, Some(n)) if subject.len() == 1 => n.to_owned(),
            _ => return Err(Refused::op()),
        };
        let params = o.get("params").filter(|p| p.is_object()).ok_or_else(Refused::op)?;
        let list_key = if self.product == Product::Meet { "devices" } else { "hubs" };
        let items: Vec<String> = params.get(list_key).and_then(Value::as_array).ok_or_else(Refused::op)?.iter().map(|x| x.as_str().map(str::to_owned)).collect::<Option<_>>().ok_or_else(Refused::op)?;
        if items.is_empty() || items.len() > 50 {
            return Err(Refused::op());
        }
        let action = format!("people.{op}");
        let attempt = |r: Refused| {
            self.note_refusal("", None, &action, Some(&target), r.code, t);
            r
        };
        let scopes = self.st.lock().link.as_ref().map(|l| l.scopes.clone()).ok_or_else(Refused::op)?;
        if !scopes.iter().any(|s| s == "people") {
            return Err(attempt(Refused::scope("people")));
        }
        self.write_gates().map_err(attempt)?;
        let auth = o.get("auth").filter(|a| a.is_object()).ok_or_else(|| attempt(Refused::of("fleet-stepup")))?;
        let wa = {
            let mut st = self.st.lock();
            let Live { link, nonces, .. } = &mut *st;
            let link = link.as_mut().ok_or_else(Refused::op)?;
            let r = ft::authorize(link, nonces, auth, &action, &target, params, t);
            self.save_live(&mut st);
            r
        }
        .map_err(attempt)?;
        let refuse = |r: Refused| {
            self.note_refusal(&wa.email, Some(&wa.role), &action, Some(&target), r.code, t);
            r
        };
        if wa.role != "admin" {
            return Err(refuse(api(ApiError::of("role"))));
        }
        if !self.relay_admin(&wa.email) {
            return Err(refuse(api(ApiError::of("not-relay-admin"))));
        }
        let second = self.second_of(&wa);
        // 11.2: a device of a relay admin needs a second admin; with one assertion and the policy on, the whole op
        // is refused before anything runs.
        if second == "refuse" && self.product == Product::Meet && op != "remove" && self.console.section().is_some_and(|s| s.admin_rule(&target, "") != AdminRule::NotRelayAdmin) {
            return Err(refuse(Refused::of("fleet-second")));
        }
        let run = json!({
            "kind": "people", "op": op, "subject": target, "items": items, "params": params, "action": action, "target": target,
            "email": wa.email, "role": wa.role, "hint": wa.hint, "admin": true,
            "approverHint": wa.approver.as_ref().map(|a| a.0.clone()), "approver": wa.approver.as_ref().map(|a| a.1.clone()),
            "approvalId": wa.approval_id, "mode": wa.mode, "second": second,
        });
        if let Some(id) = self.queue_if_confirm(&["people"], &run, &format!("{action} {target}"), &wa, t)? {
            return Ok(json!({ "results": [], "confirm": id }));
        }
        self.execute_people(&run, None, t)
    }

    fn execute_people(&self, run: &Value, confirm: Option<&str>, t: i64) -> Result<Value, Refused> {
        let op = str_of(run.get("op")).unwrap_or("");
        let subject = str_of(run.get("subject")).unwrap_or("").to_owned();
        let params = run.get("params").cloned().unwrap_or(Value::Null);
        let hours = params.get("hours").cloned().unwrap_or(Value::Null);
        let reason = params.get("reason").cloned().unwrap_or(Value::Null);
        let meet = self.product == Product::Meet;
        let mut results = Vec::new();
        for item in run.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let (path, body) = match (op, meet) {
                ("suspend", true) => ("meet/block", json!({ "principal": subject, "device": item, "hours": hours, "reason": reason })),
                ("unsuspend", true) => ("meet/unblock", json!({ "principal": subject, "device": item, "reason": reason })),
                ("remove", true) => ("requests/new", json!({ "kind": "meet.revoke", "target": { "principal": subject, "device": item }, "reason": reason })),
                ("suspend", false) => ("spokes/block", json!({ "node": item, "hours": hours, "reason": reason })),
                ("unsuspend", false) => ("spokes/unblock", json!({ "node": item, "reason": reason })),
                _ => ("requests/new", json!({ "kind": "rs.revoke", "target": { "node": item }, "reason": reason })),
            };
            let Some(spec) = self.console.fleet_route_spec("POST", path) else {
                results.push(json!({ "target": item, "ok": false, "code": "fleet-route" }));
                continue;
            };
            let mut one = run.clone();
            one["kind"] = Value::from("call");
            one["path"] = Value::from(path);
            one["action"] = Value::from(spec.action);
            one["target"] = Value::from(crate::console::target_of(spec, &body));
            one["params"] = body;
            match self.execute(&one, confirm, t) {
                Ok(_) => results.push(json!({ "target": item, "ok": true, "code": null })),
                Err(r) => results.push(json!({ "target": item, "ok": false, "code": r.code })),
            }
        }
        Ok(json!({ "results": results }))
    }

    fn roster(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let high = self.high();
        let mds = self.mds();
        let running = self.running();
        let mut st = self.st.lock();
        let link = st.link.as_mut().ok_or_else(Refused::op)?;
        let done = ft::roster_update(link, body, high, mds.as_ref(), running, t)?;
        let held = link.hints_in(ft::KeyState::Held);
        let unattested = link.hints_in(ft::KeyState::Unattested);
        self.save_live(&mut st);
        drop(st);
        let mut r = Record::new(&self.console_actor(), "fleet.roster", "ok");
        r.detail = json!({ "seq": done.seq, "adds": done.adds, "removes": done.removes, "held": held, "ignored": done.ignored });
        self.audit(r, t);
        self.notes(done.notes, t);
        self.push_state(t);
        Ok(json!({ "seq": done.seq, "held": held, "unattested": unattested }))
    }

    fn roster_cancel(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let o = body.as_object().ok_or_else(Refused::op)?;
        if !exact_keys(o, &["hint", "auth"], &["hint", "auth"]) {
            return Err(Refused::op());
        }
        let hint = str_of(o.get("hint")).ok_or_else(Refused::op)?.to_owned();
        let mut st = self.st.lock();
        let Live { link, nonces, .. } = &mut *st;
        let link = link.as_mut().ok_or_else(Refused::op)?;
        let params = json!({ "relay": link.relay_id, "hint": hint });
        let r = ft::authorize(link, nonces, o.get("auth").unwrap_or(&Value::Null), "fleet.roster.cancel", &hint, &params, t);
        let wa = match r {
            Ok(w) if w.role == "admin" => w,
            Ok(_) => {
                self.save_live(&mut st);
                return Err(Refused::of("fleet-stepup"));
            }
            Err(e) => {
                self.save_live(&mut st);
                return Err(e);
            }
        };
        let cancelled = st.link.as_mut().is_some_and(|l| l.cancel_held(&hint));
        self.save_live(&mut st);
        drop(st);
        if cancelled {
            let mut r = Record::new(&wa.email, "fleet.roster.cancel", "ok");
            r.role = Some(wa.role.clone());
            r.stepup = true;
            r.detail = json!({ "hint": hint, "by": "roster-admin" });
            self.audit(r, t);
            self.push_state(t);
        }
        Ok(json!({ "cancelled": cancelled }))
    }

    fn policy(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let mut st = self.st.lock();
        let link = st.link.as_mut().ok_or_else(Refused::op)?;
        let r = ft::policy_update(link, body);
        let policy = link.policy.to_value();
        self.save_live(&mut st);
        drop(st);
        let seq = r?;
        let mut rec = Record::new(&self.console_actor(), "fleet.policy", "ok");
        rec.detail = json!({ "seq": seq, "policy": policy });
        self.audit(rec, t);
        self.push_state(t);
        Ok(json!({ "seq": seq }))
    }

    fn scopes(&self, body: &Value, t: i64) -> Result<Value, Refused> {
        let mut st = self.st.lock();
        let link = st.link.as_mut().ok_or_else(Refused::op)?;
        let done = ft::scopes_frame(link, body)?;
        let answer = json!({ "scopes": link.scopes, "scopeGeneration": link.scope_generation, "scopeRequest": link.scope_request.as_ref().map(ft::ScopeRequest::view) });
        let detail = json!({ "scopes": link.scopes, "widened": false, "requestId": link.scope_request.as_ref().map(|r| r.request_id.clone()), "generation": link.scope_generation });
        self.save_live(&mut st);
        drop(st);
        if done.ignored_widening {
            self.console.logger.security("fleet.scopes-widening-ignored", &Fields::new(), Level::Warn);
        }
        if done.narrowed {
            let mut r = Record::new(&self.console_actor(), "fleet.scopes", "ok");
            r.detail = detail;
            self.audit(r, t);
        }
        self.push_state(t);
        Ok(answer)
    }

    // ── F20 and 5.7 for other slices ────────────────────────────────────────────────────────────────────────

    fn console_ca(&self) -> String {
        crate::fleet_agent::load_link_json(&self.state_dir).ok().flatten().map(|m| ft::console_ca_pin(&m)).unwrap_or_default()
    }

    pub fn bootstrap_view(&self, email: &str) -> Result<Value, EndorseRefusal> {
        let ca = self.console_ca();
        let st = self.st.lock();
        let link = st.link.as_ref().ok_or_else(EndorseRefusal::not_bootstrapping)?;
        if link.bootstrap.done {
            return Err(EndorseRefusal::not_bootstrapping());
        }
        Ok(ft::bootstrap_answer(link, email, &ca))
    }

    pub fn endorse(&self, ctx: &EndorseCtx, endorsement: &Value, t: i64) -> Result<Value, EndorseRefusal> {
        let ca = self.console_ca();
        let checked = {
            let mut st = self.st.lock();
            let link = st.link.as_mut().ok_or_else(EndorseRefusal::not_bootstrapping)?;
            let r = ft::check_endorsement(link, ctx, endorsement, &ca);
            let hint = r.as_ref().ok().map(|i| link.roster[*i].hint.clone());
            if hint.is_some() {
                self.save_live(&mut st);
            }
            r.map(|_| hint.unwrap_or_default())
        };
        let mut rec = Record::new(&ctx.email.trim().to_lowercase(), "fleet.bootstrap-anchor", if checked.is_ok() { "ok" } else { "refused" });
        let hint = checked.as_ref().ok().cloned();
        let why = checked.as_ref().err().and_then(|e| e.why);
        rec.detail = json!({ "hint": hint, "via": "device", "by": ctx.anchor, "result": if checked.is_ok() { "ok" } else { "refused" }, "why": why });
        if !matches!(&checked, Err(e) if e.code == "fleet-not-bootstrapping") {
            self.audit(rec, t);
        }
        let hint = checked?;
        self.settle_all(t, false);
        let bootstrap = self.st.lock().link.as_ref().map_or("pending", |l| if l.bootstrap.done { "done" } else { "pending" });
        Ok(json!({ "ok": true, "hint": hint, "bootstrap": bootstrap }))
    }

    pub fn active_admin_emails(&self) -> Vec<String> {
        self.st.lock().link.as_ref().map(Link::active_admin_emails).unwrap_or_default()
    }

    // ── Confirmations (4.2) ─────────────────────────────────────────────────────────────────────────────────

    fn done_confirm(&self, id: &str, result: &str, answer: Value, actor: &str, t: i64) {
        self.events.send("confirm-done", json!({ "id": id, "result": result, "answer": answer }));
        let mut r = Record::new(actor, "fleet.confirm", "ok");
        r.detail = json!({ "id": id, "result": result });
        self.audit(r, t);
    }

    /// Items a crash left `running` are closed `unknown`, never run again.
    fn close_running(&self, t: i64) {
        for id in fleet_local::take_running(&self.state_dir) {
            self.done_confirm(&id, "unknown", Value::Null, "relay", t);
        }
    }

    fn expire_confirmations(&self, t: i64) {
        for id in fleet_local::take_expired(&self.state_dir, t) {
            self.done_confirm(&id, "expired", Value::Null, "relay", t);
        }
    }

    /// The operator's confirm (run) or refuse of a waiting item: Ok(false) when it is no longer waiting.
    fn decide(&self, id: &str, run: bool, t: i64) -> Result<bool, String> {
        let Some(item) = fleet_local::confirm_item(&self.state_dir, id)? else { return Ok(false) };
        if !run {
            fleet_local::remove_confirm(&self.state_dir, id)?;
            self.done_confirm(id, "refused", Value::Null, "operator", t);
            return Ok(true);
        }
        fleet_local::mark_running(&self.state_dir, id)?;
        let w = item.get("run").cloned().unwrap_or(Value::Null);
        let still = {
            let st = self.st.lock();
            let roster_ok = |hint: Option<&str>| hint.is_none_or(|h| st.link.as_ref().and_then(|l| l.entry(h)).is_some_and(|e| e.state == ft::KeyState::Active));
            roster_ok(str_of(w.get("hint"))) && roster_ok(str_of(w.get("approverHint"))) && !st.local.read_only && !st.local.unreadable
        };
        let (result, answer) = if !still {
            ("failed", json!({ "status": 403, "body": { "ok": false, "code": "fleet-read-only", "error": Refused::of("fleet-read-only").error } }))
        } else {
            match self.execute(&w, Some(id), t) {
                Ok(a) => ("ok", a),
                Err(r) => ("failed", json!({ "status": r.status, "body": { "ok": false, "code": r.code, "error": r.error } })),
            }
        };
        fleet_local::remove_confirm(&self.state_dir, id)?;
        self.done_confirm(id, result, answer, "operator", t);
        Ok(true)
    }

    fn label_matches(&self, link: &Value) -> Result<bool, String> {
        let want = canonical_json(link)?;
        let seal = self.console.seal.lock();
        let s = seal.as_ref().ok_or("the sealed store does not read")?;
        Ok(s.get("fleet-key-link").is_some_and(|l| l == want))
    }
}

/// The current link of `fleet.json` (`{consoleId, relayId}`), or None.
pub fn current_link(state_dir: &Path) -> Option<Value> {
    let m = crate::fleet_agent::load_link_json(state_dir).ok().flatten()?;
    Some(json!({ "consoleId": str_of(m.get("consoleId"))?, "relayId": str_of(m.get("relayId"))? }))
}

/// Names of the sealed link keys a leave wipes (when `fleet-key-link` names the leaving link).
pub const KEY_NAMES: [&str; 4] = ["fleet-key", "fleet-key-old", "fleet-key-next", "fleet-key-link"];

impl Effects for Frames {
    fn settings(&self, read_only: bool, confirm: &[String]) {
        self.take_settings(read_only, confirm, crate::codec::now_ms());
    }

    fn link(&self) -> Option<Value> {
        current_link(&self.state_dir)
    }

    fn refuse_key(&self, hint: &str, t: i64) -> Result<Outcome, String> {
        // The refusal and the removal in one write of fleet.json, before the journal says `applied` (A3-H1).
        let mut st = self.st.lock();
        let link = st.link.as_mut().ok_or("the relay has no link")?;
        let mut next = link.clone();
        let changed = next.refuse_key(hint);
        self.save(&next)?;
        *link = next;
        drop(st);
        if changed {
            let mut r = Record::new("operator", "fleet.roster-refused", "ok");
            r.detail = json!({ "hint": hint });
            self.audit(r, t);
            let mut r = Record::new("operator", "fleet.roster.cancel", "ok");
            r.detail = json!({ "hint": hint, "by": "operator" });
            self.audit(r, t);
            self.push_state(t);
        }
        Ok(Outcome::Done(changed))
    }

    fn accept_scopes(&self, request_id: &str, hash: &str, t: i64) -> Result<Outcome, String> {
        // Already in place: this request was applied before a crash (its widening is in the audit).
        let applied = self.console.audit.lock().entries().iter().any(|e| {
            str_of(e.get("action")) == Some("fleet.scopes") && e.get("detail").is_some_and(|d| str_of(d.get("requestId")) == Some(request_id) && d.get("widened") == Some(&Value::Bool(true)))
        });
        if applied {
            return Ok(Outcome::Done(false));
        }
        let mut st = self.st.lock();
        let link = st.link.as_mut().ok_or("the relay has no link")?;
        let mut next = link.clone();
        if ft::accept_scopes(&mut next, request_id, hash).is_err() {
            return Ok(Outcome::Stale);
        }
        self.save(&next)?;
        let detail = json!({ "scopes": next.scopes, "widened": true, "requestId": request_id, "generation": next.scope_generation });
        *link = next;
        drop(st);
        let mut rec = Record::new("operator", "fleet.scopes", "ok");
        rec.detail = detail;
        self.audit(rec, t);
        self.push_state(t);
        Ok(Outcome::Done(true))
    }

    fn trust_ca(&self, generation: u64, fingerprint: &str, t: i64) -> Result<Outcome, String> {
        let r = crate::fleet_agent::trust_ca(&self.state_dir, generation, fingerprint);
        let mut rec = Record::new("operator", "fleet.ca.trust", if r.is_ok() { "ok" } else { "refused" });
        rec.detail = json!({ "generation": generation, "fingerprint": fingerprint, "result": if r.is_ok() { "ok" } else { "refused" } });
        self.audit(rec, t);
        Ok(match r {
            Ok(()) => Outcome::Done(true),
            Err(why) => Outcome::Refused(why),
        })
    }

    fn trust_time_reset(&self, manifest: &Value, t: i64) -> Result<Outcome, String> {
        let (prev_seq, prev_issued) = fleet_local::stored_trust(&self.state_dir);
        match crate::fleet_agent::trust_time_apply(&self.state_dir, manifest, t) {
            Ok(Some((from, to, seq))) => {
                let mut r = Record::new("operator", "fleet.trust-time-reset", "ok");
                r.detail = json!({ "from": from, "to": to, "manifestSeq": seq, "previousSeq": prev_seq, "previousIssuedAt": prev_issued });
                self.audit(r, t);
                Ok(Outcome::Done(true))
            }
            Ok(None) => Ok(Outcome::Done(false)),
            Err(why) => Ok(Outcome::Refused(why)),
        }
    }

    fn confirm(&self, id: &str, run: bool, t: i64) -> Result<Outcome, String> {
        self.decide(id, run, t).map(Outcome::Done)
    }

    fn notify_left(&self) {
        self.events.send("bye", json!({ "reason": "left" }));
    }

    fn wipe_key(&self, link: &Value) -> Result<(), String> {
        {
            let seal = self.console.seal.lock();
            let s = seal.as_ref().ok_or("the sealed store does not read")?;
            if s.get("fleet-key").is_none() && s.get("fleet-key-link").is_none() {
                return Ok(());
            }
        }
        if !self.label_matches(link)? {
            return Ok(());
        }
        let mut seal = self.console.seal.lock();
        let s = seal.as_mut().ok_or("the sealed store does not read")?;
        for name in KEY_NAMES {
            s.remove(name)?;
        }
        Ok(())
    }

    fn remove_link(&self, link: &Value) -> Result<(), String> {
        if current_link(&self.state_dir).as_ref() == Some(link) {
            let path = self.state_dir.join(ft::LINK_FILE);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("{}: {e}", path.display()));
                }
            }
            self.st.lock().link = None;
        }
        Ok(())
    }

    fn audit(&self, r: Record, t: i64) {
        Frames::audit(self, r, t);
    }

    fn audited(&self, action: &str, id: &str) -> bool {
        self.console.audit.lock().entries().iter().any(|e| str_of(e.get("action")) == Some(action) && e.get("detail").and_then(|d| str_of(d.get("id"))) == Some(id))
    }
}

impl RelayFrames for Frames {
    fn request(&self, op: &str, body: &Value, t: i64) -> Result<Value, Refusal> {
        let r = match op {
            "nonce" => self.nonce(body, t),
            "call" => self.call(body, t),
            "people" => self.people(body, t),
            "roster" => self.roster(body, t),
            "roster-cancel" => self.roster_cancel(body, t),
            "policy" => self.policy(body, t),
            "scopes" => self.scopes(body, t),
            _ => Err(Refused::op()),
        };
        r.map_err(refusal)
    }

    fn hello_fields(&self) -> Map<String, Value> {
        let st = self.st.lock();
        let Some(link) = st.link.as_ref() else { return Map::new() };
        let mut m = link.hello_fields();
        m.insert("readOnly".into(), Value::Bool(st.local.read_only || st.local.unreadable || !link.bootstrap.done));
        m.insert("confirm".into(), json!(st.local.confirm));
        m
    }
}

#[cfg(test)]
mod tests {
    //! 16.1 f-trust through the frames of a running relay (the same `RelayFrames` the network channel and the
    //! same-process `Local` channel call): read only, confirm here, the Meeting Hub admin rule, the 7.2 entries and
    //! the read projection.

    use super::*;
    use crate::console::{Approved, LicenseCandidate, LicenseState, LicenseView, Need, ProductSection, RouteSpec, BODY_MAX};
    use crate::console_webauthn::testkit::Authenticator;
    use crate::fleet_trust::tests::{bootstrapped, entry_of, link_map, standard, ALICE, ALL, CID, ORIGIN, RID, RP, T0};

    const UMA: &str = "uma@acme.example";

    static ROUTES: [RouteSpec; 3] = [
        RouteSpec { method: "GET", path: "spokes/relays", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: BODY_MAX },
        RouteSpec { method: "POST", path: "spokes/block", role: Role::Admin, action: "spokes.block", target: "node", stepup: true, need: Need::Any, security: true, keys: &["node", "hours", "reason"], body_max: 4096 },
        RouteSpec { method: "POST", path: "meet/seats/pick", role: Role::Manager, action: "meet.seats.pick", target: "principal", stepup: true, need: Need::Any, security: false, keys: &["principal", "pick"], body_max: 1024 },
    ];

    struct Section {
        meet: bool,
        admins: Vec<String>,
        ran: Mutex<Vec<String>>,
        /// A license view the test sets (the 4.7 object, its state and the service view); None: valid, always on.
        lic: Mutex<Option<(Value, LicenseState, crate::console::ServiceView)>>,
    }

    impl ProductSection for Section {
        fn routes(&self) -> &'static [RouteSpec] {
            &ROUTES
        }
        fn sections(&self, _l: LicenseState) -> Vec<&'static str> {
            vec![]
        }
        fn relay_info(&self, _t: i64) -> Value {
            json!({ "version": "1.2.3", "uptimeSeconds": 5, "fips": false, "tlsNotAfter": null })
        }
        fn license(&self, t: i64) -> LicenseView {
            if let Some((license, state, service)) = self.lic.lock().clone() {
                return LicenseView { license, problem: None, state, service };
            }
            LicenseView { license: json!({ "state": "valid", "daysLeft": 100 }), problem: None, state: LicenseState::Valid, service: crate::console::ServiceView::on(t) }
        }
        fn overview_cards(&self, _a: bool, _t: i64) -> Vec<Value> {
            vec![]
        }
        fn attention(&self, admin: bool, _t: i64) -> Vec<Value> {
            let mut v = vec![json!({ "kind": "spokes-silent", "severity": "warn", "args": { "n": 2 } })];
            if admin {
                v.push(json!({ "kind": "admin-suspended", "severity": "bad", "args": { "email": "bob@acme.example" } }));
            }
            v
        }
        fn search(&self, _q: &str, _a: bool, _t: i64) -> Vec<Value> {
            vec![]
        }
        fn security_actions(&self) -> &'static [&'static str] {
            &["spokes.block"]
        }
        fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
            match call.spec.path {
                "spokes/relays" => Ok(SectionAnswer::Read(json!({ "ok": true, "directory": { "version": 3, "signer": "alice@acme.example" }, "crl": { "version": 1, "nextUpdate": 1_700_000_000 }, "owner": "alice@acme.example" }))),
                path => {
                    self.ran.lock().push(format!("{path} by {} admin {}", call.caller.email, call.caller.admin));
                    Ok(SectionAnswer::Done { answer: json!({ "ok": true }), target: str_of(call.body.get("node")).or(str_of(call.body.get("principal"))).unwrap_or("-").to_owned(), detail: json!({}) })
                }
            }
        }
        fn execute(&self, run: &Approved) -> Result<Value, ApiError> {
            self.ran.lock().push(format!("{} executed", run.action));
            Ok(json!({ "ok": true }))
        }
        fn license_candidate(&self, _token: &str, _t: i64) -> Result<LicenseCandidate, ApiError> {
            Err(ApiError::of("license-refused"))
        }
        fn license_install(&self, _token: &str, _t: i64) -> Result<Value, ApiError> {
            Err(ApiError::of("license-refused"))
        }
        fn request_target(&self, _kind: &str, target: &Value) -> Result<Value, ApiError> {
            Ok(target.clone())
        }
        fn admin_rule(&self, email: &str, _anchor: &str) -> AdminRule {
            if self.meet && !self.admins.iter().any(|a| a == email) {
                AdminRule::NotRelayAdmin
            } else {
                AdminRule::Admin
            }
        }
    }

    struct World {
        f: Arc<Frames>,
        events: Arc<Mutex<Vec<(String, Value)>>>,
        dir: PathBuf,
        console: Arc<Console>,
        section: Arc<Section>,
        alice: Authenticator,
        uma: Authenticator,
    }

    fn world(name: &str, product: Product, admins: &[&str]) -> World {
        let dir = std::env::temp_dir().join(format!("lucid-fleet-exec-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::store::make_dir(&dir).unwrap();
        let console = crate::console::open_headless(product, &dir, Arc::new(crate::log::Logger::new("fleet-test"))).unwrap();
        let section = Arc::new(Section { meet: product == Product::Meet, admins: admins.iter().map(|s| (*s).to_owned()).collect(), ran: Mutex::new(Vec::new()), lic: Mutex::new(None) });
        console.attach(section.clone());
        let (mut alice, mut uma) = (Authenticator::new(61), Authenticator::new(62));
        let entries = [entry_of(&mut alice, ALICE, "admin", false), entry_of(&mut uma, UMA, "user-manager", false)];
        let link = bootstrapped(&entries, standard(), false);
        let mut m = link_map(&entries, standard(), &ALL);
        link.write_into(&mut m);
        crate::store::write_private(&dir.join(ft::LINK_FILE), crate::codec::stringify(&Value::Object(m)).as_bytes()).unwrap();
        let (events, log) = Events::capture();
        let f = open(console.clone(), dir.clone(), product, events);
        World { f, events: log, dir, console, section, alice, uma }
    }

    fn write(w: &mut World, who: &str, path: &str, action: &str, target: &str, params: Value, t: i64) -> Result<Value, Refusal> {
        let n = w.f.request("nonce", &json!({ "n": 1 }), t)?["nonces"][0].as_str().unwrap().to_owned();
        let targets = vec![(RID.to_owned(), n.clone())];
        let ch = ft::stepup_challenge(CID, action, target, &params, &targets).unwrap();
        let key = if who == ALICE { &mut w.alice } else { &mut w.uma };
        let auth = json!({ "mode": "one", "credential": key.assert(RP, ORIGIN, &ch, None), "nonce": n, "targets": ft::targets_value(&targets) });
        let role = if who == ALICE { "admin" } else { "user-manager" };
        w.f.request("call", &json!({ "method": "POST", "path": path, "query": "", "body": params, "caller": { "email": who, "role": role }, "auth": auth }), t)
    }

    fn read(w: &World, path: &str, t: i64) -> Result<Value, Refusal> {
        w.f.request("call", &json!({ "method": "GET", "path": path, "query": "", "body": {}, "caller": { "email": ALICE, "role": "admin" }, "auth": null }), t)
    }

    fn block(w: &mut World, t: i64) -> Result<Value, Refusal> {
        write(w, ALICE, "spokes/block", "spokes.block", "n_1", json!({ "node": "n_1", "hours": 2, "reason": "junk" }), t)
    }

    fn audit_actions(w: &World) -> Vec<(String, String, String)> {
        w.console.audit.lock().entries().iter().map(|e| (str_of(e.get("action")).unwrap_or("").to_owned(), str_of(e.get("actor")).unwrap_or("").to_owned(), str_of(e.get("result")).unwrap_or("").to_owned())).collect()
    }

    /// AC-2a 3.4.1 (R7-L1): the `state` body's license object for every case of
    /// tests/admin_console_fleet_state_frame_v1.json, from the license view the product gives.
    #[test]
    fn the_state_frame_license_object_matches_the_vector() {
        use crate::console::{ServiceState, ServiceView};
        let v: Value = serde_json::from_str(include_str!("../tests/admin_console_fleet_state_frame_v1.json")).unwrap();
        const WHYS: [&str; 5] = ["none", "wrong-product", "wrong-root", "invalid", "expired"];
        for (i, c) in v["cases"].as_array().unwrap().iter().enumerate() {
            let name = c["name"].as_str().unwrap();
            let product = if c["product"] == "meet" { Product::Meet } else { Product::Spokes };
            let w = world(&format!("state-frame-{i}"), product, &[ALICE]);
            let now = c["now"].as_i64().unwrap();
            let want = &c["frame"]["body"]["license"];
            let s = &want["service"];
            let state = match want["state"].as_str().unwrap() {
                "valid" => LicenseState::Valid,
                "grace" => LicenseState::Grace,
                "expired" => LicenseState::Expired,
                _ => LicenseState::None,
            };
            let service = ServiceView {
                state: match s["state"].as_str().unwrap() {
                    "on" => ServiceState::On,
                    "grace" => ServiceState::Grace,
                    "upgrade-period" => ServiceState::UpgradePeriod,
                    _ => ServiceState::Stopped,
                },
                stops_at: s["stopsAt"].as_i64(),
                why: s["why"].as_str().map(|x| *WHYS.iter().find(|w| **w == x).unwrap()),
                reason: None,
                upgrade_period_ends: s["upgradePeriodEnds"].as_i64(),
                license_id: want["id"].as_str().map(str::to_owned),
                exp: want["exp"].as_i64(),
                at: now,
            };
            // daysLeft is floor((exp - now) / 1 day), null with no fitting license
            let days = want["exp"].as_i64().map(|exp| (exp - now).div_euclid(86_400_000));
            assert_eq!(want["daysLeft"].as_i64(), days, "{name}: the vector's daysLeft");
            *w.section.lic.lock() = Some((json!({ "daysLeft": want["daysLeft"] }), state, service));
            let body = w.f.state_body(now);
            assert_eq!(&body["license"], want, "{name}");
        }
    }

    #[test]
    fn read_only_refuses_every_write_and_no_read_and_an_unreadable_file_is_read_only() {
        let mut w = world("read-only", Product::Spokes, &[]);
        assert!(block(&mut w, T0).is_ok());
        fleet_local::set_settings(&w.dir, Some(true), None).unwrap();
        w.f.poll(T0);
        assert_eq!(block(&mut w, T0).unwrap_err().code, "fleet-read-only");
        assert!(read(&w, "spokes/relays", T0).is_ok());
        assert!(audit_actions(&w).iter().any(|(a, actor, r)| a == "fleet.read-only" && actor == "operator" && r == "ok"));
        fleet_local::set_settings(&w.dir, Some(false), None).unwrap();
        w.f.poll(T0);
        assert!(block(&mut w, T0).is_ok());
        std::fs::write(w.dir.join(fleet_local::LOCAL_FILE), b"{\"v\":3").unwrap();
        w.f.poll(T0);
        assert_eq!(block(&mut w, T0).unwrap_err().code, "fleet-read-only");
        assert_eq!(w.f.hello_fields()["readOnly"], true);
    }

    #[test]
    fn every_write_and_refused_write_is_in_the_relays_audit_and_reads_are_summarized() {
        let mut w = world("audit", Product::Spokes, &[]);
        block(&mut w, T0).unwrap();
        let mut bad = Authenticator::new(99);
        let n = w.f.request("nonce", &json!({ "n": 1 }), T0).unwrap()["nonces"][0].as_str().unwrap().to_owned();
        let targets = vec![(RID.to_owned(), n.clone())];
        let params = json!({ "node": "n_2", "hours": 1, "reason": "x" });
        let ch = ft::stepup_challenge(CID, "spokes.block", "n_2", &params, &targets).unwrap();
        let auth = json!({ "mode": "one", "credential": bad.assert(RP, ORIGIN, &ch, None), "nonce": n, "targets": ft::targets_value(&targets) });
        let r = w.f.request("call", &json!({ "method": "POST", "path": "spokes/block", "query": "", "body": params, "caller": { "email": ALICE, "role": "admin" }, "auth": auth }), T0);
        assert_eq!(r.unwrap_err().code, "fleet-roster");
        for _ in 0..3 {
            read(&w, "spokes/relays", T0).unwrap();
        }
        w.f.flush_summaries(T0 + 60_000, false);
        let acts = audit_actions(&w);
        assert!(acts.iter().any(|(a, actor, r)| a == "fleet.call" && actor == ALICE && r == "ok"), "{acts:?}");
        assert!(acts.iter().any(|(a, _, r)| a == "fleet.call" && r == "refused"), "{acts:?}");
        assert_eq!(acts.iter().filter(|(a, _, _)| a == "fleet.reads.summary").count(), 1);
        let e = w.console.audit.lock().entries().into_iter().find(|e| str_of(e.get("action")) == Some("fleet.reads.summary")).unwrap();
        assert_eq!(e["detail"]["count"], 3);
        // Never a nonce, an assertion or a challenge in an entry.
        let text = Value::Array(w.console.audit.lock().entries().into_iter().map(Value::Object).collect()).to_string();
        assert!(!text.contains(&n) && !text.contains("clientDataJSON") && !text.contains("authenticatorData"));
    }

    #[test]
    fn confirm_here_queues_runs_on_confirm_drops_on_refuse_and_after_24_hours() {
        let mut w = world("confirm", Product::Spokes, &[]);
        fleet_local::set_settings(&w.dir, None, Some(vec!["people".into()])).unwrap();
        w.f.poll(T0);
        let a = block(&mut w, T0).unwrap();
        assert_eq!(a["status"], 202);
        assert_eq!(a["body"]["code"], "fleet-confirm");
        let id = a["body"]["confirm"].as_str().unwrap().to_owned();
        assert!(w.section.ran.lock().is_empty(), "nothing ran yet");
        fleet_local::add_command(&w.dir, "confirm", json!({ "id": id })).unwrap();
        w.f.poll(T0 + 1);
        assert_eq!(w.section.ran.lock().len(), 1);
        assert!(w.events.lock().iter().any(|(op, b)| op == "confirm-done" && b["id"] == id.as_str() && b["result"] == "ok"));
        // Refused: dropped.
        let id2 = block(&mut w, T0 + 2).unwrap()["body"]["confirm"].as_str().unwrap().to_owned();
        fleet_local::add_command(&w.dir, "refuse", json!({ "id": id2 })).unwrap();
        w.f.poll(T0 + 3);
        assert_eq!(w.section.ran.lock().len(), 1);
        assert!(w.events.lock().iter().any(|(op, b)| op == "confirm-done" && b["id"] == id2.as_str() && b["result"] == "refused"));
        // Read only set after queueing: the confirm re-checks and does not run it.
        let id3 = block(&mut w, T0 + 4).unwrap()["body"]["confirm"].as_str().unwrap().to_owned();
        fleet_local::set_settings(&w.dir, Some(true), None).unwrap();
        fleet_local::add_command(&w.dir, "confirm", json!({ "id": id3 })).unwrap();
        w.f.poll(T0 + 5);
        assert_eq!(w.section.ran.lock().len(), 1);
        assert!(w.events.lock().iter().any(|(op, b)| op == "confirm-done" && b["id"] == id3.as_str() && b["result"] == "failed"));
        fleet_local::set_settings(&w.dir, Some(false), None).unwrap();
        w.f.poll(T0 + 6);
        // Unconfirmed for 24 hours: dropped.
        let id4 = block(&mut w, T0 + 7).unwrap()["body"]["confirm"].as_str().unwrap().to_owned();
        w.f.expire_confirmations(T0 + 7 + 86_400_000);
        assert!(w.events.lock().iter().any(|(op, b)| op == "confirm-done" && b["id"] == id4.as_str() && b["result"] == "expired"));
        // A confirmation a crash left running is closed unknown at start, never run again.
        let id5 = block(&mut w, T0 + 8).unwrap()["body"]["confirm"].as_str().unwrap().to_owned();
        fleet_local::mark_running(&w.dir, &id5).unwrap();
        w.f.close_running(T0 + 9);
        assert!(w.events.lock().iter().any(|(op, b)| op == "confirm-done" && b["id"] == id5.as_str() && b["result"] == "unknown"));
        assert_eq!(w.section.ran.lock().len(), 1);
    }

    #[test]
    fn meeting_hub_admin_writes_need_the_principal_in_admins_and_seat_picks_do_not() {
        let mut w = world("meet-admins", Product::Meet, &[]);
        assert_eq!(block(&mut w, T0).unwrap_err().code, "not-relay-admin");
        let pick = json!({ "principal": "pat@acme.example", "pick": true });
        assert!(write(&mut w, ALICE, "meet/seats/pick", "meet.seats.pick", "pat@acme.example", pick.clone(), T0).is_ok());
        assert!(write(&mut w, UMA, "meet/seats/pick", "meet.seats.pick", "pat@acme.example", pick, T0).is_ok());
        // A user manager is never an admin.
        assert_eq!(write(&mut w, UMA, "spokes/block", "spokes.block", "n_1", json!({ "node": "n_1", "hours": 2, "reason": "x" }), T0).unwrap_err().code, "role");
        let mut w = world("meet-admins-in", Product::Meet, &[ALICE]);
        assert!(block(&mut w, T0).is_ok());
    }

    #[test]
    fn read_health_alone_serves_the_allowlist_whatever_role_is_stated() {
        let w = world("projection", Product::Spokes, &[]);
        w.f.request("scopes", &json!({ "scopes": ["read-health"] }), T0).unwrap();
        let a = read(&w, "spokes/relays", T0).unwrap();
        let text = a["body"].to_string();
        assert!(!text.contains("alice") && !text.contains("owner") && !text.contains("signer"), "{text}");
        assert_eq!(a["body"]["directory"]["version"], 3);
        // Rows are refused, not reduced; a frame naming a scope or a projection is refused.
        let mut w2 = w;
        assert_eq!(read(&w2, "spokes/nodes", T0).unwrap_err().code, "fleet-scope");
        let r = w2.f.request("call", &json!({ "method": "GET", "path": "spokes/relays", "query": "", "body": {}, "caller": { "email": ALICE, "role": "admin" }, "auth": null, "projection": "full" }), T0);
        assert_eq!(r.unwrap_err().code, "fleet-op");
        // No write scope left: no nonce, no write.
        assert!(w2.f.request("nonce", &json!({ "n": 1 }), T0).is_err());
        assert_eq!(block(&mut w2, T0).unwrap_err().code, "fleet-scope");
        // Pushed attention under read-health: the allowlist only.
        w2.f.push_attention(T0);
        let pushed = w2.events.lock().iter().rev().find(|(op, _)| op == "attention").map(|(_, b)| b.clone()).unwrap();
        assert_eq!(pushed, json!({ "items": [{ "kind": "spokes-silent", "severity": "warn", "args": { "n": 2 } }] }));
    }
}
