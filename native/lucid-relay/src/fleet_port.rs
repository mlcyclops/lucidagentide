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

use crate::codec::{b64u, hex, now_ms, parse_json, sha256, stringify};
use crate::console_source::Cidr;
use crate::fleet_ca::{vault_do, FleetCa, Health, Push, VaultLock};
use crate::fleet_wire::{self as w, Frame, In, LocalEnd, Refusal, Side, Wire};
use crate::fleet_x509 as x509;
use crate::log::{Fields, Level, Logger};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, HOST, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
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
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Semaphore};
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
    fn on_event(&self, relay: &str, op: &str, body: &Value, t: i64);
    fn on_closed(&self, relay: &str, t: i64);
    fn flapping(&self, relay: &str, t: i64);
    /// (serial, notAfter) of every relay certificate issued under `generation`.
    fn serials_of_generation(&self, generation: u64) -> Vec<(String, i64)>;
    /// An entry in the console's audit chain.
    fn audit(&self, actor: &str, action: &str, detail: Value, t: i64);
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
}

impl PortConfig {
    fn hostname(&self) -> String {
        crate::server::dialed_of(&self.public_host, true).hostname
    }
    /// `fleetUrl` (3.3, 3.6).
    pub fn fleet_url(&self) -> String {
        format!("https://{}:{}", self.hostname(), self.port)
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
                        frame_refused(&self.logger, &relay, e.why);
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

async fn handle(state: Arc<PortState>, peer: Peer, presented: Option<Vec<u8>>, ip: IpAddr, mut req: Request<Incoming>) -> Response<Full<Bytes>> {
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
    let svc = service_fn(move |req| {
        let (state, peer, presented) = (state.clone(), peer.clone(), presented.clone());
        async move { Ok::<_, Infallible>(handle(state, peer, presented, ip, req).await) }
    });
    let mut builder = http1::Builder::new();
    builder.timer(TokioTimer::new()).header_read_timeout(w::UPGRADE_WAIT);
    let _ = builder.serve_connection(io, svc).with_upgrades().await;
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
            Ok(json!({ "console": { "id": CID, "origin": format!("https://{HOST}"), "rpId": HOST, "host": host }, "enrollment": { "product": product, "name": "Edge 1", "site": "", "scopes": ["read-health"], "expires": exp }, "policy": { "profile": "standard", "twoPerson": "off" }, "roster": self.roster.lock().clone(), "bootstrapRosterHash": "00" }))
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
    }

    pub(crate) fn test_port(name: &str) -> (Arc<PortState>, Arc<TestDesk>, Arc<Mutex<MemVault>>) {
        let dir = crate::fleet_ca::tests_dir(name);
        let vault = Arc::new(Mutex::new(MemVault::default()));
        let ca = vault_do(&*vault, |v| FleetCa::open(&dir, v, CID, HOST, &["localhost".into()], now_ms()));
        let desk = Arc::new(TestDesk::default());
        let logger = Arc::new(Logger::capture("console", Box::new(|_, _| {})));
        let cfg = PortConfig { host: "127.0.0.1".into(), port: 0, names: vec!["localhost".into()], sources: Vec::new(), public_host: HOST.into() };
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

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_port.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
