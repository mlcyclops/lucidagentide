// Contract AI-1 sections 3, 4 and 6 (slice AI-1d): the organization's AI gateway, `lucid-relay ai`.
//
//   lucid-relay ai [serve] --config <ai-gateway.json>     (or LUCID_AI_CONFIG)
//   lucid-relay ai card-add <card.json> --config f        check a model card (3.1) and keep it in the state folder
//   lucid-relay ai cards --config f                       every card with its status and last benchmark
//   lucid-relay ai bench <card_id> [--files a,b] --config f   the registration benchmark (3.2)
//   lucid-relay ai approve <card_id> --by <email> --for-classes a,b [--retention-override <reason>] --config f
//   lucid-relay ai usage [--since <unix s>] --config f    requests, refusals by code, spend, card health, rids
//   lucid-relay ai audit-verify --config f                the audit log's hash chain (6.8)
//
// The config file (JSON; relative paths are read from its folder):
//   {"state_dir", "host" (0.0.0.0), "port" (8443), "cert", "key" (the gateway's `ai` app certificate from the org
//    signer: server TLS, and the client certificate toward the relay unless "relay_cert"/"relay_key" are given),
//    "client_ca" (the org CA root), "crl" (optional extra CRL file, re-read hourly), "relay" (https URL of the org's
//    relay), "relay_ca" (default client_ca), "org", "previous_signer_serial", "admin_spki" (lower-case hex SHA-256 of
//    the Admin Console client certificate's SubjectPublicKeyInfo), "backend_ca" (extra CA for internal backends),
//    "backends" ({card_id: {"api_key_env", "azure_api_version", "azure_deployment", "aws_region",
//    "aws_access_key_id_env", "aws_secret_access_key_env", "aws_session_token_env", "model_path"}}),
//    "audit_days" (400), "bench_on_start" (true)}
//
// Mutual TLS (6.1): a person's device certificate chaining to the org CA, with a current CRL from every issuer of
// its chain (refreshed from the relay's `GET /v1/crl` every hour), kind person, and the principal's domain in the
// pinned policy's `domains`. The Admin Console's own certificate is pinned by its SPKI (`admin_spki`) and reaches
// only `/v1/ai/admin/*`. The policy and AI map come from the relay over the gateway's app session (6.2,
// ai_gateway_policy.rs); `who` from `GET /v1/ai/allowed?principal=` (6.4). The gateway keeps no question, snippet or
// answer after replying and logs metadata only.

use crate::ai_gateway_admit::{self as admit, Budgets, Limits};
use crate::ai_gateway_ask::{self as ask, Load, Redactor, Refusal, Request, Usable};
use crate::ai_gateway_audit::{Audit, Record, KEEP_DAYS};
use crate::ai_gateway_backend::{uri_encode, Backends, Credential, Metrics, Prompt};
use crate::ai_gateway_bench as bench;
use crate::ai_gateway_cards::{self as cards, Card, CardStore};
use crate::ai_gateway_policy::{verify_pair, Pair, Pins, Trust, WhoCache};
use crate::codec::{now_ms, sha256_hex};
use crate::meet::{log_info, log_warn, Identity};
use crate::meet_x509::{pem_blocks, Cert, Crl};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Response;
use hyper_util::rt::TokioIo;
use parking_lot::{Mutex, RwLock};
use rustls::client::danger::HandshakeSignatureValid;
use rustls::pki_types::{CertificateDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::WebPkiClientVerifier;
use rustls::{CertificateError, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig, SignatureScheme};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

const CONFIG_KEYS: [&str; 18] = [
    "state_dir", "host", "port", "cert", "key", "relay_cert", "relay_key", "client_ca", "crl", "relay", "relay_ca", "org", "previous_signer_serial", "admin_spki", "backend_ca", "backends", "audit_days", "bench_on_start",
];
const REPLAY_MS: i64 = 10 * 60 * 1000;
const POLICY_EVERY_MS: i64 = 5 * 60 * 1000;
const CRL_EVERY_MS: i64 = 60 * 60 * 1000;
const BENCH_EVERY_S: i64 = 7 * 86_400;
const METRICS_FRESH_MS: i64 = 2000;
const DOWN_AFTER_FAILS: u32 = 3;
const DOWN_FOR_MS: i64 = 30_000;
const DOWN: Load = Load { healthy: false, queue_ms: 0, free_kv_bytes: None };

pub const NOT_PERSON: &str = "only a person's device certificate may ask the AI gateway";
pub const ADMIN_ONLY: &str = "only the Admin Console may manage this gateway";
pub const WHO_NO: &str = "you are not on the organization's list of people who may use AI";
pub const WHO_UNCHECKED: &str = "whether you may use the organization's AI could not be checked; try again soon";
pub const REPLAYED: &str = "that request id was already used";
pub const NO_ANSWER: &str = "the model did not answer; try again soon";

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct Config {
    pub state_dir: PathBuf,
    pub host: String,
    pub port: u16,
    pub cert: String,
    pub key: String,
    pub relay_cert: String,
    pub relay_key: String,
    pub client_ca: String,
    pub crl: String,
    pub relay: String,
    pub relay_ca: String,
    pub org: String,
    pub previous_signer_serial: String,
    pub admin_spki: Vec<String>,
    pub backend_ca: String,
    pub backends: Map<String, Value>,
    pub audit_days: i64,
    pub bench_on_start: bool,
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, String> {
        let data = std::fs::read(path).map_err(|e| format!("cannot read the gateway config {}: {e}", path.display()))?;
        let v: Value = serde_json::from_slice(&data).map_err(|_| format!("the gateway config {} is not JSON", path.display()))?;
        let o = v.as_object().ok_or("the gateway config must be an object")?;
        if let Some(k) = o.keys().find(|k| !CONFIG_KEYS.contains(&k.as_str())) {
            return Err(format!("the gateway config has no setting {k}"));
        }
        let base = path.parent().unwrap_or(Path::new("."));
        let text = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let file = |k: &str| {
            let t = text(k);
            if t.is_empty() || Path::new(&t).is_absolute() {
                t
            } else {
                base.join(&t).to_string_lossy().into_owned()
            }
        };
        let mut c = Config {
            state_dir: PathBuf::from(file("state_dir")),
            host: Some(text("host")).filter(|h| !h.is_empty()).unwrap_or_else(|| "0.0.0.0".into()),
            port: o.get("port").and_then(Value::as_u64).map(|p| p as u16).unwrap_or(8443),
            cert: file("cert"),
            key: file("key"),
            relay_cert: file("relay_cert"),
            relay_key: file("relay_key"),
            client_ca: file("client_ca"),
            crl: file("crl"),
            relay: text("relay"),
            relay_ca: file("relay_ca"),
            org: text("org"),
            previous_signer_serial: text("previous_signer_serial"),
            admin_spki: o.get("admin_spki").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_lowercase).collect()).unwrap_or_default(),
            backend_ca: file("backend_ca"),
            backends: o.get("backends").and_then(Value::as_object).cloned().unwrap_or_default(),
            audit_days: o.get("audit_days").and_then(Value::as_i64).unwrap_or(KEEP_DAYS),
            bench_on_start: o.get("bench_on_start").and_then(Value::as_bool).unwrap_or(true),
        };
        for (k, v) in [("state_dir", c.state_dir.as_os_str().is_empty()), ("cert", c.cert.is_empty()), ("key", c.key.is_empty()), ("client_ca", c.client_ca.is_empty()), ("org", c.org.is_empty())] {
            if v {
                return Err(format!("the gateway config needs {k}"));
            }
        }
        if !cards::https_url_ok(&c.relay) {
            return Err("relay must be the https:// URL of the organization's relay".into());
        }
        if c.relay_cert.is_empty() {
            c.relay_cert = c.cert.clone();
            c.relay_key = c.key.clone();
        }
        if c.relay_ca.is_empty() {
            c.relay_ca = c.client_ca.clone();
        }
        Ok(c)
    }
}

// ── the relay over the gateway's app session ─────────────────────────────────────────────────────────────────

/// What the gateway asks of its relay (blocking calls, run off the async workers).
pub trait RelayApi: Send + Sync {
    /// 6.4 `GET /v1/ai/allowed?principal=`.
    fn allowed(&self, principal: &str) -> Result<bool, String>;
    /// 6.2: `{"policy": signed policy, "map": signed AI map, "signer_policy"}` of the org.
    fn wires(&self, org: &str) -> Result<Value, String>;
    /// `GET /v1/crl`: the relay's CRLs, DER one after another.
    fn crl(&self) -> Result<Vec<u8>, String>;
    /// Wait up to 25 s for the session's events: true when a policy or AI map changed or the session is new.
    fn changed(&self) -> Result<bool, String>;
}

pub struct RelayLink {
    cfg: Arc<rustls::ClientConfig>,
    host: String,
    port: u16,
    session: Mutex<String>,
    after: Mutex<i64>,
}

/// `(host, port)` of an `https://` URL (port 443 by default).
pub fn host_port(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let hostport = rest.split('/').next()?;
    if let Some(v6) = hostport.strip_prefix('[') {
        let (h, p) = v6.split_once(']')?;
        let port = p.strip_prefix(':').map(|x| x.parse().ok()).unwrap_or(Some(443))?;
        return Some((h.to_string(), port));
    }
    match hostport.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
        None => Some((hostport.to_string(), 443)),
    }
}

impl RelayLink {
    pub fn new(c: &Config) -> Result<RelayLink, String> {
        let cfg = crate::meet_tls::client_config(Some(c.relay_ca.as_str()), Some((c.relay_cert.as_str(), c.relay_key.as_str())))?;
        let (host, port) = host_port(&c.relay).ok_or("relay must be an https:// URL")?;
        Ok(RelayLink { cfg, host, port, session: Mutex::new(String::new()), after: Mutex::new(0) })
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>, timeout: f64) -> Result<(u16, Vec<u8>), String> {
        let bytes = body.map(|b| b.to_string().into_bytes());
        let headers: Vec<(&str, String)> = if bytes.is_some() { vec![("Content-Type", "application/json".to_string())] } else { Vec::new() };
        match crate::meet_tls::https_request(&self.cfg, &self.host, self.port, timeout, method, path, &headers, bytes.as_deref(), &|_| Ok(())) {
            Ok(r) => Ok((r.status, r.body)),
            Err(Ok(m)) | Err(Err(m)) => Err(format!("the relay cannot be reached ({m})")),
        }
    }

    fn json(&self, path: &str) -> Result<Value, String> {
        let (status, body) = self.call("GET", path, None, 20.0)?;
        if status != 200 {
            return Err(format!("the relay answered {status} to {}", path.split('?').next().unwrap_or_default()));
        }
        serde_json::from_slice(&body).map_err(|_| "the relay's answer is not JSON".to_string())
    }

    /// The app session, opened with `POST /v1/apps/c/hello` when there is none; true when it was just opened.
    fn session(&self) -> Result<(String, bool), String> {
        let current = self.session.lock().clone();
        if !current.is_empty() {
            return Ok((current, false));
        }
        let (status, body) = self.call("POST", "/v1/apps/c/hello", Some(&json!({})), 20.0)?;
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let s = v["session"].as_str().filter(|_| status == 200).ok_or_else(|| format!("the relay refused the gateway's session ({status})"))?.to_string();
        *self.session.lock() = s.clone();
        *self.after.lock() = 0;
        Ok((s, true))
    }
}

impl RelayApi for RelayLink {
    fn allowed(&self, principal: &str) -> Result<bool, String> {
        let (s, _) = self.session()?;
        let (status, body) = self.call("GET", &format!("/v1/ai/allowed?principal={}&session={}", uri_encode(principal), uri_encode(&s)), None, 20.0)?;
        match status {
            200 => Ok(serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["allowed"].as_bool()) == Some(true)),
            404 => Ok(false),
            other => Err(format!("the relay answered {other} to /v1/ai/allowed")),
        }
    }

    fn wires(&self, org: &str) -> Result<Value, String> {
        let p = self.json(&format!("/v1/org/policy?org={}", uri_encode(org)))?;
        let sha = p["signed"]["policy"]["ai"]["map_sha256"].as_str().ok_or("the organization's policy names no AI map")?.to_string();
        let m = self.json(&format!("/v1/org/ai?org={}&sha256={}", uri_encode(org), uri_encode(&sha)))?;
        Ok(json!({"policy": p["signed"], "map": m["signed"], "signer_policy": p["signer_policy"]}))
    }

    fn crl(&self) -> Result<Vec<u8>, String> {
        let (status, body) = self.call("GET", "/v1/crl", None, 20.0)?;
        if status != 200 {
            return Err(format!("the relay answered {status} to /v1/crl"));
        }
        Ok(body)
    }

    fn changed(&self) -> Result<bool, String> {
        let (s, fresh) = self.session()?;
        let after = *self.after.lock();
        let (status, body) = self.call("GET", &format!("/v1/apps/c/events?session={}&after={after}&wait=25", uri_encode(&s)), None, 40.0)?;
        if status != 200 {
            self.session.lock().clear();
            return Err(format!("the relay ended the gateway's session ({status})"));
        }
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let events = v["events"].as_array().cloned().unwrap_or_default();
        let last = events.iter().filter_map(|e| e["seq"].as_i64()).max();
        let changed = events.iter().any(|e| matches!(e["type"].as_str(), Some("org_policy" | "org_ai")));
        if let Some(seq) = last {
            *self.after.lock() = seq;
            let _ = self.call("POST", "/v1/apps/c/ack", Some(&json!({"session": s, "seq": seq})), 20.0);
        }
        Ok(fresh || changed)
    }
}

// ── mutual TLS ───────────────────────────────────────────────────────────────────────────────────────────────

/// True when the certificate's SubjectPublicKeyInfo hash is in `admin_spki` and it is inside its validity.
pub fn admin_pinned(der: &[u8], admin_spki: &[String], now: i64) -> bool {
    Cert::from_der(der).is_some_and(|c| admin_spki.contains(&sha256_hex(&c.spki)) && c.not_before <= now && now <= c.not_after)
}

fn issuer_of<'a>(cert: &Cert, inters: &'a [Cert], roots: &'a [Cert]) -> Option<(&'a Cert, bool)> {
    if let Some(c) = inters.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)) {
        return Some((c, false));
    }
    roots.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)).map(|c| (c, true))
}

/// The client verifier: the chain to the org CA by webpki, then every certificate of the chain needs a current CRL
/// from its issuer, signed by that issuer, that does not list it (the CRLs are replaced hourly while it runs).
/// The Admin Console's pinned certificate is taken as it is (its routes are only `/v1/ai/admin/*`).
#[derive(Debug)]
struct Verifier {
    inner: Arc<dyn ClientCertVerifier>,
    roots: Vec<Cert>,
    crls: Arc<RwLock<Vec<Crl>>>,
    admin_spki: Vec<String>,
}

impl Verifier {
    fn revocation(&self, end_entity: &[u8], intermediates: &[CertificateDer<'_>], now: i64) -> Result<(), CertificateError> {
        let mut cert = Cert::from_der(end_entity).ok_or(CertificateError::BadEncoding)?;
        let inters: Vec<Cert> = intermediates.iter().filter_map(|c| Cert::from_der(c)).collect();
        let crls = self.crls.read();
        for _ in 0..8 {
            let (issuer, is_root) = issuer_of(&cert, &inters, &self.roots).ok_or(CertificateError::UnknownIssuer)?;
            let current: Vec<&Crl> = crls.iter().filter(|c| c.issuer == cert.issuer && c.signature_valid(&issuer.spki) && c.this_update <= now && c.next_update.map_or(true, |n| n > now)).collect();
            if current.is_empty() {
                return Err(CertificateError::UnknownRevocationStatus);
            }
            if current.iter().any(|c| c.serials.contains(&cert.serial)) {
                return Err(CertificateError::Revoked);
            }
            if is_root {
                return Ok(());
            }
            cert = issuer.clone();
        }
        Err(CertificateError::UnknownIssuer)
    }
}

impl ClientCertVerifier for Verifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn verify_client_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], now: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        let t = now.as_secs() as i64;
        if admin_pinned(end_entity, &self.admin_spki, t) {
            return Ok(ClientCertVerified::assertion());
        }
        let verified = self.inner.verify_client_cert(end_entity, intermediates, now)?;
        self.revocation(end_entity, intermediates, t).map_err(rustls::Error::InvalidCertificate)?;
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

/// The CRLs in DER one after another (the relay's `/v1/crl`) or PEM.
pub fn crls_of(data: &[u8]) -> Vec<Crl> {
    let pem = crate::meet_tls::crls_in(data);
    if !pem.is_empty() {
        return pem;
    }
    let mut out = Vec::new();
    let mut rest = data;
    while let Some(t) = crate::der::tlv(rest) {
        let used = rest.len() - t.rest.len();
        if let Some(c) = Crl::from_der(&rest[..used]) {
            out.push(c);
        }
        rest = t.rest;
    }
    out
}

// ── the gateway ──────────────────────────────────────────────────────────────────────────────────────────────

/// What the gateway knows about a card's backend while it runs.
#[derive(Clone, Debug, Default)]
struct Live {
    fails: u32,
    down_until_ms: i64,
    mean_ms: Option<u64>,
    metrics: Option<(Metrics, i64)>,
    /// Frontier: decode rates of real answers (tokens per second), for the weekly rolling median (3.2).
    decode_samples: Vec<u64>,
}

pub struct Gateway {
    pub cfg: Config,
    /// This gateway's principal and device (from its certificate).
    pub me: (String, String),
    pub pins: Pins,
    pub who: WhoCache,
    pub budgets: Budgets,
    pub audit: Audit,
    pub cards: CardStore,
    pub backends: Backends,
    pub creds: HashMap<String, Credential>,
    pub relay: Arc<dyn RelayApi>,
    roots: Vec<Cert>,
    crls: Arc<RwLock<Vec<Crl>>>,
    rids: Mutex<HashMap<String, i64>>,
    live: Mutex<HashMap<String, Live>>,
    benches: Mutex<HashMap<String, Value>>,
}

fn s_now() -> i64 {
    now_ms().div_euclid(1000)
}

impl Gateway {
    pub fn new(cfg: Config, relay: Arc<dyn RelayApi>) -> Result<Gateway, String> {
        std::fs::create_dir_all(&cfg.state_dir).map_err(|e| format!("cannot make the state folder {}: {e}", cfg.state_dir.display()))?;
        let own = Cert::from_pem(&String::from_utf8_lossy(&std::fs::read(&cfg.cert).map_err(|e| format!("cannot read {}: {e}", cfg.cert))?)).ok_or("the gateway certificate does not read")?;
        let principal = own.names.emails.first().map(|e| e.trim().to_lowercase()).unwrap_or_default();
        let device = crate::meet::uri_value(&own.names.uris, crate::meet::DEVICE_URI_PREFIX);
        if !principal.starts_with("ai@apps.") || device.is_empty() {
            return Err("the gateway certificate must be the org's ai app certificate (ai@apps.<domain> with a device)".into());
        }
        let roots = crate::meet_tls::self_signed_roots(Path::new(&cfg.client_ca));
        if roots.is_empty() {
            return Err(format!("{} holds no root certificate", cfg.client_ca));
        }
        let mut crls = crls_of(&std::fs::read(cfg.state_dir.join("relay-crl.der")).unwrap_or_default());
        if !cfg.crl.is_empty() {
            crls.extend(crls_of(&std::fs::read(&cfg.crl).unwrap_or_default()));
        }
        let me = (principal, device);
        let pins = {
            let trust = Trust { roots: &roots, crls: &crls, previous_serial: &cfg.previous_signer_serial };
            let verify = |w: &Value| verify_pair(w, &trust, &cfg.org, (me.0.as_str(), me.1.as_str()), crate::meet_json::now());
            Pins::open(Some(cfg.state_dir.join("pins.json")), &verify)
        };
        let mut creds = HashMap::new();
        for (id, v) in &cfg.backends {
            creds.insert(id.clone(), Credential::from_config(v, &|name: &str| std::env::var(name).ok().filter(|x| !x.is_empty())));
        }
        Ok(Gateway {
            pins,
            who: WhoCache::default(),
            budgets: Budgets::open(Some(cfg.state_dir.join("budgets.json"))),
            audit: Audit::open(&cfg.state_dir.join("audit"), cfg.audit_days)?,
            cards: CardStore::new(&cfg.state_dir),
            backends: Backends::new(Some(cfg.backend_ca.as_str()))?,
            creds,
            relay,
            roots,
            crls: Arc::new(RwLock::new(crls)),
            rids: Mutex::new(HashMap::new()),
            live: Mutex::new(HashMap::new()),
            benches: Mutex::new(HashMap::new()),
            me,
            cfg,
        })
    }

    /// The server TLS: the gateway's certificate, TLS 1.2 or later, HTTP/1.1, a client certificate required.
    pub fn tls_config(&self) -> Result<Arc<ServerConfig>, String> {
        let provider = Arc::new(crate::server::provider());
        let read = |p: &str| std::fs::read(p).map_err(|e| format!("cannot read {p}: {e}"));
        let certs = rustls_pemfile::certs(&mut read(&self.cfg.cert)?.as_slice()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("the gateway certificate does not read: {e}"))?;
        let key = rustls_pemfile::private_key(&mut read(&self.cfg.key)?.as_slice()).map_err(|e| format!("the gateway key does not read: {e}"))?.ok_or("the gateway key file holds no key")?;
        let mut store = RootCertStore::empty();
        for (_, der) in pem_blocks(&read(&self.cfg.client_ca)?, "CERTIFICATE") {
            store.add(CertificateDer::from(der)).map_err(|e| format!("the client CA does not read: {e}"))?;
        }
        let inner = WebPkiClientVerifier::builder_with_provider(Arc::new(store), provider.clone()).build().map_err(|e| format!("the client CA does not load: {e}"))?;
        let verifier = Arc::new(Verifier { inner, roots: self.roots.clone(), crls: self.crls.clone(), admin_spki: self.cfg.admin_spki.clone() });
        let mut cfg = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(|e| e.to_string())?
            .with_client_cert_verifier(verifier)
            .with_single_cert(certs, key)
            .map_err(|e| format!("the gateway certificate and key do not fit: {e}"))?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(cfg))
    }

    /// New CRLs from the relay (kept in the state folder) plus the configured file, re-read.
    pub fn set_crls(&self, relay_der: Option<Vec<u8>>) {
        let path = self.cfg.state_dir.join("relay-crl.der");
        if let Some(d) = relay_der.as_ref().filter(|d| !crls_of(d).is_empty()) {
            let _ = crate::meet_tls::write_atomic(&path, d);
        }
        let mut all = crls_of(&std::fs::read(&path).unwrap_or_default());
        if !self.cfg.crl.is_empty() {
            all.extend(crls_of(&std::fs::read(&self.cfg.crl).unwrap_or_default()));
        }
        *self.crls.write() = all;
    }

    /// 6.2: verify and pin the relay's policy and map; a new pin asks `who` again.
    pub fn refresh_policy(&self, wires: &Value) -> Result<bool, String> {
        let crls = self.crls.read().clone();
        let trust = Trust { roots: &self.roots, crls: &crls, previous_serial: &self.cfg.previous_signer_serial };
        let pair = verify_pair(wires, &trust, &self.cfg.org, (self.me.0.as_str(), self.me.1.as_str()), crate::meet_json::now())?;
        let (hash, seq) = (pair.policy_hash.clone(), pair.policy_seq);
        let changed = self.pins.pin(pair, now_ms())?;
        if changed {
            self.who.clear();
            log_info(&format!("ai_policy_pinned org={} seq={seq} hash={hash}", self.cfg.org));
        }
        Ok(changed)
    }

    fn cred(&self, id: &str) -> Credential {
        self.creds.get(id).cloned().unwrap_or_default()
    }

    /// Cards that may take requests: approved or degraded (degraded ranks last).
    pub fn usable(&self, now: i64) -> Vec<Usable> {
        let (all, refused) = self.cards.all();
        for (id, why) in refused {
            log_warn(&format!("ai_card_refused card={id} why={why}"));
        }
        all.into_iter()
            .filter_map(|card| {
                let st = self.cards.state(&card.card_id);
                match cards::status(&card, &st, now) {
                    "approved" => Some(Usable { card, degraded: false }),
                    "degraded" => Some(Usable { card, degraded: true }),
                    _ => None,
                }
            })
            .collect()
    }

    fn default_service_ms(card: &Card) -> u64 {
        match (card.throughput.int("prefill_tps"), card.throughput.int("decode_tps")) {
            (Some(p), Some(d)) if p > 0 && d > 0 => (2048 * 1000u64).div_ceil(p) + (512 * 1000u64).div_ceil(d),
            _ => 1000,
        }
    }

    /// Live load of the cards in `tiers`: org cards from their runtime's metrics (fresh for 2 s), frontier cards
    /// healthy unless they failed 3 times in a row in the last 30 s.
    async fn loads(&self, usable: &[Usable], tiers: &[String], now: i64) -> HashMap<String, Load> {
        let mut out = HashMap::new();
        for u in usable.iter().filter(|u| tiers.contains(&u.card.tier)) {
            let id = u.card.card_id.clone();
            let live = self.live.lock().get(&id).cloned().unwrap_or_default();
            if live.down_until_ms > now {
                out.insert(id, DOWN);
                continue;
            }
            if !u.card.org() {
                out.insert(id, Load { healthy: true, queue_ms: 0, free_kv_bytes: None });
                continue;
            }
            let metrics = match live.metrics {
                Some((m, at)) if now - at < METRICS_FRESH_MS => Ok(m),
                _ => self.backends.metrics(&u.card, &self.cred(&id)).await,
            };
            match metrics {
                Ok(m) => {
                    self.live.lock().entry(id.clone()).or_default().metrics = Some((m, now));
                    let mean = live.mean_ms.unwrap_or_else(|| Self::default_service_ms(&u.card));
                    let per_tok = match (u.card.arch, admit::kv_bytes(&u.card.kv_cache)) {
                        (Some((l, h, d)), Some(b)) => Some(2 * l * h * d * b),
                        _ => None,
                    };
                    let free = m.waiting.and(m.free_kv_bytes(per_tok));
                    out.insert(id, Load { healthy: true, queue_ms: m.waiting.unwrap_or(0) * mean, free_kv_bytes: free });
                }
                Err(e) => {
                    log_warn(&format!("ai_card_metrics card={id} error={e}"));
                    out.insert(id, DOWN);
                }
            }
        }
        out
    }

    fn note_ok(&self, card: &Card, took_ms: u64, tokens_out: u64) {
        let mut l = self.live.lock();
        let e = l.entry(card.card_id.clone()).or_default();
        e.fails = 0;
        e.mean_ms = Some(match e.mean_ms {
            Some(m) => (m * 7 + took_ms) / 8,
            None => took_ms,
        });
        if !card.org() && took_ms > 0 {
            e.decode_samples.push(tokens_out * 1000 / took_ms);
            let n = e.decode_samples.len();
            if n > 1000 {
                e.decode_samples.drain(..n - 1000);
            }
        }
    }

    fn note_fail(&self, card: &Card, now: i64) {
        let mut l = self.live.lock();
        let e = l.entry(card.card_id.clone()).or_default();
        e.fails += 1;
        if e.fails >= DOWN_AFTER_FAILS {
            e.down_until_ms = now + DOWN_FOR_MS;
            e.fails = 0;
        }
    }

    /// A `rid` is taken once per 10 minutes.
    fn rid_fresh(&self, rid: &str, now: i64) -> bool {
        let mut r = self.rids.lock();
        r.retain(|_, at| now - *at < REPLAY_MS);
        if r.contains_key(rid) {
            return false;
        }
        r.insert(rid.to_string(), now);
        true
    }

    /// 6.4: the relay's `allowed`, cached 5 minutes.
    async fn allowed(&self, principal: &str, now: i64) -> Result<bool, String> {
        if let Some(a) = self.who.get(principal, now) {
            return Ok(a);
        }
        let (relay, p) = (self.relay.clone(), principal.to_string());
        let a = tokio::task::spawn_blocking(move || relay.allowed(&p)).await.map_err(|e| e.to_string())??;
        self.who.put(principal, a, now);
        Ok(a)
    }

    /// The checks every request makes before the cards: the pinned pairs for its hash, org AI on, covered, tiers,
    /// and `who`.
    async fn gate(&self, who: &Identity, policy: &str, tiers: &[String], now: i64) -> Result<Vec<Pair>, Refusal> {
        let pairs = self.pins.pairs_for(policy, now).map_err(|m| Refusal::new(409, "unverified", m))?;
        ask::check_pairs(&pairs, &who.principal, tiers)?;
        match self.allowed(&who.principal, now).await {
            Ok(true) => Ok(pairs),
            Ok(false) => Err(Refusal::new(403, "who", WHO_NO)),
            Err(e) => {
                log_warn(&format!("ai_who_unchecked principal={} error={e}", who.principal));
                Err(Refusal::new(403, "who", WHO_UNCHECKED))
            }
        }
    }

    /// `POST /v1/ai/ask` (6.3), with its audit line (6.8).
    pub async fn ask(&self, who: &Identity, raw: &[u8]) -> (u16, Value) {
        let started = Instant::now();
        let mut rec = Record { principal: who.principal.clone(), device: who.device.clone(), outcome: "refused".into(), ..Record::default() };
        let r = self.ask_inner(who, raw, now_ms(), &mut rec).await;
        rec.took_ms = started.elapsed().as_millis() as u64;
        let (status, body) = match r {
            Ok(v) => {
                rec.outcome = "answered".into();
                (200, v)
            }
            Err(e) => {
                rec.code = e.code.to_string();
                if e.status == 500 {
                    rec.outcome = "failed".into();
                }
                (e.status, e.body())
            }
        };
        if let Err(e) = self.audit.append(&rec, now_ms()) {
            log_warn(&format!("ai_audit_failed rid={} error={e}", rec.rid));
        }
        (status, body)
    }

    async fn ask_inner(&self, who: &Identity, raw: &[u8], now: i64, rec: &mut Record) -> Result<Value, Refusal> {
        let v = ask::parse_body(raw)?;
        let a = ask::parse_ask(&v)?;
        rec.rid = a.rid.clone();
        rec.activity = a.activity.clone();
        rec.policy = a.policy.clone();
        if !self.rid_fresh(&a.rid, now) {
            return Err(Refusal::new(409, "conflict", REPLAYED));
        }
        let pairs = self.gate(who, &a.policy, &a.tiers, now).await?;
        let ranks = pairs.iter().map(|p| ask::request_class(p, &a.snippets)).collect::<Result<Vec<_>, _>>()?;
        let last = pairs.len() - 1;
        rec.class = pairs[last].ai.classes.get(ranks[last]).cloned().unwrap_or_default();
        // the prompt as it is, and with placeholders for a frontier card of a redact_for_frontier class (5.4)
        let nonce = crate::meet_json::token_hex(6);
        let plain: Vec<(String, String, bool, String)> = a.snippets.iter().map(|s| (s.id.clone(), s.from.clone(), s.meeting, s.text.clone())).collect();
        let user_plain = ask::user_prompt(&a.question, &plain, &nonce);
        let mut red = Redactor::new(a.snippets.iter().map(|s| s.from.as_str()));
        let red_question = red.redact(&a.question);
        let mut red_snippets = Vec::with_capacity(plain.len());
        for (id, from, meeting, text) in &plain {
            red_snippets.push((id.clone(), red.redact(from), *meeting, red.redact(text)));
        }
        let user_red = ask::user_prompt(&red_question, &red_snippets, &nonce);
        let sys = admit::estimate_tokens(ask::SYSTEM);
        let usable = self.usable(now.div_euclid(1000));
        let loads = self.loads(&usable, &a.tiers, now).await;
        let req = Request {
            principal: &who.principal,
            activity: &a.activity,
            tiers: &a.tiers,
            ranks,
            tokens_plain: sys + admit::estimate_tokens(&user_plain),
            tokens_redacted: sys + admit::estimate_tokens(&user_red),
        };
        let budgets = &self.budgets;
        let mut reserve = |_: &Card, amount: u64, limits: Limits, deadline: u64| budgets.reserve(&a.rid, &who.principal, amount, limits, now, 2 * deadline as i64).is_ok();
        let plan = ask::plan(&pairs, &req, &usable, &|c: &Card| loads.get(&c.card_id).copied().unwrap_or(DOWN), &mut reserve)?;
        rec.tier = plan.card.tier.clone();
        rec.card_id = plan.card.card_id.clone();
        rec.class = plan.class.clone();
        rec.expected_ms = plan.expected_ms;
        let prompt = Prompt { system: ask::SYSTEM.to_string(), user: if plan.redact { user_red } else { user_plain }, max_output: plan.max_output };
        let started = Instant::now();
        let got = self.backends.complete(&plan.card, &self.cred(&plan.card.card_id), &prompt, Duration::from_millis(2 * plan.deadline_ms)).await;
        let took = started.elapsed().as_millis() as u64;
        let c = match got {
            Ok(c) => c,
            Err(e) => {
                self.budgets.release(&a.rid);
                self.note_fail(&plan.card, now_ms());
                log_warn(&format!("ai_backend_failed card={} rid={} error={e}", plan.card.card_id, a.rid));
                return Err(Refusal::new(503, "health", NO_ANSWER));
            }
        };
        let text = if plan.redact { red.restore(&c.text) } else { c.text.clone() };
        let sent: Vec<String> = a.snippets.iter().map(|s| s.id.clone()).collect();
        let (answer, cites, _) = ask::filter_cites(&text, &sent);
        let tokens_in = c.tokens_in.unwrap_or(plan.tokens_in);
        let tokens_out = c.tokens_out.unwrap_or_else(|| admit::estimate_tokens(&c.text));
        self.note_ok(&plan.card, took, tokens_out);
        let usd = if plan.card.org() { 0 } else { admit::cost_micro(tokens_in, tokens_out, plan.card.price.0, plan.card.price.1) };
        if !plan.card.org() {
            self.budgets.settle(&a.rid, &who.principal, usd, now_ms());
        }
        (rec.tokens_in, rec.tokens_out, rec.usd_micro) = (tokens_in, tokens_out, usd);
        let alternatives: Vec<Value> = plan.alternatives.iter().map(|(id, why)| json!({"capability_id": id, "why_not": why})).collect();
        Ok(json!({
            "v": 1, "rid": a.rid, "policy": a.policy, "answer": answer, "cites": cites, "tier": plan.card.tier,
            "card_id": plan.card.card_id, "model": plan.card.model,
            "route": {"decision_id": crate::meet_json::token_hex(16), "feasible": plan.feasible, "chosen": plan.card.card_id, "alternatives": alternatives},
            "usage": {"tokens_in": tokens_in, "tokens_out": tokens_out, "usd_micro": usd},
        }))
    }

    /// `POST /v1/ai/estimate` (6.3): the same checks and admission without content (no reservation).
    pub async fn estimate(&self, who: &Identity, raw: &[u8]) -> (u16, Value) {
        match self.estimate_inner(who, raw, now_ms()).await {
            Ok(v) => (200, v),
            Err(e) => (e.status, e.body()),
        }
    }

    async fn estimate_inner(&self, who: &Identity, raw: &[u8], now: i64) -> Result<Value, Refusal> {
        let v = ask::parse_body(raw)?;
        let e = ask::parse_estimate(&v)?;
        let pairs = self.gate(who, &e.policy, &e.tiers, now).await?;
        let ranks = pairs.iter().map(|p| p.ai.rank(&e.class).ok_or_else(|| Refusal::new(400, "bad_request", "class must be one of the organization's classes"))).collect::<Result<Vec<_>, _>>()?;
        let tokens = e.tokens_in + admit::estimate_tokens(ask::SYSTEM) + 64;
        let usable = self.usable(now.div_euclid(1000));
        let loads = self.loads(&usable, &e.tiers, now).await;
        let req = Request { principal: &who.principal, activity: &e.activity, tiers: &e.tiers, ranks, tokens_plain: tokens, tokens_redacted: tokens };
        let mut fits = |_: &Card, amount: u64, l: Limits, _: u64| l.month_micro > 0 && l.day_micro > 0 && amount <= l.month_micro && amount <= l.day_micro;
        let plan = ask::plan(&pairs, &req, &usable, &|c: &Card| loads.get(&c.card_id).copied().unwrap_or(DOWN), &mut fits)?;
        Ok(json!({
            "tier": plan.card.tier, "card_id": plan.card.card_id, "model": plan.card.model,
            "precision": plan.card.raw.get("precision").cloned().unwrap_or_else(|| json!({})), "expected_ms": plan.expected_ms,
        }))
    }

    // ── admin ──

    pub fn cards_json(&self) -> Value {
        let now = s_now();
        let (all, refused) = self.cards.all();
        let mut list: Vec<Value> = all
            .iter()
            .map(|c| {
                let st = self.cards.state(&c.card_id);
                json!({"card": Value::Object(c.raw.clone()), "status": cards::status(c, &st, now), "bench": st.bench.unwrap_or(Value::Null)})
            })
            .collect();
        list.extend(refused.into_iter().map(|(id, why)| json!({"card_id": id, "status": "refused", "error": why})));
        json!({"cards": list})
    }

    pub fn usage(&self, since: i64) -> Value {
        let now = now_ms();
        let lines = self.audit.since(since);
        let mut refusals = Map::new();
        let mut rids = Vec::new();
        for l in &lines {
            if l["outcome"] == "answered" {
                rids.push(l["rid"].clone());
            } else {
                let code = l["code"].as_str().filter(|c| !c.is_empty()).unwrap_or("failed").to_string();
                let n = refusals.get(&code).and_then(Value::as_u64).unwrap_or(0);
                refusals.insert(code, json!(n + 1));
            }
        }
        let (spent, held) = self.budgets.month_spend(now);
        let pair = self.pins.current();
        let limits = pair.as_ref().map(|p| Limits::of(p.ai.usd_month, p.ai.usd_user_day, p.map.gateways.len())).unwrap_or(Limits { month_micro: 0, day_micro: 0 });
        let live = self.live.lock().clone();
        let (all, _) = self.cards.all();
        let card_list: Vec<Value> = all.iter().map(|c| json!({"card_id": c.card_id, "status": cards::status(c, &self.cards.state(&c.card_id), now / 1000), "healthy": live.get(&c.card_id).map_or(true, |l| l.down_until_ms <= now)})).collect();
        json!({
            "since": since, "requests": lines.len(), "refusals": refusals,
            "spend": {"month_usd_micro": spent, "held_usd_micro": held, "month_limit_usd_micro": limits.month_micro, "day_limit_usd_micro": limits.day_micro, "gateways": pair.map(|p| p.map.gateways.len()).unwrap_or(0)},
            "cards": card_list, "rids": rids,
        })
    }

    fn bench_state(&self, id: &str) -> Value {
        self.benches.lock().get(id).cloned().unwrap_or_else(|| json!({"card_id": id, "state": "none"}))
    }
}

/// Run a card's benchmark and write its result (the console's bench and the weekly re-measure).
pub async fn run_bench(gw: Arc<Gateway>, id: String, files: Vec<PathBuf>) -> Result<Value, String> {
    let card = gw.cards.get(&id)?;
    let now = s_now();
    let result = bench::run(&gw.backends, &card, &gw.cred(&id), &files, now).await;
    bench::apply(&gw.cards, &card, &result, now)?;
    log_info(&format!("ai_bench card={id} pass={}", result["pass"]));
    Ok(result)
}

/// The admin's approval (3.2): only after a passing benchmark with every required figure tested. `retire_after` is
/// kept when it is at most 12 months away, else set to 365 days from now.
pub fn approve(store: &CardStore, id: &str, by: &str, for_classes: &[String], retention_override: &str, now: i64) -> Result<Card, Refusal> {
    let conflict = |m: &str| Refusal::new(409, "conflict", m);
    let card = store.get(id).map_err(|e| Refusal::new(404, "bad_request", &e))?;
    let mut st = store.state(id);
    if !bench::passed(&st) {
        return Err(conflict("a card is approved only after its benchmark passes"));
    }
    let gap = card.approval_gap();
    if !gap.is_empty() {
        return Err(conflict(gap));
    }
    if !by.contains('@') || for_classes.is_empty() {
        return Err(Refusal::new(400, "bad_request", "an approval names who approved and the classes the card may carry"));
    }
    let mut raw = Value::Object(card.raw.clone());
    let mut approval = json!({"status": "approved", "by": by, "at": crate::meet_json::iso_date(now), "for_classes": for_classes});
    if !retention_override.trim().is_empty() {
        approval["retention_override"] = json!(retention_override.trim());
    }
    raw["approval"] = approval;
    if card.retire_after > now + 365 * 86_400 {
        raw["retire_after"] = json!(crate::meet_json::iso_date(now + 365 * 86_400));
    }
    let card = store.put(&raw).map_err(|e| Refusal::new(400, "bad_request", &e))?;
    st.quarantined = false;
    store.set_state(id, &st).map_err(|_| Refusal::failed())?;
    log_info(&format!("ai_card_approved card={id} by={by}"));
    Ok(card)
}

fn query_get(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| {
            let b = v.as_bytes();
            let mut out = Vec::with_capacity(b.len());
            let mut i = 0;
            while i < b.len() {
                match b[i] {
                    b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                        Some(x) => {
                            out.push(x);
                            i += 3;
                            continue;
                        }
                        None => out.push(b'%'),
                    },
                    b'+' => out.push(b' '),
                    c => out.push(c),
                }
                i += 1;
            }
            String::from_utf8_lossy(&out).into_owned()
        })
    })
}

async fn admin(gw: &Arc<Gateway>, method: &str, path: &str, query: &str, body: &[u8]) -> (u16, Value) {
    let input: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(body).unwrap_or(Value::Null) };
    let not_found = (404, json!({"error": "not found"}));
    match (method, path) {
        ("GET", "/v1/ai/admin/cards") => (200, gw.cards_json()),
        ("GET", "/v1/ai/admin/usage") => (200, gw.usage(query_get(query, "since").and_then(|s| s.parse().ok()).unwrap_or(0))),
        ("GET", "/v1/ai/admin/bench") => (200, gw.bench_state(&query_get(query, "card_id").unwrap_or_default())),
        ("POST", "/v1/ai/admin/bench") => {
            let id = input["card_id"].as_str().unwrap_or_default().to_string();
            if gw.cards.get(&id).is_err() {
                return not_found;
            }
            let files: Vec<PathBuf> = input["files"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect()).unwrap_or_default();
            {
                let mut b = gw.benches.lock();
                if b.get(&id).is_some_and(|s| s["state"] == "running") {
                    return (409, Refusal::new(409, "conflict", "that card's benchmark is already running").body());
                }
                b.insert(id.clone(), json!({"card_id": id, "state": "running"}));
            }
            let g = gw.clone();
            let task_id = id.clone();
            tokio::spawn(async move {
                let state = match run_bench(g.clone(), task_id.clone(), files).await {
                    Ok(r) => json!({"card_id": task_id, "state": "done", "result": r}),
                    Err(e) => json!({"card_id": task_id, "state": "failed", "error": e}),
                };
                g.benches.lock().insert(task_id, state);
            });
            (202, json!({"card_id": id, "state": "running"}))
        }
        ("POST", "/v1/ai/admin/approve") => {
            let classes: Vec<String> = input["for_classes"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            match approve(&gw.cards, input["card_id"].as_str().unwrap_or_default(), input["by"].as_str().unwrap_or_default(), &classes, input["retention_override"].as_str().unwrap_or_default(), s_now()) {
                Ok(c) => (200, json!({"card": Value::Object(c.raw)})),
                Err(e) => (e.status, e.body()),
            }
        }
        _ => not_found,
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The person behind a device certificate (6.1): kind person, a device of its own, never a seed, guest, connector
/// or the console's pinned certificate.
fn person(peer: Option<&[u8]>, admin_spki: &[String]) -> Result<Identity, Refusal> {
    let refuse = || Refusal::new(403, "who", NOT_PERSON);
    let der = peer.ok_or_else(refuse)?;
    if Cert::from_der(der).is_some_and(|c| admin_spki.contains(&sha256_hex(&c.spki))) {
        return Err(refuse());
    }
    let who = crate::meet::identity_from_cert(Some(der)).map_err(|_| refuse())?;
    if who.kind != "person" || who.seed || who.guest || who.connector || !who.own_device() {
        return Err(refuse());
    }
    Ok(who)
}

async fn route(gw: &Arc<Gateway>, peer: Option<&[u8]>, method: &str, path: &str, query: &str, body: &[u8]) -> (u16, Value) {
    match (method, path) {
        ("POST", "/v1/ai/ask") | ("POST", "/v1/ai/estimate") => {
            let who = match person(peer, &gw.cfg.admin_spki) {
                Ok(w) => w,
                Err(r) => return (r.status, r.body()),
            };
            if path == "/v1/ai/ask" {
                gw.ask(&who, body).await
            } else {
                gw.estimate(&who, body).await
            }
        }
        (_, p) if p.starts_with("/v1/ai/admin/") => {
            if !peer.is_some_and(|d| admin_pinned(d, &gw.cfg.admin_spki, s_now())) {
                return (403, Refusal::new(403, "policy", ADMIN_ONLY).body());
            }
            admin(gw, method, path, query, body).await
        }
        _ => (404, json!({"error": "not found"})),
    }
}

fn reply(status: u16, v: &Value) -> Response<Full<Bytes>> {
    // canonical JSON (6.1); an admin answer with a null in it is plain JSON
    let mut body = crate::meet_org_policy::canonical_json(v).unwrap_or_else(|_| v.to_string().into_bytes());
    let mut status = status;
    if body.len() > ask::BODY_OUT_MAX {
        status = 500;
        body = crate::meet_org_policy::canonical_json(&Refusal::failed().body()).unwrap_or_default();
    }
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

async fn handle(gw: Arc<Gateway>, peer: Option<Vec<u8>>, req: hyper::Request<Incoming>) -> Response<Full<Bytes>> {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or_default().to_string();
    let body = match Limited::new(req.into_body(), ask::BODY_IN_MAX).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return reply(400, &Refusal::new(400, "bad_request", "the body is larger than 256 KiB").body()),
    };
    let (status, v) = route(&gw, peer.as_deref(), &method, &path, &query, &body).await;
    reply(status, &v)
}

/// Serve the gateway on `listener` until the process stops.
pub async fn serve(gw: Arc<Gateway>, listener: TcpListener, acceptor: TlsAcceptor) {
    loop {
        let (tcp, _) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let (gw, acceptor) = (gw.clone(), acceptor.clone());
        tokio::spawn(async move {
            let Some(tls) = crate::server::tls_within(&acceptor, tcp, Duration::from_secs(10)).await else { return };
            let peer: Option<Vec<u8>> = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
            let svc = service_fn(move |req| {
                let (gw, peer) = (gw.clone(), peer.clone());
                async move { Ok::<_, Infallible>(handle(gw, peer, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(tls), svc).await;
        });
    }
}

// ── background work ──────────────────────────────────────────────────────────────────────────────────────────

/// The relay link (a thread of its own; its calls block): the CRLs every hour, and the policy and map on every new
/// session, every `org_policy` or `org_ai` event, and at least every 5 minutes (6.2).
fn relay_loop(gw: Arc<Gateway>) {
    let (mut last_policy, mut last_crl) = (0i64, 0i64);
    loop {
        let now = now_ms();
        if now - last_crl >= CRL_EVERY_MS {
            match gw.relay.crl() {
                Ok(d) => {
                    gw.set_crls(Some(d));
                    last_crl = now;
                }
                Err(e) => {
                    log_warn(&format!("ai_crl_refresh_failed error={e}"));
                    gw.set_crls(None);
                    last_crl = now - CRL_EVERY_MS + 60_000;
                }
            }
        }
        let due = match gw.relay.changed() {
            Ok(changed) => changed || now_ms() - last_policy >= POLICY_EVERY_MS,
            Err(e) => {
                log_warn(&format!("ai_relay_session error={e}"));
                std::thread::sleep(Duration::from_secs(10));
                now_ms() - last_policy >= POLICY_EVERY_MS
            }
        };
        if due {
            match gw.relay.wires(&gw.cfg.org).and_then(|w| gw.refresh_policy(&w)) {
                Ok(_) => last_policy = now_ms(),
                Err(e) => {
                    log_warn(&format!("ai_policy_refresh_failed error={e}"));
                    last_policy = now_ms() - POLICY_EVERY_MS + 30_000;
                }
            }
        }
    }
}

/// Hourly: prune the audit log; re-measure org cards after a start and every 7 days (3.2); write the weekly rolling
/// median of a frontier card's real decode rate.
async fn maintenance(gw: Arc<Gateway>) {
    let mut measured: HashSet<String> = HashSet::new();
    let mut medians: HashMap<String, i64> = HashMap::new();
    loop {
        let now = s_now();
        gw.audit.prune(now_ms());
        let (all, _) = gw.cards.all();
        for card in all.iter().filter(|c| c.approval_status == "approved") {
            let st = gw.cards.state(&card.card_id);
            if card.org() {
                let last = st.bench.as_ref().and_then(|b| b["at"].as_i64()).unwrap_or(0);
                let first = gw.cfg.bench_on_start && !measured.contains(&card.card_id);
                if first || now - last >= BENCH_EVERY_S {
                    measured.insert(card.card_id.clone());
                    if let Err(e) = run_bench(gw.clone(), card.card_id.clone(), Vec::new()).await {
                        log_warn(&format!("ai_bench_failed card={} error={e}", card.card_id));
                    }
                }
            } else if now - medians.get(&card.card_id).copied().unwrap_or(now) >= BENCH_EVERY_S {
                let mut samples = gw.live.lock().get(&card.card_id).map(|l| l.decode_samples.clone()).unwrap_or_default();
                if samples.len() >= 5 {
                    samples.sort_unstable();
                    let median = samples[samples.len() / 2];
                    let mut raw = Value::Object(card.raw.clone());
                    let mut value = card.throughput.value.clone();
                    value["decode_tps"] = json!(median);
                    raw["throughput"] = crate::ai_gateway_cards::Evidence::tested(value, samples.len() as u64, now).to_value();
                    if let Err(e) = gw.cards.put(&raw) {
                        log_warn(&format!("ai_card_update_failed card={} error={e}", card.card_id));
                    }
                }
                medians.insert(card.card_id.clone(), now);
            } else {
                medians.entry(card.card_id.clone()).or_insert(now);
            }
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

const USAGE: &str = "usage: lucid-relay ai [serve | card-add <file> | cards | bench <card_id> [--files a,b] | approve <card_id> --by <email> --for-classes a,b [--retention-override <reason>] | usage [--since <unix s>] | audit-verify] --config <ai-gateway.json>";

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}

/// Positional arguments and `--name value` / `--name=value` flags.
fn split_args(args: &[String]) -> (Vec<String>, HashMap<String, String>) {
    let (mut pos, mut flags) = (Vec::new(), HashMap::new());
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(name) = a.strip_prefix("--") {
            match name.split_once('=') {
                Some((k, v)) => {
                    flags.insert(k.to_string(), v.to_string());
                }
                None => {
                    flags.insert(name.to_string(), args.get(i + 1).cloned().unwrap_or_default());
                    i += 1;
                }
            }
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    (pos, flags)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| die(&format!("cannot start: {e}")))
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

/// `lucid-relay ai ...`.
pub fn main(args: &[String]) -> ! {
    let (pos, flags) = split_args(args);
    let cmd = pos.first().map(String::as_str).unwrap_or("serve");
    let config = flags.get("config").cloned().or_else(|| std::env::var("LUCID_AI_CONFIG").ok()).filter(|c| !c.is_empty()).unwrap_or_else(|| die(USAGE));
    let cfg = Config::load(Path::new(&config)).unwrap_or_else(|e| die(&e));
    match cmd {
        "serve" => serve_cli(cfg),
        "card-add" => {
            let file = pos.get(1).unwrap_or_else(|| die(USAGE));
            let v: Value = std::fs::read(file).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_else(|| die(&format!("{file} is not a JSON card")));
            let card = CardStore::new(&cfg.state_dir).put(&v).unwrap_or_else(|e| die(&format!("the card is refused: {e}")));
            println!("card {} kept ({}); run `lucid-relay ai bench {}` before approving it", card.card_id, card.tier, card.card_id);
        }
        "cards" | "usage" | "bench" | "approve" | "audit-verify" => {
            let rt = runtime();
            rt.block_on(async {
                let gw = Arc::new(Gateway::new(cfg, Arc::new(Offline)).unwrap_or_else(|e| die(&e)));
                match cmd {
                    "cards" => print(&gw.cards_json()),
                    "usage" => print(&gw.usage(flags.get("since").and_then(|s| s.parse().ok()).unwrap_or(0))),
                    "audit-verify" => {
                        let problems = gw.audit.verify();
                        if !problems.is_empty() {
                            die(&problems.join("\n"));
                        }
                        println!("the audit log's chain is whole");
                    }
                    "bench" => {
                        let id = pos.get(1).cloned().unwrap_or_else(|| die(USAGE));
                        let files: Vec<PathBuf> = flags.get("files").map(|f| f.split(',').filter(|x| !x.is_empty()).map(PathBuf::from).collect()).unwrap_or_default();
                        let r = run_bench(gw, id, files).await.unwrap_or_else(|e| die(&e));
                        print(&r);
                        if r["pass"] != true {
                            std::process::exit(1);
                        }
                    }
                    _ => {
                        let id = pos.get(1).cloned().unwrap_or_else(|| die(USAGE));
                        let classes: Vec<String> = flags.get("for-classes").map(|c| c.split(',').filter(|x| !x.is_empty()).map(str::to_string).collect()).unwrap_or_default();
                        let by = flags.get("by").cloned().unwrap_or_default();
                        let override_reason = flags.get("retention-override").cloned().unwrap_or_default();
                        match approve(&gw.cards, &id, &by, &classes, &override_reason, s_now()) {
                            Ok(c) => println!("card {} approved for {}", c.card_id, c.for_classes.join(", ")),
                            Err(e) => die(&e.error),
                        }
                    }
                }
            });
        }
        _ => die(USAGE),
    }
    std::process::exit(0)
}

/// The commands that run with the gateway stopped never reach the relay.
struct Offline;

impl RelayApi for Offline {
    fn allowed(&self, _: &str) -> Result<bool, String> {
        Err("offline".into())
    }
    fn wires(&self, _: &str) -> Result<Value, String> {
        Err("offline".into())
    }
    fn crl(&self) -> Result<Vec<u8>, String> {
        Err("offline".into())
    }
    fn changed(&self) -> Result<bool, String> {
        Err("offline".into())
    }
}

fn serve_cli(cfg: Config) -> ! {
    let rt = runtime();
    rt.block_on(async {
        let relay: Arc<dyn RelayApi> = Arc::new(RelayLink::new(&cfg).unwrap_or_else(|e| die(&e)));
        let (host, port) = (cfg.host.clone(), cfg.port);
        let gw = Arc::new(Gateway::new(cfg, relay).unwrap_or_else(|e| die(&e)));
        let acceptor = TlsAcceptor::from(gw.tls_config().unwrap_or_else(|e| die(&e)));
        let listener = TcpListener::bind((host.as_str(), port)).await.unwrap_or_else(|e| die(&format!("cannot listen on {host}:{port}: {e}")));
        let g = gw.clone();
        std::thread::spawn(move || relay_loop(g));
        tokio::spawn(maintenance(gw.clone()));
        log_info(&format!("ai_gateway listening={host}:{port} org={} principal={} device={}", gw.cfg.org, gw.me.0, gw.me.1));
        tokio::select! {
            _ = serve(gw, listener, acceptor) => {}
            _ = tokio::signal::ctrl_c() => log_info("ai_gateway stopping"),
        }
    });
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_cards::testcards::{frontier_card, org_card};
    use crate::ai_gateway_policy::testpairs;
    use crate::meet_tls::testpki::{dir, pem, Ca, Key};

    struct StubRelay;

    impl RelayApi for StubRelay {
        fn allowed(&self, principal: &str) -> Result<bool, String> {
            Ok(principal == "ann@acme.example")
        }
        fn wires(&self, _: &str) -> Result<Value, String> {
            Err("not in this test".into())
        }
        fn crl(&self) -> Result<Vec<u8>, String> {
            Err("not in this test".into())
        }
        fn changed(&self) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// The stub backend: an OpenAI-compatible runtime with vLLM metrics, and the Anthropic Messages API. It keeps
    /// what it was sent so the test can see what left the gateway.
    #[derive(Default)]
    struct Stub {
        seen: Mutex<Vec<(String, String)>>,
    }

    async fn stub_answer(stub: Arc<Stub>, req: hyper::Request<Incoming>) -> Response<Full<Bytes>> {
        let path = req.uri().path().to_string();
        let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        stub.seen.lock().push((path.clone(), String::from_utf8_lossy(&body).into_owned()));
        let text = match path.as_str() {
            "/metrics" => "vllm:num_requests_waiting{model_name=\"m\"} 0.0\nvllm:gpu_cache_usage_perc{model_name=\"m\"} 0.1\nvllm:cache_config_info{block_size=\"16\",num_gpu_blocks=\"100000\"} 1.0\n".to_string(),
            "/v1/chat/completions" => json!({"choices": [{"message": {"content": "The north lot [s1][s7]."}}], "usage": {"prompt_tokens": 120, "completion_tokens": 6}}).to_string(),
            "/v1/messages" => json!({"content": [{"type": "text", "text": "[P1] picked the north lot [s1]."}], "usage": {"input_tokens": 130, "output_tokens": 9}}).to_string(),
            _ => return Response::builder().status(404).body(Full::new(Bytes::new())).unwrap(),
        };
        Response::new(Full::new(Bytes::from(text)))
    }

    async fn stub_serve(listener: TcpListener, acceptor: TlsAcceptor, stub: Arc<Stub>) {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, stub) = (acceptor.clone(), stub.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else { return };
                let svc = service_fn(move |req| {
                    let stub = stub.clone();
                    async move { Ok::<_, Infallible>(stub_answer(stub, req).await) }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(tls), svc).await;
            });
        }
    }

    async fn post(cfg: Arc<rustls::ClientConfig>, port: u16, path: &'static str, body: Value) -> Result<(u16, Value), String> {
        tokio::task::spawn_blocking(move || {
            let raw = crate::meet_org_policy::canonical_json(&body).unwrap();
            let r = crate::meet_tls::https_request(&cfg, "localhost", port, 30.0, "POST", path, &[("Content-Type", "application/json".to_string())], Some(&raw), &|_| Ok(())).map_err(|e| format!("{e:?}"))?;
            Ok((r.status, serde_json::from_slice(&r.body).unwrap_or(Value::Null)))
        })
        .await
        .unwrap()
    }

    fn ask_body(rid: &str, tiers: &[&str], cid: &str) -> Value {
        json!({"v": 1, "rid": rid, "activity": "search", "policy": "01".repeat(32), "tiers": tiers,
               "question": "Where did Ann Lee say we park? CANARY-QUESTION-7731",
               "snippets": [{"id": "s1", "cid": cid, "mid": "ab".repeat(16), "from": "Ann Lee", "text": "We picked the north lot. CANARY-SNIPPET-5521"}]})
    }

    /// AI-1d smoke: `lucid-relay ai` over mutual TLS against a stub OpenAI-compatible backend (and a stub Anthropic
    /// API for the frontier path): an answer with citations kept to the ids sent, a replayed rid, an excluded
    /// snippet, an unknown policy hash, a revoked device, placeholders sent to the frontier card and restored, and an
    /// audit log with no content.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn smoke_against_a_stub_openai_compatible_backend() {
        let d = dir("ai-gateway-smoke");
        let w = |name: &str, data: &str| {
            let p = d.join(name);
            std::fs::write(&p, data).unwrap();
            p.to_string_lossy().into_owned()
        };
        let ca = Ca::new("Acme Org CA");
        let ca_file = w("ca.pem", &ca.pem());
        let now = s_now();
        let crl_file = w("crl.pem", &ca.crl_pem(now - 300, now + 86_400, &[&[0x12]], None));
        let gk = Key::new();
        let gw_cert = w("gw.pem", &pem("CERTIFICATE", &ca.leaf(&[0x10], "localhost", Some("ai@apps.acme.example"), &["urn:lucid-meet:app", "urn:lucid-meet:org:acme", "urn:lucid-meet:device:00112233445566ff"], &gk, false)));
        let gw_key = w("gw.key", &gk.key_pem());
        let dk = Key::new();
        let dev_cert = w("dev.pem", &pem("CERTIFICATE", &ca.leaf(&[0x11], "Ann Lee", Some("ann@acme.example"), &["urn:lucid-meet:device:0123456789abcdef"], &dk, true)));
        let dev_key = w("dev.key", &dk.key_pem());
        let rk = Key::new();
        let revoked_cert = w("revoked.pem", &pem("CERTIFICATE", &ca.leaf(&[0x12], "Ann Lee", Some("ann@acme.example"), &["urn:lucid-meet:device:0123456789abcdee"], &rk, true)));
        let revoked_key = w("revoked.key", &rk.key_pem());
        // the stub backend, its certificate from the same CA (backend_ca)
        let bk = Key::new();
        let stub = Arc::new(Stub::default());
        let stub_tls = crate::server::tls_acceptor(&pem("CERTIFICATE", &ca.leaf(&[0x20], "localhost", None, &[], &bk, false)), &bk.key_pem()).unwrap();
        let stub_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bport = stub_listener.local_addr().unwrap().port();
        tokio::spawn(stub_serve(stub_listener, stub_tls, stub.clone()));
        let state = d.join("state");
        let store = CardStore::new(&state);
        store.put(&org_card("llama", &format!("https://localhost:{bport}/v1"), &["public", "internal"])).unwrap();
        store.put(&frontier_card("claude", "anthropic", &format!("https://localhost:{bport}"), &["public", "internal"])).unwrap();
        let cfg = Config {
            state_dir: state.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            cert: gw_cert.clone(),
            key: gw_key.clone(),
            relay_cert: gw_cert,
            relay_key: gw_key,
            client_ca: ca_file.clone(),
            crl: crl_file,
            relay: "https://relay.acme.example".into(),
            relay_ca: ca_file.clone(),
            org: "acme".into(),
            backend_ca: ca_file.clone(),
            audit_days: KEEP_DAYS,
            ..Config::default()
        };
        let mut g = Gateway::new(cfg, Arc::new(StubRelay)).unwrap();
        assert_eq!(g.me, ("ai@apps.acme.example".to_string(), "00112233445566ff".to_string()));
        g.creds.insert("claude".into(), Credential { api_key: "test-key".into(), ..Credential::default() });
        let gw = Arc::new(g);
        let policy = testpairs::policy(1, &["org", "frontier"], "org", &["public", "internal"], &["internal"]);
        gw.pins.pin(testpairs::pair(&"01".repeat(32), policy, testpairs::map(1, &[], &["ch:hr"])), now_ms()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(gw.clone(), listener, TlsAcceptor::from(gw.tls_config().unwrap())));
        let client = crate::meet_tls::client_config(Some(ca_file.as_str()), Some((dev_cert.as_str(), dev_key.as_str()))).unwrap();

        // the org card answers; a cite of an id never sent is dropped
        let (status, v) = post(client.clone(), port, "/v1/ai/ask", ask_body(&"1".repeat(32), &["org"], "ch:open")).await.unwrap();
        assert_eq!(status, 200, "{v}");
        assert_eq!((v["answer"].as_str(), v["tier"].as_str(), v["card_id"].as_str()), (Some("The north lot [s1]."), Some("org"), Some("llama")));
        assert_eq!(v["cites"], json!(["s1"]));
        assert_eq!((v["policy"].as_str(), v["usage"]["tokens_in"].as_u64(), v["usage"]["usd_micro"].as_u64()), (Some("01".repeat(32).as_str()), Some(120), Some(0)));
        let org_call = stub.seen.lock().iter().find(|(p, _)| p == "/v1/chat/completions").cloned().unwrap();
        assert!(org_call.1.contains("Ann Lee") && org_call.1.contains("CANARY-SNIPPET-5521"), "org cards get the text as it is");

        // the same rid again
        let (status, v) = post(client.clone(), port, "/v1/ai/ask", ask_body(&"1".repeat(32), &["org"], "ch:open")).await.unwrap();
        assert_eq!((status, v["code"].as_str()), (409, Some("conflict")));
        // an excluded conversation
        let (status, v) = post(client.clone(), port, "/v1/ai/ask", ask_body(&"2".repeat(32), &["org"], "ch:hr")).await.unwrap();
        assert_eq!((status, v["code"].as_str()), (403, Some("policy")));
        // an unknown policy hash
        let mut other = ask_body(&"3".repeat(32), &["org"], "ch:open");
        other["policy"] = json!("02".repeat(32));
        let (status, v) = post(client.clone(), port, "/v1/ai/ask", other).await.unwrap();
        assert_eq!((status, v["code"].as_str()), (409, Some("unverified")));

        // the frontier card: placeholders leave, the answer gets the names back
        let (status, v) = post(client.clone(), port, "/v1/ai/ask", ask_body(&"4".repeat(32), &["frontier"], "ch:open")).await.unwrap();
        assert_eq!(status, 200, "{v}");
        assert_eq!(v["answer"].as_str(), Some("Ann Lee picked the north lot [s1]."));
        assert!(v["usage"]["usd_micro"].as_u64().unwrap() > 0);
        let frontier_call = stub.seen.lock().iter().find(|(p, _)| p == "/v1/messages").cloned().unwrap();
        assert!(frontier_call.1.contains("[P1]") && !frontier_call.1.contains("Ann Lee") && !frontier_call.1.contains("Lee"), "names never reach a frontier card for a redacted class");

        // the estimate takes no content
        let est = json!({"v": 1, "activity": "search", "tokens_in": 500, "class": "internal", "policy": "01".repeat(32), "tiers": ["org"]});
        let (status, v) = post(client.clone(), port, "/v1/ai/estimate", est).await.unwrap();
        assert_eq!((status, v["card_id"].as_str()), (200, Some("llama")));

        // a revoked device cannot connect at all
        let revoked = crate::meet_tls::client_config(Some(ca_file.as_str()), Some((revoked_cert.as_str(), revoked_key.as_str()))).unwrap();
        assert!(post(revoked, port, "/v1/ai/ask", ask_body(&"5".repeat(32), &["org"], "ch:open")).await.is_err());

        // the audit log holds one line per ask and no content
        let mut text = String::new();
        for e in std::fs::read_dir(state.join("audit")).unwrap() {
            text.push_str(&std::fs::read_to_string(e.unwrap().path()).unwrap());
        }
        assert_eq!(text.lines().count(), 5);
        assert!(!text.contains("CANARY") && !text.contains("north lot") && !text.contains("Ann Lee"));
        assert!(gw.audit.verify().is_empty());
        let usage = gw.usage(0);
        assert_eq!((usage["requests"].as_u64(), usage["refusals"]["conflict"].as_u64(), usage["rids"].as_array().map(Vec::len)), (Some(5), Some(1), Some(2)));
    }

    #[test]
    fn urls_and_queries_read() {
        assert_eq!(host_port("https://relay.acme.example:8443/x"), Some(("relay.acme.example".into(), 8443)));
        assert_eq!(host_port("https://relay.acme.example"), Some(("relay.acme.example".into(), 443)));
        assert_eq!(host_port("https://[::1]:9"), Some(("::1".into(), 9)));
        assert_eq!(query_get("card_id=a%2Db&since=5", "card_id").as_deref(), Some("a-b"));
        assert_eq!(query_get("since=5", "card_id"), None);
    }

    #[test]
    fn approval_needs_a_passing_benchmark() {
        let d = dir("ai-approve");
        let store = CardStore::new(&d);
        let mut v = org_card("llama", "https://h:1/v1", &[]);
        v["approval"] = json!({"status": "pending", "by": "", "at": "", "for_classes": []});
        store.put(&v).unwrap();
        let now = 1_795_000_000;
        let e = approve(&store, "llama", "admin@acme.example", &["internal".to_string()], "", now).unwrap_err();
        assert_eq!((e.status, e.code), (409, "conflict"));
        store.set_state("llama", &crate::ai_gateway_cards::CardState { bench: Some(json!({"pass": true})), quarantined: true, degraded: false }).unwrap();
        let c = approve(&store, "llama", "admin@acme.example", &["internal".to_string()], "", now).unwrap();
        assert_eq!((c.approval_status.as_str(), c.for_classes.clone()), ("approved", vec!["internal".to_string()]));
        assert!(!store.state("llama").quarantined, "a re-approval after a passing benchmark lifts the quarantine");
    }
}
