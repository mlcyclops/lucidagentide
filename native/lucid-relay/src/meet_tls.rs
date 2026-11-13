// Phase C (ADR-0540): the Meet relay's TLS (meet_relay.py tls_context, crl_path, crl_parts, bundle_checks_chain,
// RefusalLog) and its outbound mutual-TLS client (SignerClient, and the Proxmox calls of meet_console.FilesPower).
// Server TLS REQUIRES a client certificate chaining to the Meet CA; with a CRL file the leaf is checked, and once the
// bundle also holds a CRL from another CA (the signer's) every certificate of the chain is. An expired CRL refuses
// the handshake, as OpenSSL does.

use crate::meet::{log_info, Settings, E};
use crate::meet_json::{self as pj, Obj};
use crate::meet_x509::{pem_blocks, Cert, Crl};
use parking_lot::Mutex;
use rustls::client::danger::HandshakeSignatureValid;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::WebPkiClientVerifier;
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig, SignatureScheme};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const ROOT_CRL: &str = "crl-root.pem";
pub const SIGNER_CRL: &str = "crl-signer.pem";
pub const SIGNER_TIMEOUT: f64 = 10.0;
pub const SIGNER_TTL: f64 = 60.0;
pub const SIGNER_RETRY: f64 = 60.0;
const REFUSAL_EVERY: f64 = 600.0;
const REFUSAL_ADDRESSES: usize = 256;
const REFUSAL_LISTED: usize = 20;

pub fn read_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut fh = std::fs::File::create(&tmp)?;
        fh.write_all(data)?;
        fh.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// crl_path: `crl` if set, else `state_dir/crl.pem` (None when neither).
pub fn crl_path(s: &Settings) -> Option<PathBuf> {
    if !s.crl.is_empty() {
        return Some(PathBuf::from(&s.crl));
    }
    (!s.state_dir.is_empty()).then(|| Path::new(&s.state_dir).join("crl.pem"))
}

/// crl_parts: (root part, signer part) of the bundle in state_dir; None with a fixed `crl` file or no state folder.
pub fn crl_parts(s: &Settings) -> Option<(PathBuf, PathBuf)> {
    if !s.crl.is_empty() || s.state_dir.is_empty() {
        return None;
    }
    let d = Path::new(&s.state_dir);
    Some((d.join(ROOT_CRL), d.join(SIGNER_CRL)))
}

/// The CRLs in a file (each readable one).
pub fn crls_in(data: &[u8]) -> Vec<Crl> {
    pem_blocks(data, "X509 CRL").iter().filter_map(|(_, der)| Crl::from_der(der)).collect()
}

/// bundle_checks_chain: the CRL file holds the root's CRL AND at least one other CA's.
pub fn bundle_checks_chain(crl_file: &Path, ca_file: &Path) -> bool {
    let Some(root) = Cert::from_pem(&String::from_utf8_lossy(&read_bytes(ca_file))) else { return false };
    let Ok(data) = std::fs::read(crl_file) else { return false };
    let blocks = pem_blocks(&data, "X509 CRL");
    let mut issuers = Vec::new();
    for (_, der) in &blocks {
        match Crl::from_der(der) {
            Some(c) => issuers.push(c.issuer),
            None => return false,
        }
    }
    issuers.contains(&root.subject) && issuers.iter().any(|i| *i != root.subject)
}

/// The CRL file new connections check ("" when none): `crl`, else the pushed bundle when it exists.
pub fn active_crl(s: &Settings) -> Option<PathBuf> {
    if !s.crl.is_empty() {
        return Some(PathBuf::from(&s.crl));
    }
    crl_path(s).filter(|p| p.exists())
}

fn load_certs(path: &str, what: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read the {what} {path}: {e}"))?;
    let certs = rustls_pemfile::certs(&mut data.as_slice()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("the {what} {path} does not read: {e}"))?;
    if certs.is_empty() {
        return Err(format!("the {what} {path} holds no certificate"));
    }
    Ok(certs)
}

fn load_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read the key {path}: {e}"))?;
    rustls_pemfile::private_key(&mut data.as_slice()).map_err(|e| format!("the key {path} does not read: {e}"))?.ok_or_else(|| format!("the key {path} holds no private key"))
}

fn roots_of(path: &str) -> Result<RootCertStore, String> {
    let mut roots = RootCertStore::empty();
    for c in load_certs(path, "CA file")? {
        roots.add(c).map_err(|e| format!("the CA file {path} does not read: {e}"))?;
    }
    Ok(roots)
}

/// The client verifier: the chain to the Meet CA by webpki, then revocation as OpenSSL checks it with
/// VERIFY_CRL_CHECK_LEAF or _CHAIN (meet_pki's CRLs carry no CRL number, which webpki's own CRL parser requires):
/// each checked certificate needs a current CRL from its issuer, signed by that issuer, that does not list it.
#[derive(Debug)]
struct MeetVerifier {
    inner: Arc<dyn ClientCertVerifier>,
    roots: Vec<Cert>,
    crls: Vec<Crl>,
    chain: bool,
}

impl MeetVerifier {
    fn issuer_of<'a>(&'a self, cert: &Cert, intermediates: &'a [Cert]) -> Option<(&'a Cert, bool)> {
        if let Some(c) = intermediates.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)) {
            return Some((c, false));
        }
        self.roots.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)).map(|c| (c, true))
    }

    fn check_one(&self, cert: &Cert, issuer: &Cert, now: i64) -> Result<(), CertificateError> {
        let current: Vec<&Crl> = self
            .crls
            .iter()
            .filter(|c| c.issuer == cert.issuer && c.signature_valid(&issuer.spki) && c.this_update <= now && c.next_update.map(|n| n > now).unwrap_or(true))
            .collect();
        if current.is_empty() {
            return Err(CertificateError::UnknownRevocationStatus);
        }
        if current.iter().any(|c| c.serials.contains(&cert.serial)) {
            return Err(CertificateError::Revoked);
        }
        Ok(())
    }

    fn revocation(&self, end_entity: &[u8], intermediates: &[CertificateDer<'_>], now: i64) -> Result<(), CertificateError> {
        let leaf = Cert::from_der(end_entity).ok_or(CertificateError::BadEncoding)?;
        let inters: Vec<Cert> = intermediates.iter().filter_map(|c| Cert::from_der(c)).collect();
        let mut cert = leaf;
        for _ in 0..8 {
            let (issuer, is_root) = self.issuer_of(&cert, &inters).ok_or(CertificateError::UnknownIssuer)?;
            self.check_one(&cert, issuer, now)?;
            if !self.chain || is_root {
                return Ok(());
            }
            cert = issuer.clone();
        }
        Ok(())
    }
}

impl ClientCertVerifier for MeetVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn verify_client_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], now: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        let verified = self.inner.verify_client_cert(end_entity, intermediates, now)?;
        self.revocation(end_entity, intermediates, now.as_secs() as i64).map_err(rustls::Error::InvalidCertificate)?;
        Ok(verified)
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// tls_context: the server TLS for new connections.
pub fn tls_config(s: &Settings) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let certs = load_certs(&s.cert, "certificate")?;
    let key = load_key(&s.key)?;
    let roots = Arc::new(roots_of(&s.client_ca)?);
    let inner = WebPkiClientVerifier::builder_with_provider(roots, provider.clone()).build().map_err(|e| format!("the client CA does not load: {e}"))?;
    let verifier: Arc<dyn ClientCertVerifier> = match active_crl(s) {
        None => inner,
        Some(crl) => {
            let data = std::fs::read(&crl).map_err(|e| format!("cannot read the CRL {}: {e}", crl.display()))?;
            let crls = crls_in(&data);
            if crls.is_empty() {
                return Err(format!("the CRL file {} holds no CRL", crl.display()));
            }
            let ca_data = std::fs::read(&s.client_ca).map_err(|e| format!("cannot read the CA file {}: {e}", s.client_ca))?;
            let roots: Vec<Cert> = pem_blocks(&ca_data, "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).collect();
            Arc::new(MeetVerifier { inner, roots, crls, chain: bundle_checks_chain(&crl, Path::new(&s.client_ca)) })
        }
    };
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|e| format!("the relay certificate and key do not fit: {e}"))?;
    Ok(Arc::new(cfg))
}

// ── RefusalLog ───────────────────────────────────────────────────────────────────────────────────────────────

struct Refusals {
    counts: BTreeMap<String, u64>,
    others: u64,
    started: f64,
}

/// Refused or dropped connections: the first from each address in a period is one INFO line; the rest are counted
/// and summed up in one line when the period ends.
pub struct RefusalLog {
    mu: Mutex<Refusals>,
}

impl RefusalLog {
    pub fn new() -> RefusalLog {
        RefusalLog { mu: Mutex::new(Refusals { counts: BTreeMap::new(), others: 0, started: pj::mono() }) }
    }

    pub fn note(&self, address: &str) {
        {
            let mut r = self.mu.lock();
            Self::flush_locked(&mut r, pj::mono());
            if let Some(c) = r.counts.get_mut(address) {
                *c += 1;
                return;
            }
            if r.counts.len() >= REFUSAL_ADDRESSES {
                r.others += 1;
                return;
            }
            r.counts.insert(address.to_string(), 1);
        }
        log_info(&format!("connection from {address} refused or dropped"));
    }

    pub fn flush(&self) {
        let mut r = self.mu.lock();
        Self::flush_locked(&mut r, pj::mono());
    }

    fn flush_locked(r: &mut Refusals, now: f64) {
        if now - r.started < REFUSAL_EVERY {
            return;
        }
        let quiet: u64 = r.counts.values().map(|c| c - 1).sum::<u64>() + r.others;
        if quiet > 0 {
            let mut top: Vec<(&String, &u64)> = r.counts.iter().collect();
            top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let listed = top.iter().take(REFUSAL_LISTED).map(|(a, c)| format!("{a}={c}")).collect::<Vec<_>>().join(" ");
            let more = top.len() as i64 - REFUSAL_LISTED as i64;
            let total = r.counts.values().sum::<u64>() + r.others;
            log_info(&format!(
                "refused or dropped connections in the last {} min: total={total} {listed}{}{}",
                (REFUSAL_EVERY / 60.0).round() as i64,
                if more > 0 { format!(" (+{more} more addresses)") } else { String::new() },
                if r.others > 0 { format!(" other={}", r.others) } else { String::new() }
            ));
        }
        r.counts.clear();
        r.others = 0;
        r.started = now;
    }
}

// ── outbound HTTPS (blocking) ────────────────────────────────────────────────────────────────────────────────

/// The Python exception class name an outbound failure would carry (for "cannot reach ... (ClassName)").
fn error_class(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
        return match inner {
            rustls::Error::InvalidCertificate(_) => "SSLCertVerificationError",
            _ => "SSLError",
        };
    }
    match e.kind() {
        ConnectionRefused => "ConnectionRefusedError",
        TimedOut | WouldBlock => "TimeoutError",
        ConnectionReset => "ConnectionResetError",
        ConnectionAborted => "ConnectionAbortedError",
        UnexpectedEof => "RemoteDisconnected",
        InvalidData => "SSLError",
        NotFound => "gaierror",
        _ => "OSError",
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One HTTPS request on a fresh connection; `check` sees the server's certificate before the request goes out.
/// Err is the Python exception class name of the failure, or the message `check` gave.
#[allow(clippy::too_many_arguments)]
pub fn https_request(cfg: &Arc<ClientConfig>, host: &str, port: u16, timeout: f64, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>, check: &dyn Fn(&[u8]) -> Result<(), String>) -> Result<Response, Result<String, String>> {
    let t = Duration::from_secs_f64(timeout);
    let io = |e: std::io::Error| -> Result<String, String> { Err(error_class(&e).to_string()) };
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|_| Err("gaierror".to_string()))?.collect();
    let mut tcp = None;
    let mut last = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, t) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let mut tcp = match tcp {
        Some(s) => s,
        None => return Err(Err(last.map(|e| error_class(&e)).unwrap_or("gaierror").to_string())),
    };
    let _ = tcp.set_read_timeout(Some(t));
    let _ = tcp.set_write_timeout(Some(t));
    let name = ServerName::try_from(host.to_string()).map_err(|_| Err("SSLError".to_string()))?;
    let mut conn = rustls::ClientConnection::new(cfg.clone(), name).map_err(|_| Err("SSLError".to_string()))?;
    while conn.is_handshaking() {
        conn.complete_io(&mut tcp).map_err(io)?;
    }
    let peer = conn.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec()).unwrap_or_default();
    check(&peer).map_err(Ok)?;
    let mut stream = rustls::StreamOwned::new(conn, tcp);
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept-Encoding: identity\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        head.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    let mut out = head.into_bytes();
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    stream.write_all(&out).map_err(io)?;
    stream.flush().map_err(io)?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).map_err(io)? == 0 {
        return Err(Err("RemoteDisconnected".into()));
    }
    let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| Err("BadStatusLine".to_string()))?;
    let (mut length, mut chunked) = (None, false);
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).map_err(io)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
            if k == "content-length" {
                length = v.parse::<usize>().ok();
            } else if k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).map_err(io)?;
            let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).map_err(|_| Err("IncompleteRead".to_string()))?;
            if n == 0 {
                break;
            }
            let mut chunk = vec![0u8; n];
            reader.read_exact(&mut chunk).map_err(io)?;
            body.extend_from_slice(&chunk);
            let mut crlf = String::new();
            reader.read_line(&mut crlf).map_err(io)?;
        }
    } else if let Some(n) = length {
        body = vec![0u8; n];
        reader.read_exact(&mut body).map_err(|_| Err("IncompleteRead".to_string()))?;
    } else {
        let _ = reader.read_to_end(&mut body);
    }
    Ok(Response { status, body })
}

pub fn client_config(ca_file: Option<&str>, client: Option<(&str, &str)>) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let roots = match ca_file {
        Some(path) => roots_of(path)?,
        None => {
            let mut r = RootCertStore::empty();
            r.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            r
        }
    };
    let b = ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|e| e.to_string())?.with_root_certificates(roots);
    let cfg = match client {
        Some((cert, key)) => b.with_client_auth_cert(load_certs(cert, "certificate")?, load_key(key)?).map_err(|e| format!("the client certificate and key do not fit: {e}"))?,
        None => b.with_no_client_auth(),
    };
    Ok(Arc::new(cfg))
}

// ── SignerClient ─────────────────────────────────────────────────────────────────────────────────────────────

/// How a signer call failed: unreachable or unable to sign (the caller falls back to the PC path), or a refusal
/// mapped to the relay's errors (403, 404, 409, 400).
pub enum SignerErr {
    Down(String),
    Refused(E),
}

struct SignerState {
    status: Option<Obj>,
    error: String,
    checked: f64,
}

pub type OnStatus = Arc<dyn Fn(&Obj) + Send + Sync>;

/// The relay's side of the signer: `POST /v1/<op>` over mutual TLS with the relay's root-issued client
/// certificate. The signer's certificate must be issued DIRECTLY by the root.
pub struct SignerClient {
    host: String,
    port: u16,
    ca: String,
    cfg: Arc<ClientConfig>,
    state: Mutex<SignerState>,
    pub on_status: Mutex<Option<OnStatus>>,
}

impl SignerClient {
    pub fn new(url: &str, cert: &str, key: &str, ca: &str) -> Result<SignerClient, String> {
        let rest = url.strip_prefix("https://").ok_or("signer_url must be https://host:port")?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let authority = authority.rsplit('@').next().unwrap_or_default();
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let (h, after) = v6.split_once(']').ok_or("signer_url must be https://host:port")?;
            (h.to_string(), after.strip_prefix(':').map(|p| p.parse::<u16>()).transpose().map_err(|_| "signer_url must be https://host:port")?.unwrap_or(443))
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), if p.is_empty() { 443 } else { p.parse::<u16>().map_err(|_| "signer_url must be https://host:port")? }),
                None => (authority.to_string(), 443),
            }
        };
        if host.is_empty() {
            return Err("signer_url must be https://host:port".into());
        }
        let cfg = client_config(Some(ca), Some((cert, key)))?;
        Ok(SignerClient { host: host.to_ascii_lowercase(), port, ca: ca.to_string(), cfg, state: Mutex::new(SignerState { status: None, error: String::new(), checked: -1e9 }), on_status: Mutex::new(None) })
    }

    fn down(&self, error: &str) {
        let mut s = self.state.lock();
        s.status = None;
        s.error = error.to_string();
        s.checked = pj::mono();
    }

    pub fn error(&self) -> String {
        self.state.lock().error.clone()
    }

    pub fn call(&self, op: &str, body: &Obj) -> Result<Obj, SignerErr> {
        let ca = self.ca.clone();
        let check = move |der: &[u8]| -> Result<(), String> {
            let root = Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(&ca))));
            let leaf = Cert::from_der(der);
            match (leaf, root) {
                (Some(l), Some(r)) if l.issued_directly_by_root(&r) => Ok(()),
                _ => Err("the signer's certificate was not issued directly by the root".into()),
            }
        };
        let payload = pj::dumps(&serde_json::Value::Object(body.clone()));
        let res = https_request(&self.cfg, &self.host, self.port, SIGNER_TIMEOUT, "POST", &format!("/v1/{op}"), &[("Content-Type", "application/json".to_string())], Some(payload.as_bytes()), &check);
        let resp = match res {
            Ok(r) => r,
            Err(Err(class)) => {
                let msg = format!("cannot reach the signer ({class})");
                self.down(&msg);
                return Err(SignerErr::Down(msg));
            }
            Err(Ok(msg)) => {
                self.down(&msg);
                return Err(SignerErr::Down(msg));
            }
        };
        let raw = if resp.body.is_empty() { b"{}".to_vec() } else { resp.body };
        let data = serde_json::from_slice::<serde_json::Value>(&raw).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if resp.status == 200 {
            return Ok(data);
        }
        let error = {
            let e = pj::s(&data, "error");
            if e.is_empty() { format!("the signer answered {}", resp.status) } else { e }
        };
        match resp.status {
            403 => Err(SignerErr::Refused(E::Forbidden(error))),
            404 => Err(SignerErr::Refused(E::NotFound(error))),
            409 => Err(SignerErr::Refused(E::Conflict(error))),
            s if s >= 500 => {
                self.down(&error);
                Err(SignerErr::Down(error))
            }
            _ => Err(SignerErr::Refused(E::Bad(error))),
        }
    }

    /// The signer's status now; Err (the SignerDown message) when it cannot answer.
    pub fn refresh(&self) -> Result<Obj, String> {
        let status = match self.call("status", &Obj::new()) {
            Ok(s) => s,
            Err(SignerErr::Down(m)) => return Err(m),
            Err(SignerErr::Refused(e)) => {
                let m = e.message();
                self.down(&m);
                return Err(m);
            }
        };
        {
            let mut s = self.state.lock();
            s.status = Some(status.clone());
            s.error = pj::s(&status, "error");
            s.checked = pj::mono();
        }
        let hook = self.on_status.lock().clone();
        if let Some(h) = hook {
            h(&status);
        }
        Ok(status)
    }

    pub fn snapshot(&self) -> Option<Obj> {
        let s = self.state.lock();
        s.status.as_ref().filter(|o| !o.is_empty()).cloned()
    }

    /// True when the signer said it can sign within the last SIGNER_TTL seconds (a failed check is not retried for
    /// SIGNER_RETRY seconds).
    pub fn ready(&self) -> bool {
        {
            let s = self.state.lock();
            let healthy = s.status.as_ref().map(|o| pj::truthy(o.get("healthy"))).unwrap_or(false);
            let age = pj::mono() - s.checked;
            if age < if healthy { SIGNER_TTL } else { SIGNER_RETRY } {
                return healthy;
            }
        }
        self.refresh().map(|s| pj::truthy(s.get("healthy"))).unwrap_or(false)
    }
}
