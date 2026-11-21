// Contract AI-1 section 6.8: the gateway's audit log. One JSON line per request, hash-chained like the archive's
// `archive-audit.jsonl` (each line carries `seq` and `prev`, the SHA-256 hex of the previous line's bytes; lines are
// canonical JSON). One file per UTC month (`ai-audit-YYYY-MM.jsonl`, the chain runs across files); files older than
// the retention (400 days by default) are deleted whole. The record type has no field for a question, snippet or
// answer, so none can be written.

use crate::codec::sha256_hex;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
pub const KEEP_DAYS: i64 = 400;
const PREFIX: &str = "ai-audit-";
const SUFFIX: &str = ".jsonl";

/// The 6.8 fields, metadata only. Strings that do not apply are empty, numbers 0.
#[derive(Clone, Debug, Default)]
pub struct Record {
    pub rid: String,
    pub principal: String,
    pub device: String,
    pub activity: String,
    pub class: String,
    pub tier: String,
    pub card_id: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub usd_micro: u64,
    pub expected_ms: u64,
    pub took_ms: u64,
    /// `answered` or `refused` (or `failed` for a 500).
    pub outcome: String,
    /// The 6.7 code of a refusal, "" when answered.
    pub code: String,
    pub policy: String,
}

struct Tail {
    seq: u64,
    prev: String,
}

pub struct Audit {
    dir: PathBuf,
    keep_days: i64,
    tail: Mutex<Tail>,
}

fn line_bytes(v: &Value) -> Vec<u8> {
    crate::meet_org_policy::canonical_json(v).unwrap_or_default()
}

/// The month files in `dir`, oldest first.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(SUFFIX))).collect())
        .unwrap_or_default();
    out.sort();
    out
}

fn last_line(path: &Path) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    data.split(|b| *b == b'\n').filter(|l| !l.is_empty()).last().map(<[u8]>::to_vec)
}

impl Audit {
    pub fn open(dir: &Path, keep_days: i64) -> Result<Audit, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot make the audit folder {}: {e}", dir.display()))?;
        let mut tail = Tail { seq: 0, prev: ZERO.to_string() };
        if let Some(line) = files(dir).iter().rev().find_map(|p| last_line(p)) {
            let v: Value = serde_json::from_slice(&line).map_err(|_| "the last audit line is not JSON".to_string())?;
            tail = Tail { seq: v["seq"].as_u64().unwrap_or(0), prev: sha256_hex(&line) };
        }
        Ok(Audit { dir: dir.to_path_buf(), keep_days, tail: Mutex::new(tail) })
    }

    /// Append one line (fsynced) and return it.
    pub fn append(&self, r: &Record, now_ms: i64) -> Result<Value, String> {
        let mut t = self.tail.lock();
        let row = json!({
            "seq": t.seq + 1, "prev": t.prev, "ts": now_ms.div_euclid(1000),
            "rid": r.rid, "principal": r.principal, "device": r.device, "activity": r.activity, "class": r.class,
            "tier": r.tier, "card_id": r.card_id, "tokens_in": r.tokens_in, "tokens_out": r.tokens_out,
            "usd_micro": r.usd_micro, "expected_ms": r.expected_ms, "took_ms": r.took_ms, "outcome": r.outcome,
            "code": r.code, "policy": r.policy,
        });
        let data = line_bytes(&row);
        let (y, m, _) = crate::meet_json::civil(now_ms.div_euclid(86_400_000));
        let path = self.dir.join(format!("{PREFIX}{y:04}-{m:02}{SUFFIX}"));
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("cannot open the audit log: {e}"))?;
            let mut out = data.clone();
            out.push(b'\n');
            f.write_all(&out).map_err(|e| format!("cannot write the audit log: {e}"))?;
            f.sync_all().map_err(|e| format!("cannot sync the audit log: {e}"))?;
        }
        t.seq += 1;
        t.prev = sha256_hex(&data);
        Ok(row)
    }

    /// Delete month files whose month ended more than `keep_days` ago.
    pub fn prune(&self, now_ms: i64) {
        let _t = self.tail.lock();
        let cutoff_days = now_ms.div_euclid(86_400_000) - self.keep_days;
        for p in files(&self.dir) {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let ym = &name[PREFIX.len()..name.len() - SUFFIX.len()];
            let (Some(y), Some(m)) = (ym.get(0..4).and_then(|s| s.parse::<i64>().ok()), ym.get(5..7).and_then(|s| s.parse::<u32>().ok())) else { continue };
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            if crate::meet_json::days_from_civil(ny, nm, 1) <= cutoff_days {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    /// Every kept line with `ts >= since` (seconds), oldest first.
    pub fn since(&self, since: i64) -> Vec<Value> {
        let _t = self.tail.lock();
        let mut out = Vec::new();
        for p in files(&self.dir) {
            let Ok(data) = std::fs::read(&p) else { continue };
            for line in data.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
                if let Ok(v) = serde_json::from_slice::<Value>(line) {
                    if v["ts"].as_i64().unwrap_or(0) >= since {
                        out.push(v);
                    }
                }
            }
        }
        out
    }

    /// Problems of the kept chain (empty: whole). The first kept line anchors it (older files may be pruned).
    pub fn verify(&self) -> Vec<String> {
        let _t = self.tail.lock();
        let mut problems = Vec::new();
        let mut expect: Option<(String, u64)> = None;
        for p in files(&self.dir) {
            let Ok(data) = std::fs::read(&p) else {
                problems.push(format!("{} cannot be read", p.display()));
                break;
            };
            for (n, line) in data.split(|b| *b == b'\n').filter(|l| !l.is_empty()).enumerate() {
                let Ok(v) = serde_json::from_slice::<Value>(line) else {
                    problems.push(format!("{} line {} is not JSON", p.display(), n + 1));
                    return problems;
                };
                let (prev, seq) = (v["prev"].as_str().unwrap_or_default().to_string(), v["seq"].as_u64().unwrap_or(0));
                let follows = match &expect {
                    None => true,
                    Some((ep, es)) => *ep == prev && *es + 1 == seq,
                };
                if !follows || line_bytes(&v) != line {
                    problems.push(format!("{} line {} does not follow the line before it", p.display(), n + 1));
                    return problems;
                }
                expect = Some((sha256_hex(line), seq));
            }
        }
        problems
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(rid: &str) -> Record {
        Record {
            rid: rid.into(),
            principal: "ann@acme.example".into(),
            device: "0123456789abcdef".into(),
            activity: "search".into(),
            class: "internal".into(),
            tier: "org".into(),
            card_id: "llama-70b-fp8".into(),
            tokens_in: 4012,
            tokens_out: 87,
            outcome: "answered".into(),
            policy: "ab".repeat(32),
            ..Record::default()
        }
    }

    #[test]
    fn lines_chain_across_months_and_restarts() {
        let dir = crate::meet_tls::testpki::dir("ai-audit");
        let jan = 1_798_761_600_000; // 2027-01-01
        let a = Audit::open(&dir, KEEP_DAYS).unwrap();
        let first = a.append(&record(&"1".repeat(32)), jan - 1000).unwrap();
        assert_eq!((first["seq"].as_u64(), first["prev"].as_str()), (Some(1), Some(ZERO)));
        a.append(&record(&"2".repeat(32)), jan + 1000).unwrap();
        let again = Audit::open(&dir, KEEP_DAYS).unwrap();
        let third = again.append(&record(&"3".repeat(32)), jan + 2000).unwrap();
        assert_eq!(third["seq"].as_u64(), Some(3));
        assert_eq!(files(&dir).len(), 2);
        assert!(again.verify().is_empty());
        assert_eq!(again.since(jan / 1000).len(), 2);
        // an edited line breaks the chain
        let path = files(&dir)[1].clone();
        let text = std::fs::read_to_string(&path).unwrap().replace("\"tokens_out\":87", "\"tokens_out\":88");
        std::fs::write(&path, text).unwrap();
        assert!(!again.verify().is_empty());
    }

    /// 6.8: no question, snippet or answer: the line holds exactly the metadata fields.
    #[test]
    fn audit_lines_hold_no_content() {
        let dir = crate::meet_tls::testpki::dir("ai-audit-content");
        let a = Audit::open(&dir, KEEP_DAYS).unwrap();
        let row = a.append(&record(&"4".repeat(32)), 1_795_000_000_000).unwrap();
        let mut keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["activity", "card_id", "class", "code", "device", "expected_ms", "outcome", "policy", "prev", "principal", "rid", "seq", "tier", "tokens_in", "tokens_out", "took_ms", "ts", "usd_micro"]);
    }

    #[test]
    fn months_past_the_retention_are_deleted() {
        let dir = crate::meet_tls::testpki::dir("ai-audit-prune");
        let a = Audit::open(&dir, KEEP_DAYS).unwrap();
        let day = 86_400_000i64;
        let old = 1_795_000_000_000;
        a.append(&record(&"5".repeat(32)), old).unwrap();
        a.append(&record(&"6".repeat(32)), old + 420 * day).unwrap();
        a.prune(old + 420 * day);
        assert_eq!(files(&dir).len(), 1);
        assert!(a.verify().is_empty());
    }
}
