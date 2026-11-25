// AC-2a 3.2, 3.4, 3.5, 3.10 to 3.12 (F17, F21, console side): the management CA by generation, the management
// server leaf (current, next, a 7-day tail after a switch) and its revocation, the CA-signed server trust manifest,
// normal rollover and `ca-distrust`, compromise and loss recovery (the offline `fleet-ca replace`), the recovery
// records and the restricted, idempotent recovery issue (A2-H2, A3-M2), issuing relay certificates, and
// `fleet-denied.json`. The console never draws a replacement CA or server key under the old identity on its own:
// when a sealed CA key cannot be used it reports `lost` and keeps every file as it is (3.12).
//
// Files (owner-only): `fleet-ca.pem` (the CA certificates, generation 1 first), `fleet-server.pem` (the current
// leaf and its CA, then the next leaf and its CA when one is drawn), `fleet-trust.json` (generation states, server
// leaf records, revocations, the signed manifest, recovery records, audits left by offline commands) and
// `fleet-denied.json`. Sealed secrets: `fleet-ca-key` (generation 1), `fleet-ca-key-<g>` (later generations),
// `fleet-server-key` and `fleet-server-key-next`.

use crate::codec::{b64u, hex, parse_json, sha256, stringify, unb64u};
use crate::console_audit::canonical_json;
use crate::fleet_wire::{distrust_input, recover_input, same_bytes, trust_input, Refusal};
use crate::fleet_x509::{self as x509, Curve, Key, Profile, Spec, DAY_MS};
use crate::meet_x509::{der_to_pem, pem_blocks, Cert};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const CA_FILE: &str = "fleet-ca.pem";
pub const SERVER_FILE: &str = "fleet-server.pem";
pub const TRUST_FILE: &str = "fleet-trust.json";
pub const DENIED_FILE: &str = "fleet-denied.json";
pub const SERVER_KEY: &str = "fleet-server-key";
pub const SERVER_KEY_NEXT: &str = "fleet-server-key-next";

/// 3.2, 3.10, 3.11 timings.
pub const NEXT_LEAF_BEFORE_MS: i64 = 30 * DAY_MS;
pub const NEXT_LEAF_USE_AFTER_MS: i64 = 14 * DAY_MS;
pub const OLD_LEAF_TAIL_MS: i64 = 7 * DAY_MS;
pub const MANIFEST_EVERY_MS: i64 = DAY_MS;
pub const MANIFEST_LIFE_MS: i64 = 14 * DAY_MS;
pub const ROLLOVER_BEFORE_MS: i64 = 180 * DAY_MS;
pub const CA_EXPIRING_MS: i64 = 365 * DAY_MS;
pub const OVERLAP_MS: i64 = 90 * DAY_MS;
pub const RECOVERY_MS: i64 = 90 * DAY_MS;

pub fn ca_key_name(generation: u64) -> String {
    if generation == 1 {
        "fleet-ca-key".to_owned()
    } else {
        format!("fleet-ca-key-{generation}")
    }
}

// ── Sealed secrets ──────────────────────────────────────────────────────────────────────────────────────────

/// What this file needs of AC-1's `Seal` (and a memory store in tests).
pub trait Vault {
    fn get(&self, name: &str) -> Option<Vec<u8>>;
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String>;
    fn remove(&mut self, name: &str) -> Result<(), String>;
    /// False when nothing unseals (no allowed provider, or `seal-lost`).
    fn usable(&self) -> bool;
}

impl Vault for crate::console_seal::Seal {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        crate::console_seal::Seal::get(self, name)
    }
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
        crate::console_seal::Seal::put(self, name, value)
    }
    fn remove(&mut self, name: &str) -> Result<(), String> {
        crate::console_seal::Seal::remove(self, name)
    }
    fn usable(&self) -> bool {
        self.refused().is_none()
    }
}

/// A vault that holds nothing (a console whose `console-secrets.json` does not read back).
pub struct NoVault;

impl Vault for NoVault {
    fn get(&self, _: &str) -> Option<Vec<u8>> {
        None
    }
    fn put(&mut self, _: &str, _: &[u8]) -> Result<(), String> {
        Err("the sealed secrets cannot be used".into())
    }
    fn remove(&mut self, _: &str) -> Result<(), String> {
        Err("the sealed secrets cannot be used".into())
    }
    fn usable(&self) -> bool {
        false
    }
}

/// Where a vault lives behind its lock: the console's (or a relay's headless console's) `Seal`, or a test store.
pub trait VaultLock: Send + Sync {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault));
}

impl VaultLock for crate::console::Console {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault)) {
        let mut g = self.seal.lock();
        match g.as_mut() {
            Some(s) => f(s),
            None => f(&mut NoVault),
        }
    }
}

#[cfg(test)]
impl VaultLock for parking_lot::Mutex<MemVault> {
    fn with_vault(&self, f: &mut dyn FnMut(&mut dyn Vault)) {
        f(&mut *self.lock())
    }
}

/// Run `f` with the vault behind `lock`.
pub fn vault_do<R>(lock: &dyn VaultLock, f: impl FnOnce(&mut dyn Vault) -> R) -> R {
    let mut f = Some(f);
    let mut out = None;
    lock.with_vault(&mut |v| {
        if let Some(f) = f.take() {
            out = Some(f(v));
        }
    });
    out.expect("the vault lock ran the closure")
}

#[cfg(test)]
#[derive(Default)]
pub struct MemVault {
    pub map: std::collections::HashMap<String, Vec<u8>>,
    pub broken: bool,
}

#[cfg(test)]
impl Vault for MemVault {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        if self.broken {
            return None;
        }
        self.map.get(name).cloned()
    }
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
        if self.broken {
            return Err("sealed store refused".into());
        }
        self.map.insert(name.to_owned(), value.to_vec());
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), String> {
        self.map.remove(name);
        Ok(())
    }
    fn usable(&self) -> bool {
        !self.broken
    }
}

fn write(dir: &Path, name: &str, data: &[u8]) -> Result<(), String> {
    crate::store::write_private(&dir.join(name), data).map_err(|e| format!("{name} could not be written: {e}"))
}

// ── fleet-denied.json ───────────────────────────────────────────────────────────────────────────────────────

/// Denied management serials with their `notAfter` (3.5). A missing file is an empty list; one that does not read
/// back keeps the management port closed (2.4).
#[derive(Default, Clone, Debug)]
pub struct Denied {
    pub list: Vec<(String, i64)>,
}

impl Denied {
    pub fn load(dir: &Path) -> Result<Denied, String> {
        let file = dir.join(DENIED_FILE);
        let Ok(text) = std::fs::read_to_string(&file) else {
            return if file.exists() { Err(format!("{DENIED_FILE} does not read back")) } else { Ok(Denied::default()) };
        };
        let bad = || format!("{DENIED_FILE} does not read back");
        let v = parse_json(&text).ok_or_else(bad)?;
        let mut list = Vec::new();
        for e in v.get("denied").and_then(Value::as_array).ok_or_else(bad)? {
            let serial = e.get("serial").and_then(Value::as_str).ok_or_else(bad)?;
            let na = e.get("notAfter").and_then(Value::as_i64).ok_or_else(bad)?;
            list.push((serial.to_owned(), na));
        }
        Ok(Denied { list })
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let list: Vec<Value> = self.list.iter().map(|(s, n)| json!({ "serial": s, "notAfter": n })).collect();
        write(dir, DENIED_FILE, stringify(&json!({ "v": 1, "denied": list })).as_bytes())
    }

    pub fn contains(&self, serial: &str) -> bool {
        self.list.iter().any(|(s, _)| s == serial)
    }

    pub fn deny(&mut self, serial: &str, not_after: i64) {
        if !self.contains(serial) {
            self.list.push((serial.to_owned(), not_after));
        }
    }
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GenState {
    /// Signs manifests and relay certificates (or still accepted during an overlap).
    Active,
    /// Drawn by a normal rollover, announced as `nextCa`, accepted for relay certificates of relays that trust it.
    Incoming,
    /// After a normal overlap ended: no longer used or accepted.
    Retired,
    /// After `fleet-ca replace`: never trusted again; its relay certificates serve only the recovery path.
    Distrusted,
}

impl GenState {
    pub fn as_str(self) -> &'static str {
        match self {
            GenState::Active => "active",
            GenState::Incoming => "incoming",
            GenState::Retired => "retired",
            GenState::Distrusted => "distrusted",
        }
    }
    fn parse(s: &str) -> Option<GenState> {
        Some(match s {
            "active" => GenState::Active,
            "incoming" => GenState::Incoming,
            "retired" => GenState::Retired,
            "distrusted" => GenState::Distrusted,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Generation {
    pub generation: u64,
    pub state: GenState,
    pub from: i64,
    pub cert: Vec<u8>,
}

impl Generation {
    pub fn pin(&self) -> String {
        x509::pin_hex(&self.cert).unwrap_or_default()
    }
    pub fn not_after_ms(&self) -> i64 {
        Cert::from_der(&self.cert).map(|c| c.not_after * 1000).unwrap_or(0)
    }
}

/// One server leaf the manifest lists.
#[derive(Clone, Debug, PartialEq)]
pub struct Leaf {
    pub serial: String,
    pub spki_sha256: String,
    pub not_after: i64,
    pub generation: u64,
    /// `next`: when it takes over; `tail`: when the old leaf leaves the manifest.
    pub at: i64,
}

impl Leaf {
    fn of(cert: &[u8], generation: u64, at: i64) -> Option<Leaf> {
        let c = Cert::from_der(cert)?;
        Some(Leaf { serial: c.serial.clone(), spki_sha256: hex(&sha256(&c.spki)), not_after: c.not_after * 1000, generation, at })
    }
    fn to_json(&self) -> Value {
        json!({ "serial": self.serial, "spkiSha256": self.spki_sha256, "notAfter": self.not_after, "generation": self.generation, "at": self.at })
    }
    fn from_json(v: &Value) -> Option<Leaf> {
        Some(Leaf { serial: v.get("serial")?.as_str()?.to_owned(), spki_sha256: v.get("spkiSha256")?.as_str()?.to_owned(), not_after: v.get("notAfter")?.as_i64()?, generation: v.get("generation")?.as_u64()?, at: v.get("at")?.as_i64()? })
    }
}

/// What the console issued on an accepted recovery request (A3-M2), kept until the relay's first normal connection
/// with it or `until`.
#[derive(Clone, Debug, PartialEq)]
pub struct Issued {
    pub cert: Vec<u8>,
    pub spki_new: Vec<u8>,
    pub request_sha256: [u8; 32],
}

/// A recovery record (3.11): one per relay at a CA replacement.
#[derive(Clone, Debug, PartialEq)]
pub struct Recovery {
    pub relay_id: String,
    pub old_serial: String,
    pub old_spki: Vec<u8>,
    pub until: i64,
    pub generation: u64,
    pub issued: Option<Issued>,
    pub closed: bool,
}

impl Recovery {
    fn to_json(&self) -> Value {
        json!({
            "relayId": self.relay_id, "oldSerial": self.old_serial, "oldSpki": b64u(&self.old_spki), "until": self.until,
            "generation": self.generation, "closed": self.closed,
            "issued": self.issued.as_ref().map(|i| json!({ "cert": b64u(&i.cert), "spkiNew": b64u(&i.spki_new), "requestSha256": hex(&i.request_sha256) })),
        })
    }
    fn from_json(v: &Value) -> Option<Recovery> {
        let issued = match v.get("issued")? {
            Value::Null => None,
            i => Some(Issued {
                cert: unb64u(i.get("cert")?.as_str()?)?,
                spki_new: unb64u(i.get("spkiNew")?.as_str()?)?,
                request_sha256: crate::fleet_wire::hash_of(i.get("requestSha256"))?,
            }),
        };
        Some(Recovery {
            relay_id: v.get("relayId")?.as_str()?.to_owned(),
            old_serial: v.get("oldSerial")?.as_str()?.to_owned(),
            old_spki: unb64u(v.get("oldSpki")?.as_str()?)?,
            until: v.get("until")?.as_i64()?,
            generation: v.get("generation")?.as_u64()?,
            issued,
            closed: v.get("closed")?.as_bool()?,
        })
    }
}

/// The recovery checks of 3.11 in their order (vector `recovery`): no-record, closed, expired, serial, spki,
/// sig-old, sig-new, issued-different. Ok(None): a first request to issue for; Ok(Some): an exact retry, answered
/// with the stored certificate.
pub fn recovery_check<'a>(rec: Option<&'a Recovery>, console_id: &str, presented_serial: &str, presented_spki: &[u8], body: &Value, t: i64) -> Result<Option<&'a Issued>, &'static str> {
    let o = body.as_object().filter(|o| crate::codec::exact_keys(o, &["relayId", "spkiNew", "sigOld", "sigNew"], &["relayId", "spkiNew"])).ok_or("no-record")?;
    let rec = rec.filter(|r| o.get("relayId").and_then(Value::as_str) == Some(r.relay_id.as_str())).ok_or("no-record")?;
    if rec.closed {
        return Err("closed");
    }
    if t > rec.until {
        return Err("expired");
    }
    if presented_serial != rec.old_serial {
        return Err("serial");
    }
    if presented_spki != rec.old_spki.as_slice() {
        return Err("spki");
    }
    let spki_new = crate::fleet_wire::b64u_of(o.get("spkiNew")).filter(|s| x509::is_p256_spki(s)).ok_or("sig-new")?;
    let input = recover_input(console_id, &rec.relay_id, &rec.old_serial, &spki_new, rec.generation).ok_or("serial")?;
    let sig_old = crate::fleet_wire::b64u_of(o.get("sigOld")).unwrap_or_default();
    if !x509::verify_p256(&rec.old_spki, &input, &sig_old) {
        return Err("sig-old");
    }
    let sig_new = crate::fleet_wire::b64u_of(o.get("sigNew")).unwrap_or_default();
    if !x509::verify_p256(&spki_new, &input, &sig_new) {
        return Err("sig-new");
    }
    match &rec.issued {
        Some(i) if same_bytes(&i.request_sha256, &request_sha256(body)?) => Ok(Some(i)),
        Some(_) => Err("issued-different"),
        None => Ok(None),
    }
}

/// `requestSha256`: SHA-256 of the canonical request body.
pub fn request_sha256(body: &Value) -> Result<[u8; 32], &'static str> {
    canonical_json(body).map(|b| sha256(&b)).map_err(|_| "issued-different")
}

// ── The CA ──────────────────────────────────────────────────────────────────────────────────────────────────

/// Why the management port is closed (3.2, 3.4, 3.12; F7 `PkiStatus`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Health {
    Ready,
    /// No CA yet and no sealing provider the profile allows (`fleet-seal-needed`).
    SealNeeded,
    /// A CA exists but its key (or the sealed store) cannot be used (`fleet-ca-lost`).
    Lost,
    /// A fleet state file does not read back (`fleet-state-unreadable`).
    Unreadable,
    /// The issuing CA certificate has ended.
    Expired,
}

/// Something the port does after a tick or a change.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    /// Push this manifest to every connected relay (`trust`).
    Manifest(Value),
    /// Push `ca-distrust` to every connected relay.
    Distrust(Value),
    /// The server certificate changed: reload the listener's certificate.
    ServerChanged,
    /// Deny every relay serial of this generation (the end of an overlap).
    DenyGeneration(u64),
    /// An audit entry for the console's chain: (action, detail).
    Audit(&'static str, Value),
}

pub struct FleetCa {
    dir: PathBuf,
    pub console_id: String,
    pub host: String,
    pub names: Vec<String>,
    pub generations: Vec<Generation>,
    /// The generation that signs manifests, server leaves and new relay certificates.
    pub issuing: u64,
    /// When a normal rollover began (for the 90-day overlap).
    pub rollover_at: Option<i64>,
    pub current: Option<Leaf>,
    pub next: Option<Leaf>,
    pub tail: Option<Leaf>,
    /// (spkiSha256, serial, at, notAfter)
    pub revoked: Vec<(String, String, i64, i64)>,
    pub seq: u64,
    pub manifest: Value,
    pub recovery: Vec<Recovery>,
    pub denied: Denied,
    pub health: Health,
    /// Certificate DER of the current and next server leaves.
    current_cert: Vec<u8>,
    next_cert: Vec<u8>,
    /// Audits left by offline commands, recorded at the next start (3.12).
    pub pending_audit: Vec<(String, Value)>,
}

impl std::fmt::Debug for FleetCa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FleetCa({}, generation {}, {:?})", self.console_id, self.issuing, self.health)
    }
}

fn read_trust(dir: &Path) -> Result<Option<Value>, String> {
    let file = dir.join(TRUST_FILE);
    match std::fs::read_to_string(&file) {
        Ok(t) => parse_json(&t).filter(Value::is_object).map(Some).ok_or_else(|| format!("{TRUST_FILE} does not read back")),
        Err(_) if !file.exists() => Ok(None),
        Err(_) => Err(format!("{TRUST_FILE} does not read back")),
    }
}

impl FleetCa {
    fn empty(dir: &Path, console_id: &str, host: &str, names: &[String], health: Health) -> FleetCa {
        FleetCa {
            dir: dir.to_owned(),
            console_id: console_id.to_owned(),
            host: host.to_owned(),
            names: names.to_vec(),
            generations: Vec::new(),
            issuing: 0,
            rollover_at: None,
            current: None,
            next: None,
            tail: None,
            revoked: Vec::new(),
            seq: 0,
            manifest: Value::Null,
            recovery: Vec::new(),
            denied: Denied::default(),
            health,
            current_cert: Vec::new(),
            next_cert: Vec::new(),
            pending_audit: Vec::new(),
        }
    }

    /// Open the console's PKI at start. With no fleet state at all and a usable vault, the CA (generation 1), the
    /// server leaf and the first manifest are drawn (3.2). With fleet state, nothing new is drawn while a CA key is
    /// missing (3.12: `Lost`, every file kept); a lost server key alone is replaced and the old leaf revoked.
    pub fn open(dir: &Path, vault: &mut dyn Vault, console_id: &str, host: &str, names: &[String], t: i64) -> FleetCa {
        let denied = match Denied::load(dir) {
            Ok(d) => d,
            Err(_) => return FleetCa::empty(dir, console_id, host, names, Health::Unreadable),
        };
        let trust = match read_trust(dir) {
            Ok(v) => v,
            Err(_) => return FleetCa::empty(dir, console_id, host, names, Health::Unreadable),
        };
        let Some(trust) = trust else {
            if dir.join(CA_FILE).exists() {
                return FleetCa::empty(dir, console_id, host, names, Health::Unreadable);
            }
            if !vault.usable() {
                return FleetCa::empty(dir, console_id, host, names, Health::SealNeeded);
            }
            let mut ca = FleetCa::empty(dir, console_id, host, names, Health::Ready);
            ca.denied = denied;
            return match ca.first_draw(vault, t) {
                Ok(()) => ca,
                Err(_) => FleetCa::empty(dir, console_id, host, names, Health::SealNeeded),
            };
        };
        let mut ca = match FleetCa::from_files(dir, &trust, host, names) {
            Some(ca) => ca,
            None => return FleetCa::empty(dir, console_id, host, names, Health::Unreadable),
        };
        ca.denied = denied;
        if ca.console_id != console_id {
            ca.health = Health::Unreadable;
            return ca;
        }
        if !vault.usable() || ca.ca_key(vault, ca.issuing).is_none() {
            ca.health = Health::Lost;
            return ca;
        }
        if ca.issuing_cert().map(|g| g.not_after_ms() < t).unwrap_or(true) {
            ca.health = Health::Expired;
            return ca;
        }
        // A lost server key with the CA usable: a new leaf, the old one revoked (3.12), no relay action.
        if vault.get(SERVER_KEY).is_none() && ca.replace_server(vault, t, true).is_err() {
            ca.health = Health::Lost;
        }
        ca
    }

    fn from_files(dir: &Path, trust: &Value, host: &str, names: &[String]) -> Option<FleetCa> {
        let ca_pem = std::fs::read(dir.join(CA_FILE)).ok()?;
        let certs: Vec<Vec<u8>> = pem_blocks(&ca_pem, "CERTIFICATE").into_iter().map(|(_, d)| d).collect();
        let server_pem = std::fs::read(dir.join(SERVER_FILE)).ok()?;
        let server: Vec<Vec<u8>> = pem_blocks(&server_pem, "CERTIFICATE").into_iter().map(|(_, d)| d).collect();
        let mut generations = Vec::new();
        for g in trust.get("generations")?.as_array()? {
            let generation = g.get("generation")?.as_u64()?;
            let cert = certs.get(usize::try_from(generation).ok()?.checked_sub(1)?)?.clone();
            Cert::from_der(&cert)?;
            generations.push(Generation { generation, state: GenState::parse(g.get("state")?.as_str()?)?, from: g.get("from")?.as_i64()?, cert });
        }
        let leaf = |k: &str| -> Option<Option<Leaf>> {
            match trust.get(k)? {
                Value::Null => Some(None),
                v => Leaf::from_json(v).map(Some),
            }
        };
        let mut revoked = Vec::new();
        for r in trust.get("revoked")?.as_array()? {
            revoked.push((r.get("spkiSha256")?.as_str()?.to_owned(), r.get("serial")?.as_str()?.to_owned(), r.get("at")?.as_i64()?, r.get("notAfter")?.as_i64()?));
        }
        let mut recovery = Vec::new();
        for r in trust.get("recovery")?.as_array()? {
            recovery.push(Recovery::from_json(r)?);
        }
        let pending_audit = trust.get("pendingAudit").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| Some((e.get("action")?.as_str()?.to_owned(), e.get("detail")?.clone()))).collect()).unwrap_or_default();
        let current = leaf("current")?;
        let next = leaf("next")?;
        let current_cert = server.first().cloned().unwrap_or_default();
        let next_cert = if next.is_some() { server.get(2).cloned()? } else { Vec::new() };
        if current.as_ref().map(|l| Leaf::of(&current_cert, l.generation, l.at).map(|x| x.serial) != Some(l.serial.clone())).unwrap_or(false) {
            return None;
        }
        Some(FleetCa {
            dir: dir.to_owned(),
            console_id: trust.get("consoleId")?.as_str()?.to_owned(),
            host: host.to_owned(),
            names: names.to_vec(),
            generations,
            issuing: trust.get("issuing")?.as_u64()?,
            rollover_at: trust.get("rolloverAt").and_then(Value::as_i64),
            current,
            next,
            tail: leaf("tail")?,
            revoked,
            seq: trust.get("seq")?.as_u64()?,
            manifest: trust.get("manifest")?.clone(),
            recovery,
            denied: Denied::default(),
            health: Health::Ready,
            current_cert,
            next_cert,
            pending_audit,
        })
    }

    /// Write every file of this PKI (the trust file last, so a crash leaves the old trust state with the new
    /// certificates still listed in it only when both landed).
    pub fn save(&self) -> Result<(), String> {
        let ca_pem: String = self.generations.iter().map(|g| der_to_pem(&g.cert)).collect();
        write(&self.dir, CA_FILE, ca_pem.as_bytes())?;
        let mut server = String::new();
        if !self.current_cert.is_empty() {
            server.push_str(&der_to_pem(&self.current_cert));
            server.push_str(&der_to_pem(&self.gen_cert(self.current.as_ref().map(|l| l.generation).unwrap_or(self.issuing))));
        }
        if !self.next_cert.is_empty() {
            server.push_str(&der_to_pem(&self.next_cert));
            server.push_str(&der_to_pem(&self.gen_cert(self.next.as_ref().map(|l| l.generation).unwrap_or(self.issuing))));
        }
        write(&self.dir, SERVER_FILE, server.as_bytes())?;
        self.denied.save(&self.dir)?;
        let trust = json!({
            "v": 1,
            "consoleId": self.console_id,
            "generations": self.generations.iter().map(|g| json!({ "generation": g.generation, "state": g.state.as_str(), "from": g.from })).collect::<Vec<_>>(),
            "issuing": self.issuing,
            "rolloverAt": self.rollover_at,
            "current": self.current.as_ref().map(Leaf::to_json),
            "next": self.next.as_ref().map(Leaf::to_json),
            "tail": self.tail.as_ref().map(Leaf::to_json),
            "revoked": self.revoked.iter().map(|(s, n, a, na)| json!({ "spkiSha256": s, "serial": n, "at": a, "notAfter": na })).collect::<Vec<_>>(),
            "seq": self.seq,
            "manifest": self.manifest,
            "recovery": self.recovery.iter().map(Recovery::to_json).collect::<Vec<_>>(),
            "pendingAudit": self.pending_audit.iter().map(|(a, d)| json!({ "action": a, "detail": d })).collect::<Vec<_>>(),
        });
        write(&self.dir, TRUST_FILE, stringify(&trust).as_bytes())
    }

    /// The console's state folder.
    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn gen_cert(&self, generation: u64) -> Vec<u8> {
        self.generations.iter().find(|g| g.generation == generation).map(|g| g.cert.clone()).unwrap_or_default()
    }

    pub fn issuing_cert(&self) -> Option<&Generation> {
        self.generations.iter().find(|g| g.generation == self.issuing)
    }

    /// The pin of the issuing generation (what a new enrollment code carries, F1).
    pub fn pin(&self) -> Option<[u8; 32]> {
        (self.health == Health::Ready).then(|| self.issuing_cert().map(|g| sha256(&Cert::from_der(&g.cert).map(|c| c.spki).unwrap_or_default()))).flatten()
    }

    fn ca_key(&self, vault: &dyn Vault, generation: u64) -> Option<Key> {
        Key::from_pkcs8(Curve::P384, &vault.get(&ca_key_name(generation))?).ok()
    }

    fn draw_ca(&mut self, vault: &mut dyn Vault, generation: u64, state: GenState, t: i64) -> Result<(), String> {
        let key = Key::generate(Curve::P384)?;
        let serial = x509::new_serial()?;
        let cert = x509::issue(&Spec { profile: Profile::Ca { host: self.host.clone() }, serial: &serial, not_before_ms: t, not_after_ms: t + x509::CA_DAYS * DAY_MS, spki: &key.spki(), issuer: None }, &key)?;
        vault.put(&ca_key_name(generation), key.pkcs8())?;
        self.generations.push(Generation { generation, state, from: t, cert });
        Ok(())
    }

    fn first_draw(&mut self, vault: &mut dyn Vault, t: i64) -> Result<(), String> {
        self.draw_ca(vault, 1, GenState::Active, t)?;
        self.issuing = 1;
        self.draw_server(vault, SERVER_KEY, t)?;
        self.reissue(vault, t)?;
        self.save()
    }

    /// A server leaf under the issuing generation, its key sealed as `name`; it becomes `current` or `next`.
    fn draw_server(&mut self, vault: &mut dyn Vault, name: &str, t: i64) -> Result<(), String> {
        let ca_key = self.ca_key(vault, self.issuing).ok_or("the management CA key cannot be used")?;
        let ca_cert = self.gen_cert(self.issuing);
        let key = Key::generate(Curve::P256)?;
        let serial = x509::new_serial()?;
        let cert = x509::issue(&Spec { profile: Profile::Server { host: self.host.clone(), names: self.names.clone() }, serial: &serial, not_before_ms: t, not_after_ms: t + x509::LEAF_DAYS * DAY_MS, spki: &key.spki(), issuer: Some(&ca_cert) }, &ca_key)?;
        vault.put(name, key.pkcs8())?;
        if name == SERVER_KEY {
            self.current = Leaf::of(&cert, self.issuing, t);
            self.current_cert = cert;
        } else {
            self.next = Leaf::of(&cert, self.issuing, t + NEXT_LEAF_USE_AFTER_MS);
            self.next_cert = cert;
        }
        Ok(())
    }

    /// The server certificate chain and key the listener presents (current leaf, its CA).
    pub fn server_identity(&self, vault: &dyn Vault) -> Option<(Vec<Vec<u8>>, Vec<u8>)> {
        let gen = self.current.as_ref()?.generation;
        Some((vec![self.current_cert.clone(), self.gen_cert(gen)], vault.get(SERVER_KEY)?))
    }

    /// A new signed manifest (3.10): seq + 1, 14 days, the listed leaves (at most 2), revocations still in date,
    /// `nextCa` during a normal rollover; signed by the issuing generation.
    pub fn reissue(&mut self, vault: &dyn Vault, t: i64) -> Result<Value, String> {
        let key = self.ca_key(vault, self.issuing).ok_or("the management CA key cannot be used")?;
        self.revoked.retain(|(_, _, _, na)| *na > t);
        let mut leaves = Vec::new();
        for (l, role) in [(&self.current, "current"), (&self.next, "next"), (&self.tail, "current")] {
            if let Some(l) = l {
                if leaves.len() < 2 {
                    leaves.push(json!({ "spkiSha256": l.spki_sha256, "serial": l.serial, "role": role, "notAfter": l.not_after }));
                }
            }
        }
        let next_ca = self.generations.iter().find(|g| g.state == GenState::Incoming).map(|g| json!({ "generation": g.generation, "caCert": b64u(&g.cert), "fingerprint": g.pin(), "from": g.from }));
        self.seq += 1;
        let mut m = Map::new();
        m.insert("v".into(), json!(1));
        m.insert("consoleId".into(), json!(self.console_id));
        m.insert("caGeneration".into(), json!(self.issuing));
        m.insert("seq".into(), json!(self.seq));
        m.insert("issuedAt".into(), json!(t));
        m.insert("expiresAt".into(), json!(t + MANIFEST_LIFE_MS));
        m.insert("leaves".into(), Value::Array(leaves));
        m.insert("revoked".into(), Value::Array(self.revoked.iter().map(|(s, n, a, _)| json!({ "spkiSha256": s, "serial": n, "at": a })).collect()));
        m.insert("nextCa".into(), next_ca.unwrap_or(Value::Null));
        let input = trust_input(&Value::Object(m.clone()))?;
        m.insert("sig".into(), json!(b64u(&key.sign(&input)?)));
        self.manifest = Value::Object(m);
        Ok(self.manifest.clone())
    }

    pub(crate) fn issued_at(&self) -> i64 {
        self.manifest.get("issuedAt").and_then(Value::as_i64).unwrap_or(0)
    }

    /// Replace the current server leaf now; with `revoke` the old one goes into `revoked` (3.10, 3.12).
    fn replace_server(&mut self, vault: &mut dyn Vault, t: i64, revoke: bool) -> Result<String, String> {
        let old = self.current.clone();
        self.draw_server(vault, SERVER_KEY, t)?;
        self.next = None;
        self.next_cert.clear();
        let _ = vault.remove(SERVER_KEY_NEXT);
        self.tail = None;
        let spki = old.as_ref().map(|l| l.spki_sha256.clone()).unwrap_or_default();
        if let (Some(o), true) = (old, revoke) {
            self.revoked.push((o.spki_sha256, o.serial, t, o.not_after));
        }
        self.reissue(vault, t)?;
        self.save()?;
        Ok(spki)
    }

    /// "Replace the management certificate now" (3.10): a new leaf at once, the old one revoked.
    pub fn server_revoke(&mut self, vault: &mut dyn Vault, t: i64) -> Result<(String, u64), String> {
        if self.health != Health::Ready {
            return Err("the management CA cannot be used".into());
        }
        let spki = self.replace_server(vault, t, true)?;
        Ok((spki, self.seq))
    }

    /// "Start a new management CA" (3.11): generation g+1 drawn as incoming and announced as `nextCa`.
    pub fn ca_rollover(&mut self, vault: &mut dyn Vault, t: i64) -> Result<(u64, String), String> {
        if self.health != Health::Ready {
            return Err("the management CA cannot be used".into());
        }
        if let Some(g) = self.generations.iter().find(|g| g.state == GenState::Incoming) {
            return Ok((g.generation, g.pin()));
        }
        let next = self.generations.iter().map(|g| g.generation).max().unwrap_or(0) + 1;
        self.draw_ca(vault, next, GenState::Incoming, t)?;
        self.rollover_at = Some(t);
        self.reissue(vault, t)?;
        self.save()?;
        let g = self.generations.last().map(|g| (g.generation, g.pin())).unwrap_or_default();
        Ok(g)
    }

    /// The scheduled work of 3.2, 3.4, 3.10 and 3.11, once a minute: next leaf 30 days before the end, switch 14 days
    /// after, the old leaf's 7-day tail, the daily manifest, a rollover at the latest 180 days before the CA ends, the
    /// end of a 90-day overlap, and recovery records past `until`.
    pub fn tick(&mut self, vault: &mut dyn Vault, t: i64) -> Vec<Push> {
        let mut out = Vec::new();
        if self.health != Health::Ready {
            return out;
        }
        if self.issuing_cert().map(|g| g.not_after_ms() < t).unwrap_or(true) {
            self.health = Health::Expired;
            return out;
        }
        let mut changed = false;
        // Recovery records past `until`: closed, their stored answer wiped.
        for r in &mut self.recovery {
            if !r.closed && t > r.until {
                r.closed = true;
                r.issued = None;
                changed = true;
            }
        }
        if self.tail.as_ref().is_some_and(|l| t >= l.at) {
            self.tail = None;
            changed = true;
        }
        if self.next.is_none() && self.current.as_ref().is_some_and(|l| t >= l.not_after - NEXT_LEAF_BEFORE_MS) && self.draw_server(vault, SERVER_KEY_NEXT, t).is_ok() {
            changed = true;
        }
        if self.next.as_ref().is_some_and(|l| t >= l.at) {
            if let (Some(next), Some(key)) = (self.next.take(), vault.get(SERVER_KEY_NEXT)) {
                if vault.put(SERVER_KEY, &key).is_ok() {
                    let _ = vault.remove(SERVER_KEY_NEXT);
                    self.tail = self.current.take().map(|mut l| {
                        l.at = t + OLD_LEAF_TAIL_MS;
                        l
                    });
                    self.current = Some(next);
                    self.current_cert = std::mem::take(&mut self.next_cert);
                    out.push(Push::ServerChanged);
                    out.push(Push::Audit("fleet.server-cert", json!({ "serial": self.current.as_ref().map(|l| l.serial.clone()) })));
                    changed = true;
                }
            }
        }
        // A rollover at the latest 180 days before the issuing CA ends.
        let ends = self.issuing_cert().map(Generation::not_after_ms).unwrap_or(0);
        if t >= ends - ROLLOVER_BEFORE_MS && self.rollover_at.is_none() {
            if let Ok((g, fp)) = self.ca_rollover(vault, t) {
                out.push(Push::Audit("fleet.ca.rollover", json!({ "generation": g, "fingerprint": fp })));
                changed = true;
            }
        }
        // The end of the overlap: the incoming generation issues, the old one is retired, its serials denied, and
        // relays are told to distrust it.
        if let Some(at) = self.rollover_at.filter(|at| t >= at + OVERLAP_MS) {
            let _ = at;
            if let Some(incoming) = self.generations.iter().position(|g| g.state == GenState::Incoming) {
                let old = self.issuing;
                let new = self.generations[incoming].generation;
                self.generations[incoming].state = GenState::Active;
                self.issuing = new;
                if let Some(o) = self.generations.iter_mut().find(|g| g.generation == old) {
                    o.state = GenState::Retired;
                }
                self.rollover_at = None;
                if self.replace_server(vault, t, false).is_ok() {
                    out.push(Push::ServerChanged);
                }
                out.push(Push::DenyGeneration(old));
                if let Some(d) = self.distrust_frame(vault, old) {
                    out.push(Push::Distrust(d));
                }
                changed = true;
            }
        }
        if changed || t - self.issued_at() >= MANIFEST_EVERY_MS {
            if let Ok(m) = self.reissue(vault, t) {
                let _ = self.save();
                out.push(Push::Audit("fleet.trust", json!({ "seq": self.seq, "leaves": m["leaves"].as_array().map(|a| a.iter().map(|l| l["spkiSha256"].clone()).collect::<Vec<_>>()), "revoked": m["revoked"].as_array().map(|a| a.iter().map(|l| l["spkiSha256"].clone()).collect::<Vec<_>>()) })));
                out.push(Push::Manifest(m));
            }
        }
        out
    }

    /// `ca-distrust {generation, sig}` signed by the issuing generation (3.11).
    pub fn distrust_frame(&self, vault: &dyn Vault, generation: u64) -> Option<Value> {
        let key = self.ca_key(vault, self.issuing)?;
        let sig = key.sign(&distrust_input(&self.console_id, generation)).ok()?;
        Some(json!({ "generation": generation, "sig": b64u(&sig) }))
    }

    /// Generations whose relay certificates are accepted for normal use.
    pub fn accepted(&self) -> impl Iterator<Item = &Generation> {
        self.generations.iter().filter(|g| matches!(g.state, GenState::Active | GenState::Incoming))
    }

    /// Generations whose relay certificates only reach the recovery path.
    pub fn recovery_only(&self) -> impl Iterator<Item = &Generation> {
        self.generations.iter().filter(|g| matches!(g.state, GenState::Distrusted | GenState::Retired))
    }

    /// A relay certificate (3.2) for `spki` under `generation` (the issuing one unless the relay asked under a newer
    /// generation it trusts). Ok is (certificate DER, serial hex, notAfter ms).
    pub fn issue_relay(&self, vault: &dyn Vault, relay_id: &str, spki: &[u8], generation: u64, t: i64) -> Result<(Vec<u8>, String, i64), String> {
        if !x509::is_p256_spki(spki) {
            return Err("the relay key is not a P-256 key".into());
        }
        let g = self.accepted().find(|g| g.generation == generation).ok_or("that CA generation does not issue")?;
        let key = self.ca_key(vault, generation).ok_or("the management CA key cannot be used")?;
        let serial = x509::new_serial()?;
        let not_after = t + x509::LEAF_DAYS * DAY_MS;
        // backdated like Meet CA leaves: a relay whose clock runs a little behind the console's judges a leaf
        // dated "now" as not yet valid, and refuses its own enrollment answer (seen live: `leaf: expired`)
        let not_before = t - crate::meet_ca::BACKDATE_MS;
        let cert = x509::issue(&Spec { profile: Profile::Relay { relay_id: relay_id.to_owned() }, serial: &serial, not_before_ms: not_before, not_after_ms: not_after, spki, issuer: Some(&g.cert) }, &key)?;
        Ok((cert, x509::serial_of_bytes(&serial), (not_after / 1000) * 1000))
    }

    /// `POST /fleet/v1/recover-cert` (3.11, A3-M2): the 3.11 checks, then either the stored answer of an exact retry or
    /// a new-generation certificate, stored in the record and written to disk **before** the answer is returned.
    /// Ok is (answer, retry).
    pub fn recover(&mut self, vault: &dyn Vault, presented_der: &[u8], body: &Value, t: i64) -> Result<(Value, bool, Value), (Refusal, &'static str)> {
        let refuse = |why| (Refusal::of("recovery-refused"), why);
        let presented = Cert::from_der(presented_der).ok_or(refuse("serial"))?;
        let relay_id = body.get("relayId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let idx = self.recovery.iter().rposition(|r| r.relay_id == relay_id);
        let issuing_cert = self.gen_cert(self.issuing);
        let first = {
            let rec = idx.map(|i| &self.recovery[i]);
            match recovery_check(rec, &self.console_id, &presented.serial, &presented.spki, body, t) {
                Err(why) => return Err(refuse(why)),
                Ok(Some(issued)) => {
                    let new_serial = x509::serial_hex(&issued.cert).unwrap_or_default();
                    let detail = json!({ "oldSerial": presented.serial, "newSerial": new_serial, "generation": self.issuing, "retry": true });
                    return Ok((json!({ "ok": true, "cert": b64u(&issued.cert), "caCert": b64u(&issuing_cert) }), true, detail));
                }
                Ok(None) => idx.ok_or(refuse("no-record"))?,
            }
        };
        let generation = self.recovery[first].generation;
        if generation != self.issuing {
            return Err(refuse("no-record"));
        }
        let spki_new = crate::fleet_wire::b64u_of(body.get("spkiNew")).ok_or(refuse("sig-new"))?;
        let (cert, serial, _) = self.issue_relay(vault, &relay_id, &spki_new, generation, t).map_err(|_| refuse("sig-new"))?;
        let digest = request_sha256(body).map_err(refuse)?;
        self.recovery[first].issued = Some(Issued { cert: cert.clone(), spki_new, request_sha256: digest });
        if self.save().is_err() {
            self.recovery[first].issued = None;
            return Err((Refusal::new(503, "fleet-state-unreadable", "The console could not save the recovery. Try again."), "save"));
        }
        let detail = json!({ "oldSerial": presented.serial, "newSerial": serial, "generation": generation, "retry": false });
        Ok((json!({ "ok": true, "cert": b64u(&cert), "caCert": b64u(&issuing_cert) }), false, detail))
    }

    /// The relay connected normally with a certificate a recovery issued: the record is closed and its stored answer
    /// wiped (A3-M2). True when a record changed.
    pub fn recovery_connected(&mut self, relay_id: &str, serial: &str) -> bool {
        let mut changed = false;
        for r in self.recovery.iter_mut().filter(|r| r.relay_id == relay_id && !r.closed) {
            if r.issued.as_ref().and_then(|i| x509::serial_hex(&i.cert)).as_deref() == Some(serial) {
                r.closed = true;
                r.issued = None;
                changed = true;
            }
        }
        if changed {
            let _ = self.save();
        }
        changed
    }

    /// Whether an open recovery record matches a presented old-generation certificate (the verifier's admission to
    /// a recovery-only connection).
    pub fn recovery_candidate(&self, relay_id: &str, serial: &str, spki: &[u8], t: i64) -> bool {
        self.recovery.iter().any(|r| r.relay_id == relay_id && !r.closed && t <= r.until && r.old_serial == serial && r.old_spki == spki)
    }

    /// The 5.3 `GET fleet/trust` view without `ok` and `relays` (F7 `trust_view`).
    pub fn trust_view(&self) -> Value {
        json!({
            "caGenerations": self.generations.iter().map(|g| json!({ "generation": g.generation, "fingerprint": g.pin(), "state": g.state.as_str(), "notAfter": g.not_after_ms() })).collect::<Vec<_>>(),
            "manifest": { "seq": self.manifest.get("seq"), "issuedAt": self.manifest.get("issuedAt"), "leaves": self.manifest.get("leaves"), "revoked": self.manifest.get("revoked") },
        })
    }

    /// Days until the issuing CA ends.
    pub fn ca_days_left(&self, t: i64) -> Option<i64> {
        self.issuing_cert().map(|g| (g.not_after_ms() - t).div_euclid(DAY_MS))
    }

    /// The incoming generation of a normal rollover, if any.
    pub fn incoming(&self) -> Option<u64> {
        self.generations.iter().find(|g| g.state == GenState::Incoming).map(|g| g.generation)
    }
}

// ── Offline commands (5.2; f-console dispatches them under console.lock) ────────────────────────────────────

/// `lucid-relay console fleet-ca replace --compromised` or `--lost` (3.11, 3.12): a new generation, every older one
/// distrusted, every relay serial of those generations denied, one recovery record per relay (its current serial
/// and SPKI from the registry, 90 days), a new server leaf under the new CA (the old one revoked) and a manifest it
/// signs. Ok is the words the operator reads to admins.
pub fn replace_offline(state_dir: &Path, why: &str, high: bool, t: i64) -> Result<String, String> {
    if why != "compromised" && why != "lost" {
        return Err("fleet-ca replace needs --compromised or --lost".into());
    }
    let env = |k: &str| std::env::var(k).ok();
    let mut seal = crate::console_seal::Seal::open_as(state_dir, &env, high, crate::console_seal::SealIdentity::Console)?;
    if !Vault::usable(&seal) {
        return Err("the sealed store cannot be used here; run lucid-relay console seal-setup --role console first".into());
    }
    let registry = crate::console_fleet::Registry::load(state_dir)?;
    let mut seeds = Vec::new();
    for r in registry.relays.values() {
        if matches!(r.state, crate::console_fleet::RelayState::Left | crate::console_fleet::RelayState::Removed) {
            continue;
        }
        let serials: Vec<SerialSeed> = r.serials.iter().map(|s| (s.serial.clone(), s.not_after, s.current, unb64u(&s.spki).unwrap_or_default())).collect();
        seeds.push((r.id.clone(), serials));
    }
    let text = replace_with(state_dir, &mut seal, why, &seeds, t)?;
    Ok(text)
}

/// One serial of a relay for `replace_with`: (serial, notAfter, current, spki DER).
pub type SerialSeed = (String, i64, bool, Vec<u8>);
/// A relay for `replace_with`: (relayId, its serials).
pub type RelaySeed = (String, Vec<SerialSeed>);

/// The work of `replace_offline` on any vault and registry snapshot: `seeds` is (relayId, [(serial, notAfter,
/// current, spki DER)]).
pub fn replace_with(state_dir: &Path, vault: &mut dyn Vault, why: &str, seeds: &[RelaySeed], t: i64) -> Result<String, String> {
    let trust = read_trust(state_dir)?.ok_or("this console has no management CA yet; nothing to replace")?;
    let mut ca = FleetCa::from_files(state_dir, &trust, "", &[]).ok_or_else(|| format!("{TRUST_FILE} or {CA_FILE} does not read back"))?;
    ca.denied = Denied::load(state_dir)?;
    // The new CA names the same host as the old one.
    let host = ca.generations.last().and_then(|g| Cert::from_der(&g.cert)).and_then(|c| c.names.subject.iter().find(|(o, _)| o == x509::OID_O).map(|(_, v)| v.clone())).unwrap_or_default();
    let names = ca.current_cert_names();
    ca.host = host;
    ca.names = names;
    let next = ca.generations.iter().map(|g| g.generation).max().unwrap_or(0) + 1;
    for g in &mut ca.generations {
        g.state = GenState::Distrusted;
    }
    ca.draw_ca(vault, next, GenState::Active, t)?;
    ca.issuing = next;
    ca.rollover_at = None;
    for (relay, serials) in seeds {
        for (serial, not_after, _, _) in serials {
            ca.denied.deny(serial, *not_after);
        }
        if let Some((serial, _, _, spki)) = serials.iter().find(|s| s.2) {
            ca.recovery.retain(|r| &r.relay_id != relay);
            ca.recovery.push(Recovery { relay_id: relay.clone(), old_serial: serial.clone(), old_spki: spki.clone(), until: t + RECOVERY_MS, generation: next, issued: None, closed: false });
        }
    }
    let old = ca.current.clone();
    ca.draw_server(vault, SERVER_KEY, t)?;
    ca.next = None;
    ca.next_cert.clear();
    let _ = vault.remove(SERVER_KEY_NEXT);
    ca.tail = None;
    if let Some(o) = old {
        ca.revoked.push((o.spki_sha256, o.serial, t, o.not_after));
    }
    ca.reissue(vault, t)?;
    let fingerprint = ca.generations.last().map(Generation::pin).unwrap_or_default();
    ca.pending_audit.push(("fleet.ca.replace".into(), json!({ "generation": next, "fingerprint": fingerprint, "why": why })));
    ca.save()?;
    Ok(format!("New management CA {next}, fingerprint {fingerprint}. Each relay's operator confirms it on the relay."))
}

impl FleetCa {
    fn current_cert_names(&self) -> Vec<String> {
        Cert::from_der(&self.current_cert).map(|c| c.names.dns.iter().skip(1).cloned().collect()).unwrap_or_default()
    }
}

/// `lucid-relay console fleet-ca status` (5.2): generations, pins, the manifest `seq` and the open recovery records.
pub fn status_offline(state_dir: &Path) -> Result<String, String> {
    let Some(trust) = read_trust(state_dir)? else { return Ok("This console has no management CA yet.".into()) };
    let ca = FleetCa::from_files(state_dir, &trust, "", &[]).ok_or_else(|| format!("{TRUST_FILE} or {CA_FILE} does not read back"))?;
    let mut out = Vec::new();
    for g in &ca.generations {
        out.push(format!("CA {}: {}, fingerprint {}, ends {}", g.generation, g.state.as_str(), g.pin(), crate::codec::iso_time(g.not_after_ms())));
    }
    out.push(format!("Trust list: seq {}, issued {}", ca.seq, crate::codec::iso_time(ca.issued_at())));
    let open = ca.recovery.iter().filter(|r| !r.closed).count();
    let done = ca.recovery.iter().filter(|r| r.closed).count();
    out.push(format!("Relays still to replace their certificate: {open} (done or ended: {done})"));
    Ok(out.join("\n"))
}

/// A fresh, empty folder for one test.
#[cfg(test)]
pub fn tests_dir(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("lucid-fleet-{name}-{}-{}-{n}", std::process::id(), crate::codec::now_ms()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::unhex;

    fn dir(name: &str) -> PathBuf {
        tests_dir(name)
    }

    const T0: i64 = 1_800_000_000_000;
    const CID: &str = "c_0123456789abcdef";

    fn fresh(name: &str) -> (PathBuf, MemVault, FleetCa) {
        let d = dir(name);
        let mut v = MemVault::default();
        let ca = FleetCa::open(&d, &mut v, CID, "console.example.com", &["localhost".into()], T0);
        assert_eq!(ca.health, Health::Ready);
        (d, v, ca)
    }

    #[test]
    fn first_start_draws_ca_server_and_manifest_and_reopens() {
        let (d, mut v, ca) = fresh("first");
        assert_eq!(ca.issuing, 1);
        assert!(v.map.contains_key("fleet-ca-key") && v.map.contains_key(SERVER_KEY));
        let m = &ca.manifest;
        assert_eq!(m["seq"], 1);
        assert_eq!(m["leaves"].as_array().unwrap().len(), 1);
        let (chain, _) = ca.server_identity(&v).unwrap();
        x509::server_leaf(&chain[0], &chain[1], "console.example.com").unwrap();
        x509::server_leaf(&chain[0], &chain[1], "localhost").unwrap();
        let again = FleetCa::open(&d, &mut v, CID, "console.example.com", &[], T0 + 1);
        assert_eq!((again.health, again.seq, again.issuing), (Health::Ready, 1, 1));
        assert_eq!(again.pin(), ca.pin());
    }

    #[test]
    fn seal_loss_closes_the_port_keeps_every_file_and_draws_nothing() {
        let (d, _, _) = fresh("lost");
        let before: Vec<Vec<u8>> = [CA_FILE, SERVER_FILE, TRUST_FILE].iter().map(|f| std::fs::read(d.join(f)).unwrap()).collect();
        // the sealed store lost its data key
        let mut lost = MemVault { broken: true, ..Default::default() };
        let ca = FleetCa::open(&d, &mut lost, CID, "console.example.com", &[], T0 + 5);
        assert_eq!(ca.health, Health::Lost);
        assert!(ca.pin().is_none());
        // the store works but the CA key is gone
        let mut empty = MemVault::default();
        assert_eq!(FleetCa::open(&d, &mut empty, CID, "console.example.com", &[], T0 + 5).health, Health::Lost);
        assert!(empty.map.is_empty(), "no replacement CA or server key is drawn");
        let after: Vec<Vec<u8>> = [CA_FILE, SERVER_FILE, TRUST_FILE].iter().map(|f| std::fs::read(d.join(f)).unwrap()).collect();
        assert_eq!(before, after);
        // with no CA at all and no provider: seal needed, nothing drawn
        let d2 = dir("sealneeded");
        let mut none = MemVault { broken: true, ..Default::default() };
        assert_eq!(FleetCa::open(&d2, &mut none, CID, "h", &[], T0).health, Health::SealNeeded);
        assert!(!d2.join(TRUST_FILE).exists());
        // an unreadable denied list keeps the port closed
        std::fs::write(d.join(DENIED_FILE), "{").unwrap();
        let mut v = MemVault::default();
        assert_eq!(FleetCa::open(&d, &mut v, CID, "h", &[], T0).health, Health::Unreadable);
    }

    #[test]
    fn a_lost_server_key_alone_is_replaced_and_revoked() {
        let (d, mut v, ca) = fresh("serverlost");
        let old = ca.current.clone().unwrap();
        v.map.remove(SERVER_KEY);
        let again = FleetCa::open(&d, &mut v, CID, "console.example.com", &[], T0 + 10);
        assert_eq!(again.health, Health::Ready);
        assert!(again.revoked.iter().any(|(s, _, _, _)| *s == old.spki_sha256));
        assert!(again.manifest["revoked"].as_array().unwrap().iter().any(|r| r["spkiSha256"] == json!(old.spki_sha256)));
        assert!(again.seq > ca.seq);
    }

    #[test]
    fn leaf_rotation_lists_next_14_days_ahead_and_drops_the_old_after_7() {
        let (_, mut v, mut ca) = fresh("rotate");
        let first = ca.current.clone().unwrap();
        let t_next = first.not_after - NEXT_LEAF_BEFORE_MS;
        let pushes = ca.tick(&mut v, t_next);
        assert!(ca.next.is_some());
        let m = pushes.iter().find_map(|p| if let Push::Manifest(m) = p { Some(m.clone()) } else { None }).unwrap();
        let roles: Vec<&str> = m["leaves"].as_array().unwrap().iter().map(|l| l["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["current", "next"]);
        assert!(!ca.tick(&mut v, t_next + NEXT_LEAF_USE_AFTER_MS - 1).contains(&Push::ServerChanged));
        assert!(ca.tick(&mut v, t_next + NEXT_LEAF_USE_AFTER_MS).contains(&Push::ServerChanged));
        assert_ne!(ca.current.as_ref().unwrap().serial, first.serial);
        assert_eq!(ca.tail.as_ref().unwrap().serial, first.serial);
        ca.tick(&mut v, t_next + NEXT_LEAF_USE_AFTER_MS + OLD_LEAF_TAIL_MS);
        assert!(ca.tail.is_none());
        assert_eq!(ca.manifest["leaves"].as_array().unwrap().len(), 1);
        // the manifest is reissued daily even without a change
        let seq = ca.seq;
        let t = ca.issued_at();
        ca.tick(&mut v, t + MANIFEST_EVERY_MS);
        assert_eq!(ca.seq, seq + 1);
    }

    #[test]
    fn rollover_announces_next_ca_and_retires_the_old_after_the_overlap() {
        let (_, mut v, mut ca) = fresh("rollover");
        let (g, fp) = ca.ca_rollover(&mut v, T0 + 1).unwrap();
        assert_eq!(g, 2);
        assert_eq!(ca.manifest["nextCa"]["generation"], 2);
        assert_eq!(ca.manifest["nextCa"]["fingerprint"], json!(fp));
        assert_eq!(ca.manifest["caGeneration"], 1, "signed by the old generation");
        let pushes = ca.tick(&mut v, T0 + 1 + OVERLAP_MS);
        assert_eq!(ca.issuing, 2);
        assert!(pushes.contains(&Push::DenyGeneration(1)));
        let d = pushes.iter().find_map(|p| if let Push::Distrust(d) = p { Some(d.clone()) } else { None }).unwrap();
        let ca2 = ca.gen_cert(2);
        assert!(x509::verify_p384(&Cert::from_der(&ca2).unwrap().spki, &distrust_input(CID, 1), &crate::codec::unb64u(d["sig"].as_str().unwrap()).unwrap()));
        assert_eq!(ca.generations[0].state, GenState::Retired);
        assert_eq!(ca.manifest["caGeneration"], 2);
    }

    #[test]
    fn an_expired_ca_closes_the_port() {
        let (_, mut v, mut ca) = fresh("expired");
        let end = ca.issuing_cert().unwrap().not_after_ms();
        ca.tick(&mut v, end + 1);
        assert_eq!(ca.health, Health::Expired);
    }

    /// Recovery vector (3.11, A3-M2): the check order and the retry rule.
    #[test]
    fn recovery_cases_of_the_vector() {
        let path = format!("{}/tests/admin_console_fleet_x509_v1.json", env!("CARGO_MANIFEST_DIR"));
        let v: Value = parse_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let r = &v["recovery"];
        let console_id = v["console_id"].as_str().unwrap().to_owned();
        let generation = r["new_generation"].as_u64().unwrap();
        let record_of = |rec: &Value| -> Option<Recovery> {
            if rec.is_null() {
                return None;
            }
            let issued = match &rec["issued"] {
                Value::Null => None,
                i => Some(Issued { cert: unb64u(i["cert"].as_str().unwrap()).unwrap(), spki_new: unb64u(i["spkiNew"].as_str().unwrap()).unwrap(), request_sha256: crate::fleet_wire::hash_of(i.get("requestSha256")).unwrap() }),
            };
            Some(Recovery {
                relay_id: rec["relayId"].as_str().unwrap().into(),
                old_serial: rec["oldSerial"].as_str().unwrap().into(),
                old_spki: unb64u(rec["oldSpki"].as_str().unwrap()).unwrap(),
                until: rec["until"].as_i64().unwrap(),
                generation,
                issued,
                closed: rec["closed"].as_bool().unwrap(),
            })
        };
        assert_eq!(hex(&recover_input(&console_id, "r_x", "41", b"k", generation).unwrap()[..4]), "00000016");
        for c in r["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let record = record_of(&c["record"]);
            // The vector writes serials as raw hex; meet_x509 prints them without leading zeros, and the vector's are
            // never led by a zero byte, so they compare equal.
            let got = recovery_check(record.as_ref(), &console_id, c["presented_serial_hex"].as_str().unwrap(), &unhex(c["presented_spki_hex"].as_str().unwrap()).unwrap(), &c["body"], c["now_ms"].as_i64().unwrap());
            match (c["ok"].as_bool().unwrap(), got) {
                (true, Ok(i)) => {
                    assert_eq!(i.is_some(), c["retry"].as_bool().unwrap(), "{name}");
                    if let Some(i) = i {
                        assert_eq!(b64u(&i.cert), c["answer"]["cert"].as_str().unwrap(), "{name}");
                    }
                }
                (false, Err(why)) => assert_eq!(Some(why), c["why"].as_str(), "{name}"),
                (want, got) => panic!("{name}: wanted ok {want}, got {got:?}"),
            }
        }
        assert_eq!(hex(&request_sha256(&r["cases"][0]["body"]).unwrap()), r["request_sha256"].as_str().unwrap());
    }

    /// A relay's key, certificate, serial and notAfter.
    type RelayCert = (Key, Vec<u8>, String, i64);

    fn relay_with_cert(ca: &FleetCa, v: &MemVault, id: &str) -> RelayCert {
        let k = Key::generate(Curve::P256).unwrap();
        let (cert, serial, na) = ca.issue_relay(v, id, &k.spki(), ca.issuing, T0).unwrap();
        (k, cert, serial, na)
    }

    fn recover_body(old: &Key, new: &Key, relay: &str, serial: &str, generation: u64) -> Value {
        let input = recover_input(CID, relay, serial, &new.spki(), generation).unwrap();
        json!({ "relayId": relay, "spkiNew": b64u(&new.spki()), "sigOld": b64u(&old.sign(&input).unwrap()), "sigNew": b64u(&new.sign(&input).unwrap()) })
    }

    /// End to end on the console side (A2-H2, A3-M2): three relays; `fleet-ca replace --compromised` denies every old
    /// serial and records recovery; each relay's recovery issues a generation-2 certificate; a dropped first answer
    /// is retried and gets the same certificate; a changed request is refused; after the first normal connection a
    /// retry is refused; after `until` a retry is refused; a thief's certificate for another key is refused.
    #[test]
    fn compromise_replace_and_idempotent_recovery() {
        for why in ["compromised", "lost"] {
            let (d, mut v, ca) = fresh(&format!("replace-{why}"));
            let relays: Vec<(String, RelayCert)> = (0..3).map(|i| (format!("r_000000000000000{i}"), relay_with_cert(&ca, &v, &format!("r_000000000000000{i}")))).collect();
            let old_ca = ca.gen_cert(1);
            let seeds: Vec<RelaySeed> = relays.iter().map(|(id, (k, _, s, na))| (id.clone(), vec![(s.clone(), *na, true, k.spki())])).collect();
            if why == "lost" {
                // the old CA key is gone; replace still works from the files
                v.map.remove("fleet-ca-key");
            }
            let words = replace_with(&d, &mut v, why, &seeds, T0 + 100).unwrap();
            assert!(words.starts_with("New management CA 2, fingerprint "), "{words}");
            let mut ca = FleetCa::open(&d, &mut v, CID, "console.example.com", &[], T0 + 200);
            assert_eq!((ca.health, ca.issuing), (Health::Ready, 2));
            assert_eq!(ca.generations[0].state, GenState::Distrusted);
            assert!(ca.pending_audit.iter().any(|(a, _)| a == "fleet.ca.replace"));
            for (id, (k, cert, serial, _)) in &relays {
                assert!(ca.denied.contains(serial), "every old serial is denied");
                assert!(ca.recovery_candidate(id, serial, &k.spki(), T0 + 200));
                let new = Key::generate(Curve::P256).unwrap();
                let body = recover_body(k, &new, id, serial, 2);
                let (a1, retry1, _) = ca.recover(&v, cert, &body, T0 + 300).unwrap();
                assert!(!retry1);
                // the record holds the issued certificate on disk before the answer: a fresh open sees it
                let reopened = FleetCa::open(&d, &mut v, CID, "console.example.com", &[], T0 + 301);
                assert!(reopened.recovery.iter().any(|r| r.relay_id == *id && r.issued.is_some()));
                // the first answer was dropped; the exact retry gets the same certificate
                let (a2, retry2, detail) = ca.recover(&v, cert, &body, T0 + 400).unwrap();
                assert!(retry2 && detail["retry"] == json!(true));
                assert_eq!(a1, a2);
                let new_cert = unb64u(a2["cert"].as_str().unwrap()).unwrap();
                let (rid, _, _) = x509::relay_leaf(&new_cert, &ca.gen_cert(2), T0 + 400).unwrap();
                assert_eq!(&rid, id);
                assert_eq!(x509::server_leaf(&unb64u(a2["caCert"].as_str().unwrap()).unwrap(), &ca.gen_cert(2), "x").err(), Some("usage"));
                // a changed request (another key) against the issued record is refused
                let other = Key::generate(Curve::P256).unwrap();
                assert_eq!(ca.recover(&v, cert, &recover_body(k, &other, id, serial, 2), T0 + 500).err().unwrap().1, "issued-different");
                // first normal connection: the stored answer is wiped and a retry is refused
                assert!(ca.recovery_connected(id, &x509::serial_hex(&new_cert).unwrap()));
                assert_eq!(ca.recover(&v, cert, &body, T0 + 600).err().unwrap().1, "closed");
                // the old serial stays denied
                assert!(ca.denied.contains(serial));
            }
            // a thief's certificate minted with the old CA for another key fails on the stored SPKI
            let (id, (k, _, serial, _)) = &relays[0];
            let mut ca2 = FleetCa::open(&d, &mut v, CID, "console.example.com", &[], T0 + 700);
            ca2.recovery.iter_mut().for_each(|r| {
                r.closed = false;
                r.issued = None;
            });
            let thief = Key::generate(Curve::P256).unwrap();
            let forged = x509::tbs(&Spec { profile: Profile::Relay { relay_id: id.clone() }, serial: &x509::serial_bytes(serial).unwrap(), not_before_ms: T0, not_after_ms: T0 + DAY_MS * 90, spki: &thief.spki(), issuer: Some(&old_ca) }).unwrap();
            let forged = x509::certificate(&forged, b"not-a-signature");
            let body = recover_body(&thief, &Key::generate(Curve::P256).unwrap(), id, serial, 2);
            assert_eq!(ca2.recover(&v, &forged, &body, T0 + 800).err().unwrap().1, "spki");
            // a wrong sigOld with the right certificate
            let new = Key::generate(Curve::P256).unwrap();
            let mut bad = recover_body(k, &new, id, serial, 2);
            bad["sigOld"] = bad["sigNew"].clone();
            let good_cert = relays[0].1 .1.clone();
            assert_eq!(ca2.recover(&v, &good_cert, &bad, T0 + 800).err().unwrap().1, "sig-old");
            let mut bad = recover_body(k, &new, id, serial, 2);
            bad["sigNew"] = json!("");
            assert_eq!(ca2.recover(&v, &good_cert, &bad, T0 + 800).err().unwrap().1, "sig-new");
            // after `until`
            assert_eq!(ca2.recover(&v, &good_cert, &recover_body(k, &new, id, serial, 2), T0 + 100 + RECOVERY_MS + 1).err().unwrap().1, "expired");
            assert!(status_offline(&d).unwrap().contains("CA 2: active"));
        }
    }

    #[test]
    fn denied_list_round_trips() {
        let d = dir("denied");
        let mut den = Denied::default();
        den.deny("abc", T0);
        den.deny("abc", T0);
        den.save(&d).unwrap();
        let back = Denied::load(&d).unwrap();
        assert_eq!(back.list.len(), 1);
        assert!(back.contains("abc"));
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_ca.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
