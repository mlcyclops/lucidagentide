// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 5.1 and 5.2, the console end of the compliance routes on the
// front door (I only; relay listeners do not serve them):
//
// - Metadata reads (`compliance.metadata.read`, R0, `confidential`): `v1/compliance/attendance`, `meetings`,
//   `conversations`, `files`, `retention`. The console asks the relays of the org's relay set that the client's
//   `relays` reach with `api-compliance-read` (one at a time, 20 s each), merging pages in relay order and adding
//   `relay` to every item. A relay that does not answer (or is not connected) is listed in `partial` and the cursor
//   resumes it on the next page. The cursor (`after`, opaque) carries the window of the first page, a hash of the
//   filters and each pending relay's own cursor.
// - Holds (`compliance.holds.write` to place, `compliance.metadata.read` to read): `POST v1/compliance/holds` with
//   `Idempotency-Key` (`api_idempotency`), `GET v1/compliance/holds` and `GET v1/compliance/holds/{hold}`. An API hold
//   is a record `<state>/api-holds/<org>/<hold>.json` (flushed), written with its `compliance.hold.requested` audit
//   entry before any relay is asked; then `api-hold` goes to every connected relay of the org's relay set (the archive
//   relay first, the only one asked to make the reviewer's ask). The first relay's refusal `not-covered` or `reviewers`
//   (the org policy is the relays') withdraws the record and refuses the request; a request no relay placed because
//   every connected one has `legal_holds` off is refused `holds-off`. Relays not connected, or that failed, stay
//   `pending`: `tick` resends (idempotent by hold id) until each acknowledged, makes the reviewer's ask once an archive
//   relay is connected, follows the archive outcome with `api-hold-status` (audited `compliance.hold.archive`), and
//   checks hourly whether released relay holds were released everywhere (`released_at`). No API route releases a
//   hold. The list also shows the console-placed people holds the relays keep (`by: {admin}`).
//
// Nothing here reads message text, file names or hashes, meeting descriptions or channel topics: the relays answer
// only the fields of 5.1.

use crate::api_audit::ApiAudit;
use crate::api_idempotency::{self as idem, IdemStore};
use crate::api_map::ApiMapError;
use crate::api_resource::{Body, RouteId};
use crate::codec::{b64u, sha256_hex, stringify, unb64u};
use crate::console_fleet::{FleetLink, LinkError};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 5.2.2: principals one hold names.
pub const HOLD_PRINCIPALS_MAX: usize = 200;
/// 5.2.2: the relay rule `HOLD_REASON_MAX`.
pub const HOLD_REASON_MAX: usize = 500;
/// 5.2.2: `matter`.
pub const MATTER_MAX: usize = 128;
/// 5.2.2: a hold request body.
pub const HOLD_BODY_MAX: usize = 32 * 1024;
/// 5.1: a relay that does not answer within this is `partial`.
pub const READ_MS: u64 = 20_000;
/// The holds' folder under the console's state folder.
pub const HOLDS_DIR: &str = "api-holds";
/// 5.2.2 `notice` (AI-1 7.8).
pub const NO_ARCHIVE: &str = "No archive. A legal hold keeps only ciphertext on the relay, which the organization cannot read.";
const PAGE_DEFAULT: usize = 100;
const PAGE_MAX: usize = 500;
const SPAN_MAX_S: i64 = 400 * 86_400;
const DAY: i64 = 86_400;
/// Pages of console-placed holds read from one relay for a holds list.
const HOLD_PAGES_MAX: usize = 20;
/// How often a hold whose relays all acknowledged is checked for release.
const RELEASE_CHECK_S: i64 = 3600;
const NOT_FOUND: &str = "Nothing is here.";

/// `h_` and 16 lowercase hex.
pub fn hold_id_ok(s: &str) -> bool {
    s.len() == 18 && s.starts_with("h_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A principal as the hold routes take it: `local@domain`, at most 320 bytes, no space or control character.
pub fn principal_ok(p: &str) -> bool {
    let parts: Vec<&str> = p.split('@').collect();
    (3..=320).contains(&p.len()) && parts.len() == 2 && parts.iter().all(|x| !x.is_empty()) && !p.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Printable text of 1 to `max` characters.
pub(crate) fn printable(s: &str, max: usize) -> bool {
    let n = s.chars().count();
    (1..=max).contains(&n) && !s.chars().any(char::is_control) && !s.trim().is_empty()
}

// ── what the routes reach ────────────────────────────────────────────────────────────────────────────────────────

/// The console as the compliance routes and `tick` use it (`ConsoleDesk` in production).
pub trait Desk: Send + Sync {
    /// 2.3 item 2: the org's relay set (every relay that reported it, until retired), sorted.
    fn relays(&self, org: &str) -> Vec<String>;
    fn connected(&self, relay: &str) -> bool;
    /// One fleet request; blocks the calling thread.
    fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, LinkError>;
    /// 2.3 item 1: the relays whose latest `api-features` answer lists the org in `archive_orgs`.
    fn archive_relays(&self, org: &str) -> Vec<String>;
    /// 2.3 item 3.
    fn gate(&self, org: &str, needs: &[&str]) -> Result<(), ApiMapError>;
    /// 2.4 `client_lower_caps`: the client's caps now.
    fn caps(&self, org: &str, client: &str) -> BTreeMap<String, i64>;
    fn idempotency(&self) -> &IdemStore;
    /// The console's state folder (None: in memory only).
    fn dir(&self) -> Option<PathBuf>;
    /// One entry in the org's console audit chain, durable before Ok.
    fn record(&self, org: &str, entry: Value, now: i64) -> Result<(), String>;
    /// 7.1: one event of the console (never refuses).
    fn emit(&self, org: &str, kind: &str, data: Value, now: i64);
    /// Revision 4 5.3: the console's copy of the org's pinned map and relay journal (None: no map).
    fn store(&self, _org: &str) -> Option<crate::api_map::ApiMapStore> {
        None
    }
    /// 2.4: the org's active console journal entries (`client_drop_recipient`, `client_lower_caps`).
    fn console_active(&self, _org: &str) -> Vec<crate::api_cjournal::ConsoleEntry> {
        Vec::new()
    }
    /// 4.3 and 6.7: the person is active for the org (the console's people data).
    fn owner_active(&self, _org: &str, _principal: &str) -> bool {
        true
    }
    /// 5.3.8: free bytes on the disk of the console's state folder (None: unknown).
    fn free_bytes(&self) -> Option<u64> {
        None
    }
    /// The orgs with a pinned map (revision 4 12: the tick reads their console-placed holds for
    /// `lucid_compliance_holds`).
    fn orgs(&self) -> Vec<String> {
        Vec::new()
    }
}

/// The production desk: the console's api state, fleet link, state folder and audit chains.
pub struct ConsoleDesk {
    pub api: Arc<crate::console_api::ConsoleApi>,
    pub link: Option<Arc<dyn FleetLink>>,
    pub dir: Option<PathBuf>,
    pub audit: Arc<ApiAudit>,
    /// Revision 4 5.3: the console's people data (an owner deprovisioned narrows an export client).
    pub people: Option<Arc<crate::fleet_people::People>>,
}

impl Desk for ConsoleDesk {
    fn relays(&self, org: &str) -> Vec<String> {
        self.api.relay_set(org).into_keys().collect()
    }
    fn connected(&self, relay: &str) -> bool {
        self.link.as_ref().is_some_and(|l| l.connected(relay))
    }
    fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, LinkError> {
        match &self.link {
            Some(l) => l.request(relay, op, body, timeout_ms),
            None => Err(LinkError::Offline),
        }
    }
    fn archive_relays(&self, org: &str) -> Vec<String> {
        self.api.relay_set(org).into_iter().filter(|(_, r)| r.as_ref().is_some_and(|r| r.archive_orgs.iter().any(|o| o == org))).map(|(id, _)| id).collect()
    }
    fn gate(&self, org: &str, needs: &[&str]) -> Result<(), ApiMapError> {
        self.api.gate(org, needs)
    }
    fn caps(&self, org: &str, client: &str) -> BTreeMap<String, i64> {
        let pinned = self.api.pinned(org).0;
        crate::api_cjournal::caps(pinned.as_ref(), &self.api.console_active(org), client)
    }
    fn idempotency(&self) -> &IdemStore {
        self.api.idempotency()
    }
    fn dir(&self) -> Option<PathBuf> {
        self.dir.clone()
    }
    fn record(&self, org: &str, entry: Value, now: i64) -> Result<(), String> {
        self.audit.record(org, entry, now).map(|_| ()).map_err(|e| e.message)
    }
    fn emit(&self, org: &str, kind: &str, data: Value, now: i64) {
        let _ = self.api.emit_event(org, kind, data, now);
    }
    fn store(&self, org: &str) -> Option<crate::api_map::ApiMapStore> {
        self.api.org_snapshot(org)
    }
    fn console_active(&self, org: &str) -> Vec<crate::api_cjournal::ConsoleEntry> {
        self.api.console_active(org)
    }
    fn owner_active(&self, org: &str, principal: &str) -> bool {
        !self.people.as_ref().is_some_and(|p| p.person_inactive(org, principal))
    }
    fn free_bytes(&self) -> Option<u64> {
        self.dir.as_deref().and_then(crate::api_exports::free_bytes)
    }
    fn orgs(&self) -> Vec<String> {
        self.api.orgs()
    }
}

// ── one request ──────────────────────────────────────────────────────────────────────────────────────────────────

/// One compliance request that passed the resource pipeline.
pub struct Req<'a> {
    pub org: &'a str,
    pub route: RouteId,
    /// The route's name in audit entries (`GET /api/orgs/acme/v1/...`).
    pub route_name: &'a str,
    /// The path's `{hold}` or `{job}`.
    pub id: Option<&'a str>,
    /// Revision 4 5.3.7: a part route's `{n}`.
    pub n: Option<&'a str>,
    pub query: &'a str,
    pub client: &'a str,
    /// The grant's `relays` (`*` or relay ids).
    pub reach: &'a [String],
    /// The client's entry in the pinned map.
    pub entry: Option<&'a Map<String, Value>>,
    pub body: Option<&'a Body>,
    pub rid: &'a str,
    pub now: i64,
}

/// An answer: its status and body; `replayed` for an `Idempotency-Key` replay (audited `result: "replayed"`).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub replayed: bool,
    /// Revision 4 5.3.7: an export part's ciphertext (sent as `application/octet-stream` instead of `body`) and its
    /// `ETag`.
    pub bytes: Option<Vec<u8>>,
    pub etag: Option<String>,
}

/// A refusal before it is audited and answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub status: u16,
    pub code: &'static str,
    pub why: String,
    pub retry: Option<i64>,
}

pub(crate) fn no(status: u16, code: &'static str, why: impl Into<String>) -> Refused {
    Refused { status, code, why: why.into(), retry: None }
}

pub(crate) fn ok(status: u16, body: Value) -> Answer {
    Answer { status, body, replayed: false, bytes: None, etag: None }
}

/// The compliance routes of `ROUTES`.
pub fn serve(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    match req.route {
        RouteId::ComplianceAttendance => read(desk, req, "attendance"),
        RouteId::ComplianceMeetings => read(desk, req, "meetings"),
        RouteId::ComplianceConversations => read(desk, req, "conversations"),
        RouteId::ComplianceFiles => read(desk, req, "files"),
        RouteId::ComplianceRetention => retention(desk, req),
        RouteId::ComplianceHolds => holds_list(desk, req),
        RouteId::ComplianceHold => hold_one(desk, req),
        RouteId::ComplianceHoldPlace => place(desk, req),
        // revision 4 5.3.7
        RouteId::ComplianceExportRequest
        | RouteId::ComplianceExports
        | RouteId::ComplianceExport
        | RouteId::ComplianceExportSeal
        | RouteId::ComplianceExportPart
        | RouteId::ComplianceExportCancel => crate::api_exports::serve(desk, req),
        _ => Err(no(404, "not-found", NOT_FOUND)),
    }
}

// ── query parameters ─────────────────────────────────────────────────────────────────────────────────────────────

/// `%XX` decoded (`+` stays itself: a principal may hold one); None for a malformed escape or text that is not UTF-8.
fn pct(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The query's parameters (each name once), decoded.
pub(crate) fn params(query: &str) -> Result<BTreeMap<String, String>, Refused> {
    let mut out = BTreeMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (Some(k), Some(v)) = (pct(k), pct(v)) else { return Err(no(400, "bad-request", "The query does not read.")) };
        if out.insert(k.clone(), v).is_some() {
            return Err(no(400, "bad-request", format!("{k} is given twice.")));
        }
    }
    Ok(out)
}

fn bad(why: impl Into<String>) -> Refused {
    no(400, "bad-request", why)
}

/// The relays of the org's set the client's `relays` reach.
fn reached(desk: &dyn Desk, req: &Req) -> Vec<String> {
    desk.relays(req.org).into_iter().filter(|r| req.reach.iter().any(|x| x == "*" || x == r)).collect()
}

/// An item with `relay` first.
fn with_relay(relay: &str, item: Value) -> Value {
    let mut m = Map::new();
    m.insert("relay".into(), Value::from(relay));
    if let Value::Object(o) = item {
        m.extend(o.into_iter().filter(|(k, _)| k != "relay"));
    }
    Value::Object(m)
}

/// The cursor of a metadata read: `{k, f, t, x, p}` (kind, window, filters hash, pending relays and their cursors).
#[derive(Debug, Clone, PartialEq)]
struct Cursor {
    kind: String,
    from: i64,
    to: i64,
    filters: String,
    pending: BTreeMap<String, Option<String>>,
}

impl Cursor {
    fn encode(&self) -> String {
        b64u(stringify(&json!({ "k": self.kind, "f": self.from, "t": self.to, "x": self.filters, "p": self.pending })).as_bytes())
    }

    fn decode(s: &str) -> Option<Cursor> {
        let v = crate::codec::parse_json(&String::from_utf8(unb64u(s)?).ok()?)?;
        let pending = v.get("p")?.as_object()?.iter().map(|(r, a)| Some((r.clone(), match a { Value::Null => None, Value::String(s) => Some(s.clone()), _ => return None }))).collect::<Option<_>>()?;
        Some(Cursor { kind: v.get("k")?.as_str()?.into(), from: v.get("f")?.as_i64()?, to: v.get("t")?.as_i64()?, filters: v.get("x")?.as_str()?.into(), pending })
    }
}

/// 5.1 metadata reads.
fn read(desk: &dyn Desk, req: &Req, kind: &str) -> Result<Answer, Refused> {
    let p = params(req.query)?;
    let allowed: &[&str] = match kind {
        "attendance" => &["person", "room"],
        "meetings" => &["organizer", "person"],
        "conversations" => &["person"],
        _ => &["cid", "room"],
    };
    if let Some(k) = p.keys().find(|k| !["from", "to", "after", "limit"].contains(&k.as_str()) && !allowed.contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a parameter of this route.")));
    }
    let limit = match p.get("limit") {
        None => PAGE_DEFAULT,
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| bad("limit must be a number from 1 to 500."))?,
    };
    let mut filters: Map<String, Value> = Map::new();
    for k in allowed {
        if let Some(v) = p.get(*k) {
            let v = if ["person", "organizer"].contains(k) {
                let v = v.trim().to_lowercase();
                if !principal_ok(&v) {
                    return Err(bad(format!("{k} is a principal.")));
                }
                v
            } else if v.is_empty() || v.len() > 128 {
                return Err(bad(format!("{k} is 1 to 128 characters.")));
            } else {
                v.clone()
            };
            filters.insert((*k).into(), Value::from(v));
        }
    }
    if kind == "conversations" && !filters.contains_key("person") {
        return Err(bad("person is required."));
    }
    if kind == "files" && filters.len() != 1 {
        return Err(bad("Name one of cid or room."));
    }
    let hash = sha256_hex(stringify(&Value::Object(filters.clone())).as_bytes());
    let cursor = match p.get("after") {
        Some(a) => Cursor::decode(a).filter(|c| c.kind == kind && c.filters == hash).ok_or_else(|| bad("after is not a cursor of this list."))?,
        None => {
            let int = |k: &str| p.get(k).map(|v| v.parse::<i64>().map_err(|_| bad(format!("{k} is Unix seconds.")))).transpose();
            let to = int("to")?.unwrap_or(req.now);
            let from = int("from")?.unwrap_or(to - 30 * DAY);
            if from > to || to - from > SPAN_MAX_S {
                return Err(bad("from and to span at most 400 days, from first."));
            }
            Cursor { kind: kind.into(), from, to, filters: hash, pending: reached(desk, req).into_iter().map(|r| (r, None)).collect() }
        }
    };
    let mut items: Vec<Value> = Vec::new();
    let mut partial: Vec<String> = Vec::new();
    let mut kept_days = Map::new();
    let mut pending = cursor.pending.clone();
    let reach = reached(desk, req);
    for (relay, after) in &cursor.pending {
        // a relay retired from the set, or no longer reached, is done
        if !reach.contains(relay) {
            pending.remove(relay);
            continue;
        }
        let room = limit - items.len();
        if room == 0 {
            break;
        }
        if !desk.connected(relay) {
            partial.push(relay.clone());
            continue;
        }
        let mut params = filters.clone();
        params.insert("from".into(), Value::from(cursor.from));
        params.insert("to".into(), Value::from(cursor.to));
        params.insert("limit".into(), Value::from(room));
        let body = json!({ "org": req.org, "kind": kind, "params": params, "after": after });
        match desk.request(relay, "api-compliance-read", body, READ_MS) {
            Ok(v) => {
                items.extend(v.get("items").and_then(Value::as_array).into_iter().flatten().take(room).map(|i| with_relay(relay, i.clone())));
                if let Some(d) = v.get("kept_days").and_then(Value::as_i64) {
                    kept_days.insert(relay.clone(), Value::from(d));
                }
                match v.get("next").and_then(Value::as_str) {
                    Some(n) => {
                        pending.insert(relay.clone(), Some(n.to_string()));
                    }
                    None => {
                        pending.remove(relay);
                    }
                }
            }
            Err(_) => partial.push(relay.clone()),
        }
    }
    let mut body = json!({ "items": items });
    if !partial.is_empty() {
        body["partial"] = json!(partial);
    }
    if kind == "attendance" {
        body["kept_days"] = Value::Object(kept_days);
    }
    if !pending.is_empty() {
        body["next"] = Value::from(Cursor { pending, ..cursor }.encode());
    }
    Ok(ok(200, body))
}

/// 5.1 `retention`: the newest policy any reached relay holds, each relay's `legal_holds`, and the active holds (the
/// org's API holds placed somewhere and not released, plus each relay's console-placed ones).
fn retention(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let p = params(req.query)?;
    if let Some(k) = p.keys().next() {
        return Err(bad(format!("{k} is not a parameter of this route.")));
    }
    let mut best: Option<Value> = None;
    let mut legal = Map::new();
    let mut partial = Vec::new();
    let mut console_holds = 0;
    for relay in reached(desk, req) {
        if !desk.connected(&relay) {
            partial.push(relay);
            continue;
        }
        match desk.request(&relay, "api-compliance-read", json!({ "org": req.org, "kind": "retention", "params": {}, "after": null }), READ_MS) {
            Ok(v) => {
                let Some(item) = v.get("items").and_then(|i| i.get(0)).cloned() else { continue };
                legal.insert(relay.clone(), Value::Bool(item.get("legal_holds") == Some(&Value::Bool(true))));
                console_holds += item.get("holds_active").and_then(Value::as_u64).unwrap_or(0);
                let seq = |v: &Value| v.get("policy_seq").and_then(Value::as_i64).unwrap_or(0);
                if best.as_ref().is_none_or(|b| seq(&item) > seq(b)) {
                    best = Some(item);
                }
            }
            Err(_) => partial.push(relay),
        }
    }
    let api_active = records(desk, req.org).iter().filter(|r| r.get("released_at").is_none() && relays_of(r).values().any(|s| s == "placed")).count() as u64;
    let b = best.unwrap_or_else(|| json!({}));
    let mut body = json!({
        "policy_seq": b.get("policy_seq").cloned().unwrap_or(json!(0)),
        "retention": b.get("retention").cloned().unwrap_or(json!({})),
        "archive": b.get("archive").cloned().unwrap_or(json!({ "present": false, "reviewers": 0 })),
        "legal_holds": legal,
        "holds_active": api_active + console_holds,
    });
    if !partial.is_empty() {
        body["partial"] = json!(partial);
    }
    Ok(ok(200, body))
}

// ── hold records ─────────────────────────────────────────────────────────────────────────────────────────────────

static HOLDS_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn org_dir(desk: &dyn Desk, org: &str) -> Option<PathBuf> {
    desk.dir().map(|d| d.join(HOLDS_DIR).join(org))
}

/// In-memory records of a console without a state folder (tests and a console that keeps none).
static MEMORY: std::sync::LazyLock<parking_lot::Mutex<BTreeMap<(String, String), Value>>> = std::sync::LazyLock::new(Default::default);

fn save_record(desk: &dyn Desk, org: &str, rec: &Value) -> Result<(), String> {
    let hold = rec.get("hold").and_then(Value::as_str).unwrap_or_default();
    let Some(dir) = org_dir(desk, org) else {
        MEMORY.lock().insert((org.to_string(), hold.to_string()), rec.clone());
        return Ok(());
    };
    crate::store::make_dir(&dir).map_err(|e| e.to_string())?;
    crate::fleet_local::write_durable(&dir.join(format!("{hold}.json")), stringify(rec).as_bytes())
}

fn drop_record(desk: &dyn Desk, org: &str, hold: &str) {
    match org_dir(desk, org) {
        Some(dir) => {
            let _ = std::fs::remove_file(dir.join(format!("{hold}.json")));
        }
        None => {
            MEMORY.lock().remove(&(org.to_string(), hold.to_string()));
        }
    }
}

fn load_record(path: &Path) -> Option<Value> {
    crate::codec::parse_json(&std::fs::read_to_string(path).ok()?).filter(|v| v.get("hold").and_then(Value::as_str).is_some_and(hold_id_ok))
}

/// Every API hold record of the org, oldest first.
fn records(desk: &dyn Desk, org: &str) -> Vec<Value> {
    let mut out: Vec<Value> = match org_dir(desk, org) {
        Some(dir) => std::fs::read_dir(&dir).into_iter().flatten().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).filter_map(|e| load_record(&e.path())).collect(),
        None => MEMORY.lock().iter().filter(|((o, _), _)| o == org).map(|(_, v)| v.clone()).collect(),
    };
    out.sort_by_key(|r| (r.get("at").and_then(Value::as_i64).unwrap_or(0), r.get("hold").and_then(Value::as_str).unwrap_or_default().to_string()));
    out
}

fn relays_of(rec: &Value) -> BTreeMap<String, String> {
    rec.get("relays").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()
}

/// 5.2.4: an API hold as the routes show it.
fn resource(rec: &Value) -> Value {
    let principals = rec.get("principals").cloned().unwrap_or_else(|| json!([]));
    let mut v = json!({
        "hold": rec["hold"], "on": "people", "count": principals.as_array().map_or(0, Vec::len), "principals": principals,
        "reason": rec["reason"], "placed_at": rec["at"], "by": { "client": rec["client"], "owner": rec["owner"] },
        "relays": rec.get("relays").cloned().unwrap_or_else(|| json!({})), "archive": rec["archive"],
    });
    if let Some(m) = rec.get("matter").filter(|m| m.is_string()) {
        v["matter"] = m.clone();
    }
    if let Some(r) = rec.get("released_at").filter(|r| r.is_i64()) {
        v["released_at"] = r.clone();
    }
    v
}

/// The `hold` of an `api-hold` request (the relay-side check is `api_holds_relay::hold_of`).
fn wire(rec: &Value) -> Value {
    let mut w = Map::new();
    for k in ["hold", "on", "principals", "reason", "matter", "reviewer", "client", "client_name", "owner", "by", "at"] {
        if let Some(v) = rec.get(k).filter(|v| !v.is_null()) {
            w.insert(k.into(), v.clone());
        }
    }
    Value::Object(w)
}

/// The relays a hold goes to, the archive relays first.
fn send_order(desk: &dyn Desk, org: &str) -> (Vec<String>, Vec<String>) {
    let archives = desk.archive_relays(org);
    let mut all = archives.clone();
    all.extend(desk.relays(org).into_iter().filter(|r| !archives.contains(r)));
    (all, archives)
}

/// One `api-hold`; `ask` on the archive relay that makes the reviewer's ask.
fn send(desk: &dyn Desk, org: &str, rec: &Value, relay: &str, ask: bool) -> Result<Value, LinkError> {
    desk.request(relay, "api-hold", json!({ "org": org, "hold": wire(rec), "ask_reviewer": ask }), READ_MS)
}

/// What one relay's `api-hold` answer does to a record: its relay state, the archive state and the ask.
fn take_answer(rec: &mut Value, relay: &str, answer: &Result<Value, LinkError>) {
    let state = match answer {
        Ok(_) => "placed",
        Err(LinkError::Refused { code, .. }) if code == "holds-off" => "off",
        Err(_) => "pending",
    };
    rec["relays"][relay] = Value::from(state);
    if let Ok(v) = answer {
        if rec["archive"].as_str() == Some("unknown") {
            rec["archive"] = v.get("archive").cloned().filter(|a| a == "waiting" || a == "none").unwrap_or(json!("waiting"));
        }
        if let Some(r) = v.get("request").and_then(Value::as_str) {
            rec["ask"] = json!({ "relay": relay, "request": r });
        }
    }
}

/// 5.2.2 `POST v1/compliance/holds`.
fn place(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let body = req.body.ok_or_else(|| bad("This route takes a JSON body."))?;
    let key = idem::parse_key(body.key.as_deref()).map_err(|r| no(r.status, r.code, r.why()))?;
    let json = match &body.json {
        Ok(v) => v,
        Err(code) if *code == "too-large" => return Err(no(413, "too-large", "A hold request is at most 32 KiB.")),
        Err(_) => return Err(bad("The body is not a JSON object.")),
    };
    match desk.idempotency().begin(req.org, req.client, &key, json, req.now) {
        idem::Begin::Replay { status, body } => return Ok(Answer { replayed: true, ..ok(status, body) }),
        idem::Begin::Refused(r) => return Err(no(r.status, r.code, r.why())),
        idem::Begin::Fresh => {}
    }
    let sha256 = idem::body_sha256(json);
    // the key of a hold kept before a restart: its record carries the key, the body hash and, once answered, the answer
    let kept_before = records(desk, req.org).into_iter().find_map(|r| {
        let i = r.get("idem")?;
        (i.get("client").and_then(Value::as_str) == Some(req.client) && i.get("key").and_then(Value::as_str) == Some(key.as_str())).then(|| i.clone())
    });
    if let Some(i) = kept_before.filter(|i| i.get("at").and_then(Value::as_i64).is_some_and(|at| req.now - at < idem::KEEP_S)) {
        let at = i.get("at").and_then(Value::as_i64).unwrap_or(req.now);
        let was = i.get("sha256").and_then(Value::as_str).unwrap_or_default().to_string();
        let answer = i.get("status").and_then(Value::as_u64).map(|s| (s as u16, i.get("body").cloned().unwrap_or(Value::Null)));
        desk.idempotency().recover(req.org, req.client, &key, &was, at, answer.clone());
        return match answer {
            _ if was != sha256 => Err(no(idem::MISMATCH.status, idem::MISMATCH.code, idem::MISMATCH.why())),
            Some((status, body)) => Ok(Answer { replayed: true, ..ok(status, body) }),
            None => Err(no(idem::BUSY.status, idem::BUSY.code, idem::BUSY.why())),
        };
    }
    let mut kept = false;
    let out = place_fresh(desk, req, json, &json!({ "client": req.client, "key": key, "sha256": sha256, "at": req.now }), &mut kept);
    match &out {
        // the hold record already carries the answer: a failed key write leaves the key running here and replayable after
        // a restart, never free for a second hold
        Ok(a) => {
            if desk.idempotency().finish(req.org, req.client, &key, a.status, &a.body).is_err() {
                return Err(no(503, "unavailable", "The console could not keep the answer of this request; try again later with the same Idempotency-Key."));
            }
        }
        // a hold record carries the key: it stays running, so a retry cannot place a second hold
        Err(_) if kept => {}
        Err(_) => desk.idempotency().abandon(req.org, req.client, &key),
    }
    out
}

/// `key_entry` is the request's idempotency entry (client, key, body hash, time), kept in the hold record with the
/// answer; `kept` is true while a hold record of this request is on disk.
fn place_fresh(desk: &dyn Desk, req: &Req, json: &Value, key_entry: &Value, kept: &mut bool) -> Result<Answer, Refused> {
    let o = json.as_object().ok_or_else(|| bad("The body is a JSON object."))?;
    if let Some(k) = o.keys().find(|k| !["on", "principals", "reason", "matter", "reviewer"].contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a field of a hold.")));
    }
    if o.get("on").and_then(Value::as_str) != Some("people") {
        return Err(bad("on must be people."));
    }
    let list = o.get("principals").and_then(Value::as_array).filter(|l| (1..=HOLD_PRINCIPALS_MAX).contains(&l.len())).ok_or_else(|| bad("principals names 1 to 200 people."))?;
    let mut principals: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().map(|s| s.trim().to_lowercase()).filter(|p| principal_ok(p)).ok_or_else(|| bad("Each principal is local@domain."))?;
        if principals.contains(&p) {
            return Err(bad("principals are unique."));
        }
        principals.push(p);
    }
    let reason = o.get("reason").and_then(Value::as_str).filter(|r| printable(r, HOLD_REASON_MAX)).ok_or_else(|| bad("reason is 1 to 500 printable characters."))?.to_string();
    let matter = match o.get("matter") {
        None => None,
        Some(m) => Some(m.as_str().filter(|m| printable(m, MATTER_MAX)).ok_or_else(|| bad("matter is 1 to 128 printable characters."))?.to_string()),
    };
    let reviewer = match o.get("reviewer") {
        None => None,
        Some(r) => Some(r.as_str().map(|s| s.trim().to_lowercase()).filter(|r| principal_ok(r)).ok_or_else(|| bad("reviewer is a principal."))?),
    };
    let entry = req.entry.ok_or_else(|| no(403, "suspended", "That client is not registered."))?;
    let s = |k: &str| entry.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (owner, by, name) = (s("owner"), s("principal"), s("name"));
    if reviewer.as_deref() == Some(owner.as_str()) {
        return Err(no(409, "reviewers", "The reviewer cannot be the client's owner."));
    }
    desk.gate(req.org, &[crate::api_features::COMPLIANCE]).map_err(|e| no(409, "relay-outdated", e.message))?;
    let (order, archives) = send_order(desk, req.org);
    if !order.iter().any(|r| desk.connected(r)) {
        return Err(no(503, "relay-unreachable", "No relay of the organization is connected."));
    }
    // 429 quota: the holds of this client since the UTC day began
    let cap = desk.caps(req.org, req.client).get("holds_per_day").copied().unwrap_or(0);
    let day = req.now - req.now.rem_euclid(DAY);
    let today = records(desk, req.org).iter().filter(|r| r.get("client").and_then(Value::as_str) == Some(req.client) && r.get("at").and_then(Value::as_i64).is_some_and(|at| at >= day)).count() as i64;
    if today >= cap {
        return Err(Refused { retry: Some(day + DAY - req.now), ..no(429, "quota", "This client placed its holds for today; see Retry-After.") });
    }
    let mut id = [0u8; 8];
    aws_lc_rs::rand::fill(&mut id).map_err(|_| no(503, "unavailable", "The console could not make a hold id."))?;
    let hold = format!("h_{}", crate::codec::hex(&id));
    let mut rec = json!({
        "hold": hold, "on": "people", "principals": principals, "reason": reason, "client": req.client, "client_name": name,
        "owner": owner, "by": by, "at": req.now, "relays": {}, "archive": "unknown", "idem": key_entry,
    });
    if let Some(m) = &matter {
        rec["matter"] = Value::from(m.clone());
    }
    if let Some(r) = &reviewer {
        rec["reviewer"] = Value::from(r.clone());
    }
    // 5.2.3 step 1: audited and kept before any relay is asked
    let mut e = json!({ "rid": req.rid, "route": req.route_name, "action": "compliance.hold.requested", "result": "ok", "hold": hold, "on": "people",
                        "count": principals.len(), "client": req.client, "owner": owner });
    if let Some(r) = &reviewer {
        e["reviewer"] = Value::from(r.clone());
    }
    if let Some(m) = &matter {
        e["matter"] = Value::from(m.clone());
    }
    desk.record(req.org, e, req.now).map_err(|_| no(503, "audit-unavailable", "The audit log cannot record this request now; try again later."))?;
    let _one = HOLDS_LOCK.lock();
    save_record(desk, req.org, &rec).map_err(|_| no(503, "unavailable", "The console could not keep the hold; try again."))?;
    *kept = true;
    // step 2: every connected relay, the archive relay first
    let mut asked = false;
    for relay in &order {
        if !desk.connected(relay) {
            rec["relays"][relay.as_str()] = json!("pending");
            continue;
        }
        let ask = !asked && archives.contains(relay);
        asked |= ask;
        let answer = send(desk, req.org, &rec, relay, ask);
        let first = !relays_of(&rec).values().any(|s| s == "placed");
        if let Err(LinkError::Refused { code, error, .. }) = &answer {
            let code: Option<&'static str> = ["not-covered", "reviewers"].into_iter().find(|c| *c == code.as_str());
            if let (Some(code), true) = (code, first) {
                // the org policy is the relays': nothing was placed, so the request is withdrawn
                drop_record(desk, req.org, &hold);
                *kept = false;
                let why = if code == "not-covered" { "A principal is not covered by the organization's policy.".to_string() } else { error.clone() };
                return Err(no(if code == "not-covered" { 403 } else { 409 }, code, why));
            }
        }
        take_answer(&mut rec, relay, &answer);
    }
    let states = relays_of(&rec);
    if !states.values().any(|s| s == "placed") && states.iter().all(|(r, s)| s == "off" || !desk.connected(r)) {
        drop_record(desk, req.org, &hold);
        *kept = false;
        return Err(no(409, "holds-off", "No relay of the organization has legal holds on."));
    }
    let archive = rec["archive"].as_str().map(|a| if a == "unknown" { "waiting" } else { a }).unwrap_or("waiting").to_string();
    let relay_state = if states.values().any(|s| s == "placed") { "placed" } else { "pending" };
    let mut body = json!({ "hold": hold, "state": { "relay": relay_state, "archive": archive }, "relays": states });
    if archive == "none" {
        body["notice"] = Value::from(NO_ARCHIVE);
    }
    // the answer is kept with the hold, so a retry with the same key replays it even when the key store cannot keep it
    rec["idem"]["status"] = Value::from(202);
    rec["idem"]["body"] = body.clone();
    save_record(desk, req.org, &rec).map_err(|_| no(503, "unavailable", "The console could not keep the hold; try again later with the same Idempotency-Key."))?;
    if states.values().any(|s| s == "placed") {
        desk.emit(req.org, "hold.placed", json!({ "hold": hold, "on": "people", "count": principals.len(), "by": req.client }), req.now);
    }
    publish_holds(desk, req.org);
    Ok(ok(202, body))
}

/// The console-placed people holds the given relays of the org keep (`api-compliance-read` kind `holds`), with the
/// relays that did not answer. A relay read to its last page replaces what `lucid_compliance_holds` knows of its
/// console-placed holds.
fn relay_holds(desk: &dyn Desk, org: &str, relays: Vec<String>) -> (Vec<Value>, Vec<String>) {
    let (mut out, mut partial) = (Vec::new(), Vec::new());
    for relay in relays {
        if !desk.connected(&relay) {
            partial.push(relay);
            continue;
        }
        let mut after = Value::Null;
        let mut active = BTreeSet::new();
        let mut whole = false;
        for _ in 0..HOLD_PAGES_MAX {
            match desk.request(&relay, "api-compliance-read", json!({ "org": org, "kind": "holds", "params": { "limit": PAGE_MAX }, "after": after }), READ_MS) {
                Ok(v) => {
                    for item in v.get("items").and_then(Value::as_array).into_iter().flatten() {
                        let mut h = item.clone();
                        let state = if h.get("released_at").is_some() { "released" } else { "placed" };
                        if let (Some(id), "placed") = (h.get("hold").and_then(Value::as_str), state) {
                            active.insert(id.to_string());
                        }
                        h["relays"] = json!({ relay.as_str(): state });
                        out.push(h);
                    }
                    match v.get("next") {
                        Some(n) if n.is_string() => after = n.clone(),
                        _ => {
                            whole = true;
                            break;
                        }
                    }
                }
                Err(_) => {
                    partial.push(relay.clone());
                    break;
                }
            }
        }
        if whole {
            CONSOLE_HOLDS.lock().entry(org.to_string()).or_default().insert(relay, active);
        }
    }
    publish_holds(desk, org);
    (out, partial)
}

/// Revision 4 12 `lucid_compliance_holds`: per org and relay, the console-placed people holds the relay last reported
/// active (read whole by `relay_holds`).
static CONSOLE_HOLDS: std::sync::LazyLock<parking_lot::Mutex<BTreeMap<String, BTreeMap<String, BTreeSet<String>>>>> = std::sync::LazyLock::new(Default::default);
/// When the tick last read each org's console-placed holds.
static CONSOLE_READ: std::sync::LazyLock<parking_lot::Mutex<BTreeMap<String, i64>>> = std::sync::LazyLock::new(Default::default);
/// How often the tick reads the console-placed holds of an org with a pinned map.
const CONSOLE_HOLDS_S: i64 = 900;

/// Revision 4 12 `lucid_compliance_holds` for the org: `placed` counts its API holds placed on a relay and not released
/// plus the console-placed holds its relays last reported active (each hold once, relays of the org's set only);
/// `waiting_archive` counts its unreleased API holds whose archive reviewer has not decided.
fn publish_holds(desk: &dyn Desk, org: &str) {
    let (mut placed, mut waiting) = (0u64, 0u64);
    for r in records(desk, org).iter().filter(|r| r.get("released_at").is_none()) {
        placed += u64::from(relays_of(r).values().any(|s| s == "placed"));
        waiting += u64::from(r["archive"] == "waiting");
    }
    let set = desk.relays(org);
    let console: BTreeSet<String> = CONSOLE_HOLDS.lock().get(org).into_iter().flatten().filter(|(relay, _)| set.contains(relay)).flat_map(|(_, ids)| ids.iter().cloned()).collect();
    placed += console.len() as u64;
    crate::api_catalog::counters::set_compliance_holds(org, "placed", placed);
    crate::api_catalog::counters::set_compliance_holds(org, "waiting_archive", waiting);
}

/// 5.1 `GET v1/compliance/holds`: the API holds and the console-placed ones, oldest first (cursor `<placed_at>:<id>`).
fn holds_list(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let p = params(req.query)?;
    if let Some(k) = p.keys().find(|k| !["after", "limit"].contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a parameter of this route.")));
    }
    let limit = match p.get("limit") {
        None => PAGE_DEFAULT,
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| bad("limit must be a number from 1 to 500."))?,
    };
    let after: Option<(i64, String)> = match p.get("after") {
        None => None,
        Some(a) => Some(unb64u(a).and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.split_once(':').and_then(|(n, id)| Some((n.parse().ok()?, id.to_string())))).ok_or_else(|| bad("after is not a cursor of this list."))?),
    };
    let (theirs, partial) = relay_holds(desk, req.org, reached(desk, req));
    let mut all: Vec<((i64, String), Value)> = records(desk, req.org).iter().map(resource).chain(theirs).map(|h| ((h["placed_at"].as_i64().unwrap_or(0), h["hold"].as_str().unwrap_or_default().to_string()), h)).collect();
    all.sort_by(|a, b| a.0.cmp(&b.0));
    let mut page: Vec<((i64, String), Value)> = all.into_iter().filter(|(k, _)| after.as_ref().is_none_or(|a| k > a)).collect();
    let more = page.len() > limit;
    page.truncate(limit);
    let mut body = json!({ "holds": page.iter().map(|(_, h)| h.clone()).collect::<Vec<_>>() });
    if let (true, Some((k, _))) = (more, page.last()) {
        body["next"] = Value::from(b64u(format!("{}:{}", k.0, k.1).as_bytes()));
    }
    if !partial.is_empty() {
        body["partial"] = json!(partial);
    }
    Ok(ok(200, body))
}

/// 5.1 `GET v1/compliance/holds/{hold}`: an API hold by its `h_` id, else a console-placed one by its relay id.
fn hold_one(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let id = req.id.unwrap_or_default();
    if hold_id_ok(id) {
        return records(desk, req.org).iter().find(|r| r["hold"] == id).map(|r| ok(200, resource(r))).ok_or_else(|| no(404, "not-found", NOT_FOUND));
    }
    if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(no(404, "not-found", NOT_FOUND));
    }
    let (theirs, _) = relay_holds(desk, req.org, reached(desk, req));
    let mut found: Option<Value> = None;
    for h in theirs.into_iter().filter(|h| h["hold"] == id) {
        match &mut found {
            None => found = Some(h),
            Some(f) => {
                if let (Some(to), Some(from)) = (f["relays"].as_object_mut(), h["relays"].as_object()) {
                    to.extend(from.clone());
                }
            }
        }
    }
    found.map(|h| ok(200, h)).ok_or_else(|| no(404, "not-found", NOT_FOUND))
}

/// Revision 4 13.2 (`GET compliance/holds`, the console's Compliance page): every API hold of the org as 5.2.4 shows
/// it with `source: "api"`, and the console-placed holds every relay of the org's set reports with `source:
/// "console"` (one entry per hold, each relay's state in `relays`), oldest first; with the relays that did not answer.
pub fn org_holds(desk: &dyn Desk, org: &str) -> (Vec<Value>, Vec<String>) {
    let (theirs, partial) = relay_holds(desk, org, desk.relays(org));
    let mut all: Vec<Value> = records(desk, org)
        .iter()
        .map(|r| {
            let mut h = resource(r);
            h["source"] = json!("api");
            h
        })
        .collect();
    let mut console: BTreeMap<String, Value> = BTreeMap::new();
    for mut h in theirs {
        let id = h["hold"].as_str().unwrap_or_default().to_string();
        match console.get_mut(&id) {
            Some(f) => {
                if let (Some(to), Some(from)) = (f["relays"].as_object_mut(), h["relays"].as_object()) {
                    to.extend(from.clone());
                }
            }
            None => {
                h["source"] = json!("console");
                console.insert(id, h);
            }
        }
    }
    all.extend(console.into_values());
    all.sort_by(|a, b| (a["placed_at"].as_i64().unwrap_or(0), a["hold"].as_str().unwrap_or_default()).cmp(&(b["placed_at"].as_i64().unwrap_or(0), b["hold"].as_str().unwrap_or_default())));
    (all, partial)
}

// ── the console's minute ─────────────────────────────────────────────────────────────────────────────────────────

static TICKING: AtomicBool = AtomicBool::new(false);

/// The fleet's minute: on its own thread (one at a time), `tick_now`.
pub fn tick(desk: Arc<dyn Desk>, now: i64) {
    // revision 4 5.3.3: the desk a tightening uses to cancel open export jobs at once
    crate::api_exports::set_desk(desk.clone());
    if TICKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("api-holds".into()).spawn(move || {
        tick_now(&*desk, now);
        // revision 4 5.3: export jobs followed, expired, canceled when narrowed
        crate::api_exports::tick_now(&*desk, now);
        TICKING.store(false, Ordering::SeqCst);
    });
    if spawned.is_err() {
        TICKING.store(false, Ordering::SeqCst);
    }
}

/// The orgs with hold records.
fn hold_orgs(desk: &dyn Desk) -> Vec<String> {
    match desk.dir() {
        Some(d) => std::fs::read_dir(d.join(HOLDS_DIR)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        None => MEMORY.lock().keys().map(|(o, _)| o.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect(),
    }
}

/// 5.2.3: each open hold goes to the relays that have not acknowledged it (and to relays that joined the org since),
/// its reviewer's ask is made once an archive relay is connected, its archive outcome is followed and audited, and a
/// hold whose relay holds were all released gets `released_at`. Then `lucid_compliance_holds` is published for every
/// org with holds or a pinned map; the console-placed holds of an org with a pinned map are read from its relays again
/// every 15 minutes.
pub fn tick_now(desk: &dyn Desk, now: i64) {
    let pinned: BTreeSet<String> = desk.orgs().into_iter().collect();
    let mut orgs = pinned.clone();
    for org in hold_orgs(desk) {
        for rec in records(desk, &org).into_iter().filter(|r| r.get("released_at").is_none()) {
            tick_record(desk, &org, rec, now);
        }
        orgs.insert(org);
    }
    for org in orgs {
        let due = pinned.contains(&org) && {
            let mut read = CONSOLE_READ.lock();
            let due = read.get(&org).is_none_or(|at| now - at >= CONSOLE_HOLDS_S);
            if due {
                read.insert(org.clone(), now);
            }
            due
        };
        if due {
            // publishes
            relay_holds(desk, &org, desk.relays(&org));
        } else {
            publish_holds(desk, &org);
        }
    }
}

/// The fields of a hold record a tick changes besides `relays`.
const TICK_FIELDS: [&str; 4] = ["archive", "ask", "checked", "released_at"];

/// One hold of the tick. The record is read without the lock (the tick asks relays meanwhile), so a `place` may have
/// saved it again since: under the lock the record is read again and only what the tick changed is applied to it.
fn tick_record(desk: &dyn Desk, org: &str, rec: Value, now: i64) {
    let mut next = rec.clone();
    tick_hold(desk, org, &mut next, now);
    if next == rec {
        return;
    }
    let hold = rec["hold"].as_str().unwrap_or_default();
    let _one = HOLDS_LOCK.lock();
    // withdrawn meanwhile: nothing to keep
    let Some(mut current) = load_one(desk, org, hold) else { return };
    let before = relays_of(&rec);
    for (relay, state) in relays_of(&next).into_iter().filter(|(r, s)| before.get(r) != Some(s)) {
        current["relays"][relay.as_str()] = Value::from(state);
    }
    for k in TICK_FIELDS.into_iter().filter(|k| rec.get(k) != next.get(k)) {
        match (next.get(k), current.as_object_mut()) {
            (Some(v), Some(o)) => o.insert(k.into(), v.clone()),
            (None, Some(o)) => o.remove(k),
            _ => None,
        };
    }
    if let Err(e) = save_record(desk, org, &current) {
        crate::meet::log_error(&format!("api hold org={org} hold={hold} not kept: {e}"));
    }
}

/// One API hold record as it is kept now.
fn load_one(desk: &dyn Desk, org: &str, hold: &str) -> Option<Value> {
    match org_dir(desk, org) {
        Some(dir) => load_record(&dir.join(format!("{hold}.json"))),
        None => MEMORY.lock().get(&(org.to_string(), hold.to_string())).cloned(),
    }
}

fn tick_hold(desk: &dyn Desk, org: &str, rec: &mut Value, now: i64) {
    let (order, archives) = send_order(desk, org);
    let was_placed = relays_of(rec).values().any(|s| s == "placed");
    let wants_ask = |rec: &Value| rec.get("ask").is_none() && rec["archive"] != "none" && rec.get("reviewer").is_some();
    for relay in order.iter().filter(|r| desk.connected(r)) {
        let state = relays_of(rec).get(relay).cloned();
        let ask = wants_ask(rec) && archives.contains(relay);
        let done = match state.as_deref() {
            Some("placed") => !ask,
            Some("off" | "released") => true,
            _ => false,
        };
        if done {
            continue;
        }
        let answer = send(desk, org, rec, relay, ask);
        take_answer(rec, relay, &answer);
    }
    if !was_placed && relays_of(rec).values().any(|s| s == "placed") {
        let count = rec["principals"].as_array().map_or(0, Vec::len);
        desk.emit(org, "hold.placed", json!({ "hold": rec["hold"], "on": "people", "count": count, "by": rec["client"] }), now);
    }
    // the archive outcome
    if rec["archive"] == "waiting" {
        if let Some(ask) = rec.get("ask").cloned() {
            let relay = ask["relay"].as_str().unwrap_or_default();
            if desk.connected(relay) {
                if let Ok(v) = desk.request(relay, "api-hold-status", json!({ "org": org, "hold": rec["hold"] }), READ_MS) {
                    if let Some(a) = v.get("archive").and_then(Value::as_str).filter(|a| ["placed", "declined", "failed"].contains(a)) {
                        let mut e = json!({ "action": "compliance.hold.archive", "result": a, "hold": rec["hold"] });
                        if let Some(r) = rec.get("reviewer").filter(|r| r.is_string()) {
                            e["reviewer"] = r.clone();
                        }
                        if desk.record(org, e, now).is_ok() {
                            rec["archive"] = Value::from(a);
                        }
                    }
                }
            }
        }
    }
    // hourly: released everywhere?
    let states = relays_of(rec);
    let settled = !states.is_empty() && states.values().all(|s| s == "placed" || s == "off" || s == "released");
    if settled && now - rec.get("checked").and_then(Value::as_i64).unwrap_or(0) >= RELEASE_CHECK_S {
        rec["checked"] = Value::from(now);
        for relay in states.iter().filter(|(r, s)| *s == "placed" && desk.connected(r)).map(|(r, _)| r.clone()) {
            if let Ok(v) = desk.request(&relay, "api-hold-status", json!({ "org": org, "hold": rec["hold"] }), READ_MS) {
                if v.get("relay").and_then(Value::as_str) == Some("released") {
                    rec["relays"][relay.as_str()] = json!("released");
                }
            }
        }
        let states = relays_of(rec);
        if states.values().any(|s| s == "released") && states.values().all(|s| s == "released" || s == "off") {
            rec["released_at"] = Value::from(now);
            let count = rec["principals"].as_array().map_or(0, Vec::len);
            desk.emit(org, "hold.released", json!({ "hold": rec["hold"], "on": "people", "count": count, "by": rec["client"] }), now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;

    const ORG: &str = "acme";
    const NOW: i64 = 1_795_700_000;
    const KEY: &str = "\"AbCdEfGh12345678\"";
    const R1: &str = "r_00000000000000a1";
    const R2: &str = "r_00000000000000b2";
    const CLIENT: &str = "c_0a1b2c3d4e5f6071";

    type Answerer = Box<dyn Fn(&str, &str, &Value) -> Result<Value, LinkError> + Send + Sync>;

    struct Mock {
        org_dir: PathBuf,
        relays: Vec<String>,
        archives: Vec<String>,
        up: Mutex<HashMap<String, bool>>,
        answer: Answerer,
        sent: Mutex<Vec<(String, String, Value)>>,
        audit: Mutex<Vec<Value>>,
        events: Mutex<Vec<(String, Value)>>,
        idem: IdemStore,
        cap: i64,
    }

    impl Desk for Mock {
        fn relays(&self, _: &str) -> Vec<String> {
            self.relays.clone()
        }
        fn connected(&self, relay: &str) -> bool {
            self.up.lock().get(relay).copied().unwrap_or(false)
        }
        fn request(&self, relay: &str, op: &str, body: Value, _: u64) -> Result<Value, LinkError> {
            self.sent.lock().push((relay.into(), op.into(), body.clone()));
            (self.answer)(relay, op, &body)
        }
        fn archive_relays(&self, _: &str) -> Vec<String> {
            self.archives.clone()
        }
        fn gate(&self, _: &str, _: &[&str]) -> Result<(), ApiMapError> {
            Ok(())
        }
        fn caps(&self, _: &str, _: &str) -> BTreeMap<String, i64> {
            BTreeMap::from([("holds_per_day".to_string(), self.cap)])
        }
        fn idempotency(&self) -> &IdemStore {
            &self.idem
        }
        fn dir(&self) -> Option<PathBuf> {
            Some(self.org_dir.clone())
        }
        fn record(&self, _: &str, entry: Value, _: i64) -> Result<(), String> {
            self.audit.lock().push(entry);
            Ok(())
        }
        fn emit(&self, _: &str, kind: &str, data: Value, _: i64) {
            self.events.lock().push((kind.into(), data));
        }
    }

    fn mock(name: &str, answer: Answerer) -> Mock {
        let dir = std::env::temp_dir().join(format!("lucid-api-compliance-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Mock {
            org_dir: dir,
            relays: vec![R1.into(), R2.into()],
            archives: vec![R2.into()],
            up: Mutex::new(HashMap::from([(R1.to_string(), true), (R2.to_string(), true)])),
            answer,
            sent: Mutex::default(),
            audit: Mutex::default(),
            events: Mutex::default(),
            idem: IdemStore::load(None),
            cap: 20,
        }
    }

    fn placing() -> Answerer {
        Box::new(|relay, op, body| match op {
            "api-hold" => {
                let mut v = json!({ "relay_hold": format!("{relay}-1"), "archive": "waiting" });
                if body["ask_reviewer"] == true {
                    v["request"] = json!("rq_0123456789abcdef");
                }
                Ok(v)
            }
            "api-hold-status" => Ok(json!({ "relay": "placed", "archive": "placed" })),
            _ => Err(LinkError::Refused { status: 400, code: "fleet-op".into(), error: "".into() }),
        })
    }

    fn entry() -> Map<String, Value> {
        json!({"id": CLIENT, "name": "ediscovery-meta", "principal": "ediscovery-meta@apps.acme.example", "owner": "lee@acme.example"}).as_object().unwrap().clone()
    }

    fn post(desk: &dyn Desk, json: Value, key: Option<&str>) -> Result<Answer, Refused> {
        let e = entry();
        let body = Body { json: Ok(json), key: key.map(str::to_string) };
        let req = Req { org: ORG, route: RouteId::ComplianceHoldPlace, route_name: "POST /api/orgs/acme/v1/compliance/holds", id: None, n: None, query: "", client: CLIENT,
                        reach: &["*".to_string()], entry: Some(&e), body: Some(&body), rid: "rid", now: NOW };
        serve(desk, &req)
    }

    fn get(desk: &dyn Desk, route: RouteId, id: Option<&str>, query: &str) -> Result<Answer, Refused> {
        let e = entry();
        let req = Req { org: ORG, route, route_name: "GET", id, n: None, query, client: CLIENT, reach: &["*".to_string()], entry: Some(&e), body: None, rid: "rid", now: NOW };
        serve(desk, &req)
    }

    fn hold_body() -> Value {
        json!({"on": "people", "principals": ["ann@acme.example", "Bo@acme.example"], "reason": "Matter 2026-114: preservation notice", "matter": "2026-114", "reviewer": "rita@acme.example"})
    }

    #[test]
    fn a_hold_is_audited_kept_placed_at_once_and_asked_on_the_archive_relay() {
        let m = mock("place", placing());
        let a = post(&m, hold_body(), Some(KEY)).unwrap();
        assert_eq!(a.status, 202, "{}", a.body);
        assert_eq!(a.body["state"], json!({"relay": "placed", "archive": "waiting"}));
        assert_eq!(a.body["relays"], json!({R1: "placed", R2: "placed"}));
        let sent = m.sent.lock().clone();
        assert_eq!((sent[0].0.as_str(), sent[0].2["ask_reviewer"].clone()), (R2, json!(true)), "the archive relay first, asked to make the ask");
        assert_eq!(sent[1].2["ask_reviewer"], json!(false));
        assert_eq!(sent[0].2["hold"]["principals"], json!(["ann@acme.example", "bo@acme.example"]));
        let audit = m.audit.lock().clone();
        assert_eq!((audit[0]["action"].as_str(), audit[0]["matter"].as_str(), audit[0]["owner"].as_str()), (Some("compliance.hold.requested"), Some("2026-114"), Some("lee@acme.example")));
        assert_eq!(m.events.lock()[0].0, "hold.placed");
        // the same key and body: the same hold again, nothing sent
        let n = m.sent.lock().len();
        let again = post(&m, hold_body(), Some(KEY)).unwrap();
        assert!(again.replayed && again.body["hold"] == a.body["hold"]);
        assert_eq!(m.sent.lock().len(), n);
        assert_eq!(post(&m, json!({"on": "people", "principals": ["x@acme.example"], "reason": "other"}), Some(KEY)).err().unwrap().code, "idempotency-mismatch");
        // listed and readable
        let one = get(&m, RouteId::ComplianceHold, a.body["hold"].as_str(), "").unwrap();
        assert_eq!((one.body["count"].clone(), one.body["by"].clone()), (json!(2), json!({"client": CLIENT, "owner": "lee@acme.example"})));
        assert!(one.body.get("released_at").is_none());
        // the tick follows the archive outcome
        tick_now(&m, NOW + 60);
        let one = get(&m, RouteId::ComplianceHold, a.body["hold"].as_str(), "").unwrap();
        assert_eq!(one.body["archive"], "placed");
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.hold.archive" && e["result"] == "placed" && e["reviewer"] == "rita@acme.example"));
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    #[test]
    fn requests_are_checked_before_anything_is_kept() {
        let m = mock("checks", placing());
        assert_eq!(post(&m, hold_body(), None).err().unwrap().code, "idempotency-key");
        for (k, v) in [("on", json!("conversations")), ("principals", json!([])), ("principals", json!(["a@acme.example", "a@acme.example"])), ("reason", json!("")), ("matter", json!("x".repeat(129))), ("extra", json!(1))] {
            let mut b = hold_body();
            b[k] = v;
            assert_eq!(post(&m, b, Some(&format!("\"key-{k}-1234567890\""))).err().unwrap().code, "bad-request", "{k}");
        }
        let mut owner = hold_body();
        owner["reviewer"] = json!("lee@acme.example");
        assert_eq!(post(&m, owner, Some("\"owner-key-1234567\"")).err().unwrap().code, "reviewers");
        assert!(m.sent.lock().is_empty() && m.audit.lock().is_empty());
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    #[test]
    fn a_principal_of_another_org_withdraws_the_request() {
        let m = mock("covered", Box::new(|_, _, _| Err(LinkError::Refused { status: 403, code: "not-covered".into(), error: "no".into() })));
        let r = post(&m, hold_body(), Some(KEY)).err().unwrap();
        assert_eq!((r.status, r.code), (403, "not-covered"));
        assert!(records(&m, ORG).is_empty(), "the record is gone");
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    #[test]
    fn holds_off_everywhere_is_refused_and_quota_counts_the_day() {
        let off = mock("off", Box::new(|_, _, _| Err(LinkError::Refused { status: 409, code: "holds-off".into(), error: "off".into() })));
        assert_eq!(post(&off, hold_body(), Some(KEY)).err().unwrap().code, "holds-off");
        let _ = std::fs::remove_dir_all(&off.org_dir);
        let mut q = mock("quota", placing());
        q.cap = 1;
        assert_eq!(post(&q, hold_body(), Some(KEY)).unwrap().status, 202);
        let r = post(&q, hold_body(), Some("\"second-key-1234567\"")).err().unwrap();
        assert_eq!((r.status, r.code, r.retry), (429, "quota", Some(NOW - NOW.rem_euclid(DAY) + DAY - NOW)));
        let _ = std::fs::remove_dir_all(&q.org_dir);
    }

    #[test]
    fn a_relay_offline_at_request_time_gets_the_hold_after_it_connects() {
        let m = mock("offline", placing());
        m.up.lock().insert(R1.into(), false);
        let a = post(&m, hold_body(), Some(KEY)).unwrap();
        assert_eq!(a.body["relays"], json!({R1: "pending", R2: "placed"}));
        m.up.lock().insert(R1.into(), true);
        tick_now(&m, NOW + 60);
        let one = get(&m, RouteId::ComplianceHold, a.body["hold"].as_str(), "").unwrap();
        assert_eq!(one.body["relays"], json!({R1: "placed", R2: "placed"}));
        // no relay connected: 503, nothing kept
        m.up.lock().clear();
        assert_eq!(post(&m, hold_body(), Some("\"third-key-12345678\"")).err().unwrap().code, "relay-unreachable");
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    #[test]
    fn reads_merge_relays_mark_partial_and_resume_with_the_cursor() {
        let m = mock("reads", Box::new(|relay, op, body| {
            assert_eq!(op, "api-compliance-read");
            let after = body["after"].as_str();
            Ok(match (relay, after) {
                (R1, None) => json!({"items": [{"session": "s1"}, {"session": "s2"}], "next": "2:s2", "kept_days": 30}),
                (R1, Some("2:s2")) => json!({"items": [{"session": "s3"}], "kept_days": 30}),
                _ => json!({"items": [{"session": "b1"}], "kept_days": 7}),
            })
        }));
        m.up.lock().insert(R2.into(), false);
        let page = get(&m, RouteId::ComplianceAttendance, None, "person=ann%40acme.example&limit=2").unwrap().body;
        assert_eq!(page["items"], json!([{"relay": R1, "session": "s1"}, {"relay": R1, "session": "s2"}]));
        assert_eq!(page["kept_days"], json!({R1: 30}));
        let sent = m.sent.lock()[0].2.clone();
        assert_eq!((sent["params"]["person"].as_str(), sent["params"]["limit"].as_i64()), (Some("ann@acme.example"), Some(2)));
        m.up.lock().insert(R2.into(), true);
        let next = page["next"].as_str().unwrap();
        let page2 = get(&m, RouteId::ComplianceAttendance, None, &format!("person=ann%40acme.example&after={next}")).unwrap().body;
        assert_eq!(page2["items"], json!([{"relay": R1, "session": "s3"}, {"relay": R2, "session": "b1"}]));
        assert!(page2.get("next").is_none() && page2.get("partial").is_none());
        // a cursor of other filters is refused; files need one place
        assert_eq!(get(&m, RouteId::ComplianceAttendance, None, &format!("person=bo%40acme.example&after={next}")).err().unwrap().code, "bad-request");
        assert_eq!(get(&m, RouteId::ComplianceFiles, None, "cid=ch:1&room=x").err().unwrap().code, "bad-request");
        assert_eq!(get(&m, RouteId::ComplianceConversations, None, "").err().unwrap().code, "bad-request");
        assert_eq!(get(&m, RouteId::ComplianceMeetings, None, "from=0&to=99999999").err().unwrap().code, "bad-request");
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    /// The hold is placed but its record cannot be kept: 503, and the key stays running, also after a restart, so a
    /// retry never places a second hold.
    #[test]
    fn a_hold_that_cannot_be_kept_keeps_its_key_running() {
        let holds = std::env::temp_dir().join(format!("lucid-api-compliance-holdsave-{}", std::process::id())).join(HOLDS_DIR).join(ORG);
        let mut m = mock("holdsave", Box::new(move |relay, op, body| {
            if op == "api-hold" {
                // the seam: the next write of this hold record fails (its temporary file is a folder)
                let hold = body["hold"]["hold"].as_str().unwrap_or_default();
                let _ = std::fs::create_dir_all(holds.join(format!("{hold}.json.tmp-{}", std::process::id())));
            }
            placing()(relay, op, body)
        }));
        let r = post(&m, hold_body(), Some(KEY)).err().unwrap();
        assert_eq!((r.status, r.code), (503, "unavailable"));
        let n = m.sent.lock().len();
        assert_eq!(post(&m, hold_body(), Some(KEY)).err().unwrap().code, "idempotency-busy");
        m.idem = IdemStore::load(None);
        assert_eq!(post(&m, hold_body(), Some(KEY)).err().unwrap().code, "idempotency-busy", "the hold record keeps the key after a restart");
        assert_eq!(post(&m, json!({"on": "people", "principals": ["x@acme.example"], "reason": "other"}), Some(KEY)).err().unwrap().code, "idempotency-mismatch");
        assert_eq!(m.sent.lock().len(), n, "nothing sent again");
        assert_eq!(records(&m, ORG).len(), 1, "one hold");
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    /// The key store cannot keep the answer: 503, and the answer kept with the hold record is replayed after a restart.
    #[test]
    fn a_hold_answer_the_key_store_cannot_keep_is_replayed_from_the_hold() {
        let mut m = mock("keysave", placing());
        let bad = m.org_dir.join("idem-bad");
        std::fs::create_dir_all(&bad).unwrap();
        // the seam: the answers folder is a file, so the key store's write fails
        std::fs::write(bad.join(idem::DIR), b"not a folder").unwrap();
        m.idem = IdemStore::load(Some(&bad));
        let r = post(&m, hold_body(), Some(KEY)).err().unwrap();
        assert_eq!((r.status, r.code), (503, "unavailable"));
        let n = m.sent.lock().len();
        assert_eq!(post(&m, hold_body(), Some(KEY)).err().unwrap().code, "idempotency-busy", "no second hold in this process");
        m.idem = IdemStore::load(None);
        let again = post(&m, hold_body(), Some(KEY)).unwrap();
        let kept = records(&m, ORG);
        assert!(again.replayed && again.status == 202);
        assert_eq!((kept.len(), &again.body["hold"]), (1, &kept[0]["hold"]));
        assert_eq!(again.body["relays"], json!({R1: "placed", R2: "placed"}));
        assert!(post(&m, hold_body(), Some(KEY)).unwrap().replayed);
        assert_eq!(m.sent.lock().len(), n, "nothing sent again");
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    /// A tick that read the record between `place`'s two saves and saves after it keeps the answer `place` saved, and
    /// applies only what the tick changed.
    #[test]
    fn a_tick_between_the_two_saves_of_a_hold_keeps_its_answer() {
        let holds = std::env::temp_dir().join(format!("lucid-api-compliance-tickrace-{}", std::process::id())).join(HOLDS_DIR).join(ORG);
        let seen: std::sync::Arc<Mutex<Option<Value>>> = Default::default();
        let snap = seen.clone();
        let mut m = mock("tickrace", Box::new(move |relay, op, body| {
            if op == "api-hold" && snap.lock().is_none() {
                // what a tick reads while the relays are asked: the record of the first save
                let hold = body["hold"]["hold"].as_str().unwrap_or_default();
                *snap.lock() = load_record(&holds.join(format!("{hold}.json")));
            }
            placing()(relay, op, body)
        }));
        let a = post(&m, hold_body(), Some(KEY)).unwrap();
        let stale = seen.lock().clone().unwrap();
        assert!(stale["idem"].get("status").is_none(), "read between the saves");
        tick_record(&m, ORG, stale, NOW + 60);
        let kept = records(&m, ORG);
        assert_eq!((kept.len(), &kept[0]["idem"]["body"]), (1, &a.body));
        assert_eq!(kept[0]["relays"], json!({R1: "placed", R2: "placed"}));
        // a restart: the answer kept with the hold is replayed
        m.idem = IdemStore::load(None);
        let again = post(&m, hold_body(), Some(KEY)).unwrap();
        assert!(again.replayed && again.body == a.body);
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    #[test]
    fn helpers() {
        assert_eq!(pct("ann%40acme.example").as_deref(), Some("ann@acme.example"));
        assert_eq!(pct("a+b%2Bc").as_deref(), Some("a+b+c"));
        assert!(pct("%4").is_none() && pct("%zz").is_none());
        assert!(hold_id_ok("h_9f8e7d6c5b4a3921") && !hold_id_ok("h_9F8E7D6C5B4A3921"));
        assert!(principal_ok("ann@acme.example") && !principal_ok("ann") && !principal_ok("a b@x") && !principal_ok("a@b@c"));
        let c = Cursor { kind: "files".into(), from: 1, to: 2, filters: "x".into(), pending: BTreeMap::from([(R1.to_string(), None), (R2.to_string(), Some("3:f".to_string()))]) };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
    }

    /// Revision 4 13.2: the console's Compliance page lists the API holds and the console-placed ones every relay of
    /// the org's set reports (not a client's grant), each with its source, oldest first.
    #[test]
    fn the_console_list_merges_api_and_relay_holds_with_their_source() {
        const R3: &str = "r_00000000000000c3";
        let mut m = mock("console-list", Box::new(|relay, op, body| match op {
            "api-hold" => {
                let mut v = json!({ "relay_hold": format!("{relay}-1"), "archive": "waiting" });
                if body["ask_reviewer"] == true {
                    v["request"] = json!("rq_0123456789abcdef");
                }
                Ok(v)
            }
            "api-compliance-read" if body["kind"] == "holds" => {
                let mut h = json!({ "hold": "00112233445566ff", "on": "people", "count": 1, "placed_at": NOW - 500, "by": { "admin": "ann@acme.example" } });
                if relay == R2 {
                    h["released_at"] = json!(NOW - 100);
                }
                Ok(json!({ "items": [h], "next": null }))
            }
            _ => Err(LinkError::Refused { status: 400, code: "fleet-op".into(), error: "".into() }),
        }));
        // a third relay of the set that is not connected
        m.relays.push(R3.into());
        let a = post(&m, hold_body(), Some(KEY)).unwrap();
        let (holds, partial) = org_holds(&m, ORG);
        assert_eq!(partial, vec![R3.to_string()]);
        assert_eq!(holds.len(), 2, "one entry per console hold: {holds:?}");
        assert_eq!((holds[0]["source"].as_str(), holds[0]["hold"].as_str()), (Some("console"), Some("00112233445566ff")), "oldest first");
        assert_eq!(holds[0]["relays"], json!({ R1: "placed", R2: "released" }));
        assert_eq!((holds[1]["source"].as_str(), holds[1]["hold"].clone()), (Some("api"), a.body["hold"].clone()));
        assert_eq!(holds[1]["by"], json!({ "client": CLIENT, "owner": "lee@acme.example" }));
        // every relay of the set is asked, whatever a client's grant reaches
        let asked: Vec<String> = m.sent.lock().iter().filter(|(_, op, _)| op == "api-compliance-read").map(|(r, _, _)| r.clone()).collect();
        assert_eq!(asked, vec![R1.to_string(), R2.to_string()]);
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }

    fn gauge(org: &str, prom: &str, labels: &[(&str, &str)]) -> Option<f64> {
        crate::api_catalog::counters::rows(Some(org), NOW)
            .into_iter()
            .find(|r| r.prom == prom && r.labels.iter().map(|(k, v)| (k.as_str(), v.as_str())).eq(labels.iter().copied()))
            .map(|r| r.value)
    }

    /// Revision 4 12: `lucid_compliance_holds` moves when an API hold is placed, when its archive outcome arrives and
    /// when the relays report console-placed holds (each hold once, released ones not).
    #[test]
    fn the_holds_gauge_follows_placing_the_archive_and_console_holds() {
        const ORG2: &str = "metrics-holds";
        let m = mock("metrics", Box::new(|relay, op, body| match op {
            "api-compliance-read" if body["kind"] == "holds" => Ok(json!({ "items": [
                { "hold": "00112233445566aa", "on": "people", "count": 1, "placed_at": NOW - 500, "by": { "admin": "ann@acme.example" } },
                { "hold": "00112233445566bb", "on": "people", "count": 1, "placed_at": NOW - 400, "by": { "admin": "ann@acme.example" }, "released_at": NOW - 100 },
            ], "next": null })),
            _ => (placing())(relay, op, body),
        }));
        let holds = |state: &str| gauge(ORG2, "lucid_compliance_holds", &[("state", state)]);
        let e = entry();
        let body = Body { json: Ok(hold_body()), key: Some(KEY.to_string()) };
        let req = Req { org: ORG2, route: RouteId::ComplianceHoldPlace, route_name: "POST", id: None, n: None, query: "", client: CLIENT,
                        reach: &["*".to_string()], entry: Some(&e), body: Some(&body), rid: "rid", now: NOW };
        assert_eq!(serve(&m, &req).unwrap().status, 202);
        assert_eq!((holds("placed"), holds("waiting_archive")), (Some(1.0), Some(1.0)));
        // the archive reviewer decided
        tick_now(&m, NOW + 60);
        assert_eq!((holds("placed"), holds("waiting_archive")), (Some(1.0), Some(0.0)));
        // both relays report the same console hold active, and one released: it counts once
        let _ = org_holds(&m, ORG2);
        assert_eq!((holds("placed"), holds("waiting_archive")), (Some(2.0), Some(0.0)));
        let _ = std::fs::remove_dir_all(&m.org_dir);
    }
}
