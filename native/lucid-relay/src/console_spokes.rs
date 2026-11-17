// The Admin Console's Remote Spokes section (contract AC-1, 4.8, 4.10 and 7.4): the blocks a console admin places on
// this relay (console-blocks.json, with the 7-day time accounting of M9), the ring of hubs refused for want of a seat,
// the matching rules that mark rs.* requests done when the relay observes their outcome (3.8), and the I9 product
// section the console calls. The relay's own books stay in relay.rs; this file holds the console's rules about them.

use crate::codec::{as_object, parse_json, safe_int, str_of, stringify};
use crate::console::{ApiError, Approved, Caller, LicenseCandidate, LicenseRecord, LicenseState, LicenseView, Need, ProductSection, Role, RouteSpec, SectionAnswer, SectionCall, ServiceState, ServiceView};
use crate::license::{license_state, License, LicenseStateName};
use crate::log::Fields;
use crate::relay::{NodeFilter, State, Taken, BODY_BYTES};
use crate::store::{read_text, write_private};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

pub const BLOCKS_FILE: &str = "console-blocks.json";
/// At most this many blocks at once (4.8).
pub const BLOCKS_MAX: usize = 1000;
/// A block lasts 1 to 720 hours (4.8).
pub const BLOCK_HOURS_MAX: i64 = 720;
const HOUR_MS: i64 = 3_600_000;
/// One admin may block a target while its single-admin block time in the last 7 days is at most 24 hours (M9).
pub const SINGLE_ADMIN_MS: i64 = 24 * HOUR_MS;
pub const WINDOW_MS: i64 = 7 * 24 * HOUR_MS;
/// Single-admin block spans kept for the accounting; when full, a new single-admin block becomes an approval.
const SPENT_MAX: usize = 4 * BLOCKS_MAX;
/// Hubs refused with `user.uncounted`: the newest 200, shown for 7 days (4.8).
pub const UNCOUNTED_MAX: usize = 200;
/// What a blocked node's signed requests answer (403, `node.blocked`).
pub const NODE_BLOCKED: &str = "this node is blocked on this relay by its admins";
/// `GET /v1/console/requests` from a hub that is not an active console admin's (403, `console.requests-refused`).
pub const REQUESTS_REFUSED: &str = "Only the hubs of console admins can read Admin Console requests.";
/// The request kinds of this product (3.8).
pub const REQUEST_KINDS: [&str; 3] = ["rs.revoke", "rs.renew", "rs.seat"];

/// How a block was placed: on one admin's word, or after a second admin approved it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockPath {
    Single,
    Approved,
}

impl BlockPath {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockPath::Single => "single",
            BlockPath::Approved => "approved",
        }
    }

    fn parse(s: &str) -> Option<BlockPath> {
        match s {
            "single" => Some(BlockPath::Single),
            "approved" => Some(BlockPath::Approved),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub node: String,
    pub placed_by: String,
    pub placed_at: i64,
    pub until: i64,
    pub reason: String,
    pub path: BlockPath,
}

impl Block {
    /// The `blocked` object of the nodes view and of `POST /console/api/spokes/block`.
    pub fn view(&self) -> Value {
        json!({ "until": self.until, "by": self.placed_by, "reason": self.reason, "placedAt": self.placed_at, "path": self.path.as_str() })
    }
}

/// A single-admin block's span, kept 7 days for the accounting even after the block ends or is lifted.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Spent {
    node: String,
    from: i64,
    to: i64,
}

/// What one admin's block request becomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockDecision {
    /// Runs at once on one admin's word.
    Single,
    /// Waits for a second admin (3.7).
    Approval,
}

/// Why a block or an unblock did not run.
#[derive(Debug, PartialEq, Eq)]
pub enum BlockError {
    /// BLOCKS_MAX blocks are in force; the minutes until the first one ends.
    Full(i64),
    /// The node holds no block.
    NotBlocked,
    /// The list could not be written (fail closed: nothing changed).
    Write(String),
}

/// console-blocks.json: owner-only, fail closed (a file that does not read back stops the relay), dropped at `until`.
pub struct Blocks {
    file: Option<PathBuf>,
    list: Vec<Block>,
    spent: Vec<Spent>,
}

fn block_of(v: &Value) -> Option<Block> {
    let o = v.as_object()?;
    let node = str_of(o.get("node")).filter(|n| crate::identity::is_node_id(n))?;
    Some(Block {
        node: node.to_owned(),
        placed_by: str_of(o.get("placedBy"))?.to_owned(),
        placed_at: safe_int(o.get("placedAt"))?,
        until: safe_int(o.get("until"))?,
        reason: str_of(o.get("reason"))?.to_owned(),
        path: BlockPath::parse(str_of(o.get("path"))?)?,
    })
}

fn spent_of(v: &Value) -> Option<Spent> {
    let o = v.as_object()?;
    let node = str_of(o.get("node")).filter(|n| crate::identity::is_node_id(n))?;
    let (from, to) = (safe_int(o.get("from"))?, safe_int(o.get("to"))?);
    (from <= to).then(|| Spent { node: node.to_owned(), from, to })
}

impl Blocks {
    /// An empty list held in memory only (no state folder: the console is off or a test).
    pub fn memory() -> Blocks {
        Blocks { file: None, list: Vec::new(), spent: Vec::new() }
    }

    /// Read the list at start. No file is an empty list; a file that does not read back is Err (fail closed).
    pub fn open(file: &Path) -> Result<Blocks, String> {
        let mut b = Blocks { file: Some(file.to_owned()), list: Vec::new(), spent: Vec::new() };
        let Some(text) = read_text(file) else { return Ok(b) };
        let bad = || format!("{} does not read back: the relay does not start without its block list (move it aside only after checking it)", file.display());
        let parsed = parse_json(&text).ok_or_else(bad)?;
        let o = as_object(&parsed).filter(|o| crate::codec::num_is(o.get("v"), 1.0)).ok_or_else(bad)?;
        let blocks = o.get("blocks").and_then(Value::as_array).ok_or_else(bad)?;
        let spent = o.get("spent").and_then(Value::as_array).ok_or_else(bad)?;
        b.list = blocks.iter().map(block_of).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        b.spent = spent.iter().map(spent_of).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        if b.list.len() > BLOCKS_MAX || b.spent.len() > SPENT_MAX {
            return Err(bad());
        }
        Ok(b)
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        let blocks: Vec<Value> = self
            .list
            .iter()
            .map(|b| json!({ "node": b.node, "placedBy": b.placed_by, "placedAt": b.placed_at, "until": b.until, "reason": b.reason, "path": b.path.as_str() }))
            .collect();
        let spent: Vec<Value> = self.spent.iter().map(|s| json!({ "node": s.node, "from": s.from, "to": s.to })).collect();
        let text = format!("{}\n", stringify(&json!({ "v": 1, "blocks": blocks, "spent": spent })));
        write_private(file, text.as_bytes()).map_err(|e| e.to_string())
    }

    /// Drop blocks past `until` and spans older than the window; written when something went.
    pub fn sweep(&mut self, t: i64) -> Result<bool, String> {
        let (blocks, spans) = (self.list.len(), self.spent.len());
        self.list.retain(|b| b.until > t);
        self.spent.retain(|s| s.to > t - WINDOW_MS);
        let changed = blocks != self.list.len() || spans != self.spent.len();
        if changed {
            self.save()?;
        }
        Ok(changed)
    }

    /// The node's block in force at `t`, if any.
    pub fn get(&self, node: &str, t: i64) -> Option<&Block> {
        self.list.iter().find(|b| b.node == node && b.until > t)
    }

    pub fn is_blocked(&self, node: &str, t: i64) -> bool {
        self.get(node, t).is_some()
    }

    /// Blocks in force at `t`.
    pub fn active(&self, t: i64) -> impl Iterator<Item = &Block> {
        self.list.iter().filter(move |b| b.until > t)
    }

    /// The node's single-admin block time inside the 7 days before `t`, counting what is still to run.
    pub fn single_admin_ms(&self, node: &str, t: i64) -> i64 {
        let start = t - WINDOW_MS;
        self.spent.iter().filter(|s| s.node == node && s.to > start).map(|s| s.to - s.from.max(start)).sum()
    }

    /// M9: one admin may block while the target's single-admin time in 7 days, this block included, stays at most
    /// 24 hours; never alone for an active console admin's hub (`admin_hub`, the caller's judgment, unknown counts).
    pub fn decide(&self, node: &str, hours: i64, admin_hub: bool, t: i64) -> BlockDecision {
        let enough_room = self.spent.len() < SPENT_MAX;
        if admin_hub || !enough_room || self.single_admin_ms(node, t) + hours * HOUR_MS > SINGLE_ADMIN_MS {
            BlockDecision::Approval
        } else {
            BlockDecision::Single
        }
    }

    /// Place (or replace) the node's block for `hours` from `t`. Err(Full) at BLOCKS_MAX; nothing changes on Err.
    pub fn place(&mut self, node: &str, hours: i64, reason: &str, by: &str, path: BlockPath, t: i64) -> Result<Block, BlockError> {
        let block = Block { node: node.to_owned(), placed_by: by.to_owned(), placed_at: t, until: t + hours * HOUR_MS, reason: reason.to_owned(), path };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        self.list.retain(|b| b.until > t);
        if let Some(old) = self.list.iter().position(|b| b.node == node) {
            // A replaced single-admin block counts only up to now.
            self.end_spent(node, t);
            self.list.remove(old);
        }
        if self.list.len() >= BLOCKS_MAX {
            let first = self.list.iter().map(|b| b.until).min().unwrap_or(t);
            self.list = list;
            self.spent = spent;
            return Err(BlockError::Full(((first - t).max(0) + 59_999) / 60_000));
        }
        self.list.push(block.clone());
        if path == BlockPath::Single {
            self.spent.push(Spent { node: node.to_owned(), from: t, to: block.until });
        }
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            return Err(BlockError::Write(e));
        }
        Ok(block)
    }

    fn end_spent(&mut self, node: &str, t: i64) {
        for s in self.spent.iter_mut().filter(|s| s.node == node && s.to > t) {
            s.to = t.max(s.from);
        }
    }

    /// Whether `by` alone may lift the node's block before `until`: only the person who placed it (4.8).
    pub fn may_lift_alone(&self, node: &str, by: &str, t: i64) -> Option<bool> {
        self.get(node, t).map(|b| b.placed_by == by)
    }

    /// Lift the node's block now; its single-admin time counts only up to now.
    pub fn lift(&mut self, node: &str, t: i64) -> Result<Block, BlockError> {
        let Some(i) = self.list.iter().position(|b| b.node == node && b.until > t) else { return Err(BlockError::NotBlocked) };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        let gone = self.list.remove(i);
        self.end_spent(node, t);
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            return Err(BlockError::Write(e));
        }
        Ok(gone)
    }
}

/// A hub refused with `user.uncounted`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Uncounted {
    pub node: String,
    pub email: Option<String>,
    pub at: i64,
}

/// The bounded ring of hubs refused for want of a seat (newest 200, in memory).
#[derive(Default)]
pub struct UncountedRing(VecDeque<Uncounted>);

impl UncountedRing {
    /// One refusal; a node already in the ring moves to the front with the new time.
    pub fn push(&mut self, node: &str, email: Option<&str>, at: i64) {
        self.0.retain(|u| u.node != node);
        self.0.push_back(Uncounted { node: node.to_owned(), email: email.map(str::to_owned), at });
        while self.0.len() > UNCOUNTED_MAX {
            self.0.pop_front();
        }
    }

    /// The refusals of the last 7 days, newest first.
    pub fn recent(&self, t: i64) -> Vec<&Uncounted> {
        self.0.iter().rev().filter(|u| t - u.at < WINDOW_MS).collect()
    }
}

/// What the relay observed that may complete an rs.* request (3.8).
pub enum Observed<'a> {
    /// A CRL was accepted (or is held): its version and every serial it lists.
    Crl { version: i64, revoked: &'a std::collections::HashSet<String> },
    /// A certificate signed in: its node, serial and `exp`, and the `exp` of the request's serial when known.
    Certificate { node: &'a str, serial: &'a str, exp: i64 },
    /// A hub was admitted with a seat at `at`.
    Seat { node: &'a str, at: i64 },
}

/// The `observed.by` words when `what` completes the waiting request `kind` for `target` (`{node, serial}`) asked at
/// `requested_at`, or None. `serial_exp` is the `exp` the relay knows for the target serial (rs.renew needs it).
pub fn observes(kind: &str, target: &Value, requested_at: i64, what: &Observed, serial_exp: Option<i64>) -> Option<String> {
    let node = str_of(target.get("node"))?;
    let serial = str_of(target.get("serial"))?;
    match (kind, what) {
        ("rs.revoke", Observed::Crl { version, revoked }) => revoked.contains(serial).then(|| format!("crl {version}")),
        ("rs.renew", Observed::Certificate { node: n, serial: s, exp }) => {
            let old = serial_exp?;
            (*n == node && *s != serial && *exp > old).then(|| format!("certificate {s}"))
        }
        ("rs.seat", Observed::Seat { node: n, at }) => (*n == node && *at > requested_at).then(|| "seat".to_owned()),
        _ => None,
    }
}

/// R7-M1: the Remote Spokes license clock in the state folder:
/// `{highWater, reset: null or {before, after}}` (ms; `reset` the offline reset not yet audited).
pub const LICENSE_TIME_FILE: &str = "spokes-license-time.json";
/// R7-M2: the last fitting license as 4.7 compares it, `{product, root, id, edition, users, relays, exp}`.
pub const LAST_LICENSE_FILE: &str = "spokes-last-license.json";
const CLOCK_SAVE_MS: i64 = 60_000;

/// R7-M1: the time license deadlines (expiry, grace, reminders) are judged in on Remote Spokes. It never goes back:
/// the later of the host clock and the high-water mark advanced by the monotonic clock, so moving the host clock back
/// cannot extend a license or its grace, in a run or across a restart. Only the offline `license-time reset` sets the
/// mark down, to the host clock (operator level, decision 67). An absent file is created at start from the host clock.
pub struct LicenseClock {
    high_water: i64,
    since: std::time::Instant,
    file: Option<PathBuf>,
    saved_at: i64,
    /// A reset the offline command made, to audit at the next start (`license.time-reset`).
    reset: Option<(i64, i64)>,
}

impl LicenseClock {
    /// The clock of `dir` (None: in memory). A file that does not read back stops the start (fail closed).
    pub fn open(dir: Option<&Path>) -> Result<LicenseClock, String> {
        let file = dir.map(|d| d.join(LICENSE_TIME_FILE));
        let mut c = LicenseClock { high_water: i64::MIN, since: std::time::Instant::now(), file, saved_at: i64::MIN, reset: None };
        if let Some(f) = c.file.as_ref().filter(|f| f.exists()) {
            let bad = || format!("{LICENSE_TIME_FILE} is not valid; the relay will not start until it is fixed or restored");
            let v: Value = serde_json::from_slice(&std::fs::read(f).map_err(|e| format!("{LICENSE_TIME_FILE} cannot be read: {e}"))?).map_err(|_| bad())?;
            let o = v.as_object().filter(|o| o.keys().all(|k| ["highWater", "reset"].contains(&k.as_str()))).ok_or_else(bad)?;
            c.high_water = o.get("highWater").and_then(Value::as_i64).ok_or_else(bad)?;
            c.reset = match o.get("reset") {
                None | Some(Value::Null) => None,
                Some(r) => Some((r.get("before").and_then(Value::as_i64).ok_or_else(bad)?, r.get("after").and_then(Value::as_i64).ok_or_else(bad)?)),
            };
            c.saved_at = c.high_water;
        }
        Ok(c)
    }

    /// The effective time at host time `t` (ms); the mark moves up with it and is saved at most once a minute.
    pub fn now(&mut self, t: i64) -> i64 {
        let eff = self.peek(t);
        self.high_water = eff;
        self.since = std::time::Instant::now();
        if eff.saturating_sub(self.saved_at) >= CLOCK_SAVE_MS || eff < self.saved_at {
            self.save();
        }
        eff
    }

    /// The effective time without moving the mark (read-only views).
    pub fn peek(&self, t: i64) -> i64 {
        let ran = i64::try_from(self.since.elapsed().as_millis()).unwrap_or(i64::MAX);
        t.max(self.high_water.saturating_add(ran))
    }

    /// A reset made offline since the last start, taken once for the audit: (before, after).
    pub fn take_reset(&mut self) -> Option<(i64, i64)> {
        let r = self.reset.take();
        if r.is_some() {
            self.save();
        }
        r
    }

    fn value(&self) -> Value {
        json!({
            "highWater": self.high_water,
            "reset": self.reset.map(|(b, a)| json!({ "before": b, "after": a })),
        })
    }

    pub fn save(&mut self) {
        let Some(f) = &self.file else { return };
        if write_owner_only(f, &self.value()).is_ok() {
            self.saved_at = self.high_water;
        }
    }

    /// The offline `license-time reset` (R7-M1): the mark set to the host clock `wall`. Returns (before, after).
    pub fn reset_to(&mut self, wall: i64) -> Result<(i64, i64), String> {
        let before = self.high_water;
        self.high_water = wall;
        self.reset = Some((before, wall));
        let f = self.file.clone().ok_or("no state folder")?;
        write_owner_only(&f, &self.value())?;
        Ok((before, wall))
    }

    pub fn high_water(&self) -> i64 {
        self.high_water
    }
}

/// Written atomically, owner-only.
fn write_owner_only(f: &Path, v: &Value) -> Result<(), String> {
    write_private(f, format!("{v}\n").as_bytes()).map_err(|e| e.to_string())
}

/// R7-M2: the stored reference license: Ok(None) when there is none, Err when the file does not read back (fail
/// closed: the caller compares against `LastLicense::unknown()`).
pub fn read_last_license(dir: &Path) -> Result<Option<LicenseRecord>, String> {
    let f = dir.join(LAST_LICENSE_FILE);
    if !f.exists() {
        return Ok(None);
    }
    let bad = || format!("{LAST_LICENSE_FILE} is not valid");
    let v: Value = serde_json::from_slice(&std::fs::read(&f).map_err(|e| e.to_string())?).map_err(|_| bad())?;
    let s = |k: &str| str_of(v.get(k)).map(str::to_owned).ok_or_else(bad);
    let n = |k: &str| v.get(k).and_then(Value::as_i64).ok_or_else(bad);
    if s("product")? != "spokes" {
        return Err(bad());
    }
    Ok(Some(LicenseRecord { product: crate::license::Product::Spokes, root: s("root")?, id: s("id")?, edition: s("edition")?, users: n("users")?, relays: n("relays")?, exp: n("exp")? }))
}

/// R7-M2: keep `l` as the reference license.
pub fn write_last_license(dir: &Path, l: &License) -> Result<(), String> {
    let r = LicenseRecord::of(l);
    write_owner_only(&dir.join(LAST_LICENSE_FILE), &json!({ "product": "spokes", "root": r.root, "id": r.id, "edition": r.edition, "users": r.users, "relays": r.relays, "exp": r.exp }))
}

/// A reference no offered license matches: the stored one did not read back, so every install needs a second admin.
pub fn unknown_reference() -> LicenseRecord {
    LicenseRecord { product: crate::license::Product::Spokes, root: String::new(), id: String::new(), edition: String::new(), users: i64::MAX, relays: i64::MAX, exp: i64::MAX }
}

/// The 4.7 `service` of a Remote Spokes relay at license-clock time `eff` (ms).
pub fn service_of(licensed: Option<&License>, refused: Option<&(crate::license::ServiceWhy, String)>, eff: i64) -> ServiceView {
    let secs = eff.div_euclid(1000);
    let s = match licensed {
        Some(l) => crate::license::service_state(Ok(l), None, secs),
        None => crate::license::service_state(Err(refused.map_or(crate::license::ServiceWhy::None, |(w, _)| *w)), None, secs),
    };
    // the verifier's words only for a refused token (8.1 `license.why`)
    let reason = refused.filter(|_| licensed.is_none()).map(|(_, r)| r.clone());
    let state = match s.state {
        crate::license::ServiceStateName::On => ServiceState::On,
        crate::license::ServiceStateName::Grace => ServiceState::Grace,
        crate::license::ServiceStateName::UpgradePeriod => ServiceState::UpgradePeriod,
        crate::license::ServiceStateName::Stopped => ServiceState::Stopped,
    };
    ServiceView {
        state,
        stops_at: s.stops_at.map(|x| x * 1000),
        why: s.why.map(|w| w.as_str()),
        reason,
        upgrade_period_ends: None,
        license_id: licensed.map(|l| l.id.clone()),
        exp: licensed.map(|l| l.exp * 1000),
        at: eff,
    }
}

/// Whether the caller reads people's emails in this section: admins and user managers (4.8, R4-8).
pub fn sees_people(caller: &Caller) -> bool {
    caller.admin || caller.manager
}

/// Body of `POST /console/api/spokes/block`: `{node, hours, reason}` (the step-up taken out by the console).
pub fn parse_block(body: &Value) -> Result<(String, i64, String), String> {
    let o = body.as_object().ok_or("malformed")?;
    let node = str_of(o.get("node")).filter(|n| crate::identity::is_node_id(n)).ok_or("node must be a node id (n_ and 32 hex)")?;
    let hours = safe_int(o.get("hours")).filter(|h| (1..=BLOCK_HOURS_MAX).contains(h)).ok_or("hours must be a whole number from 1 to 720")?;
    let reason = reason_of(o.get("reason"))?;
    Ok((node.to_owned(), hours, reason))
}

/// Body of `POST /console/api/spokes/unblock`: `{node, reason}`.
pub fn parse_unblock(body: &Value) -> Result<(String, String), String> {
    let o = body.as_object().ok_or("malformed")?;
    let node = str_of(o.get("node")).filter(|n| crate::identity::is_node_id(n)).ok_or("node must be a node id (n_ and 32 hex)")?;
    Ok((node.to_owned(), reason_of(o.get("reason"))?))
}

/// A reason: 1 to 500 characters after cleaning (section 0: controls, bidi and default-ignorable characters out).
pub fn reason_of(v: Option<&Value>) -> Result<String, String> {
    let raw = str_of(v).ok_or("a reason is required")?;
    let cleaned = clean(raw);
    let n = cleaned.chars().count();
    if n == 0 || n > 500 {
        return Err("a reason is 1 to 500 characters".into());
    }
    Ok(cleaned)
}

/// Section 0 cleaning: C0 and C1 controls, Bidi_Control and Default_Ignorable_Code_Point characters removed; trimmed.
pub fn clean(s: &str) -> String {
    let out: String = s.chars().filter(|c| !is_unclean(*c)).collect();
    out.trim().to_owned()
}

fn is_unclean(c: char) -> bool {
    let u = c as u32;
    u < 0x20
        || (0x7f..=0x9f).contains(&u)
        || u == 0x00ad
        || u == 0x034f
        || u == 0x061c
        || (0x115f..=0x1160).contains(&u)
        || (0x17b4..=0x17b5).contains(&u)
        || (0x180b..=0x180f).contains(&u)
        || (0x200b..=0x200f).contains(&u)
        || (0x202a..=0x202e).contains(&u)
        || (0x2060..=0x206f).contains(&u)
        || u == 0x3164
        || (0xfe00..=0xfe0f).contains(&u)
        || u == 0xfeff
        || u == 0xffa0
        || (0xfff0..=0xfff8).contains(&u)
        || (0x1bca0..=0x1bca3).contains(&u)
        || (0x1d173..=0x1d17a).contains(&u)
        || (0xe0000..=0xe0fff).contains(&u)
}

/// A CRL or directory body: the token and room for its JSON wrapping, as `/v1/crl` and `/v1/directory` read it.
const UPLOAD_BODY: usize = BODY_BYTES + 1024;
const LIST_DEFAULT: usize = 100;
const LIST_MAX: usize = 500;
const SEARCH_MAX: usize = 50;
const PRODUCT_WORDS: &str = "Remote Spokes";

/// The 4.8 routes, each with its role (L1): user managers read nodes with emails and seats, and nothing else is
/// theirs (every write is an admin's, R4-8). GETs check the license themselves: the section reads in every state but
/// none (expired is read-only, 2.4); block, unblock and CRL are security actions that work in every state.
pub static ROUTES: [RouteSpec; 7] = [
    RouteSpec { method: "GET", path: "spokes/nodes", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "spokes/seats", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "spokes/relays", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "spokes/crl", role: Role::Admin, action: "spokes.crl", target: "-", stepup: true, need: Need::Any, security: true, keys: &["crl"], body_max: UPLOAD_BODY },
    RouteSpec { method: "POST", path: "spokes/directory", role: Role::Admin, action: "spokes.directory", target: "-", stepup: true, need: Need::Product, security: false, keys: &["directory"], body_max: UPLOAD_BODY },
    RouteSpec { method: "POST", path: "spokes/block", role: Role::Admin, action: "spokes.block", target: "node", stepup: true, need: Need::Any, security: true, keys: &["node", "hours", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "spokes/unblock", role: Role::Admin, action: "spokes.unblock", target: "node", stepup: true, need: Need::Any, security: true, keys: &["node", "reason"], body_max: 4096 },
];

/// AC-2a 4.11: the aggregate route served only through the fleet proxy (`read-health`). Not in ROUTES, so the relay's
/// own console answers 404; fleet_exec takes this spec and calls `route` with it.
pub static FLEET_ROUTES: [RouteSpec; 1] = [RouteSpec { method: "GET", path: "spokes/counts", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 }];

/// AC-2a 8.2 `nodes` of a Remote Spokes relay row, from its latest `spokes/counts` answer: counts only, or None when
/// the answer is not one.
pub fn nodes_summary(counts: &Value) -> Option<Value> {
    let n = |group: &str, k: &str| counts.get(group)?.get(k)?.as_u64();
    Some(json!({
        "hubs": n("hubs", "total")?, "hubsOnline": n("hubs", "online")?,
        "spokes": n("spokes", "total")?, "spokesOnline": n("spokes", "online")?, "spokesSilent": n("spokes", "silent")?,
    }))
}

const SECURITY_ACTIONS: [&str; 3] = ["spokes.block", "spokes.unblock", "spokes.crl"];
const PAGES: [&str; 7] = ["hubs", "spokes", "relays", "seats", "license", "logs", "requests"];

/// The Remote Spokes product section (I9). It holds the relay's state weakly: the state holds the console.
pub struct SpokesSection {
    state: Weak<Mutex<State>>,
}

/// I9 constructor: server.rs attaches it to the console.
pub fn section(state: Weak<Mutex<State>>) -> Arc<dyn ProductSection> {
    Arc::new(SpokesSection { state })
}

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

fn not_found(thing: &str) -> ApiError {
    ApiError::with("not-found", format!("There is no such {thing}."))
}

fn write_failed(_why: String) -> ApiError {
    ApiError::of("write-failed")
}

fn full(minutes: i64) -> ApiError {
    ApiError::rate(minutes * 60)
}

fn block_error(e: BlockError) -> ApiError {
    match e {
        BlockError::Full(minutes) => full(minutes.max(1)),
        BlockError::NotBlocked => ApiError::with("stale", "Nothing was changed: the node is not blocked."),
        BlockError::Write(why) => write_failed(why),
    }
}

fn license_state_of(s: LicenseStateName) -> LicenseState {
    match s {
        LicenseStateName::Valid => LicenseState::Valid,
        LicenseStateName::Grace => LicenseState::Grace,
        LicenseStateName::Expired => LicenseState::Expired,
    }
}

/// decodeURIComponent of a query part with `+` as a space, or None for a bad escape or bad UTF-8.
fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// The query's filters among `allowed`; an unknown name answers 400 "Unknown filter: <name>." (4.1).
fn filters(query: &str, allowed: &[&str]) -> Result<Vec<(String, String)>, ApiError> {
    let mut out = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = decode(k).ok_or_else(|| invalid("A filter could not be read."))?;
        if !allowed.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown filter: {}.", clean(&k))));
        }
        let v = decode(v).ok_or_else(|| invalid("A filter could not be read."))?;
        if !v.is_empty() {
            out.push((k, v));
        }
    }
    Ok(out)
}

/// The 4.8 nodes filters from a query.
pub fn node_filter(query: &str) -> Result<NodeFilter, ApiError> {
    let mut f = NodeFilter { limit: LIST_DEFAULT, ..NodeFilter::default() };
    for (k, v) in filters(query, &["role", "state", "q", "limit"])? {
        match k.as_str() {
            "role" if v == "hub" || v == "spoke" => f.role = Some(v),
            "role" => return Err(invalid("role is hub or spoke.")),
            "state" if ["ok", "silent", "expiring", "expired", "revoked", "blocked"].contains(&v.as_str()) => f.state = Some(v),
            "state" => return Err(invalid("state is ok, silent, expiring, expired, revoked or blocked.")),
            "q" => {
                let q = clean(&v);
                if !(1..=100).contains(&q.chars().count()) {
                    return Err(invalid("The search text is 1 to 100 characters."));
                }
                f.q = Some(q);
            }
            _ => {
                f.limit = v.parse::<usize>().ok().filter(|n| (1..=LIST_MAX).contains(n)).ok_or_else(|| invalid("limit is 1 to 500."))?;
            }
        }
    }
    Ok(f)
}

/// 4.7: the offered license as the core compares it against `reference`: the license in force, else the last fitting
/// one this relay kept (R7-M2, `spokes-last-license.json`); None only when this relay never had one (a first license).
fn candidate_of(reference: Option<LicenseRecord>, offered: &crate::license::License, dev: bool, t: i64) -> LicenseCandidate {
    let (state, _) = license_state(offered, t.div_euclid(1000));
    LicenseCandidate {
        offered: LicenseRecord::of(offered),
        valid: state == LicenseStateName::Valid,
        ended: state == LicenseStateName::Expired,
        reference,
        view: license_object(offered, dev, None, t),
    }
}

fn license_object(l: &crate::license::License, dev: bool, used: Option<i64>, t: i64) -> Value {
    let (state, days_left) = license_state(l, t.div_euclid(1000));
    json!({
        "id": l.id, "org": l.org, "product": l.product().as_str(), "edition": l.edition, "users": l.users, "used": used,
        "relays": l.relays, "exp": l.exp, "state": state.as_str(), "daysLeft": days_left, "dev": dev, "graceDays": l.effective_grace_days(),
    })
}

impl SpokesSection {
    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> Result<R, ApiError> {
        let state = self.state.upgrade().ok_or_else(|| ApiError::of("state-unreadable"))?;
        let mut st = state.lock();
        Ok(f(&mut st))
    }

    /// Whether blocking `node` always needs a second admin: a hub whose user is an active console admin, or a node
    /// this relay cannot vouch for (never seen here, or a hub whose email it has not seen since the start).
    fn admin_hub(st: &State, node: &str) -> bool {
        match st.node_seen(node) {
            None => true,
            Some((role, _)) if role != "hub" => false,
            Some((_, None)) => true,
            Some((_, Some(email))) => st.console().is_none_or(|c| c.is_active_admin(&email)),
        }
    }

    fn block(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (node, hours, reason) = parse_block(call.body).map_err(invalid)?;
        let params = json!({ "node": node, "hours": hours, "reason": reason });
        // 5 blocks an hour per admin (`rate`, section 5), counted by the console's limits.
        if let Some(console) = self.with(|st| st.console())? {
            console.limit(crate::console_limits::Limit::Blocks, &call.caller.email, call.t)?;
        }
        self.with(|st| {
            if st.block_decision(&node, hours, Self::admin_hub(st, &node), call.t) == BlockDecision::Approval {
                return Ok(SectionAnswer::Second { target: node.clone(), params: params.clone(), detail: json!({ "hours": hours }) });
            }
            let placed = st.place_block(&node, hours, &reason, &call.caller.email, BlockPath::Single, call.t).map_err(block_error)?;
            let detail = json!({ "hours": hours, "until": placed.until, "path": "single" });
            Ok(SectionAnswer::Done { answer: json!({ "ok": true, "blocked": placed.view() }), target: node.clone(), detail })
        })?
    }

    fn unblock(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (node, reason) = parse_unblock(call.body).map_err(invalid)?;
        self.with(|st| match st.may_lift_alone(&node, &call.caller.email, call.t) {
            None => Err(not_found("block")),
            Some(false) => Ok(SectionAnswer::Second { target: node.clone(), params: json!({ "node": node, "reason": reason }), detail: json!({}) }),
            Some(true) => {
                let gone = st.lift_block(&node, &call.caller.email, call.t).map_err(block_error)?;
                Ok(SectionAnswer::Done { answer: json!({ "ok": true }), target: node.clone(), detail: json!({ "placedBy": gone.placed_by, "until": gone.until }) })
            }
        })?
    }

    /// CRL and directory uploads: accepted and refused exactly as `POST /v1/crl` and `POST /v1/directory`.
    fn upload(&self, call: &SectionCall, field: &str) -> Result<SectionAnswer, ApiError> {
        let token = str_of(call.body.get(field)).ok_or_else(|| invalid(format!("{field} is required.")))?;
        let by = Fields::new().with("console", call.caller.email.as_str());
        let crl = field == "crl";
        let taken = self.with(|st| if crl { st.take_crl(token, call.t, &by) } else { st.take_directory(token, call.t, &by) })?;
        match taken.map_err(write_failed)? {
            Err(Taken { reason, .. }) if crl => Err(ApiError::with("crl-refused", format!("This revocation list cannot be used: {reason}."))),
            Err(Taken { reason, .. }) => Err(ApiError::with("directory-refused", format!("This relay directory cannot be used: {reason}."))),
            Ok(version) => {
                let target = format!("{field} {version}");
                Ok(SectionAnswer::Done { answer: json!({ "ok": true, "version": version }), target, detail: json!({ "version": version }) })
            }
        }
    }

    fn read_needs_license(call: &SectionCall) -> Result<(), ApiError> {
        if call.license == LicenseState::None {
            return Err(ApiError::with("license-needed", format!("This needs a license that includes {PRODUCT_WORDS}.")));
        }
        Ok(())
    }
}

impl ProductSection for SpokesSection {
    fn routes(&self) -> &'static [RouteSpec] {
        &ROUTES
    }

    fn sections(&self, license: LicenseState) -> Vec<&'static str> {
        if license == LicenseState::None {
            Vec::new()
        } else {
            PAGES.to_vec()
        }
    }

    fn relay_info(&self, t: i64) -> Value {
        self.with(|st| st.relay_info(t)).unwrap_or(Value::Null)
    }

    fn license(&self, t: i64) -> LicenseView {
        match self.with(|st| (st.license_view(t), st.service_view(t))) {
            Ok((Some((view, state)), service)) => LicenseView { license: view, problem: None, state: license_state_of(state), service },
            Ok((None, service)) => {
                let problem = service.reason.as_ref().map_or_else(|| "This relay has no Remote Spokes license.".to_owned(), |r| format!("This license cannot be used here: {}.", clean(r)));
                LicenseView { license: Value::Null, problem: Some(problem), state: LicenseState::None, service }
            }
            Err(_) => LicenseView { license: Value::Null, problem: Some("This relay has no Remote Spokes license.".into()), state: LicenseState::None, service: ServiceView::none(t) },
        }
    }

    fn overview_cards(&self, _admin: bool, t: i64) -> Vec<Value> {
        self.with(|st| st.spokes_cards(t)).unwrap_or_default()
    }

    fn attention(&self, admin: bool, t: i64) -> Vec<Value> {
        self.with(|st| st.spokes_attention(admin, t)).unwrap_or_default()
    }

    fn search(&self, q: &str, admin: bool, _t: i64) -> Vec<Value> {
        if !admin {
            return Vec::new();
        }
        self.with(|st| st.spokes_search(q, SEARCH_MAX)).unwrap_or_default()
    }

    fn security_actions(&self) -> &'static [&'static str] {
        &SECURITY_ACTIONS
    }

    fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        match (call.spec.method, call.spec.path) {
            ("GET", "spokes/nodes") => {
                Self::read_needs_license(call)?;
                let f = node_filter(call.query)?;
                let console = self.with(|st| st.console())?;
                let logs = console.map(|c| c.spoke_log_counts()).unwrap_or_default();
                Ok(SectionAnswer::Read(self.with(|st| st.spokes_nodes(&f, sees_people(call.caller), &logs, call.t))?))
            }
            ("GET", "spokes/seats") => {
                Self::read_needs_license(call)?;
                filters(call.query, &[])?;
                Ok(SectionAnswer::Read(self.with(|st| st.spokes_seats(call.t))?))
            }
            ("GET", "spokes/relays") => {
                Self::read_needs_license(call)?;
                filters(call.query, &[])?;
                Ok(SectionAnswer::Read(self.with(|st| st.spokes_relays())?))
            }
            ("GET", "spokes/counts") => {
                filters(call.query, &[])?;
                Ok(SectionAnswer::Read(self.with(|st| st.spokes_counts(call.t))?))
            }
            ("POST", "spokes/crl") => self.upload(call, "crl"),
            ("POST", "spokes/directory") => self.upload(call, "directory"),
            ("POST", "spokes/block") => self.block(call),
            ("POST", "spokes/unblock") => self.unblock(call),
            _ => Err(not_found("page")),
        }
    }

    fn execute(&self, run: &Approved) -> Result<Value, ApiError> {
        match run.action {
            "spokes.block" => {
                let (node, hours, reason) = parse_block(run.params).map_err(|why| ApiError::with("stale", format!("Nothing was changed: {why}.")))?;
                // The sole-admin path is still one admin's word: it counts toward the 24 hours.
                let path = if run.approved_by.is_some() { BlockPath::Approved } else { BlockPath::Single };
                let placed = self.with(|st| st.place_block(&node, hours, &reason, run.requested_by, path, run.t))?.map_err(block_error)?;
                Ok(json!({ "ok": true, "blocked": placed.view() }))
            }
            "spokes.unblock" => {
                let (node, _) = parse_unblock(run.params).map_err(|why| ApiError::with("stale", format!("Nothing was changed: {why}.")))?;
                let by = run.approved_by.unwrap_or(run.requested_by);
                self.with(|st| st.lift_block(&node, by, run.t))?.map_err(block_error)?;
                Ok(json!({ "ok": true }))
            }
            _ => Err(not_found("action")),
        }
    }

    fn license_candidate(&self, token: &str, t: i64) -> Result<LicenseCandidate, ApiError> {
        self.with(|st| {
            let offered = st.license_offered(token, t).map_err(|r| ApiError::with("license-refused", format!("This license cannot be used here: {r}.")))?;
            st.license_target().map_err(|p| ApiError::with("license-path", format!("This relay reads its license from {p}. Replace that file and restart the relay.")))?;
            let eff = st.license_time(t);
            Ok(candidate_of(st.license_reference(), &offered.license, offered.dev, eff))
        })?
    }

    fn license_install(&self, token: &str, t: i64) -> Result<Value, ApiError> {
        self.with(|st| {
            let offered = st.license_offered(token, t).map_err(|r| ApiError::with("license-refused", format!("This license cannot be used here: {r}.")))?;
            if license_state(&offered.license, st.license_time(t).div_euclid(1000)).0 == LicenseStateName::Expired {
                return Err(ApiError::of("license-ended"));
            }
            st.license_target().map_err(|p| ApiError::with("license-path", format!("This relay reads its license from {p}. Replace that file and restart the relay.")))?;
            st.install_license(offered, t).map_err(write_failed)?;
            Ok(st.license_view(t).map(|(v, _)| v).unwrap_or(Value::Null))
        })?
    }

    fn request_target(&self, kind: &str, target: &Value) -> Result<Value, ApiError> {
        if !REQUEST_KINDS.contains(&kind) {
            return Err(invalid(format!("Unknown request kind: {}.", clean(kind))));
        }
        let o = target.as_object().ok_or_else(|| invalid("The target is a node and a certificate serial."))?;
        if o.keys().any(|k| k != "node" && k != "serial") {
            return Err(invalid("The target is a node and a certificate serial."));
        }
        let node = str_of(o.get("node")).filter(|n| crate::identity::is_node_id(n)).ok_or_else(|| invalid("node must be a node id (n_ and 32 hex)."))?;
        self.with(|st| {
            let serial = match str_of(o.get("serial")) {
                Some(s) if crate::identity::is_serial(s) => s.to_owned(),
                Some(_) => return Err(invalid("serial must be 32 lower-case hex.")),
                None => st.node_serial(node).ok_or_else(|| not_found("node"))?,
            };
            if kind == "rs.revoke" && st.is_revoked(&serial) {
                return Err(ApiError::with("stale", "Nothing was changed: that certificate is already revoked."));
            }
            if kind == "rs.seat" && st.node_seen(node).is_some_and(|(role, _)| role != "hub") {
                return Err(invalid("A license seat is for a hub."));
            }
            Ok(json!({ "node": node, "serial": serial }))
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;
    const A: &str = "n_0123456789abcdef0123456789abcdef";
    const B: &str = "n_fedcba9876543210fedcba9876543210";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lucid-console-spokes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(BLOCKS_FILE)
    }

    #[test]
    fn blocks_persist_and_end_at_until() {
        let file = temp("persist");
        let mut b = Blocks::open(&file).unwrap();
        let placed = b.place(A, 2, "stolen laptop", "alice@acme.example", BlockPath::Single, T0).unwrap();
        assert_eq!(placed.until, T0 + 2 * HOUR_MS);
        let again = Blocks::open(&file).unwrap();
        assert_eq!(again.get(A, T0 + 1).map(|x| x.reason.as_str()), Some("stolen laptop"));
        assert!(again.is_blocked(A, T0 + 2 * HOUR_MS - 1));
        assert!(!again.is_blocked(A, T0 + 2 * HOUR_MS), "a block ends at until");
        let mut again = again;
        assert!(again.sweep(T0 + 2 * HOUR_MS).unwrap());
        assert_eq!(Blocks::open(&file).unwrap().active(T0).count(), 0);
    }

    #[test]
    fn a_block_list_that_does_not_read_back_stops_the_relay() {
        let file = temp("bad");
        std::fs::write(&file, "{\"v\":1,\"blocks\":[{\"node\":\"x\"}],\"spent\":[]}").unwrap();
        assert!(Blocks::open(&file).is_err());
        std::fs::write(&file, "not json").unwrap();
        assert!(Blocks::open(&file).is_err());
    }

    #[test]
    fn time_accounting_over_seven_days() {
        let mut b = Blocks::memory();
        assert_eq!(b.decide(A, 24, false, T0), BlockDecision::Single);
        assert_eq!(b.decide(A, 25, false, T0), BlockDecision::Approval);
        b.place(A, 20, "r", "alice@acme.example", BlockPath::Single, T0).unwrap();
        // 20 h used: 4 more alone, 5 more needs a second admin, even after the block ended.
        let later = T0 + 21 * HOUR_MS;
        assert_eq!(b.decide(A, 4, false, later), BlockDecision::Single);
        assert_eq!(b.decide(A, 5, false, later), BlockDecision::Approval);
        // Another target has its own 24 hours.
        assert_eq!(b.decide(B, 24, false, later), BlockDecision::Single);
        // Seven days after it began, the time is spent no more.
        assert_eq!(b.decide(A, 24, false, T0 + WINDOW_MS + 20 * HOUR_MS), BlockDecision::Single);
        // A block lifted early counts only up to the lift.
        let mut c = Blocks::memory();
        c.place(A, 24, "r", "alice@acme.example", BlockPath::Single, T0).unwrap();
        c.lift(A, T0 + HOUR_MS).unwrap();
        assert_eq!(c.single_admin_ms(A, T0 + HOUR_MS), HOUR_MS);
        // An approved block does not count.
        let mut d = Blocks::memory();
        d.place(A, 100, "r", "alice@acme.example", BlockPath::Approved, T0).unwrap();
        assert_eq!(d.decide(A, 24, false, T0 + 1), BlockDecision::Single);
        // A console admin's hub is always an approval.
        assert_eq!(Blocks::memory().decide(A, 1, true, T0), BlockDecision::Approval);
    }

    #[test]
    fn only_the_placer_lifts_alone() {
        let mut b = Blocks::memory();
        b.place(A, 2, "r", "alice@acme.example", BlockPath::Single, T0).unwrap();
        assert_eq!(b.may_lift_alone(A, "alice@acme.example", T0 + 1), Some(true));
        assert_eq!(b.may_lift_alone(A, "bob@acme.example", T0 + 1), Some(false));
        assert_eq!(b.may_lift_alone(B, "alice@acme.example", T0 + 1), None);
        assert_eq!(b.lift(B, T0 + 1), Err(BlockError::NotBlocked));
    }

    #[test]
    fn at_most_a_thousand_blocks() {
        let mut b = Blocks::memory();
        for i in 0..BLOCKS_MAX {
            let node = format!("n_{i:032x}");
            b.place(&node, 1 + (i as i64 % 3), "r", "alice@acme.example", BlockPath::Approved, T0).unwrap();
        }
        let next = format!("n_{:032x}", BLOCKS_MAX);
        assert_eq!(b.place(&next, 1, "r", "alice@acme.example", BlockPath::Approved, T0), Err(BlockError::Full(60)));
        assert_eq!(b.active(T0).count(), BLOCKS_MAX);
        // Replacing a node's own block is not a new entry.
        assert!(b.place(&format!("n_{:032x}", 0), 5, "r", "alice@acme.example", BlockPath::Approved, T0).is_ok());
        // Once some end, there is room again.
        assert!(b.place(&next, 1, "r", "alice@acme.example", BlockPath::Approved, T0 + HOUR_MS).is_ok());
    }

    #[test]
    fn uncounted_ring_is_bounded_and_seven_days() {
        let mut r = UncountedRing::default();
        for i in 0..(UNCOUNTED_MAX + 10) {
            r.push(&format!("n_{i:032x}"), None, T0 + i as i64);
        }
        assert_eq!(r.recent(T0 + 300).len(), UNCOUNTED_MAX);
        assert_eq!(r.recent(T0 + 300)[0].node, format!("n_{:032x}", UNCOUNTED_MAX + 9));
        assert!(r.recent(T0 + WINDOW_MS + 1_000).is_empty());
        r.push(A, Some("bob@acme.example"), T0 + 500);
        r.push(A, Some("bob@acme.example"), T0 + 600);
        let mine: Vec<_> = r.recent(T0 + 700).into_iter().filter(|u| u.node == A).collect();
        assert_eq!((mine.len(), mine[0].at), (1, T0 + 600));
    }

    #[test]
    fn rs_requests_are_observed_never_claimed() {
        let serial = "5f3a0000000000000000000000000000";
        let target = json!({ "node": A, "serial": serial });
        let revoked: std::collections::HashSet<String> = [serial.to_owned()].into_iter().collect();
        let none = std::collections::HashSet::new();
        assert_eq!(observes("rs.revoke", &target, T0, &Observed::Crl { version: 7, revoked: &revoked }, None).as_deref(), Some("crl 7"));
        assert_eq!(observes("rs.revoke", &target, T0, &Observed::Crl { version: 8, revoked: &none }, None), None);
        let newer = "6000000000000000000000000000000a";
        let cert = Observed::Certificate { node: A, serial: newer, exp: 2_000 };
        assert_eq!(observes("rs.renew", &target, T0, &cert, Some(1_000)).as_deref(), Some(format!("certificate {newer}").as_str()));
        assert_eq!(observes("rs.renew", &target, T0, &cert, Some(3_000)), None, "an earlier exp is no renewal");
        assert_eq!(observes("rs.renew", &target, T0, &cert, None), None, "an unknown old exp completes nothing");
        let same = Observed::Certificate { node: A, serial, exp: 9_000 };
        assert_eq!(observes("rs.renew", &target, T0, &same, Some(1_000)), None);
        let other = Observed::Certificate { node: B, serial: newer, exp: 9_000 };
        assert_eq!(observes("rs.renew", &target, T0, &other, Some(1_000)), None);
        assert_eq!(observes("rs.seat", &target, T0, &Observed::Seat { node: A, at: T0 + 1 }, None).as_deref(), Some("seat"));
        assert_eq!(observes("rs.seat", &target, T0, &Observed::Seat { node: A, at: T0 }, None), None);
        assert_eq!(observes("rs.seat", &target, T0, &Observed::Seat { node: B, at: T0 + 1 }, None), None);
        assert_eq!(observes("meet.revoke", &target, T0, &Observed::Seat { node: A, at: T0 + 1 }, None), None);
    }

    #[test]
    fn node_filters_and_unknown_filters() {
        let f = node_filter("role=hub&state=silent&q=bob%40acme&limit=5").unwrap();
        assert_eq!((f.role.as_deref(), f.state.as_deref(), f.q.as_deref(), f.limit), (Some("hub"), Some("silent"), Some("bob@acme"), 5));
        assert_eq!(node_filter("").unwrap().limit, LIST_DEFAULT);
        let e = node_filter("owner=x").err().unwrap();
        assert_eq!((e.code, e.message.as_str()), ("invalid", "Unknown filter: owner."));
        assert!(node_filter("role=root").is_err());
        assert!(node_filter("limit=501").is_err());
        assert!(node_filter("q=%ZZ").is_err());
    }

    #[test]
    fn a_relay_that_never_had_a_license_takes_a_first_license_and_otherwise_compares_with_the_reference() {
        let cur = crate::license::License { id: "l_1".into(), org: "acme".into(), root: "n_1".into(), edition: "standard".into(), users: 20, relays: 1, exp: 1000, grace_days: 14 };
        let renewal = crate::license::License { exp: 2000, ..cur.clone() };
        let smaller = crate::license::License { users: 19, ..renewal.clone() };
        let t = 500_000;
        // Never licensed here: a first license, one admin, whatever it holds (R7-M2).
        let c = candidate_of(None, &smaller, false, t);
        assert!(c.reference.is_none() && c.single() && c.valid && !c.ended);
        // The reference license (in force, or the last one kept).
        let r = Some(LicenseRecord::of(&cur));
        let c = candidate_of(r.clone(), &renewal, false, t);
        assert_eq!(c.reference.as_ref().map(|r| r.id.as_str()), Some("l_1"));
        assert!(c.single());
        assert!(!candidate_of(r.clone(), &smaller, false, t).single());
        assert!(!candidate_of(r, &crate::license::License { id: "l_2".into(), ..renewal }, false, t).single());
    }

    #[test]
    fn routes_declare_roles_and_security_actions() {
        for r in &ROUTES {
            assert!(matches!(r.role, Role::Viewer | Role::Manager | Role::Admin), "{}", r.path);
            assert_eq!(r.stepup, r.method == "POST", "{}", r.path);
            assert_eq!(r.security, SECURITY_ACTIONS.contains(&r.action), "{}", r.path);
            // Every write is an admin's.
            if r.method == "POST" {
                assert_eq!(r.role, Role::Admin, "{}", r.path);
            }
        }
        // Seats carry people's emails: user managers and admins (R4-8).
        assert!(ROUTES.iter().any(|r| r.path == "spokes/seats" && r.role == Role::Manager));
        // The directory is no security action: it needs the product license.
        assert!(ROUTES.iter().any(|r| r.path == "spokes/directory" && r.need == Need::Product));
        // CRL uploads up to 320 KiB (3.5), checked when the tests compile.
        const _: () = assert!(UPLOAD_BODY >= 320 * 1024);
    }

    #[test]
    fn license_states_change_the_section() {
        let s = section(Weak::new());
        assert!(s.sections(LicenseState::None).is_empty(), "locked: the console shows the Security page instead");
        for state in [LicenseState::Valid, LicenseState::Grace, LicenseState::Expired] {
            assert_eq!(s.sections(state), PAGES.to_vec());
        }
        let caller = Caller { email: "alice@acme.example".into(), admin: true, manager: true, ip: "10.0.0.1".into() };
        let nodes = ROUTES.iter().find(|r| r.path == "spokes/nodes").unwrap();
        let call = SectionCall { spec: nodes, query: "", body: &Value::Null, caller: &caller, license: LicenseState::None, t: T0 };
        assert_eq!(s.route(&call).err().map(|e| e.code), Some("license-needed"));
        // Security actions stay open with no license (2.4): block, unblock and CRL never ask for the product.
        for r in ROUTES.iter().filter(|r| r.security) {
            assert_eq!(r.need, Need::Any, "{}", r.path);
        }
        assert_eq!(s.security_actions(), &SECURITY_ACTIONS);
    }

    #[test]
    fn user_managers_read_people_and_viewers_do_not() {
        let who = |admin, manager| Caller { email: "m@acme.example".into(), admin, manager, ip: "10.0.0.1".into() };
        assert!(sees_people(&who(true, true)));
        assert!(sees_people(&who(false, true)));
        assert!(!sees_people(&who(false, false)), "viewers get no emails");
        // A manager's routes in 4.8: nodes and relays (viewer reads) and seats; nothing else.
        let theirs: Vec<&str> = ROUTES.iter().filter(|r| matches!(r.role, Role::Viewer | Role::Manager)).map(|r| r.path).collect();
        assert_eq!(theirs, vec!["spokes/nodes", "spokes/seats", "spokes/relays"]);
    }

    #[test]
    fn service_stops_two_days_after_exp_and_without_a_fitting_license() {
        const DAY: i64 = 86_400_000;
        let exp = T0 / 1000 + 10 * 86_400;
        let l = License { id: "l_1".into(), org: "acme".into(), root: "n_1".into(), edition: "standard".into(), users: 20, relays: 1, exp, grace_days: 14 };
        let at = |ms: i64| service_of(Some(&l), None, ms);
        assert_eq!(at(exp * 1000 - 1).state, ServiceState::On);
        let g = at(exp * 1000);
        assert_eq!((g.state, g.stops_at, g.exp, g.license_id.as_deref()), (ServiceState::Grace, Some(exp * 1000 + 2 * DAY), Some(exp * 1000), Some("l_1")));
        let s = at(exp * 1000 + 2 * DAY);
        assert_eq!((s.state, s.why), (ServiceState::Stopped, Some("expired")));
        let none = service_of(None, None, T0);
        assert_eq!((none.state, none.why), (ServiceState::Stopped, Some("none")));
        let refused = (crate::license::ServiceWhy::WrongRoot, "license is for another root".to_owned());
        let wrong = service_of(None, Some(&refused), T0);
        assert_eq!((wrong.state, wrong.why, wrong.reason.as_deref()), (ServiceState::Stopped, Some("wrong-root"), Some("license is for another root")));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-spokes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_license_clock_never_goes_back_in_a_run_or_across_a_restart() {
        // R7-M1
        let d = tmp("clock");
        let mut c = LicenseClock::open(Some(&d)).unwrap();
        assert_eq!(c.now(T0), T0);
        assert!(c.now(T0 - 86_400_000) >= T0, "a host clock moved back changes nothing");
        assert!(c.now(T0 + 5) >= T0 + 5);
        c.save();
        drop(c);
        let mut c = LicenseClock::open(Some(&d)).unwrap();
        assert!(c.now(T0 - 10 * 86_400_000) >= T0 + 5, "nor across a restart");
        // the offline reset sets the mark to the host clock and is audited once at the next start
        let ahead = c.now(T0 + 400 * 86_400_000);
        let (before, after) = c.reset_to(T0 + 10).unwrap();
        assert_eq!((before, after), (ahead, T0 + 10));
        drop(c);
        let mut c = LicenseClock::open(Some(&d)).unwrap();
        assert_eq!(c.take_reset(), Some((ahead, T0 + 10)));
        assert_eq!(c.take_reset(), None);
        assert!(c.now(T0 + 10) < ahead);
        std::fs::write(d.join(LICENSE_TIME_FILE), b"{\"highWater\": \"x\"}").unwrap();
        assert!(LicenseClock::open(Some(&d)).is_err(), "fail closed");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_last_license_stays_the_reference_and_fails_closed() {
        // R7-M2
        let d = tmp("last");
        assert_eq!(read_last_license(&d).unwrap(), None);
        let l = License { id: "l_1".into(), org: "acme".into(), root: "n_1".into(), edition: "enterprise".into(), users: 50, relays: 3, exp: 2_000_000_000, grace_days: 2 };
        write_last_license(&d, &l).unwrap();
        let r = read_last_license(&d).unwrap().unwrap();
        assert_eq!(r, LicenseRecord::of(&l));
        let smaller = License { users: 10, exp: 2_100_000_000, ..l.clone() };
        assert!(!candidate_of(Some(r.clone()), &smaller, false, T0).single(), "smaller after removal: second admin");
        let other = License { id: "l_2".into(), exp: 2_100_000_000, ..l.clone() };
        assert!(!candidate_of(Some(r.clone()), &other, false, T0).single(), "another id: second admin");
        let earlier = License { exp: 1_900_000_000, ..l.clone() };
        assert!(!candidate_of(Some(r.clone()), &earlier, false, T0).single());
        let edition = License { edition: "standard".into(), exp: 2_100_000_000, ..l.clone() };
        assert!(!candidate_of(Some(r.clone()), &edition, false, T0).single());
        let renewal = License { exp: 2_100_000_000, ..l.clone() };
        assert!(candidate_of(Some(r), &renewal, false, T0).single(), "a valid renewal: one admin");
        std::fs::write(d.join(LAST_LICENSE_FILE), b"garbage").unwrap();
        assert!(read_last_license(&d).is_err());
        assert!(!candidate_of(Some(unknown_reference()), &renewal, false, T0).single(), "unreadable: every install needs a second admin");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_long_dashes_in_this_file() {
        let text = include_str!("console_spokes.rs");
        for c in [0x2014u32, 0x2013] {
            assert!(!text.contains(char::from_u32(c).unwrap()));
        }
        assert!(!text.contains(&format!("&{}dash;", "m")) && !text.contains(&format!("&{}dash;", "n")));
    }

    #[test]
    fn block_bodies_and_reasons() {
        assert!(parse_block(&json!({ "node": A, "hours": 1, "reason": "x" })).is_ok());
        assert!(parse_block(&json!({ "node": A, "hours": 0, "reason": "x" })).is_err());
        assert!(parse_block(&json!({ "node": A, "hours": 721, "reason": "x" })).is_err());
        assert!(parse_block(&json!({ "node": "n_x", "hours": 1, "reason": "x" })).is_err());
        assert!(parse_block(&json!({ "node": A, "hours": 1, "reason": " " })).is_err());
        assert!(parse_block(&json!({ "node": A, "hours": 1, "reason": "y".repeat(501) })).is_err());
        let bidi = format!("a{}b", char::from_u32(0x202e).unwrap());
        assert_eq!(clean(&bidi), "ab");
        assert_eq!(parse_unblock(&json!({ "node": A, "reason": "done" })).unwrap().1, "done");
    }
}
