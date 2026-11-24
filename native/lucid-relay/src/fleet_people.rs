// People across the fleet (contract AC-2a section 11, F11): one People page gathered from the console's own book and
// every relay that granted the `people` scope, the in-memory cache that follows authorization (A1-M5), the 11.2
// actions mapped onto `call` and `people` frames, the CSV check and import with its session-bound `importId` store
// (A1-L2), reminders through `console_mail`, and the High non-dumpable setting (11.1) the console role calls at start
// through F7.
//
// Nothing about relay people is written to disk here: rows, the CSV check's state and the reminder clock live in memory
// only. The console's side (registry, channel, step-up verification, its own book) is reached through `PeopleHost`,
// which f-console implements over `fleet_wire` (F3) and the registry (F15).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tokio::sync::{OnceCell, Semaphore};

use crate::codec::{b64u, hex, safe_int, sha256, str_of, unb64u};
use crate::console::ApiError;

// ── Limits (11.1, 11.3) ──────────────────────────────────────────────────────────────────────────────────────────

/// Relays fetched at once, in all.
pub const FETCH_AT_ONCE: usize = 8;
/// One relay's fetch (both reads) gives up after this.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// A cached relay's rows are served for at most this long.
pub const CACHE_MS: i64 = 5 * 60 * 1000;
/// The cache's rows in all.
pub const CACHE_ROWS: usize = 200_000;
/// The cache's bytes in all.
pub const CACHE_BYTES: usize = 64 * 1024 * 1024;
/// Rows a relay is asked for in one read (the AC-1 list maximum).
pub const RELAY_READ_LIMIT: usize = 500;
/// The People list's page.
pub const LIST_DEFAULT: usize = 100;
pub const LIST_MAX: usize = 500;

/// CSV rows (after the header) and decoded bytes.
pub const CSV_ROWS: usize = 500;
pub const CSV_BYTES: usize = 256 * 1024;
/// `people/import/check`'s own `body_max` (the encoded request).
pub const CHECK_BODY_MAX: usize = 1024 * 1024;
/// A check's state lives this long.
pub const IMPORT_MS: i64 = 10 * 60 * 1000;
pub const IMPORTS_ALL: usize = 20;
pub const IMPORTS_PER_SESSION: usize = 2;
pub const IMPORT_BYTES: usize = 8 * 1024 * 1024;
/// The relay's waiting request cap (AC-1 3.8).
pub const WAITING_CAP: u64 = 200;
/// One reminder per request per this long.
pub const REMIND_MS: i64 = 24 * 60 * 60 * 1000;
pub const HOURS_MAX: i64 = 720;
pub const REASON_MAX: usize = 500;
pub const NAME_MAX: usize = 80;
pub const DAYS_DEFAULT: i64 = 7;

/// The CSV header names (any order, exactly these).
pub const CSV_COLUMNS: [&str; 6] = ["email", "name", "product", "role", "relay", "days"];
/// The row problems of 11.3, in the order a row is judged (`csv-invalid` marks a row whose name, product or days
/// cannot be used).
#[cfg(test)]
pub const ROW_PROBLEMS: [&str; 8] = ["csv-invalid", "csv-email", "csv-role", "csv-relay", "scope", "exists", "license-inactive", "request-limit"];

// ── Words (13.1, 13.3, 13.5) ─────────────────────────────────────────────────────────────────────────────────────

pub const CSV_INVALID: &str = "That file is not a CSV with the columns email, name, product, role, relay and days.";
pub const CSV_LIMIT: &str = "A CSV can have at most 500 rows and 256 KiB.";
pub const CSV_CHANGED: &str = "The list changed since it was checked. Check it again.";
pub const REQUEST_LIMIT: &str = "That relay already has 200 waiting requests.";
pub const FLEET_SECOND: &str = "This change needs a second admin. Ask another admin to approve it in the Admin Console.";
pub const MAIL_INVITE_WAITING: &str = "mail.fleet-invite-waiting";

fn refuse(status: u16, code: &'static str, words: &str) -> ApiError {
    ApiError { status, code, message: words.to_owned(), retry_after: None }
}

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

// ── The host: what the console gives this module (F11 seam) ─────────────────────────────────────────────────────

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Product {
    Meet,
    Spokes,
}

impl Product {
    pub fn as_str(self) -> &'static str {
        match self {
            Product::Meet => "meet",
            Product::Spokes => "spokes",
        }
    }
}

/// A session's rights as AC-1 computes them at this request (2.3).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Rights {
    None,
    Viewer,
    Manager,
    Admin,
}

/// Who asks: the session (its id hash or any stable id the console keys sessions by), the person, and the rights
/// this request computed.
#[derive(Clone, Debug)]
pub struct Asker {
    pub session: String,
    pub email: String,
    pub rights: Rights,
}

/// One relay as the registry (F15) and its last `state` event (5.6) give it.
#[derive(Clone, Debug)]
pub struct RelayView {
    pub id: String,
    pub name: String,
    pub product: Product,
    /// The registry state (`active`, `removed`, ...); a change wipes the relay's cached rows.
    pub state: String,
    pub profile: String,
    pub scope_generation: u64,
    pub scopes: Vec<String>,
    /// The license view's `service.state` is `stopped` (AC-1 R42-1, AC-2a 3.4): invites and CSV rows are refused with
    /// `license-inactive`.
    pub service_stopped: bool,
    /// Waiting requests on the relay, as last reported.
    pub waiting_requests: u64,
    /// Meeting Hub `relay.json` `admins` (principals, lower case); empty for Remote Spokes.
    pub admins: Vec<String>,
    /// The relay's policy record says two-person on (4.5).
    pub two_person: bool,
    /// The channel is up.
    pub connected: bool,
}

impl RelayView {
    pub fn grants(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }

    fn key(&self) -> Key {
        Key { generation: self.scope_generation, state: self.state.clone(), profile: self.profile.clone() }
    }
}

/// The console side. f-console implements it over the registry, the channel and the console's book.
pub trait PeopleHost: Send + Sync {
    /// Every registered relay, read now.
    fn relays(&self) -> Vec<RelayView>;
    /// The rights `session` holds now (AC-1 recomputes them at every request); None when the session is gone.
    fn rights_now(&self, session: &str) -> Option<Rights>;
    /// A `call` frame (5.6) to `relay`: `body` is `{method, path, query, body, caller, auth}`; the answer is the
    /// frame's `{status, body}`. Err when the relay is not connected or the channel failed.
    fn call<'a>(&'a self, relay: &'a str, body: Value) -> BoxFut<'a, Result<Value, ApiError>>;
    /// A `people` frame (5.6) to `relay`; the answer is `{results: [{target, ok, code}]}`.
    fn people_op<'a>(&'a self, relay: &'a str, body: Value) -> BoxFut<'a, Result<Value, ApiError>>;
    /// The console's own accounts as 11.1 rows (`kind: "console"`).
    fn console_rows(&self) -> Vec<Value>;
    /// True when `email` already has a console account or a live invite.
    fn console_exists(&self, email: &str) -> bool;
    /// AC-1 `admins/invite` for one CSV row (the console's step-up already verified by the route).
    fn console_invite(&self, asker: &Asker, email: &str, role: &str, t: i64) -> Result<(), ApiError>;
    /// The emails of the console's active accounts (a relay admin is mailed only when one of these).
    fn console_emails(&self) -> HashSet<String>;
    /// Mail is on (AC-1 `mail-off` otherwise).
    fn mail_on(&self) -> bool;
    /// Queue one mail (13.5) through `console_mail` (I12).
    fn mail(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        crate::console_mail::send(kind, to, args);
    }
    /// API-1 revision 4 6.7: the console's `api-people` record for (`org`, `principal`) says `deprovisioned`.
    fn api_deprovisioned(&self, _org: &str, _principal: &str) -> bool {
        false
    }
}

// ── The cache (11.1, A1-M5) ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct Key {
    generation: u64,
    state: String,
    profile: String,
}

/// A device (Meeting Hub) or hub (Remote Spokes) of one person on one relay, for the actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub serial: String,
    pub blocked: bool,
    pub revoked: bool,
}

/// One relay's answer, as cached.
#[derive(Debug)]
pub struct Fetched {
    pub relay: String,
    pub rows: Vec<Value>,
    /// The Seats strip source (11.4): the relay's seats answer.
    pub seats: Value,
    /// Person id to devices or hubs.
    pub items: HashMap<String, Vec<Item>>,
    pub as_of: i64,
    pub bytes: usize,
}

struct Entry {
    key: Key,
    data: Arc<Fetched>,
    at: i64,
    used: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, Entry>,
    tick: u64,
    rows: usize,
    bytes: usize,
}

impl Cache {
    fn remove(&mut self, relay: &str) {
        if let Some(e) = self.entries.remove(relay) {
            self.rows -= e.data.rows.len();
            self.bytes -= e.data.bytes;
        }
    }

    fn get(&mut self, relay: &str, key: &Key, now: i64) -> Option<Arc<Fetched>> {
        let fresh = self.entries.get(relay).map(|e| e.key == *key && now - e.at < CACHE_MS && now >= e.at);
        match fresh {
            Some(true) => {
                self.tick += 1;
                let tick = self.tick;
                let e = self.entries.get_mut(relay)?;
                e.used = tick;
                Some(e.data.clone())
            }
            Some(false) => {
                self.remove(relay);
                None
            }
            None => None,
        }
    }

    fn put(&mut self, key: Key, data: Arc<Fetched>, now: i64) {
        self.remove(&data.relay);
        if data.rows.len() > CACHE_ROWS || data.bytes > CACHE_BYTES {
            return;
        }
        self.tick += 1;
        self.rows += data.rows.len();
        self.bytes += data.bytes;
        let relay = data.relay.clone();
        self.entries.insert(relay.clone(), Entry { key, data, at: now, used: self.tick });
        while self.rows > CACHE_ROWS || self.bytes > CACHE_BYTES {
            let oldest = self.entries.iter().filter(|(id, _)| **id != relay).min_by_key(|(_, e)| e.used).map(|(id, _)| id.clone());
            match oldest {
                Some(id) => self.remove(&id),
                None => break,
            }
        }
    }

    /// Wipe every relay that left, was removed, narrowed or lost `people`, or changed state, profile or generation.
    fn observe(&mut self, views: &[RelayView]) {
        let stale: Vec<String> = self
            .entries
            .iter()
            .filter(|(id, e)| !views.iter().any(|v| v.id == **id && v.grants("people") && v.key() == e.key))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            self.remove(&id);
        }
    }
}

type Shared = Arc<OnceCell<Result<Arc<Fetched>, String>>>;

/// A stored CSV check (11.3, A1-L2): memory only, never the raw CSV.
struct Check {
    id: String,
    session: String,
    rights: Rights,
    digest: String,
    relays: Vec<String>,
    rows: Vec<Value>,
    expires: i64,
    bytes: usize,
    made: u64,
}

#[derive(Default)]
struct Imports {
    list: Vec<Check>,
    tick: u64,
}

impl Imports {
    fn bytes(&self) -> usize {
        self.list.iter().map(|c| c.bytes).sum()
    }

    fn keep(&mut self, mut c: Check, now: i64) {
        self.list.retain(|x| x.expires > now);
        self.tick += 1;
        c.made = self.tick;
        // 2 per session: a new one replaces the session's oldest
        while self.list.iter().filter(|x| x.session == c.session).count() >= IMPORTS_PER_SESSION {
            let oldest = self.list.iter().enumerate().filter(|(_, x)| x.session == c.session).min_by_key(|(_, x)| x.made).map(|(i, _)| i);
            if let Some(i) = oldest {
                self.list.remove(i);
            }
        }
        while !self.list.is_empty() && (self.list.len() >= IMPORTS_ALL || self.bytes() + c.bytes > IMPORT_BYTES) {
            let oldest = self.list.iter().enumerate().min_by_key(|(_, x)| x.made).map(|(i, _)| i).unwrap_or(0);
            self.list.remove(oldest);
        }
        self.list.push(c);
    }

    /// The check, consumed whatever comes next; None for unknown, expired, consumed or foreign ids, or another digest.
    fn take(&mut self, id: &str, session: &str, digest: &str, now: i64) -> Option<Check> {
        let i = self.list.iter().position(|c| c.id == id)?;
        let c = self.list.remove(i);
        (c.session == session && now < c.expires && c.digest == digest).then_some(c)
    }
}

/// The fleet People section.
pub struct People {
    host: Arc<dyn PeopleHost>,
    cache: Mutex<Cache>,
    inflight: Mutex<HashMap<(String, Key), Shared>>,
    permits: Arc<Semaphore>,
    imports: Mutex<Imports>,
    reminded: Mutex<HashMap<(String, String), i64>>,
}

// ── Rows (11.1) ──────────────────────────────────────────────────────────────────────────────────────────────────

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn rows_of<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a Value> {
    v.get(k).and_then(Value::as_array).into_iter().flatten()
}

/// One Meeting Hub relay's rows from its `meet/people` and `meet/seats` answers (AC-1 4.9 shapes).
pub fn meet_rows(view: &RelayView, people: &Value, seats: Value, as_of: i64) -> Fetched {
    let mut rows = Vec::new();
    let mut items = HashMap::new();
    for p in rows_of(people, "people") {
        let principal = s(p, "principal");
        if principal.is_empty() {
            continue;
        }
        let devices: Vec<Item> = rows_of(p, "devices")
            .map(|d| Item {
                id: s(d, "device"),
                serial: s(d, "serial"),
                blocked: d.get("blocked").is_some_and(|b| !b.is_null()),
                revoked: d.get("revoked").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect();
        let live: Vec<&Item> = devices.iter().filter(|d| !d.revoked).collect();
        let blocked = !live.is_empty() && live.iter().all(|d| d.blocked);
        let seated = p.get("seated").and_then(Value::as_bool).unwrap_or(false);
        let base = s(p, "state");
        let state = if blocked {
            "blocked".to_owned()
        } else if !seated && base != "waiting" {
            "unseated".to_owned()
        } else {
            base.clone()
        };
        let role = if view.admins.contains(&principal) { "relay-admin" } else { "member" };
        rows.push(json!({
            "kind": "meet", "relay": view.id, "id": principal, "name": p.get("name").cloned().unwrap_or(Value::Null),
            "org": p.get("org").cloned().unwrap_or(Value::Null), "role": role, "state": state,
            "source": if base == "waiting" { "request" } else { "app" }, "devices": devices.len(), "seated": seated, "asOf": as_of,
        }));
        items.insert(principal, devices);
    }
    finish(view, rows, seats, items, as_of)
}

/// One Remote Spokes relay's rows from its `spokes/seats` and `spokes/nodes` answers (one row per hub user).
pub fn spokes_rows(view: &RelayView, nodes: &Value, seats: Value, as_of: i64) -> Fetched {
    let seated: HashSet<String> = rows_of(&seats, "seats").map(|x| s(x, "email").to_lowercase()).filter(|e| !e.is_empty()).collect();
    let mut by_email: indexmap::IndexMap<String, (Vec<Item>, Vec<String>)> = indexmap::IndexMap::new();
    for n in rows_of(nodes, "nodes").filter(|n| s(n, "role") == "hub") {
        let email = s(n, "email").to_lowercase();
        if email.is_empty() {
            continue;
        }
        let item = Item {
            id: s(n, "node"),
            serial: s(n, "serial"),
            blocked: n.get("blocked").is_some_and(|b| !b.is_null()),
            revoked: n.get("revoked").and_then(Value::as_bool).unwrap_or(false),
        };
        let e = by_email.entry(email).or_default();
        e.0.push(item);
        e.1.push(s(n, "state"));
    }
    for email in &seated {
        by_email.entry(email.clone()).or_default();
    }
    let mut rows = Vec::new();
    let mut items = HashMap::new();
    for (email, (hubs, states)) in by_email {
        let live: Vec<&Item> = hubs.iter().filter(|h| !h.revoked).collect();
        let is_seated = seated.contains(&email);
        let state = if !hubs.is_empty() && live.is_empty() {
            "revoked"
        } else if !live.is_empty() && live.iter().all(|h| h.blocked) {
            "blocked"
        } else if !is_seated {
            "unseated"
        } else if !states.iter().any(|x| x == "ok" || x == "expiring") {
            "silent"
        } else {
            "active"
        };
        rows.push(json!({
            "kind": "spokes", "relay": view.id, "id": email, "name": Value::Null, "role": "hub-user", "state": state,
            "source": "hub", "hubs": hubs.len(), "seated": is_seated, "asOf": as_of,
        }));
        items.insert(email, hubs);
    }
    finish(view, rows, seats, items, as_of)
}

fn finish(view: &RelayView, rows: Vec<Value>, seats: Value, items: HashMap<String, Vec<Item>>, as_of: i64) -> Fetched {
    let bytes = rows.iter().map(|r| r.to_string().len()).sum::<usize>() + seats.to_string().len() + items.values().flatten().map(|i| i.id.len() + i.serial.len() + 16).sum::<usize>();
    Fetched { relay: view.id.clone(), rows, seats, items, as_of, bytes }
}

/// The 11.1 filters.
#[derive(Default, Debug)]
pub struct Filter {
    pub product: Option<String>,
    pub relay: Option<String>,
    pub role: Option<String>,
    pub state: Option<String>,
    pub source: Option<String>,
    pub q: Option<String>,
    pub limit: usize,
    pub after: Option<String>,
}

fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(h, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub fn parse_filter(query: &str) -> Result<Filter, ApiError> {
    let mut f = Filter { limit: LIST_DEFAULT, ..Filter::default() };
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = pct_decode(v).ok_or_else(|| invalid("A filter is not valid."))?;
        let one = |allowed: &[&str], words: &str| -> Result<Option<String>, ApiError> { if allowed.contains(&v.as_str()) { Ok(Some(v.clone())) } else { Err(invalid(words)) } };
        match k {
            "product" => f.product = one(&["console", "meet", "spokes"], "product is console, meet or spokes.")?,
            "relay" => f.relay = Some(v.clone()),
            "role" => f.role = one(&["admin", "user-manager", "viewer", "relay-admin", "member", "hub-user"], "role is not one this page shows.")?,
            "state" => f.state = Some(v.clone()),
            "source" => f.source = one(&["invite", "operator", "app", "request", "hub", "sso", "scim"], "source is not one this page shows.")?,
            "q" => {
                let n = v.chars().count();
                if !(2..=100).contains(&n) {
                    return Err(invalid("Search text is 2 to 100 characters."));
                }
                f.q = Some(v.to_lowercase());
            }
            "limit" => f.limit = v.parse::<usize>().ok().filter(|n| (1..=LIST_MAX).contains(n)).ok_or_else(|| invalid("limit is 1 to 500."))?,
            "after" => f.after = Some(v.clone()),
            _ => return Err(invalid(format!("Unknown filter: {}.", clean_text(k)))),
        }
    }
    Ok(f)
}

fn sort_key(r: &Value) -> String {
    let rank = match r.get("kind").and_then(Value::as_str) {
        Some("console") => "0",
        Some("meet") => "1",
        _ => "2",
    };
    format!("{rank}\u{0}{}\u{0}{}", s(r, "relay"), s(r, "id"))
}

fn matches(f: &Filter, r: &Value) -> bool {
    let is = |k: &str, want: &Option<String>| want.as_ref().is_none_or(|w| r.get(k).and_then(Value::as_str) == Some(w.as_str()));
    let q_ok = f.q.as_ref().is_none_or(|q| s(r, "id").to_lowercase().contains(q.as_str()) || s(r, "name").to_lowercase().contains(q.as_str()));
    is("kind", &f.product) && is("role", &f.role) && is("state", &f.state) && is("source", &f.source) && q_ok
}

/// Filter, order and page rows; `after` is the opaque cursor of the last row of the previous page.
pub fn page(mut rows: Vec<Value>, f: &Filter) -> Result<(Vec<Value>, usize, Option<String>), ApiError> {
    rows.retain(|r| matches(f, r));
    rows.sort_by_cached_key(sort_key);
    let total = rows.len();
    let start = match &f.after {
        None => 0,
        Some(c) => {
            let key = unb64u(c).and_then(|b| String::from_utf8(b).ok()).ok_or_else(|| invalid("after is not a cursor this page gave."))?;
            rows.iter().position(|r| sort_key(r) > key).unwrap_or(rows.len())
        }
    };
    let out: Vec<Value> = rows.into_iter().skip(start).take(f.limit).collect();
    let next = (start + out.len() < total).then(|| out.last().map(|r| b64u(sort_key(r).as_bytes()))).flatten();
    Ok((out, total, next))
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Drop control and bidirectional formatting characters, then trim.
pub fn clean_text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{2028}' | '\u{2029}' | '\u{feff}'))
        .collect::<String>()
        .trim()
        .to_owned()
}

// ── CSV (11.3) ───────────────────────────────────────────────────────────────────────────────────────────────────

/// RFC 4180 records: comma-separated, `"` quoting with `""` inside, CRLF or LF line ends, an empty last line ignored.
pub fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, ApiError> {
    let bad = || refuse(400, "csv-invalid", CSV_INVALID);
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    let mut was_quoted = false;
    let mut at_start = true;
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if at_start => {
                quoted = true;
                was_quoted = true;
                at_start = false;
            }
            '"' => return Err(bad()),
            ',' => {
                record.push(std::mem::take(&mut field));
                at_start = true;
                was_quoted = false;
            }
            '\r' | '\n' => {
                if c == '\r' {
                    if chars.peek() != Some(&'\n') {
                        return Err(bad());
                    }
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
                at_start = true;
                was_quoted = false;
            }
            _ => {
                if was_quoted {
                    return Err(bad());
                }
                field.push(c);
                at_start = false;
            }
        }
    }
    if quoted {
        return Err(bad());
    }
    if !field.is_empty() || !record.is_empty() || was_quoted {
        record.push(field);
        records.push(record);
    }
    // a blank line at the end (the last newline) adds nothing; blank lines elsewhere are not rows either
    records.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    Ok(records)
}

/// The decoded CSV: size, header and row count. Ok(column index per CSV_COLUMNS name, data rows).
pub fn read_csv(text: &str) -> Result<([usize; 6], Vec<Vec<String>>), ApiError> {
    if text.len() > CSV_BYTES {
        return Err(refuse(413, "csv-limit", CSV_LIMIT));
    }
    let mut records = parse_csv(text)?;
    if records.is_empty() {
        return Err(refuse(400, "csv-invalid", CSV_INVALID));
    }
    let header: Vec<String> = records.remove(0).into_iter().map(|h| h.trim().to_owned()).collect();
    if header.len() != CSV_COLUMNS.len() {
        return Err(refuse(400, "csv-invalid", CSV_INVALID));
    }
    let mut at = [0usize; 6];
    for (i, name) in CSV_COLUMNS.iter().enumerate() {
        let found: Vec<usize> = header.iter().enumerate().filter(|(_, h)| h.as_str() == *name).map(|(j, _)| j).collect();
        if found.len() != 1 {
            return Err(refuse(400, "csv-invalid", CSV_INVALID));
        }
        at[i] = found[0];
    }
    if records.len() > CSV_ROWS {
        return Err(refuse(413, "csv-limit", CSV_LIMIT));
    }
    if records.iter().any(|r| r.len() != CSV_COLUMNS.len()) {
        return Err(refuse(400, "csv-invalid", CSV_INVALID));
    }
    Ok((at, records))
}

/// `people/import/check`'s request: at most 1 MiB encoded, `{csv}` only (the route's `body_max` and keys, then
/// `read_csv`, enforce the same).
#[cfg(test)]
pub fn check_body(raw: &[u8]) -> Result<String, ApiError> {
    if raw.len() > CHECK_BODY_MAX {
        return Err(ApiError::of("too-large"));
    }
    let v: Value = serde_json::from_slice(raw).map_err(|_| ApiError::of("json"))?;
    let o = v.as_object().ok_or_else(|| invalid("The body is {csv}."))?;
    if o.keys().any(|k| k != "csv") {
        return Err(ApiError::of("unknown-field"));
    }
    let csv = str_of(o.get("csv")).ok_or_else(|| invalid("csv is the file's text."))?;
    if csv.len() > CSV_BYTES {
        return Err(refuse(413, "csv-limit", CSV_LIMIT));
    }
    Ok(csv.to_owned())
}

/// One judged row: the shown values, and the canonical row when accepted.
struct Judged {
    shown: Value,
    canonical: Option<Value>,
}

// ── Actions (11.2) ───────────────────────────────────────────────────────────────────────────────────────────────

/// The AC-1 route a console-account action maps to.
#[cfg(test)]
pub fn console_route(action: &str) -> Option<&'static str> {
    Some(match action {
        "invite" => "admins/invite",
        "resend" => "invites/resend",
        "cancel" => "invites/revoke",
        "suspend" => "admins/suspend",
        "unsuspend" => "admins/unsuspend",
        "remove" => "admins/remove",
        "role" => "admins/role",
        _ => return None,
    })
}

/// The devices or hubs a `people` op names: suspend the live unblocked ones, unsuspend the blocked ones, remove every
/// live one.
pub fn op_items(action: &str, items: &[Item]) -> Vec<Item> {
    items
        .iter()
        .filter(|i| !i.revoked)
        .filter(|i| match action {
            "suspend" => !i.blocked,
            "unsuspend" => i.blocked,
            _ => true,
        })
        .cloned()
        .collect()
}

/// The `people` frame body (5.6) and the binding the fleet step-up covers (11.2): `action: "people.<op>"`,
/// `target: <principal or email>`, `params: {relay, hours, reason, devices or hubs}`.
#[allow(clippy::too_many_arguments)]
pub fn people_frame(product: Product, relay: &str, id: &str, action: &str, hours: Option<i64>, reason: &str, items: &[Item], auth: Value) -> (Value, Value) {
    let list: Vec<Value> = items
        .iter()
        .map(|i| match product {
            Product::Meet => json!({"device": i.id}),
            Product::Spokes => json!({"node": i.id, "serial": i.serial}),
        })
        .collect();
    let mut params = Map::new();
    params.insert("relay".into(), Value::from(relay));
    if let Some(h) = hours {
        params.insert("hours".into(), Value::from(h));
    }
    params.insert("reason".into(), Value::from(reason));
    params.insert(if product == Product::Meet { "devices" } else { "hubs" }.into(), Value::Array(list));
    let subject = match product {
        Product::Meet => json!({"principal": id}),
        // one op covers every hub of the user; the subject names the first, `params.hubs` all of them
        Product::Spokes => json!({"node": items.first().map(|i| i.id.clone()).unwrap_or_default()}),
    };
    let params = Value::Object(params);
    let binding = json!({"action": format!("people.{action}"), "target": id, "params": params});
    (json!({"action": action, "subject": subject, "params": params, "auth": auth}), binding)
}

/// Console-side early refusal (the relay checks again, authoritatively): a Meeting Hub suspend that reaches a relay
/// admin's device needs a second admin; with the relay's two-person policy on and one assertion the whole op is
/// refused before anything runs.
pub fn second_needed(view: &RelayView, product: Product, action: &str, id: &str, items: &[Item], assertions: usize) -> Result<(), ApiError> {
    let needs = product == Product::Meet && action == "suspend" && !items.is_empty() && view.admins.iter().any(|a| a == id);
    if needs && view.two_person && assertions < 2 {
        return Err(refuse(409, "fleet-second", FLEET_SECOND));
    }
    Ok(())
}

/// A phase 1 answer's refusal as an ApiError (its `code` when the console knows it).
fn relay_refusal(status: u64, body: &Value) -> ApiError {
    const KNOWN: [&str; 14] = ["license-inactive", "request-exists", "rate", "request-limit", "role", "not-found", "gone", "invalid", "stale", "fleet-second", "fleet-scope", "seat-protected", "not-over", "stepup-failed"];
    let code = str_of(body.get("code")).and_then(|c| KNOWN.iter().copied().find(|k| *k == c)).unwrap_or("invalid");
    let words = str_of(body.get("message")).or_else(|| str_of(body.get("error"))).map(clean_text).unwrap_or_else(|| ApiError::of(code).message);
    ApiError { status: u16::try_from(status).unwrap_or(502), code, message: words, retry_after: None }
}

fn hours_of(v: Option<&Value>) -> Result<i64, ApiError> {
    safe_int(v).filter(|h| (1..=HOURS_MAX).contains(h)).ok_or_else(|| invalid("hours is a whole number from 1 to 720."))
}

fn reason_of(v: Option<&Value>) -> Result<String, ApiError> {
    let r = clean_text(str_of(v).unwrap_or(""));
    if r.is_empty() || r.chars().count() > REASON_MAX {
        return Err(invalid("reason is 1 to 500 characters."));
    }
    Ok(r)
}

impl People {
    pub fn new(host: Arc<dyn PeopleHost>) -> People {
        People {
            host,
            cache: Mutex::new(Cache::default()),
            inflight: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(FETCH_AT_ONCE)),
            imports: Mutex::new(Imports::default()),
            reminded: Mutex::new(HashMap::new()),
        }
    }

    // ── cache wipes (A1-M5) ──

    /// The relay narrowed or lost `people`, left, was removed, or changed state or profile.
    pub fn wipe_relay(&self, relay: &str) {
        self.cache.lock().remove(relay);
    }

    /// The roster or the policy changed.
    pub fn wipe_all(&self) {
        let mut c = self.cache.lock();
        *c = Cache::default();
    }

    /// Re-read the registry and wipe whatever no longer matches.
    pub fn observe(&self) {
        let views = self.host.relays();
        self.cache.lock().observe(&views);
    }

    /// API-1 4.3 as revision 4 6.7 revises it: true when the console's `api-people` record says `deprovisioned`, or
    /// when the console's people data (the cached Meeting Hub rows of every relay) marks `principal` revoked, removed
    /// or blocked for `org`. A principal the console knows nothing about counts as active.
    pub fn person_inactive(&self, org: &str, principal: &str) -> bool {
        if self.host.api_deprovisioned(org, principal) {
            return true;
        }
        let want = principal.trim().to_lowercase();
        let c = self.cache.lock();
        c.entries.values().flat_map(|e| e.data.rows.iter()).any(|r| {
            r.get("kind").and_then(Value::as_str) == Some("meet")
                && r.get("org").and_then(Value::as_str) == Some(org)
                && r.get("id").and_then(Value::as_str).is_some_and(|id| id.to_lowercase() == want)
                && matches!(r.get("state").and_then(Value::as_str), Some("revoked" | "removed" | "blocked"))
        })
    }

    /// Rows held, in all.
    #[cfg(test)]
    pub fn cached_rows(&self) -> usize {
        self.cache.lock().rows
    }

    fn rights(&self, asker: &Asker) -> Rights {
        self.host.rights_now(&asker.session).unwrap_or(Rights::None).min(asker.rights)
    }

    fn need(&self, asker: &Asker, at_least: Rights) -> Result<Rights, ApiError> {
        let r = self.rights(asker);
        if r < at_least {
            return Err(ApiError::of("role"));
        }
        Ok(r)
    }

    fn view(&self, relay: &str) -> Option<RelayView> {
        self.host.relays().into_iter().find(|v| v.id == relay)
    }

    fn caller(asker: &Asker) -> Value {
        json!({"email": asker.email, "role": if asker.rights >= Rights::Admin { "admin" } else { "user-manager" }})
    }

    #[allow(clippy::too_many_arguments)]
    async fn call(&self, relay: &str, asker: &Asker, method: &str, path: &str, query: &str, body: Value, auth: Value) -> Result<Value, ApiError> {
        let frame = json!({"method": method, "path": path, "query": query, "body": body, "caller": Self::caller(asker), "auth": auth});
        let answer = self.host.call(relay, frame).await?;
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(502);
        let body = answer.get("body").cloned().unwrap_or(Value::Null);
        if status == 200 {
            Ok(body)
        } else {
            Err(relay_refusal(status, &body))
        }
    }

    async fn fetch(&self, view: RelayView, asker: Asker, now: i64) -> Result<Arc<Fetched>, String> {
        let _permit = self.permits.clone().acquire_owned().await.map_err(|_| "error".to_owned())?;
        let read = |path: &'static str, query: String| {
            let (view, asker) = (&view, &asker);
            async move { self.call(&view.id, asker, "GET", path, &query, Value::Null, Value::Null).await.map_err(|e| e.code.to_owned()) }
        };
        let work = async {
            let limit = format!("limit={RELAY_READ_LIMIT}");
            Ok(Arc::new(match view.product {
                Product::Meet => {
                    let people = read("meet/people", limit).await?;
                    let seats = read("meet/seats", String::new()).await?;
                    meet_rows(&view, &people, seats, now)
                }
                Product::Spokes => {
                    let seats = read("spokes/seats", String::new()).await?;
                    let nodes = read("spokes/nodes", format!("role=hub&{limit}")).await?;
                    spokes_rows(&view, &nodes, seats, now)
                }
            }))
        };
        match tokio::time::timeout(FETCH_TIMEOUT, work).await {
            Ok(r) => r,
            Err(_) => Err("timeout".to_owned()),
        }
    }

    /// One relay's rows: from the cache when the entry still matches the relay's generation, state and profile, else
    /// fetched (concurrent fetches for the same relay share one request). Every hit re-checks the relay's `people`
    /// grant and the asker's rights now. Err is the `missing` reason.
    pub async fn relay_rows(&self, asker: &Asker, relay: &str, now: i64) -> Result<Arc<Fetched>, String> {
        let Some(view) = self.view(relay) else {
            self.wipe_relay(relay);
            return Err("removed".into());
        };
        if !view.grants("people") {
            self.wipe_relay(relay);
            return Err("scope".into());
        }
        if self.rights(asker) < Rights::Manager {
            return Err("role".into());
        }
        let key = view.key();
        let hit = self.cache.lock().get(relay, &key, now);
        let data = match hit {
            Some(d) => d,
            None => {
                if !view.connected {
                    return Err("offline".into());
                }
                let cell: Shared = self.inflight.lock().entry((relay.to_owned(), key.clone())).or_insert_with(|| Arc::new(OnceCell::new())).clone();
                let res = cell.get_or_init(|| self.fetch(view.clone(), asker.clone(), now)).await.clone();
                {
                    let mut m = self.inflight.lock();
                    if m.get(&(relay.to_owned(), key.clone())).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
                        m.remove(&(relay.to_owned(), key.clone()));
                    }
                }
                let data = res?;
                // keep it only while the relay still grants `people` at the generation it was fetched under
                if self.view(relay).is_some_and(|v| v.grants("people") && v.key() == key) {
                    self.cache.lock().put(key.clone(), data.clone(), now);
                }
                data
            }
        };
        // the per-hit re-check, before any row leaves
        let still = self.view(relay).is_some_and(|v| v.grants("people") && v.key() == key);
        if !still {
            self.wipe_relay(relay);
            return Err("scope".into());
        }
        if self.rights(asker) < Rights::Manager {
            return Err("role".into());
        }
        Ok(data)
    }

    /// `GET /console/api/fleet/people` (manager).
    pub async fn list(&self, asker: &Asker, query: &str, now: i64) -> Result<Value, ApiError> {
        self.need(asker, Rights::Manager)?;
        let f = parse_filter(query)?;
        let views = self.host.relays();
        self.cache.lock().observe(&views);
        let want = |p: &str| f.product.as_deref().is_none_or(|w| w == p);
        let mut rows: Vec<Value> = if want("console") && f.relay.is_none() { self.host.console_rows() } else { Vec::new() };
        let chosen: Vec<&RelayView> = views.iter().filter(|v| want(v.product.as_str()) && f.relay.as_deref().is_none_or(|r| r == v.id)).collect();
        let answers = futures_util::future::join_all(chosen.iter().map(|v| self.relay_rows(asker, &v.id, now))).await;
        self.need(asker, Rights::Manager)?;
        let mut missing = Vec::new();
        let mut seats = Vec::new();
        for (v, a) in chosen.iter().zip(answers) {
            match a {
                Ok(d) => {
                    rows.extend(d.rows.iter().cloned());
                    if v.product == Product::Meet {
                        seats.push(json!({"relay": v.id, "name": v.name, "serviceStopped": v.service_stopped, "seats": d.seats, "asOf": d.as_of}));
                    }
                }
                Err(reason) => missing.push(json!({"relay": v.id, "name": v.name, "reason": reason})),
            }
        }
        let (rows, total, next) = page(rows, &f)?;
        Ok(json!({"ok": true, "rows": rows, "total": total, "next": next, "missing": missing, "seats": seats}))
    }

    fn mail_admins(&self, view: &RelayView, requester: &str, email: &str) -> usize {
        let accounts = self.host.console_emails();
        let mut n = 0;
        for admin in view.admins.iter().filter(|a| accounts.contains(*a)) {
            self.host.mail(MAIL_INVITE_WAITING, admin, &[("requester", requester.to_owned()), ("email", email.to_owned()), ("relay", view.name.clone())]);
            n += 1;
        }
        n
    }

    fn meet_relay(&self, relay: &str) -> Result<RelayView, ApiError> {
        let v = self.view(relay).filter(|v| v.product == Product::Meet).ok_or_else(|| ApiError::of("not-found"))?;
        if !v.grants("people") {
            return Err(ApiError::with("invalid", "This relay did not give the Admin Console the people scope, so this page is empty."));
        }
        Ok(v)
    }

    async fn invite_one(&self, asker: &Asker, view: &RelayView, email: &str, name: &str, days: i64, auth: Value) -> Result<Value, ApiError> {
        let target = json!({"name": name, "email": email, "days": days});
        let answer = self.call(&view.id, asker, "POST", "requests/new", "", json!({"kind": "meet.invite", "target": target}), auth).await?;
        let mailed = self.mail_admins(view, &asker.email, email);
        Ok(json!({"request": answer.get("id").cloned().unwrap_or(Value::Null), "mailed": mailed}))
    }

    /// `POST /console/api/fleet/people/invite` for a Meeting Hub person (manager; fleet step-up in `auth`). Console
    /// accounts go to AC-1 `admins/invite` (`console_route`).
    pub async fn invite_meet(&self, asker: &Asker, body: &Value, auth: Value) -> Result<Value, ApiError> {
        self.need(asker, Rights::Manager)?;
        let relay = str_of(body.get("relay")).ok_or_else(|| invalid("relay is required."))?;
        let view = self.meet_relay(relay)?;
        let email = crate::console_mail::parse_mailbox(str_of(body.get("email")).unwrap_or("")).map_err(|_| ApiError::of("bad-mailbox"))?.to_lowercase();
        let name = clean_text(str_of(body.get("name")).unwrap_or(""));
        if name.is_empty() || name.chars().count() > NAME_MAX {
            return Err(invalid("name is 1 to 80 characters."));
        }
        let days = match body.get("days") {
            None | Some(Value::Null) => DAYS_DEFAULT,
            v => safe_int(v).filter(|d| (1..=30).contains(d)).ok_or_else(|| invalid("days is 1 to 30."))?,
        };
        if view.service_stopped {
            return Err(ApiError::of("license-inactive"));
        }
        if view.waiting_requests >= WAITING_CAP {
            return Err(refuse(409, "request-limit", REQUEST_LIMIT));
        }
        let done = self.invite_one(asker, &view, &email, &name, days, auth).await?;
        self.wipe_relay(&view.id);
        Ok(json!({"ok": true, "request": done["request"], "mailed": done["mailed"]}))
    }

    /// `requests/cancel` of a waiting Meeting Hub invite.
    pub async fn cancel_meet(&self, asker: &Asker, relay: &str, request: &str, auth: Value) -> Result<Value, ApiError> {
        self.need(asker, Rights::Manager)?;
        let view = self.meet_relay(relay)?;
        self.call(&view.id, asker, "POST", "requests/cancel", "", json!({"id": request}), auth).await?;
        self.wipe_relay(&view.id);
        Ok(json!({"ok": true}))
    }

    /// `meet/seats/pick` (AC-1 2.4) on one relay.
    pub async fn seat_pick(&self, asker: &Asker, relay: &str, principal: &str, pick: bool, auth: Value) -> Result<Value, ApiError> {
        self.need(asker, Rights::Manager)?;
        let view = self.meet_relay(relay)?;
        let answer = self.call(&view.id, asker, "POST", "meet/seats/pick", "", json!({"principal": principal.trim().to_lowercase(), "pick": pick}), auth).await?;
        self.wipe_relay(&view.id);
        Ok(answer)
    }

    /// `POST /console/api/fleet/people/remind` (manager): mail the relay's admins again about a waiting invite, once
    /// per request per 24 hours.
    pub async fn remind(&self, asker: &Asker, body: &Value, now: i64) -> Result<Value, ApiError> {
        self.need(asker, Rights::Manager)?;
        let relay = str_of(body.get("relay")).ok_or_else(|| invalid("relay is required."))?;
        let request = str_of(body.get("request")).filter(|r| !r.is_empty()).ok_or_else(|| invalid("request is required."))?;
        let view = self.meet_relay(relay)?;
        if !self.host.mail_on() {
            return Err(ApiError::of("mail-off"));
        }
        let key = (view.id.clone(), request.to_owned());
        if let Some(last) = self.reminded.lock().get(&key).copied().filter(|l| now - l < REMIND_MS) {
            return Err(ApiError::rate((REMIND_MS - (now - last) + 999) / 1000));
        }
        let list = self.call(&view.id, asker, "GET", "requests", "state=waiting&kind=meet.invite", Value::Null, Value::Null).await?;
        let item = rows_of(&list, "requests").find(|r| s(r, "id") == request).ok_or_else(|| ApiError::of("gone"))?;
        let email = item.get("target").map(|t| s(t, "email")).unwrap_or_default().to_lowercase();
        let requester = s(item, "requested_by").to_lowercase();
        let mailed = self.mail_admins(&view, if requester.is_empty() { &asker.email } else { &requester }, &email);
        let mut r = self.reminded.lock();
        r.retain(|_, at| now - *at < REMIND_MS);
        r.insert(key, now);
        Ok(json!({"ok": true, "mailed": mailed}))
    }

    /// `POST /console/api/fleet/people/suspend`, `unsuspend`, `remove` for a relay person (admin; one fleet step-up
    /// in `auth` covers the op, `assertions` the admins it carries).
    pub async fn act(&self, asker: &Asker, action: &str, body: &Value, auth: Value, assertions: usize, now: i64) -> Result<Value, ApiError> {
        if !matches!(action, "suspend" | "unsuspend" | "remove") {
            return Err(ApiError::of("not-found"));
        }
        self.need(asker, Rights::Admin)?;
        let product = match str_of(body.get("kind")) {
            Some("meet") => Product::Meet,
            Some("spokes") => Product::Spokes,
            Some("console") => return Err(invalid("Console accounts change through the Admin Console's own account routes.")),
            _ => return Err(invalid("kind is console, meet or spokes.")),
        };
        let relay = str_of(body.get("relay")).ok_or_else(|| invalid("relay is required."))?;
        let id = str_of(body.get("id")).map(str::to_lowercase).filter(|i| !i.is_empty()).ok_or_else(|| invalid("id is required."))?;
        let view = self.view(relay).filter(|v| v.product == product).ok_or_else(|| ApiError::of("not-found"))?;
        let hours = if action == "suspend" { Some(hours_of(body.get("hours"))?) } else { None };
        let reason = reason_of(body.get("reason"))?;
        let data = self.relay_rows(asker, relay, now).await.map_err(|why| ApiError::with("stale", format!("Nothing was changed: the relay did not answer ({why}).")))?;
        let all = data.items.get(&id).ok_or_else(|| ApiError::of("not-found"))?;
        let items = op_items(action, all);
        if items.is_empty() {
            return Err(ApiError::with("stale", "Nothing was changed: it no longer applies."));
        }
        second_needed(&view, product, action, &id, &items, assertions)?;
        let (frame, _) = people_frame(product, relay, &id, action, hours, &reason, &items, auth);
        let answer = self.host.people_op(relay, frame).await?;
        self.wipe_relay(relay);
        Ok(json!({"ok": true, "results": answer.get("results").cloned().unwrap_or(Value::Array(Vec::new()))}))
    }

    // ── CSV check and import (11.3) ──

    fn find_meet<'a>(views: &'a [RelayView], key: &str) -> Option<&'a RelayView> {
        let meet = || views.iter().filter(|v| v.product == Product::Meet);
        meet().find(|v| v.id == key).or_else(|| {
            let named: Vec<&RelayView> = meet().filter(|v| v.name == key).collect();
            (named.len() == 1).then(|| named[0])
        })
    }

    async fn judge(&self, asker: &Asker, rights: Rights, at: &[usize; 6], records: &[Vec<String>], views: &[RelayView], now: i64) -> Vec<Judged> {
        let mut seen: HashSet<(String, String, String)> = HashSet::new();
        let mut per_relay: HashMap<String, u64> = HashMap::new();
        let mut existing: HashMap<String, Option<HashSet<String>>> = HashMap::new();
        let mut out = Vec::with_capacity(records.len());
        for (n, r) in records.iter().enumerate() {
            let cell = |i: usize| r[at[i]].trim().to_owned();
            let (raw_email, name, product, role, relay, days) = (cell(0), clean_text(&cell(1)), cell(2), cell(3), cell(4), cell(5));
            let mut shown = json!({"line": n + 2, "email": raw_email, "name": name, "product": product, "role": role, "relay": relay, "days": days});
            let verdict: Result<(Value, Option<String>), &'static str> = (|| {
                let email = crate::console_mail::parse_mailbox(&raw_email).map_err(|_| "csv-email")?.to_lowercase();
                if name.chars().count() > NAME_MAX {
                    return Err("csv-invalid");
                }
                match product.as_str() {
                    "console" => {
                        if !matches!(role.as_str(), "viewer" | "user-manager" | "admin") {
                            return Err("csv-role");
                        }
                        if role == "admin" && rights < Rights::Admin {
                            return Err("csv-role");
                        }
                        if !relay.is_empty() || !days.is_empty() {
                            return Err("csv-invalid");
                        }
                        if self.host.console_exists(&email) || !seen.insert((email.clone(), "console".into(), String::new())) {
                            return Err("exists");
                        }
                        Ok((json!({"email": email, "name": name, "product": "console", "role": role, "relay": Value::Null, "days": Value::Null}), None))
                    }
                    "meet" => {
                        if role != "member" {
                            return Err("csv-role");
                        }
                        if name.is_empty() {
                            return Err("csv-invalid");
                        }
                        let days = if days.is_empty() { DAYS_DEFAULT } else { days.parse::<i64>().ok().filter(|d| (1..=30).contains(d)).ok_or("csv-invalid")? };
                        let view = Self::find_meet(views, &relay).ok_or("csv-relay")?;
                        if !view.grants("people") {
                            return Err("scope");
                        }
                        if !seen.insert((email.clone(), "meet".into(), view.id.clone())) {
                            return Err("exists");
                        }
                        Ok((json!({"email": email, "name": name, "product": "meet", "role": "member", "relay": view.id, "days": days}), Some(view.id.clone())))
                    }
                    _ => Err("csv-invalid"),
                }
            })();
            let judged = match verdict {
                Err(p) => {
                    shown["status"] = Value::from(p);
                    Judged { shown, canonical: None }
                }
                Ok((canonical, None)) => {
                    shown["status"] = Value::from("ok");
                    Judged { shown, canonical: Some(canonical) }
                }
                Ok((canonical, Some(relay_id))) => {
                    if !existing.contains_key(&relay_id) {
                        let known = self.relay_rows(asker, &relay_id, now).await.ok().map(|d| d.rows.iter().map(|r| s(r, "id")).collect::<HashSet<String>>());
                        existing.insert(relay_id.clone(), known);
                    }
                    let view = views.iter().find(|v| v.id == relay_id);
                    let email = s(&canonical, "email");
                    let status = if existing.get(&relay_id).and_then(Option::as_ref).is_some_and(|k| k.contains(&email)) {
                        "exists"
                    } else if view.is_some_and(|v| v.service_stopped) {
                        "license-inactive"
                    } else {
                        let count = per_relay.entry(relay_id.clone()).or_insert(0);
                        if view.map(|v| v.waiting_requests).unwrap_or(0) + *count + 1 > WAITING_CAP {
                            "request-limit"
                        } else {
                            *count += 1;
                            "ok"
                        }
                    };
                    shown["status"] = Value::from(status);
                    Judged { shown, canonical: (status == "ok").then_some(canonical) }
                }
            };
            out.push(judged);
        }
        out
    }

    /// `POST /console/api/fleet/people/import/check` (manager, no step-up). `csv` is the decoded string (see
    /// `check_body`); it is read once and never kept.
    pub async fn import_check(&self, asker: &Asker, csv: String, now: i64) -> Result<Value, ApiError> {
        let rights = self.need(asker, Rights::Manager)?;
        let (at, records) = read_csv(&csv)?;
        drop(csv);
        let views = self.host.relays();
        self.cache.lock().observe(&views);
        let judged = self.judge(asker, rights, &at, &records, &views, now).await;
        drop(records);
        let rows: Vec<Value> = judged.iter().filter_map(|j| j.canonical.clone()).collect();
        let canonical = crate::console_audit::canonical_json(&Value::Array(rows.clone())).map_err(|_| ApiError::of("invalid"))?;
        let digest = hex(&sha256(&canonical));
        let mut relays: Vec<String> = rows.iter().filter_map(|r| str_of(r.get("relay")).map(str::to_owned)).collect();
        relays.sort();
        relays.dedup();
        let id = b64u(&crate::console_auth::random_bytes(16)?);
        let expires = now + IMPORT_MS;
        let check = Check { id: id.clone(), session: asker.session.clone(), rights, digest: digest.clone(), relays: relays.clone(), bytes: canonical.len(), rows, expires, made: 0 };
        self.imports.lock().keep(check, now);
        let shown: Vec<Value> = judged.into_iter().map(|j| j.shown).collect();
        Ok(json!({"ok": true, "importId": id, "rows": shown, "digest": digest, "relays": relays, "expires": expires}))
    }

    /// The fleet step-up binding of an import with any Meeting Hub row (11.3): `params: {importId, digest}`, `targets`
    /// the relays named. None when the check is unknown to this session (the import then answers `csv-changed`).
    pub fn import_binding(&self, session: &str, import_id: &str) -> Option<Value> {
        let im = self.imports.lock();
        let c = im.list.iter().find(|c| c.id == import_id && c.session == session)?;
        Some(json!({"action": "people.import", "target": "-", "params": {"importId": c.id, "digest": c.digest}, "targets": c.relays}))
    }

    /// `POST /console/api/fleet/people/import {importId, digest, stepup}` (manager). The step-ups are verified by the
    /// route; `auth` is the fleet step-up forwarded to each relay.
    pub async fn import(&self, asker: &Asker, body: &Value, auth: Value, now: i64) -> Result<Value, ApiError> {
        let id = str_of(body.get("importId")).unwrap_or("");
        let digest = str_of(body.get("digest")).unwrap_or("");
        let check = self.imports.lock().take(id, &asker.session, digest, now).ok_or_else(|| refuse(409, "csv-changed", CSV_CHANGED))?;
        let rights = self.need(asker, Rights::Manager)?;
        let _ = check.rights;
        let views = self.host.relays();
        self.cache.lock().observe(&views);
        let mut done = Vec::new();
        let mut refused = Vec::new();
        let mut per_relay: HashMap<String, u64> = HashMap::new();
        for row in &check.rows {
            let email = s(row, "email");
            let outcome: Result<(), ApiError> = async {
                if s(row, "product") == "console" {
                    let role = s(row, "role");
                    if role == "admin" && rights < Rights::Admin {
                        return Err(ApiError::of("invite-role"));
                    }
                    return self.host.console_invite(asker, &email, &role, now);
                }
                let relay = s(row, "relay");
                let view = views.iter().find(|v| v.id == relay && v.product == Product::Meet).ok_or_else(|| ApiError::of("not-found"))?;
                if !view.grants("people") {
                    return Err(ApiError::with("invalid", "This relay did not give the Admin Console the people scope."));
                }
                if view.service_stopped {
                    return Err(ApiError::of("license-inactive"));
                }
                let count = per_relay.entry(relay.clone()).or_insert(0);
                if view.waiting_requests + *count + 1 > WAITING_CAP {
                    return Err(refuse(409, "request-limit", REQUEST_LIMIT));
                }
                *count += 1;
                let days = row.get("days").and_then(Value::as_i64).unwrap_or(DAYS_DEFAULT);
                self.invite_one(asker, view, &email, &s(row, "name"), days, auth.clone()).await.map(|_| ())
            }
            .await;
            match outcome {
                Ok(()) => done.push(json!({"email": email, "product": row["product"], "relay": row["relay"]})),
                Err(e) => refused.push(json!({"email": email, "product": row["product"], "relay": row["relay"], "code": e.code, "message": e.message})),
            }
        }
        for r in &check.relays {
            self.wipe_relay(r);
        }
        Ok(json!({"ok": true, "done": done, "refused": refused}))
    }
}

impl People {
    /// The 5.3 people rows, for the console's synchronous dispatcher: `path` is the route after
    /// `/console/api/fleet/`, `params` the parsed body. The fleet step-up was verified by the caller; `auth` is the
    /// 4.6 object to forward, `assertions` the admins it carries. Blocking (runs the async work on the current
    /// multi-thread runtime, or on a private one when none is running).
    #[allow(clippy::too_many_arguments)]
    pub fn route(&self, method: &str, path: &str, asker: &Asker, query: &str, params: &Value, auth: Value, assertions: usize, t: i64) -> Result<Value, ApiError> {
        let work = async {
            match (method, path) {
                ("GET", "people") => self.list(asker, query, t).await,
                ("POST", "people/invite") => self.invite_meet(asker, params, auth).await,
                ("POST", "people/import/check") => {
                    let csv = str_of(params.get("csv")).ok_or_else(|| invalid("csv is the file's text."))?.to_owned();
                    self.import_check(asker, csv, t).await
                }
                ("POST", "people/import") => self.import(asker, params, auth, t).await,
                ("POST", "people/remind") => self.remind(asker, params, t).await,
                ("POST", "people/cancel") => {
                    let relay = str_of(params.get("relay")).unwrap_or("");
                    let request = str_of(params.get("request")).unwrap_or("");
                    self.cancel_meet(asker, relay, request, auth).await
                }
                ("POST", "people/seats/pick") => {
                    let relay = str_of(params.get("relay")).unwrap_or("");
                    let principal = str_of(params.get("principal")).unwrap_or("").to_lowercase();
                    let pick = params.get("pick").and_then(Value::as_bool).ok_or_else(|| invalid("pick is true or false."))?;
                    self.seat_pick(asker, relay, &principal, pick, auth).await
                }
                ("POST", p) if p.starts_with("people/") => self.act(asker, &p["people/".len()..], params, auth, assertions, t).await,
                _ => Err(ApiError::of("not-found")),
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(h) => tokio::task::block_in_place(|| h.block_on(work)),
            Err(_) => tokio::runtime::Builder::new_current_thread().enable_time().build().map_err(|_| ApiError::of("write-failed"))?.block_on(work),
        }
    }

    /// Once a minute: wipe what no longer matches the registry, drop expired checks and old reminder marks.
    pub fn tick(&self, t: i64) {
        self.observe();
        self.cache.lock().entries.retain(|_, e| t - e.at < CACHE_MS);
        let mut c = self.cache.lock();
        c.rows = c.entries.values().map(|e| e.data.rows.len()).sum();
        c.bytes = c.entries.values().map(|e| e.data.bytes).sum();
        drop(c);
        self.imports.lock().list.retain(|x| x.expires > t);
        self.reminded.lock().retain(|_, at| t - *at < REMIND_MS);
    }
}


// ── High: no dump, no core (11.1) ────────────────────────────────────────────────────────────────────────────────

/// Under High the console role calls this at start (F7, `console::open_fleet`): Linux `prctl(PR_SET_DUMPABLE, 0)` and a
/// zero core limit. On Windows dumps are off through the service's Windows Error Reporting registration (LF-25,
/// `[INFERENCE]`), so nothing runs here; other systems likewise.
pub fn make_non_dumpable() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::{c_int, c_ulong};
        #[repr(C)]
        struct Rlimit {
            cur: c_ulong,
            max: c_ulong,
        }
        extern "C" {
            fn prctl(option: c_int, ...) -> c_int;
            fn setrlimit(resource: c_int, rlim: *const Rlimit) -> c_int;
        }
        const PR_SET_DUMPABLE: c_int = 4;
        const RLIMIT_CORE: c_int = 4;
        // SAFETY: plain system calls with constant arguments and a pointer to a live local.
        let dump = unsafe { prctl(PR_SET_DUMPABLE, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) };
        if dump != 0 {
            return Err(format!("prctl(PR_SET_DUMPABLE, 0) failed: {}", std::io::Error::last_os_error()));
        }
        let zero = Rlimit { cur: 0, max: 0 };
        // SAFETY: as above.
        if unsafe { setrlimit(RLIMIT_CORE, &zero) } != 0 {
            return Err(format!("setrlimit(RLIMIT_CORE, 0) failed: {}", std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

// ── Tests (16.1 f-people) ────────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const T0: i64 = 1_800_000_000_000;

    /// A mail the fake sent: (kind, to, args).
    type Mail = (String, String, Vec<(String, String)>);

    #[derive(Default)]
    struct Fake {
        relays: Mutex<Vec<RelayView>>,
        rights: Mutex<HashMap<String, Rights>>,
        calls: Mutex<Vec<(String, Value)>>,
        ops: Mutex<Vec<(String, Value)>>,
        reads: AtomicUsize,
        delay_ms: Mutex<u64>,
        answers: Mutex<HashMap<(String, String), Value>>,
        mails: Mutex<Vec<Mail>>,
        console: Mutex<HashSet<String>>,
        invited: Mutex<Vec<(String, String)>>,
        mail_on: Mutex<bool>,
        refuse_new: Mutex<Option<(u64, Value)>>,
    }

    impl PeopleHost for Fake {
        fn relays(&self) -> Vec<RelayView> {
            self.relays.lock().clone()
        }
        fn rights_now(&self, session: &str) -> Option<Rights> {
            self.rights.lock().get(session).copied()
        }
        fn call<'a>(&'a self, relay: &'a str, body: Value) -> BoxFut<'a, Result<Value, ApiError>> {
            Box::pin(async move {
                let delay = *self.delay_ms.lock();
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                self.calls.lock().push((relay.to_owned(), body.clone()));
                let path = s(&body, "path");
                if s(&body, "method") == "GET" {
                    self.reads.fetch_add(1, Ordering::SeqCst);
                    if !self.relays.lock().iter().any(|v| v.id == relay && v.connected) {
                        return Err(ApiError::with("invalid", "offline"));
                    }
                    let a = self.answers.lock().get(&(relay.to_owned(), path)).cloned().unwrap_or(json!({}));
                    return Ok(json!({"status": 200, "body": a}));
                }
                if path == "requests/new" {
                    if let Some((st, b)) = self.refuse_new.lock().clone() {
                        return Ok(json!({"status": st, "body": b}));
                    }
                    return Ok(json!({"status": 200, "body": {"ok": true, "id": "r1"}}));
                }
                Ok(json!({"status": 200, "body": {"ok": true}}))
            })
        }
        fn people_op<'a>(&'a self, relay: &'a str, body: Value) -> BoxFut<'a, Result<Value, ApiError>> {
            Box::pin(async move {
                self.ops.lock().push((relay.to_owned(), body.clone()));
                Ok(json!({"results": [{"target": "x", "ok": true, "code": Value::Null}]}))
            })
        }
        fn console_rows(&self) -> Vec<Value> {
            vec![json!({"kind": "console", "id": "ann@x.org", "name": Value::Null, "role": "admin", "state": "active", "source": "operator", "relay": Value::Null})]
        }
        fn console_exists(&self, email: &str) -> bool {
            self.console.lock().contains(email)
        }
        fn console_invite(&self, _asker: &Asker, email: &str, role: &str, _t: i64) -> Result<(), ApiError> {
            self.invited.lock().push((email.to_owned(), role.to_owned()));
            Ok(())
        }
        fn console_emails(&self) -> HashSet<String> {
            ["ann@x.org".to_owned()].into_iter().collect()
        }
        fn mail_on(&self) -> bool {
            *self.mail_on.lock()
        }
        fn mail(&self, kind: &str, to: &str, args: &[(&str, String)]) {
            self.mails.lock().push((kind.to_owned(), to.to_owned(), args.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()));
        }
    }

    fn view(id: &str, product: Product) -> RelayView {
        RelayView {
            id: id.into(),
            name: format!("Relay {id}"),
            product,
            state: "active".into(),
            profile: "standard".into(),
            scope_generation: 1,
            scopes: vec!["read-health".into(), "people".into()],
            service_stopped: false,
            waiting_requests: 0,
            admins: vec!["ann@x.org".into()],
            two_person: true,
            connected: true,
        }
    }

    fn meet_people() -> Value {
        json!({"ok": true, "people": [
            {"principal": "ann@x.org", "name": "Ann", "org": null, "state": "online", "seated": true, "devices": [
                {"device": "aaaa", "serial": "A1", "revoked": false, "blocked": null},
                {"device": "aaab", "serial": "A2", "revoked": false, "blocked": null}]},
            {"principal": "bob@x.org", "name": "=cmd()", "org": null, "state": "joined", "seated": false, "devices": [
                {"device": "bbbb", "serial": "B1", "revoked": false, "blocked": {"until": 1}}]},
            {"principal": "cy@x.org", "name": "Cy", "org": null, "state": "waiting", "seated": true, "devices": []}
        ], "total": 3})
    }

    fn spokes_nodes() -> Value {
        json!({"ok": true, "nodes": [
            {"node": "n_1", "role": "hub", "email": "dan@x.org", "serial": "S1", "revoked": false, "blocked": null, "state": "ok"},
            {"node": "n_2", "role": "hub", "email": "dan@x.org", "serial": "S2", "revoked": false, "blocked": null, "state": "ok"},
            {"node": "n_3", "role": "hub", "email": "eve@x.org", "serial": "S3", "revoked": true, "blocked": null, "state": "revoked"},
            {"node": "n_4", "role": "spoke", "email": null, "serial": "S4", "revoked": false, "blocked": null, "state": "ok"}
        ]})
    }

    fn setup() -> (Arc<Fake>, People, Asker) {
        let fake = Arc::new(Fake::default());
        *fake.relays.lock() = vec![view("m1", Product::Meet), view("s1", Product::Spokes)];
        fake.rights.lock().insert("sid-a".into(), Rights::Admin);
        fake.rights.lock().insert("sid-m".into(), Rights::Manager);
        *fake.mail_on.lock() = true;
        {
            let mut a = fake.answers.lock();
            a.insert(("m1".into(), "meet/people".into()), meet_people());
            a.insert(("m1".into(), "meet/seats".into()), json!({"ok": true, "users": 10, "used": 2}));
            a.insert(("s1".into(), "spokes/nodes".into()), spokes_nodes());
            a.insert(("s1".into(), "spokes/seats".into()), json!({"ok": true, "users": 5, "used": 1, "seats": [{"user": "u_1", "email": "dan@x.org"}]}));
            a.insert(("m1".into(), "requests".into()), json!({"ok": true, "requests": [{"id": "q1", "requested_by": "mia@x.org", "target": {"email": "zed@x.org"}}]}));
        }
        let people = People::new(fake.clone());
        let admin = Asker { session: "sid-a".into(), email: "ann@x.org".into(), rights: Rights::Admin };
        (fake, people, admin)
    }

    fn manager() -> Asker {
        Asker { session: "sid-m".into(), email: "mia@x.org".into(), rights: Rights::Manager }
    }

    fn by_id<'a>(rows: &'a Value, id: &str) -> &'a Value {
        rows["rows"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap()
    }

    #[test]
    fn a_person_is_inactive_only_when_the_people_data_says_so() {
        let (_fake, people, _) = setup();
        let mut answer = meet_people();
        for row in answer["people"].as_array_mut().unwrap() {
            row["org"] = json!("acme");
        }
        let m1 = view("m1", Product::Meet);
        people.cache.lock().put(m1.key(), Arc::new(meet_rows(&m1, &answer, json!({}), T0)), T0);
        assert!(people.person_inactive("acme", "Bob@x.org"), "bob's only device is blocked");
        assert!(!people.person_inactive("acme", "ann@x.org"));
        assert!(!people.person_inactive("other", "bob@x.org"), "another org");
        assert!(!people.person_inactive("acme", "nobody@x.org"), "unknown counts as active");
    }

    #[tokio::test]
    async fn gathers_every_kind_and_lists_a_missing_relay() {
        let (fake, people, admin) = setup();
        fake.relays.lock()[1].connected = false;
        let out = people.list(&admin, "", T0).await.unwrap();
        assert_eq!(out["missing"], json!([{"relay": "s1", "name": "Relay s1", "reason": "offline"}]));
        let ann = by_id(&out, "ann@x.org");
        assert!(out["rows"].as_array().unwrap().iter().any(|r| r["kind"] == "console"));
        let meet_ann = out["rows"].as_array().unwrap().iter().find(|r| r["kind"] == "meet" && r["id"] == "ann@x.org").unwrap();
        assert_eq!((meet_ann["role"].as_str(), meet_ann["devices"].as_u64(), meet_ann["asOf"].as_i64()), (Some("relay-admin"), Some(2), Some(T0)));
        assert_eq!(ann["kind"], "console");
        let bob = by_id(&out, "bob@x.org");
        assert_eq!((bob["state"].as_str(), bob["role"].as_str(), bob["source"].as_str()), (Some("blocked"), Some("member"), Some("app")));
        assert_eq!(by_id(&out, "cy@x.org")["source"], "request");
        assert_eq!(out["seats"][0]["relay"], "m1");
        // with the relay back, the Remote Spokes hub users come in
        fake.relays.lock()[1].connected = true;
        let out = people.list(&admin, "product=spokes", T0 + 1).await.unwrap();
        assert_eq!(out["missing"], json!([]));
        let dan = by_id(&out, "dan@x.org");
        assert_eq!((dan["hubs"].as_u64(), dan["state"].as_str(), dan["seated"].as_bool()), (Some(2), Some("active"), Some(true)));
        assert_eq!(by_id(&out, "eve@x.org")["state"], "revoked");
        assert_eq!(out["total"], 2);
    }

    #[tokio::test]
    async fn filters_and_paging() {
        let (_fake, people, admin) = setup();
        let out = people.list(&admin, "product=meet&state=unseated", T0).await.unwrap();
        assert_eq!(out["total"], 0);
        let out = people.list(&admin, "q=bo", T0).await.unwrap();
        assert_eq!(out["total"], 1);
        let out = people.list(&admin, "q=cmd", T0).await.unwrap();
        assert_eq!(out["rows"][0]["id"], "bob@x.org");
        let out = people.list(&admin, "role=hub-user&relay=s1", T0).await.unwrap();
        assert_eq!(out["total"], 2);
        let out = people.list(&admin, "source=request", T0).await.unwrap();
        assert_eq!(out["total"], 1);
        assert_eq!(people.list(&admin, "q=x", T0).await.unwrap_err().code, "invalid");
        assert_eq!(people.list(&admin, "color=red", T0).await.unwrap_err().code, "invalid");
        assert_eq!(people.list(&admin, "limit=501", T0).await.unwrap_err().code, "invalid");
        // pages of 2 walk every row once
        let all = people.list(&admin, "limit=500", T0).await.unwrap()["total"].as_u64().unwrap();
        let mut seen = Vec::new();
        let mut q = "limit=2".to_owned();
        loop {
            let out = people.list(&admin, &q, T0).await.unwrap();
            seen.extend(out["rows"].as_array().unwrap().iter().map(|r| format!("{}{}{}", r["kind"], r["relay"], r["id"])));
            match out["next"].as_str() {
                Some(c) => q = format!("limit=2&after={c}"),
                None => break,
            }
        }
        assert_eq!(seen.len() as u64, all);
        assert_eq!(seen.iter().collect::<HashSet<_>>().len(), seen.len());
    }

    #[tokio::test]
    async fn the_cache_expires_and_concurrent_fetches_coalesce() {
        let (fake, people, admin) = setup();
        *fake.delay_ms.lock() = 30;
        let (a, b) = tokio::join!(people.relay_rows(&admin, "m1", T0), people.relay_rows(&admin, "m1", T0));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2, "one meet/people and one meet/seats for both");
        people.relay_rows(&admin, "m1", T0 + CACHE_MS - 1).await.unwrap();
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2, "a hit");
        people.relay_rows(&admin, "m1", T0 + CACHE_MS).await.unwrap();
        assert_eq!(fake.reads.load(Ordering::SeqCst), 4, "expired after 5 minutes");
    }

    #[tokio::test]
    async fn a_hit_after_narrowing_leaving_removal_or_lost_role_returns_nothing() {
        let (fake, people, admin) = setup();
        // narrowing people
        people.relay_rows(&admin, "m1", T0).await.unwrap();
        {
            let mut r = fake.relays.lock();
            r[0].scopes = vec!["read-health".into()];
            r[0].scope_generation = 2;
        }
        assert_eq!(people.relay_rows(&admin, "m1", T0 + 1).await.unwrap_err(), "scope");
        assert_eq!(people.cached_rows(), 0);
        // the same generation but the people scope gone (a hit must still re-check)
        fake.relays.lock()[0] = view("m1", Product::Meet);
        people.relay_rows(&admin, "m1", T0 + 2).await.unwrap();
        fake.relays.lock()[0].scopes.retain(|s| s != "people");
        assert!(people.relay_rows(&admin, "m1", T0 + 3).await.is_err());
        // leaving / removal: gone from the registry, or a state change
        fake.relays.lock()[0] = view("m1", Product::Meet);
        people.relay_rows(&admin, "m1", T0 + 4).await.unwrap();
        fake.relays.lock()[0].state = "removed".into();
        people.observe();
        assert_eq!(people.cached_rows(), 0);
        fake.relays.lock()[0] = view("m1", Product::Meet);
        people.relay_rows(&admin, "m1", T0 + 5).await.unwrap();
        fake.relays.lock().remove(0);
        assert_eq!(people.relay_rows(&admin, "m1", T0 + 6).await.unwrap_err(), "removed");
        assert_eq!(people.cached_rows(), 0);
        // the asking person losing the manager role
        fake.relays.lock().insert(0, view("m1", Product::Meet));
        people.relay_rows(&admin, "m1", T0 + 7).await.unwrap();
        fake.rights.lock().insert("sid-a".into(), Rights::Viewer);
        assert_eq!(people.relay_rows(&admin, "m1", T0 + 8).await.unwrap_err(), "role");
        assert_eq!(people.list(&admin, "", T0 + 8).await.unwrap_err().code, "role");
        // roster or policy change wipes everything
        fake.rights.lock().insert("sid-a".into(), Rights::Admin);
        people.relay_rows(&admin, "m1", T0 + 9).await.unwrap();
        people.wipe_all();
        assert_eq!(people.cached_rows(), 0);
    }

    #[test]
    fn global_bounds_evict_the_least_recently_used_relay() {
        let mut c = Cache::default();
        let key = Key { generation: 1, state: "active".into(), profile: "standard".into() };
        let big = |relay: &str, rows: usize| Arc::new(Fetched { relay: relay.into(), rows: vec![Value::Null; rows], seats: Value::Null, items: HashMap::new(), as_of: T0, bytes: 10 });
        c.put(key.clone(), big("a", 100_000), T0);
        c.put(key.clone(), big("b", 90_000), T0);
        assert!(c.get("a", &key, T0).is_some());
        c.put(key.clone(), big("c", 50_000), T0);
        assert!(c.entries.contains_key("a") && c.entries.contains_key("c") && !c.entries.contains_key("b"));
        assert!(c.rows <= CACHE_ROWS);
        let fat = Arc::new(Fetched { relay: "d".into(), rows: vec![], seats: Value::Null, items: HashMap::new(), as_of: T0, bytes: CACHE_BYTES - 5 });
        c.put(key.clone(), fat, T0);
        assert!(c.bytes <= CACHE_BYTES && c.entries.contains_key("d"));
        assert_eq!(c.entries.len(), 1);
    }

    #[test]
    fn nothing_is_written_to_disk() {
        let src = include_str!("fleet_people.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for word in [concat!("std::", "fs"), concat!("write_", "private"), concat!("File", "::create"), concat!("OpenOptions", "")] {
            assert!(!code.contains(word), "{word}");
        }
    }

    #[tokio::test]
    async fn every_action_maps() {
        assert_eq!(
            ["invite", "resend", "cancel", "suspend", "unsuspend", "remove", "role"].map(console_route),
            [Some("admins/invite"), Some("invites/resend"), Some("invites/revoke"), Some("admins/suspend"), Some("admins/unsuspend"), Some("admins/remove"), Some("admins/role")]
        );
        let (fake, people, admin) = setup();
        // Meeting Hub invite: a meet.invite request, and the relay's admins who are console accounts are mailed
        let r = people.invite_meet(&admin, &json!({"relay": "m1", "email": "Zed@X.org", "name": "Zed", "days": 3}), json!({"a": 1})).await.unwrap();
        assert_eq!(r["mailed"], 1);
        let (_, frame) = fake.calls.lock().last().cloned().unwrap();
        assert_eq!((frame["method"].as_str(), frame["path"].as_str()), (Some("POST"), Some("requests/new")));
        assert_eq!(frame["body"], json!({"kind": "meet.invite", "target": {"name": "Zed", "email": "zed@x.org", "days": 3}}));
        assert_eq!(frame["auth"], json!({"a": 1}));
        let mail = fake.mails.lock().last().cloned().unwrap();
        assert_eq!((mail.0.as_str(), mail.1.as_str()), (MAIL_INVITE_WAITING, "ann@x.org"));
        // cancel and seat pick
        people.cancel_meet(&manager(), "m1", "q1", Value::Null).await.unwrap();
        assert_eq!(fake.calls.lock().last().unwrap().1["path"], "requests/cancel");
        people.seat_pick(&manager(), "m1", "bob@x.org", true, Value::Null).await.unwrap();
        assert_eq!(fake.calls.lock().last().unwrap().1["body"], json!({"principal": "bob@x.org", "pick": true}));
        // suspend a Meeting Hub member: every unblocked device, one op
        let r = people.act(&admin, "suspend", &json!({"kind": "meet", "relay": "m1", "id": "bob@x.org", "hours": 4, "reason": "lost"}), Value::Null, 1, T0).await;
        assert_eq!(r.unwrap_err().code, "stale", "bob's only device is already blocked");
        people.act(&admin, "unsuspend", &json!({"kind": "meet", "relay": "m1", "id": "bob@x.org", "reason": "found"}), Value::Null, 1, T0).await.unwrap();
        let (_, op) = fake.ops.lock().last().cloned().unwrap();
        assert_eq!(op["params"]["devices"], json!([{"device": "bbbb"}]));
        assert_eq!((op["action"].as_str(), op["subject"].clone()), (Some("unsuspend"), json!({"principal": "bob@x.org"})));
        people.act(&admin, "remove", &json!({"kind": "meet", "relay": "m1", "id": "bob@x.org", "reason": "left"}), Value::Null, 1, T0).await.unwrap();
        assert_eq!(fake.ops.lock().last().unwrap().1["action"], "remove");
        // Remote Spokes: both hubs in one op
        people.act(&admin, "suspend", &json!({"kind": "spokes", "relay": "s1", "id": "dan@x.org", "hours": 2, "reason": "audit"}), Value::Null, 1, T0).await.unwrap();
        let (_, op) = fake.ops.lock().last().cloned().unwrap();
        assert_eq!(op["params"]["hubs"], json!([{"node": "n_1", "serial": "S1"}, {"node": "n_2", "serial": "S2"}]));
        assert_eq!(op["params"]["hours"], 2);
        // suspend, unsuspend and remove are admin only
        assert_eq!(people.act(&manager(), "suspend", &json!({"kind": "spokes", "relay": "s1", "id": "dan@x.org", "hours": 2, "reason": "x"}), Value::Null, 1, T0).await.unwrap_err().code, "role");
        assert_eq!(people.act(&admin, "suspend", &json!({"kind": "spokes", "relay": "s1", "id": "dan@x.org", "hours": 721, "reason": "x"}), Value::Null, 1, T0).await.unwrap_err().code, "invalid");
    }

    #[tokio::test]
    async fn one_step_up_for_a_multi_device_suspend_refused_whole_when_one_needs_a_second_admin() {
        let (fake, people, admin) = setup();
        let body = json!({"kind": "meet", "relay": "m1", "id": "ann@x.org", "hours": 1, "reason": "test"});
        // ann is a relay admin: with two-person on and one assertion nothing runs
        assert_eq!(people.act(&admin, "suspend", &body, Value::Null, 1, T0).await.unwrap_err().code, "fleet-second");
        assert!(fake.ops.lock().is_empty());
        // two assertions: one op covering both devices
        people.act(&admin, "suspend", &body, json!({"assertions": 2}), 2, T0).await.unwrap();
        let ops = fake.ops.lock();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].1["params"]["devices"], json!([{"device": "aaaa"}, {"device": "aaab"}]));
        let (_, binding) = people_frame(Product::Meet, "m1", "ann@x.org", "suspend", Some(1), "test", &op_items("suspend", &[Item { id: "aaaa".into(), serial: "A1".into(), blocked: false, revoked: false }]), Value::Null);
        assert_eq!(binding["action"], "people.suspend");
        assert_eq!(binding["target"], "ann@x.org");
        assert_eq!(binding["params"], json!({"relay": "m1", "hours": 1, "reason": "test", "devices": [{"device": "aaaa"}]}));
    }

    fn csv_of(rows: &[&str]) -> String {
        let mut s = "email,name,product,role,relay,days\r\n".to_owned();
        for r in rows {
            s.push_str(r);
            s.push_str("\r\n");
        }
        s
    }

    #[test]
    fn csv_header_variants_and_quoting() {
        let (at, rows) = read_csv("days,relay,role,product,name,email\n7,m1,member,meet,\"Bob, \"\"B\"\"\",bob@x.org\n").unwrap();
        assert_eq!(rows[0][at[1]], "Bob, \"B\"");
        assert_eq!(rows[0][at[0]], "bob@x.org");
        // quoted newline kept, BOM accepted, no final newline
        let (at, rows) = read_csv("\u{feff}email,name,product,role,relay,days\r\na@x.org,\"two\nlines\",console,viewer,,").unwrap();
        assert_eq!(rows[0][at[1]], "two\nlines");
        for bad in ["email,name,product,role,relay\n", "email,name,product,role,relay,days,extra\n", "email,email,product,role,relay,days\n", "Email,name,product,role,relay,days\n", "", "email,name,product,role,relay,days\na,b\n", "email,name,product,role,relay,days\na\"b,c,d,e,f,g\n", "email,name,product,role,relay,days\n\"a,b,c,d,e,f\n"] {
            assert_eq!(read_csv(bad).unwrap_err().code, "csv-invalid", "{bad:?}");
        }
    }

    #[test]
    fn csv_row_and_size_limits() {
        let row = "a@x.org,A,console,viewer,,";
        assert_eq!(read_csv(&csv_of(&vec![row; 500])).unwrap().1.len(), 500);
        assert_eq!(read_csv(&csv_of(&vec![row; 501])).unwrap_err().code, "csv-limit");
        let mut big = csv_of(&[]);
        big.push_str(&"x".repeat(CSV_BYTES + 1 - big.len()));
        assert_eq!(read_csv(&big).unwrap_err().code, "csv-limit");
        // a 256 KiB CSV in a request under 1 MiB is accepted; 257 KiB is refused
        let ok = "a".repeat(CSV_BYTES);
        let req = serde_json::to_vec(&json!({"csv": ok})).unwrap();
        assert!(req.len() < CHECK_BODY_MAX);
        assert_eq!(check_body(&req).unwrap().len(), CSV_BYTES);
        let req = serde_json::to_vec(&json!({"csv": "a".repeat(257 * 1024)})).unwrap();
        assert_eq!(check_body(&req).unwrap_err().code, "csv-limit");
        assert_eq!(check_body(&vec![b' '; CHECK_BODY_MAX + 1]).unwrap_err().code, "too-large");
        assert_eq!(check_body(br#"{"csv":"","x":1}"#).unwrap_err().code, "unknown-field");
    }

    fn status_of(out: &Value, line: usize) -> String {
        out["rows"].as_array().unwrap().iter().find(|r| r["line"] == line).map(|r| s(r, "status")).unwrap()
    }

    #[tokio::test]
    async fn csv_check_problem_codes() {
        let (fake, people, admin) = setup();
        let mut stopped = view("m2", Product::Meet);
        stopped.service_stopped = true;
        let mut noscope = view("m3", Product::Meet);
        noscope.scopes = vec!["read-health".into()];
        let mut full = view("m4", Product::Meet);
        full.waiting_requests = 199;
        fake.relays.lock().extend([stopped, noscope, full]);
        fake.console.lock().insert("old@x.org".into());
        let csv = csv_of(&[
            "ok@x.org,Ok,console,viewer,,",           // 2 ok
            "not an email,X,console,viewer,,",        // 3 csv-email
            "r@x.org,R,console,owner,,",              // 4 csv-role
            "n@x.org,N,meet,member,nowhere,7",        // 5 csv-relay
            "old@x.org,Old,console,viewer,,",         // 6 exists (console)
            "bob@x.org,Bob,meet,member,m1,7",         // 7 exists (relay)
            "c@x.org,C,meet,member,Relay m2,",        // 8 license-inactive (by exact name)
            "s@x.org,S,meet,member,m3,7",             // 9 scope
            "f1@x.org,F1,meet,member,m4,7",           // 10 ok (199 + 1)
            "f2@x.org,F2,meet,member,m4,7",           // 11 request-limit
            "d@x.org,D,meet,member,m1,31",            // 12 csv-invalid (days)
            "e@x.org,=HYPERLINK(1),meet,member,m1,",  // 13 ok, shown as text
            "ok@x.org,Ok,console,viewer,,",           // 14 exists (twice in the file)
        ]);
        let out = people.import_check(&admin, csv, T0).await.unwrap();
        let want = [(2, "ok"), (3, "csv-email"), (4, "csv-role"), (5, "csv-relay"), (6, "exists"), (7, "exists"), (8, "license-inactive"), (9, "scope"), (10, "ok"), (11, "request-limit"), (12, "csv-invalid"), (13, "ok"), (14, "exists")];
        for (line, code) in want {
            assert_eq!(status_of(&out, line), code, "line {line}");
        }
        for code in ROW_PROBLEMS {
            assert!(code == "csv-invalid" || want.iter().any(|(_, c)| *c == code), "{code}");
        }
        // a name beginning with `=` comes back as the same text, never evaluated or altered
        let row = out["rows"].as_array().unwrap().iter().find(|r| r["line"] == 13).unwrap();
        assert_eq!(row["name"], "=HYPERLINK(1)");
        assert_eq!(out["relays"], json!(["m1", "m4"]));
        assert_eq!(out["digest"].as_str().unwrap().len(), 64);
    }

    #[tokio::test]
    async fn user_managers_cannot_import_admin_rows() {
        let (fake, people, _admin) = setup();
        let out = people.import_check(&manager(), csv_of(&["a@x.org,A,console,admin,,", "b@x.org,B,console,user-manager,,"]), T0).await.unwrap();
        assert_eq!((status_of(&out, 2).as_str(), status_of(&out, 3).as_str()), ("csv-role", "ok"));
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        let done = people.import(&manager(), &body, Value::Null, T0 + 1).await.unwrap();
        assert_eq!(done["done"].as_array().unwrap().len(), 1);
        assert_eq!(*fake.invited.lock(), vec![("b@x.org".to_owned(), "user-manager".to_owned())]);
    }

    #[tokio::test]
    async fn import_id_is_bound_to_session_time_digest_and_once() {
        let (fake, people, admin) = setup();
        async fn check(p: &People, a: Asker, t: i64) -> Value {
            p.import_check(&a, csv_of(&["z@x.org,Zed,meet,member,m1,", "y@x.org,Y,console,viewer,,"]), t).await.unwrap()
        }
        // from another session
        let out = check(&people, admin.clone(), T0).await;
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        assert_eq!(people.import(&manager(), &body, Value::Null, T0).await.unwrap_err().code, "csv-changed");
        assert_eq!(people.import(&admin, &body, Value::Null, T0).await.unwrap_err().code, "csv-changed", "consumed by the foreign try");
        // after 10 minutes
        let out = check(&people, admin.clone(), T0).await;
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        assert_eq!(people.import(&admin, &body, Value::Null, T0 + IMPORT_MS).await.unwrap_err().code, "csv-changed");
        // another digest
        let out = check(&people, admin.clone(), T0).await;
        let body = json!({"importId": out["importId"], "digest": "00".repeat(32)});
        assert_eq!(people.import(&admin, &body, Value::Null, T0).await.unwrap_err().code, "csv-changed");
        // once
        let out = check(&people, admin.clone(), T0).await;
        let binding = people.import_binding("sid-a", out["importId"].as_str().unwrap()).unwrap();
        assert_eq!(binding["params"], json!({"importId": out["importId"], "digest": out["digest"]}));
        assert_eq!(binding["targets"], json!(["m1"]));
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        let done = people.import(&admin, &body, Value::Null, T0 + 1).await.unwrap();
        assert_eq!((done["done"].as_array().unwrap().len(), done["refused"].as_array().unwrap().len()), (2, 0));
        assert_eq!(people.import(&admin, &body, Value::Null, T0 + 2).await.unwrap_err().code, "csv-changed");
        // a digest change between check and import: the stored rows are what the digest names
        let out = check(&people, admin.clone(), T0).await;
        let other = people.import_check(&admin, csv_of(&["q@x.org,Q,console,viewer,,"]), T0).await.unwrap();
        assert_ne!(out["digest"], other["digest"]);
        let body = json!({"importId": out["importId"], "digest": other["digest"]});
        assert_eq!(people.import(&admin, &body, Value::Null, T0).await.unwrap_err().code, "csv-changed");
        let _ = fake;
    }

    #[tokio::test]
    async fn the_store_keeps_two_per_session_and_never_the_raw_csv() {
        let (_fake, people, admin) = setup();
        let ids: Vec<String> = {
            let mut v = Vec::new();
            for i in 0..3 {
                let out = people.import_check(&admin, csv_of(&[&format!("u{i}@x.org,U,console,viewer,,")]), T0).await.unwrap();
                v.push(out["importId"].as_str().unwrap().to_owned());
            }
            v
        };
        let im = people.imports.lock();
        assert_eq!(im.list.len(), 2);
        assert!(!im.list.iter().any(|c| c.id == ids[0]), "the oldest of the session went");
        // only canonical rows are kept: no header, no raw line
        for c in &im.list {
            for r in &c.rows {
                let keys: Vec<&String> = r.as_object().unwrap().keys().collect();
                assert_eq!(keys.len(), 6);
            }
            let text = serde_json::to_string(&c.rows).unwrap();
            assert!(!text.contains("email,name"));
        }
        drop(im);
        let mut im = Imports::default();
        for i in 0..25 {
            im.keep(Check { id: i.to_string(), session: format!("s{i}"), rights: Rights::Admin, digest: String::new(), relays: vec![], rows: vec![], expires: T0 + IMPORT_MS, bytes: 1, made: 0 }, T0);
        }
        assert_eq!(im.list.len(), IMPORTS_ALL);
        im.keep(Check { id: "big".into(), session: "x".into(), rights: Rights::Admin, digest: String::new(), relays: vec![], rows: vec![], expires: T0 + IMPORT_MS, bytes: IMPORT_BYTES - 5, made: 0 }, T0);
        assert!(im.bytes() <= IMPORT_BYTES);
    }

    #[tokio::test]
    async fn import_counts_toward_the_relay_caps_and_rechecks_at_execution() {
        let (fake, people, admin) = setup();
        fake.relays.lock()[0].waiting_requests = 197;
        let out = people.import_check(&admin, csv_of(&["a@x.org,A,meet,member,m1,", "b2@x.org,B,meet,member,m1,", "c@x.org,C,meet,member,m1,", "d@x.org,D,meet,member,m1,"]), T0).await.unwrap();
        assert_eq!([2, 3, 4, 5].map(|l| status_of(&out, l)), ["ok", "ok", "ok", "request-limit"].map(String::from));
        // one more waiting request appeared since the check: the third accepted row is refused at execution
        fake.relays.lock()[0].waiting_requests = 198;
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        let done = people.import(&admin, &body, Value::Null, T0 + 1).await.unwrap();
        assert_eq!(done["done"].as_array().unwrap().len(), 2);
        assert_eq!(done["refused"][0]["code"], "request-limit");
        // the relay's service stopped for its license since the check (3.4): re-checked at execution, license-inactive
        fake.relays.lock()[0].waiting_requests = 0;
        let out = people.import_check(&admin, csv_of(&["k@x.org,K,meet,member,m1,"]), T0).await.unwrap();
        fake.relays.lock()[0].service_stopped = true;
        let body = json!({"importId": out["importId"], "digest": out["digest"]});
        assert_eq!(people.import(&admin, &body, Value::Null, T0 + 1).await.unwrap()["refused"][0]["code"], "license-inactive");
        // and a stopped relay's invite is refused before any frame
        assert_eq!(people.invite_meet(&admin, &json!({"relay": "m1", "email": "k@x.org", "name": "K"}), Value::Null).await.unwrap_err().code, "license-inactive");
        // the relay's own refusal comes back with its code
        fake.relays.lock()[0].service_stopped = false;
        *fake.refuse_new.lock() = Some((409, json!({"ok": false, "code": "request-exists", "message": "This request is already waiting."})));
        assert_eq!(people.invite_meet(&admin, &json!({"relay": "m1", "email": "k@x.org", "name": "K"}), Value::Null).await.unwrap_err().code, "request-exists");
    }

    #[tokio::test]
    async fn reminders_once_per_request_per_day() {
        let (fake, people, _admin) = setup();
        let body = json!({"relay": "m1", "request": "q1"});
        let r = people.remind(&manager(), &body, T0).await.unwrap();
        assert_eq!(r["mailed"], 1);
        let mail = fake.mails.lock().last().cloned().unwrap();
        assert_eq!(mail.2, vec![("requester".to_owned(), "mia@x.org".to_owned()), ("email".to_owned(), "zed@x.org".to_owned()), ("relay".to_owned(), "Relay m1".to_owned())]);
        assert_eq!(people.remind(&manager(), &body, T0 + REMIND_MS - 1).await.unwrap_err().code, "rate");
        assert!(people.remind(&manager(), &body, T0 + REMIND_MS).await.is_ok());
        assert_eq!(people.remind(&manager(), &json!({"relay": "m1", "request": "nope"}), T0).await.unwrap_err().code, "gone");
        *fake.mail_on.lock() = false;
        assert_eq!(people.remind(&manager(), &json!({"relay": "m1", "request": "q2"}), T0).await.unwrap_err().code, "mail-off");
    }

    #[test]
    fn words_carry_no_long_dashes() {
        for w in [CSV_INVALID, CSV_LIMIT, CSV_CHANGED, REQUEST_LIMIT, FLEET_SECOND] {
            assert!(!w.contains('\u{2014}') && !w.contains('\u{2013}'));
        }
    }

    #[test]
    fn non_dumpable_runs() {
        assert!(make_non_dumpable().is_ok());
    }
}
