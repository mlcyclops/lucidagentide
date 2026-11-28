// Contract WA-1 section 7.3: the web port (meet_relay.WebHandler and WebServer): members' browsers, TLS WITHOUT client
// certificates. It serves the web client's files (`/w/...`, an allow-list), where it signs in (`GET /w/v1/config`, no
// session), its sessions (`/w/v1/session/challenge`, `/w/v1/session`) and `/w/v1/<path>`, which runs `/v1/<path>` of
// the relay (meet_routes) with the session's identity, only for the exact sets WEB_GET and WEB_POST (anything else
// 404) and the WEB_STAGE actions (`lobby_*` while the seat is the host; never an admission; others 403). Every request
// carries `Authorization: LucidWeb <session>` (never a cookie), checked against the deny list and the CRLs each time;
// POSTs are JSON. The guest port's connection caps apply.

use crate::meet::{self as m, address_of, http_date, is_client_gone, log_error, log_info, quiet_end, read_head, reason_phrase, send_error, Ctx, Head, Raw, Relay, Settings, Tls, E, R, SERVER_VERSION};
use crate::meet_guest_port::{static_file, WEB_STATIC};
use crate::meet_hub::{guests, wa};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{guest_tls_config, RefusalLog};
use parking_lot::Mutex;
use rustls::ServerConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const CONNECTIONS_MAX: usize = 256;
const CONNECTIONS_PER_ADDRESS: usize = 16;
const HANDSHAKE_TIMEOUT: f64 = 10.0;
const POLL_TIMEOUT: f64 = 30.0;
const UNKNOWN: &str = "unknown path";
/// POST /v1/chat/keys's limit: a web session's JSON body is read once, for its checks.
const BODY_MAX: usize = 1024 * 1024;
/// WA-1 section 7.4: the routes a web port session runs (`/w/v1/<path>` -> `/v1/<path>`), exact paths.
const WEB_GET: [&str; 17] = [
    "/v1/whoami", "/v1/inbox", "/v1/events", "/v1/dm/history", "/v1/channels", "/v1/channels/history", "/v1/room/captions", "/v1/files/get", "/v1/files/list", "/v1/chat/devices", "/v1/chat/keys", "/v1/chat/log", "/v1/crl",
    "/v1/org/policy", "/v1/lobby", "/v1/lobby/wait", "/v1/emoji/file",
];
const WEB_POST: [&str; 31] = [
    "/v1/hello", "/v1/bye", "/v1/status", "/v1/dm", "/v1/dm/read", "/v1/react", "/v1/typing", "/v1/chat", "/v1/chat/edit", "/v1/chat/delete", "/v1/chat/event", "/v1/chat/devices", "/v1/chat/keys",
    "/v1/channels/post", "/v1/channels/read", "/v1/files/start", "/v1/files/chunk", "/v1/files/finish", "/v1/join", "/v1/leave", "/v1/signal", "/v1/ice", "/v1/stage", "/v1/sfu/token", "/v1/e2ee", "/v1/e2ee/keys",
    "/v1/e2ee/roster", "/v1/lobby/leave",
    // answering a recording consent request is not a recording action (WA-1 revision 3)
    "/v1/recording/consent",
    // PH-1 revision 3 (section 11.4): the web dialer, and declining an incoming phone call
    "/v1/phone/call", "/v1/invite/settle",
];
/// ...and the stage actions it may take (`lobby_*` only while its seat is the host).
const WEB_STAGE: [&str; 7] = ["hand", "react", "mute", "present", "stop", "request", "cancel"];
const APP_ONLY: &str = "open the Lucid app to do that";
const NO_ADMIT: &str = "admit guests from the Lucid app";

struct Port {
    relay: Arc<Relay>,
    tls: Arc<ServerConfig>,
    csp: String,
    open: Mutex<HashMap<String, usize>>,
    total: AtomicUsize,
    refusals: RefusalLog,
}

/// start_web_server: the web port on its own thread (nothing when `web_port` is 0).
pub fn start(settings: &Settings, relay: Arc<Relay>) -> Result<(), String> {
    let port = match pj::as_int(Some(&settings.web_port)) {
        Some(p) if p > 0 => p as u16,
        _ => return Ok(()),
    };
    // web_tls_context: its certificate, else the guest port's, else the relay's own; no client certificate asked for
    let mut s = settings.clone();
    if !settings.web_cert.is_empty() {
        s.guest_cert = settings.web_cert.clone();
        s.guest_key = settings.web_key.clone();
    }
    let tls = guest_tls_config(&s)?;
    let sso = pj::str_or(Some(&settings.web_sso_url));
    let csp = wa::page_csp(&settings.sfu_url, if sso.is_empty() { pj::str_or(Some(&settings.guest_verify_url)) } else { sso }.as_str());
    let listener = TcpListener::bind((settings.host.as_str(), port)).map_err(|e| format!("cannot listen on {}:{port}: {e}", settings.host))?;
    let server = Arc::new(Port { relay, tls, csp, open: Mutex::new(HashMap::new()), total: AtomicUsize::new(0), refusals: RefusalLog::new() });
    std::thread::Builder::new()
        .name("relay-web-port".into())
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
                let _ = std::thread::Builder::new().name("relay-web".into()).spawn(move || {
                    serve(&slot.port, tcp, &address);
                    drop(slot);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    log_info(&format!("web client listening on {}:{port} for {}", settings.host, pj::str_or(Some(&settings.web_public))));
    Ok(())
}

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
    // a long poll (events, inbox) holds the connection for up to POLL_WAIT
    let _ = reader.get_ref().sock.set_read_timeout(Some(Duration::from_secs_f64(m::POLL_WAIT + 35.0)));
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

/// WebHandler._headers: every answer's headers (the page's CSP, no framing, HSTS).
fn write(w: &mut Tls, csp: &str, status: u16, ctype: &str, cache: &str, extra: &[(&str, String)], body: &[u8]) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\n", reason_phrase(status), http_date());
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
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
        ("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=(), usb=(), payment=()".to_string()),
        ("Content-Security-Policy", csp.to_string()),
    ];
    for (k, v) in fixed {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    w.write_all(&out)?;
    w.flush()
}

fn json(w: &mut Tls, csp: &str, status: u16, payload: &Obj) -> std::io::Result<()> {
    write(w, csp, status, "application/json", "no-store", &[], pj::dumps(&Value::Object(payload.clone())).as_bytes())
}

fn error(msg: &str) -> Obj {
    obj([("error", Value::from(msg))])
}

/// _json_body: a JSON object body (Content-Type application/json) of at most `most` bytes.
fn json_body(reader: &mut BufReader<Tls>, head: &Head, most: usize) -> R<Obj> {
    let ctype = head.header("content-type").unwrap_or_default();
    if ctype.split(';').next().unwrap_or_default().trim().to_lowercase() != "application/json" {
        return m::bad("send JSON (Content-Type: application/json)");
    }
    let text = head.header("content-length").unwrap_or_default();
    let length = if text.trim().is_empty() { 0 } else { m::py_int(&text)? };
    if length <= 0 {
        return Ok(Obj::new());
    }
    if length as usize > most {
        return m::bad("request too large");
    }
    let mut raw = vec![0u8; length as usize];
    reader.read_exact(&mut raw).map_err(|_| E::ClientGone)?;
    let text = std::str::from_utf8(&raw).map_err(|e| E::Bad(format!("'utf-8' codec can't decode bytes: {e}")))?;
    match serde_json::from_str::<Value>(text).map_err(|e| E::Bad(m::json_error(&e, text)))? {
        Value::Object(o) => Ok(o),
        _ => m::bad("the body must be a JSON object"),
    }
}

/// The status and payload of a session route's answer (Handler._run); true when the connection closes after it.
type Answer = (u16, Obj, bool, Vec<(&'static str, String)>);

fn answer(result: R<Obj>) -> Option<Answer> {
    Some(match result {
        Ok(o) => (200, o, false, Vec::new()),
        Err(E::ClientGone) => return None,
        Err(E::Busy(msg, retry)) => (429, error(&msg), true, vec![("Retry-After", retry.max(1).to_string())]),
        Err(E::Forbidden(msg)) => (403, error(&msg), true, Vec::new()),
        Err(E::Bad(msg)) => (400, error(&msg), false, Vec::new()),
        Err(E::Unavailable(msg)) => (501, error(&msg), false, Vec::new()),
        Err(e) => {
            log_error(&format!("web request failed\n{}", e.message()));
            (500, error("the relay failed this request"), false, Vec::new())
        }
    })
}

/// _stage_refused: "" for a stage action a web seat may take (WA-1 7.4), else the 403 words. A web seat never admits a
/// guest (admissions come from the Lucid app).
fn stage_refused(port: &Port, who: &m::Identity, body: &Obj) -> &'static str {
    let action = body.get("action").and_then(Value::as_str).unwrap_or_default();
    let peer = pj::str_or(body.get("peer"));
    if action == "lobby_admit" || action == "lobby_admit_all" {
        return NO_ADMIT;
    }
    if action == "mute" || action == "stop" {
        // its own only
        let own = match body.get("target") {
            None | Some(Value::Null) => true,
            Some(Value::String(t)) => t.is_empty() || *t == peer,
            _ => false,
        };
        return if own { "" } else { APP_ONLY };
    }
    if WEB_STAGE.contains(&action) {
        return "";
    }
    if action.starts_with("lobby_") && port.relay.hub.wa_seat_hosts(&peer, who) {
        return "";
    }
    APP_ONLY
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>, address: &str) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let (path, query) = head.path_query();
    let close = head.close;
    let csp = port.csp.as_str();
    match head.method.as_str() {
        "GET" | "POST" => {}
        "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" => {
            m::drain_unread(reader, &head, false);
            let _ = json(reader.get_mut(), csp, 405, &error("the web port takes GET and POST only"));
            return Ok(false);
        }
        other => {
            send_error(reader.get_mut(), 501, &format!("Unsupported method ({other:?})"))?;
            return Ok(false);
        }
    }
    let get = head.method == "GET";
    if get && path == "/w" {
        let sent = write(reader.get_mut(), csp, 301, "text/plain", "no-store", &[("Location", "/w/".to_string())], b"");
        return Ok(sent.is_ok() && !close);
    }
    if get {
        if let Some((file, ctype)) = static_file(&WEB_STATIC, "/w/", &path) {
            let sent = match std::fs::read(&file) {
                Ok(data) => write(reader.get_mut(), csp, 200, ctype, "no-cache", &[], &data),
                Err(_) => json(reader.get_mut(), csp, 404, &error(UNKNOWN)),
            };
            return Ok(sent.is_ok() && !close);
        }
    }
    let relay = port.relay.clone();
    let hub = relay.hub.clone();
    // the routes before a session: where members sign in, the challenge and the session itself
    let early: Option<R<Obj>> = match (get, path.as_str()) {
        (true, "/w/v1/config") => Some(Ok(hub.wa_web_config())),
        (false, "/w/v1/session/challenge") => Some(json_body(reader, &head, m::BODY_MAX).and_then(|_| hub.wa_challenge(address))),
        (false, "/w/v1/session") => Some(json_body(reader, &head, m::BODY_MAX).and_then(|b| hub.wa_session_open(&b, address))),
        _ => None,
    };
    if let Some(result) = early {
        let drained = m::drain_unread(reader, &head, !get);
        let Some((status, payload, shut, extra)) = answer(result) else { return Ok(false) };
        let sent = write(reader.get_mut(), csp, status, "application/json", "no-store", &extra, pj::dumps(&Value::Object(payload)).as_bytes());
        return Ok(sent.is_ok() && !close && !shut && !drained);
    }
    let inner = path.strip_prefix("/w/v1/").map(|rest| format!("/v1/{rest}")).unwrap_or_default();
    let allowed = if get { WEB_GET.contains(&inner.as_str()) } else { WEB_POST.contains(&inner.as_str()) };
    if !allowed {
        m::drain_unread(reader, &head, false);
        let _ = json(reader.get_mut(), csp, 404, &error(UNKNOWN));
        return Ok(false);
    }
    let who = match hub.wa_session(&head.header("authorization").unwrap_or_default()) {
        Ok(w) => w,
        Err(words) => {
            m::drain_unread(reader, &head, false);
            let _ = json(reader.get_mut(), csp, 401, &error(&words));
            return Ok(false);
        }
    };
    let mut preset = None;
    if !get && inner != "/v1/files/chunk" {
        // the one raw-body route aside, POSTs are JSON, read here for the stage check
        let body = match json_body(reader, &head, BODY_MAX) {
            Ok(b) => b,
            Err(E::ClientGone) => return Ok(false),
            Err(e) => {
                m::drain_unread(reader, &head, false);
                let _ = json(reader.get_mut(), csp, 400, &error(&e.message()));
                return Ok(false);
            }
        };
        let refused = if inner == "/v1/stage" { stage_refused(port, &who, &body) } else { "" };
        if !refused.is_empty() {
            let _ = json(reader.get_mut(), csp, 403, &error(refused));
            return Ok(false);
        }
        preset = Some(body);
    }
    let preset_read = preset.is_some();
    let mut ctx = Ctx::web(&relay, &mut *reader, &head, address, inner.clone(), &query, who, preset);
    let method = head.method.clone();
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| crate::meet_routes::dispatch(&mut ctx, &method)));
    let raw = ctx.raw.take();
    let (body_read, closing) = (ctx.body_read || preset_read, ctx.close);
    drop(ctx);
    let close = m::drain_unread(reader, &head, body_read) || close || closing;
    let (status, payload) = match result {
        Ok(Some(a)) => a,
        Ok(None) => return Ok(false),
        Err(_) => (500, error("the relay failed this request")),
    };
    if let Some(raw) = raw {
        let keep = match raw {
            Raw::File(file) => m::send_file(reader.get_mut(), file, &inner, None),
            Raw::Bytes(headers, body) => m::send_bytes(reader.get_mut(), &headers, &body, &inner, None),
        };
        return Ok(keep && !close);
    }
    match json(reader.get_mut(), csp, status, &payload) {
        Ok(()) => Ok(!close),
        Err(e) if is_client_gone(&e) => Ok(false),
        Err(e) => Err(e),
    }
}
