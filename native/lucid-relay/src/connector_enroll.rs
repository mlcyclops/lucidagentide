// Contract API-1 revision 5 (phase 1c), section 2.4 (enrollment and certification: keygen, install, renewal) and
// 2.6 (the app private key is sealed). Port of Python `connector/lucid_connector/service_client.py`
// `ServiceIdentity` for kind `app`, with `shared/meet_pki.py` `verify_chain` and `make_proof`.
//
// Per API app, `state_dir/apps/<name>/` holds `request.csr` (for the CA) and `cert.pem` (the leaf, then its chain,
// replaced atomically as one file). The private key is the sealed value `key-app-<name>` (`connector_seal`), a
// P-256 key made on this host by AWS-LC and never written in clear. `install` accepts a certificate only when its
// key is the sealed key, it is an app certificate (SAN URI `urn:lucid-meet:app`, exactly one
// `urn:lucid-meet:org:<org>`, `urn:lucid-meet:device:<16 hex>`, email `<name>@apps.<domain>`), it is in date and
// it chains to `client_ca`. Renewal at 30 days left: `renew_request` makes the next key (sealed as
// `key-app-<name>-next`) and the body of the relay's `POST /v1/apps/c/renew {csr_pem, proof, ts}`, the proof by the
// current key over the new request (op `sign_service_renewal`); `renew_install` checks the answer as `install`
// does and that it keeps principal, device and org, then swaps certificate and key. A swap cut short is finished by
// the next `load`.

use crate::ce_device as ce;
use crate::connector_seal::{make_private_dir, names, wipe, write_private, SealedStore};
use crate::fleet_x509::{self as fx, Curve, Key};
use crate::meet_x509::{der_to_pem, pem_blocks, Cert};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Service certificates renew at 30 days left (PC-1 N8).
pub const RENEW_LEFT_MS: i64 = 30 * 86_400_000;
pub const APPS_DIR: &str = "apps";
pub const CSR_FILE: &str = "request.csr";
pub const CERT_FILE: &str = "cert.pem";
/// The relay route a renewal is sent to (over the app's mTLS session).
pub const RENEW_ROUTE: &str = "/v1/apps/c/renew";
/// The signer op the renewal proof names.
pub const RENEW_OP: &str = "sign_service_renewal";
/// `meet_pki.PROOF_PREFIX`.
pub const PROOF_PREFIX: &str = "lucid-meet-proof/1|";
pub const BAD_APP_NAME: &str = "an app name is 1 to 32 of a-z, 0-9 and -, and not archive";
const APPS_DOMAIN: &str = "apps.";
/// The SAN URIs that name a certificate's kind; an app certificate names only `urn:lucid-meet:app`.
const KIND_URIS: [&str; 6] = [ce::CONNECTOR_URI, ce::APP_URI, ce::ARCHIVE_URI, ce::SSO_URI, ce::CONSOLE_URI, ce::RELAY_URI];

/// An API app's name (Python `ServiceIdentity`): 1 to 32 of a-z, 0-9 and `-`, and not `archive`.
pub fn app_name_ok(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') && name != "archive"
}

/// `meet_pki.proof_bytes`: `"lucid-meet-proof/1|" + op + "|" + sha256_hex(subject) + "|" + ts` (UTF-8).
pub fn proof_bytes(op: &str, subject: &[u8], ts: i64) -> Vec<u8> {
    format!("{PROOF_PREFIX}{op}|{}|{ts}", crate::codec::sha256_hex(subject)).into_bytes()
}

fn pem(label: &str, der: &[u8]) -> String {
    let b = crate::meet_json::b64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn csr_cn(app: &str) -> String {
    format!("lucid-connector app {app}")
}

/// `meet_pki.verify_chain`: `leaf` is issued by the root directly, or by one CA in `chain` (an intermediate with
/// pathLen 0 and keyCertSign) that the root issued and whose pathLen allows. Every certificate is in date at
/// `now_s` (seconds, both ends inclusive) and the root is a CA.
pub fn verify_chain(leaf: &Cert, chain: &[Vec<u8>], root_der: &[u8], now_s: i64) -> bool {
    let Some(root) = Cert::from_der(root_der) else { return false };
    let valid = |c: &Cert| c.not_before <= now_s && now_s <= c.not_after;
    if !valid(leaf) || !valid(&root) {
        return false;
    }
    let Some(root_usage) = fx::usage(root_der) else { return false };
    if !root_usage.ca {
        return false;
    }
    if leaf.issued_by(&root) {
        return true;
    }
    if root_usage.path_len.is_some_and(|n| n < 1) {
        return false;
    }
    for der in chain {
        let Some(inter) = Cert::from_der(der) else { continue };
        if inter.spki == root.spki {
            continue;
        }
        let Some(u) = fx::usage(der) else { continue };
        if !u.ca || u.path_len != Some(0) || !valid(&inter) || u.key_usage.is_none_or(|k| k & 0x04 == 0) {
            continue;
        }
        if inter.issued_by(&root) && leaf.issued_by(&inter) {
            return true;
        }
    }
    false
}

/// What an app certificate names.
struct Facts {
    principal: String,
    device: String,
    org: String,
}

/// The app certificate checks of Python `ServiceIdentity._check` that read the certificate alone.
fn app_facts(app: &str, cert: &Cert) -> Result<Facts, String> {
    let uris = &cert.names.uris;
    let kinds: Vec<&str> = KIND_URIS.iter().copied().filter(|k| uris.iter().any(|u| u == k)).collect();
    if kinds != [ce::APP_URI] {
        return Err("that is not an app certificate".to_string());
    }
    let mut orgs: Vec<&str> = uris.iter().filter_map(|u| u.strip_prefix(ce::ORG_URI_PREFIX)).filter(|o| !o.is_empty()).collect();
    orgs.sort_unstable();
    orgs.dedup();
    if orgs.len() != 1 {
        return Err("a service certificate names exactly one organization".to_string());
    }
    let principal = cert.names.emails.first().map(|e| e.trim().to_lowercase()).unwrap_or_default();
    let (local, domain) = principal.split_once('@').unwrap_or(("", ""));
    if local != app || !domain.starts_with(APPS_DOMAIN) || domain.len() <= APPS_DOMAIN.len() {
        return Err(format!("that certificate is for {principal}, not {app}"));
    }
    let device = crate::meet::uri_value(uris, crate::meet::DEVICE_URI_PREFIX);
    if device.is_empty() {
        return Err("that certificate names no device".to_string());
    }
    Ok(Facts { org: orgs[0].to_string(), principal, device })
}

fn first_cert(pem_text: &str) -> Option<Vec<u8>> {
    pem_blocks(pem_text.as_bytes(), "CERTIFICATE").into_iter().next().map(|(_, d)| d)
}

/// Every check `install` and `renew_install` make: Ok is the leaf, what it names and its chain (DER).
fn check(app: &str, cert_der: &[u8], chain_pem: &str, ca_pem: &str, key_spki: &[u8], now_ms: i64) -> Result<(Cert, Facts, Vec<Vec<u8>>), String> {
    let cert = Cert::from_der(cert_der).ok_or("that is not a certificate")?;
    if cert.spki != key_spki {
        return Err("that certificate is not for this host's key".to_string());
    }
    if !fx::is_p256_spki(&cert.spki) {
        return Err("an app certificate's key must be ECDSA P-256".to_string());
    }
    let facts = app_facts(app, &cert)?;
    let now_s = now_ms.div_euclid(1000);
    if now_s > cert.not_after {
        return Err("that certificate has expired".to_string());
    }
    if now_s < cert.not_before {
        return Err("that certificate is not valid yet".to_string());
    }
    let ca_der = first_cert(ca_pem).ok_or("client_ca holds no certificate")?;
    let chain: Vec<Vec<u8>> = pem_blocks(chain_pem.as_bytes(), "CERTIFICATE").into_iter().map(|(_, d)| d).collect();
    if !chain_pem.trim().is_empty() && chain.is_empty() {
        return Err("the chain holds no certificate".to_string());
    }
    if !verify_chain(&cert, &chain, &ca_der, now_s) {
        return Err("that certificate is not issued by this Meet CA".to_string());
    }
    Ok((cert, facts, chain))
}

/// An API app's identity for the connector process: what its certificate names, the certificate and chain, and a
/// signer handle for the sealed key (the key itself stays inside; `client_config` hands it only to rustls).
#[derive(Clone)]
pub struct AppIdentity {
    pub app: String,
    pub principal: String,
    pub device: String,
    pub org: String,
    /// The certificate serial as lowercase hex (`meet_x509::int_hex`).
    pub serial: String,
    pub cert_der: Vec<u8>,
    pub chain_der: Vec<Vec<u8>>,
    pub not_after_ms: i64,
    key: Arc<Key>,
}

impl std::fmt::Debug for AppIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppIdentity").field("app", &self.app).field("principal", &self.principal).field("device", &self.device).field("org", &self.org).field("serial", &self.serial).field("not_after_ms", &self.not_after_ms).finish_non_exhaustive()
    }
}

impl AppIdentity {
    pub fn cert_pem(&self) -> String {
        der_to_pem(&self.cert_der)
    }

    pub fn chain_pem(&self) -> String {
        self.chain_der.iter().map(|d| der_to_pem(d)).collect()
    }

    /// An ASN.1 DER ECDSA P-256 SHA-256 signature by the app's key.
    pub fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        self.key.sign(msg)
    }

    pub fn renew_due(&self, now_ms: i64) -> bool {
        self.not_after_ms - now_ms <= RENEW_LEFT_MS
    }

    /// Past `notAfter` (the grace of 1a 3 is the relay's to judge; the connector stops serving at its effective end).
    pub fn expired(&self, now_ms: i64) -> bool {
        now_ms > self.not_after_ms
    }

    /// The client certificate chain (leaf first) and key for TLS client authentication.
    pub fn client_auth(&self) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let mut chain = vec![CertificateDer::from(self.cert_der.clone())];
        chain.extend(self.chain_der.iter().map(|d| CertificateDer::from(d.clone())));
        (chain, PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.pkcs8().to_vec())))
    }

    /// The rustls client config of the app's mTLS relay session (PC-1 app routes, 2.5): the relay's server
    /// certificate must chain to `relay_ca_pem`, and the app certificate authenticates the client.
    pub fn client_config(&self, relay_ca_pem: &str) -> Result<Arc<ClientConfig>, String> {
        let mut roots = RootCertStore::empty();
        for (_, der) in pem_blocks(relay_ca_pem.as_bytes(), "CERTIFICATE") {
            roots.add(CertificateDer::from(der)).map_err(|e| format!("relay_ca does not read: {e}"))?;
        }
        if roots.is_empty() {
            return Err("relay_ca holds no certificate".to_string());
        }
        let (chain, key) = self.client_auth();
        let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, key)
            .map_err(|e| format!("the app certificate and key do not fit: {e}"))?;
        Ok(Arc::new(cfg))
    }
}

/// Enrollment of the connector's API apps (2.4).
pub struct Enroll {
    state_dir: PathBuf,
    sealed: Arc<SealedStore>,
}

impl Enroll {
    pub fn new(state_dir: &Path, sealed: Arc<SealedStore>) -> Enroll {
        Enroll { state_dir: state_dir.to_path_buf(), sealed }
    }

    /// `state_dir/apps/<app>/`.
    pub fn app_dir(&self, app: &str) -> PathBuf {
        self.state_dir.join(APPS_DIR).join(app)
    }

    fn sealed_key(&self, name: &str) -> Result<Option<Key>, String> {
        match self.sealed.get_bytes(name)? {
            None => Ok(None),
            Some(mut der) => {
                let key = Key::from_pkcs8(Curve::P256, &der);
                wipe(&mut der);
                key.map(Some)
            }
        }
    }

    fn write_csr(&self, app: &str, key: &Key) -> Result<PathBuf, String> {
        let der = fx::csr(key, &csr_cn(app), &[], &[], &[])?;
        let dir = self.app_dir(app);
        make_private_dir(&dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
        let path = dir.join(CSR_FILE);
        write_private(&path, pem("CERTIFICATE REQUEST", &der).as_bytes()).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
        Ok(path)
    }

    /// `connector keygen --app <name>`: a new P-256 key made here, sealed, and its request (no SANs: the CA sets
    /// them) in `request.csr`. A key without a certificate yet only has its request written again; a key with one
    /// is refused (it renews by itself). Ok is the request's path.
    pub fn keygen(&self, app: &str) -> Result<PathBuf, String> {
        if !app_name_ok(app) {
            return Err(BAD_APP_NAME.to_string());
        }
        let name = names::app_key(app);
        if let Some(key) = self.sealed_key(&name)? {
            if self.app_dir(app).join(CERT_FILE).exists() {
                return Err(format!("a key for {app} already exists on this host; it renews by itself"));
            }
            return self.write_csr(app, &key);
        }
        let key = Key::generate(Curve::P256)?;
        self.sealed.put_bytes(&name, key.pkcs8())?;
        self.write_csr(app, &key)
    }

    fn write_cert(&self, app: &str, cert_der: &[u8], chain: &[Vec<u8>]) -> Result<(), String> {
        let mut text = der_to_pem(cert_der);
        for der in chain {
            text.push_str(&der_to_pem(der));
        }
        let dir = self.app_dir(app);
        make_private_dir(&dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
        let path = dir.join(CERT_FILE);
        write_private(&path, text.as_bytes()).map_err(|e| format!("{} could not be written: {e}", path.display()))
    }

    /// `connector install --app <name> --cert <crt> --chain <pem>`: the certificate the CA issued for `request.csr`,
    /// checked against the sealed key and `client_ca_pem` at `now_ms`, then stored.
    pub fn install(&self, app: &str, cert_pem: &str, chain_pem: &str, client_ca_pem: &str, now_ms: i64) -> Result<AppIdentity, String> {
        if !app_name_ok(app) {
            return Err(BAD_APP_NAME.to_string());
        }
        let key = self.sealed_key(&names::app_key(app))?.ok_or_else(|| format!("there is no key for {app}: run keygen first"))?;
        let leaf = first_cert(cert_pem).ok_or("that is not a PEM certificate")?;
        let (_, _, chain) = check(app, &leaf, chain_pem, client_ca_pem, &key.spki(), now_ms)?;
        self.write_cert(app, &leaf, &chain)?;
        self.load(app)
    }

    /// The installed identity. A renewal cut short between the certificate and the key swap is finished here.
    pub fn load(&self, app: &str) -> Result<AppIdentity, String> {
        if !app_name_ok(app) {
            return Err(BAD_APP_NAME.to_string());
        }
        let mut key = self.sealed_key(&names::app_key(app))?.ok_or_else(|| format!("there is no key for {app}: run keygen first"))?;
        let text = std::fs::read_to_string(self.app_dir(app).join(CERT_FILE)).map_err(|_| format!("{app} has no certificate yet: install the one the CA issued for request.csr"))?;
        let mut ders = pem_blocks(text.as_bytes(), "CERTIFICATE").into_iter().map(|(_, d)| d);
        let cert_der = ders.next().ok_or_else(|| format!("{app}'s certificate does not read"))?;
        let chain_der: Vec<Vec<u8>> = ders.collect();
        let cert = Cert::from_der(&cert_der).ok_or_else(|| format!("{app}'s certificate does not read"))?;
        if cert.spki != key.spki() {
            let next_name = names::app_next_key(app);
            match self.sealed_key(&next_name)? {
                Some(next) if next.spki() == cert.spki => {
                    self.sealed.put_bytes(&names::app_key(app), next.pkcs8())?;
                    self.sealed.delete(&next_name)?;
                    key = next;
                }
                _ => return Err(format!("{app}'s certificate does not match its key")),
            }
        }
        let facts = app_facts(app, &cert)?;
        Ok(AppIdentity {
            app: app.to_string(),
            principal: facts.principal,
            device: facts.device,
            org: facts.org,
            serial: cert.serial.clone(),
            not_after_ms: cert.not_after.saturating_mul(1000),
            cert_der,
            chain_der,
            key: Arc::new(key),
        })
    }

    /// The body of `POST /v1/apps/c/renew`: `{csr_pem, proof, ts}`, a request for the next key (made and sealed
    /// here, or the one a previous attempt made) and the proof by the current key over its DER
    /// (`sign_service_renewal`, `ts` in seconds).
    pub fn renew_request(&self, app: &str, now_ms: i64) -> Result<Value, String> {
        let id = self.load(app)?;
        let next_name = names::app_next_key(app);
        let next = match self.sealed_key(&next_name)? {
            Some(k) => k,
            None => {
                let k = Key::generate(Curve::P256)?;
                self.sealed.put_bytes(&next_name, k.pkcs8())?;
                k
            }
        };
        let csr = fx::csr(&next, &csr_cn(app), &[], &[], &[])?;
        let ts = now_ms.div_euclid(1000);
        let proof = id.sign(&proof_bytes(RENEW_OP, &csr, ts))?;
        Ok(json!({"csr_pem": pem("CERTIFICATE REQUEST", &csr), "proof": crate::meet_json::b64(&proof), "ts": ts}))
    }

    /// The relay's answer `{cert_pem, chain_pem}` to a renewal: checked as `install` checks (for the next key),
    /// keeping principal, device and org; then the certificate and the key are swapped in.
    pub fn renew_install(&self, app: &str, answer: &Value, client_ca_pem: &str, now_ms: i64) -> Result<AppIdentity, String> {
        let current = self.load(app)?;
        let next_name = names::app_next_key(app);
        let next = self.sealed_key(&next_name)?.ok_or_else(|| format!("there is no renewal under way for {app}"))?;
        let cert_pem = answer.get("cert_pem").and_then(Value::as_str).unwrap_or_default();
        let chain_pem = answer.get("chain_pem").and_then(Value::as_str).unwrap_or_default();
        let leaf = first_cert(cert_pem).ok_or("the renewal answer has no certificate")?;
        let (_, facts, chain) = check(app, &leaf, chain_pem, client_ca_pem, &next.spki(), now_ms)?;
        if facts.principal != current.principal || facts.device != current.device || facts.org != current.org {
            return Err("the renewed certificate names another service".to_string());
        }
        self.write_cert(app, &leaf, &chain)?;
        self.sealed.put_bytes(&names::app_key(app), next.pkcs8())?;
        self.sealed.delete(&next_name)?;
        self.load(app)
    }
}

/// Test app certificates: a leaf for any key, issued by a `testpki::Ca` (ecdsa-with-SHA256), with the SAN email
/// and URIs given.
#[cfg(test)]
pub(crate) mod testcert {
    use crate::meet_tls::testpki::{tlv, time, Ca};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    const ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    const CLIENT_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02];

    fn int(b: &[u8]) -> Vec<u8> {
        let mut v = b.to_vec();
        if v.first().is_some_and(|x| x & 0x80 != 0) {
            v.insert(0, 0);
        }
        tlv(0x02, &v)
    }

    fn name(cn: &str) -> Vec<u8> {
        tlv(0x30, &tlv(0x31, &tlv(0x30, &[tlv(0x06, &[0x55, 0x04, 0x03]), tlv(0x0c, cn.as_bytes())].concat())))
    }

    fn ext(oid: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
        let mut body = tlv(0x06, oid);
        if critical {
            body.extend(tlv(0x01, &[0xff]));
        }
        body.extend(tlv(0x04, value));
        tlv(0x30, &body)
    }

    /// A clientAuth leaf for `spki` (DER), valid from `not_before` to `not_after` (seconds).
    pub fn leaf(ca: &Ca, spki: &[u8], email: &str, uris: &[&str], not_before: i64, not_after: i64) -> Vec<u8> {
        let mut serial = [0u8; 8];
        aws_lc_rs::rand::fill(&mut serial).unwrap();
        serial[0] = (serial[0] & 0x7f) | 0x40;
        let mut san = tlv(0x81, email.as_bytes());
        for u in uris {
            san.extend(tlv(0x86, u.as_bytes()));
        }
        let aki = crate::codec::sha256(&ca.key.spki)[..20].to_vec();
        let exts = [
            ext(&[0x55, 0x1d, 0x13], true, &tlv(0x30, &[])),
            ext(&[0x55, 0x1d, 0x0f], true, &tlv(0x03, &[0x07, 0x80])),
            ext(&[0x55, 0x1d, 0x25], false, &tlv(0x30, &tlv(0x06, CLIENT_AUTH))),
            ext(&[0x55, 0x1d, 0x23], false, &tlv(0x30, &tlv(0x80, &aki))),
            ext(&[0x55, 0x1d, 0x11], false, &tlv(0x30, &san)),
        ]
        .concat();
        let alg = tlv(0x30, &tlv(0x06, ECDSA_SHA256));
        let validity = tlv(0x30, &[time(not_before), time(not_after)].concat());
        let tbs = tlv(0x30, &[tlv(0xa0, &int(&[2])), int(&serial), alg.clone(), name(&ca.cn), validity, name(email), spki.to_vec(), tlv(0xa3, &tlv(0x30, &exts))].concat());
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &ca.key.pkcs8).unwrap();
        let sig = pair.sign(&SystemRandom::new(), &tbs).unwrap();
        tlv(0x30, &[tbs, alg, tlv(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat())
    }
}

#[cfg(test)]
mod tests {
    use super::testcert::leaf;
    use super::*;
    use crate::connector_seal::{FixedSource, Sealer, SEALED_DIR};
    use crate::meet_tls::testpki::{dir, pem as test_pem, Ca, Key as TestKey};
    use crate::meet_x509::Csr;
    use serde_json::json;

    const APP: &str = "helpdesk-api";
    const EMAIL: &str = "helpdesk-api@apps.acme.example";
    const DEVICE: &str = "0123456789abcdef";
    const DAY_S: i64 = 86_400;

    fn setup() -> (PathBuf, Enroll, Arc<SealedStore>) {
        let d = dir("conn-enroll");
        let sealed = Arc::new(SealedStore::open(Sealer::from_source(&FixedSource([9; 32])).unwrap(), d.join(SEALED_DIR)).unwrap());
        let enroll = Enroll::new(&d, sealed.clone());
        (d, enroll, sealed)
    }

    /// The request's DER and key, after checking its signature.
    fn request(text: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let der = pem_blocks(text, "CERTIFICATE REQUEST").remove(0).1;
        let csr = Csr::from_der(&der).unwrap();
        assert!(csr.signature_valid());
        (der, csr.spki)
    }

    /// The installed certificate's key (`load` checks it is the sealed key).
    fn spki_of(id: &AppIdentity) -> Vec<u8> {
        Cert::from_der(&id.cert_der).unwrap().spki
    }

    fn app_cert(ca: &Ca, spki: &[u8], email: &str, device: &str, not_before: i64, not_after: i64) -> String {
        let dev = format!("urn:lucid-meet:device:{device}");
        test_pem("CERTIFICATE", &leaf(ca, spki, email, &["urn:lucid-meet:app", "urn:lucid-meet:org:acme", dev.as_str()], not_before, not_after))
    }

    #[test]
    fn keygen_seals_the_key_and_install_takes_the_app_certificate_for_it() {
        let (d, enroll, sealed) = setup();
        let csr_path = enroll.keygen(APP).unwrap();
        assert_eq!(csr_path, d.join("apps").join(APP).join("request.csr"));
        let (_, spki) = request(&std::fs::read(&csr_path).unwrap());
        let pkcs8 = sealed.get_bytes(&names::app_key(APP)).unwrap().unwrap();
        let raw = std::fs::read(d.join(SEALED_DIR).join(format!("{}.bin", names::app_key(APP)))).unwrap();
        assert!(!raw.windows(pkcs8.len()).any(|w| w == pkcs8.as_slice()), "the key is never in clear");
        assert!(std::fs::read_dir(enroll.app_dir(APP)).unwrap().all(|e| e.unwrap().file_name() == "request.csr"));
        let ca = Ca::new("Acme Meet CA");
        let now = crate::codec::now_ms();
        let s = now / 1000;
        let id = enroll.install(APP, &app_cert(&ca, &spki, EMAIL, DEVICE, s - 60, s + 90 * DAY_S), "", &ca.pem(), now).unwrap();
        assert_eq!((id.principal.as_str(), id.device.as_str(), id.org.as_str()), (EMAIL, DEVICE, "acme"));
        assert_eq!(spki_of(&id), spki);
        assert!(!id.renew_due(now) && !id.expired(now));
        assert_eq!(enroll.load(APP).unwrap().serial, id.serial);
        assert!(id.client_config(&ca.pem()).is_ok());
        let sig = id.sign(b"hello").unwrap();
        assert!(fx::verify_p256(&spki, b"hello", &sig));
        assert!(enroll.keygen(APP).unwrap_err().contains("already exists"));
        assert_eq!(enroll.keygen("archive").unwrap_err(), BAD_APP_NAME);
    }

    #[test]
    fn install_refuses_another_key_another_ca_a_non_app_certificate_and_an_expired_one() {
        let (_, enroll, _) = setup();
        let (_, spki) = request(&std::fs::read(enroll.keygen(APP).unwrap()).unwrap());
        let ca = Ca::new("Acme Meet CA");
        let other = Ca::new("Acme Meet CA");
        let now = crate::codec::now_ms();
        let s = now / 1000;
        let refused = |cert: String| enroll.install(APP, &cert, "", &ca.pem(), now).unwrap_err();
        assert!(refused(app_cert(&ca, &TestKey::new().spki, EMAIL, DEVICE, s - 60, s + DAY_S)).contains("not for this host's key"));
        assert!(refused(app_cert(&other, &spki, EMAIL, DEVICE, s - 60, s + DAY_S)).contains("not issued by this Meet CA"));
        let dev = format!("urn:lucid-meet:device:{DEVICE}");
        let person = test_pem("CERTIFICATE", &leaf(&ca, &spki, "ann@acme.example", &["urn:lucid-meet:org:acme", dev.as_str()], s - 60, s + DAY_S));
        assert!(refused(person).contains("not an app certificate"));
        let archive = test_pem("CERTIFICATE", &leaf(&ca, &spki, EMAIL, &["urn:lucid-meet:archive", "urn:lucid-meet:org:acme", dev.as_str()], s - 60, s + DAY_S));
        assert!(refused(archive).contains("not an app certificate"));
        assert!(refused(app_cert(&ca, &spki, "other-api@apps.acme.example", DEVICE, s - 60, s + DAY_S)).contains("not helpdesk-api"));
        let no_device = test_pem("CERTIFICATE", &leaf(&ca, &spki, EMAIL, &["urn:lucid-meet:app", "urn:lucid-meet:org:acme"], s - 60, s + DAY_S));
        assert!(refused(no_device).contains("names no device"));
        assert!(refused(app_cert(&ca, &spki, EMAIL, DEVICE, s - 10 * DAY_S, s - 60)).contains("expired"));
        assert!(enroll.load(APP).is_err(), "nothing was installed");
    }

    #[test]
    fn renewal_is_due_at_30_days_and_its_install_keeps_principal_and_device() {
        let (_, enroll, sealed) = setup();
        let (_, spki) = request(&std::fs::read(enroll.keygen(APP).unwrap()).unwrap());
        let ca = Ca::new("Acme Meet CA");
        let now = crate::codec::now_ms();
        let s = now / 1000;
        let id = enroll.install(APP, &app_cert(&ca, &spki, EMAIL, DEVICE, s - 60, s + 31 * DAY_S), "", &ca.pem(), now).unwrap();
        assert!(!id.renew_due(now), "31 days left");
        let later = now + (DAY_S + 1) * 1000;
        assert!(id.renew_due(later), "30 days left");

        let body = enroll.renew_request(APP, now).unwrap();
        assert_eq!(body["ts"], json!(now.div_euclid(1000)));
        let (csr_der, next_spki) = request(body["csr_pem"].as_str().unwrap().as_bytes());
        assert_ne!(next_spki, spki, "a new key");
        let proof = crate::meet_json::b64_strict(body["proof"].as_str().unwrap()).unwrap();
        assert!(fx::verify_p256(&spki, &proof_bytes(RENEW_OP, &csr_der, now.div_euclid(1000)), &proof), "proved by the current key");
        let (_, again) = request(enroll.renew_request(APP, now).unwrap()["csr_pem"].as_str().unwrap().as_bytes());
        assert_eq!(again, next_spki, "a second attempt reuses the next key");

        // another device is refused and nothing changes
        let moved = app_cert(&ca, &next_spki, EMAIL, "fedcba9876543210", s - 60, s + 90 * DAY_S);
        assert!(enroll.renew_install(APP, &json!({"cert_pem": moved, "chain_pem": ""}), &ca.pem(), now).unwrap_err().contains("another service"));
        // a certificate for the current key is not the renewal
        let same_key = app_cert(&ca, &spki, EMAIL, DEVICE, s - 60, s + 90 * DAY_S);
        assert!(enroll.renew_install(APP, &json!({"cert_pem": same_key}), &ca.pem(), now).unwrap_err().contains("not for this host's key"));
        assert_eq!(enroll.load(APP).unwrap().serial, id.serial);
        assert!(enroll.renew_install(APP, &json!({}), &ca.pem(), now).unwrap_err().contains("no certificate"));

        let renewed = app_cert(&ca, &next_spki, EMAIL, DEVICE, s - 60, s + 90 * DAY_S);
        let id2 = enroll.renew_install(APP, &json!({"cert_pem": renewed, "chain_pem": ""}), &ca.pem(), now).unwrap();
        assert_eq!((&id2.principal, &id2.device, &id2.org), (&id.principal, &id.device, &id.org));
        assert_eq!(spki_of(&id2), next_spki);
        assert_ne!(id2.serial, id.serial);
        assert!(!sealed.has(&names::app_next_key(APP)));
        assert_eq!(enroll.load(APP).unwrap().serial, id2.serial);
        assert!(!id2.renew_due(now));
        assert!(enroll.renew_install(APP, &json!({"cert_pem": ""}), &ca.pem(), now).unwrap_err().contains("no renewal under way"));
    }

    #[test]
    fn a_renewal_cut_short_after_the_certificate_is_finished_by_load() {
        let (_, enroll, sealed) = setup();
        let (_, spki) = request(&std::fs::read(enroll.keygen(APP).unwrap()).unwrap());
        let ca = Ca::new("Acme Meet CA");
        let now = crate::codec::now_ms();
        let s = now / 1000;
        enroll.install(APP, &app_cert(&ca, &spki, EMAIL, DEVICE, s - 60, s + 10 * DAY_S), "", &ca.pem(), now).unwrap();
        let (_, next_spki) = request(enroll.renew_request(APP, now).unwrap()["csr_pem"].as_str().unwrap().as_bytes());
        // the new certificate was written, the key swap did not happen
        let renewed = app_cert(&ca, &next_spki, EMAIL, DEVICE, s - 60, s + 90 * DAY_S);
        write_private(&enroll.app_dir(APP).join(CERT_FILE), renewed.as_bytes()).unwrap();
        let id = enroll.load(APP).unwrap();
        assert_eq!(spki_of(&id), next_spki);
        assert!(!sealed.has(&names::app_next_key(APP)));
    }
}
