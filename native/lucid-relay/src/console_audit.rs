// The Admin Console's audit log (contract AC-1 section 6): hash-chained JSONL segments in the state folder
// (`console-audit-<6 digits>.jsonl`, owner-only, a new segment at 8 MiB, the newest 64 kept), a head file written after
// each append (`console-audit-head.json`), the dropped front recorded when the oldest segment goes, and a broken
// chain at start (a torn tail or a broken middle line) moved aside to `console-audit-torn-<ts>.jsonl` with the
// verified prefix kept. The relay never refuses to start because of the audit.
//
// Chain: hash = SHA-256(lp("lucid-console-audit-v1", prev as 32 raw bytes, canonical_json(entry without "hash"))),
// canonical_json being CE-1 with null allowed; the first entry ever has a prev of 64 zeros.
//
// Refusal summaries (M12, N5): a signed-in person's POST refusals get entries of their own up to 60 a minute; past
// that, and their GET refusals, one `refusals.summary` per person per minute. Refusals with no session never get an
// entry of their own: at most one global `refusals.summary` a minute with the number of distinct source keys.

use crate::codec::{hex, parse_json, sha256, sha256_hex, stringify};
use crate::meet_org_policy::lp;
use crate::store::{make_dir, read_text, write_private};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const LABEL: &str = "lucid-console-audit-v1";
pub const SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
pub const SEGMENTS_KEPT: usize = 64;
pub const HEAD_FILE: &str = "console-audit-head.json";
pub const EXPORT_MAX: u64 = 100_000;
/// Own refusal entries per person per minute; past it, the person's summary.
pub const PERSON_REFUSALS_PER_MINUTE: u64 = 60;
const MAX_SAFE: u64 = (1 << 53) - 1;
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The keys of an entry, in the order it is written.
pub const ENTRY_KEYS: [&str; 13] = ["seq", "ts", "actor", "role", "ip", "action", "target", "result", "approval", "stepup", "detail", "prev", "hash"];

// ── CE-1 canonical JSON, null allowed ──────────────────────────────────────────────────────────────────────

fn enc_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn enc(v: &Value, out: &mut String) -> Result<(), String> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > MAX_SAFE {
                    return Err("an integer outside 2^53 - 1".into());
                }
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                if u > MAX_SAFE {
                    return Err("an integer outside 2^53 - 1".into());
                }
                out.push_str(&u.to_string());
            } else {
                return Err("a number with a fraction".into());
            }
        }
        Value::String(s) => enc_str(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                enc(x, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                enc_str(k, out);
                out.push(':');
                enc(&o[k.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// CE-1 canonical JSON (keys sorted by UTF-8 bytes, no whitespace, integers within 2^53 - 1, no fractions), with null
/// written as `null`.
pub fn canonical_json(v: &Value) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    enc(v, &mut out)?;
    Ok(out.into_bytes())
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

/// The hash of an entry (its "hash" key, if any, left out) chained to `prev` (64 hex).
pub fn entry_hash(prev: &str, entry: &Map<String, Value>) -> Option<String> {
    let mut e = entry.clone();
    e.remove("hash");
    let body = canonical_json(&Value::Object(e)).ok()?;
    let p = raw32(prev)?;
    Some(hex(&sha256(&lp(&[LABEL.as_bytes(), &p, &body]))))
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────

/// What a caller appends; the log adds seq, ts, prev and hash.
#[derive(Clone, Debug)]
pub struct Record {
    pub actor: String,
    pub role: Option<String>,
    pub ip: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub result: &'static str,
    pub approval: Option<String>,
    pub stepup: bool,
    pub detail: Value,
}

impl Record {
    pub fn new(actor: &str, action: &str, result: &'static str) -> Record {
        Record { actor: actor.to_owned(), role: None, ip: None, action: action.to_owned(), target: None, result, approval: None, stepup: false, detail: Value::Null }
    }
}

fn entry_of(seq: u64, ts: i64, r: &Record, prev: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("seq".into(), Value::from(seq));
    m.insert("ts".into(), Value::from(ts));
    m.insert("actor".into(), Value::from(r.actor.as_str()));
    m.insert("role".into(), r.role.as_deref().map_or(Value::Null, Value::from));
    m.insert("ip".into(), r.ip.as_deref().map_or(Value::Null, Value::from));
    m.insert("action".into(), Value::from(r.action.as_str()));
    m.insert("target".into(), r.target.as_deref().map_or(Value::Null, Value::from));
    m.insert("result".into(), Value::from(r.result));
    m.insert("approval".into(), r.approval.as_deref().map_or(Value::Null, Value::from));
    m.insert("stepup".into(), Value::Bool(r.stepup));
    m.insert("detail".into(), r.detail.clone());
    m.insert("prev".into(), Value::from(prev));
    m
}

/// One line checked as an entry chained to `prev` with sequence `seq`: the entry, or None.
fn check_line(line: &str, seq: u64, prev: &str) -> Option<Map<String, Value>> {
    let v = parse_json(line)?;
    let o = v.as_object()?;
    if o.len() != ENTRY_KEYS.len() || !ENTRY_KEYS.iter().all(|k| o.contains_key(*k)) {
        return None;
    }
    if o.get("seq").and_then(Value::as_u64) != Some(seq) || o.get("prev").and_then(Value::as_str) != Some(prev) {
        return None;
    }
    let hash = o.get("hash").and_then(Value::as_str)?;
    (entry_hash(prev, o).as_deref() == Some(hash)).then(|| o.clone())
}

// ── Segments and head ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub through_seq: u64,
    pub hash: String,
}

#[derive(Clone, Debug)]
pub struct Broken {
    pub at_seq: u64,
    pub file: String,
    pub sha256: String,
    pub lines: u64,
}

#[derive(Default)]
struct Pending {
    minute: i64,
    count: u64,
    codes: BTreeMap<String, u64>,
    sources: HashSet<String>,
    role: Option<String>,
}

/// What `refusal` decided for one refusal.
#[derive(Debug, PartialEq, Eq)]
pub enum RefusalEntry {
    /// The refusal gets an entry of its own.
    Own,
    /// Counted into a summary.
    Summary,
}

/// The verify answer: whether the whole kept chain verifies, through which seq, where it breaks.
#[derive(Debug, PartialEq, Eq)]
pub struct Verified {
    pub verified: bool,
    pub through: u64,
    pub broken_at: Option<u64>,
}

pub struct Audit {
    dir: PathBuf,
    segment_bytes: u64,
    kept: usize,
    /// Segment numbers, oldest first.
    segments: Vec<u32>,
    seg_size: u64,
    seq: u64,
    hash: String,
    dropped: Option<Dropped>,
    exported_through: u64,
    exported_at: Option<i64>,
    created_at: i64,
    broken: Option<Broken>,
    persons: HashMap<String, (i64, u64)>,
    person_pending: HashMap<String, Pending>,
    global: Option<Pending>,
}

fn seg_name(n: u32) -> String {
    format!("console-audit-{n:06}.jsonl")
}

fn seg_number(name: &str) -> Option<u32> {
    let mid = name.strip_prefix("console-audit-")?.strip_suffix(".jsonl")?;
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

impl Audit {
    /// The log in `dir`, verified at start; a broken chain is moved aside, never fatal. `t` names the torn file.
    pub fn open(dir: &Path, t: i64) -> (Audit, Vec<String>) {
        Audit::open_with(dir, t, SEGMENT_BYTES, SEGMENTS_KEPT)
    }

    /// `open` with the segment size and count given (tests rotate with small segments).
    pub fn open_with(dir: &Path, t: i64, segment_bytes: u64, kept: usize) -> (Audit, Vec<String>) {
        let mut notes = Vec::new();
        let _ = make_dir(dir);
        let mut a = Audit {
            dir: dir.to_owned(),
            segment_bytes,
            kept: kept.max(1),
            segments: Vec::new(),
            seg_size: 0,
            seq: 0,
            hash: ZERO.into(),
            dropped: None,
            exported_through: 0,
            exported_at: None,
            created_at: t,
            broken: None,
            persons: HashMap::new(),
            person_pending: HashMap::new(),
            global: None,
        };
        let head = read_text(&dir.join(HEAD_FILE)).and_then(|s| parse_json(&s)).and_then(|v| v.as_object().cloned());
        let mut head_seq = 0;
        if let Some(h) = &head {
            head_seq = h.get("seq").and_then(Value::as_u64).unwrap_or(0);
            a.exported_through = h.get("exportedThrough").and_then(Value::as_u64).unwrap_or(0);
            a.exported_at = h.get("exportedAt").and_then(Value::as_i64);
            a.created_at = h.get("createdAt").and_then(Value::as_i64).unwrap_or(t);
            if let Some(d) = h.get("dropped").and_then(Value::as_object) {
                if let (Some(s), Some(hh)) = (d.get("through_seq").and_then(Value::as_u64), d.get("hash").and_then(Value::as_str)) {
                    a.dropped = Some(Dropped { through_seq: s, hash: hh.to_owned() });
                }
            }
            if let Some(b) = h.get("broken").and_then(Value::as_object) {
                a.broken = Some(Broken {
                    at_seq: b.get("atSeq").and_then(Value::as_u64).unwrap_or(0),
                    file: b.get("file").and_then(Value::as_str).unwrap_or("").to_owned(),
                    sha256: b.get("sha256").and_then(Value::as_str).unwrap_or("").to_owned(),
                    lines: b.get("lines").and_then(Value::as_u64).unwrap_or(0),
                });
            }
        }
        let mut segs: Vec<u32> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).filter_map(|e| seg_number(&e.file_name().to_string_lossy())).collect()).unwrap_or_default();
        segs.sort_unstable();
        let (mut seq, mut prev) = match &a.dropped {
            Some(d) => (d.through_seq, d.hash.clone()),
            None => (0, ZERO.to_owned()),
        };
        let mut bad: Option<(usize, usize)> = None;
        'segments: for (si, n) in segs.iter().enumerate() {
            let bytes = std::fs::read(dir.join(seg_name(*n))).unwrap_or_default();
            for (off, line) in lines_of(&bytes) {
                let text = String::from_utf8_lossy(line);
                // A front dropped with no head to record it: the first entry says where the kept chain starts.
                if seq == 0 && a.dropped.is_none() {
                    if let Some(o) = parse_json(&text).and_then(|v| v.as_object().cloned()) {
                        let first = o.get("seq").and_then(Value::as_u64).unwrap_or(0);
                        if first > 1 {
                            if let Some(p) = o.get("prev").and_then(Value::as_str) {
                                a.dropped = Some(Dropped { through_seq: first - 1, hash: p.to_owned() });
                                seq = first - 1;
                                prev = p.to_owned();
                                notes.push(format!("the audit log starts at entry {first} and its head did not record the dropped front"));
                            }
                        }
                    }
                }
                match check_line(&text, seq + 1, &prev) {
                    Some(o) => {
                        seq += 1;
                        prev = o.get("hash").and_then(Value::as_str).unwrap_or("").to_owned();
                    }
                    None => {
                        bad = Some((si, off));
                        break 'segments;
                    }
                }
            }
        }
        if let Some((si, off)) = bad {
            // Move the bad line and everything after it, unchanged, to the torn file; keep the verified prefix.
            let mut torn = Vec::new();
            for (i, n) in segs.iter().enumerate().skip(si) {
                let p = dir.join(seg_name(*n));
                let bytes = std::fs::read(&p).unwrap_or_default();
                if i == si {
                    torn.extend_from_slice(&bytes[off..]);
                    let _ = write_private(&p, &bytes[..off]);
                } else {
                    torn.extend_from_slice(&bytes);
                    let _ = std::fs::remove_file(&p);
                }
            }
            segs.truncate(si + 1);
            let file = format!("console-audit-torn-{t}.jsonl");
            let lines = lines_of(&torn).len() as u64;
            let _ = write_private(&dir.join(&file), &torn);
            notes.push(format!("the audit log does not verify from entry {}: {lines} line(s) moved to {file}", seq + 1));
            a.broken = Some(Broken { at_seq: seq + 1, file, sha256: sha256_hex(&torn), lines });
        } else if head_seq > seq && a.broken.is_none() {
            // The head names entries the segments no longer hold: their tail was cut.
            notes.push(format!("the audit head names entry {head_seq} but the log ends at entry {seq}"));
            a.broken = Some(Broken { at_seq: seq + 1, file: String::new(), sha256: sha256_hex(b""), lines: 0 });
        }
        a.segments = segs;
        a.seq = seq;
        a.hash = prev;
        a.seg_size = a.segments.last().and_then(|n| std::fs::metadata(dir.join(seg_name(*n))).ok()).map_or(0, |m| m.len());
        a.write_head();
        (a, notes)
    }

    fn write_head(&self) {
        let head = json!({
            "seq": self.seq, "hash": self.hash, "segment": self.segments.last().copied().unwrap_or(0),
            "dropped": self.dropped_value(), "exportedThrough": self.exported_through, "exportedAt": self.exported_at,
            "createdAt": self.created_at,
            "broken": self.broken.as_ref().map(|b| json!({ "atSeq": b.at_seq, "file": b.file, "sha256": b.sha256, "lines": b.lines })),
        });
        let _ = write_private(&self.dir.join(HEAD_FILE), format!("{}\n", stringify(&head)).as_bytes());
    }

    pub fn dropped_value(&self) -> Value {
        self.dropped.as_ref().map_or(Value::Null, |d| json!({ "through_seq": d.through_seq, "hash": d.hash }))
    }

    pub fn head(&self) -> (u64, String) {
        (self.seq, self.hash.clone())
    }

    pub fn broken(&self) -> Option<&Broken> {
        self.broken.as_ref()
    }

    pub fn exported_through(&self) -> u64 {
        self.exported_through
    }

    /// Append one entry: the whole entry as written (with seq and hash), or why not.
    pub fn append(&mut self, ts: i64, r: &Record) -> Result<Value, String> {
        let seq = self.seq + 1;
        let mut e = entry_of(seq, ts, r, &self.hash);
        let hash = entry_hash(&self.hash, &e).ok_or("the audit entry is not canonical JSON")?;
        e.insert("hash".into(), Value::from(hash.as_str()));
        let line = format!("{}\n", stringify(&Value::Object(e.clone())));
        if self.segments.is_empty() || self.seg_size + line.len() as u64 > self.segment_bytes {
            let next = self.segments.last().map_or(1, |n| n + 1);
            self.segments.push(next);
            self.seg_size = 0;
        }
        let n = *self.segments.last().unwrap_or(&1);
        let mut f = open_append(&self.dir.join(seg_name(n))).map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.seg_size += line.len() as u64;
        self.seq = seq;
        self.hash = hash;
        self.rotate();
        self.write_head();
        Ok(Value::Object(e))
    }

    fn rotate(&mut self) {
        while self.segments.len() > self.kept {
            let oldest = self.segments.remove(0);
            let p = self.dir.join(seg_name(oldest));
            let bytes = std::fs::read(&p).unwrap_or_default();
            let last = lines_of(&bytes).into_iter().rev().find_map(|(_, l)| parse_json(&String::from_utf8_lossy(l)).and_then(|v| v.as_object().cloned()));
            if let Some(o) = last {
                if let (Some(s), Some(h)) = (o.get("seq").and_then(Value::as_u64), o.get("hash").and_then(Value::as_str)) {
                    self.dropped = Some(Dropped { through_seq: s, hash: h.to_owned() });
                }
            }
            let _ = std::fs::remove_file(&p);
        }
    }

    /// `audit.restart`: the torn file is on record in the entry `r` (its detail filled in here) and ordinary writes go
    /// on. The appended entry.
    pub fn restart(&mut self, ts: i64, mut r: Record) -> Result<Value, String> {
        let Some(b) = self.broken.clone() else { return Err("the audit log is not broken".into()) };
        let mut detail = r.detail.as_object().cloned().unwrap_or_default();
        detail.insert("torn_sha256".into(), Value::from(b.sha256.as_str()));
        detail.insert("torn_lines".into(), Value::from(b.lines));
        detail.insert("after_torn".into(), Value::Bool(true));
        r.detail = Value::Object(detail);
        let e = self.append(ts, &r)?;
        self.broken = None;
        self.write_head();
        Ok(e)
    }

    // ── Refusal summaries ───────────────────────────────────────────────────────────────────────────────────

    /// One refusal. `person` is the signed-in actor (email, role), `post` a POST route, `source` the source key.
    pub fn refusal(&mut self, person: Option<(&str, &str)>, post: bool, code: &str, source: &str, t: i64) -> RefusalEntry {
        let minute = t.div_euclid(60_000);
        match person {
            Some((email, role)) => {
                if post {
                    let w = self.persons.entry(email.to_owned()).or_insert((minute, 0));
                    if w.0 != minute {
                        *w = (minute, 0);
                    }
                    if w.1 < PERSON_REFUSALS_PER_MINUTE {
                        w.1 += 1;
                        return RefusalEntry::Own;
                    }
                }
                let p = self.person_pending.entry(email.to_owned()).or_insert_with(|| Pending { minute, ..Pending::default() });
                p.count += 1;
                *p.codes.entry(code.to_owned()).or_insert(0) += 1;
                p.role = Some(role.to_owned());
                RefusalEntry::Summary
            }
            None => {
                let g = self.global.get_or_insert_with(|| Pending { minute, ..Pending::default() });
                g.count += 1;
                *g.codes.entry(code.to_owned()).or_insert(0) += 1;
                if g.sources.len() < 100_000 {
                    g.sources.insert(source.to_owned());
                }
                RefusalEntry::Summary
            }
        }
    }

    /// The summaries of minutes that have ended, appended. The entries written.
    pub fn flush(&mut self, t: i64, force: bool) -> Vec<Value> {
        let minute = t.div_euclid(60_000);
        let mut out = Vec::new();
        let due: Vec<String> = self.person_pending.iter().filter(|(_, p)| force || p.minute < minute).map(|(k, _)| k.clone()).collect();
        for email in due {
            if let Some(p) = self.person_pending.remove(&email) {
                let mut r = Record::new(&email, "refusals.summary", "summary");
                r.role = p.role.clone();
                r.detail = json!({ "count": p.count, "codes": p.codes });
                if let Ok(e) = self.append(t, &r) {
                    out.push(e);
                }
            }
        }
        if self.global.as_ref().is_some_and(|g| force || g.minute < minute) {
            if let Some(g) = self.global.take() {
                let mut r = Record::new("relay", "refusals.summary", "summary");
                r.detail = json!({ "count": g.count, "codes": g.codes, "sources": g.sources.len() });
                if let Ok(e) = self.append(t, &r) {
                    out.push(e);
                }
            }
        }
        out
    }

    // ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────

    /// Every kept entry, oldest first.
    pub fn entries(&self) -> Vec<Map<String, Value>> {
        let mut out = Vec::new();
        for n in &self.segments {
            let bytes = std::fs::read(self.dir.join(seg_name(*n))).unwrap_or_default();
            for (_, l) in lines_of(&bytes) {
                if let Some(o) = parse_json(&String::from_utf8_lossy(l)).and_then(|v| v.as_object().cloned()) {
                    out.push(o);
                }
            }
        }
        out
    }

    /// Recompute the chain from the dropped record (or zeros) through every kept segment and the head.
    pub fn verify(&self) -> Verified {
        let (mut seq, mut prev) = match &self.dropped {
            Some(d) => (d.through_seq, d.hash.clone()),
            None => (0, ZERO.to_owned()),
        };
        for n in &self.segments {
            let bytes = std::fs::read(self.dir.join(seg_name(*n))).unwrap_or_default();
            for (_, l) in lines_of(&bytes) {
                match check_line(&String::from_utf8_lossy(l), seq + 1, &prev) {
                    Some(o) => {
                        seq += 1;
                        prev = o.get("hash").and_then(Value::as_str).unwrap_or("").to_owned();
                    }
                    None => return Verified { verified: false, through: seq, broken_at: Some(seq + 1) },
                }
            }
        }
        if seq != self.seq || prev != self.hash {
            return Verified { verified: false, through: seq, broken_at: Some(seq + 1) };
        }
        Verified { verified: true, through: seq, broken_at: None }
    }

    /// The entries `from` to `to` (seq numbers) as JSONL, oldest first; moves exportedThrough when the export covers the
    /// oldest unexported entry.
    pub fn export(&mut self, from: u64, to: u64, t: i64) -> Result<String, String> {
        if from == 0 || to < from || to - from + 1 > EXPORT_MAX {
            return Err(format!("from and to are entry numbers, at most {EXPORT_MAX} entries"));
        }
        let mut text = String::new();
        for e in self.entries() {
            let s = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
            if (from..=to).contains(&s) {
                text.push_str(&stringify(&Value::Object(e)));
                text.push('\n');
            }
        }
        let floor = self.exported_through.max(self.dropped.as_ref().map_or(0, |d| d.through_seq));
        if from <= floor + 1 && to > self.exported_through {
            self.exported_through = to.min(self.seq);
            self.exported_at = Some(t);
            self.write_head();
        }
        Ok(text)
    }

    /// Overview attention kinds the log raises now: `audit-broken`, `audit-rotating`, `audit-dropped-unexported`,
    /// `audit-not-exported`, each with its args.
    pub fn attention(&self, t: i64) -> Vec<(&'static str, Value)> {
        let mut out = Vec::new();
        if let Some(b) = &self.broken {
            out.push(("audit-broken", json!({ "n": b.at_seq })));
        }
        if let Some(d) = &self.dropped {
            if d.through_seq > self.exported_through {
                out.push(("audit-dropped-unexported", json!({ "from": self.exported_through + 1, "to": d.through_seq })));
            }
        }
        // 75% of the space used and the oldest segment, next to go, holds entries never exported.
        if self.segments.len() * 4 >= self.kept * 3 && self.segments.len() > 1 {
            let oldest = self.segments[0];
            let bytes = std::fs::read(self.dir.join(seg_name(oldest))).unwrap_or_default();
            let last = lines_of(&bytes).into_iter().rev().find_map(|(_, l)| parse_json(&String::from_utf8_lossy(l)).and_then(|v| v.get("seq").and_then(Value::as_u64)));
            if last.is_some_and(|s| s > self.exported_through) {
                out.push(("audit-rotating", json!({})));
            }
        }
        let since = self.exported_at.unwrap_or(self.created_at);
        if self.seq > 0 && t - since > 30 * 86_400_000 {
            out.push(("audit-not-exported", json!({})));
        }
        out
    }

    #[cfg(test)]
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-audit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rec(i: u64) -> Record {
        let mut r = Record::new("alice@acme.example", "admins.remove", "ok");
        r.role = Some("admin".into());
        r.ip = Some("203.0.113.7".into());
        r.target = Some(format!("bob{i}@acme.example"));
        r.stepup = true;
        r.detail = json!({ "reason": "Left the company" });
        r
    }

    #[test]
    fn canonical_json_sorts_keys_and_keeps_null() {
        let v = json!({ "b": 1, "a": [null, true, "x\n\u{1}"], "c": { "z": 0, "y": -5 } });
        assert_eq!(String::from_utf8(canonical_json(&v).unwrap()).unwrap(), "{\"a\":[null,true,\"x\\n\\u0001\"],\"b\":1,\"c\":{\"y\":-5,\"z\":0}}");
        assert!(canonical_json(&json!(1.5)).is_err());
        assert!(canonical_json(&json!(9_007_199_254_740_992u64)).is_err());
    }

    #[test]
    fn the_chain_appends_verifies_and_survives_a_restart() {
        let d = dir("chain");
        let (mut a, notes) = Audit::open(&d, T0);
        assert!(notes.is_empty());
        let first = a.append(T0, &rec(1)).unwrap();
        assert_eq!(first["prev"], ZERO);
        assert_eq!(first["seq"], 1);
        let second = a.append(T0 + 1, &rec(2)).unwrap();
        assert_eq!(second["prev"], first["hash"]);
        let keys: Vec<&str> = second.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ENTRY_KEYS.to_vec());
        assert!(a.verify().verified);
        let (b, notes) = Audit::open(&d, T0 + 5);
        assert!(notes.is_empty() && b.broken().is_none());
        assert_eq!(b.head(), a.head());
    }

    #[test]
    fn verify_finds_an_edited_byte_a_removed_line_and_a_truncated_head() {
        for case in 0..3 {
            let d = dir(&format!("verify{case}"));
            let (mut a, _) = Audit::open(&d, T0);
            for i in 0..5 {
                a.append(T0 + i, &rec(i as u64)).unwrap();
            }
            let p = d.join(seg_name(1));
            let text = std::fs::read_to_string(&p).unwrap();
            let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
            match case {
                0 => lines[2] = lines[2].replace("bob2", "bob9"),
                1 => {
                    lines.remove(2);
                }
                _ => {
                    lines.truncate(4);
                }
            }
            std::fs::write(&p, format!("{}\n", lines.join("\n"))).unwrap();
            let v = a.verify();
            assert!(!v.verified, "case {case}");
            assert_eq!(v.broken_at, Some(if case == 2 { 5 } else { 3 }), "case {case}");
        }
    }

    #[test]
    fn a_torn_tail_and_a_broken_middle_line_keep_the_verified_prefix() {
        for middle in [false, true] {
            let d = dir(&format!("torn{middle}"));
            let (mut a, _) = Audit::open(&d, T0);
            for i in 0..4 {
                a.append(T0 + i, &rec(i as u64)).unwrap();
            }
            let p = d.join(seg_name(1));
            let text = std::fs::read_to_string(&p).unwrap();
            let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
            if middle {
                lines[1] = "{not json".into();
            } else {
                let last = lines.pop().unwrap();
                lines.push(last[..last.len() / 2].to_owned());
            }
            std::fs::write(&p, lines.join("\n")).unwrap();
            let (mut b, notes) = Audit::open(&d, T0 + 99);
            assert_eq!(notes.len(), 1);
            let broken = b.broken().unwrap().clone();
            let kept = if middle { 1 } else { 3 };
            assert_eq!(broken.at_seq, kept + 1);
            assert_eq!(broken.lines, 4 - kept);
            assert!(d.join(&broken.file).exists());
            assert_eq!(b.head().0, kept);
            assert!(b.verify().verified);
            // Appends go on from the verified prefix; restart records the torn file.
            let e = b.append(T0 + 100, &rec(9)).unwrap();
            assert_eq!(e["seq"], kept + 1);
            let r = b.restart(T0 + 101, Record::new("alice@acme.example", "audit.restart", "ok")).unwrap();
            assert_eq!(r["detail"]["torn_lines"], 4 - kept);
            assert_eq!(r["detail"]["after_torn"], true);
            assert!(b.broken().is_none());
            // A restart remembers nothing broken.
            let (c, _) = Audit::open(&d, T0 + 200);
            assert!(c.broken().is_none() && c.verify().verified);
        }
    }

    #[test]
    fn a_broken_state_survives_a_restart_until_restarted() {
        let d = dir("brokenrestart");
        let (mut a, _) = Audit::open(&d, T0);
        a.append(T0, &rec(1)).unwrap();
        a.append(T0, &rec(2)).unwrap();
        let p = d.join(seg_name(1));
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, &text[..text.len() - 10]).unwrap();
        let (_, _) = Audit::open(&d, T0 + 1);
        let (b, notes) = Audit::open(&d, T0 + 2);
        assert!(notes.is_empty());
        assert!(b.broken().is_some());
    }

    #[test]
    fn segments_rotate_and_record_the_dropped_front() {
        let d = dir("rotate");
        let (mut a, _) = Audit::open_with(&d, T0, 1000, 4);
        for i in 0..40 {
            a.append(T0 + i, &rec(i as u64)).unwrap();
        }
        assert_eq!(a.segment_count(), 4);
        let dropped = a.dropped.clone().unwrap();
        assert!(dropped.through_seq > 0);
        assert!(a.verify().verified);
        let entries = a.entries();
        assert_eq!(entries[0]["seq"], dropped.through_seq + 1);
        assert_eq!(entries[0]["prev"], dropped.hash.as_str());
        // Never exported: the dropped entries are flagged, and the next rotation would drop more.
        let kinds: Vec<&str> = a.attention(T0).iter().map(|(k, _)| *k).collect();
        assert!(kinds.contains(&"audit-dropped-unexported") && kinds.contains(&"audit-rotating"));
        // An export from the oldest kept entry moves exportedThrough.
        let from = dropped.through_seq + 1;
        let text = a.export(from, 40, T0 + 50).unwrap();
        assert_eq!(text.lines().count() as u64, 40 - dropped.through_seq);
        assert_eq!(a.exported_through(), 40);
        let kinds: Vec<&str> = a.attention(T0 + 51).iter().map(|(k, _)| *k).collect();
        assert!(!kinds.contains(&"audit-rotating"));
        // Restart keeps the dropped record and verifies.
        let (b, notes) = Audit::open_with(&d, T0 + 60, 1000, 4);
        assert!(notes.is_empty() && b.verify().verified);
    }

    #[test]
    fn refusals_without_a_session_add_one_entry_a_minute() {
        let d = dir("summary");
        let (mut a, _) = Audit::open(&d, T0);
        let t = 60_000 * 30_000_000; // the start of a minute
        for i in 0..10_000 {
            assert_eq!(a.refusal(None, true, "source", &format!("198.51.{}.{}", i / 256, i % 256), t + i % 50_000), RefusalEntry::Summary);
            assert_eq!(a.refusal(None, true, "signin-refused", "203.0.113.1", t + i % 50_000), RefusalEntry::Summary);
        }
        assert!(a.flush(t + 59_000, false).is_empty());
        let out = a.flush(t + 60_000, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["actor"], "relay");
        assert_eq!(out[0]["detail"]["count"], 20_000);
        assert_eq!(out[0]["detail"]["sources"], 10_001);
        assert!(!stringify(&out[0]).contains("198.51."));
        // A person: 60 own POST refusals a minute, then a summary, and GET refusals summarized.
        for _ in 0..PERSON_REFUSALS_PER_MINUTE {
            assert_eq!(a.refusal(Some(("alice@acme.example", "admin")), true, "role", "k", t + 61_000), RefusalEntry::Own);
        }
        assert_eq!(a.refusal(Some(("alice@acme.example", "admin")), true, "role", "k", t + 61_000), RefusalEntry::Summary);
        assert_eq!(a.refusal(Some(("alice@acme.example", "admin")), false, "role", "k", t + 61_000), RefusalEntry::Summary);
        let out = a.flush(t + 120_000, false);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0]["actor"].as_str(), out[0]["detail"]["count"].as_u64()), (Some("alice@acme.example"), Some(2)));
    }
}
