// Contract API-1 revision 5 (phase 1c), section 2.7 (the content store), with 2.6 (revocation counts as removal)
// and the O5 rule (a removed app's store for a conversation is deleted within 1 hour). The construction is the
// archive's (`connector/README.md` 9, Python `archive.py` `ArchiveStore`): each record AES-256-GCM under a key
// derived with HKDF-SHA-384 from a data key that the sealing key wraps.
//
// Layout: `state_dir/store/<app>/<cid hash>.db/` is one conversation: `index.bin` (the sealed index: the
// conversation id and kind, its stop mark, and per message its time, size, keyword tokens and file ids, from which
// the keyword index of normalized lowercase word tokens to mids is rebuilt in memory) and one sealed `<rid>.rec`
// per message; `files/<fid hash>-<cached ms>.bin` caches file bytes for at most 24 hours. `state_dir/store/<app>/
// app.bin` holds the app's own stop mark. Every app has its own 32-byte data key, sealed as `store-key-<app>`
// (`connector_seal`); `forget` deletes it with the folder. Folder and record names are HMAC-SHA-256 of the ids
// under a key derived from the data key, so a name reveals no id.
//
// Crash safety: the index is the source of truth. A put writes the record, then the index; a delete writes the
// index, then removes the record and its cached files (each write atomic and fsynced, each removal fsynced), so a
// delete has erased the record and its index entries before it returns and the caller acknowledges only after.
// Records the index does not name and temporary files are removed at open.
//
// Stops (2.7): a conversation or a whole app can be stopped with a reason. Reads consult the marks at once
// (`StoreError::Stopped`). `removed` and `revoked` purge at the next `maintenance` (run every
// `connector::MAINTENANCE_EVERY`, so within the hour O5 allows); `policy` (a policy without the app)
// and `expired` (a certificate past its grace) purge 24 hours after it unless the app comes back (`resume`,
// `resume_app`). `maintenance(now)` runs due purges, the daily retention by kind and the `store_max_bytes` cap
// (oldest records first), expires cached files, and reports what it did. The clock is always a parameter.

use crate::codec::hex;
use crate::connector_enroll::app_name_ok;
use crate::connector_seal::{gcm_open, gcm_seal, hkdf_sha384, make_private_dir, names, remove_dir_durable, remove_durable, wipe, write_private, SealedStore, SecretKey, TMP_PREFIX};
use crate::meet_org_policy::lp;
use aws_lc_rs::hmac;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const STORE_DIR: &str = "store";
pub const DAY_MS: i64 = 86_400_000;
/// How long fetched file bytes are cached (2.7).
pub const FILE_CACHE_MS: i64 = DAY_MS;
/// `store_max_bytes` (2.2): 1 GiB to 1 TiB, default 64 GiB.
pub const STORE_MAX_MIN: u64 = 1 << 30;
pub const STORE_MAX_MAX: u64 = 1 << 40;
pub const STORE_MAX_DEFAULT: u64 = 64 << 30;
const RECORD_INFO: &[u8] = b"lucid-api-connector-record-v1";
const NAME_INFO: &[u8] = b"lucid-api-connector-name-v1";
const MAGIC: &[u8] = b"LCS1";
const INDEX_FILE: &str = "index.bin";
const APP_FILE: &str = "app.bin";
const FILES_DIR: &str = "files";
const CONV_EXT: &str = ".db";
const RECORD_EXT: &str = ".rec";
const FILE_EXT: &str = ".bin";
/// Longer tokens are not indexed.
const WORD_MAX_CHARS: usize = 64;
const ID_MAX: usize = 256;

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────

/// Why serving stopped (2.6, 2.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// A verified member-log entry removed the app (or it left): purge within 1 hour (O5).
    Removed,
    /// The app certificate is revoked: removal from every conversation.
    Revoked,
    /// The pinned org policy no longer lists the app: purge after 24 hours unless it comes back.
    Policy,
    /// The app certificate is past its grace: purge after 24 hours unless it comes back.
    Expired,
}

impl StopReason {
    pub fn code(self) -> &'static str {
        match self {
            StopReason::Removed => "removed",
            StopReason::Revoked => "revoked",
            StopReason::Policy => "policy",
            StopReason::Expired => "expired",
        }
    }

    fn parse(s: &str) -> Option<StopReason> {
        match s {
            "removed" => Some(StopReason::Removed),
            "revoked" => Some(StopReason::Revoked),
            "policy" => Some(StopReason::Policy),
            "expired" => Some(StopReason::Expired),
            _ => None,
        }
    }

    /// From the mark to the purge. A removal is due at once: the next `maintenance` (at most
    /// `connector::MAINTENANCE_EVERY` later) deletes it, within the hour O5 allows.
    pub fn delay_ms(self) -> i64 {
        match self {
            StopReason::Removed | StopReason::Revoked => 0,
            StopReason::Policy | StopReason::Expired => DAY_MS,
        }
    }

    /// Whether the app coming back cancels the purge (and keeps the store).
    pub fn cancellable(self) -> bool {
        matches!(self, StopReason::Policy | StopReason::Expired)
    }
}

/// A stop: since `at`, purged at the first `maintenance` at or after `purge_at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub reason: StopReason,
    pub at: i64,
    pub purge_at: i64,
}

/// A new stop on top of an earlier one: the earlier purge time wins, and a reason the app's return does not cancel
/// is never replaced by one it does.
fn merge(old: Option<Mark>, reason: StopReason, now_ms: i64) -> Mark {
    let new = Mark { reason, at: now_ms, purge_at: now_ms + reason.delay_ms() };
    let Some(old) = old else { return new };
    let reason = if old.reason.cancellable() { new.reason } else { old.reason };
    Mark { reason, at: old.at.min(now_ms), purge_at: old.purge_at.min(new.purge_at) }
}

fn mark_json(m: Option<Mark>) -> Value {
    match m {
        None => Value::Null,
        Some(m) => json!({"reason": m.reason.code(), "at": m.at, "purge_at": m.purge_at}),
    }
}

fn mark_of(v: Option<&Value>) -> Option<Mark> {
    let o = v?.as_object()?;
    Some(Mark { reason: StopReason::parse(o.get("reason")?.as_str()?)?, at: o.get("at")?.as_i64()?, purge_at: o.get("purge_at")?.as_i64()? })
}

/// Why a store call did not answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// Serving stopped for that conversation or app; the reason code (`removed`, `revoked`, `policy`, `expired`).
    Stopped(&'static str),
    /// A malformed argument.
    Invalid(String),
    /// A file could not be read, written or opened with its key.
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Stopped(why) => write!(f, "serving stopped ({why})"),
            StoreError::Invalid(m) | StoreError::Io(m) => f.write_str(m),
        }
    }
}

fn io(e: std::io::Error) -> StoreError {
    StoreError::Io(e.to_string())
}

/// One reaction on a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reaction {
    pub emoji: String,
    pub from: String,
    pub ts: i64,
}

/// A message the app could decrypt, as verified (CE-1): sender principal and device, time (ms), thread and reply,
/// content kind, text (the latest edit's, with its time), file descriptors (CE-1 9) and reactions.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredMessage {
    pub mid: String,
    pub from: String,
    pub device: String,
    pub ts: i64,
    pub thread: Option<String>,
    pub reply: Option<String>,
    pub kind: String,
    pub text: String,
    pub edited: Option<i64>,
    pub files: Vec<Value>,
    pub reactions: Vec<Reaction>,
    /// The CE-1 `post` payload's mentions (`m`, principals; r5 7.2 `mentions`). Empty in records written before 1c4.
    pub mentions: Vec<String>,
    /// The revision 9 `dlg` of a delegated or program post (r5 7.2 `via`), as verified.
    pub dlg: Option<Value>,
}

impl StoredMessage {
    pub fn to_json(&self) -> Value {
        let reactions: Vec<Value> = self.reactions.iter().map(|r| json!({"emoji": r.emoji, "from": r.from, "ts": r.ts})).collect();
        let mut v = json!({
            "mid": self.mid, "from": self.from, "device": self.device, "ts": self.ts, "thread": self.thread, "reply": self.reply,
            "kind": self.kind, "text": self.text, "edited": self.edited, "files": self.files, "reactions": reactions
        });
        if !self.mentions.is_empty() {
            v["mentions"] = json!(self.mentions);
        }
        if let Some(d) = &self.dlg {
            v["dlg"] = d.clone();
        }
        v
    }

    pub fn from_json(v: &Value) -> Option<StoredMessage> {
        let o = v.as_object()?;
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        let reactions: Vec<Reaction> = o
            .get("reactions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|r| Some(Reaction { emoji: r.get("emoji")?.as_str()?.to_string(), from: r.get("from")?.as_str()?.to_string(), ts: r.get("ts")?.as_i64()? })).collect())
            .unwrap_or_default();
        Some(StoredMessage {
            mid: s("mid")?,
            from: s("from")?,
            device: s("device").unwrap_or_default(),
            ts: o.get("ts")?.as_i64()?,
            thread: s("thread"),
            reply: s("reply"),
            kind: s("kind").unwrap_or_default(),
            text: s("text").unwrap_or_default(),
            edited: o.get("edited").and_then(Value::as_i64),
            files: o.get("files").and_then(Value::as_array).cloned().unwrap_or_default(),
            reactions,
            mentions: o.get("mentions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
            dlg: o.get("dlg").filter(|d| d.is_object()).cloned(),
        })
    }

    fn fids(&self) -> Vec<String> {
        self.files.iter().filter_map(|f| f.get("fid").and_then(Value::as_str)).map(str::to_string).collect()
    }

    /// The keyword tokens of the text and of the file names.
    fn words(&self) -> Vec<String> {
        let mut text = self.text.clone();
        for f in &self.files {
            if let Some(n) = f.get("name").and_then(Value::as_str) {
                text.push(' ');
                text.push_str(n);
            }
        }
        tokens(&text)
    }
}

/// Normalized keyword tokens: maximal runs of letters and digits, lowercased, at most 64 characters, sorted and
/// without repeats.
pub fn tokens(text: &str) -> Vec<String> {
    let set: BTreeSet<String> = text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).filter(|w| w.chars().count() <= WORD_MAX_CHARS).collect();
    set.into_iter().collect()
}

/// A purge done (audit `connector.store.purged`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Purged {
    pub app: String,
    /// None when the whole app's store went.
    pub cid: Option<String>,
    /// `removed`, `revoked`, `policy`, `expired` or `forget`.
    pub reason: &'static str,
    pub records: u64,
    pub bytes: u64,
}

/// What one `maintenance` did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub purged: Vec<Purged>,
    /// Records deleted by retention (0 when the daily run was not due).
    pub retention_deleted: u64,
    /// Records deleted, oldest first, to stay within `store_max_bytes`.
    pub cap_deleted: u64,
    /// Cached files past 24 hours removed.
    pub files_expired: u64,
    /// The store's size after it (`lucid_connector_store_bytes`): sealed records and cached files.
    pub bytes: u64,
    /// Steps that failed (each is tried again at the next run).
    pub errors: Vec<String>,
}

/// One conversation of an app, as `conversations` lists it.
// Test-only: what the store and session tests read back through `ContentStore::conversations`.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConvInfo {
    pub cid: String,
    pub kind: String,
    pub records: u64,
    pub stopped: Option<Mark>,
}

// ── keys and sealing ────────────────────────────────────────────────────────────────────────────────────────

struct Keys {
    data: SecretKey,
    names: SecretKey,
}

impl Keys {
    fn new(data: SecretKey) -> Result<Keys, String> {
        let names = hkdf_sha384(data.bytes(), NAME_INFO)?;
        Ok(Keys { data, names })
    }

    /// 32 hex of HMAC-SHA-256 under the name key over `lp(parts)`.
    fn hname(&self, parts: &[&[u8]]) -> String {
        let k = hmac::Key::new(hmac::HMAC_SHA256, self.names.bytes());
        hex(&hmac::sign(&k, &lp(parts)).as_ref()[..16])
    }

    fn conv_name(&self, cid: &str) -> String {
        format!("{}{CONV_EXT}", self.hname(&["cid".as_bytes(), cid.as_bytes()]))
    }

    fn rid(&self, cid: &str, mid: &str) -> String {
        self.hname(&["record".as_bytes(), cid.as_bytes(), mid.as_bytes()])
    }

    fn file_stem(&self, cid: &str, fid: &str) -> String {
        self.hname(&["file".as_bytes(), cid.as_bytes(), fid.as_bytes()])
    }

    /// `MAGIC || nonce || ct || tag`, AES-256-GCM under HKDF-SHA-384(data key, lp(label, rid)), additional data
    /// `lp(app, scope, rid)`.
    fn seal(&self, app: &str, scope: &str, rid: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        let k = hkdf_sha384(self.data.bytes(), &lp(&[RECORD_INFO, rid.as_bytes()]))?;
        let body = gcm_seal(&k, &lp(&[app.as_bytes(), scope.as_bytes(), rid.as_bytes()]), plain)?;
        Ok([MAGIC, body.as_slice()].concat())
    }

    fn open(&self, app: &str, scope: &str, rid: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
        if !blob.starts_with(MAGIC) {
            return Err("a stored record is not sealed".to_string());
        }
        let k = hkdf_sha384(self.data.bytes(), &lp(&[RECORD_INFO, rid.as_bytes()]))?;
        gcm_open(&k, &lp(&[app.as_bytes(), scope.as_bytes(), rid.as_bytes()]), &blob[MAGIC.len()..]).ok_or_else(|| "a stored record could not be opened (another key, or the file was changed)".to_string())
    }
}

// ── conversations ───────────────────────────────────────────────────────────────────────────────────────────

struct Entry {
    ts: i64,
    bytes: u64,
    words: Vec<String>,
    fids: Vec<String>,
}

struct Conv {
    cid: String,
    /// The folder's name (`<cid hash>.db`), bound into the index's sealing.
    name: String,
    dir: PathBuf,
    kind: String,
    mark: Option<Mark>,
    entries: BTreeMap<String, Entry>,
    /// The keyword index: token to mids.
    words: BTreeMap<String, BTreeSet<String>>,
}

impl Conv {
    fn index(&mut self, mid: &str, words: &[String]) {
        for w in words {
            self.words.entry(w.clone()).or_default().insert(mid.to_string());
        }
    }

    fn unindex(&mut self, mid: &str, words: &[String]) {
        for w in words {
            if let Some(set) = self.words.get_mut(w) {
                set.remove(mid);
                if set.is_empty() {
                    self.words.remove(w);
                }
            }
        }
    }

    fn bytes(&self) -> u64 {
        self.entries.values().map(|e| e.bytes).sum()
    }

    fn record_path(&self, keys: &Keys, mid: &str) -> PathBuf {
        self.dir.join(format!("{}{RECORD_EXT}", keys.rid(&self.cid, mid)))
    }

    fn to_json(&self) -> Value {
        let records: Map<String, Value> = self.entries.iter().map(|(m, e)| (m.clone(), json!({"ts": e.ts, "bytes": e.bytes, "words": e.words, "fids": e.fids}))).collect();
        json!({"v": 1, "cid": self.cid, "kind": self.kind, "mark": mark_json(self.mark), "records": records})
    }

    fn from_json(v: &Value, dir: PathBuf, name: String) -> Option<Conv> {
        let o = v.as_object()?;
        let mut conv = Conv {
            cid: o.get("cid")?.as_str()?.to_string(),
            name,
            dir,
            kind: o.get("kind").and_then(Value::as_str).unwrap_or_default().to_string(),
            mark: mark_of(o.get("mark")),
            entries: BTreeMap::new(),
            words: BTreeMap::new(),
        };
        for (mid, e) in o.get("records")?.as_object()? {
            let strs = |k: &str| -> Vec<String> { e.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default() };
            let entry = Entry { ts: e.get("ts")?.as_i64()?, bytes: e.get("bytes").and_then(Value::as_u64).unwrap_or(0), words: strs("words"), fids: strs("fids") };
            conv.index(mid, &entry.words);
            conv.entries.insert(mid.clone(), entry);
        }
        Some(conv)
    }
}

fn save_conv(app: &str, keys: &Keys, conv: &Conv) -> Result<(), StoreError> {
    let plain = serde_json::to_vec(&conv.to_json()).map_err(|_| StoreError::Io("a conversation index could not be encoded".to_string()))?;
    let blob = keys.seal(app, &conv.name, "index", &plain).map_err(StoreError::Io)?;
    write_private(&conv.dir.join(INDEX_FILE), &blob).map_err(io)
}

fn write_record(app: &str, keys: &Keys, conv: &Conv, msg: &StoredMessage) -> Result<u64, StoreError> {
    let plain = serde_json::to_vec(&msg.to_json()).map_err(|_| StoreError::Io("a record could not be encoded".to_string()))?;
    let blob = keys.seal(app, &conv.cid, &keys.rid(&conv.cid, &msg.mid), &plain).map_err(StoreError::Io)?;
    write_private(&conv.record_path(keys, &msg.mid), &blob).map_err(io)?;
    Ok(blob.len() as u64)
}

fn read_record(app: &str, keys: &Keys, conv: &Conv, mid: &str) -> Result<Option<StoredMessage>, StoreError> {
    if !conv.entries.contains_key(mid) {
        return Ok(None);
    }
    let blob = std::fs::read(conv.record_path(keys, mid)).map_err(io)?;
    let plain = keys.open(app, &conv.cid, &keys.rid(&conv.cid, mid), &blob).map_err(StoreError::Io)?;
    let v: Value = serde_json::from_slice(&plain).map_err(|_| StoreError::Io("a record is not JSON".to_string()))?;
    StoredMessage::from_json(&v).map(Some).ok_or_else(|| StoreError::Io("a record does not read".to_string()))
}

/// The cached files of a conversation: (path, file name stem, cached ms, size).
fn cached(conv: &Conv) -> Vec<(PathBuf, String, i64, u64)> {
    let Ok(list) = std::fs::read_dir(conv.dir.join(FILES_DIR)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in list.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some((stem, ms)) = name.strip_suffix(FILE_EXT).and_then(|n| n.rsplit_once('-')) else { continue };
        let Ok(ms) = ms.parse::<i64>() else { continue };
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        out.push((e.path(), stem.to_string(), ms, size));
    }
    out
}

fn remove_cached(keys: &Keys, conv: &Conv, fid: &str) -> Result<(), StoreError> {
    let stem = keys.file_stem(&conv.cid, fid);
    for (path, s, _, _) in cached(conv) {
        if s == stem {
            remove_durable(&path).map_err(io)?;
        }
    }
    Ok(())
}

/// Erase messages: the index first (durable), then each record and its cached files. Ok is how many there were.
fn delete_mids(app: &str, keys: &Keys, conv: &mut Conv, mids: &[String]) -> Result<u64, StoreError> {
    let mut gone = Vec::new();
    for mid in mids {
        if let Some(e) = conv.entries.remove(mid) {
            conv.unindex(mid, &e.words);
            gone.push((mid.clone(), e));
        }
    }
    if gone.is_empty() {
        return Ok(0);
    }
    if let Err(e) = save_conv(app, keys, conv) {
        for (mid, entry) in gone {
            conv.index(&mid, &entry.words);
            conv.entries.insert(mid, entry);
        }
        return Err(e);
    }
    for (mid, e) in &gone {
        remove_durable(&conv.record_path(keys, mid)).map_err(io)?;
        for fid in &e.fids {
            remove_cached(keys, conv, fid)?;
        }
    }
    Ok(gone.len() as u64)
}

fn load_conv(app: &str, keys: &Keys, dir: &Path, name: &str) -> Result<Option<Conv>, String> {
    let blob = match std::fs::read(dir.join(INDEX_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} could not be read: {e}", dir.display())),
    };
    let plain = keys.open(app, name, "index", &blob)?;
    let v: Value = serde_json::from_slice(&plain).map_err(|_| "a conversation index is not JSON".to_string())?;
    let conv = Conv::from_json(&v, dir.to_path_buf(), name.to_string()).ok_or("a conversation index does not read")?;
    if keys.conv_name(&conv.cid) != name {
        return Err("a conversation index is in another conversation's folder".to_string());
    }
    // records the index does not name (a put or a delete cut short) and temporary files
    let keep: BTreeSet<String> = conv.entries.keys().map(|m| format!("{}{RECORD_EXT}", keys.rid(&conv.cid, m))).collect();
    let list = std::fs::read_dir(dir).map_err(|e| format!("{} could not be listed: {e}", dir.display()))?;
    for e in list.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if (n.ends_with(RECORD_EXT) && !keep.contains(&n)) || n.starts_with(TMP_PREFIX) {
            remove_durable(&e.path()).map_err(|e| format!("a stale record could not be removed: {e}"))?;
        }
    }
    Ok(Some(conv))
}

// ── apps ────────────────────────────────────────────────────────────────────────────────────────────────────

struct AppStore {
    dir: PathBuf,
    keys: Keys,
    mark: Option<Mark>,
    convs: BTreeMap<String, Conv>,
}

impl AppStore {
    fn records(&self) -> u64 {
        self.convs.values().map(|c| c.entries.len() as u64).sum()
    }
    fn bytes(&self) -> u64 {
        self.convs.values().map(Conv::bytes).sum()
    }
}

fn save_app_mark(app: &str, a: &AppStore) -> Result<(), StoreError> {
    let path = a.dir.join(APP_FILE);
    match a.mark {
        None => remove_durable(&path).map_err(io),
        Some(m) => {
            let plain = serde_json::to_vec(&mark_json(Some(m))).map_err(|_| StoreError::Io("a mark could not be encoded".to_string()))?;
            let blob = a.keys.seal(app, "", "app", &plain).map_err(StoreError::Io)?;
            write_private(&path, &blob).map_err(io)
        }
    }
}

fn store_key(raw: Option<Vec<u8>>) -> Result<Option<SecretKey>, String> {
    match raw {
        None => Ok(None),
        Some(mut b) => {
            let k = SecretKey::from_slice(&b);
            wipe(&mut b);
            k.map(Some).ok_or_else(|| "a store key is not 32 bytes".to_string())
        }
    }
}

fn load_app(root: &Path, app: &str, sealed: &SealedStore) -> Result<Option<AppStore>, String> {
    let dir = root.join(app);
    let Some(data) = store_key(sealed.get_bytes(&names::store_key(app))?)? else {
        // no key opens what is there (a forget cut short after its key went): nothing in it can be read
        remove_dir_durable(&dir).map_err(|e| format!("{} could not be removed: {e}", dir.display()))?;
        return Ok(None);
    };
    let keys = Keys::new(data)?;
    let mark = match std::fs::read(dir.join(APP_FILE)) {
        Ok(blob) => {
            let plain = keys.open(app, "", "app", &blob)?;
            mark_of(serde_json::from_slice::<Value>(&plain).ok().as_ref())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{} could not be read: {e}", dir.display())),
    };
    let mut convs = BTreeMap::new();
    let list = std::fs::read_dir(&dir).map_err(|e| format!("{} could not be listed: {e}", dir.display()))?;
    for e in list.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(TMP_PREFIX) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if !path.is_dir() || !name.ends_with(CONV_EXT) {
            continue;
        }
        match load_conv(app, &keys, &path, &name)? {
            Some(c) => {
                convs.insert(c.cid.clone(), c);
            }
            // a conversation whose first put was cut short before its index
            None => remove_dir_durable(&path).map_err(|e| format!("{} could not be removed: {e}", path.display()))?,
        }
    }
    Ok(Some(AppStore { dir, keys, mark, convs }))
}

fn serving(a: &AppStore, conv: Option<&Conv>) -> Result<(), StoreError> {
    if let Some(m) = a.mark {
        return Err(StoreError::Stopped(m.reason.code()));
    }
    if let Some(m) = conv.and_then(|c| c.mark) {
        return Err(StoreError::Stopped(m.reason.code()));
    }
    Ok(())
}

fn check_app(app: &str) -> Result<(), StoreError> {
    if app_name_ok(app) {
        Ok(())
    } else {
        Err(StoreError::Invalid(crate::connector_enroll::BAD_APP_NAME.to_string()))
    }
}

fn check_id(what: &str, id: &str) -> Result<(), StoreError> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err(StoreError::Invalid(format!("{what} must be 1 to {ID_MAX} bytes")));
    }
    Ok(())
}

/// The retention of a record in ms: the shortest of its conversation kind's and, when it carries files, `files`
/// (days from the org policy; 0 or absent keeps forever).
fn retention_ms(days: &BTreeMap<String, u32>, kind: &str, has_files: bool) -> Option<i64> {
    let mut kinds = vec![kind];
    if has_files {
        kinds.push("files");
    }
    kinds.into_iter().filter_map(|k| days.get(k).copied()).filter(|d| *d > 0).map(|d| i64::from(d) * DAY_MS).min()
}

struct Inner {
    apps: BTreeMap<String, AppStore>,
    last_retention: Option<i64>,
}

/// The connector's content store (2.7).
pub struct ContentStore {
    root: PathBuf,
    sealed: Arc<SealedStore>,
    inner: Mutex<Inner>,
}

impl ContentStore {
    /// Open `state_dir/store`, loading every app's conversation indexes (and removing what a cut-short write left).
    pub fn open(state_dir: &Path, sealed: Arc<SealedStore>) -> Result<ContentStore, String> {
        let root = state_dir.join(STORE_DIR);
        make_private_dir(&root).map_err(|e| format!("{} could not be made: {e}", root.display()))?;
        let mut apps = BTreeMap::new();
        let list = std::fs::read_dir(&root).map_err(|e| format!("{} could not be listed: {e}", root.display()))?;
        for e in list.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !e.path().is_dir() || !app_name_ok(&name) {
                continue;
            }
            if let Some(a) = load_app(&root, &name, &sealed)? {
                apps.insert(name, a);
            }
        }
        Ok(ContentStore { root, sealed, inner: Mutex::new(Inner { apps, last_retention: None }) })
    }

    fn app_for_write<'a>(&self, inner: &'a mut Inner, app: &str) -> Result<&'a mut AppStore, StoreError> {
        if !inner.apps.contains_key(app) {
            let name = names::store_key(app);
            let data = match store_key(self.sealed.get_bytes(&name).map_err(StoreError::Io)?).map_err(StoreError::Io)? {
                Some(k) => k,
                None => {
                    let k = SecretKey::random().map_err(StoreError::Io)?;
                    self.sealed.put_bytes(&name, k.bytes()).map_err(StoreError::Io)?;
                    k
                }
            };
            let dir = self.root.join(app);
            make_private_dir(&dir).map_err(io)?;
            let keys = Keys::new(data).map_err(StoreError::Io)?;
            inner.apps.insert(app.to_string(), AppStore { dir, keys, mark: None, convs: BTreeMap::new() });
        }
        inner.apps.get_mut(app).ok_or_else(|| StoreError::Io("the app store could not be made".to_string()))
    }

    /// Keep a verified message of conversation `cid` (`conv_kind`: `dm`, `group` or `channel`). False when it is
    /// already kept (a redelivery). Refused while serving is stopped for it.
    pub fn put(&self, app: &str, cid: &str, conv_kind: &str, msg: &StoredMessage) -> Result<bool, StoreError> {
        check_app(app)?;
        check_id("cid", cid)?;
        check_id("mid", &msg.mid)?;
        let mut inner = self.inner.lock();
        let a = self.app_for_write(&mut inner, app)?;
        serving(a, a.convs.get(cid))?;
        if !a.convs.contains_key(cid) {
            let name = a.keys.conv_name(cid);
            let dir = a.dir.join(&name);
            make_private_dir(&dir).map_err(io)?;
            a.convs.insert(cid.to_string(), Conv { cid: cid.to_string(), name, dir, kind: conv_kind.to_string(), mark: None, entries: BTreeMap::new(), words: BTreeMap::new() });
        }
        let Some(conv) = a.convs.get_mut(cid) else { return Err(StoreError::Io("the conversation could not be made".to_string())) };
        if conv.entries.contains_key(&msg.mid) {
            return Ok(false);
        }
        let bytes = write_record(app, &a.keys, conv, msg)?;
        let words = msg.words();
        let old_kind = std::mem::replace(&mut conv.kind, conv_kind.to_string());
        conv.index(&msg.mid, &words);
        conv.entries.insert(msg.mid.clone(), Entry { ts: msg.ts, bytes, words, fids: msg.fids() });
        if let Err(e) = save_conv(app, &a.keys, conv) {
            if let Some(entry) = conv.entries.remove(&msg.mid) {
                conv.unindex(&msg.mid, &entry.words);
            }
            conv.kind = old_kind;
            let _ = remove_durable(&conv.record_path(&a.keys, &msg.mid));
            return Err(e);
        }
        Ok(true)
    }

    /// Apply a verified edit: the latest text with its edit time. False when the message is not kept or a later
    /// edit already applies.
    pub fn edit(&self, app: &str, cid: &str, mid: &str, text: &str, edit_ts: i64) -> Result<bool, StoreError> {
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(false) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get_mut(cid) else { return Ok(false) };
        let Some(mut msg) = read_record(app, &a.keys, conv, mid)? else { return Ok(false) };
        if msg.edited.is_some_and(|e| e >= edit_ts) {
            return Ok(false);
        }
        msg.text = text.to_string();
        msg.edited = Some(edit_ts);
        let bytes = write_record(app, &a.keys, conv, &msg)?;
        let words = msg.words();
        let Some(e) = conv.entries.get_mut(mid) else { return Ok(false) };
        e.bytes = bytes;
        let old = std::mem::replace(&mut e.words, words.clone());
        conv.unindex(mid, &old);
        conv.index(mid, &words);
        save_conv(app, &a.keys, conv)?;
        Ok(true)
    }

    /// Add or remove a verified reaction. False when the message is not kept or nothing changed.
    #[allow(clippy::too_many_arguments)]
    pub fn react(&self, app: &str, cid: &str, mid: &str, emoji: &str, from: &str, add: bool, ts: i64) -> Result<bool, StoreError> {
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(false) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get_mut(cid) else { return Ok(false) };
        let Some(mut msg) = read_record(app, &a.keys, conv, mid)? else { return Ok(false) };
        let had = msg.reactions.iter().any(|r| r.emoji == emoji && r.from == from);
        if add == had {
            return Ok(false);
        }
        if add {
            msg.reactions.push(Reaction { emoji: emoji.to_string(), from: from.to_string(), ts });
        } else {
            msg.reactions.retain(|r| !(r.emoji == emoji && r.from == from));
        }
        let bytes = write_record(app, &a.keys, conv, &msg)?;
        if let Some(e) = conv.entries.get_mut(mid) {
            e.bytes = bytes;
        }
        save_conv(app, &a.keys, conv)?;
        Ok(true)
    }

    /// Apply a verified CE-1 delete: the record, its index entries and its cached files are erased durably before
    /// this returns (acknowledge the event only after Ok). Also while serving is stopped. True when it was kept.
    pub fn delete(&self, app: &str, cid: &str, mid: &str) -> Result<bool, StoreError> {
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(false) };
        let Some(conv) = a.convs.get_mut(cid) else { return Ok(false) };
        let n = delete_mids(app, &a.keys, conv, &[mid.to_string()])?;
        if n == 0 {
            remove_durable(&conv.record_path(&a.keys, mid)).map_err(io)?;
        }
        Ok(n > 0)
    }

    pub fn get(&self, app: &str, cid: &str, mid: &str) -> Result<Option<StoredMessage>, StoreError> {
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Ok(None) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get(cid) else { return Ok(None) };
        read_record(app, &a.keys, conv, mid)
    }

    /// The message of conversation `cid` that carries the file `fid` (r5 7.1 file bytes), None when none does.
    pub fn holder_of(&self, app: &str, cid: &str, fid: &str) -> Result<Option<String>, StoreError> {
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Ok(None) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get(cid) else { return Ok(None) };
        Ok(conv.entries.iter().find(|(_, e)| e.fids.iter().any(|f| f == fid)).map(|(m, _)| m.clone()))
    }

    /// A page of a conversation, newest first: at most `limit` messages before the cursor `(ts, mid)` (exclusive;
    /// None starts at the newest).
    pub fn page(&self, app: &str, cid: &str, before: Option<(i64, &str)>, limit: usize) -> Result<Vec<StoredMessage>, StoreError> {
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Ok(Vec::new()) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get(cid) else { return Ok(Vec::new()) };
        let mut order: Vec<(i64, &str)> = conv.entries.iter().map(|(m, e)| (e.ts, m.as_str())).filter(|k| before.is_none_or(|b| *k < b)).collect();
        order.sort_unstable_by(|x, y| y.cmp(x));
        order.truncate(limit);
        order.iter().map(|(_, mid)| read_record(app, &a.keys, conv, mid)?.ok_or_else(|| StoreError::Io("an indexed record is missing".to_string()))).collect()
    }

    /// Keyword search within the conversations `cids` of an app: messages holding every token of `query`, newest
    /// first, at most `limit`, each with its conversation. Conversations whose serving stopped are left out.
    pub fn search(&self, app: &str, cids: &[String], query: &str, limit: usize) -> Result<Vec<(String, StoredMessage)>, StoreError> {
        let words = tokens(query);
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Ok(Vec::new()) };
        serving(a, None)?;
        let mut hits: Vec<(i64, &str, &str)> = Vec::new();
        for cid in cids {
            let Some(conv) = a.convs.get(cid.as_str()) else { continue };
            if conv.mark.is_some() {
                continue;
            }
            let mut found: Option<BTreeSet<&String>> = None;
            for w in &words {
                let Some(set) = conv.words.get(w) else {
                    found = Some(BTreeSet::new());
                    break;
                };
                found = Some(match found {
                    None => set.iter().collect(),
                    Some(f) => f.into_iter().filter(|m| set.contains(*m)).collect(),
                });
            }
            for mid in found.unwrap_or_default() {
                if let Some(e) = conv.entries.get(mid) {
                    hits.push((e.ts, conv.cid.as_str(), mid.as_str()));
                }
            }
        }
        hits.sort_unstable_by(|x, y| y.cmp(x));
        hits.truncate(limit);
        hits.iter()
            .map(|(_, cid, mid)| {
                let conv = &a.convs[*cid];
                let msg = read_record(app, &a.keys, conv, mid)?.ok_or_else(|| StoreError::Io("an indexed record is missing".to_string()))?;
                Ok((cid.to_string(), msg))
            })
            .collect()
    }

    /// The app's conversations in the store.
    // Test-only: the store and session tests check what a purge or a delete left.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn conversations(&self, app: &str) -> Vec<ConvInfo> {
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Vec::new() };
        a.convs.values().map(|c| ConvInfo { cid: c.cid.clone(), kind: c.kind.clone(), records: c.entries.len() as u64, stopped: c.mark.or(a.mark) }).collect()
    }

    /// Stop serving a conversation at once and schedule its purge (`removed`: the next `maintenance`, within 1 hour,
    /// O5; `policy` and `expired`: 24 hours). Nothing to do when it holds nothing. The stop holds in memory even when writing it fails.
    pub fn stop(&self, app: &str, cid: &str, reason: StopReason, now_ms: i64) -> Result<(), StoreError> {
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(()) };
        let Some(conv) = a.convs.get_mut(cid) else { return Ok(()) };
        conv.mark = Some(merge(conv.mark, reason, now_ms));
        save_conv(app, &a.keys, conv)
    }

    /// Stop serving every conversation of an app at once (a policy without it, an expired or revoked certificate)
    /// and schedule the purge of its whole store.
    pub fn stop_app(&self, app: &str, reason: StopReason, now_ms: i64) -> Result<(), StoreError> {
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(()) };
        a.mark = Some(merge(a.mark, reason, now_ms));
        save_app_mark(app, a)
    }

    /// The app is back in a conversation: a `policy` or `expired` stop is cancelled and the store kept; a `removed`
    /// or `revoked` one is purged now (the app reads only what comes after its return). Some is the purge done.
    pub fn resume(&self, app: &str, cid: &str, now_ms: i64) -> Result<Option<Purged>, StoreError> {
        let _ = now_ms;
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(None) };
        let Some(conv) = a.convs.get_mut(cid) else { return Ok(None) };
        let Some(m) = conv.mark else { return Ok(None) };
        if m.reason.cancellable() {
            conv.mark = None;
            save_conv(app, &a.keys, conv)?;
            return Ok(None);
        }
        purge_conv(a, app, cid, m.reason.code()).map(Some)
    }

    /// The app is back (in the policy, or with a valid certificate): as `resume`, for the app's own stop.
    pub fn resume_app(&self, app: &str, now_ms: i64) -> Result<Option<Purged>, StoreError> {
        let _ = now_ms;
        let mut inner = self.inner.lock();
        let Some(a) = inner.apps.get_mut(app) else { return Ok(None) };
        let Some(m) = a.mark else { return Ok(None) };
        if m.reason.cancellable() {
            a.mark = None;
            save_app_mark(app, a)?;
            return Ok(None);
        }
        self.purge_app(&mut inner, app, m.reason.code()).map(Some)
    }

    /// `connector forget --app <name>`: the app's whole store and its data key, now.
    pub fn forget(&self, app: &str) -> Result<Purged, StoreError> {
        check_app(app)?;
        let mut inner = self.inner.lock();
        self.purge_app(&mut inner, app, "forget")
    }

    fn purge_app(&self, inner: &mut Inner, app: &str, reason: &'static str) -> Result<Purged, StoreError> {
        let (records, bytes) = inner.apps.get(app).map(|a| (a.records(), a.bytes())).unwrap_or((0, 0));
        remove_dir_durable(&self.root.join(app)).map_err(io)?;
        self.sealed.delete(&names::store_key(app)).map_err(StoreError::Io)?;
        inner.apps.remove(app);
        Ok(Purged { app: app.to_string(), cid: None, reason, records, bytes })
    }

    /// Cache a fetched file's bytes for a kept conversation (at most 24 hours, sealed as records are).
    pub fn cache_file(&self, app: &str, cid: &str, fid: &str, data: &[u8], now_ms: i64) -> Result<(), StoreError> {
        check_id("fid", fid)?;
        let inner = self.inner.lock();
        let a = inner.apps.get(app).ok_or_else(|| StoreError::Invalid("that conversation holds nothing".to_string()))?;
        serving(a, a.convs.get(cid))?;
        let conv = a.convs.get(cid).ok_or_else(|| StoreError::Invalid("that conversation holds nothing".to_string()))?;
        remove_cached(&a.keys, conv, fid)?;
        let stem = a.keys.file_stem(cid, fid);
        let blob = a.keys.seal(app, cid, &format!("file-{stem}"), data).map_err(StoreError::Io)?;
        let dir = conv.dir.join(FILES_DIR);
        make_private_dir(&dir).map_err(io)?;
        write_private(&dir.join(format!("{stem}-{now_ms}{FILE_EXT}")), &blob).map_err(io)
    }

    /// A cached file's bytes, None when not cached or cached 24 hours ago or more (then removed).
    pub fn cached_file(&self, app: &str, cid: &str, fid: &str, now_ms: i64) -> Result<Option<Vec<u8>>, StoreError> {
        let inner = self.inner.lock();
        let Some(a) = inner.apps.get(app) else { return Ok(None) };
        serving(a, a.convs.get(cid))?;
        let Some(conv) = a.convs.get(cid) else { return Ok(None) };
        let stem = a.keys.file_stem(cid, fid);
        for (path, s, ms, _) in cached(conv) {
            if s != stem {
                continue;
            }
            if now_ms - ms >= FILE_CACHE_MS {
                remove_durable(&path).map_err(io)?;
                return Ok(None);
            }
            let blob = std::fs::read(&path).map_err(io)?;
            return a.keys.open(app, cid, &format!("file-{stem}"), &blob).map(Some).map_err(StoreError::Io);
        }
        Ok(None)
    }

    /// The store's size (`lucid_connector_store_bytes`): sealed records and cached files.
    pub fn bytes(&self) -> u64 {
        let inner = self.inner.lock();
        inner.apps.values().flat_map(|a| a.convs.values()).map(|c| c.bytes() + cached(c).iter().map(|f| f.3).sum::<u64>()).sum()
    }

    /// Due purges, the daily retention (`retention_days`: kind (`dm`, `group`, `channel`, `files`) to days, from the
    /// org policy), cached files past 24 hours, and the `max_bytes` cap (oldest records first, across apps and
    /// conversations). A failed step is reported and tried again next time.
    pub fn maintenance(&self, now_ms: i64, retention_days: &BTreeMap<String, u32>, max_bytes: u64) -> MaintenanceReport {
        let mut report = MaintenanceReport::default();
        let mut inner = self.inner.lock();

        let due_apps: Vec<(String, StopReason)> = inner.apps.iter().filter_map(|(n, a)| a.mark.filter(|m| now_ms >= m.purge_at).map(|m| (n.clone(), m.reason))).collect();
        for (app, reason) in due_apps {
            match self.purge_app(&mut inner, &app, reason.code()) {
                Ok(p) => report.purged.push(p),
                Err(e) => report.errors.push(format!("{app}: {e}")),
            }
        }
        for (app, a) in inner.apps.iter_mut() {
            let due: Vec<(String, StopReason)> = a.convs.iter().filter_map(|(c, conv)| conv.mark.filter(|m| now_ms >= m.purge_at).map(|m| (c.clone(), m.reason))).collect();
            for (cid, reason) in due {
                match purge_conv(a, app, &cid, reason.code()) {
                    Ok(p) => report.purged.push(p),
                    Err(e) => report.errors.push(format!("{app}: {e}")),
                }
            }
        }

        if inner.last_retention.is_none_or(|t| now_ms - t >= DAY_MS) {
            inner.last_retention = Some(now_ms);
            for (app, a) in inner.apps.iter_mut() {
                for conv in a.convs.values_mut() {
                    let old: Vec<String> = conv
                        .entries
                        .iter()
                        .filter(|(_, e)| retention_ms(retention_days, &conv.kind, !e.fids.is_empty()).is_some_and(|keep| now_ms - e.ts > keep))
                        .map(|(m, _)| m.clone())
                        .collect();
                    match delete_mids(app, &a.keys, conv, &old) {
                        Ok(n) => report.retention_deleted += n,
                        Err(e) => report.errors.push(format!("{app}: {e}")),
                    }
                }
            }
        }

        let mut cache_bytes = 0u64;
        for a in inner.apps.values() {
            for conv in a.convs.values() {
                for (path, _, ms, size) in cached(conv) {
                    if now_ms - ms >= FILE_CACHE_MS {
                        match remove_durable(&path) {
                            Ok(()) => report.files_expired += 1,
                            Err(e) => report.errors.push(e.to_string()),
                        }
                    } else {
                        cache_bytes += size;
                    }
                }
            }
        }

        let mut total = inner.apps.values().map(AppStore::bytes).sum::<u64>() + cache_bytes;
        if total > max_bytes {
            let mut all: Vec<(i64, String, String, String, u64)> = Vec::new();
            for (app, a) in &inner.apps {
                for conv in a.convs.values() {
                    for (mid, e) in &conv.entries {
                        all.push((e.ts, app.clone(), conv.cid.clone(), mid.clone(), e.bytes));
                    }
                }
            }
            all.sort_unstable();
            let mut doomed: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
            for (_, app, cid, mid, bytes) in all {
                if total <= max_bytes {
                    break;
                }
                total = total.saturating_sub(bytes);
                doomed.entry((app, cid)).or_default().push(mid);
            }
            for ((app, cid), mids) in doomed {
                let Some(a) = inner.apps.get_mut(&app) else { continue };
                let Some(conv) = a.convs.get_mut(&cid) else { continue };
                match delete_mids(&app, &a.keys, conv, &mids) {
                    Ok(n) => report.cap_deleted += n,
                    Err(e) => report.errors.push(format!("{app}: {e}")),
                }
            }
        }
        report.bytes = inner.apps.values().map(AppStore::bytes).sum::<u64>() + cache_bytes;
        report
    }
}

fn purge_conv(a: &mut AppStore, app: &str, cid: &str, reason: &'static str) -> Result<Purged, StoreError> {
    let Some(conv) = a.convs.get(cid) else { return Ok(Purged { app: app.to_string(), cid: Some(cid.to_string()), reason, records: 0, bytes: 0 }) };
    let (records, bytes) = (conv.entries.len() as u64, conv.bytes());
    remove_dir_durable(&conv.dir).map_err(io)?;
    a.convs.remove(cid);
    Ok(Purged { app: app.to_string(), cid: Some(cid.to_string()), reason, records, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector_seal::{FixedSource, Sealer, SEALED_DIR};
    use serde_json::json;

    const APP: &str = "helpdesk-api";
    const CID: &str = "g:7f3a01";
    const CID2: &str = "c:support";
    const T0: i64 = 1_790_000_000_000;
    const MAX: u64 = STORE_MAX_DEFAULT;
    const HOUR_MS: i64 = 3_600_000;

    fn open(d: &Path) -> (Arc<SealedStore>, ContentStore) {
        let sealed = Arc::new(SealedStore::open(Sealer::from_source(&FixedSource([5; 32])).unwrap(), d.join(SEALED_DIR)).unwrap());
        let store = ContentStore::open(d, sealed.clone()).unwrap();
        (sealed, store)
    }

    fn fresh() -> (PathBuf, Arc<SealedStore>, ContentStore) {
        let d = crate::meet_tls::testpki::dir("conn-store");
        let (sealed, store) = open(&d);
        (d, sealed, store)
    }

    fn msg(mid: &str, ts: i64, text: &str) -> StoredMessage {
        StoredMessage {
            mid: mid.to_string(),
            from: "ann@acme.example".to_string(),
            device: "0123456789abcdef".to_string(),
            ts,
            thread: None,
            reply: None,
            kind: "text".to_string(),
            text: text.to_string(),
            edited: None,
            files: Vec::new(),
            reactions: Vec::new(),
            mentions: Vec::new(),
            dlg: None,
        }
    }

    fn with_file(mut m: StoredMessage, fid: &str) -> StoredMessage {
        m.files.push(json!({"fid": fid, "id": "f_1", "name": "plan.pdf", "mime": "application/pdf", "size": 3, "sha256": "00", "key": "AA=="}));
        m
    }

    /// Every file's bytes under a folder.
    fn all_bytes(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(all_bytes(&p));
            } else {
                out.push((p.clone(), std::fs::read(&p).unwrap()));
            }
        }
        out
    }

    fn records(d: &Path) -> usize {
        all_bytes(&d.join(STORE_DIR)).iter().filter(|(p, _)| p.to_string_lossy().ends_with(RECORD_EXT)).count()
    }

    fn cids() -> Vec<String> {
        vec![CID.to_string(), CID2.to_string()]
    }

    #[test]
    fn put_search_edit_and_page_and_nothing_is_in_clear() {
        let (d, _, s) = fresh();
        assert!(s.put(APP, CID, "group", &msg("m1", T0, "Quarterly budget review")).unwrap());
        assert!(s.put(APP, CID, "group", &msg("m2", T0 + 1, "Lunch plans")).unwrap());
        assert!(s.put(APP, CID2, "channel", &msg("m3", T0 + 2, "Budget again!")).unwrap());
        assert!(!s.put(APP, CID, "group", &msg("m1", T0, "Quarterly budget review")).unwrap(), "a redelivery is kept once");
        for (_, bytes) in all_bytes(&d.join(STORE_DIR)) {
            for word in ["Quarterly", "budget", "Lunch", "g:7f3a01", "helpdesk"] {
                let word = word.as_bytes();
                assert!(!bytes.windows(word.len()).any(|w| w == word), "nothing in clear");
            }
        }
        let found = s.search(APP, &cids(), "BUDGET", 10).unwrap();
        assert_eq!(found.iter().map(|(c, m)| (c.as_str(), m.mid.as_str())).collect::<Vec<_>>(), vec![(CID2, "m3"), (CID, "m1")]);
        assert_eq!(s.search(APP, &cids(), "budget review", 10).unwrap().len(), 1);
        assert_eq!(s.search(APP, &[CID.to_string()], "again", 10).unwrap().len(), 0, "only the conversations asked for");
        assert_eq!(s.search(APP, &cids(), "budget", 1).unwrap()[0].1.mid, "m3");

        assert!(s.edit(APP, CID, "m1", "Annual forecast", T0 + 10).unwrap());
        assert!(!s.edit(APP, CID, "m1", "Older text", T0 + 5).unwrap(), "an earlier edit does not win");
        let m1 = s.get(APP, CID, "m1").unwrap().unwrap();
        assert_eq!((m1.text.as_str(), m1.edited), ("Annual forecast", Some(T0 + 10)));
        assert_eq!(s.search(APP, &cids(), "budget", 10).unwrap().len(), 1);
        assert_eq!(s.search(APP, &cids(), "forecast", 10).unwrap()[0].1.mid, "m1");
        assert!(s.react(APP, CID, "m1", "+1", "bob@acme.example", true, T0 + 11).unwrap());
        assert!(!s.react(APP, CID, "m1", "+1", "bob@acme.example", true, T0 + 12).unwrap());

        let first = s.page(APP, CID, None, 1).unwrap();
        assert_eq!(first.iter().map(|m| m.mid.as_str()).collect::<Vec<_>>(), vec!["m2"]);
        let next = s.page(APP, CID, Some((first[0].ts, first[0].mid.as_str())), 10).unwrap();
        assert_eq!(next.iter().map(|m| m.mid.as_str()).collect::<Vec<_>>(), vec!["m1"]);

        // all of it survives a restart
        drop(s);
        let (_, again) = open(&d);
        let m1 = again.get(APP, CID, "m1").unwrap().unwrap();
        assert_eq!((m1.text.as_str(), m1.reactions.len()), ("Annual forecast", 1));
        assert_eq!(again.search(APP, &cids(), "budget", 10).unwrap()[0].1.mid, "m3");
    }

    #[test]
    fn a_delete_erases_the_record_its_index_entries_and_its_cached_file_before_it_returns() {
        let (d, _, s) = fresh();
        s.put(APP, CID, "group", &msg("m1", T0, "secret plan")).unwrap();
        s.put(APP, CID, "group", &with_file(msg("m2", T0 + 1, "the attachment"), "f1")).unwrap();
        s.cache_file(APP, CID, "f1", b"pdf", T0 + 2).unwrap();
        assert_eq!(s.cached_file(APP, CID, "f1", T0 + 3).unwrap().as_deref(), Some(&b"pdf"[..]));
        assert_eq!(records(&d), 2);
        assert!(s.delete(APP, CID, "m1").unwrap());
        assert_eq!(s.get(APP, CID, "m1").unwrap(), None);
        assert!(s.search(APP, &cids(), "secret", 10).unwrap().is_empty());
        assert_eq!(records(&d), 1);
        assert!(s.delete(APP, CID, "m2").unwrap());
        assert_eq!(s.cached_file(APP, CID, "f1", T0 + 4).unwrap(), None);
        assert_eq!(records(&d), 0);
        assert!(!s.delete(APP, CID, "m2").unwrap());
        // the durable index agrees
        drop(s);
        let (_, again) = open(&d);
        assert_eq!(again.get(APP, CID, "m1").unwrap(), None);
        assert!(again.search(APP, &cids(), "plan", 10).unwrap().is_empty());
        assert_eq!(again.conversations(APP)[0].records, 0);
    }

    #[test]
    fn removal_stops_reads_at_once_and_purges_at_the_next_maintenance_within_the_hour() {
        let (d, _, s) = fresh();
        s.put(APP, CID, "group", &msg("m1", T0, "hello team")).unwrap();
        s.put(APP, CID2, "channel", &msg("m2", T0, "hello channel")).unwrap();
        let t = T0 + 1000;
        s.stop(APP, CID, StopReason::Removed, t).unwrap();
        assert_eq!(s.get(APP, CID, "m1"), Err(StoreError::Stopped("removed")));
        assert_eq!(s.page(APP, CID, None, 10), Err(StoreError::Stopped("removed")));
        assert_eq!(s.search(APP, &cids(), "hello", 10).unwrap().len(), 1, "only the other conversation answers");
        assert_eq!(s.put(APP, CID, "group", &msg("m3", t, "late")), Err(StoreError::Stopped("removed")));
        let conv_dir = s.inner.lock().apps[APP].convs[CID].dir.clone();
        // the stop survives a restart
        drop(s);
        let (_, s) = open(&d);
        assert_eq!(s.get(APP, CID, "m1"), Err(StoreError::Stopped("removed")));
        assert!(conv_dir.exists());
        let report = s.maintenance(t + crate::connector::MAINTENANCE_EVERY.as_millis() as i64, &BTreeMap::new(), MAX);
        assert_eq!(report.purged, vec![Purged { app: APP.into(), cid: Some(CID.into()), reason: "removed", records: 1, bytes: report.purged[0].bytes }]);
        assert!(!conv_dir.exists());
        assert_eq!(s.get(APP, CID, "m1").unwrap(), None);
        assert!(s.get(APP, CID2, "m2").unwrap().is_some());
    }

    #[test]
    fn a_policy_loss_purges_after_24_hours_unless_the_app_comes_back() {
        let (d, sealed, s) = fresh();
        s.put(APP, CID, "group", &msg("m1", T0, "hello")).unwrap();
        let t = T0 + 1000;
        s.stop_app(APP, StopReason::Policy, t).unwrap();
        assert_eq!(s.get(APP, CID, "m1"), Err(StoreError::Stopped("policy")));
        assert_eq!(s.search(APP, &cids(), "hello", 10), Err(StoreError::Stopped("policy")));
        assert!(s.maintenance(t + DAY_MS - 1, &BTreeMap::new(), MAX).purged.is_empty());
        assert_eq!(s.resume_app(APP, t + 2 * HOUR_MS).unwrap(), None);
        assert!(s.get(APP, CID, "m1").unwrap().is_some());
        assert!(s.maintenance(t + DAY_MS + 1, &BTreeMap::new(), MAX).purged.is_empty(), "cancelled");

        // not back in time: the whole app store and its key go
        let t2 = t + 2 * DAY_MS;
        s.stop_app(APP, StopReason::Expired, t2).unwrap();
        let report = s.maintenance(t2 + DAY_MS, &BTreeMap::new(), MAX);
        assert_eq!(report.purged.iter().map(|p| (p.cid.clone(), p.reason, p.records)).collect::<Vec<_>>(), vec![(None, "expired", 1)]);
        assert!(!d.join(STORE_DIR).join(APP).exists());
        assert!(!sealed.has(&names::store_key(APP)));

        // a conversation removal is not cancelled by a return: it is purged now
        s.put(APP, CID, "group", &msg("m2", t2, "again")).unwrap();
        s.stop(APP, CID, StopReason::Policy, t2).unwrap();
        s.stop(APP, CID, StopReason::Removed, t2 + 1).unwrap();
        let purged = s.resume(APP, CID, t2 + 2).unwrap().unwrap();
        assert_eq!((purged.reason, purged.records), ("removed", 1));
        assert_eq!(s.get(APP, CID, "m2").unwrap(), None);
    }

    #[test]
    fn a_revoked_certificate_purges_every_conversation_within_an_hour() {
        let (_, _, s) = fresh();
        s.put(APP, CID, "group", &msg("m1", T0, "a")).unwrap();
        s.put(APP, CID2, "channel", &msg("m2", T0, "b")).unwrap();
        s.stop_app(APP, StopReason::Revoked, T0).unwrap();
        s.stop_app(APP, StopReason::Policy, T0 + 10).unwrap();
        assert_eq!(s.resume_app(APP, T0 + 20).unwrap().map(|p| (p.reason, p.records)), Some(("revoked", 2)), "a revoked app's return does not keep its store");
        assert!(s.conversations(APP).is_empty());
    }

    #[test]
    fn retention_runs_daily_by_kind() {
        let (_, _, s) = fresh();
        let now = T0 + 100 * DAY_MS;
        s.put(APP, CID, "group", &msg("old", now - 31 * DAY_MS, "old")).unwrap();
        s.put(APP, CID, "group", &msg("new", now - DAY_MS, "new")).unwrap();
        s.put(APP, CID, "group", &with_file(msg("file", now - 8 * DAY_MS, "file"), "f9")).unwrap();
        s.put(APP, CID2, "channel", &msg("chan", now - 300 * DAY_MS, "kept")).unwrap();
        let days: BTreeMap<String, u32> = [("group".to_string(), 30), ("files".to_string(), 7), ("channel".to_string(), 0)].into_iter().collect();
        let report = s.maintenance(now, &days, MAX);
        assert_eq!(report.retention_deleted, 2);
        assert!(s.get(APP, CID, "old").unwrap().is_none() && s.get(APP, CID, "file").unwrap().is_none());
        assert!(s.get(APP, CID, "new").unwrap().is_some() && s.get(APP, CID2, "chan").unwrap().is_some());
        // daily: not again within the day
        s.put(APP, CID, "group", &msg("older", now - 40 * DAY_MS, "older")).unwrap();
        assert_eq!(s.maintenance(now + HOUR_MS, &days, MAX).retention_deleted, 0);
        assert_eq!(s.maintenance(now + DAY_MS, &days, MAX).retention_deleted, 1);
    }

    #[test]
    fn the_size_cap_deletes_the_oldest_records_first_across_conversations() {
        let (_, _, s) = fresh();
        s.put(APP, CID, "group", &msg("a2", T0 + 2, "same size text")).unwrap();
        s.put(APP, CID2, "channel", &msg("b1", T0 + 1, "same size text")).unwrap();
        s.put(APP, CID, "group", &msg("a3", T0 + 3, "same size text")).unwrap();
        let total = s.bytes();
        let report = s.maintenance(T0 + 10, &BTreeMap::new(), total - 1);
        assert_eq!(report.cap_deleted, 1);
        assert!(report.bytes < total);
        assert!(s.get(APP, CID2, "b1").unwrap().is_none(), "the oldest went first");
        assert!(s.get(APP, CID, "a2").unwrap().is_some() && s.get(APP, CID, "a3").unwrap().is_some());
        assert_eq!(s.maintenance(T0 + 11, &BTreeMap::new(), 0).cap_deleted, 2);
        assert_eq!(s.bytes(), 0);
    }

    #[test]
    fn forget_deletes_the_whole_app_store_and_its_key_now() {
        let (d, sealed, s) = fresh();
        s.put(APP, CID, "group", &msg("m1", T0, "x")).unwrap();
        s.put(APP, CID2, "channel", &msg("m2", T0, "y")).unwrap();
        s.put("other-api", CID, "group", &msg("m3", T0, "z")).unwrap();
        let p = s.forget(APP).unwrap();
        assert_eq!((p.cid, p.reason, p.records), (None, "forget", 2));
        assert!(!d.join(STORE_DIR).join(APP).exists());
        assert!(!sealed.has(&names::store_key(APP)));
        assert_eq!(s.get(APP, CID, "m1").unwrap(), None);
        assert!(s.get("other-api", CID, "m3").unwrap().is_some());
        drop(s);
        let (_, again) = open(&d);
        assert!(again.conversations(APP).is_empty());
        assert_eq!(again.conversations("other-api").len(), 1);
        assert!(again.forget("archive").is_err());
    }

    #[test]
    fn cached_file_bytes_last_at_most_24_hours() {
        let (_, _, s) = fresh();
        s.put(APP, CID, "group", &with_file(msg("m1", T0, "see file"), "f1")).unwrap();
        assert!(s.cache_file(APP, CID2, "f1", b"x", T0).is_err(), "only for a kept conversation");
        s.cache_file(APP, CID, "f1", b"file bytes", T0).unwrap();
        assert_eq!(s.cached_file(APP, CID, "f1", T0 + DAY_MS - 1).unwrap().as_deref(), Some(&b"file bytes"[..]));
        let report = s.maintenance(T0 + DAY_MS, &BTreeMap::new(), MAX);
        assert_eq!(report.files_expired, 1);
        assert_eq!(s.cached_file(APP, CID, "f1", T0 + DAY_MS).unwrap(), None);
        assert!(s.get(APP, CID, "m1").unwrap().is_some(), "the message stays");
    }

    #[test]
    fn tokens_are_lowercase_word_runs() {
        assert_eq!(tokens("Hello, WORLD! hello-world 42"), vec!["42", "hello", "world"]);
        assert_eq!(tokens("Über café"), vec!["café", "über"]);
        assert!(tokens(&"a".repeat(65)).is_empty());
    }
}
