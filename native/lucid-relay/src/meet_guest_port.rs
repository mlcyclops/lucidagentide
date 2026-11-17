// Phase C (ADR-0540), wave 3: the guest port (meet_relay.GuestHandler, GuestServer and _guests_redact). TLS WITHOUT
// client certificates, serving ONLY the guest page (`/g/`) and the guest API (`/g/v1/*`, every call but knock
// authenticated by `X-Guest`); none of the certificate-holder routes exist here. One thread per connection, but never
// more than CONNECTIONS_MAX at once nor CONNECTIONS_PER_ADDRESS from one address (IPv6 by /64): a connection over
// either is closed at once, before its handshake. A handshake, a request line, its headers and its body each get
// HANDSHAKE_TIMEOUT; a long poll's answer is written within POLL_TIMEOUT. Everything a guest receives is redacted: no
// email address of anyone else, at any depth.

use crate::meet::{self as m, address_of, http_date, is_client_gone, log_error, log_info, quiet_end, read_head, reason_phrase, send_error, Identity, Settings, Tls, E, R, SERVER_VERSION};
use crate::meet_hub::{guests, Hub};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{guest_tls_config, RefusalLog};
use parking_lot::Mutex;
use rustls::ServerConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The guest port's limits: connections at once, from one address, and how long a handshake (or a request line, its
/// headers, its body) and a long poll's answer may take.
const CONNECTIONS_MAX: usize = 256;
const CONNECTIONS_PER_ADDRESS: usize = 16;
const HANDSHAKE_TIMEOUT: f64 = 10.0;
const POLL_TIMEOUT: f64 = 30.0;
/// The guest page: no inline script or style, nothing from another origin, no framing.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'";
const GUEST_DIR: &str = "guest";
const UNKNOWN: &str = "unknown path";

struct Port {
    hub: Arc<Hub>,
    settings: Settings,
    secret: Vec<u8>,
    tls: Arc<ServerConfig>,
    /// URL path -> (file in the guest folder, its type).
    statics: Vec<(String, PathBuf, &'static str)>,
    open: Mutex<HashMap<String, usize>>,
    total: AtomicUsize,
    refusals: RefusalLog,
}

/// The guest page's folder: `guest` next to the executable, else in the working folder (the relay's folder, as
/// meet_relay.py serves it from beside itself).
fn guest_dir() -> PathBuf {
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(GUEST_DIR)));
    match beside {
        Some(d) if d.join("index.html").is_file() => d,
        _ => PathBuf::from(GUEST_DIR),
    }
}

/// start_guest_server: the guest port on its own thread (nothing when `guest_port` is 0).
pub fn start(settings: &Settings, hub: Arc<Hub>, secret: Vec<u8>) -> Result<(), String> {
    let port = match pj::as_int(Some(&settings.guest_port)) {
        Some(p) if pj::truthy(Some(&settings.guest_port)) && p > 0 => p as u16,
        _ => return Ok(()),
    };
    let tls = guest_tls_config(settings)?;
    let dir = guest_dir();
    let statics: Vec<(String, PathBuf, &'static str)> = [("/g/", "index.html", "text/html; charset=utf-8"), ("/g/index.html", "index.html", "text/html; charset=utf-8"), ("/g/guest.js", "guest.js", "text/javascript; charset=utf-8"), ("/g/guest.css", "guest.css", "text/css; charset=utf-8")]
        .into_iter()
        .map(|(path, file, ctype)| (path.to_string(), dir.join(file), ctype))
        .collect();
    let listener = TcpListener::bind((settings.host.as_str(), port)).map_err(|e| format!("cannot listen on {}:{port}: {e}", settings.host))?;
    let server = Arc::new(Port { hub, settings: settings.clone(), secret, tls, statics, open: Mutex::new(HashMap::new()), total: AtomicUsize::new(0), refusals: RefusalLog::new() });
    std::thread::Builder::new()
        .name("relay-guest-port".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let address = address_of(&peer);
                let Some(slot) = Slot::take(&server, &address) else {
                    server.refusals.note(&address);
                    drop(tcp);
                    continue;
                };
                let _ = std::thread::Builder::new().name("relay-guest".into()).spawn(move || {
                    serve(&slot.port, tcp, &address);
                    drop(slot);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    log_info(&format!("guest page listening on {}:{port} for {}", settings.host, settings.guest_public));
    Ok(())
}

/// One connection's place under the port's limits, given back when it ends.
struct Slot {
    port: Arc<Port>,
    key: String,
}

impl Slot {
    fn take(port: &Arc<Port>, address: &str) -> Option<Slot> {
        let key = guests::addr_key(address);
        let mut open = port.open.lock();
        if port.total.load(Ordering::SeqCst) >= CONNECTIONS_MAX || open.get(&key).copied().unwrap_or(0) >= CONNECTIONS_PER_ADDRESS {
            return None;
        }
        port.total.fetch_add(1, Ordering::SeqCst);
        *open.entry(key.clone()).or_insert(0) += 1;
        Some(Slot { port: port.clone(), key })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut open = self.port.open.lock();
        if let Some(n) = open.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                open.remove(&self.key);
            }
        }
        self.port.total.fetch_sub(1, Ordering::SeqCst);
    }
}

fn serve(port: &Port, mut tcp: TcpStream, address: &str) {
    let _ = tcp.set_read_timeout(Some(Duration::from_secs_f64(HANDSHAKE_TIMEOUT)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs_f64(POLL_TIMEOUT)));
    let Ok(mut conn) = rustls::ServerConnection::new(port.tls.clone()) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            port.refusals.note(address);
            return;
        }
    }
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    loop {
        match one(port, &mut reader, address) {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                if !quiet_end(&e) {
                    port.refusals.note(address);
                }
                break;
            }
        }
    }
    let tls = reader.get_mut();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

/// One answer: its status, the headers the guest page always gets, any extra ones, and the body.
fn write(w: &mut Tls, status: u16, ctype: &str, cache: &str, extra: &[(&str, String)], body: &[u8]) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\n", reason_phrase(status), http_date());
    let fixed = [
        ("Content-Type", ctype.to_string()),
        ("Content-Length", body.len().to_string()),
        ("Cache-Control", cache.to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        ("Cross-Origin-Opener-Policy", "same-origin".to_string()),
        ("Cross-Origin-Resource-Policy", "same-origin".to_string()),
        ("Strict-Transport-Security", "max-age=31536000".to_string()),
        ("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(), geolocation=(), usb=(), payment=()".to_string()),
        ("Content-Security-Policy", CSP.to_string()),
    ];
    for (k, v) in fixed.iter().map(|(k, v)| (*k, v)).chain(extra.iter().map(|(k, v)| (*k, v))) {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    w.write_all(&out)?;
    w.flush()
}

fn json(w: &mut Tls, status: u16, payload: &Obj, extra: &[(&str, String)]) -> std::io::Result<()> {
    write(w, status, "application/json", "no-store", extra, pj::dumps(&Value::Object(payload.clone())).as_bytes())
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>, address: &str) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let (path, query) = head.path_query();
    let mut close = head.close;
    match head.method.as_str() {
        "GET" | "POST" => {}
        "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" => {
            m::drain_unread(reader, &head, false);
            let _ = json(reader.get_mut(), 405, &obj([("error", Value::from("the guest port takes GET and POST only"))]), &[]);
            return Ok(false);
        }
        other => {
            send_error(reader.get_mut(), 501, &format!("Unsupported method ({other:?})"))?;
            return Ok(false);
        }
    }
    if head.method == "GET" {
        if path == "/g" {
            let sent = write(reader.get_mut(), 301, "text/plain", "no-store", &[("Location", "/g/".to_string())], b"");
            return Ok(sent.is_ok() && !close);
        }
        if let Some((_, file, ctype)) = port.statics.iter().find(|(p, ..)| *p == path) {
            let sent = match std::fs::read(file) {
                Ok(data) => write(reader.get_mut(), 200, ctype, "no-cache", &[], &data),
                Err(_) => json(reader.get_mut(), 404, &obj([("error", Value::from(UNKNOWN))]), &[]),
            };
            return Ok(sent.is_ok() && !close);
        }
    }
    let known = matches!((head.method.as_str(), path.as_str()), ("GET", "/g/v1/wait" | "/g/v1/events") | ("POST", "/g/v1/knock" | "/g/v1/signal" | "/g/v1/chat" | "/g/v1/stage" | "/g/v1/consent" | "/g/v1/leave"));
    if !known {
        let post = head.method == "POST";
        if post {
            m::drain_unread(reader, &head, false);
        }
        let sent = json(reader.get_mut(), 404, &obj([("error", Value::from(UNKNOWN))]), &[]);
        return Ok(sent.is_ok() && !close && !post);
    }
    // AC-1 R41-1: the guest port does not consult the license (it seats no one); guests have no certificate
    let mut req = Req { port, head: &head, query: m::parse_query(&query), reader: &mut *reader, address, body_read: false, close: false };
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| route(&mut req, &path)));
    let (body_read, closing) = (req.body_read, req.close);
    close |= closing;
    if m::drain_unread(reader, &head, body_read) {
        close = true;
    }
    let result = match result {
        Ok(r) => r,
        Err(p) => Err(E::Internal(p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())),
    };
    let err = |msg: String| obj([("error", Value::from(msg))]);
    let mut extra: Vec<(&str, String)> = Vec::new();
    let (status, payload) = match result {
        Ok(o) => (200, redact_obj(&o)),
        Err(E::ClientGone) => return Ok(false),
        Err(E::Busy(msg, retry)) => {
            close = true;
            extra.push(("Retry-After", retry.max(1).to_string()));
            (429, err(msg))
        }
        Err(E::Forbidden(msg)) => {
            close = true;
            (403, err(msg))
        }
        Err(E::Held(msg, info)) => {
            close = true;
            let mut o = err(msg);
            if let Some(code) = info.get("code") {
                o.insert("code".into(), code.clone());
            }
            (403, o)
        }
        Err(E::Conflict(msg)) | Err(E::ConflictInfo(msg, _)) => (409, err(msg)),
        Err(E::NotFound(msg)) => (404, err(msg)),
        Err(E::Unavailable(msg)) => (501, err(msg)),
        Err(E::Gone(msg)) => (410, err(msg)),
        Err(E::Bad(msg)) => (400, err(msg)),
        Err(E::Status(status, msg, shut)) => {
            close |= shut;
            (status, err(msg))
        }
        Err(E::Update(info)) => (426, err(m::update_message(&info))),
        Err(E::Internal(msg)) => {
            log_error(&format!("guest request failed\n{msg}"));
            (500, err("the relay failed this request".into()))
        }
    };
    match json(reader.get_mut(), status, &payload, &extra) {
        Ok(()) => Ok(!close),
        Err(e) if is_client_gone(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

/// One guest API request: its head, query, body (read on demand) and the caller's address.
struct Req<'a> {
    port: &'a Port,
    head: &'a m::Head,
    query: Vec<(String, String)>,
    reader: &'a mut BufReader<Tls>,
    address: &'a str,
    body_read: bool,
    close: bool,
}

impl Req<'_> {
    /// `X-Guest: <id>.<secret>`.
    fn pass(&self) -> String {
        self.head.header("x-guest").unwrap_or_default()
    }

    /// GuestHandler._body: JSON only (a form post from another site never reaches the lobby).
    fn body(&mut self) -> R<Obj> {
        let ctype = self.head.header("content-type").unwrap_or_default();
        if ctype.split(';').next().unwrap_or_default().trim().to_lowercase() != "application/json" {
            return m::bad("send JSON (Content-Type: application/json)");
        }
        let text = self.head.header("content-length").unwrap_or_default();
        let length = if text.trim().is_empty() { 0 } else { m::py_int(&text)? };
        if length <= 0 {
            self.body_read = true;
            return Ok(Obj::new());
        }
        if length as usize > m::BODY_MAX {
            return m::bad("request too large");
        }
        let mut raw = vec![0u8; length as usize];
        self.body_read = true;
        if self.reader.read_exact(&mut raw).is_err() {
            self.close = true;
            return Err(E::ClientGone);
        }
        let text = std::str::from_utf8(&raw).map_err(|e| E::Bad(format!("'utf-8' codec can't decode bytes: {e}")))?;
        match serde_json::from_str::<Value>(text).map_err(|e| E::Bad(m::json_error(&e, text)))? {
            Value::Object(o) => Ok(o),
            _ => m::bad("the body must be a JSON object"),
        }
    }

    /// _ice: TURN credentials for a guest: valid no longer than its link, and at most an hour (renewed on a later
    /// events poll), whatever `turn_ttl` says.
    fn ice(&self, who: &Identity, expires: f64) -> Obj {
        let settings = &self.port.settings;
        let ttl = (settings.turn_ttl as f64).min(expires - pj::now()).clamp(60.0, guests::ICE_MAX) as i64;
        let s = Settings { turn_ttl: ttl, ..settings.clone() };
        m::turn_credentials(&s, &self.port.secret, who, self.address)
    }
}

fn route(req: &mut Req, path: &str) -> R<Obj> {
    let hub = req.port.hub.clone();
    let (pass, address) = (req.pass(), req.address.to_string());
    match path {
        "/g/v1/wait" => {
            let mut answer = hub.guests_wait(&pass, &address)?;
            if let Some(Value::Object(you)) = answer.get("you") {
                let who = Identity { principal: pj::s(you, "principal"), name: pj::s(you, "name"), guest: true, ..Default::default() };
                let expires = pj::as_num(answer.get("expires")).filter(|x| *x != 0.0).unwrap_or_else(pj::now);
                answer.insert("ice".into(), Value::Object(req.ice(&who, expires)));
            }
            Ok(answer)
        }
        "/g/v1/events" => {
            let after = req.query.iter().find(|(k, _)| k == "after").map(|(_, v)| v.clone()).unwrap_or_else(|| "0".into());
            let mark = m::py_int(&after).map_err(|_| E::Bad("after must be a whole number".into()))?;
            let mut answer = hub.guests_events(&pass, &address, mark)?;
            if let Some((who, expires)) = hub.guests_ice_due(&pass, &address)? {
                answer.insert("ice".into(), Value::Object(req.ice(&who, expires))); // fresh TURN credentials
            }
            Ok(answer)
        }
        "/g/v1/knock" => {
            let b = req.body()?;
            hub.guests_knock(b.get("token"), b.get("name"), &address)
        }
        "/g/v1/signal" => {
            let b = req.body()?;
            hub.guests_signal(&pass, &address, b.get("to"), b.get("data").cloned().unwrap_or(Value::Null))
        }
        "/g/v1/chat" => {
            let b = req.body()?;
            hub.guests_chat(&pass, &address, b.get("text"))
        }
        "/g/v1/stage" => {
            let b = req.body()?;
            hub.guests_act(&pass, &address, &b)
        }
        "/g/v1/consent" => {
            let b = req.body()?;
            hub.guests_consent(&pass, &address, b.get("request"), b.get("accepted"))
        }
        // "/g/v1/leave", the last known path
        _ => {
            req.body()?;
            hub.guests_leave(&pass, &address)
        }
    }
}

// ── redaction ──────────────────────────────────────────────────────────────────────────────────────────────────

/// _guests_hide: "" for a string that holds anyone's email address (a guest's own guest.invalid principal is not
/// one); the string itself otherwise. The bridge passes every name it puts in an op through it too.
pub(crate) fn hide(text: &str) -> String {
    if !text.contains('@') {
        return text.to_string();
    }
    // _GUESTS_ADDRESS_RE `[^\s@]+@[^\s@]+`, its matches left to right
    let chars: Vec<char> = text.chars().collect();
    let plain = |c: char| !c.is_whitespace() && c != '@';
    let mut found: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !plain(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && plain(chars[i]) {
            i += 1;
        }
        if i < chars.len() && chars[i] == '@' {
            let mut j = i + 1;
            while j < chars.len() && plain(chars[j]) {
                j += 1;
            }
            if j > i + 1 {
                found.push(chars[start..j].iter().collect());
                i = j;
            }
        }
    }
    if !found.is_empty() && found.iter().all(|a| a.to_lowercase().ends_with(m::GUEST_DOMAIN)) {
        return text.to_string();
    }
    String::new()
}

/// What people wrote for everyone in the call and the WebRTC payloads peers exchange pass as they are.
const VERBATIM: [&str; 2] = ["text", "data"];

/// _guests_redact: no email address of anyone else, in any field at any depth: a string holding one becomes "", a key
/// that is one is dropped, reactions become counts, mentions are dropped, a recording owner keeps only its kind and
/// label, and the lobby list (other waiting people) goes, and so does a member's `cert` (a certificate names its
/// holder's email address in DER).
fn redact(value: &Value) -> Value {
    match value {
        Value::Object(o) => Value::Object(redact_obj(o)),
        Value::Array(a) => Value::Array(a.iter().map(redact).collect()),
        Value::String(s) => Value::from(hide(s)),
        other => other.clone(),
    }
}

fn redact_obj(o: &Obj) -> Obj {
    let mut out = Obj::new();
    for (k, v) in o {
        if (k == "lobby" && v.is_array()) || k == "mentions" || k == "cert" || hide(k) != *k {
            continue;
        }
        let value = if VERBATIM.contains(&k.as_str()) {
            v.clone()
        } else if let (true, Value::Object(r)) = (k == "reactions", v) {
            Value::Object(r.iter().map(|(e, who)| (e.clone(), Value::from(who.as_array().map(Vec::len).unwrap_or(0)))).collect())
        } else if let (true, Value::Object(owner)) = (k == "owner", v) {
            Value::Object(obj([("kind", owner.get("kind").cloned().unwrap_or(Value::Null)), ("label", Value::from(hide(&pj::s(owner, "label"))))]))
        } else {
            redact(v)
        };
        out.insert(k.clone(), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guests_never_see_anyone_elses_address() {
        assert_eq!(hide("ben@meet.test"), "");
        assert_eq!(hide("guest-0123456789abcdef@guest.invalid"), "guest-0123456789abcdef@guest.invalid");
        assert_eq!(hide("1700:guest-0123456789abcdef@guest.invalid"), "1700:guest-0123456789abcdef@guest.invalid");
        assert_eq!(hide("@"), "");
        assert_eq!(hide("no address"), "no address");
        let event = json!({"type": "chat", "principal": "ben@meet.test", "text": "mail me at ben@meet.test", "reactions": {"x": ["a@b.c", "d@e.f"]}, "mentions": ["cy@meet.test"], "assign": {"cy@meet.test": "r1"}, "stage": {"lobby": [{"name": "N"}], "lobby_count": 1}, "owner": {"kind": "individual", "id": "ben@meet.test", "label": "Ben"}, "members": [{"peer": "p", "cert": "-----BEGIN CERTIFICATE-----\n"}]});
        let out = redact(&event);
        assert_eq!(out, json!({"type": "chat", "principal": "", "text": "mail me at ben@meet.test", "reactions": {"x": 2}, "assign": {}, "stage": {"lobby_count": 1}, "owner": {"kind": "individual", "label": "Ben"}, "members": [{"peer": "p"}]}));
    }
}
