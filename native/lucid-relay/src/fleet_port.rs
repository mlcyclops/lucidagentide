// AC-2a 3.3 to 3.8, 3.11 and 5.5 (console side of F3, F17, F21): the management port. A TLS 1.3 listener restricted
// to the 3.7 suites, groups and schemes, whose client certificate is optional: without one only the enrollment
// calls and the public trust manifest answer; a verified relay certificate opens the WebSocket channel; an
// old-generation certificate matching an open recovery record gets a recovery-only connection that serves
// `POST /fleet/v1/recover-cert` and nothing else (A2-H2, idempotent from A3-M2). Anything else answers 404 (or 403)
// and closes, and nothing on the port tells an unverified caller whether a relay or serial exists (3.13).
//
// It runs the enrollment checks of 3.3 in order, one channel per relay (a second replaces the first, more than 10
// replacements an hour raise `relay-flapping`), renewal (3.4), the per-relay limits of 3.8, and the PKI's minute
// tick (fleet_ca.rs). The registry, the preview's content and every relay event's meaning are f-console's
// (`console_fleet::Fleet`, reached through the `Desk` seam below so the port is tested without a whole console).
//
// AC-2b-D 4 (d-port): the seven download paths under `/fleet/v1/install/` (the four install scripts behind their
// 10-line header, the program from a sealed in-memory copy of the running image, `SHA256SUMS`, `meta`), their limits
// and sources, `deploy-high` under High; and the relay's `meet-cert` request (9.3), answered by f-console.

use crate::codec::{b64u, hex, now_ms, parse_json, sha256, stringify};
use crate::console_source::Cidr;
use crate::fleet_ca::{vault_do, FleetCa, Health, Push, VaultLock};
use crate::fleet_wire::{self as w, Frame, In, LocalEnd, Refusal, Side, Wire};
use crate::fleet_x509 as x509;
use crate::log::{Fields, Level, Logger};
use bytes::Bytes;
use http_body_util::{BodyExt, Either, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{ACCEPT_RANGES, CACHE_CONTROL, CONNECTION, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HOST, RETRY_AFTER, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::{Mutex, RwLock};
use rustls::client::danger::HandshakeSignatureValid;
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{CipherSuite, DigitallySignedStruct, DistinguishedName, NamedGroup, ServerConfig, SignatureScheme};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role as WsRole;
use tokio_tungstenite::WebSocketStream;

// ── The 3.7 TLS profile (both sides) ────────────────────────────────────────────────────────────────────────

/// The signature schemes of 3.7.
pub const SCHEMES: [SignatureScheme; 2] = [SignatureScheme::ECDSA_NISTP256_SHA256, SignatureScheme::ECDSA_NISTP384_SHA384];

type Algs = &'static [&'static dyn rustls::pki_types::SignatureVerificationAlgorithm];

/// The provider's scheme mapping for the two schemes only.
static MAPPING: LazyLock<Vec<(SignatureScheme, Algs)>> = LazyLock::new(|| crate::server::provider().signature_verification_algorithms.mapping.iter().filter(|(s, _)| SCHEMES.contains(s)).copied().collect());

/// Every algorithm those two schemes use.
static ALL: LazyLock<Vec<&'static dyn rustls::pki_types::SignatureVerificationAlgorithm>> = LazyLock::new(|| MAPPING.iter().flat_map(|(_, a)| a.iter().copied()).collect());

/// The provider's verification algorithms for the two schemes only.
pub static ALGS: LazyLock<WebPkiSupportedAlgorithms> = LazyLock::new(|| WebPkiSupportedAlgorithms { all: ALL.as_slice(), mapping: MAPPING.as_slice() });

/// `server::provider()` (the FIPS provider in a `fips` build) restricted to 3.7: TLS 1.3 with AES-256-GCM-SHA384 and
/// AES-128-GCM-SHA256, groups secp384r1 and secp256r1, schemes ECDSA P-256 SHA-256 and P-384 SHA-384.
pub fn fleet_provider() -> CryptoProvider {
    let mut p = crate::server::provider();
    p.cipher_suites.retain(|s| matches!(s.suite(), CipherSuite::TLS13_AES_256_GCM_SHA384 | CipherSuite::TLS13_AES_128_GCM_SHA256));
    p.kx_groups.retain(|g| matches!(g.name(), NamedGroup::secp384r1 | NamedGroup::secp256r1));
    p.signature_verification_algorithms = *ALGS;
    p
}

pub fn verify_tls13(message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
    if !SCHEMES.contains(&dss.scheme) {
        return Err(rustls::Error::PeerIncompatible(rustls::PeerIncompatible::NoSignatureSchemesInCommon));
    }
    rustls::crypto::verify_tls13_signature(message, cert, dss, &ALGS)
}

// ── The seam to f-console ───────────────────────────────────────────────────────────────────────────────────

/// What the port needs of the fleet console (F7, F15). `FleetDesk` maps it onto `console_fleet::Fleet`.
pub trait Desk: Send + Sync {
    fn console_id(&self) -> String;
    fn state_ok(&self) -> bool;
    fn enroll_preview(&self, id: &str, host: &str, t: i64) -> Result<Value, Refusal>;
    fn enroll_secret(&self, id: &str) -> Option<Vec<u8>>;
    fn enroll_failed(&self, id: &str, t: i64);
    fn enroll_check(&self, id: &str, relay: &Value, t: i64) -> Result<(), Refusal>;
    fn draw_relay_id(&self, id: &str) -> String;
    /// `id` empty: the same-process enrollment of 2.2.
    fn enroll_done(&self, id: &str, done: Done, t: i64) -> Result<Value, Refusal>;
    fn serial_ok(&self, relay: &str, serial: &str) -> bool;
    fn renewed(&self, relay: &str, rec: Done, t: i64);
    fn renew_switched(&self, relay: &str, serial: &str, t: i64) -> Vec<String>;
    fn relay_recovered(&self, relay: &str, old_serial: &str, new_serial: &str, generation: u64, retry: bool, t: i64);
    fn on_hello(&self, relay: &str, body: &Value, source: &str, t: i64) -> Result<Value, Refusal>;
    /// After `welcome` went out (the relay takes no other frame first): the updates the relay lacks.
    fn on_welcomed(&self, relay: &str, t: i64);
    fn on_event(&self, relay: &str, op: &str, body: &Value, t: i64);
    fn on_closed(&self, relay: &str, t: i64);
    fn flapping(&self, relay: &str, t: i64);
    /// (serial, notAfter) of every relay certificate issued under `generation`.
    fn serials_of_generation(&self, generation: u64) -> Vec<(String, i64)>;
    /// An entry in the console's audit chain.
    fn audit(&self, actor: &str, action: &str, detail: Value, t: i64);
    /// The console's profile is High (AC-2b-D 4.5: every download route answers `deploy-high`).
    fn high(&self) -> bool;
    /// AC-2b-D 4.4: the enrollment `id` is `open`, or `used` within its hour (its program downloads are not counted).
    fn download_enrollment_ok(&self, id: &str, t: i64) -> bool;
    /// AC-2b-D 8.4 `meet-cert {csr, signerCsr}` from a connected relay: `{cert, signerCert}` or a refusal.
    fn meet_cert(&self, relay: &str, body: &Value, t: i64) -> Result<Value, Refusal>;
}

/// A certificate the port issued (enrollment, renewal, recovery).
#[derive(Clone, Debug)]
pub struct Done {
    pub relay_id: String,
    pub serial: String,
    pub spki: Vec<u8>,
    pub not_after: i64,
    pub generation: u64,
    pub relay: Value,
    pub source: String,
}

/// `Desk` over the fleet console (f-console's `Fleet`).
pub struct FleetDesk {
    pub console: Arc<crate::console::Console>,
    pub fleet: Arc<crate::console_fleet::Fleet>,
}

fn refusal(e: crate::console::ApiError) -> Refusal {
    Refusal::from(e)
}

fn serial_record(d: &Done, current: bool) -> crate::console_fleet::SerialRecord {
    crate::console_fleet::SerialRecord { serial: d.serial.clone(), spki_sha256: hex(&sha256(&d.spki)), spki: b64u(&d.spki), not_after: d.not_after, generation: d.generation as u32, current }
}

impl Desk for FleetDesk {
    fn console_id(&self) -> String {
        self.fleet.console_id()
    }
    fn state_ok(&self) -> bool {
        self.fleet.state_ok()
    }
    fn enroll_preview(&self, id: &str, host: &str, t: i64) -> Result<Value, Refusal> {
        self.fleet.enroll_preview(id, host, t).map_err(refusal)
    }
    fn enroll_secret(&self, id: &str) -> Option<Vec<u8>> {
        self.fleet.enroll_secret(id)
    }
    fn enroll_failed(&self, id: &str, t: i64) {
        self.fleet.enroll_failed(id, t)
    }
    fn enroll_check(&self, id: &str, relay: &Value, t: i64) -> Result<(), Refusal> {
        self.fleet.enroll_check(id, relay, t).map_err(refusal)
    }
    fn draw_relay_id(&self, id: &str) -> String {
        self.fleet.draw_relay_id(id)
    }
    fn enroll_done(&self, id: &str, d: Done, t: i64) -> Result<Value, Refusal> {
        let done = crate::console_fleet::EnrollDone { relay_id: Some(d.relay_id), serial: d.serial, spki: d.spki, not_after: d.not_after, generation: d.generation as u32, relay: d.relay, source: d.source };
        if id.is_empty() {
            self.fleet.enroll_same_process(done, t).map_err(refusal)
        } else {
            self.fleet.enroll_done(id, done, t).map_err(refusal)
        }
    }
    fn serial_ok(&self, relay: &str, serial: &str) -> bool {
        self.fleet.serial_ok(relay, serial)
    }
    fn renewed(&self, relay: &str, d: Done, t: i64) {
        self.fleet.renewed(relay, serial_record(&d, false), t)
    }
    fn renew_switched(&self, relay: &str, serial: &str, t: i64) -> Vec<String> {
        self.fleet.renew_switched(relay, serial, t)
    }
    fn relay_recovered(&self, relay: &str, old_serial: &str, new_serial: &str, generation: u64, retry: bool, t: i64) {
        self.fleet.relay_recovered(relay, old_serial, new_serial, generation as u32, retry, t)
    }
    fn on_hello(&self, relay: &str, body: &Value, source: &str, t: i64) -> Result<Value, Refusal> {
        self.fleet.on_hello(relay, body, source, t).map_err(refusal)
    }
    fn on_welcomed(&self, relay: &str, t: i64) {
        self.fleet.on_welcomed(relay, t)
    }
    fn on_event(&self, relay: &str, op: &str, body: &Value, t: i64) {
        self.fleet.on_event(relay, op, body, t)
    }
    fn on_closed(&self, relay: &str, t: i64) {
        self.fleet.on_closed(relay, t)
    }
    fn flapping(&self, relay: &str, t: i64) {
        self.fleet.flapping(relay, t)
    }
    fn serials_of_generation(&self, generation: u64) -> Vec<(String, i64)> {
        let reg = self.fleet.registry();
        reg.relays.values().flat_map(|r| r.serials.iter()).filter(|s| u64::from(s.generation) == generation).map(|s| (s.serial.clone(), s.not_after)).collect()
    }
    fn audit(&self, actor: &str, action: &str, detail: Value, t: i64) {
        let mut r = crate::console_audit::Record::new(actor, action, "ok");
        r.detail = detail;
        self.console.record(r, t);
    }
    fn high(&self) -> bool {
        self.console.high_profile()
    }
    fn download_enrollment_ok(&self, id: &str, t: i64) -> bool {
        self.fleet.download_enrollment_ok(id, t)
    }
    fn meet_cert(&self, relay: &str, body: &Value, t: i64) -> Result<Value, Refusal> {
        self.fleet.meet_cert(relay, body, t).map_err(refusal)
    }
}

// ── Settings and state ──────────────────────────────────────────────────────────────────────────────────────

/// The management port's settings (5.2).
#[derive(Clone, Debug)]
pub struct PortConfig {
    pub host: String,
    /// 0 keeps the port closed (no enrollment).
    pub port: u16,
    pub names: Vec<String>,
    pub sources: Vec<Cidr>,
    /// The console's `public` host (and port when not 443): the CA's `O`, the server leaf's first name.
    pub public_host: String,
    /// `--fleet-serve-dev` (AC-2b-D 4.2): a `dev-license` build serves its program only with it.
    pub serve_dev: bool,
}

impl PortConfig {
    fn hostname(&self) -> String {
        crate::server::dialed_of(&self.public_host, true).hostname
    }
    /// `fleetUrl` (3.3, 3.6); an IPv6 literal in brackets (AC-2b-D 3.5).
    pub fn fleet_url(&self) -> String {
        let h = self.hostname();
        if h.contains(':') && !h.starts_with('[') {
            format!("https://[{h}]:{}", self.port)
        } else {
            format!("https://{h}:{}", self.port)
        }
    }
}

/// Who is on a connection, from its client certificate.
#[derive(Clone, Debug, PartialEq)]
pub enum Peer {
    Anonymous,
    Relay { relay: String, serial: String, generation: u64, spki: Vec<u8> },
    Recovery { relay: String, serial: String },
    Refused,
}

enum Out {
    Text(String),
    Close(u16),
}

/// One open channel (console end).
pub struct Chan {
    conn: u64,
    relay: String,
    serial: String,
    out: mpsc::UnboundedSender<Out>,
    pending: Mutex<HashMap<u32, std::sync::mpsc::SyncSender<Result<Value, Refusal>>>>,
    next_id: AtomicU32,
    in_flight: AtomicUsize,
}

impl Chan {
    fn send(&self, text: String) -> bool {
        self.out.send(Out::Text(text)).is_ok()
    }
    fn close(&self, code: u16) {
        let _ = self.out.send(Out::Close(code));
    }
    fn take_id(&self) -> u32 {
        loop {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            if (1..=(1u32 << 31)).contains(&id) {
                return id;
            }
            self.next_id.store(1, Ordering::SeqCst);
        }
    }
}

/// Why a channel request did not get an answer (mapped to f-console's `LinkError`).
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    Offline,
    Timeout,
    Busy,
    Refused(Refusal),
}

pub struct PortState {
    desk: Arc<dyn Desk>,
    vault: Arc<dyn VaultLock>,
    pub ca: Mutex<FleetCa>,
    cfg: PortConfig,
    logger: Arc<Logger>,
    chans: Mutex<HashMap<String, Arc<Chan>>>,
    replaced: Mutex<HashMap<String, VecDeque<i64>>>,
    rate: Mutex<HashMap<String, VecDeque<i64>>>,
    unverified: Mutex<HashMap<IpAddr, usize>>,
    server_key: RwLock<Option<Arc<CertifiedKey>>>,
    /// Active CA pins each relay reported in its last `hello` (renewal under a generation it trusts).
    pins: Mutex<HashMap<String, Vec<u64>>>,
    /// Per relay: (last metrics ms, events this minute, minute start, dropped).
    limits: Mutex<HashMap<String, (i64, u32, i64, u64)>>,
    enroll_lock: Mutex<()>,
    conn_seq: std::sync::atomic::AtomicU64,
    /// AC-2b-D 4.2: the sealed copy of the running program, or why none is served.
    program: Mutex<Result<Arc<Program>, &'static str>>,
    /// AC-2b-D 4.4: script, `SHA256SUMS` and `meta` requests, and counted program downloads, per source.
    dl_small: Mutex<HashMap<String, VecDeque<i64>>>,
    dl_program: Mutex<HashMap<String, VecDeque<i64>>>,
    /// Program transfers running: per source, and in all.
    dl_active: Mutex<(HashMap<String, usize>, usize)>,
    /// The last `deploy.download` line per (source, file).
    dl_logged: Mutex<HashMap<(String, String), i64>>,
}

impl std::fmt::Debug for PortState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PortState")
    }
}

static PORT: OnceLock<Arc<PortState>> = OnceLock::new();

/// The process's management port state, once `start` ran (the same-process channel of 2.2 attaches to it).
pub fn global() -> Option<Arc<PortState>> {
    PORT.get().cloned()
}

fn ip_key(ip: IpAddr) -> String {
    match crate::console_source::canonical(ip) {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        v4 => v4.to_string(),
    }
}

fn host_of(req: &Request<Incoming>) -> String {
    req.headers().get(HOST).and_then(|h| h.to_str().ok()).map(|h| crate::server::dialed_of(h, true).hostname).unwrap_or_default()
}

/// The words for refused frames in the log.
fn frame_refused(logger: &Logger, relay: &str, why: &str) {
    logger.security("fleet.frame-refused", &Fields::new().with("relay", relay).with("why", why), Level::Warn);
}

impl PortState {
    pub fn new(desk: Arc<dyn Desk>, vault: Arc<dyn VaultLock>, ca: FleetCa, cfg: PortConfig, logger: Arc<Logger>) -> Arc<PortState> {
        let s = Arc::new(PortState {
            desk,
            vault,
            ca: Mutex::new(ca),
            cfg,
            logger,
            chans: Mutex::new(HashMap::new()),
            replaced: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            unverified: Mutex::new(HashMap::new()),
            server_key: RwLock::new(None),
            pins: Mutex::new(HashMap::new()),
            limits: Mutex::new(HashMap::new()),
            enroll_lock: Mutex::new(()),
            conn_seq: std::sync::atomic::AtomicU64::new(1),
            program: Mutex::new(Err("not-started")),
            dl_small: Mutex::new(HashMap::new()),
            dl_program: Mutex::new(HashMap::new()),
            dl_active: Mutex::new((HashMap::new(), 0)),
            dl_logged: Mutex::new(HashMap::new()),
        });
        s.reload_server_key();
        s
    }

    fn health(&self) -> Health {
        self.ca.lock().health
    }

    /// Whether the port may serve (3.12, invariant 20).
    pub fn open(&self) -> bool {
        self.health() == Health::Ready && self.desk.state_ok()
    }

    pub(crate) fn reload_server_key(&self) {
        let ca = self.ca.lock();
        let id = vault_do(&*self.vault, |v| ca.server_identity(v));
        drop(ca);
        let key = id.and_then(|(chain, pkcs8)| {
            let sk = fleet_provider().key_provider.load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8))).ok()?;
            Some(Arc::new(CertifiedKey::new(chain.into_iter().map(CertificateDer::from).collect(), sk)))
        });
        *self.server_key.write() = key;
    }

    /// Classify a presented client certificate (the verifier and, after the handshake, the connection).
    pub fn classify(&self, der: &[u8], t: i64) -> Peer {
        let (normal, recovery) = {
            let ca = self.ca.lock();
            let normal = ca.accepted().find_map(|g| x509::relay_leaf(der, &g.cert, t).ok().map(|(id, serial, c)| (id, serial, g.generation, c.spki)));
            let normal = normal.filter(|(_, s, _, _)| !ca.denied.contains(s));
            let recovery = ca.recovery_only().find_map(|g| x509::relay_leaf(der, &g.cert, t).ok()).filter(|(id, serial, c)| ca.recovery_candidate(id, serial, &c.spki, t)).map(|(id, serial, _)| (id, serial));
            (normal, recovery)
        };
        // The registry is f-console's: asked with the PKI lock released.
        if let Some((relay, serial, generation, spki)) = normal {
            if self.desk.serial_ok(&relay, &serial) {
                return Peer::Relay { relay, serial, generation, spki };
            }
        }
        match recovery {
            Some((relay, serial)) => Peer::Recovery { relay, serial },
            None => Peer::Refused,
        }
    }

    fn rate_ok(&self, ip: IpAddr, t: i64) -> bool {
        let mut r = self.rate.lock();
        let q = r.entry(ip_key(ip)).or_default();
        while q.front().is_some_and(|x| t - x >= w::ENROLL_WINDOW_MS) {
            q.pop_front();
        }
        if q.len() >= w::ENROLL_CALLS {
            return false;
        }
        q.push_back(t);
        true
    }

    // ── Enrollment (3.3) ──

    /// `POST /fleet/v1/enroll/preview {v, id, mac}`: consumes nothing; a wrong proof counts toward the id's 5.
    pub fn preview(&self, body: &Value, host: &str, t: i64) -> Result<Value, Refusal> {
        let o = body.as_object().filter(|o| crate::codec::exact_keys(o, &["v", "id", "mac"], &["v", "id", "mac"]) && o["v"] == json!(1)).ok_or_else(|| Refusal::of("fleet-code"))?;
        let id = o["id"].as_str().filter(|i| w::is_enrollment_id(i)).ok_or_else(|| Refusal::of("fleet-code"))?;
        let mac = w::b64u_of(o.get("mac")).ok_or_else(|| Refusal::of("fleet-code"))?;
        let secret = w::Redacted::new(self.desk.enroll_secret(id).ok_or_else(|| Refusal::of("fleet-code-expired"))?);
        if !w::same_bytes(w::preview_mac(secret.expose(), id, host).expose(), &mac) {
            self.desk.enroll_failed(id, t);
            return Err(Refusal::of("fleet-code"));
        }
        let mut answer = self.desk.enroll_preview(id, host, t)?;
        let hash = w::preview_hash(&answer).map_err(|_| Refusal::of("fleet-op"))?;
        let o = answer.as_object_mut().ok_or_else(|| Refusal::of("fleet-op"))?;
        let mut out = serde_json::Map::new();
        out.insert("ok".into(), json!(true));
        out.insert("previewHash".into(), json!(hex(hash.expose())));
        out.append(o);
        Ok(Value::Object(out))
    }

    /// `POST /fleet/v1/enroll {v, id, spki, previewHash, relay, mac, sig}`: the 3.3 order (open, product, preview
    /// unchanged, MAC, signature, profile and count), then the certificate and the record.
    pub fn enroll(&self, body: &Value, host: &str, source: &str, t: i64) -> Result<Value, Refusal> {
        const KEYS: [&str; 7] = ["v", "id", "spki", "previewHash", "relay", "mac", "sig"];
        let o = body.as_object().filter(|o| crate::codec::exact_keys(o, &KEYS, &KEYS) && o["v"] == json!(1)).ok_or_else(|| Refusal::of("fleet-code"))?;
        let id = o["id"].as_str().filter(|i| w::is_enrollment_id(i)).ok_or_else(|| Refusal::of("fleet-code"))?;
        let _serial = self.enroll_lock.lock();
        let secret = w::Redacted::new(self.desk.enroll_secret(id).ok_or_else(|| Refusal::of("fleet-code-expired"))?);
        let preview = self.desk.enroll_preview(id, host, t)?;
        let relay = o["relay"].clone();
        let code_product = preview["enrollment"]["product"].as_str().unwrap_or_default();
        let relay_product = relay.get("product").and_then(Value::as_str).unwrap_or_default();
        if code_product != relay_product {
            let name = w::product_of(code_product).map(|p| p.name()).unwrap_or(code_product);
            return Err(Refusal::filled("fleet-product", &[("product", name)]));
        }
        let hash = w::preview_hash(&preview).map_err(|_| Refusal::of("fleet-op"))?;
        let sent = w::hash_of(o.get("previewHash")).ok_or_else(|| Refusal::of("fleet-preview-changed"))?;
        if !w::same_bytes(hash.expose(), &sent) {
            return Err(Refusal::of("fleet-preview-changed"));
        }
        let wrong = || {
            self.desk.enroll_failed(id, t);
            Refusal::of("fleet-code")
        };
        let spki = w::b64u_of(o.get("spki")).filter(|s| x509::is_p256_spki(s)).ok_or_else(wrong)?;
        let input = w::enroll_input(id, hash.expose(), &spki, &relay).map_err(|_| wrong())?;
        let mac = w::b64u_of(o.get("mac")).ok_or_else(wrong)?;
        if !w::same_bytes(w::enroll_mac(secret.expose(), &input).expose(), &mac) {
            return Err(wrong());
        }
        let sig = w::b64u_of(o.get("sig")).ok_or_else(wrong)?;
        if !x509::verify_p256(&spki, &input, &sig) {
            return Err(wrong());
        }
        self.desk.enroll_check(id, &relay, t)?;
        let relay_id = self.desk.draw_relay_id(id);
        self.finish_enroll(id, relay_id, spki, relay, source, self.cfg.fleet_url(), t)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_enroll(&self, id: &str, relay_id: String, spki: Vec<u8>, relay: Value, source: &str, fleet_url: String, t: i64) -> Result<Value, Refusal> {
        let (cert, serial, not_after, generation, ca_cert, manifest) = {
            let ca = self.ca.lock();
            if ca.health != Health::Ready {
                return Err(Refusal::new(503, "seal-provider-needed", "The console cannot enroll relays until its sealing is set up."));
            }
            let g = ca.issuing;
            let (cert, serial, na) = vault_do(&*self.vault, |v| ca.issue_relay(v, &relay_id, &spki, g, t)).map_err(|_| Refusal::of("fleet-op"))?;
            (cert, serial, na, g, ca.issuing_cert().map(|c| c.cert.clone()).unwrap_or_default(), ca.manifest.clone())
        };
        let done = Done { relay_id, serial, spki, not_after, generation, relay, source: source.to_owned() };
        let mut answer = self.desk.enroll_done(id, done, t)?;
        let o = answer.as_object_mut().ok_or_else(|| Refusal::of("fleet-op"))?;
        o.insert("cert".into(), json!(b64u(&cert)));
        o.insert("caCert".into(), json!(b64u(&ca_cert)));
        o.insert("trust".into(), manifest);
        o.insert("fleetUrl".into(), json!(fleet_url));
        let mut out = serde_json::Map::new();
        out.insert("ok".into(), json!(true));
        out.append(o);
        Ok(Value::Object(out))
    }

    /// The same-process enrollment of 2.2 (no code, Standard only): the relay's own key's SPKI, its `relay`
    /// object; the answer is the 3.3 apply answer with `fleetUrl: "same-process"`.
    pub fn enroll_same_process(&self, spki: &[u8], relay: &Value, t: i64) -> Result<Value, Refusal> {
        if !x509::is_p256_spki(spki) {
            return Err(Refusal::of("fleet-op"));
        }
        let relay_id = self.desk.draw_relay_id("");
        self.finish_enroll("", relay_id, spki.to_vec(), relay.clone(), "same-process", "same-process".into(), t)
    }

    /// `GET /fleet/v1/trust`: the current signed manifest.
    pub fn trust(&self) -> Value {
        self.ca.lock().manifest.clone()
    }

    /// `POST /fleet/v1/recover-cert` on a recovery-only connection (3.11, A3-M2).
    pub fn recover(&self, presented: &[u8], body: &Value, t: i64) -> Result<Value, Refusal> {
        let result = {
            let mut ca = self.ca.lock();
            vault_do(&*self.vault, |v| ca.recover(v, presented, body, t))
        };
        match result {
            Ok((answer, retry, detail)) => {
                let relay = body["relayId"].as_str().unwrap_or_default();
                let old = detail["oldSerial"].as_str().unwrap_or_default();
                let new = detail["newSerial"].as_str().unwrap_or_default();
                let generation = detail["generation"].as_u64().unwrap_or(0);
                if !retry {
                    if let (Some(cert), Some(spki)) = (w::b64u_of(answer.get("cert")), w::b64u_of(body.get("spkiNew"))) {
                        let na = crate::meet_x509::Cert::from_der(&cert).map(|c| c.not_after * 1000).unwrap_or(0);
                        self.desk.renewed(relay, Done { relay_id: relay.to_owned(), serial: new.to_owned(), spki, not_after: na, generation, relay: Value::Null, source: String::new() }, t);
                    }
                }
                self.desk.relay_recovered(relay, old, new, generation, retry, t);
                Ok(answer)
            }
            Err((r, why)) => {
                self.logger.security("fleet.recovery-refused", &Fields::new().with("why", why), Level::Warn);
                Err(r)
            }
        }
    }

    // ── Renewal (3.4) ──

    fn renew(&self, peer: &Peer, body: &serde_json::Map<String, Value>, t: i64) -> Result<Value, Refusal> {
        let Peer::Relay { relay, serial, spki: old_spki, .. } = peer else { return Err(Refusal::of("fleet-op")) };
        let spki = w::b64u_of(body.get("spki")).filter(|s| x509::is_p256_spki(s)).ok_or_else(|| Refusal::of("fleet-op"))?;
        let input = w::renew_input(relay, serial, &spki).ok_or_else(|| Refusal::of("fleet-op"))?;
        let ok_old = w::b64u_of(body.get("sigOld")).is_some_and(|s| x509::verify_p256(old_spki, &input, &s));
        let ok_new = w::b64u_of(body.get("sigNew")).is_some_and(|s| x509::verify_p256(&spki, &input, &s));
        if !ok_old || !ok_new {
            return Err(Refusal::of("fleet-op"));
        }
        let trusted = self.pins.lock().get(relay).cloned().unwrap_or_default();
        let (cert, new_serial, na, generation) = {
            let ca = self.ca.lock();
            // Under the incoming generation when the relay already trusts it (3.11), else the issuing one.
            let g = ca.incoming().filter(|g| trusted.contains(g)).unwrap_or(ca.issuing);
            let (c, s, na) = vault_do(&*self.vault, |v| ca.issue_relay(v, relay, &spki, g, t)).map_err(|_| Refusal::of("fleet-op"))?;
            (c, s, na, g)
        };
        self.desk.renewed(relay, Done { relay_id: relay.clone(), serial: new_serial, spki, not_after: na, generation, relay: Value::Null, source: String::new() }, t);
        Ok(json!({ "cert": b64u(&cert) }))
    }

    // ── Channels ──

    fn register(&self, chan: Arc<Chan>, t: i64) {
        let old = self.chans.lock().insert(chan.relay.clone(), chan.clone());
        if let Some(old) = old {
            old.close(w::CLOSE_REPLACED);
            self.logger.security("fleet.replaced", &Fields::new().with("relay", chan.relay.as_str()), Level::Warn);
            let mut r = self.replaced.lock();
            let q = r.entry(chan.relay.clone()).or_default();
            q.push_back(t);
            while q.front().is_some_and(|x| t - x >= 3_600_000) {
                q.pop_front();
            }
            if q.len() > w::REPLACED_MAX_PER_HOUR {
                drop(r);
                self.desk.flapping(&chan.relay, t);
            }
        }
    }

    fn unregister(&self, chan: &Chan, t: i64) {
        let mut chans = self.chans.lock();
        if chans.get(&chan.relay).is_some_and(|c| c.conn == chan.conn) {
            chans.remove(&chan.relay);
            drop(chans);
            self.desk.on_closed(&chan.relay, t);
        }
        for (_, tx) in chan.pending.lock().drain() {
            let _ = tx.try_send(Err(Refusal::of("relay-offline")));
        }
    }

    /// F7 `FleetLink::request`: blocks the calling thread until the relay answers, the timeout passes, or the channel
    /// closes.
    pub fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, CallError> {
        let chan = self.chans.lock().get(relay).cloned().ok_or(CallError::Offline)?;
        if chan.in_flight.fetch_add(1, Ordering::SeqCst) >= w::IN_FLIGHT {
            chan.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(CallError::Busy);
        }
        let id = chan.take_id();
        let text = w::req_text(id, op, body);
        let result = if text.len() > w::TO_RELAY_MAX {
            Err(CallError::Refused(Refusal::of("fleet-op")))
        } else {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            chan.pending.lock().insert(id, tx);
            if !chan.send(text) {
                chan.pending.lock().remove(&id);
                Err(CallError::Offline)
            } else {
                match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err(r)) if r.code == "relay-offline" => Err(CallError::Offline),
                    Ok(Err(r)) => Err(CallError::Refused(r)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        chan.pending.lock().remove(&id);
                        Err(CallError::Timeout)
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(CallError::Offline),
                }
            }
        };
        chan.in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// F7 `FleetLink::event`.
    pub fn event(&self, relay: &str, op: &str, body: Value) -> bool {
        let text = w::evt_text(op, body);
        if text.len() > w::TO_RELAY_MAX {
            return false;
        }
        self.chans.lock().get(relay).is_some_and(|c| c.send(text))
    }

    pub fn connected(&self, relay: &str) -> bool {
        self.chans.lock().contains_key(relay)
    }

    pub fn close(&self, relay: &str, code: u16) {
        if let Some(c) = self.chans.lock().get(relay) {
            c.close(code);
        }
    }

    fn broadcast(&self, op: &str, body: &Value) {
        let text = w::evt_text(op, body.clone());
        for c in self.chans.lock().values() {
            c.send(text.clone());
        }
    }

    /// The per-relay frame limits of 3.8 (metrics 1 per 50 s, events 600 a minute); false: drop and count.
    fn event_allowed(&self, relay: &str, op: &str, t: i64) -> bool {
        let mut l = self.limits.lock();
        let e = l.entry(relay.to_owned()).or_insert((i64::MIN / 2, 0, t, 0));
        if op == "metrics" {
            if t - e.0 < w::METRICS_EVERY_MS {
                e.3 += 1;
                return false;
            }
            e.0 = t;
            return true;
        }
        if matches!(op, "attention" | "state" | "confirm-done") {
            if t - e.2 >= 60_000 {
                e.2 = t;
                e.1 = 0;
            }
            if e.1 >= w::EVENTS_PER_MINUTE {
                e.3 += 1;
                return false;
            }
            e.1 += 1;
        }
        true
    }

    /// Frames dropped by the 3.8 limits for one relay.
    #[cfg(test)]
    pub fn dropped(&self, relay: &str) -> u64 {
        self.limits.lock().get(relay).map(|e| e.3).unwrap_or(0)
    }

    /// Run one channel (console end) until it closes: `hello` first (within 90 s), then frames. Used for the
    /// network channel and the same-process `Local` one alike.
    pub async fn serve_channel(self: Arc<Self>, wire: Wire, peer: Peer, source: String) {
        let Peer::Relay { relay, serial, .. } = peer.clone() else { return };
        let (mut tx, mut rx) = wire.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let chan = Arc::new(Chan { conn: self.conn_seq.fetch_add(1, Ordering::SeqCst), relay: relay.clone(), serial: serial.clone(), out: out_tx, pending: Mutex::new(HashMap::new()), next_id: AtomicU32::new(1), in_flight: AtomicUsize::new(0) });
        let writer = tokio::spawn(async move {
            while let Some(o) = out_rx.recv().await {
                match o {
                    Out::Text(t) => {
                        if !tx.text(t).await {
                            break;
                        }
                    }
                    Out::Close(code) => {
                        tx.close(code).await;
                        break;
                    }
                }
            }
        });
        // hello first
        let first = tokio::time::timeout(w::IDLE, rx.next()).await;
        let hello = match first {
            Ok(In::Text(t)) => match w::parse_frame(&t, Side::Console) {
                Ok(Frame::Evt { op: "hello", body }) if body.get("relayId").and_then(Value::as_str) == Some(relay.as_str()) => Some(Value::Object(body)),
                _ => None,
            },
            _ => None,
        };
        let Some(hello) = hello else {
            frame_refused(&self.logger, &relay, "hello");
            chan.close(w::CLOSE_PROTOCOL);
            let _ = writer.await;
            return;
        };
        let t = now_ms();
        // the first hello with a renewed or recovered certificate denies the old serials (3.4) and closes the
        // recovery record (A3-M2)
        let old = self.desk.renew_switched(&relay, &serial, t);
        {
            let mut ca = self.ca.lock();
            if !old.is_empty() {
                for s in &old {
                    ca.denied.deny(s, t + x509::LEAF_DAYS * x509::DAY_MS);
                }
                let _ = ca.save();
            }
            ca.recovery_connected(&relay, &serial);
        }
        let active: Vec<u64> = hello["pins"].as_array().map(|a| a.iter().filter(|p| p["state"] == json!("active")).filter_map(|p| p["generation"].as_u64()).collect()).unwrap_or_default();
        self.pins.lock().insert(relay.clone(), active);
        self.register(chan.clone(), t);
        match self.desk.on_hello(&relay, &hello, &source, t) {
            Ok(welcome) => {
                chan.send(w::evt_text("welcome", welcome));
                self.desk.on_welcomed(&relay, t);
            }
            Err(r) => {
                self.logger.security("fleet.hello-refused", &Fields::new().with("relay", relay.as_str()).with("code", r.code.as_str()), Level::Warn);
                chan.close(w::CLOSE_PROTOCOL);
                self.unregister(&chan, t);
                let _ = writer.await;
                return;
            }
        }
        let mut parts = w::Parts::default();
        loop {
            let next = match tokio::time::timeout(w::IDLE, rx.next()).await {
                Ok(n) => n,
                Err(_) => {
                    chan.close(1000);
                    break;
                }
            };
            let t = now_ms();
            match next {
                In::Text(text) => match w::parse_frame(&text, Side::Console) {
                    Ok(Frame::Req { id, op: "renew", body }) => {
                        let state = self.clone();
                        let p = peer.clone();
                        let answer = tokio::task::spawn_blocking(move || state.renew(&p, &body, t)).await.unwrap_or_else(|_| Err(Refusal::of("fleet-op")));
                        chan.send(match answer {
                            Ok(b) => w::res_ok_text(id, b),
                            Err(r) => w::res_err_text(id, &r),
                        });
                    }
                    Ok(Frame::Req { id, op: "meet-cert", body }) => {
                        // AC-2b-D 8.4: the console checks the requests as 6.5 and issues; blocking like renew.
                        let state = self.clone();
                        let r = relay.clone();
                        let answer = tokio::task::spawn_blocking(move || state.desk.meet_cert(&r, &Value::Object(body), t)).await.unwrap_or_else(|_| Err(Refusal::of("fleet-op")));
                        chan.send(match answer {
                            Ok(b) => w::res_ok_text(id, b),
                            Err(r) => w::res_err_text(id, &r),
                        });
                    }
                    Ok(Frame::Req { id, .. }) => {
                        chan.send(w::res_err_text(id, &Refusal::of("fleet-op")));
                    }
                    Ok(Frame::Res { id, answer }) => {
                        if let Some(tx) = chan.pending.lock().remove(&id) {
                            let _ = tx.try_send(answer);
                        }
                    }
                    Ok(Frame::Part { id, i, of, data }) => match parts.push(id, i, of, &data) {
                        Ok(Some(v)) => {
                            if let Some(tx) = chan.pending.lock().remove(&id) {
                                let _ = tx.try_send(Ok(v));
                            }
                        }
                        Ok(None) => {
                            // The call already ended (`relay-timeout`, 3.8): its parts stop counting toward the 64 MiB.
                            if !chan.pending.lock().contains_key(&id) {
                                parts.drop_id(id);
                            }
                        }
                        Err(()) => {
                            frame_refused(&self.logger, &relay, "part");
                            if let Some(tx) = chan.pending.lock().remove(&id) {
                                let _ = tx.try_send(Err(Refusal::of("fleet-op")));
                            }
                        }
                    },
                    Ok(Frame::Evt { op: "hello", .. }) => frame_refused(&self.logger, &relay, "hello"),
                    Ok(Frame::Evt { op: "bye", body }) => {
                        self.desk.on_event(&relay, "bye", &Value::Object(body), t);
                        chan.close(w::CLOSE_BYE);
                        break;
                    }
                    Ok(Frame::Evt { op, body }) => {
                        if self.event_allowed(&relay, op, t) {
                            self.desk.on_event(&relay, op, &Value::Object(body), t);
                        }
                    }
                    Err(e) => {
                        if e.op.is_empty() {
                            frame_refused(&self.logger, &relay, e.why);
                        } else {
                            self.logger.security("fleet.frame-refused", &Fields::new().with("relay", &relay).with("why", e.why).with("op", e.op), Level::Warn);
                        }
                        if let Some(id) = e.id {
                            chan.send(w::res_err_text(id, &Refusal::of("fleet-op")));
                        }
                    }
                },
                In::Binary => {
                    frame_refused(&self.logger, &relay, "binary");
                    chan.close(w::CLOSE_BINARY);
                    break;
                }
                In::TooBig => {
                    frame_refused(&self.logger, &relay, "size");
                    chan.close(w::CLOSE_TOO_BIG);
                    break;
                }
                In::Pong(_) => {}
                In::Closed(_) | In::Failed => break,
            }
        }
        self.unregister(&chan, now_ms());
        let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
        // Read on briefly until the peer answers the close, so the connection is not dropped with unread bytes (which
        // some systems turn into a reset that discards the close frame).
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while !matches!(rx.next().await, In::Closed(_) | In::Failed) {}
        })
        .await;
    }

    // ── The minute tick ──

    pub fn tick(&self, t: i64) {
        let pushes = {
            let mut ca = self.ca.lock();
            vault_do(&*self.vault, |v| ca.tick(v, t))
        };
        for p in pushes {
            match p {
                Push::Manifest(m) => self.broadcast("trust", &m),
                Push::Distrust(d) => self.broadcast("ca-distrust", &d),
                Push::ServerChanged => self.reload_server_key(),
                Push::DenyGeneration(g) => {
                    let serials = self.desk.serials_of_generation(g);
                    let mut ca = self.ca.lock();
                    for (s, na) in serials {
                        ca.denied.deny(&s, na);
                    }
                    let _ = ca.save();
                }
                Push::Audit(action, detail) => self.desk.audit("console", action, detail, t),
            }
        }
    }

    // ── F7 FleetPki ──

    pub fn deny(&self, serials: &[String], t: i64) -> Result<(), String> {
        {
            let mut ca = self.ca.lock();
            for s in serials {
                ca.denied.deny(s, t + x509::LEAF_DAYS * x509::DAY_MS);
            }
            ca.save()?;
        }
        for c in self.chans.lock().values() {
            if serials.contains(&c.serial) {
                c.close(w::CLOSE_BYE);
            }
        }
        Ok(())
    }

    pub fn server_revoke(&self, t: i64) -> Result<(String, u64), String> {
        let r = {
            let mut ca = self.ca.lock();
            vault_do(&*self.vault, |v| ca.server_revoke(v, t))
        }?;
        self.reload_server_key();
        self.broadcast("trust", &self.trust());
        self.desk.audit("console", "fleet.server-revoke", json!({ "spkiSha256": r.0, "seq": r.1 }), t);
        Ok(r)
    }

    pub fn ca_rollover(&self, t: i64) -> Result<(u64, String), String> {
        let r = {
            let mut ca = self.ca.lock();
            vault_do(&*self.vault, |v| ca.ca_rollover(v, t))
        }?;
        self.broadcast("trust", &self.trust());
        Ok(r)
    }

    /// Relays whose last hello did not show the incoming generation active.
    pub fn unconfirmed(&self) -> usize {
        let Some(g) = self.ca.lock().incoming() else { return 0 };
        self.pins.lock().values().filter(|p| !p.contains(&g)).count()
    }
}

// ── TLS: the server's certificate and the relay verifier ────────────────────────────────────────────────────

#[derive(Debug)]
struct Resolver(Arc<PortState>);

impl ResolvesServerCert for Resolver {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.0.server_key.read().clone()
    }
}

/// The console's client verifier (invariant 6): a certificate is optional; one that is presented must be a relay
/// leaf of an accepted generation with a current, undenied serial, or an old-generation one matching an open
/// recovery record. Everything else fails the handshake.
#[derive(Debug)]
struct RelayVerifier(Arc<PortState>);

impl ClientCertVerifier for RelayVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }
    fn client_auth_mandatory(&self) -> bool {
        false
    }
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(&self, end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], now: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        let t = (now.as_secs() as i64) * 1000;
        match self.0.classify(end_entity.as_ref(), t) {
            Peer::Relay { .. } | Peer::Recovery { .. } => Ok(ClientCertVerified::assertion()),
            _ => Err(rustls::Error::InvalidCertificate(rustls::CertificateError::Revoked)),
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

/// The management port's server config (3.7): TLS 1.3 only, the restricted provider, an optional verified client
/// certificate, HTTP/1.1, no session resumption (every connection is checked against the denied list).
pub fn server_config(state: &Arc<PortState>) -> Result<Arc<ServerConfig>, String> {
    let mut cfg = ServerConfig::builder_with_provider(Arc::new(fleet_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(RelayVerifier(state.clone())))
        .with_cert_resolver(Arc::new(Resolver(state.clone())));
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    cfg.send_tls13_tickets = 0;
    Ok(Arc::new(cfg))
}

// ── HTTP on the port ────────────────────────────────────────────────────────────────────────────────────────

fn answer(status: u16, body: &Value, close: bool) -> Response<Full<Bytes>> {
    let mut b = Response::builder().status(status).header("content-type", "application/json").header("cache-control", "no-store");
    if close {
        b = b.header(CONNECTION, "close");
    }
    b.body(Full::new(Bytes::from(stringify(body)))).unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn refused(r: &Refusal) -> Response<Full<Bytes>> {
    answer(r.status, &r.body(), true)
}

fn not_found() -> Response<Full<Bytes>> {
    answer(404, &json!({ "ok": false, "code": "not-found", "error": w::NOT_FOUND }), true)
}

fn forbidden() -> Response<Full<Bytes>> {
    answer(403, &json!({ "ok": false, "code": "forbidden", "error": w::FORBIDDEN }), true)
}

async fn read_body(req: Request<Incoming>) -> Option<Value> {
    let collected = tokio::time::timeout(w::UPGRADE_WAIT, Limited::new(req.into_body(), w::BODY_MAX).collect()).await.ok()?.ok()?;
    parse_json(std::str::from_utf8(&collected.to_bytes()).ok()?)
}

/// What the port answers with: a whole body, or the program streamed from its sealed copy (AC-2b-D 4.2).
pub type PortBody = Either<Full<Bytes>, Download>;

/// Whether a request goes to the AC-2b-D 4.1 download routes: any peer but a recovery-only connection, which keeps its
/// 403 for everything but `recover-cert`.
fn to_downloads(peer: &Peer, path: &str) -> bool {
    path.starts_with(INSTALL_PREFIX) && !matches!(peer, Peer::Recovery { .. })
}

async fn handle(state: Arc<PortState>, peer: Peer, presented: Option<Vec<u8>>, ip: IpAddr, req: Request<Incoming>, cut: Arc<Notify>) -> Response<PortBody> {
    if to_downloads(&peer, req.uri().path()) {
        let path = req.uri().path().to_owned();
        let query = req.uri().query().unwrap_or_default().to_owned();
        return state.download(req.method().as_str(), &path, &query, ip, now_ms(), Some(cut));
    }
    handle_api(state, peer, presented, ip, req).await.map(Either::Left)
}

async fn handle_api(state: Arc<PortState>, peer: Peer, presented: Option<Vec<u8>>, ip: IpAddr, mut req: Request<Incoming>) -> Response<Full<Bytes>> {
    let path = req.uri().path().to_owned();
    let method = req.method().as_str().to_owned();
    let t = now_ms();
    // A recovery-only connection serves recover-cert and nothing else (3.11).
    if let Peer::Recovery { .. } = peer {
        if method != "POST" || path != "/fleet/v1/recover-cert" {
            return forbidden();
        }
        let (Some(body), Some(der)) = (read_body(req).await, presented) else { return refused(&Refusal::of("recovery-refused")) };
        let s = state.clone();
        return match tokio::task::spawn_blocking(move || s.recover(&der, &body, t)).await {
            Ok(Ok(a)) => answer(200, &a, false),
            Ok(Err(r)) => refused(&r),
            Err(_) => refused(&Refusal::of("recovery-refused")),
        };
    }
    match (method.as_str(), path.as_str()) {
        ("GET", "/fleet/v1/trust") => answer(200, &state.trust(), false),
        ("POST", "/fleet/v1/enroll/preview") | ("POST", "/fleet/v1/enroll") => {
            if peer != Peer::Anonymous {
                return forbidden();
            }
            if !state.rate_ok(ip, t) {
                return refused(&Refusal::new(429, "rate-limited", "Too many tries from this address. Wait a few minutes and try again."));
            }
            let host = host_of(&req);
            let Some(body) = read_body(req).await else { return refused(&Refusal::of("fleet-code")) };
            let s = state.clone();
            let enroll = path == "/fleet/v1/enroll";
            let source = crate::console_source::canonical(ip).to_string();
            let r = tokio::task::spawn_blocking(move || if enroll { s.enroll(&body, &host, &source, t) } else { s.preview(&body, &host, t) }).await;
            match r {
                Ok(Ok(a)) => answer(200, &a, false),
                Ok(Err(r)) => refused(&r),
                Err(_) => refused(&Refusal::of("fleet-op")),
            }
        }
        ("GET", w::CHANNEL_PATH) => {
            if !matches!(peer, Peer::Relay { .. }) {
                return forbidden();
            }
            let upgrade = req.headers().get(UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
            let proto = req.headers().get(SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|p| p.trim() == w::SUBPROTOCOL));
            let key = req.headers().get(SEC_WEBSOCKET_KEY).map(|k| derive_accept_key(k.as_bytes()));
            let (true, true, Some(accept)) = (upgrade, proto, key) else { return forbidden() };
            let on_upgrade = hyper::upgrade::on(&mut req);
            let source = crate::console_source::canonical(ip).to_string();
            tokio::spawn(async move {
                let Ok(upgraded) = on_upgrade.await else { return };
                let io: w::BoxIo = Box::new(TokioIo::new(upgraded));
                let ws = WebSocketStream::from_raw_socket(io, WsRole::Server, Some(w::ws_config(Side::Console))).await;
                state.serve_channel(Wire::Ws(Box::new(ws)), peer, source).await;
            });
            Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header(UPGRADE, "websocket")
                .header(CONNECTION, "Upgrade")
                .header(SEC_WEBSOCKET_ACCEPT, accept)
                .header(SEC_WEBSOCKET_PROTOCOL, w::SUBPROTOCOL)
                .body(Full::new(Bytes::new()))
                .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
        }
        _ => not_found(),
    }
}

// ── AC-2b-D 4: the download routes ──────────────────────────────────────────────────────────────────────────

/// The folder of the seven download paths (AC-2b-D 4.1, invariant D2).
pub const INSTALL_PREFIX: &str = "/fleet/v1/install/";
/// The four install scripts: (file, product, environment) as `deploy_scripts::body` names them.
pub const SCRIPTS: [(&str, &str, &str); 4] = [("meet-linux.sh", "meet", "linux"), ("spokes-linux.sh", "spokes", "linux"), ("meet-docker.sh", "meet", "docker"), ("spokes-docker.sh", "spokes", "docker")];
/// 4.4: scripts, `SHA256SUMS` and `meta`, 60 per 15 minutes per source; the program 6 per hour, 1 at once per source
/// and 4 in all.
const SMALL_CALLS: usize = 60;
const SMALL_WINDOW_MS: i64 = 15 * 60_000;
const PROGRAM_CALLS: usize = 6;
const PROGRAM_WINDOW_MS: i64 = 3_600_000;
const PROGRAM_AT_ONCE: usize = 4;
const PROGRAM_PER_SOURCE: usize = 1;
/// 4.4: a transfer is cut under 256 KiB/s averaged over 20 s after its first 20 s, or past 600 s.
const CUT_RATE: u64 = 256 * 1024;
const CUT_WINDOW_MS: u64 = 20_000;
const CUT_MAX_MS: u64 = 600_000;
const CHUNK: usize = 64 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const METHOD_WORDS: &str = "Method not allowed.";
const BAD_ENROLLMENT: &str = "The only query is e, an enrollment id (en_ and 16 hex).";

/// The sealed in-memory copy of the running program (4.2, invariant D3): every byte the port serves comes from it by
/// positional reads, so a program replaced on disk since exec is never served.
pub struct Program {
    #[cfg_attr(not(any(unix, windows)), allow(dead_code))]
    file: std::fs::File,
    pub size: u64,
    pub sha256: String,
}

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Program({} bytes, {})", self.size, self.sha256)
    }
}

#[cfg(target_os = "linux")]
mod memfd {
    extern "C" {
        pub fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
        pub fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    pub const MFD_CLOEXEC: u32 = 1;
    pub const MFD_ALLOW_SEALING: u32 = 2;
    pub const F_ADD_SEALS: i32 = 1033;
    pub const F_GET_SEALS: i32 = 1034;
    pub const F_SEAL_SEAL: i32 = 1;
    pub const F_SEAL_SHRINK: i32 = 2;
    pub const F_SEAL_GROW: i32 = 4;
    pub const F_SEAL_WRITE: i32 = 8;
}

impl Program {
    /// Copy `path` (at start `/proc/self/exe`, the running image) into a `memfd_create` file, seal it with
    /// `F_SEAL_WRITE`, `F_SEAL_SHRINK`, `F_SEAL_GROW` and `F_SEAL_SEAL`, then hash the sealed copy (SHA-256, streamed).
    #[cfg(target_os = "linux")]
    pub fn sealed_copy_of(path: &Path) -> Result<Program, String> {
        use std::os::unix::io::{AsRawFd, FromRawFd};
        let mut src = std::fs::File::open(path).map_err(|e| format!("{} could not be opened: {e}", path.display()))?;
        // SAFETY: a NUL-terminated name and two flags; the descriptor returned is owned by the File below alone.
        let fd = unsafe { memfd::memfd_create(c"lucid-relay".as_ptr(), memfd::MFD_CLOEXEC | memfd::MFD_ALLOW_SEALING) };
        if fd < 0 {
            return Err("memfd_create failed".into());
        }
        // SAFETY: `fd` is a new descriptor nothing else owns.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let size = std::io::copy(&mut src, &mut file).map_err(|e| format!("the program could not be copied: {e}"))?;
        drop(src);
        let seals = memfd::F_SEAL_WRITE | memfd::F_SEAL_SHRINK | memfd::F_SEAL_GROW | memfd::F_SEAL_SEAL;
        // SAFETY: fcntl on our own descriptor with one int argument.
        if unsafe { memfd::fcntl(file.as_raw_fd(), memfd::F_ADD_SEALS, seals) } != 0 {
            return Err("the copy could not be sealed".into());
        }
        // SAFETY: fcntl on our own descriptor with no argument.
        let got = unsafe { memfd::fcntl(file.as_raw_fd(), memfd::F_GET_SEALS) };
        if got < 0 || got & seals != seals {
            return Err("the copy is not sealed".into());
        }
        Program::hashed(file, size)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn sealed_copy_of(_path: &Path) -> Result<Program, String> {
        Err("the program is served only on Linux".into())
    }

    /// The bytes of an already open file (the sealed copy, or a test's file), hashed by positional reads.
    #[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
    fn hashed(file: std::fs::File, size: u64) -> Result<Program, String> {
        let mut p = Program { file, size, sha256: String::new() };
        let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
        let mut buf = vec![0u8; CHUNK];
        let mut pos = 0u64;
        while pos < size {
            let n = p.read_at(&mut buf, pos).map_err(|e| format!("the copy could not be read: {e}"))?;
            if n == 0 {
                break;
            }
            ctx.update(&buf[..n]);
            pos += n as u64;
        }
        if pos != size {
            return Err("the copy is shorter than the program".into());
        }
        p.sha256 = hex(ctx.finish().as_ref());
        Ok(p)
    }

    /// A plain file served as the program (tests of the routes on any system).
    #[cfg(test)]
    pub(crate) fn of_file(path: &Path) -> Result<Program, String> {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        Program::hashed(file, size)
    }

    fn read_at(&self, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            self.file.read_at(buf, pos)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            self.file.seek_read(buf, pos)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (buf, pos);
            Err(std::io::Error::other("not served on this system"))
        }
    }
}

/// Whether this console serves its program (4.2), or the reason id it does not: `not-linux`, `arch` (only `x86_64`
/// and `aarch64`), `dev-license` (a `dev-license` build without `--fleet-serve-dev`).
pub fn program_allowed(linux: bool, arch: &str, dev_build: bool, serve_dev: bool) -> Result<(), &'static str> {
    if !linux {
        return Err("not-linux");
    }
    if !matches!(arch, "x86_64" | "aarch64") {
        return Err("arch");
    }
    if dev_build && !serve_dev {
        return Err("dev-license");
    }
    Ok(())
}

fn load_program(serve_dev: bool, logger: &Logger) -> Result<Arc<Program>, &'static str> {
    program_allowed(cfg!(target_os = "linux"), std::env::consts::ARCH, cfg!(feature = "dev-license"), serve_dev)?;
    Program::sealed_copy_of(Path::new("/proc/self/exe")).map(Arc::new).map_err(|e| {
        logger.ops("deploy.program-copy-failed", &Fields::new().with("why", e), Level::Error);
        "copy-failed"
    })
}

/// The program this console serves, as the options route and the mint show it (AC-2b-D 9.1, 6.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryInfo {
    pub version: String,
    pub arch: String,
    pub sha256: String,
    pub size: u64,
    pub fips: bool,
}

/// The served program's facts, or the reason id none is served (`program_allowed`'s, `copy-failed`, or `not-started`
/// before `start` made the sealed copy).
pub fn served_binary() -> Result<BinaryInfo, &'static str> {
    let state = global().ok_or("not-started")?;
    let p = state.program.lock().clone()?;
    Ok(BinaryInfo { version: VERSION.to_owned(), arch: std::env::consts::ARCH.to_owned(), sha256: p.sha256.clone(), size: p.size, fips: cfg!(feature = "fips") })
}

/// The curl pin string (4.3): `sha256//<base64>` of each server leaf the manifest lists (its `spkiSha256`), the
/// current leaf first and the next one second when listed, joined by `;`.
pub fn curl_pins_of(manifest: &Value) -> String {
    let leaves = manifest.get("leaves").and_then(Value::as_array).cloned().unwrap_or_default();
    let pick = |role: &str| leaves.iter().find(|l| l.get("role").and_then(Value::as_str) == Some(role)).and_then(|l| w::unhex(l.get("spkiSha256")?.as_str()?)).filter(|h| h.len() == 32).map(|h| format!("sha256//{}", crate::meet_json::b64(&h)));
    [pick("current"), pick("next")].into_iter().flatten().collect::<Vec<_>>().join(";")
}

/// The `e` query of 4.1: empty or `en_` and 16 hex; any other key or value is refused.
fn enrollment_of(query: &str) -> Result<Option<String>, ()> {
    if query.is_empty() {
        return Ok(None);
    }
    let mut e = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').ok_or(())?;
        if k != "e" || e.is_some() || !(v.is_empty() || w::is_enrollment_id(v)) {
            return Err(());
        }
        e = Some(v.to_owned());
    }
    Ok(e.filter(|v| !v.is_empty()))
}

/// Take one call in a sliding window; Err is the milliseconds until the oldest call leaves it.
fn take_window(map: &Mutex<HashMap<String, VecDeque<i64>>>, key: &str, n: usize, span: i64, t: i64) -> Result<(), i64> {
    let mut m = map.lock();
    let q = m.entry(key.to_owned()).or_default();
    while q.front().is_some_and(|x| t - x >= span) {
        q.pop_front();
    }
    if q.len() >= n {
        return Err(q.front().map_or(span, |f| f + span - t));
    }
    q.push_back(t);
    Ok(())
}

/// 429 `deploy-rate` with the minutes in the words and `Retry-After` in seconds.
fn rate_refused(wait_ms: i64) -> Response<Full<Bytes>> {
    let secs = ((wait_ms + 999) / 1000).max(1);
    let minutes = ((secs + 59) / 60).max(1);
    let mut r = refused(&Refusal::filled("deploy-rate", &[("minutes", &minutes.to_string())]));
    r.headers_mut().insert(RETRY_AFTER, hyper::header::HeaderValue::from(secs as u64));
    r
}

fn file_answer(content_type: &'static str, body: Bytes) -> Response<Full<Bytes>> {
    Response::builder().status(200).header(CONTENT_TYPE, content_type).header(CACHE_CONTROL, "no-store").body(Full::new(body)).unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

/// `SHA256SUMS` (4.1): the program, then one line per script body.
fn sums_text(p: &Program) -> String {
    let mut s = format!("{}  lucid-relay-{VERSION}-linux-{}\n", p.sha256, std::env::consts::ARCH);
    for (name, product, env) in SCRIPTS {
        if let Some(b) = crate::deploy_scripts::body(product, env) {
            s.push_str(&format!("{}  {name}\n", hex(&sha256(b.as_bytes()))));
        }
    }
    s
}

/// `meta` (4.1): no origin and no build type (L4).
fn meta_value(p: &Program) -> Value {
    let mut scripts = serde_json::Map::new();
    for (name, product, env) in SCRIPTS {
        if let Some(b) = crate::deploy_scripts::body(product, env) {
            scripts.insert(name.to_owned(), json!(hex(&sha256(b.as_bytes()))));
        }
    }
    json!({ "v": 1, "version": VERSION, "arch": std::env::consts::ARCH, "fips": cfg!(feature = "fips"), "sha256": p.sha256, "size": p.size, "scripts": scripts })
}

/// AC-2b-D 4.4: cut when, after its first 20 s, the last 20 s carried less than 256 KiB/s on average, or past 600 s.
pub fn transfer_cut(elapsed_ms: u64, sent: u64, sent_20s_ago: u64) -> bool {
    elapsed_ms > CUT_MAX_MS || (elapsed_ms >= CUT_WINDOW_MS && sent.saturating_sub(sent_20s_ago) < CUT_RATE * (CUT_WINDOW_MS / 1000))
}

/// One program transfer's place in the 4.4 limits; released (and the transfer logged) when the body is dropped: at
/// its end, on failure, or when cut.
struct Slot {
    state: Arc<PortState>,
    source: String,
    started: Instant,
    sent: Arc<AtomicU64>,
    cut: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        {
            let mut a = self.state.dl_active.lock();
            let left = a.0.get_mut(&self.source).map(|n| {
                *n = n.saturating_sub(1);
                *n
            });
            if left == Some(0) {
                a.0.remove(&self.source);
            }
            a.1 = a.1.saturating_sub(1);
        }
        let ms = self.started.elapsed().as_millis() as u64;
        self.state.log_download("lucid-relay", &self.source, self.sent.load(Ordering::SeqCst), ms, self.cut.load(Ordering::SeqCst), now_ms());
    }
}

/// The program's bytes, read from the sealed copy as the connection takes them.
pub struct Download {
    program: Arc<Program>,
    pos: u64,
    slot: Slot,
}

impl hyper::body::Body for Download {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Result<hyper::body::Frame<Bytes>, std::io::Error>>> {
        let this = &mut *self;
        if this.slot.cut.load(Ordering::SeqCst) {
            return Poll::Ready(Some(Err(std::io::Error::other("the transfer was cut"))));
        }
        if this.pos >= this.program.size {
            return Poll::Ready(None);
        }
        let n = ((this.program.size - this.pos) as usize).min(CHUNK);
        let mut buf = vec![0u8; n];
        match this.program.read_at(&mut buf, this.pos) {
            Ok(0) => Poll::Ready(Some(Err(std::io::Error::other("the sealed copy ended early")))),
            Ok(k) => {
                buf.truncate(k);
                this.pos += k as u64;
                this.slot.sent.store(this.pos, Ordering::SeqCst);
                Poll::Ready(Some(Ok(hyper::body::Frame::data(Bytes::from(buf)))))
            }
            Err(e) => Poll::Ready(Some(Err(e))),
        }
    }

    fn is_end_stream(&self) -> bool {
        self.pos >= self.program.size
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        hyper::body::SizeHint::with_exact(self.program.size - self.pos)
    }
}

/// Watch one transfer every second and cut it by the 4.4 rule (the connection closes; the body stops).
fn watch(started: Instant, sent: Arc<AtomicU64>, cut: Arc<AtomicBool>, done: Arc<AtomicBool>, conn: Option<Arc<Notify>>) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    rt.spawn(async move {
        // (elapsed ms, bytes sent): from the newest mark at least 20 s old to now
        let mut marks: VecDeque<(u64, u64)> = VecDeque::from([(0, 0)]);
        let mut every = tokio::time::interval(Duration::from_secs(1));
        every.tick().await;
        loop {
            every.tick().await;
            if done.load(Ordering::SeqCst) {
                return;
            }
            let el = started.elapsed().as_millis() as u64;
            let now = sent.load(Ordering::SeqCst);
            marks.push_back((el, now));
            while marks.len() > 1 && marks[1].0 + CUT_WINDOW_MS <= el {
                marks.pop_front();
            }
            if transfer_cut(el, now, marks[0].1) {
                cut.store(true, Ordering::SeqCst);
                if let Some(c) = &conn {
                    c.notify_one();
                }
                return;
            }
        }
    });
}

impl PortState {
    /// The program this port serves (`start` makes the sealed copy; tests set their own).
    pub fn set_program(&self, p: Result<Arc<Program>, &'static str>) {
        *self.program.lock() = p;
    }

    /// The curl pin string of the current signed trust manifest (4.3).
    pub fn curl_pins(&self) -> String {
        curl_pins_of(&self.ca.lock().manifest)
    }

    /// `deploy.download` (ops, info), at most one line per source per file per minute (4.4); no audit entry.
    fn log_download(&self, file: &str, source: &str, bytes: u64, ms: u64, cut: bool, t: i64) {
        {
            let mut l = self.dl_logged.lock();
            let k = (source.to_owned(), file.to_owned());
            if l.get(&k).is_some_and(|at| t - at < 60_000) {
                return;
            }
            l.retain(|_, at| t - *at < 60_000);
            l.insert(k, t);
        }
        self.logger.ops("deploy.download", &Fields::new().with("file", file).with("source", source).with("bytes", bytes).with("ms", ms).with("cut", cut), Level::Info);
    }

    /// A served script: the 10-line header of 5.1 (every value checked against the safe pattern; one that fails is
    /// never served and is logged), then the body.
    fn script_text(&self, product: &str, env: &str, program: &Program, enrollment: &str) -> Option<String> {
        let body = crate::deploy_scripts::body(product, env)?;
        let console = self.cfg.fleet_url();
        let pins = self.curl_pins();
        let h = crate::deploy_scripts::Header { console: &console, pins: &pins, version: VERSION, arch: std::env::consts::ARCH, sha256: &program.sha256, profile: "standard", enrollment };
        match crate::deploy_scripts::header(&h) {
            Some(mut text) => {
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(body);
                Some(text)
            }
            None => {
                self.logger.ops("deploy.header-refused", &Fields::new().with("console", console.as_str()), Level::Error);
                None
            }
        }
    }

    /// The seven download paths (4.1 to 4.5): `GET` only (HEAD and the rest 405), any other path under the folder
    /// 404; under High 403 `deploy-high`; without a served program 404 `deploy-unavailable`; `e` checked; the limits
    /// of 4.4; `Cache-Control: no-store` on every answer.
    pub fn download(self: &Arc<Self>, method: &str, path: &str, query: &str, ip: IpAddr, t: i64, cut: Option<Arc<Notify>>) -> Response<PortBody> {
        let left = |r: Response<Full<Bytes>>| r.map(Either::Left);
        let file = path.strip_prefix(INSTALL_PREFIX).unwrap_or_default();
        let script = SCRIPTS.iter().find(|s| s.0 == file);
        if script.is_none() && !matches!(file, "lucid-relay" | "SHA256SUMS" | "meta") {
            return left(not_found());
        }
        if method != "GET" {
            return left(answer(405, &json!({ "ok": false, "code": "method", "error": METHOD_WORDS }), true));
        }
        if self.desk.high() {
            return left(refused(&Refusal::of("deploy-high")));
        }
        let program = match self.program.lock().clone() {
            Ok(p) => p,
            Err(_) => return left(refused(&Refusal::of("deploy-unavailable"))),
        };
        let Ok(e) = enrollment_of(query) else { return left(refused(&Refusal::new(400, "invalid", BAD_ENROLLMENT))) };
        let source = ip_key(ip);
        if file == "lucid-relay" {
            return self.send_program(program, e.as_deref(), source, t, cut);
        }
        if let Err(wait) = take_window(&self.dl_small, &source, SMALL_CALLS, SMALL_WINDOW_MS, t) {
            return left(rate_refused(wait));
        }
        let (body, ctype) = match script {
            Some((_, product, env)) => match self.script_text(product, env, &program, e.as_deref().unwrap_or_default()) {
                Some(text) => (Bytes::from(text), "text/x-shellscript; charset=utf-8"),
                None => return left(refused(&Refusal::of("deploy-unavailable"))),
            },
            None if file == "SHA256SUMS" => (Bytes::from(sums_text(&program)), "text/plain"),
            None => (Bytes::from(stringify(&meta_value(&program))), "application/json"),
        };
        self.log_download(file, &source, body.len() as u64, 0, false, t);
        left(file_answer(ctype, body))
    }

    /// `GET /fleet/v1/install/lucid-relay` (4.2, 4.4): 1 at once per source and 4 in all (`deploy-busy`), 6 an hour per
    /// source unless `e` names an enrollment open or used within its hour (`deploy-rate`), then the sealed copy.
    fn send_program(self: &Arc<Self>, program: Arc<Program>, e: Option<&str>, source: String, t: i64, conn: Option<Arc<Notify>>) -> Response<PortBody> {
        let counted = !e.is_some_and(|id| self.desk.download_enrollment_ok(id, t));
        {
            let mut a = self.dl_active.lock();
            if a.1 >= PROGRAM_AT_ONCE || a.0.get(&source).copied().unwrap_or(0) >= PROGRAM_PER_SOURCE {
                return refused(&Refusal::of("deploy-busy")).map(Either::Left);
            }
            if counted {
                if let Err(wait) = take_window(&self.dl_program, &source, PROGRAM_CALLS, PROGRAM_WINDOW_MS, t) {
                    return rate_refused(wait).map(Either::Left);
                }
            }
            *a.0.entry(source.clone()).or_insert(0) += 1;
            a.1 += 1;
        }
        let (sent, cut, done) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let started = Instant::now();
        watch(started, sent.clone(), cut.clone(), done.clone(), conn);
        let size = program.size;
        let body = Download { program, pos: 0, slot: Slot { state: self.clone(), source, started, sent, cut, done } };
        Response::builder()
            .status(200)
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_DISPOSITION, "attachment; filename=\"lucid-relay\"")
            .header(CONTENT_LENGTH, size)
            .header(ACCEPT_RANGES, "none")
            .header(CACHE_CONTROL, "no-store")
            .body(Either::Right(body))
            .unwrap_or_else(|_| Response::new(Either::Left(Full::new(Bytes::new()))))
    }
}

/// Counts a source's connections that have not presented a verified relay certificate (8 at once, 3.8).
struct Unverified {
    state: Arc<PortState>,
    ip: IpAddr,
    held: bool,
}

impl Unverified {
    fn take(state: &Arc<PortState>, ip: IpAddr) -> Option<Unverified> {
        let mut m = state.unverified.lock();
        let n = m.entry(ip).or_insert(0);
        if *n >= w::UNVERIFIED_PER_SOURCE {
            return None;
        }
        *n += 1;
        Some(Unverified { state: state.clone(), ip, held: true })
    }
    fn release(&mut self) {
        if self.held {
            self.held = false;
            let mut m = self.state.unverified.lock();
            if let Some(n) = m.get_mut(&self.ip) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.ip);
                }
            }
        }
    }
}

impl Drop for Unverified {
    fn drop(&mut self) {
        self.release();
    }
}

async fn serve_conn(state: Arc<PortState>, acceptor: TlsAcceptor, tcp: TcpStream, addr: SocketAddr) {
    let ip = crate::console_source::canonical(addr.ip());
    let Some(mut unverified) = Unverified::take(&state, ip) else { return };
    let Ok(Ok(tls)) = tokio::time::timeout(w::HANDSHAKE, acceptor.accept(tcp)).await else { return };
    let presented = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.as_ref().to_vec());
    let peer = match &presented {
        None => Peer::Anonymous,
        Some(der) => state.classify(der, now_ms()),
    };
    if peer == Peer::Refused {
        return;
    }
    if matches!(peer, Peer::Relay { .. }) {
        unverified.release();
    }
    let io = TokioIo::new(tls);
    // AC-2b-D 4.4: a program transfer that falls too slow, or runs too long, closes its connection.
    let cut = Arc::new(Notify::new());
    let cut_conn = cut.clone();
    let svc = service_fn(move |req| {
        let (state, peer, presented, cut) = (state.clone(), peer.clone(), presented.clone(), cut.clone());
        async move { Ok::<_, Infallible>(handle(state, peer, presented, ip, req, cut).await) }
    });
    let mut builder = http1::Builder::new();
    builder.timer(TokioTimer::new()).header_read_timeout(w::UPGRADE_WAIT);
    tokio::select! {
        _ = builder.serve_connection(io, svc).with_upgrades() => {}
        _ = cut_conn.notified() => {}
    }
}

/// Accept on `listener` until the process stops (512 connections at once, the source list, 3.8).
pub async fn run(listener: TcpListener, state: Arc<PortState>) {
    let slots = Arc::new(Semaphore::new(w::PORT_CONNECTIONS));
    let cfg = match server_config(&state) {
        Ok(c) => c,
        Err(e) => {
            state.logger.security("fleet.port-closed", &Fields::new().with("why", e), Level::Error);
            return;
        }
    };
    let acceptor = TlsAcceptor::from(cfg);
    loop {
        let Ok((tcp, addr)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        if !state.open() || (!state.cfg.sources.is_empty() && !state.cfg.sources.iter().any(|c| c.contains(addr.ip()))) {
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
        let (state, acceptor) = (state.clone(), acceptor.clone());
        tokio::spawn(async move {
            let _permit = permit;
            serve_conn(state, acceptor, tcp, addr).await;
        });
    }
}

// ── F7: the console end (FleetLink, FleetPki) and start ─────────────────────────────────────────────────────

struct PortLink(Arc<PortState>);

impl crate::console_fleet::FleetLink for PortLink {
    fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, crate::console_fleet::LinkError> {
        use crate::console_fleet::LinkError;
        self.0.request(relay, op, body, timeout_ms).map_err(|e| match e {
            CallError::Offline => LinkError::Offline,
            CallError::Timeout => LinkError::Timeout,
            CallError::Busy => LinkError::Busy,
            CallError::Refused(r) => LinkError::Refused { status: r.status, code: r.code, error: r.error },
        })
    }
    fn event(&self, relay: &str, op: &str, body: Value) -> bool {
        self.0.event(relay, op, body)
    }
    fn connected(&self, relay: &str) -> bool {
        self.0.connected(relay)
    }
    fn close(&self, relay: &str, code: u16) {
        self.0.close(relay, code)
    }
}

struct PortPki(Arc<PortState>);

fn api_error(e: String) -> crate::console::ApiError {
    crate::console::ApiError::with("seal-provider-needed", e)
}

impl crate::console_fleet::FleetPki for PortPki {
    fn pin(&self) -> Option<[u8; 32]> {
        self.0.ca.lock().pin()
    }
    fn status(&self, t: i64) -> crate::console_fleet::PkiStatus {
        let health = self.0.health();
        let days = self.0.ca.lock().ca_days_left(t);
        crate::console_fleet::PkiStatus {
            ready: health == Health::Ready,
            seal_needed: health == Health::SealNeeded,
            lost: health == Health::Lost,
            unreadable: health == Health::Unreadable,
            ca_days_left: days,
            unconfirmed: self.0.unconfirmed(),
        }
    }
    fn deny(&self, serials: &[String], t: i64) -> Result<(), String> {
        self.0.deny(serials, t)
    }
    fn trust_view(&self, _t: i64) -> Value {
        self.0.ca.lock().trust_view()
    }
    fn server_revoke(&self, t: i64) -> Result<(String, u64), crate::console::ApiError> {
        self.0.server_revoke(t).map_err(api_error)
    }
    fn ca_rollover(&self, t: i64) -> Result<(u32, String), crate::console::ApiError> {
        self.0.ca_rollover(t).map(|(g, f)| (g as u32, f)).map_err(api_error)
    }
}

/// Start the management port of a fleet console (main.rs, on the current tokio runtime): open the PKI from the
/// console's sealed store, attach the PKI and the link to the fleet section, record what offline commands left,
/// tick every minute, and listen unless the port is 0, the PKI is not ready, or a High console lacks FIPS (3.7).
pub fn start(console: Arc<crate::console::Console>, cfg: PortConfig, logger: Arc<Logger>) -> Result<(), String> {
    let fleet = console.fleet().ok_or("the management port needs a fleet console")?;
    let desk: Arc<dyn Desk> = Arc::new(FleetDesk { console: console.clone(), fleet: fleet.clone() });
    let t = now_ms();
    let dir = console.cfg.state_dir.clone();
    let host = cfg.hostname();
    let console_id = desk.console_id();
    let mut ca = vault_do(&*console, |v| FleetCa::open(&dir, v, &console_id, &host, &cfg.names, t));
    for (action, detail) in std::mem::take(&mut ca.pending_audit) {
        desk.audit("operator", &action, detail, t);
    }
    let _ = ca.save();
    if ca.health != Health::Ready {
        let event = match ca.health {
            Health::Lost => "fleet.ca-lost",
            Health::SealNeeded => "fleet.seal-needed",
            Health::Expired => "fleet.ca-expired",
            _ => "fleet.state-unreadable",
        };
        logger.security(event, &Fields::new(), Level::Error);
    }
    let vault: Arc<dyn VaultLock> = console.clone();
    let state = PortState::new(desk, vault, ca, cfg.clone(), logger.clone());
    // AC-2b-D 4.2: the sealed copy of the running image, made once at start (under High every route still answers
    // `deploy-high`).
    state.set_program(load_program(cfg.serve_dev, &logger));
    let _ = PORT.set(state.clone());
    fleet.attach_pki(Arc::new(PortPki(state.clone())));
    fleet.attach_link(Arc::new(PortLink(state.clone())));
    let ticker = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(60));
        loop {
            every.tick().await;
            let s = ticker.clone();
            let _ = tokio::task::spawn_blocking(move || s.tick(now_ms())).await;
        }
    });
    let fips_ok = crate::server::fips_check().is_ok() && cfg!(feature = "fips");
    if console.high_profile() && !fips_ok {
        logger.security("fleet.fips-needed", &Fields::new(), Level::Error);
        return Ok(());
    }
    if cfg.port == 0 {
        return Ok(());
    }
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let std_listener = std::net::TcpListener::bind(&addr).map_err(|e| format!("the management port {addr} could not be opened: {e}"))?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = TcpListener::from_std(std_listener).map_err(|e| e.to_string())?;
    logger.ops("fleet.port", &Fields::new().with("address", addr), Level::Info);
    tokio::spawn(run(listener, state));
    Ok(())
}

/// The console end of a same-process channel (2.2): the relay's certificate classifies the peer exactly as on the
/// network, then the same channel code runs over `Local`.
pub fn attach_local(end: LocalEnd, cert_der: &[u8]) -> Result<(), String> {
    let state = global().ok_or("the console's management state is not running in this process")?;
    let peer = state.classify(cert_der, now_ms());
    if !matches!(peer, Peer::Relay { .. }) {
        return Err("the same-process relay's certificate is not accepted".into());
    }
    tokio::spawn(state.serve_channel(Wire::Local(end), peer, "same-process".into()));
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fleet_ca::MemVault;
    use crate::fleet_x509::{Curve, Key};
    use crate::license::Product;
    use rustls::pki_types::ServerName;
    use std::collections::HashSet;

    pub(crate) const CID: &str = "c_0123456789abcdef";
    const HOST: &str = "console.example.com";

    /// A code: (secret, state, expires, wrong proofs, product).
    pub(crate) type TestCode = (Vec<u8>, String, i64, u32, String);

    /// A registry stand-in with the 3.1 rules f-console implements (open, expiry, 5 fails burn, used once).
    #[derive(Default)]
    pub(crate) struct TestDesk {
        pub codes: Mutex<HashMap<String, TestCode>>,
        pub serials: Mutex<HashMap<String, Vec<String>>>,
        pub events: Mutex<Vec<(String, String)>>,
        pub flapped: Mutex<HashSet<String>>,
        pub roster: Mutex<Value>,
        pub next_relay: AtomicU32,
        pub audits: Mutex<Vec<String>>,
        /// Every enrollment call that reached the console (preview, secret).
        pub calls: AtomicU32,
        /// AC-2b-D: the console's profile, enrollments whose downloads are not counted, `meet-cert` requests seen.
        pub high: AtomicBool,
        pub download_ok: Mutex<HashSet<String>>,
        pub meet_certs: Mutex<Vec<(String, Value)>>,
        /// AC-2b-D 6.2: the preview's `deploy` object (none when null).
        pub deploy: Mutex<Value>,
    }

    impl TestDesk {
        pub(crate) fn mint(&self, id: &str, secret: &[u8], product: &str, expires: i64) {
            self.codes.lock().insert(id.into(), (secret.to_vec(), "open".into(), expires, 0, product.into()));
        }
    }

    impl Desk for TestDesk {
        fn console_id(&self) -> String {
            CID.into()
        }
        fn state_ok(&self) -> bool {
            true
        }
        fn enroll_preview(&self, id: &str, host: &str, t: i64) -> Result<Value, Refusal> {
            let c = self.codes.lock();
            let (_, state, exp, _, product) = c.get(id).ok_or_else(|| Refusal::of("fleet-code-expired"))?;
            if state != "open" || t > *exp {
                return Err(Refusal::of("fleet-code-expired"));
            }
            let mut p = json!({ "console": { "id": CID, "origin": format!("https://{HOST}"), "rpId": HOST, "host": host }, "enrollment": { "product": product, "name": "Edge 1", "site": "", "scopes": ["read-health"], "expires": exp }, "policy": { "profile": "standard", "twoPerson": "off" }, "roster": self.roster.lock().clone(), "bootstrapRosterHash": "00" });
            let deploy = self.deploy.lock().clone();
            if !deploy.is_null() {
                p["deploy"] = deploy;
            }
            Ok(p)
        }
        fn enroll_secret(&self, id: &str) -> Option<Vec<u8>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.codes.lock().get(id).filter(|c| c.1 == "open").map(|c| c.0.clone())
        }
        fn enroll_failed(&self, id: &str, _t: i64) {
            if let Some(c) = self.codes.lock().get_mut(id) {
                c.3 += 1;
                if c.3 >= w::CODE_FAILS {
                    c.1 = "expired".into();
                    c.0.clear();
                }
            }
        }
        fn enroll_check(&self, id: &str, _relay: &Value, t: i64) -> Result<(), Refusal> {
            let c = self.codes.lock();
            match c.get(id) {
                Some(c) if c.1 == "open" && t <= c.2 => Ok(()),
                _ => Err(Refusal::of("fleet-code-expired")),
            }
        }
        fn draw_relay_id(&self, _id: &str) -> String {
            format!("r_{:016x}", self.next_relay.fetch_add(1, Ordering::SeqCst) + 1)
        }
        fn enroll_done(&self, id: &str, d: Done, _t: i64) -> Result<Value, Refusal> {
            if !id.is_empty() {
                let mut c = self.codes.lock();
                let code = c.get_mut(id).filter(|c| c.1 == "open").ok_or_else(|| Refusal::of("fleet-code-expired"))?;
                code.1 = "used".into();
                code.0.clear();
            }
            self.serials.lock().entry(d.relay_id.clone()).or_default().push(d.serial.clone());
            Ok(json!({ "relayId": d.relay_id, "name": "Edge 1", "site": "", "scopes": ["read-health"], "policy": { "profile": "standard", "twoPerson": "off" }, "policySeq": 0, "policyHash": "", "roster": self.roster.lock().clone(), "rosterSeq": 0, "rosterHash": "", "bootstrapRosterHash": "00", "console": { "id": CID, "origin": format!("https://{HOST}"), "rpId": HOST }, "fingerprint": x509::relay_fingerprint(&d.spki) }))
        }
        fn serial_ok(&self, relay: &str, serial: &str) -> bool {
            self.serials.lock().get(relay).is_some_and(|s| s.iter().any(|x| x == serial))
        }
        fn renewed(&self, relay: &str, d: Done, _t: i64) {
            self.serials.lock().entry(relay.into()).or_default().push(d.serial);
        }
        fn renew_switched(&self, relay: &str, serial: &str, _t: i64) -> Vec<String> {
            let mut s = self.serials.lock();
            let list = s.entry(relay.into()).or_default();
            let old: Vec<String> = list.iter().filter(|x| *x != serial).cloned().collect();
            list.retain(|x| x == serial);
            old
        }
        fn relay_recovered(&self, relay: &str, _o: &str, _n: &str, _g: u64, retry: bool, _t: i64) {
            self.audits.lock().push(format!("fleet.relay.recovered {relay} retry={retry}"));
        }
        fn on_hello(&self, relay: &str, _body: &Value, _source: &str, t: i64) -> Result<Value, Refusal> {
            self.events.lock().push((relay.into(), "hello".into()));
            Ok(json!({ "consoleId": CID, "time": t, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1 }))
        }
        fn on_welcomed(&self, _relay: &str, _t: i64) {}
        fn on_event(&self, relay: &str, op: &str, _body: &Value, _t: i64) {
            self.events.lock().push((relay.into(), op.into()));
        }
        fn on_closed(&self, relay: &str, _t: i64) {
            self.events.lock().push((relay.into(), "closed".into()));
        }
        fn flapping(&self, relay: &str, _t: i64) {
            self.flapped.lock().insert(relay.into());
        }
        fn serials_of_generation(&self, _g: u64) -> Vec<(String, i64)> {
            Vec::new()
        }
        fn audit(&self, _actor: &str, action: &str, _detail: Value, _t: i64) {
            self.audits.lock().push(action.into());
        }
        fn high(&self) -> bool {
            self.high.load(Ordering::SeqCst)
        }
        fn download_enrollment_ok(&self, id: &str, _t: i64) -> bool {
            self.download_ok.lock().contains(id)
        }
        fn meet_cert(&self, relay: &str, body: &Value, _t: i64) -> Result<Value, Refusal> {
            self.meet_certs.lock().push((relay.into(), body.clone()));
            Ok(json!({ "cert": "-----BEGIN CERTIFICATE-----", "signerCert": null }))
        }
    }

    pub(crate) fn test_port(name: &str) -> (Arc<PortState>, Arc<TestDesk>, Arc<Mutex<MemVault>>) {
        let dir = crate::fleet_ca::tests_dir(name);
        let vault = Arc::new(Mutex::new(MemVault::default()));
        let ca = vault_do(&*vault, |v| FleetCa::open(&dir, v, CID, HOST, &["localhost".into()], now_ms()));
        let desk = Arc::new(TestDesk::default());
        let logger = Arc::new(Logger::capture("console", Box::new(|_, _| {})));
        let cfg = PortConfig { host: "127.0.0.1".into(), port: 0, names: vec!["localhost".into()], sources: Vec::new(), public_host: HOST.into(), serve_dev: false };
        (PortState::new(desk.clone(), vault.clone(), ca, cfg, logger), desk, vault)
    }

    pub(crate) fn pin(state: &PortState) -> [u8; 32] {
        state.ca.lock().pin().unwrap()
    }

    /// A relay's proofs for an enrollment, as fleet_agent makes them.
    pub(crate) fn enroll_body(code: &w::Code, preview: &Value, key: &Key, relay: &Value) -> Value {
        let hash: [u8; 32] = *w::preview_hash(preview).unwrap().expose();
        let input = w::enroll_input(&code.id(), &hash, &key.spki(), relay).unwrap();
        json!({ "v": 1, "id": code.id(), "spki": b64u(&key.spki()), "previewHash": hex(&hash), "relay": relay, "mac": b64u(w::enroll_mac(code.secret.expose(), &input).expose()), "sig": b64u(&key.sign(&input).unwrap()) })
    }

    pub(crate) fn relay_value() -> Value {
        json!({ "product": "spokes", "version": "1", "fips": false, "profile": "standard", "host": "edge-1", "os": "linux", "localConsole": false })
    }

    pub(crate) fn mint_code(state: &PortState, desk: &TestDesk, expires: i64) -> w::Code {
        let id: [u8; 8] = crate::console_auth::random(8).unwrap().try_into().unwrap();
        let secret: [u8; 20] = crate::console_auth::random(20).unwrap().try_into().unwrap();
        let text = w::code_encode(Product::Spokes, &id, &secret, &pin(state));
        let code = w::code_parse(&text).unwrap();
        desk.mint(&code.id(), &secret, "spokes", expires);
        code
    }

    fn preview_req(code: &w::Code, host: &str) -> Value {
        json!({ "v": 1, "id": code.id(), "mac": b64u(w::preview_mac(code.secret.expose(), &code.id(), host).expose()) })
    }

    #[test]
    fn enrollment_follows_3_3() {
        let (state, desk, _) = test_port("enroll");
        let t = now_ms();
        let code = mint_code(&state, &desk, t + 3_600_000);
        // preview consumes nothing: twice, same answer
        let p1 = state.preview(&preview_req(&code, HOST), HOST, t).unwrap();
        let p2 = state.preview(&preview_req(&code, HOST), HOST, t).unwrap();
        assert_eq!(p1, p2);
        assert!(desk.enroll_secret(&code.id()).is_some());
        // a preview proof for another host fails and counts
        assert_eq!(state.preview(&preview_req(&code, "evil.example"), HOST, t).err().unwrap().code, "fleet-code");
        assert_eq!(desk.codes.lock()[&code.id()].3, 1);
        // the preview changed since the operator checked it: fleet-preview-changed
        let key = Key::generate(Curve::P256).unwrap();
        let mut stale = p1.clone();
        stale["policy"]["twoPerson"] = json!("on");
        assert_eq!(state.enroll(&enroll_body(&code, &stale, &key, &relay_value()), HOST, "198.51.100.7", t).err().unwrap().code, "fleet-preview-changed");
        // a wrong product
        let mut meet = relay_value();
        meet["product"] = json!("meet");
        assert_eq!(state.enroll(&enroll_body(&code, &p1, &key, &meet), HOST, "x", t).err().unwrap().code, "fleet-product");
        // good: the certificate, the CA, the manifest, the fleet URL
        let a = state.enroll(&enroll_body(&code, &p1, &key, &relay_value()), HOST, "x", t).unwrap();
        let cert = crate::codec::unb64u(a["cert"].as_str().unwrap()).unwrap();
        let ca = crate::codec::unb64u(a["caCert"].as_str().unwrap()).unwrap();
        let (relay, _, c) = x509::relay_leaf(&cert, &ca, t).unwrap();
        assert_eq!(c.spki, key.spki(), "only the SPKI travelled; the key stayed with the relay");
        assert_eq!(a["relayId"], json!(relay));
        assert_eq!(a["fleetUrl"], json!("https://console.example.com:0"));
        assert_eq!(a["trust"]["seq"], state.trust()["seq"]);
        // the code's secret is gone; a second use answers fleet-code-expired
        assert!(desk.enroll_secret(&code.id()).is_none());
        assert_eq!(state.enroll(&enroll_body(&code, &p1, &key, &relay_value()), HOST, "x", t).err().unwrap().code, "fleet-code-expired");
        assert_eq!(state.preview(&preview_req(&code, HOST), HOST, t).err().unwrap().code, "fleet-code-expired");
    }

    #[test]
    fn five_wrong_proofs_burn_the_code_and_expired_or_cancelled_codes_answer_expired() {
        let (state, desk, _) = test_port("burn");
        let t = now_ms();
        let code = mint_code(&state, &desk, t + 3_600_000);
        let p = state.preview(&preview_req(&code, HOST), HOST, t).unwrap();
        let key = Key::generate(Curve::P256).unwrap();
        for i in 0..5 {
            let mut b = enroll_body(&code, &p, &key, &relay_value());
            b["mac"] = json!(b64u(&[i as u8; 32]));
            assert_eq!(state.enroll(&b, HOST, "x", t).err().unwrap().code, "fleet-code", "try {i}");
        }
        // the sixth try, even with the right proof, finds the code burned
        assert_eq!(state.enroll(&enroll_body(&code, &p, &key, &relay_value()), HOST, "x", t).err().unwrap().code, "fleet-code-expired");
        // expired
        let late = mint_code(&state, &desk, t - 1);
        let body = json!({ "v": 1, "id": late.id(), "mac": b64u(w::preview_mac(late.secret.expose(), &late.id(), HOST).expose()) });
        assert_eq!(state.preview(&body, HOST, t).err().unwrap().code, "fleet-code-expired");
        // cancelled
        let c = mint_code(&state, &desk, t + 60_000);
        desk.codes.lock().get_mut(&c.id()).unwrap().1 = "cancelled".into();
        assert_eq!(state.preview(&preview_req(&c, HOST), HOST, t).err().unwrap().code, "fleet-code-expired");
        // the enroll/preview rate: 30 per 15 minutes per source, IPv6 by /64
        let ip: IpAddr = "2001:db8::1".parse().unwrap();
        for _ in 0..30 {
            assert!(state.rate_ok(ip, t));
        }
        assert!(!state.rate_ok("2001:db8::ffff".parse().unwrap(), t));
        assert!(state.rate_ok("2001:db8:0:1::1".parse().unwrap(), t));
        assert!(state.rate_ok(ip, t + w::ENROLL_WINDOW_MS));
    }

    pub(crate) fn enrolled(state: &PortState, desk: &TestDesk) -> (String, Key, Vec<u8>) {
        let t = now_ms();
        let code = mint_code(state, desk, t + 3_600_000);
        let p = state.preview(&preview_req(&code, HOST), HOST, t).unwrap();
        let key = Key::generate(Curve::P256).unwrap();
        let a = state.enroll(&enroll_body(&code, &p, &key, &relay_value()), HOST, "x", t).unwrap();
        (a["relayId"].as_str().unwrap().to_owned(), key, crate::codec::unb64u(a["cert"].as_str().unwrap()).unwrap())
    }

    #[test]
    fn renewal_issues_switches_at_the_next_hello_then_denies_the_old_serial() {
        let (state, desk, _) = test_port("renew");
        let (relay, key, cert) = enrolled(&state, &desk);
        let t = now_ms();
        let Peer::Relay { serial, .. } = state.classify(&cert, t) else { panic!() };
        let peer = Peer::Relay { relay: relay.clone(), serial: serial.clone(), generation: 1, spki: key.spki() };
        let new = Key::generate(Curve::P256).unwrap();
        let input = w::renew_input(&relay, &serial, &new.spki()).unwrap();
        let body = json!({ "spki": b64u(&new.spki()), "sigOld": b64u(&key.sign(&input).unwrap()), "sigNew": b64u(&new.sign(&input).unwrap()) });
        // a wrong sigOld is refused
        let mut bad = body.clone();
        bad["sigOld"] = bad["sigNew"].clone();
        assert!(state.renew(&peer, bad.as_object().unwrap(), t).is_err());
        let a = state.renew(&peer, body.as_object().unwrap(), t).unwrap();
        let new_cert = crate::codec::unb64u(a["cert"].as_str().unwrap()).unwrap();
        let Peer::Relay { serial: new_serial, .. } = state.classify(&new_cert, t) else { panic!("the new certificate is accepted") };
        // both serials work until the hello with the new one
        assert!(matches!(state.classify(&cert, t), Peer::Relay { .. }));
        let old = desk.renew_switched(&relay, &new_serial, t);
        assert_eq!(old, vec![serial.clone()]);
        state.deny(&old, t).unwrap();
        assert_eq!(state.classify(&cert, t), Peer::Refused, "a denied serial fails the handshake");
        assert!(matches!(state.classify(&new_cert, t), Peer::Relay { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn channels_replace_flap_limit_and_close_on_binary() {
        let (state, desk, _) = test_port("chan");
        let (relay, key, cert) = enrolled(&state, &desk);
        let t = now_ms();
        let peer = state.classify(&cert, t);
        let hello = |relay: &str| w::evt_text("hello", json!({"relayId": relay, "version": "1", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": [], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": {}, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "pins": [{"generation": 1, "pin": "x", "state": "active"}], "certNotAfter": 0}));
        let _ = key;
        let mut ends = Vec::new();
        for i in 0..12 {
            let (console_end, relay_end) = w::local_pair();
            tokio::spawn(state.clone().serve_channel(Wire::Local(console_end), peer.clone(), "test".into()));
            let (mut tx, mut rx) = Wire::Local(relay_end).split();
            assert!(tx.text(hello(&relay)).await);
            let In::Text(welcome) = rx.next().await else { panic!("welcome {i}") };
            assert!(matches!(w::parse_frame(&welcome, Side::Relay), Ok(Frame::Evt { op: "welcome", .. })));
            if let Some((_, prev_rx)) = ends.last_mut() {
                let prev_rx: &mut w::WireRx = prev_rx;
                assert!(matches!(prev_rx.next().await, In::Closed(Some(w::CLOSE_REPLACED))), "the second channel replaces the first");
            }
            ends.push((tx, rx));
        }
        assert!(desk.flapped.lock().contains(&relay), "11 replacements in an hour raise relay-flapping");
        let (tx, rx) = ends.last_mut().unwrap();
        // a request from the console answered by the relay end
        let s = state.clone();
        let r = relay.clone();
        let call = tokio::task::spawn_blocking(move || s.request(&r, "nonce", json!({"n": 1}), 5_000));
        let In::Text(req) = rx.next().await else { panic!() };
        let Ok(Frame::Req { id, op: "nonce", .. }) = w::parse_frame(&req, Side::Relay) else { panic!("{req}") };
        assert!(tx.text(w::res_ok_text(id, json!({"nonces": ["a"], "ttl": 120}))).await);
        assert_eq!(call.await.unwrap().unwrap()["ttl"], 120);
        // unknown op and extra keys from the relay are answered fleet-op / logged and the channel stays open
        assert!(tx.text(r#"{"t":"req","id":9,"op":"format","body":{}}"#.into()).await);
        let In::Text(refusal) = rx.next().await else { panic!() };
        assert_eq!(w::parse_frame(&refusal, Side::Relay).unwrap(), Frame::Res { id: 9, answer: Err(Refusal::of("fleet-op")) });
        // events within limits reach the desk; a second metrics snapshot inside 50 s is dropped
        let snap = w::evt_text("metrics", json!({"v": 1, "seq": 1, "ts": t, "interval": 60, "m": {}}));
        assert!(tx.text(snap.clone()).await && tx.text(snap).await);
        // bye closes with 4003
        assert!(tx.text(w::evt_text("bye", json!({"reason": "left"}))).await);
        assert!(matches!(rx.next().await, In::Closed(Some(w::CLOSE_BYE))));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let events = desk.events.lock().clone();
        assert_eq!(events.iter().filter(|(_, op)| op == "metrics").count(), 1);
        assert!(events.iter().any(|(_, op)| op == "bye"));
        assert_eq!(state.dropped(&relay), 1);
        assert!(!state.connected(&relay));
        // the request path reports an offline relay
        assert_eq!(state.request(&relay, "nonce", json!({"n": 1}), 100).err(), Some(CallError::Offline));
    }

    /// TLS: the server config offers exactly TLS 1.3, the two suites, the two groups and the two schemes; a peer
    /// limited to TLS 1.2, to ChaCha20 or to X25519 fails; a relay certificate opens the channel, a server leaf
    /// presented as a client is refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_tls_profile_is_exactly_3_7() {
        let p = fleet_provider();
        let suites: Vec<CipherSuite> = p.cipher_suites.iter().map(|s| s.suite()).collect();
        assert_eq!(suites.len(), 2);
        assert!(suites.contains(&CipherSuite::TLS13_AES_256_GCM_SHA384) && suites.contains(&CipherSuite::TLS13_AES_128_GCM_SHA256));
        let groups: Vec<NamedGroup> = p.kx_groups.iter().map(|g| g.name()).collect();
        assert_eq!(groups.len(), 2);
        assert!(groups.contains(&NamedGroup::secp384r1) && groups.contains(&NamedGroup::secp256r1));
        // SignatureScheme is not Hash; compare the wire values
        let schemes: HashSet<u16> = ALGS.mapping.iter().map(|(s, _)| u16::from(*s)).collect();
        assert_eq!(schemes, SCHEMES.iter().map(|s| u16::from(*s)).collect::<HashSet<u16>>());

        let (state, desk, _) = test_port("tls");
        let (_, key, cert) = enrolled(&state, &desk);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(run(listener, state.clone()));

        #[derive(Debug)]
        struct AnyServer;
        impl rustls::client::danger::ServerCertVerifier for AnyServer {
            fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            }
            fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                Ok(HandshakeSignatureValid::assertion())
            }
            fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                Ok(HandshakeSignatureValid::assertion())
            }
            fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
                crate::server::provider().signature_verification_algorithms.supported_schemes()
            }
        }
        async fn try_with(port: u16, provider: CryptoProvider, versions: &[&'static rustls::SupportedProtocolVersion], client: Option<(Vec<u8>, Vec<u8>)>) -> Result<String, String> {
            let b = rustls::ClientConfig::builder_with_provider(Arc::new(provider)).with_protocol_versions(versions).map_err(|e| e.to_string())?.dangerous().with_custom_certificate_verifier(Arc::new(AnyServer));
            let cfg = match client {
                Some((c, k)) => b.with_client_auth_cert(vec![CertificateDer::from(c)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(k))).map_err(|e| e.to_string())?,
                None => b.with_no_client_auth(),
            };
            let tcp = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
            let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(ServerName::try_from("console.example.com").unwrap(), tcp).await.map_err(|e| e.to_string())?;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            tls.write_all(b"GET /fleet/v1/trust HTTP/1.1\r\nHost: console.example.com\r\nConnection: close\r\n\r\n").await.map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            tls.read_to_end(&mut out).await.map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(&out).into_owned())
        }
        let ok = |r: Result<String, String>| r.map(|s| s.starts_with("HTTP/1.1 200")).unwrap_or(false);
        let base = crate::server::provider;
        // the profile itself works, without and with the relay's certificate
        assert!(ok(try_with(port, fleet_provider(), &[&rustls::version::TLS13], None).await));
        assert!(ok(try_with(port, fleet_provider(), &[&rustls::version::TLS13], Some((cert.clone(), key.pkcs8().to_vec()))).await));
        // TLS 1.2 only
        assert!(!ok(try_with(port, base(), &[&rustls::version::TLS12], None).await));
        // ChaCha20 only
        let mut chacha = base();
        chacha.cipher_suites.retain(|s| s.suite() == CipherSuite::TLS13_CHACHA20_POLY1305_SHA256);
        assert!(!ok(try_with(port, chacha, &[&rustls::version::TLS13], None).await));
        // X25519 only
        let mut x = base();
        x.kx_groups.retain(|g| g.name() == NamedGroup::X25519);
        assert!(!ok(try_with(port, x, &[&rustls::version::TLS13], None).await));
        // the server leaf presented as a client certificate is refused
        let (chain, server_key) = {
            let ca = state.ca.lock();
            vault_do(&*state.vault, |v| ca.server_identity(v)).unwrap()
        };
        assert!(!ok(try_with(port, fleet_provider(), &[&rustls::version::TLS13], Some((chain[0].clone(), server_key))).await));
    }

    // ── AC-2b-D 4: the download routes ──

    fn deploy_vector() -> Value {
        let path = format!("{}/tests/admin_console_fleet_deploy_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    /// A port serving the bytes of a plain file as its program.
    fn serving(name: &str, bytes: &[u8]) -> (Arc<PortState>, Arc<TestDesk>, Vec<u8>) {
        let (state, desk, _) = test_port(name);
        let f = crate::fleet_ca::tests_dir(name).join("lucid-relay.bin");
        std::fs::write(&f, bytes).unwrap();
        state.set_program(Ok(Arc::new(Program::of_file(&f).unwrap())));
        (state, desk, bytes.to_vec())
    }

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([192, 0, 2, n])
    }

    async fn body_of(r: Response<PortBody>) -> Vec<u8> {
        r.into_body().collect().await.map(|c| c.to_bytes().to_vec()).unwrap_or_default()
    }

    fn code_of(r: &Response<PortBody>) -> u16 {
        r.status().as_u16()
    }

    fn header<'a>(r: &'a Response<PortBody>, k: &str) -> &'a str {
        r.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or_default()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_seven_download_routes_answer_exactly() {
        let program: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let (state, desk, bytes) = serving("dl-routes", &program);
        let t = now_ms();
        let get = |path: &str, query: &str, n: u8| state.download("GET", path, query, ip(n), t, None);
        let sha = hex(&sha256(&bytes));
        // the four scripts: the 10-line header, then the body, the same bytes for every console
        for (i, (name, product, env)) in SCRIPTS.iter().enumerate() {
            let e = "en_0123456789abcdef";
            let r = get(&format!("{INSTALL_PREFIX}{name}"), &format!("e={e}"), 10 + i as u8);
            assert_eq!(code_of(&r), 200, "{name}");
            assert_eq!(header(&r, "content-type"), "text/x-shellscript; charset=utf-8");
            assert_eq!(header(&r, "cache-control"), "no-store");
            let text = String::from_utf8(body_of(r).await).unwrap();
            let lines: Vec<&str> = text.splitn(11, '\n').collect();
            assert_eq!(lines[0], "#!/usr/bin/env bash");
            assert_eq!(lines[1], "# Lucid relay installer served by a Lucid Admin Console. Read it before you run it.");
            assert_eq!(lines[2], format!("LUCID_CONSOLE='{}'", state.cfg.fleet_url()));
            assert_eq!(lines[3], format!("LUCID_PINS='{}'", state.curl_pins()));
            assert_eq!(lines[6], format!("LUCID_SHA256='{sha}'"));
            assert_eq!(lines[7], "LUCID_PROFILE='standard'");
            assert_eq!(lines[8], format!("LUCID_ENROLLMENT='{e}'"));
            assert_eq!(lines[10], crate::deploy_scripts::body(product, env).unwrap());
        }
        // without e the enrollment line is empty
        let text = String::from_utf8(body_of(get(&format!("{INSTALL_PREFIX}meet-linux.sh"), "", 20)).await).unwrap();
        assert!(text.lines().nth(8) == Some("LUCID_ENROLLMENT=''"));
        // the program: the sealed bytes, attachment, length, no ranges
        let r = get(&format!("{INSTALL_PREFIX}lucid-relay"), "", 21);
        assert_eq!(code_of(&r), 200);
        assert_eq!(header(&r, "content-type"), "application/octet-stream");
        assert_eq!(header(&r, "content-disposition"), "attachment; filename=\"lucid-relay\"");
        assert_eq!(header(&r, "content-length"), bytes.len().to_string());
        assert_eq!(header(&r, "cache-control"), "no-store");
        assert_eq!(body_of(r).await, bytes);
        // SHA256SUMS and meta
        let r = get(&format!("{INSTALL_PREFIX}SHA256SUMS"), "", 22);
        assert_eq!((code_of(&r), header(&r, "content-type")), (200, "text/plain"));
        let sums = String::from_utf8(body_of(r).await).unwrap();
        let first = format!("{sha}  lucid-relay-{VERSION}-linux-{}", std::env::consts::ARCH);
        assert_eq!(sums.lines().next(), Some(first.as_str()));
        for (name, product, env) in SCRIPTS {
            assert!(sums.lines().any(|l| l == format!("{}  {name}", hex(&sha256(crate::deploy_scripts::body(product, env).unwrap().as_bytes())))));
        }
        let r = get(&format!("{INSTALL_PREFIX}meta"), "", 23);
        assert_eq!((code_of(&r), header(&r, "content-type")), (200, "application/json"));
        let meta = parse_json(&String::from_utf8(body_of(r).await).unwrap()).unwrap();
        let keys: Vec<&str> = meta.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["v", "version", "arch", "fips", "sha256", "size", "scripts"]);
        assert_eq!((meta["sha256"].as_str(), meta["size"].as_u64()), (Some(sha.as_str()), Some(bytes.len() as u64)));
        assert_eq!(meta["scripts"].as_object().unwrap().len(), 4);
        // anything else under the folder 404; a HEAD or another method 405; a bad e 400
        assert_eq!(code_of(&get(&format!("{INSTALL_PREFIX}other.sh"), "", 24)), 404);
        assert_eq!(code_of(&get(INSTALL_PREFIX, "", 24)), 404);
        assert_eq!(code_of(&state.download("HEAD", &format!("{INSTALL_PREFIX}meta"), "", ip(24), t, None)), 405);
        assert_eq!(code_of(&state.download("POST", &format!("{INSTALL_PREFIX}lucid-relay"), "", ip(24), t, None)), 405);
        for q in ["e=LCE1-AAAA", "e=en_0123", "x=1", "e=en_0123456789abcdef&e=en_0123456789abcdef", "e"] {
            assert_eq!(code_of(&get(&format!("{INSTALL_PREFIX}meet-linux.sh"), q, 25)), 400, "{q}");
        }
        // recovery-only connections keep their 403 (the download routes are not theirs); relays and anonymous peers get them
        assert!(!to_downloads(&Peer::Recovery { relay: "r_0000000000000001".into(), serial: "1".into() }, "/fleet/v1/install/meta"));
        assert!(to_downloads(&Peer::Anonymous, "/fleet/v1/install/meta"));
        assert!(!to_downloads(&Peer::Anonymous, "/fleet/v1/trust"));
        // High: every route 403 deploy-high
        desk.high.store(true, Ordering::SeqCst);
        for f in ["meet-linux.sh", "spokes-linux.sh", "meet-docker.sh", "spokes-docker.sh", "lucid-relay", "SHA256SUMS", "meta"] {
            let r = get(&format!("{INSTALL_PREFIX}{f}"), "", 26);
            assert_eq!(code_of(&r), 403, "{f}");
            let v = parse_json(&String::from_utf8(body_of(r).await).unwrap()).unwrap();
            assert_eq!(v["code"], "deploy-high");
        }
        desk.high.store(false, Ordering::SeqCst);
        // no program served (a dev-license build without --fleet-serve-dev, another system): 404 deploy-unavailable
        state.set_program(Err("dev-license"));
        let r = get(&format!("{INSTALL_PREFIX}lucid-relay"), "", 27);
        assert_eq!(code_of(&r), 404);
        assert_eq!(parse_json(&String::from_utf8(body_of(r).await).unwrap()).unwrap()["code"], "deploy-unavailable");
    }

    #[test]
    fn the_program_is_served_only_where_4_2_allows() {
        assert_eq!(program_allowed(true, "x86_64", false, false), Ok(()));
        assert_eq!(program_allowed(true, "aarch64", false, false), Ok(()));
        assert_eq!(program_allowed(false, "x86_64", false, false), Err("not-linux"));
        assert_eq!(program_allowed(true, "riscv64", false, false), Err("arch"));
        assert_eq!(program_allowed(true, "x86_64", true, false), Err("dev-license"));
        assert_eq!(program_allowed(true, "x86_64", true, true), Ok(()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn download_limits_of_4_4() {
        let (state, desk, _) = serving("dl-limits", &[7u8; 1000]);
        let t = now_ms();
        // the 61st script request in 15 minutes from one source: 429 deploy-rate with Retry-After
        for i in 0..60 {
            assert_eq!(code_of(&state.download("GET", "/fleet/v1/install/meta", "", ip(1), t + i, None)), 200, "{i}");
        }
        let r = state.download("GET", "/fleet/v1/install/meet-linux.sh", "", ip(1), t + 60, None);
        assert_eq!(code_of(&r), 429);
        assert!(header(&r, "retry-after").parse::<u64>().unwrap() > 0);
        assert_eq!(parse_json(&String::from_utf8(body_of(r).await).unwrap()).unwrap()["code"], "deploy-rate");
        // another source is not limited by it; 15 minutes later the first is free again
        assert_eq!(code_of(&state.download("GET", "/fleet/v1/install/meta", "", ip(2), t, None)), 200);
        assert_eq!(code_of(&state.download("GET", "/fleet/v1/install/meta", "", ip(1), t + SMALL_WINDOW_MS, None)), 200);
        // the 7th program download in an hour: 429 with Retry-After
        let p = "/fleet/v1/install/lucid-relay";
        for i in 0..6 {
            let r = state.download("GET", p, "", ip(3), t + i, None);
            assert_eq!(code_of(&r), 200, "{i}");
            body_of(r).await;
        }
        let r = state.download("GET", p, "", ip(3), t + 6, None);
        assert_eq!(code_of(&r), 429);
        assert!(!header(&r, "retry-after").is_empty());
        // ... unless e names an enrollment open or used within its hour (a site behind one NAT)
        desk.download_ok.lock().insert("en_00000000000000aa".into());
        let r = state.download("GET", p, "e=en_00000000000000aa", ip(3), t + 7, None);
        assert_eq!(code_of(&r), 200);
        body_of(r).await;
        assert_eq!(code_of(&state.download("GET", p, "e=en_00000000000000bb", ip(3), t + 8, None)), 429);
        // 1 at once per source, 4 at once in all: the 5th is 503 deploy-busy
        let held: Vec<Response<PortBody>> = (10..14).map(|n| state.download("GET", p, "", ip(n), t, None)).collect();
        assert!(held.iter().all(|r| code_of(r) == 200));
        let r = state.download("GET", p, "", ip(14), t, None);
        assert_eq!(code_of(&r), 503);
        assert_eq!(parse_json(&String::from_utf8(body_of(r).await).unwrap()).unwrap()["code"], "deploy-busy");
        drop(held);
        let one = state.download("GET", p, "", ip(15), t, None);
        assert_eq!(code_of(&one), 200);
        assert_eq!(code_of(&state.download("GET", p, "", ip(15), t, None)), 503, "a second at once from one source");
        drop(one);
        assert_eq!(code_of(&state.download("GET", p, "", ip(15), t, None)), 200);
    }

    #[test]
    fn a_slow_or_long_transfer_is_cut() {
        let rate = CUT_RATE * 20;
        // the first 20 s are free
        assert!(!transfer_cut(19_999, 0, 0));
        // after them, the last 20 s must average 256 KiB/s
        assert!(transfer_cut(20_000, rate - 1, 0));
        assert!(!transfer_cut(20_000, rate, 0));
        assert!(transfer_cut(45_000, 10 * rate, 10 * rate - 1));
        assert!(!transfer_cut(45_000, 10 * rate, 9 * rate));
        // never past 600 s
        assert!(transfer_cut(600_001, u64::MAX / 2, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stalled_reader_is_cut_and_the_slot_freed() {
        // real time: the rule gives a transfer its first 20 s
        let (state, _, _) = serving("dl-stall", &[1u8; 300_000]);
        let conn = Arc::new(Notify::new());
        let r = state.download("GET", "/fleet/v1/install/lucid-relay", "", ip(30), now_ms(), Some(conn.clone()));
        assert_eq!(code_of(&r), 200);
        // nothing is read: after the first 20 s the watch closes the connection
        tokio::time::timeout(Duration::from_secs(30), conn.notified()).await.expect("cut");
        let mut body = r.into_body();
        let frame = body.frame().await;
        assert!(matches!(frame, Some(Err(_))), "the body stops after a cut");
        drop(body);
        assert_eq!(state.dl_active.lock().1, 0);
    }

    /// Invariant D3: the served bytes are the sealed copy made at start, even after the file on disk is replaced.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_sealed_copy_is_served_after_the_file_is_replaced() {
        let (state, _, _) = test_port("dl-sealed");
        let f = crate::fleet_ca::tests_dir("dl-sealed").join("exe");
        let first = vec![0x5au8; 150_000];
        std::fs::write(&f, &first).unwrap();
        let p = Program::sealed_copy_of(&f).unwrap();
        assert_eq!(p.sha256, hex(&sha256(&first)));
        // the copy cannot be written, shrunk or grown
        {
            use std::io::Write;
            let mut sealed = &p.file;
            assert!(sealed.write_all(b"x").is_err());
            assert!(p.file.set_len(1).is_err());
        }
        state.set_program(Ok(Arc::new(p)));
        std::fs::write(&f, vec![0xa5u8; 90_000]).unwrap();
        let r = state.download("GET", "/fleet/v1/install/lucid-relay", "", ip(40), now_ms(), None);
        assert_eq!(body_of(r).await, first);
    }

    #[test]
    fn the_curl_pins_list_current_then_next() {
        let cur = [0x11u8; 32];
        let next = [0x22u8; 32];
        let m = json!({ "leaves": [{ "role": "next", "spkiSha256": hex(&next) }, { "role": "current", "spkiSha256": hex(&cur) }] });
        assert_eq!(curl_pins_of(&m), format!("sha256//{};sha256//{}", crate::meet_json::b64(&cur), crate::meet_json::b64(&next)));
        let only = json!({ "leaves": [{ "role": "current", "spkiSha256": hex(&cur) }] });
        assert_eq!(curl_pins_of(&only), format!("sha256//{}", crate::meet_json::b64(&cur)));
        // the port's own manifest gives a pin string of the safe header pattern
        let (state, _, _) = test_port("dl-pins");
        assert!(state.curl_pins().starts_with("sha256//") && crate::deploy_scripts::safe_value(&state.curl_pins()));
    }

    /// The deploy vector: the pin string of a fixed manifest, and header rendering (unsafe values refused, an IPv6
    /// literal in brackets accepted).
    #[test]
    fn header_rendering_and_pins_of_the_deploy_vector() {
        let v = deploy_vector();
        assert_eq!(curl_pins_of(&v["pins"]["manifest"]), v["pins"]["pins"].as_str().unwrap());
        let s = |x: &Value| x.as_str().unwrap_or_default().to_owned();
        for c in v["header"]["cases"].as_array().unwrap() {
            let i = &c["inputs"];
            let (console, pins, version, arch, sha, profile, enrollment) = (s(&i["console"]), s(&i["pins"]), s(&i["version"]), s(&i["arch"]), s(&i["sha256"]), s(&i["profile"]), s(&i["enrollment"]));
            let h = crate::deploy_scripts::Header { console: &console, pins: &pins, version: &version, arch: &arch, sha256: &sha, profile: &profile, enrollment: &enrollment };
            let got = crate::deploy_scripts::header(&h);
            match c["lines"].as_array() {
                Some(lines) => {
                    let want: Vec<String> = lines.iter().map(s).collect();
                    let text = got.unwrap_or_else(|| panic!("{} refused", c["name"]));
                    assert_eq!(text.trim_end_matches('\n').split('\n').collect::<Vec<_>>(), want, "{}", c["name"]);
                }
                None => assert!(got.is_none(), "{} must be refused", c["name"]),
            }
        }
        let empty: Vec<String> = v["header"]["empty"]["lines"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(crate::deploy_scripts::empty_header().trim_end_matches('\n').split('\n').collect::<Vec<_>>(), empty);
        // an IPv6 console host is bracketed in fleetUrl and LUCID_CONSOLE
        let cfg = PortConfig { host: "::".into(), port: 7443, names: vec![], sources: vec![], public_host: "[2001:db8::1]".into(), serve_dev: false };
        assert!(cfg.fleet_url().starts_with("https://[2001:db8::1]"), "{}", cfg.fleet_url());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn meet_cert_goes_to_the_console() {
        let (state, desk, _) = test_port("meetcert");
        let (relay, _, _) = enrolled(&state, &desk);
        let (a, b) = w::local_pair();
        let peer = Peer::Relay { relay: relay.clone(), serial: desk.serials.lock()[&relay][0].clone(), generation: 1, spki: vec![] };
        tokio::spawn(state.clone().serve_channel(Wire::Local(a), peer, "test".into()));
        let (mut tx, mut rx) = Wire::Local(b).split();
        let hello = json!({"relayId": relay, "version": "1", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": [], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": {}, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "pins": [], "certNotAfter": 0});
        assert!(tx.text(w::evt_text("hello", hello)).await);
        let In::Text(_) = rx.next().await else { panic!("welcome") };
        assert!(tx.text(w::req_text(9, "meet-cert", json!({ "csr": "AAAA", "signerCsr": null }))).await);
        let In::Text(t) = rx.next().await else { panic!("answer") };
        assert!(matches!(w::parse_frame(&t, Side::Relay), Ok(Frame::Res { id: 9, answer: Ok(_) })));
        assert_eq!(desk.meet_certs.lock()[0].0, relay);
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_port.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
