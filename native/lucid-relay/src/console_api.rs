// Contract API-1 (docs/api/contract.md) 2.4, 2.5, 2.6 and 3.4, the console end: the org api maps the console holds
// (`<state>/api-console/`, an `ApiMapStore`), the per-org tightening journal (`<state>/api-journal-console/<org>.jsonl`,
// append-only and flushed after every entry, rewritten only when acknowledged and folded entries are pruned;
// `<org>.acks.json` keeps the pruned base, per relay the acknowledged tseq and pseudonym key version, and the key's
// version and start), each org's pseudonym key (32 random bytes, sealed), the relays' api heads (`api-heads`, asked
// first after `welcome`; an older relay answers `fleet-op` and gets no api op until it reconnects), the reconnect
// catch-up (key, then map, then journal entries strictly in order, before any other request), and the console-wide
// relay grace of the fleet verifier (3.4).
//
// 5.1 to 5.5, the front door's issuer: each org's issuer signing key (P-256, sealed as `api-issuer-<org>-<kid>`, used
// only while the pinned map lists it), the public documents, and the token and revocation endpoints (`api_issue`) run
// on a snapshot of the org's store with the front door's limiters, jti caches and fetch cache.

use crate::api_audit::{ApiAudit, IngestError, Repr};
use crate::api_checkpoint::IssueFn;
use crate::api_cjournal::{ConsoleEntry, ConsoleJournals};
use crate::api_features::{RelaySets, Report};
use crate::api_idempotency::IdemStore;
use crate::api_fetch::FetchCache;
use crate::api_issue::{self, Answer, IssueCtx, IssueState, TokenHttp};
use crate::api_map::{check_tighten, AcceptOutcome, ApiMapError, ApiMapStore, ApiTrust, Edition, VerifiedApiMap};
use crate::codec::{b64u, parse_json, stringify};
use crate::console_fleet::{FleetLink, LinkError};
use crate::fleet_ca::{vault_do, NoVault, Vault, VaultLock};
use crate::log::{Fields, Level, Logger};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

/// The console's own map store, under its state folder.
const STORE_DIR: &str = "api-console";
/// The console's journals and acknowledgments.
pub const JOURNAL_DIR: &str = "api-journal-console";
/// The pseudonym key version the console draws (one key per org in this slice).
pub const PSEUDONYM_PKV: u64 = 1;
/// One api request's answer wait.
const CALL_MS: u64 = 30_000;
/// 12.2: at most this many `api-chains` pages per org in one run, so other api ops to the relay wait at most that
/// long; `audit_tick` resumes a backfill that has more.
const PAGES_MAX: usize = 64;
/// 9.3: a connected relay's checkpoint certificates are checked this often (seconds) after its catch-up; it asks for
/// a new one when under 30 days are left.
const CHECKPOINT_EVERY: i64 = 3600;
/// 4.2: a client's `jwks_uri` and a federated issuer's discovery and keys are fetched at most hourly.
const FETCH_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// A public document of the front door (5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiDoc {
    /// RFC 8414 `/.well-known/oauth-authorization-server/api/orgs/<org>`.
    AuthorizationServer,
    /// RFC 9728 `/.well-known/oauth-protected-resource/api/orgs/<org>`.
    ProtectedResource,
    /// `I/jwks.json`: the map's `issuer.jwks`.
    Jwks,
    /// Revision 4 8.1 `I/federation/.well-known/openid-configuration`, only when `federation.issuer` is `I/federation`.
    FederationDiscovery,
    /// Revision 4 8.1 `I/federation/jwks.json`, the same rule; dropped keys left out.
    FederationJwks,
    /// Revision 4 7.3 `I/v1/webhooks/keys`: the map's `webhook_keys`, dropped keys left out.
    WebhookKeys,
    /// Revision 5 4.4: RFC 9728 `/.well-known/oauth-protected-resource/api/orgs/<org>/mcp` (resource M).
    McpResource,
}

/// The sealed name of an org's issuer signing key (PKCS#8).
fn issuer_seal_name(org: &str, kid: &str) -> String {
    format!("api-issuer-{org}-{kid}")
}

/// The console's sealed store, reached without keeping the console alive.
pub struct ConsoleVault(pub Weak<crate::console::Console>);

impl VaultLock for ConsoleVault {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault)) {
        match self.0.upgrade() {
            Some(c) => VaultLock::with_vault(&*c, f),
            None => f(&mut NoVault),
        }
    }
}

/// One org's journal on the console.
#[derive(Default)]
struct OrgJournal {
    /// The tseq of the last pruned entry (0: none pruned).
    base: u64,
    /// The entries kept, in tseq order (entry `i` has tseq `base + i + 1`).
    entries: Vec<Value>,
    /// relay -> acknowledged tseq, for every relay that reported the org.
    acks: BTreeMap<String, u64>,
    /// relay -> acknowledged pseudonym key version.
    keys: BTreeMap<String, u64>,
    /// (pkv, not_before) of the org's sealed pseudonym key.
    key: Option<(u64, i64)>,
    /// The `kid` of the newest issuer signing key drawn for the org (sealed as `api-issuer-<org>-<kid>`).
    issuer_kid: Option<String>,
}

impl OrgJournal {
    fn head(&self) -> u64 {
        self.base + self.entries.len() as u64
    }
}

/// What the console knows of a connected relay's api state.
enum RelayApi {
    /// Welcomed; `api-heads` not asked yet.
    Unknown,
    /// An older relay (`api-heads` answered `fleet-op`): no api op until it reconnects.
    NoApi,
    /// org -> (pinned seq, applied tseq), from `api-heads` and the answers since.
    Heads(BTreeMap<String, (i64, u64)>),
}

struct Inner {
    store: ApiMapStore,
    orgs: BTreeMap<String, OrgJournal>,
    relays: HashMap<String, RelayApi>,
    /// Relays that answered `fleet-op` to an audit op (`api-checkpoint-csr`, `api-chains`): none until they reconnect.
    no_audit: std::collections::HashSet<String>,
    /// relay -> when its checkpoint certificates are checked next (set by its catch-up, then hourly; `audit_tick`).
    checkpoint_at: HashMap<String, i64>,
    /// (relay, org) whose `api-chains` backfill stopped after `PAGES_MAX` pages with more left. The position is the
    /// console's stored heads of that relay's chains (on disk), so only the pair is kept; `audit_tick` resumes it.
    backfill: std::collections::BTreeSet<(String, String)>,
    /// Revision 4 7.3: (relay, org) whose `api-event-chains` backfill has more left, as `backfill`.
    ev_backfill: std::collections::BTreeSet<(String, String)>,
    /// Relays that answered `fleet-op` to `api-event-chains` (revision 3): no event backfill until they reconnect.
    no_events: std::collections::HashSet<String>,
    /// Relays whose audit work runs on a thread now.
    audit_busy: std::collections::HashSet<String>,
    /// 13: the license edition the maps were last held to (`set_edition`); None until first read.
    edition: Option<Option<Edition>>,
    /// 2.5, 12.2: relays whose last `sync` did not fully succeed (or whose `api-synced` was refused); `sync_tick`
    /// tries them again.
    unsynced: std::collections::HashSet<String>,
    /// Relays a `sync_tick` thread works on now.
    sync_busy: std::collections::HashSet<String>,
    /// Revision 4 2.3 item 2: every relay that ever reported each org, with its latest `api-features` answer.
    sets: RelaySets,
    /// Revision 4 2.3 item 4: the console journals (console-only and connector-relevant actions).
    cj: ConsoleJournals,
    /// Revision 4 2.3 item 5: (relay, org) whose pinned map the relay cannot take (it lacks a need of the map); its
    /// catch-up holds it to the seq it has.
    withheld: std::collections::HashSet<(String, String)>,
}

/// The console's api maps, journals and pseudonym keys, and their delivery to the relays (2.4, 2.5, 2.6).
pub struct ConsoleApi {
    dir: Option<PathBuf>,
    logger: Arc<Logger>,
    vault: Arc<dyn VaultLock>,
    inner: Mutex<Inner>,
    /// One delivery at a time per relay, so entries reach it strictly in order.
    sending: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The front door's issuer state (6.5 limiters and jti caches) and its 8.1 fetch cache.
    issue: IssueState,
    fetch: FetchCache,
    /// 9: the console's API audit chains and the issuer of relay checkpoint certificates (`set_audit`, at start).
    audit: std::sync::OnceLock<(Arc<ApiAudit>, IssueFn)>,
    /// Revision 4 7.3: the console's event chains and feed index (`set_events`, at start).
    events: std::sync::OnceLock<Arc<crate::api_events::EventLog>>,
    /// 11: told when the destinations may have changed (None: a map, a tightening or the edition; Some((org, id)):
    /// that destination's credential), so the export engine applies it at once (`set_export_hook`, at start).
    export_hook: std::sync::OnceLock<ExportHook>,
    /// 12.3: the failover credential records, (org, destination, relay) -> record, kept in `FAILOVER_FILE`.
    failover: Mutex<BTreeMap<(String, String, String), FailoverRecord>>,
    /// Revision 4 4.5: the front door's `Idempotency-Key` store.
    idem: IdemStore,
    /// Revision 5 6: the delegated grants' state (waiting sign-ins, codes, person records, refresh families).
    delegated: crate::api_delegated::DelegatedState,
    /// Revision 5 6.5 step 2: per org and registry provider, the SSO service's public URL (`api-sso-urls.json`).
    sso_urls: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    /// Revision 5 14.1: (org, issuer) -> the last IdP test's time and key count (memory only).
    idp_tests: Mutex<BTreeMap<(String, String), (i64, usize)>>,
    /// API-1d 2.4, 5.1: spokes relay -> its bound record (`api-spokes-bound.json`).
    spokes: Mutex<BTreeMap<String, SpokesBound>>,
    /// API-1d 7.1, 7.13: the signed Agent Cards served now and the partner card checks (`console_a2a`).
    pub(crate) a2a: crate::console_a2a::A2aState,
}

/// API-1d 2.4, 5.1: the console's record of one spokes relay: the orgs bound to it, the binding generation of that list
/// (raised by every change and never lowered, so the relay refuses a replayed older list), and the orgs whose pinned
/// Meet org CA root this generation releases (kept until the relay acknowledges the generation that carries them).
#[derive(Clone, Debug, Default, PartialEq)]
struct SpokesBound {
    orgs: Vec<String>,
    generation: u64,
    release_roots: Vec<String>,
}

impl SpokesBound {
    fn of(v: &Value) -> SpokesBound {
        let ids = |k: &str| -> Vec<String> { v.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|o| org_ok(o)).map(str::to_string).collect() };
        SpokesBound { orgs: ids("orgs"), generation: v.get("generation").and_then(Value::as_u64).unwrap_or(0), release_roots: ids("release_roots") }
    }

    fn to_value(&self) -> Value {
        json!({ "orgs": self.orgs, "generation": self.generation, "release_roots": self.release_roots })
    }

    /// The `api-orgs` body: the list under its generation, with `release_roots` when there are any.
    fn body(&self) -> Value {
        let mut body = json!({ "orgs": self.orgs, "generation": self.generation });
        if !self.release_roots.is_empty() {
            body["release_roots"] = json!(self.release_roots);
        }
        body
    }
}

/// Revision 5 6.5: the SSO services' public URLs the console sends browsers to.
const SSO_URLS_FILE: &str = "api-sso-urls.json";
/// Revision 5 6.1: the newest root-verified signer policy each org's maps were published under (its registry).
const SIGNER_DIR: &str = "api-signer";
/// API-1d 2.4, 5.1: per spokes relay its bound record, `{"relays": {relay: {"orgs": [org, ...], "generation": n,
/// "release_roots": [org, ...]}}}`, flushed before it is relied on. A relay with a record is a spokes relay to the API
/// sync (only spokes relays are ever bound).
const SPOKES_BOUND_FILE: &str = "api-spokes-bound.json";
/// API-1d 2.4 `api-orgs`: at most this many orgs per spokes relay.
pub const SPOKES_ORGS_MAX: usize = 64;

/// 12.3: the console's failover credential records (not in the signed map), flushed to disk after every change.
const FAILOVER_FILE: &str = "api-failover-console.json";
/// 12.3: a failover credential lasts at most 90 days.
const FAILOVER_MAX_S: i64 = 90 * 86_400;
/// 12.3: renewal is asked for this long before `expires`.
const FAILOVER_RENEW_S: i64 = 14 * 86_400;
/// 12.3: what an older relay (`fleet-op` to `api-failover`) leaves the record with.
pub const FAILOVER_TOO_OLD: &str = "This relay is too old to hold a failover credential. Update it, then try again.";

/// One failover credential of a destination on one relay (12.3). No secret: once armed, `type`, `public_id`
/// (the SPKI hash, the token hint `sha256:xxxxxxxx` or `client_email:private_key_id`), `not_before` and `expires`
/// are as the relay answered its install; a pending record has none of them yet.
#[derive(Clone, Debug, PartialEq)]
pub struct FailoverRecord {
    pub org: String,
    pub destination: String,
    pub relay: String,
    pub kind: String,
    pub public_id: String,
    pub not_before: i64,
    pub expires: i64,
    /// `pending`, `armed` or `deleted`.
    pub state: &'static str,
    /// Why it stays pending (an older relay), else empty.
    pub note: String,
}

impl FailoverRecord {
    fn to_json(&self) -> Value {
        json!({ "org": self.org, "destination": self.destination, "relay": self.relay, "type": self.kind, "public_id": self.public_id,
                "not_before": self.not_before, "expires": self.expires, "state": self.state, "note": self.note })
    }

    fn from_json(v: &Value) -> Option<FailoverRecord> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let state = match v.get("state").and_then(Value::as_str)? {
            "pending" => "pending",
            "armed" => "armed",
            "deleted" => "deleted",
            _ => return None,
        };
        Some(FailoverRecord {
            org: s("org")?,
            destination: s("destination")?,
            relay: s("relay")?,
            kind: s("type")?,
            public_id: s("public_id").unwrap_or_default(),
            not_before: v.get("not_before").and_then(Value::as_i64).unwrap_or(0),
            expires: v.get("expires").and_then(Value::as_i64).unwrap_or(0),
            state,
            note: s("note").unwrap_or_default(),
        })
    }
}

/// An attention item of `failover_attention`: `days_left` None once ended.
pub struct FailoverAttention {
    pub org: String,
    /// The destination's name in the pinned map (its id when gone).
    pub destination: String,
    pub relay: String,
    pub days_left: Option<i64>,
}

/// 12.3: the `public_id` a relay answers for installed material whose secret is `secret` (`token`: `sha256:` and the
/// first 8 hex of its SHA-256; `key_json`: `<client_email>:<private_key_id>`; `cert_pem`: the SHA-256 hex of the
/// certificate's SubjectPublicKeyInfo). None when the material does not read.
fn failover_public_id(secret: &str, m: &Map<String, Value>) -> Option<String> {
    let text = |k: &str| m.get(k).and_then(Value::as_str);
    match secret {
        "token" => Some(format!("sha256:{}", &crate::codec::sha256_hex(text("token")?.as_bytes())[..8])),
        "key_json" => {
            let k = parse_json(text("key_json")?)?;
            Some(format!("{}:{}", k.get("client_email")?.as_str()?, k.get("private_key_id")?.as_str()?))
        }
        _ => {
            let der = crate::der::pem_blocks(text("cert_pem")?, "CERTIFICATE").into_iter().next()?;
            Some(crate::codec::sha256_hex(&crate::meet_x509::Cert::from_der(&der)?.spki))
        }
    }
}

/// See `ConsoleApi::set_export_hook`.
pub type ExportHook = Box<dyn Fn(Option<(&str, &str)>) + Send + Sync>;

/// `[a-z0-9-]{1,32}`.
fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn io_e(e: impl std::fmt::Display) -> ApiMapError {
    ApiMapError::new("io", e.to_string())
}

fn u64_map(v: Option<&Value>) -> BTreeMap<String, u64> {
    v.and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n))).collect()
}

fn ids(map: &Map<String, Value>, k: &str) -> Vec<String> {
    map.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

impl ConsoleApi {
    /// The console's api state under `dir` (in memory without one): the map store, every journal (a torn or broken
    /// line ends it), and the store's journal brought up to the journal file after a crash between the two writes.
    pub fn open(dir: Option<&Path>, logger: Arc<Logger>, vault: Arc<dyn VaultLock>) -> ConsoleApi {
        let mut store = ApiMapStore::load(dir.map(|d| d.join(STORE_DIR)).as_deref());
        let mut orgs: BTreeMap<String, OrgJournal> = BTreeMap::new();
        let mut raw: BTreeMap<String, Vec<Option<Value>>> = BTreeMap::new();
        if let Some(entries) = dir.and_then(|d| std::fs::read_dir(d.join(JOURNAL_DIR)).ok()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(org) = name.strip_suffix(".jsonl").filter(|o| org_ok(o)) {
                    let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                    raw.insert(org.to_string(), text.lines().filter(|l| !l.trim().is_empty()).map(parse_json).collect());
                } else if let Some(org) = name.strip_suffix(".acks.json").filter(|o| org_ok(o)) {
                    let v = parse_json(&std::fs::read_to_string(entry.path()).unwrap_or_default()).unwrap_or(Value::Null);
                    let j = orgs.entry(org.to_string()).or_default();
                    j.base = v.get("base").and_then(Value::as_u64).unwrap_or(0);
                    j.acks = u64_map(v.get("tseq"));
                    j.keys = u64_map(v.get("pkv"));
                    j.key = v.get("key").and_then(|k| Some((k.get("pkv")?.as_u64()?, k.get("not_before")?.as_i64()?)));
                    j.issuer_kid = v.get("issuer").and_then(Value::as_str).map(str::to_string);
                }
            }
        }
        for (org, lines) in raw {
            let j = orgs.entry(org.clone()).or_default();
            // the file starts after the pruned base
            if let Some(first) = lines.first().and_then(|l| l.as_ref()).and_then(|e| e.get("tseq")).and_then(Value::as_u64) {
                j.base = j.base.max(first.saturating_sub(1));
            }
            for line in lines {
                // lines a crash left behind a prune
                if line.as_ref().and_then(|e| e.get("tseq")).and_then(Value::as_u64).is_some_and(|t| t <= j.base) {
                    continue;
                }
                match line.filter(|e| check_tighten(e, j.head()).is_ok_and(|t| t.org == org)) {
                    Some(e) => j.entries.push(e),
                    None => {
                        logger.security("api.journal.unreadable", &Fields::new().with("org", org.as_str()).with("tseq", j.head() + 1), Level::Error);
                        break;
                    }
                }
            }
        }
        for (org, j) in &orgs {
            let applied = store.head(org).1;
            for e in j.entries.iter().skip(applied.saturating_sub(j.base) as usize) {
                if e["tseq"].as_u64().unwrap_or(0) <= applied {
                    continue;
                }
                if let Err(e) = store.apply_tighten(org, e) {
                    logger.security("api.journal.store-behind", &Fields::new().with("org", org.as_str()).with("why", e.message), Level::Error);
                    break;
                }
            }
        }
        let sets = RelaySets::load(dir);
        let (mut cj, broken) = ConsoleJournals::load(dir);
        for (org, cseq) in broken {
            logger.security("api.console-journal.unreadable", &Fields::new().with("org", org.as_str()).with("cseq", cseq), Level::Error);
        }
        // a crash between a pin and the console journal's settling: settle against the pinned maps again
        for org in store.issuers().into_keys() {
            if let Some(m) = store.get(&org, "").map(|m| Value::Object(m.map().clone())) {
                if let Err(e) = cj.settle(&org, &m) {
                    logger.security("api.console-journal.unsettled", &Fields::new().with("org", org.as_str()).with("why", e.message), Level::Error);
                }
            }
        }
        // revision 5 6.6: validation reads each org's active `person_revoke` entries from the published copy
        for org in store.issuers().into_keys() {
            crate::api_delegated::publish_revokes(&org, &cj.active(&org));
        }
        let sso_urls = dir
            .and_then(|d| std::fs::read_to_string(d.join(SSO_URLS_FILE)).ok())
            .and_then(|t| parse_json(&t))
            .and_then(|v| v.as_object().cloned())
            .into_iter()
            .flatten()
            .map(|(org, p)| (org, p.as_object().into_iter().flatten().filter_map(|(k, u)| Some((k.clone(), u.as_str()?.to_string()))).collect()))
            .collect();
        let spokes: BTreeMap<String, SpokesBound> = dir
            .and_then(|d| std::fs::read_to_string(d.join(SPOKES_BOUND_FILE)).ok())
            .and_then(|t| parse_json(&t))
            .and_then(|v| v.get("relays").and_then(Value::as_object).cloned())
            .into_iter()
            .flatten()
            .map(|(relay, record)| (relay, SpokesBound::of(&record)))
            .collect();
        ConsoleApi {
            delegated: crate::api_delegated::DelegatedState::new(dir, vault.clone()),
            sso_urls: Mutex::new(sso_urls),
            idp_tests: Mutex::default(),
            spokes: Mutex::new(spokes),
            a2a: crate::console_a2a::A2aState::default(),
            dir: dir.map(Path::to_path_buf),
            logger,
            vault,
            inner: Mutex::new(Inner {
                store,
                orgs,
                relays: HashMap::new(),
                no_audit: Default::default(),
                checkpoint_at: HashMap::new(),
                backfill: Default::default(),
                ev_backfill: Default::default(),
                no_events: Default::default(),
                audit_busy: Default::default(),
                edition: None,
                unsynced: Default::default(),
                sync_busy: Default::default(),
                sets,
                cj,
                withheld: Default::default(),
            }),
            idem: IdemStore::load(dir),
            sending: Mutex::new(HashMap::new()),
            issue: IssueState::new(),
            fetch: FetchCache::new(FETCH_MAX_AGE),
            audit: std::sync::OnceLock::new(),
            events: std::sync::OnceLock::new(),
            export_hook: std::sync::OnceLock::new(),
            failover: Mutex::new(
                dir.and_then(|d| std::fs::read_to_string(d.join(FAILOVER_FILE)).ok())
                    .and_then(|t| parse_json(&t))
                    .and_then(|v| v.get("records").and_then(Value::as_array).cloned())
                    .into_iter()
                    .flatten()
                    .filter_map(|r| FailoverRecord::from_json(&r))
                    .map(|r| ((r.org.clone(), r.destination.clone(), r.relay.clone()), r))
                    .collect(),
            ),
        }
    }

    fn journal_dir(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(JOURNAL_DIR))
    }

    /// Append one entry line to `<org>.jsonl`, owner-only, flushed to disk before Ok.
    fn append_line(&self, org: &str, entry: &Value) -> Result<(), ApiMapError> {
        let Some(dir) = self.journal_dir() else { return Ok(()) };
        crate::store::make_dir(&dir).map_err(io_e)?;
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(dir.join(format!("{org}.jsonl"))).map_err(io_e)?;
        f.write_all(format!("{}\n", stringify(entry)).as_bytes()).map_err(io_e)?;
        f.sync_all().map_err(io_e)?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(&dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    /// `<org>.acks.json`, flushed to disk.
    fn save_acks(&self, org: &str, j: &OrgJournal) -> Result<(), ApiMapError> {
        let Some(dir) = self.journal_dir() else { return Ok(()) };
        crate::store::make_dir(&dir).map_err(io_e)?;
        let key = j.key.map_or(Value::Null, |(pkv, nb)| json!({ "pkv": pkv, "not_before": nb }));
        let v = json!({ "base": j.base, "tseq": j.acks, "pkv": j.keys, "key": key, "issuer": j.issuer_kid });
        crate::fleet_local::write_durable(&dir.join(format!("{org}.acks.json")), stringify(&v).as_bytes()).map_err(io_e)
    }

    // ── maps (2.4) ──

    /// Verify and pin a signed map in the console's store, then send it (`api-map`) to every connected relay of its
    /// org. A conflict raises `api.map.conflict`. Called by the API access screen's save (slice 1a6).
    #[allow(clippy::too_many_arguments)]
    pub fn publish_map(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, signed: &Value, trust: &ApiTrust, now: i64, policy: Option<&Map<String, Value>>, edition: Option<Edition>) -> Result<AcceptOutcome, ApiMapError> {
        let (r, was_off) = {
            let mut inner = self.inner.lock();
            let map = signed.get("map").unwrap_or(&Value::Null);
            let org = map.get("org").and_then(Value::as_str).unwrap_or_default();
            // revision 4 2.3 items 3 and 4: saved only while every relay of the org takes the map, and only folding or
            // clearing console journal entries as revision 3 2.5 allows
            inner.sets.gate(org, &crate::api_features::map_needs(map))?;
            inner.cj.check_map(org, map)?;
            let was_off = inner.store.is_off(org);
            (inner.store.accept(signed, trust, now, policy, edition), was_off)
        };
        // revision 5 6.1: the registry (`iss`, `sso_serial`) of the root-verified signer policy the map was verified with
        if let Ok(AcceptOutcome::Pinned(vm) | AcceptOutcome::Unchanged(vm)) = &r {
            if let Err(e) = self.save_signer_policy(&vm.org, trust.signer_policy) {
                self.logger.security("api.signer-policy.unsaved", &Fields::new().with("org", vm.org.as_str()).with("why", e), Level::Error);
            }
        }
        self.published(link, r, now, was_off)
    }

    /// Revision 5 6.1: keep `<state>/api-signer/<org>.json`, the signer policy `publish_map` verified against the root.
    fn save_signer_policy(&self, org: &str, policy: &Map<String, Value>) -> Result<(), String> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let folder = dir.join(SIGNER_DIR);
        crate::store::make_dir(&folder).map_err(|e| e.to_string())?;
        crate::fleet_local::write_durable(&folder.join(format!("{org}.json")), stringify(&Value::Object(policy.clone())).as_bytes())
    }

    /// API-1d 2.4 (map trust on spokes relays): keep `<state>/api-signer/<org>.trust.json` = `{"root": <PEM>, "crl":
    /// <PEM>?}`, the Meet org CA root (and its CRL) the console verifies the org's maps with, flushed. The
    /// console's save calls it before it publishes, so a spokes relay can verify the map under the same root. A failed
    /// write is the security line `api.map.trust-unsaved` (spokes relays then get no map until a later save keeps it).
    /// A root other than the one kept is a root rotation: the spokes relays' records take a generation that releases
    /// the org's pinned root (`spokes_rotate`), the only way a spokes relay ever drops a pinned root.
    pub fn save_map_trust(&self, org: &str, root_der: &[u8], crl_pem: Option<&str>) {
        let Some(dir) = self.dir.as_ref().filter(|_| org_ok(org)) else { return };
        let folder = dir.join(SIGNER_DIR);
        let file = folder.join(format!("{org}.trust.json"));
        let root = crate::meet_x509::der_to_pem(root_der);
        let kept = std::fs::read_to_string(&file).ok().and_then(|t| parse_json(&t)).and_then(|v| v.get("root").and_then(Value::as_str).map(str::to_string));
        let mut v = json!({ "root": root.as_str() });
        if let Some(crl) = crl_pem {
            v["crl"] = json!(crl);
        }
        let saved = crate::store::make_dir(&folder).map_err(|e| e.to_string()).and_then(|_| crate::fleet_local::write_durable(&file, stringify(&v).as_bytes()));
        match saved {
            Err(e) => self.logger.security("api.map.trust-unsaved", &Fields::new().with("org", org).with("why", e), Level::Error),
            Ok(()) if kept.is_some_and(|k| k != root) => self.spokes_rotate(org),
            Ok(()) => {}
        }
    }

    /// API-1d 2.4: the `trust` an `api-map` to a spokes relay carries, `{root, signer_policy, crl?}`: the saved root
    /// (`save_map_trust`) and the root-signed signer policy the org's map was verified with. None before both are kept.
    fn spokes_trust(&self, org: &str) -> Option<Value> {
        let dir = self.dir.as_ref().filter(|_| org_ok(org))?.join(SIGNER_DIR);
        let read = |name: String| std::fs::read_to_string(dir.join(name)).ok().and_then(|t| parse_json(&t));
        let mut trust = read(format!("{org}.trust.json")).filter(|t| t.get("root").is_some_and(Value::is_string))?;
        trust["signer_policy"] = read(format!("{org}.json")).filter(Value::is_object)?;
        Some(trust)
    }

    // ── API-1d 2.4, 5.1: spokes relays and their bound orgs ──

    /// The orgs bound to a spokes relay, sorted (none for a relay never bound, and for every Meet relay).
    pub fn spokes_bound(&self, relay: &str) -> Vec<String> {
        self.spokes.lock().get(relay).map(|b| b.orgs.clone()).unwrap_or_default()
    }

    /// A relay with a bound record is a spokes relay: it gets `api-orgs` first in every catch-up and `trust` with each
    /// map. Meet relays never have one.
    fn is_spokes(&self, relay: &str) -> bool {
        self.spokes.lock().contains_key(relay)
    }

    /// `api-spokes-bound.json`, flushed (its folder made first: a console may bind before it keeps anything else).
    fn save_spokes(&self, all: &BTreeMap<String, SpokesBound>) -> Result<(), String> {
        let Some(dir) = &self.dir else { return Ok(()) };
        crate::store::make_dir(dir).map_err(|e| e.to_string())?;
        let relays: Map<String, Value> = all.iter().map(|(r, b)| (r.clone(), b.to_value())).collect();
        crate::fleet_local::write_durable(&dir.join(SPOKES_BOUND_FILE), stringify(&json!({ "relays": relays })).as_bytes())
    }

    /// `api-orgs` with the relay's recorded list under its generation, after any delivery to the relay in flight. Once
    /// the relay acknowledged a generation that carried released roots, the release is done: it is dropped from the
    /// record unless a newer generation was recorded meanwhile. A relay that already applied a newer generation (the
    /// console's record went back) refuses `stale-generation`, the security line `api.spokes.stale-generation`.
    fn send_orgs(&self, link: &dyn FleetLink, relay: &str) -> Result<Value, LinkError> {
        let record = self.spokes.lock().get(relay).cloned().unwrap_or_default();
        let answer = link.request(relay, "api-orgs", record.body(), CALL_MS);
        match &answer {
            Ok(_) if !record.release_roots.is_empty() => {
                let mut all = self.spokes.lock();
                if all.get(relay).is_some_and(|b| b.generation == record.generation) {
                    let mut candidate = all.clone();
                    if let Some(b) = candidate.get_mut(relay) {
                        b.release_roots.clear();
                    }
                    // unsaved, the release goes again with the next generation: harmless before the new root is pinned
                    match self.save_spokes(&candidate) {
                        Ok(()) => *all = candidate,
                        Err(e) => self.logger.ops("api.spokes.bound-unsaved", &Fields::new().with("relay", relay).with("why", e), Level::Warn),
                    }
                }
            }
            Err(LinkError::Refused { code, .. }) if code == "stale-generation" => {
                self.logger.security("api.spokes.stale-generation", &Fields::new().with("relay", relay).with("generation", record.generation), Level::Error);
            }
            _ => {}
        }
        answer
    }

    /// API-1d 2.4 (shared contract item 3): the Meet org CA root the console verifies `org`'s maps with changed, so
    /// every spokes relay's record takes a new generation releasing `org`'s pinned root (a relay may still pin it
    /// after an unbinding), and each relay is caught up again (`api-orgs` first) before the map under the new root.
    fn spokes_rotate(&self, org: &str) {
        let relays: Vec<String> = {
            let mut all = self.spokes.lock();
            if all.is_empty() {
                return;
            }
            let mut candidate = all.clone();
            for b in candidate.values_mut() {
                b.generation += 1;
                if !b.release_roots.iter().any(|o| o == org) {
                    b.release_roots.push(org.to_string());
                    b.release_roots.sort();
                }
            }
            if let Err(e) = self.save_spokes(&candidate) {
                self.logger.security("api.spokes.rotation-unsaved", &Fields::new().with("org", org).with("why", e), Level::Error);
                return;
            }
            *all = candidate;
            all.keys().cloned().collect()
        };
        self.logger.security("api.spokes.root-rotated", &Fields::new().with("org", org).with("relays", &relays[..]), Level::Warn);
        let mut inner = self.inner.lock();
        for relay in relays {
            if !matches!(inner.relays.get(&relay), Some(RelayApi::NoApi)) {
                inner.relays.insert(relay.clone(), RelayApi::Unknown);
            }
            inner.unsynced.insert(relay);
        }
    }

    /// API-1d 5.1 (`POST settings/api/spokes/relays`): bind (or unbind) `org` on the spokes relay `relay`. The new list
    /// is recorded durably first; then, when the relay is connected, `api-orgs` goes at once and, once acknowledged,
    /// a catch-up follows on its own thread (heads, features, the org's map with `trust`, its journal). Ok(true) when
    /// the relay acknowledged, Ok(false) when it was not connected or the send failed: the relay is then left unsynced,
    /// so the minute's `sync_tick` (or its next `welcome`) sends `api-orgs` first. A relay that answers `fleet-op` is
    /// older than API-1d: a bind is undone (`relay-outdated`), an unbind stays recorded. The caller stages the map's
    /// `spokes.relays` and audits the route.
    pub fn spokes_bind(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, relay: &str, org: &str, bound: bool, now: i64) -> Result<bool, ApiMapError> {
        if !org_ok(org) || !crate::fleet_metrics::relay_id_ok(relay) {
            return Err(ApiMapError::new("invalid", "that is not an organization and relay id"));
        }
        let (before, generation) = {
            let mut all = self.spokes.lock();
            let before = all.get(relay).cloned();
            let mut next = before.clone().unwrap_or_default();
            next.orgs.retain(|o| o != org);
            if bound {
                next.orgs.push(org.to_string());
                next.orgs.sort();
            }
            if next.orgs.len() > SPOKES_ORGS_MAX {
                return Err(ApiMapError::new("invalid", "a spokes relay serves at most 64 organizations"));
            }
            // every change is a new binding generation, so the relay refuses the older list if it is ever replayed
            next.generation += 1;
            let generation = next.generation;
            let mut candidate = all.clone();
            candidate.insert(relay.to_string(), next);
            self.save_spokes(&candidate).map_err(io_e)?;
            *all = candidate;
            (before, generation)
        };
        let Some(link) = link.filter(|l| l.connected(relay)) else { return Ok(false) };
        let sent = {
            let gate = self.sending.lock().entry(relay.to_string()).or_default().clone();
            let _one = gate.lock();
            self.send_orgs(&*link, relay)
        };
        match sent {
            Ok(_) => {
                // the relay serves another set of orgs now: its heads are asked again, then it is caught up
                self.inner.lock().relays.insert(relay.to_string(), RelayApi::Unknown);
                let (me, r) = (self.clone(), relay.to_string());
                let _ = std::thread::Builder::new().name("api-sync".into()).spawn(move || {
                    me.sync(&*link, &r, now);
                });
                Ok(true)
            }
            Err(LinkError::Refused { code, .. }) if code == "fleet-op" => {
                self.logger.ops("api.spokes.relay-outdated", &Fields::new().with("relay", relay).with("org", org), Level::Warn);
                if !bound {
                    return Ok(false);
                }
                let mut all = self.spokes.lock();
                let mut candidate = all.clone();
                // the list goes back, the generation never does
                match before {
                    Some(b) => candidate.insert(relay.to_string(), SpokesBound { generation, ..b }),
                    None => candidate.remove(relay),
                };
                self.save_spokes(&candidate).map_err(io_e)?;
                *all = candidate;
                Err(ApiMapError::new(crate::api_features::OUTDATED, "that relay does not take organizations yet; update it first"))
            }
            Err(_) => {
                let mut inner = self.inner.lock();
                inner.unsynced.insert(relay.to_string());
                if !matches!(inner.relays.get(relay), Some(RelayApi::NoApi)) {
                    inner.relays.insert(relay.to_string(), RelayApi::Unknown);
                }
                Ok(false)
            }
        }
    }

    /// API-1d 6.1 on the front door: one 6.2 view of a spokes relay bound to `org`, asked with `api-spokes`. None when
    /// the relay is not a spokes relay of the org here (404); a relay that is not connected, does not answer or does
    /// not report `spokes-read` is 503 `relay-unreachable`; its own `not-found` or `bad-request` is passed on.
    pub fn spokes_view(&self, link: Option<&dyn FleetLink>, org: &str, relay: &str, view: &str, query: &str, people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
        use crate::fleet_wire::Refusal;
        if !self.spokes_bound(relay).iter().any(|o| o == org) {
            return None;
        }
        let unreachable = || Refusal::new(503, "relay-unreachable", "That spokes relay is not answering now; try again later.");
        let Some(link) = link.filter(|l| l.connected(relay)) else { return Some(Err(unreachable())) };
        if !self.relay_has(relay, crate::api_features::SPOKES_READ) {
            return Some(Err(unreachable()));
        }
        match link.request(relay, "api-spokes", json!({ "org": org, "view": view, "query": query, "people": people }), CALL_MS) {
            Ok(v) => Some(Ok(v)),
            Err(LinkError::Refused { status, code, error }) if code == "not-found" || code == "bad-request" => Some(Err(Refusal::new(status, &code, &error))),
            Err(_) => Some(Err(unreachable())),
        }
    }

    /// API-1d 4.2: the CRL tokens the spokes relays bound to `org` hold now (their `relays` view, `crl.token`), for the
    /// check of a pasted service hub certificate. A relay that does not answer gives none.
    pub fn spokes_crls(&self, link: Option<&dyn FleetLink>, org: &str) -> Vec<String> {
        let relays: Vec<String> = self.spokes.lock().iter().filter(|(_, b)| b.orgs.iter().any(|o| o == org)).map(|(r, _)| r.clone()).collect();
        relays
            .iter()
            .filter_map(|relay| self.spokes_view(link, org, relay, "relays", "", false)?.ok())
            .filter_map(|v| v.pointer("/crl/token").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    /// Whether the pinned map of `org` lets the spokes relay take it: no map yet, or `spokes.relays` lists the relay.
    /// A map that does not list it (staged before the save that binds it) is neither sent nor awaited (5.1:
    /// `not-bound`).
    fn spokes_listed(inner: &Inner, relay: &str, org: &str) -> bool {
        inner.store.get(org, "").is_none_or(|m| m.map().get("spokes").and_then(|s| s.get("relays")).and_then(Value::as_array).is_some_and(|l| l.iter().any(|r| r.as_str() == Some(relay))))
    }

    /// Revision 5 6.1: the org's registry entries (signer policy v3 `identity_providers`) from the newest signer policy
    /// a pinned map of the org was verified with (none before the first publish).
    pub fn identity_providers(&self, org: &str) -> Vec<crate::meet_org_policy::IdentityProvider> {
        let Some(dir) = self.dir.as_ref().filter(|_| org_ok(org)) else { return Vec::new() };
        let policy = std::fs::read_to_string(dir.join(SIGNER_DIR).join(format!("{org}.json"))).ok().and_then(|t| parse_json(&t));
        let terms = policy.as_ref().and_then(Value::as_object).and_then(|p| crate::meet_org_policy::signer_terms(p).ok());
        terms.map(|t| t.providers_of(org).into_iter().cloned().collect()).unwrap_or_default()
    }

    /// Revision 5 6.5 step 2: the SSO service's public URL for (org, provider), set by the console's admin (1c7).
    pub fn sso_url(&self, org: &str, provider: &str) -> Option<String> {
        self.sso_urls.lock().get(org)?.get(provider).cloned()
    }

    /// Set (or with None remove) the SSO service's public URL for (org, provider), flushed before Ok; `https://` only.
    pub fn set_sso_url(&self, org: &str, provider: &str, url: Option<&str>) -> Result<(), String> {
        if !org_ok(org) || url.is_some_and(|u| !u.starts_with("https://") || u.contains(['?', '#']) || crate::api_fetch::check_url(u).is_err()) {
            return Err("an SSO URL is an https:// URL without a query or fragment".into());
        }
        let mut all = self.sso_urls.lock();
        let mut next = all.clone();
        match url {
            Some(u) => {
                next.entry(org.to_string()).or_default().insert(provider.to_string(), u.trim_end_matches('/').to_string());
            }
            None => {
                if let Some(p) = next.get_mut(org) {
                    p.remove(provider);
                }
            }
        }
        if let Some(dir) = &self.dir {
            crate::fleet_local::write_durable(&dir.join(SSO_URLS_FILE), stringify(&json!(next)).as_bytes())?;
        }
        *all = next;
        Ok(())
    }

    /// 13: hold every pinned map to the license `edition` (None: unknown, which serves no map). Revalidates only when
    /// the edition changes (or on the first call); each org set aside logs `api.map.edition-refused`, each restored
    /// `api.map.edition-restored`.
    pub fn set_edition(&self, edition: Option<Edition>) {
        let changed = {
            let mut inner = self.inner.lock();
            if inner.edition == Some(edition) {
                return;
            }
            inner.edition = Some(edition);
            inner.store.revalidate(edition)
        };
        self.edition_lines(&changed, edition);
        self.export_changed(None);
    }

    /// Call with the store's lock released.
    fn edition_lines(&self, changed: &[String], edition: Option<Edition>) {
        for org in changed {
            let aside = self.inner.lock().store.is_set_aside(org);
            let f = Fields::new().with("org", org.as_str()).with("edition", edition.map(Edition::as_str));
            if aside {
                self.logger.security("api.map.edition-refused", &f, Level::Warn);
            } else {
                self.logger.security("api.map.edition-restored", &f, Level::Info);
            }
        }
    }

    /// `publish_map` for a map already verified.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn publish_verified(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, vm: VerifiedApiMap, now: i64) -> Result<AcceptOutcome, ApiMapError> {
        let (r, was_off) = {
            let mut inner = self.inner.lock();
            let was_off = inner.store.is_off(&vm.org);
            (inner.store.pin(vm), was_off)
        };
        self.published(link, r, now, was_off)
    }

    /// After a pin or a refusal; `was_off` is whether the org's `api_off` was active before the pin.
    fn published(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, r: Result<AcceptOutcome, ApiMapError>, now: i64, was_off: bool) -> Result<AcceptOutcome, ApiMapError> {
        match &r {
            Ok(AcceptOutcome::Pinned(vm)) => {
                // revision 4 7.1: a signed map that cleared the org's `api_off` turns the API on again
                if was_off && !self.inner.lock().store.is_off(&vm.org) {
                    self.emit_event(&vm.org, "api.enabled", Value::Null, now);
                }
                // a map pinned without an edition check (`publish_verified`) is held to the edition in force too
                let changed = {
                    let mut inner = self.inner.lock();
                    let held = inner.edition;
                    match held {
                        Some(edition) => (inner.store.revalidate(edition), edition),
                        None => (Vec::new(), None),
                    }
                };
                self.edition_lines(&changed.0, changed.1);
                self.note_audit(vec![crate::fleet_agent::api_note_pinned(vm)], now);
                self.prune(&vm.org, now);
                let map = Value::Object(vm.map().clone());
                let settled = {
                    let mut inner = self.inner.lock();
                    let r = inner.cj.settle(&vm.org, &map);
                    crate::api_delegated::publish_revokes(&vm.org, &inner.cj.active(&vm.org));
                    r
                };
                if let Err(e) = settled {
                    // the entries stay active (stricter) until the next open settles them
                    self.logger.security("api.console-journal.unsettled", &Fields::new().with("org", vm.org.as_str()).with("why", e.message), Level::Error);
                }
                self.export_changed(None);
                if let Some(link) = link {
                    self.deliver_org(link, &vm.org);
                }
            }
            Ok(AcceptOutcome::Conflict { org, seq, pinned_hash, offered_hash }) => {
                let f = Fields::new().with("org", org.as_str()).with("seq", *seq).with("pinned", pinned_hash.as_str()).with("offered", offered_hash.as_str()).with("via", "console");
                self.logger.security("api.map.conflict", &f, Level::Error);
                self.note_audit(vec![crate::fleet_agent::api_note_conflict(org, *seq, None)], now);
            }
            _ => {}
        }
        r
    }

    // ── the journal (2.5) ──

    /// Append a tightening to the org's journal (the next tseq, checked as a relay checks it: never widening),
    /// flushed to disk, applied to the console's store, then sent (`api-tighten`) to every connected relay of the
    /// org. Ok is the entry.
    pub fn append(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, org: &str, action: &str, target: Value, until: Option<i64>, now: i64) -> Result<Value, ApiMapError> {
        if !org_ok(org) {
            return Err(ApiMapError::new("not-tightening", "that is not an organization id"));
        }
        // revision 4 2.3 item 4c: an entry only revision 4 relays read is journaled while version 2 is open for the
        // org; while it is closed, its revision 3 fallback (equal or stricter), once
        let (action, target): (&str, Value) = {
            let inner = self.inner.lock();
            match crate::api_features::relay_entry_gate(action, &target) {
                Some((need, fallback, ft)) if !inner.sets.open(org, need) => {
                    let f = Fields::new().with("org", org).with("action", action).with("fallback", fallback).with("need", need);
                    self.logger.security("api.journal.fallback", &f, Level::Warn);
                    if let Some(held) = inner.store.active(org).iter().find(|e| e.action == fallback && e.target == ft) {
                        return Ok(held.to_value());
                    }
                    (fallback, ft)
                }
                _ => (action, target),
            }
        };
        let entry = {
            let mut inner = self.inner.lock();
            let head = inner.orgs.get(org).map_or(0, OrgJournal::head);
            let tseq = head + 1;
            let mut e = json!({ "id": format!("t_{org}_{tseq:06}"), "tseq": tseq, "ts": now, "action": action, "target": target });
            if let Some(u) = until {
                e["until"] = json!(u);
            }
            let checked = check_tighten(&e, head)?;
            if checked.org != org || checked.tseq != tseq {
                return Err(ApiMapError::new("not-tightening", "that entry is for another organization"));
            }
            self.append_line(org, &e)?;
            inner.orgs.entry(org.to_string()).or_default().entries.push(e.clone());
            // the journal file is the record; a store that falls behind is brought up at the next open
            if let Err(err) = inner.store.apply_tighten(org, &e) {
                self.logger.security("api.journal.store-behind", &Fields::new().with("org", org).with("why", err.message), Level::Error);
            }
            e
        };
        // 9.2: the journal file is the record of the tightening; its audit entry follows it (a tightening is never
        // refused for the audit: `api.audit-failed` instead)
        self.note_audit(vec![crate::fleet_agent::api_note_tighten(org, &entry)], now);
        // revision 4 7.1: its event, before any relay or destination hears of it
        match (action, entry["target"].as_str()) {
            ("client_suspend", Some(client)) => {
                self.emit_event(org, "client.suspended", json!({ "client": client, "reason": action }), now);
            }
            ("api_off", _) => {
                self.emit_event(org, "api.disabled", Value::Null, now);
            }
            _ => {}
        }
        // 2.5, 11: a destination tightening takes effect on the console's exports at once
        self.export_changed(None);
        if let Some(link) = link {
            self.deliver_org(link, org);
        }
        // revision 4 5.3.3 (Rev4Review R4-2): open export jobs of a narrowed client are canceled at once
        crate::api_exports::tightened(org, now);
        Ok(entry)
    }

    /// The journal head (last tseq) of an org.
    pub fn journal_head(&self, org: &str) -> u64 {
        self.inner.lock().orgs.get(org).map_or(0, OrgJournal::head)
    }

    /// The newest `n` journal entries still kept for an org, newest first (the API access screen, slice 1a6).
    pub fn journal_newest(&self, org: &str, n: usize) -> Vec<Value> {
        self.inner.lock().orgs.get(org).map(|j| j.entries.iter().rev().take(n).cloned().collect()).unwrap_or_default()
    }

    /// The active (not folded or cleared) journal entries of an org, as the console's store applies them.
    pub fn journal_active(&self, org: &str) -> Vec<crate::api_map::TightenEntry> {
        self.inner.lock().store.active(org).to_vec()
    }

    // ── revision 4 2.3: the feature gate and the console journal ──

    /// 2.3 item 3: Ok while every relay of the org's set reports each need (`api_features` names; `map-v2` for map
    /// version 2), else `relay-outdated` naming the relays that lack one. Stages and saves check it, and every
    /// feature-specific request checks it again right before it is sent.
    pub fn gate(&self, org: &str, needs: &[&str]) -> Result<(), ApiMapError> {
        self.inner.lock().sets.gate(org, needs)
    }

    /// 2.3 item 3: whether a relay reports a need now (its latest `api-features` answer).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn relay_has(&self, relay: &str, need: &str) -> bool {
        self.inner.lock().sets.report_of(relay).is_some_and(|r| r.has(need))
    }

    /// 2.3 item 2: the org's relay set, relay to its latest `api-features` answer (None: not answered yet).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn relay_set(&self, org: &str) -> BTreeMap<String, Option<Report>> {
        self.inner.lock().sets.set(org)
    }

    /// 2.3 item 2 (`POST settings/api/relays/retire`): an admin retires a relay from the org's set. Refused
    /// (`relay-connected`) while that relay is connected and still reports the org; Ok(false) when it was not in the
    /// set. The caller audits it.
    pub fn retire_relay(&self, org: &str, relay: &str) -> Result<bool, ApiMapError> {
        if self.serves_now(relay, org) {
            return Err(ApiMapError::new("relay-connected", "that relay is connected and still reports the organization"));
        }
        let mut inner = self.inner.lock();
        let gone = inner.sets.retire(org, relay)?;
        inner.withheld.remove(&(relay.to_string(), org.to_string()));
        Ok(gone)
    }

    /// The attention item `relay-outdated` (2.3 item 3): per org with a pinned map, each relay of its set that lacks
    /// a need of that map, with those needs.
    pub fn outdated(&self) -> Vec<(String, String, Vec<&'static str>)> {
        let inner = self.inner.lock();
        let mut out = Vec::new();
        for org in inner.sets.orgs() {
            let Some(m) = inner.store.get(&org, "") else { continue };
            let needs = crate::api_features::map_needs(&Value::Object(m.map().clone()));
            let set = inner.sets.set(&org);
            for relay in crate::api_features::lacking(&set, &needs) {
                let missing: Vec<&'static str> = needs.iter().copied().filter(|n| !set.get(&relay).and_then(Option::as_ref).is_some_and(|r| r.has(n))).collect();
                out.push((org.clone(), relay, missing));
            }
        }
        out
    }

    /// 2.3 item 4: append a console-only (4a) or connector-relevant (4b) action to the org's console journal, as the
    /// next `cseq`, flushed before Ok: only then does it take effect (the console's effect reads `console_active`)
    /// and is the admin answered. Its `api.tighten` audit entry follows. Never sent to a relay. Ok is the entry.
    pub fn append_console(&self, org: &str, action: &str, target: Value, now: i64) -> Result<Value, ApiMapError> {
        let e = {
            let mut inner = self.inner.lock();
            let e = inner.cj.append(org, action, target, now)?.to_value();
            // revision 5 6.6: offline validation sees a `person_revoke` at once
            crate::api_delegated::publish_revokes(org, &inner.cj.active(org));
            e
        };
        // the audit entry's resource is the `k_` id, which tells it from a relay journal entry
        self.note_audit(vec![crate::fleet_agent::api_note_tighten(org, &e)], now);
        // revision 4 2.4 `client_drop_recipient`: its open export jobs are canceled at once
        crate::api_exports::tightened(org, now);
        Ok(e)
    }

    /// 2.3 item 4: the org's console journal entries not yet folded or cleared, in `cseq` order (their effects:
    /// `api_cjournal::caps`, `recipient_dropped`, `key_dropped`).
    pub fn console_active(&self, org: &str) -> Vec<ConsoleEntry> {
        self.inner.lock().cj.active(org)
    }

    /// Revision 5 6.6, 8.2: the org's last verified policy, which a delegated token at M is checked against.
    pub fn verified_policy(&self, org: &str, now: i64) -> Option<crate::meet_org_policy::Obj> {
        self.delegated.verified_policy(org, now)
    }

    /// 4b: the org's connector-relevant entries after `cseq`, in order (revision 5 syncs them to connectors).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn connector_entries(&self, org: &str, after: u64) -> Vec<ConsoleEntry> {
        self.inner.lock().cj.connector_entries(org, after)
    }

    // ── revision 5 2.8: what the connector sync reads (`console_connector`) ──

    /// The console's state folder (None in memory).
    pub fn state_dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// 2.8 `sync`: what a connector holding map `seq` and relay journal `tseq` lacks of the org, as a relay's catch-up
    /// plans it: the pinned map's signed wire (`{map, sig, chain}`) when newer than `seq` or when `tseq` is below the
    /// pruned base, that base (only with the map), and the relay journal entries after `tseq` (after the base when
    /// rebasing), in order.
    pub fn connector_plan(&self, org: &str, seq: i64, tseq: u64) -> (Option<Value>, Option<u64>, Vec<Value>) {
        let inner = self.inner.lock();
        let (_, map, base, entries) = Self::plan(&inner, "", org, seq, tseq);
        (map, base, entries)
    }

    /// 2.8, 12.1: the console's audit chains (connector chains are stored there) and the issuer of checkpoint
    /// certificates, once `set_audit` ran.
    pub fn audit_parts(&self) -> Option<(Arc<ApiAudit>, IssueFn)> {
        self.audit.get().cloned()
    }

    /// 2.8 `ack` and r5 3.3: the connector joins the org's relay set under its id and its `Report` replaces the one
    /// kept, flushed, exactly as a relay's `api-heads` and `api-features` answers; a report that closes a feature
    /// open until now writes `api.relay-outdated`.
    pub fn connector_reported(&self, org: &str, connector: &str, report: Report) -> Result<(), ApiMapError> {
        let mut inner = self.inner.lock();
        for o in inner.sets.joined(connector, [org])? {
            self.logger.ops("api.relay-set.joined", &Fields::new().with("relay", connector).with("org", o.as_str()), Level::Info);
        }
        let watched = [
            crate::api_features::MAP_V2,
            crate::api_features::CONNECTORS,
            crate::api_features::IDPS,
            crate::api_features::CONTENT_CLIENTS,
            crate::api_features::DELEGATED,
            crate::api_features::JOURNAL_1C,
        ];
        for (o, needs) in inner.sets.reported(connector, report, &watched)? {
            let f = Fields::new().with("relay", connector).with("org", o.as_str()).with("closed", needs.join(","));
            self.logger.security("api.relay-outdated", &f, Level::Warn);
        }
        Ok(())
    }

    /// The `k_` ids a save may keep listing in `folded` and `cleared` (every console journal entry of the org).
    pub fn console_ids(&self, org: &str) -> Vec<String> {
        self.inner.lock().cj.entries(org).into_iter().map(|e| e.id).collect()
    }

    /// Every console journal entry of the org, settled ones included (revision 4 2.4: a `federation_drop_key` keeps
    /// its attention item after a map folds it; `api_federation`).
    pub fn console_entries(&self, org: &str) -> Vec<ConsoleEntry> {
        self.inner.lock().cj.entries(org)
    }

    /// The console's sealed store (revision 4 8.1: the org federation keys, `api_federation`).
    pub fn vault(&self) -> Arc<dyn VaultLock> {
        self.vault.clone()
    }

    /// Revision 4 4.5: the front door's `Idempotency-Key` store (the compliance routes of slices 1b4 and 1b5).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn idempotency(&self) -> &IdemStore {
        &self.idem
    }

    /// Per relay that serves the org (`relays_of`): `{id, acked, synced}`, `synced` when it acknowledged the journal
    /// head and its last catch-up fully succeeded (the API access screen, slice 1a6).
    pub fn relays_view(&self, org: &str) -> Vec<Value> {
        let relays = self.relays_of(org);
        let inner = self.inner.lock();
        let j = inner.orgs.get(org);
        let head = j.map_or(0, OrgJournal::head);
        relays
            .into_iter()
            .map(|r| {
                let acked = j.and_then(|j| j.acks.get(&r).copied()).unwrap_or(0);
                json!({ "id": r, "acked": acked, "synced": acked >= head && !inner.unsynced.contains(&r) })
            })
            .collect()
    }

    /// Every org the console holds a pinned map or a journal for, or a connected relay reported, sorted.
    pub fn known_orgs(&self) -> Vec<String> {
        let inner = self.inner.lock();
        let mut out: std::collections::BTreeSet<String> = inner.store.issuers().into_keys().collect();
        out.extend(inner.orgs.keys().cloned());
        for s in inner.relays.values() {
            if let RelayApi::Heads(h) = s {
                out.extend(h.keys().cloned());
            }
        }
        out.into_iter().collect()
    }

    /// The org's serving pinned map (the `map` object), its seq even while set aside, and whether it is set aside.
    pub fn pinned(&self, org: &str) -> (Option<Value>, i64, bool) {
        let inner = self.inner.lock();
        let map = inner.store.get(org, "").map(|m| Value::Object(m.map().clone()));
        (map, inner.store.head(org).0, inner.store.is_set_aside(org))
    }

    /// The entries still kept for an org (after pruning).
    #[cfg(test)]
    pub fn journal_len(&self, org: &str) -> usize {
        self.inner.lock().orgs.get(org).map_or(0, |j| j.entries.len())
    }

    /// The tseq a relay acknowledged for an org.
    #[cfg(test)]
    pub fn acked(&self, relay: &str, org: &str) -> u64 {
        self.inner.lock().orgs.get(org).and_then(|j| j.acks.get(relay).copied()).unwrap_or(0)
    }

    /// 2.5: drop the oldest entries once every relay that reported the org acknowledged them and the pinned map lists
    /// them in `folded` or `cleared` (`token_deny`: once `until` passed; `scrape_deny` stays). Nothing is pruned
    /// while the org has no pinned map. The kept entries are rewritten, flushed, and the base recorded.
    fn prune(&self, org: &str, now: i64) {
        let mut inner = self.inner.lock();
        // No pinned map, no pruning: `base` reaches a late relay only with a map (2.5).
        let Some((folded, cleared)) = inner.store.get(org, "").map(|m| (ids(m.map(), "folded"), ids(m.map(), "cleared"))) else { return };
        let Some(j) = inner.orgs.get_mut(org) else { return };
        if j.acks.is_empty() {
            return;
        }
        let gone = |e: &Value| {
            let tseq = e["tseq"].as_u64().unwrap_or(u64::MAX);
            let acked = j.acks.values().all(|a| *a >= tseq);
            let id = e["id"].as_str().unwrap_or_default();
            let done = match e["action"].as_str() {
                Some("token_deny") => e["until"].as_i64().is_some_and(|u| u <= now),
                Some("scrape_deny") => false,
                _ => folded.iter().chain(&cleared).any(|f| f == id),
            };
            acked && done
        };
        let n = j.entries.iter().take_while(|e| gone(e)).count();
        if n == 0 {
            return;
        }
        let kept = j.entries[n..].to_vec();
        if let Some(dir) = self.journal_dir() {
            let text: String = kept.iter().map(|e| format!("{}\n", stringify(e))).collect();
            // the base first: a crash between the writes leaves entries the next open skips by their tseq
            let next = OrgJournal { base: j.base + n as u64, entries: Vec::new(), acks: j.acks.clone(), keys: j.keys.clone(), key: j.key, issuer_kid: j.issuer_kid.clone() };
            if self.save_acks(org, &next).is_err() || crate::fleet_local::write_durable(&dir.join(format!("{org}.jsonl")), text.as_bytes()).is_err() {
                self.logger.security("api.journal.prune-failed", &Fields::new().with("org", org), Level::Error);
                return;
            }
        }
        j.base += n as u64;
        j.entries = kept;
        self.logger.ops("api.journal.pruned", &Fields::new().with("org", org).with("entries", n).with("base", j.base), Level::Info);
    }

    // ── pseudonym keys (2.6, 11.4) ──

    /// The org's pseudonym key: 32 random bytes drawn once and sealed (`api-pseudonym-<org>-1`). Ok is (pkv, key,
    /// not_before). The key never enters a log.
    pub fn pseudonym_key(&self, org: &str, now: i64) -> Result<(u64, Vec<u8>, i64), String> {
        if !org_ok(org) {
            return Err("that is not an organization id".into());
        }
        let name = crate::fleet_agent::api_pseudonym_seal_name(org, PSEUDONYM_PKV);
        let held = self.inner.lock().orgs.get(org).and_then(|j| j.key);
        if let Some(k) = vault_do(&*self.vault, |v| v.get(&name)) {
            return Ok((PSEUDONYM_PKV, k, held.map_or(now, |(_, nb)| nb)));
        }
        let key = crate::console_auth::random(32).ok_or("no random bytes")?;
        vault_do(&*self.vault, |v| v.put(&name, &key))?;
        let mut inner = self.inner.lock();
        let j = inner.orgs.entry(org.to_string()).or_default();
        j.key = Some((PSEUDONYM_PKV, now));
        self.save_acks(org, j).map_err(|e| e.message)?;
        Ok((PSEUDONYM_PKV, key, now))
    }

    // ── api-heads and catch-up (2.5) ──

    /// After `welcome`: the relay's api heads are unknown until it answers `api-heads`.
    pub fn on_welcomed(&self, relay: &str) {
        let mut inner = self.inner.lock();
        inner.relays.insert(relay.to_string(), RelayApi::Unknown);
        inner.no_audit.remove(relay);
        // the reconnect catch-up checks the certificates and backfills from the stored heads again
        inner.checkpoint_at.remove(relay);
        inner.backfill.retain(|(r, _)| r != relay);
        inner.ev_backfill.retain(|(r, _)| r != relay);
        inner.no_events.remove(relay);
    }

    /// The relay's `api-heads` answer (`{org: {seq, tseq}}`). A relay reporting a tseq above the console's journal
    /// raises `api.journal.conflict` and keeps its stricter state (nothing is sent to it for that org); every other
    /// org it reports counts toward pruning from now on.
    fn take_heads(&self, relay: &str, api: &Value) {
        let heads: BTreeMap<String, (i64, u64)> = api
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(org, _)| org_ok(org))
            .map(|(org, h)| (org.clone(), (h.get("seq").and_then(Value::as_i64).unwrap_or(0), h.get("tseq").and_then(Value::as_u64).unwrap_or(0))))
            .collect();
        let mut inner = self.inner.lock();
        // revision 4 2.3 item 2: every relay that reports an org is in its set from now on
        match inner.sets.joined(relay, heads.keys().map(String::as_str)) {
            Ok(joined) => {
                for org in joined {
                    self.logger.ops("api.relay-set.joined", &Fields::new().with("relay", relay).with("org", org.as_str()), Level::Info);
                }
            }
            Err(e) => self.logger.security("api.relay-set.unsaved", &Fields::new().with("relay", relay).with("why", e.message), Level::Error),
        }
        for (org, (_, tseq)) in &heads {
            let head = inner.orgs.get(org).map_or(0, OrgJournal::head);
            if *tseq > head {
                let f = Fields::new().with("relay", relay).with("org", org.as_str()).with("relayTseq", *tseq).with("consoleTseq", head);
                self.logger.security("api.journal.conflict", &f, Level::Error);
                continue;
            }
            let j = inner.orgs.entry(org.clone()).or_default();
            let a = j.acks.entry(relay.to_string()).or_insert(*tseq);
            *a = (*a).max(*tseq);
            if let Err(e) = self.save_acks(org, j) {
                self.logger.security("api.journal.ack-unsaved", &Fields::new().with("org", org.as_str()).with("why", e.message), Level::Error);
            }
        }
        inner.relays.insert(relay.to_string(), RelayApi::Heads(heads));
    }

    /// Revision 4 2.3 items 1 and 3: the relay's `api-features` answer (`Report::old` for `fleet-op`) kept for every
    /// org whose set holds it. An answer that lacks a feature open for an org until now (a rollback) closes it at once:
    /// the `api.relay-outdated` security line names the relay and the closed features (the attention item
    /// `relay-outdated` follows from `outdated`). False when the set could not be kept on disk (the catch-up tries
    /// again).
    fn take_features(&self, relay: &str, report: Report) -> bool {
        let mut inner = self.inner.lock();
        let watched = [crate::api_features::MAP_V2, crate::api_features::COMPLIANCE, crate::api_features::EVENTS, crate::api_features::SCIM_CHECK, crate::api_features::ARCHIVE];
        match inner.sets.reported(relay, report, &watched) {
            Ok(closed) => {
                for (org, needs) in closed {
                    let f = Fields::new().with("relay", relay).with("org", org.as_str()).with("closed", needs.join(","));
                    self.logger.security("api.relay-outdated", &f, Level::Warn);
                }
                true
            }
            Err(e) => {
                self.logger.security("api.relay-set.unsaved", &Fields::new().with("relay", relay).with("why", e.message), Level::Error);
                false
            }
        }
    }

    fn holds_any(inner: &Inner) -> bool {
        !inner.store.issuers().is_empty() || inner.orgs.values().any(|j| j.head() > 0)
    }

    /// What the relay lacks for one org: (send the key, the map to send, the pruned `base` to send with it, the
    /// entries to send). A relay below the pruned base gets the pinned map with `base` (it rebases), then every entry
    /// kept; without a pinned map it gets no entry (it could only refuse them as a gap).
    fn plan(inner: &Inner, relay: &str, org: &str, seq: i64, tseq: u64) -> (bool, Option<Value>, Option<u64>, Vec<Value>) {
        let j = inner.orgs.get(org);
        let pinned = inner.store.get(org, "");
        let key = pinned.is_some() && j.and_then(|j| j.keys.get(relay)).is_none_or(|k| *k < PSEUDONYM_PKV);
        let behind = j.map(|j| j.base).filter(|b| tseq < *b);
        let map = pinned.filter(|m| m.seq > seq || behind.is_some()).map(|m| Value::Object(m.wire.clone()));
        let from = match (behind, &map) {
            (Some(b), Some(_)) => Some(b),
            (Some(_), None) => None,
            (None, _) => Some(tseq),
        };
        let entries = j.zip(from).filter(|(j, f)| *f >= j.base && *f <= j.head()).map(|(j, f)| j.entries[(f - j.base) as usize..].to_vec()).unwrap_or_default();
        (key, map, behind.filter(|_| pinned.is_some()), entries)
    }

    /// Whether the relay must be asked `api-heads` or lacks a key, map or journal entry of an org it reported.
    pub fn needs_sync(&self, relay: &str) -> bool {
        let inner = self.inner.lock();
        match inner.relays.get(relay) {
            // API-1d 2.4 (R6-10): a spokes relay gets `api-orgs` at every reconnect, even with nothing else to send
            Some(RelayApi::Unknown) => Self::holds_any(&inner) || self.is_spokes(relay),
            Some(RelayApi::Heads(heads)) => heads.iter().any(|(org, (seq, tseq))| {
                if *tseq > inner.orgs.get(org).map_or(0, OrgJournal::head) {
                    return false;
                }
                let (k, m, _, e) = Self::plan(&inner, relay, org, *seq, *tseq);
                k || m.is_some() || !e.is_empty()
            }),
            Some(RelayApi::NoApi) | None => false,
        }
    }

    /// Send every connected relay of `org` (or whose heads are not known yet) what it lacks, each on its own thread.
    fn deliver_org(self: &Arc<Self>, link: Arc<dyn FleetLink>, org: &str) {
        let relays: Vec<String> = self
            .inner
            .lock()
            .relays
            .iter()
            .filter(|(_, s)| match s {
                RelayApi::Unknown => true,
                RelayApi::Heads(h) => h.contains_key(org),
                RelayApi::NoApi => false,
            })
            .map(|(r, _)| r.clone())
            .collect();
        for relay in relays.into_iter().filter(|r| link.connected(r)) {
            let (me, link) = (self.clone(), link.clone());
            let _ = std::thread::Builder::new().name("api-sync".into()).spawn(move || {
                me.sync(&*link, &relay, crate::codec::now_ms() / 1000);
            });
        }
    }

    /// The reconnect catch-up of 2.5: `api-heads` when not known (an older relay's `fleet-op` marks it as having no
    /// api), then per org it reported the pseudonym key it lacks, the map newer than its seq, and every journal entry
    /// after its tseq, strictly in order, each answered before the next; the acknowledgments are kept on disk. A sync
    /// that fully succeeded ends with `api-synced` (the console's pinned seq and journal head of every org the relay
    /// reported), which the relay accepts only when it holds that much: until then it stays in failover (12.2). False
    /// when a request failed; `sync_tick` tries again.
    pub fn sync(&self, link: &dyn FleetLink, relay: &str, now: i64) -> bool {
        let done = self.sync_once(link, relay, now);
        // a relay that left is synced again by its next `welcome`
        let settled = done || !link.connected(relay);
        let mut inner = self.inner.lock();
        if settled {
            inner.unsynced.remove(relay);
        } else {
            inner.unsynced.insert(relay.to_string());
            // a request whose answer was lost may have been applied: the retry asks `api-heads` first
            if let Some(s) = inner.relays.get_mut(relay).filter(|s| matches!(s, RelayApi::Heads(_))) {
                *s = RelayApi::Unknown;
            }
        }
        done
    }

    fn sync_once(&self, link: &dyn FleetLink, relay: &str, now: i64) -> bool {
        let gate = self.sending.lock().entry(relay.to_string()).or_default().clone();
        let _one = gate.lock();
        let unknown = matches!(self.inner.lock().relays.get(relay), Some(RelayApi::Unknown));
        // API-1d 2.4 (R6-10): a spokes relay takes its bound orgs right after `welcome`, before `api-heads`, so an org
        // unbound while it was away is dropped before any other request; a failure leaves the catch-up incomplete
        if unknown && self.is_spokes(relay) {
            match self.send_orgs(link, relay) {
                Ok(_) => {}
                // older than API-1d: it holds no API state of its own, `api-heads` tells
                Err(LinkError::Refused { code, .. }) if code == "fleet-op" => {
                    self.logger.ops("api.spokes.relay-outdated", &Fields::new().with("relay", relay), Level::Warn);
                }
                Err(_) => return false,
            }
        }
        if unknown {
            match link.request(relay, "api-heads", json!({}), CALL_MS) {
                Ok(v) => self.take_heads(relay, &v),
                Err(LinkError::Refused { code, .. }) if code == "fleet-op" => {
                    self.inner.lock().relays.insert(relay.to_string(), RelayApi::NoApi);
                    self.logger.ops("api.relay-without-api", &Fields::new().with("relay", relay), Level::Info);
                    return true;
                }
                Err(_) => return false,
            }
            // revision 4 2.3 item 1: the one request before the catch-up, read-only on the relay
            let report = match link.request(relay, "api-features", json!({}), CALL_MS) {
                Ok(v) => Report::of_answer(&v, now),
                Err(LinkError::Refused { code, .. }) if code == "fleet-op" => Some(Report::old(now)),
                Err(_) => return false,
            };
            if !self.take_features(relay, report.unwrap_or_else(|| Report::old(now))) {
                return false;
            }
        }
        let spokes = self.is_spokes(relay);
        let orgs: Vec<String> = {
            let inner = self.inner.lock();
            match inner.relays.get(relay) {
                // API-1d 5.1: a spokes relay waits for a map that lists it; until then nothing of that org is sent
                Some(RelayApi::Heads(h)) => h.keys().filter(|org| !spokes || Self::spokes_listed(&inner, relay, org)).cloned().collect(),
                _ => Vec::new(),
            }
        };
        // then, in the reconnect catch-up only, per org the checkpoint certificate and the backfill of the relay's
        // audit chains (9.3, 12.2); later deliveries carry maps and journal entries alone
        let done = orgs.iter().all(|org| self.sync_org(link, relay, org, now) && (!unknown || self.audit_org(link, relay, org, now)));
        if unknown && self.audit.get().is_some() {
            // a relay that stays connected has its certificates checked again hourly (`audit_tick`)
            self.inner.lock().checkpoint_at.insert(relay.to_string(), now + CHECKPOINT_EVERY);
        }
        done && self.synced(link, relay, &orgs)
    }

    /// `api-synced` after a catch-up that fully succeeded (2.5, 12.2). An older relay's `fleet-op` counts as done.
    fn synced(&self, link: &dyn FleetLink, relay: &str, orgs: &[String]) -> bool {
        let body: Map<String, Value> = {
            let inner = self.inner.lock();
            // revision 4 2.3 item 5: an org whose map the relay cannot take holds it to the seq it has
            let held = |org: &str| match inner.relays.get(relay) {
                Some(RelayApi::Heads(h)) => h.get(org).map_or(0, |x| x.0),
                _ => 0,
            };
            orgs.iter()
                .map(|org| {
                    let seq = if inner.withheld.contains(&(relay.to_string(), org.clone())) { held(org) } else { inner.store.get(org, "").map_or(0, |m| m.seq) };
                    (org.clone(), json!({ "seq": seq, "tseq": inner.orgs.get(org).map_or(0, OrgJournal::head) }))
                })
                .collect()
        };
        match link.request(relay, "api-synced", json!({ "orgs": body }), CALL_MS) {
            Ok(_) => true,
            Err(LinkError::Refused { code, .. }) if code == "fleet-op" => true,
            Err(LinkError::Refused { code, .. }) => {
                self.logger.ops("api.sync.not-synced", &Fields::new().with("relay", relay).with("code", code.as_str()), Level::Warn);
                false
            }
            Err(_) => false,
        }
    }

    /// The fleet's minute (`Fleet::tick`): every connected relay whose last `sync` did not fully succeed is synced
    /// again, each on its own thread, at most one per relay at a time.
    pub fn sync_tick(self: &Arc<Self>, link: Arc<dyn FleetLink>, now: i64) {
        let waiting: Vec<String> = {
            let inner = self.inner.lock();
            inner.unsynced.iter().filter(|r| !inner.sync_busy.contains(*r)).cloned().collect()
        };
        for relay in waiting.into_iter().filter(|r| link.connected(r)) {
            if !self.inner.lock().sync_busy.insert(relay.clone()) {
                continue;
            }
            let (me, link, r) = (self.clone(), link.clone(), relay.clone());
            let spawned = std::thread::Builder::new().name("api-sync-retry".into()).spawn(move || {
                me.sync(&*link, &r, now);
                me.inner.lock().sync_busy.remove(&r);
            });
            if spawned.is_err() {
                self.inner.lock().sync_busy.remove(&relay);
            }
        }
    }

    fn sync_org(&self, link: &dyn FleetLink, relay: &str, org: &str, now: i64) -> bool {
        let (key, map, base, entries) = {
            let inner = self.inner.lock();
            let Some(RelayApi::Heads(h)) = inner.relays.get(relay) else { return true };
            let Some(&(seq, tseq)) = h.get(org) else { return true };
            if tseq > inner.orgs.get(org).map_or(0, OrgJournal::head) {
                return true;
            }
            Self::plan(&inner, relay, org, seq, tseq)
        };
        // revision 4 2.3 items 3 and 5, checked again right before the send: a map goes only to a relay that reports
        // what it needs, and only while it is open for the org; a relay that cannot take it keeps the map it has and
        // still gets every journal entry it can read
        let map = match map {
            Some(m) => {
                let needs = crate::api_features::map_needs(&m["map"]);
                let mut inner = self.inner.lock();
                let fits = inner.sets.gate(org, &needs).is_ok() && needs.iter().all(|n| inner.sets.report_of(relay).is_some_and(|r| r.has(n)));
                let pair = (relay.to_string(), org.to_string());
                if fits {
                    inner.withheld.remove(&pair);
                    Some(m)
                } else {
                    let f = Fields::new().with("relay", relay).with("org", org).with("seq", m["map"]["seq"].as_i64().unwrap_or(0)).with("needs", needs.join(","));
                    self.logger.security("api.map.withheld", &f, Level::Warn);
                    inner.withheld.insert(pair);
                    if base.is_some() {
                        // the entries kept start above the pruned base, which reaches a relay only with the map
                        return false;
                    }
                    None
                }
            }
            None => {
                self.inner.lock().withheld.remove(&(relay.to_string(), org.to_string()));
                None
            }
        };
        // an entry journaled while its feature was open, for a relay that lost the feature since (a rollback): it gets
        // the entries before it, never one it cannot read
        let report = self.inner.lock().sets.report_of(relay).cloned();
        let unreadable = |e: &Value| {
            crate::api_features::relay_entry_gate(e["action"].as_str().unwrap_or_default(), &e["target"]).is_some_and(|(need, _, _)| !report.as_ref().is_some_and(|r| r.has(need)))
        };
        if let Some(i) = entries.iter().position(unreadable) {
            let f = Fields::new().with("relay", relay).with("org", org).with("tseq", entries[i]["tseq"].as_u64().unwrap_or(0));
            self.logger.security("api.journal.withheld", &f, Level::Warn);
            let sendable = entries[..i].to_vec();
            self.sync_send(link, relay, org, now, key, map, base, sendable);
            return false;
        }
        self.sync_send(link, relay, org, now, key, map, base, entries)
    }

    /// The sends of one org's catch-up, in order: the key, the map, then each entry; false when one failed.
    #[allow(clippy::too_many_arguments)]
    fn sync_send(&self, link: &dyn FleetLink, relay: &str, org: &str, now: i64, key: bool, map: Option<Value>, base: Option<u64>, entries: Vec<Value>) -> bool {
        if key {
            let Ok((pkv, k, not_before)) = self.pseudonym_key(org, now) else { return false };
            let body = json!({ "org": org, "pkv": pkv, "key": b64u(&k), "not_before": not_before });
            if link.request(relay, "api-pseudonym-key", body, CALL_MS).is_err() {
                return false;
            }
            self.note(org, now, |j| {
                j.keys.insert(relay.to_string(), pkv);
            });
        }
        if let Some(map) = map {
            let mut body = json!({ "org": org, "map": map.clone() });
            if let Some(b) = base {
                body["base"] = json!(b);
            }
            // API-1d 2.4: a spokes relay holds no Meet org CA; it verifies the map under the root the console used
            if self.is_spokes(relay) {
                match self.spokes_trust(org) {
                    Some(trust) => body["trust"] = trust,
                    None => {
                        self.logger.security("api.map.no-trust", &Fields::new().with("relay", relay).with("org", org), Level::Error);
                        return false;
                    }
                }
            }
            match link.request(relay, "api-map", body, CALL_MS) {
                Ok(a) => {
                    let seq = a.get("seq").and_then(Value::as_i64).unwrap_or_else(|| map["map"]["seq"].as_i64().unwrap_or(0));
                    self.set_head(relay, org, |h| h.0 = seq);
                    if let Some(b) = base {
                        // the relay rebased: it takes the kept entries from base + 1
                        let got = a.get("tseq").and_then(Value::as_u64).unwrap_or(b);
                        self.set_head(relay, org, |h| h.1 = got);
                        self.note(org, now, |j| {
                            let a = j.acks.entry(relay.to_string()).or_insert(got);
                            *a = (*a).max(got);
                        });
                    }
                }
                Err(LinkError::Refused { code, .. }) if code == "conflict" => {
                    let seq = map["map"]["seq"].as_i64().unwrap_or(0);
                    let f = Fields::new().with("relay", relay).with("org", org).with("seq", seq).with("via", "relay");
                    self.logger.security("api.map.conflict", &f, Level::Error);
                    self.note_audit(vec![crate::fleet_agent::api_note_conflict(org, seq, Some(relay))], now);
                    return false;
                }
                Err(_) => return false,
            }
        }
        for e in entries {
            let tseq = e["tseq"].as_u64().unwrap_or(0);
            match link.request(relay, "api-tighten", json!({ "org": org, "entry": e }), CALL_MS) {
                Ok(a) => {
                    let got = a.get("tseq").and_then(Value::as_u64).unwrap_or(tseq);
                    self.set_head(relay, org, |h| h.1 = got);
                    self.note(org, now, |j| {
                        j.acks.insert(relay.to_string(), got);
                    });
                    // 12.3: the relay deleted its failover credential of the destination before acknowledging
                    if matches!(e["action"].as_str(), Some("destination_delete" | "destination_disable_failover")) {
                        self.failover_retired(org, e["target"].as_str().unwrap_or_default(), relay);
                    }
                }
                Err(_) => return false,
            }
        }
        true
    }

    /// Change an org's journal record, keep it on disk, then prune what that allows.
    fn note(&self, org: &str, now: i64, f: impl FnOnce(&mut OrgJournal)) {
        {
            let mut inner = self.inner.lock();
            let j = inner.orgs.entry(org.to_string()).or_default();
            f(j);
            if let Err(e) = self.save_acks(org, j) {
                self.logger.security("api.journal.ack-unsaved", &Fields::new().with("org", org).with("why", e.message), Level::Error);
            }
        }
        self.prune(org, now);
    }

    fn set_head(&self, relay: &str, org: &str, f: impl FnOnce(&mut (i64, u64))) {
        if let Some(RelayApi::Heads(h)) = self.inner.lock().relays.get_mut(relay) {
            if let Some(h) = h.get_mut(org) {
                f(h);
            }
        }
    }

    // ── API audit (9, 12.2): the console's own entries, the relays' chains and their checkpoint certificates ──

    /// The console's API audit chains and the issuer of relay checkpoint certificates (the console's Meet CA), set
    /// once at start; until then no fleet op touches audit and `audit_in` answers 503 `audit-unavailable`.
    pub fn set_audit(&self, audit: Arc<ApiAudit>, issue: IssueFn) {
        let _ = self.audit.set((audit, issue));
    }

    fn chains(&self) -> Option<&Arc<ApiAudit>> {
        self.audit.get().map(|(a, _)| a)
    }

    // ── events (revision 4 7) ──

    /// The console's event chains and feed index, set once at start; until then `events_in` answers 503 and
    /// `emit_event` records nothing.
    pub fn set_events(&self, events: Arc<crate::api_events::EventLog>) {
        let _ = self.events.set(events);
    }

    /// The console's event chains and feed index, once set.
    pub fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
        self.events.get().cloned()
    }

    /// Revision 4 7.1: one console event for `org` (`kind` a registry name the console emits, `data` exactly its
    /// registry fields), durable in the org's event chains and feed index before Some(its seq). Events never refuse
    /// what the console does: a failure is the security line `api.events.failed` and None. Later slices call this
    /// after their audit entry and before they report the effect anywhere else.
    pub fn emit_event(&self, org: &str, kind: &str, data: Value, now: i64) -> Option<u64> {
        // a console without fleet state opens no event chains (tests, a console that is starting)
        let events = self.events.get()?;
        events.emit(org, kind, data, now).map_err(|e| self.logger.security("api.events.failed", &Fields::new().with("org", org).with("type", kind).with("why", e.message), Level::Error)).ok()
    }

    /// `api-events` from a relay (revision 4 2.5): as `audit_in`, for its event chain; entries stored in all three
    /// forms join the org's feed index before the answer.
    pub fn events_in(&self, relay: &str, body: &Value) -> Result<Value, crate::fleet_wire::Refusal> {
        use crate::fleet_wire::Refusal;
        let events = self.events().ok_or_else(|| Refusal::new(503, "audit-unavailable", "The console's event chains are not open."))?;
        let bad = |why: &str| Refusal::new(400, "bad-chain", why);
        let org = body.get("org").and_then(Value::as_str).filter(|o| org_ok(o)).ok_or_else(|| bad("org is not an organization id"))?;
        if !self.serves_now(relay, org) {
            return Err(Refusal::new(403, "org-not-served", "This relay did not report that organization on this connection."));
        }
        let repr = body.get("repr").and_then(Value::as_str).and_then(Repr::of).ok_or_else(|| bad("repr must be as_is, pseudonymized or removed"))?;
        let first = body.get("first").and_then(Value::as_u64).filter(|f| *f >= 1).ok_or_else(|| bad("first must be a seq from 1"))?;
        let last = body.get("last").and_then(Value::as_u64).filter(|l| *l >= first).ok_or_else(|| bad("last must be a seq from first"))?;
        let entries = body.get("entries").and_then(Value::as_array).ok_or_else(|| bad("entries must be a list"))?;
        if entries.len() as u64 != last - first + 1 {
            return Err(bad("entries must hold first to last"));
        }
        match events.ingest(org, relay, repr, first, last, entries) {
            Ok(()) => Ok(json!({ "ok": true, "last": events.head(org, relay, repr).0 })),
            Err(IngestError::Gap(expected)) => Ok(json!({ "ok": false, "code": "gap", "expected": expected })),
            Err(IngestError::Invalid(why)) => {
                let f = Fields::new().with("relay", relay).with("org", org).with("repr", repr.as_str()).with("first", first).with("why", why.as_str());
                self.logger.security("api.events.ingest-refused", &f, Level::Error);
                Err(bad(&why))
            }
            Err(IngestError::Unavailable(why)) => Err(Refusal::new(503, "audit-unavailable", &why)),
        }
    }

    /// The backfill of one org's event chains of the relay (revision 4 2.5): `api-event-chains` pages from the heads
    /// the console holds, as `backfill_org`. A relay answering `fleet-op` (revision 3) is left alone until it
    /// reconnects. False when it did not end.
    fn backfill_events_org(&self, link: &dyn FleetLink, relay: &str, org: &str) -> bool {
        let Some(events) = self.events() else { return true };
        let key = (relay.to_string(), org.to_string());
        let set = |pending: bool| {
            let mut inner = self.inner.lock();
            if pending {
                inner.ev_backfill.insert(key.clone());
            } else {
                inner.ev_backfill.remove(&key);
            }
        };
        for _ in 0..PAGES_MAX {
            if self.inner.lock().no_events.contains(relay) {
                set(false);
                return true;
            }
            let after: Map<String, Value> = Repr::ALL.iter().map(|r| (r.as_str().to_string(), json!(events.head(org, relay, *r).0))).collect();
            let page = match link.request(relay, "api-event-chains", json!({ "org": org, "after": after }), CALL_MS) {
                Ok(p) => p,
                Err(LinkError::Refused { code, .. }) if code == "fleet-op" => {
                    self.inner.lock().no_events.insert(relay.to_string());
                    set(false);
                    return true;
                }
                Err(_) => {
                    set(true);
                    return false;
                }
            };
            for repr in Repr::ALL {
                let entries = page.get(repr.as_str()).and_then(Value::as_array).cloned().unwrap_or_default();
                let seq = |e: Option<&Value>| e.and_then(|e| e.get("seq")).and_then(Value::as_u64);
                let (Some(first), Some(last)) = (seq(entries.first()), seq(entries.last())) else { continue };
                if let Err(e) = events.ingest(org, relay, repr, first, last, &entries) {
                    let why = match e {
                        IngestError::Gap(n) => format!("gap: expected {n}"),
                        IngestError::Invalid(w) | IngestError::Unavailable(w) => w,
                    };
                    self.logger.security("api.events.backfill-refused", &Fields::new().with("relay", relay).with("org", org).with("repr", repr.as_str()).with("why", why), Level::Error);
                    set(false);
                    return false;
                }
            }
            if page.get("more") != Some(&Value::Bool(true)) {
                set(false);
                return true;
            }
        }
        set(true);
        false
    }

    /// Record the console's own notes (see `fleet_agent::api_record`).
    fn note_audit(&self, notes: Vec<crate::fleet_agent::ApiNote>, now: i64) {
        if notes.is_empty() || self.audit.get().is_none() {
            return;
        }
        crate::fleet_agent::api_record(self.chains().map(|a| &**a), notes, &self.logger, now);
    }

    /// `api-audit` from a relay (2.6, API1-S11): a batch of its own chain for one org (which it reported) and one
    /// representation, checked for continuity and hashes and stored durably before `{ok: true, last}` (`last` the
    /// console's head of that chain). A batch that does not start right after the stored head answers
    /// `{ok: false, code: "gap", expected}` and the relay sends again from `expected`; a broken chain is refused
    /// `bad-chain`; a storage failure is 503 `audit-unavailable`.
    pub fn audit_in(&self, relay: &str, body: &Value) -> Result<Value, crate::fleet_wire::Refusal> {
        use crate::fleet_wire::Refusal;
        let audit = self.chains().ok_or_else(|| Refusal::new(503, "audit-unavailable", "The console's audit chains are not open."))?;
        let bad = |why: &str| Refusal::new(400, "bad-chain", why);
        let org = body.get("org").and_then(Value::as_str).filter(|o| org_ok(o)).ok_or_else(|| bad("org is not an organization id"))?;
        if !self.serves_now(relay, org) {
            return Err(Refusal::new(403, "org-not-served", "This relay did not report that organization on this connection."));
        }
        let repr = body.get("repr").and_then(Value::as_str).and_then(Repr::of).ok_or_else(|| bad("repr must be as_is, pseudonymized or removed"))?;
        let first = body.get("first").and_then(Value::as_u64).filter(|f| *f >= 1).ok_or_else(|| bad("first must be a seq from 1"))?;
        let last = body.get("last").and_then(Value::as_u64).filter(|l| *l >= first).ok_or_else(|| bad("last must be a seq from first"))?;
        let entries = body.get("entries").and_then(Value::as_array).ok_or_else(|| bad("entries must be a list"))?;
        if entries.len() as u64 != last - first + 1 {
            return Err(bad("entries must hold first to last"));
        }
        match audit.ingest(org, relay, repr, first, last, entries) {
            Ok(()) => Ok(json!({ "ok": true, "last": audit.head(org, relay, repr).0 })),
            Err(IngestError::Gap(expected)) => Ok(json!({ "ok": false, "code": "gap", "expected": expected })),
            Err(IngestError::Invalid(why)) => {
                let f = Fields::new().with("relay", relay).with("org", org).with("repr", repr.as_str()).with("first", first).with("why", why.as_str());
                self.logger.security("api.audit.ingest-refused", &f, Level::Error);
                Err(bad(&why))
            }
            Err(IngestError::Unavailable(why)) => Err(Refusal::new(503, "audit-unavailable", &why)),
        }
    }

    /// Whether a relay answered an audit op `fleet-op` (an API-1a2 relay); marks it so until it reconnects.
    fn audit_refused(&self, relay: &str, e: &LinkError) -> bool {
        let old = matches!(e, LinkError::Refused { code, .. } if code == "fleet-op");
        if old {
            self.inner.lock().no_audit.insert(relay.to_string());
            self.logger.ops("api.relay-without-audit", &Fields::new().with("relay", relay), Level::Info);
        }
        old
    }

    /// Whether the relay listed `org` in its latest `api-heads` answer on its current connection (the orgs it serves
    /// now). Journal acknowledgments are history kept for pruning, not membership.
    pub fn serves_now(&self, relay: &str, org: &str) -> bool {
        matches!(self.inner.lock().relays.get(relay), Some(RelayApi::Heads(h)) if h.contains_key(org))
    }

    /// The audit part of the catch-up for one org the relay reported (9.3, 12.2): the checkpoint certificate, then
    /// the backfill of its chains (`backfill_org`; what it leaves goes on at the fleet's minute, so it never fails the
    /// catch-up). Nothing for a relay that answered an audit op `fleet-op` (until it reconnects) or while the console
    /// has no audit. False when the certificate's requests failed.
    fn audit_org(&self, link: &dyn FleetLink, relay: &str, org: &str, now: i64) -> bool {
        if self.audit.get().is_none() || self.inner.lock().no_audit.contains(relay) {
            return true;
        }
        if !self.checkpoint_org(link, relay, org, now) {
            return false;
        }
        self.backfill_org(link, relay, org);
        // revision 4 7.3: the relay's event chains (signed with the same checkpoint key)
        self.backfill_events_org(link, relay, org);
        true
    }

    /// The checkpoint certificate of one org (9.3): the relay answers a CSR when it has none or under 30 days are
    /// left; the console's Meet CA issues it, the console keeps it for `v1/audit/keys` and for checking the relay's
    /// checkpoints (`add_keys`, before the relay can sign with it), then the relay installs it. False when a request
    /// failed (a relay answering `fleet-op` is marked and counts as done).
    fn checkpoint_org(&self, link: &dyn FleetLink, relay: &str, org: &str, now: i64) -> bool {
        let Some((audit, issue)) = self.audit.get() else { return true };
        if self.inner.lock().no_audit.contains(relay) {
            return true;
        }
        match link.request(relay, "api-checkpoint-csr", json!({ "org": org }), CALL_MS) {
            Ok(a) => {
                if let Some(csr) = a.get("csr").and_then(Value::as_str).and_then(crate::codec::unb64u) {
                    let (cert, chain) = match issue(relay, org, &csr, now * 1000) {
                        Ok(c) => c,
                        Err(why) => {
                            self.logger.security("api.checkpoint.issue-failed", &Fields::new().with("relay", relay).with("org", org).with("why", why), Level::Error);
                            return false;
                        }
                    };
                    if let Err(e) = audit.add_keys(org, relay, &cert, &chain) {
                        self.logger.security("api.checkpoint.keys-unsaved", &Fields::new().with("relay", relay).with("org", org).with("why", e.message), Level::Error);
                        return false;
                    }
                    let body = json!({ "org": org, "cert": b64u(&cert), "chain": chain.iter().map(|c| b64u(c)).collect::<Vec<_>>() });
                    if let Err(e) = link.request(relay, "api-checkpoint-cert", body, CALL_MS) {
                        if let LinkError::Refused { code, error, .. } = &e {
                            self.logger.security("api.checkpoint.install-refused", &Fields::new().with("relay", relay).with("org", org).with("code", code.as_str()).with("why", error.as_str()), Level::Error);
                        }
                        return false;
                    }
                    self.logger.ops("api.checkpoint.installed", &Fields::new().with("relay", relay).with("org", org), Level::Info);
                }
            }
            Err(e) => return self.audit_refused(relay, &e),
        }
        true
    }

    /// The backfill of one org's chains of the relay (12.2): `api-chains` pages from the heads the console holds of
    /// each representation, at most `PAGES_MAX` in this run. A last page with `more: true` leaves the pair in
    /// `backfill` and `audit_tick` goes on from the stored heads; a page with `more: false` ends it. A link failure
    /// keeps it for the next tick; a refused page drops it (`api.audit.backfill-refused`). False when it did not end.
    fn backfill_org(&self, link: &dyn FleetLink, relay: &str, org: &str) -> bool {
        let Some(audit) = self.chains() else { return true };
        let key = (relay.to_string(), org.to_string());
        let set = |pending: bool| {
            let mut inner = self.inner.lock();
            if pending {
                inner.backfill.insert(key.clone());
            } else {
                inner.backfill.remove(&key);
            }
        };
        for _ in 0..PAGES_MAX {
            if self.inner.lock().no_audit.contains(relay) {
                set(false);
                return true;
            }
            let after: Map<String, Value> = Repr::ALL.iter().map(|r| (r.as_str().to_string(), json!(audit.head(org, relay, *r).0))).collect();
            let page = match link.request(relay, "api-chains", json!({ "org": org, "after": after }), CALL_MS) {
                Ok(p) => p,
                Err(e) => {
                    let old = self.audit_refused(relay, &e);
                    set(!old);
                    return old;
                }
            };
            for repr in Repr::ALL {
                let entries = page.get(repr.as_str()).and_then(Value::as_array).cloned().unwrap_or_default();
                let seq = |e: Option<&Value>| e.and_then(|e| e.get("seq")).and_then(Value::as_u64);
                let (Some(first), Some(last)) = (seq(entries.first()), seq(entries.last())) else { continue };
                if let Err(e) = audit.ingest(org, relay, repr, first, last, &entries) {
                    let why = match e {
                        IngestError::Gap(n) => format!("gap: expected {n}"),
                        IngestError::Invalid(w) | IngestError::Unavailable(w) => w,
                    };
                    self.logger.security("api.audit.backfill-refused", &Fields::new().with("relay", relay).with("org", org).with("repr", repr.as_str()).with("why", why), Level::Error);
                    set(false);
                    return false;
                }
            }
            if page.get("more") != Some(&Value::Bool(true)) {
                set(false);
                return true;
            }
        }
        set(true);
        false
    }

    /// The audit work due for one connected relay at `now`, run in the caller's thread under the relay's delivery
    /// gate (so maps and journal entries wait at most one bounded run): when its hourly check is due, the checkpoint
    /// certificate of every org it reported (`checkpoint_org`; again in an hour, or at the next tick after a failed
    /// request); then the backfills left with more (`backfill_org`, `PAGES_MAX` pages each).
    pub fn audit_work(&self, link: &dyn FleetLink, relay: &str, now: i64) {
        let gate = self.sending.lock().entry(relay.to_string()).or_default().clone();
        let _one = gate.lock();
        let (orgs, renew, backfill, ev_backfill) = {
            let inner = self.inner.lock();
            let Some(RelayApi::Heads(h)) = inner.relays.get(relay) else { return };
            if inner.no_audit.contains(relay) {
                return;
            }
            let renew = inner.checkpoint_at.get(relay).is_some_and(|at| now >= *at);
            let backfill: Vec<String> = inner.backfill.iter().filter(|(r, _)| r == relay).map(|(_, o)| o.clone()).filter(|o| h.contains_key(o)).collect();
            let ev_backfill: Vec<String> = inner.ev_backfill.iter().filter(|(r, _)| r == relay).map(|(_, o)| o.clone()).filter(|o| h.contains_key(o)).collect();
            (h.keys().cloned().collect::<Vec<String>>(), renew, backfill, ev_backfill)
        };
        if renew {
            let ok = orgs.iter().all(|org| self.checkpoint_org(link, relay, org, now));
            let next = if ok { now + CHECKPOINT_EVERY } else { now };
            self.inner.lock().checkpoint_at.insert(relay.to_string(), next);
        }
        for org in backfill {
            self.backfill_org(link, relay, &org);
        }
        for org in ev_backfill {
            self.backfill_events_org(link, relay, &org);
        }
    }

    /// The fleet's minute (`Fleet::tick`): `audit_work` for every connected relay that has any due, each on its own
    /// thread, at most one per relay at a time.
    pub fn audit_tick(self: &Arc<Self>, link: Arc<dyn FleetLink>, now: i64) {
        if self.audit.get().is_none() {
            return;
        }
        let due: Vec<String> = {
            let inner = self.inner.lock();
            inner
                .relays
                .iter()
                .filter(|(r, s)| matches!(s, RelayApi::Heads(_)) && !inner.no_audit.contains(*r) && !inner.audit_busy.contains(*r))
                .filter(|(r, _)| inner.checkpoint_at.get(*r).is_some_and(|at| now >= *at) || inner.backfill.iter().any(|(b, _)| b == *r) || inner.ev_backfill.iter().any(|(b, _)| b == *r))
                .map(|(r, _)| r.clone())
                .collect()
        };
        for relay in due.into_iter().filter(|r| link.connected(r)) {
            if !self.inner.lock().audit_busy.insert(relay.clone()) {
                continue;
            }
            let (me, link) = (self.clone(), link.clone());
            let r = relay.clone();
            let spawned = std::thread::Builder::new().name("api-audit-work".into()).spawn(move || {
                me.audit_work(&*link, &r, now);
                me.inner.lock().audit_busy.remove(&r);
            });
            if spawned.is_err() {
                self.inner.lock().audit_busy.remove(&relay);
            }
        }
    }

    // ── exports (11) ──

    /// The export engine's hook (`api_export::ExportEngine::refresh` and `credential_changed`), set once at start.
    pub fn set_export_hook(&self, hook: ExportHook) {
        let _ = self.export_hook.set(hook);
    }

    /// Call with the store's lock released (the engine reads `export_config`).
    fn export_changed(&self, credential: Option<(&str, &str)>) {
        if let Some(h) = self.export_hook.get() {
            h(credential);
        }
    }

    /// 11.1, 11.5, 13: the license edition the maps are held to (None: unknown) and every org with a pinned map:
    /// whether it serves (not set aside), the map's `expires`, its destinations and its active journal entries. Also
    /// sets the org's `lucid_api_clients{state}` gauge (10.1) from the same read (clients expired at `now` counted so).
    pub fn export_config(&self, now: i64) -> (Option<Edition>, Vec<crate::api_export::OrgConfig>) {
        let inner = self.inner.lock();
        let orgs = inner
            .store
            .issuers()
            .into_keys()
            .map(|org| {
                let suspended = |id: &str| inner.store.active(&org).iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(id));
                let mut counts = [("active", 0u64), ("suspended", 0), ("expired", 0)];
                for c in inner.store.clients(&org) {
                    let i = if c.get("state").and_then(Value::as_str) == Some("suspended") || suspended(c.get("id").and_then(Value::as_str).unwrap_or_default()) {
                        1
                    } else if c.get("expires").and_then(Value::as_i64).is_some_and(|e| e <= now) {
                        2
                    } else {
                        0
                    };
                    counts[i].1 += 1;
                }
                for (state, n) in counts {
                    crate::api_catalog::counters::set_api_clients(&org, state, n);
                }
                // an expired map still serves its destinations' config; the engine stops them at `expires` itself
                let serving = inner.store.get(&org, "");
                let destinations = serving.and_then(|m| m.map().get("destinations")).and_then(Value::as_array).cloned().unwrap_or_default();
                let expires = serving.map_or(0, |m| m.expires);
                crate::api_export::OrgConfig { serving: serving.is_some(), expires, destinations, active: inner.store.active(&org).to_vec(), org }
            })
            .collect();
        (inner.edition.flatten(), orgs)
    }

    /// 11.3: seal a destination's credential as `secret:<org>:<id>` (destination ids are unique only within one
    /// org's map) with its entry date and, for a vendor token or a service account key, its "rotate by" date (90
    /// days). The destination must be in the org's pinned map, or be `staged` (the entry of an unsigned staged save,
    /// so it can be tested before the save), with a `credential` the value fits. The value never enters a log, the
    /// map or the audit. The export engine makes the destination's sink again at once. Called by the Exports screen
    /// (slice 1a6).
    pub fn put_destination_credential(&self, org: &str, id: &str, staged: Option<&Value>, credential: crate::api_export_wire::Credential, now: i64) -> Result<(), String> {
        let entry = {
            let inner = self.inner.lock();
            inner.store.get(org, "").and_then(|m| m.map().get("destinations")?.as_array()?.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(id)).cloned())
        };
        // the staged entry is what the next save signs
        let entry = staged.filter(|d| d.get("id").and_then(Value::as_str) == Some(id)).cloned().or(entry);
        let Some(entry) = entry else { return Err("That destination is not in the organization's api map.".into()) };
        if entry.get("credential").is_none() || !crate::api_export::credential_fits(&entry, &credential) {
            return Err("That credential does not fit the destination's credential type.".into());
        }
        let sealed = crate::api_export::sealed_credential(&credential, now);
        vault_do(&*self.vault, |v| v.put(&crate::api_export::seal_name(org, id), stringify(&sealed).as_bytes()))?;
        self.logger.ops("exports.credential-stored", &Fields::new().with("org", org).with("destination", id), Level::Info);
        self.export_changed(Some((org, id)));
        Ok(())
    }

    // ── failover credentials (12.3): one per destination and relay, made on the relay, recorded here ──

    /// The destination's `credential.type` and name in the org's pinned map, which must mark it `failover: true`.
    fn failover_destination(&self, org: &str, destination: &str) -> Result<(String, String), String> {
        let d = {
            let inner = self.inner.lock();
            inner.store.get(org, "").and_then(|m| m.map().get("destinations")?.as_array()?.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(destination)).cloned())
        };
        let Some(d) = d else { return Err("That destination is not in the organization's api map.".into()) };
        if d.get("failover").and_then(Value::as_bool) != Some(true) {
            return Err("That destination is not marked for failover in the api map.".into());
        }
        let kind = d.pointer("/credential/type").and_then(Value::as_str).unwrap_or_default().to_string();
        if crate::api_failover::FailoverKind::of(&kind).is_none() {
            return Err("That destination's credential type has no failover credential.".into());
        }
        Ok((kind, d.get("name").and_then(Value::as_str).unwrap_or(destination).to_string()))
    }

    fn failover_save(&self, all: &BTreeMap<(String, String, String), FailoverRecord>) -> Result<(), String> {
        let Some(dir) = &self.dir else { return Ok(()) };
        fn failed<E>(_: E) -> String {
            "The failover records could not be written.".to_string()
        }
        crate::store::make_dir(dir).map_err(failed)?;
        let body = stringify(&json!({ "records": all.values().map(FailoverRecord::to_json).collect::<Vec<_>>() }));
        crate::fleet_local::write_durable(&dir.join(FAILOVER_FILE), body.as_bytes()).map_err(failed)
    }

    /// Change (or add) one record and flush the file; on a failed write the record is left as it was.
    fn failover_update(&self, org: &str, destination: &str, relay: &str, f: impl FnOnce(&mut FailoverRecord)) -> Result<(), String> {
        let mut all = self.failover.lock();
        let key = (org.to_string(), destination.to_string(), relay.to_string());
        let old = all.get(&key).cloned();
        let mut rec = old.clone().unwrap_or(FailoverRecord { org: org.into(), destination: destination.into(), relay: relay.into(), kind: String::new(), public_id: String::new(), not_before: 0, expires: 0, state: "pending", note: String::new() });
        f(&mut rec);
        all.insert(key.clone(), rec);
        if let Err(e) = self.failover_save(&all) {
            match old {
                Some(o) => all.insert(key, o),
                None => all.remove(&key),
            };
            return Err(e);
        }
        Ok(())
    }

    /// A refused or failed `api-failover`: an older relay (`fleet-op`) leaves the record pending with `FAILOVER_TOO_OLD`.
    fn failover_failed(&self, org: &str, destination: &str, relay: &str, kind: &str, e: LinkError) -> String {
        match e {
            LinkError::Refused { code, .. } if code == "fleet-op" => {
                let _ = self.failover_update(org, destination, relay, |r| {
                    if r.state != "armed" {
                        (r.kind, r.state, r.note) = (kind.to_string(), "pending", FAILOVER_TOO_OLD.to_string());
                    }
                });
                self.logger.ops("api.failover.relay-too-old", &Fields::new().with("org", org).with("destination", destination).with("relay", relay), Level::Warn);
                FAILOVER_TOO_OLD.to_string()
            }
            LinkError::Refused { code, error, .. } => {
                self.logger.security("api.failover.refused", &Fields::new().with("org", org).with("destination", destination).with("relay", relay).with("code", code.as_str()), Level::Error);
                error
            }
            LinkError::Offline => "The relay is not connected.".into(),
            _ => "The relay did not answer.".into(),
        }
    }

    /// 12.3: ask the relay for a certificate request for the destination's failover key (made on the relay, never
    /// leaving it); the admin registers the CSR with the tool. The record is `pending` (an armed one stays armed
    /// until the renewed certificate is installed). Called by the admin screen (slice 1a6).
    pub fn failover_request_csr(&self, link: &dyn FleetLink, org: &str, destination: &str, relay: &str) -> Result<String, String> {
        let (kind, _) = self.failover_destination(org, destination)?;
        if !crate::api_failover::FailoverKind::of(&kind).is_some_and(|k| k.uses_csr()) {
            return Err("This destination needs no certificate request. Enter its secret for this relay instead.".into());
        }
        let params = json!({ "type": kind, "subject_cn": format!("{destination}.{relay}") });
        let csr = match link.request(relay, "api-failover", json!({ "org": org, "destination": destination, "action": "csr", "params": params }), CALL_MS) {
            Ok(a) => a.get("csr").and_then(Value::as_str).filter(|c| c.contains("CERTIFICATE REQUEST")).map(str::to_string).ok_or_else(|| "The relay answered no certificate request.".to_string())?,
            Err(e) => return Err(self.failover_failed(org, destination, relay, &kind, e)),
        };
        self.failover_update(org, destination, relay, |r| {
            if r.state != "armed" {
                (r.kind, r.public_id, r.not_before, r.expires, r.state, r.note) = (kind.clone(), String::new(), 0, 0, "pending", String::new());
            }
        })?;
        self.logger.ops("api.failover.csr", &Fields::new().with("org", org).with("destination", destination).with("relay", relay), Level::Info);
        Ok(csr)
    }

    /// 12.3: install the failover credential on the relay: for a certificate kind `{cert_pem, chain_pem?}` (after a
    /// CSR from that relay), for a token `{token}` and for a service account key `{key_json}`, each entered for that
    /// relay only; with `expires` (unix seconds, at most 90 days from now) and the credential's non-secret fields.
    /// The record is `armed` only after the relay acknowledged, with the type, `public_id` (SPKI hash, token hint or
    /// `client_email:private_key_id`), `not_before` and `expires` the relay answered (its `expires` no later than the
    /// one asked, and after now). The material never enters a log or the record.
    pub fn failover_install(&self, link: &dyn FleetLink, org: &str, destination: &str, relay: &str, material: Value, now: i64) -> Result<(), String> {
        const KEYS: &[&str] = &["cert_pem", "chain_pem", "ca_pem", "token", "key_json", "expires", "tenant", "client_id", "cloud", "trust_anchor_arn", "profile_arn", "role_arn", "region"];
        let (kind, _) = self.failover_destination(org, destination)?;
        let Value::Object(m) = material else { return Err("The credential must be an object.".into()) };
        let asked = m.get("expires").and_then(Value::as_i64).filter(|e| *e > now && *e <= now + FAILOVER_MAX_S).ok_or_else(|| "The failover credential must end within 90 days from now.".to_string())?;
        let s = |k: &str| m.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
        // the one secret this kind takes, and the others it refuses
        let (secret, others, missing): (&str, &[&str], &str) = match crate::api_failover::FailoverKind::of(&kind) {
            Some(k) if k.uses_csr() => ("cert_pem", &["token", "key_json"], "Paste the certificate (PEM) issued for this relay's request."),
            Some(crate::api_failover::FailoverKind::GcpServiceAccountKey) => ("key_json", &["cert_pem", "chain_pem", "ca_pem", "token"], "Paste the service account key (JSON) for this relay."),
            _ => ("token", &["cert_pem", "chain_pem", "ca_pem", "key_json"], "Enter the token for this relay."),
        };
        if s(secret).is_none() || (secret == "cert_pem" && !s(secret).is_some_and(|c| c.contains("BEGIN CERTIFICATE"))) {
            return Err(missing.into());
        }
        if let Some(k) = others.iter().find(|k| m.contains_key(**k)) {
            return Err(format!("This destination does not take {k}."));
        }
        if secret == "cert_pem" && self.failover.lock().get(&(org.to_string(), destination.to_string(), relay.to_string())).is_none_or(|r| r.state == "deleted") {
            return Err("Ask this relay for a certificate request first.".into());
        }
        let expected = failover_public_id(secret, &m).ok_or_else(|| missing.to_string())?;
        let params: Map<String, Value> = m.iter().filter(|(k, _)| KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        let answer = match link.request(relay, "api-failover", json!({ "org": org, "destination": destination, "action": "install", "params": params }), CALL_MS) {
            Ok(a) => a,
            Err(e) => return Err(self.failover_failed(org, destination, relay, &kind, e)),
        };
        // the relay's record of what it installed, taken as answered once it fits what was sent
        let got = (
            answer.get("ok").and_then(Value::as_bool),
            answer.get("type").and_then(Value::as_str),
            answer.get("public_id").and_then(Value::as_str),
            answer.get("not_before").and_then(Value::as_i64),
            answer.get("expires").and_then(Value::as_i64),
        );
        let (Some(true), Some(t), Some(public_id), Some(not_before), Some(expires)) = got else {
            self.logger.security("api.failover.answer-unusable", &Fields::new().with("org", org).with("destination", destination).with("relay", relay), Level::Error);
            return Err("The relay installed the credential but answered no usable record of it. Install it again.".into());
        };
        if t != kind || public_id != expected || expires > asked || expires <= now || not_before > expires {
            self.logger.security("api.failover.answer-unusable", &Fields::new().with("org", org).with("destination", destination).with("relay", relay), Level::Error);
            return Err("The relay's record of the installed credential does not match what was asked. Install it again.".into());
        }
        let public_id = public_id.to_string();
        self.failover_update(org, destination, relay, |r| {
            (r.kind, r.public_id, r.not_before, r.expires, r.state, r.note) = (kind.clone(), public_id, not_before, expires, "armed", String::new());
        })?;
        self.logger.ops("api.failover.armed", &Fields::new().with("org", org).with("destination", destination).with("relay", relay).with("expires", expires), Level::Info);
        Ok(())
    }

    /// 12.3: delete the destination's failover credential (and its failover queue) on the relay; the record is
    /// `deleted` after the relay acknowledged. Allowed whatever the map says now (it only ever removes).
    pub fn failover_delete(&self, link: &dyn FleetLink, org: &str, destination: &str, relay: &str) -> Result<(), String> {
        if !org_ok(org) {
            return Err("That is not an organization id.".into());
        }
        if let Err(e) = link.request(relay, "api-failover", json!({ "org": org, "destination": destination, "action": "delete", "params": {} }), CALL_MS) {
            let kind = self.failover.lock().get(&(org.to_string(), destination.to_string(), relay.to_string())).map(|r| r.kind.clone()).unwrap_or_default();
            return Err(self.failover_failed(org, destination, relay, &kind, e));
        }
        self.failover_retired(org, destination, relay);
        Ok(())
    }

    /// The relay acknowledged the deletion (an `api-failover` delete or a retiring journal entry): the record of
    /// that destination on that relay is `deleted`.
    fn failover_retired(&self, org: &str, destination: &str, relay: &str) {
        let key = (org.to_string(), destination.to_string(), relay.to_string());
        if self.failover.lock().get(&key).is_none_or(|r| r.state == "deleted") {
            return;
        }
        if let Err(why) = self.failover_update(org, destination, relay, |r| (r.state, r.note) = ("deleted", String::new())) {
            self.logger.security("api.failover.record-unsaved", &Fields::new().with("org", org).with("destination", destination).with("relay", relay).with("why", why), Level::Error);
        }
        self.logger.ops("api.failover.deleted", &Fields::new().with("org", org).with("destination", destination).with("relay", relay), Level::Info);
    }

    /// 12.3: the failover credential records of an org (for the admin screen).
    pub fn failover_records(&self, org: &str) -> Vec<FailoverRecord> {
        self.failover.lock().values().filter(|r| r.org == org).cloned().collect()
    }

    /// 12.3: armed records within 14 days of `expires` (`days_left`, rounded up), or past it (None: the relay
    /// stops using it on its own).
    pub fn failover_attention(&self, now: i64) -> Vec<FailoverAttention> {
        let due: Vec<FailoverRecord> = self.failover.lock().values().filter(|r| r.state == "armed" && r.expires - now <= FAILOVER_RENEW_S).cloned().collect();
        let inner = self.inner.lock();
        due.into_iter()
            .map(|r| {
                let name = inner
                    .store
                    .get(&r.org, "")
                    .and_then(|m| m.map().get("destinations")?.as_array()?.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(r.destination.as_str()))?.get("name")?.as_str().map(str::to_string))
                    .unwrap_or_else(|| r.destination.clone());
                let days_left = (r.expires > now).then(|| (r.expires - now + 86_399).div_euclid(86_400));
                FailoverAttention { org: r.org, destination: name, relay: r.relay, days_left }
            })
            .collect()
    }

    fn sealed_destination(&self, org: &str, id: &str) -> Option<Value> {
        let raw = vault_do(&*self.vault, |v| v.get(&crate::api_export::seal_name(org, id)))?;
        parse_json(std::str::from_utf8(&raw).ok()?)
    }

    /// 11.3: whether a destination's credential is sealed (and reads).
    pub fn has_destination_credential(&self, org: &str, id: &str) -> bool {
        self.destination_credential(org, id).is_some()
    }

    /// The sealed credential of a destination, for its sink only.
    pub fn destination_credential(&self, org: &str, id: &str) -> Option<crate::api_export_wire::Credential> {
        crate::api_export::credential_of(self.sealed_destination(org, id)?.get("credential")?)
    }

    /// 11.3: the "rotate by" date (unix seconds) of a destination's vendor token or service account key.
    pub fn destination_credential_rotate_by(&self, org: &str, id: &str) -> Option<i64> {
        self.sealed_destination(org, id)?.get("rotate_by")?.as_i64()
    }

    /// A deleted destination's sealed credential goes with it.
    pub fn delete_destination_credential(&self, org: &str, id: &str) {
        if let Err(e) = vault_do(&*self.vault, |v| v.remove(&crate::api_export::seal_name(org, id))) {
            self.logger.ops("exports.credential-not-removed", &Fields::new().with("org", org).with("destination", id).with("why", e), Level::Error);
        }
    }

    // ── 3.4 ──

    /// The `relay` grace of the fleet verifier at `now` (seconds): the minimum of `grace.relay` (lowered by the
    /// journal) over every org map the console holds; 0 when it holds none or any of them has expired.
    pub fn relay_grace_hours(&self, now: i64) -> u32 {
        let inner = self.inner.lock();
        let orgs = inner.store.issuers();
        orgs.keys().map(|o| inner.store.grace_hours(o, "relay", now).unwrap_or(0)).min().unwrap_or(0)
    }

    /// 3.3 for an API client certificate: the smallest `app` grace (hours) of the orgs its SAN names, an org without a
    /// pinned unexpired map counting 0; 0 for a certificate naming none.
    pub fn app_grace_hours(&self, orgs: &[String], now: i64) -> u32 {
        let inner = self.inner.lock();
        orgs.iter().map(|o| inner.store.grace_hours(o, "app", now).unwrap_or(0)).min().unwrap_or(0)
    }

    // ── the front door's issuer (5.1 to 5.5) ──

    fn sealed_issuer_key(&self, org: &str, kid: &str) -> Option<EcdsaKeyPair> {
        let pkcs8 = vault_do(&*self.vault, |v| v.get(&issuer_seal_name(org, kid)))?;
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8).ok()
    }

    /// The org's issuer signing key, drawn once (P-256 on AWS-LC) and sealed as `api-issuer-<org>-<kid>`; Ok is its
    /// public JWK, for an admin to list in the map's `issuer.jwks` with its `nbf` and `exp`. A held key whose sealed
    /// value no longer opens is replaced by a new one. The private key never leaves the sealed store or this process.
    pub fn issuer_public_jwk(&self, org: &str) -> Result<Value, String> {
        if !org_ok(org) {
            return Err("that is not an organization id".into());
        }
        let held = self.inner.lock().orgs.get(org).and_then(|j| j.issuer_kid.clone());
        if let Some(kid) = held {
            if let Some(pair) = self.sealed_issuer_key(org, &kid) {
                return Ok(api_issue::ec_public_jwk(&pair, &kid));
            }
        }
        let kid = format!("i-{}", b64u(&crate::console_auth::random(6).ok_or("no random bytes")?));
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).map_err(|_| "the issuer key could not be drawn".to_string())?;
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).map_err(|_| "the issuer key does not read".to_string())?;
        vault_do(&*self.vault, |v| v.put(&issuer_seal_name(org, &kid), pkcs8.as_ref()))?;
        let mut inner = self.inner.lock();
        let j = inner.orgs.entry(org.to_string()).or_default();
        j.issuer_kid = Some(kid.clone());
        self.save_acks(org, j).map_err(|e| e.message)?;
        Ok(api_issue::ec_public_jwk(&pair, &kid))
    }

    /// The key the console signs the org's access tokens with (5.3): a sealed issuer key whose `kid` the pinned map
    /// lists in `issuer.jwks` with the same public point and inside that entry's `nbf`/`exp`, the latest `nbf` first.
    /// Err is `issuer-key-unlisted`.
    pub fn issuer_key(&self, org: &str, now: i64) -> Result<(EcdsaKeyPair, String), &'static str> {
        let listed: Vec<Value> = {
            let inner = self.inner.lock();
            inner.store.get(org, "").and_then(|m| m.map().get("issuer")?.get("jwks")?.as_array().cloned()).unwrap_or_default()
        };
        let int = |k: &Value, f: &str| k.get(f).and_then(Value::as_i64);
        let mut live: Vec<&Value> = listed.iter().filter(|k| int(*k, "nbf").is_some_and(|n| n <= now) && int(*k, "exp").is_some_and(|e| now < e)).collect();
        live.sort_by_key(|k| std::cmp::Reverse(int(*k, "nbf")));
        for k in live {
            let Some(kid) = k.get("kid").and_then(Value::as_str) else { continue };
            let Some(pair) = self.sealed_issuer_key(org, kid) else { continue };
            let mine = api_issue::ec_public_jwk(&pair, kid);
            if mine.get("x") == k.get("x") && mine.get("y") == k.get("y") {
                return Ok((pair, kid.to_string()));
            }
        }
        Err("issuer-key-unlisted")
    }

    /// API-1d 7.1.2: the keys a card of `org` is signed with now, in `kid` order: the pinned map's `a2a.jwks` entries
    /// with `nbf <= now < exp`, not under an active `a2a_key_drop`, sealed here (`console_a2a::seal_name`) with the
    /// same public point.
    pub fn a2a_keys(&self, org: &str, now: i64) -> Vec<(String, EcdsaKeyPair)> {
        let listed: Vec<Value> = {
            let inner = self.inner.lock();
            inner.store.get(org, "").and_then(|m| m.map().get("a2a")?.get("jwks")?.as_array().cloned()).unwrap_or_default()
        };
        let active = self.console_active(org);
        let mut out: Vec<(String, EcdsaKeyPair)> = crate::console_a2a::usable(&listed, &active, now)
            .into_iter()
            .filter_map(|k| {
                let kid = k.get("kid")?.as_str()?;
                let pair = crate::console_a2a::sealed_key(&*self.vault, org, kid)?;
                let mine = api_issue::ec_public_jwk(&pair, kid);
                (mine.get("x") == k.get("x") && mine.get("y") == k.get("y")).then(|| (kid.to_string(), pair))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// API-1d 7.1.5: the org's pinned map (the `map` object) and its seq while its cards may be served: pinned and not
    /// set aside, unexpired at `now`, and not under `api_off`.
    pub fn a2a_serving(&self, org: &str, now: i64) -> Option<(Value, i64)> {
        let inner = self.inner.lock();
        let m = inner.store.get(org, "").filter(|m| m.expires > now && !inner.store.is_off(org))?;
        Some((Value::Object(m.map().clone()), m.seq))
    }

    /// 6.5 on the front door's public routes outside `api_document` (API-1d 7.1.5): the source limiter; Err is the
    /// seconds to wait.
    pub fn public_source_ok(&self, source: IpAddr, now: i64) -> Result<(), i64> {
        self.issue.source_ok(source, now)
    }

    /// A read-only copy of one org's api state for the front door's routes: None unless the org has a pinned map or
    /// one set aside (6.1 `license` then answers).
    pub fn org_snapshot(&self, org: &str) -> Option<ApiMapStore> {
        let inner = self.inner.lock();
        (org_ok(org) && (inner.store.get(org, "").is_some() || inner.store.is_set_aside(org))).then(|| inner.store.org_snapshot(org))
    }

    /// The orgs with a pinned map, sorted.
    pub fn orgs(&self) -> Vec<String> {
        self.inner.lock().store.issuers().keys().cloned().collect()
    }

    /// The relays that serve an org, sorted: every relay that reported it (its acknowledgments) and every connected
    /// relay whose api heads list it.
    pub fn relays_of(&self, org: &str) -> Vec<String> {
        let inner = self.inner.lock();
        let mut out: std::collections::BTreeSet<String> = inner.orgs.get(org).map(|j| j.acks.keys().cloned().collect()).unwrap_or_default();
        out.extend(inner.relays.iter().filter(|(_, s)| matches!(s, RelayApi::Heads(h) if h.contains_key(org))).map(|(r, _)| r.clone()));
        out.into_iter().collect()
    }

    /// 5.1 and the 6.1 Public pipeline: None for an org without a pinned map (404 `not-found`); then the source
    /// limiter (429 `abuse`); then the document from the pinned map, whose `issuer.url` is I.
    pub fn api_document(&self, org: &str, doc: ApiDoc, source: IpAddr, now: i64) -> Option<Answer> {
        if !org_ok(org) {
            return None;
        }
        let (issuer, federation) = {
            let inner = self.inner.lock();
            let m = inner.store.get(org, "")?.map();
            (m.get("issuer").cloned().unwrap_or(Value::Null), m.get("federation").cloned().unwrap_or(Value::Null))
        };
        if let Err(s) = self.issue.source_ok(source, now) {
            let mut a = api_issue::problem(429, "abuse", "Too many requests from this address; try again later.");
            a.headers.push(("Retry-After", s.to_string()));
            return Some(a);
        }
        let i = issuer.get("url").and_then(Value::as_str).unwrap_or_default();
        let body = match doc {
            ApiDoc::AuthorizationServer => api_issue::console_as_metadata(i),
            ApiDoc::McpResource => crate::api_delegated::mcp_metadata(i, org),
            // directory.* tokens are for the SSO service's SCIM resource S, never for I (revision 4 4.3)
            ApiDoc::ProtectedResource => api_issue::resource_metadata(i, &[i], &crate::api_map::SCOPES.iter().copied().filter(|s| !s.starts_with("directory.")).collect::<Vec<_>>()),
            ApiDoc::Jwks => api_issue::jwks(issuer.get("jwks").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)),
            // revision 4 8.1: served only when the org's federation issuer is I/federation, else 404
            ApiDoc::FederationDiscovery | ApiDoc::FederationJwks => {
                let map = json!({ "issuer": issuer, "federation": federation });
                match crate::api_federation::front_door_document(&map, &self.console_active(org), doc == ApiDoc::FederationJwks) {
                    Some(b) => b,
                    None => return Some(api_issue::problem(404, "not-found", "Nothing is here.")),
                }
            }
            // revision 4 7.3: public; a key under `webhook_key_drop` leaves at once (2.4)
            ApiDoc::WebhookKeys => {
                let keys = self.inner.lock().store.get(org, "").and_then(|m| m.map().get("webhook_keys").cloned());
                crate::api_webhook::published(keys.as_ref(), &self.console_active(org))
            }
        };
        Some(api_issue::document(body))
    }

    /// 5.2 (`revoke` false) and 5.5 (`revoke` true) on the front door for the org of the request path. None for an org
    /// without a pinned map (404 `not-found`, after the source limiter). `body_refused` is the port's verdict on a body
    /// it could not take (`too-large`, `request`). The issuer key must be listed in the pinned map (503
    /// `issuer-key-unlisted`). The store is a snapshot, so no lock is held while a JWKS or discovery fetch runs. A
    /// revocation is journaled as `token_deny` (`until` = the token's `exp`) and sent to the org's relays. `licensed`
    /// is the console's own license state (6.1 `license`). `audit(client, jti, until)` records a revocation in the
    /// org's chain before it is journaled (9.4); its failure answers 503 `audit-unavailable`. `host` (revision 5 6) opens
    /// the delegated grants and the M, C and CM resources; None refuses them (`grant`, `target`).
    #[allow(clippy::too_many_arguments)]
    pub fn api_token(
        self: &Arc<Self>,
        link: Option<Arc<dyn FleetLink>>,
        org: &str,
        revoke: bool,
        http: &TokenHttp,
        body_refused: Option<&'static str>,
        owner_active: &dyn Fn(&str) -> bool,
        licensed: bool,
        audit: &dyn Fn(&str, &str, i64) -> Result<(), String>,
        host: Option<&dyn crate::api_delegated::DelegatedHost>,
        now: i64,
    ) -> Option<Answer> {
        let store = self.org_snapshot(org);
        let refuse = |code: &'static str, why: &str, retry: Option<i64>| api_issue::refusal(org, http.source, None, code, why, retry);
        let abuse = |s: i64| refuse("abuse", "Too many requests from this address.", Some(s));
        let Some(store) = store else {
            return self.issue.source_ok(http.source, now).err().map(abuse);
        };
        let key = if body_refused.is_none() { self.issuer_key(org, now).ok() } else { None };
        let Some((key, kid)) = key else {
            if let Err(s) = self.issue.source_ok(http.source, now) {
                return Some(abuse(s));
            }
            let code = if licensed { api_issue::closed(&store, org, now).or(body_refused).unwrap_or("issuer-key-unlisted") } else { "license" };
            let why = match code {
                "license" => api_issue::LICENSE_WHY,
                "too-large" => "The request body is larger than 16 KiB.",
                "request" => "The request body is not an application/x-www-form-urlencoded form.",
                "issuer-key-unlisted" => "The console's issuer key is not listed in the organization's api map.",
                c => api_issue::closed_why(c),
            };
            return Some(refuse(code, why, None));
        };
        let issuer = store.get(org, "").and_then(|m| Some(m.map().get("issuer")?.get("url")?.as_str()?.to_string())).unwrap_or_default();
        let endpoint = format!("{issuer}/oauth/token");
        let mut resources = vec![issuer.clone()];
        resources.extend(store.relay_origins(org).into_iter().flatten().filter_map(|(_, o)| o.as_str()).map(|o| format!("{}/api/orgs/{org}", o.trim_end_matches('/'))));
        let delegated = host.map(|host| crate::api_delegated::Delegated { host, state: &self.delegated });
        let ctx = IssueCtx {
            org,
            issuer: &issuer,
            token_endpoint: &endpoint,
            resources: &resources,
            local_scopes: None,
            key: &key,
            kid: &kid,
            store: &store,
            owner_active,
            fetch: &self.fetch,
            state: &self.issue,
            licensed,
            now,
            delegated: delegated.as_ref(),
        };
        if !revoke {
            return Some(api_issue::token(&ctx, http));
        }
        // 9.4: the revocation is in the org's audit chain before the journal entry is written
        let journal = |client: &str, jti: &str, until: i64| -> Result<(), (&'static str, String)> {
            audit(client, jti, until).map_err(|e| ("audit-unavailable", e))?;
            self.append(link.clone(), org, "token_deny", json!({"client": client, "jti": jti}), Some(until), now).map(|_| ()).map_err(|e| ("journal", e.message))
        };
        Some(api_issue::revoke(&ctx, http, &journal))
    }

    // ── person-delegated OAuth (revision 5 4.2, 4.3, 6) ──

    /// Revision 5 4.3: `api-subject` over the fleet link to a relay of the org connected now (any: the record is
    /// self-verifying), the next one when one fails; Err when none is connected or none answered.
    pub fn api_subject(&self, link: Option<Arc<dyn FleetLink>>, org: &str, request: &Value) -> Result<Value, String> {
        let link = link.ok_or("the console has no fleet link")?;
        let mut last = "no relay of the organization is connected".to_string();
        for relay in self.relays_of(org).into_iter().filter(|r| self.serves_now(r, org)) {
            match link.request(&relay, "api-subject", request.clone(), CALL_MS) {
                Ok(answer) => return Ok(answer),
                Err(e) => last = format!("{relay}: {e:?}"),
            }
        }
        Err(last)
    }

    /// Revision 5 6.1, 6.4: `api-org-policy {org}` over the fleet link to the relays of the org connected now, in turn;
    /// each answer is verified under the console's Meet CA `root` as it arrives (`api_delegated::first_verified_policy`),
    /// so a relay that fails or answers with a policy that does not verify passes to the next. Ok(None) when the relays
    /// hold no policy; Err when none is connected or none answered with one that verifies.
    pub fn api_org_policy(&self, link: Option<Arc<dyn FleetLink>>, org: &str, root: &crate::api_delegated::Root, now: i64) -> Result<Option<crate::meet_org_policy::Obj>, String> {
        let link = link.ok_or("the console has no fleet link")?;
        let answers = self.relays_of(org).into_iter().filter(|r| self.serves_now(r, org)).map(|relay| {
            let answer = link.request(&relay, "api-org-policy", json!({"org": org}), CALL_MS).map_err(|e| format!("{e:?}"));
            (relay, answer)
        });
        crate::api_delegated::first_verified_policy(answers, root, org, now)
    }

    /// Revision 5 4.6, 6.5: the Authorize pipeline (`GET oauth/authorize`, `POST oauth/sso-return`, `GET` and `POST
    /// oauth/consent`) on a snapshot of the org's store; None for an org without a pinned map (404). Every decision is
    /// in the org's chain through `host.audit` before the answer.
    #[allow(clippy::too_many_arguments)]
    pub fn api_authorize(
        &self,
        org: &str,
        route: crate::api_delegated::AuthzRoute,
        http: &crate::api_delegated::AuthzHttp,
        owner_active: &dyn Fn(&str) -> bool,
        licensed: bool,
        host: &dyn crate::api_delegated::DelegatedHost,
        now: i64,
    ) -> Option<crate::api_resource::Reply> {
        let store = self.org_snapshot(org)?;
        let d = crate::api_delegated::Delegated { host, state: &self.delegated };
        let limiter = |ip: IpAddr| self.issue.source_ok(ip, now);
        let ctx = crate::api_delegated::AuthzCtx { org, store: &store, d: &d, fetch: &self.fetch, limiter: &limiter, owner_active, licensed, now };
        Some(crate::api_delegated::authorize(&ctx, route, http))
    }

    /// Revision 5 4.2 (R5-3, R5-6): journal `person_revoke {client, principal}` (`client` a `c_` id or `*`), then end
    /// that person's refresh families of the client (every client for `*`) at once. Called for an admin's revocation,
    /// a person's Stop, a deprovisioned person (`api_people`) and `drop_delegation`.
    pub fn person_revoke(&self, org: &str, client: &str, principal: &str, now: i64) -> Result<Value, ApiMapError> {
        let principal = principal.trim().to_lowercase();
        let e = self.append_console(org, "person_revoke", json!({"client": client, "principal": principal}), now)?;
        let ended = self.delegated.end_families(org, now, &|f| (client == "*" || f.client == client) && f.person.eq_ignore_ascii_case(&principal), "person_revoke");
        if let Err(f) = ended {
            // the entry stands (every refresh is refused `person` by 6.1); the families end at their next use
            self.logger.security("api.consent.unended", &Fields::new().with("org", org).with("why", f.why), Level::Error);
        }
        Ok(e)
    }

    /// Revision 5 4.2 (R5-6): journal `client_drop_delegation {client, <what>: value}` (`what` `group`, `principal`
    /// or `idp`), then `person_revoke` for each principal with a live refresh family or a delegated token in the last
    /// 10 minutes through that way in who is not still allowed by another listed group or principal. Ok is the
    /// principals revoked. The admin's client update journals it (`console_fleet::api_journal`, slice 1c7).
    pub fn drop_delegation(&self, org: &str, client: &str, what: &str, value: &str, now: i64) -> Result<Vec<String>, ApiMapError> {
        if !matches!(what, "group" | "principal" | "idp") {
            return Err(ApiMapError::new("not-tightening", "a delegation is dropped by group, principal or idp"));
        }
        let mut target = json!({"client": client});
        target[what] = json!(value);
        self.append_console(org, "client_drop_delegation", target, now)?;
        let affected = self.delegated.through(org, client, &format!("{what}:{value}"), now).map_err(|f| ApiMapError::new("io", f.why))?;
        let active = self.console_active(org);
        let pinned = self.inner.lock().store.get(org, "").and_then(|m| m.map().get("clients")?.as_array()?.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(client)).cloned());
        let mut revoked = Vec::new();
        for (principal, groups) in affected {
            let still = pinned.as_ref().and_then(Value::as_object).is_some_and(|c| crate::api_delegated::still_allowed(c, client, &principal, &groups, &active));
            if !still {
                self.person_revoke(org, client, &principal, now)?;
                revoked.push(principal);
            }
        }
        Ok(revoked)
    }

    /// Revision 5 14.1 `GET settings/api/delegations`: each person's delegated grant uses of the org in the last 24
    /// hours (of `client` only, when given) with their live refresh families' ends (`DelegatedState::uses`).
    pub fn delegation_uses(&self, org: &str, client: Option<&str>, now: i64) -> Result<Vec<crate::api_delegated::Use>, String> {
        self.delegated.uses(org, client, now).map_err(|f| f.why)
    }

    /// Revision 5 14.1 `POST settings/api/idps/test`: the IdP's discovery (`<issuer>/.well-known/openid-configuration`,
    /// else `/.well-known/oauth-authorization-server`, naming exactly `issuer`) and its `jwks_uri`, fetched under 1a 8.1
    /// with the front door's fetch cache. Ok is (jwks_uri, keys); nothing is kept but the test time and key count
    /// (`idp_tested`).
    pub fn idp_test(&self, issuer: &str, private_ok: bool) -> Result<(String, Vec<Value>), String> {
        let base = issuer.trim_end_matches('/');
        let mut last = "The identity provider's discovery document could not be fetched.".to_string();
        for path in ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"] {
            match api_issue::fetch_doc(&self.fetch, &format!("{base}{path}"), private_ok) {
                Ok(doc) => {
                    let named = doc.get("issuer").and_then(Value::as_str) == Some(issuer);
                    let Some(uri) = doc.get("jwks_uri").and_then(Value::as_str).filter(|_| named) else {
                        last = "The identity provider's discovery document names another issuer or no jwks_uri.".to_string();
                        continue;
                    };
                    let keys = api_issue::fetch_doc(&self.fetch, uri, private_ok).map_err(|r| r.why)?;
                    return Ok((uri.to_string(), api_issue::keys_of(&keys)));
                }
                Err(r) => last = r.why,
            }
        }
        Err(last)
    }

    /// Keep the last IdP test of (org, issuer): when (seconds) and how many keys it found (memory only).
    pub fn idp_tested(&self, org: &str, issuer: &str, at: i64, keys: usize) {
        self.idp_tests.lock().insert((org.to_string(), issuer.to_string()), (at, keys));
    }

    /// The last IdP test of (org, issuer) this console ran since it started: (when, key count).
    pub fn idp_last_test(&self, org: &str, issuer: &str) -> Option<(i64, usize)> {
        self.idp_tests.lock().get(&(org.to_string(), issuer.to_string())).copied()
    }
}

/// 9.3: the console's api audit reads each org's sealed pseudonym key (never draws one) through a weak reference, so
/// the audit held by `ConsoleApi` makes no cycle.
pub struct ConsolePseudonymKeys(pub Weak<ConsoleApi>);

impl crate::api_audit::PseudonymKeys for ConsolePseudonymKeys {
    fn current(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        let api = self.0.upgrade()?;
        if !org_ok(org) {
            return None;
        }
        let name = crate::fleet_agent::api_pseudonym_seal_name(org, PSEUDONYM_PKV);
        vault_do(&*api.vault, |v| v.get(&name)).map(|k| (PSEUDONYM_PKV as u32, k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_map::api_map_hash;
    use crate::fleet_ca::MemVault;
    use crate::fleet_wire::Refusal;

    const NOW: i64 = 1_795_000_000;
    const RELAY: &str = "r_00000000000000b1";
    const OTHER: &str = "r_00000000000000b2";
    const CLIENT: &str = "c_5f1a2b3c4d5e6f70";
    const VECTORS: &str = include_str!("../tests/api_map_v1.json");

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-console-api-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn map_folding(seq: i64, relay_grace: i64, expires: i64, folded: &[&str]) -> VerifiedApiMap {
        let m = json!({"v": 1, "org": "acme", "seq": seq, "issued": NOW - 10, "expires": expires,
                       "issuer": {"url": "https://console.acme.example:7443/api/orgs/acme", "jwks": []},
                       "grace": {"person": 0, "app": 24, "connector": 0, "relay": relay_grace},
                       "failover_after_s": 300, "folded": folded, "cleared": [], "clients": [], "destinations": []});
        let wire = json!({"map": m, "sig": "", "chain": []});
        VerifiedApiMap { org: "acme".into(), seq, expires, hash: api_map_hash(&wire["map"]), signer: "root".into(), wire: wire.as_object().unwrap().clone() }
    }

    fn map(seq: i64, relay_grace: i64, expires: i64) -> VerifiedApiMap {
        map_folding(seq, relay_grace, expires, &[])
    }

    /// API-1 11.3: a destination credential is sealed as `secret:<org>:<id>` with its "rotate by" date, must fit the
    /// map's credential type, never reaches a log line, and the export engine's hook hears of it.
    #[test]
    fn destination_credentials_are_sealed_fit_the_map_and_are_never_logged() {
        use crate::api_export_wire::Credential;
        let (log, lines) = logger();
        let api = Arc::new(ConsoleApi::open(None, log, vault()));
        let d = "d_9a8b7c6d5e4f3a2b";
        let mut vm = map(1, 0, NOW + 86_400);
        vm.wire["map"]["destinations"] = json!([{"id": d, "name": "Splunk HEC", "kind": "splunk_hec", "preset": "splunk_hec", "signals": ["audit"],
            "ceiling": "internal", "identities": "pseudonymized", "failover": false, "private_ok": false,
            "endpoint": "https://hec.acme.example:8088/services/collector/event", "credential": {"type": "token", "ref": format!("secret:{d}")},
            "queue": {"max_bytes": 1_073_741_824u64, "max_age_s": 259_200}}]);
        vm.hash = api_map_hash(&vm.wire["map"]);
        api.publish_verified(None, vm, NOW).unwrap();
        let heard: Arc<Mutex<Vec<Option<(String, String)>>>> = Arc::default();
        let h = heard.clone();
        api.set_export_hook(Box::new(move |k: Option<(&str, &str)>| h.lock().push(k.map(|(o, i)| (o.to_string(), i.to_string())))));
        assert!(api.put_destination_credential("acme", d, None, Credential::Mtls { cert_pem: "C".into(), key_pem: "K".into(), ca_pem: None }, NOW).is_err());
        assert!(api.put_destination_credential("acme", "d_0000000000000000", None, Credential::Token("x".into()), NOW).is_err());
        assert!(api.put_destination_credential("beta", d, None, Credential::Token("x".into()), NOW).is_err(), "another org has no such destination");
        // a staged destination (not pinned yet) holds its credential so it can be tested before the save
        let staged = json!({"id": "d_1111111111111111", "kind": "splunk_hec", "preset": "splunk_hec", "credential": {"type": "token", "ref": "secret:d_1111111111111111"}});
        api.put_destination_credential("beta", "d_1111111111111111", Some(&staged), Credential::Token("staged-secret".into()), NOW).unwrap();
        assert!(api.has_destination_credential("beta", "d_1111111111111111"));
        heard.lock().clear();
        assert!(!api.has_destination_credential("acme", d));
        api.put_destination_credential("acme", d, None, Credential::Token("hec-secret-value".into()), NOW).unwrap();
        assert!(api.has_destination_credential("acme", d));
        assert!(!api.has_destination_credential("beta", d), "the same id in another org is another secret");
        assert_eq!(api.destination_credential_rotate_by("acme", d), Some(NOW + 90 * 86_400));
        assert!(matches!(api.destination_credential("acme", d), Some(Credential::Token(t)) if t == "hec-secret-value"));
        assert_eq!(*heard.lock(), vec![Some(("acme".to_string(), d.to_string()))]);
        assert!(lines.lock().iter().all(|l| !l.contains("hec-secret-value")));
        let (edition, orgs) = api.export_config(NOW);
        assert_eq!(edition, None);
        assert_eq!((orgs.len(), orgs[0].serving, orgs[0].destinations.len(), orgs[0].expires), (1, true, 1, NOW + 86_400));
        api.delete_destination_credential("acme", d);
        assert!(!api.has_destination_credential("acme", d));
    }

    type Lines = Arc<Mutex<Vec<String>>>;

    fn logger() -> (Arc<Logger>, Lines) {
        let lines: Lines = Arc::default();
        let l = lines.clone();
        (Arc::new(Logger::capture("console", Box::new(move |line, _| l.lock().push(line.to_string())))), lines)
    }

    /// A relay behind the channel: its own store (on disk), sealed store and the relay handlers of fleet_agent; `old`
    /// answers every api op `fleet-op` as a relay before API-1 does.
    struct FakeRelay {
        id: &'static str,
        org: String,
        old: bool,
        up: Mutex<bool>,
        dir: PathBuf,
        store: Mutex<ApiMapStore>,
        vault: Arc<Mutex<MemVault>>,
        sent: Mutex<Vec<(String, Value)>>,
        heads: Mutex<Option<Value>>,
        logger: Arc<Logger>,
        /// The relay's own audit chains (API-1 9); `api-chains` pages hold at most `page` entries per representation.
        audit: Mutex<Option<Arc<ApiAudit>>>,
        page: usize,
        /// An API-1a2 relay: api ops but no audit op (`fleet-op`).
        no_audit: bool,
        /// The relay's clock for its checkpoint renewal check (`api-checkpoint-csr`).
        csr_now: Mutex<i64>,
        /// See `caught_up`.
        caught_up: Mutex<bool>,
        /// The failover retirement of a `destination_delete` or `destination_disable_failover` entry fails.
        fail_retire: Mutex<bool>,
        /// The next applied `api-tighten` answers an error instead (an answer lost after the entry was applied).
        lose_answer: Mutex<bool>,
        /// The `api-features` answer (None: this build's, `api_features::relay_answer`; `Some(Null)`: `fleet-op`, as a
        /// revision 3 relay answers it while it knows every other api op).
        features: Mutex<Option<Value>>,
    }

    impl FakeRelay {
        fn new(id: &'static str, org: &str, dir: &Path, logger: Arc<Logger>) -> FakeRelay {
            FakeRelay { id, org: org.to_string(), old: false, up: Mutex::new(true), dir: dir.to_path_buf(), store: Mutex::new(ApiMapStore::load(Some(dir))), vault: Arc::new(Mutex::new(MemVault::default())), sent: Mutex::new(Vec::new()), heads: Mutex::new(None), logger, audit: Mutex::new(None), page: 2, no_audit: false, csr_now: Mutex::new(NOW), caught_up: Mutex::new(false), fail_retire: Mutex::new(false), lose_answer: Mutex::new(false), features: Mutex::new(None) }
        }

        /// The ops sent, without the `api-synced` that ends every catch-up that fully succeeded (see `caught_up`) and the
        /// `api-features` that follows every `api-heads` (revision 4 2.3).
        fn ops(&self) -> Vec<String> {
            self.sent.lock().iter().map(|(op, _)| op.clone()).filter(|op| op != "api-synced" && op != "api-features").collect()
        }

        /// As `fleet_agent::api_caught_up`: set by an accepted `api-synced`, cleared by `api-heads`, a failed
        /// `api-tighten` or `api-map`, and a reconnect.
        fn caught_up(&self) -> bool {
            *self.caught_up.lock()
        }

        fn heads_now(&self) -> Value {
            let (seq, tseq) = self.store.lock().head(&self.org);
            let mut o = Map::new();
            o.insert(self.org.clone(), json!({ "seq": seq, "tseq": tseq }));
            Value::Object(o)
        }

        fn answer(&self, op: &str, body: &Value) -> Result<Value, Refusal> {
            if self.old && op.starts_with("api-") {
                return Err(Refusal::of("fleet-op"));
            }
            if self.no_audit && matches!(op, "api-chains" | "api-checkpoint-csr" | "api-checkpoint-cert") {
                return Err(Refusal::of("fleet-op"));
            }
            match op {
                "api-chains" => match self.audit.lock().clone() {
                    Some(a) => crate::fleet_agent::api_chains_page(&a, body, self.page),
                    None => Ok(json!({ "org": self.org, "as_is": [], "pseudonymized": [], "removed": [], "more": false })),
                },
                "api-checkpoint-csr" => crate::fleet_agent::api_checkpoint_csr_answer(&self.dir, &*self.vault, body, *self.csr_now.lock()),
                "api-checkpoint-cert" => crate::fleet_agent::api_checkpoint_cert_answer(&self.dir, &*self.vault, body),
                "api-heads" => {
                    *self.caught_up.lock() = false;
                    Ok(self.heads.lock().clone().unwrap_or_else(|| self.heads_now()))
                }
                // read-only: leaves the catch-up state as it is
                "api-features" => match self.features.lock().clone() {
                    Some(Value::Null) => Err(Refusal::of("fleet-op")),
                    Some(v) => Ok(v),
                    None => Ok(crate::api_features::relay_answer(Vec::new())),
                },
                "api-synced" => {
                    // what the relay holds on disk for every org asked about
                    let store = self.store.lock();
                    let held: Map<String, Value> = body["orgs"].as_object().into_iter().flatten().map(|(org, _)| (org.clone(), { let (seq, tseq) = store.head(org); json!({ "seq": seq, "tseq": tseq }) })).collect();
                    drop(store);
                    let r = crate::fleet_agent::api_synced_answer(&Value::Object(held), body);
                    *self.caught_up.lock() = r.is_ok();
                    r
                }
                "api-failover" => crate::fleet_agent::api_failover_answer(&self.dir, &*self.vault, body, NOW),
                "api-tighten" => {
                    let retiring = matches!(body["entry"]["action"].as_str(), Some("destination_delete" | "destination_disable_failover"));
                    // as the relay: check, retire and apply under the store's lock
                    let mut store = self.store.lock();
                    let applied = store.head(body["org"].as_str().unwrap_or_default()).1;
                    let r = if retiring && *self.fail_retire.lock() {
                        Err(Refusal::new(500, "io", "The failover credential could not be deleted."))
                    } else {
                        crate::fleet_agent::api_tighten_retire_failover(&self.dir, &*self.vault, applied, body).and_then(|_| crate::fleet_agent::api_tighten_answer(&mut store, body, &mut Vec::new()))
                    };
                    drop(store);
                    // applied, but the answer never reached the console
                    let r = match r {
                        Ok(_) if std::mem::take(&mut *self.lose_answer.lock()) => Err(Refusal::new(504, "timeout", "The answer was lost.")),
                        r => r,
                    };
                    if r.is_err() {
                        *self.caught_up.lock() = false;
                    }
                    r
                }
                "api-pseudonym-key" => crate::fleet_agent::api_pseudonym_key_store(&self.dir, &*self.vault, body),
                "api-map" => {
                    let wire = body["map"].as_object().unwrap().clone();
                    let m = &wire["map"];
                    let vm = VerifiedApiMap { org: m["org"].as_str().unwrap().into(), seq: m["seq"].as_i64().unwrap(), expires: m["expires"].as_i64().unwrap(), hash: api_map_hash(m), signer: "root".into(), wire: wire.clone() };
                    let mut store = self.store.lock();
                    let r = store.pin(vm);
                    crate::fleet_agent::api_map_pinned(r, &mut store, body, &self.logger, &mut Vec::new())
                }
                _ => Ok(json!({})),
            }
        }
    }

    /// The channels of several fake relays.
    struct Fleet(Vec<Arc<FakeRelay>>);

    impl Fleet {
        fn of(&self, relay: &str) -> Option<&Arc<FakeRelay>> {
            self.0.iter().find(|r| r.id == relay && *r.up.lock())
        }
    }

    impl FleetLink for Fleet {
        fn request(&self, relay: &str, op: &str, body: Value, _timeout_ms: u64) -> Result<Value, LinkError> {
            let r = self.of(relay).ok_or(LinkError::Offline)?;
            r.sent.lock().push((op.to_string(), body.clone()));
            r.answer(op, &body).map_err(|r| LinkError::Refused { status: r.status, code: r.code, error: r.error })
        }
        fn event(&self, relay: &str, _op: &str, _body: Value) -> bool {
            self.of(relay).is_some()
        }
        fn connected(&self, relay: &str) -> bool {
            self.of(relay).is_some()
        }
        fn close(&self, _relay: &str, _code: u16) {}
    }

    fn vault() -> Arc<dyn VaultLock> {
        Arc::new(Mutex::new(MemVault::default()))
    }

    fn wait_for(f: impl Fn() -> bool) -> bool {
        for _ in 0..300 {
            if f() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        f()
    }

    fn one(d: &Path, log: &Arc<Logger>) -> (Arc<FakeRelay>, Arc<dyn FleetLink>) {
        let relay = Arc::new(FakeRelay::new(RELAY, "acme", &d.join("relay"), log.clone()));
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![relay.clone()]));
        (relay, link)
    }

    // ── API-1 12.3: failover credentials ──

    const D_CERT: &str = "d_0123456789abcdef";
    const D_TOKEN: &str = "d_9a8b7c6d5e4f3a2b";
    const D_GCP: &str = "d_00000000000000a1";
    const FAILOVER_TOKEN: &str = "failover-token-secret-7f3a";

    fn failover_map(seq: i64, failover: bool) -> VerifiedApiMap {
        let mut vm = map(seq, 12, NOW + 30 * 86_400);
        let dest = |id: &str, kind: &str, preset: &str, cred: &str, endpoint: &str| {
            json!({"id": id, "name": format!("Dest {id}"), "kind": kind, "preset": preset, "signals": ["audit"], "ceiling": "internal",
                   "identities": "as_is", "failover": failover, "private_ok": false, "endpoint": endpoint,
                   "credential": {"type": cred, "ref": format!("secret:{id}")}, "queue": {"max_bytes": 1_073_741_824u64, "max_age_s": 259_200}})
        };
        vm.wire["map"]["destinations"] = json!([
            dest(D_CERT, "otlp", "otlp_generic", "mtls", "https://collector.acme.example:4318"),
            dest(D_TOKEN, "splunk_hec", "splunk_hec", "token", "https://hec.acme.example:8088/services/collector/event"),
            dest(D_GCP, "otlp", "google_cloud", "gcp_service_account_key", "https://telemetry.googleapis.com"),
        ]);
        vm.hash = api_map_hash(&vm.wire["map"]);
        vm
    }

    fn failover_setup(name: &str, failover: bool) -> (PathBuf, Lines, Arc<FakeRelay>, Arc<dyn FleetLink>, Arc<ConsoleApi>) {
        let d = temp(name);
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.publish_verified(None, failover_map(1, failover), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        (d, lines, relay, link, api)
    }

    fn record(api: &ConsoleApi, destination: &str) -> Option<FailoverRecord> {
        api.failover_records("acme").into_iter().find(|r| r.destination == destination && r.relay == RELAY)
    }

    fn token_material(expires: i64) -> Value {
        json!({ "token": FAILOVER_TOKEN, "expires": expires })
    }

    fn relay_holds(relay: &FakeRelay, destination: &str) -> bool {
        crate::api_failover::failover_credential(&relay.dir, &*relay.vault, "acme", destination, NOW).is_some()
    }

    #[test]
    fn failover_csr_round_trips_through_the_relay_and_stays_pending() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-csr", true);
        let csr = api.failover_request_csr(&*link, "acme", D_CERT, RELAY).unwrap();
        assert!(csr.contains("BEGIN CERTIFICATE REQUEST"), "{csr}");
        let sent = relay.sent.lock().iter().rev().find(|(op, _)| op == "api-failover").cloned().unwrap().1;
        assert_eq!((sent["action"].as_str(), sent["params"]["type"].as_str()), (Some("csr"), Some("mtls")));
        let r = record(&api, D_CERT).unwrap();
        assert_eq!((r.state, r.kind.as_str(), r.public_id.as_str()), ("pending", "mtls", ""));
        // a token or service account key destination takes no CSR
        assert!(api.failover_request_csr(&*link, "acme", D_TOKEN, RELAY).is_err());
        assert!(api.failover_request_csr(&*link, "acme", D_GCP, RELAY).is_err());
    }

    #[test]
    fn failover_install_arms_only_after_the_relay_acknowledged_and_never_logs_the_material() {
        let (d, lines, relay, link, api) = failover_setup("failover-install", true);
        // more than 90 days is refused before anything is sent
        assert!(api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 91 * 86_400), NOW).is_err());
        assert!(!relay.ops().contains(&"api-failover".to_string()));
        // offline: no ack, nothing armed
        *relay.up.lock() = false;
        assert!(api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).is_err());
        assert!(record(&api, D_TOKEN).is_none_or(|r| r.state != "armed"));
        *relay.up.lock() = true;
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).unwrap();
        // the record is the relay's answer: its token hint, its clock's not_before, the expires it took
        let r = record(&api, D_TOKEN).unwrap();
        assert_eq!((r.state, r.kind.as_str(), r.expires), ("armed", "token", NOW + 30 * 86_400));
        assert!(r.public_id.starts_with("sha256:") && !r.public_id.contains(FAILOVER_TOKEN), "{}", r.public_id);
        assert!(r.not_before > 0 && r.not_before <= r.expires);
        assert!(relay_holds(&relay, D_TOKEN));
        // a token where a certificate or key is due, and a key where a token is due, are refused before sending
        let sent = relay.ops().len();
        assert!(api.failover_install(&*link, "acme", D_TOKEN, RELAY, json!({"token": FAILOVER_TOKEN, "key_json": "{}", "expires": NOW + 86_400}), NOW).is_err());
        assert!(api.failover_install(&*link, "acme", D_GCP, RELAY, token_material(NOW + 86_400), NOW).is_err());
        assert_eq!(relay.ops().len(), sent);
        // durable, and the material is in no log line and not in the record file
        let again = ConsoleApi::open(Some(&d.join("console")), logger().0, vault());
        assert_eq!(record(&again, D_TOKEN), Some(r));
        assert!(lines.lock().iter().all(|l| !l.contains(FAILOVER_TOKEN)));
        assert!(!std::fs::read_to_string(d.join("console").join(FAILOVER_FILE)).unwrap().contains(FAILOVER_TOKEN));
        // a certificate kind needs this relay's CSR first
        assert!(api.failover_install(&*link, "acme", D_CERT, RELAY, json!({"cert_pem": "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n", "expires": NOW + 86_400}), NOW).is_err());
    }

    #[test]
    fn failover_is_refused_for_a_destination_without_failover() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-refused", false);
        assert!(api.failover_request_csr(&*link, "acme", D_CERT, RELAY).is_err());
        assert!(api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 86_400), NOW).is_err());
        assert!(api.failover_request_csr(&*link, "acme", "d_ffffffffffffffff", RELAY).is_err());
        assert!(!relay.ops().contains(&"api-failover".to_string()));
        assert!(api.failover_records("acme").is_empty());
    }

    #[test]
    fn failover_delete_marks_deleted_after_the_ack() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-delete", true);
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).unwrap();
        *relay.up.lock() = false;
        assert!(api.failover_delete(&*link, "acme", D_TOKEN, RELAY).is_err());
        assert_eq!(record(&api, D_TOKEN).unwrap().state, "armed");
        *relay.up.lock() = true;
        api.failover_delete(&*link, "acme", D_TOKEN, RELAY).unwrap();
        assert_eq!(record(&api, D_TOKEN).unwrap().state, "deleted");
        assert!(!relay_holds(&relay, D_TOKEN));
    }

    #[test]
    fn disabling_failover_in_the_journal_deletes_on_the_relay_before_the_ack() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-journal", true);
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).unwrap();
        assert!(relay_holds(&relay, D_TOKEN));
        api.append(Some(link.clone()), "acme", "destination_disable_failover", json!(D_TOKEN), None, NOW).unwrap();
        assert!(wait_for(|| api.acked(RELAY, "acme") == 1));
        assert!(wait_for(|| record(&api, D_TOKEN).is_some_and(|r| r.state == "deleted")));
        assert!(!relay_holds(&relay, D_TOKEN), "deleted on the relay before it acknowledged");
    }

    #[test]
    fn failover_attention_at_14_days_and_at_expiry() {
        let (_d, _lines, _relay, link, api) = failover_setup("failover-attention", true);
        let expires = NOW + 20 * 86_400;
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(expires), NOW).unwrap();
        assert!(api.failover_attention(NOW).is_empty());
        assert!(api.failover_attention(expires - 14 * 86_400 - 1).is_empty());
        let soon = api.failover_attention(expires - 14 * 86_400);
        assert_eq!(soon.len(), 1);
        assert_eq!((soon[0].destination.as_str(), soon[0].relay.as_str(), soon[0].days_left), (format!("Dest {D_TOKEN}").as_str(), RELAY, Some(14)));
        assert_eq!(api.failover_attention(expires - 1)[0].days_left, Some(1));
        assert_eq!(api.failover_attention(expires)[0].days_left, None);
    }

    #[test]
    fn an_older_relay_keeps_the_failover_record_pending_as_too_old() {
        let d = temp("failover-old");
        let (log, _lines) = logger();
        let mut fake = FakeRelay::new(RELAY, "acme", &d.join("relay"), log.clone());
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.publish_verified(None, failover_map(1, true), NOW).unwrap();
        fake.old = true;
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![Arc::new(fake)]));
        assert_eq!(api.failover_request_csr(&*link, "acme", D_CERT, RELAY).unwrap_err(), FAILOVER_TOO_OLD);
        let r = record(&api, D_CERT).unwrap();
        assert_eq!((r.state, r.note.as_str()), ("pending", FAILOVER_TOO_OLD));
        assert_eq!(api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 86_400), NOW).unwrap_err(), FAILOVER_TOO_OLD);
        assert_eq!(record(&api, D_TOKEN).unwrap().state, "pending");
    }

    #[test]
    fn a_gcp_service_account_key_is_armed_with_the_relays_public_id() {
        let (_d, lines, relay, link, api) = failover_setup("failover-gcp", true);
        let key = json!({"type": "service_account", "project_id": "acme-prod", "private_key_id": "kid1", "private_key": "-----BEGIN PRIVATE KEY-----\nMIIsecretsecret\n-----END PRIVATE KEY-----\n",
                         "client_email": "lucid@acme-prod.iam.gserviceaccount.com", "token_uri": "https://oauth2.googleapis.com/token"})
        .to_string();
        assert!(api.failover_install(&*link, "acme", D_GCP, RELAY, json!({"cert_pem": "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n", "expires": NOW + 86_400}), NOW).is_err());
        api.failover_install(&*link, "acme", D_GCP, RELAY, json!({"key_json": key, "expires": NOW + 30 * 86_400}), NOW).unwrap();
        let r = record(&api, D_GCP).unwrap();
        assert_eq!((r.state, r.kind.as_str(), r.public_id.as_str(), r.expires), ("armed", "gcp_service_account_key", "lucid@acme-prod.iam.gserviceaccount.com:kid1", NOW + 30 * 86_400));
        assert!(relay_holds(&relay, D_GCP));
        assert!(lines.lock().iter().all(|l| !l.contains("secretsecret")));
    }

    /// A channel whose relay answers `api-failover` install with `answer` (after really installing).
    struct InstallAnswer(Arc<dyn FleetLink>, Value);

    impl FleetLink for InstallAnswer {
        fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, LinkError> {
            let install = op == "api-failover" && body["action"] == "install";
            let a = self.0.request(relay, op, body, timeout_ms)?;
            Ok(if install { self.1.clone() } else { a })
        }
        fn event(&self, relay: &str, op: &str, body: Value) -> bool {
            self.0.event(relay, op, body)
        }
        fn connected(&self, relay: &str) -> bool {
            self.0.connected(relay)
        }
        fn close(&self, relay: &str, code: u16) {
            self.0.close(relay, code)
        }
    }

    #[test]
    fn an_install_answer_that_does_not_fit_the_request_arms_nothing() {
        let (_d, lines, _relay, link, api) = failover_setup("failover-answer", true);
        let asked = NOW + 30 * 86_400;
        // the token hint the relay must answer for the token sent
        let hint = format!("sha256:{}", &crate::codec::sha256_hex(FAILOVER_TOKEN.as_bytes())[..8]);
        let bad = [
            json!({"ok": true}),
            json!({"type": "token", "public_id": hint, "not_before": NOW, "expires": asked}),
            json!({"ok": false, "type": "token", "public_id": hint, "not_before": NOW, "expires": asked}),
            json!({"ok": true, "type": "mtls", "public_id": hint, "not_before": NOW, "expires": asked}),
            json!({"ok": true, "type": "token", "public_id": "sha256:abcd1234", "not_before": NOW, "expires": asked}),
            json!({"ok": true, "type": "token", "public_id": "", "not_before": NOW, "expires": asked}),
            json!({"ok": true, "type": "token", "public_id": hint, "not_before": NOW, "expires": asked + 1}),
            json!({"ok": true, "type": "token", "public_id": hint, "not_before": NOW - 10, "expires": NOW}),
        ];
        for answer in bad {
            let lying: Arc<dyn FleetLink> = Arc::new(InstallAnswer(link.clone(), answer.clone()));
            assert!(api.failover_install(&*lying, "acme", D_TOKEN, RELAY, token_material(asked), NOW).is_err(), "{answer}");
            assert!(record(&api, D_TOKEN).is_none_or(|r| r.state != "armed"), "{answer}");
        }
        assert!(lines.lock().iter().any(|l| l.contains("api.failover.answer-unusable")));
        assert!(lines.lock().iter().all(|l| !l.contains("abcd1234") && !l.contains(hint.as_str())), "no answered value is quoted");
        // a clamped expires is taken as answered
        let fits: Arc<dyn FleetLink> = Arc::new(InstallAnswer(link.clone(), json!({"ok": true, "type": "token", "public_id": hint, "not_before": NOW, "expires": asked - 5})));
        api.failover_install(&*fits, "acme", D_TOKEN, RELAY, token_material(asked), NOW).unwrap();
        let r = record(&api, D_TOKEN).unwrap();
        assert_eq!((r.state, r.public_id.as_str(), r.not_before, r.expires), ("armed", hint.as_str(), NOW, asked - 5));
    }

    #[test]
    fn the_console_computes_the_public_id_of_each_material() {
        let m = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(failover_public_id("token", &m(json!({"token": "abc"}))), Some(format!("sha256:{}", &crate::codec::sha256_hex(b"abc")[..8])));
        let key = json!({"client_email": "lucid@acme-prod.iam.gserviceaccount.com", "private_key_id": "kid1", "private_key": "x"}).to_string();
        assert_eq!(failover_public_id("key_json", &m(json!({"key_json": key}))).as_deref(), Some("lucid@acme-prod.iam.gserviceaccount.com:kid1"));
        assert_eq!(failover_public_id("key_json", &m(json!({"key_json": "not json"}))), None);
        assert_eq!(failover_public_id("cert_pem", &m(json!({"cert_pem": "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n"}))), None);
        // a certificate (structure only) around a key's SubjectPublicKeyInfo: the SHA-256 of that SPKI
        use crate::fleet_x509 as x509;
        let spki = x509::Key::generate(x509::Curve::P256).unwrap().spki();
        let seq = |parts: &[Vec<u8>]| x509::der(0x30, &parts.concat());
        let alg = seq(&[x509::der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])]);
        let name = x509::name(&[(x509::OID_CN, "acme-tool")]);
        let tbs = seq(&[x509::der(0xa0, &x509::der(0x02, &[2])), x509::integer(&[0x41, 1, 2, 3]), alg.clone(), name.clone(), seq(&[x509::time((NOW - 60) * 1000), x509::time((NOW + 86_400) * 1000)]), name, spki.clone()]);
        let pem = crate::meet_x509::der_to_pem(&seq(&[tbs, alg, x509::der(0x03, &[0, 1, 2, 3])]));
        assert_eq!(failover_public_id("cert_pem", &m(json!({"cert_pem": pem}))), Some(crate::codec::sha256_hex(&spki)));
    }

    #[test]
    fn the_relay_stays_behind_after_a_failed_retire_until_a_retried_sync_ends_with_api_synced() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-synced", true);
        assert!(relay.caught_up(), "a catch-up that fully succeeded ends with an accepted api-synced");
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).unwrap();
        // offline while failover is disabled; on reconnect the retirement fails
        *relay.up.lock() = false;
        api.append(Some(link.clone()), "acme", "destination_disable_failover", json!(D_TOKEN), None, NOW).unwrap();
        *relay.up.lock() = true;
        *relay.fail_retire.lock() = true;
        api.on_welcomed(RELAY);
        assert!(!api.sync(&*link, RELAY, NOW));
        assert!(!relay.caught_up(), "not caught up: no api-synced after a failed catch-up");
        assert!(!relay.sent.lock().iter().rev().take_while(|(op, _)| op != "api-heads").any(|(op, _)| op == "api-synced"));
        assert_eq!(record(&api, D_TOKEN).unwrap().state, "armed");
        // the relay refuses an api-synced while it is behind the console
        let heads = json!({"acme": {"seq": 1, "tseq": 0}});
        assert_eq!(crate::fleet_agent::api_synced_answer(&heads, &json!({"orgs": {"acme": {"seq": 1, "tseq": 1}}})).unwrap_err().code, "not-synced");
        // the fleet's minute tries again without a new contact
        *relay.fail_retire.lock() = false;
        api.sync_tick(link.clone(), NOW + 60);
        assert!(wait_for(|| relay.caught_up()));
        assert!(wait_for(|| record(&api, D_TOKEN).is_some_and(|r| r.state == "deleted")));
        assert!(!relay_holds(&relay, D_TOKEN));
        // nothing left to retry
        assert!(wait_for(|| api.inner.lock().sync_busy.is_empty()));
        assert!(api.inner.lock().unsynced.is_empty());
    }

    #[test]
    fn an_out_of_order_disable_failover_is_refused_and_deletes_nothing() {
        let (_d, _lines, relay, link, api) = failover_setup("failover-order", true);
        api.failover_install(&*link, "acme", D_TOKEN, RELAY, token_material(NOW + 30 * 86_400), NOW).unwrap();
        let entry = |tseq: u64, org: &str| json!({"id": format!("t_{org}_{tseq:06}"), "tseq": tseq, "ts": NOW, "action": "destination_disable_failover", "target": D_TOKEN});
        // a gap (the relay applied 0, so only tseq 1 is next)
        let gap = relay.answer("api-tighten", &json!({"org": "acme", "entry": entry(3, "acme")})).unwrap_err();
        assert_eq!(gap.code, "tseq-gap");
        // an entry for another org, and a malformed target
        assert!(relay.answer("api-tighten", &json!({"org": "acme", "entry": entry(1, "beta")})).is_err());
        let mut bad = entry(1, "acme");
        bad["target"] = json!("not-a-destination");
        assert!(relay.answer("api-tighten", &json!({"org": "acme", "entry": bad})).is_err());
        assert!(relay_holds(&relay, D_TOKEN), "nothing refused deleted the credential");
        assert_eq!(relay.store.lock().head("acme").1, 0);
        // the next entry in order retires it, then applies
        relay.answer("api-tighten", &json!({"org": "acme", "entry": entry(1, "acme")})).unwrap();
        assert!(!relay_holds(&relay, D_TOKEN));
        assert_eq!(relay.store.lock().head("acme").1, 1);
    }

    #[test]
    fn a_tightening_applied_with_its_answer_lost_is_recovered_by_the_next_sync_tick() {
        let (_d, _lines, relay, link, api) = failover_setup("lost-answer", true);
        assert!(relay.caught_up());
        *relay.lose_answer.lock() = true;
        api.append(None, "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        assert!(!api.sync(&*link, RELAY, NOW), "the answer was lost");
        assert_eq!(relay.store.lock().head("acme").1, 1, "but the relay applied it");
        assert!(!relay.caught_up());
        // the retry asks api-heads first, sends nothing already applied, and ends with api-synced
        relay.sent.lock().clear();
        api.sync_tick(link.clone(), NOW + 60);
        assert!(wait_for(|| relay.caught_up()));
        let ops: Vec<String> = relay.sent.lock().iter().map(|(op, _)| op.clone()).collect();
        assert_eq!(ops.first().map(String::as_str), Some("api-heads"), "{ops:?}");
        assert!(!ops.iter().any(|o| o == "api-tighten"), "{ops:?}");
        assert_eq!(ops.last().map(String::as_str), Some("api-synced"), "{ops:?}");
        assert!(wait_for(|| api.inner.lock().unsynced.is_empty()));
        assert_eq!(api.acked(RELAY, "acme"), 1);
    }

    #[test]
    fn a_relay_offline_during_two_tightenings_gets_both_in_order_first_on_reconnect() {
        let d = temp("offline");
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        api.publish_verified(None, map(1, 12, NOW + 30 * 86400), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert_eq!(relay.ops(), ["api-heads", "api-pseudonym-key", "api-map"]);
        // offline: two tightenings wait in the journal
        *relay.up.lock() = false;
        api.append(Some(link.clone()), "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        api.append(Some(link.clone()), "acme", "grace_lower", json!({"kind": "relay", "hours": 6}), None, NOW).unwrap();
        assert_eq!(api.journal_head("acme"), 2);
        assert_eq!(api.relay_grace_hours(NOW), 6, "the console applies its own journal");
        relay.sent.lock().clear();
        // reconnect: api-heads, then the entries strictly in order before anything else
        *relay.up.lock() = true;
        api.on_welcomed(RELAY);
        assert!(api.needs_sync(RELAY));
        assert!(api.sync(&*link, RELAY, NOW));
        let sent = relay.sent.lock().clone();
        assert_eq!(sent.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(), ["api-heads", "api-features", "api-tighten", "api-tighten", "api-synced"], "the key and map are not sent again");
        assert_eq!(sent[4].1["orgs"]["acme"], json!({"seq": 1, "tseq": 2}));
        assert_eq!((sent[2].1["entry"]["tseq"].as_u64(), sent[3].1["entry"]["tseq"].as_u64()), (Some(1), Some(2)));
        assert_eq!(relay.store.lock().head("acme"), (1, 2));
        assert_eq!(api.acked(RELAY, "acme"), 2);
        assert!(!api.needs_sync(RELAY));
        // a new tightening reaches a connected relay at once
        api.append(Some(link.clone()), "acme", "scrape_deny", json!("b".repeat(64)), None, NOW).unwrap();
        assert!(wait_for(|| relay.store.lock().head("acme").1 == 3 && api.acked(RELAY, "acme") == 3));
        // the console's acknowledgments and journal survive its restart
        let again = ConsoleApi::open(Some(&d.join("console")), log, vault());
        assert_eq!((again.journal_head("acme"), again.acked(RELAY, "acme")), (3, 3));
        assert!(!lines.lock().iter().any(|l| l.contains("api.journal.conflict")));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Revision 4 2.3 (Rev4Review R4-1): a revision 3 relay in a version 2 org keeps receiving the relay journal in
    /// order (its tseq never stalls), never receives a version 2 map or a console journal action, ends its catch-up
    /// with an accepted `api-synced`, and shows as outdated; the gate refuses what needs version 2.
    #[test]
    fn a_revision_3_relay_in_a_version_2_org_never_stalls() {
        let d = temp("r3-relay");
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        *relay.features.lock() = Some(Value::Null);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        api.publish_verified(None, map(1, 12, NOW + 30 * 86_400), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert_eq!(relay.store.lock().head("acme").0, 1);
        assert_eq!(api.gate("acme", &[crate::api_features::MAP_V2]).unwrap_err().code, "relay-outdated");
        assert!(api.gate("acme", &[]).is_ok());
        // a version 2 map saved before this relay joined (pinned here without the gate)
        let mut v2 = map(2, 12, NOW + 30 * 86_400);
        v2.wire["map"]["v"] = json!(2);
        v2.wire["map"]["webhook_keys"] = json!([]);
        v2.hash = api_map_hash(&v2.wire["map"]);
        api.publish_verified(Some(link.clone()), v2, NOW).unwrap();
        // a tightening only revision 4 relays read is journaled as its revision 3 fallback, once
        let e = api.append(Some(link.clone()), "acme", "client_drop_scope", json!({"client": CLIENT, "scope": "directory.write"}), None, NOW).unwrap();
        assert_eq!((e["action"].as_str(), e["target"].as_str()), (Some("client_suspend"), Some(CLIENT)));
        api.append(Some(link.clone()), "acme", "client_drop_scope", json!({"client": CLIENT, "scope": "directory.write"}), None, NOW).unwrap();
        assert_eq!(api.journal_head("acme"), 1);
        // a console-only action reaches no relay
        let k = api.append_console("acme", "webhook_key_drop", json!({"kid": "wk-1"}), NOW).unwrap();
        assert_eq!(k["id"], "k_acme_000001");
        assert!(wait_for(|| relay.store.lock().head("acme").1 == 1));
        assert!(api.sync(&*link, RELAY, NOW), "the catch-up ends with an accepted api-synced");
        assert!(relay.caught_up());
        assert_eq!(relay.store.lock().head("acme"), (1, 1), "it keeps map 1 and holds every entry");
        let sent = relay.sent.lock().clone();
        assert!(!sent.iter().any(|(op, b)| op == "api-map" && b["map"]["map"]["v"] == 2), "never a version 2 map");
        assert!(!sent.iter().any(|(_, b)| b["entry"]["id"].as_str().is_some_and(|i| i.starts_with("k_"))), "never a console journal action");
        assert_eq!(api.outdated(), vec![("acme".to_string(), RELAY.to_string(), vec![crate::api_features::MAP_V2])]);
        assert!(lines.lock().iter().any(|l| l.contains("api.map.withheld")));
        assert_eq!(api.relay_set("acme").get(RELAY).cloned().flatten().map(|r| r.map), Some(vec![1]));
        assert!(api.connector_entries("acme", 0).is_empty(), "revision 4 journals no connector action");
        assert_eq!(api.idempotency().begin("acme", CLIENT, "AbCdEfGh12345678", &json!({}), NOW), crate::api_idempotency::Begin::Fresh);
        // retiring a relay that is connected and still reports the org is refused; the set survives a restart
        assert_eq!(api.retire_relay("acme", RELAY).unwrap_err().code, "relay-connected");
        let again = ConsoleApi::open(Some(&d.join("console")), log, vault());
        assert!(again.gate("acme", &[crate::api_features::MAP_V2]).is_err());
        assert_eq!(again.console_active("acme").len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Revision 4 2.3 item 3: a relay that answers `api-features` with version 2 opens the gate; its rollback to an
    /// older build closes it at once (`api.relay-outdated`), and the relay gets no version 2 map after that.
    #[test]
    fn a_rollback_closes_the_gate_at_once() {
        let d = temp("rollback");
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert!(api.gate("acme", &[crate::api_features::MAP_V2]).is_ok());
        assert!(api.relay_has(RELAY, crate::api_features::MAP_V2));
        let mut v2 = map(1, 12, NOW + 30 * 86_400);
        v2.wire["map"]["v"] = json!(2);
        v2.wire["map"]["webhook_keys"] = json!([]);
        v2.hash = api_map_hash(&v2.wire["map"]);
        api.publish_verified(None, v2, NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert_eq!(relay.store.lock().head("acme").0, 1, "the version 2 map reached the relay that reports it");
        // the relay is rolled back to revision 3 and reconnects
        *relay.features.lock() = Some(Value::Null);
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert!(lines.lock().iter().any(|l| l.contains("api.relay-outdated")));
        assert_eq!(api.gate("acme", &[crate::api_features::MAP_V2]).unwrap_err().code, "relay-outdated");
        assert_eq!(api.outdated().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_older_relay_answering_fleet_op_gets_no_api_op_until_it_reconnects() {
        let d = temp("older");
        let (log, _) = logger();
        let mut old = FakeRelay::new(RELAY, "acme", &d.join("relay"), log.clone());
        old.old = true;
        let old = Arc::new(old);
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![old.clone()]));
        let api = Arc::new(ConsoleApi::open(None, log, vault()));
        api.on_welcomed(RELAY);
        assert!(!api.needs_sync(RELAY), "a console with no api state asks nothing");
        api.append(None, "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        assert!(api.needs_sync(RELAY));
        assert!(api.sync(&*link, RELAY, NOW));
        assert_eq!(old.ops(), ["api-heads"]);
        assert!(!api.needs_sync(RELAY));
        api.append(Some(link.clone()), "acme", "scrape_deny", json!("c".repeat(64)), None, NOW).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(old.ops(), ["api-heads"], "no api op until it reconnects");
        api.on_welcomed(RELAY);
        assert!(api.needs_sync(RELAY), "a reconnect asks again");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_relay_refuses_a_gap_and_a_widening_and_keeps_tightenings_across_restart() {
        let d = temp("relay");
        let (log, _) = logger();
        let mut store = ApiMapStore::load(Some(&d));
        let entry = |tseq: u64, action: &str, target: Value| json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW, "action": action, "target": target});
        let body = |e: Value| json!({"org": "acme", "entry": e});
        let mut notes = Vec::new();
        let gap = crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "client_suspend", json!(CLIENT))), &mut notes).unwrap_err();
        assert_eq!((gap.status, gap.code.as_str()), (409, "tseq-gap"));
        assert!(notes.is_empty(), "a refused entry is not audited as applied");
        assert_eq!(crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(1, "client_suspend", json!(CLIENT))), &mut notes).unwrap(), json!({"ok": true, "tseq": 1}));
        assert_eq!(notes, vec![("acme".to_string(), json!({"action": "api.tighten", "result": "ok", "resource": "t_acme_000001", "tseq": 1, "op": "client_suspend"}))]);
        let wide = crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "destination_identities", json!({"destination": "d_9a8b7c6d5e4f3a2b", "identities": "as_is"}))), &mut notes).unwrap_err();
        assert_eq!(wide.code, "not-tightening");
        assert_eq!(crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "api_off", json!("acme"))), &mut notes).unwrap()["tseq"], 2);
        assert_eq!(notes.len(), 2);
        drop(store);
        let back = ApiMapStore::load(Some(&d));
        assert_eq!(back.head("acme"), (0, 2));
        assert!(back.is_off("acme"));
        // the console refuses to journal a widening at all
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        assert_eq!(api.append(None, "acme", "client_resume", json!(CLIENT), None, NOW).unwrap_err().code, "not-tightening");
        assert_eq!(api.journal_head("acme"), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_api_map_conflict_raises_the_alarm_and_a_higher_relay_tseq_is_a_journal_conflict() {
        let d = temp("conflict");
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        relay.store.lock().pin(map(1, 12, NOW + 30 * 86400)).unwrap();
        // the same seq with another hash
        let other = map(1, 6, NOW + 30 * 86400);
        let wire = Value::Object(other.wire.clone());
        let r = relay.answer("api-map", &json!({"org": "acme", "map": wire})).unwrap_err();
        assert_eq!((r.status, r.code.as_str()), (409, "conflict"));
        assert!(lines.lock().iter().any(|l| l.contains("api.map.conflict")));
        assert_eq!(relay.store.lock().head("acme"), (1, 0), "nothing changed");
        // the console's own pin raises it too
        let api = Arc::new(ConsoleApi::open(None, log, vault()));
        api.publish_verified(None, map(1, 12, NOW + 30 * 86400), NOW).unwrap();
        lines.lock().clear();
        assert!(matches!(api.publish_verified(None, other, NOW), Ok(AcceptOutcome::Conflict { .. })));
        assert!(lines.lock().iter().any(|l| l.contains("api.map.conflict")));
        // a relay ahead of the console's journal keeps its stricter state and gets nothing for that org
        *relay.heads.lock() = Some(json!({"acme": {"seq": 1, "tseq": 4}}));
        relay.sent.lock().clear();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert!(lines.lock().iter().any(|l| l.contains("api.journal.conflict")));
        assert_eq!(relay.ops(), ["api-heads"]);
        assert!(!api.needs_sync(RELAY), "nothing goes to a relay ahead of the console's journal");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_pseudonym_key_is_delivered_once_sealed_and_never_logged() {
        let d = temp("pseudonym");
        let (log, lines) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.publish_verified(None, map(1, 12, NOW + 30 * 86400), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        let keys: Vec<Value> = relay.sent.lock().iter().filter(|(op, _)| op == "api-pseudonym-key").map(|(_, b)| b.clone()).collect();
        assert_eq!(keys.len(), 1, "delivered once");
        assert_eq!(relay.ops().get(1).map(String::as_str), Some("api-pseudonym-key"), "after api-heads, before the map");
        let (pkv, key, _) = api.pseudonym_key("acme", NOW + 99).unwrap();
        assert_eq!((pkv, key.len()), (1, 32));
        assert_eq!(keys[0]["key"], json!(b64u(&key)), "drawn once: the same key again");
        // the relay sealed it and wrote only {pkv, not_before}
        assert_eq!(relay.vault.lock().map.get(&crate::fleet_agent::api_pseudonym_seal_name("acme", 1)), Some(&key));
        let record = std::fs::read_to_string(d.join("relay").join(crate::fleet_agent::API_PSEUDONYM_DIR).join("acme.json")).unwrap();
        assert!(!record.contains(&b64u(&key)));
        assert_eq!(parse_json(&record).unwrap()["pkv"], 1);
        // another key under the same version is refused
        let mut forged = keys[0].clone();
        forged["key"] = json!(b64u(&[1u8; 32]));
        assert_eq!(relay.answer("api-pseudonym-key", &forged).unwrap_err().code, "conflict");
        let k = b64u(&key);
        assert!(lines.lock().iter().all(|l| !l.contains(&k)), "the key never enters a log");
        for f in walk(&d) {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            assert!(!text.contains(&k), "{}", f.display());
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    fn walk(d: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn acknowledged_and_folded_entries_are_pruned_and_stay_pruned() {
        let d = temp("prune");
        let (log, _) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        api.on_welcomed(RELAY);
        api.append(None, "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        api.append(None, "acme", "scrape_deny", json!("d".repeat(64)), None, NOW).unwrap();
        api.append(None, "acme", "token_deny", json!({"client": CLIENT, "jti": "j1"}), Some(NOW + 10), NOW).unwrap();
        assert!(api.sync(&*link, RELAY, NOW));
        assert_eq!((relay.store.lock().head("acme").1, api.acked(RELAY, "acme")), (3, 3));
        // acknowledged but not folded: kept
        assert_eq!(api.journal_len("acme"), 3);
        // a map folding the suspension: entry 1 goes; scrape_deny is never pruned, so nothing after it either
        api.publish_verified(None, map_folding(1, 12, NOW + 30 * 86400, &["t_acme_000001"]), NOW).unwrap();
        assert_eq!((api.journal_len("acme"), api.journal_head("acme")), (2, 3));
        // across a restart the base holds and the next entry continues the tseq
        let again = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        assert_eq!((again.journal_len("acme"), again.journal_head("acme")), (2, 3));
        assert_eq!(again.append(None, "acme", "client_suspend", json!("c_0000000000000001"), None, NOW).unwrap()["tseq"], 4);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_relay_first_reporting_after_pruning_rebases_on_the_map_and_takes_the_next_entry() {
        let d = temp("rebase");
        let (log, lines) = logger();
        let first = Arc::new(FakeRelay::new(RELAY, "acme", &d.join("first"), log.clone()));
        let late = Arc::new(FakeRelay::new(OTHER, "acme", &d.join("late"), log.clone()));
        *late.up.lock() = false;
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![first.clone(), late.clone()]));
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.on_welcomed(RELAY);
        api.append(None, "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        assert!(api.sync(&*link, RELAY, NOW));
        api.publish_verified(None, map_folding(1, 12, NOW + 30 * 86400, &["t_acme_000001"]), NOW).unwrap();
        assert_eq!((api.journal_len("acme"), api.journal_head("acme")), (0, 1), "pruned");
        // the late relay reports acme for the first time: the map goes with base 1, and it rebases
        *late.up.lock() = true;
        api.on_welcomed(OTHER);
        assert!(api.sync(&*link, OTHER, NOW));
        let maps: Vec<Value> = late.sent.lock().iter().filter(|(op, _)| op == "api-map").map(|(_, b)| b.clone()).collect();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0]["base"], 1);
        assert_eq!(late.store.lock().head("acme"), (1, 1));
        assert!(lines.lock().iter().any(|l| l.contains("api.journal.rebased")));
        assert!(!late.ops().iter().any(|o| o == "api-tighten"), "no gap entry is sent");
        // a base at or below the applied tseq is ignored
        let again = late.answer("api-map", &maps[0]).unwrap();
        assert_eq!(again["tseq"], 1);
        // the next entry (base + 1) reaches both relays
        api.append(Some(link.clone()), "acme", "client_drop_scope", json!({"client": CLIENT, "scope": "audit.read"}), None, NOW).unwrap();
        assert!(wait_for(|| late.store.lock().head("acme").1 == 2 && first.store.lock().head("acme").1 == 2));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn publish_map_verifies_pins_and_reaches_only_the_relays_of_its_org() {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        let root = crate::meet_x509::Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap().clone();
        let now = doc["now"].as_i64().unwrap();
        let case = doc["signed"].as_array().unwrap().iter().find(|c| c["expect"] == "ok").unwrap().clone();
        let signed = case["signed"].clone();
        let org = signed["map"]["org"].as_str().unwrap().to_string();
        let org = org.as_str();
        let d = temp("publish");
        let (log, _) = logger();
        let mine = Arc::new(FakeRelay::new(RELAY, org, &d.join("mine"), log.clone()));
        let theirs = Arc::new(FakeRelay::new(OTHER, "zz-other", &d.join("theirs"), log.clone()));
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![mine.clone(), theirs.clone()]));
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.on_welcomed(RELAY);
        api.on_welcomed(OTHER);
        let trust = ApiTrust { root: &root, signer_policy: &sp, root_crl: None, previous_serial: "" };
        // a tampered map does not verify and nothing is sent
        let mut bad = signed.clone();
        bad["map"]["seq"] = json!(bad["map"]["seq"].as_i64().unwrap() + 1);
        assert!(api.publish_map(Some(link.clone()), &bad, &trust, now, doc["policy"].as_object(), Some(Edition::Enterprise)).is_err());
        let vm = match api.publish_map(Some(link.clone()), &signed, &trust, now, doc["policy"].as_object(), Some(Edition::Enterprise)).unwrap() {
            AcceptOutcome::Pinned(vm) => vm,
            other => panic!("expected a pin, got {other:?}"),
        };
        assert!(wait_for(|| mine.store.lock().head(org).0 == vm.seq), "the relay of the org pinned it");
        assert!(wait_for(|| theirs.ops().contains(&"api-heads".to_string())));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!theirs.ops().iter().any(|o| o == "api-map" || o == "api-pseudonym-key"), "{:?}", theirs.ops());
        assert_eq!(mine.ops().iter().filter(|o| *o == "api-map").count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_relay_grace_is_the_minimum_over_held_maps_and_zero_when_any_expired() {
        let (log, _) = logger();
        let api = Arc::new(ConsoleApi::open(None, log, vault()));
        assert_eq!(api.relay_grace_hours(NOW), 0, "no map: 0");
        api.publish_verified(None, map(1, 12, NOW + 100), NOW).unwrap();
        assert_eq!(api.relay_grace_hours(NOW), 12);
        assert_eq!(api.relay_grace_hours(NOW + 100), 0, "an expired map counts 0");
    }

    const SECRET: &str = "lcs_0123456789abcdef";

    /// A pinned map listing `jwks`, with one D11 secret client (`networks` 10.40.0.0/23).
    fn issuer_map(seq: i64, jwks: Value) -> VerifiedApiMap {
        let m = json!({"v": 1, "org": "acme", "seq": seq, "issued": NOW - 10, "expires": NOW + 30 * 86400,
                       "issuer": {"url": "https://console.acme.example:7443/api/orgs/acme", "jwks": jwks},
                       "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0},
                       "failover_after_s": 300, "folded": [], "cleared": [],
                       "relay_origins": {"r_01": "https://relay1.acme.example:9443"},
                       "clients": [{"id": CLIENT, "name": "scrape", "principal": "scrape@apps.acme.example", "kind": "monitoring",
                                    "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read"], "ceiling": "internal",
                                    "relays": ["*"], "networks": ["10.40.0.0/23"], "mtls_required": false,
                                    "rate": {"per_minute_each": 60, "per_day_each": 1000},
                                    "credentials": [{"type": "client_secret", "sha256": crate::codec::sha256_hex(SECRET.as_bytes()), "hint": "lcs_0123", "expires": NOW + 30 * 86400}],
                                    "created": NOW - 10, "expires": NOW + 300 * 86400, "state": "active"}],
                       "destinations": []});
        let wire = json!({"map": m, "sig": "", "chain": []});
        VerifiedApiMap { org: "acme".into(), seq, expires: NOW + 30 * 86400, hash: api_map_hash(&wire["map"]), signer: "root".into(), wire: wire.as_object().unwrap().clone() }
    }

    #[test]
    fn the_front_door_issues_with_a_listed_key_and_journals_revocations() {
        let (log, _) = logger();
        let api = Arc::new(ConsoleApi::open(None, log, vault()));
        let source: IpAddr = "10.40.0.7".parse().unwrap();
        let basic = format!("Basic {}", crate::meet_json::b64(format!("{CLIENT}:{SECRET}").as_bytes()));
        let ask_as = |revoke: bool, body: &[u8], licensed: bool| {
            let http = TokenHttp { form: body, authorization: Some(basic.as_str()), dpop: None, client_cert: None, source };
            api.api_token(None, "acme", revoke, &http, None, &|_: &str| true, licensed, &|_: &str, _: &str, _: i64| Ok(()), None, NOW)
        };
        let ask = |revoke: bool, body: &[u8]| ask_as(revoke, body, true);
        let cc = b"grant_type=client_credentials".as_slice();
        assert!(ask(false, cc).is_none(), "no map: not-found");
        assert!(api.api_document("acme", ApiDoc::Jwks, source, NOW).is_none());
        let jwk = api.issuer_public_jwk("acme").unwrap();
        assert_eq!(api.issuer_public_jwk("acme").unwrap(), jwk, "drawn once");
        api.publish_verified(None, issuer_map(1, json!([])), NOW).unwrap();
        let a = ask(false, cc).unwrap();
        assert_eq!((a.status, a.body["code"].as_str()), (503, Some("issuer-key-unlisted")));
        assert_eq!(ask_as(false, cc, false).unwrap().body["code"], "license", "the license comes before the key");
        let mut listed = jwk.clone();
        listed["nbf"] = json!(NOW + 60);
        listed["exp"] = json!(NOW + 86400);
        api.publish_verified(None, issuer_map(2, json!([listed])), NOW).unwrap();
        assert_eq!(ask(false, cc).unwrap().body["code"], "issuer-key-unlisted", "not before its nbf");
        listed["nbf"] = json!(NOW - 60);
        api.publish_verified(None, issuer_map(3, json!([listed])), NOW).unwrap();
        let a = ask_as(false, cc, false).unwrap();
        assert_eq!((a.status, a.body["code"].as_str()), (403, Some("license")));
        let a = ask(false, cc).unwrap();
        assert_eq!((a.status, a.body["token_type"].as_str(), a.body["expires_in"].as_i64()), (200, Some("Bearer"), Some(300)), "{}", a.body);
        let token = a.body["access_token"].as_str().unwrap().to_string();
        // the documents come from the pinned map
        let d = api.api_document("acme", ApiDoc::Jwks, source, NOW).unwrap();
        assert_eq!(d.body["keys"][0]["kid"], jwk["kid"]);
        let d = api.api_document("acme", ApiDoc::ProtectedResource, source, NOW).unwrap();
        assert_eq!(d.body["authorization_servers"], json!(["https://console.acme.example:7443/api/orgs/acme"]));
        // a revocation journals token_deny once
        let body = format!("token={token}");
        let r = ask(true, body.as_bytes()).unwrap();
        assert_eq!((r.status, r.event.as_ref().map(|e| e.0)), (200, Some("api.revoke")));
        assert_eq!(api.journal_head("acme"), 1);
        assert_eq!(ask(true, body.as_bytes()).unwrap().status, 200);
        assert_eq!(api.journal_head("acme"), 1, "already denied");
        // 13: an unknown edition sets the map aside (403 `map-edition`); a known edition it fits serves it again
        api.set_edition(None);
        let a = ask(false, cc).unwrap();
        assert_eq!((a.status, a.body["code"].as_str()), (403, Some("map-edition")));
        assert!(api.api_document("acme", ApiDoc::Jwks, source, NOW).is_none(), "a set-aside org serves nothing");
        api.set_edition(Some(Edition::Enterprise));
        assert_eq!(ask(false, cc).unwrap().status, 200, "restored");
    }

    // ── API audit over the channel (2.6, 9, 12.2) ──

    use crate::fleet_agent::{api_next_batch, api_ship_answer, api_shipped_load, ShipStep};

    struct NoSigner;

    impl crate::api_audit::CheckpointSigner for NoSigner {
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

    struct NoKeys;

    impl crate::api_audit::PseudonymKeys for NoKeys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            None
        }
    }

    fn chains(dir: &Path, source: &str) -> Arc<ApiAudit> {
        Arc::new(ApiAudit::open(Some(dir), source, Arc::new(NoSigner), Arc::new(NoKeys), NOW))
    }

    fn event_log(dir: &Path, source: &str) -> Arc<crate::api_events::EventLog> {
        Arc::new(crate::api_events::EventLog::open(Some(dir), source, Arc::new(NoSigner), Arc::new(NoKeys), NOW))
    }

    /// Revision 4 7.1, 2.5: a journaled suspension and `api_off` are events before any relay hears of them; a relay's
    /// event chain arrives with `api-events` (in order, from the org it reported) and joins the feed index.
    #[test]
    fn tightenings_are_events_and_relay_event_chains_join_the_feed() {
        let (d, _lines, _relay, _link, api) = failover_setup("events", false);
        let events = event_log(&d.join("console"), "console");
        assert_eq!(api.emit_event("acme", "api.enabled", Value::Null, NOW), None, "nothing before the chains are set");
        api.set_events(events.clone());
        api.append(None, "acme", "client_suspend", json!(CLIENT), None, NOW).unwrap();
        api.append(None, "acme", "api_off", json!("acme"), None, NOW).unwrap();
        let own = events.chains().range("acme", "console", Repr::AsIs, 0, 10);
        let types: Vec<&str> = own.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(types, ["client.suspended", "api.disabled"]);
        assert_eq!(own[0]["data"], json!({"client": CLIENT, "reason": "client_suspend"}));
        assert_eq!(api.emit_event("acme", "nothing.happened", Value::Null, NOW), None, "a type outside the registry");
        // the relay's own chain, shipped as the relay's loop ships it
        let relay_events = event_log(&d.join("relay-events"), RELAY);
        relay_events.emit("acme", "relay.mode.changed", json!({"relay": RELAY, "mode": "failover"}), NOW).unwrap();
        let mut skip = std::collections::HashSet::new();
        let mut shipped = BTreeMap::new();
        while let Some(b) = api_next_batch(relay_events.chains(), &shipped, &skip) {
            assert_eq!((b.op, b.shipped), ("api-events", crate::fleet_agent::API_EVENTS_SHIPPED_FILE));
            let a = api.events_in(RELAY, &b.body).unwrap();
            assert_eq!(a["ok"], true);
            shipped.entry(b.org.clone()).or_insert_with(BTreeMap::new).insert(b.repr.as_str().to_string(), b.last);
            skip.insert((b.org, b.repr));
        }
        assert_eq!(api.events_in("r_ffffffffffffffff", &json!({"org": "acme", "repr": "as_is", "first": 1, "last": 1, "entries": [{}]})).unwrap_err().code, "org-not-served");
        let scopes = vec!["events.subscribe".to_string(), "monitor.read".to_string(), "audit.read".to_string()];
        let any = |_: &str| true;
        let viewer = crate::api_events::Viewer { scopes: &scopes, reaches: &any, ceiling: crate::api_catalog::Ceiling::Internal, repr: Repr::Pseudonymized, types: None };
        let page = events.page("acme", &crate::api_events::FeedQuery::parse("").unwrap(), &viewer).unwrap();
        let got: Vec<&str> = page["events"].as_array().unwrap().iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(got, ["com.emertins.lucid.client.suspended", "com.emertins.lucid.api.disabled", "com.emertins.lucid.relay.mode.changed"]);
        // a signed map that clears the `api_off` entry turns the API on again: `api.enabled` once, with no data
        for seq in [2, 3] {
            let mut vm = failover_map(seq, false);
            vm.wire["map"]["issued"] = json!(NOW + 5);
            vm.wire["map"]["cleared"] = json!(["t_acme_000002"]);
            vm.hash = api_map_hash(&vm.wire["map"]);
            api.publish_verified(None, vm, NOW + 10).unwrap();
        }
        let enabled: Vec<Value> = events.chains().range("acme", "console", Repr::AsIs, 0, 100).into_iter().filter(|e| e["type"] == "api.enabled").collect();
        assert_eq!(enabled.len(), 1, "fired once");
        assert!(enabled[0].get("data").is_none(), "api.enabled carries no data");
        let _ = std::fs::remove_dir_all(&d);
    }

    fn call_entry(i: u64) -> Value {
        json!({"action": "api.call", "client": CLIENT, "scope": "audit.read", "route": "GET /api/orgs/acme/v1/audit", "resource": format!("r{i}"), "result": "ok", "check": "none", "ip": "203.0.113.7", "count": 1})
    }

    /// The console's Meet CA (a test CA from now) as the issuer of checkpoint certificates.
    fn issuer(d: &Path) -> IssueFn {
        let dir = d.join("meet-ca");
        std::fs::create_dir_all(&dir).unwrap();
        let mut v = MemVault::default();
        let ca = crate::meet_ca::test_ca(&dir, &mut v, None, crate::codec::now_ms());
        let held = Arc::new(Mutex::new((ca, v)));
        Arc::new(move |holder: &str, org: &str, csr: &[u8], t: i64| -> Result<(Vec<u8>, Vec<Vec<u8>>), String> {
            let mut g = held.lock();
            let (ca, v) = &mut *g;
            let issued = ca.issue_checkpoint(&*v, holder, org, csr, t).map_err(|e| e.code.to_string())?;
            Ok((issued.der, vec![ca.ca_der().to_vec()]))
        })
    }

    /// A console with its audit chains and a test Meet CA; one relay of acme (its chains apart, not yet behind
    /// `api-chains`).
    fn audited(d: &Path, log: &Arc<Logger>) -> (Arc<ConsoleApi>, Arc<ApiAudit>, Arc<FakeRelay>, Arc<dyn FleetLink>, Arc<ApiAudit>) {
        let (relay, link) = one(d, log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        let console = chains(&d.join("console"), "console");
        api.set_audit(console.clone(), issuer(d));
        let mine = chains(&relay.dir, RELAY);
        (api, console, relay, link, mine)
    }

    /// The relay's shipping loop against the console until nothing is left: (repr, first, last) of each batch.
    fn ship_all(api: &ConsoleApi, mine: &ApiAudit, rdir: &Path, log: &Logger) -> Vec<(Repr, u64, u64)> {
        let mut out = Vec::new();
        while let Some(b) = api_next_batch(mine, &api_shipped_load(rdir), &Default::default()) {
            let own = mine.head("acme", RELAY, b.repr).0;
            assert_eq!(api_ship_answer(rdir, &b, api.audit_in(RELAY, &b.body), own, log), ShipStep::Acked);
            out.push((b.repr, b.first, b.last));
            assert!(out.len() <= 30, "shipping ends");
        }
        out
    }

    fn now_s() -> i64 {
        crate::codec::now_ms() / 1000
    }

    #[test]
    fn a_relay_offline_while_recording_ships_in_order_after_reconnect_and_the_console_chain_verifies() {
        let d = temp("ship");
        let (log, lines) = logger();
        let (api, console, relay, link, mine) = audited(&d, &log);
        // offline: the relay records; nothing reaches the console
        *relay.up.lock() = false;
        for i in 1..=5 {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        assert!(api.audit_in(RELAY, &json!({"org": "acme", "repr": "as_is", "first": 1, "last": 1, "entries": [{}]})).is_err(), "a relay that did not report the org yet");
        // reconnect: the catch-up learns that the relay serves acme; then the relay ships from what was acknowledged
        *relay.up.lock() = true;
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        let rdir = relay.dir.clone();
        assert_eq!(ship_all(&api, &mine, &rdir, &log), vec![(Repr::AsIs, 1, 5), (Repr::Pseudonymized, 1, 5), (Repr::Removed, 1, 5)]);
        assert_eq!(api_shipped_load(&rdir)["acme"]["as_is"], 5, "the acknowledgment is on disk");
        // the console's copy verified: every chain has the relay's head seq and hash, and reads in order
        for r in Repr::ALL {
            assert_eq!(console.head("acme", RELAY, r), mine.head("acme", RELAY, r), "{r:?}");
        }
        let read = console.read("acme", RELAY, Repr::AsIs, 0, 100).unwrap();
        let seqs: Vec<u64> = read["entries"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, [1, 2, 3, 4, 5]);
        assert_eq!(read["chain"]["head_hash"], json!(mine.head("acme", RELAY, Repr::AsIs).1));
        // offline again: later entries ship from the acknowledged seq, nothing twice
        for i in 6..=7 {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        assert_eq!(ship_all(&api, &mine, &rdir, &log), vec![(Repr::AsIs, 6, 7), (Repr::Pseudonymized, 6, 7), (Repr::Removed, 6, 7)]);
        assert_eq!(console.head("acme", RELAY, Repr::Removed), mine.head("acme", RELAY, Repr::Removed));
        assert!(!lines.lock().iter().any(|l| l.contains("api.audit.ingest-refused")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_gap_answer_makes_the_relay_resend_from_the_consoles_head() {
        let d = temp("gap");
        let (log, _) = logger();
        let (api, console, relay, link, mine) = audited(&d, &log);
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        let rdir = relay.dir.clone();
        for i in 1..=3 {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        ship_all(&api, &mine, &rdir, &log);
        for i in 4..=7 {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        // the relay believes the console holds up to 5; the console holds 3 and answers gap
        crate::fleet_agent::api_shipped_set_in(&rdir, crate::fleet_agent::API_SHIPPED_FILE, "acme", "as_is", 5).unwrap();
        let b = api_next_batch(&mine, &api_shipped_load(&rdir), &Default::default()).unwrap();
        assert_eq!((b.repr, b.first, b.last), (Repr::AsIs, 6, 7));
        let answer = api.audit_in(RELAY, &b.body).unwrap();
        assert_eq!(answer, json!({"ok": false, "code": "gap", "expected": 4}));
        assert_eq!(api_ship_answer(&rdir, &b, Ok(answer), 7, &log), ShipStep::Resend);
        assert_eq!(api_shipped_load(&rdir)["acme"]["as_is"], 3);
        // the resend starts at the console's head and verifies
        let b = api_next_batch(&mine, &api_shipped_load(&rdir), &Default::default()).unwrap();
        assert_eq!((b.repr, b.first, b.last), (Repr::AsIs, 4, 7));
        assert_eq!(api_ship_answer(&rdir, &b, api.audit_in(RELAY, &b.body), 7, &log), ShipStep::Acked);
        assert_eq!(console.head("acme", RELAY, Repr::AsIs), mine.head("acme", RELAY, Repr::AsIs));
        // a console that holds more than the relay has stops that chain; an older console stops shipping
        assert_eq!(api_ship_answer(&rdir, &b, Ok(json!({"ok": false, "code": "gap", "expected": 9})), 7, &log), ShipStep::Skip("console-ahead".into()));
        assert_eq!(api_ship_answer(&rdir, &b, Err(Refusal::of("fleet-op")), 7, &log), ShipStep::Off);
        assert_eq!(api_shipped_load(&rdir)["acme"]["as_is"], 7);
        // a broken batch is refused, and a relay that never reported the org is not taken
        let mut broken = b.body.clone();
        broken["first"] = json!(8);
        broken["last"] = json!(9);
        assert_eq!(api.audit_in(RELAY, &broken).unwrap_err().code, "bad-chain");
        assert_eq!(api.audit_in(OTHER, &b.body).unwrap_err().code, "org-not-served");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn api_chains_backfill_pulls_the_relays_chains_in_pages_on_reconnect() {
        let d = temp("chains");
        let (log, _) = logger();
        let (api, console, relay, link, mine) = audited(&d, &log);
        *relay.audit.lock() = Some(mine.clone());
        for i in 1..=5 {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        // pages of at most 2 entries per representation, each asked from the console's heads
        let afters: Vec<u64> = relay.sent.lock().iter().filter(|(op, _)| op == "api-chains").map(|(_, b)| b["after"]["as_is"].as_u64().unwrap()).collect();
        assert_eq!(afters, [0, 2, 4]);
        for r in Repr::ALL {
            assert_eq!(console.head("acme", RELAY, r), mine.head("acme", RELAY, r), "{r:?}");
        }
        // the relay's shipping then finds the console at its head (an overlapping resend is taken)
        let rdir = relay.dir.clone();
        assert_eq!(ship_all(&api, &mine, &rdir, &log).len(), 3);
        // the next reconnect pulls one empty page
        relay.sent.lock().clear();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        assert_eq!(relay.sent.lock().iter().filter(|(op, _)| op == "api-chains").count(), 1);
        // `after` names exactly the three representations
        let page = |after: Value| crate::fleet_agent::api_chains_answer(&mine, &json!({"org": "acme", "after": after}));
        assert_eq!(page(json!({"as_is": 0, "pseudonymized": 0, "removed": 0, "x": 0})).unwrap_err().code, "bad-after");
        assert_eq!(page(json!({"as_is": 0, "pseudonymized": 0, "x": 0})).unwrap_err().code, "bad-after");
        let all = page(json!({"as_is": 3, "pseudonymized": 5, "removed": 0})).unwrap();
        assert_eq!((all["as_is"].as_array().unwrap().len(), all["pseudonymized"].as_array().unwrap().len(), all["removed"].as_array().unwrap().len(), &all["more"]), (2, 0, 5, &json!(false)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn checkpoint_csr_issue_and_install_round_trip_and_the_certificate_verifies_a_relay_checkpoint() {
        use crate::api_audit::CheckpointSigner;
        let d = temp("checkpoint");
        let (log, _) = logger();
        let (api, console, relay, link, _mine) = audited(&d, &log);
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        let ops = relay.ops();
        assert_eq!(&ops[..3], ["api-heads", "api-checkpoint-csr", "api-checkpoint-cert"], "{ops:?}");
        let body = relay.sent.lock().iter().find(|(op, _)| op == "api-checkpoint-cert").unwrap().1.clone();
        let cert = crate::codec::unb64u(body["cert"].as_str().unwrap()).unwrap();
        assert_eq!(body["chain"].as_array().unwrap().len(), 1);
        // the console keeps the relay's certificate for `v1/audit/keys`
        assert!(!console.keys("acme").is_empty());
        // the relay signs a checkpoint with its installed key; the issued certificate verifies it, and nothing else
        let signer = crate::api_checkpoint::RelayCheckpoints::new(&relay.dir, relay.vault.clone() as Arc<dyn VaultLock>);
        assert!(signer.kid("acme").is_some());
        let payload = crate::api_audit::checkpoint_signed_bytes(br#"{"heads":{},"org":"acme","source":"r_00000000000000b1","ts":1}"#);
        let sig = signer.sign("acme", &payload).unwrap();
        assert!(crate::api_checkpoint::verify(&cert, &payload, &sig));
        let mut other = payload.clone();
        other.push(b' ');
        assert!(!crate::api_checkpoint::verify(&cert, &other, &sig));
        // installed and in date: the next catch-up asks, the relay answers no request, nothing is issued
        relay.sent.lock().clear();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        let ops = relay.ops();
        assert!(ops.iter().any(|o| o == "api-checkpoint-csr") && !ops.iter().any(|o| o == "api-checkpoint-cert"), "{ops:?}");
        // a certificate for another key is refused by the relay
        let wrong = crate::fleet_agent::api_checkpoint_cert_answer(&relay.dir, &*relay.vault, &json!({"org": "acme", "cert": b64u(b"not a certificate"), "chain": []}));
        assert_eq!(wrong.unwrap_err().code, "bad-cert");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_relay_answering_fleet_op_to_audit_ops_gets_none_until_it_reconnects() {
        let d = temp("no-audit");
        let (log, lines) = logger();
        let mut r = FakeRelay::new(RELAY, "acme", &d.join("relay"), log.clone());
        r.no_audit = true;
        let relay = Arc::new(r);
        *relay.heads.lock() = Some(json!({"acme": {"seq": 0, "tseq": 0}, "beta": {"seq": 0, "tseq": 0}}));
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![relay.clone()]));
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        api.set_audit(chains(&d.join("console"), "console"), issuer(&d));
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()), "an API-1a2 relay keeps its catch-up");
        assert_eq!(relay.ops(), ["api-heads", "api-checkpoint-csr"], "one refused audit op, none for the next org");
        assert!(lines.lock().iter().any(|l| l.contains("api.relay-without-audit")));
        // later deliveries on the same channel carry no audit op
        assert!(api.sync(&*link, RELAY, now_s()));
        assert_eq!(relay.ops(), ["api-heads", "api-checkpoint-csr"]);
        // a reconnect asks again
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        assert_eq!(relay.ops().iter().filter(|o| *o == "api-checkpoint-csr").count(), 2);
        // a relay before API-1 answers api-heads fleet-op and gets no audit op either
        let mut o = FakeRelay::new(OTHER, "acme", &d.join("old"), log.clone());
        o.old = true;
        let old = Arc::new(o);
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![old.clone()]));
        api.on_welcomed(OTHER);
        assert!(api.sync(&*link, OTHER, now_s()));
        assert_eq!(old.ops(), ["api-heads"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn api_audit_takes_only_orgs_the_relay_reports_on_this_connection() {
        let d = temp("membership");
        let (log, _) = logger();
        let (api, _console, relay, link, mine) = audited(&d, &log);
        mine.record("acme", call_entry(1), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        let b = api_next_batch(&mine, &api_shipped_load(&relay.dir), &Default::default()).unwrap();
        assert_eq!(api.audit_in(RELAY, &b.body).unwrap()["ok"], json!(true));
        // reconnected, still unasked: nothing is taken
        api.on_welcomed(RELAY);
        assert_eq!(api.audit_in(RELAY, &b.body).unwrap_err().code, "org-not-served");
        // the relay no longer serves acme: its journal acknowledgment stays (pruning history), membership does not
        *relay.heads.lock() = Some(json!({"beta": {"seq": 0, "tseq": 0}}));
        assert!(api.sync(&*link, RELAY, now_s()));
        assert!(api.relays_of("acme").iter().any(|r| r == RELAY), "history is kept for pruning");
        assert!(!api.serves_now(RELAY, "acme") && api.serves_now(RELAY, "beta"));
        assert_eq!(api.audit_in(RELAY, &b.body).unwrap_err().code, "org-not-served");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_connected_relay_gets_its_checkpoint_certificate_renewed_by_the_hourly_check() {
        let d = temp("renew");
        let (log, _) = logger();
        let (api, console, relay, link, _mine) = audited(&d, &log);
        // the catch-up an hour ago installed the first certificate
        let now = now_s();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now - 3600));
        let certs = || relay.sent.lock().iter().filter(|(op, _)| op == "api-checkpoint-cert").count();
        assert_eq!(certs(), 1);
        let keys = console.keys("acme").len();
        // still connected and 340 days on, its certificate has under 30 days left
        *relay.csr_now.lock() = now + 340 * 86400;
        relay.sent.lock().clear();
        api.audit_work(&*link, RELAY, now - 1800);
        assert!(relay.ops().is_empty(), "not an hour since the catch-up");
        api.audit_work(&*link, RELAY, now);
        assert_eq!(relay.ops(), ["api-checkpoint-csr", "api-checkpoint-cert"]);
        assert_eq!(certs(), 1);
        assert!(console.keys("acme").len() > keys, "the console keeps the new certificate before the relay installs it");
        // the next check is an hour later; a certificate in date is not renewed
        *relay.csr_now.lock() = now;
        relay.sent.lock().clear();
        api.audit_work(&*link, RELAY, now + 1800);
        assert!(relay.ops().is_empty());
        api.audit_work(&*link, RELAY, now + 3600);
        assert_eq!(relay.ops(), ["api-checkpoint-csr"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_api_chains_backfill_longer_than_one_run_goes_on_at_the_next_tick() {
        let d = temp("backfill");
        let (log, _) = logger();
        let mut r = FakeRelay::new(RELAY, "acme", &d.join("relay"), log.clone());
        r.page = 1;
        let relay = Arc::new(r);
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![relay.clone()]));
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        let console = chains(&d.join("console"), "console");
        api.set_audit(console.clone(), issuer(&d));
        let mine = chains(&relay.dir, RELAY);
        *relay.audit.lock() = Some(mine.clone());
        let n = PAGES_MAX as u64 + 6;
        for i in 1..=n {
            mine.record("acme", call_entry(i), NOW + i as i64).unwrap();
        }
        // the catch-up stops after PAGES_MAX pages and still succeeds (other api ops are not held up)
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, now_s()));
        assert_eq!(console.head("acme", RELAY, Repr::AsIs).0, PAGES_MAX as u64);
        assert!(api.inner.lock().backfill.contains(&(RELAY.to_string(), "acme".to_string())));
        // the fleet's minute resumes it from the stored heads until a page says no more
        api.audit_tick(link.clone(), now_s());
        assert!(wait_for(|| {
            let inner = api.inner.lock();
            !inner.backfill.contains(&(RELAY.to_string(), "acme".to_string())) && !inner.audit_busy.contains(RELAY)
        }));
        for r in Repr::ALL {
            assert_eq!(console.head("acme", RELAY, r), mine.head("acme", RELAY, r), "{r:?}");
        }
        let afters: Vec<u64> = relay.sent.lock().iter().filter(|(op, _)| op == "api-chains").map(|(_, b)| b["after"]["as_is"].as_u64().unwrap()).collect();
        assert_eq!(afters, (0..=n).collect::<Vec<u64>>(), "each page from the stored head, none twice");
        // nothing left: the next minute asks nothing
        relay.sent.lock().clear();
        api.audit_tick(link.clone(), now_s());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(relay.ops().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── API-1d 2.4, 5.1: spokes relays ──

    const SPOKE: &str = "n_00000000000000000000000000000a01";

    /// A map whose `spokes.relays` lists `relays`.
    fn spokes_map(seq: i64, relays: &[&str]) -> VerifiedApiMap {
        let mut vm = map(seq, 12, NOW + 30 * 86_400);
        vm.wire["map"]["spokes"] = json!({"root": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "root_spki": "ab".repeat(32), "relays": relays});
        vm.hash = api_map_hash(&vm.wire["map"]);
        vm
    }

    fn sent_ops(relay: &FakeRelay) -> Vec<String> {
        relay.sent.lock().iter().map(|(op, _)| op.clone()).collect()
    }

    fn body_of(relay: &FakeRelay, op: &str) -> Option<Value> {
        relay.sent.lock().iter().rev().find(|(o, _)| o == op).map(|(_, b)| b.clone())
    }

    #[test]
    fn a_spokes_relay_takes_api_orgs_before_api_heads_and_maps_with_trust_and_a_meet_relay_never_does() {
        let d = temp("spokes-sync");
        let (log, _) = logger();
        let spokes = Arc::new(FakeRelay::new(RELAY, "acme", &d.join("spokes"), log.clone()));
        let meet = Arc::new(FakeRelay::new(OTHER, "acme", &d.join("meet"), log.clone()));
        let link: Arc<dyn FleetLink> = Arc::new(Fleet(vec![spokes.clone(), meet.clone()]));
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        // bound while it is offline: recorded, nothing sent
        *spokes.up.lock() = false;
        assert!(!api.spokes_bind(Some(link.clone()), RELAY, "acme", true, NOW).unwrap());
        *spokes.up.lock() = true;
        assert!(spokes.sent.lock().is_empty());
        // the root and signer policy the save verified the map with
        api.save_map_trust("acme", b"root-der", Some("CRL PEM"));
        let policy = json!({"v": 3, "org_domains": {"acme": ["acme.example"]}, "sig": "s"});
        api.save_signer_policy("acme", policy.as_object().unwrap()).unwrap();
        api.publish_verified(None, spokes_map(1, &[RELAY]), NOW).unwrap();
        for r in [RELAY, OTHER] {
            api.on_welcomed(r);
            assert!(api.needs_sync(r), "{r}");
            assert!(api.sync(&*link, r, NOW), "{r}");
        }
        // R6-10: `api-orgs` with the recorded list right after welcome, then `api-heads`, then `api-features`
        assert_eq!(&sent_ops(&spokes)[..3], ["api-orgs", "api-heads", "api-features"]);
        assert_eq!(body_of(&spokes, "api-orgs").unwrap(), json!({"orgs": ["acme"], "generation": 1}));
        let sent = body_of(&spokes, "api-map").expect("the map reached the spokes relay");
        assert_eq!(sent["trust"], json!({"root": crate::meet_x509::der_to_pem(b"root-der"), "crl": "CRL PEM", "signer_policy": policy}));
        // a Meet relay: no `api-orgs`, and its map carries no trust
        assert!(!sent_ops(&meet).iter().any(|op| op == "api-orgs"));
        assert_eq!(sent_ops(&meet)[0], "api-heads");
        assert!(body_of(&meet, "api-map").unwrap().get("trust").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_map_that_does_not_list_the_spokes_relay_is_not_sent_and_its_catch_up_still_ends() {
        let d = temp("spokes-unlisted");
        let (log, _) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        *relay.up.lock() = false;
        api.spokes_bind(Some(link.clone()), RELAY, "acme", true, NOW).unwrap();
        *relay.up.lock() = true;
        api.save_map_trust("acme", b"root-der", None);
        api.save_signer_policy("acme", json!({"v": 3}).as_object().unwrap()).unwrap();
        // bound on the relay, but the signed map binding it is not saved yet
        api.publish_verified(None, spokes_map(1, &[]), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        assert!(!relay.ops().iter().any(|op| op == "api-map" || op == "api-pseudonym-key"), "{:?}", relay.ops());
        // the save that lists it goes out with its trust
        api.publish_verified(Some(link.clone()), spokes_map(2, &[RELAY]), NOW).unwrap();
        assert!(wait_for(|| body_of(&relay, "api-map").is_some_and(|b| b["map"]["map"]["seq"] == 2 && b["trust"]["root"].is_string())));
        // no saved trust: the map is held back and the catch-up stays incomplete
        let bare = temp("spokes-no-trust");
        let (log, _) = logger();
        let (relay, link) = one(&bare, &log);
        let api = Arc::new(ConsoleApi::open(Some(&bare.join("console")), log, vault()));
        *relay.up.lock() = false;
        api.spokes_bind(Some(link.clone()), RELAY, "acme", true, NOW).unwrap();
        *relay.up.lock() = true;
        api.publish_verified(None, spokes_map(1, &[RELAY]), NOW).unwrap();
        api.on_welcomed(RELAY);
        assert!(!api.sync(&*link, RELAY, NOW));
        assert!(!relay.ops().iter().any(|op| op == "api-map"));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn bound_records_are_durable_and_an_unbind_while_offline_goes_first_at_reconnect() {
        let d = temp("spokes-bound");
        let (log, _) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        // connected: `api-orgs` at once with the full list
        assert!(api.spokes_bind(Some(link.clone()), RELAY, "acme", true, NOW).unwrap());
        assert_eq!(relay.sent.lock().first().cloned().unwrap(), ("api-orgs".to_string(), json!({"orgs": ["acme"], "generation": 1})));
        assert!(api.spokes_bind(Some(link.clone()), RELAY, "beta", true, NOW).unwrap());
        assert!(wait_for(|| body_of(&relay, "api-orgs") == Some(json!({"orgs": ["acme", "beta"], "generation": 2}))));
        assert!(api.spokes_bind(None, RELAY, "nope!", true, NOW).is_err(), "an org id");
        // kept on disk
        let again = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        assert_eq!(again.spokes_bound(RELAY), ["acme", "beta"]);
        assert!(again.spokes_bound(OTHER).is_empty());
        // unbound while the relay is away: recorded only, then first thing at its next reconnect
        *relay.up.lock() = false;
        assert!(!again.spokes_bind(Some(link.clone()), RELAY, "acme", false, NOW).unwrap());
        assert_eq!(ConsoleApi::open(Some(&d.join("console")), log, vault()).spokes_bound(RELAY), ["beta"]);
        *relay.up.lock() = true;
        // let the bind threads of `api` settle, then watch the reconnect alone
        std::thread::sleep(std::time::Duration::from_millis(200));
        relay.sent.lock().clear();
        again.on_welcomed(RELAY);
        assert!(again.needs_sync(RELAY), "a spokes relay with nothing else to send still gets api-orgs");
        assert!(again.sync(&*link, RELAY, NOW));
        // the generation was kept on disk across the reopen and raised by the unbinding
        assert_eq!(relay.sent.lock().first().cloned().unwrap(), ("api-orgs".to_string(), json!({"orgs": ["beta"], "generation": 3})));
        // a failed `api-orgs` leaves the reconnect sync incomplete, so the minute tick tries again
        let gone = Arc::new(Fleet(Vec::new()));
        again.on_welcomed(RELAY);
        assert!(!again.sync_once(&*gone, RELAY, NOW));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Shared contract item 3, R6-10: saving the same Meet org CA root again changes nothing; another root is a
    /// rotation: every spokes relay's record (a relay with no org bound too, since it may still pin the old root) takes
    /// a new generation releasing the org's root, sent first at the next catch-up, and the release is dropped once the
    /// relay acknowledged it, so a resend never releases the newly pinned root.
    #[test]
    fn a_root_rotation_releases_the_pinned_root_under_a_new_generation_once() {
        let d = temp("spokes-rotate");
        let (log, _) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log.clone(), vault()));
        *relay.up.lock() = false;
        api.spokes_bind(Some(link.clone()), RELAY, "acme", true, NOW).unwrap();
        api.spokes_bind(None, OTHER, "beta", true, NOW).unwrap();
        api.spokes_bind(None, OTHER, "beta", false, NOW).unwrap();
        api.save_map_trust("acme", b"root-one", None);
        api.save_map_trust("acme", b"root-one", None);
        let record = |r: &str| api.spokes.lock().get(r).cloned().unwrap();
        assert_eq!((record(RELAY).generation, record(RELAY).release_roots.len()), (1, 0), "the same root is no rotation");
        api.save_map_trust("acme", b"root-two", None);
        assert_eq!(record(RELAY), SpokesBound { orgs: vec!["acme".into()], generation: 2, release_roots: vec!["acme".into()] });
        assert_eq!(record(OTHER), SpokesBound { orgs: Vec::new(), generation: 3, release_roots: vec!["acme".into()] });
        // kept on disk; the reconnect sends the release first, then the record forgets it
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        *relay.up.lock() = true;
        api.on_welcomed(RELAY);
        api.sync(&*link, RELAY, NOW);
        assert_eq!(relay.sent.lock().first().cloned().unwrap(), ("api-orgs".to_string(), json!({"orgs": ["acme"], "generation": 2, "release_roots": ["acme"]})));
        assert_eq!(api.spokes.lock().get(RELAY).cloned().unwrap().release_roots, Vec::<String>::new());
        relay.sent.lock().clear();
        api.on_welcomed(RELAY);
        api.sync(&*link, RELAY, NOW);
        assert_eq!(body_of(&relay, "api-orgs").unwrap(), json!({"orgs": ["acme"], "generation": 2}), "the resend releases nothing");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn narrowing_a_spokes_target_journals_client_drop_target_only_while_spokes_is_open() {
        let d = temp("spokes-target");
        let (log, _) = logger();
        let (relay, link) = one(&d, &log);
        let api = Arc::new(ConsoleApi::open(Some(&d.join("console")), log, vault()));
        api.publish_verified(None, map(1, 12, NOW + 30 * 86_400), NOW).unwrap();
        // a relay of the org that does not report `spokes` (revision 5)
        *relay.features.lock() = Some(json!({"map": [1, 2], "features": [crate::api_features::EVENTS]}));
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        let e = api.append(Some(link.clone()), "acme", "client_drop_target", json!({"client": CLIENT, "spoke": SPOKE}), None, NOW).unwrap();
        assert_eq!((e["action"].as_str(), e["target"].as_str()), (Some("client_suspend"), Some(CLIENT)), "the revision 3 fallback");
        // the relay reports `spokes` after an update: the action itself
        *relay.features.lock() = None;
        api.on_welcomed(RELAY);
        assert!(api.sync(&*link, RELAY, NOW));
        let e = api.append(Some(link.clone()), "acme", "client_drop_target", json!({"client": CLIENT, "spoke": SPOKE}), None, NOW).unwrap();
        assert_eq!((e["action"].as_str(), &e["target"]), (Some("client_drop_target"), &json!({"client": CLIENT, "spoke": SPOKE})));
        let _ = std::fs::remove_dir_all(&d);
    }
}
