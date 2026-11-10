// Phase C (ADR-0534): the Meet relay's state (meet_relay.Hub): rooms, peers and seats, presence sessions and their
// inboxes, room history with rseq and catch-up, direct messages, reactions, invitations, devices, the certificate
// mailboxes (renewals, enrolments, seed requests) and the admin queue, behind ONE lock and one condition variable as
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

pub const PEER_TIMEOUT: f64 = 40.0;
pub const SESSION_TIMEOUT: f64 = 40.0;
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
const SAVE_EVERY: f64 = 2.0;
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
type PState = (bool, String, Vec<(String, String, String)>);

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
    denied: Obj,
    moved: HashMap<String, Moved>,
    room_seq: HashMap<String, i64>,
    stays: HashMap<String, Stay>,
    gone: HashMap<String, GoneQueue>,
    pub dirty: bool,
    last_prune: f64,
    history_s: f64,
    mail_s: f64,
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
        for p in self.peers.values_mut() {
            if p.room == room && Some(p.peer_id.as_str()) != skip {
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

    fn members(&self, room: &str) -> Vec<Value> {
        self.peers.values().filter(|p| p.room == room).map(|p| Value::Object(with(&p.public(), obj([("weak", Value::Bool(p.weak))])))).collect()
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
        if who.console {
            return;
        }
        let now = pj::now();
        let mut devices = as_obj(self.directory.get(&who.principal)).and_then(|e| as_obj(e.get("devices"))).cloned().unwrap_or_default();
        if !who.device.is_empty() {
            devices.insert(who.device.clone(), Value::Object(obj([("label", Value::from(who.device_label.clone())), ("last_seen", f(now))])));
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
        if let Some(p) = self.peers.values().find(|p| p.who.principal == principal) {
            return (true, p.room.clone(), devices);
        }
        if self.sessions.values().any(|s| s.who.principal == principal) {
            return (true, String::new(), devices);
        }
        (false, String::new(), devices)
    }

    fn announce(&mut self, who: &Identity, before: &PState) {
        if who.console {
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
        let event = obj([
            ("type", Value::from("presence")),
            ("principal", Value::from(who.principal.clone())),
            ("name", Value::from(who.name.clone())),
            ("online", Value::Bool(after.0)),
            ("room", Value::from(after.1.clone())),
            ("devices", Self::devices_value(&after.2)),
        ]);
        for s in self.sessions.values_mut() {
            push(&mut s.seq, &mut s.events, &event);
        }
    }

    /// _check_copy: a device certificate active right now from another address is refused (409).
    fn check_copy(&mut self, who: &Identity, address: &str) -> R<()> {
        if who.device.is_empty() || address.is_empty() {
            return Ok(());
        }
        let now = pj::mono();
        let others: Vec<(String, String, f64, String)> = self
            .sessions
            .values()
            .map(|s| (s.who.principal.clone(), s.who.device.clone(), s.last_seen, s.address.clone()))
            .chain(self.peers.values().map(|p| (p.who.principal.clone(), p.who.device.clone(), p.last_seen, p.address.clone())))
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

    /// _online: people online by principal; the console server is not a person.
    pub fn online(&self) -> IndexMap<String, Obj> {
        let mut out: IndexMap<String, Obj> = IndexMap::new();
        let mut add = |who: &Identity, since: f64, room: &str| {
            if who.console {
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
        }
        out
    }

    fn set_recording(&mut self, id: &str, on: bool) {
        let Some(p) = self.peers.get_mut(id) else { return };
        p.recording = on;
        let (room, name, principal) = (p.room.clone(), p.who.name.clone(), p.who.principal.clone());
        self.broadcast(&room, &obj([("type", Value::from("recording")), ("peer", Value::from(id)), ("name", Value::from(name.clone())), ("principal", Value::from(principal.clone())), ("on", Value::Bool(on))]), None);
        let mut line = obj([
            ("kind", Value::from("recording")),
            ("id", Value::from(pj::token_hex(6))),
            ("peer", Value::from(id)),
            ("name", Value::from(name)),
            ("principal", Value::from(principal)),
            ("on", Value::Bool(on)),
            ("ts", f(pj::now())),
        ]);
        self.room_log(&room, &mut line);
    }

    /// _drop: remove a room peer.
    fn drop_peer(&mut self, id: &str, why: &str, announce: bool, end_stay: bool) {
        let Some(p) = self.peers.get(id) else { return };
        let before = self.pstate(&p.who.principal.clone());
        if self.peers[id].recording {
            self.set_recording(id, false);
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
                if to == principal && from != principal && pj::num(msg, "ts") > pj::as_num(marks.get(&from)).unwrap_or(0.0) {
                    let n = pj::as_int(out.get(&from)).unwrap_or(0) + 1;
                    out.insert(from, Value::from(n));
                }
            }
        }
        out
    }

    fn prune(&mut self, now: f64) {
        let (hist_cut, mail_cut, invite_cut) = (now - self.history_s, now - self.mail_s, now - INVITE_TTL);
        let keep = |lines: &mut Lines, cut: f64| {
            for v in lines.values_mut() {
                v.retain(|l| pj::num(l, "ts") >= cut);
            }
            lines.retain(|_, v| !v.is_empty());
        };
        keep(&mut self.rooms, hist_cut);
        keep(&mut self.dms, mail_cut);
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
        ]));
        pj::dumps(&v)
    }

    fn drop_matching(&mut self, wanted: &HashSet<String>) -> i64 {
        let mut count = 0;
        let peers: Vec<String> = self.peers.values().filter(|p| !p.who.serial.is_empty() && wanted.contains(&m::serial(&p.who.serial))).map(|p| p.peer_id.clone()).collect();
        for id in peers {
            self.drop_peer(&id, "revoked", true, true);
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
    for (block, _) in pem_blocks(pem.as_bytes(), "CERTIFICATE REQUEST").into_iter().chain(pem_blocks(pem.as_bytes(), "NEW CERTIFICATE REQUEST")) {
        let text = String::from_utf8_lossy(&block);
        let body: String = text.lines().filter(|l| !l.starts_with("-----")).collect::<String>().split_whitespace().collect();
        return match pj::b64_strict(&body) {
            Some(der) => crate::codec::sha256_hex(&der),
            None => String::new(),
        };
    }
    String::new()
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

// ── the hub ──────────────────────────────────────────────────────────────────────────────────────────────────

pub struct Hub {
    pub st: Mutex<State>,
    cond: Condvar,
    pub signer: Option<Arc<SignerClient>>,
    pub links: Arc<LinkStats>,
    state_dir: Option<PathBuf>,
    save_lock: Mutex<()>,
    stop: AtomicBool,
}

type Body<'a> = Option<&'a Value>;

impl Hub {
    pub fn new(state_dir: Option<PathBuf>, admins: &[String], history_hours: f64, mail_days: f64, signer: Option<Arc<SignerClient>>, links: Arc<LinkStats>) -> Hub {
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
            history_s: history_hours * 3600.0,
            mail_s: mail_days * 86400.0,
        };
        let hub = Hub { st: Mutex::new(st), cond: Condvar::new(), signer, links, state_dir, save_lock: Mutex::new(()), stop: AtomicBool::new(false) };
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

    /// Write state.json now (tmp file, then rename).
    pub fn save(&self) {
        let Some(path) = self.path() else { return };
        let _g = self.save_lock.lock();
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
            std::fs::rename(&tmp, &path)
        })();
        if let Err(e) = result {
            log_warn(&format!("cannot write {}: {e}", path.display()));
            self.st.lock().dirty = true;
        }
    }

    /// Background upkeep: reap every REAP_EVERY s, save at most every SAVE_EVERY s when something changed.
    pub fn start(self: &Arc<Self>) {
        let hub = self.clone();
        let _ = std::thread::Builder::new().name("relay-upkeep".into()).spawn(move || {
            let mut last_reap = pj::mono();
            loop {
                std::thread::sleep(Duration::from_secs_f64(SAVE_EVERY));
                if hub.stop.load(Ordering::Relaxed) {
                    return;
                }
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if pj::mono() - last_reap >= REAP_EVERY {
                        last_reap = pj::mono();
                        hub.reap();
                    }
                    if hub.st.lock().dirty {
                        hub.save();
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
            st.drop_peer(&id, "timeout", true, true);
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
        if now - st.last_prune >= PRUNE_EVERY {
            st.last_prune = now;
            st.prune(pj::now());
        }
        drop(st);
        self.wake();
    }

    // ── rooms ────────────────────────────────────────────────────────────────────────────────────────────────

    pub fn join(&self, room: &str, who: &Identity, address: &str, late_history: bool, client: Body) -> R<Obj> {
        if who.seed {
            return forbidden(m::FINISH_SETUP);
        }
        let client = m::client(client);
        let mut st = self.st.lock();
        let r = self.join_locked(&mut st, room, who, address, late_history, &client);
        drop(st);
        self.wake();
        let (out, peer_id) = r?;
        log_info(&format!(
            "join room={room} principal={} peer={peer_id} device={} device_label={} app={} version={} platform={}",
            who.principal,
            kv(&who.device),
            kv(&who.device_label),
            kv_of(client.get("app")),
            kv_of(client.get("version")),
            kv_of(client.get("platform"))
        ));
        Ok(out)
    }

    fn join_locked(&self, st: &mut State, room: &str, who: &Identity, address: &str, late_history: bool, client: &Obj) -> R<(Obj, String)> {
        st.check_copy(who, address)?;
        let mine: Vec<String> = st.peers.values().filter(|p| p.who.principal == who.principal && p.room == room).map(|p| p.peer_id.clone()).collect();
        if st.peers.values().filter(|p| p.room == room && p.who.principal != who.principal).count() >= PEER_MAX_PER_ROOM {
            return forbidden(format!("room {room} is full ({PEER_MAX_PER_ROOM} people)"));
        }
        let before = st.pstate(&who.principal);
        for old in mine {
            let device = st.peers[&old].who.device.clone();
            if device != who.device {
                st.push_peer(&old, &obj([("type", Value::from("moved")), ("room", Value::from(room)), ("to_device", Value::from(who.device.clone())), ("to_label", Value::from(who.device_label.clone()))]));
                let event = st.peers[&old].events.back().cloned().unwrap_or_default();
                st.moved.insert(old.clone(), Moved { principal: who.principal.clone(), event, at: pj::mono() });
                st.drop_peer(&old, "moved", false, false);
            } else {
                st.drop_peer(&old, "rejoined", false, false);
            }
        }
        if who.own_device() {
            let same: Vec<String> = st.peers.values().filter(|p| p.who.principal == who.principal && p.who.device == who.device).map(|p| p.peer_id.clone()).collect();
            for old in same {
                st.drop_peer(&old, "replaced", false, true);
            }
        }
        let peer = Peer {
            peer_id: pj::token_urlsafe(12),
            room: room.to_string(),
            who: who.clone(),
            last_seen: pj::mono(),
            seq: 0,
            events: VecDeque::new(),
            joined: pj::now(),
            recording: false,
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
        };
        let members = st.members(room);
        let recording: Vec<Value> = st.peers.values().filter(|p| p.room == room && p.recording).map(|p| Value::from(p.peer_id.clone())).collect();
        let now = pj::now();
        let creates = !st.stays.contains_key(room);
        if creates {
            st.stays.insert(room.to_string(), Stay { start: now, seen: IndexMap::new(), late_history });
            if late_history {
                log_info(&format!("options room={room} principal={} late_history=on why=created", who.principal));
            }
        }
        let stay = st.stays.get_mut(room).expect("the stay");
        let mut late_join = stay.late_history && !stay.seen.contains_key(&who.principal);
        stay.seen.entry(who.principal.clone()).or_insert(now);
        let (stay_start, stay_late) = (stay.start, stay.late_history);
        let public = peer.public();
        let peer_id = peer.peer_id.clone();
        st.peers.insert(peer_id.clone(), peer);
        st.seen(who);
        st.broadcast(room, &with(&obj([("type", Value::from("join"))]), public.clone()), Some(&peer_id));
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
        if let Some(pending) = st.invites.get_mut(&who.principal) {
            pending.retain(|i| pj::text_of(i, "room") != room);
            if pending.is_empty() {
                st.invites.shift_remove(&who.principal);
            }
        }
        st.announce(who, &before);
        let mut out_missed = obj([("since", since.unwrap_or(Value::Null)), ("lines", Value::Array(missed))]);
        if late_join {
            out_missed.insert("late_join".into(), Value::Bool(true));
        }
        let out = obj([
            ("peer", Value::from(peer_id.clone())),
            ("you", Value::Object(public)),
            ("members", Value::Array(members)),
            ("chat", Value::Array(history)),
            ("missed", Value::Object(out_missed)),
            ("recording", Value::Array(recording)),
            ("rseq", Value::from(rseq)),
            ("options", Value::Object(obj([("late_history", Value::Bool(stay_late))]))),
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

    pub fn say(&self, peer_id: &str, who: &Identity, text: &str) -> R<Obj> {
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        let mut line = obj([
            ("type", Value::from("chat")),
            ("kind", Value::from("chat")),
            ("id", Value::from(pj::token_hex(6))),
            ("from", Value::from(peer_id)),
            ("name", Value::from(who.name.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("text", Value::from(text)),
            ("ts", f(pj::now())),
            ("reactions", Value::Object(Obj::new())),
        ]);
        st.room_log(&room, &mut line);
        st.broadcast(&room, &line, None);
        drop(st);
        self.wake();
        log_info(&format!("chat room={room} principal={} chars={}", who.principal, pj::char_len(text)));
        Ok(line)
    }

    pub fn caption(&self, peer_id: &str, who: &Identity, text: &str, cseq_v: Body, age_v: Body, dur_v: Body) -> R<Obj> {
        let cseq = cseq(cseq_v)?;
        let age = ms(age_v, "age_ms", AGE_MS_MAX)?;
        let dur = ms(dur_v, "dur_ms", DUR_MS_MAX)?;
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        let (line, repeat) = Self::caption_line(&mut st, peer_id, who, text, cseq, age, dur);
        drop(st);
        self.wake();
        Self::caption_logged(&room, who, text, &line, repeat);
        Ok(line)
    }

    pub fn captions(&self, peer_id: &str, who: &Identity, lines: Body, weak: Option<bool>, sent_ms: Body) -> R<Obj> {
        let Some(Value::Array(lines)) = lines else { return bad("lines must be a list") };
        if lines.is_empty() || lines.len() > CAPTIONS_BATCH_MAX {
            return bad(format!("send 1 to {CAPTIONS_BATCH_MAX} lines at a time"));
        }
        let sent = pj::as_num(sent_ms);
        let mut out: Vec<Value> = Vec::new();
        let mut done: Vec<(String, Obj, bool)> = Vec::new();
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
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
            let checked = (|| -> R<(String, Option<i64>, Option<i64>, Option<i64>)> {
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
                    let (line, repeat) = Self::caption_line(&mut st, peer_id, who, &t, c, age, dur);
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

    fn caption_line(st: &mut State, peer_id: &str, who: &Identity, text: &str, cseq: Option<i64>, age: Option<i64>, dur: Option<i64>) -> (Obj, bool) {
        if let Some(c) = cseq {
            if let Some(stored) = st.peers[peer_id].captions.get(&c) {
                return (stored.clone(), true);
            }
        }
        let room = st.peers[peer_id].room.clone();
        let mut line = obj([
            ("type", Value::from("caption")),
            ("kind", Value::from("caption")),
            ("id", Value::from(pj::token_hex(6))),
            ("from", Value::from(peer_id)),
            ("name", Value::from(who.name.clone())),
            ("principal", Value::from(who.principal.clone())),
            ("text", Value::from(text)),
            ("ts", f(pj::now())),
        ]);
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
        (line, false)
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
        st.drop_peer(peer_id, "left", true, true);
        drop(st);
        self.wake();
        Ok(())
    }

    pub fn recording(&self, peer_id: &str, who: &Identity, on: Body) -> R<Obj> {
        let Some(Value::Bool(on)) = on else { return bad("on must be true or false") };
        let on = *on;
        let mut st = self.st.lock();
        st.owned(peer_id, who)?;
        let room = st.peers[peer_id].room.clone();
        if st.peers[peer_id].recording != on {
            st.set_recording(peer_id, on);
        }
        drop(st);
        self.wake();
        log_info(&format!("recording room={room} principal={} on={}", who.principal, if on { "True" } else { "False" }));
        Ok(obj([("ok", Value::Bool(true)), ("on", Value::Bool(on))]))
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
            Stay { start: now, seen, late_history: false }
        });
        let changed = stay.late_history != late;
        if changed {
            stay.late_history = late;
            st.broadcast(&room, &obj([("type", Value::from("room_options")), ("late_history", Value::Bool(late)), ("by", Value::from(who.name.clone())), ("principal", Value::from(who.principal.clone())), ("peer", Value::from(peer_id))]), None);
        }
        drop(st);
        self.wake();
        if changed {
            log_info(&format!("options room={room} principal={} late_history={}", who.principal, if late { "on" } else { "off" }));
        }
        Ok(obj([("ok", Value::Bool(true)), ("options", Value::Object(obj([("late_history", Value::Bool(late))])))]))
    }

    pub fn room_captions(&self, peer_id: &str, who: &Identity, after: &str, limit: &str) -> R<Obj> {
        let whole = |s: &str| m::py_int(s).map_err(|_| E::Bad("after and limit must be whole numbers".into()));
        let after = whole(after)?;
        let limit = whole(limit)?.clamp(1, m::CAPTIONS_LIMIT_MAX) as usize;
        let st = self.st.lock();
        st.owned(peer_id, who)?;
        let p = &st.peers[peer_id];
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

    pub fn hello(&self, who: &Identity, address: &str, client: &Obj) -> R<Obj> {
        if who.seed {
            return forbidden(m::FINISH_SETUP);
        }
        let client = m::client(Some(&Value::Object(client.clone())));
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            st.check_copy(who, address)?;
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
            };
            let sid = session.session_id.clone();
            st.sessions.insert(sid.clone(), session);
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
                    Value::Object(obj([
                        ("principal", Value::from(p.clone())),
                        ("name", Value::from(if name.is_empty() { p.clone() } else { name })),
                        ("last_seen", if on.is_some() { f(now) } else { e.get("last_seen").cloned().unwrap_or(Value::from(0)) }),
                        ("online", Value::Bool(on.is_some())),
                        ("devices", on.and_then(|o| o.get("devices").cloned()).unwrap_or(Value::Array(Vec::new()))),
                    ]))
                })
                .collect();
            let invites: Vec<Value> = st.invites.get(&who.principal).map(|l| l.iter().filter(|i| pj::num(i, "ts") > now - INVITE_TTL).map(|i| Value::Object(i.clone())).collect()).unwrap_or_default();
            let renewed = st.renewed.get(&m::key(&who.principal, &who.device)).cloned().unwrap_or(Value::Null);
            let admin = st.admins.contains(&who.principal);
            let reply = obj([
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
            ]);
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

    // ── direct messages and reactions ────────────────────────────────────────────────────────────────────────

    pub fn dm(&self, session: &str, who: &Identity, to: &str, text: Body) -> R<Obj> {
        let to = to.trim().to_lowercase();
        let text = m::text(text, "messages")?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let Some(entry) = st.directory.get(&to).cloned() else { return Err(E::NotFound("nobody with that address has used this relay yet".into())) };
        let to_name = entry.as_object().map(|e| pj::s(e, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| to.clone());
        let msg = obj([
            ("id", Value::from(pj::token_hex(8))),
            ("from", Value::from(who.principal.clone())),
            ("from_name", Value::from(who.name.clone())),
            ("to", Value::from(to.clone())),
            ("to_name", Value::from(to_name)),
            ("text", Value::from(text.clone())),
            ("ts", f(pj::now())),
            ("reactions", Value::Object(Obj::new())),
        ]);
        let list = st.dms.entry(conv(&who.principal, &to)).or_default();
        list.push(msg.clone());
        if list.len() > DM_KEEP {
            let cut = list.len() - DM_KEEP;
            list.drain(..cut);
        }
        st.dirty = true;
        st.tell(&[to.clone(), who.principal.clone()], &with(&msg, obj([("type", Value::from("dm"))])), Some(session));
        drop(st);
        self.wake();
        log_info(&format!("dm from={} to={to} chars={}", who.principal, pj::char_len(&text)));
        Ok(msg)
    }

    pub fn dm_history(&self, session: &str, who: &Identity, with_: &str, after: &Value, limit: i64) -> R<Obj> {
        let with_ = with_.trim().to_lowercase();
        let after = m::number(Some(after), "after")?;
        let limit = limit.clamp(1, DM_LIMIT_MAX) as usize;
        let st = self.st.lock();
        st.session(session, who)?;
        let msgs: Vec<&Obj> = st.dms.get(&conv(&who.principal, &with_)).map(|l| l.iter().filter(|m| pj::num(m, "ts") > after).collect()).unwrap_or_default();
        let cut = msgs.len().saturating_sub(limit);
        Ok(obj([("messages", Value::Array(msgs[cut..].iter().map(|m| Value::Object((*m).clone())).collect()))]))
    }

    pub fn dm_read(&self, session: &str, who: &Identity, with_: &str, ts: Body) -> R<Obj> {
        let with_ = with_.trim().to_lowercase();
        let ts = m::number(ts, "ts")?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let marks = obj_mut(&mut st.read, &who.principal);
        if ts > pj::as_num(marks.get(&with_)).unwrap_or(0.0) {
            marks.insert(with_, f(ts));
            st.dirty = true;
        }
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// _toggle: the caller's reaction on or off.
    fn toggle(item: &mut Obj, emoji: &str, principal: &str) -> R<bool> {
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
    pub fn react(&self, who: &Identity, scope: &str, id: &str, emoji: &str, session: Option<String>, peer: Option<String>, with_: Option<String>) -> R<Obj> {
        let emoji = emoji.trim().to_string();
        if emoji.is_empty() || pj::char_len(&emoji) > EMOJI_MAX {
            return bad(format!("a reaction is one emoji (at most {EMOJI_MAX} characters)"));
        }
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let (on, reactions) = if scope == "room" {
                let Some(peer) = &peer else { return bad("a reaction in a room needs your room session (peer)") };
                st.owned(peer, who)?;
                let room = st.peers[peer.as_str()].room.clone();
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
                if let Some(s) = &session {
                    st.session(s, who)?;
                } else if let Some(p) = &peer {
                    st.owned(p, who)?;
                } else {
                    return bad("a reaction needs your session");
                }
                let with_ = with_.as_deref().unwrap_or("").trim().to_lowercase();
                if with_.is_empty() {
                    return bad("say whose conversation the message is in (with)");
                }
                let target = st.dms.get_mut(&conv(&who.principal, &with_)).and_then(|l| l.iter_mut().find(|m| pj::text_of(m, "id") == id));
                let Some(target) = target else { return Err(E::NotFound("that message is no longer kept".into())) };
                let on = Self::toggle(target, emoji.as_str(), &who.principal)?;
                let reactions = target.get("reactions").cloned().unwrap_or(Value::Object(Obj::new()));
                let event = obj([
                    ("type", Value::from("react")),
                    ("scope", Value::from("dm")),
                    ("id", Value::from(id)),
                    ("emoji", Value::from(emoji.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("name", Value::from(who.name.clone())),
                    ("on", Value::Bool(on)),
                ]);
                for s in st.sessions.values_mut() {
                    if s.who.principal == who.principal {
                        push(&mut s.seq, &mut s.events, &with(&event, obj([("with", Value::from(with_.clone()))])));
                    } else if s.who.principal == with_ {
                        push(&mut s.seq, &mut s.events, &with(&event, obj([("with", Value::from(who.principal.clone()))])));
                    }
                }
                st.dirty = true;
                (on, reactions)
            } else {
                return bad("scope must be dm or room");
            };
            Ok(obj([("id", Value::from(id)), ("emoji", Value::from(emoji.clone())), ("on", Value::Bool(on)), ("reactions", reactions)]))
        })();
        drop(st);
        self.wake();
        r
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
        let now = pj::now();
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
        let mut out = Vec::new();
        for t in &targets {
            let inv = obj([
                ("id", Value::from(pj::token_hex(8))),
                ("from", Value::from(who.principal.clone())),
                ("from_name", Value::from(who.name.clone())),
                ("to", Value::from(t.clone())),
                ("room", Value::from(room.clone())),
                ("ts", f(now)),
                ("host", host.clone().map(Value::Object).unwrap_or(Value::Null)),
            ]);
            let mut pending: Vec<Obj> = st.invites.get(t).cloned().unwrap_or_default().into_iter().filter(|i| !(pj::text_of(i, "room") == room && pj::text_of(i, "from") == who.principal)).collect();
            pending.push(inv.clone());
            st.invites.insert(t.clone(), pending);
            st.tell(std::slice::from_ref(t), &with(&inv, obj([("type", Value::from("invite"))])), None);
            out.push(Value::Object(inv));
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
        out
    }

    pub fn is_denied(&self, serial: &str) -> bool {
        let s = m::serial(serial);
        !s.is_empty() && self.st.lock().denied.contains_key(&s)
    }

    /// drop_serials: end every peer and session whose certificate serial is listed.
    pub fn drop_serials(&self, serials: &[String]) -> i64 {
        let wanted: HashSet<String> = serials.iter().map(|s| m::serial(s)).filter(|s| !s.is_empty()).collect();
        if wanted.is_empty() {
            return 0;
        }
        let mut st = self.st.lock();
        let n = st.drop_matching(&wanted);
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
        let mut out: Vec<Obj> = rows.values().filter_map(Value::as_object).filter(|r| keep(*r)).cloned().collect();
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

    // ── enrolment ────────────────────────────────────────────────────────────────────────────────────────────

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
            "enrolment {} principal={} device={device} seed={serial} origin={}",
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
                log_info(&format!("enrolment delivered principal={} device={} seed={serial}", who.principal, str_value(row.get("device"))));
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
            let Some(row) = as_obj(st.enrollments.get(&serial)) else { return Err(E::NotFound("no enrolment is waiting for that invite".into())) };
            if pj::text_of(row, "state") == "signed" {
                return Err(E::Conflict("that enrolment was already signed".into()));
            }
            (row.get("csr_pem").cloned().unwrap_or(Value::Null), pj::text_of(row, "principal"), row.get("device").cloned().unwrap_or(Value::Null))
        };
        if reason.is_empty() {
            let (cert, _) = load_issued(cert_pem, ca_pem)?;
            if !cert_emails(&cert).contains(&principal) {
                return bad("the certificate is for a different email");
            }
            if Value::from(m::uri_value(&cert.names.uris, m::DEVICE_URI_PREFIX)) != device {
                return bad("the certificate is not for the device that asked");
            }
            if cert.spki != load_csr(Some(&csr_pem))?.spki {
                return bad("the certificate is not for the key that device made");
            }
        }
        let mut st = self.st.lock();
        let row = st.enrollments.get_mut(&serial).and_then(Value::as_object_mut);
        let Some(row) = row.filter(|r| pj::text_of(r, "state") != "signed") else { return Err(E::Conflict("that enrolment was already answered".into())) };
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
        log_info(&format!("enrolment {} principal={principal} seed={serial} by={}", if reason.is_empty() { "signed" } else { "refused" }, who.principal));
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
            let pick = |rows: &Obj, keep: &dyn Fn(&Obj) -> bool| -> Vec<Obj> { rows.values().filter_map(Value::as_object).filter(|r| keep(*r)).cloned().collect() };
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
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, None, Arc::new(LinkStats::new()))
    }

    #[test]
    fn a_chat_line_gets_the_room_rseq_and_reaches_the_room() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let ben = who("ben@x", "bbbbbbbbbbbbbbbb");
        let a = h.join("ops", &ann, "", false, None).unwrap();
        let b = h.join("ops", &ben, "", false, None).unwrap();
        assert_eq!(b["members"].as_array().unwrap().len(), 1);
        let line = h.say(a["peer"].as_str().unwrap(), &ann, "hi").unwrap();
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
        let text = "{\"v\": 2, \"directory\": {\"ann@x\": {\"name\": \"Ann\", \"last_seen\": 1.5}}, \"dms\": {}, \"read\": {}, \"invites\": {}, \"rooms\": {}, \"left\": {}, \"renewals\": {}, \"renewed\": {}, \"enrollments\": {}, \"consumed_seeds\": {}, \"seed_requests\": {}, \"seeded\": {}, \"denied\": {}}";
        let dir = std::env::temp_dir().join(format!("meet-state-{}", pj::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), text).unwrap();
        let h = Hub::new(Some(dir.clone()), &[], 1e9, 1e9, None, Arc::new(LinkStats::new()));
        assert_eq!(h.st.lock().snapshot(), text);
        let _ = std::fs::remove_dir_all(dir);
    }
}
