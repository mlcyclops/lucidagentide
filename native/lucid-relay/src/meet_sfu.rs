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
const CALL_TIMEOUT: f64 = 5.0;

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
        obj([("media", Value::from("sfu")), ("sfu", grant)])
    }

    /// _sfu_left: the seat's media server participant goes too.
    pub(super) fn sfu_left(&mut self, peer: &Peer, why: &str) {
        let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(&peer.room).cloned()) else { return };
        let (who, why) = (identity(peer), why.to_string());
        spawn("sfu-remove", move || remove_now(&cfg, &lk_room, &who, &why));
    }

    /// _sfu_room_empty: the stay is over: anyone still connected to its LiveKit room goes with it.
    pub(super) fn sfu_room_empty(&mut self, room: &str) {
        self.sfu.media.remove(room);
        self.sfu.presenter.remove(room);
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
        }
    }

    /// _sfu_stage_view: runs for every stage view; acts only when the presenter changed (the media server then lets
    /// only that identity share a screen).
    pub(super) fn sfu_stage_view(&mut self, room: &str, view: &Obj) {
        let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(room).cloned()) else { return };
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

    /// `POST /v1/sfu/token {peer}`: a fresh media server token for the caller's own seat in a call that uses it.
    pub fn sfu_token(&self, peer_id: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.owned(peer_id, who)?;
        if st.sfu.cfg.is_none() {
            return Err(E::Unavailable("this relay has no media server (sfu_url)".into()));
        }
        if st.sfu.media.get(&st.peers[peer_id].room) != Some(&"sfu") {
            return Err(E::Conflict(NOT_USED.into()));
        }
        if st.peers[peer_id].admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        Ok(st.sfu_grant(peer_id))
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
}
