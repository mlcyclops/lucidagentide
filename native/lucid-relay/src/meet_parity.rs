// Parity wave A (contract PA-1): the relay parts of the low-cost Slack and Teams features (meet_relay.Hub's prefs,
// status `until`, forwarded messages, co-organizers, attendance and custom emoji). A child module of meet_hub: it
// shares the hub's one lock. Persisted in state.json as the Python keeps them: `prefs` {principal: {rev, notify,
// sections, channel_default}}, `attendance` {room: [session]} and `emoji` {name: {name, hash, type, org, by, ts}}
// (the images themselves in state_dir/emoji/<sha256>, in memory without a state folder).

use super::*;

/// What `emoji_file` answers: the response headers, then the image bytes.
pub type EmojiFile = (Vec<(&'static str, String)>, Vec<u8>);

/// Bodies of `POST /v1/prefs` and `POST /v1/emoji`.
pub const PREFS_BODY_MAX: usize = 512 * 1024;
pub const EMOJI_BODY_MAX: usize = 512 * 1024;
const LEVELS: [&str; 3] = ["all", "mentions", "off"];
const CHANNEL_DEFAULTS: [&str; 2] = ["all", "mentions"];
const CONV_KINDS: [&str; 4] = ["dm", "channel", "room", "meeting"];
const CONV_KEY_MAX: usize = 200;
const NOTIFY_MAX: usize = 5000;
const SECTIONS_MAX: usize = 20;
const SECTION_NAME_MAX: usize = 40;
const SECTION_CONVS_MAX: usize = 500;
/// A status's `until`: from a minute to 7 days ahead (ms).
const UNTIL_MIN_MS: i64 = 60 * 1000;
const UNTIL_MAX_MS: i64 = 7 * 86_400_000;
/// Co-organizers of one call (stage.cohosts) and of one scheduled meeting.
pub(super) const COHOSTS_MAX: usize = 10;
const FWD_TEXT_MAX: usize = 100;
const FWD_KINDS: [&str; 5] = ["dm", "group", "channel", "room", "meeting"];
/// Attendance: join intervals of one person, people of one session, sessions kept per room.
const ATTEND_JOINS_MAX: usize = 50;
const ATTEND_PEOPLE_MAX: usize = 1000;
const ATTEND_SESSIONS_MAX: usize = 200;
const EMOJI_BYTES_MAX: usize = 256 * 1024;
const EMOJI_SIDE_MAX: u32 = 128;
const EMOJI_CACHE: &str = "public, max-age=31536000, immutable";

const BAD_CONV: &str = "bad conversation key";
const BAD_SECTIONS: &str = "sections must be a list of {id, name, convs}";
const BAD_FWD: &str = "fwd must be {name, conv, ts, kind}";
const BAD_UNTIL: &str = "until must be between 1 minute and 7 days from now";
const BAD_EMOJI_NAME: &str = "name must be 2 to 32 of a-z, 0-9, _ and -";
const NO_EMOJI: &str = "no custom emoji by that name";
const NO_EMOJI_HASH: &str = "no custom emoji with that hash";
const NOT_ORGANIZERS: &str = "Only the meeting's organizers can see attendance";
pub(super) const NOT_COHOST_GUEST: &str = "a guest cannot be a co-organizer";
pub(super) const COHOSTS_FULL: &str = "a call has at most 10 co-organizers";
pub(super) const MEETING_COHOSTS_FULL: &str = "a meeting has at most 10 co-organizers";

/// In memory: the relay.json settings of this wave and the custom emoji images' home.
pub struct Parity {
    attendance: bool,
    attendance_days: i64,
    emoji_max: usize,
    /// state_dir/emoji (None: the images stay in `emoji_mem`).
    emoji_dir: Option<PathBuf>,
    emoji_mem: HashMap<String, Vec<u8>>,
    /// API-1 revision 4 7.1: `meeting.*` and `member.*` events raised under the hub's lock, appended to the relay's
    /// event chains by its event thread (`Hub::api_take_events`, about once a second).
    events: Vec<CallEvent>,
    /// room -> the live call's organizer (a scheduled meeting's, else the person who opened the session) and meeting.
    calls: HashMap<String, LiveCall>,
}

/// One call event before its org is known: `owner` is the principal whose org it belongs to (the organizer for
/// `meeting.*` and a guest's `member.*`, the person otherwise).
#[derive(Clone, Debug, PartialEq)]
pub struct CallEvent {
    pub kind: &'static str,
    pub data: Value,
    pub owner: String,
}

/// What the call events of a live session need to know of it.
#[derive(Clone, Debug, Default)]
struct LiveCall {
    organizer: Option<String>,
    meeting: Option<String>,
}

/// Call events kept at most while the event thread is behind (older ones go first).
const CALL_EVENTS_MAX: usize = 10_000;

impl Parity {
    pub fn new(state_dir: Option<&std::path::Path>) -> Parity {
        Parity {
            attendance: true,
            attendance_days: 30,
            emoji_max: 500,
            emoji_dir: state_dir.map(|d| d.join("emoji")),
            emoji_mem: HashMap::new(),
            events: Vec::new(),
            calls: HashMap::new(),
        }
    }
}

/// int(time.time() * 1000).
fn ms_now() -> i64 {
    (pj::now() * 1000.0) as i64
}

/// The text a Python `re.match(...$)` checks: `$` also matches before one final newline.
fn body_of(s: &str) -> &str {
    s.strip_suffix('\n').unwrap_or(s)
}

/// str.isspace() of one character (what `\S` refuses).
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// CONV_KEY_RE (`^(dm|channel|room|meeting):\S+$`), at most CONV_KEY_MAX characters.
pub(super) fn conv_key_ok(s: &str) -> bool {
    if pj::char_len(s) > CONV_KEY_MAX {
        return false;
    }
    let Some((kind, rest)) = body_of(s).split_once(':') else { return false };
    CONV_KINDS.contains(&kind) && !rest.is_empty() && !rest.chars().any(py_space)
}

/// SECTION_ID_RE: `s-` + 8 lower-case hex digits.
fn section_id_ok(s: &str) -> bool {
    let b = body_of(s);
    b.len() == 10 && b.starts_with("s-") && b[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// EMOJI_NAME_RE: 2 to 32 of `a-z`, `0-9`, `_` and `-`.
fn emoji_name_ok(s: &str) -> bool {
    let b = body_of(s);
    (2..=32).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// The custom emoji a reaction names (`:name:`), None for any other text.
fn custom_name(emoji: &str) -> Option<&str> {
    let name = body_of(emoji).strip_prefix(':')?.strip_suffix(':')?;
    emoji_name_ok(name).then_some(name)
}

/// _fwd: what a forwarded plain-text message says of the original (`fwd`); None when absent.
pub(super) fn fwd(v: Option<&Value>) -> R<Option<Obj>> {
    let o = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(o)) => o,
        Some(_) => return bad(BAD_FWD),
    };
    let short = |k: &str| matches!(o.get(k), Some(Value::String(s)) if pj::char_len(s) <= FWD_TEXT_MAX);
    let kind = matches!(o.get("kind"), Some(Value::String(k)) if FWD_KINDS.contains(&k.as_str()));
    match pj::as_int(o.get("ts")) {
        Some(ts) if ts >= 0 && o.len() == 4 && short("name") && short("conv") && kind => {
            Ok(Some(obj([("name", o["name"].clone()), ("conv", o["conv"].clone()), ("ts", Value::from(ts)), ("kind", o["kind"].clone())])))
        }
        _ => bad(BAD_FWD),
    }
}

/// _status_until: when a status set now clears itself (ms), None for never.
pub(super) fn status_until(v: Option<&Value>) -> R<Option<i64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        _ => {
            let now = ms_now();
            match pj::as_int(v) {
                Some(t) if (now + UNTIL_MIN_MS..=now + UNTIL_MAX_MS).contains(&t) => Ok(Some(t)),
                _ => bad(BAD_UNTIL),
            }
        }
    }
}

/// A kept status still in force at `now` (ms): no `until`, or one still ahead.
pub(super) fn status_live(status: &Value, now: i64) -> bool {
    status.get("until").and_then(Value::as_i64).map(|u| u > now).unwrap_or(true)
}

/// _prefs_default.
fn prefs_default() -> Obj {
    obj([("rev", Value::from(0)), ("notify", Value::Object(Obj::new())), ("sections", Value::Array(Vec::new())), ("channel_default", Value::from("all"))])
}

/// _prefs_notify: a patch of notification levels (`null` removes a conversation's own level).
fn notify_patch(v: Option<&Value>) -> R<Option<Vec<(String, Value)>>> {
    let o = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(o)) => o,
        Some(_) => return bad("notify must map conversations to levels"),
    };
    let mut out = Vec::with_capacity(o.len());
    for (key, level) in o {
        if !conv_key_ok(key) {
            return bad(BAD_CONV);
        }
        if !matches!(level, Value::Null) && !matches!(level, Value::String(l) if LEVELS.contains(&l.as_str())) {
            return bad("level must be all, mentions or off");
        }
        out.push((key.clone(), level.clone()));
    }
    Ok(Some(out))
}

/// _prefs_sections: the person's custom chat list sections (replacing the kept ones).
fn sections(v: Option<&Value>) -> R<Option<Vec<Value>>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) => a,
        Some(_) => return bad(BAD_SECTIONS),
    };
    if list.len() > SECTIONS_MAX {
        return bad(format!("at most {SECTIONS_MAX} sections"));
    }
    let mut out = Vec::with_capacity(list.len());
    let mut ids: Vec<&str> = Vec::with_capacity(list.len());
    let mut total = 0;
    for section in list {
        let Some(o) = section.as_object().filter(|o| o.len() == 3 && o.contains_key("id") && o.contains_key("name")) else { return bad(BAD_SECTIONS) };
        let Some(Value::Array(convs)) = o.get("convs") else { return bad(BAD_SECTIONS) };
        let id = match o.get("id") {
            Some(Value::String(id)) if section_id_ok(id) => id,
            _ => return bad("section id must be s- and 8 hex digits"),
        };
        if ids.contains(&id.as_str()) {
            return bad("each section needs its own id");
        }
        let name = o.get("name").and_then(Value::as_str).unwrap_or_default().trim();
        if name.is_empty() || pj::char_len(name) > SECTION_NAME_MAX {
            return bad(format!("a section name is 1 to {SECTION_NAME_MAX} characters"));
        }
        if !convs.iter().all(|c| matches!(c, Value::String(k) if conv_key_ok(k))) {
            return bad(BAD_CONV);
        }
        total += convs.len();
        if total > SECTION_CONVS_MAX {
            return bad(format!("at most {SECTION_CONVS_MAX} conversations in sections"));
        }
        ids.push(id);
        out.push(Value::Object(obj([("id", Value::from(id.clone())), ("name", Value::from(name)), ("convs", Value::Array(convs.clone()))])));
    }
    Ok(Some(out))
}

/// _prefs_channel_default: the level a new channel starts with.
fn channel_default(v: Option<&Value>) -> R<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(d)) if CHANNEL_DEFAULTS.contains(&d.as_str()) => Ok(Some(d.clone())),
        Some(_) => bad("channel_default must be all or mentions"),
    }
}

/// _pa_load's check of one person's prefs from state.json (any unsound part drops them all).
fn stored_prefs(v: &Value) -> Option<Obj> {
    let o = v.as_object()?;
    let rev = pj::as_int(o.get("rev")).filter(|r| *r >= 0)?;
    let notify = as_obj(o.get("notify"))?;
    if !notify.iter().all(|(k, l)| conv_key_ok(k) && matches!(l, Value::String(l) if LEVELS.contains(&l.as_str()))) {
        return None;
    }
    let default = match o.get("channel_default") {
        Some(Value::String(d)) if CHANNEL_DEFAULTS.contains(&d.as_str()) => d.clone(),
        _ => return None,
    };
    let sections = sections(Some(o.get("sections")?)).ok()??;
    Some(obj([("rev", Value::from(rev)), ("notify", Value::Object(notify.clone())), ("sections", Value::Array(sections)), ("channel_default", Value::from(default))]))
}

/// _pa_load's check of one custom emoji from state.json: the row as the relay keeps it.
fn stored_emoji(name: &str, v: &Value) -> Option<Obj> {
    let o = v.as_object()?;
    let hash = o.get("hash").and_then(Value::as_str)?;
    let sound = emoji_name_ok(name)
        && o.get("name").and_then(Value::as_str) == Some(name)
        && body_of(hash).len() == 64
        && body_of(hash).bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && matches!(o.get("type").and_then(Value::as_str), Some("png" | "gif"))
        && o.get("by").map(Value::is_string).unwrap_or(false)
        && pj::as_int(o.get("ts")).is_some();
    let org = o.get("org").filter(|g| g.is_object()).cloned().unwrap_or(Value::Null);
    sound.then(|| obj([("name", Value::from(name)), ("hash", Value::from(hash)), ("type", o["type"].clone()), ("org", org), ("by", o["by"].clone()), ("ts", o["ts"].clone())]))
}

/// _pa_stored_session: one attendance session from state.json has the shape the relay keeps.
fn stored_session(v: &Value) -> Option<Obj> {
    let ms = |v: Option<&Value>| pj::as_int(v).is_some();
    let o = v.as_object()?;
    let people = o.get("people")?.as_array()?;
    let person_ok = |p: &Value| {
        let Some(p) = p.as_object() else { return false };
        let joins_ok = p.get("joins").and_then(Value::as_array).map(|j| j.iter().all(|j| matches!(j.as_array().map(Vec::as_slice), Some([a, b]) if ms(Some(a)) && (b.is_null() || ms(Some(b)))))).unwrap_or(false);
        p.get("principal").map(Value::is_string).unwrap_or(false)
            && p.get("name").map(Value::is_string).unwrap_or(false)
            && matches!(p.get("role").and_then(Value::as_str), Some("host" | "cohost" | "attendee" | "guest"))
            && joins_ok
    };
    let sound = o.get("id").map(Value::is_string).unwrap_or(false) && ms(o.get("start")) && matches!(o.get("end"), Some(e) if e.is_null() || ms(Some(e))) && people.iter().all(person_ok);
    sound.then(|| o.clone())
}

/// The end of a session the relay stopped in the middle of: the latest moment it saw (each join's leave, or its
/// arrival while still in, and the session's start).
fn session_last(s: &Obj) -> i64 {
    let mut last = pj::as_int(s.get("start")).unwrap_or(0);
    for row in s.get("people").and_then(Value::as_array).into_iter().flatten() {
        for j in row.get("joins").and_then(Value::as_array).into_iter().flatten() {
            if let Some(t) = j.get(1).and_then(Value::as_i64).or_else(|| j.get(0).and_then(Value::as_i64)) {
                last = last.max(t);
            }
        }
    }
    last
}

/// End a session at `at`: its `end` and every open join interval.
fn end_session(s: &mut Obj, at: i64) {
    s.insert("end".into(), Value::from(at));
    for row in s.get_mut("people").and_then(Value::as_array_mut).into_iter().flatten() {
        for j in row.get_mut("joins").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(slot) = j.as_array_mut().and_then(|a| a.get_mut(1)).filter(|v| v.is_null()) {
                *slot = Value::from(at);
            }
        }
    }
}

/// _attend_key: a person as attendance names them: the principal, or `guest:` + the web guest's id.
fn attend_key(who: &Identity) -> String {
    if who.guest {
        let id = who.principal.strip_prefix("guest-").and_then(|r| r.strip_suffix(m::GUEST_DOMAIN)).unwrap_or(&who.principal);
        return format!("guest:{id}");
    }
    who.principal.clone()
}

/// _emoji_kind: "png" or "gif" from the image's magic bytes, its header's size at most EMOJI_SIDE_MAX each way.
fn emoji_kind(data: &[u8]) -> R<&'static str> {
    let (kind, width, height) = if data.len() >= 24 && data.starts_with(b"\x89PNG\r\n\x1a\n") && data[12..16] == *b"IHDR" {
        ("png", u32::from_be_bytes([data[16], data[17], data[18], data[19]]), u32::from_be_bytes([data[20], data[21], data[22], data[23]]))
    } else if data.len() >= 10 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        ("gif", u32::from(u16::from_le_bytes([data[6], data[7]])), u32::from(u16::from_le_bytes([data[8], data[9]])))
    } else {
        return bad("an emoji image must be PNG or GIF");
    };
    if !(1..=EMOJI_SIDE_MAX).contains(&width) || !(1..=EMOJI_SIDE_MAX).contains(&height) {
        return bad(format!("an emoji image is at most {EMOJI_SIDE_MAX} by {EMOJI_SIDE_MAX} pixels"));
    }
    Ok(kind)
}

/// _emoji_view: a custom emoji as every session sees it.
fn emoji_view(row: &Obj) -> Value {
    let get = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    Value::Object(obj([("name", get("name")), ("hash", get("hash")), ("org", get("org")), ("by", get("by")), ("ts", get("ts"))]))
}

impl State {
    /// _pa_configure: this wave's relay.json settings, once at start.
    pub(super) fn pa_configure(&mut self, s: &m::Settings) {
        self.pa.attendance = s.attendance;
        self.pa.attendance_days = s.attendance_days;
        self.pa.emoji_max = usize::try_from(s.emoji_max).unwrap_or(usize::MAX);
        self.pa_prune(pj::now());
    }

    /// _pa_load: prefs, custom emoji and attendance from state.json; a session the relay stopped in the middle of
    /// ends at the last moment it saw.
    pub(super) fn pa_load(&mut self, raw: &Obj) {
        for (principal, v) in as_obj(raw.get("prefs")).into_iter().flatten() {
            match stored_prefs(v) {
                Some(p) => {
                    self.prefs.insert(principal.clone(), Value::Object(p));
                }
                None => log_warn(&format!("state file: prefs of {principal} unreadable; ignored")),
            }
        }
        for (name, v) in as_obj(raw.get("emoji")).into_iter().flatten() {
            match stored_emoji(name, v) {
                Some(row) => {
                    self.emoji.insert(name.clone(), Value::Object(row));
                }
                None => log_warn(&format!("state file: custom emoji {} unreadable; ignored", kv(name))),
            }
        }
        for (room, list) in as_obj(raw.get("attendance")).into_iter().flatten() {
            let sessions: Vec<Value> = list
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(stored_session)
                .map(|mut s| {
                    if s.get("end").map(Value::is_null).unwrap_or(true) {
                        let at = session_last(&s);
                        end_session(&mut s, at);
                    }
                    Value::Object(s)
                })
                .collect();
            if !sessions.is_empty() {
                self.attendance.insert(room.clone(), Value::Array(sessions));
            }
        }
    }

    /// _pa_prune (the periodic prune): ended attendance sessions older than `attendance_days` go.
    pub(super) fn pa_prune(&mut self, now: f64) {
        let cut = (now * 1000.0) as i64 - self.pa.attendance_days.saturating_mul(86_400_000);
        for list in self.attendance.values_mut() {
            if let Some(a) = list.as_array_mut() {
                a.retain(|s| s.get("end").and_then(Value::as_i64).map(|e| e >= cut).unwrap_or(true));
            }
        }
        self.attendance.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false));
    }

    // ── status that clears itself ──

    /// _status_sweep (every reap): a status whose `until` came goes back to automatic; everyone hears `presence`.
    pub(super) fn pa_status_sweep(&mut self) {
        let now = ms_now();
        let done: Vec<String> = self.statuses.iter().filter(|(_, s)| !status_live(s, now)).map(|(p, _)| p.clone()).collect();
        for principal in done {
            self.statuses.shift_remove(&principal);
            self.dirty = true;
            self.tell_presence(&principal);
            log_info(&format!("status principal={principal} state=auto why=until"));
        }
    }

    // ── co-organizers ──

    /// A co-organizer of the call in `room` (stage.cohosts names the principal).
    pub(super) fn pa_is_cohost(&self, room: &str, principal: &str) -> bool {
        self.stages.get(room).and_then(|s| s.get("cohosts")).and_then(Value::as_array).map(|l| l.iter().any(|c| c.as_str() == Some(principal))).unwrap_or(false)
    }

    /// _hosts: the peer is the host of `room` or a co-organizer of it (every host power but make_host and cohost).
    pub(super) fn pa_hosts(&self, room: &str, peer_id: &str) -> bool {
        if self.stage_host(room).as_deref() == Some(peer_id) {
            return true;
        }
        self.peers.get(peer_id).map(|p| p.room == room && !p.who.guest && self.pa_is_cohost(room, &p.who.principal)).unwrap_or(false)
    }

    /// _meeting_cohost: an admitted peer the scheduled meeting held in `room` names as a co-organizer becomes one of
    /// the call (true when it just did; the caller tells the room, stage `why: "cohost"`).
    pub(super) fn pa_meeting_cohost(&mut self, room: &str, peer_id: &str) -> bool {
        let Some(m) = as_obj(self.meetings.get(room)) else { return false };
        let Some(p) = self.peers.get(peer_id) else { return false };
        if pj::truthy(m.get("canceled")) || p.admission_pending || p.who.guest {
            return false;
        }
        let principal = p.who.principal.clone();
        if !m.get("cohosts").and_then(Value::as_array).map(|l| l.iter().any(|c| c.as_str() == Some(principal.as_str()))).unwrap_or(false) {
            return false;
        }
        let list = list_mut(self.stage_mut(room), "cohosts");
        if list.len() >= COHOSTS_MAX || list.iter().any(|c| c.as_str() == Some(principal.as_str())) {
            return false;
        }
        list.push(Value::from(principal.clone()));
        log_info(&format!("stage room={room} principal={principal} cohost=meeting"));
        true
    }

    // ── attendance ──

    /// Calls keep an attendance list (`attendance` on and `attendance_days` above 0).
    pub(super) fn pa_attendance_on(&self) -> bool {
        self.pa.attendance && self.pa.attendance_days > 0
    }

    /// API-1 revision 4 5.1 `kept_days`: how long ended sessions are kept (0 while attendance is off).
    pub(super) fn pa_kept_days(&self) -> i64 {
        if self.pa_attendance_on() {
            self.pa.attendance_days
        } else {
            0
        }
    }

    /// The live attendance session of `room` (end null), if any.
    fn pa_live(&mut self, room: &str) -> Option<&mut Obj> {
        self.attendance.get_mut(room)?.as_array_mut()?.last_mut()?.as_object_mut().filter(|s| s.get("end").map(Value::is_null).unwrap_or(true))
    }

    /// _attend_in: an admitted seat is in the call: the room's live session (made by the first one) opens a join
    /// interval for the person unless one is open.
    pub(super) fn pa_attend_in(&mut self, peer_id: &str) {
        if !self.pa_attendance_on() {
            return;
        }
        let Some(p) = self.peers.get(peer_id).filter(|p| !p.admission_pending && !p.who.is_console() && !p.who.connector) else { return };
        let (room, key, name, guest) = (p.room.clone(), attend_key(&p.who), p.who.name.clone(), p.who.guest);
        let person = key.clone();
        let org = if guest { Value::Null } else { self.org(&p.who.principal) };
        let now = ms_now();
        if self.pa_live(&room).is_none() {
            let mut session = obj([("id", Value::from(pj::token_hex(8))), ("start", Value::from(now)), ("end", Value::Null)]);
            // revision 4 7.1: who organizes the call (a scheduled meeting's organizer, else who opened it)
            let mut call = LiveCall::default();
            let mut title = None;
            if let Some(m) = as_obj(self.meetings.get(&room)) {
                session.insert("meeting_id".into(), Value::from(room.clone()));
                session.insert("title".into(), m.get("title").cloned().unwrap_or(Value::Null));
                call.meeting = Some(room.clone());
                call.organizer = as_obj(m.get("organizer")).map(|o| pj::text_of(o, "principal")).filter(|o| !o.is_empty());
                title = m.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned);
            }
            if call.organizer.is_none() && !guest {
                call.organizer = Some(person.clone());
            }
            if let Some(organizer) = call.organizer.clone() {
                let mut data = serde_json::json!({ "room": room, "organizer": organizer });
                if let Some(m) = &call.meeting {
                    data["meeting"] = Value::from(m.clone());
                }
                // free text: kept as is only; the transformed forms drop it (`api_events::derive`)
                if let Some(t) = title {
                    data["title"] = Value::from(t);
                }
                self.pa_event("meeting.started", data, organizer);
            }
            self.pa.calls.insert(room.clone(), call);
            session.insert("people".into(), Value::Array(Vec::new()));
            let slot = self.attendance.entry(room.clone()).or_insert_with(|| Value::Array(Vec::new()));
            if !slot.is_array() {
                *slot = Value::Array(Vec::new());
            }
            let list = slot.as_array_mut().expect("a session list");
            list.push(Value::Object(session));
            if list.len() > ATTEND_SESSIONS_MAX {
                let cut = list.len() - ATTEND_SESSIONS_MAX;
                list.drain(..cut);
            }
        }
        let session = self.pa_live(&room).expect("the live session");
        let people = list_mut(session, "people");
        let i = match people.iter().position(|r| r.get("principal").and_then(Value::as_str) == Some(key.as_str())) {
            Some(i) => {
                if let Some(row) = people[i].as_object_mut() {
                    row.insert("name".into(), Value::from(name));
                }
                i
            }
            None if people.len() >= ATTEND_PEOPLE_MAX => return,
            None => {
                let role = if guest { "guest" } else { "attendee" };
                people.push(Value::Object(obj([("principal", Value::from(key)), ("name", Value::from(name)), ("org", org), ("joins", Value::Array(Vec::new())), ("role", Value::from(role))])));
                people.len() - 1
            }
        };
        let joins = list_mut(people[i].as_object_mut().expect("a person"), "joins");
        let open = joins.last().and_then(|j| j.get(1)).map(Value::is_null).unwrap_or(false);
        if !open {
            if joins.len() >= ATTEND_JOINS_MAX {
                if let Some(slot) = joins.last_mut().and_then(Value::as_array_mut).and_then(|j| j.get_mut(1)) {
                    *slot = Value::Null;
                }
            } else {
                joins.push(Value::Array(vec![Value::from(now), Value::Null]));
            }
        }
        self.dirty = true;
        self.pa_attend_roles(&room);
        // revision 4 7.1: once per join interval (a second seat of the same person is no new join), with the role the
        // stage gave
        if !open {
            let role = self.pa_role(&room, &person);
            self.pa_member_event("member.joined", &room, &person, &role);
        }
    }

    /// The role attendance records for a person of the room's live session ("" when none).
    fn pa_role(&mut self, room: &str, key: &str) -> String {
        let row = self.pa_live(room).and_then(|s| s.get("people")?.as_array()?.iter().find(|r| r.get("principal").and_then(Value::as_str) == Some(key)).cloned());
        row.and_then(|r| r.get("role").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
    }

    /// Revision 4 7.1: a call event, kept for the event thread (the oldest goes past `CALL_EVENTS_MAX`). Revision 8
    /// 4.7: also `presence.changed` (meet_hub's `pr_flush`).
    pub(super) fn pa_event(&mut self, kind: &'static str, data: Value, owner: String) {
        if self.pa.events.len() >= CALL_EVENTS_MAX {
            self.pa.events.remove(0);
        }
        self.pa.events.push(CallEvent { kind, data, owner });
    }

    /// `member.joined` or `member.left` of an attendance key (a principal, or `guest:<id>`): a person's event is their
    /// org's, a guest's (`guest` the web guest's id) the organizer's; registry fields only.
    fn pa_member_event(&mut self, kind: &'static str, room: &str, key: &str, role: &str) {
        let organizer = self.pa.calls.get(room).and_then(|c| c.organizer.clone());
        let (field, value, owner) = match key.strip_prefix("guest:") {
            Some(id) => ("guest", id.to_owned(), organizer),
            None => ("principal", key.to_owned(), Some(key.to_owned())),
        };
        let Some(owner) = owner else { return };
        let mut data = serde_json::json!({ "room": room });
        data[field] = Value::from(value);
        if !role.is_empty() {
            data["role"] = Value::from(role);
        }
        self.pa_event(kind, data, owner);
    }

    /// _attend_out: a seat left: the person's open join interval closes unless another of their seats is still in.
    pub(super) fn pa_attend_out(&mut self, peer: &Peer) {
        if peer.admission_pending {
            return;
        }
        let key = attend_key(&peer.who);
        if self.peers.values().any(|p| p.room == peer.room && !p.admission_pending && attend_key(&p.who) == key) {
            return;
        }
        let now = ms_now();
        let Some(session) = self.pa_live(&peer.room) else { return };
        let Some(row) = session.get_mut("people").and_then(Value::as_array_mut).and_then(|l| l.iter_mut().find(|r| r.get("principal").and_then(Value::as_str) == Some(key.as_str()))) else { return };
        let role = row.get("role").and_then(Value::as_str).unwrap_or_default().to_owned();
        let open = row.get_mut("joins").and_then(Value::as_array_mut).and_then(|j| j.last_mut()).and_then(Value::as_array_mut).and_then(|j| j.get_mut(1)).filter(|v| v.is_null());
        let closed = open.map(|slot| *slot = Value::from(now)).is_some();
        if closed {
            self.dirty = true;
            // revision 4 7.1: once per join interval
            self.pa_member_event("member.left", &peer.room, &key, &role);
        }
    }

    /// _attend_end: the room is empty: its live session ends.
    pub(super) fn pa_attend_end(&mut self, room: &str) {
        let now = ms_now();
        let ended = self.pa_live(room).map(|session| {
            end_session(session, now);
            let start = pj::as_int(session.get("start")).unwrap_or(now);
            let rows = session.get("people").and_then(Value::as_array).cloned().unwrap_or_default();
            let guests = rows.iter().filter(|r| r.get("role").and_then(Value::as_str) == Some("guest")).count();
            (start, rows.len() - guests, guests)
        });
        if let Some((start, people, guests)) = ended {
            self.dirty = true;
            // revision 4 7.1: counts only (who was in is in the attendance and the member events)
            let call = self.pa.calls.remove(room).unwrap_or_default();
            if let Some(organizer) = call.organizer {
                let mut data = serde_json::json!({ "room": room, "duration_s": (now - start).max(0) / 1000, "people": people, "guests": guests });
                if let Some(m) = call.meeting {
                    data["meeting"] = Value::from(m);
                }
                self.pa_event("meeting.ended", data, organizer);
            }
        }
    }

    /// _attend_roles: the live session's roles from the stage: "host" for anyone who held the host role, "cohost" for
    /// a co-organizer present (roles only go up; a guest stays "guest").
    pub(super) fn pa_attend_roles(&mut self, room: &str) {
        if !self.attendance.contains_key(room) {
            return;
        }
        let host = self.stage_host(room).and_then(|h| self.peers.get(&h)).filter(|p| !p.admission_pending).map(|p| attend_key(&p.who));
        let present: Vec<String> = self
            .peers
            .values()
            .filter(|p| p.room == room && !p.admission_pending && !p.who.guest && self.pa_is_cohost(room, &p.who.principal))
            .map(|p| p.who.principal.clone())
            .collect();
        let Some(session) = self.pa_live(room) else { return };
        let mut changed = false;
        for row in session.get_mut("people").and_then(Value::as_array_mut).into_iter().flatten().filter_map(Value::as_object_mut) {
            let key = pj::text_of(row, "principal");
            let role = pj::text_of(row, "role");
            let next = if role == "guest" || role == "host" {
                None
            } else if host.as_deref() == Some(key.as_str()) {
                Some("host")
            } else if role == "attendee" && present.contains(&key) {
                Some("cohost")
            } else {
                None
            };
            if let Some(next) = next {
                row.insert("role".into(), Value::from(next));
                changed = true;
            }
        }
        if changed {
            self.dirty = true;
        }
    }

    // ── custom emoji ──

    fn pa_tell_all(&mut self, event: &Obj) {
        for s in self.sessions.values_mut() {
            push(&mut s.seq, &mut s.events, event);
        }
    }

    /// Keep an emoji image under its hash (once).
    fn pa_emoji_keep(&mut self, hash: &str, data: &[u8]) -> R<()> {
        let Some(dir) = &self.pa.emoji_dir else {
            self.pa.emoji_mem.insert(hash.to_string(), data.to_vec());
            return Ok(());
        };
        let path = dir.join(hash);
        if path.is_file() {
            return Ok(());
        }
        let tmp = dir.join(format!("{hash}.tmp"));
        std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&tmp, data)).and_then(|()| std::fs::rename(&tmp, &path)).map_err(|e| E::Internal(format!("cannot keep emoji {hash}: {e}")))
    }

    /// Forget an emoji image no emoji uses any more.
    fn pa_emoji_forget(&mut self, hash: &str) {
        self.pa.emoji_mem.remove(hash);
        if let Some(dir) = &self.pa.emoji_dir {
            let _ = std::fs::remove_file(dir.join(hash));
        }
    }

    fn pa_emoji_bytes(&self, hash: &str) -> Option<Vec<u8>> {
        match &self.pa.emoji_dir {
            Some(dir) => std::fs::read(dir.join(hash)).ok(),
            None => self.pa.emoji_mem.get(hash).cloned(),
        }
    }
}

impl Hub {
    // ── call events (API-1 revision 4 7.1) ──

    /// The call events raised since the last call, each with the org whose signed policy covers its owner (events of
    /// owners no policy covers, a service or an unknown person, are dropped): `(org, type, data)` in order.
    pub fn api_take_events(&self) -> Vec<(String, &'static str, Value)> {
        let mut st = self.st.lock();
        if st.pa.events.is_empty() {
            return Vec::new();
        }
        let events = std::mem::take(&mut st.pa.events);
        let policies = st.pc_current();
        events
            .into_iter()
            .filter_map(|e| {
                let org = pc::covering(&policies, &e.owner).and_then(|p| p.get("org")).and_then(Value::as_str)?.to_owned();
                Some((org, e.kind, e.data))
            })
            .collect()
    }

    /// The call events waiting for the event thread (tests).
    #[cfg(test)]
    pub(crate) fn api_pending_events(&self) -> Vec<CallEvent> {
        self.st.lock().pa.events.clone()
    }

    // ── notification levels and sections (/v1/prefs) ──

    /// prefs_get (`GET /v1/prefs`): `{rev, notify, sections, channel_default}` of the caller.
    pub fn prefs_get(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.session(session, who)?;
        Ok(as_obj(st.prefs.get(&who.principal)).cloned().unwrap_or_else(prefs_default))
    }

    /// prefs_set (`POST /v1/prefs`): `{rev, notify?, sections?, channel_default?}`: `notify` patches the levels
    /// (`null` removes one), `sections` replaces the sections. A stale `rev` gets 409 `{error: "rev", rev}`. A change
    /// moves `rev` on and the person's sessions hear `prefs` `{rev}`.
    pub fn prefs_set(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        let Some(rev) = pj::as_int(body.get("rev")) else { return bad("rev must be a whole number") };
        let notify = notify_patch(body.get("notify"))?;
        let sections = sections(body.get("sections"))?;
        let default = channel_default(body.get("channel_default"))?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, bool)> {
            st.session(session, who)?;
            let current = as_obj(st.prefs.get(&who.principal)).cloned().unwrap_or_else(prefs_default);
            let have = pj::as_int(current.get("rev")).unwrap_or(0);
            if rev != have {
                return Err(E::ConflictInfo("rev".into(), obj([("rev", Value::from(have))])));
            }
            let mut next = current.clone();
            if let Some(patch) = notify {
                let levels = obj_mut(&mut next, "notify");
                for (key, level) in patch {
                    if level.is_null() {
                        levels.shift_remove(&key);
                    } else {
                        levels.insert(key, level);
                    }
                }
                if levels.len() > NOTIFY_MAX {
                    return bad(format!("at most {NOTIFY_MAX} conversation settings"));
                }
            }
            if let Some(list) = sections {
                next.insert("sections".into(), Value::Array(list));
            }
            if let Some(d) = default {
                next.insert("channel_default".into(), Value::from(d));
            }
            let changed = next != current;
            if changed {
                next.insert("rev".into(), Value::from(have + 1));
                st.prefs.insert(who.principal.clone(), Value::Object(next.clone()));
                st.dirty = true;
                st.tell(std::slice::from_ref(&who.principal), &obj([("type", Value::from("prefs")), ("rev", Value::from(have + 1))]), None);
            }
            Ok((next, changed))
        })();
        drop(st);
        self.wake();
        let (out, changed) = r?;
        if changed {
            log_info(&format!("prefs principal={} rev={}", who.principal, pj::as_int(out.get("rev")).unwrap_or(0)));
        }
        Ok(out)
    }

    // ── attendance (/v1/attendance) ──

    /// attendance (`GET /v1/attendance?room=`): `{sessions}` of the room's calls the caller may see: every one for
    /// relay admins and the scheduled meeting's organizer, else those where the caller was host or co-organizer.
    pub fn attendance(&self, session: &str, who: &Identity, room: &str) -> R<Obj> {
        let room = m::room_name(Some(&Value::from(room)))?;
        let st = self.st.lock();
        st.session(session, who)?;
        let organizer = as_obj(st.meetings.get(&room)).and_then(|m| as_obj(m.get("organizer"))).map(|o| pj::text_of(o, "principal"));
        let all = st.admins.contains(&who.principal) || organizer.as_deref() == Some(who.principal.as_str());
        let organized = |s: &Value| {
            s.get("people").and_then(Value::as_array).into_iter().flatten().any(|r| r.get("principal").and_then(Value::as_str) == Some(who.principal.as_str()) && matches!(r.get("role").and_then(Value::as_str), Some("host" | "cohost")))
        };
        let sessions: Vec<Value> = st.attendance.get(&room).and_then(Value::as_array).into_iter().flatten().filter(|s| all || organized(s)).cloned().collect();
        if !all && sessions.is_empty() {
            return forbidden(NOT_ORGANIZERS);
        }
        Ok(obj([("sessions", Value::Array(sessions))]))
    }

    // ── custom emoji (/v1/emoji) ──

    /// emoji_list (`GET /v1/emoji`): every custom emoji `[{name, hash, org, by, ts}]`, by name.
    pub fn emoji_list(&self, session: &str, who: &Identity) -> R<Vec<Value>> {
        let st = self.st.lock();
        st.session(session, who)?;
        let mut rows: Vec<&Obj> = st.emoji.values().filter_map(Value::as_object).collect();
        rows.sort_by_key(|r| pj::text_of(r, "name"));
        Ok(rows.into_iter().map(emoji_view).collect())
    }

    /// emoji_add (`POST /v1/emoji`, relay admins): `{name, image}`, a PNG or GIF (base64) of at most 128 by 128 and
    /// 256 KB under a new name. Every session hears `emoji`.
    pub fn emoji_add(&self, session: &str, who: &Identity, name: Body, image: Body) -> R<Obj> {
        let taken = || E::Conflict("that emoji name is taken".into());
        let name = {
            let st = self.st.lock();
            st.check_admin(session, who)?;
            let name = match name {
                Some(Value::String(n)) if emoji_name_ok(n) => n.clone(),
                _ => return bad(BAD_EMOJI_NAME),
            };
            if st.emoji.contains_key(&name) {
                return Err(taken());
            }
            name
        };
        let data = match image {
            Some(Value::String(t)) => pj::b64_strict(t),
            _ => None,
        };
        let Some(data) = data else { return bad("image must be base64") };
        if data.len() > EMOJI_BYTES_MAX {
            return bad("an emoji image is at most 256 KB");
        }
        let kind = emoji_kind(&data)?;
        let hash = crate::codec::sha256_hex(&data);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            if st.emoji.contains_key(&name) {
                return Err(taken());
            }
            if st.emoji.len() >= st.pa.emoji_max {
                return Err(E::Conflict(format!("this relay keeps at most {} custom emoji", st.pa.emoji_max)));
            }
            st.pa_emoji_keep(&hash, &data)?;
            let row = obj([
                ("name", Value::from(name.clone())),
                ("hash", Value::from(hash.clone())),
                ("type", Value::from(kind)),
                ("org", st.org(&who.principal)),
                ("by", Value::from(who.principal.clone())),
                ("ts", Value::from(ms_now())),
            ]);
            let view = emoji_view(&row);
            st.emoji.insert(name.clone(), Value::Object(row));
            st.dirty = true;
            st.pa_tell_all(&obj([("type", Value::from("emoji"))]));
            Ok(obj([("ok", Value::Bool(true)), ("emoji", view)]))
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("emoji added name={name} principal={} bytes={}", who.principal, data.len()));
        Ok(out)
    }

    /// emoji_delete (`POST /v1/emoji/delete`, relay admins): `{name}`. Every session hears `emoji`.
    pub fn emoji_delete(&self, session: &str, who: &Identity, name: Body) -> R<Obj> {
        let name = name.and_then(Value::as_str).unwrap_or_default().to_string();
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            st.check_admin(session, who)?;
            // a name that is not text names none (no emoji is named "")
            let Some(row) = st.emoji.shift_remove(&name) else { return Err(E::NotFound(NO_EMOJI.into())) };
            let hash = row.get("hash").and_then(Value::as_str).unwrap_or_default().to_string();
            if !st.emoji.values().any(|r| r.get("hash").and_then(Value::as_str) == Some(hash.as_str())) {
                st.pa_emoji_forget(&hash);
            }
            st.dirty = true;
            st.pa_tell_all(&obj([("type", Value::from("emoji"))]));
            Ok(())
        })();
        drop(st);
        self.wake();
        r?;
        log_info(&format!("emoji deleted name={} principal={}", kv(&name), who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// emoji_file (`GET /v1/emoji/file?hash=`): the image's type and bytes, and how it is served (public content,
    /// cached for good).
    pub fn emoji_file(&self, hash: &str) -> R<EmojiFile> {
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return bad("hash must be 64 hex");
        }
        let st = self.st.lock();
        let kind = st.emoji.values().find(|r| r.get("hash").and_then(Value::as_str) == Some(hash)).and_then(|r| r.get("type").and_then(Value::as_str).map(str::to_string));
        let Some(kind) = kind else { return Err(E::NotFound(NO_EMOJI_HASH.into())) };
        let Some(data) = st.pa_emoji_bytes(hash) else { return Err(E::NotFound(NO_EMOJI_HASH.into())) };
        drop(st);
        let headers = vec![
            ("Content-Type", format!("image/{kind}")),
            ("Content-Length", data.len().to_string()),
            ("Cache-Control", EMOJI_CACHE.to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Content-Security-Policy", "default-src 'none'".to_string()),
        ];
        Ok((headers, data))
    }

    /// _custom_reaction: true when a reaction names a custom emoji the relay has (`:name:`), false for any other text
    /// (an ordinary emoji, held to EMOJI_MAX characters); 400 for a custom name it does not have.
    pub(super) fn pa_custom_reaction(&self, emoji: &str) -> R<bool> {
        let Some(name) = custom_name(emoji) else { return Ok(false) };
        if self.st.lock().emoji.contains_key(name) {
            return Ok(true);
        }
        bad(NO_EMOJI)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversation_keys() {
        for good in ["dm:ann@x", "channel:c-1", "room:daily", "meeting:m-abcdefghij", "dm:a:b", "dm:x\n"] {
            assert!(conv_key_ok(good), "{good:?}");
        }
        let long = format!("dm:{}", "a".repeat(198));
        for wrong in ["", "dm:", "dm", "group:x", "dm:a b", "DM:x", "dm:\t", long.as_str()] {
            assert!(!conv_key_ok(wrong), "{wrong:?}");
        }
        assert!(conv_key_ok(&format!("dm:{}", "a".repeat(197))));
    }

    #[test]
    fn forwarded_message() {
        assert_eq!(fwd(None).unwrap(), None);
        assert_eq!(fwd(Some(&Value::Null)).unwrap(), None);
        let good = json!({"kind": "dm", "ts": 5, "conv": "Ann", "name": "Ben"});
        assert_eq!(Value::Object(fwd(Some(&good)).unwrap().unwrap()), json!({"name": "Ben", "conv": "Ann", "ts": 5, "kind": "dm"}));
        let long = "x".repeat(101);
        for wrong in [
            json!("x"),
            json!({"name": "a", "conv": "b", "ts": 1}),
            json!({"name": "a", "conv": "b", "ts": 1, "kind": "dm", "x": 1}),
            json!({"name": "a", "conv": "b", "ts": 1.5, "kind": "dm"}),
            json!({"name": "a", "conv": "b", "ts": true, "kind": "dm"}),
            json!({"name": "a", "conv": "b", "ts": -1, "kind": "dm"}),
            json!({"name": "a", "conv": "b", "ts": 1, "kind": "mail"}),
            json!({"name": long, "conv": "b", "ts": 1, "kind": "dm"}),
            json!({"name": 1, "conv": "b", "ts": 1, "kind": "dm"}),
        ] {
            assert_eq!(fwd(Some(&wrong)).unwrap_err().message(), BAD_FWD, "{wrong}");
        }
    }

    #[test]
    fn status_until_window() {
        let now = ms_now();
        assert_eq!(status_until(None).unwrap(), None);
        assert_eq!(status_until(Some(&json!(now + 120_000))).unwrap(), Some(now + 120_000));
        for wrong in [json!(now + 1000), json!(now + 8 * 86_400_000), json!("soon"), json!(true), json!((now + 120_000) as f64 + 0.5)] {
            assert_eq!(status_until(Some(&wrong)).unwrap_err().message(), BAD_UNTIL, "{wrong}");
        }
        assert!(status_live(&json!({"state": "busy", "text": ""}), now));
        assert!(status_live(&json!({"state": "busy", "text": "", "until": now + 1}), now));
        assert!(!status_live(&json!({"state": "busy", "text": "", "until": now}), now));
    }

    #[test]
    fn prefs_parts() {
        let patch = notify_patch(Some(&json!({"dm:ann@x": "off", "channel:c": null}))).unwrap().unwrap();
        assert_eq!(patch, vec![("dm:ann@x".to_string(), json!("off")), ("channel:c".to_string(), Value::Null)]);
        assert_eq!(notify_patch(Some(&json!(["x"]))).unwrap_err().message(), "notify must map conversations to levels");
        assert_eq!(notify_patch(Some(&json!({"x": "off"}))).unwrap_err().message(), BAD_CONV);
        assert_eq!(notify_patch(Some(&json!({"dm:a": "loud"}))).unwrap_err().message(), "level must be all, mentions or off");
        let made = sections(Some(&json!([{"id": "s-0123abcd", "name": "  Team  ", "convs": ["dm:a"]}]))).unwrap().unwrap();
        assert_eq!(made, vec![json!({"id": "s-0123abcd", "name": "Team", "convs": ["dm:a"]})]);
        let cases = [
            (json!({}), BAD_SECTIONS.to_string()),
            (json!([{"id": "s-0123abcd", "name": "a"}]), BAD_SECTIONS.to_string()),
            (json!([{"id": "s-0123ABCD", "name": "a", "convs": []}]), "section id must be s- and 8 hex digits".to_string()),
            (json!([{"id": "s-0123abcd", "name": "a", "convs": []}, {"id": "s-0123abcd", "name": "b", "convs": []}]), "each section needs its own id".to_string()),
            (json!([{"id": "s-0123abcd", "name": " ", "convs": []}]), "a section name is 1 to 40 characters".to_string()),
            (json!([{"id": "s-0123abcd", "name": "a", "convs": ["x"]}]), BAD_CONV.to_string()),
        ];
        for (wrong, error) in cases {
            assert_eq!(sections(Some(&wrong)).unwrap_err().message(), error, "{wrong}");
        }
        let many: Vec<Value> = (0..21).map(|i| json!({"id": format!("s-{i:08x}"), "name": "a", "convs": []})).collect();
        assert_eq!(sections(Some(&Value::Array(many))).unwrap_err().message(), "at most 20 sections");
        let convs: Vec<Value> = (0..251).map(|i| json!(format!("dm:{i}"))).collect();
        let big = json!([{"id": "s-00000001", "name": "a", "convs": convs}, {"id": "s-00000002", "name": "b", "convs": convs}]);
        assert_eq!(sections(Some(&big)).unwrap_err().message(), "at most 500 conversations in sections");
        assert_eq!(channel_default(Some(&json!("mentions"))).unwrap(), Some("mentions".into()));
        assert_eq!(channel_default(Some(&json!("off"))).unwrap_err().message(), "channel_default must be all or mentions");
        let kept = stored_prefs(&json!({"rev": 3, "notify": {"dm:a": "off"}, "sections": [{"id": "s-0123abcd", "name": " Team ", "convs": []}], "channel_default": "mentions", "x": 1})).unwrap();
        assert_eq!(Value::Object(kept), json!({"rev": 3, "notify": {"dm:a": "off"}, "sections": [{"id": "s-0123abcd", "name": "Team", "convs": []}], "channel_default": "mentions"}));
        for wrong in [
            json!({"rev": -1, "notify": {}, "sections": [], "channel_default": "all"}),
            json!({"rev": 1, "notify": {"bad": "off"}, "sections": [], "channel_default": "all"}),
            json!({"rev": 1, "notify": {"dm:b": "loud"}, "sections": [], "channel_default": "all"}),
            json!({"rev": 1, "notify": {}, "sections": "x", "channel_default": "all"}),
            json!({"rev": 1, "notify": {}, "channel_default": "all"}),
            json!({"rev": 1, "notify": {}, "sections": [], "channel_default": "off"}),
        ] {
            assert!(stored_prefs(&wrong).is_none(), "{wrong}");
        }
    }

    #[test]
    fn emoji_images_and_names() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 64, 0, 0, 0, 32]);
        assert_eq!(emoji_kind(&png).unwrap(), "png");
        let mut wide = png.clone();
        wide[16..20].copy_from_slice(&129u32.to_be_bytes());
        assert_eq!(emoji_kind(&wide).unwrap_err().message(), "an emoji image is at most 128 by 128 pixels");
        let gif = b"GIF89a\x80\x00\x10\x00".to_vec();
        assert_eq!(emoji_kind(&gif).unwrap(), "gif");
        let big_gif = b"GIF87a\x81\x00\x10\x00".to_vec();
        assert!(emoji_kind(&big_gif).is_err());
        assert_eq!(emoji_kind(b"\xff\xd8\xff\xe0 jpeg").unwrap_err().message(), "an emoji image must be PNG or GIF");
        let (z32, z33) = ("z".repeat(32), "z".repeat(33));
        for good in ["ok", "party_parrot", "a-1", z32.as_str()] {
            assert!(emoji_name_ok(good), "{good}");
        }
        for wrong in ["a", "Party", "a b", "a.b", z33.as_str(), "é1"] {
            assert!(!emoji_name_ok(wrong), "{wrong}");
        }
        assert_eq!(custom_name(":party_parrot:"), Some("party_parrot"));
        assert_eq!(custom_name("👍"), None);
        assert_eq!(custom_name(":A:"), None);
    }

    #[test]
    fn attendance_sessions_from_state() {
        let raw = json!({"id": "abc", "start": 1000, "end": null, "people": [
            {"principal": "ann@x", "name": "Ann", "org": null, "joins": [[1000, 2000], [3000, null]], "role": "host"},
            {"principal": "ben@x", "name": "Ben", "org": null, "joins": [[1100, 2500]], "role": "attendee"}
        ]});
        let mut s = stored_session(&raw).unwrap();
        assert_eq!(session_last(&s), 3000);
        end_session(&mut s, 3000);
        assert_eq!(Value::Object(s), json!({"id": "abc", "start": 1000, "end": 3000, "people": [
            {"principal": "ann@x", "name": "Ann", "org": null, "joins": [[1000, 2000], [3000, 3000]], "role": "host"},
            {"principal": "ben@x", "name": "Ben", "org": null, "joins": [[1100, 2500]], "role": "attendee"}
        ]}));
        for wrong in [
            json!({"id": 1, "start": 1, "end": null, "people": []}),
            json!({"id": "a", "start": 1, "people": []}),
            json!({"id": "a", "start": 1, "end": null, "people": [{"principal": "a", "name": "A", "joins": [["x", 1]], "role": "host"}]}),
            json!({"id": "a", "start": 1, "end": null, "people": [{"principal": "a", "name": "A", "joins": [], "role": "boss"}]}),
        ] {
            assert!(stored_session(&wrong).is_none(), "{wrong}");
        }
        assert_eq!(session_last(&stored_session(&json!({"id": "a", "start": 7, "end": null, "people": []})).unwrap()), 7);
        assert!(stored_emoji("party", &json!({"name": "party", "hash": "0".repeat(64), "type": "png", "org": "x", "by": "ann@x", "ts": 1})).unwrap()["org"].is_null());
        assert!(stored_emoji("party", &json!({"name": "party", "hash": "0".repeat(64), "type": "jpeg", "by": "ann@x", "ts": 1})).is_none());
        let guest = Identity { principal: format!("guest-0123456789abcdef{}", m::GUEST_DOMAIN), guest: true, ..Default::default() };
        assert_eq!(attend_key(&guest), "guest:0123456789abcdef");
        assert_eq!(attend_key(&Identity { principal: "ann@x".into(), ..Default::default() }), "ann@x");
    }

    // ── through the hub ──────────────────────────────────────────────────────────────────────────────────────

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    /// ann@x is a relay admin.
    fn hub() -> Hub {
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    fn session(h: &Hub, w: &Identity) -> String {
        h.hello(w, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string()
    }

    fn inbox(h: &Hub, s: &str) -> Vec<Obj> {
        h.st.lock().sessions[s].events.iter().cloned().collect()
    }

    fn peer_of(joined: &Obj) -> String {
        joined["peer"].as_str().unwrap().to_string()
    }

    fn error<T>(r: R<T>) -> String {
        match r {
            Err(e) => e.message(),
            Ok(_) => "ok".into(),
        }
    }

    fn body(v: Value) -> Obj {
        v.as_object().cloned().unwrap()
    }

    fn act(h: &Hub, peer: &str, w: &Identity, action: &str, target: Option<&str>, up: Option<bool>) -> R<Obj> {
        let (action, target, up) = (json!(action), target.map(|t| json!(t)), up.map(Value::Bool));
        h.stage(peer, w, Some(&action), target.as_ref(), up.as_ref(), None)
    }

    fn png(side: u32) -> String {
        let mut d = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        d.extend_from_slice(&side.to_be_bytes());
        d.extend_from_slice(&side.to_be_bytes());
        d.extend_from_slice(b"rest of it");
        pj::b64(&d)
    }

    #[test]
    fn prefs_sync_across_a_persons_sessions_by_revision() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let (s1, s2) = (session(&h, &ben), session(&h, &who("ben@x", "cccccccccccccccc")));
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let sa = session(&h, &ann);
        assert_eq!(Value::Object(h.prefs_get(&s1, &ben).unwrap()), json!({"rev": 0, "notify": {}, "sections": [], "channel_default": "all"}));
        let set = h.prefs_set(&s1, &ben, &body(json!({"rev": 0, "notify": {"dm:ann@x": "off", "channel:c-1": "mentions"}, "channel_default": "mentions"}))).unwrap();
        assert_eq!(Value::Object(set), json!({"rev": 1, "notify": {"dm:ann@x": "off", "channel:c-1": "mentions"}, "sections": [], "channel_default": "mentions"}));
        for s in [&s1, &s2] {
            let last = inbox(&h, s).pop().unwrap();
            assert_eq!((&last["type"], &last["rev"]), (&json!("prefs"), &json!(1)));
        }
        assert!(inbox(&h, &sa).iter().all(|e| e["type"] != json!("prefs")), "only the person's own sessions hear prefs");
        match h.prefs_set(&s2, &ben, &body(json!({"rev": 0, "notify": {"dm:ann@x": null}}))) {
            Err(E::ConflictInfo(m, info)) => assert_eq!((m.as_str(), Value::Object(info)), ("rev", json!({"rev": 1}))),
            other => panic!("{other:?}"),
        }
        let removed = h.prefs_set(&s2, &ben, &body(json!({"rev": 1, "notify": {"dm:ann@x": null}, "sections": [{"id": "s-0000000a", "name": "Team", "convs": ["channel:c-1"]}]}))).unwrap();
        assert_eq!((&removed["rev"], &removed["notify"]), (&json!(2), &json!({"channel:c-1": "mentions"})));
        assert_eq!(removed["sections"][0]["name"], json!("Team"));
        // nothing changes: no new revision, nobody hears it
        let before = inbox(&h, &s1).len();
        assert_eq!(h.prefs_set(&s1, &ben, &body(json!({"rev": 2, "notify": {"dm:ann@x": null}}))).unwrap()["rev"], json!(2));
        assert_eq!(inbox(&h, &s1).len(), before);
        assert_eq!(error(h.prefs_set(&s1, &ben, &body(json!({"rev": "2"})))), "rev must be a whole number");
        assert_eq!(error(h.prefs_set(&s1, &ben, &body(json!({"rev": 2, "notify": {"dm:ann@x": "loud"}})))), "level must be all, mentions or off");
        assert_eq!(error(h.prefs_get("gone", &ben)), "not connected (the relay ended this session); say hello again");
    }

    #[test]
    fn a_status_clears_itself_at_until() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let s = session(&h, &ben);
        let until = ms_now() + 120_000;
        let set = h.set_status(&s, &ben, Some(&json!("busy")), Some(&json!("Focus")), Some(&json!(until))).unwrap();
        assert_eq!(set["status"], json!({"state": "busy", "text": "Focus", "until": until}));
        assert_eq!(inbox(&h, &s).pop().unwrap()["status"]["until"], json!(until));
        assert_eq!(error(h.set_status(&s, &ben, Some(&json!("busy")), None, Some(&json!(ms_now() + 1000)))), BAD_UNTIL);
        // automatic ignores until
        assert_eq!(h.set_status(&s, &ben, Some(&json!("auto")), None, Some(&json!("x"))).unwrap()["status"], Value::Null);
        h.set_status(&s, &ben, Some(&json!("dnd")), None, Some(&json!(until))).unwrap();
        // its time came: dropped on read, then the sweep clears it and everyone hears presence
        h.st.lock().statuses.get_mut("ben@x").unwrap()["until"] = json!(ms_now() - 1);
        assert_eq!(h.st.lock().status_of("ben@x"), Value::Null);
        h.st.lock().pa_status_sweep();
        assert!(!h.st.lock().statuses.contains_key("ben@x"));
        let cleared = inbox(&h, &s).pop().unwrap();
        assert_eq!((&cleared["type"], &cleared["status"]), (&json!("presence"), &Value::Null));
    }

    #[test]
    fn co_organizers_and_the_spotlight() {
        let h = hub();
        let (ben, cy, dee) = (who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"), who("dee@x", "dddddddddddddddd"));
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        let d = peer_of(&h.join("ops", &dee, "", false, None).unwrap());
        assert_eq!(error(act(&h, &c, &cy, "spotlight", Some(&d), None)), NOT_HOST);
        assert_eq!(error(act(&h, &b, &ben, "cohost", Some(&c), None)), "up must be true or false");
        assert_eq!(error(act(&h, &b, &ben, "cohost", None, Some(true))), "say whom to cohost (target)");
        let made = act(&h, &b, &ben, "cohost", Some(&c), Some(true)).unwrap();
        assert_eq!(made["stage"]["cohosts"], json!(["cy@x"]));
        let heard = h.st.lock().peers[&d].events.back().cloned().unwrap();
        assert_eq!((&heard["type"], &heard["why"], &heard["by"]), (&json!("stage"), &json!("cohost"), &json!("ben@x")));
        // a co-organizer has every host power but make_host and cohost
        let lit = act(&h, &c, &cy, "spotlight", Some(&d), None).unwrap();
        assert_eq!(lit["stage"]["spotlight"], json!(d));
        assert_eq!(error(act(&h, &c, &cy, "make_host", Some(&d), None)), NOT_HOST);
        assert_eq!(error(act(&h, &c, &cy, "cohost", Some(&d), Some(true))), NOT_HOST);
        act(&h, &c, &cy, "mute", Some(&d), None).unwrap();
        // the spotlight goes with its peer
        h.leave(&d, &dee).unwrap();
        assert_eq!(h.st.lock().stage_view("ops")["spotlight"], json!(""));
        // a rejoin keeps the co-organizer; the host takes it back
        let c2 = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        assert!(h.st.lock().pa_hosts("ops", &c2));
        assert_eq!(act(&h, &b, &ben, "cohost", Some(&c2), Some(false)).unwrap()["stage"]["cohosts"], json!([]));
        assert!(!h.st.lock().pa_hosts("ops", &c2));
        assert_eq!(act(&h, &b, &ben, "spotlight", None, None).unwrap()["stage"]["spotlight"], json!(""));
        // never a guest, at most COHOSTS_MAX
        h.st.lock().peers.get_mut(&c2).unwrap().who.guest = true;
        assert_eq!(error(act(&h, &b, &ben, "cohost", Some(&c2), Some(true))), NOT_COHOST_GUEST);
        h.st.lock().stage_mut("ops").insert("cohosts".into(), json!(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]));
        assert_eq!(error(act(&h, &b, &ben, "cohost", Some(&b), Some(true))), COHOSTS_FULL);
    }

    #[test]
    fn attendance_follows_each_call_session() {
        let h = hub();
        let (ann, ben, cy) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"));
        let (sa, sb, sc) = (session(&h, &ann), session(&h, &ben), session(&h, &cy));
        assert_eq!(error(h.attendance(&sb, &ben, "ops")), NOT_ORGANIZERS);
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        h.leave(&c, &cy).unwrap();
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        let live = h.attendance(&sb, &ben, "ops").unwrap();
        let s = &live["sessions"][0];
        assert_eq!(s.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "start", "end", "people"]);
        assert_eq!(s["end"], Value::Null);
        assert_eq!((&s["people"][0]["principal"], &s["people"][0]["role"]), (&json!("ben@x"), &json!("host")));
        assert_eq!((&s["people"][1]["principal"], &s["people"][1]["role"]), (&json!("cy@x"), &json!("attendee")));
        assert_eq!(s["people"][1]["joins"].as_array().unwrap().len(), 2);
        assert!(s["people"][1]["joins"][0][1].is_i64() && s["people"][1]["joins"][1][1].is_null());
        assert_eq!(error(h.attendance(&sc, &cy, "ops")), NOT_ORGANIZERS);
        h.leave(&c, &cy).unwrap();
        h.leave(&b, &ben).unwrap();
        let done = h.attendance(&sb, &ben, "ops").unwrap();
        assert!(done["sessions"][0]["end"].is_i64() && done["sessions"][0]["people"][1]["joins"][1][1].is_i64());
        // relay admins see every session; the next call is a session of its own
        assert_eq!(h.attendance(&sa, &ann, "ops").unwrap()["sessions"].as_array().unwrap().len(), 1);
        peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        assert_eq!(h.attendance(&sa, &ann, "ops").unwrap()["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(h.attendance(&sb, &ben, "ops").unwrap()["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(h.hello(&ben, "", &Obj::new()).unwrap()["attendance"], json!(true));
        // off: nothing is kept, and calls say so
        h.st.lock().pa.attendance = false;
        peer_of(&h.join("off", &ben, "", false, None).unwrap());
        assert!(!h.st.lock().attendance.contains_key("off"));
        assert_eq!(h.join("off", &cy, "", false, None).unwrap()["options"]["attendance"], json!(false));
    }

    /// API-1 revision 4 7.1: one `meeting.started` and one `meeting.ended` per call session, a `member.joined` and a
    /// `member.left` per join interval, registry fields only, none while attendance is off; events whose owner no
    /// signed policy covers reach no org. A person has one seat per room: joining from another device moves the seat,
    /// which closes the join interval and opens a new one, as attendance records it.
    #[test]
    fn calls_raise_their_events_once_with_registry_fields_only() {
        let h = hub();
        let (ben, cy, cy2) = (who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"), who("cy@x", "dddddddddddddddd"));
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        let c2 = peer_of(&h.join("ops", &cy2, "", false, None).unwrap());
        assert!(h.leave(&c, &cy).is_err(), "the second device took the seat over");
        h.leave(&c2, &cy2).unwrap();
        h.leave(&b, &ben).unwrap();
        let got = h.api_pending_events();
        let kinds: Vec<&str> = got.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, ["meeting.started", "member.joined", "member.joined", "member.left", "member.joined", "member.left", "member.left", "meeting.ended"]);
        assert_eq!((&got[0].data, got[0].owner.as_str()), (&json!({"room": "ops", "organizer": "ben@x"}), "ben@x"));
        let who_of = |i: usize| got[i].data["principal"].as_str();
        assert_eq!((who_of(1), who_of(2), who_of(3), who_of(4), who_of(5), who_of(6)), (Some("ben@x"), Some("cy@x"), Some("cy@x"), Some("cy@x"), Some("cy@x"), Some("ben@x")));
        assert_eq!((got[2].owner.as_str(), got[7].owner.as_str()), ("cy@x", "ben@x"), "a person's own org; the organizer's for the call");
        assert_eq!((&got[7].data["people"], &got[7].data["guests"], got[7].data["duration_s"].is_i64()), (&json!(2), &json!(0), true));
        for e in &got {
            let f = crate::api_events::check_emit("r_00000000000000a1", e.kind, &e.data).unwrap_or_else(|why| panic!("{}: {why}", e.kind));
            assert!(e.data.as_object().unwrap().keys().all(|k| ["room", "meeting", "title", "organizer", "duration_s", "people", "guests", "principal", "guest", "role"].contains(&k.as_str())));
            assert_eq!(f["data"], e.data);
        }
        // nothing while attendance is off
        h.st.lock().pa.attendance = false;
        let off = peer_of(&h.join("off", &ben, "", false, None).unwrap());
        h.leave(&off, &ben).unwrap();
        assert_eq!(h.api_pending_events().len(), 8);
        // no signed policy covers these people here: taken, and no org gets them
        assert!(h.api_take_events().is_empty());
        assert!(h.api_pending_events().is_empty());
    }

    #[test]
    fn a_meeting_names_its_co_organizers() {
        let h = hub();
        let (ben, cy) = (who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"));
        let (sb, sc) = (session(&h, &ben), session(&h, &cy));
        let start = json!(pj::now() + 3600.0);
        let end = json!(pj::now() + 7200.0);
        let create = |cohosts: Value| h.meeting_create(&sb, &ben, Some(&json!("Plan")), Some(&start), Some(&end), Some(&json!(["cy@x"])), None, None, None, Some(&cohosts), None);
        assert_eq!(error(create(json!("cy@x"))), "cohosts must be a list of people");
        let many: Vec<String> = (0..11).map(|i| format!("p{i}@x")).collect();
        assert_eq!(error(create(json!(many))), MEETING_COHOSTS_FULL);
        assert_eq!(error(create(json!(["zed@x"]))), "not known on this relay: zed@x");
        let made = create(json!(["CY@x", "ben@x", "cy@x"])).unwrap();
        assert_eq!(made["cohosts"], json!(["cy@x"]));
        let room = made["room"].as_str().unwrap().to_string();
        let b = peer_of(&h.join(&room, &ben, "", false, None).unwrap());
        let c = peer_of(&h.join(&room, &cy, "", false, None).unwrap());
        assert!(h.st.lock().pa_hosts(&room, &c));
        let heard = h.st.lock().peers[&b].events.back().cloned().unwrap();
        assert_eq!((&heard["type"], &heard["why"], &heard["by"]), (&json!("stage"), &json!("cohost"), &json!("cy@x")));
        let seen = h.attendance(&sc, &cy, &room).unwrap();
        assert_eq!((&seen["sessions"][0]["meeting_id"], &seen["sessions"][0]["title"]), (&json!(room), &json!("Plan")));
        assert_eq!(seen["sessions"][0]["people"][1]["role"], json!("cohost"));
        let changes = body(json!({"cohosts": []}));
        assert_eq!(h.meeting_update(&sb, &ben, Some(&json!(room)), &changes).unwrap()["cohosts"], json!([]));
    }

    #[test]
    fn custom_emoji_from_admins_for_everyone() {
        let h = hub();
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", "bbbbbbbbbbbbbbbb"));
        let (sa, sb) = (session(&h, &ann), session(&h, &ben));
        let (name, img) = (json!("party"), json!(png(64)));
        assert_eq!(error(h.emoji_add(&sb, &ben, Some(&name), Some(&img))), "only the person who issues certificates can do that");
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&json!("Party")), Some(&img))), BAD_EMOJI_NAME);
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&name), Some(&json!("not base64!")))), "image must be base64");
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&name), Some(&json!(png(129))))), "an emoji image is at most 128 by 128 pixels");
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&name), Some(&json!(pj::b64(&[0u8; 300 * 1024]))))), "an emoji image is at most 256 KB");
        let added = h.emoji_add(&sa, &ann, Some(&name), Some(&img)).unwrap();
        let view = added["emoji"].as_object().unwrap();
        assert_eq!(view.keys().collect::<Vec<_>>(), ["name", "hash", "org", "by", "ts"]);
        let hash = view["hash"].as_str().unwrap().to_string();
        assert_eq!((&view["by"], &view["org"]), (&json!("ann@x"), &Value::Null));
        let heard = inbox(&h, &sb).pop().unwrap();
        assert_eq!(heard.keys().collect::<Vec<_>>(), ["type", "seq"]);
        assert_eq!(heard["type"], json!("emoji"));
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&name), Some(&img))), "that emoji name is taken");
        assert_eq!(h.emoji_list(&sb, &ben).unwrap(), vec![added["emoji"].clone()]);
        let (headers, bytes) = h.emoji_file(&hash).unwrap();
        assert_eq!(headers[0], ("Content-Type", "image/png".to_string()));
        assert!(headers.contains(&("Cache-Control", EMOJI_CACHE.to_string())) && headers.contains(&("Content-Security-Policy", "default-src 'none'".to_string())));
        assert_eq!(pj::b64(&bytes), png(64));
        assert_eq!(error(h.emoji_file("abc")), "hash must be 64 hex");
        // reactions may name it
        assert!(h.pa_custom_reaction(":party:").unwrap());
        assert!(!h.pa_custom_reaction("👍").unwrap());
        assert_eq!(error(h.pa_custom_reaction(":nope:")), NO_EMOJI);
        h.emoji_delete(&sa, &ann, Some(&name)).unwrap();
        assert_eq!(error(h.emoji_file(&hash)), NO_EMOJI_HASH);
        assert_eq!(error(h.emoji_delete(&sa, &ann, Some(&name))), NO_EMOJI);
        h.st.lock().pa.emoji_max = 0;
        assert_eq!(error(h.emoji_add(&sa, &ann, Some(&name), Some(&img))), "this relay keeps at most 0 custom emoji");
    }
}
