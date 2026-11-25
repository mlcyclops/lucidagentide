// Health metrics on the console (contract AC-2a 9.1 and 9.3 to 9.5, interface F8): the metric list, the validation of
// each relay's `metrics` snapshot, the append-only JSON lines under `<state>/metrics/<relayId>/` with their 5-minute and
// hourly rollups, retention, the hard byte budget with its free-space reserve (A1-M6), and the chart query.
//
// Files (owner-only, UTC dates): `raw-<YYYYMMDD>.jsonl` one line per accepted snapshot `{"t", "s", "m"}`;
// `m5-<YYYYMMDD>.jsonl` and `h1-<YYYYMM>.jsonl` one line per closed bucket `{"t": start, "n": snapshots, "m": {key:
// [min, mean, max, sum, last]}}`, both computed from the bucket's raw snapshots over non-null values, keys null or absent
// in every snapshot left out. Lines are compact JSON, `m` keys in 9.1 order, a number with no fractional part written as
// an integer, else as the shortest round-trip decimal. Nulls are not written in raw lines.
//
// Writes never block the channel: `Metrics::receive` validates under a short lock and hands the line to a writer thread
// through a bounded queue of 1,000; the writer appends, closes buckets (by arrival, or 2 minutes after their end), syncs
// once a minute, prunes once an hour, and keeps the byte budget. No relay string is stored: series are keyed by the
// console's own relay id.

use crate::codec::{exact_keys, safe_int};
use crate::console::ApiError;
use crate::license::Product;
use crate::log::{Fields, Level, Logger};
use crate::meet_json::{civil, days_from_civil};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

// ── 9.1 The metric list ─────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// The value at the snapshot.
    Now,
    /// What happened in the snapshot's 60 s.
    Interval,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Products {
    Both,
    Spokes,
    Meet,
}

/// How a fleet series combines relays (9.5): counts and interval metrics summed, percentages averaged,
/// `latency_console` the maximum; `cert_*`, `crl_days`, `license_days` never (nor the codes `license_state` and
/// `license_service`, which are neither counts nor percentages).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Aggregate {
    Sum,
    Mean,
    Max,
    Never,
}

/// The Prometheus family type (10.1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PromType {
    Gauge,
    Counter,
    Stateset,
}

/// One 9.1 key.
#[derive(Debug)]
pub struct Key {
    pub key: &'static str,
    pub unit: &'static str,
    pub kind: Kind,
    pub products: Products,
    pub min: f64,
    pub max: f64,
    /// A count: the value must be an integer.
    pub integer: bool,
    pub aggregate: Aggregate,
    /// The Prometheus family (10.1).
    pub family: &'static str,
    pub prom: PromType,
    /// Divisor from the 9.1 unit to the family's base unit (1000: ms to seconds for latency).
    pub divide: f64,
}

impl Key {
    pub fn of(&self, product: Product) -> bool {
        match self.products {
            Products::Both => true,
            Products::Spokes => product == Product::Spokes,
            Products::Meet => product == Product::Meet,
        }
    }
}

const P50: f64 = 1_125_899_906_842_624.0; // 2^50

#[allow(clippy::too_many_arguments)]
const fn k(key: &'static str, unit: &'static str, kind: Kind, products: Products, min: f64, max: f64, integer: bool, aggregate: Aggregate, family: &'static str, prom: PromType, divide: f64) -> Key {
    Key { key, unit, kind, products, min, max, integer, aggregate, family, prom, divide }
}

use Aggregate::{Max as AMax, Mean as AMean, Never as ANever, Sum as ASum};
use Kind::{Interval as I, Now as N};
use Products::{Both as B, Meet as M, Spokes as S};
use PromType::{Counter as C, Gauge as G, Stateset as SS};

/// The 9.1 list, in its order (the order of every `m` written and of the exposition).
pub static KEYS: [Key; 31] = [
    k("people_online", "people", N, B, 0.0, 100_000.0, true, ASum, "lucid_relay_people_online", G, 1.0),
    k("devices_online", "devices", N, M, 0.0, 1_000_000.0, true, ASum, "lucid_relay_devices_online", G, 1.0),
    k("calls_active", "calls", N, M, 0.0, 100_000.0, true, ASum, "lucid_relay_calls_active", G, 1.0),
    k("participants", "people", N, M, 0.0, 100_000.0, true, ASum, "lucid_relay_participants", G, 1.0),
    k("call_minutes", "minutes", I, M, 0.0, 6_000_000.0, false, ASum, "lucid_relay_call_minutes_total", C, 1.0),
    k("messages", "messages", I, B, 0.0, 10_000_000.0, true, ASum, "lucid_relay_messages_total", C, 1.0),
    k("hubs_online", "hubs", N, S, 0.0, 100_000.0, true, ASum, "lucid_relay_hubs_online", G, 1.0),
    k("spokes_online", "spokes", N, S, 0.0, 100_000.0, true, ASum, "lucid_relay_spokes_online", G, 1.0),
    k("spokes_total", "spokes", N, S, 0.0, 100_000.0, true, ASum, "lucid_relay_spokes_total", G, 1.0),
    k("spokes_busy", "spokes", I, S, 0.0, 100_000.0, true, ASum, "lucid_relay_spokes_busy_total", C, 1.0),
    k("lanes_busy", "lanes", N, S, 0.0, 800_000.0, true, ASum, "lucid_relay_lanes_busy", G, 1.0),
    k("lanes_total", "lanes", N, S, 0.0, 800_000.0, true, ASum, "lucid_relay_lanes_total", G, 1.0),
    k("seats_used", "seats", N, B, 0.0, 100_000.0, true, ASum, "lucid_relay_seats_used", G, 1.0),
    k("seats_total", "seats", N, B, 0.0, 100_000.0, true, ASum, "lucid_relay_seats_total", G, 1.0),
    k("cpu_process", "percent", N, B, 0.0, 100.0, false, AMean, "lucid_relay_cpu_process_percent", G, 1.0),
    k("cpu_host", "percent", N, B, 0.0, 100.0, false, AMean, "lucid_relay_cpu_host_percent", G, 1.0),
    k("mem_process", "bytes", N, B, 0.0, P50, true, ASum, "lucid_relay_mem_process_bytes", G, 1.0),
    k("mem_host_used", "percent", N, B, 0.0, 100.0, false, AMean, "lucid_relay_mem_host_used_percent", G, 1.0),
    k("net_in", "bytes", I, B, 0.0, P50, true, ASum, "lucid_relay_network_receive_bytes_total", C, 1.0),
    k("net_out", "bytes", I, B, 0.0, P50, true, ASum, "lucid_relay_network_transmit_bytes_total", C, 1.0),
    k("conn_open", "connections", N, B, 0.0, 1_000_000.0, true, ASum, "lucid_relay_conn_open", G, 1.0),
    k("latency_console", "ms", N, B, 0.0, 60_000.0, false, AMax, "lucid_relay_latency_console_seconds", G, 1000.0),
    k("cert_tls_days", "days", N, B, -3_650.0, 3_650.0, true, ANever, "lucid_relay_cert_tls_days", G, 1.0),
    k("cert_console_days", "days", N, B, -3_650.0, 3_650.0, true, ANever, "lucid_relay_cert_console_days", G, 1.0),
    k("cert_mgmt_days", "days", N, B, -3_650.0, 3_650.0, true, ANever, "lucid_relay_cert_mgmt_days", G, 1.0),
    k("cert_signer_days", "days", N, M, -3_650.0, 3_650.0, true, ANever, "lucid_relay_cert_signer_days", G, 1.0),
    k("crl_days", "days", N, B, -3_650.0, 3_650.0, true, ANever, "lucid_relay_crl_days", G, 1.0),
    k("license_days", "days", N, B, -3_650.0, 3_650.0, true, ANever, "lucid_relay_license_days", G, 1.0),
    k("license_state", "code", N, B, 0.0, 4.0, true, ANever, "lucid_relay_license_state", SS, 1.0),
    k("license_service", "code", N, B, 0.0, 3.0, true, ANever, "lucid_relay_license_service", SS, 1.0),
    k("quota_hits", "refusals", I, B, 0.0, 10_000_000.0, true, ASum, "lucid_relay_quota_hits_total", C, 1.0),
];

/// The index of a 9.1 key.
pub fn key_index(name: &str) -> Option<usize> {
    KEYS.iter().position(|k| k.key == name)
}

// ── 9.3 Validation ──────────────────────────────────────────────────────────────────────────────────────────

/// Why a snapshot was refused (the vector's `why`), or dropped after it was accepted (`queue`, `space`, `file`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Why {
    /// Not the 9.3 envelope (keys, `interval`, `seq`, `ts`, `m`).
    Shape,
    Version,
    KeyUnknown,
    KeyOtherProduct,
    NotNumber,
    NotFinite,
    NotInteger,
    Bound,
    Seq,
    Rate,
    Queue,
    Space,
    File,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Shape => "shape",
            Why::Version => "version",
            Why::KeyUnknown => "key-unknown",
            Why::KeyOtherProduct => "key-other-product",
            Why::NotNumber => "not-number",
            Why::NotFinite => "not-finite",
            Why::NotInteger => "not-integer",
            Why::Bound => "bound",
            Why::Seq => "seq",
            Why::Rate => "rate",
            Why::Queue => "queue",
            Why::Space => "space",
            Why::File => "file",
        }
    }
}

/// The last accepted snapshot of a relay: its `seq` and the console's receive time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Last {
    pub seq: i64,
    pub t: i64,
}

/// An accepted snapshot: its non-null values by key index, in 9.1 order.
#[derive(Clone, Debug, PartialEq)]
pub struct Accepted {
    pub seq: i64,
    pub ts: i64,
    pub values: Vec<(usize, f64)>,
    /// The relay's clock differs from the console's by more than 300 s (`relay-clock`).
    pub clock_off: bool,
}

/// At most one snapshot per 50 s per relay (3.8).
pub const MIN_GAP_MS: i64 = 50_000;
pub const CLOCK_SKEW_MS: i64 = 300_000;
const ENVELOPE: [&str; 5] = ["v", "seq", "ts", "interval", "m"];

/// A frame body's text as a snapshot: JSON, where a literal `NaN` or `Infinity` (which JSON does not allow, and the
/// wire refuses) or a number too large for a double is `not-finite`, and anything else that does not parse `shape`.
#[cfg(test)]
pub fn parse_snapshot(text: &str) -> Result<Value, Why> {
    match crate::codec::parse_json(text) {
        Some(v) => Ok(v),
        None if text.contains("NaN") || text.contains("Infinity") || serde_json::from_str::<Value>(text).err().is_some_and(|e| e.to_string().contains("out of range")) => Err(Why::NotFinite),
        None => Err(Why::Shape),
    }
}

/// 9.3: the whole snapshot is accepted or refused.
pub fn validate(body: &Value, product: Product, last: Option<&Last>, now: i64) -> Result<Accepted, Why> {
    let o = body.as_object().ok_or(Why::Shape)?;
    if o.get("v").and_then(Value::as_i64) != Some(1) || o.get("v").and_then(Value::as_f64) != Some(1.0) {
        return Err(Why::Version);
    }
    if !exact_keys(o, &ENVELOPE, &ENVELOPE) || o.get("interval").and_then(Value::as_f64) != Some(60.0) {
        return Err(Why::Shape);
    }
    let seq = safe_int(o.get("seq")).filter(|s| *s >= 1).ok_or(Why::Shape)?;
    let ts = safe_int(o.get("ts")).ok_or(Why::Shape)?;
    let m = o.get("m").and_then(Value::as_object).ok_or(Why::Shape)?;
    let mut idx = Vec::with_capacity(m.len());
    for name in m.keys() {
        let i = key_index(name).ok_or(Why::KeyUnknown)?;
        if !KEYS[i].of(product) {
            return Err(Why::KeyOtherProduct);
        }
        idx.push(i);
    }
    let mut values = Vec::with_capacity(m.len());
    for (v, i) in m.values().zip(idx) {
        let key = &KEYS[i];
        let x = match v {
            Value::Null => continue,
            Value::Number(n) => n.as_f64().ok_or(Why::NotNumber)?,
            _ => return Err(Why::NotNumber),
        };
        if !x.is_finite() {
            return Err(Why::NotFinite);
        }
        if key.integer && x.fract() != 0.0 {
            return Err(Why::NotInteger);
        }
        if x < key.min || x > key.max {
            return Err(Why::Bound);
        }
        values.push((i, x));
    }
    values.sort_by_key(|(i, _)| *i);
    if let Some(l) = last {
        if seq <= l.seq {
            return Err(Why::Seq);
        }
        if now - l.t < MIN_GAP_MS {
            return Err(Why::Rate);
        }
    }
    Ok(Accepted { seq, ts, values, clock_off: (ts - now).abs() > CLOCK_SKEW_MS })
}

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────────────────

const SAFE: f64 = 9_007_199_254_740_992.0;

/// A number as the lines write it: an integer when it has no fractional part, else the shortest round-trip decimal.
pub fn fmt_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < SAFE {
        format!("{}", x as i64)
    } else {
        serde_json::Number::from_f64(x).map_or_else(|| "null".into(), |n| n.to_string())
    }
}

/// `{"t":<ms>,"s":<seq>,"m":{...}}` with the non-null values in 9.1 order.
pub fn raw_line(t: i64, seq: i64, values: &[(usize, f64)]) -> String {
    let mut s = format!("{{\"t\":{t},\"s\":{seq},\"m\":{{");
    for (n, (i, x)) in values.iter().enumerate() {
        if n > 0 {
            s.push(',');
        }
        s.push_str(&format!("\"{}\":{}", KEYS[*i].key, fmt_num(*x)));
    }
    s.push_str("}}");
    s
}

#[derive(Clone, Copy, Debug)]
struct Stat {
    min: f64,
    max: f64,
    sum: f64,
    count: u64,
    last: f64,
}

/// One 5-minute or hourly bucket being filled.
#[derive(Clone, Debug)]
pub struct Bucket {
    pub start: i64,
    pub n: u64,
    stats: Vec<Option<Stat>>,
}

impl Bucket {
    pub fn new(start: i64) -> Bucket {
        Bucket { start, n: 0, stats: vec![None; KEYS.len()] }
    }

    pub fn add(&mut self, values: &[(usize, f64)]) {
        self.n += 1;
        for &(i, x) in values {
            let s = self.stats[i].get_or_insert(Stat { min: x, max: x, sum: 0.0, count: 0, last: x });
            s.min = s.min.min(x);
            s.max = s.max.max(x);
            s.sum += x;
            s.count += 1;
            s.last = x;
        }
    }

    /// `{"t":<start>,"n":<snapshots>,"m":{"<key>":[min,mean,max,sum,last]}}`.
    pub fn line(&self) -> String {
        let mut s = format!("{{\"t\":{},\"n\":{},\"m\":{{", self.start, self.n);
        let mut first = true;
        for (i, st) in self.stats.iter().enumerate() {
            let Some(st) = st else { continue };
            if !first {
                s.push(',');
            }
            first = false;
            let mean = st.sum / st.count as f64;
            s.push_str(&format!("\"{}\":[{},{},{},{},{}]", KEYS[i].key, fmt_num(st.min), fmt_num(mean), fmt_num(st.max), fmt_num(st.sum), fmt_num(st.last)));
        }
        s.push_str("}}");
        s
    }
}

// ── Files, dates and safety ─────────────────────────────────────────────────────────────────────────────────

pub const FIVE_MIN: i64 = 300_000;
pub const HOUR: i64 = 3_600_000;
pub const DAY: i64 = 86_400_000;
/// A bucket closes 2 minutes after its end when no later snapshot closed it first.
pub const CLOSE_GRACE: i64 = 120_000;
pub const RAW_KEEP: i64 = 48 * HOUR;
pub const M5_KEEP: i64 = 8 * DAY;
pub const H1_KEEP: i64 = 31 * DAY;
/// A removed or left relay's folder is deleted this long after it left.
pub const DEPARTED_KEEP: i64 = 31 * DAY;
/// The hard byte budget of everything under `metrics/`.
pub const BUDGET: u64 = 4 << 30;
/// The free-space reserve: the larger of 1 GiB and 10% of the volume.
pub const RESERVE_MIN: u64 = 1 << 30;
pub const QUEUE: usize = 1_000;
const PRUNE_EVERY: i64 = HOUR;
const RETRY_EVERY: i64 = 5 * 60_000;
const RETRY_HEADROOM: u64 = 64 * 1024;
const SYNC_EVERY: i64 = 60_000;
/// Snapshots kept in memory per relay (8.2 "for 10 minutes" checks; `/metrics`).
pub const RECENT: usize = 16;

fn ymd(ms: i64) -> (i64, u32, u32) {
    civil(ms.div_euclid(DAY))
}

fn day_name(ms: i64) -> String {
    let (y, m, d) = ymd(ms);
    format!("{y:04}{m:02}{d:02}")
}

fn month_name(ms: i64) -> String {
    let (y, m, _) = ymd(ms);
    format!("{y:04}{m:02}")
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum FileKind {
    Raw,
    M5,
    H1,
}

/// A metrics file name: its kind, its first ms and its end ms (exclusive).
fn parse_name(name: &str) -> Option<(FileKind, i64, i64)> {
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let day = |s: &str| -> Option<(i64, i64)> {
        if s.len() != 8 || !digits(s) {
            return None;
        }
        let (y, m, d): (i64, u32, u32) = (s[..4].parse().ok()?, s[4..6].parse().ok()?, s[6..].parse().ok()?);
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        let start = days_from_civil(y, m, d) * DAY;
        Some((start, start + DAY))
    };
    if let Some(s) = name.strip_prefix("raw-").and_then(|s| s.strip_suffix(".jsonl")) {
        let (a, b) = day(s)?;
        return Some((FileKind::Raw, a, b));
    }
    if let Some(s) = name.strip_prefix("m5-").and_then(|s| s.strip_suffix(".jsonl")) {
        let (a, b) = day(s)?;
        return Some((FileKind::M5, a, b));
    }
    let s = name.strip_prefix("h1-")?.strip_suffix(".jsonl")?;
    if s.len() != 6 || !digits(s) {
        return None;
    }
    let (y, m): (i64, u32) = (s[..4].parse().ok()?, s[4..].parse().ok()?);
    if !(1..=12).contains(&m) {
        return None;
    }
    let start = days_from_civil(y, m, 1) * DAY;
    let end = if m == 12 { days_from_civil(y + 1, 1, 1) } else { days_from_civil(y, m + 1, 1) } * DAY;
    Some((FileKind::H1, start, end))
}

/// When a file is past retention.
fn expires(kind: FileKind, end: i64) -> i64 {
    end + match kind {
        FileKind::Raw => RAW_KEEP,
        FileKind::M5 => M5_KEEP,
        FileKind::H1 => H1_KEEP,
    }
}

/// A console relay id: `r_` and 16 lower-case hex (2.4). Anything else never becomes a path.
pub fn relay_id_ok(id: &str) -> bool {
    id.len() == 18 && id.starts_with("r_") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(unix)]
extern "C" {
    fn geteuid() -> u32;
}

/// A regular file (not a link) owned by this process's identity.
fn file_ok(path: &Path, meta: &Metadata) -> bool {
    if !meta.file_type().is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        // SAFETY: geteuid takes nothing and cannot fail.
        meta.uid() == unsafe { geteuid() }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE: u32 = 0x400;
        meta.file_attributes() & REPARSE == 0 && win::owned(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        true
    }
}

/// Open a metrics file without following links: refused when the path is a link or not a regular file owned by us,
/// and when the handle opened is not the file the path names.
fn open_safe(path: &Path, append: bool) -> std::io::Result<File> {
    let bad = |why: &str| std::io::Error::new(std::io::ErrorKind::PermissionDenied, why.to_string());
    match fs::symlink_metadata(path) {
        Ok(m) if !file_ok(path, &m) => return Err(bad("not a regular file owned by the console")),
        Err(e) if !(append && e.kind() == std::io::ErrorKind::NotFound) => return Err(e),
        _ => {}
    }
    let mut o = OpenOptions::new();
    if append {
        o.append(true).create(true);
    } else {
        o.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: open a link itself, never its target.
        o.custom_flags(0x0020_0000);
    }
    let f = o.open(path)?;
    let hm = f.metadata()?;
    let pm = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if hm.dev() != pm.dev() || hm.ino() != pm.ino() {
            return Err(bad("the file changed while it was opened"));
        }
    }
    if !hm.file_type().is_file() || !file_ok(path, &pm) {
        return Err(bad("not a regular file owned by the console"));
    }
    Ok(f)
}

/// The volume and file operations the budget depends on (real, or a test double for full volumes and failing deletes).
pub trait FsOps: Send {
    /// (bytes available to us, volume size), or None when this OS cannot say.
    fn free_space(&self, dir: &Path) -> Option<(u64, u64)>;
    fn remove(&self, path: &Path) -> std::io::Result<()>;
}

pub struct RealFs;

impl FsOps for RealFs {
    fn free_space(&self, dir: &Path) -> Option<(u64, u64)> {
        free_space(dir)
    }

    fn remove(&self, path: &Path) -> std::io::Result<()> {
        fs::remove_file(path)
    }
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
fn free_space(dir: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    // struct statvfs on 64-bit Linux (glibc and musl): unsigned longs and 64-bit block counts; the tail is padded.
    #[repr(C)]
    struct StatVfs {
        bsize: u64,
        frsize: u64,
        blocks: u64,
        bfree: u64,
        bavail: u64,
        rest: [u64; 16],
    }
    extern "C" {
        fn statvfs(path: *const std::ffi::c_char, buf: *mut StatVfs) -> i32;
    }
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut s = StatVfs { bsize: 0, frsize: 0, blocks: 0, bfree: 0, bavail: 0, rest: [0; 16] };
    // SAFETY: `c` is a NUL-terminated path and `s` is larger than the C struct statvfs.
    if unsafe { statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = if s.frsize > 0 { s.frsize } else { s.bsize };
    Some((s.bavail.saturating_mul(unit), s.blocks.saturating_mul(unit)))
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<(u64, u64)> {
    win::free_space(dir)
}

#[cfg(not(any(windows, all(target_os = "linux", target_pointer_width = "64"))))]
fn free_space(_dir: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const SE_FILE_OBJECT: u32 = 1;
    const OWNER_SECURITY_INFORMATION: u32 = 1;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER: u32 = 1;
    const TOKEN_OWNER: u32 = 4;

    #[link(name = "advapi32")]
    extern "system" {
        fn GetNamedSecurityInfoW(name: *const u16, object_type: u32, info: u32, owner: *mut *mut c_void, group: *mut *mut c_void, dacl: *mut *mut c_void, sacl: *mut *mut c_void, sd: *mut *mut c_void) -> u32;
        fn EqualSid(a: *mut c_void, b: *mut c_void) -> i32;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// The file's owner is this process's user, or the token's default owner for new objects (an elevated
    /// administrator's files are owned by BUILTIN\Administrators).
    pub fn owned(path: &Path) -> bool {
        let w = wide(path);
        let (mut owner, mut sd) = (std::ptr::null_mut(), std::ptr::null_mut());
        let null = std::ptr::null_mut();
        // SAFETY: `w` is NUL-terminated; `owner` points into `sd`, which is freed with LocalFree below.
        let rc = unsafe { GetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &mut owner, null, null, null, &mut sd) };
        let ok = rc == 0 && !owner.is_null() && token_has(owner);
        if !sd.is_null() {
            // SAFETY: `sd` came from GetNamedSecurityInfoW and is freed once.
            unsafe { LocalFree(sd) };
        }
        ok
    }

    fn token_has(sid: *mut c_void) -> bool {
        let mut token: *mut c_void = std::ptr::null_mut();
        // SAFETY: a pseudo handle; `token` is closed below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return false;
        }
        let mut found = false;
        for class in [TOKEN_USER, TOKEN_OWNER] {
            let mut buf = [0u64; 128];
            let mut len = 0u32;
            // SAFETY: `buf` is writable for its size; TOKEN_USER and TOKEN_OWNER both start with a PSID into `buf`.
            let ok = unsafe { GetTokenInformation(token, class, buf.as_mut_ptr() as *mut c_void, std::mem::size_of_val(&buf) as u32, &mut len) };
            if ok != 0 {
                // SAFETY: as above; both SIDs are valid for the call.
                let mine = unsafe { *(buf.as_ptr() as *const *mut c_void) };
                if !mine.is_null() && unsafe { EqualSid(mine, sid) } != 0 {
                    found = true;
                    break;
                }
            }
        }
        // SAFETY: `token` came from OpenProcessToken and is closed once.
        unsafe { CloseHandle(token) };
        found
    }

    pub fn free_space(dir: &Path) -> Option<(u64, u64)> {
        let w = wide(dir);
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        // SAFETY: `w` is NUL-terminated and the out pointers are valid.
        (unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) } != 0).then_some((avail, total))
    }
}

/// The lines of a file, a torn last line (no newline) left out.
fn read_lines(path: &Path) -> Vec<String> {
    let Ok(mut f) = open_safe(path, false) else { return Vec::new() };
    let mut text = String::new();
    if f.read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    let whole = text.rfind('\n').map_or("", |i| &text[..i]);
    whole.lines().map(str::to_owned).collect()
}

fn line_values(m: &Map<String, Value>) -> Vec<(usize, f64)> {
    let mut v: Vec<(usize, f64)> = m.iter().filter_map(|(k, x)| Some((key_index(k)?, x.as_f64()?))).collect();
    v.sort_by_key(|(i, _)| *i);
    v
}

// ── 9.4 The store (the writer thread's own) ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Open {
    m5: Option<Bucket>,
    h1: Option<Bucket>,
}

/// The files under `metrics/`, the open buckets and the accounted bytes.
pub struct Store {
    root: PathBuf,
    budget: u64,
    accounted: u64,
    fs: Box<dyn FsOps>,
    logger: Option<Arc<Logger>>,
    open: HashMap<String, Open>,
    blocked: bool,
    last_retry: i64,
    last_prune: i64,
    last_sync: i64,
    dirty: HashSet<PathBuf>,
    /// Snapshots and rollups not written, by relay, for the hourly summary (`why: "space"` or `"file"`).
    drops: HashMap<String, BTreeMap<Why, u64>>,
    departed: Vec<(String, i64)>,
    skipped: HashSet<PathBuf>,
}

impl Store {
    /// Open `root` (`<state>/metrics`): count every byte under it, cut torn last lines, and rebuild the open buckets of
    /// each relay from its raw lines (closing those whose time has passed).
    pub fn open(root: PathBuf, budget: u64, fs_ops: Box<dyn FsOps>, logger: Option<Arc<Logger>>, now: i64) -> Store {
        let _ = crate::store::make_dir(&root);
        let mut s = Store {
            root,
            budget,
            accounted: 0,
            fs: fs_ops,
            logger,
            open: HashMap::new(),
            blocked: false,
            last_retry: now,
            last_prune: i64::MIN,
            last_sync: now,
            dirty: HashSet::new(),
            drops: HashMap::new(),
            departed: Vec::new(),
            skipped: HashSet::new(),
        };
        s.accounted = s.walk();
        for relay in s.relay_dirs() {
            s.cut_torn(&relay);
            s.rebuild(&relay, now);
        }
        s.tick(now);
        s
    }

    #[cfg(test)]
    pub fn accounted(&self) -> u64 {
        self.accounted
    }

    /// Writes are stopped (budget or free-space reserve): Overview raises `metrics-space`.
    pub fn blocked(&self) -> bool {
        self.blocked
    }

    fn note(&self, event: &str, fields: Fields) {
        if let Some(l) = &self.logger {
            l.ops(event, &fields, Level::Warn);
        }
    }

    /// Every byte under the folder, links not followed (a link counts as nothing it points to).
    fn walk(&self) -> u64 {
        fn go(dir: &Path, total: &mut u64) {
            let Ok(rd) = fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
                if m.file_type().is_dir() {
                    go(&e.path(), total);
                } else if m.file_type().is_file() {
                    *total = total.saturating_add(m.len());
                }
            }
        }
        let mut total = 0;
        go(&self.root, &mut total);
        total
    }

    fn relay_dirs(&self) -> Vec<String> {
        let Ok(rd) = fs::read_dir(&self.root) else { return Vec::new() };
        let mut v: Vec<String> = rd
            .flatten()
            .filter(|e| fs::symlink_metadata(e.path()).is_ok_and(|m| m.file_type().is_dir()))
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|n| relay_id_ok(n))
            .collect();
        v.sort();
        v
    }

    /// The metrics files of a relay: (kind, start, end, path), sorted by start.
    fn files(&self, relay: &str) -> Vec<(FileKind, i64, i64, PathBuf)> {
        let dir = self.root.join(relay);
        let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
        let mut v: Vec<_> = rd.flatten().filter_map(|e| {
            let name = e.file_name().to_str()?.to_owned();
            let (kind, a, b) = parse_name(&name)?;
            Some((kind, a, b, dir.join(name)))
        }).collect();
        v.sort_by_key(|(k, a, _, _)| (*a, *k));
        v
    }

    /// A torn last line (no newline) is cut at start.
    fn cut_torn(&mut self, relay: &str) {
        for (_, _, _, path) in self.files(relay) {
            let Ok(mut f) = open_safe(&path, false) else { continue };
            let mut bytes = Vec::new();
            if f.read_to_end(&mut bytes).is_err() || bytes.is_empty() || bytes.ends_with(b"\n") {
                continue;
            }
            let keep = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1) as u64;
            drop(f);
            if let Ok(f) = OpenOptions::new().write(true).open(&path) {
                if f.set_len(keep).is_ok() {
                    self.accounted = self.accounted.saturating_sub(bytes.len() as u64 - keep);
                }
            }
        }
    }

    fn last_written(&self, relay: &str, kind: FileKind) -> i64 {
        self.files(relay)
            .iter()
            .rev()
            .filter(|f| f.0 == kind)
            .find_map(|f| read_lines(&f.3).iter().rev().find_map(|l| crate::codec::parse_json(l).and_then(|v| v["t"].as_i64())))
            .unwrap_or(i64::MIN)
    }

    /// Rebuild the buckets not yet written from the raw lines; every one but the newest of each kind is closed now,
    /// the newest stays open (and `tick` closes it when its time has passed).
    fn rebuild(&mut self, relay: &str, now: i64) {
        let (w5, w1) = (self.last_written(relay, FileKind::M5), self.last_written(relay, FileKind::H1));
        let from = now - 2 * HOUR;
        let mut b5: BTreeMap<i64, Bucket> = BTreeMap::new();
        let mut b1: BTreeMap<i64, Bucket> = BTreeMap::new();
        for (_, _, _, path) in self.files(relay).into_iter().filter(|f| f.0 == FileKind::Raw && f.2 > from) {
            for line in read_lines(&path) {
                let Some(v) = crate::codec::parse_json(&line) else { continue };
                let (Some(t), Some(m)) = (v["t"].as_i64(), v["m"].as_object()) else { continue };
                let values = line_values(m);
                let (s5, s1) = (t - t.rem_euclid(FIVE_MIN), t - t.rem_euclid(HOUR));
                if s5 > w5 {
                    b5.entry(s5).or_insert_with(|| Bucket::new(s5)).add(&values);
                }
                if s1 > w1 {
                    b1.entry(s1).or_insert_with(|| Bucket::new(s1)).add(&values);
                }
            }
        }
        let newest5 = b5.pop_last().map(|(_, b)| b);
        let newest1 = b1.pop_last().map(|(_, b)| b);
        for b in b5.into_values() {
            self.write_bucket(relay, FileKind::M5, &b, now);
        }
        for b in b1.into_values() {
            self.write_bucket(relay, FileKind::H1, &b, now);
        }
        let o = self.open.entry(relay.to_owned()).or_default();
        o.m5 = newest5;
        o.h1 = newest1;
    }

    fn drop_count(&mut self, relay: &str, why: Why) {
        *self.drops.entry(relay.to_owned()).or_default().entry(why).or_default() += 1;
    }

    /// Writes a line only when the budget and the free-space reserve allow it: the bytes are reserved first, pruning
    /// makes room when it can, and the write does not happen when it cannot.
    fn write_line(&mut self, relay: &str, name: &str, line: &str, now: i64) -> Result<(), Why> {
        if self.blocked {
            return Err(Why::Space);
        }
        let need = line.len() as u64 + 1;
        if !self.reserve_ok() {
            self.block("reserve", now);
            return Err(Why::Space);
        }
        if self.accounted.saturating_add(need) > self.budget {
            self.prune_for_space(need, now);
            if self.accounted.saturating_add(need) > self.budget {
                self.block("budget", now);
                return Err(Why::Space);
            }
        }
        let dir = self.root.join(relay);
        if crate::store::make_dir(&dir).is_err() {
            return Err(Why::File);
        }
        let path = dir.join(name);
        self.accounted += need;
        let mut f = match open_safe(&path, true) {
            Ok(f) => f,
            Err(e) => {
                self.accounted -= need;
                self.skip(&path, &e.to_string());
                return Err(Why::File);
            }
        };
        let mut bytes = Vec::with_capacity(need as usize);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        // On a failed write the reservation stays: the bytes may be partly on disk, and the hourly walk recounts.
        if f.write_all(&bytes).and_then(|_| f.flush()).is_err() {
            return Err(Why::File);
        }
        self.dirty.insert(path);
        Ok(())
    }

    fn skip(&mut self, path: &Path, why: &str) {
        if self.skipped.insert(path.to_path_buf()) {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
            self.note("fleet.metrics-file-skipped", Fields::new().with("file", name).with("why", why));
        }
    }

    fn reserve_ok(&self) -> bool {
        match self.fs.free_space(&self.root) {
            Some((avail, total)) => avail >= RESERVE_MIN.max(total / 10),
            None => true,
        }
    }

    fn block(&mut self, why: &str, now: i64) {
        if !self.blocked {
            self.blocked = true;
            self.last_retry = now;
            self.note("fleet.metrics-space", Fields::new().with("why", why).with("accounted", self.accounted).with("budget", self.budget));
        }
    }

    /// Delete a file only when it is a regular file of ours; a delete that fails frees nothing.
    fn remove_file(&mut self, path: &Path) -> bool {
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => return false,
        };
        if !file_ok(path, &meta) {
            self.skip(path, "not a regular file owned by the console");
            return false;
        }
        match self.fs.remove(path) {
            Ok(()) => {
                self.accounted = self.accounted.saturating_sub(meta.len());
                self.dirty.remove(path);
                true
            }
            Err(e) => {
                self.skip(path, &e.to_string());
                false
            }
        }
    }

    /// Make room for `need` bytes: the oldest raw files first, then 5-minute files, never an hourly file younger than
    /// 31 days.
    fn prune_for_space(&mut self, need: u64, now: i64) {
        let mut cands: Vec<(FileKind, i64, PathBuf)> = Vec::new();
        for relay in self.relay_dirs() {
            for (kind, start, end, path) in self.files(&relay) {
                if kind != FileKind::H1 || expires(kind, end) <= now {
                    cands.push((kind, start, path));
                }
            }
        }
        cands.sort();
        for (_, _, path) in cands {
            if self.accounted.saturating_add(need) <= self.budget {
                break;
            }
            self.remove_file(&path);
        }
    }

    /// Delete whole files past retention, and the folders of relays that left more than 31 days ago.
    fn prune(&mut self, now: i64) {
        for relay in self.relay_dirs() {
            for (kind, _, end, path) in self.files(&relay) {
                if expires(kind, end) <= now {
                    self.remove_file(&path);
                }
            }
        }
        let gone: Vec<String> = self.departed.iter().filter(|(_, at)| now - at >= DEPARTED_KEEP).map(|(id, _)| id.clone()).collect();
        for id in gone {
            let dir = self.root.join(&id);
            if let Ok(rd) = fs::read_dir(&dir) {
                for e in rd.flatten() {
                    self.remove_file(&e.path());
                }
            }
            let _ = fs::remove_dir(&dir);
            self.open.remove(&id);
        }
    }

    fn write_bucket(&mut self, relay: &str, kind: FileKind, b: &Bucket, now: i64) {
        let name = match kind {
            FileKind::M5 => format!("m5-{}.jsonl", day_name(b.start)),
            _ => format!("h1-{}.jsonl", month_name(b.start)),
        };
        if let Err(why) = self.write_line(relay, &name, &b.line(), now) {
            self.drop_count(relay, why);
        }
    }

    fn close_m5(&mut self, relay: &str, now: i64) {
        if let Some(b) = self.open.get_mut(relay).and_then(|o| o.m5.take()) {
            self.write_bucket(relay, FileKind::M5, &b, now);
        }
    }

    fn close_h1(&mut self, relay: &str, now: i64) {
        if let Some(b) = self.open.get_mut(relay).and_then(|o| o.h1.take()) {
            self.write_bucket(relay, FileKind::H1, &b, now);
        }
    }

    /// One accepted snapshot received at `t`: earlier buckets close by arrival, the raw line is written, and the open
    /// buckets take its values. Err when it could not be written (budget, reserve or file): it is dropped and counted.
    pub fn append(&mut self, relay: &str, t: i64, seq: i64, values: &[(usize, f64)], now: i64) -> Result<(), Why> {
        if !relay_id_ok(relay) {
            return Err(Why::File);
        }
        let (s5, s1) = (t - t.rem_euclid(FIVE_MIN), t - t.rem_euclid(HOUR));
        let o = self.open.entry(relay.to_owned()).or_default();
        let (c5, c1) = (o.m5.as_ref().is_some_and(|b| b.start != s5), o.h1.as_ref().is_some_and(|b| b.start != s1));
        if c5 {
            self.close_m5(relay, now);
        }
        if c1 {
            self.close_h1(relay, now);
        }
        if let Err(why) = self.write_line(relay, &format!("raw-{}.jsonl", day_name(t)), &raw_line(t, seq, values), now) {
            self.drop_count(relay, why);
            return Err(why);
        }
        let o = self.open.entry(relay.to_owned()).or_default();
        o.m5.get_or_insert_with(|| Bucket::new(s5)).add(values);
        o.h1.get_or_insert_with(|| Bucket::new(s1)).add(values);
        Ok(())
    }

    /// The timer: buckets close 2 minutes after their end; files sync once a minute; retention once an hour; while
    /// writes are stopped, pruning and the reserve are retried every 5 minutes.
    pub fn tick(&mut self, now: i64) {
        let due: Vec<(String, bool, bool)> = self
            .open
            .iter()
            .map(|(r, o)| (r.clone(), o.m5.as_ref().is_some_and(|b| now >= b.start + FIVE_MIN + CLOSE_GRACE), o.h1.as_ref().is_some_and(|b| now >= b.start + HOUR + CLOSE_GRACE)))
            .collect();
        for (relay, c5, c1) in due {
            if c5 {
                self.close_m5(&relay, now);
            }
            if c1 {
                self.close_h1(&relay, now);
            }
        }
        if now - self.last_sync >= SYNC_EVERY {
            self.last_sync = now;
            for p in std::mem::take(&mut self.dirty) {
                if let Ok(f) = open_safe(&p, false) {
                    let _ = f.sync_all();
                }
            }
        }
        if self.last_prune == i64::MIN || now - self.last_prune >= PRUNE_EVERY {
            self.last_prune = now;
            self.accounted = self.walk();
            self.prune(now);
        }
        if self.blocked && now - self.last_retry >= RETRY_EVERY {
            self.last_retry = now;
            self.accounted = self.walk();
            self.prune(now);
            // Room for more than one line before writes resume, so they do not stop again at once.
            let headroom = (self.budget / 10).min(RETRY_HEADROOM);
            self.prune_for_space(headroom, now);
            if self.accounted.saturating_add(headroom) <= self.budget && self.reserve_ok() {
                self.blocked = false;
                self.note("fleet.metrics-space-ok", Fields::new().with("accounted", self.accounted));
            }
        }
    }

    pub fn set_departed(&mut self, departed: Vec<(String, i64)>) {
        self.departed = departed.into_iter().filter(|(id, _)| relay_id_ok(id)).collect();
    }

    fn take_drops(&mut self) -> HashMap<String, BTreeMap<Why, u64>> {
        std::mem::take(&mut self.drops)
    }
}

// ── The console's handle ────────────────────────────────────────────────────────────────────────────────────

/// What `receive` says about an accepted snapshot.
#[derive(Debug, PartialEq, Eq)]
pub struct Received {
    pub clock_off: bool,
}

/// The latest accepted snapshot of a relay (console receive time).
#[derive(Clone, Debug)]
pub struct Latest {
    pub t: i64,
    pub m: Map<String, Value>,
}

/// One `fleet.metrics-refused` entry (actor `relay <relayId>`, at most one an hour per relay).
#[derive(Debug, PartialEq)]
pub struct MetricsSummary {
    pub relay: String,
    pub count: u64,
    pub why: Map<String, Value>,
}

/// Overview items: `metrics-space` and `metrics-refused` (`<relay> sent <n> health reports that were not accepted.`).
#[derive(Debug, Default, PartialEq)]
pub struct MetricsAttention {
    pub space: bool,
    pub refused: Vec<(String, u64)>,
}

/// A snapshot kept in memory: (receive time, seq, values by key index).
type Kept = (i64, i64, Vec<(usize, f64)>);

struct RelayFront {
    last: Option<Last>,
    recent: VecDeque<Kept>,
    /// Interval metrics summed since the console started (the 10.1 counters); None until a first value.
    totals: Vec<Option<f64>>,
    pending: BTreeMap<Why, u64>,
    last_summary: Option<i64>,
    /// Refusals in the current 24-hour window (the Overview item).
    day: (i64, u64),
}

impl Default for RelayFront {
    fn default() -> RelayFront {
        RelayFront { last: None, recent: VecDeque::new(), totals: vec![None; KEYS.len()], pending: BTreeMap::new(), last_summary: None, day: (0, 0) }
    }
}

enum Job {
    Snap { relay: String, t: i64, seq: i64, values: Vec<(usize, f64)> },
    Departed(Vec<(String, i64)>),
    #[cfg(test)]
    Sync(mpsc::Sender<()>),
}

/// The console's metrics: validation, the latest values, the writer and the query.
pub struct Metrics {
    root: PathBuf,
    front: Mutex<HashMap<String, RelayFront>>,
    store: Arc<Mutex<Store>>,
    tx: SyncSender<Job>,
}

impl Metrics {
    /// Open `<state_dir>/metrics` and start the writer thread.
    pub fn open(state_dir: &Path, logger: Arc<Logger>) -> Arc<Metrics> {
        let root = state_dir.join("metrics");
        let store = Store::open(root.clone(), BUDGET, Box::new(RealFs), Some(logger), crate::codec::now_ms());
        Metrics::start(root, store)
    }

    /// The handle over an opened store (tests give a small budget or a test volume).
    pub fn start(root: PathBuf, store: Store) -> Arc<Metrics> {
        let store = Arc::new(Mutex::new(store));
        let (tx, rx) = mpsc::sync_channel::<Job>(QUEUE);
        let s = store.clone();
        let _ = std::thread::Builder::new().name("fleet-metrics".into()).spawn(move || loop {
            match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(Job::Snap { relay, t, seq, values }) => {
                    let now = crate::codec::now_ms();
                    let mut st = s.lock();
                    let _ = st.append(&relay, t, seq, &values, now);
                    st.tick(now);
                }
                Ok(Job::Departed(d)) => s.lock().set_departed(d),
                #[cfg(test)]
                Ok(Job::Sync(done)) => {
                    let _ = done.send(());
                }
                Err(RecvTimeoutError::Timeout) => s.lock().tick(crate::codec::now_ms()),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        });
        Arc::new(Metrics { root, front: Mutex::new(HashMap::new()), store, tx })
    }

    fn refuse(f: &mut RelayFront, why: Why, now: i64) {
        *f.pending.entry(why).or_default() += 1;
        if now - f.day.0 >= DAY {
            f.day = (now, 0);
        }
        f.day.1 += 1;
    }

    /// A relay's `metrics` event (9.3): validated whole, then queued for the writer. Never blocks on the disk.
    pub fn receive(&self, relay: &str, product: Product, body: &Value, now: i64) -> Result<Received, Why> {
        if !relay_id_ok(relay) {
            return Err(Why::Shape);
        }
        let mut front = self.front.lock();
        let f = front.entry(relay.to_owned()).or_default();
        let a = match validate(body, product, f.last.as_ref(), now) {
            Ok(a) => a,
            Err(why) => {
                Metrics::refuse(f, why, now);
                return Err(why);
            }
        };
        match self.tx.try_send(Job::Snap { relay: relay.to_owned(), t: now, seq: a.seq, values: a.values.clone() }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                Metrics::refuse(f, Why::Queue, now);
                return Err(Why::Queue);
            }
        }
        f.last = Some(Last { seq: a.seq, t: now });
        for &(i, x) in &a.values {
            if KEYS[i].kind == Kind::Interval {
                *f.totals[i].get_or_insert(0.0) += x;
            }
        }
        if f.recent.len() == RECENT {
            f.recent.pop_front();
        }
        f.recent.push_back((now, a.seq, a.values));
        Ok(Received { clock_off: a.clock_off })
    }

    /// Wait until the writer has handled everything queued before this call.
    #[cfg(test)]
    pub fn flush(&self) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Job::Sync(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(30));
        }
    }

    /// The registry's removed and left relays with when they went (their folders go 31 days later).
    pub fn set_departed(&self, departed: Vec<(String, i64)>) {
        let _ = self.tx.try_send(Job::Departed(departed));
    }

    pub fn latest(&self, relay: &str) -> Option<Latest> {
        let front = self.front.lock();
        let (t, _, values) = front.get(relay)?.recent.back()?;
        let m = values.iter().map(|(i, x)| (KEYS[*i].key.to_owned(), crate::fleet_probe::number(*x))).collect();
        Some(Latest { t: *t, m })
    }

    /// The values of `key` in the snapshots kept in memory since `since` (ms), oldest first.
    pub fn recent(&self, relay: &str, key: &str, since: i64) -> Vec<(i64, f64)> {
        let Some(i) = key_index(key) else { return Vec::new() };
        let front = self.front.lock();
        front.get(relay).map_or_else(Vec::new, |f| f.recent.iter().filter(|(t, _, _)| *t >= since).filter_map(|(t, _, v)| v.iter().find(|(k, _)| *k == i).map(|(_, x)| (*t, *x))).collect())
    }

    /// The interval metrics of a relay summed since the console started, by key: only keys it ever reported.
    pub fn totals(&self, relay: &str) -> Vec<(usize, f64)> {
        let front = self.front.lock();
        front.get(relay).map_or_else(Vec::new, |f| f.totals.iter().enumerate().filter_map(|(i, x)| Some((i, (*x)?))).collect())
    }

    /// The `fleet.metrics-refused` entries due now: one per relay with refusals or drops, at most one an hour each.
    pub fn take_summaries(&self, now: i64) -> Vec<MetricsSummary> {
        let drops = self.store.lock().take_drops();
        let mut front = self.front.lock();
        for (relay, whys) in drops {
            let f = front.entry(relay).or_default();
            for (why, n) in whys {
                *f.pending.entry(why).or_default() += n;
            }
        }
        let mut out = Vec::new();
        let mut ids: Vec<&String> = front.keys().collect();
        ids.sort();
        let ids: Vec<String> = ids.into_iter().cloned().collect();
        for relay in ids {
            let f = front.get_mut(&relay).unwrap();
            if f.pending.is_empty() || f.last_summary.is_some_and(|t| now - t < HOUR) {
                continue;
            }
            let pending = std::mem::take(&mut f.pending);
            let count = pending.values().sum();
            let why = pending.into_iter().map(|(w, n)| (w.as_str().to_owned(), Value::from(n))).collect();
            f.last_summary = Some(now);
            out.push(MetricsSummary { relay, count, why });
        }
        out
    }

    /// The Overview items.
    pub fn attention(&self, now: i64) -> MetricsAttention {
        let space = self.store.lock().blocked();
        let front = self.front.lock();
        let mut refused: Vec<(String, u64)> = front.iter().filter(|(_, f)| f.day.1 > 0 && now - f.day.0 < DAY).map(|(r, f)| (r.clone(), f.day.1)).collect();
        refused.sort();
        MetricsAttention { space, refused }
    }

    /// `GET /console/api/fleet/metrics` (9.5) over the console's registry (`(relayId, product)`).
    pub fn query(&self, pairs: &[(String, String)], registry: &[(String, Product)], now: i64) -> Result<Value, ApiError> {
        query(&self.root, pairs, registry, now)
    }
}

// ── 9.5 Query ───────────────────────────────────────────────────────────────────────────────────────────────

pub const QUERY_RELAYS_MAX: usize = 20;
pub const QUERY_NAMES_MAX: usize = 8;
pub const POINTS_MAX: usize = 800;

/// A range's window, step (ms) and file kind.
fn range_of(r: &str) -> Option<(i64, i64, FileKind)> {
    Some(match r {
        "1h" => (HOUR, 60_000, FileKind::Raw),
        "24h" => (DAY, FIVE_MIN, FileKind::M5),
        "7d" => (7 * DAY, HOUR, FileKind::H1),
        "30d" => (30 * DAY, HOUR, FileKind::H1),
        _ => return None,
    })
}

/// The points of one relay and key in the window: raw values (1h), else each bucket's mean ("now") or sum (interval),
/// at most the newest 800.
fn series(root: &Path, relay: &str, key: usize, window: i64, kind: FileKind, now: i64) -> Vec<(i64, f64)> {
    let from = now - window;
    let dir = root.join(relay);
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(i64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_owned();
            let (k, a, b) = parse_name(&name)?;
            (k == kind && b > from && a <= now).then(|| (a, dir.join(name)))
        })
        .collect();
    files.sort();
    let name = KEYS[key].key;
    let at = if KEYS[key].kind == Kind::Interval { 3 } else { 1 };
    let mut pts = Vec::new();
    for (_, path) in files {
        for line in read_lines(&path) {
            let Some(v) = crate::codec::parse_json(&line) else { continue };
            let Some(t) = v["t"].as_i64().filter(|t| *t >= from && *t <= now) else { continue };
            let x = match kind {
                FileKind::Raw => v["m"][name].as_f64(),
                _ => v["m"][name].get(at).and_then(Value::as_f64),
            };
            if let Some(x) = x {
                pts.push((t, x));
            }
        }
    }
    pts.sort_by_key(|p| p.0);
    if pts.len() > POINTS_MAX {
        pts.drain(..pts.len() - POINTS_MAX);
    }
    pts
}

fn points_value(pts: &[(i64, f64)]) -> Value {
    Value::Array(pts.iter().map(|(t, x)| Value::Array(vec![Value::from(*t), crate::fleet_probe::number(*x)])).collect())
}

fn query(root: &Path, pairs: &[(String, String)], registry: &[(String, Product)], now: i64) -> Result<Value, ApiError> {
    let bad = || ApiError::of("invalid");
    let get = |k: &str| pairs.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    if pairs.iter().any(|(n, _)| !["relays", "names", "range", "aggregate"].contains(&n.as_str())) {
        return Err(ApiError::of("unknown-field"));
    }
    let range = get("range").ok_or_else(bad)?;
    let (window, step, kind) = range_of(range).ok_or_else(bad)?;
    let aggregate = match get("aggregate").unwrap_or("0") {
        "0" => false,
        "1" => true,
        _ => return Err(bad()),
    };
    let names: Vec<usize> = get("names").ok_or_else(bad)?.split(',').map(key_index).collect::<Option<_>>().ok_or_else(bad)?;
    if names.is_empty() || names.len() > QUERY_NAMES_MAX || names.iter().enumerate().any(|(n, i)| names[..n].contains(i)) {
        return Err(bad());
    }
    let relays_text = get("relays").ok_or_else(bad)?;
    let relays: Vec<(String, Product)> = if relays_text == "all" {
        if !aggregate {
            return Err(bad());
        }
        registry.to_vec()
    } else {
        let ids: Vec<&str> = relays_text.split(',').collect();
        if ids.is_empty() || ids.len() > QUERY_RELAYS_MAX || ids.iter().enumerate().any(|(n, id)| ids[..n].contains(id)) {
            return Err(bad());
        }
        ids.iter().map(|id| registry.iter().find(|(r, _)| r == id).cloned()).collect::<Option<_>>().ok_or_else(bad)?
    };
    if aggregate && names.iter().any(|i| KEYS[*i].aggregate == Aggregate::Never) {
        return Err(bad());
    }
    let mut out = Vec::new();
    if aggregate {
        for &i in &names {
            let key = &KEYS[i];
            // Points grouped by floor(t / step) * step across the relays (in their order), then summed, averaged or the
            // maximum.
            let mut slots: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
            for (relay, _) in relays.iter().filter(|(_, p)| key.of(*p)) {
                for (t, x) in series(root, relay, i, window, kind, now) {
                    slots.entry(t - t.rem_euclid(step)).or_default().push(x);
                }
            }
            let mut pts: Vec<(i64, f64)> = slots
                .into_iter()
                .map(|(t, xs)| {
                    let v = match key.aggregate {
                        Aggregate::Sum => xs.iter().sum(),
                        Aggregate::Mean => xs.iter().sum::<f64>() / xs.len() as f64,
                        _ => xs.iter().copied().fold(f64::MIN, f64::max),
                    };
                    (t, v)
                })
                .collect();
            if pts.len() > POINTS_MAX {
                pts.drain(..pts.len() - POINTS_MAX);
            }
            out.push(serde_json::json!({"relay": "fleet", "name": key.key, "unit": key.unit, "points": points_value(&pts)}));
        }
    } else {
        for (relay, product) in &relays {
            for &i in &names {
                let key = &KEYS[i];
                if !key.of(*product) {
                    continue;
                }
                let pts = series(root, relay, i, window, kind, now);
                out.push(serde_json::json!({"relay": relay, "name": key.key, "unit": key.unit, "points": points_value(&pts)}));
            }
        }
    }
    Ok(serde_json::json!({"ok": true, "range": range, "step": step, "series": out}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_json;

    const R1: &str = "r_00000000000000a1";
    const R2: &str = "r_00000000000000b2";
    /// 2026-11-17T00:00:00Z.
    fn t0() -> i64 {
        days_from_civil(2026, 11, 17) * DAY
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-fleet-metrics-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn snap(seq: i64, ts: i64, m: Value) -> Value {
        serde_json::json!({"v": 1, "seq": seq, "ts": ts, "interval": 60, "m": m})
    }

    /// A volume and delete double: free space set by the test, deletes that fail for chosen paths.
    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<FakeState>>);

    #[derive(Default)]
    struct FakeState {
        free: Option<(u64, u64)>,
        fail: Option<std::io::ErrorKind>,
    }

    impl FsOps for Fake {
        fn free_space(&self, _dir: &Path) -> Option<(u64, u64)> {
            self.0.lock().free
        }

        fn remove(&self, path: &Path) -> std::io::Result<()> {
            if let Some(kind) = self.0.lock().fail {
                return Err(std::io::Error::from(kind));
            }
            fs::remove_file(path)
        }
    }

    fn store(d: &Path, budget: u64, fake: &Fake, now: i64) -> Store {
        Store::open(d.join("metrics"), budget, Box::new(fake.clone()), None, now)
    }

    fn lines(d: &Path, relay: &str, name: &str) -> Vec<String> {
        read_lines(&d.join("metrics").join(relay).join(name))
    }

    #[test]
    fn the_key_table_equals_the_vector() {
        let v = vector("admin_console_fleet_metrics_v1.json");
        let keys = v["keys"].as_array().unwrap();
        assert_eq!(keys.len(), KEYS.len());
        for (k, want) in KEYS.iter().zip(keys) {
            assert_eq!(want["key"], k.key);
            assert_eq!(want["unit"], k.unit, "{}", k.key);
            assert_eq!(want["kind"], if k.kind == Kind::Now { "now" } else { "interval" }, "{}", k.key);
            let products: Vec<&str> = want["products"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
            assert_eq!(products.contains(&"spokes"), k.of(Product::Spokes), "{}", k.key);
            assert_eq!(products.contains(&"meet"), k.of(Product::Meet), "{}", k.key);
            assert_eq!(want["min"].as_f64(), Some(k.min), "{}", k.key);
            assert_eq!(want["max"].as_f64(), Some(k.max), "{}", k.key);
            assert_eq!(want["integer"].as_bool(), Some(k.integer), "{}", k.key);
            let agg = match k.aggregate {
                Aggregate::Sum => Value::from("sum"),
                Aggregate::Mean => Value::from("mean"),
                Aggregate::Max => Value::from("max"),
                Aggregate::Never => Value::Null,
            };
            assert_eq!(want["aggregate"], agg, "{}", k.key);
            assert_eq!(want["family"], k.family, "{}", k.key);
            let t = match k.prom {
                PromType::Gauge => "gauge",
                PromType::Counter => "counter",
                PromType::Stateset => "stateset",
            };
            assert_eq!(want["type"], t, "{}", k.key);
            assert_eq!(want["divide_by"].as_f64().unwrap_or(1.0), k.divide, "{}", k.key);
        }
    }

    /// The vector's snapshots in order (state carried), then the raw, 5-minute and hourly lines they produce.
    #[test]
    fn vector_snapshots_and_rollups_byte_for_byte() {
        let v = vector("admin_console_fleet_metrics_v1.json");
        let products: HashMap<String, Product> = v["relays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_str().unwrap().to_owned(), if r["product"] == "meet" { Product::Meet } else { Product::Spokes }))
            .collect();
        let d = dir("vector");
        let fake = Fake::default();
        let first = v["snapshots"][0]["received_ms"].as_i64().unwrap();
        let mut st = store(&d, BUDGET, &fake, first);
        let mut last: HashMap<String, Last> = HashMap::new();
        let mut kinds = HashSet::new();
        for c in v["snapshots"].as_array().unwrap() {
            let relay = c["relay"].as_str().unwrap();
            let now = c["received_ms"].as_i64().unwrap();
            let got = parse_snapshot(c["text"].as_str().unwrap()).and_then(|b| validate(&b, products[relay], last.get(relay), now));
            match (&got, c["accept"].as_bool().unwrap()) {
                (Ok(a), true) => {
                    last.insert(relay.to_owned(), Last { seq: a.seq, t: now });
                    st.append(relay, now, a.seq, &a.values, now).unwrap();
                    st.tick(now);
                }
                (Err(why), false) => {
                    assert_eq!(c["why"], why.as_str(), "{}", c["name"]);
                    kinds.insert(why.as_str());
                }
                _ => panic!("{}: {got:?}", c["name"]),
            }
        }
        for want in v["checks"].as_array().unwrap() {
            assert!(kinds.contains(want.as_str().unwrap()), "the vector refuses for {want}");
        }
        // the vector's buckets closed by arrival; the last of each relay is still open
        for (kind, prefix) in [("raw", "raw-"), ("m5", "m5-"), ("h1", "h1-")] {
            for (relay, want) in v[kind].as_object().unwrap() {
                let mut got = Vec::new();
                for (_, _, _, path) in st.files(relay) {
                    if path.file_name().unwrap().to_str().unwrap().starts_with(prefix) {
                        got.extend(read_lines(&path));
                    }
                }
                let want: Vec<String> = want.as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_owned()).collect();
                assert_eq!(got, want, "{kind} lines of {relay}");
            }
        }
    }

    #[test]
    fn vector_queries_answer_exactly() {
        let v = vector("admin_console_fleet_metrics_v1.json");
        let registry: Vec<(String, Product)> = v["relays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_str().unwrap().to_owned(), if r["product"] == "meet" { Product::Meet } else { Product::Spokes }))
            .collect();
        let d = dir("vector-query");
        let root = d.join("metrics");
        for kind in ["raw", "m5", "h1"] {
            for (relay, ls) in v[kind].as_object().unwrap() {
                fs::create_dir_all(root.join(relay)).unwrap();
                for l in ls.as_array().unwrap() {
                    let line = l.as_str().unwrap();
                    let t = parse_json(line).unwrap()["t"].as_i64().unwrap();
                    let name = match kind {
                        "raw" => format!("raw-{}.jsonl", day_name(t)),
                        "m5" => format!("m5-{}.jsonl", day_name(t)),
                        _ => format!("h1-{}.jsonl", month_name(t)),
                    };
                    let mut f = OpenOptions::new().append(true).create(true).open(root.join(relay).join(name)).unwrap();
                    writeln!(f, "{line}").unwrap();
                }
            }
        }
        for q in v["queries"].as_array().unwrap() {
            let r = &q["request"];
            // the query string's form: lists comma-joined
            let list = |v: &Value| v.as_str().map(str::to_owned).unwrap_or_else(|| v.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect::<Vec<_>>().join(","));
            let aggregate = r["aggregate"].as_i64().map_or_else(|| r["aggregate"].as_str().unwrap().to_owned(), |a| a.to_string());
            let pairs = vec![("relays".to_string(), list(&r["relays"])), ("names".into(), list(&r["names"])), ("range".into(), r["range"].as_str().unwrap().to_owned()), ("aggregate".into(), aggregate)];
            let got = query(&root, &pairs, &registry, r["now_ms"].as_i64().unwrap()).unwrap();
            assert_eq!(crate::codec::stringify(&got), crate::codec::stringify(&q["answer"]), "{r}");
        }
    }

    #[test]
    fn validation_refuses_every_kind() {
        let now = t0();
        let ok = snap(5, now, serde_json::json!({"people_online": 3, "cpu_host": 12.5, "license_state": null}));
        let a = validate(&ok, Product::Spokes, None, now).unwrap();
        assert_eq!(a.values, vec![(0, 3.0), (15, 12.5)]);
        assert!(!a.clock_off);
        let cases: Vec<(Value, Product, Why)> = vec![
            (serde_json::json!({"v": 2, "seq": 1, "ts": now, "interval": 60, "m": {}}), Product::Spokes, Why::Version),
            (serde_json::json!({"seq": 1, "ts": now, "interval": 60, "m": {}}), Product::Spokes, Why::Version),
            (serde_json::json!({"v": 1, "seq": 1, "ts": now, "interval": 60, "m": {}, "x": 1}), Product::Spokes, Why::Shape),
            (serde_json::json!({"v": 1, "seq": 1, "ts": now, "interval": 30, "m": {}}), Product::Spokes, Why::Shape),
            (serde_json::json!({"v": 1, "seq": 0, "ts": now, "interval": 60, "m": {}}), Product::Spokes, Why::Shape),
            (snap(1, now, serde_json::json!({"made_up": 1})), Product::Spokes, Why::KeyUnknown),
            (snap(1, now, serde_json::json!({"calls_active": 1})), Product::Spokes, Why::KeyOtherProduct),
            (snap(1, now, serde_json::json!({"hubs_online": 1})), Product::Meet, Why::KeyOtherProduct),
            (snap(1, now, serde_json::json!({"people_online": "3"})), Product::Spokes, Why::NotNumber),
            (snap(1, now, serde_json::json!({"people_online": [3]})), Product::Spokes, Why::NotNumber),
            (snap(1, now, serde_json::json!({"people_online": 1.5})), Product::Spokes, Why::NotInteger),
            (snap(1, now, serde_json::json!({"cpu_host": 100.5})), Product::Spokes, Why::Bound),
            (snap(1, now, serde_json::json!({"cert_tls_days": -3651})), Product::Spokes, Why::Bound),
            (snap(1, now, serde_json::json!({"people_online": -1})), Product::Spokes, Why::Bound),
        ];
        for (body, product, want) in cases {
            assert_eq!(validate(&body, product, None, now).err(), Some(want), "{body}");
        }
        assert_eq!(parse_snapshot(r#"{"v":1,"seq":1,"ts":1,"interval":60,"m":{"cpu_host":NaN}}"#).err(), Some(Why::NotFinite));
        assert_eq!(parse_snapshot(r#"{"v":1,"seq":1,"ts":1,"interval":60,"m":{"cpu_host":1e999}}"#).err(), Some(Why::NotFinite));
        assert_eq!(parse_snapshot("{not json").err(), Some(Why::Shape));
        let last = Last { seq: 5, t: now };
        assert_eq!(validate(&snap(5, now, serde_json::json!({})), Product::Spokes, Some(&last), now + 60_000).err(), Some(Why::Seq));
        assert_eq!(validate(&snap(6, now, serde_json::json!({})), Product::Spokes, Some(&last), now + 49_999).err(), Some(Why::Rate));
        assert!(validate(&snap(6, now, serde_json::json!({})), Product::Spokes, Some(&last), now + 50_000).is_ok());
        assert!(validate(&snap(6, now - 301_000, serde_json::json!({})), Product::Spokes, None, now).unwrap().clock_off);
    }

    #[test]
    fn buckets_close_by_arrival_and_by_timer() {
        let d = dir("close");
        let fake = Fake::default();
        let t = t0();
        let mut st = store(&d, BUDGET, &fake, t);
        st.append(R1, t + 10_000, 1, &[(0, 2.0)], t + 10_000).unwrap();
        st.append(R1, t + 70_000, 2, &[(0, 4.0)], t + 70_000).unwrap();
        assert!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))).is_empty());
        // arrival in the next 5-minute bucket closes the first
        st.append(R1, t + FIVE_MIN + 1_000, 3, &[(0, 9.0)], t + FIVE_MIN + 1_000).unwrap();
        assert_eq!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))), vec![format!(r#"{{"t":{t},"n":2,"m":{{"people_online":[2,3,4,6,4]}}}}"#)]);
        // the timer closes the second 2 minutes after its end, not before
        st.tick(t + 2 * FIVE_MIN + CLOSE_GRACE - 1);
        assert_eq!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))).len(), 1);
        st.tick(t + 2 * FIVE_MIN + CLOSE_GRACE);
        assert_eq!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))).len(), 2);
        assert!(lines(&d, R1, &format!("h1-{}.jsonl", month_name(t))).is_empty());
        st.tick(t + HOUR + CLOSE_GRACE);
        assert_eq!(lines(&d, R1, &format!("h1-{}.jsonl", month_name(t))), vec![format!(r#"{{"t":{t},"n":3,"m":{{"people_online":[2,5,9,15,9]}}}}"#)]);
        // keys null in every snapshot are left out; the mean is the shortest round-trip decimal
        let mut b = Bucket::new(0);
        b.add(&[(15, 1.0)]);
        b.add(&[(15, 2.0)]);
        b.add(&[]);
        assert_eq!(b.line(), r#"{"t":0,"n":3,"m":{"cpu_host":[1,1.5,2,3,2]}}"#);
    }

    #[test]
    fn open_buckets_are_rebuilt_at_start_and_torn_lines_cut() {
        let d = dir("rebuild");
        let fake = Fake::default();
        let t = t0() + 10 * HOUR;
        {
            let mut st = store(&d, BUDGET, &fake, t);
            st.append(R1, t + 1_000, 1, &[(0, 1.0)], t + 1_000).unwrap();
            st.append(R1, t + 61_000, 2, &[(0, 3.0)], t + 61_000).unwrap();
        }
        // a torn last line (a crash mid-write) in the raw file
        let raw = d.join("metrics").join(R1).join(format!("raw-{}.jsonl", day_name(t)));
        let mut f = OpenOptions::new().append(true).open(&raw).unwrap();
        f.write_all(br#"{"t":99,"s":3,"m":{"peo"#).unwrap();
        drop(f);
        assert_eq!(read_lines(&raw).len(), 2, "a torn line is skipped when read");
        // restart within the bucket: the open buckets come back from the raw lines and the torn tail is cut
        let mut st = store(&d, BUDGET, &fake, t + 90_000);
        assert!(fs::read(&raw).unwrap().ends_with(b"\n"));
        assert_eq!(fs::read_to_string(&raw).unwrap().lines().count(), 2);
        st.append(R1, t + FIVE_MIN + 1_000, 3, &[(0, 5.0)], t + FIVE_MIN + 1_000).unwrap();
        assert_eq!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))), vec![format!(r#"{{"t":{t},"n":2,"m":{{"people_online":[1,2,3,4,3]}}}}"#)]);
        drop(st);
        // restart long after: the buckets that should have closed are closed at start, once
        let st = store(&d, BUDGET, &fake, t + 3 * HOUR);
        drop(st);
        assert_eq!(lines(&d, R1, &format!("m5-{}.jsonl", day_name(t))).len(), 2);
        assert_eq!(lines(&d, R1, &format!("h1-{}.jsonl", month_name(t))), vec![format!(r#"{{"t":{t},"n":3,"m":{{"people_online":[1,3,5,9,5]}}}}"#)]);
        let _ = store(&d, BUDGET, &fake, t + 4 * HOUR);
        assert_eq!(lines(&d, R1, &format!("h1-{}.jsonl", month_name(t))).len(), 1, "a restart never writes a bucket twice");
    }

    #[test]
    fn retention_prunes_whole_files() {
        let d = dir("retention");
        let fake = Fake::default();
        let t = t0();
        let rd = d.join("metrics").join(R1);
        fs::create_dir_all(&rd).unwrap();
        let day = |n: i64| day_name(t - n * DAY);
        for n in [1, 2, 3, 8, 9] {
            fs::write(rd.join(format!("raw-{}.jsonl", day(n))), "x\n").unwrap();
            fs::write(rd.join(format!("m5-{}.jsonl", day(n))), "x\n").unwrap();
        }
        let (y, m, _) = ymd(t);
        let prev_month = if m == 1 { format!("{:04}12", y - 1) } else { format!("{y:04}{:02}", m - 1) };
        let two_back = if m <= 2 { format!("{:04}{:02}", y - 1, m + 10) } else { format!("{y:04}{:02}", m - 2) };
        fs::write(rd.join(format!("h1-{}.jsonl", month_name(t))), "x\n").unwrap();
        fs::write(rd.join(format!("h1-{prev_month}.jsonl")), "x\n").unwrap();
        fs::write(rd.join(format!("h1-{two_back}.jsonl")), "x\n").unwrap();
        // just past midnight: raw files whose day ended 48 hours ago go, 5-minute files 8 days after their day
        let st = store(&d, BUDGET, &fake, t + 1);
        let mut left: Vec<String> = fs::read_dir(&rd).unwrap().flatten().map(|e| e.file_name().to_str().unwrap().to_owned()).collect();
        left.sort();
        let mut want = vec![
            format!("raw-{}.jsonl", day(1)),
            format!("raw-{}.jsonl", day(2)),
            format!("m5-{}.jsonl", day(1)),
            format!("m5-{}.jsonl", day(2)),
            format!("m5-{}.jsonl", day(3)),
            format!("m5-{}.jsonl", day(8)),
            format!("h1-{}.jsonl", month_name(t)),
            format!("h1-{prev_month}.jsonl"),
        ];
        want.sort();
        assert_eq!(left, want);
        assert_eq!(st.accounted(), 2 * want.len() as u64);
        // a departed relay's folder goes 31 days after it left, not before
        let mut st = st;
        st.set_departed(vec![(R1.to_owned(), t - 30 * DAY)]);
        st.last_prune = t;
        st.tick(t + HOUR);
        assert!(rd.exists());
        st.tick(t + HOUR + DAY + 1);
        assert!(!rd.exists());
    }

    #[test]
    fn the_space_cap_prunes_raw_then_five_minute_never_young_hourly() {
        let d = dir("cap-order");
        let fake = Fake::default();
        let t = t0();
        let rd = d.join("metrics").join(R2);
        fs::create_dir_all(&rd).unwrap();
        let big = "y".repeat(99) + "\n";
        fs::write(rd.join(format!("raw-{}.jsonl", day_name(t - DAY))), &big).unwrap();
        fs::write(rd.join(format!("raw-{}.jsonl", day_name(t))), &big).unwrap();
        fs::write(rd.join(format!("m5-{}.jsonl", day_name(t - 2 * DAY))), &big).unwrap();
        fs::write(rd.join(format!("h1-{}.jsonl", month_name(t))), &big).unwrap();
        let mut st = store(&d, 420, &fake, t + 1);
        assert_eq!(st.accounted(), 400);
        let line = "z".repeat(49);
        // 50 bytes more than fits: the older raw file goes first
        st.write_line(R2, &format!("raw-{}.jsonl", day_name(t)), &line, t + 1).unwrap();
        assert!(!rd.join(format!("raw-{}.jsonl", day_name(t - DAY))).exists());
        assert_eq!(st.accounted(), 350);
        st.write_line(R2, &format!("raw-{}.jsonl", day_name(t)), &line, t + 1).unwrap();
        // then the newer raw file, then the 5-minute file
        st.write_line(R2, &format!("x-{}.jsonl", 1), &"q".repeat(199), t + 1).unwrap();
        assert!(!rd.join(format!("raw-{}.jsonl", day_name(t))).exists());
        assert!(rd.join(format!("m5-{}.jsonl", day_name(t - 2 * DAY))).exists());
        st.write_line(R2, &format!("x-{}.jsonl", 2), &"q".repeat(99), t + 1).unwrap();
        assert!(!rd.join(format!("m5-{}.jsonl", day_name(t - 2 * DAY))).exists());
        // only the young hourly file is left to delete, and it is never deleted: writes stop
        assert_eq!(st.write_line(R2, "x-3.jsonl", &"q".repeat(199), t + 1), Err(Why::Space));
        assert!(rd.join(format!("h1-{}.jsonl", month_name(t))).exists());
        assert!(st.blocked());
        assert!(st.accounted() <= 420);
    }

    /// A1-M6: every way pruning can fail stops writes at the budget, the rest of the console keeps working, and writes
    /// resume when room returns.
    #[test]
    fn writes_stop_at_the_budget_when_pruning_fails_and_resume_with_room() {
        // a delete that fails, a file held open and a permission removed, each as the error its delete returns (the
        // volume double fails every delete; the held-open case also runs for real on Windows below)
        let failures = [("delete-fails", std::io::ErrorKind::Other), ("held-open", std::io::ErrorKind::Interrupted), ("permission", std::io::ErrorKind::PermissionDenied)];
        for (label, failure) in failures {
            let d = dir(&format!("cap-fail-{label}"));
            let fake = Fake::default();
            let t = t0();
            let rd = d.join("metrics").join(R1);
            fs::create_dir_all(&rd).unwrap();
            let old = rd.join(format!("raw-{}.jsonl", day_name(t - DAY)));
            fs::write(&old, "o".repeat(299) + "\n").unwrap();
            fake.0.lock().fail = Some(failure);
            let mut st = store(&d, 400, &fake, t + 1);
            let mut n = 0;
            while st.append(R1, t + 1 + n * 60_000, n + 1, &[(0, 1.0)], t + 1 + n * 60_000).is_ok() {
                n += 1;
                assert!(n < 100);
            }
            assert!(st.blocked() && st.accounted() <= 400, "{failure:?}");
            let on_disk: u64 = fs::read_dir(&rd).unwrap().flatten().map(|e| e.metadata().unwrap().len()).sum();
            assert!(on_disk <= 400);
            // the console's other files still write (the audit lives outside metrics/)
            fs::write(d.join("console-audit-000001.jsonl"), "entry\n").unwrap();
            // dropped and counted
            assert!(st.append(R1, t + 10 * HOUR, 1000, &[(0, 1.0)], t + 10 * HOUR).is_err());
            assert!(st.take_drops()[R1][&Why::Space] >= 1);
            // within 5 minutes nothing is retried; once the delete works, the retry frees room and writes resume
            fake.0.lock().fail = None;
            st.tick(t + 1 + n * 60_000 + 60_000);
            assert!(st.blocked());
            st.tick(t + 1 + n * 60_000 + RETRY_EVERY + 1);
            assert!(!st.blocked(), "{failure:?}");
            assert!(!old.exists());
            st.append(R1, t + 11 * HOUR, 2000, &[(0, 1.0)], t + 11 * HOUR).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_file_held_open_is_not_counted_as_freed() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = dir("held-open");
        let t = t0();
        let rd = d.join("metrics").join(R1);
        fs::create_dir_all(&rd).unwrap();
        let old = rd.join(format!("raw-{}.jsonl", day_name(t - DAY)));
        fs::write(&old, "o".repeat(299) + "\n").unwrap();
        // no sharing at all: the real delete fails while this handle lives
        let held = OpenOptions::new().read(true).share_mode(0).open(&old).unwrap();
        let mut st = Store::open(d.join("metrics"), 340, Box::new(RealFs), None, t + 1);
        assert_eq!(st.append(R1, t + 1, 1, &[(0, 1.0)], t + 1), Err(Why::Space));
        assert!(old.exists() && st.blocked() && st.accounted() == 300);
        drop(held);
        st.tick(t + 1 + RETRY_EVERY);
        assert!(!st.blocked());
        st.append(R1, t + 2 + RETRY_EVERY, 2, &[(0, 1.0)], t + 2 + RETRY_EVERY).unwrap();
        assert!(!old.exists(), "the write made room by deleting the old file once it was closed");
    }

    #[test]
    fn a_full_volume_stops_writes_at_the_reserve_and_resumes() {
        let d = dir("cap-volume");
        let fake = Fake::default();
        let t = t0();
        let gib = 1u64 << 30;
        fake.0.lock().free = Some((5 * gib, 100 * gib)); // under 10% of 100 GiB
        let mut st = store(&d, BUDGET, &fake, t);
        assert_eq!(st.append(R1, t, 1, &[(0, 1.0)], t), Err(Why::Space));
        assert!(st.blocked());
        fake.0.lock().free = Some((900 << 20, 4 * gib)); // under the 1 GiB floor
        st.tick(t + RETRY_EVERY);
        assert!(st.blocked());
        fake.0.lock().free = Some((20 * gib, 100 * gib));
        st.tick(t + 2 * RETRY_EVERY);
        assert!(!st.blocked());
        st.append(R1, t + 2 * RETRY_EVERY, 2, &[(0, 1.0)], t + 2 * RETRY_EVERY).unwrap();
    }

    #[test]
    fn two_writers_racing_never_pass_the_budget() {
        let d = dir("cap-race");
        let fake = Fake::default();
        let t = t0();
        let st = Arc::new(Mutex::new(store(&d, 8_000, &fake, t)));
        let outside = d.join("metrics").join(R2);
        fs::create_dir_all(&outside).unwrap();
        let mut handles = Vec::new();
        for (w, relay) in [R1, R2].into_iter().enumerate() {
            let st = st.clone();
            let outside = outside.clone();
            handles.push(std::thread::spawn(move || {
                for n in 0..400i64 {
                    let at = t + n * 60_000 + w as i64;
                    let _ = st.lock().append(relay, at, n + 1, &[(0, 1.0), (15, 12.25)], at);
                    if w == 1 && n % 50 == 0 {
                        // another process writing into the folder behind the store's back
                        fs::write(outside.join(format!("tmp-{n}")), "t".repeat(100)).unwrap();
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let mut st = st.lock();
        st.tick(t + 401 * 60_000 + RETRY_EVERY);
        let walked = st.walk();
        // what the store itself wrote never passed the budget
        let ours: u64 = [R1, R2].iter().flat_map(|r| st.files(r)).map(|f| fs::metadata(&f.3).unwrap().len()).sum();
        assert!(ours <= 8_000, "{ours}");
        assert!(walked >= ours);
    }

    #[cfg(unix)]
    #[test]
    fn links_and_foreign_files_are_skipped_never_followed() {
        let d = dir("links");
        let fake = Fake::default();
        let t = t0();
        let rd = d.join("metrics").join(R1);
        fs::create_dir_all(&rd).unwrap();
        let target = d.join("secret.txt");
        fs::write(&target, "keep me\n").unwrap();
        std::os::unix::fs::symlink(&target, rd.join(format!("raw-{}.jsonl", day_name(t)))).unwrap();
        let mut st = store(&d, BUDGET, &fake, t);
        assert_eq!(st.append(R1, t, 1, &[(0, 1.0)], t), Err(Why::File));
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
        // past retention the link is not deleted through, and nothing is counted as freed
        st.last_prune = t;
        st.tick(t + 10 * DAY);
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
    }

    fn write_lines(root: &Path, relay: &str, name: &str, ls: &[String]) {
        fs::create_dir_all(root.join(relay)).unwrap();
        let mut f = OpenOptions::new().append(true).create(true).open(root.join(relay).join(name)).unwrap();
        for l in ls {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn queries_at_each_range_with_point_limits_and_aggregation() {
        let d = dir("query");
        let root = d.join("metrics");
        let now = t0() + 40 * DAY;
        let reg = vec![(R1.to_owned(), Product::Spokes), (R2.to_owned(), Product::Meet)];
        // 1h raw: R1 one point a minute for 2 hours; R2 two
        let mut raw1 = Vec::new();
        let mut raw2 = Vec::new();
        for n in 0..120 {
            let t = now - n * 60_000;
            // KEYS indexes: 0 people_online, 15 cpu_host, 21 latency_console
            raw1.push(raw_line(t, 1000 - n, &[(0, 2.0), (15, 10.0), (21, 5.0)]));
            raw2.push(raw_line(t - 5_000, 1000 - n, &[(0, 3.0), (15, 30.0), (21, 7.0)]));
        }
        raw1.reverse();
        raw2.reverse();
        for (r, ls) in [(R1, &raw1), (R2, &raw2)] {
            for l in ls.iter() {
                let t = parse_json(l).unwrap()["t"].as_i64().unwrap();
                write_lines(&root, r, &format!("raw-{}.jsonl", day_name(t)), std::slice::from_ref(l));
            }
        }
        let pairs = |relays: &str, names: &str, range: &str, agg: &str| -> Vec<(String, String)> {
            vec![("relays".into(), relays.into()), ("names".into(), names.into()), ("range".into(), range.into()), ("aggregate".into(), agg.into())]
        };
        let a = query(&root, &pairs(R1, "people_online", "1h", "0"), &reg, now).unwrap();
        assert_eq!(a["step"], 60_000);
        assert_eq!(a["series"][0]["unit"], "people");
        let pts = a["series"][0]["points"].as_array().unwrap();
        assert_eq!(pts.len(), 61, "the last hour, both ends included");
        assert_eq!(pts[60], serde_json::json!([now, 2]));
        // aggregation: counts summed, percentages averaged, latency the maximum
        let a = query(&root, &pairs("all", "people_online,cpu_host,latency_console", "1h", "1"), &reg, now).unwrap();
        let s = a["series"].as_array().unwrap();
        assert_eq!(s.len(), 3);
        assert!(s.iter().all(|x| x["relay"] == "fleet"));
        // R2 reports 5 s before R1; both land in the slot one step before now (the slot of now has R1 only)
        let at = |i: usize| {
            let p = s[i]["points"].as_array().unwrap();
            assert!(p.len() >= 2, "series {i}: {}", s[i]);
            assert_eq!(p[p.len() - 1], serde_json::json!([now, ([2, 10, 5][i])]));
            assert_eq!(p[p.len() - 2][0], now - 60_000);
            p[p.len() - 2][1].clone()
        };
        assert_eq!(at(0), 5);
        assert_eq!(at(1), 20);
        assert_eq!(at(2), 7);
        // never aggregated; `all` only with aggregate; limits
        assert_eq!(query(&root, &pairs("all", "cert_tls_days", "24h", "1"), &reg, now).unwrap_err().code, "invalid");
        assert_eq!(query(&root, &pairs("all", "people_online", "1h", "0"), &reg, now).unwrap_err().code, "invalid");
        let nine = KEYS[..9].iter().map(|k| k.key).collect::<Vec<_>>().join(",");
        assert_eq!(query(&root, &pairs(R1, &nine, "1h", "0"), &reg, now).unwrap_err().code, "invalid");
        let many: Vec<String> = (0..21).map(|n| format!("r_{n:016x}")).collect();
        let big_reg: Vec<(String, Product)> = many.iter().map(|r| (r.clone(), Product::Spokes)).collect();
        assert_eq!(query(&root, &pairs(&many.join(","), "people_online", "1h", "0"), &big_reg, now).unwrap_err().code, "invalid");
        assert!(query(&root, &pairs(&many[..20].join(","), "people_online", "1h", "0"), &big_reg, now).is_ok());
        assert_eq!(query(&root, &pairs("r_ffffffffffffffff", "people_online", "1h", "0"), &reg, now).unwrap_err().code, "invalid");
        assert_eq!(query(&root, &pairs(R1, "people_online", "2h", "0"), &reg, now).unwrap_err().code, "invalid");
        // a key of the other product gives no series for that relay
        let a = query(&root, &pairs(R1, "calls_active", "1h", "0"), &reg, now).unwrap();
        assert_eq!(a["series"], serde_json::json!([]));
        // 24h from 5-minute buckets: mean for "now" metrics, sum for interval metrics
        let mut b = Bucket::new(now - now.rem_euclid(FIVE_MIN) - FIVE_MIN);
        b.add(&[(0, 2.0), (5, 10.0)]);
        b.add(&[(0, 4.0), (5, 20.0)]);
        write_lines(&root, R1, &format!("m5-{}.jsonl", day_name(b.start)), &[b.line()]);
        let a = query(&root, &pairs(R1, "people_online,messages", "24h", "0"), &reg, now).unwrap();
        assert_eq!(a["step"], FIVE_MIN);
        assert_eq!(a["series"][0]["points"], serde_json::json!([[b.start, 3]]));
        assert_eq!(a["series"][1]["points"], serde_json::json!([[b.start, 30]]));
        // 7d and 30d from hourly files, at most 800 points (30 days of hours is 720; 40 days written)
        let mut hours = Vec::new();
        for n in (0..40 * 24).rev() {
            let mut h = Bucket::new(now - now.rem_euclid(HOUR) - n * HOUR);
            h.add(&[(0, n as f64)]);
            hours.push(h);
        }
        for h in &hours {
            write_lines(&root, R1, &format!("h1-{}.jsonl", month_name(h.start)), &[h.line()]);
        }
        let a = query(&root, &pairs(R1, "people_online", "7d", "0"), &reg, now).unwrap();
        assert_eq!(a["step"], HOUR);
        assert_eq!(a["series"][0]["points"].as_array().unwrap().len(), 7 * 24 + 1, "the window's both ends included");
        let a = query(&root, &pairs(R1, "people_online", "30d", "0"), &reg, now).unwrap();
        assert_eq!(a["series"][0]["points"].as_array().unwrap().len(), 30 * 24 + 1);
        let mut many_pts = Vec::new();
        for n in 0..900 {
            many_pts.push(raw_line(now - 1000 + n, n, &[(0, 1.0)]));
        }
        write_lines(&root, R2, &format!("raw-{}.jsonl", day_name(now)), &many_pts);
        let a = query(&root, &pairs(R2, "people_online", "1h", "0"), &reg, now).unwrap();
        assert_eq!(a["series"][0]["points"].as_array().unwrap().len(), POINTS_MAX);
    }

    #[test]
    fn receive_counts_refusals_queues_and_summarizes_hourly() {
        let d = dir("receive");
        let t = crate::codec::now_ms();
        let m = Metrics::start(d.join("metrics"), Store::open(d.join("metrics"), BUDGET, Box::new(Fake::default()), None, t));
        assert!(m.receive(R1, Product::Spokes, &snap(1, t, serde_json::json!({"people_online": 4, "messages": 7})), t).is_ok());
        assert_eq!(m.receive(R1, Product::Spokes, &snap(2, t, serde_json::json!({})), t + 10_000), Err(Why::Rate));
        assert_eq!(m.receive(R1, Product::Spokes, &snap(1, t, serde_json::json!({})), t + 60_000), Err(Why::Seq));
        assert!(m.receive(R1, Product::Spokes, &snap(3, t, serde_json::json!({"messages": 5})), t + 60_000).is_ok());
        assert_eq!(m.receive("../x", Product::Spokes, &snap(1, t, serde_json::json!({})), t), Err(Why::Shape));
        m.flush();
        assert_eq!(m.latest(R1).unwrap().t, t + 60_000, "the latest is seq 3's");
        assert_eq!(m.recent(R1, "people_online", t), vec![(t, 4.0)]);
        assert_eq!(m.totals(R1).into_iter().find(|(i, _)| KEYS[*i].key == "messages").unwrap().1, 12.0);
        let s = m.take_summaries(t + 60_000);
        assert_eq!(s, vec![MetricsSummary { relay: R1.into(), count: 2, why: serde_json::json!({"seq": 1, "rate": 1}).as_object().unwrap().clone() }]);
        let _ = m.receive(R1, Product::Spokes, &snap(9, t, serde_json::json!({"x": 1})), t + 200_000);
        assert!(m.take_summaries(t + 200_000).is_empty(), "at most one an hour");
        assert_eq!(m.take_summaries(t + 60_000 + HOUR).len(), 1);
        assert_eq!(m.attention(t + 200_000).refused, vec![(R1.to_owned(), 3)]);
        // both accepted snapshots reached the raw file (the writer stamps the receive time)
        let days: HashSet<String> = [day_name(t), day_name(t + 60_000)].into_iter().collect();
        let raw: usize = days.iter().map(|day| lines(&d, R1, &format!("raw-{day}.jsonl")).len()).sum();
        assert_eq!(raw, 2);
    }
}
