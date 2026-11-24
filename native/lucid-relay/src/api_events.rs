// API-1 revision 4 (docs/api/contract-r4-1b.md) section 7.1 to 7.3: the event chains, the console's feed index and
// the pull feed (`v1/events` on I and RR, long poll), with the CloudEvents 1.0 envelope.
//
// Event chains are the audit chains of revision 3 9.1 to 9.4 (`api_audit`, kind `ChainKind::Events`): per org and
// source, three representations (labels `lucid-api-events-as-is-v1:<org>`, `-pseudo-`, `-removed-`), crash-atomic
// transactions, checkpoints every 1000 entries or 5 minutes signed by the org's checkpoint key over
// lp("lucid-api-events-checkpoint-v1", payload), files `api-events/<org>/<source>/`. Retention is a hard 35 days, and
// below 1 GiB free the oldest segments go early (`reason` `space`); events never block deletion and never refuse a
// call. An event's chain record is
//
//   {"seq", "ts", "org", "relay"? (relay sources only), "type", "data"? (absent when empty), "pkv"? (pseudonymized
//    only), "prev", "hash"}
//
// with `data` holding only the registry's fields for the type (`api_catalog`, kind `event`). The pseudonymized form
// turns identity-tagged fields into pseudonyms (`api_audit::pseudonym`; dropped without a key, `pkv` 0), the removed
// form drops them, and both drop `free_text` fields (a meeting title is never in a transformed form, Rev4Review
// R4-11). Every append writes all three, so an event has the same seq in each and the derived forms carry no
// `raw_seq`.
//
// The CloudEvent carries the record losslessly (`cloud_event`; the tests rebuild it as a subscriber does):
// `id` = `<label>/<source>:<seq>`, `source` `/api/orgs/<org>/console` or `/api/orgs/<org>/relays/<id>`, `type`
// `com.emertins.lucid.<name>`, `time` from `ts`, `subject` the registry's subject field, `data`, and the extensions
// `lucidorg`, `lucidseq`, `lucidchain` (`<label>/<source>`), `lucidprev`, `lucidhash` and, pseudonymized,
// `lucidpkv`. A subscriber rebuilds the record from those and checks `lucidhash` = SHA-256(lp(label, prev,
// canonical JSON of the record without `hash`)).
//
// The console's feed index (`api-events/<org>/feed.jsonl`, append-only, flushed) lists `(fseq, source, seq)` in the
// order the console stored events (its own and the relays' it received through `api-events`); a relay's entry is
// indexed once all three of its forms are stored. The feed filters by the client's effective scopes, relays,
// ceiling and the `types` asked for; every chain entry it may not see is a stub (`lucidseq`, `lucidchain`,
// `lucidprev`, `lucidhash`, `stub: true`) unless `stubs=false`, so continuity stays checkable (Rev4Review R4-9).
// Cursors are opaque: on I a feed position, on RR the relay's own seq.

use crate::api_audit::{ApiAudit, AuditError, CheckpointSigner, Dropped, IngestError, PseudonymKeys, Repr};
use crate::api_catalog::{catalog, Ceiling, RecordType, Tag};
use crate::codec::{b64u, parse_json, stringify, unb64u};
use crate::fleet_local::write_durable;
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The folder under the state folder.
pub const EVENTS_DIR: &str = "api-events";
/// 7.3: the checkpoint payload label.
pub const CHECKPOINT_LABEL: &str = "lucid-api-events-checkpoint-v1";
/// 7.3 (Rev4Review R4-17, R4-D16): a hard 35 days.
pub const RETENTION_SECS: i64 = 35 * 86_400;
/// 7.3: below this much free space on the event volume the oldest segments go early.
pub const SPACE_FLOOR: u64 = 1 << 30;
/// 7.2: the CloudEvents `type` prefix (reverse DNS).
pub const TYPE_PREFIX: &str = "com.emertins.lucid.";
/// 7.2: `dataschema` is this, the registry name, then `/1`.
pub const SCHEMA_BASE: &str = "https://lucid.emertins.com/schemas/events/";
/// 7.2: one event serializes to at most 16 KiB.
pub const EVENT_MAX: usize = 16 * 1024;
/// 7.3: `wait` is 0 to 25 seconds.
pub const WAIT_MAX: u64 = 25;
/// 7.3: `limit` is 1 to 1000.
pub const LIMIT_MAX: usize = 1000;
/// With `stubs=false`, at most this many chain entries are looked at for one page.
const SCAN_MAX: usize = 20_000;
const FEED_FILE: &str = "feed.jsonl";
const MAX_SAFE: u64 = (1 << 53) - 1;

// ── labels, records and the envelope ────────────────────────────────────────────────────────────────────────────

/// 7.3: the hash label of the org's event chain in one representation.
pub fn label(repr: Repr, org: &str) -> String {
    let part = match repr {
        Repr::AsIs => "as-is",
        Repr::Pseudonymized => "pseudo",
        Repr::Removed => "removed",
    };
    format!("lucid-api-events-{part}-v1:{org}")
}

/// 7.2 `lucidchain`: the label and the source.
pub fn chain_name(repr: Repr, org: &str, source: &str) -> String {
    format!("{}/{source}", label(repr, org))
}

/// The chain record fields (before seq, ts, org, prev, hash) of an event of `source` (`console` or a relay id).
fn record_fields(source: &str, kind: &str, data: Map<String, Value>) -> Map<String, Value> {
    let mut f = Map::new();
    if source != "console" {
        f.insert("relay".into(), Value::from(source));
    }
    f.insert("type".into(), Value::from(kind));
    if !data.is_empty() {
        f.insert("data".into(), Value::Object(data));
    }
    f
}

/// A checkpoint entry's fields (written by `ApiAudit::checkpoint` for event chains).
pub fn checkpoint_fields(source: &str, kid: &str, payload: &str, sig: &str) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("kid".into(), Value::from(kid));
    data.insert("payload".into(), Value::from(payload));
    data.insert("sig".into(), Value::from(sig));
    record_fields(source, "checkpoint", data)
}

fn tag_of(e: &RecordType, field: &str) -> Option<Tag> {
    e.fields.iter().find(|(k, _)| k == field).and_then(|(_, f)| match f {
        crate::api_catalog::Field::Leaf(t) => Some(*t),
        crate::api_catalog::Field::Object(_) => None,
    })
}

fn identity(t: Tag) -> bool {
    !matches!(t, Tag::Plain | Tag::FreeText)
}

fn scalar(v: &Value, ident: bool) -> bool {
    match v {
        Value::String(_) => true,
        Value::Bool(_) => !ident,
        Value::Number(n) => !ident && (n.as_u64().is_some_and(|u| u <= MAX_SAFE) || n.as_i64().is_some_and(|i| i.unsigned_abs() <= MAX_SAFE)),
        _ => false,
    }
}

/// `p_` and 16 lowercase hex.
fn is_pseudonym(s: &str) -> bool {
    s.len() == 18 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 7.1: an event a caller emits, checked against the registry: the type is listed for this kind of source (and is
/// not `checkpoint`, which only the chains write), `data` (an object, or null for none) holds only the type's fields
/// with string, boolean or integer values (identities strings only), and the record fits 16 KiB as a CloudEvent.
pub fn check_emit(source: &str, kind: &str, data: &Value) -> Result<Map<String, Value>, AuditError> {
    let et = catalog().event(kind).filter(|_| kind != "checkpoint").ok_or_else(|| AuditError::bad(format!("{kind} is not an event type of the registry")))?;
    let side = if source == "console" { "console" } else { "relay" };
    if !et.sources.iter().any(|s| s == side) {
        return Err(AuditError::bad(format!("{kind} is not emitted by a {side}")));
    }
    let data = match data {
        Value::Null => Map::new(),
        Value::Object(m) => m.clone(),
        _ => return Err(AuditError::bad("event data is a JSON object")),
    };
    for (k, v) in &data {
        let tag = tag_of(et, k).ok_or_else(|| AuditError::bad(format!("{k} is not a field of {kind}")))?;
        if !scalar(v, identity(tag)) {
            return Err(AuditError::bad(format!("the field {k} of {kind} has a value of the wrong kind")));
        }
    }
    let f = record_fields(source, kind, data);
    // the envelope's own attributes take about 700 bytes
    if stringify(&Value::Object(f.clone())).len() + 1024 > EVENT_MAX {
        return Err(AuditError::bad(format!("the {kind} event is over 16 KiB")));
    }
    Ok(f)
}

/// 7.1, 7.3: the fields of one representation: as is; pseudonymized (identity fields as pseudonyms with the key's
/// version in `pkv`, or dropped with `pkv` 0 when there is no key; free text dropped); removed (identities and free
/// text dropped). A field the registry does not list is dropped from the derived forms (fail closed).
pub fn derive(fields: &Map<String, Value>, repr: Repr, key: Option<&(u32, Vec<u8>)>) -> Map<String, Value> {
    if repr == Repr::AsIs {
        return fields.clone();
    }
    let mut out = fields.clone();
    let et = fields.get("type").and_then(Value::as_str).and_then(|k| catalog().event(k));
    if let Some(Value::Object(d)) = fields.get("data") {
        let mut kept = Map::new();
        for (k, v) in d {
            match et.and_then(|e| tag_of(e, k)) {
                Some(Tag::Plain) => {
                    kept.insert(k.clone(), v.clone());
                }
                Some(t) if identity(t) && repr == Repr::Pseudonymized => {
                    if let Some((_, key)) = key {
                        let text = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
                        kept.insert(k.clone(), Value::from(crate::api_audit::pseudonym(key, &text)));
                    }
                }
                _ => {}
            }
        }
        if kept.is_empty() {
            out.remove("data");
        } else {
            out.insert("data".into(), Value::Object(kept));
        }
    }
    if repr == Repr::Pseudonymized {
        out.insert("pkv".into(), Value::from(key.map_or(0, |(v, _)| *v)));
    }
    out
}

/// A received entry of a relay's event chain in one representation, checked in full but for its link: only the
/// record's keys; `relay` the relay; a registry type a relay emits; `data` only that type's fields as scalars, with
/// identities as is (as_is), pseudonyms (pseudonymized with `pkv` above 0) or absent, and free text only as is; a
/// checkpoint's data exactly kid, payload and sig.
pub fn check_received(o: &Map<String, Value>, repr: Repr, relay: &str, seq: u64) -> Result<(), String> {
    let bad = |why: String| -> Result<(), String> { Err(format!("event {seq}: {why}")) };
    for k in o.keys() {
        let known = matches!(k.as_str(), "seq" | "ts" | "org" | "relay" | "type" | "data" | "prev" | "hash") || (k == "pkv" && repr == Repr::Pseudonymized);
        if !known {
            return bad(format!("{k} is not an event record field"));
        }
    }
    if o.get("relay").and_then(Value::as_str) != Some(relay) {
        return bad(format!("it does not name relay {relay}"));
    }
    if o.get("ts").and_then(Value::as_i64).is_none() {
        return bad("it has no ts".into());
    }
    let kind = o.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(et) = catalog().event(kind).filter(|e| e.sources.iter().any(|s| s == "relay")) else {
        return bad(format!("{kind} is not an event type a relay emits"));
    };
    let pkv = o.get("pkv").and_then(Value::as_u64);
    if repr == Repr::Pseudonymized && pkv.is_none() {
        return bad("it has no pkv".into());
    }
    let data = match o.get("data") {
        None => Map::new(),
        Some(Value::Object(d)) if !d.is_empty() => d.clone(),
        Some(_) => return bad("its data is not a non-empty object".into()),
    };
    for (k, v) in &data {
        let Some(tag) = tag_of(et, k) else { return bad(format!("{k} is not a field of {kind}")) };
        if !scalar(v, identity(tag)) {
            return bad(format!("{k} has a value of the wrong kind"));
        }
        match (repr, tag) {
            (Repr::AsIs, _) | (_, Tag::Plain) => {}
            (_, Tag::FreeText) => return bad(format!("the transformed form keeps {k}")),
            (Repr::Removed, _) => return bad(format!("the removed form keeps {k}")),
            (Repr::Pseudonymized, _) if pkv == Some(0) || !v.as_str().is_some_and(is_pseudonym) => return bad(format!("{k} is not a pseudonym")),
            _ => {}
        }
    }
    if kind == "checkpoint" && (data.len() != 3 || ["kid", "payload", "sig"].iter().any(|k| !data.get(*k).is_some_and(Value::is_string))) {
        return bad("a checkpoint carries exactly kid, payload and sig".into());
    }
    Ok(())
}

/// Whether two representations of one seq are the same event: seq, ts, org, relay, type and the plain data equal;
/// and, when one is pseudonymized under the key version the console holds and the other keeps identities (as is),
/// the pseudonymized form carries exactly the identity fields of the as is form, each the HMAC of the as is value.
/// `reprs` names the representations of `a` and `b`.
pub fn same_event(a: &Map<String, Value>, b: &Map<String, Value>, reprs: (Repr, Repr), key: Option<&(u32, Vec<u8>)>) -> bool {
    if ["seq", "ts", "org", "relay", "type"].iter().any(|k| a.get(*k) != b.get(*k)) {
        return false;
    }
    let et = a.get("type").and_then(Value::as_str).and_then(|k| catalog().event(k));
    let data = |m: &Map<String, Value>| m.get("data").and_then(Value::as_object).cloned().unwrap_or_default();
    let (da, db) = (data(a), data(b));
    let with = |d: &Map<String, Value>, want: &dyn Fn(Tag) -> bool| -> Map<String, Value> {
        d.iter().filter(|(k, _)| et.and_then(|e| tag_of(e, k)).is_some_and(want)).map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    if with(&da, &|t| t == Tag::Plain) != with(&db, &|t| t == Tag::Plain) {
        return false;
    }
    let (raw, derived, pkv) = match reprs {
        (Repr::AsIs, Repr::Pseudonymized) => (&da, &db, b.get("pkv").and_then(Value::as_u64)),
        (Repr::Pseudonymized, Repr::AsIs) => (&db, &da, a.get("pkv").and_then(Value::as_u64)),
        _ => return true,
    };
    match (key, pkv) {
        // A value that already is a pseudonym is kept, as `derive` keeps it.
        (Some((v, k)), Some(p)) if p > 0 && p == u64::from(*v) => {
            let (ids, pseudo) = (with(raw, &identity), with(derived, &identity));
            ids.len() == pseudo.len()
                && ids.iter().all(|(f, val)| {
                    let expected = match val.as_str() {
                        Some(s) if is_pseudonym(s) => val.clone(),
                        _ => Value::from(crate::api_audit::pseudonym(k, &val.as_str().map_or_else(|| val.to_string(), str::to_owned))),
                    };
                    pseudo.get(f) == Some(&expected)
                })
        }
        _ => true,
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` of unix seconds.
fn time_of(ts: i64) -> String {
    let t = crate::codec::iso_time(ts.saturating_mul(1000));
    format!("{}Z", &t[..t.len().saturating_sub(5)])
}

/// 7.2: the CloudEvent of a chain entry of `source` in `repr`; None for an entry that is not an event record.
pub fn cloud_event(org: &str, source: &str, repr: Repr, e: &Map<String, Value>) -> Option<Value> {
    let seq = e.get("seq")?.as_u64()?;
    let ts = e.get("ts")?.as_i64()?;
    let kind = e.get("type")?.as_str()?;
    let chain = chain_name(repr, org, source);
    let src = if source == "console" { format!("/api/orgs/{org}/console") } else { format!("/api/orgs/{org}/relays/{source}") };
    let mut ce = Map::new();
    ce.insert("specversion".into(), json!("1.0"));
    ce.insert("id".into(), json!(format!("{chain}:{seq}")));
    ce.insert("source".into(), json!(src));
    ce.insert("type".into(), json!(format!("{TYPE_PREFIX}{kind}")));
    ce.insert("time".into(), json!(time_of(ts)));
    let data = e.get("data").and_then(Value::as_object);
    if let Some(s) = catalog().event(kind).and_then(|et| et.subject.as_deref()).and_then(|f| data?.get(f)?.as_str()) {
        ce.insert("subject".into(), json!(s));
    }
    ce.insert("dataschema".into(), json!(format!("{SCHEMA_BASE}{kind}/1")));
    ce.insert("datacontenttype".into(), json!("application/json"));
    ce.insert("lucidorg".into(), json!(org));
    ce.insert("lucidseq".into(), json!(seq));
    ce.insert("lucidchain".into(), json!(chain));
    ce.insert("lucidprev".into(), e.get("prev")?.clone());
    ce.insert("lucidhash".into(), e.get("hash")?.clone());
    if let Some(p) = e.get("pkv") {
        ce.insert("lucidpkv".into(), p.clone());
    }
    if let Some(d) = data {
        ce.insert("data".into(), Value::Object(d.clone()));
    }
    Some(Value::Object(ce))
}

/// 7.3: the stub of an entry the client may not see.
fn stub(org: &str, source: &str, repr: Repr, e: &Map<String, Value>) -> Value {
    json!({"lucidseq": e.get("seq"), "lucidchain": chain_name(repr, org, source), "lucidprev": e.get("prev"), "lucidhash": e.get("hash"), "stub": true})
}

/// An opaque feed cursor: the org, the scope (`console` for I's feed, the relay id for RR's) and the position.
pub fn cursor(org: &str, scope: &str, pos: u64) -> String {
    b64u(format!("ev1\n{org}\n{scope}\n{pos}").as_bytes())
}

fn parse_cursor(c: &str, org: &str, scope: &str) -> Option<u64> {
    let text = String::from_utf8(unb64u(c)?).ok()?;
    let parts: Vec<&str> = text.split('\n').collect();
    let [v, o, s, n] = parts.as_slice() else { return None };
    if *v != "ev1" || *o != org || *s != scope || n.is_empty() || n.len() > 16 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

// ── who reads ─────────────────────────────────────────────────────────────────────────────────────────────────

/// What a client may see of the feed (7.3, 7.4 selection): its effective scopes, the relays it reaches (`console`
/// for the console's events), its effective ceiling (judged against the class of the representation read), and the
/// types it asked for.
pub struct Viewer<'a> {
    pub scopes: &'a [String],
    pub reaches: &'a dyn Fn(&str) -> bool,
    pub ceiling: Ceiling,
    pub repr: Repr,
    /// `types=`; None for every type.
    pub types: Option<Vec<String>>,
}

impl Viewer<'_> {
    fn type_ok(&self, et: &RecordType) -> bool {
        let class = if self.repr == Repr::AsIs { et.class } else { et.class_transformed };
        self.scopes.iter().any(|s| *s == et.scope) && class <= self.ceiling
    }

    fn sees(&self, source: &str, e: &Map<String, Value>) -> bool {
        let Some(et) = e.get("type").and_then(Value::as_str).and_then(|k| catalog().event(k)) else { return false };
        self.types.as_ref().is_none_or(|t| t.iter().any(|x| *x == et.name)) && self.type_ok(et) && (self.reaches)(source)
    }
}

/// The query of `v1/events`: `after`, `limit` (1 to 1000, default 100), `wait` (0 to 25), `types` (registry names),
/// `stubs` (`true` or `false`). Err is the 400 sentence.
pub struct FeedQuery {
    pub after: Option<String>,
    pub limit: usize,
    pub wait: u64,
    pub types: Option<Vec<String>>,
    pub stubs: bool,
}

impl FeedQuery {
    pub fn parse(query: &str) -> Result<FeedQuery, &'static str> {
        let param = |k: &str| query.split('&').filter_map(|p| p.split_once('=')).find(|(a, _)| *a == k).map(|(_, v)| v);
        let limit = match param("limit") {
            None => crate::api_resource::PAGE_DEFAULT,
            Some(l) => l.parse::<usize>().ok().filter(|n| (1..=LIMIT_MAX).contains(n)).ok_or("limit must be a number from 1 to 1000.")?,
        };
        let wait = match param("wait") {
            None => 0,
            Some(w) => w.parse::<u64>().ok().filter(|n| *n <= WAIT_MAX).ok_or("wait must be a number of seconds from 0 to 25.")?,
        };
        let types = match param("types") {
            None => None,
            Some(t) => {
                let list: Vec<String> = t.replace("%2C", ",").replace("%2c", ",").split(',').map(str::to_owned).collect();
                if list.is_empty() || list.len() > 64 || list.iter().any(|n| catalog().event(n).is_none()) {
                    return Err("types must list event types of the registry, separated by commas.");
                }
                Some(list)
            }
        };
        let stubs = match param("stubs") {
            None | Some("true") => true,
            Some("false") => false,
            Some(_) => return Err("stubs must be true or false."),
        };
        Ok(FeedQuery { after: param("after").map(str::to_owned), limit, wait, types, stubs })
    }
}

/// Why a feed page is not answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedError {
    /// 400 `cursor`: malformed or foreign.
    Cursor,
    /// 410 `cursor-gone`: older than retention.
    Gone,
    /// 503: the chains cannot be read.
    Unavailable,
}

/// 7.3: one held long poll per client and listener; a second is 429 `abuse`.
#[derive(Default)]
pub struct Holds(Mutex<HashSet<String>>);

/// A held long poll, let go when dropped.
pub struct Held<'a> {
    holds: &'a Holds,
    key: String,
}

impl Holds {
    /// The hold of `key` (org and client), None while another request holds it.
    pub fn hold(&self, key: String) -> Option<Held<'_>> {
        let fresh = self.0.lock().insert(key.clone());
        fresh.then(|| Held { holds: self, key })
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.holds.0.lock().remove(&self.key);
    }
}

// ── the console's feed index ──────────────────────────────────────────────────────────────────────────────────

struct Row {
    fseq: u64,
    src: usize,
    seq: u64,
}

/// One org's feed index: rows after `base` (the fseq of the last row dropped by retention).
struct Feed {
    path: Option<PathBuf>,
    base: u64,
    rows: VecDeque<Row>,
    srcs: Vec<String>,
    /// Per `srcs` index: the last seq indexed.
    indexed: Vec<u64>,
}

impl Feed {
    fn load(path: Option<PathBuf>) -> Feed {
        let mut f = Feed { path, base: 0, rows: VecDeque::new(), srcs: Vec::new(), indexed: Vec::new() };
        let text = f.path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        for v in text.lines().filter_map(parse_json) {
            if let Some(b) = v.get("base").and_then(Value::as_u64) {
                f.base = f.base.max(b);
                continue;
            }
            let (Some(fseq), Some(s), Some(seq)) = (v.get("f").and_then(Value::as_u64), v.get("s").and_then(Value::as_str), v.get("q").and_then(Value::as_u64)) else { continue };
            if fseq <= f.last() || !crate::api_audit::source_ok(s) {
                continue;
            }
            let src = f.src(s);
            if seq <= f.indexed[src] {
                continue;
            }
            f.indexed[src] = seq;
            f.rows.push_back(Row { fseq, src, seq });
        }
        // a torn last line (never acknowledged) would run into the next row: the file is written again without it
        if !text.is_empty() && !text.ends_with('\n') {
            f.rewrite();
        }
        f
    }

    /// The highest position handed out (the last row's, or the dropped front's).
    fn last(&self) -> u64 {
        self.rows.back().map_or(self.base, |r| r.fseq.max(self.base))
    }

    /// The file written again: the dropped front, then every row kept.
    fn rewrite(&self) {
        let Some(p) = &self.path else { return };
        let mut text = format!("{}\n", stringify(&json!({"base": self.base})));
        for r in &self.rows {
            text.push_str(&stringify(&json!({"f": r.fseq, "s": self.srcs[r.src], "q": r.seq})));
            text.push('\n');
        }
        let _ = write_durable(p, text.as_bytes());
    }

    fn src(&mut self, s: &str) -> usize {
        match self.srcs.iter().position(|x| x == s) {
            Some(i) => i,
            None => {
                self.srcs.push(s.to_owned());
                self.indexed.push(0);
                self.srcs.len() - 1
            }
        }
    }

    /// Rows for `source`'s seqs after the last indexed through `upto`, written and flushed before they count.
    fn catch_up(&mut self, source: &str, upto: u64) -> Result<(), String> {
        let src = self.src(source);
        let from = self.indexed[src] + 1;
        if upto < from {
            return Ok(());
        }
        let mut next = self.last();
        let mut text = String::new();
        let mut rows = Vec::new();
        for seq in from..=upto {
            next += 1;
            text.push_str(&stringify(&json!({"f": next, "s": source, "q": seq})));
            text.push('\n');
            rows.push(Row { fseq: next, src, seq });
        }
        if let Some(p) = &self.path {
            let mut o = std::fs::OpenOptions::new();
            o.append(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut file = o.open(p).map_err(|e| e.to_string())?;
            file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_data().map_err(|e| e.to_string())?;
        }
        self.indexed[src] = upto;
        self.rows.extend(rows);
        Ok(())
    }

    /// Rows whose entries retention dropped (`kept(source)` the first seq still kept in every form) leave the index,
    /// and `base` moves to the highest of them: a cursor below it may have missed an event (410 `cursor-gone`). The
    /// file is written again without them.
    fn compact(&mut self, kept: &dyn Fn(&str) -> u64) {
        let floors: Vec<u64> = self.srcs.iter().map(|s| kept(s)).collect();
        let before = self.rows.len();
        let mut base = self.base;
        self.rows.retain(|r| {
            let keep = r.seq >= floors[r.src];
            if !keep {
                base = base.max(r.fseq);
            }
            keep
        });
        if self.rows.len() != before {
            self.base = base;
            self.rewrite();
        }
    }
}

// ── the log ───────────────────────────────────────────────────────────────────────────────────────────────────

/// The event chains of one console or relay (`source`), and on the console the feed index of every org.
pub struct EventLog {
    chains: Arc<ApiAudit>,
    root: Option<PathBuf>,
    console: bool,
    feeds: Mutex<HashMap<String, Arc<Mutex<Feed>>>>,
    /// Bumped after every append or ingest; long polls wait on it.
    generation: Mutex<u64>,
    changed: Condvar,
    /// On the console: what its watched events last reported (`api_event_watch`, `watch.json` beside the chains).
    watch: crate::api_event_watch::Watch,
}

impl EventLog {
    /// The event chains under `<state_dir>/api-events` (in memory without a state folder), opened as `ApiAudit`
    /// opens the audit chains, with the same checkpoint and pseudonym keys.
    pub fn open(state_dir: Option<&Path>, source: &str, signer: Arc<dyn CheckpointSigner>, pseudonym: Arc<dyn PseudonymKeys>, now: i64) -> EventLog {
        EventLog::over(Arc::new(ApiAudit::open_events(state_dir, source, signer, pseudonym, now)), state_dir)
    }

    fn over(chains: Arc<ApiAudit>, state_dir: Option<&Path>) -> EventLog {
        let console = chains.source() == "console";
        let root = state_dir.map(|d| d.join(EVENTS_DIR));
        let watch = crate::api_event_watch::Watch::load(root.as_ref().map(|r| r.join(crate::api_event_watch::WATCH_FILE)));
        EventLog { chains, root, console, feeds: Mutex::new(HashMap::new()), generation: Mutex::new(0), changed: Condvar::new(), watch }
    }

    /// The console's record of its watched events (`api_event_watch`).
    pub fn watch(&self) -> &crate::api_event_watch::Watch {
        &self.watch
    }

    /// The chains themselves (shipping with `api-events`, backfill with `api-event-chains`).
    pub fn chains(&self) -> &Arc<ApiAudit> {
        &self.chains
    }

    fn bump(&self) {
        *self.generation.lock() += 1;
        self.changed.notify_all();
    }

    /// The org's feed index (console), loaded on first use and brought up to every chain already stored (a crash
    /// between an append and its index row).
    fn feed(&self, org: &str) -> Option<Arc<Mutex<Feed>>> {
        if !self.console || !crate::api_audit::org_ok(org) {
            return None;
        }
        let mut all = self.feeds.lock();
        if let Some(f) = all.get(org) {
            return Some(f.clone());
        }
        let dir = self.root.as_ref().map(|r| r.join(org));
        if let Some(d) = &dir {
            let _ = crate::store::make_dir(d);
        }
        let mut f = Feed::load(dir.as_ref().map(|d| d.join(FEED_FILE)));
        let sources: Vec<String> = dir
            .as_ref()
            .and_then(|d| std::fs::read_dir(d).ok())
            .map(|r| r.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|s| crate::api_audit::source_ok(s)).collect())
            .unwrap_or_default();
        for s in sources {
            let _ = f.catch_up(&s, self.stored(org, &s));
        }
        f.compact(&|s: &str| self.kept(org, s));
        let f = Arc::new(Mutex::new(f));
        all.insert(org.to_owned(), f.clone());
        Some(f)
    }

    /// The last seq of `source` stored in all three forms.
    fn stored(&self, org: &str, source: &str) -> u64 {
        Repr::ALL.iter().map(|r| self.chains.head(org, source, *r).0).min().unwrap_or(0)
    }

    /// The first seq of `source` kept in every form.
    fn kept(&self, org: &str, source: &str) -> u64 {
        Repr::ALL.iter().map(|r| self.chains.first_kept(org, source, *r)).max().unwrap_or(1)
    }

    /// 7.1: append one event of this source to the org's chains (in all three forms, durable before Ok, its seq) and,
    /// on the console, to the feed index; long polls wake. `kind` is a registry name and `data` its fields.
    pub fn emit(&self, org: &str, kind: &str, data: Value, now: i64) -> Result<u64, AuditError> {
        let fields = check_emit(self.chains.source(), kind, &data)?;
        let feed = self.feed(org);
        let mut guard = feed.as_ref().map(|f| f.lock());
        let seq = self.chains.append_event(org, &fields, now)?;
        crate::api_catalog::counters::event(org, kind);
        if let Some(f) = guard.as_mut() {
            // a row that cannot be written now is written with the next one (`catch_up` starts after the last indexed)
            let _ = f.catch_up("console", seq);
        }
        drop(guard);
        self.bump();
        Ok(seq)
    }

    /// `api-events` on the console (2.5): a page of a relay's event chain for the org in one form, stored once every
    /// link verifies (as `ApiAudit::ingest`); entries stored in all three forms join the feed index.
    pub fn ingest(&self, org: &str, relay: &str, repr: Repr, first: u64, last: u64, entries: &[Value]) -> Result<(), IngestError> {
        let feed = self.feed(org).ok_or_else(|| IngestError::Invalid("only the console takes relay event chains".into()))?;
        let mut f = feed.lock();
        self.chains.ingest(org, relay, repr, first, last, entries)?;
        let upto = self.stored(org, relay);
        f.catch_up(relay, upto).map_err(IngestError::Unavailable)?;
        drop(f);
        self.bump();
        Ok(())
    }

    /// The head (seq, hash) of the org's `source` chain in one form.
    pub fn head(&self, org: &str, source: &str, repr: Repr) -> (u64, String) {
        self.chains.head(org, source, repr)
    }

    /// 7.3 `v1/events/keys`: the checkpoint certificates (the same as `v1/audit/keys`).
    pub fn keys(&self, org: &str) -> Vec<Value> {
        self.chains.keys(org)
    }

    /// 7.3 `v1/events/types`: the registry's event entries the viewer may see.
    pub fn types(viewer: &Viewer) -> Vec<Value> {
        let records = catalog().json().get("records").and_then(Value::as_array).cloned().unwrap_or_default();
        records
            .into_iter()
            .filter(|r| r.get("kind").and_then(Value::as_str) == Some("event"))
            .filter(|r| r.get("name").and_then(Value::as_str).and_then(|n| catalog().event(n)).is_some_and(|et| viewer.type_ok(et)))
            .collect()
    }

    /// 7.3 `GET .../v1/events`: one page in feed order (I: the org's feed index; RR: this relay's own chain), events
    /// the viewer may see as CloudEvents and the rest as stubs (unless `stubs=false`), `next` always present. With
    /// `wait` above 0 and nothing to answer, the request is held up to `wait` seconds and answered as soon as an
    /// append or ingest gives it something.
    pub fn page(&self, org: &str, q: &FeedQuery, viewer: &Viewer) -> Result<Value, FeedError> {
        let deadline = Instant::now() + Duration::from_secs(q.wait.min(WAIT_MAX));
        loop {
            let seen = *self.generation.lock();
            let (events, next) = self.page_once(org, q, viewer)?;
            if !events.is_empty() || q.wait == 0 || Instant::now() >= deadline {
                let scope = if self.console { "console" } else { self.chains.source() };
                return Ok(json!({"events": events, "next": cursor(org, scope, next), "repr": viewer.repr.as_str()}));
            }
            let mut g = self.generation.lock();
            while *g == seen {
                if self.changed.wait_until(&mut g, deadline).timed_out() {
                    break;
                }
            }
        }
    }

    /// One page without waiting: the items and the position `next` names.
    fn page_once(&self, org: &str, q: &FeedQuery, viewer: &Viewer) -> Result<(Vec<Value>, u64), FeedError> {
        let scan = if q.stubs { q.limit } else { (q.limit * 20).min(SCAN_MAX) };
        let mut out = Vec::new();
        if self.console {
            let feed = self.feed(org).ok_or(FeedError::Unavailable)?;
            // the rows to read, taken under the lock; the chains are read after it
            let (rows, base) = {
                let f = feed.lock();
                // no cursor: from the oldest row kept
                let after = match &q.after {
                    None => f.rows.front().map_or(f.base, |r| r.fseq - 1),
                    Some(c) => {
                        let after = parse_cursor(c, org, "console").ok_or(FeedError::Cursor)?;
                        if after > f.last() {
                            return Err(FeedError::Cursor);
                        }
                        if after < f.base {
                            return Err(FeedError::Gone);
                        }
                        after
                    }
                };
                let at = f.rows.partition_point(|r| r.fseq <= after);
                let rows: Vec<(u64, String, u64)> = f.rows.iter().skip(at).take(scan).map(|r| (r.fseq, f.srcs[r.src].clone(), r.seq)).collect();
                (rows, after)
            };
            // each source's run read at once
            let mut got: HashMap<(String, u64), Map<String, Value>> = HashMap::new();
            let mut runs: HashMap<&str, (u64, u64)> = HashMap::new();
            for (_, s, seq) in &rows {
                let e = runs.entry(s.as_str()).or_insert((*seq, *seq));
                e.0 = e.0.min(*seq);
                e.1 = e.1.max(*seq);
            }
            for (s, (lo, hi)) in runs {
                for v in self.chains.range(org, s, viewer.repr, lo - 1, (hi - lo + 1) as usize) {
                    if let (Some(seq), Value::Object(m)) = (v.get("seq").and_then(Value::as_u64), v) {
                        got.insert((s.to_owned(), seq), m);
                    }
                }
            }
            let mut next = base;
            for (fseq, s, seq) in rows {
                let Some(e) = got.get(&(s.clone(), seq)) else {
                    if seq < self.kept(org, &s) {
                        return Err(FeedError::Gone);
                    }
                    break;
                };
                if let Some(item) = item(org, &s, e, viewer, q.stubs) {
                    out.push(item);
                }
                next = fseq;
                if out.len() >= q.limit {
                    break;
                }
            }
            Ok((out, next))
        } else {
            let me = self.chains.source().to_owned();
            let (head, _) = self.chains.head(org, &me, viewer.repr);
            let kept = self.kept(org, &me);
            let after = match &q.after {
                None => kept - 1,
                Some(c) => parse_cursor(c, org, &me).ok_or(FeedError::Cursor)?,
            };
            if after > head {
                return Err(FeedError::Cursor);
            }
            if after + 1 < kept {
                return Err(FeedError::Gone);
            }
            let mut next = after;
            for v in self.chains.range(org, &me, viewer.repr, after, scan) {
                let (Some(seq), Some(e)) = (v.get("seq").and_then(Value::as_u64), v.as_object()) else { continue };
                if let Some(item) = item(org, &me, e, viewer, q.stubs) {
                    out.push(item);
                }
                next = seq;
                if out.len() >= q.limit {
                    break;
                }
            }
            Ok((out, next))
        }
    }

    /// Every 10 s: the chains' checkpoints and retention; on the console the checkpoints join the feed index and the
    /// rows retention left behind leave it. Long polls wake (a relay's checkpoint is in its own feed at once).
    pub fn tick(&self, now: i64) {
        self.chains.tick(now);
        if self.console {
            for org in self.chains.orgs() {
                if let Some(f) = self.feed(&org) {
                    let upto = self.stored(&org, "console");
                    let _ = f.lock().catch_up("console", upto);
                }
            }
            let feeds: Vec<(String, Arc<Mutex<Feed>>)> = self.feeds.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (org, f) in feeds {
                f.lock().compact(&|s: &str| self.kept(&org, s));
            }
        }
        self.bump();
    }

    /// Notes for the security log (as `ApiAudit::take_notes`).
    pub fn take_notes(&self) -> Vec<String> {
        self.chains.take_notes()
    }

    /// 7.4: event ranges deleted before every destination could read them (the webhook slice counts and audits them).
    pub fn take_dropped(&self) -> Vec<Dropped> {
        self.chains.take_dropped()
    }
}

/// The CloudEvent the viewer may see, its stub, or nothing (`stubs=false`).
fn item(org: &str, source: &str, e: &Map<String, Value>, viewer: &Viewer, stubs: bool) -> Option<Value> {
    if viewer.sees(source, e) {
        if let Some(ce) = cloud_event(org, source, viewer.repr, e) {
            return Some(ce);
        }
    }
    stubs.then(|| stub(org, source, viewer.repr, e))
}

/// `EventLog::tick` every 10 s on its own thread, for the life of the process, whenever `events` yields the log.
pub fn spawn_ticker(name: &str, events: Box<dyn Fn() -> Option<Arc<EventLog>> + Send>, note: Box<dyn Fn(&str) + Send>) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || loop {
            std::thread::sleep(crate::api_resource::TICK_EVERY);
            if let Some(e) = events() {
                e.tick(crate::meet_json::now() as i64);
                for n in e.take_notes() {
                    note(&n);
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::chain_hash;
    use crate::fleet_ca::tests_dir;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING};

    const NOW: i64 = 1_795_000_020;
    const KEY: [u8; 32] = [7u8; 32];
    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    struct Signer(EcdsaKeyPair);

    impl CheckpointSigner for Signer {
        fn kid(&self, _: &str) -> Option<String> {
            Some("cp-test".into())
        }
        fn sign(&self, _: &str, payload: &[u8]) -> Option<Vec<u8>> {
            self.0.sign(&SystemRandom::new(), payload).ok().map(|s| s.as_ref().to_vec())
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

    struct Fixed(Option<(u32, Vec<u8>)>);

    impl PseudonymKeys for Fixed {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            self.0.clone()
        }
    }

    fn console(dir: &Path) -> EventLog {
        EventLog::open(Some(dir), "console", Arc::new(NoSigner), Arc::new(Fixed(Some((1, KEY.to_vec())))), NOW)
    }

    fn all_scopes() -> Vec<String> {
        crate::api_map::MAP_SCOPES.iter().map(|(s, _, _)| s.to_string()).collect()
    }

    fn query(q: &str) -> FeedQuery {
        FeedQuery::parse(q).unwrap()
    }

    /// Unix seconds of `YYYY-MM-DDTHH:MM:SSZ`.
    fn unix_of(t: &str) -> Option<i64> {
        let b = t.as_bytes();
        if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
            return None;
        }
        let n = |r: std::ops::Range<usize>| t.get(r).filter(|s| s.bytes().all(|c| c.is_ascii_digit())).and_then(|s| s.parse::<i64>().ok());
        let (y, m, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
            return None;
        }
        // Howard Hinnant's days_from_civil
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + s)
    }

    /// 7.2: the chain record a CloudEvent carries, rebuilt as a subscriber does to check `lucidhash` (with `hash`).
    fn chain_record(ce: &Value) -> Option<Map<String, Value>> {
        let org = ce.get("lucidorg")?.as_str()?;
        let source = ce.get("source")?.as_str()?.strip_prefix(&format!("/api/orgs/{org}/"))?;
        let mut r = Map::new();
        r.insert("seq".into(), json!(ce.get("lucidseq")?.as_u64()?));
        r.insert("ts".into(), json!(unix_of(ce.get("time")?.as_str()?)?));
        r.insert("org".into(), json!(org));
        match source {
            "console" => {}
            s => {
                r.insert("relay".into(), json!(s.strip_prefix("relays/")?));
            }
        }
        r.insert("type".into(), json!(ce.get("type")?.as_str()?.strip_prefix(TYPE_PREFIX)?));
        if let Some(d) = ce.get("data") {
            r.insert("data".into(), d.clone());
        }
        if let Some(p) = ce.get("lucidpkv") {
            r.insert("pkv".into(), p.clone());
        }
        r.insert("prev".into(), ce.get("lucidprev")?.clone());
        r.insert("hash".into(), ce.get("lucidhash")?.clone());
        Some(r)
    }

    /// Every CloudEvent and stub of a page, checked as one chain per `lucidchain` from 64 zeros.
    fn verify_page(events: &[Value]) {
        let mut heads: HashMap<String, (u64, String)> = HashMap::new();
        for ev in events {
            let chain = ev["lucidchain"].as_str().unwrap().to_owned();
            let (label, _) = chain.rsplit_once('/').unwrap();
            let (seq, prev) = heads.get(&chain).cloned().unwrap_or((0, ZERO.to_owned()));
            assert_eq!(ev["lucidseq"].as_u64(), Some(seq + 1), "continuous seqs in {chain}");
            assert_eq!(ev["lucidprev"].as_str(), Some(prev.as_str()), "linked in {chain}");
            if ev.get("stub").is_none() {
                let r = chain_record(ev).expect("the record rebuilds");
                assert_eq!(chain_hash(label, &prev, &r).as_deref(), ev["lucidhash"].as_str(), "the hash of {ev}");
            }
            heads.insert(chain, (seq + 1, ev["lucidhash"].as_str().unwrap().to_owned()));
        }
    }

    #[test]
    fn emits_are_checked_against_the_registry() {
        assert!(check_emit("console", "api.disabled", &Value::Null).is_ok());
        assert!(check_emit("console", "relay.connected", &json!({"relay": "r_01", "version": "0.99.0"})).is_ok());
        assert_eq!(check_emit("console", "nothing.happened", &Value::Null).unwrap_err().code, "bad-request");
        assert!(check_emit("console", "checkpoint", &Value::Null).is_err(), "only the chains write checkpoints");
        assert!(check_emit("console", "meeting.started", &json!({"room": "m-1"})).is_err(), "a relay type");
        assert!(check_emit("r_01", "meeting.started", &json!({"room": "m-1", "organizer": "ann@acme.example"})).is_ok());
        assert!(check_emit("console", "relay.connected", &json!({"relay": "r_01", "secret": "x"})).is_err(), "a field outside the registry");
        assert!(check_emit("console", "client.suspended", &json!({"client": 5})).is_err(), "an identity is a string");
        assert!(check_emit("console", "relay.connected", &json!({"relay": null})).is_err(), "no null");
        assert!(check_emit("console", "test.ping", &json!({"destination": "x".repeat(EVENT_MAX)})).is_err(), "over 16 KiB");
        // r5 7.6: a connector-only content type is no event type of these chains, feeds or webhooks
        for kind in ["message.created", "conversation.removed"] {
            assert_eq!(check_emit("console", kind, &json!({"conv": "ch:0123456789abcdef"})).unwrap_err().code, "bad-request", "{kind}");
            assert!(check_emit("r_01", kind, &Value::Null).is_err(), "{kind}");
            assert!(FeedQuery::parse(&format!("types={kind}")).is_err(), "{kind}");
        }
    }

    #[test]
    fn the_three_forms_drop_titles_and_identities() {
        let f = check_emit("r_01", "meeting.started", &json!({"room": "m-1", "title": "Weekly ops", "organizer": "ann@acme.example"})).unwrap();
        let key = (3, KEY.to_vec());
        let p = derive(&f, Repr::Pseudonymized, Some(&key));
        assert_eq!(p["data"]["organizer"], json!(crate::api_audit::pseudonym(&KEY, "ann@acme.example")));
        assert!(p["data"].get("title").is_none(), "R4-11: no title in a transformed form");
        assert_eq!(p["pkv"], 3);
        let r = derive(&f, Repr::Removed, Some(&key));
        assert_eq!(r["data"], json!({"room": "m-1"}));
        assert!(r.get("pkv").is_none());
        let nokey = derive(&f, Repr::Pseudonymized, None);
        assert_eq!((nokey["data"].clone(), nokey["pkv"].clone()), (json!({"room": "m-1"}), json!(0)));
        let (a, ps, rm) = (Repr::AsIs, Repr::Pseudonymized, Repr::Removed);
        assert!(same_event(&f, &p, (a, ps), Some(&key)) && same_event(&p, &f, (ps, a), Some(&key)) && same_event(&p, &r, (ps, rm), Some(&key)));
        let mut forged = p.clone();
        forged["data"]["organizer"] = json!(crate::api_audit::pseudonym(&KEY, "bo@acme.example"));
        assert!(!same_event(&f, &forged, (a, ps), Some(&key)));
    }

    #[test]
    fn a_keyed_pseudonymized_form_keeps_every_identity_of_the_as_is_form() {
        let f = check_emit("r_01", "meeting.started", &json!({"room": "m-1", "organizer": "ann@acme.example"})).unwrap();
        let key = (3, KEY.to_vec());
        let (a, ps) = (Repr::AsIs, Repr::Pseudonymized);
        let p = derive(&f, ps, Some(&key));
        // an omitted identity is not the same event when the key is held
        let mut omitted = p.clone();
        omitted["data"].as_object_mut().unwrap().remove("organizer");
        assert!(!same_event(&f, &omitted, (a, ps), Some(&key)));
        assert!(!same_event(&omitted, &f, (ps, a), Some(&key)));
        // an extra identity the as is form lacks is not either
        let bare = check_emit("r_01", "meeting.started", &json!({"room": "m-1"})).unwrap();
        assert!(!same_event(&bare, &p, (a, ps), Some(&key)));
        // a value that is not the expected pseudonym fails
        let mut swapped = p.clone();
        swapped["data"]["organizer"] = json!("p_0000000000000000");
        assert!(!same_event(&f, &swapped, (a, ps), Some(&key)));
        // without the key version the pseudonyms cannot be checked
        assert!(same_event(&f, &omitted, (a, ps), Some(&(4, KEY.to_vec()))));
        assert!(same_event(&f, &omitted, (a, ps), None));
    }

    #[test]
    fn a_cloud_event_carries_its_chain_record_losslessly() {
        let dir = tests_dir("api-events-ce");
        let log = console(&dir);
        log.emit("acme", "relay.connected", json!({"relay": "r_01", "version": "0.99.0"}), NOW).unwrap();
        log.emit("acme", "api.disabled", Value::Null, NOW + 1).unwrap();
        let entries = log.chains().range("acme", "console", Repr::AsIs, 0, 10);
        let ce = cloud_event("acme", "console", Repr::AsIs, entries[0].as_object().unwrap()).unwrap();
        assert_eq!(ce["id"], "lucid-api-events-as-is-v1:acme/console:1");
        assert_eq!(ce["source"], "/api/orgs/acme/console");
        assert_eq!(ce["type"], "com.emertins.lucid.relay.connected");
        assert_eq!(ce["subject"], "r_01");
        assert_eq!(ce["time"], time_of(NOW));
        assert_eq!(unix_of(ce["time"].as_str().unwrap()), Some(NOW));
        assert_eq!(ce["dataschema"], "https://lucid.emertins.com/schemas/events/relay.connected/1");
        assert_eq!(&Value::Object(chain_record(&ce).unwrap()), &entries[0]);
        let empty = cloud_event("acme", "console", Repr::AsIs, entries[1].as_object().unwrap()).unwrap();
        assert!(empty.get("data").is_none() && empty.get("subject").is_none(), "no data, no null");
        assert!(!stringify(&empty).contains("null"));
    }

    #[test]
    fn the_feed_filters_with_stubs_and_its_chain_verifies() {
        let dir = tests_dir("api-events-feed");
        let log = console(&dir);
        log.emit("acme", "relay.connected", json!({"relay": "r_01", "version": "1"}), NOW).unwrap();
        log.emit("acme", "client.suspended", json!({"client": "c_0a1b2c3d4e5f6071", "reason": "client_suspend"}), NOW).unwrap();
        log.emit("acme", "api.disabled", Value::Null, NOW).unwrap();
        let scopes = vec!["events.subscribe".to_string(), "fleet.read".to_string()];
        let reaches = |_: &str| true;
        let v = Viewer { scopes: &scopes, reaches: &reaches, ceiling: Ceiling::Internal, repr: Repr::Pseudonymized, types: None };
        let page = log.page("acme", &query(""), &v).unwrap();
        let events = page["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "com.emertins.lucid.relay.connected");
        assert_eq!((events[1]["stub"].as_bool(), events[2]["stub"].as_bool()), (Some(true), Some(true)), "audit.read types the client lacks");
        assert!(events[1].get("data").is_none() && events[1].get("type").is_none());
        assert_eq!(page["repr"], "pseudonymized");
        verify_page(events);
        // without stubs, and with a types filter
        let page = log.page("acme", &query("stubs=false"), &v).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        let v2 = Viewer { types: Some(vec!["api.disabled".into()]), ..v };
        assert!(log.page("acme", &query("stubs=false"), &v2).unwrap()["events"].as_array().unwrap().is_empty());
        // `next` is present on an empty page, and a cursor pages on
        let first = log.page("acme", &query("limit=1"), &v2).unwrap();
        let next = first["next"].as_str().unwrap().to_owned();
        let rest = log.page("acme", &query(&format!("after={next}")), &v2).unwrap();
        assert_eq!(rest["events"].as_array().unwrap().len(), 2);
        let end = rest["next"].as_str().unwrap().to_owned();
        let empty = log.page("acme", &query(&format!("after={end}")), &v2).unwrap();
        assert_eq!((empty["events"].as_array().unwrap().len(), empty["next"].as_str()), (0, Some(end.as_str())));
        // malformed and foreign cursors
        assert_eq!(log.page("acme", &query("after=nope"), &v2).unwrap_err(), FeedError::Cursor);
        assert_eq!(log.page("acme", &query(&format!("after={}", cursor("beta", "console", 1))), &v2).unwrap_err(), FeedError::Cursor);
        assert_eq!(log.page("acme", &query(&format!("after={}", cursor("acme", "console", 99))), &v2).unwrap_err(), FeedError::Cursor);
    }

    #[test]
    fn an_internal_client_never_reads_a_meeting_title_or_an_identity() {
        let dir = tests_dir("api-events-console-relay");
        let log = console(&dir);
        // a relay's chain arrives through `api-events`
        let relay = EventLog::open(Some(&dir.join("relay")), "r_01", Arc::new(NoSigner), Arc::new(Fixed(Some((1, KEY.to_vec())))), NOW);
        relay.emit("acme", "meeting.started", json!({"room": "m-1", "title": "Canary title", "organizer": "ann@acme.example"}), NOW).unwrap();
        relay.emit("acme", "member.joined", json!({"room": "m-1", "principal": "ann@acme.example", "role": "host"}), NOW).unwrap();
        let scopes = all_scopes();
        let any = |_: &str| true;
        let only_r02 = |r: &str| r == "r_02";
        let cui = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Cui, repr: Repr::AsIs, types: None };
        for repr in Repr::ALL {
            let entries = relay.chains().since("acme", repr, 0, 10);
            assert_eq!(log.page("acme", &query(""), &cui).unwrap()["events"].as_array().unwrap().len(), 0, "indexed only once all three forms are stored");
            log.ingest("acme", "r_01", repr, 1, entries.len() as u64, &entries).unwrap();
        }
        let internal = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Internal, repr: Repr::Pseudonymized, types: None };
        let page = log.page("acme", &query(""), &internal).unwrap();
        let text = stringify(&page);
        assert!(!text.contains("Canary title") && !text.contains("ann@acme.example"), "{text}");
        assert_eq!(page["events"][0]["source"], "/api/orgs/acme/relays/r_01");
        assert_eq!(page["events"][0]["lucidpkv"], 1);
        verify_page(page["events"].as_array().unwrap());
        let confidential = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Confidential, repr: Repr::AsIs, types: None };
        assert!(stringify(&log.page("acme", &query(""), &confidential).unwrap()).contains("Canary title"));
        // a client that does not reach r_01 gets stubs only
        let other = Viewer { scopes: &scopes, reaches: &only_r02, ceiling: Ceiling::Confidential, repr: Repr::AsIs, types: None };
        assert!(log.page("acme", &query(""), &other).unwrap()["events"].as_array().unwrap().iter().all(|e| e["stub"] == true));
        // the relay's own feed (RR) pages its chain by seq
        let rr = relay.page("acme", &query("limit=1"), &confidential).unwrap();
        assert_eq!(rr["events"][0]["lucidseq"], 1);
        let rest = relay.page("acme", &query(&format!("after={}", rr["next"].as_str().unwrap())), &confidential).unwrap();
        assert_eq!(rest["events"][0]["type"], "com.emertins.lucid.member.joined");
        // a changed relay entry is refused
        relay.emit("acme", "member.left", json!({"room": "m-1", "principal": "ann@acme.example", "role": "host"}), NOW + 1).unwrap();
        let mut forged = relay.chains().since("acme", Repr::AsIs, 2, 1);
        forged[0]["data"]["role"] = json!("guest");
        assert!(matches!(log.ingest("acme", "r_01", Repr::AsIs, 3, 3, &forged), Err(IngestError::Invalid(_))));
        // the index survives a restart and new rows follow it
        drop(log);
        let again = console(&dir);
        assert_eq!(again.page("acme", &query(""), &confidential).unwrap()["events"].as_array().unwrap().len(), 2);
        again.emit("acme", "api.enabled", Value::Null, NOW + 5).unwrap();
        let page = again.page("acme", &query(""), &confidential).unwrap();
        assert_eq!(page["events"][2]["type"], "com.emertins.lucid.api.enabled");
    }

    #[test]
    fn a_checkpoint_event_verifies_with_the_keys() {
        let dir = tests_dir("api-events-checkpoint");
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
        let public = pair.public_key().as_ref().to_vec();
        let log = EventLog::open(Some(&dir), "console", Arc::new(Signer(pair)), Arc::new(Fixed(Some((1, KEY.to_vec())))), NOW);
        log.emit("acme", "test.ping", json!({"destination": "d_3d4e5f6071829304"}), NOW).unwrap();
        log.tick(NOW + crate::api_audit::CHECKPOINT_SECS);
        let scopes = vec!["events.subscribe".to_string()];
        let any = |_: &str| true;
        let v = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Internal, repr: Repr::Pseudonymized, types: None };
        let page = log.page("acme", &query(""), &v).unwrap();
        let events = page["events"].as_array().unwrap();
        verify_page(events);
        let cp = &events[1];
        assert_eq!(cp["type"], "com.emertins.lucid.checkpoint");
        let payload = unb64u(cp["data"]["payload"].as_str().unwrap()).unwrap();
        let sig = unb64u(cp["data"]["sig"].as_str().unwrap()).unwrap();
        let signed = crate::meet_org_policy::lp(&[CHECKPOINT_LABEL.as_bytes(), &payload]);
        assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public).verify(&signed, &sig).is_ok());
        let p: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(p["heads"]["pseudonymized"][1], events[0]["lucidhash"], "the checkpoint names the head before it");
    }

    #[test]
    fn a_long_poll_answers_within_a_second_of_a_new_event() {
        let dir = tests_dir("api-events-wait");
        let log = Arc::new(console(&dir));
        let scopes = vec!["events.subscribe".to_string()];
        let other = log.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            other.emit("acme", "test.ping", json!({"destination": "d_1"}), NOW).unwrap();
        });
        let start = Instant::now();
        let any = |_: &str| true;
        let v = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Internal, repr: Repr::Pseudonymized, types: None };
        let page = log.page("acme", &query("wait=5"), &v).unwrap();
        t.join().unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        assert!(start.elapsed() < Duration::from_millis(1300), "{:?}", start.elapsed());
        // nothing new: held for `wait`, then an empty page with next
        let start = Instant::now();
        let page = log.page("acme", &query(&format!("wait=1&after={}", page["next"].as_str().unwrap())), &v).unwrap();
        assert!(start.elapsed() >= Duration::from_secs(1));
        assert!(page["events"].as_array().unwrap().is_empty() && page["next"].is_string());
        // one held request per client and listener
        let holds = Holds::default();
        let held = holds.hold("acme c_1".into());
        assert!(held.is_some() && holds.hold("acme c_1".into()).is_none());
        drop(held);
        assert!(holds.hold("acme c_1".into()).is_some());
        assert!(FeedQuery::parse("wait=26").is_err() && FeedQuery::parse("limit=0").is_err() && FeedQuery::parse("types=nothing").is_err());
    }

    #[test]
    fn retention_is_a_hard_35_days_and_old_cursors_are_gone() {
        let dir = tests_dir("api-events-retention");
        let chains = Arc::new(ApiAudit::open_events_with(Some(&dir), "console", Arc::new(NoSigner), Arc::new(Fixed(Some((1, KEY.to_vec())))), NOW, 300));
        let log = EventLog::over(chains, Some(&dir));
        for i in 0..6 {
            log.emit("acme", "test.ping", json!({"destination": format!("d_{i}")}), NOW + i).unwrap();
        }
        let scopes = vec!["events.subscribe".to_string()];
        let any = |_: &str| true;
        let v = Viewer { scopes: &scopes, reaches: &any, ceiling: Ceiling::Internal, repr: Repr::AsIs, types: None };
        let start = cursor("acme", "console", 0);
        assert_eq!(log.page("acme", &query(&format!("after={start}")), &v).unwrap()["events"].as_array().unwrap().len(), 6);
        log.tick(NOW + RETENTION_SECS + 10);
        assert_eq!(log.page("acme", &query(&format!("after={start}")), &v).unwrap_err(), FeedError::Gone);
        let dropped = log.take_dropped();
        assert!(dropped.iter().any(|d| d.reason == "retention" && d.first == 1), "{dropped:?}");
        // the feed starts at the oldest event kept
        let page = log.page("acme", &query(""), &v).unwrap();
        let first = page["events"][0]["lucidseq"].as_u64().unwrap();
        assert!(first > 1 && first <= 6);
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Contract 20 (`make_api_events_v1.py`): every registry type in the three forms with its exact hashing input,
    /// its CloudEvent both ways, each chain's checkpoint signed by the checkpoint key, and filtered pages with stubs.
    #[test]
    fn the_event_vectors_agree() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/api_events_v1.json");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e} (run tests/vectors/make_api_events_v1.py in the Meeting Hub and copy it here)"));
        let v: Value = serde_json::from_str(&text).unwrap();
        let org = v["org"].as_str().unwrap();
        let key = (v["key"]["pkv"].as_u64().unwrap() as u32, unhex(v["key"]["hex"].as_str().unwrap()));
        let mut point = vec![4u8];
        point.extend(unhex(v["checkpoint_key"]["x"].as_str().unwrap()));
        point.extend(unhex(v["checkpoint_key"]["y"].as_str().unwrap()));
        assert_eq!(v["checkpoint_label"], CHECKPOINT_LABEL);
        let mut records: HashMap<(String, Repr, u64), Map<String, Value>> = HashMap::new();
        for chain in v["chains"].as_array().unwrap() {
            let source = chain["source"].as_str().unwrap();
            let emits = chain["emits"].as_array().unwrap();
            for repr in Repr::ALL {
                let mut prev = ZERO.to_owned();
                for (i, item) in chain["reprs"][repr.as_str()].as_array().unwrap().iter().enumerate() {
                    let rec = item["record"].as_object().unwrap();
                    let what = format!("{source} {} {}", repr.as_str(), i + 1);
                    match emits.get(i) {
                        Some(em) => {
                            let f = check_emit(source, em["type"].as_str().unwrap(), &em["data"]).unwrap_or_else(|e| panic!("{what}: {e}"));
                            let mut got = rec.clone();
                            for k in ["seq", "ts", "org", "prev", "hash"] {
                                got.remove(k);
                            }
                            assert_eq!(got, derive(&f, repr, Some(&key)), "{what}");
                            assert_eq!(rec["ts"], em["ts"], "{what}");
                        }
                        None => {
                            // the checkpoint over the heads before it
                            let d = &rec["data"];
                            let payload = unb64u(d["payload"].as_str().unwrap()).unwrap();
                            let sig = unb64u(d["sig"].as_str().unwrap()).unwrap();
                            let signed = crate::meet_org_policy::lp(&[CHECKPOINT_LABEL.as_bytes(), payload.as_slice()]);
                            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).verify(&signed, &sig).is_ok(), "{what}");
                            let p: Value = serde_json::from_slice(&payload).unwrap();
                            assert_eq!(p["heads"][repr.as_str()], json!([i, prev]), "{what}");
                            assert_eq!((p["org"].as_str(), p["source"].as_str()), (Some(org), Some(source)));
                        }
                    }
                    let lab = label(repr, org);
                    assert_eq!(item["label"], json!(lab));
                    let mut body = rec.clone();
                    body.remove("hash");
                    let canon = crate::console_audit::canonical_json(&Value::Object(body)).unwrap();
                    let input = crate::meet_org_policy::lp(&[lab.as_bytes(), unhex(&prev).as_slice(), canon.as_slice()]);
                    assert_eq!(json!(crate::codec::hex(&input)), item["input_hex"], "{what}");
                    assert_eq!(chain_hash(&lab, &prev, rec).as_deref(), rec["hash"].as_str(), "{what}");
                    assert_eq!(cloud_event(org, source, repr, rec).as_ref(), Some(&item["cloud_event"]), "{what}");
                    assert_eq!(chain_record(&item["cloud_event"]).as_ref(), Some(rec), "{what}");
                    prev = rec["hash"].as_str().unwrap().to_owned();
                    records.insert((source.to_owned(), repr, i as u64 + 1), rec.clone());
                }
            }
        }
        for f in v["feeds"].as_array().unwrap() {
            let w = &f["viewer"];
            let words = |k: &str| w[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<String>>());
            let (scopes, relays) = (words("scopes").unwrap(), words("relays").unwrap());
            let reaches = |r: &str| relays.iter().any(|x| x == "*" || x == r);
            let viewer = Viewer {
                scopes: &scopes,
                reaches: &reaches,
                ceiling: Ceiling::of(w["ceiling"].as_str().unwrap()).unwrap(),
                repr: Repr::of(w["repr"].as_str().unwrap()).unwrap(),
                types: words("types"),
            };
            let stubs = w["stubs"].as_bool().unwrap();
            let got: Vec<Value> = f["rows"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|r| {
                    let (s, seq) = (r[0].as_str().unwrap(), r[1].as_u64().unwrap());
                    item(org, s, &records[&(s.to_owned(), viewer.repr, seq)], &viewer, stubs)
                })
                .collect();
            assert_eq!(Value::Array(got), f["events"], "{w}");
        }
    }
}
