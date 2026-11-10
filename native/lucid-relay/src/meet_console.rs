// Phase C (ADR-0534): the Meet relay's side of the browser console (relay/meet_console.py): the /v1/console/* routes
// for the console server's certificate from `console_sources` only, the in-memory log ring (session ids and download
// tokens hidden), per-link performance from link reports and `state` signals, and the download server's power through
// the Proxmox API (`files_power`).

use crate::meet::{bad, forbidden, log_info, log_warn, Identity, Level, Relay, Settings, R, SERVER_VERSION};
use crate::meet_json::{self as pj, f, obj, Obj};
use crate::meet_tls::{client_config, https_request};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::Arc;

pub const DEFAULT_SOURCES: [&str; 5] = ["192.168.0.0/16", "10.42.42.0/24", "10.99.0.0/27", "10.0.0.0/24", "192.168.3.0/24"];
const REFUSED: &str = "The console is only available on the home network or the VPN.";
const MOVED: &str = "The console moved to https://console.emertins.com.";
const CONSOLE_PRINCIPAL: &str = "console@meet.emertins.com";
const LOG_KEEP: usize = 2000;
const LOG_LINE_MAX: usize = 400;
const LOG_PAGE: usize = 500;
const QUERY_MAX: usize = 100;
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

// ── sources ──────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct Network {
    v4: bool,
    addr: u128,
    prefix: u32,
}

fn bits(ip: IpAddr) -> (bool, u128) {
    match ip {
        IpAddr::V4(v) => (true, u32::from(v) as u128),
        IpAddr::V6(v) => (false, u128::from(v)),
    }
}

impl Network {
    fn contains(&self, ip: IpAddr) -> bool {
        let (v4, a) = bits(ip);
        let width = if v4 { 32 } else { 128 };
        if v4 != self.v4 {
            return false;
        }
        if self.prefix == 0 {
            return true;
        }
        let shift = width - self.prefix;
        (a >> shift) == (self.addr >> shift)
    }
}

/// parse_sources: `console_sources` as networks (host bits ignored, as ip_network(strict=False)).
fn parse_sources(values: &[String]) -> Result<Vec<Network>, String> {
    values
        .iter()
        .map(|value| {
            let t = value.trim();
            let (addr, prefix) = match t.split_once('/') {
                Some((a, p)) => (a, Some(p)),
                None => (t, None),
            };
            let err = || format!("console_sources: '{value}' is not an address range");
            let ip: IpAddr = addr.parse().map_err(|_| err())?;
            let (v4, a) = bits(ip);
            let width = if v4 { 32 } else { 128 };
            let prefix = match prefix {
                Some(p) => p.parse::<u32>().ok().filter(|p| *p <= width).ok_or_else(err)?,
                None => width,
            };
            Ok(Network { v4, addr: a, prefix })
        })
        .collect()
}

/// source_allowed: the TCP peer is inside one of the networks; an IPv4-mapped address counts as its IPv4.
fn source_allowed(address: &str, networks: &[Network]) -> bool {
    let Ok(ip) = address.split('%').next().unwrap_or_default().parse::<IpAddr>() else { return false };
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    networks.iter().any(|n| n.contains(ip))
}

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

    fn read(&self, since: i64, level: &str, query: &str) -> Obj {
        let floor = match level {
            "warning" => 30,
            "error" => 40,
            _ => 20,
        };
        let query = pj::clip(&pj::squash(query).to_lowercase(), QUERY_MAX);
        let g = self.mu.lock();
        let rows: Vec<Value> = g
            .0
            .iter()
            .filter(|r| r.seq > since && r.levelno >= floor && (query.is_empty() || r.text.to_lowercase().contains(&query)))
            .map(|r| Value::Object(obj([("seq", Value::from(r.seq)), ("ts", f(r.ts)), ("level", Value::from(r.level)), ("text", Value::from(r.text.clone()))])))
            .collect();
        let cut = rows.len().saturating_sub(LOG_PAGE);
        obj([("lines", Value::Array(rows[cut..].to_vec())), ("last", Value::from(g.1)), ("kept", Value::from(g.0.len()))])
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
        out.sort_by(|a, b| (pj::s(a, "room"), pj::s(a, "principal")).cmp(&(pj::s(b, "room"), pj::s(b, "principal"))));
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

pub struct Console {
    sources: Vec<Network>,
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

impl Console {
    pub fn new(settings: &Settings, links: Arc<LinkStats>) -> Result<Console, String> {
        let sources = parse_sources(&settings.console_sources)?;
        let power = if settings.files_power.is_empty() { None } else { Some(FilesPower::new(&settings.files_power)?) };
        Ok(Console { sources, power, ring: Arc::new(LogRing::new()), links, started: pj::now() })
    }

    /// The source gate: 403 unless the TCP peer is allowed.
    pub fn gate(&self, address: &str) -> R<()> {
        if !source_allowed(address, &self.sources) {
            log_info(&format!("console refused from {address}"));
            return forbidden(REFUSED);
        }
        Ok(())
    }

    /// The caller gate: 403 unless the console server's certificate.
    pub fn service(&self, who: &Identity) -> R<()> {
        if !who.console {
            log_info(&format!("console refused for principal={}", who.principal));
            return forbidden(MOVED);
        }
        Ok(())
    }

    fn presence(relay: &Relay) -> Presence {
        let st = relay.hub.st.lock();
        let online = st.online();
        let mut rooms: std::collections::BTreeMap<String, Vec<Obj>> = std::collections::BTreeMap::new();
        for p in st.peers.values() {
            if p.who.console {
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

    fn signer_headline(relay: &Relay) -> Obj {
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

    fn signer_detail(relay: &Relay) -> Obj {
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

    fn files(&self) -> Obj {
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

    /// GET /v1/console/summary.
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

    /// GET /v1/console/links?room=.
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

    /// GET /v1/console/directory: everyone the relay knows, never the console server itself.
    pub fn directory(&self, relay: &Relay) -> Obj {
        let now = pj::now();
        let (online, known) = {
            let st = relay.hub.st.lock();
            (st.online(), st.directory.clone())
        };
        let mut people: Vec<Obj> = known
            .iter()
            .filter_map(|(p, e)| e.as_object().map(|e| (p, e)))
            .filter(|(p, _)| p.as_str() != CONSOLE_PRINCIPAL)
            .map(|(p, e)| {
                let name = Some(pj::s(e, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| p.clone());
                let devices = e.get("devices").and_then(Value::as_object).map(|d| d.len()).unwrap_or(0);
                let last = if online.contains_key(p) { now } else { pj::as_num(e.get("last_seen")).unwrap_or(0.0) };
                obj([("principal", Value::from(p.clone())), ("name", Value::from(name)), ("devices", Value::from(devices)), ("last_seen", f(last))])
            })
            .collect();
        people.sort_by(|a, b| (pj::s(a, "name").to_lowercase(), pj::s(a, "principal")).cmp(&(pj::s(b, "name").to_lowercase(), pj::s(b, "principal"))));
        obj([("people", Value::Array(people.into_iter().map(Value::Object).collect()))])
    }

    /// GET /v1/console/logs?since=&level=&q=.
    pub fn logs(&self, since: &str, level: &str, query: &str) -> R<Obj> {
        let since = if since.is_empty() { 0 } else { crate::meet::py_int(since).map_err(|_| crate::meet::E::Bad("since must be a line number".into()))?.max(0) };
        let level = Some(level.trim().to_lowercase()).filter(|l| !l.is_empty()).unwrap_or_else(|| "info".into());
        if !["info", "warning", "error"].contains(&level.as_str()) {
            return bad("level must be info, warning or error");
        }
        Ok(self.ring.read(since, &level, query))
    }

    /// GET /v1/console/servers.
    pub fn servers(&self, relay: &Relay) -> Obj {
        obj([("signer", Value::Object(Self::signer_detail(relay))), ("files", Value::Object(self.files())), ("release", Self::release(relay))])
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
    fn sources_match_networks() {
        let nets = parse_sources(&["127.0.0.2/32".to_string(), "10.0.0.5/24".to_string()]).unwrap();
        assert!(source_allowed("127.0.0.2", &nets));
        assert!(!source_allowed("127.0.0.1", &nets));
        assert!(source_allowed("::ffff:10.0.0.9", &nets));
        assert_eq!(parse_sources(&["x".to_string()]).unwrap_err(), "console_sources: 'x' is not an address range");
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
