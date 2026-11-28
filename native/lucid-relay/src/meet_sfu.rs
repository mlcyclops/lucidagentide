// Phase C (ADR-0540), wave 3: large calls (meet_relay._Wave3LargeCalls). A LiveKit SFU carries the media of a call a
// mesh cannot hold. The media mode is chosen once per stay, at its first join: `sfu` when the relay has a media server
// and the first joiner asked for a large call (join `large: true`), or the room is a scheduled meeting of
// `sfu_threshold` or more people, or the call of a group chat or channel with that many members; else `mesh` (at most
// PEER_MAX_PER_ROOM). The join answer says `media` and, for sfu, `sfu: {url, token, expires}`: a LiveKit access token
// (JWT HS256 with the media server's API secret) for the stay's identity format (WA-1 4.3 revision 4: `"peer"`, the
// identity `<peer>`, when every certificate holder seated at the stay's first token joined with the cap
// `peer_identity`, else `"legacy"`, `<principal>|<peer>`, which 0.96.3 apps verify; fixed until the stay ends; the
// captioner service only listens) in a LiveKit room of its own per
// stay (`<room>.s<12 hex>`), valid TOKEN_TTL, publishing microphone and camera only (the presenter the relay names
// also gets the screen). A peer leaving the relay room is removed from the media server too, the stay's LiveKit room
// is deleted when the stay ends, and every SYNC_EVERY the relay removes any participant that is not a current seat
// and deletes rooms of stays it does not know, so a token never outlives the seat it was given for. Every call to the
// media server runs on its own thread (it may be slow or down, and callers hold the lock). A child module of
// meet_hub: it shares the one lock.
//
// A phone stay (PH-1, meet_phone: a personal phone call or a meeting that allows phone callers) runs here too, without
// end-to-end encryption; its own rules replace the ones below.
//
// Every sfu stay is end-to-end encrypted (contract E2EE-1); the media server and this relay are untrusted for keys. A
// seat joins one only with `e2ee: true` (409 otherwise) and never as a web guest (403). The join answer adds
// `e2ee: {required: true, stay}` (`stay`: the stay's LiveKit room, bound in what seats sign) and the rows carry each
// seat's `cert`, `epk` and `sig`. `POST /v1/e2ee` publishes a seat's ephemeral key to the room (`e2ee_epk`);
// `POST /v1/e2ee/keys` delivers a seat's own wrapped sender key, each only to its recipient (`e2ee_key`, contract
// E2EE-2: every member is the only source of its own key, there is no key leader); `POST /v1/e2ee/roster` fans a
// member's signed list of the members it verified out to the others (`e2ee_roster`). Caption lines of a large call
// must be ciphertext (409 otherwise). Nothing of it is kept or logged beyond counts.

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
/// WA-1 4.3 revision 4: a seat without the cap `peer_identity` asking for media in a `"peer"` stay.
const NEEDS_NEW_APP: &str = "this call needs the newest Lucid app; update Lucid to join it";
/// An uncompressed P-384 point: 0x04 || X (48) || Y (48).
const E2EE_EPK_BYTES: usize = 97;
const E2EE_BAD_EPK: &str = "epk must be a P-384 public key (base64 of 97 bytes)";
/// Bytes of a DER ECDSA signature (P-384: at most 104).
const E2EE_SIG_MAX: usize = 256;
/// Characters of one wrapped key (base64; 80 in practice).
const E2EE_BLOB_MAX: usize = 512;
/// Recipients of one key delivery.
const E2EE_TO_MAX: usize = 200;
/// Epochs and attestation counters: JSON integers a browser holds exactly (2^53 - 1).
const E2EE_COUNT_MAX: i64 = (1 << 53) - 1;
/// The body of `/v1/e2ee/keys`: a key delivery to E2EE_TO_MAX recipients with the largest blobs fits.
pub const E2EE_BODY_MAX: usize = 192 * 1024;
/// One roster entry: {principal, peer, epk_sha256}, exactly these, with these most characters.
const E2EE_ROSTER_FIELDS: [(&str, usize); 3] = [("principal", 320), ("peer", 64), ("epk_sha256", 128)];
/// The body of `/v1/e2ee/roster`: a roster of MAX_LIMIT entries of the largest fields fits.
pub const E2EE_ROSTER_BODY_MAX: usize = 640 * 1024;
/// A caption line of a large call is the sender's ciphertext, `lme2:<epoch>:<seq>:<base64>`; anything else is refused.
const E2EE_CAPTION_PLAIN: &str = "captions in an end-to-end encrypted call must be encrypted";

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

impl Cfg {
    /// PH-1: the API key LiveKit names as a webhook's `iss`, and the secret it signs webhooks with.
    pub(super) fn api_key(&self) -> &str {
        &self.key
    }

    pub(super) fn secret(&self) -> &[u8] {
        &self.secret
    }
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
    /// room -> its stay's LiveKit identity format, "peer" | "legacy" (fixed at the stay's first token)
    format: HashMap<String, &'static str>,
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

/// The seat's LiveKit identity in its stay's format: `<peer>` (apps map peers to people from the member rows), or
/// `<principal>|<peer>` once the stay is fixed "legacy" (what 0.96.3 apps verify, WA-1 4.3 revision 4).
fn identity(peer: &Peer, legacy: bool) -> String {
    if legacy {
        format!("{}|{}", peer.who.principal, peer.peer_id)
    } else {
        peer.peer_id.clone()
    }
}

/// The seat verifies `<peer>` LiveKit identities: guest pages and web clients always, an app when its join listed
/// `peer_identity` (WA-1 4.3 revision 4).
fn peer_capable(who: &Identity, caps: Option<&[String]>) -> bool {
    who.guest || who.kind == "web" || caps.is_some_and(|c| c.iter().any(|x| x == "peer_identity"))
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
    twirp(cfg, &format!("livekit.RoomService/{method}"), body, obj([("video", Value::Object(video))]))
}

/// PH-1: one LiveKit SIP service call (Twirp, JSON: `CreateSIPParticipant` and the dispatch rules) with a
/// short-lived token holding the SIP grant (admin and call) and, for a call into a room, that room's admin grant.
pub(super) fn sip_call(cfg: &Cfg, method: &str, body: &Obj, room: Option<&str>) -> (Option<u16>, Option<Obj>) {
    let mut grants = obj([("sip", Value::Object(obj([("admin", Value::Bool(true)), ("call", Value::Bool(true))])))]);
    if let Some(room) = room {
        grants.insert("video".into(), Value::Object(admin_video(room)));
    }
    twirp(cfg, &format!("livekit.SIP/{method}"), body, grants)
}

/// One Twirp call (`<package>.<Service>/<Method>`) with the relay's admin token carrying `grants`.
fn twirp(cfg: &Cfg, service: &str, body: &Obj, grants: Obj) -> (Option<u16>, Option<Obj>) {
    let now = pj::now() as i64;
    let mut claims = obj([("iss", Value::from(cfg.key.clone())), ("sub", Value::from("lucid-meet-relay")), ("nbf", Value::from(now - 10)), ("exp", Value::from(now + ADMIN_TTL))]);
    claims.extend(grants);
    let token = jwt(&claims, &cfg.secret);
    let method = service.rsplit('/').next().unwrap_or(service);
    let path = format!("/twirp/{service}");
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
pub(super) fn e2ee_b64(value: Body, least: usize, most: usize, message: &str) -> R<Vec<u8>> {
    let Some(Value::String(text)) = value else { return bad(message) };
    if text.is_empty() || text.len() > 4 * most.div_ceil(3) {
        return bad(message);
    }
    match pj::b64_strict(text) {
        Some(raw) if (least..=most).contains(&raw.len()) => Ok(raw),
        _ => bad(message),
    }
}

/// _e2ee_count: an epoch or attestation counter: a JSON whole number from 0 to E2EE_COUNT_MAX.
fn e2ee_count(value: Body, what: &str) -> R<i64> {
    match pj::as_int(value) {
        Some(n) if (0..=E2EE_COUNT_MAX).contains(&n) => Ok(n),
        _ => bad(format!("{what} must be a whole number from 0 to {E2EE_COUNT_MAX}")),
    }
}

/// E2EE_CAPTION_RE (full match): `lme[23]:[0-9]+:[0-9]+:[A-Za-z0-9+/=]+` (lme3: a captioner's line for another seat,
/// WA-1 5.2).
fn sealed_caption(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("lme2:").or_else(|| text.strip_prefix("lme3:")) else { return false };
    let mut parts = rest.splitn(3, ':');
    let (Some(epoch), Some(seq), Some(data)) = (parts.next(), parts.next(), parts.next()) else { return false };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    digits(epoch) && digits(seq) && !data.is_empty() && data.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
}

/// A LiveKit room's `creation_time` in seconds (protojson writes an int64 as a string), 0 when it does not say.
fn created_at(room: &Obj) -> f64 {
    match room.get("creation_time").or_else(|| room.get("creationTime")) {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        v => pj::as_num(v).unwrap_or(0.0),
    }
}

fn status_text(status: Option<u16>) -> String {
    status.map(|s| s.to_string()).unwrap_or_else(|| "failed".into())
}

fn admin_video(lk_room: &str) -> Obj {
    obj([("room", Value::from(lk_room)), ("roomAdmin", Value::Bool(true))])
}

pub(super) fn remove_now(cfg: &Cfg, lk_room: &str, who: &str, why: &str) {
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
        // PH-1 section 7: a phone stay (a personal call, a meeting that allows phone callers) always runs here
        if self.phone_kind(room).is_some() {
            return "phone";
        }
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
        // PH-1 section 7: a phone stay is not end-to-end encrypted; its own rules decide (the `phone` cap, the owner)
        if let Some(decided) = self.phone_may_join(room, who, ext) {
            return decided;
        }
        let sfu = if self.stays.contains_key(room) { self.sfu.media.get(room) == Some(&"sfu") } else { !self.sfu_why(room, large).is_empty() };
        if sfu && who.guest {
            // WA-1 4.3: a guest with its key, an admission and rules allowing large calls
            let ok = self.guests.rec.get(&guests::guest_id(&who.principal)).is_some_and(|r| !r.key.is_empty() && !r.admission.is_null() && r.rules.as_ref().and_then(|x| x.get("large_calls")).and_then(Value::as_str) != Some("refuse"));
            // WA-1 4.3 revision 4: no guest in a stay whose identities 0.96.3 apps verify
            if !ok || self.sfu.format.get(room).copied().unwrap_or_else(|| self.sfu_decide(room)) == "legacy" {
                return forbidden(E2EE_GUESTS);
            }
        }
        if sfu && !e2ee {
            return Err(E::Conflict(E2EE_REQUIRED.into()));
        }
        // WA-1 4.3 revision 4: a seat without `peer_identity` cannot verify the media of a "peer" stay
        if sfu && self.sfu.format.get(room) == Some(&"peer") && !peer_capable(who, wa::caps(ext)?.0.as_deref()) {
            return Err(E::Conflict(NEEDS_NEW_APP.into()));
        }
        Ok(())
    }

    /// The format a stay's first SFU token fixes: "peer" when every certificate holder seated in it now has the cap
    /// `peer_identity`, else "legacy".
    fn sfu_decide(&self, room: &str) -> &'static str {
        if self.peers.values().filter(|p| p.room == room).all(|p| peer_capable(&p.who, p.caps.as_deref())) {
            "peer"
        } else {
            "legacy"
        }
    }

    /// The stay's identity format is fixed "legacy" (guests refused, WA-1 4.3 revision 4).
    pub(super) fn sfu_legacy(&self, room: &str) -> bool {
        self.sfu.format.get(room) == Some(&"legacy")
    }

    /// _sfu_grant with the stay's identity format: the stay's first grant fixes it; 403 for a guest in a "legacy"
    /// stay, 409 for a seat without `peer_identity` in a "peer" one; the answer says `identity`.
    fn sfu_media_grant(&mut self, peer_id: &str) -> R<Obj> {
        let room = self.peers[peer_id].room.clone();
        let format = match self.sfu.format.get(&room) {
            Some(f) => *f,
            None => {
                let f = self.sfu_decide(&room);
                self.sfu.format.insert(room.clone(), f);
                log_info(&format!("sfu room={room} identity={f}"));
                f
            }
        };
        let peer = &self.peers[peer_id];
        // PH-1 revision 3 (section 11.4): a phone stay is not end-to-end encrypted; its joins checked the `phone` cap
        let phone = self.phone_stay(&room);
        if format == "legacy" && peer.who.guest && !phone {
            return forbidden(E2EE_GUESTS);
        }
        if format == "peer" && !phone && !peer_capable(&peer.who, peer.caps.as_deref()) {
            return Err(E::Conflict(NEEDS_NEW_APP.into()));
        }
        let mut grant = self.sfu_grant(peer_id);
        grant.insert("identity".into(), Value::from(format));
        Ok(grant)
    }

    /// _sfu_stay_created: the media mode of the stay this join starts.
    pub(super) fn sfu_stay_created(&mut self, room: &str, who: &Identity, ext: &Obj) {
        // PH-1: a personal phone call (sfu_why: "phone") runs on the media server; revision 3: a meeting with a PIN
        // starts like any stay and is armed for dial-in below
        let why = self.sfu_why(room, ext.get("large") == Some(&Value::Bool(true)));
        let media = if why.is_empty() { "mesh" } else { "sfu" };
        self.sfu.media.insert(room.to_string(), media);
        if media == "sfu" {
            // PH-1: a personal phone call's stay is the LiveKit room its caller is already in
            let lk_room = self.phone_lk_room(room).unwrap_or_else(|| format!("{room}.s{}", pj::token_hex(6)));
            self.sfu.rooms.insert(room.to_string(), lk_room.clone());
            self.sfu.presenter.insert(room.to_string(), String::new());
            // check the media server soon after a large call starts (leftovers of a restart)
            self.sfu.next_sync = self.sfu.next_sync.min(pj::now() + SYNC_SOON);
            log_info(&format!("sfu room={room} principal={} media=sfu why={why} sfu_room={lk_room}", who.principal));
        }
        // PH-1 revision 3 (section 11.2): every new stay of a meeting with a PIN, mesh or media server, is armed
        self.phone_stay_created(room);
    }

    /// PH-1 revision 3 (section 11.3): a phone caller switched the stay: it runs on the media server in the dial-in
    /// room, with no presenter and no identity format (a phone stay needs none); the sync soon deletes the old
    /// end-to-end encrypted room nobody uses any more.
    pub(super) fn sfu_phone_switch(&mut self, room: &str, lk_room: &str) {
        self.sfu.media.insert(room.to_string(), "sfu");
        self.sfu.rooms.insert(room.to_string(), lk_room.to_string());
        self.sfu.presenter.insert(room.to_string(), String::new());
        self.sfu.format.remove(room);
        self.sfu.next_sync = self.sfu.next_sync.min(pj::now() + SYNC_SOON);
    }

    /// The LiveKit room of a large call's stay (its E2EE `stay`), None for a mesh call.
    pub(super) fn sfu_stay(&self, room: &str) -> Option<String> {
        self.sfu.rooms.get(room).cloned()
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
        let grant = if pending { Value::Null } else { self.sfu_media_grant(peer_id).map(Value::Object).unwrap_or(Value::Null) };
        // PH-1 section 7: a phone stay says so, never end-to-end encrypted
        if let Some(phone) = self.phone_join_extra(room) {
            return obj([("media", Value::from("sfu")), ("sfu", grant), ("e2ee", Value::Object(obj([("required", Value::Bool(false))]))), ("phone", Value::Object(phone))]);
        }
        let stay = self.sfu.rooms.get(room).cloned().unwrap_or_default();
        // `stay`: the stay's LiveKit room, bound in what seats sign
        let mut e2ee = obj([("required", Value::Bool(true)), ("stay", Value::from(stay))]);
        // the stay's identity format once its first token fixed it (a seat waiting for consent reads it from its
        // /v1/sfu/token answer)
        if let Some(format) = self.sfu.format.get(room) {
            e2ee.insert("identity".into(), Value::from(*format));
        }
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

    /// _sfu_left: the seat's media server participant goes too.
    pub(super) fn sfu_left(&mut self, peer: &Peer, why: &str) {
        let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(&peer.room).cloned()) else { return };
        let (who, why) = (identity(peer, self.sfu_legacy(&peer.room)), why.to_string());
        spawn("sfu-remove", move || remove_now(&cfg, &lk_room, &who, &why));
    }

    /// _sfu_room_empty: the stay is over: anyone still connected to its LiveKit room goes with it.
    pub(super) fn sfu_room_empty(&mut self, room: &str) {
        self.sfu.media.remove(room);
        self.sfu.presenter.remove(room);
        self.sfu.format.remove(room);
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
            self.sfu.format.remove(&room);
        }
    }

    /// _sfu_stage_view: runs for every stage view; acts only when the presenter changed (the media server then lets
    /// only that identity share a screen).
    pub(super) fn sfu_stage_view(&mut self, room: &str, view: &Obj) {
        let (Some(cfg), Some(lk_room)) = (self.sfu.cfg.clone(), self.sfu.rooms.get(room).cloned()) else { return };
        // PH-1 section 7: nobody shares a screen in a personal phone call
        if self.phone_personal(room) {
            return;
        }
        let peer = view.get("presenter").and_then(|p| p.get("peer")).map(pj::py_str).unwrap_or_default();
        let now_id = self.peers.get(&peer).filter(|p| p.room == room).map(|p| identity(p, self.sfu_legacy(room))).unwrap_or_default();
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
        self.peers.values().filter(|p| p.room == room && !p.admission_pending).map(|p| identity(p, self.sfu_legacy(room))).collect()
    }

    // ── end-to-end encryption: keys pass through, opaque, never kept ──

    /// _sfu_encrypted: `room`'s current stay is a large call (end-to-end encrypted, no guests).
    pub(super) fn sfu_encrypted(&self, room: &str) -> bool {
        // PH-1: a phone stay runs on the media server without end-to-end encryption
        self.stays.contains_key(room) && self.sfu.media.get(room) == Some(&"sfu") && !self.phone_stay(room)
    }

    /// PH-1: the media server's settings (the phone slice calls LiveKit and checks its webhooks with them).
    pub(super) fn sfu_cfg(&self) -> Option<Arc<Cfg>> {
        self.sfu.cfg.clone()
    }

    /// Unit tests of other slices: a media server nobody listens on (key `k`, secret `s`).
    #[cfg(test)]
    pub(super) fn sfu_test_server(&mut self) {
        self.sfu.cfg = Some(Arc::new(Cfg { url: "ws://127.0.0.1:9".into(), host: "127.0.0.1".into(), port: 9, tls: false, key: "k".into(), secret: b"s".to_vec(), threshold: 9, max: 100 }));
    }

    /// _sfu_caption_check: in a large call every caption line is the sender's ciphertext (contract E2EE-2 section 5):
    /// a line that is not refuses the whole request (409), so a client that would leak its transcript in plain text is
    /// stopped before anything is kept. Each text is matched trimmed; `texts` is read only in a large call.
    pub(super) fn sfu_caption_check<S: AsRef<str>>(&self, peer_id: &str, mut texts: impl Iterator<Item = S>) -> R<()> {
        if self.sfu_encrypted(&self.peers[peer_id].room) && !texts.all(|t| sealed_caption(t.as_ref().trim())) {
            return Err(E::Conflict(E2EE_CAPTION_PLAIN.into()));
        }
        Ok(())
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
        let who = identity(peer, self.sfu_legacy(&peer.room));
        // the named presenter keeps the screen across a reconnect with a fresh token
        let mut sources: Vec<Value> = SOURCES.iter().map(|s| Value::from(*s)).collect();
        // PH-1 section 7: a personal phone call carries the microphone only, never a screen
        let personal = self.phone_personal(&peer.room);
        if personal {
            sources.truncate(1);
        } else if self.sfu.presenter.get(&peer.room) == Some(&who) {
            sources.extend(["screen_share", "screen_share_audio"].map(Value::from));
        }
        let publish = peer.who.kind != "captioner"; // WA-1 5.3: the captioner only listens
        // PH-1 section 8: the keypad's tones (RFC 4733 through LiveKit publishDtmf) travel as data packets
        let data = self.phone_stay(&peer.room);
        let video = obj([
            ("room", Value::from(self.sfu.rooms.get(&peer.room).cloned().unwrap_or_default())),
            ("roomJoin", Value::Bool(true)),
            ("canPublish", Value::Bool(publish)),
            ("canSubscribe", Value::Bool(true)),
            ("canPublishData", Value::Bool(data)),
            ("canPublishSources", Value::Array(if publish { sources } else { Vec::new() })),
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
        let names: Vec<(String, f64)> = answer.as_ref().and_then(|a| a.get("rooms")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).map(|r| (pj::s(r, "name"), created_at(r))).collect();
        let active: Vec<(String, String)> = self.st.lock().sfu.rooms.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (name, created) in names {
            // PH-1 section 7: a `lucid-phone_*` room without a phone stay goes too (a relay restart drops calls in
            // progress), once old enough that its call's webhook cannot still be on its way
            let phone_room = name.starts_with(phone::LK_PREFIX);
            if !(stay_room(&name) || phone_room) || active.iter().any(|(_, lk)| *lk == name) {
                continue;
            }
            if self.st.lock().sfu.rooms.values().any(|lk| *lk == name) {
                continue;
            }
            if phone_room && !self.st.lock().phone_room_unheld(&name, created) {
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
            // identity -> a SIP participant (LiveKit `kind` SIP, as its name or its number 3)
            let there: HashMap<String, bool> = answer
                .as_ref()
                .and_then(|a| a.get("participants"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .map(|p| (pj::s(p, "identity"), p.get("kind") == Some(&Value::from("SIP")) || pj::as_int(p.get("kind")) == Some(3)))
                .collect();
            let extra: Vec<String> = {
                let st = self.st.lock();
                if st.sfu.rooms.get(room) != Some(lk_room) {
                    continue; // the stay ended meanwhile (its room was deleted)
                }
                let seats = st.sfu_seats(room);
                // PH-1 section 7: the phone participants of a live phone stay are not seats and stay
                let mut extra: Vec<String> = there.into_iter().filter(|(i, sip)| !i.is_empty() && !seats.contains(i) && !st.phone_keeps(room, i, *sip)).map(|(i, _)| i).collect();
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
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        if st.sfu.cfg.is_none() {
            return Err(E::Unavailable(NO_SFU.into()));
        }
        let peer = &st.peers[peer_id];
        if st.sfu.media.get(&peer.room) != Some(&"sfu") {
            return Err(E::Conflict(NOT_USED.into()));
        }
        // PH-1: a phone stay is the one media server call that is not end-to-end encrypted
        if !peer.e2ee && !st.phone_stay(&peer.room) {
            return Err(E::Conflict(E2EE_REQUIRED.into()));
        }
        // PH-1 revision 3 (section 11.4): a seat a phone caller switched (a guest keeps its seat and asks here) needs
        // the `phone` cap
        if st.phone_stay(&peer.room) && !peer.caps.as_ref().is_some_and(|c| c.iter().any(|x| x == "phone")) {
            return Err(E::Conflict(phone::NEEDS_UPDATE.into()));
        }
        if peer.admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        st.sfu_media_grant(peer_id)
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

    /// `POST /v1/e2ee/keys {peer, epoch, to: [{peer, blob}]}` -> `{ok, delivered}`: the seat's own sender key of that
    /// epoch, wrapped for each recipient, delivered to that seat only as `e2ee_key {from, epoch, blob}`. Any seat of
    /// the large call may send its own keys (there is no key leader). A recipient that is not (or not yet) an admitted
    /// seat of the call, or the sender itself, is skipped (`delivered` counts the rest). Receivers keep only newer
    /// epochs: the relay does not order them.
    pub fn e2ee_keys(&self, peer_id: &str, who: &Identity, epoch: Body, to: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(String, usize, usize)> {
            st.sfu_e2ee_seat(peer_id, who)?;
            let room = st.peers[peer_id].room.clone();
            let epoch = e2ee_count(epoch, "epoch")?;
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
                if *target == peer_id || !st.peers.get(*target).is_some_and(|seat| seat.room == room && !seat.admission_pending) {
                    continue;
                }
                st.push_peer(target, &obj([("type", Value::from("e2ee_key")), ("from", Value::from(peer_id)), ("epoch", Value::from(epoch)), ("blob", Value::from(*blob))]));
                delivered += 1;
            }
            Ok((room, wraps.len(), delivered))
        })();
        drop(st);
        self.wake();
        let (room, sent, delivered) = r?;
        log_info(&format!("e2ee keys room={room} principal={} to={sent} delivered={delivered}", who.principal));
        Ok(obj([("ok", Value::Bool(true)), ("delivered", Value::from(delivered))]))
    }

    /// `POST /v1/e2ee/roster {peer, seq, sig, roster: [{principal, peer, epk_sha256}]}` -> `{ok}`: the seat's signed
    /// attestation of the members it verified, passed to every other admitted seat of the call as
    /// `e2ee_roster {from, roster_seq, roster, sig}` (`roster_seq`: the attestation's `seq`; an event's own `seq` is its
    /// queue number). Never stored: a later joiner hears the next one (every 20 s). The relay checks only shapes and
    /// sizes; members verify the signature and the order.
    pub fn e2ee_roster(&self, peer_id: &str, who: &Identity, seq: Body, sig: Body, roster: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(String, usize)> {
            st.sfu_e2ee_seat(peer_id, who)?;
            let seq = e2ee_count(seq, "seq")?;
            e2ee_b64(sig, 8, E2EE_SIG_MAX, &format!("sig must be a signature (base64 of at most {E2EE_SIG_MAX} bytes)"))?;
            let most = st.sfu.cfg.as_ref().map(|c| c.max).unwrap_or_default();
            let Some(entries) = roster.and_then(Value::as_array).filter(|r| (1..=most).contains(&r.len())) else {
                return bad(format!("roster must list 1 to {most} members"));
            };
            let entry_ok = |item: &Value| {
                item.as_object().is_some_and(|o| {
                    o.len() == E2EE_ROSTER_FIELDS.len() && E2EE_ROSTER_FIELDS.iter().all(|(k, n)| o.get(*k).and_then(Value::as_str).is_some_and(|v| (1..=*n).contains(&pj::char_len(v))))
                })
            };
            if !entries.iter().all(entry_ok) {
                return bad("each roster entry is {principal, peer, epk_sha256}, short texts");
            }
            let room = st.peers[peer_id].room.clone();
            let event = obj([
                ("type", Value::from("e2ee_roster")),
                ("from", Value::from(peer_id)),
                ("roster_seq", Value::from(seq)),
                ("roster", Value::Array(entries.clone())),
                ("sig", sig.cloned().unwrap_or(Value::Null)),
            ]);
            st.broadcast(&room, &event, Some(peer_id));
            Ok((room, entries.len()))
        })();
        drop(st);
        self.wake();
        let (room, members) = r?;
        m::log_debug(&format!("e2ee roster room={room} principal={} members={members}", who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
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
    fn a_stays_identity_format_is_fixed_at_its_first_token() {
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        h.st.lock().sfu.cfg = Some(Arc::new(Cfg { url: "ws://127.0.0.1:9".into(), host: "127.0.0.1".into(), port: 9, tls: false, key: "k".into(), secret: b"s".to_vec(), threshold: 9, max: 100 }));
        let (ann, ben, cy) = (seat("ann@x", "aaaaaaaaaaaaaaaa"), seat("ben@x", "bbbbbbbbbbbbbbbb"), seat("cy@x", "cccccccccccccccc"));
        let new = body(serde_json::json!({"large": true, "e2ee": true, "caps": ["peer_identity"]}));
        let old = body(serde_json::json!({"e2ee": true}));
        let a = h.join("new", &ann, "", false, Some(&new)).unwrap();
        let ap = a["peer"].as_str().unwrap().to_string();
        assert_eq!((&a["e2ee"]["identity"], &a["sfu"]["identity"]), (&Value::from("peer"), &Value::from("peer")));
        // a 0.96.3 app cannot verify `<peer>` identities: refused before it takes a seat
        assert_eq!(refusal(h.join("new", &ben, "", false, Some(&old))), NEEDS_NEW_APP);
        assert_eq!(h.sfu_token(&ap, &ann).unwrap()["identity"], Value::from("peer"));
        assert_eq!(h.st.lock().sfu_seats("new"), HashSet::from([ap.clone()]));

        // an old app first: "legacy" for the whole stay, even for new apps joining later
        let large_old = body(serde_json::json!({"large": true, "e2ee": true}));
        let b = h.join("old", &ben, "", false, Some(&large_old)).unwrap();
        let bp = b["peer"].as_str().unwrap().to_string();
        let c = h.join("old", &cy, "", false, Some(&new)).unwrap();
        let cp = c["peer"].as_str().unwrap().to_string();
        assert_eq!(c["e2ee"]["identity"], Value::from("legacy"));
        assert_eq!(h.st.lock().sfu_seats("old"), HashSet::from([format!("ben@x|{bp}"), format!("cy@x|{cp}")]));
        let guest = Identity { guest: true, ..seat("guest-0123456789abcdef@guest.invalid", "") };
        assert_eq!(refusal(h.join("old", &guest, "", false, Some(&old))), E2EE_GUESTS);

        // the stay ends: the next one decides again
        h.leave(&bp, &ben).unwrap();
        h.leave(&cp, &cy).unwrap();
        assert!(!h.st.lock().sfu.format.contains_key("old"));
    }

    #[test]
    fn large_calls_carry_certs_sender_keys_rosters_and_sealed_captions() {
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
        // ann's join had no `peer_identity`: her first token fixed the stay "legacy" (WA-1 4.3 revision 4)
        assert_eq!(a["e2ee"], serde_json::json!({"required": true, "stay": stay, "identity": "legacy"}));
        assert_eq!(a["sfu"]["identity"], Value::from("legacy"));
        assert_eq!(a["you"]["cert"], Value::from(ann.cert_pem.clone()));
        assert_eq!((&a["you"]["epk"], &a["you"]["sig"]), (&Value::Null, &Value::Null));
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

        // every seat sends its own sender key, each blob only to its recipient (never back to the sender)
        assert!(a["stage"].get("e2ee_leader").is_none());
        let to = serde_json::json!([{"peer": bp, "blob": "AAAA"}, {"peer": "gone", "blob": "AAAA"}, {"peer": ap, "blob": "AAAA"}]);
        assert_eq!(h.e2ee_keys(&ap, &ann, Some(&Value::from(0)), Some(&to)).unwrap()["delivered"], Value::from(1));
        let got = &events_of(&h, &bp, "e2ee_key")[0];
        assert_eq!((got["from"].as_str(), &got["epoch"]), (Some(ap.as_str()), &Value::from(0)));
        assert!(events_of(&h, &cp, "e2ee_key").is_empty() && events_of(&h, &ap, "e2ee_key").is_empty());
        let most = E2EE_COUNT_MAX;
        assert_eq!(h.e2ee_keys(&cp, &cy, Some(&Value::from(most)), Some(&serde_json::json!([{"peer": ap, "blob": "AAAA"}]))).unwrap()["delivered"], Value::from(1));
        let bad_epoch = "epoch must be a whole number from 0 to 9007199254740991";
        for epoch in [Value::from(most + 1), Value::from(-1), Value::Bool(true), Value::from("0"), Value::from(1.5), Value::Null] {
            assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&epoch), Some(&to))), bad_epoch, "{epoch}");
        }
        assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&Value::from(1)), Some(&serde_json::json!([])))), "to must list 1 to 200 recipients ({peer, blob})");
        assert_eq!(refusal(h.e2ee_keys(&ap, &ann, Some(&Value::from(1)), Some(&serde_json::json!([{"blob": "AAAA"}])))), "each recipient needs its peer and a blob");

        // a signed roster goes to the other members, never kept
        let entry = serde_json::json!({"principal": "ann@x", "peer": ap, "epk_sha256": "f".repeat(64)});
        let roster = serde_json::json!([entry]);
        h.e2ee_roster(&ap, &ann, Some(&Value::from(3)), Some(&Value::from(sig.clone())), Some(&roster)).unwrap();
        assert!(events_of(&h, &ap, "e2ee_roster").is_empty());
        let heard = &events_of(&h, &cp, "e2ee_roster")[0];
        assert_eq!(heard.keys().map(String::as_str).collect::<Vec<_>>(), ["type", "from", "roster_seq", "roster", "sig", "seq"]);
        assert_eq!((heard["from"].as_str(), &heard["roster_seq"], &heard["roster"]), (Some(ap.as_str()), &Value::from(3), &roster));
        let bad_entry = "each roster entry is {principal, peer, epk_sha256}, short texts";
        for item in [serde_json::json!("x"), serde_json::json!({"principal": "a", "peer": "p"}), serde_json::json!({"principal": "a", "peer": "p", "epk_sha256": "f", "extra": "1"}), serde_json::json!({"principal": 7, "peer": "p", "epk_sha256": "f"}), serde_json::json!({"principal": "a", "peer": "p".repeat(65), "epk_sha256": "f"})] {
            assert_eq!(refusal(h.e2ee_roster(&ap, &ann, Some(&Value::from(4)), Some(&Value::from(sig.clone())), Some(&serde_json::json!([item])))), bad_entry);
        }
        assert_eq!(refusal(h.e2ee_roster(&ap, &ann, Some(&Value::from(4)), Some(&Value::from(sig.clone())), Some(&serde_json::json!([])))), "roster must list 1 to 100 members");

        // captions of a large call are ciphertext; plain text is refused whole
        let sealed = format!("lme2:3:1:{}", pj::b64(&[1u8; 40]));
        assert!(sealed_caption(&sealed));
        for text in ["the budget is approved", "lme2:3:1:", "lme2:x:1:QUJD", "lme2:3:1:QUJD!", "LME2:3:1:QUJD", "lme2:3:1:QU:JD"] {
            assert!(!sealed_caption(text), "{text}");
            assert_eq!(refusal(h.caption(&ap, &ann, text, Some(&Value::from(1)), None, None)), E2EE_CAPTION_PLAIN, "{text}");
        }
        let lines = serde_json::json!([{"text": sealed, "cseq": 1}, {"text": "the budget is approved", "cseq": 2}]);
        assert_eq!(refusal(h.captions(&ap, &ann, Some(&lines), None, None, None)), E2EE_CAPTION_PLAIN);
        assert!(events_of(&h, &bp, "caption").is_empty());
        assert_eq!(h.caption(&ap, &ann, &sealed, Some(&Value::from(1)), None, None).unwrap()["text"], Value::from(sealed.clone()));

        // the host leaves: nobody leads keys, any seat still sends its own
        h.leave(&ap, &ann).unwrap();
        let stage = events_of(&h, &cp, "stage").into_iter().find(|e| pj::text_of(e, "why") == "leave").unwrap();
        assert!(stage["stage"].get("e2ee_leader").is_none());
        assert_eq!(h.e2ee_keys(&cp, &cy, Some(&Value::from(2)), Some(&serde_json::json!([{"peer": bp, "blob": "AAAA"}]))).unwrap()["delivered"], Value::from(1));

        // nothing of it in state.json
        let snapshot = h.st.lock().snapshot();
        assert!(!snapshot.contains("e2ee") && !snapshot.contains("BEGIN CERTIFICATE") && !snapshot.contains(&point) && !snapshot.contains(&"f".repeat(64)));
    }
}
