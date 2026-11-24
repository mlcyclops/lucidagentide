// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 4.5: the `Idempotency-Key` store of the front door
// (draft-ietf-httpapi-idempotency-key-header-09). `POST v1/compliance/holds` and `POST v1/compliance/exports` carry the
// header as a Structured Field String of 16 to 64 of `[A-Za-z0-9_-]`; the console remembers each key per org and
// client for 24 hours with the SHA-256 of the canonical request body and, once the first request finished, its answer.
// Missing or malformed: 400 `idempotency-key`. Same key and body, finished: the original answer again (the caller audits
// the replay as `api.call` with `result: "replayed"`). Same key, still running: 409 `idempotency-busy`. Same key,
// another body: 422 `idempotency-mismatch`.
//
// Finished answers are kept in `<state>/api-idempotency/<org>.json`, flushed before the answer leaves; an answer of
// 500 or above is not kept (the client may try again with the same key). A request still running is held in memory
// only: after a console restart its key starts afresh, unless the caller kept it with its own durable record (`recover`).
//
// The compliance routes of slices 1b4 and 1b5 call it (`ConsoleApi::idempotency`).
#![cfg_attr(not(test), allow(dead_code))]

use crate::api_map::ApiMapError;
use crate::codec::{parse_json, sha256_hex, stringify};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The folder of the kept answers.
pub const DIR: &str = "api-idempotency";
/// How long a key is remembered (seconds).
pub const KEEP_S: i64 = 86_400;
const KEY_MIN: usize = 16;
const KEY_MAX: usize = 64;

/// A refusal of 4.5: its status and code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refused {
    pub status: u16,
    pub code: &'static str,
}

pub const KEY: Refused = Refused { status: 400, code: "idempotency-key" };
pub const BUSY: Refused = Refused { status: 409, code: "idempotency-busy" };
pub const MISMATCH: Refused = Refused { status: 422, code: "idempotency-mismatch" };

impl Refused {
    /// The sentence of the refusal.
    pub fn why(self) -> &'static str {
        match self.code {
            "idempotency-busy" => "A request with this Idempotency-Key is still running.",
            "idempotency-mismatch" => "This Idempotency-Key was used with another request body.",
            _ => "This request needs an Idempotency-Key header: a quoted string of 16 to 64 letters, digits, - and _.",
        }
    }
}

/// The key of an `Idempotency-Key` header value: `"<16 to 64 of [A-Za-z0-9_-]>"` (a Structured Field String; the
/// allowed characters need no escapes). 400 `idempotency-key` when missing or malformed.
pub fn parse_key(header: Option<&str>) -> Result<String, Refused> {
    let inner = header.map(str::trim).and_then(|h| h.strip_prefix('"')).and_then(|h| h.strip_suffix('"')).ok_or(KEY)?;
    let ok = (KEY_MIN..=KEY_MAX).contains(&inner.len()) && inner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(inner.to_string())
    } else {
        Err(KEY)
    }
}

/// The SHA-256 (hex) of a request body's canonical JSON (of its compact text when canonical JSON refuses it).
pub fn body_sha256(body: &Value) -> String {
    match crate::meet_org_policy::canonical_json(body) {
        Ok(b) => sha256_hex(&b),
        Err(_) => sha256_hex(stringify(body).as_bytes()),
    }
}

/// What `begin` decided.
#[derive(Clone, Debug, PartialEq)]
pub enum Begin {
    /// A new request: run it, then `finish` (or `abandon`).
    Fresh,
    /// The same request finished before: answer this again.
    Replay { status: u16, body: Value },
    /// Refused: `BUSY` or `MISMATCH`.
    Refused(Refused),
}

#[derive(Clone, Debug)]
struct Rec {
    sha256: String,
    at: i64,
    /// None while the first request runs.
    answer: Option<(u16, Value)>,
}

/// org -> (client, key) -> record.
type Book = BTreeMap<String, BTreeMap<(String, String), Rec>>;

/// The console's idempotency keys (in memory without a folder).
#[derive(Debug, Default)]
pub struct IdemStore {
    dir: Option<PathBuf>,
    book: Mutex<Book>,
    /// One answer is written at a time, so each write's snapshot holds every answer committed before it.
    saving: Mutex<()>,
}

fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl IdemStore {
    /// The kept answers under `<dir>/api-idempotency` (each read once; expired ones drop at the next write).
    pub fn load(dir: Option<&Path>) -> IdemStore {
        let dir = dir.map(|d| d.join(DIR));
        let mut book = Book::new();
        for entry in dir.as_ref().and_then(|d| std::fs::read_dir(d).ok()).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(org) = name.strip_suffix(".json").filter(|o| org_ok(o)) else { continue };
            let v = parse_json(&std::fs::read_to_string(entry.path()).unwrap_or_default()).unwrap_or(Value::Null);
            let keys = book.entry(org.to_string()).or_default();
            for k in v.get("keys").and_then(Value::as_array).into_iter().flatten() {
                let s = |f: &str| k.get(f).and_then(Value::as_str).map(str::to_string);
                let (Some(client), Some(key), Some(sha256), Some(at), Some(status)) = (s("client"), s("key"), s("sha256"), k.get("at").and_then(Value::as_i64), k.get("status").and_then(Value::as_u64)) else { continue };
                let answer = Some((status as u16, k.get("body").cloned().unwrap_or(Value::Null)));
                keys.insert((client, key), Rec { sha256, at, answer });
            }
        }
        IdemStore { dir, book: Mutex::new(book), saving: Mutex::new(()) }
    }

    fn save(&self, org: &str, keys: &BTreeMap<(String, String), Rec>) -> Result<(), ApiMapError> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let io = |e: String| ApiMapError::new("io", e);
        crate::store::make_dir(dir).map_err(|e| io(e.to_string()))?;
        let list: Vec<Value> = keys
            .iter()
            .filter_map(|((client, key), r)| r.answer.as_ref().map(|(status, body)| json!({ "client": client, "key": key, "sha256": r.sha256, "at": r.at, "status": status, "body": body })))
            .collect();
        crate::fleet_local::write_durable(&dir.join(format!("{org}.json")), stringify(&json!({ "keys": list })).as_bytes()).map_err(io)
    }

    /// 4.5 for one request of `client` in `org` with `key` and `body` at `now`: a new request is marked running.
    pub fn begin(&self, org: &str, client: &str, key: &str, body: &Value, now: i64) -> Begin {
        let sha256 = body_sha256(body);
        let mut book = self.book.lock();
        let keys = book.entry(org.to_string()).or_default();
        keys.retain(|_, r| r.answer.is_none() || now - r.at < KEEP_S);
        let id = (client.to_string(), key.to_string());
        match keys.get(&id) {
            Some(r) if r.sha256 != sha256 => Begin::Refused(MISMATCH),
            Some(Rec { answer: None, .. }) => Begin::Refused(BUSY),
            Some(Rec { answer: Some((status, body)), .. }) => Begin::Replay { status: *status, body: body.clone() },
            None => {
                keys.insert(id, Rec { sha256, at: now, answer: None });
                Begin::Fresh
            }
        }
    }

    /// The first request's answer, written durably and only then made the key's answer, so no retry is answered from a
    /// record that is not on disk: until the write succeeds the key stays running (`BUSY`). A failed write returns Err
    /// and leaves it running (no retry runs the request again in this process); the caller answers its own request.
    /// An answer of 500 or above is forgotten instead, so the same key may run again.
    pub fn finish(&self, org: &str, client: &str, key: &str, status: u16, body: &Value) -> Result<(), ApiMapError> {
        let id = (client.to_string(), key.to_string());
        if status >= 500 {
            if let Some(keys) = self.book.lock().get_mut(org) {
                keys.remove(&id);
            }
            return Ok(());
        }
        let answer = (status, body.clone());
        let _one = self.saving.lock();
        let snapshot = {
            let book = self.book.lock();
            let Some(keys) = book.get(org).filter(|k| k.get(&id).is_some_and(|r| r.answer.is_none())) else { return Ok(()) };
            let mut staged = keys.clone();
            if let Some(r) = staged.get_mut(&id) {
                r.answer = Some(answer.clone());
            }
            staged
        };
        self.save(org, &snapshot)?;
        if let Some(r) = self.book.lock().get_mut(org).and_then(|k| k.get_mut(&id)) {
            r.answer = Some(answer);
        }
        Ok(())
    }

    /// A key the caller kept durably elsewhere (an API hold record carries its key, body hash, time and answer): the
    /// key takes that hash and time and, when there is one, that answer, in memory (the caller's record is the durable
    /// copy). Without an answer the key stays running (`BUSY`), so a retry cannot run the request a second time.
    pub fn recover(&self, org: &str, client: &str, key: &str, sha256: &str, at: i64, answer: Option<(u16, Value)>) {
        let rec = Rec { sha256: sha256.to_string(), at, answer };
        self.book.lock().entry(org.to_string()).or_default().insert((client.to_string(), key.to_string()), rec);
    }

    /// The first request ended without an answer to keep: the key may run again.
    pub fn abandon(&self, org: &str, client: &str, key: &str) {
        if let Some(keys) = self.book.lock().get_mut(org) {
            keys.remove(&(client.to_string(), key.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY16: &str = "AbCdEfGh12345678";

    #[test]
    fn the_header_is_a_structured_field_string() {
        assert_eq!(parse_key(Some(&format!("\"{KEY16}\""))), Ok(KEY16.to_string()));
        assert_eq!(parse_key(Some(&format!(" \"{}\" ", "a_-9".repeat(16)))), Ok("a_-9".repeat(16)));
        for bad in [None, Some(KEY16), Some("\"short\""), Some(&*format!("\"{}\"", "a".repeat(65))), Some("\"AbCdEfGh1234567!\""), Some("\"AbCdEfGh 2345678\"")] {
            assert_eq!(parse_key(bad), Err(KEY), "{bad:?}");
        }
    }

    /// An answer whose write fails is never replayed: the key stays running until a write succeeds.
    #[test]
    fn an_answer_is_replayed_only_once_it_is_on_disk() {
        let dir = std::env::temp_dir().join(format!("lucid-api-idem-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = IdemStore::load(Some(&dir));
        let body = json!({"org": "acme", "job": {"matter": "m-7"}});
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 100), Begin::Fresh);
        // the seam: the answers folder is a file, so the write fails
        std::fs::write(dir.join(DIR), b"not a folder").unwrap();
        assert_eq!(s.finish("acme", "c_1", KEY16, 201, &json!({"job": "j_1"})).unwrap_err().code, "io");
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 101), Begin::Refused(BUSY), "no replay of an answer that is not on disk");
        assert!(IdemStore::load(Some(&dir)).book.lock().is_empty());
        // writes work again: the answer is kept, then replayed, also after a restart
        std::fs::remove_file(dir.join(DIR)).unwrap();
        s.finish("acme", "c_1", KEY16, 201, &json!({"job": "j_1"})).unwrap();
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 102), Begin::Replay { status: 201, body: json!({"job": "j_1"}) });
        assert_eq!(IdemStore::load(Some(&dir)).begin("acme", "c_1", KEY16, &body, 103), Begin::Replay { status: 201, body: json!({"job": "j_1"}) });
        // a finished key is not finished again
        s.finish("acme", "c_1", KEY16, 201, &json!({"job": "j_2"})).unwrap();
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 104), Begin::Replay { status: 201, body: json!({"job": "j_1"}) });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_busy_mismatch_and_expiry() {
        let dir = std::env::temp_dir().join(format!("lucid-api-idem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = IdemStore::load(Some(&dir));
        let body = json!({"org": "acme", "hold": {"on": ["ann@acme.example"]}, "reason": "matter 7"});
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 100), Begin::Fresh);
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 101), Begin::Refused(BUSY));
        assert_eq!(s.begin("acme", "c_1", KEY16, &json!({"other": 1}), 101), Begin::Refused(MISMATCH));
        assert_eq!(s.begin("acme", "c_2", KEY16, &body, 101), Begin::Fresh, "keys are per client");
        s.finish("acme", "c_1", KEY16, 201, &json!({"hold": "h_1"})).unwrap();
        assert_eq!(s.begin("acme", "c_1", KEY16, &body, 102), Begin::Replay { status: 201, body: json!({"hold": "h_1"}) });
        // the answer survives a restart; a running one does not
        let back = IdemStore::load(Some(&dir));
        assert_eq!(back.begin("acme", "c_1", KEY16, &body, 103), Begin::Replay { status: 201, body: json!({"hold": "h_1"}) });
        assert_eq!(back.begin("acme", "c_2", KEY16, &body, 103), Begin::Fresh);
        // 24 hours later the key starts afresh
        assert_eq!(back.begin("acme", "c_1", KEY16, &body, 100 + KEEP_S), Begin::Fresh);
        // a 5xx answer is not kept
        back.finish("acme", "c_1", KEY16, 503, &json!({})).unwrap();
        assert_eq!(back.begin("acme", "c_1", KEY16, &body, 100 + KEEP_S), Begin::Fresh);
        back.abandon("acme", "c_1", KEY16);
        assert_eq!(back.begin("acme", "c_1", KEY16, &json!({"other": 1}), 100 + KEEP_S), Begin::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
