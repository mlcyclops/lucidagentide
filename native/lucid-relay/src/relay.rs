// The relay: a store-and-forward mailbox that sees ciphertext only. Rule for rule the add-on's src/relay.ts
// startRelay: every request signed by the caller's node key for this one mailbox (RS-RELAY-03) inside a 60 s window
// with a nonce never seen before; mail taken only for a node seen authenticating here (RS-RELAY-01); the per-sender
// quota, the store cap, the rate limit and the mailbox depth; the body limit while the body streams in (RS-RELAY-02);
// the 72 h TTL; the license (users on hub certificates, relays in the directory, 503 past grace); and the state folder
// in the same format, so a relay moves between the Bun relay and this one with its queued mail, seen book, CRL,
// directory and user book.

use crate::codec::{as_object, exact_keys, js_number_string, parse_json, safe_int, sha256_hex, str_of, stringify, unb64u, utf8_lossy};
use crate::console::{Console, CONSOLE_OFF};
use crate::der::{ecdsa_verify, CertNames};
use crate::identity::{is_node_id, DirectoryHolder, NodeCert, TrustStore, LOOPBACK_HOSTS};
use crate::license::{
    license_keys, license_state, license_user_of, migrate_license_file, verify_license, Admission, License, LicenseStateName, LicenseUsers, LICENSE_USERS_FILE, LICENSE_USERS_FILE_OLD,
    LICENSE_V1_SEATS_FILE, LICENSE_V1_SEATS_FILE_OLD, seat_problem, UNCOUNTED_REASON, UNLICENSED_DIRECTORY_REASON,
};
use crate::log::{Fields, Level, Logger};
use crate::store::{make_dir, read_text, remove, write_in_place, write_private};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const BODY_BYTES: usize = 320 * 1024;
const MAILBOX_MESSAGES: usize = 1000;
const SENDS_PER_MINUTE: usize = 120;
pub const MESSAGE_TTL_MS: i64 = 72 * 3_600_000;
const AUTH_WINDOW_MS: f64 = 60_000.0;
const INBOX_BATCH: usize = 50;
pub const STORE_BYTES: i64 = 128 * 1024 * 1024;
pub const SENDER_BYTES: i64 = 16 * 1024 * 1024;
const PRESENCE_MS: i64 = 72 * 3_600_000;
const SEEN_MS: i64 = MESSAGE_TTL_MS;
const SEEN_SAVE_MS: i64 = 3_600_000;
pub const LICENSE_CHECK_MS: u64 = 24 * 3_600_000;
const EXPIRED_LOG_EVERY_MS: i64 = 60_000;
/// The books are swept at most this often, and only for a request whose authorization parses.
const SWEEP_EVERY_MS: i64 = 1000;
/// Why a LAN mailbox refuses its owner's node id on a certificate that is not a spoke's.
const OWNER_NOT_SPOKE: &str = "the owner of this LAN mailbox must be a spoke";

/// What startRelay takes, as `relay serve` (or a spoke's LAN mailbox, `owner`) builds it.
pub struct Options {
    pub root: crate::der::P256Key,
    pub owner: Option<String>,
    /// The license token (already out of its armor).
    pub license: Option<String>,
    pub crl_file: Option<PathBuf>,
    pub store: Option<PathBuf>,
    pub seen_file: Option<PathBuf>,
    pub directory_file: Option<PathBuf>,
    pub users_file: Option<PathBuf>,
    pub store_bytes: i64,
    pub sender_bytes: i64,
    /// The control panel (src/console.rs), when it is on: /v1/logs and /v1/console/invite go to it.
    pub console: Option<Arc<Console>>,
}

struct Licensed {
    token: String,
    license: License,
    dev: bool,
    users: LicenseUsers,
}

struct Stored {
    env: Value,
    from: String,
    to: String,
    id: String,
    at: i64,
    bytes: i64,
}

struct Seen {
    role: String,
    at: i64,
    serial: String,
    exp: i64,
}

/// A finished answer: status, content type and body, and whether the connection closes after it.
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
    pub close: bool,
}

pub fn json_reply(status: u16, data: &Value) -> Reply {
    Reply { status, content_type: "application/json", body: stringify(data), close: false }
}

fn deny() -> Reply {
    Reply { status: 401, content_type: "text/plain;charset=utf-8", body: "unauthorized".into(), close: false }
}

/// Every refusal is one security line: the status, the error the caller sees, and who asked.
pub fn refuse(logger: &Logger, status: u16, error: &str, event: &str, fields: &Fields) -> Reply {
    let f = Fields::new().with("status", status).with("error", error).merge(fields);
    logger.security(event, &f, Level::Warn);
    json_reply(status, &json!({ "ok": false, "error": error }))
}

/// The request as the relay sees it: method, path with its query, the dialed host, and the body text.
pub struct Request<'a> {
    pub method: &'a str,
    pub pathname: &'a str,
    pub path: &'a str,
    pub authorization: &'a str,
    /// F2 (ADR-A100): the `lucid-seat` header, a hub's license seat.
    pub seat: Option<&'a str>,
    pub dialed: &'a Dialed,
    pub body: &'a str,
    pub where_: &'a Fields,
}

/// The host a caller dialed, as `new URL(req.url)` normalizes it: `host` (with a port that is not the default),
/// `hostname` (IPv6 in brackets) and the port number the request went to.
pub struct Dialed {
    pub host: String,
    pub hostname: String,
    pub port: u16,
}

pub struct State {
    owner: Option<String>,
    trust: TrustStore,
    licensed: Option<Licensed>,
    directory: DirectoryHolder,
    mailboxes: HashMap<String, Vec<Stored>>,
    nonces: HashMap<String, i64>,
    sends: HashMap<String, Vec<i64>>,
    polls: IndexMap<String, i64>,
    held: i64,
    held_by: HashMap<String, i64>,
    seen: IndexMap<String, Seen>,
    seen_saved_at: i64,
    /// When sweep() last ran, None before the first.
    swept_at: Option<i64>,
    license_seen: Option<LicenseStateName>,
    expired_refused: i64,
    expired_logged_at: Option<i64>,
    store_cap: i64,
    sender_cap: i64,
    crl_file: Option<PathBuf>,
    store: Option<PathBuf>,
    seen_file: Option<PathBuf>,
    directory_file: Option<PathBuf>,
    logger: Arc<Logger>,
    console: Option<Arc<Console>>,
    started: i64,
    /// For the control panel: each node's certificate label and user email, as last seen since the start.
    labels: HashMap<String, (String, Option<String>)>,
}

fn store_name(to: &str, id: &str) -> String {
    format!("{to}.{id}.json")
}

/// STORE_NAME_RE: `<recipient node id>.<envelope id>.json`.
fn parse_store_name(name: &str) -> Option<(&str, &str)> {
    let stem = name.strip_suffix(".json")?;
    let (to, id) = stem.split_once('.')?;
    (is_node_id(to) && crate::identity::is_serial(id)).then_some((to, id))
}

/// `/\.tmp-\d+$/`: a torn write.
fn is_torn(name: &str) -> bool {
    name.rfind(".tmp-").is_some_and(|i| {
        let digits = &name[i + 5..];
        !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())
    })
}

/// envelope.ts parseEnvelope: a shape the relay may store and forward.
pub fn parse_envelope(v: Option<&Value>) -> Option<(&Map<String, Value>, String, String, String)> {
    let o = v?.as_object()?;
    const KEYS: [&str; 10] = ["v", "from", "to", "id", "ts", "cert", "epk", "iv", "ct", "sig"];
    if !exact_keys(o, &KEYS, &KEYS) || !crate::codec::num_is(o.get("v"), 1.0) {
        return None;
    }
    let from = str_of(o.get("from")).filter(|s| is_node_id(s))?;
    let to = str_of(o.get("to")).filter(|s| is_node_id(s))?;
    let id = str_of(o.get("id")).filter(|s| crate::identity::is_serial(s))?;
    safe_int(o.get("ts"))?;
    let cert = str_of(o.get("cert"))?;
    let b64u_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let (a, b) = cert.split_once('.')?;
    if a.is_empty() || b.is_empty() || !a.bytes().all(b64u_char) || !b.bytes().all(b64u_char) {
        return None;
    }
    for k in ["epk", "iv", "ct", "sig"] {
        unb64u(str_of(o.get(k))?)?;
    }
    Some((o, from.to_owned(), to.to_owned(), id.to_owned()))
}

/// How many relays a directory may name under `license`: its count. F2 (ADR-A100): a mailbox with no license (a spoke's
/// LAN mailbox) carries one at most, or it would hand nodes a list of more relays than any licensed relay would serve.
fn relay_cap_of(license: Option<&License>) -> i64 {
    license.map_or(1, |l| l.relays)
}

/// Why a directory naming `relays` distinct relays may not be served under `license` (None: no license), or None.
fn relays_over_cap(license: Option<&License>, relays: usize) -> Option<String> {
    if relays as i64 <= relay_cap_of(license) {
        return None;
    }
    let Some(l) = license else { return Some(UNLICENSED_DIRECTORY_REASON.into()) };
    Some(if l.edition == "standard" {
        "a Standard license covers one relay; more relays need an Enterprise license".into()
    } else {
        format!("the license covers {} relays", l.relays)
    })
}

impl State {
    /// Load everything a restarted relay needs and judge the license; Err is why the relay does not start.
    pub fn new(opts: Options, logger: Arc<Logger>) -> Result<State, String> {
        let mut trust = TrustStore::new(opts.root);
        if let Some(file) = opts.crl_file.as_ref().filter(|f| f.exists()) {
            let text = read_text(file).unwrap_or_default();
            if let Err(reason) = trust.accept_crl(&text) {
                // Fail closed: never start without the revocations we had.
                logger.security("crl.stored-refused", &Fields::new().with("reason", &reason), Level::Error);
                return Err(format!("stored CRL refused: {reason}"));
            }
        }
        let now = crate::codec::now_ms();
        let licensed = match &opts.license {
            None => None,
            Some(token) => {
                let keys = license_keys(|k| std::env::var(k).ok())?;
                match verify_license(token, &trust.root_id, &keys, now.div_euclid(1000)) {
                    Err(reason) => {
                        logger.security("license.refused", &Fields::new().with("reason", &reason), Level::Error);
                        return Err(format!("relay license refused: {reason}"));
                    }
                    Ok(c) => {
                        if let Some(file) = opts.users_file.as_deref().filter(|f| f.file_name().is_some_and(|n| n == LICENSE_USERS_FILE)) {
                            let dir = file.parent().unwrap_or(Path::new(""));
                            if migrate_license_file(dir, LICENSE_USERS_FILE_OLD, LICENSE_USERS_FILE)? {
                                let f = Fields::new().with("from", dir.join(LICENSE_USERS_FILE_OLD).display().to_string()).with("to", file.display().to_string());
                                logger.ops("license.users-migrated", &f, Level::Info);
                            }
                            migrate_license_file(dir, LICENSE_V1_SEATS_FILE_OLD, LICENSE_V1_SEATS_FILE)?;
                        }
                        Some(Licensed { token: token.clone(), license: c.license, dev: c.dev, users: LicenseUsers::open(opts.users_file.as_deref())? })
                    }
                }
            }
        };
        if let (Some(_), Some(users_file)) = (&licensed, &opts.users_file) {
            let leftover = users_file.parent().map(|d| d.join(LICENSE_V1_SEATS_FILE)).unwrap_or_else(|| PathBuf::from(LICENSE_V1_SEATS_FILE));
            if leftover.exists() {
                let f = Fields::new().with("file", leftover.display().to_string()).with("why", "spokes are no longer counted (ADR-A077); remove the file");
                logger.ops("license.v1-seats-ignored", &f, Level::Warn);
            }
        }
        let mut st = State {
            owner: opts.owner,
            trust,
            licensed,
            directory: DirectoryHolder::default(),
            mailboxes: HashMap::new(),
            nonces: HashMap::new(),
            sends: HashMap::new(),
            polls: IndexMap::new(),
            held: 0,
            held_by: HashMap::new(),
            seen: IndexMap::new(),
            seen_saved_at: 0,
            swept_at: None,
            license_seen: None,
            expired_refused: 0,
            expired_logged_at: None,
            store_cap: opts.store_bytes,
            sender_cap: opts.sender_bytes,
            crl_file: opts.crl_file,
            store: opts.store,
            seen_file: opts.seen_file,
            directory_file: opts.directory_file,
            logger,
            console: opts.console,
            started: now,
            labels: HashMap::new(),
        };
        if let Some(stored) = st.directory_file.as_deref().and_then(read_text).filter(|s| !s.is_empty()) {
            // Not fatal, unlike the CRL; one naming more relays than the license covers is not loaded either.
            let t = now.div_euclid(1000);
            if let Some(over) = st.directory_over_cap(&stored, t) {
                let f = Fields::new().with("reason", over).with("relays", st.relay_cap());
                st.logger.security("directory.stored-over-license", &f, Level::Warn);
            } else if let Err(reason) = st.directory.accept(&st.trust, &stored, t) {
                st.logger.warn("directory.stored-refused", &Fields::new().with("reason", reason));
            }
        }
        if let Some(file) = st.seen_file.clone() {
            // A bad entry is skipped, a bad file is an empty book: spokes come back on their next poll.
            let t = crate::codec::now_ms();
            let parsed = parse_json(&read_text(&file).unwrap_or_default());
            let nodes = parsed.as_ref().and_then(as_object).and_then(|o| o.get("nodes")).and_then(as_object);
            for (node, v) in nodes.into_iter().flatten() {
                let Some(e) = v.as_object() else { continue };
                let (Some(role), Some(serial)) = (str_of(e.get("role")), str_of(e.get("serial"))) else { continue };
                let (Some(at), Some(exp)) = (safe_int(e.get("at")), safe_int(e.get("exp"))) else { continue };
                if !is_node_id(node) {
                    continue;
                }
                st.seen.insert(node.clone(), Seen { role: role.into(), at: at.min(t), serial: serial.into(), exp });
            }
            st.seen_saved_at = t;
        }
        // A LAN mailbox for a node this mailbox saw authenticate as a hub: --owner names a hub, not a spoke.
        if let Some(owner) = &st.owner {
            if st.seen.get(owner).is_some_and(|s| s.role != "spoke") {
                return Err(format!("--owner {owner} is a hub's node id (seen here on a hub certificate): a LAN mailbox belongs to a spoke"));
            }
        }
        if st.store.is_some() {
            st.restore_store()?;
        }
        st.check_license(crate::codec::now_ms())?;
        st.tell_console_revoked();
        Ok(st)
    }

    /// The control panel refuses admins whose inviting hub's certificate the CRL revokes (ADR-0540 review).
    fn tell_console_revoked(&self) {
        if let Some(console) = &self.console {
            console.set_revoked(self.trust.revoked_serials());
        }
    }

    pub fn licensed(&self) -> bool {
        self.licensed.is_some()
    }

    /// Load the store once at start, with the same TTL and caps as a live send. A file that does not read back as a
    /// stored envelope for the recipient and id its name says is skipped and logged, never fatal.
    fn restore_store(&mut self) -> Result<(), String> {
        let Some(dir) = self.store.clone() else { return Ok(()) };
        make_dir(&dir).map_err(|e| e.to_string())?;
        let t = crate::codec::now_ms();
        let mut names: Vec<String> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        let mut found = Vec::new();
        for name in names {
            let path = dir.join(&name);
            if is_torn(&name) {
                remove(&path); // torn write: its sender never got a 200
                continue;
            }
            let read = parse_store_name(&name).and_then(|(to, id)| {
                let raw = utf8_lossy(&std::fs::read(&path).ok()?);
                let parsed = parse_json(&raw)?;
                let o = parsed.as_object()?;
                let at = safe_int(o.get("at")).filter(|_| exact_keys(o, &["at", "env"], &["at", "env"]))?;
                let (env, from, eto, eid) = parse_envelope(o.get("env"))?;
                (eto == to && eid == id).then(|| Stored { env: Value::Object(env.clone()), from, to: eto, id: eid, at: at.min(t), bytes: raw.len() as i64 })
            });
            let Some(s) = read else {
                let f = Fields::new().with("file", name.as_str()).with("why", "does not read back as a stored envelope for the recipient and id its name says");
                self.logger.warn("store.skipped", &f);
                continue;
            };
            if t - s.at >= MESSAGE_TTL_MS {
                remove(&path);
                continue;
            }
            found.push(s);
        }
        found.sort_by_key(|s| s.at);
        let total = found.len();
        let mut dropped = 0usize;
        for s in found {
            let box_len = self.mailboxes.get(&s.to).map_or(0, Vec::len);
            let sender = self.held_by.get(&s.from).copied().unwrap_or(0);
            if box_len >= MAILBOX_MESSAGES || self.held + s.bytes > self.store_cap || sender + s.bytes > self.sender_cap {
                remove(&dir.join(store_name(&s.to, &s.id)));
                dropped += 1;
                continue;
            }
            self.held += s.bytes;
            self.held_by.insert(s.from.clone(), sender + s.bytes);
            self.mailboxes.entry(s.to.clone()).or_default().push(s);
        }
        let f = Fields::new().with("restored", total - dropped).with("dropped", dropped).with("mailboxes", self.mailboxes.len()).with("heldBytes", self.held);
        self.logger.ops("store.restored", &f, if dropped > 0 { Level::Warn } else { Level::Info });
        Ok(())
    }

    /// How many relays a directory this mailbox carries may name (relay_cap_of).
    fn relay_cap(&self) -> i64 {
        relay_cap_of(self.licensed.as_ref().map(|l| &l.license))
    }

    /// Why a root-signed directory may not be served here, or None (ADR-A077): it names more relays than relay_cap.
    fn directory_over_cap(&self, token: &str, t: i64) -> Option<String> {
        let mut probe = DirectoryHolder::default();
        probe.accept(&self.trust, token, t).ok()?;
        relays_over_cap(self.licensed.as_ref().map(|l| &l.license), probe.urls().iter().collect::<HashSet<_>>().len())
    }

    fn save_seen(&mut self, t: i64) {
        self.seen_saved_at = t;
        let Some(file) = &self.seen_file else { return };
        let mut nodes = Map::new();
        for (node, s) in &self.seen {
            nodes.insert(node.clone(), json!({ "role": s.role, "at": s.at, "serial": s.serial, "exp": s.exp }));
        }
        let text = format!("{}\n", stringify(&json!({ "nodes": nodes })));
        if let Err(e) = write_private(file, text.as_bytes()) {
            self.logger.ops("seen.write-failed", &Fields::new().with("reason", e.to_string()), Level::Warn);
        }
    }

    /// Record an authenticated node. Written at once when it is new or shows another certificate, else hourly.
    fn note_seen(&mut self, c: &NodeCert, t: i64) {
        let changed = self.seen.get(&c.node).is_none_or(|was| was.serial != c.serial || was.role != c.role);
        self.seen.insert(c.node.clone(), Seen { role: c.role.clone(), at: t, serial: c.serial.clone(), exp: c.exp });
        if self.console.is_some() {
            self.labels.insert(c.node.clone(), (c.label.clone(), c.user.as_ref().map(|u| u.email.clone())));
        }
        if changed || t - self.seen_saved_at >= SEEN_SAVE_MS {
            self.save_seen(t);
        }
    }

    /// Why mail for `to` is not taken, or None.
    fn recipient_problem(&self, to: &str, t: i64) -> Option<&'static str> {
        if self.owner.as_deref() == Some(to) {
            return None;
        }
        let Some(s) = self.seen.get(to) else { return Some("never authenticated here") };
        if self.trust.is_revoked(&s.serial) {
            return Some("its certificate was revoked");
        }
        if s.exp <= t.div_euclid(1000) {
            return Some("its certificate expired");
        }
        if s.role != "hub" && t - s.at >= SEEN_MS {
            return Some("not seen within 72 hours");
        }
        None
    }

    /// Free the seats of users whose every certificate was revoked or has expired.
    fn free_users(&mut self, t: i64) -> Result<(), String> {
        let Some(l) = self.licensed.as_mut() else { return Ok(()) };
        let trust = &self.trust;
        let freed = l.users.prune(|serial| trust.is_revoked(serial), t.div_euclid(1000))?;
        for f in freed {
            let fields = Fields::new().with("user", f.user).with("why", f.why).with("used", l.users.used()).with("users", l.license.users);
            self.logger.ops("user.freed", &fields, Level::Info);
        }
        Ok(())
    }

    /// Where the license stands, logged at start, once a day, and when a request finds it moved on.
    pub fn check_license(&mut self, t: i64) -> Result<(), String> {
        if self.licensed.is_none() {
            return Ok(());
        }
        self.free_users(t)?;
        let Some(lic) = self.licensed.as_ref() else { return Ok(()) };
        let l = &lic.license;
        let (state, days_left) = license_state(l, t.div_euclid(1000));
        self.license_seen = Some(state);
        let fields = Fields::new()
            .with("id", &l.id)
            .with("org", &l.org)
            .with("edition", &l.edition)
            .with("users", l.users)
            .with("used", lic.users.used())
            .with("relays", l.relays)
            .with("exp", l.exp)
            .with("state", state.as_str())
            .with("daysLeft", days_left);
        if lic.dev {
            let why = "development license: signed by LUCID_LICENSE_DEV_PUB (LUCID_LICENSE_DEV=1), not the publisher; never for production";
            self.logger.security("license.development", &fields.clone().with("why", why), Level::Warn);
        }
        match state {
            LicenseStateName::Valid => self.logger.ops("license.ok", &fields, Level::Info),
            LicenseStateName::Grace => {
                let why = format!("the license expired; the relay stops serving in {days_left} day(s) unless a renewed license is installed");
                self.logger.security("license.grace", &fields.with("why", why), Level::Warn);
            }
            LicenseStateName::Expired => {
                let why = "the license is past its grace: every route but /healthz answers 503 until a renewed license is installed; queued mail stays on disk";
                self.logger.security("license.expired", &fields.with("why", why), Level::Error);
            }
        }
        Ok(())
    }

    /// Past its grace a licensed relay answers 503 to every route but /healthz, before reading the body.
    pub fn license_gate(&mut self, t: i64, where_: &Fields) -> Result<Option<Reply>, String> {
        let Some(state) = self.licensed.as_ref().map(|l| license_state(&l.license, t.div_euclid(1000)).0) else { return Ok(None) };
        if Some(state) != self.license_seen {
            self.check_license(t)?;
        }
        if state != LicenseStateName::Expired {
            return Ok(None);
        }
        // One line a minute with the count, not one per poll: every spoke keeps polling a stopped relay.
        self.expired_refused += 1;
        if self.expired_logged_at.is_none_or(|at| t - at >= EXPIRED_LOG_EVERY_MS) {
            let f = where_.clone().with("status", 503u16).with("refused", self.expired_refused);
            self.logger.security("license.expired.refused", &f, Level::Warn);
            self.expired_refused = 0;
            self.expired_logged_at = Some(t);
        }
        Ok(Some(json_reply(503, &json!({ "ok": false, "error": "license expired" }))))
    }

    /// Drop envelopes from the books and from disk (acknowledged, expired or over a cap).
    fn forget(&mut self, list: Vec<Stored>) {
        for m in list {
            self.held -= m.bytes;
            let left = self.held_by.get(&m.from).copied().unwrap_or(0) - m.bytes;
            if left > 0 {
                self.held_by.insert(m.from.clone(), left);
            } else {
                self.held_by.remove(&m.from);
            }
            if let Some(dir) = &self.store {
                remove(&dir.join(store_name(&m.to, &m.id)));
            }
        }
    }

    fn sweep(&mut self, t: i64) {
        self.nonces.retain(|_, at| t - *at <= 2 * AUTH_WINDOW_MS as i64);
        self.polls.retain(|_, at| t - *at < PRESENCE_MS);
        // Dropped here, written with the next save: a stale entry on disk is judged again by recipient_problem.
        let stale: Vec<String> = self.seen.keys().filter(|n| self.recipient_problem(n, t).is_some()).cloned().collect();
        for n in stale {
            self.seen.shift_remove(&n);
            self.labels.remove(&n);
        }
        let mut expired = Vec::new();
        self.mailboxes.retain(|_, b| {
            let (keep, gone): (Vec<Stored>, Vec<Stored>) = std::mem::take(b).into_iter().partition(|m| t - m.at < MESSAGE_TTL_MS);
            expired.extend(gone);
            *b = keep;
            !b.is_empty()
        });
        self.forget(expired);
    }

    /// The caller's certificate, or why it was refused: (event, reason, claimed node).
    fn authenticate(&mut self, r: &Request, t: i64, host_ok: bool) -> Result<NodeCert, (&'static str, String, Option<String>)> {
        let failed = |reason: &str, claimed: Option<String>| Err(("auth.failed", reason.to_owned(), claimed));
        let Some(token) = r.authorization.strip_prefix("LucidNode ") else { return failed("no signed authorization", None) };
        let parsed = unb64u(token).and_then(|b| parse_json(&utf8_lossy(&b)));
        let Some(a) = parsed.as_ref().and_then(as_object).filter(|a| exact_keys(a, &["cert", "ts", "nonce", "sig"], &["cert", "ts", "nonce", "sig"])) else {
            return failed("malformed authorization", None);
        };
        let ts = a.get("ts").and_then(Value::as_f64).filter(|_| a.get("ts").is_some_and(Value::is_number));
        let nonce = str_of(a.get("nonce")).filter(|n| crate::identity::is_serial(n));
        let (Some(ts), Some(nonce), Some(sig)) = (ts, nonce, str_of(a.get("sig"))) else { return failed("malformed authorization", None) };
        // Only now, for an authorization that parses, and at most once a second: junk never costs a sweep.
        if self.swept_at.is_none_or(|at| t - at >= SWEEP_EVERY_MS || t < at) {
            self.swept_at = Some(t);
            self.sweep(t);
        }
        let claimed = str_of(a.get("cert"))
            .and_then(|c| unb64u(c.split('.').next().unwrap_or("")))
            .and_then(|b| parse_json(&utf8_lossy(&b)))
            .and_then(|v| str_of(v.get("node")).filter(|n| is_node_id(n)).map(str::to_owned));
        if (t as f64 - ts).abs() > AUTH_WINDOW_MS {
            return failed("timestamp outside the window", claimed);
        }
        let c = match self.trust.verify_cert(a.get("cert"), t.div_euclid(1000)) {
            Ok(c) => c,
            Err(reason) => return Err((if reason == "certificate revoked" { "auth.revoked" } else { "auth.failed" }, reason, claimed)),
        };
        // A LAN mailbox carries mail for its spoke: its node id on a hub certificate is not that spoke.
        if self.owner.as_deref() == Some(c.cert.node.as_str()) && c.cert.role != "spoke" {
            return failed(OWNER_NOT_SPOKE, claimed);
        }
        // RS-RELAY-03: the signature must name this mailbox: its owner, or the host the caller dialed.
        if self.owner.is_none() && !host_ok {
            return failed("request is for another host", claimed);
        }
        let audience = match &self.owner {
            Some(o) => format!("lan:{o}"),
            None => format!("relay:{}", r.dialed.host),
        };
        let signed = format!("lucid-relay-auth/v2\n{audience}\n{}\n{}\n{}\n{nonce}\n{}", r.method, r.path, js_number_string(ts), sha256_hex(r.body.as_bytes()));
        let good = unb64u(sig).is_some_and(|s| ecdsa_verify(&c.key, signed.as_bytes(), &s));
        if !good {
            return failed("bad request signature", claimed);
        }
        if self.nonces.contains_key(nonce) {
            return Err(("auth.replay", "nonce already used".into(), Some(c.cert.node)));
        }
        self.nonces.insert(nonce.to_owned(), t);
        Ok(c.cert)
    }

    /// Everything after the body is read: authenticate (sweeping the books, at most once a second), seat, route.
    pub fn serve(&mut self, r: &Request, t: i64, host_ok: bool) -> Result<Reply, String> {
        let me = match self.authenticate(r, t, host_ok) {
            Ok(c) => c,
            Err((event, reason, claimed)) => {
                let f = r.where_.clone().with("status", 401u16).with("reason", reason).with("claimedNode", claimed);
                self.logger.security(event, &f, Level::Warn);
                return Ok(deny());
            }
        };
        let who = r.where_.clone().with("node", &me.node).with("role", &me.role);
        let logger = self.logger.clone();
        if me.role == "hub" {
            if let Some(reply) = self.seat(&me, r.seat, t, &who)? {
                return Ok(reply);
            }
        }
        self.note_seen(&me, t);
        let body = || parse_json(r.body);
        let reply = match (r.pathname, r.method) {
            ("/v1/send", "POST") => self.send(&me, body(), t, &who),
            ("/v1/inbox", "GET") => {
                if me.role == "spoke" {
                    self.polls.insert(me.node.clone(), t);
                }
                let mail = self.mailboxes.get(&me.node).map(Vec::as_slice).unwrap_or_default();
                let messages: Vec<Value> = mail.iter().take(INBOX_BATCH).map(|m| m.env.clone()).collect();
                json_reply(200, &json!({ "ok": true, "messages": messages, "more": mail.len() > INBOX_BATCH }))
            }
            ("/v1/ack", "POST") => {
                let parsed = body();
                let ids = parsed
                    .as_ref()
                    .and_then(as_object)
                    .filter(|b| exact_keys(b, &["ids"], &["ids"]))
                    .and_then(|b| b.get("ids")?.as_array())
                    .filter(|ids| ids.len() <= 500)
                    .and_then(|ids| ids.iter().map(|i| i.as_str().map(str::to_owned)).collect::<Option<HashSet<String>>>());
                let Some(acked) = ids else { return Ok(refuse(&logger, 400, "malformed", "ack.malformed", &who)) };
                let all = self.mailboxes.remove(&me.node).unwrap_or_default();
                let (gone, kept): (Vec<Stored>, Vec<Stored>) = all.into_iter().partition(|m| acked.contains(&m.id));
                self.forget(gone);
                if !kept.is_empty() {
                    self.mailboxes.insert(me.node.clone(), kept);
                }
                json_reply(200, &json!({ "ok": true }))
            }
            ("/v1/directory", "GET") => json_reply(200, &json!({ "ok": true, "directory": self.directory.token() })),
            ("/v1/directory", "POST") => {
                // Any certified node may hand the relay a directory: only a root-signed, in-date, newer one is taken.
                let parsed = body();
                let token = parsed.as_ref().and_then(as_object).filter(|b| exact_keys(b, &["directory"], &["directory"])).and_then(|b| str_of(b.get("directory")));
                let Some(token) = token else { return Ok(refuse(&logger, 400, "malformed", "directory.malformed", &who)) };
                let ts = t.div_euclid(1000);
                if let Some(over) = self.directory_over_cap(token, ts) {
                    return Ok(refuse(&logger, 403, &over, "directory.over-license", &who.clone().with("relays", self.relay_cap())));
                }
                match self.directory.accept(&self.trust, token, ts) {
                    Err(reason) => refuse(&logger, 409, &reason, "directory.refused", &who),
                    Ok(changed) => {
                        if changed {
                            if let Some(file) = &self.directory_file {
                                write_private(file, format!("{token}\n").as_bytes()).map_err(|e| e.to_string())?;
                            }
                            logger.ops("directory.accepted", &Fields::new().with("node", &me.node).with("version", self.directory.version()), Level::Info);
                        }
                        json_reply(200, &json!({ "ok": true, "version": self.directory.version() }))
                    }
                }
            }
            ("/v1/crl", "GET") => json_reply(200, &json!({ "ok": true, "crl": self.trust.crl_token() })),
            ("/v1/crl", "POST") => {
                let parsed = body();
                let token = parsed.as_ref().and_then(as_object).filter(|b| exact_keys(b, &["crl"], &["crl"])).and_then(|b| str_of(b.get("crl")));
                let Some(token) = token else { return Ok(refuse(&logger, 400, "malformed", "crl.malformed", &who)) };
                match self.trust.accept_crl(token) {
                    Err(reason) => refuse(&logger, 409, &reason, "crl.refused", &who),
                    Ok(changed) => {
                        if changed {
                            if let Some(file) = &self.crl_file {
                                write_in_place(file, format!("{token}\n").as_bytes()).map_err(|e| e.to_string())?;
                            }
                            logger.ops("crl.accepted", &Fields::new().with("node", &me.node).with("version", self.trust.crl_version()), Level::Info);
                            self.free_users(t)?; // a user whose every certificate is revoked frees its seat now
                            self.tell_console_revoked(); // and an admin a revoked hub invited is signed out
                        }
                        json_reply(200, &json!({ "ok": true, "version": self.trust.crl_version() }))
                    }
                }
            }
            ("/v1/presence", "GET") => {
                // Only a hub that may recall sees which spokes are polling.
                if me.role != "hub" || !me.scopes.iter().any(|s| s == "recall") {
                    return Ok(refuse(&logger, 403, "presence needs a hub with the recall scope", "presence.refused", &who.clone().with("scopes", me.scopes.as_slice())));
                }
                let nodes: Vec<Value> = self.polls.iter().filter(|(_, at)| t - **at < PRESENCE_MS).map(|(node, at)| json!({ "node": node, "lastPollAt": at })).collect();
                json_reply(200, &json!({ "ok": true, "nodes": nodes }))
            }
            ("/v1/license", "GET") => match &self.licensed {
                // A spoke's LAN mailbox has none; hubs ask every mailbox, so that is an answer, not a refusal to log.
                None => json_reply(404, &json!({ "ok": false, "error": "this mailbox carries no license" })),
                Some(lic) => {
                    let l = &lic.license;
                    let (state, days_left) = license_state(l, t.div_euclid(1000));
                    let mut o = json!({
                        "ok": true, "id": l.id, "org": l.org, "edition": l.edition, "users": l.users, "used": lic.users.used(),
                        "relays": l.relays, "exp": l.exp, "state": state.as_str(), "daysLeft": days_left,
                    });
                    // ADR-A089: a development license hands out its signed token so a reader checks it itself.
                    if lic.dev {
                        if let Some(m) = o.as_object_mut() {
                            m.insert("dev".into(), Value::Bool(true));
                            m.insert("token".into(), Value::from(lic.token.as_str()));
                        }
                    }
                    json_reply(200, &o)
                }
            },
            // The control panel (ADR-A094): a spoke's own security and ops lines, kept in a ring per node.
            ("/v1/logs", "POST") => {
                let Some(console) = self.console.clone() else { return Ok(refuse(&logger, 409, CONSOLE_OFF, "logs.console-off", &who)) };
                if me.role != "spoke" {
                    return Ok(refuse(&logger, 403, "only a spoke sends its log lines here", "logs.refused", &who));
                }
                match console.take_logs(&me.node, r.body, t) {
                    Err(e) => refuse(&logger, e.status, &e.error, e.event, &who),
                    Ok(kept) => {
                        logger.perf("logs", &Fields::new().with("node", &me.node).with("lines", kept));
                        json_reply(200, &json!({ "ok": true, "kept": kept }))
                    }
                }
            }
            // The control panel's one-time invite, for the person a hub with the drive scope names.
            ("/v1/console/invite", "POST") => {
                let Some(console) = self.console.clone() else { return Ok(refuse(&logger, 409, CONSOLE_OFF, "console.invite-refused", &who)) };
                if me.role != "hub" || !me.scopes.iter().any(|s| s == "drive") {
                    let f = who.clone().with("scopes", me.scopes.as_slice());
                    return Ok(refuse(&logger, 403, "a control panel invite needs a hub with the drive scope", "console.invite-refused", &f));
                }
                let Some(email) = me.user.as_ref().map(|u| u.email.clone()) else {
                    return Ok(refuse(&logger, 403, "this hub's certificate names no user email: an invite is for a person", "console.invite-refused", &who));
                };
                if !parse_json(r.body).as_ref().and_then(as_object).is_some_and(|b| b.is_empty()) {
                    return Ok(refuse(&logger, 400, "malformed", "console.invite-malformed", &who));
                }
                match console.invite(&email, &me.node, &me.serial, r.dialed, t) {
                    Err(e) => refuse(&logger, e.status, &e.error, e.event, &who.clone().with("email", &email)),
                    Ok(inv) => {
                        // The link signs its holder in once: never written to a log.
                        logger.security("console.invite", &who.clone().with("email", &email).with("expires", inv.expires).with("consoleOrigin", &inv.origin), Level::Info);
                        json_reply(200, &json!({ "ok": true, "link": inv.link, "email": email, "expires": inv.expires, "origin": inv.origin }))
                    }
                }
            }
            _ => refuse(&logger, 404, "not found", "route.unknown", &who),
        };
        Ok(reply)
    }

    /// The control panel, when it is on.
    pub fn console(&self) -> Option<Arc<Console>> {
        self.console.clone()
    }

    /// What the control panel shows of the relay (read-only; never message contents): health, license, seats, nodes
    /// seen, CRL and directory versions. Times in `...At` are milliseconds; `exp` and `since` are seconds.
    pub fn console_status(&self, t: i64) -> Value {
        let mut queues: Vec<(&String, usize, i64)> = self.mailboxes.iter().map(|(n, b)| (n, b.len(), b.iter().map(|m| m.bytes).sum::<i64>())).collect();
        queues.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(b.0)));
        let queues: Vec<Value> = queues.iter().take(100).map(|(n, m, b)| json!({ "node": n, "messages": m, "bytes": b })).collect();
        let license = self.licensed.as_ref().map(|lic| {
            let l = &lic.license;
            let (state, days_left) = license_state(l, t.div_euclid(1000));
            json!({
                "id": l.id, "org": l.org, "edition": l.edition, "users": l.users, "used": lic.users.used(), "relays": l.relays,
                "exp": l.exp, "state": state.as_str(), "daysLeft": days_left, "dev": lic.dev,
            })
        });
        // A seat is a user key (u_ and a hash of the email); the email shows when a hub of that user was seen.
        let emails: HashMap<String, &str> = self.labels.values().filter_map(|(_, e)| e.as_deref()).map(|e| (crate::identity::user_id_of(e), e)).collect();
        let seats: Vec<Value> = self
            .licensed
            .as_ref()
            .map(|l| l.users.seats())
            .unwrap_or_default()
            .into_iter()
            .map(|s| json!({ "user": s.user, "email": emails.get(&s.user), "since": s.since, "certificates": s.certificates, "exp": s.exp }))
            .collect();
        let nodes: Vec<Value> = self
            .seen
            .iter()
            .map(|(node, s)| {
                let (label, email) = self.labels.get(node).cloned().unwrap_or_default();
                json!({
                    "node": node, "role": s.role, "label": label, "email": email, "serial": s.serial, "exp": s.exp,
                    "lastSeenAt": s.at, "lastPollAt": self.polls.get(node), "revoked": self.trust.is_revoked(&s.serial),
                })
            })
            .collect();
        json!({
            "relay": {
                "version": env!("CARGO_PKG_VERSION"), "startedAt": self.started, "uptimeSeconds": (t - self.started).max(0) / 1000,
                "mailboxes": self.mailboxes.len(), "queued": self.mailboxes.values().map(Vec::len).sum::<usize>(),
                "heldBytes": self.held, "storeBytes": self.store_cap, "senderBytes": self.sender_cap, "queues": queues,
            },
            "license": license,
            "seats": seats,
            "nodes": nodes,
            "crl": { "version": self.trust.crl_version() },
            "directory": { "version": self.directory.version(), "relays": self.directory.urls() },
        })
    }

    /// Users (ADR-A077): distinct people on hub certificates take a seat; a refused one first frees the seats of users
    /// whose every certificate was revoked or expired.
    fn seat(&mut self, me: &NodeCert, seat: Option<&str>, t: i64, who: &Fields) -> Result<Option<Reply>, String> {
        // F2 (ADR-A100): only a hub the org root counted under THIS license (its seat, in the lucid-seat header), so one
        // license copied to many relays admits at most its users in all. This relay's own book is the second wall.
        if let Some(lic) = self.licensed.as_ref() {
            if let Some(why) = seat_problem(seat, self.trust.root_key(), &self.trust.root_id, &lic.license.id, me, t.div_euclid(1000)) {
                let f = who.clone().with("user", license_user_of(me)).with("license", &lic.license.id).with("why", why);
                return Ok(Some(refuse(&self.logger, 403, UNCOUNTED_REASON, "user.uncounted", &f)));
            }
        }
        let Some(lic) = self.licensed.as_mut() else { return Ok(None) };
        let users = lic.license.users;
        let mut seat = lic.users.admit(me, users, t.div_euclid(1000))?;
        if seat == Admission::Refused {
            self.free_users(t)?;
            let Some(lic) = self.licensed.as_mut() else { return Ok(None) };
            seat = lic.users.admit(me, users, t.div_euclid(1000))?;
        }
        let Some(lic) = self.licensed.as_ref() else { return Ok(None) };
        let l = &lic.license;
        let counts = Fields::new().with("user", license_user_of(me)).with("used", lic.users.used()).with("users", l.users).with("edition", &l.edition);
        match seat {
            Admission::Refused => {
                let tail = if l.edition == "standard" { " (Standard); more users need an Enterprise license" } else { "" };
                let error = format!("the license allows {} users{tail}", l.users);
                Ok(Some(refuse(&self.logger, 403, &error, "user.refused", &who.clone().merge(&counts))))
            }
            Admission::Taken => {
                let f = Fields::new().with("node", &me.node).with("label", &me.label).merge(&counts);
                self.logger.ops("user.taken", &f, Level::Info);
                Ok(None)
            }
            Admission::Held => Ok(None),
        }
    }

    fn send(&mut self, me: &NodeCert, body: Option<Value>, t: i64, who: &Fields) -> Reply {
        let logger = self.logger.clone();
        let Some((env, from, to, id)) = parse_envelope(body.as_ref()).filter(|(_, from, _, _)| *from == me.node) else {
            return refuse(&logger, 400, "malformed envelope", "send.malformed", who);
        };
        if let Some(owner) = &self.owner {
            if to != *owner && from != *owner {
                return refuse(&logger, 403, "this mailbox carries messages for its own spoke only", "send.foreign", &who.clone().with("to", &to));
            }
        }
        // Mail nobody will collect would sit out the TTL against the store.
        if to == me.node {
            return refuse(&logger, 403, "a node may not send mail to itself", "send.self", who);
        }
        if let Some(why) = self.recipient_problem(&to, t) {
            return refuse(&logger, 403, "the recipient is unknown to this mailbox", "send.unknown-recipient", &who.clone().with("to", &to).with("why", why));
        }
        let recent: Vec<i64> = self.sends.get(&me.node).map(|v| v.iter().copied().filter(|at| t - at < 60_000).collect()).unwrap_or_default();
        if recent.len() >= SENDS_PER_MINUTE {
            return refuse(&logger, 429, "rate limited", "send.rate-limited", &who.clone().with("perMinute", SENDS_PER_MINUTE));
        }
        let mut recent = recent;
        recent.push(t);
        self.sends.insert(me.node.clone(), recent);
        let depth = self.mailboxes.get(&to).map_or(0, Vec::len);
        if depth >= MAILBOX_MESSAGES {
            return refuse(&logger, 507, "recipient mailbox is full", "mailbox.full", &who.clone().with("to", &to).with("depth", depth));
        }
        let ct_len = str_of(env.get("ct")).map_or(0, str::len);
        let env = Value::Object(env.clone());
        let duplicate = self.mailboxes.get(&to).is_some_and(|b| b.iter().any(|m| m.id == id));
        if !duplicate {
            let record = stringify(&json!({ "at": t, "env": env }));
            let bytes = record.len() as i64;
            let mine = self.held_by.get(&me.node).copied().unwrap_or(0);
            if mine + bytes > self.sender_cap {
                let f = who.clone().with("to", &to).with("heldBytes", mine).with("capBytes", self.sender_cap);
                return refuse(&logger, 507, "this sender's queued mail is at its quota", "send.quota", &f);
            }
            if self.held + bytes > self.store_cap {
                let f = who.clone().with("to", &to).with("heldBytes", self.held).with("capBytes", self.store_cap);
                return refuse(&logger, 507, "relay store is full", "store.full", &f);
            }
            // On disk before the 200: a sender that got ok may forget the message, so the relay must not.
            if let Some(dir) = &self.store {
                if let Err(e) = write_private(&dir.join(store_name(&to, &id)), record.as_bytes()) {
                    logger.ops("store.write-failed", &who.clone().with("to", &to).with("reason", e.to_string()), Level::Error);
                    return json_reply(507, &json!({ "ok": false, "error": "relay store failed" }));
                }
            }
            self.mailboxes.entry(to.clone()).or_default().push(Stored { env, from, to: to.clone(), id, at: t, bytes });
            self.held += bytes;
            self.held_by.insert(me.node.clone(), mine + bytes);
        }
        let depth = self.mailboxes.get(&to).map_or(0, Vec::len);
        let f = Fields::new().with("from", &me.node).with("to", &to).with("bytes", ct_len).with("depth", depth).with("mailboxes", self.mailboxes.len()).with("heldBytes", self.held);
        logger.perf("send", &f);
        json_reply(200, &json!({ "ok": true }))
    }
}

/// The relay's own TLS names and listening port, or behind a TLS front its public host, for RS-RELAY-03's host check.
pub struct HostCheck {
    pub names: Option<CertNames>,
    pub port: u16,
    /// LUCID_RELAY_PUBLIC_HOST behind a TLS front, as an https URL's host normalizes it.
    pub public: Option<Dialed>,
}

impl HostCheck {
    /// Whether a request's Host names this relay: with its own TLS certificate the name must be on it and the port
    /// the one it listens on; behind a TLS front, the public host exactly (so the audience a request is signed for
    /// and the control panel's origin are that host); plain HTTP with neither, loopback on the listening port only.
    pub fn accepts(&self, d: &Dialed) -> bool {
        if let Some(p) = &self.public {
            return d.host == p.host;
        }
        let name = d.hostname.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&d.hostname);
        if let Some(names) = &self.names {
            return d.port == self.port
                && match name.parse::<std::net::IpAddr>() {
                    Ok(ip) => names.check_ip(&ip),
                    Err(_) => names.check_host(name),
                };
        }
        LOOPBACK_HOSTS.contains(&d.hostname.as_str()) && d.port == self.port
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_names_and_torn_writes() {
        let to = "n_0123456789abcdef0123456789abcdef";
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse_store_name(&format!("{to}.{id}.json")), Some((to, id)));
        assert_eq!(parse_store_name(&format!("{to}.{id}.json.tmp-42")), None);
        assert!(is_torn(&format!("{to}.{id}.json.tmp-42")));
        assert!(!is_torn("seen.json"));
        assert_eq!(parse_store_name("seen.json"), None);
    }

    fn license(edition: &str, relays: i64) -> License {
        License { id: "l_0123456789abcdef".into(), org: String::new(), root: String::new(), edition: edition.into(), users: 20, relays, exp: 0, grace_days: 14 }
    }

    #[test]
    fn f2_a_mailbox_with_no_license_carries_one_relay_at_most() {
        assert_eq!(relays_over_cap(None, 1), None);
        assert_eq!(relays_over_cap(None, 2).as_deref(), Some(UNLICENSED_DIRECTORY_REASON));
        let standard = license("standard", 1);
        assert_eq!(relays_over_cap(Some(&standard), 1), None);
        assert_eq!(relays_over_cap(Some(&standard), 2).as_deref(), Some("a Standard license covers one relay; more relays need an Enterprise license"));
        let enterprise = license("enterprise", 3);
        assert_eq!(relays_over_cap(Some(&enterprise), 3), None);
        assert_eq!(relays_over_cap(Some(&enterprise), 4).as_deref(), Some("the license covers 3 relays"));
    }

    use crate::codec::b64u;
    use crate::der::p256_spki_der;
    use crate::identity::node_id_of;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};

    const T0: i64 = 1_800_000_000_000;

    fn compact(key: &SigningKey, payload: &Value) -> String {
        let body = stringify(payload);
        let sig: Signature = key.sign(body.as_bytes());
        format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
    }

    /// A node's key, root-signed certificate and id.
    fn node(root: &SigningKey, seed: u8, role: &str) -> (SigningKey, String, String) {
        let key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let spki = p256_spki_der(&key.verifying_key().into());
        let id = node_id_of(&spki);
        let now = T0 / 1000;
        let p = json!({
            "v": 1, "typ": "lucid-node-cert", "serial": format!("{seed:032x}"), "root": node_id_of(&p256_spki_der(&root.verifying_key().into())),
            "node": id, "role": role, "label": format!("{role} {seed}"), "spki": b64u(&spki), "scopes": [], "iat": now - 60, "exp": now + 86_400,
        });
        (key, compact(root, &p), id)
    }

    fn state(root: &SigningKey, owner: Option<String>, seen_file: Option<PathBuf>) -> Result<State, String> {
        let opts = Options {
            root: root.verifying_key().into(),
            owner,
            license: None,
            crl_file: None,
            store: None,
            seen_file,
            directory_file: None,
            users_file: None,
            store_bytes: STORE_BYTES,
            sender_bytes: SENDER_BYTES,
            console: None,
        };
        State::new(opts, Arc::new(Logger::capture("relay", Box::new(|_, _| {}))))
    }

    /// GET /v1/inbox signed by `key` and `cert` for `audience`: the status.
    fn inbox(st: &mut State, key: &SigningKey, cert: &str, audience: &str, t: i64, nonce: u32) -> u16 {
        let nonce = format!("{nonce:032x}");
        let line = format!("lucid-relay-auth/v2\n{audience}\nGET\n/v1/inbox\n{}\n{nonce}\n{}", js_number_string(t as f64), sha256_hex(b""));
        let sig: Signature = key.sign(line.as_bytes());
        let a = json!({ "cert": cert, "ts": t, "nonce": nonce, "sig": b64u(sig.to_der().as_bytes()) });
        let authorization = format!("LucidNode {}", b64u(stringify(&a).as_bytes()));
        let d = Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 443 };
        let where_ = Fields::new();
        let r = Request { method: "GET", pathname: "/v1/inbox", path: "/v1/inbox", authorization: &authorization, seat: None, dialed: &d, body: "", where_: &where_ };
        st.serve(&r, t, true).unwrap().status
    }

    #[test]
    fn a_lan_mailbox_refuses_its_owner_id_on_a_hub_certificate() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (spoke_key, spoke_cert, spoke) = node(&root, 2, "spoke");
        let (hub_key, hub_cert, hub) = node(&root, 3, "hub");
        let mut lan = state(&root, Some(spoke.clone()), None).unwrap();
        assert_eq!(inbox(&mut lan, &spoke_key, &spoke_cert, &format!("lan:{spoke}"), T0, 1), 200);
        // A LAN mailbox whose --owner is a hub's node id: that hub never authenticates as its owner.
        let mut wrong = state(&root, Some(hub.clone()), None).unwrap();
        assert_eq!(inbox(&mut wrong, &hub_key, &hub_cert, &format!("lan:{hub}"), T0, 2), 401);
        // And a mailbox that saw that id on a hub certificate refuses to start with it as --owner.
        let dir = std::env::temp_dir().join(format!("lucid-relay-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let seen = dir.join("lan-mailbox-seen.json");
        let book = json!({ "nodes": { hub.clone(): { "role": "hub", "at": T0, "serial": format!("{:032x}", 3), "exp": T0 / 1000 + 86_400 } } });
        std::fs::write(&seen, stringify(&book)).unwrap();
        let e = state(&root, Some(hub.clone()), Some(seen)).err().unwrap_or_default();
        assert!(e.contains("is a hub's node id"), "{e}");
    }

    #[test]
    fn only_an_authorization_that_parses_sweeps_and_at_most_once_a_second() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mut st = state(&root, None, None).unwrap();
        let junk = |st: &mut State, authorization: &str, t: i64| {
            let d = Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 443 };
            let where_ = Fields::new();
            let r = Request { method: "GET", pathname: "/v1/inbox", path: "/v1/inbox", authorization, seat: None, dialed: &d, body: "", where_: &where_ };
            st.serve(&r, t, true).unwrap().status
        };
        // A nonce long past its window: the next sweep drops it.
        st.nonces.insert("stale".into(), 0);
        let t = T0;
        assert_eq!(junk(&mut st, "", t), 401);
        assert_eq!(junk(&mut st, "LucidNode !!!", t), 401);
        assert_eq!(junk(&mut st, &format!("LucidNode {}", b64u(b"{\"cert\":1}")), t), 401);
        assert!(st.nonces.contains_key("stale") && st.swept_at.is_none(), "junk never sweeps");
        // An authorization that parses (its certificate is still refused) sweeps.
        let parses = format!("LucidNode {}", b64u(stringify(&json!({ "cert": "a.b", "ts": t, "nonce": format!("{:032x}", 9), "sig": "AA" })).as_bytes()));
        assert_eq!(junk(&mut st, &parses, t), 401);
        assert!(!st.nonces.contains_key("stale"));
        assert_eq!(st.swept_at, Some(t));
        // Within the second, no second sweep; after it, one.
        st.nonces.insert("stale".into(), 0);
        assert_eq!(junk(&mut st, &parses, t + 999), 401);
        assert!(st.nonces.contains_key("stale"));
        assert_eq!(junk(&mut st, &parses, t + 1000), 401);
        assert!(!st.nonces.contains_key("stale"));
        assert_eq!(st.swept_at, Some(t + 1000));
    }
}
