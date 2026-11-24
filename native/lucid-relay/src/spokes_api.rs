// API-1d (docs/api/contract-r6-1d.md) on a Remote Spokes relay: the API state of the orgs it is bound to (5.1, the
// bound list in `api-orgs.json`), their pinned maps and journals (`api_map::ApiMapStore` under the state folder), the
// relay's own audit and event chains, the fleet ops of 2.4 (`ApiHooks`: `api-heads`, `api-orgs`, `api-map`,
// `api-tighten`, `api-spokes`, `api-synced`), the 5.3 checks of every service hub request (`SpokesApi::check`, called
// by `relay::State::serve`), the `spokes.mail` audit entry (11), the `spoke.offline` and `spoke.online` events (6.4),
// the 6.2 views (`SpokesApi::view`, for `api-spokes` and the listener's `RR/v1/spokes/*`), and the start of all this
// (`start`, from `server::fleet_start`).
//
// Lock order: the relay State's lock may be held while this file's locks are taken (5.3 runs inside `serve`); this
// file never takes the State's lock while it holds one of its own.

use crate::api_audit::ApiAudit;
use crate::api_events::EventLog;
use crate::api_map::{ApiMapError, ApiMapStore, Edition, VerifiedApiMap};
use crate::api_token::{client_entries, find_client, names, rank, rate_of, relay_reachable, source_allowed, target_field};
use crate::fleet_agent::{api_map_pinned, api_record, api_refusal, api_tighten_answer};
use crate::fleet_ca::VaultLock;
use crate::fleet_wire::Refusal;
use crate::license::Product;
use crate::log::{Fields, Level, Logger};
use crate::relay::State;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

/// API-1d 2.4: the bound orgs of a spokes relay, in its state folder.
pub const ORGS_FILE: &str = "api-orgs.json";
/// API-1d 5.3 rule 1: the answer to a service hub no pinned map of a bound org registers.
pub const NOT_REGISTERED: &str = "this service hub is not registered for the API on this relay";
/// API-1d 5.3: the answer when the decision cannot be appended to the org's chain.
pub const AUDIT_UNAVAILABLE: &str = "audit unavailable";
/// API-1d 5.3 rule 1: the security line of a service hub refused while no org is bound.
pub const UNREGISTERED_EVENT: &str = "spokes.service-unregistered";
/// The security line of every other 5.3 refusal.
pub const REFUSED_EVENT: &str = "spokes.service-refused";
/// API-1d 2.4: at most this many bound orgs (`api_map::API_MAP_ORGS_MAX`).
const ORGS_MAX: usize = crate::api_map::API_MAP_ORGS_MAX;
/// API-1d 2.4 `api-spokes`: the views and the longest query.
const VIEWS: [&str; 4] = ["nodes", "counts", "seats", "relays"];
const QUERY_MAX: usize = 512;
/// API-1d 5.3 rule 7: the only routes a service hub may use.
const SERVICE_ROUTES: [(&str, &str); 8] = [
    ("POST", "/v1/send"),
    ("GET", "/v1/inbox"),
    ("POST", "/v1/ack"),
    ("GET", "/v1/presence"),
    ("GET", "/v1/directory"),
    ("GET", "/v1/crl"),
    ("GET", "/v1/license"),
    ("POST", crate::relay::REGISTER_PATH),
];
/// The folders `ApiMapStore` keeps an org's pinned maps and journal in (`<dir>/api-maps/<org>.json`,
/// `<dir>/api-journal/<org>.json`).
const STORE_DIRS: [&str; 2] = ["api-maps", "api-journal"];
/// API-1d 6.4: how often the spokes are looked at for `spoke.offline`.
const SILENT_TICK: std::time::Duration = std::time::Duration::from_secs(60);

fn now_s() -> i64 {
    crate::codec::now_ms().div_euclid(1000)
}

/// API-1d 1 (shared contract item 6): the task class of a spoke from its certificate's `classification`:
/// `shareable` is `internal`, `private` or absent is `confidential`, `cui` is `cui`; any other value is taken as `cui`
/// (fail closed).
pub fn task_class(classification: Option<&str>) -> &'static str {
    match classification {
        Some("shareable") => "internal",
        Some("private") | None => "confidential",
        _ => "cui",
    }
}

/// API-1d 5.3, 5.7: a refusal of a service hub request: the status, the audit `check` code, the sentence the hub
/// reads (`{ok: false, error}`) and the security line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub status: u16,
    pub code: &'static str,
    pub error: &'static str,
    pub event: &'static str,
}

/// The status and sentence of each 5.7 code.
fn refused(code: &'static str) -> Refused {
    let (status, error) = match code {
        "not-registered" => (403, NOT_REGISTERED),
        "map-expired" => (403, "the organization's api map has expired"),
        "map-edition" => (403, "the organization's api map exceeds what the license edition allows"),
        "journal-unknown" => (403, "this relay waits for the console to sync the organization's api state"),
        "api-off" => (403, "the API is off for this organization"),
        "license" => (403, "this relay's license edition does not serve service hubs"),
        "suspended" => (403, "this service hub's client is suspended"),
        "expired" => (403, "this service hub's client registration has expired"),
        "owner" => (403, "this service hub's client owner is not active"),
        "client-auth" => (403, "this service hub's credential was removed"),
        "not-found" => (404, "not found"),
        "network" => (403, "this service hub may not connect from this address"),
        "hours" => (403, "this service hub may not connect at this time"),
        "rate" => (429, "rate limited"),
        "route" => (403, "a service hub may not use this route"),
        "target" => (403, "this service hub may not send to that node"),
        "ceiling" => (403, "that node's work is above this service hub's ceiling"),
        _ => (503, AUDIT_UNAVAILABLE),
    };
    let code = if status == 503 { "audit-unavailable" } else { code };
    Refused { status, code, error, event: REFUSED_EVENT }
}

/// API-1d 5.3: one service hub request as the relay saw it after `authenticate` and the block check.
pub struct ServiceReq<'a> {
    /// The sender's node id, certificate serial and the SHA-256 hex of its certificate's SPKI.
    pub node: &'a str,
    pub serial: &'a str,
    pub spki_sha256: &'a str,
    pub method: &'a str,
    /// The path without its query.
    pub path: &'a str,
    pub source: Option<IpAddr>,
    /// `POST /v1/send`: the envelope's `to` (None when it does not read).
    pub to: Option<&'a str>,
    /// `POST /v1/send`: the recipient as this relay last verified it (rule 9): None when never seen here, else its
    /// certificate's `classification`.
    pub to_seen: Option<Option<&'a str>>,
    /// The relay's own license edition (rule 2).
    pub edition: Option<&'a str>,
}

/// API-1d 5.3: a service hub request every rule allowed: the org and client it belongs to, and what the relay needs
/// for the rest (its `spokes.mail` entry, rule 10).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowed {
    pub org: String,
    pub client: String,
    /// `<METHOD> <path>`.
    pub route: String,
    pub ip: Option<String>,
    /// The client's `spokes.targets` (`*` for all) and the spokes journaled `client_drop_target`.
    targets: Vec<String>,
    dropped: Vec<String>,
}

impl Allowed {
    /// API-1d 5.3 rules 8 and 10: the client may reach `node`.
    pub fn reaches(&self, node: &str) -> bool {
        !self.dropped.iter().any(|d| d == node) && self.targets.iter().any(|t| t == "*" || t == node)
    }
}

/// API-1d 6.4: a spoke silent for 24 hours (no poll), as the relay sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpokeSeen {
    pub node: String,
    pub label: String,
    /// Its last poll (ms), or when it was last seen when it has not polled since the relay started.
    pub last_poll_at: i64,
}

/// API-1d 2.4 (shared contract item 4): `api-orgs.json` = `{"orgs": [...], "generation": n, "retired": {org: {seq,
/// tseq}}, "roots": {org: <SHA-256 hex of the Meet org CA root's SPKI>}}`. `generation` is the newest binding
/// generation `api-orgs` applied (0 before the first); a root stays pinned across an unbinding until an `api-orgs` of a
/// newer generation releases it (`release_roots`).
#[derive(Clone, Debug, Default, PartialEq)]
struct Bound {
    orgs: Vec<String>,
    generation: u64,
    retired: BTreeMap<String, (i64, u64)>,
    roots: BTreeMap<String, String>,
}

impl Bound {
    /// The file, or nothing bound when it is absent; a file that does not read binds nothing (fail closed) and is
    /// reported.
    fn load(path: &Path, logger: &Logger) -> Bound {
        let Ok(text) = std::fs::read_to_string(path) else { return Bound::default() };
        let Some(v) = crate::codec::parse_json(&text) else {
            logger.security("api.orgs.unreadable", &Fields::new().with("file", path.display().to_string()), Level::Error);
            return Bound::default();
        };
        let orgs = v.get("orgs").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|o| crate::api_audit::org_ok(o)).map(str::to_owned).collect();
        let retired = v
            .get("retired")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(o, m)| Some((o.clone(), (m.get("seq")?.as_i64()?, m.get("tseq")?.as_u64()?))))
            .collect();
        let roots = v.get("roots").and_then(Value::as_object).into_iter().flatten().filter_map(|(o, h)| Some((o.clone(), h.as_str()?.to_owned()))).collect();
        let generation = v.get("generation").and_then(Value::as_u64).unwrap_or(0);
        Bound { orgs, generation, retired, roots }
    }

    fn to_value(&self) -> Value {
        let retired: Map<String, Value> = self.retired.iter().map(|(o, (s, t))| (o.clone(), json!({ "seq": s, "tseq": t }))).collect();
        json!({ "orgs": self.orgs, "generation": self.generation, "retired": retired, "roots": self.roots })
    }

    fn has(&self, org: &str) -> bool {
        self.orgs.iter().any(|o| o == org)
    }
}

struct Inner {
    store: ApiMapStore,
    bound: Bound,
}

/// API-1d 2.4, 5, 6: the API side of a Remote Spokes relay (one per state folder).
pub struct SpokesApi {
    dir: PathBuf,
    /// The relay's own root (`--root`): its node id and the SHA-256 hex of its SPKI (5.1 `root-mismatch`).
    root_id: String,
    root_spki: String,
    logger: Arc<Logger>,
    /// Where the relay seals secrets (the console book of the fleet link), once it has one.
    vault: OnceLock<Arc<dyn VaultLock>>,
    state: OnceLock<Weak<Mutex<State>>>,
    inner: Mutex<Inner>,
    /// The relay's fleet id, read from `fleet.json` once it has one.
    relay_id: Mutex<Option<String>>,
    /// API-1 9.1, revision 4 7.3: the relay's own chains, opened once it has a relay id and a vault.
    audit: Mutex<Option<Arc<ApiAudit>>>,
    events: Mutex<Option<Arc<EventLog>>>,
    /// API-1d 5.3 rule 6: per client per relay, the minute and day windows.
    minute: Mutex<HashMap<String, VecDeque<i64>>>,
    daily: Mutex<HashMap<String, VecDeque<(i64, u64)>>>,
    /// API-1d 6.4: the spokes whose `spoke.offline` was emitted and whose `spoke.online` was not yet.
    silent: Mutex<HashSet<String>>,
}

impl SpokesApi {
    /// The API state under the state folder `dir` for a relay of the root `root_id` (SPKI hash `root_spki`).
    pub fn new(dir: &Path, root_id: &str, root_spki: &str, logger: Arc<Logger>) -> SpokesApi {
        let bound = Bound::load(&dir.join(ORGS_FILE), &logger);
        SpokesApi {
            dir: dir.to_path_buf(),
            root_id: root_id.to_owned(),
            root_spki: root_spki.to_owned(),
            logger,
            vault: OnceLock::new(),
            state: OnceLock::new(),
            inner: Mutex::new(Inner { store: ApiMapStore::load(Some(dir)), bound }),
            relay_id: Mutex::new(None),
            audit: Mutex::new(None),
            events: Mutex::new(None),
            minute: Mutex::new(HashMap::new()),
            daily: Mutex::new(HashMap::new()),
            silent: Mutex::new(HashSet::new()),
        }
    }

    /// The relay State the views and the license edition are read from (held weakly).
    pub fn set_state(&self, state: &Arc<Mutex<State>>) {
        let _ = self.state.set(Arc::downgrade(state));
    }

    fn state(&self) -> Option<Arc<Mutex<State>>> {
        self.state.get()?.upgrade()
    }

    /// Where the relay seals secrets: the console book of the fleet link (server.rs, once `fleet_open` gave it).
    pub fn set_vault(&self, vault: Arc<dyn VaultLock>) {
        let _ = self.vault.set(vault);
    }

    fn vault(&self) -> Option<Arc<dyn VaultLock>> {
        self.vault.get().cloned()
    }

    /// The relay's fleet id (`fleet.json` `relayId`), None while not enrolled.
    pub fn relay_id(&self) -> Option<String> {
        let mut held = self.relay_id.lock();
        if held.is_none() {
            let map = crate::fleet_agent::load_link_json(&self.dir).ok().flatten()?;
            *held = Some(crate::fleet_agent::Link { map }.relay_id().to_string()).filter(|id| !id.is_empty());
        }
        held.clone()
    }

    /// API-1d 14: the edition of the relay's own Spokes license (None: no license, so no map is accepted).
    fn edition(&self) -> Option<Edition> {
        let edition = self.state()?.lock().license_edition();
        Edition::of(edition.as_deref())
    }

    /// The orgs bound to this relay now.
    pub fn bound_orgs(&self) -> Vec<String> {
        self.inner.lock().bound.orgs.clone()
    }

    /// API-1 9.1: the relay's own audit chains (source = its fleet relay id), opened as `MeetFleet::audit` opens them.
    pub fn api_audit(&self) -> Option<Arc<ApiAudit>> {
        let mut held = self.audit.lock();
        if let Some(a) = held.as_ref() {
            return Some(a.clone());
        }
        let id = self.relay_id()?;
        let vault = self.vault()?;
        let signer = Arc::new(crate::api_checkpoint::RelayCheckpoints::new(&self.dir, vault.clone()));
        let keys = Arc::new(crate::api_checkpoint::RelayPseudonymKeys::new(&self.dir, vault));
        let audit = Arc::new(ApiAudit::open(Some(&self.dir), &id, signer, keys, now_s()));
        *held = Some(audit.clone());
        Some(audit)
    }

    /// API-1 revision 4 7.3: the relay's own event chains, opened as the audit chains are.
    pub fn api_events(&self) -> Option<Arc<EventLog>> {
        let mut held = self.events.lock();
        if let Some(e) = held.as_ref() {
            return Some(e.clone());
        }
        let id = self.relay_id()?;
        let vault = self.vault()?;
        let signer = Arc::new(crate::api_checkpoint::RelayCheckpoints::new(&self.dir, vault.clone()));
        let keys = Arc::new(crate::api_checkpoint::RelayPseudonymKeys::new(&self.dir, vault));
        let events = Arc::new(EventLog::open(Some(&self.dir), &id, signer, keys, now_s()));
        *held = Some(events.clone());
        Some(events)
    }

    /// API-1 revision 4 7.1 (as `Relay::api_event` in meet.rs): one event of this relay for `org`, durable in its event
    /// chains before Some(seq). A failure (or no chains yet) is the security line `api.events.failed` and None.
    pub fn event(&self, org: &str, kind: &str, data: Value) -> Option<u64> {
        let failed = |why: &str| {
            let f = Fields::new().with("org", org).with("type", kind).with("why", why);
            self.logger.security("api.events.failed", &f, Level::Error);
        };
        let Some(events) = self.api_events() else {
            failed("the relay's event chains are not open");
            return None;
        };
        events.emit(org, kind, data, now_s()).map_err(|e| failed(&e.message)).ok()
    }

    /// `api-orgs.json` written and flushed (shared contract item 4).
    fn save_bound(&self, b: &Bound) -> Result<(), Refusal> {
        let text = format!("{}\n", crate::codec::stringify(&b.to_value()));
        crate::fleet_local::write_durable(&self.dir.join(ORGS_FILE), text.as_bytes()).map_err(|_| Refusal::new(500, "io", "The bound organizations could not be written."))
    }

    /// API-1d 2.4, 5.1: bind exactly `orgs`, starting from `next` (the bound record with any other change of the same
    /// write: a generation, released roots, a raised high-water mark). The new record (with the high-water marks of
    /// every org it drops, R6-10) is flushed first; then the dropped orgs' pinned maps and journals are deleted and the
    /// store is read again. Their audit and event chains stay (retention), and so do their pinned roots: a later map
    /// under another root is refused until an `api-orgs` of a newer generation releases it. Returns the dropped orgs.
    fn rebind(&self, inner: &mut Inner, mut next: Bound, orgs: Vec<String>) -> Result<Vec<String>, Refusal> {
        let gone: Vec<String> = inner.bound.orgs.iter().filter(|o| !orgs.contains(o)).cloned().collect();
        next.orgs = orgs;
        for org in &gone {
            let (seq, tseq) = inner.store.head(org);
            let was = next.retired.get(org).copied().unwrap_or((0, 0));
            let mark = (seq.max(was.0), tseq.max(was.1));
            if mark != (0, 0) {
                next.retired.insert(org.clone(), mark);
            }
        }
        if next != inner.bound {
            self.save_bound(&next)?;
            inner.bound = next;
        }
        if !gone.is_empty() {
            for org in &gone {
                for sub in STORE_DIRS {
                    crate::store::remove(&self.dir.join(sub).join(format!("{org}.json")));
                }
            }
            inner.store = ApiMapStore::load(Some(&self.dir));
            let f = Fields::new().with("orgs", &inner.bound.orgs[..]).with("unbound", &gone[..]);
            self.logger.security("api.orgs.unbound", &f, Level::Info);
        }
        Ok(gone)
    }

    /// API-1d 2.4 `api-orgs`: 0 to 64 distinct org ids under a binding `generation` (1 or more), with the orgs whose
    /// pinned root this generation releases (`release_roots`, optional, 0 to 64 distinct ids). A generation below the
    /// applied one is refused (409 `stale-generation`), so a replayed older list never binds an org again; the applied
    /// generation again is answered `{ok: true}` and changes nothing (the console sends its record at every
    /// reconnect). A newer one is applied (an unbinding stops serving at once) and flushed, with the generation and the
    /// released roots in the same write, before `{ok: true}`.
    fn api_orgs(&self, body: &Value) -> Result<Value, Refusal> {
        let bad = || Refusal::new(400, "bad-orgs", "orgs and release_roots must be 0 to 64 distinct organization ids.");
        let ids = |key: &str| -> Result<Vec<String>, Refusal> {
            let list = match body.get(key) {
                None if key == "release_roots" => return Ok(Vec::new()),
                v => v.and_then(Value::as_array).filter(|a| a.len() <= ORGS_MAX).ok_or_else(bad)?,
            };
            let mut out: Vec<String> = list.iter().map(|v| v.as_str().filter(|o| crate::api_audit::org_ok(o)).map(str::to_owned)).collect::<Option<_>>().ok_or_else(bad)?;
            out.sort();
            if out.windows(2).any(|w| w[0] == w[1]) {
                return Err(bad());
            }
            Ok(out)
        };
        let orgs = ids("orgs")?;
        let release = ids("release_roots")?;
        let generation = body.get("generation").and_then(Value::as_u64).filter(|g| *g >= 1).ok_or_else(|| Refusal::new(400, "bad-orgs", "generation must be a whole number of 1 or more."))?;
        let mut inner = self.inner.lock();
        let applied = inner.bound.generation;
        if generation < applied {
            let f = Fields::new().with("generation", generation).with("applied", applied);
            self.logger.security("api.orgs.stale", &f, Level::Warn);
            return Err(Refusal::new(409, "stale-generation", &format!("That binding generation is older than generation {applied}, which this relay already applied.")));
        }
        if generation == applied {
            return Ok(json!({ "ok": true }));
        }
        let mut next = inner.bound.clone();
        next.generation = generation;
        for org in &release {
            if next.roots.remove(org).is_some() {
                self.logger.security("api.orgs.root-released", &Fields::new().with("org", org.as_str()).with("generation", generation), Level::Warn);
            }
        }
        self.rebind(&mut inner, next, orgs)?;
        Ok(json!({ "ok": true }))
    }

    /// API-1d 2.4, 5.1 `api-map` on a spokes relay (shared contract item 3): the org bound (`not-bound`), the map
    /// verified under the `trust` the console sends (the Meet org CA root and the root-signed signer policy, optional
    /// CRL; the relay's own Spokes license edition), then `pin_verified`.
    fn api_map(&self, body: &Value) -> Result<Value, Refusal> {
        let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
        let signed = body.get("map").unwrap_or(&Value::Null);
        if signed.get("map").and_then(|m| m.get("org")).and_then(Value::as_str) != Some(org) {
            return Err(Refusal::new(400, "bad-map", "The api map is for another organization."));
        }
        if !self.inner.lock().bound.has(org) {
            return Err(not_bound("This relay is not bound to that organization."));
        }
        let edition = self.edition().ok_or_else(|| api_refusal(ApiMapError::new("map-edition", "the license edition is not known, so no api map is accepted")))?;
        let bad_trust = || Refusal::new(400, "bad-map", "trust must be {root, signer_policy, crl?}.");
        let trust = body.get("trust").and_then(Value::as_object).ok_or_else(bad_trust)?;
        if trust.keys().any(|k| !matches!(k.as_str(), "root" | "signer_policy" | "crl")) {
            return Err(bad_trust());
        }
        let sig = |m: &str| api_refusal(ApiMapError::new("signature", m));
        let root = trust.get("root").and_then(Value::as_str).filter(|p| p.is_ascii()).and_then(crate::meet_x509::Cert::from_pem).ok_or_else(|| sig("the trust root is not a certificate"))?;
        let policy = trust.get("signer_policy").and_then(Value::as_object).ok_or_else(bad_trust)?;
        let crl = match trust.get("crl") {
            None => None,
            Some(v) => Some(v.as_str().and_then(|p| crate::meet_x509::Crl::from_pem(p.as_bytes())).ok_or_else(|| sig("the trust CRL does not read"))?),
        };
        let now = now_s();
        let held = self.inner.lock().store.issuers();
        let vm = crate::api_map::verify_api_map(signed, &root, policy, crl.as_ref(), "", now, None, edition, &held).map_err(api_refusal)?;
        self.pin_verified(org, vm, &crate::codec::sha256_hex(&root.spki), body, now)
    }

    /// API-1d 5.1 for a verified map of a bound org: its `spokes.root` and `spokes.root_spki` are this relay's root
    /// (409 `root-mismatch`); the Meet org CA root it was verified under is the one pinned for the org at its first
    /// accepted map (`signature`); after a rebind its seq is above the kept high-water mark (`seq-not-higher`). A map
    /// whose `spokes.relays` does not list this relay unbinds the org when it is newer than the pinned one (`{ok,
    /// unbound}`, R6-10) and is refused `not-bound` when nothing is pinned. Otherwise it is pinned (flushed) and
    /// answered as `api_map_pinned` answers, the journal rebased to the kept `tseq` after a rebind.
    pub fn pin_verified(&self, org: &str, vm: VerifiedApiMap, root_hex: &str, body: &Value, now: i64) -> Result<Value, Refusal> {
        let spokes = vm.map().get("spokes").cloned().unwrap_or(Value::Null);
        let ours = spokes.get("root").and_then(Value::as_str) == Some(self.root_id.as_str())
            && spokes.get("root_spki").and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case(&self.root_spki));
        if !ours {
            return Err(Refusal::new(409, "root-mismatch", "That api map names another Remote Spokes root."));
        }
        let relay = self.relay_id();
        let listed = relay.as_deref().is_some_and(|id| names(spokes.as_object().unwrap_or(&Map::new()), "relays").any(|r| r == id));
        let mut notes = Vec::new();
        let mut inner = self.inner.lock();
        if !inner.bound.has(org) {
            return Err(not_bound("This relay is not bound to that organization."));
        }
        if inner.bound.roots.get(org).is_some_and(|pin| !pin.eq_ignore_ascii_case(root_hex)) {
            return Err(api_refusal(ApiMapError::new("signature", "the api map was verified under another root than the one pinned for this organization")));
        }
        let (pinned_seq, _) = inner.store.head(org);
        if pinned_seq == 0 {
            if let Some((kept, _)) = inner.bound.retired.get(org).filter(|(kept, _)| vm.seq <= *kept) {
                return Err(api_refusal(ApiMapError::new("seq-not-higher", format!("that api map's seq is not higher than {kept}"))));
            }
        }
        if !listed {
            if pinned_seq == 0 {
                return Err(not_bound("That api map does not list this relay."));
            }
            let pinned_hash = inner.store.get(org, "").map(|p| p.hash.clone()).unwrap_or_default();
            match crate::api_map::pin_verdict(vm.seq, &vm.hash, pinned_seq, &pinned_hash) {
                "ok" => {}
                v => return Err(api_refusal(ApiMapError::new(v, format!("that api map's seq is not higher than {pinned_seq}")))),
            }
            // the unbinding map's seq is the kept high-water mark (written before the pinned map is deleted), so no other
            // map at that seq is taken after a rebind
            let mut next = inner.bound.clone();
            let was = next.retired.get(org).copied().unwrap_or((0, 0));
            next.retired.insert(org.to_owned(), (was.0.max(pinned_seq).max(vm.seq), was.1));
            let orgs: Vec<String> = inner.bound.orgs.iter().filter(|o| o.as_str() != org).cloned().collect();
            self.rebind(&mut inner, next, orgs)?;
            return Ok(json!({ "ok": true, "unbound": true }));
        }
        let r = inner.store.pin(vm);
        let answer = api_map_pinned(r, &mut inner.store, body, &self.logger, &mut notes).and_then(|mut answer| {
            let mut next = inner.bound.clone();
            if let Some((_, tseq)) = next.retired.remove(org) {
                // R6-10: journal acceptance starts from the kept tseq (1a 2.5 rebase)
                if let Some(from) = inner.store.rebase(org, tseq).map_err(api_refusal)? {
                    self.logger.security("api.journal.rebased", &Fields::new().with("org", org).with("from", from).with("to", tseq), Level::Warn);
                    notes.push((org.to_owned(), json!({ "action": "api.journal.rebased", "resource": org, "result": "ok", "tseq": tseq })));
                }
                answer["tseq"] = json!(inner.store.head(org).1);
            }
            next.roots.entry(org.to_owned()).or_insert_with(|| root_hex.to_lowercase());
            if next != inner.bound {
                self.save_bound(&next)?;
                inner.bound = next;
            }
            Ok(answer)
        });
        drop(inner);
        // a new pin, a conflict and a rebase go into the org's chain with the lock released
        api_record(self.api_audit().as_deref(), notes, &self.logger, now);
        answer
    }

    /// API-1 2.5 `api-tighten` for a bound org (fail closed on an unknown action, as the store is).
    fn api_tighten(&self, body: &Value) -> Result<Value, Refusal> {
        let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
        let mut notes = Vec::new();
        let answer = {
            let mut inner = self.inner.lock();
            if !inner.bound.has(org) {
                return Err(not_bound("This relay is not bound to that organization."));
            }
            api_tighten_answer(&mut inner.store, body, &mut notes)
        };
        api_record(self.api_audit().as_deref(), notes, &self.logger, now_s());
        answer
    }

    /// API-1d 2.4 `api-spokes`.
    fn api_spokes(&self, body: &Value) -> Result<Value, Refusal> {
        let s = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or_default();
        let people = body.get("people").and_then(Value::as_bool).unwrap_or(false);
        self.view(s("org"), s("view"), s("query"), people)
    }

    /// The listener's view of one bound org (API-1 5.6): a read-only copy of its api state, the pinned maps checked
    /// against the license edition in force first (13); None when the org is not bound.
    pub fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
        let edition = self.edition();
        let mut inner = self.inner.lock();
        if !inner.bound.has(org) {
            return None;
        }
        for o in inner.store.revalidate(edition) {
            let state = if inner.store.is_set_aside(&o) { "set-aside" } else { "restored" };
            self.logger.security("api.map.edition-refused", &Fields::new().with("org", o.as_str()).with("state", state), Level::Warn);
        }
        Some(inner.store.org_snapshot(org))
    }

    /// API-1d 6.1, 6.2 (shared contract item 9): the view of the relay's own state for a bound org (404 `not-found`
    /// otherwise): `nodes` (`{nodes, next?}`, filters `role`, `state`, `q`, `limit`, `after`), `counts`, `seats`,
    /// `relays` (with the license `state`, `daysLeft`, `edition`). Without `people` no email appears and `q` never
    /// matches one. A `relay` in the query must be this relay.
    pub fn view(&self, org: &str, view: &str, query: &str, people: bool) -> Result<Value, Refusal> {
        let not_found = || Refusal::new(404, "not-found", "not found");
        if !self.inner.lock().bound.has(org) {
            return Err(not_found());
        }
        let bad = |m: &str| Refusal::new(400, "invalid", m);
        if !VIEWS.contains(&view) {
            return Err(bad("view is nodes, counts, seats or relays."));
        }
        if query.len() > QUERY_MAX {
            return Err(bad("The query is longer than 512 bytes."));
        }
        let (relay, after, rest) = split_query(query);
        if relay.is_some() && relay != self.relay_id() {
            return Err(not_found());
        }
        if view != "nodes" && (after.is_some() || !rest.is_empty()) {
            return Err(bad("This view takes no filter."));
        }
        if after.as_deref().is_some_and(|a| !crate::identity::is_node_id(a)) {
            return Err(bad("after is a node id."));
        }
        let state = self.state().ok_or_else(|| Refusal::new(503, "relay-unavailable", "The relay is stopping."))?;
        let t = crate::codec::now_ms();
        let filter = if view == "nodes" { Some(crate::console_spokes::node_filter(&rest).map_err(Refusal::from)?) } else { None };
        let st = state.lock();
        let mut v = match (view, filter) {
            ("nodes", Some(f)) => st.api_spokes_nodes(&f, after.as_deref(), people, t),
            ("counts", _) => st.spokes_counts(t),
            ("seats", _) => {
                let mut v = st.spokes_seats(t);
                if !people {
                    for k in ["seats", "uncounted"] {
                        for row in v.get_mut(k).and_then(Value::as_array_mut).into_iter().flatten() {
                            if let Some(m) = row.as_object_mut() {
                                m.remove("email");
                            }
                        }
                    }
                }
                v
            }
            _ => {
                let mut v = st.spokes_relays();
                let lic = st.license_view(t).map(|(l, _)| l);
                let field = |k: &str| lic.as_ref().and_then(|l| l.get(k)).cloned().unwrap_or(Value::Null);
                v["state"] = field("state");
                v["daysLeft"] = field("daysLeft");
                v["edition"] = field("edition");
                // the root-signed CRL itself (public, as at `GET /v1/crl`): the console checks a pasted service hub
                // certificate against it (4.2)
                v["crl"]["token"] = st.crl_token().map_or(Value::Null, Value::from);
                v
            }
        };
        if let Some(m) = v.as_object_mut() {
            m.remove("ok");
        }
        Ok(v)
    }

    /// API-1d 5.3 rules 1 to 10 for one service hub request (the caller runs it after `authenticate` and the block
    /// check, before seat and routing). Every refusal is appended to the org's relay chain as `api.refusal` before Err
    /// (503 `audit-unavailable` when it cannot be); with no org bound, a `not-registered` refusal is the security line
    /// `spokes.service-unregistered` only. Ok: the relay appends `spokes.mail` (`mail`) before it answers.
    pub fn check(&self, q: &ServiceReq, t: i64) -> Result<Allowed, Refused> {
        let now = t.div_euclid(1000);
        let route = format!("{} {}", q.method, q.path);
        let inner = self.inner.lock();
        // 1: a `spokes_node` credential (serial and SPKI) of a `spokes_hub` client in a pinned map of a bound org
        let found = inner.bound.orgs.iter().find_map(|org| registered(&inner.store, org, q.serial, q.spki_sha256).map(|c| (org.clone(), c)));
        let Some((org, id)) = found else {
            let orgs = inner.bound.orgs.clone();
            drop(inner);
            if orgs.is_empty() {
                return Err(Refused { event: UNREGISTERED_EVENT, ..refused("not-registered") });
            }
            let mut out = refused("not-registered");
            for org in &orgs {
                let r = self.refusal(org, None, q, &route, "not-registered", now);
                if r.status == 503 {
                    out = r;
                }
            }
            return Err(out);
        };
        let store = &inner.store;
        let no = |code: &'static str| Err(self.refusal(&org, Some(id.as_str()), q, &route, code, now));
        // 2
        if let Some(code) = crate::api_issue::closed(store, &org, now) {
            return no(code);
        }
        if q.edition != Some("enterprise") {
            return no("license");
        }
        let Some(c) = find_client(store, &org, &id) else { return no("suspended") };
        let active = store.active(&org);
        // 3
        let suspended = c.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(id.as_str()));
        if suspended {
            return no("suspended");
        }
        let registration_end = c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
        if now > crate::api_map::effective_end(registration_end, &[store.grace_hours(&org, "app", now)]) {
            return no("expired");
        }
        if crate::api_scim::owner_inactive_in(&self.dir, &org, c.get("owner").and_then(Value::as_str).unwrap_or_default()) {
            return no("owner");
        }
        // 4.2: a removed `spokes_node` credential is journaled `client_drop_credential` with its serial as `kid`
        let dropped = client_entries(active, "client_drop_credential", &id).any(|e| target_field(e, "kid").eq_ignore_ascii_case(q.serial) || target_field(e, "type") == "spokes_node");
        if dropped {
            return no("client-auth");
        }
        // 4 (contract.md 6.2 check 8: no existence leak)
        if !self.relay_id().is_some_and(|relay| relay_reachable(c, active, &id, &relay)) {
            return no("not-found");
        }
        // 5
        let network = match q.source {
            Some(ip) => source_allowed(c, active, &id, ip),
            // no address to judge: only a client limited to no network passes
            None => names(c, "networks").next().is_none() && client_entries(active, "client_limit", &id).all(|e| e.target.get("networks").is_none()),
        };
        if !network {
            return no("network");
        }
        if c.get("hours").is_some_and(|h| !crate::api_issue::inside_hours(h, now)) {
            return no("hours");
        }
        // 6: on this relay, per request
        let key = format!("{org} {id}");
        let (per_minute, per_day) = (rate_of(c, active, &id, "per_minute_each"), rate_of(c, active, &id, "per_day_each"));
        if crate::api_issue::take(&self.minute, &key, usize::try_from(per_minute).unwrap_or(usize::MAX), now).is_err() || crate::api_issue::take_daily(&self.daily, &key, per_day, now).is_err() {
            return no("rate");
        }
        // 7
        if !SERVICE_ROUTES.contains(&(q.method, q.path)) {
            return no("route");
        }
        let targets: Vec<String> = c.get("spokes").and_then(Value::as_object).map(|s| names(s, "targets").map(str::to_owned).collect()).unwrap_or_default();
        let dropped: Vec<String> = client_entries(active, "client_drop_target", &id).map(|e| target_field(e, "spoke").to_owned()).collect();
        let allowed = Allowed { org: org.clone(), client: id.clone(), route: route.clone(), ip: q.source.map(|s| s.to_string()), targets, dropped };
        if (q.method, q.path) == ("POST", "/v1/send") {
            // 8
            if !q.to.is_some_and(|to| allowed.reaches(to)) {
                return no("target");
            }
            // 9: the recipient's class as last verified here, at or below the effective ceiling
            let Some(class) = q.to_seen.map(task_class) else { return no("target") };
            let own = c.get("ceiling").and_then(Value::as_str).and_then(rank).unwrap_or(0);
            let ceiling = client_entries(active, "client_lower_ceiling", &id).filter_map(|e| rank(target_field(e, "ceiling"))).fold(own, usize::min);
            if rank(class).is_none_or(|r| r > ceiling) {
                return no("ceiling");
            }
        }
        Ok(allowed)
    }

    /// API-1d 5.3, 1a 9.4: a refusal into the org's refusal summaries (key: the client once identified, else the
    /// sender node), counted; 503 `audit-unavailable` when it cannot be recorded.
    fn refusal(&self, org: &str, client: Option<&str>, q: &ServiceReq, route: &str, code: &'static str, now: i64) -> Refused {
        let r = refused(code);
        let mut e = json!({ "action": "api.refusal", "route": route, "result": "refused", "check": code, "status": r.status, "count": 1, "node": q.node });
        if let Some(c) = client {
            e["client"] = json!(c);
        }
        if let Some(ip) = q.source {
            e["ip"] = json!(ip.to_string());
        }
        let key = client.unwrap_or(q.node);
        let recorded = self.api_audit().is_some_and(|a| a.refusal(org, key, code, route, e, now).is_ok());
        crate::api_catalog::counters::spokes_service_mail(org, client.unwrap_or_default(), "refused");
        if recorded {
            r
        } else {
            self.logger.security("api.audit-failed", &Fields::new().with("org", org).with("action", "api.refusal").with("check", code), Level::Error);
            refused("audit-unavailable")
        }
    }

    /// API-1d 5.3, 11: an allowed service hub request as `spokes.mail` (`client`, `node` the sender, `to` for a send,
    /// `route`, `bytes`, `ip`), durable in the org's chain; false when it could not be appended (the caller answers 503
    /// and stores nothing).
    pub fn mail(&self, a: &Allowed, node: &str, to: Option<&str>, bytes: usize, t: i64) -> bool {
        let mut e = json!({ "action": "spokes.mail", "client": a.client, "node": node, "route": a.route, "bytes": bytes, "result": "ok" });
        if let Some(to) = to {
            e["to"] = json!(to);
        }
        if let Some(ip) = &a.ip {
            e["ip"] = json!(ip);
        }
        let why = match self.api_audit() {
            Some(audit) => audit.record(&a.org, e, t.div_euclid(1000)).err().map(|e| e.message),
            None => Some("no audit chains yet".to_owned()),
        };
        crate::api_catalog::counters::spokes_service_mail(&a.org, &a.client, if why.is_none() { "ok" } else { "refused" });
        if let Some(why) = &why {
            self.logger.security("api.audit-failed", &Fields::new().with("org", a.org.as_str()).with("action", "spokes.mail").with("why", why.as_str()), Level::Error);
        }
        why.is_none()
    }

    /// API-1d 6.4: `kind` about one spoke into the event chains of every bound org with a pinned map.
    fn spoke_event(&self, kind: &str, node: &str, label: &str, last_poll_at: i64) {
        let Some(relay) = self.relay_id() else { return };
        let orgs: Vec<String> = {
            let inner = self.inner.lock();
            inner.bound.orgs.iter().filter(|o| inner.store.get(o, "").is_some()).cloned().collect()
        };
        for org in orgs {
            self.event(&org, kind, json!({ "relay": relay, "node": node, "label": label, "last_poll_at": last_poll_at }));
        }
    }

    /// API-1d 6.4: the spokes silent now (no poll for 24 hours); `spoke.offline` for each one not reported yet.
    pub fn spokes_silent(&self, rows: &[SpokeSeen]) {
        let fresh: Vec<&SpokeSeen> = {
            let mut silent = self.silent.lock();
            rows.iter().filter(|r| silent.insert(r.node.clone())).collect()
        };
        for r in fresh {
            self.spoke_event("spoke.offline", &r.node, &r.label, r.last_poll_at);
        }
    }

    /// API-1d 6.4: a silent spoke polled at `t` (`before` its last poll before this one): `spoke.offline` first when no
    /// tick reported it yet, then `spoke.online`.
    pub fn spoke_polled(&self, node: &str, label: &str, before: i64, t: i64) {
        let noted = self.silent.lock().remove(node);
        if !noted {
            self.spoke_event("spoke.offline", node, label, before);
        }
        self.spoke_event("spoke.online", node, label, t);
    }

    /// API-1d 6.4: one look at the relay's spokes (the periodic tick).
    pub fn tick(&self, t: i64) {
        let Some(state) = self.state() else { return };
        let rows = state.lock().silent_spokes(t);
        self.spokes_silent(&rows);
    }
}

/// API-1d 5.1 `not-bound` (403).
fn not_bound(why: &str) -> Refusal {
    Refusal::new(403, "not-bound", why)
}

/// API-1d 5.3 rule 1: the client of `org`'s pinned map (not set aside) of kind `spokes_hub` holding a `spokes_node`
/// credential with this serial and SPKI hash.
fn registered(store: &ApiMapStore, org: &str, serial: &str, spki: &str) -> Option<String> {
    store.clients(org).iter().filter_map(Value::as_object).filter(|c| c.get("kind").and_then(Value::as_str) == Some("spokes_hub")).find_map(|c| {
        let holds = c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|cr| {
            let s = |k: &str| cr.get(k).and_then(Value::as_str).unwrap_or_default();
            s("type") == "spokes_node" && s("serial").eq_ignore_ascii_case(serial) && s("spki").eq_ignore_ascii_case(spki)
        });
        holds.then(|| c.get("id").and_then(Value::as_str).unwrap_or_default().to_owned())
    })
}

/// A 6.1 query string split into its `relay`, its `after` and the remaining filters (as given).
fn split_query(query: &str) -> (Option<String>, Option<String>, String) {
    let (mut relay, mut after, mut rest) = (None, None, Vec::new());
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        match pair.split_once('=').unwrap_or((pair, "")) {
            ("relay", v) => relay = Some(v.to_owned()),
            ("after", v) => after = Some(v.to_owned()),
            _ => rest.push(pair),
        }
    }
    (relay, after, rest.join("&"))
}

/// API-1d 2.4: the API ops of the link on a spokes relay.
impl crate::fleet_agent::ApiHooks for SpokesApi {
    /// API-1d 5.1: exactly the bound orgs; an org bound again before its first map reports its kept high-water marks.
    fn api_heads(&self) -> Value {
        let inner = self.inner.lock();
        let heads: Map<String, Value> = inner
            .bound
            .orgs
            .iter()
            .map(|o| {
                let (seq, tseq) = inner.store.head(o);
                let (kept_seq, kept_tseq) = inner.bound.retired.get(o).copied().unwrap_or((0, 0));
                (o.clone(), json!({ "seq": seq.max(kept_seq), "tseq": tseq.max(kept_tseq) }))
            })
            .collect();
        Value::Object(heads)
    }

    fn api_request(&self, op: &str, body: &Value) -> Option<Result<Value, Refusal>> {
        Some(match op {
            "api-orgs" => self.api_orgs(body),
            "api-map" => self.api_map(body),
            "api-tighten" => self.api_tighten(body),
            "api-spokes" => self.api_spokes(body),
            _ => Err(Refusal::of("fleet-op")),
        })
    }

    fn api_audit(&self) -> Option<Arc<ApiAudit>> {
        SpokesApi::api_audit(self)
    }

    fn api_events(&self) -> Option<Arc<EventLog>> {
        SpokesApi::api_events(self)
    }

    /// API-1 revision 4 2.3 item 6, as `api_synced_clear` on a Meeting Hub relay.
    fn api_synced(&self, orgs: &[String]) {
        match self.inner.lock().store.clear_unknown(orgs.iter().map(String::as_str)) {
            Ok(cleared) => {
                for org in cleared {
                    self.logger.security("api.journal.unknown-cleared", &Fields::new().with("org", org.as_str()), Level::Info);
                }
            }
            Err(e) => self.logger.security("api.journal.unknown-unsaved", &Fields::new().with("why", e.message), Level::Error),
        }
    }

    fn spokes(&self) -> bool {
        true
    }
}

/// API-1d 6.3: the spokes relay as its API listener sees it.
pub struct SpokesSource(pub Arc<SpokesApi>);

impl crate::api_listener::Source for SpokesSource {
    fn relay_id(&self) -> Option<String> {
        self.0.relay_id()
    }

    fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
        self.0.snapshot(org)
    }

    /// No people directory on a spokes relay: the owner-inactive record is applied by 5.3 rule 3.
    fn owner_active(&self, _principal: &str) -> bool {
        true
    }

    fn pseudonym_ready(&self, org: &str) -> bool {
        self.0.dir.join(crate::fleet_agent::API_PSEUDONYM_DIR).join(format!("{org}.json")).is_file()
    }

    fn vault(&self) -> Option<Arc<dyn VaultLock>> {
        self.0.vault()
    }

    fn licensed(&self) -> bool {
        self.0.state().is_some_and(|s| s.lock().service_on(crate::codec::now_ms()))
    }

    fn audit(&self) -> Option<Arc<dyn crate::api_resource::AuditLog>> {
        self.0.api_audit().map(|a| a as Arc<dyn crate::api_resource::AuditLog>)
    }

    fn console_connected(&self) -> bool {
        crate::fleet_agent::channel_up(&self.0.dir)
    }

    fn product(&self) -> Product {
        Product::Spokes
    }

    fn events(&self) -> Option<Arc<EventLog>> {
        self.0.api_events()
    }

    fn spokes(&self, org: &str, view: &str, query: &str, people: bool) -> Option<Result<Value, Refusal>> {
        Some(self.0.view(org, view, query, people))
    }
}

/// API-1 12 on a spokes relay: what its failover exporter reads (as `MeetFailover` in meet.rs).
struct SpokesFailover(Arc<SpokesApi>);

impl crate::api_failover::RelaySide for SpokesFailover {
    fn orgs(&self) -> Vec<String> {
        self.0.bound_orgs()
    }

    fn api_map(&self, org: &str) -> Option<(Value, Vec<crate::api_map::TightenEntry>)> {
        let store = self.0.snapshot(org)?;
        let map = Value::Object(store.get(org, "")?.map().clone());
        Some((map, store.active(org).to_vec()))
    }

    fn edition(&self) -> Option<Edition> {
        self.0.edition()
    }

    fn relay_id(&self) -> Option<String> {
        self.0.relay_id()
    }

    fn audit(&self) -> Option<Arc<ApiAudit>> {
        self.0.api_audit()
    }

    fn vault(&self) -> Option<Arc<dyn VaultLock>> {
        self.0.vault()
    }

    fn channel_up(&self) -> bool {
        crate::fleet_agent::channel_up(&self.0.dir)
    }

    fn caught_up(&self) -> bool {
        crate::fleet_agent::api_caught_up(&self.0.dir)
    }

    fn metric_rows(&self, org: &str, now: i64) -> Vec<crate::api_export::MetricRow> {
        let Some(id) = self.relay_id() else { return Vec::new() };
        crate::api_export::parse_exposition(&crate::api_listener::own_exposition(&id, Product::Spokes, org, now))
    }

    fn mode_changed(&self, org: &str, mode: &str) {
        if let Some(id) = self.relay_id() {
            self.0.event(org, "relay.mode.changed", json!({ "relay": id, "mode": mode }));
        }
    }

    fn make_sink(&self, destination: &Value, credential: crate::api_export_wire::Credential) -> Result<Box<dyn crate::api_export_wire::Sink>, crate::api_export_wire::SinkError> {
        if destination.get("kind").and_then(Value::as_str) == Some("syslog_cef") {
            let host = gethostname::gethostname().to_string_lossy().to_ascii_lowercase();
            crate::fleet_syslog::cef_sink(destination, credential, &host, env!("CARGO_PKG_VERSION"))
        } else {
            crate::api_export_wire::sink_for(destination, credential)
        }
    }
}

/// What `start` needs (server.rs `fleet_start`, Remote Spokes with a state folder).
pub struct Start<'a> {
    pub dir: &'a Path,
    pub state: &'a Arc<Mutex<State>>,
    pub logger: Arc<Logger>,
    /// `--api-listen` or LUCID_RELAY_API_LISTEN, and the relay's own TLS configuration for it.
    pub api_listen: Option<&'a str>,
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

/// API-1d 2.4, 6.3, 6.4: the spokes relay's API side at start: the state, registered as the folder's `ApiHooks` and
/// given to the relay State (5.3); the audit and event chain tickers (API-1 9.3, 9.4; revision 4 7.3); the failover
/// exporter (API-1 12); the minute tick for `spoke.offline`; and, with `api_listen`, the listener. The pinned maps go
/// on enforcing 5.3 while the console is gone, until they expire (6.3, 1a 12). Called before the fleet agent starts,
/// so its first `api-orgs` finds the hooks; the vault follows with `set_vault` (the chains open once it is there).
pub fn start(s: Start) -> Result<Arc<SpokesApi>, String> {
    let (root_id, root_spki) = s.state.lock().root_pin();
    let api = Arc::new(SpokesApi::new(s.dir, &root_id, &root_spki, s.logger.clone()));
    api.set_state(s.state);
    s.state.lock().set_spokes_api(api.clone());
    crate::fleet_agent::set_api_hooks(s.dir, api.clone());
    crate::api_failover::start(s.dir, Arc::new(SpokesFailover(api.clone())), s.logger.clone())?;
    let note_logger = s.logger.clone();
    let note = move |n: &str| note_logger.security("api.audit.note", &Fields::new().with("note", n), Level::Warn);
    let weak = Arc::downgrade(&api);
    crate::api_resource::spawn_ticker("spokes-api-audit", Box::new(move || weak.upgrade()?.api_audit()), Box::new(note.clone()))?;
    let weak = Arc::downgrade(&api);
    crate::api_events::spawn_ticker("spokes-api-events", Box::new(move || weak.upgrade()?.api_events()), Box::new(note))?;
    let weak = Arc::downgrade(&api);
    std::thread::Builder::new()
        .name("spokes-api-silent".into())
        .spawn(move || loop {
            std::thread::sleep(SILENT_TICK);
            let Some(api) = weak.upgrade() else { break };
            api.tick(crate::codec::now_ms());
        })
        .map_err(|e| e.to_string())?;
    if let Some(listen) = s.api_listen {
        let tls = s.tls.ok_or("the API listener needs the relay's own TLS certificate and key (--tls-cert, --tls-key)")?;
        crate::api_listener::start_spokes(Box::new(SpokesSource(api.clone())), s.dir, listen, tls)?;
    }
    Ok(api)
}

#[cfg(test)]
impl SpokesApi {
    /// A spokes relay `relay` of the root `root_id` (SPKI hash `root_spki`) under `dir` with its chains open (no
    /// checkpoint signer).
    pub(crate) fn for_test(dir: &Path, relay: &str, root_id: &str, root_spki: &str) -> SpokesApi {
        let api = SpokesApi::new(dir, root_id, root_spki, Arc::new(Logger::capture("relay", Box::new(|_, _| {}))));
        *api.relay_id.lock() = Some(relay.to_owned());
        let now = now_s();
        *api.audit.lock() = Some(Arc::new(ApiAudit::open(Some(dir), relay, Arc::new(tests::NoSigner), Arc::new(tests::Keys), now)));
        *api.events.lock() = Some(Arc::new(EventLog::open(Some(dir), relay, Arc::new(tests::NoSigner), Arc::new(tests::Keys), now)));
        api
    }

    /// The binding generation `api-orgs` applied last.
    pub(crate) fn generation(&self) -> u64 {
        self.inner.lock().bound.generation
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fleet_agent::ApiHooks;

    pub(crate) const NOW: i64 = 1_795_000_000;
    pub(crate) const T: i64 = NOW * 1000;
    pub(crate) const RELAY: &str = "r_21";
    pub(crate) const ROOT: &str = "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    pub(crate) const ROOT_SPKI: &str = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
    /// The SHA-256 hex of the Meet org CA root a map is "verified" under in these tests.
    pub(crate) const CA_PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    pub(crate) const HUB: &str = "n_5e6f708192a3b4c5d6e7f8091a2b3c4d";
    pub(crate) const SERIAL: &str = "0a1b2c3d";
    pub(crate) const SPKI: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    const SPOKE: &str = "n_a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const CUI_SPOKE: &str = "n_a1b2c3d4e5f60718293a4b5c6d7e8f91";
    const OTHER: &str = "n_b1b2c3d4e5f60718293a4b5c6d7e8f90";
    const CLIENT: &str = "c_9a8b7c6d5e4f3a2b";

    pub(crate) struct NoSigner;
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

    pub(crate) struct Keys;
    impl crate::api_audit::PseudonymKeys for Keys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![5; 32]))
        }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-spokes-api-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn api(name: &str) -> (SpokesApi, PathBuf) {
        let dir = temp(name);
        (SpokesApi::for_test(&dir, RELAY, ROOT, ROOT_SPKI), dir)
    }

    /// A `spokes_hub` client holding the test service hub's credential.
    pub(crate) fn hub_client(targets: Value, ceiling: &str, serial: &str, spki: &str) -> Value {
        json!({"id": CLIENT, "name": "build-hub", "principal": "build-hub@apps.acme.example", "kind": "spokes_hub",
               "owner": "ann@acme.example", "reach": "R1", "scopes": ["spokes.tasks.submit"], "ceiling": ceiling,
               "relays": [RELAY], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 60, "per_day_each": 20000},
               "credentials": [{"type": "spokes_node", "node": HUB, "serial": serial, "spki": spki, "expires": NOW + 30 * 86_400, "key_store": "os_store"}],
               "spokes": {"targets": targets}, "created": NOW - 86_400, "expires": NOW + 300 * 86_400, "state": "active"})
    }

    /// A map of acme with `seq`, naming `relays` in `spokes.relays` under `root`, with `clients`.
    pub(crate) fn map(seq: i64, relays: Value, root: &str, clients: Value) -> VerifiedApiMap {
        let map = json!({"v": 1, "org": "acme", "seq": seq, "issued": NOW - 60, "expires": NOW + 30 * 86_400,
                         "issuer": {"url": "https://console.acme.example/api/orgs/acme", "jwks": []},
                         "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0}, "failover_after_s": 300,
                         "spokes": {"root": root, "root_spki": ROOT_SPKI, "relays": relays}, "clients": clients});
        let hash = crate::api_map::api_map_hash(&map);
        let wire = json!({"map": map, "sig": "", "chain": []}).as_object().unwrap().clone();
        VerifiedApiMap { wire, org: "acme".into(), seq, expires: NOW + 30 * 86_400, hash, signer: "root".into() }
    }

    fn standard_map(seq: i64) -> VerifiedApiMap {
        map(seq, json!([RELAY]), ROOT, json!([hub_client(json!([SPOKE, CUI_SPOKE]), "confidential", SERIAL, SPKI)]))
    }

    fn pin(api: &SpokesApi, vm: VerifiedApiMap) -> Result<Value, Refusal> {
        api.pin_verified("acme", vm, CA_PIN, &json!({"org": "acme"}), NOW)
    }

    /// `api-orgs` with `orgs` at the next binding generation.
    fn bind(api: &SpokesApi, orgs: Value) {
        let generation = api.generation() + 1;
        assert_eq!(api.api_request("api-orgs", &json!({ "orgs": orgs, "generation": generation })).unwrap(), Ok(json!({ "ok": true })));
    }

    fn req<'a>(method: &'a str, path: &'a str, to: Option<&'a str>, to_seen: Option<Option<&'a str>>) -> ServiceReq<'a> {
        ServiceReq { node: HUB, serial: SERIAL, spki_sha256: SPKI, method, path, source: Some("10.40.0.7".parse().unwrap()), to, to_seen, edition: Some("enterprise") }
    }

    fn send<'a>(to: &'a str, seen: Option<Option<&'a str>>) -> ServiceReq<'a> {
        req("POST", "/v1/send", Some(to), seen)
    }

    fn code(r: Result<Allowed, Refused>) -> &'static str {
        r.err().map_or("ok", |e| e.code)
    }

    fn tighten(api: &SpokesApi, tseq: u64, action: &str, target: Value) -> Result<Value, Refusal> {
        let entry = json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW - 10, "action": action, "target": target});
        api.api_request("api-tighten", &json!({ "org": "acme", "entry": entry })).unwrap()
    }

    /// The actions in the relay's `as_is` audit chain for acme.
    fn actions(api: &SpokesApi) -> Vec<(String, String)> {
        let page = api.api_audit().unwrap().read("acme", RELAY, crate::api_audit::Repr::AsIs, 0, 1000).unwrap();
        page["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| (e["action"].as_str().unwrap_or_default().to_owned(), e["check"].as_str().unwrap_or_default().to_owned()))
            .collect()
    }

    /// The event types in the relay's `as_is` event chain for acme.
    fn events(api: &SpokesApi) -> Vec<String> {
        let page = api.api_events().unwrap().chains().read("acme", RELAY, crate::api_audit::Repr::AsIs, 0, 1000).unwrap();
        page["entries"].as_array().into_iter().flatten().filter_map(|e| e["type"].as_str().map(str::to_owned)).collect()
    }

    #[test]
    fn task_class_follows_the_classification() {
        assert_eq!(task_class(Some("shareable")), "internal");
        assert_eq!(task_class(Some("private")), "confidential");
        assert_eq!(task_class(None), "confidential");
        assert_eq!(task_class(Some("cui")), "cui");
        assert_eq!(task_class(Some("secret")), "cui", "an unknown classification is the top (fail closed)");
    }

    /// 17.2: an unregistered service hub is refused with and without a bound org; with none bound only the security
    /// line says so, with one the refusal is in its chain.
    #[test]
    fn an_unregistered_service_hub_is_refused_with_and_without_a_bound_org() {
        let (api, _dir) = api("unregistered");
        let r = api.check(&req("GET", "/v1/inbox", None, None), T).unwrap_err();
        assert_eq!((r.status, r.code, r.error, r.event), (403, "not-registered", NOT_REGISTERED, UNREGISTERED_EVENT));
        bind(&api, json!(["acme"]));
        let r = api.check(&req("GET", "/v1/inbox", None, None), T).unwrap_err();
        assert_eq!((r.status, r.code, r.event), (403, "not-registered", REFUSED_EVENT));
        assert_eq!(actions(&api), [("api.refusal".to_owned(), "not-registered".to_owned())]);
        // a pinned map that registers another credential
        pin(&api, map(1, json!([RELAY]), ROOT, json!([hub_client(json!(["*"]), "confidential", "ffff", SPKI)]))).unwrap();
        assert_eq!(code(api.check(&req("GET", "/v1/inbox", None, None), T)), "not-registered");
    }

    /// 17.2: a registered hub sends to a target, is refused `target` for another spoke and for one never seen here,
    /// `ceiling` for a cui spoke under a confidential ceiling; a journaled `client_lower_ceiling` takes effect on the
    /// next send; `client_drop_target` and `client_suspend` refuse; every decision is in the chain.
    #[test]
    fn a_registered_service_hub_is_held_to_targets_ceiling_and_the_journal() {
        let (api, _dir) = api("registered");
        bind(&api, json!(["acme"]));
        assert_eq!(pin(&api, standard_map(1)).unwrap()["seq"], 1);
        let a = api.check(&send(SPOKE, Some(Some("private"))), T).unwrap();
        assert_eq!((a.org.as_str(), a.client.as_str(), a.route.as_str()), ("acme", CLIENT, "POST /v1/send"));
        assert!(api.mail(&a, HUB, Some(SPOKE), 120, T));
        assert_eq!(code(api.check(&send(OTHER, Some(Some("private"))), T)), "target");
        assert_eq!(code(api.check(&send(SPOKE, None), T)), "target", "a recipient never seen here");
        assert_eq!(code(api.check(&send(CUI_SPOKE, Some(Some("cui"))), T)), "ceiling");
        assert_eq!(code(api.check(&req("GET", "/v1/console/where", None, None), T)), "route");
        let inbox = api.check(&req("GET", "/v1/inbox", None, None), T).unwrap();
        assert!(inbox.reaches(SPOKE) && !inbox.reaches(OTHER), "presence rows are filtered to the targets");
        tighten(&api, 1, "client_lower_ceiling", json!({"client": CLIENT, "ceiling": "internal"})).unwrap();
        assert_eq!(code(api.check(&send(SPOKE, Some(Some("private"))), T)), "ceiling", "effective on the next send");
        assert_eq!(code(api.check(&send(SPOKE, Some(Some("shareable"))), T)), "ok");
        tighten(&api, 2, "client_drop_target", json!({"client": CLIENT, "spoke": SPOKE})).unwrap();
        assert_eq!(code(api.check(&send(SPOKE, Some(Some("shareable"))), T)), "target");
        tighten(&api, 3, "client_suspend", json!(CLIENT)).unwrap();
        assert_eq!(code(api.check(&req("GET", "/v1/inbox", None, None), T)), "suspended");
        let got = actions(&api);
        assert!(got.contains(&("spokes.mail".to_owned(), String::new())));
        for check in ["target", "ceiling", "route", "suspended"] {
            assert!(got.iter().any(|(a, c)| a == "api.refusal" && c == check), "{check} is in the chain: {got:?}");
        }
    }

    /// 5.3 rules 2, 4 and 5: the license edition, a relay outside `relays` (404 with the relay's own body), the
    /// networks.
    #[test]
    fn license_relays_and_networks_refuse() {
        let (api, _dir) = api("rules");
        bind(&api, json!(["acme"]));
        let mut c = hub_client(json!(["*"]), "confidential", SERIAL, SPKI);
        c["networks"] = json!(["10.40.0.0/23"]);
        pin(&api, map(1, json!([RELAY]), ROOT, json!([c.clone()]))).unwrap();
        let mut q = send(SPOKE, Some(Some("private")));
        q.edition = Some("standard");
        assert_eq!(code(api.check(&q, T)), "license");
        let mut q = send(SPOKE, Some(Some("private")));
        q.source = Some("192.0.2.1".parse().unwrap());
        assert_eq!(code(api.check(&q, T)), "network");
        q.source = None;
        assert_eq!(code(api.check(&q, T)), "network", "no address to judge");
        c["relays"] = json!(["r_22"]);
        pin(&api, map(2, json!([RELAY]), ROOT, json!([c]))).unwrap();
        let r = api.check(&send(SPOKE, Some(Some("private"))), T).unwrap_err();
        assert_eq!((r.status, r.code, r.error), (404, "not-found", "not found"));
    }

    /// 5.1: a map naming another Remote Spokes root is refused `root-mismatch`; a map of an org that is not bound
    /// `not-bound`; a map under another Meet org CA root than the pinned one `signature`.
    #[test]
    fn maps_are_pinned_only_under_this_root_for_a_bound_org() {
        let (api, _dir) = api("root");
        let other = map(1, json!([RELAY]), "n_11111111111111111111111111111111", json!([]));
        assert_eq!(pin(&api, other.clone()).unwrap_err().code, "root-mismatch");
        assert_eq!(pin(&api, standard_map(1)).unwrap_err().code, "not-bound");
        bind(&api, json!(["acme"]));
        assert_eq!(pin(&api, other).unwrap_err().code, "root-mismatch");
        pin(&api, standard_map(1)).unwrap();
        let r = api.pin_verified("acme", standard_map(2), &"b".repeat(64), &json!({"org": "acme"}), NOW).unwrap_err();
        assert_eq!((r.status, r.code.as_str()), (403, "signature"));
    }

    /// 2.4, R6-10: `api-orgs` without an org stops serving it at once, deletes its maps and journal, keeps its
    /// high-water marks; after a rebind an older map is refused `seq-not-higher` and the journal starts at the kept
    /// tseq.
    #[test]
    fn unbinding_drops_the_org_at_once_and_keeps_its_marks() {
        let (api, dir) = api("unbind");
        bind(&api, json!(["acme"]));
        pin(&api, standard_map(3)).unwrap();
        tighten(&api, 1, "grace_lower", json!({"kind": "app", "hours": 0})).unwrap();
        assert_eq!(api.api_heads(), json!({"acme": {"seq": 3, "tseq": 1}}));
        assert_eq!(code(api.check(&send(SPOKE, Some(Some("private"))), T)), "ok");
        bind(&api, json!([]));
        assert_eq!(api.api_heads(), json!({}));
        assert_eq!(code(api.check(&send(SPOKE, Some(Some("private"))), T)), "not-registered");
        assert!(!dir.join("api-maps").join("acme.json").exists() && !dir.join("api-journal").join("acme.json").exists());
        let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(ORGS_FILE)).unwrap()).unwrap();
        assert_eq!(file, json!({"orgs": [], "generation": 2, "retired": {"acme": {"seq": 3, "tseq": 1}}, "roots": {"acme": CA_PIN}}), "the root stays pinned");
        assert!(!actions(&api).is_empty(), "the audit chain is kept");
        // bound again: the kept marks, an older map refused, the next map pinned with the journal at the kept tseq
        bind(&api, json!(["acme"]));
        assert_eq!(api.api_heads(), json!({"acme": {"seq": 3, "tseq": 1}}));
        assert_eq!(pin(&api, standard_map(2)).unwrap_err().code, "seq-not-higher");
        assert_eq!(pin(&api, standard_map(3)).unwrap_err().code, "seq-not-higher");
        assert_eq!(pin(&api, standard_map(4)).unwrap()["tseq"], 1);
        assert_eq!(tighten(&api, 1, "client_suspend", json!(CLIENT)).unwrap_err().code, "tseq-gap");
        assert!(tighten(&api, 2, "client_suspend", json!(CLIENT)).is_ok());
        // a restart reads the same state
        drop(api);
        let again = SpokesApi::for_test(&dir, RELAY, ROOT, ROOT_SPKI);
        assert_eq!(again.api_heads(), json!({"acme": {"seq": 4, "tseq": 2}}));
    }

    /// 5.1, R6-10: a newer map that no longer lists this relay unbinds it (`unbound: true`); a map that never listed
    /// it is refused `not-bound`.
    #[test]
    fn a_newer_map_without_this_relay_unbinds_it() {
        let (api, dir) = api("dropped");
        bind(&api, json!(["acme"]));
        assert_eq!(pin(&api, map(1, json!(["r_22"]), ROOT, json!([]))).unwrap_err().code, "not-bound");
        assert_eq!(api.api_heads(), json!({"acme": {"seq": 0, "tseq": 0}}), "still bound");
        pin(&api, standard_map(1)).unwrap();
        assert_eq!(pin(&api, map(1, json!(["r_22"]), ROOT, json!([]))).unwrap_err().code, "conflict");
        assert_eq!(pin(&api, map(2, json!(["r_22"]), ROOT, json!([]))).unwrap(), json!({"ok": true, "unbound": true}));
        assert_eq!(api.api_heads(), json!({}));
        // the unbinding map's own seq is the kept mark, not the pinned map's
        let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(ORGS_FILE)).unwrap()).unwrap();
        assert_eq!(file["retired"], json!({"acme": {"seq": 2, "tseq": 0}}));
        // bound again: another map at the unbinding seq (listing this relay again) is no rollback of the removal
        bind(&api, json!(["acme"]));
        assert_eq!(pin(&api, standard_map(2)).unwrap_err().code, "seq-not-higher");
        assert_eq!(pin(&api, standard_map(3)).unwrap()["seq"], 3);
    }

    /// 5.3, 9.4: with the audit volume full an allowed request cannot be appended (the relay answers 503 and stores
    /// nothing); a refusal is still taken.
    #[test]
    fn a_full_audit_volume_fails_the_mail_closed() {
        let (api, _dir) = api("full");
        bind(&api, json!(["acme"]));
        pin(&api, standard_map(1)).unwrap();
        let a = api.check(&send(SPOKE, Some(Some("private"))), T).unwrap();
        api.api_audit().unwrap().set_free_space(Arc::new(|_: &Path| Some(0u64)));
        assert!(!api.mail(&a, HUB, Some(SPOKE), 120, T));
        assert_eq!(code(api.check(&send(OTHER, Some(Some("private"))), T)), "target");
        assert!(!actions(&api).iter().any(|(a, _)| a == "spokes.mail"));
    }

    /// 6.4: `spoke.offline` once when a spoke turns silent, `spoke.online` when it polls again (with its offline
    /// first when no tick saw it), into every bound org with a pinned map.
    #[test]
    fn spoke_offline_and_online_are_emitted_on_the_transitions() {
        let (api, _dir) = api("events");
        let row = SpokeSeen { node: SPOKE.into(), label: "build box".into(), last_poll_at: T - 25 * 3_600_000 };
        bind(&api, json!(["acme"]));
        pin(&api, standard_map(1)).unwrap();
        api.spokes_silent(std::slice::from_ref(&row));
        api.spokes_silent(std::slice::from_ref(&row));
        assert_eq!(events(&api), ["spoke.offline"]);
        api.spoke_polled(SPOKE, "build box", row.last_poll_at, T);
        assert_eq!(events(&api), ["spoke.offline", "spoke.online"]);
        api.spoke_polled(OTHER, "other", T - 25 * 3_600_000, T);
        assert_eq!(events(&api), ["spoke.offline", "spoke.online", "spoke.offline", "spoke.online"]);
    }

    #[test]
    fn api_orgs_takes_0_to_64_distinct_ids() {
        let (api, _dir) = api("orgs");
        for bad in [json!(["acme", "acme"]), json!(["Acme"]), json!([1]), json!("acme"), json!((0..65).map(|i| format!("o{i}")).collect::<Vec<_>>())] {
            assert_eq!(api.api_request("api-orgs", &json!({ "orgs": bad })).unwrap().unwrap_err().code, "bad-orgs", "{bad}");
        }
        bind(&api, json!(["beta", "acme"]));
        assert_eq!(api.bound_orgs(), ["acme", "beta"]);
        assert!(api.spokes());
        assert_eq!(api.api_request("api-sign-request", &json!({})).unwrap().unwrap_err().code, "fleet-op");
        for bad in [json!({"orgs": []}), json!({"orgs": [], "generation": 0}), json!({"orgs": [], "generation": "3"}), json!({"orgs": [], "generation": 9, "release_roots": ["acme", "acme"]})] {
            assert_eq!(api.api_request("api-orgs", &bad).unwrap().unwrap_err().code, "bad-orgs", "{bad}");
        }
    }

    /// 2.4 (R6-10): a replayed older `api-orgs` (its list from before an unbinding) is refused `stale-generation` and
    /// binds nothing again; the applied generation again changes nothing; the generation survives a restart.
    #[test]
    fn an_older_binding_generation_never_binds_an_org_again() {
        let (api, dir) = api("generation");
        let orgs = |list: Value, generation: u64| api.api_request("api-orgs", &json!({ "orgs": list, "generation": generation })).unwrap();
        assert_eq!(orgs(json!(["acme", "beta"]), 4), Ok(json!({"ok": true})));
        assert_eq!(orgs(json!(["beta"]), 5), Ok(json!({"ok": true})));
        let r = orgs(json!(["acme", "beta"]), 4).unwrap_err();
        assert_eq!((r.status, r.code.as_str()), (409, "stale-generation"));
        assert_eq!(api.bound_orgs(), ["beta"], "the replayed list did not bind acme again");
        // the applied generation again (the console's reconnect resend) is a no-op, even with another list
        assert_eq!(orgs(json!(["acme", "beta"]), 5), Ok(json!({"ok": true})));
        assert_eq!(api.bound_orgs(), ["beta"]);
        drop(api);
        let again = SpokesApi::for_test(&dir, RELAY, ROOT, ROOT_SPKI);
        assert_eq!(again.generation(), 5);
        assert_eq!(again.api_request("api-orgs", &json!({ "orgs": ["acme"], "generation": 3 })).unwrap().unwrap_err().code, "stale-generation");
        assert_eq!(again.bound_orgs(), ["beta"]);
    }

    /// Shared contract item 3: the Meet org CA root pinned at the first map stays pinned across an unbinding and a
    /// rebind, so a map under another root is still refused `signature`; only an `api-orgs` of a newer generation that
    /// releases the root lets the next map pin another one, and a replay of that release changes nothing.
    #[test]
    fn the_root_pin_survives_unbinding_until_a_newer_generation_releases_it() {
        let (api, _dir) = api("root-pin");
        let other_root = "b".repeat(64);
        let under = |vm: VerifiedApiMap, root: &str| api.pin_verified("acme", vm, root, &json!({"org": "acme"}), NOW);
        bind(&api, json!(["acme"]));
        under(standard_map(1), CA_PIN).unwrap();
        bind(&api, json!([]));
        bind(&api, json!(["acme"]));
        assert_eq!(under(standard_map(2), &other_root).unwrap_err().code, "signature", "the pin outlived the unbinding");
        // a release names the org; the next map pins the new root
        let generation = api.generation() + 1;
        assert_eq!(api.api_request("api-orgs", &json!({ "orgs": ["acme"], "generation": generation, "release_roots": ["acme"] })).unwrap(), Ok(json!({"ok": true})));
        assert_eq!(under(standard_map(2), &other_root).unwrap()["seq"], 2);
        // the same release again (a resend of the applied generation) does not drop the new pin
        assert_eq!(api.api_request("api-orgs", &json!({ "orgs": ["acme"], "generation": generation, "release_roots": ["acme"] })).unwrap(), Ok(json!({"ok": true})));
        assert_eq!(under(standard_map(3), CA_PIN).unwrap_err().code, "signature");
    }

    /// 6.1: a view of an org that is not bound is 404; a relay in the query that is not this one is 404.
    #[test]
    fn views_answer_only_bound_orgs_and_this_relay() {
        let (api, _dir) = api("views");
        assert_eq!(api.view("acme", "counts", "", false).unwrap_err().code, "not-found");
        bind(&api, json!(["acme"]));
        assert_eq!(api.view("acme", "counts", "relay=r_99", false).unwrap_err().code, "not-found");
        assert_eq!(api.view("acme", "models", "", false).unwrap_err().code, "invalid");
        assert_eq!(api.view("acme", "counts", "role=hub", false).unwrap_err().code, "invalid");
        assert_eq!(api.view("acme", "nodes", &"q=x&".repeat(200), false).unwrap_err().code, "invalid");
        assert_eq!(split_query("relay=r_21&role=hub&after=n_1&q=a"), (Some("r_21".into()), Some("n_1".into()), "role=hub&q=a".into()));
    }
}
