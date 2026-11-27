// PH-1 (docs/phone/contract.md): Lucid Meeting Hub as a phone, through LiveKit SIP beside the media server (no
// REGISTER: the org's PBX, SBC or SIP provider trunks to it). A person's line (a DID in relay.json `phone.lines`) rings
// their phone-capable apps: LiveKit SIP puts the caller in a `lucid-phone_*` room, its webhook tells the relay, and the
// relay opens a `ph-` room on the media server and invites the person with the NT-1 ring, settle and push, gated on the
// `phone` cap. A person calls a number through `livekit.SIP/CreateSIPParticipant`, and a meeting that allows phone
// callers gets a PIN and, while its stay runs, a dispatch rule on the conference trunk. A phone stay is never
// end-to-end encrypted (a phone caller holds no call key). The webhooks arrive on a TLS listener of their own
// (`webhook_listen`, no client certificate, from `webhook_from` only), each an HS256 JWT over the body's SHA-256 with
// the media server's API secret. Nothing of a call is kept: a relay restart drops calls in progress. A child module of
// meet_hub: it shares the one lock.

use super::*;
use crate::console_source::{parse_cidr, Cidr};
use crate::meet::{address_of, http_date, quiet_end, read_head, reason_phrase, Head, Settings, Tls, SERVER_VERSION};
use crate::meet_tls::RefusalLog;
use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;

/// LiveKit rooms of personal calls: the operator's dispatch rule (`roomPrefix: "lucid-phone"`) names a caller's
/// `lucid-phone_<...>`, and a call a person places gets `lucid-phone_out_<12 hex>`.
pub(super) const LK_PREFIX: &str = "lucid-phone_";
/// The dispatch rules this relay makes on the conference trunk: `lucid-meeting-<room>`.
const RULE_PREFIX: &str = "lucid-meeting-";
/// LiveKit SIP may open a personal call's room a moment before its webhook arrives: the sync leaves a room this young.
const ROOM_GRACE: f64 = 60.0;
/// Phone calls (ringing or answered) per person, phone participants per stay.
const PER_PERSON: usize = 4;
const PER_STAY: usize = 4;
/// A PIN given up is not given again for this long.
const PIN_KEEP: f64 = 30.0 * 86400.0;
const PERSONAL: &str = "personal";
const MEETING: &str = "meeting";
const RINGING: &str = "ringing";
const CONNECTED: &str = "connected";
/// `ph-` + 10 of these (ROOM_RE allows them).
const ROOM_CHARS: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
// the webhook listener (section 4)
const WEBHOOK_PATH: &str = "/v1/sfu/webhook";
const WEBHOOK_BODY_MAX: usize = 64 * 1024;
/// nbf and exp are checked with this leeway (seconds); an event id is refused again for REPLAY_WINDOW.
const LEEWAY: f64 = 60.0;
const REPLAY_WINDOW: f64 = 600.0;
/// A connection's handshake, request and answer each get this long; at most CONNECTIONS_MAX at once.
const WEBHOOK_TIMEOUT: f64 = 10.0;
const CONNECTIONS_MAX: usize = 64;

pub(super) const NEEDS_UPDATE: &str = "this call has a phone caller; update Lucid to join it";
pub(super) const NOT_YOURS: &str = "this phone call is for someone else";
pub(super) const ENDED: &str = "this phone call has ended";
pub(super) const NO_LINE: &str = "you have no phone number";
pub(super) const NO_OUTBOUND: &str = "calling phone numbers is not set up on this relay";
pub(super) const NO_CONFERENCE: &str = "phone callers are not set up on this relay";
pub(super) const BAD_TO: &str = "to must be a phone number in E.164 form (+ and 7 to 15 digits)";
pub(super) const BAD_PHONE: &str = "phone must be true or false";
const BAD_ROOM: &str = "room must name the phone call to add the number to";
pub(super) const NOT_SEATED: &str = "you are not in that phone call";
pub(super) const TOO_MANY_MINE: &str = "you already have 4 phone calls";
pub(super) const TOO_MANY_HERE: &str = "this call already has 4 phone callers";
pub(super) const NOT_PLACED: &str = "the phone call could not be placed";
const UNKNOWN: &str = "unknown path";
pub(super) const NOT_SIGNED: &str = "the webhook is not signed by the media server";
pub(super) const WRONG_ISSUER: &str = "the webhook names another API key";
pub(super) const OUT_OF_TIME: &str = "the webhook's token is not valid now";
pub(super) const BAD_HASH: &str = "the webhook body does not match its signature";
pub(super) const TOO_BIG: &str = "the webhook body is larger than 64 KiB";
pub(super) const REPLAYED: &str = "this webhook was already received";
const NO_LENGTH: &str = "the webhook needs a Content-Length";
const BAD_EVENT: &str = "the webhook body must be a JSON object with its event id";
// relay.json `phone` (section 2)
const SHAPE: &str = "relay settings: phone must be {webhook_listen, webhook_from, lines, outbound_trunk, conference}";
const FIELDS: [&str; 5] = ["webhook_listen", "webhook_from", "lines", "outbound_trunk", "conference"];
const LISTEN: &str = "relay settings: phone.webhook_listen must be host:port (where the media server's webhooks arrive)";
const FROM: &str = "relay settings: phone.webhook_from must list the media servers' address ranges (CIDR)";
const LINES: &str = "relay settings: phone.lines must map phone numbers (E.164, like +19415550100) to people's email addresses";
const OUTBOUND: &str = "relay settings: phone.outbound_trunk must name a LiveKit outbound trunk";
const CONFERENCE: &str = "relay settings: phone.conference must be {numbers, trunk}";
const NUMBERS: &str = "relay settings: phone.conference.numbers must list at least one phone number (E.164)";
const TRUNK: &str = "relay settings: phone.conference.trunk must name the LiveKit inbound trunk of the conference numbers";
pub(super) const NEEDS_SFU: &str = "relay settings: phone needs the media server (sfu_url, sfu_api_key, sfu_secret_file)";

/// relay.json `phone`, read and checked once at start.
pub struct Cfg {
    host: String,
    port: u16,
    from: Vec<Cidr>,
    /// (number, principal), one line per person.
    lines: Vec<(String, String)>,
    /// The LiveKit outbound trunk ("" = no calls out).
    outbound: String,
    /// The conference numbers and their LiveKit inbound trunk ("" = no conference number).
    numbers: Vec<String>,
    trunk: String,
}

impl Cfg {
    fn line_of(&self, principal: &str) -> Option<&str> {
        self.lines.iter().find(|(_, p)| p == principal).map(|(n, _)| n.as_str())
    }

    fn owner_of(&self, number: &str) -> Option<&str> {
        self.lines.iter().find(|(n, _)| n == number).map(|(_, p)| p.as_str())
    }

    fn conference(&self) -> bool {
        !self.trunk.is_empty()
    }
}

/// One phone participant of a stay (the contract's phone record).
#[derive(Clone)]
struct Caller {
    /// Its LiveKit identity (`sip_<number>` in, `sip_out_<8 hex>` out).
    identity: String,
    number: String,
    /// The caller's name when the trunk gave one ("" otherwise).
    name: String,
    /// "in" or "out".
    kind: &'static str,
    /// "ringing" or "connected".
    state: &'static str,
    /// The line it came to or goes out from ("" for a conference caller).
    line: String,
    /// Whose phone call it is ("" for a conference caller).
    owner: String,
    /// The invite that rings for it (an inbound personal call), and whether it was answered.
    invite: String,
    answered: bool,
}

impl Caller {
    fn view(&self) -> Value {
        Value::Object(obj([
            ("identity", Value::from(self.identity.clone())),
            ("number", Value::from(self.number.clone())),
            ("name", Value::from(self.name.clone())),
            ("kind", Value::from(self.kind)),
            ("state", Value::from(self.state)),
        ]))
    }
}

/// A meeting stay's dispatch rule, made on its own thread: its id once LiveKit answered, and whether the stay already
/// ended (then the rule is deleted as soon as it exists).
#[derive(Default)]
struct Rule {
    id: String,
    ended: bool,
}

/// A phone stay: a personal call (a `ph-` room, from its caller's webhook or the call a person places, until it ends)
/// or a meeting's stay that allows phone callers (from its first join until it is empty).
struct PhoneStay {
    kind: &'static str,
    lk_room: String,
    /// A personal call's person ("" for a meeting).
    owner: String,
    callers: Vec<Caller>,
    rule: Option<Arc<Mutex<Rule>>>,
}

impl PhoneStay {
    fn callers_view(&self) -> Value {
        Value::Array(self.callers.iter().map(Caller::view).collect())
    }
}

/// In memory: the settings, the sessions whose hello listed `phone`, the phone stays by relay room, the webhook ids
/// seen in the last REPLAY_WINDOW (monotonic) and the dispatch rule ids this relay owns.
#[derive(Default)]
pub(super) struct Phone {
    cfg: Option<Arc<Cfg>>,
    sessions: HashSet<String>,
    stays: HashMap<String, PhoneStay>,
    seen: HashMap<String, f64>,
    owned: Arc<Mutex<HashSet<String>>>,
}

/// An E.164 number: `+`, a first digit 1 to 9, 7 to 15 digits in all.
pub(super) fn e164(text: &str) -> bool {
    let Some(digits) = text.strip_prefix('+') else { return false };
    (7..=15).contains(&digits.len()) && digits.bytes().all(|c| c.is_ascii_digit()) && !digits.starts_with('0')
}

/// A personal call's room: `ph-` and 10 of `[a-z2-7]`.
fn ph_room(room: &str) -> bool {
    room.len() == 13 && room.starts_with("ph-") && room.as_bytes()[3..].iter().all(|c| ROOM_CHARS.contains(c))
}

fn new_room() -> String {
    let mut out = String::from("ph-");
    for b in pj::random_bytes(10) {
        out.push(ROOM_CHARS[usize::from(b & 31)] as char);
    }
    out
}

/// Six random digits.
fn new_pin() -> String {
    let b = pj::random_bytes(4);
    format!("{:06}", u32::from_be_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000)
}

/// A push row registered with `phone: true` (section 5.4): it rings for phone calls.
pub(super) fn row_rings(row: &Obj) -> bool {
    row.get("phone") == Some(&Value::Bool(true))
}

/// A meeting's `phone` (create and update): absent or null leaves it, true or false sets it; 400 otherwise.
pub(super) fn flag(v: Body) -> R<Option<bool>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => bad(BAD_PHONE),
    }
}

/// LiveKit's participant `kind` SIP (as its name or its number).
fn sip_kind(p: &Obj) -> bool {
    p.get("kind") == Some(&Value::from("SIP")) || pj::as_int(p.get("kind")) == Some(3)
}

fn status_of(status: Option<u16>) -> String {
    status.map(|s| s.to_string()).unwrap_or_else(|| "failed".into())
}

/// `host:port` of `webhook_listen` (an IPv6 host in brackets).
fn listen_parts(text: &str) -> Option<(String, u16)> {
    let (host, port) = text.rsplit_once(':')?;
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    let port = port.parse::<u16>().ok().filter(|p| *p > 0)?;
    (!host.is_empty() && !host.contains(char::is_whitespace)).then(|| (host.to_string(), port))
}

/// relay.json `phone` (section 2): its five fields only, each checked; Err names the field.
fn parse(v: &Value) -> Result<Cfg, String> {
    let Value::Object(o) = v else { return Err(SHAPE.into()) };
    if o.keys().any(|k| !FIELDS.contains(&k.as_str())) {
        return Err(SHAPE.into());
    }
    let (host, port) = o.get("webhook_listen").and_then(Value::as_str).and_then(|t| listen_parts(t.trim())).ok_or_else(|| LISTEN.to_string())?;
    let mut from = Vec::new();
    match o.get("webhook_from") {
        Some(Value::Array(a)) if !a.is_empty() => {
            for c in a {
                from.push(c.as_str().and_then(|c| parse_cidr(c).ok()).ok_or_else(|| FROM.to_string())?);
            }
        }
        _ => return Err(FROM.into()),
    }
    let mut lines: Vec<(String, String)> = Vec::new();
    match o.get("lines") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (number, who) in map {
                let principal = who.as_str().map(|p| p.trim().to_lowercase()).unwrap_or_default();
                if !e164(number) || !principal.contains('@') || principal.contains(char::is_whitespace) {
                    return Err(LINES.into());
                }
                if lines.iter().any(|(_, p)| *p == principal) {
                    return Err(format!("relay settings: phone.lines gives {principal} more than one number"));
                }
                lines.push((number.clone(), principal));
            }
        }
        Some(_) => return Err(LINES.into()),
    }
    let outbound = match o.get("outbound_trunk") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(t)) if !t.trim().is_empty() && pj::printable(t) => t.trim().to_string(),
        Some(_) => return Err(OUTBOUND.into()),
    };
    let (numbers, trunk) = match o.get("conference") {
        None | Some(Value::Null) => (Vec::new(), String::new()),
        Some(Value::Object(c)) if c.len() == 2 => {
            let numbers: Vec<String> = match c.get("numbers") {
                Some(Value::Array(a)) if !a.is_empty() && a.iter().all(|n| n.as_str().is_some_and(e164)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                _ => return Err(NUMBERS.into()),
            };
            let trunk = match c.get("trunk") {
                Some(Value::String(t)) if !t.trim().is_empty() && pj::printable(t) => t.trim().to_string(),
                _ => return Err(TRUNK.into()),
            };
            (numbers, trunk)
        }
        Some(_) => return Err(CONFERENCE.into()),
    };
    Ok(Cfg { host, port, from, lines, outbound, numbers, trunk })
}

/// The id of a dispatch rule LiveKit answered (protojson's proto name or its camel case).
fn rule_id(o: &Obj) -> String {
    let id = pj::text_of(o, "sip_dispatch_rule_id");
    if id.is_empty() {
        pj::text_of(o, "sipDispatchRuleId")
    } else {
        id
    }
}

fn delete_rule(sfu: &sfu::Cfg, id: &str, why: &str) {
    let (status, _) = sfu::sip_call(sfu, "DeleteSIPDispatchRule", &obj([("sip_dispatch_rule_id", Value::from(id))]), None);
    log_info(&format!("phone rule delete id={id} why={why} status={}", status_of(status)));
}

/// At start (section 6): every `lucid-meeting-*` dispatch rule this relay does not own goes (it restarted, or a delete
/// was missed).
fn sweep_rules(sfu: &sfu::Cfg, owned: &Mutex<HashSet<String>>) {
    let (status, answer) = sfu::sip_call(sfu, "ListSIPDispatchRule", &Obj::new(), None);
    if status != Some(200) {
        log_warn(&format!("phone rules not listed status={}", status_of(status)));
        return;
    }
    let items: Vec<Obj> = answer.as_ref().and_then(|a| a.get("items")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).cloned().collect();
    for rule in items {
        let id = rule_id(&rule);
        if pj::text_of(&rule, "name").starts_with(RULE_PREFIX) && !id.is_empty() && !owned.lock().contains(&id) {
            delete_rule(sfu, &id, "unowned");
        }
    }
}

/// A meeting stay's dispatch rule (its own thread): `dispatchRuleDirect {roomName, pin}` on the conference trunk,
/// named `lucid-meeting-<room>` (CreateSIPDispatchRuleRequest `dispatch_rule`, a SIPDispatchRuleInfo); deleted at
/// once when the stay ended meanwhile.
fn create_rule(sfu: &sfu::Cfg, trunk: &str, room: &str, lk_room: &str, pin: &str, cell: &Mutex<Rule>, owned: &Mutex<HashSet<String>>) {
    let direct = obj([("roomName", Value::from(lk_room)), ("pin", Value::from(pin))]);
    let info = obj([
        ("name", Value::from(format!("{RULE_PREFIX}{room}"))),
        ("trunk_ids", Value::from(vec![trunk.to_string()])),
        ("rule", Value::Object(obj([("dispatchRuleDirect", Value::Object(direct))]))),
    ]);
    let body = obj([("dispatch_rule", Value::Object(info))]);
    let (status, answer) = sfu::sip_call(sfu, "CreateSIPDispatchRule", &body, None);
    let id = answer.as_ref().map(rule_id).unwrap_or_default();
    log_info(&format!("phone rule create room={room} id={} status={}", kv(&id), status_of(status)));
    if status != Some(200) || id.is_empty() {
        return;
    }
    owned.lock().insert(id.clone());
    let mut rule = cell.lock();
    if rule.ended {
        drop(rule);
        owned.lock().remove(&id);
        delete_rule(sfu, &id, "ended");
    } else {
        rule.id = id;
    }
}

fn refused(why: &'static str) -> Result<(), (u16, &'static str)> {
    Err((401, why))
}

/// Section 4: the webhook's `Authorization` JWT: HS256 signed with the media server's API secret, `iss` its API key,
/// `nbf` and `exp` with LEEWAY, and `sha256` the standard base64 of the body's SHA-256. Err: (401, why).
pub(super) fn verify(token: &str, body: &[u8], key: &str, secret: &[u8], now: f64) -> Result<(), (u16, &'static str)> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return refused(NOT_SIGNED);
    }
    let header = crate::codec::unb64u(parts[0]).and_then(|h| serde_json::from_slice::<Value>(&h).ok());
    if header.as_ref().and_then(|h| h.get("alg")).and_then(Value::as_str) != Some("HS256") {
        return refused(NOT_SIGNED);
    }
    let Some(signature) = crate::codec::unb64u(parts[2]) else { return refused(NOT_SIGNED) };
    let mac = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    if aws_lc_rs::hmac::verify(&mac, format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).is_err() {
        return refused(NOT_SIGNED);
    }
    let Some(Value::Object(claims)) = crate::codec::unb64u(parts[1]).and_then(|c| serde_json::from_slice::<Value>(&c).ok()) else { return refused(NOT_SIGNED) };
    if claims.get("iss").and_then(Value::as_str) != Some(key) {
        return refused(WRONG_ISSUER);
    }
    match pj::as_num(claims.get("exp")) {
        Some(exp) if now <= exp + LEEWAY => {}
        _ => return refused(OUT_OF_TIME),
    }
    if pj::as_num(claims.get("nbf")).is_some_and(|nbf| now + LEEWAY < nbf) {
        return refused(OUT_OF_TIME);
    }
    let hash = pj::b64(&crate::codec::sha256(body));
    if claims.get("sha256").and_then(Value::as_str) != Some(hash.as_str()) {
        return refused(BAD_HASH);
    }
    Ok(())
}

impl State {
    /// _phone_configure: relay.json `phone`, once at start (after the media server's settings, which it needs).
    pub(super) fn phone_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        if s.phone.is_null() {
            self.ph.cfg = None;
            return Ok(());
        }
        let cfg = parse(&s.phone)?;
        let Some(sfu) = self.sfu_cfg() else { return Err(NEEDS_SFU.into()) };
        for (number, principal) in &cfg.lines {
            if !self.directory.contains_key(principal) {
                log_info(&format!("phone line={number} principal={principal} unknown (it rings once they sign in)"));
            }
        }
        let yes = |b: bool| if b { "yes" } else { "no" };
        log_info(&format!("phone configured webhook={}:{} lines={} outbound={} conference={}", cfg.host, cfg.port, cfg.lines.len(), yes(!cfg.outbound.is_empty()), yes(cfg.conference())));
        if cfg.conference() {
            let owned = self.ph.owned.clone();
            sfu::spawn("phone-rules", move || sweep_rules(&sfu, &owned));
        }
        self.ph.cfg = Some(Arc::new(cfg));
        Ok(())
    }

    /// The phone stay `room` is or would start as ("personal" or "meeting"), None when it is none (or phone is off):
    /// a live phone stay decides; a stay running already stays as it began; a new stay of a meeting that allows phone
    /// callers is a meeting phone stay.
    pub(super) fn phone_kind(&self, room: &str) -> Option<&'static str> {
        self.ph.cfg.as_ref()?;
        if let Some(stay) = self.ph.stays.get(room) {
            return Some(stay.kind);
        }
        if self.stays.contains_key(room) {
            return None;
        }
        self.phone_meeting_on(room).then_some(MEETING)
    }

    /// The stay starting now in `room` (already in `stays`, so `phone_kind` no longer sees it as new) is a phone
    /// stay: a personal call waiting for its owner, or a meeting that allows phone callers.
    pub(super) fn phone_starts(&self, room: &str) -> bool {
        self.ph.cfg.is_some() && (self.ph.stays.contains_key(room) || self.phone_meeting_on(room))
    }

    /// The meeting in `room` allows phone callers (it has a PIN, it is not canceled, the relay has a conference number).
    fn phone_meeting_on(&self, room: &str) -> bool {
        self.ph.cfg.as_ref().is_some_and(|c| c.conference()) && as_obj(self.meetings.get(room)).is_some_and(|m| !pj::truthy(m.get("canceled")) && !pj::text_of(m, "phone_pin").is_empty())
    }

    /// `room`'s current stay is a phone stay.
    pub(super) fn phone_stay(&self, room: &str) -> bool {
        self.ph.stays.contains_key(room)
    }

    /// `room` is a personal phone call (microphone only, never a screen).
    pub(super) fn phone_personal(&self, room: &str) -> bool {
        self.ph.stays.get(room).is_some_and(|s| s.kind == PERSONAL)
    }

    /// A personal call's LiveKit room (its stay starts in it).
    pub(super) fn phone_lk_room(&self, room: &str) -> Option<String> {
        self.ph.stays.get(room).map(|s| s.lk_room.clone())
    }

    /// The SFU sync may delete this `lucid-phone_*` room: phone is on, no phone stay holds it, and it is ROOM_GRACE old.
    pub(super) fn phone_room_unheld(&self, lk_room: &str, created: f64) -> bool {
        self.ph.cfg.is_some() && !self.ph.stays.values().any(|s| s.lk_room == lk_room) && pj::now() - created >= ROOM_GRACE
    }

    /// The SFU sync keeps this participant of `room`'s stay: a phone participant (LiveKit kind SIP, or one of its
    /// callers) of a live phone stay.
    pub(super) fn phone_keeps(&self, room: &str, identity: &str, sip: bool) -> bool {
        self.ph.stays.get(room).is_some_and(|s| sip || s.callers.iter().any(|c| c.identity == identity))
    }

    /// _phone_may_join (sfu_may_join, before anything changes): None when `room` is no phone matter. A `ph-` room
    /// without its phone stay has ended (410); guests and web seats cannot take a phone stay (409); a personal call
    /// is its owner's (403); the join must list the `phone` cap (409).
    pub(super) fn phone_may_join(&self, room: &str, who: &Identity, ext: &Obj) -> Option<R<()>> {
        self.ph.cfg.as_ref()?;
        let Some(kind) = self.phone_kind(room) else {
            return ph_room(room).then(|| Err(E::Gone(ENDED.into())));
        };
        if who.guest || who.kind == "web" {
            return Some(Err(E::Conflict(NEEDS_UPDATE.into())));
        }
        if kind == PERSONAL && self.ph.stays.get(room).is_some_and(|s| s.owner != who.principal) {
            return Some(forbidden(NOT_YOURS));
        }
        let caps = match wa::caps(ext) {
            Ok((caps, _)) => caps,
            Err(e) => return Some(Err(e)),
        };
        if !caps.is_some_and(|c| c.iter().any(|x| x == "phone")) {
            return Some(Err(E::Conflict(NEEDS_UPDATE.into())));
        }
        Some(Ok(()))
    }

    /// _phone_stay_created (sfu_stay_created): a personal call's stay starts in its caller's room; a meeting that
    /// allows phone callers starts a meeting phone stay and its dispatch rule.
    pub(super) fn phone_stay_created(&mut self, room: &str, lk_room: &str) {
        if let Some(stay) = self.ph.stays.get(room) {
            log_info(&format!("phone stay room={room} kind={} sfu_room={lk_room}", stay.kind));
            return;
        }
        if !self.phone_meeting_on(room) {
            return;
        }
        let pin = as_obj(self.meetings.get(room)).map(|m| pj::text_of(m, "phone_pin")).unwrap_or_default();
        let cell = Arc::new(Mutex::new(Rule::default()));
        self.ph.stays.insert(room.to_string(), PhoneStay { kind: MEETING, lk_room: lk_room.to_string(), owner: String::new(), callers: Vec::new(), rule: Some(cell.clone()) });
        log_info(&format!("phone stay room={room} kind={MEETING} sfu_room={lk_room}"));
        let (Some(cfg), Some(sfu)) = (self.ph.cfg.clone(), self.sfu_cfg()) else { return };
        let owned = self.ph.owned.clone();
        let (room, lk_room) = (room.to_string(), lk_room.to_string());
        sfu::spawn("phone-rule", move || create_rule(&sfu, &cfg.trunk, &room, &lk_room, &pin, &cell, &owned));
    }

    /// _phone_join_extra (sfu_join_extra): `{kind, callers}` of a phone stay.
    pub(super) fn phone_join_extra(&self, room: &str) -> Option<Obj> {
        let stay = self.ph.stays.get(room)?;
        Some(obj([("kind", Value::from(stay.kind)), ("callers", stay.callers_view())]))
    }

    /// _phone_room_empty (wave3_room_empty): the stay is over (its LiveKit room was deleted with it, so a personal
    /// call's caller hears the call end); a meeting's dispatch rule goes.
    pub(super) fn phone_room_empty(&mut self, room: &str) {
        let Some(stay) = self.ph.stays.remove(room) else { return };
        log_info(&format!("phone stay over room={room} kind={} callers={}", stay.kind, stay.callers.len()));
        let Some(cell) = stay.rule else { return };
        let id = {
            let mut rule = cell.lock();
            rule.ended = true;
            std::mem::take(&mut rule.id)
        };
        let Some(sfu) = self.sfu_cfg().filter(|_| !id.is_empty()) else { return };
        let owned = self.ph.owned.clone();
        sfu::spawn("phone-rule", move || {
            owned.lock().remove(&id);
            delete_rule(&sfu, &id, "ended");
        });
    }

    /// _phone_prune: sessions that ended, and the PIN book: a PIN a meeting holds is fresh, one given up 30 days ago
    /// may be given again.
    pub(super) fn phone_prune(&mut self, now: f64) {
        let live: HashSet<String> = self.sessions.keys().cloned().collect();
        self.ph.sessions.retain(|s| live.contains(s));
        let held: Vec<String> = self.meetings.values().filter_map(Value::as_object).map(|m| pj::text_of(m, "phone_pin")).filter(|p| !p.is_empty()).collect();
        if held.is_empty() && !self.ext.contains_key("phone") {
            return;
        }
        let book = obj_mut(obj_mut(&mut self.ext, "phone"), "pins");
        for pin in held {
            book.insert(pin, f(now));
        }
        book.retain(|_, t| pj::as_num(Some(&*t)).is_some_and(|t| now - t < PIN_KEEP));
    }

    /// The person's phone calls (ringing or answered, in and out).
    fn phone_count(&self, principal: &str) -> usize {
        self.ph.stays.values().flat_map(|s| &s.callers).filter(|c| c.owner == principal).count()
    }

    fn phone_room_of(&self, lk_room: &str) -> Option<String> {
        self.ph.stays.iter().find(|(_, s)| s.lk_room == lk_room).map(|(r, _)| r.clone())
    }

    /// Section 7: every seat of the stay hears `phone {room, callers}`.
    fn phone_tell(&mut self, room: &str) {
        let Some(callers) = self.ph.stays.get(room).map(PhoneStay::callers_view) else { return };
        let event = obj([("type", Value::from("phone")), ("room", Value::from(room)), ("callers", callers)]);
        self.broadcast(room, &event, None);
    }

    /// Ask the media server to remove a phone participant (its call ends), on its own thread.
    fn phone_remove(&self, lk_room: &str, identity: &str, why: &str) {
        let Some(sfu) = self.sfu_cfg() else { return };
        let (lk, who, why) = (lk_room.to_string(), identity.to_string(), why.to_string());
        sfu::spawn("phone-remove", move || sfu::remove_now(&sfu, &lk, &who, &why));
    }

    /// A webhook event (checked, not a replay): the SIP participants' joins and departures; anything else is ignored.
    fn phone_event(&mut self, event: &Obj) {
        let Some(p) = as_obj(event.get("participant")).filter(|p| sip_kind(p)) else { return };
        let lk_room = as_obj(event.get("room")).map(|r| pj::text_of(r, "name")).unwrap_or_default();
        let identity = pj::text_of(p, "identity");
        if lk_room.is_empty() || identity.is_empty() {
            return;
        }
        match pj::text_of(event, "event").as_str() {
            "participant_joined" => self.phone_joined(&lk_room, &identity, p),
            "participant_left" => self.phone_left(&lk_room, &identity),
            _ => {}
        }
    }

    /// `participant_joined` of a SIP participant: one of a phone stay's (its call connected, or a conference caller
    /// that typed the PIN), or a call to a personal line (section 5.1).
    fn phone_joined(&mut self, lk_room: &str, identity: &str, p: &Obj) {
        let attrs = as_obj(p.get("attributes")).cloned().unwrap_or_default();
        let (number, line) = (pj::text_of(&attrs, "sip.phoneNumber"), pj::text_of(&attrs, "sip.trunkPhoneNumber"));
        let shown = pj::clip(&pj::squash(&pj::text_of(p, "name")), 100);
        let name = if shown == format!("Phone {number}") { String::new() } else { shown };
        if let Some(room) = self.phone_room_of(lk_room) {
            let Some(stay) = self.ph.stays.get_mut(&room) else { return };
            match stay.callers.iter_mut().find(|c| c.identity == identity) {
                Some(c) => c.state = CONNECTED,
                None => {
                    let owner = if stay.kind == PERSONAL { stay.owner.clone() } else { String::new() };
                    stay.callers.push(Caller { identity: identity.to_string(), number, name, kind: "in", state: CONNECTED, line, owner, invite: String::new(), answered: true });
                }
            }
            log_info(&format!("phone joined room={room} identity={identity}"));
            self.phone_tell(&room);
            return;
        }
        if lk_room.starts_with(LK_PREFIX) {
            self.phone_inbound(lk_room, identity, number, name, line);
        }
    }

    /// Section 5.1: a call to a personal line opens a `ph-` phone stay and rings the line's person; a line nobody
    /// holds, a person the directory does not know, or one with PER_PERSON calls already, ends the call.
    fn phone_inbound(&mut self, lk_room: &str, identity: &str, number: String, name: String, line: String) {
        let Some(cfg) = self.ph.cfg.clone() else { return };
        let owner = cfg.owner_of(&line).unwrap_or_default().to_string();
        let why = if owner.is_empty() {
            "no_line"
        } else if !self.directory.contains_key(&owner) {
            "unknown"
        } else if self.phone_count(&owner) >= PER_PERSON {
            "busy"
        } else {
            ""
        };
        if !why.is_empty() {
            log_info(&format!("phone refused why={why} line={}", kv(&line)));
            self.phone_remove(lk_room, identity, &format!("refused_{why}"));
            return;
        }
        let mut room = new_room();
        while self.ph.stays.contains_key(&room) || self.stays.contains_key(&room) || self.rooms.contains_key(&room) {
            room = new_room();
        }
        let caller = Caller { identity: identity.to_string(), number: number.clone(), name: name.clone(), kind: "in", state: CONNECTED, line: line.clone(), owner: owner.clone(), invite: String::new(), answered: false };
        self.ph.stays.insert(room.clone(), PhoneStay { kind: PERSONAL, lk_room: lk_room.to_string(), owner: owner.clone(), callers: vec![caller], rule: None });
        log_info(&format!("phone in room={room} sfu_room={lk_room} line={line} principal={owner}"));
        self.phone_ring(&room, &owner, &number, &name, &line);
    }

    /// Section 5.1: the invite of a call to `owner`'s line: `kind: "call"`, `from: "phone:<number>"` and `phone`, to
    /// the sessions whose hello listed `phone` and the push rows registered with `phone: true`. With neither, Do not
    /// disturb or a call level `off`, it settles `missed` at once (the caller's call ends).
    fn phone_ring(&mut self, room: &str, owner: &str, number: &str, name: &str, line: &str) {
        let now = self.nt_now();
        let id = pj::token_hex(8);
        let from = format!("phone:{number}");
        let phone = obj([("kind", Value::from("in")), ("number", Value::from(number)), ("name", Value::from(name)), ("line", Value::from(line))]);
        let inv = obj([
            ("id", Value::from(id.clone())),
            ("from", Value::from(from.clone())),
            ("from_name", Value::from(if name.is_empty() { number } else { name })),
            ("to", Value::from(owner)),
            ("room", Value::from(room)),
            ("ts", f(now)),
            ("host", Value::Null),
            ("kind", Value::from("call")),
            ("ring", Value::Bool(true)),
            ("phone", Value::Object(phone)),
        ]);
        if let Some(c) = self.ph.stays.get_mut(room).and_then(|s| s.callers.first_mut()) {
            c.invite = id.clone();
        }
        let mut pending = self.invites.get(owner).cloned().unwrap_or_default();
        pending.push(inv.clone());
        self.invites.insert(owner.to_string(), pending);
        self.dirty = true;
        let capable: Vec<String> = self.sessions.values().filter(|s| s.who.principal == owner && self.ph.sessions.contains(&s.session_id)).map(|s| s.session_id.clone()).collect();
        let rows = self.pu_on() && as_obj(self.push_tokens.get(owner)).is_some_and(|d| d.values().filter_map(Value::as_object).any(row_rings));
        let held = self.pu_dnd(owner) || self.nt_call_level(&from, owner, room) == "off";
        if held || (capable.is_empty() && !rows) {
            log_info(&format!("phone missed room={room} principal={owner} why={}", if held { "held" } else { "no_device" }));
            self.nt_settle(owner, &id, "missed", "", now);
            return;
        }
        let shown = with(&inv, obj([("ring_ms_left", Value::from((push::RING_SECONDS * 1000.0) as i64))]));
        let event = with(&shown, obj([("type", Value::from("invite"))]));
        for s in self.sessions.values_mut().filter(|s| capable.contains(&s.session_id)) {
            push(&mut s.seq, &mut s.events, &event);
        }
        self.nt_call(&inv, 0);
        log_info(&format!("phone ring room={room} principal={owner} sessions={} push={}", capable.len(), if rows { "yes" } else { "no" }));
    }

    /// `participant_left` of a SIP participant: its record ends. Hanging up while it rings settles the invite
    /// `cancelled`; a personal call whose last phone participant left ends (section 7).
    fn phone_left(&mut self, lk_room: &str, identity: &str) {
        let Some(room) = self.phone_room_of(lk_room) else { return };
        let Some(stay) = self.ph.stays.get_mut(&room) else { return };
        let Some(i) = stay.callers.iter().position(|c| c.identity == identity) else { return };
        let caller = stay.callers.remove(i);
        let (kind, empty) = (stay.kind, stay.callers.is_empty());
        log_info(&format!("phone left room={room} identity={identity}"));
        let ringing = !caller.answered && self.invites.get(&caller.owner).into_iter().flatten().any(|inv| pj::text_of(inv, "id") == caller.invite && inv.get("settled").is_none());
        if ringing {
            let now = self.nt_now();
            self.nt_settle(&caller.owner, &caller.invite, "cancelled", "", now);
        }
        if kind == PERSONAL && empty {
            self.phone_hangup(&room);
        } else {
            self.phone_tell(&room);
        }
    }

    /// Section 7: the last phone participant of a personal call left: its seats hear `phone` with no callers, then
    /// `ended` (`why: "phone_hangup"`), and are dropped (the last one ends the stay and deletes its LiveKit room).
    fn phone_hangup(&mut self, room: &str) {
        let seats: Vec<String> = self.peers.values().filter(|p| p.room == room).map(|p| p.peer_id.clone()).collect();
        if !seats.is_empty() {
            self.phone_tell(room);
            let ended = obj([("type", Value::from("ended")), ("room", Value::from(room)), ("why", Value::from("phone_hangup"))]);
            for id in &seats {
                self.push_peer(id, &ended);
            }
            for id in &seats {
                // its next poll still hears `ended` after the seat is gone (like a host's `removed`)
                if let Some(p) = self.peers.get(id.as_str()) {
                    let moved = super::Moved { principal: p.who.principal.clone(), event: p.events.back().cloned().unwrap_or_default(), at: pj::mono() };
                    self.moved.insert(id.clone(), moved);
                }
                self.drop_peer(id, "phone_hangup", true, true, "");
            }
        }
        self.ph.stays.remove(room);
        log_info(&format!("phone ended room={room} why=phone_hangup seats={}", seats.len()));
    }

    /// nt_settle of a phone call's invite (section 5.1): answered marks the call answered; declined and missed remove
    /// the caller from the media server (the caller hears the call end), and the stay goes when nobody is in it.
    pub(super) fn phone_settled(&mut self, room: &str, id: &str, how: &str) {
        let Some(stay) = self.ph.stays.get_mut(room) else { return };
        let Some(i) = stay.callers.iter().position(|c| c.invite == id) else { return };
        match how {
            "answered" => stay.callers[i].answered = true,
            "declined" | "missed" => {
                let caller = stay.callers.remove(i);
                let (lk_room, empty) = (stay.lk_room.clone(), stay.callers.is_empty());
                self.phone_remove(&lk_room, &caller.identity, how);
                log_info(&format!("phone {how} room={room} line={}", kv(&caller.line)));
                if empty && !self.peers.values().any(|p| p.room == room) {
                    self.ph.stays.remove(room);
                } else {
                    self.phone_tell(room);
                }
            }
            _ => {}
        }
    }

    /// A meeting's `phone` (create and update, section 6): true gives it a PIN (409 without a conference number),
    /// false takes it away; None leaves it.
    pub(super) fn phone_meeting_set(&mut self, m: &mut Obj, on: Option<bool>) -> R<()> {
        let now = pj::now();
        match on {
            None => {}
            Some(true) => {
                if !self.ph.cfg.as_ref().is_some_and(|c| c.conference()) {
                    return Err(E::Conflict(NO_CONFERENCE.into()));
                }
                if pj::text_of(m, "phone_pin").is_empty() {
                    let pin = self.phone_new_pin(now);
                    m.insert("phone_pin".into(), Value::from(pin));
                }
            }
            Some(false) => {
                if let Some(Value::String(pin)) = m.shift_remove("phone_pin") {
                    obj_mut(obj_mut(&mut self.ext, "phone"), "pins").insert(pin, f(now));
                    self.dirty = true;
                }
            }
        }
        Ok(())
    }

    /// A PIN no meeting holds and none gave up in the last 30 days (kept in ext["phone"]["pins"]).
    fn phone_new_pin(&mut self, now: f64) -> String {
        let held: HashSet<String> = self.meetings.values().filter_map(Value::as_object).map(|m| pj::text_of(m, "phone_pin")).collect();
        let book = obj_mut(obj_mut(&mut self.ext, "phone"), "pins");
        loop {
            let pin = new_pin();
            let recent = pj::as_num(book.get(&pin)).is_some_and(|t| now - t < PIN_KEEP);
            if !held.contains(&pin) && !recent {
                book.insert(pin.clone(), f(now));
                self.dirty = true;
                return pin;
            }
        }
    }

    /// `phone: {numbers, pin}` of a meeting view (section 6), for a meeting that allows phone callers.
    pub(super) fn phone_meeting_view(&self, m: &Obj) -> Option<Value> {
        let cfg = self.ph.cfg.as_ref().filter(|c| c.conference())?;
        let pin = pj::text_of(m, "phone_pin");
        if pin.is_empty() {
            return None;
        }
        Some(Value::Object(obj([("numbers", Value::from(cfg.numbers.clone())), ("pin", Value::from(pin))])))
    }
}

impl Hub {
    /// Section 5.3 (the hello route, after the hello): the session takes phone calls when its `caps` list `phone`
    /// (unknown caps are ignored); `you.phone_line` and `you.phone_out` for a person with a line, `phone_conference`
    /// when the relay has a conference number; a session without the cap is not shown phone calls' invites.
    pub fn phone_hello(&self, who: &Identity, caps: Body, reply: &mut Obj) {
        let mut st = self.st.lock();
        let Some(cfg) = st.ph.cfg.clone() else { return };
        if who.kind == "captioner" {
            return;
        }
        let session = pj::text_of(reply, "session");
        let capable = caps.and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.as_str() == Some("phone")));
        if capable {
            st.ph.sessions.insert(session);
        } else {
            st.ph.sessions.remove(&session);
        }
        drop(st);
        if let (Some(line), Some(Value::Object(you))) = (cfg.line_of(&who.principal), reply.get_mut("you")) {
            you.insert("phone_line".into(), Value::from(line));
            if !cfg.outbound.is_empty() {
                you.insert("phone_out".into(), Value::Bool(true));
            }
        }
        if cfg.conference() {
            reply.insert("phone_conference".into(), Value::Bool(true));
        }
        if !capable {
            if let Some(Value::Array(list)) = reply.get_mut("invites") {
                list.retain(|i| i.get("phone").is_none());
            }
        }
    }

    /// `POST /v1/phone/call {session, to, room?}` (section 5.2): call `to` from the caller's line. Without `room` a new
    /// personal phone stay the caller then joins; with `room` the number is added to the phone stay the caller sits
    /// in. `{room, phone}` (`phone`: the new caller as the stay's `callers` show it). 404 without `phone` in
    /// relay.json, 400 a number not in E.164, 403 no line or not seated there, 409 no outbound trunk, 429 too many
    /// calls, 502 when LiveKit refuses (a new stay nobody joined ends).
    pub fn phone_call(&self, session: &str, who: &Identity, to: Body, room: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let Some(cfg) = st.ph.cfg.clone() else { return Err(E::NotFound(UNKNOWN.into())) };
        st.session(session, who)?;
        let to = match to {
            Some(Value::String(t)) if e164(t) => t.clone(),
            _ => return bad(BAD_TO),
        };
        let Some(line) = cfg.line_of(&who.principal).map(str::to_string) else { return forbidden(NO_LINE) };
        let Some(sfu) = st.sfu_cfg().filter(|_| !cfg.outbound.is_empty()) else { return Err(E::Conflict(NO_OUTBOUND.into())) };
        if st.phone_count(&who.principal) >= PER_PERSON {
            return Err(E::Status(429, TOO_MANY_MINE.into(), false));
        }
        let (room, created) = match room {
            None | Some(Value::Null) => {
                let mut room = new_room();
                while st.ph.stays.contains_key(&room) || st.stays.contains_key(&room) || st.rooms.contains_key(&room) {
                    room = new_room();
                }
                let lk_room = format!("{LK_PREFIX}out_{}", pj::token_hex(6));
                st.ph.stays.insert(room.clone(), PhoneStay { kind: PERSONAL, lk_room, owner: who.principal.clone(), callers: Vec::new(), rule: None });
                (room, true)
            }
            Some(Value::String(r)) => {
                let seated = st.stays.contains_key(r.as_str()) && st.peers.values().any(|p| p.room == *r && p.who.principal == who.principal && !p.admission_pending);
                let Some(stay) = st.ph.stays.get(r.as_str()).filter(|_| seated) else { return forbidden(NOT_SEATED) };
                if stay.callers.len() >= PER_STAY {
                    return Err(E::Status(429, TOO_MANY_HERE.into(), false));
                }
                (r.clone(), false)
            }
            Some(_) => return bad(BAD_ROOM),
        };
        let identity = format!("sip_out_{}", pj::token_hex(4));
        let caller = Caller { identity: identity.clone(), number: to.clone(), name: String::new(), kind: "out", state: RINGING, line: line.clone(), owner: who.principal.clone(), invite: String::new(), answered: true };
        let view = caller.view();
        let Some(stay) = st.ph.stays.get_mut(&room) else { return Err(E::Internal("the phone stay went".into())) };
        stay.callers.push(caller);
        let lk_room = stay.lk_room.clone();
        if !created {
            st.phone_tell(&room);
        }
        drop(st);
        self.wake();
        let body = obj([
            ("sip_trunk_id", Value::from(cfg.outbound.clone())),
            ("sip_call_to", Value::from(to.clone())),
            ("sip_number", Value::from(line.clone())),
            ("room_name", Value::from(lk_room.clone())),
            ("participant_identity", Value::from(identity.clone())),
            ("participant_name", Value::from(to)),
            ("wait_until_answered", Value::Bool(false)),
        ]);
        let (status, _) = sfu::sip_call(&sfu, "CreateSIPParticipant", &body, Some(&lk_room));
        if status != Some(200) {
            let mut st = self.st.lock();
            let alone = !st.peers.values().any(|p| p.room == room);
            if let Some(stay) = st.ph.stays.get_mut(&room) {
                stay.callers.retain(|c| c.identity != identity);
            }
            if created && alone {
                st.ph.stays.remove(&room);
            } else {
                st.phone_tell(&room);
            }
            drop(st);
            self.wake();
            log_warn(&format!("phone out failed room={room} principal={} status={}", who.principal, status_of(status)));
            return Err(E::Status(502, NOT_PLACED.into(), false));
        }
        log_info(&format!("phone out room={room} principal={} line={line} identity={identity}", who.principal));
        Ok(obj([("room", Value::from(room)), ("phone", view)]))
    }

    /// A webhook whose token checked (section 4): its event id is refused again for REPLAY_WINDOW (409), then the SIP
    /// participants' events change the phone stays.
    pub fn phone_webhook(&self, body: &[u8]) -> R<()> {
        let event = match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(o)) if !pj::text_of(&o, "id").is_empty() => o,
            _ => return bad(BAD_EVENT),
        };
        let id = pj::text_of(&event, "id");
        let mut st = self.st.lock();
        let now = pj::mono();
        st.ph.seen.retain(|_, at| now - *at < REPLAY_WINDOW);
        if st.ph.seen.contains_key(&id) {
            return Err(E::Conflict(REPLAYED.into()));
        }
        st.ph.seen.insert(id, now);
        st.phone_event(&event);
        drop(st);
        self.wake();
        Ok(())
    }
}

// ── the webhook listener (section 4) ─────────────────────────────────────────────────────────────────────────

struct Port {
    hub: Arc<Hub>,
    tls: Arc<rustls::ServerConfig>,
    from: Vec<Cidr>,
    open: AtomicUsize,
    refusals: RefusalLog,
}

/// The webhook listener on `webhook_listen`, on its own thread (nothing without `phone`): the relay's own server
/// certificate, no client certificate, connections from `webhook_from` only (any other is closed at accept), and
/// `POST /v1/sfu/webhook` only (404 for anything else).
pub fn start(settings: &Settings, hub: Arc<Hub>) -> Result<(), String> {
    let Some(cfg) = hub.st.lock().ph.cfg.clone() else { return Ok(()) };
    let tls = crate::meet_tls::webhook_tls_config(settings)?;
    let listener = TcpListener::bind((cfg.host.as_str(), cfg.port)).map_err(|e| format!("cannot listen on {}:{} (phone.webhook_listen): {e}", cfg.host, cfg.port))?;
    let port = Arc::new(Port { hub, tls, from: cfg.from.clone(), open: AtomicUsize::new(0), refusals: RefusalLog::new() });
    std::thread::Builder::new()
        .name("relay-phone-webhooks".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let address = address_of(&peer);
                if !port.from.iter().any(|c| c.contains(peer.ip())) || port.open.load(Ordering::SeqCst) >= CONNECTIONS_MAX {
                    port.refusals.note(&address);
                    drop(tcp);
                    continue;
                }
                port.open.fetch_add(1, Ordering::SeqCst);
                let p = port.clone();
                let spawned = std::thread::Builder::new().name("relay-phone-webhook".into()).spawn(move || {
                    serve(&p, tcp, &address);
                    p.open.fetch_sub(1, Ordering::SeqCst);
                });
                if spawned.is_err() {
                    port.open.fetch_sub(1, Ordering::SeqCst);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    log_info(&format!("phone webhooks listening on {}:{} from {} address ranges", cfg.host, cfg.port, cfg.from.len()));
    Ok(())
}

fn serve(port: &Port, mut tcp: TcpStream, address: &str) {
    let timeout = Some(Duration::from_secs_f64(WEBHOOK_TIMEOUT));
    let _ = tcp.set_read_timeout(timeout);
    let _ = tcp.set_write_timeout(timeout);
    let Ok(mut conn) = rustls::ServerConnection::new(port.tls.clone()) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            port.refusals.note(address);
            return;
        }
    }
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    loop {
        match one(port, &mut reader) {
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

fn answer(w: &mut Tls, status: u16, payload: &Obj) -> std::io::Result<()> {
    let body = pj::dumps(&Value::Object(payload.clone()));
    let head = format!(
        "HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n",
        reason_phrase(status),
        http_date(),
        body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(body.as_bytes())?;
    w.flush()
}

fn error(message: &str) -> Obj {
    obj([("error", Value::from(message))])
}

/// The token check of one webhook (in the contract's order after the size): Err (status, why).
fn check(port: &Port, head: &Head, body: &[u8]) -> Result<(), (u16, &'static str)> {
    let Some(sfu) = port.hub.st.lock().sfu_cfg() else { return refused(NOT_SIGNED) };
    let auth = head.header("authorization").unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").unwrap_or(&auth).trim();
    verify(token, body, sfu.api_key(), sfu.secret(), pj::now())
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let (path, _) = head.path_query();
    if head.method != "POST" || path != WEBHOOK_PATH {
        let unread = crate::meet::drain_unread(reader, &head, false);
        answer(reader.get_mut(), 404, &error(UNKNOWN))?;
        return Ok(!head.close && !unread);
    }
    let Some(length) = head.header("content-length").and_then(|l| l.trim().parse::<usize>().ok()) else {
        answer(reader.get_mut(), 411, &error(NO_LENGTH))?;
        return Ok(false);
    };
    if length > WEBHOOK_BODY_MAX {
        crate::meet::drain_unread(reader, &head, false);
        log_info(&format!("phone webhook refused status=413 bytes={length}"));
        answer(reader.get_mut(), 413, &error(TOO_BIG))?;
        return Ok(false);
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let (status, out) = match check(port, &head, &body) {
        Err((status, why)) => {
            log_info(&format!("phone webhook refused status={status} why={}", kv(why)));
            (status, error(why))
        }
        Ok(()) => match port.hub.phone_webhook(&body) {
            Ok(()) => (200, obj([("ok", Value::Bool(true))])),
            Err(e) => {
                let status = if matches!(e, E::Conflict(_)) { 409 } else { 400 };
                log_info(&format!("phone webhook refused status={status} why={}", kv(&e.message())));
                (status, error(&e.message()))
            }
        },
    };
    answer(reader.get_mut(), status, &out)?;
    Ok(!head.close && status == 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LINE: &str = "+19415550100";
    const CALLER: &str = "+15555550123";

    fn person(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), cert_pem: format!("-----BEGIN CERTIFICATE-----\n{p}\n-----END CERTIFICATE-----\n"), ..Default::default() }
    }

    fn settings(conference: bool) -> Value {
        let mut s = json!({"webhook_listen": "127.0.0.1:8447", "webhook_from": ["127.0.0.1/32"], "lines": {LINE: "Ann@X"}, "outbound_trunk": "ST_out"});
        if conference {
            s["conference"] = json!({"numbers": ["+19415550199"], "trunk": "ST_conf"});
        }
        s
    }

    fn hub() -> Hub {
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        {
            let mut st = h.st.lock();
            st.sfu_test_server();
            st.ph.cfg = Some(Arc::new(parse(&settings(true)).unwrap()));
        }
        h
    }

    fn hello(h: &Hub, who: &Identity, caps: Value) -> (String, Obj) {
        let mut reply = h.hello(who, "", &Obj::new()).unwrap();
        h.phone_hello(who, Some(&caps), &mut reply);
        (reply["session"].as_str().unwrap().to_string(), reply)
    }

    fn event(kind: &str, lk_room: &str, identity: &str, line: &str) -> Vec<u8> {
        let attrs = json!({"sip.phoneNumber": CALLER, "sip.trunkPhoneNumber": line, "sip.trunkID": "ST_in", "sip.callStatus": "active"});
        let participant = json!({"sid": "PA_1", "identity": identity, "name": format!("Phone {CALLER}"), "kind": "SIP", "state": "ACTIVE", "attributes": attrs});
        serde_json::to_vec(&json!({"event": kind, "id": format!("EV_{}", pj::token_hex(6)), "createdAt": "1700000000", "room": {"sid": "RM_1", "name": lk_room}, "participant": participant})).unwrap()
    }

    fn inbox(h: &Hub, sid: &str, kind: &str) -> Vec<Obj> {
        h.st.lock().sessions[sid].events.iter().filter(|e| pj::text_of(e, "type") == kind).cloned().collect()
    }

    fn caps(list: Value) -> Obj {
        obj([("caps", list)])
    }

    fn refusal<T>(r: R<T>) -> String {
        match r {
            Ok(_) => "ok".into(),
            Err(e) => e.message(),
        }
    }

    fn last_invite(h: &Hub, principal: &str) -> Obj {
        h.st.lock().invites[principal].last().cloned().unwrap()
    }

    #[test]
    fn settings_are_checked_at_start() {
        let cfg = parse(&settings(true)).unwrap();
        assert_eq!((cfg.host.as_str(), cfg.port, cfg.from.len()), ("127.0.0.1", 8447, 1));
        assert_eq!(cfg.owner_of(LINE), Some("ann@x"));
        assert_eq!(cfg.line_of("ann@x"), Some(LINE));
        assert!(cfg.conference() && cfg.outbound == "ST_out");
        let with = |key: &str, v: Value| {
            let mut s = settings(true);
            s[key] = v;
            parse(&s).err().unwrap_or_default()
        };
        assert_eq!(with("webhook_listen", json!("8447")), LISTEN);
        assert_eq!(with("webhook_listen", json!("host:0")), LISTEN);
        assert_eq!(with("webhook_from", json!([])), FROM);
        assert_eq!(with("webhook_from", json!(["10.0.0.0/33"])), FROM);
        assert_eq!(with("lines", json!({"5550100": "ann@x"})), LINES);
        assert_eq!(with("lines", json!({LINE: "ann"})), LINES);
        assert_eq!(with("lines", json!({LINE: "ann@x", "+19415550101": "ANN@x"})), "relay settings: phone.lines gives ann@x more than one number");
        assert_eq!(with("outbound_trunk", json!(7)), OUTBOUND);
        assert_eq!(with("conference", json!({"numbers": []})), CONFERENCE);
        assert_eq!(with("conference", json!({"numbers": [], "trunk": "ST_c"})), NUMBERS);
        assert_eq!(with("conference", json!({"numbers": ["+19415550199"], "trunk": ""})), TRUNK);
        assert_eq!(with("extra", json!(1)), SHAPE);
        assert_eq!(parse(&json!("on")).err().unwrap(), SHAPE);
        for good in ["+1941555", "+194155501001234"] {
            assert!(e164(good), "{good}");
        }
        for bad in ["19415550100", "+0941555010", "+194155", "+1941555010012345", "+1 941 555 0100", "+1941555010a"] {
            assert!(!e164(bad), "{bad}");
        }
        // the media server is required
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        let s = m::Settings { phone: settings(false), ..m::Settings::default() };
        assert_eq!(h.st.lock().phone_configure(&s).err().unwrap(), NEEDS_SFU);
        h.st.lock().sfu_test_server();
        assert!(h.st.lock().phone_configure(&s).is_ok());
        let mut st = h.st.lock();
        assert!(st.phone_configure(&m::Settings::default()).is_ok() && st.ph.cfg.is_none());
    }

    #[test]
    fn webhooks_are_signed_timely_and_bound_to_their_body() {
        let body = br#"{"event":"room_started","id":"EV_1"}"#;
        let now = 1_800_000_000.0;
        let sign = |claims: Value, secret: &[u8]| -> String {
            let signing = format!("{}.{}", crate::codec::b64u(br#"{"alg":"HS256","typ":"JWT"}"#), crate::codec::b64u(claims.to_string().as_bytes()));
            let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
            format!("{signing}.{}", crate::codec::b64u(aws_lc_rs::hmac::sign(&key, signing.as_bytes()).as_ref()))
        };
        let hash = pj::b64(&crate::codec::sha256(body));
        let claims = |iss: &str, nbf: f64, exp: f64, sha: &str| json!({"iss": iss, "nbf": nbf as i64, "iat": nbf as i64, "exp": exp as i64, "sha256": sha});
        let check = |token: String| verify(&token, body, "k", b"s", now).err().map(|(_, why)| why).unwrap_or("ok");
        assert_eq!(check(sign(claims("k", now - 5.0, now + 295.0, &hash), b"s")), "ok");
        assert_eq!(check(sign(claims("k", now - 5.0, now + 295.0, &hash), b"other")), NOT_SIGNED);
        assert_eq!(check(sign(claims("other", now - 5.0, now + 295.0, &hash), b"s")), WRONG_ISSUER);
        assert_eq!(check(sign(claims("k", now - 400.0, now - 61.0, &hash), b"s")), OUT_OF_TIME);
        assert_eq!(check(sign(claims("k", now - 300.0, now - 59.0, &hash), b"s")), "ok", "60 s leeway");
        assert_eq!(check(sign(claims("k", now + 61.0, now + 361.0, &hash), b"s")), OUT_OF_TIME);
        assert_eq!(check(sign(json!({"iss": "k", "nbf": now as i64, "sha256": hash}), b"s")), OUT_OF_TIME, "no exp");
        let other = pj::b64(&crate::codec::sha256(b"{}"));
        assert_eq!(check(sign(claims("k", now - 5.0, now + 295.0, &other), b"s")), BAD_HASH);
        assert_eq!(check("not-a-token".into()), NOT_SIGNED);
        let unsigned = format!("{}.{}.", crate::codec::b64u(br#"{"alg":"none"}"#), crate::codec::b64u(claims("k", now, now + 300.0, &hash).to_string().as_bytes()));
        assert_eq!(check(unsigned), NOT_SIGNED);
        // a replay is refused and changes nothing; a body that is not an event is refused
        let h = hub();
        assert!(h.phone_webhook(body).is_ok());
        assert_eq!(refusal(h.phone_webhook(body)), REPLAYED);
        assert_eq!(refusal(h.phone_webhook(b"[1]")), BAD_EVENT);
    }

    #[test]
    fn an_inbound_call_rings_phone_sessions_and_only_its_owner_joins_it_unencrypted() {
        let h = hub();
        let (ann, ann2, ben) = (person("ann@x", "aaaaaaaaaaaaaaaa"), person("ann@x", "a2a2a2a2a2a2a2a2"), person("ben@x", "bbbbbbbbbbbbbbbb"));
        let (phone_sid, reply) = hello(&h, &ann, json!(["phone", "later"]));
        assert_eq!((&reply["you"]["phone_line"], &reply["you"]["phone_out"], &reply["phone_conference"]), (&json!(LINE), &json!(true), &json!(true)));
        let (old_sid, _) = hello(&h, &ann2, json!(["peer_identity"]));
        let (_, other) = hello(&h, &ben, json!(["phone"]));
        assert!(other["you"].get("phone_line").is_none() && other["you"].get("phone_out").is_none());
        let lk_room = format!("{LK_PREFIX}{CALLER}_abc");
        let identity = format!("sip_{CALLER}");
        h.phone_webhook(&event("participant_joined", &lk_room, &identity, LINE)).unwrap();
        let rung = inbox(&h, &phone_sid, "invite");
        assert_eq!(rung.len(), 1);
        assert!(inbox(&h, &old_sid, "invite").is_empty(), "an app without the phone cap is not rung");
        let invite = &rung[0];
        assert_eq!((&invite["kind"], &invite["from"], &invite["from_name"]), (&json!("call"), &json!(format!("phone:{CALLER}")), &json!(CALLER)));
        assert_eq!(invite["phone"], json!({"kind": "in", "number": CALLER, "name": "", "line": LINE}));
        let room = invite["room"].as_str().unwrap().to_string();
        assert!(ph_room(&room), "{room}");
        // hello shows the ringing call to a phone session only
        let (_, again) = hello(&h, &ann2, json!([]));
        assert!(again["invites"].as_array().unwrap().iter().all(|i| i.get("phone").is_none()));
        // someone else, an app without the cap, a guest
        assert_eq!(refusal(h.join(&room, &ben, "", false, Some(&caps(json!(["phone"]))))), NOT_YOURS);
        assert_eq!(refusal(h.join(&room, &ann2, "", false, Some(&caps(json!(["peer_identity"]))))), NEEDS_UPDATE);
        let guest = Identity { guest: true, ..person("guest-0123456789abcdef@guest.invalid", "") };
        assert_eq!(refusal(h.join(&room, &guest, "", false, Some(&caps(json!(["phone"]))))), NEEDS_UPDATE);
        // the owner answers: no end-to-end encryption, the caller in `phone`, the microphone only and the keypad's data
        let joined = h.join(&room, &ann, "", false, Some(&caps(json!(["peer_identity", "phone"])))).unwrap();
        assert_eq!((&joined["media"], &joined["e2ee"]), (&json!("sfu"), &json!({"required": false})));
        assert_eq!(joined["phone"], json!({"kind": "personal", "callers": [{"identity": identity, "number": CALLER, "name": "", "kind": "in", "state": "connected"}]}));
        let token = joined["sfu"]["token"].as_str().unwrap();
        let claims: Value = serde_json::from_slice(&crate::codec::unb64u(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["video"]["room"], json!(lk_room));
        assert_eq!((&claims["video"]["canPublishSources"], &claims["video"]["canPublishData"]), (&json!(["microphone"]), &json!(true)));
        assert_eq!(inbox(&h, &phone_sid, "invite_settled")[0]["how"], json!("answered"));
        assert!(h.st.lock().phone_keeps(&room, &identity, true));
        // the caller hangs up: the seat hears `phone` with no callers, then `ended`, and is dropped
        let peer = joined["peer"].as_str().unwrap().to_string();
        h.st.lock().peers.get_mut(&peer).unwrap().polls = 1; // a poll waits: the seat's last events stay readable
        h.phone_webhook(&event("participant_left", &lk_room, &identity, LINE)).unwrap();
        let st = h.st.lock();
        assert!(!st.peers.contains_key(&peer) && !st.ph.stays.contains_key(&room) && !st.stays.contains_key(&room));
        let kinds: Vec<String> = st.gone[&peer].events.iter().map(|e| pj::text_of(e, "type")).collect();
        assert!(kinds.ends_with(&["phone".to_string(), "ended".to_string()]), "{kinds:?}");
        let ended = st.gone[&peer].events.back().unwrap();
        assert_eq!((&ended["room"], &ended["why"]), (&json!(room), &json!("phone_hangup")));
        drop(st);
        // a ph- room after its call ended
        assert_eq!(refusal(h.join(&room, &ann, "", false, Some(&caps(json!(["phone"]))))), ENDED);
    }

    #[test]
    fn rings_end_missed_declined_timed_out_or_cancelled() {
        let h = hub();
        let ann = person("ann@x", "aaaaaaaaaaaaaaaa");
        // no device takes phone calls: missed at once, the caller's call ends
        hello(&h, &ann, json!([]));
        h.phone_webhook(&event("participant_joined", "lucid-phone_a", "sip_a", LINE)).unwrap();
        assert_eq!(last_invite(&h, "ann@x")["settled"], json!("missed"));
        assert!(h.st.lock().ph.stays.is_empty());
        // a line nobody holds, and the person's fifth call, are refused
        h.phone_webhook(&event("participant_joined", "lucid-phone_n", "sip_n", "+19415550111")).unwrap();
        assert!(h.st.lock().ph.stays.is_empty());
        // declined
        let (sid, _) = hello(&h, &ann, json!(["phone"]));
        h.phone_webhook(&event("participant_joined", "lucid-phone_b", "sip_b", LINE)).unwrap();
        let id = last_invite(&h, "ann@x")["id"].as_str().unwrap().to_string();
        assert_eq!(h.invite_settle(&sid, &ann, Some(&json!(id)), Some(&json!("declined"))).unwrap()["how"], json!("declined"));
        assert!(h.st.lock().ph.stays.is_empty());
        // past RING_SECONDS: missed
        h.phone_webhook(&event("participant_joined", "lucid-phone_c", "sip_c", LINE)).unwrap();
        {
            let mut st = h.st.lock();
            let then = st.nt_now() - push::RING_SECONDS - 1.0;
            st.invites.get_mut("ann@x").unwrap().last_mut().unwrap().insert("ts".into(), f(then));
        }
        h.push_tick();
        assert_eq!(last_invite(&h, "ann@x")["settled"], json!("missed"));
        assert!(h.st.lock().ph.stays.is_empty());
        // the caller hangs up while it rings: cancelled
        h.phone_webhook(&event("participant_joined", "lucid-phone_d", "sip_d", LINE)).unwrap();
        assert_eq!(h.st.lock().ph.stays.len(), 1);
        h.phone_webhook(&event("participant_left", "lucid-phone_d", "sip_d", LINE)).unwrap();
        assert_eq!(last_invite(&h, "ann@x")["settled"], json!("cancelled"));
        assert!(h.st.lock().ph.stays.is_empty());
        // at most PER_PERSON calls at once
        for i in 0..=PER_PERSON {
            h.phone_webhook(&event("participant_joined", &format!("lucid-phone_{i}"), &format!("sip_{i}"), LINE)).unwrap();
        }
        assert_eq!(h.st.lock().phone_count("ann@x"), PER_PERSON);
    }

    #[test]
    fn calls_out_need_a_number_a_line_and_a_trunk() {
        let h = hub();
        let (ann, ben) = (person("ann@x", "aaaaaaaaaaaaaaaa"), person("ben@x", "bbbbbbbbbbbbbbbb"));
        let (sa, _) = hello(&h, &ann, json!(["phone"]));
        let (sb, _) = hello(&h, &ben, json!(["phone"]));
        assert_eq!(refusal(h.phone_call(&sa, &ann, Some(&json!("5550123")), None)), BAD_TO);
        assert_eq!(refusal(h.phone_call(&sb, &ben, Some(&json!(CALLER)), None)), NO_LINE);
        assert_eq!(refusal(h.phone_call(&sa, &ann, Some(&json!(CALLER)), Some(&json!("m-aaaaaaaaaa")))), NOT_SEATED);
        // the media server cannot be reached: 502, and the new stay nobody joined is gone
        assert_eq!(refusal(h.phone_call(&sa, &ann, Some(&json!(CALLER)), None)), NOT_PLACED);
        assert!(h.st.lock().ph.stays.is_empty());
        let no_trunk = json!({"webhook_listen": "127.0.0.1:8447", "webhook_from": ["127.0.0.1/32"], "lines": {LINE: "ann@x"}});
        h.st.lock().ph.cfg = Some(Arc::new(parse(&no_trunk).unwrap()));
        assert_eq!(refusal(h.phone_call(&sa, &ann, Some(&json!(CALLER)), None)), NO_OUTBOUND);
        let (_, reply) = hello(&h, &ann, json!(["phone"]));
        assert!(reply["you"].get("phone_out").is_none() && reply.get("phone_conference").is_none());
        // phone off: 404
        h.st.lock().ph.cfg = None;
        assert_eq!(refusal(h.phone_call(&sa, &ann, Some(&json!(CALLER)), None)), UNKNOWN);
    }

    #[test]
    fn a_meeting_that_allows_phone_callers_has_a_pin_and_a_phone_stay() {
        let h = hub();
        let ann = person("ann@x", "aaaaaaaaaaaaaaaa");
        let (sa, _) = hello(&h, &ann, json!(["phone"]));
        let (start, end) = (pj::now() + 60.0, pj::now() + 3600.0);
        let made = h.meeting_create(&sa, &ann, Some(&json!("Plan")), Some(&json!(start)), Some(&json!(end)), Some(&json!([])), None, None, None, None, Some(&json!(true))).unwrap();
        let pin = made["phone"]["pin"].as_str().unwrap().to_string();
        assert!(pin.len() == 6 && pin.bytes().all(|c| c.is_ascii_digit()), "{pin}");
        assert_eq!(made["phone"]["numbers"], json!(["+19415550199"]));
        let room = made["room"].as_str().unwrap().to_string();
        assert_eq!(refusal(h.meeting_create(&sa, &ann, Some(&json!("x")), Some(&json!(start)), Some(&json!(end)), Some(&json!([])), None, None, None, None, Some(&json!("yes")))), BAD_PHONE);
        // the stay is a meeting phone stay: no end-to-end encryption, the `phone` cap, the camera too
        assert_eq!(refusal(h.join(&room, &ann, "", false, Some(&caps(json!(["peer_identity"]))))), NEEDS_UPDATE);
        let joined = h.join(&room, &ann, "", false, Some(&caps(json!(["peer_identity", "phone"])))).unwrap();
        assert_eq!((&joined["e2ee"], &joined["phone"]), (&json!({"required": false}), &json!({"kind": "meeting", "callers": []})));
        let token = joined["sfu"]["token"].as_str().unwrap();
        let claims: Value = serde_json::from_slice(&crate::codec::unb64u(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["video"]["canPublishSources"], json!(["microphone", "camera"]));
        let lk_room = claims["video"]["room"].as_str().unwrap().to_string();
        assert!(h.st.lock().ph.stays[&room].rule.is_some());
        // a dial-in caller joins and leaves the stay's LiveKit room
        let peer = joined["peer"].as_str().unwrap().to_string();
        h.phone_webhook(&event("participant_joined", &lk_room, "sip_pin", "+19415550199")).unwrap();
        let heard: Vec<Obj> = h.st.lock().peers[&peer].events.iter().filter(|e| pj::text_of(e, "type") == "phone").cloned().collect();
        assert_eq!(heard.last().unwrap()["callers"][0]["identity"], json!("sip_pin"));
        assert!(h.st.lock().phone_keeps(&room, "sip_pin", false));
        h.phone_webhook(&event("participant_left", &lk_room, "sip_pin", "+19415550199")).unwrap();
        assert!(h.st.lock().ph.stays[&room].callers.is_empty(), "a meeting stays when its callers leave");
        // the stay ends with its last seat; turning phone off takes the PIN away
        h.leave(&peer, &ann).unwrap();
        assert!(!h.st.lock().ph.stays.contains_key(&room));
        let off = h.meeting_update(&sa, &ann, Some(&json!(room)), &obj([("phone", json!(false))])).unwrap();
        assert!(off.get("phone").is_none());
        assert!(pj::as_num(h.st.lock().ext["phone"]["pins"].get(pin.as_str())).is_some(), "the PIN rests 30 days");
        // without a conference number: 409
        h.st.lock().ph.cfg = Some(Arc::new(parse(&settings(false)).unwrap()));
        assert_eq!(refusal(h.meeting_update(&sa, &ann, Some(&json!(room)), &obj([("phone", json!(true))]))), NO_CONFERENCE);
    }

    #[test]
    fn the_sync_keeps_live_phone_participants_and_old_unheld_phone_rooms_go() {
        let h = hub();
        let mut st = h.st.lock();
        st.ph.stays.insert("ph-aaaaaaaaaa".into(), PhoneStay { kind: PERSONAL, lk_room: "lucid-phone_x".into(), owner: "ann@x".into(), callers: Vec::new(), rule: None });
        assert!(st.phone_keeps("ph-aaaaaaaaaa", "sip_1", true) && !st.phone_keeps("ph-aaaaaaaaaa", "ghost", false) && !st.phone_keeps("big", "sip_1", true));
        assert!(!st.phone_room_unheld("lucid-phone_x", 0.0), "held");
        assert!(st.phone_room_unheld("lucid-phone_y", 0.0));
        assert!(!st.phone_room_unheld("lucid-phone_y", pj::now()), "too young");
        st.ph.cfg = None;
        assert!(!st.phone_room_unheld("lucid-phone_y", 0.0), "phone off: not the relay's business");
    }
}
