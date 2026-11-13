// Structured log lines exactly as the add-on's src/log.ts writes them: one JSON object per line,
// `{ ts, level, cat, component, event, ...fields }`, debug and info on stdout, warn and error on stderr, security lines
// whatever LUCID_LOG_LEVEL says, secret-looking field names dropped, strings and lists clipped. With LUCID_LOG_SYSLOG
// (udp://host[:port] or tcp://host[:port]) every line also goes to that collector as one RFC 5424 message, TCP framed
// by octet counting (RFC 6587), best effort through a bounded queue on its own thread, never holding a line back.

use crate::codec::{iso_time, stringify, utf16_len, utf16_prefix};
use serde_json::{Map, Value};
use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use parking_lot::Mutex;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    fn severity(self) -> u8 {
        match self {
            Level::Debug => 7,
            Level::Info => 6,
            Level::Warn => 4,
            Level::Error => 3,
        }
    }

    /// LUCID_LOG_LEVEL: an unknown value means info, never silence.
    pub fn from_env(v: Option<&str>) -> Level {
        match v.map(|s| crate::codec::js_trim(s).to_lowercase()).as_deref() {
            Some("debug") => Level::Debug,
            Some("warn") => Level::Warn,
            Some("error") => Level::Error,
            _ => Level::Info,
        }
    }
}

const MAX_FIELD: usize = 300;
const SYSLOG_FACILITY: u8 = 1;
const SYSLOG_QUEUE_BYTES: usize = 256 * 1024;
const SYSLOG_CONNECT: Duration = Duration::from_millis(5_000);
const SYSLOG_BACKOFF_FIRST: Duration = Duration::from_millis(1_000);
const SYSLOG_BACKOFF_MAX: Duration = Duration::from_millis(60_000);

/// The caller's fields in order; a later value for the same name replaces the earlier one in place, and an absent
/// one (JavaScript's undefined) is skipped.
#[derive(Default, Clone)]
pub struct Fields(Vec<(String, Value)>);

/// A field value; None is undefined (left out of the line).
pub trait IntoField {
    fn into_field(self) -> Option<Value>;
}

impl IntoField for Value {
    fn into_field(self) -> Option<Value> {
        Some(self)
    }
}
impl IntoField for &str {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for String {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for &String {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self.as_str()))
    }
}
impl IntoField for i64 {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for usize {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for u64 {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for u16 {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for bool {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self))
    }
}
impl IntoField for &[String] {
    fn into_field(self) -> Option<Value> {
        Some(Value::from(self.to_vec()))
    }
}
impl<T: IntoField> IntoField for Option<T> {
    fn into_field(self) -> Option<Value> {
        self.and_then(IntoField::into_field)
    }
}

impl Fields {
    pub fn new() -> Fields {
        Fields(Vec::new())
    }

    pub fn set(&mut self, key: &str, v: impl IntoField) -> &mut Fields {
        let v = v.into_field();
        match (self.0.iter().position(|(k, _)| k == key), v) {
            (Some(i), Some(v)) => self.0[i].1 = v,
            (Some(i), None) => {
                self.0.remove(i);
            }
            (None, Some(v)) => self.0.push((key.to_owned(), v)),
            (None, None) => {}
        }
        self
    }

    pub fn with(mut self, key: &str, v: impl IntoField) -> Fields {
        self.set(key, v);
        self
    }

    /// `{ ...this, ...other }`.
    pub fn merge(mut self, other: &Fields) -> Fields {
        for (k, v) in &other.0 {
            self.set(k, v.clone());
        }
        self
    }
}

/// Names that hold or carry secrets (exact, or ending so); `exitCode`, `statusCode` and `keyId` stay.
pub(crate) fn secret_field(k: &str) -> bool {
    const EXACT: [&str; 12] = ["code", "key", "token", "secret", "password", "passphrase", "cookie", "authorization", "prompt", "text", "input", "body"];
    const ENDS: [&str; 7] = ["Token", "Secret", "Password", "Passphrase", "Key", "Cookie", "Prompt"];
    EXACT.contains(&k) || ENDS.iter().any(|e| k.ends_with(e))
}

fn clean(fields: &Fields, line: &mut Map<String, Value>) {
    for (k, v) in &fields.0 {
        if secret_field(k) || line.contains_key(k) {
            continue;
        }
        let v = match v {
            Value::String(s) if utf16_len(s) > MAX_FIELD => Value::from(format!("{}...", utf16_prefix(s, MAX_FIELD))),
            Value::Array(a) => Value::Array(
                a.iter()
                    .take(20)
                    .map(|s| {
                        let text = match s {
                            Value::String(s) => s.clone(),
                            other => stringify(other),
                        };
                        Value::from(utf16_prefix(&text, 80).to_owned())
                    })
                    .collect(),
            ),
            other => other.clone(),
        };
        line.insert(k.clone(), v);
    }
}

// ── Syslog shipping ──────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SyslogTarget {
    pub tcp: bool,
    pub host: String,
    pub port: u16,
}

/// udp://host[:port] or tcp://host[:port], port 514 when left out, an IPv6 address in brackets; None for anything
/// else (log.ts SYSLOG_TARGET_RE).
pub fn syslog_target(value: &str) -> Option<SyslogTarget> {
    let v = crate::codec::js_trim(value);
    let (proto, rest) = v.split_once("://")?;
    let tcp = match proto {
        "udp" => false,
        "tcp" => true,
        _ => return None,
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = if rest.starts_with('[') {
        let end = rest.find(']')?;
        let inner = &rest[1..end];
        if inner.is_empty() || !inner.bytes().all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.') {
            return None;
        }
        (inner, &rest[end + 1..])
    } else {
        let end = rest.find(':').unwrap_or(rest.len());
        let host = &rest[..end];
        if host.is_empty() || !host.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
            return None;
        }
        (host, &rest[end..])
    };
    let port: u32 = if port.is_empty() {
        514
    } else {
        let digits = port.strip_prefix(':')?;
        if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok()?
    };
    if !(1..=65_535).contains(&port) {
        return None;
    }
    Some(SyslogTarget { tcp, host: host.to_owned(), port: port as u16 })
}

/// HOSTNAME as RFC 5424 allows it: printable ASCII, at most 255.
static SYSLOG_HOST: LazyLock<String> = LazyLock::new(|| {
    let raw = gethostname::gethostname().to_string_lossy().into_owned();
    let clean: String = raw.chars().map(|c| if ('\x21'..='\x7e').contains(&c) { c } else { '_' }).take(255).collect();
    if clean.is_empty() { "-".into() } else { clean }
});

/// Every shipper made in this process, by target, and the targets already refused (said once).
static SHIPPERS: LazyLock<Mutex<(Vec<(String, Arc<Shipper>)>, HashSet<String>)>> = LazyLock::new(Default::default);

/// One RFC 5424 message: `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID - MSG`, MSG the JSON line with every
/// character from U+007F up escaped (UTF-16 units, as JavaScript's replace sees them).
pub fn syslog_frame(ts: &str, level: Level, cat: &str, component: &str, json: &str) -> String {
    let pri = SYSLOG_FACILITY * 8 + level.severity();
    let app: String = format!("lucid-{component}").chars().map(|c| if ('\x21'..='\x7e').contains(&c) { c } else { '_' }).take(48).collect();
    let mut msg = String::with_capacity(json.len());
    for c in json.chars() {
        if (c as u32) < 0x7f {
            msg.push(c);
        } else {
            let mut units = [0u16; 2];
            for u in c.encode_utf16(&mut units) {
                msg.push_str(&format!("\\u{:04x}", u));
            }
        }
    }
    format!("<{pri}>1 {ts} {} {app} {} {cat} - {msg}", *SYSLOG_HOST, std::process::id())
}

/// A note about shipping itself, on stderr only.
fn shipping_note(level: Level, event: &str, fields: &[(&str, Value)]) {
    let mut line = Map::new();
    line.insert("ts".into(), Value::from(iso_time(crate::codec::now_ms())));
    line.insert("level".into(), Value::from(level.as_str()));
    line.insert("cat".into(), Value::from("ops"));
    line.insert("component".into(), Value::from("log"));
    line.insert("event".into(), Value::from(event));
    for (k, v) in fields {
        line.insert((*k).into(), v.clone());
    }
    let _ = writeln!(std::io::stderr().lock(), "{}", stringify(&Value::Object(line)));
}

struct Shipper {
    tx: SyncSender<String>,
    queued: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

impl Shipper {
    fn send(&self, frame: String) {
        let size = frame.len();
        if self.queued.load(Ordering::Relaxed) + size > SYSLOG_QUEUE_BYTES {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.queued.fetch_add(size, Ordering::Relaxed);
        if let Err(TrySendError::Full(f) | TrySendError::Disconnected(f)) = self.tx.try_send(frame) {
            self.queued.fetch_sub(f.len(), Ordering::Relaxed);
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn run_udp(t: SyslogTarget, rx: Receiver<String>, queued: Arc<AtomicUsize>) {
    let v6 = t.host.parse::<std::net::Ipv6Addr>().is_ok();
    let socket = UdpSocket::bind(if v6 { "[::]:0" } else { "0.0.0.0:0" }).ok();
    for frame in rx {
        queued.fetch_sub(frame.len(), Ordering::Relaxed);
        if let Some(s) = &socket {
            let _ = s.send_to(frame.as_bytes(), (t.host.as_str(), t.port));
        }
    }
}

fn connect(t: &SyslogTarget) -> Option<TcpStream> {
    let addrs = (t.host.as_str(), t.port).to_socket_addrs().ok()?;
    for a in addrs {
        if let Ok(s) = TcpStream::connect_timeout(&a, SYSLOG_CONNECT) {
            let _ = s.set_write_timeout(Some(SYSLOG_CONNECT));
            return Some(s);
        }
    }
    None
}

fn run_tcp(t: SyslogTarget, target: String, rx: Receiver<String>, queued: Arc<AtomicUsize>, dropped: Arc<AtomicUsize>) {
    let mut stream: Option<TcpStream> = None;
    let mut pending: VecDeque<String> = VecDeque::new();
    let mut pending_bytes = 0usize;
    let mut backoff = SYSLOG_BACKOFF_FIRST;
    let mut retry_at = Instant::now();
    let mut down = false;
    for frame in rx {
        queued.fetch_sub(frame.len(), Ordering::Relaxed);
        let framed = format!("{} {frame}", frame.len());
        if pending_bytes + framed.len() > SYSLOG_QUEUE_BYTES {
            dropped.fetch_add(1, Ordering::Relaxed);
        } else {
            pending_bytes += framed.len();
            pending.push_back(framed);
        }
        if stream.is_none() && Instant::now() >= retry_at {
            stream = connect(&t);
            if stream.is_some() {
                if down {
                    shipping_note(Level::Info, "syslog.recovered", &[("target", Value::from(target.as_str())), ("dropped", Value::from(dropped.swap(0, Ordering::Relaxed)))]);
                } else {
                    dropped.store(0, Ordering::Relaxed);
                }
                down = false;
                backoff = SYSLOG_BACKOFF_FIRST;
            }
        }
        let mut failed = stream.is_none() && Instant::now() >= retry_at;
        if let Some(s) = stream.as_mut() {
            while let Some(f) = pending.front() {
                if s.write_all(f.as_bytes()).is_err() {
                    failed = true;
                    break;
                }
                pending_bytes -= f.len();
                pending.pop_front();
            }
        }
        if failed {
            stream = None;
            if !down {
                shipping_note(Level::Warn, "syslog.unreachable", &[("target", Value::from(target.as_str())), ("retryInMs", Value::from(backoff.as_millis() as u64))]);
            }
            down = true;
            retry_at = Instant::now() + backoff;
            backoff = (backoff * 2).min(SYSLOG_BACKOFF_MAX);
        }
    }
}

/// One shipper per target for the process.
fn shipper_for(value: Option<&str>) -> Option<Arc<Shipper>> {
    let target = crate::codec::js_trim(value.unwrap_or(""));
    if target.is_empty() {
        return None;
    }
    let mut book = SHIPPERS.lock();
    if let Some((_, s)) = book.0.iter().find(|(t, _)| t == target) {
        return Some(s.clone());
    }
    let Some(t) = syslog_target(target) else {
        if book.1.insert(target.to_owned()) {
            let shown: String = target.chars().take(200).collect();
            shipping_note(Level::Warn, "syslog.target-refused", &[("target", Value::from(shown)), ("why", Value::from("LUCID_LOG_SYSLOG must be udp://host:port or tcp://host:port"))]);
        }
        return None;
    };
    let (tx, rx) = sync_channel::<String>(4096);
    let queued = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let (q, d, name) = (queued.clone(), dropped.clone(), target.to_owned());
    let spawned = if t.tcp {
        std::thread::Builder::new().name("syslog".into()).spawn(move || run_tcp(t, name, rx, q, d))
    } else {
        std::thread::Builder::new().name("syslog".into()).spawn(move || run_udp(t, rx, q))
    };
    spawned.ok()?;
    let s = Arc::new(Shipper { tx, queued, dropped });
    book.0.push((target.to_owned(), s.clone()));
    Some(s)
}

type Sink = Box<dyn Fn(&str, Level) + Send + Sync>;

/// Every written line handed on as well (the control panel's ring, ADR-A094): category, level, event, the JSON line.
pub type Tap = Arc<dyn Fn(&str, Level, &str, &str) + Send + Sync>;

pub struct Logger {
    component: String,
    min: Level,
    sink: Option<Sink>,
    ship: Option<Arc<Shipper>>,
    tap: Option<Tap>,
}

impl Logger {
    /// A logger with the process environment's LUCID_LOG_LEVEL and LUCID_LOG_SYSLOG, on stdout and stderr.
    pub fn new(component: &str) -> Logger {
        Logger {
            component: component.to_owned(),
            min: Level::from_env(std::env::var("LUCID_LOG_LEVEL").ok().as_deref()),
            sink: None,
            ship: shipper_for(std::env::var("LUCID_LOG_SYSLOG").ok().as_deref()),
            tap: None,
        }
    }

    /// The same logger, every line it writes also handed to `tap`.
    pub fn with_tap(mut self, tap: Tap) -> Logger {
        self.tap = Some(tap);
        self
    }

    #[cfg(test)]
    pub fn capture(component: &str, sink: Sink) -> Logger {
        Logger { component: component.to_owned(), min: Level::Debug, sink: Some(sink), ship: None, tap: None }
    }

    pub fn log(&self, cat: &str, level: Level, event: &str, fields: &Fields) {
        // Security lines are always written: a level setting must never hide a refusal.
        if cat != "security" && level < self.min {
            return;
        }
        let ts = iso_time(crate::codec::now_ms());
        let mut line = Map::new();
        line.insert("ts".into(), Value::from(ts.as_str()));
        line.insert("level".into(), Value::from(level.as_str()));
        line.insert("cat".into(), Value::from(cat));
        line.insert("component".into(), Value::from(self.component.as_str()));
        line.insert("event".into(), Value::from(event));
        clean(fields, &mut line);
        let json = stringify(&Value::Object(line));
        match &self.sink {
            Some(sink) => sink(&json, level),
            None if level >= Level::Warn => {
                let _ = writeln!(std::io::stderr().lock(), "{json}");
            }
            None => {
                let _ = writeln!(std::io::stdout().lock(), "{json}");
            }
        }
        if let Some(s) = &self.ship {
            s.send(syslog_frame(&ts, level, cat, &self.component, &json));
        }
        if let Some(tap) = &self.tap {
            tap(cat, level, event, &json);
        }
    }

    pub fn warn(&self, event: &str, fields: &Fields) {
        self.log("ops", Level::Warn, event, fields);
    }

    /// A refusal or trust decision; always written (default level warn).
    pub fn security(&self, event: &str, fields: &Fields, level: Level) {
        self.log("security", level, event, fields);
    }

    pub fn perf(&self, event: &str, fields: &Fields) {
        self.log("perf", Level::Info, event, fields);
    }

    pub fn ops(&self, event: &str, fields: &Fields, level: Level) {
        self.log("ops", level, event, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_have_the_typescript_shape() {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let log = Logger::capture("relay", Box::new(move |l, _| l2.lock().push(l.to_owned())));
        let f = Fields::new().with("status", 401i64).with("token", "secret").with("claimedNode", None::<String>).with("path", "/v1/inbox").with("status", 403i64);
        log.security("auth.failed", &f, Level::Warn);
        let line = lines.lock()[0].clone();
        let tail = line.split_once(r#""component":"relay","#).unwrap().1;
        assert!(line.starts_with(r#"{"ts":""#));
        assert!(line.contains(r#""level":"warn","cat":"security""#));
        assert_eq!(tail, r#""event":"auth.failed","status":403,"path":"/v1/inbox"}"#);
    }

    #[test]
    fn syslog_targets_and_frames() {
        assert_eq!(syslog_target("udp://10.0.0.5"), Some(SyslogTarget { tcp: false, host: "10.0.0.5".into(), port: 514 }));
        assert_eq!(syslog_target("tcp://[::1]:6514/"), Some(SyslogTarget { tcp: true, host: "::1".into(), port: 6514 }));
        assert_eq!(syslog_target("http://x:1"), None);
        assert_eq!(syslog_target("udp://x:0"), None);
        let f = syslog_frame("2026-11-09T00:00:00.000Z", Level::Warn, "security", "relay", "{\"a\":\"\u{e9}\u{1f600}\"}");
        assert!(f.starts_with("<12>1 2026-11-09T00:00:00.000Z "));
        assert!(f.ends_with(" security - {\"a\":\"\\u00e9\\ud83d\\ude00\"}"));
        assert!(f.contains(" lucid-relay "));
    }
}
