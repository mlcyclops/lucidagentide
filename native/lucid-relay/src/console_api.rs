// Contract API-1 (docs/api/contract.md) 2.4, 2.5, 2.6 and 3.4, the console end: the org api maps the console holds
// (`<state>/api-console/`, an `ApiMapStore`), the per-org tightening journal (`<state>/api-journal-console/<org>.jsonl`,
// append-only and flushed after every entry, rewritten only when acknowledged and folded entries are pruned;
// `<org>.acks.json` keeps the pruned base, per relay the acknowledged tseq and pseudonym key version, and the key's
// version and start), each org's pseudonym key (32 random bytes, sealed), the relays' api heads (`api-heads`, asked
// first after `welcome`; an older relay answers `fleet-op` and gets no api op until it reconnects), the reconnect
// catch-up (key, then map, then journal entries strictly in order, before any other request), and the console-wide
// relay grace of the fleet verifier (3.4).

use crate::api_map::{check_tighten, AcceptOutcome, ApiMapError, ApiMapStore, ApiTrust, Edition, VerifiedApiMap};
use crate::codec::{b64u, parse_json, stringify};
use crate::console_fleet::{FleetLink, LinkError};
use crate::fleet_ca::{vault_do, NoVault, Vault, VaultLock};
use crate::log::{Fields, Level, Logger};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
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
}

/// The console's api maps, journals and pseudonym keys, and their delivery to the relays (2.4, 2.5, 2.6).
pub struct ConsoleApi {
    dir: Option<PathBuf>,
    logger: Arc<Logger>,
    vault: Arc<dyn VaultLock>,
    inner: Mutex<Inner>,
    /// One delivery at a time per relay, so entries reach it strictly in order.
    sending: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

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
        ConsoleApi { dir: dir.map(Path::to_path_buf), logger, vault, inner: Mutex::new(Inner { store, orgs, relays: HashMap::new() }), sending: Mutex::new(HashMap::new()) }
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
        let v = json!({ "base": j.base, "tseq": j.acks, "pkv": j.keys, "key": key });
        crate::fleet_local::write_durable(&dir.join(format!("{org}.acks.json")), stringify(&v).as_bytes()).map_err(io_e)
    }

    // ── maps (2.4) ──

    /// Verify and pin a signed map in the console's store, then send it (`api-map`) to every connected relay of its
    /// org. A conflict raises `api.map.conflict`.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_map(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, signed: &Value, trust: &ApiTrust, now: i64, policy: Option<&Map<String, Value>>, edition: Edition) -> Result<AcceptOutcome, ApiMapError> {
        let r = self.inner.lock().store.accept(signed, trust, now, policy, edition);
        self.published(link, r, now)
    }

    /// `publish_map` for a map already verified.
    pub fn publish_verified(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, vm: VerifiedApiMap, now: i64) -> Result<AcceptOutcome, ApiMapError> {
        let r = self.inner.lock().store.pin(vm);
        self.published(link, r, now)
    }

    fn published(self: &Arc<Self>, link: Option<Arc<dyn FleetLink>>, r: Result<AcceptOutcome, ApiMapError>, now: i64) -> Result<AcceptOutcome, ApiMapError> {
        match &r {
            Ok(AcceptOutcome::Pinned(vm)) => {
                self.prune(&vm.org, now);
                if let Some(link) = link {
                    self.deliver_org(link, &vm.org);
                }
            }
            Ok(AcceptOutcome::Conflict { org, seq, pinned_hash, offered_hash }) => {
                let f = Fields::new().with("org", org.as_str()).with("seq", *seq).with("pinned", pinned_hash.as_str()).with("offered", offered_hash.as_str()).with("via", "console");
                self.logger.security("api.map.conflict", &f, Level::Error);
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
        if let Some(link) = link {
            self.deliver_org(link, org);
        }
        Ok(entry)
    }

    /// The journal head (last tseq) of an org.
    pub fn journal_head(&self, org: &str) -> u64 {
        self.inner.lock().orgs.get(org).map_or(0, OrgJournal::head)
    }

    /// The entries still kept for an org (after pruning).
    pub fn journal_len(&self, org: &str) -> usize {
        self.inner.lock().orgs.get(org).map_or(0, |j| j.entries.len())
    }

    /// The tseq a relay acknowledged for an org.
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
            let next = OrgJournal { base: j.base + n as u64, entries: Vec::new(), acks: j.acks.clone(), keys: j.keys.clone(), key: j.key };
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
        self.inner.lock().relays.insert(relay.to_string(), RelayApi::Unknown);
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
        orgs.iter().all(|org| self.sync_org(link, relay, org, now))
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
                    let f = Fields::new().with("relay", relay).with("org", org).with("seq", map["map"]["seq"].as_i64().unwrap_or(0)).with("via", "relay");
                    self.logger.security("api.map.conflict", &f, Level::Error);
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

    // ── 3.4 ──

    /// The `relay` grace of the fleet verifier at `now` (seconds): the minimum of `grace.relay` (lowered by the
    /// journal) over every org map the console holds; 0 when it holds none or any of them has expired.
    pub fn relay_grace_hours(&self, now: i64) -> u32 {
        let inner = self.inner.lock();
        let orgs = inner.store.issuers();
        orgs.keys().map(|o| inner.store.grace_hours(o, "relay", now).unwrap_or(0)).min().unwrap_or(0)
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
        vault: Mutex<MemVault>,
        sent: Mutex<Vec<(String, Value)>>,
        heads: Mutex<Option<Value>>,
        logger: Arc<Logger>,
    }

    impl FakeRelay {
        fn new(id: &'static str, org: &str, dir: &Path, logger: Arc<Logger>) -> FakeRelay {
            FakeRelay { id, org: org.to_string(), old: false, up: Mutex::new(true), dir: dir.to_path_buf(), store: Mutex::new(ApiMapStore::load(Some(dir))), vault: Mutex::new(MemVault::default()), sent: Mutex::new(Vec::new()), heads: Mutex::new(None), logger }
        }

        fn ops(&self) -> Vec<String> {
            self.sent.lock().iter().map(|(op, _)| op.clone()).collect()
        }

        fn answer(&self, op: &str, body: &Value) -> Result<Value, Refusal> {
            if self.old && op.starts_with("api-") {
                return Err(Refusal::of("fleet-op"));
            }
            match op {
                "api-heads" => Ok(self.heads.lock().clone().unwrap_or_else(|| {
                    let (seq, tseq) = self.store.lock().head(&self.org);
                    let mut o = Map::new();
                    o.insert(self.org.clone(), json!({ "seq": seq, "tseq": tseq }));
                    Value::Object(o)
                })),
                "api-tighten" => crate::fleet_agent::api_tighten_answer(&mut self.store.lock(), body),
                "api-pseudonym-key" => crate::fleet_agent::api_pseudonym_key_store(&self.dir, &self.vault, body),
                "api-map" => {
                    let wire = body["map"].as_object().unwrap().clone();
                    let m = &wire["map"];
                    let vm = VerifiedApiMap { org: m["org"].as_str().unwrap().into(), seq: m["seq"].as_i64().unwrap(), expires: m["expires"].as_i64().unwrap(), hash: api_map_hash(m), signer: "root".into(), wire: wire.clone() };
                    let mut store = self.store.lock();
                    let r = store.pin(vm);
                    crate::fleet_agent::api_map_pinned(r, &mut store, body, &self.logger)
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
        let gap = crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "client_suspend", json!(CLIENT)))).unwrap_err();
        assert_eq!((gap.status, gap.code.as_str()), (409, "tseq-gap"));
        assert_eq!(crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(1, "client_suspend", json!(CLIENT)))).unwrap(), json!({"ok": true, "tseq": 1}));
        let wide = crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "destination_identities", json!({"destination": "d_9a8b7c6d5e4f3a2b", "identities": "as_is"})))).unwrap_err();
        assert_eq!(wide.code, "not-tightening");
        assert_eq!(crate::fleet_agent::api_tighten_answer(&mut store, &body(entry(2, "api_off", json!("acme")))).unwrap()["tseq"], 2);
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
        assert!(api.publish_map(Some(link.clone()), &bad, &trust, now, doc["policy"].as_object(), Edition::Enterprise).is_err());
        let vm = match api.publish_map(Some(link.clone()), &signed, &trust, now, doc["policy"].as_object(), Edition::Enterprise).unwrap() {
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
}
