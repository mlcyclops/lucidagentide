// Contract API-1 (docs/api/contract.md) 9.3: the audit checkpoint keys. Each org and source has a dedicated P-256
// key (never a token key) whose certificate the org's Meet CA issues (`meet_ca::issue_checkpoint`: SAN
// `urn:lucid-meet:org:<org>`, digitalSignature, no extendedKeyUsage, one year). Every retired certificate is kept for
// the audit retention (400 days after it retired) and served at `I/v1/audit/keys` (`RR/v1/audit/keys`), so old
// checkpoints stay verifiable.
//
// Keys are sealed as `api-checkpoint-<org>-<gen>`: on the console in the console's sealed store (as the token key,
// 5.3), on a relay in the store its local token keys use (`api_listener.rs`). The owner-only record
// `<state>/api-checkpoint/<org>.json` (flushed to disk) holds the certified key's generation and certificate chain,
// the generation waiting for a certificate, and the retired certificates. The console certifies its own key at once
// through the injected `IssueFn`; a relay sends a request (`relay_checkpoint_csr`) and installs what the console
// issued (`install`), both through the fleet ops. A retired key's sealed copy is removed once its successor is on
// record; only its certificate stays.
//
// Signatures are ES256 in the JOSE form (64 bytes, r||s) over the bytes `api_audit::checkpoint_signed_bytes` gives.

use crate::api_audit::{org_ok, CheckpointSigner, PseudonymKeys, RETENTION_SECS};
use crate::codec::{hex, parse_json, sha256, stringify};
use crate::fleet_ca::{vault_do, VaultLock};
use crate::fleet_x509::{self as x509, Curve, Key};
use crate::meet_json::{b64, b64_strict};
use crate::meet_x509::Cert;
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The folder of the records, under the state folder.
pub const CHECKPOINT_DIR: &str = "api-checkpoint";
/// A new key is certified once the current certificate has fewer than 30 days left.
pub const RENEW_BEFORE_S: i64 = 30 * 86_400;
/// The console asks its CA again at most once a minute while it has no usable certificate.
const RETRY_S: i64 = 60;

/// The console's Meet CA issuing a checkpoint certificate: (holder `console` or a relay id, org, request DER, ms)
/// to (certificate DER, chain DER with the CA first).
pub type IssueFn = Arc<dyn Fn(&str, &str, &[u8], i64) -> Result<(Vec<u8>, Vec<Vec<u8>>), String> + Send + Sync>;

/// The sealed name of an org's checkpoint key generation.
pub fn seal_name(org: &str, gen: u64) -> String {
    format!("api-checkpoint-{org}-{gen}")
}

/// `cp-` and the first 16 hex of SHA-256 of the key's SubjectPublicKeyInfo DER.
pub fn checkpoint_kid(spki: &[u8]) -> String {
    format!("cp-{}", &hex(&sha256(spki))[..16])
}

/// A certificate as `audit/keys` lists it: `{kid, source?, x5c (standard base64 DER, CA after), not_before,
/// not_after (unix s), status: current | retired, retired_at?}`.
pub fn cert_value(source: Option<&str>, cert_der: &[u8], chain: &[Vec<u8>], retired_at: Option<i64>) -> Option<Value> {
    let cert = Cert::from_der(cert_der)?;
    let mut x5c = vec![b64(cert_der)];
    x5c.extend(chain.iter().map(|c| b64(c)));
    let mut v = json!({
        "kid": checkpoint_kid(&cert.spki),
        "x5c": x5c,
        "not_before": cert.not_before,
        "not_after": cert.not_after,
        "status": if retired_at.is_some() { "retired" } else { "current" },
    });
    if let Some(s) = source {
        v["source"] = json!(s);
    }
    if let Some(at) = retired_at {
        v["retired_at"] = json!(at);
    }
    Some(v)
}

/// The certificate DER of an `audit/keys` entry (`x5c[0]`).
pub fn cert_der_of(v: &Value) -> Option<Vec<u8>> {
    b64_strict(v.get("x5c")?.get(0)?.as_str()?)
}

/// Whether `sig` (ES256, r||s) over `signed` (the lp bytes of a checkpoint) was made by the certificate's key (the
/// console checks the checkpoints of relay chains it receives with it).
pub fn verify(cert_der: &[u8], signed: &[u8], sig: &[u8]) -> bool {
    let Some(cert) = Cert::from_der(cert_der) else { return false };
    // a P-256 SubjectPublicKeyInfo ends with the 65-byte uncompressed point
    if !x509::is_p256_spki(&cert.spki) || cert.spki.len() < 65 {
        return false;
    }
    let point = &cert.spki[cert.spki.len() - 65..];
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point).verify(signed, sig).is_ok()
}

fn now_ms() -> i64 {
    crate::codec::now_ms()
}

// ── the record ──────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct Held {
    gen: u64,
    der: Vec<u8>,
    chain: Vec<Vec<u8>>,
}

#[derive(Default)]
struct Record {
    current: Option<Held>,
    pending: Option<u64>,
    /// (certificate, retired at, unix s)
    retired: Vec<(Held, i64)>,
}

fn held_json(h: &Held) -> Value {
    json!({"gen": h.gen, "der": b64(&h.der), "chain": h.chain.iter().map(|c| b64(c)).collect::<Vec<_>>()})
}

fn held_of(v: &Value) -> Option<Held> {
    let chain = v.get("chain")?.as_array()?.iter().map(|c| c.as_str().and_then(b64_strict)).collect::<Option<Vec<_>>>()?;
    Some(Held { gen: v.get("gen")?.as_u64()?, der: b64_strict(v.get("der")?.as_str()?)?, chain })
}

fn record_path(dir: &Path, org: &str) -> PathBuf {
    dir.join(CHECKPOINT_DIR).join(format!("{org}.json"))
}

fn load(dir: &Path, org: &str) -> Record {
    let Some(v) = std::fs::read_to_string(record_path(dir, org)).ok().and_then(|t| parse_json(&t)) else { return Record::default() };
    Record {
        current: v.get("current").and_then(held_of),
        pending: v.get("pending").and_then(Value::as_u64),
        retired: v.get("retired").and_then(Value::as_array).map(|a| a.iter().filter_map(|r| Some((held_of(r)?, r.get("retired_at")?.as_i64()?))).collect()).unwrap_or_default(),
    }
}

fn save(dir: &Path, org: &str, r: &Record) -> Result<(), String> {
    let v = json!({
        "current": r.current.as_ref().map(held_json),
        "pending": r.pending,
        "retired": r.retired.iter().map(|(h, at)| { let mut x = held_json(h); x["retired_at"] = json!(at); x }).collect::<Vec<_>>(),
    });
    crate::store::make_dir(&dir.join(CHECKPOINT_DIR)).map_err(|e| format!("the checkpoint key folder could not be made: {e}"))?;
    crate::fleet_local::write_durable(&record_path(dir, org), stringify(&v).as_bytes())
}

fn unseal(vault: &dyn VaultLock, org: &str, gen: u64) -> Option<Vec<u8>> {
    vault_do(vault, |v| v.get(&seal_name(org, gen)))
}

/// The key waiting for a certificate: the one on record when it still opens, else a fresh one sealed and recorded.
fn pending_key(dir: &Path, vault: &dyn VaultLock, org: &str) -> Result<Key, String> {
    let mut rec = load(dir, org);
    if let Some(key) = rec.pending.and_then(|g| unseal(vault, org, g)).and_then(|d| Key::from_pkcs8(Curve::P256, &d).ok()) {
        return Ok(key);
    }
    let gen = rec.current.iter().map(|h| h.gen).chain(rec.retired.iter().map(|(h, _)| h.gen)).chain(rec.pending).max().unwrap_or(0) + 1;
    let key = Key::generate(Curve::P256)?;
    vault_do(vault, |v| v.put(&seal_name(org, gen), key.pkcs8())).map_err(|e| format!("the checkpoint key could not be sealed: {e}"))?;
    rec.pending = Some(gen);
    save(dir, org, &rec)?;
    Ok(key)
}

/// A request for the org's checkpoint key waiting for a certificate (drawn and sealed when none waits): PKCS#10,
/// `CN=Lucid API audit checkpoint`, SAN URI `urn:lucid-meet:org:<org>`. A relay sends it to the console.
pub fn relay_checkpoint_csr(state_dir: &Path, vault: &dyn VaultLock, org: &str) -> Result<Vec<u8>, String> {
    if !org_ok(org) {
        return Err("that is not an organization id".into());
    }
    let key = pending_key(state_dir, vault, org)?;
    x509::csr(&key, crate::meet_ca::CHECKPOINT_CN, &[], &[], &[crate::meet_ca::checkpoint_uri(org)])
}

/// Install the certificate the console issued for the waiting key (its chain starts with the Meet CA): it must be
/// that key's, the org's checkpoint profile and in date. The previous certificate is retired (kept for the audit
/// retention) and its sealed key removed once the record is flushed.
pub fn install(state_dir: &Path, vault: &dyn VaultLock, org: &str, cert_der: &[u8], chain: &[Vec<u8>]) -> Result<(), String> {
    install_at(state_dir, vault, org, cert_der, chain, now_ms())
}

fn install_at(state_dir: &Path, vault: &dyn VaultLock, org: &str, cert_der: &[u8], chain: &[Vec<u8>], t_ms: i64) -> Result<(), String> {
    if !org_ok(org) {
        return Err("that is not an organization id".into());
    }
    let mut rec = load(state_dir, org);
    let gen = rec.pending.ok_or("no checkpoint key is waiting for a certificate")?;
    let key = unseal(vault, org, gen).and_then(|d| Key::from_pkcs8(Curve::P256, &d).ok()).ok_or("the waiting checkpoint key does not open")?;
    let ca = chain.first().ok_or("the certificate comes without its CA")?;
    let cert = crate::meet_ca::checkpoint_check(cert_der, org, ca, t_ms)?;
    if cert.spki != key.spki() {
        return Err("the certificate is not for the waiting checkpoint key".into());
    }
    let now = t_ms.div_euclid(1000);
    let old = rec.current.take();
    if let Some(o) = &old {
        rec.retired.push((o.clone(), now));
    }
    rec.retired.retain(|(_, at)| *at >= now - RETENTION_SECS);
    rec.current = Some(Held { gen, der: cert_der.to_vec(), chain: chain.to_vec() });
    rec.pending = None;
    save(state_dir, org, &rec)?;
    if let Some(o) = old {
        vault_do(vault, |v| {
            let _ = v.remove(&seal_name(org, o.gen));
        });
    }
    Ok(())
}

/// Whether the org has no checkpoint certificate in use or it has fewer than 30 days left (a relay then sends a new
/// request).
pub fn renewal_due(state_dir: &Path, org: &str, now_s: i64) -> bool {
    load(state_dir, org).current.and_then(|h| Cert::from_der(&h.der)).is_none_or(|c| c.not_after - now_s < RENEW_BEFORE_S)
}

/// The certified key's id while its certificate is in date.
fn current_kid(dir: &Path, org: &str, now_s: i64) -> Option<String> {
    let h = load(dir, org).current?;
    let c = Cert::from_der(&h.der)?;
    (c.not_before <= now_s && now_s <= c.not_after).then(|| checkpoint_kid(&c.spki))
}

fn sign_current(dir: &Path, vault: &dyn VaultLock, org: &str, payload: &[u8]) -> Option<Vec<u8>> {
    let h = load(dir, org).current?;
    let pkcs8 = unseal(vault, org, h.gen)?;
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8).ok()?;
    pair.sign(&SystemRandom::new(), payload).ok().map(|s| s.as_ref().to_vec())
}

fn certs_of(dir: &Path, org: &str, source: Option<&str>, now_s: i64) -> Vec<Value> {
    let rec = load(dir, org);
    let mut out: Vec<Value> = rec.current.iter().filter_map(|h| cert_value(source, &h.der, &h.chain, None)).collect();
    out.extend(rec.retired.iter().filter(|(_, at)| *at >= now_s - RETENTION_SECS).filter_map(|(h, at)| cert_value(source, &h.der, &h.chain, Some(*at))));
    out
}

// ── the console ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The console's checkpoint keys: certified at first use and again 30 days before the certificate ends.
pub struct ConsoleCheckpoints {
    dir: PathBuf,
    vault: Arc<dyn VaultLock>,
    issue: IssueFn,
    /// org -> when the CA was last asked (unix s).
    tried: Mutex<HashMap<String, i64>>,
}

impl ConsoleCheckpoints {
    pub fn new(state_dir: &Path, vault: Arc<dyn VaultLock>, issue: IssueFn) -> ConsoleCheckpoints {
        ConsoleCheckpoints { dir: state_dir.to_path_buf(), vault, issue, tried: Mutex::new(HashMap::new()) }
    }

    /// A new key for the org, certified by the Meet CA and installed; the previous certificate is retired. Ok is the
    /// new kid.
    pub fn rotate(&self, org: &str, t_ms: i64) -> Result<String, String> {
        let csr = relay_checkpoint_csr(&self.dir, &*self.vault, org)?;
        let (der, chain) = (self.issue)("console", org, csr.as_slice(), t_ms)?;
        install_at(&self.dir, &*self.vault, org, &der, &chain, t_ms)?;
        let cert = Cert::from_der(&der).ok_or("the certificate does not read")?;
        Ok(checkpoint_kid(&cert.spki))
    }

    fn ensure(&self, org: &str) -> Option<String> {
        let t = now_ms();
        let now = t.div_euclid(1000);
        if renewal_due(&self.dir, org, now) {
            let mut tried = self.tried.lock();
            if tried.get(org).is_none_or(|at| now - at >= RETRY_S) {
                tried.insert(org.to_owned(), now);
                drop(tried);
                if self.rotate(org, t).is_ok() {
                    self.tried.lock().remove(org);
                }
            }
        }
        current_kid(&self.dir, org, now)
    }
}

impl CheckpointSigner for ConsoleCheckpoints {
    fn kid(&self, org: &str) -> Option<String> {
        if !org_ok(org) {
            return None;
        }
        self.ensure(org)
    }

    fn sign(&self, org: &str, payload: &[u8]) -> Option<Vec<u8>> {
        org_ok(org).then(|| sign_current(&self.dir, &*self.vault, org, payload)).flatten()
    }

    fn certs(&self, org: &str) -> Vec<Value> {
        if !org_ok(org) {
            return Vec::new();
        }
        certs_of(&self.dir, org, Some("console"), now_ms().div_euclid(1000))
    }
}

// ── a relay ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// A relay's checkpoint keys: certified by the console through the fleet ops (`relay_checkpoint_csr`, `install`).
/// Every call reads the record, so an install is seen at once.
pub struct RelayCheckpoints {
    dir: PathBuf,
    vault: Arc<dyn VaultLock>,
}

impl RelayCheckpoints {
    pub fn new(state_dir: &Path, vault: Arc<dyn VaultLock>) -> RelayCheckpoints {
        RelayCheckpoints { dir: state_dir.to_path_buf(), vault }
    }
}

impl CheckpointSigner for RelayCheckpoints {
    fn kid(&self, org: &str) -> Option<String> {
        org_ok(org).then(|| current_kid(&self.dir, org, now_ms().div_euclid(1000))).flatten()
    }

    fn sign(&self, org: &str, payload: &[u8]) -> Option<Vec<u8>> {
        org_ok(org).then(|| sign_current(&self.dir, &*self.vault, org, payload)).flatten()
    }

    /// Without `source`: the relay's audit adds its relay id.
    fn certs(&self, org: &str) -> Vec<Value> {
        if !org_ok(org) {
            return Vec::new();
        }
        certs_of(&self.dir, org, None, now_ms().div_euclid(1000))
    }
}

/// A relay's pseudonym keys (11.4, `api-pseudonym-key`): the version in `api-pseudonym/<org>.json`, the key sealed as
/// `api-pseudonym-<org>-<pkv>`.
pub struct RelayPseudonymKeys {
    dir: PathBuf,
    vault: Arc<dyn VaultLock>,
}

impl RelayPseudonymKeys {
    pub fn new(state_dir: &Path, vault: Arc<dyn VaultLock>) -> RelayPseudonymKeys {
        RelayPseudonymKeys { dir: state_dir.to_path_buf(), vault }
    }
}

impl PseudonymKeys for RelayPseudonymKeys {
    fn current(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        if !org_ok(org) {
            return None;
        }
        let path = self.dir.join(crate::fleet_agent::API_PSEUDONYM_DIR).join(format!("{org}.json"));
        let pkv = parse_json(&std::fs::read_to_string(path).ok()?)?.get("pkv")?.as_u64()?;
        let key = vault_do(&*self.vault, |v| v.get(&crate::fleet_agent::api_pseudonym_seal_name(org, pkv)))?;
        Some((u32::try_from(pkv).ok()?, key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::{chain_hash, checkpoint_signed_bytes, ApiAudit, IngestError, Repr};
    use crate::codec::unb64u;
    use crate::fleet_ca::{tests_dir, MemVault};
    use crate::meet_ca::{test_ca, MeetCa};

    struct NoKey;

    impl PseudonymKeys for NoKey {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            None
        }
    }

    type TestVault = Arc<parking_lot::Mutex<MemVault>>;

    /// A console with a held Meet CA whose key is sealed in `vault`, and the issue hook over it.
    fn console_ca(dir: &Path, vault: &TestVault) -> (Arc<parking_lot::Mutex<MeetCa>>, IssueFn) {
        let ca = Arc::new(parking_lot::Mutex::new(test_ca(&dir.join("meet"), &mut *vault.lock(), None, now_ms())));
        let (c, v) = (ca.clone(), vault.clone());
        let issue: IssueFn = Arc::new(move |holder: &str, org: &str, csr: &[u8], t: i64| {
            let v = v.lock();
            let mut ca = c.lock();
            let issued = ca.issue_checkpoint(&*v, holder, org, csr, t).map_err(|e| e.message)?;
            Ok((issued.der, vec![ca.ca_der().to_vec()]))
        });
        (ca, issue)
    }

    fn checkpoints(a: &ApiAudit, org: &str) -> Vec<Value> {
        let es = a.read(org, "console", Repr::AsIs, 0, 1000).unwrap()["entries"].as_array().unwrap().clone();
        es.into_iter().filter(|e| e["action"] == "checkpoint").collect()
    }

    fn checks(cert_der: &[u8], cp: &Value) -> bool {
        let pj = unb64u(cp["payload"].as_str().unwrap()).unwrap();
        let sig = unb64u(cp["sig"].as_str().unwrap()).unwrap();
        verify(cert_der, &checkpoint_signed_bytes(&pj), &sig)
    }

    #[test]
    fn checkpoint_verifies_with_a_retired_certificate_after_rotation() {
        let dir = tests_dir("api-checkpoint-rotate");
        let vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let (ca, issue) = console_ca(&dir, &vault);
        let signer = Arc::new(ConsoleCheckpoints::new(&dir, vault.clone() as Arc<dyn VaultLock>, issue));
        let now = now_ms().div_euclid(1000);
        let a = ApiAudit::open(Some(&dir), "console", signer.clone(), Arc::new(NoKey), now);
        let call = serde_json::json!({"action": "api.call", "client": "c_1", "result": "ok", "check": "none"});
        a.record("acme", call.clone(), now).unwrap();
        a.tick(now + 400);
        let first_kid = checkpoints(&a, "acme")[0]["kid"].as_str().unwrap().to_owned();
        assert!(first_kid.starts_with("cp-"));
        let second_kid = signer.rotate("acme", now_ms()).unwrap();
        assert_ne!(first_kid, second_kid);
        a.record("acme", call, now + 500).unwrap();
        a.tick(now + 900);
        let cps = checkpoints(&a, "acme");
        assert_eq!(cps.len(), 2);
        assert_eq!(cps[1]["kid"], second_kid.as_str());
        let keys = a.keys("acme");
        assert_eq!(keys.len(), 2);
        let by_kid = |kid: &str| keys.iter().find(|k| k["kid"] == kid).unwrap().clone();
        let (old, new) = (by_kid(&first_kid), by_kid(&second_kid));
        assert_eq!((old["status"].as_str(), new["status"].as_str()), (Some("retired"), Some("current")));
        assert_eq!(old["source"], "console");
        let (old_der, new_der) = (cert_der_of(&old).unwrap(), cert_der_of(&new).unwrap());
        // the old checkpoint verifies with the retired certificate only, the new one with the current one only
        assert!(checks(&old_der, &cps[0]) && !checks(&new_der, &cps[0]));
        assert!(checks(&new_der, &cps[1]) && !checks(&old_der, &cps[1]));
        // both certificates chain to the Meet CA with the checkpoint profile
        let ca_der = ca.lock().ca_der().to_vec();
        assert!(crate::meet_ca::checkpoint_check(&old_der, "acme", &ca_der, now_ms()).is_ok());
        assert!(crate::meet_ca::checkpoint_check(&new_der, "acme", &ca_der, now_ms()).is_ok());
        // the retired key itself is no longer sealed
        assert!(vault.lock().map.keys().filter(|k| k.starts_with("api-checkpoint-acme-")).count() == 1);
    }

    #[test]
    fn relay_request_install_and_sign() {
        let console_dir = tests_dir("api-checkpoint-console");
        let relay_dir = tests_dir("api-checkpoint-relay");
        let console_vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let relay_vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let (_ca, issue) = console_ca(&console_dir, &console_vault);
        let relay = RelayCheckpoints::new(&relay_dir, relay_vault.clone() as Arc<dyn VaultLock>);
        let now = now_ms().div_euclid(1000);
        assert!(renewal_due(&relay_dir, "acme", now));
        assert_eq!(relay.kid("acme"), None);
        let csr = relay_checkpoint_csr(&relay_dir, &*relay_vault, "acme").unwrap();
        // the same waiting key until it is certified
        let again = relay_checkpoint_csr(&relay_dir, &*relay_vault, "acme").unwrap();
        assert_eq!(x509::read_request(&csr).unwrap().spki, x509::read_request(&again).unwrap().spki);
        let (der, chain) = issue("r_00000000000000aa", "acme", csr.as_slice(), now_ms()).unwrap();
        // another org's certificate is refused
        assert!(install(&relay_dir, &*relay_vault, "beta", &der, &chain).is_err());
        install(&relay_dir, &*relay_vault, "acme", &der, &chain).unwrap();
        assert!(!renewal_due(&relay_dir, "acme", now));
        let kid = relay.kid("acme").unwrap();
        let signed = checkpoint_signed_bytes(b"{\"org\":\"acme\"}");
        let sig = relay.sign("acme", &signed).unwrap();
        assert_eq!(sig.len(), 64);
        assert!(verify(&der, &signed, &sig));
        let certs = relay.certs("acme");
        assert_eq!(certs.len(), 1);
        assert_eq!(certs[0]["kid"], kid.as_str());
        assert!(certs[0].get("source").is_none());
        // the console keeps it for I/v1/audit/keys
        let c = ApiAudit::open(Some(&console_dir), "console", Arc::new(ConsoleCheckpoints::new(&console_dir, console_vault.clone() as Arc<dyn VaultLock>, issue)), Arc::new(NoKey), now);
        c.add_keys("acme", "r_00000000000000aa", &der, &chain).unwrap();
        let keys = c.keys("acme");
        assert!(keys.iter().any(|k| k["kid"] == kid.as_str() && k["source"] == "r_00000000000000aa"));
    }

    #[test]
    fn relay_checkpoints_verify_on_ingest() {
        let console_dir = tests_dir("api-checkpoint-ingest-console");
        let relay_dir = tests_dir("api-checkpoint-ingest-relay");
        let relay = "r_00000000000000aa";
        let console_vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let relay_vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let (_ca, issue) = console_ca(&console_dir, &console_vault);
        let csr = relay_checkpoint_csr(&relay_dir, &*relay_vault, "acme").unwrap();
        let (der, chain) = issue(relay, "acme", csr.as_slice(), now_ms()).unwrap();
        install(&relay_dir, &*relay_vault, "acme", &der, &chain).unwrap();
        let now = now_ms().div_euclid(1000);
        let r = ApiAudit::open(Some(&relay_dir), relay, Arc::new(RelayCheckpoints::new(&relay_dir, relay_vault.clone() as Arc<dyn VaultLock>)), Arc::new(NoKey), now);
        r.record("acme", json!({"action": "api.call", "client": "c_1", "result": "ok"}), now).unwrap();
        r.tick(now + 400);
        let es = r.since("acme", Repr::AsIs, 0, 10);
        assert_eq!(es.len(), 2);
        assert_eq!(es[1]["action"], "checkpoint");
        let c = ApiAudit::open(Some(&console_dir), "console", Arc::new(ConsoleCheckpoints::new(&console_dir, console_vault.clone() as Arc<dyn VaultLock>, issue)), Arc::new(NoKey), now);
        // no certificate is stored for that relay yet
        assert!(matches!(c.ingest("acme", relay, Repr::AsIs, 1, 2, &es), Err(IngestError::Invalid(_))));
        c.add_keys("acme", relay, &der, &chain).unwrap();
        // a payload naming other heads, chained again, does not verify
        let mut bad = es[1].as_object().unwrap().clone();
        let zero = "00".repeat(32);
        let payload = json!({"org": "acme", "source": relay, "ts": bad["ts"].clone(), "heads": {"as_is": [0, zero], "pseudonymized": [0, zero], "removed": [0, zero]}});
        bad.insert("payload".into(), json!(crate::codec::b64u(&crate::console_audit::canonical_json(&payload).unwrap())));
        let prev = bad["prev"].as_str().unwrap().to_owned();
        let h = chain_hash(&Repr::AsIs.label("acme"), &prev, &bad).unwrap();
        bad.insert("hash".into(), json!(h));
        assert!(matches!(c.ingest("acme", relay, Repr::AsIs, 1, 2, &[es[0].clone(), Value::Object(bad)]), Err(IngestError::Invalid(_))));
        assert_eq!(c.head("acme", relay, Repr::AsIs).0, 0);
        // the relay's own pages go in, checkpoint and all
        for repr in Repr::ALL {
            let page = r.since("acme", repr, 0, 10);
            c.ingest("acme", relay, repr, 1, page.len() as u64, &page).unwrap();
        }
        assert_eq!(c.head("acme", relay, Repr::Removed), r.head("acme", relay, Repr::Removed));
        assert!(c.keys("acme").iter().any(|k| k["source"] == relay));
    }

    #[test]
    fn relay_pseudonym_keys_read_the_sealed_key() {
        let dir = tests_dir("api-checkpoint-pseudonym");
        let vault: TestVault = Arc::new(parking_lot::Mutex::new(MemVault::default()));
        let keys = RelayPseudonymKeys::new(&dir, vault.clone() as Arc<dyn VaultLock>);
        assert_eq!(keys.current("acme"), None);
        let body = serde_json::json!({"org": "acme", "pkv": 2, "key": crate::codec::b64u(&[9u8; 32]), "not_before": 1});
        crate::fleet_agent::api_pseudonym_key_store(&dir, &*vault, &body).unwrap();
        assert_eq!(keys.current("acme"), Some((2, vec![9u8; 32])));
        assert_eq!(keys.current("../acme"), None);
    }
}
