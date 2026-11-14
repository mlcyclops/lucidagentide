// Phase C (ADR-0540), wave 3: large calls (meet_relay._Wave3LargeCalls). A LiveKit SFU carries the media of a call a
// mesh cannot hold. The media mode is chosen once per stay, at its first join: `sfu` when the relay has a media server
// and the first joiner asked for a large call (join `large: true`), or the room is a scheduled meeting of
// `sfu_threshold` or more people, or the call of a group chat or channel with that many members; else `mesh` (at most
// PEER_MAX_PER_ROOM). The join answer says `media` and, for sfu, `sfu: {url, token, expires}`: a LiveKit access token
// (JWT HS256 with the media server's API secret) for identity `<principal>|<peer>` in a LiveKit room of its own per
// stay (`<room>.s<12 hex>`), valid TOKEN_TTL, publishing microphone and camera only (the presenter the relay names
// also gets the screen). A peer leaving the relay room is removed from the media server too, the stay's LiveKit room
// is deleted when the stay ends, and every SYNC_EVERY the relay removes any participant that is not a current seat
// and deletes rooms of stays it does not know, so a token never outlives the seat it was given for. Every call to the
// media server runs on its own thread (it may be slow or down, and callers hold the lock). A child module of
// meet_hub: it shares the one lock.
//
// Every sfu stay is end-to-end encrypted (contract E2EE-1); the media server and this relay are untrusted for keys. A
// seat joins one only with `e2ee: true` (409 otherwise) and never as a web guest (403). The join answer adds
// `e2ee: {required: true, stay}` (`stay`: the stay's LiveKit room, bound in what seats sign) and the rows carry each
// seat's `cert`, `epk` and `sig`. `POST /v1/e2ee` publishes a seat's ephemeral key to the room (`e2ee_epk`);
// `POST /v1/e2ee/keys` delivers wrapped group keys from the key leader, each only to its recipient (`e2ee_key`). The
// key leader (`stage.e2ee_leader`) is the host when it is a certificate seat, else the earliest joined certificate
// seat; a change is a stage event. Nothing of it is kept or logged beyond counts.

use super::*;
use crate::meet_tls;

/// A media server token's life (renewed through /v1/sfu/token), and the relay's own RoomService token's.
const TOKEN_TTL: i64 = 600;
const ADMIN_TTL: i64 = 120;
/// How often the media server's rooms are checked against seats, and how soon after a large call starts.
const SYNC_EVERY: f64 = 60.0;
const SYNC_SOON: f64 = 10.0;
/// What any seat may publish, and what the named presenter may.
const SOURCES: [&str; 2] = ["microphone", "camera"];
const PRESENTER_SOURCES: [&str; 4] = ["MICROPHONE", "CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"];
/// sfu_max above this is a typo, not a call.
const MAX_LIMIT: i64 = 1000;
const LOCAL_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];
const NOT_USED: &str = "this call does not use the media server";
const NO_SFU: &str = "this relay has no media server (sfu_url)";
const CALL_TIMEOUT: f64 = 5.0;
// End-to-end encryption of large calls (contract E2EE-1): the relay forwards each seat's ephemeral public key and the
// wrapped group keys as opaque base64; it never holds a key.
const E2EE_REQUIRED: &str = "this call is end-to-end encrypted and this app cannot join it";
pub(super) const E2EE_GUESTS: &str = "guests cannot join an end-to-end encrypted large call";
const E2EE_NOT_LEADER: &str = "only the call's key leader can send keys";
/// An uncompressed P-384 point: 0x04 || X (48) || Y (48).
const E2EE_EPK_BYTES: usize = 97;
const E2EE_BAD_EPK: &str = "epk must be a P-384 public key (base64 of 97 bytes)";
/// Bytes of a DER ECDSA signature (P-384: at most 104).
const E2EE_SIG_MAX: usize = 256;
/// Characters of one wrapped key (base64; 80 in practice).
const E2EE_BLOB_MAX: usize = 512;
/// Recipients of one key delivery.
const E2EE_TO_MAX: usize = 200;
/// Key indexes 0..15 (LiveKit's key ring).
const E2EE_INDEXES: i64 = 16;
/// The body of `/v1/e2ee/keys`: a key delivery to E2EE_TO_MAX recipients with the largest blobs fits.
pub const E2EE_BODY_MAX: usize = 192 * 1024;

/// The media server, from relay.json (checked at start).
pub(super) struct Cfg {
    url: String,
    host: String,
    port: u16,
    tls: bool,
    key: String,
    secret: Vec<u8>,
    threshold: usize,
    max: usize,
}

/// The stays' media modes and LiveKit rooms (from a stay's first join until it is empty).
#[derive(Default)]
pub(super) struct Sfu {
    cfg: Option<Arc<Cfg>>,
    /// room -> "sfu" | "mesh"
    media: HashMap<String, &'static str>,
    /// room -> the LiveKit room of its current stay (sfu stays only)
    rooms: HashMap<String, String>,
    /// room -> the identity the media server lets share a screen ("" = nobody)
    presenter: HashMap<String, String>,
    /// room -> the key leader (peer id, None: nobody) the room was last told (sfu stays)
    leaders: HashMap<String, Option<String>>,
    /// time of the next check against seats, and whether one runs now
    next_sync: f64,
    syncing: bool,
}

/// The media server's room of one stay: `<relay room>.s<12 hex>` (SFU_ROOM_RE, full match).
fn stay_room(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 15 {
        return false;
    }
    let (rest, tail) = b.split_at(b.len() - 14);
    !rest.contains(&b'\n') && tail.starts_with(b".s") && tail[2..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

fn identity(peer: &Peer) -> String {
    format!("{}|{}", peer.who.principal, peer.peer_id)
}

/// A compact JWT, HS256 (what LiveKit verifies with the API secret).
fn jwt(claims: &Obj, secret: &[u8]) -> String {
    let header = crate::codec::b64u(b"{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
    let payload = crate::codec::b64u(pj::dumps_compact(&Value::Object(claims.clone())).as_bytes());
    let signing = format!("{header}.{payload}");
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    let signature = aws_lc_rs::hmac::sign(&key, signing.as_bytes());
    format!("{signing}.{}", crate::codec::b64u(signature.as_ref()))
}

/// The media server may be slow or down, and callers hold the lock: its own thread.
pub(super) fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.to_string()).spawn(f);
}

/// One LiveKit RoomService call (Twirp, JSON) with a short-lived admin token: `(status, answer)`, `(None, None)` when
/// the media server could not be reached.
fn call(cfg: &Cfg, method: &str, body: &Obj, video: Obj) -> (Option<u16>, Option<Obj>) {
    let now = pj::now() as i64;
    let token = jwt(&obj([("iss", Value::from(cfg.key.clone())), ("sub", Value::from("lucid-meet-relay")), ("nbf", Value::from(now - 10)), ("exp", Value::from(now + ADMIN_TTL)), ("video", Value::Object(video))]), &cfg.secret);
    let path = format!("/twirp/livekit.RoomService/{method}");
    let headers = [("Authorization", format!("Bearer {token}")), ("Content-Type", "application/json".to_string())];
    let data = pj::dumps(&Value::Object(body.clone()));
    let sent = if cfg.tls {
        match meet_tls::client_config(None, None) {
            Ok(tls) => meet_tls::https_request(&tls, &cfg.host, cfg.port, CALL_TIMEOUT, "POST", &path, &headers, Some(data.as_bytes()), &|_: &[u8]| Ok(())),
            Err(_) => Err(Err("SSLError".to_string())),
        }
    } else {
        meet_tls::http_request(&cfg.host, cfg.port, CALL_TIMEOUT, "POST", &path, &headers, Some(data.as_bytes()))
    };
    match sent {
        Ok(r) => {
            let answer = if r.body.is_empty() { Some(Obj::new()) } else { serde_json::from_slice::<Value>(&r.body).ok().and_then(|v| v.as_object().cloned()) };
            (Some(r.status), answer)
        }
        Err(e) => {
            log_info(&format!("sfu {method} failed={}", e.unwrap_or_else(|m| m)));
            (None, None)
        }
    }
}

/// _e2ee_b64: the bytes of `value`: standard base64 with padding (RFC 4648 section 4, no line breaks) of `least` to
/// `most` bytes; 400 `message` otherwise.
fn e2ee_b64(value: Body, least: usize, most: usize, message: &str) -> R<Vec<u8>> {
    let Some(Value::String(text)) = value else { return bad(message) };
    if text.is_empty() || text.len() > 4 * most.div_ceil(3) {
        return bad(message);
    }
    match pj::b64_strict(text) {
        Some(raw) if (least..=most).contains(&raw.len()) => Ok(raw),
        _ => bad(message),
    }
}

fn status_text(status: Option<u16>) -> String {
    status.map(|s| s.to_string()).unwrap_or_else(|| "failed".into())
}

fn admin_video(lk_room: &str) -> Obj {
    obj([("room", Value::from(lk_room)), ("roomAdmin", Value::Bool(true))])
}

fn remove_now(cfg: &Cfg, lk_room: &str, who: &str, why: &str) {
    let (status, _) = call(cfg, "RemoveParticipant", &obj([("room", Value::from(lk_room)), ("identity", Value::from(who))]), admin_video(lk_room));
    // 404: the participant had already gone (or never connected): nothing to remove
    log_info(&format!("sfu remove room={lk_room} identity={who} why={why} status={}", status_text(status)));
}

fn delete_room(cfg: &Cfg, lk_room: &str, why: &str) {
    let (status, _) = call(cfg, "DeleteRoom", &obj([("room", Value::from(lk_room))]), obj([("room", Value::from(lk_room)), ("roomCreate", Value::Bool(true))]));
    log_info(&format!("sfu delete room={lk_room} why={why} status={}", status_text(status)));
}

/// UpdateParticipant: the screen added (presenter) or taken away (best effort).
fn permission(cfg: &Cfg, lk_room: &str, who: &str, screen: bool) {
    let sources = if screen { &PRESENTER_SOURCES[..] } else { &PRESENTER_SOURCES[..2] };
    let body = obj([
        ("room", Value::from(lk_room)),
        ("identity", Value::from(who)),
        ("permission", Value::Object(obj([("canSubscribe", Value::Bool(true)), ("canPublish", Value::Bool(true)), ("canPublishData", Value::Bool(false)), ("canPublishSources", Value::from(sources.to_vec()))]))),
    ]);
    let (status, _) = call(cfg, "UpdateParticipant", &body, admin_video(lk_room));
    let status = status.map(|s| s.to_string()).unwrap_or_else(|| "None".into());
    log_info(&format!("sfu permission room={lk_room} identity={who} screen={} status={status}", if screen { "on" } else { "off" }));
}

/// The parts of `ws[s]://host[:port][/]`: (scheme, host, port), None when it is anything else.
fn parse_url(url: &str) -> Option<(String, String, Option<u16>)> {
    let (scheme, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (netloc, tail) = rest.split_at(end);
    if !(tail.is_empty() || tail == "/") || netloc.contains('@') {
        return None;
    }
    let (host, port) = if let Some(v6) = netloc.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h.to_string(), after.strip_prefix(':'))
    } else {
        match netloc.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (netloc.to_string(), None),
        }
    };
    let port = match port {
        None | Some("") => None,
        Some(p) => Some(p.parse::<u16>().ok()?),
    };
    (!host.is_empty()).then(|| (scheme.to_lowercase(), host.to_lowercase(), port))
}

impl State {
    /// _sfu_configure: the `sfu_*` settings, read and checked once at start.
    pub(super) fn sfu_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        let url = s.sfu_url.trim();
        if url.is_empty() {
            self.sfu.cfg = None;
            return Ok(());
        }
        // host and port only: Hubs refuse an address with a user, path, query or fragment
        let Some((scheme, host, port)) = parse_url(url).filter(|(scheme, ..)| scheme == "wss" || scheme == "ws") else {
            return Err("relay settings: sfu_url must be the media server's wss:// address".into());
        };
        if scheme == "ws" && !LOCAL_HOSTS.contains(&host.as_str()) {
            return Err("relay settings: sfu_url must use wss:// (ws:// only for a media server on this machine)".into());
        }
        let key = s.sfu_api_key.trim();
        if key.is_empty() || !pj::printable(key) || key.contains(' ') {
            return Err("relay settings: sfu_api_key must name the media server's API key".into());
        }
        let secret = std::fs::read_to_string(&s.sfu_secret_file).map_err(|_| "relay settings: sfu_secret_file must be a readable file holding the media server's API secret".to_string())?;
        let secret = secret.trim();
        if secret.is_empty() {
            return Err("relay settings: sfu_secret_file is empty".into());
        }
        let most = pj::as_int(Some(&s.sfu_max)).filter(|n| (2..=MAX_LIMIT).contains(n)).ok_or_else(|| format!("relay settings: sfu_max must be a whole number from 2 to {MAX_LIMIT}"))?;
        let threshold = pj::as_int(Some(&s.sfu_threshold)).filter(|n| (2..=most).contains(n)).ok_or_else(|| "relay settings: sfu_threshold must be a whole number from 2 to sfu_max".to_string())?;
        let tls = scheme == "wss";
        let cfg = Cfg {
            url: url.trim_end_matches('/').to_string(),
            host,
            port: port.unwrap_or(if tls { 443 } else { 80 }),
            tls,
            key: key.to_string(),
            secret: secret.as_bytes().to_vec(),
            threshold: threshold as usize,
            max: most as usize,
        };
        log_info(&format!("sfu configured url={} threshold={threshold} max={most}", cfg.url));
        self.sfu.cfg = Some(Arc::new(cfg));
        Ok(())
    }

    /// _sfu_why: why the stay starting now uses the media server ("" = it does not).
    fn sfu_why(&self, room: &str, large: bool) -> &'static str {
        let Some(cfg) = &self.sfu.cfg else { return "" };
        if large {
            return "large";
        }
        let need = cfg.threshold;
        if let Some(meeting) = as_obj(self.meetings.get(room)).filter(|m| !pj::truthy(m.get("canceled"))) {
            let mut people: HashSet<String> = HashSet::new();
            people.insert(as_obj(meeting.get("organizer")).map(|o| pj::text_of(o, "principal")).unwrap_or_default());
            for a in meeting.get("attendees").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
                if pj::text_of(a, "response") != "decline" {
                    people.insert(pj::py_str(a.get("principal").unwrap_or(&Value::Null)));
                }
            }
            if people.len() >= need {
                return "meeting";
            }
        }
        if room.starts_with("cv-") {
            for (cid, ch) in self.channels.iter() {
                let Some(ch) = ch.as_object() else { continue };
                if pj::truthy(ch.get("archived")) {
                    continue;
                }
                let rest = cid.strip_prefix("c-").unwrap_or(cid);
                let call: String = format!("cv-{rest}").chars().take(40).collect();
                if call == room && channels::members_of(Some(ch)).len() >= need {
                    return "conversation";
                }
            }
        }
        ""
    }

    /// _sfu_may_join (before anything changes): a large call is end-to-end encrypted, so a seat joins one only with
    /// `e2ee: true` (409 otherwise) and never as a web guest (403). The stay's mode decides, or the one this join
    /// would start (a seat taken over keeps the stay).
    pub(super) fn sfu_may_join(&self, room: &str, who: &Identity, ext: &Obj) -> R<()> {
        let large = m::flag(ext.get("large"), "large")?;
        let e2ee = m::flag(ext.get("e2ee"), "e2ee")?;
        let sfu = if self.stays.contains_key(room) { self.sfu.media.get(room) == Some(&"sfu") } else { !self.sfu_why(room, large).is_empty() };
        if sfu && who.guest {
            return forbidden(E2EE_GUESTS);
        }
        if sfu && !e2ee {
            return Err(E::Conflict(E2EE_REQUIRED.into()));
        }
        Ok(())
    }

    /// _sfu_stay_created: the media mode of the stay this join starts.
    pub(super) fn sfu_stay_created(&mut self, room: &str, who: &Identity, ext: &Obj) {
        let why = self.sfu_why(room, ext.get("large") == Some(&Value::Bool(true)));
        let media = if why.is_empty() { "mesh" } else { "sfu" };
        self.sfu.media.insert(room.to_string(), media);
        if media == "sfu" {
            let lk_room = format!("{room}.s{}", pj::token_hex(6));
            self.sfu.rooms.insert(room.to_string(), lk_room.clone());
            self.sfu.presenter.insert(room.to_string(), String::new());
            // check the media server soon after a large call starts (leftovers of a restart)
            self.sfu.next_sync = self.sfu.next_sync.min(pj::now() + SYNC_SOON);
            log_info(&format!("sfu room={room} principal={} media=sfu why={why} sfu_room={lk_room}", who.principal));
        }
    }

    /// _sfu_cap: a large call holds sfu_max people, a mesh PEER_MAX_PER_ROOM.
    pub(super) fn sfu_cap(&self, room: &str) -> usize {
        match &self.sfu.cfg {
            Some(cfg) if self.sfu.media.get(room) == Some(&"sfu") => cfg.max,
            _ => PEER_MAX_PER_ROOM,
        }
    }

    /// _sfu_join_extra: `media` (absent without a media server: the wave-2 answer) and, for sfu, the seat's token (a
    /// joiner waiting for recording consent gets it once admitted, through /v1/sfu/token).
    pub(super) fn sfu_join_extra(&mut self, room: &str, peer_id: &str) -> Obj {
        if self.sfu.cfg.is_none() {
            return Obj::new();
        }
        if self.sfu.media.get(room) != Some(&"sfu") {
            return obj([("media", Value::from("mesh"))]);
        }
        let pending = self.peers.get(peer_id).map(|p| p.admission_pending).unwrap_or(true);
        let grant = if pending { Value::Null } else { Value::Object(self.sfu_grant(peer_id)) };
        let stay = self.sfu.rooms.get(room).cloned().unwrap_or_default();
        // `stay`: the stay's LiveKit room, bound in what seats sign
        let e2ee = obj([("required", Value::Bool(true)), ("stay", Value::from(stay))]);
        obj([("media", Value::from("sfu")), ("sfu", grant), ("e2ee", Value::Object(e2ee))])
    }

    /// _sfu_member: a large call's member row (State::member): the seat's published ephemeral key and signature, null
    /// until it publishes.
    pub(super) fn sfu_member(&self, peer: &Peer, row: &mut Obj) {
        if self.sfu.media.get(&peer.room) == Some(&"sfu") {
            let or_null = |v: &str| if v.is_empty() { Value::Null } else { Value::from(v) };
            row.insert("epk".into(), or_null(&peer.epk));
            row.insert("sig".into(), or_null(&peer.epk_sig));
        }
    }

    /// _sfu_left: the seat's media server participant goes too, and the room hears a new key leader (a seat taken
    /// over by a join: that join tells the room).
    pub(super) fn sfu_left(&mut self, peer: &Peer, why: &str) {
        if let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(&peer.room).cloned()) {
            let (who, why) = (identity(peer), why.to_string());
            spawn("sfu-remove", move || remove_now(&cfg, &lk_room, &who, &why));
        }
        if why != "moved" && why != "rejoined" {
            self.sfu_leader_sync(&peer.room, None);
        }
    }

    /// _sfu_room_empty: the stay is over: anyone still connected to its LiveKit room goes with it.
    pub(super) fn sfu_room_empty(&mut self, room: &str) {
        self.sfu.media.remove(room);
        self.sfu.presenter.remove(room);
        self.sfu.leaders.remove(room);
        let lk_room = self.sfu.rooms.remove(room);
        if let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), lk_room) {
            spawn("sfu-delete", move || delete_room(&cfg, &lk_room, "empty"));
        }
    }

    /// _sfu_prune: a room whose stay ended some other way forgets its mode.
    pub(super) fn sfu_prune(&mut self) {
        let gone: Vec<String> = self.sfu.media.keys().filter(|r| !self.stays.contains_key(*r)).cloned().collect();
        for room in gone {
            self.sfu.media.remove(&room);
            self.sfu.rooms.remove(&room);
            self.sfu.presenter.remove(&room);
            self.sfu.leaders.remove(&room);
        }
    }

    /// _sfu_stage_view: runs for every stage view: a large call's view names its key leader (`e2ee_leader`); the media
    /// server hears only a presenter change (it then lets only that identity share a screen).
    pub(super) fn sfu_stage_view(&mut self, room: &str, view: &mut Obj) {
        let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(room).cloned()) else { return };
        view.insert("e2ee_leader".into(), self.sfu_leader(room).map(Value::from).unwrap_or(Value::Null));
        let peer = view.get("presenter").and_then(|p| p.get("peer")).map(pj::py_str).unwrap_or_default();
        let now_id = self.peers.get(&peer).filter(|p| p.room == room).map(identity).unwrap_or_default();
        let before = self.sfu.presenter.get(room).cloned().unwrap_or_default();
        if now_id == before {
            return;
        }
        self.sfu.presenter.insert(room.to_string(), now_id.clone());
        spawn("sfu-stage", move || {
            if !before.is_empty() {
                permission(&cfg, &lk_room, &before, false);
            }
            if !now_id.is_empty() {
                permission(&cfg, &lk_room, &now_id, true);
            }
        });
    }

    /// _sfu_tick: a check against seats is due (at most every SYNC_EVERY): its media server, and it is now running.
    pub(super) fn sfu_tick(&mut self, now: f64) -> Option<Arc<Cfg>> {
        let cfg = self.sfu.cfg.clone()?;
        if self.sfu.syncing || now < self.sfu.next_sync {
            return None;
        }
        self.sfu.next_sync = now + SYNC_EVERY;
        self.sfu.syncing = true;
        Some(cfg)
    }

    fn sfu_seats(&self, room: &str) -> HashSet<String> {
        self.peers.values().filter(|p| p.room == room && !p.admission_pending).map(identity).collect()
    }

    // ── end-to-end encryption: keys pass through, opaque, never kept ──

    /// _sfu_encrypted: `room`'s current stay is a large call (end-to-end encrypted, no guests).
    pub(super) fn sfu_encrypted(&self, room: &str) -> bool {
        self.stays.contains_key(room) && self.sfu.media.get(room) == Some(&"sfu")
    }

    /// _sfu_leader: the key leader of a large call: the host when it is a certificate seat, else the earliest joined
    /// certificate seat (None: no certificate seat is in the call).
    fn sfu_leader(&self, room: &str) -> Option<String> {
        if self.sfu.media.get(room) != Some(&"sfu") {
            return None;
        }
        let host = self.stage_host(room);
        let mut first: Option<&Peer> = None;
        for p in self.peers.values().filter(|p| p.room == room && !p.cert.is_empty() && !p.who.guest && !p.admission_pending) {
            if host.as_deref() == Some(p.peer_id.as_str()) {
                return Some(p.peer_id.clone());
            }
            if first.map(|b| p.joined < b.joined).unwrap_or(true) {
                first = Some(p);
            }
        }
        first.map(|p| p.peer_id.clone())
    }

    /// _sfu_leader_told: a stage event went to the room (State::stage_event): it named this leader.
    pub(super) fn sfu_leader_told(&mut self, room: &str, leader: &Value) {
        self.sfu.leaders.insert(room.to_string(), leader.as_str().map(str::to_string));
    }

    /// _sfu_leader_sync: a large call's key leader changed without a stage event saying so (a join, a departure): one
    /// now, `why: "e2ee_leader"`.
    pub(super) fn sfu_leader_sync(&mut self, room: &str, skip: Option<&str>) {
        let seats = self.peers.values().filter(|p| p.room == room).count();
        if seats > 0 && self.sfu_encrypted(room) && self.sfu_leader(room) != self.sfu.leaders.get(room).cloned().flatten() {
            self.stage_event(room, "e2ee_leader", "", skip);
            log_info(&format!("e2ee leader room={room} seats={seats}"));
        }
    }

    /// _sfu_e2ee_seat: the caller's own seat in a large call, ready for keys.
    fn sfu_e2ee_seat(&self, peer_id: &str, who: &Identity) -> R<()> {
        self.owned(peer_id, who)?;
        if self.sfu.cfg.is_none() {
            return Err(E::Unavailable(NO_SFU.into()));
        }
        let peer = &self.peers[peer_id];
        if !self.sfu_encrypted(&peer.room) {
            return Err(E::Conflict(NOT_USED.into()));
        }
        if peer.who.guest {
            return forbidden(E2EE_GUESTS);
        }
        if !peer.e2ee {
            return Err(E::Conflict(E2EE_REQUIRED.into()));
        }
        if peer.admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        Ok(())
    }

    /// _sfu_grant: `{url, token, expires}` for this seat.
    fn sfu_grant(&self, peer_id: &str) -> Obj {
        let cfg = self.sfu.cfg.as_ref().expect("a media server");
        let peer = &self.peers[peer_id];
        let now = pj::now() as i64;
        let expires = now + TOKEN_TTL;
        let who = identity(peer);
        // the named presenter keeps the screen across a reconnect with a fresh token
        let mut sources: Vec<Value> = SOURCES.iter().map(|s| Value::from(*s)).collect();
        if self.sfu.presenter.get(&peer.room) == Some(&who) {
            sources.extend(["screen_share", "screen_share_audio"].map(Value::from));
        }
        let video = obj([
            ("room", Value::from(self.sfu.rooms.get(&peer.room).cloned().unwrap_or_default())),
            ("roomJoin", Value::Bool(true)),
            ("canPublish", Value::Bool(true)),
            ("canSubscribe", Value::Bool(true)),
            ("canPublishData", Value::Bool(false)),
            ("canPublishSources", Value::Array(sources)),
        ]);
        let claims = obj([
            ("iss", Value::from(cfg.key.clone())),
            ("sub", Value::from(who)),
            ("name", Value::from(peer.who.name.clone())),
            ("nbf", Value::from(now - 10)),
            ("exp", Value::from(expires)),
            ("jti", Value::from(pj::token_hex(8))),
            ("video", Value::Object(video)),
        ]);
        obj([("url", Value::from(cfg.url.clone())), ("token", Value::from(jwt(&claims, &cfg.secret))), ("expires", Value::from(expires))])
    }
}

impl Hub {
    /// _sfu_sync (its own thread): delete LiveKit rooms of stays this relay does not know (it restarted, or a delete was
    /// missed) and remove participants that are not a current seat of their stay.
    pub(super) fn sfu_sync(&self, cfg: Arc<Cfg>) {
        let (mut removed, mut deleted) = (0, 0);
        let (_, answer) = call(&cfg, "ListRooms", &Obj::new(), obj([("roomList", Value::Bool(true))]));
        let names: Vec<String> = answer.as_ref().and_then(|a| a.get("rooms")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).map(|r| pj::s(r, "name")).collect();
        let active: Vec<(String, String)> = self.st.lock().sfu.rooms.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for name in names {
            if !stay_room(&name) || active.iter().any(|(_, lk)| *lk == name) {
                continue;
            }
            if self.st.lock().sfu.rooms.values().any(|lk| *lk == name) {
                continue;
            }
            delete_room(&cfg, &name, "unknown");
            deleted += 1;
        }
        for (room, lk_room) in &active {
            let (status, answer) = call(&cfg, "ListParticipants", &obj([("room", Value::from(lk_room.clone()))]), admin_video(lk_room));
            if status != Some(200) {
                continue;
            }
            let there: HashSet<String> = answer.as_ref().and_then(|a| a.get("participants")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).map(|p| pj::s(p, "identity")).collect();
            let extra: Vec<String> = {
                let st = self.st.lock();
                if st.sfu.rooms.get(room) != Some(lk_room) {
                    continue; // the stay ended meanwhile (its room was deleted)
                }
                let seats = st.sfu_seats(room);
                let mut extra: Vec<String> = there.into_iter().filter(|i| !i.is_empty() && !seats.contains(i)).collect();
                extra.sort();
                extra
            };
            for who in extra {
                remove_now(&cfg, lk_room, &who, "not_a_seat");
                removed += 1;
            }
        }
        log_info(&format!("sfu sync rooms={} removed={removed} deleted={deleted}", active.len()));
        self.st.lock().sfu.syncing = false;
    }

    /// `POST /v1/sfu/token {peer}`: a fresh media server token for the caller's own seat in a call that uses it (only
    /// a seat that joined it with `e2ee: true`: there is no unencrypted large call).
    pub fn sfu_token(&self, peer_id: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.owned(peer_id, who)?;
        if st.sfu.cfg.is_none() {
            return Err(E::Unavailable(NO_SFU.into()));
        }
        let peer = &st.peers[peer_id];
        if st.sfu.media.get(&peer.room) != Some(&"sfu") {
            return Err(E::Conflict(NOT_USED.into()));
        }
        if peer.who.guest {
            return forbidden(E2EE_GUESTS);
        }
        if !peer.e2ee {
            return Err(E::Conflict(E2EE_REQUIRED.into()));
        }
        if peer.admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        Ok(st.sfu_grant(peer_id))
    }

    /// `POST /v1/e2ee {peer, epk, sig}` -> `{ok}`: the seat's ephemeral public key for this stay (base64 of an
    /// uncompressed P-384 point) and its device certificate's signature over it (base64 DER ECDSA), replacing any
    /// earlier one. Everyone else in the room hears `e2ee_epk {peer, principal, epk, sig}`; later joiners find both in
    /// the member rows. The relay checks only their size: the members verify them.
    pub fn e2ee_publish(&self, peer_id: &str, who: &Identity, epk: Body, sig: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(String, bool)> {
            st.sfu_e2ee_seat(peer_id, who)?;
            let point = e2ee_b64(epk, E2EE_EPK_BYTES, E2EE_EPK_BYTES, E2EE_BAD_EPK)?;
            if point[0] != 4 {
                return bad(E2EE_BAD_EPK);
            }
            e2ee_b64(sig, 8, E2EE_SIG_MAX, &format!("sig must be a signature (base64 of at most {E2EE_SIG_MAX} bytes)"))?;
            let epk = epk.and_then(Value::as_str).unwrap_or_default().to_string();
            let sig = sig.and_then(Value::as_str).unwrap_or_default().to_string();
            let peer = st.peers.get_mut(peer_id).expect("an owned seat");
            let again = !peer.epk.is_empty();
            peer.epk.clone_from(&epk);
            peer.epk_sig.clone_from(&sig);
            let (room, principal) = (peer.room.clone(), peer.who.principal.clone());
            let event = obj([("type", Value::from("e2ee_epk")), ("peer", Value::from(peer_id)), ("principal", Value::from(principal)), ("epk", Value::from(epk)), ("sig", Value::from(sig))]);
            st.broadcast(&room, &event, Some(peer_id));
            Ok((room, again))
        })();
        drop(st);
        self.wake();
        let (room, again) = r?;
        log_info(&format!("e2ee epk room={room} principal={} peer={peer_id} again={}", who.principal, if again { "yes" } else { "no" }));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `POST /v1/e2ee/keys {peer, index, to: [{peer, blob}]}` -> `{ok, delivered}`: the key leader's wrapped group key
    /// for each recipient, delivered to that seat only as `e2ee_key {from, index, blob}`. A recipient that is not (or
    /// not yet) a member of the call is skipped (`delivered` counts the rest). Anyone but the current key leader: 403
    /// (before the body is looked at).
    pub fn e2ee_keys(&self, peer_id: &str, who: &Identity, index: Body, to: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(String, i64, usize, usize)> {
            st.sfu_e2ee_seat(peer_id, who)?;
            let room = st.peers[peer_id].room.clone();
            if st.sfu_leader(&room).as_deref() != Some(peer_id) {
                return forbidden(E2EE_NOT_LEADER);
            }
            let Some(index) = pj::as_int(index).filter(|i| (0..E2EE_INDEXES).contains(i)) else {
                return bad(format!("index must be a whole number from 0 to {}", E2EE_INDEXES - 1));
            };
            let Some(to) = to.and_then(Value::as_array).filter(|t| (1..=E2EE_TO_MAX).contains(&t.len())) else {
                return bad(format!("to must list 1 to {E2EE_TO_MAX} recipients ({{peer, blob}})"));
            };
            let bad_blob = format!("each blob must be base64 of at most {E2EE_BLOB_MAX} characters");
            let mut wraps: Vec<(&str, &str)> = Vec::with_capacity(to.len());
            for item in to {
                let target = item.as_object().and_then(|i| i.get("peer")).and_then(Value::as_str).filter(|t| (1..=64).contains(&pj::char_len(t)));
                let Some(target) = target else { return bad("each recipient needs its peer and a blob") };
                let blob = item.get("blob");
                // E2EE_BLOB_MAX characters of base64 carry 3/4 as many bytes
                e2ee_b64(blob, 1, E2EE_BLOB_MAX * 3 / 4, &bad_blob)?;
                wraps.push((target, blob.and_then(Value::as_str).unwrap_or_default()));
            }
            let mut delivered = 0;
            for (target, blob) in &wraps {
                if !st.peers.get(*target).is_some_and(|seat| seat.room == room && !seat.admission_pending) {
                    continue;
                }
                st.push_peer(target, &obj([("type", Value::from("e2ee_key")), ("from", Value::from(peer_id)), ("index", Value::from(index)), ("blob", Value::from(*blob))]));
                delivered += 1;
            }
            Ok((room, index, wraps.len(), delivered))
        })();
        drop(st);
        self.wake();
        let (room, index, sent, delivered) = r?;
        log_info(&format!("e2ee keys room={room} principal={} index={index} to={sent} delivered={delivered}", who.principal));
        Ok(obj([("ok", Value::Bool(true)), ("delivered", Value::from(delivered))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_server_addresses_and_rooms() {
        assert_eq!(parse_url("wss://sfu.test"), Some(("wss".into(), "sfu.test".into(), None)));
        assert_eq!(parse_url("ws://127.0.0.1:7880/"), Some(("ws".into(), "127.0.0.1".into(), Some(7880))));
        assert_eq!(parse_url("ws://[::1]:7880"), Some(("ws".into(), "::1".into(), Some(7880))));
        assert!(parse_url("wss://sfu.test/lk").is_none() && parse_url("wss://u@sfu.test").is_none() && parse_url("https:/x").is_none());
        assert!(stay_room("big.s0123456789ab") && !stay_room(".s0123456789ab") && !stay_room("not-ours") && !stay_room("big.s0123456789AB"));
    }

    #[test]
    fn tokens_are_hs256_with_the_secret() {
        let token = jwt(&obj([("sub", Value::from("a|b"))]), b"secret");
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
        let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret");
        let want = aws_lc_rs::hmac::sign(&key, format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(parts[2], crate::codec::b64u(want.as_ref()));
    }

    #[test]
    fn e2ee_base64_is_strict_and_sized() {
        let ok = |v: Value, least, most| e2ee_b64(Some(&v), least, most, "no").ok();
        assert_eq!(ok(Value::from("AAAA"), 1, 3), Some(vec![0, 0, 0]));
        assert_eq!(ok(Value::from("AA=="), 1, 3), Some(vec![0]));
        for bad in [Value::Null, Value::from(""), Value::from("AA"), Value::from("AA=A"), Value::from("A==="), Value::from("%%%%"), Value::from(1)] {
            assert_eq!(ok(bad.clone(), 1, 3), None, "{bad}");
        }
        assert_eq!(ok(Value::from("AAAAAA=="), 1, 3), None); // 4 bytes
        assert_eq!(ok(Value::from("AAAA"), 4, 6), None); // 3 bytes
        assert_eq!(ok(Value::from("A".repeat(512)), 1, 384).map(|b| b.len()), Some(384));
        assert_eq!(ok(Value::from("A".repeat(516)), 1, 384), None);
    }

    fn seat(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), cert_pem: format!("-----BEGIN CERTIFICATE-----\n{p}\n-----END CERTIFICATE-----\n"), ..Default::default() }
    }

    fn body(v: Value) -> Obj {
        v.as_object().cloned().unwrap()
    }

    fn refusal<T>(r: R<T>) -> String {
        match r {
            Err(e @ (E::Forbidden(_) | E::Conflict(_) | E::Bad(_) | E::Unavailable(_))) => e.message(),
            Err(e) => format!("other {}", e.message()),
            Ok(_) => "ok".into(),
        }
    }

    fn events_of(h: &Hub, peer: &str, kind: &str) -> Vec<Obj> {
        h.st.lock().peers[peer].events.iter().filter(|e| pj::text_of(e, "type") == kind).cloned().collect()
    }

    #[test]
    fn large_calls_carry_certs_keys_and_a_key_leader() {
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        // a media server nobody listens on: leaving seats are removed from it on their own threads
        h.st.lock().sfu.cfg = Some(Arc::new(Cfg { url: "ws://127.0.0.1:9".into(), host: "127.0.0.1".into(), port: 9, tls: false, key: "k".into(), secret: b"s".to_vec(), threshold: 9, max: 100 }));
        let (ann, ben, cy) = (seat("ann@x", "aaaaaaaaaaaaaaaa"), seat("ben@x", "bbbbbbbbbbbbbbbb"), seat("cy@x", "cccccccccccccccc"));
        let large = body(serde_json::json!({"large": true}));
        let e2ee = body(serde_json::json!({"large": true, "e2ee": true}));
        assert_eq!(refusal(h.join("big", &ann, "", false, Some(&large))), E2EE_REQUIRED);
        let guest = Identity { guest: true, ..seat("guest-0123456789abcdef@guest.invalid", "") };
        assert_eq!(refusal(h.join("big", &guest, "", false, Some(&e2ee))), E2EE_GUESTS);
        let a = h.join("big", &ann, "", false, Some(&e2ee)).unwrap();
        let ap = a["peer"].as_str().unwrap().to_string();
        let stay = h.st.lock().sfu.rooms.get("big").cloned().unwrap();
        assert_eq!(a["e2ee"], serde_json::json!({"required": true, "stay": stay}));
        assert_eq!(a["you"]["cert"], Value::from(ann.cert_pem.clone()));
        assert_eq!((&a["you"]["epk"], &a["you"]["sig"]), (&Value::Null, &Value::Null));
        assert_eq!(a["stage"]["e2ee_leader"], Value::from(ap.clone()));
        let later = body(serde_json::json!({"e2ee": true}));
        let bp = h.join("big", &ben, "", false, Some(&later)).unwrap()["peer"].as_str().unwrap().to_string();
        let cp = h.join("big", &cy, "", false, Some(&later)).unwrap()["peer"].as_str().unwrap().to_string();
        let joins = events_of(&h, &ap, "join");
        assert_eq!(joins[0]["cert"], Value::from(ben.cert_pem.clone()));

        // an ephemeral key goes to everyone else and into later member rows
        let mut raw = [0u8; E2EE_EPK_BYTES];
        raw[0] = 2; // a compressed point's prefix
        let compressed = pj::b64(&raw);
        raw[0] = 4;
        let point = pj::b64(&raw);
        let sig = pj::b64(&[0x30; 70]);
        assert_eq!(refusal(h.e2ee_publish(&ap, &ann, Some(&Value::from(compressed)), Some(&Value::from(sig.clone())))), E2EE_BAD_EPK);
        h.e2ee_publish(&ap, &ann, Some(&Value::from(point.clone())), Some(&Value::from(sig.clone()))).unwrap();
        assert!(events_of(&h, &ap, "e2ee_epk").is_empty());
        let heard = &events_of(&h, &bp, "e2ee_epk")[0];
        assert_eq!((heard["peer"].as_str(), heard["principal"].as_str(), heard["epk"].as_str()), (Some(ap.as_str()), Some("ann@x"), Some(point.as_str())));
        let row = h.st.lock().members("big").into_iter().find(|m| m["peer"].as_str() == Some(ap.as_str())).unwrap();
        assert_eq!((row["epk"].as_str(), row["sig"].as_str()), (Some(point.as_str()), Some(sig.as_str())));

        // only the leader sends keys (refused before the body is read), each blob only to its recipient
        assert_eq!(refusal(h.e2ee_keys(&bp, &ben, Some(&Value::from(99)), None)), E2EE_NOT_LEADER);
        let to = serde_json::json!([{"peer": bp, "blob": "AAAA"}, {"peer": "gone", "blob": "AAAA"}]);
        assert_eq!(h.e2ee_keys(&ap, &ann, Some(&Value::from(0)), Some(&to)).unwrap()["delivered"], Value::from(1));
        assert_eq!(events_of(&h, &bp, "e2ee_key")[0]["from"], Value::from(ap.clone()));
        assert!(events_of(&h, &cp, "e2ee_key").is_empty());
        assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&Value::from(16)), Some(&to))), "index must be a whole number from 0 to 15");
        assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&Value::from(1)), Some(&serde_json::json!([])))), "to must list 1 to 200 recipients ({peer, blob})");
        assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&Value::from(1)), Some(&serde_json::json!([{"blob": "AAAA"}])))), "each recipient needs its peer and a blob");

        // the host leaves: the longest-present seat hosts and leads the keys, and the room hears it at once
        h.leave(&ap, &ann).unwrap();
        let stage = events_of(&h, &cp, "stage").into_iter().find(|e| pj::text_of(e, "why") == "leave").unwrap();
        assert_eq!(stage["stage"]["e2ee_leader"], Value::from(bp.clone()));
        assert_eq!(refusal(h.e2ee_keys(&cp, &cy, Some(&Value::from(1)), Some(&to))), E2EE_NOT_LEADER);
        assert_eq!(h.e2ee_keys(&bp, &ben, Some(&Value::from(1)), Some(&serde_json::json!([{"peer": cp, "blob": "AAAA"}]))).unwrap()["delivered"], Value::from(1));

        // nothing of it in state.json
        let snapshot = h.st.lock().snapshot();
        assert!(!snapshot.contains("e2ee") && !snapshot.contains("BEGIN CERTIFICATE") && !snapshot.contains(&point));
    }
}
