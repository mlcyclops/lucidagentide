// Contract API-1 (docs/api/contract.md) section 9: the API audit chains.
//
// Per org and source (9.1) three chains (9.3): `as_is` (label `lucid-api-audit-as-is-v1:<org>`), `pseudonymized`
// (`lucid-api-audit-pseudo-v1:<org>`, identity fields as `p_` + 16 hex of HMAC-SHA-256(org pseudonym key, value) and
// the key version `pkv`; with no key the removed form and `pkv` 0) and `removed` (`lucid-api-audit-removed-v1:<org>`,
// identity fields dropped). Each derived entry carries `raw_seq`. Built as `console_audit.rs`: JSONL segments of
// 8 MiB under `<state>/api-audit/<org>/<source>/<repr>-<6 digits>.jsonl`, a head file per chain
// (`<repr>-head.json`: seq, hash, segment, the dropped front), a broken tail moved aside to `<repr>-torn-<t>.jsonl`
// with the verified prefix kept, hash = SHA-256(lp(label, prev as 32 raw bytes, CE-1 canonical JSON of the entry
// without `hash`)), the first prev 64 zeros. `source` is `console` or the relay id; on the console the chains a
// relay ships (`api-audit`, `api-chains`) are kept under `<org>/<relay id>/` as received, after every entry is
// checked in full: link and hash, org, the known fields only, `source`/`relay` naming that relay, pseudonyms only (or
// nothing) in identity fields of derived entries, `raw_seq` equal to `seq` and the same decision as the entry of
// that seq already stored in the other representations, and every checkpoint's payload naming the heads before it,
// signed by a checkpoint certificate stored for that relay and org (`add_keys`).
//
// Crash-atomic append (API1-S5): the three entries and the three prior heads go to `txn.jsonl` (written and flushed),
// then each chain file is appended and flushed, then a commit marker is appended and flushed. At open, and before
// the next append after a failed write, an uncommitted transaction is completed: an entry already present with the
// expected head is not appended twice.
//
// Checkpoints (API1-S4): every 1000 entries or 5 minutes a `checkpoint` entry goes to all three chains, carrying
// `kid`, `payload` (base64url of the CE-1 JSON of {org, source, ts, heads}, the heads being those before the
// checkpoint entry) and `sig` (base64url of the ES256 r||s signature over lp("lucid-api-audit-checkpoint-v1",
// payload JSON)), made by the org's dedicated checkpoint key (`api_checkpoint.rs`). A signer without a certified key
// writes no checkpoint; the next tick tries again.
//
// Refusal flooding (9.4, API1-S7): equivalent refusals (org, client or source key, check, route) within a minute get
// entries of their own up to 10 (a source key `ip:<addr>` folds from the first); the rest are counted in a bucket
// whose new total is appended and flushed to `summary.wal` before the refusal is answered. The WAL has a hard byte
// budget: an open line (the bucket's id, key, minute and fields, at most 2 KiB) per bucket, at most 4096 open
// buckets, small count and retire lines, and a compaction (one open line per open bucket) whenever the next line
// would pass the budget; when it still would not fit, the refusal is answered audit-unavailable without appending.
// At the minute's end the bucket becomes one `api.refusal.summary` entry with the exact `count` and its id in
// `bucket`; a retire line follows its commit. A crash between the two leaves that summary as the last transaction
// in `txn.jsonl`, so at open a bucket whose id is in the last committed transaction is not written twice. At open
// every other recovered bucket is flushed first.
//
// Free space: 64 MiB of the audit volume are reserved; below it (the volume's free bytes as `fleet_metrics`
// reads them: statvfs on 64-bit Linux, GetDiskFreeSpaceExW on Windows; elsewhere unknown counts as enough) every
// entry other than a refusal is refused with audit-unavailable, while refusals go on (folded as summaries). Writes
// here are synchronous under the org's lock, so the 2 s channel wait of 9.4 has no queue to wait on.
//
// Retention: a segment (never the newest) goes once its last entry is older than 400 days and every entry in it is
// below the retention hold of its chain (org, source, representation: the lowest seq of that chain an audit
// destination has not acknowledged, slice 1a4), for this source's chains and the relay chains received alike; the
// dropped front is kept in the head file so the chain still verifies.

use crate::codec::{b64u, hex, parse_json, sha256, stringify, unb64u};
use crate::console_audit::canonical_json;
use crate::fleet_local::write_durable;
use crate::meet_org_policy::lp;
use crate::store::{make_dir, write_private};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The folder under the state folder.
pub const AUDIT_DIR: &str = "api-audit";
pub const SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
/// 9.4: the free space kept for refusal summaries.
pub const RESERVE_BYTES: u64 = 64 * 1024 * 1024;
/// 9.4: open buckets in `summary.wal`.
pub const WAL_BUCKETS: usize = 4096;
/// The longest open line of a bucket; a refusal whose fields pass it is answered audit-unavailable.
pub const WAL_LINE_MAX: usize = 2048;
/// The hard size of `summary.wal`: every bucket's open line plus 1 MiB of count and retire lines between compactions.
pub const WAL_BYTES: u64 = (WAL_BUCKETS * WAL_LINE_MAX) as u64 + 1024 * 1024;
/// 9.4: equivalent refusals in a minute that get entries of their own.
pub const OWN_REFUSALS: u64 = 10;
/// 9.3: a checkpoint every 1000 entries or 5 minutes.
pub const CHECKPOINT_ENTRIES: u64 = 1000;
pub const CHECKPOINT_SECS: i64 = 300;
/// 9.4: 400 days.
pub const RETENTION_SECS: i64 = 400 * 86_400;
pub const CHECKPOINT_LABEL: &str = "lucid-api-audit-checkpoint-v1";
/// 8.2 pagination: the most entries one read returns (the routes' default page is `api_resource::PAGE_DEFAULT`).
pub const LIMIT_MAX: usize = 1000;
const TXN_FILE: &str = "txn.jsonl";
const WAL_FILE: &str = "summary.wal";
/// On the console: the checkpoint certificates of a relay's chains (`add_keys`).
const KEYS_FILE: &str = "keys.json";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_SAFE: u64 = (1 << 53) - 1;
/// Distinct (key, check, route, minute) counters of own refusals kept at once; past it refusals fold at once.
const SEEN_MAX: usize = 100_000;
/// How long a pseudonym key read from the sealed store is reused.
const PKEY_TTL: Duration = Duration::from_secs(10);
/// How long a free-space reading is reused.
const FREE_TTL: Duration = Duration::from_secs(1);

/// Identity fields (the 1a3 table; the full registry is slice 1a4): pseudonymized or dropped.
pub const IDENTITY_FIELDS: [&str; 7] = ["client", "act", "ip", "principal", "serial", "device", "node"];
/// Every other field a caller may set; anything else is refused (fail closed).
pub const PLAIN_FIELDS: [&str; 26] = [
    "rid", "source", "relay", "action", "scope", "route", "resource", "result", "check", "jti", "bytes_out", "count", "status", "code", "method", "map_seq", "map_hash", "tseq", "op", "kind", "aud",
    "exp", "cnf", "auth", "until", "destination",
];
/// Actions only this file writes.
const RESERVED_ACTIONS: [&str; 2] = ["checkpoint", "api.refusal.summary"];
/// Fields this file writes: every entry's, a summary's bucket id, a checkpoint's.
const CHAIN_FIELDS: [&str; 5] = ["seq", "ts", "org", "prev", "hash"];
const OWN_FIELDS: [&str; 4] = ["bucket", "kid", "payload", "sig"];

// ── representations, errors, hooks ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Repr {
    AsIs,
    Pseudonymized,
    Removed,
}

impl Repr {
    pub const ALL: [Repr; 3] = [Repr::AsIs, Repr::Pseudonymized, Repr::Removed];

    pub fn of(s: &str) -> Option<Repr> {
        match s {
            "as_is" => Some(Repr::AsIs),
            "pseudonymized" => Some(Repr::Pseudonymized),
            "removed" => Some(Repr::Removed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Repr::AsIs => "as_is",
            Repr::Pseudonymized => "pseudonymized",
            Repr::Removed => "removed",
        }
    }

    fn index(self) -> usize {
        match self {
            Repr::AsIs => 0,
            Repr::Pseudonymized => 1,
            Repr::Removed => 2,
        }
    }

    /// The chain's hash label.
    pub fn label(self, org: &str) -> String {
        let part = match self {
            Repr::AsIs => "as-is",
            Repr::Pseudonymized => "pseudo",
            Repr::Removed => "removed",
        };
        format!("lucid-api-audit-{part}-v1:{org}")
    }
}

/// `audit-unavailable` (answer 503) or `bad-request` (400).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditError {
    pub code: &'static str,
    pub message: String,
}

impl AuditError {
    pub fn unavailable(message: impl Into<String>) -> AuditError {
        AuditError { code: "audit-unavailable", message: message.into() }
    }

    pub fn bad(message: impl Into<String>) -> AuditError {
        AuditError { code: "bad-request", message: message.into() }
    }

    #[cfg(test)]
    pub fn status(&self) -> u16 {
        if self.code == "bad-request" {
            400
        } else {
            503
        }
    }
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Why a shipped page of a relay chain was not stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IngestError {
    /// The page does not start at the stored head + 1 (the expected first seq).
    Gap(u64),
    /// A link, hash, org or shape does not verify.
    Invalid(String),
    /// The page could not be stored (disk).
    Unavailable(String),
}

/// The org's audit checkpoint key (`api_checkpoint.rs`).
pub trait CheckpointSigner: Send + Sync {
    /// The certified key's id, None while there is none.
    fn kid(&self, org: &str) -> Option<String>;
    /// ES256 over `payload`: the 64-byte r||s form.
    fn sign(&self, org: &str, payload: &[u8]) -> Option<Vec<u8>>;
    /// Current and retired certificates (`api_checkpoint::cert_value` objects).
    fn certs(&self, org: &str) -> Vec<Value>;
}

/// The org's pseudonym key (11.4): (pkv, key). None: the pseudonymized chain gets the removed form with `pkv` 0.
pub trait PseudonymKeys: Send + Sync {
    fn current(&self, org: &str) -> Option<(u32, Vec<u8>)>;
}

/// Slice 1a4: for (org, source `console` or a relay id, representation) the lowest seq of that chain an audit
/// destination has not acknowledged, None for no hold.
pub type RetentionHold = Arc<dyn Fn(&str, &str, Repr) -> Option<u64> + Send + Sync>;
/// Free bytes of the volume holding a folder, None when this OS cannot say.
pub type FreeSpace = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `[a-z0-9-]{1,32}`.
pub fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `console` or a relay id: `[a-z0-9_-]{1,64}`.
pub fn source_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn now_s() -> i64 {
    crate::codec::now_ms().div_euclid(1000)
}

fn raw32(h: &str) -> Option<[u8; 32]> {
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The hash of an entry (its `hash` key left out) chained to `prev` (64 hex) under `label`.
pub fn chain_hash(label: &str, prev: &str, entry: &Map<String, Value>) -> Option<String> {
    let mut e = entry.clone();
    e.remove("hash");
    let body = canonical_json(&Value::Object(e)).ok()?;
    let p = raw32(prev)?;
    Some(hex(&sha256(&lp(&[label.as_bytes(), &p, &body]))))
}

/// 11.4: `p_` + the first 16 hex of HMAC-SHA-256(key, value).
pub fn pseudonym(key: &[u8], value: &str) -> String {
    let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key);
    let tag = aws_lc_rs::hmac::sign(&k, value.as_bytes());
    format!("p_{}", &hex(tag.as_ref())[..16])
}

/// The bytes a checkpoint signature covers: lp(label, payload JSON).
pub fn checkpoint_signed_bytes(payload_json: &[u8]) -> Vec<u8> {
    lp(&[CHECKPOINT_LABEL.as_bytes(), payload_json])
}

/// An opaque cursor (8.2) naming the org, source and representation it belongs to (9.1).
pub fn cursor(org: &str, source: &str, repr: Repr, seq: u64) -> String {
    b64u(format!("v1\n{org}\n{source}\n{}\n{seq}", repr.as_str()).as_bytes())
}

/// The seq of a cursor made for this org, source and representation; None for any other.
pub fn parse_cursor(c: &str, org: &str, source: &str, repr: Repr) -> Option<u64> {
    let text = String::from_utf8(unb64u(c)?).ok()?;
    let parts: Vec<&str> = text.split('\n').collect();
    let [v, o, s, r, n] = parts.as_slice() else { return None };
    if *v != "v1" || *o != org || *s != source || *r != repr.as_str() || n.is_empty() || n.len() > 16 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// A caller's entry: an object of known fields with string, integer or boolean values (identities strings only) and
/// an action that is not reserved.
fn validate(entry: Value) -> Result<Map<String, Value>, AuditError> {
    let Value::Object(m) = entry else { return Err(AuditError::bad("an audit entry is a JSON object")) };
    for (k, v) in &m {
        let ident = IDENTITY_FIELDS.contains(&k.as_str());
        if !ident && !PLAIN_FIELDS.contains(&k.as_str()) {
            return Err(AuditError::bad(format!("{k} is not an audit field")));
        }
        let ok = match v {
            Value::String(_) => true,
            Value::Bool(_) => !ident,
            Value::Number(n) => !ident && (n.as_u64().is_some_and(|u| u <= MAX_SAFE) || n.as_i64().is_some_and(|i| i.unsigned_abs() <= MAX_SAFE)),
            _ => false,
        };
        if !ok {
            return Err(AuditError::bad(format!("the audit field {k} has a value of the wrong kind")));
        }
    }
    let action = m.get("action").and_then(Value::as_str).ok_or_else(|| AuditError::bad("an audit entry needs an action"))?;
    let shape = (1..=64).contains(&action.len()) && action.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if !shape || RESERVED_ACTIONS.contains(&action) {
        return Err(AuditError::bad(format!("{action} is not an action a caller records")));
    }
    Ok(m)
}

/// The fields of one representation (before seq, ts, org, raw_seq, prev and hash).
fn derive(fields: &Map<String, Value>, repr: Repr, key: Option<&(u32, Vec<u8>)>) -> Map<String, Value> {
    let ident = |k: &str| IDENTITY_FIELDS.contains(&k);
    let mut out = Map::new();
    match (repr, key) {
        (Repr::AsIs, _) => return fields.clone(),
        (Repr::Pseudonymized, Some((pkv, k))) => {
            for (f, v) in fields {
                if ident(f.as_str()) {
                    let text = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
                    out.insert(f.clone(), Value::from(pseudonym(k, &text)));
                } else {
                    out.insert(f.clone(), v.clone());
                }
            }
            out.insert("pkv".into(), Value::from(*pkv));
        }
        (r, _) => {
            for (f, v) in fields.iter().filter(|(f, _)| !ident(f.as_str())) {
                out.insert(f.clone(), v.clone());
            }
            if r == Repr::Pseudonymized {
                out.insert("pkv".into(), Value::from(0));
            }
        }
    }
    out
}

/// One entry checked as chained to `prev` with sequence `seq` in `org`'s chain of `label`: its hash, or None.
fn check_entry(label: &str, org: &str, o: &Map<String, Value>, seq: u64, prev: &str) -> Option<String> {
    if o.get("seq").and_then(Value::as_u64) != Some(seq) || o.get("prev").and_then(Value::as_str) != Some(prev) || o.get("org").and_then(Value::as_str) != Some(org) {
        return None;
    }
    let hash = o.get("hash").and_then(Value::as_str)?;
    (chain_hash(label, prev, o).as_deref() == Some(hash)).then(|| hash.to_owned())
}

/// `p_` and 16 lowercase hex.
fn is_pseudonym(s: &str) -> bool {
    s.len() == 18 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn action_ok(a: &str) -> bool {
    (1..=64).contains(&a.len()) && a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// A received entry of a relay's chain in one representation, checked in full but for its link (`check_entry`): only
/// known fields with scalar values; identities strings, pseudonyms in the pseudonymized form (none with `pkv` 0) and
/// none in the removed form; an action; `source` `relay` and `relay` the relay's id; `raw_seq` its seq; a summary's
/// bucket and a checkpoint's kid, payload and sig on those actions only.
fn check_received(o: &Map<String, Value>, repr: Repr, relay: &str, seq: u64) -> Result<(), String> {
    let bad = |why: String| -> Result<(), String> { Err(format!("entry {seq}: {why}")) };
    for (k, v) in o {
        let k = k.as_str();
        let ident = IDENTITY_FIELDS.contains(&k);
        let known = ident
            || PLAIN_FIELDS.contains(&k)
            || CHAIN_FIELDS.contains(&k)
            || OWN_FIELDS.contains(&k)
            || (k == "raw_seq" && repr != Repr::AsIs)
            || (k == "pkv" && repr == Repr::Pseudonymized);
        if !known {
            return bad(format!("{k} is not an audit field"));
        }
        let scalar = match v {
            Value::String(_) => true,
            Value::Bool(_) => !ident,
            Value::Number(n) => !ident && (n.as_u64().is_some_and(|u| u <= MAX_SAFE) || n.as_i64().is_some_and(|i| i.unsigned_abs() <= MAX_SAFE)),
            _ => false,
        };
        if !scalar {
            return bad(format!("{k} has a value of the wrong kind"));
        }
        match (ident, repr) {
            (true, Repr::Removed) => return bad(format!("the removed form keeps {k}")),
            (true, Repr::Pseudonymized) if !v.as_str().is_some_and(is_pseudonym) => return bad(format!("{k} is not a pseudonym")),
            _ => {}
        }
    }
    let action = o.get("action").and_then(Value::as_str).unwrap_or_default();
    if !action_ok(action) {
        return bad("it has no action".into());
    }
    if action != "checkpoint" && ["kid", "payload", "sig"].iter().any(|k| o.contains_key(*k)) {
        return bad("only a checkpoint carries kid, payload and sig".into());
    }
    if action != "api.refusal.summary" && o.contains_key("bucket") {
        return bad("only a refusal summary carries a bucket".into());
    }
    if o.get("ts").and_then(Value::as_i64).is_none() {
        return bad("it has no ts".into());
    }
    if o.get("source").and_then(Value::as_str) != Some("relay") || o.get("relay").and_then(Value::as_str) != Some(relay) {
        return bad(format!("it does not name relay {relay}"));
    }
    if repr != Repr::AsIs && o.get("raw_seq").and_then(Value::as_u64) != Some(seq) {
        return bad("its raw_seq is not its seq".into());
    }
    if repr == Repr::Pseudonymized {
        let Some(pkv) = o.get("pkv").and_then(Value::as_u64) else { return bad("it has no pkv".into()) };
        if pkv == 0 && o.keys().any(|k| IDENTITY_FIELDS.contains(&k.as_str())) {
            return bad("pkv 0 keeps an identity field".into());
        }
    }
    Ok(())
}

/// Whether two representations of one seq are the same decision: every field but identities, `prev`, `hash`,
/// `raw_seq` and `pkv` equal; identities in the same places where both keep them (as_is, pseudonymized with a key);
/// and, when the console holds the pseudonym key of that version, each pseudonym the HMAC of the as_is value.
fn same_decision(a: &Map<String, Value>, b: &Map<String, Value>, key: Option<&(u32, Vec<u8>)>) -> bool {
    fn plain(m: &Map<String, Value>) -> BTreeMap<&String, &Value> {
        let skip = |k: &str| IDENTITY_FIELDS.contains(&k) || matches!(k, "prev" | "hash" | "raw_seq" | "pkv");
        m.iter().filter(|(k, _)| !skip(k.as_str())).collect()
    }
    if plain(a) != plain(b) {
        return false;
    }
    let keeps = |m: &Map<String, Value>| m.get("raw_seq").is_none() || m.get("pkv").and_then(Value::as_u64).is_some_and(|p| p > 0);
    let ids = |m: &Map<String, Value>| m.keys().filter(|k| IDENTITY_FIELDS.contains(&k.as_str())).cloned().collect::<std::collections::BTreeSet<String>>();
    if keeps(a) && keeps(b) && ids(a) != ids(b) {
        return false;
    }
    let (raw, derived) = match (a.get("raw_seq").is_none(), b.get("raw_seq").is_none()) {
        (true, false) => (a, b),
        (false, true) => (b, a),
        _ => return true,
    };
    match (key, derived.get("pkv").and_then(Value::as_u64)) {
        (Some((v, k)), Some(p)) if p > 0 && p == u64::from(*v) => {
            ids(raw).iter().all(|f| raw.get(f).and_then(Value::as_str).map(|s| Value::from(pseudonym(k, s))).as_ref() == derived.get(f))
        }
        _ => true,
    }
}

/// A received checkpoint: its payload is canonical JSON of this org, this relay, its ts and the heads before it (each
/// at `seq - 1`, this chain's being its `prev`), and its signature verifies with the certificate stored for its kid
/// (`add_keys`), in date at its ts.
fn check_checkpoint(o: &Map<String, Value>, org: &str, relay: &str, repr: Repr, seq: u64, prev: &str, keys: &[Value]) -> Result<(), String> {
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let (Some(kid), Some(pj), Some(sig)) = (s("kid"), s("payload").and_then(unb64u), s("sig").and_then(unb64u)) else {
        return Err(format!("checkpoint {seq} lacks its kid, payload or sig"));
    };
    let p = std::str::from_utf8(&pj).ok().and_then(parse_json).ok_or_else(|| format!("checkpoint {seq}: its payload does not read"))?;
    if canonical_json(&p).ok().as_deref() != Some(pj.as_slice()) {
        return Err(format!("checkpoint {seq}: its payload is not canonical JSON"));
    }
    let ts = o.get("ts").and_then(Value::as_i64);
    let heads = p.get("heads").and_then(Value::as_object);
    let head_ok = |r: Repr| {
        heads.and_then(|h| h.get(r.as_str())).and_then(Value::as_array).is_some_and(|h| h.len() == 2 && h[0].as_u64() == Some(seq - 1) && h[1].as_str().is_some_and(|x| raw32(x).is_some()))
    };
    let named = p.get("org").and_then(Value::as_str) == Some(org)
        && p.get("source").and_then(Value::as_str) == Some(relay)
        && p.get("ts").and_then(Value::as_i64) == ts
        && p.as_object().is_some_and(|m| m.len() == 4)
        && heads.is_some_and(|h| h.len() == 3)
        && Repr::ALL.iter().all(|r| head_ok(*r))
        && heads.and_then(|h| h.get(repr.as_str())).and_then(|h| h.get(1)).and_then(Value::as_str) == Some(prev);
    if !named {
        return Err(format!("checkpoint {seq} does not name this chain and the heads before it"));
    }
    let cert = keys.iter().filter(|k| k.get("kid").and_then(Value::as_str) == Some(kid)).find_map(crate::api_checkpoint::cert_der_of).ok_or_else(|| format!("checkpoint {seq}: no certificate is stored for {kid}"))?;
    let in_date = crate::meet_x509::Cert::from_der(&cert).zip(ts).is_some_and(|(c, t)| c.not_before <= t && t <= c.not_after);
    if !in_date || !crate::api_checkpoint::verify(&cert, &checkpoint_signed_bytes(&pj), &sig) {
        return Err(format!("checkpoint {seq}: its signature does not verify with the certificate of {kid}"));
    }
    Ok(())
}

fn seg_name(repr: Repr, n: u32) -> String {
    format!("{}-{n:06}.jsonl", repr.as_str())
}

fn head_name(repr: Repr) -> String {
    format!("{}-head.json", repr.as_str())
}

fn seg_number(repr: Repr, name: &str) -> Option<u32> {
    let mid = name.strip_prefix(repr.as_str())?.strip_prefix('-')?.strip_suffix(".jsonl")?;
    (mid.len() == 6 && mid.bytes().all(|b| b.is_ascii_digit())).then(|| mid.parse().ok()).flatten()
}

fn open_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

/// A new file's name is on disk once its folder is flushed (Unix; NTFS journals it).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// The lines of a segment with the byte offset each starts at; a final piece with no newline is a line too.
fn lines_of(bytes: &[u8]) -> Vec<(usize, &[u8])> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            out.push((start, &bytes[start..i]));
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push((start, &bytes[start..]));
    }
    out
}

fn sub_dirs(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

fn read_keys(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join(KEYS_FILE)).ok().and_then(|t| parse_json(&t)).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn real_free(dir: &Path) -> Option<u64> {
    use crate::fleet_metrics::FsOps;
    crate::fleet_metrics::RealFs.free_space(dir).map(|(avail, _)| avail)
}

// ── one chain ──────────────────────────────────────────────────────────────────────────────────────────────────

/// A segment's place in the chain (an empty segment has `first > last`).
struct Seg {
    n: u32,
    first: u64,
    last: u64,
    last_hash: String,
    last_ts: i64,
    size: u64,
}

struct Chain {
    /// None: kept in memory (no state folder).
    dir: Option<PathBuf>,
    repr: Repr,
    org: String,
    label: String,
    segment_bytes: u64,
    segs: Vec<Seg>,
    mem: Vec<String>,
    seq: u64,
    hash: String,
    /// The front retention removed: (through seq, its hash).
    dropped: Option<(u64, String)>,
    /// (raw seq, ts) of the newest checkpoint entry.
    last_checkpoint: Option<(u64, i64)>,
}

impl Chain {
    /// The chain in `dir`, verified; a broken tail is moved aside (`<repr>-torn-<t>.jsonl`), never fatal.
    fn open(dir: Option<&Path>, repr: Repr, org: &str, segment_bytes: u64, t: i64, notes: &mut Vec<String>) -> Chain {
        let mut c = Chain {
            dir: dir.map(Path::to_path_buf),
            repr,
            org: org.to_owned(),
            label: repr.label(org),
            segment_bytes,
            segs: Vec::new(),
            mem: Vec::new(),
            seq: 0,
            hash: ZERO.to_owned(),
            dropped: None,
            last_checkpoint: None,
        };
        let Some(dir) = dir else { return c };
        if let Some(h) = std::fs::read_to_string(dir.join(head_name(repr))).ok().and_then(|s| parse_json(&s)) {
            if let (Some(s), Some(hh)) = (h.pointer("/dropped/seq").and_then(Value::as_u64), h.pointer("/dropped/hash").and_then(Value::as_str)) {
                c.dropped = Some((s, hh.to_owned()));
            }
        }
        let mut nums: Vec<u32> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).filter_map(|e| seg_number(repr, &e.file_name().to_string_lossy())).collect()).unwrap_or_default();
        nums.sort_unstable();
        let (mut seq, mut prev) = c.dropped.clone().unwrap_or((0, ZERO.to_owned()));
        let mut bad: Option<(usize, usize)> = None;
        for (si, n) in nums.iter().enumerate() {
            let bytes = std::fs::read(dir.join(seg_name(repr, *n))).unwrap_or_default();
            let mut seg = Seg { n: *n, first: seq + 1, last: seq, last_hash: prev.clone(), last_ts: 0, size: bytes.len() as u64 };
            let mut cut = None;
            for (off, line) in lines_of(&bytes) {
                let Some(o) = parse_json(&String::from_utf8_lossy(line)).and_then(|v| v.as_object().cloned()) else {
                    cut = Some(off);
                    break;
                };
                // A front dropped with no head to record it: the first entry says where the kept chain starts.
                if seq == 0 && c.dropped.is_none() {
                    let first = o.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    if let (true, Some(p)) = (first > 1, o.get("prev").and_then(Value::as_str)) {
                        notes.push(format!("api audit {org} {}: the chain starts at entry {first} and its head did not record the dropped front", repr.as_str()));
                        c.dropped = Some((first - 1, p.to_owned()));
                        seq = first - 1;
                        prev = p.to_owned();
                        seg.first = first;
                        seg.last = seq;
                    }
                }
                match check_entry(&c.label, org, &o, seq + 1, &prev) {
                    Some(h) => {
                        seq += 1;
                        prev = h;
                        let ts = o.get("ts").and_then(Value::as_i64).unwrap_or(0);
                        let raw = o.get("raw_seq").and_then(Value::as_u64).unwrap_or(seq);
                        seg.last = seq;
                        seg.last_hash = prev.clone();
                        seg.last_ts = ts;
                        if o.get("action").and_then(Value::as_str) == Some("checkpoint") {
                            c.last_checkpoint = Some((raw, ts));
                        }
                    }
                    None => {
                        cut = Some(off);
                        break;
                    }
                }
            }
            if let Some(off) = cut {
                seg.size = off as u64;
                c.segs.push(seg);
                bad = Some((si, off));
                break;
            }
            c.segs.push(seg);
        }
        if let Some((si, off)) = bad {
            // The bad line and everything after it, unchanged, to the torn file; the verified prefix stays.
            let mut torn = Vec::new();
            for (i, n) in nums.iter().enumerate().skip(si) {
                let p = dir.join(seg_name(repr, *n));
                let bytes = std::fs::read(&p).unwrap_or_default();
                if i == si {
                    torn.extend_from_slice(&bytes[off.min(bytes.len())..]);
                    let _ = write_durable(&p, &bytes[..off.min(bytes.len())]);
                } else {
                    torn.extend_from_slice(&bytes);
                    let _ = std::fs::remove_file(&p);
                }
            }
            let file = format!("{}-torn-{t}.jsonl", repr.as_str());
            if let Ok(mut f) = open_append(&dir.join(&file)) {
                let _ = f.write_all(&torn);
                let _ = f.sync_data();
            }
            notes.push(format!("api audit {org} {}: the chain does not verify from entry {}; {} byte(s) moved to {file}", repr.as_str(), seq + 1, torn.len()));
        }
        c.seq = seq;
        c.hash = prev;
        c.write_head();
        c
    }

    fn write_head(&self) {
        let Some(dir) = &self.dir else { return };
        let head = json!({
            "seq": self.seq, "hash": self.hash, "segment": self.segs.last().map_or(0, |s| s.n),
            "dropped": self.dropped.as_ref().map(|(s, h)| json!({"seq": s, "hash": h})),
        });
        let _ = write_private(&dir.join(head_name(self.repr)), format!("{}\n", stringify(&head)).as_bytes());
    }

    /// The next entry of this chain for `fields`: seq, ts, org, the fields, raw_seq (derived chains), prev, hash.
    fn next(&self, ts: i64, fields: &Map<String, Value>, raw: Option<u64>) -> Result<Map<String, Value>, AuditError> {
        let mut e = Map::new();
        e.insert("seq".into(), Value::from(self.seq + 1));
        e.insert("ts".into(), Value::from(ts));
        e.insert("org".into(), Value::from(self.org.as_str()));
        for (k, v) in fields {
            if !matches!(k.as_str(), "seq" | "ts" | "org" | "raw_seq" | "prev" | "hash") {
                e.insert(k.clone(), v.clone());
            }
        }
        if let Some(r) = raw {
            e.insert("raw_seq".into(), Value::from(r));
        }
        e.insert("prev".into(), Value::from(self.hash.as_str()));
        let h = chain_hash(&self.label, &self.hash, &e).ok_or_else(|| AuditError::bad("the audit entry is not canonical JSON"))?;
        e.insert("hash".into(), Value::from(h));
        Ok(e)
    }

    fn advance(&mut self, e: &Map<String, Value>) {
        let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(self.seq + 1);
        let hash = e.get("hash").and_then(Value::as_str).unwrap_or_default().to_owned();
        let ts = e.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let raw = e.get("raw_seq").and_then(Value::as_u64).unwrap_or(seq);
        if let Some(s) = self.segs.last_mut() {
            s.last = seq;
            s.last_hash = hash.clone();
            s.last_ts = ts;
        }
        if e.get("action").and_then(Value::as_str) == Some("checkpoint") {
            self.last_checkpoint = Some((raw, ts));
        }
        self.seq = seq;
        self.hash = hash;
    }

    /// Append entries already chained to the head and flush them to disk (a new segment past 8 MiB). A failed write
    /// is cut back off the file.
    fn append_batch(&mut self, es: &[Map<String, Value>]) -> Result<(), String> {
        let Some(dir) = self.dir.clone() else {
            for e in es {
                self.mem.push(stringify(&Value::Object(e.clone())));
                self.advance(e);
            }
            return Ok(());
        };
        let mut file: Option<(u32, std::fs::File)> = None;
        let mut created = false;
        for e in es {
            let line = format!("{}\n", stringify(&Value::Object(e.clone())));
            let len = line.len() as u64;
            if self.segs.last().is_none_or(|s| s.size > 0 && s.size + len > self.segment_bytes) {
                if let Some((_, f)) = file.take() {
                    f.sync_data().map_err(|e| e.to_string())?;
                }
                let n = self.segs.last().map_or(1, |s| s.n + 1);
                self.segs.push(Seg { n, first: self.seq + 1, last: self.seq, last_hash: self.hash.clone(), last_ts: 0, size: 0 });
                created = true;
            }
            let (n, size) = self.segs.last().map_or((1, 0), |s| (s.n, s.size));
            let path = dir.join(seg_name(self.repr, n));
            if file.as_ref().is_none_or(|(m, _)| *m != n) {
                file = Some((n, open_append(&path).map_err(|e| e.to_string())?));
            }
            if let Some((_, f)) = file.as_mut() {
                if let Err(err) = f.write_all(line.as_bytes()) {
                    if let Ok(w) = std::fs::OpenOptions::new().write(true).open(&path) {
                        let _ = w.set_len(size);
                    }
                    return Err(err.to_string());
                }
            }
            if let Some(s) = self.segs.last_mut() {
                s.size += len;
            }
            self.advance(e);
        }
        if let Some((_, f)) = file {
            f.sync_data().map_err(|e| e.to_string())?;
        }
        if created {
            sync_dir(&dir);
        }
        self.write_head();
        Ok(())
    }

    /// Up to `limit` entries with seq above `after`, oldest first.
    fn read(&self, after: u64, limit: usize) -> Vec<Value> {
        let mut out = Vec::new();
        if limit == 0 {
            return out;
        }
        let Some(dir) = &self.dir else {
            for v in self.mem.iter().filter_map(|l| parse_json(l)) {
                if v.get("seq").and_then(Value::as_u64).unwrap_or(0) > after {
                    out.push(v);
                    if out.len() >= limit {
                        break;
                    }
                }
            }
            return out;
        };
        for s in self.segs.iter().filter(|s| s.first <= s.last && s.last > after) {
            let Ok(bytes) = std::fs::read(dir.join(seg_name(self.repr, s.n))) else { continue };
            let end = (s.size as usize).min(bytes.len());
            for (_, l) in lines_of(&bytes[..end]) {
                if let Some(v) = parse_json(&String::from_utf8_lossy(l)) {
                    if v.get("seq").and_then(Value::as_u64).unwrap_or(0) > after {
                        out.push(v);
                        if out.len() >= limit {
                            return out;
                        }
                    }
                }
            }
        }
        out
    }

    /// Retention: drop whole segments (never the newest) whose last entry is before `before` and, under a hold (the
    /// lowest seq of this chain not acknowledged), entirely below it.
    fn retire(&mut self, before: i64, hold: Option<u64>) {
        let Some(dir) = self.dir.clone() else { return };
        let mut changed = false;
        while self.segs.len() > 1 {
            let s = &self.segs[0];
            let empty = s.first > s.last;
            if !empty && (s.last_ts >= before || hold.is_some_and(|h| s.last >= h)) {
                break;
            }
            if std::fs::remove_file(dir.join(seg_name(self.repr, s.n))).is_err() && dir.join(seg_name(self.repr, s.n)).exists() {
                break;
            }
            if !empty {
                self.dropped = Some((s.last, s.last_hash.clone()));
            }
            self.segs.remove(0);
            changed = true;
        }
        if changed {
            self.write_head();
        }
    }
}

// ── one org and source ─────────────────────────────────────────────────────────────────────────────────────────

/// An open refusal summary bucket.
struct Bucket {
    /// 16 random hex: the summary entry's `bucket`.
    id: String,
    /// `<key>\n<check>\n<route>`.
    key: String,
    minute: i64,
    count: u64,
    /// The first folded refusal's fields (without rid, jti, bytes_out, count).
    entry: Map<String, Value>,
}

struct Set {
    org: String,
    dir: Option<PathBuf>,
    chains: [Chain; 3],
    txn: u64,
    /// `txn.jsonl` may hold a transaction not committed yet.
    pending: bool,
    /// `<minute>\n<bucket key>` -> bucket.
    buckets: BTreeMap<String, Bucket>,
    /// The bytes in `summary.wal`, and the most it may hold (`WAL_BYTES`).
    wal_size: u64,
    wal_budget: u64,
    /// The bucket id of the summary the last committed transaction wrote, when it is the chain's head (open only).
    last_bucket: Option<String>,
    /// `<minute>\n<bucket key>` -> (minute, own entries so far).
    seen: HashMap<String, (i64, u64)>,
    /// The as_is seq and ts of the last checkpoint (0, 0: none yet).
    cp_seq: u64,
    cp_ts: i64,
}

fn unavailable(e: impl std::fmt::Display) -> AuditError {
    AuditError::unavailable(format!("the api audit could not be written: {e}"))
}

impl Set {
    /// One decision as one transaction in all three chains; Ok is its as_is seq. `appends` below 3 stops after that
    /// many chain appends with no commit marker, as a crash would (tests).
    fn commit(&mut self, fields: &Map<String, Value>, key: Option<&(u32, Vec<u8>)>, ts: i64, appends: usize, notes: &mut Vec<String>) -> Result<u64, AuditError> {
        if self.pending {
            self.recover(notes)?;
        }
        let raw = self.chains[0].seq + 1;
        let entries = [
            self.chains[0].next(ts, fields, None)?,
            self.chains[1].next(ts, &derive(fields, Repr::Pseudonymized, key), Some(raw))?,
            self.chains[2].next(ts, &derive(fields, Repr::Removed, key), Some(raw))?,
        ];
        if let Some(dir) = &self.dir {
            let txn = self.txn + 1;
            let rec = json!({
                "txn": txn,
                "entries": entries.iter().cloned().map(Value::Object).collect::<Vec<_>>(),
                "prior": self.chains.iter().map(|c| json!([c.seq, c.hash])).collect::<Vec<_>>(),
            });
            write_durable(&dir.join(TXN_FILE), format!("{}\n", stringify(&rec)).as_bytes()).map_err(unavailable)?;
            self.txn = txn;
            self.pending = true;
        }
        for (c, e) in self.chains.iter_mut().zip(entries.iter()).take(appends) {
            c.append_batch(std::slice::from_ref(e)).map_err(unavailable)?;
        }
        if appends < 3 {
            return Ok(raw);
        }
        self.mark_committed().map_err(unavailable)?;
        Ok(raw)
    }

    fn mark_committed(&mut self) -> Result<(), String> {
        if let Some(dir) = &self.dir {
            let mut f = open_append(&dir.join(TXN_FILE)).map_err(|e| e.to_string())?;
            f.write_all(format!("{}\n", stringify(&json!({"commit": self.txn}))).as_bytes()).map_err(|e| e.to_string())?;
            f.sync_data().map_err(|e| e.to_string())?;
        }
        self.pending = false;
        Ok(())
    }

    /// Complete the transaction in `txn.jsonl` when it has no commit marker: each entry is appended only where its
    /// chain still ends at the recorded prior head.
    fn recover(&mut self, notes: &mut Vec<String>) -> Result<(), AuditError> {
        let Some(dir) = self.dir.clone() else {
            self.pending = false;
            return Ok(());
        };
        let text = std::fs::read_to_string(dir.join(TXN_FILE)).unwrap_or_default();
        let mut lines = text.lines();
        // a record that does not read was torn before any chain append
        let Some(rec) = lines.next().and_then(parse_json) else {
            self.pending = false;
            return Ok(());
        };
        let id = rec.get("txn").and_then(Value::as_u64).unwrap_or(0);
        self.txn = self.txn.max(id);
        let entries: Vec<Map<String, Value>> = rec.get("entries").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| e.as_object().cloned()).collect()).unwrap_or_default();
        let committed = lines.any(|l| parse_json(l).and_then(|v| v.get("commit").and_then(Value::as_u64)) == Some(id));
        let out = if committed {
            self.pending = false;
            Ok(())
        } else {
            self.complete(id, &rec, &entries, notes)
        };
        // a summary whose transaction is the chain's head is written, whatever its bucket's retire line says
        let head = entries.first().filter(|e| e.get("hash").and_then(Value::as_str) == Some(self.chains[0].hash.as_str()));
        self.last_bucket = head.and_then(|e| e.get("bucket")).and_then(Value::as_str).map(str::to_owned);
        out
    }

    /// The appends of an uncommitted transaction that are missing, then its commit marker.
    fn complete(&mut self, id: u64, rec: &Value, entries: &[Map<String, Value>], notes: &mut Vec<String>) -> Result<(), AuditError> {
        let prior: Vec<(u64, String)> = rec.get("prior").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| Some((p.get(0)?.as_u64()?, p.get(1)?.as_str()?.to_owned()))).collect()).unwrap_or_default();
        if entries.len() != 3 || prior.len() != 3 {
            notes.push(format!("api audit {}: transaction {id} does not read; nothing was completed", self.org));
            return self.mark_committed().map_err(unavailable);
        }
        let mut completed = 0;
        for (i, (e, (ps, ph))) in entries.iter().zip(prior.iter()).enumerate() {
            let c = &mut self.chains[i];
            let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
            let hash = e.get("hash").and_then(Value::as_str).unwrap_or_default();
            if c.seq == seq && c.hash == hash {
                continue;
            }
            if c.seq == *ps && c.hash == *ph && check_entry(&c.label, &c.org, e, ps + 1, ph).is_some() {
                c.append_batch(std::slice::from_ref(e)).map_err(unavailable)?;
                completed += 1;
            } else {
                notes.push(format!("api audit {} {}: transaction {id} does not continue the chain and was left out", self.org, c.repr.as_str()));
            }
        }
        if completed > 0 {
            notes.push(format!("api audit {}: transaction {id} completed after a crash ({completed} append(s))", self.org));
        }
        self.mark_committed().map_err(unavailable)
    }

    /// One line appended to `summary.wal` and flushed, inside the byte budget: compacted first when the line would
    /// pass it, refused (nothing appended) when it still would. A failed write is cut back off the file.
    fn wal_append(&mut self, line: &Value) -> Result<(), AuditError> {
        let Some(dir) = self.dir.clone() else { return Ok(()) };
        let text = format!("{}\n", stringify(line));
        let len = text.len() as u64;
        if self.wal_size + len > self.wal_budget {
            self.wal_rewrite().map_err(wal_failed)?;
            if self.wal_size + len > self.wal_budget {
                return Err(AuditError::unavailable("the refusal summary log is full"));
            }
        }
        let path = dir.join(WAL_FILE);
        let r = (|| -> std::io::Result<()> {
            let mut f = open_append(&path)?;
            f.write_all(text.as_bytes())?;
            f.sync_data()
        })();
        if let Err(e) = r {
            if let Ok(w) = std::fs::OpenOptions::new().write(true).open(&path) {
                let _ = w.set_len(self.wal_size);
            }
            return Err(wal_failed(e));
        }
        self.wal_size += len;
        Ok(())
    }

    /// The buckets of `summary.wal`: open lines `{o: id, k, m, n, e}`, count lines `{i: id, n: total}` and retire
    /// lines `{x: id}`, in order. A torn last line was never acknowledged and is ignored.
    fn wal_load(&mut self, notes: &mut Vec<String>) {
        let Some(path) = self.dir.as_ref().map(|d| d.join(WAL_FILE)) else { return };
        let bytes = std::fs::read(path).unwrap_or_default();
        self.wal_size = bytes.len() as u64;
        let mut ids: HashMap<String, String> = HashMap::new();
        for v in String::from_utf8_lossy(&bytes).lines().filter_map(parse_json) {
            let n = v.get("n").and_then(Value::as_u64);
            if let Some(id) = v.get("o").and_then(Value::as_str) {
                let (Some(k), Some(m), Some(n), Some(e)) = (v.get("k").and_then(Value::as_str), v.get("m").and_then(Value::as_i64), n, v.get("e").and_then(Value::as_object)) else {
                    notes.push(format!("api audit {}: a refusal summary bucket that does not read was left out", self.org));
                    continue;
                };
                let mkey = format!("{m}\n{k}");
                ids.insert(id.to_owned(), mkey.clone());
                self.buckets.insert(mkey, Bucket { id: id.to_owned(), key: k.to_owned(), minute: m, count: n, entry: e.clone() });
            } else if let (Some(id), Some(n)) = (v.get("i").and_then(Value::as_str), n) {
                if let Some(b) = ids.get(id).and_then(|mk| self.buckets.get_mut(mk)) {
                    b.count = b.count.max(n);
                }
            } else if let Some(id) = v.get("x").and_then(Value::as_str) {
                if let Some(mk) = ids.remove(id) {
                    self.buckets.remove(&mk);
                }
            }
        }
    }

    /// `summary.wal` rewritten with one open line per open bucket (its count so far).
    fn wal_rewrite(&mut self) -> Result<(), String> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let mut text = String::new();
        for b in self.buckets.values() {
            text.push_str(&stringify(&json!({"o": b.id, "k": b.key, "m": b.minute, "n": b.count, "e": Value::Object(b.entry.clone())})));
            text.push('\n');
        }
        write_durable(&dir.join(WAL_FILE), text.as_bytes())?;
        self.wal_size = text.len() as u64;
        Ok(())
    }

    /// The buckets of minutes before `before` (all with None) as `api.refusal.summary` entries carrying their bucket
    /// id; each is retired from the WAL only after its transaction commits. Ok is how many were written.
    fn flush(&mut self, before: Option<i64>, key: Option<&(u32, Vec<u8>)>, ts: i64, notes: &mut Vec<String>) -> Result<usize, AuditError> {
        let due: Vec<String> = self.buckets.iter().filter(|(_, b)| before.is_none_or(|m| b.minute < m)).map(|(k, _)| k.clone()).collect();
        let mut done = 0;
        for k in due {
            let Some(b) = self.buckets.get(&k) else { continue };
            let id = b.id.clone();
            let mut f = b.entry.clone();
            f.insert("action".into(), Value::from("api.refusal.summary"));
            f.insert("count".into(), Value::from(b.count));
            f.insert("bucket".into(), Value::from(id.as_str()));
            self.commit(&f, key, ts, 3, notes)?;
            self.buckets.remove(&k);
            done += 1;
            // the retire line, or a compaction without the bucket when it cannot be appended
            if self.wal_append(&json!({"x": id})).is_err() {
                self.wal_rewrite().map_err(wal_failed)?;
            }
        }
        Ok(done)
    }
}

fn wal_failed(e: impl std::fmt::Display) -> AuditError {
    AuditError::unavailable(format!("the refusal summary log could not be written: {e}"))
}

// ── the audit ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The API audit of one console or relay (`source`): its own chains per org, and on the console the relay chains
/// it receives.
pub struct ApiAudit {
    root: Option<PathBuf>,
    source: String,
    signer: Arc<dyn CheckpointSigner>,
    pseudonym: Arc<dyn PseudonymKeys>,
    segment_bytes: u64,
    sets: Mutex<BTreeMap<(String, String), Arc<Mutex<Set>>>>,
    hold: RwLock<Option<RetentionHold>>,
    free: RwLock<FreeSpace>,
    free_seen: Mutex<Option<(Instant, bool)>>,
    pkeys: Mutex<HashMap<String, (Instant, Option<(u32, Vec<u8>)>)>>,
    notes: Mutex<Vec<String>>,
    /// `WAL_BYTES` (tests shrink it before an org's chains open).
    wal_budget: std::sync::atomic::AtomicU64,
}

impl ApiAudit {
    /// The audit under `<state_dir>/api-audit` (in memory without a state folder). Every org's chains of this
    /// source are verified, uncommitted transactions completed and recovered summary buckets flushed before this
    /// returns; on the console the relay chains received are opened too. `now` is unix seconds.
    pub fn open(state_dir: Option<&Path>, source: &str, signer: Arc<dyn CheckpointSigner>, pseudonym: Arc<dyn PseudonymKeys>, now: i64) -> ApiAudit {
        ApiAudit::open_with(state_dir, source, signer, pseudonym, now, SEGMENT_BYTES)
    }

    fn open_with(state_dir: Option<&Path>, source: &str, signer: Arc<dyn CheckpointSigner>, pseudonym: Arc<dyn PseudonymKeys>, now: i64, segment_bytes: u64) -> ApiAudit {
        let root = state_dir.map(|d| d.join(AUDIT_DIR));
        if let Some(r) = &root {
            let _ = make_dir(r);
        }
        let free: FreeSpace = Arc::new(real_free);
        let a = ApiAudit {
            root,
            source: source.to_owned(),
            signer,
            pseudonym,
            segment_bytes,
            sets: Mutex::new(BTreeMap::new()),
            hold: RwLock::new(None),
            free: RwLock::new(free),
            free_seen: Mutex::new(None),
            pkeys: Mutex::new(HashMap::new()),
            notes: Mutex::new(Vec::new()),
            wal_budget: std::sync::atomic::AtomicU64::new(WAL_BYTES),
        };
        if let Some(r) = a.root.clone() {
            for org in sub_dirs(&r).into_iter().filter(|o| org_ok(o)) {
                for s in sub_dirs(&r.join(&org)).into_iter().filter(|s| source_ok(s)) {
                    let _ = a.set(&org, &s, false, now);
                }
            }
        }
        a
    }

    /// Notes for the security log (torn tails moved aside, transactions completed, summaries recovered), taken once.
    pub fn take_notes(&self) -> Vec<String> {
        std::mem::take(&mut *self.notes.lock())
    }

    /// Slice 1a4's export hook: segments holding entries at or above a chain's hold are kept, on this source's chains
    /// and on the relay chains received. Its caller (the export queues) arrives with slice 1a4.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_retention_hold(&self, hold: RetentionHold) {
        *self.hold.write() = Some(hold);
    }

    /// A smaller `summary.wal` budget for the org chains opened after this (tests).
    #[cfg(test)]
    fn set_wal_budget(&self, bytes: u64) {
        self.wal_budget.store(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    /// The free-space reading (tests stand in a full volume).
    #[cfg(test)]
    pub fn set_free_space(&self, free: FreeSpace) {
        *self.free.write() = free;
        *self.free_seen.lock() = None;
    }

    /// 9.4: false while the audit volume is below its 64 MiB reserve (allowed calls answer 503 audit-unavailable).
    pub fn allowed_ok(&self) -> bool {
        let Some(root) = &self.root else { return true };
        let mut seen = self.free_seen.lock();
        if let Some((at, ok)) = *seen {
            if at.elapsed() < FREE_TTL {
                return ok;
            }
        }
        let free = self.free.read().clone();
        let ok = free(root.as_path()).is_none_or(|b| b >= RESERVE_BYTES);
        *seen = Some((Instant::now(), ok));
        ok
    }

    /// The orgs this source has chains for.
    pub fn orgs(&self) -> Vec<String> {
        self.sets.lock().keys().filter(|(_, s)| *s == self.source).map(|(o, _)| o.clone()).collect()
    }

    fn pseudonym_key(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        let mut cache = self.pkeys.lock();
        if let Some((at, k)) = cache.get(org) {
            if at.elapsed() < PKEY_TTL {
                return k.clone();
            }
        }
        let k = self.pseudonym.current(org);
        cache.insert(org.to_owned(), (Instant::now(), k.clone()));
        k
    }

    /// The org's chains of `source`, opened on first use; None when they do not exist and `create` is false.
    fn set(&self, org: &str, source: &str, create: bool, now: i64) -> Result<Option<Arc<Mutex<Set>>>, AuditError> {
        if !org_ok(org) {
            return Err(AuditError::bad("that is not an organization id"));
        }
        if !source_ok(source) {
            return Err(AuditError::bad("that is not an audit source"));
        }
        let mut sets = self.sets.lock();
        let k = (org.to_owned(), source.to_owned());
        if let Some(s) = sets.get(&k) {
            return Ok(Some(s.clone()));
        }
        let exists = self.root.as_ref().is_some_and(|r| r.join(org).join(source).is_dir());
        if !create && !exists {
            return Ok(None);
        }
        let s = Arc::new(Mutex::new(self.load_set(org, source, now)));
        sets.insert(k, s.clone());
        Ok(Some(s))
    }

    fn load_set(&self, org: &str, source: &str, now: i64) -> Set {
        let own = source == self.source;
        let dir = self.root.as_ref().map(|r| r.join(org).join(source));
        if let Some(d) = &dir {
            let _ = make_dir(d);
        }
        let mut notes = Vec::new();
        let chains = Repr::ALL.map(|r| Chain::open(dir.as_deref(), r, org, self.segment_bytes, now, &mut notes));
        let (cp_seq, cp_ts) = chains[0].last_checkpoint.unwrap_or((0, 0));
        let mut s = Set {
            org: org.to_owned(),
            dir,
            chains,
            txn: 0,
            pending: own,
            buckets: BTreeMap::new(),
            wal_size: 0,
            wal_budget: self.wal_budget.load(std::sync::atomic::Ordering::Relaxed),
            last_bucket: None,
            seen: HashMap::new(),
            cp_seq,
            cp_ts,
        };
        if own {
            if let Err(e) = s.recover(&mut notes) {
                notes.push(format!("api audit {org}: {}", e.message));
            }
            s.wal_load(&mut notes);
            // a crash after a summary's commit and before its retire line: the summary is already in the chain
            if let Some(id) = s.last_bucket.take() {
                let written: Vec<String> = s.buckets.iter().filter(|(_, b)| b.id == id).map(|(k, _)| k.clone()).collect();
                for k in written {
                    s.buckets.remove(&k);
                    notes.push(format!("api audit {org}: refusal summary bucket {id} was already written"));
                }
            }
            if !s.buckets.is_empty() {
                let key = self.pseudonym_key(org);
                match s.flush(None, key.as_ref(), now, &mut notes) {
                    Ok(n) => notes.push(format!("api audit {org}: {n} refusal summary bucket(s) recovered and written")),
                    Err(e) => notes.push(format!("api audit {org}: recovered refusal summaries not written: {}", e.message)),
                }
            }
            // a compact log (also ends a torn last line, so the next line starts clean)
            if s.dir.as_ref().is_some_and(|d| d.join(WAL_FILE).exists()) {
                if let Err(e) = s.wal_rewrite() {
                    notes.push(format!("api audit {org}: the refusal summary log could not be compacted: {e}"));
                }
            }
        }
        self.notes.lock().extend(notes);
        s
    }

    /// A caller's entry checked, with `source` (and `relay` on a relay) set first.
    fn fields(&self, entry: Value) -> Result<Map<String, Value>, AuditError> {
        let m = validate(entry)?;
        let (src, relay) = if self.source == "console" { ("console", None) } else { ("relay", Some(self.source.as_str())) };
        if m.get("source").is_some_and(|v| v.as_str() != Some(src)) {
            return Err(AuditError::bad(format!("source is {src} in this audit")));
        }
        if let Some(r) = relay {
            if m.get("relay").is_some_and(|v| v.as_str() != Some(r)) {
                return Err(AuditError::bad(format!("relay is {r} in this audit")));
            }
        }
        let mut out = Map::new();
        out.insert("source".into(), Value::from(src));
        if let Some(r) = relay {
            out.insert("relay".into(), Value::from(r));
        }
        for (k, v) in m {
            if k != "source" && !(relay.is_some() && k == "relay") {
                out.insert(k, v);
            }
        }
        Ok(out)
    }

    /// 9.4: one decision (the 9.2 fields except seq, ts, org, prev, hash), durable in all three chains before Ok
    /// (its as_is seq). Below the free-space reserve only refusals are taken.
    pub fn record(&self, org: &str, entry: Value, now: i64) -> Result<u64, AuditError> {
        let fields = self.fields(entry)?;
        let refusal = fields.get("action").and_then(Value::as_str) == Some("api.refusal");
        if !refusal && !self.allowed_ok() {
            return Err(AuditError::unavailable("the audit volume is below its reserved free space"));
        }
        self.append(org, &fields, now, 3)
    }

    fn append(&self, org: &str, fields: &Map<String, Value>, now: i64, appends: usize) -> Result<u64, AuditError> {
        let set = self.set(org, &self.source, true, now)?.ok_or_else(|| AuditError::unavailable("the org's audit is not open"))?;
        let key = self.pseudonym_key(org);
        let mut notes = Vec::new();
        let mut s = set.lock();
        let out = s.commit(fields, key.as_ref(), now, appends, &mut notes);
        if out.is_ok() && appends >= 3 && s.chains[0].seq.saturating_sub(s.cp_seq) >= CHECKPOINT_ENTRIES {
            if let Err(e) = self.checkpoint(&mut s, key.as_ref(), now, &mut notes) {
                notes.push(format!("api audit {org}: checkpoint not written: {}", e.message));
            }
        }
        drop(s);
        self.notes.lock().extend(notes);
        out
    }

    /// 9.4: a refusal. `key` is the client id or `ip:<addr>` (unauthenticated: folded from the first). The first 10
    /// per key, check, route and minute are recorded; the rest are counted in the summary WAL (flushed before Ok)
    /// and written as one summary at the minute's end.
    pub fn refusal(&self, org: &str, key: &str, check: &str, route: &str, entry: Value, now: i64) -> Result<(), AuditError> {
        let mut fields = self.fields(entry)?;
        if fields.get("action").and_then(Value::as_str) != Some("api.refusal") {
            return Err(AuditError::bad("a refusal's action is api.refusal"));
        }
        if key.is_empty() || check.is_empty() {
            return Err(AuditError::bad("a refusal needs its key and check"));
        }
        let minute = now.div_euclid(60);
        let bkey = format!("{key}\n{check}\n{route}");
        let mkey = format!("{minute}\n{bkey}");
        let set = self.set(org, &self.source, true, now)?.ok_or_else(|| AuditError::unavailable("the org's audit is not open"))?;
        let mut s = set.lock();
        if !key.starts_with("ip:") && !s.buckets.contains_key(&mkey) {
            let n = s.seen.get(&mkey).map_or(0, |(_, n)| *n);
            if n < OWN_REFUSALS && (n > 0 || s.seen.len() < SEEN_MAX) {
                s.seen.insert(mkey, (minute, n + 1));
                drop(s);
                return self.append(org, &fields, now, 3).map(|_| ());
            }
        }
        // the new total is on disk before the refusal is answered
        if let Some((id, n)) = s.buckets.get(&mkey).map(|b| (b.id.clone(), b.count + 1)) {
            s.wal_append(&json!({"i": id, "n": n}))?;
            if let Some(b) = s.buckets.get_mut(&mkey) {
                b.count = n;
            }
            return Ok(());
        }
        if s.buckets.len() >= WAL_BUCKETS {
            return Err(AuditError::unavailable("the refusal summary log is full"));
        }
        for k in ["rid", "jti", "bytes_out", "count"] {
            fields.remove(k);
        }
        let id = hex(&crate::console_auth::random(8).ok_or_else(|| AuditError::unavailable("no random bytes for a refusal summary"))?);
        let line = json!({"o": id, "k": bkey, "m": minute, "n": 1, "e": Value::Object(fields.clone())});
        if stringify(&line).len() + 1 > WAL_LINE_MAX {
            return Err(AuditError::unavailable("the refusal is too large to summarize"));
        }
        s.wal_append(&line)?;
        s.buckets.insert(mkey, Bucket { id, key: bkey, minute, count: 1, entry: fields });
        Ok(())
    }

    /// Close ended minute buckets, write due checkpoints (1000 entries or 5 minutes since the last), apply retention.
    pub fn tick(&self, now: i64) {
        let all: Vec<((String, String), Arc<Mutex<Set>>)> = self.sets.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let hold = self.hold.read().clone();
        let minute = now.div_euclid(60);
        let mut notes = Vec::new();
        for ((org, source), set) in all {
            let own = source == self.source;
            // the hook runs before the org's lock is taken
            let holds = Repr::ALL.map(|r| hold.as_ref().and_then(|f| f(org.as_str(), source.as_str(), r)));
            let key = if own { self.pseudonym_key(&org) } else { None };
            let mut s = set.lock();
            if own {
                if let Err(e) = s.flush(Some(minute), key.as_ref(), now, &mut notes) {
                    notes.push(format!("api audit {org}: refusal summaries not written: {}", e.message));
                }
                s.seen.retain(|_, (m, _)| *m >= minute);
                let since = s.chains[0].seq.saturating_sub(s.cp_seq);
                if since > 0 && (since >= CHECKPOINT_ENTRIES || now - s.cp_ts >= CHECKPOINT_SECS) {
                    if let Err(e) = self.checkpoint(&mut s, key.as_ref(), now, &mut notes) {
                        notes.push(format!("api audit {org}: checkpoint not written: {}", e.message));
                    }
                }
            }
            for (c, h) in s.chains.iter_mut().zip(holds) {
                c.retire(now - RETENTION_SECS, h);
            }
        }
        self.notes.lock().extend(notes);
    }

    /// A checkpoint over the heads before it, in all three chains. Ok(false) while the signer has no certified key.
    fn checkpoint(&self, s: &mut Set, key: Option<&(u32, Vec<u8>)>, now: i64, notes: &mut Vec<String>) -> Result<bool, AuditError> {
        let head = |r: Repr| json!([s.chains[r.index()].seq, s.chains[r.index()].hash]);
        let payload = json!({
            "org": s.org, "source": self.source, "ts": now,
            "heads": {"as_is": head(Repr::AsIs), "pseudonymized": head(Repr::Pseudonymized), "removed": head(Repr::Removed)},
        });
        let pj = canonical_json(&payload).map_err(AuditError::unavailable)?;
        let Some(kid) = self.signer.kid(&s.org) else { return Ok(false) };
        let Some(sig) = self.signer.sign(&s.org, &checkpoint_signed_bytes(&pj)) else { return Ok(false) };
        let mut f = Map::new();
        if self.source == "console" {
            f.insert("source".into(), Value::from("console"));
        } else {
            f.insert("source".into(), Value::from("relay"));
            f.insert("relay".into(), Value::from(self.source.as_str()));
        }
        f.insert("action".into(), Value::from("checkpoint"));
        f.insert("kid".into(), Value::from(kid));
        f.insert("payload".into(), Value::from(b64u(&pj)));
        f.insert("sig".into(), Value::from(b64u(&sig)));
        s.commit(&f, key, now, 3, notes)?;
        s.cp_seq = s.chains[0].seq;
        s.cp_ts = now;
        Ok(true)
    }

    /// 9.3 `GET .../v1/audit`: up to `limit` (1 to 1000) entries after `after` of the org's `source` chains in one
    /// representation, with that chain's head and the cursor of the last entry given.
    pub fn read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Result<Value, AuditError> {
        let limit = limit.clamp(1, LIMIT_MAX);
        let set = self.set(org, source, false, now_s())?;
        let (entries, (head_seq, head_hash)) = match &set {
            Some(s) => {
                let s = s.lock();
                let c = &s.chains[repr.index()];
                (c.read(after, limit), (c.seq, c.hash.clone()))
            }
            None => (Vec::new(), (0, ZERO.to_owned())),
        };
        let last = entries.last().and_then(|e| e.get("seq")).and_then(Value::as_u64).unwrap_or(after);
        Ok(json!({
            "entries": entries,
            "next": cursor(org, source, repr, last),
            "repr": repr.as_str(),
            "chain": {"source": source, "head_seq": head_seq, "head_hash": head_hash},
        }))
    }

    /// 9.3 `audit/keys`: this source's checkpoint certificates (current and retired) and, on the console, those
    /// stored for the relay chains received.
    pub fn keys(&self, org: &str) -> Vec<Value> {
        if !org_ok(org) {
            return Vec::new();
        }
        let mut out: Vec<Value> = self
            .signer
            .certs(org)
            .into_iter()
            .map(|mut c| {
                if let Some(o) = c.as_object_mut() {
                    o.entry("source").or_insert_with(|| Value::from(self.source.as_str()));
                }
                c
            })
            .collect();
        if let Some(root) = &self.root {
            for d in sub_dirs(&root.join(org)).into_iter().filter(|d| source_ok(d) && *d != self.source) {
                out.extend(read_keys(&root.join(org).join(&d)));
            }
        }
        out
    }

    /// On the console: a relay's checkpoint certificate for the org (after the console issued it); that relay's
    /// previous one becomes retired, retired ones go after the retention.
    pub fn add_keys(&self, org: &str, relay: &str, cert_der: &[u8], chain: &[Vec<u8>]) -> Result<(), AuditError> {
        if !org_ok(org) || !source_ok(relay) || relay == self.source {
            return Err(AuditError::bad("that is not an org and relay"));
        }
        let Some(root) = &self.root else { return Ok(()) };
        let v = crate::api_checkpoint::cert_value(Some(relay), cert_der, chain, None).ok_or_else(|| AuditError::bad("the certificate does not read"))?;
        let now = now_s();
        let dir = root.join(org).join(relay);
        make_dir(&dir).map_err(unavailable)?;
        let mut list = read_keys(&dir);
        if list.iter().any(|k| k.get("kid") == v.get("kid")) {
            return Ok(());
        }
        for k in list.iter_mut().filter(|k| k["status"] == "current") {
            k["status"] = json!("retired");
            k["retired_at"] = json!(now);
        }
        list.retain(|k| k.get("retired_at").and_then(Value::as_i64).is_none_or(|at| at >= now - RETENTION_SECS));
        list.push(v);
        write_durable(&dir.join(KEYS_FILE), stringify(&Value::Array(list)).as_bytes()).map_err(unavailable)
    }

    /// This source's own entries after `after` in one representation, for shipping (as stored).
    pub fn since(&self, org: &str, repr: Repr, after: u64, limit: usize) -> Vec<Value> {
        match self.set(org, &self.source, false, now_s()) {
            Ok(Some(s)) => s.lock().chains[repr.index()].read(after, limit),
            _ => Vec::new(),
        }
    }

    /// The head (seq, hash) of the org's `source` chain in one representation; (0, 64 zeros) when there is none.
    pub fn head(&self, org: &str, source: &str, repr: Repr) -> (u64, String) {
        match self.set(org, source, false, now_s()) {
            Ok(Some(s)) => {
                let s = s.lock();
                let c = &s.chains[repr.index()];
                (c.seq, c.hash.clone())
            }
            _ => (0, ZERO.to_owned()),
        }
    }

    /// On the console (`api-audit`, 2.6): a page `first..=last` of a relay's chain for the org in one
    /// representation, stored durably once every link verifies. A page starting past the stored head + 1 is a gap;
    /// entries already stored must be the same ones.
    pub fn ingest(&self, org: &str, source: &str, repr: Repr, first: u64, last: u64, entries: &[Value]) -> Result<(), IngestError> {
        if source == self.source || source == "console" {
            return Err(IngestError::Invalid("a relay chain is stored under its relay id".into()));
        }
        if first == 0 || last < first || entries.len() as u64 != last - first + 1 {
            return Err(IngestError::Invalid("first, last and the entries disagree".into()));
        }
        let set = match self.set(org, source, true, now_s()) {
            Ok(Some(s)) => s,
            Ok(None) => return Err(IngestError::Unavailable("the chain could not be opened".into())),
            Err(e) => return Err(IngestError::Invalid(e.message)),
        };
        let key = self.pseudonym_key(org);
        let keys = self.root.as_ref().map(|r| read_keys(&r.join(org).join(source))).unwrap_or_default();
        let mut s = set.lock();
        let ri = repr.index();
        let head = s.chains[ri].seq;
        if first > head + 1 {
            return Err(IngestError::Gap(head + 1));
        }
        let skip = if head >= first { (head.min(last) - first + 1) as usize } else { 0 };
        if skip > 0 {
            let stored = s.chains[ri].read(first - 1, skip);
            if stored.len() != skip || stored.iter().zip(entries).any(|(a, b)| a.get("hash").is_none() || a.get("hash") != b.get("hash") || a.get("seq") != b.get("seq")) {
                return Err(IngestError::Invalid(format!("the page differs from the stored chain before entry {}", head + 1)));
            }
        }
        let mut prev = s.chains[ri].hash.clone();
        let mut fresh: Vec<Map<String, Value>> = Vec::new();
        for (i, e) in entries.iter().enumerate().skip(skip) {
            let seq = first + i as u64;
            let o = e.as_object().ok_or_else(|| IngestError::Invalid(format!("entry {seq} is not an object")))?;
            check_received(o, repr, source, seq).map_err(IngestError::Invalid)?;
            let hash = check_entry(&s.chains[ri].label, org, o, seq, &prev).ok_or_else(|| IngestError::Invalid(format!("entry {seq} does not verify")))?;
            if o.get("action").and_then(Value::as_str) == Some("checkpoint") {
                check_checkpoint(o, org, source, repr, seq, &prev, &keys).map_err(IngestError::Invalid)?;
            }
            prev = hash;
            fresh.push(o.clone());
        }
        // the same decisions as the entries of these seqs already stored in the other representations
        if let Some(lo) = fresh.first().and_then(|e| e.get("seq")).and_then(Value::as_u64) {
            for other in Repr::ALL.into_iter().filter(|r| *r != repr) {
                for st in s.chains[other.index()].read(lo - 1, fresh.len()) {
                    let Some(so) = st.as_object() else { continue };
                    let sq = so.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    let Some(mine) = sq.checked_sub(lo).and_then(|i| fresh.get(i as usize)) else { continue };
                    if !same_decision(mine, so, key.as_ref()) {
                        return Err(IngestError::Invalid(format!("entry {sq} is not the decision its {} form records", other.as_str())));
                    }
                }
            }
        }
        s.chains[ri].append_batch(&fresh).map_err(IngestError::Unavailable)
    }

    /// A decision stopped after `appends` chain appends with no commit marker, as a crash would leave it.
    #[cfg(test)]
    fn record_torn(&self, org: &str, entry: Value, now: i64, appends: usize) -> Result<u64, AuditError> {
        let fields = self.fields(entry)?;
        self.append(org, &fields, now, appends)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_ca::tests_dir;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING};

    const NOW: i64 = 1_795_000_020;
    const KEY: [u8; 32] = [7u8; 32];

    /// A checkpoint signer with one fresh key per org.
    #[derive(Default)]
    struct TestSigner {
        keys: Mutex<HashMap<String, Arc<EcdsaKeyPair>>>,
    }

    impl TestSigner {
        fn pair(&self, org: &str) -> Arc<EcdsaKeyPair> {
            self.keys.lock().entry(org.to_owned()).or_insert_with(|| Arc::new(EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap())).clone()
        }
        fn public(&self, org: &str) -> Vec<u8> {
            self.pair(org).public_key().as_ref().to_vec()
        }
    }

    impl CheckpointSigner for TestSigner {
        fn kid(&self, org: &str) -> Option<String> {
            Some(format!("k-{org}"))
        }
        fn sign(&self, org: &str, payload: &[u8]) -> Option<Vec<u8>> {
            self.pair(org).sign(&SystemRandom::new(), payload).ok().map(|s| s.as_ref().to_vec())
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct NoSigner;

    impl CheckpointSigner for NoSigner {
        fn kid(&self, _: &str) -> Option<String> {
            None
        }
        fn sign(&self, _: &str, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct FixedKey(Option<(u32, Vec<u8>)>);

    impl PseudonymKeys for FixedKey {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            self.0.clone()
        }
    }

    fn open_in(dir: Option<&Path>, source: &str, signer: Arc<dyn CheckpointSigner>, key: Option<(u32, Vec<u8>)>) -> ApiAudit {
        ApiAudit::open(dir, source, signer, Arc::new(FixedKey(key)), NOW)
    }

    fn console(dir: &Path) -> ApiAudit {
        open_in(Some(dir), "console", Arc::new(TestSigner::default()), Some((1, KEY.to_vec())))
    }

    fn call(client: &str) -> Value {
        json!({"rid": "AAAAAAAAAAAAAAAAAAAAAA", "action": "api.call", "client": client, "scope": "audit.read", "route": "GET /api/orgs/acme/v1/audit",
               "resource": "r_01", "result": "ok", "check": "none", "jti": "j1", "ip": "203.0.113.7", "bytes_out": 5123, "count": 1})
    }

    fn refused(ip: &str) -> Value {
        json!({"rid": "BBBBBBBBBBBBBBBBBBBBBB", "action": "api.refusal", "ip": ip, "route": "POST /api/orgs/acme/oauth/token", "result": "refused", "check": "abuse"})
    }

    fn entries(a: &ApiAudit, org: &str, source: &str, repr: Repr) -> Vec<Value> {
        a.read(org, source, repr, 0, LIMIT_MAX).unwrap()["entries"].as_array().unwrap().clone()
    }

    /// Recompute a chain from 64 zeros (or the given start) and return its head.
    fn verify(org: &str, repr: Repr, es: &[Value], start: (u64, String)) -> (u64, String) {
        let (mut seq, mut prev) = start;
        for e in es {
            prev = check_entry(&repr.label(org), org, e.as_object().unwrap(), seq + 1, &prev).expect("the entry verifies");
            seq += 1;
        }
        (seq, prev)
    }

    fn heads(a: &ApiAudit, org: &str) -> Vec<u64> {
        Repr::ALL.iter().map(|r| a.head(org, "console", *r).0).collect()
    }

    #[test]
    fn three_chains_link_verify_and_page() {
        let dir = tests_dir("api-audit-chains");
        let a = console(&dir);
        for i in 0..3 {
            assert_eq!(a.record("acme", call(&format!("c_{i}")), NOW + i).unwrap(), i as u64 + 1);
        }
        for r in Repr::ALL {
            let es = entries(&a, "acme", "console", r);
            assert_eq!(es.len(), 3);
            assert_eq!(verify("acme", r, &es, (0, ZERO.to_owned())), a.head("acme", "console", r));
            for (i, e) in es.iter().enumerate() {
                assert_eq!(e["org"], "acme");
                assert_eq!(e["source"], "console");
                if r != Repr::AsIs {
                    assert_eq!(e["raw_seq"].as_u64(), Some(i as u64 + 1));
                }
            }
        }
        assert!(dir.join("api-audit/acme/console/as_is-000001.jsonl").is_file());
        assert!(dir.join("api-audit/acme/console/as_is-head.json").is_file());
        // pages of 2 with the opaque cursor
        let page = a.read("acme", "console", Repr::AsIs, 0, 2).unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 2);
        let after = parse_cursor(page["next"].as_str().unwrap(), "acme", "console", Repr::AsIs).unwrap();
        let rest = a.read("acme", "console", Repr::AsIs, after, 2).unwrap();
        assert_eq!(rest["entries"][0]["seq"], 3);
        assert_eq!(rest["chain"]["head_seq"], 3);
        assert_eq!(rest["repr"], "as_is");
        // the same heads after a restart
        let before = heads(&a, "acme");
        drop(a);
        let b = console(&dir);
        assert_eq!(heads(&b, "acme"), before);
        assert!(b.take_notes().is_empty());
        assert_eq!(b.orgs(), vec!["acme".to_owned()]);
    }

    #[test]
    fn crash_between_second_and_third_append_recovers() {
        let dir = tests_dir("api-audit-crash");
        let a = console(&dir);
        a.record("acme", call("c_1"), NOW).unwrap();
        a.record_torn("acme", call("c_2"), NOW + 1, 2).unwrap();
        assert_eq!(heads(&a, "acme"), vec![2, 2, 1]);
        drop(a);
        // and the third file holds half a line, as a crash during its write leaves it
        let removed = dir.join("api-audit/acme/console/removed-000001.jsonl");
        let mut f = open_append(&removed).unwrap();
        f.write_all(b"{\"seq\":2,\"ts\":17950").unwrap();
        drop(f);
        let b = console(&dir);
        assert_eq!(heads(&b, "acme"), vec![2, 2, 2]);
        for r in Repr::ALL {
            let es = entries(&b, "acme", "console", r);
            assert_eq!(verify("acme", r, &es, (0, ZERO.to_owned())).0, 2);
        }
        let notes = b.take_notes().join("\n");
        assert!(notes.contains("moved to removed-torn-"), "{notes}");
        assert!(notes.contains("completed after a crash"), "{notes}");
        // completing it again appends nothing twice
        drop(b);
        let c = console(&dir);
        assert_eq!(heads(&c, "acme"), vec![2, 2, 2]);
        c.record("acme", call("c_3"), NOW + 2).unwrap();
        assert_eq!(heads(&c, "acme"), vec![3, 3, 3]);
    }

    #[test]
    fn crash_with_fifty_folded_refusals_gives_one_summary() {
        let dir = tests_dir("api-audit-wal");
        let a = console(&dir);
        for _ in 0..50 {
            a.refusal("acme", "ip:198.51.100.9", "abuse", "POST /api/orgs/acme/oauth/token", refused("198.51.100.9"), NOW).unwrap();
        }
        assert_eq!(heads(&a, "acme"), vec![0, 0, 0]);
        drop(a);
        let b = console(&dir);
        let es = entries(&b, "acme", "console", Repr::AsIs);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["action"], "api.refusal.summary");
        assert_eq!(es[0]["count"], 50);
        assert_eq!(es[0]["check"], "abuse");
        assert!(es[0].get("rid").is_none());
        assert_eq!(std::fs::read_to_string(dir.join("api-audit/acme/console/summary.wal")).unwrap(), "");
        // nothing more at the next restart
        drop(b);
        assert_eq!(entries(&console(&dir), "acme", "console", Repr::AsIs).len(), 1);
    }

    #[test]
    fn summary_log_keeps_to_its_byte_budget() {
        let dir = tests_dir("api-audit-wal-budget");
        let a = console(&dir);
        a.set_wal_budget(600);
        let wal = dir.join("api-audit/acme/console/summary.wal");
        let size = || std::fs::metadata(&wal).unwrap().len();
        // one source floods: the log is compacted, never past its budget
        for _ in 0..200 {
            a.refusal("acme", "ip:198.51.100.9", "abuse", "GET /x", refused("198.51.100.9"), NOW).unwrap();
            assert!(size() <= 600, "{}", size());
        }
        // a second bucket fits; a third does not, and nothing is appended for it
        a.refusal("acme", "ip:198.51.100.10", "abuse", "GET /x", refused("198.51.100.10"), NOW).unwrap();
        let before = size();
        let e = a.refusal("acme", "ip:198.51.100.11", "abuse", "GET /x", refused("198.51.100.11"), NOW).unwrap_err();
        assert_eq!(e.code, "audit-unavailable");
        assert!(size() <= before);
        // an oversized refusal is never folded
        let mut long = refused("198.51.100.12");
        long["route"] = json!("x".repeat(WAL_LINE_MAX));
        assert_eq!(a.refusal("acme", "ip:198.51.100.12", "abuse", "GET /y", long, NOW).unwrap_err().code, "audit-unavailable");
        drop(a);
        let b = console(&dir);
        let mut counts: Vec<u64> = entries(&b, "acme", "console", Repr::AsIs).iter().map(|e| e["count"].as_u64().unwrap()).collect();
        counts.sort_unstable();
        assert_eq!(counts, vec![1, 200]);
    }

    #[test]
    fn a_summary_written_before_its_retire_line_is_not_repeated() {
        let dir = tests_dir("api-audit-wal-retire");
        let a = console(&dir);
        for _ in 0..5 {
            a.refusal("acme", "ip:198.51.100.9", "abuse", "GET /x", refused("198.51.100.9"), NOW).unwrap();
        }
        // the summary's transaction commits, then the process stops before the bucket's retire line
        {
            let set = a.set("acme", "console", false, NOW).unwrap().unwrap();
            let mut s = set.lock();
            let b = s.buckets.values().next().unwrap();
            let mut f = b.entry.clone();
            f.insert("action".into(), json!("api.refusal.summary"));
            f.insert("count".into(), json!(b.count));
            f.insert("bucket".into(), json!(b.id));
            s.commit(&f, None, NOW + 60, 3, &mut Vec::new()).unwrap();
        }
        drop(a);
        let b = console(&dir);
        let es = entries(&b, "acme", "console", Repr::AsIs);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["count"], 5);
        assert!(es[0]["bucket"].as_str().is_some_and(|id| id.len() == 16));
        assert!(b.take_notes().join("\n").contains("was already written"));
        assert_eq!(std::fs::read_to_string(dir.join("api-audit/acme/console/summary.wal")).unwrap(), "");
    }

    #[test]
    fn authenticated_refusals_fold_after_ten() {
        let dir = tests_dir("api-audit-fold");
        let a = console(&dir);
        let mut e = refused("203.0.113.7");
        e["client"] = json!("c_5f1a2b3c4d5e6f70");
        e["check"] = json!("scope");
        for _ in 0..25 {
            a.refusal("acme", "c_5f1a2b3c4d5e6f70", "scope", "GET /api/orgs/acme/v1/audit", e.clone(), NOW).unwrap();
        }
        assert_eq!(a.head("acme", "console", Repr::AsIs).0, 10);
        a.tick(NOW + 60);
        let es = entries(&a, "acme", "console", Repr::AsIs);
        let summary = es.iter().find(|e| e["action"] == "api.refusal.summary").unwrap();
        assert_eq!(summary["count"], 15);
        // the pseudonymized summary carries the client's pseudonym only
        let p = entries(&a, "acme", "console", Repr::Pseudonymized);
        let ps = p.iter().find(|e| e["action"] == "api.refusal.summary").unwrap();
        assert_eq!(ps["client"], json!(pseudonym(&KEY, "c_5f1a2b3c4d5e6f70")));
    }

    #[test]
    fn full_summary_log_is_unavailable() {
        let a = open_in(None, "console", Arc::new(NoSigner), None);
        for i in 0..WAL_BUCKETS {
            a.refusal("acme", &format!("ip:10.0.{}.{}", i / 256, i % 256), "abuse", "GET /x", refused("10.0.0.1"), NOW).unwrap();
        }
        let e = a.refusal("acme", "ip:10.9.9.9", "abuse", "GET /x", refused("10.9.9.9"), NOW).unwrap_err();
        assert_eq!((e.code, e.status()), ("audit-unavailable", 503));
        // a known bucket still counts
        a.refusal("acme", "ip:10.0.0.0", "abuse", "GET /x", refused("10.0.0.0"), NOW).unwrap();
        a.tick(NOW + 60);
        assert_eq!(a.head("acme", "console", Repr::AsIs).0, WAL_BUCKETS as u64);
    }

    #[test]
    fn checkpoint_signs_the_heads_before_it() {
        let dir = tests_dir("api-audit-checkpoint");
        let signer = Arc::new(TestSigner::default());
        let a = open_in(Some(&dir), "console", signer.clone(), Some((1, KEY.to_vec())));
        for i in 0..3 {
            a.record("acme", call("c_1"), NOW + i).unwrap();
        }
        let before: Vec<(u64, String)> = Repr::ALL.iter().map(|r| a.head("acme", "console", *r)).collect();
        a.tick(NOW + 10);
        for (i, r) in Repr::ALL.iter().enumerate() {
            let es = entries(&a, "acme", "console", *r);
            let cp = es.last().unwrap();
            assert_eq!(cp["action"], "checkpoint");
            assert_eq!(cp["kid"], "k-acme");
            let pj = unb64u(cp["payload"].as_str().unwrap()).unwrap();
            let payload: Value = serde_json::from_slice(&pj).unwrap();
            assert_eq!(payload["org"], "acme");
            assert_eq!(payload["source"], "console");
            for (j, name) in ["as_is", "pseudonymized", "removed"].iter().enumerate() {
                assert_eq!(payload["heads"][name], json!([before[j].0, before[j].1]));
            }
            assert_eq!(cp["seq"].as_u64(), Some(before[i].0 + 1));
            let sig = unb64u(cp["sig"].as_str().unwrap()).unwrap();
            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, signer.public("acme")).verify(&checkpoint_signed_bytes(&pj), &sig).is_ok());
        }
        // nothing new: no second checkpoint
        a.tick(NOW + 400);
        assert_eq!(a.head("acme", "console", Repr::AsIs).0, 4);
        // a signer without a certified key writes none and nothing fails
        let n = open_in(None, "console", Arc::new(NoSigner), None);
        n.record("acme", call("c_1"), NOW).unwrap();
        n.tick(NOW + 400);
        assert_eq!(n.head("acme", "console", Repr::AsIs).0, 1);
    }

    #[test]
    fn checkpoint_every_thousand_entries() {
        let a = open_in(None, "console", Arc::new(TestSigner::default()), Some((1, KEY.to_vec())));
        for _ in 0..CHECKPOINT_ENTRIES {
            a.record("acme", call("c_1"), NOW).unwrap();
        }
        // a page holds at most LIMIT_MAX entries, so read the head and the entry after the thousandth
        assert_eq!(a.head("acme", "console", Repr::AsIs).0, CHECKPOINT_ENTRIES + 1);
        let page = a.read("acme", "console", Repr::AsIs, CHECKPOINT_ENTRIES, 10).unwrap();
        let es = page["entries"].as_array().unwrap();
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["action"], "checkpoint");
    }

    #[test]
    fn two_orgs_never_share_a_file_cursor_or_checkpoint() {
        let dir = tests_dir("api-audit-orgs");
        let signer = Arc::new(TestSigner::default());
        let a = open_in(Some(&dir), "console", signer.clone(), Some((1, KEY.to_vec())));
        a.record("acme", call("c_1"), NOW).unwrap();
        a.record("beta", call("c_1"), NOW).unwrap();
        a.tick(NOW + 10);
        for (org, other) in [("acme", "beta"), ("beta", "acme")] {
            let folder = dir.join("api-audit").join(org).join("console");
            for f in std::fs::read_dir(&folder).unwrap() {
                let text = std::fs::read_to_string(f.unwrap().path()).unwrap();
                assert!(!text.contains(&format!("\"org\":\"{other}\"")));
            }
            // the same seq in both orgs: different hashes, cursors that do not cross
            let c = a.read(org, "console", Repr::AsIs, 0, 1).unwrap()["next"].as_str().unwrap().to_owned();
            assert_eq!(parse_cursor(&c, org, "console", Repr::AsIs), Some(1));
            assert_eq!(parse_cursor(&c, other, "console", Repr::AsIs), None);
            assert_eq!(parse_cursor(&c, org, "console", Repr::Removed), None);
            let cp = entries(&a, org, "console", Repr::AsIs).last().unwrap().clone();
            let pj = unb64u(cp["payload"].as_str().unwrap()).unwrap();
            let sig = unb64u(cp["sig"].as_str().unwrap()).unwrap();
            let payload: Value = serde_json::from_slice(&pj).unwrap();
            assert_eq!(payload["org"], org);
            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, signer.public(org)).verify(&checkpoint_signed_bytes(&pj), &sig).is_ok());
            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, signer.public(other)).verify(&checkpoint_signed_bytes(&pj), &sig).is_err());
        }
        assert_ne!(a.head("acme", "console", Repr::AsIs).1, a.head("beta", "console", Repr::AsIs).1);
    }

    #[test]
    fn pseudonymized_entries_never_hold_a_raw_identity() {
        let dir = tests_dir("api-audit-canary");
        let a = console(&dir);
        let canaries = [
            ("client", "c_canary0000000001"),
            ("act", "canary-subject@acme.example"),
            ("ip", "198.51.100.231"),
            ("principal", "canary-principal@acme.example"),
            ("serial", "7ca7a5e1a1"),
            ("device", "canary-device-77"),
            ("node", "canary-node-99"),
        ];
        let mut e = json!({"action": "cert.grace-used", "result": "ok", "kind": "meet"});
        for (k, v) in canaries {
            e[k] = json!(v);
        }
        a.record("acme", e, NOW).unwrap();
        a.tick(NOW + 10);
        for file in ["pseudonymized-000001.jsonl", "removed-000001.jsonl"] {
            let text = std::fs::read_to_string(dir.join("api-audit/acme/console").join(file)).unwrap();
            for (_, v) in canaries {
                assert!(!text.contains(v), "{file} holds {v}");
            }
        }
        let p = &entries(&a, "acme", "console", Repr::Pseudonymized)[0];
        for (k, v) in canaries {
            assert_eq!(p[k], json!(pseudonym(&KEY, v)));
            assert!(p[k].as_str().unwrap().starts_with("p_") && p[k].as_str().unwrap().len() == 18);
        }
        assert_eq!(p["pkv"], 1);
        let r = &entries(&a, "acme", "console", Repr::Removed)[0];
        assert!(canaries.iter().all(|(k, _)| r.get(*k).is_none()));
        assert_eq!(r["kind"], "meet");
    }

    #[test]
    fn missing_pseudonym_key_gives_the_removed_form() {
        let a = open_in(None, "console", Arc::new(NoSigner), None);
        a.record("acme", call("c_5f1a2b3c4d5e6f70"), NOW).unwrap();
        let p = entries(&a, "acme", "console", Repr::Pseudonymized)[0].as_object().unwrap().clone();
        let r = entries(&a, "acme", "console", Repr::Removed)[0].as_object().unwrap().clone();
        assert_eq!(p.get("pkv"), Some(&json!(0)));
        assert!(p.get("client").is_none() && p.get("ip").is_none());
        let strip = |m: &Map<String, Value>| m.iter().filter(|(k, _)| !matches!(k.as_str(), "pkv" | "prev" | "hash")).map(|(k, v)| (k.clone(), v.clone())).collect::<BTreeMap<_, _>>();
        assert_eq!(strip(&p), strip(&r));
    }

    #[test]
    fn ingest_refuses_a_gap_and_a_bad_hash() {
        let relay_dir = tests_dir("api-audit-relay");
        let console_dir = tests_dir("api-audit-ingest");
        let relay = "r_00000000000000aa";
        let r = open_in(Some(&relay_dir), relay, Arc::new(TestSigner::default()), Some((1, KEY.to_vec())));
        let c = console(&console_dir);
        for i in 0..5 {
            r.record("acme", call("c_1"), NOW + i).unwrap();
        }
        assert_eq!(entries(&r, "acme", relay, Repr::AsIs)[0]["relay"], relay);
        for repr in Repr::ALL {
            let es = r.since("acme", repr, 0, 100);
            assert_eq!(c.ingest("acme", relay, repr, 2, 3, &es[1..3]), Err(IngestError::Gap(1)));
            c.ingest("acme", relay, repr, 1, 3, &es[0..3]).unwrap();
            // a resend of what is stored changes nothing; an overlap that differs is refused
            c.ingest("acme", relay, repr, 2, 3, &es[1..3]).unwrap();
            let mut changed = es[2].clone();
            changed["hash"] = json!(ZERO);
            assert!(matches!(c.ingest("acme", relay, repr, 3, 3, &[changed]), Err(IngestError::Invalid(_))));
            // a changed field or a forged hash does not verify
            let mut tampered = es[3..5].to_vec();
            tampered[0]["result"] = json!("refused");
            assert!(matches!(c.ingest("acme", relay, repr, 4, 5, &tampered), Err(IngestError::Invalid(_))));
            let mut forged = es[3..5].to_vec();
            forged[1]["hash"] = json!("ab".repeat(32));
            assert!(matches!(c.ingest("acme", relay, repr, 4, 5, &forged), Err(IngestError::Invalid(_))));
            assert_eq!(c.head("acme", relay, repr).0, 3);
            c.ingest("acme", relay, repr, 4, 5, &es[3..5]).unwrap();
            assert_eq!(c.head("acme", relay, repr), r.head("acme", relay, repr));
        }
        assert!(console_dir.join("api-audit/acme").join(relay).join("as_is-000001.jsonl").is_file());
        // another org's entries never enter this org's chain
        let es = r.since("acme", Repr::AsIs, 0, 1);
        assert!(matches!(c.ingest("beta", relay, Repr::AsIs, 1, 1, &es), Err(IngestError::Invalid(_))));
        // the console reads them back after a restart, by relay id
        drop(c);
        let c = console(&console_dir);
        assert_eq!(entries(&c, "acme", relay, Repr::Removed).len(), 5);
        assert_eq!(c.orgs(), Vec::<String>::new());
    }

    /// `e` changed by `f` and chained again after its `prev`, as a relay without the console's trust could forge it.
    fn forged(repr: Repr, e: &Value, f: impl FnOnce(&mut Map<String, Value>)) -> Value {
        let mut o = e.as_object().unwrap().clone();
        f(&mut o);
        let prev = o["prev"].as_str().unwrap().to_owned();
        let h = chain_hash(&repr.label("acme"), &prev, &o).unwrap();
        o.insert("hash".into(), json!(h));
        Value::Object(o)
    }

    #[test]
    fn ingest_refuses_entries_that_break_their_form() {
        let relay = "r_00000000000000aa";
        let r = open_in(Some(&tests_dir("api-audit-form-relay")), relay, Arc::new(NoSigner), Some((1, KEY.to_vec())));
        let c = console(&tests_dir("api-audit-form-console"));
        r.record("acme", call("c_1"), NOW).unwrap();
        let first = |repr: Repr| r.since("acme", repr, 0, 1)[0].clone();
        let cases = [
            (Repr::Pseudonymized, forged(Repr::Pseudonymized, &first(Repr::Pseudonymized), |o| {
                o.insert("client".into(), json!("c_1"));
            })),
            (Repr::Removed, forged(Repr::Removed, &first(Repr::Removed), |o| {
                o.insert("ip".into(), json!("203.0.113.7"));
            })),
            (Repr::AsIs, forged(Repr::AsIs, &first(Repr::AsIs), |o| {
                o.insert("why".into(), json!("free text"));
            })),
            (Repr::AsIs, forged(Repr::AsIs, &first(Repr::AsIs), |o| {
                o.insert("relay".into(), json!("r_00000000000000bb"));
            })),
            (Repr::AsIs, forged(Repr::AsIs, &first(Repr::AsIs), |o| {
                o.insert("source".into(), json!("console"));
            })),
            (Repr::Removed, forged(Repr::Removed, &first(Repr::Removed), |o| {
                o.insert("raw_seq".into(), json!(2));
            })),
            (Repr::Pseudonymized, forged(Repr::Pseudonymized, &first(Repr::Pseudonymized), |o| {
                o.insert("pkv".into(), json!(0));
            })),
            (Repr::AsIs, forged(Repr::AsIs, &first(Repr::AsIs), |o| {
                o.insert("bucket".into(), json!("0123456789abcdef"));
            })),
            (Repr::AsIs, forged(Repr::AsIs, &first(Repr::AsIs), |o| {
                o.insert("count".into(), json!([1]));
            })),
        ];
        for (i, (repr, e)) in cases.iter().enumerate() {
            assert!(matches!(c.ingest("acme", relay, *repr, 1, 1, std::slice::from_ref(e)), Err(IngestError::Invalid(_))), "case {i}");
        }
        // derived entries that are not the decision of the stored as_is entry
        c.ingest("acme", relay, Repr::AsIs, 1, 1, &[first(Repr::AsIs)]).unwrap();
        let other = forged(Repr::Removed, &first(Repr::Removed), |o| {
            o.insert("result".into(), json!("refused"));
        });
        assert!(matches!(c.ingest("acme", relay, Repr::Removed, 1, 1, &[other]), Err(IngestError::Invalid(_))));
        let wrong = forged(Repr::Pseudonymized, &first(Repr::Pseudonymized), |o| {
            o.insert("client".into(), json!(pseudonym(&KEY, "c_2")));
        });
        assert!(matches!(c.ingest("acme", relay, Repr::Pseudonymized, 1, 1, &[wrong]), Err(IngestError::Invalid(_))));
        for repr in [Repr::Pseudonymized, Repr::Removed] {
            c.ingest("acme", relay, repr, 1, 1, &[first(repr)]).unwrap();
        }
        assert_eq!(c.head("acme", relay, Repr::Removed), r.head("acme", relay, Repr::Removed));
    }

    #[test]
    fn entries_with_unknown_fields_are_refused() {
        let a = open_in(None, "console", Arc::new(NoSigner), None);
        let mut e = call("c_1");
        e["why"] = json!("free text");
        assert_eq!(a.record("acme", e, NOW).unwrap_err().code, "bad-request");
        let mut e = call("c_1");
        e["client"] = json!(5);
        assert_eq!(a.record("acme", e, NOW).unwrap_err().code, "bad-request");
        let mut e = call("c_1");
        e["scope"] = Value::Null;
        assert_eq!(a.record("acme", e, NOW).unwrap_err().code, "bad-request");
        let mut e = call("c_1");
        e["action"] = json!("checkpoint");
        assert_eq!(a.record("acme", e, NOW).unwrap_err().code, "bad-request");
        let mut e = call("c_1");
        e["source"] = json!("relay");
        assert_eq!(a.record("acme", e, NOW).unwrap_err().code, "bad-request");
        assert_eq!(a.record("ACME", call("c_1"), NOW).unwrap_err().code, "bad-request");
        assert_eq!(a.refusal("acme", "c_1", "scope", "GET /x", call("c_1"), NOW).unwrap_err().code, "bad-request");
        assert_eq!(a.head("acme", "console", Repr::AsIs).0, 0);
    }

    #[test]
    fn below_the_reserve_only_refusals_are_taken() {
        let dir = tests_dir("api-audit-reserve");
        let a = console(&dir);
        a.set_free_space(Arc::new(|_: &Path| Some(RESERVE_BYTES - 1)));
        assert!(!a.allowed_ok());
        assert_eq!(a.record("acme", call("c_1"), NOW).unwrap_err().code, "audit-unavailable");
        a.refusal("acme", "ip:198.51.100.9", "abuse", "GET /x", refused("198.51.100.9"), NOW).unwrap();
        a.set_free_space(Arc::new(|_: &Path| Some(RESERVE_BYTES)));
        assert!(a.allowed_ok());
        a.record("acme", call("c_1"), NOW).unwrap();
    }

    #[test]
    fn retention_drops_old_segments_under_the_hold() {
        let dir = tests_dir("api-audit-retention");
        let open = || ApiAudit::open_with(Some(&dir), "console", Arc::new(NoSigner), Arc::new(FixedKey(Some((1, KEY.to_vec())))), NOW, 300);
        let a = open();
        for i in 0..5 {
            a.record("acme", call("c_1"), NOW + i).unwrap();
        }
        assert!(dir.join("api-audit/acme/console/as_is-000005.jsonl").is_file());
        // a relay's chains received on the console, held per representation
        let relay = "r_00000000000000aa";
        let r = open_in(Some(&tests_dir("api-audit-retention-relay")), relay, Arc::new(NoSigner), Some((1, KEY.to_vec())));
        for i in 0..5 {
            r.record("acme", call("c_1"), NOW + i).unwrap();
        }
        for repr in Repr::ALL {
            a.ingest("acme", relay, repr, 1, 5, &r.since("acme", repr, 0, 10)).unwrap();
        }
        a.set_retention_hold(Arc::new(|org: &str, source: &str, repr: Repr| match (source, repr) {
            ("console", _) => (org == "acme").then_some(3),
            (_, Repr::AsIs) => Some(4),
            (_, Repr::Removed) => Some(2),
            (_, Repr::Pseudonymized) => None,
        }));
        a.tick(NOW + RETENTION_SECS + 10);
        for r in Repr::ALL {
            let es = entries(&a, "acme", "console", r);
            assert_eq!(es[0]["seq"], 3, "{}", r.as_str());
        }
        assert!(!dir.join("api-audit/acme/console/as_is-000001.jsonl").exists());
        let firsts: Vec<Value> = Repr::ALL.iter().map(|r| entries(&a, "acme", relay, *r)[0]["seq"].clone()).collect();
        assert_eq!(firsts, vec![json!(4), json!(5), json!(2)]);
        // without a hold everything but the newest segment goes; the kept chain still verifies after a restart
        a.set_retention_hold(Arc::new(|_: &str, _: &str, _: Repr| None));
        a.tick(NOW + RETENTION_SECS + 20);
        drop(a);
        let b = open();
        assert!(b.take_notes().is_empty());
        let es = entries(&b, "acme", "console", Repr::AsIs);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["seq"], 5);
        b.record("acme", call("c_1"), NOW + 30).unwrap();
        assert_eq!(b.head("acme", "console", Repr::AsIs).0, 6);
    }

    #[test]
    fn pseudonym_vector() {
        // HMAC-SHA-256 with a fixed key and value, its first 16 hex digits
        let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, &KEY);
        let full = hex(aws_lc_rs::hmac::sign(&k, b"c_5f1a2b3c4d5e6f70").as_ref());
        assert_eq!(pseudonym(&KEY, "c_5f1a2b3c4d5e6f70"), format!("p_{}", &full[..16]));
        assert_eq!(Repr::of("pseudonymized"), Some(Repr::Pseudonymized));
        assert_eq!(Repr::Removed.label("acme"), "lucid-api-audit-removed-v1:acme");
        assert_eq!(Repr::AsIs.label("acme"), "lucid-api-audit-as-is-v1:acme");
        assert_eq!(Repr::Pseudonymized.label("acme"), "lucid-api-audit-pseudo-v1:acme");
    }
}
