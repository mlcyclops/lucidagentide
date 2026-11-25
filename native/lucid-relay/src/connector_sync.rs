// Contract API-1 revision 5 (phase 1c), sections 2.8 (the console link), 4.2 (the 4b console journal entries), 7.6
// (stopping a client) and 12.1 (the connector's audit chains): the connector's own channel to the front door.
//
// The connector is not a fleet peer: it pulls its API state from `I = <console>/api/orgs/<org>` over blocking HTTPS,
// authenticated by mTLS with one of its API app identities, the front door pinned by `console_spki` (the SHA-256 of
// its certificate's SubjectPublicKeyInfo; TLS 1.3 with the fleet port's provider and schemes), and in an enclave
// every connection's addresses inside `enclave_networks`.
//
// `GET I/v1/connector/sync` is applied as a relay applies its api ops: the map verified by `ApiMapStore::accept`
// (the Meet CA root, signer policy and CRL `OrgTrust` holds, the pinned org policy, edition Enterprise) after the
// active 4b entries were fold-checked against it (`api_cjournal::fold`), `base` by `rebase`, the relay journal by
// `apply_tighten` in `tseq` order, the 4b entries in `cseq` order with each `prev_cseq` naming the last applied one
// (else `tseq-gap`, and nothing after it applies until a later sync). The map store lives under `state_dir`
// (`api-maps`, `api-journal`), the 4b journal and its head in the owner-only flushed `connector-sync.json`, the
// pseudonym key, client id keys and the person deny list sealed. Then the person revokes are published
// (`api_delegated::publish_revokes`), local denies the journal now covers dropped, the full sync time recorded, and
// `POST I/v1/connector/ack` sent. A failed round backs off from 1 s doubling to 60 s.
//
// Freshness (2.8): a full sync within the map's `connectors[].stale_s`; a watch every 5 s writes `connector.stale.on`
// when that ends and `connector.stale.off` after the next full sync. The audit chains (12.1) are an `ApiAudit` with
// source = the connector id, its checkpoint key certified by the console (`checkpoint-csr`), shipped with
// `POST I/v1/connector/audit` exactly as the fleet op `api-audit`.

use crate::api_audit::{chain_hash, checkpoint_signed_bytes, org_ok, ApiAudit, PseudonymKeys, Repr, AUDIT_DIR};
use crate::api_checkpoint::RelayCheckpoints;
use crate::api_cjournal::{self as cj, ConsoleEntry, Reach};
use crate::api_map::{AcceptOutcome, ApiMapError, ApiMapStore, ApiTrust, Edition};
use crate::codec::{b64u, hex, now_ms, parse_json, sha256, stringify, unb64u};
use crate::connector::{Config, Connector, Enclave};
use crate::connector_enroll::Enroll;
use crate::connector_seal::{make_private_dir, names, write_private, SealedStore};
use crate::connector_session::OrgTrust;
use crate::fleet_agent::{self as fa, ApiNote, ShipStep};
use crate::fleet_ca::{NoVault, Vault, VaultLock};
use crate::fleet_port::{fleet_provider, verify_tls13, SCHEMES};
use crate::fleet_wire::Refusal;
use crate::log::Logger;
use crate::meet::{log_error, log_info, log_warn};
use crate::meet_x509::Cert;
use parking_lot::{Condvar, Mutex, RwLock};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The owner-only file under `state_dir` holding the applied 4b console journal: `{org, cseq, active, synced_ms}`.
pub const SYNC_FILE: &str = "connector-sync.json";
/// 2.8: the long poll's `wait` (seconds).
pub const SYNC_WAIT_S: u64 = 30;
/// The sync request's timeout: the long poll and room for the answer.
const SYNC_TIMEOUT_S: f64 = 45.0;
/// Every other console call's timeout.
const CALL_TIMEOUT_S: f64 = 30.0;
/// The backoff after a failed round: 1 s doubling to 60 s.
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// 2.8: the freshness watch looks this often.
pub const WATCH_EVERY: Duration = Duration::from_secs(5);
/// The audit shipping loop looks for new entries this often.
const SHIP_EVERY: Duration = Duration::from_secs(2);
/// A chain the console could not take is tried again after this long.
const SHIP_SKIP_RESET: Duration = Duration::from_secs(3600);
/// The checkpoint certificate is checked this often (`api_checkpoint::renewal_due`).
const CHECKPOINT_EVERY: Duration = Duration::from_secs(60);
/// The mTLS client config is built again after this long (an app certificate renews by itself).
const TLS_REBUILD: Duration = Duration::from_secs(600);
/// 2.8 ack: at most this many conversations.
pub const ACK_CONVERSATIONS_MAX: usize = 5000;

// ── the sync state ──────────────────────────────────────────────────────────────────────────────────────────

/// The org's audit pseudonym key from sync (1a 11.4).
#[derive(Clone, PartialEq, Eq)]
struct Pseudonym {
    pkv: u32,
    key: Vec<u8>,
    not_before: i64,
}

/// One person's stop of a client (7.6): kept until an applied `person_revoke` covers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deny {
    pub client: String,
    pub principal: String,
    pub mid: String,
    pub at_ms: i64,
    /// The console acknowledged `person-stop`.
    pub acked: bool,
}

impl Deny {
    fn to_json(&self) -> Value {
        json!({"client": self.client, "principal": self.principal, "mid": self.mid, "at": self.at_ms, "acked": self.acked})
    }

    fn of(v: &Value) -> Option<Deny> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Deny { client: s("client")?, principal: s("principal")?, mid: s("mid").unwrap_or_default(), at_ms: v.get("at").and_then(Value::as_i64).unwrap_or(0), acked: v.get("acked") == Some(&Value::Bool(true)) })
    }
}

#[derive(Default)]
struct St {
    store: ApiMapStore,
    /// The active 4b entries, cseq order.
    console: Vec<ConsoleEntry>,
    /// The last applied 4b cseq (a connector sees only 4b entries).
    cseq: u64,
    synced_ms: i64,
    client_keys: BTreeMap<String, [u8; 32]>,
    pseudonym: Option<Pseudonym>,
    denies: Vec<Deny>,
}

/// What a connector applies a received signed map with: the relay's `ApiMapStore::accept` in production
/// (`trusted_accept`), a plain pin in tests.
pub type MapAccept<'a> = dyn Fn(&mut ApiMapStore, &Value) -> Result<AcceptOutcome, ApiMapError> + 'a;

/// The connector's API state from the console (2.8): the pinned map and applied relay journal, the active 4b console
/// journal, the client id keys, the pseudonym key, the last full sync and the local person deny list. Interior
/// locking; every change is on disk (or sealed) before it is used.
pub struct SyncState {
    org: String,
    connector_id: String,
    dir: Option<PathBuf>,
    sealed: Option<Arc<SealedStore>>,
    st: RwLock<St>,
    /// Wakes the person-stop sender.
    wake: (Mutex<bool>, Condvar),
}

fn io_e(e: impl std::fmt::Display) -> ApiMapError {
    ApiMapError::new("io", e.to_string())
}

/// The connector's `connectors[]` entry of the org's serving pinned map.
fn entry_of(store: &ApiMapStore, org: &str, id: &str) -> Option<Map<String, Value>> {
    store.get(org, "")?.map().get("connectors")?.as_array()?.iter().filter_map(Value::as_object).find(|c| c.get("id").and_then(Value::as_str) == Some(id)).cloned()
}

/// The pinned map lists `principal` in `delegation.denied` of `client` (the journal entry was folded into it).
fn map_denies(store: &ApiMapStore, org: &str, client: &str, principal: &str) -> bool {
    let Some(vm) = store.get(org, "") else { return false };
    vm.map().get("clients").and_then(Value::as_array).into_iter().flatten().filter(|c| c.get("id").and_then(Value::as_str) == Some(client)).any(|c| {
        c.pointer("/delegation/denied").and_then(Value::as_array).is_some_and(|d| d.iter().any(|p| p.as_str() == Some(principal)))
    })
}

/// 5.5 `kid`: the first 16 hex of SHA-256 of the key.
pub fn client_kid(key: &[u8]) -> String {
    hex(&sha256(key))[..16].to_string()
}

impl SyncState {
    /// The state kept under `state_dir` (made owner-only) and in the sealed store, published to the delegated token
    /// check (`api_delegated::publish_revokes`) before this returns. An unreadable journal file or sealed value is an
    /// error: starting without it could serve wider than the console decided.
    pub fn open(org: &str, connector_id: &str, state_dir: &Path, sealed: Arc<SealedStore>) -> Result<SyncState, String> {
        make_private_dir(state_dir).map_err(|e| format!("{} could not be made: {e}", state_dir.display()))?;
        let mut st = St { store: ApiMapStore::load(Some(state_dir)), ..St::default() };
        match std::fs::read(state_dir.join(SYNC_FILE)) {
            Ok(b) => {
                let v: Value = serde_json::from_slice(&b).map_err(|_| format!("{SYNC_FILE} does not read"))?;
                if v.get("org").and_then(Value::as_str) != Some(org) {
                    return Err(format!("{SYNC_FILE} is not {org}'s"));
                }
                st.cseq = v.get("cseq").and_then(Value::as_u64).unwrap_or(0);
                st.synced_ms = v.get("synced_ms").and_then(Value::as_i64).unwrap_or(0);
                for e in v.get("active").and_then(Value::as_array).into_iter().flatten() {
                    st.console.push(ConsoleEntry::parse(e).map_err(|e| format!("{SYNC_FILE}: {}", e.message))?);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{SYNC_FILE} could not be read: {e}")),
        }
        if let Some(keys) = sealed.get(names::CLIENT_ID_KEYS)? {
            for (c, k) in keys.as_object().into_iter().flatten() {
                if let Some(k) = k.as_str().and_then(unb64u).and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok()) {
                    st.client_keys.insert(c.clone(), k);
                }
            }
        }
        if let Some(p) = sealed.get(names::AUDIT_PSEUDONYM_KEY)? {
            st.pseudonym = pseudonym_of(&p);
        }
        if let Some(d) = sealed.get(names::DENY_LIST)? {
            st.denies = d.get("entries").and_then(Value::as_array).into_iter().flatten().filter_map(Deny::of).collect();
        }
        let s = SyncState { org: org.to_string(), connector_id: connector_id.to_string(), dir: Some(state_dir.to_path_buf()), sealed: Some(sealed), st: RwLock::new(st), wake: (Mutex::new(false), Condvar::new()) };
        {
            let mut st = s.st.write();
            crate::api_delegated::publish_revokes(org, &st.console);
            s.drop_covered(&mut st);
        }
        Ok(s)
    }

    /// An in-memory state for tests of every lane: nothing on disk or sealed, nothing published to
    /// `api_delegated` (the registry is process-wide); `cseq` is the highest of `console`.
    #[cfg(test)]
    pub(crate) fn for_test(org: &str, connector_id: &str, store: ApiMapStore, console: Vec<ConsoleEntry>, client_keys: BTreeMap<String, [u8; 32]>, synced_ms: i64) -> SyncState {
        let cseq = console.iter().map(|e| e.cseq).max().unwrap_or(0);
        let st = St { store, console, cseq, synced_ms, client_keys, ..St::default() };
        SyncState { org: org.to_string(), connector_id: connector_id.to_string(), dir: None, sealed: None, st: RwLock::new(st), wake: (Mutex::new(false), Condvar::new()) }
    }

    pub fn org(&self) -> &str {
        &self.org
    }

    pub fn connector_id(&self) -> &str {
        &self.connector_id
    }

    /// A read-only snapshot (`ApiMapStore::org_snapshot`) of the pinned map and the applied relay journal.
    pub fn store(&self) -> ApiMapStore {
        self.st.read().store.org_snapshot(&self.org)
    }

    /// The active (not folded or cleared) 4b console journal entries, cseq order.
    pub fn console_active(&self) -> Vec<ConsoleEntry> {
        self.st.read().console.clone()
    }

    /// This connector's `connectors[]` entry of the pinned map (None: no map, or not listed).
    pub fn connector(&self) -> Option<Map<String, Value>> {
        entry_of(&self.st.read().store, &self.org, &self.connector_id)
    }

    /// (pinned seq, applied tseq, applied cseq).
    pub fn heads(&self) -> (i64, u64, u64) {
        let st = self.st.read();
        let (seq, tseq) = st.store.head(&self.org);
        (seq, tseq, st.cseq)
    }

    /// When the last full sync completed (ms, 0 never).
    pub fn last_sync_ms(&self) -> i64 {
        self.st.read().synced_ms
    }

    /// 2.8 freshness: a full sync completed within the entry's `stale_s` (false without a map or entry).
    pub fn fresh(&self, now_ms: i64) -> bool {
        let st = self.st.read();
        let Some(stale_s) = entry_of(&st.store, &self.org, &self.connector_id).and_then(|c| c.get("stale_s").and_then(Value::as_i64)) else { return false };
        st.synced_ms > 0 && now_ms - st.synced_ms <= stale_s.saturating_mul(1000)
    }

    /// 5.5: the client's id key from the last sync.
    pub fn client_key(&self, client: &str) -> Option<[u8; 32]> {
        self.st.read().client_keys.get(client).copied()
    }

    /// The org's pseudonym key from sync: (pkv, key).
    fn pseudonym(&self) -> Option<(u32, Vec<u8>)> {
        self.st.read().pseudonym.as_ref().map(|p| (p.pkv, p.key.clone()))
    }

    /// 7.6: the person stopped `client` (a c_ id): sealed local deny, then `POST person-stop` retried until
    /// acknowledged. The deny holds in memory even when sealing fails (the Err says so).
    pub fn person_stopped(&self, client: &str, principal: &str, mid: &str) -> Result<(), String> {
        let saved = {
            let mut st = self.st.write();
            if !st.denies.iter().any(|d| d.client == client && d.principal == principal) {
                st.denies.push(Deny { client: client.to_string(), principal: principal.to_string(), mid: mid.to_string(), at_ms: now_ms(), acked: false });
            }
            self.save_denies(&st)
        };
        *self.wake.0.lock() = true;
        self.wake.1.notify_one();
        saved
    }

    /// 7.6: the local deny list (dropped once an applied console journal `person_revoke` covers the pair).
    pub fn locally_denied(&self, client: &str, principal: &str) -> bool {
        self.st.read().denies.iter().any(|d| d.client == client && d.principal == principal)
    }

    /// The stops the console has not acknowledged yet.
    pub fn pending_stops(&self) -> Vec<Deny> {
        self.st.read().denies.iter().filter(|d| !d.acked).cloned().collect()
    }

    /// The console acknowledged the stop of (`client`, `principal`).
    fn stop_acked(&self, client: &str, principal: &str) -> Result<(), String> {
        let mut st = self.st.write();
        let mut changed = false;
        for d in st.denies.iter_mut().filter(|d| d.client == client && d.principal == principal && !d.acked) {
            d.acked = true;
            changed = true;
        }
        if changed {
            self.save_denies(&st)
        } else {
            Ok(())
        }
    }

    /// Wait until a stop is added or `t` passes.
    fn wait_stop(&self, t: Duration) {
        let mut g = self.wake.0.lock();
        if !*g {
            self.wake.1.wait_for(&mut g, t);
        }
        *g = false;
    }

    fn save_denies(&self, st: &St) -> Result<(), String> {
        let Some(sealed) = &self.sealed else { return Ok(()) };
        sealed.put(names::DENY_LIST, &json!({"entries": st.denies.iter().map(Deny::to_json).collect::<Vec<_>>()}))
    }

    /// Drop the local denies an active `person_revoke` (or the pinned map's `delegation.denied`) now covers.
    fn drop_covered(&self, st: &mut St) {
        let St { denies, console, store, .. } = &mut *st;
        let (console, store) = (console.as_slice(), &*store);
        let before = denies.len();
        denies.retain(|d| !cj::person_revoked(console, &d.client, &d.principal) && !map_denies(store, &self.org, &d.client, &d.principal));
        if denies.len() != before {
            if let Err(e) = self.save_denies(st) {
                log_error(&format!("connector_deny_list_not_sealed error={e}"));
            }
        }
    }

    fn save_journal(&self, st: &St, synced_ms: i64) -> Result<(), ApiMapError> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let v = json!({"org": self.org, "cseq": st.cseq, "active": st.console.iter().map(ConsoleEntry::to_value).collect::<Vec<_>>(), "synced_ms": synced_ms});
        write_private(&dir.join(SYNC_FILE), stringify(&v).as_bytes()).map_err(|e| io_e(format!("{SYNC_FILE} could not be written: {e}")))
    }

    /// Apply one sync answer (2.8 "Applying a sync answer"): map, base, relay journal, 4b entries, each step durable;
    /// then, only when every step applied, the keys are sealed and the full sync time recorded. The audit notes of
    /// what applied come back even when a later step stopped the answer (the Err).
    pub fn apply(&self, ans: &Value, accept: &MapAccept, now_ms: i64) -> (Vec<ApiNote>, Result<(), ApiMapError>) {
        let mut notes = Vec::new();
        let mut changed = false;
        let mut st = self.st.write();
        let mut done = self.apply_steps(&mut st, ans, accept, &mut notes, &mut changed);
        if done.is_ok() {
            if let Err(e) = self.take_keys(&mut st, ans) {
                done = Err(io_e(e));
            }
        }
        let synced = if done.is_ok() { now_ms } else { st.synced_ms };
        if changed || done.is_ok() {
            if let Err(e) = self.save_journal(&st, synced) {
                done = done.and(Err(e));
            }
        }
        crate::api_delegated::publish_revokes(&self.org, &st.console);
        self.drop_covered(&mut st);
        if done.is_ok() {
            st.synced_ms = synced;
        }
        (notes, done)
    }

    fn apply_steps(&self, st: &mut St, ans: &Value, accept: &MapAccept, notes: &mut Vec<ApiNote>, changed: &mut bool) -> Result<(), ApiMapError> {
        let org = self.org.as_str();
        if ans.get("org").and_then(Value::as_str) != Some(org) {
            return Err(ApiMapError::new("bad-sync", format!("the sync answer is not {org}'s")));
        }
        // the map: fold-checked against the active 4b entries, then verified and pinned as a relay does
        if let Some(wire) = ans.get("map").filter(|m| !m.is_null()) {
            let map = wire.get("map").unwrap_or(&Value::Null);
            if map.get("org").and_then(Value::as_str) != Some(org) {
                return Err(ApiMapError::new("bad-map", format!("the api map is not {org}'s")));
            }
            let remaining = cj::fold(&st.console, map)?;
            match accept(&mut st.store, wire)? {
                AcceptOutcome::Pinned(vm) => {
                    notes.push(fa::api_note_pinned(&vm));
                    let before = st.console.len();
                    st.console.retain(|e| remaining.contains(&e.id));
                    *changed |= st.console.len() != before;
                }
                AcceptOutcome::Unchanged(_) => {}
                AcceptOutcome::Conflict { org, seq, .. } => {
                    log_error(&format!("api.map.conflict org={org} seq={seq} via=connector-sync"));
                    notes.push(fa::api_note_conflict(&org, seq, None));
                    return Err(ApiMapError::new("conflict", format!("{org}'s api map {seq} was seen with two different hashes")));
                }
            }
        }
        if let Some(base) = ans.get("base").and_then(Value::as_u64) {
            if let Some(from) = st.store.rebase(org, base)? {
                log_warn(&format!("api.journal.rebased org={org} from={from} to={base}"));
                notes.push((org.to_string(), json!({"action": "api.journal.rebased", "resource": org, "result": "ok", "tseq": base})));
            }
        }
        for e in ans.get("journal").and_then(Value::as_array).into_iter().flatten() {
            if e.get("tseq").and_then(Value::as_u64).is_some_and(|t| t <= st.store.head(org).1) {
                continue;
            }
            st.store.apply_tighten(org, e)?;
            notes.push(fa::api_note_tighten(org, e));
        }
        // 4b: cseq order, each naming the last applied 4b entry (r4 2.3 item 4b, r5 4.2)
        for v in ans.get("console_journal").and_then(Value::as_array).into_iter().flatten() {
            let cseq = v.get("cseq").and_then(Value::as_u64).ok_or_else(|| ApiMapError::new("not-tightening", "cseq must be a whole number from 1"))?;
            if cseq <= st.cseq {
                continue;
            }
            let e = ConsoleEntry::parse(v)?;
            if e.reach != Reach::Connector || e.org != org {
                return Err(ApiMapError::new("not-tightening", format!("{} is not a connector entry of {org}", e.id)));
            }
            if e.prev_cseq != Some(st.cseq) {
                return Err(ApiMapError::new("tseq-gap", format!("expected prev_cseq {}, got {}", st.cseq, e.prev_cseq.unwrap_or(0))));
            }
            // an entry the pinned map already folds or clears is applied but not kept active
            let settled = st.store.get(org, "").is_some_and(|vm| cj::fold(std::slice::from_ref(&e), vm.wire.get("map").unwrap_or(&Value::Null)).is_ok_and(|r| r.is_empty()));
            notes.push((org.to_string(), json!({"action": "api.tighten", "resource": e.id, "op": e.action, "result": "ok"})));
            st.cseq = e.cseq;
            if !settled {
                st.console.push(e);
            }
            *changed = true;
        }
        Ok(())
    }

    /// The pseudonym key and client id keys of the answer, sealed when they changed. A malformed key is skipped (and
    /// logged); the held one stays.
    fn take_keys(&self, st: &mut St, ans: &Value) -> Result<(), String> {
        if let Some(p) = ans.get("pseudonym").filter(|p| !p.is_null()) {
            match pseudonym_of(p) {
                None => log_warn(&format!("connector_pseudonym_key_refused org={} (malformed)", self.org)),
                Some(p) if st.pseudonym.as_ref().is_some_and(|h| h.pkv > p.pkv) => {}
                Some(p) if st.pseudonym.as_ref().is_some_and(|h| h.pkv == p.pkv && h.key != p.key) => {
                    log_error(&format!("connector_pseudonym_key_conflict org={} pkv={}", self.org, p.pkv));
                }
                Some(p) if st.pseudonym.as_ref() == Some(&p) => {}
                Some(p) => {
                    if let Some(sealed) = &self.sealed {
                        sealed.put(names::AUDIT_PSEUDONYM_KEY, &json!({"pkv": p.pkv, "key": b64u(&p.key), "not_before": p.not_before}))?;
                    }
                    st.pseudonym = Some(p);
                }
            }
        }
        if let Some(list) = ans.get("client_keys").and_then(Value::as_array) {
            let mut keys = BTreeMap::new();
            for k in list {
                let client = k.get("client").and_then(Value::as_str).filter(|c| c.strip_prefix("c_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit())));
                let key = k.get("key").and_then(Value::as_str).and_then(unb64u).and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok());
                match (client, key) {
                    (Some(c), Some(key)) if k.get("kid").and_then(Value::as_str) == Some(client_kid(&key).as_str()) => {
                        keys.insert(c.to_string(), key);
                    }
                    _ => log_warn(&format!("connector_client_key_refused org={} client={}", self.org, client.unwrap_or("?"))),
                }
            }
            if keys != st.client_keys {
                if let Some(sealed) = &self.sealed {
                    sealed.put(names::CLIENT_ID_KEYS, &Value::Object(keys.iter().map(|(c, k)| (c.clone(), Value::from(b64u(k)))).collect()))?;
                }
                st.client_keys = keys;
            }
        }
        Ok(())
    }
}

/// `{pkv (1 to 2^32 - 1), key (base64url 32 bytes), not_before}`.
fn pseudonym_of(v: &Value) -> Option<Pseudonym> {
    let pkv = v.get("pkv").and_then(Value::as_u64).filter(|n| *n >= 1).and_then(|n| u32::try_from(n).ok())?;
    let key = v.get("key").and_then(Value::as_str).and_then(unb64u).filter(|k| k.len() == 32)?;
    Some(Pseudonym { pkv, key, not_before: v.get("not_before").and_then(Value::as_i64).unwrap_or(0) })
}

/// The relay's map check (1a 2.4) with what `OrgTrust` holds: the Meet CA root, its signer policy and CRL, the
/// pinned org policy, edition Enterprise.
pub fn trusted_accept(trust: &OrgTrust, now_s: i64) -> impl Fn(&mut ApiMapStore, &Value) -> Result<AcceptOutcome, ApiMapError> + '_ {
    move |store: &mut ApiMapStore, wire: &Value| -> Result<AcceptOutcome, ApiMapError> {
        let (root, sp, crl) = trust.map_trust().ok_or_else(|| ApiMapError::new("signature", "no signer policy signed by the Meet CA is held yet"))?;
        let policy = trust.own_policy();
        let t = ApiTrust { root: &root, signer_policy: &sp, root_crl: crl.as_ref(), previous_serial: "" };
        store.accept(wire, &t, now_s, policy.as_ref(), Some(Edition::Enterprise))
    }
}

// ── 2.8 freshness ───────────────────────────────────────────────────────────────────────────────────────────

/// The freshness watch's state: `connector.stale.on` once when the connector turns stale, `connector.stale.off`
/// after the next full sync.
#[derive(Debug, Default)]
pub struct StaleWatch {
    on: bool,
    /// The last full sync when it turned stale.
    last: i64,
}

impl StaleWatch {
    /// The audit entry to write now, if any. `age_s`: for `on` the seconds since the last full sync, for `off` the age
    /// the state had reached when the next full sync completed.
    pub fn step(&mut self, sync: &SyncState, now_ms: i64) -> Option<Value> {
        let last = sync.last_sync_ms();
        let fresh = sync.fresh(now_ms);
        if !self.on {
            if fresh || sync.connector().is_none() {
                return None;
            }
            self.on = true;
            self.last = last;
            let age = if last > 0 { (now_ms - last).max(0) / 1000 } else { 0 };
            return Some(json!({"action": "connector.stale.on", "resource": sync.connector_id(), "result": "ok", "age_s": age}));
        }
        if fresh && last > self.last {
            self.on = false;
            let age = if self.last > 0 { (last - self.last).max(0) / 1000 } else { 0 };
            return Some(json!({"action": "connector.stale.off", "resource": sync.connector_id(), "result": "ok", "age_s": age}));
        }
        None
    }
}

// ── the console link (2.8) ──────────────────────────────────────────────────────────────────────────────────

/// The front door's server verifier: only a leaf whose SubjectPublicKeyInfo hashes to `console_spki`, and only TLS
/// 1.3 signatures by that key with the fleet port's schemes.
#[derive(Debug)]
pub struct ConsolePin {
    spki_sha256: String,
}

impl ConsolePin {
    /// `spki_sha256`: 64 lowercase hex.
    pub fn new(spki_sha256: &str) -> ConsolePin {
        ConsolePin { spki_sha256: spki_sha256.to_ascii_lowercase() }
    }
}

impl ServerCertVerifier for ConsolePin {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], _name: &ServerName<'_>, _ocsp: &[u8], _now: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        if Cert::from_der(end_entity.as_ref()).is_some_and(|c| hex(&sha256(&c.spki)) == self.spki_sha256) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(rustls::CertificateError::ApplicationVerificationFailure))
        }
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        SCHEMES.to_vec()
    }
}

/// Blocking HTTPS to `I/v1/connector/<route>`: mTLS by the first API app with a usable certificate, the front door
/// pinned, and in an enclave the console's addresses checked before every connection.
pub struct ConsoleLink {
    host: String,
    port: u16,
    prefix: String,
    pin: Arc<ConsolePin>,
    enclave: Enclave,
    enroll: Enroll,
    apps: Vec<String>,
    tls: Mutex<Option<(Arc<ClientConfig>, Instant)>>,
}

impl ConsoleLink {
    pub fn new(cfg: &Config, sealed: Arc<SealedStore>) -> Result<ConsoleLink, String> {
        let (host, port) = crate::ai_gateway::host_port(&cfg.console).ok_or(crate::connector::CONSOLE_BAD)?;
        Ok(ConsoleLink {
            host,
            port,
            prefix: format!("/api/orgs/{}/v1/connector/", cfg.org),
            pin: Arc::new(ConsolePin::new(&cfg.console_spki)),
            enclave: cfg.enclave.clone(),
            enroll: Enroll::new(&cfg.state_dir, sealed),
            apps: cfg.apps.clone(),
            tls: Mutex::new(None),
        })
    }

    fn client(&self) -> Result<Arc<ClientConfig>, String> {
        if let Some((c, _)) = self.tls.lock().as_ref().filter(|(_, at)| at.elapsed() < TLS_REBUILD) {
            return Ok(c.clone());
        }
        let now = now_ms();
        let id = self.apps.iter().filter_map(|a| self.enroll.load(a).ok()).find(|id| !id.expired(now)).ok_or("no API app of this connector has a usable certificate for the console link")?;
        let (chain, key) = id.client_auth();
        let mut cfg = ClientConfig::builder_with_provider(Arc::new(fleet_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(self.pin.clone())
            .with_client_auth_cert(chain, key)
            .map_err(|e| format!("the app certificate and key do not fit: {e}"))?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        cfg.resumption = rustls::client::Resumption::disabled();
        let cfg = Arc::new(cfg);
        *self.tls.lock() = Some((cfg.clone(), Instant::now()));
        Ok(cfg)
    }

    /// One call: (status, JSON body; Null when the body is not JSON). Err when the console cannot be reached.
    pub fn call(&self, method: &str, route: &str, query: &str, body: Option<&Value>, timeout: f64) -> Result<(u16, Value), String> {
        self.enclave.check_host(&self.host, self.port)?;
        let cfg = self.client()?;
        let path = if query.is_empty() { format!("{}{route}", self.prefix) } else { format!("{}{route}?{query}", self.prefix) };
        let bytes = body.map(|b| stringify(b).into_bytes());
        let mut headers: Vec<(&str, String)> = vec![("Accept", "application/json".to_string())];
        if bytes.is_some() {
            headers.push(("Content-Type", "application/json".to_string()));
        }
        match crate::meet_tls::https_request(&cfg, &self.host, self.port, timeout, method, &path, &headers, bytes.as_deref(), &|_| Ok(())) {
            Ok(r) => Ok((r.status, serde_json::from_slice(&r.body).unwrap_or(Value::Null))),
            Err(Ok(why)) | Err(Err(why)) => {
                self.tls.lock().take();
                Err(format!("the console could not be reached ({why})"))
            }
        }
    }
}

/// A refusal body (`api_resource::problem`) in one line.
fn problem_text(status: u16, body: &Value) -> String {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("error");
    let detail = body.get("detail").or_else(|| body.get("error")).and_then(Value::as_str).unwrap_or_default();
    format!("{status} {code}: {detail}")
}

// ── the audit chains (12.1) ─────────────────────────────────────────────────────────────────────────────────

/// The connector's sealed store as the vault of its checkpoint keys (`api_checkpoint`, sealed as
/// `api-checkpoint-<org>-<gen>`).
pub struct SealedVault(pub Arc<SealedStore>);

impl Vault for SealedVault {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        self.0.get_bytes(name).ok().flatten()
    }
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
        self.0.put_bytes(name, value)
    }
    fn remove(&mut self, name: &str) -> Result<(), String> {
        self.0.delete(name)
    }
    fn usable(&self) -> bool {
        true
    }
}

impl VaultLock for SealedVault {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault)) {
        let mut v = SealedVault(self.0.clone());
        f(&mut v)
    }
}

/// A vault holding nothing: `audit-verify` reads only certificates.
struct NoVaultLock;

impl VaultLock for NoVaultLock {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault)) {
        f(&mut NoVault)
    }
}

/// The pseudonym key the console delivered in sync (pkv from the sync answer).
struct SyncPseudonym(Arc<SyncState>);

impl PseudonymKeys for SyncPseudonym {
    fn current(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        (org == self.0.org()).then(|| self.0.pseudonym()).flatten()
    }
}

/// The connector's audit chains (source = the connector id), checkpoint keys certified by the console, pseudonym key
/// from sync.
pub fn open_audit(state_dir: &Path, connector_id: &str, sealed: Arc<SealedStore>, sync: Arc<SyncState>, now_s: i64) -> Arc<ApiAudit> {
    let vault: Arc<dyn VaultLock> = Arc::new(SealedVault(sealed));
    let signer = Arc::new(RelayCheckpoints::new(state_dir, vault));
    let audit = ApiAudit::open(Some(state_dir), connector_id, signer, Arc::new(SyncPseudonym(sync)), now_s);
    for n in audit.take_notes() {
        log_warn(&n);
    }
    Arc::new(audit)
}

/// One checkpoint certificate round: a request for the waiting key, the console's certificate installed.
fn checkpoint_round(link: &ConsoleLink, dir: &Path, vault: &dyn VaultLock, org: &str) -> Result<(), String> {
    let csr = crate::api_checkpoint::relay_checkpoint_csr(dir, vault, org)?;
    let (status, body) = link.call("POST", "checkpoint-csr", "", Some(&json!({"org": org, "csr": b64u(&csr)})), CALL_TIMEOUT_S)?;
    if status != 200 {
        return Err(problem_text(status, &body));
    }
    let cert = body.get("cert").and_then(Value::as_str).and_then(unb64u).ok_or("the console's answer has no cert")?;
    let chain: Vec<Vec<u8>> = body.get("chain").and_then(Value::as_array).ok_or("the console's answer has no chain")?.iter().map(|c| c.as_str().and_then(unb64u)).collect::<Option<_>>().ok_or("the chain is not base64url DER")?;
    crate::api_checkpoint::install(dir, vault, org, &cert, &chain)
}

/// The console's answer to an audit batch as the fleet op's: `{ok: true, last}` and `gap` go to `api_ship_answer`,
/// anything else is a refusal.
fn ship_answer(r: Result<(u16, Value), String>) -> Result<Value, Refusal> {
    match r {
        Ok((_, b)) if b.get("ok") == Some(&Value::Bool(true)) || b.get("code").and_then(Value::as_str) == Some("gap") => Ok(b),
        Ok((status, b)) => Err(Refusal::new(status, b.get("code").and_then(Value::as_str).unwrap_or("error"), b.get("detail").or_else(|| b.get("error")).and_then(Value::as_str).unwrap_or_default())),
        Err(why) => Err(Refusal::new(503, "unreachable", &why)),
    }
}

// ── the threads ─────────────────────────────────────────────────────────────────────────────────────────────

fn thread(name: &str, f: impl FnOnce() + Send + 'static) -> Result<(), String> {
    std::thread::Builder::new().name(name.to_string()).spawn(f).map(|_| ()).map_err(|e| format!("cannot start {name}: {e}"))
}

/// One sync and ack round.
fn sync_once(conn: &Connector, sync: &SyncState, audit: &ApiAudit, link: &ConsoleLink, logger: &Logger) -> Result<(), String> {
    let (seq, tseq, cseq) = sync.heads();
    let (status, body) = link.call("GET", "sync", &format!("seq={seq}&tseq={tseq}&cseq={cseq}&wait={SYNC_WAIT_S}"), None, SYNC_TIMEOUT_S)?;
    if status != 200 {
        return Err(problem_text(status, &body));
    }
    let now = now_ms();
    let accept = trusted_accept(conn.trust(), now.div_euclid(1000));
    let (notes, done) = sync.apply(&body, &accept, now);
    fa::api_record(Some(audit), notes, logger, now.div_euclid(1000));
    done.map_err(|e| format!("{}: {}", e.code, e.message))?;
    let (seq, tseq, cseq) = sync.heads();
    let all = conn.conversations();
    let conversations: Vec<Value> = all.iter().take(ACK_CONVERSATIONS_MAX).map(|c| c.to_json()).collect();
    // r5 13.1: the connector serves no metrics route; its families travel in each ack
    let metrics = crate::api_catalog::counters::connector_metrics(sync.org(), all.len() as u64, conn.store().bytes());
    let ack = json!({
        "org": sync.org(), "seq": seq, "tseq": tseq, "cseq": cseq, "conversations": conversations,
        "metrics": metrics, "features": conn.features(), "seal": conn.key_store(),
    });
    let (status, body) = link.call("POST", "ack", "", Some(&ack), CALL_TIMEOUT_S)?;
    if status != 200 || body.get("ok") != Some(&Value::Bool(true)) {
        return Err(problem_text(status, &body));
    }
    Ok(())
}

/// The sync and ack loop: at once after a full round (the long poll paces it), 1 s doubling to 60 s after a failure.
fn sync_loop(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<ApiAudit>, link: Arc<ConsoleLink>) {
    let logger = Logger::new("connector");
    let mut backoff = BACKOFF_MIN;
    loop {
        match sync_once(&conn, &sync, &audit, &link, &logger) {
            Ok(()) => backoff = BACKOFF_MIN,
            Err(e) => {
                log_warn(&format!("connector_sync_failed org={} error={e}", sync.org()));
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
}

/// 12.1: ship the chains to `POST I/v1/connector/audit`, resending from `expected` on a gap.
fn ship_loop(dir: PathBuf, audit: Arc<ApiAudit>, link: Arc<ConsoleLink>) {
    let logger = Logger::new("connector");
    let mut skip: HashSet<(String, Repr)> = HashSet::new();
    let mut skip_since = Instant::now();
    loop {
        std::thread::sleep(SHIP_EVERY);
        if skip_since.elapsed() >= SHIP_SKIP_RESET {
            skip.clear();
            skip_since = Instant::now();
        }
        loop {
            let shipped = fa::api_shipped_load(&dir);
            let Some(batch) = fa::api_next_batch(&audit, &shipped, &skip) else { break };
            let answer = ship_answer(link.call("POST", "audit", "", Some(&batch.body), CALL_TIMEOUT_S));
            let own_head = audit.head(&batch.org, audit.source(), batch.repr).0;
            match fa::api_ship_answer(&dir, &batch, answer, own_head, &logger) {
                ShipStep::Acked | ShipStep::Resend => continue,
                ShipStep::Retry => break,
                ShipStep::Skip(code) => {
                    log_warn(&format!("connector_audit_ship_skipped org={} repr={} code={code}", batch.org, batch.repr.as_str()));
                    skip.insert((batch.org.clone(), batch.repr));
                }
                ShipStep::Off => {
                    std::thread::sleep(SHIP_SKIP_RESET);
                    break;
                }
            }
        }
    }
}

/// 12.1: the checkpoint certificate, requested when `renewal_due` (none yet, or under 30 days left).
fn checkpoint_loop(dir: PathBuf, org: String, vault: Arc<dyn VaultLock>, link: Arc<ConsoleLink>) {
    loop {
        if crate::api_checkpoint::renewal_due(&dir, &org, now_ms().div_euclid(1000)) {
            match checkpoint_round(&link, &dir, &*vault, &org) {
                Ok(()) => log_info(&format!("connector_checkpoint_certified org={org}")),
                Err(e) => log_warn(&format!("connector_checkpoint_not_certified org={org} error={e}")),
            }
        }
        std::thread::sleep(CHECKPOINT_EVERY);
    }
}

/// 7.6: each stop not yet acknowledged goes to `POST I/v1/connector/person-stop` until the console answers ok.
fn stop_loop(sync: Arc<SyncState>, link: Arc<ConsoleLink>) {
    let mut backoff = BACKOFF_MIN;
    loop {
        sync.wait_stop(WATCH_EVERY);
        let mut failed = false;
        for d in sync.pending_stops() {
            let body = json!({"org": sync.org(), "client": d.client, "principal": d.principal, "mid": d.mid});
            match link.call("POST", "person-stop", "", Some(&body), CALL_TIMEOUT_S) {
                Ok((200, b)) if b.get("ok") == Some(&Value::Bool(true)) => {
                    if let Err(e) = sync.stop_acked(&d.client, &d.principal) {
                        log_error(&format!("connector_deny_list_not_sealed error={e}"));
                    }
                    log_info(&format!("connector_person_stop_sent org={} client={}", sync.org(), d.client));
                }
                Ok((status, b)) => {
                    log_warn(&format!("connector_person_stop_refused client={} error={}", d.client, problem_text(status, &b)));
                    failed = true;
                }
                Err(e) => {
                    log_warn(&format!("connector_person_stop_failed client={} error={e}", d.client));
                    failed = true;
                }
            }
        }
        if failed {
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(BACKOFF_MAX);
        } else {
            backoff = BACKOFF_MIN;
        }
    }
}

/// 2.8: every 5 s, `connector.stale.on` / `.off` into the connector's chain.
fn watch_loop(sync: Arc<SyncState>, audit: Arc<ApiAudit>) {
    let mut w = StaleWatch::default();
    loop {
        std::thread::sleep(WATCH_EVERY);
        let now = now_ms();
        if let Some(entry) = w.step(&sync, now) {
            log_warn(&format!("{} org={} age_s={}", entry["action"].as_str().unwrap_or_default(), sync.org(), entry["age_s"]));
            if let Err(e) = audit.record(sync.org(), entry, now.div_euclid(1000)) {
                log_error(&format!("api.audit-failed org={} why={}", sync.org(), e.message));
            }
        }
    }
}

/// The console link's threads: sync and ack loop, audit shipping, checkpoint certificate, person-stop sender, and the
/// freshness watch (`connector.stale.on` / `.off`). Blocking work on its own threads.
pub fn spawn(conn: Arc<Connector>, sync: Arc<SyncState>, audit: Arc<ApiAudit>) -> Result<(), String> {
    let link = Arc::new(ConsoleLink::new(&conn.cfg, conn.shared.sealed.clone())?);
    let dir = conn.cfg.state_dir.clone();
    let vault: Arc<dyn VaultLock> = Arc::new(SealedVault(conn.shared.sealed.clone()));
    {
        let (c, s, a, l) = (conn.clone(), sync.clone(), audit.clone(), link.clone());
        thread("connector-sync", move || sync_loop(c, s, a, l))?;
    }
    {
        let (d, a, l) = (dir.clone(), audit.clone(), link.clone());
        thread("connector-audit-ship", move || ship_loop(d, a, l))?;
    }
    {
        let a = audit.clone();
        crate::api_resource::spawn_ticker("connector-audit-tick", Box::new(move || Some(a.clone())), Box::new(|n: &str| log_warn(n)))?;
    }
    {
        let (org, l) = (sync.org().to_string(), link.clone());
        thread("connector-checkpoint", move || checkpoint_loop(dir, org, vault, l))?;
    }
    {
        let (s, l) = (sync.clone(), link);
        thread("connector-person-stop", move || stop_loop(s, l))?;
    }
    thread("connector-stale-watch", move || watch_loop(sync, audit))
}

// ── `connector audit-verify` ────────────────────────────────────────────────────────────────────────────────

const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn hash_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sub_dirs(dir: &Path) -> Result<Vec<String>, String> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{} could not be read: {e}", dir.display())),
    };
    let mut out: Vec<String> = rd.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    out.sort();
    Ok(out)
}

/// A checkpoint entry of the connector's chain: its payload is canonical JSON naming the org, this connector, its ts
/// and the heads before it, and its signature verifies with a checkpoint certificate on record, in date at its ts.
fn checkpoint_problem(o: &Map<String, Value>, org: &str, id: &str, repr: Repr, seq: u64, prev: &str, certs: &[Value]) -> Option<String> {
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let (Some(kid), Some(pj), Some(sig)) = (s("kid"), s("payload").and_then(unb64u), s("sig").and_then(unb64u)) else {
        return Some(format!("checkpoint {seq} lacks its kid, payload or sig"));
    };
    let Some(p) = std::str::from_utf8(&pj).ok().and_then(parse_json) else { return Some(format!("checkpoint {seq}: its payload does not read")) };
    if crate::console_audit::canonical_json(&p).ok().as_deref() != Some(pj.as_slice()) {
        return Some(format!("checkpoint {seq}: its payload is not canonical JSON"));
    }
    let ts = o.get("ts").and_then(Value::as_i64);
    let heads = p.get("heads").and_then(Value::as_object);
    let head_ok = |r: Repr| heads.and_then(|h| h.get(r.as_str())).and_then(Value::as_array).is_some_and(|h| h.len() == 2 && h[0].as_u64() == Some(seq - 1) && h[1].as_str().is_some_and(hash_hex));
    let named = p.get("org").and_then(Value::as_str) == Some(org)
        && p.get("source").and_then(Value::as_str) == Some(id)
        && p.get("ts").and_then(Value::as_i64) == ts
        && heads.is_some_and(|h| h.len() == 3)
        && Repr::ALL.iter().all(|r| head_ok(*r))
        && heads.and_then(|h| h.get(repr.as_str())).and_then(|h| h.get(1)).and_then(Value::as_str) == Some(prev);
    if !named {
        return Some(format!("checkpoint {seq} does not name this connector and the heads before it"));
    }
    let Some(cert) = certs.iter().filter(|c| c.get("kid").and_then(Value::as_str) == Some(kid)).find_map(crate::api_checkpoint::cert_der_of) else {
        return Some(format!("checkpoint {seq}: no certificate is on record for {kid}"));
    };
    let in_date = Cert::from_der(&cert).zip(ts).is_some_and(|(c, t)| c.not_before <= t && t <= c.not_after);
    if !in_date || !crate::api_checkpoint::verify(&cert, &checkpoint_signed_bytes(&pj), &sig) {
        return Some(format!("checkpoint {seq}: its signature does not verify with the certificate of {kid}"));
    }
    None
}

/// One chain read from its files (never changed): (first kept seq, head seq, checkpoints, the first problem).
fn verify_chain(dir: &Path, org: &str, id: &str, repr: Repr, certs: &[Value]) -> (u64, u64, u64, Option<String>) {
    let label = repr.label(org);
    let head = std::fs::read_to_string(dir.join(format!("{}-head.json", repr.as_str()))).ok().and_then(|t| parse_json(&t));
    let dropped = head.as_ref().and_then(|h| Some((h.pointer("/dropped/seq")?.as_u64()?, h.pointer("/dropped/hash")?.as_str()?.to_string())));
    let had_head = dropped.is_some();
    let (mut seq, mut prev) = dropped.unwrap_or((0, ZERO_HASH.to_string()));
    let mut first = seq + 1;
    let mut checkpoints = 0;
    let prefix = format!("{}-", repr.as_str());
    let mut segs: Vec<(u32, PathBuf)> = std::fs::read_dir(dir)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let mid = name.strip_prefix(&prefix)?.strip_suffix(".jsonl")?.to_string();
                    (mid.len() == 6 && mid.bytes().all(|b| b.is_ascii_digit())).then(|| mid.parse().ok().map(|n| (n, e.path()))).flatten()
                })
                .collect()
        })
        .unwrap_or_default();
    segs.sort();
    for (_, path) in segs {
        let Ok(bytes) = std::fs::read(&path) else { return (first, seq, checkpoints, Some(format!("{} could not be read", path.display()))) };
        let mut lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').collect();
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        for line in lines {
            let Some(o) = std::str::from_utf8(line).ok().and_then(parse_json).and_then(|v| v.as_object().cloned()) else {
                return (first, seq, checkpoints, Some(format!("entry {} does not read", seq + 1)));
            };
            // a front dropped with no head to record it: the first entry says where the kept chain starts
            if seq == 0 && !had_head {
                if let (Some(n), Some(p)) = (o.get("seq").and_then(Value::as_u64).filter(|n| *n > 1), o.get("prev").and_then(Value::as_str)) {
                    seq = n - 1;
                    prev = p.to_string();
                    first = n;
                }
            }
            let next = seq + 1;
            let linked = o.get("seq").and_then(Value::as_u64) == Some(next) && o.get("prev").and_then(Value::as_str) == Some(prev.as_str()) && o.get("org").and_then(Value::as_str) == Some(org);
            let hash = o.get("hash").and_then(Value::as_str).filter(|h| linked && chain_hash(&label, &prev, &o).as_deref() == Some(*h));
            let Some(hash) = hash.map(str::to_string) else { return (first, seq, checkpoints, Some(format!("entry {next} does not verify"))) };
            if o.get("source").and_then(Value::as_str) != Some("connector") || o.get("connector").and_then(Value::as_str) != Some(id) {
                return (first, seq, checkpoints, Some(format!("entry {next} does not name connector {id}")));
            }
            if o.get("action").and_then(Value::as_str) == Some("checkpoint") {
                if let Some(why) = checkpoint_problem(&o, org, id, repr, next, &prev, certs) {
                    return (first, seq, checkpoints, Some(why));
                }
                checkpoints += 1;
            }
            seq = next;
            prev = hash;
        }
    }
    (first, seq, checkpoints, None)
}

/// `connector audit-verify`: the connector's chains read from `state_dir` without changing them, per org and
/// representation the head seq, whether every link and every checkpoint verifies, and the first problem found.
pub fn verify_chains(state_dir: &Path, connector_id: &str) -> Result<Value, String> {
    if !crate::connector::connector_id_ok(connector_id) {
        return Err(crate::connector::CONNECTOR_ID_BAD.to_string());
    }
    let root = state_dir.join(AUDIT_DIR);
    let checkpoints = RelayCheckpoints::new(state_dir, Arc::new(NoVaultLock));
    let mut all_ok = true;
    let mut orgs = Vec::new();
    for org in sub_dirs(&root)?.into_iter().filter(|o| org_ok(o) && root.join(o).join(connector_id).is_dir()) {
        let certs = crate::api_audit::CheckpointSigner::certs(&checkpoints, &org);
        let dir = root.join(&org).join(connector_id);
        let chains: Vec<Value> = Repr::ALL
            .iter()
            .map(|r| {
                let (first, head, cps, problem) = verify_chain(&dir, &org, connector_id, *r, &certs);
                all_ok &= problem.is_none();
                let mut c = json!({"repr": r.as_str(), "first_seq": first, "head_seq": head, "checkpoints": cps, "ok": problem.is_none()});
                if let Some(p) = problem {
                    c["problem"] = json!(p);
                }
                c
            })
            .collect();
        orgs.push(json!({"org": org, "chains": chains}));
    }
    Ok(json!({"connector": connector_id, "ok": all_ok, "orgs": orgs}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_map::{api_map_hash, VerifiedApiMap};
    use crate::connector_seal::{FixedSource, Sealer, KEY_LEN, SEALED_DIR};

    const T: i64 = 1_795_000_000;
    const T_MS: i64 = T * 1000;
    const DAY: i64 = 86_400;
    const K: &str = "k_7a1b2c3d4e5f6a7b";
    const C1: &str = "c_0b1c2d3e4f5a6b7c";
    const C2: &str = "c_00000000000000ff";
    const APP: &str = "helpdesk-api@apps.acme.example";
    const ANN: &str = "ann@acme.example";

    fn map(org: &str, seq: i64, folded: &[&str], apps: &[&str]) -> Value {
        json!({"v": 2, "org": org, "seq": seq, "issued": T - 100, "expires": T + 30 * DAY, "folded": folded, "cleared": [],
               "connectors": [{"id": K, "name": "helpdesk", "origin": "https://connector.acme.example:9445", "apps": [APP],
                               "networks": [], "stale_s": 60, "state": "active"}],
               "clients": [{"id": C1, "name": "claude-ops", "principal": "claude-ops@apps.acme.example", "kind": "agent_delegated",
                            "connectors": [K], "apps": apps, "channels": ["*"], "confirm": [],
                            "delegation": {"groups": [], "principals": [], "idps": [], "denied": []}, "state": "active"}]})
    }

    fn wire(m: Value) -> Value {
        json!({"map": m, "sig": "", "chain": []})
    }

    /// A pin without the signature check (the map's own checks are `api_map`'s tests).
    fn pin_unchecked(store: &mut ApiMapStore, wire: &Value) -> Result<AcceptOutcome, ApiMapError> {
        let m = &wire["map"];
        store.pin(VerifiedApiMap {
            wire: wire.as_object().unwrap().clone(),
            org: m["org"].as_str().unwrap().to_string(),
            seq: m["seq"].as_i64().unwrap(),
            expires: m["expires"].as_i64().unwrap(),
            hash: api_map_hash(m),
            signer: "root".into(),
        })
    }

    fn ce(org: &str, cseq: u64, prev: u64, action: &str, target: Value) -> Value {
        json!({"id": format!("k_{org}_{cseq:06}"), "cseq": cseq, "ts": T - 50, "action": action, "target": target, "reach": "connector", "prev_cseq": prev})
    }

    fn sealed(dir: &Path) -> Arc<SealedStore> {
        Arc::new(SealedStore::open(Sealer::from_source(&FixedSource([7; KEY_LEN])).unwrap(), dir.join(SEALED_DIR)).unwrap())
    }

    fn store_with(org: &str) -> ApiMapStore {
        let mut s = ApiMapStore::load(None);
        pin_unchecked(&mut s, &wire(map(org, 1, &[], &[APP]))).unwrap();
        s
    }

    fn ids(s: &SyncState) -> Vec<String> {
        s.console_active().into_iter().map(|e| e.id).collect()
    }

    #[test]
    fn a_sync_answer_applies_in_order_and_persists() {
        let org = "sync-order";
        let dir = crate::meet_tls::testpki::dir("sync-order");
        let s = SyncState::open(org, K, &dir, sealed(&dir)).unwrap();
        assert_eq!((s.heads(), s.last_sync_ms()), ((0, 0, 0), 0));
        let ans = json!({
            "org": org, "map": wire(map(org, 3, &[], &[APP])), "base": 5,
            "journal": [{"id": format!("t_{org}_000006"), "tseq": 6, "ts": T - 10, "action": "client_suspend", "target": C2}],
            "console_journal": [ce(org, 2, 0, "client_confirm", json!({"client": C1, "scope": "content.post"})),
                                ce(org, 4, 2, "person_revoke", json!({"client": C1, "principal": ANN}))],
            "pseudonym": {"pkv": 2, "key": b64u(&[9u8; 32]), "not_before": T},
            "client_keys": [{"client": C1, "kid": client_kid(&[5u8; 32]), "key": b64u(&[5u8; 32])}],
            "connector": {"id": K, "suspended": false}, "now": T, "wait_s": 30,
        });
        let (notes, done) = s.apply(&ans, &pin_unchecked, T_MS);
        done.unwrap();
        let actions: Vec<&str> = notes.iter().map(|(_, e)| e["action"].as_str().unwrap()).collect();
        assert_eq!(actions, ["api.map.pinned", "api.journal.rebased", "api.tighten", "api.tighten", "api.tighten"]);
        let check = |s: &SyncState| {
            assert_eq!(s.heads(), (3, 6, 4));
            assert_eq!(ids(s), [format!("k_{org}_000002"), format!("k_{org}_000004")]);
            assert_eq!(s.client_key(C1), Some([5u8; 32]));
            assert_eq!(s.client_key(C2), None);
            assert_eq!(s.pseudonym(), Some((2, vec![9u8; 32])));
            assert_eq!(s.last_sync_ms(), T_MS);
            assert_eq!(s.connector().and_then(|c| c["stale_s"].as_i64()), Some(60));
        };
        check(&s);
        drop(s);
        check(&SyncState::open(org, K, &dir, sealed(&dir)).unwrap());
        // the key files are sealed, never clear
        let raw = std::fs::read(dir.join(SEALED_DIR).join(format!("{}.bin", names::CLIENT_ID_KEYS))).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(&b64u(&[5u8; 32])));
    }

    #[test]
    fn a_skipped_prev_cseq_is_a_tseq_gap_and_stops_there() {
        let org = "sync-gap";
        let s = SyncState::for_test(org, K, ApiMapStore::load(None), Vec::new(), BTreeMap::new(), 0);
        let ans = json!({"org": org, "console_journal": [
            ce(org, 1, 0, "client_confirm", json!({"client": C1, "scope": "content.post"})),
            ce(org, 3, 2, "person_revoke", json!({"client": C1, "principal": ANN})),
            ce(org, 4, 3, "client_confirm", json!({"client": C1, "scope": "content.read"})),
        ]});
        let (_, done) = s.apply(&ans, &pin_unchecked, T_MS);
        assert_eq!(done.unwrap_err().code, "tseq-gap");
        assert_eq!(s.heads().2, 1);
        assert_eq!(ids(&s), [format!("k_{org}_000001")]);
        assert_eq!(s.last_sync_ms(), 0, "no full sync");
        assert!(!cj::person_revoked(&s.console_active(), C1, ANN));
    }

    #[test]
    fn a_map_folding_a_4b_entry_it_does_not_hold_is_refused() {
        let org = "sync-fold";
        let s = SyncState::for_test(org, K, ApiMapStore::load(None), Vec::new(), BTreeMap::new(), 0);
        let first = json!({"org": org, "map": wire(map(org, 1, &[], &[APP])), "console_journal": [ce(org, 1, 0, "client_drop_app", json!({"client": C1, "app": APP}))]});
        s.apply(&first, &pin_unchecked, T_MS).1.unwrap();
        let id = format!("k_{org}_000001");
        assert_eq!(ids(&s), [id.clone()]);
        // folds the entry but still lists the app
        let bad = json!({"org": org, "map": wire(map(org, 2, &[id.as_str()], &[APP]))});
        assert_eq!(s.apply(&bad, &pin_unchecked, T_MS + 1000).1.unwrap_err().code, "fold-mismatch");
        assert_eq!((s.heads().0, ids(&s)), (1, vec![id.clone()]));
        assert_eq!(s.last_sync_ms(), T_MS);
        // holds it: pinned, and the entry leaves the active set
        let good = json!({"org": org, "map": wire(map(org, 2, &[id.as_str()], &[]))});
        s.apply(&good, &pin_unchecked, T_MS + 2000).1.unwrap();
        assert_eq!((s.heads().0, ids(&s).len()), (2, 0));
    }

    #[test]
    fn fresh_within_stale_s_and_stale_past_it() {
        let s = SyncState::for_test("sync-fresh", K, store_with("sync-fresh"), Vec::new(), BTreeMap::new(), T_MS);
        assert!(s.fresh(T_MS + 60_000));
        assert!(!s.fresh(T_MS + 60_001));
        // no map, or a map without this connector, or never synced: not fresh
        assert!(!SyncState::for_test("sync-fresh", K, ApiMapStore::load(None), Vec::new(), BTreeMap::new(), T_MS).fresh(T_MS));
        assert!(!SyncState::for_test("sync-fresh", "k_0000000000000001", store_with("sync-fresh"), Vec::new(), BTreeMap::new(), T_MS).fresh(T_MS));
        assert!(!SyncState::for_test("sync-fresh", K, store_with("sync-fresh"), Vec::new(), BTreeMap::new(), 0).fresh(T_MS));
    }

    #[test]
    fn the_stale_watch_writes_on_then_off_after_the_next_sync() {
        let org = "sync-watch";
        let s = SyncState::for_test(org, K, store_with(org), Vec::new(), BTreeMap::new(), T_MS);
        let mut w = StaleWatch::default();
        assert_eq!(w.step(&s, T_MS + 1000), None);
        let on = w.step(&s, T_MS + 61_000).unwrap();
        assert_eq!((on["action"].as_str(), on["age_s"].as_i64(), on["resource"].as_str()), (Some("connector.stale.on"), Some(61), Some(K)));
        assert_eq!(w.step(&s, T_MS + 66_000), None, "written once");
        s.apply(&json!({"org": org}), &pin_unchecked, T_MS + 70_000).1.unwrap();
        let off = w.step(&s, T_MS + 71_000).unwrap();
        assert_eq!((off["action"].as_str(), off["age_s"].as_i64()), (Some("connector.stale.off"), Some(70)));
        assert_eq!(w.step(&s, T_MS + 72_000), None);
    }

    #[test]
    fn an_applied_person_revoke_is_published() {
        let org = "sync-revoke";
        let s = SyncState::for_test(org, K, ApiMapStore::load(None), Vec::new(), BTreeMap::new(), 0);
        assert!(!crate::api_delegated::person_revoked_now(org, C1, ANN));
        s.apply(&json!({"org": org, "console_journal": [ce(org, 1, 0, "person_revoke", json!({"client": C1, "principal": ANN}))]}), &pin_unchecked, T_MS).1.unwrap();
        assert!(crate::api_delegated::person_revoked_now(org, C1, ANN));
        assert!(!crate::api_delegated::person_revoked_now(org, C2, ANN));
    }

    #[test]
    fn a_local_deny_holds_until_the_covering_entry_applies() {
        let org = "sync-deny";
        let dir = crate::meet_tls::testpki::dir("sync-deny");
        let s = SyncState::open(org, K, &dir, sealed(&dir)).unwrap();
        s.person_stopped(C1, ANN, "m_1").unwrap();
        assert!(s.locally_denied(C1, ANN));
        assert!(!s.locally_denied(C2, ANN));
        assert_eq!(s.pending_stops().len(), 1);
        s.stop_acked(C1, ANN).unwrap();
        assert!(s.pending_stops().is_empty());
        drop(s);
        let s = SyncState::open(org, K, &dir, sealed(&dir)).unwrap();
        assert!(s.locally_denied(C1, ANN), "the sealed deny survives a restart");
        // a sync without the covering entry keeps it
        s.apply(&json!({"org": org}), &pin_unchecked, T_MS).1.unwrap();
        assert!(s.locally_denied(C1, ANN));
        s.apply(&json!({"org": org, "console_journal": [ce(org, 1, 0, "person_revoke", json!({"client": C1, "principal": ANN}))]}), &pin_unchecked, T_MS + 1000).1.unwrap();
        assert!(!s.locally_denied(C1, ANN));
        drop(s);
        assert!(!SyncState::open(org, K, &dir, sealed(&dir)).unwrap().locally_denied(C1, ANN));
    }

    #[test]
    fn the_console_pin_refuses_another_key() {
        use crate::meet_tls::testpki::{Ca, Key};
        let ca = Ca::new("Lucid Meet CA");
        let console = ca.leaf(&[0x21], "console.acme.test", None, &[], &Key::new(), false);
        let other = ca.leaf(&[0x22], "console.acme.test", None, &[], &Key::new(), false);
        let pin = ConsolePin::new(&hex(&sha256(&Cert::from_der(&console).unwrap().spki)));
        let name = ServerName::try_from("console.acme.test").unwrap();
        let verify = |der: &[u8]| pin.verify_server_cert(&CertificateDer::from(der.to_vec()), &[], &name, &[], UnixTime::now());
        assert!(verify(&console).is_ok());
        assert!(verify(&other).is_err());
        assert!(verify(&b"not a certificate"[..]).is_err());
        assert_eq!(pin.supported_verify_schemes(), SCHEMES.to_vec());
    }

    #[test]
    fn for_test_gives_other_lanes_a_synced_state() {
        let org = "sync-test";
        let e = ConsoleEntry::parse(&ce(org, 3, 0, "connector_suspend", json!(K))).unwrap();
        let s = SyncState::for_test(org, K, store_with(org), vec![e], BTreeMap::from([(C1.to_string(), [4u8; 32])]), T_MS);
        assert_eq!((s.org(), s.connector_id()), (org, K));
        assert_eq!(s.heads(), (1, 0, 3));
        assert!(cj::connector_suspended(&s.console_active(), K));
        assert_eq!(s.client_key(C1), Some([4u8; 32]));
        assert!(s.fresh(T_MS));
        assert_eq!(s.store().head(org), (1, 0));
        assert!(!s.locally_denied(C1, ANN));
    }

    #[test]
    fn the_sealed_vault_keeps_checkpoint_keys_sealed() {
        let dir = crate::meet_tls::testpki::dir("sync-vault");
        let sealed = sealed(&dir);
        let csr = crate::api_checkpoint::relay_checkpoint_csr(&dir, &SealedVault(sealed.clone()), "acme").unwrap();
        assert!(!csr.is_empty());
        assert!(sealed.has(&crate::api_checkpoint::seal_name("acme", 1)));
        assert!(crate::api_checkpoint::renewal_due(&dir, "acme", T));
    }

    #[test]
    fn verify_chains_reports_links_and_a_broken_one() {
        let dir = crate::meet_tls::testpki::dir("sync-verify");
        assert_eq!(verify_chains(&dir, K).unwrap(), json!({"connector": K, "ok": true, "orgs": []}));
        assert!(verify_chains(&dir, "relay-1").is_err());
        let chain = dir.join(AUDIT_DIR).join("acme").join(K);
        std::fs::create_dir_all(&chain).unwrap();
        let label = Repr::AsIs.label("acme");
        let mut prev = ZERO_HASH.to_string();
        let mut text = String::new();
        for seq in 1..=2u64 {
            let mut e = json!({"seq": seq, "ts": T, "org": "acme", "source": "connector", "connector": K, "action": "connector.stale.on", "age_s": 61, "prev": prev}).as_object().unwrap().clone();
            let h = chain_hash(&label, &prev, &e).unwrap();
            e.insert("hash".into(), json!(h));
            text.push_str(&format!("{}\n", stringify(&Value::Object(e))));
            prev = h;
        }
        let seg = chain.join("as_is-000001.jsonl");
        std::fs::write(&seg, &text).unwrap();
        let v = verify_chains(&dir, K).unwrap();
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(v["orgs"][0]["chains"][0]["head_seq"], json!(2));
        std::fs::write(&seg, text.replace("\"age_s\":61", "\"age_s\":62")).unwrap();
        let v = verify_chains(&dir, K).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["orgs"][0]["chains"][0]["head_seq"], json!(0));
        assert_eq!(v["orgs"][0]["chains"][0]["problem"], json!("entry 1 does not verify"));
        assert_eq!(std::fs::read_to_string(&seg).unwrap(), text.replace("\"age_s\":61", "\"age_s\":62"), "read only");
    }
}
