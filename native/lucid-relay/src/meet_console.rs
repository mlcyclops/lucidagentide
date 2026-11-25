// Phase C (ADR-0540), AC-1: what the Meeting Hub section of the Admin Console reads from the relay: the in-memory log
// ring (session ids and download tokens hidden), per-link performance from link reports and `state` signals, and the
// download server's power through the Proxmox API (`files_power`); the `console_sources` networks the Admin Console
// port answers (contract 3.1). The /v1/console/* routes and the console server's certificate are gone (9.1).

use crate::meet::{log_info, log_warn, Level, Relay, Settings, SERVER_VERSION};
use crate::meet_json::{self as pj, f, obj, Obj};
use crate::meet_tls::{client_config, https_request};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

const LOG_KEEP: usize = 2000;
const LOG_LINE_MAX: usize = 400;
const LINK_WINDOW: f64 = 300.0;
const LINK_KEEP: f64 = 3600.0;
const LINK_MAX: usize = 500;
const LINK_SAMPLES: usize = 300;
const LEDGER_RECENT: i64 = 10;
const POWER_TIMEOUT: f64 = 10.0;
const POWER_TTL: f64 = 15.0;
const WINDOW_HOURS: f64 = 24.0;
const POWER_HINT: &str = "Start the download server from Proxmox (VM 208).";
const SIGNER_FIELDS: [&str; 14] = [
    "healthy", "error", "root_mode", "not_after", "days_left", "intermediate_serial", "previous_serial", "previous_not_after", "root_not_after", "root_crl_days_left", "pending_key", "ledger_seq", "ledger_head", "policy",
];
const LEDGER_FIELDS: [&str; 9] = ["seq", "ts", "op", "via", "principal", "name", "device_label", "serial", "why"];

// ── the log ring ─────────────────────────────────────────────────────────────────────────────────────────────

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// clean_line: one line, session ids and download tokens hidden, at most LOG_LINE_MAX characters.
pub fn clean_line(text: &str) -> String {
    let text = pj::squash(text);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < chars.len() {
        if i == 0 || !word_char(chars[i - 1]) {
            for k in ["session", "token", "secret", "password", "credential"] {
                let n = k.len();
                if i + n < chars.len() && chars[i..i + n].iter().collect::<String>().to_lowercase() == k && chars[i + n] == '=' {
                    let mut j = i + n + 1;
                    while j < chars.len() && !(chars[j].is_whitespace() || ",;&".contains(chars[j])) {
                        j += 1;
                    }
                    if j > i + n + 1 {
                        out.extend(&chars[i..i + n]);
                        out.push_str("=[hidden]");
                        i = j;
                        continue 'outer;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    let chars: Vec<char> = out.chars().collect();
    let mut done = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '/' && i + 2 < chars.len() && chars[i + 1] == 'd' && chars[i + 2] == '/' {
            let mut j = i + 3;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || "_.=-".contains(chars[j])) {
                j += 1;
            }
            if j > i + 3 {
                done.push_str("/d/[hidden]");
                i = j;
                continue;
            }
        }
        done.push(chars[i]);
        i += 1;
    }
    pj::clip(&done, LOG_LINE_MAX)
}

struct RingLine {
    seq: i64,
    ts: f64,
    levelno: i64,
    level: &'static str,
    text: String,
}

/// LogRing: the last LOG_KEEP INFO-and-above lines of the relay's log, in memory.
pub struct LogRing {
    mu: Mutex<(VecDeque<RingLine>, i64)>,
}

impl LogRing {
    fn new() -> LogRing {
        LogRing { mu: Mutex::new((VecDeque::new(), 0)) }
    }

    pub fn emit(&self, ts: f64, level: Level, msg: &str) {
        let text = clean_line(msg);
        let name = match level {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warning => "warning",
            Level::Error => "error",
        };
        let mut g = self.mu.lock();
        g.1 += 1;
        let seq = g.1;
        g.0.push_back(RingLine { seq, ts, levelno: level as i64, level: name, text });
        while g.0.len() > LOG_KEEP {
            g.0.pop_front();
        }
    }

    /// The Admin Console's log view (4.6): every kept line at `floor` (a level number) or above, newest first, each a
    /// JSON line `{ts (ms), level, cat: "relay", event, text}` (already cleaned by clean_line).
    pub fn json_lines(&self, floor: i64) -> Vec<String> {
        let g = self.mu.lock();
        g.0.iter()
            .rev()
            .filter(|r| r.levelno >= floor)
            .map(|r| {
                let event = r.text.split_whitespace().next().unwrap_or_default().to_string();
                serde_json::json!({"seq": r.seq, "ts": (r.ts * 1000.0) as i64, "level": r.level, "cat": "relay", "event": event, "text": r.text}).to_string()
            })
            .collect()
    }

}

// ── link performance ─────────────────────────────────────────────────────────────────────────────────────────

/// The reason as the relay's `link` line writes it.
pub fn link_reason(v: Option<&Value>) -> String {
    let reason = pj::clip(&pj::str_or(v).split_whitespace().collect::<Vec<_>>().join("_"), 60);
    let t: String = reason.chars().filter(|c| c.is_ascii_alphanumeric() || "_.%:/+-".contains(*c)).collect();
    if t.is_empty() { "-".into() } else { t }
}

/// link_path: (path, proto) of a link report or `state` signal, at the top level or inside `stats`.
pub fn link_path(data: &Obj) -> (String, String) {
    let empty = Obj::new();
    let stats = data.get("stats").and_then(Value::as_object).unwrap_or(&empty);
    let pick = |key: &str, allowed: &[&str]| -> String {
        for source in [data, stats] {
            let v = pj::s(source, key).trim().to_lowercase();
            if allowed.contains(&v.as_str()) {
                return v;
            }
        }
        String::new()
    };
    (pick("path", &["host", "srflx", "prflx", "relay"]), pick("proto", &["udp", "tcp"]))
}

type Sample = (f64, Option<f64>, Option<f64>, Option<f64>, Option<f64>);

struct LinkRow {
    room: String,
    principal: String,
    level: String,
    reason: String,
    first: f64,
    last: f64,
    rtt_ms: Option<f64>,
    loss_pct: Option<f64>,
    out_kbps: Option<f64>,
    relay_rtt_ms: Option<f64>,
    path: String,
    proto: String,
    samples: VecDeque<Sample>,
    changes: VecDeque<f64>,
    changes_total: i64,
}

/// LinkStats: per (room, person) the last report and the spread over LINK_WINDOW.
pub struct LinkStats {
    rows: Mutex<Vec<LinkRow>>,
}

fn opt(v: Option<f64>) -> Value {
    v.map(f).unwrap_or(Value::Null)
}

fn spread(values: &[f64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let r = |x: f64| f((x * 10.0).round_ties_even() / 10.0);
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let avg = values.iter().sum::<f64>() / values.len() as f64;
    Value::Object(obj([("min", r(min)), ("avg", r(avg)), ("max", r(max))]))
}

impl LinkStats {
    pub fn new() -> LinkStats {
        LinkStats { rows: Mutex::new(Vec::new()) }
    }

    fn trim(row: &mut LinkRow, now: f64) {
        let cut = now - LINK_WINDOW;
        while row.samples.front().map(|s| s.0 < cut).unwrap_or(false) {
            row.samples.pop_front();
        }
        while row.changes.front().map(|c| *c < cut).unwrap_or(false) {
            row.changes.pop_front();
        }
    }

    fn prune(rows: &mut Vec<LinkRow>, now: f64, room_for: usize) {
        rows.retain(|r| r.last >= now - LINK_KEEP);
        while room_for > 0 && rows.len() > LINK_MAX - room_for {
            let oldest = rows.iter().enumerate().min_by(|a, b| a.1.last.partial_cmp(&b.1.last).unwrap_or(std::cmp::Ordering::Equal)).map(|(i, _)| i).unwrap_or(0);
            rows.remove(oldest);
        }
    }

    /// One report (a link report or a forwarded `state` signal).
    pub fn record(&self, room: &str, principal: &str, data: &Obj) {
        let level = pj::s(data, "level");
        let level = if crate::meet_hub::LINK_LEVELS.contains(&level.as_str()) { level } else { "unknown".into() };
        let empty = Obj::new();
        let stats = data.get("stats").and_then(Value::as_object).unwrap_or(&empty);
        let now = pj::now();
        let n = |o: &Obj, k: &str| pj::as_num(o.get(k));
        let sample = (now, n(stats, "rtt_ms"), n(stats, "loss_pct"), n(stats, "out_kbps"), n(data, "relay_rtt_ms"));
        let mut rows = self.rows.lock();
        let idx = match rows.iter().position(|r| r.room == room && r.principal == principal) {
            Some(i) => {
                if rows[i].level != level {
                    rows[i].changes.push_back(now);
                    while rows[i].changes.len() > LINK_SAMPLES {
                        rows[i].changes.pop_front();
                    }
                    rows[i].changes_total += 1;
                }
                i
            }
            None => {
                if rows.len() >= LINK_MAX {
                    Self::prune(&mut rows, now, 1);
                }
                rows.push(LinkRow {
                    room: room.into(),
                    principal: principal.into(),
                    level: level.clone(),
                    reason: String::new(),
                    first: now,
                    last: now,
                    rtt_ms: None,
                    loss_pct: None,
                    out_kbps: None,
                    relay_rtt_ms: None,
                    path: String::new(),
                    proto: String::new(),
                    samples: VecDeque::new(),
                    changes: VecDeque::new(),
                    changes_total: 0,
                });
                rows.len() - 1
            }
        };
        let row = &mut rows[idx];
        row.level = level;
        row.reason = link_reason(data.get("reason"));
        row.last = now;
        row.rtt_ms = sample.1;
        row.loss_pct = sample.2;
        row.out_kbps = sample.3;
        if data.contains_key("relay_rtt_ms") {
            row.relay_rtt_ms = sample.4;
        }
        let (path, proto) = link_path(data);
        if !path.is_empty() {
            row.path = path;
        }
        if !proto.is_empty() {
            row.proto = proto;
        }
        row.samples.push_back(sample);
        while row.samples.len() > LINK_SAMPLES {
            row.samples.pop_front();
        }
        Self::trim(row, now);
    }

    fn snapshot(&self, room: &str) -> Vec<Obj> {
        let now = pj::now();
        let mut rows = self.rows.lock();
        Self::prune(&mut rows, now, 0);
        let mut out: Vec<Obj> = Vec::new();
        for row in rows.iter_mut() {
            if !room.is_empty() && row.room != room {
                continue;
            }
            Self::trim(row, now);
            let col = |i: usize| -> Vec<f64> {
                row.samples
                    .iter()
                    .filter_map(|s| match i {
                        1 => s.1,
                        2 => s.2,
                        3 => s.3,
                        _ => s.4,
                    })
                    .collect()
            };
            out.push(obj([
                ("room", Value::from(row.room.clone())),
                ("principal", Value::from(row.principal.clone())),
                ("level", Value::from(row.level.clone())),
                ("reason", Value::from(row.reason.clone())),
                ("updated", f(row.last)),
                ("since", f(row.first)),
                ("rtt_ms", opt(row.rtt_ms)),
                ("loss_pct", opt(row.loss_pct)),
                ("out_kbps", opt(row.out_kbps)),
                ("relay_rtt_ms", opt(row.relay_rtt_ms)),
                ("path", Value::from(row.path.clone())),
                ("proto", Value::from(row.proto.clone())),
                ("rtt", spread(&col(1))),
                ("loss", spread(&col(2))),
                ("kbps", spread(&col(3))),
                ("relay_rtt", spread(&col(4))),
                ("samples", Value::from(row.samples.len())),
                ("changes_window", Value::from(row.changes.len())),
                ("changes_total", Value::from(row.changes_total)),
            ]));
        }
        out.sort_by_key(|a| (pj::s(a, "room"), pj::s(a, "principal")));
        out
    }
}

// ── the download server's power (Proxmox) ────────────────────────────────────────────────────────────────────

struct FilesPower {
    host: String,
    port: u16,
    base: String,
    node: String,
    vmid: i64,
    token_file: String,
    ca_file: String,
    window_hours: f64,
    cache: Mutex<(Option<Obj>, f64)>,
}

/// urllib.parse.quote (safe "/").
fn quote(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

impl FilesPower {
    fn new(cfg: &Obj) -> Result<FilesPower, String> {
        let api = pj::s(cfg, "api");
        let rest = api.strip_prefix("https://").ok_or("files_power.api must be https://host:8006/api2/json")?;
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "files_power.api must be https://host:8006/api2/json")?),
            None => (authority.to_string(), 8006),
        };
        if host.is_empty() {
            return Err("files_power.api must be https://host:8006/api2/json".into());
        }
        let node = pj::s(cfg, "node").trim().to_string();
        let vmid = match cfg.get("vmid") {
            Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
            other => pj::as_num(other).map(|x| x.trunc() as i64).unwrap_or(0),
        };
        let token_file = pj::s(cfg, "token_file");
        if node.is_empty() || vmid <= 0 || token_file.is_empty() {
            return Err("files_power needs node, vmid and token_file".into());
        }
        let window_hours = if pj::truthy(cfg.get("window_hours")) {
            match cfg.get("window_hours") {
                Some(Value::String(s)) => crate::meet::py_float(s),
                other => pj::as_num(other),
            }
            .ok_or("files_power.window_hours must be a number")?
        } else {
            WINDOW_HOURS
        };
        let base = if path.is_empty() { "/api2/json".to_string() } else { path.trim_end_matches('/').to_string() };
        Ok(FilesPower { host, port, base, node, vmid, token_file, ca_file: pj::s(cfg, "ca_file"), window_hours, cache: Mutex::new((None, -1e9)) })
    }

    fn token(&self) -> Result<String, String> {
        let t = std::fs::read_to_string(&self.token_file).map_err(|_| "cannot read the Proxmox token file".to_string())?;
        let t = t.trim();
        let t = t.strip_prefix("PVEAPIToken=").unwrap_or(t);
        if !t.contains('!') || !t.contains('=') {
            return Err("the Proxmox token file must hold user@realm!tokenid=secret".into());
        }
        Ok(t.to_string())
    }

    fn call(&self, method: &str, op: &str) -> Result<Value, String> {
        let token = self.token()?;
        let cfg = client_config(if self.ca_file.is_empty() { None } else { Some(&self.ca_file) }, None).map_err(|_| "cannot read the Proxmox CA file".to_string())?;
        let path = format!("{}/nodes/{}/qemu/{}/{op}", self.base, quote(&self.node), self.vmid);
        let headers = [("Authorization", format!("PVEAPIToken={token}"))];
        let body: Option<&[u8]> = if method == "POST" { Some(b"") } else { None };
        let resp = https_request(&cfg, &self.host, self.port, POWER_TIMEOUT, method, &path, &headers, body, &|_: &[u8]| Ok(())).map_err(|e| match e {
            Err(class) | Ok(class) => format!("cannot reach Proxmox ({class})"),
        })?;
        if resp.status != 200 {
            return Err(format!("Proxmox answered {}", resp.status));
        }
        let raw = if resp.body.is_empty() { b"{}".to_vec() } else { resp.body };
        let data: Value = serde_json::from_slice(&raw).map_err(|_| "Proxmox did not answer JSON".to_string())?;
        Ok(data.as_object().and_then(|o| o.get("data").cloned()).unwrap_or(Value::Null))
    }

    fn status(&self, fresh: bool) -> Obj {
        {
            let c = self.cache.lock();
            if !fresh && c.0.is_some() && pj::mono() - c.1 < POWER_TTL {
                return c.0.clone().unwrap_or_default();
            }
        }
        let mut out = match self.call("GET", "status/current") {
            Ok(data) => {
                let d = data.as_object().cloned().unwrap_or_default();
                let uptime = pj::as_num(d.get("uptime")).filter(|u| *u > 0.0).map(|u| u.trunc() as i64).unwrap_or(0);
                let state = Some(pj::s(&d, "status")).filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
                obj([("state", Value::from(state)), ("uptime_s", Value::from(uptime)), ("window_ends", Value::Null), ("error", Value::from(""))])
            }
            Err(e) => obj([("state", Value::from("unknown")), ("uptime_s", Value::from(0)), ("window_ends", Value::Null), ("error", Value::from(e))]),
        };
        let uptime = pj::as_int(out.get("uptime_s")).unwrap_or(0);
        if pj::text_of(&out, "state") == "running" && uptime != 0 {
            out.insert("window_ends".into(), Value::from((pj::now() - uptime as f64 + self.window_hours * 3600.0) as i64));
        }
        *self.cache.lock() = (Some(out.clone()), pj::mono());
        out
    }

    fn start(&self) -> Result<bool, String> {
        let status = self.status(true);
        let error = pj::s(&status, "error");
        if !error.is_empty() {
            return Err(error);
        }
        if pj::text_of(&status, "state") == "running" {
            return Ok(false);
        }
        self.call("POST", "status/start")?;
        self.cache.lock().0 = None;
        log_info(&format!("download server start sent (VM {} on {})", self.vmid, self.node));
        Ok(true)
    }
}

// ── the console routes ───────────────────────────────────────────────────────────────────────────────────────

/// The relay-side views of the Meeting Hub section: the log ring, link performance and the download server's power.
pub struct Console {
    power: Option<FilesPower>,
    pub ring: Arc<LogRing>,
    pub links: Arc<LinkStats>,
    started: f64,
}

struct Presence {
    online: Vec<Value>,
    names: Obj,
    rooms: Vec<Value>,
}

/// AC-2a 9.2: how often the participants are sampled into `call_minutes`.
pub const SAMPLE_SECONDS: u64 = 10;

/// AC-2a 9.2: one participant sample (the people in rooms now, never the console), handed to the metrics counters.
/// The number sampled.
pub fn sample_participants(relay: &Relay) -> u64 {
    let n = relay.hub.fleet_counts().participants as u64;
    crate::fleet_probe::counters().participants_sample(n);
    n
}

/// AC-2a 9.2: the participant sampler, every SAMPLE_SECONDS for as long as the relay lives.
pub fn start_sampler(relay: std::sync::Weak<Relay>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("meet-participants".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(SAMPLE_SECONDS));
            let Some(r) = relay.upgrade() else { return };
            sample_participants(&r);
        })
        .map(|_| ())
        .map_err(|e| format!("the participant sampler did not start: {e}"))
}

/// AC-2a 9.1: the Meeting Hub product values of the metrics snapshot (fleet_probe merges the OS readings and the
/// interval counters). A key this relay cannot measure is null.
pub fn fleet_metrics(relay: &Relay) -> serde_json::Map<String, Value> {
    use crate::license::{license_state, LicenseStateName, Product};
    let c = relay.hub.fleet_counts();
    let gate = relay.hub.gate();
    let now = pj::now() as i64;
    let lic = gate.as_ref().and_then(|g| g.license()).map(|(l, _)| l);
    let state = lic.as_ref().map(|l| (l.product(), license_state(l, now)));
    let code = match state {
        None => 0,
        Some((p, _)) if p != Product::Meet => 4,
        Some((_, (LicenseStateName::Valid, _))) => 1,
        Some((_, (LicenseStateName::Grace, _))) => 2,
        Some(_) => 3,
    };
    let seats = gate.as_ref().map(|g| g.seat_counts());
    let service = gate.as_ref().map(|g| g.service_view().state.code());
    let signer_days = Console::signer_headline(relay).get("days_left").and_then(Value::as_i64);
    let mut m = serde_json::Map::new();
    m.insert("people_online".into(), Value::from(c.online.len()));
    m.insert("devices_online".into(), Value::from(c.devices_online));
    m.insert("calls_active".into(), Value::from(c.calls_active));
    m.insert("participants".into(), Value::from(c.participants));
    m.insert("seats_used".into(), seats.map_or(Value::Null, |s| Value::from(s.0)));
    m.insert("seats_total".into(), seats.map_or(Value::Null, |s| Value::from(s.1)));
    m.insert("license_state".into(), Value::from(code));
    m.insert("license_days".into(), state.map_or(Value::Null, |(_, (_, d))| Value::from(d)));
    m.insert("license_service".into(), service.map_or(Value::Null, Value::from));
    m.insert("cert_signer_days".into(), signer_days.map_or(Value::Null, Value::from));
    m
}

impl Console {
    pub fn new(settings: &Settings, links: Arc<LinkStats>) -> Result<Console, String> {
        let power = if settings.files_power.is_empty() { None } else { Some(FilesPower::new(&settings.files_power)?) };
        Ok(Console { power, ring: Arc::new(LogRing::new()), links, started: pj::now() })
    }

    /// Whether `files_power` is set (the Servers page shows `files: null` otherwise).
    pub fn has_power(&self) -> bool {
        self.power.is_some()
    }

    fn presence(relay: &Relay) -> Presence {
        let st = relay.hub.st.lock();
        let online = st.online();
        let mut rooms: std::collections::BTreeMap<String, Vec<Obj>> = std::collections::BTreeMap::new();
        for p in st.peers.values() {
            if p.who.is_console() {
                continue;
            }
            rooms.entry(p.room.clone()).or_default().push(obj([("principal", Value::from(p.who.principal.clone())), ("name", Value::from(p.who.name.clone())), ("since", f(p.joined)), ("recording", Value::Bool(p.recording))]));
        }
        let mut names: Obj = st.directory.iter().filter(|(_, v)| v.is_object()).map(|(k, v)| (k.clone(), Value::from(v.as_object().map(|o| pj::s(o, "name")).unwrap_or_default()))).collect();
        drop(st);
        for (k, e) in &online {
            names.insert(k.clone(), e.get("name").cloned().unwrap_or(Value::Null));
        }
        let mut people: Vec<Obj> = online
            .values()
            .map(|e| {
                let devices: Vec<Value> = e
                    .get("devices")
                    .and_then(Value::as_array)
                    .map(|d| d.iter().filter_map(Value::as_object).map(|d| Value::Object(obj([("label", d.get("label").cloned().unwrap_or(Value::Null)), ("room", d.get("room").cloned().unwrap_or(Value::Null))]))).collect())
                    .unwrap_or_default();
                obj([
                    ("principal", e.get("principal").cloned().unwrap_or(Value::Null)),
                    ("name", e.get("name").cloned().unwrap_or(Value::Null)),
                    ("room", e.get("room").cloned().unwrap_or(Value::Null)),
                    ("since", e.get("since").cloned().unwrap_or(Value::Null)),
                    ("devices", Value::Array(devices)),
                ])
            })
            .collect();
        people.sort_by_key(|p| pj::s(p, "name").to_lowercase());
        let rooms = rooms
            .into_iter()
            .map(|(r, mut ps)| {
                ps.sort_by(|a, b| pj::num(a, "since").partial_cmp(&pj::num(b, "since")).unwrap_or(std::cmp::Ordering::Equal));
                Value::Object(obj([("room", Value::from(r)), ("participants", Value::Array(ps.into_iter().map(Value::Object).collect()))]))
            })
            .collect();
        Presence { online: people.into_iter().map(Value::Object).collect(), names, rooms }
    }

    pub(crate) fn signer_headline(relay: &Relay) -> Obj {
        let Some(signer) = &relay.hub.signer else {
            return obj([("configured", Value::Bool(false)), ("healthy", Value::Bool(false)), ("days_left", Value::Null), ("error", Value::from(""))]);
        };
        let healthy = signer.ready();
        let snap = signer.snapshot().unwrap_or_default();
        let error = if healthy {
            String::new()
        } else {
            Some(signer.error()).filter(|e| !e.is_empty()).unwrap_or_else(|| pj::s(&snap, "error"))
        };
        obj([("configured", Value::Bool(true)), ("healthy", Value::Bool(healthy)), ("days_left", snap.get("days_left").cloned().unwrap_or(Value::Null)), ("error", Value::from(error))])
    }

    pub(crate) fn signer_detail(relay: &Relay) -> Obj {
        let mut out = obj([
            ("configured", Value::Bool(relay.hub.signer.is_some())),
            ("healthy", Value::Bool(false)),
            ("crl_check", Value::from(relay.crl_check())),
            ("crls", Value::Array(relay.crl_info().into_iter().map(Value::Object).collect())),
            ("alerts", Value::Array(relay.hub.alerts().into_iter().map(Value::Object).collect())),
        ]);
        let Some(signer) = &relay.hub.signer else { return out };
        let status = match signer.refresh() {
            Ok(s) => s,
            Err(e) => {
                out.insert("error".into(), Value::from(e));
                return out;
            }
        };
        for k in SIGNER_FIELDS {
            if let Some(v) = status.get(k) {
                out.insert(k.into(), v.clone());
            }
        }
        if let Some(seq) = pj::as_int(status.get("ledger_seq")).filter(|s| *s > 0) {
            match signer.call("ledger", &obj([("since", Value::from((seq - LEDGER_RECENT).max(0)))])) {
                Ok(page) => {
                    let entries: Vec<Value> = page
                        .get("entries")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_object).map(|e| Value::Object(LEDGER_FIELDS.iter().filter_map(|k| e.get(*k).map(|v| (k.to_string(), v.clone()))).collect())).collect())
                        .unwrap_or_default();
                    out.insert("ledger".into(), Value::Array(entries));
                }
                Err(crate::meet_tls::SignerErr::Down(e)) => {
                    out.insert("ledger_error".into(), Value::from(e));
                }
                Err(crate::meet_tls::SignerErr::Refused(e)) => {
                    out.insert("ledger_error".into(), Value::from(e.message()));
                }
            }
        }
        out
    }

    pub(crate) fn files(&self) -> Obj {
        let Some(power) = &self.power else {
            return obj([("configured", Value::Bool(false)), ("state", Value::from("unknown")), ("hint", Value::from(POWER_HINT))]);
        };
        let mut out = power.status(false);
        out.insert("configured".into(), Value::Bool(true));
        out.insert("vmid".into(), Value::from(power.vmid));
        out.insert("node".into(), Value::from(power.node.clone()));
        out.insert("window_estimate".into(), Value::Bool(true));
        out
    }

    fn release(relay: &Relay) -> Value {
        let m = relay.release();
        if m.is_empty() { Value::Null } else { Value::Object(m) }
    }

    /// The calls summary (Admin Console `GET /console/api/meet/calls`).
    pub fn summary(&self, relay: &Relay) -> Obj {
        let pres = Self::presence(relay);
        let release = Self::release(relay);
        let devices: usize = pres.online.iter().map(|p| p.get("devices").and_then(Value::as_array).map(|d| d.len()).unwrap_or(0)).sum();
        let participants: usize = pres.rooms.iter().map(|r| r.get("participants").and_then(Value::as_array).map(|p| p.len()).unwrap_or(0)).sum();
        let now = pj::now();
        obj([
            ("relay", Value::Object(obj([("version", Value::from(SERVER_VERSION)), ("started", Value::from(self.started as i64)), ("uptime_s", Value::from((now - self.started) as i64))]))),
            ("people_online", Value::from(pres.online.len())),
            ("devices_online", Value::from(devices)),
            ("online", Value::Array(pres.online)),
            ("rooms", Value::Array(pres.rooms)),
            ("participants", Value::from(participants)),
            ("signer", Value::Object(Self::signer_headline(relay))),
            ("files", Value::Object(self.files())),
            (
                "release",
                match release.as_object() {
                    Some(r) => Value::Object(obj([("version", Value::from(pj::s(r, "version"))), ("published", Value::from(pj::s(r, "published")))])),
                    None => Value::Null,
                },
            ),
        ])
    }

    /// Per-link performance, optionally for one room.
    pub fn links_view(&self, relay: &Relay, room: &str) -> Obj {
        let room = room.trim().to_lowercase();
        let pres = Self::presence(relay);
        let mut here: HashSet<(String, String)> = HashSet::new();
        for r in &pres.rooms {
            let name = r.get("room").and_then(Value::as_str).unwrap_or_default();
            for p in r.get("participants").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or_default() {
                here.insert((name.to_string(), p.get("principal").and_then(Value::as_str).unwrap_or_default().to_string()));
            }
        }
        let rows: Vec<Value> = self
            .links
            .snapshot(&room)
            .into_iter()
            .map(|mut row| {
                let principal = pj::s(&row, "principal");
                let name = pres.names.get(&principal).filter(|n| pj::truthy(Some(*n))).cloned().unwrap_or(Value::from(principal.clone()));
                let live = here.contains(&(pj::s(&row, "room"), principal));
                row.insert("name".into(), name);
                row.insert("live".into(), Value::Bool(live));
                Value::Object(row)
            })
            .collect();
        obj([("window_s", Value::from(LINK_WINDOW as i64)), ("rows", Value::Array(rows)), ("rooms", Value::Array(pres.rooms))])
    }

    /// The Admin Console's "Start the download server": Ok(true) when the start was sent, Ok(false) when it already
    /// runs, Err when `files_power` is not set or Proxmox refused.
    pub fn start_files_now(&self) -> Result<bool, String> {
        let Some(power) = &self.power else { return Err("files_power is not set on this relay".into()) };
        power.start()
    }

    /// For the update-link route: true when the download server runs or was asked to start. Never fails.
    pub fn start_files(&self) -> bool {
        let Some(power) = &self.power else { return false };
        match power.start() {
            Ok(_) => true,
            Err(e) => {
                log_warn(&format!("download server start failed: {e}"));
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn log_lines_hide_sessions_and_tokens() {
        assert_eq!(clean_line("hello principal=a session=abc123 x"), "hello principal=a session=[hidden] x");
        assert_eq!(clean_line("url https://f/d/abc.def-1 done"), "url https://f/d/[hidden] done");
        assert_eq!(clean_line("mysession=abc"), "mysession=abc");
    }

    #[test]
    fn ring_lines_for_the_admin_console_hide_secrets() {
        let ring = LogRing::new();
        ring.emit(1.0, Level::Info, "hello session=abc123 token=zz");
        ring.emit(2.0, Level::Warning, "warn one");
        let lines = ring.json_lines(Level::Warning as i64);
        assert_eq!(lines.len(), 1);
        let all = ring.json_lines(Level::Info as i64);
        assert_eq!(all.len(), 2);
        let first: Value = serde_json::from_str(&all[1]).unwrap();
        assert_eq!(first["text"], json!("hello session=[hidden] token=[hidden]"));
        assert_eq!(first["event"], json!("hello"));
        assert!(!all.iter().any(|l| l.contains("abc123")));
    }

    #[test]
    fn link_rows_keep_the_last_report() {
        let s = LinkStats::new();
        s.record("ops", "ann@x", json!({"level": "full", "reason": "ok now", "stats": {"rtt_ms": 20}, "relay_rtt_ms": 30, "path": "relay"}).as_object().unwrap());
        let rows = s.snapshot("");
        assert_eq!(rows[0]["reason"], json!("ok_now"));
        assert_eq!(rows[0]["path"], json!("relay"));
        assert_eq!(rows[0]["rtt"]["avg"], json!(20.0));
    }
}
