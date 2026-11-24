// Contract API-1 revision 5 (phase 1c), sections 2.5 and 2.6: the CE-1 member device of one API app, a port of
// Python `connector/lucid_connector/service_client.py` `MemberDevice` onto `ce_device` and `ce_device_log`.
//
// The device keeps its chat key bundle current (`POST /v1/chat/devices`), verifies the bundles and certificates of
// the people it reads and writes to (`GET /v1/chat/devices`), replays and verifies member logs incrementally
// (`GET /v1/chat/log`), opens the wraps addressed to it (`GET /v1/chat/keys`), opens and verifies envelopes, and
// plans epochs, wraps and seals what the app sends. The relay is never trusted for content: every log entry, wrap and
// envelope is verified here. Network calls go through `connector_session::AppRelay`; org policies through
// `Policies` (the session's verified pins). The whole state (keys, epoch keys, logs, bundles, cursors, rows waiting
// for a key) converts to one JSON value that the session seals as `chat-keys-<app>` (2.6); it is never written in
// clear.

use crate::ce_device::{self as ce, CeCert, CeError, CeResult, DckKey, DeviceKey, Head, OpenedMessage, Pd, Revocation, VerifiedBundle, Verifier};
use crate::ce_device_log::{self as cl, KeyStore, LogState, PolicyView, SenderKeys};
use crate::connector_session::{get_json, post_json, AppRelay};
use crate::meet::{log_error, log_info, log_warn};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// A principal's verified devices are asked again after this long.
pub const DIRECTORY_TTL_MS: i64 = 600_000;
pub const KEYS_PAGE: usize = 500;
pub const DEVICES_PAGE: usize = 200;
pub const LOG_PAGE: usize = 500;
/// Rows kept while their key or member log has not arrived (the oldest go first).
pub const PENDING_MAX: usize = 500;
/// Refusals that mean "not yet": the row is kept and tried again when keys or logs arrive.
pub const WAIT_CODES: [&str; 4] = ["no_key", "head_ahead", "revocation_unknown", "policy_unknown"];
pub const NOT_IN_CONVERSATION: &str = "this app is not a member of that conversation";
pub const NOT_IN_DM: &str = "this app is not in that direct message";
pub const NO_ROOM_CHAT: &str = "API apps never post in call chat or AI history";
pub const REVOKED: &str = "this app's certificate is revoked; nothing is sent";
/// The relay's refusal of a second message with an id it keeps (Rust and Python relays, CE-1 `ce_post`).
pub const ID_KEPT: &str = "a message with that id is already kept";

/// The org policies the device judges logs and DM device sets by (the session's verified pins).
pub trait Policies {
    /// Every verified policy by hash and the pinned one per org, at `now_ms`.
    fn view(&self, now_ms: i64) -> PolicyView;
    /// Fetch (`GET /v1/org/policy?sha256=`) and verify a policy a log entry or wrap names.
    fn fetch_by_hash(&self, relay: &dyn AppRelay, sha256: &str, now_ms: i64);
}

/// The app's certificate and key as the device uses them.
#[derive(Clone)]
pub struct DeviceId {
    pub principal: String,
    pub device: String,
    pub serial: String,
    pub cert_pem: String,
    pub chain_pem: String,
    pub key: Arc<DeviceKey>,
}

impl std::fmt::Debug for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceId").field("principal", &self.principal).field("device", &self.device).field("serial", &self.serial).finish_non_exhaustive()
    }
}

impl DeviceId {
    /// From the certificate (leaf PEM), its chain and the certificate's key.
    pub fn new(key: DeviceKey, cert_pem: &str, chain_pem: &str) -> Result<DeviceId, String> {
        let cert = CeCert::from_pem(cert_pem).map_err(|e| e.to_string())?;
        let (principal, device) = (cert.principal(), cert.device_id());
        ce::check_principal(&principal).map_err(|e| e.to_string())?;
        ce::check_device(&device).map_err(|e| e.to_string())?;
        Ok(DeviceId { principal, device, serial: cert.serial_hex().to_string(), cert_pem: cert_pem.to_string(), chain_pem: chain_pem.to_string(), key: Arc::new(key) })
    }

    pub fn cert(&self) -> Option<CeCert> {
        CeCert::from_pem(&self.cert_pem).ok()
    }
}

/// True when a revocation list from the certificate's issuer lists it as revoked at `now_ms`.
pub fn revoked_now(rev: Option<&Revocation>, cert: &CeCert, now_ms: i64) -> bool {
    rev.is_some_and(|r| r.crls.iter().any(|(who, list)| who.x.subject == cert.x.issuer && list.revoked_from(cert.serial_hex()).is_some_and(|from| from.saturating_mul(1000) <= now_ms)))
}

/// What opening a row gave.
#[derive(Debug)]
pub enum Opened {
    /// Verified: signature, head, sender a member at that head.
    Message(OpenedMessage),
    /// Not yet (one of `WAIT_CODES`): keep the row and try again.
    Waiting(String),
    /// Refused for good (counted as withheld, never stored).
    Refused(CeError),
}

/// A row waiting for its key or member log.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub cid: String,
    pub row: Value,
    pub author: String,
}

#[derive(Clone, Debug, Default)]
struct DirEntry {
    at_ms: i64,
    ok: BTreeMap<String, VerifiedBundle>,
}

fn lower(s: &str) -> String {
    s.trim().to_lowercase()
}

fn str_at<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// A relay row's reference field: a message id, or `{id}`.
fn row_ref(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
        _ => String::new(),
    }
}

/// One API app's CE-1 member device.
pub struct MemberDevice {
    pub id: DeviceId,
    ca: Option<CeCert>,
    pub verifier: Verifier,
    pub keys: KeyStore,
    pub sender: SenderKeys,
    logs: BTreeMap<String, LogState>,
    pairs: BTreeMap<String, Vec<String>>,
    dir: BTreeMap<String, DirEntry>,
    certs: BTreeMap<Pd, Vec<(String, String)>>,
    bundle: Option<Value>,
    /// `GET /v1/chat/keys` cursor (the last wrap `seq` taken).
    pub wraps_cursor: i64,
    /// `GET /v1/apps/c/events` cursor (the last event `seq` applied).
    pub events_cursor: i64,
    pub pending: Vec<Pending>,
    /// Per conversation, the relay time (s) of the newest history row taken.
    pub synced: BTreeMap<String, f64>,
    /// Channel names as the relay shows them (R0 metadata, for pickers and counts only).
    pub names: BTreeMap<String, String>,
    /// The time of the last completed sync with the relay (ms).
    pub last_sync: i64,
    /// This app's certificate is revoked by a verified list.
    pub revoked: bool,
    changes: Vec<(String, bool)>,
}

impl MemberDevice {
    /// A new device: no keys, no logs. `require_crl` refuses signatures without a fresh revocation list.
    pub fn new(id: DeviceId, ca_pem: &str, require_crl: bool) -> Result<MemberDevice, String> {
        let sender = SenderKeys::new(&id.principal, &id.device).map_err(|e| e.to_string())?;
        Ok(MemberDevice {
            ca: CeCert::from_pem(ca_pem).ok(),
            verifier: Verifier::new(ca_pem, None, require_crl),
            keys: KeyStore::new(),
            sender,
            logs: BTreeMap::new(),
            pairs: BTreeMap::new(),
            dir: BTreeMap::new(),
            certs: BTreeMap::new(),
            bundle: None,
            wraps_cursor: 0,
            events_cursor: 0,
            pending: Vec::new(),
            synced: BTreeMap::new(),
            names: BTreeMap::new(),
            last_sync: 0,
            revoked: false,
            changes: Vec::new(),
            id,
        })
    }

    /// The device from its unsealed state (`to_value`). A kept member log that no longer reads is dropped and
    /// replayed from the relay.
    pub fn load(id: DeviceId, ca_pem: &str, require_crl: bool, data: &Value) -> Result<MemberDevice, String> {
        let mut d = MemberDevice::new(id, ca_pem, require_crl)?;
        if let Some(k) = data.get("keys").filter(|k| k.is_object()) {
            d.keys = KeyStore::from_value(k).map_err(|e| format!("the sealed chat keys do not read ({e})"))?;
        }
        if let Some(s) = data.get("sender").filter(|s| s.is_object()) {
            d.sender = SenderKeys::from_value(s, &d.id.principal, &d.id.device).map_err(|e| format!("the sealed sender keys do not read ({e})"))?;
        }
        let st = data.get("state").cloned().unwrap_or(Value::Null);
        d.bundle = st.get("bundle").filter(|b| b.is_object()).cloned();
        for (cid, v) in st.get("logs").and_then(Value::as_object).into_iter().flatten() {
            match LogState::from_value(cid, v) {
                Ok(l) => {
                    d.logs.insert(cid.clone(), l);
                }
                Err(e) => log_warn(&format!("connector_log_unreadable cid={cid} code={}", e.code)),
            }
        }
        for (cid, v) in st.get("pairs").and_then(Value::as_object).into_iter().flatten() {
            let pair: Vec<String> = v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            if pair.len() == 2 {
                d.pairs.insert(cid.clone(), pair);
            }
        }
        d.wraps_cursor = st.get("wraps_cursor").and_then(Value::as_i64).unwrap_or(0);
        d.events_cursor = st.get("events_cursor").and_then(Value::as_i64).unwrap_or(0);
        d.last_sync = st.get("last_sync").and_then(Value::as_i64).unwrap_or(0);
        for p in st.get("pending").and_then(Value::as_array).into_iter().flatten() {
            d.pending.push(Pending { cid: str_at(p, "cid").to_string(), row: p.get("row").cloned().unwrap_or(Value::Null), author: str_at(p, "author").to_string() });
        }
        for (cid, v) in st.get("synced").and_then(Value::as_object).into_iter().flatten() {
            if let Some(ts) = v.as_f64() {
                d.synced.insert(cid.clone(), ts);
            }
        }
        for c in st.get("changes").and_then(Value::as_array).into_iter().flatten() {
            if let (Some(cid), Some(member)) = (c.get(0).and_then(Value::as_str), c.get(1).and_then(Value::as_bool)) {
                d.changes.push((cid.to_string(), member));
            }
        }
        for (cid, v) in st.get("names").and_then(Value::as_object).into_iter().flatten() {
            if let Some(n) = v.as_str() {
                d.names.insert(cid.clone(), n.to_string());
            }
        }
        Ok(d)
    }

    /// Everything to seal (2.6).
    pub fn to_value(&self) -> Value {
        let logs: Map<String, Value> = self.logs.iter().map(|(c, l)| (c.clone(), l.to_value())).collect();
        let pairs: Map<String, Value> = self.pairs.iter().map(|(c, p)| (c.clone(), json!(p))).collect();
        let pending: Vec<Value> = self.pending.iter().map(|p| json!({"cid": p.cid, "row": p.row, "author": p.author})).collect();
        let changes: Vec<Value> = self.changes.iter().map(|(cid, member)| json!([cid, member])).collect();
        json!({
            "keys": self.keys.to_value(),
            "sender": self.sender.to_value(),
            "state": {
                "bundle": self.bundle, "logs": logs, "pairs": pairs, "wraps_cursor": self.wraps_cursor,
                "events_cursor": self.events_cursor, "last_sync": self.last_sync, "pending": pending,
                "synced": self.synced, "names": self.names, "changes": changes,
            },
        })
    }

    /// A renewed certificate and key (same principal and device): a new bundle follows (`bundle_due`).
    pub fn set_id(&mut self, id: DeviceId) -> Result<(), String> {
        if id.principal != self.id.principal || id.device != self.id.device {
            return Err("the renewed certificate names another service".to_string());
        }
        self.id = id;
        Ok(())
    }

    pub fn set_revocation(&mut self, rev: Option<Revocation>) {
        self.verifier.revocation = rev;
    }

    // ── certificates and bundles ────────────────────────────────────────────────────────────────────────────

    fn note_cert(&mut self, principal: &str, device: &str, pem: &str, chain: &str) {
        let pair = (pem.to_string(), chain.to_string());
        let certs = self.certs.entry((principal.to_string(), device.to_string())).or_default();
        if !certs.contains(&pair) {
            certs.insert(0, pair);
        }
    }

    /// The certificates (and chains) held for a device, this device's own first.
    pub fn certs_for(&self, principal: &str, device: &str) -> Vec<(String, String)> {
        let mut out = self.certs.get(&(principal.to_string(), device.to_string())).cloned().unwrap_or_default();
        if principal == self.id.principal && device == self.id.device {
            let mine = (self.id.cert_pem.clone(), self.id.chain_pem.clone());
            if !out.contains(&mine) {
                out.insert(0, mine);
            }
        }
        out
    }

    fn check_bundle(&self, bundle: &Value, principal: &str, now_ms: i64) -> CeResult<VerifiedBundle> {
        let vb = ce::verify_bundle(bundle, &self.verifier, now_ms.div_euclid(1000), None, None)?;
        if vb.principal != principal {
            return ce::fail("rules", "the bundle names another principal");
        }
        let Some(ca) = self.ca.as_ref() else { return ce::fail("certificate", "unreadable certificate") };
        let cert = ce::check_cert(&vb.cert_pem, ca, &vb.chain_pem, principal, now_ms)?;
        if revoked_now(self.verifier.revocation.as_ref(), &cert, now_ms) {
            return ce::fail("revoked", "the certificate is revoked");
        }
        Ok(vb)
    }

    /// Every principal's device bundles (`GET /v1/chat/devices?p=`), each verified here and its certificate checked
    /// now (valid, not revoked); asked again after `DIRECTORY_TTL_MS` or with `force`.
    pub fn bundles(&mut self, relay: &dyn AppRelay, principals: &[String], force: bool, now_ms: i64) {
        let wanted: BTreeSet<String> = principals.iter().map(|p| lower(p)).filter(|p| !p.is_empty() && *p != self.id.principal).collect();
        let need: Vec<String> = wanted.into_iter().filter(|p| force || self.dir.get(p).map_or(true, |e| now_ms - e.at_ms > DIRECTORY_TTL_MS)).collect();
        for batch in need.chunks(DEVICES_PAGE) {
            let got = match get_json(relay, "/v1/chat/devices", &[("p", batch.join(","))]) {
                Ok(v) => v,
                Err(e) => {
                    log_info(&format!("connector_devices_not_fetched status={}", e.status));
                    return;
                }
            };
            let mut fresh: BTreeMap<String, DirEntry> = batch.iter().map(|p| (p.clone(), DirEntry { at_ms: now_ms, ok: BTreeMap::new() })).collect();
            for bundle in got.get("devices").and_then(Value::as_array).into_iter().flatten() {
                let principal = lower(str_at(bundle, "principal"));
                let device = str_at(bundle, "device").to_string();
                if device.is_empty() || !fresh.contains_key(&principal) {
                    continue;
                }
                let pem = str_at(bundle, "cert");
                if !pem.trim().is_empty() {
                    self.note_cert(&principal, &device, pem, str_at(bundle, "chain"));
                }
                match self.check_bundle(bundle, &principal, now_ms) {
                    Ok(vb) => {
                        if let Some(entry) = fresh.get_mut(&principal) {
                            if entry.ok.get(&device).map_or(true, |old| vb.created > old.created) {
                                entry.ok.insert(device, vb);
                            }
                        }
                    }
                    Err(e) => log_info(&format!("connector_bundle_refused code={}", e.code)),
                }
            }
            self.dir.extend(fresh);
        }
    }

    pub fn forget_devices(&mut self, principal: &str) {
        self.dir.remove(&lower(principal));
    }

    /// This device's newest bundle.
    pub fn my_bundle(&self) -> Option<VerifiedBundle> {
        self.keys.my_bundles().into_iter().map(|(vb, _)| vb).filter(|vb| vb.device == self.id.device).max_by_key(|vb| vb.created)
    }

    /// The verified, unexpired devices of `principals` (this device's own bundle when it is among them).
    pub fn devices_of(&self, principals: &[String], now_ms: i64) -> BTreeMap<Pd, VerifiedBundle> {
        let mut out = BTreeMap::new();
        for p in principals {
            for (d, vb) in self.dir.get(p).map(|e| &e.ok).into_iter().flatten() {
                if vb.expires.saturating_mul(1000) > now_ms {
                    out.insert((p.clone(), d.clone()), vb.clone());
                }
            }
        }
        if principals.contains(&self.id.principal) {
            if let Some(mine) = self.my_bundle() {
                out.insert((self.id.principal.clone(), self.id.device.clone()), mine);
            }
        }
        out
    }

    /// A new chat key bundle when none is current, every 30 days and after a renewal (CE-1 4). True when one was
    /// made: the caller seals the state, then posts `bundle()` (`POST /v1/chat/devices`).
    pub fn ensure_bundle(&mut self, now_ms: i64) -> Result<bool, String> {
        let now_s = now_ms.div_euclid(1000);
        if self.bundle.is_some() && !ce::bundle_due(self.my_bundle().as_ref(), &self.id.serial, now_s) {
            return Ok(false);
        }
        let dck = DckKey::generate().map_err(|e| e.to_string())?;
        let bundle = ce::make_bundle(&self.id.key, &self.id.cert_pem, &self.id.chain_pem, &dck, now_s, None).map_err(|e| e.to_string())?;
        let vb = VerifiedBundle::from_value(&bundle).map_err(|e| e.to_string())?;
        self.keys.add_dck(dck, vb).map_err(|e| e.to_string())?;
        self.bundle = Some(bundle);
        Ok(true)
    }

    pub fn bundle(&self) -> Option<&Value> {
        self.bundle.as_ref()
    }

    // ── DM pairs ────────────────────────────────────────────────────────────────────────────────────────────

    /// The DM cid of two principals, remembered (the cid is a hash).
    pub fn note_pair(&mut self, a: &str, b: &str) -> CeResult<String> {
        let (a, b) = (lower(a), lower(b));
        let cid = ce::dm_cid(&a, &b)?;
        let mut pair = vec![a, b];
        pair.sort();
        self.pairs.insert(cid.clone(), pair);
        Ok(cid)
    }

    pub fn pair(&self, cid: &str) -> Vec<String> {
        self.pairs.get(cid).cloned().unwrap_or_default()
    }

    /// The other principal of this app's DM, "" when it is not one.
    pub fn dm_other(&self, cid: &str) -> String {
        let pair = self.pair(cid);
        if pair.len() != 2 || !pair.contains(&self.id.principal) {
            return String::new();
        }
        pair.into_iter().find(|p| *p != self.id.principal).unwrap_or_default()
    }

    /// Every DM of this app with the other principal.
    pub fn dms(&self) -> Vec<(String, String)> {
        self.pairs.keys().map(|cid| (cid.clone(), self.dm_other(cid))).filter(|(_, o)| !o.is_empty()).collect()
    }

    // ── member logs (CE-1 7.2) ──────────────────────────────────────────────────────────────────────────────

    pub fn log(&self, cid: &str) -> Option<&LogState> {
        self.logs.get(cid)
    }

    /// The `ch:` cids whose verified log names this app a current member.
    pub fn member_cids(&self) -> Vec<String> {
        self.logs.iter().filter(|(_, l)| l.members.contains(&self.id.principal)).map(|(c, _)| c.clone()).collect()
    }

    /// Every `ch:` cid with a verified log here.
    pub fn log_cids(&self) -> Vec<String> {
        self.logs.keys().cloned().collect()
    }

    fn is_member_now(&self, cid: &str) -> bool {
        self.logs.get(cid).is_some_and(|l| l.members.contains(&self.id.principal))
    }

    /// Membership changes of this app since the last call: `(cid, now a member)`.
    pub fn drain_changes(&mut self) -> Vec<(String, bool)> {
        std::mem::take(&mut self.changes)
    }

    /// Changes whose store mark could not be written, put back in front of any newer ones (sealed with the state,
    /// so they are applied again after a restart).
    pub fn requeue_changes(&mut self, first: Vec<(String, bool)>) {
        let later = std::mem::replace(&mut self.changes, first);
        self.changes.extend(later);
    }

    /// Entries the relay served: replayed from seq 1 or extended past the verified head. A fork or rollback is
    /// refused and the verified log kept. Err is a wait code (`revocation_unknown`).
    pub fn take_log(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, cid: &str, entries: &[Value], complete: bool, now_ms: i64) -> Result<(), String> {
        let bys: Vec<String> = entries.iter().filter_map(|e| e.get("by").and_then(Value::as_str)).map(lower).collect();
        self.bundles(relay, &bys, false, now_ms);
        for attempt in 0..3 {
            let view = pol.view(now_ms);
            let result = {
                let certs_for = |p: &str, d: &str| self.certs_for(p, d);
                match self.logs.get(cid) {
                    None => {
                        if entries.is_empty() {
                            return Ok(());
                        }
                        cl::replay_log(cid, entries, &certs_for, &self.verifier, now_ms, None, Some(&view))
                    }
                    Some(cur) => {
                        let mut served: Vec<Value> = entries.iter().filter(|e| e.get("seq").and_then(ce::int_of).is_some()).cloned().collect();
                        served.sort_by_key(|e| e.get("seq").and_then(ce::int_of).unwrap_or(0));
                        let last = served.last().and_then(|e| e.get("seq")).and_then(ce::int_of);
                        if complete && last.is_some_and(|s| s < cur.head.seq) {
                            log_error(&format!("connector_log_shorter cid={cid}"));
                            return Ok(());
                        }
                        if served.is_empty() {
                            return Ok(());
                        }
                        cl::extend_log(cur, &served, &certs_for, &self.verifier, now_ms, Some(&view), 0)
                    }
                }
            };
            match result {
                Ok(got) => {
                    let was = self.is_member_now(cid);
                    let now = got.members.contains(&self.id.principal);
                    self.logs.insert(cid.to_string(), got);
                    if was != now {
                        self.changes.push((cid.to_string(), now));
                    }
                    return Ok(());
                }
                Err(e) if e.code == "log_refused" => {
                    log_error(&format!("connector_log_refused cid={cid}"));
                    return Ok(());
                }
                Err(e) if e.code == "policy_unknown" && attempt < 2 => {
                    for h in entries.iter().filter_map(|e| e.get("policy").and_then(Value::as_str)) {
                        if view.get(h).is_none() {
                            pol.fetch_by_hash(relay, h, now_ms);
                        }
                    }
                }
                Err(e) if WAIT_CODES.contains(&e.code) => return Err(e.code.to_string()),
                Err(e) => {
                    log_warn(&format!("connector_log_entries_refused cid={cid} code={}", e.code));
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// The entries after the verified head (`GET /v1/chat/log`), verified. Err is a wait code.
    pub fn refresh_log(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, cid: &str, now_ms: i64) -> Result<(), String> {
        let complete = !self.logs.contains_key(cid);
        let mut after = self.logs.get(cid).map_or(0, |l| l.head.seq);
        let mut entries: Vec<Value> = Vec::new();
        loop {
            let got = match get_json(relay, "/v1/chat/log", &[("cid", cid.to_string()), ("after", after.to_string()), ("limit", LOG_PAGE.to_string())]) {
                Ok(v) => v,
                Err(e) => {
                    log_info(&format!("connector_log_not_fetched cid={cid} status={}", e.status));
                    return Ok(());
                }
            };
            let batch: Vec<Value> = got.get("entries").and_then(Value::as_array).into_iter().flatten().filter(|e| e.is_object()).cloned().collect();
            let top = batch.iter().filter_map(|e| e.get("seq").and_then(ce::int_of)).max();
            let n = batch.len();
            entries.extend(batch);
            match top {
                Some(s) if n >= LOG_PAGE => after = s,
                _ => break,
            }
        }
        self.take_log(relay, pol, cid, &entries, complete, now_ms)
    }

    /// The members of `cid` by this device's verification: a DM's pair, a channel's log (at `head` when it names
    /// one this log holds).
    pub fn members(&self, cid: &str, head: Option<&Head>) -> BTreeSet<String> {
        match ce::cid_kind(cid) {
            Ok("dm") => self.pair(cid).into_iter().collect(),
            Ok("ch") => match self.logs.get(cid) {
                None => BTreeSet::new(),
                Some(l) => match head {
                    Some(h) if h.seq > 0 && l.has_head(h) => l.members_at(h.seq),
                    _ => l.members.clone(),
                },
            },
            _ => BTreeSet::new(),
        }
    }

    // ── wraps (CE-1 5) ──────────────────────────────────────────────────────────────────────────────────────

    /// Fetch what judging a wrap's device set needs (its log, the members' and archives' bundles) before opening it.
    fn prepare_wrap(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, wrap: &Value, now_ms: i64) -> Result<(), String> {
        let cid = str_at(wrap, "cid").to_string();
        let hint = lower(wrap.get("from").map(|f| str_at(f, "principal")).unwrap_or_default());
        match ce::cid_kind(&cid) {
            Ok("dm") => {
                if self.pair(&cid).is_empty() && !hint.is_empty() && hint != self.id.principal && ce::dm_cid(&self.id.principal, &hint).is_ok_and(|c| c == cid) {
                    let me = self.id.principal.clone();
                    self.note_pair(&me, &hint).map_err(|e| e.to_string())?;
                }
                let pair = self.pair(&cid);
                if pair.is_empty() {
                    return Ok(());
                }
                self.bundles(relay, &pair, false, now_ms);
                let pols: Vec<String> = wrap.get("pols").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                let mut view = pol.view(now_ms);
                for h in &pols {
                    if view.get(h).is_none() {
                        pol.fetch_by_hash(relay, h, now_ms);
                        view = pol.view(now_ms);
                    }
                }
                let archives: Vec<String> = cl::dm_archives(&pair, &pols, &view).unwrap_or_default().into_iter().map(|(p, _)| p).collect();
                self.bundles(relay, &archives, false, now_ms);
            }
            Ok("ch") => {
                let seq = wrap.get("log_seq").and_then(ce::int_of).unwrap_or(0);
                if self.logs.get(&cid).map_or(true, |l| l.head.seq < seq) {
                    self.refresh_log(relay, pol, &cid, now_ms)?;
                }
                if let Some(l) = self.logs.get(&cid) {
                    let members: Vec<String> = l.members_at(seq).into_iter().collect();
                    self.bundles(relay, &members, false, now_ms);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The device set this device verifies for a wrap (`open_wrap`'s `members_for`), from what `prepare_wrap` fetched.
    fn wrap_members(&self, view: &PolicyView, cid: &str, head: &Head, pols: &[String], now_ms: i64) -> CeResult<Option<Vec<Pd>>> {
        match ce::cid_kind(cid)? {
            "dm" => {
                let pair = self.pair(cid);
                if pair.is_empty() {
                    return Ok(None);
                }
                let mut devices: BTreeSet<Pd> = self.devices_of(&pair, now_ms).into_keys().collect();
                for (p, d) in cl::dm_archives(&pair, pols, view)? {
                    if self.dir.get(&p).is_some_and(|e| e.ok.contains_key(&d)) {
                        devices.insert((p, d));
                    }
                }
                Ok(Some(devices.into_iter().collect()))
            }
            "ch" => match self.logs.get(cid).filter(|l| l.has_head(head)) {
                None => Ok(None),
                Some(l) => {
                    let principals: Vec<String> = l.members_at(head.seq).into_iter().collect();
                    Ok(Some(self.devices_of(&principals, now_ms).into_keys().collect()))
                }
            },
            _ => Ok(None),
        }
    }

    fn open_one_wrap(&mut self, wrap: &Value, view: &PolicyView, now_ms: i64) -> CeResult<bool> {
        if wrap.get("share").is_some_and(|s| s.as_bool() == Some(true)) {
            log_info("connector_share_refused (a history share to a service)");
            return Ok(false);
        }
        let observed = wrap.get("rts").and_then(ce::int_of).unwrap_or(now_ms);
        let got = {
            let certs_for = |p: &str, d: &str| self.certs_for(p, d);
            let members_for = |cid: &str, head: &Head, pols: &[String]| self.wrap_members(view, cid, head, pols, now_ms);
            let mine = self.keys.my_bundles();
            ce::open_wrap(wrap, &self.id.principal, &self.id.device, &mine, &certs_for, &self.verifier, observed, &members_for)?
        };
        self.keys.put_key(&got.cid, &got.from_p, &got.from_d, got.epoch, &got.key, now_ms)?;
        if !got.members_ok {
            log_warn(&format!("connector_wrap_members_unverified cid={}", got.cid));
        }
        Ok(true)
    }

    /// Every wrap for this device (`GET /v1/chat/keys`); true when a key opened. Stops (keeping the cursor) at a
    /// wrap that waits for a fresh revocation list.
    pub fn fetch_wraps(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, now_ms: i64) -> bool {
        let mut opened = false;
        loop {
            let got = match get_json(relay, "/v1/chat/keys", &[("after", self.wraps_cursor.to_string()), ("limit", KEYS_PAGE.to_string())]) {
                Ok(v) => v,
                Err(e) => {
                    log_info(&format!("connector_wraps_not_fetched status={}", e.status));
                    return opened;
                }
            };
            let wraps: Vec<Value> = got.get("wraps").and_then(Value::as_array).into_iter().flatten().filter(|w| w.is_object()).cloned().collect();
            let senders: Vec<String> = wraps.iter().filter_map(|w| w.get("from").map(|f| str_at(f, "principal").to_string())).collect();
            self.bundles(relay, &senders, false, now_ms);
            for wrap in &wraps {
                if let Err(code) = self.prepare_wrap(relay, pol, wrap, now_ms) {
                    log_info(&format!("connector_wrap_waiting code={code}"));
                    return opened;
                }
                let view = pol.view(now_ms);
                match self.open_one_wrap(wrap, &view, now_ms) {
                    Ok(o) => opened = opened || o,
                    Err(e) if e.code == "revocation_unknown" => return opened,
                    Err(e) => log_info(&format!("connector_wrap_refused code={}", e.code)),
                }
                if let Some(seq) = wrap.get("seq").and_then(ce::int_of) {
                    self.wraps_cursor = self.wraps_cursor.max(seq);
                }
            }
            if wraps.len() < KEYS_PAGE {
                return opened;
            }
        }
    }

    // ── receiving (CE-1 6) ──────────────────────────────────────────────────────────────────────────────────

    /// A relay row's (or event's) envelope, opened and verified, its sender a member at the head it names. `live`
    /// rows close to now are judged at now, others at the relay's receive time `rts`.
    pub fn open(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, cid: &str, row: &Value, author: &str, live: bool, now_ms: i64) -> Opened {
        let Some(env) = row.get("enc").filter(|e| e.is_object()) else { return Opened::Refused(CeError::new("encoding", "not an encrypted row")) };
        let author = lower(author);
        let mid = str_at(row, "id").to_string();
        self.bundles(relay, std::slice::from_ref(&author), false, now_ms);
        if self.certs_for(&author, str_at(env, "d")).is_empty() {
            return Opened::Waiting("no_key".to_string());
        }
        let rowref = json!({"thread": row_ref(row.get("thread")), "reply_to": row_ref(row.get("reply_to")), "also_channel": row.get("also_channel").and_then(Value::as_bool).unwrap_or(false)});
        let observed = match row.get("rts").and_then(ce::int_of) {
            Some(rts) if !(live && (now_ms - rts).abs() <= ce::SKEW_MS) => rts,
            _ => now_ms,
        };
        let is_ch = ce::cid_kind(cid).ok() == Some("ch");
        let mut opened = None;
        for attempt in 0..2 {
            let r = {
                let key_for = |c: &str, p: &str, d: &str, e: i64| self.keys.get_key(c, p, d, e);
                let certs_for = |p: &str, d: &str| self.certs_for(p, d);
                let log = if is_ch { self.logs.get(cid) } else { None };
                ce::open_envelope(env, cid, &mid, &author, Some(&rowref), &key_for, &certs_for, &self.verifier, observed, log)
            };
            match r {
                Ok(m) => {
                    opened = Some(m);
                    break;
                }
                Err(e) if e.code == "head_ahead" && is_ch && attempt == 0 => {
                    if let Err(code) = self.refresh_log(relay, pol, cid, now_ms) {
                        return Opened::Waiting(code);
                    }
                }
                Err(e) if WAIT_CODES.contains(&e.code) => return Opened::Waiting(e.code.to_string()),
                Err(e) => return Opened::Refused(e),
            }
        }
        let Some(msg) = opened else { return Opened::Waiting("head_ahead".to_string()) };
        if !self.members(cid, Some(&msg.head)).contains(&msg.from_p) {
            return Opened::Refused(CeError::new("rules", "the sender is not a member"));
        }
        if let Err(e) = self.keys.note_message(cid, &msg.from_p, &msg.from_d, msg.epoch, msg.counter, &msg.mid, msg.s, &msg.kind) {
            return Opened::Refused(e);
        }
        Opened::Message(msg)
    }

    /// Keep a row that cannot open yet (the oldest go past `PENDING_MAX`).
    pub fn push_pending(&mut self, cid: &str, row: &Value, author: &str) {
        if self.pending.iter().any(|p| p.cid == cid && p.row.get("id") == row.get("id") && p.row.get("enc") == row.get("enc")) {
            return;
        }
        self.pending.push(Pending { cid: cid.to_string(), row: row.clone(), author: author.to_string() });
        if self.pending.len() > PENDING_MAX {
            let cut = self.pending.len() - PENDING_MAX;
            self.pending.drain(..cut);
        }
    }

    pub fn take_pending(&mut self) -> Vec<Pending> {
        std::mem::take(&mut self.pending)
    }

    // ── sending (CE-1 5 and 6) ──────────────────────────────────────────────────────────────────────────────

    /// The verified device set to send to in `cid` and, for a DM, the `pols` of its wraps (CE-1 7.1: both
    /// principals' devices plus the archive devices of the in-force policies covering either).
    fn send_set(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, cid: &str, now_ms: i64) -> Result<(BTreeMap<Pd, VerifiedBundle>, Option<Vec<String>>), String> {
        match ce::cid_kind(cid).map_err(|e| e.to_string())? {
            "dm" => {
                let pair = self.pair(cid);
                if pair.len() != 2 || !pair.contains(&self.id.principal) {
                    return Err(NOT_IN_DM.to_string());
                }
                self.bundles(relay, &pair, false, now_ms);
                let mut devices = self.devices_of(&pair, now_ms);
                let view = pol.view(now_ms);
                let pols = cl::dm_policy_hashes(&pair, &view);
                for (p, d) in cl::dm_archives(&pair, &pols, &view).map_err(|e| e.to_string())? {
                    self.bundles(relay, std::slice::from_ref(&p), false, now_ms);
                    match self.dir.get(&p).and_then(|e| e.ok.get(&d)).filter(|vb| self.service_ok(&(p.clone(), d.clone()), vb, &view, cid)) {
                        Some(vb) => {
                            devices.insert((p, d), vb.clone());
                        }
                        None => {
                            let org = view.service_org(&p);
                            return Err(format!("Waiting for {}'s archive.", view.label(&org)));
                        }
                    }
                }
                Ok((devices, Some(pols)))
            }
            "ch" => {
                self.refresh_log(relay, pol, cid, now_ms).map_err(|code| format!("{} ({code})", ce::TEXT_MEMBER_LIST_NOT_VERIFIED))?;
                let Some(l) = self.logs.get(cid) else { return Err(ce::TEXT_MEMBER_LIST_NOT_VERIFIED.to_string()) };
                if !l.members.contains(&self.id.principal) {
                    return Err(NOT_IN_CONVERSATION.to_string());
                }
                let principals: Vec<String> = l.members.iter().cloned().collect();
                self.bundles(relay, &principals, false, now_ms);
                let view = pol.view(now_ms);
                let mut devices = self.devices_of(&principals, now_ms);
                devices.retain(|pd, vb| self.service_ok(pd, vb, &view, cid));
                Ok((devices, None))
            }
            _ => Err(NO_ROOM_CHAT.to_string()),
        }
    }

    /// r5 2.5, PC-1 1 (CE-1 via PC-1): a service member's device gets a wrap only when its org's in-force policy names
    /// that device and its certificate's kind and org match the policy's entry (`ce_device_log::service_reader`,
    /// `service_device_ok`, as the Hub's `_pc_service_ok`). People's devices always pass, and so does this app's own
    /// device (the session judges it against the policy, `PolicyState`). A refused device is logged, like a refused
    /// bundle.
    fn service_ok(&self, (p, d): &Pd, vb: &VerifiedBundle, view: &PolicyView, cid: &str) -> bool {
        if (*p == self.id.principal && *d == self.id.device) || ce::principal_kind(p).ok() == Some("person") {
            return true;
        }
        let ok = cl::service_reader(p, view, false).is_ok_and(|reader| CeCert::from_pem(&vb.cert_pem).is_ok_and(|cert| cl::service_device_ok(&reader, d, &cert)));
        if !ok {
            log_info(&format!("connector_service_device_refused cid={cid} principal={p} device={d}"));
        }
        ok
    }

    /// Seal one envelope (planning the epoch and wrapping its key to the current verified members first) and post it
    /// to the DM or channel `cid`. `save` seals the state after the counter is taken and before anything leaves.
    /// Ok is the message id, the relay's answer and the message as sent (for the content store). `fixed_mid` sends
    /// under a message id chosen (and sealed) before, so a retry is the same message: when the relay already keeps
    /// one with that id (409, CE-1 ids are unique per conversation) the answer is Err(`ID_KEPT`).
    #[allow(clippy::too_many_arguments)]
    pub fn send(&mut self, relay: &dyn AppRelay, pol: &dyn Policies, cid: &str, kind: &str, ref_: &str, payload: Value, t: &str, fixed_mid: Option<&str>, now_ms: i64, save: &mut dyn FnMut(&MemberDevice) -> Result<(), String>) -> Result<(String, Value, OpenedMessage), String> {
        if self.revoked {
            return Err(REVOKED.to_string());
        }
        let ce_err = |e: CeError| e.to_string();
        ce::check_payload(kind, ref_, &payload).map_err(ce_err)?;
        let (devices, pols) = self.send_set(relay, pol, cid, now_ms)?;
        let pds: Vec<Pd> = devices.keys().cloned().collect();
        let plan = self.sender.plan(&mut self.keys, cid, &pds, now_ms.div_euclid(1000), self.logs.get(cid)).map_err(ce_err)?;
        let targets: Vec<Pd> = plan.wrap_to.iter().filter(|pd| devices.contains_key(*pd)).cloned().collect();
        let (me, dev) = (self.id.principal.clone(), self.id.device.clone());
        let mut wraps = Vec::with_capacity(targets.len());
        for pd in &targets {
            wraps.push(ce::make_wrap(&self.id.key, cid, &me, &dev, &self.id.serial, plan.epoch, &plan.key, &devices[pd], &plan.members, plan.head, now_ms, None, None, pols.as_deref()).map_err(ce_err)?);
        }
        for page in wraps.chunks(KEYS_PAGE) {
            post_json(relay, "/v1/chat/keys", &json!({"wraps": page})).map_err(|e| e.to_string())?;
        }
        self.sender.mark_wrapped(cid, plan.epoch, &targets).map_err(ce_err)?;
        let nxt = self.sender.next_counter(cid, now_ms, kind).map_err(ce_err)?;
        save(self)?;
        let mid = fixed_mid.map_or_else(ce::new_mid, str::to_string);
        let m = OpenedMessage {
            cid: cid.to_string(),
            mid: mid.clone(),
            from_p: me.clone(),
            from_d: dev.clone(),
            serial: self.id.serial.clone(),
            epoch: nxt.epoch,
            counter: nxt.counter,
            pe: nxt.pe,
            pc: nxt.pc,
            kind: kind.to_string(),
            ref_: ref_.to_string(),
            payload,
            s: nxt.s,
            t: t.to_string(),
            q: String::new(),
            a: false,
            head: plan.head,
        };
        let env = ce::seal(&self.id.key, &nxt.key, &m, None).map_err(ce_err)?;
        let dm = ce::cid_kind(cid).ok() == Some("dm");
        let posted = if kind == "post" {
            let mut body = json!({"id": mid, "enc": env});
            if !t.is_empty() {
                body["thread"] = json!(t);
            }
            if dm {
                body["to"] = json!(self.dm_other(cid));
                post_json(relay, "/v1/dm", &body)
            } else {
                body["channel"] = json!(&cid[3..]);
                post_json(relay, "/v1/channels/post", &body)
            }
        } else {
            let path = match kind {
                "edit" => "/v1/chat/edit",
                "delete" => "/v1/chat/delete",
                _ => "/v1/chat/event",
            };
            let mut body = if dm { json!({"scope": "dm", "with": self.dm_other(cid)}) } else { json!({"scope": "channel", "channel": &cid[3..]}) };
            body["id"] = json!(ref_);
            body["event"] = json!(mid);
            body["enc"] = env;
            post_json(relay, path, &body)
        };
        let row = match posted {
            Ok(row) => row,
            Err(e) if fixed_mid.is_some() && e.status == 409 && e.message.contains(ID_KEPT) => return Err(ID_KEPT.to_string()),
            Err(e) => return Err(e.to_string()),
        };
        self.keys.note_message(cid, &me, &dev, nxt.epoch, nxt.counter, &mid, nxt.s, kind).map_err(ce_err)?;
        Ok((mid, row, m))
    }
}
