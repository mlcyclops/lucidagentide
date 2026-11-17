// The relay: a store-and-forward mailbox that sees ciphertext only. Rule for rule the add-on's src/relay.ts
// startRelay: every request signed by the caller's node key for this one mailbox (RS-RELAY-03) inside a 60 s window
// with a nonce never seen before; mail taken only for a node seen authenticating here (RS-RELAY-01); the per-sender
// quota, the store cap, the rate limit and the mailbox depth; the body limit while the body streams in (RS-RELAY-02);
// the 72 h TTL; the license (users on hub certificates, relays in the directory, 503 past grace); and the state folder
// in the same format, so a relay moves between the Bun relay and this one with its queued mail, seen book, CRL,
// directory and user book.

use crate::codec::{as_object, exact_keys, js_number_string, parse_json, safe_int, sha256_hex, str_of, stringify, unb64u, utf8_lossy};
use crate::console::{Console, CONSOLE_OFF};
use crate::console_spokes::{license_notice, observes, Block, BlockPath, Blocks, LicenseNotices, Observed, UncountedRing, BLOCKS_FILE, LICENSE_MAIL, NODE_BLOCKED, REQUESTS_REFUSED};
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
    /// The --state folder: with the console on, its block list (console-blocks.json) lives there.
    pub state_dir: Option<PathBuf>,
    /// The file --license named, when it named a file (not armored text): where the console installs a license.
    pub license_file: Option<PathBuf>,
}

/// AC-2a 5.7: the link to a Lucid Admin Console while this relay is enrolled (server.rs builds it from fleet_agent).
pub struct FleetLink {
    /// The console origin while the link stands; None once the relay left or was removed.
    pub managed_by: Box<dyn Fn() -> Option<String> + Send + Sync>,
    /// The book holding the requests the fleet creates: the headless console's, or the local console's when it is on.
    pub book: Arc<Console>,
    /// The active admin emails of the fleet roster: who reads `/v1/console/requests` while the local console is off.
    pub admins: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    /// The relay's state folder (fleet.json), for the 3.9 endorsement routes.
    pub state_dir: PathBuf,
}

/// 9.2: a spoke's latest `lanes.state` line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lanes {
    pub busy: u8,
    pub live: u8,
    pub max: u8,
    pub at: i64,
}

/// 9.1: "online" and lane reports count within this window.
pub const ONLINE_MS: i64 = 5 * 60_000;
/// 9.1 `spokes_total`: spokes seen within 30 days.
const SPOKES_TOTAL_MS: i64 = 30 * 86_400_000;
/// 9.1 `spokes_busy` and `spokes/counts` `busy`: mail sent or received within the 60 s interval.
const BUSY_MS: i64 = 60_000;
/// 5.7 (F20): endorsement attempts per certificate per hour.
const ENDORSE_TRIES: usize = 10;
/// The 409 of the endorsement routes when no bootstrap is pending (13.3).
pub const NOT_BOOTSTRAPPING: &str = "fleet-not-bootstrapping";
pub const NOT_BOOTSTRAPPING_WORDS: &str = "This relay is not waiting for admin keys.";

/// The last valid `{"cat":"ops","event":"lanes.state","busy","live","max"}` line of a POST /v1/logs body: each value
/// an integer 0 to 8, else the line is ignored (9.2).
pub fn lanes_of(body: &str) -> Option<(u8, u8, u8)> {
    let parsed = parse_json(body)?;
    let lines = parsed.get("lines")?.as_array()?;
    lines.iter().rev().find_map(|l| {
        if str_of(l.get("cat")) != Some("ops") || str_of(l.get("event")) != Some("lanes.state") {
            return None;
        }
        let small = |k: &str| l.get(k).and_then(Value::as_u64).filter(|n| *n <= 8).map(|n| n as u8);
        Some((small("busy")?, small("live")?, small("max")?))
    })
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

/// 5.7: the 409 of the endorsement routes on a relay with no pending bootstrap (or not enrolled, or not a hub's user).
fn not_bootstrapping(logger: &Logger, who: &Fields) -> Reply {
    let e = crate::fleet_trust::EndorseRefusal { status: 409, code: NOT_BOOTSTRAPPING, why: None, error: NOT_BOOTSTRAPPING_WORDS.into() };
    endorse_refused(logger, &e, "fleet.bootstrap-refused", who)
}

/// A 3.9 refusal: `{ok: false, error, code, why}`, logged as a security line.
fn endorse_refused(logger: &Logger, e: &crate::fleet_trust::EndorseRefusal, event: &str, who: &Fields) -> Reply {
    let f = Fields::new().with("status", e.status).with("code", e.code).with("why", e.why).merge(who);
    logger.security(event, &f, Level::Warn);
    json_reply(e.status, &json!({ "ok": false, "error": e.error, "code": e.code, "why": e.why }))
}

/// A CRL or directory refused: the status and reason `/v1/crl` and `/v1/directory` answer, and the security event.
#[derive(Debug)]
pub struct Taken {
    pub status: u16,
    pub reason: String,
    pub event: &'static str,
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
    /// The console's blocks on this relay (4.8): fail closed at start, dropped at `until`.
    blocks: Blocks,
    /// Hubs refused with `user.uncounted` (4.8 seats view).
    uncounted: UncountedRing,
    /// The license notice mailed last (3.11, I12), when the console is on.
    notices: LicenseNotices,
    state_dir: Option<PathBuf>,
    license_file: Option<PathBuf>,
    /// 9.2 (F14): each spoke's latest `lanes.state` line.
    lanes: HashMap<String, Lanes>,
    /// 9.1: when each node last sent or received mail.
    mail_at: HashMap<String, i64>,
    /// 5.7: the Lucid Admin Console link, while enrolled.
    fleet: Option<FleetLink>,
    /// 5.7 (F20): endorsement attempts per certificate serial within the hour.
    endorse_tries: HashMap<String, Vec<i64>>,
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
        // A security list: with the console on, a block list that does not read back stops the start (section 0).
        let blocks = match (&opts.console, &opts.state_dir) {
            (Some(_), Some(dir)) => Blocks::open(&dir.join(BLOCKS_FILE)).inspect_err(|reason| {
                logger.security("console.blocks-unreadable", &Fields::new().with("reason", reason), Level::Error);
            })?,
            _ => Blocks::memory(),
        };
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
            blocks,
            uncounted: UncountedRing::default(),
            notices: LicenseNotices::default(),
            state_dir: opts.state_dir,
            license_file: opts.license_file,
            lanes: HashMap::new(),
            mail_at: HashMap::new(),
            fleet: None,
            endorse_tries: HashMap::new(),
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
        st.observe_crl(now);
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

    /// A root-signed directory from a node (`POST /v1/directory`) or the console: Ok(version), Ok(Err) refused with the
    /// status, reason and event `/v1/directory` answers, Err when the accepted one could not be written.
    pub fn take_directory(&mut self, token: &str, t: i64, by: &Fields) -> Result<Result<i64, Taken>, String> {
        let ts = t.div_euclid(1000);
        if let Some(over) = self.directory_over_cap(token, ts) {
            return Ok(Err(Taken { status: 403, reason: over, event: "directory.over-license" }));
        }
        match self.directory.accept(&self.trust, token, ts) {
            Err(reason) => Ok(Err(Taken { status: 409, reason, event: "directory.refused" })),
            Ok(changed) => {
                if changed {
                    if let Some(file) = &self.directory_file {
                        write_private(file, format!("{token}\n").as_bytes()).map_err(|e| e.to_string())?;
                    }
                    self.logger.ops("directory.accepted", &by.clone().with("version", self.directory.version()), Level::Info);
                }
                Ok(Ok(self.directory.version()))
            }
        }
    }

    /// A root-signed, newer CRL from a node (`POST /v1/crl`) or the console, as `take_directory` answers. A new one
    /// frees seats, latches the console's anchors (3.2) and completes the rs.revoke requests it lists (3.8).
    pub fn take_crl(&mut self, token: &str, t: i64, by: &Fields) -> Result<Result<i64, Taken>, String> {
        match self.trust.accept_crl(token) {
            Err(reason) => Ok(Err(Taken { status: 409, reason, event: "crl.refused" })),
            Ok(changed) => {
                if changed {
                    if let Some(file) = &self.crl_file {
                        write_in_place(file, format!("{token}\n").as_bytes()).map_err(|e| e.to_string())?;
                    }
                    self.logger.ops("crl.accepted", &by.clone().with("version", self.trust.crl_version()), Level::Info);
                    self.free_users(t)?; // a user whose every certificate is revoked frees its seat now
                    self.tell_console_revoked(); // and an admin a revoked hub invited is latched out
                    self.observe_crl(t);
                }
                Ok(Ok(self.trust.crl_version()))
            }
        }
    }

    /// 3.8 rs.revoke: the held CRL lists the request's serial.
    fn observe_crl(&self, t: i64) {
        let Some(console) = &self.console else { return };
        let version = self.trust.crl_version();
        let held = Observed::Crl { version, revoked: self.trust.revoked_serials() };
        console.observe_requests("rs.revoke", &format!("crl {version}"), t, &|target| observes("rs.revoke", target, 0, &held, None).is_some());
    }

    /// The held CRL's nextUpdate (seconds), read from its verified token, or None.
    fn crl_next_update(&self) -> Option<i64> {
        let token = self.trust.crl_token()?;
        safe_int(crate::identity::peek_compact(token)?.get("nextUpdate"))
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
        // 3.8 rs.renew: a certificate for the node with a later exp than the request's serial signs in.
        if let (Some(console), Some(was)) = (&self.console, self.seen.get(&c.node).filter(|w| w.serial != c.serial)) {
            let seen = Observed::Certificate { node: &c.node, serial: &c.serial, exp: c.exp };
            let by = format!("certificate {}", c.serial);
            console.observe_requests("rs.renew", &by, t, &|target| {
                let known = (str_of(target.get("serial")) == Some(was.serial.as_str())).then_some(was.exp);
                observes("rs.renew", target, 0, &seen, known).is_some()
            });
        }
        self.seen.insert(c.node.clone(), Seen { role: c.role.clone(), at: t, serial: c.serial.clone(), exp: c.exp });
        if self.console.is_some() || self.fleet.is_some() {
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
            let why = "development license: signed by a development key, not the publisher; never for production";
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
        // Ended blocks leave the file; a write that fails is retried at the next sweep (get() already ignores them).
        if let Err(e) = self.blocks.sweep(t) {
            self.logger.ops("console.blocks-write-failed", &Fields::new().with("reason", e), Level::Warn);
        }
        self.license_notices(t);
    }

    /// 3.11 (I12): the Remote Spokes license notice due now, mailed once to every active console admin.
    fn license_notices(&mut self, t: i64) {
        let Some(console) = self.console.clone() else { return };
        let due = self.licensed.as_ref().and_then(|l| license_notice(&l.license, t).map(|(stage, args)| (l.license.id.clone(), stage, args)));
        if !self.notices.due(due.as_ref().map(|(id, stage, _)| (id.clone(), *stage))) {
            return;
        }
        let Some((_, _, args)) = due else { return };
        for to in console.active_admin_emails() {
            crate::console_mail::send(LICENSE_MAIL, &to, &args);
        }
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
        // 4.8 (M9): a console block refuses the node's signed requests here, mailbox kept. Never a root-signed CRL or
        // directory: they authenticate themselves, so a blocked root holder's hub can still publish revocations.
        let self_authenticating = r.method == "POST" && matches!(r.pathname, "/v1/crl" | "/v1/directory");
        if !self_authenticating {
            if let Some(b) = self.blocks.get(&me.node, t) {
                let f = who.clone().with("until", b.until).with("placedBy", b.placed_by.as_str());
                return Ok(refuse(&logger, 403, NODE_BLOCKED, "node.blocked", &f));
            }
        }
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
                if self.mailboxes.get(&me.node).is_some_and(|m| !m.is_empty()) {
                    self.note_mail(&me.node, t);
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
                match self.take_directory(token, t, &Fields::new().with("node", &me.node))? {
                    Err(Taken { status, reason, event }) => {
                        let f = if status == 403 { who.clone().with("relays", self.relay_cap()) } else { who.clone() };
                        refuse(&logger, status, &reason, event, &f)
                    }
                    Ok(version) => json_reply(200, &json!({ "ok": true, "version": version })),
                }
            }
            ("/v1/crl", "GET") => json_reply(200, &json!({ "ok": true, "crl": self.trust.crl_token() })),
            ("/v1/crl", "POST") => {
                let parsed = body();
                let token = parsed.as_ref().and_then(as_object).filter(|b| exact_keys(b, &["crl"], &["crl"])).and_then(|b| str_of(b.get("crl")));
                let Some(token) = token else { return Ok(refuse(&logger, 400, "malformed", "crl.malformed", &who)) };
                match self.take_crl(token, t, &Fields::new().with("node", &me.node))? {
                    Err(Taken { status, reason, event }) => refuse(&logger, status, &reason, event, &who),
                    Ok(version) => json_reply(200, &json!({ "ok": true, "version": version })),
                }
            }
            // 4.10 (I6): the waiting rs.* requests, for the hubs of active console admins, never one about the asker.
            // AC-2a 5.7: on an enrolled relay whose local console is off, from the headless book, for the hubs of the
            // fleet roster's active admins.
            ("/v1/console/requests", "GET") => {
                let email = me.user.as_ref().map(|u| u.email.as_str()).filter(|_| me.role == "hub");
                let (console, admin) = match (&self.console, &self.fleet) {
                    (Some(c), _) => (c.clone(), email.is_some_and(|e| c.is_active_admin(e))),
                    (None, Some(f)) => (f.book.clone(), email.is_some_and(|e| (f.admins)().iter().any(|a| a.eq_ignore_ascii_case(e)))),
                    (None, None) => return Ok(refuse(&logger, 409, CONSOLE_OFF, "console.requests-refused", &who)),
                };
                if !admin {
                    return Ok(refuse(&logger, 403, REQUESTS_REFUSED, "console.requests-refused", &who));
                }
                let requests: Vec<Value> = console
                    .requests_waiting("rs.", t)
                    .into_iter()
                    .filter(|rq| rq.get("target").and_then(|x| str_of(x.get("node"))) != Some(me.node.as_str()))
                    .collect();
                json_reply(200, &json!({ "ok": true, "requests": requests }))
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
                let Some(console) = self.console.clone().or_else(|| self.fleet.as_ref().map(|f| f.book.clone())) else {
                    return Ok(refuse(&logger, 409, CONSOLE_OFF, "logs.console-off", &who));
                };
                if me.role != "spoke" {
                    return Ok(refuse(&logger, 403, "only a spoke sends its log lines here", "logs.refused", &who));
                }
                match console.take_logs(&me.node, r.body, t) {
                    Err(e) => refuse(&logger, e.status, &e.error, e.event, &who),
                    Ok(kept) => {
                        // 9.2 (F14): the spoke's lanes, last valid line wins; out-of-range values are ignored.
                        if let Some((busy, live, max)) = lanes_of(r.body) {
                            self.lanes.insert(me.node.clone(), Lanes { busy, live, max, at: t });
                        }
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
            // AC-2a 5.7 (F13): whether this relay runs its own console and which Lucid Admin Console manages it.
            ("/v1/console/where", "GET") => json_reply(200, &self.console_where()),
            // AC-2a 3.9 (F20): the first-roster entries of this hub's user, for its IDE plugin to endorse.
            ("/v1/console/fleet-bootstrap", "GET") => {
                let Some((dir, email)) = self.endorser(&me) else { return Ok(not_bootstrapping(&logger, &who)) };
                match crate::fleet_trust::bootstrap_view(&dir, &email, t) {
                    Ok(v) => json_reply(200, &v),
                    Err(e) => endorse_refused(&logger, &e, "fleet.bootstrap-refused", &who),
                }
            }
            ("/v1/console/fleet-endorse", "POST") => {
                let Some((dir, email)) = self.endorser(&me) else { return Ok(not_bootstrapping(&logger, &who)) };
                if !self.endorse_try(&me.serial, t) {
                    return Ok(refuse(&logger, 429, "too many endorsement attempts from this certificate; try again within the hour", "fleet.endorse-limited", &who));
                }
                let parsed = body();
                let Some(endorsement) = parsed.as_ref().and_then(as_object).filter(|b| exact_keys(b, &["endorsement"], &["endorsement"])).and_then(|b| b.get("endorsement")) else {
                    return Ok(refuse(&logger, 400, "malformed", "fleet.endorse-malformed", &who));
                };
                // The hub op's own signature (checked above, over this body) is the hub's signature on the endorsement;
                // the certificate chains to --root, is in date, not revoked (authenticate) and not blocked (above).
                let no_proof = |_: &[u8], _: &[u8]| false;
                let ctx = crate::fleet_trust::EndorseCtx {
                    state_dir: &dir,
                    product: crate::license::Product::Spokes,
                    email: &email,
                    anchor: &me.serial,
                    chain_ok: true,
                    in_date: true,
                    revoked: false,
                    blocked: false,
                    relay_admin: true,
                    verify: &no_proof,
                    proof: None,
                };
                match crate::fleet_trust::endorse(&ctx, endorsement, t) {
                    Ok(v) => json_reply(200, &v),
                    Err(e) => endorse_refused(&logger, &e, "fleet.endorse-refused", &who),
                }
            }
            _ => refuse(&logger, 404, "not found", "route.unknown", &who),
        };
        Ok(reply)
    }

    /// 5.7 `where`: `{ok, local, managedBy}`.
    pub fn console_where(&self) -> Value {
        let managed_by = self.fleet.as_ref().and_then(|f| (f.managed_by)());
        json!({ "ok": true, "local": self.console.is_some(), "managedBy": managed_by })
    }

    /// The state folder of the fleet link and the hub's user email, for the 3.9 endorsement routes: a hub with an email
    /// on an enrolled relay, else None (answered `fleet-not-bootstrapping`).
    fn endorser(&self, me: &NodeCert) -> Option<(PathBuf, String)> {
        let f = self.fleet.as_ref()?;
        let email = me.user.as_ref().map(|u| u.email.clone()).filter(|_| me.role == "hub")?;
        Some((f.state_dir.clone(), email))
    }

    /// One endorsement attempt by the certificate `serial`: false past 10 within the hour (5.7).
    fn endorse_try(&mut self, serial: &str, t: i64) -> bool {
        self.endorse_tries.retain(|_, v| {
            v.retain(|at| t - at < 3_600_000);
            !v.is_empty()
        });
        let tries = self.endorse_tries.entry(serial.to_owned()).or_default();
        if tries.len() >= ENDORSE_TRIES {
            return false;
        }
        tries.push(t);
        true
    }

    /// Install the Lucid Admin Console link (server.rs, at start, when the relay is enrolled).
    pub fn set_fleet(&mut self, link: FleetLink) {
        self.fleet = Some(link);
    }

    /// 9.2: the sums of the latest `lanes.state` lines of spokes seen within 5 minutes, or None when none reports.
    pub fn lanes_now(&self, t: i64) -> Option<(u64, u64)> {
        let fresh: Vec<&Lanes> = self.lanes.iter().filter(|(n, l)| t - l.at < ONLINE_MS && self.seen.get(*n).is_some_and(|s| t - s.at < ONLINE_MS)).map(|(_, l)| l).collect();
        (!fresh.is_empty()).then(|| fresh.iter().fold((0, 0), |(b, m), l| (b + u64::from(l.busy), m + u64::from(l.live))))
    }

    /// The control panel, when it is on.
    pub fn console(&self) -> Option<Arc<Console>> {
        self.console.clone()
    }

    /// Users (ADR-A077): distinct people on hub certificates take a seat; a refused one first frees the seats of users
    /// whose every certificate was revoked or expired.
    fn seat(&mut self, me: &NodeCert, seat: Option<&str>, t: i64, who: &Fields) -> Result<Option<Reply>, String> {
        // F2 (ADR-A100): only a hub the org root counted under THIS license (its seat, in the lucid-seat header), so one
        // license copied to many relays admits at most its users in all. This relay's own book is the second wall.
        if let Some(lic) = self.licensed.as_ref() {
            if let Some(why) = seat_problem(seat, self.trust.root_key(), &self.trust.root_id, &lic.license.id, me, t.div_euclid(1000)) {
                let f = who.clone().with("user", license_user_of(me)).with("license", &lic.license.id).with("why", why);
                self.uncounted.push(&me.node, me.user.as_ref().map(|u| u.email.as_str()), t);
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
            Admission::Taken | Admission::Held => {
                if seat == Admission::Taken {
                    let f = Fields::new().with("node", &me.node).with("label", &me.label).merge(&counts);
                    self.logger.ops("user.taken", &f, Level::Info);
                }
                // 3.8 rs.seat: the hub is admitted with a seat (live, so after any request waiting now).
                if let Some(console) = &self.console {
                    let admitted = Observed::Seat { node: &me.node, at: t };
                    console.observe_requests("rs.seat", "seat", t, &|target| observes("rs.seat", target, t - 1, &admitted, None).is_some());
                }
                Ok(None)
            }
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
        // 9.2: one mail item accepted; the sender is busy in this interval.
        crate::fleet_probe::counters().message(1);
        self.note_mail(&me.node, t);
        json_reply(200, &json!({ "ok": true }))
    }

    /// 9.2: `node` sent or received mail now (spokes only count toward `spokes_busy`).
    fn note_mail(&mut self, node: &str, t: i64) {
        if self.seen.get(node).is_some_and(|s| s.role == "spoke") || self.owner.as_deref() == Some(node) {
            crate::fleet_probe::counters().spoke_mail(node);
        }
        self.mail_at.insert(node.to_owned(), t);
    }
}

/// A spoke with no poll for this long is `silent` (4.8).
const SILENT_MS: i64 = 24 * 3_600_000;
/// A certificate ending within this many seconds is `expiring` (4.8).
const EXPIRING_SEC: i64 = 7 * 86_400;

/// The 4.8 nodes filters: role (hub or spoke), state, text, and the row limit.
#[derive(Default)]
pub struct NodeFilter {
    pub role: Option<String>,
    pub state: Option<String>,
    pub q: Option<String>,
    pub limit: usize,
}

/// A license the console was handed (4.7): the verified license, whether it is a development one, its token.
pub struct Offered {
    pub license: License,
    pub dev: bool,
    pub token: String,
}

/// The Admin Console's Remote Spokes views of the relay (4.8, 7.3, 7.4): read-only; never message contents.
/// Times in `...At` are milliseconds; `exp` and `since` are seconds.
impl State {
    /// One node's state word: revoked, blocked, expired, expiring, silent (a spoke with no poll for 24 h), or ok.
    fn node_state(&self, node: &str, s: &Seen, t: i64) -> &'static str {
        let now = t.div_euclid(1000);
        if self.trust.is_revoked(&s.serial) {
            "revoked"
        } else if self.blocks.is_blocked(node, t) {
            "blocked"
        } else if s.exp <= now {
            "expired"
        } else if s.exp - now <= EXPIRING_SEC {
            "expiring"
        } else if s.role == "spoke" && t - self.polls.get(node).copied().unwrap_or(self.started) >= SILENT_MS {
            "silent"
        } else {
            "ok"
        }
    }

    /// `GET /console/api/spokes/nodes`: emails only for `people` (admins and user managers, R4-8); viewers get none,
    /// and the text filter never reads one for them.
    pub fn spokes_nodes(&self, f: &NodeFilter, people: bool, logs: &HashMap<String, usize>, t: i64) -> Value {
        let q = f.q.as_deref().map(str::to_lowercase);
        let rows: Vec<Value> = self
            .seen
            .iter()
            .filter(|(_, s)| f.role.as_deref().is_none_or(|r| r == s.role))
            .filter_map(|(node, s)| {
                let state = self.node_state(node, s, t);
                if f.state.as_deref().is_some_and(|w| w != state) {
                    return None;
                }
                let (label, email) = self.labels.get(node).cloned().unwrap_or_default();
                let email = email.filter(|_| people);
                if let Some(q) = &q {
                    let hit = [Some(node.as_str()), Some(label.as_str()), Some(s.serial.as_str()), email.as_deref()].into_iter().flatten().any(|x| x.to_lowercase().contains(q.as_str()));
                    if !hit {
                        return None;
                    }
                }
                Some(json!({
                    "node": node, "role": s.role, "label": label, "email": email, "serial": s.serial, "exp": s.exp,
                    "lastSeenAt": s.at, "lastPollAt": self.polls.get(node), "revoked": self.trust.is_revoked(&s.serial),
                    "blocked": self.blocks.get(node, t).map(Block::view), "logs": logs.get(node).copied().unwrap_or(0), "state": state,
                }))
            })
            .collect();
        let total = rows.len();
        let nodes: Vec<Value> = rows.into_iter().take(f.limit).collect();
        json!({ "ok": true, "nodes": nodes, "total": total })
    }

    /// `GET /console/api/spokes/seats` (user managers and admins): the license's users, and hubs refused for want of a seat in 7 days.
    pub fn spokes_seats(&self, t: i64) -> Value {
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
        let uncounted: Vec<Value> = self.uncounted.recent(t).into_iter().map(|u| json!({ "node": u.node, "email": u.email, "at": u.at })).collect();
        let (users, used) = self.licensed.as_ref().map_or((0, 0), |l| (l.license.users, l.users.used()));
        json!({ "ok": true, "users": users, "used": used, "seats": seats, "uncounted": uncounted })
    }

    /// `GET /console/api/spokes/relays`: the held directory and CRL.
    pub fn spokes_relays(&self) -> Value {
        json!({
            "ok": true,
            "directory": { "version": self.directory.version(), "relays": self.directory.urls() },
            "crl": { "version": self.trust.crl_version(), "nextUpdate": self.crl_next_update() },
        })
    }

    /// The node as last seen: its role and its certificate's user email (hubs), or None when never seen here.
    pub fn node_seen(&self, node: &str) -> Option<(String, Option<String>)> {
        let s = self.seen.get(node)?;
        Some((s.role.clone(), self.labels.get(node).and_then(|(_, e)| e.clone())))
    }

    /// The serial of the certificate the node last signed in with.
    pub fn node_serial(&self, node: &str) -> Option<String> {
        self.seen.get(node).map(|s| s.serial.clone())
    }

    pub fn is_revoked(&self, serial: &str) -> bool {
        self.trust.is_revoked(serial)
    }

    /// Whether `block` would run on one admin's word (M9); `admin_hub` is the console's judgment of the target.
    pub fn block_decision(&self, node: &str, hours: i64, admin_hub: bool, t: i64) -> crate::console_spokes::BlockDecision {
        self.blocks.decide(node, hours, admin_hub, t)
    }

    pub fn place_block(&mut self, node: &str, hours: i64, reason: &str, by: &str, path: BlockPath, t: i64) -> Result<Block, crate::console_spokes::BlockError> {
        let placed = self.blocks.place(node, hours, reason, by, path, t)?;
        let f = Fields::new().with("node", node).with("until", placed.until).with("placedBy", by).with("path", path.as_str());
        self.logger.security("node.block", &f, Level::Warn);
        Ok(placed)
    }

    pub fn may_lift_alone(&self, node: &str, by: &str, t: i64) -> Option<bool> {
        self.blocks.may_lift_alone(node, by, t)
    }

    pub fn lift_block(&mut self, node: &str, by: &str, t: i64) -> Result<Block, crate::console_spokes::BlockError> {
        let gone = self.blocks.lift(node, t)?;
        self.logger.security("node.unblock", &Fields::new().with("node", node).with("by", by).with("placedBy", gone.placed_by.as_str()), Level::Info);
        Ok(gone)
    }

    /// Health facts of the overview: version, up for, FIPS mode (a `fips` build runs only in FIPS mode).
    pub fn relay_info(&self, t: i64) -> Value {
        json!({ "host": Value::Null, "version": env!("CARGO_PKG_VERSION"), "uptimeSeconds": (t - self.started).max(0) / 1000, "fips": cfg!(feature = "fips"), "tlsNotAfter": Value::Null })
    }

    /// The 4.7 license object, or None when the relay holds no license.
    pub fn license_view(&self, t: i64) -> Option<(Value, LicenseStateName)> {
        let lic = self.licensed.as_ref()?;
        let l = &lic.license;
        let (state, days_left) = license_state(l, t.div_euclid(1000));
        let view = json!({
            "id": l.id, "org": l.org, "product": l.product().as_str(), "edition": l.edition, "users": l.users, "used": lic.users.used(),
            "relays": l.relays, "exp": l.exp, "state": state.as_str(), "daysLeft": days_left, "dev": lic.dev, "graceDays": l.grace_days,
        });
        Some((view, state))
    }

    /// The 7.3 cards of this product: hubs, spokes (`m` silent), seats (`m` users), relays and revocation.
    pub fn spokes_cards(&self, t: i64) -> Vec<Value> {
        let (mut hubs, mut spokes, mut silent, mut hubs_warn) = (0, 0, 0, 0);
        for (node, s) in &self.seen {
            let state = self.node_state(node, s, t);
            if s.role == "hub" {
                hubs += 1;
                hubs_warn += usize::from(state != "ok");
            } else {
                spokes += 1;
                silent += usize::from(state == "silent");
            }
        }
        let warn = |bad: bool| if bad { "warn" } else { "ok" };
        let (users, used) = self.licensed.as_ref().map_or((0, 0), |l| (l.license.users, l.users.used()));
        let crl_age_days = self.crl_issued().map(|iat| (t.div_euclid(1000) - iat).max(0) / 86_400);
        vec![
            json!({ "id": "hubs", "state": warn(hubs_warn > 0), "n": hubs, "m": hubs_warn }),
            json!({ "id": "spokes", "state": warn(silent > 0), "n": spokes, "m": silent }),
            json!({ "id": "seats", "state": warn(users > 0 && used * 10 >= users * 9), "n": used, "m": users }),
            json!({ "id": "relays", "state": warn(self.crl_stale(t)), "n": self.trust.crl_version(), "m": crl_age_days }),
        ]
    }

    /// AC-2a 4.11 `GET /console/api/spokes/counts` (fleet proxy, `read-health`): integers only, built field by field
    /// from the projection allowlist; no id, label, name, serial, time, reason or actor.
    pub fn spokes_counts(&self, t: i64) -> Value {
        #[derive(Default)]
        struct Tally {
            total: u64,
            online: u64,
            silent: u64,
            busy: u64,
            expiring: u64,
            expired: u64,
            revoked: u64,
            blocked: u64,
        }
        let (mut hubs, mut spokes) = (Tally::default(), Tally::default());
        for (node, s) in &self.seen {
            let spoke = s.role != "hub";
            let n = if spoke { &mut spokes } else { &mut hubs };
            n.total += 1;
            let last = if spoke { self.polls.get(node).copied() } else { Some(s.at) };
            n.online += u64::from(last.is_some_and(|at| t - at < ONLINE_MS));
            n.busy += u64::from(self.mail_at.get(node).is_some_and(|at| t - at < BUSY_MS));
            match self.node_state(node, s, t) {
                "silent" => n.silent += 1,
                "expiring" => n.expiring += 1,
                "expired" => n.expired += 1,
                "revoked" => n.revoked += 1,
                "blocked" => n.blocked += 1,
                _ => {}
            }
        }
        let lanes = self.lanes_now(t).map(|(busy, total)| json!({ "busy": busy, "total": total }));
        json!({
            "ok": true,
            "hubs": { "total": hubs.total, "online": hubs.online, "silent": hubs.silent, "expiring": hubs.expiring, "expired": hubs.expired, "revoked": hubs.revoked, "blocked": hubs.blocked },
            "spokes": { "total": spokes.total, "online": spokes.online, "silent": spokes.silent, "busy": spokes.busy, "expiring": spokes.expiring, "expired": spokes.expired, "revoked": spokes.revoked, "blocked": spokes.blocked },
            "lanes": lanes,
        })
    }

    /// AC-2a 9.1: the Remote Spokes product values of the metrics snapshot (fleet_probe merges the OS readings and
    /// the interval counters). A key this relay cannot measure is null.
    pub fn fleet_metrics(&self, t: i64) -> Map<String, Value> {
        let online = |at: i64| t - at < ONLINE_MS;
        let mut people = HashSet::new();
        let (mut hubs_online, mut spokes_online, mut spokes_total) = (0u64, 0u64, 0u64);
        for (node, s) in &self.seen {
            if s.role == "hub" {
                if online(s.at) {
                    hubs_online += 1;
                    if let Some(e) = self.labels.get(node).and_then(|(_, e)| e.as_deref()) {
                        people.insert(e.to_ascii_lowercase());
                    }
                }
            } else {
                spokes_online += u64::from(self.polls.get(node).is_some_and(|at| online(*at)));
                spokes_total += u64::from(t - s.at < SPOKES_TOTAL_MS);
            }
        }
        let lanes = self.lanes_now(t);
        let lic = self.licensed.as_ref().map(|l| (license_state(&l.license, t.div_euclid(1000)), l.license.users, l.users.used(), l.license.product()));
        let license_state_code = match &lic {
            None => 0,
            Some((_, _, _, p)) if *p != crate::license::Product::Spokes => 4,
            Some(((LicenseStateName::Valid, _), _, _, _)) => 1,
            Some(((LicenseStateName::Grace, _), _, _, _)) => 2,
            Some(_) => 3,
        };
        let crl_days = self.crl_next_update().map(|n| (n - t.div_euclid(1000)).div_euclid(86_400));
        let mut m = Map::new();
        m.insert("people_online".into(), json!(people.len()));
        m.insert("hubs_online".into(), json!(hubs_online));
        m.insert("spokes_online".into(), json!(spokes_online));
        m.insert("spokes_total".into(), json!(spokes_total));
        m.insert("lanes_busy".into(), json!(lanes.map(|l| l.0)));
        m.insert("lanes_total".into(), json!(lanes.map(|l| l.1)));
        m.insert("seats_used".into(), json!(lic.as_ref().map(|l| l.2)));
        m.insert("seats_total".into(), json!(lic.as_ref().map(|l| l.1)));
        m.insert("license_days".into(), json!(lic.as_ref().map(|l| l.0 .1)));
        m.insert("license_state".into(), json!(license_state_code));
        m.insert("crl_days".into(), json!(crl_days));
        m
    }

    /// The held CRL's `iat` (seconds), read from its verified token.
    fn crl_issued(&self) -> Option<i64> {
        safe_int(crate::identity::peek_compact(self.trust.crl_token()?)?.get("iat"))
    }

    /// Past the held CRL's nextUpdate.
    fn crl_stale(&self, t: i64) -> bool {
        self.crl_next_update().is_some_and(|n| n <= t.div_euclid(1000))
    }

    /// The 7.3 attention items of this product; viewers get only `crl-stale` and `spokes-silent`.
    pub fn spokes_attention(&self, admin: bool, t: i64) -> Vec<Value> {
        let mut out = Vec::new();
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({ "kind": kind, "severity": severity, "args": args, "go": go });
        if self.crl_stale(t) {
            out.push(item("crl-stale", "bad", json!({}), "#/spokes/relays"));
        }
        let silent = self.seen.iter().filter(|(n, s)| self.node_state(n, s, t) == "silent").count();
        if silent > 0 {
            out.push(item("spokes-silent", "warn", json!({ "n": silent }), "#/spokes/spokes"));
        }
        if !admin {
            return out;
        }
        if let Some(l) = self.licensed.as_ref().filter(|l| l.license.users > 0 && l.users.used() * 10 >= l.license.users * 9) {
            out.push(item("seats-high", "warn", json!({ "used": l.users.used(), "users": l.license.users }), "#/spokes/seats"));
        }
        let uncounted = self.uncounted.recent(t).len();
        if uncounted > 0 {
            out.push(item("uncounted", "warn", json!({ "n": uncounted }), "#/spokes/seats"));
        }
        let expiring = self.seen.iter().filter(|(n, s)| self.node_state(n, s, t) == "expiring").count();
        if expiring > 0 {
            out.push(item("cert-expiring", "warn", json!({ "n": expiring }), "#/spokes/hubs"));
        }
        let blocks = self.blocks.active(t).count();
        if blocks > 0 {
            out.push(item("blocks-active", "info", json!({ "n": blocks }), "#/spokes/hubs"));
        }
        out
    }

    /// 4.2 search hits among hubs and spokes (admins only: nodes carry people's emails).
    pub fn spokes_search(&self, q: &str, limit: usize) -> Vec<Value> {
        let q = q.to_lowercase();
        self.seen
            .iter()
            .filter_map(|(node, s)| {
                let (label, email) = self.labels.get(node).cloned().unwrap_or_default();
                let hit = [Some(node.as_str()), Some(label.as_str()), Some(s.serial.as_str()), email.as_deref()].into_iter().flatten().any(|x| x.to_lowercase().contains(&q));
                let page = if s.role == "hub" { "hubs" } else { "spokes" };
                hit.then(|| json!({ "kind": s.role, "id": node, "title": label, "detail": email.unwrap_or_default(), "go": format!("#/spokes/{page}?q={node}") }))
            })
            .take(limit)
            .collect()
    }

    /// A license handed to the console (4.7), verified exactly as at start; Err is the verifier's words.
    pub fn license_offered(&self, text: &str, t: i64) -> Result<Offered, String> {
        let token = crate::license::license_token_of(text);
        let keys = license_keys(|k| std::env::var(k).ok())?;
        let c = verify_license(&token, &self.trust.root_id, &keys, t.div_euclid(1000))?;
        if c.license.product() != crate::license::Product::Spokes {
            return Err("this license is for Meeting Hub, not Remote Spokes".into());
        }
        Ok(Offered { license: c.license, dev: c.dev, token })
    }

    /// The license in force now, for the 4.7 one-admin test.
    pub fn license_now(&self) -> Option<&License> {
        self.licensed.as_ref().map(|l| &l.license)
    }

    /// Where an installed license goes (4.7): the file --license named when it is inside --state; Err names where
    /// the relay reads its license from instead (a file outside --state, or LUCID_RELAY_LICENSE text).
    pub fn license_target(&self) -> Result<PathBuf, String> {
        let Some(dir) = &self.state_dir else { return Err("LUCID_RELAY_LICENSE".into()) };
        match &self.license_file {
            Some(f) if f.parent().is_some_and(|p| same_dir(p, dir)) => Ok(f.clone()),
            Some(f) => Err(f.display().to_string()),
            None => Err("LUCID_RELAY_LICENSE".into()),
        }
    }

    /// Install a verified license: written where 4.7 says, then in force at once. People admitted first stay.
    pub fn install_license(&mut self, offered: Offered, t: i64) -> Result<(), String> {
        let file = self.license_target()?;
        write_private(&file, format!("{}\n", offered.token).as_bytes()).map_err(|e| e.to_string())?;
        let users = match self.licensed.take() {
            Some(old) => old.users,
            None => LicenseUsers::open(self.state_dir.as_ref().map(|d| d.join(LICENSE_USERS_FILE)).as_deref())?,
        };
        let f = Fields::new().with("id", &offered.license.id).with("exp", offered.license.exp).with("file", file.display().to_string());
        self.licensed = Some(Licensed { token: offered.token, license: offered.license, dev: offered.dev, users });
        self.logger.security("license.installed", &f, Level::Info);
        self.license_seen = None;
        self.check_license(t)
    }
}

/// Whether two folder paths name the same folder (canonical when both resolve).
fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
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

/// AC-2a 16.1 f-relay (A2-H1): `answer` of `GET <path>` has exactly the field set and types the projection vector
/// lists for it (`tests/admin_console_fleet_projection_v1.json`), compared field by field. Err names the first miss.
#[cfg(test)]
pub(crate) fn projection_matches(path: &str, answer: &Value) -> Result<(), String> {
    let file = format!("{}/tests/admin_console_fleet_projection_v1.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{file}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
    let v = parse_json(&text).ok_or("the projection vector does not parse")?;
    let route = format!("GET {path}");
    let fields = v["routes"].as_array().and_then(|r| r.iter().find(|x| x["route"] == route.as_str())).and_then(|x| x["fields"].as_array()).ok_or(format!("{route} is not in the vector"))?;
    let at = |p: &str| p.split('.').try_fold(answer, |cur, k| cur.get(k));
    let mut listed = HashSet::new();
    for f in fields {
        let p = str_of(f.get("path")).ok_or("a field without path")?;
        listed.insert(p.to_owned());
        let ty = str_of(f.get("type")).unwrap_or("");
        let nullable = f.get("nullable") == Some(&Value::Bool(true));
        let parent_null = p.rsplit_once('.').is_some_and(|(parent, _)| at(parent).is_some_and(Value::is_null));
        if parent_null {
            continue;
        }
        let x = at(p).ok_or(format!("{p} is missing"))?;
        let ok = match ty {
            _ if x.is_null() => nullable,
            "count" => x.is_u64(),
            "days" => x.is_i64() || x.is_u64(),
            "bool" => x.is_boolean(),
            "object" => x.is_object(),
            _ => true,
        };
        if !ok {
            return Err(format!("{p} is not a {ty}: {x}"));
        }
    }
    fn walk(v: &Value, prefix: &str, out: &mut Vec<String>) {
        if let Some(o) = v.as_object() {
            for (k, x) in o {
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                out.push(p.clone());
                walk(x, &p, out);
            }
        }
    }
    let mut seen = Vec::new();
    walk(answer, "", &mut seen);
    // A grouping object the vector does not list itself (`hubs` of `hubs.total`) is allowed when it holds listed fields;
    // its own children are still checked one by one.
    let grouping = |p: &str| listed.iter().any(|l| l.strip_prefix(p).is_some_and(|rest| rest.starts_with('.')));
    match seen.into_iter().find(|p| !listed.contains(p) && !(at(p).is_some_and(Value::is_object) && grouping(p))) {
        Some(extra) => Err(format!("{extra} is not in the allowlist")),
        None => Ok(()),
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
            state_dir: None,
            license_file: None,
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

    /// A signed request by `key` and `cert` to relay.example.com: the reply.
    #[allow(clippy::too_many_arguments)]
    fn call(st: &mut State, key: &SigningKey, cert: &str, method: &str, path: &str, body: &str, t: i64, nonce: u32) -> Reply {
        let nonce = format!("{nonce:032x}");
        let line = format!("lucid-relay-auth/v2\nrelay:relay.example.com\n{method}\n{path}\n{}\n{nonce}\n{}", js_number_string(t as f64), sha256_hex(body.as_bytes()));
        let sig: Signature = key.sign(line.as_bytes());
        let a = json!({ "cert": cert, "ts": t, "nonce": nonce, "sig": b64u(sig.to_der().as_bytes()) });
        let authorization = format!("LucidNode {}", b64u(stringify(&a).as_bytes()));
        let d = Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 443 };
        let where_ = Fields::new();
        let r = Request { method, pathname: path, path, authorization: &authorization, seat: None, dialed: &d, body, where_: &where_ };
        st.serve(&r, t, true).unwrap()
    }

    fn root_id(root: &SigningKey) -> String {
        node_id_of(&p256_spki_der(&root.verifying_key().into()))
    }

    fn crl(root: &SigningKey, version: i64, serials: &[String], next_update: Option<i64>) -> String {
        let mut p = json!({ "v": 1, "typ": "lucid-crl", "root": root_id(root), "version": version, "serials": serials, "iat": T0 / 1000 - 60 });
        if let Some(n) = next_update {
            p["nextUpdate"] = json!(n);
        }
        compact(root, &p)
    }

    fn directory(root: &SigningKey, version: i64) -> String {
        let now = T0 / 1000;
        let p = json!({
            "v": 1, "typ": "lucid-relay-directory", "root": root_id(root), "version": version,
            "relays": [{ "url": "https://relay.example.com", "region": "eu", "priority": 1 }], "iat": now - 60, "exp": now + 86_400,
        });
        compact(root, &p)
    }

    /// A state whose security lines land in `lines`.
    fn state_logged(root: &SigningKey) -> (State, Arc<parking_lot::Mutex<Vec<String>>>) {
        let lines = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = lines.clone();
        let opts = Options {
            root: root.verifying_key().into(),
            owner: None,
            license: None,
            crl_file: None,
            store: None,
            seen_file: None,
            directory_file: None,
            users_file: None,
            store_bytes: STORE_BYTES,
            sender_bytes: SENDER_BYTES,
            console: None,
            state_dir: None,
            license_file: None,
        };
        let logger = Logger::capture("relay", Box::new(move |line: &str, _| sink.lock().push(line.to_owned())));
        (State::new(opts, Arc::new(logger)).unwrap(), lines)
    }

    /// A hub's key, root-signed certificate (naming `email` as its user) and id.
    fn hub_of(root: &SigningKey, seed: u8, email: &str) -> (SigningKey, String, String) {
        let key = SigningKey::from_slice(&[seed; 32]).unwrap();
        let spki = p256_spki_der(&key.verifying_key().into());
        let id = node_id_of(&spki);
        let now = T0 / 1000;
        let p = json!({
            "v": 1, "typ": "lucid-node-cert", "serial": format!("{seed:032x}"), "root": root_id(root),
            "node": id, "role": "hub", "label": format!("hub {seed}"), "spki": b64u(&spki), "scopes": [], "iat": now - 60, "exp": now + 86_400,
            "user": { "id": crate::identity::user_id_of(email), "email": email },
        });
        (key, compact(root, &p), id)
    }

    fn envelope(from: &str, to: &str, id: u32) -> String {
        stringify(&json!({ "v": 1, "from": from, "to": to, "id": format!("{id:032x}"), "ts": T0, "cert": "a.b", "epk": "AA", "iv": "AA", "ct": "AA", "sig": "AA" }))
    }

    fn fleet_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-relay-fleet-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// AC-2a 16.1 f-relay: `/v1/send` moves the `messages` counter and marks the sending spoke busy; a refused send
    /// moves nothing.
    #[test]
    fn ac2a_send_moves_the_messages_counter_and_the_spoke_is_busy() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        let (spoke_key, spoke_cert, spoke) = node(&root, 2, "spoke");
        let (hub_key, hub_cert, hub) = node(&root, 3, "hub");
        assert_eq!(inbox(&mut st, &hub_key, &hub_cert, "relay:relay.example.com", T0, 1), 200);
        assert_eq!(inbox(&mut st, &spoke_key, &spoke_cert, "relay:relay.example.com", T0, 2), 200);
        let counters = crate::fleet_probe::counters();
        let before = counters.messages_total();
        // to itself: refused, nothing counted by this request
        let r = call(&mut st, &spoke_key, &spoke_cert, "POST", "/v1/send", &envelope(&spoke, &spoke, 1), T0 + 1, 3);
        assert_eq!(r.status, 403);
        let r = call(&mut st, &spoke_key, &spoke_cert, "POST", "/v1/send", &envelope(&spoke, &hub, 2), T0 + 2, 4);
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(counters.messages_total() > before);
        assert!(counters.spoke_mail_seen(&spoke));
        let counts = st.spokes_counts(T0 + 3);
        assert_eq!(counts["spokes"]["busy"], json!(1));
        assert_eq!(counts["hubs"]["busy"], Value::Null, "hubs carry no busy count");
        assert_eq!(st.fleet_metrics(T0 + 3)["spokes_online"], json!(1));
    }

    /// AC-2a 16.1 f-relay: `lanes.state` lines are kept per spoke; out-of-range or non-integer values are ignored.
    #[test]
    fn ac2a_lanes_state_lines_with_out_of_range_values_are_ignored() {
        let line = |busy: Value, live: Value, max: Value| stringify(&json!({ "lines": [{ "cat": "ops", "level": "info", "event": "lanes.state", "busy": busy, "live": live, "max": max }] }));
        assert_eq!(lanes_of(&line(json!(1), json!(2), json!(4))), Some((1, 2, 4)));
        assert_eq!(lanes_of(&line(json!(0), json!(0), json!(8))), Some((0, 0, 8)));
        for bad in [line(json!(9), json!(2), json!(4)), line(json!(1), json!(-1), json!(4)), line(json!(1), json!(2), json!(4.5)), line(json!("1"), json!(2), json!(4)), line(json!(1), json!(2), Value::Null)] {
            assert_eq!(lanes_of(&bad), None, "{bad}");
        }
        // another event or category is no lanes report
        assert_eq!(lanes_of(r#"{"lines":[{"cat":"security","level":"info","event":"lanes.state","busy":1,"live":1,"max":1}]}"#), None);
        // through the route: kept per node and summed while fresh
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let dir = fleet_dir("lanes");
        let mut st = state(&root, None, None).unwrap();
        let book = crate::console::open_headless(crate::license::Product::Spokes, &dir, Arc::new(Logger::capture("relay", Box::new(|_, _| {})))).unwrap();
        st.set_fleet(FleetLink { managed_by: Box::new(|| Some("https://console.example.com".into())), book, admins: Box::new(Vec::new), state_dir: dir.clone() });
        let (spoke_key, spoke_cert, _) = node(&root, 2, "spoke");
        assert_eq!(st.lanes_now(T0), None, "no spoke reports: null");
        let r = call(&mut st, &spoke_key, &spoke_cert, "POST", "/v1/logs", &line(json!(2), json!(3), json!(4)), T0, 1);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(st.lanes_now(T0 + 1), Some((2, 3)), "busy and live lanes");
        let r = call(&mut st, &spoke_key, &spoke_cert, "POST", "/v1/logs", &line(json!(20), json!(3), json!(4)), T0 + 2, 2);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(st.lanes_now(T0 + 3), Some((2, 3)), "an out-of-range line changes nothing");
        assert_eq!(st.spokes_counts(T0 + 3)["lanes"], json!({ "busy": 2, "total": 3 }));
        assert_eq!(st.lanes_now(T0 + ONLINE_MS + 10), None, "older than 5 minutes: not counted");
    }

    /// AC-2a 16.1 f-relay: `GET /v1/console/where` on a relay with neither console, its own console, and enrolled.
    #[test]
    fn ac2a_where_answers_neither_local_and_enrolled() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mut st = state(&root, None, None).unwrap();
        let (hub_key, hub_cert, _) = hub_of(&root, 3, "alice@acme.example");
        let r = call(&mut st, &hub_key, &hub_cert, "GET", "/v1/console/where", "", T0, 1);
        assert_eq!((r.status, parse_json(&r.body).unwrap()), (200, json!({ "ok": true, "local": false, "managedBy": null })));
        let dir = fleet_dir("where");
        let book = crate::console::open_headless(crate::license::Product::Spokes, &dir, Arc::new(Logger::capture("relay", Box::new(|_, _| {})))).unwrap();
        st.set_fleet(FleetLink { managed_by: Box::new(|| Some("https://console.example.com".into())), book: book.clone(), admins: Box::new(Vec::new), state_dir: dir.clone() });
        let r = call(&mut st, &hub_key, &hub_cert, "GET", "/v1/console/where", "", T0 + 1, 2);
        assert_eq!(parse_json(&r.body).unwrap(), json!({ "ok": true, "local": false, "managedBy": "https://console.example.com" }));
        // its own console on (the console field), not managed
        st.fleet = None;
        st.console = Some(book);
        let r = call(&mut st, &hub_key, &hub_cert, "GET", "/v1/console/where", "", T0 + 2, 3);
        assert_eq!(parse_json(&r.body).unwrap(), json!({ "ok": true, "local": true, "managedBy": null }));
    }

    /// AC-2a 16.1 f-relay: with the local console off, an enrolled relay serves `/v1/console/requests` from the
    /// headless book to the hubs of the roster's active admins, and the endorsement routes answer
    /// `fleet-not-bootstrapping` on a relay that is not enrolled.
    #[test]
    fn ac2a_requests_are_readable_from_the_headless_book_by_an_admins_hub() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mut st = state(&root, None, None).unwrap();
        let (alice_key, alice_cert, _) = hub_of(&root, 3, "alice@acme.example");
        let (bob_key, bob_cert, _) = hub_of(&root, 4, "bob@acme.example");
        let r = call(&mut st, &alice_key, &alice_cert, "GET", "/v1/console/fleet-bootstrap", "", T0, 1);
        assert_eq!(r.status, 409);
        assert_eq!(parse_json(&r.body).unwrap()["code"], json!(NOT_BOOTSTRAPPING));
        assert_eq!(parse_json(&r.body).unwrap()["error"], json!(NOT_BOOTSTRAPPING_WORDS));
        let dir = fleet_dir("requests");
        let book = crate::console::open_headless(crate::license::Product::Spokes, &dir, Arc::new(Logger::capture("relay", Box::new(|_, _| {})))).unwrap();
        let request = book.new_request("carol@acme.example", "rs.revoke", json!({ "node": "n_0123456789abcdef0123456789abcdef" }), "Stolen", T0).unwrap();
        st.set_fleet(FleetLink { managed_by: Box::new(|| Some("https://console.example.com".into())), book, admins: Box::new(|| vec!["alice@acme.example".to_owned()]), state_dir: dir });
        let r = call(&mut st, &alice_key, &alice_cert, "GET", "/v1/console/requests", "", T0 + 1, 2);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(parse_json(&r.body).unwrap()["requests"][0]["id"], request["id"]);
        // not a roster admin: refused
        let r = call(&mut st, &bob_key, &bob_cert, "GET", "/v1/console/requests", "", T0 + 2, 3);
        assert_eq!(r.status, 403);
    }

    /// AC-2a 16.1 f-relay (A2-H1): `spokes/counts` holds exactly the allowlisted fields, every value a non-negative
    /// integer (or `lanes` null), for an empty relay and a busy one.
    #[test]
    fn ac2a_spokes_counts_are_integers_only() {
        let ints = |v: &Value| v.as_object().unwrap().iter().filter(|(k, _)| *k != "ok").all(|(_, x)| x.is_null() || x.is_u64() || x.as_object().is_some_and(|o| o.values().all(Value::is_u64)));
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let mut st = state(&root, None, None).unwrap();
        let empty = st.spokes_counts(T0);
        assert!(ints(&empty) && empty["lanes"].is_null());
        let (spoke_key, spoke_cert, _) = node(&root, 2, "spoke");
        let (hub_key, hub_cert, _) = hub_of(&root, 3, "alice@acme.example");
        assert_eq!(inbox(&mut st, &spoke_key, &spoke_cert, "relay:relay.example.com", T0, 1), 200);
        assert_eq!(inbox(&mut st, &hub_key, &hub_cert, "relay:relay.example.com", T0, 2), 200);
        st.lanes.insert(node_id_of(&p256_spki_der(&spoke_key.verifying_key().into())), Lanes { busy: 1, live: 2, max: 2, at: T0 });
        let busy = st.spokes_counts(T0 + 1);
        assert!(ints(&busy) && busy["lanes"].is_object());
        // exactly the vector's fields and types, read from the vector, for the empty and the busy relay
        projection_matches("spokes/counts", &empty).unwrap();
        projection_matches("spokes/counts", &busy).unwrap();
        assert_eq!((busy["hubs"]["total"].as_u64(), busy["spokes"]["online"].as_u64()), (Some(1), Some(1)));
        // no id, label, email, serial or time anywhere
        let text = stringify(&busy);
        assert!(!text.contains("n_") && !text.contains("acme") && !text.contains("hub 3"));
    }

    #[test]
    fn a_blocked_node_is_refused_but_still_publishes_a_crl_and_a_directory() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, lines) = state_logged(&root);
        let (spoke_key, spoke_cert, spoke) = node(&root, 2, "spoke");
        let (hub_key, hub_cert, hub) = node(&root, 3, "hub");
        assert_eq!(call(&mut st, &spoke_key, &spoke_cert, "GET", "/v1/inbox", "", T0, 1).status, 200);
        st.place_block(&spoke, 2, "lost laptop", "alice@acme.example", BlockPath::Single, T0).unwrap();
        st.place_block(&hub, 2, "check", "alice@acme.example", BlockPath::Single, T0).unwrap();
        let r = call(&mut st, &spoke_key, &spoke_cert, "GET", "/v1/inbox", "", T0 + 1, 2);
        assert_eq!(r.status, 403);
        assert!(r.body.contains(NODE_BLOCKED), "{}", r.body);
        assert!(lines.lock().iter().any(|l| l.contains("\"node.blocked\"") && l.contains(&spoke)), "a security line names the node");
        // The mailbox stays: mail for the blocked spoke is still taken from others.
        assert!(st.recipient_problem(&spoke, T0 + 2).is_none());
        // The blocked hub still hands the relay a root-signed CRL and directory.
        let body = stringify(&json!({ "crl": crl(&root, 1, &[], None) }));
        let r = call(&mut st, &hub_key, &hub_cert, "POST", "/v1/crl", &body, T0 + 3, 3);
        assert_eq!((r.status, r.body.contains("\"version\":1")), (200, true), "{}", r.body);
        let body = stringify(&json!({ "directory": directory(&root, 1) }));
        let r = call(&mut st, &hub_key, &hub_cert, "POST", "/v1/directory", &body, T0 + 4, 4);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(call(&mut st, &hub_key, &hub_cert, "GET", "/v1/inbox", "", T0 + 5, 5).status, 403);
        // At until the block ends by itself.
        assert_eq!(call(&mut st, &spoke_key, &spoke_cert, "GET", "/v1/inbox", "", T0 + 2 * 3_600_000, 6).status, 200);
    }

    #[test]
    fn console_uploads_are_taken_and_refused_as_the_v1_routes() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        let (hub_key, hub_cert, _) = node(&root, 3, "hub");
        let by = Fields::new().with("console", "alice@acme.example");
        let foreign = crl(&other, 5, &[], None);
        let Err(Taken { status, reason, .. }) = st.take_crl(&foreign, T0, &by).unwrap() else { panic!("a foreign CRL is refused") };
        let r = call(&mut st, &hub_key, &hub_cert, "POST", "/v1/crl", &stringify(&json!({ "crl": foreign })), T0, 1);
        assert_eq!((r.status, r.body.contains(&reason)), (status, true));
        assert_eq!(st.take_crl(&crl(&root, 2, &[], Some(T0 / 1000 + 600)), T0, &by).unwrap().unwrap(), 2);
        let older = crl(&root, 1, &[], None);
        let Err(Taken { reason, .. }) = st.take_crl(&older, T0, &by).unwrap() else { panic!("an older CRL is refused") };
        assert_eq!(reason, "CRL version 1 is older than 2");
        let Err(Taken { reason, .. }) = st.take_directory(&directory(&other, 1), T0, &by).unwrap() else { panic!("a foreign directory is refused") };
        assert_eq!(reason, "relay directory is not signed by this root");
        assert_eq!(st.take_directory(&directory(&root, 3), T0, &by).unwrap().unwrap(), 3);
        let relays = st.spokes_relays();
        assert_eq!((relays["crl"]["version"].as_i64(), relays["crl"]["nextUpdate"].as_i64()), (Some(2), Some(T0 / 1000 + 600)));
        assert_eq!(relays["directory"]["version"].as_i64(), Some(3));
        // Past nextUpdate the overview says the list is stale.
        assert!(st.spokes_attention(false, T0 + 601_000).iter().any(|a| a["kind"] == "crl-stale"));
    }

    #[test]
    fn nodes_view_filters_and_viewers_get_no_email() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        let (spoke_key, spoke_cert, spoke) = node(&root, 2, "spoke");
        let (hub_key, hub_cert, hub) = node(&root, 3, "hub");
        assert_eq!(call(&mut st, &spoke_key, &spoke_cert, "GET", "/v1/inbox", "", T0, 1).status, 200);
        assert_eq!(call(&mut st, &hub_key, &hub_cert, "GET", "/v1/inbox", "", T0, 2).status, 200);
        st.labels.insert(hub.clone(), ("hub 3".into(), Some("bob@acme.example".into())));
        let logs: HashMap<String, usize> = [(spoke.clone(), 4usize)].into_iter().collect();
        fn all(st: &State, logs: &HashMap<String, usize>, f: NodeFilter, admin: bool) -> Value {
            let limit = if f.limit == 0 { 100 } else { f.limit };
            st.spokes_nodes(&NodeFilter { limit, ..f }, admin, logs, T0 + 10)
        }
        let none = NodeFilter::default;
        let v = all(&st, &logs, none(), true);
        assert_eq!(v["total"], 2);
        let row = |v: &Value, n: &str| v["nodes"].as_array().unwrap().iter().find(|x| x["node"] == n).cloned().unwrap();
        assert_eq!(row(&v, &hub)["email"], "bob@acme.example");
        assert_eq!(row(&v, &spoke)["logs"], 4);
        // The test certificates last a day: within 7 days of their end.
        assert_eq!(row(&v, &spoke)["state"], "expiring");
        // Viewers: no email, and the text filter never matches one.
        let v = all(&st, &logs, none(), false);
        assert!(v["nodes"].as_array().unwrap().iter().all(|x| x["email"].is_null()));
        assert_eq!(all(&st, &logs, NodeFilter { q: Some("bob@".into()), ..none() }, false)["total"], 0);
        assert_eq!(all(&st, &logs, NodeFilter { q: Some("bob@".into()), ..none() }, true)["total"], 1);
        assert_eq!(all(&st, &logs, NodeFilter { role: Some("spoke".into()), ..none() }, true)["total"], 1);
        assert_eq!(all(&st, &logs, NodeFilter { state: Some("ok".into()), ..none() }, true)["total"], 0);
        assert_eq!(all(&st, &logs, NodeFilter { limit: 1, ..none() }, true)["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(all(&st, &logs, NodeFilter { limit: 1, ..none() }, true)["total"], 2);
        // A block shows on the row and in the state filter.
        st.place_block(&spoke, 1, "r", "alice@acme.example", BlockPath::Single, T0).unwrap();
        let v = all(&st, &logs, NodeFilter { state: Some("blocked".into()), ..none() }, true);
        assert_eq!(v["total"], 1);
        assert_eq!(row(&v, &spoke)["blocked"]["by"], "alice@acme.example");
        // Revoked wins over everything.
        let serial = format!("{:032x}", 2);
        st.take_crl(&crl(&root, 1, &[serial], None), T0, &Fields::new()).unwrap().unwrap();
        assert_eq!(row(&all(&st, &logs, none(), true), &spoke)["state"], "revoked");
    }

    #[test]
    fn seats_view_shows_hubs_refused_for_want_of_a_seat() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        st.uncounted.push("n_0123456789abcdef0123456789abcdef", Some("carol@acme.example"), T0);
        let v = st.spokes_seats(T0 + 1);
        assert_eq!(v["uncounted"][0]["email"], "carol@acme.example");
        assert!(st.spokes_attention(true, T0 + 1).iter().any(|a| a["kind"] == "uncounted"));
        assert!(!st.spokes_attention(false, T0 + 1).iter().any(|a| a["kind"] == "uncounted"), "viewers see no seat items");
        assert_eq!(st.spokes_seats(T0 + crate::console_spokes::WINDOW_MS)["uncounted"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn the_remote_spokes_service_gate_is_unchanged_503_past_grace_and_no_upgrade_period() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        let where_ = Fields::new();
        // No license: no gate and no upgrade period (that is Meeting Hub's alone, 2.4).
        assert!(st.license_gate(T0 + 400 * 86_400_000, &where_).unwrap().is_none());
        let exp = T0 / 1000 + 86_400;
        let license = crate::license::License { id: "l_1".into(), org: "acme".into(), root: root_id(&root), edition: "standard".into(), users: 5, relays: 1, exp, grace_days: 14 };
        st.licensed = Some(Licensed { token: String::new(), license, dev: false, users: crate::license::LicenseUsers::open(None).unwrap() });
        assert!(st.license_gate(T0, &where_).unwrap().is_none(), "valid serves");
        assert!(st.license_gate((exp + 86_400) * 1000, &where_).unwrap().is_none(), "grace serves");
        let r = st.license_gate((exp + 14 * 86_400) * 1000, &where_).unwrap().expect("past grace refuses");
        assert_eq!(r.status, 503);
    }

    #[test]
    fn console_requests_answer_409_when_the_console_is_off() {
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let (mut st, _) = state_logged(&root);
        let (hub_key, hub_cert, _) = node(&root, 3, "hub");
        let r = call(&mut st, &hub_key, &hub_cert, "GET", "/v1/console/requests", "", T0, 1);
        assert_eq!(r.status, 409);
        assert!(r.body.contains(CONSOLE_OFF));
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
