// Phase B (ADR-0540): the LUCID collab relay broker, a drop-in for tools/relay/serve.ts over
// desktop/collab/relay_server.ts (P-COLLAB.5/.9, ADR-0192/0195; P-REMOTE.1/.2/.7/.16, ADR-0226/0227/0431). A dumb
// forwarder of OPAQUE E2E-sealed frames: it reads and rewrites only the 4-byte peer header and never holds a room key.
//
//   `…/r/<roomId>?role=host|guest` upgrades to a WebSocket. BINARY frames are `[4B BE target peer][sealed]`; the relay
//   rewrites the header to the SENDER's peer id (host = 0, guests 1, 2, 3…): a host frame to 0 goes to every guest,
//   to n to that guest; a guest frame always goes to the host. STRING frames from the relay are JSON control:
//   peer-joined / peer-left (to the host), room-closed (to guests), auth-ok, and pong for the exact client keepalive
//   `{"t":"ping"}`. Fatal close codes: 4001 room closed, 4004 no such room, 4009 host already connected, 4029 full,
//   4401 / 4403 / 4429 from the optional identity gate, 1013 when a peer that does not read lets its outgoing queue
//   (frames, control strings and pongs) pass MAX_QUEUE_BYTES. Connections are capped (server.rs CONN_LIMITS), and a
//   TLS handshake gets 10 s.
//
//   lucid-relay collab [--host=0.0.0.0] [--port=8790] [--tls-cert=f --tls-key=f]
//     (or HOST, PORT, TLS_CERT, TLS_KEY, MAX_ROOMS, MAX_PEERS_PER_ROOM, MAX_FRAME_BYTES, IDLE_TIMEOUT_SEC,
//      RELAY_PWA_REDIRECT, RELAY_AUTH and the rest of relay_auth.ts / relay_presence.ts's environment)

use crate::codec::{iso_time, js_number, stringify};
use crate::collab_auth::{auth_from_env, AuthGate, Verdict};
use crate::collab_presence::{Presence, Principal};
use crate::http_client::HttpClient;
use crate::server::{tls_within, ConnLimits, CONN_LIMITS};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{CONNECTION, CONTENT_TYPE, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, UPGRADE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role as WsRole, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

const KEEPALIVE_PING: &str = r#"{"t":"ping"}"#;
const KEEPALIVE_PONG: &str = r#"{"t":"pong"}"#;
/// After the relay sends a close frame, how long it waits for the peer's before dropping the connection.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// The most a connection's outgoing queue holds (frames, control strings and pongs waiting for its socket); past it
/// the connection is closed with 1013, so a peer that never reads cannot grow the relay's memory.
pub const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
/// What one queued message costs beyond its payload (its allocation and channel slot), so tiny pongs count too.
const QUEUE_OVERHEAD: usize = 64;
/// How long a 1013 close gets to reach a peer over its queue before the socket is dropped.
const OVERFLOW_CLOSE_WAIT: Duration = Duration::from_secs(1);

/// `[lucid-relay] <ISO time> <message>[ <JSON detail>]` on stdout, as serve.ts logs.
pub fn log(message: &str, detail: Option<Value>) {
    let tail = detail.map(|d| format!(" {}", stringify(&d))).unwrap_or_default();
    println!("[lucid-relay] {} {message}{tail}", iso_time(crate::codec::now_ms()));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Host,
    Guest,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Guest => "guest",
        }
    }
}

enum Out {
    Text(String),
    Binary(Vec<u8>),
    Ping,
    Close(u16, String),
}

impl Out {
    /// What this message counts against its connection's queue (a close is never refused, so never counted).
    fn weight(&self) -> usize {
        QUEUE_OVERHEAD
            + match self {
                Out::Text(s) => s.len(),
                Out::Binary(b) => b.len(),
                Out::Ping | Out::Close(..) => 0,
            }
    }
}

/// A connection's outgoing queue: the channel to its writer, the bytes waiting in it (the writer takes off what it
/// has sent), its cap, and the signal that it went over.
struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
    queued: Arc<AtomicUsize>,
    cap: usize,
    over: watch::Sender<bool>,
}

struct Conn {
    out: Outbox,
    room_id: String,
    role: Role,
    peer: u32,
    authed: bool,
    authing: bool,
    uid: Option<String>,
    principal: Option<Principal>,
    closing: bool,
}

struct Room {
    host: Option<u64>,
    host_uid: Option<String>,
    guests: BTreeMap<u32, u64>,
    peer_seq: u32,
    /// The pending grace timer's generation, 0 when none.
    grace: u64,
}

#[derive(Default)]
struct State {
    rooms: HashMap<String, Room>,
    conns: HashMap<u64, Conn>,
    recent: HashMap<String, Vec<i64>>,
    next: u64,
}

pub struct Limits {
    pub max_rooms: f64,
    pub max_peers: f64,
    pub max_frame: usize,
    pub idle: Duration,
    /// MAX_QUEUE_BYTES, smaller in tests.
    pub max_queue: usize,
}

pub struct Broker {
    limits: Limits,
    pwa: Option<String>,
    auth: Option<AuthGate>,
    presence: Option<Arc<Presence>>,
    state: Mutex<State>,
}

fn send(st: &mut State, id: u64, out: Out) {
    let Some(c) = st.conns.get_mut(&id) else { return };
    if c.closing {
        return;
    }
    if matches!(out, Out::Close(..)) {
        c.closing = true;
    } else {
        let weight = out.weight();
        let held = c.out.queued.load(Ordering::SeqCst);
        if held + weight > c.out.cap {
            // A peer that does not read: its socket goes (1013) rather than the relay holding its backlog.
            c.closing = true;
            c.out.over.send_replace(true);
            log("relay: outgoing queue full, connection closed", Some(json!({ "code": 1013, "role": c.role.as_str(), "peer": c.peer, "queuedBytes": held })));
            return;
        }
        c.out.queued.fetch_add(weight, Ordering::SeqCst);
    }
    let _ = c.out.tx.send(out);
}

fn close(st: &mut State, id: u64, code: u16, reason: &str) {
    // A close reason is at most 123 bytes on the wire.
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    send(st, id, Out::Close(code, reason[..end].to_owned()));
}

fn ctrl(v: Value) -> Out {
    Out::Text(stringify(&v))
}

fn pack(peer: u32, sealed: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + sealed.len());
    out.extend_from_slice(&peer.to_be_bytes());
    out.extend_from_slice(sealed);
    out
}

impl Broker {
    pub fn new(limits: Limits, pwa: Option<String>, auth: Option<AuthGate>, presence: Option<Arc<Presence>>) -> Broker {
        Broker { limits, pwa, auth, presence, state: Mutex::new(State::default()) }
    }

    pub fn counts(&self) -> (usize, usize) {
        let st = self.state.lock();
        let peers = st.rooms.values().map(|r| r.guests.len() + usize::from(r.host.is_some())).sum();
        (st.rooms.len(), peers)
    }

    /// Kick every guest and delete the room (the host-close path and the grace expiry).
    fn teardown(&self, st: &mut State, room_id: &str) {
        let Some(room) = st.rooms.remove(room_id) else { return };
        for g in room.guests.values() {
            send(st, *g, ctrl(json!({ "t": "room-closed" })));
            close(st, *g, 4001, "room closed");
        }
        if let Some(p) = &self.presence {
            p.host_closed(room_id);
        }
        log("relay: room closed", None);
    }

    /// Room admission: at open in anonymous mode, after the verified auth frame in gated mode.
    fn admit(&self, st: &mut State, id: u64) -> bool {
        let Some(c) = st.conns.get(&id) else { return false };
        let (room_id, role, uid, principal) = (c.room_id.clone(), c.role, c.uid.clone(), c.principal.clone());
        let gated = self.auth.is_some();
        if role == Role::Host {
            if let Some(existing) = st.rooms.get(&room_id) {
                let owner = gated && uid.is_some() && existing.host_uid == uid;
                if let Some(stale) = existing.host {
                    if owner {
                        // P-REMOTE.2: the same signed-in account replaces its own lingering socket. Adopt first, so the
                        // stale socket's close finds another host and leaves the room alone.
                        let guests: Vec<u32> = existing.guests.keys().copied().collect();
                        if let Some(r) = st.rooms.get_mut(&room_id) {
                            r.host = Some(id);
                        }
                        close(st, stale, 4009, "replaced by a newer connection from the same account");
                        for peer in guests {
                            send(st, id, ctrl(json!({ "t": "peer-joined", "peer": peer })));
                        }
                        if let (Some(p), Some(who)) = (&self.presence, &principal) {
                            p.host_reclaimed(&room_id, who);
                        }
                        log("relay: host re-claimed room (live socket replaced)", None);
                        return true;
                    }
                    close(st, id, 4009, "a host is already connected for this room");
                    return false;
                }
                // A hostless room exists only inside the re-claim grace; only its owner resumes it.
                if owner {
                    let guests: Vec<u32> = existing.guests.keys().copied().collect();
                    if let Some(r) = st.rooms.get_mut(&room_id) {
                        r.grace = 0;
                        r.host = Some(id);
                    }
                    for peer in guests {
                        send(st, id, ctrl(json!({ "t": "peer-joined", "peer": peer })));
                    }
                    if let (Some(p), Some(who)) = (&self.presence, &principal) {
                        p.host_reclaimed(&room_id, who);
                    }
                    log("relay: host re-claimed room (within grace)", None);
                    return true;
                }
                close(st, id, 4009, "this room is reserved for its host");
                return false;
            }
            if st.rooms.len() as f64 >= self.limits.max_rooms {
                close(st, id, 4029, "relay is at room capacity");
                return false;
            }
            if let Some(u) = &uid {
                let held = st.rooms.values().filter(|r| r.host_uid.as_ref() == Some(u)).count();
                if held >= self.auth.as_ref().map_or(4, |a| a.max_rooms_per_user) {
                    close(st, id, 4429, "per-user room quota reached");
                    return false;
                }
            }
            st.rooms.insert(room_id.clone(), Room { host: Some(id), host_uid: uid, guests: BTreeMap::new(), peer_seq: 1, grace: 0 });
            if let (Some(p), Some(who)) = (&self.presence, &principal) {
                p.host_started(&room_id, who);
            }
            log("relay: host opened room", None);
            return true;
        }
        let Some(room) = st.rooms.get(&room_id).filter(|r| r.host.is_some()) else {
            close(st, id, 4004, "no such room");
            return false;
        };
        if room.guests.len() as f64 >= self.limits.max_peers {
            close(st, id, 4029, "room is full");
            return false;
        }
        let host = room.host;
        let Some(room) = st.rooms.get_mut(&room_id) else { return false };
        let peer = room.peer_seq;
        room.peer_seq += 1;
        room.guests.insert(peer, id);
        if let Some(c) = st.conns.get_mut(&id) {
            c.peer = peer;
        }
        if let Some(h) = host {
            send(st, h, ctrl(json!({ "t": "peer-joined", "peer": peer })));
        }
        if let (Some(p), Some(who)) = (&self.presence, &principal) {
            p.guest_joined(&room_id, peer, who);
        }
        log("relay: guest joined", Some(json!({ "peerId": peer })));
        true
    }

    fn open(self: &Arc<Self>, room_id: String, role: Role, out: Outbox) -> u64 {
        let mut st = self.state.lock();
        st.next += 1;
        let id = st.next;
        st.conns.insert(id, Conn { out, room_id, role, peer: 0, authed: false, authing: false, uid: None, principal: None, closing: false });
        match &self.auth {
            // Gated: not admitted yet; the first frame must authenticate within the deadline.
            Some(gate) => {
                let me = self.clone();
                let deadline = Duration::from_millis(gate.deadline_ms);
                tokio::spawn(async move {
                    tokio::time::sleep(deadline).await;
                    let mut st = me.state.lock();
                    if st.conns.get(&id).is_some_and(|c| !c.authed) {
                        close(&mut st, id, 4401, "authentication deadline");
                    }
                });
            }
            None => {
                self.admit(&mut st, id);
            }
        }
        id
    }

    fn on_text(self: &Arc<Self>, id: u64, text: &str) {
        let mut st = self.state.lock();
        let Some(c) = st.conns.get(&id).filter(|c| !c.closing) else { return };
        if self.auth.is_some() && !c.authed {
            // The ONLY acceptable pre-auth frame is {"t":"auth","token":…}; anything else is 4401.
            if c.authing {
                return;
            }
            let token = crate::codec::parse_json(text).and_then(|f| {
                (f.get("t").and_then(Value::as_str) == Some("auth")).then_some(())?;
                f.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned)
            });
            let Some(token) = token else {
                close(&mut st, id, 4401, "expected an auth frame");
                return;
            };
            if let Some(c) = st.conns.get_mut(&id) {
                c.authing = true;
            }
            let me = self.clone();
            tokio::spawn(async move {
                let verdict = match &me.auth {
                    Some(gate) => gate.verifier.verify(&token).await,
                    None => return,
                };
                me.on_verdict(id, verdict);
            });
            return;
        }
        // The exact client keepalive is answered on the same socket; every other string is ignored.
        if text == KEEPALIVE_PING {
            if let Some(p) = &self.presence {
                p.activity(&c.room_id, c.role.as_str(), c.peer, "heartbeat");
            }
            send(&mut st, id, Out::Text(KEEPALIVE_PONG.into()));
        }
    }

    fn on_verdict(&self, id: u64, verdict: Verdict) {
        let mut st = self.state.lock();
        let Some(c) = st.conns.get_mut(&id) else { return };
        c.authing = false;
        let (uid, email, premium, admin) = match verdict {
            Verdict::Refused { code, reason } => {
                log("relay: auth refused", Some(json!({ "code": code })));
                close(&mut st, id, code, &reason);
                return;
            }
            Verdict::Ok { uid, email, premium, admin } => (uid, email, premium, admin),
        };
        let t = crate::codec::now_ms();
        if st.recent.len() > 4096 {
            st.recent.retain(|_, stamps| {
                stamps.retain(|s| t - *s < 60_000);
                !stamps.is_empty()
            });
        }
        let stamps = st.recent.entry(uid.clone()).or_default();
        stamps.retain(|s| t - *s < 60_000);
        stamps.push(t);
        let over = stamps.len() > self.auth.as_ref().map_or(30, |a| a.max_connects_per_minute);
        if over {
            close(&mut st, id, 4429, "per-user connect rate exceeded");
            return;
        }
        if let Some(c) = st.conns.get_mut(&id) {
            c.authed = true;
            c.uid = Some(uid.clone());
            c.principal = Some(Principal { uid, email, admin, premium, effective_premium: premium || admin });
        }
        if self.admit(&mut st, id) {
            send(&mut st, id, ctrl(json!({ "t": "auth-ok" })));
        }
    }

    fn on_binary(&self, id: u64, bytes: &[u8]) {
        let mut st = self.state.lock();
        let Some(c) = st.conns.get(&id).filter(|c| !c.closing) else { return };
        if self.auth.is_some() && !c.authed {
            close(&mut st, id, 4401, "authenticate first");
            return;
        }
        let (room_id, role, peer) = (c.room_id.clone(), c.role, c.peer);
        let Some(room) = st.rooms.get(&room_id) else { return };
        if bytes.len() < 4 {
            return; // runt envelope
        }
        let target = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let sealed = &bytes[4..];
        if let Some(p) = &self.presence {
            p.activity(&room_id, role.as_str(), peer, "binary");
        }
        let deliveries: Vec<(u64, Vec<u8>)> = if role == Role::Host {
            // Header = the sender: the host is peer 0. Target 0 broadcasts, any other unicasts.
            let out = pack(0, sealed);
            if target == 0 {
                room.guests.values().map(|g| (*g, out.clone())).collect()
            } else {
                room.guests.get(&target).map(|g| (*g, out)).into_iter().collect()
            }
        } else {
            // A guest's frame goes to the host, tagged with the guest's peer id, whatever target it wrote.
            room.host.map(|h| (h, pack(peer, sealed))).into_iter().collect()
        };
        for (to, frame) in deliveries {
            send(&mut st, to, Out::Binary(frame));
        }
    }

    fn on_close(self: &Arc<Self>, id: u64) {
        let mut st = self.state.lock();
        let Some(c) = st.conns.remove(&id) else { return };
        let Some(room) = st.rooms.get_mut(&c.room_id) else { return };
        if c.role == Role::Host {
            // Only the socket that OWNS the room tears it down.
            if room.host != Some(id) {
                return;
            }
            let grace = self.auth.as_ref().map_or(0, |a| a.reclaim_grace_ms);
            if self.auth.is_some() && room.host_uid.is_some() && grace > 0 && !room.guests.is_empty() {
                // P-REMOTE.2: a dropped host's room with live guests waits for the same account to re-claim it.
                room.host = None;
                st.next += 1;
                let generation = st.next;
                if let Some(r) = st.rooms.get_mut(&c.room_id) {
                    r.grace = generation;
                }
                let me = self.clone();
                let room_id = c.room_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(grace)).await;
                    let mut st = me.state.lock();
                    if st.rooms.get(&room_id).is_some_and(|r| r.host.is_none() && r.grace == generation) {
                        me.teardown(&mut st, &room_id);
                    }
                });
                if let Some(p) = &self.presence {
                    p.host_grace(&c.room_id);
                }
                log("relay: host dropped, holding room for re-claim", None);
                return;
            }
            self.teardown(&mut st, &c.room_id);
        } else if room.guests.remove(&c.peer).is_some() {
            let host = room.host;
            if let Some(p) = &self.presence {
                p.guest_left(&c.room_id, c.peer);
            }
            if let Some(h) = host {
                send(&mut st, h, ctrl(json!({ "t": "peer-left", "peer": c.peer })));
            }
        }
    }

    /// The terminal presence snapshot for every open room (handle.stop()).
    pub fn stop(&self) {
        let st = self.state.lock();
        if let Some(p) = &self.presence {
            for room_id in st.rooms.keys() {
                p.host_closed(room_id);
            }
        }
    }
}

fn text_response(status: StatusCode, content_type: &str, body: String) -> Response<Full<Bytes>> {
    Response::builder().status(status).header(CONTENT_TYPE, content_type).body(Full::new(Bytes::from(body))).unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn plain(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    text_response(status, "text/plain;charset=utf-8", body.to_owned())
}

/// The fragment-forwarding page for a stale relay-host invite (P-REMOTE.4a); `base` is trusted config.
fn pwa_redirect_html(base: &str) -> String {
    let b = stringify(&Value::from(base.trim_end_matches('/')));
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>Opening LUCID Remote\u{2026}</title><style>body{{background:#0a0b0f;color:#e8edf5;font:15px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:56px 22px}}a{{color:#2dd4bf;word-break:break-all}}</style></head><body><p>Opening LUCID Remote\u{2026}</p><p><a id=\"go\" href={b}>Tap here if it doesn't open automatically</a></p><script>(function(){{var base={b};var dest=base+(location.hash||\"\");var a=document.getElementById(\"go\");if(a)a.href=dest;location.replace(dest);}})();</script></body></html>"
    )
}

/// decodeURIComponent, or None where it would throw.
fn decode_component(s: &str, plus_is_space: bool) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' if plus_is_space => {
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

/// url.searchParams.get(name): the first value, form-decoded (an undecodable escape is kept as written).
fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = decode_component(k, true).unwrap_or_else(|| k.to_owned());
        (k == name).then(|| decode_component(v, true).unwrap_or_else(|| v.to_owned()))
    })
}

async fn handle(broker: Arc<Broker>, mut req: hyper::Request<Incoming>, permit: Arc<OwnedSemaphorePermit>) -> Response<Full<Bytes>> {
    let path = req.uri().path().to_owned();
    // A Firebase Hosting rewrite forwards `/relay/r/<id>`: an optional `/relay` prefix is stripped.
    let pathname = if path == "/relay" {
        "/".to_owned()
    } else if path.starts_with("/relay/") {
        path["/relay".len()..].to_owned()
    } else {
        path
    };
    if pathname == "/healthz" {
        let (rooms, peers) = broker.counts();
        let body = stringify(&json!({ "ok": true, "service": "lucid-collab-relay", "rooms": rooms, "peers": peers }));
        return text_response(StatusCode::OK, "application/json", body);
    }
    if pathname == "/" {
        if let Some(base) = &broker.pwa {
            return text_response(StatusCode::OK, "text/html; charset=utf-8", pwa_redirect_html(base));
        }
    }
    let segment = pathname.strip_prefix("/r/").filter(|s| !s.is_empty() && !s.contains('/'));
    let Some(segment) = segment.map(str::to_owned) else { return plain(StatusCode::NOT_FOUND, "not a relay room") };
    let role = match query_param(req.uri().query(), "role").as_deref() {
        Some("host") => Role::Host,
        Some("guest") => Role::Guest,
        _ => return plain(StatusCode::BAD_REQUEST, "role must be host|guest"),
    };
    let Some(room_id) = decode_component(&segment, false) else { return plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error") };
    let upgrade = req.headers().get(UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let key = req.headers().get(SEC_WEBSOCKET_KEY).map(|k| derive_accept_key(k.as_bytes()));
    let (true, Some(accept)) = (upgrade, key) else { return plain(StatusCode::UPGRADE_REQUIRED, "expected a websocket upgrade") };
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        // The connection's slot stays taken while its WebSocket runs.
        let _permit = permit;
        let Ok(upgraded) = on_upgrade.await else { return };
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = Some(broker.limits.max_frame);
        cfg.max_frame_size = Some(broker.limits.max_frame);
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), WsRole::Server, Some(cfg)).await;
        run_socket(broker, ws, room_id, role).await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(UPGRADE, "websocket")
        .header(CONNECTION, "Upgrade")
        .header(SEC_WEBSOCKET_ACCEPT, accept)
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

async fn run_socket<S>(broker: Arc<Broker>, ws: WebSocketStream<S>, room_id: String, role: Role)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    let queued = Arc::new(AtomicUsize::new(0));
    let (over_tx, mut over) = watch::channel(false);
    let closing = Arc::new(AtomicBool::new(false));
    let writer_closing = closing.clone();
    let writer_queued = queued.clone();
    let mut writer_over = over.clone();
    let mut writer = tokio::spawn(async move {
        let mut overflowed = false;
        loop {
            let out = tokio::select! {
                biased;
                Ok(_) = writer_over.wait_for(|o| *o) => {
                    overflowed = true;
                    break;
                }
                out = rx.recv() => match out {
                    Some(out) => out,
                    None => break,
                },
            };
            let weight = out.weight();
            let msg = match out {
                Out::Text(s) => Message::text(s),
                Out::Binary(b) => Message::binary(b),
                Out::Ping => Message::Ping(Default::default()),
                Out::Close(code, reason) => {
                    writer_closing.store(true, Ordering::SeqCst);
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                    break;
                }
            };
            // A send stuck on a peer that does not read gives way to the overflow close.
            let sent = tokio::select! {
                biased;
                Ok(_) = writer_over.wait_for(|o| *o) => {
                    overflowed = true;
                    break;
                }
                sent = sink.send(msg) => sent,
            };
            writer_queued.fetch_sub(weight, Ordering::SeqCst);
            if sent.is_err() {
                break;
            }
        }
        if overflowed {
            writer_closing.store(true, Ordering::SeqCst);
            let frame = Message::Close(Some(CloseFrame { code: CloseCode::from(1013), reason: "outgoing queue full".into() }));
            let _ = tokio::time::timeout(OVERFLOW_CLOSE_WAIT, sink.send(frame)).await;
        }
    });
    let id = broker.open(room_id, role, Outbox { tx, queued, cap: broker.limits.max_queue, over: over_tx });
    let mut pinged = false;
    loop {
        let wait = if closing.load(Ordering::SeqCst) { CLOSE_WAIT } else { broker.limits.idle };
        let next = tokio::select! {
            biased;
            // Over its queue: the reader stops at once, the writer sends the 1013.
            Ok(_) = over.wait_for(|o| *o) => break,
            next = tokio::time::timeout(wait, stream.next()) => next,
        };
        match next {
            Err(_) => {
                // Idle: one ping, then drop the socket if the peer still says nothing (Bun's sendPings).
                if pinged || closing.load(Ordering::SeqCst) {
                    break;
                }
                pinged = true;
                send(&mut broker.state.lock(), id, Out::Ping);
            }
            Ok(None) => break,
            Ok(Some(Err(WsError::Capacity(_)))) => {
                let mut st = broker.state.lock();
                close(&mut st, id, 1009, "Received too big message");
                drop(st);
            }
            Ok(Some(Err(_))) => break,
            Ok(Some(Ok(msg))) => {
                pinged = false;
                match msg {
                    Message::Text(t) => broker.on_text(id, t.as_str()),
                    Message::Binary(b) => broker.on_binary(id, &b[..]),
                    _ => {}
                }
            }
        }
    }
    // The connection's record (and with it the queue's sender) goes; the writer drains what is left, but never waits
    // on a peer that does not read for longer than CLOSE_WAIT.
    broker.on_close(id);
    if tokio::time::timeout(CLOSE_WAIT, &mut writer).await.is_err() {
        writer.abort();
    }
}

/// Accept connections until the process stops.
async fn serve(listener: tokio::net::TcpListener, broker: Arc<Broker>, acceptor: Option<TlsAcceptor>, limits: ConnLimits) {
    let slots = Arc::new(Semaphore::new(limits.connections));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        // Every slot taken: this connection is dropped unread.
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let broker = broker.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            // Held until the connection (and its WebSocket, which runs inside the upgrade) is gone.
            let permit = Arc::new(permit);
            let svc = service_fn(move |req| {
                let broker = broker.clone();
                let permit = permit.clone();
                async move { Ok::<_, Infallible>(handle(broker, req, permit).await) }
            });
            let mut builder = http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(30));
            match acceptor {
                Some(a) => {
                    if let Some(s) = tls_within(&a, stream, limits.handshake).await {
                        let _ = builder.serve_connection(TokioIo::new(s), svc).with_upgrades().await;
                    }
                }
                None => {
                    let _ = builder.serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
                }
            }
        });
    }
}

/// serve.ts envInt: a positive number, else the fallback.
fn env_number(env: &HashMap<String, String>, name: &str, fallback: f64) -> f64 {
    let n = env.get(name).filter(|v| !v.is_empty()).map_or(f64::NAN, |v| js_number(v));
    if n.is_finite() && n > 0.0 { n } else { fallback }
}

fn fail(code: i32, message: &str) -> ! {
    eprintln!("[lucid-relay] {message}");
    std::process::exit(code);
}

/// `lucid-relay collab …`: tools/relay/serve.ts.
pub fn main(argv: &[String]) -> ! {
    let mut args = HashMap::new();
    for a in argv {
        if let Some((k, v)) = a.strip_prefix("--").and_then(|r| r.split_once('=')).filter(|(k, _)| !k.is_empty()) {
            args.insert(k.to_owned(), v.to_owned());
        }
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let host = args.get("host").or_else(|| env.get("HOST")).cloned().unwrap_or_else(|| "0.0.0.0".into());
    let port = match args.get("port").filter(|p| !p.is_empty()) {
        Some(p) => js_number(p),
        None => env_number(&env, "PORT", 8790.0),
    };
    let cert = args.get("tls-cert").or_else(|| env.get("TLS_CERT")).filter(|v| !v.is_empty());
    let key = args.get("tls-key").or_else(|| env.get("TLS_KEY")).filter(|v| !v.is_empty());
    let tls = match (cert, key) {
        (Some(c), Some(k)) => match (std::fs::read_to_string(c), std::fs::read_to_string(k)) {
            (Ok(c), Ok(k)) => Some((c, k)),
            (Err(e), _) | (_, Err(e)) => fail(2, &format!("cannot read TLS cert/key: {e}")),
        },
        _ => None,
    };
    let limits = Limits {
        max_rooms: env_number(&env, "MAX_ROOMS", 256.0),
        max_peers: env_number(&env, "MAX_PEERS_PER_ROOM", 16.0),
        max_frame: env_number(&env, "MAX_FRAME_BYTES", 512.0 * 1024.0) as usize,
        idle: Duration::from_secs_f64(env_number(&env, "IDLE_TIMEOUT_SEC", 120.0)),
        max_queue: MAX_QUEUE_BYTES,
    };
    let pwa = env.get("RELAY_PWA_REDIRECT").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| fail(1, &format!("failed to start: {e}")));
    runtime.block_on(async move {
        let client = HttpClient::new().unwrap_or_else(|e| fail(1, &format!("failed to start: {e}")));
        let (auth, auth_summary) = auth_from_env(&env, &client).unwrap_or_else(|e| fail(2, &format!("auth config error: {e}")));
        let (presence, presence_summary) = match Presence::from_env(&env, &client, Arc::new(|m: &str, d: Option<Value>| log(m, d))) {
            Ok(None) => (None, "relay telemetry: off"),
            Ok(Some(p)) => (Some(p), "relay telemetry: metadata-only Firestore presence enabled"),
            Err(_) => (None, "relay telemetry: disabled by invalid configuration"),
        };
        if !(port.fract() == 0.0 && (0.0..=65_535.0).contains(&port)) {
            fail(1, &format!("failed to start: port {} is not 0 to 65535", crate::codec::js_number_string(port)));
        }
        let acceptor = tls.as_ref().map(|(c, k)| crate::server::tls_acceptor(c, k).unwrap_or_else(|e| fail(1, &format!("failed to start: {e}"))));
        let bind = if host.is_empty() { "0.0.0.0" } else { host.as_str() };
        let listener = tokio::net::TcpListener::bind((bind, port as u16)).await.unwrap_or_else(|e| fail(1, &format!("failed to start: {e}")));
        let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port as u16);
        let broker = Arc::new(Broker::new(limits, pwa.clone(), auth, presence.clone()));
        let scheme = if tls.is_some() { "wss" } else { "ws" };
        let s = if tls.is_some() { "s" } else { "" };
        log(&format!("LUCID collab relay listening on {scheme}://{host}:{bound}  (health: http{s}://{host}:{bound}/healthz)"), None);
        log("forwarding OPAQUE E2E-sealed frames only - the relay never holds a room key", None);
        log(&auth_summary, None);
        log(presence_summary, None);
        if let Some(base) = &pwa {
            log(&format!("invite fallback: GET / forwards a stale relay-host QR to {base}"), None);
        }
        if tls.is_none() {
            log("serving plain ws:// - terminate TLS at a reverse proxy for wss:// (see tools/relay/README.md)", None);
        }
        let status = broker.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(60));
            every.tick().await;
            loop {
                every.tick().await;
                let (rooms, peers) = status.counts();
                log("status", Some(json!({ "rooms": rooms, "peers": peers })));
            }
        });
        tokio::spawn(serve(listener, broker.clone(), acceptor, CONN_LIMITS));
        let signal = stop_signal().await;
        log(&format!("{signal} - shutting down ({} rooms open)", broker.counts().0), None);
        broker.stop();
        if let Some(p) = presence {
            let _ = tokio::time::timeout(Duration::from_secs(1), p.flush()).await;
        }
    });
    std::process::exit(0)
}

#[cfg(unix)]
async fn stop_signal() -> &'static str {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        std::future::pending::<()>().await;
        return "SIGTERM";
    };
    tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    }
}

#[cfg(not(unix))]
async fn stop_signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "SIGINT"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_and_path_decoding_follow_url() {
        assert_eq!(query_param(Some("role=host"), "role").as_deref(), Some("host"));
        assert_eq!(query_param(Some("x=1&role=guest&role=host"), "role").as_deref(), Some("guest"));
        assert_eq!(query_param(None, "role"), None);
        assert_eq!(decode_component("room%2Fa", false).as_deref(), Some("room/a"));
        assert_eq!(decode_component("bad%zz", false), None);
        assert_eq!(pack(7, &[1, 2]), vec![0, 0, 0, 7, 1, 2]);
        assert!(pwa_redirect_html("https://x.app/remote/").contains("\"https://x.app/remote\""));
    }

    type Client = WebSocketStream<tokio::net::TcpStream>;

    async fn dial(port: u16, path: &str) -> Client {
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}{path}"), tcp).await.unwrap().0
    }

    /// The next control string a client gets, as JSON.
    async fn next_ctrl(ws: &mut futures_util::stream::SplitStream<Client>) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("a control string in time") {
                Some(Ok(Message::Text(t))) => return crate::codec::parse_json(t.as_str()).unwrap_or(Value::Null),
                Some(Ok(_)) => continue,
                _ => panic!("the socket ended"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_guest_that_never_reads_is_closed_while_the_room_goes_on() {
        const CAP: usize = 1024 * 1024;
        const FRAME: usize = 32 * 1024;
        const STEP: usize = 8;
        let limits = Limits { max_rooms: 8.0, max_peers: 8.0, max_frame: 64 * 1024, idle: Duration::from_secs(120), max_queue: CAP };
        let broker = Arc::new(Broker::new(limits, None, None, None));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, broker.clone(), None, CONN_LIMITS));
        let (mut host_tx, mut host_rx) = dial(port, "/r/room-q?role=host").await.split();
        // The host's room exists once its socket task has opened it.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while broker.counts().0 == 0 {
            assert!(tokio::time::Instant::now() < deadline, "the host never opened its room");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let reader = dial(port, "/r/room-q?role=guest").await;
        assert_eq!(next_ctrl(&mut host_rx).await, json!({ "t": "peer-joined", "peer": 1 }));
        let mut stuck = dial(port, "/r/room-q?role=guest").await;
        assert_eq!(next_ctrl(&mut host_rx).await, json!({ "t": "peer-joined", "peer": 2 }));
        // The guest that reads counts every frame that reaches it.
        let got = Arc::new(AtomicUsize::new(0));
        let counted = got.clone();
        tokio::spawn(async move {
            let mut reader = reader;
            while let Some(Ok(m)) = reader.next().await {
                if let Message::Binary(b) = m {
                    assert_eq!(&b[..4], &[0, 0, 0, 0], "a host frame carries peer 0");
                    counted.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        let caught_up = |want: usize| {
            let got = got.clone();
            async move {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                while got.load(Ordering::SeqCst) < want {
                    assert!(tokio::time::Instant::now() < deadline, "the reading guest fell behind");
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }
        };
        // The host broadcasts in steps the reading guest keeps up with; the other guest reads nothing, so its queue
        // (past what the sockets buffer) reaches the cap and the relay closes it.
        let mut sent = 0usize;
        let left = loop {
            for _ in 0..STEP {
                host_tx.send(Message::binary(vec![0u8; FRAME])).await.unwrap();
                sent += 1;
            }
            caught_up(sent).await;
            if let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_millis(1), host_rx.next()).await {
                break crate::codec::parse_json(t.as_str()).unwrap_or(Value::Null);
            }
            assert!(sent * FRAME < 1024 * 1024 * 1024, "the guest that never reads was never closed");
        };
        assert_eq!(left, json!({ "t": "peer-left", "peer": 2 }));
        // The host and the other guest go on: a frame for peer 1 still arrives, and the room holds both.
        let mut to_one = vec![0u8; FRAME];
        to_one[3] = 1;
        host_tx.send(Message::binary(to_one)).await.unwrap();
        caught_up(sent + 1).await;
        assert_eq!(broker.counts(), (1, 2));
        // The closed guest finds its socket ended (a 1013 close, when it got through, or the dropped connection)
        // after fewer frames than were sent.
        let mut frames = 0usize;
        let ended = loop {
            match tokio::time::timeout(Duration::from_secs(30), stuck.next()).await {
                Err(_) => break None,
                Ok(Some(Ok(Message::Binary(_)))) => frames += 1,
                Ok(Some(Ok(Message::Close(frame)))) => break Some(frame.map(|f| u16::from(f.code))),
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => break Some(None),
            }
        };
        let ended = ended.expect("the closed guest's socket ended");
        assert!(ended.is_none_or(|code| code == 1013), "closed with {ended:?}");
        assert!(frames < sent, "{frames} of {sent} frames");
    }
}
