// The relay's control panel (ADR-A094; core ADR-0534, decision D3): an admin web app under /console/ on the relay's
// own port, OFF unless `--console 1` or LUCID_RELAY_CONSOLE=1, its admins and passkeys in `console.json` in the state
// folder. The flow is the Meeting Hub console's (console/meet_console_web.py): a one-time invite link (here minted by a
// hub with the drive scope through the signed op POST /v1/console/invite, for the user its certificate names, good
// once and for 24 hours), a passkey registered from it (WebAuthn ES256, user verification required), a server-side
// session in the cookie `__Host-lrc` (12 h idle, 7 days at most), every POST with this console's Origin and the header
// `X-Lucid-Console: 1`, and sign-in attempts limited per source address. Admin actions go to the security log.
//
// It shows, read-only: relay health, license, seats, nodes seen, CRL and directory versions (State::console_status),
// the relay's own recent log lines (a ring fed by the logger's tap, newest first, by category and level, downloadable
// as JSONL) and spoke log lines (POST /v1/logs, a signed spoke op, kept in a ring per node). Never message contents.

use crate::codec::{b64u, exact_keys, is_int, js_trim, num_is, parse_json, sha256_hex, str_of, stringify, unb64u};
use crate::console_page::{APP_CSS, APP_JS, INDEX_HTML};
use crate::console_webauthn::{credential_id, verify_assertion, verify_registration, Refusal};
use crate::identity::is_node_id;
use crate::log::{secret_field, Fields, Level, Logger, Tap};
use crate::relay::Dialed;
use crate::store::{read_text, write_private};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const CONSOLE_FILE: &str = "console.json";
/// What /v1/logs and /v1/console/invite answer (409) on a relay whose control panel is off.
pub const CONSOLE_OFF: &str = "the control panel is turned off on this relay (start it with --console 1 or LUCID_RELAY_CONSOLE=1)";
/// The header every console POST carries (with the console's Origin).
pub const MARKER_HEADER: &str = "x-lucid-console";
const COOKIE: &str = "__Host-lrc";
pub const INVITE_MS: i64 = 24 * 3_600_000;
const INVITES_MAX: usize = 50;
const SESSION_IDLE_MS: i64 = 12 * 3_600_000;
const SESSION_MAX_MS: i64 = 7 * 24 * 3_600_000;
const SESSIONS_MAX: usize = 200;
const CEREMONY_MS: i64 = 300_000;
const CEREMONIES_MAX: usize = 1000;
pub const SIGNIN_LIMIT: usize = 30;
pub const SIGNIN_WINDOW_MS: i64 = 600_000;
const SOURCES_MAX: usize = 10_000;
pub const PASSKEYS_MAX: usize = 10;
const LABEL_MAX: usize = 40;
const BODY_MAX: usize = 64 * 1024;
/// The relay's own lines kept for the panel, and the longest one kept.
pub const RELAY_LINES: usize = 2000;
const RELAY_LINE_BYTES: usize = 16 * 1024;
/// Spoke lines: per node, nodes, and bytes across all nodes.
pub const SPOKE_LINES: usize = 500;
pub const SPOKE_NODES: usize = 1000;
pub const SPOKE_BYTES: usize = 32 * 1024 * 1024;
/// POST /v1/logs (src/console-logs.ts states the same): a line, lines a post, a post, posts a minute per node.
pub const LOG_LINE_BYTES: usize = 2048;
pub const LOG_POST_LINES: usize = 100;
pub const LOG_POST_BYTES: usize = 64 * 1024;
pub const LOG_POSTS_PER_MINUTE: usize = 6;
const PAGE_LINES: usize = 500;
/// Refusals counted for "quotas hit" (seen through the log tap).
const QUOTA_EVENTS: [&str; 6] = ["send.rate-limited", "send.quota", "mailbox.full", "store.full", "user.refused", "logs.rate-limited"];
const GONE: &str = "This invite link has expired or was already used. Ask for a new one from the IDE (Relay, Control panel).";
const NO_ADMIN: &str = "This control panel has no admin yet: ask for an invite from the IDE (Relay, Control panel).";
const SECURITY_HEADERS: [(&str, &str); 8] = [
    ("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Strict-Transport-Security", "max-age=31536000"),
];

fn level_of(s: &str) -> Option<Level> {
    match s {
        "debug" => Some(Level::Debug),
        "info" => Some(Level::Info),
        "warn" => Some(Level::Warn),
        "error" => Some(Level::Error),
        _ => None,
    }
}

fn random(n: usize) -> Option<Vec<u8>> {
    use aws_lc_rs::rand::{SecureRandom, SystemRandom};
    let mut b = vec![0u8; n];
    SystemRandom::new().fill(&mut b).ok()?;
    Some(b)
}

// ── Log rings ───────────────────────────────────────────────────────────────────────────────────────────────

struct Line {
    cat: String,
    level: Level,
    json: String,
}

/// Which lines a reader wants: one category or all, and the lowest level.
pub struct Filter {
    pub cat: Option<String>,
    pub min: Level,
}

impl Filter {
    fn keeps(&self, l: &Line) -> bool {
        l.level >= self.min && self.cat.as_ref().is_none_or(|c| *c == l.cat)
    }
}

#[derive(Default)]
struct RingInner {
    lines: VecDeque<Line>,
    hits: IndexMap<String, u64>,
}

/// The relay's own recent log lines, fed by the logger's tap: the newest RELAY_LINES, and the quota refusals counted.
#[derive(Default)]
pub struct LineRing(Mutex<RingInner>);

impl LineRing {
    /// The tap to hand the logger (Logger::with_tap).
    pub fn tap(self: &Arc<Self>) -> Tap {
        let ring = self.clone();
        Arc::new(move |cat: &str, level: Level, event: &str, json: &str| ring.push(cat, level, event, json))
    }

    fn push(&self, cat: &str, level: Level, event: &str, json: &str) {
        let mut r = self.0.lock();
        if QUOTA_EVENTS.contains(&event) {
            *r.hits.entry(event.to_owned()).or_insert(0) += 1;
        }
        if json.len() > RELAY_LINE_BYTES {
            return;
        }
        if r.lines.len() >= RELAY_LINES {
            r.lines.pop_front();
        }
        r.lines.push_back(Line { cat: cat.to_owned(), level, json: json.to_owned() });
    }

    /// The matching lines as written, newest first.
    pub fn lines(&self, f: &Filter) -> Vec<String> {
        self.0.lock().lines.iter().rev().filter(|l| f.keeps(l)).map(|l| l.json.clone()).collect()
    }

    fn hits(&self) -> Value {
        let r = self.0.lock();
        Value::Object(r.hits.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect())
    }
}

#[derive(Default)]
struct SpokeRing {
    lines: VecDeque<Line>,
    bytes: usize,
    last: i64,
}

#[derive(Default)]
struct SpokeLogs {
    /// Least recently posting first.
    nodes: IndexMap<String, SpokeRing>,
    posts: HashMap<String, VecDeque<i64>>,
    bytes: usize,
}

/// Why a signed op was refused: the status, the error the caller sees, the security event.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused {
    pub status: u16,
    pub error: String,
    pub event: &'static str,
}

fn refused(status: u16, error: impl Into<String>, event: &'static str) -> Refused {
    Refused { status, error: error.into(), event }
}

/// The lines of one POST /v1/logs body, checked: `{"lines":[...]}`, 1 to 100 objects, each at most 2048 bytes as
/// JSON, security or ops, with a level and an event; secret-looking fields dropped.
fn parse_log_post(body: &str) -> Result<Vec<Line>, &'static str> {
    const MALFORMED: &str = "malformed log lines: {\"lines\":[...]} of objects with cat, level and event";
    if body.len() > LOG_POST_BYTES {
        return Err("a post carries at most 64 KiB of log lines");
    }
    let parsed = parse_json(body).ok_or(MALFORMED)?;
    let o = parsed.as_object().filter(|o| exact_keys(o, &["lines"], &["lines"])).ok_or(MALFORMED)?;
    let list = o.get("lines").and_then(Value::as_array).ok_or(MALFORMED)?;
    if list.is_empty() || list.len() > LOG_POST_LINES {
        return Err("a post carries 1 to 100 log lines");
    }
    let mut out = Vec::with_capacity(list.len());
    for v in list {
        let mut line = v.as_object().ok_or(MALFORMED)?.clone();
        if stringify(v).len() > LOG_LINE_BYTES {
            return Err("a log line is at most 2048 bytes");
        }
        let cat = str_of(line.get("cat")).ok_or(MALFORMED)?.to_owned();
        if cat != "security" && cat != "ops" {
            return Err("only security and ops log lines are taken");
        }
        let level = str_of(line.get("level")).and_then(level_of).ok_or(MALFORMED)?;
        if !str_of(line.get("event")).is_some_and(|e| (1..=120).contains(&e.len())) {
            return Err(MALFORMED);
        }
        line.retain(|k, _| !secret_field(k));
        out.push(Line { cat, level, json: stringify(&Value::Object(line)) });
    }
    Ok(out)
}

impl SpokeLogs {
    fn take(&mut self, node: &str, body: &str, t: i64) -> Result<usize, Refused> {
        // Every post counts against the rate, a refused one too.
        self.posts.retain(|_, p| p.back().is_some_and(|at| t - *at < 60_000));
        let posts = self.posts.entry(node.to_owned()).or_default();
        while posts.front().is_some_and(|at| t - *at >= 60_000) {
            posts.pop_front();
        }
        if posts.len() >= LOG_POSTS_PER_MINUTE {
            return Err(refused(429, "rate limited: at most 6 log posts a minute", "logs.rate-limited"));
        }
        posts.push_back(t);
        let lines = parse_log_post(body).map_err(|e| refused(400, e, "logs.malformed"))?;
        let n = lines.len();
        let mut ring = self.nodes.shift_remove(node).unwrap_or_default();
        for l in lines {
            if ring.lines.len() >= SPOKE_LINES {
                if let Some(old) = ring.lines.pop_front() {
                    ring.bytes -= old.json.len();
                    self.bytes -= old.json.len();
                }
            }
            ring.bytes += l.json.len();
            self.bytes += l.json.len();
            ring.lines.push_back(l);
        }
        ring.last = t;
        self.nodes.insert(node.to_owned(), ring);
        // Over the bounds: the spoke that posted least recently goes first (one node alone stays within its ring).
        while self.nodes.len() > 1 && (self.nodes.len() > SPOKE_NODES || self.bytes > SPOKE_BYTES) {
            if let Some((_, gone)) = self.nodes.shift_remove_index(0) {
                self.bytes -= gone.bytes;
            }
        }
        Ok(n)
    }

    fn lines(&self, node: &str, f: &Filter) -> Vec<String> {
        self.nodes.get(node).map(|r| r.lines.iter().rev().filter(|l| f.keeps(l)).map(|l| l.json.clone()).collect()).unwrap_or_default()
    }
}

// ── The book: console.json ──────────────────────────────────────────────────────────────────────────────────

struct Invite {
    email: String,
    expires: i64,
    by: String,
}

struct Passkey {
    id: String,
    cose: String,
    count: u32,
    label: String,
    created: i64,
    last_used: i64,
}

struct Admin {
    handle: String,
    created: i64,
    last_sign_in: i64,
    passkeys: Vec<Passkey>,
}

/// What console.json keeps: the origin the first invite fixed, open invites by the SHA-256 of their token, and the
/// admins by email with their passkeys.
#[derive(Default)]
struct Book {
    origin: Option<String>,
    invites: IndexMap<String, Invite>,
    admins: IndexMap<String, Admin>,
}

impl Book {
    fn read(file: &Path) -> Result<Book, String> {
        let mut book = Book::default();
        let Some(raw) = read_text(file) else { return Ok(book) };
        let broken = || format!("{} is not a control panel book: fix it, or remove it and invite the admins again", file.display());
        let parsed = parse_json(&raw).ok_or_else(broken)?;
        let o = parsed.as_object().filter(|o| exact_keys(o, &["v", "origin", "invites", "admins"], &["v", "invites", "admins"]) && num_is(o.get("v"), 1.0)).ok_or_else(broken)?;
        book.origin = match o.get("origin") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_str().filter(|s| s.starts_with("https://")).ok_or_else(broken)?.to_owned()),
        };
        for (hash, v) in o.get("invites").and_then(Value::as_object).ok_or_else(broken)? {
            let i = v.as_object().ok_or_else(broken)?;
            let (Some(email), Some(expires), Some(by)) = (str_of(i.get("email")), is_int(i.get("expires")), str_of(i.get("by"))) else { return Err(broken()) };
            book.invites.insert(hash.clone(), Invite { email: email.into(), expires, by: by.into() });
        }
        for (email, v) in o.get("admins").and_then(Value::as_object).ok_or_else(broken)? {
            let a = v.as_object().ok_or_else(broken)?;
            let (Some(handle), Some(created), Some(last_sign_in)) = (str_of(a.get("handle")), is_int(a.get("created")), is_int(a.get("lastSignIn"))) else { return Err(broken()) };
            let mut passkeys = Vec::new();
            for p in a.get("passkeys").and_then(Value::as_array).ok_or_else(broken)? {
                let p = p.as_object().ok_or_else(broken)?;
                let (Some(id), Some(cose), Some(label)) = (str_of(p.get("id")), str_of(p.get("cose")), str_of(p.get("label"))) else { return Err(broken()) };
                let (Some(count), Some(created), Some(last_used)) = (is_int(p.get("count")), is_int(p.get("created")), is_int(p.get("lastUsed"))) else { return Err(broken()) };
                let count = u32::try_from(count).map_err(|_| broken())?;
                passkeys.push(Passkey { id: id.into(), cose: cose.into(), count, label: label.into(), created, last_used });
            }
            book.admins.insert(email.clone(), Admin { handle: handle.into(), created, last_sign_in, passkeys });
        }
        Ok(book)
    }

    fn save(&self, file: &Path) -> Result<(), String> {
        let invites: Map<String, Value> = self.invites.iter().map(|(h, i)| (h.clone(), json!({ "email": i.email, "expires": i.expires, "by": i.by }))).collect();
        let admins: Map<String, Value> = self
            .admins
            .iter()
            .map(|(e, a)| {
                let keys: Vec<Value> = a.passkeys.iter().map(|p| json!({ "id": p.id, "cose": p.cose, "count": p.count, "label": p.label, "created": p.created, "lastUsed": p.last_used })).collect();
                (e.clone(), json!({ "handle": a.handle, "created": a.created, "lastSignIn": a.last_sign_in, "passkeys": keys }))
            })
            .collect();
        let text = format!("{}\n", stringify(&json!({ "v": 1, "origin": self.origin, "invites": invites, "admins": admins })));
        write_private(file, text.as_bytes()).map_err(|e| e.to_string())
    }

    /// The open invite a token names, or 410.
    fn invite(&self, token: Option<&str>, t: i64) -> Result<(String, &Invite), ApiError> {
        let gone = || api_err(410, GONE);
        let token = token.filter(|s| s.len() == 43 && unb64u(s).is_some()).ok_or_else(gone)?;
        let hash = sha256_hex(token.as_bytes());
        let i = self.invites.get(&hash).filter(|i| i.expires > t).ok_or_else(gone)?;
        Ok((hash, i))
    }

    /// The admin and passkey with this credential id: (email, COSE key, sign count, user handle).
    fn find(&self, id: &str) -> Option<(String, String, u32, String)> {
        self.admins.iter().find_map(|(e, a)| a.passkeys.iter().find(|p| p.id == id).map(|p| (e.clone(), p.cose.clone(), p.count, a.handle.clone())))
    }

    fn admin_view(&self, email: &str) -> Value {
        let Some(a) = self.admins.get(email) else { return Value::Null };
        let keys: Vec<Value> = a.passkeys.iter().map(|p| json!({ "label": p.label, "created": p.created, "lastUsed": p.last_used })).collect();
        json!({ "email": email, "lastSignIn": a.last_sign_in, "passkeys": keys })
    }
}

// ── Sessions, ceremonies, the sign-in limit ─────────────────────────────────────────────────────────────────

struct ApiError {
    status: u16,
    message: String,
    retry_after: Option<i64>,
}

fn api_err(status: u16, message: impl Into<String>) -> ApiError {
    ApiError { status, message: message.into(), retry_after: None }
}

impl From<Refusal> for ApiError {
    fn from(r: Refusal) -> ApiError {
        api_err(r.status, r.message)
    }
}

fn random_token(n: usize) -> Result<String, ApiError> {
    random(n).map(|b| b64u(&b)).ok_or_else(|| api_err(500, "The control panel could not draw random bytes; see the relay's log."))
}

struct Session {
    email: String,
    created: i64,
    last: i64,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    Register,
    Login,
}

struct Ceremony {
    kind: Kind,
    challenge: Vec<u8>,
    expires: i64,
    email: String,
    invite: String,
    handle: String,
    allow: Vec<String>,
}

#[derive(Default)]
struct Inner {
    book: Book,
    sessions: HashMap<String, Session>,
    ceremonies: IndexMap<String, Ceremony>,
    attempts: HashMap<String, VecDeque<i64>>,
}

impl Inner {
    /// One sign-in attempt from `ip`: at most SIGNIN_LIMIT in SIGNIN_WINDOW_MS, else 429 with the wait.
    fn limit(&mut self, ip: &str, t: i64) -> Result<(), ApiError> {
        if self.attempts.len() >= SOURCES_MAX {
            self.attempts.retain(|_, v| v.back().is_some_and(|at| t - *at < SIGNIN_WINDOW_MS));
            if self.attempts.len() >= SOURCES_MAX {
                self.attempts.clear();
            }
        }
        let v = self.attempts.entry(ip.to_owned()).or_default();
        while v.front().is_some_and(|at| t - *at >= SIGNIN_WINDOW_MS) {
            v.pop_front();
        }
        if v.len() >= SIGNIN_LIMIT {
            let wait = (v.front().copied().unwrap_or(t) + SIGNIN_WINDOW_MS - t + 999) / 1000;
            return Err(ApiError { status: 429, message: "Too many sign-in attempts from this address; wait a few minutes.".into(), retry_after: Some(wait.max(1)) });
        }
        v.push_back(t);
        Ok(())
    }

    fn ceremony(&mut self, c: Ceremony, t: i64) -> Result<String, ApiError> {
        self.ceremonies.retain(|_, c| c.expires > t);
        while self.ceremonies.len() >= CEREMONIES_MAX {
            self.ceremonies.shift_remove_index(0);
        }
        let id = random_token(16)?;
        self.ceremonies.insert(id.clone(), c);
        Ok(id)
    }

    fn take(&mut self, id: Option<&str>, kind: Kind, t: i64) -> Result<Ceremony, ApiError> {
        let c = self.ceremonies.shift_remove(id.unwrap_or(""));
        c.filter(|c| c.kind == kind && c.expires > t).ok_or_else(|| api_err(400, "That sign-in request expired; try again."))
    }

    /// The signed-in admin's email, the session touched; a dead session (idle, too old, its admin gone) is dropped.
    fn session(&mut self, sid: &str, t: i64) -> Option<String> {
        if sid.is_empty() || sid.len() > 100 {
            return None;
        }
        let s = self.sessions.get_mut(sid)?;
        if t - s.last <= SESSION_IDLE_MS && t - s.created <= SESSION_MAX_MS && self.book.admins.contains_key(&s.email) {
            s.last = t;
            return Some(s.email.clone());
        }
        self.sessions.remove(sid);
        None
    }

    /// A new session for `email`; the Set-Cookie value.
    fn new_session(&mut self, email: &str, t: i64) -> Result<String, ApiError> {
        self.sessions.retain(|_, s| t - s.last <= SESSION_IDLE_MS && t - s.created <= SESSION_MAX_MS);
        while self.sessions.len() >= SESSIONS_MAX {
            let Some(oldest) = self.sessions.iter().min_by_key(|(_, s)| s.created).map(|(k, _)| k.clone()) else { break };
            self.sessions.remove(&oldest);
        }
        let sid = random_token(32)?;
        self.sessions.insert(sid.clone(), Session { email: email.to_owned(), created: t, last: t });
        Ok(format!("{COOKIE}={sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={}", SESSION_MAX_MS / 1000))
    }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────

/// A request under /console as server.rs hands it over.
pub struct ConsoleRequest<'a> {
    pub method: &'a str,
    pub pathname: &'a str,
    pub query: &'a str,
    pub cookie: &'a str,
    pub origin: Option<&'a str>,
    pub marker: Option<&'a str>,
    pub content_type: &'a str,
    pub ip: &'a str,
    pub body: &'a str,
    pub dialed: &'a Dialed,
    /// RS-RELAY-03's check: the relay's TLS certificate names the host dialed.
    pub host_ok: bool,
}

/// A finished console answer, every header included.
pub struct ConsoleReply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
    pub close: bool,
}

fn reply(status: u16, content_type: &'static str, body: Vec<u8>, cache: &str) -> ConsoleReply {
    let mut headers: Vec<(&'static str, String)> = SECURITY_HEADERS.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
    headers.push(("Cache-Control", cache.to_owned()));
    ConsoleReply { status, content_type, body, headers, close: false }
}

fn json_answer(status: u16, v: &Value) -> ConsoleReply {
    reply(status, "application/json; charset=utf-8", stringify(v).into_bytes(), "no-store")
}

fn fail(status: u16, message: &str) -> ConsoleReply {
    json_answer(status, &json!({ "ok": false, "error": message }))
}

fn closing(mut r: ConsoleReply) -> ConsoleReply {
    r.close = true;
    r
}

/// The origin a browser sees for the host a caller dialed (https, the port left out when it is 443 or was not
/// given); Err for an IP address, where passkeys do not work.
pub fn origin_of(d: &Dialed) -> Result<String, String> {
    let bare = d.hostname.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&d.hostname);
    if bare.parse::<IpAddr>().is_ok() || bare.is_empty() {
        return Err("the control panel needs the relay's DNS name: this relay was reached by an IP address, where passkeys do not work".into());
    }
    Ok(if d.host == d.hostname || d.port == 443 { format!("https://{}", d.hostname) } else { format!("https://{}", d.host) })
}

/// The WebAuthn relying party id of an origin: its host name.
fn rp_id_of(origin: &str) -> String {
    let host = origin.strip_prefix("https://").unwrap_or(origin);
    host.split(':').next().unwrap_or(host).to_owned()
}

fn cookie_of(header: &str) -> &str {
    header.split(';').filter_map(|p| p.trim().split_once('=')).find(|(n, _)| *n == COOKIE).map(|(_, v)| v.trim()).unwrap_or("")
}

fn label_of(v: Option<&Value>) -> String {
    let words = str_of(v).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let label: String = words.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect();
    if label.is_empty() { "Passkey".into() } else { label }
}

/// An invite just minted: the link, when it ends (ms) and the console's origin.
pub struct Invited {
    pub link: String,
    pub expires: i64,
    pub origin: String,
}

type Answer = Result<(Value, Option<String>), ApiError>;

/// The control panel: its book and sessions, the relay's log ring and the spokes' rings.
pub struct Console {
    file: PathBuf,
    logger: Arc<Logger>,
    ring: Arc<LineRing>,
    inner: Mutex<Inner>,
    spokes: Mutex<SpokeLogs>,
}

/// The control panel from `--console` or LUCID_RELAY_CONSOLE (`1` on, `0` or unset off): the logger, tapped for the
/// panel's ring when it is on, and the console. Err is why the relay does not start.
pub fn open(flag: Option<&String>, env: impl Fn(&str) -> Option<String>, state: Option<&str>, lan: bool, logger: Logger) -> Result<(Arc<Logger>, Option<Arc<Console>>), String> {
    let on = flag.filter(|v| !v.is_empty()).cloned().or_else(|| env("LUCID_RELAY_CONSOLE").filter(|v| !v.is_empty())).unwrap_or_else(|| "0".into());
    if on != "0" && on != "1" {
        return Err("the control panel is 1 (on) or 0 (off): --console or LUCID_RELAY_CONSOLE".into());
    }
    if on == "0" {
        return Ok((Arc::new(logger), None));
    }
    if lan {
        return Err("a LAN mailbox (--owner) serves no control panel: leave out --console and LUCID_RELAY_CONSOLE".into());
    }
    let Some(dir) = state.filter(|d| !d.is_empty()) else {
        return Err("the control panel keeps its admins and passkeys in the state folder: give --state or LUCID_RELAY_STATE".into());
    };
    let ring = Arc::new(LineRing::default());
    let logger = Arc::new(logger.with_tap(ring.tap()));
    let console = Console::load(Path::new(dir).join(CONSOLE_FILE), logger.clone(), ring)?;
    let (admins, origin) = {
        let inner = console.inner.lock();
        (inner.book.admins.len(), inner.book.origin.clone())
    };
    logger.ops("console.on", &Fields::new().with("admins", admins).with("origin", origin), Level::Info);
    Ok((logger, Some(Arc::new(console))))
}

impl Console {
    pub fn load(file: PathBuf, logger: Arc<Logger>, ring: Arc<LineRing>) -> Result<Console, String> {
        let book = Book::read(&file)?;
        Ok(Console { file, logger, ring, inner: Mutex::new(Inner { book, ..Inner::default() }), spokes: Mutex::new(SpokeLogs::default()) })
    }

    /// POST /v1/logs from an authenticated spoke: the number of lines kept, or why not.
    pub fn take_logs(&self, node: &str, body: &str, t: i64) -> Result<usize, Refused> {
        self.spokes.lock().take(node, body, t)
    }

    /// POST /v1/console/invite from a hub with the drive scope, for the user its certificate names. The first invite
    /// fixes the console's origin; a newer invite for the same email replaces the older one.
    pub fn invite(&self, email: &str, by: &str, dialed: &Dialed, t: i64) -> Result<Invited, Refused> {
        let origin = origin_of(dialed).map_err(|e| refused(409, e, "console.invite-refused"))?;
        let mut inner = self.inner.lock();
        if let Some(o) = inner.book.origin.as_ref().filter(|o| **o != origin) {
            let why = format!("this relay's control panel is at {o}: ask for the invite through that address (to move it, stop the relay and remove {CONSOLE_FILE} from its state folder)");
            return Err(refused(409, why, "console.invite-refused"));
        }
        let token = random(32).map(|b| b64u(&b)).ok_or_else(|| refused(500, "the control panel could not draw random bytes", "console.invite-failed"))?;
        let book = &mut inner.book;
        book.invites.retain(|_, i| i.expires > t && i.email != email);
        while book.invites.len() >= INVITES_MAX {
            book.invites.shift_remove_index(0);
        }
        let expires = t + INVITE_MS;
        book.invites.insert(sha256_hex(token.as_bytes()), Invite { email: email.to_owned(), expires, by: by.to_owned() });
        book.origin = Some(origin.clone());
        if let Err(e) = book.save(&self.file) {
            self.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
            return Err(refused(500, "the control panel could not save its state", "console.invite-failed"));
        }
        Ok(Invited { link: format!("{origin}/console/#join={token}"), expires, origin })
    }

    /// One request under /console: the page and its files, or the API under /console/api/. `view` is the relay's
    /// status (State::console_status), asked for only when shown and never while the console's own lock is held.
    pub fn http(&self, r: &ConsoleRequest, t: i64, view: impl FnOnce() -> Value) -> ConsoleReply {
        if !r.host_ok {
            return closing(fail(421, "this relay does not answer for that host name"));
        }
        let Some(route) = r.pathname.strip_prefix("/console/api/") else { return page(r) };
        let origin = self.inner.lock().book.origin.clone();
        let Some(origin) = origin else { return fail(409, NO_ADMIN) };
        if origin_of(r.dialed).ok().as_deref() != Some(origin.as_str()) {
            return fail(409, &format!("Open the control panel at {origin}/console/"));
        }
        let post = r.method == "POST";
        if !post && r.method != "GET" {
            return closing(fail(405, "Method not allowed."));
        }
        let mut body = Value::Object(Map::new());
        if post {
            if r.marker != Some("1") || r.origin != Some(origin.as_str()) {
                let shown = r.origin.map(|o| o.chars().take(200).collect::<String>());
                let f = Fields::new().with("ip", r.ip).with("path", r.pathname).with("origin", shown).with("why", "a POST without this control panel's Origin and its X-Lucid-Console header");
                self.logger.security("console.refused", &f, Level::Warn);
                return closing(fail(403, "Refused: this request did not come from the control panel's own page."));
            }
            if !r.content_type.to_ascii_lowercase().starts_with("application/json") {
                return fail(415, "Send JSON.");
            }
            if r.body.len() > BODY_MAX {
                return closing(fail(413, "Request too large."));
            }
            match parse_json(r.body) {
                Some(v @ Value::Object(_)) => body = v,
                _ => return fail(400, "The body must be a JSON object."),
            }
        }
        let sid = cookie_of(r.cookie);
        let answer: Answer = match (r.method, route) {
            ("GET", "me") => {
                let mut inner = self.inner.lock();
                let user = inner.session(sid, t).map(|e| inner.book.admin_view(&e)).unwrap_or(Value::Null);
                Ok((json!({ "ok": true, "user": user, "origin": origin }), None))
            }
            ("POST", "join") => self.join(r.ip, &body, t),
            ("POST", "register/begin") => self.register_begin(r.ip, &body, &origin, t),
            ("POST", "register/finish") => self.register_finish(r.ip, &body, &origin, t),
            ("POST", "login/begin") => self.login_begin(r.ip, &body, &origin, t),
            ("POST", "login/finish") => self.login_finish(r.ip, &body, &origin, t),
            ("POST", "logout") => Ok(self.logout(sid, r.ip)),
            ("GET", "status") => {
                // The console's lock is let go before the relay's status is asked for.
                let who = self.inner.lock().session(sid, t);
                match who {
                    None => Err(api_err(401, "Sign in first.")),
                    Some(_) => Ok((self.status(view(), t), None)),
                }
            }
            ("GET", "logs") => {
                let who = self.inner.lock().session(sid, t);
                return match who {
                    None => fail(401, "Sign in first."),
                    Some(email) => self.logs(&email, r.query, r.ip),
                };
            }
            _ => return closing(fail(404, "Unknown path.")),
        };
        match answer {
            Ok((v, cookie)) => {
                let mut x = json_answer(200, &v);
                if let Some(c) = cookie {
                    x.headers.push(("Set-Cookie", c));
                }
                x
            }
            Err(e) => {
                let mut x = fail(e.status, &e.message);
                if let Some(s) = e.retry_after {
                    x.headers.push(("Retry-After", s.to_string()));
                }
                x
            }
        }
    }

    fn join(&self, ip: &str, body: &Value, t: i64) -> Answer {
        let mut inner = self.inner.lock();
        inner.limit(ip, t)?;
        let (_, i) = inner.book.invite(str_of(body.get("token")), t)?;
        Ok((json!({ "ok": true, "email": i.email, "expires": i.expires }), None))
    }

    fn register_begin(&self, ip: &str, body: &Value, origin: &str, t: i64) -> Answer {
        let mut inner = self.inner.lock();
        inner.limit(ip, t)?;
        let (hash, email) = {
            let (h, i) = inner.book.invite(str_of(body.get("token")), t)?;
            (h, i.email.clone())
        };
        let existing = inner.book.admins.get(&email);
        let handle = match existing {
            Some(a) => a.handle.clone(),
            None => random_token(16)?,
        };
        let exclude: Vec<Value> = existing.map(|a| a.passkeys.iter().map(|p| json!({ "type": "public-key", "id": p.id })).collect()).unwrap_or_default();
        let challenge = random(32).ok_or_else(|| api_err(500, "The control panel could not draw random bytes; see the relay's log."))?;
        let c = Ceremony { kind: Kind::Register, challenge: challenge.clone(), expires: t + CEREMONY_MS, email: email.clone(), invite: hash, handle: handle.clone(), allow: Vec::new() };
        let id = inner.ceremony(c, t)?;
        let public_key = json!({
            "challenge": b64u(&challenge),
            "rp": { "id": rp_id_of(origin), "name": "LUCID relay control panel" },
            "user": { "id": handle, "name": email, "displayName": email },
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
            "timeout": CEREMONY_MS,
            "attestation": "none",
            "authenticatorSelection": { "residentKey": "preferred", "requireResidentKey": false, "userVerification": "required" },
            "excludeCredentials": exclude,
        });
        Ok((json!({ "ok": true, "ceremony": id, "publicKey": public_key }), None))
    }

    fn register_finish(&self, ip: &str, body: &Value, origin: &str, t: i64) -> Answer {
        let mut inner = self.inner.lock();
        inner.limit(ip, t)?;
        let c = inner.take(str_of(body.get("ceremony")), Kind::Register, t)?;
        let credential = body.get("credential").cloned().unwrap_or(Value::Null);
        let made = verify_registration(&rp_id_of(origin), origin, &c.challenge, &credential, true).map_err(|e| {
            self.logger.security("console.passkey-refused", &Fields::new().with("email", &c.email).with("ip", ip).with("why", &e.message), Level::Warn);
            ApiError::from(e)
        })?;
        // Single use: checked again, then gone with the passkey saved.
        if !inner.book.invites.get(&c.invite).is_some_and(|i| i.expires > t) {
            return Err(api_err(410, GONE));
        }
        let id = b64u(&made.id);
        if inner.book.admins.values().any(|a| a.passkeys.iter().any(|p| p.id == id)) {
            return Err(api_err(409, "That passkey is already registered."));
        }
        if inner.book.admins.get(&c.email).is_some_and(|a| a.passkeys.len() >= PASSKEYS_MAX) {
            return Err(api_err(409, format!("At most {PASSKEYS_MAX} passkeys per admin.")));
        }
        let label = label_of(body.get("label"));
        inner.book.invites.shift_remove(&c.invite);
        let admin = inner.book.admins.entry(c.email.clone()).or_insert_with(|| Admin { handle: c.handle.clone(), created: t, last_sign_in: 0, passkeys: Vec::new() });
        admin.passkeys.push(Passkey { id, cose: b64u(&made.cose), count: made.sign_count, label: label.clone(), created: t, last_used: t });
        admin.last_sign_in = t;
        self.save(&inner.book)?;
        let cookie = inner.new_session(&c.email, t)?;
        self.logger.security("console.passkey-registered", &Fields::new().with("email", &c.email).with("label", &label).with("ip", ip), Level::Info);
        Ok((json!({ "ok": true, "user": inner.book.admin_view(&c.email) }), Some(cookie)))
    }

    fn login_begin(&self, ip: &str, body: &Value, origin: &str, t: i64) -> Answer {
        let mut inner = self.inner.lock();
        inner.limit(ip, t)?;
        let email = str_of(body.get("email")).map(|e| js_trim(e).to_lowercase()).unwrap_or_default();
        let allow: Vec<String> = inner.book.admins.get(&email).map(|a| a.passkeys.iter().map(|p| p.id.clone()).collect()).unwrap_or_default();
        let challenge = random(32).ok_or_else(|| api_err(500, "The control panel could not draw random bytes; see the relay's log."))?;
        let offered: Vec<Value> = allow.iter().map(|i| json!({ "type": "public-key", "id": i })).collect();
        let c = Ceremony { kind: Kind::Login, challenge: challenge.clone(), expires: t + CEREMONY_MS, email: String::new(), invite: String::new(), handle: String::new(), allow };
        let id = inner.ceremony(c, t)?;
        let public_key = json!({ "challenge": b64u(&challenge), "rpId": rp_id_of(origin), "timeout": CEREMONY_MS, "userVerification": "required", "allowCredentials": offered });
        Ok((json!({ "ok": true, "ceremony": id, "publicKey": public_key }), None))
    }

    fn login_finish(&self, ip: &str, body: &Value, origin: &str, t: i64) -> Answer {
        let mut inner = self.inner.lock();
        inner.limit(ip, t)?;
        let c = inner.take(str_of(body.get("ceremony")), Kind::Login, t)?;
        let credential = body.get("credential").cloned().unwrap_or(Value::Null);
        let refuse = |status: u16, why: &str, email: Option<&str>| {
            self.logger.security("console.signin-refused", &Fields::new().with("email", email).with("ip", ip).with("why", why), Level::Warn);
            api_err(status, why)
        };
        let id = credential_id(&credential).map(|i| b64u(&i)).map_err(|e| refuse(e.status, &e.message, None))?;
        if !c.allow.is_empty() && !c.allow.contains(&id) {
            return Err(refuse(403, "That passkey was not offered for this sign-in.", None));
        }
        let Some((email, cose, stored, handle)) = inner.book.find(&id) else {
            return Err(refuse(403, "This passkey is not registered here (or was removed).", None));
        };
        let given = credential.get("response").and_then(|r| r.get("userHandle")).and_then(Value::as_str).unwrap_or("");
        if !given.is_empty() && given != handle {
            return Err(refuse(403, "The passkey belongs to someone else.", Some(email.as_str())));
        }
        let cose = unb64u(&cose).unwrap_or_default();
        let count = verify_assertion(&rp_id_of(origin), origin, &c.challenge, &cose, &credential, true).map_err(|e| refuse(e.status, &e.message, Some(email.as_str())))?;
        if (count != 0 || stored != 0) && count <= stored {
            let why = format!("This passkey's counter went backwards ({count} after {stored}), so it may have been copied. Sign-in refused.");
            return Err(refuse(403, &why, Some(email.as_str())));
        }
        if let Some(a) = inner.book.admins.get_mut(&email) {
            a.last_sign_in = t;
            if let Some(p) = a.passkeys.iter_mut().find(|p| p.id == id) {
                p.count = count;
                p.last_used = t;
            }
        }
        self.save(&inner.book)?;
        let cookie = inner.new_session(&email, t)?;
        self.logger.security("console.signin", &Fields::new().with("email", &email).with("ip", ip), Level::Info);
        Ok((json!({ "ok": true, "user": inner.book.admin_view(&email) }), Some(cookie)))
    }

    fn logout(&self, sid: &str, ip: &str) -> (Value, Option<String>) {
        let gone = self.inner.lock().sessions.remove(sid);
        if let Some(s) = gone {
            self.logger.security("console.signout", &Fields::new().with("email", s.email).with("ip", ip), Level::Info);
        }
        (json!({ "ok": true }), Some(format!("{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0")))
    }

    fn save(&self, book: &Book) -> Result<(), ApiError> {
        book.save(&self.file).map_err(|e| {
            self.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
            api_err(500, "The control panel could not save its state; see the relay's log.")
        })
    }

    /// The relay's status with the panel's own: admins, open invites, sessions, quota refusals, spokes with logs.
    fn status(&self, view: Value, t: i64) -> Value {
        let console = {
            let inner = self.inner.lock();
            let admins: Vec<Value> = inner.book.admins.iter().map(|(e, a)| json!({ "email": e, "passkeys": a.passkeys.len(), "lastSignIn": a.last_sign_in })).collect();
            json!({ "origin": inner.book.origin, "admins": admins, "invitesOpen": inner.book.invites.values().filter(|i| i.expires > t).count(), "sessions": inner.sessions.len() })
        };
        let spokes: Vec<Value> = self.spokes.lock().nodes.iter().rev().map(|(n, r)| json!({ "node": n, "lines": r.lines.len(), "lastAt": r.last })).collect();
        let mut out = match view {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        out.insert("ok".into(), Value::Bool(true));
        out.insert("console".into(), console);
        out.insert("quotaHits".into(), self.ring.hits());
        out.insert("spokeLogs".into(), Value::from(spokes));
        Value::Object(out)
    }

    /// GET /console/api/logs?source=relay|<node>&cat=all|security|ops|perf&level=<min>&limit=N[&format=jsonl]: the
    /// lines newest first, or the download (oldest first, as a log file reads).
    fn logs(&self, email: &str, query: &str, ip: &str) -> ConsoleReply {
        let pairs: Vec<(&str, &str)> = query.split('&').filter_map(|p| p.split_once('=')).collect();
        let get = |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
        let source = get("source").filter(|s| !s.is_empty()).unwrap_or("relay");
        let cat = match get("cat").unwrap_or("all") {
            "all" | "" => None,
            c @ ("security" | "ops" | "perf") => Some(c.to_owned()),
            _ => return fail(400, "cat is all, security, ops or perf"),
        };
        let min = match get("level").filter(|l| !l.is_empty()) {
            None => Level::Debug,
            Some(l) => match level_of(l) {
                Some(l) => l,
                None => return fail(400, "level is debug, info, warn or error"),
            },
        };
        let f = Filter { cat, min };
        let lines = if source == "relay" {
            self.ring.lines(&f)
        } else if is_node_id(source) {
            self.spokes.lock().lines(source, &f)
        } else {
            return fail(400, "source is relay or a spoke's node id");
        };
        if get("format") == Some("jsonl") {
            let f = Fields::new().with("email", email).with("source", source).with("lines", lines.len()).with("ip", ip);
            self.logger.security("console.logs-downloaded", &f, Level::Info);
            let mut text = String::new();
            for l in lines.iter().rev() {
                text.push_str(l);
                text.push('\n');
            }
            let mut x = reply(200, "application/x-ndjson; charset=utf-8", text.into_bytes(), "no-store");
            x.headers.push(("Content-Disposition", format!("attachment; filename=\"lucid-relay-{source}-log.jsonl\"")));
            return x;
        }
        let limit = get("limit").and_then(|l| l.parse::<usize>().ok()).unwrap_or(200).clamp(1, PAGE_LINES);
        let shown = &lines[..lines.len().min(limit)];
        let body = format!("{{\"ok\":true,\"source\":{},\"total\":{},\"lines\":[{}]}}", stringify(&Value::from(source)), lines.len(), shown.join(","));
        reply(200, "application/json; charset=utf-8", body.into_bytes(), "no-store")
    }
}

/// The page and its two files; anything else under /console/ that is not the API is 404.
fn page(r: &ConsoleRequest) -> ConsoleReply {
    if r.method != "GET" {
        return closing(fail(405, "Method not allowed."));
    }
    let (content_type, body) = match r.pathname {
        "/console" => {
            let mut x = reply(308, "text/plain; charset=utf-8", b"/console/\n".to_vec(), "no-cache");
            x.headers.push(("Location", "/console/".into()));
            return x;
        }
        "/console/" | "/console/index.html" => ("text/html; charset=utf-8", INDEX_HTML),
        "/console/app.js" => ("text/javascript; charset=utf-8", APP_JS),
        "/console/app.css" => ("text/css; charset=utf-8", APP_CSS),
        _ => return reply(404, "text/plain; charset=utf-8", b"Not found\n".to_vec(), "no-cache"),
    };
    reply(200, content_type, body.as_bytes().to_vec(), "no-cache")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console_webauthn::testkit::Authenticator;

    const ORIGIN: &str = "https://relay.example.com:8787";
    const RP: &str = "relay.example.com";
    const T0: i64 = 1_800_000_000_000;

    /// A dialed DNS name or IPv4 address, with or without a port (server.rs dialed_of for TLS).
    fn dialed(host: &str) -> Dialed {
        let (hostname, port) = match host.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), p.parse().unwrap_or(443)),
            None => (host.to_owned(), 443),
        };
        Dialed { host: host.to_owned(), hostname, port }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lucid-console-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(CONSOLE_FILE)
    }

    fn lines_of(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        log.lock().clone()
    }

    fn console(name: &str) -> (Console, Arc<Mutex<Vec<String>>>) {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let w = written.clone();
        let ring = Arc::new(LineRing::default());
        let logger = Arc::new(Logger::capture("relay", Box::new(move |l, _| w.lock().push(l.to_owned()))).with_tap(ring.tap()));
        (Console::load(temp(name), logger, ring).unwrap(), written)
    }

    struct Call<'a> {
        method: &'a str,
        path: &'a str,
        body: Value,
        cookie: String,
        origin: Option<&'a str>,
        marker: Option<&'a str>,
        content_type: &'a str,
        ip: &'a str,
        host: &'a str,
    }

    fn call<'a>(method: &'a str, path: &'a str, body: Value, cookie: &str) -> Call<'a> {
        Call { method, path, body, cookie: cookie.to_owned(), origin: Some(ORIGIN), marker: Some("1"), content_type: "application/json", ip: "192.0.2.7", host: "relay.example.com:8787" }
    }

    fn send(c: &Console, k: Call, t: i64) -> ConsoleReply {
        let d = dialed(k.host);
        let body = if k.method == "POST" { stringify(&k.body) } else { String::new() };
        let (pathname, query) = k.path.split_once('?').unwrap_or((k.path, ""));
        let r = ConsoleRequest {
            method: k.method,
            pathname,
            query,
            cookie: &k.cookie,
            origin: k.origin,
            marker: k.marker,
            content_type: k.content_type,
            ip: k.ip,
            body: &body,
            dialed: &d,
            host_ok: true,
        };
        c.http(&r, t, || json!({ "relay": { "version": "test" } }))
    }

    fn json_of(r: &ConsoleReply) -> Value {
        parse_json(&String::from_utf8_lossy(&r.body)).unwrap_or(Value::Null)
    }

    fn header<'a>(r: &'a ConsoleReply, name: &str) -> Option<&'a str> {
        r.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    /// The `__Host-lrc=<sid>` a Set-Cookie carries.
    fn cookie(r: &ConsoleReply) -> String {
        header(r, "Set-Cookie").and_then(|c| c.split(';').next()).unwrap_or("").to_owned()
    }

    fn token_of(link: &str) -> String {
        link.split_once("#join=").map(|(_, t)| t.to_owned()).unwrap_or_default()
    }

    /// Invite, then register a passkey from the link: the session cookie.
    fn enrol(c: &Console, a: &mut Authenticator, email: &str, t: i64) -> String {
        let inv = c.invite(email, "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), t).unwrap();
        let token = token_of(&inv.link);
        let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token }), ""), t));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let credential = a.register(RP, ORIGIN, &challenge, false);
        let r = send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": credential, "label": "Laptop" }), ""), t);
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        cookie(&r)
    }

    #[test]
    fn an_invite_is_a_link_good_once_for_24_hours() {
        let (c, log) = console("invite");
        let inv = c.invite("alice@acme.example", "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), T0).unwrap();
        assert_eq!(inv.origin, ORIGIN);
        assert_eq!(inv.expires, T0 + 24 * 3_600_000);
        let token = token_of(&inv.link);
        assert!(inv.link.starts_with("https://relay.example.com:8787/console/#join="));
        assert_eq!(token.len(), 43);
        // The book keeps the token's hash, never the token.
        let saved = std::fs::read_to_string(&c.file).unwrap();
        assert!(!saved.contains(&token) && saved.contains(&sha256_hex(token.as_bytes())));
        let ok = send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 1000);
        assert_eq!(json_of(&ok)["email"], "alice@acme.example");
        let late = send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 24 * 3_600_000);
        assert_eq!(late.status, 410);
        // A newer invite for the same person replaces the older one.
        let again = c.invite("alice@acme.example", "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), T0 + 2000).unwrap();
        assert_eq!(send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 3000).status, 410);
        // Used once: registering a passkey spends it.
        let mut a = Authenticator::new(3);
        let t2 = token_of(&again.link);
        let begin = json_of(&send(&c, call("POST", "/console/api/register/begin", json!({ "token": t2 }), ""), T0 + 4000));
        assert_eq!(begin["publicKey"]["rp"]["id"], RP);
        assert_eq!(begin["publicKey"]["authenticatorSelection"]["userVerification"], "required");
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let reg = a.register(RP, ORIGIN, &challenge, true);
        let r = send(&c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0 + 5000);
        assert_eq!(r.status, 200);
        assert!(cookie(&r).starts_with("__Host-lrc="));
        let set = header(&r, "Set-Cookie").unwrap();
        assert!(set.contains("Secure") && set.contains("HttpOnly") && set.contains("SameSite=Strict") && set.contains("Path=/"));
        assert_eq!(send(&c, call("POST", "/console/api/join", json!({ "token": t2 }), ""), T0 + 6000).status, 410);
        assert!(lines_of(&log).iter().any(|l| l.contains("\"event\":\"console.passkey-registered\"") && l.contains("alice@acme.example")));
        // The admin and passkey survive a restart.
        let ring = Arc::new(LineRing::default());
        let again = Console::load(c.file.clone(), c.logger.clone(), ring).unwrap();
        assert!(again.inner.lock().book.admins.contains_key("alice@acme.example"));
    }

    #[test]
    fn an_invite_needs_a_dns_name_and_the_console_origin() {
        let (c, _) = console("origin");
        let by = "n_0123456789abcdef0123456789abcdef";
        let e = c.invite("alice@acme.example", by, &dialed("10.0.0.5:8787"), T0).err().unwrap();
        assert_eq!(e.status, 409);
        assert!(e.error.contains("IP address"));
        assert_eq!(c.invite("alice@acme.example", by, &Dialed { host: "[::1]:8787".into(), hostname: "[::1]".into(), port: 8787 }, T0).err().unwrap().status, 409);
        // Port 443, given or not, is the same origin.
        assert_eq!(c.invite("alice@acme.example", by, &dialed("relay.example.com:443"), T0).unwrap().origin, "https://relay.example.com");
        assert_eq!(c.invite("bob@acme.example", by, &Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 80 }, T0).unwrap().origin, "https://relay.example.com");
        let e = c.invite("alice@acme.example", by, &dialed("other.example.com"), T0).err().unwrap();
        assert_eq!(e.status, 409);
        assert!(e.error.contains("https://relay.example.com"));
    }

    #[test]
    fn posts_need_the_console_origin_and_header() {
        let (c, log) = console("posts");
        c.invite("alice@acme.example", "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), T0).unwrap();
        let mut k = call("POST", "/console/api/login/begin", json!({}), "");
        k.marker = None;
        let r = send(&c, k, T0);
        assert_eq!((r.status, r.close), (403, true));
        let mut k = call("POST", "/console/api/login/begin", json!({}), "");
        k.origin = Some("https://evil.example");
        assert_eq!(send(&c, k, T0).status, 403);
        let mut k = call("POST", "/console/api/login/begin", json!({}), "");
        k.origin = None;
        assert_eq!(send(&c, k, T0).status, 403);
        let mut k = call("POST", "/console/api/login/begin", json!({}), "");
        k.content_type = "text/plain";
        assert_eq!(send(&c, k, T0).status, 415);
        assert!(lines_of(&log).iter().filter(|l| l.contains("\"event\":\"console.refused\"")).count() >= 3);
        let ok = send(&c, call("POST", "/console/api/login/begin", json!({}), ""), T0);
        assert_eq!(ok.status, 200);
        assert_eq!(json_of(&ok)["publicKey"]["rpId"], RP);
        // The API answers only at the console's origin, and only with a session.
        let mut k = call("GET", "/console/api/me", Value::Null, "");
        k.host = "other.example.com";
        assert_eq!(send(&c, k, T0).status, 409);
        assert_eq!(send(&c, call("GET", "/console/api/status", Value::Null, ""), T0).status, 401);
        assert_eq!(send(&c, call("GET", "/console/api/logs", Value::Null, ""), T0).status, 401);
        // Every answer carries the page's protections.
        let page = send(&c, call("GET", "/console/", Value::Null, ""), T0);
        assert_eq!(page.status, 200);
        assert!(header(&page, "Content-Security-Policy").unwrap().contains("script-src 'self'"));
        assert_eq!(header(&page, "X-Frame-Options"), Some("DENY"));
    }

    #[test]
    fn a_console_with_no_admin_says_how_to_get_one() {
        let (c, _) = console("empty");
        let r = send(&c, call("GET", "/console/api/me", Value::Null, ""), T0);
        assert_eq!(r.status, 409);
        assert!(json_of(&r)["error"].as_str().unwrap().contains("ask for an invite from the IDE"));
        assert_eq!(send(&c, call("GET", "/console/app.js", Value::Null, ""), T0).status, 200);
    }

    #[test]
    fn a_session_signs_in_with_the_passkey_and_ends() {
        let (c, log) = console("session");
        let mut a = Authenticator::new(5);
        let sid = enrol(&c, &mut a, "alice@acme.example", T0);
        let me = json_of(&send(&c, call("GET", "/console/api/me", Value::Null, &sid), T0 + 1000));
        assert_eq!(me["user"]["email"], "alice@acme.example");
        let st = send(&c, call("GET", "/console/api/status", Value::Null, &sid), T0 + 2000);
        assert_eq!(st.status, 200);
        let v = json_of(&st);
        assert_eq!(v["relay"]["version"], "test");
        assert_eq!(v["console"]["admins"][0]["email"], "alice@acme.example");
        // Idle past 12 hours: signed out.
        assert_eq!(send(&c, call("GET", "/console/api/status", Value::Null, &sid), T0 + 2000 + 12 * 3_600_000 + 1).status, 401);
        // Sign in again with the passkey.
        let t = T0 + 13 * 3_600_000;
        let begin = json_of(&send(&c, call("POST", "/console/api/login/begin", json!({ "email": "Alice@acme.example" }), ""), t));
        assert_eq!(begin["publicKey"]["allowCredentials"][0]["id"], b64u(&a.id));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let got = a.assert(RP, ORIGIN, &challenge, None);
        let r = send(&c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t);
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        let sid2 = cookie(&r);
        assert_eq!(send(&c, call("GET", "/console/api/status", Value::Null, &sid2), t + 1).status, 200);
        assert!(lines_of(&log).iter().any(|l| l.contains("\"event\":\"console.signin\"")));
        // A ceremony is used once.
        let again = send(&c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t);
        assert_eq!(again.status, 400);
        // A counter that goes backwards is a copied passkey.
        a.count = 0;
        let begin = json_of(&send(&c, call("POST", "/console/api/login/begin", json!({}), ""), t + 2));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let got = a.assert(RP, ORIGIN, &challenge, None);
        let r = send(&c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t + 3);
        assert_eq!(r.status, 403);
        assert!(lines_of(&log).iter().any(|l| l.contains("\"event\":\"console.signin-refused\"")));
        // Another passkey, never registered here, is refused.
        let mut stranger = Authenticator::new(9);
        let begin = json_of(&send(&c, call("POST", "/console/api/login/begin", json!({}), ""), t + 4));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let got = stranger.assert(RP, ORIGIN, &challenge, None);
        assert_eq!(send(&c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t + 5).status, 403);
        // Sign out: the cookie is cleared and the session is gone.
        let out = send(&c, call("POST", "/console/api/logout", json!({}), &sid2), t + 6);
        assert!(header(&out, "Set-Cookie").unwrap().contains("Max-Age=0"));
        assert_eq!(send(&c, call("GET", "/console/api/status", Value::Null, &sid2), t + 7).status, 401);
        // At most 7 days, however busy.
        let sid3 = enrol(&c, &mut Authenticator::new(11), "bob@acme.example", t);
        for step in 1..=29i64 {
            let s = send(&c, call("GET", "/console/api/status", Value::Null, &sid3), t + step * 6 * 3_600_000).status;
            assert_eq!(s, if step <= 28 { 200 } else { 401 }, "after {} hours", step * 6);
        }
    }

    #[test]
    fn a_registration_for_another_site_is_refused() {
        let (c, _) = console("othersite");
        let inv = c.invite("alice@acme.example", "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), T0).unwrap();
        let token = token_of(&inv.link);
        let begin = json_of(&send(&c, call("POST", "/console/api/register/begin", json!({ "token": token }), ""), T0));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let reg = Authenticator::new(4).register("evil.example", "https://evil.example", &challenge, false);
        let r = send(&c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0);
        assert_eq!(r.status, 403);
        assert!(header(&r, "Set-Cookie").is_none());
        // The invite is still good for the real passkey.
        assert_eq!(send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0).status, 200);
    }

    #[test]
    fn sign_in_attempts_are_limited_per_address() {
        let (c, _) = console("limit");
        c.invite("alice@acme.example", "n_0123456789abcdef0123456789abcdef", &dialed("relay.example.com:8787"), T0).unwrap();
        for i in 0..SIGNIN_LIMIT {
            assert_eq!(send(&c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + i as i64).status, 200);
        }
        let r = send(&c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 100);
        assert_eq!(r.status, 429);
        assert_eq!(header(&r, "Retry-After"), Some("600"));
        let mut other = call("POST", "/console/api/login/begin", json!({}), "");
        other.ip = "198.51.100.9";
        assert_eq!(send(&c, other, T0 + 100).status, 200);
        assert_eq!(send(&c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + SIGNIN_WINDOW_MS).status, 200);
    }

    #[test]
    fn the_relay_ring_keeps_the_newest_lines_and_filters_them() {
        let (c, _) = console("ring");
        for i in 0..RELAY_LINES + 5 {
            let level = if i % 2 == 0 { Level::Info } else { Level::Warn };
            c.logger.log(if i % 3 == 0 { "security" } else { "ops" }, level, &format!("e{i}"), &Fields::new());
        }
        c.logger.security("store.full", &Fields::new(), Level::Warn);
        let all = c.ring.lines(&Filter { cat: None, min: Level::Debug });
        assert_eq!(all.len(), RELAY_LINES);
        assert!(all[0].contains("\"event\":\"store.full\""));
        assert!(all[1].contains(&format!("\"event\":\"e{}\"", RELAY_LINES + 4)));
        assert!(!all.iter().any(|l| l.contains("\"event\":\"e5\"")));
        let warn_ops = c.ring.lines(&Filter { cat: Some("ops".into()), min: Level::Warn });
        assert!(!warn_ops.is_empty() && warn_ops.iter().all(|l| l.contains("\"cat\":\"ops\"") && l.contains("\"level\":\"warn\"")));
        assert_eq!(c.ring.hits()["store.full"], 1);
        // Signed in: newest first, a page, and the download.
        let sid = enrol(&c, &mut Authenticator::new(6), "alice@acme.example", T0);
        let page = json_of(&send(&c, call("GET", "/console/api/logs?source=relay&cat=security&level=warn&limit=3", Value::Null, &sid), T0));
        assert_eq!(page["lines"].as_array().unwrap().len(), 3);
        assert!(page["lines"].as_array().unwrap().iter().all(|l| l["cat"] == "security" && l["level"] != "info"));
        let file = send(&c, call("GET", "/console/api/logs?source=relay&format=jsonl", Value::Null, &sid), T0);
        assert!(header(&file, "Content-Disposition").unwrap().starts_with("attachment;"));
        let text = String::from_utf8_lossy(&file.body).into_owned();
        assert!(text.lines().all(|l| parse_json(l).is_some()));
        assert!(text.lines().last().unwrap().contains("console.passkey-registered"));
        assert!(c.ring.lines(&Filter { cat: None, min: Level::Debug })[0].contains("console.logs-downloaded"));
        assert_eq!(send(&c, call("GET", "/console/api/logs?cat=nope", Value::Null, &sid), T0).status, 400);
    }

    fn post(n: usize, cat: &str, pad: usize) -> String {
        let lines: Vec<Value> = (0..n).map(|i| json!({ "ts": "2026-11-09T00:00:00.000Z", "level": "warn", "cat": cat, "component": "spoke", "event": format!("e{i}"), "token": "drop me", "pad": "x".repeat(pad) })).collect();
        stringify(&json!({ "lines": lines }))
    }

    #[test]
    fn spoke_logs_are_bounded_and_rate_limited() {
        let (c, _) = console("spokes");
        let node = "n_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert_eq!(c.take_logs(node, &post(3, "security", 0), T0), Ok(3));
        let kept = c.spokes.lock().lines(node, &Filter { cat: None, min: Level::Debug });
        assert_eq!(kept.len(), 3);
        assert!(kept[0].contains("\"event\":\"e2\"") && !kept[0].contains("drop me"));
        let e = c.take_logs(node, &post(101, "ops", 0), T0 + 1).err().unwrap();
        assert_eq!((e.status, e.error.as_str()), (400, "a post carries 1 to 100 log lines"));
        assert_eq!(c.take_logs(node, &post(1, "ops", 2100), T0 + 2).err().unwrap().error, "a log line is at most 2048 bytes");
        assert_eq!(c.take_logs(node, &post(1, "perf", 0), T0 + 3).err().unwrap().error, "only security and ops log lines are taken");
        assert_eq!(c.take_logs(node, &post(40, "ops", 1700), T0 + 4).err().unwrap().error, "a post carries at most 64 KiB of log lines");
        // Six posts a minute, malformed ones counted: the seventh waits until the first is a minute old.
        assert_eq!(c.take_logs(node, &post(1, "ops", 0), T0 + 5), Ok(1));
        let e = c.take_logs(node, &post(1, "ops", 0), T0 + 6).err().unwrap();
        assert_eq!((e.status, e.event), (429, "logs.rate-limited"));
        assert_eq!(c.take_logs(node, &post(1, "ops", 0), T0 + 60_000), Ok(1));
        // The ring per node keeps the newest SPOKE_LINES.
        let mut t = T0 + 120_000;
        for _ in 0..6 {
            c.take_logs(node, &post(100, "ops", 0), t).unwrap();
            t += 60_000;
        }
        let kept = c.spokes.lock().lines(node, &Filter { cat: None, min: Level::Debug });
        assert_eq!(kept.len(), SPOKE_LINES);
        // Past SPOKE_NODES spokes, the one that posted least recently goes.
        for i in 0..SPOKE_NODES {
            c.take_logs(&format!("n_{i:032x}"), &post(1, "security", 0), t + i as i64).unwrap();
        }
        let s = c.spokes.lock();
        assert_eq!(s.nodes.len(), SPOKE_NODES);
        assert!(!s.nodes.contains_key(node));
    }

    // ── The signed ops on the relay (relay.rs State::serve) ─────────────────────────────────────────────────

    use crate::codec::js_number_string;
    use crate::der::p256_spki_der;
    use crate::identity::{node_id_of, user_id_of};
    use crate::relay::{Options, Request, State, SENDER_BYTES, STORE_BYTES};
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};

    fn compact(key: &SigningKey, payload: &Value) -> String {
        let body = stringify(payload);
        let sig: Signature = key.sign(body.as_bytes());
        format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
    }

    struct Node {
        key: SigningKey,
        cert: String,
        id: String,
    }

    /// A node certificate signed by `root` (identity.ts issueCert's shape).
    fn node(root: &SigningKey, seed: u8, role: &str, scopes: &[&str], email: Option<&str>) -> Node {
        let root_id = node_id_of(&p256_spki_der(root.verifying_key()));
        let key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let spki = p256_spki_der(key.verifying_key());
        let id = node_id_of(&spki);
        let now = T0 / 1000;
        let mut p = json!({
            "v": 1, "typ": "lucid-node-cert", "serial": format!("{seed:032x}"), "root": root_id, "node": id, "role": role,
            "label": format!("{role} {seed}"), "spki": b64u(&spki), "scopes": scopes, "iat": now - 60, "exp": now + 86_400,
        });
        if let Some(e) = email {
            p["user"] = json!({ "id": user_id_of(e), "email": e });
        }
        Node { cert: compact(root, &p), key, id }
    }

    fn relay(console: Option<Arc<Console>>, root: &SigningKey) -> State {
        let logger = Arc::new(Logger::capture("relay", Box::new(|_, _| {})));
        let opts = Options {
            root: *root.verifying_key(),
            owner: None,
            license: None,
            crl_file: None,
            store: None,
            seen_file: None,
            directory_file: None,
            users_file: None,
            store_bytes: STORE_BYTES,
            sender_bytes: SENDER_BYTES,
            console,
        };
        State::new(opts, logger).unwrap()
    }

    /// POST `sent` to `path`, signed by `n` over `signed` (the same body unless a test tampers with it).
    fn signed_post(st: &mut State, n: &Node, path: &str, signed: &str, sent: &str, t: i64, nonce: u32) -> (u16, Value) {
        let host = "relay.example.com:8787";
        let nonce = format!("{nonce:032x}");
        let line = format!("lucid-relay-auth/v2\nrelay:{host}\nPOST\n{path}\n{}\n{nonce}\n{}", js_number_string(t as f64), sha256_hex(signed.as_bytes()));
        let sig: Signature = n.key.sign(line.as_bytes());
        let a = json!({ "cert": n.cert, "ts": t, "nonce": nonce, "sig": b64u(sig.to_der().as_bytes()) });
        let authorization = format!("LucidNode {}", b64u(stringify(&a).as_bytes()));
        let d = dialed(host);
        let where_ = Fields::new();
        let r = Request { method: "POST", pathname: path, path, authorization: &authorization, dialed: &d, body: sent, where_: &where_ };
        let reply = st.serve(&r, t, true).unwrap();
        (reply.status, parse_json(&reply.body).unwrap_or(Value::Null))
    }

    fn op(st: &mut State, n: &Node, path: &str, body: &str, t: i64, nonce: u32) -> (u16, Value) {
        signed_post(st, n, path, body, body, t, nonce)
    }

    #[test]
    fn spoke_logs_need_a_signed_spoke_and_the_panel_on() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let spoke = node(&root, 2, "spoke", &[], None);
        let hub = node(&root, 3, "hub", &["drive"], Some("alice@acme.example"));
        // Off: 409 with how to turn it on (a 2.x relay, so not the 404 an older relay gives).
        let mut off = relay(None, &root);
        let (s, v) = op(&mut off, &spoke, "/v1/logs", &post(1, "ops", 0), T0, 1);
        assert_eq!((s, v["error"].as_str()), (409, Some(CONSOLE_OFF)));
        let (c, _) = console("route-logs");
        let c = Arc::new(c);
        let mut st = relay(Some(c.clone()), &root);
        let (s, v) = op(&mut st, &spoke, "/v1/logs", &post(2, "security", 0), T0, 2);
        assert_eq!((s, v["kept"].as_i64()), (200, Some(2)));
        assert_eq!(c.spokes.lock().lines(&spoke.id, &Filter { cat: None, min: Level::Debug }).len(), 2);
        // A hub is not a spoke; a body other than the one signed, or a replay, is not this spoke.
        assert_eq!(op(&mut st, &hub, "/v1/logs", &post(1, "ops", 0), T0, 3).0, 403);
        assert_eq!(signed_post(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), &post(1, "security", 0), T0, 4).0, 401);
        assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(2, "security", 0), T0, 2).0, 401);
        assert_eq!(op(&mut st, &spoke, "/v1/logs", "{\"lines\":[]}", T0, 5).0, 400);
        // Six posts a minute per node (two so far).
        for i in 0..4 {
            assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), T0 + 1 + i, 10 + i as u32).0, 200);
        }
        assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), T0 + 10, 20).0, 429);
        // The panel names the spoke by its certificate's label.
        let status = st.console_status(T0 + 20);
        let seen = status["nodes"].as_array().unwrap().iter().find(|n| n["node"] == spoke.id.as_str()).cloned().unwrap();
        assert_eq!((seen["role"].as_str(), seen["label"].as_str()), (Some("spoke"), Some("spoke 2")));
    }

    #[test]
    fn an_invite_needs_a_hub_with_drive_naming_a_person() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let hub = node(&root, 3, "hub", &["drive"], Some("alice@acme.example"));
        let recall = node(&root, 4, "hub", &["recall"], Some("bob@acme.example"));
        let nobody = node(&root, 5, "hub", &["drive"], None);
        let spoke = node(&root, 6, "spoke", &[], None);
        assert_eq!(op(&mut relay(None, &root), &hub, "/v1/console/invite", "{}", T0, 1).0, 409);
        let (c, _) = console("route-invite");
        let c = Arc::new(c);
        let mut st = relay(Some(c.clone()), &root);
        let (s, v) = op(&mut st, &hub, "/v1/console/invite", "{}", T0, 2);
        assert_eq!(s, 200);
        assert_eq!((v["email"].as_str(), v["origin"].as_str(), v["expires"].as_i64()), (Some("alice@acme.example"), Some(ORIGIN), Some(T0 + INVITE_MS)));
        let token = token_of(v["link"].as_str().unwrap());
        assert_eq!(v["link"].as_str().unwrap(), format!("{ORIGIN}/console/#join={token}"));
        assert_eq!(json_of(&send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0))["email"], "alice@acme.example");
        assert_eq!(op(&mut st, &recall, "/v1/console/invite", "{}", T0, 3).0, 403);
        assert_eq!(op(&mut st, &nobody, "/v1/console/invite", "{}", T0, 4).0, 403);
        assert_eq!(op(&mut st, &spoke, "/v1/console/invite", "{}", T0, 5).0, 403);
        assert_eq!(op(&mut st, &hub, "/v1/console/invite", "{\"email\":\"eve@evil.example\"}", T0, 6).0, 400);
        assert_eq!(op(&mut st, &hub, "/v1/console/invite", "{}", T0, 2).0, 401);
    }

    #[test]
    fn the_switch_and_its_preconditions() {
        let env = |v: &'static str| move |k: &str| (k == "LUCID_RELAY_CONSOLE").then(|| v.to_owned());
        let quiet = || Logger::capture("relay", Box::new(|_, _| {}));
        assert!(open(None, env(""), None, false, quiet()).unwrap().1.is_none());
        assert!(open(None, env("yes"), Some("x"), false, quiet()).err().unwrap().contains("1 (on) or 0 (off)"));
        assert!(open(None, env("1"), None, false, quiet()).err().unwrap().contains("state folder"));
        assert!(open(Some(&"1".to_string()), env(""), Some("x"), true, quiet()).err().unwrap().contains("LAN mailbox"));
        let dir = temp("switch");
        let dir = dir.parent().unwrap().to_string_lossy().into_owned();
        assert!(open(Some(&"0".to_string()), env("1"), Some(dir.as_str()), false, quiet()).unwrap().1.is_none());
        let (logger, c) = open(None, env("1"), Some(dir.as_str()), false, quiet()).unwrap();
        logger.ops("probe", &Fields::new(), Level::Info);
        let c = c.unwrap();
        assert!(c.ring.lines(&Filter { cat: None, min: Level::Debug }).iter().any(|l| l.contains("\"event\":\"probe\"")));
        std::fs::write(&c.file, "{\"v\":2}").unwrap();
        assert!(open(None, env("1"), Some(dir.as_str()), false, quiet()).err().unwrap().contains("not a control panel book"));
    }
}
