// Contract API-1 revision 6 (phase 1d), 7.2.1, 7.2.3, 5.2, 5.4, 5.5 and 16 (slice 1d3): the connector as service hub.
//
// The connector holds the node key of its agent's hub (the `spokes_hub` client the map's `agents[].hub` names) and
// that client's node certificate, and speaks the Remote Spokes protocol to the org's spokes on its own tasks only.
//
//   config key `spokes_hub`   `{"client": "c_<16 hex>", "cert": "<file>", "directory": "<file>"}` (`HubConfig`): the
//                             client id, where the installed certificate lives, and the root-signed relay directory
//                             file (kept current from the API relays).
//   `state_dir/spokes_hub/`   the sealed node key (`node-key`) and sealed task book (`tasks`), under the config's
//                             `seal` source, which is the credential's `key_store` (4.2: `tpm`, `pkcs11`,
//                             `azure_key_vault`, else `os_store`; the connector reports it in its sync `seal`);
//                             `request.txt` (the node request), `root.pub` (the org root's key), `license.seat`
//                             (optional), `crl.json` (the newest CRL bundle), `seen.json` (the replay guard's ids) and
//                             `spokes/<node>.cert` (the spokes it may address; certificates are public).
//   `spokes-keygen`           makes the key (sealed) and the `lucid-node-request` for `root approve --service`.
//   `spokes-install`          installs the certificate (`--cert`), the root key (`--root`, first time) and the seat
//                             (`--seat`): refused unless it verifies under the root, is this key's, is a hub's with
//                             exactly `recall` and `drive`, and is a service hub's under 5.2.
//   `spokes-add`              installs a spoke's certificate (as the add-on's `hub add-spoke`).
//
// `ServiceHub` (started by `connector serve`, never in an enclave: 7.2.1):
//   - own tasks only (R6-1): the ops it can send are the `Op` enum (`hello`, `status`, `recall` always with `task`,
//     `approvals`, `submit` always held, `followup`, `cancel`, `close`, `deny`); `decide`, `model*`, `custody`,
//     `standby`, `handoffNote`, `restore` and `renew` cannot be expressed. Every op naming a task needs the task in its
//     own book (made by its own submit), else "unknown task" without sending anything.
//   - marked relays only (rule M, 5.8): the held directory's entries with `"api": true`, while it is in date.
//   - the inbox loop: `GET /v1/inbox` every 2 s while a task is open or a request waits, every 30 s otherwise; each
//     batch's task book changes are sealed and fsynced before the batch is acknowledged. The CRL bundle and the
//     directory are fetched again every 5 minutes; a newer directory that no longer makes this certificate a service
//     hub's stops the hub.
//   - presence-based spoke choice: a skill's targets in order, the first present (polled within 5 minutes on an API
//     relay), registered for the client in the pinned map, of a class the key store allows (`cui` needs a hardware
//     store, 2.2), that takes the submit; else a fixed Lucid sentence (R6-13).
//   - held starts and turns (5.5, R6-6): `held_text` writes the connector's header naming the partner into the signed
//     `input`; `task_name` is the skill id. The spoke holds both until a person approves.
//   - requests are kept in one table (`Outstanding`), submits sealed with the book: a submit's task is made and sealed
//     from its reply before the reply is acknowledged; a submit whose wait ends first is cancel-required, and the task
//     its late reply makes is canceled, sent again until a reply confirms it, across restarts, so no task runs
//     untracked.
//   - fail closed: a replay guard or book that cannot be written leaves the batch unacknowledged; a newer CRL or
//     directory is written before it is used (else the hub stops); after every trust refresh the hub's own
//     certificate is checked again (revoked, expired, not a service hub's: the hub stops and reads no inbox).
// Slice 1d4's A2A server (`connector_a2a`) calls the ops and hears the inbox loop through `HubEvents`.

use crate::codec::{now_ms, sha256_hex, str_of, stringify, utf16_len};
use crate::connector::Config;
use crate::connector_seal::{make_private_dir, write_private, SealedStore, Sealer, KEY_STORE_AZURE, KEY_STORE_PKCS11, KEY_STORE_TPM};
use crate::connector_spokes_relay::{api_relays, granted, relay_grant, warn_relay, ApiRelay, HttpsMailbox, Mailbox, RelayClient};
use crate::connector_spokes_wire::{check_code, node_request, object_of, open, random_hex, request_plaintext, seal, task_name, verify_run, JournalEntry, NodeKey, OpenError, Reply, ReplayGuard, MAX_TEXT};
use crate::der::{p256_from_spki, p256_spki_der, P256Key};
use crate::identity::{is_node_id, is_service_hub, parse_bundle, DirectoryHolder, NodeCert, TrustStore};
use crate::meet::{log_error, log_info, log_warn};
use crate::meet_org_policy::Obj;
use parking_lot::{Condvar, Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const HUB_DIR: &str = "spokes_hub";
pub const KEY_NAME: &str = "node-key";
pub const TASKS_NAME: &str = "tasks";
pub const REQUEST_FILE: &str = "request.txt";
pub const ROOT_FILE: &str = "root.pub";
pub const SEAT_FILE: &str = "license.seat";
pub const BUNDLE_FILE: &str = "crl.json";
pub const SEEN_FILE: &str = "seen.json";
pub const SPOKES_DIR: &str = "spokes";
/// 7.2.3: the inbox is polled this often while a task is open or a request waits, and this often otherwise.
pub const POLL_OPEN: Duration = Duration::from_secs(2);
pub const POLL_IDLE: Duration = Duration::from_secs(30);
/// The CRL bundle and the relay directory are fetched again this often (spoke.ts CRL_EVERY_MS).
pub const TRUST_EVERY_MS: i64 = 5 * 60_000;
/// 7.2.3: a target is present when an API relay saw it poll within this long.
pub const PRESENT_MS: i64 = 5 * 60_000;
/// hub.ts: how long a request waits for its sealed reply.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// spoke.ts HOLD_MIN_S, HOLD_MAX_S: a held instruction's `within_s`.
pub const HOLD_MIN_S: i64 = 300;
pub const HOLD_MAX_S: i64 = 86_400;
/// Notes on tasks the book does not have yet that are kept until their submit is recorded.
pub const EARLY_MAX: usize = 64;
/// spoke.ts ENDED_TASK_DAYS: ended tasks leave the book after this long.
pub const ENDED_KEPT_MS: i64 = 14 * 86_400_000;
/// 7.2.1: what an enclave connector lists in its sync `features`.
pub const A2A_ENCLAVE: &str = "a2a-enclave";
/// 2.2: the key stores that may hold a service hub key for `cui` work.
pub const HARDWARE_KEY_STORES: [&str; 3] = [KEY_STORE_PKCS11, KEY_STORE_AZURE, KEY_STORE_TPM];
/// owner.ts OWNER_PAUSED: the spoke's words when the person at it paused new work.
pub const OWNER_PAUSED: &str = "the person at this computer paused new work; try again later";

// The refusals (each one sentence, exact).
pub const ENCLAVE: &str = "an enclave connector serves no A2A, so its service hub does not start (contract r6 7.2.1)";
pub const CLIENT_BAD: &str = "spokes_hub.client must be the spokes_hub client's id, c_ followed by 16 lowercase hex digits";
pub const HUB_KEYS_BAD: &str = "spokes_hub must be {\"client\": <c_ id>, \"cert\": <file>, \"directory\": <file>}";
pub const NO_HUB: &str = "the connector config has no spokes_hub";
pub const NO_KEY: &str = "the service hub has no key on this host: run connector spokes-keygen first";
pub const NO_CERT: &str = "the service hub's certificate is not installed: run connector spokes-install --cert <file> first";
pub const NO_ROOT: &str = "the org root's public key is not installed: run connector spokes-install with --root <root.pub>";
pub const ROOT_BAD: &str = "the org root's public key must be a P-256 PUBLIC KEY PEM (root.pub)";
pub const NO_DIRECTORY: &str = "the relay directory file named by spokes_hub.directory is missing: copy the root-signed relay directory there";
pub const NO_API_RELAY: &str = "the held relay directory marks no API relay in date, so no spoke can be reached (contract r6 5.8)";
pub const NOT_SERVICE_HUB: &str = "this certificate is not a service hub's: its user email must be <name>@apps.<an organization domain> (contract r6 5.2)";
pub const SCOPES_BAD: &str = "a service hub never approves: its certificate must carry exactly the recall and drive scopes";
pub const KEY_EXISTS: &str = "this host already holds the service hub's key and its certificate is installed; a renewed certificate is installed with connector spokes-install";
pub const NOT_OWN: &str = "unknown task";
pub const WAIT: &str = "wait until the current step ends";

// ── config (r5 2.2, r6 7.2.3) ───────────────────────────────────────────────────────────────────────────────

/// The connector config's `spokes_hub`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubConfig {
    pub client: String,
    pub cert: PathBuf,
    pub directory: PathBuf,
}

fn client_id_ok(s: &str) -> bool {
    s.strip_prefix("c_").is_some_and(|h| h.len() == 16 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

impl HubConfig {
    /// `{"client", "cert", "directory"}`, exactly; `base` (the config's folder) resolves relative paths.
    pub fn parse(v: &Value, base: &Path) -> Result<HubConfig, String> {
        let o = v.as_object().filter(|o| o.len() == 3 && ["client", "cert", "directory"].iter().all(|k| o.contains_key(*k))).ok_or(HUB_KEYS_BAD)?;
        let text = |k: &str| str_of(o.get(k)).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("spokes_hub.{k} must be a non-empty string"));
        let client = text("client")?;
        if !client_id_ok(client) {
            return Err(CLIENT_BAD.to_string());
        }
        let file = |p: &str| {
            let p = PathBuf::from(p);
            if p.is_absolute() {
                p
            } else {
                base.join(p)
            }
        };
        Ok(HubConfig { client: client.to_owned(), cert: file(text("cert")?), directory: file(text("directory")?) })
    }
}

/// `state_dir/spokes_hub/`, owner-only, with its sealed store under the config's `seal`, and the seal's `key_store`.
pub fn hub_store(cfg: &Config) -> Result<(PathBuf, Arc<SealedStore>, &'static str), String> {
    let dir = cfg.state_dir.join(HUB_DIR);
    make_private_dir(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let source = cfg.seal.source();
    let sealed = SealedStore::open(Sealer::from_source(&*source)?, dir.clone())?;
    Ok((dir, Arc::new(sealed), source.key_store()))
}

fn load_key(sealed: &SealedStore) -> Result<Option<NodeKey>, String> {
    match sealed.get_bytes(KEY_NAME)? {
        None => Ok(None),
        Some(mut d) => {
            let k = NodeKey::from_scalar(&d);
            crate::connector_seal::wipe(&mut d);
            k.map(Some)
        }
    }
}

fn read_trimmed(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

/// A flag value that is a file holds the token; anything else is the token itself (the add-on's `pemOrFile`).
fn token_arg(v: &str) -> String {
    let p = Path::new(v.trim());
    if p.is_file() {
        read_trimmed(p).unwrap_or_default()
    } else {
        v.trim().to_owned()
    }
}

/// The org root's key from `root.pub` (a P-256 `PUBLIC KEY` PEM).
pub fn root_key(pem: &str) -> Result<P256Key, String> {
    crate::der::pem_blocks(pem, "PUBLIC KEY").into_iter().next().and_then(|d| p256_from_spki(&d)).ok_or_else(|| ROOT_BAD.to_string())
}

/// The trust store of `dir`: its root, and the CRL bundle last held (a refused one is left out, never half taken).
fn trust_of(dir: &Path, root_pem: &str) -> Result<TrustStore, String> {
    let mut trust = TrustStore::new(root_key(root_pem)?);
    if let Some(b) = read_trimmed(&dir.join(BUNDLE_FILE)).and_then(|t| crate::codec::parse_json(&t)).and_then(|v| parse_bundle(Some(&v))) {
        if let Err(r) = trust.accept_bundle(&b) {
            log_warn(&format!("connector_spokes_bundle_refused reason={}", r.reason));
        }
    }
    Ok(trust)
}

/// The held relay directory (verified under `trust`), when the file is there.
fn directory_of(file: &Path, trust: &TrustStore, now_s: i64) -> Result<Option<DirectoryHolder>, String> {
    let Some(token) = read_trimmed(file) else { return Ok(None) };
    let mut holder = DirectoryHolder::default();
    holder.accept(trust, &token, now_s).map_err(|e| format!("the relay directory {} is refused: {e}", file.display()))?;
    Ok(Some(holder))
}

/// Why `cert` cannot be this connector's service hub certificate (for `key`), or None.
pub fn identity_problem(cert: &NodeCert, key: &NodeKey, org_domains: Option<&[String]>) -> Option<String> {
    if cert.node != key.node() {
        return Some(format!("this certificate is for node {}, not this host's service hub key {}", cert.node, key.node()));
    }
    if cert.role != "hub" {
        return Some(format!("this certificate is a {}'s, not a hub's", cert.role));
    }
    let mut scopes: Vec<&str> = cert.scopes.iter().map(String::as_str).collect();
    scopes.sort_unstable();
    if scopes != ["drive", "recall"] {
        return Some(SCOPES_BAD.to_string());
    }
    if !is_service_hub(cert, org_domains) {
        return Some(NOT_SERVICE_HUB.to_string());
    }
    None
}

// ── the CLI (7.2.3) ─────────────────────────────────────────────────────────────────────────────────────────

/// What `spokes-keygen` made.
#[derive(Clone, Debug)]
pub struct Keygen {
    pub request: PathBuf,
    pub node: String,
    pub check_code: String,
    pub key_store: &'static str,
}

/// `connector spokes-keygen`: a new P-256 node key made and sealed here (an existing one without a certificate is kept),
/// and its `lucid-node-request` (role hub, label `connector <connector id>`) in `request.txt` for `root approve
/// --service`.
pub fn keygen(cfg: &Config, now_s: i64) -> Result<Keygen, String> {
    let hub = cfg.spokes_hub.as_ref().ok_or(NO_HUB)?;
    let (dir, sealed, key_store) = hub_store(cfg)?;
    keygen_in(&dir, &sealed, key_store, &hub.cert, &format!("connector {}", cfg.connector_id), now_s)
}

/// `keygen` in `dir` over its sealed store.
pub(crate) fn keygen_in(dir: &Path, sealed: &SealedStore, key_store: &'static str, cert_file: &Path, label: &str, now_s: i64) -> Result<Keygen, String> {
    let key = match load_key(sealed)? {
        Some(_) if cert_file.exists() => return Err(KEY_EXISTS.to_string()),
        Some(k) => k,
        None => {
            let k = NodeKey::generate()?;
            sealed.put_bytes(KEY_NAME, k.scalar())?;
            k
        }
    };
    let request = node_request(&key, label, now_s)?;
    let path = dir.join(REQUEST_FILE);
    write_private(&path, format!("{request}\n").as_bytes()).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
    Ok(Keygen { request: path, node: key.node().to_owned(), check_code: check_code(key.spki()), key_store })
}

/// `connector spokes-install --cert <token or file> [--root <root.pub>] [--seat <file>]`: the certificate `root approve
/// --service` issued for `request.txt`, checked and stored at `spokes_hub.cert`. Ok is the certificate.
pub fn install(cfg: &Config, cert: &str, root: Option<&Path>, seat: Option<&Path>, now_s: i64) -> Result<NodeCert, String> {
    let hub = cfg.spokes_hub.as_ref().ok_or(NO_HUB)?;
    let (dir, sealed, _) = hub_store(cfg)?;
    install_in(&dir, &sealed, hub, cert, root, seat, now_s)
}

/// `install` in `dir` over its sealed store.
pub(crate) fn install_in(dir: &Path, sealed: &SealedStore, hub: &HubConfig, cert: &str, root: Option<&Path>, seat: Option<&Path>, now_s: i64) -> Result<NodeCert, String> {
    let key = load_key(sealed)?.ok_or(NO_KEY)?;
    let root_pem = match root {
        Some(p) => std::fs::read_to_string(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?,
        None => std::fs::read_to_string(dir.join(ROOT_FILE)).map_err(|_| NO_ROOT.to_string())?,
    };
    let trust = trust_of(&dir, &root_pem)?;
    let org_domains = directory_of(&hub.directory, &trust, now_s)?.and_then(|h| h.org_domains());
    let token = token_arg(cert);
    let c = trust.verify_cert(Some(&Value::String(token.clone())), now_s).map_err(|e| format!("the certificate is refused: {e}"))?;
    if let Some(p) = identity_problem(&c.cert, &key, org_domains.as_deref()) {
        return Err(p);
    }
    let seat = match seat {
        Some(p) => Some(read_trimmed(p).ok_or_else(|| format!("cannot read the seat {}", p.display()))?),
        None => None,
    };
    let write = |p: &Path, data: &str| write_private(p, format!("{data}\n").as_bytes()).map_err(|e| format!("{} could not be written: {e}", p.display()));
    if root.is_some() {
        write(&dir.join(ROOT_FILE), root_pem.trim())?;
    }
    if let Some(s) = &seat {
        write(&dir.join(SEAT_FILE), s)?;
    }
    write(&hub.cert, &token)?;
    Ok(c.cert)
}

/// `connector spokes-add --cert <token or file>`: a spoke's certificate (root-signed or delegated, role spoke), kept as
/// `spokes/<node>.cert`. Ok is the certificate.
pub fn add_spoke(cfg: &Config, cert: &str, now_s: i64) -> Result<NodeCert, String> {
    cfg.spokes_hub.as_ref().ok_or(NO_HUB)?;
    let (dir, _, _) = hub_store(cfg)?;
    add_spoke_in(&dir, cert, now_s)
}

/// `add_spoke` in `dir`.
pub(crate) fn add_spoke_in(dir: &Path, cert: &str, now_s: i64) -> Result<NodeCert, String> {
    let root_pem = std::fs::read_to_string(dir.join(ROOT_FILE)).map_err(|_| NO_ROOT.to_string())?;
    let trust = trust_of(&dir, &root_pem)?;
    let token = token_arg(cert);
    let c = trust.verify_cert(Some(&Value::String(token.clone())), now_s).map_err(|e| format!("spoke certificate refused: {e}"))?;
    if c.cert.role != "spoke" {
        return Err(format!("that certificate is a {}, not a spoke", c.cert.role));
    }
    let path = dir.join(SPOKES_DIR).join(format!("{}.cert", c.cert.node));
    write_private(&path, format!("{token}\n").as_bytes()).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
    Ok(c.cert)
}

// ── tasks ───────────────────────────────────────────────────────────────────────────────────────────────────

/// A spoke task this service hub created, as its book keeps it (no task text: only ids, states and times).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubTask {
    pub id: String,
    pub spoke: String,
    pub name: String,
    /// The spoke's state (`spoke.ts` TaskState): `working`, `awaiting_approval`, `idle`, `error`, `stopped`, `closed`.
    pub state: String,
    /// `task.start`, `task.turn` (held, 5.5) or the engine's kind while `awaiting_approval`.
    pub awaiting: Option<String>,
    pub ask: Option<PendingAsk>,
    /// Turns read so far (`publicTask.turns`).
    pub turns: i64,
    /// The spoke journal's head in its last note.
    pub journal_head: i64,
    /// Why it closed (`denied`, `approval expired`, `canceled`, ...).
    pub reason: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// The ask a task waits on, without its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAsk {
    pub id: String,
    pub kind: String,
    pub digest: String,
    pub expires_at: i64,
}

fn task_id_ok(s: &str) -> bool {
    s.len() == 18 && s.starts_with("t_") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl HubTask {
    /// Neither closed nor stopped.
    pub fn open(&self) -> bool {
        !matches!(self.state.as_str(), "closed" | "stopped")
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "spoke": self.spoke, "name": self.name, "state": self.state, "awaiting": self.awaiting,
            "ask": self.ask.as_ref().map(|a| json!({ "id": a.id, "kind": a.kind, "digest": a.digest, "expires_at": a.expires_at })),
            "turns": self.turns, "journal_head": self.journal_head, "reason": self.reason, "created_ms": self.created_ms, "updated_ms": self.updated_ms,
        })
    }

    fn from_json(v: &Value) -> Option<HubTask> {
        let s = |k: &str| str_of(v.get(k)).map(str::to_owned);
        let i = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
        let ask = v.get("ask").filter(|a| a.is_object()).and_then(|a| {
            Some(PendingAsk { id: str_of(a.get("id"))?.to_owned(), kind: str_of(a.get("kind"))?.to_owned(), digest: str_of(a.get("digest"))?.to_owned(), expires_at: a.get("expires_at")?.as_i64()? })
        });
        Some(HubTask {
            id: s("id").filter(|t| task_id_ok(t))?,
            spoke: s("spoke").filter(|n| is_node_id(n))?,
            name: s("name")?,
            state: s("state")?,
            awaiting: s("awaiting"),
            ask,
            turns: i("turns"),
            journal_head: i("journal_head"),
            reason: s("reason"),
            created_ms: i("created_ms"),
            updated_ms: i("updated_ms"),
        })
    }

    /// A spoke's `publicTask` view (or a reply's `{state, awaiting}`) applied; true when anything changed.
    fn take_view(&mut self, v: &Value, now_ms: i64) -> bool {
        let before = self.clone();
        if let Some(st) = str_of(v.get("state")) {
            self.state = st.to_owned();
            self.awaiting = str_of(v.get("awaiting")).map(str::to_owned);
        }
        if let Some(t) = v.get("turns").and_then(Value::as_i64) {
            self.turns = t;
        }
        if let Some(r) = str_of(v.get("reason")) {
            self.reason = Some(r.to_owned());
        }
        if let Some(h) = v.get("journalHead").and_then(Value::as_i64) {
            self.journal_head = h;
        }
        if self.state != "awaiting_approval" {
            self.ask = None;
        }
        let changed = *self != before;
        if changed {
            self.updated_ms = now_ms;
        }
        changed
    }
}

// ── the service hub ─────────────────────────────────────────────────────────────────────────────────────────

/// The ops a service hub sends (contract r6 5.4, 7.2.3). Nothing else can be expressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Hello,
    Status,
    Recall,
    Approvals,
    Submit,
    Followup,
    Cancel,
    Close,
    Deny,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::Hello => "hello",
            Op::Status => "status",
            Op::Recall => "recall",
            Op::Approvals => "approvals",
            Op::Submit => "submit",
            Op::Followup => "followup",
            Op::Cancel => "cancel",
            Op::Close => "close",
            Op::Deny => "deny",
        }
    }

    fn of(name: &str) -> Option<Op> {
        [Op::Hello, Op::Status, Op::Recall, Op::Approvals, Op::Submit, Op::Followup, Op::Cancel, Op::Close, Op::Deny].into_iter().find(|o| o.name() == name)
    }
}

/// A late submit's cancel is sent again after this long without a confirmation.
pub const CANCEL_RETRY_MS: i64 = 60_000;
/// A cancel-required submit whose reply never came is dropped after the relays' mail TTL (72 hours) and an hour.
pub const CANCEL_GIVE_UP_MS: i64 = 73 * 3_600_000;

/// One outstanding request of the hub, by request id (contract r6 5.5, 7.2.3). A submit is sealed with the book before
/// it leaves and until its reply is taken (the task it made is sealed in the same write, before the reply is
/// acknowledged). One whose wait ends first becomes cancel-required in the same step, and stays, sealed and across
/// restarts, until a cancel of the task its reply made is confirmed.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Outstanding {
    op: Op,
    spoke: String,
    /// The task the op names, or the task a cancel-required submit's reply made.
    task: Option<String>,
    /// A submit's task name and hold.
    name: String,
    within_s: i64,
    /// Nobody waits: the task the reply makes is canceled.
    cancel: bool,
    /// The cancel sent for that task and when (ms); sent again after CANCEL_RETRY_MS without a confirmation.
    cancel_rid: Option<String>,
    cancel_at: i64,
    /// When it was sent, or became cancel-required (ms).
    at: i64,
}

impl Outstanding {
    fn to_json(&self, rid: &str) -> Value {
        json!({
            "rid": rid, "op": self.op.name(), "spoke": self.spoke, "task": self.task, "name": self.name, "within_s": self.within_s,
            "cancel": self.cancel, "cancel_rid": self.cancel_rid, "cancel_at": self.cancel_at, "at": self.at,
        })
    }

    fn from_json(v: &Value) -> Option<(String, Outstanding)> {
        let i = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
        let r = Outstanding {
            op: Op::of(str_of(v.get("op"))?)?,
            spoke: str_of(v.get("spoke")).filter(|n| is_node_id(n))?.to_owned(),
            task: str_of(v.get("task")).filter(|t| task_id_ok(t)).map(str::to_owned),
            name: str_of(v.get("name")).unwrap_or_default().to_owned(),
            within_s: i("within_s"),
            cancel: v.get("cancel") == Some(&Value::Bool(true)),
            cancel_rid: str_of(v.get("cancel_rid")).map(str::to_owned),
            cancel_at: i("cancel_at"),
            at: i("at"),
        };
        Some((str_of(v.get("rid"))?.to_owned(), r))
    }
}

/// What one envelope did to the hub's state (`take`).
enum Taken {
    Nothing,
    /// The book or the request table changed: seal before acknowledging.
    Dirty,
    /// A task changed (with the ask when the spoke announced one): seal, then tell the hook.
    Task(HubTask, Option<Value>),
    /// The replay guard could not keep the envelope's id: nothing of it was taken, and it stays unacknowledged.
    Unavailable(String),
}

/// Why a service hub call did not get done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HubError {
    /// The spoke answered `ok: false`, in its words.
    Refused(String),
    /// Not a task of this service hub's own book: the add-on's "unknown task", nothing sent.
    NotOwn,
    /// The task does not take this now (5.5: "wait until the current step ends").
    Busy,
    /// No API relay took the request.
    Unreachable(String),
    /// No reply in time; the request still waits in the relay.
    Timeout,
    /// The hub cannot act now (not registered in the pinned map, stopped, no spoke certificate).
    Unavailable(String),
    /// The call itself is malformed.
    Invalid(String),
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubError::Refused(m) | HubError::Unreachable(m) | HubError::Unavailable(m) | HubError::Invalid(m) => f.write_str(m),
            HubError::NotOwn => f.write_str(NOT_OWN),
            HubError::Busy => f.write_str(WAIT),
            HubError::Timeout => f.write_str("no reply from the spoke in time; the request waits in the relay"),
        }
    }
}

/// A new task no spoke took (contract r6 7.6, R6-13: a fixed Lucid sentence, never the spoke's own words; the A2A
/// server words it with `connector_a2a_wire::Why::sentence`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejected {
    Paused,
    CannotRun,
    NoSpoke,
}

/// `submit`'s failure: rejected by every target (the task is `TASK_STATE_REJECTED`), or the hub could not act.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmitError {
    Rejected(Rejected),
    Hub(HubError),
}

/// A held submit (5.5): the targets in order (a skill's `targets`), the task name (`task_name` of the skill id), the
/// whole `input` (`held_text`: the connector's header and the partner's text), the hold and an optional model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submit {
    pub targets: Vec<String>,
    pub name: String,
    pub text: String,
    pub within_s: i64,
    pub model: Option<String>,
}

/// One verified page of a task's spoke journal.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallPage {
    pub entries: Vec<JournalEntry>,
    pub head: i64,
    pub more: bool,
}

/// What the A2A server (slice 1d4) hears from the inbox loop. Called outside every hub lock.
pub trait HubEvents: Send + Sync {
    /// A task's state, ask or journal head changed (a spoke note, or an op's answer).
    fn task_changed(&self, task: &HubTask);
    /// The spoke announced an ask on the task (a held `task.start` or `task.turn`, or an engine ask); `ask` as sent.
    fn approval_asked(&self, task: &HubTask, ask: &Value);
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type MailboxFactory = Arc<dyn Fn(&ApiRelay) -> Result<Arc<dyn Mailbox>, String> + Send + Sync>;
/// The org's pinned API map (`connector_sync`), None while none is pinned.
pub type PinnedMap = Arc<dyn Fn() -> Option<Obj> + Send + Sync>;

/// What `ServiceHub::open` takes (`start` fills it from the config; tests from their own world).
pub struct HubParts {
    pub org: String,
    pub client: String,
    pub key_store: &'static str,
    pub dir: PathBuf,
    pub cert_file: PathBuf,
    pub directory_file: PathBuf,
    pub sealed: Arc<SealedStore>,
    pub enclave: bool,
    pub clock: Clock,
    pub mailbox: MailboxFactory,
    pub pinned: PinnedMap,
    pub request_timeout: Duration,
}

pub struct ServiceHub {
    org: String,
    client: String,
    key_store: &'static str,
    dir: PathBuf,
    directory_file: PathBuf,
    key: Arc<NodeKey>,
    cert: String,
    me: NodeCert,
    seat: Option<String>,
    sealed: Arc<SealedStore>,
    clock: Clock,
    mailbox: MailboxFactory,
    pinned: PinnedMap,
    request_timeout: Duration,
    trust: RwLock<TrustStore>,
    directory: RwLock<DirectoryHolder>,
    /// The clients made so far, keyed by the directory entry (relay id and url) they were made for, not by what their
    /// mailbox reports.
    relays: RwLock<Vec<(ApiRelay, Arc<RelayClient>)>>,
    /// Spoke node id to its certificate token.
    spokes: RwLock<BTreeMap<String, String>>,
    book: Mutex<BTreeMap<String, HubTask>>,
    replay: Mutex<ReplayGuard>,
    /// Outstanding requests by request id (submits sealed with the book), and the replies that came for waiting ones.
    /// Lock order: `requests`, then `book`, then `replies`.
    requests: Mutex<BTreeMap<String, Outstanding>>,
    replies: Mutex<HashMap<String, Reply>>,
    replied: Condvar,
    /// Notes and asks (spoke, message) on tasks not in the book yet, at most EARLY_MAX.
    early: Mutex<Vec<(String, Map<String, Value>)>>,
    waiting: AtomicUsize,
    wake: (Mutex<bool>, Condvar),
    poll_lock: Mutex<()>,
    looping: AtomicBool,
    trust_at: Mutex<i64>,
    stopped: RwLock<Option<String>>,
    unknown: AtomicU64,
    events: OnceLock<Arc<dyn HubEvents>>,
}

/// `connector serve`: the service hub of `spokes_hub` opened and its inbox loop started on its own thread. Err (the
/// connector serves on without A2A) in an enclave (7.2.1) or when the key, certificate, root, directory or identity
/// does not hold.
pub fn start(cfg: &Config, pinned: PinnedMap) -> Result<Arc<ServiceHub>, String> {
    let hub = cfg.spokes_hub.as_ref().ok_or(NO_HUB)?;
    if cfg.enclave.on {
        return Err(ENCLAVE.to_string());
    }
    let (dir, sealed, key_store) = hub_store(cfg)?;
    let mailbox: MailboxFactory = Arc::new(|r: &ApiRelay| HttpsMailbox::new(r).map(|m| Arc::new(m) as Arc<dyn Mailbox>));
    let parts = HubParts {
        org: cfg.org.clone(),
        client: hub.client.clone(),
        key_store,
        dir,
        cert_file: hub.cert.clone(),
        directory_file: hub.directory.clone(),
        sealed,
        enclave: cfg.enclave.on,
        clock: Arc::new(now_ms),
        mailbox,
        pinned,
        request_timeout: REQUEST_TIMEOUT,
    };
    let h = ServiceHub::open(parts)?;
    let runner = h.clone();
    std::thread::Builder::new().name("connector-spokes-hub".into()).spawn(move || runner.run()).map_err(|e| format!("cannot start the service hub: {e}"))?;
    Ok(h)
}

impl ServiceHub {
    /// The hub over `parts`, checked: not an enclave, key, certificate (this key's, a service hub's under the held
    /// directory's `org_domains`, exactly recall and drive), root, directory with an API relay in date.
    pub fn open(p: HubParts) -> Result<Arc<ServiceHub>, String> {
        if p.enclave {
            return Err(ENCLAVE.to_string());
        }
        let now = (p.clock)();
        let now_s = now.div_euclid(1000);
        let key = load_key(&p.sealed)?.ok_or(NO_KEY)?;
        let cert = read_trimmed(&p.cert_file).ok_or(NO_CERT)?;
        let root_pem = std::fs::read_to_string(p.dir.join(ROOT_FILE)).map_err(|_| NO_ROOT.to_string())?;
        let mut trust = trust_of(&p.dir, &root_pem)?;
        let holder = directory_of(&p.directory_file, &trust, now_s)?.ok_or(NO_DIRECTORY)?;
        trust.set_cert_grace_hours(holder.cert_grace_hours());
        let me = trust.verify_cert(Some(&Value::String(cert.clone())), now_s).map_err(|e| format!("this service hub's certificate: {e}"))?.cert;
        if let Some(problem) = identity_problem(&me, &key, holder.org_domains().as_deref()) {
            return Err(problem);
        }
        let mut spokes = BTreeMap::new();
        for e in std::fs::read_dir(p.dir.join(SPOKES_DIR)).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let (Some(node), Some(token)) = (name.strip_suffix(".cert").filter(|n| is_node_id(n)), read_trimmed(&e.path())) {
                spokes.insert(node.to_owned(), token);
            }
        }
        let mut book = BTreeMap::new();
        let mut requests = BTreeMap::new();
        if let Some(v) = p.sealed.get(TASKS_NAME)? {
            for t in v.get("tasks").and_then(Value::as_array).into_iter().flatten().filter_map(HubTask::from_json) {
                book.insert(t.id.clone(), t);
            }
            // a submit sent before the restart has no caller now: whatever task its reply makes is canceled
            for (rid, mut r) in v.get("requests").and_then(Value::as_array).into_iter().flatten().filter_map(Outstanding::from_json) {
                if !r.cancel {
                    r.cancel = true;
                    r.at = now;
                }
                requests.insert(rid, r);
            }
        }
        let key = Arc::new(key);
        let seat = read_trimmed(&p.dir.join(SEAT_FILE));
        let hub = ServiceHub {
            org: p.org,
            client: p.client,
            key_store: p.key_store,
            replay: Mutex::new(ReplayGuard::persisted(p.dir.join(SEEN_FILE))),
            dir: p.dir,
            directory_file: p.directory_file,
            key,
            cert,
            me,
            seat,
            sealed: p.sealed,
            clock: p.clock,
            mailbox: p.mailbox,
            pinned: p.pinned,
            request_timeout: p.request_timeout,
            trust: RwLock::new(trust),
            directory: RwLock::new(holder),
            relays: RwLock::new(Vec::new()),
            spokes: RwLock::new(spokes),
            book: Mutex::new(book),
            requests: Mutex::new(requests),
            replies: Mutex::new(HashMap::new()),
            replied: Condvar::new(),
            early: Mutex::new(Vec::new()),
            waiting: AtomicUsize::new(0),
            wake: (Mutex::new(false), Condvar::new()),
            poll_lock: Mutex::new(()),
            looping: AtomicBool::new(false),
            // the loop's first pass fetches the CRL bundle and the directory
            trust_at: Mutex::new(0),
            stopped: RwLock::new(None),
            unknown: AtomicU64::new(0),
            events: OnceLock::new(),
        };
        // the grant (5.8 as amended) is judged at each use: the pinned map may come after the hub opens
        let marked = api_relays(hub.directory.read().token().unwrap_or_default(), now_s);
        if marked.is_empty() {
            return Err(NO_API_RELAY.to_string());
        }
        log_info(&format!(
            "connector_spokes_hub org={} client={} node={} key_store={} relays={} spokes={} tasks={}",
            hub.org,
            hub.client,
            hub.me.node,
            hub.key_store,
            marked.iter().map(|r| format!("{}={}", r.relay, r.url)).collect::<Vec<_>>().join(","),
            hub.spokes.read().len(),
            hub.book.lock().len()
        ));
        Ok(Arc::new(hub))
    }

    /// The A2A server's hook (set once).
    pub fn set_events(&self, events: Arc<dyn HubEvents>) {
        let _ = self.events.set(events);
    }

    pub fn node(&self) -> &str {
        &self.me.node
    }

    pub fn client(&self) -> &str {
        &self.client
    }

    /// 4.2: where the node key is sealed (the connector's `seal` source).
    pub fn key_store(&self) -> &'static str {
        self.key_store
    }

    /// Why the hub stopped acting (its certificate is no longer a service hub's under a newer directory), or None.
    pub fn stopped(&self) -> Option<String> {
        self.stopped.read().clone()
    }

    /// A task of its own book.
    pub fn task(&self, task: &str) -> Option<HubTask> {
        self.book.lock().get(task).cloned()
    }

    /// Every task of its own book.
    pub fn tasks(&self) -> Vec<HubTask> {
        self.book.lock().values().cloned().collect()
    }

    /// The Lucid task class (contract r6 1) of a known spoke, from its verified certificate's `classification`.
    pub fn spoke_class(&self, node: &str) -> Option<&'static str> {
        self.spoke(node).ok().map(|(c, _)| crate::spokes_api::task_class(c.classification.as_deref()))
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// The relay ids the pinned map grants this hub's client (5.8 as amended); none while no map is pinned.
    fn relay_grant(&self) -> Vec<String> {
        (self.pinned)().map(|map| relay_grant(&map, &self.client)).unwrap_or_default()
    }

    /// The relays usable now (rule M, 5.8 as amended): the held directory's entries marked `api`, in date, whose relay
    /// id is in the client's grant, lowest `priority` first; none without a pinned map. A client is made on first use
    /// and kept until the directory changes; an entry that cannot be dialed at all is logged and left out.
    fn relays_now(&self) -> Vec<Arc<RelayClient>> {
        let now_s = self.now().div_euclid(1000);
        let token = self.directory.read().token().map(str::to_owned).unwrap_or_default();
        let wanted = granted(api_relays(&token, now_s), &self.relay_grant());
        let mut held = self.relays.write();
        let mut out = Vec::with_capacity(wanted.len());
        for r in wanted {
            if let Some((_, c)) = held.iter().find(|(e, _)| *e == r) {
                out.push(c.clone());
                continue;
            }
            match (self.mailbox)(&r).and_then(|m| RelayClient::new(m, self.key.clone(), &self.cert, self.seat.clone())) {
                Ok(c) => {
                    let c = Arc::new(c);
                    held.push((r, c.clone()));
                    out.push(c);
                }
                Err(e) => log_error(&format!("connector_spokes_relay_unusable relay={} url={} error={e}", r.relay, r.url)),
            }
        }
        out
    }

    fn usable(&self) -> Result<(), HubError> {
        match self.stopped() {
            Some(why) => Err(HubError::Unavailable(why)),
            None => Ok(()),
        }
    }

    /// A known spoke's certificate, verified now (role spoke, its own node id), and its key.
    fn spoke(&self, node: &str) -> Result<(NodeCert, P256Key), HubError> {
        let token = self.spokes.read().get(node).cloned().ok_or_else(|| HubError::Unavailable(format!("no certificate for spoke {node} on this connector (connector spokes-add)")))?;
        let c = self.trust.read().verify_cert(Some(&Value::String(token)), self.now().div_euclid(1000)).map_err(|e| HubError::Unavailable(format!("spoke {node}: {e}")))?;
        if c.cert.role != "spoke" || c.cert.node != node {
            return Err(HubError::Unavailable(format!("the certificate held for {node} is not that spoke's")));
        }
        Ok((c.cert, c.key))
    }

    /// The task, when it is in its own book (rule O).
    fn own(&self, task: &str) -> Result<HubTask, HubError> {
        self.book.lock().get(task).cloned().ok_or(HubError::NotOwn)
    }

    /// Seal the book (ended tasks past ENDED_KEPT_MS dropped) and fsync it.
    fn save(&self) -> Result<(), String> {
        let now = self.now();
        // lock order: requests, then book
        let reqs = self.requests.lock();
        let mut book = self.book.lock();
        book.retain(|_, t| t.open() || now - t.updated_ms <= ENDED_KEPT_MS);
        let tasks: Vec<Value> = book.values().map(HubTask::to_json).collect();
        // only submits are kept: they make tasks; every other op's reply is lost harmlessly with its caller
        let requests: Vec<Value> = reqs.iter().filter(|(_, r)| r.op == Op::Submit).map(|(rid, r)| r.to_json(rid)).collect();
        self.sealed.put(TASKS_NAME, &json!({ "v": 1, "tasks": tasks, "requests": requests }))
    }

    /// 7.2.3: the client in the org's pinned map, registered with this certificate, and its `spokes.targets`. The map's
    /// `spokes.root_spki` must be this hub's root.
    pub fn registration(&self) -> Result<Vec<String>, HubError> {
        let unavailable = |m: &str| HubError::Unavailable(m.to_owned());
        let map = (self.pinned)().ok_or_else(|| unavailable("the connector holds no pinned API map yet"))?;
        let root_spki = sha256_hex(&p256_spki_der(self.trust.read().root_key()));
        if map.get("spokes").and_then(|s| str_of(s.get("root_spki"))).is_some_and(|r| r != root_spki) {
            return Err(unavailable("the pinned map's Remote Spokes root is not this service hub's root"));
        }
        let c = map
            .get("clients")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|c| str_of(c.get("id")) == Some(self.client.as_str()))
            .ok_or_else(|| HubError::Unavailable(format!("the pinned map does not list client {}", self.client)))?;
        if str_of(c.get("kind")) != Some("spokes_hub") || str_of(c.get("state")) != Some("active") {
            return Err(HubError::Unavailable(format!("client {} is not an active spokes_hub client in the pinned map", self.client)));
        }
        let own_spki = sha256_hex(self.key.spki());
        let held = c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|k| {
            str_of(k.get("type")) == Some("spokes_node") && str_of(k.get("serial")).is_some_and(|s| s.eq_ignore_ascii_case(&self.me.serial)) && str_of(k.get("spki")) == Some(own_spki.as_str())
        });
        if !held {
            return Err(unavailable("the pinned map does not register this service hub's certificate"));
        }
        Ok(c.get("spokes").and_then(|s| s.get("targets")).and_then(Value::as_array).into_iter().flatten().filter_map(|t| t.as_str().map(str::to_owned)).collect())
    }

    // ── requests ────────────────────────────────────────────────────────────────────────────────────────────

    fn wake_loop(&self) {
        let (lock, cv) = &self.wake;
        *lock.lock() = true;
        cv.notify_all();
    }

    /// Seal `op` (request id `rid`) to `spoke` and hand it to the first API relay that takes it.
    fn send_sealed(&self, spoke: &str, key: &P256Key, rid: &str, op: Op, args: &Value, now: i64) -> Result<(), HubError> {
        let crl = self.trust.read().crl_token().map(str::to_owned);
        let text = request_plaintext(rid, op.name(), args, crl.as_deref());
        let env = seal(&self.key, &self.cert, spoke, key, &text, now).map_err(HubError::Invalid)?;
        let relays = self.relays_now();
        if relays.is_empty() {
            return Err(HubError::Unreachable(NO_API_RELAY.to_string()));
        }
        let mut failed = Vec::new();
        for r in relays {
            match r.send(&env, now) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    warn_relay(r.url(), "send", &e);
                    failed.push(format!("{}: {e}", r.url()));
                }
            }
        }
        Err(HubError::Unreachable(format!("no API relay took the message ({})", failed.join("; "))))
    }

    /// Record `op` in the request table (a submit sealed before it leaves), then send it; Ok is the request id. A
    /// submit no relay took is cancel-required: a relay may have stored it all the same.
    fn send_op(&self, spoke: &str, op: Op, args: &Value) -> Result<String, HubError> {
        self.usable()?;
        let (_, key) = self.spoke(spoke)?;
        let rid = random_hex(8).map_err(HubError::Unavailable)?;
        let now = self.now();
        let entry = Outstanding {
            op,
            spoke: spoke.to_owned(),
            task: str_of(args.get("task")).map(str::to_owned),
            name: str_of(args.get("name")).unwrap_or_default().to_owned(),
            within_s: args.pointer("/hold/within_s").and_then(Value::as_i64).unwrap_or(0),
            cancel: false,
            cancel_rid: None,
            cancel_at: 0,
            at: now,
        };
        self.requests.lock().insert(rid.clone(), entry);
        if op == Op::Submit {
            if let Err(e) = self.save() {
                self.requests.lock().remove(&rid);
                return Err(HubError::Unavailable(format!("the submit could not be recorded: {e}")));
            }
        }
        match self.send_sealed(spoke, &key, &rid, op, args, now) {
            Ok(()) => Ok(rid),
            Err(e) => {
                let submit = {
                    let mut reqs = self.requests.lock();
                    match reqs.get_mut(&rid) {
                        Some(r) if r.op == Op::Submit => {
                            r.cancel = true;
                            true
                        }
                        _ => {
                            reqs.remove(&rid);
                            false
                        }
                    }
                };
                if submit {
                    if let Err(s) = self.save() {
                        log_error(&format!("connector_spokes_book_unsaved error={s}"));
                    }
                }
                Err(e)
            }
        }
    }

    /// The wait for `rid` ended without a reply: in one step under the table's lock, a reply that came at the last
    /// moment is taken, else a submit becomes cancel-required (sealed) and any other op is forgotten.
    fn give_up(&self, rid: &str) -> Result<Reply, HubError> {
        let now = self.now();
        let (reply, submit) = {
            let mut reqs = self.requests.lock();
            match self.replies.lock().remove(rid) {
                Some(r) => (Some(r), false),
                None => match reqs.get_mut(rid) {
                    Some(r) if r.op == Op::Submit => {
                        r.cancel = true;
                        r.at = now;
                        (None, true)
                    }
                    _ => {
                        reqs.remove(rid);
                        (None, false)
                    }
                },
            }
        };
        if submit {
            if let Err(e) = self.save() {
                // a restart turns the still-waiting record cancel-required anyway
                log_error(&format!("connector_spokes_book_unsaved error={e}"));
            }
        }
        reply.ok_or(HubError::Timeout)
    }

    /// One op and its sealed reply. While the inbox loop runs it files the reply; otherwise this call polls itself.
    fn request(&self, spoke: &str, op: Op, args: &Value) -> Result<Reply, HubError> {
        let rid = self.send_op(spoke, op, args)?;
        self.waiting.fetch_add(1, Ordering::SeqCst);
        self.wake_loop();
        let until = Instant::now() + self.request_timeout;
        let reply = loop {
            if let Some(r) = self.replies.lock().remove(&rid) {
                break Some(r);
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break None;
            }
            if self.looping.load(Ordering::SeqCst) {
                let mut g = self.replies.lock();
                if let Some(r) = g.remove(&rid) {
                    break Some(r);
                }
                self.replied.wait_for(&mut g, left.min(Duration::from_secs(1)));
            } else {
                self.poll_once();
                if let Some(r) = self.replies.lock().remove(&rid) {
                    break Some(r);
                }
                std::thread::sleep(left.min(Duration::from_millis(200)));
            }
        };
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        match reply {
            // `take` removed the record when it filed the reply
            Some(r) => Ok(r),
            None => self.give_up(&rid),
        }
    }

    /// `request` with `ok: false` as `Refused`.
    fn call(&self, spoke: &str, op: Op, args: &Value) -> Result<Value, HubError> {
        let r = self.request(spoke, op, args)?;
        if !r.ok {
            return Err(HubError::Refused(r.error.unwrap_or_else(|| "refused".into())));
        }
        Ok(r.data)
    }

    // ── own-task ops (5.4) ──────────────────────────────────────────────────────────────────────────────────

    /// The present targets in order: allowed by the pinned registration, polled within PRESENT_MS on an API relay,
    /// with a held certificate, and of a class this key store may reach (`cui` needs a hardware store).
    pub fn candidates(&self, targets: &[String], allowed: &[String]) -> Vec<String> {
        let now = self.now();
        let mut seen: HashMap<String, i64> = HashMap::new();
        for r in self.relays_now() {
            match r.presence(now) {
                Ok(rows) => {
                    for (node, at) in rows {
                        let e = seen.entry(node).or_insert(at);
                        *e = (*e).max(at);
                    }
                }
                Err(e) => warn_relay(r.url(), "presence", &e),
            }
        }
        let hardware = HARDWARE_KEY_STORES.contains(&self.key_store);
        targets
            .iter()
            .filter(|t| allowed.iter().any(|a| a == "*" || a == *t))
            .filter(|t| seen.get(*t).is_some_and(|at| now - at <= PRESENT_MS))
            .filter(|t| self.spoke(t).is_ok_and(|(c, _)| hardware || crate::spokes_api::task_class(c.classification.as_deref()) != "cui"))
            .cloned()
            .collect()
    }

    /// 5.5, 7.2.3: a held submit on the first present target that takes it. The spoke holds the task (no lane) until a
    /// person approves its `task.start` ask.
    pub fn submit(&self, s: &Submit) -> Result<HubTask, SubmitError> {
        let invalid = |m: &str| SubmitError::Hub(HubError::Invalid(m.to_owned()));
        if !(HOLD_MIN_S..=HOLD_MAX_S).contains(&s.within_s) {
            return Err(invalid("within_s must be 300 to 86400"));
        }
        if task_name(&s.name).as_deref() != Some(s.name.as_str()) {
            return Err(invalid("the task name must be 1 to 48 letters, digits, spaces, dot, dash or underscore"));
        }
        if s.text.trim().is_empty() || utf16_len(&s.text) > MAX_TEXT {
            return Err(invalid("text must be 1 to 32000 characters"));
        }
        self.usable().map_err(SubmitError::Hub)?;
        let allowed = self.registration().map_err(SubmitError::Hub)?;
        let mut args = json!({ "text": s.text, "name": s.name, "hold": { "within_s": s.within_s } });
        if let Some(m) = &s.model {
            args["model"] = Value::from(m.as_str());
        }
        let mut outcome = Rejected::NoSpoke;
        for spoke in self.candidates(&s.targets, &allowed) {
            match self.request(&spoke, Op::Submit, &args) {
                Ok(r) if r.ok => {
                    // `take` made and sealed the task from this reply before the reply was acknowledged
                    let Some(t) = str_of(r.data.get("task")).and_then(|id| self.task(id)) else {
                        log_warn(&format!("connector_spokes_submit_malformed spoke={spoke}"));
                        continue;
                    };
                    self.apply_early(&t.id);
                    log_info(&format!("connector_spokes_submitted task={} spoke={spoke} name={}", t.id, s.name));
                    return Ok(self.task(&t.id).unwrap_or(t));
                }
                Ok(r) => {
                    let why = r.error.unwrap_or_default();
                    log_info(&format!("connector_spokes_submit_refused spoke={spoke} reason={why}"));
                    outcome = if why == OWNER_PAUSED { Rejected::Paused } else { Rejected::CannotRun };
                }
                Err(e) => log_warn(&format!("connector_spokes_submit_failed spoke={spoke} error={e}")),
            }
        }
        Err(SubmitError::Rejected(outcome))
    }

    /// 5.5 (R6-3): a follow-up on its own idle task, which the spoke holds as a `task.turn` ask. While the task works
    /// or waits on any ask it is `Busy` and nothing is sent.
    pub fn followup(&self, task: &str, text: &str) -> Result<HubTask, HubError> {
        let t = self.own(task)?;
        if t.state != "idle" || t.awaiting.is_some() {
            return Err(HubError::Busy);
        }
        if text.trim().is_empty() || utf16_len(text) > MAX_TEXT {
            return Err(HubError::Invalid("text must be 1 to 32000 characters".into()));
        }
        // every op's reply is applied to the book by `take`, sealed with its batch before it is acknowledged
        self.call(&t.spoke, Op::Followup, &json!({ "task": task, "text": text }))?;
        self.own(task)
    }

    /// Cancel its own task (a held one closes, `canceled`).
    pub fn cancel(&self, task: &str) -> Result<HubTask, HubError> {
        let t = self.own(task)?;
        self.call(&t.spoke, Op::Cancel, &json!({ "task": task }))?;
        self.own(task)
    }

    /// Close its own task (its lane ends and its slot is freed).
    pub fn close(&self, task: &str) -> Result<HubTask, HubError> {
        let t = self.own(task)?;
        self.call(&t.spoke, Op::Close, &json!({ "task": task }))?;
        self.own(task)
    }

    /// Deny an ask on its own task (unsigned; refusing is always safe).
    pub fn deny(&self, task: &str, ask: &str) -> Result<HubTask, HubError> {
        let t = self.own(task)?;
        self.call(&t.spoke, Op::Deny, &json!({ "task": task, "ask": ask }))?;
        self.own(task)
    }

    /// `status` of its own task: the spoke's view taken into the book.
    pub fn status(&self, task: &str) -> Result<HubTask, HubError> {
        let t = self.own(task)?;
        let data = self.call(&t.spoke, Op::Status, &json!({ "task": task }))?;
        match self.status_view(task, &data) {
            Some(_) => self.own(task),
            None => Err(HubError::Refused(NOT_OWN.to_string())),
        }
    }

    /// A `status` reply's view of `task`, when it is this hub's own.
    fn status_view(&self, task: &str, data: &Value) -> Option<Value> {
        let v = data.get("tasks")?.as_array()?.iter().find(|v| str_of(v.get("id")) == Some(task))?;
        (str_of(v.get("origin")) == Some(self.me.node.as_str())).then(|| v.clone())
    }

    /// A submit's reply (`{task, state, awaiting, ask}`) as a task of the book; None when it names none, or the book
    /// has it already.
    fn create_task(&self, r: &Outstanding, data: &Value, now: i64) -> Option<HubTask> {
        let id = str_of(data.get("task")).filter(|t| task_id_ok(t))?.to_owned();
        let mut book = self.book.lock();
        if book.contains_key(&id) {
            return None;
        }
        let mut t = HubTask {
            id: id.clone(),
            spoke: r.spoke.clone(),
            name: r.name.clone(),
            state: "awaiting_approval".into(),
            awaiting: Some("task.start".into()),
            ask: None,
            turns: 0,
            journal_head: 0,
            reason: None,
            created_ms: now,
            updated_ms: now,
        };
        t.take_view(data, now);
        if let Some(ask) = str_of(data.get("ask")) {
            // the digest comes with the spoke's approval note
            t.ask.get_or_insert(PendingAsk { id: ask.to_owned(), kind: "task.start".into(), digest: String::new(), expires_at: now + r.within_s * 1000 });
        }
        book.insert(id, t.clone());
        Some(t)
    }

    /// An op's reply view applied to its own task (a follow-up's held `task.turn` ask kept); Some when it changed.
    fn apply_reply(&self, task: &str, spoke: &str, view: &Value, held: Option<&str>, now: i64) -> Option<HubTask> {
        let mut book = self.book.lock();
        let t = book.get_mut(task).filter(|t| t.spoke == spoke)?;
        let mut changed = t.take_view(view, now);
        if let (Some(kind), Some(ask)) = (held, str_of(view.get("ask"))) {
            if t.ask.as_ref().is_none_or(|a| a.id != ask) {
                t.ask = Some(PendingAsk { id: ask.to_owned(), kind: kind.to_owned(), digest: String::new(), expires_at: 0 });
                t.updated_ms = now;
                changed = true;
            }
        }
        changed.then(|| t.clone())
    }

    /// `hello` to a known spoke: its node, journal head and this hub's own tasks there.
    pub fn hello(&self, spoke: &str) -> Result<Value, HubError> {
        self.call(spoke, Op::Hello, &json!({}))
    }

    /// `approvals` of its own task: the asks it waits on, as the spoke reports them (a held ask with its full `input`,
    /// which this hub sent).
    pub fn approvals(&self, task: &str) -> Result<Vec<Value>, HubError> {
        let t = self.own(task)?;
        let data = self.call(&t.spoke, Op::Approvals, &json!({ "task": task }))?;
        Ok(data.get("approvals").and_then(Value::as_array).into_iter().flatten().filter(|a| str_of(a.get("task")) == Some(task)).cloned().collect())
    }

    /// `recall {since, task}` of its own task: the journal page, every entry verified against the spoke's certified key
    /// (hub.ts `recall`).
    pub fn recall(&self, task: &str, since: i64) -> Result<RecallPage, HubError> {
        let t = self.own(task)?;
        if since < 0 {
            return Err(HubError::Invalid("since must be a non-negative integer".into()));
        }
        let (_, key) = self.spoke(&t.spoke)?;
        let data = self.call(&t.spoke, Op::Recall, &json!({ "since": since, "task": task }))?;
        let list = data.get("entries").and_then(Value::as_array).ok_or_else(|| HubError::Refused("recall reply is malformed".into()))?;
        let entries = list.iter().map(JournalEntry::parse).collect::<Option<Vec<_>>>().ok_or_else(|| HubError::Refused("recall returned a malformed journal entry".into()))?;
        verify_run(&entries, &key).map_err(|e| HubError::Refused(format!("journal from {} failed verification: {e}", t.spoke)))?;
        if entries.iter().any(|e| e.task != task) {
            return Err(HubError::Refused("recall returned another task's entries".into()));
        }
        Ok(RecallPage { entries, head: data.get("head").and_then(Value::as_i64).unwrap_or(0), more: data.get("more") == Some(&Value::Bool(true)) })
    }

    // ── the inbox loop (7.2.3) ──────────────────────────────────────────────────────────────────────────────

    /// The loop on its own thread: the trust refresh when due, the inbox, then a wait of POLL_OPEN while a task is
    /// open or a request waits, POLL_IDLE otherwise (a request wakes it at once).
    pub fn run(&self) {
        self.looping.store(true, Ordering::SeqCst);
        loop {
            let now = self.now();
            let due = { now - *self.trust_at.lock() >= TRUST_EVERY_MS };
            if due {
                *self.trust_at.lock() = now;
                self.refresh_trust();
            }
            // a stopped hub reads no inbox and acknowledges nothing: the loop ends (waiting calls time out)
            if let Some(why) = self.stopped() {
                log_error(&format!("connector_spokes_hub_loop_ended reason={why}"));
                self.looping.store(false, Ordering::SeqCst);
                return;
            }
            self.poll_once();
            let busy = self.waiting.load(Ordering::SeqCst) > 0 || self.book.lock().values().any(HubTask::open);
            let (lock, cv) = &self.wake;
            let mut woken = lock.lock();
            if !*woken {
                cv.wait_for(&mut woken, if busy { POLL_OPEN } else { POLL_IDLE });
            }
            *woken = false;
        }
    }

    /// One pass over every API relay's inbox: each batch opened, its book and request table changes sealed and fsynced,
    /// then acknowledged (handled, refused or unreadable alike: none comes back), again while the relay says `more`.
    /// When the replay guard cannot keep an id, or the book cannot be sealed, nothing of the batch is acknowledged and
    /// its ids are forgotten again, so it opens again when it comes back; the pass ends there. A stopped hub reads
    /// nothing. Ok is the number of envelopes acknowledged. Then the late submits' cancels that are due are sent.
    pub fn poll_once(&self) -> usize {
        let _g = self.poll_lock.lock();
        if self.stopped().is_some() {
            return 0;
        }
        let mut taken = 0;
        'relays: for r in self.relays_now() {
            loop {
                let now = self.now();
                let (envs, more) = match r.inbox(now) {
                    Ok(x) => x,
                    Err(e) => {
                        warn_relay(r.url(), "inbox", &e);
                        break;
                    }
                };
                let (mut changed, mut dirty, mut opened, mut halted) = (Vec::new(), false, Vec::new(), None);
                for env in &envs {
                    match self.take(env, now) {
                        Taken::Nothing => {}
                        Taken::Dirty => dirty = true,
                        Taken::Task(t, ask) => {
                            dirty = true;
                            changed.push((t, ask));
                        }
                        Taken::Unavailable(e) => {
                            halted = Some(e);
                            break;
                        }
                    }
                    opened.push(env.id.clone());
                }
                let unsaved = if dirty { self.save().err() } else { None };
                if unsaved.is_none() {
                    // what was taken is sealed: the hook hears it even when the batch stays unacknowledged (taken
                    // again, it changes nothing)
                    if let Some(ev) = self.events.get() {
                        for (t, ask) in &changed {
                            match ask {
                                Some(a) => ev.approval_asked(t, a),
                                None => ev.task_changed(t),
                            }
                        }
                    }
                }
                if let Some(why) = unsaved.or(halted) {
                    log_error(&format!("connector_spokes_batch_unacknowledged relay={} error={why}", r.url()));
                    if let Err(e) = self.replay.lock().forget(&opened) {
                        log_error(&format!("connector_spokes_replay_unforgotten error={e}"));
                    }
                    break 'relays;
                }
                if let Err(e) = r.ack(&opened, now) {
                    warn_relay(r.url(), "ack", &e);
                    break;
                }
                taken += opened.len();
                if !(more && !envs.is_empty()) {
                    break;
                }
            }
        }
        self.retry_cancels();
        let dropped = self.unknown.swap(0, Ordering::SeqCst);
        if dropped > 0 {
            log_warn(&format!("connector_spokes_unknown_dropped count={dropped} (spokes without a certificate on this connector)"));
        }
        taken
    }

    /// One envelope: replies taken by request id (`answered`), notes and asks on its own tasks taken into the book.
    /// Only spokes with a held certificate are heard (RS-FLOOD-01).
    fn take(&self, env: &crate::connector_spokes_wire::Envelope, now: i64) -> Taken {
        let known = self.spokes.read().get(&env.from).cloned();
        let Some(known) = known else {
            self.unknown.fetch_add(1, Ordering::SeqCst);
            return Taken::Nothing;
        };
        let opened = {
            let trust = self.trust.read();
            let mut replay = self.replay.lock();
            open(&self.key, &trust, env, &["spoke"], &mut replay, now)
        };
        let o = match opened {
            Ok(o) => o,
            Err(OpenError::Unavailable(e)) => return Taken::Unavailable(e),
            Err(OpenError::Refused(reason)) => {
                log_warn(&format!("connector_spokes_envelope_refused from={} reason={reason}", env.from));
                return Taken::Nothing;
            }
        };
        // a spoke that installed a renewed certificate speaks with it: keep the one that lasts longer
        if known != env.cert {
            let held = self.trust.read().verify_cert(Some(&Value::String(known)), now.div_euclid(1000));
            if held.map_or(true, |h| h.cert.exp < o.from.exp) {
                let path = self.dir.join(SPOKES_DIR).join(format!("{}.cert", o.from.node));
                match write_private(&path, format!("{}\n", env.cert).as_bytes()) {
                    Ok(()) => {
                        self.spokes.write().insert(o.from.node.clone(), env.cert.clone());
                    }
                    Err(e) => log_warn(&format!("connector_spokes_cert_unsaved spoke={} error={e}", o.from.node)),
                }
            }
        }
        let Some(m) = object_of(&o.plaintext) else { return Taken::Nothing };
        let changed = match str_of(m.get("t")) {
            Some("res") => {
                return match str_of(m.get("rid")) {
                    Some(rid) => self.answered(&o.from.node, rid, Reply::of(&m), now),
                    None => Taken::Nothing,
                };
            }
            Some(kind @ ("note" | "approval")) => {
                let Some(id) = str_of(m.get("task")) else { return Taken::Nothing };
                if !self.book.lock().contains_key(id) {
                    // a note on a task whose submit is not recorded yet
                    let mut early = self.early.lock();
                    if early.len() >= EARLY_MAX {
                        early.remove(0);
                    }
                    early.push((o.from.node.clone(), m));
                    return Taken::Nothing;
                }
                if kind == "note" {
                    self.note(&o.from.node, &m, now)
                } else {
                    self.asked(&o.from.node, &m, now)
                }
            }
            Some("alert") => {
                log_warn(&format!("connector_spokes_alert spoke={} kind={}", o.from.node, str_of(m.get("kind")).unwrap_or("?")));
                None
            }
            _ => None,
        };
        changed.map_or(Taken::Nothing, |(t, ask)| Taken::Task(t, ask))
    }

    /// A spoke's reply to request `rid`, under the request table's lock throughout (lock order: `requests`, `book`,
    /// `replies`), so a waiting caller's `give_up` sees either the reply or the record:
    /// - a waited request: its record leaves the table, its effect is put in the book (a submit's reply makes the task;
    ///   any other op's reply view is applied to its own task), then the reply is filed for the caller. The batch seals
    ///   the book and the table before it is acknowledged.
    /// - a cancel-required submit: the task its reply made is noted, and `retry_cancels` cancels it; a refused one leaves.
    /// - the reply to such a cancel: confirmed (done, or the task is unknown or closed), the record leaves; else the
    ///   cancel is sent again.
    fn answered(&self, from: &str, rid: &str, reply: Reply, now: i64) -> Taken {
        let mut reqs = self.requests.lock();
        if let Some(r) = reqs.get(rid).cloned().filter(|r| r.spoke == from) {
            if !r.cancel {
                reqs.remove(rid);
                let changed = if !reply.ok {
                    None
                } else {
                    match r.op {
                        Op::Submit => self.create_task(&r, &reply.data, now),
                        Op::Status => r.task.as_deref().and_then(|t| self.status_view(t, &reply.data).and_then(|v| self.apply_reply(t, from, &v, None, now))),
                        Op::Followup | Op::Cancel | Op::Close | Op::Deny => {
                            r.task.as_deref().and_then(|t| self.apply_reply(t, from, &reply.data, (r.op == Op::Followup).then_some("task.turn"), now))
                        }
                        Op::Hello | Op::Recall | Op::Approvals => None,
                    }
                };
                self.replies.lock().insert(rid.to_owned(), reply);
                self.replied.notify_all();
                return match changed {
                    Some(t) => Taken::Task(t, None),
                    None if r.op == Op::Submit => Taken::Dirty,
                    None => Taken::Nothing,
                };
            }
            let made = str_of(reply.data.get("task")).filter(|t| reply.ok && task_id_ok(t));
            return match (made, &r.task) {
                (Some(task), None) => {
                    log_warn(&format!("connector_spokes_late_submit spoke={from} task={task} (to be canceled)"));
                    if let Some(x) = reqs.get_mut(rid) {
                        x.task = Some(task.to_owned());
                    }
                    Taken::Dirty
                }
                (None, None) => {
                    reqs.remove(rid);
                    Taken::Dirty
                }
                _ => Taken::Nothing,
            };
        }
        let Some(sub) = reqs.iter().find(|(_, r)| r.cancel_rid.as_deref() == Some(rid) && r.spoke == from).map(|(k, _)| k.clone()) else { return Taken::Nothing };
        let gone = reply.error.as_deref().is_some_and(|e| e == NOT_OWN || e.starts_with("the task is closed"));
        if reply.ok || gone {
            if let Some(r) = reqs.remove(&sub) {
                log_info(&format!("connector_spokes_late_cancel_confirmed spoke={from} task={}", r.task.unwrap_or_default()));
            }
        } else if let Some(x) = reqs.get_mut(&sub) {
            log_warn(&format!("connector_spokes_late_cancel_refused spoke={from} reason={} (sent again)", reply.error.as_deref().unwrap_or("refused")));
            x.cancel_rid = None;
        }
        Taken::Dirty
    }

    /// The notes and asks that came for `task` before its submit was recorded, taken now (from its own spoke only).
    fn apply_early(&self, task: &str) {
        let mine: Vec<(String, Map<String, Value>)> = {
            let mut early = self.early.lock();
            let (mine, rest) = std::mem::take(&mut *early).into_iter().partition(|(_, m)| str_of(m.get("task")) == Some(task));
            *early = rest;
            mine
        };
        let now = self.now();
        let mut changed = Vec::new();
        for (spoke, m) in &mine {
            let r = if str_of(m.get("t")) == Some("approval") { self.asked(spoke, m, now) } else { self.note(spoke, m, now) };
            changed.extend(r);
        }
        if changed.is_empty() {
            return;
        }
        if let Err(e) = self.save() {
            log_error(&format!("connector_spokes_book_unsaved error={e}"));
        }
        if let Some(ev) = self.events.get() {
            for (t, ask) in &changed {
                match ask {
                    Some(a) => ev.approval_asked(t, a),
                    None => ev.task_changed(t),
                }
            }
        }
    }

    /// Cancel-required submits (sealed, so after a restart too): the task each one's late reply made is canceled (held,
    /// so it closes), sent again every CANCEL_RETRY_MS until a reply confirms it (`answered`), never left running. One
    /// whose reply never came leaves after CANCEL_GIVE_UP_MS (the relays' mail TTL is over).
    fn retry_cancels(&self) {
        if self.stopped().is_some() {
            return;
        }
        let now = self.now();
        let (due, mut dirty) = {
            let mut reqs = self.requests.lock();
            let before = reqs.len();
            reqs.retain(|_, r| !(r.cancel && r.task.is_none() && now - r.at > CANCEL_GIVE_UP_MS));
            let due: Vec<(String, String, String)> = reqs
                .iter()
                // never sent, or the last one is CANCEL_RETRY_MS old (unanswered or refused)
                .filter(|(_, r)| r.cancel && (r.cancel_at == 0 || now - r.cancel_at >= CANCEL_RETRY_MS))
                .filter_map(|(rid, r)| Some((rid.clone(), r.spoke.clone(), r.task.clone()?)))
                .collect();
            (due, reqs.len() != before)
        };
        for (rid, spoke, task) in due {
            let sent = random_hex(8).map_err(HubError::Unavailable).and_then(|crid| {
                let (_, key) = self.spoke(&spoke)?;
                self.send_sealed(&spoke, &key, &crid, Op::Cancel, &json!({ "task": task }), now).map(|()| crid)
            });
            match sent {
                Ok(crid) => {
                    log_warn(&format!("connector_spokes_late_cancel_sent spoke={spoke} task={task}"));
                    if let Some(r) = self.requests.lock().get_mut(&rid) {
                        r.cancel_rid = Some(crid);
                        r.cancel_at = now;
                        dirty = true;
                    }
                }
                Err(e) => log_error(&format!("connector_spokes_late_cancel_failed spoke={spoke} task={task} error={e} (tried again)")),
            }
        }
        if dirty {
            if let Err(e) = self.save() {
                log_error(&format!("connector_spokes_book_unsaved error={e}"));
            }
        }
    }

    /// `{t: "note", task, name, state, awaiting?, journalHead}` on its own task.
    fn note(&self, spoke: &str, m: &Map<String, Value>, now: i64) -> Option<(HubTask, Option<Value>)> {
        let id = str_of(m.get("task"))?;
        let mut book = self.book.lock();
        let t = book.get_mut(id).filter(|t| t.spoke == spoke)?;
        t.take_view(&Value::Object(m.clone()), now).then(|| (t.clone(), None))
    }

    /// `{t: "approval", task, name, lane, ask}` on its own task: the pending ask kept (its id, kind, digest and end;
    /// never its text), and handed on with the ask as sent.
    fn asked(&self, spoke: &str, m: &Map<String, Value>, now: i64) -> Option<(HubTask, Option<Value>)> {
        let id = str_of(m.get("task"))?;
        let ask = m.get("ask")?;
        let pending = PendingAsk {
            id: str_of(ask.get("id"))?.to_owned(),
            kind: str_of(ask.get("kind"))?.to_owned(),
            digest: str_of(ask.get("digest")).unwrap_or_default().to_owned(),
            expires_at: ask.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
        };
        let mut book = self.book.lock();
        let t = book.get_mut(id).filter(|t| t.spoke == spoke)?;
        t.state = "awaiting_approval".into();
        if matches!(pending.kind.as_str(), "task.start" | "task.turn") {
            t.awaiting = Some(pending.kind.clone());
        } else if t.awaiting.is_none() {
            t.awaiting = Some("approval".into());
        }
        t.ask = Some(pending);
        t.updated_ms = now;
        Some((t.clone(), Some(ask.clone())))
    }

    /// The hub stops acting for good (until a restart): no op is sent, no inbox is read or acknowledged.
    fn stop(&self, why: String) {
        log_error(&format!("connector_spokes_hub_stopped reason={why}"));
        *self.stopped.write() = Some(why);
    }

    /// Why this hub's own certificate no longer holds under the trust and directory held now (revoked, expired past
    /// the directory's grace, or not a service hub's under 5.2), or None.
    fn check_self(&self, now_s: i64) -> Option<String> {
        let domains = self.directory.read().org_domains();
        let verified = self.trust.read().verify_cert(Some(&Value::String(self.cert.clone())), now_s);
        match verified {
            Err(e) => Some(format!("this service hub's certificate: {e}")),
            Ok(c) => identity_problem(&c.cert, &self.key, domains.as_deref()),
        }
    }

    /// Every TRUST_EVERY_MS: the newest CRL bundle and relay directory from the API relays. Each newer one is written
    /// (fsynced) before it is used; one that cannot be written stops the hub (fail closed: it would otherwise run on
    /// what a restart forgets). Then this hub's own certificate is checked again under what is held now: revoked,
    /// expired or no longer a service hub's, the hub stops.
    pub fn refresh_trust(&self) {
        let now = self.now();
        let now_s = now.div_euclid(1000);
        let relays = self.relays_now();
        for r in &relays {
            match r.bundle(now) {
                Ok(Some(b)) => {
                    let mut staged = self.trust.read().clone();
                    match staged.accept_bundle(&b) {
                        Ok(true) => {
                            let mut o = Map::new();
                            o.insert("crl".into(), Value::from(b.crl.as_str()));
                            for (k, t) in &b.items {
                                o.insert((*k).to_owned(), Value::from(t.as_str()));
                            }
                            let path = self.dir.join(BUNDLE_FILE);
                            if let Err(e) = write_private(&path, stringify(&Value::Object(o)).as_bytes()) {
                                return self.stop(format!("a newer revocation list could not be saved ({e})"));
                            }
                            *self.trust.write() = staged;
                        }
                        Ok(false) => {}
                        Err(refusal) => log_warn(&format!("connector_spokes_bundle_refused relay={} reason={}", r.url(), refusal.reason)),
                    }
                }
                Ok(None) => {}
                Err(e) => warn_relay(r.url(), "crl", &e),
            }
        }
        let mut changed = false;
        for r in &relays {
            match r.directory(now) {
                Ok(Some(token)) => {
                    // DirectoryHolder is not Clone: a fresh holder takes the token, and only a newer version is used
                    let held = self.directory.read().version();
                    let mut staged = DirectoryHolder::default();
                    let accepted = staged.accept(&self.trust.read(), &token, now_s);
                    match accepted {
                        Ok(_) if staged.version() > held => {
                            if let Err(e) = write_private(&self.directory_file, format!("{token}\n").as_bytes()) {
                                return self.stop(format!("a newer relay directory could not be saved ({e})"));
                            }
                            *self.directory.write() = staged;
                            changed = true;
                        }
                        Ok(_) => {}
                        Err(e) => log_warn(&format!("connector_spokes_directory_refused relay={} reason={e}", r.url())),
                    }
                }
                Ok(None) => {}
                Err(e) => warn_relay(r.url(), "directory", &e),
            }
        }
        if changed {
            let grace = self.directory.read().cert_grace_hours();
            self.trust.write().set_cert_grace_hours(grace);
            // a newer directory may pin other keys for a url: clients are made again from it on next use
            self.relays.write().clear();
        }
        if let Some(problem) = self.check_self(now_s) {
            self.stop(problem);
        }
    }
}
