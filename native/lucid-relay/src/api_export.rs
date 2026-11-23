// Contract API-1 (docs/api/contract.md) 11.4 to 11.7 with 9.4 and 9.5 (the retention hold) and 13 (edition limits):
// the console's export engine. The console is the egress in normal mode; in catastrophe mode (12) a relay runs the
// same engine over its own records through `api_failover`, whose `Host` adds a failover gate per destination.
//
// Config: the destinations of every org whose pinned map serves (not set aside, not expired), with the journal's
// destination tightenings applied at once (`effective`); the standard edition allows one `otlp` destination plus
// `syslog_cef`, no `splunk_hec`, no `azure_logs`, and turns pseudonymized identities into removed ones. Destination
// ids are unique only within one org's map, so everything is keyed by (org, id): runtimes, queues
// (`exports/<org>/<id>/`), cursors and the sealed credential (`secret:<org>:<id>`). A destination whose org stops
// serving is suspended (its queues kept), and so is one whose map's `expires` passes, at that instant; one that is
// absent from a serving map, or has an active `destination_delete`, stops at once and its queues and sealed
// credential are removed.
//
// A config change takes the destination's send lock (so it waits for a delivery in flight), then bumps the
// destination's generation under its queue lock. Records transformed under an older generation are refused at the
// queue (`enqueue` returns false and the work is done again under the new config), and every send checks the
// generation and the map's expiry right before it leaves.
//
// Sources: audit (the org's chains: the console's own and every relay chain it stores, in the representation the
// destination's `identities` selects, in seq order, pulled every 2 s from a durable cursor per source), metrics (the
// front door's `v1/metrics` exposition of the org each minute, labels through `transform_labels`, counters turned
// into deltas for `temporality: delta`), logs (catalog-listed log events that name an org, from the logger tap) and
// traces (one span per API call, sampled per destination in parts per million). Every record passes 11.5
// (`api_catalog::transform_record`); a refused one is counted (`lucid_export_refused_total`) and summarized per
// minute and reason as `exports.refused` in the org's chain.
//
// Queues (11.6): one owner-only disk queue per destination and signal (`exports/<org>/<id>/<signal>/`, JSONL
// segments of 8 MiB named by their first record number and a flushed `head.json`). Only the pending records of the
// oldest segment are held in memory; later segments are kept as counts, bytes and audit marks. At least once and in
// order per signal, batches of at most 1000 records or 1 MiB, backoff from 1 s to 5 minutes with jitter.
// `queue.max_bytes` bounds the destination's whole backlog: metrics, logs and traces lose their oldest records
// first (counted `dropped`), and their age over `queue.max_age_s` drops them too; audit is never dropped: when audit
// alone fills the limit or grows too old the destination stops pulling (`paused`, `ExportAuditBacklog`) and the
// retention hold keeps every chain entry from the lowest seq not yet acknowledged. Producers on call paths never
// block: logs and spans have their own bounded intake (a full one drops the new record, counted
// `export_failures{reason="intake"}`), metric samples another that evicts its oldest.
//
// Audit records are 10.3 log records: `lucid.chain` is the representation's label with the source appended
// (`lucid-api-audit-as-is-v1:acme/console`), because each source has its own chain and seq; `lucid.event_id` is
// `<lucid.chain>:<seq>`.

use crate::api_audit::Repr;
use crate::api_catalog::{self as catalog, Ceiling, Identities, MetricKind};
use crate::api_export_wire::{Batch, Credential, Signal, Sink, SinkError};
use crate::api_map::{Edition, TightenEntry};
use crate::codec::{hex, now_ms, sha256, stringify};
use crate::log::{Fields, Level, Logger};
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

/// The folder under the console's state folder.
pub const EXPORTS_DIR: &str = "exports";
/// 11.6 batch limits.
pub const BATCH_RECORDS: usize = 1000;
pub const BATCH_BYTES: usize = 1 << 20;
/// 11.6 backoff.
pub const BACKOFF_FIRST_MS: i64 = 1_000;
pub const BACKOFF_MAX_MS: i64 = 300_000;
/// The bounded intake of log events and spans.
pub const INTAKE_MAX: usize = 4096;
/// The bounded intake of metric samples (one item per org and minute).
pub const METRICS_INTAKE: usize = 64;
/// 11.3: "rotate by" 90 days after a token or service account key is entered.
pub const ROTATE_DAYS: i64 = 90;
/// Every signal, in queue index order.
pub const SIGNALS: [Signal; 4] = [Signal::Audit, Signal::Logs, Signal::Traces, Signal::Metrics];
const SEGMENT_BYTES: u64 = 8 << 20;
const AUDIT_PAGE: usize = 1000;
/// Pages pulled per source in one pull, so one busy chain does not hold the others back.
const AUDIT_PAGES: usize = 16;
const PULL_MS: i64 = 2_000;
const KEY_TTL_MS: i64 = 10_000;
const SAMPLING_ALL: u64 = 1_000_000;
/// Bytes a queue line adds to its record (number, time, mark).
const LINE_OVERHEAD: u64 = 48;
const HEAD_FILE: &str = "head.json";
const META_FILE: &str = "meta.json";
const CURSORS_FILE: &str = "cursors.json";
const SPAN_TYPE: &str = "api.span";

/// (org, destination id).
type Key = (String, String);

fn idx(s: Signal) -> usize {
    match s {
        Signal::Audit => 0,
        Signal::Logs => 1,
        Signal::Traces => 2,
        Signal::Metrics => 3,
    }
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// A path part that came from a signed map (an org id or a destination id): letters, digits, `-` and `_` only.
fn part_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ── credentials (11.3) ───────────────────────────────────────────────────────────────────────────────────────────

/// The sealed name of a destination's credential. The map references it as `secret:<id>` (unique within the map);
/// the console's store holds every org's, so the org is part of the name.
pub fn seal_name(org: &str, id: &str) -> String {
    format!("secret:{org}:{id}")
}

/// The 11.3 `credential.type` a credential is for (None for `Credential::None`).
pub fn credential_type(c: &Credential) -> Option<&'static str> {
    match c {
        Credential::None => None,
        Credential::Token(_) => Some("token"),
        Credential::Mtls { .. } => Some("mtls"),
        Credential::EntraCertificate { .. } => Some("entra_certificate"),
        Credential::AwsRolesAnywhere { .. } => Some("aws_roles_anywhere"),
        Credential::GcpServiceAccountKey(_) => Some("gcp_service_account_key"),
    }
}

/// Whether a credential fits the map entry's `credential` (its type, and the public fields the map names).
pub fn credential_fits(destination: &Value, c: &Credential) -> bool {
    let Some(want) = destination.get("credential") else { return matches!(c, Credential::None) };
    if credential_type(c) != want.get("type").and_then(Value::as_str) {
        return false;
    }
    let same = |k: &str, v: &str| want.get(k).and_then(Value::as_str) == Some(v);
    match c {
        Credential::EntraCertificate { tenant, client_id, cloud, .. } => same("tenant", tenant) && same("client_id", client_id) && same("cloud", cloud),
        Credential::AwsRolesAnywhere { trust_anchor_arn, profile_arn, role_arn, region, .. } => {
            same("trust_anchor_arn", trust_anchor_arn) && same("profile_arn", profile_arn) && same("role_arn", role_arn) && same("region", region)
        }
        _ => true,
    }
}

/// The sealed form of a credential (never logged).
pub fn credential_json(c: &Credential) -> Value {
    match c {
        Credential::None => json!({"type": "none"}),
        Credential::Token(t) => json!({"type": "token", "token": t}),
        Credential::Mtls { cert_pem, key_pem, ca_pem } => {
            let mut v = json!({"type": "mtls", "cert_pem": cert_pem, "key_pem": key_pem});
            if let Some(ca) = ca_pem {
                v["ca_pem"] = json!(ca);
            }
            v
        }
        Credential::EntraCertificate { tenant, client_id, cloud, cert_pem, key_pem } => {
            json!({"type": "entra_certificate", "tenant": tenant, "client_id": client_id, "cloud": cloud, "cert_pem": cert_pem, "key_pem": key_pem})
        }
        Credential::AwsRolesAnywhere { trust_anchor_arn, profile_arn, role_arn, region, cert_pem, key_pem } => json!({
            "type": "aws_roles_anywhere", "trust_anchor_arn": trust_anchor_arn, "profile_arn": profile_arn, "role_arn": role_arn,
            "region": region, "cert_pem": cert_pem, "key_pem": key_pem,
        }),
        Credential::GcpServiceAccountKey(k) => json!({"type": "gcp_service_account_key", "key": k}),
    }
}

/// `credential_json` read back.
pub fn credential_of(v: &Value) -> Option<Credential> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(match v.get("type")?.as_str()? {
        "none" => Credential::None,
        "token" => Credential::Token(s("token")?),
        "mtls" => Credential::Mtls { cert_pem: s("cert_pem")?, key_pem: s("key_pem")?, ca_pem: s("ca_pem") },
        "entra_certificate" => Credential::EntraCertificate { tenant: s("tenant")?, client_id: s("client_id")?, cloud: s("cloud")?, cert_pem: s("cert_pem")?, key_pem: s("key_pem")? },
        "aws_roles_anywhere" => Credential::AwsRolesAnywhere {
            trust_anchor_arn: s("trust_anchor_arn")?,
            profile_arn: s("profile_arn")?,
            role_arn: s("role_arn")?,
            region: s("region")?,
            cert_pem: s("cert_pem")?,
            key_pem: s("key_pem")?,
        },
        "gcp_service_account_key" => Credential::GcpServiceAccountKey(s("key")?),
        _ => return None,
    })
}

/// The sealed value of a destination credential: the credential, when it was entered and, for vendor tokens and
/// service account keys (11.3), its "rotate by" date (unix seconds).
pub fn sealed_credential(c: &Credential, now: i64) -> Value {
    let mut v = json!({"credential": credential_json(c), "entered": now});
    if matches!(c, Credential::Token(_) | Credential::GcpServiceAccountKey(_)) {
        v["rotate_by"] = json!(now + ROTATE_DAYS * 86_400);
    }
    v
}

// ── config (11.1, 11.4, 11.5, 13) ────────────────────────────────────────────────────────────────────────────────

/// One org as the console holds it.
#[derive(Clone, Debug)]
pub struct OrgConfig {
    pub org: String,
    /// The pinned map serves: held and not set aside (13). Otherwise every destination of the org is suspended and
    /// its queues kept.
    pub serving: bool,
    /// The pinned map's `expires` (unix seconds): at that instant the org's exports stop (2.2, 12.4).
    pub expires: i64,
    /// The pinned map's `destinations`.
    pub destinations: Vec<Value>,
    /// The org's active journal entries (2.5).
    pub active: Vec<TightenEntry>,
}

/// A destination after the journal and the edition.
#[derive(Clone, Debug, PartialEq)]
pub struct Dest {
    pub org: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub signals: Vec<Signal>,
    pub ceiling: Ceiling,
    pub identities: Identities,
    pub suspended: bool,
    /// Why the edition refuses it (state `failed` with this sentence).
    pub refused: Option<String>,
    /// The map's `expires` (unix seconds).
    pub expires: i64,
    pub max_bytes: u64,
    pub max_age_s: i64,
    /// Traces kept, parts per million.
    pub sampling_ppm: u64,
    /// `delta` or `cumulative` for counters.
    pub temporality: &'static str,
    /// The map entry with the tightened `signals`, `ceiling` and `identities`, as `sink_for` gets it.
    pub entry: Value,
}

impl Dest {
    fn expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires.saturating_mul(1000)
    }

    fn live(&self, now_ms: i64) -> bool {
        !self.suspended && self.refused.is_none() && !self.expired(now_ms)
    }

    fn carries(&self, s: Signal) -> bool {
        self.signals.contains(&s)
    }

    fn key(&self) -> Key {
        (self.org.clone(), self.id.clone())
    }
}

fn ident_rank(i: Identities) -> u8 {
    match i {
        Identities::AsIs => 0,
        Identities::Pseudonymized => 1,
        Identities::Removed => 2,
    }
}

fn repr_rank(r: Repr) -> u8 {
    match r {
        Repr::AsIs => 0,
        Repr::Pseudonymized => 1,
        Repr::Removed => 2,
    }
}

/// 9.3: the audit representation a destination's `identities` selects.
pub fn repr_of(i: Identities) -> Repr {
    match i {
        Identities::AsIs => Repr::AsIs,
        Identities::Pseudonymized => Repr::Pseudonymized,
        Identities::Removed => Repr::Removed,
    }
}

/// One map destination with the org's active journal entries (2.5) and the license edition (13). None when an
/// active `destination_delete` names it or the entry does not read. `otlp_before` counts the `otlp` destinations
/// listed before it in the map (the standard edition allows the first one). `expires` is left open (`i64::MAX`);
/// `refresh` sets the map's.
pub fn effective(org: &str, d: &Value, active: &[TightenEntry], edition: Option<Edition>, otlp_before: usize) -> Option<Dest> {
    let id = d.get("id")?.as_str()?.to_string();
    if !part_ok(org) || !part_ok(&id) {
        return None;
    }
    let names = |e: &&TightenEntry| e.target.as_str() == Some(id.as_str()) || e.target.get("destination").and_then(Value::as_str) == Some(id.as_str());
    let entries: Vec<&TightenEntry> = active.iter().filter(|e| e.action.starts_with("destination_")).filter(names).collect();
    if entries.iter().any(|e| e.action == "destination_delete") {
        return None;
    }
    let mut signals: Vec<Signal> = SIGNALS.iter().copied().filter(|s| d.get("signals").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(s.name())))).collect();
    let mut ceiling = Ceiling::of(text(d, "ceiling"))?;
    let mut identities = Identities::of(text(d, "identities"))?;
    let mut suspended = false;
    for e in &entries {
        let field = |k: &str| e.target.get(k).and_then(Value::as_str).unwrap_or_default();
        match e.action.as_str() {
            "destination_suspend" => suspended = true,
            "destination_drop_signal" => signals.retain(|s| s.name() != field("signal")),
            "destination_lower_ceiling" => {
                if let Some(c) = Ceiling::of(field("ceiling")) {
                    ceiling = ceiling.min(c);
                }
            }
            "destination_identities" => {
                if let Some(i) = Identities::of(field("identities")).filter(|i| ident_rank(*i) > ident_rank(identities)) {
                    identities = i;
                }
            }
            _ => {}
        }
    }
    let kind = text(d, "kind").to_string();
    let refused = match edition {
        None => Some("The license edition is not known, so nothing is exported.".to_string()),
        Some(Edition::Standard) => {
            // never wider: the standard edition has no pseudonymized identities, so removed stands in
            if identities == Identities::Pseudonymized {
                identities = Identities::Removed;
            }
            match kind.as_str() {
                "splunk_hec" | "azure_logs" => Some(format!("The standard edition does not include {kind} destinations.")),
                "otlp" if otlp_before > 0 => Some("The standard edition allows one otlp destination.".to_string()),
                _ => None,
            }
        }
        Some(Edition::Enterprise) => None,
    };
    let settings = d.get("settings");
    let preset = crate::api_export_wire::preset(text(d, "preset"));
    let temporality = match settings.and_then(|s| s.get("temporality")).and_then(Value::as_str) {
        Some("delta") => "delta",
        Some("cumulative") => "cumulative",
        _ => preset.map_or("cumulative", |p| if p.temporality == "delta" { "delta" } else { "cumulative" }),
    };
    let sampling_ppm = settings.and_then(|s| s.get("sampling")).and_then(Value::as_u64).map_or(SAMPLING_ALL, |n| n.min(SAMPLING_ALL));
    let q = d.get("queue");
    let max_bytes = q.and_then(|q| q.get("max_bytes")).and_then(Value::as_u64).unwrap_or(1 << 30);
    let max_age_s = q.and_then(|q| q.get("max_age_s")).and_then(Value::as_i64).unwrap_or(259_200);
    let mut entry = d.clone();
    entry["signals"] = json!(signals.iter().map(|s| s.name()).collect::<Vec<_>>());
    entry["ceiling"] = json!(ceiling.as_str());
    entry["identities"] = json!(identities.as_str());
    Some(Dest {
        org: org.to_string(),
        id,
        name: text(d, "name").to_string(),
        kind,
        signals,
        ceiling,
        identities,
        suspended,
        refused,
        expires: i64::MAX,
        max_bytes,
        max_age_s,
        sampling_ppm,
        temporality,
        entry,
    })
}

// ── what the engine needs of the console ─────────────────────────────────────────────────────────────────────────

/// One sample: a Prometheus family (or a sample of it), its labels and value.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricRow {
    pub prom: String,
    pub labels: Vec<(String, String)>,
    pub value: f64,
}

/// The console behind the engine (`console_fleet::ExportHost`; tests stand in fakes).
pub trait Host: Send + Sync {
    /// The license edition (None: unknown) and every org with a pinned map.
    fn config(&self, now: i64) -> (Option<Edition>, Vec<OrgConfig>);
    /// The sealed credential of a destination.
    fn credential(&self, org: &str, id: &str) -> Option<Credential>;
    /// Drop a deleted destination's sealed credential.
    fn delete_credential(&self, org: &str, id: &str);
    /// The org's pseudonym key (pkv, key).
    fn pseudonym_key(&self, org: &str) -> Option<(u32, Vec<u8>)>;
    /// `console` and every relay whose chains the console stores for the org.
    fn audit_sources(&self, org: &str) -> Vec<String>;
    /// Entries after `after` of one chain.
    fn audit_read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Vec<Value>;
    /// Record one entry in the org's console chain (`exports.refused`, `exports.failed`).
    fn audit_record(&self, org: &str, entry: Value, now: i64);
    /// The org's relays' latest snapshots and the console's counters for the org (raw labels).
    fn metric_rows(&self, org: &str, now: i64) -> Vec<MetricRow>;
    /// 10.2 resource attributes.
    fn resource(&self, org: &str) -> Vec<(String, String)>;
    /// The sink for a destination entry (`syslog_cef` through `fleet_syslog::cef_sink`, the rest `sink_for`).
    fn make_sink(&self, destination: &Value, credential: Credential) -> Result<Box<dyn Sink>, SinkError>;
    /// A relay's failover gate on one map entry (12.2, 12.3; `api_failover`). The console has none: None leaves the
    /// destination as the map and the journal make it.
    fn failover_gate(&self, _org: &str, _entry: &Value, _now: i64) -> Option<Gate> {
        None
    }
}

/// What a relay adds to a failover destination (12.2, 12.3).
#[derive(Clone, Debug, Default)]
pub struct Gate {
    /// The org is in failover: direct delivery runs. Off, the destination is suspended and its queues kept.
    pub on: bool,
    /// The end of the destination's installed failover credential (unix seconds, 0 without one): the destination
    /// stops at that instant, as at the map's `expires`, and never runs past it.
    pub until: i64,
    /// Per audit source, the first seq of each representation (`Repr::ALL` order) to deliver: the org's
    /// `relay.failover.on` entry. A destination's audit cursor is raised to just before it, never lowered.
    pub from: Vec<(String, [u64; 3])>,
}

// ── the disk queue (11.6) ────────────────────────────────────────────────────────────────────────────────────────

/// One pending record of the oldest segment.
struct Rec {
    n: u64,
    t_ms: i64,
    off: u64,
    len: u32,
    /// Audit: (source, seq).
    mark: Option<(String, u64)>,
}

/// What is kept of a segment without its records: numbers, file length, pending count and bytes, and the first and
/// last audit seq of each source it holds.
#[derive(Default)]
struct Seg {
    first: u64,
    /// One past the last record number in the file.
    next: u64,
    len: u64,
    count: u64,
    bytes: u64,
    first_marks: BTreeMap<String, u64>,
    last_marks: BTreeMap<String, u64>,
}

impl Seg {
    fn note(&mut self, r: &Rec) {
        self.count += 1;
        self.bytes += u64::from(r.len);
        if let Some((s, q)) = &r.mark {
            self.first_marks.entry(s.clone()).or_insert(*q);
            let l = self.last_marks.entry(s.clone()).or_insert(*q);
            *l = (*l).max(*q);
        }
    }
}

fn seg_path(dir: &Path, first: u64) -> PathBuf {
    dir.join(format!("{first:020}.jsonl"))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn sync_dir(_dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(_dir) {
        let _ = d.sync_all();
    }
}

/// Read a segment file line by line (never whole): its metadata for the records numbered from `head`, those records
/// when `keep`, and the length of its complete, readable prefix with the file's size (a torn tail is cut by the
/// caller).
fn scan(path: &Path, first: u64, head: u64, keep: bool) -> (Seg, Vec<Rec>, u64, u64) {
    let mut seg = Seg { first, next: first, ..Seg::default() };
    let mut recs = Vec::new();
    let Ok(f) = std::fs::File::open(path) else { return (seg, recs, 0, 0) };
    let size = f.metadata().map_or(0, |m| m.len());
    let mut r = std::io::BufReader::new(f);
    let mut line = Vec::new();
    let mut off = 0u64;
    loop {
        line.clear();
        let Ok(got) = r.read_until(b'\n', &mut line) else { break };
        if got == 0 || line.last() != Some(&b'\n') {
            break;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line[..got - 1]) else { break };
        let Some(n) = v.get("n").and_then(Value::as_u64) else { break };
        seg.next = n + 1;
        if n >= head {
            let mark = v.get("s").and_then(Value::as_str).zip(v.get("q").and_then(Value::as_u64)).map(|(s, x)| (s.to_string(), x));
            let rec = Rec { n, t_ms: v.get("t").and_then(Value::as_i64).unwrap_or(0), off, len: (got - 1) as u32, mark };
            seg.note(&rec);
            if keep {
                recs.push(rec);
            }
        }
        off += got as u64;
    }
    seg.len = off;
    (seg, recs, off, size)
}

/// Records numbered from 1: JSONL segments `<first n, 20 digits>.jsonl` and `head.json` (the first record not yet
/// acknowledged or dropped), flushed before any caller goes on. Only the pending records of the oldest segment are in
/// memory (`cur`); every later segment is a `Seg`.
struct Queue {
    dir: PathBuf,
    seg_bytes: u64,
    head: u64,
    next: u64,
    segs: VecDeque<Seg>,
    cur: VecDeque<Rec>,
    bytes: u64,
    count: u64,
    /// `head` moved since `head.json` was written.
    dirty: bool,
}

impl Queue {
    fn open(dir: PathBuf, seg_bytes: u64) -> Queue {
        let mut q = Queue { dir, seg_bytes, head: 1, next: 1, segs: VecDeque::new(), cur: VecDeque::new(), bytes: 0, count: 0, dirty: false };
        if let Some(h) = read_json(&q.dir.join(HEAD_FILE)).and_then(|v| v.get("head")?.as_u64()) {
            q.head = h.max(1);
        }
        q.next = q.head;
        let mut firsts: Vec<u64> = std::fs::read_dir(&q.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".jsonl")?.parse::<u64>().ok())
            .collect();
        firsts.sort_unstable();
        for first in firsts {
            let path = seg_path(&q.dir, first);
            let keep = q.segs.is_empty();
            let (seg, recs, good, size) = scan(&path, first, q.head, keep);
            if good < size {
                // a torn tail: keep the verified prefix
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&path) {
                    let _ = f.set_len(good).and_then(|_| f.sync_all());
                }
            }
            q.next = q.next.max(seg.next);
            if seg.count == 0 {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if keep {
                q.cur = recs.into();
            }
            q.bytes += seg.bytes;
            q.count += seg.count;
            q.segs.push_back(seg);
        }
        q
    }

    fn is_empty(&self) -> bool {
        self.count == 0
    }

    fn oldest(&self) -> Option<i64> {
        self.cur.front().map(|r| r.t_ms)
    }

    /// Append records (record, enqueue time ms, audit mark), flushed before Ok.
    fn append(&mut self, items: Vec<(Value, i64, Option<(String, u64)>)>) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        let first_n = self.next;
        let reuse = self.segs.back().is_some_and(|s| s.len < self.seg_bytes);
        let (seg_first, base) = match self.segs.back() {
            Some(s) if reuse => (s.first, s.len),
            _ => (first_n, 0),
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut recs = Vec::with_capacity(items.len());
        for (i, (rec, t, mark)) in items.into_iter().enumerate() {
            let n = first_n + i as u64;
            let mut line = json!({"n": n, "t": t, "r": rec});
            if let Some((s, x)) = &mark {
                line["s"] = json!(s);
                line["q"] = json!(x);
            }
            let text = stringify(&line);
            recs.push(Rec { n, t_ms: t, off: base + buf.len() as u64, len: text.len() as u32, mark });
            buf.extend_from_slice(text.as_bytes());
            buf.push(b'\n');
        }
        crate::store::make_dir(&self.dir).map_err(|e| e.to_string())?;
        let path = seg_path(&self.dir, seg_first);
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&path).map_err(|e| e.to_string())?;
        if let Err(e) = f.write_all(&buf).and_then(|_| f.sync_data()) {
            // nothing half written stays behind the next append
            let _ = f.set_len(base);
            return Err(e.to_string());
        }
        if !reuse {
            sync_dir(&self.dir);
            self.segs.push_back(Seg { first: seg_first, next: seg_first, ..Seg::default() });
        }
        let only = self.segs.len() == 1;
        let added = recs.len() as u64;
        if let Some(s) = self.segs.back_mut() {
            for r in &recs {
                s.note(r);
            }
            s.next = first_n + added;
            s.len = base + buf.len() as u64;
        }
        self.next = first_n + added;
        self.bytes += recs.iter().map(|r| u64::from(r.len)).sum::<u64>();
        self.count += added;
        if only {
            self.cur.extend(recs);
        }
        Ok(())
    }

    /// The oldest records, at most `max_n` and about `max_bytes` (at least one), from the oldest segment: (n, record).
    fn batch(&self, max_n: usize, max_bytes: usize) -> Result<Vec<(u64, Value)>, String> {
        let mut out = Vec::new();
        let Some(seg) = self.segs.front() else { return Ok(out) };
        let mut f = std::fs::File::open(seg_path(&self.dir, seg.first)).map_err(|e| e.to_string())?;
        let mut size = 0usize;
        for r in &self.cur {
            if !out.is_empty() && (out.len() >= max_n || size + r.len as usize > max_bytes) {
                break;
            }
            f.seek(SeekFrom::Start(r.off)).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; r.len as usize];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
            out.push((r.n, v.get("r").cloned().unwrap_or(Value::Null)));
            size += r.len as usize;
        }
        Ok(out)
    }

    /// Every record up to `upto` is done, in memory (`persist` writes `head.json`). Whole segments go with their
    /// files; the next oldest segment's pending records are read in.
    fn advance(&mut self, upto: u64) {
        if upto < self.head {
            return;
        }
        self.head = upto + 1;
        self.dirty = true;
        let mut reload = false;
        loop {
            while self.segs.front().is_some_and(|s| s.next <= self.head) {
                if let Some(s) = self.segs.pop_front() {
                    self.bytes -= s.bytes;
                    self.count -= s.count;
                    let _ = std::fs::remove_file(seg_path(&self.dir, s.first));
                }
                self.cur.clear();
                reload = true;
            }
            if !reload {
                while self.cur.front().is_some_and(|r| r.n < self.head) {
                    if let (Some(r), Some(s)) = (self.cur.pop_front(), self.segs.front_mut()) {
                        s.count -= 1;
                        s.bytes -= u64::from(r.len);
                        self.count -= 1;
                        self.bytes -= u64::from(r.len);
                    }
                }
                return;
            }
            let Some(s) = self.segs.front_mut() else { return };
            let (fresh, recs, _, _) = scan(&seg_path(&self.dir, s.first), s.first, self.head, true);
            self.bytes = self.bytes - s.bytes + fresh.bytes;
            self.count = self.count - s.count + fresh.count;
            let empty = fresh.count == 0;
            *s = Seg { len: s.len, next: s.next, ..fresh };
            self.cur = recs.into();
            if !empty {
                return;
            }
            // nothing pending or not readable: the segment goes, and the next one is read
            if let Some(s) = self.segs.pop_front() {
                let _ = std::fs::remove_file(seg_path(&self.dir, s.first));
            }
            self.cur.clear();
            if self.segs.is_empty() {
                return;
            }
            self.head = self.head.max(self.segs.front().map_or(self.head, |s| s.first));
        }
    }

    /// Write `head.json` (flushed) when it moved.
    fn persist(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        crate::store::make_dir(&self.dir).map_err(|e| e.to_string())?;
        crate::fleet_local::write_durable(&self.dir.join(HEAD_FILE), stringify(&json!({"head": self.head})).as_bytes())?;
        self.dirty = false;
        Ok(())
    }

    /// Every record up to `upto` is acknowledged; flushed before Ok.
    fn ack(&mut self, upto: u64) -> Result<(), String> {
        self.advance(upto);
        self.persist()
    }

    /// Drop the oldest record (in memory; `persist` after). False when nothing went.
    fn pop_front(&mut self) -> bool {
        let before = self.count;
        if let Some(n) = self.cur.front().map(|r| r.n) {
            self.advance(n);
        }
        self.count < before
    }

    /// Everything queued is done.
    fn clear(&mut self) -> Result<(), String> {
        let last = self.next.saturating_sub(1);
        self.ack(last)
    }

    /// The seq of the first audit record of `source` still queued.
    fn first_mark(&self, source: &str) -> Option<u64> {
        if let Some(q) = self.cur.iter().find_map(|r| r.mark.as_ref().filter(|(s, _)| s == source).map(|(_, q)| *q)) {
            return Some(q);
        }
        self.segs.iter().skip(1).find_map(|s| s.first_marks.get(source).copied())
    }

    /// The highest audit seq queued per source (for cursors after a crash).
    fn last_marks(&self) -> BTreeMap<String, u64> {
        let mut out: BTreeMap<String, u64> = BTreeMap::new();
        for s in &self.segs {
            for (k, v) in &s.last_marks {
                let e = out.entry(k.clone()).or_insert(*v);
                *e = (*e).max(*v);
            }
        }
        out
    }
}

// ── one destination ──────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
struct SigState {
    next_try: i64,
    attempt: u32,
}

struct Queues {
    q: [Queue; 4],
    s: [SigState; 4],
    /// The config generation: bumped by every config change, under this lock. Work prepared under another one is
    /// refused here.
    epoch: u64,
    /// Audit: source -> the last seq taken from its chain (enqueued or refused).
    cursors: BTreeMap<String, u64>,
    /// The destination was deleted: nothing more is written.
    gone: bool,
    /// Audit is over its limits: nothing more is pulled (`ExportAuditBacklog`).
    paused: bool,
    /// The last delivery failed for good (a non-retryable `SinkError`); cleared by a success.
    failed: bool,
    last_success: Option<i64>,
    last_error: Option<String>,
    dropped: u64,
    failures: u64,
    intake: u64,
    refused: BTreeMap<&'static str, u64>,
}

impl Queues {
    fn bytes(&self) -> u64 {
        self.q.iter().map(|q| q.bytes).sum()
    }

    fn oldest(&self) -> Option<i64> {
        self.q.iter().filter_map(Queue::oldest).min()
    }

    /// 11.6: the destination's whole backlog under `max_bytes`, and logs, traces and metrics under `max_age_ms`:
    /// the oldest non-audit records go first (counted). Audit is never dropped. Returns how many went.
    fn trim(&mut self, max_bytes: u64, max_age_ms: i64, now: i64) -> u64 {
        let mut lost = 0u64;
        let mut touched = [false; 4];
        for i in 1..4 {
            while self.q[i].oldest().is_some_and(|t| now - t > max_age_ms) {
                if !self.q[i].pop_front() {
                    break;
                }
                lost += 1;
                touched[i] = true;
            }
        }
        while self.bytes() > max_bytes {
            let Some(i) = (1..4).filter(|i| !self.q[*i].is_empty()).min_by_key(|i| self.q[*i].oldest().unwrap_or(i64::MAX)) else { break };
            if !self.q[i].pop_front() {
                break;
            }
            lost += 1;
            touched[i] = true;
        }
        for (q, _) in self.q.iter_mut().zip(touched).filter(|(_, t)| *t) {
            if let Err(e) = q.persist() {
                self.last_error = Some(format!("The export queue could not be written ({e})."));
            }
        }
        self.dropped += lost;
        lost
    }

    /// A tightening: what was queued under the wider form never leaves. Logs, traces and metrics queued are dropped
    /// (returned as lost); audit is taken again from each source's first unsent seq.
    fn narrow(&mut self, narrower: bool, dropped: &[Signal]) -> u64 {
        let mut lost = 0u64;
        for sig in SIGNALS {
            if !(narrower || dropped.contains(&sig)) {
                continue;
            }
            let i = idx(sig);
            if sig == Signal::Audit {
                let sources: Vec<String> = self.cursors.keys().cloned().collect();
                for s in sources {
                    if let Some(first) = self.q[0].first_mark(&s) {
                        self.cursors.insert(s, first - 1);
                    }
                }
            } else {
                lost += self.q[i].count;
            }
            if let Err(e) = self.q[i].clear() {
                self.last_error = Some(format!("The export queue could not be written ({e})."));
            }
            self.s[i] = SigState::default();
        }
        self.dropped += lost;
        lost
    }
}

struct DestRt {
    org: String,
    id: String,
    dir: PathBuf,
    /// Held across one delivery; a config change takes it first, so it never returns while a delivery made under
    /// the wider config is in flight. Lock order: `send`, then `cfg`, then `q`.
    send: Mutex<()>,
    cfg: Mutex<Dest>,
    q: Mutex<Queues>,
    cv: Condvar,
    stop: AtomicBool,
    /// Bumped when the entry or the credential changes: the sink is made again.
    gen: AtomicU64,
    rr: AtomicUsize,
    sink: Mutex<Option<(u64, Arc<dyn Sink>)>>,
}

impl DestRt {
    fn open(dir: PathBuf, dest: Dest) -> DestRt {
        let q = SIGNALS.map(|s| Queue::open(dir.join(s.name()), SEGMENT_BYTES));
        let mut cursors: BTreeMap<String, u64> = read_json(&dir.join(CURSORS_FILE))
            .and_then(|v| v.as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_u64()?))).collect()))
            .unwrap_or_default();
        // a crash between a queue append and the cursor's write: the queue is the record
        for (s, seq) in q[0].last_marks() {
            let c = cursors.entry(s).or_insert(0);
            *c = (*c).max(seq);
        }
        let queues = Queues {
            q,
            s: Default::default(),
            epoch: 0,
            cursors,
            gone: false,
            paused: false,
            failed: false,
            last_success: None,
            last_error: None,
            dropped: 0,
            failures: 0,
            intake: 0,
            refused: BTreeMap::new(),
        };
        DestRt {
            org: dest.org.clone(),
            id: dest.id.clone(),
            dir,
            send: Mutex::new(()),
            cfg: Mutex::new(dest),
            q: Mutex::new(queues),
            cv: Condvar::new(),
            stop: AtomicBool::new(false),
            gen: AtomicU64::new(0),
            rr: AtomicUsize::new(0),
            sink: Mutex::new(None),
        }
    }

    fn key(&self) -> Key {
        (self.org.clone(), self.id.clone())
    }

    /// The config and its generation, read together.
    fn snap(&self) -> (Dest, u64) {
        let c = self.cfg.lock();
        let epoch = self.q.lock().epoch;
        (c.clone(), epoch)
    }

    fn save_meta(&self, d: &Dest) -> Result<(), String> {
        crate::store::make_dir(&self.dir).map_err(|e| e.to_string())?;
        crate::fleet_local::write_durable(&self.dir.join(META_FILE), stringify(&json!({"org": d.org, "entry": d.entry})).as_bytes())
    }

    fn save_cursors(&self, cursors: &BTreeMap<String, u64>) -> Result<(), String> {
        crate::store::make_dir(&self.dir).map_err(|e| e.to_string())?;
        crate::fleet_local::write_durable(&self.dir.join(CURSORS_FILE), stringify(&json!(cursors)).as_bytes())
    }
}

fn backoff(attempt: u32) -> i64 {
    let full = BACKOFF_FIRST_MS.saturating_mul(1i64 << attempt.saturating_sub(1).min(20)).min(BACKOFF_MAX_MS);
    let r = crate::console_auth::random(4).map_or(0, |b| i64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])));
    // equal jitter: half fixed, half random
    full / 2 + r % (full / 2 + 1)
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────────────────────────

/// Work handed in by call paths and the minute tick.
pub enum Item {
    Log { org: String, event: String, line: Value, t_ms: i64 },
    Span { org: String, span: Value },
    Metrics { org: String, rows: Vec<MetricRow>, t_ms: i64 },
}

/// The two bounded intakes: log events and spans, and metric samples.
#[derive(Default)]
struct Intake {
    events: VecDeque<Item>,
    metrics: VecDeque<Item>,
}

/// The console's export engine (one per console).
pub struct ExportEngine {
    dir: PathBuf,
    host: Arc<dyn Host>,
    logger: Arc<Logger>,
    threads: bool,
    me: Weak<ExportEngine>,
    dests: Mutex<BTreeMap<Key, Arc<DestRt>>>,
    /// org -> signals some live destination carries (read on call paths).
    wanted: Mutex<HashMap<String, [bool; 4]>>,
    intake: Mutex<Intake>,
    intake_cv: Condvar,
    metrics_evicted: AtomicU64,
    stop: AtomicBool,
    keys: Mutex<HashMap<String, (i64, Option<(u32, Vec<u8>)>)>>,
    /// ((org, destination), series) -> the last cumulative value sent as a delta.
    prev: Mutex<HashMap<(Key, String), f64>>,
    /// (org, destination, reason, minute) -> refused records, written as `exports.refused` once the minute ends.
    refused: Mutex<BTreeMap<(String, String, &'static str, i64), u64>>,
}

impl Drop for ExportEngine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for rt in self.dests.get_mut().values() {
            rt.stop.store(true, Ordering::Relaxed);
            rt.cv.notify_all();
        }
        self.intake_cv.notify_all();
    }
}

static GLOBAL: OnceLock<Weak<ExportEngine>> = OnceLock::new();

/// Make this engine the process's target for API spans and log lines (the first console to call it).
pub fn install(engine: &Arc<ExportEngine>) {
    let _ = GLOBAL.set(Arc::downgrade(engine));
}

fn global() -> Option<Arc<ExportEngine>> {
    GLOBAL.get().and_then(Weak::upgrade)
}

/// A relay's failover exporter (12.2, `api_failover`): the target of its listener's spans and of log lines.
static RELAY: OnceLock<Weak<ExportEngine>> = OnceLock::new();

/// Make this engine the process's relay failover exporter (the first relay to call it).
pub fn install_relay(engine: &Arc<ExportEngine>) {
    let _ = RELAY.set(Arc::downgrade(engine));
}

fn relay_global() -> Option<Arc<ExportEngine>> {
    RELAY.get().and_then(Weak::upgrade)
}

/// One API call, as a span (10.3 traces).
pub struct SpanCall<'a> {
    pub org: &'a str,
    pub method: &'a str,
    /// The route template (`/api/orgs/{org}/v1/health`).
    pub route: &'a str,
    pub status: u16,
    pub rid: &'a str,
    /// The relay id of the listener, `console` on the front door.
    pub relay: &'a str,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// The span record of a call: the trace id is the `rid`'s 16 random bytes in hex (so a trace finds its audit entry),
/// the span id 8 bytes of SHA-256 over it.
pub fn span_value(c: &SpanCall) -> Value {
    let trace_id = crate::codec::unb64u(c.rid).filter(|b| b.len() == 16).map_or_else(|| hex(&sha256(c.rid.as_bytes())[..16]), |b| hex(&b));
    let span_id = hex(&sha256(format!("span:{}", c.rid).as_bytes())[..8]);
    json!({
        "trace_id": trace_id, "span_id": span_id, "name": format!("{} {}", c.method, c.route),
        "start_ms": c.start_ms, "end_ms": c.end_ms, "status": if c.status >= 500 { "error" } else { "ok" },
        "attributes": {"http.request.method": c.method, "http.route": c.route, "http.response.status_code": c.status,
                       "lucid.rid": c.rid, "lucid.org": c.org, "lucid.relay": c.relay},
    })
}

/// A finished API call (`api_resource::answer`): one span when one of the org's destinations carries traces, into
/// the console's engine for a front door call and into the relay's failover exporter for a relay listener call;
/// nothing otherwise (no engine, or no traces destination live).
pub fn api_span(c: &SpanCall) {
    let Some(e) = (if c.relay == "console" { global() } else { relay_global() }) else { return };
    if e.wants(c.org, Signal::Traces) {
        e.push(Item::Span { org: c.org.to_string(), span: span_value(c) });
    }
}

/// The logger's export tap (`log::set_export_tap`): a catalog-listed event naming an org goes to that org's `logs`
/// destinations, on the console's engine and on a relay's failover exporter. Lines without an `org` are console-wide
/// and stay with the existing SIEM export.
pub fn log_tap() -> crate::log::Tap {
    Arc::new(|_cat: &str, _level: Level, event: &str, json: &str| {
        let engines: Vec<Arc<ExportEngine>> = [global(), relay_global()].into_iter().flatten().collect();
        if engines.is_empty() || catalog::catalog().record_type(event).is_none() {
            return;
        }
        let Some(line) = crate::codec::parse_json(json) else { return };
        let Some(org) = line.get("org").and_then(Value::as_str).map(str::to_string) else { return };
        let wanted: Vec<&Arc<ExportEngine>> = engines.iter().filter(|e| e.wants(&org, Signal::Logs)).collect();
        if wanted.is_empty() {
            return;
        }
        let t_ms = line.get("ts").and_then(Value::as_str).and_then(crate::meet_json::from_iso).map_or_else(now_ms, |s| (s * 1000.0).round() as i64);
        for e in wanted {
            e.push(Item::Log { org: org.clone(), event: event.to_string(), line: line.clone(), t_ms });
        }
    })
}

/// 10.3: an audit entry as a log record.
fn audit_record(org: &str, source: &str, repr: Repr, seq: u64, action: &str, ts: i64, body: Value) -> Value {
    let chain = format!("{}/{source}", repr.label(org));
    let severity = catalog::catalog().severity(action, &body);
    json!({
        "t_ms": ts.saturating_mul(1000), "severity": severity, "event": action, "body": body,
        "attributes": {"lucid.action": action, "lucid.seq": seq, "lucid.chain": chain, "lucid.event_id": format!("{chain}:{seq}"), "lucid.source": source},
    })
}

/// Whether a trace is kept at `ppm` (the same trace is kept or dropped alike everywhere).
fn sampled(trace_id: &str, ppm: u64) -> bool {
    if ppm >= SAMPLING_ALL {
        return true;
    }
    let head = &trace_id[..trace_id.len().min(12)];
    u64::from_str_radix(head, 16).is_ok_and(|n| n % SAMPLING_ALL < ppm)
}

type KeyRef<'a> = Option<(u32, &'a [u8])>;

impl ExportEngine {
    /// The engine over `dir` (`<state>/exports`): every destination folder found is loaded suspended (its queues,
    /// cursors and retention hold in force) until `refresh` reads the maps. With `threads`, an intake thread and one
    /// delivery thread per destination run; tests drive `drain`, `pull_audit` and `pump` themselves.
    pub fn open(dir: &Path, host: Arc<dyn Host>, logger: Arc<Logger>, threads: bool) -> Arc<ExportEngine> {
        let e = Arc::new_cyclic(|me: &Weak<ExportEngine>| ExportEngine {
            dir: dir.to_path_buf(),
            host,
            logger,
            threads,
            me: me.clone(),
            dests: Mutex::new(BTreeMap::new()),
            wanted: Mutex::new(HashMap::new()),
            intake: Mutex::new(Intake::default()),
            intake_cv: Condvar::new(),
            metrics_evicted: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            keys: Mutex::new(HashMap::new()),
            prev: Mutex::new(HashMap::new()),
            refused: Mutex::new(BTreeMap::new()),
        });
        let _ = crate::store::make_dir(&e.dir);
        let subdirs = |d: &Path| -> Vec<(String, PathBuf)> {
            std::fs::read_dir(d).into_iter().flatten().flatten().filter(|x| x.path().is_dir()).filter_map(|x| Some((x.file_name().to_str().filter(|n| part_ok(n))?.to_string(), x.path()))).collect()
        };
        for (org, org_dir) in subdirs(&e.dir) {
            for (id, path) in subdirs(&org_dir) {
                let Some(meta) = read_json(&path.join(META_FILE)) else { continue };
                let Some(mut dest) = effective(&org, &meta["entry"], &[], Some(Edition::Enterprise), 0) else { continue };
                if dest.id != id || text(&meta, "org") != org {
                    continue;
                }
                dest.suspended = true;
                let rt = Arc::new(DestRt::open(path, dest));
                e.dests.lock().insert((org.clone(), id), rt);
            }
        }
        if threads {
            let w = Arc::downgrade(&e);
            if let Err(err) = std::thread::Builder::new().name("export-intake".into()).spawn(move || intake_loop(w)) {
                e.logger.ops("exports.thread-failed", &Fields::new().with("why", err.to_string()), Level::Error);
            }
            let all: Vec<Arc<DestRt>> = e.dests.lock().values().cloned().collect();
            for rt in all {
                e.spawn_worker(rt);
            }
        }
        e
    }

    fn spawn_worker(&self, rt: Arc<DestRt>) {
        if !self.threads {
            return;
        }
        let w = self.me.clone();
        if let Err(err) = std::thread::Builder::new().name("export-worker".into()).spawn(move || worker_loop(w, rt)) {
            self.logger.ops("exports.thread-failed", &Fields::new().with("why", err.to_string()), Level::Error);
        }
    }

    fn snapshot(&self) -> Vec<Arc<DestRt>> {
        self.dests.lock().values().cloned().collect()
    }

    fn wants(&self, org: &str, sig: Signal) -> bool {
        self.wanted.lock().get(org).is_some_and(|w| w[idx(sig)])
    }

    fn update_wanted(&self) {
        let mut w: HashMap<String, [bool; 4]> = HashMap::new();
        for rt in self.snapshot() {
            let c = rt.cfg.lock().clone();
            if !c.suspended && c.refused.is_none() {
                let slot = w.entry(c.org.clone()).or_default();
                for s in &c.signals {
                    slot[idx(*s)] = true;
                }
            }
        }
        *self.wanted.lock() = w;
    }

    /// The org's destinations that carry a signal and are live at `now` (any time with None).
    fn active(&self, org: &str, sig: Signal, now: Option<i64>) -> Vec<Arc<DestRt>> {
        self.snapshot()
            .into_iter()
            .filter(|rt| {
                let c = rt.cfg.lock();
                rt.org == org && c.carries(sig) && now.map_or(!c.suspended && c.refused.is_none(), |t| c.live(t))
            })
            .collect()
    }

    fn key(&self, org: &str, now: i64) -> Option<(u32, Vec<u8>)> {
        if let Some((at, k)) = self.keys.lock().get(org) {
            if now - at < KEY_TTL_MS {
                return k.clone();
            }
        }
        let k = self.host.pseudonym_key(org);
        self.keys.lock().insert(org.to_string(), (now, k.clone()));
        k
    }

    // ── config ──

    /// Read the maps and the journal again (at start, on every pin, tightening or edition change, and each minute):
    /// destinations added, changed (tightenings take effect at once: records queued under a wider form are dropped
    /// and audit is taken again from the first unsent seq), suspended, or deleted (queues and credential removed).
    /// `now_s` is unix seconds.
    pub fn refresh(&self, now_s: i64) {
        let (edition, orgs) = self.host.config(now_s);
        let now = now_s.saturating_mul(1000);
        let serving: BTreeSet<&str> = orgs.iter().filter(|o| o.serving).map(|o| o.org.as_str()).collect();
        let mut seen: BTreeSet<Key> = BTreeSet::new();
        for oc in orgs.iter().filter(|o| o.serving) {
            let mut otlp = 0;
            for d in &oc.destinations {
                let Some(mut dest) = effective(&oc.org, d, &oc.active, edition, otlp) else { continue };
                if dest.kind == "otlp" {
                    otlp += 1;
                }
                dest.expires = oc.expires;
                let gate = self.host.failover_gate(&oc.org, d, now_s);
                if let Some(g) = &gate {
                    dest.suspended |= !g.on;
                    dest.expires = dest.expires.min(g.until);
                }
                seen.insert(dest.key());
                self.upsert(dest, gate.as_ref().map_or(&[][..], |g| g.from.as_slice()), now);
            }
        }
        for rt in self.snapshot() {
            if seen.contains(&rt.key()) {
                continue;
            }
            if serving.contains(rt.org.as_str()) {
                self.delete(&rt);
            } else {
                let mut d = rt.cfg.lock().clone();
                d.suspended = true;
                self.apply(&rt, d, now);
            }
        }
        self.update_wanted();
    }

    /// `from`: a relay's failover start per audit source (`Gate::from`), applied before the new config can go live.
    fn upsert(&self, dest: Dest, from: &[(String, [u64; 3])], now: i64) {
        let existing = self.dests.lock().get(&dest.key()).cloned();
        match existing {
            Some(rt) => {
                self.raise_cursors(&rt, &dest, from);
                self.apply(&rt, dest, now)
            }
            None => {
                let dir = self.dir.join(&dest.org).join(&dest.id);
                let rt = Arc::new(DestRt::open(dir, dest.clone()));
                self.raise_cursors(&rt, &dest, from);
                if let Err(e) = rt.save_meta(&dest) {
                    self.logger.ops("exports.meta-unsaved", &Fields::new().with("org", dest.org.as_str()).with("destination", dest.id.as_str()).with("why", e), Level::Error);
                }
                self.dests.lock().insert(dest.key(), rt.clone());
                self.logger.ops("exports.destination-added", &Fields::new().with("org", dest.org.as_str()).with("destination", dest.id.as_str()).with("kind", dest.kind.as_str()), Level::Info);
                self.spawn_worker(rt);
            }
        }
    }

    /// A changed config: after any delivery in flight (the send lock), the config and its generation change together
    /// under the queue lock, and a narrower one drops what was queued under the wider form.
    fn apply(&self, rt: &DestRt, dest: Dest, now: i64) {
        let _send = rt.send.lock();
        let mut c = rt.cfg.lock();
        if *c == dest {
            return;
        }
        let old = c.clone();
        let narrower = dest.ceiling < old.ceiling || ident_rank(dest.identities) > ident_rank(old.identities);
        let dropped: Vec<Signal> = old.signals.iter().copied().filter(|s| !dest.carries(*s)).collect();
        let meta = if old.entry != dest.entry {
            rt.gen.fetch_add(1, Ordering::Relaxed);
            rt.save_meta(&dest).err()
        } else {
            None
        };
        *c = dest.clone();
        let mut q = rt.q.lock();
        q.epoch += 1;
        let lost = if narrower || !dropped.is_empty() {
            let lost = q.narrow(narrower, &dropped);
            if let Err(e) = rt.save_cursors(&q.cursors) {
                q.last_error = Some(format!("The export cursors could not be written ({e})."));
            }
            Some(lost)
        } else {
            None
        };
        self.gauges(&dest, &q, now);
        drop(q);
        drop(c);
        rt.cv.notify_all();
        let f = || Fields::new().with("org", dest.org.as_str()).with("destination", dest.id.as_str());
        if let Some(e) = meta {
            self.logger.ops("exports.meta-unsaved", &f().with("why", e), Level::Error);
        }
        if let Some(lost) = lost {
            if lost > 0 {
                catalog::counters::export_failures(&dest.org, &dest.id, "dropped", lost);
            }
            self.logger.ops("exports.destination-narrowed", &f().with("dropped", lost), Level::Info);
        }
    }

    /// `destination_delete`, or absent from the serving map: after any delivery in flight, delivery stops, the queues
    /// and the sealed credential are removed.
    fn delete(&self, rt: &Arc<DestRt>) {
        rt.stop.store(true, Ordering::Relaxed);
        {
            let _send = rt.send.lock();
            let mut q = rt.q.lock();
            q.gone = true;
            q.epoch += 1;
            q.cursors.clear();
            q.paused = false;
            for x in q.q.iter_mut() {
                x.segs.clear();
                x.cur.clear();
                x.bytes = 0;
                x.count = 0;
            }
        }
        rt.cv.notify_all();
        self.dests.lock().remove(&rt.key());
        *rt.sink.lock() = None;
        let removed = std::fs::remove_dir_all(&rt.dir).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) });
        if let Some(parent) = rt.dir.parent() {
            sync_dir(parent);
        }
        self.host.delete_credential(&rt.org, &rt.id);
        catalog::counters::remove_destination(&rt.org, &rt.id);
        let key = rt.key();
        self.prev.lock().retain(|(k, _), _| *k != key);
        let f = Fields::new().with("org", rt.org.as_str()).with("destination", rt.id.as_str());
        if let Err(e) = removed {
            self.logger.ops("exports.queue-not-removed", &f.clone().with("why", e.to_string()), Level::Error);
        }
        self.logger.ops("exports.destination-deleted", &f, Level::Info);
    }

    /// A relay's failover start (`Gate::from`): each source's audit cursor of the destination's representation is
    /// raised to just before the org's `relay.failover.on` entry (never lowered), so that entry is the first audit
    /// record a failover delivers after what was queued before.
    fn raise_cursors(&self, rt: &DestRt, dest: &Dest, from: &[(String, [u64; 3])]) {
        if from.is_empty() {
            return;
        }
        let r = usize::from(repr_rank(repr_of(dest.identities)));
        let mut q = rt.q.lock();
        if q.gone {
            return;
        }
        let mut moved = false;
        for (source, firsts) in from {
            let floor = firsts[r].saturating_sub(1);
            let c = q.cursors.entry(source.clone()).or_insert(0);
            if *c < floor {
                *c = floor;
                moved = true;
            }
        }
        if moved {
            if let Err(e) = rt.save_cursors(&q.cursors) {
                q.last_error = Some(format!("The export cursors could not be written ({e})."));
            }
        }
    }

    /// A relay's failover retirement (`destination_delete`, `destination_disable_failover`, the `api-failover`
    /// `delete`, 12.3): after any delivery in flight, delivery stops and the destination's queues and credential are
    /// removed (`Host::delete_credential`). Nothing when the engine does not hold it.
    pub fn remove(&self, org: &str, id: &str) {
        let rt = self.dests.lock().get(&(org.to_string(), id.to_string())).cloned();
        if let Some(rt) = rt {
            self.delete(&rt);
            self.update_wanted();
        }
    }

    /// The destination's credential was stored again: the sink is made anew and a failed destination tries at once.
    pub fn credential_changed(&self, org: &str, id: &str) {
        let Some(rt) = self.dests.lock().get(&(org.to_string(), id.to_string())).cloned() else { return };
        rt.gen.fetch_add(1, Ordering::Relaxed);
        {
            let mut q = rt.q.lock();
            q.failed = false;
            q.s = Default::default();
        }
        rt.cv.notify_all();
    }

    // ── intake ──

    /// Hand work in without blocking. Log events and spans have their own bound (`INTAKE_MAX`): over it the new one
    /// is dropped and counted `export_failures{reason="intake"}` for each destination that would have taken it.
    /// Metric samples have theirs (`METRICS_INTAKE`), which drops its oldest.
    pub fn push(&self, item: Item) {
        let sig = match &item {
            Item::Log { .. } => Some(Signal::Logs),
            Item::Span { .. } => Some(Signal::Traces),
            Item::Metrics { .. } => None,
        };
        let rejected = {
            let mut g = self.intake.lock();
            match sig {
                None => {
                    if g.metrics.len() >= METRICS_INTAKE {
                        g.metrics.pop_front();
                        self.metrics_evicted.fetch_add(1, Ordering::Relaxed);
                    }
                    g.metrics.push_back(item);
                    None
                }
                Some(_) if g.events.len() >= INTAKE_MAX => Some(item),
                Some(_) => {
                    g.events.push_back(item);
                    None
                }
            }
        };
        match (rejected, sig) {
            (Some(Item::Log { org, .. } | Item::Span { org, .. }), Some(sig)) => {
                for rt in self.active(&org, sig, None) {
                    rt.q.lock().intake += 1;
                    catalog::counters::export_failures(&rt.org, &rt.id, "intake", 1);
                }
            }
            _ => {
                self.intake_cv.notify_one();
            }
        }
    }

    /// Everything handed in so far, into the queues.
    pub fn drain(&self, now: i64) {
        let (events, metrics) = {
            let mut g = self.intake.lock();
            (std::mem::take(&mut g.events), std::mem::take(&mut g.metrics))
        };
        for it in events.into_iter().chain(metrics) {
            self.take(it, now);
        }
    }

    /// Transform under the destination's current config and enqueue; when a tightening lands in between, the append
    /// is refused as stale and the work is done once more under the new config.
    fn produce(&self, rt: &DestRt, sig: Signal, now: i64, make: &dyn Fn(&Dest, KeyRef) -> Result<Vec<Value>, &'static str>) {
        for _ in 0..2 {
            let (cfg, epoch) = rt.snap();
            if !cfg.live(now) || !cfg.carries(sig) {
                return;
            }
            let key = self.key(&cfg.org, now);
            let kref = key.as_ref().map(|(v, k)| (*v, k.as_slice()));
            match make(&cfg, kref) {
                Ok(recs) => {
                    if self.enqueue(rt, &cfg, epoch, sig, recs.into_iter().map(|r| (r, now, None)).collect(), now) {
                        return;
                    }
                }
                Err(why) => {
                    self.refuse(rt, &cfg, why, 1, now);
                    return;
                }
            }
        }
    }

    fn take(&self, item: Item, now: i64) {
        match item {
            Item::Log { org, event, line, t_ms } => {
                for rt in self.active(&org, Signal::Logs, Some(now)) {
                    self.produce(&rt, Signal::Logs, now, &|cfg, kref| {
                        let body = catalog::transform_record(&event, &line, cfg.identities, kref, cfg.ceiling).map_err(|r| r.reason())?;
                        let severity = catalog::catalog().severity(&event, &line);
                        let id = format!("log:{t_ms}:{}", &hex(&sha256(stringify(&line).as_bytes()))[..16]);
                        Ok(vec![json!({"t_ms": t_ms, "severity": severity, "event": event, "body": body, "attributes": {"lucid.action": event, "lucid.event_id": id}})])
                    });
                }
            }
            Item::Span { org, span } => {
                for rt in self.active(&org, Signal::Traces, Some(now)) {
                    self.produce(&rt, Signal::Traces, now, &|cfg, kref| {
                        if !sampled(text(&span, "trace_id"), cfg.sampling_ppm) {
                            return Ok(Vec::new());
                        }
                        let attrs = catalog::transform_record(SPAN_TYPE, &span["attributes"], cfg.identities, kref, cfg.ceiling).map_err(|r| r.reason())?;
                        let mut s = span.clone();
                        s["attributes"] = attrs;
                        Ok(vec![s])
                    });
                }
            }
            Item::Metrics { org, rows, t_ms } => {
                for rt in self.active(&org, Signal::Metrics, Some(now)) {
                    for _ in 0..2 {
                        let (cfg, epoch) = rt.snap();
                        if !cfg.live(now) || !cfg.carries(Signal::Metrics) {
                            break;
                        }
                        let (recs, baselines) = self.metric_records(&rt, &cfg, &rows, t_ms, now);
                        if self.enqueue(&rt, &cfg, epoch, Signal::Metrics, recs.into_iter().map(|r| (r, now, None)).collect(), now) {
                            // the delta baselines move only with what was enqueued
                            self.prev.lock().extend(baselines);
                            break;
                        }
                    }
                }
            }
        }
    }

    /// One record per family: labels through `transform_labels` (series that end up alike are summed), counters as
    /// deltas for a `delta` destination (the first reading is the baseline and sends nothing). Also the new baselines.
    #[allow(clippy::type_complexity)]
    fn metric_records(&self, rt: &DestRt, cfg: &Dest, rows: &[MetricRow], t_ms: i64, now: i64) -> (Vec<Value>, Vec<((Key, String), f64)>) {
        let key = self.key(&cfg.org, now);
        let kref = key.as_ref().map(|(v, k)| (*v, k.as_slice()));
        let mut by: BTreeMap<&str, Vec<&MetricRow>> = BTreeMap::new();
        for r in rows {
            by.entry(r.prom.as_str()).or_default().push(r);
        }
        let mut out = Vec::new();
        let mut baselines = Vec::new();
        let prev = self.prev.lock().clone();
        for (prom, rs) in by {
            // a family is refused once per tick, not once per series
            let Some(fam) = catalog::catalog().family(prom) else {
                self.refuse(rt, cfg, "identity", 1, now);
                continue;
            };
            let mut series: BTreeMap<Vec<(String, String)>, f64> = BTreeMap::new();
            let mut refused = None;
            for r in rs {
                match catalog::transform_labels(fam, &r.labels, cfg.identities, kref, cfg.ceiling) {
                    Ok(labels) => *series.entry(labels).or_insert(0.0) += r.value,
                    Err(x) => {
                        refused = Some(x.reason());
                        break;
                    }
                }
            }
            if let Some(why) = refused {
                self.refuse(rt, cfg, why, 1, now);
                continue;
            }
            let counter = matches!(fam.kind, MetricKind::Counter);
            let delta = counter && cfg.temporality == "delta";
            let mut points = Vec::new();
            for (labels, v) in series {
                let value = if delta {
                    let k = (cfg.key(), format!("{prom}{}", stringify(&json!(labels))));
                    let p = prev.get(&k).copied();
                    baselines.push((k, v));
                    match p {
                        Some(p) if v >= p => v - p,
                        Some(_) => v,
                        None => continue,
                    }
                } else {
                    v
                };
                let l: Map<String, Value> = labels.into_iter().map(|(k, v)| (k, Value::from(v))).collect();
                points.push(json!({"t_ms": t_ms, "v": value, "labels": l}));
            }
            if points.is_empty() {
                continue;
            }
            out.push(json!({
                "name": fam.otel, "prom": prom, "kind": if counter { "sum" } else { "gauge" }, "unit": fam.unit,
                "temporality": if delta { "delta" } else { "cumulative" }, "points": points,
            }));
        }
        (out, baselines)
    }

    /// Append under the queue lock. False when the config changed since `epoch` (the records were made under the
    /// old one); true otherwise, including when nothing is to be written (deleted, expired).
    fn enqueue(&self, rt: &DestRt, cfg: &Dest, epoch: u64, sig: Signal, items: Vec<(Value, i64, Option<(String, u64)>)>, now: i64) -> bool {
        let mut q = rt.q.lock();
        if q.gone {
            return true;
        }
        if q.epoch != epoch {
            return false;
        }
        if items.is_empty() || !cfg.live(now) {
            return true;
        }
        if let Err(e) = q.q[idx(sig)].append(items) {
            q.last_error = Some(format!("The export queue could not be written ({e})."));
            drop(q);
            self.logger.ops("exports.queue-failed", &Fields::new().with("org", cfg.org.as_str()).with("destination", cfg.id.as_str()).with("why", e), Level::Error);
            return true;
        }
        let lost = q.trim(cfg.max_bytes, cfg.max_age_s.saturating_mul(1000), now);
        self.gauges(cfg, &q, now);
        drop(q);
        if lost > 0 {
            catalog::counters::export_failures(&cfg.org, &cfg.id, "dropped", lost);
        }
        rt.cv.notify_all();
        true
    }

    fn gauges(&self, cfg: &Dest, q: &Queues, now: i64) {
        catalog::counters::set_export_backlog_bytes(&cfg.org, &cfg.id, q.bytes());
        let oldest = q.oldest().map_or(0, |t| u64::try_from((now - t).max(0) / 1000).unwrap_or(0));
        catalog::counters::set_export_oldest_seconds(&cfg.org, &cfg.id, oldest);
    }

    /// 11.5: records not enqueued, counted now and summarized as `exports.refused` per minute and reason.
    fn refuse(&self, rt: &DestRt, cfg: &Dest, why: &'static str, n: u64, now: i64) {
        catalog::counters::export_refused(&cfg.org, &cfg.id, why, n);
        *rt.q.lock().refused.entry(why).or_insert(0) += n;
        *self.refused.lock().entry((cfg.org.clone(), cfg.id.clone(), why, now.div_euclid(60_000))).or_insert(0) += n;
    }

    fn flush_refused(&self, now: i64) {
        let minute = now.div_euclid(60_000);
        let due: Vec<((String, String, &'static str, i64), u64)> = {
            let mut g = self.refused.lock();
            let keys: Vec<_> = g.keys().filter(|k| k.3 < minute).cloned().collect();
            keys.into_iter().filter_map(|k| g.remove(&k).map(|n| (k, n))).collect()
        };
        for ((org, id, why, _), n) in due {
            let e = json!({"action": "exports.refused", "result": "refused", "check": why, "destination": id, "resource": id, "count": n});
            self.host.audit_record(&org, e, now / 1000);
        }
    }

    // ── audit (9.4, 9.5, 11.6) ──

    /// Take what is new in every audit chain into the queues of the live audit destinations.
    pub fn pull_audit(&self, now: i64) {
        for rt in self.snapshot() {
            self.pull_one(&rt, now);
        }
    }

    fn pull_one(&self, rt: &DestRt, now: i64) {
        let (cfg, epoch) = rt.snap();
        if !cfg.live(now) || !cfg.carries(Signal::Audit) {
            return;
        }
        let repr = repr_of(cfg.identities);
        let key = self.key(&cfg.org, now);
        let kref = key.as_ref().map(|(v, k)| (*v, k.as_slice()));
        let max_age_ms = cfg.max_age_s.saturating_mul(1000);
        let mut added = false;
        for source in self.host.audit_sources(&cfg.org) {
            for _ in 0..AUDIT_PAGES {
                // audit alone counts against the limit: other signals make room by losing their oldest
                let (after, room) = {
                    let q = rt.q.lock();
                    if q.gone || q.epoch != epoch {
                        return;
                    }
                    let a = &q.q[0];
                    let full = a.bytes >= cfg.max_bytes || a.oldest().is_some_and(|t| now - t > max_age_ms);
                    (q.cursors.get(&source).copied().unwrap_or(0), (!full).then(|| cfg.max_bytes - a.bytes))
                };
                let Some(room) = room else {
                    self.set_paused(rt, &cfg, true);
                    if added {
                        rt.cv.notify_all();
                    }
                    return;
                };
                let entries = self.host.audit_read(&cfg.org, &source, repr, after, AUDIT_PAGE);
                if entries.is_empty() {
                    break;
                }
                let more = entries.len() >= AUDIT_PAGE;
                let mut items = Vec::new();
                let mut last = after;
                let mut size = 0u64;
                let mut refused: BTreeMap<&'static str, u64> = BTreeMap::new();
                for e in &entries {
                    let Some(seq) = e.get("seq").and_then(Value::as_u64).filter(|s| *s > last) else { continue };
                    let action = text(e, "action");
                    match catalog::transform_record(action, e, cfg.identities, kref, cfg.ceiling) {
                        Ok(body) => {
                            let rec = audit_record(&cfg.org, &source, repr, seq, action, e.get("ts").and_then(Value::as_i64).unwrap_or(0), body);
                            size += stringify(&rec).len() as u64 + LINE_OVERHEAD;
                            items.push((rec, now, Some((source.clone(), seq))));
                        }
                        Err(r) => *refused.entry(r.reason()).or_insert(0) += 1,
                    }
                    last = seq;
                    if size >= room {
                        break;
                    }
                }
                let lost = {
                    let mut q = rt.q.lock();
                    // a tightening since the snapshot: nothing made under the old config goes in, and the cursor
                    // stays, so the next pull takes these entries again under the new one
                    if q.gone || q.epoch != epoch || !cfg.live(now) {
                        return;
                    }
                    if let Err(e) = q.q[0].append(items) {
                        q.last_error = Some(format!("The export queue could not be written ({e})."));
                        return;
                    }
                    q.cursors.insert(source.clone(), last);
                    if let Err(e) = rt.save_cursors(&q.cursors) {
                        q.last_error = Some(format!("The export cursors could not be written ({e})."));
                    }
                    let lost = q.trim(cfg.max_bytes, max_age_ms, now);
                    self.gauges(&cfg, &q, now);
                    lost
                };
                for (why, n) in refused {
                    self.refuse(rt, &cfg, why, n, now);
                }
                if lost > 0 {
                    catalog::counters::export_failures(&cfg.org, &cfg.id, "dropped", lost);
                }
                added = true;
                if !more && size < room {
                    break;
                }
            }
        }
        self.set_paused(rt, &cfg, false);
        if added {
            rt.cv.notify_all();
        }
    }

    fn set_paused(&self, rt: &DestRt, cfg: &Dest, on: bool) {
        let changed = {
            let mut q = rt.q.lock();
            let c = q.paused != on;
            q.paused = on;
            c
        };
        if !changed {
            return;
        }
        let f = Fields::new().with("org", cfg.org.as_str()).with("destination", cfg.id.as_str());
        if on {
            self.logger.security("exports.audit-backlog", &f, Level::Error);
        } else {
            self.logger.ops("exports.audit-backlog-cleared", &f, Level::Info);
        }
    }

    /// 9.4, 9.5: the lowest seq of the org's `source` chain in `repr` that an audit destination has not
    /// acknowledged (None: no destination holds it). A destination holds its own representation and the stricter
    /// ones (a tightening may move it there); suspended, expired and failed destinations hold too, deleted ones do
    /// not.
    pub fn hold(&self, org: &str, source: &str, repr: Repr) -> Option<u64> {
        let mut out: Option<u64> = None;
        for rt in self.snapshot().into_iter().filter(|rt| rt.org == org) {
            let c = rt.cfg.lock().clone();
            if !c.carries(Signal::Audit) || repr_rank(repr) < repr_rank(repr_of(c.identities)) {
                continue;
            }
            let q = rt.q.lock();
            if q.gone {
                continue;
            }
            let h = q.q[0].first_mark(source).unwrap_or_else(|| q.cursors.get(source).copied().unwrap_or(0) + 1);
            out = Some(out.map_or(h, |o| o.min(h)));
        }
        out
    }

    /// `ApiAudit::set_retention_hold`'s hook.
    pub fn retention_hold(&self) -> crate::api_audit::RetentionHold {
        let w = self.me.clone();
        Arc::new(move |org: &str, source: &str, repr: Repr| w.upgrade().and_then(|e| e.hold(org, source, repr)))
    }

    /// The destinations whose audit is paused (`ExportAuditBacklog`): (org, id, name).
    pub fn audit_backlog(&self) -> Vec<(String, String, String)> {
        self.snapshot()
            .into_iter()
            .filter(|rt| rt.q.lock().paused)
            .map(|rt| {
                let c = rt.cfg.lock();
                (c.org.clone(), c.id.clone(), c.name.clone())
            })
            .collect()
    }

    // ── delivery ──

    /// One batch of one signal of one destination, if any is due, under the destination's send lock. True when it
    /// tried.
    fn deliver_once(&self, rt: &DestRt, now: i64) -> bool {
        let _send = rt.send.lock();
        let (cfg, epoch) = rt.snap();
        if !cfg.live(now) {
            return false;
        }
        let start = rt.rr.fetch_add(1, Ordering::Relaxed);
        for k in 0..SIGNALS.len() {
            let sig = SIGNALS[(start + k) % SIGNALS.len()];
            let i = idx(sig);
            let batch = {
                let q = rt.q.lock();
                if q.gone || q.epoch != epoch || q.s[i].next_try > now || q.q[i].is_empty() {
                    continue;
                }
                q.q[i].batch(BATCH_RECORDS, BATCH_BYTES)
            };
            let batch = match batch {
                Ok(b) if !b.is_empty() => b,
                Ok(_) => continue,
                Err(e) => {
                    let err = SinkError { retryable: true, code: "queue", message: format!("The export queue could not be read ({e}).") };
                    self.failure(rt, &cfg, sig, &err, now);
                    return true;
                }
            };
            let last_n = batch.last().map_or(0, |b| b.0);
            let sink = match self.sink(rt, &cfg) {
                Ok(s) => s,
                Err(e) => {
                    self.failure(rt, &cfg, sig, &e, now);
                    return true;
                }
            };
            // right before the send: the config generation and the map's expiry
            if rt.q.lock().epoch != epoch || !cfg.live(now) {
                return true;
            }
            let b = Batch { signal: sig, resource: self.host.resource(&cfg.org), records: batch.into_iter().map(|(_, r)| r).collect() };
            match sink.deliver(&b) {
                Ok(()) => self.success(rt, &cfg, epoch, sig, last_n, now),
                Err(e) => self.failure(rt, &cfg, sig, &e, now),
            }
            return true;
        }
        false
    }

    fn sink(&self, rt: &DestRt, cfg: &Dest) -> Result<Arc<dyn Sink>, SinkError> {
        let gen = rt.gen.load(Ordering::Relaxed);
        if let Some((g, s)) = rt.sink.lock().as_ref() {
            if *g == gen {
                return Ok(s.clone());
            }
        }
        let cred = if cfg.entry.get("credential").is_some() {
            self.host.credential(&cfg.org, &cfg.id).ok_or_else(|| SinkError { retryable: false, code: "credential", message: "The credential for this destination is not stored yet.".into() })?
        } else {
            Credential::None
        };
        let s: Arc<dyn Sink> = Arc::from(self.host.make_sink(&cfg.entry, cred)?);
        *rt.sink.lock() = Some((gen, s.clone()));
        Ok(s)
    }

    fn success(&self, rt: &DestRt, cfg: &Dest, epoch: u64, sig: Signal, last_n: u64, now: i64) {
        let mut q = rt.q.lock();
        if q.gone || q.epoch != epoch {
            return;
        }
        let i = idx(sig);
        if let Err(e) = q.q[i].ack(last_n) {
            q.last_error = Some(format!("The export queue could not be written ({e})."));
        }
        q.s[i] = SigState::default();
        q.failed = false;
        q.last_success = Some(now / 1000);
        self.gauges(cfg, &q, now);
        drop(q);
        catalog::counters::export_success(&cfg.org, &cfg.id, now / 1000);
    }

    fn failure(&self, rt: &DestRt, cfg: &Dest, sig: Signal, e: &SinkError, now: i64) {
        catalog::counters::export_failures(&cfg.org, &cfg.id, e.code, 1);
        let newly_failed = {
            let mut q = rt.q.lock();
            if q.gone {
                return;
            }
            q.failures += 1;
            let i = idx(sig);
            q.s[i].attempt = q.s[i].attempt.saturating_add(1);
            let wait = if e.retryable { backoff(q.s[i].attempt) } else { BACKOFF_MAX_MS };
            q.s[i].next_try = now + wait;
            q.last_error = Some(e.message.clone());
            let newly = !e.retryable && !q.failed;
            if !e.retryable {
                q.failed = true;
            }
            newly
        };
        let f = Fields::new().with("org", cfg.org.as_str()).with("destination", cfg.id.as_str()).with("signal", sig.name()).with("code", e.code);
        if newly_failed {
            self.logger.security("exports.failed", &f.with("why", e.message.as_str()), Level::Error);
            let entry = json!({"action": "exports.failed", "result": "failed", "destination": cfg.id, "resource": cfg.id, "code": e.code, "count": 1});
            self.host.audit_record(&cfg.org, entry, now / 1000);
        } else {
            self.logger.ops("exports.retrying", &f, Level::Warn);
        }
    }

    // ── the minute, status ──

    /// The console's minute (`t` ms): metrics snapshots handed in for every org with a live metrics destination,
    /// queues held to their limits, gauges set, ended minutes of refusals written as `exports.refused`.
    pub fn tick(&self, now: i64) {
        let orgs: BTreeSet<String> = self.snapshot().iter().map(|rt| rt.cfg.lock().clone()).filter(|c| c.live(now) && c.carries(Signal::Metrics)).map(|c| c.org).collect();
        for org in orgs {
            let rows = self.host.metric_rows(&org, now / 1000);
            self.push(Item::Metrics { org, rows, t_ms: now });
        }
        for rt in self.snapshot() {
            let cfg = rt.cfg.lock().clone();
            let mut q = rt.q.lock();
            if q.gone {
                continue;
            }
            let lost = q.trim(cfg.max_bytes, cfg.max_age_s.saturating_mul(1000), now);
            self.gauges(&cfg, &q, now);
            drop(q);
            if lost > 0 {
                catalog::counters::export_failures(&cfg.org, &cfg.id, "dropped", lost);
            }
        }
        let evicted = self.metrics_evicted.swap(0, Ordering::Relaxed);
        if evicted > 0 {
            self.logger.ops("exports.metrics-intake-full", &Fields::new().with("dropped", evicted), Level::Warn);
        }
        self.flush_refused(now);
    }

    /// 11.7 per destination (all orgs with None): state (`ok`, `retrying`, `paused`, `failed`, `suspended`), backlog
    /// bytes, oldest age (s), last success (unix s), last error sentence, and its counters. Failover is slice 1a5.
    /// The Exports screen (slice 1a6) reads it.
    pub fn status(&self, org: Option<&str>, now: i64) -> Vec<Value> {
        let mut out = Vec::new();
        for rt in self.snapshot() {
            if org.is_some_and(|o| o != rt.org) {
                continue;
            }
            let c = rt.cfg.lock().clone();
            let q = rt.q.lock();
            let state = if c.suspended || c.expired(now) {
                "suspended"
            } else if c.refused.is_some() || q.failed {
                "failed"
            } else if q.paused {
                "paused"
            } else if q.s.iter().any(|s| s.attempt > 0) {
                "retrying"
            } else {
                "ok"
            };
            let mut v = json!({
                "id": c.id, "org": c.org, "name": c.name, "kind": c.kind, "state": state,
                "signals": c.signals.iter().map(|s| s.name()).collect::<Vec<_>>(),
                "backlog_bytes": q.bytes(), "oldest_s": q.oldest().map_or(0, |t| (now - t).max(0) / 1000),
                "counters": {"failures": q.failures, "dropped": q.dropped, "intake": q.intake, "refused": q.refused},
                "failover": false,
            });
            if let Some(t) = q.last_success {
                v["last_success"] = json!(t);
            }
            if let Some(e) = c.refused.as_ref().or(q.last_error.as_ref()) {
                v["last_error"] = json!(e);
            }
            out.push(v);
        }
        out
    }

    /// Tests: deliver every due batch now (the failover exporter's tests too).
    #[cfg(test)]
    pub(crate) fn pump(&self, now: i64) -> usize {
        let mut n = 0;
        for _ in 0..1000 {
            let did = self.snapshot().iter().filter(|rt| self.deliver_once(rt, now)).count();
            if did == 0 {
                break;
            }
            n += did;
        }
        n
    }

    #[cfg(test)]
    fn rt(&self, org: &str, id: &str) -> Arc<DestRt> {
        self.dests.lock().get(&(org.to_string(), id.to_string())).cloned().expect("a destination")
    }

    #[cfg(test)]
    fn set_limits(&self, org: &str, id: &str, max_bytes: u64, max_age_s: i64) {
        let rt = self.rt(org, id);
        let mut c = rt.cfg.lock();
        c.max_bytes = max_bytes;
        c.max_age_s = max_age_s;
    }
}

fn intake_loop(me: Weak<ExportEngine>) {
    let mut last_pull = 0i64;
    loop {
        let Some(e) = me.upgrade() else { return };
        if e.stop.load(Ordering::Relaxed) {
            return;
        }
        {
            let mut g = e.intake.lock();
            if g.events.is_empty() && g.metrics.is_empty() {
                e.intake_cv.wait_for(&mut g, Duration::from_millis(PULL_MS as u64));
            }
        }
        let now = now_ms();
        e.drain(now);
        if now - last_pull >= PULL_MS {
            e.pull_audit(now);
            last_pull = now;
        }
    }
}

fn worker_loop(me: Weak<ExportEngine>, rt: Arc<DestRt>) {
    loop {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        let Some(e) = me.upgrade() else { return };
        let worked = e.deliver_once(&rt, now_ms());
        drop(e);
        if !worked {
            let mut g = rt.q.lock();
            if rt.stop.load(Ordering::Relaxed) {
                return;
            }
            rt.cv.wait_for(&mut g, Duration::from_millis(1000));
        }
    }
}

/// Prometheus text exposition (the relays' families, `fleet_export::exposition`) as rows.
pub fn parse_exposition(text: &str) -> Vec<MetricRow> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(i) = line.find(['{', ' ']) else { continue };
        let (name, rest) = line.split_at(i);
        let (labels, rest) = match rest.strip_prefix('{') {
            Some(r) => match parse_labels(r) {
                Some(x) => x,
                None => continue,
            },
            None => (Vec::new(), rest),
        };
        let Some(value) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) else { continue };
        out.push(MetricRow { prom: name.to_string(), labels, value });
    }
    out
}

/// `k="v",...}` with `\\`, `\"` and `\n` escapes; the text after the closing brace.
fn parse_labels(s: &str) -> Option<(Vec<(String, String)>, &str)> {
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        rest = rest.trim_start_matches([',', ' ']);
        if let Some(r) = rest.strip_prefix('}') {
            return Some((out, r));
        }
        let eq = rest.find('=')?;
        let k = rest[..eq].trim().to_string();
        let mut chars = rest[eq + 1..].strip_prefix('"')?.char_indices();
        let body = &rest[eq + 2..];
        let mut v = String::new();
        let end = loop {
            let (j, c) = chars.next()?;
            match c {
                '\\' => {
                    let (_, n) = chars.next()?;
                    v.push(if n == 'n' { '\n' } else { n });
                }
                '"' => break j,
                c => v.push(c),
            }
        };
        out.push((k, v));
        rest = &body[end + 1..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "acme";
    const ORG2: &str = "beta";
    const D1: &str = "d_00000000000000a1";
    const D2: &str = "d_00000000000000b2";
    const NOW: i64 = 1_795_000_000;
    const T: i64 = NOW * 1000;
    const CANARY_CLIENT: &str = "c_c4a7a7c4a7a7c4a7";
    const CANARY_IP: &str = "198.51.100.77";

    fn tmp(name: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("lucid-api-export-{name}-{}-{}-{}", std::process::id(), now_ms(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn dest(id: &str, kind: &str, signals: &[&str], ceiling: &str, identities: &str) -> Value {
        let preset = match kind {
            "otlp" => "otlp_generic",
            "splunk_hec" => "splunk_hec",
            "azure_logs" => "sentinel",
            _ => "syslog_cef",
        };
        json!({"id": id, "name": format!("dest {id}"), "kind": kind, "preset": preset, "signals": signals, "ceiling": ceiling,
               "identities": identities, "failover": false, "private_ok": false, "endpoint": "https://collector.acme.example/v1/logs",
               "settings": {"temporality": "cumulative"},
               "queue": {"max_bytes": 64u64 << 20, "max_age_s": 259_200}})
    }

    fn org(name: &str, dests: Vec<Value>, active: Vec<TightenEntry>) -> OrgConfig {
        OrgConfig { org: name.into(), serving: true, expires: NOW + 30 * 86_400, destinations: dests, active }
    }

    fn tighten(tseq: u64, action: &str, target: Value) -> TightenEntry {
        TightenEntry::parse(&json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW, "action": action, "target": target})).unwrap()
    }

    fn entry(seq: u64, repr: Repr, action: &str) -> Value {
        let mut e = json!({"seq": seq, "ts": NOW + seq as i64, "org": ORG, "rid": "AAAAAAAAAAAAAAAAAAAAAA", "source": "console", "action": action,
                           "scope": "monitor.read", "route": "GET /api/orgs/acme/v1/health", "resource": "console", "result": "ok",
                           "check": "none", "bytes_out": 10, "count": 1, "prev": "0".repeat(64), "hash": format!("{seq:064x}")});
        match repr {
            Repr::AsIs => {
                e["client"] = json!(CANARY_CLIENT);
                e["ip"] = json!(CANARY_IP);
            }
            Repr::Pseudonymized => {
                e["client"] = json!("p_0123456789abcdef");
                e["ip"] = json!("p_fedcba9876543210");
                e["pkv"] = json!(1);
                e["raw_seq"] = json!(seq);
            }
            Repr::Removed => e["raw_seq"] = json!(seq),
        }
        e
    }

    fn span(rid: &str) -> Value {
        span_value(&SpanCall { org: ORG, method: "GET", route: "/api/orgs/{org}/v1/health", status: 200, rid, relay: "console", start_ms: T, end_ms: T + 3 })
    }

    struct FakeSink {
        sent: Arc<Mutex<Vec<(Batch, bool)>>>,
        fail: Arc<Mutex<Option<SinkError>>>,
        /// Held by a test to keep a delivery in flight; `entered` says one is.
        hold: Arc<Mutex<()>>,
        entered: Arc<AtomicBool>,
    }

    impl Sink for FakeSink {
        fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
            self.entered.store(true, Ordering::SeqCst);
            drop(self.hold.lock());
            // a lost acknowledgment: the tool got the batch, the exporter hears a failure
            let fail = self.fail.lock().clone();
            self.sent.lock().push((batch.clone(), fail.is_none()));
            fail.map_or(Ok(()), Err)
        }
    }

    struct FakeHost {
        cfg: Mutex<(Option<Edition>, Vec<OrgConfig>)>,
        audit: Mutex<HashMap<Repr, Vec<Value>>>,
        recorded: Mutex<Vec<Value>>,
        sent: Arc<Mutex<Vec<(Batch, bool)>>>,
        fail: Arc<Mutex<Option<SinkError>>>,
        hold: Arc<Mutex<()>>,
        entered: Arc<AtomicBool>,
        made: AtomicUsize,
        deleted: Mutex<Vec<(String, String)>>,
    }

    impl FakeHost {
        fn new(edition: Option<Edition>, dests: Vec<Value>, active: Vec<TightenEntry>) -> Arc<FakeHost> {
            FakeHost::with(edition, vec![org(ORG, dests, active)])
        }

        fn with(edition: Option<Edition>, orgs: Vec<OrgConfig>) -> Arc<FakeHost> {
            Arc::new(FakeHost {
                cfg: Mutex::new((edition, orgs)),
                audit: Mutex::new(HashMap::new()),
                recorded: Mutex::new(Vec::new()),
                sent: Arc::new(Mutex::new(Vec::new())),
                fail: Arc::new(Mutex::new(None)),
                hold: Arc::new(Mutex::new(())),
                entered: Arc::new(AtomicBool::new(false)),
                made: AtomicUsize::new(0),
                deleted: Mutex::new(Vec::new()),
            })
        }

        fn add_audit(&self, seqs: std::ops::RangeInclusive<u64>) {
            let mut a = self.audit.lock();
            for s in seqs {
                for r in Repr::ALL {
                    a.entry(r).or_default().push(entry(s, r, "api.call"));
                }
            }
        }

        fn set_active(&self, active: Vec<TightenEntry>) {
            self.cfg.lock().1[0].active = active;
        }

        fn fail_with(&self, retryable: bool) {
            *self.fail.lock() = Some(SinkError { retryable, code: "test", message: "The collector did not answer.".into() });
        }

        fn ok(&self) {
            *self.fail.lock() = None;
        }

        /// Records of the batches the tool accepted, in order.
        fn delivered(&self, sig: Signal) -> Vec<Value> {
            self.sent.lock().iter().filter(|(b, ok)| *ok && b.signal == sig).flat_map(|(b, _)| b.records.clone()).collect()
        }

        fn seqs(&self) -> Vec<u64> {
            self.delivered(Signal::Audit).iter().map(|r| r["attributes"]["lucid.seq"].as_u64().unwrap()).collect()
        }
    }

    impl Host for FakeHost {
        fn config(&self, _now: i64) -> (Option<Edition>, Vec<OrgConfig>) {
            self.cfg.lock().clone()
        }
        fn credential(&self, _org: &str, _id: &str) -> Option<Credential> {
            Some(Credential::Token("secret-token".into()))
        }
        fn delete_credential(&self, org: &str, id: &str) {
            self.deleted.lock().push((org.to_string(), id.to_string()));
        }
        fn pseudonym_key(&self, _org: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![7u8; 32]))
        }
        fn audit_sources(&self, _org: &str) -> Vec<String> {
            vec!["console".into()]
        }
        fn audit_read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Vec<Value> {
            if source != "console" || org != ORG {
                return Vec::new();
            }
            self.audit.lock().get(&repr).map(|v| v.iter().filter(|e| e["seq"].as_u64().unwrap() > after).take(limit).cloned().collect()).unwrap_or_default()
        }
        fn audit_record(&self, _org: &str, entry: Value, _now: i64) {
            self.recorded.lock().push(entry);
        }
        fn metric_rows(&self, _org: &str, _now: i64) -> Vec<MetricRow> {
            Vec::new()
        }
        fn resource(&self, org: &str) -> Vec<(String, String)> {
            vec![("service.name".into(), "lucid-console".into()), ("lucid.org".into(), org.into())]
        }
        fn make_sink(&self, _d: &Value, _c: Credential) -> Result<Box<dyn Sink>, SinkError> {
            self.made.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(FakeSink { sent: self.sent.clone(), fail: self.fail.clone(), hold: self.hold.clone(), entered: self.entered.clone() }))
        }
    }

    fn engine(dir: &Path, host: &Arc<FakeHost>) -> Arc<ExportEngine> {
        let e = ExportEngine::open(dir, host.clone(), Arc::new(Logger::capture("test", Box::new(|_, _| {}))), false);
        e.refresh(NOW);
        e
    }

    fn status_of(e: &ExportEngine, org: &str, id: &str, now: i64) -> Value {
        e.status(Some(org), now).into_iter().find(|s| s["id"] == id).unwrap_or(Value::Null)
    }

    fn state(e: &ExportEngine, id: &str) -> String {
        status_of(e, ORG, id, T)["state"].as_str().unwrap_or_default().to_string()
    }

    fn metric_row(prom: &str, label: (&str, &str), v: f64) -> Vec<MetricRow> {
        vec![MetricRow { prom: prom.into(), labels: vec![(label.0.into(), label.1.into())], value: v }]
    }

    #[test]
    fn audit_is_in_order_and_at_least_once_across_a_restart() {
        let dir = tmp("restart");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=5);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        host.fail_with(true);
        e.pump(T);
        assert_eq!(host.sent.lock().len(), 1, "one attempt, its acknowledgment lost");
        assert_eq!(state(&e, D1), "retrying");
        drop(e);
        host.ok();
        let e = engine(&dir, &host);
        e.pull_audit(T);
        e.pump(T);
        assert_eq!(host.seqs(), vec![1, 2, 3, 4, 5], "sent again after the restart, nothing enqueued twice");
        host.add_audit(6..=7);
        e.pull_audit(T + 1000);
        e.pump(T + 1000);
        let all: Vec<u64> = host.sent.lock().iter().flat_map(|(b, _)| b.records.iter().map(|r| r["attributes"]["lucid.seq"].as_u64().unwrap()).collect::<Vec<_>>()).collect();
        assert_eq!(all, vec![1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 7]);
        let ids: BTreeSet<String> = host.delivered(Signal::Audit).iter().map(|r| r["attributes"]["lucid.event_id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids.len(), 7);
        assert!(ids.contains("lucid-api-audit-as-is-v1:acme/console:7"));
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(8));
        assert_eq!(state(&e, D1), "ok");
        assert!(dir.join(ORG).join(D1).join("audit").exists(), "queues live under exports/<org>/<id>/");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_is_never_dropped_under_a_full_queue() {
        let dir = tmp("full");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=20);
        let e = engine(&dir, &host);
        e.set_limits(ORG, D1, 1, 3600);
        host.fail_with(true);
        let mut t = T;
        for _ in 0..5 {
            e.pull_audit(t);
            e.pump(t);
            t += 600_000;
        }
        assert_eq!(state(&e, D1), "paused");
        assert_eq!(e.audit_backlog(), vec![(ORG.to_string(), D1.to_string(), format!("dest {D1}"))]);
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(1), "the chain keeps everything from seq 1");
        assert_eq!(status_of(&e, ORG, D1, t)["counters"]["dropped"], 0);
        host.ok();
        for _ in 0..100 {
            e.pull_audit(t);
            e.pump(t);
            t += 1000;
            if host.seqs().len() == 20 {
                break;
            }
        }
        assert_eq!(host.seqs(), (1..=20).collect::<Vec<u64>>(), "resumed from the first unsent seq, nothing lost");
        e.pull_audit(t);
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(21));
        assert_eq!(state(&e, D1), "ok");
        assert!(e.audit_backlog().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metrics_are_dropped_oldest_first() {
        let dir = tmp("metrics");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["metrics"], "internal", "as_is")], vec![]);
        let e = engine(&dir, &host);
        let row = |v: f64| metric_row("lucid_api_clients", ("state", "active"), v);
        e.push(Item::Metrics { org: ORG.into(), rows: row(1.0), t_ms: T });
        e.drain(T);
        let one = status_of(&e, ORG, D1, T)["backlog_bytes"].as_u64().unwrap();
        assert!(one > 0);
        e.set_limits(ORG, D1, one, 3600);
        for v in [2.0, 3.0] {
            e.push(Item::Metrics { org: ORG.into(), rows: row(v), t_ms: T });
            e.drain(T);
        }
        assert_eq!(status_of(&e, ORG, D1, T)["counters"]["dropped"], 2);
        e.pump(T);
        let got = host.delivered(Signal::Metrics);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["points"][0]["v"], 3.0, "the newest sample stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_queue_limit_covers_every_signal_together() {
        let dir = tmp("total");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit", "metrics", "traces"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=1);
        let e = engine(&dir, &host);
        e.push(Item::Metrics { org: ORG.into(), rows: metric_row("lucid_api_clients", ("state", "active"), 1.0), t_ms: T });
        e.push(Item::Span { org: ORG.into(), span: span("AAAAAAAAAAAAAAAAAAAAAA") });
        e.drain(T);
        let two = status_of(&e, ORG, D1, T)["backlog_bytes"].as_u64().unwrap();
        // room for both, not for a third record of any signal
        e.set_limits(ORG, D1, two, 3600);
        e.pull_audit(T + 1);
        let st = status_of(&e, ORG, D1, T + 1);
        // each signal alone is under the limit; together with the audit record they are not
        assert!(st["counters"]["dropped"].as_u64().unwrap() >= 1, "the oldest non-audit record made room: {st}");
        e.pump(T + 1);
        assert_eq!(host.seqs(), vec![1], "audit is never what goes");
        assert!(host.delivered(Signal::Metrics).len() + host.delivered(Signal::Traces).len() < 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delta_temporality_sends_differences() {
        let dir = tmp("delta");
        let mut d = dest(D1, "otlp", &["metrics"], "internal", "as_is");
        d["settings"] = json!({"temporality": "delta"});
        let host = FakeHost::new(Some(Edition::Enterprise), vec![d], vec![]);
        let e = engine(&dir, &host);
        for v in [10.0, 15.0] {
            e.push(Item::Metrics { org: ORG.into(), rows: metric_row("lucid_api_refusals_total", ("check", "scope"), v), t_ms: T });
            e.drain(T);
        }
        e.pump(T);
        let got = host.delivered(Signal::Metrics);
        assert_eq!(got.len(), 1, "the first reading is the baseline");
        assert_eq!((got[0]["temporality"].as_str(), got[0]["kind"].as_str(), got[0]["points"][0]["v"].as_f64()), (Some("delta"), Some("sum"), Some(5.0)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ceiling_and_unknown_refusals_are_counted_and_audited() {
        let dir = tmp("refused");
        let host = FakeHost::new(
            Some(Edition::Enterprise),
            vec![dest(D1, "otlp", &["audit"], "internal", "as_is"), dest(D2, "otlp", &["audit"], "confidential", "as_is")],
            vec![],
        );
        {
            let mut a = host.audit.lock();
            for r in Repr::ALL {
                a.insert(r, vec![entry(1, r, "api.call"), entry(2, r, "made.up.action")]);
            }
        }
        let e = engine(&dir, &host);
        e.pull_audit(T);
        let of = |id: &str| status_of(&e, ORG, id, T)["counters"]["refused"].clone();
        assert!(of(D1)["ceiling"].as_u64().unwrap() >= 1, "an as_is entry is confidential, above an internal ceiling");
        assert_eq!(of(D2)["identity"], 1, "an action missing from the registry");
        assert!(of(D2).get("ceiling").is_none());
        e.pump(T);
        assert_eq!(host.seqs(), vec![1], "only the listed action within the ceiling leaves");
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(3), "refused entries do not hold retention");
        e.tick(T + 60_000);
        let rec = host.recorded.lock().clone();
        let refused: Vec<&Value> = rec.iter().filter(|r| r["action"] == "exports.refused").collect();
        assert!(refused.iter().any(|r| r["destination"] == D1 && r["check"] == "ceiling"));
        assert!(refused.iter().any(|r| r["destination"] == D2 && r["check"] == "identity" && r["count"] == 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pseudonymized_destination_never_receives_a_raw_identity() {
        let dir = tmp("canary");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit", "traces", "metrics"], "internal", "pseudonymized")], vec![]);
        host.add_audit(1..=3);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        let mut s = span("AAAAAAAAAAAAAAAAAAAAAA");
        s["attributes"]["lucid.client"] = json!(CANARY_CLIENT);
        e.push(Item::Span { org: ORG.into(), span: s });
        let rows = vec![MetricRow { prom: "lucid_api_requests_total".into(), labels: vec![("client".into(), CANARY_CLIENT.into()), ("result".into(), "ok".into())], value: 5.0 }];
        e.push(Item::Metrics { org: ORG.into(), rows, t_ms: T });
        e.drain(T);
        e.pump(T);
        assert_eq!(host.seqs(), vec![1, 2, 3]);
        assert_eq!(host.delivered(Signal::Traces).len(), 1);
        assert_eq!(host.delivered(Signal::Metrics).len(), 1);
        let all = stringify(&json!(host.sent.lock().iter().map(|(b, _)| b.records.clone()).collect::<Vec<_>>()));
        assert!(!all.contains(CANARY_CLIENT) && !all.contains(CANARY_IP), "{all}");
        let audit = host.delivered(Signal::Audit);
        assert!(audit[0]["body"]["client"].as_str().unwrap().starts_with("p_"));
        assert!(audit[0]["attributes"]["lucid.chain"].as_str().unwrap().starts_with("lucid-api-audit-pseudo-v1:acme/"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_identities_tightening_requeues_audit_in_the_stricter_form() {
        let dir = tmp("narrow");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=3);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        host.set_active(vec![tighten(1, "destination_identities", json!({"destination": D1, "identities": "removed"}))]);
        e.refresh(NOW);
        e.pull_audit(T);
        e.pump(T);
        let audit = host.delivered(Signal::Audit);
        assert_eq!(host.seqs(), vec![1, 2, 3]);
        assert!(audit.iter().all(|r| r["body"].get("client").is_none() && r["body"].get("ip").is_none()));
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), None, "a removed destination holds only the removed chain");
        assert_eq!(e.hold(ORG, "console", Repr::Removed), Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tightening_refuses_stale_appends_and_waits_for_a_send_in_flight() {
        let dir = tmp("stale");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit", "traces"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=2);
        let e = engine(&dir, &host);
        // work made under the old config is refused once the config changed
        let rt = e.rt(ORG, D1);
        let (cfg, epoch) = rt.snap();
        host.set_active(vec![tighten(1, "destination_lower_ceiling", json!({"destination": D1, "ceiling": "internal"}))]);
        e.refresh(NOW);
        assert!(!e.enqueue(&rt, &cfg, epoch, Signal::Traces, vec![(json!({"x": 1}), T, None)], T));
        assert_eq!(status_of(&e, ORG, D1, T)["backlog_bytes"], 0);
        // a tightening waits for the delivery in flight under the wider config
        host.set_active(vec![]);
        e.refresh(NOW);
        e.pull_audit(T);
        let gate = host.hold.lock();
        let (e2, done) = (e.clone(), Arc::new(AtomicBool::new(false)));
        let sender = std::thread::spawn(move || e2.pump(T));
        for _ in 0..500 {
            if host.entered.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(host.entered.load(Ordering::SeqCst), "the delivery is in flight");
        host.set_active(vec![tighten(1, "destination_identities", json!({"destination": D1, "identities": "removed"}))]);
        let (e3, d) = (e.clone(), done.clone());
        let tightening = std::thread::spawn(move || {
            e3.refresh(NOW);
            d.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(!done.load(Ordering::SeqCst), "the tightening returned while a wider delivery was in flight");
        drop(gate);
        sender.join().unwrap();
        tightening.join().unwrap();
        assert!(done.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_map_stops_enqueue_and_delivery_at_the_instant() {
        let dir = tmp("expired");
        let mut o = org(ORG, vec![dest(D1, "otlp", &["audit", "traces"], "confidential", "as_is")], vec![]);
        o.expires = NOW + 100;
        let host = FakeHost::with(Some(Edition::Enterprise), vec![o]);
        host.add_audit(1..=2);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        let at = (NOW + 100) * 1000;
        assert_eq!(e.pump(at), 0, "nothing leaves at the expiry instant");
        assert!(host.sent.lock().is_empty());
        assert_eq!(state(&e, D1), "ok");
        assert_eq!(status_of(&e, ORG, D1, at)["state"], "suspended");
        e.push(Item::Span { org: ORG.into(), span: span("BBBBBBBBBBBBBBBBBBBBBB") });
        let before = status_of(&e, ORG, D1, at)["backlog_bytes"].clone();
        e.drain(at);
        assert_eq!(status_of(&e, ORG, D1, at)["backlog_bytes"], before, "nothing is enqueued after it");
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(1), "the queued audit stays held");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logs_and_spans_have_their_own_intake() {
        let dir = tmp("intake");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["traces", "metrics"], "confidential", "as_is")], vec![]);
        let e = engine(&dir, &host);
        // a metrics burst never pushes a span out
        e.push(Item::Span { org: ORG.into(), span: span("AAAAAAAAAAAAAAAAAAAAAA") });
        for _ in 0..METRICS_INTAKE + 10 {
            e.push(Item::Metrics { org: ORG.into(), rows: metric_row("lucid_api_clients", ("state", "active"), 1.0), t_ms: T });
        }
        e.drain(T);
        e.pump(T);
        assert_eq!(host.delivered(Signal::Traces).len(), 1);
        // a full event intake drops the new span, counted for the destination
        for _ in 0..=INTAKE_MAX {
            e.push(Item::Span { org: ORG.into(), span: span("AAAAAAAAAAAAAAAAAAAAAA") });
        }
        assert_eq!(status_of(&e, ORG, D1, T)["counters"]["intake"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_destination_id_in_two_orgs_stays_apart() {
        let dir = tmp("orgs");
        let both = vec![org(ORG, vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]), org(ORG2, vec![dest(D1, "otlp", &["metrics"], "internal", "as_is")], vec![])];
        let host = FakeHost::with(Some(Edition::Enterprise), both);
        host.add_audit(1..=2);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        assert_eq!(e.status(None, T).len(), 2);
        assert!(dir.join(ORG).join(D1).exists() && dir.join(ORG2).join(D1).exists());
        host.set_active(vec![tighten(1, "destination_delete", json!(D1))]);
        e.refresh(NOW);
        assert!(!dir.join(ORG).join(D1).exists());
        assert!(dir.join(ORG2).join(D1).exists(), "the other org's destination is untouched");
        assert_eq!(*host.deleted.lock(), vec![(ORG.to_string(), D1.to_string())]);
        assert_eq!(e.status(Some(ORG2), T).len(), 1);
        assert_eq!(seal_name(ORG, D1), format!("secret:acme:{D1}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deleted_destination_stops_at_once_and_its_queue_is_removed() {
        let dir = tmp("delete");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=3);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        assert!(dir.join(ORG).join(D1).join("audit").exists());
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(1));
        host.set_active(vec![tighten(1, "destination_delete", json!(D1))]);
        e.refresh(NOW);
        assert!(!dir.join(ORG).join(D1).exists());
        assert!(e.status(None, T).is_empty());
        assert_eq!(e.pump(T), 0);
        assert!(host.sent.lock().is_empty());
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), None);
        assert_eq!(*host.deleted.lock(), vec![(ORG.to_string(), D1.to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_set_aside_map_suspends_without_deleting() {
        let dir = tmp("aside");
        let host = FakeHost::new(Some(Edition::Enterprise), vec![dest(D1, "otlp", &["audit"], "confidential", "as_is")], vec![]);
        host.add_audit(1..=2);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        host.cfg.lock().1[0].serving = false;
        e.refresh(NOW);
        assert_eq!(state(&e, D1), "suspended");
        assert_eq!(e.pump(T), 0);
        assert_eq!(e.hold(ORG, "console", Repr::AsIs), Some(1));
        assert!(host.deleted.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_standard_edition_refuses_splunk_hec() {
        let dir = tmp("standard");
        let mut hec = dest(D1, "splunk_hec", &["audit"], "internal", "removed");
        hec["settings"] = json!({"index": "lucid", "ack": true});
        let host = FakeHost::new(Some(Edition::Standard), vec![hec], vec![]);
        host.add_audit(1..=2);
        let e = engine(&dir, &host);
        e.pull_audit(T);
        assert_eq!(e.pump(T), 0);
        assert_eq!(host.made.load(Ordering::Relaxed), 0);
        let st = status_of(&e, ORG, D1, T);
        assert_eq!(st["state"], "failed");
        assert!(st["last_error"].as_str().unwrap().contains("standard edition"));
        // one otlp destination plus syslog_cef; pseudonymized becomes removed
        let a = effective(ORG, &dest(D1, "otlp", &["audit"], "internal", "pseudonymized"), &[], Some(Edition::Standard), 0).unwrap();
        assert_eq!((a.refused.is_none(), a.identities), (true, Identities::Removed));
        assert!(effective(ORG, &dest(D2, "otlp", &["audit"], "internal", "as_is"), &[], Some(Edition::Standard), 1).unwrap().refused.is_some());
        assert!(effective(ORG, &dest(D2, "syslog_cef", &["audit"], "internal", "as_is"), &[], Some(Edition::Standard), 1).unwrap().refused.is_none());
        assert!(effective(ORG, &dest(D2, "otlp", &["audit"], "internal", "as_is"), &[], None, 0).unwrap().refused.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tightenings_apply_to_the_effective_destination() {
        let d = dest(D1, "otlp", &["audit", "logs", "metrics"], "confidential", "as_is");
        let active = vec![
            tighten(1, "destination_drop_signal", json!({"destination": D1, "signal": "logs"})),
            tighten(2, "destination_lower_ceiling", json!({"destination": D1, "ceiling": "internal"})),
            tighten(3, "destination_identities", json!({"destination": D1, "identities": "pseudonymized"})),
            tighten(4, "destination_suspend", json!(D2)),
        ];
        let e = effective(ORG, &d, &active, Some(Edition::Enterprise), 0).unwrap();
        assert_eq!(e.signals, vec![Signal::Audit, Signal::Metrics]);
        assert_eq!((e.ceiling, e.identities, e.suspended), (Ceiling::Internal, Identities::Pseudonymized, false));
        assert_eq!(e.entry["signals"], json!(["audit", "metrics"]));
        let s = effective(ORG, &d, &[tighten(1, "destination_suspend", json!(D1))], Some(Edition::Enterprise), 0).unwrap();
        assert!(s.suspended);
        assert!(effective(ORG, &d, &[tighten(1, "destination_delete", json!(D1))], Some(Edition::Enterprise), 0).is_none());
    }

    #[test]
    fn the_queue_survives_a_torn_tail() {
        let dir = tmp("queue");
        let mut q = Queue::open(dir.clone(), SEGMENT_BYTES);
        q.append((1..=3).map(|i| (json!({"i": i}), T, None)).collect()).unwrap();
        q.ack(1).unwrap();
        let seg = std::fs::read_dir(&dir).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".jsonl")).unwrap().path();
        std::fs::OpenOptions::new().append(true).open(&seg).unwrap().write_all(b"{\"n\":4,\"t\":1,\"r\"").unwrap();
        let mut q = Queue::open(dir.clone(), SEGMENT_BYTES);
        assert_eq!(q.count, 2);
        q.append(vec![(json!({"i": 4}), T, Some(("console".into(), 9)))]).unwrap();
        let b = q.batch(10, BATCH_BYTES).unwrap();
        assert_eq!(b.iter().map(|(n, r)| (*n, r["i"].as_i64().unwrap())).collect::<Vec<_>>(), vec![(2, 2), (3, 3), (4, 4)]);
        assert_eq!(q.first_mark("console"), Some(9));
        q.clear().unwrap();
        assert_eq!(Queue::open(dir.clone(), SEGMENT_BYTES).count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_queue_keeps_only_the_oldest_segment_in_memory() {
        let dir = tmp("sparse");
        let mut q = Queue::open(dir.clone(), 300);
        for i in 1..=50u64 {
            let mark = (i == 40).then(|| ("r_01".to_string(), 77));
            q.append(vec![(json!({"i": i}), T + i as i64, mark)]).unwrap();
        }
        let mut q = Queue::open(dir.clone(), 300);
        assert_eq!(q.count, 50);
        assert!(q.segs.len() > 3, "{} segments", q.segs.len());
        assert!(q.cur.len() < 50 && q.cur.len() as u64 == q.segs[0].count);
        assert_eq!(q.first_mark("r_01"), Some(77), "a later segment's mark without its records");
        assert_eq!(q.last_marks().get("r_01"), Some(&77));
        let mut seen = Vec::new();
        while !q.is_empty() {
            let b = q.batch(1000, BATCH_BYTES).unwrap();
            assert!(!b.is_empty());
            seen.extend(b.iter().map(|(_, r)| r["i"].as_u64().unwrap()));
            q.ack(b.last().unwrap().0).unwrap();
        }
        assert_eq!(seen, (1..=50).collect::<Vec<u64>>(), "every record once, in order, across segments");
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".jsonl")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_the_oldest_crosses_segments() {
        let dir = tmp("drop");
        let mut qs = Queue::open(dir.clone(), 200);
        for i in 1..=30u64 {
            qs.append(vec![(json!({"i": i}), T + i as i64, None)]).unwrap();
        }
        for _ in 0..25 {
            assert!(qs.pop_front());
        }
        qs.persist().unwrap();
        let q = Queue::open(dir.clone(), 200);
        assert_eq!(q.count, 5);
        assert_eq!(q.bytes, qs.bytes);
        assert_eq!(q.batch(10, BATCH_BYTES).unwrap()[0].1["i"], 26);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exposition_text_reads_as_rows() {
        let text = "# HELP lucid_relay_up 1 when up.\n# TYPE lucid_relay_up gauge\nlucid_relay_up{relay=\"r_01\",name=\"A \\\"b\\\"\",site=\"\"} 1\nlucid_console_info 1\nlucid_relay_health{state=\"ok\"} NaN\n";
        let rows = parse_exposition(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].labels, vec![("relay".to_string(), "r_01".to_string()), ("name".to_string(), "A \"b\"".to_string()), ("site".to_string(), String::new())]);
        assert_eq!((rows[1].prom.as_str(), rows[1].value), ("lucid_console_info", 1.0));
    }

    #[test]
    fn credentials_round_trip_and_fit_their_entry() {
        let c = Credential::EntraCertificate { tenant: "t".into(), client_id: "c".into(), cloud: "usgov".into(), cert_pem: "CERT".into(), key_pem: "KEY".into() };
        let v = sealed_credential(&c, NOW);
        assert!(v.get("rotate_by").is_none());
        let back = credential_of(&v["credential"]).unwrap();
        assert_eq!(credential_json(&back), credential_json(&c));
        let mut d = dest(D1, "otlp", &["metrics"], "internal", "as_is");
        d["credential"] = json!({"type": "entra_certificate", "ref": format!("secret:{D1}"), "tenant": "t", "client_id": "c", "cloud": "usgov"});
        assert!(credential_fits(&d, &c));
        assert!(!credential_fits(&d, &Credential::Token("x".into())));
        let t = sealed_credential(&Credential::Token("x".into()), NOW);
        assert_eq!(t["rotate_by"], NOW + 90 * 86_400);
        assert!(!format!("{:?}", Credential::Token("hunter2".into())).contains("hunter2"));
    }
}
