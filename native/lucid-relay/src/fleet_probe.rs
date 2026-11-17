// The relay's health readings for the Lucid Admin Console (contract AC-2a 9.1 and 9.2, interface F9): the counters the
// product code increments where an event happens, the operating system readings (CPU, memory, network) and the one
// snapshot the management channel pushes every 60 s (`metrics`, 5.6).
//
// Operating system readings use no crate: Linux reads `/proc/self/stat`, `/proc/self/status` (`VmRSS`), `/proc/stat`,
// `/proc/meminfo` and `/proc/net/dev`, and inside a cgroup v2 container `/sys/fs/cgroup/cpu.stat`, `cpu.max`,
// `memory.current` and `memory.max`; Windows calls `GetProcessTimes`, `GetSystemTimes`, `K32GetProcessMemoryInfo`,
// `GlobalMemoryStatusEx` and `GetIfTable2` (FFI, as console_seal.rs does for DPAPI). Anything else is `null`. A reading
// never panics: a file that does not parse or a call that fails gives `null` for what it would have measured.
//
// Interval metrics (`messages`, `call_minutes`, `spokes_busy`, `net_in`, `net_out`, `quota_hits`) count what happened
// since the last snapshot; the first snapshot after start has `null` for the CPU and network deltas.

use crate::fleet_metrics::KEYS;
use crate::license::Product;
use parking_lot::Mutex;
use serde_json::{Map, Number, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Instant;

/// The snapshot interval, seconds (9.1).
pub const INTERVAL_SECS: i64 = 60;
/// The AC-1 refusals counted as "quotas hit" (AC-1 `QUOTA_EVENTS`, the events `LineRing` counts).
pub const QUOTA_EVENTS: [&str; 6] = ["send.rate-limited", "send.quota", "mailbox.full", "store.full", "user.refused", "logs.rate-limited"];
/// Distinct spokes remembered for `spokes_busy` in one interval (the 9.1 bound).
const BUSY_SPOKES_MAX: usize = 100_000;
/// Ping round trips kept for the median of one interval.
const PINGS_MAX: usize = 1_024;
/// No value: an atomic gauge that was never set.
const UNSET: i64 = i64::MIN;
const DAY_MS: i64 = 86_400_000;

/// What the product code knows at a snapshot (9.1 "now" keys it computes: people, devices, calls, hubs, spokes, lanes,
/// seats, certificate, CRL and license days, the license state, the growth gate), called with the time in ms.
pub type ProductSource = Box<dyn Fn(i64) -> Map<String, Value> + Send + Sync>;

/// The keys a product source may give; any other key it returns is ignored (OS readings and interval counts are this
/// file's own).
const SOURCE_KEYS: [&str; 19] = [
    "people_online",
    "devices_online",
    "calls_active",
    "participants",
    "hubs_online",
    "spokes_online",
    "spokes_total",
    "lanes_busy",
    "lanes_total",
    "seats_used",
    "seats_total",
    "cert_tls_days",
    "cert_console_days",
    "cert_signer_days",
    "crl_days",
    "license_days",
    "license_state",
    "license_service",
    "conn_open",
];

/// The process's counters (F9): atomics the product code increments where the event happens.
pub struct Counters {
    messages: AtomicU64,
    /// The sum of the participants of every 10 s sample in the interval (call minutes = sum * 10 / 60).
    participant_samples: AtomicU64,
    quota_hits: AtomicU64,
    conn_open: AtomicI64,
    mgmt_not_after: AtomicI64,
    busy_spokes: Mutex<HashSet<String>>,
    pings: Mutex<Vec<f64>>,
    /// Since start, never reset (for tests: other tests add to the same process-wide counters).
    #[cfg(test)]
    messages_all: AtomicU64,
    #[cfg(test)]
    participants_all: AtomicU64,
}

impl Default for Counters {
    fn default() -> Self {
        Counters {
            #[cfg(test)]
            messages_all: AtomicU64::new(0),
            #[cfg(test)]
            participants_all: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            participant_samples: AtomicU64::new(0),
            quota_hits: AtomicU64::new(0),
            conn_open: AtomicI64::new(0),
            mgmt_not_after: AtomicI64::new(UNSET),
            busy_spokes: Mutex::new(HashSet::new()),
            pings: Mutex::new(Vec::new()),
        }
    }
}

/// One open TCP connection on the relay's listeners; dropping it closes the count.
pub struct ConnGuard<'a> {
    counters: &'a Counters,
}

impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        self.counters.conn_open.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Counters {
    /// `messages`: Remote Spokes mail items accepted by `/v1/send`, Meeting Hub chat messages relayed.
    pub fn message(&self, n: u64) {
        self.messages.fetch_add(n, Ordering::Relaxed);
        #[cfg(test)]
        self.messages_all.fetch_add(n, Ordering::Relaxed);
    }

    /// Every `message` since start (not reset by a snapshot).
    #[cfg(test)]
    pub fn messages_total(&self) -> u64 {
        self.messages_all.load(Ordering::Relaxed)
    }

    /// The sum of every participant sample since start (not reset by a snapshot).
    #[cfg(test)]
    pub fn participants_total(&self) -> u64 {
        self.participants_all.load(Ordering::Relaxed)
    }

    /// Whether `node` sent or received mail in the current interval.
    #[cfg(test)]
    pub fn spoke_mail_seen(&self, node: &str) -> bool {
        self.busy_spokes.lock().contains(node)
    }

    /// `spokes_busy`: a spoke that sent or received mail in this interval.
    pub fn spoke_mail(&self, node: &str) {
        let mut set = self.busy_spokes.lock();
        if set.len() < BUSY_SPOKES_MAX && !set.contains(node) {
            set.insert(node.to_owned());
        }
    }

    /// `call_minutes`: one participant sample, taken every 10 s.
    pub fn participants_sample(&self, participants: u64) {
        self.participant_samples.fetch_add(participants, Ordering::Relaxed);
        #[cfg(test)]
        self.participants_all.fetch_add(participants, Ordering::Relaxed);
    }

    /// `conn_open`: one TCP connection on a listener, counted until the guard drops.
    pub fn conn_open(&self) -> ConnGuard<'_> {
        self.conn_open.fetch_add(1, Ordering::Relaxed);
        ConnGuard { counters: self }
    }

    /// `quota_hits`: one AC-1 quota refusal (an event of `QUOTA_EVENTS`).
    pub fn quota_hit(&self) {
        self.quota_hits.fetch_add(1, Ordering::Relaxed);
    }

    /// `latency_console`: one management channel ping round trip, ms.
    pub fn ping_rtt(&self, ms: u64) {
        let mut p = self.pings.lock();
        if p.len() < PINGS_MAX {
            p.push(ms as f64);
        }
    }

    /// `cert_mgmt_days`: the management certificate's notAfter (ms), or None without one.
    pub fn set_mgmt_not_after(&self, ms: Option<i64>) {
        self.mgmt_not_after.store(ms.unwrap_or(UNSET), Ordering::Relaxed);
    }

    /// The interval values, taken and reset.
    fn take_interval(&self) -> Interval {
        let busy = std::mem::take(&mut *self.busy_spokes.lock()).len() as u64;
        let mut pings = std::mem::take(&mut *self.pings.lock());
        Interval {
            messages: self.messages.swap(0, Ordering::Relaxed),
            participant_samples: self.participant_samples.swap(0, Ordering::Relaxed),
            quota_hits: self.quota_hits.swap(0, Ordering::Relaxed),
            busy_spokes: busy,
            latency: median(&mut pings),
        }
    }
}

struct Interval {
    messages: u64,
    participant_samples: u64,
    quota_hits: u64,
    busy_spokes: u64,
    latency: Option<f64>,
}

fn median(v: &mut [f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let mid = v.len() / 2;
    Some(if v.len() % 2 == 1 { v[mid] } else { (v[mid - 1] + v[mid]) / 2.0 })
}

static COUNTERS: LazyLock<Counters> = LazyLock::new(Counters::default);
static SOURCE: LazyLock<Mutex<Option<ProductSource>>> = LazyLock::new(|| Mutex::new(None));
static PROBE: LazyLock<Mutex<ProbeState>> = LazyLock::new(Default::default);

/// The process's counters.
pub fn counters() -> &'static Counters {
    &COUNTERS
}

/// The product's own readings, registered once at relay start (a later call replaces the earlier one).
pub fn set_product_source(f: ProductSource) {
    *SOURCE.lock() = Some(f);
}

#[derive(Default)]
struct ProbeState {
    last: Option<OsReading>,
    seq: i64,
}

/// The snapshot of 9.3 for this relay now: `{"v": 1, "seq", "ts", "interval": 60, "m": {...}}` with every key of
/// the product's 9.1 list, in that order, a number or `null`. `seq` only grows: one above the last, and never below
/// the wall clock in ms, so it stays above every earlier one across restarts while the clock moves forward.
pub fn snapshot(product: Product) -> Value {
    let now = crate::codec::now_ms();
    let reading = OsReading::read();
    let source = SOURCE.lock().as_ref().map(|f| f(now)).unwrap_or_default();
    let mut st = PROBE.lock();
    let seq = (st.seq + 1).max(now);
    st.seq = seq;
    let prev = st.last.replace(reading);
    drop(st);
    build(product, now, seq, prev.as_ref(), &reading, counters().take_interval(), &source, counters())
}

#[allow(clippy::too_many_arguments)]
fn build(product: Product, now: i64, seq: i64, prev: Option<&OsReading>, cur: &OsReading, iv: Interval, source: &Map<String, Value>, c: &Counters) -> Value {
    let os = os_values(prev, cur);
    let mgmt = c.mgmt_not_after.load(Ordering::Relaxed);
    let mut m = Map::new();
    for k in KEYS.iter().filter(|k| k.of(product)) {
        let v: Option<f64> = match k.key {
            "messages" => Some(iv.messages as f64),
            "call_minutes" => Some(round2(iv.participant_samples as f64 * 10.0 / 60.0)),
            "spokes_busy" => Some(iv.busy_spokes as f64),
            "quota_hits" => Some(iv.quota_hits as f64),
            "latency_console" => iv.latency.map(round2),
            "conn_open" => match source.get("conn_open").and_then(Value::as_f64) {
                Some(n) => Some(n),
                None => Some(c.conn_open.load(Ordering::Relaxed).max(0) as f64),
            },
            "cert_mgmt_days" => (mgmt != UNSET).then(|| (mgmt - now).div_euclid(DAY_MS) as f64),
            "cpu_process" => os.cpu_process,
            "cpu_host" => os.cpu_host,
            "mem_process" => os.mem_process,
            "mem_host_used" => os.mem_host_used,
            "net_in" => os.net_in,
            "net_out" => os.net_out,
            key if SOURCE_KEYS.contains(&key) => source.get(key).and_then(Value::as_f64),
            _ => None,
        };
        // A value the console would refuse (outside its bound, a fraction for a count) is sent as null instead, so one
        // bad reading never costs the whole snapshot.
        let v = v.filter(|x| x.is_finite() && *x >= k.min && *x <= k.max && (!k.integer || x.fract() == 0.0));
        m.insert(k.key.to_owned(), v.map_or(Value::Null, number));
    }
    let mut out = Map::new();
    out.insert("v".into(), Value::from(1));
    out.insert("seq".into(), Value::from(seq));
    out.insert("ts".into(), Value::from(now));
    out.insert("interval".into(), Value::from(INTERVAL_SECS));
    out.insert("m".into(), Value::Object(m));
    Value::Object(out)
}

/// A number as JSON: an integer when it has no fraction, else the float.
pub(crate) fn number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        Value::from(x as i64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// ── Operating system readings ───────────────────────────────────────────────────────────────────────────────

/// One reading of cumulative values; two readings give the interval's percentages and byte counts.
#[derive(Clone, Copy, Debug)]
pub struct OsReading {
    at: Instant,
    /// Process CPU time, seconds.
    process_cpu: Option<f64>,
    /// Host CPU (busy, total) in any one unit.
    host_cpu: Option<(f64, f64)>,
    /// cgroup v2 CPU usage, seconds, and the cores the cgroup may use.
    cgroup_cpu: Option<(f64, f64)>,
    mem_process: Option<u64>,
    mem_host_used: Option<f64>,
    /// Bytes received and sent on every interface but loopback.
    net: Option<(u64, u64)>,
    cores: f64,
}

#[derive(Default, Debug)]
struct OsValues {
    cpu_process: Option<f64>,
    cpu_host: Option<f64>,
    mem_process: Option<f64>,
    mem_host_used: Option<f64>,
    net_in: Option<f64>,
    net_out: Option<f64>,
}

fn cores() -> f64 {
    std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64)
}

fn pct(x: f64) -> f64 {
    round2(x.clamp(0.0, 100.0))
}

fn os_values(prev: Option<&OsReading>, cur: &OsReading) -> OsValues {
    let mut v = OsValues { mem_process: cur.mem_process.map(|b| b as f64), mem_host_used: cur.mem_host_used.map(pct), ..Default::default() };
    let Some(p) = prev else { return v };
    let elapsed = cur.at.saturating_duration_since(p.at).as_secs_f64();
    if elapsed > 0.0 {
        if let (Some(a), Some(b)) = (p.process_cpu, cur.process_cpu) {
            if b >= a {
                v.cpu_process = Some(pct((b - a) / (elapsed * cur.cores) * 100.0));
            }
        }
        v.cpu_host = match (p.cgroup_cpu, cur.cgroup_cpu, p.host_cpu, cur.host_cpu) {
            (Some((a, _)), Some((b, n)), _, _) if b >= a && n > 0.0 => Some(pct((b - a) / (elapsed * n) * 100.0)),
            (_, _, Some((ab, at)), Some((bb, bt))) if bt > at && bb >= ab => Some(pct((bb - ab) / (bt - at) * 100.0)),
            _ => None,
        };
    }
    if let (Some((ai, ao)), Some((bi, bo))) = (p.net, cur.net) {
        // A counter that went down (an interface reset or removed) gives no value for the interval.
        if bi >= ai && bo >= ao {
            v.net_in = Some((bi - ai) as f64);
            v.net_out = Some((bo - ao) as f64);
        }
    }
    v
}

impl OsReading {
    /// Read everything this OS offers; what it does not offer is None.
    #[cfg(target_os = "linux")]
    pub fn read() -> OsReading {
        linux::read()
    }

    #[cfg(windows)]
    pub fn read() -> OsReading {
        win::read()
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    pub fn read() -> OsReading {
        OsReading { at: Instant::now(), process_cpu: None, host_cpu: None, cgroup_cpu: None, mem_process: None, mem_host_used: None, net: None, cores: cores() }
    }
}

// ── Linux text formats (built on Linux, and in tests on every OS) ──────────────────────────────────────────────

/// `/proc/self/stat`: utime plus stime (fields 14 and 15), in clock ticks. The command name may hold spaces and
/// parentheses, so the fields are counted after the last `)`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_self_stat_ticks(text: &str) -> Option<u64> {
    let rest = &text[text.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    // After the `)`: field 3 (state) is index 0, so field n is index n - 3.
    let utime: u64 = f.get(11)?.parse().ok()?;
    let stime: u64 = f.get(12)?.parse().ok()?;
    utime.checked_add(stime)
}

/// `/proc/stat` first line: (busy, total) jiffies, idle and iowait not busy.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_proc_stat(text: &str) -> Option<(f64, f64)> {
    let line = text.lines().find(|l| l.starts_with("cpu "))?;
    let n: Vec<u64> = line.split_whitespace().skip(1).map(|x| x.parse().ok()).collect::<Option<Vec<_>>>()?;
    if n.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal (guest and guest_nice are inside user and nice).
    let total: u64 = n.iter().take(8).sum();
    let idle = n[3] + n.get(4).copied().unwrap_or(0);
    Some(((total - idle) as f64, total as f64))
}

#[cfg(any(target_os = "linux", test))]
fn kib_field(text: &str, name: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with(name) && l[name.len()..].starts_with(':'))?;
    let mut it = line[name.len() + 1..].split_whitespace();
    let n: u64 = it.next()?.parse().ok()?;
    match it.next() {
        Some("kB") | None => n.checked_mul(1024),
        _ => None,
    }
}

/// `/proc/self/status` `VmRSS`, bytes.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_vmrss(text: &str) -> Option<u64> {
    kib_field(text, "VmRSS")
}

/// `/proc/meminfo`: percent of memory in use, (MemTotal - MemAvailable) / MemTotal.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_meminfo(text: &str) -> Option<f64> {
    let total = kib_field(text, "MemTotal")? as f64;
    let avail = kib_field(text, "MemAvailable")? as f64;
    (total > 0.0).then(|| (total - avail.min(total)) / total * 100.0)
}

/// `/proc/net/dev`: bytes received and sent on every interface but `lo`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_net_dev(text: &str) -> Option<(u64, u64)> {
    let (mut rx, mut tx, mut any) = (0u64, 0u64, false);
    for line in text.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else { continue };
        if name.trim() == "lo" {
            continue;
        }
        let f: Vec<&str> = rest.split_whitespace().collect();
        let (Some(r), Some(t)) = (f.first().and_then(|x| x.parse::<u64>().ok()), f.get(8).and_then(|x| x.parse::<u64>().ok())) else { continue };
        rx = rx.saturating_add(r);
        tx = tx.saturating_add(t);
        any = true;
    }
    any.then_some((rx, tx))
}

/// cgroup v2 `cpu.stat` `usage_usec`, seconds.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_cgroup_usage(text: &str) -> Option<f64> {
    let line = text.lines().find(|l| l.starts_with("usage_usec "))?;
    let us: u64 = line["usage_usec ".len()..].trim().parse().ok()?;
    Some(us as f64 / 1_000_000.0)
}

/// cgroup v2 `cpu.max` (`max 100000` or `<quota> <period>`): the cores the cgroup may use, None when unlimited.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_cpu_max(text: &str) -> Option<f64> {
    let mut it = text.split_whitespace();
    let quota = it.next()?;
    let period: f64 = it.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    let q: f64 = quota.parse().ok()?;
    (q > 0.0).then(|| q / period)
}

/// cgroup v2 `memory.current` over `memory.max`, percent; None when the limit is `max`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_cgroup_memory(current: &str, max: &str) -> Option<f64> {
    let max = max.trim();
    if max == "max" {
        return None;
    }
    let (c, m): (u64, u64) = (current.trim().parse().ok()?, max.parse().ok()?);
    (m > 0).then(|| c.min(m) as f64 / m as f64 * 100.0)
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::fs::read_to_string;

    extern "C" {
        fn sysconf(name: i32) -> i64;
    }
    /// `_SC_CLK_TCK` on Linux (glibc and musl).
    const SC_CLK_TCK: i32 = 2;

    fn clk_tck() -> f64 {
        // SAFETY: sysconf takes an integer name and returns a value or -1; no memory is touched.
        let t = unsafe { sysconf(SC_CLK_TCK) };
        if t > 0 {
            t as f64
        } else {
            100.0
        }
    }

    pub fn read() -> OsReading {
        let at = Instant::now();
        let process_cpu = read_to_string("/proc/self/stat").ok().and_then(|t| parse_self_stat_ticks(&t)).map(|t| t as f64 / clk_tck());
        let host_cpu = read_to_string("/proc/stat").ok().and_then(|t| parse_proc_stat(&t));
        // Inside a container (a cgroup v2 namespace whose root is not the host's: the host's root cgroup has no
        // memory.current), the cgroup's own CPU and memory are the "host".
        let cg = std::path::Path::new("/sys/fs/cgroup");
        let in_container = cg.join("memory.current").is_file();
        let (cgroup_cpu, cgroup_mem) = if in_container {
            let usage = read_to_string(cg.join("cpu.stat")).ok().and_then(|t| parse_cgroup_usage(&t));
            let limit = read_to_string(cg.join("cpu.max")).ok().and_then(|t| parse_cpu_max(&t)).unwrap_or_else(cores).min(cores());
            let mem = match (read_to_string(cg.join("memory.current")), read_to_string(cg.join("memory.max"))) {
                (Ok(c), Ok(m)) => parse_cgroup_memory(&c, &m),
                _ => None,
            };
            (usage.map(|u| (u, limit)), mem)
        } else {
            (None, None)
        };
        let mem_host_used = cgroup_mem.or_else(|| read_to_string("/proc/meminfo").ok().and_then(|t| parse_meminfo(&t)));
        OsReading {
            at,
            process_cpu,
            host_cpu,
            cgroup_cpu,
            mem_process: read_to_string("/proc/self/status").ok().and_then(|t| parse_vmrss(&t)),
            mem_host_used,
            net: read_to_string("/proc/net/dev").ok().and_then(|t| parse_net_dev(&t)),
            cores: cores(),
        }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn ticks(self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }

    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessTimes(process: *mut c_void, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetIfTable2(table: *mut *mut c_void) -> u32;
        fn FreeMibTable(memory: *mut c_void);
    }

    // MIB_IF_TABLE2: a ULONG count, then MIB_IF_ROW2 rows from offset 8, each 1352 bytes (netioapi.h, x86 and x64).
    const ROWS_AT: usize = 8;
    const ROW_SIZE: usize = 1352;
    const ROW_TYPE: usize = 1128;
    const ROW_FLAGS: usize = 1152;
    const ROW_IN_OCTETS: usize = 1208;
    const ROW_OUT_OCTETS: usize = 1280;
    /// IF_TYPE_SOFTWARE_LOOPBACK.
    const LOOPBACK: u32 = 24;
    /// InterfaceAndOperStatusFlags.FilterInterface: a filter module's view of another interface (counted there).
    const FILTER_INTERFACE: u8 = 0b10;
    const ROWS_MAX: u32 = 4096;

    fn net() -> Option<(u64, u64)> {
        let mut table: *mut c_void = std::ptr::null_mut();
        // SAFETY: GetIfTable2 allocates the table and writes its pointer; it is freed once with FreeMibTable below.
        if unsafe { GetIfTable2(&mut table) } != 0 || table.is_null() {
            return None;
        }
        let base = table as *const u8;
        // SAFETY: the table starts with its ULONG row count.
        let n = unsafe { std::ptr::read_unaligned(base as *const u32) }.min(ROWS_MAX) as usize;
        let (mut rx, mut tx) = (0u64, 0u64);
        for i in 0..n {
            // SAFETY: row i lies inside the table GetIfTable2 sized for `n` rows; fields are read unaligned by offset.
            unsafe {
                let row = base.add(ROWS_AT + i * ROW_SIZE);
                let kind = std::ptr::read_unaligned(row.add(ROW_TYPE) as *const u32);
                let flags = std::ptr::read_unaligned(row.add(ROW_FLAGS));
                if kind == LOOPBACK || flags & FILTER_INTERFACE != 0 {
                    continue;
                }
                rx = rx.saturating_add(std::ptr::read_unaligned(row.add(ROW_IN_OCTETS) as *const u64));
                tx = tx.saturating_add(std::ptr::read_unaligned(row.add(ROW_OUT_OCTETS) as *const u64));
            }
        }
        // SAFETY: `table` came from GetIfTable2 and is freed exactly once.
        unsafe { FreeMibTable(table) };
        Some((rx, tx))
    }

    pub fn read() -> OsReading {
        let at = Instant::now();
        // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing.
        let process = unsafe { GetCurrentProcess() };
        let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
        // SAFETY: every out pointer is a valid FileTime.
        let process_cpu = (unsafe { GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u) } != 0).then(|| (k.ticks() + u.ticks()) as f64 / 10_000_000.0);
        let (mut idle, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default());
        // SAFETY: every out pointer is a valid FileTime. Kernel time includes idle time.
        let host_cpu = if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0 {
            kernel.ticks().checked_add(user.ticks()).and_then(|total| Some((total.checked_sub(idle.ticks())? as f64, total as f64)))
        } else {
            None
        };
        let mut pmc = ProcessMemoryCounters { cb: std::mem::size_of::<ProcessMemoryCounters>() as u32, ..Default::default() };
        // SAFETY: `pmc` is writable for `cb` bytes.
        let mem_process = (unsafe { K32GetProcessMemoryInfo(process, &mut pmc, pmc.cb) } != 0).then_some(pmc.working_set_size as u64);
        let mut ms = MemoryStatusEx { length: std::mem::size_of::<MemoryStatusEx>() as u32, ..Default::default() };
        // SAFETY: `ms` is a MEMORYSTATUSEX with its length set.
        let mem_host_used = (unsafe { GlobalMemoryStatusEx(&mut ms) } != 0 && ms.total_phys > 0)
            .then(|| (ms.total_phys - ms.avail_phys.min(ms.total_phys)) as f64 / ms.total_phys as f64 * 100.0);
        OsReading { at, process_cpu, host_cpu, cgroup_cpu: None, mem_process, mem_host_used, net: net(), cores: cores() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_metrics::validate;

    fn reading(at: Instant, cpu: f64, host: (f64, f64), net: (u64, u64)) -> OsReading {
        OsReading { at, process_cpu: Some(cpu), host_cpu: Some(host), cgroup_cpu: None, mem_process: Some(50 << 20), mem_host_used: Some(42.123), net: Some(net), cores: 4.0 }
    }

    #[test]
    fn probe_readings_are_numbers_or_null_and_never_panic() {
        // Whatever this OS offers (Linux, Windows or neither): two readings, each value null or a finite number.
        let a = OsReading::read();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let b = OsReading::read();
        let v = os_values(Some(&a), &b);
        for x in [v.cpu_process, v.cpu_host, v.mem_process, v.mem_host_used, v.net_in, v.net_out].into_iter().flatten() {
            assert!(x.is_finite() && x >= 0.0, "{x}");
        }
        if let Some(p) = v.cpu_process.or(v.cpu_host).or(v.mem_host_used) {
            assert!(p <= 100.0);
        }
        #[cfg(any(target_os = "linux", windows))]
        {
            assert!(b.process_cpu.is_some() && b.mem_process.is_some() && b.mem_host_used.is_some(), "{b:?}");
            assert!(b.host_cpu.is_some() || b.cgroup_cpu.is_some(), "{b:?}");
        }
        // The first reading after start has no interval: CPU and network are null, memory is there.
        let first = os_values(None, &b);
        assert!(first.cpu_process.is_none() && first.cpu_host.is_none() && first.net_in.is_none());
    }

    #[test]
    fn snapshots_pass_the_consoles_validation_for_both_products() {
        for product in [Product::Spokes, Product::Meet] {
            let s1 = snapshot(product);
            let s2 = snapshot(product);
            assert!(s2["seq"].as_i64() > s1["seq"].as_i64());
            for s in [&s1, &s2] {
                assert_eq!(s["v"], 1);
                assert_eq!(s["interval"], 60);
                let m = s["m"].as_object().unwrap();
                let want: Vec<&str> = KEYS.iter().filter(|k| k.of(product)).map(|k| k.key).collect();
                assert_eq!(m.keys().map(String::as_str).collect::<Vec<_>>(), want, "every key of the product, in 9.1 order");
                validate(s, product, None, s["ts"].as_i64().unwrap()).unwrap_or_else(|w| panic!("{product:?} {w:?}: {s}"));
            }
        }
    }

    #[test]
    fn os_deltas_give_percent_and_bytes() {
        let t0 = Instant::now();
        let t1 = t0 + std::time::Duration::from_secs(60);
        let a = reading(t0, 10.0, (1000.0, 4000.0), (1_000, 2_000));
        let b = reading(t1, 70.0, (2000.0, 6000.0), (5_000, 2_500));
        let v = os_values(Some(&a), &b);
        assert_eq!(v.cpu_process, Some(25.0)); // 60 s of CPU over 60 s on 4 cores
        assert_eq!(v.cpu_host, Some(50.0));
        assert_eq!((v.net_in, v.net_out), (Some(4_000.0), Some(500.0)));
        assert_eq!(v.mem_host_used, Some(42.12));
        // a counter going down (an interface reset) gives no network value
        let c = reading(t1, 70.0, (2000.0, 6000.0), (10, 2_500));
        assert!(os_values(Some(&a), &c).net_in.is_none());
        // a cgroup's own usage over its cores wins over the host's
        let mut ca = a;
        let mut cb = b;
        ca.cgroup_cpu = Some((100.0, 2.0));
        cb.cgroup_cpu = Some((130.0, 2.0));
        assert_eq!(os_values(Some(&ca), &cb).cpu_host, Some(25.0));
    }

    #[test]
    fn linux_files_parse_and_garbage_gives_none() {
        let stat = "1234 (lucid relay (x)) S 1 1234 1234 0 -1 4194560 2510 0 0 0 150 50 0 0 20 0 9 0 12345 1000 200 ";
        assert_eq!(parse_self_stat_ticks(stat), Some(200));
        assert_eq!(parse_proc_stat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n"), Some((150.0, 1000.0)));
        assert_eq!(parse_vmrss("Name:\tx\nVmRSS:\t  2048 kB\n"), Some(2048 * 1024));
        assert_eq!(parse_meminfo("MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable:  250 kB\n"), Some(75.0));
        let dev = "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n  eth1: 5 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n";
        assert_eq!(parse_net_dev(dev), Some((105, 207)));
        assert_eq!(parse_cgroup_usage("usage_usec 2500000\nuser_usec 1\n"), Some(2.5));
        assert_eq!(parse_cpu_max("200000 100000\n"), Some(2.0));
        assert_eq!(parse_cpu_max("max 100000\n"), None);
        assert_eq!(parse_cgroup_memory("512\n", "1024\n"), Some(50.0));
        assert_eq!(parse_cgroup_memory("512\n", "max\n"), None);
        for junk in ["", "garbage", "cpu x y z", ")))", "\u{0}\u{1}"] {
            assert_eq!(parse_self_stat_ticks(junk), None);
            assert_eq!(parse_proc_stat(junk), None);
            assert_eq!(parse_vmrss(junk), None);
            assert_eq!(parse_meminfo(junk), None);
            assert_eq!(parse_net_dev(junk), None);
            assert_eq!(parse_cgroup_usage(junk), None);
            assert_eq!(parse_cpu_max(junk), None);
        }
    }

    #[test]
    fn counters_count_the_interval_and_reset() {
        let owned = Counters::default();
        let c = &owned;
        c.message(3);
        c.message(2);
        c.spoke_mail("n_a");
        c.spoke_mail("n_a");
        c.spoke_mail("n_b");
        for _ in 0..6 {
            c.participants_sample(10); // one minute of 10 people
        }
        c.quota_hit();
        for ms in [30, 10, 20, 40] {
            c.ping_rtt(ms);
        }
        let g1 = c.conn_open();
        let g2 = c.conn_open();
        drop(g1);
        c.set_mgmt_not_after(Some(10 * DAY_MS + 5));
        let mut src = Map::new();
        src.insert("people_online".into(), Value::from(7));
        src.insert("license_state".into(), Value::from(9)); // out of bound: sent as null
        src.insert("cpu_host".into(), Value::from(1)); // not a source key: ignored
        src.insert("calls_active".into(), Value::from(1)); // a Meeting Hub key on Remote Spokes: never sent
        let now = 0;
        let r = reading(Instant::now(), 0.0, (0.0, 1.0), (0, 0));
        let s = build(Product::Spokes, now, 1, None, &r, c.take_interval(), &src, c);
        let m = &s["m"];
        assert_eq!(m["messages"], 5);
        assert_eq!(m["spokes_busy"], 2);
        assert_eq!(m["quota_hits"], 1);
        assert_eq!(m["latency_console"], 25.0);
        assert_eq!(m["conn_open"], 1);
        assert_eq!(m["cert_mgmt_days"], 10);
        assert_eq!(m["people_online"], 7);
        assert_eq!(m["license_state"], Value::Null);
        assert_eq!(m["cpu_host"], Value::Null);
        assert!(m.get("calls_active").is_none() && m.get("call_minutes").is_none());
        let meet = build(Product::Meet, now, 2, None, &r, Interval { messages: 0, participant_samples: 60, quota_hits: 0, busy_spokes: 0, latency: None }, &Map::new(), c);
        assert_eq!(meet["m"]["call_minutes"], 10);
        assert!(meet["m"].get("spokes_busy").is_none());
        // the interval values were taken: a second take is empty
        let again = c.take_interval();
        assert_eq!((again.messages, again.busy_spokes, again.quota_hits, again.latency), (0, 0, 0, None));
        drop(g2);
        assert_eq!(c.conn_open.load(Ordering::Relaxed), 0);
    }
}
