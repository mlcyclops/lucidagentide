// Contract API-1 revision 6 section 8.4 (slice API-1d6): the AI gateway's own MCP credentials, never a person's.
// Each gateway makes its own P-256 key per MCP server (`POST /v1/ai/admin/mcp/key` answers the public JWK and its
// RFC 7638 thumbprint as the key id; the admin registers it with the server's authorization server and lists it in
// the server's `auth.kids` under this gateway's principal), or a key with a PKCS#10 request for `oauth_mtls` and
// `mtls_only` (`/csr`, then `/cert` installs the issued certificate). The private key is sealed with systemd-creds
// (TPM2 when there is one) where that works, else kept in an owner-only file, like the gateway's other secrets; it is
// never logged or answered. The client assertion is a JWS ES256 with `typ` `client-authentication+jwt` and `aud` the
// issuer only (RFC 10070). `mcp_credential_drop` deletes the server's credential.

use crate::codec::{b64u, now_ms, sha256};
use crate::fleet_x509::{self as x509, Curve, Key};
use crate::meet_json::{b64, b64_strict};
use crate::meet_x509::{pem_blocks, Cert};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The systemd credential name the keys are sealed under (systemd-creds is used only on Unix).
#[cfg(unix)]
const SEAL_NAME: &str = "lucid-ai-mcp";

/// What a gateway holds for one server.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CredState {
    /// "none", "key" (private_key_jwt), "csr" (waiting for its certificate) or "cert".
    pub state: String,
    pub kid: String,
    pub not_after: i64,
}

/// A certificate chain (leaf first) and its PKCS#8 key, for TLS client authentication.
pub struct ClientCert {
    pub chain: Vec<Vec<u8>>,
    pub pkcs8: Vec<u8>,
}

pub struct CredStore {
    dir: PathBuf,
    lock: Mutex<()>,
    /// Tests: the next record write fails.
    #[cfg(test)]
    fail_record: std::sync::atomic::AtomicBool,
}

fn pem(label: &str, der: &[u8]) -> String {
    let b = b64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// The public JWK of a P-256 key pair and its RFC 7638 thumbprint.
pub fn public_jwk(pair: &EcdsaKeyPair) -> (String, Value) {
    let point = pair.public_key().as_ref();
    let (x, y) = (b64u(&point[1..33]), b64u(&point[33..65]));
    let kid = b64u(&sha256(format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#).as_bytes()));
    (kid.clone(), json!({"kty": "EC", "crv": "P-256", "x": x, "y": y, "kid": kid, "use": "sig", "alg": "ES256"}))
}

/// A compact JWS ES256 of `header` and `claims`.
pub fn jws(pair: &EcdsaKeyPair, header: &Value, claims: &Value) -> Result<String, String> {
    let input = format!("{}.{}", b64u(header.to_string().as_bytes()), b64u(claims.to_string().as_bytes()));
    let sig = pair.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "the assertion could not be signed".to_string())?;
    Ok(format!("{input}.{}", b64u(sig.as_ref())))
}

#[cfg(unix)]
fn systemd_encrypt(out: &Path, secret: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("systemd-creds")
        .args(["encrypt", "--with-key=auto", &format!("--name={SEAL_NAME}"), "-"])
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let fed = child.stdin.take().ok_or("no stdin")?.write_all(secret).map_err(|e| e.to_string());
    let status = child.wait().map_err(|e| e.to_string())?;
    fed?;
    if !status.success() {
        let _ = std::fs::remove_file(out);
        return Err("systemd-creds encrypt failed".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn systemd_encrypt(_out: &Path, _secret: &[u8]) -> Result<(), String> {
    Err("systemd-creds is not available here".into())
}

#[cfg(unix)]
fn systemd_decrypt(path: &Path) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    let out = Command::new("systemd-creds")
        .args(["decrypt", &format!("--name={SEAL_NAME}")])
        .arg(path)
        .arg("-")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("systemd-creds decrypt failed".into());
    }
    Ok(out.stdout)
}

#[cfg(not(unix))]
fn systemd_decrypt(_path: &Path) -> Result<Vec<u8>, String> {
    Err("systemd-creds is not available here".into())
}

fn server_ok(server: &str) -> bool {
    crate::ai_mcp::server_id_ok(Some(&Value::from(server)))
}

impl CredStore {
    pub fn new(state_dir: &Path) -> CredStore {
        CredStore {
            dir: state_dir.join("mcp-creds"),
            lock: Mutex::new(()),
            #[cfg(test)]
            fail_record: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn record_path(&self, server: &str) -> PathBuf {
        self.dir.join(format!("{server}.json"))
    }

    fn record(&self, server: &str) -> Option<Value> {
        serde_json::from_slice(&std::fs::read(self.record_path(server)).ok()?).ok()
    }

    /// Seal the PKCS#8 bytes into a new file of their own (`<server>.<random>.cred` with systemd-creds where that
    /// works, else an owner-only `<server>.<random>.key`): (its name, how). No existing file is touched.
    fn seal(&self, server: &str, pkcs8: &[u8]) -> Result<(String, &'static str), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("cannot make {}: {e}", self.dir.display()))?;
        let stem = format!("{server}.{}", crate::meet_json::token_hex(8));
        let cred = format!("{stem}.cred");
        if systemd_encrypt(&self.dir.join(&cred), pkcs8).is_ok() {
            return Ok((cred, "systemd-creds"));
        }
        let file = format!("{stem}.key");
        crate::store::write_private(&self.dir.join(&file), b64(pkcs8).as_bytes()).map_err(|e| format!("the MCP key cannot be written: {e}"))?;
        Ok((file, "file"))
    }

    /// The key file a record names (a plain file name in this folder), if any.
    fn key_file(&self, server: &str, rec: &Value) -> Option<PathBuf> {
        let name = rec["key_file"].as_str().filter(|n| n.starts_with(&format!("{server}.")) && !n.contains(['/', '\\']) && !n.contains(".."))?;
        Some(self.dir.join(name))
    }

    fn unseal(&self, server: &str, rec: &Value) -> Result<Vec<u8>, String> {
        let path = self.key_file(server, rec).ok_or("no MCP key")?;
        match rec["seal"].as_str() {
            Some("systemd-creds") => systemd_decrypt(&path),
            _ => {
                let text = std::fs::read_to_string(&path).map_err(|_| "the MCP key cannot be read".to_string())?;
                b64_strict(text.trim()).ok_or_else(|| "the MCP key does not read".to_string())
            }
        }
    }

    fn write_record(&self, server: &str, v: &Value) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_record.swap(false, std::sync::atomic::Ordering::Relaxed) {
            return Err("the MCP credential record cannot be written (test)".into());
        }
        crate::meet_tls::write_atomic(&self.record_path(server), v.to_string().as_bytes()).map_err(|e| format!("the MCP credential record cannot be written: {e}"))
    }

    /// Seal a new key and switch to it: the record naming the new key file is written atomically, and that write is
    /// the only step that switches keys. On any failure the new key file is deleted and the old key and record stay;
    /// after the switch the old key file is deleted.
    fn commit(&self, server: &str, pkcs8: &[u8], mut rec: Value) -> Result<(), String> {
        let old = self.record(server).and_then(|r| self.key_file(server, &r));
        let (name, how) = self.seal(server, pkcs8)?;
        rec["key_file"] = json!(name);
        rec["seal"] = json!(how);
        if let Err(e) = self.write_record(server, &rec) {
            let _ = std::fs::remove_file(self.dir.join(&name));
            return Err(e);
        }
        if let Some(o) = old.filter(|o| *o != self.dir.join(&name)) {
            let _ = std::fs::remove_file(o);
        }
        Ok(())
    }

    /// `POST /v1/ai/admin/mcp/key`: a new P-256 key for `server` (replacing this gateway's previous one), sealed;
    /// the public JWK and its thumbprint (the kid to list under this gateway's principal in `auth.kids`).
    pub fn make_key(&self, server: &str) -> Result<(String, Value), String> {
        if !server_ok(server) {
            return Err(crate::ai_mcp::MCP_ID.into());
        }
        let _g = self.lock.lock();
        let key = Key::generate(Curve::P256)?;
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, key.pkcs8()).map_err(|_| "the new key does not read".to_string())?;
        let (kid, jwk) = public_jwk(&pair);
        let spki = crate::codec::sha256_hex(&key.spki());
        self.commit(server, key.pkcs8(), json!({"v": 1, "state": "key", "kid": kid, "spki_sha256": spki, "made": now_ms() / 1000}))?;
        Ok((kid, jwk))
    }

    /// `POST /v1/ai/admin/mcp/csr`: a new P-256 key and its PKCS#10 request (`CN` = this gateway's principal).
    pub fn make_csr(&self, server: &str, cn: &str) -> Result<String, String> {
        if !server_ok(server) {
            return Err(crate::ai_mcp::MCP_ID.into());
        }
        let _g = self.lock.lock();
        let key = Key::generate(Curve::P256)?;
        let der = x509::csr(&key, cn, &[], &[], &[])?;
        let spki = crate::codec::sha256_hex(&key.spki());
        self.commit(server, key.pkcs8(), json!({"v": 1, "state": "csr", "kid": "", "spki_sha256": spki, "made": now_ms() / 1000}))?;
        Ok(pem("CERTIFICATE REQUEST", &der))
    }

    /// `POST /v1/ai/admin/mcp/cert`: install the certificate issued for the pending request (its key must be the
    /// sealed one); answers its `not_after`.
    pub fn install_cert(&self, server: &str, cert_pem: &str, chain_pem: &str, now: i64) -> Result<i64, String> {
        let _g = self.lock.lock();
        let mut rec = self.record(server).filter(|r| r["state"] == "csr" || r["state"] == "cert").ok_or("ask for a certificate request for this server first")?;
        let cert = Cert::from_pem(cert_pem).ok_or("cert_pem is not a certificate")?;
        if crate::codec::sha256_hex(&cert.spki) != rec["spki_sha256"].as_str().unwrap_or_default() {
            return Err("that certificate is not for this gateway's request key".into());
        }
        if cert.not_after <= now {
            return Err("that certificate has expired".into());
        }
        if !chain_pem.trim().is_empty() && pem_blocks(chain_pem.as_bytes(), "CERTIFICATE").is_empty() {
            return Err("chain_pem holds no certificate".into());
        }
        rec["state"] = json!("cert");
        rec["cert_pem"] = json!(cert_pem);
        rec["chain_pem"] = json!(chain_pem);
        rec["not_after"] = json!(cert.not_after);
        self.write_record(server, &rec)?;
        Ok(cert.not_after)
    }

    /// `mcp_credential_drop`: the sealed key and its record are deleted.
    pub fn drop_server(&self, server: &str) {
        let _g = self.lock.lock();
        if let Some(path) = self.record(server).and_then(|r| self.key_file(server, &r)) {
            let _ = std::fs::remove_file(path);
        }
        let _ = std::fs::remove_file(self.record_path(server));
    }

    pub fn state(&self, server: &str) -> CredState {
        match self.record(server) {
            Some(r) => CredState {
                state: r["state"].as_str().unwrap_or("none").to_string(),
                kid: r["kid"].as_str().unwrap_or_default().to_string(),
                not_after: r["not_after"].as_i64().unwrap_or(0),
            },
            None => CredState { state: "none".into(), ..CredState::default() },
        }
    }

    fn pkcs8(&self, server: &str) -> Result<Vec<u8>, String> {
        let r = self.record(server).ok_or("no MCP credential")?;
        self.unseal(server, &r)
    }

    /// The key pair that signs this gateway's client assertions for `server`.
    pub fn signer(&self, server: &str) -> Result<EcdsaKeyPair, String> {
        if self.state(server).state != "key" {
            return Err("no MCP key".into());
        }
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &self.pkcs8(server)?).map_err(|_| "the MCP key does not read".to_string())
    }

    /// The installed client certificate (leaf first) and its key.
    pub fn client_cert(&self, server: &str) -> Result<ClientCert, String> {
        let r = self.record(server).filter(|r| r["state"] == "cert").ok_or("no MCP client certificate")?;
        let mut chain: Vec<Vec<u8>> = pem_blocks(r["cert_pem"].as_str().unwrap_or_default().as_bytes(), "CERTIFICATE").into_iter().map(|(_, d)| d).collect();
        chain.extend(pem_blocks(r["chain_pem"].as_str().unwrap_or_default().as_bytes(), "CERTIFICATE").into_iter().map(|(_, d)| d));
        if chain.is_empty() {
            return Err("no MCP client certificate".into());
        }
        Ok(ClientCert { chain, pkcs8: self.pkcs8(server)? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    const SERVER: &str = "m_3f2e1d0c9b8a7f6e";

    /// R6-14: each gateway signs with its own key; the assertion verifies with the JWK it answered.
    #[test]
    fn a_new_key_answers_its_jwk_and_signs_assertions_that_verify() {
        let dir = crate::meet_tls::testpki::dir("ai-mcp-cred");
        let store = CredStore::new(&dir);
        let (kid, jwk) = store.make_key(SERVER).unwrap();
        assert_eq!(jwk["kid"], json!(kid));
        assert_eq!(store.state(SERVER).state, "key");
        let other = CredStore::new(&crate::meet_tls::testpki::dir("ai-mcp-cred-2"));
        let (kid2, _) = other.make_key(SERVER).unwrap();
        assert_ne!(kid, kid2, "two gateways never share a key");
        let (h, c) = crate::ai_mcp::assertion_parts("https://auth.acme.example", "lucid-ai-gateway", &kid, 1_795_000_000, &"ab".repeat(16));
        let token = jws(&store.signer(SERVER).unwrap(), &h, &c).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let header: Value = serde_json::from_slice(&crate::codec::unb64u(parts[0]).unwrap()).unwrap();
        assert_eq!((header["typ"].as_str(), header["alg"].as_str()), (Some("client-authentication+jwt"), Some("ES256")));
        let claims: Value = serde_json::from_slice(&crate::codec::unb64u(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], json!("https://auth.acme.example"));
        let x = crate::codec::unb64u(jwk["x"].as_str().unwrap()).unwrap();
        let y = crate::codec::unb64u(jwk["y"].as_str().unwrap()).unwrap();
        let point = [vec![4u8], x, y].concat();
        let sig = crate::codec::unb64u(parts[2]).unwrap();
        assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok());
        store.drop_server(SERVER);
        assert_eq!(store.state(SERVER).state, "none");
        assert!(store.signer(SERVER).is_err());
    }

    /// A new key or request whose record cannot be written leaves the old key and record in use and no new key
    /// file behind.
    #[test]
    fn a_failed_record_write_keeps_the_old_key() {
        let dir = crate::meet_tls::testpki::dir("ai-mcp-cred-commit");
        let store = CredStore::new(&dir);
        let (kid, jwk) = store.make_key(SERVER).unwrap();
        let files = || std::fs::read_dir(dir.join("mcp-creds")).unwrap().count();
        let before = files();
        for fail in [true, false] {
            store.fail_record.store(true, std::sync::atomic::Ordering::Relaxed);
            if fail {
                assert!(store.make_key(SERVER).is_err());
            } else {
                assert!(store.make_csr(SERVER, "ai@apps.acme.example").is_err());
            }
            assert_eq!(files(), before);
            assert_eq!((store.state(SERVER).state.as_str(), store.state(SERVER).kid), ("key", kid.clone()));
            let (h, c) = crate::ai_mcp::assertion_parts("https://auth.acme.example", "lucid-ai-gateway", &kid, 1_795_000_000, &"cd".repeat(16));
            let token = jws(&store.signer(SERVER).unwrap(), &h, &c).unwrap();
            let parts: Vec<&str> = token.split('.').collect();
            let x = crate::codec::unb64u(jwk["x"].as_str().unwrap()).unwrap();
            let y = crate::codec::unb64u(jwk["y"].as_str().unwrap()).unwrap();
            let point = [vec![4u8], x, y].concat();
            let sig = crate::codec::unb64u(parts[2]).unwrap();
            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok(), "the old key still signs");
        }
        // a later success switches and leaves one key file
        let (kid2, _) = store.make_key(SERVER).unwrap();
        assert_ne!(kid, kid2);
        assert_eq!(files(), before);
    }

    #[test]
    fn a_request_key_waits_for_its_own_certificate() {
        let dir = crate::meet_tls::testpki::dir("ai-mcp-csr");
        let store = CredStore::new(&dir);
        let csr = store.make_csr(SERVER, "ai@apps.acme.example").unwrap();
        assert!(csr.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
        assert_eq!(store.state(SERVER).state, "csr");
        assert!(store.client_cert(SERVER).is_err());
        // a certificate for another key is refused
        let foreign = crate::meet_tls::testpki::Ca::new("Other CA").pem();
        assert!(store.install_cert(SERVER, &foreign, "", 1_795_000_000).is_err());
    }
}
