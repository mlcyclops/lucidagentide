// lucid-relay meet (ADR-0540 phase C): a drop-in for the Meeting Hub rendezvous relay `relay/meet_relay.py`. The
// same `--config relay.json` (same fields, defaults and refusals), the same `state_dir` (state.json written as
// json.dumps writes it, crl.pem with its root and signer parts, releases.json, link-reports.log), mutual TLS that
// requires a client certificate from the Meet CA and checks the CRL bundle, the identity read from the client
// certificate (CN, email SAN, device id URI, OU label), every route with the same status codes, JSON fields, error
// strings, limits and timeouts, the signer hand-off over mutual TLS, the /v1/console/* routes and the same log lines
// (`%(asctime)s %(levelname)s %(message)s` on stderr). One thread per connection and one lock for all state, as the
// Python relay (ThreadingHTTPServer, Hub.cond), so a long-poll holds its connection exactly as there.
//
//   lucid-relay meet --config /etc/lucid-meet/relay.json [--verbose]

use crate::meet_console::{Console, LinkStats, LogRing};
use crate::meet_hub::{pc, Hub};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{tls_config, RefusalLog, SignerClient};
use crate::meet_x509::{der_to_pem, Cert};
use parking_lot::{Mutex, RwLock};
use rustls::ServerConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub const POLL_WAIT: f64 = 25.0;
pub const BODY_MAX: usize = 64 * 1024;
pub const TEXT_MAX: usize = 4000;
pub const CAPTIONS_LIMIT_MAX: i64 = 500;
pub const LABEL_MAX: usize = 64;
pub const REASON_MAX: usize = 500;
pub const FINISH_SETUP: &str = "finish setting up this device first";
pub const DEVICE_URI_PREFIX: &str = "urn:lucid-meet:device:";
pub const SEED_URI_PREFIX: &str = "urn:lucid-meet:enroll:";
pub const CONSOLE_URI: &str = "urn:lucid-meet:console";
/// SAN URI of a bridge connector's certificate (contract BR-1): the /v1/bridge/c/* routes only, never a person.
pub const CONNECTOR_URI: &str = "urn:lucid-meet:connector";
pub const LEGACY_PREFIX: &str = "legacy-";
pub const CLIENT_FIELD_MAX: usize = 40;
pub const GATED_APPS: [&str; 2] = ["hub", "ios"];
pub const UNGATED_APPS: [&str; 2] = ["bot", "console"];
pub const VERSION_EXEMPT: [&str; 2] = ["console@meet.emertins.com", "testbot@emertins.com"];
pub const SERVER_VERSION: &str = "LucidMeetRelay/5";
const IDLE_TIMEOUT: f64 = POLL_WAIT + 35.0;
const LINK_REPORTS_FILE: &str = "link-reports.log";
const LINK_REPORTS_BYTES: u64 = 5 * 1024 * 1024;
const LINK_REPORTS_KEEP: u32 = 4;

// ── logging ──────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 10,
    Info = 20,
    Warning = 30,
    Error = 40,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warning => "WARNING",
            Level::Error => "ERROR",
        }
    }
}

static VERBOSE: AtomicBool = AtomicBool::new(false);
static RING: OnceLock<Arc<LogRing>> = OnceLock::new();
static LINK_REPORTS: OnceLock<Mutex<PathBuf>> = OnceLock::new();

/// logging's asctime: `2026-11-09 12:00:00,123` (UTC).
pub fn asctime(t: f64) -> String {
    let secs = t.floor() as i64;
    let ms = ((t - t.floor()) * 1000.0) as i64;
    let (y, m, d) = pj::civil(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02},{ms:03}", s / 3600, s / 60 % 60, s % 60)
}

pub fn log(level: Level, msg: &str) {
    if level < Level::Info && !VERBOSE.load(Ordering::Relaxed) {
        return;
    }
    let t = pj::now();
    let line = format!("{} {} {msg}\n", asctime(t), level.name());
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
    if level >= Level::Info {
        if let Some(ring) = RING.get() {
            ring.emit(t, level, msg);
        }
    }
}

pub fn log_debug(msg: &str) {
    log(Level::Debug, msg)
}
pub fn log_info(msg: &str) {
    log(Level::Info, msg)
}
pub fn log_warn(msg: &str) {
    log(Level::Warning, msg)
}
pub fn log_error(msg: &str) {
    log(Level::Error, msg)
}

/// One line of state_dir/link-reports.log (`%(asctime)s %(message)s`, rotated at LINK_REPORTS_BYTES, keeping
/// LINK_REPORTS_KEEP old files), when the relay has a state folder.
pub fn link_report(msg: &str) -> bool {
    let Some(file) = LINK_REPORTS.get() else { return false };
    let path = file.lock();
    let line = format!("{} {msg}\n", asctime(pj::now()));
    let size = std::fs::metadata(&*path).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + line.len() as u64 >= LINK_REPORTS_BYTES {
        let name = |i: u32| PathBuf::from(format!("{}.{i}", path.display()));
        let _ = std::fs::remove_file(name(LINK_REPORTS_KEEP));
        for i in (1..LINK_REPORTS_KEEP).rev() {
            let _ = std::fs::rename(name(i), name(i + 1));
        }
        let _ = std::fs::rename(&*path, name(1));
    }
    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(&*path) {
        let _ = fh.write_all(line.as_bytes());
    }
    true
}

pub fn link_reports_on() -> bool {
    LINK_REPORTS.get().is_some()
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────────────────────

/// The exceptions the Python handlers raise, by the status Handler._run gives them.
#[derive(Debug, Clone)]
pub enum E {
    /// PermissionError: 403 (the connection closes after the answer).
    Forbidden(String),
    /// Conflict: 409 (the connection closes).
    Conflict(String),
    /// A Conflict with `info` (a stale prefs `rev`): 409 with the info merged in after `error`.
    ConflictInfo(String, Obj),
    /// NotFound: 404.
    NotFound(String),
    /// Unavailable: 501.
    Unavailable(String),
    /// LookupError: 410.
    Gone(String),
    /// ValueError, TypeError: 400.
    Bad(String),
    /// UpdateRequired: 426 with its info.
    Update(Obj),
    /// A refusal with a status of its own (_FilesRefused: 411, 413, 507); `close`: the request body was left unread.
    Status(u16, String, bool),
    /// A PermissionError with `info` (_GuestsWait: a join the lobby holds): 403 with the info merged in.
    Held(String, Obj),
    /// _GuestsBusy: 429 on the guest port, with Retry-After seconds.
    Busy(String, u64),
    /// The client went away while its body was read: nobody to answer.
    ClientGone,
    /// Anything else: 500 (logged).
    Internal(String),
}

impl E {
    pub fn message(&self) -> String {
        match self {
            E::Forbidden(m) | E::Conflict(m) | E::NotFound(m) | E::Unavailable(m) | E::Gone(m) | E::Bad(m) | E::Internal(m) | E::Status(_, m, _) | E::Held(m, _) | E::ConflictInfo(m, _) | E::Busy(m, _) => m.clone(),
            E::Update(info) => update_message(info),
            E::ClientGone => String::new(),
        }
    }
}

pub type R<T> = Result<T, E>;

pub fn bad<T>(m: impl Into<String>) -> R<T> {
    Err(E::Bad(m.into()))
}
pub fn forbidden<T>(m: impl Into<String>) -> R<T> {
    Err(E::Forbidden(m.into()))
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────

/// relay.json (meet_relay.Settings): the same fields and defaults; unknown fields refuse to start.
#[derive(Clone, Debug)]
pub struct Settings {
    pub host: String,
    pub port: u16,
    pub cert: String,
    pub key: String,
    pub client_ca: String,
    pub crl: String,
    pub turn_secret_file: String,
    pub turn_host: String,
    pub turn_host_public: String,
    pub turn_ttl: i64,
    pub stun_urls: Vec<String>,
    pub state_dir: String,
    pub admins: Vec<String>,
    pub history_hours: f64,
    pub mail_days: f64,
    /// Channel and group chat message retention.
    pub channel_days: f64,
    pub signer_url: String,
    pub signer_cert: String,
    pub signer_key: String,
    pub signer_ca: String,
    pub files_secret_file: String,
    pub files_base: String,
    pub console_sources: Vec<String>,
    pub files_power: Obj,
    pub min_client: Obj,
    pub version_exempt: Vec<String>,
    pub recording_enabled: bool,
    /// Explicit issuer-managed membership, keyed by the authenticated certificate principal: {id, label}.
    /// A relay address or email domain never establishes organization ownership. Admins change it at runtime
    /// (/v1/admin/organizations, kept in state.json over this).
    pub organizations: Obj,
    /// Wave 3, files kept in conversations: the largest file (MB) and every kept file together (GB) in
    /// state_dir/files.
    pub file_max_mb: i64,
    pub files_quota_gb: f64,
    /// Wave 3, lobby and guests: a second HTTPS port WITHOUT client certificates serving only the guest page (/g/)
    /// and the guest API (/g/v1/*); 0 = off (checked at start, as relay.json holds it). `guest_public` is the https
    /// origin guests open; guest_cert/guest_key a publicly trusted certificate for it ("" = the relay's own).
    pub guest_port: Value,
    pub guest_public: String,
    pub guest_cert: String,
    pub guest_key: String,
    /// Wave 3, large calls: the LiveKit media server ("" = none), its API key, the file holding its API secret, the
    /// size from which a scheduled meeting or conversation call uses it, and its cap (checked at start).
    pub sfu_url: String,
    pub sfu_api_key: String,
    pub sfu_secret_file: String,
    pub sfu_threshold: Value,
    pub sfu_max: Value,
    /// Bridges (contract BR-1): each organization's bridge policy {org id: policy} ("_none" for people with no
    /// organization). A missing org is off. Checked at start (meet_bridge); admins change it at runtime
    /// (/v1/admin/bridge, kept in state.json over this).
    pub bridge_policies: Obj,
    /// Chat encryption (contract CE-1 section 13): "default" or "required" (no bridgeable conversations, no bridge
    /// links, no call chat while a web guest is here), and whether a device may share message history with another
    /// device of the same person. Kept as relay.json holds them; meet_chat_e2ee checks them at start.
    pub chat_e2ee: Value,
    pub chat_history_share: Value,
    /// Parity wave A (contract PA-1 section 10): whether calls keep an attendance list for their organizers, and for
    /// how many days (0 keeps none).
    pub attendance: bool,
    pub attendance_days: i64,
    /// PA-1 section 11: the most custom emoji the relay keeps.
    pub emoji_max: i64,
    /// Parity wave B (contract PB-1 section 5): iPhone alert pushes through APNs, off by default.
    pub push: PushSettings,
    /// A T3/T4 deployment: push may not be on.
    pub enclave: bool,
    /// Parity wave C: in an enclave, the networks (CIDR) service certificates may connect from and the signer must
    /// resolve into ([] = not limited); and legal holds (PC-1 section 3), off unless set.
    pub enclave_networks: Vec<String>,
    pub legal_holds: bool,
    /// NT-1 section 3.1: false turns message previews off for everyone on this relay (no `env` or `wrap` in any push,
    /// hello's `notify_previews: false`).
    pub notify_previews: bool,
}

/// relay.json `push`: `{enabled, team_id, key_id, key_file (the .p8, never logged), topic (the app's bundle id),
/// sandbox, voip}`. `voip`: calls ring CallKit iPhones through PushKit on `<topic>.voip` (NT-1 section 3.1).
#[derive(Clone, Debug, PartialEq)]
pub struct PushSettings {
    pub enabled: bool,
    pub team_id: String,
    pub key_id: String,
    pub key_file: String,
    pub topic: String,
    pub sandbox: bool,
    pub voip: bool,
}

impl Default for PushSettings {
    fn default() -> PushSettings {
        PushSettings { enabled: false, team_id: String::new(), key_id: String::new(), key_file: String::new(), topic: String::new(), sandbox: true, voip: false }
    }
}

const SETTINGS_FIELDS: [&str; 50] = [
    "host", "port", "cert", "key", "client_ca", "crl", "turn_secret_file", "turn_host", "turn_host_public", "turn_ttl", "stun_urls", "state_dir", "admins", "history_hours", "mail_days", "channel_days", "signer_url", "signer_cert",
    "signer_key", "signer_ca", "files_secret_file", "files_base", "console_sources", "files_power", "min_client", "version_exempt", "recording_enabled", "organizations", "file_max_mb", "files_quota_gb", "guest_port",
    "guest_public", "guest_cert", "guest_key", "sfu_url", "sfu_api_key", "sfu_secret_file", "sfu_threshold", "sfu_max",
    "bridge_policies", "chat_e2ee", "chat_history_share", "attendance", "attendance_days", "emoji_max", "push", "enclave", "enclave_networks", "legal_holds", "notify_previews",
];

/// ORG_FIELD_MAX: characters of an organization id or label.
pub const ORG_FIELD_MAX: usize = 200;
pub const ORG_ENTRY: &str = "organization membership needs principal, id and label";

/// _org_entry: one organization membership {id, label} of a lower-case principal; Err (400) when it is not exactly
/// that.
pub fn org_entry(principal: &str, owner: &Value) -> R<Obj> {
    let field_ok = |v: Option<&Value>| matches!(v, Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= ORG_FIELD_MAX);
    let ok = !principal.is_empty() && principal == principal.to_lowercase() && owner.as_object().map(|o| o.len() == 2 && field_ok(o.get("id")) && field_ok(o.get("label"))).unwrap_or(false);
    if !ok {
        return bad(ORG_ENTRY);
    }
    Ok(obj([("id", owner["id"].clone()), ("label", owner["label"].clone())]))
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            host: "127.0.0.1".into(),
            port: 443,
            cert: "/etc/lucid-meet/relay.crt".into(),
            key: "/etc/lucid-meet/relay.key".into(),
            client_ca: "/etc/lucid-meet/ca.crt".into(),
            crl: String::new(),
            turn_secret_file: "/etc/lucid-meet/turn.secret".into(),
            turn_host: String::new(),
            turn_host_public: String::new(),
            turn_ttl: 12 * 3600,
            stun_urls: Vec::new(),
            state_dir: "/var/lib/lucid-meet".into(),
            admins: Vec::new(),
            history_hours: 168.0,
            mail_days: 30.0,
            channel_days: 365.0,
            signer_url: String::new(),
            signer_cert: String::new(),
            signer_key: String::new(),
            signer_ca: String::new(),
            files_secret_file: String::new(),
            files_base: String::new(),
            console_sources: crate::meet_console::DEFAULT_SOURCES.iter().map(|s| s.to_string()).collect(),
            files_power: Obj::new(),
            min_client: Obj::new(),
            version_exempt: VERSION_EXEMPT.iter().map(|s| s.to_string()).collect(),
            recording_enabled: true,
            organizations: Obj::new(),
            file_max_mb: 100,
            files_quota_gb: 20.0,
            guest_port: Value::from(0),
            guest_public: String::new(),
            guest_cert: String::new(),
            guest_key: String::new(),
            sfu_url: String::new(),
            sfu_api_key: String::new(),
            sfu_secret_file: String::new(),
            sfu_threshold: Value::from(9),
            sfu_max: Value::from(100),
            bridge_policies: Obj::new(),
            chat_e2ee: Value::from("default"),
            chat_history_share: Value::Bool(true),
            attendance: true,
            attendance_days: 30,
            emoji_max: 500,
            push: PushSettings::default(),
            enclave: false,
            enclave_networks: Vec::new(),
            legal_holds: false,
            notify_previews: true,
        }
    }
}

/// Settings.__post_init__: the recording switch, the channel retention (a positive number of days) and each
/// organization membership {id, label} (1 to 200 characters, not blank) under a lower-case principal.
fn recording_settings(raw: &Obj, s: &mut Settings) -> Result<(), String> {
    match raw.get("recording_enabled") {
        None => {}
        Some(Value::Bool(b)) => s.recording_enabled = *b,
        Some(_) => return Err("recording_enabled must be true or false".into()),
    }
    if let Some(v) = raw.get("channel_days") {
        match pj::as_num(Some(v)) {
            Some(d) if d > 0.0 => s.channel_days = d,
            _ => return Err("channel_days must be a number of days".into()),
        }
    }
    let orgs = match raw.get("organizations") {
        None => return Ok(()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err("organizations must map certificate principals to owners".into()),
    };
    for (principal, owner) in orgs {
        org_entry(principal, owner).map_err(|e| e.message())?;
    }
    s.organizations = orgs.clone();
    Ok(())
}

/// Parity wave A settings: `attendance` (true or false), `attendance_days` and `emoji_max` (whole numbers, 0 or
/// more).
fn parity_settings(raw: &Obj, s: &mut Settings) -> Result<(), String> {
    match raw.get("attendance") {
        None => {}
        Some(Value::Bool(b)) => s.attendance = *b,
        Some(_) => return Err("attendance must be true or false".into()),
    }
    for (key, slot) in [("attendance_days", &mut s.attendance_days), ("emoji_max", &mut s.emoji_max)] {
        if let Some(v) = raw.get(key) {
            match pj::as_int(Some(v)) {
                Some(n) if n >= 0 => *slot = n,
                _ => return Err(format!("{key} must be a whole number (0 or more)")),
            }
        }
    }
    Ok(())
}

/// Parity wave B settings (contract PB-1 section 5): `enclave` (true or false) and `push` (only its six keys, the
/// switches true or false and the rest text; on, it needs team_id, key_id, key_file and topic). Push never runs on
/// an enclave relay (ADR-0174: never for T3/T4).
fn push_settings(raw: &Obj, s: &mut Settings) -> Result<(), String> {
    const SHAPE: &str = "push must be {enabled, team_id, key_id, key_file, topic, sandbox, voip}";
    match raw.get("notify_previews") {
        None => {}
        Some(Value::Bool(b)) => s.notify_previews = *b,
        Some(_) => return Err("notify_previews must be true or false".into()),
    }
    match raw.get("enclave") {
        None => {}
        Some(Value::Bool(b)) => s.enclave = *b,
        Some(_) => return Err("enclave must be true or false".into()),
    }
    // parity wave C: enclave_networks (only with enclave) and legal_holds
    s.enclave_networks = pc::networks(raw.get("enclave_networks"), s.enclave)?;
    match raw.get("legal_holds") {
        None => {}
        Some(Value::Bool(b)) => s.legal_holds = *b,
        Some(_) => return Err("legal_holds must be true or false".into()),
    }
    if let Some(v) = raw.get("push") {
        let Value::Object(o) = v else { return Err(SHAPE.into()) };
        let p = &mut s.push;
        for (k, v) in o {
            match (k.as_str(), v) {
                ("enabled", Value::Bool(b)) => p.enabled = *b,
                ("sandbox", Value::Bool(b)) => p.sandbox = *b,
                ("voip", Value::Bool(b)) => p.voip = *b,
                ("team_id", Value::String(t)) => p.team_id = t.clone(),
                ("key_id", Value::String(t)) => p.key_id = t.clone(),
                ("key_file", Value::String(t)) => p.key_file = t.clone(),
                ("topic", Value::String(t)) => p.topic = t.clone(),
                _ => return Err(SHAPE.into()),
            }
        }
        if p.enabled && [&p.team_id, &p.key_id, &p.key_file, &p.topic].iter().any(|t| t.is_empty()) {
            return Err("push needs team_id, key_id, key_file and topic".into());
        }
        if p.voip && p.topic.ends_with(".voip") {
            return Err("push.topic is the app's bundle id; the relay adds .voip for calls".into());
        }
    }
    if s.push.enabled && s.enclave {
        return Err("push cannot be enabled when enclave is true".into());
    }
    Ok(())
}

impl Settings {
    pub fn load(path: &str) -> Result<Settings, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
        let raw: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
        let raw = raw.as_object().ok_or_else(|| format!("{path}: relay settings must be a JSON object"))?;
        if raw.contains_key("recording_organizations") {
            return Err("relay settings: recording_organizations is now called organizations; rename the key in relay.json".into());
        }
        let mut unknown: Vec<&String> = raw.keys().filter(|k| !SETTINGS_FIELDS.contains(&k.as_str())).collect();
        unknown.sort();
        if !unknown.is_empty() {
            return Err(format!("unknown relay settings: {}", unknown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
        let mut s = Settings::default();
        let text = |k: &str, into: &mut String| -> Result<(), String> {
            match raw.get(k) {
                None => Ok(()),
                Some(Value::String(v)) => {
                    *into = v.clone();
                    Ok(())
                }
                Some(Value::Null) => {
                    *into = String::new();
                    Ok(())
                }
                Some(_) => Err(format!("relay settings: {k} must be text")),
            }
        };
        let list = |k: &str, into: &mut Vec<String>| -> Result<(), String> {
            match raw.get(k) {
                None => Ok(()),
                Some(Value::Array(a)) => {
                    *into = a.iter().map(pj::py_str).collect();
                    Ok(())
                }
                Some(_) => Err(format!("relay settings: {k} must be a list")),
            }
        };
        let number = |k: &str| -> Result<Option<f64>, String> {
            match raw.get(k) {
                None => Ok(None),
                Some(v) => pj::as_num(Some(v)).map(Some).ok_or_else(|| format!("relay settings: {k} must be a number")),
            }
        };
        text("host", &mut s.host)?;
        if let Some(p) = number("port")? {
            if !(0.0..=65535.0).contains(&p) {
                return Err("relay settings: port must be 0 to 65535".into());
            }
            s.port = p as u16;
        }
        text("cert", &mut s.cert)?;
        text("key", &mut s.key)?;
        text("client_ca", &mut s.client_ca)?;
        text("crl", &mut s.crl)?;
        text("turn_secret_file", &mut s.turn_secret_file)?;
        text("turn_host", &mut s.turn_host)?;
        text("turn_host_public", &mut s.turn_host_public)?;
        if let Some(t) = number("turn_ttl")? {
            s.turn_ttl = t as i64;
        }
        list("stun_urls", &mut s.stun_urls)?;
        text("state_dir", &mut s.state_dir)?;
        list("admins", &mut s.admins)?;
        if let Some(h) = number("history_hours")? {
            s.history_hours = h;
        }
        if let Some(d) = number("mail_days")? {
            s.mail_days = d;
        }
        text("signer_url", &mut s.signer_url)?;
        text("signer_cert", &mut s.signer_cert)?;
        text("signer_key", &mut s.signer_key)?;
        text("signer_ca", &mut s.signer_ca)?;
        text("files_secret_file", &mut s.files_secret_file)?;
        text("files_base", &mut s.files_base)?;
        list("console_sources", &mut s.console_sources)?;
        match raw.get("files_power") {
            None | Some(Value::Null) => {}
            Some(Value::Object(o)) => s.files_power = o.clone(),
            Some(_) => return Err("relay settings: files_power must be an object".into()),
        }
        s.min_client = minimum(raw.get("min_client"), "min_client").map_err(|e| format!("relay settings: {e}"))?;
        match raw.get("version_exempt") {
            None => {}
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => s.version_exempt = a.iter().map(pj::py_str).collect(),
            Some(_) => return Err("relay settings: version_exempt must be a list of email addresses".into()),
        }
        recording_settings(raw, &mut s)?;
        text("guest_public", &mut s.guest_public)?;
        text("guest_cert", &mut s.guest_cert)?;
        text("guest_key", &mut s.guest_key)?;
        text("sfu_url", &mut s.sfu_url)?;
        text("sfu_api_key", &mut s.sfu_api_key)?;
        text("sfu_secret_file", &mut s.sfu_secret_file)?;
        for (k, slot) in [("guest_port", &mut s.guest_port), ("sfu_threshold", &mut s.sfu_threshold), ("sfu_max", &mut s.sfu_max), ("chat_e2ee", &mut s.chat_e2ee), ("chat_history_share", &mut s.chat_history_share)] {
            if let Some(v) = raw.get(k) {
                *slot = v.clone();
            }
        }
        // _bridge_configure checks each policy at start
        match raw.get("bridge_policies") {
            None => {}
            Some(Value::Object(o)) => s.bridge_policies = o.clone(),
            Some(_) => return Err("relay settings: bridge_policies must map organization ids to policies".into()),
        }
        // _files_configure
        if let Some(v) = raw.get("file_max_mb") {
            match pj::as_int(Some(v)) {
                Some(mb) if (1..=4096).contains(&mb) => s.file_max_mb = mb,
                _ => return Err("relay settings: file_max_mb must be a whole number of megabytes from 1 to 4096".into()),
            }
        }
        if let Some(v) = raw.get("files_quota_gb") {
            match pj::as_num(Some(v)) {
                Some(gb) if gb > 0.0 => s.files_quota_gb = gb,
                _ => return Err("relay settings: files_quota_gb must be a number of gigabytes".into()),
            }
        }
        parity_settings(raw, &mut s)?;
        push_settings(raw, &mut s)?;
        Ok(s)
    }
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Identity {
    pub principal: String,
    pub name: String,
    pub serial: String,
    pub device: String,
    pub device_label: String,
    pub seed: bool,
    pub seed_token: String,
    pub console: bool,
    pub cert_pem: String,
    /// A web guest (wave 3): `guest-<16 hex>@guest.invalid`, never in the directory or presence.
    pub guest: bool,
    /// A bridge connector (SAN URI urn:lucid-meet:connector): the /v1/bridge/c/* routes only, no session; never a
    /// person.
    pub connector: bool,
    /// Parity wave C: the certificate's kind ("person", "app", "archive", "sso", "connector", "console"), only ever
    /// from its SAN URIs, and its org URIs (an app or archive has one).
    pub kind: String,
    pub orgs: Vec<String>,
}

/// Web guests' principals: `guest-<16 hex>@guest.invalid` only.
pub const GUEST_DOMAIN: &str = "@guest.invalid";

impl Identity {
    /// An app, archive or SSO service: never a person of the directory or presence.
    pub fn is_service(&self) -> bool {
        matches!(self.kind.as_str(), "app" | "archive" | "sso")
    }

    /// A device id of its own (not legacy, not in-process): one session and one seat.
    pub fn own_device(&self) -> bool {
        !self.device.is_empty() && !self.device.starts_with(LEGACY_PREFIX)
    }
}

fn is_device_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// _uri_value: the 16 hex after `prefix` in the first URI that carries one, else "".
pub fn uri_value(uris: &[String], prefix: &str) -> String {
    uris.iter().find_map(|u| u.strip_prefix(prefix).filter(|v| is_device_id(v)).map(str::to_string)).unwrap_or_default()
}

/// identity_from_cert: CN and email SAN of the verified client certificate, the device from the SAN URI (label:
/// the first OU), a seed's token, or `legacy-` plus the serial's first 16 hex.
pub fn identity_from_cert(der: Option<&[u8]>) -> R<Identity> {
    let Some(der) = der else { return forbidden("no client certificate") };
    let cert = Cert::from_der(der).ok_or_else(|| E::Forbidden("the client certificate has no name or no email".into()))?;
    let cn = cert.names.cns().last().cloned().unwrap_or_default();
    let ou = cert.names.ous().first().map(|o| pj::clip(o.trim(), LABEL_MAX)).unwrap_or_default();
    let uris = &cert.names.uris;
    let (kind, orgs) = pc::cert_kind(uris)?;
    if kind == "sso" {
        // the SSO service has no email or device: it is named by its serial, sso routes only
        let name = if cn.is_empty() { "Lucid Meet SSO".to_string() } else { cn };
        return Ok(Identity { principal: format!("sso:{}", cert.serial), name: pj::clip(name.trim(), 80), serial: cert.serial.clone(), kind, orgs, ..Default::default() });
    }
    let emails = &cert.names.emails;
    if cn.is_empty() || emails.is_empty() {
        return forbidden("the client certificate has no name or no email");
    }
    if emails[0].trim().to_lowercase().ends_with(GUEST_DOMAIN) {
        // web guests own this domain (wave 3): a certificate may never pose as one
        return forbidden("addresses ending @guest.invalid belong to web guests");
    }
    let principal = emails[0].trim().to_lowercase();
    let service = if kind == "app" || kind == "archive" { kind.as_str() } else { "" };
    if pc::service_kind(&principal) != service {
        return forbidden(pc::APPS_EMAIL);
    }
    let mut who = Identity {
        principal,
        name: pj::clip(cn.trim(), 80),
        serial: cert.serial.clone(),
        console: uris.iter().any(|u| u == CONSOLE_URI),
        connector: uris.iter().any(|u| u == CONNECTOR_URI),
        kind,
        orgs,
        ..Default::default()
    };
    let token = uri_value(uris, SEED_URI_PREFIX);
    if !token.is_empty() {
        who.seed = true;
        who.seed_token = token;
        return Ok(who);
    }
    let device = uri_value(uris, DEVICE_URI_PREFIX);
    if !device.is_empty() {
        who.device = device;
        who.device_label = ou;
    } else if !who.serial.is_empty() {
        who.device = format!("{LEGACY_PREFIX}{}", pj::clip(&who.serial, 16));
    }
    Ok(who)
}

/// The SAN URIs of the client certificate (read from the certificate itself, so a service is confined even when
/// nothing else about it would be accepted); none without one.
pub fn cert_uris(der: Option<&[u8]>) -> Vec<String> {
    der.and_then(Cert::from_der).map(|c| c.names.uris).unwrap_or_default()
}

/// from_internet: a public internet address (ipaddress is_global), an IPv4-mapped address as its IPv4 address.
pub fn from_internet(address: &str) -> bool {
    let Ok(ip) = address.parse::<IpAddr>() else { return false };
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            let in_net = |net: [u8; 4], bits: u32| -> bool {
                let a = u32::from_be_bytes(o);
                let n = u32::from_be_bytes(net);
                let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
                a & mask == n & mask
            };
            if in_net([192, 0, 0, 9], 32) || in_net([192, 0, 0, 10], 32) {
                return true;
            }
            let private = [
                ([0, 0, 0, 0], 8),
                ([10, 0, 0, 0], 8),
                ([100, 64, 0, 0], 10),
                ([127, 0, 0, 0], 8),
                ([169, 254, 0, 0], 16),
                ([172, 16, 0, 0], 12),
                ([192, 0, 0, 0], 24),
                ([192, 0, 0, 170], 31),
                ([192, 0, 2, 0], 24),
                ([192, 168, 0, 0], 16),
                ([198, 18, 0, 0], 15),
                ([198, 51, 100, 0], 24),
                ([203, 0, 113, 0], 24),
                ([240, 0, 0, 0], 4),
                ([255, 255, 255, 255], 32),
            ];
            !private.iter().any(|(n, b)| in_net(*n, *b))
        }
        IpAddr::V6(v) => {
            let seg = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || (seg[0] == 0x2001 && seg[1] == 0x0db8)
                || (seg[0] == 0x2001 && seg[1] < 0x0200)
                || (seg[0] == 0x0100 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0)
                || (seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2] == 1)
                || (seg[0] == 0 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0xffff))
        }
    }
}

/// turn_credentials: coturn REST credentials (`use-auth-secret`), the public TURN name for an internet caller.
pub fn turn_credentials(s: &Settings, secret: &[u8], who: &Identity, client_address: &str) -> Obj {
    let expiry = pj::now().floor() as i64 + s.turn_ttl;
    let username = format!("{expiry}:{}", who.principal);
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let password = pj::b64(aws_lc_rs::hmac::sign(&key, username.as_bytes()).as_ref());
    let mut servers = Vec::new();
    if !s.stun_urls.is_empty() {
        servers.push(Value::Object(obj([("urls", Value::from(s.stun_urls.clone()))])));
    }
    let mut h = s.turn_host.clone();
    if !s.turn_host_public.is_empty() && from_internet(client_address) {
        h = s.turn_host_public.clone();
    }
    if !h.is_empty() {
        servers.push(Value::Object(obj([
            ("urls", Value::from(vec![format!("turn:{h}:3478?transport=udp"), format!("turn:{h}:3478?transport=tcp"), format!("turns:{h}:5349?transport=tcp")])),
            ("username", Value::from(username)),
            ("credential", Value::from(password)),
        ])));
    }
    obj([("iceServers", Value::Array(servers)), ("expires", Value::from(expiry))])
}

// ── small checks shared by the routes ───────────────────────────────────────────────────────────────────────

pub fn principal(v: Option<&Value>) -> String {
    pj::str_or(v).trim().to_lowercase()
}

/// _serial: lower-case hex without leading zeros ("" when it is not hex).
pub fn serial(v: &str) -> String {
    let t = v.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    let t = t.replace('_', "");
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_hexdigit()) {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    let s = lower.trim_start_matches('0');
    if s.is_empty() { "0".into() } else { s.into() }
}

/// _serial of a JSON value (an int is written in hex, anything else read as hex).
pub fn serial_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) if !n.is_f64() => n.as_u64().map(|u| format!("{u:x}")).unwrap_or_default(),
        Some(Value::Bool(b)) => (*b as u8).to_string(),
        Some(other) => serial(&pj::py_str(other)),
        None => String::new(),
    }
}

pub fn room_name(v: Option<&Value>) -> R<String> {
    let room = pj::str_or(v).trim().to_lowercase();
    let b = room.as_bytes();
    let ok = !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if !ok {
        return bad("room names are 1 to 40 letters, digits or dashes");
    }
    Ok(room)
}

/// _text: a chat message, caption or direct message.
pub fn text(v: Option<&Value>, what: &str) -> R<String> {
    let t = pj::str_or(v).trim().to_string();
    if t.is_empty() {
        return bad("nothing to send");
    }
    if pj::char_len(&t) > TEXT_MAX {
        return bad(format!("{what} are limited to {TEXT_MAX} characters"));
    }
    Ok(t)
}

/// _number: float(value), finite.
pub fn number(v: Option<&Value>, what: &str) -> R<f64> {
    let out = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(*b as u8 as f64),
        Some(Value::String(s)) => py_float(s),
        _ => None,
    };
    match out {
        Some(x) if x.is_finite() => Ok(x),
        _ => bad(format!("{what} must be a number")),
    }
}

/// float(text) as Python reads it (surrounding white space, underscores between digits, inf and nan).
pub fn py_float(s: &str) -> Option<f64> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    let bare = lower.trim_start_matches(['+', '-']);
    if matches!(bare, "inf" | "infinity" | "nan") {
        return Some(if bare == "nan" { f64::NAN } else if lower.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if t.contains("__") || t.starts_with('_') || t.ends_with('_') {
        return None;
    }
    t.replace('_', "").parse::<f64>().ok().filter(|_| !t.is_empty())
}

/// int(text) as Python reads it; the ValueError text it raises.
pub fn py_int(s: &str) -> R<i64> {
    let t = s.trim();
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    let ok = !digits.is_empty() && !digits.starts_with('_') && !digits.ends_with('_') && !digits.contains("__") && digits.bytes().all(|c| c.is_ascii_digit() || c == b'_');
    if ok {
        if let Ok(n) = t.replace('_', "").parse::<i64>() {
            return Ok(n);
        }
    }
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    bad(format!("invalid literal for int() with base 10: {q}{s}{q}"))
}

/// _flag: an optional true/false field (absent or null: false).
pub fn flag(v: Option<&Value>, what: &str) -> R<bool> {
    match v {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => bad(format!("{what} must be true or false")),
    }
}

/// _weak: None when the app said nothing.
pub fn weak(v: Option<&Value>) -> R<Option<bool>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        _ => bad("weak must be true or false"),
    }
}

/// _label: a new device's label.
pub fn label(v: Option<&Value>) -> R<String> {
    let l = pj::squash(&pj::str_or(v));
    if l.is_empty() || pj::char_len(&l) > LABEL_MAX || !pj::printable(&l) {
        return bad(format!("name the new device (1 to {LABEL_MAX} characters)"));
    }
    Ok(l)
}

/// _reason: a refusal reason ("" when none was given).
pub fn reason(v: Option<&Value>) -> String {
    pj::clip(&pj::squash(&pj::str_or(v)), REASON_MAX)
}

/// _host: an own-network room's server, as an invitation carries it.
pub fn host(v: Option<&Value>) -> R<Option<Obj>> {
    let msg = "host must be {address, port, principal}";
    let h = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(o)) => o,
        _ => return bad(msg),
    };
    let address = pj::str_or(h.get("address")).trim().to_string();
    let p = principal(h.get("principal"));
    let port = pj::as_int(h.get("port"));
    if address.is_empty() || pj::char_len(&address) > 255 || p.is_empty() || pj::char_len(&p) > 320 || !matches!(port, Some(n) if n > 0 && n < 65536) {
        return bad(msg);
    }
    Ok(Some(obj([("address", Value::from(address)), ("port", Value::from(port.unwrap_or(0))), ("principal", Value::from(p))])))
}

/// _client: the `{app, version, platform}` a join or hello names: short printable words, anything else dropped.
pub fn client(v: Option<&Value>) -> Obj {
    let mut out = Obj::new();
    let Some(Value::Object(o)) = v else { return out };
    for key in ["app", "version", "platform"] {
        let item = match o.get(key) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => pj::py_str(&Value::Number(n.clone())),
            _ => continue,
        };
        let t: String = pj::squash(&item).chars().filter(|c| c.is_ascii_alphanumeric() || " ._+()/-".contains(*c)).collect();
        if !t.is_empty() {
            out.insert(key.into(), Value::from(pj::clip(&t, CLIENT_FIELD_MAX)));
        }
    }
    out
}

/// version_key: the integers in a version, trailing zeros dropped; (0,) without digits.
pub fn version_key(v: &str) -> Vec<u128> {
    let mut parts: Vec<u128> = Vec::new();
    let mut cur = String::new();
    for c in v.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            parts.push(cur.parse().unwrap_or(u128::MAX));
            cur.clear();
        }
    }
    while parts.len() > 1 && parts.last() == Some(&0) {
        parts.pop();
    }
    if parts.is_empty() {
        vec![0]
    } else {
        parts
    }
}

fn version_like(t: &str) -> bool {
    let b = t.as_bytes();
    !b.is_empty() && b.len() <= 40 && b[0].is_ascii_digit() && b.iter().all(|c| c.is_ascii_alphanumeric() || b".+-".contains(c))
}

pub fn version_ok(t: &str) -> bool {
    version_like(t)
}

/// _minimum: `{hub, ios}` (each optional); {} when absent; Err names what is wrong.
pub fn minimum(entry: Option<&Value>, what: &str) -> Result<Obj, String> {
    let o = match entry {
        None | Some(Value::Null) => return Ok(Obj::new()),
        Some(Value::Object(o)) if o.is_empty() => return Ok(Obj::new()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err(format!("{what} must be {{hub, ios}} versions, for example {{\"hub\": \"0.93.0\"}}")),
    };
    let mut out = Obj::new();
    for (app, value) in o {
        if !GATED_APPS.contains(&app.as_str()) {
            return Err(format!("{what} may only name hub and ios"));
        }
        if matches!(value, Value::Null) || value.as_str() == Some("") {
            continue;
        }
        let t = value.as_str().map(str::trim).unwrap_or("");
        if !version_like(t) {
            return Err(format!("{what}.{app} must look like 0.92.0"));
        }
        out.insert(app.clone(), Value::from(t));
    }
    Ok(out)
}

/// update_message: what an outdated app is told.
pub fn update_message(info: &Obj) -> String {
    let (m, c) = (pj::py_str(info.get("minimum").unwrap_or(&Value::Null)), pj::py_str(info.get("current").unwrap_or(&Value::Null)));
    if info.get("app").and_then(Value::as_str) == Some("ios") {
        return format!("Lucid Meet {m} or newer is required (this one is {c}). Update it in TestFlight.");
    }
    format!("Lucid Meeting Hub {m} or newer is required (this one is {c}). Update from the banner, or download it again from your invite email.")
}

/// _kv: a log line value: `-` when empty, quoted when it has spaces or quotes.
pub fn kv(v: &str) -> String {
    let t = pj::squash(v);
    if t.is_empty() {
        return "-".into();
    }
    if t.contains(' ') || t.contains('"') {
        pj::quote_text(&t)
    } else {
        t
    }
}

/// _kv of an optional JSON value.
pub fn kv_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "-".into(),
        Some(v) => kv(&pj::py_str(v)),
    }
}

pub fn key(principal: &str, device: &str) -> String {
    format!("{principal}|{device}")
}

// ── the relay server ─────────────────────────────────────────────────────────────────────────────────────────

pub struct Relay {
    pub settings: Settings,
    pub hub: Arc<Hub>,
    pub tls: RwLock<Arc<ServerConfig>>,
    pub files: Mutex<()>,
    pub refusals: RefusalLog,
    pub outdated_logged: Mutex<HashMap<String, f64>>,
    pub console: Console,
    pub turn_secret: Vec<u8>,
    pub last_fetch: Mutex<f64>,
    pub last_check: Mutex<f64>,
    /// Monotonic: when the signer CRL's age was last checked (PC-1).
    pub pc_last_crl_check: Mutex<f64>,
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn usage(err: &str) -> ! {
    eprintln!("usage: lucid-relay meet [-h] --config CONFIG [--verbose]\nlucid-relay meet: error: {err}");
    std::process::exit(2);
}

/// `lucid-relay meet --config <relay.json> [--verbose]` (meet_relay.main and serve).
pub fn main(argv: &[String]) -> ! {
    let (mut config, mut verbose) = (None, false);
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "-h" || a == "--help" {
            println!("usage: lucid-relay meet [-h] --config CONFIG [--verbose]\n\nLucid Meet relay: certificate-authenticated rendezvous for Meeting Hub calls.\n\noptions:\n  -h, --help       show this help message and exit\n  --config CONFIG  relay.json\n  --verbose");
            std::process::exit(0);
        } else if a == "--verbose" {
            verbose = true;
        } else if let Some(v) = a.strip_prefix("--config=") {
            config = Some(v.to_string());
        } else if a == "--config" {
            i += 1;
            config = Some(argv.get(i).cloned().unwrap_or_else(|| usage("argument --config: expected one argument")));
        } else {
            usage(&format!("unrecognized arguments: {a}"));
        }
        i += 1;
    }
    let config = config.unwrap_or_else(|| usage("the following arguments are required: --config"));
    VERBOSE.store(verbose, Ordering::Relaxed);
    let settings = Settings::load(&config).unwrap_or_else(|e| die(&e));
    serve(settings)
}

/// pc_enclave_start: PC-1 invariant 4 at start: in an enclave with `enclave_networks` the signer must resolve only
/// inside them (the relay does not start otherwise), and one line says what is refused.
fn pc_enclave_start(s: &Settings) {
    use std::net::ToSocketAddrs;
    if !s.enclave {
        return;
    }
    let nets = &s.enclave_networks;
    if !nets.is_empty() && !s.signer_url.is_empty() {
        let rest = s.signer_url.split_once("://").map(|(_, r)| r).unwrap_or(&s.signer_url);
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let authority = authority.rsplit('@').next().unwrap_or_default();
        let host = match authority.strip_prefix('[') {
            Some(h) => h.split(']').next().unwrap_or_default(),
            None => authority.split(':').next().unwrap_or_default(),
        }
        .to_lowercase();
        let mut found: Vec<String> = match (host.as_str(), 0).to_socket_addrs() {
            Ok(addrs) => addrs.map(|a| a.ip().to_string()).collect(),
            Err(e) => die(&format!("enclave: the signer {host} cannot be resolved ({e})")),
        };
        found.sort();
        found.dedup();
        let outside: Vec<String> = found.into_iter().filter(|a| !pc::inside(a, nets)).collect();
        if !outside.is_empty() {
            die(&format!("enclave: the signer {host} resolves outside enclave_networks ({})", outside.join(", ")));
        }
    }
    let mut line = String::from("enclave: on; refused: bridges, bridgeable conversations, push");
    if !nets.is_empty() {
        line.push_str("; service connections limited to ");
        line.push_str(&nets.join(", "));
    }
    log_info(&line);
}

fn serve(settings: Settings) -> ! {
    let secret = match std::fs::read(&settings.turn_secret_file) {
        Ok(b) => {
            let t = String::from_utf8_lossy(&b).trim_matches(|c: char| c.is_ascii_whitespace()).as_bytes().to_vec();
            t
        }
        Err(e) => die(&format!("cannot read the TURN secret {}: {e}", settings.turn_secret_file)),
    };
    if secret.len() < 16 {
        die("the TURN secret is missing or shorter than 16 bytes");
    }
    pc_enclave_start(&settings);
    let signer = if settings.signer_url.is_empty() {
        None
    } else {
        let ca = if settings.signer_ca.is_empty() { &settings.client_ca } else { &settings.signer_ca };
        Some(Arc::new(SignerClient::new(&settings.signer_url, &settings.signer_cert, &settings.signer_key, ca).unwrap_or_else(|e| die(&e))))
    };
    let links = Arc::new(LinkStats::new());
    let state_dir = (!settings.state_dir.is_empty()).then(|| PathBuf::from(&settings.state_dir));
    let hub = Arc::new(Hub::new(state_dir.clone(), &settings.admins, settings.history_hours, settings.mail_days, settings.channel_days, signer.clone(), links.clone()));
    {
        let mut st = hub.st.lock();
        st.recording_enabled = settings.recording_enabled;
        st.organizations = settings.organizations.clone();
    }
    // before the slices: the bridge reads the enclave
    hub.pc_configure(&settings);
    hub.wave3_configure(&settings).unwrap_or_else(|e| die(&e));
    hub.push_configure(&settings);
    let tls = tls_config(&settings).unwrap_or_else(|e| die(&e));
    let listener = TcpListener::bind((settings.host.as_str(), settings.port)).unwrap_or_else(|e| die(&format!("cannot listen on {}:{}: {e}", settings.host, settings.port)));
    let console = Console::new(&settings, links).unwrap_or_else(|e| die(&e));
    let ring = console.ring.clone();
    let relay = Arc::new(Relay {
        settings: settings.clone(),
        hub: hub.clone(),
        tls: RwLock::new(tls),
        files: Mutex::new(()),
        refusals: RefusalLog::new(),
        outdated_logged: Mutex::new(HashMap::new()),
        console,
        turn_secret: secret,
        last_fetch: Mutex::new(-1e9),
        last_check: Mutex::new(-1e9),
        pc_last_crl_check: Mutex::new(-1e9),
    });
    {
        // the service gate reads the relay's version minimums
        let weak = Arc::downgrade(&relay);
        hub.pc_set_minimums(Arc::new(move || weak.upgrade().map(|r| r.minimums(&r.release())).unwrap_or_default()));
    }
    relay.prepare_bundle();
    if let Some(signer) = &signer {
        let weak = Arc::downgrade(&relay);
        let hook: crate::meet_tls::OnStatus = Arc::new(move |status: &Obj| {
            if let Some(r) = weak.upgrade() {
                r.adopt_signer_root(status);
            }
        });
        *signer.on_status.lock() = Some(hook);
    }
    let _ = RING.set(ring);
    if let Some(dir) = &state_dir {
        let _ = std::fs::create_dir_all(dir);
        let _ = LINK_REPORTS.set(Mutex::new(dir.join(LINK_REPORTS_FILE)));
    }
    hub.start();
    crate::meet_guest_port::start(&settings, hub.clone(), relay.turn_secret.clone()).unwrap_or_else(|e| die(&e));
    relay.start_upkeep();
    log_info(&format!(
        "listening on {}:{} (certificate server: {})",
        settings.host,
        settings.port,
        if settings.signer_url.is_empty() { "none, the issuer's PC signs" } else { &settings.signer_url }
    ));
    let accepting = relay.clone();
    std::thread::Builder::new()
        .name("relay-accept".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let r = accepting.clone();
                let _ = std::thread::Builder::new().name("relay-conn".into()).spawn(move || serve_conn(r, tcp, peer));
            }
        })
        .unwrap_or_else(|e| die(&e.to_string()));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| die(&e.to_string()));
    runtime.block_on(stop_signal());
    hub.close();
    std::process::exit(0);
}

#[cfg(unix)]
async fn stop_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv() => {},
    }
}

#[cfg(not(unix))]
async fn stop_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

// ── HTTP/1.1 over the mutual-TLS connection ──────────────────────────────────────────────────────────────────

pub(crate) type Tls = rustls::StreamOwned<rustls::ServerConnection, TcpStream>;

/// A client address as the handlers name it (an IPv4-mapped IPv6 address as `::ffff:a.b.c.d`).
pub(crate) fn address_of(peer: &SocketAddr) -> String {
    match peer.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(|v4| format!("::ffff:{v4}")).unwrap_or_else(|| v6.to_string()),
        v4 => v4.to_string(),
    }
}

pub(crate) fn quiet_end(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(e.kind(), UnexpectedEof | TimedOut | WouldBlock)
}

fn serve_conn(relay: Arc<Relay>, mut tcp: TcpStream, peer: SocketAddr) {
    let address = address_of(&peer);
    let idle = Duration::from_secs_f64(IDLE_TIMEOUT);
    let _ = tcp.set_read_timeout(Some(idle));
    let _ = tcp.set_write_timeout(Some(idle));
    let cfg = relay.tls.read().clone();
    let Ok(mut conn) = rustls::ServerConnection::new(cfg) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            relay.refusals.note(&address);
            return;
        }
    }
    let der = conn.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    loop {
        match one_request(&relay, &mut reader, &address, der.as_deref()) {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                if !quiet_end(&e) {
                    relay.refusals.note(&address);
                }
                break;
            }
        }
    }
    let tls = reader.get_mut();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

pub(crate) fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        301 => "Moved Permanently",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Request Entity Too Large",
        414 => "Request-URI Too Long",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        505 => "HTTP Version Not Supported",
        507 => "Insufficient Storage",
        _ => "",
    }
}

/// email.utils.formatdate(usegmt=True).
pub(crate) fn http_date() -> String {
    let secs = pj::now().floor() as i64;
    let days = secs.div_euclid(86_400);
    let (y, m, d) = pj::civil(days);
    let wd = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
    let t = secs.rem_euclid(86_400);
    format!("{wd}, {d:02} {mon} {y:04} {:02}:{:02}:{:02} GMT", t / 3600, t / 60 % 60, t % 60)
}

fn write_response(w: &mut impl Write, status: u16, content_type: &str, body: &[u8], extra: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\n{extra}Content-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n",
        reason_phrase(status),
        http_date(),
        body.len()
    );
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    w.write_all(&out)?;
    w.flush()
}

/// BaseHTTPRequestHandler.send_error's answer (HTML), the connection closing after it.
pub(crate) fn send_error(w: &mut impl Write, status: u16, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!DOCTYPE HTML>\n<html lang=\"en\">\n    <head>\n        <meta charset=\"utf-8\">\n        <title>Error response</title>\n    </head>\n    <body>\n        <h1>Error response</h1>\n        <p>Error code: {status}</p>\n        <p>Message: {message}.</p>\n    </body>\n</html>\n"
    );
    let head = format!(
        "HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\nConnection: close\r\nContent-Type: text/html;charset=utf-8\r\nContent-Length: {}\r\n\r\n",
        reason_phrase(status),
        http_date(),
        body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(body.as_bytes())?;
    w.flush()
}

pub(crate) fn read_line_limited(r: &mut impl BufRead, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok((out, false));
        }
        let room = limit + 1 - out.len();
        let take = buf.len().min(room);
        if let Some(i) = buf[..take].iter().position(|&c| c == b'\n') {
            out.extend_from_slice(&buf[..=i]);
            r.consume(i + 1);
            return Ok((out, false));
        }
        out.extend_from_slice(&buf[..take]);
        r.consume(take);
        if out.len() > limit {
            return Ok((out, true));
        }
    }
}

/// %XX and `+` decoding (unquote_plus), invalid UTF-8 replaced.
fn unquote_plus(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// parse_qs: blank values dropped; the first value of a name wins when read.
pub(crate) fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter_map(|field| {
            let (k, v) = field.split_once('=')?;
            let v = unquote_plus(v);
            (!v.is_empty()).then(|| (unquote_plus(k), v))
        })
        .collect()
}

/// The head of one request as BaseHTTPRequestHandler reads it: its line, method, target, headers (names lower case)
/// and whether the connection closes after it.
pub(crate) struct Head {
    pub requestline: String,
    pub method: String,
    pub target: String,
    pub close: bool,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    /// The path and the query (without a fragment).
    pub fn path_query(&self) -> (String, String) {
        match self.target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.split('#').next().unwrap_or_default().to_string()),
            None => (self.target.split('#').next().unwrap_or_default().to_string(), String::new()),
        }
    }
}

/// One request and its answer; Ok(false) when the connection closes after it.
fn one_request(relay: &Arc<Relay>, reader: &mut BufReader<Tls>, address: &str, der: Option<&[u8]>) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    if head.method != "GET" && head.method != "POST" {
        send_error(reader.get_mut(), 501, &format!("Unsupported method ({:?})", head.method))?;
        return Ok(false);
    }
    let (path, query) = head.path_query();
    let mut ctx = Ctx {
        relay,
        address: address.to_string(),
        der,
        path: path.clone(),
        query: parse_query(&query),
        content_length: head.header("content-length"),
        transfer_encoding: head.header("transfer-encoding").filter(|v| !v.is_empty()),
        reader: &mut *reader,
        body_read: false,
        close: false,
        raw: None,
    };
    let answer = crate::meet_routes::dispatch(&mut ctx, &head.method);
    let raw = ctx.raw.take();
    let (body_read, closing) = (ctx.body_read, ctx.close);
    let close = drain_unread(reader, &head, body_read) || head.close || closing;
    let requestline = &head.requestline;
    let (status, payload) = match answer {
        Some(a) => a,
        None => return Ok(false),
    };
    if let Some(raw) = raw {
        // the route answered itself (raw bytes)
        let keep = match raw {
            Raw::File(file) => send_file(reader.get_mut(), file, &path, der),
            Raw::Bytes(headers, body) => send_bytes(reader.get_mut(), &headers, &body, &path, der),
        };
        log_debug(&format!("{address} \"{requestline}\" {status} -"));
        return Ok(keep && !close);
    }
    let body = pj::dumps(&Value::Object(payload));
    if let Err(e) = write_response(reader.get_mut(), status, "application/json", body.as_bytes(), "") {
        if is_client_gone(&e) {
            gone(&path, der);
            return Ok(false);
        }
        return Err(e);
    }
    log_debug(&format!("{address} \"{requestline}\" {status} -"));
    Ok(!close)
}

/// A body never read (a refusal before it) is read away (up to 1 MiB) so closing does not reset the connection under
/// the answer; true when there was one (the connection then closes after the answer).
pub(crate) fn drain_unread(reader: &mut BufReader<Tls>, head: &Head, body_read: bool) -> bool {
    let length = head.header("content-length").and_then(|l| l.trim().parse::<u64>().ok()).filter(|n| *n > 0);
    let Some(n) = length.filter(|_| !body_read) else { return false };
    if n <= 1 << 20 {
        let _ = std::io::copy(&mut (&mut *reader).take(n), &mut std::io::sink());
    }
    true
}

/// read_head: a request's line and headers; None when the connection ends now (nothing came, or the error answer was
/// sent).
pub(crate) fn read_head(reader: &mut BufReader<Tls>) -> std::io::Result<Option<Head>> {
    let (raw, long) = read_line_limited(reader, 65536)?;
    if long {
        send_error(reader.get_mut(), 414, "Request-URI Too Long")?;
        return Ok(None);
    }
    if raw.is_empty() {
        return Ok(None);
    }
    let requestline: String = raw.iter().map(|&c| c as char).collect::<String>().trim_end_matches(['\r', '\n']).to_string();
    let words: Vec<&str> = requestline.split_whitespace().collect();
    if words.is_empty() {
        return Ok(None);
    }
    let mut close = true;
    let mut version = "HTTP/0.9";
    if words.len() >= 3 {
        version = words[words.len() - 1];
        let ok = version.strip_prefix("HTTP/").and_then(|v| v.split_once('.')).map(|(a, b)| (a.parse::<u32>(), b.parse::<u32>()));
        match ok {
            Some((Ok(major), Ok(minor))) => {
                if major >= 2 {
                    send_error(reader.get_mut(), 505, &format!("Invalid HTTP version ({major}.{minor})"))?;
                    return Ok(None);
                }
                if (major, minor) >= (1, 1) {
                    close = false;
                }
            }
            _ => {
                send_error(reader.get_mut(), 400, &format!("Bad request version ({version:?})"))?;
                return Ok(None);
            }
        }
    }
    if words.len() != 3 {
        send_error(reader.get_mut(), 400, &format!("Bad request syntax ({requestline:?})"))?;
        return Ok(None);
    }
    let (method, mut target) = (words[0].to_string(), words[1].to_string());
    if target.starts_with("//") {
        target = format!("/{}", target.trim_start_matches('/'));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let (line, long) = read_line_limited(reader, 65536)?;
        if long {
            send_error(reader.get_mut(), 431, "Line too long")?;
            return Ok(None);
        }
        if line.is_empty() {
            break;
        }
        let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string();
        if text.is_empty() {
            break;
        }
        if headers.len() >= 100 {
            send_error(reader.get_mut(), 431, "Too many headers")?;
            return Ok(None);
        }
        if let Some((k, v)) = text.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let keep_alive_ok = version >= "HTTP/1.1";
    let mut head = Head { requestline: requestline.clone(), method, target, close, headers };
    match head.header("connection").map(|v| v.to_ascii_lowercase()) {
        Some(c) if c == "close" => head.close = true,
        Some(c) if c == "keep-alive" && keep_alive_ok => head.close = false,
        _ => {}
    }
    Ok(Some(head))
}

pub(crate) fn is_client_gone(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(e.kind(), BrokenPipe | ConnectionReset | ConnectionAborted | UnexpectedEof | TimedOut | WouldBlock)
}

/// _gone: one INFO line for a client that went away, never a traceback.
pub fn gone(path: &str, der: Option<&[u8]>) {
    let principal = identity_from_cert(der).map(|w| w.principal).unwrap_or_else(|_| "-".into());
    log_info(&format!("client gone path={path} principal={principal}"));
}

/// Bytes `GET /v1/files/get` writes to the socket at a time (FILES_SEND).
const FILE_SEND: usize = 64 * 1024;

/// The answer of a route that sends raw bytes itself (Handler._run with a route returning None): its headers after
/// the status line, Server and Date, then the part of an open file or the bytes it sends.
pub enum Raw {
    File(RawFile),
    Bytes(Vec<(&'static str, String)>, Vec<u8>),
}

/// The part of an open file a raw answer sends (`GET /v1/files/get`).
pub struct RawFile {
    pub headers: Vec<(&'static str, String)>,
    pub file: std::fs::File,
    pub offset: u64,
    pub count: u64,
    /// For the log lines: the file's id and who fetched it.
    pub id: String,
    pub principal: String,
}

/// Send a raw answer held in memory; false when the connection ends after it (the client went away).
fn send_bytes(w: &mut Tls, headers: &[(&'static str, String)], body: &[u8], path: &str, der: Option<&[u8]>) -> bool {
    let mut head = format!("HTTP/1.1 200 {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\n", reason_phrase(200), http_date());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    match w.write_all(head.as_bytes()).and_then(|()| w.write_all(body)).and_then(|()| w.flush()) {
        Ok(()) => true,
        Err(e) => {
            if is_client_gone(&e) {
                gone(path, der);
            } else {
                log_warn(&format!("{path} failed: {e}"));
            }
            false
        }
    }
}

/// Send a raw answer, FILE_SEND bytes at a time; false when the connection ends after it (a file shorter than
/// promised, or a failure once the answer has begun: no JSON error can follow).
fn send_file(w: &mut Tls, mut raw: RawFile, path: &str, der: Option<&[u8]>) -> bool {
    let mut head = format!("HTTP/1.1 200 {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\n", reason_phrase(200), http_date());
    for (k, v) in &raw.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut whole = true;
    let sent = (|| -> std::io::Result<()> {
        w.write_all(head.as_bytes())?;
        raw.file.seek(SeekFrom::Start(raw.offset))?;
        let mut buf = vec![0u8; FILE_SEND.min(raw.count as usize)];
        let mut left = raw.count;
        while left > 0 {
            let want = buf.len().min(left as usize);
            let n = raw.file.read(&mut buf[..want])?;
            if n == 0 {
                whole = false; // shorter than promised: end it
                break;
            }
            w.write_all(&buf[..n])?;
            left -= n as u64;
        }
        w.flush()
    })();
    match sent {
        Ok(()) => {
            log_info(&format!("files_get id={} principal={} offset={} bytes={}", raw.id, raw.principal, raw.offset, raw.count));
            whole
        }
        Err(e) if is_client_gone(&e) => {
            gone(path, der);
            false
        }
        Err(e) => {
            log_warn(&format!("files_get id={} failed: {e}", raw.id));
            false
        }
    }
}

/// One request: the caller's address and certificate, its query and its body (read on demand).
pub struct Ctx<'a> {
    pub relay: &'a Arc<Relay>,
    pub address: String,
    pub der: Option<&'a [u8]>,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub content_length: Option<String>,
    /// The Transfer-Encoding header, when the request has a non-empty one.
    pub transfer_encoding: Option<String>,
    reader: &'a mut BufReader<Tls>,
    pub body_read: bool,
    pub close: bool,
    /// Set by a route that answers raw bytes itself (its JSON answer is then not sent).
    pub raw: Option<Raw>,
}

impl Ctx<'_> {
    /// `(query.get(name) or [default])[0]`.
    pub fn q(&self, name: &str, default: &str) -> String {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap_or_else(|| default.to_string())
    }

    /// _who: the caller. A seed certificate may only use the routes that pass `seed_ok`.
    pub fn who(&self, seed_ok: bool) -> R<Identity> {
        let mut who = identity_from_cert(self.der)?;
        if !who.serial.is_empty() && self.relay.hub.is_denied(&who.serial) {
            return forbidden("this certificate was revoked");
        }
        if who.seed && !seed_ok {
            return forbidden(FINISH_SETUP);
        }
        if let Some(der) = self.der {
            who.cert_pem = der_to_pem(der);
        }
        Ok(who)
    }

    /// _body: the JSON object a POST carries ({} without one).
    pub fn body(&mut self) -> R<Obj> {
        self.body_max(BODY_MAX)
    }

    /// _body(most): the JSON object a POST carries, of at most `most` bytes.
    pub fn body_max(&mut self, most: usize) -> R<Obj> {
        let text = self.content_length.clone().unwrap_or_default();
        let length = if text.trim().is_empty() { 0 } else { py_int(&text)? };
        if length <= 0 {
            self.body_read = true;
            return Ok(Obj::new());
        }
        if length as usize > most {
            return bad("request too large");
        }
        let mut raw = vec![0u8; length as usize];
        let mut got = 0;
        while got < raw.len() {
            match self.reader.read(&mut raw[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if is_client_gone(&e) => return Err(E::ClientGone),
                Err(_) => return Err(E::ClientGone),
            }
        }
        raw.truncate(got);
        self.body_read = true;
        let text = std::str::from_utf8(&raw).map_err(|e| E::Bad(format!("'utf-8' codec can't decode bytes: {e}")))?;
        let data: Value = serde_json::from_str(text).map_err(|e| E::Bad(json_error(&e, text)))?;
        match data {
            Value::Object(o) => Ok(o),
            _ => bad("the body must be a JSON object"),
        }
    }

    /// `rfile.read(length)`: a raw body of exactly `length` bytes (the caller caps it); ClientGone when it ends early.
    pub fn raw_body(&mut self, length: usize) -> R<Vec<u8>> {
        self.body_read = true;
        let mut raw = vec![0u8; length];
        let mut got = 0;
        while got < length {
            match self.reader.read(&mut raw[got..]) {
                Ok(0) => return Err(E::ClientGone),
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(E::ClientGone),
            }
        }
        Ok(raw)
    }

    /// _gate: 426 when the caller's app is older than the minimum for it. The app is the `client` the request
    /// carries (a join), else the one its room `peer` or presence `session` said.
    pub fn gate(&self, who: &Identity, client_given: Option<&Value>, peer: &str, session: &str) -> R<()> {
        let c = match client_given {
            Some(c) => client(Some(c)),
            None => match self.relay.hub.client_of(who, peer, session) {
                None => return Ok(()),
                Some(c) => client(Some(&Value::Object(c))),
            },
        };
        if let Some(info) = self.relay.outdated(who, &c) {
            self.relay.note_outdated(who, &info);
            return Err(E::Update(info));
        }
        Ok(())
    }
}

/// json.JSONDecodeError's text for the common cases (`Expecting value: line 1 column 1 (char 0)`).
pub(crate) fn json_error(e: &serde_json::Error, text: &str) -> String {
    let (line, col) = (e.line(), e.column());
    let pos: usize = text.split_inclusive('\n').take(line.saturating_sub(1)).map(|l| l.chars().count()).sum::<usize>() + col.saturating_sub(1);
    let what = if text.trim().is_empty() || matches!(e.classify(), serde_json::error::Category::Eof) { "Expecting value" } else if e.to_string().starts_with("trailing") { "Extra data" } else { "Expecting value" };
    format!("{what}: line {line} column {} (char {pos})", col.max(1))
}

/// The answer of a route: Python's Handler._run mapping from an error to a status and a JSON payload. None when the
/// client went away (nothing is sent).
pub fn run(ctx: &mut Ctx, result: std::thread::Result<R<Obj>>) -> Option<(u16, Obj)> {
    let result = match result {
        Ok(r) => r,
        Err(p) => {
            let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            Err(E::Internal(msg))
        }
    };
    let err = |m: String| obj([("error", Value::from(m))]);
    Some(match result {
        Ok(o) => (200, o),
        Err(E::ClientGone) => {
            ctx.close = true;
            gone(&ctx.path, ctx.der);
            return None;
        }
        Err(E::Update(info)) => {
            let mut o = info.clone();
            o.insert("error".into(), Value::from(update_message(&info)));
            o.insert("code".into(), Value::from("update_required"));
            (426, o)
        }
        Err(E::Forbidden(m)) => {
            ctx.close = true;
            (403, err(m))
        }
        Err(E::Conflict(m)) => {
            ctx.close = true;
            (409, err(m))
        }
        Err(E::ConflictInfo(m, info)) => {
            ctx.close = true;
            let mut o = err(m);
            o.extend(info);
            (409, o)
        }
        Err(E::Status(status, m, close)) => {
            ctx.close |= close;
            (status, err(m))
        }
        Err(E::Held(m, info)) => {
            ctx.close = true;
            let mut o = info;
            o.insert("error".into(), Value::from(m));
            (403, o)
        }
        Err(E::Busy(m, _)) => {
            ctx.close = true;
            (429, err(m))
        }
        Err(E::NotFound(m)) => (404, err(m)),
        Err(E::Unavailable(m)) => (501, err(m)),
        Err(E::Gone(m)) => (410, err(m)),
        Err(E::Bad(m)) => (400, err(m)),
        Err(E::Internal(m)) => {
            log_error(&format!("request failed\n{m}"));
            (500, err("the relay failed this request".into()))
        }
    })
}

/// A path under the state folder.
pub fn state_file(s: &Settings, name: &str) -> Option<PathBuf> {
    (!s.state_dir.is_empty()).then(|| Path::new(&s.state_dir).join(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_compare_as_the_updater_does() {
        assert_eq!(version_key("0.91-ausa.16"), vec![0, 91, 16]);
        assert_eq!(version_key("0.93"), version_key("0.93.0"));
        assert_eq!(version_key("x"), vec![0]);
        assert!(version_key("0.92.0") < version_key("0.93.0"));
    }

    #[test]
    fn recording_settings_are_checked_as_python_does() {
        let check = |v: Value| {
            let mut s = Settings::default();
            recording_settings(v.as_object().unwrap(), &mut s).map(|_| s)
        };
        let s = check(json!({})).unwrap();
        assert!(s.recording_enabled && s.organizations.is_empty());
        let s = check(json!({"recording_enabled": false, "organizations": {"ann@x": {"id": "org-1", "label": "Org"}}})).unwrap();
        assert!(!s.recording_enabled);
        assert_eq!(s.organizations["ann@x"], json!({"id": "org-1", "label": "Org"}));
        for wrong in [json!({"recording_enabled": 1}), json!({"recording_enabled": null})] {
            assert_eq!(check(wrong).unwrap_err(), "recording_enabled must be true or false");
        }
        assert_eq!(check(json!({"channel_days": 30})).unwrap().channel_days, 30.0);
        for wrong in [json!({"channel_days": 0}), json!({"channel_days": true}), json!({"channel_days": null}), json!({"channel_days": "365"})] {
            assert_eq!(check(wrong).unwrap_err(), "channel_days must be a number of days");
        }
        for wrong in [json!({"organizations": []}), json!({"organizations": null})] {
            assert_eq!(check(wrong).unwrap_err(), "organizations must map certificate principals to owners");
        }
        let long = "x".repeat(201);
        for owner in [json!({"Ann@x": {"id": "o", "label": "O"}}), json!({"": {"id": "o", "label": "O"}}), json!({"ann@x": {"id": "o"}}), json!({"ann@x": {"id": "o", "label": "O", "x": "y"}}), json!({"ann@x": {"id": " ", "label": "O"}}), json!({"ann@x": {"id": 1, "label": "O"}}), json!({"ann@x": {"id": long, "label": "O"}}), json!({"ann@x": "org"})] {
            assert_eq!(check(json!({"organizations": owner})).unwrap_err(), "organization membership needs principal, id and label");
        }
    }

    #[test]
    fn parity_settings_are_checked_as_python_does() {
        let check = |v: Value| {
            let mut s = Settings::default();
            parity_settings(v.as_object().unwrap(), &mut s).map(|_| s)
        };
        let s = check(json!({})).unwrap();
        assert_eq!((s.attendance, s.attendance_days, s.emoji_max), (true, 30, 500));
        let s = check(json!({"attendance": false, "attendance_days": 0, "emoji_max": 20})).unwrap();
        assert_eq!((s.attendance, s.attendance_days, s.emoji_max), (false, 0, 20));
        for wrong in [json!({"attendance": 1}), json!({"attendance": null})] {
            assert_eq!(check(wrong).unwrap_err(), "attendance must be true or false");
        }
        for wrong in [json!(-1), json!(1.5), json!(true), json!("30"), Value::Null] {
            assert_eq!(check(json!({"attendance_days": wrong})).unwrap_err(), "attendance_days must be a whole number (0 or more)");
            assert_eq!(check(json!({"emoji_max": wrong})).unwrap_err(), "emoji_max must be a whole number (0 or more)");
        }
    }

    #[test]
    fn push_settings_are_checked_as_python_does() {
        let check = |v: Value| {
            let mut s = Settings::default();
            push_settings(v.as_object().unwrap(), &mut s).map(|_| s)
        };
        let s = check(json!({})).unwrap();
        assert_eq!((s.push.clone(), s.enclave), (PushSettings::default(), false));
        assert!(s.push.sandbox && !s.push.enabled);
        let on = json!({"enabled": true, "team_id": "T", "key_id": "K", "key_file": "/k.p8", "topic": "com.x", "sandbox": false});
        let s = check(json!({"push": on})).unwrap();
        assert_eq!(s.push, PushSettings { enabled: true, team_id: "T".into(), key_id: "K".into(), key_file: "/k.p8".into(), topic: "com.x".into(), sandbox: false, voip: false });
        // NT-1 section 3.1: voip, with the app's bundle id as the topic; notify_previews
        let mut voip = on.clone();
        voip["voip"] = json!(true);
        assert!(check(json!({"push": voip})).unwrap().push.voip);
        voip["topic"] = json!("com.x.voip");
        assert_eq!(check(json!({"push": voip})).unwrap_err(), "push.topic is the app's bundle id; the relay adds .voip for calls");
        assert!(check(json!({})).unwrap().notify_previews);
        assert!(!check(json!({"notify_previews": false})).unwrap().notify_previews);
        for wrong in [json!(0), json!("false"), Value::Null] {
            assert_eq!(check(json!({"notify_previews": wrong})).unwrap_err(), "notify_previews must be true or false");
        }
        // off with nothing else set, or partly set, is fine
        assert!(check(json!({"push": {"enabled": false}, "enclave": true})).is_ok());
        assert!(check(json!({"push": {"topic": "com.x"}})).is_ok());
        for wrong in [json!([]), json!(null), json!({"enabled": 1}), json!({"sandbox": "yes"}), json!({"voip": "yes"}), json!({"topic": 1}), json!({"key_file": null}), json!({"url": "x"})] {
            assert_eq!(check(json!({"push": wrong})).unwrap_err(), "push must be {enabled, team_id, key_id, key_file, topic, sandbox, voip}");
        }
        for missing in ["team_id", "key_id", "key_file", "topic"] {
            let mut p = on.clone();
            p[missing] = json!("");
            assert_eq!(check(json!({"push": p})).unwrap_err(), "push needs team_id, key_id, key_file and topic");
        }
        for wrong in [json!(1), json!("true"), Value::Null] {
            assert_eq!(check(json!({"enclave": wrong})).unwrap_err(), "enclave must be true or false");
        }
        assert_eq!(check(json!({"push": on, "enclave": true})).unwrap_err(), "push cannot be enabled when enclave is true");
    }

    #[test]
    fn minimum_and_update_message() {
        assert_eq!(minimum(Some(&json!({"hub": "0.93.0", "ios": ""})), "min_client").unwrap().len(), 1);
        assert_eq!(minimum(Some(&json!({"mac": "1"})), "min_client").unwrap_err(), "min_client may only name hub and ios");
        assert_eq!(minimum(Some(&json!({"hub": "x"})), "minimum").unwrap_err(), "minimum.hub must look like 0.92.0");
        let info = json!({"app": "hub", "current": "0.92.0", "minimum": "0.93.0"});
        assert_eq!(
            update_message(info.as_object().unwrap()),
            "Lucid Meeting Hub 0.93.0 or newer is required (this one is 0.92.0). Update from the banner, or download it again from your invite email."
        );
    }

    #[test]
    fn client_fields_and_log_values() {
        let c = client(Some(&json!({"app": "hub", "version": "0.93.0 <b>", "platform": true})));
        assert_eq!(pj::dumps(&Value::Object(c)), "{\"app\": \"hub\", \"version\": \"0.93.0 b\"}");
        assert_eq!(kv(""), "-");
        assert_eq!(kv("Ann's PC"), "\"Ann's PC\"");
        assert_eq!(kv("mac"), "mac");
    }

    #[test]
    fn rooms_numbers_and_internet() {
        assert_eq!(room_name(Some(&json!(" Ops "))).unwrap(), "ops");
        assert!(room_name(Some(&json!("-x"))).is_err());
        assert_eq!(py_int(" 12 ").unwrap(), 12);
        assert_eq!(py_int("x").unwrap_err().message(), "invalid literal for int() with base 10: 'x'");
        assert!(from_internet("8.8.8.8"));
        assert!(!from_internet("10.1.2.3"));
        assert!(!from_internet("100.64.0.1"));
        assert!(from_internet("::ffff:8.8.8.8"));
        assert_eq!(serial("0A1b"), "a1b");
    }

    #[test]
    fn query_and_dates() {
        assert_eq!(parse_query("a=1&b=&c=x+y%21"), vec![("a".to_string(), "1".to_string()), ("c".to_string(), "x y!".to_string())]);
        assert_eq!(asctime(0.5), "1970-01-01 00:00:00,500");
    }
}
