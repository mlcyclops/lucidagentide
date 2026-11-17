// AC-2a 3.1 to 3.6, 3.9 (apply), 3.10 to 3.13 and 5.7 (relay side of F1, F3, F17, F21): the relay's end of the
// management channel. The enrollment code is read only from a no-echo prompt, stdin, `--code-file` or `--code-fd`
// (never argv or the environment; the parser has no such path), previewed over a TLS 1.3 connection pinned to the
// code's CA, and handed to the relay's own service through a service-only, no-follow handoff file that the relay
// deletes before doing anything else; the relay draws and seals its key and applies the enrollment itself. Then it
// keeps one outbound channel: pinned mutual TLS 1.3 (3.7), an optional HTTP CONNECT proxy, the server leaf checked
// against a CA-signed trust manifest at trusted time (3.10, A2-M1, A3-M1 as revised in 3.2), the WebSocket upgrade,
// `hello`, pings, renewal (3.4), CA pins, rollover and `ca-distrust` (3.11), the restricted recovery client after
// `trust-ca` (A2-H2, idempotent retries A3-M2), `bye`, reconnect with backoff, and the failure categories of 3.13.
// Requests from the console go to f-trust (`RelayFrames`, F5) after the shape check.

use crate::codec::{b64u, hex, now_ms, parse_json, sha256, stringify, unb64u};
use crate::console::Console;
use crate::console_audit::canonical_json;
use crate::fleet_ca::{vault_do, Vault, VaultLock};
use crate::fleet_port::{fleet_provider, verify_tls13, SCHEMES};
use crate::fleet_wire::{self as w, Code, Events, Frame, In, Redacted, Refusal, RelayFrames, Side, Wire};
use crate::fleet_x509::{self as x509, Curve, Key};
use crate::license::Product;
use crate::log::{Fields, Level, Logger};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, SEC_WEBSOCKET_VERSION, UPGRADE};
use hyper::Request;
use hyper_util::rt::TokioIo;
use parking_lot::{Mutex, RwLock};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role as WsRole;
use tokio_tungstenite::WebSocketStream;

pub const LINK_FILE: &str = "fleet.json";
pub const HANDOFF_FILE: &str = "fleet-pending.json";
pub const KEY: &str = "fleet-key";
pub const KEY_LINK: &str = "fleet-key-link";
pub const KEY_OLD: &str = "fleet-key-old";
pub const KEY_NEXT: &str = "fleet-key-next";
pub const SAME_PROCESS: &str = "same-process";
pub const PROXY_ENV: &str = "LUCID_RELAY_FLEET_PROXY";

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// 3.10 (revision 3.2): issuedAt no more than 5 minutes after the reference; wall time more than 10 minutes ahead or
/// 5 minutes behind makes the relay clock-uncertain; a reset needs a manifest within 10 minutes of wall time.
const ISSUED_SLACK: i64 = 5 * MINUTE;
const AHEAD: i64 = 10 * MINUTE;
const BEHIND: i64 = 5 * MINUTE;
const RESET_WINDOW: i64 = 10 * MINUTE;
/// 3.4: renew with 30 days left; retry every 6 hours.
const RENEW_BEFORE: i64 = 30 * DAY;
const RENEW_RETRY: i64 = 6 * HOUR;
/// 3.3: a handoff file older than an hour is deleted unread.
const HANDOFF_MAX_AGE: Duration = Duration::from_secs(3600);
const TCP_CONNECT: Duration = Duration::from_secs(10);
const ANSWER_MAX: usize = 1024 * 1024;

// ── fleet.json (the link) ───────────────────────────────────────────────────────────────────────────────────

/// Every read-modify-write of `fleet.json` in this process holds this lock (f-trust's keys and mine).
static LINK_LOCK: Mutex<()> = Mutex::new(());

fn link_path(dir: &Path) -> PathBuf {
    dir.join(LINK_FILE)
}

fn read_link_file(dir: &Path) -> Result<Option<Map<String, Value>>, String> {
    let path = link_path(dir);
    match std::fs::read(&path) {
        Ok(b) => match std::str::from_utf8(&b).ok().and_then(parse_json) {
            Some(Value::Object(m)) => Ok(Some(m)),
            _ => Err(format!("{LINK_FILE} does not read back")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("{LINK_FILE} does not read back")),
    }
}

fn write_link_file(dir: &Path, m: &Map<String, Value>) -> Result<(), String> {
    crate::store::write_private(&link_path(dir), stringify(&Value::Object(m.clone())).as_bytes()).map_err(|e| format!("{LINK_FILE} could not be written: {e}"))
}

/// The link as stored (2.4), or None without one. Err when it exists and does not read back.
pub fn load_link_json(state_dir: &Path) -> Result<Option<Map<String, Value>>, String> {
    let _g = LINK_LOCK.lock();
    read_link_file(state_dir)
}

/// Read, change and write `fleet.json` atomically under the process's link lock; keys `f` does not touch are kept.
/// Err when there is no link (nothing is created) or it does not read back.
pub fn update_link(state_dir: &Path, f: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let _g = LINK_LOCK.lock();
    let mut m = read_link_file(state_dir)?.ok_or_else(|| "this relay is not enrolled".to_owned())?;
    f(&mut m)?;
    write_link_file(state_dir, &m)
}

fn remove_link(state_dir: &Path) {
    let _g = LINK_LOCK.lock();
    crate::store::remove(&link_path(state_dir));
}

/// A CA pin (3.11).
#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub generation: u64,
    pub pin: String,
    /// "active", "pending" or "distrusted".
    pub state: String,
    /// The CA certificate (the relay keeps it to verify chains and manifests of that generation).
    pub ca_cert: Option<Vec<u8>>,
}

impl Pin {
    pub fn to_json(&self, with_cert: bool) -> Value {
        let mut m = Map::new();
        m.insert("generation".into(), json!(self.generation));
        m.insert("pin".into(), json!(self.pin));
        m.insert("state".into(), json!(self.state));
        if with_cert {
            m.insert("caCert".into(), self.ca_cert.as_ref().map(|c| json!(b64u(c))).unwrap_or(Value::Null));
        }
        Value::Object(m)
    }
    pub fn of(v: &Value) -> Option<Pin> {
        Some(Pin {
            generation: v.get("generation")?.as_u64()?,
            pin: v.get("pin")?.as_str()?.to_ascii_lowercase(),
            state: v.get("state")?.as_str()?.to_owned(),
            ca_cert: v.get("caCert").and_then(Value::as_str).and_then(unb64u),
        })
    }
    fn active(&self) -> bool {
        self.state == "active"
    }
}

pub fn pins_of(v: Option<&Value>) -> Vec<Pin> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Pin::of).collect()).unwrap_or_default()
}

pub fn pins_value(pins: &[Pin], with_cert: bool) -> Value {
    Value::Array(pins.iter().map(|p| p.to_json(with_cert)).collect())
}

/// An enrolled relay's link (`fleet.json`): the whole object, with typed reads of the keys this file owns.
#[derive(Clone, Debug)]
pub struct Link {
    pub map: Map<String, Value>,
}

impl Link {
    fn s(&self, k: &str) -> &str {
        self.map.get(k).and_then(Value::as_str).unwrap_or_default()
    }
    pub fn origin(&self) -> &str {
        self.s("origin")
    }
    pub fn console_id(&self) -> &str {
        self.s("consoleId")
    }
    pub fn relay_id(&self) -> &str {
        self.s("relayId")
    }
    pub fn fleet_url(&self) -> &str {
        self.s("fleetUrl")
    }
    pub fn cert(&self) -> Option<Vec<u8>> {
        self.map.get("cert").and_then(Value::as_str).and_then(unb64u)
    }
    pub fn pins(&self) -> Vec<Pin> {
        pins_of(self.map.get("pins"))
    }
    pub fn key_lost(&self) -> bool {
        self.map.get("keyLost").and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn trust_time(&self) -> Option<i64> {
        self.map.get("trustTimeMs").and_then(Value::as_i64)
    }
    pub fn manifest(&self) -> Option<&Value> {
        self.map.get("trust").and_then(|t| t.get("manifest")).filter(|m| m.is_object())
    }
    pub fn stored(&self) -> Option<Stored> {
        self.manifest().and_then(Stored::of)
    }
    /// A link the channel can use: a certificate and its key not lost.
    pub fn usable(&self) -> bool {
        self.cert().is_some() && !self.key_lost()
    }
}

/// F13 and `start`: the link when it is usable; None without one, without a certificate, or after `fleet.key-lost`.
/// One that does not read back is logged `fleet.state-unreadable` and the relay starts unmanaged (2.4).
pub fn read_link(state_dir: &Path, logger: &Logger) -> Option<Link> {
    match load_link_json(state_dir) {
        Ok(Some(map)) => Some(Link { map }).filter(Link::usable),
        Ok(None) => None,
        Err(_) => {
            logger.security("fleet.state-unreadable", &Fields::new(), Level::Error);
            None
        }
    }
}

/// Whether an enrollment handoff waits (only stats the file).
pub fn has_handoff(state_dir: &Path) -> bool {
    std::fs::symlink_metadata(state_dir.join(HANDOFF_FILE)).is_ok()
}

// ── Trust manifests and trusted time (3.10, 3.11) ───────────────────────────────────────────────────────────

/// What a relay keeps of the newest manifest it accepted.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub seq: u64,
    pub issued_at: i64,
    /// SHA-256 of the canonical JSON of the whole manifest (sig included).
    pub sha256: [u8; 32],
}

impl Stored {
    pub fn of(m: &Value) -> Option<Stored> {
        Some(Stored { seq: m.get("seq")?.as_u64()?, issued_at: m.get("issuedAt")?.as_i64()?, sha256: sha256(&canonical_json(m).ok()?) })
    }
}

/// How a manifest is judged (3.10 as revised in 3.2).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// While running (pushed manifests, reconnects, wall time only ahead): at T; `issuedAt <= T + 5 min`, `T <
    /// expiresAt`; wall time unused.
    Running,
    /// At every start and while wall time is behind T: with `R = max(T, wall)` (revision 3.3, T the persisted
    /// trusted time), `issuedAt <= R + 5 min` and `R` no later than `expiresAt`.
    Refresh,
    /// The operator's `fleet trust-time reset`: a strictly higher seq, `issuedAt` within 10 minutes of wall time
    /// (it may be below the stored one).
    Reset,
}

/// Accept or refuse a manifest (3.10). Checks in the vector's order: unpinned-ca, signature, rollback-seq,
/// same-seq-different-bytes, rollback-issued, issued-future, expired, revoked, not-listed (Reset: unpinned-ca,
/// signature, not-higher, far, revoked, not-listed). `ca_of` gives a pinned generation's CA certificate DER; `leaf`
/// is the server leaf's spkiSha256 when one must be listed.
#[allow(clippy::too_many_arguments)]
pub fn accept_manifest(m: &Value, pins: &[Pin], ca_of: &dyn Fn(u64) -> Option<Vec<u8>>, console_id: Option<&str>, stored: Option<&Stored>, mode: Mode, t: i64, wall: i64, leaf: Option<&str>) -> Result<Stored, &'static str> {
    let o = m.as_object().filter(|o| o.len() == 10 && ["v", "consoleId", "caGeneration", "seq", "issuedAt", "expiresAt", "leaves", "revoked", "nextCa", "sig"].iter().all(|k| o.contains_key(*k))).ok_or("signature")?;
    let generation = o["caGeneration"].as_u64().ok_or("signature")?;
    let pin = pins.iter().find(|p| p.generation == generation && p.active()).ok_or("unpinned-ca")?;
    let ca = ca_of(generation).or_else(|| pin.ca_cert.clone()).ok_or("unpinned-ca")?;
    let ca_spki = crate::meet_x509::Cert::from_der(&ca).map(|c| c.spki).ok_or("unpinned-ca")?;
    if hex(&sha256(&ca_spki)) != pin.pin {
        return Err("unpinned-ca");
    }
    let sig = w::b64u_of(o.get("sig")).ok_or("signature")?;
    let input = w::trust_input(m).map_err(|_| "signature")?;
    if !x509::verify_p384(&ca_spki, &input, &sig) || console_id.is_some_and(|c| o["consoleId"].as_str() != Some(c)) {
        return Err("signature");
    }
    let seq = o["seq"].as_u64().ok_or("signature")?;
    let issued = o["issuedAt"].as_i64().ok_or("signature")?;
    let expires = o["expiresAt"].as_i64().ok_or("signature")?;
    let this = Stored::of(m).ok_or("signature")?;
    if mode == Mode::Reset {
        if stored.is_some_and(|s| seq <= s.seq) {
            return Err("not-higher");
        }
        if (issued - wall).abs() > RESET_WINDOW {
            return Err("far");
        }
    } else {
        if let Some(s) = stored {
            if seq < s.seq {
                return Err("rollback-seq");
            }
            if seq == s.seq && this.sha256 != s.sha256 {
                return Err("same-seq-different-bytes");
            }
            if issued < s.issued_at {
                return Err("rollback-issued");
            }
        }
        let (future, expired) = match mode {
            Mode::Running => (issued > t + ISSUED_SLACK, t >= expires),
            // revision 3.3: judged at R = max(T, wall), T the persisted trusted time (0 when none: R is wall)
            _ => {
                let r = t.max(wall);
                (issued > r + ISSUED_SLACK, r > expires)
            }
        };
        if future {
            return Err("issued-future");
        }
        if expired {
            return Err("expired");
        }
    }
    if let Some(leaf) = leaf {
        let listed = |k: &str| o[k].as_array().is_some_and(|a| a.iter().any(|e| e.get("spkiSha256").and_then(Value::as_str) == Some(leaf)));
        if listed("revoked") {
            return Err("revoked");
        }
        if !listed("leaves") {
            return Err("not-listed");
        }
    }
    Ok(this)
}

/// A manifest's `nextCa` (3.11): stored `pending`, never trusted on that signature; its fingerprint must be the pin
/// of its own certificate.
pub fn apply_next_ca(pins: &[Pin], m: &Value) -> Vec<Pin> {
    let mut out = pins.to_vec();
    let Some(n) = m.get("nextCa").filter(|n| n.is_object()) else { return out };
    let (Some(g), Some(cert), Some(fp)) = (n.get("generation").and_then(Value::as_u64), w::b64u_of(n.get("caCert")), n.get("fingerprint").and_then(Value::as_str)) else { return out };
    let Some(pin) = x509::pin_hex(&cert) else { return out };
    if !x509::same_fingerprint(&pin, fp) || out.iter().any(|p| p.generation >= g) {
        return out;
    }
    out.push(Pin { generation: g, pin, state: "pending".into(), ca_cert: Some(cert) });
    out
}

/// `trust-ca` (3.11): the operator's fingerprint activates the matching pending generation (and only that); with two
/// active already, the oldest becomes distrusted (at most two active, dual pins). Err `fingerprint` otherwise.
pub fn confirm_pin(pins: &[Pin], generation: Option<u64>, fingerprint: &str) -> Result<Vec<Pin>, &'static str> {
    let mut out = pins.to_vec();
    let i = out.iter().position(|p| p.state == "pending" && generation.is_none_or(|g| g == p.generation) && x509::same_fingerprint(&p.pin, fingerprint)).ok_or("fingerprint")?;
    out[i].state = "active".into();
    let active: Vec<u64> = out.iter().filter(|p| p.active()).map(|p| p.generation).collect();
    if active.len() > 2 {
        let oldest = active.iter().min().copied().unwrap_or_default();
        for p in out.iter_mut().filter(|p| p.generation == oldest) {
            p.state = "distrusted".into();
        }
    }
    Ok(out)
}

/// `ca-distrust {generation, sig}` (3.11): verified with any active or pending pinned CA over
/// `lp("lucid-fleet-distrust-v1", consoleId, generation)`; it only ever removes trust.
pub fn apply_distrust(pins: &[Pin], frame: &Value, console_id: &str, ca_of: &dyn Fn(u64) -> Option<Vec<u8>>) -> Result<Vec<Pin>, &'static str> {
    let g = frame.get("generation").and_then(Value::as_u64).ok_or("signature")?;
    let sig = w::b64u_of(frame.get("sig")).ok_or("signature")?;
    let input = w::distrust_input(console_id, g);
    let ok = pins.iter().filter(|p| p.state == "active" || p.state == "pending").any(|p| {
        ca_of(p.generation).or_else(|| p.ca_cert.clone()).and_then(|c| crate::meet_x509::Cert::from_der(&c)).is_some_and(|c| hex(&sha256(&c.spki)) == p.pin && x509::verify_p384(&c.spki, &input, &sig))
    });
    if !ok {
        return Err("signature");
    }
    Ok(pins.iter().map(|p| if p.generation == g { Pin { state: "distrusted".into(), ..p.clone() } } else { p.clone() }).collect())
}

/// Wall time against trusted time (3.10).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gap {
    Agree,
    Ahead(i64),
    Behind(i64),
}

pub fn gap_of(t: i64, wall: i64) -> Gap {
    if wall - t > AHEAD {
        Gap::Ahead(wall - t)
    } else if t - wall > BEHIND {
        Gap::Behind(t - wall)
    } else {
        Gap::Agree
    }
}

/// Trusted time T: advances only by the monotonic clock from its mark; raised only by an accepted manifest's
/// `issuedAt`, set back only by the operator's reset.
#[derive(Debug)]
pub struct TrustClock {
    base: i64,
    at: Instant,
    pub gap: Gap,
}

impl TrustClock {
    pub fn new(mark: i64) -> TrustClock {
        TrustClock { base: mark, at: Instant::now(), gap: Gap::Agree }
    }
    pub fn now(&self) -> i64 {
        self.base + self.at.elapsed().as_millis() as i64
    }
    /// `T = max(T, issuedAt)`.
    pub fn adopt(&mut self, issued_at: i64) {
        if issued_at > self.now() {
            self.set(issued_at);
        }
    }
    pub fn set(&mut self, t: i64) {
        self.base = t;
        self.at = Instant::now();
    }
}

// ── TLS to the console ──────────────────────────────────────────────────────────────────────────────────────

/// 3.13 failure categories.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Category {
    Dns,
    Tcp,
    Proxy,
    TlsProtocol,
    ServerUntrusted,
    ServerExpired,
    CertificateRefused,
    UpgradeRefused,
    Closed,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Dns => "dns",
            Category::Tcp => "tcp",
            Category::Proxy => "proxy",
            Category::TlsProtocol => "tls-protocol",
            Category::ServerUntrusted => "server-untrusted",
            Category::ServerExpired => "server-expired",
            Category::CertificateRefused => "certificate-refused",
            Category::UpgradeRefused => "upgrade-refused",
            Category::Closed => "closed",
        }
    }
    /// The 13.4 `cli.connect-<category>` words `fleet status` prints.
    pub fn words(self) -> &'static str {
        w::cli_words(&format!("cli.connect-{}", self.as_str()))
    }
}

fn category_of_rustls(e: &rustls::Error) -> Category {
    use rustls::{AlertDescription as A, CertificateError as C, Error as E};
    match e {
        E::InvalidCertificate(C::Expired) => Category::ServerExpired,
        E::InvalidCertificate(_) => Category::ServerUntrusted,
        E::AlertReceived(A::BadCertificate | A::CertificateRevoked | A::CertificateExpired | A::CertificateUnknown | A::UnknownCA | A::AccessDenied | A::CertificateRequired | A::UnsupportedCertificate) => Category::CertificateRefused,
        E::PeerIncompatible(_) | E::AlertReceived(A::HandshakeFailure | A::ProtocolVersion | A::InsufficientSecurity | A::IllegalParameter) => Category::TlsProtocol,
        _ => Category::Closed,
    }
}

/// The category of an error and its sources (an io::Error or a hyper::Error around a rustls::Error).
pub fn category_of(e: &(dyn std::error::Error + 'static)) -> Category {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(x) = cur {
        if let Some(r) = x.downcast_ref::<rustls::Error>() {
            return category_of_rustls(r);
        }
        if let Some(io) = x.downcast_ref::<std::io::Error>() {
            if let Some(r) = io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
                return category_of_rustls(r);
            }
        }
        cur = x.source();
    }
    Category::Closed
}

/// Which CAs the server must chain to: the relay's active pins, or (enrollment) the code's pin over the CA the
/// server presents.
#[derive(Debug, Clone)]
enum Anchor {
    Pinned(Vec<Vec<u8>>),
    Code([u8; 32]),
}

/// The relay's server verifier (invariant 6): a chain to a pinned CA, serverAuth only, CA false, the dialed host, in
/// date at trusted time. Records the leaf and its CA for the manifest check.
#[derive(Debug)]
struct PinnedServer {
    anchor: Anchor,
    host: String,
    t: i64,
    seen: Arc<Mutex<Option<SeenChain>>>,
}

/// The leaf and CA certificates (DER) the pinned server presented.
type SeenChain = (Vec<u8>, Vec<u8>);

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], _name: &ServerName<'_>, _ocsp: &[u8], _now: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let cas: Vec<Vec<u8>> = match &self.anchor {
            Anchor::Pinned(cas) => cas.clone(),
            Anchor::Code(pin) => intermediates.iter().map(|c| c.as_ref().to_vec()).filter(|c| crate::meet_x509::Cert::from_der(c).is_some_and(|x| sha256(&x.spki) == *pin)).collect(),
        };
        for ca in cas {
            if let Ok(cert) = x509::server_leaf(end_entity.as_ref(), &ca, &self.host) {
                if !x509::in_date(&cert, self.t) {
                    return Err(rustls::Error::InvalidCertificate(rustls::CertificateError::Expired));
                }
                *self.seen.lock() = Some((end_entity.as_ref().to_vec(), ca));
                return Ok(ServerCertVerified::assertion());
            }
        }
        Err(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer))
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

/// The relay's client config (3.7): TLS 1.3 only, the restricted provider, the pinned verifier, the relay's
/// certificate when it has one, HTTP/1.1, no resumption.
fn client_config(verifier: Arc<PinnedServer>, client: Option<(&[u8], &[u8])>) -> Result<Arc<ClientConfig>, String> {
    let b = ClientConfig::builder_with_provider(Arc::new(fleet_provider())).with_protocol_versions(&[&rustls::version::TLS13]).map_err(|e| e.to_string())?.dangerous().with_custom_certificate_verifier(verifier);
    let mut cfg = match client {
        Some((cert, key)) => b.with_client_auth_cert(vec![CertificateDer::from(cert.to_vec())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec()))).map_err(|e| e.to_string())?,
        None => b.with_no_client_auth(),
    };
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(cfg))
}

/// `https://host[:port]` (default port 7443).
pub fn parse_fleet_url(url: &str) -> Result<(String, u16), String> {
    let rest = url.trim().strip_prefix("https://").ok_or("the console URL must start with https://")?;
    let hostport = rest.split('/').next().unwrap_or_default();
    if hostport.is_empty() || hostport.contains('@') {
        return Err("the console URL has no host".into());
    }
    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        let (h, tail) = v6.split_once(']').ok_or("the console URL's host does not read")?;
        (h.to_owned(), tail.strip_prefix(':').map(|p| p.parse::<u16>()).transpose().map_err(|_| "the console URL's port does not read")?)
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p.parse::<u16>().map_err(|_| "the console URL's port does not read")?)),
            None => (hostport.to_owned(), None),
        }
    };
    Ok((host.to_ascii_lowercase(), port.unwrap_or(w::DEFAULT_PORT)))
}

/// `http://host:port` (3.6: an HTTP CONNECT proxy, no authentication).
pub fn parse_proxy(url: &str) -> Result<(String, u16), String> {
    let rest = url.trim().strip_prefix("http://").ok_or("the fleet proxy must be http://host:port")?;
    let hostport = rest.trim_end_matches('/');
    let (h, p) = hostport.rsplit_once(':').ok_or("the fleet proxy must be http://host:port")?;
    if h.is_empty() || h.contains('@') {
        return Err("the fleet proxy must be http://host:port".into());
    }
    Ok((h.trim_matches(|c| c == '[' || c == ']').to_owned(), p.parse().map_err(|_| "the fleet proxy's port does not read")?))
}

async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, Category> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| Category::Dns)?.collect();
    if addrs.is_empty() {
        return Err(Category::Dns);
    }
    for a in addrs {
        if let Ok(Ok(s)) = tokio::time::timeout(TCP_CONNECT, TcpStream::connect(a)).await {
            return Ok(s);
        }
    }
    Err(Category::Tcp)
}

/// An HTTP CONNECT tunnel; the pin and the client certificate keep the proxy from reading or changing the channel.
async fn connect_proxy(mut s: TcpStream, host: &str, port: u16) -> Result<TcpStream, Category> {
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    s.write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes()).await.map_err(|_| Category::Proxy)?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    let read = async {
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > 8192 || s.read(&mut byte).await.ok()? == 0 {
                return None;
            }
            head.push(byte[0]);
        }
        Some(())
    };
    tokio::time::timeout(TCP_CONNECT, read).await.ok().flatten().ok_or(Category::Proxy)?;
    let status = String::from_utf8_lossy(&head);
    let ok = status.split_whitespace().nth(1) == Some("200") && status.starts_with("HTTP/1.");
    if ok {
        Ok(s)
    } else {
        Err(Category::Proxy)
    }
}

type Tls = tokio_rustls::client::TlsStream<w::BoxIo>;

/// One TLS 1.3 connection to the console: DNS, TCP (or the proxy), the pinned handshake. Ok also gives the server
/// leaf and its CA as verified.
async fn dial(url: &str, proxy: Option<&str>, anchor: Anchor, t: i64, client: Option<(&[u8], &[u8])>) -> Result<(Tls, Vec<u8>, Vec<u8>), Category> {
    let (host, port) = parse_fleet_url(url).map_err(|_| Category::Dns)?;
    let tcp = match proxy {
        Some(p) => {
            let (ph, pp) = parse_proxy(p).map_err(|_| Category::Proxy)?;
            let s = connect_tcp(&ph, pp).await.map_err(|c| if c == Category::Dns { Category::Proxy } else { c })?;
            connect_proxy(s, &host, port).await?
        }
        None => connect_tcp(&host, port).await?,
    };
    let seen = Arc::new(Mutex::new(None));
    let verifier = Arc::new(PinnedServer { anchor, host: host.clone(), t, seen: seen.clone() });
    let cfg = client_config(verifier, client).map_err(|_| Category::TlsProtocol)?;
    let name = ServerName::try_from(host.clone()).map_err(|_| Category::Dns)?;
    let io: w::BoxIo = Box::new(tcp);
    let tls = match tokio::time::timeout(w::HANDSHAKE, tokio_rustls::TlsConnector::from(cfg).connect(name, io)).await {
        Err(_) => return Err(Category::Closed),
        Ok(Err(e)) => return Err(category_of(&e)),
        Ok(Ok(s)) => s,
    };
    let (leaf, ca) = seen.lock().take().ok_or(Category::ServerUntrusted)?;
    Ok((tls, leaf, ca))
}

/// HTTP/1.1 on one TLS connection (requests, then possibly the upgrade).
struct Http {
    sender: hyper::client::conn::http1::SendRequest<Full<Bytes>>,
    host: String,
}

impl Http {
    async fn over(tls: Tls, url: &str) -> Result<Http, Category> {
        let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| category_of(&e))?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let (host, port) = parse_fleet_url(url).map_err(|_| Category::Dns)?;
        Ok(Http { sender, host: if port == 443 { host } else { format!("{host}:{port}") } })
    }

    async fn call(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Category> {
        let data = body.map(stringify).unwrap_or_default();
        let mut b = Request::builder().method(method).uri(path).header(HOST, &self.host);
        if body.is_some() {
            b = b.header(CONTENT_TYPE, "application/json");
        }
        let req = b.body(Full::new(Bytes::from(data))).map_err(|_| Category::Closed)?;
        let resp = tokio::time::timeout(w::CALL_TIMEOUT, self.sender.send_request(req)).await.map_err(|_| Category::Closed)?.map_err(|e| category_of(&e))?;
        let status = resp.status().as_u16();
        let bytes = tokio::time::timeout(w::CALL_TIMEOUT, Limited::new(resp.into_body(), ANSWER_MAX).collect()).await.map_err(|_| Category::Closed)?.map_err(|_| Category::Closed)?.to_bytes();
        Ok((status, std::str::from_utf8(&bytes).ok().and_then(parse_json).unwrap_or(Value::Null)))
    }

    /// `GET /fleet/v1/channel` with `Upgrade: websocket` and `Sec-WebSocket-Protocol: lucid-fleet.v1` (3.6).
    async fn upgrade(mut self) -> Result<Wire, (Category, u16)> {
        let key = generate_key();
        let req = Request::builder()
            .method("GET")
            .uri(w::CHANNEL_PATH)
            .header(HOST, &self.host)
            .header(UPGRADE, "websocket")
            .header(CONNECTION, "Upgrade")
            .header(SEC_WEBSOCKET_KEY, &key)
            .header(SEC_WEBSOCKET_VERSION, "13")
            .header(SEC_WEBSOCKET_PROTOCOL, w::SUBPROTOCOL)
            .body(Full::new(Bytes::new()))
            .map_err(|_| (Category::Closed, 0))?;
        let resp = tokio::time::timeout(w::UPGRADE_WAIT, self.sender.send_request(req)).await.map_err(|_| (Category::Closed, 0))?.map_err(|e| (category_of(&e), 0))?;
        let status = resp.status().as_u16();
        let accept_ok = resp.headers().get(SEC_WEBSOCKET_ACCEPT).and_then(|v| v.to_str().ok()) == Some(derive_accept_key(key.as_bytes()).as_str());
        let proto_ok = resp.headers().get(SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()) == Some(w::SUBPROTOCOL);
        if status != 101 || !accept_ok || !proto_ok {
            return Err((Category::UpgradeRefused, status));
        }
        let upgraded = hyper::upgrade::on(resp).await.map_err(|e| (category_of(&e), status))?;
        let io: w::BoxIo = Box::new(TokioIo::new(upgraded));
        Ok(Wire::Ws(Box::new(WebSocketStream::from_raw_socket(io, WsRole::Client, Some(w::ws_config(Side::Relay))).await)))
    }
}

/// Run a future to completion from synchronous code, inside or outside a tokio runtime (a scoped thread with its
/// own runtime; the caller's thread waits).
pub fn run_blocking<F: Future + Send>(f: F) -> F::Output
where
    F::Output: Send,
{
    std::thread::scope(|s| {
        s.spawn(|| tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime").block_on(f)).join().expect("the blocking task ran")
    })
}

// ── Relay facts (3.3 `relay`) ───────────────────────────────────────────────────────────────────────────────

fn fips() -> bool {
    cfg!(feature = "fips") && crate::server::fips_check().is_ok()
}

fn os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

fn high(console: &Console) -> bool {
    console.high_profile()
}

fn local_console(console: &Console) -> bool {
    matches!(console.kind(), crate::console::ConsoleKind::Local(_)) && !console.is_headless()
}

/// The `relay` object of 3.3.
pub fn relay_value(console: &Console, product: Product, version: &str) -> Value {
    json!({
        "product": product.as_str(), "version": version, "fips": fips(), "profile": if high(console) { "high" } else { "standard" },
        "host": gethostname::gethostname().to_string_lossy().to_ascii_lowercase(), "os": os(), "localConsole": local_console(console),
    })
}

fn words_of(r: &Refusal) -> String {
    r.error.clone()
}

fn refusal_of(status: u16, body: &Value) -> Refusal {
    match (body.get("code").and_then(Value::as_str), body.get("error").and_then(Value::as_str)) {
        (Some(c), Some(e)) => Refusal { status, code: c.to_owned(), error: e.to_owned() },
        _ => Refusal::new(status, "closed", Category::Closed.words()),
    }
}

// ── Enrollment: preview and apply (3.3) ─────────────────────────────────────────────────────────────────────

/// Check a code before any network call: shape and product (13.3 `fleet-code`, `fleet-product`).
pub fn check_code(text: &str, product: Product) -> Result<Code, String> {
    // every shape error, an unknown product byte included, is `fleet-code` before any network call (3.1)
    let code = w::code_parse(text).map_err(|_| Refusal::of("fleet-code").error)?;
    if code.product != product {
        return Err(Refusal::filled("fleet-product", &[("product", code.product.name())]).error);
    }
    Ok(code)
}

async fn preview_async(url: &str, code: &Code, proxy: Option<&str>) -> Result<Value, String> {
    let (host, _) = parse_fleet_url(url)?;
    // A pin mismatch fails the handshake: nothing is sent.
    let (tls, _, _) = dial(url, proxy, Anchor::Code(code.pin), now_ms(), None).await.map_err(|c| if c == Category::ServerUntrusted { Refusal::of("fleet-pin").error } else { c.words().to_owned() })?;
    let mut http = Http::over(tls, url).await.map_err(|c| c.words().to_owned())?;
    let body = json!({ "v": 1, "id": code.id(), "mac": b64u(w::preview_mac(code.secret.expose(), &code.id(), &host).expose()) });
    let (status, answer) = http.call("POST", "/fleet/v1/enroll/preview", Some(&body)).await.map_err(|c| c.words().to_owned())?;
    if status != 200 {
        return Err(words_of(&refusal_of(status, &answer)));
    }
    let hash = w::preview_hash(&answer).map_err(|_| Refusal::of("fleet-op").error)?;
    if w::hash_of(answer.get("previewHash")) != Some(*hash.expose()) {
        return Err(Refusal::of("fleet-preview-changed").error);
    }
    let roster = answer.get("roster").and_then(Value::as_array).cloned().unwrap_or_default();
    if crate::fleet_trust::roster_duplicate(&roster) {
        return Err(Refusal::of("fleet-roster-duplicate").error);
    }
    Ok(answer)
}

/// The 3.3 preview as the CLI and the local console's Join show it (consumes nothing). Err holds the 13.3 words.
pub fn preview(url: &str, code: &str, product: Product) -> Result<Value, String> {
    let code = check_code(code, product)?;
    let proxy = std::env::var(PROXY_ENV).ok();
    run_blocking(preview_async(url, &code, proxy.as_deref()))
}

/// What the apply needs besides the code.
pub struct Apply<'a> {
    pub console: &'a Console,
    pub state_dir: &'a Path,
    pub product: Product,
    pub version: &'a str,
    pub url: &'a str,
    pub preview_hash: [u8; 32],
    pub admin_keys: &'a [String],
    pub confirmed_by: &'a str,
    pub proxy: Option<&'a str>,
}

/// The relay applies an enrollment itself (3.3 steps 2 to 4): the preview is fetched again and must hash to what
/// the operator confirmed; the key is drawn and sealed by this process; the answer's roster, policy and
/// bootstrapRosterHash must be the preview's; the certificate, its CA and the trust manifest are checked; then
/// `fleet.json` is written with every first-roster entry inactive. Err holds the words of 13.3 or 13.4.
pub async fn apply(a: Apply<'_>, code: &Code) -> Result<Value, String> {
    let wall = now_ms();
    let preview = preview_async(a.url, code, a.proxy).await?;
    let hash = *w::preview_hash(&preview).map_err(|_| Refusal::of("fleet-op").error)?.expose();
    if !w::same_bytes(&hash, &a.preview_hash) {
        return Err(Refusal::of("fleet-preview-changed").error);
    }
    if high(a.console) && preview["policy"]["profile"] != json!("high") {
        return Err(w::cli_words("cli.enroll-high-standard").to_owned());
    }
    let key = Key::generate(Curve::P256)?;
    let spki = key.spki();
    let relay = relay_value(a.console, a.product, a.version);
    let input = w::enroll_input(&code.id(), &hash, &spki, &relay)?;
    let body = json!({ "v": 1, "id": code.id(), "spki": b64u(&spki), "previewHash": hex(&hash), "relay": relay, "mac": b64u(w::enroll_mac(code.secret.expose(), &input).expose()), "sig": b64u(&key.sign(&input)?) });
    let (tls, leaf, ca_seen) = dial(a.url, a.proxy, Anchor::Code(code.pin), wall, None).await.map_err(|c| if c == Category::ServerUntrusted { Refusal::of("fleet-pin").error } else { c.words().to_owned() })?;
    let mut http = Http::over(tls, a.url).await.map_err(|c| c.words().to_owned())?;
    let (status, answer) = http.call("POST", "/fleet/v1/enroll", Some(&body)).await.map_err(|c| c.words().to_owned())?;
    if status != 200 {
        return Err(words_of(&refusal_of(status, &answer)));
    }
    let changed = || Refusal::of("fleet-preview-changed").error;
    for k in ["roster", "policy", "bootstrapRosterHash"] {
        if answer.get(k) != preview.get(k) {
            return Err(changed());
        }
    }
    let roster = answer["roster"].as_array().cloned().unwrap_or_default();
    if crate::fleet_trust::roster_duplicate(&roster) {
        return Err(Refusal::of("fleet-roster-duplicate").error);
    }
    let untrusted = || Category::ServerUntrusted.words().to_owned();
    let cert = w::b64u_of(answer.get("cert")).ok_or_else(untrusted)?;
    let ca_cert = w::b64u_of(answer.get("caCert")).ok_or_else(untrusted)?;
    if ca_cert != ca_seen || x509::pin_hex(&ca_cert).as_deref() != Some(code.pin_hex().as_str()) {
        return Err(Refusal::of("fleet-pin").error);
    }
    let (relay_id, _, issued) = x509::relay_leaf(&cert, &ca_cert, wall).map_err(|_| untrusted())?;
    if issued.spki != spki || answer.get("relayId").and_then(Value::as_str) != Some(relay_id.as_str()) {
        return Err(untrusted());
    }
    let manifest = answer.get("trust").cloned().unwrap_or(Value::Null);
    let generation = manifest.get("caGeneration").and_then(Value::as_u64).unwrap_or(1);
    let pins = vec![Pin { generation, pin: code.pin_hex(), state: "active".into(), ca_cert: Some(ca_cert.clone()) }];
    let leaf_hash = crate::meet_x509::Cert::from_der(&leaf).map(|c| hex(&sha256(&c.spki))).unwrap_or_default();
    let console_id = answer["console"]["id"].as_str().unwrap_or_default().to_owned();
    let stored = accept_manifest(&manifest, &pins, &|_| None, Some(&console_id), None, Mode::Refresh, wall, wall, Some(&leaf_hash)).map_err(|_| untrusted())?;
    let pins = apply_next_ca(&pins, &manifest);
    let link = json!({
        "v": 1,
        "consoleId": console_id,
        "origin": answer["console"]["origin"],
        "rpId": answer["console"]["rpId"],
        "fleetUrl": answer["fleetUrl"],
        "pins": pins_value(&pins, true),
        "trust": { "seq": stored.seq, "issuedAt": stored.issued_at, "manifest": manifest },
        "relayId": relay_id,
        "name": answer["name"],
        "site": answer["site"],
        "scopes": answer["scopes"],
        "scopeRequest": null,
        "recovery": null,
        "cert": b64u(&cert),
        "caCert": b64u(&ca_cert),
        "policy": answer["policy"],
        "policySeq": answer["policySeq"],
        "policyHash": answer["policyHash"],
        "bootstrap": { "state": "pending", "bootstrapRosterHash": answer["bootstrapRosterHash"], "via": "code", "adminKeys": a.admin_keys },
        "roster": roster.iter().map(|e| { let mut e = e.clone(); e["state"] = json!("inactive"); e }).collect::<Vec<_>>(),
        "rosterSeq": answer["rosterSeq"],
        "rosterHash": answer["rosterHash"],
        "enrolledAt": wall,
        "keyLost": false,
        "trustTimeMs": stored.issued_at,
        "fingerprint": x509::relay_fingerprint(&spki),
        "lastContactAt": null,
        "lastConnectFailure": null,
    });
    write_new_link(a.console, a.state_dir, &key, link.as_object().cloned().unwrap_or_default())?;
    let fingerprint = x509::relay_fingerprint(&spki);
    a.console.audit_relay("fleet.enrolled", &relay_id, json!({ "fingerprint": fingerprint, "bootstrapRosterHash": answer["bootstrapRosterHash"], "confirmedBy": a.confirmed_by }));
    Ok(json!({ "relayId": relay_id, "origin": answer["console"]["origin"], "fingerprint": fingerprint, "bootstrapRosterHash": answer["bootstrapRosterHash"] }))
}

/// Seal the key with its link label (A3-H1 revision 3.2) and write a new `fleet.json`.
fn write_new_link(vault: &dyn VaultLock, state_dir: &Path, key: &Key, map: Map<String, Value>) -> Result<(), String> {
    let label = canonical_json(&json!({ "consoleId": map.get("consoleId"), "relayId": map.get("relayId") }))?;
    vault_do(vault, |v| -> Result<(), String> {
        v.put(KEY, key.pkcs8())?;
        v.put(KEY_LINK, &label)
    })?;
    let _g = LINK_LOCK.lock();
    write_link_file(state_dir, &map)
}

fn link_label(link: &Link) -> Vec<u8> {
    canonical_json(&json!({ "consoleId": link.console_id(), "relayId": link.relay_id() })).unwrap_or_default()
}

/// Move a new key in: the current one becomes `fleet-key-old` until the first hello on the new certificate.
fn switch_keys(vault: &mut dyn Vault, new: &[u8], label: &[u8]) -> Result<(), String> {
    if let Some(cur) = vault.get(KEY) {
        vault.put(KEY_OLD, &cur)?;
    }
    vault.put(KEY, new)?;
    vault.put(KEY_LINK, label)?;
    let _ = vault.remove(KEY_NEXT);
    Ok(())
}

// ── The handoff file and the code (A1-M1) ───────────────────────────────────────────────────────────────────

#[cfg(unix)]
extern "C" {
    fn geteuid() -> u32;
}

#[cfg(windows)]
fn whoami() -> Option<String> {
    let out = std::process::Command::new("whoami").stdin(std::process::Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase())
}

/// The principals `icacls` lists for one file.
#[cfg_attr(not(windows), allow(dead_code))]
fn icacls_principals(text: &str, path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.strip_prefix(path).unwrap_or(line).trim();
        if let Some((who, _)) = line.split_once(":(") {
            out.push(who.trim().to_ascii_lowercase());
        }
    }
    out
}

/// Who may hold access to a private file besides its owner.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Others {
    /// Nobody (the handoff file: the relay's service identity alone).
    None,
    /// SYSTEM and the Administrators group (a code file the operator wrote: they always can).
    Admins,
}

/// Open a file no-follow and read it when it is a regular file owned by this process's identity with no access for
/// others; the checks of 5.7 (`--code-file`) and 3.3 (the handoff file). Err holds a short reason.
fn read_private(path: &Path, others: Others) -> Result<Vec<u8>, &'static str> {
    let before = std::fs::symlink_metadata(path).map_err(|_| "missing")?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err("not a regular file");
    }
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: a link swapped in is opened as itself, never followed.
        o.custom_flags(0x0020_0000);
    }
    let mut f = o.open(path).map_err(|_| "unreadable")?;
    let meta = f.metadata().map_err(|_| "unreadable")?;
    if !meta.is_file() {
        return Err("not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // the file opened is the file checked (no swap between the two looks)
        if meta.ino() != before.ino() || meta.dev() != before.dev() {
            return Err("replaced");
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        if meta.uid() != unsafe { geteuid() } || meta.mode() & 0o077 != 0 {
            return Err("wider permissions");
        }
        let _ = others;
    }
    #[cfg(windows)]
    {
        let me = whoami().ok_or("unreadable")?;
        let out = std::process::Command::new("icacls").arg(path).stdin(std::process::Stdio::null()).output().map_err(|_| "unreadable")?;
        let names = icacls_principals(&String::from_utf8_lossy(&out.stdout), &path.display().to_string());
        let allowed = |n: &str| n == me || (others == Others::Admins && (n == "nt authority\\system" || n == "builtin\\administrators" || n == "*s-1-5-32-544"));
        if names.is_empty() || !names.iter().all(|n| allowed(n)) {
            return Err("wider permissions");
        }
    }
    let mut data = Vec::new();
    f.read_to_end(&mut data).map_err(|_| "unreadable")?;
    Ok(data)
}

/// Write the handoff exclusively, readable only by the relay's service identity (the state folder's owner on Linux,
/// `NT SERVICE\LucidRelay` on Windows).
fn write_handoff(state_dir: &Path, content: &Value) -> Result<(), String> {
    let path = state_dir.join(HANDOFF_FILE);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&path).map_err(|e| format!("{HANDOFF_FILE} could not be created: {e}"))?;
    let data = stringify(content);
    let written = f.write_all(data.as_bytes()).and_then(|_| f.sync_all());
    drop(f);
    let owned = written.map_err(|e| e.to_string()).and_then(|_| hand_to_service(state_dir, &path));
    if let Err(e) = owned {
        crate::store::remove(&path);
        return Err(format!("{HANDOFF_FILE} could not be written: {e}"));
    }
    Ok(())
}

#[cfg(unix)]
fn hand_to_service(state_dir: &Path, path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let dir = std::fs::metadata(state_dir).map_err(|e| e.to_string())?;
    let me = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if dir.uid() != me.uid() {
        std::os::unix::fs::chown(path, Some(dir.uid()), Some(dir.gid())).map_err(|e| format!("it cannot be given to the relay's user ({e}); run this as root or as that user"))?;
    }
    Ok(())
}

/// The identity the handoff file is given to: the relay's service account; in tests the current user, so the same
/// grant, removal and check run on a machine without the service.
#[cfg(windows)]
fn relay_service_account() -> String {
    #[cfg(test)]
    {
        whoami().unwrap_or_default()
    }
    #[cfg(not(test))]
    {
        crate::console_seal::SealIdentity::Relay.service_account().to_owned()
    }
}

#[cfg(windows)]
fn hand_to_service(_state_dir: &Path, path: &Path) -> Result<(), String> {
    let account = relay_service_account();
    let account = account.as_str();
    let out = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").arg("/grant:r").arg(format!("{account}:(F)")).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("its access could not be limited to the relay's service".into());
    }
    // the service alone: remove the creator's own entry
    let me = whoami().unwrap_or_default();
    if !me.is_empty() && !me.eq_ignore_ascii_case(account) {
        let _ = std::process::Command::new("icacls").arg(path).arg("/remove:g").arg(&me).stdin(std::process::Stdio::null()).output();
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn hand_to_service(_state_dir: &Path, _path: &Path) -> Result<(), String> {
    Err("not supported on this system".into())
}

/// What the relay read from the handoff file. The code is held redacted from the moment it is read.
#[derive(Debug)]
pub struct Handoff {
    pub url: String,
    pub code: Redacted<String>,
    pub preview_hash: Redacted<[u8; 32]>,
    pub confirmed_by: String,
    pub admin_keys: Vec<String>,
}

/// Take the handoff (3.3): deleted before anything else on every path; one older than an hour is deleted unread.
pub fn take_handoff(state_dir: &Path) -> Result<Option<Handoff>, String> {
    let path = state_dir.join(HANDOFF_FILE);
    let Ok(meta) = std::fs::symlink_metadata(&path) else { return Ok(None) };
    let old = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age > HANDOFF_MAX_AGE);
    if old {
        crate::store::remove(&path);
        return Err("the enrollment was saved more than an hour ago; run enroll again".into());
    }
    let data = read_private(&path, Others::None);
    crate::store::remove(&path);
    let data = data.map_err(|why| format!("{HANDOFF_FILE} was refused ({why})"))?;
    let bad = || format!("{HANDOFF_FILE} does not read");
    let v = std::str::from_utf8(&data).ok().and_then(parse_json).ok_or_else(bad)?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let at = v.get("at").and_then(Value::as_i64).ok_or_else(bad)?;
    if now_ms() - at > HANDOFF_MAX_AGE.as_millis() as i64 {
        return Err("the enrollment was saved more than an hour ago; run enroll again".into());
    }
    Ok(Some(Handoff {
        url: s("url").ok_or_else(bad)?,
        code: Redacted::new(s("code").ok_or_else(bad)?),
        preview_hash: Redacted::new(w::hash_of(v.get("previewHash")).ok_or_else(bad)?),
        confirmed_by: s("confirmedBy").ok_or_else(bad)?,
        admin_keys: v.get("adminKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),
    }))
}

/// The terminal the code prompt uses (a seam for tests).
pub trait Term {
    fn is_terminal(&self) -> bool;
    /// Turn echo on or off; false when it could not be changed.
    fn set_echo(&mut self, on: bool) -> bool;
    fn read_line(&mut self) -> Option<String>;
    fn write(&mut self, s: &str);
}

pub struct RealTerm;

#[cfg(windows)]
mod console_mode {
    use std::ffi::c_void;
    const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    const ENABLE_ECHO_INPUT: u32 = 0x0004;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n: u32) -> *mut c_void;
        fn GetConsoleMode(h: *mut c_void, mode: *mut u32) -> i32;
        fn SetConsoleMode(h: *mut c_void, mode: u32) -> i32;
    }
    pub fn set_echo(on: bool) -> bool {
        // SAFETY: the standard input handle of this process, and a mode word on the stack.
        unsafe {
            let h = GetStdHandle(STD_INPUT_HANDLE);
            let mut mode = 0u32;
            if GetConsoleMode(h, &mut mode) == 0 {
                return false;
            }
            let next = if on { mode | ENABLE_ECHO_INPUT } else { mode & !ENABLE_ECHO_INPUT };
            SetConsoleMode(h, next) != 0
        }
    }
}

impl Term for RealTerm {
    fn is_terminal(&self) -> bool {
        use std::io::IsTerminal;
        std::io::stdin().is_terminal()
    }
    fn set_echo(&mut self, on: bool) -> bool {
        #[cfg(windows)]
        {
            console_mode::set_echo(on)
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("stty").arg(if on { "echo" } else { "-echo" }).stdin(std::process::Stdio::inherit()).status().is_ok_and(|s| s.success())
        }
    }
    fn read_line(&mut self) -> Option<String> {
        let mut s = String::new();
        std::io::stdin().lock().read_line(&mut s).ok().filter(|n| *n > 0)?;
        Some(s.trim_end_matches(['\r', '\n']).to_owned())
    }
    fn write(&mut self, s: &str) {
        let mut e = std::io::stderr();
        let _ = e.write_all(s.as_bytes());
        let _ = e.flush();
    }
}

/// Where the code comes from (5.7). There is no argument or environment form: the parser has none.
#[derive(Debug, PartialEq, Eq)]
pub enum CodeFrom {
    Prompt,
    File(PathBuf),
    #[cfg_attr(not(unix), allow(dead_code))]
    Fd(i32),
}

/// `enroll <console URL> [--code-file <path> | --code-fd <n>] [--fleet-admin-key <fingerprint>]... [--yes]`
/// (`--state`, `--config` and their values are the state selector main.rs already read).
#[derive(Debug, PartialEq, Eq)]
pub struct EnrollArgs {
    pub url: String,
    pub code: CodeFrom,
    pub admin_keys: Vec<String>,
    pub yes: bool,
}

pub const ENROLL_USAGE: &str = "usage: lucid-relay enroll <console URL> [--code-file <path> | --code-fd <n>] [--fleet-admin-key <fingerprint>]... [--yes] (the code is asked for, never given on the command line)";

pub fn parse_enroll_args(args: &[String]) -> Result<EnrollArgs, String> {
    let (mut url, mut code, mut keys, mut yes) = (None, CodeFrom::Prompt, Vec::new(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "enroll" if url.is_none() && keys.is_empty() => {}
            "--state" | "--config" => {
                it.next().ok_or(ENROLL_USAGE)?;
            }
            "--code-file" => {
                if code != CodeFrom::Prompt {
                    return Err(ENROLL_USAGE.into());
                }
                code = CodeFrom::File(PathBuf::from(it.next().ok_or(ENROLL_USAGE)?));
            }
            "--code-fd" => {
                if code != CodeFrom::Prompt {
                    return Err(ENROLL_USAGE.into());
                }
                code = CodeFrom::Fd(it.next().and_then(|n| n.parse().ok()).filter(|n: &i32| *n >= 0).ok_or(ENROLL_USAGE)?);
            }
            "--fleet-admin-key" => {
                let fp = it.next().ok_or(ENROLL_USAGE)?.to_ascii_lowercase();
                if fp.len() != 64 || !fp.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("an admin key fingerprint is 64 hex characters".into());
                }
                keys.push(fp);
            }
            "--yes" => yes = true,
            s if !s.starts_with('-') && url.is_none() => url = Some(s.to_owned()),
            // anything else (a second positional value included) is refused: no code can be passed on argv
            _ => return Err(ENROLL_USAGE.into()),
        }
    }
    let url = url.ok_or(ENROLL_USAGE)?;
    parse_fleet_url(&url)?;
    Ok(EnrollArgs { url, code, admin_keys: keys, yes })
}

/// Read the code (5.7): the no-echo prompt on a terminal, else one line of stdin; or the code file (checked, then
/// deleted); or the descriptor.
pub fn read_code(from: &CodeFrom, term: &mut dyn Term) -> Result<Redacted<String>, String> {
    let line = match from {
        CodeFrom::Prompt => {
            if term.is_terminal() {
                term.write(w::cli_words("cli.enroll-ask-code"));
                let off = term.set_echo(false);
                let line = term.read_line();
                if off {
                    term.set_echo(true);
                }
                term.write("\n");
                line
            } else {
                term.read_line()
            }
        }
        CodeFrom::File(p) => {
            let data = read_private(p, Others::Admins).map_err(|_| w::cli_words("cli.code-file").to_owned());
            if data.is_ok() {
                crate::store::remove(p);
            }
            let data = data?;
            String::from_utf8(data).ok().map(|s| s.lines().next().unwrap_or_default().to_owned())
        }
        CodeFrom::Fd(n) => read_fd(*n),
    };
    line.map(Redacted::new).ok_or_else(|| Refusal::of("fleet-code").error)
}

#[cfg(unix)]
fn read_fd(n: i32) -> Option<String> {
    use std::os::unix::io::FromRawFd;
    // SAFETY: the caller opened this descriptor for us (--code-fd); it is read once and closed with the File.
    let f = unsafe { std::fs::File::from_raw_fd(n) };
    let mut s = String::new();
    std::io::BufReader::new(f).read_line(&mut s).ok()?;
    Some(s.trim_end_matches(['\r', '\n']).to_owned())
}

#[cfg(not(unix))]
fn read_fd(_n: i32) -> Option<String> {
    None
}

/// The preview as the CLI prints it (13.4 `cli.enroll-preview`).
pub fn preview_text(p: &Value) -> String {
    let entries: Vec<String> = p["roster"].as_array().map(|a| {
        a.iter().map(|e| {
            let hint = w::b64u_of(e.get("credentialId")).map(|id| hex(&sha256(&id))[..16].to_owned()).unwrap_or_default();
            let ev = if e.get("evidence").is_some_and(|x| x.is_object()) { "with security key evidence the relay checks itself" } else { "no security key evidence" };
            format!("{}, {}, key {hint}, {ev}", e["email"].as_str().unwrap_or_default(), e["role"].as_str().unwrap_or_default())
        }).collect()
    }).unwrap_or_default();
    let product = w::product_of(p["enrollment"]["product"].as_str().unwrap_or_default()).map(|x| x.name()).unwrap_or_default();
    let scopes: Vec<&str> = p["enrollment"]["scopes"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let words = w::cli_words("cli.enroll-preview").replace("<one line per entry: email, role, key hint, verified as a security key or not>", &entries.join("\n"));
    w::fill(&words, &[
        ("origin", p["console"]["origin"].as_str().unwrap_or_default()),
        ("name", p["enrollment"]["name"].as_str().unwrap_or_default()),
        ("site", p["enrollment"]["site"].as_str().unwrap_or_default()),
        ("product", product),
        ("scopes", &scopes.join(", ")),
        ("profile", p["policy"]["profile"].as_str().unwrap_or_default()),
        ("on or off", p["policy"]["twoPerson"].as_str().unwrap_or_default()),
    ])
}

/// `lucid-relay enroll` and `lucid-relay meet enroll` (5.7): read the code, check it, preview, ask, and write the
/// service-only handoff file. Ok holds the words to print.
pub fn enroll_cli(product: Product, state_dir: &Path, args: &[String]) -> Result<String, String> {
    let a = parse_enroll_args(args)?;
    if !state_dir.is_dir() {
        return Err(w::cli_words("cli.fleet-state-needed").to_owned());
    }
    let failed = |why: String| w::fill(w::cli_words("cli.enroll-failed"), &[("why", &why)]);
    let mut term = RealTerm;
    let code_text = read_code(&a.code, &mut term).map_err(failed)?;
    let code = check_code(code_text.expose(), product).map_err(failed)?;
    let proxy = std::env::var(PROXY_ENV).ok();
    let p = run_blocking(preview_async(&a.url, &code, proxy.as_deref())).map_err(failed)?;
    println!("{}", preview_text(&p));
    if !a.yes {
        term.write(w::cli_words("cli.enroll-ask"));
        if term.read_line().map(|l| l.trim().to_ascii_lowercase()) != Some("yes".into()) {
            return Err(failed("not confirmed".into()));
        }
    }
    let content = json!({ "url": a.url, "code": code_text.expose(), "previewHash": p["previewHash"], "confirmedBy": if a.yes { "flag" } else { "prompt" }, "adminKeys": a.admin_keys, "at": now_ms() });
    write_handoff(state_dir, &content).map_err(failed)?;
    Ok(w::cli_words("cli.enroll-next").to_owned())
}

/// The local console's Join (5.7): applied in this process (the code never touches the disk), then the running
/// agent is woken so the channel opens.
pub fn join_local(console: &Console, state_dir: &Path, url: &str, code: &str, preview_hash: &str, admin_keys: &[String], product: Product) -> Result<(), String> {
    let code = check_code(code, product)?;
    let ph = w::hash_of(Some(&json!(preview_hash))).ok_or_else(|| Refusal::of("fleet-preview-changed").error)?;
    if load_link_json(state_dir)?.is_some_and(|m| Link { map: m }.usable()) {
        return Err("This relay is already managed by a Lucid Admin Console. Leave it first.".into());
    }
    let proxy = std::env::var(PROXY_ENV).ok();
    let version = env!("CARGO_PKG_VERSION");
    let a = Apply { console, state_dir, product, version, url, preview_hash: ph, admin_keys, confirmed_by: "local-console", proxy: proxy.as_deref() };
    run_blocking(apply(a, &code))?;
    wake(state_dir);
    Ok(())
}

// ── trust-ca and trusted time commands (F17, F21) ───────────────────────────────────────────────────────────

/// `fleet trust-ca <fingerprint>` (3.11), consumed by f-trust's one-shot: the matching pending generation becomes
/// active. Err when none matches (f-trust answers `fingerprint`).
pub fn trust_ca(state_dir: &Path, generation: u64, fingerprint: &str) -> Result<(), String> {
    update_link(state_dir, |m| {
        let pins = confirm_pin(&pins_of(m.get("pins")), Some(generation), fingerprint).map_err(|_| "no pending CA generation has that fingerprint".to_owned())?;
        m.insert("pins".into(), pins_value(&pins, true));
        Ok(())
    })?;
    wake(state_dir);
    Ok(())
}

/// `trustTimeMs` as stored.
pub fn trust_time_ms(state_dir: &Path) -> Option<i64> {
    load_link_json(state_dir).ok().flatten().and_then(|m| m.get("trustTimeMs").and_then(Value::as_i64))
}

/// `fleet trust-time reset`, step 1 (3.10 revision 3.2): a fresh manifest over a pinned TLS connection, accepted
/// only from an active pinned CA with a seq higher than the stored one, dated within 10 minutes of wall time, and
/// listing the server leaf of that connection, not revoked.
pub fn trust_time_fetch(state_dir: &Path, _product: Product) -> Result<Value, String> {
    let link = load_link_json(state_dir)?.map(|map| Link { map }).filter(Link::usable).ok_or_else(|| Refusal::of("trust-time-refused").error)?;
    let proxy = std::env::var(PROXY_ENV).ok();
    let refused = || Refusal::of("trust-time-refused").error;
    run_blocking(async {
        let wall = now_ms();
        let pins = link.pins();
        let cas: Vec<Vec<u8>> = pins.iter().filter(|p| p.active()).filter_map(|p| p.ca_cert.clone()).collect();
        // The leaf is judged by the new manifest, at wall time for its dates (T may be stuck ahead).
        let (tls, leaf, _) = dial(link.fleet_url(), proxy.as_deref(), Anchor::Pinned(cas), wall, None).await.map_err(|_| refused())?;
        let mut http = Http::over(tls, link.fleet_url()).await.map_err(|_| refused())?;
        let (status, m) = http.call("GET", "/fleet/v1/trust", None).await.map_err(|_| refused())?;
        if status != 200 {
            return Err(refused());
        }
        let leaf_hash = crate::meet_x509::Cert::from_der(&leaf).map(|c| hex(&sha256(&c.spki))).unwrap_or_default();
        accept_manifest(&m, &pins, &|_| None, Some(link.console_id()), link.stored().as_ref(), Mode::Reset, wall, wall, Some(&leaf_hash)).map_err(|_| refused())?;
        Ok(m)
    })
}

/// `fleet trust-time reset`, step 2: the same checks again (without the connection's leaf), then one write replaces
/// the stored manifest and sets `T` to its `issuedAt`. Ok(Some((from, to, manifestSeq))) when it changed anything,
/// Ok(None) when `T` already came from that manifest (a rerun changes nothing).
pub fn trust_time_apply(state_dir: &Path, manifest: &Value, t: i64) -> Result<Option<(i64, i64, u64)>, String> {
    let refused = || Refusal::of("trust-time-refused").error;
    let mut out = None;
    update_link(state_dir, |m| {
        let link = Link { map: m.clone() };
        let this = Stored::of(manifest).ok_or_else(refused)?;
        if link.stored().as_ref() == Some(&this) && link.trust_time() == Some(this.issued_at) {
            return Ok(());
        }
        accept_manifest(manifest, &link.pins(), &|_| None, Some(link.console_id()), link.stored().as_ref(), Mode::Reset, t, t, None).map_err(|_| refused())?;
        let from = agent_for(state_dir).map(|a| a.clock.lock().now()).or(link.trust_time()).unwrap_or(0);
        m.insert("trust".into(), json!({ "seq": this.seq, "issuedAt": this.issued_at, "manifest": manifest }));
        m.insert("trustTimeMs".into(), json!(this.issued_at));
        out = Some((from, this.issued_at, this.seq));
        Ok(())
    })?;
    if let Some((_, to, _)) = out {
        if let Some(a) = agent_for(state_dir) {
            a.clock.lock().set(to);
            a.refresh.store(false, Ordering::SeqCst);
        }
        wake(state_dir);
    }
    Ok(out)
}

// ── Same-process all-in-one (2.2) ───────────────────────────────────────────────────────────────────────────

/// Standard all-in-one (2.2): at the first start, the in-process relay enrolls in the in-process console without a
/// code (`fleet_port::start` ran first), sealing its key in its own state folder; later starts find the link. The
/// relay's agent then runs the same channel code over `fleet_wire::Local`.
pub fn same_process(console: Arc<Console>, relay_state: &Path, product: Product, logger: Arc<Logger>) -> Result<(), String> {
    if load_link_json(relay_state)?.is_some_and(|m| Link { map: m }.usable()) {
        return Ok(());
    }
    if console.high_profile() {
        return Err(w::cli_words("cli.with-console-high").to_owned());
    }
    let port = crate::fleet_port::global().ok_or("the console's management state is not running in this process")?;
    let env = |k: &str| std::env::var(k).ok();
    let mut seal = crate::console_seal::Seal::open(relay_state, &env, false)?;
    let key = Key::generate(Curve::P256)?;
    let relay = json!({ "product": product.as_str(), "version": env!("CARGO_PKG_VERSION"), "fips": fips(), "profile": "standard", "host": gethostname::gethostname().to_string_lossy().to_ascii_lowercase(), "os": os(), "localConsole": false });
    let t = now_ms();
    let answer = port.enroll_same_process(&key.spki(), &relay, t).map_err(|r| r.error)?;
    let manifest = answer.get("trust").cloned().unwrap_or(Value::Null);
    let ca_cert = w::b64u_of(answer.get("caCert")).ok_or("the console did not answer with its CA")?;
    let pins = vec![Pin { generation: manifest.get("caGeneration").and_then(Value::as_u64).unwrap_or(1), pin: x509::pin_hex(&ca_cert).unwrap_or_default(), state: "active".into(), ca_cert: Some(ca_cert.clone()) }];
    // f-trust completes a same-process bootstrap without anchors (2.2); the entries start inactive like any other.
    let roster: Vec<Value> = answer["roster"].as_array().cloned().unwrap_or_default().into_iter().map(|mut e| {
        e["state"] = json!("inactive");
        e
    }).collect();
    let link = json!({
        "v": 1, "consoleId": answer["console"]["id"], "origin": answer["console"]["origin"], "rpId": answer["console"]["rpId"], "fleetUrl": SAME_PROCESS,
        "pins": pins_value(&pins, true), "trust": { "seq": manifest["seq"], "issuedAt": manifest["issuedAt"], "manifest": manifest },
        "relayId": answer["relayId"], "name": answer["name"], "site": answer["site"], "scopes": answer["scopes"], "scopeRequest": null, "recovery": null,
        "cert": answer["cert"], "caCert": answer["caCert"], "policy": answer["policy"], "policySeq": answer["policySeq"], "policyHash": answer["policyHash"],
        "bootstrap": { "state": "pending", "bootstrapRosterHash": answer["bootstrapRosterHash"], "via": SAME_PROCESS },
        "roster": roster, "rosterSeq": answer["rosterSeq"], "rosterHash": answer["rosterHash"], "enrolledAt": t, "keyLost": false,
        "trustTimeMs": manifest["issuedAt"], "fingerprint": x509::relay_fingerprint(&key.spki()), "lastContactAt": null, "lastConnectFailure": null,
    });
    let map = link.as_object().cloned().unwrap_or_default();
    let label = canonical_json(&json!({ "consoleId": map.get("consoleId"), "relayId": map.get("relayId") }))?;
    Vault::put(&mut seal, KEY, key.pkcs8())?;
    Vault::put(&mut seal, KEY_LINK, &label)?;
    {
        let _g = LINK_LOCK.lock();
        write_link_file(relay_state, &map)?;
    }
    logger.ops("fleet.enrolled", &Fields::new().with("via", SAME_PROCESS).with("relay", answer["relayId"].as_str().unwrap_or_default()), Level::Info);
    Ok(())
}

// ── The agent ───────────────────────────────────────────────────────────────────────────────────────────────

pub struct AgentConfig {
    pub product: Product,
    pub state_dir: PathBuf,
    pub link: Option<Link>,
    /// The relay's console (its local one, or the headless one).
    pub console: Arc<Console>,
    pub logger: Arc<Logger>,
    /// Meeting Hub `relay.json` `fleet_proxy`; `LUCID_RELAY_FLEET_PROXY` otherwise.
    pub proxy: Option<String>,
    pub version: String,
}

pub struct Agent {
    product: Product,
    dir: PathBuf,
    console: Arc<Console>,
    logger: Arc<Logger>,
    proxy: Option<String>,
    version: String,
    events: Events,
    events_rx: Mutex<Option<mpsc::Receiver<(String, Value)>>>,
    frames: Mutex<Option<(String, Arc<dyn RelayFrames>)>>,
    managed: RwLock<Option<String>>,
    wake: Notify,
    pub clock: Mutex<TrustClock>,
    /// The stored manifest counts as expired: at every start and while wall time is behind T (3.10).
    refresh: AtomicBool,
    last_logged: Mutex<HashMap<Category, i64>>,
    last_renew: Mutex<i64>,
    req_id: AtomicU32,
}

static AGENTS: LazyLock<Mutex<HashMap<PathBuf, Weak<Agent>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn agent_for(dir: &Path) -> Option<Arc<Agent>> {
    AGENTS.lock().get(dir).and_then(Weak::upgrade)
}

/// Wake the agent of a state folder (a local Join, trust-ca, a reset).
pub fn wake(dir: &Path) {
    if let Some(a) = agent_for(dir) {
        a.wake.notify_one();
    }
}

/// What ended one connection attempt.
enum End {
    /// Connected and later closed (with how long it lasted).
    Closed(Duration),
    /// Could not connect.
    Failed(Category),
    /// Nothing to do until something changes (no link, no pins, removed, left).
    Idle,
    /// Try again at once (a new certificate).
    Again,
}

/// F13/F7 entry (f-relay): start the agent. It applies a waiting handoff, then dials while a usable link exists;
/// with neither it opens and writes nothing and waits to be woken (invariant 22).
pub fn start(cfg: AgentConfig) -> Result<Arc<Agent>, String> {
    let (events, rx) = Events::channel();
    let mark = cfg.link.as_ref().and_then(Link::trust_time).unwrap_or(0);
    let proxy = cfg.proxy.clone().or_else(|| std::env::var(PROXY_ENV).ok()).filter(|p| !p.is_empty());
    let agent = Arc::new(Agent {
        product: cfg.product,
        dir: cfg.state_dir.clone(),
        console: cfg.console,
        logger: cfg.logger,
        proxy,
        version: cfg.version,
        events,
        events_rx: Mutex::new(Some(rx)),
        frames: Mutex::new(None),
        managed: RwLock::new(cfg.link.as_ref().filter(|l| l.usable()).map(|l| l.origin().to_owned())),
        wake: Notify::new(),
        clock: Mutex::new(TrustClock::new(mark)),
        refresh: AtomicBool::new(true),
        last_logged: Mutex::new(HashMap::new()),
        last_renew: Mutex::new(i64::MIN / 2),
        req_id: AtomicU32::new(1),
    });
    AGENTS.lock().insert(cfg.state_dir, Arc::downgrade(&agent));
    let run = agent.clone();
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn(async move { run.run().await });
        }
        Err(_) => {
            std::thread::Builder::new()
                .name("fleet-agent".into())
                .spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
                        rt.block_on(run.run());
                    }
                })
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(agent)
}

impl Agent {
    /// The console origin while the relay is managed (F13 `where`); None after leave, `bye` or a lost key.
    pub fn managed_by(&self) -> Option<String> {
        self.managed.read().clone()
    }

    fn link(&self) -> Option<Link> {
        match load_link_json(&self.dir) {
            Ok(Some(map)) => Some(Link { map }),
            Ok(None) => None,
            Err(_) => {
                self.logger.security("fleet.state-unreadable", &Fields::new(), Level::Error);
                None
            }
        }
    }

    fn frames_for(&self, relay_id: &str) -> Arc<dyn RelayFrames> {
        let mut f = self.frames.lock();
        if let Some((id, fr)) = f.as_ref() {
            if id == relay_id {
                return fr.clone();
            }
        }
        let fr = crate::fleet_exec::frames(self.console.clone(), self.dir.clone(), self.product, self.events.clone());
        *f = Some((relay_id.to_owned(), fr.clone()));
        fr
    }

    fn connect_failed(&self, c: Category) {
        let t = now_ms();
        let first = {
            let mut l = self.last_logged.lock();
            let due = l.get(&c).is_none_or(|at| t - at >= HOUR);
            if due {
                l.insert(c, t);
            }
            due
        };
        if first {
            self.logger.security("fleet.connect-failed", &Fields::new().with("category", c.as_str()), Level::Warn);
        }
        let _ = update_link(&self.dir, |m| {
            m.insert("lastConnectFailure".into(), json!({ "category": c.as_str(), "at": t }));
            Ok(())
        });
    }

    async fn idle(&self) {
        // drop what f-trust queued while there is no channel (`bye` is sent only on a live channel)
        if let Some(rx) = self.events_rx.lock().as_mut() {
            while rx.try_recv().is_ok() {}
        }
        let _ = tokio::time::timeout(Duration::from_secs(60), self.wake.notified()).await;
    }

    async fn run(self: Arc<Self>) {
        let mut backoff = w::Backoff::default();
        loop {
            if has_handoff(&self.dir) && !self.link().is_some_and(|l| l.usable()) {
                self.apply_handoff().await;
            }
            let end = self.clone().once().await;
            match end {
                End::Idle => self.idle().await,
                End::Again => backoff.reset(),
                End::Closed(lasted) => {
                    if lasted >= w::BACKOFF_RESET_AFTER {
                        backoff.reset();
                    }
                    let _ = tokio::time::timeout(backoff.next(), self.wake.notified()).await;
                }
                End::Failed(c) => {
                    self.connect_failed(c);
                    let _ = tokio::time::timeout(backoff.next(), self.wake.notified()).await;
                }
            }
        }
    }

    async fn apply_handoff(&self) {
        let failed = |why: &str| {
            self.logger.ops("fleet.enroll-failed", &Fields::new().with("why", why), Level::Error);
        };
        let h = match take_handoff(&self.dir) {
            Ok(Some(h)) => h,
            Ok(None) => return,
            Err(why) => return failed(&why),
        };
        let code = match check_code(h.code.expose(), self.product) {
            Ok(c) => c,
            Err(why) => return failed(&why),
        };
        let a = Apply { console: &self.console, state_dir: &self.dir, product: self.product, version: &self.version, url: &h.url, preview_hash: *h.preview_hash.expose(), admin_keys: &h.admin_keys, confirmed_by: &h.confirmed_by, proxy: self.proxy.as_deref() };
        match apply(a, &code).await {
            Ok(done) => {
                let fp = done["fingerprint"].as_str().unwrap_or_default().to_owned();
                self.logger.ops("fleet.enrolled", &Fields::new().with("fingerprint", fp.as_str()).with("bootstrapRosterHash", done["bootstrapRosterHash"].as_str().unwrap_or_default()), Level::Info);
                println!("{}", w::fill(w::cli_words("cli.enrolled"), &[("origin", done["origin"].as_str().unwrap_or_default()), ("relayId", done["relayId"].as_str().unwrap_or_default()), ("fingerprint", &fp)]));
                println!("{}", w::cli_words("cli.bootstrap-wait"));
                if let Some(l) = self.link() {
                    self.clock.lock().set(l.trust_time().unwrap_or(0));
                    self.refresh.store(false, Ordering::SeqCst);
                }
            }
            Err(why) => failed(&why),
        }
    }

    fn key(&self) -> Option<Key> {
        vault_do(&*self.console, |v| v.get(KEY)).and_then(|k| Key::from_pkcs8(Curve::P256, &k).ok())
    }

    fn key_lost(&self) {
        self.logger.security("fleet.key-lost", &Fields::new(), Level::Error);
        let _ = update_link(&self.dir, |m| {
            m.insert("keyLost".into(), json!(true));
            Ok(())
        });
        self.console.audit_relay("fleet.key-lost", "", Value::Null);
        *self.managed.write() = None;
    }

    /// Check the clock gap (3.10, 3.2): behind forces a refresh; ahead is only reported; both are logged once per change.
    fn check_clock(&self) -> i64 {
        let wall = now_ms();
        let (t, before, gap) = {
            let mut c = self.clock.lock();
            let t = c.now();
            let gap = gap_of(t, wall);
            let before = c.gap;
            c.gap = gap;
            (t, before, gap)
        };
        let kind = |g: Gap| std::mem::discriminant(&g);
        if kind(before) != kind(gap) {
            match gap {
                Gap::Ahead(ms) => self.trust_time_event(json!({ "aheadMs": ms })),
                Gap::Behind(ms) => self.trust_time_event(json!({ "behindMs": ms })),
                Gap::Agree => self.trust_time_event(json!({ "cleared": true, "via": "clocks" })),
            }
        }
        if matches!(gap, Gap::Behind(_)) {
            self.refresh.store(true, Ordering::SeqCst);
        }
        t
    }

    fn trust_time_event(&self, detail: Value) {
        self.logger.security("fleet.trust-time", &Fields::new().with("detail", detail.clone()), Level::Warn);
        self.console.audit_relay("fleet.trust-time", "", detail);
    }

    fn persist_clock(&self, relay_id: &str) {
        let t = self.clock.lock().now();
        let _ = update_link(&self.dir, |m| {
            if m.get("relayId").and_then(Value::as_str) == Some(relay_id) {
                m.insert("trustTimeMs".into(), json!(t));
            }
            Ok(())
        });
    }

    /// Store an accepted manifest and its `nextCa`; T = max(T, issuedAt).
    fn store_manifest(&self, m: &Value, s: &Stored) {
        let _ = update_link(&self.dir, |map| {
            let pins = apply_next_ca(&pins_of(map.get("pins")), m);
            map.insert("pins".into(), pins_value(&pins, true));
            map.insert("trust".into(), json!({ "seq": s.seq, "issuedAt": s.issued_at, "manifest": m }));
            Ok(())
        });
        self.clock.lock().adopt(s.issued_at);
        self.console.audit_relay("fleet.trust", "", json!({ "seq": s.seq, "from": "console" }));
    }

    fn manifest_refused(&self, why: &str) {
        if why.starts_with("rollback") || why == "same-seq-different-bytes" {
            self.logger.security("fleet.trust-rollback", &Fields::new().with("why", why), Level::Error);
            self.console.audit_relay("fleet.trust-rollback", "", json!({ "why": why }));
        } else {
            self.logger.security("fleet.trust-refused", &Fields::new().with("why", why), Level::Warn);
        }
    }

    /// One connection attempt and, when it opens, the channel until it closes.
    async fn once(self: Arc<Self>) -> End {
        let Some(link) = self.link() else {
            *self.managed.write() = None;
            return End::Idle;
        };
        if !link.usable() {
            *self.managed.write() = None;
            return End::Idle;
        }
        let Some(key) = self.key() else {
            self.key_lost();
            return End::Idle;
        };
        *self.managed.write() = Some(link.origin().to_owned());
        crate::fleet_probe::counters().set_mgmt_not_after(link.cert().and_then(|c| crate::meet_x509::Cert::from_der(&c)).map(|c| c.not_after * 1000));
        if link.fleet_url() == SAME_PROCESS {
            let (console_end, relay_end) = w::local_pair();
            if crate::fleet_port::attach_local(console_end, &link.cert().unwrap_or_default()).is_err() {
                return End::Failed(Category::Closed);
            }
            return self.session(Wire::Local(relay_end), &link, &key, None).await;
        }
        let pins = link.pins();
        let cas: Vec<Vec<u8>> = pins.iter().filter(|p| p.active()).filter_map(|p| p.ca_cert.clone()).collect();
        if cas.is_empty() {
            // read only and silent until a confirmed pin exists (3.11)
            self.logger.security("fleet.connect-failed", &Fields::new().with("category", Category::ServerUntrusted.as_str()), Level::Warn);
            return End::Idle;
        }
        let t = self.check_clock();
        let wall = now_ms();
        let mut stored = link.stored();
        // At every start and while wall time is behind T: the stored manifest counts as expired; refresh first over a
        // connection that sends nothing but `GET /fleet/v1/trust`.
        if self.refresh.load(Ordering::SeqCst) {
            let fresh = async {
                // the leaf's dates at R = max(T, wall) like the manifest (revision 3.3)
                let (tls, leaf, _) = dial(link.fleet_url(), self.proxy.as_deref(), Anchor::Pinned(cas.clone()), t.max(wall), None).await?;
                let mut http = Http::over(tls, link.fleet_url()).await?;
                let (status, m) = http.call("GET", "/fleet/v1/trust", None).await?;
                if status != 200 {
                    return Err(Category::ServerUntrusted);
                }
                let leaf_hash = crate::meet_x509::Cert::from_der(&leaf).map(|c| hex(&sha256(&c.spki))).unwrap_or_default();
                match accept_manifest(&m, &pins, &|_| None, Some(link.console_id()), stored.as_ref(), Mode::Refresh, t, wall, Some(&leaf_hash)) {
                    Ok(s) => Ok((m, s)),
                    Err(why) => {
                        self.manifest_refused(why);
                        Err(Category::ServerUntrusted)
                    }
                }
            };
            match fresh.await {
                Ok((m, s)) => {
                    let was_uncertain = matches!(self.clock.lock().gap, Gap::Behind(_));
                    self.store_manifest(&m, &s);
                    stored = Some(s);
                    self.refresh.store(false, Ordering::SeqCst);
                    if was_uncertain {
                        self.clock.lock().gap = Gap::Agree;
                        self.trust_time_event(json!({ "cleared": true, "via": "manifest" }));
                    }
                }
                Err(c) => return End::Failed(c),
            }
        }
        let Some(link) = self.link() else { return End::Idle };
        let pins = link.pins();
        let cert = link.cert().unwrap_or_default();
        let t_now = self.clock.lock().now();
        let (tls, leaf, _) = match dial(link.fleet_url(), self.proxy.as_deref(), Anchor::Pinned(cas.clone()), t_now, Some((&cert, key.pkcs8()))).await {
            Ok(x) => x,
            Err(c) => return End::Failed(c),
        };
        let leaf_hash = crate::meet_x509::Cert::from_der(&leaf).map(|c| hex(&sha256(&c.spki))).unwrap_or_default();
        let mut http = match Http::over(tls, link.fleet_url()).await {
            Ok(h) => h,
            Err(c) => return End::Failed(c),
        };
        // The leaf must be listed, not revoked, in a manifest fresh at T, before anything else is sent.
        let t = self.clock.lock().now();
        let listed = link.manifest().map(|m| accept_manifest(m, &pins, &|_| None, Some(link.console_id()), None, Mode::Running, t, now_ms(), Some(&leaf_hash)));
        if !matches!(listed, Some(Ok(_))) {
            match http.call("GET", "/fleet/v1/trust", None).await {
                Ok((200, m)) => match accept_manifest(&m, &pins, &|_| None, Some(link.console_id()), stored.as_ref(), Mode::Running, t, now_ms(), Some(&leaf_hash)) {
                    Ok(s) => self.store_manifest(&m, &s),
                    Err(why) => {
                        self.manifest_refused(why);
                        return End::Failed(Category::ServerUntrusted);
                    }
                },
                Ok(_) => return End::Failed(Category::ServerUntrusted),
                Err(c) => return End::Failed(c),
            }
        }
        match http.upgrade().await {
            Ok(wire) => self.session(wire, &link, &key, Some(leaf_hash)).await,
            Err((Category::UpgradeRefused, 403)) if self.needs_recovery(&link) => match self.recover(&link, &key).await {
                Ok(()) => End::Again,
                Err(c) => End::Failed(c),
            },
            Err((c, _)) => End::Failed(c),
        }
    }

    /// A relay whose certificate is of an older generation than its newest active pin, refused the channel, is the
    /// recovery case (3.11).
    fn needs_recovery(&self, link: &Link) -> bool {
        cert_generation(link).is_some_and(|g| newest_active(link).is_some_and(|n| n > g))
    }

    /// The restricted recovery client (3.11, A2-H2, A3-M2): the same request (stored before it is sent) until the
    /// answer arrives, so a lost answer is retried exactly.
    async fn recover(&self, link: &Link, old: &Key) -> Result<(), Category> {
        let generation = newest_active(link).ok_or(Category::ServerUntrusted)?;
        let cert = link.cert().unwrap_or_default();
        let serial = x509::serial_hex(&cert).unwrap_or_default();
        let stored = link.map.get("recovery").filter(|r| r.get("generation").and_then(Value::as_u64) == Some(generation)).and_then(|r| r.get("body")).cloned();
        let retry = stored.is_some();
        let body = match stored {
            Some(b) if vault_do(&*self.console, |v| v.get(KEY_NEXT)).is_some() => b,
            _ => {
                let new = Key::generate(Curve::P256).map_err(|_| Category::Closed)?;
                vault_do(&*self.console, |v| v.put(KEY_NEXT, new.pkcs8())).map_err(|_| Category::Closed)?;
                let input = w::recover_input(link.console_id(), link.relay_id(), &serial, &new.spki(), generation).ok_or(Category::Closed)?;
                let body = json!({ "relayId": link.relay_id(), "spkiNew": b64u(&new.spki()), "sigOld": b64u(&old.sign(&input).map_err(|_| Category::Closed)?), "sigNew": b64u(&new.sign(&input).map_err(|_| Category::Closed)?) });
                update_link(&self.dir, |m| {
                    m.insert("recovery".into(), json!({ "generation": generation, "body": body }));
                    Ok(())
                })
                .map_err(|_| Category::Closed)?;
                body
            }
        };
        let cas: Vec<Vec<u8>> = link.pins().iter().filter(|p| p.active()).filter_map(|p| p.ca_cert.clone()).collect();
        let t_now = self.clock.lock().now();
        let (tls, _, _) = dial(link.fleet_url(), self.proxy.as_deref(), Anchor::Pinned(cas), t_now, Some((&cert, old.pkcs8()))).await?;
        let mut http = Http::over(tls, link.fleet_url()).await?;
        let (status, answer) = http.call("POST", "/fleet/v1/recover-cert", Some(&body)).await?;
        if status != 200 {
            self.logger.security("fleet.recovery-refused", &Fields::new().with("status", u64::from(status)), Level::Warn);
            return Err(Category::CertificateRefused);
        }
        let new_cert = w::b64u_of(answer.get("cert")).ok_or(Category::ServerUntrusted)?;
        let ca = w::b64u_of(answer.get("caCert")).ok_or(Category::ServerUntrusted)?;
        let pin = link.pins().into_iter().find(|p| p.generation == generation && p.active()).ok_or(Category::ServerUntrusted)?;
        if x509::pin_hex(&ca).as_deref() != Some(pin.pin.as_str()) {
            return Err(Category::ServerUntrusted);
        }
        let spki_new = w::b64u_of(body.get("spkiNew")).unwrap_or_default();
        let (rid, new_serial, c) = x509::relay_leaf(&new_cert, &ca, self.clock.lock().now()).map_err(|_| Category::ServerUntrusted)?;
        if rid != link.relay_id() || c.spki != spki_new {
            return Err(Category::ServerUntrusted);
        }
        let next = vault_do(&*self.console, |v| v.get(KEY_NEXT)).ok_or(Category::Closed)?;
        let label = link_label(link);
        vault_do(&*self.console, |v| switch_keys(v, &next, &label)).map_err(|_| Category::Closed)?;
        update_link(&self.dir, |m| {
            m.insert("cert".into(), json!(b64u(&new_cert)));
            m.insert("caCert".into(), json!(b64u(&ca)));
            m.insert("fingerprint".into(), json!(x509::relay_fingerprint(&spki_new)));
            m.insert("recovery".into(), Value::Null);
            Ok(())
        })
        .map_err(|_| Category::Closed)?;
        self.console.audit_relay("fleet.relay.recovered", link.relay_id(), json!({ "oldSerial": serial, "newSerial": new_serial, "generation": generation, "retry": retry }));
        Ok(())
    }

    fn hello(&self, link: &Link, frames: &dyn RelayFrames) -> Value {
        let mut m = frames.hello_fields();
        let cert_na = link.cert().and_then(|c| crate::meet_x509::Cert::from_der(&c)).map(|c| c.not_after * 1000).unwrap_or(0);
        m.insert("relayId".into(), json!(link.relay_id()));
        m.insert("version".into(), json!(self.version));
        m.insert("fips".into(), json!(fips()));
        m.insert("profile".into(), json!(if high(&self.console) { "high" } else { "standard" }));
        m.insert("os".into(), json!(os()));
        m.insert("localConsole".into(), json!(local_console(&self.console)));
        m.insert("trustSeq".into(), json!(link.stored().map(|s| s.seq).unwrap_or(0)));
        m.insert("pins".into(), pins_value(&link.pins(), false));
        m.insert("certNotAfter".into(), json!(cert_na));
        let keys = w::op_spec("hello").map(|s| s.keys).unwrap_or_default();
        m.retain(|k, _| keys.contains(&k.as_str()));
        Value::Object(m)
    }

    /// The channel (both transports): hello, welcome, then frames, pings, metrics, events and renewal until it closes.
    async fn session(self: &Arc<Self>, wire: Wire, link: &Link, key: &Key, leaf: Option<String>) -> End {
        let local = wire.is_local();
        let started = Instant::now();
        let frames = self.frames_for(link.relay_id());
        let (mut tx, mut rx) = wire.split();
        if !tx.text(w::evt_text("hello", self.hello(link, &*frames))).await {
            return End::Failed(Category::Closed);
        }
        match tokio::time::timeout(w::IDLE, rx.next()).await {
            Ok(In::Text(t)) if matches!(w::parse_frame(&t, Side::Relay), Ok(Frame::Evt { op: "welcome", .. })) => {}
            Ok(In::Closed(Some(w::CLOSE_BYE))) => {
                self.logger.security("fleet.refused-by-console", &Fields::new(), Level::Warn);
                return End::Failed(Category::Closed);
            }
            _ => return End::Failed(Category::Closed),
        }
        // The first welcome on this certificate: the previous key is no longer needed (3.4, 3.11).
        vault_do(&*self.console, |v| {
            if v.get(KEY_OLD).is_some() {
                let _ = v.remove(KEY_OLD);
            }
        });
        let _ = update_link(&self.dir, |m| {
            m.insert("lastContactAt".into(), json!(now_ms()));
            m.insert("lastConnectFailure".into(), Value::Null);
            Ok(())
        });
        self.logger.ops("fleet.connected", &Fields::new().with("relay", link.relay_id()), Level::Info);
        let mut events_rx = match self.events_rx.lock().take() {
            Some(r) => r,
            None => return End::Failed(Category::Closed),
        };
        let (ans_tx, mut ans_rx) = mpsc::unbounded_channel::<String>();
        let mut ping = tokio::time::interval(w::PING_EVERY);
        let mut metrics = tokio::time::interval(Duration::from_secs(60));
        let mut minute = tokio::time::interval(Duration::from_secs(60));
        let mut renew_check = tokio::time::interval(Duration::from_secs(3600));
        let mut last_seen = Instant::now();
        let mut pings: HashMap<u64, Instant> = HashMap::new();
        let mut ping_seq = 0u64;
        let mut renewing: Option<(u32, Key)> = None;
        let mut end = End::Closed(Duration::ZERO);
        let _ = leaf;
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    if !local {
                        if last_seen.elapsed() > w::IDLE {
                            tx.close(1000).await;
                            break;
                        }
                        ping_seq += 1;
                        pings.insert(ping_seq, Instant::now());
                        pings.retain(|_, at| at.elapsed() < w::IDLE);
                        if !tx.ping(ping_seq.to_be_bytes().to_vec()).await {
                            break;
                        }
                    }
                }
                _ = metrics.tick() => {
                    let snap = crate::fleet_probe::snapshot(self.product);
                    let text = w::evt_text("metrics", snap);
                    if text.len() <= w::TO_CONSOLE_MAX && !tx.text(text).await {
                        break;
                    }
                }
                _ = minute.tick() => {
                    self.check_clock();
                    self.persist_clock(link.relay_id());
                }
                _ = renew_check.tick() => {
                    if renewing.is_none() {
                        // the link as it is now (a `trust-ca` may have added a newer active pin)
                        let cur = self.link().unwrap_or_else(|| link.clone());
                        if let Some((id, body, next)) = self.renewal(&cur, key) {
                            if !tx.text(w::req_text(id, "renew", body)).await {
                                break;
                            }
                            renewing = Some((id, next));
                        }
                    }
                }
                ev = events_rx.recv() => {
                    let Some((op, body)) = ev else { break };
                    let text = w::evt_text(&op, body);
                    if text.len() > w::TO_CONSOLE_MAX {
                        continue;
                    }
                    let bye = op == "bye";
                    if !tx.text(text).await {
                        break;
                    }
                    if bye {
                        tx.close(w::CLOSE_BYE).await;
                        end = End::Idle;
                        break;
                    }
                }
                a = ans_rx.recv() => {
                    if let Some(a) = a {
                        if !tx.text(a).await {
                            break;
                        }
                    }
                }
                _ = self.wake.notified() => {
                    if !self.link().is_some_and(|l| l.usable() && l.relay_id() == link.relay_id()) {
                        tx.close(1000).await;
                        end = End::Idle;
                        break;
                    }
                    // a `trust-ca` may make a renewal under the new generation due now (3.11)
                    renew_check.reset_immediately();
                }
                inc = rx.next() => {
                    last_seen = Instant::now();
                    match inc {
                        In::Text(text) => match w::parse_frame(&text, Side::Relay) {
                            Ok(Frame::Req { id, op, body }) => {
                                let (frames, ans) = (frames.clone(), ans_tx.clone());
                                tokio::task::spawn_blocking(move || {
                                    let answer = frames.request(op, &Value::Object(body), now_ms());
                                    let texts = match answer {
                                        Ok(v) => w::answer_frames(id, v),
                                        Err(r) => vec![w::res_err_text(id, &r)],
                                    };
                                    for t in texts {
                                        let _ = ans.send(t);
                                    }
                                });
                            }
                            Ok(Frame::Res { id, answer }) => {
                                let ours = renewing.as_ref().is_some_and(|(rid, _)| *rid == id);
                                if let Some((_, next)) = if ours { renewing.take() } else { None } {
                                    let cur = self.link().unwrap_or_else(|| link.clone());
                                    match self.renewed(&cur, &next, answer) {
                                        Ok(()) => {
                                            // reconnect: the next hello presents the new certificate (3.4)
                                            tx.close(1000).await;
                                            end = End::Again;
                                            break;
                                        }
                                        Err(why) => self.logger.ops("fleet.renew-failed", &Fields::new().with("why", why), Level::Warn),
                                    }
                                }
                            }
                            Ok(Frame::Evt { op: "trust", body }) => {
                                let m = Value::Object(body);
                                let cur = self.link().unwrap_or_else(|| link.clone());
                                let t = self.clock.lock().now();
                                match accept_manifest(&m, &cur.pins(), &|_| None, Some(cur.console_id()), cur.stored().as_ref(), Mode::Running, t, now_ms(), None) {
                                    Ok(s) => self.store_manifest(&m, &s),
                                    Err(why) => self.manifest_refused(why),
                                }
                            }
                            Ok(Frame::Evt { op: "ca-distrust", body }) => {
                                if !self.distrust(&Value::Object(body)) {
                                    tx.close(1000).await;
                                    end = End::Idle;
                                    break;
                                }
                            }
                            Ok(Frame::Evt { op: "bye", body }) => {
                                self.on_bye(link, &Value::Object(body));
                                tx.close(w::CLOSE_BYE).await;
                                end = End::Idle;
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                self.logger.security("fleet.frame-refused", &Fields::new().with("why", e.why), Level::Warn);
                                if let Some(id) = e.id {
                                    if !tx.text(w::res_err_text(id, &Refusal::of("fleet-op"))).await {
                                        break;
                                    }
                                }
                            }
                        },
                        In::Pong(p) => {
                            if let Ok(b) = <[u8; 8]>::try_from(p.as_slice()) {
                                if let Some(at) = pings.remove(&u64::from_be_bytes(b)) {
                                    crate::fleet_probe::counters().ping_rtt(at.elapsed().as_millis() as u64);
                                }
                            }
                        }
                        In::Binary => {
                            tx.close(w::CLOSE_BINARY).await;
                            break;
                        }
                        In::TooBig => {
                            tx.close(w::CLOSE_TOO_BIG).await;
                            break;
                        }
                        In::Closed(Some(w::CLOSE_BYE)) => {
                            // close 4003 on a verified channel: the console refused this relay
                            self.logger.security("fleet.refused-by-console", &Fields::new(), Level::Warn);
                            break;
                        }
                        In::Closed(_) | In::Failed => break,
                    }
                }
            }
        }
        *self.events_rx.lock() = Some(events_rx);
        self.persist_clock(link.relay_id());
        match end {
            End::Closed(_) => End::Closed(started.elapsed()),
            other => other,
        }
    }

    /// Whether to renew now (3.4): 30 days left at T, or a newer active pin than the certificate's generation (3.11);
    /// at most every 6 hours. Some((request id, body, the new key, already sealed as `fleet-key-next`)).
    fn renewal(&self, link: &Link, key: &Key) -> Option<(u32, Value, Key)> {
        let t = self.clock.lock().now();
        let cert = crate::meet_x509::Cert::from_der(&link.cert()?)?;
        let newer = cert_generation(link).is_some_and(|g| newest_active(link).is_some_and(|n| n > g));
        if cert.not_after * 1000 - t > RENEW_BEFORE && !newer {
            return None;
        }
        {
            let mut last = self.last_renew.lock();
            if t - *last < RENEW_RETRY {
                return None;
            }
            *last = t;
        }
        let next = Key::generate(Curve::P256).ok()?;
        vault_do(&*self.console, |v| v.put(KEY_NEXT, next.pkcs8())).ok()?;
        let input = w::renew_input(link.relay_id(), &cert.serial, &next.spki())?;
        let body = json!({ "spki": b64u(&next.spki()), "sigOld": b64u(&key.sign(&input).ok()?), "sigNew": b64u(&next.sign(&input).ok()?) });
        let id = self.req_id.fetch_add(1, Ordering::SeqCst).max(1);
        Some((id, body, next))
    }

    /// The `renew` answer: a certificate for the new key from a pinned active CA; the keys switch and the next hello
    /// presents it (the console then denies the old serial).
    fn renewed(&self, link: &Link, next: &Key, answer: Result<Value, Refusal>) -> Result<(), String> {
        let a = answer.map_err(|r| r.code)?;
        let cert = w::b64u_of(a.get("cert")).ok_or("no certificate")?;
        let t = self.clock.lock().now();
        let (ca, _) = link.pins().into_iter().filter(|p| p.active()).filter_map(|p| p.ca_cert).find_map(|ca| x509::relay_leaf(&cert, &ca, t).ok().filter(|(id, _, c)| id == link.relay_id() && c.spki == next.spki()).map(|x| (ca.clone(), x))).ok_or("the certificate does not fit")?;
        let label = link_label(link);
        vault_do(&*self.console, |v| switch_keys(v, next.pkcs8(), &label))?;
        update_link(&self.dir, |m| {
            m.insert("cert".into(), json!(b64u(&cert)));
            m.insert("caCert".into(), json!(b64u(&ca)));
            m.insert("fingerprint".into(), json!(x509::relay_fingerprint(&next.spki())));
            Ok(())
        })?;
        crate::fleet_probe::counters().set_mgmt_not_after(crate::meet_x509::Cert::from_der(&cert).map(|c| c.not_after * 1000));
        Ok(())
    }

    /// `ca-distrust`: true while an active pin remains.
    fn distrust(&self, frame: &Value) -> bool {
        let mut active = true;
        let _ = update_link(&self.dir, |m| {
            let link = Link { map: m.clone() };
            match apply_distrust(&link.pins(), frame, link.console_id(), &|_| None) {
                Ok(pins) => {
                    active = pins.iter().any(Pin::active);
                    m.insert("pins".into(), pins_value(&pins, true));
                    Ok(())
                }
                Err(_) => Err("refused".into()),
            }
        });
        if let Some(g) = frame.get("generation").and_then(Value::as_u64) {
            self.console.audit_relay("fleet.ca-distrust", "", json!({ "generation": g }));
        }
        active
    }

    /// `bye` from the console (3.5): the link and the key go; audited `fleet.removed` (actor `console <id>`).
    fn on_bye(&self, link: &Link, body: &Value) {
        forget_link(&*self.console, &self.dir, link);
        *self.managed.write() = None;
        self.logger.security("fleet.refused-by-console", &Fields::new().with("reason", body["reason"].as_str().unwrap_or_default()), Level::Warn);
        let mut r = crate::console_audit::Record::new(&format!("console {}", link.console_id()), "fleet.removed", "ok");
        r.target = Some(link.relay_id().to_owned());
        self.console.record(r, now_ms());
    }
}

/// After `bye` (3.5): `fleet.json` goes, and the sealed key with it when it carries this link's label (a key of
/// another link is never touched, A3-H1 revision 3.2).
pub fn forget_link(vault: &dyn VaultLock, dir: &Path, link: &Link) {
    let label = link_label(link);
    vault_do(vault, |v| {
        if v.get(KEY_LINK).as_deref() == Some(label.as_slice()) {
            for k in [KEY, KEY_LINK, KEY_OLD, KEY_NEXT] {
                let _ = v.remove(k);
            }
        }
    });
    remove_link(dir);
}

/// The CA generation that issued the link's certificate.
fn cert_generation(link: &Link) -> Option<u64> {
    let cert = crate::meet_x509::Cert::from_der(&link.cert()?)?;
    link.pins().into_iter().find(|p| p.ca_cert.as_ref().and_then(|c| crate::meet_x509::Cert::from_der(c)).is_some_and(|ca| cert.issued_by(&ca))).map(|p| p.generation)
}

fn newest_active(link: &Link) -> Option<u64> {
    link.pins().iter().filter(|p| p.active()).map(|p| p.generation).max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::unhex;

    fn vector() -> Value {
        let path = format!("{}/tests/admin_console_fleet_x509_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn cas(v: &Value) -> impl Fn(u64) -> Option<Vec<u8>> + '_ {
        move |g| match g {
            1 => unhex(v["ca"]["der_hex"].as_str()?),
            2 => unhex(v["ca2"]["der_hex"].as_str()?),
            _ => None,
        }
    }

    fn stored_of(v: &Value) -> Option<Stored> {
        if v.is_null() {
            return None;
        }
        Some(Stored { seq: v["seq"].as_u64()?, issued_at: v["issuedAt"].as_i64()?, sha256: unhex(v["sha256"].as_str()?)?.try_into().ok()? })
    }

    #[test]
    fn manifest_cases_of_the_vector() {
        let v = vector();
        let ca_of = cas(&v);
        let console = v["console_id"].as_str().unwrap();
        let m = &v["manifest"];
        assert_eq!(hex(&w::trust_input(&m["base"]).unwrap()), m["signing_input_hex"].as_str().unwrap());
        for c in m["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let got = accept_manifest(&c["manifest"], &pins_of(Some(&c["pins"])), &ca_of, Some(console), stored_of(&c["stored"]).as_ref(), Mode::Refresh, c["trusted_time_ms"].as_i64().unwrap(), c["wall_ms"].as_i64().unwrap(), c["leaf_spki_sha256"].as_str());
            assert_eq!(got.err(), c["why"].as_str(), "{name}");
        }
    }

    #[test]
    fn rollover_and_distrust_cases_of_the_vector() {
        let v = vector();
        let r = &v["rollover"];
        let strip = |pins: &[Pin]| pins_value(pins, false);
        for c in r["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let before = pins_of(Some(&c["pins_before"]));
            match c["step"].as_str().unwrap() {
                "manifest" => assert_eq!(strip(&apply_next_ca(&before, &r["manifest"])), c["pins_after"], "{name}"),
                _ => match confirm_pin(&before, None, c["fingerprint"].as_str().unwrap()) {
                    Ok(after) => {
                        assert!(c["ok"].as_bool().unwrap(), "{name}");
                        assert_eq!(strip(&after), c["pins_after"], "{name}");
                    }
                    Err(why) => {
                        assert_eq!(Some(why), c["why"].as_str(), "{name}");
                        assert_eq!(strip(&before), c["pins_after"], "{name}");
                    }
                },
            }
        }
        let ca_of = cas(&v);
        let console = v["console_id"].as_str().unwrap();
        for c in v["distrust"]["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let before = pins_of(Some(&c["pins_before"]));
            assert_eq!(hex(&w::distrust_input(console, c["frame"]["generation"].as_u64().unwrap())), c["input_hex"].as_str().unwrap(), "{name}");
            match apply_distrust(&before, &c["frame"], console, &ca_of) {
                Ok(after) => {
                    assert!(c["ok"].as_bool().unwrap(), "{name}");
                    assert_eq!(strip(&after), c["pins_after"], "{name}");
                    assert_eq!(!after.iter().any(Pin::active), c["silent"].as_bool().unwrap(), "{name}");
                }
                Err(why) => assert_eq!(Some(why), c["why"].as_str(), "{name}"),
            }
        }
    }

    fn older(why: &str) -> &str {
        if why.starts_with("rollback") || why == "same-seq-different-bytes" {
            "older"
        } else {
            why
        }
    }

    /// Trusted time (3.10 as revised in 3.1 and 3.2): the clock gap, the start refresh, the ahead rules, the reset.
    #[test]
    fn trusted_time_cases_of_the_vector() {
        let v = vector();
        let ca_of = cas(&v);
        let console = v["console_id"].as_str().unwrap();
        let tt = &v["trusted_time"];
        let pins = vec![Pin { generation: 1, pin: v["ca"]["pin_hex"].as_str().unwrap().into(), state: "active".into(), ca_cert: None }];
        for c in tt["running"].as_array().unwrap() {
            let g = gap_of(c["T"].as_i64().unwrap(), c["wall"].as_i64().unwrap());
            let why = match g {
                Gap::Ahead(_) => Some("ahead"),
                Gap::Behind(_) => Some("behind"),
                Gap::Agree => None,
            };
            assert_eq!(why, c["why"].as_str(), "{}", c["name"]);
        }
        for c in tt["start"].as_array().unwrap() {
            let t = c["T"].as_i64().unwrap();
            let got = accept_manifest(&c["manifest"], &pins, &ca_of, Some(console), stored_of(&c["stored"]).as_ref(), Mode::Refresh, t, c["wall"].as_i64().unwrap(), None);
            assert_eq!(got.as_ref().err().map(|w| older(w)), c["why"].as_str(), "{}", c["name"]);
            if let Ok(s) = got {
                let mut clock = TrustClock::new(t);
                clock.adopt(s.issued_at);
                assert!((clock.now() - c["T_after"].as_i64().unwrap()).abs() < 1000, "{}", c["name"]);
            }
        }
        for c in tt["ahead"].as_array().unwrap() {
            let got = accept_manifest(&c["manifest"], &pins, &ca_of, Some(console), stored_of(&c["stored"]).as_ref(), Mode::Running, c["T"].as_i64().unwrap(), c["wall"].as_i64().unwrap(), None);
            assert_eq!(got.err().map(older), c["why"].as_str(), "{}", c["name"]);
        }
        for c in tt["reset"].as_array().unwrap() {
            let case_pins = pins_of(Some(&c["pins"]));
            let wall = c["wall"].as_i64().unwrap();
            let got = if c["manifest"].is_null() { Err("no-manifest") } else { accept_manifest(&c["manifest"], &case_pins, &ca_of, Some(console), stored_of(&c["stored"]).as_ref(), Mode::Reset, c["T"].as_i64().unwrap(), wall, c["leaf_spki_sha256"].as_str()) };
            assert_eq!(got.as_ref().err().copied(), c["why"].as_str(), "{}", c["name"]);
            if let Ok(s) = got {
                assert_eq!(s.issued_at, c["T_after"].as_i64().unwrap());
                assert_eq!(Some(s), stored_of(&c["stored_after"]));
            }
        }
    }

    /// Revision 3.3: at start a manifest is judged at R = max(T, wall).
    #[test]
    fn a_persisted_trusted_time_survives_a_clock_set_back() {
        use crate::fleet_ca::{FleetCa, MemVault};
        let t0 = 1_800_000_000_000i64;
        let d = crate::fleet_ca::tests_dir("r33");
        let mut v = MemVault::default();
        let mut ca = FleetCa::open(&d, &mut v, "c_0123456789abcdef", "console.example.com", &[], t0 - 20 * DAY);
        let old = ca.manifest.clone();
        let current = ca.reissue(&v, t0).unwrap();
        let ahead = ca.reissue(&v, t0 + 2 * HOUR).unwrap();
        let cert = ca.issuing_cert().unwrap().cert.clone();
        let pins = vec![Pin { generation: 1, pin: x509::pin_hex(&cert).unwrap(), state: "active".into(), ca_cert: Some(cert) }];
        let judge = |m: &Value, t: i64, wall: i64| accept_manifest(m, &pins, &|_| None, Some("c_0123456789abcdef"), None, Mode::Refresh, t, wall, None).map(|_| ());
        let (t, back) = (t0 + HOUR, t0 + HOUR - 30 * DAY);
        // a persisted T near real time, wall 30 days behind: the current manifest is accepted
        assert_eq!(judge(&current, t, back), Ok(()));
        // an old manifest is still refused (T is past its expiresAt)
        assert_eq!(judge(&old, t, back), Err("expired"));
        // no persisted T (a fresh enrollment) with the same clock: refused until the clock or a reset fixes it
        assert_eq!(judge(&current, 0, back), Err("issued-future"));
        // dated more than 5 minutes after max(T, wall): refused in both cases
        assert_eq!(judge(&ahead, t, back), Err("issued-future"));
        assert_eq!(judge(&ahead, 0, back), Err("issued-future"));
    }

    #[test]
    fn a_running_clock_never_takes_wall_time() {
        let mut c = TrustClock::new(1_000_000);
        let t0 = c.now();
        // wall two years ahead: T keeps its own pace; only a manifest raises it
        assert!(matches!(gap_of(t0, t0 + 730 * DAY), Gap::Ahead(_)));
        assert!(c.now() - t0 < 1000);
        c.adopt(t0 - 5);
        assert!(c.now() >= t0, "adopt never moves T back");
        c.adopt(t0 + 60_000);
        assert!(c.now() >= t0 + 60_000);
        assert_eq!(gap_of(t0, t0 + 10 * MINUTE), Gap::Agree);
        assert_eq!(gap_of(t0, t0 - 5 * MINUTE), Gap::Agree);
        assert!(matches!(gap_of(t0, t0 - 6 * MINUTE), Gap::Behind(_)));
    }

    #[test]
    fn urls_and_proxies_read() {
        assert_eq!(parse_fleet_url("https://Console.Example.com").unwrap(), ("console.example.com".into(), 7443));
        assert_eq!(parse_fleet_url("https://console.example.com:9443/x").unwrap(), ("console.example.com".into(), 9443));
        assert_eq!(parse_fleet_url("https://[::1]:7443").unwrap(), ("::1".into(), 7443));
        assert!(parse_fleet_url("http://console.example.com").is_err());
        assert!(parse_fleet_url("https://user@console.example.com").is_err());
        assert_eq!(parse_proxy("http://proxy.local:3128").unwrap(), ("proxy.local".into(), 3128));
        assert!(parse_proxy("socks5://proxy.local:1080").is_err());
        assert!(parse_proxy("http://user:pw@proxy.local:3128").is_err());
    }

    /// 5.7 and A1-M1: no argument or environment form of the code exists.
    #[test]
    fn the_code_never_comes_from_argv() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let a = parse_enroll_args(&s(&["https://console.example.com", "--yes"])).unwrap();
        assert_eq!(a.code, CodeFrom::Prompt);
        assert!(parse_enroll_args(&s(&["https://console.example.com", "LCE1-AAAAA-BBBBB"])).is_err());
        assert!(parse_enroll_args(&s(&["https://console.example.com", "--code", "LCE1-AAAAA"])).is_err());
        assert!(parse_enroll_args(&s(&["--code-file", "a", "--code-fd", "3", "https://c.example"])).is_err());
        assert_eq!(parse_enroll_args(&s(&["--state", "/x", "https://c.example", "--code-fd", "3"])).unwrap().code, CodeFrom::Fd(3));
        assert!(parse_enroll_args(&s(&["https://c.example", "--fleet-admin-key", "abc"])).is_err());
        let src = include_str!("fleet_agent.rs");
        let env_reads: Vec<&str> = src.lines().filter(|l| l.contains("env::var(") && !l.contains("PROXY_ENV") && !l.contains("std::env::var(k)")).collect();
        assert!(env_reads.is_empty(), "{env_reads:?}");
    }

    struct FakeTerm {
        tty: bool,
        echo: Vec<bool>,
        lines: Vec<String>,
        out: String,
    }

    impl Term for FakeTerm {
        fn is_terminal(&self) -> bool {
            self.tty
        }
        fn set_echo(&mut self, on: bool) -> bool {
            self.echo.push(on);
            true
        }
        fn read_line(&mut self) -> Option<String> {
            // the code is typed while echo is off
            if self.tty {
                assert_eq!(self.echo.last(), Some(&false));
            }
            (!self.lines.is_empty()).then(|| self.lines.remove(0))
        }
        fn write(&mut self, s: &str) {
            self.out.push_str(s);
        }
    }

    #[test]
    fn the_prompt_does_not_echo_and_stdin_reads_one_line() {
        let code = w::code_encode(Product::Spokes, &[1; 8], &[2; 20], &[3; 32]);
        let mut t = FakeTerm { tty: true, echo: vec![], lines: vec![code.clone()], out: String::new() };
        let got = read_code(&CodeFrom::Prompt, &mut t).unwrap();
        assert_eq!(got.expose(), &code);
        assert_eq!(t.echo, vec![false, true]);
        assert!(t.out.starts_with(w::cli_words("cli.enroll-ask-code")) && !t.out.contains(&code));
        let mut piped = FakeTerm { tty: false, echo: vec![], lines: vec![code.clone()], out: String::new() };
        assert_eq!(read_code(&CodeFrom::Prompt, &mut piped).unwrap().expose(), &code);
        assert!(piped.echo.is_empty() && piped.out.is_empty());
        assert_eq!(format!("{got:?}"), "<redacted>");
    }

    #[cfg(unix)]
    #[test]
    fn the_code_file_must_be_private_and_is_deleted() {
        use std::os::unix::fs::PermissionsExt;
        let d = crate::fleet_ca::tests_dir("codefile");
        let code = w::code_encode(Product::Spokes, &[1; 8], &[2; 20], &[3; 32]);
        let mut t = FakeTerm { tty: false, echo: vec![], lines: vec![], out: String::new() };
        // wider permissions
        let p = d.join("code.txt");
        std::fs::write(&p, &code).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_code(&CodeFrom::File(p.clone()), &mut t).unwrap_err(), w::cli_words("cli.code-file"));
        // a symbolic link
        let link = d.join("link.txt");
        std::os::unix::fs::symlink(&p, &link).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_code(&CodeFrom::File(link.clone()), &mut t).unwrap_err(), w::cli_words("cli.code-file"));
        // a non-regular file
        assert_eq!(read_code(&CodeFrom::File(d.clone()), &mut t).unwrap_err(), w::cli_words("cli.code-file"));
        // a good one is read and deleted
        assert_eq!(read_code(&CodeFrom::File(p.clone()), &mut t).unwrap().expose(), &code);
        assert!(!p.exists());
    }

    #[test]
    fn the_handoff_is_exclusive_private_and_deleted_on_every_path() {
        let d = crate::fleet_ca::tests_dir("handoff");
        let content = json!({ "url": "https://c.example", "code": "LCE1-SECRET", "previewHash": hex(&[7u8; 32]), "confirmedBy": "prompt", "adminKeys": [], "at": now_ms() });
        write_handoff(&d, &content).unwrap();
        // exclusive: a second write while one waits is refused
        assert!(write_handoff(&d, &content).is_err());
        assert!(has_handoff(&d));
        let h = take_handoff(&d).unwrap().unwrap();
        assert!(!has_handoff(&d), "deleted before anything else");
        assert_eq!(h.code.expose(), "LCE1-SECRET");
        assert!(!format!("{h:?}").contains("SECRET"));
        // a file that does not read is deleted too
        std::fs::write(d.join(HANDOFF_FILE), "{").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d.join(HANDOFF_FILE), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let e = take_handoff(&d).unwrap_err();
        assert!(!e.contains("SECRET"));
        assert!(!has_handoff(&d));
        // older than an hour: deleted unread
        let old = json!({ "url": "https://c.example", "code": "LCE1-SECRET", "previewHash": hex(&[7u8; 32]), "confirmedBy": "flag", "adminKeys": [], "at": now_ms() - 2 * HOUR });
        write_handoff(&d, &old).unwrap();
        assert!(take_handoff(&d).is_err());
        assert!(!has_handoff(&d));
        // a symbolic link is refused and removed
        #[cfg(unix)]
        {
            let target = d.join("t.json");
            std::fs::write(&target, "{}").unwrap();
            std::os::unix::fs::symlink(&target, d.join(HANDOFF_FILE)).unwrap();
            assert!(take_handoff(&d).is_err());
            assert!(!has_handoff(&d) && target.exists());
        }
    }

    #[test]
    fn link_updates_keep_other_keys_and_never_create_a_link() {
        let d = crate::fleet_ca::tests_dir("link");
        assert!(update_link(&d, |_| Ok(())).is_err(), "no link is created by an update");
        write_link_file(&d, &json!({ "relayId": "r_0000000000000001", "roster": [1, 2] }).as_object().cloned().unwrap()).unwrap();
        update_link(&d, |m| {
            m.insert("trustTimeMs".into(), json!(5));
            Ok(())
        })
        .unwrap();
        let m = load_link_json(&d).unwrap().unwrap();
        assert_eq!((m["roster"].clone(), m["trustTimeMs"].clone()), (json!([1, 2]), json!(5)));
        std::fs::write(d.join(LINK_FILE), "{").unwrap();
        let logger = Logger::capture("relay", Box::new(|_, _| {}));
        assert!(read_link(&d, &logger).is_none(), "an unreadable link starts the relay unmanaged");
        // a link without a certificate (after `fleet recover`) is unmanaged, not unreadable
        write_link_file(&d, &json!({ "relayId": "r_0000000000000001", "pins": [] }).as_object().cloned().unwrap()).unwrap();
        assert!(read_link(&d, &logger).is_none());
        assert!(load_link_json(&d).unwrap().is_some());
    }

    use crate::fleet_port::tests as port;
    use tokio::net::TcpListener;

    async fn listen(state: &Arc<crate::fleet_port::PortState>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = listener.local_addr().unwrap().port();
        tokio::spawn(crate::fleet_port::run(listener, state.clone()));
        format!("https://localhost:{p}")
    }

    fn hello_text(relay: &str) -> String {
        w::evt_text("hello", json!({"relayId": relay, "version": "1", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": [], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": {}, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "pins": [], "certNotAfter": 0}))
    }

    /// Invariant 4: a pin mismatch fails the handshake and nothing reaches the console; the right pin previews.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pin_mismatch_sends_nothing() {
        let (state, desk, _) = port::test_port("pin");
        let url = listen(&state).await;
        let good = port::mint_code(&state, &desk, now_ms() + HOUR);
        let wrong = w::code_parse(&w::code_encode(Product::Spokes, &good.id_bytes, good.secret.expose(), &[9; 32])).unwrap();
        let e = preview_async(&url, &wrong, None).await.unwrap_err();
        assert_eq!(e, Refusal::of("fleet-pin").error);
        assert_eq!(desk.calls.load(Ordering::SeqCst), 0, "the console saw no request");
        let p = preview_async(&url, &good, None).await.unwrap();
        assert!(p["previewHash"].is_string());
        assert_eq!(desk.calls.load(Ordering::SeqCst), 1);
    }

    /// 3.6: the channel through an HTTP CONNECT proxy; a refusing proxy is its own category (3.13).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_connect_proxy_path() {
        let (state, _, _) = port::test_port("proxy");
        let url = listen(&state).await;
        async fn proxy(refuse: bool) -> String {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let p = l.local_addr().unwrap().port();
            tokio::spawn(async move {
                while let Ok((mut c, _)) = l.accept().await {
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        let mut b = [0u8; 1];
                        while !head.ends_with(b"\r\n\r\n") {
                            if c.read(&mut b).await.unwrap_or(0) == 0 {
                                return;
                            }
                            head.push(b[0]);
                        }
                        if refuse {
                            let _ = c.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
                            return;
                        }
                        let text = String::from_utf8_lossy(&head).into_owned();
                        let target = text.split_whitespace().nth(1).unwrap_or_default().to_owned();
                        let Ok(mut up) = TcpStream::connect(target.replace("localhost", "127.0.0.1")).await else { return };
                        let _ = c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
                        let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                    });
                }
            });
            format!("http://127.0.0.1:{p}")
        }
        let ca = state.ca.lock().issuing_cert().unwrap().cert.clone();
        let through = proxy(false).await;
        let (tls, _, _) = dial(&url, Some(&through), Anchor::Pinned(vec![ca.clone()]), now_ms(), None).await.unwrap();
        let mut http = Http::over(tls, &url).await.unwrap();
        let (status, m) = http.call("GET", "/fleet/v1/trust", None).await.unwrap();
        assert_eq!((status, m["seq"].clone()), (200, state.trust()["seq"].clone()));
        let refusing = proxy(true).await;
        assert_eq!(dial(&url, Some(&refusing), Anchor::Pinned(vec![ca]), now_ms(), None).await.err(), Some(Category::Proxy));
        assert_eq!(dial("https://no-such-host.invalid:7443", None, Anchor::Pinned(vec![]), now_ms(), None).await.err(), Some(Category::Dns));
    }

    async fn upgrade_with(url: &str, ca: &[u8], cert: &[u8], key: &[u8]) -> Result<Wire, (Category, u16)> {
        let (tls, _, _) = dial(url, None, Anchor::Pinned(vec![ca.to_vec()]), now_ms(), Some((cert, key))).await.map_err(|c| (c, 0))?;
        Http::over(tls, url).await.map_err(|c| (c, 0))?.upgrade().await
    }

    async fn call_with(url: &str, ca: &[u8], cert: &[u8], key: &[u8], method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Category> {
        let (tls, _, _) = dial(url, None, Anchor::Pinned(vec![ca.to_vec()]), now_ms(), Some((cert, key))).await?;
        Http::over(tls, url).await?.call(method, path, body).await
    }

    /// 16.1 (A2-H2, A3-M2) end to end over TLS: three relays; `fleet-ca replace --compromised`; the old pin no longer
    /// verifies the console; with the confirmed new pin, each old certificate gets a recovery-only connection (no
    /// upgrade, no trust read, no enroll), `recover-cert` issues a generation-2 certificate, an exact retry gets the same
    /// one, the new certificate opens the channel, and after that first normal connection the old one is refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn recovery_end_to_end_over_tls() {
        let (state, desk, vault) = port::test_port("e2e");
        let url = listen(&state).await;
        let relays: Vec<(String, Key, Vec<u8>)> = (0..3).map(|_| port::enrolled(&state, &desk)).collect();
        let old_ca = state.ca.lock().issuing_cert().unwrap().cert.clone();
        assert!(upgrade_with(&url, &old_ca, &relays[0].2, relays[0].1.pkcs8()).await.is_ok(), "a normal channel before the replacement");
        let dir = state.ca.lock().dir().to_owned();
        let t = now_ms();
        let seeds: Vec<crate::fleet_ca::RelaySeed> = relays.iter().map(|(id, k, c)| (id.clone(), vec![(x509::serial_hex(c).unwrap(), t + 90 * DAY, true, k.spki())])).collect();
        vault_do(&*vault, |v| crate::fleet_ca::replace_with(&dir, v, "compromised", &seeds, t)).unwrap();
        *state.ca.lock() = vault_do(&*vault, |v| crate::fleet_ca::FleetCa::open(&dir, v, port::CID, "console.example.com", &["localhost".into()], t));
        state.reload_server_key();
        let new_ca = state.ca.lock().issuing_cert().unwrap().cert.clone();
        for (id, key, cert) in &relays {
            // a relay whose operator has not confirmed the new CA cannot verify the console
            assert_eq!(dial(&url, None, Anchor::Pinned(vec![old_ca.clone()]), now_ms(), None).await.err(), Some(Category::ServerUntrusted));
            // recovery-only: no channel, no trust read, no enrollment
            assert_eq!(upgrade_with(&url, &new_ca, cert, key.pkcs8()).await.err(), Some((Category::UpgradeRefused, 403)));
            assert_eq!(call_with(&url, &new_ca, cert, key.pkcs8(), "GET", "/fleet/v1/trust", None).await.unwrap().0, 403);
            assert_eq!(call_with(&url, &new_ca, cert, key.pkcs8(), "POST", "/fleet/v1/enroll", Some(&json!({}))).await.unwrap().0, 403);
            let new = Key::generate(Curve::P256).unwrap();
            let serial = x509::serial_hex(cert).unwrap();
            let input = w::recover_input(port::CID, id, &serial, &new.spki(), 2).unwrap();
            let body = json!({ "relayId": id, "spkiNew": b64u(&new.spki()), "sigOld": b64u(&key.sign(&input).unwrap()), "sigNew": b64u(&new.sign(&input).unwrap()) });
            let (s1, a1) = call_with(&url, &new_ca, cert, key.pkcs8(), "POST", "/fleet/v1/recover-cert", Some(&body)).await.unwrap();
            assert_eq!(s1, 200, "{a1}");
            // the first answer is dropped; the exact retry gets the same certificate
            let (s2, a2) = call_with(&url, &new_ca, cert, key.pkcs8(), "POST", "/fleet/v1/recover-cert", Some(&body)).await.unwrap();
            assert_eq!((s2, &a2["cert"]), (200, &a1["cert"]));
            assert!(desk.audits.lock().iter().any(|a| a == &format!("fleet.relay.recovered {id} retry=true")));
            let new_cert = unb64u(a1["cert"].as_str().unwrap()).unwrap();
            // the new certificate connects normally; its first hello closes the record
            let wire = upgrade_with(&url, &new_ca, &new_cert, new.pkcs8()).await.unwrap();
            let (mut tx, mut rx) = wire.split();
            assert!(tx.text(hello_text(id)).await);
            let In::Text(welcome) = rx.next().await else { panic!("welcome") };
            assert!(matches!(w::parse_frame(&welcome, Side::Relay), Ok(Frame::Evt { op: "welcome", .. })));
            // after the first normal connection the old certificate serves nothing at all
            assert!(!matches!(call_with(&url, &new_ca, cert, key.pkcs8(), "POST", "/fleet/v1/recover-cert", Some(&body)).await, Ok((200, _))));
            assert!(upgrade_with(&url, &new_ca, cert, key.pkcs8()).await.is_err());
        }
    }

    /// 3.6 and 3.8 on the real channel: a binary frame closes it with 1003, a frame over 1 MiB with 1009.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn binary_and_oversized_frames_close_the_channel() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let (state, desk, _) = port::test_port("binary");
        let url = listen(&state).await;
        let (id, key, cert) = port::enrolled(&state, &desk);
        let ca = state.ca.lock().issuing_cert().unwrap().cert.clone();
        let big = w::evt_text("audit", json!({ "entries": ["a".repeat(w::TO_CONSOLE_MAX + 10)] }));
        for (msg, code) in [(Message::binary(vec![1u8, 2]), w::CLOSE_BINARY), (Message::text(big), w::CLOSE_TOO_BIG)] {
            let Ok(Wire::Ws(mut ws)) = upgrade_with(&url, &ca, &cert, key.pkcs8()).await else { panic!("no channel") };
            ws.send(Message::text(hello_text(&id))).await.unwrap();
            let _welcome = ws.next().await;
            // the send of an oversized frame may already meet the closed connection
            let _ = ws.send(msg).await;
            loop {
                match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("the console closes the channel") {
                    Some(Ok(Message::Close(Some(c)))) => {
                        assert_eq!(u16::from(c.code), code);
                        break;
                    }
                    // a reset or end after the console closed counts as closed (Windows reports 10054 when the close
                    // frame and the reset race)
                    Some(Err(_)) | None | Some(Ok(Message::Close(None))) => break,
                    Some(Ok(_)) => continue,
                }
            }
            // either way the console dropped the channel
            let mut gone = false;
            for _ in 0..50 {
                if !state.connected(&id) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(gone, "the channel is closed on the console");
        }
    }

    #[test]
    fn bye_deletes_the_link_and_only_its_own_key() {
        let d = crate::fleet_ca::tests_dir("bye");
        let vault = Mutex::new(crate::fleet_ca::MemVault::default());
        let map = json!({ "consoleId": "c_0123456789abcdef", "relayId": "r_0000000000000001", "cert": "AA" }).as_object().cloned().unwrap();
        let key = Key::generate(Curve::P256).unwrap();
        write_new_link(&vault, &d, &key, map.clone()).unwrap();
        let link = Link { map };
        // a key labeled for another link is never touched
        let other = Link { map: json!({ "consoleId": "c_0123456789abcdef", "relayId": "r_0000000000000002" }).as_object().cloned().unwrap() };
        forget_link(&vault, &d, &other);
        assert!(vault.lock().map.contains_key(KEY));
        write_link_file(&d, &link.map).unwrap();
        forget_link(&vault, &d, &link);
        assert!(!d.join(LINK_FILE).exists());
        assert!(!vault.lock().map.contains_key(KEY) && !vault.lock().map.contains_key(KEY_LINK));
    }

    #[test]
    fn failure_categories_are_distinct() {
        use rustls::{AlertDescription as A, CertificateError as C, Error as E};
        let cat = |e: E| category_of(&std::io::Error::other(e));
        assert_eq!(cat(E::InvalidCertificate(C::Expired)), Category::ServerExpired);
        assert_eq!(cat(E::InvalidCertificate(C::UnknownIssuer)), Category::ServerUntrusted);
        assert_eq!(cat(E::AlertReceived(A::CertificateRevoked)), Category::CertificateRefused);
        assert_eq!(cat(E::AlertReceived(A::HandshakeFailure)), Category::TlsProtocol);
        assert_eq!(cat(E::PeerIncompatible(rustls::PeerIncompatible::NoKxGroupsInCommon)), Category::TlsProtocol);
        let all = [Category::Dns, Category::Tcp, Category::Proxy, Category::TlsProtocol, Category::ServerUntrusted, Category::ServerExpired, Category::CertificateRefused, Category::UpgradeRefused, Category::Closed];
        let words: std::collections::HashSet<&str> = all.iter().map(|c| c.words()).collect();
        assert_eq!(words.len(), all.len());
        assert!(!words.contains(""));
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_agent.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
