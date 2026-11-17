// The Admin Console's Meeting Hub section (contract AC-1, 2.4, 3.1, 3.2, 3.8, 4.9, 4.10, 7.4; I8, I9). The console
// itself (sessions, passkeys, approvals, requests, audit) is src/console.rs, the same code as on the Remote Spokes
// relay; this file is what the Meeting Hub relay adds: its start (3.1 checks, the console port), the I9 product
// section whose routes call the Hub and Relay functions in process through `check_console_admin` and an Identity of
// kind `console` (L9), the device blocks kept in `denied_until` (never the denied set), the Meeting Hub license
// (`["meet"]`, the `m_` root of a self-signed `client_ca` certificate), the hooks that latch passkey anchors and
// observe `meet.*` requests, the 4.10 routes of the main port and the offline `meet console` commands.

use crate::console::{AdminRule, ApiError, Approved, Console, ConsoleConfig, Filter, LicenseCandidate, LicenseRecord, LicenseState, LicenseView, Need, ProductSection, Role, RouteSpec, SectionAnswer, SectionCall};
use crate::console_limits::Limit;
use crate::console_spokes::{clean, reason_of};
use crate::license::{license_standing, license_token_of, License, LicenseStateName, Product};
use crate::meet_license::MeetGate;
use crate::meet::{self as m, Identity, Relay, E, R};
use crate::meet_hub::{push, ConsoleHooks};
use crate::meet_json::{self as pj, obj, Obj};
use crate::store::{read_text, write_private};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

pub const BLOCKS_FILE: &str = "console-blocks.json";
pub const LICENSE_FILE: &str = "license.lic";
/// 4.10 words.
pub const CONSOLE_OFF: &str = "The Admin Console is turned off on this relay. Set console_port in relay.json.";
pub const CONSOLE_REQUEST_FIELD: &str = "console_request must be a request id (rq_ and 16 hex)";
pub const DECLINE_ID: &str = "id must be a request id (rq_ and 16 hex)";
pub const DECLINE_REASON: &str = "reason must be 1 to 500 characters";
pub const NO_REQUEST: &str = "There is no such request.";
/// 2.4: a Meeting Hub license that does not fit (logged as `license.refused` at start).
const NO_LICENSE: &str = "This relay has no Meeting Hub license.";
const PRODUCT_WORDS: &str = "Meeting Hub";
/// Blocks (M9, as 4.8): at most 1000; 1 to 720 hours; one admin while the target's single-admin time in 7 days stays
/// at most 24 hours (the 5 an hour per admin is the core console's `Limit::Blocks`).
pub const BLOCKS_MAX: usize = 1000;
pub const BLOCK_HOURS_MAX: i64 = 720;
const HOUR_MS: i64 = 3_600_000;
const SINGLE_ADMIN_MS: i64 = 24 * HOUR_MS;
const WINDOW_MS: i64 = 7 * 24 * HOUR_MS;
const SPENT_MAX: usize = 4 * BLOCKS_MAX;
/// Holds: up to 10 items on one admin's word; a placer may release their own single-admin hold within 24 hours.
const HOLD_SINGLE_MAX: usize = 10;
const HOLD_RELEASE_MS: i64 = 24 * HOUR_MS;
const LIST_DEFAULT: usize = 100;
const LIST_MAX: usize = 500;
const SEARCH_MAX: usize = 50;
const PEOPLE_STATES: [&str; 6] = ["online", "joined", "waiting", "approved", "invited", "expired"];

/// The 4.9 routes, each with its role (L1). GETs check the license themselves: the section reads in every state but
/// none; CRL uploads, blocks, unblocks and hold placement are security actions that work in every state (2.4); bridge
/// changes check the product themselves (turning a bridge off works in every state).
static ROUTES: [RouteSpec; 26] = [
    RouteSpec { method: "GET", path: "meet/people", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    // 2.4 seats and trusted time (R4-2, R3-M3): allowed in every license state
    RouteSpec { method: "GET", path: "meet/seats", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/seats/pick", role: Role::Manager, action: "meet.seats.pick", target: "principal", stepup: true, need: Need::Any, security: false, keys: &["principal", "pick"], body_max: 1024 },
    RouteSpec { method: "POST", path: "meet/seats/request", role: Role::Admin, action: "meet.seats.request", target: "-", stepup: false, need: Need::Any, security: false, keys: &["wanted"], body_max: 1024 },
    RouteSpec { method: "GET", path: "meet/clock", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/clock/confirm", role: Role::Admin, action: "meet.clock.confirm", target: "-", stepup: true, need: Need::Any, security: false, keys: &["browserTime", "reason"], body_max: 2048 },
    RouteSpec { method: "GET", path: "meet/enrollments", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/organizations", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/organizations", role: Role::Admin, action: "meet.org.set", target: "principal", stepup: true, need: Need::Product, security: false, keys: &["principal", "id", "label", "remove", "reason"], body_max: 8192 },
    RouteSpec { method: "GET", path: "meet/signer", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/crl", role: Role::Admin, action: "meet.crl", target: "-", stepup: true, need: Need::Any, security: true, keys: &["crl_pem"], body_max: m::BODY_MAX },
    RouteSpec { method: "POST", path: "meet/block", role: Role::Admin, action: "meet.block", target: "principal+device", stepup: true, need: Need::Any, security: true, keys: &["principal", "device", "hours", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/unblock", role: Role::Admin, action: "meet.unblock", target: "principal+device", stepup: true, need: Need::Any, security: true, keys: &["principal", "device", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/bridge", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/bridge", role: Role::Admin, action: "meet.bridge.set", target: "org", stepup: true, need: Need::Any, security: false, keys: &["org", "policy", "reason"], body_max: m::BODY_MAX },
    RouteSpec { method: "GET", path: "meet/bridge/audit", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/holds", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/holds", role: Role::Admin, action: "meet.holds.place", target: "-", stepup: true, need: Need::Any, security: true, keys: &["on", "principals", "cids", "reason"], body_max: m::BODY_MAX },
    RouteSpec { method: "POST", path: "meet/holds/release", role: Role::Admin, action: "meet.holds.release", target: "id", stepup: true, need: Need::Product, security: false, keys: &["id", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/release", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/release", role: Role::Admin, action: "meet.release.set", target: "version", stepup: true, need: Need::Product, security: false, keys: &["version", "files", "ios", "notes", "minimum", "reason"], body_max: 32 * 1024 },
    RouteSpec { method: "GET", path: "meet/push", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/identity", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/calls", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/servers", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/files/start", role: Role::Admin, action: "meet.files.start", target: "-", stepup: true, need: Need::Product, security: false, keys: &[], body_max: 1024 },
];

const SECURITY_ACTIONS: [&str; 5] = ["meet.block", "meet.unblock", "meet.crl", "meet.revoke", "meet.holds.place"];
const PAGES: [&str; 15] = ["people", "seats", "enrollments", "organizations", "signer", "bridges", "holds", "releases", "push", "identity", "calls", "servers", "license", "logs", "requests"];
const LOCKED_PAGES: [&str; 5] = ["security", "seats", "license", "logs", "requests"];

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

fn not_found(thing: &str) -> ApiError {
    ApiError::with("not-found", format!("There is no such {thing}."))
}

fn stale(why: &str) -> ApiError {
    ApiError::with("stale", format!("Nothing was changed: {}.", why.trim_end_matches('.')))
}

fn rate(minutes: i64) -> ApiError {
    ApiError::rate(minutes.max(1) * 60)
}

fn license_needed() -> ApiError {
    ApiError::with("license-needed", format!("This needs a license that includes {PRODUCT_WORDS}."))
}

/// A Hub or Relay function's refusal as the console answers it (8.3): its own words under `invalid`, `role`,
/// `not-found` or `stale`.
fn from_hub(e: E) -> ApiError {
    match e {
        E::Bad(w) => invalid(w),
        E::Forbidden(w) | E::Held(w, _) => ApiError::with("role", w),
        E::NotFound(w) => ApiError::with("not-found", w),
        E::Conflict(w) | E::ConflictInfo(w, _) | E::Gone(w) => stale(&w),
        E::Status(429, _, _) | E::Busy(..) => rate(1),
        other => {
            crate::meet::log_warn(&format!("console.meet-failed why={}", m::kv(&other.message())));
            ApiError::of("write-failed")
        }
    }
}

fn license_state_of(s: Option<LicenseStateName>) -> LicenseState {
    match s {
        Some(LicenseStateName::Valid) => LicenseState::Valid,
        Some(LicenseStateName::Grace) => LicenseState::Grace,
        Some(LicenseStateName::Expired) => LicenseState::Expired,
        None => LicenseState::None,
    }
}

fn writes_allowed(state: LicenseState) -> bool {
    matches!(state, LicenseState::Valid | LicenseState::Grace)
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
fn filters(query: &str, allowed: &[&str]) -> Result<HashMap<String, String>, ApiError> {
    let mut out = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = decode(k).ok_or_else(|| invalid("A filter could not be read."))?;
        if !allowed.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown filter: {}.", clean(&k))));
        }
        let v = decode(v).ok_or_else(|| invalid("A filter could not be read."))?;
        if !v.is_empty() {
            out.insert(k, v);
        }
    }
    Ok(out)
}

fn limit_of(f: &HashMap<String, String>) -> Result<usize, ApiError> {
    match f.get("limit") {
        None => Ok(LIST_DEFAULT),
        Some(v) => v.parse::<usize>().ok().filter(|n| (1..=LIST_MAX).contains(n)).ok_or_else(|| invalid("limit is 1 to 500.")),
    }
}

fn search_text(f: &HashMap<String, String>) -> Result<Option<String>, ApiError> {
    match f.get("q") {
        None => Ok(None),
        Some(v) => {
            let q = clean(v).to_lowercase();
            if !(2..=100).contains(&q.chars().count()) {
                return Err(invalid("The search text is 2 to 100 characters."));
            }
            Ok(Some(q))
        }
    }
}

/// `rq_` and 16 lower-case hex (4.10).
pub fn request_id_ok(id: &str) -> bool {
    id.strip_prefix("rq_").map(|h| h.len() == 16 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).unwrap_or(false)
}

// ── device blocks (`denied_until`) ───────────────────────────────────────────────────────────────────────────

/// One Meet device block (M9): `principal|device` until a time; never a revocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeetBlock {
    pub principal: String,
    pub device: String,
    pub placed_by: String,
    pub placed_at: i64,
    pub until: i64,
    pub reason: String,
    pub single: bool,
}

impl MeetBlock {
    fn key(&self) -> String {
        m::key(&self.principal, &self.device)
    }

    pub fn view(&self) -> Value {
        json!({"until": self.until, "by": self.placed_by, "reason": self.reason, "placedAt": self.placed_at, "path": if self.single { "single" } else { "approved" }})
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Spent {
    key: String,
    from: i64,
    to: i64,
}

/// `console-blocks.json` (owner-only, fail closed: a file that does not read back stops the relay), with each held
/// hold's path for the release rule.
pub struct MeetBlocks {
    file: Option<PathBuf>,
    list: Vec<MeetBlock>,
    spent: Vec<Spent>,
    /// hold id -> "single" or "approved" (4.9 holds `path`).
    holds: Obj,
}

impl MeetBlocks {
    pub fn memory() -> MeetBlocks {
        MeetBlocks { file: None, list: Vec::new(), spent: Vec::new(), holds: Obj::new() }
    }

    pub fn open(file: &Path) -> Result<MeetBlocks, String> {
        let mut b = MeetBlocks { file: Some(file.to_owned()), ..MeetBlocks::memory() };
        let Some(text) = read_text(file) else { return Ok(b) };
        let bad = || format!("{} does not read back: the relay does not start without its block list (move it aside only after checking it)", file.display());
        let parsed: Value = serde_json::from_str(&text).map_err(|_| bad())?;
        let o = parsed.as_object().filter(|o| o.get("v") == Some(&json!(1))).ok_or_else(bad)?;
        let block = |v: &Value| -> Option<MeetBlock> {
            let o = v.as_object()?;
            Some(MeetBlock {
                principal: o.get("principal")?.as_str()?.to_owned(),
                device: o.get("device")?.as_str()?.to_owned(),
                placed_by: o.get("placedBy")?.as_str()?.to_owned(),
                placed_at: o.get("placedAt")?.as_i64()?,
                until: o.get("until")?.as_i64()?,
                reason: o.get("reason")?.as_str()?.to_owned(),
                single: o.get("path")?.as_str()? == "single",
            })
        };
        let spent = |v: &Value| -> Option<Spent> {
            let o = v.as_object()?;
            Some(Spent { key: o.get("key")?.as_str()?.to_owned(), from: o.get("from")?.as_i64()?, to: o.get("to")?.as_i64()? })
        };
        b.list = o.get("meet").and_then(Value::as_array).ok_or_else(bad)?.iter().map(block).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        b.spent = o.get("spent").and_then(Value::as_array).ok_or_else(bad)?.iter().map(spent).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        b.holds = o.get("holds").and_then(Value::as_object).cloned().unwrap_or_default();
        if b.list.len() > BLOCKS_MAX || b.spent.len() > SPENT_MAX {
            return Err(bad());
        }
        Ok(b)
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        let list: Vec<Value> = self
            .list
            .iter()
            .map(|b| json!({"principal": b.principal, "device": b.device, "placedBy": b.placed_by, "placedAt": b.placed_at, "until": b.until, "reason": b.reason, "path": if b.single { "single" } else { "approved" }}))
            .collect();
        let spent: Vec<Value> = self.spent.iter().map(|s| json!({"key": s.key, "from": s.from, "to": s.to})).collect();
        let text = format!("{}\n", json!({"v": 1, "meet": list, "spent": spent, "holds": self.holds}));
        write_private(file, text.as_bytes()).map_err(|e| e.to_string())
    }

    /// The hub's mirror: `principal|device` -> until (seconds).
    pub fn mirror(&self, t: i64) -> HashMap<String, f64> {
        self.list.iter().filter(|b| b.until > t).map(|b| (b.key(), b.until as f64 / 1000.0)).collect()
    }

    pub fn get(&self, principal: &str, device: &str, t: i64) -> Option<&MeetBlock> {
        self.list.iter().find(|b| b.principal == principal && b.device == device && b.until > t)
    }

    pub fn active(&self, t: i64) -> usize {
        self.list.iter().filter(|b| b.until > t).count()
    }

    pub fn single_admin_ms(&self, key: &str, t: i64) -> i64 {
        let start = t - WINDOW_MS;
        self.spent.iter().filter(|s| s.key == key && s.to > start).map(|s| s.to - s.from.max(start)).sum()
    }

    /// M9: one admin while the target's single-admin time in 7 days, this block included, is at most 24 hours; never
    /// alone for a device of a relay admin.
    pub fn single_ok(&self, principal: &str, device: &str, hours: i64, relay_admin: bool, t: i64) -> bool {
        !relay_admin && self.spent.len() < SPENT_MAX && self.single_admin_ms(&m::key(principal, device), t) + hours * HOUR_MS <= SINGLE_ADMIN_MS
    }

    fn end_spent(&mut self, key: &str, t: i64) {
        for s in self.spent.iter_mut().filter(|s| s.key == key && s.to > t) {
            s.to = t.max(s.from);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place(&mut self, principal: &str, device: &str, hours: i64, reason: &str, by: &str, single: bool, t: i64) -> Result<MeetBlock, ApiError> {
        let block = MeetBlock { principal: principal.into(), device: device.into(), placed_by: by.into(), placed_at: t, until: t + hours * HOUR_MS, reason: reason.into(), single };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        self.list.retain(|b| b.until > t);
        if let Some(i) = self.list.iter().position(|b| b.key() == block.key()) {
            self.end_spent(&block.key(), t);
            self.list.remove(i);
        }
        if self.list.len() >= BLOCKS_MAX {
            let first = self.list.iter().map(|b| b.until).min().unwrap_or(t);
            self.list = list;
            self.spent = spent;
            return Err(rate(((first - t).max(0) + 59_999) / 60_000));
        }
        self.list.push(block.clone());
        if single {
            self.spent.push(Spent { key: block.key(), from: t, to: block.until });
        }
        self.spent.retain(|s| s.to > t - WINDOW_MS);
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
            return Err(ApiError::of("write-failed"));
        }
        Ok(block)
    }

    pub fn lift(&mut self, principal: &str, device: &str, t: i64) -> Result<MeetBlock, ApiError> {
        let Some(i) = self.list.iter().position(|b| b.principal == principal && b.device == device && b.until > t) else { return Err(stale("that device is not blocked")) };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        let gone = self.list.remove(i);
        self.end_spent(&gone.key(), t);
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
            return Err(ApiError::of("write-failed"));
        }
        Ok(gone)
    }

    fn hold_path(&self, id: &str) -> &str {
        self.holds.get(id).and_then(Value::as_str).unwrap_or("approved")
    }

    fn set_hold_path(&mut self, id: &str, single: bool) {
        self.holds.insert(id.into(), Value::from(if single { "single" } else { "approved" }));
        if let Err(e) = self.save() {
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
        }
    }
}

/// `{principal, device, hours, reason}` of a block, `hours` 1 to 720.
pub fn parse_block(body: &Value) -> Result<(String, String, i64, String), String> {
    let principal = m::principal(body.get("principal"));
    let device = pj::str_or(body.get("device")).trim().to_string();
    if !principal.contains('@') || device.is_empty() || device.chars().count() > 64 {
        return Err("name the person (their email) and the device".into());
    }
    let hours = body.get("hours").and_then(Value::as_i64).filter(|h| (1..=BLOCK_HOURS_MAX).contains(h)).ok_or("hours is 1 to 720")?;
    let reason = reason_of(body.get("reason"))?;
    Ok((principal, device, hours, reason))
}

pub fn parse_unblock(body: &Value) -> Result<(String, String, String), String> {
    let principal = m::principal(body.get("principal"));
    let device = pj::str_or(body.get("device")).trim().to_string();
    if !principal.contains('@') || device.is_empty() {
        return Err("name the person (their email) and the device".into());
    }
    Ok((principal, device, reason_of(body.get("reason"))?))
}

// ── the license (2.4) ────────────────────────────────────────────────────────────────────────────────────────
// The license, the upgrade period and seats live in the relay's service gate (meet_license.rs); the console reads
// and installs through it, so the gate works the same with the console off.

// ── the section ──────────────────────────────────────────────────────────────────────────────────────────────

/// The Meeting Hub product section (I9). It holds the relay weakly: the relay holds the console.
pub struct MeetSection {
    relay: Weak<Relay>,
    blocks: Mutex<MeetBlocks>,
    started: i64,
}

impl MeetSection {
    pub fn new(relay: Weak<Relay>, blocks: MeetBlocks, t: i64) -> MeetSection {
        MeetSection { relay, blocks: Mutex::new(blocks), started: t }
    }

    /// The relay's service gate (license, upgrade period, trusted time, seats).
    fn gate(relay: &Relay) -> Result<Arc<MeetGate>, ApiError> {
        relay.hub.gate().ok_or_else(|| ApiError::of("state-unreadable"))
    }

    /// The Identity a read runs as: a relay admin through check_console_admin, a user manager through
    /// check_console_reader (4.9, reads only).
    fn reader(relay: &Relay, caller: &crate::console::Caller) -> Result<Identity, ApiError> {
        if caller.admin {
            return Self::who(relay, &caller.email);
        }
        relay.hub.check_console_reader(&caller.email).map_err(|_| ApiError::of("role"))
    }

    fn relay(&self) -> Result<Arc<Relay>, ApiError> {
        self.relay.upgrade().ok_or_else(|| ApiError::of("state-unreadable"))
    }

    /// The Identity the Hub functions run as (I8): the principal must be in relay.json `admins` now.
    fn who(relay: &Relay, principal: &str) -> Result<Identity, ApiError> {
        relay.hub.check_console_admin(principal).map_err(|_| stale(&format!("{principal} is not a relay admin")))
    }

    /// Where the license is read and installed: relay.json `license`, else state_dir/license.lic.
    fn license_file(relay: &Relay) -> Option<PathBuf> {
        if !relay.settings.license.trim().is_empty() {
            return Some(PathBuf::from(relay.settings.license.trim()));
        }
        m::state_file(&relay.settings, LICENSE_FILE)
    }

    /// 4.7: an install target inside state_dir; Err names where the relay reads its license from.
    fn license_target(relay: &Relay) -> Result<PathBuf, ApiError> {
        let refuse = |p: &str| ApiError::with("license-path", format!("This relay reads its license from {p}. Replace that file and restart the relay."));
        let file = Self::license_file(relay).ok_or_else(|| refuse("relay.json"))?;
        let dir = Path::new(&relay.settings.state_dir);
        let inside = !relay.settings.state_dir.is_empty() && file.parent().map(|p| std::path::absolute(p).ok() == std::path::absolute(dir).ok()).unwrap_or(false);
        if inside {
            Ok(file)
        } else {
            Err(refuse(&file.display().to_string()))
        }
    }

    fn verify(relay: &Relay, text: &str) -> Result<(License, bool), ApiError> {
        Self::gate(relay)?.verify_candidate(text).map_err(|r| ApiError::with("license-refused", format!("This license cannot be used here: {r}.")))
    }

    /// The 4.7 reference license (R6-M1): the current fitting license while one is in force (valid or grace), else
    /// `lastLicense`; None only while `lastLicense` is null (a first license).
    fn reference(gate: &MeetGate) -> Option<LicenseRecord> {
        if gate.standing().active {
            if let Some((l, _)) = gate.license() {
                return Some(LicenseRecord::of(&l));
            }
        }
        gate.last_license().map(|l| LicenseRecord { product: Product::Meet, root: l.root, id: l.id, edition: l.edition, users: l.users, relays: l.relays, exp: l.exp })
    }

    /// The license state the console uses, from the gate's standing in trusted time (`none` covers no license, the
    /// wrong product and the wrong root).
    fn license_now(relay: &Relay) -> LicenseState {
        let Ok(gate) = Self::gate(relay) else { return LicenseState::None };
        license_state_of(gate.standing().license.state)
    }

    /// 2.4 Meet users: the seated principals (meet_license.rs, meet_seats.rs).
    fn used(relay: &Relay) -> i64 {
        Self::gate(relay).map(|g| g.seat_counts().0).unwrap_or(0)
    }

    fn license_object(&self, relay: &Relay, l: &License, dev: bool) -> Value {
        let gate = Self::gate(relay).ok();
        let t = gate.as_ref().map(|g| g.time.now()).unwrap_or_else(|| (pj::now() * 1000.0) as i64);
        let standing = license_standing(Some(l), t.div_euclid(1000));
        let days_left = crate::license::license_state(l, t.div_euclid(1000)).1;
        // 8.2 `license` (R3-M4): whether the upgrade period stays as a fallback after this license
        let upgrade = gate.as_ref().map(|g| g.upgrade()).and_then(|u| u.ends);
        let keeps = gate.as_ref().is_some_and(|g| g.keeps_period(l.grace_end()));
        json!({
            "id": l.id, "org": l.org, "product": l.product().as_str(), "edition": l.edition, "users": l.users, "used": Self::used(relay),
            "relays": l.relays, "exp": l.exp, "state": standing.state_str(), "daysLeft": days_left, "dev": dev, "graceDays": l.grace_days,
            "graceEnd": standing.grace_end.map(|g| g * 1000), "upgradePeriodEnds": upgrade.map(|e| e * 1000), "keepsUpgradePeriod": keeps,
        })
    }

    // ── the GET views ──

    fn people(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let f = filters(call.query, &["q", "org", "state", "limit"])?;
        let q = search_text(&f)?;
        let limit = limit_of(&f)?;
        if let Some(s) = f.get("state").filter(|s| !PEOPLE_STATES.contains(&s.as_str())) {
            return Err(invalid(format!("state is {}, not {}.", PEOPLE_STATES.join(", "), clean(s))));
        }
        let who = Self::reader(relay, call.caller)?;
        let gate = Self::gate(relay)?;
        let devices = relay.hub.admin_devices("", &who).map_err(from_hub)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let pending = relay.hub.admin_pending("", &who).map_err(from_hub)?;
        let directory = relay.hub.st.lock().directory.clone();
        let blocks = self.blocks.lock();
        let mut people: indexmap::IndexMap<String, Obj> = indexmap::IndexMap::new();
        fn person(people: &mut indexmap::IndexMap<String, Obj>, principal: &str, name: &str) {
            let entry = people.entry(principal.to_string()).or_insert_with(|| obj([("principal", Value::from(principal)), ("name", Value::from(name)), ("org", Value::Null), ("state", Value::from("joined")), ("devices", Value::Array(Vec::new()))]));
            if pj::s(entry, "name").is_empty() {
                entry.insert("name".into(), Value::from(name));
            }
        }
        for (p, e) in &directory {
            let name = e.get("name").and_then(Value::as_str).unwrap_or_default();
            person(&mut people, p, name);
        }
        for d in devices.get("devices").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(d, "principal");
            person(&mut people, &principal, "");
            let device = pj::s(d, "device");
            let info = directory.get(&principal).and_then(|e| e.get("devices")).and_then(|ds| ds.get(&device)).and_then(Value::as_object).cloned().unwrap_or_default();
            let serial = m::serial_of(info.get("serial"));
            let online = pj::truthy(d.get("online"));
            let row = json!({
                "device": device,
                "label": d.get("label").cloned().unwrap_or(Value::Null),
                "serial": serial,
                "notAfter": info.get("not_after").cloned().unwrap_or(Value::Null),
                "lastSeenAt": pj::as_num(d.get("last_seen")).map(|s| (s * 1000.0) as i64),
                "online": online,
                "revoked": !serial.is_empty() && relay.hub.is_denied(&serial),
                "blocked": blocks.get(&principal, &device, call.t).map(MeetBlock::view),
            });
            if let Some(p) = people.get_mut(&principal) {
                if online {
                    p.insert("state".into(), Value::from("online"));
                }
                if let Some(Value::Array(list)) = p.get_mut("devices") {
                    list.push(row);
                }
            }
        }
        for w in pending.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(w, "principal");
            if principal.is_empty() {
                continue;
            }
            let name = pj::s(w, "name");
            person(&mut people, &principal, &name);
            if let Some(p) = people.get_mut(&principal) {
                if pj::text_of(p, "state") != "online" && p.get("devices").and_then(Value::as_array).map(|d| d.is_empty()).unwrap_or(true) {
                    p.insert("state".into(), Value::from("waiting"));
                }
            }
        }
        for mbr in orgs.get("members").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(mbr, "principal");
            if let Some(p) = people.get_mut(&principal) {
                p.insert("org".into(), json!({"id": pj::s(mbr, "id"), "label": pj::s(mbr, "label")}));
            }
        }
        drop(blocks);
        let rows: Vec<Value> = people
            .into_values()
            .filter(|p| q.as_ref().map(|q| pj::s(p, "principal").contains(q.as_str()) || pj::s(p, "name").to_lowercase().contains(q.as_str())).unwrap_or(true))
            .filter(|p| f.get("org").map(|o| p.get("org").and_then(|x| x.get("id")).and_then(Value::as_str) == Some(o.as_str())).unwrap_or(true))
            .filter(|p| f.get("state").map(|s| pj::text_of(p, "state") == *s).unwrap_or(true))
            .map(|mut p| {
                let seated = gate.is_seated(&pj::s(&p, "principal"));
                p.insert("seated".into(), Value::Bool(seated));
                Value::Object(p)
            })
            .collect();
        let total = rows.len();
        let users = gate.license().map(|(l, _)| Value::from(l.users)).unwrap_or(Value::Null);
        Ok(json!({"ok": true, "people": rows.into_iter().take(limit).collect::<Vec<_>>(), "total": total, "seats": {"users": users, "used": Self::used(relay)}}))
    }

    fn enrollments(&self, relay: &Relay, call: &SectionCall, core: Option<&Console>) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let pending = relay.hub.admin_pending("", &who).map_err(from_hub)?;
        let waiting_requests = core.map(|c| c.requests_waiting("meet.approve", call.t)).unwrap_or_default();
        let rows: Vec<Value> = pending
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|w| {
                let (kind, id, csr) = (pj::s(w, "kind"), pj::s(w, "id"), pj::s(w, "csr_sha256"));
                let request = waiting_requests
                    .iter()
                    .find(|r| r.get("target").map(|t| t.get("kind").and_then(Value::as_str) == Some(kind.as_str()) && t.get("id").and_then(Value::as_str) == Some(id.as_str())).unwrap_or(false))
                    .and_then(|r| r.get("id").cloned())
                    .unwrap_or(Value::Null);
                json!({
                    "kind": kind, "id": id, "principal": pj::s(w, "principal"), "name": pj::s(w, "name"),
                    "device": w.get("device_label").or_else(|| w.get("device")).cloned().unwrap_or(Value::Null),
                    "check": pj::s(w, "check_code"), "csr_sha256": csr,
                    "at": pj::as_num(w.get("ts")).map(|s| (s * 1000.0) as i64), "request": request,
                })
            })
            .collect();
        Ok(json!({"ok": true, "waiting": rows}))
    }

    fn org_facts(relay: &Relay, who: &Identity, org: &str) -> Result<(bool, usize), ApiError> {
        let bridges = relay.hub.bridge_admin("", who).map_err(from_hub)?;
        let on = bridges.get("policies").and_then(|p| p.get(org)).and_then(|p| p.get("enabled")) == Some(&Value::Bool(true));
        Ok((on, relay.hub.pc_org_admin_count(org)))
    }

    fn organizations(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let members = orgs.get("members").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut rows = Vec::new();
        for o in orgs.get("organizations").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let id = pj::s(o, "id");
            let (on, admins) = Self::org_facts(relay, &who, &id)?;
            let policy = relay.hub.pc_policy_get(&id, "").ok().filter(|p| !p.is_empty()).map(|p| {
                let inner = p.get("policy").and_then(Value::as_object).cloned().unwrap_or_else(|| p.clone());
                json!({
                    "seq": inner.get("seq").or_else(|| p.get("seq")).cloned().unwrap_or(Value::Null),
                    "issued": inner.get("issued").or_else(|| p.get("issued")).cloned().unwrap_or(Value::Null),
                    "sha256": p.get("hash").or_else(|| p.get("sha256")).cloned().unwrap_or(Value::Null),
                    "pending_lowering": p.get("pending_lowering").cloned().unwrap_or(Value::Null),
                })
            });
            let count = members.iter().filter(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str())).count();
            rows.push(json!({"id": id, "label": pj::s(o, "label"), "members": count, "bridgesOn": on, "orgAdmins": admins, "policy": policy}));
        }
        Ok(json!({"ok": true, "organizations": rows}))
    }

    fn signer(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        Self::who(relay, &call.caller.email)?;
        let detail = crate::meet_console::Console::signer_detail(relay);
        let fields = ["healthy", "error", "root_mode", "not_after", "days_left", "intermediate_serial", "previous_serial", "previous_not_after", "root_not_after", "root_crl_days_left", "pending_key", "ledger_seq", "ledger_head", "policy"];
        let signer: Obj = fields.iter().filter_map(|k| detail.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
        let next_update = detail.get("crls").and_then(Value::as_array).and_then(|a| a.iter().filter_map(|c| c.get("next_update").cloned()).filter(|v| !v.is_null()).min_by(|a, b| pj::py_str(a).cmp(&pj::py_str(b))));
        Ok(json!({
            "ok": true, "signer": signer,
            "crl": {"root_days_left": detail.get("root_crl_days_left").cloned().unwrap_or(Value::Null), "next_update": next_update},
            "ledger": detail.get("ledger").cloned().unwrap_or(json!([])),
        }))
    }

    fn holds(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let list = relay.hub.pc_holds_list("", &who).map_err(from_hub)?;
        let blocks = self.blocks.lock();
        let rows: Vec<Value> = list
            .get("holds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|h| {
                let mut h = h.clone();
                let id = pj::s(&h, "id");
                h.insert("placedBy".into(), h.get("by").cloned().unwrap_or(Value::Null));
                h.insert("placedAt".into(), pj::as_num(h.get("placed")).map(|s| Value::from((s * 1000.0) as i64)).unwrap_or(Value::Null));
                h.insert("path".into(), Value::from(blocks.hold_path(&id)));
                Value::Object(h)
            })
            .collect();
        Ok(json!({"ok": true, "holds": rows, "on": list.get("on").cloned().unwrap_or(Value::Bool(false))}))
    }

    fn release_view(relay: &Relay) -> Value {
        let release = relay.release();
        json!({
            "ok": true,
            "release": if release.is_empty() { Value::Null } else { Value::Object(release.clone()) },
            "minimums": relay.minimums(&release),
            "min_client": relay.settings.min_client,
            "history": relay.release_history_view(),
        })
    }

    fn push_view(relay: &Relay) -> Value {
        let p = &relay.settings.push;
        let (alert, voip) = relay.hub.push_device_counts();
        let (sent, failed) = push::apns::counts();
        json!({
            "ok": true, "enabled": p.enabled, "voip": p.voip, "environment": if p.sandbox { "sandbox" } else { "production" },
            "notify_previews": relay.settings.notify_previews, "devices": {"alert": alert, "voip": voip}, "sent24h": sent, "failed24h": failed,
        })
    }

    /// Calls and links: viewers get no principals or names (rooms and a per-person number only).
    fn calls(relay: &Relay, admin: bool) -> Value {
        let summary = relay.console.summary(relay);
        let links = relay.console.links_view(relay, "");
        if admin {
            return json!({"ok": true, "summary": summary, "links": links});
        }
        let mut numbers: HashMap<String, usize> = HashMap::new();
        let mut number = |p: &str| -> usize {
            let n = numbers.len() + 1;
            *numbers.entry(p.to_string()).or_insert(n)
        };
        let rooms: Vec<Value> = summary
            .get("rooms")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|r| {
                let people: Vec<Value> = r.get("participants").and_then(Value::as_array).into_iter().flatten().map(|p| json!({"person": number(&pj::py_str(p.get("principal").unwrap_or(&Value::Null))), "since": p.get("since"), "recording": p.get("recording")})).collect();
                json!({"room": r.get("room"), "participants": people})
            })
            .collect();
        let rows: Vec<Value> = links
            .get("rows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|row| {
                let mut row = row.clone();
                let principal = pj::s(&row, "principal");
                row.remove("principal");
                row.remove("name");
                row.insert("person".into(), Value::from(number(&principal)));
                Value::Object(row)
            })
            .collect();
        let viewer_summary = json!({
            "relay": summary.get("relay"), "people_online": summary.get("people_online"), "devices_online": summary.get("devices_online"),
            "participants": summary.get("participants"), "rooms": rooms, "release": summary.get("release"),
        });
        json!({"ok": true, "summary": viewer_summary, "links": {"window_s": links.get("window_s"), "rows": rows}})
    }

    fn servers(relay: &Relay) -> Value {
        let headline = crate::meet_console::Console::signer_headline(relay);
        let files = if relay.console.has_power() {
            let f = relay.console.files();
            let uptime = pj::as_int(f.get("uptime_s")).unwrap_or(0);
            let since = if uptime > 0 { Value::from(((pj::now() as i64) - uptime) * 1000) } else { Value::Null };
            json!({"state": f.get("state").cloned().unwrap_or(Value::Null), "since": since})
        } else {
            Value::Null
        };
        json!({"ok": true, "signer": {"healthy": headline.get("healthy"), "days_left": headline.get("days_left")}, "files": files})
    }

    // ── the writes ──

    fn org_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let b = call.body;
        let principal = m::principal(b.get("principal"));
        reason_of(b.get("reason")).map_err(invalid)?;
        let remove = b.get("remove") == Some(&Value::Bool(true));
        if !principal.contains('@') {
            return Err(invalid("name the person (their email)"));
        }
        let who = Self::who(relay, &call.caller.email)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let has_org = orgs.get("members").and_then(Value::as_array).map(|a| a.iter().any(|m| m.get("principal").and_then(Value::as_str) == Some(principal.as_str()))).unwrap_or(false);
        let single = if remove || has_org {
            false
        } else {
            let id = pj::str_or(b.get("id")).trim().to_string();
            let (on, admins) = Self::org_facts(relay, &who, &id)?;
            !on && admins == 0
        };
        let params = b.clone();
        if !single {
            return Ok(SectionAnswer::Second { target: principal, params, detail: json!({"remove": remove}) });
        }
        let answer = self.run("meet.org.set", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: principal, detail: json!({"remove": false, "path": "single"}) })
    }

    fn block(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (principal, device, hours, reason) = parse_block(call.body).map_err(invalid)?;
        // 3.9: 5 blocks an hour per admin, counted by the core console
        if let Some(core) = self.core() {
            core.limit(Limit::Blocks, &call.caller.email, call.t)?;
        }
        let target = format!("{principal}/{device}");
        let params = json!({"principal": principal, "device": device, "hours": hours, "reason": reason});
        let single = self.blocks.lock().single_ok(&principal, &device, hours, relay.hub.is_admin(&principal), call.t);
        if !single {
            return Ok(SectionAnswer::Second { target, params, detail: json!({"hours": hours}) });
        }
        let answer = self.run("meet.block", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target, detail: json!({"hours": hours, "path": "single"}) })
    }

    fn unblock(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (principal, device, reason) = parse_unblock(call.body).map_err(invalid)?;
        let target = format!("{principal}/{device}");
        let placer = self.blocks.lock().get(&principal, &device, call.t).map(|b| b.placed_by.clone()).ok_or_else(|| not_found("block"))?;
        let params = json!({"principal": principal, "device": device, "reason": reason});
        if placer != call.caller.email {
            return Ok(SectionAnswer::Second { target, params, detail: json!({"placedBy": placer}) });
        }
        let answer = self.run("meet.unblock", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target, detail: json!({"placedBy": placer}) })
    }

    fn bridge_set(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let b = call.body;
        let org = pj::str_or(b.get("org")).trim().to_string();
        if org.is_empty() {
            return Err(invalid("org is required"));
        }
        reason_of(b.get("reason")).map_err(invalid)?;
        let off = b.get("policy").and_then(|p| p.get("enabled")) == Some(&Value::Bool(false));
        if off {
            let answer = self.run("meet.bridge.set", b, &call.caller.email, true, call.t)?;
            return Ok(SectionAnswer::Done { answer, target: org, detail: json!({"enabled": false, "path": "single"}) });
        }
        if !writes_allowed(call.license) {
            return Err(license_needed());
        }
        Ok(SectionAnswer::Second { target: org, params: b.clone(), detail: json!({}) })
    }

    fn hold_items(body: &Value) -> Result<(String, Vec<String>), ApiError> {
        let on = pj::str_or(body.get("on"));
        let field = match on.as_str() {
            "people" => "principals",
            "conversations" => "cids",
            _ => return Err(invalid("on must be people or conversations")),
        };
        let items: Vec<String> = body.get(field).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).collect()).unwrap_or_default();
        Ok((on, items))
    }

    fn holds_place(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (on, items) = Self::hold_items(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        // the per-principal rule applies to the requester before anything waits (3.7)
        if on == "people" && !relay.hub.pc_may_hold_people(&call.caller.email, &items) {
            return Err(ApiError::with("role", "Only an admin of these people's organization (org_admins) can hold them."));
        }
        let detail = json!({"on": on, "items": items.len()});
        if items.len() > HOLD_SINGLE_MAX {
            return Ok(SectionAnswer::Second { target: "-".into(), params: call.body.clone(), detail });
        }
        let answer = self.run("meet.holds.place", call.body, &call.caller.email, true, call.t)?;
        let target = pj::py_str(answer.get("id").unwrap_or(&Value::Null));
        Ok(SectionAnswer::Done { answer, target, detail })
    }

    fn holds_release(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let id = pj::str_or(call.body.get("id"));
        reason_of(call.body.get("reason")).map_err(invalid)?;
        let who = Self::who(relay, &call.caller.email)?;
        let list = relay.hub.pc_holds_list("", &who).map_err(from_hub)?;
        let hold = list.get("holds").and_then(Value::as_array).and_then(|a| a.iter().find(|h| h.get("id").and_then(Value::as_str) == Some(id.as_str()))).cloned().ok_or_else(|| not_found("hold"))?;
        let placed_ms = pj::as_num(hold.get("placed")).map(|s| (s * 1000.0) as i64).unwrap_or(0);
        let mine = hold.get("by").and_then(Value::as_str) == Some(call.caller.email.as_str());
        let single = mine && self.blocks.lock().hold_path(&id) == "single" && call.t - placed_ms <= HOLD_RELEASE_MS;
        if !single {
            return Ok(SectionAnswer::Second { target: id, params: call.body.clone(), detail: json!({}) });
        }
        let answer = self.run("meet.holds.release", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: id, detail: json!({"path": "single"}) })
    }

    fn release_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        reason_of(call.body.get("reason")).map_err(invalid)?;
        let body = call.body.as_object().cloned().unwrap_or_default();
        let manifest = relay.release_preview(&body).map_err(from_hub)?;
        let version = pj::s(&manifest, "version");
        let detail = json!({"minimum": manifest.get("minimum").cloned().unwrap_or(Value::Null), "in_force": relay.minimums(&relay.release())});
        if !relay.release_single_admin(&manifest) {
            return Ok(SectionAnswer::Second { target: version, params: call.body.clone(), detail });
        }
        let answer = self.run("meet.release.set", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: version, detail })
    }

    fn files_start(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        // 3.9: 6 an hour for the console, counted by the core console
        if let Some(core) = self.core() {
            core.limit(Limit::FilesStart, "console", call.t)?;
        }
        let answer = self.run("meet.files.start", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: "-".into(), detail: json!({}) })
    }

    /// `meet.seats.request` (2.4 "Request more seats"): mails the publisher `mail.seats-request` at Settings,
    /// License, "Seat requests go to", and answers the same text to copy.
    fn seats_request(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let gate = Self::gate(relay)?;
        let Some((license, _)) = gate.license() else { return Err(license_needed()) };
        let wanted = call.body.get("wanted").and_then(Value::as_i64).filter(|w| *w > license.users && *w <= 10_000).ok_or_else(|| invalid(format!("wanted is more than {} and at most 10,000.", license.users)))?;
        let core = self.core();
        if let Some(c) = &core {
            c.limit(Limit::SeatRequests, &call.caller.email, call.t)?;
        }
        let (seated, _) = gate.seat_counts();
        let host = crate::meet_console_port::host_of(&relay.settings.console_public);
        let time = pj::iso_utc(call.t.div_euclid(1000));
        let email = call.caller.email.clone();
        let text = format!(
            "Organization: {}\nLicense ID: {}\nProduct: Meeting Hub\nSeats in the license: {}\nSeats in use: {seated}\nSeats wanted: {wanted}\nAdmin: {email} {email}\nRelay: {host}\nSent from the Lucid Admin Console on {time}.",
            license.org, license.id, license.users
        );
        let to = core.as_ref().and_then(|c| c.license_request_to());
        let mailed = match &to {
            Some(addr) => {
                let args = [("org", license.org.clone()), ("license id", license.id.clone()), ("users", license.users.to_string()), ("seated", seated.to_string()), ("wanted", wanted.to_string()), ("name", email.clone()), ("email", email.clone()), ("time", time.clone())];
                crate::console_mail::send("mail.seats-request", addr, &args);
                true
            }
            None => false,
        };
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "mailed": mailed, "to": to, "text": text}), target: "-".into(), detail: json!({"wanted": wanted, "mailed": mailed}) })
    }

    /// Run one action as `principal` (the requester, for an approval: 3.7 M10). `single`: on one admin's word.
    fn run(&self, action: &str, params: &Value, principal: &str, single: bool, t: i64) -> Result<Value, ApiError> {
        let relay = self.relay()?;
        let who = Self::who(&relay, principal)?;
        let p = params.as_object().cloned().unwrap_or_default();
        match action {
            "meet.org.set" => {
                let remove = p.get("remove").filter(|v| v.as_bool() == Some(true));
                // R41-1: an approval carried out later is checked again (adding may have closed meanwhile)
                if let Some(principal) = Self::adds_principal(&relay, action, params) {
                    if !Self::gate(&relay)?.may_add(&principal) {
                        return Err(ApiError::of("license-inactive"));
                    }
                }
                relay.hub.admin_set_organization("", &who, p.get("principal"), p.get("id"), p.get("label"), remove).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.crl" => match relay.push_crl("", &who, p.get("crl_pem")) {
                Ok(_) => Ok(json!({"ok": true})),
                Err(E::Bad(why)) => Err(ApiError::with("crl-refused", format!("This revocation list cannot be used: {}.", why.trim_end_matches('.')))),
                Err(e) => Err(from_hub(e)),
            },
            "meet.block" => {
                let (principal, device, hours, reason) = parse_block(params).map_err(|w| stale(&w))?;
                let placed = self.blocks.lock().place(&principal, &device, hours, &reason, &who.principal, single, t)?;
                relay.hub.set_blocks(self.blocks.lock().mirror(t));
                // a block closes the device's sessions; it never revokes, never completes meet.revoke, never latches
                let dropped = relay.hub.drop_device(&principal, &device);
                crate::meet::log_warn(&format!("device.block category=security principal={principal} device={} until={} by={} dropped={dropped}", m::kv(&device), placed.until, who.principal));
                Ok(json!({"ok": true, "blocked": placed.view()}))
            }
            "meet.unblock" => {
                let (principal, device, _) = parse_unblock(params).map_err(|w| stale(&w))?;
                let gone = self.blocks.lock().lift(&principal, &device, t)?;
                relay.hub.set_blocks(self.blocks.lock().mirror(t));
                crate::meet::log_info(&format!("device.unblock category=security principal={principal} device={} by={} placed_by={}", m::kv(&device), who.principal, gone.placed_by));
                Ok(json!({"ok": true}))
            }
            "meet.bridge.set" => {
                relay.hub.bridge_admin_set("", &who, p.get("org"), p.get("policy")).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.holds.place" => {
                let out = relay.hub.pc_holds_place("", &who, p.get("on"), p.get("principals"), p.get("cids"), p.get("reason")).map_err(from_hub)?;
                let id = pj::s(&out, "id");
                self.blocks.lock().set_hold_path(&id, single);
                Ok(json!({"ok": true, "id": id}))
            }
            "meet.holds.release" => {
                relay.hub.pc_holds_release("", &who, p.get("id"), p.get("reason")).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.release.set" => {
                let mut body = p.clone();
                body.remove("reason");
                relay.set_release("", &who, &body).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.clock.confirm" => {
                // approved (or sole-admin path): the browser time of the request, checked again now
                let browser = p.get("browserTime").and_then(Value::as_i64).ok_or_else(|| invalid("browserTime is a time in milliseconds."))?;
                let done = Self::gate(&relay)?.confirm_clock(browser).map_err(|w| ApiError::with("clock-disagree", w))?;
                Ok(json!({"ok": true, "old": done.old, "new": done.new, "credited": done.credited}))
            }
            "meet.files.start" => {
                relay.console.start_files_now().map_err(|why| stale(&why))?;
                let f = relay.console.files();
                Ok(json!({"ok": true, "files": {"state": f.get("state").cloned().unwrap_or(Value::Null)}}))
            }
            _ => Err(not_found("action")),
        }
    }

    fn core(&self) -> Option<Arc<Console>> {
        self.relay.upgrade().and_then(|r| r.admin_console.get().cloned())
    }

    /// The principal a console write would seat (R41-1), or None when it seats no one: `requests.new` of
    /// `meet.invite` (its email) or of `meet.approve` approving an enrollment (the enrollment's principal), and
    /// `meet.org.set` (its principal, unless it removes them).
    fn adds_principal(relay: &Relay, action: &str, params: &Value) -> Option<String> {
        match action {
            "requests.new" => {
                let target = params.get("target")?;
                match params.get("kind").and_then(Value::as_str)? {
                    "meet.invite" => Some(m::principal(target.get("email"))).filter(|p| !p.is_empty()),
                    "meet.approve" if pj::str_or(target.get("kind")) == "enroll" && pj::str_or(target.get("decision")) == "approve" => {
                        // an enrollment the relay no longer has seats no one (the approval itself is refused later)
                        relay.hub.enrollment_principal(&pj::str_or(target.get("id")))
                    }
                    _ => None,
                }
            }
            "meet.org.set" if params.get("remove") != Some(&Value::Bool(true)) => Some(m::principal(params.get("principal"))).filter(|p| !p.is_empty()),
            _ => None,
        }
    }

    /// The `meet.*` request target checks (3.8): `meet.approve {kind, id, csr_sha256, decision}`, `meet.revoke
    /// {principal, device}`, `meet.invite {name, email, days}`.
    pub fn check_target(kind: &str, target: &Value) -> Result<Value, ApiError> {
        let o = target.as_object().ok_or_else(|| invalid("The target is an object."))?;
        let only = |keys: &[&str]| -> Result<(), ApiError> {
            match o.keys().find(|k| !keys.contains(&k.as_str())) {
                Some(k) => Err(ApiError::with("unknown-field", format!("Unknown field: {}.", clean(k)))),
                None => Ok(()),
            }
        };
        match kind {
            "meet.approve" => {
                only(&["kind", "id", "csr_sha256", "decision"])?;
                let k = pj::str_or(o.get("kind"));
                if !["enroll", "seed", "renew"].contains(&k.as_str()) {
                    return Err(invalid("kind is enroll, seed or renew."));
                }
                let id = clean(&pj::str_or(o.get("id")));
                if id.is_empty() || id.chars().count() > 128 {
                    return Err(invalid("id is required."));
                }
                let csr = pj::str_or(o.get("csr_sha256")).to_lowercase();
                if csr.len() != 64 || !csr.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err(invalid("csr_sha256 must be 64 hex digits."));
                }
                let decision = pj::str_or(o.get("decision"));
                if decision != "approve" && decision != "refuse" {
                    return Err(invalid("decision is approve or refuse."));
                }
                Ok(json!({"kind": k, "id": id, "csr_sha256": csr, "decision": decision}))
            }
            "meet.revoke" => {
                only(&["principal", "device"])?;
                let principal = m::principal(o.get("principal"));
                let device = clean(&pj::str_or(o.get("device")));
                if !principal.contains('@') || device.is_empty() {
                    return Err(invalid("name the person (their email) and the device"));
                }
                Ok(json!({"principal": principal, "device": device}))
            }
            "meet.invite" => {
                only(&["name", "email", "days"])?;
                let name = clean(&pj::str_or(o.get("name")));
                let email = m::principal(o.get("email"));
                let days = o.get("days").and_then(Value::as_i64).filter(|d| (1..=30).contains(d)).ok_or_else(|| invalid("days is 1 to 30."))?;
                if name.is_empty() || name.chars().count() > 80 || !email.contains('@') {
                    return Err(invalid("name and email are required."));
                }
                Ok(json!({"name": name, "email": email, "days": days}))
            }
            _ => Err(invalid(format!("Unknown request kind: {}.", clean(kind)))),
        }
    }
}

impl ProductSection for MeetSection {
    fn routes(&self) -> &'static [RouteSpec] {
        &ROUTES
    }

    fn sections(&self, license: LicenseState) -> Vec<&'static str> {
        if license == LicenseState::None {
            LOCKED_PAGES.to_vec()
        } else {
            PAGES.to_vec()
        }
    }

    fn relay_info(&self, t: i64) -> Value {
        let Ok(relay) = self.relay() else { return Value::Null };
        let tls = crate::meet_x509::Cert::from_pem(&String::from_utf8_lossy(&std::fs::read(&relay.settings.console_cert).unwrap_or_default())).map(|c| c.not_after);
        json!({
            "host": crate::meet_console_port::host_of(&relay.settings.console_public), "version": m::SERVER_VERSION,
            "uptimeSeconds": (t - self.started).max(0) / 1000, "fips": cfg!(feature = "fips"), "tlsNotAfter": tls,
        })
    }

    fn license(&self, _t: i64) -> LicenseView {
        let none = |problem: String| LicenseView { license: Value::Null, problem: Some(problem), state: LicenseState::None };
        let Ok(relay) = self.relay() else { return none(NO_LICENSE.into()) };
        let Ok(gate) = Self::gate(&relay) else { return none(NO_LICENSE.into()) };
        match gate.license() {
            Some((l, dev)) => LicenseView { license: self.license_object(&relay, &l, dev), problem: None, state: Self::license_now(&relay) },
            None => none(Some(gate.problem()).filter(|p| !p.is_empty()).unwrap_or_else(|| NO_LICENSE.into())),
        }
    }

    fn overview_cards(&self, admin: bool, _t: i64) -> Vec<Value> {
        let Ok(relay) = self.relay() else { return Vec::new() };
        let summary = relay.console.summary(&relay);
        let headline = crate::meet_console::Console::signer_headline(&relay);
        let (used, users) = Self::gate(&relay).map(|g| g.seat_counts()).unwrap_or((0, 0));
        let warn = |bad: bool| if bad { "warn" } else { "ok" };
        let mut cards = vec![json!({"id": "health", "state": "ok", "n": summary.get("people_online"), "m": summary.get("participants")})];
        if admin {
            cards.push(json!({"id": "people", "state": warn(users > 0 && used * 10 >= users * 9), "n": used, "m": users}));
            let configured = pj::truthy(headline.get("configured"));
            cards.push(json!({"id": "signer", "state": if !configured || pj::truthy(headline.get("healthy")) { "ok" } else { "bad" }, "n": headline.get("days_left"), "m": Value::Null}));
            let (sent, failed) = push::apns::counts();
            cards.push(json!({"id": "push", "state": warn(failed.values().sum::<u64>() > 0), "n": sent, "m": failed.values().sum::<u64>()}));
        }
        let release = relay.release();
        cards.push(json!({"id": "release", "state": "ok", "n": pj::s(&release, "version"), "m": relay.minimums(&release).get("hub").cloned().unwrap_or(Value::Null)}));
        cards
    }

    fn attention(&self, admin: bool, t: i64) -> Vec<Value> {
        let Ok(relay) = self.relay() else { return Vec::new() };
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({"kind": kind, "severity": severity, "args": args, "go": go});
        let mut out = Vec::new();
        let headline = crate::meet_console::Console::signer_headline(&relay);
        if pj::truthy(headline.get("configured")) && !pj::truthy(headline.get("healthy")) {
            out.push(item("signer-unhealthy", "bad", json!({}), "#/meet/signer"));
        }
        if let Some(cert) = crate::meet_x509::Cert::from_pem(&String::from_utf8_lossy(&std::fs::read(&relay.settings.console_cert).unwrap_or_default())) {
            let days = (cert.not_after - t.div_euclid(1000)).div_euclid(86_400);
            if days <= 21 {
                out.push(item("tls-expiring", if days <= 7 { "bad" } else { "warn" }, json!({"n": days.max(0)}), "#/overview"));
            }
        }
        if !admin {
            return out;
        }
        if let Some(n) = pj::as_int(headline.get("days_left")).filter(|d| *d <= 30) {
            out.push(item("signer-expiring", "warn", json!({"n": n.max(0)}), "#/meet/signer"));
        }
        // 2.4: the license gate, the upgrade period, trusted time and seats (with their banners)
        if let Ok(gate) = Self::gate(&relay) {
            out.extend(gate.attention());
        }
        if let Some(who) = relay.settings.admins.first().and_then(|p| relay.hub.check_console_admin(p).ok()) {
            let waiting = relay.hub.admin_pending("", &who).ok().and_then(|p| p.get("items").and_then(Value::as_array).map(Vec::len)).unwrap_or(0);
            if waiting > 0 {
                out.push(item("enrollments-waiting", "info", json!({"n": waiting}), "#/meet/enrollments"));
            }
        }
        let blocks = self.blocks.lock().active(t);
        if blocks > 0 {
            out.push(item("blocks-active", "info", json!({"n": blocks}), "#/meet/people"));
        }
        out
    }

    fn search(&self, q: &str, admin: bool, _t: i64) -> Vec<Value> {
        if !admin {
            return Vec::new();
        }
        let Ok(relay) = self.relay() else { return Vec::new() };
        let q = q.to_lowercase();
        let directory = relay.hub.st.lock().directory.clone();
        directory
            .iter()
            .filter_map(|(p, e)| {
                let name = e.get("name").and_then(Value::as_str).unwrap_or_default();
                (p.contains(&q) || name.to_lowercase().contains(&q)).then(|| json!({"kind": "person", "id": p, "title": name, "detail": p, "go": format!("#/meet/people?q={p}")}))
            })
            .take(SEARCH_MAX)
            .collect()
    }

    fn security_actions(&self) -> &'static [&'static str] {
        &SECURITY_ACTIONS
    }

    fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let relay = self.relay()?;
        let read = |v: Result<Value, ApiError>| v.map(SectionAnswer::Read);
        // Seats and the relay's time are always allowed (2.4)
        let always = matches!(call.spec.path, "meet/identity" | "meet/seats" | "meet/clock");
        if call.spec.method == "GET" && call.license == LicenseState::None && !always {
            return Err(license_needed());
        }
        match (call.spec.method, call.spec.path) {
            ("GET", "meet/seats") => {
                filters(call.query, &[])?;
                let gate = Self::gate(&relay)?;
                let directory = relay.hub.st.lock().directory.clone();
                let names = |p: &str| directory.get(p).and_then(|e| e.get("name")).and_then(Value::as_str).unwrap_or_default().to_string();
                let to = self.core().and_then(|c| c.license_request_to());
                read(Ok(gate.seats_view(&names, to)))
            }
            ("GET", "meet/clock") => {
                filters(call.query, &[])?;
                read(Ok(Self::gate(&relay)?.clock_view()))
            }
            ("POST", "meet/seats/pick") => {
                let principal = call.body.get("principal").and_then(Value::as_str).map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).ok_or_else(|| invalid("principal is required."))?;
                let pick = call.body.get("pick").and_then(Value::as_bool).ok_or_else(|| invalid("pick is true or false."))?;
                if let Some(c) = self.core() {
                    c.limit(Limit::SeatPicks, &call.caller.email, call.t)?;
                }
                Self::gate(&relay)?.pick(&principal, &call.caller.email, pick).map_err(|(code, words)| if words.is_empty() { ApiError::of(code) } else { ApiError::with(code, words) })?;
                Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: principal, detail: json!({"pick": pick}) })
            }
            ("POST", "meet/seats/request") => self.seats_request(&relay, call),
            ("POST", "meet/clock/confirm") => {
                let browser = call.body.get("browserTime").and_then(Value::as_i64).ok_or_else(|| invalid("browserTime is a time in milliseconds."))?;
                let gate = Self::gate(&relay)?;
                // a second admin (with two-person on) when the confirmed time is behind the high-water mark
                if gate.time.confirm_goes_back() {
                    return Ok(SectionAnswer::Second { target: "-".into(), params: call.body.clone(), detail: json!({"back": true}) });
                }
                let done = gate.confirm_clock(browser).map_err(|w| ApiError::with("clock-disagree", w))?;
                Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: "-".into(), detail: json!({"old": done.old, "new": done.new, "credited": done.credited}) })
            }
            ("GET", "meet/people") => read(self.people(&relay, call)),
            ("GET", "meet/enrollments") => read(self.enrollments(&relay, call, self.core().as_deref())),
            ("GET", "meet/organizations") => read(self.organizations(&relay, call)),
            ("GET", "meet/signer") => read(self.signer(&relay, call)),
            ("GET", "meet/bridge") => {
                filters(call.query, &[])?;
                let who = Self::who(&relay, &call.caller.email)?;
                let b = relay.hub.bridge_admin("", &who).map_err(from_hub)?;
                read(Ok(json!({"ok": true, "policies": b.get("policies").cloned().unwrap_or(json!({}))})))
            }
            ("GET", "meet/bridge/audit") => {
                let f = filters(call.query, &["after", "limit"])?;
                let who = Self::who(&relay, &call.caller.email)?;
                let mut rows = relay.hub.bridge_audit("", &who, f.get("after").map(String::as_str).unwrap_or(""), f.get("limit").map(String::as_str).unwrap_or("")).map_err(from_hub)?;
                rows.insert("ok".into(), Value::Bool(true));
                read(Ok(Value::Object(rows)))
            }
            ("GET", "meet/holds") => read(self.holds(&relay, call)),
            ("GET", "meet/release") => {
                filters(call.query, &[])?;
                read(Ok(Self::release_view(&relay)))
            }
            ("GET", "meet/push") => {
                filters(call.query, &[])?;
                read(Ok(Self::push_view(&relay)))
            }
            ("GET", "meet/identity") => {
                filters(call.query, &[])?;
                read(Ok(crate::meet_console_identity::view()))
            }
            ("GET", "meet/calls") => {
                filters(call.query, &[])?;
                read(Ok(Self::calls(&relay, call.caller.admin)))
            }
            ("GET", "meet/servers") => {
                filters(call.query, &[])?;
                read(Ok(Self::servers(&relay)))
            }
            ("POST", "meet/organizations") => self.org_set(&relay, call),
            ("POST", "meet/crl") => {
                let answer = self.run("meet.crl", call.body, &call.caller.email, true, call.t)?;
                let sha = crate::codec::sha256_hex(pj::str_or(call.body.get("crl_pem")).as_bytes());
                Ok(SectionAnswer::Done { answer, target: "-".into(), detail: json!({"sha256": sha}) })
            }
            ("POST", "meet/block") => self.block(&relay, call),
            ("POST", "meet/unblock") => self.unblock(call),
            ("POST", "meet/bridge") => self.bridge_set(call),
            ("POST", "meet/holds") => self.holds_place(&relay, call),
            ("POST", "meet/holds/release") => self.holds_release(&relay, call),
            ("POST", "meet/release") => self.release_set(&relay, call),
            ("POST", "meet/files/start") => self.files_start(call),
            _ => Err(not_found("page")),
        }
    }

    fn execute(&self, run: &Approved) -> Result<Value, ApiError> {
        // the sole-admin path is still one admin's word (it counts toward the 24 hours of blocks and the holds rule)
        let single = run.approved_by.is_none();
        self.run(run.action, run.params, run.requested_by, single, run.t)
    }

    fn may_approve(&self, action: &str, params: &Value, approver: &str) -> bool {
        let Some(relay) = self.relay.upgrade() else { return false };
        if !relay.hub.is_admin(approver) {
            return false;
        }
        if action == "meet.holds.place" {
            if let Ok((on, items)) = Self::hold_items(params) {
                if on == "people" {
                    return relay.hub.pc_may_hold_people(approver, &items);
                }
            }
        }
        true
    }

    fn license_candidate(&self, token: &str, _t: i64) -> Result<LicenseCandidate, ApiError> {
        let relay = self.relay()?;
        let gate = Self::gate(&relay)?;
        let (offered, dev) = Self::verify(&relay, token)?;
        Self::license_target(&relay)?;
        let state = license_standing(Some(&offered), gate.time.now().div_euclid(1000)).state;
        let reference = Self::reference(&gate);
        let view = self.license_object(&relay, &offered, dev);
        Ok(LicenseCandidate { offered: LicenseRecord::of(&offered), valid: state == Some(LicenseStateName::Valid), ended: state == Some(LicenseStateName::Expired), reference, view })
    }

    fn license_install(&self, token: &str, _t: i64) -> Result<Value, ApiError> {
        let relay = self.relay()?;
        let gate = Self::gate(&relay)?;
        let (offered, dev) = Self::verify(&relay, token)?;
        if license_standing(Some(&offered), gate.time.now().div_euclid(1000)).state == Some(LicenseStateName::Expired) {
            return Err(ApiError::of("license-ended"));
        }
        let file = Self::license_target(&relay)?;
        write_private(&file, format!("{}\n", license_token_of(token)).as_bytes()).map_err(|e| {
            crate::meet::log_error(&format!("license cannot be written: {e}"));
            ApiError::of("write-failed")
        })?;
        // the view before the install says whether the upgrade period stays as a fallback (8.2, R3-M4)
        let view = self.license_object(&relay, &offered, dev);
        // effective at once: service, seats (reseat with more `users`, the clock with fewer) and the period's end
        gate.installed();
        Ok(view)
    }

    fn request_target(&self, kind: &str, target: &Value) -> Result<Value, ApiError> {
        Self::check_target(kind, target)
    }

    fn admin_rule(&self, email: &str, anchor: &str) -> AdminRule {
        let Some(relay) = self.relay.upgrade() else { return AdminRule::NotRelayAdmin };
        if !relay.hub.is_admin(email) {
            return AdminRule::NotRelayAdmin;
        }
        // the break-glass account (anchor "operator"): admin rights without a device anchor (3.3)
        if anchor.is_empty() || anchor == "operator" {
            return AdminRule::Admin;
        }
        // decision 14: the admin role only through a passkey anchored to one of that principal's own devices
        if relay.hub.device_serials(email).contains(&m::serial(anchor)) {
            AdminRule::Admin
        } else {
            AdminRule::ViewerOnly
        }
    }

    fn relay_lines(&self, f: &Filter) -> Option<Vec<String>> {
        let relay = self.relay.upgrade()?;
        if f.cat.as_deref().is_some_and(|c| c != "relay") {
            return Some(Vec::new());
        }
        Some(relay.console.ring.json_lines(f.min as i64))
    }

    /// 4.7 `adding` (Meeting Hub only, R41-1): `{state: "open" or "closed" or "upgrade-period", upgradePeriodEnds,
    /// lastUsers}`.
    fn adding(&self, _t: i64) -> Value {
        let Some(gate) = self.relay.upgrade().and_then(|r| r.hub.gate()) else { return Value::Null };
        gate.adding_view()
    }

    /// The growth gate for the console's add-people writes (4.9, R41-1): `requests.new` of `meet.invite`, or of
    /// `meet.approve` approving a new principal's enrollment, and `meet.org.set` naming a new principal.
    fn may_add(&self, action: &str, params: &Value) -> Result<(), ApiError> {
        let Some(relay) = self.relay.upgrade() else { return Ok(()) };
        let Some(gate) = relay.hub.gate() else { return Ok(()) };
        let principal = Self::adds_principal(&relay, action, params);
        match principal {
            Some(p) if !gate.may_add(&p) => Err(ApiError::of("license-inactive")),
            _ => Ok(()),
        }
    }

    /// A promotion to admin, an unsuspension, a removal or a role change: protected people reseat at once (R3-M6).
    fn people_changed(&self, _t: i64) {
        if let Some(gate) = self.relay.upgrade().and_then(|r| r.hub.gate()) {
            gate.check(true);
        }
    }
}

// ── the hub's hooks ──────────────────────────────────────────────────────────────────────────────────────────

/// Anchor latching and request observation, from the hub to the core console.
struct Hooks {
    relay: Weak<Relay>,
    console: Arc<Console>,
}

/// The serial of one device the relay knows (directory), or "".
fn device_serial(relay: &Relay, principal: &str, device: &str) -> String {
    let st = relay.hub.st.lock();
    st.directory.get(principal).and_then(|e| e.get("devices")).and_then(|d| d.get(device)).map(|d| m::serial_of(d.get("serial"))).unwrap_or_default()
}

impl ConsoleHooks for Hooks {
    fn revoked(&self, serials: &[String]) {
        let set: HashSet<String> = serials.iter().map(|s| m::serial(s)).filter(|s| !s.is_empty()).collect();
        if set.is_empty() {
            return;
        }
        self.console.set_revoked(&set);
        // 3.8: a CRL the relay holds that lists the device's serial completes meet.revoke
        let Some(relay) = self.relay.upgrade() else { return };
        let t = (pj::now() * 1000.0) as i64;
        self.console.observe_requests("meet.revoke", "crl", t, &|target: &Value| {
            let principal = target.get("principal").and_then(Value::as_str).unwrap_or_default();
            let device = target.get("device").and_then(Value::as_str).unwrap_or_default();
            let serial = device_serial(&relay, principal, device);
            !serial.is_empty() && set.contains(&serial)
        });
    }

    fn observed(&self, kind: &str, target: &Obj, by: &str, link: Option<&str>) {
        let t = (pj::now() * 1000.0) as i64;
        let want = |k: &str| target.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let n = match kind {
            "meet.approve" => {
                let (k, id, csr) = (want("kind"), want("id"), want("csr_sha256"));
                self.console.observe_requests(kind, by, t, &|r: &Value| r.get("kind").and_then(Value::as_str) == Some(k.as_str()) && r.get("id").and_then(Value::as_str) == Some(id.as_str()) && r.get("csr_sha256").and_then(Value::as_str) == Some(csr.as_str()))
            }
            "meet.revoke" => {
                let (principal, device) = (want("principal"), want("device"));
                self.console.observe_requests(kind, by, t, &|r: &Value| {
                    let rd = r.get("device").and_then(Value::as_str).unwrap_or_default();
                    r.get("principal").and_then(Value::as_str) == Some(principal.as_str()) && (device.is_empty() || rd == device)
                })
            }
            "meet.invite" => {
                let email = want("email");
                self.console.observe_requests(kind, by, t, &|r: &Value| r.get("email").and_then(Value::as_str) == Some(email.as_str()))
            }
            _ => 0,
        };
        if let Some(id) = link {
            self.console.audit_relay("requests.linked", id, json!({"kind": kind, "by": by, "observed": n}));
        }
    }

    fn reader(&self, email: &str) -> bool {
        self.console.check_console_reader(email)
    }

    fn console_admin(&self, principal: &str) -> bool {
        self.console.is_active_admin(principal)
    }

    fn admin_emails(&self) -> Vec<String> {
        self.console.active_admin_emails()
    }

    fn audit(&self, action: &str, target: &str, detail: Value) {
        self.console.audit_relay(action, target, detail);
    }

    fn mail(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        crate::console_mail::send(kind, to, args);
    }
}

// ── start (3.1) ──────────────────────────────────────────────────────────────────────────────────────────────

/// The Admin Console on the Meeting Hub relay: nothing when `console_port` is 0; Err is why the relay does not start.
pub fn start(relay: &Arc<Relay>) -> Result<(), String> {
    let s = &relay.settings;
    let main_dns = crate::meet_tls::cert_dns_names(&s.cert);
    let Some(conf) = crate::meet_console_port::check_settings(s, &main_dns)? else { return Ok(()) };
    if s.state_dir.is_empty() {
        return Err("the Admin Console needs state_dir".into());
    }
    crate::meet_tls::check_console_cert(&s.console_cert, &s.client_ca, &conf.host)?;
    let tls = crate::meet_tls::console_tls_config(s)?;
    let state_dir = PathBuf::from(&s.state_dir);
    let blocks = MeetBlocks::open(&state_dir.join(BLOCKS_FILE))?;
    let t = (pj::now() * 1000.0) as i64;
    relay.hub.set_blocks(blocks.mirror(t));
    let sources = crate::console_source::parse_cidrs(&s.console_sources, 32)?;
    let first_admin = Some(s.console_first_admin.trim().to_lowercase()).filter(|p| !p.is_empty());
    let cfg = ConsoleConfig { product: Product::Meet, state_dir, origin: Some(conf.origin()), sources, trusted_fronts: Vec::new(), behind_front: false, first_admin, profile: crate::console_settings::Profile::parse(s.console_profile.trim()), host: conf.host.clone() };
    let ring = Arc::new(crate::console::LineRing::default());
    let logger = Arc::new(crate::log::Logger::new("meet-console").with_tap(ring.tap()));
    let console = Console::open(cfg, logger, ring)?;
    let section = Arc::new(MeetSection::new(Arc::downgrade(relay), blocks, t));
    console.attach(section);
    // 3.2: latch at start from the denied set and every CRL the relay holds, then on every change
    let mut serials: Vec<String> = relay.hub.denied_serials().into_iter().collect();
    serials.extend(relay.revoked_serials());
    let hooks = Arc::new(Hooks { relay: Arc::downgrade(relay), console: console.clone() });
    hooks.revoked(&serials);
    relay.hub.set_console_hooks(hooks);
    // 2.4: the gate's first-start entries (upgrade period, `firstSeen` migration) reach the audit now; then a check
    // with the console's admins protected (R3-M6)
    if let Some(gate) = relay.hub.gate() {
        gate.flush_pending();
        gate.check(true);
    }
    let _ = relay.admin_console.set(console.clone());
    let handler_console = console.clone();
    let handler: crate::meet_console_port::Handler = Arc::new(move |r: &crate::console::ConsoleRequest<'_>, t: i64| handler_console.http(r, t));
    let source_console = console;
    let source_ok: crate::meet_console_port::SourceCheck = Arc::new(move |ip: std::net::IpAddr| source_console.source_allowed(ip));
    crate::meet_console_port::start(s, conf, tls, handler, source_ok)
}

// ── the main port's 4.10 routes ──────────────────────────────────────────────────────────────────────────────

/// `GET /v1/admin/console/requests`: the waiting `meet.*` requests; `meet.console-invite` only to its principal.
pub fn requests_for(relay: &Relay, principal: &str) -> Obj {
    let t = (pj::now() * 1000.0) as i64;
    let list: Vec<Value> = match relay.admin_console.get() {
        None => Vec::new(),
        Some(c) => c
            .requests_waiting("meet.", t)
            .into_iter()
            .filter(|r| r.get("kind").and_then(Value::as_str) != Some("meet.console-invite") || r.get("target").and_then(|x| x.get("principal")).and_then(Value::as_str) == Some(principal))
            .collect(),
    };
    obj([("ok", Value::Bool(true)), ("requests", Value::Array(list))])
}

/// `POST /v1/admin/console/invite {session}`: a sign-in link for the caller's own principal (3.2), anchored to the
/// calling device certificate's serial.
pub fn device_invite(relay: &Relay, who: &Identity) -> R<Obj> {
    let Some(console) = relay.admin_console.get() else { return Err(E::Conflict(CONSOLE_OFF.into())) };
    let t = (pj::now() * 1000.0) as i64;
    match console.invite_device(&who.principal, &m::serial(&who.serial), t) {
        Ok(i) => Ok(obj([("ok", Value::Bool(true)), ("link", Value::from(i.link)), ("email", Value::from(who.principal.clone())), ("expires", Value::from(i.expires))])),
        Err(r) if r.status == 429 => Err(E::Status(429, r.error, false)),
        Err(r) if r.status == 409 => Err(E::Conflict(r.error)),
        Err(r) if r.status == 403 => Err(E::Forbidden(r.error)),
        Err(r) => Err(E::Bad(r.error)),
    }
}

/// `POST /v1/admin/console/requests/decline {session, id, reason}`: closes the to-do; changes no certificate.
pub fn decline(relay: &Relay, by: &str, id: Option<&Value>, reason: Option<&Value>) -> R<Obj> {
    let id = id.and_then(Value::as_str).filter(|i| request_id_ok(i)).ok_or_else(|| E::Bad(DECLINE_ID.into()))?;
    let reason = reason.and_then(Value::as_str).map(clean).filter(|r| (1..=m::REASON_MAX).contains(&r.chars().count())).ok_or_else(|| E::Bad(DECLINE_REASON.into()))?;
    let Some(console) = relay.admin_console.get() else { return Err(E::NotFound(NO_REQUEST.into())) };
    let t = (pj::now() * 1000.0) as i64;
    match console.decline_request(id, by, &reason, t) {
        Ok(_) => Ok(obj([("ok", Value::Bool(true))])),
        Err(e) if e.status == 404 || e.code == "not-found" => Err(E::NotFound(NO_REQUEST.into())),
        Err(e) if e.status == 410 => Err(E::Gone(e.message)),
        Err(e) => Err(E::Status(e.status, e.message, false)),
    }
}

// ── the offline commands (3.2) ───────────────────────────────────────────────────────────────────────────────

const CLI_USAGE: &str = "usage: lucid-relay meet console (remove-admin <email> | unsuspend <email> | approve-join <email> [--role admin] | reset --first-admin <principal> | break-glass <email> [--replace] | two-person off) --config <relay.json>";

/// `lucid-relay meet console ...` with the relay stopped: the same commands as the Remote Spokes relay's, over
/// state_dir/console.json; `approve-join --role admin` also needs the email in relay.json `admins` and the passkey made
/// active anchored to a device of that principal (state.json directory). Audited with actor `operator` at the next
/// start (by the core console).
pub fn cli(argv: &[String]) -> ! {
    match cli_run(argv, &mut |prompt: &str| {
        use std::io::Write;
        print!("{prompt}");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        line.trim().to_string()
    }) {
        Ok(done) => {
            println!("{done}");
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("lucid-relay meet console: {e}");
            std::process::exit(if e == CLI_USAGE { 2 } else { 1 })
        }
    }
}

/// The parsed command, or the usage words.
pub fn cli_parse(argv: &[String]) -> Result<(crate::console_auth::Offline, String), String> {
    use crate::console_auth::Offline;
    let usage = || CLI_USAGE.to_string();
    let (mut config, mut role, mut first) = (None, None, None);
    let mut replace = false;
    let mut rest: Vec<&String> = Vec::new();
    let mut args = argv.iter();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--replace" => replace = true,
            "--config" => config = Some(args.next().cloned().ok_or_else(usage)?),
            "--role" => role = Some(args.next().cloned().ok_or_else(usage)?),
            "--first-admin" => first = Some(args.next().cloned().ok_or_else(usage)?),
            s if s.starts_with("--") => return Err(usage()),
            _ => rest.push(a),
        }
    }
    let config = config.ok_or_else(usage)?;
    let cmd = match (rest.first().map(|s| s.as_str()), rest.get(1)) {
        (Some("remove-admin"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::RemoveAdmin(e.trim().to_lowercase()),
        (Some("unsuspend"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::Unsuspend(e.trim().to_lowercase()),
        (Some("approve-join"), Some(e)) if rest.len() == 2 && first.is_none() => match role.as_deref() {
            None => Offline::ApproveJoin { email: e.trim().to_lowercase(), admin: false },
            Some("admin") => Offline::ApproveJoin { email: e.trim().to_lowercase(), admin: true },
            Some(_) => return Err(usage()),
        },
        (Some("reset"), None) if role.is_none() => match first {
            Some(f) if !f.trim().is_empty() => Offline::Reset { first_admin: f.trim().to_lowercase(), typed_host: String::new() },
            _ => return Err(usage()),
        },
        // revision 4: the break-glass account (3.3) and turning two-person control off (3.7)
        (Some("break-glass"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::BreakGlass { email: e.trim().to_lowercase(), replace, origin: None },
        (Some("two-person"), Some(off)) if off.as_str() == "off" && rest.len() == 2 && role.is_none() && first.is_none() && !replace => Offline::TwoPersonOff,
        _ => return Err(usage()),
    };
    if replace && !matches!(cmd, Offline::BreakGlass { .. }) {
        return Err(usage());
    }
    Ok((cmd, config))
}

/// The Meet rule of `approve-join --role admin`: the email is a relay admin and the anchor is one of that
/// principal's device serials in state.json.
pub fn admin_ok(admins: &[String], directory: &Obj, email: &str, anchor: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if !admins.iter().any(|a| a.trim().to_lowercase() == email) {
        return Err(format!("{email} is not in relay.json admins: add them there first"));
    }
    // the break-glass account (anchor "operator", 3.3): admin rights without a device anchor; its principal must be
    // in relay.json admins
    if anchor == "operator" {
        return Ok(());
    }
    let anchor = m::serial(anchor);
    let serials: HashSet<String> = directory.get(&email).and_then(|e| e.get("devices")).and_then(Value::as_object).map(|d| d.values().map(|v| m::serial_of(v.get("serial"))).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    if anchor.is_empty() || !serials.contains(&anchor) {
        return Err(format!("{email} must first join from their own device in the Meeting Hub app"));
    }
    Ok(())
}

fn cli_run(argv: &[String], ask: &mut dyn FnMut(&str) -> String) -> Result<String, String> {
    use crate::console_auth::Offline;
    let (cmd, config) = cli_parse(argv)?;
    let s = m::Settings::load(&config)?;
    if s.state_dir.is_empty() {
        return Err("relay.json has no state_dir".into());
    }
    let host = crate::meet_console_port::host_of(&s.console_public);
    let cmd = match cmd {
        Offline::Reset { first_admin, .. } => {
            if !s.admins.iter().any(|a| a.trim().to_lowercase() == first_admin) {
                return Err(crate::meet_console_port::FIRST_ADMIN.into());
            }
            let typed = ask(&format!("This clears every person, passkey, invite and approval of the Admin Console. Type the relay's host name ({host}) to go on: "));
            Offline::Reset { first_admin, typed_host: typed }
        }
        other => other,
    };
    let directory: Obj = std::fs::read(Path::new(&s.state_dir).join("state.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|v| v.get("directory").and_then(Value::as_object).cloned())
        .unwrap_or_default();
    let admins = s.admins.clone();
    crate::console_auth::run_offline(Path::new(&s.state_dir), cmd, &host, &|email: &str, anchor: &str| admin_ok(&admins, &directory, email, anchor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-console-meet-{}-{}", std::process::id(), pj::mono().to_bits()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const T0: i64 = 1_763_300_000_000;

    #[test]
    fn routes_declare_roles_and_security_actions() {
        for r in &ROUTES {
            assert!(matches!(r.role, Role::Viewer | Role::Manager | Role::Admin), "{}", r.path);
            // every write needs a step-up except "Request more seats" (4.9: body `{wanted}`, no stepup)
            assert_eq!(r.stepup, r.method == "POST" && r.path != "meet/seats/request", "{}", r.path);
            assert_eq!(r.action.is_empty(), r.method == "GET", "{}", r.path);
            assert!(r.path.starts_with("meet/"), "{}", r.path);
            if r.security {
                assert!(SECURITY_ACTIONS.contains(&r.action), "{}", r.path);
                assert!(matches!(r.need, Need::Any), "{}", r.path);
            }
        }
        // viewers read only calls and the release
        let viewer: Vec<&str> = ROUTES.iter().filter(|r| r.role == Role::Viewer).map(|r| r.path).collect();
        assert_eq!(viewer, vec!["meet/release", "meet/calls"]);
        // user managers read people and seats and pick seats, nothing else (4.9, R4-8)
        let manager: Vec<(&str, &str)> = ROUTES.iter().filter(|r| r.role == Role::Manager).map(|r| (r.method, r.path)).collect();
        assert_eq!(manager, vec![("GET", "meet/people"), ("GET", "meet/seats"), ("POST", "meet/seats/pick")]);
        // seats and the relay's time work in every license state (2.4)
        for r in ROUTES.iter().filter(|r| r.path.starts_with("meet/seats") || r.path.starts_with("meet/clock")) {
            assert!(matches!(r.need, Need::Any), "{}", r.path);
        }
        assert_eq!(ROUTES.iter().find(|r| r.path == "meet/release" && r.method == "POST").unwrap().body_max, 32 * 1024);
    }

    #[test]
    fn blocks_time_accounting_and_admin_devices() {
        let mut b = MeetBlocks::open(&temp_dir().join(BLOCKS_FILE)).unwrap();
        // a relay admin's device is always an approval
        assert!(!b.single_ok("ann@x.org", "aaaa", 1, true, T0));
        assert!(b.single_ok("bob@x.org", "bbbb", 20, false, T0));
        b.place("bob@x.org", "bbbb", 20, "lost", "ann@x.org", true, T0).unwrap();
        assert_eq!(b.mirror(T0 + 1).get("bob@x.org|bbbb").copied(), Some((T0 + 20 * HOUR_MS) as f64 / 1000.0));
        // 20 + 5 hours in 7 days is past 24: an approval; 4 more is fine
        assert!(!b.single_ok("bob@x.org", "bbbb", 5, false, T0 + HOUR_MS));
        assert!(b.single_ok("bob@x.org", "bbbb", 4, false, T0 + HOUR_MS));
        // lifting counts the time only up to now
        b.lift("bob@x.org", "bbbb", T0 + 2 * HOUR_MS).unwrap();
        assert_eq!(b.single_admin_ms("bob@x.org|bbbb", T0 + 2 * HOUR_MS), 2 * HOUR_MS);
        assert!(b.mirror(T0 + 2 * HOUR_MS).is_empty());
        // 8 days later the window is clear
        assert!(b.single_ok("bob@x.org", "bbbb", 24, false, T0 + 8 * 24 * HOUR_MS));
    }

    #[test]
    fn blocks_persist_and_fail_closed() {
        let dir = temp_dir();
        let file = dir.join(BLOCKS_FILE);
        let mut b = MeetBlocks::open(&file).unwrap();
        b.place("bob@x.org", "bbbb", 2, "lost", "ann@x.org", false, T0).unwrap();
        b.set_hold_path("h1", true);
        let again = MeetBlocks::open(&file).unwrap();
        assert_eq!(again.get("bob@x.org", "bbbb", T0 + 1).map(|b| b.placed_by.clone()), Some("ann@x.org".into()));
        assert_eq!(again.hold_path("h1"), "single");
        assert_eq!(again.hold_path("other"), "approved");
        // expiry at until
        assert!(again.get("bob@x.org", "bbbb", T0 + 2 * HOUR_MS).is_none());
        std::fs::write(&file, "{not json").unwrap();
        assert!(MeetBlocks::open(&file).is_err());
    }

    #[test]
    fn block_bodies() {
        assert!(parse_block(&json!({"principal": "Bob@X.org", "device": "bbbb", "hours": 720, "reason": "lost"})).is_ok());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 721, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 0, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "", "hours": 1, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 1, "reason": ""})).is_err());
    }

    #[test]
    fn request_ids_and_targets() {
        assert!(request_id_ok("rq_0123456789abcdef"));
        assert!(!request_id_ok("rq_0123456789ABCDEF"));
        assert!(!request_id_ok("rq_0123"));
        assert!(!request_id_ok("ap_0123456789abcdef"));
        let csr = "a".repeat(64);
        assert_eq!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": csr, "decision": "approve"})).unwrap()["kind"], "enroll");
        assert!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": "x", "decision": "approve"})).is_err());
        assert_eq!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": csr, "decision": "approve", "x": 1})).unwrap_err().code, "unknown-field");
        assert_eq!(MeetSection::check_target("meet.revoke", &json!({"principal": "Bob@x.org", "device": "bbbb"})).unwrap(), json!({"principal": "bob@x.org", "device": "bbbb"}));
        assert!(MeetSection::check_target("meet.invite", &json!({"name": "Bob", "email": "bob@x.org", "days": 7})).is_ok());
        assert!(MeetSection::check_target("meet.invite", &json!({"name": "Bob", "email": "bob@x.org", "days": 0})).is_err());
        assert!(MeetSection::check_target("rs.revoke", &json!({})).is_err());
    }

    #[test]
    fn query_filters() {
        assert_eq!(filters("q=bob&limit=5", &["q", "limit"]).unwrap().get("q").map(String::as_str), Some("bob"));
        assert_eq!(filters("x=1", &["q"]).unwrap_err().message, "Unknown filter: x.");
        assert!(search_text(&filters("q=b", &["q"]).unwrap()).is_err());
    }

    #[test]
    fn offline_commands_parse() {
        use crate::console_auth::Offline;
        let args = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert!(matches!(cli_parse(&args("remove-admin a@x.org --config r.json")).unwrap().0, Offline::RemoveAdmin(e) if e == "a@x.org"));
        assert!(matches!(cli_parse(&args("unsuspend A@x.org --config r.json")).unwrap().0, Offline::Unsuspend(e) if e == "a@x.org"));
        assert!(matches!(cli_parse(&args("approve-join a@x.org --role admin --config r.json")).unwrap().0, Offline::ApproveJoin { admin: true, .. }));
        assert!(matches!(cli_parse(&args("approve-join a@x.org --config r.json")).unwrap().0, Offline::ApproveJoin { admin: false, .. }));
        assert!(matches!(cli_parse(&args("reset --first-admin a@x.org --config r.json")).unwrap().0, Offline::Reset { .. }));
        // reset is refused without --first-admin, and every command needs --config
        assert_eq!(cli_parse(&args("reset --config r.json")).err().as_deref(), Some(CLI_USAGE));
        assert_eq!(cli_parse(&args("remove-admin a@x.org")).err().as_deref(), Some(CLI_USAGE));
        assert_eq!(cli_parse(&args("approve-join a@x.org --role owner --config r.json")).err().as_deref(), Some(CLI_USAGE));
    }

    #[test]
    fn approve_join_admin_needs_a_relay_admin_and_a_device_anchor() {
        let directory: Obj = json!({"ann@x.org": {"devices": {"aaaa": {"serial": "5F3A"}}}}).as_object().unwrap().clone();
        let admins = vec!["ann@x.org".to_string()];
        assert_eq!(admin_ok(&admins, &directory, "ann@x.org", "5f3a"), Ok(()));
        assert!(admin_ok(&admins, &directory, "ann@x.org", "console").is_err());
        assert!(admin_ok(&admins, &directory, "ann@x.org", "77").is_err());
        assert!(admin_ok(&admins, &directory, "bob@x.org", "5f3a").unwrap_err().contains("not in relay.json admins"));
    }

    // ── a fixture relay ──

    fn fixture(admins: &[&str]) -> (Arc<Relay>, MeetSection) {
        fixture_at(admins, T0)
    }

    /// A fixture relay whose service gate runs on a fake clock at `now` (milliseconds).
    fn fixture_at(admins: &[&str], now: i64) -> (Arc<Relay>, MeetSection) {
        use crate::meet_console_port::tests::{self_signed, temp};
        let dir = temp_dir();
        let (cert, key) = self_signed("relay.example.org");
        let admins: Vec<String> = admins.iter().map(|a| a.to_string()).collect();
        let s = m::Settings { state_dir: dir.to_string_lossy().into_owned(), admins: admins.clone(), console_cert: temp("c.crt", &cert), console_key: temp("c.key", &key), ..m::Settings::default() };
        let tls = crate::meet_tls::console_tls_config(&s).unwrap();
        let links = Arc::new(crate::meet_console::LinkStats::new());
        let hub = Arc::new(crate::meet_hub::Hub::new(Some(dir.clone()), &admins, 168.0, 30.0, 365.0, None, links.clone()));
        let console = crate::meet_console::Console::new(&s, links).unwrap();
        let relay = Arc::new(Relay {
            settings: s,
            hub,
            tls: parking_lot::RwLock::new(tls),
            files: Mutex::new(()),
            refusals: crate::meet_tls::RefusalLog::new(),
            outdated_logged: Mutex::new(HashMap::new()),
            console,
            turn_secret: vec![7; 16],
            last_fetch: Mutex::new(-1e9),
            last_check: Mutex::new(-1e9),
            pc_last_crl_check: Mutex::new(-1e9),
            admin_console: std::sync::OnceLock::new(),
        });
        let cfg = crate::meet_license::GateConfig { state_dir: Some(dir.clone()), license_file: Some(dir.join(crate::meet_license::LICENSE_FILE)), client_ca: dir.join("client_ca.pem") };
        let gate = MeetGate::open(cfg, &relay.hub, crate::meet_time::testclock::FakeClock::new(now)).unwrap();
        relay.hub.set_gate(gate);
        let section = MeetSection::new(Arc::downgrade(&relay), MeetBlocks::open(&dir.join(BLOCKS_FILE)).unwrap(), T0);
        (relay, section)
    }

    fn spec(method: &str, path: &str) -> &'static RouteSpec {
        ROUTES.iter().find(|r| r.method == method && r.path == path).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn call(section: &MeetSection, method: &str, path: &str, query: &str, body: Value, email: &str, admin: bool, license: LicenseState, t: i64) -> Result<SectionAnswer, ApiError> {
        let caller = crate::console::Caller { email: email.into(), admin, manager: admin, ip: "10.0.0.1".into() };
        let c = SectionCall { spec: spec(method, path), query, body: &body, caller: &caller, license, t };
        section.route(&c)
    }

    fn device(relay: &Relay, principal: &str, device: &str, serial: &str) {
        relay.hub.st.lock().directory.insert(principal.into(), json!({"name": principal.to_uppercase(), "devices": {device: {"serial": serial, "label": "Laptop"}}}));
    }

    #[test]
    fn console_identity_is_a_principal_and_no_device() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let who = relay.hub.check_console_admin("Ann@X.org").unwrap();
        assert_eq!((who.kind.as_str(), who.principal.as_str(), who.device.as_str(), who.serial.as_str()), ("console", "ann@x.org", "", ""));
        assert!(!who.guest && !who.seed && !who.is_service() && !who.own_device() && who.cert_pem.is_empty());
        // the same rule as check_admin: only a principal in relay.json admins
        assert_eq!(relay.hub.check_console_admin("bob@x.org").unwrap_err().message(), "only the person who issues certificates can do that");
        // the I8 functions take it without a presence session
        assert!(relay.hub.admin_devices("", &who).is_ok());
        assert!(relay.hub.admin_organizations("", &who).is_ok());
        assert!(relay.hub.admin_pending("", &who).is_ok());
        assert!(relay.hub.bridge_admin("", &who).is_ok());
        assert!(relay.hub.pc_holds_list("", &who).is_ok());
        // and nothing takes it for a device: no block, no own device, never presence
        assert!(!relay.hub.is_blocked(&who));
        // a certificate can never carry the console kind (the retired console server's certificate is refused)
        assert_eq!(crate::meet::CONSOLE_RETIRED, "this is the retired console's certificate; the relay no longer accepts it");
    }

    #[test]
    fn admin_role_only_through_a_device_anchored_passkey() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "ann@x.org", "aaaaaaaaaaaaaaaa", "5F3A");
        assert!(matches!(section.admin_rule("ann@x.org", "5f3a"), AdminRule::Admin));
        assert!(matches!(section.admin_rule("ann@x.org", "console"), AdminRule::ViewerOnly));
        assert!(matches!(section.admin_rule("ann@x.org", "77"), AdminRule::ViewerOnly));
        assert!(matches!(section.admin_rule("bob@x.org", "5f3a"), AdminRule::NotRelayAdmin));
        // approvers of Meet actions must be relay admins too
        assert!(section.may_approve("meet.block", &json!({}), "ann@x.org"));
        assert!(!section.may_approve("meet.block", &json!({}), "bob@x.org"));
        // a people hold needs an approver who meets the org_admins rule (no signer policy here: nobody does)
        assert!(!section.may_approve("meet.holds.place", &json!({"on": "people", "principals": ["c@x.org"]}), "ann@x.org"));
    }

    #[test]
    fn blocks_refuse_at_who_close_sessions_and_never_revoke() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        device(&relay, "ann@x.org", "aaaaaaaaaaaaaaaa", "5f3a");
        // the hub judges a block at `who` against its own clock, so the blocks are placed now (a fixed T0 in the
        // past made every block already over: the baseline failure)
        let now = (pj::now() * 1000.0) as i64;
        let body = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "hours": 4, "reason": "lost laptop"});
        let done = call(&section, "POST", "meet/block", "", body, "ann@x.org", true, LicenseState::None, now).unwrap();
        assert!(matches!(done, SectionAnswer::Done { .. }));
        let bob = Identity { principal: "bob@x.org".into(), device: "bbbbbbbbbbbbbbbb".into(), serial: "77".into(), kind: "person".into(), ..Default::default() };
        assert!(relay.hub.is_blocked(&bob));
        assert!(!relay.hub.is_denied("77"), "a block is never a revocation");
        // a relay admin's device is always an approval
        let admin = json!({"principal": "ann@x.org", "device": "aaaaaaaaaaaaaaaa", "hours": 1, "reason": "test"});
        assert!(matches!(call(&section, "POST", "meet/block", "", admin, "ann@x.org", true, LicenseState::None, now).unwrap(), SectionAnswer::Second { .. }));
        // past 24 hours in 7 days: an approval
        let more = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "hours": 21, "reason": "again"});
        assert!(matches!(call(&section, "POST", "meet/block", "", more, "ann@x.org", true, LicenseState::None, now + 1).unwrap(), SectionAnswer::Second { .. }));
        // the placer lifts alone
        let lift = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "reason": "found"});
        assert!(matches!(call(&section, "POST", "meet/unblock", "", lift, "ann@x.org", true, LicenseState::None, now + 2).unwrap(), SectionAnswer::Done { .. }));
        assert!(!relay.hub.is_blocked(&bob));
    }

    fn release(version: &str, minimum: &str) -> Value {
        json!({"version": version, "files": {"windows": {"name": "LucidMeetingHub.exe", "sha256": "a".repeat(64), "size": 1000}}, "notes": "", "minimum": {"hub": minimum}, "reason": "release"})
    }

    #[test]
    fn release_minimum_rules() {
        let (_relay, section) = fixture(&["ann@x.org", "bob@x.org"]);
        let post = |body: Value| call(&section, "POST", "meet/release", "", body, "ann@x.org", true, LicenseState::Valid, T0);
        let approved = |body: &Value| section.execute(&Approved { action: "meet.release.set", target: "-", params: body, requested_by: "ann@x.org", approved_by: Some("bob@x.org"), t: T0 }).unwrap();
        // a minimum above the release itself is refused
        assert_eq!(post(release("1.0.0", "2.0.0")).err().unwrap().message, crate::meet_ops::RELEASE_MINIMUM_TOO_NEW);
        // the first minimum is a raise: an approval
        assert!(matches!(post(release("1.0.0", "0.9.0")).unwrap(), SectionAnswer::Second { .. }));
        approved(&release("1.0.0", "0.9.0"));
        // every minimum the same: one admin
        assert!(matches!(post(release("1.0.1", "0.9.0")).unwrap(), SectionAnswer::Done { .. }));
        // lowering: an approval, then raising back to the value it replaced within 24 h: one admin
        assert!(matches!(post(release("1.0.2", "0.8.0")).unwrap(), SectionAnswer::Second { .. }));
        approved(&release("1.0.2", "0.8.0"));
        assert!(matches!(post(release("1.0.3", "0.9.0")).unwrap(), SectionAnswer::Done { .. }));
        // raising in any other way, or going back down after a raise, needs a second admin
        assert!(matches!(post(release("1.0.4", "1.0.0")).unwrap(), SectionAnswer::Second { .. }));
        assert!(matches!(post(release("1.0.4", "0.8.0")).unwrap(), SectionAnswer::Second { .. }));
        // the history the page shows
        let view = call(&section, "GET", "meet/release", "", Value::Null, "ann@x.org", false, LicenseState::Valid, T0).unwrap();
        let SectionAnswer::Read(v) = view else { panic!() };
        assert_eq!(v["history"].as_array().unwrap().len(), 4);
        assert_eq!(v["history"][0]["version"], "1.0.3");
        assert!(v["history"][0]["until"].is_null());
    }

    #[test]
    fn a_replacement_license_is_compared_with_the_last_license() {
        // R6-M1, with the development-signed fixtures (test keys only)
        let v: Value = serde_json::from_str(include_str!("../tests/license-v2-products.json")).unwrap();
        let _ = crate::meet_license::TEST_DEV_PUB.set(v["devPub"].as_str().unwrap().to_owned());
        let token = |name: &str| v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["token"].as_str().unwrap().to_owned();
        let (a, b) = (token("Meeting Hub, root A"), token("Meeting Hub, root B"));
        let (relay, section) = fixture_at(&["ann@x.org", "bob@x.org"], v["now"].as_i64().unwrap() * 1000);
        let dir = PathBuf::from(&relay.settings.state_dir);
        std::fs::write(dir.join("client_ca.pem"), v["clientCas"][2]["pem"].as_str().unwrap()).unwrap();
        // lastLicense null: any fitting license is a first license (one admin)
        let first = section.license_candidate(&a, 0).unwrap();
        assert!(first.reference.is_none() && first.single());
        section.license_install(&a, 0).unwrap();
        // the 500-user license is removed by hand: the 20-user one is still compared with it (a second admin)
        std::fs::remove_file(dir.join(crate::meet_license::LICENSE_FILE)).unwrap();
        relay.hub.gate().unwrap().check(true);
        let smaller = section.license_candidate(&b, 0).unwrap();
        let reference = smaller.reference.clone().unwrap();
        assert_eq!((reference.users, reference.id.as_str(), reference.edition.as_str(), reference.relays), (500, "l_00000000000000b1", "enterprise", 2));
        assert!(!smaller.single(), "fewer users (and another root and edition) than the last license");
        // with the 500-user license in force, it is the reference too
        section.license_install(&a, 0).unwrap();
        assert_eq!(section.license_candidate(&b, 0).unwrap().reference.unwrap().users, 500);
    }

    #[test]
    fn bridge_holds_and_organizations_follow_the_two_admin_rules() {
        let (relay, section) = fixture(&["ann@x.org", "bob@x.org"]);
        let on = json!({"org": "acme", "policy": {"enabled": true}, "reason": "partners"});
        assert_eq!(call(&section, "POST", "meet/bridge", "", on.clone(), "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "license-needed");
        assert!(matches!(call(&section, "POST", "meet/bridge", "", on, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
        // a hold on more than 10 conversations waits for a second admin; up to 10 runs at once (holds are off here)
        let cids: Vec<String> = (0..11).map(|i| format!("dm:{}", format!("{i:x}").repeat(64).chars().take(64).collect::<String>())).collect();
        let big = json!({"on": "conversations", "cids": cids, "reason": "litigation"});
        assert!(matches!(call(&section, "POST", "meet/holds", "", big, "ann@x.org", true, LicenseState::None, T0).unwrap(), SectionAnswer::Second { .. }));
        let small = json!({"on": "conversations", "cids": [format!("dm:{}", "a".repeat(64))], "reason": "litigation"});
        assert_eq!(call(&section, "POST", "meet/holds", "", small, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "stale");
        // a people hold by someone who is not that org's admin is refused before it waits
        let people = json!({"on": "people", "principals": ["c@x.org"], "reason": "litigation"});
        assert_eq!(call(&section, "POST", "meet/holds", "", people, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "role");
        // removing someone from an organization is always two-admin
        let remove = json!({"principal": "c@x.org", "remove": true, "reason": "left"});
        assert!(matches!(call(&section, "POST", "meet/organizations", "", remove, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
        // R41-1: with no license (adding closed), a new principal is refused before anything else
        let put = json!({"principal": "c@x.org", "id": "acme", "label": "Acme", "reason": "joined"});
        assert_eq!(section.may_add("meet.org.set", &put).err().unwrap().code, "license-inactive");
        assert!(section.may_add("meet.org.set", &json!({"principal": "c@x.org", "remove": true})).is_ok());
        let invite = json!({"kind": "meet.invite", "target": {"name": "C", "email": "c@x.org", "days": 7}});
        assert_eq!(section.may_add("requests.new", &invite).err().unwrap().code, "license-inactive");
        // a principal the relay holds may be moved: someone with none into an org with no bridge on and no
        // org_admins is one admin
        device(&relay, "c@x.org", "cccccccccccccccc", "c1");
        relay.hub.gate().unwrap().check(true); // seated now, so in everSeated (R6-M2)
        assert!(section.may_add("meet.org.set", &put).is_ok());
        assert!(section.may_add("requests.new", &invite).is_ok());
        assert!(matches!(call(&section, "POST", "meet/organizations", "", put, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Done { .. }));
        // moving them again is two-admin
        let again = json!({"principal": "c@x.org", "id": "other", "label": "Other", "reason": "moved"});
        assert!(matches!(call(&section, "POST", "meet/organizations", "", again, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
    }

    #[test]
    fn views_answer_and_viewers_get_no_people() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let read = |path: &str, query: &str, admin: bool| match call(&section, "GET", path, query, Value::Null, "ann@x.org", admin, LicenseState::Valid, T0) {
            Ok(SectionAnswer::Read(v)) => v,
            other => panic!("{path}: {:?}", other.err()),
        };
        let people = read("meet/people", "q=bob", true);
        assert_eq!(people["people"][0]["principal"], "bob@x.org");
        assert_eq!(people["seats"]["used"], 1);
        assert!(call(&section, "GET", "meet/people", "nope=1", Value::Null, "ann@x.org", true, LicenseState::Valid, T0).is_err());
        assert_eq!(read("meet/identity", "", true), json!({"ok": true, "available": false}));
        assert_eq!(read("meet/enrollments", "", true)["waiting"], json!([]));
        assert_eq!(read("meet/push", "", true)["enabled"], false);
        assert!(read("meet/servers", "", true)["files"].is_null());
        assert_eq!(read("meet/organizations", "", true)["organizations"], json!([]));
        let calls = read("meet/calls", "", false);
        assert!(!calls.to_string().contains('@'), "viewers see no principals");
        // reads need a license in some state (2.4): none locks the section
        assert_eq!(call(&section, "GET", "meet/people", "", Value::Null, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "license-needed");
        assert_eq!(section.sections(LicenseState::None), LOCKED_PAGES.to_vec());
        assert_eq!(section.sections(LicenseState::Expired), PAGES.to_vec());
    }

    #[test]
    fn main_port_routes_with_the_console_off() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let ann = Identity { principal: "ann@x.org".into(), device: "aaaaaaaaaaaaaaaa".into(), serial: "5f3a".into(), kind: "person".into(), ..Default::default() };
        assert_eq!(device_invite(&relay, &ann).unwrap_err().message(), CONSOLE_OFF);
        assert_eq!(requests_for(&relay, "ann@x.org"), obj([("ok", Value::Bool(true)), ("requests", json!([]))]));
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_1")), Some(&json!("no"))).unwrap_err().message(), DECLINE_ID);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!(" "))).unwrap_err().message(), DECLINE_REASON);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!("x".repeat(501)))).unwrap_err().message(), DECLINE_REASON);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!("done already"))).unwrap_err().message(), NO_REQUEST);
    }

    #[test]
    fn push_counters_count_the_last_day() {
        let (before, _) = push::apns::counts();
        push::apns::note(None);
        push::apns::note(Some("410"));
        let (after, failed) = push::apns::counts();
        assert!(after > before);
        assert!(failed.get("410").copied().unwrap_or(0) >= 1);
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_meet.rs");
        for c in [char::from_u32(0x2014).unwrap(), char::from_u32(0x2013).unwrap()] {
            assert!(!src.contains(c));
        }
        for w in [CONSOLE_OFF, CONSOLE_REQUEST_FIELD, DECLINE_ID, DECLINE_REASON, NO_REQUEST] {
            assert!(!w.contains(char::from_u32(0x2014).unwrap()) && !w.contains(char::from_u32(0x2013).unwrap()));
        }
    }
}
