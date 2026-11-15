// Phase C (ADR-0540), wave 3: the lobby and web guests (meet_relay._Wave3Guests).
//
// A guest link is `<guest_public>/g/#t=<token>`, token = base64url(payload) "." base64url(HMAC-SHA256(state_dir/
// guest.secret, the first part)), payload `{v: 1, r: room, e: expiry (unix s), n: nonce, i: issued (unix s)}`. A guest
// knocks with it (`guests_knock`) and gets a guest id and a secret (only its SHA-256 is kept); every later guest call
// carries `X-Guest: <id>.<secret>`. Guests and held certificate holders wait in the lobby rows (in memory) until a host
// admits or denies them (stage actions `lobby_*`); an admitted guest joins as a peer whose Identity has `guest` (never
// in the directory or presence). Persisted (ext["guests"]): `revoked` {room: time} (every link of the room issued
// before it) and `blocked` {nonce: expiry} (one link, from "Deny and block"); a restart ends every guest (their links
// still work). The guest port itself (TLS without client certificates) is meet_guest_port. A child module of meet_hub:
// it shares the one lock.

use super::*;
use std::net::{IpAddr, Ipv6Addr};

const MODES: [&str; 3] = ["off", "external", "everyone"];
const ACTIONS: [&str; 5] = ["lobby_admit", "lobby_deny", "lobby_admit_all", "lobby_option", "lobby_links_off"];
const NAME_MAX: usize = 60;
const MINUTES_MAX: f64 = 1440.0;
const TOKEN_MAX: usize = 512;
/// Knocks with a valid link from one address a minute, with one link per 10 minutes, into one room per 10 minutes;
/// knocks with a bad or expired link, and wrong guest passes, from one address a minute.
const KNOCKS_PER_ADDRESS: usize = 12;
const KNOCKS_PER_LINK: usize = 20;
const KNOCKS_PER_ROOM: usize = 60;
const BAD_LINKS_PER_ADDRESS: usize = 30;
const BAD_PER_ADDRESS: usize = 30;
/// Keys of the rate-limit map; past it every new key of a kind shares one overflow bucket.
const HITS_MAX: usize = 20000;
/// Waiting or admitted guests from one address.
const ACTIVE_PER_ADDRESS: usize = 5;
/// A guest's TURN credentials last at most an hour and are renewed on a poll after 30 minutes.
pub const ICE_MAX: f64 = 3600.0;
const ICE_RENEW: f64 = 1800.0;
/// People waiting in one room's lobby, and guest and lobby rows on the whole relay.
const LOBBY_MAX: usize = 50;
const TOTAL_MAX: usize = 1000;
const SECRET_FILE: &str = "guest.secret";
const BUSY: &str = "too many tries from this address; wait a minute";
const BAD_LINK: &str = "this guest link is not valid";
const EXPIRED: &str = "this guest link has expired";
const BAD_PASS: &str = "this guest pass is not valid; open the guest link again";
const NOT_YET: &str = "wait until the host lets you in";
const NOT_WAITING: &str = "that person is not waiting in the lobby";

/// The window each kind of rate-limit mark is kept for.
fn window(kind: &str) -> f64 {
    match kind {
        "knock" | "badlink" | "bad" => 60.0,
        _ => 600.0,
    }
}

/// _guests_addr_key: the key a guest-port limit counts an address under: an IPv4 address itself (also when
/// IPv4-mapped), an IPv6 address by its /64 (one subscriber's whole prefix).
pub fn addr_key(address: &str) -> String {
    let bare = address.split('%').next().unwrap_or_default();
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{}/64", Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
        Err(_) if address.is_empty() => "-".into(),
        Err(_) => pj::clip(address, 64),
    }
}

fn sha_hex(text: &str) -> String {
    crate::codec::hex(&crate::codec::sha256(text.as_bytes()))
}

/// ROOM_RE (re.match, so `$` also matches before one final newline).
fn room_ok(r: &str) -> bool {
    let b = r.strip_suffix('\n').unwrap_or(r).as_bytes();
    !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// The token's characters: `^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$`.
fn token_shape(token: &str) -> Option<(&str, &str)> {
    let (part, sig) = token.split_once('.')?;
    let ok = |s: &str| s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
    ((1..=400).contains(&part.len()) && sig.len() == 43 && ok(part) && ok(sig)).then_some((part, sig))
}

/// base64.urlsafe_b64decode with the padding added.
fn b64u_decode(part: &str) -> Option<Vec<u8>> {
    let mut std: String = part.chars().map(|c| match c {
        '-' => '+',
        '_' => '/',
        c => c,
    }).collect();
    while !std.len().is_multiple_of(4) {
        std.push('=');
    }
    pj::b64_strict(&std)
}

/// `%g` of a number of minutes.
fn fmt_g(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// A checked guest link.
struct Link {
    room: String,
    expires: i64,
    nonce: String,
    issued: f64,
}

/// One lobby row: a web guest (`guest`) or a certificate holder the lobby holds (`member`).
pub(super) struct Rec {
    id: String,
    kind: &'static str,
    room: String,
    name: String,
    ts: f64,
    /// Monotonic: its last sign of life.
    seen: f64,
    /// waiting | admitted | in | ended
    state: &'static str,
    why: String,
    exp: f64,
    nonce: String,
    /// SHA-256 (hex) of a guest's secret.
    secret: String,
    address: String,
    peer: String,
    principal: String,
    who: Identity,
    /// The latest poll (wait or events) of this pass: a newer one ends an older one.
    poll: u64,
    ice_at: f64,
}

/// In memory: the guest port's origin and link secret, the lobby rows, each room's lobby option (this stay), who the
/// lobby let in, and the rate limits.
pub struct Guests {
    public: String,
    state_dir: Option<PathBuf>,
    key: Vec<u8>,
    rec: IndexMap<String, Rec>,
    modes: HashMap<String, &'static str>,
    let_in: HashMap<String, HashSet<String>>,
    hits: HashMap<(&'static str, String), VecDeque<f64>>,
}

impl Guests {
    pub(super) fn new(state_dir: Option<PathBuf>) -> Guests {
        Guests { public: String::new(), state_dir, key: Vec::new(), rec: IndexMap::new(), modes: HashMap::new(), let_in: HashMap::new(), hits: HashMap::new() }
    }

    /// _guests_key: the 32-byte link secret: state_dir/guest.secret (made once, mode 0600), or a random one per process
    /// without a state folder.
    fn key(&mut self) -> &[u8] {
        if self.key.is_empty() {
            let key = if let Some(dir) = &self.state_dir {
                let path = dir.join(SECRET_FILE);
                let mut key = std::fs::read(&path).unwrap_or_default();
                if key.len() != 32 {
                    key = pj::random_bytes(32);
                    let written = (|| -> std::io::Result<()> {
                        std::fs::create_dir_all(dir)?;
                        let tmp = dir.join(format!("{SECRET_FILE}.tmp"));
                        let mut opts = std::fs::OpenOptions::new();
                        opts.write(true).create(true).truncate(true);
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::OpenOptionsExt;
                            opts.mode(0o600);
                        }
                        let mut fh = opts.open(&tmp)?;
                        fh.write_all(&key)?;
                        fh.sync_all()?;
                        drop(fh);
                        std::fs::rename(&tmp, &path)
                    })();
                    if let Err(e) = written {
                        log_warn(&format!("cannot write {}: {e}", path.display()));
                    }
                }
                key
            } else {
                pj::random_bytes(32)
            };
            self.key = key;
        }
        &self.key
    }

    fn sign(&mut self, part: &str) -> String {
        let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, self.key());
        crate::codec::b64u(aws_lc_rs::hmac::sign(&key, part.as_bytes()).as_ref())
    }

    /// _guests_mint: a signed link to `room` until `expires`.
    fn mint(&mut self, room: &str, expires: i64) -> String {
        let issued = (pj::now() * 1000.0).round() / 1000.0;
        let payload = obj([("e", Value::from(expires)), ("i", f(issued)), ("n", Value::from(pj::token_urlsafe(9))), ("r", Value::from(room)), ("v", Value::from(1))]);
        let part = crate::codec::b64u(pj::dumps_compact(&Value::Object(payload)).as_bytes());
        let sig = self.sign(&part);
        format!("{part}.{sig}")
    }

    /// _guests_token: the checked payload of a guest link: 403 when it is not one this relay signed (or was changed),
    /// 410 when it expired.
    fn token(&mut self, token: Body, now: f64) -> R<Link> {
        let bad = || E::Forbidden(BAD_LINK.into());
        let Some(Value::String(token)) = token else { return Err(bad()) };
        if token.len() > TOKEN_MAX {
            return Err(bad());
        }
        let (part, sig) = token_shape(token).ok_or_else(bad)?;
        if aws_lc_rs::constant_time::verify_slices_are_equal(sig.as_bytes(), self.sign(part).as_bytes()).is_err() {
            return Err(bad());
        }
        let payload = b64u_decode(part).and_then(|raw| serde_json::from_slice::<Value>(&raw).ok()).ok_or_else(bad)?;
        let p = payload.as_object().ok_or_else(bad)?;
        let v_ok = matches!(p.get("v"), Some(Value::Bool(true))) || pj::as_num(p.get("v")) == Some(1.0);
        let room = p.get("r").and_then(Value::as_str).filter(|r| room_ok(r)).ok_or_else(bad)?;
        let expires = pj::as_int(p.get("e")).ok_or_else(bad)?;
        let issued = pj::as_num(p.get("i")).ok_or_else(bad)?;
        let nonce = p.get("n").and_then(Value::as_str).ok_or_else(bad)?;
        if !v_ok {
            return Err(bad());
        }
        if (expires as f64) <= now {
            return Err(E::Gone(EXPIRED.into()));
        }
        Ok(Link { room: room.to_string(), expires, nonce: nonce.to_string(), issued })
    }

    /// _guests_count: the marks of one limit, older ones dropped (past HITS_MAX keys, a new key shares one overflow
    /// bucket).
    fn count(&mut self, kind: &'static str, key: &str) -> &mut VecDeque<f64> {
        let mono = pj::mono();
        let mut k = (kind, key.to_string());
        if !self.hits.contains_key(&k) && self.hits.len() >= HITS_MAX {
            k = (kind, "*overflow*".to_string());
        }
        let hits = self.hits.entry(k).or_default();
        while hits.front().map(|t| mono - t > window(kind)).unwrap_or(false) {
            hits.pop_front();
        }
        hits
    }

    /// _guests_check: 429 (with Retry-After) once `most` marks are in the window.
    fn check(&mut self, kind: &'static str, key: &str, most: usize, message: &str) -> R<()> {
        let hits = self.count(kind, key);
        if hits.len() >= most {
            let first = hits.front().copied().unwrap_or_else(pj::mono);
            let retry = (window(kind) - (pj::mono() - first)) as i64 + 1;
            return Err(E::Busy(message.into(), retry.max(1) as u64));
        }
        Ok(())
    }

    fn mark(&mut self, kind: &'static str, key: &str) {
        self.count(kind, key).push_back(pj::mono());
    }

    /// _guests_limit: check, then count this one.
    fn limit(&mut self, kind: &'static str, key: &str, most: usize, message: &str) -> R<()> {
        self.check(kind, key, most, message)?;
        self.mark(kind, key);
        Ok(())
    }

    fn waiting(&self, room: &str) -> usize {
        self.rec.values().filter(|r| r.room == room && r.state == "waiting").count()
    }

    /// _guests_admit.
    fn admit(&mut self, id: &str) {
        let Some(r) = self.rec.get_mut(id) else { return };
        r.state = "admitted";
        r.seen = pj::mono(); // the admitted get PEER_TIMEOUT to come in
        if r.kind == "member" {
            self.let_in.entry(r.room.clone()).or_default().insert(r.principal.clone());
        }
    }
}

/// _guests_id: the guest id in a guest's principal ("" for anyone else).
fn guest_id(principal: &str) -> String {
    principal.strip_prefix("guest-").and_then(|r| r.strip_suffix(m::GUEST_DOMAIN)).filter(|id| id.len() == 16 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).unwrap_or_default().to_string()
}

/// _guests_ended: what a pass that ended answers.
fn ended(why: &str) -> E {
    match why {
        "denied" => E::Forbidden("the host did not let you in".into()),
        "expired" => E::Gone(EXPIRED.into()),
        "removed" => E::Forbidden("the host removed you from this call".into()),
        "e2ee" => E::Forbidden(sfu::E2EE_GUESTS.into()),
        _ => E::Gone("this guest pass has ended; open the guest link again".into()),
    }
}

impl State {
    pub(super) fn guests_on(&self) -> bool {
        !self.guests.public.is_empty()
    }

    /// _bridge_guest_url: a guest link to `room` until `expires` with this slice's own tokens (the guest waits in the
    /// lobby until someone in the call lets them in). Callers check guests_on first.
    pub(super) fn guests_url(&mut self, room: &str, expires: i64) -> String {
        let token = self.guests.mint(room, expires);
        format!("{}/g/#t={token}", self.guests.public)
    }

    /// _guests_configure: guests on when `guest_port` is set (its expiry and liveness sweep runs every reap).
    pub(super) fn guests_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        if !pj::truthy(Some(&s.guest_port)) {
            return Ok(());
        }
        let port_ok = pj::as_int(Some(&s.guest_port)).map(|p| p > 0 && p < 65536 && p != s.port as i64).unwrap_or(false);
        if !port_ok {
            return Err("relay settings: guest_port must be a free port number (not the relay's own port), or 0 for no guests".into());
        }
        self.guests.public = guest_origin(&s.guest_public).ok_or_else(|| "relay settings: guest_public must be the https origin guests open, such as https://join.example.com".to_string())?;
        Ok(())
    }

    /// _guests_left: a seated guest's row ends; a guest never keeps the host role.
    pub(super) fn guests_left(&mut self, peer: &Peer, why: &str) {
        if peer.who.guest {
            if let Some(r) = self.guests.rec.get_mut(&guest_id(&peer.who.principal)) {
                if r.state == "in" && r.peer == peer.peer_id {
                    r.state = "ended";
                    r.why = why.to_string();
                    r.seen = pj::mono();
                }
            }
        }
        self.guests_fix_host(&peer.room);
    }

    /// _guests_room_empty: the room's stay ended: its lobby option goes, held certificate holders may join.
    pub(super) fn guests_room_empty(&mut self, room: &str) {
        self.guests.modes.remove(room);
        self.guests.let_in.remove(room);
        for r in self.guests.rec.values_mut() {
            if r.room == room && r.kind == "member" && r.state == "waiting" {
                r.state = "admitted";
            }
        }
    }

    /// _guests_stage_view: what everyone's stage says of the lobby: how many wait (`lobby_count`) and the option
    /// (`lobby_mode`). Who waits goes only to hosts and relay admins.
    pub(super) fn guests_stage_view(&mut self, room: &str, view: &mut Obj) {
        let waiting = self.guests.waiting(room);
        if waiting > 0 {
            view.insert("lobby_count".into(), Value::from(waiting));
        }
        let mode = self.guests.modes.get(room).copied().unwrap_or("off");
        if mode != "off" {
            view.insert("lobby_mode".into(), Value::from(mode));
        }
    }

    fn guests_entries(&self, room: &str) -> Vec<Value> {
        let mut waiting: Vec<&Rec> = self.guests.rec.values().filter(|r| r.room == room && r.state == "waiting").collect();
        waiting.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
        waiting
            .into_iter()
            .map(|r| {
                let mut out = obj([("guest", Value::from(r.id.clone())), ("name", Value::from(r.name.clone())), ("ts", f(r.ts)), ("kind", Value::from(r.kind))]);
                if r.kind == "member" {
                    out.insert("principal".into(), Value::from(r.principal.clone()));
                    out.insert("org".into(), self.org(&r.principal));
                }
                Value::Object(out)
            })
            .collect()
    }

    /// _guests_sees_lobby: the room's host, a co-organizer or a relay admin in it (never a guest, never while waiting
    /// for recording consent).
    fn guests_sees_lobby(&self, peer_id: &str) -> bool {
        let Some(p) = self.peers.get(peer_id) else { return false };
        if p.who.guest || p.admission_pending {
            return false;
        }
        self.pa_hosts(&p.room, peer_id) || self.admins.contains(&p.who.principal)
    }

    fn guests_host_view(&mut self, room: &str) -> Value {
        let mut view = self.stage_view_ext(room);
        let entries = self.guests_entries(room);
        if let (Value::Object(v), false) = (&mut view, entries.is_empty()) {
            v.insert("lobby".into(), Value::Array(entries));
        }
        view
    }

    /// _guests_lobby_event: the stage event of a lobby change (`why: "lobby"`), per viewer: hosts and admins get the
    /// list, everyone else the count. `by` names the actor for everyone only when it is someone in the call.
    fn guests_lobby_event(&mut self, room: &str, by: &str) {
        let plain = self.stage_view_ext(room);
        let full = self.guests_host_view(room);
        let here = self.peers.values().any(|p| p.room == room && !p.admission_pending && p.who.principal == by);
        let public_by = if here { by } else { "" };
        let ids: Vec<String> = self.peers.values().filter(|p| p.room == room && !p.admission_pending).map(|p| p.peer_id.clone()).collect();
        for id in ids {
            let host = self.guests_sees_lobby(&id);
            let event = obj([("type", Value::from("stage")), ("room", Value::from(room)), ("stage", if host { full.clone() } else { plain.clone() }), ("why", Value::from("lobby")), ("by", Value::from(if host { by } else { public_by }))]);
            self.push_peer(&id, &event);
        }
    }

    /// _guests_join_extra: a host or admin joining sees who waits in its join answer's stage.
    pub(super) fn guests_join_extra(&mut self, room: &str, peer_id: &str) -> Obj {
        if !self.guests_sees_lobby(peer_id) || self.guests.waiting(room) == 0 {
            return Obj::new();
        }
        obj([("stage", self.guests_host_view(room))])
    }

    /// _guests_may_join: a web guest joins only once admitted; a certificate holder the room's lobby option holds is
    /// refused with a wait id (one row per person and room).
    pub(super) fn guests_may_join(&mut self, room: &str, who: &Identity) -> R<()> {
        if who.guest {
            let ok = self.guests.rec.get(&guest_id(&who.principal)).map(|r| r.room == room && (r.state == "admitted" || r.state == "in")).unwrap_or(false);
            return if ok { Ok(()) } else { forbidden("guests join through the lobby") };
        }
        if who.principal.ends_with(m::GUEST_DOMAIN) {
            return forbidden("addresses ending @guest.invalid belong to web guests");
        }
        let mode = self.guests.modes.get(room).copied().unwrap_or("off");
        let mine: Vec<String> = self.guests.rec.values().filter(|r| r.kind == "member" && r.room == room && r.principal == who.principal && (r.state == "waiting" || r.state == "admitted")).map(|r| r.id.clone()).collect();
        if mode == "off" || self.guests_exempt(room, who, mode) {
            // admitted (or the option went off): the row is done
            for id in mine {
                self.guests.rec.shift_remove(&id);
            }
            return Ok(());
        }
        let id = match mine.into_iter().next() {
            Some(id) => id,
            None => {
                if self.guests.waiting(room) >= LOBBY_MAX {
                    return forbidden("the lobby of this meeting is full; try again later");
                }
                let id = self.guests_new("member", room, &who.name, who.clone(), "", 0.0, "", "");
                self.guests_lobby_event(room, &who.principal);
                log_info(&format!("lobby_wait room={room} principal={} wait={id}", who.principal));
                id
            }
        };
        if let Some(r) = self.guests.rec.get_mut(&id) {
            r.seen = pj::mono();
        }
        Err(E::Held("wait in the lobby: the host will let you in".into(), obj([("lobby", Value::Bool(true)), ("wait", Value::from(id)), ("room", Value::from(room))])))
    }

    #[allow(clippy::too_many_arguments)]
    fn guests_new(&mut self, kind: &'static str, room: &str, name: &str, who: Identity, address: &str, exp: f64, nonce: &str, secret: &str) -> String {
        let id = pj::token_hex(8);
        let who = if kind == "guest" { Identity { principal: format!("guest-{id}{}", m::GUEST_DOMAIN), name: name.to_string(), guest: true, ..Default::default() } } else { who };
        let rec = Rec {
            id: id.clone(),
            kind,
            room: room.to_string(),
            name: name.to_string(),
            ts: pj::now(),
            seen: pj::mono(),
            state: "waiting",
            why: String::new(),
            exp,
            nonce: nonce.to_string(),
            secret: if secret.is_empty() { String::new() } else { sha_hex(secret) },
            address: address.to_string(),
            peer: String::new(),
            principal: who.principal.clone(),
            who,
            poll: 0,
            ice_at: 0.0,
        };
        self.guests.rec.insert(id.clone(), rec);
        id
    }

    fn guests_members_here(&self, room: &str) -> Vec<&Peer> {
        self.peers.values().filter(|p| p.room == room && !p.who.guest && !p.admission_pending).collect()
    }

    /// _guests_exempt: who the lobby option lets straight in: relay admins, the scheduled meeting's organizer, anyone
    /// already in this stay or admitted, everyone when no certificate holder is there to answer, and with `external`
    /// the host's own organization.
    fn guests_exempt(&self, room: &str, who: &Identity, mode: &str) -> bool {
        if self.admins.contains(&who.principal) {
            return true;
        }
        if self.stays.get(room).map(|s| s.seen.contains_key(&who.principal)).unwrap_or(false) {
            return true;
        }
        if self.guests.let_in.get(room).map(|s| s.contains(&who.principal)).unwrap_or(false) {
            return true;
        }
        let organizer = as_obj(self.meetings.get(room)).filter(|m| !pj::truthy(m.get("canceled"))).and_then(|m| as_obj(m.get("organizer"))).map(|o| pj::text_of(o, "principal"));
        if organizer.as_deref() == Some(who.principal.as_str()) {
            return true;
        }
        if self.guests_members_here(room).is_empty() {
            return true;
        }
        if mode == "external" {
            let host = self.stage_host(room).and_then(|h| self.peers.get(&h)).filter(|p| !p.who.guest).map(|p| self.org(&p.who.principal));
            let mine = self.org(&who.principal);
            return match (host, mine) {
                (Some(Value::Object(a)), Value::Object(b)) => a.get("id") == b.get("id"),
                _ => false,
            };
        }
        false
    }

    /// _guests_fix_host: a guest never hosts: when the role fell to one, it goes to the longest-present certificate
    /// holder, or nobody (the next one to join takes it).
    fn guests_fix_host(&mut self, room: &str) {
        let Some(host) = self.stage_host(room) else { return };
        if !self.peers.get(&host).map(|p| p.who.guest).unwrap_or(false) {
            return;
        }
        let next = self.guests_members_here(room).into_iter().min_by(|a, b| a.joined.partial_cmp(&b.joined).unwrap_or(std::cmp::Ordering::Equal)).map(|p| Value::from(p.peer_id.clone())).unwrap_or(Value::Null);
        self.stage_mut(room).insert("host".into(), next);
        self.stage_event(room, "leave", "", None);
    }

    /// _guests_end: end a row: a guest in the call is sent `removed` (`why`) and dropped; a waiting one leaves the
    /// lobby (the caller tells the room).
    fn guests_end(&mut self, id: &str, why: &str) {
        let Some(r) = self.guests.rec.get(id) else { return };
        if r.state == "in" && self.peers.contains_key(&r.peer) {
            let peer = r.peer.clone();
            self.push_peer(&peer, &obj([("type", Value::from("removed")), ("by", Value::from("")), ("name", Value::from("")), ("why", Value::from(why))]));
            let p = &self.peers[peer.as_str()];
            let moved = Moved { principal: p.who.principal.clone(), event: p.events.back().cloned().unwrap_or_default(), at: pj::mono() };
            self.moved.insert(peer.clone(), moved);
            self.drop_peer(&peer, why, true, true, "");
        }
        if let Some(r) = self.guests.rec.get_mut(id) {
            r.state = "ended";
            r.why = why.to_string();
            r.seen = pj::mono();
        }
    }

    /// _guests_sweep: kick guests whose link expired, drop rows nobody polls any more (PEER_TIMEOUT), forget ended rows
    /// and old rate-limit marks and turned-off links that cover nothing any more.
    pub(super) fn guests_sweep(&mut self) {
        let (mono, wall) = (pj::mono(), pj::now());
        let mut changed: Vec<String> = Vec::new();
        let ids: Vec<String> = self.guests.rec.keys().cloned().collect();
        for id in ids {
            let Some(r) = self.guests.rec.get(&id) else { continue };
            if r.state == "ended" {
                if mono - r.seen > PEER_TIMEOUT {
                    self.guests.rec.shift_remove(&id);
                }
                continue;
            }
            let (waiting, room) = (r.state == "waiting", r.room.clone());
            if r.kind == "guest" && r.exp <= wall {
                self.guests_end(&id, "expired");
            } else if (r.state == "waiting" || r.state == "admitted") && mono - r.seen > PEER_TIMEOUT {
                self.guests_end(&id, "timeout");
            } else {
                continue;
            }
            if waiting && !changed.contains(&room) {
                changed.push(room);
            }
        }
        for room in changed {
            self.guests_lobby_event(&room, "");
        }
        self.guests.hits.retain(|(kind, _), hits| {
            while hits.front().map(|t| mono - t > window(kind)).unwrap_or(false) {
                hits.pop_front();
            }
            !hits.is_empty()
        });
        let cut = wall - MINUTES_MAX * 60.0 - 60.0;
        let store = self.guests_store();
        let mut dropped = false;
        if let Some(Value::Object(revoked)) = store.get_mut("revoked") {
            let n = revoked.len();
            revoked.retain(|_, at| pj::as_num(Some(at)).unwrap_or(0.0) >= cut);
            dropped |= revoked.len() != n;
        }
        if let Some(Value::Object(blocked)) = store.get_mut("blocked") {
            let n = blocked.len();
            blocked.retain(|_, exp| pj::as_num(Some(exp)).unwrap_or(0.0) >= wall);
            dropped |= blocked.len() != n;
        }
        if dropped {
            self.dirty = true;
        }
    }

    /// _guests_store: ext["guests"] as checked: `{revoked: {room: t}, blocked: {nonce: expiry}}` (anything unreadable
    /// from state.json is dropped; a sound one is kept as it is).
    fn guests_store(&mut self) -> &mut Obj {
        let raw = as_obj(self.ext.get("guests")).cloned().unwrap_or_default();
        let mut out = Obj::new();
        for part in ["revoked", "blocked"] {
            let kept: Obj = as_obj(raw.get(part)).map(|o| o.iter().filter_map(|(k, v)| pj::as_num(Some(v)).map(|x| (k.clone(), f(x)))).collect()).unwrap_or_default();
            out.insert(part.into(), Value::Object(kept));
        }
        // dict equality: the same keys, the same numbers (an int equals its float)
        let same = |a: &Obj, b: &Obj| -> bool {
            a.len() == b.len()
                && a.iter().all(|(k, v)| match (v, b.get(k)) {
                    (Value::Object(x), Some(Value::Object(y))) => x.len() == y.len() && x.iter().all(|(n, t)| y.get(n).and_then(|u| pj::as_num(Some(u))) == pj::as_num(Some(t)) && pj::as_num(Some(t)).is_some()),
                    _ => false,
                })
        };
        if !self.ext.get("guests").map(|g| g.is_object()).unwrap_or(false) || !same(&raw, &out) {
            self.ext.insert("guests".into(), Value::Object(out));
        }
        obj_mut(&mut self.ext, "guests")
    }

    fn guests_revoked(&mut self, room: &str) -> f64 {
        as_obj(self.guests_store().get("revoked")).and_then(|r| pj::as_num(r.get(room))).unwrap_or(-1.0)
    }

    /// _guests_auth: the guest row an `X-Guest: <id>.<secret>` header names (403 otherwise; too many wrong ones from one
    /// address: 429).
    fn guests_auth(&mut self, header: &str, address: &str) -> R<String> {
        let addr = addr_key(address);
        self.guests.check("bad", &addr, BAD_PER_ADDRESS, BUSY)?;
        let header = header.trim();
        let (gid, secret) = header.split_once('.').unwrap_or((header, ""));
        let ok = !gid.is_empty()
            && self.guests.rec.get(gid).map(|r| r.kind == "guest" && !secret.is_empty() && secret.chars().count() <= 100 && aws_lc_rs::constant_time::verify_slices_are_equal(r.secret.as_bytes(), sha_hex(secret).as_bytes()).is_ok()).unwrap_or(false);
        if !ok {
            self.guests.mark("bad", &addr);
            return forbidden(BAD_PASS);
        }
        Ok(gid.to_string())
    }

    /// _guests_live: (peer id, Identity) of an admitted guest in the call; its link expiring ends it.
    fn guests_live(&mut self, header: &str, address: &str) -> R<(String, Identity)> {
        let id = self.guests_auth(header, address)?;
        let r = &self.guests.rec[&id];
        if r.state == "in" && r.exp <= pj::now() {
            self.guests_end(&id, "expired");
        }
        let r = &self.guests.rec[&id];
        if r.state == "ended" {
            return Err(ended(&r.why));
        }
        if r.state != "in" {
            return forbidden(NOT_YET);
        }
        Ok((r.peer.clone(), r.who.clone()))
    }

    /// _guests_mine: the caller's own lobby row, by its wait id or by the room it waits for (the newest).
    fn guests_mine(&self, wait: &str, room: &str, who: &Identity) -> R<String> {
        let found = if !wait.is_empty() {
            self.guests.rec.get(wait)
        } else {
            let name = room.trim().to_lowercase();
            self.guests.rec.values().filter(|r| r.kind == "member" && r.room == name && r.principal == who.principal).max_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal))
        };
        match found {
            Some(r) if r.kind == "member" && r.principal == who.principal => Ok(r.id.clone()),
            _ => Err(E::Gone("you are not waiting in a lobby".into())),
        }
    }
}

/// _guests_origin: the https origin guests open (no path, query, fragment or user).
fn guest_origin(value: &str) -> Option<String> {
    let rest = value.trim().strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (netloc, tail) = rest.split_at(end);
    if !(tail.is_empty() || tail == "/") || netloc.contains('@') || netloc.is_empty() || netloc.starts_with(':') {
        return None;
    }
    Some(format!("https://{netloc}"))
}

impl Hub {
    /// `POST /v1/guest/link`: a guest link to `room` for `minutes` (0 < m <= 1440). From a call (`peer`): its host or a
    /// relay admin; from a presence `session`: the organizer of the scheduled meeting in that room or a relay admin.
    pub fn guests_link(&self, who: &Identity, room: Body, minutes: Body, peer: Option<String>, session: Option<String>) -> R<Obj> {
        let room = m::room_name(room)?;
        let minutes = match pj::as_num(minutes) {
            Some(x) if x > 0.0 && x <= MINUTES_MAX => x,
            _ => return bad(format!("minutes must be more than 0 and at most {}", MINUTES_MAX as i64)),
        };
        let mut st = self.st.lock();
        if !st.guests_on() {
            return Err(E::Unavailable("this relay does not take guests (set guest_port and guest_public)".into()));
        }
        if let Some(peer) = &peer {
            st.owned(peer, who)?;
            let p = &st.peers[peer.as_str()];
            if p.admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            if p.room != room {
                return forbidden("you are not in that call");
            }
            if !st.pa_hosts(&room, peer) && !st.admins.contains(&who.principal) {
                return forbidden(NOT_HOST);
            }
        } else if let Some(session) = &session {
            st.session(session, who)?;
            let organizer = as_obj(st.meetings.get(&room)).and_then(|m| as_obj(m.get("organizer"))).map(|o| pj::text_of(o, "principal"));
            if !st.admins.contains(&who.principal) && organizer.as_deref() != Some(who.principal.as_str()) {
                return forbidden("only the host or the meeting organizer can invite guests");
            }
        } else {
            return bad("say which call (peer) or session");
        }
        let expires = (pj::now() + minutes * 60.0) as i64;
        let token = st.guests.mint(&room, expires);
        let public = st.guests.public.clone();
        drop(st);
        log_info(&format!("guest_link room={room} principal={} minutes={}", who.principal, fmt_g(minutes)));
        Ok(obj([("url", Value::from(format!("{public}/g/#t={token}"))), ("expires", Value::from(expires)), ("room", Value::from(room))]))
    }

    /// `GET /v1/lobby?peer=` (host or relay admin): `{lobby, mode}`.
    pub fn guests_lobby_list(&self, peer_id: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        if st.peers[peer_id].admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        if !st.guests_sees_lobby(peer_id) {
            return forbidden(NOT_HOST);
        }
        st.guests_sweep();
        let room = st.peers[peer_id].room.clone();
        let mode = st.guests.modes.get(&room).copied().unwrap_or("off");
        let out = obj([("lobby", Value::Array(st.guests_entries(&room))), ("mode", Value::from(mode))]);
        drop(st);
        self.wake();
        Ok(out)
    }

    /// `GET /v1/lobby/wait?wait=|room=`: a held certificate holder waits (up to POLL_WAIT) to be admitted (then joins
    /// again) or denied (403).
    pub fn guests_lobby_wait(&self, wait: &str, who: &Identity, room: &str) -> R<Obj> {
        let deadline = pj::mono() + m::POLL_WAIT;
        let mut st = self.st.lock();
        let id = st.guests_mine(wait, room, who)?;
        let mut last = ("waiting", String::new(), String::new());
        loop {
            match st.guests.rec.get_mut(&id) {
                Some(r) => {
                    r.seen = pj::mono();
                    last = (r.state, r.why.clone(), r.room.clone());
                }
                None => last.0 = "ended",
            }
            match last.0 {
                "admitted" => return Ok(obj([("admitted", Value::Bool(true)), ("room", Value::from(last.2))])),
                "ended" => return Err(ended(&last.1)),
                _ => {}
            }
            let left = deadline - pj::mono();
            if left <= 0.0 {
                return Ok(obj([("admitted", Value::Bool(false)), ("room", Value::from(last.2))]));
            }
            self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
        }
    }

    /// `POST /v1/lobby/leave {wait|room}`: stop waiting.
    pub fn guests_lobby_leave(&self, wait: Body, who: &Identity, room: Body) -> R<Obj> {
        let wait = if pj::truthy(wait) { pj::str_or(wait) } else { String::new() };
        let mut st = self.st.lock();
        let id = st.guests_mine(&wait, &pj::str_or(room), who)?;
        let (was_waiting, room) = st.guests.rec.get(&id).map(|r| (r.state == "waiting", r.room.clone())).unwrap_or_default();
        st.guests_end(&id, "left");
        if was_waiting {
            st.guests_lobby_event(&room, &who.principal);
        }
        drop(st);
        self.wake();
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// _guests_stage: `/v1/stage` lobby actions (host or relay admin): `lobby_admit {target}`, `lobby_deny {target,
    /// block?}`, `lobby_admit_all`, `lobby_option {mode}`, `lobby_links_off`.
    pub(super) fn guests_stage(&self, peer_id: &str, who: &Identity, action: &str, body: &Obj) -> R<Obj> {
        if !ACTIONS.contains(&action) {
            return bad(format!("action must be one of {}", STAGE_ACTIONS.iter().chain(ACTIONS.iter()).copied().collect::<Vec<_>>().join(", ")));
        }
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            st.owned(peer_id, who)?;
            if st.peers[peer_id].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id].room.clone();
            if who.guest || (!st.pa_hosts(&room, peer_id) && !st.admins.contains(&who.principal)) {
                return forbidden(NOT_HOST);
            }
            st.guests_sweep();
            let mut target = String::new();
            let changed = match action {
                "lobby_option" => {
                    let Some(mode) = body.get("mode").and_then(Value::as_str).and_then(|m| MODES.iter().copied().find(|x| *x == m)) else {
                        return bad("mode must be off, external or everyone");
                    };
                    let changed = st.guests.modes.get(&room).copied().unwrap_or("off") != mode;
                    if mode == "off" {
                        st.guests.modes.remove(&room);
                        // held members may come in now
                        let held: Vec<String> = st.guests.rec.values().filter(|r| r.room == room && r.kind == "member" && r.state == "waiting").map(|r| r.id.clone()).collect();
                        for id in held {
                            st.guests.admit(&id);
                        }
                    } else {
                        st.guests.modes.insert(room.clone(), mode);
                    }
                    target = mode.to_string();
                    changed
                }
                "lobby_admit_all" => {
                    let waiting: Vec<(String, bool)> = st.guests.rec.values().filter(|r| r.room == room && r.state == "waiting").map(|r| (r.id.clone(), r.kind == "guest")).collect();
                    let encrypted = st.sfu_encrypted(&room);
                    for (id, guest) in &waiting {
                        if *guest && encrypted {
                            st.guests_end(id, "e2ee"); // never into a large call
                        } else {
                            st.guests.admit(id);
                        }
                    }
                    !waiting.is_empty()
                }
                "lobby_links_off" => {
                    // every guest link of this room made so far stops working (new ones work); the cutoff on the
                    // tokens' own clock and resolution (ms): a link issued before this moment always has i <= cutoff
                    let cutoff = (pj::now() * 1000.0).round() / 1000.0;
                    if let Some(Value::Object(revoked)) = st.guests_store().get_mut("revoked") {
                        revoked.insert(room.clone(), f(cutoff));
                    }
                    st.dirty = true;
                    false
                }
                _ => {
                    let admit = action == "lobby_admit";
                    let Some(t) = body.get("target").and_then(Value::as_str).filter(|t| !t.is_empty()) else {
                        return bad(format!("say whom to {} (target)", if admit { "admit" } else { "deny" }));
                    };
                    target = t.to_string();
                    let found = st.guests.rec.get(t).filter(|r| r.room == room && r.state == "waiting").map(|r| (r.kind, r.nonce.clone(), r.exp));
                    let Some((kind, nonce, exp)) = found else { return Err(E::NotFound(NOT_WAITING.into())) };
                    let block = match body.get("block") {
                        None | Some(Value::Null) => false,
                        Some(Value::Bool(b)) => *b,
                        Some(_) => return bad("block must be true or false"),
                    };
                    if admit {
                        if kind == "guest" && st.sfu_encrypted(&room) {
                            return forbidden(sfu::E2EE_GUESTS);
                        }
                        st.guests.admit(t);
                    } else {
                        st.guests_end(t, "denied");
                        if block && kind == "guest" && !nonce.is_empty() {
                            // "Deny and block": the link that person used stops working
                            if let Some(Value::Object(blocked)) = st.guests_store().get_mut("blocked") {
                                blocked.insert(nonce, f(exp));
                            }
                            st.dirty = true;
                        }
                    }
                    true
                }
            };
            if changed {
                st.guests_lobby_event(&room, &who.principal);
            }
            // the host: with who waits
            Ok((obj([("ok", Value::Bool(true)), ("stage", st.guests_host_view(&room))]), room, target))
        })();
        drop(st);
        self.wake();
        let (out, room, target) = r?;
        log_info(&format!("stage room={room} principal={} action={action} target={}", who.principal, kv(&target)));
        Ok(out)
    }

    // ── the guest port (no certificate; every call but knock carries X-Guest) ───────────────────────────────

    /// `POST /g/v1/knock {token, name}` -> `{guest, secret, wait: true, room, expires, name}`; the guest waits in the
    /// room's lobby.
    pub fn guests_knock(&self, token: Body, name: Body, address: &str) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            if !st.guests_on() {
                return Err(E::Unavailable("this relay does not take guests".into()));
            }
            let addr = addr_key(address);
            // the token is checked before a knock is counted: a bad or expired one counts against the address's
            // bad-link limit instead
            st.guests.check("badlink", &addr, BAD_LINKS_PER_ADDRESS, BUSY)?;
            st.guests.check("knock", &addr, KNOCKS_PER_ADDRESS, BUSY)?;
            let link = match st.guests.token(token, pj::now()) {
                Ok(l) => l,
                Err(e) => {
                    st.guests.mark("badlink", &addr);
                    return Err(e);
                }
            };
            let blocked = as_obj(st.guests_store().get("blocked")).map(|b| b.contains_key(&link.nonce)).unwrap_or(false);
            if blocked || link.issued <= st.guests_revoked(&link.room) {
                st.guests.mark("badlink", &addr);
                return forbidden("the host turned this guest link off");
            }
            st.guests.limit("link", &link.nonce, KNOCKS_PER_LINK, "this guest link was used too often; wait a few minutes")?;
            st.guests.limit("room", &link.room, KNOCKS_PER_ROOM, "this meeting has too many people knocking; wait a few minutes")?;
            st.guests.mark("knock", &addr);
            let name = match name {
                Some(Value::String(s)) => pj::squash(s),
                _ => String::new(),
            };
            if name.is_empty() || pj::char_len(&name) > NAME_MAX || !pj::printable(&name) {
                return bad(format!("say your name (1 to {NAME_MAX} characters)"));
            }
            if st.sfu_encrypted(&link.room) {
                return forbidden(sfu::E2EE_GUESTS);
            }
            let live = st.guests.rec.values().filter(|r| r.state != "ended");
            if live.clone().count() >= TOTAL_MAX {
                return Err(E::Busy("too many guests right now; try again later".into(), 60));
            }
            if live.filter(|r| r.kind == "guest" && addr_key(&r.address) == addr).count() >= ACTIVE_PER_ADDRESS {
                return Err(E::Busy("too many guests from this address".into(), 60));
            }
            if st.guests.waiting(&link.room) >= LOBBY_MAX {
                return Err(E::Busy("the lobby of this meeting is full; try again later".into(), 60));
            }
            let secret = pj::token_urlsafe(24);
            let id = st.guests_new("guest", &link.room, &name, Identity::default(), address, link.expires as f64, &link.nonce, &secret);
            st.guests_lobby_event(&link.room, "");
            let out = obj([("guest", Value::from(id.clone())), ("secret", Value::from(secret)), ("wait", Value::Bool(true)), ("room", Value::from(link.room.clone())), ("expires", Value::from(link.expires)), ("name", Value::from(name))]);
            Ok((out, link.room, id))
        })();
        drop(st);
        self.wake();
        let (out, room, id) = r?;
        log_info(&format!("guest_knock room={room} guest={id}"));
        Ok(out)
    }

    /// `GET /g/v1/wait`: waits up to POLL_WAIT; `{admitted: false}`, or once admitted the join answer (as `/v1/join`)
    /// plus `admitted: true`. Denied: 403; link expired or the pass ended: 410.
    pub fn guests_wait(&self, header: &str, address: &str) -> R<Obj> {
        let deadline = pj::mono() + m::POLL_WAIT;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let id = st.guests_auth(header, address)?;
            // one poll per pass: a newer one ends this one (a reconnect never stacks threads)
            let mine = {
                let r = st.guests.rec.get_mut(&id).expect("an authenticated row");
                r.seen = pj::mono();
                r.poll += 1;
                r.poll
            };
            self.wake();
            loop {
                let Some(r) = st.guests.rec.get(&id) else { return Err(ended("")) };
                if r.poll != mine {
                    return Ok(obj([("admitted", Value::Bool(false))]));
                }
                if r.state != "ended" && r.exp <= pj::now() {
                    let (waiting, room) = (r.state == "waiting", r.room.clone());
                    st.guests_end(&id, "expired");
                    if waiting {
                        st.guests_lobby_event(&room, "");
                    }
                }
                let (state, why, peer) = {
                    let r = &st.guests.rec[&id];
                    (r.state, r.why.clone(), r.peer.clone())
                };
                match state {
                    "ended" => return Err(ended(&why)),
                    "admitted" => return self.guests_enter(&mut st, &id),
                    "in" => return Ok(obj([("admitted", Value::Bool(true)), ("peer", Value::from(peer))])),
                    _ => {}
                }
                let left = deadline - pj::mono();
                if left <= 0.0 {
                    return Ok(obj([("admitted", Value::Bool(false))]));
                }
                self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
            }
        })();
        drop(st);
        self.wake();
        r
    }

    /// _guests_enter: the admitted guest takes its seat (a join with the lock held). It sees only the chat of this
    /// stay, never older history.
    fn guests_enter(&self, st: &mut State, id: &str) -> R<Obj> {
        let (room, who, address, exp) = {
            let r = &st.guests.rec[id];
            (r.room.clone(), r.who.clone(), r.address.clone(), r.exp)
        };
        let ext = obj([("client", Value::Object(obj([("app", Value::from("guest")), ("platform", Value::from("web"))])))]);
        let mut answer = match self.join_held(st, &room, &who, &address, false, &ext) {
            Ok(answer) => answer,
            Err(E::Forbidden(e)) if e == sfu::E2EE_GUESTS => {
                st.guests_end(id, "e2ee"); // the call became a large one meanwhile
                return Err(E::Forbidden(e));
            }
            Err(e) => return Err(e),
        };
        let peer = pj::text_of(&answer, "peer");
        if let Some(r) = st.guests.rec.get_mut(id) {
            r.state = "in";
            r.peer = peer.clone();
            r.ice_at = pj::mono(); // the guest port adds fresh credentials
        }
        if st.stage_host(&room).as_deref() == Some(peer.as_str()) {
            st.guests_fix_host(&room);
            answer.insert("stage".into(), st.stage_view_ext(&room));
        }
        let start = st.stays.get(&room).map(|s| s.start).unwrap_or_else(pj::now);
        let chat: Vec<Value> = answer.get("chat").and_then(Value::as_array).into_iter().flatten().filter(|l| l.get("ts").and_then(|t| pj::as_num(Some(t))).unwrap_or(0.0) >= start).cloned().collect();
        answer.insert("chat".into(), Value::Array(chat));
        answer.insert("missed".into(), Value::Object(Obj::new()));
        answer.insert("admitted".into(), Value::Bool(true));
        answer.insert("expires".into(), Value::from(exp as i64)); // when the link (and so the seat) ends
        log_info(&format!("guest_in room={room} guest={id} peer={peer}"));
        Ok(answer)
    }

    /// `GET /g/v1/events`: the guest's room events (as `/v1/events`); after a removal or the link's expiry, one last
    /// `removed` event, then 410. One poll per pass: a newer poll ends the older at once.
    pub fn guests_events(&self, header: &str, address: &str, after: i64) -> R<Obj> {
        let deadline = pj::mono() + m::POLL_WAIT;
        let mut st = self.st.lock();
        let id = st.guests_auth(header, address)?;
        let r = &st.guests.rec[&id];
        if r.state == "in" && r.exp <= pj::now() {
            st.guests_end(&id, "expired");
            self.wake();
        }
        let Some(r) = st.guests.rec.get(&id) else { return Err(ended("")) };
        if !(r.state == "in" || r.state == "ended") || r.peer.is_empty() {
            return forbidden(NOT_YET);
        }
        let (peer_id, who) = (r.peer.clone(), r.who.clone());
        if !st.peers.contains_key(&peer_id) {
            if let Some(g) = st.moved.get(&peer_id) {
                if g.principal == who.principal && seq_of(&g.event) > after {
                    return Ok(obj([("events", Value::Array(vec![Value::Object(g.event.clone())]))]));
                }
            }
        }
        st.owned(&peer_id, &who)?;
        let lapsed = {
            let p = st.peers.get_mut(&peer_id).expect("owned");
            p.last_seen = pj::mono();
            p.polls += 1;
            std::mem::replace(&mut p.lapsed, false)
        };
        if lapsed {
            st.set_weak(&peer_id, "polls");
        }
        let mine = {
            let r = st.guests.rec.get_mut(&id).expect("an authenticated row");
            r.poll += 1;
            r.poll
        };
        self.wake();
        let pending = |q: &VecDeque<Obj>| -> Vec<Value> { q.iter().filter(|e| seq_of(e) > after).map(|e| Value::Object(e.clone())).collect() };
        let out = loop {
            let found = match st.peers.get(&peer_id) {
                Some(p) => pending(&p.events),
                None => st.gone.get(&peer_id).map(|g| pending(&g.events)).unwrap_or_default(),
            };
            if !found.is_empty() {
                break found;
            }
            let left = deadline - pj::mono();
            if left <= 0.0 || !st.peers.contains_key(&peer_id) || st.guests.rec.get(&id).map(|r| r.poll) != Some(mine) {
                break Vec::new();
            }
            self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
        };
        if let Some(p) = st.peers.get_mut(&peer_id) {
            p.polls -= 1;
            p.poll_end = pj::mono();
        } else if let Some(g) = st.gone.get_mut(&peer_id) {
            g.waiters -= 1;
            if g.waiters <= 0 {
                st.gone.remove(&peer_id);
            }
        }
        Ok(obj([("events", Value::Array(out))]))
    }

    /// `(who, link expiry)` when a seated guest's TURN credentials are due for renewal (issued ICE_RENEW ago), stamping
    /// the renewal; else None.
    pub fn guests_ice_due(&self, header: &str, address: &str) -> R<Option<(Identity, f64)>> {
        let mut st = self.st.lock();
        let id = st.guests_auth(header, address)?;
        let r = st.guests.rec.get_mut(&id).expect("an authenticated row");
        if r.state != "in" || pj::mono() - r.ice_at < ICE_RENEW {
            return Ok(None);
        }
        r.ice_at = pj::mono();
        Ok(Some((r.who.clone(), r.exp)))
    }

    fn guests_seat(&self, header: &str, address: &str) -> R<(String, Identity)> {
        let mut st = self.st.lock();
        let r = st.guests_live(header, address);
        drop(st);
        self.wake();
        r
    }

    pub fn guests_signal(&self, header: &str, address: &str, to: Body, data: Value) -> R<Obj> {
        let (peer, who) = self.guests_seat(header, address)?;
        self.signal(&peer, &who, &pj::str_or(to), data)?;
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// A room chat line from a guest (`guest: true`; no replies or mentions).
    pub fn guests_chat(&self, header: &str, address: &str, text: Body) -> R<Obj> {
        let text = m::text(text, "messages")?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            let (peer_id, who) = st.guests_live(header, address)?;
            st.owned(&peer_id, &who)?;
            if st.peers[peer_id.as_str()].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id.as_str()].room.clone();
            // "required": no chat while a guest is here
            st.ce_room_open(&room)?;
            let now = pj::now();
            let mut line = obj([
                ("type", Value::from("chat")),
                ("kind", Value::from("chat")),
                ("id", Value::from(pj::token_hex(6))),
                ("from", Value::from(peer_id)),
                ("name", Value::from(who.name.clone())),
                ("principal", Value::from(who.principal.clone())),
                ("org", Value::Null),
                ("guest", Value::Bool(true)),
                ("text", Value::from(text.clone())),
                ("ts", f(now)),
                ("rts", Value::from((now * 1000.0) as i64)),
                ("reactions", Value::Object(Obj::new())),
            ]);
            st.room_log(&room, &mut line);
            st.broadcast(&room, &line, None);
            Ok((line, room, who.principal))
        })();
        drop(st);
        self.wake();
        let (out, room, principal) = r?;
        log_info(&format!("chat room={room} principal={principal} chars={}", pj::char_len(&text)));
        Ok(out)
    }

    /// A guest raises or lowers its own hand, or reacts; nothing else of the stage.
    pub fn guests_act(&self, header: &str, address: &str, body: &Obj) -> R<Obj> {
        let action = body.get("action").and_then(Value::as_str).filter(|a| *a == "hand" || *a == "react");
        let Some(action) = action else { return forbidden("guests can raise a hand and react, nothing else") };
        let (peer, who) = self.guests_seat(header, address)?;
        let action = Value::from(action);
        if action == "hand" {
            return self.stage(&peer, &who, Some(&action), None, body.get("up"), None);
        }
        self.stage(&peer, &who, Some(&action), None, None, body.get("emoji"))
    }

    /// A guest answers a recording request (accept or decline), like `/v1/recording/consent`.
    pub fn guests_consent(&self, header: &str, address: &str, request: Body, accepted: Body) -> R<Obj> {
        let (peer, who) = self.guests_seat(header, address)?;
        self.recording_consent(&peer, &who, &pj::str_or(request), accepted)
    }

    pub fn guests_leave(&self, header: &str, address: &str) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            let id = st.guests_auth(header, address)?;
            let (state, peer, room) = {
                let r = &st.guests.rec[&id];
                (r.state, r.peer.clone(), r.room.clone())
            };
            if state == "in" {
                if st.peers.contains_key(&peer) {
                    st.drop_peer(&peer, "left", true, true, "");
                }
                if let Some(r) = st.guests.rec.get_mut(&id) {
                    r.state = "ended";
                    r.why = "left".into();
                    r.seen = pj::mono();
                }
            } else if state != "ended" {
                st.guests_end(&id, "left");
                if state == "waiting" {
                    st.guests_lobby_event(&room, "");
                }
            }
            Ok(())
        })();
        drop(st);
        self.wake();
        r?;
        Ok(obj([("ok", Value::Bool(true))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_count_by_ipv4_or_ipv6_prefix() {
        assert_eq!(addr_key("10.1.2.3"), "10.1.2.3");
        assert_eq!(addr_key("::ffff:10.1.2.3"), "10.1.2.3");
        assert_eq!(addr_key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
        assert_eq!(addr_key("fe80::1%3"), "fe80::/64");
        assert_eq!(addr_key(""), "-");
    }

    #[test]
    fn links_are_signed_and_checked() {
        let mut g = Guests::new(None);
        let token = g.mint("plan", (pj::now() + 60.0) as i64);
        let link = g.token(Some(&Value::from(token.clone())), pj::now()).unwrap();
        assert_eq!(link.room, "plan");
        let (part, sig) = token.split_once('.').unwrap();
        let flipped = format!("{part}.{}{}", &sig[..42], if sig.ends_with('A') { "B" } else { "A" });
        assert!(matches!(g.token(Some(&Value::from(flipped)), pj::now()), Err(E::Forbidden(m)) if m == BAD_LINK));
        let old = g.mint("plan", (pj::now() - 1.0) as i64);
        assert!(matches!(g.token(Some(&Value::from(old)), pj::now()), Err(E::Gone(m)) if m == EXPIRED));
        assert_eq!(guest_origin("https://join.example.com/"), Some("https://join.example.com".into()));
        assert!(guest_origin("http://x").is_none() && guest_origin("https://x/p").is_none());
        assert_eq!(guest_id("guest-0123456789abcdef@guest.invalid"), "0123456789abcdef");
    }

    #[test]
    fn the_rate_limit_answers_429_with_a_retry() {
        let mut g = Guests::new(None);
        for _ in 0..3 {
            g.limit("knock", "a", 3, BUSY).unwrap();
        }
        assert!(matches!(g.check("knock", "a", 3, BUSY), Err(E::Busy(_, retry)) if (1..=61).contains(&retry)));
        assert!(g.check("knock", "b", 3, BUSY).is_ok());
    }
}
