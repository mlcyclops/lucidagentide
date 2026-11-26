// Phase C (ADR-0540): the Meet relay's state (meet_relay.Hub): rooms, peers and seats, presence sessions and their
// inboxes, room history with rseq and catch-up, direct messages, reactions, invitations, devices, the certificate
// mailboxes (renewals, enrollments, seed requests) and the admin queue, behind ONE lock and one condition variable as
// in the Python. The persistent parts are kept as the JSON values state.json holds, in the order Python's dicts keep
// them, so state.json moves between the two implementations.

use crate::meet::{self as m, bad, forbidden, kv, kv_of, log_info, log_warn, Identity, E, R};
use crate::meet_console::LinkStats;
use crate::meet_json::{self as pj, f, obj, with, Obj};
use crate::meet_tls::{SignerClient, SignerErr};
use crate::meet_x509::{pem_blocks, Cert, Csr};
use indexmap::IndexMap;
use parking_lot::{Condvar, Mutex};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// AC-2a 4.11 and 9.1 (`Hub::fleet_counts`): the relay's people, devices and calls, as counts for `meet/counts`.
#[derive(Clone, Debug, Default)]
pub struct FleetCounts {
    /// Every principal the relay holds (directory) or sees online.
    pub principals: Vec<String>,
    /// The principals online now.
    pub online: HashSet<String>,
    /// Every (principal, device) known or online.
    pub devices: Vec<(String, String)>,
    pub devices_online: usize,
    pub revoked: usize,
    /// Rooms with 2 or more participants.
    pub calls_active: usize,
    pub participants: usize,
    pub enrollments_waiting: usize,
}

// Scheduled meetings and conversations (channels, group chats, threads, pins, search): child modules, so they share
// the hub's one lock and its private state.
#[path = "meet_meetings.rs"]
mod meetings;
#[path = "meet_channels.rs"]
mod channels;
// Wave 3: each feature slice keeps its state and methods in its own child module (named with the slice's prefix,
// e.g. `files_`, so no slice shadows another); persisted state lives under `ext[<slice>]` (state.json key `ext`).
#[path = "meet_files.rs"]
pub mod files;
#[path = "meet_tools.rs"]
mod tools;
#[path = "meet_breakout.rs"]
mod breakout;
#[path = "meet_control.rs"]
mod control;
#[path = "meet_sfu.rs"]
mod sfu;
pub use sfu::{E2EE_BODY_MAX, E2EE_ROSTER_BODY_MAX};
#[path = "meet_guests.rs"]
pub mod guests;
#[path = "meet_bridge.rs"]
pub mod bridge;
#[path = "meet_chat_e2ee.rs"]
pub mod ce;
// Parity wave A (contract PA-1): prefs, status `until`, forwarded messages, co-organizers, attendance, custom emoji.
#[path = "meet_parity.rs"]
pub mod parity;
// Parity wave B (contract PB-1 section 5): iPhone alert pushes through APNs.
#[path = "meet_push.rs"]
pub mod push;
// Parity wave C (contract PC-1): org policies, app and archive sessions, legal holds, the SSO service, the enclave.
#[path = "meet_parity_c.rs"]
pub mod pc;
// PC-1 section 2: canvases and lists (/v1/docs/*).
#[path = "meet_pc_docs.rs"]
mod pc_docs;
// AI-1: who may use org AI, the personal-access audit and AI history (`ai:` conversations).
#[path = "meet_ai.rs"]
pub mod ai;
// WA-1 (web access): verified guests and guest rules, guests inside encryption, captions for others, web sessions.
#[path = "meet_web_access.rs"]
pub mod wa;
// API-1 revision 4 5.1: the relay end of `api-compliance-read`.
#[path = "meet_compliance.rs"]
pub mod compliance;

pub const PEER_TIMEOUT: f64 = 40.0;
pub const SESSION_TIMEOUT: f64 = 40.0;
/// PR-1 1.2: a push-registered person whose device was seen within this many days shows away (mobile).
pub const PRESENCE_MOBILE_DAYS: f64 = 7.0;
const ACTIVE_ERROR: &str = "active must be true or false";
const CHAT_KEEP: usize = 200;
const QUEUE_KEEP: usize = 500;
const PEER_MAX_PER_ROOM: usize = 8;
const ROOM_LOG_KEEP: usize = 2000;
const DM_KEEP: usize = 2000;
const DM_LIMIT_MAX: i64 = 500;
const INVITE_TTL: f64 = 2.0 * 3600.0;
const INVITE_MAX_TO: usize = 50;
const EMOJI_MAX: usize = 16;
const REACTIONS_MAX: usize = 32;
/// Characters of the quoted message a reply keeps (send time).
const REPLY_PREVIEW: usize = 140;
const MENTIONS_MAX: usize = 20;
/// Typing notices: one per sender and conversation this often.
const TYPING_EVERY: f64 = 2.0;
const STATUS_STATES: [&str; 4] = ["available", "busy", "dnd", "away"];
const STATUS_TEXT_MAX: usize = 100;
/// A granted request to present keeps the presenter slot this long.
const GRANT_TTL: f64 = 60.0;
/// Live reactions in a call: one per peer this often.
const CALL_REACT_EVERY: f64 = 0.5;
const STAGE_ACTIONS: [&str; 13] = ["present", "stop", "request", "cancel", "grant", "deny", "hand", "make_host", "mute", "remove", "react", "spotlight", "cohost"];
const NOT_HOST: &str = "only the host can do that";
const SAVE_EVERY: f64 = 2.0;
/// NT-1: the ring timer and the delayed pushes run this often (seconds).
const NT_TICK: f64 = 1.0;
const REAP_EVERY: f64 = 5.0;
const PRUNE_EVERY: f64 = 3600.0;
const STATE_FILE: &str = "state.json";
const CONFLICT_WINDOW: f64 = 25.0;
const SEED_KEEP: f64 = 8.0 * 86400.0;
const DENY_KEEP: f64 = 400.0 * 86400.0;
pub const LINK_LEVELS: [&str; 3] = ["full", "audio", "text"];
const CAPTION_LATE_MS: i64 = 8000;
const AGE_MS_MAX: i64 = 3600 * 1000;
const DUR_MS_MAX: i64 = 600 * 1000;
const CSEQ_MAX: i64 = (1 << 31) - 1;
const CSEQ_KEEP: usize = 256;
const CATCHUP_WINDOW: f64 = 15.0 * 60.0;
const CAPTIONS_BATCH_MAX: usize = 50;
const WEAK_LAPSE: f64 = 10.0;
const WEAK_LAPSE_TRIPS: f64 = 5.0;
const MERGE_WINDOW: f64 = 30.0;
pub const OLD_APP: &str = "this device runs an older app: approve it on the issuer's PC, or update the app and let it ask again";
pub const SIGNER_DOWN: &str = "the certificate server cannot be reached; use the issuer's PC";
const RECORDING_NOTICE: &str = "Encrypted recording stays on the recorder's device. Every participant must explicitly consent before recording.";
/// A late joiner still owes its consent to an active recorder: no room content until then.
const ADMISSION_FIRST: &str = "acknowledge recording before joining the call";

// ── call tally and link lines ────────────────────────────────────────────────────────────────────────────────

fn finite(v: Option<&Value>) -> Option<f64> {
    pj::as_num(v)
}

/// Python's round() to an int (half to even).
fn pyround(v: f64) -> i64 {
    v.round_ties_even() as i64
}

fn link_number(stats: &Obj, key: &str) -> String {
    finite(stats.get(key)).map(|v| pyround(v).to_string()).unwrap_or_else(|| "-".into())
}

fn quality_step(q: &Obj, key: &str) -> String {
    match pj::as_int(q.get(key)) {
        Some(v) if (0..=9).contains(&v) => v.to_string(),
        _ => "-".into(),
    }
}

fn codec_name(c: &Obj, key: &str) -> String {
    match c.get(key) {
        Some(Value::String(s)) => {
            let t: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').take(12).collect();
            if t.is_empty() { "-".into() } else { t }
        }
        _ => "-".into(),
    }
}

fn sub<'a>(data: &'a Obj, key: &str) -> std::borrow::Cow<'a, Obj> {
    match data.get(key) {
        Some(Value::Object(o)) => std::borrow::Cow::Borrowed(o),
        _ => std::borrow::Cow::Owned(Obj::new()),
    }
}

/// link_line: the `link` log line of one `state` signal.
pub fn link_line(room: &str, principal: &str, data: &Obj) -> String {
    let level = pj::s(data, "level");
    let level = if LINK_LEVELS.contains(&level.as_str()) { level } else { "unknown".into() };
    let reason = crate::meet_console::link_reason(data.get("reason"));
    let stats = sub(data, "stats");
    let quality = sub(data, "quality");
    let codecs = sub(data, "codecs");
    let (path, proto) = crate::meet_console::link_path(data);
    format!(
        "link room={room} principal={principal} level={level} reason={reason} rtt_ms={} base_ms={} loss_pct={} out_kbps={} path={} proto={} q={}/{} codec={}/{}",
        link_number(&stats, "rtt_ms"),
        link_number(&stats, "base_ms"),
        link_number(&stats, "loss_pct"),
        link_number(&stats, "out_kbps"),
        if path.is_empty() { "-" } else { &path },
        if proto.is_empty() { "-" } else { &proto },
        quality_step(&quality, "video"),
        quality_step(&quality, "audio"),
        codec_name(&codecs, "audio"),
        codec_name(&codecs, "video")
    )
}

/// How one seat's call went, for its `call_summary` log line.
#[derive(Clone, Debug)]
pub struct CallTally {
    started: f64,
    level: String,
    level_at: f64,
    seconds: [f64; 3],
    reports: i64,
    rtt_max: Option<f64>,
    base_max: Option<f64>,
    loss_max: Option<f64>,
    video_step: i64,
    audio_step: i64,
    codec_audio: Option<String>,
    codec_video: Option<String>,
    weak_n: i64,
    weak_since: Option<f64>,
    weak_s: f64,
    captions: i64,
    late: i64,
    age_max: i64,
}

impl CallTally {
    fn new() -> CallTally {
        CallTally {
            started: pj::mono(),
            level: String::new(),
            level_at: 0.0,
            seconds: [0.0; 3],
            reports: 0,
            rtt_max: None,
            base_max: None,
            loss_max: None,
            video_step: 0,
            audio_step: 0,
            codec_audio: None,
            codec_video: None,
            weak_n: 0,
            weak_since: None,
            weak_s: 0.0,
            captions: 0,
            late: 0,
            age_max: 0,
        }
    }

    fn at_level(&mut self, level: Option<&Value>, now: f64) {
        let Some(level) = level.and_then(Value::as_str).filter(|l| LINK_LEVELS.contains(l)) else { return };
        if let Some(i) = LINK_LEVELS.iter().position(|l| *l == self.level) {
            self.seconds[i] += (now - self.level_at).max(0.0);
        }
        self.level = level.to_string();
        self.level_at = now;
    }

    fn figures(&mut self, stats: Option<&Value>) {
        let Some(Value::Object(s)) = stats else { return };
        self.reports += 1;
        for (key, slot) in [("rtt_ms", &mut self.rtt_max), ("base_ms", &mut self.base_max), ("loss_pct", &mut self.loss_max)] {
            if let Some(v) = finite(s.get(key)) {
                if slot.map(|cur| v > cur).unwrap_or(true) {
                    *slot = Some(v);
                }
            }
        }
    }

    fn state(&mut self, data: &Obj) {
        let quality = sub(data, "quality");
        for (key, slot) in [("video", &mut self.video_step), ("audio", &mut self.audio_step)] {
            if let Ok(step) = quality_step(&quality, key).parse::<i64>() {
                if step > *slot {
                    *slot = step;
                }
            }
        }
        let codecs = sub(data, "codecs");
        for (key, slot) in [("audio", &mut self.codec_audio), ("video", &mut self.codec_video)] {
            let name = codec_name(&codecs, key);
            if name != "-" {
                *slot = Some(name);
            }
        }
    }

    fn weak(&mut self, on: bool, now: f64) {
        if on && self.weak_since.is_none() {
            self.weak_n += 1;
            self.weak_since = Some(now);
        } else if !on {
            if let Some(since) = self.weak_since.take() {
                self.weak_s += now - since;
            }
        }
    }

    fn caption(&mut self, line: &Obj) {
        self.captions += 1;
        if pj::truthy(line.get("late")) {
            self.late += 1;
        }
        if let Some(age) = pj::as_int(line.get("age_ms")) {
            if age > self.age_max {
                self.age_max = age;
            }
        }
    }

    fn summary(&mut self, now: f64) -> String {
        if !self.level.is_empty() {
            let level = Value::from(self.level.clone());
            self.at_level(Some(&level), now);
        }
        self.weak(false, now);
        let num = |v: Option<f64>| v.map(|x| pyround(x).to_string()).unwrap_or_else(|| "-".into());
        let secs = LINK_LEVELS.iter().zip(self.seconds.iter()).map(|(k, v)| format!("{k}_s={}", pyround(*v))).collect::<Vec<_>>().join(" ");
        format!(
            "secs={} {secs} reports={} rtt_ms_max={} base_ms_max={} loss_pct_max={} q_max={}/{} codec={}/{} weak_n={} weak_s={} captions={} late={} age_ms_max={}",
            pyround(now - self.started),
            self.reports,
            num(self.rtt_max),
            num(self.base_max),
            num(self.loss_max),
            self.video_step,
            self.audio_step,
            self.codec_audio.as_deref().unwrap_or("-"),
            self.codec_video.as_deref().unwrap_or("-"),
            self.weak_n,
            pyround(self.weak_s),
            self.captions,
            self.late,
            self.age_max
        )
    }
}

// ── peers and sessions ───────────────────────────────────────────────────────────────────────────────────────

pub struct Peer {
    pub peer_id: String,
    pub room: String,
    pub who: Identity,
    pub last_seen: f64,
    seq: i64,
    events: VecDeque<Obj>,
    pub joined: f64,
    pub recording: bool,
    recording_paused: bool,
    /// The recorder's live request snapshot ({} when none): control state only, never room history.
    recording_request: Obj,
    /// peer id -> its answer to this recorder's request (the recorder's own policy acknowledgement included).
    recording_replies: IndexMap<String, bool>,
    /// A late joiner who has not yet accepted every active recorder: no members, media or room content.
    admission_pending: bool,
    pub address: String,
    pub client: Obj,
    captions: IndexMap<i64, Obj>,
    reported_weak: bool,
    lapsed: bool,
    weak: bool,
    polls: i64,
    poll_end: f64,
    clock_gap: Option<f64>,
    relay_rtt: Option<f64>,
    tally: CallTally,
    /// Monotonic: its last live reaction (CALL_REACT_EVERY).
    react_at: f64,
    /// The seat's client certificate PEM, the leaf as presented in its mTLS handshake ("" for a web guest). Live only:
    /// never in state.json.
    cert: String,
    /// Its join said `e2ee: true` (it can encrypt frames itself).
    e2ee: bool,
    /// Large calls (contract E2EE-1): its ephemeral public key for this stay and the signature over it, base64, opaque
    /// to the relay ("" until it publishes). Live only, never logged.
    epk: String,
    epk_sig: String,
    /// WA-1 section 5.1: the join's `caps` (None: an app that sent none, which captions itself) and how many others
    /// it may caption (`caption_others_max`).
    caps: Option<Vec<String>>,
    cap_max: i64,
    /// CD-1: the presence session id its join proved (`session`), "" when none. Copy detection skips this peer for
    /// a request that proves the same live session. Live only.
    session: String,
}

impl Peer {
    pub fn public(&self) -> Obj {
        obj([("peer", Value::from(self.peer_id.clone())), ("name", Value::from(self.who.name.clone())), ("principal", Value::from(self.who.principal.clone()))])
    }
}

pub struct Session {
    pub session_id: String,
    pub who: Identity,
    pub since: f64,
    pub last_seen: f64,
    seq: i64,
    events: VecDeque<Obj>,
    pub address: String,
    pub client: Obj,
    waiters: i64,
    /// PR-1 1.1: the person is using this device (hello `active`, `/v1/activity`).
    pub active: bool,
}

/// The NT-1 release of the apps: a session of an older `hub` or `ios` app is not told of an invitation that does
/// not ring (MV-2).
const NT1_APPS: &str = "0.97.0";

/// MV-2: the session's client is a pre-NT-1 app (`hub` or `ios` below NT1_APPS).
fn pre_nt1(client: &Obj) -> bool {
    matches!(pj::s(client, "app").as_str(), "hub" | "ios") && m::version_key(&pj::s(client, "version")) < m::version_key(NT1_APPS)
}

/// MV-2: whether a session with this client hears of the invitation (a silent one skips a pre-NT-1 app).
fn hears_invite(client: &Obj, inv: &Obj) -> bool {
    inv.get("ring") != Some(&Value::Bool(false)) || !pre_nt1(client)
}

fn push(seq: &mut i64, events: &mut VecDeque<Obj>, event: &Obj) {
    *seq += 1;
    let mut e = event.clone();
    e.insert("seq".into(), Value::from(*seq));
    events.push_back(e);
    while events.len() > QUEUE_KEEP {
        events.pop_front();
    }
}

fn seq_of(e: &Obj) -> i64 {
    pj::as_int(e.get("seq")).unwrap_or(0)
}

struct Stay {
    start: f64,
    seen: IndexMap<String, f64>,
    late_history: bool,
    /// The stay id of the call's chat (cid `room:<room>:<chat_stay>`; meet_chat_e2ee), "" until a join starts it.
    chat_stay: String,
    /// The newest signed catch-up option of the call's chat (meet_chat_e2ee::ce_catchup).
    chat_catchup: Option<Obj>,
    /// WA-1 section 5.1: seat -> the seat captioning it (null: nobody), the captioner service asked, and removed.
    captioning: Obj,
    caption_requested: bool,
    captioner_removed: bool,
}

impl Stay {
    fn new(start: f64, seen: IndexMap<String, f64>, late_history: bool) -> Stay {
        Stay { start, seen, late_history, chat_stay: String::new(), chat_catchup: None, captioning: Obj::new(), caption_requested: false, captioner_removed: false }
    }
}

struct Moved {
    principal: String,
    event: Obj,
    at: f64,
}

/// The final queue of a peer or session removed while a poll waited on it.
struct GoneQueue {
    events: VecDeque<Obj>,
    waiters: i64,
}

type Lines = IndexMap<String, Vec<Obj>>;
/// PR-1 1.1: a hello's or `/v1/activity`'s `active`; a missing one is `absent` (hello: true) or refused (None).
pub fn parse_active(v: Option<&Value>, absent: Option<bool>) -> R<bool> {
    match (v, absent) {
        (None, Some(d)) => Ok(d),
        (Some(Value::Bool(b)), _) => Ok(*b),
        _ => bad(ACTIVE_ERROR),
    }
}

/// (online, room, devices, presence, mobile).
type PState = (bool, String, Vec<(String, String, String)>, &'static str, bool);

pub struct State {
    pub peers: IndexMap<String, Peer>,
    pub sessions: IndexMap<String, Session>,
    pub alerts: Vec<Obj>,
    admins: Vec<String>,
    pub directory: Obj,
    dms: Lines,
    read: Obj,
    invites: Lines,
    rooms: Lines,
    left: Obj,
    renewals: Obj,
    renewed: Obj,
    enrollments: Obj,
    consumed_seeds: Obj,
    seed_requests: Obj,
    seeded: Obj,
    pub(crate) denied: Obj,
    moved: HashMap<String, Moved>,
    room_seq: HashMap<String, i64>,
    stays: HashMap<String, Stay>,
    gone: HashMap<String, GoneQueue>,
    pub dirty: bool,
    last_prune: f64,
    /// PR-1 1.4: when (wall seconds) the reaper last looked for an away (mobile) that ran out.
    mobile_checked: f64,
    history_s: f64,
    mail_s: f64,
    /// relay.json `recording_enabled` and `organizations` (principal -> {id, label}), set at start.
    pub recording_enabled: bool,
    pub organizations: Obj,
    /// principal -> {id, label} or null (removed): admins' organization changes (state.json), over relay.json's.
    org_edits: Obj,
    /// principal -> {state, text}.
    statuses: Obj,
    /// reader -> {other: ts}: the read marks the reader lets the other person see (DM read receipts).
    receipts: Obj,
    /// In memory: room -> its stage {host, presenter, grant, requests, hands}, from the first join until the room is
    /// empty.
    stages: HashMap<String, Obj>,
    /// In memory: (principal, conversation) -> monotonic time of the last typing notice.
    typing: HashMap<(String, String), f64>,
    /// meeting id (= its room) -> scheduled meeting (/v1/meetings): kept until it ends, while a recurrence is active,
    /// or mail_days after it was canceled.
    meetings: Obj,
    /// channel id -> {id, kind, name, topic, created_by, members, created, archived, last}.
    channels: Obj,
    /// channel id -> [message].
    channel_msgs: Lines,
    /// reader -> {channel id: ts}.
    channel_read: Obj,
    /// relay.json `channel_days` in seconds: channel and group chat message retention.
    channel_s: f64,
    /// Wave-3 feature slices: slice name -> its persisted state (state.json key `ext`).
    ext: Obj,
    /// In memory: unfinished file uploads and where kept files' bytes are.
    files: files::Files,
    /// In memory: room -> its whiteboard, until the room is empty.
    boards: HashMap<String, tools::Board>,
    /// In memory: main room -> its breakout plan.
    breakouts: IndexMap<String, breakout::Plan>,
    /// In memory: room -> its remote-control session, for the whole presentation.
    control: HashMap<String, control::Session>,
    /// The media server (large calls) and each stay's media mode.
    sfu: sfu::Sfu,
    /// In memory: the lobby, web guests and the guest port's rate limits.
    guests: guests::Guests,
    /// In memory: the bridges' relay.json policies, connector rate limits and the audit without a state folder
    /// (persisted state: ext["bridge"]).
    bridge: bridge::Bridge,
    /// In memory: chat encryption's settings and join and leave rate limit (persisted state: ext["ce"]).
    ce: ce::Ce,
    /// principal -> {rev, notify, sections, channel_default}: notification levels and chat list sections, synced
    /// across the person's devices (/v1/prefs).
    prefs: Obj,
    /// room -> [{id, start, end, meeting_id?, title?, people}]: the attendance of each call session (ms times).
    attendance: Obj,
    /// name -> {name, hash, type, org, by, ts}: custom emoji (the images in state_dir/emoji).
    emoji: Obj,
    /// In memory: parity wave A's settings and the emoji images without a state folder.
    pa: parity::Parity,
    /// principal -> {device: {token, env, ts, serial, seal, sk, seal_prev, sk_prev, voip, callkit}}: the iPhone devices
    /// registered for pushes (NT-1 section 3.2; the seal keys are guarded like push.secret).
    push_tokens: Obj,
    /// In memory: the APNs sender (None: push is off), the thread-id secret, the push rate books, the ring buckets and
    /// the NT-1 timers.
    pu: push::Push,
    /// In memory: parity wave C's settings, the verified org policy store, SSO answers and app icons without a state
    /// folder (persisted state: ext["pc"]).
    pc: pc::Pc,
    /// In memory: the canvases' and cursors' rate counters.
    pc_docs: pc_docs::DocsRate,
    /// In memory: WA-1's settings, web port sessions and challenges, guest conflicts (persisted state: ext["wa"]).
    wa: wa::Wa,
}

/// _empty_stage. `spotlight`: the peer everyone sees large ("" for none); `cohosts`: the co-organizers' principals.
fn empty_stage() -> Obj {
    obj([
        ("host", Value::Null),
        ("presenter", Value::Null),
        ("grant", Value::Null),
        ("requests", Value::Array(Vec::new())),
        ("hands", Value::Array(Vec::new())),
        ("spotlight", Value::from("")),
        ("cohosts", Value::Array(Vec::new())),
    ])
}

/// _expire_grant: a grant whose time ran out goes.
fn expire_grant(stage: &mut Obj, now: f64) -> bool {
    if let Some(Value::Object(g)) = stage.get("grant") {
        if pj::num(g, "until") <= now {
            stage.insert("grant".into(), Value::Null);
            return true;
        }
    }
    false
}

fn entry_peer(v: &Value) -> &str {
    v.get("peer").and_then(Value::as_str).unwrap_or_default()
}

fn list_mut<'a>(stage: &'a mut Obj, key: &str) -> &'a mut Vec<Value> {
    let slot = stage.entry(key.to_string()).or_insert_with(|| Value::Array(Vec::new()));
    if !slot.is_array() {
        *slot = Value::Array(Vec::new());
    }
    slot.as_array_mut().expect("a list")
}

/// _message_id: an optional message id (reply_to); None when absent.
fn message_id(v: Option<&Value>, what: &str) -> R<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if s.chars().count() <= 64 => Ok(Some(s.clone())),
        _ => bad(format!("{what} must be a message id")),
    }
}

/// _mentions: the principals a chat line mentions (absent: none), lower case, each once.
fn mentions(v: Option<&Value>) -> R<Vec<String>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a,
        _ => return bad("mentions must be a list of people"),
    };
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().unwrap_or_default().trim().to_lowercase();
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.len() > MENTIONS_MAX {
        return bad(format!("a message can mention at most {MENTIONS_MAX} people"));
    }
    Ok(out)
}

/// _receipt: `receipt` of a read mark; absent or null is true.
fn receipt(v: Option<&Value>) -> R<bool> {
    match v {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Bool(b)) => Ok(*b),
        _ => bad("receipt must be true or false"),
    }
}

/// _status: a presence status {state, text}; None for automatic (state absent, "" or auto).
fn status(state: Option<&Value>, text: Option<&Value>) -> R<Option<Obj>> {
    let state = match state {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) if s.is_empty() || s == "auto" => return Ok(None),
        Some(Value::String(s)) if STATUS_STATES.contains(&s.as_str()) => s.clone(),
        _ => return bad("state must be available, busy, dnd, away or auto"),
    };
    let text = match text {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => pj::squash(s),
        Some(_) => return bad("text must be a short text"),
    };
    if pj::char_len(&text) > STATUS_TEXT_MAX || !pj::printable(&text) {
        return bad(format!("a status is at most {STATUS_TEXT_MAX} printable characters"));
    }
    Ok(Some(obj([("state", Value::from(state)), ("text", Value::from(text))])))
}

/// _org_field: an organization id or label as an admin sends it.
fn org_field(v: Option<&Value>, what: &str) -> R<String> {
    match v {
        Some(Value::String(s)) => Ok(pj::squash(s)),
        _ => bad(format!("{what} must be a short text")),
    }
}

/// _preview: what a reply keeps of the message it answers: id, author and the start of it.
fn preview(target: &Obj, name: Option<&Value>) -> R<Obj> {
    if pj::truthy(target.get("deleted")) {
        return bad("that message was deleted");
    }
    Ok(obj([("id", Value::from(str_value(target.get("id")))), ("name", Value::from(pj::str_or(name))), ("text", Value::from(pj::clip(&pj::s(target, "text"), REPLY_PREVIEW)))]))
}

const SCOPE_ERROR: &str = "scope must be dm, room or channel";

/// A checked conversation (_conversation): the caller's room seat, the other person of a direct conversation, or a
/// channel (or group chat) the caller is a member of.
enum Conv {
    Room { peer: String, room: String },
    Dm(String),
    Channel(String),
}

fn obj_mut<'a>(map: &'a mut Obj, key: &str) -> &'a mut Obj {
    let slot = map.entry(key.to_string()).or_insert_with(|| Value::Object(Obj::new()));
    if !slot.is_object() {
        *slot = Value::Object(Obj::new());
    }
    slot.as_object_mut().expect("an object")
}

fn as_obj(v: Option<&Value>) -> Option<&Obj> {
    v.and_then(Value::as_object)
}

fn conv(a: &str, b: &str) -> String {
    let mut pair = [a, b];
    pair.sort();
    pair.join(" ")
}

/// _by_device: rows from before device ids were keyed by the principal alone and become device "".
fn by_device(rows: &Obj) -> Obj {
    let mut out = Obj::new();
    for (k, row) in rows {
        let Some(r) = row.as_object() else { continue };
        if r.contains_key("device") {
            out.insert(k.clone(), row.clone());
        } else {
            let mut r = r.clone();
            r.insert("device".into(), Value::from(""));
            r.insert("device_label".into(), Value::from(""));
            out.insert(m::key(k, ""), Value::Object(r));
        }
    }
    out
}

fn lines_of(v: Option<&Value>) -> Lines {
    let mut out = Lines::new();
    if let Some(Value::Object(o)) = v {
        for (k, list) in o {
            if let Value::Array(a) = list {
                out.insert(k.clone(), a.iter().filter_map(|i| i.as_object().cloned()).collect());
            }
        }
    }
    out
}

fn lines_value(l: &Lines) -> Value {
    Value::Object(l.iter().map(|(k, v)| (k.clone(), Value::Array(v.iter().cloned().map(Value::Object).collect()))).collect())
}

fn only_objects(v: Option<&Value>) -> Obj {
    as_obj(v).map(|o| o.iter().filter(|(_, v)| v.is_object()).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
}

impl State {
    fn push_peer(&mut self, id: &str, event: &Obj) {
        if let Some(p) = self.peers.get_mut(id) {
            push(&mut p.seq, &mut p.events, event);
        }
    }

    fn broadcast(&mut self, room: &str, event: &Obj, skip: Option<&str>) {
        let control = matches!(event.get("type").and_then(Value::as_str), Some("recording" | "recording_request" | "recording_consent" | "moved"));
        for p in self.peers.values_mut() {
            if p.room == room && Some(p.peer_id.as_str()) != skip {
                if p.admission_pending && !control {
                    continue;
                }
                push(&mut p.seq, &mut p.events, event);
            }
        }
    }

    fn tell(&mut self, principals: &[String], event: &Obj, skip: Option<&str>) {
        for s in self.sessions.values_mut() {
            if Some(s.session_id.as_str()) != skip && principals.contains(&s.who.principal) {
                push(&mut s.seq, &mut s.events, event);
            }
        }
    }

    fn tell_admins(&mut self, event: &Obj) {
        let admins = self.admins.clone();
        self.tell(&admins, event, None);
    }

    fn tell_device(&mut self, principal: &str, device: &str, event: &Obj) {
        for s in self.sessions.values_mut() {
            if s.who.principal == principal && s.who.device == device {
                push(&mut s.seq, &mut s.events, event);
            }
        }
    }

    /// _members: the people in `room` as a join answer names them ({peer, name, principal, org, cert?, ..., weak}).
    fn members(&self, room: &str) -> Vec<Value> {
        self.peers.values().filter(|p| p.room == room && !p.admission_pending).map(|p| Value::Object(with(&self.member(p), obj([("weak", Value::Bool(p.weak))])))).collect()
    }

    /// _member: a room seat as join answers (`you`, `members`) and `join` events name it: `person` plus `cert`, its
    /// client certificate PEM as presented in its mTLS handshake (absent for a seat without one: a web guest). Clients
    /// check it against their own CA before trusting a signed DTLS fingerprint (mesh) or ephemeral key (large call). A
    /// large call's rows add `epk` and `sig` (null until published).
    fn member(&self, p: &Peer) -> Obj {
        let mut out = self.person(p);
        if !p.cert.is_empty() {
            out.insert("cert".into(), Value::from(p.cert.clone()));
        }
        self.sfu_member(p, &mut out);
        self.wa_member(p, &mut out); // WA-1: a guest's key, bundle, verification, admission, rules
        out
    }

    fn member_of(&self, id: &str) -> Obj {
        self.peers.get(id).map(|p| self.member(p)).unwrap_or_default()
    }

    /// _org: this person's organization {id, label} (an admin's change over relay.json), null when none.
    fn org(&self, principal: &str) -> Value {
        let entry = match self.org_edits.get(principal) {
            Some(e) => Some(e),
            None => self.organizations.get(principal),
        };
        match entry.and_then(Value::as_object) {
            Some(o) => Value::Object(obj([("id", o.get("id").cloned().unwrap_or(Value::Null)), ("label", o.get("label").cloned().unwrap_or(Value::Null))])),
            None => Value::Null,
        }
    }

    /// _status_of: the person's status, null when automatic or once its `until` passed.
    fn status_of(&self, principal: &str) -> Value {
        let now = (pj::now() * 1000.0) as i64;
        self.statuses.get(principal).filter(|s| s.is_object() && parity::status_live(s, now)).cloned().unwrap_or(Value::Null)
    }

    /// _person: a room peer as join answers, join events and the stage name it ({peer, name, principal, org}, plus
    /// `guest: true`, `email` and `email_verified` for a web guest).
    fn person(&self, p: &Peer) -> Obj {
        let mut out = with(&p.public(), obj([("org", self.org(&p.who.principal))]));
        if p.who.guest {
            let rec = self.guests.rec.get(&guests::guest_id(&p.who.principal));
            out.insert("guest".into(), Value::Bool(true));
            out.insert("email".into(), Value::from(rec.map(|r| r.email.clone()).unwrap_or_default()));
            out.insert("email_verified".into(), Value::Bool(rec.is_some_and(|r| r.email_verified)));
        }
        out
    }

    fn person_of(&self, id: &str) -> Obj {
        self.peers.get(id).map(|p| self.person(p)).unwrap_or_default()
    }

    /// _presence_event.
    fn presence_event(&self, principal: &str, name: &str, state: &PState) -> Obj {
        obj([
            ("type", Value::from("presence")),
            ("principal", Value::from(principal)),
            ("name", Value::from(name)),
            ("online", Value::Bool(state.0)),
            ("room", Value::from(state.1.clone())),
            ("devices", Self::devices_value(&state.2)),
            ("org", self.org(principal)),
            ("status", self.status_of(principal)),
            ("presence", Value::from(state.3)),
            ("mobile", Value::Bool(state.4)),
        ])
    }

    /// _tell_presence: a `presence` event about this person to every session (their status or organization
    /// changed).
    fn tell_presence(&mut self, principal: &str) {
        let name = match self.directory.get(principal).and_then(Value::as_object) {
            Some(e) => {
                let n = pj::s(e, "name");
                if n.is_empty() { principal.to_string() } else { n }
            }
            None => principal.to_string(),
        };
        let state = self.pstate(principal);
        let event = self.presence_event(principal, &name, &state);
        for s in self.sessions.values_mut() {
            push(&mut s.seq, &mut s.events, &event);
        }
    }

    // ── the stage: host, presenter, requests to present, raised hands ──

    /// _stage: the room's stage, made when it has none.
    fn stage_mut(&mut self, room: &str) -> &mut Obj {
        self.stages.entry(room.to_string()).or_insert_with(empty_stage)
    }

    fn stage_host(&self, room: &str) -> Option<String> {
        self.stages.get(room).and_then(|s| s.get("host")).and_then(Value::as_str).map(str::to_string)
    }

    /// _stage_view: a copy of the room's stage as clients see it (an empty one when it has none).
    fn stage_view(&self, room: &str) -> Value {
        Value::Object(self.stages.get(room).cloned().unwrap_or_else(empty_stage))
    }

    /// _stage_view_ext: `stage_view` plus the wave-3 parts, each added by its slice only while it is active in this
    /// room.
    fn stage_view_ext(&mut self, room: &str) -> Value {
        let mut view = self.stage_view(room);
        if let Value::Object(v) = &mut view {
            self.breakout_stage_view(room, v);
            self.control_stage_view(room, v);
            self.guests_stage_view(room, v);
            self.sfu_stage_view(room, v);
            self.wa_stage_view(room, v);
        }
        view
    }

    /// _stage_event.
    fn stage_event(&mut self, room: &str, why: &str, by: &str, skip: Option<&str>) {
        self.pa_attend_roles(room);
        let event = obj([("type", Value::from("stage")), ("room", Value::from(room)), ("stage", self.stage_view_ext(room)), ("why", Value::from(why)), ("by", Value::from(by))]);
        self.broadcast(room, &event, skip);
    }

    /// _stage_entry.
    fn stage_entry(&self, id: &str, key: &str, at: f64) -> Value {
        Value::Object(with(&self.person_of(id), obj([(key, f(at))])))
    }

    /// _next_host: the longest-present admitted peer of `room`.
    fn next_host(&self, room: &str) -> Value {
        let mut best: Option<&Peer> = None;
        for p in self.peers.values().filter(|p| p.room == room && !p.admission_pending) {
            if best.map(|b| p.joined < b.joined).unwrap_or(true) {
                best = Some(p);
            }
        }
        best.map(|p| Value::from(p.peer_id.clone())).unwrap_or(Value::Null)
    }

    /// _stage_drop: a peer left: its presenter slot, grant, request and hand go; a leaving host's role passes to the
    /// longest-present peer. A seat taken over by a join (`takeover`) leaves the host empty for the join to fill.
    fn stage_drop(&mut self, peer: &Peer, why: &str, takeover: bool, by: &str) {
        let me = peer.peer_id.as_str();
        let next = self.next_host(&peer.room);
        let Some(stage) = self.stages.get_mut(&peer.room) else { return };
        let mut changed = false;
        for key in ["presenter", "grant"] {
            if stage.get(key).map(|v| v.is_object() && entry_peer(v) == me).unwrap_or(false) {
                stage.insert(key.into(), Value::Null);
                changed = true;
            }
        }
        for key in ["requests", "hands"] {
            let list = list_mut(stage, key);
            let before = list.len();
            list.retain(|e| entry_peer(e) != me);
            if list.len() != before {
                changed = true;
            }
        }
        if stage.get("host").and_then(Value::as_str) == Some(me) {
            stage.insert("host".into(), if takeover { Value::Null } else { next });
            changed = true;
        }
        if stage.get("spotlight").and_then(Value::as_str) == Some(me) {
            stage.insert("spotlight".into(), Value::from(""));
            changed = true;
        }
        if changed && !takeover {
            let by = if by.is_empty() { peer.who.principal.as_str() } else { by };
            self.stage_event(&peer.room, if why == "removed" { "remove" } else { "leave" }, by, None);
        }
    }

    fn set_weak(&mut self, id: &str, why: &str) {
        let Some(p) = self.peers.get_mut(id) else { return };
        let weak = p.reported_weak || p.lapsed;
        if weak == p.weak {
            return;
        }
        p.weak = weak;
        p.tally.weak(weak, pj::mono());
        let (room, principal) = (p.room.clone(), p.who.principal.clone());
        let event = obj([
            ("type", Value::from("weak")),
            ("peer", Value::from(id)),
            ("name", Value::from(p.who.name.clone())),
            ("principal", Value::from(principal.clone())),
            ("weak", Value::Bool(weak)),
            ("ts", f(pj::now())),
        ]);
        self.broadcast(&room, &event, None);
        log_info(&format!("weak room={room} principal={principal} {} why={why}", if weak { "on" } else { "off" }));
    }

    fn report_weak(&mut self, id: &str, weak: Option<bool>) {
        let Some(w) = weak else { return };
        if let Some(p) = self.peers.get_mut(id) {
            p.reported_weak = w;
        }
        self.set_weak(id, "reported");
    }

    fn rseq(&self, room: &str) -> i64 {
        if let Some(r) = self.room_seq.get(room) {
            return *r;
        }
        self.rooms.get(room).map(|lines| lines.iter().filter_map(|l| pj::as_int(l.get("rseq"))).max().unwrap_or(0)).unwrap_or(0).max(0)
    }

    /// _log: keep one line of the room's history (chat and caption lines get the room's next rseq).
    fn room_log(&mut self, room: &str, line: &mut Obj) {
        let kind = pj::text_of(line, "kind");
        if kind == "chat" || kind == "caption" {
            let next = self.rseq(room) + 1;
            self.room_seq.insert(room.to_string(), next);
            line.insert("rseq".into(), Value::from(next));
        }
        let lines = self.rooms.entry(room.to_string()).or_default();
        lines.push(line.clone());
        if lines.len() > ROOM_LOG_KEEP {
            let cut = lines.len() - ROOM_LOG_KEEP;
            lines.drain(..cut);
        }
        self.dirty = true;
    }

    fn seen(&mut self, who: &Identity) {
        // the console server, web guests, bridge connectors and services (apps, archives, SSO) are not people
        if who.is_console() || who.guest || who.connector || who.is_service() {
            return;
        }
        let now = pj::now();
        let mut devices = as_obj(self.directory.get(&who.principal)).and_then(|e| as_obj(e.get("devices"))).cloned().unwrap_or_default();
        if !who.device.is_empty() {
            let mut d = obj([("label", Value::from(who.device_label.clone())), ("last_seen", f(now))]);
            // AC-1 2.4 seats: when the record began, and the certificate it was last seen with
            let old = devices.get(&who.device).and_then(Value::as_object).cloned().unwrap_or_default();
            d.insert("added".into(), old.get("added").cloned().unwrap_or_else(|| f(now)));
            if !who.serial.is_empty() {
                d.insert("serial".into(), Value::from(m::serial(&who.serial)));
                d.insert("not_before".into(), Value::from(who.not_before));
                d.insert("not_after".into(), Value::from(who.not_after));
            } else {
                for k in ["serial", "not_before", "not_after"] {
                    if let Some(v) = old.get(k) {
                        d.insert(k.into(), v.clone());
                    }
                }
            }
            if who.kind == "web" {
                d.insert("web".into(), Value::Bool(true)); // WA-1 4.5: never a history share's target
            }
            devices.insert(who.device.clone(), Value::Object(d));
        }
        let mut entry = obj([("name", Value::from(who.name.clone())), ("last_seen", f(now))]);
        if !devices.is_empty() {
            entry.insert("devices".into(), Value::Object(devices));
        }
        self.directory.insert(who.principal.clone(), Value::Object(entry));
        self.dirty = true;
    }

    fn touch_device(&mut self, who: &Identity) {
        if who.device.is_empty() {
            return;
        }
        let slot = self.directory.get_mut(&who.principal).and_then(Value::as_object_mut).and_then(|e| e.get_mut("devices")).and_then(Value::as_object_mut).and_then(|d| d.get_mut(&who.device)).and_then(Value::as_object_mut);
        if let Some(d) = slot {
            d.insert("last_seen".into(), f(pj::now()));
            self.dirty = true;
        }
    }

    /// _devices: one entry per live device of this person, sorted by label then id.
    fn devices(&self, principal: &str) -> Vec<(String, String, String)> {
        let mut found: IndexMap<String, (String, String, String)> = IndexMap::new();
        for p in self.peers.values() {
            if p.who.principal == principal && !p.who.device.is_empty() {
                found.entry(p.who.device.clone()).or_insert((p.who.device.clone(), p.who.device_label.clone(), p.room.clone()));
            }
        }
        for s in self.sessions.values() {
            if s.who.principal == principal && !s.who.device.is_empty() {
                found.entry(s.who.device.clone()).or_insert((s.who.device.clone(), s.who.device_label.clone(), String::new()));
            }
        }
        let mut out: Vec<_> = found.into_values().collect();
        out.sort_by(|a, b| (a.1.to_lowercase(), &a.0).cmp(&(b.1.to_lowercase(), &b.0)));
        out
    }

    fn devices_value(d: &[(String, String, String)]) -> Value {
        Value::Array(d.iter().map(|(dev, label, room)| Value::Object(obj([("device", Value::from(dev.clone())), ("label", Value::from(label.clone())), ("room", Value::from(room.clone()))]))).collect())
    }

    fn pstate(&self, principal: &str) -> PState {
        let devices = self.devices(principal);
        let (presence, mobile) = self.presence_of(principal);
        if let Some(p) = self.peers.values().find(|p| p.who.principal == principal) {
            return (true, p.room.clone(), devices, presence, mobile);
        }
        if self.sessions.values().any(|s| s.who.principal == principal) {
            return (true, String::new(), devices, presence, mobile);
        }
        (false, String::new(), devices, presence, mobile)
    }

    /// PR-1 1.2: a person's automatic `(presence, mobile)`.
    fn presence_of(&self, principal: &str) -> (&'static str, bool) {
        if self.peers.values().any(|p| p.who.principal == principal) {
            return ("available", false);
        }
        let mut live = self.sessions.values().filter(|s| s.who.principal == principal).peekable();
        if live.peek().is_some() {
            return if live.any(|s| s.active) { ("available", false) } else { ("away", false) };
        }
        if self.pu_on() && self.mobile_seen(principal) >= pj::now() - PRESENCE_MOBILE_DAYS * 86400.0 {
            return ("away", true);
        }
        ("offline", false)
    }

    /// The newest directory `last_seen` of this person's push-registered devices (-inf without one).
    fn mobile_seen(&self, principal: &str) -> f64 {
        let Some(registered) = self.push_tokens.get(principal).and_then(Value::as_object) else { return f64::NEG_INFINITY };
        let seen = self.directory.get(principal).and_then(|e| e.get("devices")).and_then(Value::as_object);
        registered
            .keys()
            .filter_map(|d| seen.and_then(|s| s.get(d)).and_then(Value::as_object).map(|i| pj::num(i, "last_seen")))
            .fold(f64::NEG_INFINITY, f64::max)
    }

    /// A `presence` event about this person to every session when their state changed since `before` (a push
    /// registration added or removed, an away (mobile) that ran out).
    pub(crate) fn presence_changed(&mut self, principal: &str, before: &PState) {
        if self.pstate(principal) != *before {
            self.tell_presence(principal);
        }
    }

    /// PR-1 1.4: at most once an hour, the people whose away (mobile) ran out since the last check (their newest
    /// registered device passed PRESENCE_MOBILE_DAYS) are announced.
    fn mobile_expire(&mut self) {
        let now = pj::now();
        if now - self.mobile_checked < PRUNE_EVERY {
            return;
        }
        let (from, to) = (self.mobile_checked - PRESENCE_MOBILE_DAYS * 86400.0, now - PRESENCE_MOBILE_DAYS * 86400.0);
        self.mobile_checked = now;
        if !self.pu_on() {
            return;
        }
        let ran_out: Vec<String> = self
            .push_tokens
            .keys()
            .filter(|p| !self.peers.values().any(|x| x.who.principal == **p) && !self.sessions.values().any(|s| s.who.principal == **p))
            .filter(|p| {
                let seen = self.mobile_seen(p);
                seen >= from && seen < to
            })
            .cloned()
            .collect();
        for p in ran_out {
            self.tell_presence(&p);
        }
    }

    fn announce(&mut self, who: &Identity, before: &PState) {
        if who.is_console() || who.guest || who.connector || who.is_service() {
            return;
        }
        let after = self.pstate(&who.principal);
        if after == *before {
            return;
        }
        if !after.0 {
            if let Some(e) = self.directory.get_mut(&who.principal).and_then(Value::as_object_mut) {
                e.insert("last_seen".into(), f(pj::now()));
                self.dirty = true;
            }
        }
        let event = self.presence_event(&who.principal, &who.name, &after);
        for s in self.sessions.values_mut() {
            push(&mut s.seq, &mut s.events, &event);
        }
    }

    /// CD-1: `proof` if it names a live presence session of this principal and device, else "".
    fn proven_session(&self, who: &Identity, proof: &str) -> String {
        match self.sessions.get(proof) {
            Some(s) if !proof.is_empty() && !who.device.is_empty() && s.who.principal == who.principal && s.who.device == who.device => proof.to_string(),
            _ => String::new(),
        }
    }

    /// _check_copy: a device certificate active right now from another address is refused (409). CD-1: `proof` (a
    /// join's `session`, a hello's `resume`) naming a live session of this principal and device exempts that session
    /// and the peers joined with it; any other value is ignored.
    fn check_copy(&mut self, who: &Identity, address: &str, proof: &str) -> R<()> {
        if who.device.is_empty() || address.is_empty() {
            return Ok(());
        }
        let proof = self.proven_session(who, proof);
        let now = pj::mono();
        let others: Vec<(String, String, f64, String)> = self
            .sessions
            .values()
            .map(|s| (s.who.principal.clone(), s.who.device.clone(), s.last_seen, if !proof.is_empty() && s.session_id == proof { String::new() } else { s.address.clone() }))
            .chain(self.peers.values().map(|p| (p.who.principal.clone(), p.who.device.clone(), p.last_seen, if !proof.is_empty() && p.session == proof { String::new() } else { p.address.clone() })))
            .collect();
        let labels: Vec<String> = self.sessions.values().map(|s| s.who.device_label.clone()).chain(self.peers.values().map(|p| p.who.device_label.clone())).collect();
        for (i, (p, d, last, addr)) in others.iter().enumerate() {
            if *p != who.principal || *d != who.device || addr.is_empty() || addr == address || now - last > CONFLICT_WINDOW {
                continue;
            }
            let label = if who.device_label.is_empty() { labels[i].clone() } else { who.device_label.clone() };
            let event = obj([
                ("type", Value::from("device_conflict")),
                ("principal", Value::from(who.principal.clone())),
                ("device", Value::from(who.device.clone())),
                ("device_label", Value::from(label)),
                ("addresses", Value::from(vec![addr.clone(), address.to_string()])),
                ("ts", f(pj::now())),
            ]);
            let mut people = self.admins.clone();
            if !people.contains(&who.principal) {
                people.push(who.principal.clone());
            }
            self.tell(&people, &event, None);
            log_warn(&format!("device certificate in use from two places: principal={} device={} addresses={addr},{address}", who.principal, who.device));
            return Err(E::Conflict("this device's certificate is already signed in from another computer".into()));
        }
        Ok(())
    }

    /// _online: people online by principal; the console server, web guests and bridge connectors are not people.
    pub fn online(&self) -> IndexMap<String, Obj> {
        let mut out: IndexMap<String, Obj> = IndexMap::new();
        let mut add = |who: &Identity, since: f64, room: &str| {
            if who.is_console() || who.guest || who.connector || who.is_service() {
                return;
            }
            match out.get_mut(&who.principal) {
                None => {
                    out.insert(who.principal.clone(), obj([("principal", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone())), ("since", f(since)), ("room", Value::from(room))]));
                }
                Some(e) => {
                    let cur = pj::num(e, "since");
                    e.insert("since".into(), f(cur.min(since)));
                }
            }
        };
        for p in self.peers.values() {
            add(&p.who, p.joined, &p.room);
        }
        for s in self.sessions.values() {
            add(&s.who, s.since, "");
        }
        for (principal, e) in out.iter_mut() {
            e.insert("devices".into(), Self::devices_value(&self.devices(principal)));
            e.insert("org".into(), self.org(principal));
            e.insert("status".into(), self.status_of(principal));
            let (presence, mobile) = self.presence_of(principal);
            e.insert("presence".into(), Value::from(presence));
            e.insert("mobile".into(), Value::Bool(mobile));
        }
        out
    }

    /// _set_recording: announce a recorder's state; stopping ends its request and may admit late joiners.
    /// Consent and owner snapshots are live control state only, never relay history.
    fn set_recording(&mut self, id: &str, on: bool, paused: bool) {
        let Some(p) = self.peers.get_mut(id) else { return };
        p.recording = on;
        p.recording_paused = on && paused;
        let event = with(
            &p.recording_request,
            obj([
                ("type", Value::from("recording")),
                ("peer", Value::from(id)),
                ("name", Value::from(p.who.name.clone())),
                ("principal", Value::from(p.who.principal.clone())),
                ("on", Value::Bool(on)),
                ("paused", Value::Bool(p.recording_paused)),
            ]),
        );
        let room = p.room.clone();
        if !on {
            p.recording_request.clear();
            p.recording_replies.clear();
        }
        self.broadcast(&room, &event, None);
        if !on {
            self.admit_waiting(&room);
        }
    }

    /// _admit_waiting: a late joiner who has accepted every active recorder joins the call.
    fn admit_waiting(&mut self, room: &str) {
        let waiting: Vec<String> = self.peers.values().filter(|p| p.room == room && p.admission_pending).map(|p| p.peer_id.clone()).collect();
        for id in waiting {
            let accepted = self.peers.values().filter(|r| r.room == room && r.recording).all(|r| r.recording_replies.get(&id) == Some(&true));
            if !accepted {
                continue;
            }
            let Some(p) = self.peers.get_mut(&id) else { continue };
            p.admission_pending = false;
            let host_here = self.stage_host(room).map(|h| self.peers.contains_key(&h)).unwrap_or(false);
            if !host_here {
                // only waiting joiners were left
                self.stage_mut(room).insert("host".into(), Value::from(id.clone()));
            }
            let organizer = self.organizer_host(room, &id);
            let cohost = self.pa_meeting_cohost(room, &id);
            self.pa_attend_in(&id);
            let person = self.member_of(&id);
            let members: Vec<Value> = self.members(room).into_iter().filter(|m| m.get("peer").and_then(Value::as_str) != Some(id.as_str())).collect();
            let stage = self.stage_view_ext(room);
            self.push_peer(&id, &obj([("type", Value::from("recording_admitted")), ("members", Value::Array(members)), ("stage", stage)]));
            self.broadcast(room, &with(&obj([("type", Value::from("join"))]), person.clone()), Some(&id));
            if organizer || cohost {
                let by = pj::text_of(&person, "principal");
                self.stage_event(room, if organizer { "organizer" } else { "cohost" }, &by, Some(&id));
            }
            self.wa_recaption(room);
        }
    }

    /// _recording_owner: the organization the issuer names for this principal, else the person.
    fn recording_owner(&self, who: &Identity) -> Obj {
        if let Value::Object(org) = self.org(&who.principal) {
            return obj([("kind", Value::from("organization")), ("id", Value::from(pj::text_of(&org, "id"))), ("label", Value::from(pj::text_of(&org, "label")))]);
        }
        obj([("kind", Value::from("individual")), ("id", Value::from(who.principal.clone())), ("label", Value::from(who.name.clone()))])
    }

    /// _recording_peer: the caller's own peer, from the very certificate (device and serial) that joined.
    fn recording_peer(&self, id: &str, who: &Identity) -> R<()> {
        self.owned(id, who)?;
        let p = &self.peers[id];
        if p.who.device != who.device || p.who.serial != who.serial {
            return forbidden("recording controls belong to the joined certificate");
        }
        Ok(())
    }

    /// recording_policy (the caller's peer already checked): permission, ownership and the room's recorders and requests.
    fn recording_policy(&self, id: &str, who: &Identity) -> Obj {
        let p = &self.peers[id];
        let recorders: Vec<Value> = self
            .peers
            .values()
            .filter(|r| r.room == p.room && r.recording)
            .map(|r| Value::Object(with(&r.recording_request, obj([("on", Value::Bool(true)), ("paused", Value::Bool(r.recording_paused))]))))
            .collect();
        let requests: Vec<Value> = self.peers.values().filter(|r| r.room == p.room && !r.recording_request.is_empty() && !r.recording).map(|r| Value::Object(r.recording_request.clone())).collect();
        obj([
            ("allowed", Value::Bool(self.recording_enabled && !p.admission_pending)),
            ("owner", Value::Object(self.recording_owner(who))),
            ("notice", Value::from(RECORDING_NOTICE)),
            ("participant_consent_required", Value::Bool(true)),
            ("policy_acknowledgement_required", Value::Bool(true)),
            ("recorders", Value::Array(recorders)),
            ("requests", Value::Array(requests)),
            ("admission_pending", Value::Bool(p.admission_pending)),
        ])
    }

    /// _drop: remove a room peer. `by`: who removed them (the stage event names them; "" for the peer itself).
    fn drop_peer(&mut self, id: &str, why: &str, announce: bool, end_stay: bool, by: &str) {
        let Some(p) = self.peers.get(id) else { return };
        let before = self.pstate(&p.who.principal.clone());
        if p.recording || !p.recording_request.is_empty() {
            self.set_recording(id, false, false);
        }
        let Some(mut peer) = self.peers.shift_remove(id) else { return };
        if peer.polls > 0 {
            self.gone.insert(id.to_string(), GoneQueue { events: peer.events.clone(), waiters: peer.polls });
        }
        let now = pj::now();
        self.broadcast(&peer.room, &obj([("type", Value::from("leave")), ("peer", Value::from(id)), ("why", Value::from(why))]), None);
        let mut line = obj([
            ("kind", Value::from("leave")),
            ("id", Value::from(pj::token_hex(6))),
            ("peer", Value::from(id)),
            ("name", Value::from(peer.who.name.clone())),
            ("principal", Value::from(peer.who.principal.clone())),
            ("why", Value::from(why)),
            ("ts", f(now)),
        ]);
        self.room_log(&peer.room, &mut line);
        obj_mut(&mut self.left, &peer.who.principal).insert(peer.room.clone(), f(now));
        self.pa_attend_out(&peer);
        self.stage_drop(&peer, why, !end_stay, by);
        self.wave3_left(&peer, why);
        self.touch_device(&peer.who);
        if announce {
            self.announce(&peer.who, &before);
        }
        log_info(&format!("leave room={} principal={} peer={id} why={why}", peer.room, peer.who.principal));
        let c = |k: &str| {
            let v = pj::s(&peer.client, k);
            if v.is_empty() { "-".to_string() } else { v }
        };
        let (app, version, platform) = (c("app"), c("version"), c("platform"));
        log_info(&format!(
            "call_summary room={} principal={} peer={id} app={app} version={version} platform={platform} why={why} {}",
            peer.room,
            peer.who.principal,
            peer.tally.summary(pj::mono())
        ));
        if end_stay && !self.peers.values().any(|p| p.room == peer.room) {
            // NT-1 section 3.5: the inviter left and nobody is in the room: their open invitations to it are cancelled
            self.nt_left(&peer.who.principal, &peer.room);
            self.stages.remove(&peer.room);
            self.pa_attend_end(&peer.room);
            self.wave3_room_empty(&peer.room);
            if let Some(stay) = self.stays.remove(&peer.room) {
                if stay.late_history {
                    log_info(&format!("options room={} late_history=off why=empty", peer.room));
                }
            }
        }
    }

    fn end_session(&mut self, id: &str, why: &str, announce: bool) {
        let Some(s) = self.sessions.get(id) else { return };
        let before = self.pstate(&s.who.principal.clone());
        let Some(s) = self.sessions.shift_remove(id) else { return };
        if s.waiters > 0 {
            self.gone.insert(id.to_string(), GoneQueue { events: s.events.clone(), waiters: s.waiters });
        }
        self.touch_device(&s.who);
        if announce {
            self.announce(&s.who, &before);
        }
        log_info(&format!("bye principal={} session={id} why={why}", s.who.principal));
    }

    /// _session: the caller's live presence session.
    fn session(&self, id: &str, who: &Identity) -> R<()> {
        // AC-1 (I8): the Admin Console's in-process identity (Hub::check_console_admin; never from a certificate) has
        // no presence session; the per-principal rules that follow still apply to its principal
        if who.is_console() {
            return Ok(());
        }
        match self.sessions.get(id) {
            None => Err(E::Gone("not connected (the relay ended this session); say hello again".into())),
            Some(s) if s.who.principal != who.principal => forbidden("that session belongs to someone else"),
            Some(_) => Ok(()),
        }
    }

    /// owned: the caller's own peer.
    fn owned(&self, id: &str, who: &Identity) -> R<()> {
        match self.peers.get(id) {
            None => Err(E::Gone("not in a room (the relay dropped this session); join again".into())),
            Some(p) if p.who.principal != who.principal => forbidden("that session belongs to someone else"),
            Some(_) => Ok(()),
        }
    }

    fn check_admin(&self, session: &str, who: &Identity) -> R<()> {
        self.session(session, who)?;
        // AC-1 4.9: a console user manager's in-process reader identity (check_console_reader); console_meet.rs
        // passes it to read functions only
        if who.kind == m::CONSOLE_READER_KIND {
            return Ok(());
        }
        if !self.admins.contains(&who.principal) {
            return forbidden("only the person who issues certificates can do that");
        }
        Ok(())
    }

    fn unread(&self, principal: &str) -> Obj {
        let marks = as_obj(self.read.get(principal)).cloned().unwrap_or_default();
        let mut out = Obj::new();
        for msgs in self.dms.values() {
            for msg in msgs {
                let (to, from) = (pj::text_of(msg, "to"), pj::text_of(msg, "from"));
                if to == principal && from != principal && !pj::truthy(msg.get("deleted")) && pj::num(msg, "ts") > pj::as_num(marks.get(&from)).unwrap_or(0.0) {
                    let n = pj::as_int(out.get(&from)).unwrap_or(0) + 1;
                    out.insert(from, Value::from(n));
                }
            }
        }
        out
    }

    fn prune(&mut self, now: f64) {
        self.wave3_prune(now);
        let (hist_cut, mail_cut, invite_cut) = (now - self.history_s, now - self.mail_s, now - INVITE_TTL);
        let keep = |lines: &mut Lines, cut: f64| {
            for v in lines.values_mut() {
                v.retain(|l| pj::num(l, "ts") >= cut);
            }
            lines.retain(|_, v| !v.is_empty());
        };
        keep(&mut self.rooms, hist_cut);
        // PC-1: the longest of the members' signed retentions, capped by mail_days and channel_days; a held
        // conversation's pruned rows go to the hold store
        for key in self.dms.keys().cloned().collect::<Vec<_>>() {
            let rows = self.dms.get_mut(&key).map(std::mem::take).unwrap_or_default();
            let kept = self.pc_prune_rows(rows, now, Some(&key), None);
            if kept.is_empty() {
                self.dms.shift_remove(&key);
            } else if let Some(slot) = self.dms.get_mut(&key) {
                *slot = kept;
            }
        }
        let channel_cut = now - self.channel_s;
        for cid in self.channel_msgs.keys().cloned().collect::<Vec<_>>() {
            let rows = self.channel_msgs.get_mut(&cid).map(std::mem::take).unwrap_or_default();
            let kept = self.pc_prune_rows(rows, now, None, Some(&cid));
            if kept.is_empty() {
                self.channel_msgs.shift_remove(&cid);
            } else if let Some(slot) = self.channel_msgs.get_mut(&cid) {
                *slot = kept;
            }
        }
        // archived longer than the retention, nothing kept
        let msgs = &self.channel_msgs;
        self.channels.retain(|cid, ch| {
            let archived = ch.get("archived").and_then(|v| pj::as_num(Some(v))).unwrap_or(0.0);
            !(archived != 0.0 && archived < channel_cut && !msgs.contains_key(cid))
        });
        let channels = &self.channels;
        for v in self.channel_read.values_mut() {
            if let Some(o) = v.as_object_mut() {
                o.retain(|c, _| channels.contains_key(c));
            }
        }
        self.channel_read.retain(|_, v| v.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        keep(&mut self.invites, invite_cut);
        for v in self.left.values_mut() {
            if let Some(o) = v.as_object_mut() {
                o.retain(|_, t| pj::as_num(Some(t)).unwrap_or(0.0) >= hist_cut);
            }
        }
        self.left.retain(|_, v| v.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        let by_ts = |rows: &mut Obj, key: &str, cut: f64| rows.retain(|_, v| as_obj(Some(v)).map(|r| pj::num(r, key)).unwrap_or(0.0) >= cut);
        by_ts(&mut self.renewals, "ts", mail_cut);
        by_ts(&mut self.renewed, "ts", mail_cut);
        by_ts(&mut self.enrollments, "ts", mail_cut);
        let seed_cut = now - self.mail_s.max(SEED_KEEP);
        self.consumed_seeds.retain(|_, t| pj::as_num(Some(t)).unwrap_or(0.0) >= seed_cut);
        by_ts(&mut self.seed_requests, "ts", mail_cut);
        by_ts(&mut self.seeded, "ts", mail_cut);
        by_ts(&mut self.denied, "until", now);
        // scheduled meetings: until they end; a recurring one while its recurrence is active; a canceled one
        // mail_days after the cancel (so attendees still see it)
        self.meetings.retain(|_, m| {
            let Some(m) = m.as_object() else { return false };
            if pj::truthy(m.get("canceled")) {
                return pj::num(m, "canceled") >= mail_cut;
            }
            pj::text_of(m, "recurrence") != "none" || pj::num(m, "end") >= now
        });
        for entry in self.directory.values_mut() {
            let Some(e) = entry.as_object_mut() else { continue };
            if let Some(Value::Object(devices)) = e.get_mut("devices") {
                devices.retain(|_, i| i.as_object().map(|i| pj::num(i, "last_seen") >= mail_cut).unwrap_or(false));
            }
        }
        self.dirty = true;
    }

    fn snapshot(&self) -> String {
        let v = Value::Object(obj([
            ("v", Value::from(2)),
            ("directory", Value::Object(self.directory.clone())),
            ("dms", lines_value(&self.dms)),
            ("read", Value::Object(self.read.clone())),
            ("invites", lines_value(&self.invites)),
            ("rooms", lines_value(&self.rooms)),
            ("left", Value::Object(self.left.clone())),
            ("renewals", Value::Object(self.renewals.clone())),
            ("renewed", Value::Object(self.renewed.clone())),
            ("enrollments", Value::Object(self.enrollments.clone())),
            ("consumed_seeds", Value::Object(self.consumed_seeds.clone())),
            ("seed_requests", Value::Object(self.seed_requests.clone())),
            ("seeded", Value::Object(self.seeded.clone())),
            ("denied", Value::Object(self.denied.clone())),
            ("organizations", Value::Object(self.org_edits.clone())),
            ("status", Value::Object(self.statuses.clone())),
            ("receipts", Value::Object(self.receipts.clone())),
            ("meetings", Value::Object(self.meetings.clone())),
            ("channels", Value::Object(self.channels.clone())),
            ("channel_messages", lines_value(&self.channel_msgs)),
            ("channel_read", Value::Object(self.channel_read.clone())),
            ("prefs", Value::Object(self.prefs.clone())),
            ("emoji", Value::Object(self.emoji.clone())),
            ("attendance", Value::Object(self.attendance.clone())),
            ("push_tokens", Value::Object(self.push_tokens.clone())),
            ("ext", Value::Object(self.ext.clone())),
        ]));
        pj::dumps(&v)
    }

    fn drop_matching(&mut self, wanted: &HashSet<String>) -> i64 {
        let mut count = 0;
        let peers: Vec<String> = self.peers.values().filter(|p| !p.who.serial.is_empty() && wanted.contains(&m::serial(&p.who.serial))).map(|p| p.peer_id.clone()).collect();
        for id in peers {
            self.drop_peer(&id, "revoked", true, true, "");
            count += 1;
        }
        let sessions: Vec<String> = self.sessions.values().filter(|s| !s.who.serial.is_empty() && wanted.contains(&m::serial(&s.who.serial))).map(|s| s.session_id.clone()).collect();
        for id in sessions {
            self.end_session(&id, "revoked", true);
            count += 1;
        }
        count
    }
}

// ── wave 3: the hooks every feature slice answers (callers hold the lock) ───────────────────────────────────

impl State {
    /// _wave3_left: a peer left its room (any reason).
    fn wave3_left(&mut self, peer: &Peer, why: &str) {
        self.files_left(peer);
        self.control_left(peer, why);
        self.sfu_left(peer, why);
        self.guests_left(peer, why);
        self.wa_left(peer, why);
    }

    /// _wave3_room_empty: the last one left a room.
    fn wave3_room_empty(&mut self, room: &str) {
        self.tools_room_empty(room);
        self.breakout_room_empty(room);
        self.control_room_empty(room);
        self.sfu_room_empty(room);
        self.guests_room_empty(room);
        self.wa_room_empty(room);
    }

    /// _wave3_prune: the periodic prune (and the one at load), before the relay's own retention.
    fn wave3_prune(&mut self, now: f64) {
        self.files_prune(now);
        self.tools_prune();
        self.breakout_prune(now);
        self.control_prune();
        self.sfu_prune();
        self.guests_sweep();
        self.bridge_prune(now);
        self.ce_prune(now);
        self.pa_prune(now);
        self.pc_prune(now);
        self.ai_prune(now);
    }

    /// _wave3_each("may_join"): a slice may refuse a join (before any seat changes). `ext`: the join's body.
    fn wave3_may_join(&mut self, room: &str, who: &Identity, ext: &Obj) -> R<()> {
        self.breakout_may_join(room, who)?;
        self.sfu_may_join(room, who, ext)?;
        self.guests_may_join(room, who)?;
        self.bridge_may_join(who)?;
        self.wa_may_join(room, who, ext)
    }

    /// _wave3_each("stay_created"): the first join into an empty room started a stay.
    fn wave3_stay_created(&mut self, room: &str, who: &Identity, ext: &Obj) {
        self.sfu_stay_created(room, who, ext);
        self.ce_stay_created(room);
    }

    /// _wave3_cap: the room's people cap.
    fn wave3_cap(&self, room: &str) -> usize {
        self.sfu_cap(room)
    }

    /// _wave3_join_extra: what the slices add to (or replace in) a join answer.
    fn wave3_join_extra(&mut self, room: &str, peer_id: &str) -> Obj {
        let mut out = self.breakout_join_extra(room, peer_id);
        for part in [self.sfu_join_extra(room, peer_id), self.guests_join_extra(room, peer_id), self.ce_join_extra(room), self.wa_join_extra(room)] {
            for (k, v) in part {
                out.insert(k, v);
            }
        }
        out
    }
}

impl Hub {
    /// _wave3_configure: the slices' relay.json settings, once at start (Err: the setting the relay cannot use).
    pub fn wave3_configure(&self, s: &m::Settings) -> Result<(), String> {
        let mut st = self.st.lock();
        st.files.configure(s.file_max_mb, s.files_quota_gb);
        st.sfu_configure(s)?;
        st.guests_configure(s)?;
        st.bridge_configure(s)?;
        st.pa_configure(s);
        st.ce_configure(s)?;
        st.wa_configure(s)
    }

    /// _wave3_each("tick"), every reap: the media server's check against seats (on its own thread) and the guests'
    /// expiry and liveness sweep.
    pub fn wave3_tick(self: &Arc<Self>) {
        let mut st = self.st.lock();
        if let Some(sync) = st.sfu_tick(pj::now()) {
            let hub = self.clone();
            sfu::spawn("sfu-sync", move || hub.sfu_sync(sync));
        }
        if st.guests_on() {
            st.guests_sweep();
        }
        st.wa_tick(pj::now());
        drop(st);
        self.wake();
    }

    /// stage_ext: `POST /v1/stage` actions of the wave-3 slices (`breakout_*`, `control_*`, `lobby_*`), each answered
    /// by its slice.
    pub fn stage_ext(&self, peer_id: &str, who: &Identity, action: &str, body: &Obj) -> R<Obj> {
        if action.starts_with("breakout_") {
            return self.breakout_stage(peer_id, who, action, body);
        }
        if action.starts_with("control_") {
            return self.control_stage(peer_id, who, action, body);
        }
        if action.starts_with("lobby_") {
            return self.guests_stage(peer_id, who, action, body);
        }
        bad(format!("action must be one of {}", STAGE_ACTIONS.join(", ")))
    }
}

// ── certificate request helpers (meet_relay _load_csr and friends) ───────────────────────────────────────────

fn csr_blocks(text: &str) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = pem_blocks(text.as_bytes(), "CERTIFICATE REQUEST").into_iter().map(|b| b.1).collect();
    out.extend(pem_blocks(text.as_bytes(), "NEW CERTIFICATE REQUEST").into_iter().map(|b| b.1));
    out
}

/// _load_csr: a certificate request whose own signature verifies.
fn load_csr(pem: Option<&Value>) -> R<Csr> {
    let text = pj::str_or(pem);
    let csr = csr_blocks(&text).first().and_then(|der| Csr::from_der(der)).ok_or_else(|| E::Bad("that is not a certificate request".into()))?;
    if !csr.signature_valid() {
        return bad("the certificate request's signature does not verify");
    }
    Ok(csr)
}

/// _csr_identity: (CN, email) a request asks for: email SAN first, else emailAddress.
fn csr_identity(csr: &Csr) -> (String, String) {
    let name = csr.names.cns().first().cloned().unwrap_or_default();
    let mut emails = csr.names.emails.clone();
    if emails.is_empty() {
        emails = csr.names.subject_emails();
    }
    (name, emails.first().map(|e| e.trim().to_lowercase()).unwrap_or_default())
}

fn check_csr_person(csr: &Csr, who: &Identity) -> R<()> {
    let (name, email) = csr_identity(csr);
    if pj::clip(name.trim(), 80) != who.name || email != who.principal {
        return bad("the certificate request must carry your own name and email");
    }
    Ok(())
}

fn csr_device(csr: &Csr) -> (String, String) {
    let device = m::uri_value(&csr.names.uris, m::DEVICE_URI_PREFIX);
    if device.is_empty() {
        return (String::new(), String::new());
    }
    let label = csr.names.ous().first().map(|o| pj::clip(o.trim(), m::LABEL_MAX)).unwrap_or_default();
    (device, label)
}

fn cert_emails(cert: &Cert) -> Vec<String> {
    cert.names.emails.iter().map(|e| e.trim().to_lowercase()).collect()
}

/// _load_issued: (certificate, CA) the issuer posted: both parse and the CA names the issuer.
fn load_issued(cert_pem: Option<&Value>, ca_pem: Option<&Value>) -> R<(Cert, Cert)> {
    let parse = |v: Option<&Value>| Cert::from_pem(&pj::str_or(v));
    let (Some(cert), Some(ca)) = (parse(cert_pem), parse(ca_pem)) else { return bad("that is not a certificate") };
    if cert.issuer != ca.subject {
        return bad("the certificate was not issued by that CA");
    }
    Ok((cert, ca))
}

/// _csr_hash: SHA-256 (hex) of a request's DER, from its PEM ("" when none).
pub fn csr_hash(pem: &str) -> String {
    let first = pem_blocks(pem.as_bytes(), "CERTIFICATE REQUEST").into_iter()
        .chain(pem_blocks(pem.as_bytes(), "NEW CERTIFICATE REQUEST")).next();
    let Some((block, _)) = first else { return String::new() };
    let text = String::from_utf8_lossy(&block);
    let body: String = text.lines().filter(|l| !l.starts_with("-----")).collect::<String>().split_whitespace().collect();
    match pj::b64_strict(&body) {
        Some(der) => crate::codec::sha256_hex(&der),
        None => String::new(),
    }
}

/// meet_pki.check_code of a request's key: `"123 456"`.
fn check_code(pem: &str) -> String {
    let Some(csr) = csr_blocks(pem).first().and_then(|d| Csr::from_der(d)) else { return String::new() };
    let h = crate::codec::sha256(&csr.spki);
    let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000;
    let d = format!("{n:06}");
    format!("{} {}", &d[..3], &d[3..])
}

fn proof_ts(v: Option<&Value>) -> Value {
    pj::as_num(v).map(|x| Value::from(x.trunc() as i64)).unwrap_or(Value::Null)
}

fn proved(who: &Identity, chain: Option<&Value>, proof: Option<&Value>) -> bool {
    pj::truthy(chain) && pj::truthy(proof) && !who.cert_pem.is_empty()
}

fn proof_fields(who: &Identity, chain: Option<&Value>, proof: Option<&Value>, ts: Option<&Value>) -> Obj {
    if !proved(who, chain, proof) {
        return obj([("chain", Value::Bool(false))]);
    }
    obj([("chain", Value::Bool(true)), ("proof", Value::from(pj::py_str(proof.unwrap_or(&Value::Null)))), ("proof_ts", proof_ts(ts)), ("requester_pem", Value::from(who.cert_pem.clone()))])
}

fn issued(answer: &Obj) -> Obj {
    obj([("cert_pem", Value::from(pj::s(answer, "cert_pem"))), ("chain_pem", Value::from(pj::s(answer, "chain_pem"))), ("ca_pem", Value::from(pj::s(answer, "ca_pem")))])
}

fn cseq(v: Option<&Value>) -> R<Option<i64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        _ => match pj::as_int(v) {
            Some(n) if (1..=CSEQ_MAX).contains(&n) => Ok(Some(n)),
            _ => bad("cseq must be a whole number from 1"),
        },
    }
}

fn ms(v: Option<&Value>, what: &str, most: i64) -> R<Option<i64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        _ => match pj::as_num(v) {
            Some(x) => Ok(Some(x.max(0.0).min(most as f64).trunc() as i64)),
            None => bad(format!("{what} must be a number of milliseconds")),
        },
    }
}

fn update(row: &mut Obj, extra: Obj) {
    for (k, v) in extra {
        row.insert(k, v);
    }
}

fn str_value(v: Option<&Value>) -> String {
    pj::py_str(v.unwrap_or(&Value::Null))
}

/// _tombstone: delete the message at `i` of its conversation in place (callers hold the lock): no text, no reactions,
/// no quoted text, no pin, no link preview, no forward origin; replies quoting it and its edits lose the words too, and
/// a deleted thread reply leaves its root's counters. Shared by chat_change and a connector's delete.
fn tombstone(list: &mut [Obj], i: usize, now: f64) {
    let id = pj::text_of(&list[i], "id");
    let target = &mut list[i];
    target.insert("text".into(), Value::from(""));
    target.insert("deleted".into(), f(now));
    target.insert("reactions".into(), Value::Object(Obj::new()));
    target.shift_remove("pinned");
    target.shift_remove("preview");
    target.shift_remove("fwd");
    if let Some(Value::Object(q)) = target.get_mut("reply_to") {
        q.insert("text".into(), Value::from(""));
    }
    let root = pj::truthy(target.get("thread")).then(|| str_value(target.get("thread")));
    for msg in list.iter_mut() {
        if let Some(Value::Object(q)) = msg.get_mut("reply_to") {
            if q.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                q.insert("text".into(), Value::from(""));
            }
        }
        if pj::text_of(msg, "kind") == "chat_update" && pj::text_of(msg, "target") == id {
            msg.insert("text".into(), Value::from(""));
        }
    }
    if let Some(root) = root {
        channels::recount(list, &root);
    }
}

// ── the hub ──────────────────────────────────────────────────────────────────────────────────────────────────

pub struct Hub {
    pub st: Mutex<State>,
    cond: Condvar,
    pub signer: Option<Arc<SignerClient>>,
    pub links: Arc<LinkStats>,
    state_dir: Option<PathBuf>,
    save_lock: Mutex<()>,
    stop: AtomicBool,
    /// AC-1: the Admin Console's hooks (anchor latching, request observation) and its device blocks.
    console_hooks: Mutex<Option<Arc<dyn ConsoleHooks>>>,
    denied_until: Mutex<HashMap<String, f64>>,
    /// AC-1 2.4 (R4-1, R4-2): the Meeting Hub service gate and seats, installed at start before the ports listen.
    gate: Mutex<Option<Arc<crate::meet_license::MeetGate>>>,
    /// MR-1 2.4: this relay's node of a cluster (set once at start; none for a single relay).
    cluster: std::sync::OnceLock<Arc<crate::meet_cluster::Cluster>>,
}

/// What the Admin Console wants to hear from the hub (contract 3.2 latching, 3.8 observation).
pub trait ConsoleHooks: Send + Sync {
    /// Certificate serials the relay now holds revoked.
    fn revoked(&self, serials: &[String]);
    /// An outcome a `meet.*` request waits for: `kind` "meet.approve", "meet.revoke" or "meet.invite".
    fn observed(&self, kind: &str, target: &Obj, by: &str, link: Option<&str>);
    /// AC-1 4.9 `check_console_reader`: an active console user manager or admin (R4-8).
    fn reader(&self, _email: &str) -> bool {
        false
    }
    /// AC-1 2.4: an active console admin (protected from losing a seat, R3-M6).
    fn console_admin(&self, _principal: &str) -> bool {
        false
    }
    /// The active console admins' emails (seat and license notices, I12).
    fn admin_emails(&self) -> Vec<String> {
        Vec::new()
    }
    /// An audit entry from the relay itself (actor `relay`, I13).
    fn audit(&self, _action: &str, _target: &str, _detail: Value) {}
    /// An audit entry for something the host's operator did offline (actor `operator`): `license.time-reset`.
    fn audit_operator(&self, _action: &str, _target: &str, _detail: Value) {}
    /// A mail through the console's mailer (I12).
    fn mail(&self, _kind: &str, _to: &str, _args: &[(&str, String)]) {}
}

type Body<'a> = Option<&'a Value>;
/// One checked caption line: its text and its optional numbers.
type CaptionLine = (String, Option<i64>, Option<i64>, Option<i64>);

impl Hub {
    pub fn new(state_dir: Option<PathBuf>, admins: &[String], history_hours: f64, mail_days: f64, channel_days: f64, signer: Option<Arc<SignerClient>>, links: Arc<LinkStats>) -> Hub {
        let mut list: Vec<String> = Vec::new();
        for a in admins {
            let p = a.trim().to_lowercase();
            if !p.is_empty() && !list.contains(&p) {
                list.push(p);
            }
        }
        let st = State {
            peers: IndexMap::new(),
            sessions: IndexMap::new(),
            alerts: Vec::new(),
            admins: list,
            directory: Obj::new(),
            dms: Lines::new(),
            read: Obj::new(),
            invites: Lines::new(),
            rooms: Lines::new(),
            left: Obj::new(),
            renewals: Obj::new(),
            renewed: Obj::new(),
            enrollments: Obj::new(),
            consumed_seeds: Obj::new(),
            seed_requests: Obj::new(),
            seeded: Obj::new(),
            denied: Obj::new(),
            moved: HashMap::new(),
            room_seq: HashMap::new(),
            stays: HashMap::new(),
            gone: HashMap::new(),
            dirty: false,
            last_prune: pj::mono(),
            mobile_checked: pj::now(),
            history_s: history_hours * 3600.0,
            mail_s: mail_days * 86400.0,
            recording_enabled: true,
            organizations: Obj::new(),
            org_edits: Obj::new(),
            statuses: Obj::new(),
            receipts: Obj::new(),
            stages: HashMap::new(),
            typing: HashMap::new(),
            meetings: Obj::new(),
            channels: Obj::new(),
            channel_msgs: Lines::new(),
            channel_read: Obj::new(),
            channel_s: channel_days * 86400.0,
            ext: Obj::new(),
            files: files::Files::new(state_dir.as_ref().map(|d| d.join("files"))),
            boards: HashMap::new(),
            breakouts: IndexMap::new(),
            control: HashMap::new(),
            sfu: sfu::Sfu::default(),
            guests: guests::Guests::new(state_dir.clone()),
            bridge: bridge::Bridge::new(state_dir.clone()),
            ce: ce::Ce::default(),
            prefs: Obj::new(),
            attendance: Obj::new(),
            emoji: Obj::new(),
            pa: parity::Parity::new(state_dir.as_deref()),
            push_tokens: Obj::new(),
            pu: push::Push::new(state_dir.as_deref()),
            pc: pc::Pc::new(state_dir.as_deref()),
            pc_docs: pc_docs::DocsRate::default(),
            wa: wa::Wa::new(),
        };
        let hub = Hub { st: Mutex::new(st), cond: Condvar::new(), signer, links, state_dir, save_lock: Mutex::new(()), stop: AtomicBool::new(false), console_hooks: Mutex::new(None), denied_until: Mutex::new(HashMap::new()), gate: Mutex::new(None), cluster: std::sync::OnceLock::new() };
        if hub.state_dir.is_some() {
            hub.load();
        }
        hub
    }

    fn wake(&self) {
        self.cond.notify_all();
    }

    fn path(&self) -> Option<PathBuf> {
        self.state_dir.as_ref().map(|d| d.join(STATE_FILE))
    }

    fn load(&self) {
        let Some(path) = self.path() else { return };
        let text = match std::fs::read(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                self.unreadable(&path, &e.to_string());
                return;
            }
        };
        let raw = match serde_json::from_slice::<Value>(&text) {
            Ok(Value::Object(o)) => o,
            Ok(_) => return self.unreadable(&path, "not a JSON object"),
            Err(e) => return self.unreadable(&path, &e.to_string()),
        };
        let section = |k: &str| as_obj(raw.get(k)).cloned().unwrap_or_default();
        let mut st = self.st.lock();
        st.directory = section("directory");
        st.dms = lines_of(raw.get("dms"));
        st.read = section("read");
        st.invites = lines_of(raw.get("invites"));
        st.rooms = lines_of(raw.get("rooms"));
        st.left = section("left");
        st.renewals = by_device(&section("renewals"));
        st.renewed = by_device(&section("renewed"));
        st.enrollments = only_objects(raw.get("enrollments"));
        st.consumed_seeds = section("consumed_seeds").into_iter().filter_map(|(k, v)| match v {
            Value::Number(n) => n.as_f64().map(|x| (k, f(x))),
            _ => None,
        }).collect();
        st.seed_requests = only_objects(raw.get("seed_requests"));
        st.seeded = only_objects(raw.get("seeded"));
        st.denied = only_objects(raw.get("denied"));
        for (principal, owner) in section("organizations") {
            if owner.is_null() {
                st.org_edits.insert(principal, Value::Null);
                continue;
            }
            match m::org_entry(&principal, &owner) {
                Ok(entry) => {
                    st.org_edits.insert(principal, Value::Object(entry));
                }
                Err(_) => log_warn(&format!("state file: organization of {principal} unreadable; ignored")),
            }
        }
        for (principal, row) in section("status") {
            let Some(row) = row.as_object() else { continue };
            if let Ok(Some(mut found)) = status(row.get("state"), row.get("text")) {
                if let Some(until) = pj::as_int(row.get("until")) {
                    found.insert("until".into(), Value::from(until));
                }
                // one whose `until` passed while the relay was down is automatic again
                let found = Value::Object(found);
                if parity::status_live(&found, (pj::now() * 1000.0) as i64) {
                    st.statuses.insert(principal, found);
                }
            }
        }
        st.receipts = section("receipts")
            .into_iter()
            .filter_map(|(k, v)| {
                let marks: Obj = v.as_object()?.iter().filter_map(|(o, t)| match t {
                    Value::Number(n) => n.as_f64().map(|x| (o.clone(), f(x))),
                    _ => None,
                }).collect();
                Some((k, Value::Object(marks)))
            })
            .collect();
        for (mid, meeting) in section("meetings") {
            if meetings::stored_meeting(&mid, &meeting) {
                st.meetings.insert(mid, meeting);
            } else {
                log_warn(&format!("state file: meeting {} unreadable; ignored", kv(&mid)));
            }
        }
        st.channels = section("channels")
            .into_iter()
            .filter(|(_, v)| v.as_object().map(|c| channels::CHANNEL_KINDS.contains(&pj::text_of(c, "kind").as_str()) && c.get("members").map(Value::is_array).unwrap_or(false)).unwrap_or(false))
            .collect();
        let known = st.channels.clone();
        st.channel_msgs = section("channel_messages")
            .into_iter()
            .filter_map(|(k, v)| {
                let list = v.as_array().filter(|_| known.contains_key(&k))?;
                Some((k, list.iter().filter_map(|m| m.as_object().cloned()).collect()))
            })
            .collect();
        st.channel_read = section("channel_read")
            .into_iter()
            .filter_map(|(k, v)| {
                let marks: Obj = v.as_object()?.iter().filter_map(|(c, t)| match t {
                    Value::Number(n) => n.as_f64().map(|x| (c.clone(), f(x))),
                    _ => None,
                }).collect();
                Some((k, Value::Object(marks)))
            })
            .collect();
        // each wave-3 slice validates its own part when it first reads it
        st.ext = only_objects(raw.get("ext"));
        st.pa_load(&raw);
        st.pu_load(&raw);
        st.prune(pj::now());
        let (people, convs, rooms) = (st.directory.len(), st.dms.len(), st.rooms.len());
        drop(st);
        log_info(&format!("state loaded: {people} people, {convs} conversations, {rooms} rooms"));
    }

    fn unreadable(&self, path: &std::path::Path, why: &str) {
        log_warn(&format!("state file {} unreadable ({why}); starting empty", path.display()));
        let mut bad = path.as_os_str().to_owned();
        bad.push(".bad");
        let _ = std::fs::rename(path, PathBuf::from(bad));
    }

    /// Write state.json now (tmp file, then rename); a failed write is logged and left to the upkeep's next save.
    pub fn save(&self) {
        if let Err(e) = self.save_synced() {
            log_warn(&e);
        }
    }

    /// Write state.json now (tmp file synced, then renamed, then the folder synced). Err when it is not on disk: the
    /// state stays dirty, so the upkeep writes it again. Without a state folder there is nothing to write (Ok).
    pub fn save_synced(&self) -> Result<(), String> {
        let Some(path) = self.path() else { return Ok(()) };
        let _g = self.save_lock.lock();
        // MR-1 2.3: a standby's state.json is the active's copy; its own Hub never writes over it
        if self.cluster().is_some_and(|c| !c.saves_allowed()) {
            return Ok(());
        }
        let data = {
            let mut st = self.st.lock();
            st.dirty = false;
            st.snapshot()
        };
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let result = (|| -> std::io::Result<()> {
            if let Some(d) = &self.state_dir {
                std::fs::create_dir_all(d)?;
            }
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut fh = opts.open(&tmp)?;
            fh.write_all(data.as_bytes())?;
            fh.flush()?;
            fh.sync_all()?;
            drop(fh);
            std::fs::rename(&tmp, &path)?;
            #[cfg(unix)]
            if let Some(d) = path.parent() {
                if let Ok(d) = std::fs::File::open(d) {
                    let _ = d.sync_all();
                }
            }
            Ok(())
        })();
        result.map_err(|e| {
            self.st.lock().dirty = true;
            format!("cannot write {}: {e}", path.display())
        })?;
        // MR-1 2.3: a new replica generation for the standby
        if let Some(c) = self.cluster() {
            c.note_saved();
        }
        Ok(())
    }

    /// MR-1 2.4: wait for a save in progress (a node turning standby stops saving first).
    pub fn save_barrier(&self) {
        drop(self.save_lock.lock());
    }

    pub fn set_cluster(&self, c: Arc<crate::meet_cluster::Cluster>) {
        let _ = self.cluster.set(c);
    }

    pub fn cluster(&self) -> Option<&Arc<crate::meet_cluster::Cluster>> {
        self.cluster.get()
    }

    /// MR-1 2.4: whether this relay serves people now (always without a cluster; else the active node, not handing
    /// over). The loops that change state run only then.
    pub fn serving(&self) -> bool {
        self.cluster().is_none_or(|c| c.serving())
    }

    /// MR-1 2.4: the one check before a change that does not come through a client route (the console, the fleet
    /// link, an upkeep): Err the refusal's code and words while this node does not serve people, so a standby or
    /// fenced node never takes state it would diverge on.
    pub fn cluster_writes(&self) -> Result<(), (&'static str, &'static str)> {
        match self.cluster() {
            Some(c) if !c.serving() => Err(c.not_serving()),
            _ => Ok(()),
        }
    }

    /// MR-1 2.4: `/healthz`, with the node's role, epoch and id when it is in a cluster.
    pub fn health(&self) -> Obj {
        match self.cluster() {
            Some(c) => c.health(),
            None => obj([("ok", Value::Bool(true))]),
        }
    }

    /// Background upkeep: the NT-1 ring timer and delayed pushes every NT_TICK s (at most 1 s late), reap every
    /// REAP_EVERY s, save at most every SAVE_EVERY s when something changed. MR-1 2.4: on a node that does not serve
    /// people only the save runs (a fenced node keeps what it has; a standby saves nothing); the active lists its
    /// replica set at the same pace, so writers other than the save are seen too.
    pub fn start(self: &Arc<Self>) {
        let hub = self.clone();
        let _ = std::thread::Builder::new().name("relay-upkeep".into()).spawn(move || {
            let mut last_reap = pj::mono();
            let mut last_save = pj::mono();
            loop {
                std::thread::sleep(Duration::from_secs_f64(NT_TICK));
                if hub.stop.load(Ordering::Relaxed) {
                    return;
                }
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let serving = hub.serving();
                    if serving {
                        hub.push_tick();
                    }
                    if serving && pj::mono() - last_reap >= REAP_EVERY {
                        last_reap = pj::mono();
                        hub.reap();
                        hub.wave3_tick();
                    }
                    if pj::mono() - last_save >= SAVE_EVERY {
                        last_save = pj::mono();
                        if hub.st.lock().dirty {
                            hub.save();
                        }
                        if let Some(c) = hub.cluster() {
                            c.note_saved();
                        }
                    }
                }));
                if r.is_err() {
                    crate::meet::log_error("upkeep failed");
                }
            }
        });
    }

    /// Stop the upkeep and write any unsaved state.
    pub fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if self.st.lock().dirty {
            self.save();
        }
    }

    pub fn reap(&self) {
        let now = pj::mono();
        let mut st = self.st.lock();
        let dead: Vec<String> = st.peers.values().filter(|p| now - p.last_seen > PEER_TIMEOUT).map(|p| p.peer_id.clone()).collect();
        for id in dead {
            st.drop_peer(&id, "timeout", true, true, "");
        }
        let ids: Vec<String> = st.peers.keys().cloned().collect();
        for id in ids {
            let Some(p) = st.peers.get_mut(&id) else { continue };
            let lapse = WEAK_LAPSE.max(WEAK_LAPSE_TRIPS * p.relay_rtt.unwrap_or(0.0)).min(PEER_TIMEOUT - 5.0);
            if !p.lapsed && p.polls == 0 && now - p.last_seen.max(p.poll_end) > lapse {
                p.lapsed = true;
                st.set_weak(&id, "polls");
            }
        }
        let quiet: Vec<String> = st.sessions.values().filter(|s| now - s.last_seen > SESSION_TIMEOUT).map(|s| s.session_id.clone()).collect();
        for id in quiet {
            st.end_session(&id, "timeout", true);
        }
        st.moved.retain(|_, v| now - v.at <= PEER_TIMEOUT);
        // a status whose `until` came goes back to automatic
        st.pa_status_sweep();
        st.mobile_expire();
        let wall = pj::now();
        // ID-1 2.11: a stale status or a suspension closes sessions itself
        st.pc_id_sweep(wall);
        let rooms: Vec<String> = st.stages.keys().cloned().collect();
        for room in rooms {
            // the granted person never presented
            if st.stages.get_mut(&room).map(|s| expire_grant(s, wall)).unwrap_or(false) {
                st.stage_event(&room, "expire", "", None);
            }
        }
        if now - st.last_prune >= PRUNE_EVERY {
            st.last_prune = now;
            st.prune(pj::now());
        }
        drop(st);
        self.wake();
    }

    // ── rooms ────────────────────────────────────────────────────────────────────────────────────────────────

    /// join: `ext` is the join request's body (its `client`, and whatever a wave-3 slice reads from it).
    pub fn join(&self, room: &str, who: &Identity, address: &str, late_history: bool, ext: Option<&Obj>) -> R<Obj> {
        if who.seed {
            return forbidden(m::FINISH_SETUP);
        }
        let empty = Obj::new();
        let mut st = self.st.lock();
        let r = self.join_held(&mut st, room, who, address, late_history, ext.unwrap_or(&empty));
        drop(st);
        self.wake();
        r
    }

    /// join with the lock held (an admitted web guest joins from inside its wait): the seat, then what the wave-3
    /// slices add to the answer.
    fn join_held(&self, st: &mut State, room: &str, who: &Identity, address: &str, late_history: bool, ext: &Obj) -> R<Obj> {
        let client = m::client(ext.get("client"));
        let (mut out, peer_id) = self.join_locked(st, room, who, address, late_history, &client, ext)?;
        log_info(&format!(
            "join room={room} principal={} peer={peer_id} device={} device_label={} app={} version={} platform={}",
            who.principal,
            kv(&who.device),
            kv(&who.device_label),
            kv_of(client.get("app")),
            kv_of(client.get("version")),
            kv_of(client.get("platform"))
        ));
        for (k, v) in st.wave3_join_extra(room, &peer_id) {
            out.insert(k, v);
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    fn join_locked(&self, st: &mut State, room: &str, who: &Identity, address: &str, late_history: bool, client: &Obj, ext: &Obj) -> R<(Obj, String)> {
        let (caps, cap_max) = wa::caps(ext)?;
        let proof = ext.get("session").and_then(Value::as_str).unwrap_or("");
        st.check_copy(who, address, proof)?;
        let joined_session = st.proven_session(who, proof);
        st.wave3_may_join(room, who, ext)?;
        let mine: Vec<String> = st.peers.values().filter(|p| p.who.principal == who.principal && p.room == room).map(|p| p.peer_id.clone()).collect();
        let cap = st.wave3_cap(room);
        if st.peers.values().filter(|p| p.room == room && p.who.principal != who.principal).count() >= cap {
            return forbidden(format!("room {room} is full ({cap} people)"));
        }
        let before = st.pstate(&who.principal);
        // a seat taken over (rejoin, another device) keeps the host role it held
        let old_host = st.stage_host(room);
        let was_host = old_host.map(|h| mine.contains(&h)).unwrap_or(false);
        let took_over = !mine.is_empty();
        let stage_before = st.stages.contains_key(room).then(|| st.stage_view(room));
        for old in mine {
            let device = st.peers[&old].who.device.clone();
            if device != who.device {
                st.push_peer(&old, &obj([("type", Value::from("moved")), ("room", Value::from(room)), ("to_device", Value::from(who.device.clone())), ("to_label", Value::from(who.device_label.clone()))]));
                let event = st.peers[&old].events.back().cloned().unwrap_or_default();
                st.moved.insert(old.clone(), Moved { principal: who.principal.clone(), event, at: pj::mono() });
                st.drop_peer(&old, "moved", false, false, "");
            } else {
                st.drop_peer(&old, "rejoined", false, false, "");
            }
        }
        if who.own_device() {
            let same: Vec<String> = st.peers.values().filter(|p| p.who.principal == who.principal && p.who.device == who.device).map(|p| p.peer_id.clone()).collect();
            for old in same {
                st.drop_peer(&old, "replaced", false, true, "");
            }
        }
        let mut peer = Peer {
            peer_id: pj::token_urlsafe(12),
            room: room.to_string(),
            who: who.clone(),
            last_seen: pj::mono(),
            seq: 0,
            events: VecDeque::new(),
            joined: pj::now(),
            recording: false,
            recording_paused: false,
            recording_request: Obj::new(),
            recording_replies: IndexMap::new(),
            admission_pending: false,
            address: address.to_string(),
            client: client.clone(),
            captions: IndexMap::new(),
            reported_weak: false,
            lapsed: false,
            weak: false,
            polls: 0,
            poll_end: 0.0,
            clock_gap: None,
            relay_rtt: None,
            tally: CallTally::new(),
            react_at: 0.0,
            cert: if who.guest { String::new() } else { who.cert_pem.clone() },
            e2ee: ext.get("e2ee") == Some(&Value::Bool(true)),
            epk: String::new(),
            epk_sig: String::new(),
            caps,
            cap_max,
            session: joined_session,
        };
        let mut members = st.members(room);
        let recording: Vec<Value> = st.peers.values().filter(|p| p.room == room && p.recording).map(|p| Value::from(p.peer_id.clone())).collect();
        peer.admission_pending = !recording.is_empty();
        let pending = peer.admission_pending;
        let notices: Vec<Value> = st
            .peers
            .values()
            .filter(|p| p.room == room && !p.recording_request.is_empty())
            .map(|p| Value::Object(with(&p.recording_request, obj([("on", Value::Bool(p.recording)), ("paused", Value::Bool(p.recording_paused))]))))
            .collect();
        if pending {
            members.clear();
        }
        let now = pj::now();
        let creates = !st.stays.contains_key(room);
        if creates {
            st.stays.insert(room.to_string(), Stay::new(now, IndexMap::new(), late_history));
            st.wave3_stay_created(room, who, ext);
            if late_history {
                log_info(&format!("options room={room} principal={} late_history=on why=created", who.principal));
            }
        }
        let stay = st.stays.get_mut(room).expect("the stay");
        let mut late_join = stay.late_history && !stay.seen.contains_key(&who.principal);
        stay.seen.entry(who.principal.clone()).or_insert(now);
        let (stay_start, stay_late) = (stay.start, stay.late_history);
        let peer_id = peer.peer_id.clone();
        st.peers.insert(peer_id.clone(), peer);
        st.seen(who);
        st.stage_mut(room);
        let host_here = st.stage_host(room).map(|h| st.peers.contains_key(&h)).unwrap_or(false);
        if !pending && (was_host || !host_here) {
            st.stage_mut(room).insert("host".into(), Value::from(peer_id.clone()));
        }
        // the organizer of the scheduled meeting in this room takes the host role
        let organizer = st.organizer_host(room, &peer_id);
        // a co-organizer the scheduled meeting names becomes one of the call
        let cohost = st.pa_meeting_cohost(room, &peer_id);
        st.pa_attend_in(&peer_id);
        let you = st.member_of(&peer_id);
        if !pending {
            st.broadcast(room, &with(&obj([("type", Value::from("join"))]), you.clone()), Some(&peer_id));
            // a taken-over seat that held a role (host, presenter, grant, request, hand): the others hear where it
            // went; otherwise nothing changed
            if organizer {
                st.stage_event(room, "organizer", &who.principal, Some(&peer_id));
            } else if cohost {
                st.stage_event(room, "cohost", &who.principal, Some(&peer_id));
            } else if took_over && stage_before.as_ref().map(|b| *b != st.stage_view(room)).unwrap_or(false) {
                st.stage_event(room, "join", &who.principal, Some(&peer_id));
            }
        }
        st.wa_joined(room, &peer_id);
        let stage_view = st.stage_view_ext(room);
        let log = st.rooms.get(room).cloned().unwrap_or_default();
        let chats: Vec<&Obj> = log.iter().filter(|l| pj::text_of(l, "kind") == "chat").collect();
        let history: Vec<Value> = chats[chats.len().saturating_sub(CHAT_KEEP)..].iter().map(|l| Value::Object((*l).clone())).collect();
        let mut since: Option<Value> = as_obj(st.left.get(&who.principal)).and_then(|o| o.get(room)).cloned();
        if late_join && !creates {
            since = Some(f(stay_start.max(now - CATCHUP_WINDOW)));
        } else {
            late_join = false;
        }
        let missed: Vec<Value> = match since.as_ref().and_then(|v| pj::as_num(Some(v))) {
            None if since.is_none() => Vec::new(),
            s => {
                let s = s.unwrap_or(0.0);
                log.iter().filter(|l| matches!(pj::text_of(l, "kind").as_str(), "chat" | "caption") && pj::num(l, "ts") >= s).map(|l| Value::Object(l.clone())).collect()
            }
        };
        let rseq = st.rseq(room);
        let mut line = obj([
            ("kind", Value::from("join")),
            ("id", Value::from(pj::token_hex(6))),
            ("peer", Value::from(peer_id.clone())),
            ("name", Value::from(who.name.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("ts", f(pj::now())),
        ]);
        st.room_log(room, &mut line);
        // NT-1 section 3.5: the person's invitations to this room are answered (they stay, settled, joinable)
        st.nt_joined(who, room);
        st.announce(who, &before);
        let mut out_missed = obj([("since", since.unwrap_or(Value::Null)), ("lines", Value::Array(missed))]);
        if late_join {
            out_missed.insert("late_join".into(), Value::Bool(true));
        }
        let mut options = obj([("late_history", Value::Bool(stay_late)), ("attendance", Value::Bool(st.pa_attendance_on()))]);
        st.ce_options(room, &mut options);
        let out = obj([
            ("peer", Value::from(peer_id.clone())),
            ("you", Value::Object(you)),
            ("members", Value::Array(members)),
            ("chat", Value::Array(if pending { Vec::new() } else { history })),
            ("missed", Value::Object(if pending { Obj::new() } else { out_missed })),
            ("recording", Value::Array(recording)),
            ("recording_notices", Value::Array(notices)),
            ("admission_pending", Value::Bool(pending)),
            ("rseq", Value::from(rseq)),
            ("options", Value::Object(options)),
            // waiting joiners hear the stage with recording_admitted
            ("stage", if pending { Value::Null } else { stage_view }),
        ]);
        Ok((out, peer_id))
    }

    pub fn owned(&self, peer_id: &str, who: &Identity) -> R<()> {
        self.st.lock().owned(peer_id, who)
    }

    pub fn events(&self, peer_id: &str, who: &Identity, after: i64) -> R<Obj> {
        let deadline = pj::mono() + m::POLL_WAIT;
        let mut st = self.st.lock();
        if !st.peers.contains_key(peer_id) {
            if let Some(g) = st.moved.get(peer_id) {
                if g.principal == who.principal && seq_of(&g.event) > after {
                    return Ok(obj([("events", Value::Array(vec![Value::Object(g.event.clone())]))]));
                }
            }
        }
        st.owned(peer_id, who)?;
        let lapsed = {
            let p = st.peers.get_mut(peer_id).expect("owned");
            p.last_seen = pj::mono();
            p.polls += 1;
            std::mem::replace(&mut p.lapsed, false)
        };
        if lapsed {
            st.set_weak(peer_id, "polls");
            self.wake();
        }
        let pending = |q: &VecDeque<Obj>| -> Vec<Value> { q.iter().filter(|e| seq_of(e) > after).map(|e| Value::Object(e.clone())).collect() };
        let out = loop {
            let found = match st.peers.get(peer_id) {
                Some(p) => pending(&p.events),
                None => break st.gone.get(peer_id).map(|g| pending(&g.events)).unwrap_or_default(),
            };
            if !found.is_empty() {
                break found;
            }
            let left = deadline - pj::mono();
            if left <= 0.0 {
                break Vec::new();
            }
            self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
        };
        if let Some(p) = st.peers.get_mut(peer_id) {
            p.polls -= 1;
            p.poll_end = pj::mono();
        } else if let Some(g) = st.gone.get_mut(peer_id) {
            g.waiters -= 1;
            if g.waiters <= 0 {
                st.gone.remove(peer_id);
            }
        }
        Ok(obj([("events", Value::Array(out))]))
    }

    pub fn signal(&self, peer_id: &str, who: &Identity, to: &str, data: Value) -> R<()> {
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        if st.peers.get(to).map(|t| t.room != room).unwrap_or(true) {
            return Err(E::Gone("that participant has left".into()));
        }
        if st.peers[peer_id].admission_pending || st.peers[to].admission_pending {
            return forbidden("recording consent is required before joining media");
        }
        st.push_peer(to, &obj([("type", Value::from("signal")), ("from", Value::from(peer_id)), ("data", data.clone())]));
        let state = data.as_object().filter(|d| d.get("kind").and_then(Value::as_str) == Some("state")).cloned();
        if let Some(d) = &state {
            let p = st.peers.get_mut(peer_id).expect("owned");
            let now = pj::mono();
            p.tally.at_level(d.get("level"), now);
            p.tally.figures(d.get("stats"));
            p.tally.state(d);
        }
        drop(st);
        self.wake();
        if let Some(d) = state {
            log_info(&link_line(&room, &who.principal, &d));
            self.links.record(&room, &who.principal, &d);
        }
        Ok(())
    }

    pub fn link(&self, peer_id: &str, who: &Identity, data: &Obj, weak: Option<bool>) -> R<()> {
        let rtt = data.get("relay_rtt_ms");
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        st.report_weak(peer_id, weak);
        {
            let p = st.peers.get_mut(peer_id).expect("owned");
            p.tally.at_level(data.get("level"), pj::mono());
            p.tally.figures(data.get("stats"));
            if let Some(r) = pj::as_num(rtt) {
                if r > 0.0 && r < 60000.0 {
                    let secs = r / 1000.0;
                    p.relay_rtt = Some(p.relay_rtt.map(|cur| cur.min(secs)).unwrap_or(secs));
                }
            }
        }
        drop(st);
        self.wake();
        if m::link_reports_on() {
            let relay_rtt = finite(rtt);
            let peers = finite(data.get("peers"));
            m::link_report(&format!(
                "{} relay_rtt_ms={} peers={} weak={}",
                link_line(&room, &who.principal, data).replacen("link ", "report ", 1),
                relay_rtt.map(|v| pyround(v).to_string()).unwrap_or_else(|| "-".into()),
                peers.map(|v| (v.trunc() as i64).to_string()).unwrap_or_else(|| "-".into()),
                match weak {
                    None => "-",
                    Some(true) => "on",
                    Some(false) => "off",
                }
            ));
        }
        self.links.record(&room, &who.principal, data);
        Ok(())
    }

    /// say: a plain room chat line to everyone in the call, only while a web guest is in it (otherwise the call's chat
    /// is end-to-end encrypted: ce_post). `reply_to` (a chat line of this room) stores a short preview of
    /// it; `mentions` (principals) keeps only the people in the call, and each of them also hears a `mention` on their
    /// presence sessions. `fwd` (a forwarded message's origin) is kept with the line.
    pub fn say(&self, peer_id: &str, who: &Identity, text: &str, reply_to: Body, mentioned: Body, fwd: Body) -> R<Obj> {
        let reply_to = message_id(reply_to, "reply_to")?;
        let mentioned = mentions(mentioned)?;
        let fwd = parity::fwd(fwd)?;
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        if st.peers[peer_id].admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        let room = st.peers[peer_id].room.clone();
        // otherwise the call's chat is end-to-end encrypted (ce_post)
        st.ce_plain(Some(&room), None)?;
        let now = pj::now();
        let mut line = obj([
            ("type", Value::from("chat")),
            ("kind", Value::from("chat")),
            ("id", Value::from(pj::token_hex(6))),
            ("from", Value::from(peer_id)),
            ("name", Value::from(who.name.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("org", st.org(&who.principal)),
            ("text", Value::from(text)),
            ("ts", f(now)),
            ("rts", Value::from((now * 1000.0) as i64)),
            ("reactions", Value::Object(Obj::new())),
        ]);
        if let Some(id) = &reply_to {
            let target = Self::room_line(&mut st, &room, id)?;
            let quoted = preview(target, target.get("name"))?;
            line.insert("reply_to".into(), Value::Object(quoted));
        }
        let here: Vec<String> = st.peers.values().filter(|p| p.room == room && !p.admission_pending).map(|p| p.who.principal.clone()).collect();
        let mentioned: Vec<String> = mentioned.into_iter().filter(|p| here.contains(p) && *p != who.principal).collect();
        if !mentioned.is_empty() {
            line.insert("mentions".into(), Value::Array(mentioned.iter().cloned().map(Value::from).collect()));
        }
        if let Some(origin) = fwd {
            line.insert("fwd".into(), Value::Object(origin));
        }
        st.room_log(&room, &mut line);
        st.broadcast(&room, &line, None);
        // AC-2a 9.2: one chat message relayed.
        crate::fleet_probe::counters().message(1);
        if !mentioned.is_empty() {
            let event = obj([
                ("type", Value::from("mention")),
                ("room", Value::from(room.clone())),
                ("id", line["id"].clone()),
                ("from", Value::from(who.principal.clone())),
                ("name", Value::from(who.name.clone())),
                ("text", Value::from(text)),
            ]);
            st.tell(&mentioned, &event, None);
        }
        drop(st);
        self.wake();
        log_info(&format!("chat room={room} principal={} chars={}", who.principal, pj::char_len(text)));
        Ok(line)
    }

    // ── chat changes: edits, deletions, typing (callers hold the lock) ──

    /// _room_line: a chat line of the room by id.
    fn room_line<'a>(st: &'a mut State, room: &str, id: &str) -> R<&'a mut Obj> {
        st.rooms.get_mut(room).and_then(|l| l.iter_mut().find(|l| pj::text_of(l, "id") == id && pj::text_of(l, "kind") == "chat")).ok_or_else(|| E::NotFound("that message is no longer kept".into()))
    }

    /// _conversation: the caller's room seat (scope room), the other person (scope dm) or the channel the caller is a
    /// member of (scope channel), checked. `writing` refuses an archived channel.
    #[allow(clippy::too_many_arguments)]
    fn conversation(st: &State, who: &Identity, scope: &str, peer: Option<&str>, session: Option<&str>, with_: Option<&str>, channel: Option<&str>, writing: bool) -> R<Conv> {
        if scope == "room" {
            let Some(peer) = peer else { return bad("a room message needs your room session (peer)") };
            st.owned(peer, who)?;
            if st.peers[peer].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            return Ok(Conv::Room { peer: peer.to_string(), room: st.peers[peer].room.clone() });
        }
        if scope == "dm" {
            if let Some(s) = session {
                st.session(s, who)?;
            } else if let Some(p) = peer {
                st.owned(p, who)?;
            } else {
                return bad("a direct message needs your session");
            }
            let other = with_.unwrap_or("").trim().to_lowercase();
            if other.is_empty() {
                return bad("say whose conversation the message is in (with)");
            }
            return Ok(Conv::Dm(other));
        }
        if scope == "channel" {
            let Some(s) = session else { return bad("a channel message needs your session") };
            st.session(s, who)?;
            let Some(c) = channel else { return bad("say which channel the message is in (channel)") };
            return Ok(Conv::Channel(st.member_channel(c, &who.principal, writing)?));
        }
        bad(SCOPE_ERROR)
    }

    /// The kept messages of a checked conversation (a room: its log).
    fn conv_list<'a>(st: &'a State, who: &Identity, c: &Conv) -> Option<&'a Vec<Obj>> {
        match c {
            Conv::Room { room, .. } => st.rooms.get(room),
            Conv::Channel(cid) => st.channel_msgs.get(cid),
            Conv::Dm(other) => st.dms.get(&conv(&who.principal, other)),
        }
    }

    fn conv_list_mut<'a>(st: &'a mut State, who: &Identity, c: &Conv) -> Option<&'a mut Vec<Obj>> {
        match c {
            Conv::Room { room, .. } => st.rooms.get_mut(room),
            Conv::Channel(cid) => st.channel_msgs.get_mut(cid),
            Conv::Dm(other) => st.dms.get_mut(&conv(&who.principal, other)),
        }
    }

    /// _scoped_message: where the message `id` is in a checked conversation (a room: one of its chat lines).
    fn scoped_index(st: &State, who: &Identity, c: &Conv, id: &str) -> R<usize> {
        let room = matches!(c, Conv::Room { .. });
        Self::conv_list(st, who, c)
            .and_then(|l| l.iter().position(|m| pj::text_of(m, "id") == id && (!room || pj::text_of(m, "kind") == "chat")))
            .ok_or_else(|| E::NotFound("that message is no longer kept".into()))
    }

    /// _tell_conversation: one event to everyone in a conversation: the room (`room`), every member's sessions
    /// (`channel`) or both people's sessions (`with` = the other person from each receiver's point of view).
    fn tell_conversation(st: &mut State, who: &Identity, c: &Conv, event: &Obj) {
        match c {
            Conv::Room { room, .. } => st.broadcast(room, &with(event, obj([("room", Value::from(room.clone()))])), None),
            Conv::Channel(cid) => {
                let members = channels::members_of(as_obj(st.channels.get(cid)));
                st.tell(&members, &with(event, obj([("channel", Value::from(cid.clone()))])), None);
            }
            Conv::Dm(other) => {
                for s in st.sessions.values_mut() {
                    if s.who.principal == who.principal {
                        push(&mut s.seq, &mut s.events, &with(event, obj([("with", Value::from(other.clone()))])));
                    } else if s.who.principal == *other {
                        push(&mut s.seq, &mut s.events, &with(event, obj([("with", Value::from(who.principal.clone()))])));
                    }
                }
                st.pc_tell_archives(&who.principal, other, event);
            }
        }
    }

    /// chat_change: edit (`text`) or delete (`delete`) a room chat line or a direct message. Only the author edits;
    /// the author or a relay admin deletes. A deletion keeps the line as a tombstone (`deleted`, no text, no
    /// reactions, no quoted text). Everyone in the conversation hears one `chat_update`; a room also keeps it as a
    /// history line. Answers the changed message.
    #[allow(clippy::too_many_arguments)]
    pub fn chat_change(&self, who: &Identity, scope: &str, id: &str, text: Body, delete: bool, peer: Option<String>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let text = if delete { String::new() } else { m::text(text, "messages")? };
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, bool)> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), !delete)?;
            st.ce_plain_in(&c)?;
            let i = Self::scoped_index(&st, who, &c, id)?;
            let is_admin = st.admins.contains(&who.principal);
            let list = Self::conv_list_mut(&mut st, who, &c).expect("the message's conversation");
            let target = &mut list[i];
            let author = pj::s(target, if matches!(c, Conv::Room { .. }) { "principal" } else { "from" });
            if pj::truthy(target.get("deleted")) {
                if delete {
                    // already gone: nothing more to tell
                    return Ok((target.clone(), false));
                }
                return bad("that message was deleted");
            }
            if author != who.principal && !(delete && is_admin) {
                return forbidden(format!("only the person who wrote a message can {} it", if delete { "delete" } else { "edit" }));
            }
            let now = pj::now();
            let mut event = obj([("type", Value::from("chat_update")), ("scope", Value::from(scope)), ("id", Value::from(id))]);
            // PC-1: a held conversation keeps the message as it was before the delete
            let held = if delete { Some(list[i].clone()) } else { None };
            if delete {
                tombstone(list, i, now);
                event.insert("text".into(), Value::from(""));
                event.insert("deleted".into(), f(now));
            } else {
                let target = &mut list[i];
                target.insert("text".into(), Value::from(text.clone()));
                target.insert("edited".into(), f(now));
                event.insert("text".into(), Value::from(text.clone()));
                event.insert("edited".into(), f(now));
            }
            let out = list[i].clone();
            if let Some(target) = held {
                match &c {
                    Conv::Channel(cid) => st.pc_hold_deleted(&who.principal, "", Some(cid), &target),
                    Conv::Dm(other) => st.pc_hold_deleted(&who.principal, other, None, &target),
                    Conv::Room { .. } => {}
                }
            }
            event.insert("by".into(), Value::from(who.principal.clone()));
            st.dirty = true;
            if let Conv::Channel(cid) = &c {
                st.bridge_chan_changed(cid, id, delete);
            }
            if let Conv::Room { room, .. } = &c {
                let mut line: Obj = event.iter().filter(|(k, _)| k.as_str() != "type").map(|(k, v)| (k.clone(), v.clone())).collect();
                line.insert("room".into(), Value::from(room.clone()));
                line.insert("kind".into(), Value::from("chat_update"));
                line.insert("id".into(), Value::from(pj::token_hex(6)));
                line.insert("target".into(), Value::from(id));
                line.insert("name".into(), Value::from(who.name.clone()));
                line.insert("ts".into(), f(now));
                st.room_log(room, &mut line);
            }
            Self::tell_conversation(&mut st, who, &c, &event);
            Ok((out, true))
        })();
        drop(st);
        self.wake();
        let (out, changed) = r?;
        if changed {
            log_info(&format!("chat_{} scope={scope} principal={}", if delete { "delete" } else { "edit" }, who.principal));
        }
        Ok(out)
    }

    /// typing: `Name is typing`, never stored; one notice per sender and conversation every TYPING_EVERY seconds at
    /// most (`sent` false when this one was dropped).
    pub fn typing(&self, who: &Identity, scope: &str, peer: Option<String>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            let key = (who.principal.clone(), match &c {
                Conv::Room { room, .. } => format!("room {room}"),
                Conv::Channel(cid) => format!("channel {cid}"),
                Conv::Dm(other) => format!("dm {other}"),
            });
            let now = pj::mono();
            if let Some(last) = st.typing.get(&key) {
                if now - last < TYPING_EVERY {
                    return Ok(obj([("ok", Value::Bool(true)), ("sent", Value::Bool(false))]));
                }
            }
            if st.typing.len() > 4096 {
                st.typing.retain(|_, t| now - *t < TYPING_EVERY);
            }
            st.typing.insert(key, now);
            let event = obj([("type", Value::from("typing")), ("scope", Value::from(scope)), ("principal", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone())), ("ts", f(pj::now()))]);
            match &c {
                Conv::Room { room, peer } => st.broadcast(room, &with(&event, obj([("room", Value::from(room.clone()))])), Some(peer.as_str())),
                Conv::Channel(cid) => {
                    let others: Vec<String> = channels::members_of(as_obj(st.channels.get(cid))).into_iter().filter(|p| *p != who.principal).collect();
                    st.tell(&others, &with(&event, obj([("channel", Value::from(cid.clone()))])), None);
                }
                Conv::Dm(other) if *other != who.principal => st.tell(std::slice::from_ref(other), &with(&event, obj([("with", Value::from(who.principal.clone()))])), None),
                Conv::Dm(_) => {}
            }
            Ok(obj([("ok", Value::Bool(true)), ("sent", Value::Bool(true))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// stage (`POST /v1/stage`): who presents, asks to present, has a hand up, is host, plus the host's mute and
    /// remove and live reactions. Every change is one `stage` event to the room with the whole state. Relay admins
    /// count as host in every room. Answers `{ok, stage}` (`sent` too for `react`).
    pub fn stage(&self, peer_id: &str, who: &Identity, action: Body, target: Body, up: Body, emoji: Body) -> R<Obj> {
        let action = match action {
            Some(Value::String(a)) if STAGE_ACTIONS.contains(&a.as_str()) => a.clone(),
            _ => return bad(format!("action must be one of {}", STAGE_ACTIONS.join(", "))),
        };
        let mut emoji_text = String::new();
        if action == "react" {
            emoji_text = pj::str_or(emoji).trim().to_string();
            if !self.pa_custom_reaction(&emoji_text)? && (emoji_text.is_empty() || pj::char_len(&emoji_text) > EMOJI_MAX) {
                return bad(format!("a reaction is one emoji (at most {EMOJI_MAX} characters)"));
            }
        }
        let up = match up {
            Some(Value::Bool(b)) => Some(*b),
            _ if action == "hand" || action == "cohost" => return bad("up must be true or false"),
            _ => None,
        };
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            st.owned(peer_id, who)?;
            if st.peers[peer_id].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id].room.clone();
            let me = peer_id.to_string();
            let now = pj::now();
            if expire_grant(st.stage_mut(&room), now) {
                st.stage_event(&room, "expire", "", None);
            }
            // the host (and relay admins) alone name hosts and co-organizers; co-organizers have every other power
            let chief = st.stage_host(&room).as_deref() == Some(me.as_str()) || st.admins.contains(&who.principal);
            let host = chief || st.pa_hosts(&room, &me);
            let mut other: Option<String> = None;
            if let Some(t) = target.filter(|t| !t.is_null() && t.as_str() != Some("")) {
                let id = pj::py_str(t);
                match st.peers.get(&id) {
                    Some(o) if o.room == room && !o.admission_pending => other = Some(id),
                    _ => return Err(E::NotFound("that person is not in this call".into())),
                }
            }
            if matches!(action.as_str(), "grant" | "deny" | "make_host" | "mute" | "remove" | "cohost") && other.is_none() {
                return bad(format!("say whom to {} (target)", action.replace('_', " ")));
            }
            let other_principal = other.as_ref().map(|o| st.peers[o.as_str()].who.principal.clone()).unwrap_or_default();
            let stage = st.stage_mut(&room).clone();
            let presenter = stage.get("presenter").filter(|v| v.is_object()).cloned();
            let presenting = presenter.as_ref().map(|p| entry_peer(p) == me).unwrap_or(false);
            let in_list = |key: &str, id: &str| stage.get(key).and_then(Value::as_array).map(|l| l.iter().any(|e| entry_peer(e) == id)).unwrap_or(false);
            let mut changed = true;
            let mut out = obj([("ok", Value::Bool(true))]);
            match action.as_str() {
                "present" => {
                    let grant = stage.get("grant").filter(|v| v.is_object()).cloned();
                    if presenting {
                        changed = false;
                    } else if !host && !grant.as_ref().map(|g| entry_peer(g) == me).unwrap_or(false) {
                        if let Some(p) = &presenter {
                            return Err(E::Conflict(format!("{} is presenting. Ask to present.", pj::s(p.as_object().expect("an entry"), "name"))));
                        }
                        if let Some(g) = &grant {
                            let name = st.peers.get(entry_peer(g)).map(|p| p.who.name.clone()).unwrap_or_else(|| "Someone".into());
                            return Err(E::Conflict(format!("{name} was asked to present. Ask to present.")));
                        }
                    }
                    if changed {
                        let entry = st.stage_entry(&me, "since", now);
                        let s = st.stage_mut(&room);
                        s.insert("presenter".into(), entry);
                        s.insert("grant".into(), Value::Null);
                        list_mut(s, "requests").retain(|r| entry_peer(r) != me);
                    }
                }
                "stop" => {
                    let subject = other.clone().unwrap_or_else(|| me.clone());
                    if subject != me && !host {
                        return forbidden("only the presenter or the host can stop a presentation");
                    }
                    if presenter.as_ref().map(|p| entry_peer(p) == subject).unwrap_or(false) {
                        st.stage_mut(&room).insert("presenter".into(), Value::Null);
                    } else {
                        changed = false;
                    }
                }
                "request" => {
                    if presenting {
                        return bad("you are presenting already");
                    }
                    if in_list("requests", &me) {
                        changed = false;
                    } else {
                        let entry = st.stage_entry(&me, "ts", now);
                        list_mut(st.stage_mut(&room), "requests").push(entry);
                    }
                }
                "cancel" => {
                    let list = list_mut(st.stage_mut(&room), "requests");
                    let before = list.len();
                    list.retain(|r| entry_peer(r) != me);
                    changed = list.len() != before;
                }
                "grant" | "deny" => {
                    if !(host || presenting) {
                        return forbidden("only the presenter or the host can do that");
                    }
                    let target = other.clone().expect("a target");
                    let s = st.stage_mut(&room);
                    let list = list_mut(s, "requests");
                    let before = list.len();
                    list.retain(|r| entry_peer(r) != target);
                    if list.len() == before {
                        return Err(E::NotFound("that person has not asked to present".into()));
                    }
                    if action == "grant" {
                        s.insert("presenter".into(), Value::Null);
                        s.insert("grant".into(), Value::Object(obj([("peer", Value::from(target)), ("until", f(now + GRANT_TTL))])));
                    }
                }
                "hand" => {
                    let up = up.unwrap_or(false);
                    let subject = other.clone().unwrap_or_else(|| me.clone());
                    if subject != me {
                        if !host {
                            return forbidden("only the host can lower someone else's hand");
                        }
                        if up {
                            return bad("only the person can raise their own hand");
                        }
                    }
                    let raised = in_list("hands", &subject);
                    if up && !raised {
                        let entry = st.stage_entry(&subject, "ts", now);
                        list_mut(st.stage_mut(&room), "hands").push(entry);
                    } else if !up && raised {
                        list_mut(st.stage_mut(&room), "hands").retain(|h| entry_peer(h) != subject);
                    } else {
                        changed = false;
                    }
                }
                "make_host" => {
                    if !chief {
                        return forbidden(NOT_HOST);
                    }
                    let target = other.clone().expect("a target");
                    if st.peers[target.as_str()].who.guest {
                        return forbidden("a guest cannot be a host");
                    }
                    changed = st.stage_host(&room).as_deref() != Some(target.as_str());
                    st.stage_mut(&room).insert("host".into(), Value::from(target));
                }
                "mute" | "remove" => {
                    if !host {
                        return forbidden(NOT_HOST);
                    }
                    let target = other.clone().expect("a target");
                    if target == me {
                        return bad("choose someone else");
                    }
                    changed = false;
                    let kind = if action == "mute" { "host_mute" } else { "removed" };
                    st.push_peer(&target, &obj([("type", Value::from(kind)), ("by", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone()))]));
                    if action == "remove" {
                        // its next poll still hears `removed` after the seat is gone
                        let t = &st.peers[target.as_str()];
                        let moved = Moved { principal: t.who.principal.clone(), event: t.events.back().cloned().unwrap_or_default(), at: pj::mono() };
                        st.moved.insert(target.clone(), moved);
                        st.drop_peer(&target, "removed", true, true, &who.principal);
                    }
                }
                "spotlight" => {
                    // everyone sees this person large ("" or no target: nobody)
                    if !host {
                        return forbidden(NOT_HOST);
                    }
                    let next = other.clone().unwrap_or_default();
                    changed = stage.get("spotlight").and_then(Value::as_str).unwrap_or_default() != next;
                    st.stage_mut(&room).insert("spotlight".into(), Value::from(next));
                }
                "cohost" => {
                    if !chief {
                        return forbidden(NOT_HOST);
                    }
                    let target = other.clone().expect("a target");
                    let t = &st.peers[target.as_str()].who;
                    if t.guest {
                        return forbidden(parity::NOT_COHOST_GUEST);
                    }
                    let principal = Value::from(t.principal.clone());
                    let list = list_mut(st.stage_mut(&room), "cohosts");
                    let named = list.contains(&principal);
                    if up == Some(true) && !named {
                        if list.len() >= parity::COHOSTS_MAX {
                            return bad(parity::COHOSTS_FULL);
                        }
                        list.push(principal);
                    } else if up == Some(false) && named {
                        list.retain(|c| *c != principal);
                    } else {
                        changed = false;
                    }
                }
                _ => {
                    // react: no state, a live reaction over the sender's tile
                    changed = false;
                    let mono = pj::mono();
                    let p = st.peers.get_mut(peer_id).expect("owned");
                    let sent = mono - p.react_at >= CALL_REACT_EVERY;
                    out.insert("sent".into(), Value::Bool(sent));
                    if sent {
                        p.react_at = mono;
                        let event = obj([
                            ("type", Value::from("call_react")),
                            ("peer", Value::from(me.clone())),
                            ("name", Value::from(who.name.clone())),
                            ("principal", Value::from(who.principal.clone())),
                            ("emoji", Value::from(emoji_text.clone())),
                            ("ts", f(now)),
                        ]);
                        st.broadcast(&room, &event, None);
                    }
                }
            }
            if changed {
                st.stage_event(&room, &action, &who.principal, None);
            }
            out.insert("stage".into(), st.stage_view_ext(&room));
            Ok((out, room, other_principal))
        })();
        drop(st);
        self.wake();
        let (out, room, target) = r?;
        if action != "react" {
            log_info(&format!("stage room={room} principal={} action={action} target={}", who.principal, kv(&target)));
        }
        Ok(out)
    }

    pub fn caption(&self, peer_id: &str, who: &Identity, text: &str, cseq_v: Body, age_v: Body, dur_v: Body) -> R<Obj> {
        let cseq = cseq(cseq_v)?;
        let age = ms(age_v, "age_ms", AGE_MS_MAX)?;
        let dur = ms(dur_v, "dur_ms", DUR_MS_MAX)?;
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        st.sfu_caption_check(peer_id, std::iter::once(text))?;
        let room = st.peers[peer_id].room.clone();
        let (line, repeat) = Self::caption_line(&mut st, peer_id, who, text, cseq, age, dur, None)?;
        drop(st);
        self.wake();
        Self::caption_logged(&room, who, text, &line, repeat);
        Ok(line)
    }

    /// `for_`: the seat whose speech the caller captions (WA-1 section 5.2), only from its assigned captioner.
    pub fn captions(&self, peer_id: &str, who: &Identity, lines: Body, weak: Option<bool>, sent_ms: Body, for_: Body) -> R<Obj> {
        let Some(Value::Array(lines)) = lines else { return bad("lines must be a list") };
        if lines.is_empty() || lines.len() > CAPTIONS_BATCH_MAX {
            return bad(format!("send 1 to {CAPTIONS_BATCH_MAX} lines at a time"));
        }
        let sent = pj::as_num(sent_ms);
        let mut out: Vec<Value> = Vec::new();
        let mut done: Vec<(String, Obj, bool)> = Vec::new();
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let target = match for_ {
            Some(t) => Some(st.wa_caption_for(peer_id, t)?),
            None => None,
        };
        st.sfu_caption_check(peer_id, lines.iter().filter_map(Value::as_object).map(|o| pj::s(o, "text")).filter(|t| !t.trim().is_empty()))?;
        let room = st.peers[peer_id].room.clone();
        st.report_weak(peer_id, weak);
        let mut transit = 0i64;
        if let Some(sent) = sent {
            let p = st.peers.get_mut(peer_id).expect("owned");
            let gap = pj::now() * 1000.0 - sent;
            if p.clock_gap.map(|g| gap < g).unwrap_or(true) {
                p.clock_gap = Some(gap);
            }
            transit = (gap - p.clock_gap.unwrap_or(gap)).max(0.0) as i64;
        }
        for item in lines {
            let raw = item.as_object().and_then(|o| o.get("cseq"));
            let checked = (|| -> R<CaptionLine> {
                let Some(o) = item.as_object() else { return bad("each line must be an object") };
                let t = pj::s(o, "text").trim().to_string();
                if t.is_empty() {
                    return bad("empty caption");
                }
                let t = m::text(Some(&Value::from(t)), "captions")?;
                let c = cseq(raw)?;
                let mut age = ms(o.get("age_ms"), "age_ms", AGE_MS_MAX)?;
                if let Some(a) = age {
                    if transit != 0 {
                        age = Some(AGE_MS_MAX.min(a + transit));
                    }
                }
                let dur = ms(o.get("dur_ms"), "dur_ms", DUR_MS_MAX)?;
                Ok((t, c, age, dur))
            })();
            match checked {
                Err(e) => {
                    let c = pj::as_int(raw).map(Value::from).unwrap_or(Value::Null);
                    out.push(Value::Object(obj([("cseq", c), ("refused", Value::from(e.message()))])));
                }
                Ok((t, c, age, dur)) => {
                    let (line, repeat) = match Self::caption_line(&mut st, peer_id, who, &t, c, age, dur, target.as_deref()) {
                        Ok(stored) => stored,
                        Err(e) => {
                            // a late joiner's refusal ends the batch, after any weak report it carried
                            drop(st);
                            self.wake();
                            return Err(e);
                        }
                    };
                    out.push(Value::Object(line.clone()));
                    done.push((t, line, repeat));
                }
            }
        }
        drop(st);
        self.wake();
        for (t, line, repeat) in &done {
            Self::caption_logged(&room, who, t, line, *repeat);
        }
        Ok(obj([("lines", Value::Array(out))]))
    }

    /// `target`: the seat whose speech the captioner `peer_id` captions (WA-1 5.2): the line is that seat's, with
    /// `peer` (the target) and `by` (the captioner).
    #[allow(clippy::too_many_arguments)]
    fn caption_line(st: &mut State, peer_id: &str, who: &Identity, text: &str, cseq: Option<i64>, age: Option<i64>, dur: Option<i64>, target: Option<&str>) -> R<(Obj, bool)> {
        if st.peers[peer_id].admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        if let Some(c) = cseq {
            if let Some(stored) = st.peers[peer_id].captions.get(&c) {
                return Ok((stored.clone(), true));
            }
        }
        let room = st.peers[peer_id].room.clone();
        let speaker = target.and_then(|t| st.peers.get(t)).map(|p| (p.peer_id.clone(), p.who.name.clone(), p.who.principal.clone()));
        let (from, name, principal) = speaker.unwrap_or_else(|| (peer_id.to_string(), who.name.clone(), who.principal.clone()));
        let mut line = obj([
            ("type", Value::from("caption")),
            ("kind", Value::from("caption")),
            ("id", Value::from(pj::token_hex(6))),
            ("from", Value::from(from.clone())),
            ("name", Value::from(name)),
            ("principal", Value::from(principal)),
            ("text", Value::from(text)),
            ("ts", f(pj::now())),
        ]);
        if target.is_some() {
            line.insert("peer".into(), Value::from(from));
            line.insert("by".into(), Value::from(peer_id));
            line.insert("by_name".into(), Value::from(who.name.clone()));
        }
        if let Some(c) = cseq {
            line.insert("cseq".into(), Value::from(c));
        }
        if let Some(a) = age {
            line.insert("age_ms".into(), Value::from(a));
            if a > CAPTION_LATE_MS {
                line.insert("late".into(), Value::Bool(true));
            }
        }
        if let Some(d) = dur {
            line.insert("dur_ms".into(), Value::from(d));
        }
        st.room_log(&room, &mut line);
        st.broadcast(&room, &line, Some(peer_id));
        let p = st.peers.get_mut(peer_id).expect("owned");
        p.tally.caption(&line);
        if let Some(c) = cseq {
            p.captions.insert(c, line.clone());
            while p.captions.len() > CSEQ_KEEP {
                p.captions.shift_remove_index(0);
            }
        }
        Ok((line, false))
    }

    fn caption_logged(room: &str, who: &Identity, text: &str, line: &Obj, repeat: bool) {
        if repeat {
            log_info(&format!("caption room={room} principal={} cseq={} repeat", who.principal, pj::as_int(line.get("cseq")).unwrap_or(0)));
            return;
        }
        log_info(&format!(
            "caption room={room} principal={} chars={} cseq={} age_ms={}{}",
            who.principal,
            pj::char_len(text),
            kv_of(line.get("cseq")),
            kv_of(line.get("age_ms")),
            if pj::truthy(line.get("late")) { " late" } else { "" }
        ));
    }

    pub fn leave(&self, peer_id: &str, who: &Identity) -> R<()> {
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        st.drop_peer(peer_id, "left", true, true, "");
        drop(st);
        self.wake();
        Ok(())
    }

    /// `POST /v1/recording/policy`: permission, ownership and the room's recorders and open requests.
    pub fn recording_policy(&self, peer_id: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.recording_peer(peer_id, who)?;
        Ok(st.recording_policy(peer_id, who))
    }

    /// `POST /v1/recording`: capture is authorized only after the recorder acknowledged the policy and every
    /// participant actually consented; until then the answer is a pending request, never permission.
    /// `acknowledged` and `paused` default to false when absent.
    pub fn recording(&self, peer_id: &str, who: &Identity, on: Body, acknowledged: Body, paused: Body) -> R<Obj> {
        let flag = |v: Option<&Value>| match v {
            None => Some(false),
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => None,
        };
        let (Some(Value::Bool(on)), Some(acknowledged), Some(paused)) = (on, flag(acknowledged), flag(paused)) else {
            return bad("on, acknowledged and paused must be true or false");
        };
        let on = *on;
        let mut st = self.st.lock();
        st.recording_peer(peer_id, who)?;
        let out = Self::recording_locked(&mut st, peer_id, who, on, acknowledged, paused);
        drop(st);
        self.wake();
        out
    }

    fn recording_locked(st: &mut State, peer_id: &str, who: &Identity, on: bool, acknowledged: bool, paused: bool) -> R<Obj> {
        let p = &st.peers[peer_id];
        if !on {
            let request = p.recording_request.get("request").cloned().unwrap_or(Value::Null);
            if p.recording || !p.recording_request.is_empty() {
                st.set_recording(peer_id, false, false);
            }
            return Ok(obj([("ok", Value::Bool(true)), ("on", Value::Bool(false)), ("paused", Value::Bool(false)), ("request", request)]));
        }
        let policy = st.recording_policy(peer_id, who);
        if policy.get("allowed") != Some(&Value::Bool(true)) {
            return forbidden("recording is not permitted");
        }
        let room = st.peers[peer_id].room.clone();
        if st.peers[peer_id].recording_request.is_empty() {
            if st.wa_any_rule(&room, "record", "refuse") {
                return Err(E::Conflict(wa::RECORD_REFUSED.into())); // WA-1 section 3.3
            }
            if !acknowledged {
                return forbidden("acknowledge the recording policy before requesting consent");
            }
            if paused {
                return bad("start recording before pausing");
            }
            let request = obj([
                ("request", Value::from(pj::token_urlsafe(18))),
                ("peer", Value::from(peer_id)),
                ("name", Value::from(who.name.clone())),
                ("principal", Value::from(who.principal.clone())),
                ("owner", policy.get("owner").cloned().unwrap_or(Value::Null)),
                ("notice", policy.get("notice").cloned().unwrap_or(Value::Null)),
                ("policy_acknowledged", Value::Bool(true)),
            ]);
            let p = st.peers.get_mut(peer_id).expect("recording peer");
            p.recording_request = request.clone();
            p.recording_replies.clear();
            p.recording_replies.insert(peer_id.to_string(), true);
            st.broadcast(&room, &with(&request, obj([("type", Value::from("recording_request"))])), None);
        }
        let p = &st.peers[peer_id];
        let participants: Vec<&Peer> = st.peers.values().filter(|r| r.room == room && !r.admission_pending).collect();
        let waiting: Vec<Value> = participants.iter().filter(|r| !p.recording_replies.contains_key(&r.peer_id)).map(|r| Value::Object(r.public())).collect();
        let denied: Vec<Value> = participants.iter().filter(|r| p.recording_replies.get(&r.peer_id) == Some(&false)).map(|r| Value::Object(r.public())).collect();
        if !waiting.is_empty() || !denied.is_empty() {
            return Ok(with(
                &p.recording_request,
                obj([("ok", Value::Bool(false)), ("pending", Value::Bool(true)), ("waiting", Value::Array(waiting)), ("denied", Value::Array(denied)), ("on", Value::Bool(false))]),
            ));
        }
        if !p.recording || p.recording_paused != paused {
            st.set_recording(peer_id, true, paused);
        }
        Ok(with(
            &st.peers[peer_id].recording_request,
            obj([("ok", Value::Bool(true)), ("on", Value::Bool(true)), ("paused", Value::Bool(paused)), ("participant_consent_complete", Value::Bool(true))]),
        ))
    }

    /// `POST /v1/recording/consent`: a participant's own answer to one recorder's request. A refusal stops an active
    /// recording (unless the one refusing is still waiting to be admitted); an acceptance may admit a late joiner.
    pub fn recording_consent(&self, peer_id: &str, who: &Identity, request: &str, accepted: Body) -> R<Obj> {
        let Some(Value::Bool(accepted)) = accepted else { return bad("accepted must be true or false") };
        let accepted = *accepted;
        let mut st = self.st.lock();
        st.recording_peer(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        let Some(recorder) = st.peers.values().find(|r| r.room == room && r.recording_request.get("request").and_then(Value::as_str) == Some(request)).map(|r| r.peer_id.clone()) else {
            return Err(E::Gone("that recording request has ended".into()));
        };
        if recorder == peer_id {
            return bad("recorder policy acknowledgement is not participant consent");
        }
        st.peers.get_mut(&recorder).expect("recorder").recording_replies.insert(peer_id.to_string(), accepted);
        st.broadcast(&room, &obj([("type", Value::from("recording_consent")), ("request", Value::from(request)), ("peer", Value::from(peer_id)), ("accepted", Value::Bool(accepted))]), None);
        if !accepted && st.peers[&recorder].recording && !st.peers[peer_id].admission_pending {
            st.set_recording(&recorder, false, false);
        }
        st.admit_waiting(&room);
        let pending = st.peers[peer_id].admission_pending;
        let members: Vec<Value> = if pending { Vec::new() } else { st.members(&room).into_iter().filter(|m| m.get("peer").and_then(Value::as_str) != Some(peer_id)).collect() };
        drop(st);
        self.wake();
        Ok(obj([("ok", Value::Bool(true)), ("accepted", Value::Bool(accepted)), ("admission_pending", Value::Bool(pending)), ("members", Value::Array(members))]))
    }

    pub fn room_options(&self, peer_id: &str, who: &Identity, late: Body) -> R<Obj> {
        let Some(Value::Bool(late)) = late else { return bad("late_history must be true or false") };
        let late = *late;
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        let now = pj::now();
        let stay = st.stays.entry(room.clone()).or_insert_with(|| {
            let mut seen = IndexMap::new();
            seen.insert(who.principal.clone(), now);
            Stay::new(now, seen, false)
        });
        let changed = stay.late_history != late;
        let attendance = Value::Bool(st.pa_attendance_on());
        if changed {
            if let Some(stay) = st.stays.get_mut(&room) {
                stay.late_history = late;
            }
            st.broadcast(
                &room,
                &obj([
                    ("type", Value::from("room_options")),
                    ("late_history", Value::Bool(late)),
                    ("attendance", attendance.clone()),
                    ("by", Value::from(who.name.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("peer", Value::from(peer_id)),
                ]),
                None,
            );
        }
        drop(st);
        self.wake();
        if changed {
            log_info(&format!("options room={room} principal={} late_history={}", who.principal, if late { "on" } else { "off" }));
        }
        Ok(obj([("ok", Value::Bool(true)), ("options", Value::Object(obj([("late_history", Value::Bool(late)), ("attendance", attendance)])))]))
    }

    pub fn room_captions(&self, peer_id: &str, who: &Identity, after: &str, limit: &str) -> R<Obj> {
        let whole = |s: &str| m::py_int(s).map_err(|_| E::Bad("after and limit must be whole numbers".into()));
        let after = whole(after)?;
        let limit = whole(limit)?.clamp(1, m::CAPTIONS_LIMIT_MAX) as usize;
        let st = self.st.lock();
        st.owned(peer_id, who)?;
        let p = &st.peers[peer_id];
        if p.admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        let now = pj::now();
        let start = match st.stays.get(&p.room) {
            Some(s) if s.late_history => s.start,
            Some(s) => s.seen.get(&who.principal).copied().unwrap_or(p.joined),
            None => p.joined,
        }
        .max(now - CATCHUP_WINDOW);
        let lines: Vec<Value> = st
            .rooms
            .get(&p.room)
            .map(|l| l.as_slice())
            .unwrap_or_default()
            .iter()
            .filter(|l| matches!(pj::text_of(l, "kind").as_str(), "chat" | "caption") && pj::as_int(l.get("rseq")).map(|r| r > after).unwrap_or(false) && pj::num(l, "ts") >= start)
            .take(limit)
            .map(|l| Value::Object(l.clone()))
            .collect();
        Ok(obj([("lines", Value::Array(lines)), ("rseq", Value::from(st.rseq(&p.room)))]))
    }

    fn windows(st: &State, room: &str, principal: &str) -> Vec<(f64, f64)> {
        let left = as_obj(st.left.get(principal)).and_then(|o| pj::as_num(o.get(room)));
        let mut opened: IndexMap<String, f64> = IndexMap::new();
        let mut out = Vec::new();
        for line in st.rooms.get(room).map(|l| l.as_slice()).unwrap_or_default() {
            if pj::text_of(line, "principal") != principal {
                continue;
            }
            let peer = pj::dumps(line.get("peer").unwrap_or(&Value::Null));
            match pj::text_of(line, "kind").as_str() {
                "join" => {
                    opened.insert(peer, pj::num(line, "ts"));
                }
                "leave" => out.push((opened.shift_remove(&peer).unwrap_or(f64::NEG_INFINITY), pj::num(line, "ts"))),
                _ => {}
            }
        }
        if let Some(l) = left {
            out.extend(opened.values().filter(|s| l >= **s).map(|s| (*s, l)));
        }
        out
    }

    pub fn room_history(&self, room: &Value, who: &Identity, since: &Value, limit: i64) -> R<Obj> {
        let room = m::room_name(Some(room))?;
        let since = m::number(Some(since), "since")?;
        let limit = limit.clamp(1, ROOM_LOG_KEEP as i64) as usize;
        let st = self.st.lock();
        if st.peers.values().any(|p| p.room == room && p.who.principal == who.principal && p.admission_pending) {
            return forbidden(ADMISSION_FIRST);
        }
        let mut lines: Vec<&Obj> = st.rooms.get(&room).map(|l| l.iter().filter(|l| pj::num(l, "ts") > since).collect()).unwrap_or_default();
        if !st.peers.values().any(|p| p.room == room && p.who.principal == who.principal) {
            if !as_obj(st.left.get(&who.principal)).map(|o| o.contains_key(&room)).unwrap_or(false) {
                return forbidden("you are not in that room");
            }
            let windows = Self::windows(&st, &room, &who.principal);
            lines.retain(|l| {
                let ts = pj::num(l, "ts");
                windows.iter().any(|(a, b)| *a <= ts && ts <= *b)
            });
        }
        let cut = lines.len().saturating_sub(limit);
        Ok(obj([("lines", Value::Array(lines[cut..].iter().map(|l| Value::Object((*l).clone())).collect()))]))
    }

    // ── presence ─────────────────────────────────────────────────────────────────────────────────────────────

    #[cfg(test)]
    pub fn hello(&self, who: &Identity, address: &str, client: &Obj) -> R<Obj> {
        self.hello_active(who, address, client, true)
    }

    /// hello with PR-1 1.1's `active` (false: the app opens its session while not on screen).
    pub fn hello_active(&self, who: &Identity, address: &str, client: &Obj, active: bool) -> R<Obj> {
        self.hello_resume(who, address, client, active, "")
    }

    /// hello with CD-1's `resume`: the session id this device held before; a live one of this principal and device is
    /// exempt from copy detection, is replaced, and its peers move to the new session.
    pub fn hello_resume(&self, who: &Identity, address: &str, client: &Obj, active: bool, resume: &str) -> R<Obj> {
        if who.seed {
            return forbidden(m::FINISH_SETUP);
        }
        if who.connector {
            return forbidden(bridge::ROUTES_ONLY);
        }
        if who.is_service() && who.kind != "captioner" {
            // WA-1 5.3: the captioner's session is its inbox (caption_request)
            return forbidden(pc::routes_only(&who.kind));
        }
        let client = m::client(Some(&Value::Object(client.clone())));
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            st.check_copy(who, address, resume)?;
            let resumed = st.proven_session(who, resume);
            let before = st.pstate(&who.principal);
            if who.own_device() {
                let old: Vec<String> = st.sessions.values().filter(|s| s.who.principal == who.principal && s.who.device == who.device).map(|s| s.session_id.clone()).collect();
                for id in old {
                    st.end_session(&id, "replaced", false);
                }
            }
            st.seen(who);
            let session = Session {
                session_id: pj::token_urlsafe(12),
                who: who.clone(),
                since: pj::now(),
                last_seen: pj::mono(),
                seq: 0,
                events: VecDeque::new(),
                address: address.to_string(),
                client: client.clone(),
                waiters: 0,
                active,
            };
            let sid = session.session_id.clone();
            st.sessions.insert(sid.clone(), session);
            if !resumed.is_empty() {
                for p in st.peers.values_mut().filter(|p| p.session == resumed) {
                    p.session = sid.clone();
                }
            }
            st.announce(who, &before);
            let now = pj::now();
            let online = st.online();
            let mut people: Vec<(&String, &Value)> = st.directory.iter().collect();
            people.sort_by(|a, b| a.0.cmp(b.0));
            let people: Vec<Value> = people
                .into_iter()
                .filter(|(p, _)| **p != who.principal)
                .map(|(p, e)| {
                    let e = e.as_object().cloned().unwrap_or_default();
                    let on = online.get(p);
                    let name = pj::s(&e, "name");
                    let (presence, mobile) = st.presence_of(p);
                    Value::Object(obj([
                        ("principal", Value::from(p.clone())),
                        ("name", Value::from(if name.is_empty() { p.clone() } else { name })),
                        ("last_seen", if on.is_some() { f(now) } else { e.get("last_seen").cloned().unwrap_or(Value::from(0)) }),
                        ("online", Value::Bool(on.is_some())),
                        ("devices", on.and_then(|o| o.get("devices").cloned()).unwrap_or(Value::Array(Vec::new()))),
                        ("org", st.org(p)),
                        ("status", st.status_of(p)),
                        ("presence", Value::from(presence)),
                        ("mobile", Value::Bool(mobile)),
                    ]))
                })
                .collect();
            let invites: Vec<Value> = st.invites.get(&who.principal).map(|l| l.iter().filter(|i| pj::num(i, "ts") > now - INVITE_TTL && hears_invite(&client, i)).map(|i| Value::Object(i.clone())).collect()).unwrap_or_default();
            let renewed = st.renewed.get(&m::key(&who.principal, &who.device)).cloned().unwrap_or(Value::Null);
            let admin = st.admins.contains(&who.principal);
            let mut reply = obj([
                ("session", Value::from(sid.clone())),
                (
                    "you",
                    Value::Object(obj([
                        ("principal", Value::from(who.principal.clone())),
                        ("name", Value::from(who.name.clone())),
                        ("device", Value::from(who.device.clone())),
                        ("device_label", Value::from(who.device_label.clone())),
                        ("seed", Value::Bool(who.seed)),
                    ])),
                ),
                ("admin", Value::Bool(admin)),
                ("alerts", Value::Array(if admin { st.alerts.iter().cloned().map(Value::Object).collect() } else { Vec::new() })),
                ("online", Value::Array(online.into_values().map(Value::Object).collect())),
                ("people", Value::Array(people)),
                ("invites", Value::Array(invites)),
                ("renewed", renewed),
                ("unread", Value::Object(st.unread(&who.principal))),
                ("attendance", Value::Bool(st.pa_attendance_on())),
                ("push", Value::Bool(st.pu_on())),
            ]);
            // NT-1: push_voip, notify_previews and the invitations settled in the last 2 hours
            reply.extend(st.nt_hello(&who.principal));
            reply.extend(st.ce_hello());
            reply.extend(st.pc_hello());
            if who.kind == "captioner" {
                reply = obj([("session", reply["session"].clone()), ("you", reply["you"].clone())]);
            }
            Ok((reply, sid))
        })();
        drop(st);
        self.wake();
        let (reply, sid) = r?;
        log_info(&format!(
            "hello principal={} session={sid} device={} device_label={} app={} version={} platform={}",
            who.principal,
            kv(&who.device),
            kv(&who.device_label),
            kv_of(client.get("app")),
            kv_of(client.get("version")),
            kv_of(client.get("platform"))
        ));
        Ok(reply)
    }

    pub fn inbox(&self, session: &str, who: &Identity, after: i64, wait: f64) -> R<Obj> {
        let deadline = pj::mono() + wait.max(0.0);
        let mut st = self.st.lock();
        st.session(session, who)?;
        {
            let s = st.sessions.get_mut(session).expect("session");
            s.last_seen = pj::mono();
            s.waiters += 1;
        }
        // NT-1 section 3.6: live for push while the latest poll started less than 15 s ago
        st.nt_polled(session);
        let pending = |q: &VecDeque<Obj>| -> Vec<Value> { q.iter().filter(|e| seq_of(e) > after).map(|e| Value::Object(e.clone())).collect() };
        let out = loop {
            let found = match st.sessions.get(session) {
                Some(s) => pending(&s.events),
                None => break st.gone.get(session).map(|g| pending(&g.events)).unwrap_or_default(),
            };
            if !found.is_empty() {
                break found;
            }
            let left = deadline - pj::mono();
            if left <= 0.0 {
                break Vec::new();
            }
            self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
        };
        if let Some(s) = st.sessions.get_mut(session) {
            s.waiters -= 1;
        } else if let Some(g) = st.gone.get_mut(session) {
            g.waiters -= 1;
            if g.waiters <= 0 {
                st.gone.remove(session);
            }
        }
        Ok(obj([("events", Value::Array(out))]))
    }

    pub fn bye(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        st.end_session(session, "bye", true);
        drop(st);
        self.wake();
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// PR-1 1.1 `POST /v1/activity {session, active}`: whether the person is using this device. `{ok, presence,
    /// mobile}` (the caller's own); every session hears a `presence` event when that changed the person's state.
    pub fn activity(&self, session: &str, who: &Identity, active: Body) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let active = parse_active(active, None)?;
        let before = st.pstate(&who.principal);
        let changed = match st.sessions.get_mut(session) {
            Some(s) if s.active != active => {
                s.active = active;
                true
            }
            _ => false,
        };
        st.announce(who, &before);
        let (presence, mobile) = st.presence_of(&who.principal);
        drop(st);
        self.wake();
        if changed {
            log_info(&format!("activity principal={} session={session} active={}", who.principal, if active { "yes" } else { "no" }));
        }
        Ok(obj([("ok", Value::Bool(true)), ("presence", Value::from(presence)), ("mobile", Value::Bool(mobile))]))
    }

    // ── direct messages and reactions ────────────────────────────────────────────────────────────────────────

    /// dm: a plain direct message (`text`, `reply_to`, `thread`, `preview`): always refused (409), every direct
    /// message is end-to-end encrypted (ce_post).
    pub fn dm(&self, session: &str, who: &Identity) -> R<Obj> {
        self.st.lock().session(session, who)?;
        Err(E::Conflict(ce::PLAIN.into()))
    }

    /// dm_history: the conversation with `with_` after `after`, oldest first (thread replies included, for apps that
    /// know no threads). With `thread` (a root id): that root first, then its replies after `after`.
    pub fn dm_history(&self, session: &str, who: &Identity, with_: &str, after: &Value, limit: i64, thread: Body) -> R<Obj> {
        let with_ = with_.trim().to_lowercase();
        let after = m::number(Some(after), "after")?;
        let limit = limit.clamp(1, DM_LIMIT_MAX) as usize;
        let thread = message_id(thread, "thread")?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let view = st.ce_dm_view();
        let empty = Vec::new();
        let list = st.dms.get(&conv(&who.principal, &with_)).unwrap_or(&empty);
        let msgs: Vec<Obj> = match &thread {
            Some(root) => channels::thread_view(list, root, after, limit)?,
            None => {
                let kept: Vec<&Obj> = list.iter().filter(|m| pj::num(m, "ts") > after).collect();
                kept[kept.len().saturating_sub(limit)..].iter().map(|m| (*m).clone()).collect()
            }
        };
        // how far the other person has read, if they send read receipts
        let read_by_them = as_obj(st.receipts.get(&with_)).and_then(|o| o.get(&who.principal)).cloned().unwrap_or(Value::from(0));
        let mut out = obj([("messages", Value::Array(msgs.into_iter().map(Value::Object).collect())), ("read_by_them", read_by_them)]);
        out.extend(view);
        Ok(out)
    }

    /// dm_read: mark the conversation with `with_` read up to `ts`. With `receipt` (the default) the other person sees
    /// it: their sessions hear `dm_read` when the mark moves forward. `receipt: false` withdraws a mark they could see
    /// (`dm_read` with ts 0) and keeps this one to the reader.
    pub fn dm_read(&self, session: &str, who: &Identity, with_: &str, ts: Body, receipt_v: Body) -> R<Obj> {
        let with_ = with_.trim().to_lowercase();
        let ts = m::number(ts, "ts")?;
        let receipt = receipt(receipt_v)?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let marks = obj_mut(&mut st.read, &who.principal);
        if ts > pj::as_num(marks.get(&with_)).unwrap_or(0.0) {
            marks.insert(with_.clone(), f(ts));
            st.dirty = true;
            // NT-1: the reader's other sessions clear that conversation's notifications
            st.tell(std::slice::from_ref(&who.principal), &obj([("type", Value::from("read")), ("conv", Value::from(format!("dm:{with_}")))]), Some(session));
        }
        let seen = obj_mut(&mut st.receipts, &who.principal);
        let mut told: Option<Value> = None;
        if receipt && ts > pj::as_num(seen.get(&with_)).unwrap_or(0.0) {
            seen.insert(with_.clone(), f(ts));
            told = Some(f(ts));
        } else if !receipt && seen.shift_remove(&with_).is_some() {
            told = Some(Value::from(0));
        }
        if seen.is_empty() {
            st.receipts.shift_remove(&who.principal);
        }
        if let Some(ts) = told {
            if with_ != who.principal {
                st.dirty = true;
                st.tell(std::slice::from_ref(&with_), &obj([("type", Value::from("dm_read")), ("by", Value::from(who.principal.clone())), ("ts", ts)]), None);
            }
        }
        drop(st);
        self.wake();
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// _toggle: the caller's reaction on or off.
    fn toggle(item: &mut Obj, emoji: &str, principal: &str) -> R<bool> {
        if pj::truthy(item.get("deleted")) {
            return bad("that message was deleted");
        }
        let reactions = obj_mut(item, "reactions");
        if let Some(Value::Array(people)) = reactions.get_mut(emoji) {
            if let Some(i) = people.iter().position(|p| p.as_str() == Some(principal)) {
                people.remove(i);
                if people.is_empty() {
                    reactions.shift_remove(emoji);
                }
                return Ok(false);
            }
        }
        if !reactions.contains_key(emoji) {
            if reactions.len() >= REACTIONS_MAX {
                return bad("this message has too many different reactions");
            }
            reactions.insert(emoji.to_string(), Value::Array(Vec::new()));
        }
        if let Some(Value::Array(people)) = reactions.get_mut(emoji) {
            people.push(Value::from(principal));
        }
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn react(&self, who: &Identity, scope: &str, id: &str, emoji: &str, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let emoji = emoji.trim().to_string();
        if !self.pa_custom_reaction(&emoji)? && (emoji.is_empty() || pj::char_len(&emoji) > EMOJI_MAX) {
            return bad(format!("a reaction is one emoji (at most {EMOJI_MAX} characters)"));
        }
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let (on, reactions) = if scope == "room" {
                let Some(peer) = &peer else { return bad("a reaction in a room needs your room session (peer)") };
                st.owned(peer, who)?;
                let room = st.peers[peer.as_str()].room.clone();
                st.ce_plain(Some(&room), None)?;
                let lines = st.rooms.get_mut(&room);
                let target = lines.and_then(|l| l.iter_mut().find(|l| pj::text_of(l, "id") == id && pj::text_of(l, "kind") == "chat"));
                let Some(target) = target else { return Err(E::NotFound("that message is no longer kept".into())) };
                let on = Self::toggle(target, emoji.as_str(), &who.principal)?;
                let reactions = target.get("reactions").cloned().unwrap_or(Value::Object(Obj::new()));
                let mut line = obj([
                    ("kind", Value::from("react")),
                    ("id", Value::from(pj::token_hex(6))),
                    ("target", Value::from(id)),
                    ("emoji", Value::from(emoji.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("name", Value::from(who.name.clone())),
                    ("on", Value::Bool(on)),
                    ("ts", f(pj::now())),
                ]);
                st.room_log(&room, &mut line);
                st.broadcast(
                    &room,
                    &obj([
                        ("type", Value::from("react")),
                        ("scope", Value::from("room")),
                        ("id", Value::from(id)),
                        ("emoji", Value::from(emoji.clone())),
                        ("principal", Value::from(who.principal.clone())),
                        ("name", Value::from(who.name.clone())),
                        ("on", Value::Bool(on)),
                        ("room", Value::from(room.clone())),
                    ]),
                    None,
                );
                (on, reactions)
            } else if scope == "dm" {
                // every direct message is encrypted: a signed `react` event (/v1/chat/event)
                Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), None, true)?;
                return Err(E::Conflict(ce::PLAIN.into()));
            } else if scope == "channel" {
                let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
                let Conv::Channel(cid) = &c else { return bad(SCOPE_ERROR) };
                st.ce_plain(None, Some(cid))?;
                let i = Self::scoped_index(&st, who, &c, id)?;
                let target = &mut st.channel_msgs.get_mut(cid).expect("the message's channel")[i];
                let on = Self::toggle(target, emoji.as_str(), &who.principal)?;
                let reactions = target.get("reactions").cloned().unwrap_or(Value::Object(Obj::new()));
                let members = channels::members_of(as_obj(st.channels.get(cid)));
                let event = obj([
                    ("type", Value::from("react")),
                    ("scope", Value::from("channel")),
                    ("id", Value::from(id)),
                    ("emoji", Value::from(emoji.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("name", Value::from(who.name.clone())),
                    ("on", Value::Bool(on)),
                    ("channel", Value::from(cid.clone())),
                ]);
                st.tell(&members, &event, None);
                st.dirty = true;
                st.bridge_chan_reacted(cid, id, &emoji, who, on);
                (on, reactions)
            } else {
                return bad(SCOPE_ERROR);
            };
            Ok(obj([("id", Value::from(id)), ("emoji", Value::from(emoji.clone())), ("on", Value::Bool(on)), ("reactions", reactions)]))
        })();
        drop(st);
        self.wake();
        r
    }

    // ── presence status and organizations ────────────────────────────────────────────────────────────────────

    /// set_status (`POST /v1/status`): the status this person sets (available, busy, dnd, away and an optional text);
    /// `state` absent or "auto" goes back to automatic (null). Every session hears a `presence` event about them when
    /// it changes. `until` (ms, from a minute to 7 days ahead) clears it then (ignored for automatic).
    pub fn set_status(&self, session: &str, who: &Identity, state: Body, text: Body, until: Body) -> R<Obj> {
        let mut status = status(state, text)?;
        if let Some(s) = status.as_mut() {
            if let Some(at) = parity::status_until(until)? {
                s.insert("until".into(), Value::from(at));
            }
        }
        let mut st = self.st.lock();
        st.session(session, who)?;
        let value = status.clone().map(Value::Object);
        if st.statuses.get(&who.principal) != value.as_ref() {
            match &value {
                None => {
                    st.statuses.shift_remove(&who.principal);
                }
                Some(v) => {
                    st.statuses.insert(who.principal.clone(), v.clone());
                }
            }
            st.dirty = true;
            st.tell_presence(&who.principal);
        }
        drop(st);
        self.wake();
        log_info(&format!("status principal={} state={}", who.principal, status.as_ref().map(|s| pj::text_of(s, "state")).unwrap_or_else(|| "auto".into())));
        Ok(obj([("ok", Value::Bool(true)), ("status", value.unwrap_or(Value::Null))]))
    }

    /// _org_list: `{members: [{id, label, principal, name}], organizations: [{id, label}]}`.
    fn org_list(st: &State) -> Obj {
        let mut principals: Vec<&String> = st.organizations.keys().chain(st.org_edits.keys()).collect();
        principals.sort();
        principals.dedup();
        let mut members: Vec<Value> = Vec::new();
        let mut known: Vec<(String, String)> = Vec::new();
        for principal in principals {
            let Value::Object(org) = st.org(principal) else { continue };
            let name = st.directory.get(principal).and_then(Value::as_object).map(|e| pj::s(e, "name")).unwrap_or_default();
            let pair = (pj::text_of(&org, "id"), pj::text_of(&org, "label"));
            if !known.contains(&pair) {
                known.push(pair);
            }
            members.push(Value::Object(with(&org, obj([("principal", Value::from(principal.clone())), ("name", Value::from(if name.is_empty() { principal.clone() } else { name }))]))));
        }
        known.sort();
        let organizations: Vec<Value> = known.into_iter().map(|(id, label)| Value::Object(obj([("id", Value::from(id)), ("label", Value::from(label))]))).collect();
        obj([("members", Value::Array(members)), ("organizations", Value::Array(organizations))])
    }

    /// admin_organizations: `{members: [{id, label, principal, name}], organizations: [{id, label}]}`.
    pub fn admin_organizations(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.check_admin(session, who)?;
        Ok(Self::org_list(&st))
    }

    /// admin_set_organization: an admin puts a person in an organization (`id`, `label`) or takes them out
    /// (`remove: true`). Kept in state.json over relay.json's `organizations`; every session hears a `presence` event
    /// about the person when it changes.
    pub fn admin_set_organization(&self, session: &str, who: &Identity, principal: Body, id: Body, label: Body, remove: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, Option<Obj>)> {
            st.check_admin(session, who)?;
            let principal = m::principal(principal);
            if principal.is_empty() {
                return bad("name the person (principal)");
            }
            let remove = m::flag(remove, "remove")?;
            let entry = if remove {
                None
            } else {
                let owner = Value::Object(obj([("id", Value::from(org_field(id, "id")?)), ("label", Value::from(org_field(label, "label")?))]));
                Some(m::org_entry(&principal, &owner)?)
            };
            let before = st.org(&principal);
            let base = st.organizations.get(&principal).and_then(Value::as_object).cloned();
            if entry == base {
                st.org_edits.shift_remove(&principal);
            } else {
                st.org_edits.insert(principal.clone(), entry.clone().map(Value::Object).unwrap_or(Value::Null));
            }
            st.dirty = true;
            if st.org(&principal) != before {
                st.tell_presence(&principal);
                st.bridge_recheck("relay", None, None);
            }
            Ok((with(&Self::org_list(&st), obj([("ok", Value::Bool(true))])), principal, entry))
        })();
        drop(st);
        self.wake();
        let (out, principal, entry) = r?;
        let org = entry.map(|e| pj::text_of(&e, "id")).unwrap_or_else(|| "-".into());
        log_info(&format!("organization principal={principal} by={} org={}", who.principal, kv(&org)));
        Ok(out)
    }

    // ── invitations ──────────────────────────────────────────────────────────────────────────────────────────

    fn crossed_call(st: &State, caller: &str, targets: &[String], room: &str, now: f64) -> Option<Obj> {
        if targets.len() != 1 {
            return None;
        }
        let other = &targets[0];
        let left = as_obj(st.left.get(other)).cloned().unwrap_or_default();
        for inv in st.invites.get(caller).map(|l| l.as_slice()).unwrap_or_default().iter().rev() {
            let ts = pj::num(inv, "ts");
            let r = pj::text_of(inv, "room");
            if pj::text_of(inv, "from") == *other && pj::truthy(inv.get("room")) && pj::py_str(inv.get("room").unwrap_or(&Value::Null)) != room && now - ts <= MERGE_WINDOW && pj::as_num(left.get(&r)).unwrap_or(0.0) < ts {
                return Some(inv.clone());
            }
        }
        None
    }

    pub fn invite(&self, session: &str, who: &Identity, to: Body, room: Body, host: Body) -> R<Obj> {
        let list: Vec<Value> = match to {
            Some(Value::String(s)) => vec![Value::from(s.clone())],
            Some(Value::Array(a)) if !a.is_empty() => a.clone(),
            _ => return bad("name at least one person to invite"),
        };
        if list.len() > INVITE_MAX_TO {
            return bad(format!("invite at most {INVITE_MAX_TO} people at once"));
        }
        let mut targets: Vec<String> = Vec::new();
        for t in &list {
            let t = m::principal(Some(t));
            if !t.is_empty() && !targets.contains(&t) {
                targets.push(t);
            }
        }
        if targets.is_empty() {
            return bad("name at least one person to invite");
        }
        let room = m::room_name(room)?;
        let host = m::host(host)?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let missing: Vec<&String> = targets.iter().filter(|t| !st.directory.contains_key(t.as_str())).collect();
        if !missing.is_empty() {
            return Err(E::NotFound(format!("not known on this relay: {}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))));
        }
        let now = st.nt_now();
        if let Some(crossed) = Self::crossed_call(&st, &who.principal, &targets, &room, now) {
            let into = crossed.get("room").cloned().unwrap_or(Value::Null);
            let merged = obj([
                ("merged", into.clone()),
                ("host", crossed.get("host").filter(|h| pj::truthy(Some(*h))).cloned().unwrap_or(Value::Null)),
                ("from", crossed.get("from").cloned().unwrap_or(Value::Null)),
                ("invites", Value::Array(Vec::new())),
            ]);
            drop(st);
            log_info(&format!("invite merged from={} to={} room={room} into={}", who.principal, targets[0], pj::py_str(&into)));
            return Ok(merged);
        }
        // NT-1 section 3.5: each invite's kind (call or live), whether it rings (the ring bucket of section 3.7) and the
        // ring left (`ring_ms_left`, the full 45 s now) for the invitee's event and the inviter's answer
        let mut out = Vec::new();
        for t in &targets {
            let id = pj::token_hex(8);
            let (kind, others) = st.nt_kind(&who.principal, t, &room, now);
            let ring = st.nt_ring(&who.principal, t, &room, &id);
            let inv = obj([
                ("id", Value::from(id)),
                ("from", Value::from(who.principal.clone())),
                ("from_name", Value::from(who.name.clone())),
                ("to", Value::from(t.clone())),
                ("room", Value::from(room.clone())),
                ("ts", f(now)),
                ("host", host.clone().map(Value::Object).unwrap_or(Value::Null)),
                ("kind", Value::from(kind)),
                ("ring", Value::Bool(ring)),
            ]);
            let mut pending: Vec<Obj> = st.invites.get(t).cloned().unwrap_or_default().into_iter().filter(|i| !(pj::text_of(i, "room") == room && pj::text_of(i, "from") == who.principal)).collect();
            pending.push(inv.clone());
            st.invites.insert(t.clone(), pending);
            let shown = with(&inv, obj([("ring_ms_left", Value::from((push::RING_SECONDS * 1000.0) as i64))]));
            let event = with(&shown, obj([("type", Value::from("invite"))]));
            for s in st.sessions.values_mut().filter(|s| s.who.principal == *t && hears_invite(&s.client, &inv)) {
                push(&mut s.seq, &mut s.events, &event);
            }
            if ring {
                st.nt_call(&inv, others);
            }
            out.push(Value::Object(shown));
        }
        st.dirty = true;
        drop(st);
        self.wake();
        log_info(&format!("invite from={} room={room} people={}", who.principal, out.len()));
        Ok(obj([("invites", Value::Array(out))]))
    }

    // ── sessions, admins, the version gate ───────────────────────────────────────────────────────────────────

    pub fn check_admin(&self, session: &str, who: &Identity) -> R<()> {
        self.st.lock().check_admin(session, who)
    }

    pub fn check_session(&self, session: &str, who: &Identity) -> R<()> {
        self.st.lock().session(session, who)
    }

    /// client_of: the `client` the caller's peer (or session) said; None when the named one is not the caller's.
    pub fn client_of(&self, who: &Identity, peer: &str, session: &str) -> Option<Obj> {
        let st = self.st.lock();
        if !peer.is_empty() || !session.is_empty() {
            let item = if !peer.is_empty() { st.peers.get(peer).map(|p| (&p.who, &p.client)) } else { st.sessions.get(session).map(|s| (&s.who, &s.client)) };
            return match item {
                Some((w, c)) if w.principal == who.principal => Some(c.clone()),
                _ => None,
            };
        }
        for (w, c) in st.peers.values().map(|p| (&p.who, &p.client)).chain(st.sessions.values().map(|s| (&s.who, &s.client))) {
            if w.principal == who.principal && w.device == who.device {
                return Some(c.clone());
            }
        }
        Some(Obj::new())
    }

    pub fn alerts(&self) -> Vec<Obj> {
        self.st.lock().alerts.clone()
    }

    pub fn set_alerts(&self, alerts: Vec<Obj>) {
        let mut st = self.st.lock();
        st.alerts = alerts;
        for a in st.alerts.clone() {
            st.tell_admins(&a);
        }
        drop(st);
        self.wake();
    }

    /// deny: refuse these serials from now on (`[{serial, not_after}]` from the signer).
    pub fn deny(&self, rows: &[Obj], principal: &str, device: &str) -> Vec<String> {
        let now = pj::now();
        let mut out = Vec::new();
        let mut st = self.st.lock();
        for row in rows {
            let serial = m::serial_of(row.get("serial"));
            if serial.is_empty() {
                continue;
            }
            let until = row.get("not_after").and_then(|v| pj::from_iso(&pj::py_str(v))).unwrap_or(now + DENY_KEEP);
            st.denied.insert(serial.clone(), Value::Object(obj([("principal", Value::from(principal)), ("device", Value::from(device)), ("until", f(until)), ("ts", f(now))])));
            out.push(serial);
        }
        st.dirty = true;
        drop(st);
        // AC-1 3.2: the console latches every passkey anchored to a denied serial before it answers anything else
        self.console_revoked(&out);
        out
    }

    pub fn is_denied(&self, serial: &str) -> bool {
        let s = m::serial(serial);
        !s.is_empty() && self.st.lock().denied.contains_key(&s)
    }

    /// AC-2a 4.11 `meet/counts` and 9.1: what this relay holds, as counts and the principals and devices to count with
    /// the console's blocks and seats. People are the directory's principals and everyone online (never the console,
    /// guests, connectors or services); devices those of admin_devices.
    pub fn fleet_counts(&self) -> FleetCounts {
        let st = self.st.lock();
        let person = |w: &Identity| !(w.is_console() || w.guest || w.connector || w.is_service());
        let mut devices: HashSet<(String, String)> = HashSet::new();
        let mut online_devices: HashSet<(String, String)> = HashSet::new();
        for w in st.sessions.values().map(|s| &s.who).chain(st.peers.values().map(|p| &p.who)) {
            if !w.device.is_empty() && person(w) {
                online_devices.insert((w.principal.clone(), w.device.clone()));
            }
        }
        let mut revoked = 0;
        for (principal, entry) in &st.directory {
            let Some(list) = entry.as_object().and_then(|e| e.get("devices")).and_then(Value::as_object) else { continue };
            for (device, info) in list {
                let Some(info) = info.as_object() else { continue };
                devices.insert((principal.clone(), device.clone()));
                let serial = m::serial_of(info.get("serial"));
                revoked += usize::from(!serial.is_empty() && st.denied.contains_key(&serial));
            }
        }
        devices.extend(online_devices.iter().cloned());
        let online: HashSet<String> = st.online().into_keys().collect();
        let mut principals: HashSet<String> = st.directory.keys().cloned().collect();
        principals.extend(online.iter().cloned());
        let mut rooms: HashMap<&str, usize> = HashMap::new();
        for p in st.peers.values().filter(|p| !p.who.is_console()) {
            *rooms.entry(p.room.as_str()).or_default() += 1;
        }
        let waiting = st.enrollments.values().filter_map(Value::as_object).filter(|r| pj::text_of(r, "state") == "waiting").count()
            + st.seed_requests.len()
            + st.renewals.values().filter_map(Value::as_object).filter(|r| pj::truthy(r.get("needs_admin"))).count();
        FleetCounts {
            principals: principals.into_iter().collect(),
            online,
            devices: devices.into_iter().collect(),
            devices_online: online_devices.len(),
            revoked,
            calls_active: rooms.values().filter(|n| **n >= 2).count(),
            participants: rooms.values().sum(),
            enrollments_waiting: waiting,
        }
    }

    // ── AC-1: the Admin Console's hooks (contract 3.2, 3.8, 4.9) ─────────────────────────────────────────────

    /// check_console_admin (I8): the same rule as check_admin (the principal is in relay.json `admins`) without a
    /// presence session or client certificate; Ok is the `console` Identity the Hub functions are called with.
    pub fn check_console_admin(&self, principal: &str) -> R<Identity> {
        let who = Identity::console_admin(principal);
        if who.principal.is_empty() || !self.st.lock().admins.contains(&who.principal) {
            return forbidden("only the person who issues certificates can do that");
        }
        Ok(who)
    }

    /// check_console_reader (4.9, I14): an active console user manager or admin may read through the same functions
    /// with the `console` Identity; reads only (every write still goes through check_console_admin).
    pub fn check_console_reader(&self, email: &str) -> R<Identity> {
        let who = Identity::console_reader(email);
        if who.principal.is_empty() || !self.console_hooks().is_some_and(|h| h.reader(&who.principal)) {
            return forbidden("only an admin or user manager of this console can read this");
        }
        Ok(who)
    }

    pub fn console_hooks_installed(&self) -> Option<Arc<dyn ConsoleHooks>> {
        self.console_hooks()
    }

    /// Whether `principal` is in relay.json `admins` now.
    pub fn is_admin(&self, principal: &str) -> bool {
        self.st.lock().admins.contains(&principal.trim().to_lowercase())
    }

    /// The certificate serials the relay knows for one principal's devices (directory and live sessions): the
    /// anchors a Meet admin's passkey may have (3.2, decision 14).
    pub fn device_serials(&self, principal: &str) -> HashSet<String> {
        let principal = principal.trim().to_lowercase();
        let st = self.st.lock();
        let mut out: HashSet<String> = HashSet::new();
        if let Some(devices) = st.directory.get(&principal).and_then(|e| e.get("devices")).and_then(Value::as_object) {
            for d in devices.values() {
                let s = m::serial_of(d.get("serial"));
                if !s.is_empty() {
                    out.insert(s);
                }
            }
        }
        for who in st.sessions.values().map(|s| &s.who).chain(st.peers.values().map(|p| &p.who)) {
            if who.principal == principal && !who.serial.is_empty() {
                out.insert(m::serial(&who.serial));
            }
        }
        out
    }

    /// Every serial in the denied set (anchor latching reads it at start and on each change).
    pub fn denied_serials(&self) -> HashSet<String> {
        self.st.lock().denied.keys().cloned().collect()
    }

    /// AC-1 2.4: install the service gate (once, at start, before the ports listen).
    pub fn set_gate(&self, gate: Arc<crate::meet_license::MeetGate>) {
        *self.gate.lock() = Some(gate);
    }

    pub fn gate(&self) -> Option<Arc<crate::meet_license::MeetGate>> {
        self.gate.lock().clone()
    }

    /// AC-1 2.4 seats: the principals with at least one device certificate the relay knows that is neither revoked
    /// nor expired at `now` (seconds). The device store is the directory: each device record keeps `serial`,
    /// `not_before` and `not_after` of the certificate it was last seen with (records from before AC-1 have none and
    /// count while no denied entry names that principal and device).
    pub fn seat_live(&self, now: i64) -> Vec<String> {
        let st = self.st.lock();
        let denied_devices: HashSet<(String, String)> = st.denied.values().filter_map(Value::as_object).map(|d| (pj::s(d, "principal"), pj::s(d, "device"))).collect();
        let mut out: Vec<String> = st
            .directory
            .iter()
            .filter(|(principal, e)| {
                e.get("devices").and_then(Value::as_object).is_some_and(|d| {
                    d.iter().any(|(device, dev)| {
                        let serial = m::serial_of(dev.get("serial"));
                        if serial.is_empty() {
                            return !denied_devices.contains(&((*principal).clone(), device.clone()));
                        }
                        let alive = dev.get("not_after").and_then(Value::as_i64).map(|na| na == 0 || na > now).unwrap_or(true);
                        !st.denied.contains_key(&serial) && alive
                    })
                })
            })
            .map(|(p, _)| p.clone())
            .collect();
        out.sort();
        out
    }

    /// AC-1 2.4 "`firstSeen` at the upgrade" (R3-M5): every principal with devices and the earliest persisted
    /// timestamp the relay holds for it, in milliseconds: the device record's `added` (seconds, AC-1 records), the
    /// certificate's `not_before` (seconds) and the `ts` (seconds) of the principal's enrollments. `last_seen` is
    /// not a creation time and is never used. None when there is no such record.
    pub fn seat_records(&self) -> Vec<(String, Option<i64>)> {
        let st = self.st.lock();
        let mut out = Vec::new();
        for (principal, e) in &st.directory {
            let Some(devices) = e.get("devices").and_then(Value::as_object).filter(|d| !d.is_empty()) else { continue };
            let mut first: Option<f64> = None;
            let mut take = |v: Option<f64>| {
                if let Some(v) = v.filter(|v| *v > 0.0) {
                    first = Some(first.map_or(v, |f| f.min(v)));
                }
            };
            for d in devices.values() {
                take(d.get("added").and_then(Value::as_f64));
                take(d.get("not_before").and_then(Value::as_f64));
            }
            for r in st.enrollments.values().filter_map(Value::as_object) {
                if pj::s(r, "principal") == *principal {
                    take(r.get("ts").and_then(Value::as_f64));
                }
            }
            out.push((principal.clone(), first.map(|s| (s * 1000.0) as i64)));
        }
        out
    }

    /// AC-1 2.4: an unseated principal's sessions close (their certificates stay).
    pub fn drop_principal(&self, principal: &str) -> i64 {
        let wanted: HashSet<String> = {
            let st = self.st.lock();
            st.sessions.values().map(|s| &s.who).chain(st.peers.values().map(|p| &p.who)).filter(|w| w.principal == principal && !w.serial.is_empty()).map(|w| m::serial(&w.serial)).collect()
        };
        if wanted.is_empty() {
            return 0;
        }
        let n = self.st.lock().drop_matching(&wanted);
        self.wake();
        n
    }

    /// Install the Admin Console's hooks (once, at start).
    pub fn set_console_hooks(&self, hooks: Arc<dyn ConsoleHooks>) {
        *self.console_hooks.lock() = Some(hooks);
    }

    fn console_hooks(&self) -> Option<Arc<dyn ConsoleHooks>> {
        self.console_hooks.lock().clone()
    }

    /// Serials newly revoked (the denied set, a CRL the relay holds, /v1/admin/revoke): the console latches every
    /// passkey anchored to one (3.2). A Meet block is never one.
    pub fn console_revoked(&self, serials: &[String]) {
        if serials.is_empty() {
            return;
        }
        if let Some(h) = self.console_hooks() {
            h.revoked(serials);
        }
    }

    /// An outcome the console observes for its `meet.*` requests (3.8): `kind` is the request kind, `target` what was
    /// done, `by` the Meet admin principal, `link` the optional `console_request` the app sent.
    pub fn console_observed(&self, kind: &str, target: &Obj, by: &str, link: Option<&str>) {
        if let Some(h) = self.console_hooks() {
            h.observed(kind, target, by, link);
        }
    }

    /// AC-1 Meet blocks (4.9): the `denied_until` mirror the console's block store keeps; never the denied set.
    pub fn set_blocks(&self, blocks: HashMap<String, f64>) {
        *self.denied_until.lock() = blocks;
    }

    /// Whether this device is blocked now (`principal|device` until a time in seconds).
    pub fn is_blocked(&self, who: &Identity) -> bool {
        if who.device.is_empty() || who.is_console() {
            return false;
        }
        let now = pj::now();
        self.denied_until.lock().get(&m::key(&who.principal, &who.device)).map(|until| *until > now).unwrap_or(false)
    }

    /// End every live session and peer of one device (a block closes them; it revokes nothing).
    pub fn drop_device(&self, principal: &str, device: &str) -> i64 {
        let wanted: HashSet<String> = {
            let st = self.st.lock();
            st.sessions.values().map(|s| &s.who).chain(st.peers.values().map(|p| &p.who)).filter(|w| w.principal == principal && w.device == device && !w.serial.is_empty()).map(|w| m::serial(&w.serial)).collect()
        };
        if wanted.is_empty() {
            return 0;
        }
        let n = self.st.lock().drop_matching(&wanted);
        self.wake();
        n
    }

    /// drop_serials: end every peer and session whose certificate serial is listed (their push registrations go too).
    pub fn drop_serials(&self, serials: &[String]) -> i64 {
        let wanted: HashSet<String> = serials.iter().map(|s| m::serial(s)).filter(|s| !s.is_empty()).collect();
        if wanted.is_empty() {
            return 0;
        }
        let mut st = self.st.lock();
        let n = st.drop_matching(&wanted);
        st.pu_drop_serials(&wanted);
        st.wa_drop_serials(&wanted); // WA-1: web port sessions go at once
        drop(st);
        self.wake();
        n
    }

    // ── the signer ───────────────────────────────────────────────────────────────────────────────────────────

    /// _ask_signer: the signer's answer to a proved request, or None (no signer, down, or an older app).
    fn ask_signer(&self, op: &str, who: &Identity, chain: Body, proof: Body, ts: Body, extra: Obj) -> R<Option<Obj>> {
        let Some(signer) = &self.signer else { return Ok(None) };
        if !proved(who, chain, proof) || !signer.ready() {
            return Ok(None);
        }
        let body = with(&extra, obj([("cert_pem", Value::from(who.cert_pem.clone())), ("proof", Value::from(str_value(proof))), ("ts", proof_ts(ts))]));
        match signer.call(op, &body) {
            Ok(a) => Ok(Some(a)),
            Err(SignerErr::Down(_)) => Ok(None),
            Err(SignerErr::Refused(e)) => Err(e),
        }
    }

    fn signer_call(&self, op: &str, body: &Obj) -> R<Obj> {
        let Some(signer) = &self.signer else { return Err(E::Unavailable(SIGNER_DOWN.into())) };
        match signer.call(op, body) {
            Ok(a) => Ok(a),
            Err(SignerErr::Down(_)) => Err(E::Unavailable(SIGNER_DOWN.into())),
            Err(SignerErr::Refused(e)) => Err(e),
        }
    }

    fn signer_ready(&self) -> bool {
        self.signer.as_ref().map(|s| s.ready()).unwrap_or(false)
    }

    // ── certificate renewal ──────────────────────────────────────────────────────────────────────────────────

    pub fn renew(&self, session: &str, who: &Identity, csr_pem: Body, chain: Body, proof: Body, ts: Body) -> R<Obj> {
        self.check_session(session, who)?;
        let csr = load_csr(csr_pem)?;
        check_csr_person(&csr, who)?;
        let pem = str_value(csr_pem);
        let answer = self.ask_signer("sign_renewal", who, chain, proof, ts, obj([("csr_pem", Value::from(pem.clone()))]))?;
        let now = pj::now();
        let key = m::key(&who.principal, &who.device);
        let mut st = self.st.lock();
        st.session(session, who)?;
        if let Some(a) = answer.as_ref().filter(|a| pj::text_of(a, "state") == "signed") {
            let renewed = with(&issued(a), obj([("device", Value::from(who.device.clone())), ("ts", f(now))]));
            st.renewals.shift_remove(&key);
            st.renewed.insert(key, Value::Object(renewed.clone()));
            st.dirty = true;
            st.tell_device(&who.principal, &who.device, &with(&renewed, obj([("type", Value::from("renewed"))])));
            drop(st);
            self.wake();
            log_info(&format!("renewed principal={} device={} by=signer", who.principal, who.device));
            return Ok(with(&issued(a), obj([("ok", Value::Bool(true)), ("state", Value::from("signed"))])));
        }
        let mut row = obj([
            ("id", Value::from(pj::token_hex(8))),
            ("principal", Value::from(who.principal.clone())),
            ("name", Value::from(who.name.clone())),
            ("csr_pem", Value::from(pem)),
            ("device", Value::from(who.device.clone())),
            ("device_label", Value::from(who.device_label.clone())),
            ("ts", f(now)),
        ]);
        update(&mut row, proof_fields(who, chain, proof, ts));
        if let Some(a) = &answer {
            update(&mut row, obj([("needs_admin", Value::Bool(true)), ("reason", Value::from(m::reason(a.get("reason"))))]));
        }
        st.renewals.insert(key, Value::Object(row));
        st.dirty = true;
        st.tell_admins(&obj([
            ("type", Value::from("renew_request")),
            ("principal", Value::from(who.principal.clone())),
            ("name", Value::from(who.name.clone())),
            ("device", Value::from(who.device.clone())),
            ("device_label", Value::from(who.device_label.clone())),
            ("ts", f(now)),
        ]));
        drop(st);
        self.wake();
        log_info(&format!("renewal requested principal={} device={} waits_for={}", who.principal, who.device, if answer.is_some() { "admin" } else { "issuer" }));
        Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("waiting"))]))
    }

    pub fn renew_ack(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        if st.renewed.shift_remove(&m::key(&who.principal, &who.device)).is_some() {
            st.dirty = true;
        }
        Ok(obj([("ok", Value::Bool(true))]))
    }

    fn rows_by_ts(rows: &Obj, keep: impl Fn(&Obj) -> bool) -> Vec<Obj> {
        let mut out: Vec<Obj> = rows.values().filter_map(Value::as_object).filter(|r| keep(r)).cloned().collect();
        out.sort_by(|a, b| pj::num(a, "ts").partial_cmp(&pj::num(b, "ts")).unwrap_or(std::cmp::Ordering::Equal));
        out
    }

    pub fn admin_renewals(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.check_admin(session, who)?;
        let rows = Self::rows_by_ts(&st.renewals, |r| !pj::truthy(r.get("needs_admin")));
        Ok(obj([("requests", Value::Array(rows.into_iter().map(Value::Object).collect()))]))
    }

    pub fn admin_renewed(&self, session: &str, who: &Identity, principal: &str, cert_pem: Body, ca_pem: Body, device: Option<String>) -> R<Obj> {
        let principal = principal.trim().to_lowercase();
        self.check_admin(session, who)?;
        let (cert, _) = load_issued(cert_pem, ca_pem)?;
        if !cert_emails(&cert).contains(&principal) {
            return bad("the certificate is for a different email");
        }
        let now = pj::now();
        let mut st = self.st.lock();
        let device = match device {
            Some(d) => d,
            None => {
                let pending: Vec<&Obj> = st.renewals.values().filter_map(Value::as_object).filter(|r| pj::text_of(r, "principal") == principal).collect();
                if pending.len() == 1 { pj::s(pending[0], "device") } else { String::new() }
            }
        };
        let renewed = obj([("cert_pem", Value::from(str_value(cert_pem))), ("ca_pem", Value::from(str_value(ca_pem))), ("device", Value::from(device.clone())), ("ts", f(now))]);
        let key = m::key(&principal, &device);
        st.renewals.shift_remove(&key);
        st.renewed.insert(key, Value::Object(renewed.clone()));
        st.dirty = true;
        st.tell_device(&principal, &device, &with(&renewed, obj([("type", Value::from("renewed"))])));
        drop(st);
        self.wake();
        log_info(&format!("renewed principal={principal} device={device} by={}", who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    // ── enrollment ────────────────────────────────────────────────────────────────────────────────────────────

    pub fn seed_used(&self, serial: &str) -> bool {
        self.st.lock().consumed_seeds.contains_key(&m::serial(serial))
    }

    fn enrol_used(st: &State, serial: &str) -> bool {
        st.consumed_seeds.contains_key(serial) || as_obj(st.enrollments.get(serial)).map(|r| pj::text_of(r, "state") == "signed").unwrap_or(false)
    }

    pub fn enroll(&self, who: &Identity, csr_pem: Body, chain: Body, proof: Body, ts: Body) -> R<Obj> {
        if !who.seed {
            return forbidden("only a new device's invite can ask for a first certificate");
        }
        let csr = load_csr(csr_pem)?;
        check_csr_person(&csr, who)?;
        let (device, label) = csr_device(&csr);
        if device.is_empty() {
            return bad("the certificate request does not name this device");
        }
        let serial = m::serial(&who.serial);
        let used = "this invite was already used on another device";
        if Self::enrol_used(&self.st.lock(), &serial) {
            return Err(E::Conflict(used.into()));
        }
        let pem = str_value(csr_pem);
        let answer = self.ask_signer("sign_enrollment", who, chain, proof, ts, obj([("csr_pem", Value::from(pem.clone()))]))?;
        let signed = answer.as_ref().map(|a| pj::text_of(a, "state") == "signed").unwrap_or(false);
        let now = pj::now();
        let mut st = self.st.lock();
        if Self::enrol_used(&st, &serial) {
            return Err(E::Conflict(used.into()));
        }
        let origin = answer.as_ref().map(|a| pj::s(a, "origin")).unwrap_or_default();
        let mut row = obj([
            ("seed_serial", Value::from(serial.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("name", Value::from(who.name.clone())),
            ("token", Value::from(who.seed_token.clone())),
            ("csr_pem", Value::from(pem)),
            ("device", Value::from(device.clone())),
            ("device_label", Value::from(label.clone())),
            ("ts", f(now)),
            ("state", Value::from("waiting")),
            ("origin", Value::from(origin.clone())),
        ]);
        update(&mut row, proof_fields(who, chain, proof, ts));
        if let Some(a) = &answer {
            if signed {
                update(&mut row, issued(a));
                row.insert("state".into(), Value::from("signed"));
            } else {
                update(&mut row, obj([("needs_admin", Value::Bool(true)), ("reason", Value::from(m::reason(a.get("reason"))))]));
            }
        }
        st.enrollments.insert(serial.clone(), Value::Object(row));
        st.dirty = true;
        if !signed {
            st.tell_admins(&obj([
                ("type", Value::from("enroll_request")),
                ("principal", Value::from(who.principal.clone())),
                ("name", Value::from(who.name.clone())),
                ("device_label", Value::from(label)),
                ("origin", Value::from(origin.clone())),
                ("ts", f(now)),
            ]));
        }
        drop(st);
        self.wake();
        log_info(&format!(
            "enrollment {} principal={} device={device} seed={serial} origin={}",
            if signed { "signed by signer" } else { "requested" },
            who.principal,
            if origin.is_empty() { "-" } else { &origin }
        ));
        match answer {
            Some(a) if signed => Ok(with(&issued(&a), obj([("state", Value::from("signed"))]))),
            _ => Ok(obj([("state", Value::from("waiting"))])),
        }
    }

    pub fn enroll_status(&self, who: &Identity) -> R<Obj> {
        if !who.seed {
            return forbidden("only a new device's invite can ask that");
        }
        let serial = m::serial(&who.serial);
        let mut st = self.st.lock();
        if st.consumed_seeds.contains_key(&serial) {
            return forbidden("this invite was already used");
        }
        let Some(row) = as_obj(st.enrollments.get(&serial)).cloned() else { return Err(E::NotFound("this device has not asked for its certificate yet".into())) };
        match pj::text_of(&row, "state").as_str() {
            "signed" => {
                st.enrollments.shift_remove(&serial);
                st.consumed_seeds.insert(serial.clone(), f(pj::now()));
                st.dirty = true;
                drop(st);
                log_info(&format!("enrollment delivered principal={} device={} seed={serial}", who.principal, str_value(row.get("device"))));
                let get = |k: &str| row.get(k).cloned().ok_or_else(|| E::Gone(format!("'{k}'")));
                Ok(obj([("state", Value::from("signed")), ("cert_pem", get("cert_pem")?), ("ca_pem", get("ca_pem")?), ("chain_pem", row.get("chain_pem").cloned().unwrap_or(Value::from("")))]))
            }
            "refused" => Ok(obj([("state", Value::from("refused")), ("reason", row.get("reason").cloned().unwrap_or(Value::from("")))])),
            _ => Ok(obj([("state", Value::from("waiting"))])),
        }
    }

    pub fn admin_enrollments(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.check_admin(session, who)?;
        let rows = Self::rows_by_ts(&st.enrollments, |r| pj::text_of(r, "state") == "waiting" && !pj::truthy(r.get("needs_admin")));
        let fields = ["seed_serial", "principal", "name", "token", "csr_pem", "device", "device_label", "ts"];
        let out = rows.iter().map(|r| Value::Object(fields.iter().map(|k| (k.to_string(), r.get(*k).cloned().unwrap_or(Value::Null))).collect())).collect();
        Ok(obj([("requests", Value::Array(out))]))
    }

    pub fn admin_enrolled(&self, session: &str, who: &Identity, seed_serial: &str, cert_pem: Body, ca_pem: Body, refused: Body) -> R<Obj> {
        let serial = m::serial(seed_serial);
        self.check_admin(session, who)?;
        let reason = m::reason(refused);
        let (csr_pem, principal, device) = {
            let st = self.st.lock();
            let Some(row) = as_obj(st.enrollments.get(&serial)) else { return Err(E::NotFound("no enrollment is waiting for that invite".into())) };
            if pj::text_of(row, "state") == "signed" {
                return Err(E::Conflict("that enrollment was already signed".into()));
            }
            (row.get("csr_pem").cloned().unwrap_or(Value::Null), pj::text_of(row, "principal"), row.get("device").cloned().unwrap_or(Value::Null))
        };
        if reason.is_empty() {
            let (cert, _) = load_issued(cert_pem, ca_pem)?;
            if !cert_emails(&cert).contains(&principal) {
                return bad("the certificate is for a different email");
            }
            if m::uri_value(&cert.names.uris, m::DEVICE_URI_PREFIX) != device {
                return bad("the certificate is not for the device that asked");
            }
            if cert.spki != load_csr(Some(&csr_pem))?.spki {
                return bad("the certificate is not for the key that device made");
            }
        }
        let mut st = self.st.lock();
        let row = st.enrollments.get_mut(&serial).and_then(Value::as_object_mut);
        let Some(row) = row.filter(|r| pj::text_of(r, "state") != "signed") else { return Err(E::Conflict("that enrollment was already answered".into())) };
        if row.get("csr_pem") != Some(&csr_pem) {
            return bad("the device sent a new request meanwhile; read it again");
        }
        if !reason.is_empty() {
            update(row, obj([("state", Value::from("refused")), ("reason", Value::from(reason.clone()))]));
        } else {
            update(row, obj([("state", Value::from("signed")), ("cert_pem", Value::from(str_value(cert_pem))), ("ca_pem", Value::from(str_value(ca_pem)))]));
            row.shift_remove("reason");
        }
        let principal = pj::py_str(row.get("principal").unwrap_or(&Value::Null));
        st.dirty = true;
        drop(st);
        log_info(&format!("enrollment {} principal={principal} seed={serial} by={}", if reason.is_empty() { "signed" } else { "refused" }, who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    // ── add a device ─────────────────────────────────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn devices_add(&self, session: &str, who: &Identity, csr_pem: Body, label: Body, chain: Body, proof: Body, ts: Body) -> R<Obj> {
        let label = m::label(label)?;
        self.check_session(session, who)?;
        let csr = load_csr(csr_pem)?;
        check_csr_person(&csr, who)?;
        let pem = str_value(csr_pem);
        let answer = self.ask_signer("issue_seed", who, chain, proof, ts, obj([("csr_pem", Value::from(pem.clone())), ("origin", Value::from("device")), ("label", Value::from(label.clone()))]))?;
        let now = pj::now();
        let rid = pj::token_hex(8);
        let mut st = self.st.lock();
        st.session(session, who)?;
        if let Some(a) = answer.as_ref().filter(|a| pj::text_of(a, "state") == "seeded") {
            let iss = issued(a);
            st.seeded.insert(
                rid.clone(),
                Value::Object(with(&iss, obj([("request", Value::from(rid.clone())), ("principal", Value::from(who.principal.clone())), ("from_device", Value::from(who.device.clone())), ("ts", f(now)), ("state", Value::from("seeded"))]))),
            );
            st.dirty = true;
            st.tell_device(&who.principal, &who.device, &with(&iss, obj([("type", Value::from("seeded")), ("request", Value::from(rid.clone()))])));
            drop(st);
            self.wake();
            log_info(&format!("new device seeded principal={} from={} request={rid} by=signer", who.principal, who.device));
            return Ok(with(&iss, obj([("request", Value::from(rid)), ("state", Value::from("seeded"))])));
        }
        let mut row = obj([
            ("id", Value::from(rid.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("name", Value::from(who.name.clone())),
            ("csr_pem", Value::from(pem)),
            ("label", Value::from(label.clone())),
            ("from_device", Value::from(who.device.clone())),
            ("ts", f(now)),
        ]);
        update(&mut row, proof_fields(who, chain, proof, ts));
        if let Some(a) = &answer {
            update(&mut row, obj([("needs_admin", Value::Bool(true)), ("reason", Value::from(m::reason(a.get("reason"))))]));
        }
        st.seed_requests.insert(rid.clone(), Value::Object(row));
        st.dirty = true;
        st.tell_admins(&obj([("type", Value::from("seed_request")), ("principal", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone())), ("label", Value::from(label)), ("ts", f(now))]));
        drop(st);
        self.wake();
        log_info(&format!("new device requested principal={} from={} request={rid}", who.principal, who.device));
        Ok(obj([("request", Value::from(rid)), ("state", Value::from("waiting"))]))
    }

    pub fn devices_add_status(&self, session: &str, who: &Identity, request: &str) -> R<Obj> {
        let st = self.st.lock();
        st.session(session, who)?;
        if as_obj(st.seed_requests.get(request)).map(|r| pj::text_of(r, "principal") == who.principal).unwrap_or(false) {
            return Ok(obj([("request", Value::from(request)), ("state", Value::from("waiting"))]));
        }
        let Some(a) = as_obj(st.seeded.get(request)).filter(|a| pj::text_of(a, "principal") == who.principal) else { return Err(E::NotFound("no such request".into())) };
        if pj::text_of(a, "state") == "refused" {
            return Ok(obj([("request", Value::from(request)), ("state", Value::from("refused")), ("reason", a.get("reason").cloned().unwrap_or(Value::from("")))]));
        }
        let get = |k: &str| a.get(k).cloned().ok_or_else(|| E::Gone(format!("'{k}'")));
        Ok(obj([("request", Value::from(request)), ("state", Value::from("seeded")), ("cert_pem", get("cert_pem")?), ("ca_pem", get("ca_pem")?), ("chain_pem", a.get("chain_pem").cloned().unwrap_or(Value::from("")))]))
    }

    pub fn admin_seed_requests(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.check_admin(session, who)?;
        let rows = Self::rows_by_ts(&st.seed_requests, |r| !pj::truthy(r.get("needs_admin")));
        Ok(obj([("requests", Value::Array(rows.into_iter().map(Value::Object).collect()))]))
    }

    pub fn admin_seeded(&self, session: &str, who: &Identity, request: &str, cert_pem: Body, ca_pem: Body, refused: Body) -> R<Obj> {
        self.check_admin(session, who)?;
        let reason = m::reason(refused);
        let gone = || E::NotFound("that request is no longer waiting".into());
        let row = as_obj(self.st.lock().seed_requests.get(request)).cloned().ok_or_else(gone)?;
        let principal = pj::text_of(&row, "principal");
        if reason.is_empty() {
            let (cert, _) = load_issued(cert_pem, ca_pem)?;
            if !cert_emails(&cert).contains(&principal) {
                return bad("the certificate is for a different email");
            }
            if m::uri_value(&cert.names.uris, m::SEED_URI_PREFIX).is_empty() {
                return bad("that is not a seed certificate");
            }
            if cert.spki != load_csr(row.get("csr_pem"))?.spki {
                return bad("the certificate is not for the key that was sent");
            }
        }
        let from_device = row.get("from_device").cloned().unwrap_or(Value::from(""));
        let mut answer = obj([("request", Value::from(request)), ("principal", Value::from(principal.clone())), ("from_device", from_device.clone()), ("ts", f(pj::now()))]);
        let event = if !reason.is_empty() {
            update(&mut answer, obj([("state", Value::from("refused")), ("reason", Value::from(reason.clone()))]));
            obj([("type", Value::from("seed_refused")), ("request", Value::from(request)), ("reason", Value::from(reason.clone()))])
        } else {
            update(&mut answer, obj([("state", Value::from("seeded")), ("cert_pem", Value::from(str_value(cert_pem))), ("ca_pem", Value::from(str_value(ca_pem)))]));
            obj([("type", Value::from("seeded")), ("request", Value::from(request)), ("cert_pem", Value::from(str_value(cert_pem))), ("ca_pem", Value::from(str_value(ca_pem)))])
        };
        let mut st = self.st.lock();
        if st.seed_requests.shift_remove(request).is_none() {
            return Err(gone());
        }
        st.seeded.insert(request.to_string(), Value::Object(answer));
        st.dirty = true;
        st.tell_device(&principal, &pj::py_str(&from_device), &event);
        drop(st);
        self.wake();
        log_info(&format!("new device {} principal={principal} request={request} by={}", if reason.is_empty() { "seeded" } else { "refused" }, who.principal));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    pub fn admin_devices(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.check_admin(session, who)?;
        let mut live: IndexMap<(String, String), (String, String)> = IndexMap::new();
        for s in st.sessions.values() {
            if !s.who.device.is_empty() {
                live.entry((s.who.principal.clone(), s.who.device.clone())).or_insert((s.who.device_label.clone(), String::new()));
            }
        }
        for p in st.peers.values() {
            if !p.who.device.is_empty() {
                live.insert((p.who.principal.clone(), p.who.device.clone()), (p.who.device_label.clone(), p.room.clone()));
            }
        }
        let mut rows: IndexMap<(String, String), Obj> = IndexMap::new();
        for (principal, entry) in &st.directory {
            let Some(devices) = as_obj(Some(entry)).and_then(|e| as_obj(e.get("devices"))) else { continue };
            for (device, info) in devices {
                let Some(info) = info.as_object() else { continue };
                rows.insert(
                    (principal.clone(), device.clone()),
                    obj([
                        ("principal", Value::from(principal.clone())),
                        ("device", Value::from(device.clone())),
                        ("label", Value::from(pj::s(info, "label"))),
                        ("online", Value::Bool(false)),
                        ("room", Value::from("")),
                        ("last_seen", info.get("last_seen").cloned().unwrap_or(Value::from(0))),
                    ]),
                );
            }
        }
        let now = pj::now();
        for ((principal, device), (label, room)) in live {
            let row = rows.entry((principal.clone(), device.clone())).or_insert_with(|| obj([("principal", Value::from(principal)), ("device", Value::from(device)), ("label", Value::from(label.clone()))]));
            let label = if label.is_empty() { pj::s(row, "label") } else { label };
            update(row, obj([("online", Value::Bool(true)), ("room", Value::from(room)), ("last_seen", f(now)), ("label", Value::from(label))]));
        }
        rows.sort_keys();
        Ok(obj([("devices", Value::Array(rows.into_values().map(Value::Object).collect()))]))
    }

    // ── admin approvals ──────────────────────────────────────────────────────────────────────────────────────

    pub fn admin_pending(&self, session: &str, who: &Identity) -> R<Obj> {
        let (enrolls, seeds, renews) = {
            let st = self.st.lock();
            st.check_admin(session, who)?;
            let pick = |rows: &Obj, keep: &dyn Fn(&Obj) -> bool| -> Vec<Obj> { rows.values().filter_map(Value::as_object).filter(|r| keep(r)).cloned().collect() };
            (pick(&st.enrollments, &|r| pj::text_of(r, "state") == "waiting"), pick(&st.seed_requests, &|_| true), pick(&st.renewals, &|r| pj::truthy(r.get("needs_admin"))))
        };
        let get = |r: &Obj, k: &str| r.get(k).cloned().unwrap_or(Value::from(""));
        let mut items: Vec<Obj> = Vec::new();
        for r in &enrolls {
            let pem = pj::s(r, "csr_pem");
            items.push(obj([
                ("kind", Value::from("enroll")),
                ("id", Value::from(pj::s(r, "seed_serial"))),
                ("principal", get(r, "principal")),
                ("name", get(r, "name")),
                ("device", get(r, "device")),
                ("device_label", get(r, "device_label")),
                ("label", get(r, "device_label")),
                ("origin", get(r, "origin")),
                ("check_code", Value::from(check_code(&pem))),
                ("csr_pem", Value::from(pem.clone())),
                ("csr_sha256", Value::from(csr_hash(&pem))),
                ("chain", Value::Bool(pj::truthy(r.get("chain")))),
                ("reason", get(r, "reason")),
                ("ts", r.get("ts").cloned().unwrap_or(Value::from(0))),
            ]));
        }
        for r in &seeds {
            let pem = pj::s(r, "csr_pem");
            items.push(obj([
                ("kind", Value::from("seed")),
                ("id", Value::from(pj::s(r, "id"))),
                ("principal", get(r, "principal")),
                ("name", get(r, "name")),
                ("device", get(r, "from_device")),
                ("device_label", Value::from("")),
                ("label", get(r, "label")),
                ("origin", Value::from("device")),
                ("check_code", Value::from("")),
                ("csr_pem", Value::from(pem.clone())),
                ("csr_sha256", Value::from(csr_hash(&pem))),
                ("chain", Value::Bool(pj::truthy(r.get("chain")))),
                ("reason", get(r, "reason")),
                ("ts", r.get("ts").cloned().unwrap_or(Value::from(0))),
            ]));
        }
        for r in &renews {
            let pem = pj::s(r, "csr_pem");
            items.push(obj([
                ("kind", Value::from("renew")),
                ("id", Value::from(pj::s(r, "id"))),
                ("principal", get(r, "principal")),
                ("name", get(r, "name")),
                ("device", get(r, "device")),
                ("device_label", get(r, "device_label")),
                ("label", get(r, "device_label")),
                ("origin", Value::from("")),
                ("check_code", Value::from("")),
                ("csr_pem", Value::from(pem.clone())),
                ("csr_sha256", Value::from(csr_hash(&pem))),
                ("chain", Value::Bool(pj::truthy(r.get("chain")))),
                ("reason", get(r, "reason")),
                ("ts", r.get("ts").cloned().unwrap_or(Value::from(0))),
            ]));
        }
        items.sort_by(|a, b| {
            let t = |o: &Obj| if pj::truthy(o.get("ts")) { pj::num(o, "ts") } else { 0.0 };
            t(a).partial_cmp(&t(b)).unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(obj([("items", Value::Array(items.into_iter().map(Value::Object).collect()))]))
    }

    fn pending_row(st: &State, kind: &str, id: &str) -> R<Obj> {
        let row = match kind {
            "enroll" => as_obj(st.enrollments.get(&m::serial(id))).filter(|r| pj::text_of(r, "state") == "waiting").cloned(),
            "seed" => as_obj(st.seed_requests.get(id)).cloned(),
            "renew" => st.renewals.values().filter_map(Value::as_object).find(|r| pj::text_of(r, "id") == id).cloned(),
            _ => return bad("kind must be enroll, seed or renew"),
        };
        row.ok_or_else(|| E::NotFound("that request is no longer waiting".into()))
    }

    fn pending_changed(&self, kind: &str, id: &str, state: &str) {
        let mut st = self.st.lock();
        st.tell_admins(&obj([("type", Value::from("pending_changed")), ("kind", Value::from(kind)), ("id", Value::from(id)), ("state", Value::from(state)), ("ts", f(pj::now()))]));
        drop(st);
        self.wake();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn admin_approve(&self, session: &str, who: &Identity, kind: &str, id: &str, csr_sha256: &str, decision: &str, reason: Body, proof: Body, ts: Body) -> R<Obj> {
        self.check_admin(session, who)?;
        if decision != "approve" && decision != "refuse" {
            return bad("decision must be approve or refuse");
        }
        let row = Self::pending_row(&self.st.lock(), kind, id)?;
        let pem = pj::s(&row, "csr_pem");
        if csr_hash(&pem) != csr_sha256.to_lowercase() {
            return bad("that request changed since you read it; read it again");
        }
        let principal = pj::text_of(&row, "principal");
        let device = pj::s(&row, "device");
        if decision == "refuse" {
            let text = Some(m::reason(reason)).filter(|t| !t.is_empty()).unwrap_or_else(|| "refused by an admin".into());
            match kind {
                "enroll" => {
                    self.admin_enrolled(session, who, id, None, None, Some(&Value::from(text.clone())))?;
                }
                "seed" => {
                    self.admin_seeded(session, who, id, None, None, Some(&Value::from(text.clone())))?;
                }
                _ => {
                    let mut st = self.st.lock();
                    let key = m::key(&principal, &device);
                    if as_obj(st.renewals.get(&key)).map(|r| pj::text_of(r, "id") == id).unwrap_or(false) {
                        st.renewals.shift_remove(&key);
                        st.dirty = true;
                    }
                    st.tell_device(&principal, &device, &obj([("type", Value::from("renew_refused")), ("reason", Value::from(text.clone()))]));
                    drop(st);
                    self.wake();
                    log_info(&format!("renewal refused principal={principal} device={} by={}", str_value(row.get("device")), who.principal));
                }
            }
            self.pending_changed(kind, id, "refused");
            return Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("refused"))]));
        }
        if !pj::truthy(row.get("chain")) {
            return Err(E::Conflict(OLD_APP.into()));
        }
        if who.cert_pem.is_empty() {
            return forbidden("approve from one of your devices");
        }
        if !self.signer_ready() {
            return Err(E::Unavailable(SIGNER_DOWN.into()));
        }
        let op = match kind {
            "enroll" => "sign_enrollment",
            "seed" => "issue_seed",
            _ => "sign_renewal",
        };
        let mut body = obj([
            ("csr_pem", row.get("csr_pem").cloned().unwrap_or(Value::Null)),
            ("cert_pem", row.get("requester_pem").cloned().unwrap_or(Value::from(""))),
            ("proof", row.get("proof").cloned().unwrap_or(Value::from(""))),
            ("ts", row.get("proof_ts").cloned().unwrap_or(Value::Null)),
            (
                "approval",
                Value::Object(obj([("cert_pem", Value::from(who.cert_pem.clone())), ("proof", Value::from(pj::str_or(proof))), ("ts", proof_ts(ts)), ("kind", Value::from(kind)), ("id", Value::from(id))])),
            ),
        ]);
        if kind == "seed" {
            update(&mut body, obj([("origin", Value::from("device")), ("label", row.get("label").cloned().unwrap_or(Value::from("")))]));
        }
        let answer = self.signer_call(op, &body)?;
        let state = pj::text_of(&answer, "state");
        if state != "signed" && state != "seeded" {
            let why = pj::s(&answer, "reason");
            return bad(format!("the certificate server did not sign it: {}", if why.is_empty() { "no reason given".into() } else { why }));
        }
        let iss = issued(&answer);
        let now = pj::now();
        let mut st = self.st.lock();
        match kind {
            "enroll" => {
                let current = st.enrollments.get_mut(&m::serial(id)).and_then(Value::as_object_mut);
                let Some(current) = current.filter(|c| c.get("csr_pem") == row.get("csr_pem")) else { return Err(E::Conflict("the device sent a new request meanwhile; read it again".into())) };
                update(current, iss.clone());
                current.insert("state".into(), Value::from("signed"));
                current.shift_remove("reason");
            }
            "seed" => {
                if st.seed_requests.shift_remove(id).is_none() {
                    return Err(E::NotFound("that request is no longer waiting".into()));
                }
                let from = row.get("from_device").cloned().unwrap_or(Value::from(""));
                st.seeded.insert(id.to_string(), Value::Object(with(&iss, obj([("request", Value::from(id)), ("principal", Value::from(principal.clone())), ("from_device", from.clone()), ("ts", f(now)), ("state", Value::from("seeded"))]))));
                st.tell_device(&principal, &pj::py_str(&from), &with(&iss, obj([("type", Value::from("seeded")), ("request", Value::from(id))])));
            }
            _ => {
                let key = m::key(&principal, &device);
                st.renewals.shift_remove(&key);
                let renewed = with(&iss, obj([("device", Value::from(device.clone())), ("ts", f(now))]));
                st.renewed.insert(key, Value::Object(renewed.clone()));
                st.tell_device(&principal, &device, &with(&renewed, obj([("type", Value::from("renewed"))])));
            }
        }
        st.dirty = true;
        drop(st);
        self.wake();
        self.pending_changed(kind, id, &state);
        log_info(&format!("{kind} approved principal={principal} id={id} by={}", who.principal));
        Ok(obj([("ok", Value::Bool(true)), ("state", Value::from(state))]))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn admin_invite(&self, session: &str, who: &Identity, name: Body, email: Body, days: Body, seed_csr_pem: Body, proof: Body, ts: Body) -> R<Obj> {
        self.check_admin(session, who)?;
        let name = pj::squash(&pj::str_or(name));
        let email = m::principal(email);
        if name.is_empty() || !email.contains('@') {
            return bad("an invite needs a name and an email address");
        }
        let csr = load_csr(seed_csr_pem)?;
        let (cname, cemail) = csr_identity(&csr);
        if cname.trim() != name || cemail != email {
            return bad("the seed request must carry the invited name and email");
        }
        if who.cert_pem.is_empty() {
            return forbidden("invite from one of your devices");
        }
        if !self.signer_ready() {
            return Err(E::Unavailable(SIGNER_DOWN.into()));
        }
        let answer = self.signer_call(
            "issue_seed",
            &obj([
                ("csr_pem", Value::from(str_value(seed_csr_pem))),
                ("cert_pem", Value::from(who.cert_pem.clone())),
                ("proof", Value::from(pj::str_or(proof))),
                ("ts", proof_ts(ts)),
                ("origin", Value::from("issuer")),
                ("name", Value::from(name)),
                ("email", Value::from(email.clone())),
                ("days", days.cloned().unwrap_or(Value::Null)),
            ]),
        )?;
        log_info(&format!("invite issued for={email} by={} serial={}", who.principal, answer.get("serial").map(pj::py_str).unwrap_or_default()));
        let expires = Some(pj::s(&answer, "expires")).filter(|e| !e.is_empty()).unwrap_or_else(|| pj::s(&answer, "not_after"));
        Ok(with(&issued(&answer), obj([("serial", Value::from(pj::s(&answer, "serial"))), ("expires", Value::from(expires))])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    fn hub() -> Hub {
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    #[test]
    fn a_chat_line_gets_the_room_rseq_and_reaches_the_room() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = h.join("ops", &ann, "", false, None).unwrap();
        let b = h.join("ops", &ben, "", false, None).unwrap();
        assert_eq!(b["members"].as_array().unwrap().len(), 1);
        assert_eq!(refusal(h.say(a["peer"].as_str().unwrap(), &ann, "hi", None, None, None)), format!("409 {}", ce::PLAIN));
        // plain call chat only while a web guest is in the call
        h.st.lock().peers.get_mut(b["peer"].as_str().unwrap()).unwrap().who.guest = true;
        let line = h.say(a["peer"].as_str().unwrap(), &ann, "hi", None, None, None).unwrap();
        assert_eq!(line["rseq"], json!(1));
        let got = h.events(b["peer"].as_str().unwrap(), &ben, 0).unwrap();
        assert_eq!(got["events"][0]["type"], json!("chat"));
    }

    #[test]
    fn a_caption_retry_is_answered_not_repeated() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let a = h.join("ops", &ann, "", false, None).unwrap();
        let p = a["peer"].as_str().unwrap();
        let one = h.caption(p, &ann, "hello", Some(&json!(1)), Some(&json!(9000)), None).unwrap();
        let two = h.caption(p, &ann, "hello", Some(&json!(1)), None, None).unwrap();
        assert_eq!(one["id"], two["id"]);
        assert_eq!(one["late"], json!(true));
    }

    #[test]
    fn state_json_round_trips_in_python_text() {
        let text = "{\"v\": 2, \"directory\": {\"ann@x\": {\"name\": \"Ann\", \"last_seen\": 1.5}}, \"dms\": {}, \"read\": {}, \"invites\": {}, \"rooms\": {}, \"left\": {}, \"renewals\": {}, \"renewed\": {}, \"enrollments\": {}, \"consumed_seeds\": {}, \"seed_requests\": {}, \"seeded\": {}, \"denied\": {}, \"organizations\": {\"ben@x\": null, \"cy@x\": {\"id\": \"o\", \"label\": \"O\"}}, \"status\": {\"ann@x\": {\"state\": \"busy\", \"text\": \"\", \"until\": 4102444800000}, \"ben@x\": {\"state\": \"away\", \"text\": \"\"}}, \"receipts\": {\"ann@x\": {\"ben@x\": 2.5}}, \"meetings\": {\"m-abcdefgh23\": {\"id\": \"m-abcdefgh23\", \"room\": \"m-abcdefgh23\", \"title\": \"Weekly\", \"description\": \"\", \"start\": 1700000000.0, \"end\": 1700001800.0, \"recurrence\": \"weekly\", \"tz\": \"Europe/Paris\", \"organizer\": {\"principal\": \"ann@x\", \"name\": \"Ann\"}, \"attendees\": [{\"principal\": \"ben@x\", \"name\": \"Ben\", \"response\": \"none\"}], \"created\": 1.5, \"updated\": 1.5, \"canceled\": null}}, \"channels\": {\"c-01\": {\"id\": \"c-01\", \"kind\": \"public\", \"name\": \"general\", \"topic\": \"\", \"created_by\": \"ann@x\", \"members\": [\"ann@x\"], \"created\": 1.5, \"archived\": null, \"last\": 1.5, \"e2ee\": true, \"bridgeable\": false, \"e2ee_since\": 1500}}, \"channel_messages\": {\"c-01\": [{\"id\": \"m1\", \"channel\": \"c-01\", \"from\": \"ann@x\", \"from_name\": \"Ann\", \"from_org\": null, \"text\": \"hi\", \"ts\": 1.5, \"reactions\": {}}]}, \"channel_read\": {\"ann@x\": {\"c-01\": 1.5}}, \"prefs\": {\"ann@x\": {\"rev\": 2, \"notify\": {\"dm:ben@x\": \"off\"}, \"sections\": [{\"id\": \"s-0123abcd\", \"name\": \"Team\", \"convs\": [\"dm:ben@x\"]}], \"channel_default\": \"mentions\"}}, \"emoji\": {\"party\": {\"name\": \"party\", \"hash\": \"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\", \"type\": \"png\", \"org\": null, \"by\": \"ann@x\", \"ts\": 1500}}, \"attendance\": {\"ops\": [{\"id\": \"0123456789abcdef\", \"start\": 4102444000000, \"end\": 4102444800000, \"people\": [{\"principal\": \"ann@x\", \"name\": \"Ann\", \"org\": null, \"joins\": [[4102444000000, 4102444800000]], \"role\": \"host\"}]}]}, \"push_tokens\": {\"ann@x\": {\"aaaaaaaaaaaaaaaa\": {\"token\": \"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\", \"env\": \"sandbox\", \"ts\": 1700000000000, \"serial\": \"1a\", \"seal\": \"BI2v5YHwWUGbhOdhiQ3+w8TpAkRe9LcJA7pzR9JxIttNKHIyizRAXX5o3tD/EcIKYpNmh5Ct9aJ6I8UdyL9fGrc=\", \"sk\": \"d197f269\", \"seal_prev\": \"\", \"sk_prev\": \"\", \"voip\": \"\", \"callkit\": true}}}, \"ext\": {\"files\": {\"v\": 1, \"files\": {}}, \"guests\": {\"revoked\": {}, \"blocked\": {}}, \"bridge\": {\"v\": 1, \"policies\": {}, \"links\": {}, \"codes\": {}, \"connectors\": {}, \"seq\": 0, \"outbox\": {}, \"map\": {}, \"offered\": {}}, \"ce\": {\"v\": 1, \"since\": 1500, \"seq\": 0, \"bundles\": {}, \"wraps\": {}, \"logs\": {}}, \"pc\": {\"v\": 1, \"policies\": [], \"holds\": [], \"kept\": {}, \"sso\": {}, \"adds\": [], \"docs\": {}, \"proposals\": {}, \"suspended\": {}, \"stale\": {}, \"lowerings\": {}, \"signer_policy\": null, \"maps\": []}}}";
        let dir = std::env::temp_dir().join(format!("meet-state-{}", pj::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), text).unwrap();
        let h = Hub::new(Some(dir.clone()), &[], 1e9, 1e9, 1e9, None, Arc::new(LinkStats::new()));
        assert_eq!(h.st.lock().snapshot(), text);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── recording consent ───────────────────────────────────────────────────────────────────────────────────

    fn refusal<T>(r: R<T>) -> String {
        match r {
            Err(E::Forbidden(m)) => format!("403 {m}"),
            Err(E::Bad(m)) => format!("400 {m}"),
            Err(E::Conflict(m)) => format!("409 {m}"),
            Err(E::Gone(m)) => format!("410 {m}"),
            Err(e) => format!("other {}", e.message()),
            Ok(_) => "ok".into(),
        }
    }

    fn queue(h: &Hub, peer: &str) -> Vec<Obj> {
        h.st.lock().peers[peer].events.iter().cloned().collect()
    }

    fn types(h: &Hub, peer: &str) -> Vec<String> {
        queue(h, peer).iter().map(|e| pj::text_of(e, "type")).collect()
    }

    fn keys(o: &Obj) -> Vec<&str> {
        o.keys().map(String::as_str).collect()
    }

    fn on(h: &Hub, peer: &str, who: &Identity, acknowledged: bool) -> R<Obj> {
        h.recording(peer, who, Some(&json!(true)), Some(&json!(acknowledged)), None)
    }

    fn peer_of(joined: &Obj) -> String {
        joined["peer"].as_str().unwrap().to_string()
    }

    /// ann records "ops" with ben's consent: (hub, ann, ben, ann's peer, ben's peer).
    fn recording_room() -> (Hub, Identity, Identity, String, String) {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        let request = on(&h, &a, &ann, true).unwrap()["request"].as_str().unwrap().to_string();
        h.recording_consent(&b, &ben, &request, Some(&json!(true))).unwrap();
        assert_eq!(on(&h, &a, &ann, false).unwrap()["on"], json!(true));
        (h, ann, ben, a, b)
    }

    #[test]
    fn recording_waits_for_the_policy_acknowledgement_and_every_participant() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        assert_eq!(refusal(h.recording(&a, &ann, Some(&json!("yes")), None, None)), "400 on, acknowledged and paused must be true or false");
        assert_eq!(refusal(h.recording(&a, &ann, Some(&json!(true)), Some(&Value::Null), None)), "400 on, acknowledged and paused must be true or false");
        assert_eq!(refusal(on(&h, &a, &ann, false)), "403 acknowledge the recording policy before requesting consent");
        assert_eq!(refusal(h.recording(&a, &ann, Some(&json!(true)), Some(&json!(true)), Some(&json!(true)))), "400 start recording before pausing");

        let pending = on(&h, &a, &ann, true).unwrap();
        assert_eq!(keys(&pending), ["request", "peer", "name", "principal", "owner", "notice", "policy_acknowledged", "ok", "pending", "waiting", "denied", "on"]);
        assert_eq!(pending["request"].as_str().unwrap().len(), 24);
        assert_eq!(pending["owner"], json!({"kind": "individual", "id": "ann@x", "label": "ANN@X"}));
        assert_eq!(pending["notice"], json!(RECORDING_NOTICE));
        assert_eq!((&pending["ok"], &pending["pending"], &pending["on"]), (&json!(false), &json!(true), &json!(false)));
        assert_eq!(pending["waiting"], json!([{"peer": b, "name": "BEN@X", "principal": "ben@x"}]));
        assert_eq!(pending["denied"], json!([]));
        let request = pending["request"].as_str().unwrap().to_string();
        let asked = queue(&h, &b).pop().unwrap();
        assert_eq!(keys(&asked), ["request", "peer", "name", "principal", "owner", "notice", "policy_acknowledged", "type", "seq"]);
        assert_eq!(asked["type"], json!("recording_request"));

        assert_eq!(refusal(h.recording_consent(&a, &ann, &request, Some(&json!(true)))), "400 recorder policy acknowledgement is not participant consent");
        assert_eq!(refusal(h.recording_consent(&b, &ben, "nope", Some(&json!(true)))), "410 that recording request has ended");
        assert_eq!(refusal(h.recording_consent(&b, &ben, &request, Some(&json!("yes")))), "400 accepted must be true or false");

        let refused = h.recording_consent(&b, &ben, &request, Some(&json!(false))).unwrap();
        assert_eq!(Value::Object(refused), json!({"ok": true, "accepted": false, "admission_pending": false, "members": [{"peer": a, "name": "ANN@X", "principal": "ann@x", "org": null, "weak": false}]}));
        let mut told = queue(&h, &a).pop().unwrap();
        told.shift_remove("seq");
        assert_eq!(told, obj([("type", json!("recording_consent")), ("request", json!(request)), ("peer", json!(b)), ("accepted", json!(false))]));
        let denied = on(&h, &a, &ann, false).unwrap();
        assert_eq!((&denied["waiting"], &denied["denied"]), (&json!([]), &json!([{"peer": b, "name": "BEN@X", "principal": "ben@x"}])));

        h.recording_consent(&b, &ben, &request, Some(&json!(true))).unwrap();
        let started = on(&h, &a, &ann, false).unwrap();
        assert_eq!(keys(&started), ["request", "peer", "name", "principal", "owner", "notice", "policy_acknowledged", "ok", "on", "paused", "participant_consent_complete"]);
        let notice = queue(&h, &b).pop().unwrap();
        assert_eq!(keys(&notice), ["request", "peer", "name", "principal", "owner", "notice", "policy_acknowledged", "type", "on", "paused", "seq"]);
        assert_eq!((&notice["type"], &notice["on"], &notice["paused"]), (&json!("recording"), &json!(true), &json!(false)));

        let paused = h.recording(&a, &ann, Some(&json!(true)), None, Some(&json!(true))).unwrap();
        assert_eq!(paused["paused"], json!(true));
        let policy = h.recording_policy(&b, &ben).unwrap();
        assert_eq!(keys(&policy), ["allowed", "owner", "notice", "participant_consent_required", "policy_acknowledgement_required", "recorders", "requests", "admission_pending"]);
        assert_eq!(policy["recorders"][0]["paused"], json!(true));
        assert_eq!(policy["requests"], json!([]));

        // a participant revokes: the recording stops and its request ends
        h.recording_consent(&b, &ben, &request, Some(&json!(false))).unwrap();
        let stopped = queue(&h, &b).pop().unwrap();
        assert_eq!((&stopped["type"], &stopped["on"], &stopped["paused"]), (&json!("recording"), &json!(false), &json!(false)));
        assert!(!h.st.lock().peers[&a].recording);
        assert_eq!(refusal(h.recording_consent(&b, &ben, &request, Some(&json!(true)))), "410 that recording request has ended");
        let off = h.recording(&a, &ann, Some(&json!(false)), None, None).unwrap();
        assert_eq!(Value::Object(off), json!({"ok": true, "on": false, "paused": false, "request": null}));
        // control state only: never room history, never state.json
        let st = h.st.lock();
        assert!(st.rooms["ops"].iter().all(|l| pj::text_of(l, "kind") == "join"));
        assert!(!st.snapshot().contains("recording"));
    }

    #[test]
    fn a_late_joiner_is_held_until_it_accepts_every_recorder() {
        let (h, ann, ben, a, b) = recording_room();
        let cy = who("cy@x", "cccccccccccccccc");
        let joined = h.join("ops", &cy, "", false, None).unwrap();
        let c = peer_of(&joined);
        assert_eq!(keys(&joined), ["peer", "you", "members", "chat", "missed", "recording", "recording_notices", "admission_pending", "rseq", "options", "stage", "chat_stay", "chat_e2ee", "stay"]);
        assert_eq!((&joined["members"], &joined["chat"], &joined["missed"], &joined["stage"]), (&json!([]), &json!([]), &json!({}), &Value::Null));
        assert_eq!((&joined["recording"], &joined["admission_pending"]), (&json!([a]), &json!(true)));
        assert_eq!(joined["recording_notices"][0]["on"], json!(true));
        assert!(queue(&h, &b).iter().all(|e| e.get("peer") != Some(&json!(c))), "the room does not hear a waiting joiner");

        assert_eq!(refusal(h.say(&c, &cy, "hi", None, None, None)), format!("403 {ADMISSION_FIRST}"));
        assert_eq!(refusal(h.caption(&c, &cy, "hi", None, None, None)), format!("403 {ADMISSION_FIRST}"));
        assert_eq!(refusal(h.captions(&c, &cy, Some(&json!([{"text": "hi"}])), None, None, None)), format!("403 {ADMISSION_FIRST}"));
        assert_eq!(refusal(h.room_captions(&c, &cy, "0", "10")), format!("403 {ADMISSION_FIRST}"));
        assert_eq!(refusal(h.room_history(&json!("ops"), &cy, &json!(0), 10)), format!("403 {ADMISSION_FIRST}"));
        assert_eq!(refusal(h.signal(&c, &cy, &a, json!({}))), "403 recording consent is required before joining media");
        assert_eq!(refusal(h.signal(&b, &ben, &c, json!({}))), "403 recording consent is required before joining media");
        assert_eq!(refusal(on(&h, &c, &cy, true)), "403 recording is not permitted");
        let policy = h.recording_policy(&c, &cy).unwrap();
        assert_eq!((&policy["allowed"], &policy["admission_pending"]), (&json!(false), &json!(true)));
        assert_eq!(refusal(h.say(&a, &ann, "not for cy", None, None, None)), format!("409 {}", ce::PLAIN));
        assert!(queue(&h, &c).is_empty());
        // the recorder's own answer does not wait for a joiner who is not yet in the call
        assert_eq!(on(&h, &a, &ann, false).unwrap()["ok"], json!(true));

        let request = joined["recording_notices"][0]["request"].as_str().unwrap().to_string();
        let refused = h.recording_consent(&c, &cy, &request, Some(&json!(false))).unwrap();
        assert_eq!(Value::Object(refused), json!({"ok": true, "accepted": false, "admission_pending": true, "members": []}));
        assert!(h.st.lock().peers[&a].recording, "a waiting joiner's refusal does not stop the recording");
        let accepted = h.recording_consent(&c, &cy, &request, Some(&json!(true))).unwrap();
        assert_eq!(accepted["admission_pending"], json!(false));
        assert_eq!(accepted["members"], json!([{"peer": a, "name": "ANN@X", "principal": "ann@x", "org": null, "weak": false}, {"peer": b, "name": "BEN@X", "principal": "ben@x", "org": null, "weak": false}]));
        assert_eq!(types(&h, &c), ["recording_consent", "recording_consent", "recording_admitted"]);
        assert_eq!(queue(&h, &c)[2]["members"], accepted["members"]);
        let joins: Vec<Obj> = queue(&h, &b).into_iter().filter(|e| e["type"] == json!("join")).collect();
        assert_eq!(joins.len(), 1);
        assert_eq!(keys(&joins[0]), ["type", "peer", "name", "principal", "org", "seq"]);
        assert_eq!(joins[0]["peer"], json!(c));
        // admitted: past the consent gate, at the call chat's encryption
        assert_eq!(refusal(h.say(&c, &cy, "hello", None, None, None)), format!("409 {}", ce::PLAIN));
    }

    #[test]
    fn the_recorder_leaving_admits_a_waiting_joiner() {
        let (h, ann, _ben, a, b) = recording_room();
        let cy = who("cy@x", "cccccccccccccccc");
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        h.leave(&a, &ann).unwrap();
        // meet_relay._drop admits cy before _stage_drop hands the leaving host's role to ben (why "leave")
        assert_eq!(types(&h, &c), ["recording", "recording_admitted", "leave", "stage"]);
        assert_eq!(queue(&h, &c)[3]["stage"]["host"], json!(b));
        let events = queue(&h, &c);
        let peers: Vec<&Value> = events[1]["members"].as_array().unwrap().iter().map(|m| &m["peer"]).collect();
        assert_eq!(peers, [&json!(a), &json!(b)]);
        assert!(!h.st.lock().peers[&c].admission_pending);
    }

    #[test]
    fn recording_controls_belong_to_the_joined_certificate() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let laptop = who("ann@x", "dddddddddddddddd");
        let reissued = Identity { serial: "0f".into(), ..ann.clone() };
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        assert_eq!(refusal(h.recording_policy(&a, &laptop)), "403 recording controls belong to the joined certificate");
        assert_eq!(refusal(on(&h, &a, &reissued, true)), "403 recording controls belong to the joined certificate");
        assert_eq!(refusal(h.recording_consent(&a, &laptop, "x", Some(&json!(true)))), "403 recording controls belong to the joined certificate");
        assert_eq!(refusal(h.recording_policy(&a, &ben)), "403 that session belongs to someone else");
        assert_eq!(refusal(h.recording_policy("gone", &ann)), "410 not in a room (the relay dropped this session); join again");
    }

    #[test]
    fn relay_settings_name_the_owner_and_may_disable_recording() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        h.st.lock().organizations = json!({"ann@x": {"id": "org-1", "label": "Org One"}}).as_object().unwrap().clone();
        assert_eq!(h.recording_policy(&a, &ann).unwrap()["owner"], json!({"kind": "organization", "id": "org-1", "label": "Org One"}));
        assert_eq!(h.recording_policy(&b, &ben).unwrap()["owner"], json!({"kind": "individual", "id": "ben@x", "label": "BEN@X"}));
        h.st.lock().recording_enabled = false;
        assert_eq!(h.recording_policy(&a, &ann).unwrap()["allowed"], json!(false));
        assert_eq!(refusal(on(&h, &a, &ann, true)), "403 recording is not permitted");
        assert_eq!(Value::Object(h.recording(&a, &ann, Some(&json!(false)), None, None).unwrap()), json!({"ok": true, "on": false, "paused": false, "request": null}));
    }

    // ── stage and chat changes ──────────────────────────────────────────────────────────────────────────────

    fn act(h: &Hub, peer: &str, who: &Identity, action: &str, target: Option<&str>) -> R<Obj> {
        let action = json!(action);
        let target = target.map(|t| json!(t));
        h.stage(peer, who, Some(&action), target.as_ref(), None, None)
    }

    #[test]
    fn the_stage_follows_present_grant_and_leave() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let cy = who("cy@x", "cccccccccccccccc");
        let joined = h.join("ops", &ben, "", false, None).unwrap();
        let b = peer_of(&joined);
        assert_eq!(joined["stage"]["host"], json!(b));
        let c = peer_of(&h.join("ops", &cy, "", false, None).unwrap());
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let stage = act(&h, &b, &ben, "present", None).unwrap();
        assert_eq!(keys(stage["stage"].as_object().unwrap()), ["host", "presenter", "grant", "requests", "hands", "spotlight", "cohosts"]);
        assert_eq!(refusal(act(&h, &c, &cy, "present", None)), "409 BEN@X is presenting. Ask to present.");
        act(&h, &c, &cy, "request", None).unwrap();
        let granted = act(&h, &b, &ben, "grant", Some(&c)).unwrap();
        assert_eq!(granted["stage"]["grant"]["peer"], json!(c));
        // the host takes over even while a grant is live (meet_relay.py: `not host and ...`)
        let taken = act(&h, &b, &ben, "present", None).unwrap();
        assert_eq!(taken["stage"]["presenter"]["peer"], json!(b));
        assert_eq!(taken["stage"]["grant"], Value::Null);
        assert_eq!(refusal(act(&h, &c, &cy, "mute", Some(&b))), format!("403 {NOT_HOST}"));
        assert_eq!(refusal(act(&h, &a, &ann, "grant", None)), "400 say whom to grant (target)");
        // ann is a relay admin: host in every room
        act(&h, &a, &ann, "remove", Some(&c)).unwrap();
        // cy held no stage slot after the takeover, so removing cy is a plain leave
        assert_eq!(types(&h, &b).last().map(String::as_str), Some("leave"));
        h.leave(&b, &ben).unwrap();
        assert_eq!(queue(&h, &a).last().unwrap()["stage"]["host"], json!(a));
    }

    #[test]
    fn a_deleted_line_keeps_no_words() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        // plain call chat only while a web guest is in the call
        h.st.lock().peers.get_mut(&b).unwrap().who.guest = true;
        let line = h.say(&a, &ann, "first draft", None, None, None).unwrap();
        let id = line["id"].as_str().unwrap().to_string();
        assert!(!line.contains_key("fwd"));
        let fwd = json!({"name": "Cy", "conv": "Design", "ts": 1700000000000_i64, "kind": "channel"});
        let reply = h.say(&b, &ben, "answer", Some(&json!(id)), Some(&json!(["ann@x", "ben@x"])), Some(&fwd)).unwrap();
        assert_eq!(reply["reply_to"], json!({"id": id, "name": "ANN@X", "text": "first draft"}));
        assert_eq!(reply["mentions"], json!(["ann@x"]));
        assert_eq!(reply["fwd"], fwd);
        assert_eq!(refusal(h.say(&b, &ben, "x", None, None, Some(&json!({"name": "Cy"})))), "400 fwd must be {name, conv, ts, kind}");
        let edit = |who: &Identity, peer: &str, text: &str| h.chat_change(who, "room", &id, Some(&json!(text)), false, Some(peer.to_string()), None, None, None);
        assert_eq!(refusal(edit(&ben, &b, "mine")), "403 only the person who wrote a message can edit it");
        edit(&ann, &a, "final words").unwrap();
        let gone = h.chat_change(&ann, "room", &id, None, true, Some(a.clone()), None, None, None).unwrap();
        assert_eq!((&gone["text"], gone.contains_key("deleted")), (&json!(""), true));
        assert_eq!(h.chat_change(&ann, "room", &id, None, true, Some(a.clone()), None, None, None).unwrap(), gone);
        let text = pj::dumps(&lines_value(&h.st.lock().rooms));
        assert!(!text.contains("first draft") && !text.contains("final words"));
        assert_eq!(refusal(h.say(&b, &ben, "x", Some(&json!(id)), None, None)), "400 that message was deleted");
    }

    /// AC-2a 16.1 f-relay: the `messages` counter moves with a relayed chat message (and not with a refused one), and
    /// `fleet_counts` sees the call.
    #[test]
    fn ac2a_a_chat_message_moves_the_messages_counter_and_the_call_is_counted() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        let counters = crate::fleet_probe::counters();
        let before = counters.messages_total();
        assert!(h.say(&a, &ann, "hi", None, None, None).is_err(), "a refused line is no message");
        h.st.lock().peers.get_mut(&b).unwrap().who.guest = true;
        h.say(&a, &ann, "hi", None, None, None).unwrap();
        // other tests run at once and may add more; this one added at least its one line
        assert!(counters.messages_total() > before);
        let c = h.fleet_counts();
        assert_eq!((c.calls_active, c.participants), (1, 2));
        assert!(c.online.contains("ann@x"));
    }

    // ── CD-1: copy detection with a session proof ───────────────────────────────────────────────────────────

    const COPY: &str = "409 this device's certificate is already signed in from another computer";

    fn conflicts(h: &Hub) -> usize {
        h.st.lock().sessions.values().flat_map(|s| s.events.iter()).filter(|e| pj::text_of(e, "type") == "device_conflict").count()
    }

    fn sid(o: &Obj) -> String {
        o["session"].as_str().unwrap().to_string()
    }

    fn body(session: &str) -> Obj {
        obj([("session", Value::from(session))])
    }

    #[test]
    fn cd1_a_join_from_another_address_with_the_live_session_is_accepted() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let s = sid(&h.hello(&ben, "198.51.100.1", &Obj::new()).unwrap());
        let p = peer_of(&h.join("ops", &ben, "203.0.113.9", false, Some(&body(&s))).unwrap());
        assert_eq!(conflicts(&h), 0);
        assert_eq!(h.st.lock().peers[&p].session, s);
        // a non-string session is ignored like an absent one
        let b = obj([("session", json!(5))]);
        assert_eq!(refusal(h.join("ops2", &ben, "192.0.2.7", false, Some(&b))), COPY);
    }

    #[test]
    fn cd1_a_join_from_another_address_without_the_session_is_refused() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        h.hello(&ben, "198.51.100.1", &Obj::new()).unwrap();
        assert_eq!(refusal(h.join("ops", &ben, "203.0.113.9", false, None)), COPY);
        assert_eq!(refusal(h.join("ops", &ben, "203.0.113.9", false, Some(&body("nope")))), COPY);
        assert!(conflicts(&h) > 0);
    }

    #[test]
    fn cd1_a_hello_with_resume_replaces_the_session_and_moves_its_peers() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let s1 = sid(&h.hello(&ben, "198.51.100.1", &Obj::new()).unwrap());
        let p = peer_of(&h.join("ops", &ben, "203.0.113.9", false, Some(&body(&s1))).unwrap());
        let s2 = sid(&h.hello_resume(&ben, "192.0.2.7", &Obj::new(), true, &s1).unwrap());
        assert_eq!(conflicts(&h), 0);
        let st = h.st.lock();
        assert!(!st.sessions.contains_key(&s1));
        assert!(st.sessions.contains_key(&s2));
        assert_eq!(st.peers[&p].session, s2);
    }

    #[test]
    fn cd1_a_resume_of_someone_elses_session_does_not_help() {
        let h = hub();
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let cy = who("cy@x", "cccccccccccccccc");
        let ben_other = who("ben@x", "dddddddddddddddd");
        h.hello(&ben, "198.51.100.1", &Obj::new()).unwrap();
        let theirs = sid(&h.hello(&cy, "192.0.2.7", &Obj::new()).unwrap());
        let other_device = sid(&h.hello(&ben_other, "192.0.2.8", &Obj::new()).unwrap());
        assert_eq!(refusal(h.hello_resume(&ben, "203.0.113.9", &Obj::new(), true, &theirs)), COPY);
        assert_eq!(refusal(h.hello_resume(&ben, "203.0.113.9", &Obj::new(), true, &other_device)), COPY);
        assert_eq!(refusal(h.join("ops", &ben, "203.0.113.9", false, Some(&body(&theirs)))), COPY);
        assert!(conflicts(&h) > 0);
    }
}
