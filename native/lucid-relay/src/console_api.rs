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
    /// Relays whose audit work runs on a thread now.
    audit_busy: std::collections::HashSet<String>,
    /// 13: the license edition the maps were last held to (`set_edition`); None until first read.
    edition: Option<Option<Edition>>,
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
    /// 11: told when the destinations may have changed (None: a map, a tightening or the edition; Some((org, id)):
    /// that destination's credential), so the export engine applies it at once (`set_export_hook`, at start).
    export_hook: std::sync::OnceLock<ExportHook>,
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
        ConsoleApi {
            dir: dir.map(Path::to_path_buf),
            logger,
            vault,
            inner: Mutex::new(Inner { store, orgs, relays: HashMap::new(), no_audit: Default::default(), checkpoint_at: HashMap::new(), backfill: Default::default(), audit_busy: Default::default(), edition: None }),
            sending: Mutex::new(HashMap::new()),
            issue: IssueState::new(),
            fetch: FetchCache::new(FETCH_MAX_AGE),
            audit: std::sync::OnceLock::new(),
            export_hook: std::sync::OnceLock::new(),
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
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn publish_map(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, signed: &Value, trust: &ApiTrust, now: i64, policy: Option<&Map<String, Value>>, edition: Option<Edition>) -> Result<AcceptOutcome, ApiMapError> {
        let r = self.inner.lock().store.accept(signed, trust, now, policy, edition);
        self.published(link, r, now)
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
        let r = self.inner.lock().store.pin(vm);
        self.published(link, r, now)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn published(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, r: Result<AcceptOutcome, ApiMapError>, now: i64) -> Result<AcceptOutcome, ApiMapError> {
        match &r {
            Ok(AcceptOutcome::Pinned(vm)) => {
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
        // 2.5, 11: a destination tightening takes effect on the console's exports at once
        self.export_changed(None);
        if let Some(link) = link {
            self.deliver_org(link, org);
        }
        Ok(entry)
    }

    /// The journal head (last tseq) of an org.
    #[cfg(test)]
    pub fn journal_head(&self, org: &str) -> u64 {
        self.inner.lock().orgs.get(org).map_or(0, OrgJournal::head)
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
            Some(RelayApi::Unknown) => Self::holds_any(&inner),
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
    /// after its tseq, strictly in order, each answered before the next; the acknowledgments are kept on disk. False
    /// when a request failed (the next contact tries again).
    pub fn sync(&self, link: &dyn FleetLink, relay: &str, now: i64) -> bool {
        let gate = self.sending.lock().entry(relay.to_string()).or_default().clone();
        let _one = gate.lock();
        let unknown = matches!(self.inner.lock().relays.get(relay), Some(RelayApi::Unknown));
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
        }
        let orgs: Vec<String> = match self.inner.lock().relays.get(relay) {
            Some(RelayApi::Heads(h)) => h.keys().cloned().collect(),
            _ => Vec::new(),
        };
        // then, in the reconnect catch-up only, per org the checkpoint certificate and the backfill of the relay's
        // audit chains (9.3, 12.2); later deliveries carry maps and journal entries alone
        let done = orgs.iter().all(|org| self.sync_org(link, relay, org, now) && (!unknown || self.audit_org(link, relay, org, now)));
        if unknown && self.audit.get().is_some() {
            // a relay that stays connected has its certificates checked again hourly (`audit_tick`)
            self.inner.lock().checkpoint_at.insert(relay.to_string(), now + CHECKPOINT_EVERY);
        }
        done
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
        let (orgs, renew, backfill) = {
            let inner = self.inner.lock();
            let Some(RelayApi::Heads(h)) = inner.relays.get(relay) else { return };
            if inner.no_audit.contains(relay) {
                return;
            }
            let renew = inner.checkpoint_at.get(relay).is_some_and(|at| now >= *at);
            let backfill: Vec<String> = inner.backfill.iter().filter(|(r, _)| r == relay).map(|(_, o)| o.clone()).filter(|o| h.contains_key(o)).collect();
            (h.keys().cloned().collect::<Vec<String>>(), renew, backfill)
        };
        if renew {
            let ok = orgs.iter().all(|org| self.checkpoint_org(link, relay, org, now));
            let next = if ok { now + CHECKPOINT_EVERY } else { now };
            self.inner.lock().checkpoint_at.insert(relay.to_string(), next);
        }
        for org in backfill {
            self.backfill_org(link, relay, &org);
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
                .filter(|(r, _)| inner.checkpoint_at.get(*r).is_some_and(|at| now >= *at) || inner.backfill.iter().any(|(b, _)| b == *r))
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
    /// days). The destination must be in the org's pinned map with a `credential` the value fits. The value never
    /// enters a log, the map or the audit. The export engine makes the destination's sink again at once. Called by
    /// the Exports screen (slice 1a6).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn put_destination_credential(&self, org: &str, id: &str, credential: crate::api_export_wire::Credential, now: i64) -> Result<(), String> {
        let entry = {
            let inner = self.inner.lock();
            inner.store.get(org, "").and_then(|m| m.map().get("destinations")?.as_array()?.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(id)).cloned())
        };
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

    fn sealed_destination(&self, org: &str, id: &str) -> Option<Value> {
        let raw = vault_do(&*self.vault, |v| v.get(&crate::api_export::seal_name(org, id)))?;
        parse_json(std::str::from_utf8(&raw).ok()?)
    }

    /// 11.3: whether a destination's credential is sealed (and reads).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has_destination_credential(&self, org: &str, id: &str) -> bool {
        self.destination_credential(org, id).is_some()
    }

    /// The sealed credential of a destination, for its sink only.
    pub fn destination_credential(&self, org: &str, id: &str) -> Option<crate::api_export_wire::Credential> {
        crate::api_export::credential_of(self.sealed_destination(org, id)?.get("credential")?)
    }

    /// 11.3: the "rotate by" date (unix seconds) of a destination's vendor token or service account key.
    #[cfg_attr(not(test), allow(dead_code))]
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
    // The API settings page (slice 1a6) calls this; until then only tests do.
    #[cfg_attr(not(test), allow(dead_code))]
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
        let issuer = self.inner.lock().store.get(org, "")?.map().get("issuer").cloned().unwrap_or(Value::Null);
        if let Err(s) = self.issue.source_ok(source, now) {
            let mut a = api_issue::problem(429, "abuse", "Too many requests from this address; try again later.");
            a.headers.push(("Retry-After", s.to_string()));
            return Some(a);
        }
        let i = issuer.get("url").and_then(Value::as_str).unwrap_or_default();
        let body = match doc {
            ApiDoc::AuthorizationServer => api_issue::as_metadata(i, &format!("{i}/oauth/token"), Some(&format!("{i}/oauth/revoke")), &format!("{i}/jwks.json")),
            ApiDoc::ProtectedResource => api_issue::resource_metadata(i, &[i], &crate::api_map::SCOPES),
            ApiDoc::Jwks => api_issue::jwks(issuer.get("jwks").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)),
        };
        Some(api_issue::document(body))
    }

    /// 5.2 (`revoke` false) and 5.5 (`revoke` true) on the front door for the org of the request path. None for an org
    /// without a pinned map (404 `not-found`, after the source limiter). `body_refused` is the port's verdict on a body
    /// it could not take (`too-large`, `request`). The issuer key must be listed in the pinned map (503
    /// `issuer-key-unlisted`). The store is a snapshot, so no lock is held while a JWKS or discovery fetch runs. A
    /// revocation is journaled as `token_deny` (`until` = the token's `exp`) and sent to the org's relays. `licensed`
    /// is the console's own license state (6.1 `license`). `audit(client, jti, until)` records a revocation in the
    /// org's chain before it is journaled (9.4); its failure answers 503 `audit-unavailable`.
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
        assert!(api.put_destination_credential("acme", d, Credential::Mtls { cert_pem: "C".into(), key_pem: "K".into(), ca_pem: None }, NOW).is_err());
        assert!(api.put_destination_credential("acme", "d_0000000000000000", Credential::Token("x".into()), NOW).is_err());
        assert!(api.put_destination_credential("beta", d, Credential::Token("x".into()), NOW).is_err(), "another org has no such destination");
        assert!(!api.has_destination_credential("acme", d));
        api.put_destination_credential("acme", d, Credential::Token("hec-secret-value".into()), NOW).unwrap();
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
    }

    impl FakeRelay {
        fn new(id: &'static str, org: &str, dir: &Path, logger: Arc<Logger>) -> FakeRelay {
            FakeRelay { id, org: org.to_string(), old: false, up: Mutex::new(true), dir: dir.to_path_buf(), store: Mutex::new(ApiMapStore::load(Some(dir))), vault: Arc::new(Mutex::new(MemVault::default())), sent: Mutex::new(Vec::new()), heads: Mutex::new(None), logger, audit: Mutex::new(None), page: 2, no_audit: false, csr_now: Mutex::new(NOW) }
        }

        fn ops(&self) -> Vec<String> {
            self.sent.lock().iter().map(|(op, _)| op.clone()).collect()
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
                "api-heads" => Ok(self.heads.lock().clone().unwrap_or_else(|| {
                    let (seq, tseq) = self.store.lock().head(&self.org);
                    let mut o = Map::new();
                    o.insert(self.org.clone(), json!({ "seq": seq, "tseq": tseq }));
                    Value::Object(o)
                })),
                "api-tighten" => crate::fleet_agent::api_tighten_answer(&mut self.store.lock(), body, &mut Vec::new()),
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
        assert_eq!(sent.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(), ["api-heads", "api-tighten", "api-tighten"], "the key and map are not sent again");
        assert_eq!((sent[1].1["entry"]["tseq"].as_u64(), sent[2].1["entry"]["tseq"].as_u64()), (Some(1), Some(2)));
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
            api.api_token(None, "acme", revoke, &http, None, &|_: &str| true, licensed, &|_: &str, _: &str, _: i64| Ok(()), NOW)
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
        crate::fleet_agent::api_shipped_set(&rdir, "acme", "as_is", 5).unwrap();
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
}
