// The relay operator's local controls (contract AC-2a revision 3.2, 4.2 and 5.7, F6 and F21): `fleet-local.json`
// (standing settings and one-shot commands, each naming the link it was written for), read with no-follow and type,
// owner and identity checks; the local-control lock `fleet-local.lock` around every read-modify-write by the CLI,
// the local console or the relay, with a `gen` compared before every rewrite; the command journal
// `fleet-local-journal.json` of durable state transitions (pending, an idempotent effect that saves its own result,
// applied or stale), completed at start before anything else, with the link checked before every effect step;
// `fleet-confirm.json` (writes waiting for the operator); the `fleet` commands; and the relay's own console routes
// for the link.

use crate::codec::{exact_keys, hex, is_int, iso_time, now_ms, parse_json, sha256_hex, str_of, stringify};
use crate::console::{ApiError, Console};
use crate::console_audit::{canonical_json, Audit, Record};
use crate::fleet_trust::{self as ft, Link, Refused};
use crate::license::Product;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const LOCAL_FILE: &str = "fleet-local.json";
pub const LOCAL_LOCK: &str = "fleet-local.lock";
pub const JOURNAL_FILE: &str = "fleet-local-journal.json";
pub const CONFIRM_FILE: &str = "fleet-confirm.json";
pub const RUN_LOCK: &str = "fleet.lock";
/// The `fleet audit export` record `fleet audit restart` needs (A1-M4).
pub const EXPORT_MARK: &str = "fleet-audit-export.json";
const LOCAL_MAX: usize = 1024 * 1024;
const JOURNAL_MAX: usize = 10_000;
const YEAR: i64 = 365 * 86_400_000;
const CONFIRM_MAX: usize = 50;
const CONFIRM_MS: i64 = 86_400_000;
pub const KINDS: [&str; 7] = ["leave", "accept-scopes", "confirm", "refuse", "refuse-key", "trust-ca", "trust-time-reset"];
const LEAVE_STEPS: [&str; 4] = ["notify", "wipe-key", "remove-link", "audit"];

// 13.4 words.
pub const FLEET_RUNNING: &str = "Stop the relay first, or use its Admin Console.";
pub const NOT_ENROLLED: &str = "This relay is not managed by a Lucid Admin Console.";
const BOOTSTRAP_WAIT: &str = "This relay trusts no admin key yet. Each admin endorses their key from the IDE plugin or the Hub app (Endorse my Admin Console key), or you add their key fingerprints with --fleet-admin-key when enrolling.";
const CONNECT_WORDS: [(&str, &str); 9] = [
    ("dns", "The console's host name did not resolve."),
    ("tcp", "The console's management port did not answer."),
    ("proxy", "The proxy refused the connection."),
    ("tls-protocol", "The console and this relay share no allowed TLS settings."),
    ("server-untrusted", "The server is not the console this relay trusts (its certificate, name or trust list did not match)."),
    ("server-expired", "The console's certificate has ended."),
    ("certificate-refused", "The console refused this relay's certificate. It may have been removed from the console, or its certificate ended."),
    ("upgrade-refused", "The console answered but did not open the channel."),
    ("closed", "The connection closed before the channel opened."),
];

fn bootstrap_done(n: usize, m: usize) -> String {
    format!("This relay now trusts {n} admin keys ({m} wait 24 hours under High).")
}

fn left_words(origin: &str) -> String {
    format!("This relay left the Lucid Admin Console at {origin}.")
}

fn trust_ca_words(fingerprint: &str) -> String {
    format!("New management CA fingerprint: {fingerprint}. Confirm only if a console admin read you the same one by phone or in person.")
}

fn recover_words(name: &str) -> String {
    format!("This relay's management key is lost. Ask a console admin for a Replace code for {name}, then run lucid-relay enroll again.")
}

fn trust_time_words(t: &str, stored_seq: &str, stored_issued: &str, seq: &str, issued: &str, wall: &str) -> String {
    format!(
        "Trusted time: {t}\nStored trust list: number {stored_seq}, issued {stored_issued}\nNewer trust list from the console: number {seq}, issued {issued}\nThis host's clock: {wall}\nUse the newer trust list and set trusted time to {issued}? Type yes to continue: "
    )
}

// ── Crash points for the tests (A3-H1) ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
thread_local! {
    static CRASH: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

/// A process kill at `point` (tests only).
fn crash(point: &str) {
    #[cfg(test)]
    CRASH.with(|c| {
        if c.borrow().as_deref() == Some(point) {
            *c.borrow_mut() = None;
            panic!("crash injected at {point}");
        }
    });
    #[cfg(not(test))]
    let _ = point;
}

fn hook() {
    #[cfg(test)]
    HOOK.with(|h| {
        if let Some(f) = h.borrow_mut().take() {
            f();
        }
    });
}

// ── Files: checked reads, durable writes, the lock ──────────────────────────────────────────────────────────

#[cfg(unix)]
extern "C" {
    fn geteuid() -> u32;
    fn flock(fd: std::os::raw::c_int, operation: std::os::raw::c_int) -> std::os::raw::c_int;
}

/// A file read as 4.2 says: not followed through a link, a regular file owned by this identity (or root) with no group
/// or other write access, read whole, and the same file (device and inode; on Windows, held with sharing that allows
/// no writer or delete while it is read) before and after. Ok(None) when it does not exist.
pub fn read_checked(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let before = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{name}: {e}")),
    };
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(format!("{name} is not a regular file"));
    }
    if before.len() as usize > LOCAL_MAX {
        return Err(format!("{name} is too large"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let me = unsafe { geteuid() };
        if before.uid() != me && before.uid() != 0 {
            return Err(format!("{name} is owned by another account"));
        }
        if before.mode() & 0o022 != 0 {
            return Err(format!("{name} can be written by other accounts"));
        }
    }
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW where its value is known; the lstat checks before and after cover the rest.
        #[cfg(target_os = "linux")]
        o.custom_flags(if cfg!(any(target_arch = "x86_64", target_arch = "x86")) { 0o400000 } else { 0o100000 });
        #[cfg(target_os = "macos")]
        o.custom_flags(0x100);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only (no writer, no delete or rename while held); FILE_FLAG_OPEN_REPARSE_POINT so a link
        // is opened as itself, never followed.
        o.share_mode(1);
        o.custom_flags(0x0020_0000);
    }
    let mut f = o.open(path).map_err(|e| format!("{name}: {e}"))?;
    let opened = f.metadata().map_err(|e| format!("{name}: {e}"))?;
    if !opened.is_file() {
        return Err(format!("{name} is not a regular file"));
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut f).take(LOCAL_MAX as u64 + 1).read_to_end(&mut bytes).map_err(|e| format!("{name}: {e}"))?;
    if bytes.len() > LOCAL_MAX {
        return Err(format!("{name} is too large"));
    }
    let after = std::fs::symlink_metadata(path).map_err(|e| format!("{name}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let same = before.dev() == opened.dev() && before.ino() == opened.ino() && after.dev() == opened.dev() && after.ino() == opened.ino();
        if !same || after.mode() != before.mode() || after.uid() != before.uid() {
            return Err(format!("{name} changed while it was read"));
        }
    }
    #[cfg(not(unix))]
    {
        if after.file_type().is_symlink() || after.len() != opened.len() || after.modified().ok() != opened.modified().ok() {
            return Err(format!("{name} changed while it was read"));
        }
    }
    if bytes.len() as u64 != opened.len() {
        return Err(format!("{name} changed while it was read"));
    }
    Ok(Some(bytes))
}

/// Write owner-only, flushed to disk, then renamed over the file (4.2 "flushed").
pub fn write_durable(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let r = (|| -> std::io::Result<()> {
        let mut f = o.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)]
        if let Some(dir) = path.parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| format!("{}: {e}", path.display()))
}

/// An exclusive OS lock on a file beside the state, held until dropped.
pub struct FileLock {
    _file: std::fs::File,
}

fn open_lock(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // No sharing: a second open, by any process, fails while this handle lives (the exclusive lock).
        o.share_mode(0);
    }
    o.open(path)
}

impl FileLock {
    /// The local-control lock (4.2), waiting up to 10 s for another holder.
    pub fn local(dir: &Path) -> Result<FileLock, String> {
        let path = dir.join(LOCAL_LOCK);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match open_lock(&path) {
                Ok(file) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::io::AsRawFd;
                        // SAFETY: flock on a descriptor this function owns; it blocks until the lock is free.
                        if unsafe { flock(file.as_raw_fd(), 2) } != 0 {
                            return Err(format!("{LOCAL_LOCK} could not be locked"));
                        }
                    }
                    return Ok(FileLock { _file: file });
                }
                Err(e) if (e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33)) && std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(e) => return Err(format!("{LOCAL_LOCK}: {e}")),
            }
        }
    }

    /// `fleet.lock` without waiting: Err when the relay holds it (it runs).
    pub fn run(dir: &Path) -> Result<FileLock, String> {
        let file = open_lock(&dir.join(RUN_LOCK)).map_err(|_| FLEET_RUNNING.to_owned())?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            // SAFETY: flock on a descriptor this function owns; LOCK_EX | LOCK_NB never blocks.
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
                return Err(FLEET_RUNNING.to_owned());
            }
        }
        Ok(FileLock { _file: file })
    }
}

// ── fleet-local.json ────────────────────────────────────────────────────────────────────────────────────────

/// The control file (4.2).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalFile {
    pub gen: u64,
    pub read_only: bool,
    pub confirm: Vec<String>,
    pub commands: Vec<Value>,
}

fn args_ok(kind: &str, a: &Map<String, Value>) -> bool {
    let s = |k: &str| str_of(a.get(k));
    match kind {
        "leave" => a.is_empty(),
        "accept-scopes" => exact_keys(a, &["requestId", "hash"], &["requestId", "hash"]) && s("requestId").is_some_and(|x| x.starts_with("sr_")) && s("hash").is_some_and(|h| h.len() == 64),
        "confirm" | "refuse" => exact_keys(a, &["id"], &["id"]) && s("id").is_some_and(|x| x.starts_with("fc_") && x.len() == 19),
        "refuse-key" => exact_keys(a, &["hint"], &["hint"]) && s("hint").is_some_and(|h| h.len() == 16 && h.bytes().all(|c| c.is_ascii_hexdigit())),
        "trust-ca" => exact_keys(a, &["generation", "fingerprint"], &["generation", "fingerprint"]) && is_int(a.get("generation")).is_some() && s("fingerprint").is_some_and(|f| (1..=200).contains(&f.len())),
        "trust-time-reset" => exact_keys(a, &["manifest"], &["manifest"]) && a.get("manifest").is_some_and(Value::is_object),
        _ => false,
    }
}

fn command_ok(c: &Value) -> bool {
    let Some(o) = c.as_object() else { return false };
    let link_ok = match o.get("link") {
        Some(Value::Null) => true,
        Some(Value::Object(l)) => exact_keys(l, &["consoleId", "relayId"], &["consoleId", "relayId"]) && str_of(l.get("consoleId")).is_some() && str_of(l.get("relayId")).is_some(),
        _ => false,
    };
    exact_keys(o, &["id", "kind", "link", "args"], &["id", "kind", "link", "args"])
        && str_of(o.get("id")).is_some_and(|id| id.starts_with("lc_") && id.len() == 19)
        && str_of(o.get("kind")).is_some_and(|k| KINDS.contains(&k))
        && link_ok
        && o.get("args").and_then(Value::as_object).is_some_and(|a| args_ok(str_of(o.get("kind")).unwrap_or(""), a))
}

/// `fleet-local.json` read strictly: version 3, exact keys, settings of their types. A missing file is the defaults.
pub fn read_local(dir: &Path) -> Result<LocalFile, String> {
    let Some(bytes) = read_checked(&dir.join(LOCAL_FILE))? else { return Ok(LocalFile::default()) };
    let v = std::str::from_utf8(&bytes).ok().and_then(parse_json).ok_or("fleet-local.json is not JSON")?;
    let o = v.as_object().ok_or("fleet-local.json is not an object")?;
    let bad = || "fleet-local.json is not a complete version 3 file".to_owned();
    if !exact_keys(o, &["v", "gen", "settings", "commands"], &["v", "gen", "settings", "commands"]) || o.get("v").and_then(Value::as_i64) != Some(3) {
        return Err(bad());
    }
    let s = o.get("settings").and_then(Value::as_object).ok_or_else(bad)?;
    if !exact_keys(s, &["readOnly", "confirm"], &["readOnly", "confirm"]) {
        return Err(bad());
    }
    let confirm: Vec<String> = s.get("confirm").and_then(Value::as_array).ok_or_else(bad)?.iter().map(|x| x.as_str().filter(|c| ft::WRITE_SCOPES.contains(c)).map(str::to_owned)).collect::<Option<_>>().ok_or_else(bad)?;
    let commands = o.get("commands").and_then(Value::as_array).ok_or_else(bad)?.clone();
    if commands.len() > 1000 {
        return Err(bad());
    }
    Ok(LocalFile { gen: is_int(o.get("gen")).ok_or_else(bad)? as u64, read_only: s.get("readOnly").and_then(Value::as_bool).ok_or_else(bad)?, confirm, commands })
}

fn write_local(dir: &Path, f: &LocalFile) -> Result<(), String> {
    let v = json!({ "v": 3, "gen": f.gen, "settings": { "readOnly": f.read_only, "confirm": f.confirm }, "commands": f.commands });
    write_durable(&dir.join(LOCAL_FILE), stringify(&v).as_bytes())
}

fn random_id(prefix: &str) -> Result<String, String> {
    let b = crate::console_auth::random(8).ok_or("no random bytes")?;
    Ok(format!("{prefix}{}", hex(&b)))
}

/// The link a command names now: `fleet.json`'s `{consoleId, relayId}`, or null.
pub fn link_now(dir: &Path) -> Value {
    crate::fleet_exec::current_link(dir).unwrap_or(Value::Null)
}

/// A one-shot command written by the CLI or the local console, under the lock, `gen` raised. Its id.
pub fn add_command(dir: &Path, kind: &str, args: Value) -> Result<String, String> {
    let _l = FileLock::local(dir)?;
    let mut f = read_local(dir)?;
    let id = random_id("lc_")?;
    let c = json!({ "id": id, "kind": kind, "link": link_now(dir), "args": args });
    if !command_ok(&c) {
        return Err(format!("the {kind} command is not valid"));
    }
    f.commands.push(c);
    f.gen += 1;
    write_local(dir, &f)?;
    Ok(id)
}

/// The standing settings written under the lock, `gen` raised. The settings as written.
pub fn set_settings(dir: &Path, read_only: Option<bool>, confirm: Option<Vec<String>>) -> Result<(bool, Vec<String>), String> {
    let _l = FileLock::local(dir)?;
    let mut f = read_local(dir)?;
    if let Some(r) = read_only {
        f.read_only = r;
    }
    if let Some(c) = confirm {
        if let Some(bad) = c.iter().find(|s| !ft::WRITE_SCOPES.contains(&s.as_str())) {
            return Err(format!("{bad} is not a write scope (read-logs, people, config, license)"));
        }
        f.confirm = ft::WRITE_SCOPES.iter().filter(|s| c.iter().any(|x| x == **s)).map(|s| (*s).to_owned()).collect();
    }
    f.gen += 1;
    write_local(dir, &f)?;
    Ok((f.read_only, f.confirm))
}

// ── The journal (A2-M2, A3-H1, revision 3.2) ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct JEntry {
    pub id: String,
    pub kind: String,
    pub link: Value,
    pub args: Value,
    /// "pending", "applied" or "stale".
    pub state: String,
    pub step: String,
    pub at: i64,
    pub done_at: Option<i64>,
}

impl JEntry {
    fn to_value(&self) -> Value {
        json!({ "id": self.id, "kind": self.kind, "link": self.link, "args": self.args, "state": self.state, "step": self.step, "at": self.at, "doneAt": self.done_at })
    }

    fn from_value(v: &Value) -> Option<JEntry> {
        let o = v.as_object()?;
        let k = ["id", "kind", "link", "args", "state", "step", "at", "doneAt"];
        if !exact_keys(o, &k, &k) {
            return None;
        }
        Some(JEntry {
            id: str_of(o.get("id"))?.to_owned(),
            kind: str_of(o.get("kind")).filter(|k| KINDS.contains(k))?.to_owned(),
            link: o.get("link")?.clone(),
            args: o.get("args")?.clone(),
            state: str_of(o.get("state")).filter(|s| matches!(*s, "pending" | "applied" | "stale"))?.to_owned(),
            step: str_of(o.get("step"))?.to_owned(),
            at: is_int(o.get("at"))?,
            done_at: match o.get("doneAt") {
                Some(Value::Null) => None,
                v => Some(is_int(v)?),
            },
        })
    }
}

pub fn read_journal(dir: &Path) -> Result<Vec<JEntry>, String> {
    let Some(bytes) = read_checked(&dir.join(JOURNAL_FILE))? else { return Ok(Vec::new()) };
    let v = std::str::from_utf8(&bytes).ok().and_then(parse_json).ok_or("fleet-local-journal.json is not JSON")?;
    let o = v.as_object().filter(|o| exact_keys(o, &["v", "entries"], &["v", "entries"]) && o.get("v").and_then(Value::as_i64) == Some(1)).ok_or("fleet-local-journal.json is not a version 1 journal")?;
    o.get("entries").and_then(Value::as_array).ok_or("fleet-local-journal.json has no entries")?.iter().map(|e| JEntry::from_value(e).ok_or_else(|| "a fleet-local-journal.json entry does not read".to_owned())).collect()
}

fn write_journal(dir: &Path, entries: &mut Vec<JEntry>, t: i64) -> Result<(), String> {
    entries.retain(|e| e.done_at.is_none_or(|d| t - d < YEAR));
    while entries.len() > JOURNAL_MAX {
        match entries.iter().position(|e| e.state != "pending") {
            Some(i) => {
                entries.remove(i);
            }
            None => break,
        }
    }
    let v = json!({ "v": 1, "entries": entries.iter().map(JEntry::to_value).collect::<Vec<_>>() });
    write_durable(&dir.join(JOURNAL_FILE), stringify(&v).as_bytes())
}

/// What an effect did: done (true when it changed something; false when it was already in place), the request it
/// names is no longer the relay's (`stale`), or refused with a reason. Err is a passing failure: the entry stays
/// pending and is run again.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Done(bool),
    Stale,
    Refused(String),
}

/// The effects of the one-shot commands, each idempotent and saving its own result before it returns (4.2).
pub trait Effects {
    /// The standing settings just read, before any command is taken up (so a confirm re-checks the newest read only).
    fn settings(&self, _read_only: bool, _confirm: &[String]) {}
    /// The current link (`{consoleId, relayId}`), or None.
    fn link(&self) -> Option<Value>;
    fn refuse_key(&self, hint: &str, t: i64) -> Result<Outcome, String>;
    fn accept_scopes(&self, request_id: &str, hash: &str, t: i64) -> Result<Outcome, String>;
    fn trust_ca(&self, generation: u64, fingerprint: &str, t: i64) -> Result<Outcome, String>;
    fn trust_time_reset(&self, manifest: &Value, t: i64) -> Result<Outcome, String>;
    /// Run (`run`) or refuse a waiting confirmation; Done(false) when it is no longer waiting.
    fn confirm(&self, id: &str, run: bool, t: i64) -> Result<Outcome, String>;
    fn notify_left(&self);
    /// Remove the sealed link keys when they are labeled for `link`; absent or labeled for another link: nothing.
    fn wipe_key(&self, link: &Value) -> Result<(), String>;
    /// Delete `fleet.json` when it still names `link`.
    fn remove_link(&self, link: &Value) -> Result<(), String>;
    fn audit(&self, r: Record, t: i64);
    /// An entry `action` with `detail.id` equal to `id` is in the audit.
    fn audited(&self, action: &str, id: &str) -> bool;
}

fn finish(fx: &dyn Effects, dir: &Path, j: &mut Vec<JEntry>, i: usize, state: &str, result: &str, t: i64) -> Result<(), String> {
    j[i].state = state.to_owned();
    j[i].done_at = Some(t);
    write_journal(dir, j, t)?;
    crash("applied");
    let mut r = Record::new("operator", "fleet.local", "ok");
    r.detail = json!({ "command": j[i].kind, "id": j[i].id, "result": result });
    fx.audit(r, t);
    Ok(())
}

/// Carry a journal entry to `applied` or `stale` from its recorded step, the link checked before every step.
pub fn advance(fx: &dyn Effects, dir: &Path, j: &mut Vec<JEntry>, i: usize, t: i64) -> Result<(), String> {
    let e = j[i].clone();
    if e.kind == "leave" {
        let start = LEAVE_STEPS.iter().position(|s| *s == e.step).map_or(0, |p| p + 1);
        for step in &LEAVE_STEPS[start..] {
            if *step != "audit" {
                match fx.link() {
                    Some(cur) if e.link.is_null() || cur != e.link => return finish(fx, dir, j, i, "stale", "stale", t),
                    // No link: only the audit step may run.
                    None => continue,
                    _ => {}
                }
            }
            match *step {
                "notify" => fx.notify_left(),
                "wipe-key" => fx.wipe_key(&e.link)?,
                "remove-link" => fx.remove_link(&e.link)?,
                _ => {
                    if !fx.audited("fleet.left", &e.id) {
                        let mut r = Record::new("operator", "fleet.left", "ok");
                        r.detail = json!({ "id": e.id, "consoleId": e.link.get("consoleId"), "relayId": e.link.get("relayId") });
                        fx.audit(r, t);
                    }
                }
            }
            crash(step);
            j[i].step = (*step).to_owned();
            write_journal(dir, j, t)?;
        }
        return finish(fx, dir, j, i, "applied", "ok", t);
    }
    if e.step == "effect" {
        return finish(fx, dir, j, i, "applied", "ok", t);
    }
    if e.link.is_null() || fx.link().as_ref() != Some(&e.link) {
        return finish(fx, dir, j, i, "stale", "stale", t);
    }
    let a = &e.args;
    let s = |k: &str| str_of(a.get(k)).unwrap_or("");
    let out = match e.kind.as_str() {
        "refuse-key" => fx.refuse_key(s("hint"), t)?,
        "accept-scopes" => fx.accept_scopes(s("requestId"), s("hash"), t)?,
        "trust-ca" => fx.trust_ca(a.get("generation").and_then(Value::as_u64).unwrap_or(0), s("fingerprint"), t)?,
        "trust-time-reset" => fx.trust_time_reset(a.get("manifest").unwrap_or(&Value::Null), t)?,
        "confirm" => fx.confirm(s("id"), true, t)?,
        "refuse" => fx.confirm(s("id"), false, t)?,
        _ => Outcome::Stale,
    };
    crash("effect");
    match out {
        Outcome::Done(_) => {
            j[i].step = "effect".into();
            write_journal(dir, j, t)?;
            finish(fx, dir, j, i, "applied", "ok", t)
        }
        Outcome::Stale => finish(fx, dir, j, i, "stale", "stale", t),
        Outcome::Refused(_) => finish(fx, dir, j, i, "stale", "refused", t),
    }
}

fn finish_pending(fx: &dyn Effects, dir: &Path, j: &mut Vec<JEntry>, t: i64) -> Result<(), String> {
    for i in 0..j.len() {
        if j[i].state == "pending" {
            advance(fx, dir, j, i, t)?;
        }
    }
    Ok(())
}

/// One take-up of a command: the entry `pending` (flushed), then the effect and `applied` or `stale`.
fn take_up(fx: &dyn Effects, dir: &Path, j: &mut Vec<JEntry>, c: &Value, t: i64) -> Result<(), String> {
    let id = str_of(c.get("id")).unwrap_or("").to_owned();
    let valid = command_ok(c);
    j.push(JEntry {
        id,
        kind: str_of(c.get("kind")).filter(|k| KINDS.contains(k)).unwrap_or("leave").to_owned(),
        link: c.get("link").cloned().unwrap_or(Value::Null),
        args: c.get("args").cloned().unwrap_or(Value::Null),
        state: "pending".into(),
        step: String::new(),
        at: t,
        done_at: None,
    });
    let i = j.len() - 1;
    if !valid {
        return finish(fx, dir, j, i, "stale", "refused", t);
    }
    write_journal(dir, j, t)?;
    crash("pending");
    advance(fx, dir, j, i, t)
}

/// One poll (at start and every 5 s): under the local-control lock, the journal's pending entries completed first,
/// then new commands taken up one by one and removed from the file (the rewrite only onto the same `gen`; a newer
/// file starts the pass over). The standing settings, or why the files did not read (the relay is then read only).
pub fn poll(fx: &dyn Effects, dir: &Path, t: i64) -> Result<crate::fleet_exec::LocalView, String> {
    let _l = FileLock::local(dir)?;
    let mut j = read_journal(dir)?;
    let first = read_local(dir)?;
    fx.settings(first.read_only, &first.confirm);
    finish_pending(fx, dir, &mut j, t)?;
    loop {
        let f = read_local(dir)?;
        fx.settings(f.read_only, &f.confirm);
        let mut done: Vec<String> = Vec::new();
        for c in &f.commands {
            let id = str_of(c.get("id")).unwrap_or("").to_owned();
            if !j.iter().any(|e| e.id == id) {
                take_up(fx, dir, &mut j, c, t)?;
            }
            done.push(id);
        }
        if done.is_empty() {
            return Ok(crate::fleet_exec::LocalView { read_only: f.read_only, confirm: f.confirm, unreadable: false });
        }
        hook();
        let again = read_local(dir)?;
        if again.gen != f.gen {
            continue;
        }
        let kept: Vec<Value> = again.commands.into_iter().filter(|c| !str_of(c.get("id")).is_some_and(|id| done.iter().any(|d| d == id))).collect();
        let next = LocalFile { gen: again.gen + 1, read_only: again.read_only, confirm: again.confirm.clone(), commands: kept };
        write_local(dir, &next)?;
        return Ok(crate::fleet_exec::LocalView { read_only: next.read_only, confirm: next.confirm, unreadable: false });
    }
}

// ── fleet-confirm.json ──────────────────────────────────────────────────────────────────────────────────────

static CONFIRM_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn read_confirm(dir: &Path) -> Result<Vec<Value>, String> {
    let Some(bytes) = read_checked(&dir.join(CONFIRM_FILE))? else { return Ok(Vec::new()) };
    let v = std::str::from_utf8(&bytes).ok().and_then(parse_json).ok_or("fleet-confirm.json is not JSON")?;
    v.get("items").and_then(Value::as_array).cloned().ok_or_else(|| "fleet-confirm.json has no items".to_owned())
}

fn write_confirm(dir: &Path, items: &[Value]) -> Result<(), String> {
    write_durable(&dir.join(CONFIRM_FILE), stringify(&json!({ "v": 1, "items": items })).as_bytes())
}

fn with_confirm<T>(dir: &Path, f: impl FnOnce(&mut Vec<Value>) -> Result<(T, bool), String>) -> Result<T, String> {
    let _g = CONFIRM_LOCK.lock();
    let mut items = read_confirm(dir)?;
    let (out, changed) = f(&mut items)?;
    if changed {
        write_confirm(dir, &items)?;
    }
    Ok(out)
}

/// A verified write waiting for the operator (`{id, op, summary, actor, at, expires}` plus its state and run).
pub fn queue_confirm(dir: &Path, run: &Value, summary: &str, actor: &str, t: i64) -> Result<String, String> {
    with_confirm(dir, |items| {
        items.retain(|i| i.get("expires").and_then(Value::as_i64).is_some_and(|e| e > t) || str_of(i.get("state")) == Some("running"));
        if items.len() >= CONFIRM_MAX {
            return Err("50 changes already wait for the operator".into());
        }
        let id = random_id("fc_")?;
        let op = if str_of(run.get("kind")) == Some("people") { "people" } else { "call" };
        items.push(json!({ "id": id, "op": op, "summary": summary, "actor": actor, "at": t, "expires": t + CONFIRM_MS, "state": "waiting", "run": run }));
        Ok((id, true))
    })
}

pub fn confirm_item(dir: &Path, id: &str) -> Result<Option<Value>, String> {
    with_confirm(dir, |items| Ok((items.iter().find(|i| str_of(i.get("id")) == Some(id) && str_of(i.get("state")) == Some("waiting")).cloned(), false)))
}

pub fn mark_running(dir: &Path, id: &str) -> Result<(), String> {
    with_confirm(dir, |items| {
        let mut hit = false;
        for i in items.iter_mut().filter(|i| str_of(i.get("id")) == Some(id)) {
            i["state"] = Value::from("running");
            hit = true;
        }
        Ok(((), hit))
    })
}

pub fn remove_confirm(dir: &Path, id: &str) -> Result<(), String> {
    with_confirm(dir, |items| {
        let n = items.len();
        items.retain(|i| str_of(i.get("id")) != Some(id));
        Ok(((), items.len() != n))
    })
}

/// Items a crash left `running`: removed, their ids returned (closed `unknown`, never run again).
pub fn take_running(dir: &Path) -> Vec<String> {
    with_confirm(dir, |items| {
        let ids: Vec<String> = items.iter().filter(|i| str_of(i.get("state")) == Some("running")).filter_map(|i| str_of(i.get("id")).map(str::to_owned)).collect();
        items.retain(|i| str_of(i.get("state")) != Some("running"));
        let changed = !ids.is_empty();
        Ok((ids, changed))
    })
    .unwrap_or_default()
}

/// Waiting items past 24 hours: removed, their ids returned.
pub fn take_expired(dir: &Path, t: i64) -> Vec<String> {
    with_confirm(dir, |items| {
        let gone = |i: &Value| str_of(i.get("state")) == Some("waiting") && i.get("expires").and_then(Value::as_i64).is_none_or(|e| e <= t);
        let ids: Vec<String> = items.iter().filter(|i| gone(i)).filter_map(|i| str_of(i.get("id")).map(str::to_owned)).collect();
        items.retain(|i| !gone(i));
        let changed = !ids.is_empty();
        Ok((ids, changed))
    })
    .unwrap_or_default()
}

/// The waiting items as `fleet status` and the local console show them.
pub fn waiting(dir: &Path) -> Vec<Value> {
    read_confirm(dir)
        .unwrap_or_default()
        .iter()
        .map(|i| json!({ "id": i.get("id"), "summary": i.get("summary"), "actor": i.get("actor"), "at": i.get("at"), "expires": i.get("expires") }))
        .collect()
}

// ── Effects with the relay stopped (the CLI) ────────────────────────────────────────────────────────────────

/// The commands' effects run by the CLI with the relay stopped (under `console.lock` and `fleet.lock`).
pub struct Offline {
    pub dir: PathBuf,
}

impl Offline {
    fn with_link(&self, f: impl FnOnce(&mut Link) -> Result<Outcome, String>) -> Result<Outcome, String> {
        let mut out = Ok(Outcome::Stale);
        crate::fleet_agent::update_link(&self.dir, |m| {
            let mut link = Link::from_map(m)?;
            out = f(&mut link);
            if matches!(out, Ok(Outcome::Done(true))) {
                link.write_into(m);
            }
            Ok(())
        })?;
        out
    }

    fn seal(&self) -> Result<crate::console_seal::Seal, String> {
        let high = crate::console_auth::Book::read(&self.dir.join(crate::console::CONSOLE_FILE), now_ms()).map(|b| b.settings.high()).unwrap_or(false);
        crate::console_seal::Seal::open(&self.dir, &|k| std::env::var(k).ok(), high)
    }
}

impl Effects for Offline {
    fn link(&self) -> Option<Value> {
        crate::fleet_exec::current_link(&self.dir)
    }

    fn refuse_key(&self, hint: &str, t: i64) -> Result<Outcome, String> {
        let out = self.with_link(|l| Ok(Outcome::Done(l.refuse_key(hint))))?;
        if out == Outcome::Done(true) {
            let mut r = Record::new("operator", "fleet.roster-refused", "ok");
            r.detail = json!({ "hint": hint });
            self.audit(r, t);
        }
        Ok(out)
    }

    fn accept_scopes(&self, request_id: &str, hash: &str, t: i64) -> Result<Outcome, String> {
        if self.audited_scopes(request_id) {
            return Ok(Outcome::Done(false));
        }
        let mut detail = Value::Null;
        let out = self.with_link(|l| match ft::accept_scopes(l, request_id, hash) {
            Ok(changed) => {
                detail = json!({ "scopes": l.scopes, "widened": true, "requestId": request_id, "generation": l.scope_generation });
                Ok(Outcome::Done(changed))
            }
            Err(_) => Ok(Outcome::Stale),
        })?;
        if out == Outcome::Done(true) {
            let mut r = Record::new("operator", "fleet.scopes", "ok");
            r.detail = detail;
            self.audit(r, t);
        }
        Ok(out)
    }

    fn trust_ca(&self, generation: u64, fingerprint: &str, t: i64) -> Result<Outcome, String> {
        let r = crate::fleet_agent::trust_ca(&self.dir, generation, fingerprint);
        let mut rec = Record::new("operator", "fleet.ca.trust", if r.is_ok() { "ok" } else { "refused" });
        rec.detail = json!({ "generation": generation, "fingerprint": fingerprint, "result": if r.is_ok() { "ok" } else { "refused" } });
        self.audit(rec, t);
        Ok(match r {
            Ok(()) => Outcome::Done(true),
            Err(why) => Outcome::Refused(why),
        })
    }

    fn trust_time_reset(&self, manifest: &Value, t: i64) -> Result<Outcome, String> {
        let (prev_seq, prev_issued) = stored_trust(&self.dir);
        match crate::fleet_agent::trust_time_apply(&self.dir, manifest, t) {
            Ok(Some((from, to, seq))) => {
                let mut r = Record::new("operator", "fleet.trust-time-reset", "ok");
                r.detail = json!({ "from": from, "to": to, "manifestSeq": seq, "previousSeq": prev_seq, "previousIssuedAt": prev_issued });
                self.audit(r, t);
                Ok(Outcome::Done(true))
            }
            Ok(None) => Ok(Outcome::Done(false)),
            Err(why) => Ok(Outcome::Refused(why)),
        }
    }

    fn confirm(&self, _id: &str, _run: bool, _t: i64) -> Result<Outcome, String> {
        // A console write runs only in the running relay (it re-checks the roster and read only there).
        Ok(Outcome::Refused("the relay is stopped".into()))
    }

    fn notify_left(&self) {}

    fn wipe_key(&self, link: &Value) -> Result<(), String> {
        let mut seal = self.seal()?;
        if seal.get("fleet-key").is_none() && seal.get("fleet-key-link").is_none() {
            return Ok(());
        }
        let want = canonical_json(link)?;
        if seal.get("fleet-key-link").is_some_and(|l| l == want) {
            for name in crate::fleet_exec::KEY_NAMES {
                seal.remove(name)?;
            }
        }
        Ok(())
    }

    fn remove_link(&self, link: &Value) -> Result<(), String> {
        if self.link().as_ref() == Some(link) {
            let path = self.dir.join(ft::LINK_FILE);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("{}: {e}", path.display()));
                }
            }
        }
        Ok(())
    }

    fn audit(&self, r: Record, t: i64) {
        let (mut a, _) = Audit::open(&self.dir, t);
        let _ = a.append(t, &r);
    }

    fn audited(&self, action: &str, id: &str) -> bool {
        let (a, _) = Audit::open(&self.dir, now_ms());
        a.entries().iter().any(|e| str_of(e.get("action")) == Some(action) && e.get("detail").and_then(|d| str_of(d.get("id"))) == Some(id))
    }
}

impl Offline {
    fn audited_scopes(&self, request_id: &str) -> bool {
        let (a, _) = Audit::open(&self.dir, now_ms());
        a.entries().iter().any(|e| str_of(e.get("action")) == Some("fleet.scopes") && e.get("detail").is_some_and(|d| str_of(d.get("requestId")) == Some(request_id) && d.get("widened") == Some(&Value::Bool(true))))
    }
}

// ── The `fleet` commands (5.7) ──────────────────────────────────────────────────────────────────────────────

fn ask(input: &mut dyn BufRead, out: &mut dyn Write, prompt: &str) -> String {
    let _ = write!(out, "{prompt}");
    let _ = out.flush();
    let mut line = String::new();
    let _ = input.read_line(&mut line);
    line.trim().to_owned()
}

fn say(out: &mut dyn Write, text: &str) {
    let _ = writeln!(out, "{text}");
}

fn link_map(dir: &Path) -> Option<Map<String, Value>> {
    crate::fleet_agent::load_link_json(dir).ok().flatten()
}

/// The stored trust list's `seq` and `issuedAt` (`fleet.json` `trust`), read before a reset replaces them.
pub fn stored_trust(dir: &Path) -> (Value, Value) {
    let trust = link_map(dir).and_then(|m| m.get("trust").cloned()).unwrap_or(Value::Null);
    (trust.get("seq").cloned().unwrap_or(Value::Null), trust.get("issuedAt").cloned().unwrap_or(Value::Null))
}

fn time_text(ms: Option<i64>) -> String {
    ms.map_or_else(|| "unknown".to_owned(), iso_time)
}

/// `lucid-relay fleet <args>` (and `meet fleet`): the exit code; the words are printed to `out`.
pub fn cli(product: Product, state_dir: &Path, args: &[String], input: &mut dyn BufRead, out: &mut dyn Write) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let t = now_ms();
    let r = match a.as_slice() {
        ["status"] => {
            status(state_dir, out);
            Ok(())
        }
        ["read-only", v @ ("on" | "off")] => set_settings(state_dir, Some(*v == "on"), None).map(|(on, _)| say(out, &format!("Read only from the Admin Console: {}.", if on { "on" } else { "off" }))),
        ["confirm-scopes", "none"] => set_settings(state_dir, None, Some(Vec::new())).map(|_| say(out, "Confirm here: none.")),
        ["confirm-scopes", list] => {
            let scopes: Vec<String> = list.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
            set_settings(state_dir, None, Some(scopes)).map(|(_, c)| say(out, &format!("Confirm here: {}.", c.join(", "))))
        }
        ["confirm", id] => one_shot(state_dir, "confirm", json!({ "id": id }), out),
        ["refuse", id] => one_shot(state_dir, "refuse", json!({ "id": id }), out),
        ["refuse-key", hint] => one_shot(state_dir, "refuse-key", json!({ "hint": hint }), out),
        ["trust-ca", fp] => trust_ca_cli(state_dir, fp, out),
        ["accept-scopes", id] => accept_scopes_cli(state_dir, id, input, out),
        ["leave"] => leave_cli(state_dir, t, out),
        ["recover"] => recover_cli(state_dir, t, out),
        ["trust-time", "reset"] => trust_time_cli(product, state_dir, t, input, out),
        ["audit", "verify"] => audit_verify(state_dir, t, out),
        ["audit", "export", "--out", file] => audit_export(state_dir, Path::new(file), t, out),
        ["audit", "restart"] => audit_restart(state_dir, t, input, out),
        _ => {
            say(out, "usage: fleet status | trust-ca <fingerprint> | trust-time reset | read-only on|off | confirm-scopes <scope,...>|none | confirm <id> | refuse <id> | accept-scopes <requestId> | refuse-key <hint> | leave | recover | audit verify | audit export --out <file> | audit restart");
            return 2;
        }
    };
    match r {
        Ok(()) => 0,
        Err(e) => {
            say(out, &e);
            1
        }
    }
}

fn one_shot(dir: &Path, kind: &str, args: Value, out: &mut dyn Write) -> Result<(), String> {
    if link_map(dir).is_none() {
        return Err(NOT_ENROLLED.into());
    }
    let id = add_command(dir, kind, args)?;
    say(out, &format!("Written as {id}. The relay applies it within 5 seconds while it runs, or at its next start."));
    Ok(())
}

fn trust_ca_cli(dir: &Path, fingerprint: &str, out: &mut dyn Write) -> Result<(), String> {
    let m = link_map(dir).ok_or(NOT_ENROLLED)?;
    // No pending generation after `fleet-ca replace` (3.11, 3.12): 0, and the relay learns the CA with that fingerprint
    // from the console (`fleet_agent::trust_ca`).
    let generation = m
        .get("pins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| str_of(p.get("state")) == Some("pending"))
        .filter_map(|p| p.get("generation").and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    say(out, &trust_ca_words(fingerprint));
    one_shot(dir, "trust-ca", json!({ "generation": generation, "fingerprint": fingerprint }), out)
}

fn accept_scopes_cli(dir: &Path, request_id: &str, input: &mut dyn BufRead, out: &mut dyn Write) -> Result<(), String> {
    let m = link_map(dir).ok_or(NOT_ENROLLED)?;
    let link = Link::from_map(&m)?;
    let r = link.scope_request.filter(|r| r.request_id == request_id).ok_or_else(|| Refused::of("stale").error)?;
    say(out, &format!("Scopes now: {}\nScopes asked: {}\nRequest {} hash {}", r.old.join(", "), r.requested.join(", "), r.request_id, r.hash));
    if ask(input, out, "Accept this request? Type yes to continue: ") != "yes" {
        return Err("Nothing was changed.".into());
    }
    one_shot(dir, "accept-scopes", json!({ "requestId": r.request_id, "hash": r.hash }), out)
}

/// `fleet leave`: the one-shot while the relay runs; with it stopped, the leave itself through the journal.
fn leave_cli(dir: &Path, t: i64, out: &mut dyn Write) -> Result<(), String> {
    let m = link_map(dir).ok_or(NOT_ENROLLED)?;
    let origin = str_of(m.get("origin")).unwrap_or("").to_owned();
    let Ok(_run) = FileLock::run(dir) else { return one_shot(dir, "leave", json!({}), out) };
    let _console = crate::console_auth::lock_state(dir)?;
    add_command(dir, "leave", json!({}))?;
    let fx = Offline { dir: dir.to_owned() };
    poll(&fx, dir, t)?;
    if link_map(dir).is_some() {
        return Err("The relay could not leave; see fleet status.".into());
    }
    say(out, &left_words(&origin));
    Ok(())
}

/// `fleet recover` (3.12): relay stopped; the relay id, name, site and pins kept, the link and key cleared.
fn recover_cli(dir: &Path, t: i64, out: &mut dyn Write) -> Result<(), String> {
    let _run = FileLock::run(dir)?;
    let _console = crate::console_auth::lock_state(dir)?;
    let m = link_map(dir).ok_or(NOT_ENROLLED)?;
    let name = str_of(m.get("name")).unwrap_or("").to_owned();
    let fx = Offline { dir: dir.to_owned() };
    let mut seal = fx.seal()?;
    for k in crate::fleet_exec::KEY_NAMES {
        seal.remove(k)?;
    }
    crate::fleet_agent::update_link(dir, |m| {
        m.retain(|k, _| matches!(k.as_str(), "v" | "relayId" | "name" | "site" | "pins"));
        Ok(())
    })?;
    let mut r = Record::new("operator", "fleet.recover", "ok");
    r.detail = json!({ "relayId": m.get("relayId") });
    fx.audit(r, t);
    say(out, &recover_words(&name));
    Ok(())
}

/// `fleet trust-time reset` (3.10, revision 3.2): a fresh signed trust list fetched now, shown, confirmed, applied.
fn trust_time_cli(product: Product, dir: &Path, t: i64, input: &mut dyn BufRead, out: &mut dyn Write) -> Result<(), String> {
    let m = link_map(dir).ok_or(NOT_ENROLLED)?;
    let refused = || Refused::of("trust-time-refused").error;
    let manifest = crate::fleet_agent::trust_time_fetch(dir, product).map_err(|_| refused())?;
    let trust = m.get("trust").cloned().unwrap_or(Value::Null);
    let stored_seq = trust.get("seq").and_then(Value::as_i64).map_or_else(|| "none".to_owned(), |s| s.to_string());
    let stored_issued = time_text(trust.get("issuedAt").and_then(Value::as_i64));
    let seq = manifest.get("seq").and_then(Value::as_i64).map_or_else(|| "?".to_owned(), |s| s.to_string());
    let issued = time_text(manifest.get("issuedAt").and_then(Value::as_i64));
    let tt = time_text(crate::fleet_agent::trust_time_ms(dir));
    let prompt = trust_time_words(&tt, &stored_seq, &stored_issued, &seq, &issued, &iso_time(t));
    if ask(input, out, &prompt) != "yes" {
        return Err("Nothing was changed.".into());
    }
    match FileLock::run(dir) {
        Err(_) => one_shot(dir, "trust-time-reset", json!({ "manifest": manifest }), out),
        Ok(_run) => {
            let _console = crate::console_auth::lock_state(dir)?;
            match (Offline { dir: dir.to_owned() }).trust_time_reset(&manifest, t)? {
                Outcome::Done(_) => {
                    say(out, &format!("Trusted time is now {issued}."));
                    Ok(())
                }
                _ => Err(refused()),
            }
        }
    }
}

fn status(dir: &Path, out: &mut dyn Write) {
    let Some(m) = link_map(dir) else {
        say(out, NOT_ENROLLED);
        return;
    };
    let s = |k: &str| str_of(m.get(k)).unwrap_or("").to_owned();
    say(out, &format!("Console: {} ({})\nRelay: {} {} ({})", s("origin"), s("consoleId"), s("relayId"), s("name"), s("site")));
    if m.get("keyLost").and_then(Value::as_bool) == Some(true) {
        say(out, &recover_words(&s("name")));
    }
    match Link::from_map(&m) {
        Err(e) => say(out, &format!("Trust state: {e}")),
        Ok(link) => {
            if link.bootstrap.done {
                let active = link.hints_in(ft::KeyState::Active).len() + link.hints_in(ft::KeyState::Held).len();
                say(out, &bootstrap_done(active, link.hints_in(ft::KeyState::Held).len()));
            } else {
                say(out, BOOTSTRAP_WAIT);
            }
            for e in &link.roster {
                let anchor = e.anchor.as_ref().map_or("none".to_owned(), |a| a.via.clone());
                say(out, &format!("  {} {} {} key {} anchor {}{}", e.canon.email, e.canon.role, e.state.as_str(), e.hint, anchor, if e.attested { ", verified security key" } else { "" }));
            }
            say(out, &format!("Scopes: {} (generation {})", link.scopes.join(", "), link.scope_generation));
            if let Some(r) = &link.scope_request {
                say(out, &format!("Scope request {}: {} (hash {})", r.request_id, r.requested.join(", "), r.hash));
            }
            say(out, &format!("Policy: {} profile, two-person control {}", if link.policy.high { "High" } else { "Standard" }, if link.policy.two_person { "on" } else { "off" }));
            if !link.refused_keys.is_empty() {
                say(out, &format!("Refused keys: {}", link.refused_keys.join(", ")));
            }
        }
    }
    match FileLock::local(dir).and_then(|_l| read_local(dir)) {
        Ok(f) => say(out, &format!("Read only from the console: {}\nConfirm here: {}", if f.read_only { "on" } else { "off" }, if f.confirm.is_empty() { "none".to_owned() } else { f.confirm.join(", ") })),
        Err(e) => say(out, &format!("fleet-local.json does not read ({e}): the relay acts as read only.")),
    }
    for w in waiting(dir) {
        say(out, &format!("Waiting: {} {} by {}", str_of(w.get("id")).unwrap_or(""), str_of(w.get("summary")).unwrap_or(""), str_of(w.get("actor")).unwrap_or("")));
    }
    if let Ok(j) = read_journal(dir) {
        for e in j.iter().filter(|e| e.kind == "confirm" && e.state == "stale") {
            say(out, &format!("Confirm command {}: not run.", e.id));
        }
    }
    for p in m.get("pins").and_then(Value::as_array).into_iter().flatten() {
        say(out, &format!("CA generation {}: {} {}", p.get("generation").and_then(Value::as_u64).unwrap_or(0), str_of(p.get("state")).unwrap_or(""), str_of(p.get("fingerprint")).or_else(|| str_of(p.get("pin"))).unwrap_or("")));
    }
    if let Some(seq) = m.get("trust").and_then(|x| x.get("seq")).and_then(Value::as_i64) {
        say(out, &format!("Trust list: number {seq}"));
    }
    say(out, &format!("Last contact: {}", time_text(m.get("lastContactAt").and_then(Value::as_i64))));
    if let Some(cat) = m.get("lastConnectFailure").and_then(|f| str_of(f.get("category"))) {
        if let Some((_, w)) = CONNECT_WORDS.iter().find(|(c, _)| *c == cat) {
            say(out, &format!("Last connection failure ({cat}): {w}"));
        }
    }
}

// ── `fleet audit` (A1-M4) ───────────────────────────────────────────────────────────────────────────────────

fn audit_verify(dir: &Path, t: i64, out: &mut dyn Write) -> Result<(), String> {
    let _run = FileLock::run(dir)?;
    let _console = crate::console_auth::lock_state(dir)?;
    let (a, notes) = Audit::open(dir, t);
    for n in notes {
        say(out, &n);
    }
    let v = a.verify();
    match a.broken() {
        Some(b) => say(out, &format!("The audit log verifies through entry {}. A broken part was set aside: {} ({} lines, SHA-256 {}).", v.through, b.file, b.lines, b.sha256)),
        None if v.verified => say(out, &format!("The audit log verifies through entry {}.", v.through)),
        None => say(out, &format!("The audit log does not verify from entry {}.", v.broken_at.unwrap_or(0))),
    }
    Ok(())
}

/// The JSONL of every kept entry (AC-1 4.5), owner-only and new, plus the torn file beside it, and the record that
/// lets `restart` go ahead.
fn audit_export(dir: &Path, file: &Path, t: i64, out: &mut dyn Write) -> Result<(), String> {
    let _run = FileLock::run(dir)?;
    let _console = crate::console_auth::lock_state(dir)?;
    let (a, _) = Audit::open(dir, t);
    let mut text = String::new();
    for e in a.entries() {
        text.push_str(&stringify(&Value::Object(e)));
        text.push('\n');
    }
    let create = |p: &Path, bytes: &[u8]| -> Result<(), String> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(p).map_err(|e| format!("{}: {e}", p.display()))?;
        f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| format!("{}: {e}", p.display()))
    };
    create(file, text.as_bytes())?;
    let (through, _) = a.head();
    let mut torn = Value::Null;
    if let Some(b) = a.broken() {
        let bytes = std::fs::read(dir.join(&b.file)).map_err(|e| format!("{}: {e}", b.file))?;
        let mut name = file.as_os_str().to_owned();
        name.push(".torn.jsonl");
        create(Path::new(&name), &bytes)?;
        torn = Value::from(sha256_hex(&bytes));
    }
    write_durable(&dir.join(EXPORT_MARK), stringify(&json!({ "at": t, "through": through, "tornSha256": torn })).as_bytes())?;
    say(out, &format!("Exported entries through {through} to {}.", file.display()));
    Ok(())
}

/// AC-1 6 "A broken chain", offline: only after an export since the break, with the torn file's SHA-256 prefix typed.
fn audit_restart(dir: &Path, t: i64, input: &mut dyn BufRead, out: &mut dyn Write) -> Result<(), String> {
    let _run = FileLock::run(dir)?;
    let _console = crate::console_auth::lock_state(dir)?;
    let (mut a, _) = Audit::open(dir, t);
    let Some(b) = a.broken().cloned() else { return Err("The audit log is not broken. Nothing was changed.".into()) };
    let mark = read_checked(&dir.join(EXPORT_MARK))?.and_then(|bytes| std::str::from_utf8(&bytes).ok().and_then(parse_json));
    let covered = mark.as_ref().is_some_and(|m| m.get("through").and_then(Value::as_u64) == Some(a.head().0) && str_of(m.get("tornSha256")) == Some(b.sha256.as_str()));
    if !covered {
        return Err("Export the audit log first: lucid-relay fleet audit export --out <file>. Nothing was changed.".into());
    }
    say(out, &format!("Torn file: {} ({} lines), SHA-256 {}", b.file, b.lines, b.sha256));
    let typed = ask(input, out, "Type the first 16 characters of that SHA-256 to start a new chain: ");
    if typed.to_ascii_lowercase() != b.sha256[..16] {
        return Err("That does not match. Nothing was changed.".into());
    }
    let mut r = Record::new("operator", "audit.restart", "ok");
    r.detail = json!({});
    a.restart(t, r)?;
    say(out, "A new audit chain starts after the verified entries.");
    Ok(())
}

// ── The relay's own console: the link panel (5.7) ───────────────────────────────────────────────────────────

/// `GET /console/api/fleet-link`.
pub fn console_view(console: &Console, _t: i64) -> Value {
    let dir = &console.cfg.state_dir;
    let Some(m) = link_map(dir) else {
        return json!({ "ok": true, "enrolled": false, "console": null, "relayId": null, "name": null, "scopes": [], "pendingScopes": null, "readOnly": false, "confirm": [], "waiting": [], "held": [], "fingerprint": null, "lastContactAt": null });
    };
    let link = Link::from_map(&m).ok();
    let local = FileLock::local(dir).and_then(|_l| read_local(dir));
    let (read_only, confirm) = match &local {
        Ok(f) => (f.read_only || !link.as_ref().is_some_and(|l| l.bootstrap.done), f.confirm.clone()),
        Err(_) => (true, Vec::new()),
    };
    json!({
        "ok": true, "enrolled": true,
        "console": { "id": m.get("consoleId"), "origin": m.get("origin") },
        "relayId": m.get("relayId"), "name": m.get("name"),
        "scopes": link.as_ref().map(|l| l.scopes.clone()).unwrap_or_default(),
        "pendingScopes": link.as_ref().and_then(|l| l.scope_request.as_ref().map(ft::ScopeRequest::view)),
        "readOnly": read_only, "confirm": confirm, "waiting": waiting(dir),
        "held": link.as_ref().map(|l| l.hints_in(ft::KeyState::Held)).unwrap_or_default(),
        "fingerprint": m.get("fingerprint").cloned().unwrap_or(Value::Null),
        "lastContactAt": m.get("lastContactAt").cloned().unwrap_or(Value::Null),
    })
}

fn invalid(e: impl Into<String>) -> ApiError {
    ApiError::with("invalid", e)
}

/// `POST /console/api/fleet-link/<x>` (admin; step-up as the route rows say). Each runs as its command: settings and
/// one-shot commands through the same lock, generation and journal (4.2).
pub fn console_route(console: &Console, x: &str, params: &Value, email: &str, t: i64) -> Result<Value, ApiError> {
    let dir = console.cfg.state_dir.clone();
    let product = console.cfg.product;
    let s = |k: &str| str_of(params.get(k)).unwrap_or("").to_owned();
    let enrolled = || link_map(&dir).map(|_| ()).ok_or_else(|| ApiError::with("stale", NOT_ENROLLED));
    let record = |action: &str, detail: Value| {
        let mut r = Record::new(email, action, "ok");
        r.role = Some("admin".into());
        r.stepup = !matches!(x, "refuse" | "refuse-key");
        r.detail = detail;
        console.record(r, t);
    };
    let command = |kind: &str, args: Value| -> Result<Value, ApiError> {
        enrolled()?;
        let id = add_command(&dir, kind, args).map_err(invalid)?;
        if let Some(f) = crate::fleet_exec::live(&dir) {
            f.poll(t);
        }
        Ok(json!({ "ok": true, "id": id }))
    };
    match x {
        "preview" => {
            let mut v = crate::fleet_agent::preview(&s("url"), &s("code"), product).map_err(invalid)?;
            if let Some(o) = v.as_object_mut() {
                o.insert("ok".into(), Value::Bool(true));
            }
            Ok(v)
        }
        "join" => {
            let keys: Vec<String> = params.get("adminKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            if keys.iter().any(|k| k.len() != 64 || !k.bytes().all(|c| c.is_ascii_hexdigit())) {
                return Err(invalid("An admin key fingerprint is 64 hex characters."));
            }
            crate::fleet_agent::join_local(console, &dir, &s("url"), &s("code"), &s("previewHash"), &keys, product).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "read-only" => {
            enrolled()?;
            let on = params.get("on").and_then(Value::as_bool).ok_or_else(|| invalid("on is true or false."))?;
            let (ro, confirm) = set_settings(&dir, Some(on), None).map_err(invalid)?;
            record("fleet.read-only", json!({ "on": ro }));
            if let Some(f) = crate::fleet_exec::live(&dir) {
                f.note_settings(ro, confirm);
            }
            Ok(json!({ "ok": true, "readOnly": ro }))
        }
        "confirm-scopes" => {
            enrolled()?;
            let scopes: Vec<String> = params.get("scopes").and_then(Value::as_array).ok_or_else(|| invalid("scopes is a list."))?.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<_>>().ok_or_else(|| invalid("scopes is a list of names."))?;
            let (ro, confirm) = set_settings(&dir, None, Some(scopes)).map_err(invalid)?;
            record("fleet.confirm-scopes", json!({ "scopes": confirm }));
            if let Some(f) = crate::fleet_exec::live(&dir) {
                f.note_settings(ro, confirm.clone());
            }
            Ok(json!({ "ok": true, "confirm": confirm }))
        }
        "confirm" => command("confirm", json!({ "id": s("id") })),
        "refuse" => command("refuse", json!({ "id": s("id") })),
        "refuse-key" => command("refuse-key", json!({ "hint": s("hint") })),
        "accept-scopes" => command("accept-scopes", json!({ "requestId": s("requestId"), "hash": s("hash") })),
        "trust-ca" => {
            let generation = params.get("generation").and_then(Value::as_u64).or_else(|| s("generation").parse().ok()).ok_or_else(|| invalid("generation is a number."))?;
            command("trust-ca", json!({ "generation": generation, "fingerprint": s("fingerprint") }))
        }
        "leave" => command("leave", json!({})),
        _ => Err(ApiError::of("not-found")),
    }
}

#[cfg(test)]
mod tests {
    //! 16.1 f-trust, local controls (A1-M2, A2-M2, A3-H1, revision 3.2): one-shot commands consumed once, the file
    //! checks, the lock and `gen`, the journal with crash injection at every step, link-bound commands, and the
    //! offline `fleet audit` commands.

    use super::*;
    use std::cell::RefCell;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const T: i64 = 1_800_000_000_000;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lucid-fleet-local-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::store::make_dir(&dir).unwrap();
        dir
    }

    fn link(n: u8) -> Value {
        json!({ "consoleId": format!("c_000000000000000{n}"), "relayId": format!("r_000000000000000{n}") })
    }

    /// The relay's state as the effects see it, in memory.
    #[derive(Default)]
    struct Fx {
        link: RefCell<Option<Value>>,
        /// The label of the sealed key, None when the key is gone.
        key: RefCell<Option<Value>>,
        refused: RefCell<Vec<String>>,
        request: RefCell<Option<String>>,
        scopes_applied: RefCell<Vec<String>>,
        pins: RefCell<Vec<u64>>,
        trust_time: RefCell<Option<u64>>,
        waiting: RefCell<Vec<String>>,
        ran: RefCell<Vec<String>>,
        notified: RefCell<u32>,
        audit: RefCell<Vec<(String, Value)>>,
    }

    impl Fx {
        fn enrolled(n: u8) -> Fx {
            let fx = Fx::default();
            *fx.link.borrow_mut() = Some(link(n));
            *fx.key.borrow_mut() = Some(link(n));
            fx
        }

        fn count(&self, action: &str) -> usize {
            self.audit.borrow().iter().filter(|(a, _)| a == action).count()
        }
    }

    impl Effects for Fx {
        fn link(&self) -> Option<Value> {
            self.link.borrow().clone()
        }
        fn refuse_key(&self, hint: &str, _t: i64) -> Result<Outcome, String> {
            let mut r = self.refused.borrow_mut();
            let new = !r.iter().any(|h| h == hint);
            if new {
                r.push(hint.to_owned());
            }
            Ok(Outcome::Done(new))
        }
        fn accept_scopes(&self, request_id: &str, _hash: &str, _t: i64) -> Result<Outcome, String> {
            if self.scopes_applied.borrow().iter().any(|x| x == request_id) {
                return Ok(Outcome::Done(false));
            }
            if self.request.borrow().as_deref() != Some(request_id) {
                return Ok(Outcome::Stale);
            }
            *self.request.borrow_mut() = None;
            self.scopes_applied.borrow_mut().push(request_id.to_owned());
            Ok(Outcome::Done(true))
        }
        fn trust_ca(&self, generation: u64, fingerprint: &str, _t: i64) -> Result<Outcome, String> {
            if fingerprint != "good" {
                return Ok(Outcome::Refused("fingerprint".into()));
            }
            let mut p = self.pins.borrow_mut();
            if p.contains(&generation) {
                return Ok(Outcome::Done(false));
            }
            p.push(generation);
            Ok(Outcome::Done(true))
        }
        fn trust_time_reset(&self, manifest: &Value, _t: i64) -> Result<Outcome, String> {
            let seq = manifest["seq"].as_u64().unwrap();
            let mut tt = self.trust_time.borrow_mut();
            if *tt == Some(seq) {
                return Ok(Outcome::Done(false));
            }
            *tt = Some(seq);
            Ok(Outcome::Done(true))
        }
        fn confirm(&self, id: &str, run: bool, _t: i64) -> Result<Outcome, String> {
            let mut w = self.waiting.borrow_mut();
            let Some(i) = w.iter().position(|x| x == id) else { return Ok(Outcome::Done(false)) };
            w.remove(i);
            if run {
                self.ran.borrow_mut().push(id.to_owned());
            }
            Ok(Outcome::Done(true))
        }
        fn notify_left(&self) {
            *self.notified.borrow_mut() += 1;
        }
        fn wipe_key(&self, l: &Value) -> Result<(), String> {
            let mut k = self.key.borrow_mut();
            if k.as_ref() == Some(l) {
                *k = None;
            }
            Ok(())
        }
        fn remove_link(&self, l: &Value) -> Result<(), String> {
            let mut cur = self.link.borrow_mut();
            if cur.as_ref() == Some(l) {
                *cur = None;
            }
            Ok(())
        }
        fn audit(&self, r: Record, _t: i64) {
            self.audit.borrow_mut().push((r.action.clone(), r.detail.clone()));
        }
        fn audited(&self, action: &str, id: &str) -> bool {
            self.audit.borrow().iter().any(|(a, d)| a == action && str_of(d.get("id")) == Some(id))
        }
    }

    fn command(kind: &str, link: Value, args: Value) -> (String, Value) {
        let id = random_id("lc_").unwrap();
        (id.clone(), json!({ "id": id, "kind": kind, "link": link, "args": args }))
    }

    fn write_commands(dir: &Path, cmds: Vec<Value>) {
        let mut f = read_local(dir).unwrap();
        f.commands.extend(cmds);
        f.gen += 1;
        write_local(dir, &f).unwrap();
    }

    fn crash_at(point: &str) {
        CRASH.with(|c| *c.borrow_mut() = Some(point.to_owned()));
    }

    /// A poll killed at `point` (the panic stands for the process being killed), then a clean poll.
    fn crash_then_poll(fx: &Fx, dir: &Path, point: &str) {
        crash_at(point);
        let r = catch_unwind(AssertUnwindSafe(|| poll(fx, dir, T)));
        assert!(r.is_err(), "the crash at {point} happened");
        CRASH.with(|c| *c.borrow_mut() = None);
        poll(fx, dir, T + 1).unwrap();
    }

    fn state_of(dir: &Path, id: &str) -> String {
        read_journal(dir).unwrap().into_iter().find(|e| e.id == id).map(|e| e.state).unwrap_or_default()
    }

    #[test]
    fn every_command_completes_eventually_after_a_crash_at_every_step() {
        for point in ["pending", "effect", "applied"] {
            // refuse-key: always ends with the hint refused.
            let dir = temp(&format!("rk-{point}"));
            let fx = Fx::enrolled(1);
            let (id, c) = command("refuse-key", link(1), json!({ "hint": "0123456789abcdef" }));
            write_commands(&dir, vec![c]);
            crash_then_poll(&fx, &dir, point);
            assert_eq!(*fx.refused.borrow(), vec!["0123456789abcdef".to_owned()], "{point}");
            assert_eq!(state_of(&dir, &id), "applied", "{point}");
            assert!(read_local(&dir).unwrap().commands.is_empty());
            // accept-scopes, trust-ca, refuse, trust-time-reset: applied once, a rerun changes nothing.
            let dir = temp(&format!("as-{point}"));
            let fx = Fx::enrolled(1);
            *fx.request.borrow_mut() = Some("sr_0000000000000001".into());
            fx.waiting.borrow_mut().push("fc_0000000000000001".into());
            let cmds = vec![
                command("accept-scopes", link(1), json!({ "requestId": "sr_0000000000000001", "hash": "a".repeat(64) })).1,
                command("trust-ca", link(1), json!({ "generation": 2, "fingerprint": "good" })).1,
                command("refuse", link(1), json!({ "id": "fc_0000000000000001" })).1,
                command("trust-time-reset", link(1), json!({ "manifest": { "seq": 9 } })).1,
            ];
            write_commands(&dir, cmds);
            crash_then_poll(&fx, &dir, point);
            assert_eq!(*fx.scopes_applied.borrow(), vec!["sr_0000000000000001".to_owned()]);
            assert_eq!(*fx.pins.borrow(), vec![2]);
            assert!(fx.waiting.borrow().is_empty() && fx.ran.borrow().is_empty());
            assert_eq!(*fx.trust_time.borrow(), Some(9));
            assert!(read_journal(&dir).unwrap().iter().all(|e| e.state == "applied"), "{point}");
        }
    }

    #[test]
    fn a_leave_always_ends_fully_left_once_after_a_crash_at_every_step() {
        for point in ["pending", "notify", "wipe-key", "remove-link", "audit", "applied"] {
            let dir = temp(&format!("leave-{point}"));
            let fx = Fx::enrolled(1);
            let (id, c) = command("leave", link(1), json!({}));
            write_commands(&dir, vec![c]);
            crash_then_poll(&fx, &dir, point);
            assert!(fx.link.borrow().is_none() && fx.key.borrow().is_none(), "{point}");
            assert_eq!(fx.count("fleet.left"), 1, "{point}");
            assert_eq!(state_of(&dir, &id), "applied");
            // Another poll does nothing more.
            poll(&fx, &dir, T + 2).unwrap();
            assert_eq!(fx.count("fleet.left"), 1);
        }
    }

    #[test]
    fn a_pending_old_link_command_never_touches_a_new_enrollment() {
        for kind in ["leave", "refuse-key", "accept-scopes", "trust-ca"] {
            for point in ["pending", "notify", "wipe-key"] {
                if kind != "leave" && point != "pending" {
                    continue;
                }
                let dir = temp(&format!("relink-{kind}-{point}"));
                let fx = Fx::enrolled(1);
                *fx.request.borrow_mut() = Some("sr_0000000000000001".into());
                let args = match kind {
                    "refuse-key" => json!({ "hint": "0123456789abcdef" }),
                    "accept-scopes" => json!({ "requestId": "sr_0000000000000001", "hash": "a".repeat(64) }),
                    "trust-ca" => json!({ "generation": 2, "fingerprint": "good" }),
                    _ => json!({}),
                };
                let (id, c) = command(kind, link(1), args);
                write_commands(&dir, vec![c]);
                crash_at(point);
                assert!(catch_unwind(AssertUnwindSafe(|| poll(&fx, &dir, T))).is_err());
                CRASH.with(|c| *c.borrow_mut() = None);
                // Left (or lost) and enrolled again while stopped: a new link and a new sealed key.
                *fx.link.borrow_mut() = Some(link(2));
                *fx.key.borrow_mut() = Some(link(2));
                poll(&fx, &dir, T + 1).unwrap();
                assert_eq!(state_of(&dir, &id), "stale", "{kind} {point}");
                assert_eq!(*fx.link.borrow(), Some(link(2)));
                assert_eq!(*fx.key.borrow(), Some(link(2)));
                assert!(fx.refused.borrow().is_empty() && fx.scopes_applied.borrow().is_empty() && fx.pins.borrow().is_empty());
                assert!(fx.audit.borrow().iter().any(|(a, d)| a == "fleet.local" && d["result"] == "stale"));
            }
        }
    }

    #[test]
    fn a_pending_leave_whose_link_is_gone_runs_only_its_audit_step_once() {
        let dir = temp("leave-gone");
        let fx = Fx::enrolled(1);
        let (id, c) = command("leave", link(1), json!({}));
        write_commands(&dir, vec![c]);
        crash_at("pending");
        assert!(catch_unwind(AssertUnwindSafe(|| poll(&fx, &dir, T))).is_err());
        CRASH.with(|c| *c.borrow_mut() = None);
        *fx.link.borrow_mut() = None;
        poll(&fx, &dir, T + 1).unwrap();
        assert_eq!(*fx.notified.borrow(), 0);
        assert_eq!(*fx.key.borrow(), Some(link(1)), "no link step ran");
        assert_eq!(fx.count("fleet.left"), 1);
        assert_eq!(state_of(&dir, &id), "applied");
        poll(&fx, &dir, T + 2).unwrap();
        assert_eq!(fx.count("fleet.left"), 1);
    }

    #[test]
    fn stale_and_replayed_commands_do_nothing_and_pending_ones_finish_first() {
        let dir = temp("stale");
        let fx = Fx::enrolled(2);
        // A leave written for the old link, still present after re-enrollment.
        let (old, c) = command("leave", link(1), json!({}));
        write_commands(&dir, vec![c]);
        poll(&fx, &dir, T).unwrap();
        assert_eq!(state_of(&dir, &old), "stale");
        assert_eq!(*fx.link.borrow(), Some(link(2)));
        // A command replayed after use: its id is in the journal, removed without effect.
        *fx.request.borrow_mut() = Some("sr_0000000000000001".into());
        let (id, c) = command("accept-scopes", link(2), json!({ "requestId": "sr_0000000000000001", "hash": "a".repeat(64) }));
        write_commands(&dir, vec![c.clone()]);
        poll(&fx, &dir, T).unwrap();
        *fx.request.borrow_mut() = Some("sr_0000000000000001".into());
        write_commands(&dir, vec![c]);
        poll(&fx, &dir, T).unwrap();
        assert_eq!(fx.scopes_applied.borrow().len(), 1);
        assert_eq!(state_of(&dir, &id), "applied");
        // An accept-scopes naming an old request is consumed stale.
        let (sid, c) = command("accept-scopes", link(2), json!({ "requestId": "sr_0000000000000009", "hash": "a".repeat(64) }));
        write_commands(&dir, vec![c]);
        poll(&fx, &dir, T).unwrap();
        assert_eq!(state_of(&dir, &sid), "stale");
        // A pending entry finishes before the next command is taken up.
        let (first, c1) = command("refuse-key", link(2), json!({ "hint": "1111111111111111" }));
        write_commands(&dir, vec![c1]);
        crash_at("pending");
        assert!(catch_unwind(AssertUnwindSafe(|| poll(&fx, &dir, T))).is_err());
        CRASH.with(|c| *c.borrow_mut() = None);
        let (second, c2) = command("refuse-key", link(2), json!({ "hint": "2222222222222222" }));
        write_commands(&dir, vec![c2]);
        poll(&fx, &dir, T).unwrap();
        assert_eq!(*fx.refused.borrow(), vec!["1111111111111111".to_owned(), "2222222222222222".to_owned()]);
        let j = read_journal(&dir).unwrap();
        let pos = |id: &str| j.iter().position(|e| e.id == id).unwrap();
        assert!(pos(&first) < pos(&second));
    }

    #[test]
    fn a_write_landing_between_read_and_rewrite_is_kept_and_two_writers_both_land() {
        let dir = temp("gen");
        let fx = Fx::enrolled(1);
        let (a, c) = command("refuse-key", link(1), json!({ "hint": "0123456789abcdef" }));
        write_commands(&dir, vec![c]);
        let late = command("trust-ca", link(1), json!({ "generation": 3, "fingerprint": "good" }));
        let d2 = dir.clone();
        let late_cmd = late.1.clone();
        HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // A writer between the relay's read and its rewrite: read only on and a new command.
                let mut f = read_local(&d2).unwrap();
                f.read_only = true;
                f.commands.push(late_cmd.clone());
                f.gen += 1;
                write_local(&d2, &f).unwrap();
            }))
        });
        let view = poll(&fx, &dir, T).unwrap();
        assert!(view.read_only, "the newer read only was not lost");
        assert_eq!(state_of(&dir, &a), "applied");
        assert_eq!(state_of(&dir, &late.0), "applied");
        assert_eq!(*fx.pins.borrow(), vec![3]);
        let f = read_local(&dir).unwrap();
        assert!(f.read_only && f.commands.is_empty());
        // Two writers at once both land.
        let dir = temp("writers");
        let (d1, d2) = (dir.clone(), dir.clone());
        let t1 = std::thread::spawn(move || add_command(&d1, "refuse-key", json!({ "hint": "aaaaaaaaaaaaaaaa" })).unwrap());
        let t2 = std::thread::spawn(move || add_command(&d2, "refuse-key", json!({ "hint": "bbbbbbbbbbbbbbbb" })).unwrap());
        let (i1, i2) = (t1.join().unwrap(), t2.join().unwrap());
        let f = read_local(&dir).unwrap();
        assert_eq!(f.gen, 2);
        let ids: Vec<&str> = f.commands.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&i1.as_str()) && ids.contains(&i2.as_str()));
    }

    #[test]
    fn an_unreadable_control_file_or_journal_applies_nothing() {
        let dir = temp("unreadable");
        let fx = Fx::enrolled(1);
        let (_, c) = command("leave", link(1), json!({}));
        write_commands(&dir, vec![c]);
        // A partial write.
        let full = std::fs::read(dir.join(LOCAL_FILE)).unwrap();
        std::fs::write(dir.join(LOCAL_FILE), &full[..full.len() / 2]).unwrap();
        assert!(poll(&fx, &dir, T).is_err());
        assert!(fx.link.borrow().is_some());
        // Extra keys or another version.
        std::fs::write(dir.join(LOCAL_FILE), br#"{"v":3,"gen":1,"settings":{"readOnly":false,"confirm":[]},"commands":[],"extra":1}"#).unwrap();
        assert!(read_local(&dir).is_err());
        std::fs::write(dir.join(LOCAL_FILE), br#"{"v":2,"gen":1,"settings":{"readOnly":false,"confirm":[]},"commands":[]}"#).unwrap();
        assert!(read_local(&dir).is_err());
        // An unreadable journal.
        std::fs::write(dir.join(LOCAL_FILE), br#"{"v":3,"gen":1,"settings":{"readOnly":false,"confirm":[]},"commands":[]}"#).unwrap();
        std::fs::write(dir.join(JOURNAL_FILE), b"{\"v\":1,\"entries\":[{\"id\":").unwrap();
        assert!(poll(&fx, &dir, T).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::remove_file(dir.join(JOURNAL_FILE));
            // A symbolic link swapped in, and a permission widened.
            let elsewhere = dir.join("elsewhere.json");
            std::fs::write(&elsewhere, br#"{"v":3,"gen":1,"settings":{"readOnly":false,"confirm":[]},"commands":[]}"#).unwrap();
            let _ = std::fs::remove_file(dir.join(LOCAL_FILE));
            std::os::unix::fs::symlink(&elsewhere, dir.join(LOCAL_FILE)).unwrap();
            assert!(read_local(&dir).is_err());
            std::fs::remove_file(dir.join(LOCAL_FILE)).unwrap();
            std::fs::write(dir.join(LOCAL_FILE), br#"{"v":3,"gen":1,"settings":{"readOnly":false,"confirm":[]},"commands":[]}"#).unwrap();
            std::fs::set_permissions(dir.join(LOCAL_FILE), std::fs::Permissions::from_mode(0o666)).unwrap();
            assert!(read_local(&dir).is_err());
        }
    }

    #[test]
    fn confirmations_queue_mark_running_and_close_unknown() {
        let dir = temp("confirm");
        let id = queue_confirm(&dir, &json!({ "kind": "call" }), "spokes.block n_1", "alice@acme.example", T).unwrap();
        assert_eq!(waiting(&dir).len(), 1);
        mark_running(&dir, &id).unwrap();
        assert!(confirm_item(&dir, &id).unwrap().is_none(), "a running item is not waiting");
        assert_eq!(take_running(&dir), vec![id.clone()]);
        assert!(waiting(&dir).is_empty());
        let id2 = queue_confirm(&dir, &json!({ "kind": "call" }), "x", "a@b.example", T).unwrap();
        assert!(take_expired(&dir, T + CONFIRM_MS - 1).is_empty());
        assert_eq!(take_expired(&dir, T + CONFIRM_MS), vec![id2]);
        for _ in 0..CONFIRM_MAX {
            queue_confirm(&dir, &json!({ "kind": "call" }), "x", "a@b.example", T).unwrap();
        }
        assert!(queue_confirm(&dir, &json!({ "kind": "call" }), "x", "a@b.example", T).is_err());
    }

    fn cli_run(dir: &Path, args: &[&str], input: &str) -> (i32, String) {
        let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
        let mut out = Vec::new();
        let code = cli(Product::Spokes, dir, &args, &mut std::io::Cursor::new(input.as_bytes().to_vec()), &mut out);
        (code, String::from_utf8(out).unwrap())
    }

    #[test]
    fn the_offline_audit_commands_recover_a_broken_headless_chain() {
        let dir = temp("audit");
        {
            let (mut a, _) = Audit::open(&dir, T);
            for i in 0..3 {
                a.append(T + i, &Record::new("relay", "fleet.call", "ok")).unwrap();
            }
        }
        // A torn tail.
        let seg = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.file_name().unwrap().to_string_lossy().starts_with("console-audit-0")).unwrap();
        let bytes = std::fs::read(&seg).unwrap();
        std::fs::write(&seg, &bytes[..bytes.len() - 20]).unwrap();
        let (code, out) = cli_run(&dir, &["audit", "verify"], "");
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("set aside"), "{out}");
        // Restart refuses without an export.
        let (code, out) = cli_run(&dir, &["audit", "restart"], "");
        assert_eq!(code, 1);
        assert!(out.contains("Export the audit log first"), "{out}");
        let export = dir.join("export.jsonl");
        let (code, out) = cli_run(&dir, &["audit", "export", "--out", export.to_str().unwrap()], "");
        assert_eq!(code, 0, "{out}");
        assert!(export.exists());
        // A wrong typed prefix refuses; the right one restarts.
        let (code, _) = cli_run(&dir, &["audit", "restart"], "0000000000000000\n");
        assert_eq!(code, 1);
        let (a, _) = Audit::open(&dir, T + 10);
        let sha = a.broken().unwrap().sha256.clone();
        drop(a);
        let (code, out) = cli_run(&dir, &["audit", "restart"], &format!("{}\n", &sha[..16]));
        assert_eq!(code, 0, "{out}");
        let (a, _) = Audit::open(&dir, T + 20);
        assert!(a.broken().is_none());
        assert!(a.entries().iter().any(|e| str_of(e.get("action")) == Some("audit.restart") && str_of(e.get("actor")) == Some("operator")));
        // While the relay runs (it holds fleet.lock) the offline commands refuse.
        let _running = FileLock::run(&dir).unwrap();
        let (code, out) = cli_run(&dir, &["audit", "verify"], "");
        assert_eq!(code, 1);
        assert!(out.contains(FLEET_RUNNING));
    }
}
