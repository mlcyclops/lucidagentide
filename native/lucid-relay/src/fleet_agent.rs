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
//
// AC-2b-D 6 and 7 (d-port): `enroll --deploy <env>` judges the preview against the values set on the host (profile,
// certificate source, names, placed roots) and the installer marker (the only console-installed claim), asks for the
// relay admins, ceremony B fingerprints and, under C-prime, the console-offered key; the relay applies the handoff
// before its listeners (`apply_before_listeners`), drawing its Meeting Hub keys and requests itself; the channel
// carries `meet-cert` renewals, `meet-crl` and `meet-crl-get` (9.3) through f-relay's `MeetHooks`.

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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
    /// AC-2b-D 6.4: the relay's own facts and the handoff's `deploy` (the apply before the listeners). None for the
    /// agent's late apply and the in-process Join, which refuse a deploy preview.
    pub deploy: Option<&'a DeployApply<'a>>,
}

/// What the apply before the listeners knows besides the handoff.
pub struct DeployApply<'a> {
    pub local: &'a LocalDeploy,
    /// The handoff's `deploy` object (None after a plain `enroll`).
    pub handoff: Option<&'a Value>,
    /// The state folder was fresh (7.3) when this start began, before the headless console that carries the apply
    /// sealed and wrote its first audit segment.
    pub fresh: bool,
    pub logger: &'a Logger,
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
    // AC-2b-D 2.3: the profile set on the host decides, not the relay's book
    let local_high = a.deploy.map_or_else(|| high(a.console), |d| d.local.high);
    if local_high && preview["policy"]["profile"] != json!("high") {
        return Err(w::cli_words("cli.enroll-high-standard").to_owned());
    }
    // AC-2b-D 6.3 step 1 and 6.4: a deploy preview is taken only by the apply before the listeners
    let dv = preview.get("deploy").filter(|d| d.is_object());
    let deploy = match (dv, a.deploy) {
        (Some(dv), Some(d)) => Some((dv, d)),
        (Some(_), None) => return Err(w::cli_words("cli.deploy-needs-deploy").to_owned()),
        (None, Some(d)) if d.handoff.is_some() => return Err(w::cli_words("cli.deploy-not-deploy").to_owned()),
        _ => None,
    };
    if let Some((dv, d)) = deploy {
        if !local_high && preview["policy"]["profile"] == json!("high") {
            return Err(w::cli_words("cli.deploy-profile").to_owned());
        }
        recheck_local(d, dv, code, a.state_dir, a.product)?;
    }
    let key = Key::generate(Curve::P256)?;
    let spki = key.spki();
    let mut relay = relay_value(a.console, a.product, a.version);
    relay["profile"] = json!(if local_high { "high" } else { "standard" });
    // AC-2b-D 6.5: a Meeting Hub relay names its roots and, with `fleet_pki`, sends its certificate requests; all of
    // it inside T, so the MAC and the management key's signature cover it.
    let mut requests: Option<MeetRequests> = None;
    if a.product == Product::Meet {
        let roots = a.deploy.and_then(|d| d.local.client_ca.as_deref()).map(meet_roots_of).unwrap_or_default();
        relay["meetRoots"] = json!(roots);
        relay["meetCsr"] = Value::Null;
        relay["meetSignerCsr"] = Value::Null;
        if let Some((dv, d)) = deploy {
            if d.local.fleet_pki {
                let r = MeetRequests::draw(&a.state_dir.join(PKI_DIR), meet_names(dv), dv.get("signer").is_some_and(Value::is_object)).map_err(|_| "meet-pki".to_owned())?;
                relay["meetCsr"] = r.csr.as_ref().map_or(Value::Null, |c| json!(b64u(c)));
                relay["meetSignerCsr"] = r.signer_csr.as_ref().map_or(Value::Null, |c| json!(b64u(c)));
                requests = Some(r);
            }
        }
    }
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
    // the words stay `server-untrusted`; the apply before the listeners logs which check failed
    let untrusted_because = |why: &str| {
        if let Some(d) = a.deploy {
            d.logger.security("fleet.enroll-answer-refused", &Fields::new().with("why", why), Level::Warn);
        }
        Category::ServerUntrusted.words().to_owned()
    };
    let untrusted = || untrusted_because("no-cert");
    let cert = w::b64u_of(answer.get("cert")).ok_or_else(untrusted)?;
    let ca_cert = w::b64u_of(answer.get("caCert")).ok_or_else(untrusted)?;
    if ca_cert != ca_seen || x509::pin_hex(&ca_cert).as_deref() != Some(code.pin_hex().as_str()) {
        return Err(Refusal::of("fleet-pin").error);
    }
    let (relay_id, _, issued) = x509::relay_leaf(&cert, &ca_cert, wall).map_err(|e| untrusted_because(&format!("leaf: {e}")))?;
    if issued.spki != spki {
        return Err(untrusted_because("leaf-key"));
    }
    if answer.get("relayId").and_then(Value::as_str) != Some(relay_id.as_str()) {
        return Err(untrusted_because("relay-id"));
    }
    let manifest = answer.get("trust").cloned().unwrap_or(Value::Null);
    let generation = manifest.get("caGeneration").and_then(Value::as_u64).unwrap_or(1);
    let pins = vec![Pin { generation, pin: code.pin_hex(), state: "active".into(), ca_cert: Some(ca_cert.clone()) }];
    let leaf_hash = crate::meet_x509::Cert::from_der(&leaf).map(|c| hex(&sha256(&c.spki))).unwrap_or_default();
    let console_id = answer["console"]["id"].as_str().unwrap_or_default().to_owned();
    let stored = accept_manifest(&manifest, &pins, &|_| None, Some(&console_id), None, Mode::Refresh, wall, wall, Some(&leaf_hash)).map_err(|why| untrusted_because(&format!("manifest: {why}")))?;
    let pins = apply_next_ca(&pins, &manifest);
    // AC-2b-D 6.5: the Meeting Hub certificates are checked (and written into the new folder) before anything else
    // is kept; any failure discards everything (the new folder goes with `requests`).
    let issued_meet = match (deploy, requests.as_mut()) {
        (Some((dv, _)), Some(r)) => Some(r.check_answer(dv, &answer, wall).map_err(|_| "meet-pki".to_owned())?),
        _ => None,
    };
    // AC-2b-D 7.3 (C-prime, Standard only): the console-offered key the operator typed yes to
    let offered: Vec<String> = match deploy {
        Some((dv, d)) if !local_high => offered_anchors(dv, d),
        _ => Vec::new(),
    };
    let mut anchored: Vec<(String, String)> = Vec::new();
    let roster_out: Vec<Value> = roster
        .iter()
        .map(|e| {
            let mut e = e.clone();
            e["state"] = json!("inactive");
            let fp = entry_fingerprint(&e);
            let email_ok = a.product != Product::Meet || deploy.is_some_and(|(_, d)| d.local.admins.iter().any(|x| e["email"].as_str() == Some(x.as_str())));
            if fp.as_ref().is_some_and(|f| offered.contains(f)) && e["role"] == json!("admin") && email_ok {
                let f = fp.unwrap_or_default();
                e["anchor"] = json!({ "via": "console-offered", "by": format!("console-offered:{f}") });
                anchored.push((e["email"].as_str().unwrap_or_default().to_owned(), f));
            }
            e
        })
        .collect();
    let mut link = json!({
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
        "roster": roster_out,
        "rosterSeq": answer["rosterSeq"],
        "rosterHash": answer["rosterHash"],
        "enrolledAt": wall,
        "keyLost": false,
        "trustTimeMs": stored.issued_at,
        "fingerprint": x509::relay_fingerprint(&spki),
        "lastContactAt": null,
        "lastConnectFailure": null,
    });
    if let Some(r) = requests.as_ref() {
        // the names recorded at mint, for the renewal requests (8.4)
        link["meetNames"] = json!(r.names);
    }
    let link_map = link.as_object().cloned().unwrap_or_default();
    write_new_link(a.console, a.state_dir, &key, link_map.clone())?;
    if let Some((dv, d)) = deploy {
        if let Err(why) = place_deploy(a.console, a.product, a.state_dir, d, dv, requests.as_mut().zip(issued_meet.as_ref()), wall) {
            // any failure discards everything (6.5), the link included
            forget_link(a.console, a.state_dir, &Link { map: link_map });
            return Err(why);
        }
    }
    let fingerprint = x509::relay_fingerprint(&spki);
    a.console.audit_relay("fleet.enrolled", &relay_id, json!({ "fingerprint": fingerprint, "bootstrapRosterHash": answer["bootstrapRosterHash"], "confirmedBy": a.confirmed_by }));
    for (email, fp) in &anchored {
        a.console.audit_relay("fleet.bootstrap-anchor", &relay_id, json!({ "via": "console-offered", "email": email, "fingerprint": fp }));
    }
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
    /// AC-2b-D 6.3 step 10: `{env, consoleInstalled: null or {enrollment, sha256}, fresh, offeredAccepted}`; None
    /// after a plain `enroll`.
    pub deploy: Option<Value>,
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
        deploy: v.get("deploy").filter(|d| d.is_object()).cloned(),
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
    /// AC-2b-D 6.3: `--deploy <env>` and the values set on the host; None for AC-2a's `enroll`.
    pub deploy: Option<DeployFlags>,
    /// `--config <relay.json>` when it is among the arguments (Meeting Hub).
    pub config: Option<PathBuf>,
}

/// The values the operator sets on the host (AC-2b-D 6.3, H1). No option claims that the console installed the
/// program: only the installer marker does (6.3 step 4, invariant D14).
#[derive(Debug, PartialEq, Eq, Clone, Default)]
pub struct DeployFlags {
    /// `linux` or `docker`.
    pub env: String,
    /// `standard` or `high`.
    pub profile: String,
    /// Meeting Hub: `console` or `own`.
    pub pki: Option<String>,
    pub admins: Option<Vec<String>>,
    pub host: Option<String>,
    pub turn_host: Option<String>,
    pub clients: Option<Vec<String>>,
    pub env_out: Option<PathBuf>,
}

pub const ENROLL_USAGE: &str = "usage: lucid-relay enroll <console URL> [--code-file <path> | --code-fd <n>] [--fleet-admin-key <fingerprint>]... [--yes] (the code is asked for, never given on the command line)";
pub const DEPLOY_USAGE: &str = "usage: lucid-relay [meet] enroll <console URL> --deploy <linux or docker> --profile <standard or high> [--pki <console or own>] [--admins <email,...>] [--host <name>] [--turn-host <name or address>] [--clients <CIDR,...>] [--deploy-env-out <path>] [--code-file <path>] [--yes]";

/// A relay DNS name (AC-2b-D 3.4): 1 to 253 characters, labels of `a-z 0-9 -`, lower-cased.
pub fn dns_name_ok(s: &str) -> bool {
    (1..=253).contains(&s.len()) && s.split('.').all(|l| (1..=63).contains(&l.len()) && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

/// An email as the relay admins take it (lower-cased): one `@`, a local part and a dotted domain, no spaces.
pub fn email_ok(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    s.len() <= 254 && !local.is_empty() && !domain.contains('@') && domain.contains('.') && dns_name_ok(domain) && !s.chars().any(|c| c.is_whitespace() || c.is_control() || c == ',' || c == '"')
}

/// `--admins`: 1 to 16 emails separated by commas, lower-cased.
pub fn parse_admins(text: &str) -> Result<Vec<String>, String> {
    let list: Vec<String> = text.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect();
    if list.is_empty() || list.len() > 16 || !list.iter().all(|e| email_ok(e)) {
        return Err("give 1 to 16 relay admin email addresses, separated by commas".into());
    }
    Ok(list)
}

fn parse_clients(text: &str) -> Result<Vec<String>, String> {
    let list: Vec<String> = text.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    crate::console_source::parse_cidrs(&list, 16).map_err(|_| Refusal::of("deploy-clients").error)?;
    Ok(list)
}

pub fn parse_enroll_args(args: &[String]) -> Result<EnrollArgs, String> {
    let (mut url, mut code, mut keys, mut yes) = (None, CodeFrom::Prompt, Vec::new(), false);
    let mut config = None;
    let mut d = DeployFlags::default();
    let mut deploy_seen = false;
    let mut other_seen = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "enroll" if url.is_none() && keys.is_empty() => {}
            "--state" => {
                it.next().ok_or(ENROLL_USAGE)?;
            }
            "--config" => {
                config = Some(PathBuf::from(it.next().ok_or(ENROLL_USAGE)?));
            }
            "--deploy" => {
                let v = next_value(&mut it)?;
                if deploy_seen || !matches!(v.as_str(), "linux" | "docker") {
                    return Err(DEPLOY_USAGE.into());
                }
                deploy_seen = true;
                d.env = v;
            }
            "--profile" => {
                let v = next_value(&mut it)?;
                if !d.profile.is_empty() || !matches!(v.as_str(), "standard" | "high") {
                    return Err(DEPLOY_USAGE.into());
                }
                other_seen = true;
                d.profile = v;
            }
            "--pki" => {
                let v = next_value(&mut it)?;
                if d.pki.is_some() || !matches!(v.as_str(), "console" | "own") {
                    return Err(DEPLOY_USAGE.into());
                }
                other_seen = true;
                d.pki = Some(v);
            }
            "--admins" => {
                other_seen = true;
                d.admins = Some(parse_admins(&next_value(&mut it)?)?);
            }
            "--host" => {
                let v = next_value(&mut it)?.to_ascii_lowercase();
                if !(dns_name_ok(&v) || v.parse::<std::net::IpAddr>().is_ok()) {
                    return Err(Refusal::of("deploy-host").error);
                }
                other_seen = true;
                d.host = Some(v);
            }
            "--turn-host" => {
                let v = next_value(&mut it)?.to_ascii_lowercase();
                if !(v.is_empty() || dns_name_ok(&v) || v.parse::<std::net::IpAddr>().is_ok()) {
                    return Err(Refusal::of("deploy-host").error);
                }
                other_seen = true;
                d.turn_host = Some(v);
            }
            "--clients" => {
                other_seen = true;
                d.clients = Some(parse_clients(&next_value(&mut it)?)?);
            }
            "--deploy-env-out" => {
                other_seen = true;
                d.env_out = Some(PathBuf::from(next_value(&mut it)?));
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
    // the host values are set only with --deploy, and --deploy needs its profile
    if other_seen && !deploy_seen {
        return Err(DEPLOY_USAGE.into());
    }
    let deploy = if deploy_seen {
        if d.profile.is_empty() {
            return Err(DEPLOY_USAGE.into());
        }
        Some(d)
    } else {
        None
    };
    Ok(EnrollArgs { url, code, admin_keys: keys, yes, deploy, config })
}

fn next_value(it: &mut std::slice::Iter<'_, String>) -> Result<String, String> {
    it.next().cloned().ok_or_else(|| DEPLOY_USAGE.to_owned())
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
    enroll_cli_with(product, state_dir, None, args)
}

/// `enroll_cli` with the Meeting Hub `relay.json` path (meet.rs takes `--config` out of the arguments; with
/// `--deploy` the program writes that file when it is absent, AC-2b-D 6.3 step 9).
pub fn enroll_cli_with(product: Product, state_dir: &Path, config: Option<&Path>, args: &[String]) -> Result<String, String> {
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
    let deploy_preview = p.get("deploy").is_some_and(Value::is_object);
    if let Some(flags) = a.deploy.as_ref() {
        let config = config.map(Path::to_path_buf).or_else(|| a.config.clone());
        let marker = PathBuf::from(marker_path(product, &flags.env));
        let mut c = DeployCli { product, state_dir, config: config.as_deref(), args: &a, flags, code: &code, term: &mut term, marker };
        return c.run(code_text.expose(), &p);
    }
    // AC-2b-D 6.3 step 1 (H2): a plain enroll never acts on a deploy preview
    if deploy_preview {
        return Err(w::cli_words("cli.deploy-needs-deploy").to_owned());
    }
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
    let a = Apply { console, state_dir, product, version, url, preview_hash: ph, admin_keys, confirmed_by: "local-console", proxy: proxy.as_deref(), deploy: None };
    run_blocking(apply(a, &code))?;
    wake(state_dir);
    Ok(())
}

// ── AC-2b-D 6.3 to 6.7 and 7: deploy ────────────────────────────────────────────────────────────────────────

/// The installer marker's fixed paths (6.3 step 4, invariant D14): written by the served script only.
pub const MARKER_MEET: &str = "/opt/lucid-meet/.lucid-deploy";
pub const MARKER_SPOKES: &str = "/opt/lucid-relay/.lucid-deploy";
pub const MARKER_DOCKER: &str = "/usr/local/lib/lucid-deploy";
/// 6.3 step 10: the file the script reads `HOST`, `TURN_HOST`, `CLIENTS` and `PKI` from.
pub const DEPLOY_ENV_OUT: &str = "/run/lucid-relay-deploy.env";
/// 2.4: the Meeting Hub certificate folder under the state folder, and the root CRL file.
pub const PKI_DIR: &str = "pki";
pub const CRL_ROOT: &str = "crl-root.pem";
/// 8.4: the signer client certificate's SAN URI.
pub const SIGNER_URI: &str = "urn:lucid-meet:relay";
const MARKER_MAX_AGE_S: i64 = 3600;
/// 6.4: the apply before the listeners has 60 s.
const APPLY_LIMIT: Duration = Duration::from_secs(60);
/// 7.3: the files a fresh state folder may hold (besides the `pki/` folder and the installer's `deploy/` folder).
pub const FRESH_FILES: [&str; 7] = ["console-secrets.json", "console-seal.key", "console.lock", "fleet.lock", "fleet-pending.json", "fleet-local.json", "fleet-local.lock"];

/// The marker path for a product and `--deploy` environment.
pub fn marker_path(product: Product, env: &str) -> &'static str {
    match (env, product) {
        ("docker", _) => MARKER_DOCKER,
        (_, Product::Meet) => MARKER_MEET,
        (_, Product::Spokes) => MARKER_SPOKES,
    }
}

/// What the installer marker looks like on disk (read without following a link; a swapped file counts as not
/// regular).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarkerFacts {
    pub uid: u32,
    pub mode: u32,
    pub symlink: bool,
    pub regular: bool,
    pub enrollment: Option<String>,
    pub sha256: Option<String>,
    /// Unix seconds.
    pub at: Option<i64>,
}

/// The marker at `path`, or None when there is none.
pub fn read_marker(path: &Path) -> Option<MarkerFacts> {
    let before = std::fs::symlink_metadata(path).ok()?;
    let mut f = MarkerFacts { uid: u32::MAX, ..MarkerFacts::default() };
    if before.file_type().is_symlink() {
        f.symlink = true;
        return Some(f);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        f.uid = before.uid();
        f.mode = before.mode() & 0o7777;
    }
    f.regular = before.is_file();
    if !f.regular {
        return Some(f);
    }
    let Ok(file) = std::fs::File::open(path) else {
        f.regular = false;
        return Some(f);
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // the file read is the file checked
        if file.metadata().map(|m| (m.ino(), m.dev())).ok() != Some((before.ino(), before.dev())) {
            f.regular = false;
            return Some(f);
        }
    }
    let mut data = Vec::new();
    if file.take(4096).read_to_end(&mut data).is_ok() {
        if let Some(v) = std::str::from_utf8(&data).ok().and_then(parse_json) {
            f.enrollment = v.get("enrollment").and_then(Value::as_str).map(str::to_owned);
            f.sha256 = v.get("sha256").and_then(Value::as_str).map(str::to_ascii_lowercase);
            f.at = v.get("at").and_then(Value::as_i64);
        }
    }
    Some(f)
}

/// 6.3 step 4: console-installed only when the local profile is Standard and the marker is a regular file owned by
/// root, writable by no one else, naming the code's enrollment, holding the SHA-256 of the running program equal to
/// the preview's `binarySha256`, and less than an hour old. No flag stands in for it. The words, when given, say that
/// the marker was fetched for another code (`cli.deploy-marker-other`).
pub fn console_installed(marker: Option<&MarkerFacts>, high: bool, code_enrollment: &str, exe_sha256: Option<&str>, preview_sha256: Option<&str>, now_s: i64) -> (bool, Option<String>) {
    let Some(m) = marker else { return (false, None) };
    let other = m.enrollment.as_deref().filter(|e| *e != code_enrollment).map(|e| w::fill(w::cli_words("cli.deploy-marker-other"), &[("marker enrollment", e)]));
    let exe = exe_sha256.filter(|e| !e.is_empty());
    let ok = !high
        && !m.symlink
        && m.regular
        && m.uid == 0
        && m.mode & 0o022 == 0
        && m.enrollment.as_deref() == Some(code_enrollment)
        && exe.is_some()
        && m.sha256.as_deref() == exe
        && preview_sha256.map(str::to_ascii_lowercase).as_deref() == exe
        && m.at.is_some_and(|at| now_s - at < MARKER_MAX_AGE_S && at - now_s <= 300);
    (ok, other)
}

/// 7.3: a state folder that holds nothing of an earlier relay.
pub fn is_fresh(state_dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(state_dir) else { return false };
    rd.flatten().all(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let dir = e.file_type().is_ok_and(|t| t.is_dir());
        FRESH_FILES.contains(&name.as_str()) || (dir && (name == PKI_DIR || name == "deploy"))
    })
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Some(hex(ctx.finish().as_ref()))
}

/// The SHA-256 of the running program (`/proc/self/exe` on Linux).
pub fn own_exe_sha256() -> Option<String> {
    if cfg!(target_os = "linux") {
        file_sha256(Path::new("/proc/self/exe"))
    } else {
        file_sha256(&std::env::current_exe().ok()?)
    }
}

/// The `m_` ids of every self-signed certificate in a `client_ca` file (empty before one exists).
pub fn meet_roots_of(client_ca: &Path) -> Vec<String> {
    std::fs::read(client_ca).map(|b| crate::license::meet_roots(&b)).unwrap_or_default()
}

/// The org root node id of a `root.pub` PEM (`PUBLIC KEY`, P-256), or None.
pub fn spokes_root_id_of_pem(pem: &str) -> Option<String> {
    let (_, spki) = crate::meet_x509::pem_blocks(pem.as_bytes(), "PUBLIC KEY").into_iter().next()?;
    x509::is_p256_spki(&spki).then(|| crate::identity::node_id_of(&spki))
}

fn spokes_root_id(path: &Path) -> Option<String> {
    spokes_root_id_of_pem(&std::fs::read_to_string(path).ok()?)
}

/// The names a Meeting Hub relay's server certificate carries (6.5): the DNS name, then the TURN name when it
/// differs.
pub fn meet_names(dv: &Value) -> Vec<String> {
    let host = dv.get("host").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let turn = dv.get("turnHost").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let mut out = vec![host.clone()];
    if !turn.is_empty() && turn != host {
        out.push(turn);
    }
    out
}

fn split_names(names: &[String]) -> (Vec<String>, Vec<std::net::IpAddr>) {
    let mut dns = Vec::new();
    let mut ips = Vec::new();
    for n in names {
        match n.parse::<std::net::IpAddr>() {
            Ok(ip) => ips.push(ip),
            Err(_) => dns.push(n.clone()),
        }
    }
    (dns, ips)
}

/// A license of the preview checked with the publisher key compiled into this program (AC-1 4.7): product, root,
/// not issued in the future, and in date (`exp` not passed; grace not counted).
fn license_check(lic: &Value, product: Product, roots: &[String], now_s: i64) -> Result<crate::license::License, String> {
    let token = lic.get("token").and_then(Value::as_str).ok_or("no license token")?;
    let env = |k: &str| std::env::var(k).ok();
    let keys = crate::license::license_keys(env)?;
    let c = crate::license::verify_license_for(token, product, roots, &keys, now_s)?;
    if c.license.exp <= now_s {
        return Err("expired".into());
    }
    Ok(c.license)
}

/// Where the organization root in use comes from (6.3 step 5, 6.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootSource {
    Placed,
    Delivered,
}

/// What 6.3 steps 1 to 5 decided: the values set on the host and the organization root in use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeployPlan {
    pub host: String,
    pub turn_host: String,
    pub clients: Vec<String>,
    pub root: (String, RootSource),
}

/// The local facts 6.3 judges a preview against (H1: all set on the host).
pub struct DeployLocal<'a> {
    pub product: Product,
    /// `--deploy <env>`; None for a plain `enroll`.
    pub flag: Option<&'a str>,
    pub high: bool,
    pub pki: Option<&'a str>,
    pub host: Option<&'a str>,
    pub turn_host: Option<&'a str>,
    pub clients: Option<&'a [String]>,
    /// The `m_` id of a placed `pki/ca.crt`, and whether `pki/current/relay.crt` is placed (Meeting Hub).
    pub placed_ca: Option<&'a str>,
    pub placed_cert: bool,
    /// The node id of a placed `deploy/root.pub` (Remote Spokes).
    pub placed_root: Option<&'a str>,
    pub console_installed: bool,
    /// The profile of a kept configuration.
    pub kept_profile: Option<&'a str>,
}

fn same_env(preview: &str, flag: &str) -> bool {
    // a Proxmox code runs the Linux installer inside the VM
    preview == flag || (preview == "proxmox" && flag == "linux")
}

fn pki_words(p: &str) -> &'static str {
    match p {
        "console" => "the organization CA held by the console",
        "own" => "its own certificate files",
        _ => "nothing",
    }
}

fn same_set(a: &[String], b: &[String]) -> bool {
    let norm = |v: &[String]| {
        let mut v: Vec<String> = v.iter().map(|s| s.trim().to_ascii_lowercase()).collect();
        v.sort();
        v.dedup();
        v
    };
    norm(a) == norm(b)
}

/// 6.3 steps 1 to 5 and the anchor rules of 6.5 and 6.7, in order; Err is the words of the first refusal (nothing
/// has been written). Ok(None): a plain `enroll` of an `installed` code. `root_license_ok(license, id)`: the 6.7
/// license check of a delivered Remote Spokes root.
pub fn deploy_decide(l: &DeployLocal, preview: &Value, root_license_ok: &dyn Fn(&Value, &str) -> bool) -> Result<Option<DeployPlan>, String> {
    let words = |id: &str| w::cli_words(id).to_owned();
    let (dv, flag) = match (preview.get("deploy").filter(|d| d.is_object()), l.flag) {
        (None, None) => return Ok(None),
        (None, Some(_)) => return Err(words("cli.deploy-not-deploy")),
        (Some(_), None) => return Err(words("cli.deploy-needs-deploy")),
        (Some(d), Some(f)) => (d, f),
    };
    let s = |k: &str| dv.get(k).and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    // step 1
    let env = s("env");
    if !same_env(&env, flag) {
        return Err(w::fill(w::cli_words("cli.deploy-env"), &[("env", &env), ("this env", flag)]));
    }
    // step 2: the local values first
    let profile = if l.high { "high" } else { "standard" };
    if let Some(k) = l.kept_profile.filter(|k| *k != profile) {
        return Err(w::fill(w::cli_words("cli.deploy-profile-changed"), &[("profile", k)]));
    }
    let policy_high = preview["policy"]["profile"] == json!("high");
    if l.high && !policy_high {
        return Err(words("cli.enroll-high-standard"));
    }
    if !l.high && policy_high {
        return Err(words("cli.deploy-profile"));
    }
    let meet = l.product == Product::Meet;
    let ppki = s("pki");
    if meet && l.pki != Some(ppki.as_str()) {
        return Err(w::fill(w::cli_words("cli.deploy-pki"), &[("source", pki_words(&ppki)), ("other", pki_words(l.pki.unwrap_or_default()))]));
    }
    let differs = |field: &str, console: &str, host: &str| w::fill(w::cli_words("cli.deploy-host-differs"), &[("field", field), ("console value", console), ("host value", host)]);
    let p_host = s("host");
    let host = match l.host.map(str::to_ascii_lowercase) {
        Some(h) if l.high && h != p_host => return Err(differs("the relay DNS name", &p_host, &h)),
        Some(h) => h,
        None if l.high => return Err(differs("the relay DNS name", &p_host, "")),
        None => p_host.clone(),
    };
    let mut turn_host = String::new();
    let mut clients = Vec::new();
    if meet {
        let p_turn = Some(s("turnHost")).filter(|t| !t.is_empty()).unwrap_or_else(|| p_host.clone());
        let local = l.turn_host.map(|t| if t.is_empty() { host.clone() } else { t.to_ascii_lowercase() });
        turn_host = match local {
            Some(t) if l.high && t != p_turn => return Err(differs("the TURN name", &p_turn, &t)),
            Some(t) => t,
            None if l.high => return Err(differs("the TURN name", &p_turn, "")),
            None => p_turn,
        };
    } else {
        let p_clients: Vec<String> = dv.get("clients").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        clients = match l.clients {
            Some(c) if l.high && !same_set(c, &p_clients) => return Err(differs("the client networks", &p_clients.join(", "), &c.join(", "))),
            Some(c) => c.to_vec(),
            None if l.high => return Err(differs("the client networks", &p_clients.join(", "), "")),
            None => p_clients,
        };
    }
    // step 3: a High relay takes nothing of trust from the console, and needs its files placed
    let offered = dv.get("offered").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let ca = dv.get("ca").filter(|c| c.is_object());
    let spokes_root = dv.get("spokesRoot").filter(|c| c.is_object());
    if l.high {
        if ppki == "console" || offered || ca.is_some() || spokes_root.is_some() {
            return Err(words("cli.deploy-high-preview"));
        }
        let placed = if meet { l.placed_ca.is_some() && l.placed_cert } else { l.placed_root.is_some() };
        if !placed {
            return Err(words("cli.deploy-anchor"));
        }
    }
    // step 5: placed roots against the preview's
    let ca_id = ca.and_then(|c| c.get("id")).and_then(Value::as_str);
    let root_id = spokes_root.and_then(|c| c.get("id")).and_then(Value::as_str);
    let named = if meet { ca_id } else { root_id };
    let placed = if meet { l.placed_ca } else { l.placed_root };
    if let (Some(p), Some(id)) = (placed, named) {
        if p != id {
            return Err(w::fill(w::cli_words("cli.deploy-root-differs"), &[("id", id), ("placed id", p)]));
        }
    }
    // 6.5 and 6.7: the root in use, placed or (console-installed only) delivered
    let root = match (placed, named) {
        (Some(p), _) => (p.to_owned(), RootSource::Placed),
        (None, Some(id)) if l.console_installed && !l.high && meet && ppki == "console" => (id.to_owned(), RootSource::Delivered),
        (None, Some(id)) if l.console_installed && !l.high && !meet && root_license_ok(dv.get("license").unwrap_or(&Value::Null), id) => (id.to_owned(), RootSource::Delivered),
        _ => return Err(words("cli.deploy-anchor")),
    };
    Ok(Some(DeployPlan { host, turn_host, clients, root }))
}

/// `cli.deploy-preview` (13.4); Remote Spokes has no TURN, relay admins or certificate lines.
pub fn deploy_preview_text(product: Product, plan: &DeployPlan, admins: &[String], profile: &str, pki: Option<&str>, dv: &Value) -> String {
    let cert = if pki == Some("console") { w::cli_words("cli.deploy-source-console-ca") } else { w::cli_words("cli.deploy-source-placed") };
    let source = match plan.root.1 {
        RootSource::Placed => w::cli_words("cli.deploy-source-placed"),
        RootSource::Delivered => w::cli_words("cli.deploy-source-delivered"),
    };
    let license = match dv.get("license").filter(|l| l.is_object()) {
        Some(l) => w::fill(w::cli_words("cli.deploy-license-line"), &[
            ("org", l["org"].as_str().unwrap_or_default()),
            ("edition", l["edition"].as_str().unwrap_or_default()),
            ("users", &l["users"].as_i64().unwrap_or(0).to_string()),
            ("date", &crate::meet_json::iso_date(l["exp"].as_i64().unwrap_or(0))),
        ]),
        None => w::cli_words("cli.deploy-license-none").to_owned(),
    };
    let text = w::fill(w::cli_words("cli.deploy-preview"), &[
        ("host", &plan.host),
        ("turnHost", &plan.turn_host),
        ("admins", &admins.join(", ")),
        ("profile", profile),
        ("certificate source", cert),
        ("id", &plan.root.0),
        ("root source", source),
        ("license line", &license),
    ]);
    if product == Product::Meet {
        return text;
    }
    text.lines().filter(|l| !(l.starts_with("TURN:") || l.starts_with("Relay admins:") || l.starts_with("Certificate:"))).collect::<Vec<_>>().join("\n")
}

/// The deploy env file's values: the characters of the 5.1 safe pattern and the comma.
fn env_value_ok(v: &str) -> bool {
    v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:/+=;[],-".contains(&b))
}

/// 6.3 step 10: `HOST`, `TURN_HOST`, `CLIENTS`, `PKI`, root-only (0600), created new (a planted link is not followed).
fn write_env_file(path: &Path, plan: &DeployPlan, pki: Option<&str>) -> Result<(), String> {
    let clients = plan.clients.join(",");
    let vals = [("HOST", plan.host.as_str()), ("TURN_HOST", plan.turn_host.as_str()), ("CLIENTS", clients.as_str()), ("PKI", pki.unwrap_or_default())];
    if !vals.iter().all(|(_, v)| env_value_ok(v)) {
        return Err("a deploy value holds characters the installer does not take".into());
    }
    let text: String = vals.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
    crate::store::remove(path);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("{} could not be written: {e}", path.display()))
}

/// 6.3 step 9: the Meeting Hub `relay.json`, written only when absent (later edits by the operator are kept); 0640
/// root and the state folder's group, or 0600 to the container's user under Docker.
fn write_relay_json(path: &Path, state_dir: &Path, plan: &DeployPlan, admins: &[String], f: &DeployFlags, dv: &Value) -> Result<(), String> {
    let st = state_dir.to_string_lossy().into_owned();
    let pki_console = f.pki.as_deref() == Some("console");
    let mut m = json!({
        "host": "0.0.0.0", "port": 443,
        "cert": format!("{st}/pki/current/relay.crt"), "key": format!("{st}/pki/current/relay.key"), "client_ca": format!("{st}/pki/ca.crt"), "crl": "",
        "turn_secret_file": "/etc/lucid-meet/turn.secret", "turn_host": plan.turn_host, "state_dir": st, "admins": admins, "license": "",
        "fleet_pki": pki_console, "console_profile": f.profile,
    });
    if pki_console {
        if let Some(url) = dv.get("signer").and_then(|s| s.get("url")).and_then(Value::as_str) {
            m["signer_url"] = json!(url);
            m["signer_cert"] = json!(format!("{st}/pki/current/signer-client.crt"));
            m["signer_key"] = json!(format!("{st}/pki/current/signer-client.key"));
            m["signer_ca"] = json!("");
        }
    }
    let docker = f.env == "docker";
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(if docker { 0o600 } else { 0o640 });
    }
    let mut file = o.open(path).map_err(|e| format!("{} could not be created: {e}", path.display()))?;
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())? + "\n";
    file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if !docker && unsafe { geteuid() } == 0 {
            let gid = std::fs::metadata(state_dir).map(|m| m.gid()).ok();
            std::os::unix::fs::chown(path, Some(0), gid).map_err(|e| format!("{} could not be given to the relay's group: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{} cannot be read: {e}", path.display()))?;
    parse_json(&text).filter(Value::is_object).ok_or_else(|| format!("{} does not read", path.display()))
}

fn strings_of(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_ascii_lowercase()).filter(|x| !x.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// `lucid-relay [meet] enroll ... --deploy <env>` (6.3), run by the install script as root with the terminal as its
/// standard input and output.
struct DeployCli<'a> {
    product: Product,
    state_dir: &'a Path,
    config: Option<&'a Path>,
    args: &'a EnrollArgs,
    flags: &'a DeployFlags,
    code: &'a Code,
    term: &'a mut dyn Term,
    /// The installer marker's path (`marker_path`; tests use their own folder).
    marker: PathBuf,
}

impl DeployCli<'_> {
    fn say(&mut self, s: &str) {
        self.term.write(s);
        self.term.write("\n");
    }

    /// A prompt on the terminal; None without one.
    fn ask(&mut self, prompt: &str) -> Option<String> {
        if !self.term.is_terminal() {
            return None;
        }
        self.term.write(prompt);
        self.term.read_line().map(|l| l.trim().to_owned())
    }

    fn run(&mut self, code_text: &str, p: &Value) -> Result<String, String> {
        let f = self.flags;
        let meet = self.product == Product::Meet;
        if meet && (self.config.is_none() || f.pki.is_none() || f.clients.is_some()) {
            return Err(DEPLOY_USAGE.into());
        }
        if !meet && (f.pki.is_some() || f.admins.is_some() || f.turn_host.is_some()) {
            return Err(DEPLOY_USAGE.into());
        }
        let high = f.profile == "high";
        let dv = p.get("deploy").filter(|d| d.is_object()).cloned().unwrap_or(Value::Null);
        let kept = match self.config.filter(|c| c.exists()) {
            Some(c) => Some(read_json_file(c)?),
            None => None,
        };
        let kept_profile = kept.as_ref().map(|k| if k.get("console_profile").and_then(Value::as_str).map(str::trim) == Some("high") { "high" } else { "standard" });
        // the roots placed on this host (6.3 step 5)
        let pki = self.state_dir.join(PKI_DIR);
        let placed_ca = if meet { meet_roots_of(&pki.join("ca.crt")).into_iter().next() } else { None };
        let placed_cert = pki.join("current").join("relay.crt").is_file();
        let placed_root = if meet { None } else { spokes_root_id(&self.state_dir.join("deploy").join("root.pub")) };
        // step 4: the installer marker
        let marker_at = self.marker.clone();
        let marker = read_marker(&marker_at);
        let exe = own_exe_sha256();
        let now_s = now_ms() / 1000;
        let (installed, other) = console_installed(marker.as_ref(), high, &self.code.id(), exe.as_deref(), dv.get("binarySha256").and_then(Value::as_str), now_s);
        if let Some(words) = other {
            self.say(&words);
        }
        let fresh = is_fresh(self.state_dir);
        // step 2: under High the host values are required (a flag or the terminal)
        let mut host = f.host.clone();
        let mut turn = f.turn_host.clone();
        let mut clients = f.clients.clone();
        if high {
            if host.is_none() {
                host = self.ask(w::cli_words("cli.deploy-ask-host")).map(|h| h.to_ascii_lowercase()).filter(|h| dns_name_ok(h) || h.parse::<std::net::IpAddr>().is_ok());
            }
            if meet && turn.is_none() {
                turn = self.ask(w::cli_words("cli.deploy-ask-turn-host")).map(|h| h.to_ascii_lowercase()).filter(|h| h.is_empty() || dns_name_ok(h) || h.parse::<std::net::IpAddr>().is_ok());
            }
            if !meet && clients.is_none() {
                clients = self.ask(w::cli_words("cli.deploy-ask-clients")).and_then(|c| parse_clients(&c).ok());
            }
        }
        let local = DeployLocal {
            product: self.product,
            flag: Some(f.env.as_str()),
            high,
            pki: f.pki.as_deref(),
            host: host.as_deref(),
            turn_host: turn.as_deref(),
            clients: clients.as_deref(),
            placed_ca: placed_ca.as_deref(),
            placed_cert,
            placed_root: placed_root.as_deref(),
            console_installed: installed,
            kept_profile,
        };
        let lic_ok = |lic: &Value, id: &str| license_check(lic, Product::Spokes, &[id.to_owned()], now_s).is_ok();
        let plan = deploy_decide(&local, p, &lic_ok)?.ok_or_else(|| w::cli_words("cli.deploy-not-deploy").to_owned())?;
        self.say(&w::fill(w::cli_words("cli.deploy-root-id"), &[("id", &plan.root.0)]));
        // step 6: the relay admins (Meeting Hub)
        let admins = if meet { self.admins(kept.as_ref())? } else { Vec::new() };
        // step 7: ceremony B fingerprints, then the console-offered key (C-prime)
        let mut keys = self.args.admin_keys.clone();
        if self.term.is_terminal() {
            self.fingerprints(&mut keys);
        }
        let accepted = self.offered(&dv, &admins, installed && fresh && !high);
        // step 8
        println!("{}", preview_text(p));
        println!("{}", deploy_preview_text(self.product, &plan, &admins, &f.profile, f.pki.as_deref(), &dv));
        let failed = |why: &str| w::fill(w::cli_words("cli.enroll-failed"), &[("why", why)]);
        if !self.args.yes {
            self.term.write(w::cli_words("cli.enroll-ask"));
            if self.term.read_line().map(|l| l.trim().to_ascii_lowercase()) != Some("yes".into()) {
                return Err(failed("not confirmed"));
            }
        }
        // step 9: relay.json when absent
        if let (true, None, Some(config)) = (meet, kept.as_ref(), self.config) {
            write_relay_json(config, self.state_dir, &plan, &admins, f, &dv).map_err(|e| failed(e.as_str()))?;
        }
        // step 10: the env file, the handoff, then the marker goes
        let out = f.env_out.clone().unwrap_or_else(|| PathBuf::from(DEPLOY_ENV_OUT));
        write_env_file(&out, &plan, f.pki.as_deref()).map_err(|e| failed(e.as_str()))?;
        let ci = if installed { json!({ "enrollment": self.code.id(), "sha256": exe }) } else { Value::Null };
        let content = json!({
            "url": self.args.url, "code": code_text, "previewHash": p["previewHash"], "confirmedBy": if self.args.yes { "flag" } else { "prompt" },
            "adminKeys": keys, "at": now_ms(),
            "deploy": { "env": f.env, "consoleInstalled": ci, "fresh": fresh, "offeredAccepted": accepted },
        });
        write_handoff(self.state_dir, &content).map_err(|e| failed(e.as_str()))?;
        if f.env != "docker" && marker.is_some() {
            crate::store::remove(&marker_at);
        }
        Ok(w::cli_words("cli.deploy-next").to_owned())
    }

    /// 6.3 step 6: `--admins`, else the kept configuration's, else the terminal (no default).
    fn admins(&mut self, kept: Option<&Value>) -> Result<Vec<String>, String> {
        let kept = strings_of(kept.and_then(|k| k.get("admins")));
        if !kept.is_empty() {
            return Ok(kept);
        }
        if let Some(a) = &self.flags.admins {
            return Ok(a.clone());
        }
        if !self.term.is_terminal() {
            return Err(w::cli_words("cli.deploy-admins-needed").to_owned());
        }
        for _ in 0..3 {
            let Some(line) = self.ask(w::cli_words("cli.deploy-ask-admins")) else { break };
            match parse_admins(&line) {
                Ok(list) => return Ok(list),
                Err(e) => self.say(&e),
            }
        }
        Err(w::cli_words("cli.deploy-admins-needed").to_owned())
    }

    /// 6.3 step 7: ceremony B fingerprints, one per line, until an empty line.
    fn fingerprints(&mut self, keys: &mut Vec<String>) {
        self.term.write(w::cli_words("cli.deploy-ask-fingerprints"));
        for _ in 0..64 {
            let Some(line) = self.term.read_line() else { break };
            let fp: String = line.chars().filter(|c| !c.is_whitespace() && *c != ':').collect::<String>().to_ascii_lowercase();
            if fp.is_empty() {
                break;
            }
            if fp.len() == 64 && fp.bytes().all(|b| b.is_ascii_hexdigit()) {
                if !keys.contains(&fp) {
                    keys.push(fp);
                }
            } else {
                self.say("an admin key fingerprint is 64 hex characters");
            }
        }
    }

    /// 7.3 (C-prime): each console-offered key of an admin in this relay's admins, only on a console-installed,
    /// fresh, Standard relay with a terminal, trusted only on a typed `yes`.
    fn offered(&mut self, dv: &Value, admins: &[String], eligible: bool) -> Vec<String> {
        let list = dv.get("offered").and_then(Value::as_array).cloned().unwrap_or_default();
        if list.is_empty() {
            return Vec::new();
        }
        let mut accepted = Vec::new();
        let mut skipped = !eligible || !self.term.is_terminal();
        if !skipped {
            for o in &list {
                let email = o.get("email").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
                let fp = o.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
                let ok = o.get("role").and_then(Value::as_str) == Some("admin") && (self.product != Product::Meet || admins.contains(&email)) && fp.len() == 64 && fp.bytes().all(|b| b.is_ascii_hexdigit());
                if !ok {
                    skipped = true;
                    continue;
                }
                let prompt = w::fill(w::cli_words("cli.deploy-offered-key"), &[("email", &email), ("hint", o.get("hint").and_then(Value::as_str).unwrap_or_default()), ("fingerprint", &fp)]);
                self.term.write(&prompt);
                if self.term.read_line().map(|l| l.trim().to_ascii_lowercase()) == Some("yes".into()) {
                    accepted.push(fp);
                }
            }
        }
        if skipped {
            self.say(w::cli_words("cli.deploy-not-offered"));
        }
        accepted
    }
}

fn pem_text(label: &str, der: &[u8]) -> String {
    let b = crate::meet_json::b64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for c in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(c).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn first_der(pem: &str, kind: &str) -> Option<Vec<u8>> {
    crate::meet_x509::pem_blocks(pem.as_bytes(), kind).into_iter().next().map(|(_, der)| der)
}

/// A key file the relay draws for itself (6.5): PKCS#8 PEM, 0600, created new, owned by the relay's user.
fn write_key(path: &Path, key: &Key) -> Result<(), String> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path).map_err(|e| format!("{} could not be created: {e}", path.display()))?;
    f.write_all(pem_text("PRIVATE KEY", key.pkcs8()).as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())
}

/// Overwrite every file of a folder, then remove it (a discarded or superseded key folder).
fn wipe_dir(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(m) = std::fs::symlink_metadata(&p) {
                if m.is_file() {
                    let _ = std::fs::OpenOptions::new().write(true).open(&p).and_then(|mut f| f.write_all(&vec![0u8; m.len() as usize]).and_then(|_| f.sync_all()));
                }
            }
            let _ = std::fs::remove_file(&p);
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// Switch `pki/current` to `pki/<name>` by one rename of a new symbolic link (L9).
#[cfg(unix)]
fn switch_current(pki: &Path, name: &str) -> Result<(), String> {
    let tmp = pki.join(format!("current.new-{}", hex(&crate::console_auth::random(8).ok_or("no random bytes")?)));
    std::os::unix::fs::symlink(name, &tmp).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, pki.join("current")).map_err(|e| {
        crate::store::remove(&tmp);
        e.to_string()
    })
}

#[cfg(not(unix))]
fn switch_current(_pki: &Path, _name: &str) -> Result<(), String> {
    Err("pki/current is a symbolic link on Linux only".into())
}

/// `pki/current` of a state folder (the pair in use, 2.4).
pub fn pki_current(state_dir: &Path) -> PathBuf {
    state_dir.join(PKI_DIR).join("current")
}

/// The keys and requests a Meeting Hub relay drew for itself (6.5, 8.4) in `pki/new-<random>/`; the folder is
/// wiped on drop unless it was kept.
struct MeetRequests {
    dir: PathBuf,
    key: Option<Key>,
    signer: Option<Key>,
    names: Vec<String>,
    csr: Option<Vec<u8>>,
    signer_csr: Option<Vec<u8>>,
    keep: bool,
}

impl Drop for MeetRequests {
    fn drop(&mut self) {
        if !self.keep {
            wipe_dir(&self.dir);
        }
    }
}

/// What the console issued for a relay's requests, as checked.
struct MeetIssued {
    serial: String,
    not_after: i64,
    ca_pem: String,
    ca_id: String,
    crl_pem: String,
    signer_serial: Option<String>,
}

impl MeetRequests {
    /// A new folder with the keys for `server` and `signer` and their requests: the server request `CN=<host>`
    /// with SAN the DNS names and addresses, the signer request `CN=Lucid Meet Relay` with SAN URI
    /// `urn:lucid-meet:relay`; both ECDSA P-256 SHA-256 by keys drawn here.
    fn new_folder(pki: &Path, names: Vec<String>, server: bool, signer: bool) -> Result<MeetRequests, String> {
        let key = if server { Some(Key::generate(Curve::P256)?) } else { None };
        let skey = if signer { Some(Key::generate(Curve::P256)?) } else { None };
        crate::store::make_dir(pki).map_err(|e| e.to_string())?;
        let dir = pki.join(format!("new-{}", hex(&crate::console_auth::random(8).ok_or("no random bytes")?)));
        crate::store::make_dir(&dir).map_err(|e| e.to_string())?;
        let mut r = MeetRequests { dir, key, signer: skey, names, csr: None, signer_csr: None, keep: false };
        if let Some(k) = &r.key {
            let cn = r.names.first().cloned().ok_or("no relay DNS name")?;
            write_key(&r.dir.join("relay.key"), k)?;
            let (dns, ips) = split_names(&r.names);
            r.csr = Some(x509::csr(k, &cn, &dns, &ips, &[])?);
        }
        if let Some(k) = &r.signer {
            write_key(&r.dir.join("signer-client.key"), k)?;
            r.signer_csr = Some(x509::csr(k, "Lucid Meet Relay", &[], &[], &[SIGNER_URI.to_owned()])?);
        }
        Ok(r)
    }

    /// At enrollment: a server key and request, and a signer client one when the console names a certificate
    /// server.
    fn draw(pki: &Path, names: Vec<String>, signer: bool) -> Result<MeetRequests, String> {
        MeetRequests::new_folder(pki, names, true, signer)
    }

    /// One certificate of an answer, checked (6.5): it chains to the CA, names exactly this relay's names (the
    /// signer certificate its URI), has the one extended key usage, is in date, is not a CA and holds our key.
    fn check_leaf(pem: Option<&str>, key: &Key, server: bool, names: &[String], ca: &crate::meet_x509::Cert, t: i64) -> Result<(crate::meet_x509::Cert, String), String> {
        let bad = || "the relay certificate is not the one requested".to_owned();
        let pem = pem.ok_or_else(bad)?;
        let der = first_der(pem, "CERTIFICATE").ok_or_else(bad)?;
        let c = crate::meet_x509::Cert::from_der(&der).ok_or_else(bad)?;
        let u = x509::usage(&der).ok_or_else(bad)?;
        let (dns, _) = split_names(names);
        let sorted = |v: &[String]| {
            let mut v: Vec<String> = v.iter().map(|s| s.to_ascii_lowercase()).collect();
            v.sort();
            v
        };
        let names_ok = if server { sorted(&c.names.dns) == sorted(&dns) && c.names.uris.is_empty() } else { c.names.uris == [SIGNER_URI.to_owned()] && c.names.dns.is_empty() };
        let eku_ok = if server { u.server_auth_only() } else { u.client_auth_only() };
        if !c.issued_by(ca) || c.ca || !x509::in_date(&c, t) || c.spki != key.spki() || !names_ok || !eku_ok {
            return Err(bad());
        }
        Ok((c, pem.to_owned()))
    }

    /// The enrollment answer's `meet` (6.5): `caCert` equal to the preview's `ca.pem`, each certificate as
    /// `check_leaf`, `crl` signed by the CA; then the certificates go into the new folder.
    fn check_answer(&mut self, dv: &Value, answer: &Value, t: i64) -> Result<MeetIssued, String> {
        let bad = |why: &str| why.to_owned();
        let m = answer.get("meet").filter(|m| m.is_object()).ok_or_else(|| bad("no meet answer"))?;
        let pem = |k: &str| m.get(k).and_then(Value::as_str);
        let ca_pem = pem("caCert").ok_or_else(|| bad("no CA"))?;
        let ca_der = first_der(ca_pem, "CERTIFICATE").ok_or_else(|| bad("no CA"))?;
        let want = dv.get("ca").and_then(|c| c.get("pem")).and_then(Value::as_str).and_then(|p| first_der(p, "CERTIFICATE"));
        if want.as_deref() != Some(ca_der.as_slice()) {
            return Err(bad("the CA is not the preview's"));
        }
        let ca = crate::meet_x509::Cert::from_der(&ca_der).ok_or_else(|| bad("no CA"))?;
        let key = self.key.as_ref().ok_or_else(|| bad("no key"))?;
        let (server, server_pem) = MeetRequests::check_leaf(pem("cert"), key, true, &self.names, &ca, t)?;
        let signer = match &self.signer {
            Some(k) => Some(MeetRequests::check_leaf(pem("signerCert"), k, false, &self.names, &ca, t)?),
            None if m.get("signerCert").is_some_and(|s| !s.is_null()) => return Err(bad("a signer certificate nobody asked for")),
            None => None,
        };
        let crl_pem = pem("crl").ok_or_else(|| bad("no CRL"))?;
        let crl = crate::meet_x509::Crl::from_pem(crl_pem.as_bytes()).ok_or_else(|| bad("no CRL"))?;
        if crl.issuer != ca.subject || !crl.signature_valid(&ca.spki) {
            return Err(bad("the CRL is not the CA's"));
        }
        crate::store::write_private(&self.dir.join("relay.crt"), server_pem.as_bytes()).map_err(|e| e.to_string())?;
        if let Some((_, p)) = &signer {
            crate::store::write_private(&self.dir.join("signer-client.crt"), p.as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(MeetIssued { serial: server.serial, not_after: server.not_after, ca_pem: ca_pem.to_owned(), ca_id: crate::license::meet_root_id(&ca.spki), crl_pem: crl_pem.to_owned(), signer_serial: signer.map(|(c, _)| c.serial) })
    }
}

/// 6.4: the local rules of 6.3 the relay can see as its own user, checked again at apply; a handoff that disagrees is
/// refused (`fleet.enroll-failed`, `why: "deploy-local"`).
fn recheck_local(d: &DeployApply, dv: &Value, code: &Code, state_dir: &Path, product: Product) -> Result<(), String> {
    let bad = || Err("deploy-local".to_owned());
    let Some(h) = d.handoff else { return bad() };
    let pki_console = dv.get("pki").and_then(Value::as_str) == Some("console");
    if product == Product::Meet && d.local.fleet_pki != pki_console {
        return bad();
    }
    if d.local.high && (d.local.fleet_pki || pki_console) {
        return bad();
    }
    if !same_env(dv.get("env").and_then(Value::as_str).unwrap_or_default(), h.get("env").and_then(Value::as_str).unwrap_or_default()) {
        return bad();
    }
    let ci = h.get("consoleInstalled").filter(|c| c.is_object());
    let accepted = h.get("offeredAccepted").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let fresh = h.get("fresh") == Some(&json!(true));
    if d.local.high && (ci.is_some() || accepted) {
        return bad();
    }
    if let Some(ci) = ci {
        let own = own_exe_sha256();
        let own = own.as_deref();
        if own.is_none() || ci.get("enrollment").and_then(Value::as_str) != Some(code.id().as_str()) || ci.get("sha256").and_then(Value::as_str) != own || dv.get("binarySha256").and_then(Value::as_str) != own {
            return bad();
        }
    }
    if accepted && (ci.is_none() || !fresh) {
        return bad();
    }
    if fresh && !d.fresh {
        return bad();
    }
    // a Meeting Hub relay that takes its certificate from the console needs the CA placed, or delivered to a
    // console-installed relay (6.5, 6.7)
    if product == Product::Meet && pki_console && ci.is_none() && meet_roots_of(&state_dir.join(PKI_DIR).join("ca.crt")).is_empty() {
        return bad();
    }
    Ok(())
}

/// 7.3 at apply: the fingerprints offered in the hashed preview that the operator accepted, on a console-installed,
/// fresh relay (its digest and folder were checked again by `recheck_local`).
fn offered_anchors(dv: &Value, d: &DeployApply) -> Vec<String> {
    let Some(h) = d.handoff else { return Vec::new() };
    if !h.get("consoleInstalled").is_some_and(Value::is_object) || h.get("fresh") != Some(&json!(true)) || d.local.high {
        return Vec::new();
    }
    let offered: Vec<String> = dv.get("offered").and_then(Value::as_array).map(|a| a.iter().filter_map(|o| o.get("fingerprint").and_then(Value::as_str)).map(str::to_ascii_lowercase).collect()).unwrap_or_default();
    strings_of(h.get("offeredAccepted")).into_iter().map(|f| f.to_ascii_lowercase()).filter(|f| offered.contains(f)).collect()
}

/// A roster entry's ceremony B fingerprint (AC-2a 3.9).
fn entry_fingerprint(e: &Value) -> Option<String> {
    let id = unb64u(e.get("credentialId")?.as_str()?)?;
    let cose = unb64u(e.get("cose")?.as_str()?)?;
    Some(crate::fleet_trust::admin_key_fingerprint(&id, &cose, e.get("email")?.as_str()?, e.get("role")?.as_str()?))
}

/// 6.5 to 6.7 after the link is written: the Meeting Hub pair moves to `pki/<serial>` and `pki/current` switches to
/// it, `pki/ca.crt` is written atomically, the root CRL is placed by the 8.5 adoption rule; a delivered Remote Spokes
/// root is written; the enrollment license is installed when none is in force.
fn place_deploy(console: &Console, product: Product, state_dir: &Path, d: &DeployApply, dv: &Value, meet: Option<(&mut MeetRequests, &MeetIssued)>, wall: i64) -> Result<(), String> {
    let now_s = wall / 1000;
    let installed = d.handoff.and_then(|h| h.get("consoleInstalled")).is_some_and(Value::is_object);
    if let Some((r, i)) = meet {
        let failed = |_| "meet-pki".to_owned();
        let pki = state_dir.join(PKI_DIR);
        let dest = pki.join(&i.serial);
        std::fs::rename(&r.dir, &dest).map_err(failed)?;
        r.dir = dest;
        switch_current(&pki, &i.serial).map_err(|_| "meet-pki".to_owned())?;
        r.keep = true;
        crate::store::write_private(&pki.join("ca.crt"), i.ca_pem.as_bytes()).map_err(failed)?;
        let client_ca = d.local.client_ca.clone().unwrap_or_else(|| pki.join("ca.crt"));
        crate::meet_tls::place_root_crl(state_dir, &client_ca, i.crl_pem.as_bytes(), wall).map_err(|_| "meet-pki".to_owned())?;
        console.audit_relay("fleet.pki-installed", "", json!({ "serial": i.serial, "caId": i.ca_id, "notAfter": i.not_after * 1000, "signer": i.signer_serial.is_some() }));
    }
    // 6.7: a delivered Remote Spokes root, only on a console-installed Standard relay with an in-date license for it
    if product == Product::Spokes {
        if let Some(path) = d.local.root_path.as_deref().filter(|p| !p.exists()) {
            let sr = dv.get("spokesRoot").filter(|s| s.is_object());
            if let (Some(pem), Some(id)) = (sr.and_then(|s| s.get("pem")).and_then(Value::as_str), sr.and_then(|s| s.get("id")).and_then(Value::as_str)) {
                if installed && !d.local.high && spokes_root_id_of_pem(pem).as_deref() == Some(id) && license_check(dv.get("license").unwrap_or(&Value::Null), product, &[id.to_owned()], now_s).is_ok() {
                    crate::store::write_private(path, pem.as_bytes()).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    if let Some(why) = install_license(console, product, state_dir, d.local, dv, wall) {
        d.logger.ops("fleet.deploy-license-skipped", &Fields::new().with("why", why), Level::Warn);
    }
    Ok(())
}

/// 6.6: the preview's license, installed only when no license is in force and it verifies with the compiled
/// publisher key for this relay's own anchor. Some(why) when it was skipped.
fn install_license(console: &Console, product: Product, state_dir: &Path, local: &LocalDeploy, dv: &Value, wall: i64) -> Option<String> {
    let lic = dv.get("license").filter(|l| l.is_object())?;
    if local.license_in_force {
        return Some("in-force".into());
    }
    let Some(path) = local.license_path.as_deref() else { return Some("no-license-file".into()) };
    let roots: Vec<String> = match product {
        Product::Meet => meet_roots_of(&local.client_ca.clone().unwrap_or_else(|| state_dir.join(PKI_DIR).join("ca.crt"))),
        Product::Spokes => local.root_path.as_deref().and_then(spokes_root_id).into_iter().collect(),
    };
    let l = match license_check(lic, product, &roots, wall / 1000) {
        Ok(l) => l,
        Err(why) => return Some(why),
    };
    let token = lic.get("token").and_then(Value::as_str).unwrap_or_default();
    if let Err(e) = crate::store::write_private(path, token.as_bytes()) {
        return Some(e.to_string());
    }
    let mut r = crate::console_audit::Record::new("operator", "license.install", "ok");
    r.detail = json!({ "via": "enrollment", "id": l.id });
    console.record(r, wall);
    None
}

/// The relay's own facts for the apply before its listeners (6.4), set on the host (relay.json, the unit's flags and
/// `profile.lock`), never by the console.
#[derive(Clone, Debug, Default)]
pub struct LocalDeploy {
    /// The effective profile is High (`profile.lock` applied).
    pub high: bool,
    /// Meeting Hub `relay.json` `fleet_pki`.
    pub fleet_pki: bool,
    /// Meeting Hub `client_ca` (None: Remote Spokes).
    pub client_ca: Option<PathBuf>,
    /// Remote Spokes `--root` file (a delivered root is written there when it is absent).
    pub root_path: Option<PathBuf>,
    /// Where an enrollment license goes: Meeting Hub `<state>/license.lic`, Remote Spokes `--license`.
    pub license_path: Option<PathBuf>,
    /// A license is in force (`service.why` is not `none`).
    pub license_in_force: bool,
    /// Meeting Hub `relay.json` `admins` (lower-cased).
    pub admins: Vec<String>,
}

/// AC-2b-D 6.4 (f-relay calls it at every start, under `fleet.lock`, before reading its TLS files, `client_ca`, CRL,
/// `--root` or license): takes a waiting handoff and applies it in this process within 60 s. Ok(true) when an
/// enrollment was applied, Ok(false) when none waited; Err (already logged `fleet.enroll-failed` with its `why`) when
/// it failed; the relay then continues its normal start. `fresh` is `is_fresh(state_dir)` taken before `console` was
/// opened: opening it seals and appends to the audit log, so the folder is never fresh afterwards.
pub fn apply_before_listeners(console: &Arc<Console>, product: Product, state_dir: &Path, logger: &Arc<Logger>, proxy: Option<&str>, local: &LocalDeploy, fresh: bool) -> Result<bool, String> {
    if !has_handoff(state_dir) {
        return Ok(false);
    }
    let failed = |why: &str| {
        logger.ops("fleet.enroll-failed", &Fields::new().with("why", why), Level::Error);
        why.to_owned()
    };
    let h = match take_handoff(state_dir) {
        Ok(Some(h)) => h,
        Ok(None) => return Ok(false),
        Err(why) => return Err(failed(&why)),
    };
    let code = check_code(h.code.expose(), product).map_err(|why| failed(&why))?;
    let proxy = proxy.map(str::to_owned).or_else(|| std::env::var(PROXY_ENV).ok()).filter(|p| !p.is_empty());
    let d = DeployApply { local, handoff: h.deploy.as_ref(), fresh, logger: logger.as_ref() };
    let a = Apply {
        console: console.as_ref(),
        state_dir,
        product,
        version: env!("CARGO_PKG_VERSION"),
        url: &h.url,
        preview_hash: *h.preview_hash.expose(),
        admin_keys: &h.admin_keys,
        confirmed_by: &h.confirmed_by,
        proxy: proxy.as_deref(),
        deploy: Some(&d),
    };
    match run_blocking(async move { tokio::time::timeout(APPLY_LIMIT, apply(a, &code)).await }) {
        Ok(Ok(done)) => {
            let fp = done["fingerprint"].as_str().unwrap_or_default().to_owned();
            logger.ops("fleet.enrolled", &Fields::new().with("fingerprint", fp.as_str()).with("bootstrapRosterHash", done["bootstrapRosterHash"].as_str().unwrap_or_default()), Level::Info);
            println!("{}", w::fill(w::cli_words("cli.enrolled"), &[("origin", done["origin"].as_str().unwrap_or_default()), ("relayId", done["relayId"].as_str().unwrap_or_default()), ("fingerprint", &fp)]));
            Ok(true)
        }
        Ok(Err(why)) => Err(failed(&why)),
        Err(_) => Err(failed("timeout")),
    }
}

/// `fleet status --fingerprint` and `meet fleet status ... --fingerprint` (9.4): the relay's management fingerprint
/// once enrolled, else None (the command prints nothing and exits 0 either way; it reads only `fleet.json`, so it
/// works while the relay runs).
pub fn status_fingerprint(state_dir: &Path) -> Option<String> {
    let link = Link { map: load_link_json(state_dir).ok().flatten()? };
    if !link.usable() {
        return None;
    }
    link.map.get("fingerprint").and_then(Value::as_str).filter(|f| !f.is_empty()).map(str::to_owned)
}

/// What the agent asks of a Meeting Hub relay for the channel (f-relay implements it in meet.rs and registers it with
/// `set_meet_hooks`; AC-2b-D 8.4, 8.5, 8.7, 9.3).
pub trait MeetHooks: Send + Sync {
    /// `hello.meetRoots`: the `m_` ids of the self-signed certificates in `client_ca`.
    fn meet_roots(&self) -> Vec<String>;
    /// `hello` and `state` `meetCrl`.
    fn meet_crl(&self) -> Value;
    /// `hello` and `state` `meetPki` (null unless `fleet_pki`).
    fn meet_pki(&self) -> Value;
    /// `meet-crl {crl}`: adopt by the 8.5 rules, or Err(why) (logged `fleet.meet-crl-refused`).
    fn adopt_crl(&self, pem: &str) -> Result<(), String>;
    /// `welcome.meetCaId` (8.7).
    fn welcome(&self, meet_ca_id: Option<&str>);
    /// A High relay whose CA the console says it holds: every write frame answers `fleet-ca-held` (8.7).
    fn ca_held(&self) -> bool;
    /// A renewal switched `pki/current`: reload the TLS configuration and the signer client (8.4).
    fn pki_switched(&self);
    /// API-1 2.5 `api-heads`: `{org: {seq, tseq}}` for every org the relay serves.
    fn api_heads(&self) -> Value {
        json!({})
    }
    /// API-1 2.6 `api-map` and `api-tighten`, answered after the store is flushed (None: the relay is stopping).
    fn api_request(&self, _op: &str, _body: &Value) -> Option<Result<Value, Refusal>> {
        None
    }
    /// API-1 9.1: this relay's own audit chains (source = its relay id); None while it has no relay id or vault.
    fn api_audit(&self) -> Option<Arc<crate::api_audit::ApiAudit>> {
        None
    }
}

// ── API-1: the relay end of the api ops (docs/api/contract.md 2.4 to 2.6) ──────────────────────────────────

/// The folder of the relay's pseudonym key records (`<org>.json` = `{pkv, not_before}`; the key itself is sealed).
pub const API_PSEUDONYM_DIR: &str = "api-pseudonym";

/// The sealed name of an org's pseudonym key version.
pub fn api_pseudonym_seal_name(org: &str, pkv: u64) -> String {
    format!("api-pseudonym-{org}-{pkv}")
}

/// An api map refusal as a `res` refusal with its contract code.
pub fn api_refusal(e: crate::api_map::ApiMapError) -> Refusal {
    let status = match e.code {
        "signature" | "map-expired" => 403,
        "license" | "issuer-taken" | "seq-not-higher" | "conflict" | "tseq-gap" => 409,
        "io" => 500,
        _ => 400,
    };
    Refusal::new(status, e.code, &e.message)
}

/// One entry for an org's API audit chain (9.2 fields without seq, ts, org, prev and hash), produced under a store
/// lock and recorded once the lock is released (`api_record`).
pub type ApiNote = (String, Value);

/// The `api.map.pinned` entry of a newly pinned map (9.2).
pub fn api_note_pinned(vm: &crate::api_map::VerifiedApiMap) -> ApiNote {
    (vm.org.clone(), json!({ "action": "api.map.pinned", "resource": vm.org, "result": "ok", "map_seq": vm.seq, "map_hash": vm.hash }))
}

/// The `api.map.conflict` entry (2.4): the pinned seq seen with another hash; `node` names the relay that saw it on
/// the console's chain.
pub fn api_note_conflict(org: &str, seq: i64, node: Option<&str>) -> ApiNote {
    let mut e = json!({ "action": "api.map.conflict", "resource": org, "result": "conflict", "map_seq": seq });
    if let Some(n) = node {
        e["node"] = json!(n);
    }
    (org.to_string(), e)
}

/// The `api.tighten` entry of a journal entry appended (console) or applied (relay) (2.5).
pub fn api_note_tighten(org: &str, entry: &Value) -> ApiNote {
    let mut e = json!({ "action": "api.tighten", "result": "ok" });
    if let Some(id) = entry.get("id").and_then(Value::as_str) {
        e["resource"] = json!(id);
    }
    if let Some(t) = entry.get("tseq").and_then(Value::as_u64) {
        e["tseq"] = json!(t);
    }
    if let Some(a) = entry.get("action").and_then(Value::as_str) {
        e["op"] = json!(a);
    }
    if let Some(u) = entry.get("until").and_then(Value::as_i64) {
        e["until"] = json!(u);
    }
    (org.to_string(), e)
}

/// 9.4 for the fleet's own api changes: each note goes into its org's chain. A pin or a tightening is never undone or
/// refused because the audit failed (that would keep a relay wider than the console decided); the failure is the
/// security line `api.audit-failed` instead.
pub fn api_record(audit: Option<&crate::api_audit::ApiAudit>, notes: Vec<ApiNote>, logger: &Logger, now: i64) {
    for (org, entry) in notes {
        let action = entry.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
        let why = match audit {
            Some(a) => match a.record(&org, entry, now) {
                Ok(_) => continue,
                Err(e) => e.message,
            },
            None => "no audit chains yet".to_string(),
        };
        logger.security("api.audit-failed", &Fields::new().with("org", org.as_str()).with("action", action.as_str()).with("why", why), Level::Error);
    }
}

/// `api-map` (2.4): `{ok: true, seq}` once pinned (or already pinned); the pinned seq with another hash raises the
/// alarm `api.map.conflict` and answers `conflict`. A new pin and a conflict add their audit entries to `notes`.
pub fn api_map_answer(r: Result<crate::api_map::AcceptOutcome, crate::api_map::ApiMapError>, logger: &Logger, notes: &mut Vec<ApiNote>) -> Result<Value, Refusal> {
    use crate::api_map::AcceptOutcome;
    match r.map_err(api_refusal)? {
        AcceptOutcome::Pinned(vm) => {
            logger.ops("api.map.pinned", &Fields::new().with("org", vm.org.as_str()).with("seq", vm.seq).with("hash", vm.hash.as_str()), Level::Info);
            notes.push(api_note_pinned(&vm));
            Ok(json!({ "ok": true, "seq": vm.seq }))
        }
        AcceptOutcome::Unchanged(vm) => {
            logger.ops("api.map.pinned", &Fields::new().with("org", vm.org.as_str()).with("seq", vm.seq).with("hash", vm.hash.as_str()), Level::Info);
            Ok(json!({ "ok": true, "seq": vm.seq }))
        }
        AcceptOutcome::Conflict { org, seq, pinned_hash, offered_hash } => {
            let f = Fields::new().with("org", org.as_str()).with("seq", seq).with("pinned", pinned_hash.as_str()).with("offered", offered_hash.as_str()).with("via", "fleet");
            logger.security("api.map.conflict", &f, Level::Error);
            notes.push(api_note_conflict(&org, seq, None));
            Err(Refusal::new(409, "conflict", &format!("{org}'s api map {seq} was seen with two different hashes")))
        }
    }
}

/// `api-map` after the accept: the answer of `api_map_answer`, then (2.5 rebase) the optional `base` the console
/// sends a relay behind its pruned journal: an applied tseq below it moves up to it, logged and audited
/// `api.journal.rebased`. The answer carries the relay's applied `tseq` after it.
pub fn api_map_pinned(r: Result<crate::api_map::AcceptOutcome, crate::api_map::ApiMapError>, store: &mut crate::api_map::ApiMapStore, body: &Value, logger: &Logger, notes: &mut Vec<ApiNote>) -> Result<Value, Refusal> {
    let mut answer = api_map_answer(r, logger, notes)?;
    let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
    if let Some(base) = body.get("base").and_then(Value::as_u64) {
        if let Some(from) = store.rebase(org, base).map_err(api_refusal)? {
            logger.security("api.journal.rebased", &Fields::new().with("org", org).with("from", from).with("to", base), Level::Warn);
            notes.push((org.to_string(), json!({ "action": "api.journal.rebased", "resource": org, "result": "ok", "tseq": base })));
        }
    }
    answer["tseq"] = json!(store.head(org).1);
    Ok(answer)
}

/// `api-tighten` (2.5): apply the entry (its tseq exactly the next, never widening) and flush the journal before
/// answering `{ok: true, tseq}`; the applied entry adds its `api.tighten` audit entry to `notes`.
pub fn api_tighten_answer(store: &mut crate::api_map::ApiMapStore, body: &Value, notes: &mut Vec<ApiNote>) -> Result<Value, Refusal> {
    let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
    let entry = body.get("entry").unwrap_or(&Value::Null);
    let tseq = store.apply_tighten(org, entry).map_err(api_refusal)?;
    notes.push(api_note_tighten(org, entry));
    Ok(json!({ "ok": true, "tseq": tseq }))
}

/// `api-pseudonym-key` (2.6, 11.4): the 32-byte key sealed as `api-pseudonym-<org>-<pkv>`, then the owner-only
/// record `api-pseudonym/<org>.json` `{pkv, not_before}` flushed to disk, then `{ok: true, pkv}`. The same version
/// again with the same key changes nothing; with another key it is refused (`conflict`). The key is never logged.
pub fn api_pseudonym_key_store(dir: &Path, vault: &dyn VaultLock, body: &Value) -> Result<Value, Refusal> {
    let bad = |why: &str| Refusal::new(400, "bad-key", why);
    let org = body.get("org").and_then(Value::as_str).filter(|o| (1..=32).contains(&o.len()) && o.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')).ok_or_else(|| bad("org is not an organization id"))?;
    let pkv = body.get("pkv").and_then(Value::as_u64).filter(|n| (1..=(1u64 << 53)).contains(n)).ok_or_else(|| bad("pkv must be a whole number from 1"))?;
    let not_before = body.get("not_before").and_then(Value::as_i64).filter(|n| *n >= 0).ok_or_else(|| bad("not_before must be a time"))?;
    let key = body.get("key").and_then(Value::as_str).and_then(unb64u).filter(|k| k.len() == 32).ok_or_else(|| bad("key must be 32 bytes in base64url"))?;
    let name = api_pseudonym_seal_name(org, pkv);
    let path = dir.join(API_PSEUDONYM_DIR).join(format!("{org}.json"));
    let held = parse_json(&std::fs::read_to_string(&path).unwrap_or_default()).and_then(|v| v.get("pkv").and_then(Value::as_u64));
    if held.is_some_and(|h| h > pkv) {
        return Err(Refusal::new(409, "pkv-not-higher", "This relay already holds a newer pseudonym key version."));
    }
    vault_do(vault, |v| -> Result<(), Refusal> {
        match v.get(&name) {
            Some(k) if k == key => Ok(()),
            Some(_) => Err(Refusal::new(409, "conflict", "That pseudonym key version was seen with another key.")),
            None => v.put(&name, &key).map_err(|_| Refusal::new(500, "io", "The key could not be sealed.")),
        }
    })?;
    crate::store::make_dir(&dir.join(API_PSEUDONYM_DIR)).map_err(|_| Refusal::new(500, "io", "The key record could not be written."))?;
    let record = stringify(&json!({ "pkv": pkv, "not_before": not_before }));
    crate::fleet_local::write_durable(&path, record.as_bytes()).map_err(|_| Refusal::new(500, "io", "The key record could not be written."))?;
    Ok(json!({ "ok": true, "pkv": pkv }))
}

// ── API-1 9 and 12.2: the relay's audit chains over the channel (`api-audit`, `api-chains`, checkpoint certificates) ──

/// What the console acknowledged of this relay's own chains: `{org: {repr: last seq}}`, flushed after each answer.
pub const API_SHIPPED_FILE: &str = "api-audit-shipped.json";
/// At most this many entries per `api-audit` batch or `api-chains` representation page.
pub const API_SHIP_ENTRIES: usize = 1000;
/// Room kept in a 1 MiB frame for the envelope and the other body keys.
const API_FRAME_ROOM: usize = 4 * 1024;
/// The shipping loop looks for new entries this often, and waits this long after the console's last api request
/// (its reconnect catch-up) before it starts.
const API_SHIP_EVERY: Duration = Duration::from_secs(2);
const API_SHIP_QUIET: Duration = Duration::from_secs(1);

fn api_org(body: &Value) -> Result<&str, Refusal> {
    body.get("org").and_then(Value::as_str).filter(|o| (1..=32).contains(&o.len()) && o.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')).ok_or_else(|| Refusal::new(400, "bad-org", "org is not an organization id"))
}

fn audit_unavailable() -> Refusal {
    Refusal::new(503, "audit-unavailable", "The audit chains cannot be read or written now.")
}

/// The acknowledged seqs (`API_SHIPPED_FILE`); empty when none was written yet.
pub fn api_shipped_load(dir: &Path) -> std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>> {
    let v = parse_json(&std::fs::read_to_string(dir.join(API_SHIPPED_FILE)).unwrap_or_default()).unwrap_or(Value::Null);
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(org, r)| (org.clone(), r.as_object().into_iter().flatten().filter_map(|(k, n)| n.as_u64().map(|n| (k.clone(), n))).collect()))
        .collect()
}

/// Keep on disk that the console holds `org`'s `repr` chain of this relay up to `last`.
pub fn api_shipped_set(dir: &Path, org: &str, repr: &str, last: u64) -> Result<(), String> {
    let mut all = api_shipped_load(dir);
    all.entry(org.to_string()).or_default().insert(repr.to_string(), last);
    crate::fleet_local::write_durable(&dir.join(API_SHIPPED_FILE), stringify(&json!(all)).as_bytes()).map_err(|e| e.to_string())
}

/// One `api-audit` request: entries `first..=last` of one org's chain in one representation.
#[derive(Clone, Debug)]
pub struct ApiBatch {
    pub org: String,
    pub repr: crate::api_audit::Repr,
    /// Also in `body`; read by the shipping tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub first: u64,
    pub last: u64,
    pub body: Value,
}

/// Up to `limit` entries from `entries` that fit in `budget` bytes of JSON (each with its comma); true when some were
/// left out.
fn api_fit(entries: Vec<Value>, budget: &mut usize) -> (Vec<Value>, bool) {
    let mut out = Vec::new();
    let total = entries.len();
    for e in entries {
        let n = stringify(&e).len() + 1;
        if n > *budget {
            break;
        }
        *budget -= n;
        out.push(e);
    }
    let cut = out.len() < total;
    (out, cut)
}

/// 12.2: the next batch to ship, in order: orgs sorted, then as_is, pseudonymized, removed, each from the seq after
/// the one the console acknowledged (`shipped`), as many entries as fit in one 1 MiB frame. `skip` holds the chains
/// the console cannot take on this channel. None when everything is acknowledged.
pub fn api_next_batch(audit: &crate::api_audit::ApiAudit, shipped: &std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>>, skip: &std::collections::HashSet<(String, crate::api_audit::Repr)>) -> Option<ApiBatch> {
    let mut orgs = audit.orgs();
    orgs.sort();
    for org in orgs {
        for repr in crate::api_audit::Repr::ALL {
            if skip.contains(&(org.clone(), repr)) {
                continue;
            }
            let after = shipped.get(&org).and_then(|r| r.get(repr.as_str())).copied().unwrap_or(0);
            let entries = audit.since(&org, repr, after, API_SHIP_ENTRIES);
            if entries.is_empty() {
                continue;
            }
            let mut budget = w::API_AUDIT_MAX - API_FRAME_ROOM;
            let (entries, _) = api_fit(entries, &mut budget);
            let seq = |e: Option<&Value>| e.and_then(|e| e.get("seq")).and_then(Value::as_u64);
            let (Some(first), Some(last)) = (seq(entries.first()), seq(entries.last())) else { continue };
            let body = json!({ "org": org, "repr": repr.as_str(), "first": first, "last": last, "entries": entries });
            return Some(ApiBatch { org, repr, first, last, body });
        }
    }
    None
}

/// What the shipping loop does after the console's answer to an `api-audit` batch.
#[derive(Debug, PartialEq, Eq)]
pub enum ShipStep {
    /// Stored and acknowledged: the next batch at once.
    Acked,
    /// `gap`: the acknowledged seq moved to the console's head; resend from there at once.
    Resend,
    /// Try this batch again at the next tick.
    Retry,
    /// The console cannot take this chain on this channel (it holds more than this relay has, or `bad-chain`).
    Skip(String),
    /// The console does not know `api-audit` (an older console): no batch until reconnect.
    Off,
}

/// The console's answer to `batch`: `{ok: true, last}` moves the acknowledged seq (kept on disk) to `last`;
/// `{ok: false, code: "gap", expected}` moves it to `expected - 1` so the entries from `expected` are sent (or stops
/// that chain when `expected` is past this relay's own head `own_head`); `fleet-op` stops shipping until reconnect.
pub fn api_ship_answer(dir: &Path, batch: &ApiBatch, answer: Result<Value, Refusal>, own_head: u64, logger: &Logger) -> ShipStep {
    let repr = batch.repr.as_str();
    match answer {
        Ok(b) if b.get("ok") == Some(&Value::Bool(true)) => {
            let last = b.get("last").and_then(Value::as_u64).filter(|l| *l <= own_head).unwrap_or(batch.last).max(batch.last);
            match api_shipped_set(dir, &batch.org, repr, last) {
                Ok(()) => ShipStep::Acked,
                Err(why) => {
                    logger.security("api.audit.ship-unsaved", &Fields::new().with("org", batch.org.as_str()).with("repr", repr).with("why", why), Level::Error);
                    ShipStep::Retry
                }
            }
        }
        Ok(b) if b.get("code").and_then(Value::as_str) == Some("gap") => {
            let expected = b.get("expected").and_then(Value::as_u64).unwrap_or(0);
            if expected == 0 || expected - 1 > own_head {
                logger.security("api.audit.console-ahead", &Fields::new().with("org", batch.org.as_str()).with("repr", repr).with("expected", expected).with("head", own_head), Level::Error);
                return ShipStep::Skip("console-ahead".into());
            }
            match api_shipped_set(dir, &batch.org, repr, expected - 1) {
                Ok(()) => ShipStep::Resend,
                Err(_) => ShipStep::Retry,
            }
        }
        Ok(_) => ShipStep::Retry,
        Err(r) if r.code == "fleet-op" => ShipStep::Off,
        Err(r) if r.code == "bad-chain" || r.code == "org-not-served" => {
            logger.security("api.audit.ship-refused", &Fields::new().with("org", batch.org.as_str()).with("repr", repr).with("code", r.code.as_str()).with("why", r.error.as_str()), Level::Error);
            ShipStep::Skip(r.code)
        }
        Err(_) => ShipStep::Retry,
    }
}

/// `api-chains` (2.6, 12.2): one page of this relay's chains for an org after the seqs the console holds, `after`
/// exactly `{as_is, pseudonymized, removed}`: `{org, as_is: [...], pseudonymized: [...], removed: [...], more}`, at
/// most 1 MiB in all; `more` when the console should ask again from the last seqs of this page.
pub fn api_chains_answer(audit: &crate::api_audit::ApiAudit, body: &Value) -> Result<Value, Refusal> {
    api_chains_page(audit, body, API_SHIP_ENTRIES)
}

/// `api_chains_answer` with at most `limit` entries per representation.
pub fn api_chains_page(audit: &crate::api_audit::ApiAudit, body: &Value, limit: usize) -> Result<Value, Refusal> {
    let org = api_org(body)?;
    let bad = || Refusal::new(400, "bad-after", "after must be exactly {as_is, pseudonymized, removed} with whole numbers");
    let after = body.get("after").and_then(Value::as_object).filter(|a| a.len() == 3).ok_or_else(bad)?;
    let mut budget = w::API_AUDIT_MAX - API_FRAME_ROOM;
    let mut out = Map::new();
    out.insert("org".into(), json!(org));
    let mut more = false;
    for repr in crate::api_audit::Repr::ALL {
        let from = after.get(repr.as_str()).and_then(Value::as_u64).ok_or_else(bad)?;
        let got = audit.since(org, repr, from, limit);
        let full = got.len() >= limit;
        let (page, cut) = api_fit(got, &mut budget);
        more |= full || cut;
        out.insert(repr.as_str().into(), Value::Array(page));
    }
    out.insert("more".into(), json!(more));
    Ok(Value::Object(out))
}

/// `api-checkpoint-csr` (9.3): `{csr}` (base64url DER) for this relay's checkpoint key of the org when it has no
/// installed certificate or under 30 days are left, else `{csr: null}`.
pub fn api_checkpoint_csr_answer(dir: &Path, vault: &dyn VaultLock, body: &Value, now: i64) -> Result<Value, Refusal> {
    let org = api_org(body)?;
    if !crate::api_checkpoint::renewal_due(dir, org, now) {
        return Ok(json!({ "csr": null }));
    }
    let csr = crate::api_checkpoint::relay_checkpoint_csr(dir, vault, org).map_err(|why| Refusal::new(500, "io", &why))?;
    Ok(json!({ "csr": b64u(&csr) }))
}

/// `api-checkpoint-cert` (9.3): the certificate (base64url DER) the console's Meet CA issued for the pending key and
/// its chain, checked, installed and flushed to disk before `{ok: true}`; the previous one is retired.
pub fn api_checkpoint_cert_answer(dir: &Path, vault: &dyn VaultLock, body: &Value) -> Result<Value, Refusal> {
    let org = api_org(body)?;
    let bad = |why: &str| Refusal::new(400, "bad-cert", why);
    let cert = body.get("cert").and_then(Value::as_str).and_then(unb64u).ok_or_else(|| bad("cert must be base64url DER"))?;
    let chain: Vec<Vec<u8>> = body.get("chain").and_then(Value::as_array).ok_or_else(|| bad("chain must be a list"))?.iter().map(|c| c.as_str().and_then(unb64u)).collect::<Option<_>>().ok_or_else(|| bad("chain must hold base64url DER"))?;
    crate::api_checkpoint::install(dir, vault, org, &cert, &chain).map_err(|why| bad(&why))?;
    Ok(json!({ "ok": true }))
}

/// `api-failover` (12.3): `csr` (`params` `{type, subject_cn}`) answers `{csr}` (PEM) for a key made here that never
/// leaves; `install` (`params` the material) answers `{ok: true, type, public_id, not_before, expires}` and `delete`
/// `{ok: true}`, only after the sealed credential is on disk or gone. The material is never logged. `now` is unix
/// seconds.
pub fn api_failover_answer(dir: &Path, vault: &dyn VaultLock, body: &Value, now: i64) -> Result<Value, Refusal> {
    let org = api_org(body)?;
    let bad = |why: &str| Refusal::new(400, "bad-failover", why);
    let destination = body.get("destination").and_then(Value::as_str).filter(|d| (3..=64).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or_else(|| bad("destination is not a destination id"))?;
    let params = body.get("params").filter(|p| p.is_object()).ok_or_else(|| bad("params must be an object"))?;
    let io = |why: String| Refusal::new(500, "io", &why);
    match body.get("action").and_then(Value::as_str) {
        Some("csr") => {
            let kind = params.get("type").and_then(Value::as_str).and_then(crate::api_failover::FailoverKind::of).filter(|k| k.uses_csr()).ok_or_else(|| bad("type must be a certificate credential type"))?;
            let cn = params.get("subject_cn").and_then(Value::as_str).filter(|c| (1..=64).contains(&c.len())).ok_or_else(|| bad("subject_cn must be 1 to 64 characters"))?;
            let csr = crate::api_failover::failover_csr(dir, vault, org, destination, kind, cn).map_err(io)?;
            Ok(json!({ "csr": csr }))
        }
        Some("install") => {
            let mut answer = crate::api_failover::failover_install(dir, vault, org, destination, params.clone(), now).map_err(|why| bad(&why))?;
            crate::api_failover::changed();
            // the installed credential's non-secret record: type, public_id, not_before, expires
            match answer.as_object_mut() {
                Some(o) => {
                    o.insert("ok".into(), json!(true));
                }
                None => answer = json!({ "ok": true }),
            }
            Ok(answer)
        }
        Some("delete") => {
            crate::api_failover::retire(dir, vault, org, destination).map_err(io)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(bad("action must be csr, install or delete")),
    }
}

/// Every `api-tighten` and `api-map` on this relay holds this lock across its check, failover retirement and apply
/// (`api_tighten_retire_failover`), so no other entry lands between them.
pub static API_JOURNAL_LOCK: Mutex<()> = Mutex::new(());

/// `api-tighten` (2.5), check only: the entry is well formed, for the body's org, and its tseq is exactly
/// `applied + 1` (the store's own check, as `apply_tighten` makes it). Nothing is applied.
pub fn api_tighten_check(applied: u64, body: &Value) -> Result<crate::api_map::TightenEntry, Refusal> {
    let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
    let e = crate::api_map::check_tighten(body.get("entry").unwrap_or(&Value::Null), applied).map_err(api_refusal)?;
    if e.org != org {
        return Err(api_refusal(crate::api_map::ApiMapError::new("not-tightening", "that entry is for another organization")));
    }
    Ok(e)
}

/// `api-tighten` (2.5, 12.3): a `destination_delete` or `destination_disable_failover` entry that passes
/// `api_tighten_check` against the org's applied tseq deletes this relay's failover credential of that destination
/// (and its failover queue) before it is applied and acknowledged; an entry that does not pass deletes nothing and
/// is refused. The caller holds what serializes the org's journal (`API_JOURNAL_LOCK`, or the store's lock) from
/// reading `applied` until the entry is applied.
pub fn api_tighten_retire_failover(dir: &Path, vault: &dyn VaultLock, applied: u64, body: &Value) -> Result<(), Refusal> {
    let action = body.get("entry").and_then(|e| e.get("action")).and_then(Value::as_str);
    if !matches!(action, Some("destination_delete" | "destination_disable_failover")) {
        return Ok(());
    }
    let e = api_tighten_check(applied, body)?;
    let target = e.target.as_str().unwrap_or_default();
    crate::api_failover::retire(dir, vault, &e.org, target).map_err(|why| Refusal::new(500, "io", &why))
}

/// Shipping state of one channel (12.2).
#[derive(Default)]
struct Ship {
    /// The console asked `api-heads` on this channel (it knows the api ops).
    asked: bool,
    /// The console answered `fleet-op` to `api-audit`: nothing more until reconnect.
    off: bool,
    /// When the console's last api request arrived.
    last_api: Option<Instant>,
    /// A batch is being read from disk.
    building: bool,
    /// The batch sent and not answered yet, with when.
    in_flight: Option<(u32, ApiBatch, Instant)>,
    /// Chains the console cannot take on this channel.
    skip: std::collections::HashSet<(String, crate::api_audit::Repr)>,
}

impl Ship {
    fn due(&self) -> bool {
        self.asked && !self.off && !self.building && self.in_flight.is_none() && self.last_api.is_none_or(|t| t.elapsed() >= API_SHIP_QUIET)
    }
}

static MEET_HOOKS: LazyLock<Mutex<HashMap<PathBuf, Arc<dyn MeetHooks>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register the Meeting Hub hooks of a state folder (before or after the agent starts).
pub fn set_meet_hooks(state_dir: &Path, hooks: Arc<dyn MeetHooks>) {
    MEET_HOOKS.lock().insert(state_dir.to_path_buf(), hooks);
}

fn meet_hooks(dir: &Path) -> Option<Arc<dyn MeetHooks>> {
    MEET_HOOKS.lock().get(dir).cloned()
}

/// API-1 9.1: the audit chains of the Meeting Hub relay of this state folder (its hooks' `api_audit`).
pub fn api_audit_of(dir: &Path) -> Option<Arc<crate::api_audit::ApiAudit>> {
    meet_hooks(dir)?.api_audit()
}

/// Requests a High relay that holds a console's CA still answers (8.7): `nonce`, `meet-crl-get` and reading calls.
fn write_frame(op: &str, body: &Map<String, Value>) -> bool {
    match op {
        "nonce" | "meet-crl-get" | "api-heads" | "api-chains" => false,
        "call" => body.get("method").and_then(Value::as_str) != Some("GET"),
        _ => true,
    }
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
    /// AC-2b-D 8.4: the last Meeting Hub certificate renewal sent.
    last_meet_renew: Mutex<i64>,
    req_id: AtomicU32,
    /// The channel is welcomed and open now.
    up: AtomicBool,
    /// API-1 2.5, 12.2: whether the console's catch-up on this channel ended with an accepted `api-synced`.
    api_sync: Arc<ApiSync>,
}

/// API-1 2.5, 12.2: `chan` moves on at every connect, disconnect and `api-heads`; `synced` holds the `chan` an
/// accepted `api-synced` was asked on, so an answer from an earlier channel or catch-up never counts.
#[derive(Default)]
struct ApiSync {
    chan: AtomicU64,
    synced: parking_lot::Mutex<Option<u64>>,
}

impl ApiSync {
    fn reset(&self) {
        let _g = self.synced.lock();
        self.chan.fetch_add(1, Ordering::SeqCst);
    }

    /// Mark the channel `chan` caught up, unless it moved on since the request arrived.
    fn set(&self, chan: u64) {
        let mut s = self.synced.lock();
        if self.chan.load(Ordering::SeqCst) == chan {
            *s = Some(chan);
        }
    }

    fn caught_up(&self) -> bool {
        let s = self.synced.lock();
        *s == Some(self.chan.load(Ordering::SeqCst))
    }
}

/// `api-synced` (2.5, 12.2): `{ok: true}` only when, for every org listed, this relay's pinned seq and applied tseq
/// (`heads`, as `api-heads` answers them) are at least the console's; else `not-synced`.
pub fn api_synced_answer(heads: &Value, body: &Value) -> Result<Value, Refusal> {
    let bad = || Refusal::new(400, "bad-synced", "orgs must map each organization to {seq, tseq}.");
    let orgs = body.get("orgs").and_then(Value::as_object).ok_or_else(bad)?;
    for (org, want) in orgs {
        let (Some(seq), Some(tseq)) = (want.get("seq").and_then(Value::as_i64), want.get("tseq").and_then(Value::as_u64)) else { return Err(bad()) };
        let have = heads.get(org.as_str());
        let ok = have.and_then(|h| h.get("seq")).and_then(Value::as_i64).is_some_and(|s| s >= seq) && have.and_then(|h| h.get("tseq")).and_then(Value::as_u64).is_some_and(|t| t >= tseq);
        if !ok {
            return Err(Refusal::new(409, "not-synced", "This relay has not applied everything the console holds for that organization yet."));
        }
    }
    Ok(json!({ "ok": true }))
}

static AGENTS: LazyLock<Mutex<HashMap<PathBuf, Weak<Agent>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn agent_for(dir: &Path) -> Option<Arc<Agent>> {
    AGENTS.lock().get(dir).and_then(Weak::upgrade)
}

/// API-1 7.2 `v1/health`: the agent of this state folder holds a welcomed channel to its console now.
pub fn channel_up(dir: &Path) -> bool {
    agent_for(dir).is_some_and(|a| a.up.load(Ordering::SeqCst))
}

/// API-1 12.2: the channel of this state folder is up and the console's catch-up on it ended with an `api-synced`
/// this relay accepted (it holds every map and journal entry the console holds for its orgs).
pub fn api_caught_up(dir: &Path) -> bool {
    agent_for(dir).is_some_and(|a| a.up.load(Ordering::SeqCst) && a.api_sync.caught_up())
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
        last_meet_renew: Mutex::new(i64::MIN / 2),
        req_id: AtomicU32::new(1),
        up: AtomicBool::new(false),
        api_sync: Arc::default(),
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
        let a = Apply { console: &self.console, state_dir: &self.dir, product: self.product, version: &self.version, url: &h.url, preview_hash: *h.preview_hash.expose(), admin_keys: &h.admin_keys, confirmed_by: &h.confirmed_by, proxy: self.proxy.as_deref(), deploy: None };
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
            Err(c) => {
                self.logger.security("fleet.channel-ended", &Fields::new().with("stage", "http").with("category", c.as_str()), Level::Warn);
                return End::Failed(c);
            }
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
            Err((c, status)) => {
                self.logger.security("fleet.channel-ended", &Fields::new().with("stage", "upgrade").with("status", status), Level::Warn);
                End::Failed(c)
            }
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
        // AC-2b-D 9.3: every Meeting Hub relay names its roots, its root CRL and (fleet_pki) its pairs
        if let Some(h) = self.meet() {
            m.insert("meetRoots".into(), json!(h.meet_roots()));
            m.insert("meetCrl".into(), h.meet_crl());
            m.insert("meetPki".into(), h.meet_pki());
        }
        let (keys, opt) = w::op_spec("hello").map(|s| (s.keys, s.opt)).unwrap_or_default();
        m.retain(|k, _| keys.contains(&k.as_str()) || opt.contains(&k.as_str()));
        Value::Object(m)
    }

    /// The Meeting Hub hooks of this relay (none for Remote Spokes).
    fn meet(&self) -> Option<Arc<dyn MeetHooks>> {
        (self.product == Product::Meet).then(|| meet_hooks(&self.dir)).flatten()
    }

    /// `meet-crl-get` (9.3): the relay's `crl-root.pem`, or null.
    fn crl_root(&self) -> Value {
        std::fs::read_to_string(self.dir.join(CRL_ROOT)).map_or(Value::Null, Value::from)
    }

    /// 8.4: a renewal is due when the server certificate has 30 days left, or the signer client certificate its
    /// point (30 days left for a 90-day certificate, 10 for a 30-day one); at most every 6 hours (the console allows
    /// one a day). Some((request id, body, the new folder with the new keys and copies of the unchanged pair)).
    fn meet_renewal(&self, link: &Link) -> Option<(u32, Value, MeetRequests)> {
        let h = self.meet()?;
        if h.meet_pki().is_null() {
            return None;
        }
        let t = now_ms();
        if t - *self.last_meet_renew.lock() < RENEW_RETRY {
            return None;
        }
        let cur = pki_current(&self.dir);
        let read = |name: &str| std::fs::read_to_string(cur.join(name)).ok().and_then(|p| crate::meet_x509::Cert::from_pem(&p));
        let server = read("relay.crt")?;
        let signer = read("signer-client.crt");
        let server_due = server.not_after * 1000 - t <= RENEW_BEFORE;
        let signer_due = signer.as_ref().is_some_and(|c| {
            let before = if c.not_after - c.not_before > 60 * 86_400 { 30 * DAY } else { 10 * DAY };
            c.not_after * 1000 - t <= before
        });
        if !server_due && !signer_due {
            return None;
        }
        *self.last_meet_renew.lock() = t;
        let names = Some(strings_of(link.map.get("meetNames"))).filter(|n| !n.is_empty()).unwrap_or_else(|| server.names.dns.clone());
        let r = MeetRequests::new_folder(&self.dir.join(PKI_DIR), names, server_due, signer_due).ok()?;
        // the pair not due is copied unchanged into the new folder
        let copies: &[&str] = match (server_due, signer.is_some() && !signer_due) {
            (false, _) => &["relay.key", "relay.crt"],
            (true, true) => &["signer-client.key", "signer-client.crt"],
            (true, false) => &[],
        };
        for name in copies {
            let data = std::fs::read(cur.join(name)).ok()?;
            crate::store::write_private(&r.dir.join(name), &data).ok()?;
        }
        let body = json!({ "csr": r.csr.as_ref().map(|c| b64u(c)), "signerCsr": r.signer_csr.as_ref().map(|c| b64u(c)) });
        Some((self.req_id.fetch_add(1, Ordering::SeqCst).max(1), body, r))
    }

    /// `meet-cert`'s answer (8.4): each new certificate checked as at enrollment against `pki/ca.crt`; then the folder
    /// becomes `pki/<serial>`, `pki/current` switches by one rename, and f-relay reloads TLS and the signer client.
    fn meet_renewed(&self, mut r: MeetRequests, answer: Result<Value, Refusal>) -> Result<(), String> {
        let a = answer.map_err(|e| e.code)?;
        let pki = self.dir.join(PKI_DIR);
        let ca = std::fs::read_to_string(pki.join("ca.crt")).ok().and_then(|p| crate::meet_x509::Cert::from_pem(&p)).ok_or("no CA")?;
        let t = now_ms();
        let mut serial = None;
        let mut kinds = Vec::new();
        if let Some(k) = &r.key {
            let (c, pem) = MeetRequests::check_leaf(a.get("cert").and_then(Value::as_str), k, true, &r.names, &ca, t)?;
            crate::store::write_private(&r.dir.join("relay.crt"), pem.as_bytes()).map_err(|e| e.to_string())?;
            serial = Some(c.serial);
            kinds.push("server");
        }
        if let Some(k) = &r.signer {
            let (c, pem) = MeetRequests::check_leaf(a.get("signerCert").and_then(Value::as_str), k, false, &r.names, &ca, t)?;
            crate::store::write_private(&r.dir.join("signer-client.crt"), pem.as_bytes()).map_err(|e| e.to_string())?;
            serial = serial.or(Some(c.serial));
            kinds.push("signer-client");
        }
        let serial = serial.ok_or("nothing was renewed")?;
        let dest = pki.join(&serial);
        std::fs::rename(&r.dir, &dest).map_err(|e| e.to_string())?;
        r.dir = dest;
        switch_current(&pki, &serial)?;
        r.keep = true;
        self.console.audit_relay("fleet.meet-cert.renewed", "", json!({ "serial": serial, "kinds": kinds }));
        if let Some(h) = self.meet() {
            h.pki_switched();
        }
        Ok(())
    }

    /// The channel (both transports): hello, welcome, then frames, pings, metrics, events and renewal until it closes.
    async fn session(self: &Arc<Self>, wire: Wire, link: &Link, key: &Key, leaf: Option<String>) -> End {
        let local = wire.is_local();
        let started = Instant::now();
        let frames = self.frames_for(link.relay_id());
        let (mut tx, mut rx) = wire.split();
        let hello = w::evt_text("hello", self.hello(link, &*frames));
        let hello_bytes = hello.len();
        if !tx.text(hello).await {
            self.logger.security("fleet.channel-ended", &Fields::new().with("stage", "hello").with("bytes", hello_bytes), Level::Warn);
            return End::Failed(Category::Closed);
        }
        let first = tokio::time::timeout(w::IDLE, rx.next()).await;
        if !matches!(&first, Ok(In::Text(t)) if matches!(w::parse_frame(t, Side::Relay), Ok(Frame::Evt { op: "welcome", .. }))) {
            let got = match &first {
                Err(_) => "timeout".to_owned(),
                Ok(In::Text(t)) => match w::parse_frame(t, Side::Relay) {
                    Ok(Frame::Evt { op, .. }) => format!("evt {op}"),
                    Ok(_) => "another frame".to_owned(),
                    Err(e) => format!("refused frame: {} {}", e.why, e.op),
                },
                Ok(In::Pong(_)) => "pong".to_owned(),
                Ok(other) => format!("{other:?}"),
            };
            self.logger.security("fleet.channel-ended", &Fields::new().with("stage", "welcome").with("got", got.as_str()).with("helloBytes", hello_bytes), Level::Warn);
        }
        match first {
            Ok(In::Text(t)) if matches!(w::parse_frame(&t, Side::Relay), Ok(Frame::Evt { op: "welcome", .. })) => {
                // AC-2b-D 8.7: the CA the console says it holds
                if let (Some(h), Ok(Frame::Evt { body, .. })) = (self.meet(), w::parse_frame(&t, Side::Relay)) {
                    h.welcome(body.get("meetCaId").and_then(Value::as_str));
                }
            }
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
        // AC-2b-D 8.4, 9.3: a Meeting Hub certificate renewal in flight; the last `state` sent and the Meeting Hub
        // facts it carried (a change is sent again with the last body)
        let mut meet_renewing: Option<(u32, MeetRequests)> = None;
        let mut last_state: Option<Map<String, Value>> = None;
        let mut meet_sent: Option<(Value, Value)> = self.meet().map(|h| (h.meet_crl(), h.meet_pki()));
        // API-1 12.2: shipping this relay's own audit chains (`api-audit`), once the console asked `api-heads` and its
        // catch-up went quiet; batches are read from disk off this task and sent one at a time
        let mut ship = Ship::default();
        let (built_tx, mut built_rx) = mpsc::unbounded_channel::<Option<ApiBatch>>();
        let mut ship_tick = tokio::time::interval(API_SHIP_EVERY);
        self.api_sync.reset();
        self.up.store(true, Ordering::SeqCst);
        let mut end = End::Closed(Duration::ZERO);
        let _ = leaf;
        loop {
            tokio::select! {
                _ = ship_tick.tick() => {
                    if ship.in_flight.as_ref().is_some_and(|(_, _, at)| at.elapsed() > w::CALL_TIMEOUT) {
                        ship.in_flight = None;
                    }
                    if ship.due() {
                        if let Some(h) = self.meet() {
                            ship.building = true;
                            let (dir, skip, done) = (self.dir.clone(), ship.skip.clone(), built_tx.clone());
                            tokio::task::spawn_blocking(move || {
                                let batch = h.api_audit().and_then(|a| api_next_batch(&a, &api_shipped_load(&dir), &skip));
                                let _ = done.send(batch);
                            });
                        }
                    }
                }
                built = built_rx.recv() => {
                    ship.building = false;
                    if let Some(Some(b)) = built {
                        let id = self.req_id.fetch_add(1, Ordering::SeqCst).max(1);
                        if !tx.text(w::req_text(id, "api-audit", b.body.clone())).await {
                            break;
                        }
                        ship.in_flight = Some((id, b, Instant::now()));
                    }
                }
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
                    // 9.3: `state` carries `meetCrl` and `meetPki` on change
                    if let (Some(h), Some(body)) = (self.meet(), last_state.as_ref()) {
                        let now = (h.meet_crl(), h.meet_pki());
                        if meet_sent.as_ref() != Some(&now) {
                            let mut b = body.clone();
                            b.insert("meetCrl".into(), now.0.clone());
                            b.insert("meetPki".into(), now.1.clone());
                            meet_sent = Some(now);
                            let text = w::evt_text("state", Value::Object(b));
                            if text.len() <= w::TO_CONSOLE_MAX && !tx.text(text).await {
                                break;
                            }
                        }
                    }
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
                    if meet_renewing.is_none() {
                        let cur = self.link().unwrap_or_else(|| link.clone());
                        if let Some((id, body, r)) = self.meet_renewal(&cur) {
                            if !tx.text(w::req_text(id, "meet-cert", body)).await {
                                break;
                            }
                            meet_renewing = Some((id, r));
                        }
                    }
                }
                ev = events_rx.recv() => {
                    let Some((op, mut body)) = ev else { break };
                    if op == "state" {
                        if let (Some(h), Some(o)) = (self.meet(), body.as_object_mut()) {
                            last_state = Some(o.clone());
                            let now = (h.meet_crl(), h.meet_pki());
                            o.insert("meetCrl".into(), now.0.clone());
                            o.insert("meetPki".into(), now.1.clone());
                            meet_sent = Some(now);
                        }
                    }
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
                            Ok(Frame::Req { id, op: "meet-crl-get", .. }) => {
                                // 9.3: the root CRL in force on this relay, for the console's divergence check (8.5)
                                if !tx.text(w::res_ok_text(id, json!({ "crl": self.crl_root() }))).await {
                                    break;
                                }
                            }
                            Ok(Frame::Req { id, op, body }) if write_frame(op, &body) && self.meet().is_some_and(|h| h.ca_held()) => {
                                // 8.7: a High relay whose CA this console says it holds takes no fleet write from it
                                if !tx.text(w::res_err_text(id, &Refusal::of("fleet-ca-held"))).await {
                                    break;
                                }
                            }
                            Ok(Frame::Req { id, op, body }) if op.starts_with("api-") => {
                                // API-1 2.6: answered only after the store (or the sealed key) is on disk
                                ship.last_api = Some(Instant::now());
                                if op == "api-heads" {
                                    ship.asked = true;
                                    // a new catch-up: not caught up until its `api-synced`
                                    self.api_sync.reset();
                                }
                                let (sync, chan) = (self.api_sync.clone(), self.api_sync.chan.load(Ordering::SeqCst));
                                let (hooks, console, dir, ans) = (self.meet(), self.console.clone(), self.dir.clone(), ans_tx.clone());
                                tokio::task::spawn_blocking(move || {
                                    let body = Value::Object(body);
                                    let served = |h: &Arc<dyn MeetHooks>| -> Result<(), Refusal> {
                                        let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
                                        match h.api_heads().get(org) {
                                            Some(_) => Ok(()),
                                            None => Err(Refusal::new(403, "org-not-served", "This relay does not serve that organization.")),
                                        }
                                    };
                                    let answer = match (op, hooks) {
                                        ("api-heads", Some(h)) => Ok(h.api_heads()),
                                        // API-1 2.5, 12.2: the console's catch-up fully succeeded; checked against what is on disk
                                        ("api-synced", Some(h)) => api_synced_answer(&h.api_heads(), &body).inspect(|_| sync.set(chan)),
                                        ("api-pseudonym-key", Some(h)) => served(&h).and_then(|_| api_pseudonym_key_store(&dir, &*console, &body)),
                                        // API-1 9.3, 12.2: the relay's chains and its checkpoint certificates
                                        ("api-chains", Some(h)) => served(&h).and_then(|_| h.api_audit().ok_or_else(audit_unavailable)).and_then(|a| api_chains_answer(&a, &body)),
                                        ("api-checkpoint-csr", Some(h)) => served(&h).and_then(|_| api_checkpoint_csr_answer(&dir, &*console, &body, now_ms() / 1000)),
                                        ("api-checkpoint-cert", Some(h)) => served(&h).and_then(|_| api_checkpoint_cert_answer(&dir, &*console, &body)),
                                        // API-1 12.3: failover credentials, and their retirement before a tightening is acknowledged
                                        ("api-failover", Some(h)) => served(&h).and_then(|_| api_failover_answer(&dir, &*console, &body, now_ms() / 1000)),
                                        ("api-tighten" | "api-map", Some(h)) => {
                                            // check, retire and apply with no other journal entry or map between them
                                            let _one = API_JOURNAL_LOCK.lock();
                                            let retired = match op {
                                                "api-tighten" => served(&h).and_then(|_| {
                                                    let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
                                                    let applied = h.api_heads().get(org).and_then(|o| o.get("tseq")).and_then(Value::as_u64).unwrap_or(0);
                                                    api_tighten_retire_failover(&dir, &*console, applied, &body)
                                                }),
                                                _ => Ok(()),
                                            };
                                            let r = retired.and_then(|_| h.api_request(op, &body).unwrap_or_else(|| Err(Refusal::of("fleet-op"))));
                                            match &r {
                                                // 12.3: the relay exporter re-reads its config at once
                                                Ok(_) => crate::api_failover::changed(),
                                                // 12.2: behind the console again until its next `api-synced`
                                                Err(_) => sync.reset(),
                                            }
                                            r
                                        }
                                        (_, Some(h)) => h.api_request(op, &body).unwrap_or_else(|| Err(Refusal::of("fleet-op"))),
                                        (_, None) => Err(Refusal::of("fleet-op")),
                                    };
                                    let text = match answer {
                                        Ok(v) => w::res_ok_text(id, v),
                                        Err(r) => w::res_err_text(id, &r),
                                    };
                                    let _ = ans.send(text);
                                });
                            }
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
                            Ok(Frame::Res { id, answer }) if ship.in_flight.as_ref().is_some_and(|(sid, _, _)| *sid == id) => {
                                if let Some((_, b, _)) = ship.in_flight.take() {
                                    let own = self.meet().and_then(|h| h.api_audit()).map_or(0, |a| a.head(&b.org, link.relay_id(), b.repr).0);
                                    match api_ship_answer(&self.dir, &b, answer, own, &self.logger) {
                                        ShipStep::Acked | ShipStep::Resend => ship_tick.reset_immediately(),
                                        ShipStep::Retry => {}
                                        ShipStep::Skip(_) => {
                                            ship.skip.insert((b.org, b.repr));
                                        }
                                        ShipStep::Off => {
                                            ship.off = true;
                                            self.logger.ops("api.audit.console-without-api", &Fields::new(), Level::Info);
                                        }
                                    }
                                }
                            }
                            Ok(Frame::Res { id, answer }) if meet_renewing.as_ref().is_some_and(|(rid, _)| *rid == id) => {
                                if let Some((_, r)) = meet_renewing.take() {
                                    match self.meet_renewed(r, answer) {
                                        Ok(()) => self.logger.ops("fleet.meet-cert-renewed", &Fields::new(), Level::Info),
                                        Err(why) => self.logger.ops("fleet.meet-cert-failed", &Fields::new().with("why", why), Level::Warn),
                                    }
                                }
                            }
                            Ok(Frame::Evt { op: "meet-crl", body }) => {
                                // 8.5: the relay adopts a pushed root CRL only by its own rules
                                let pem = body.get("crl").and_then(Value::as_str).unwrap_or_default();
                                let r = match self.meet() {
                                    Some(h) => h.adopt_crl(pem),
                                    None => Err("not-meet".to_owned()),
                                };
                                if let Err(why) = r {
                                    self.logger.security("fleet.meet-crl-refused", &Fields::new().with("why", why), Level::Warn);
                                }
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
        self.up.store(false, Ordering::SeqCst);
        self.api_sync.reset();
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

    // ── AC-2b-D 6.3 to 6.7 and 7 ──

    fn deploy_vector() -> Value {
        let path = format!("{}/tests/admin_console_fleet_deploy_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    /// The words of `id` (filled or not) begin `got`.
    fn words_are(got: &str, id: &str) -> bool {
        let t = w::cli_words(id);
        !t.is_empty() && got.starts_with(t.split('<').next().unwrap_or_default())
    }

    /// A terminal of fixed lines that records what was written (no echo rule: the deploy prompts echo).
    struct Lines {
        tty: bool,
        lines: Vec<String>,
        out: String,
    }

    impl Term for Lines {
        fn is_terminal(&self) -> bool {
            self.tty
        }
        fn set_echo(&mut self, _on: bool) -> bool {
            true
        }
        fn read_line(&mut self) -> Option<String> {
            (!self.lines.is_empty()).then(|| self.lines.remove(0))
        }
        fn write(&mut self, s: &str) {
            self.out.push_str(s);
        }
    }

    fn s_of(v: &Value) -> Option<&str> {
        v.as_str()
    }

    #[test]
    fn the_6_3_decisions_of_the_deploy_vector() {
        let v = deploy_vector();
        for c in v["decisions"].as_array().unwrap() {
            let l = &c["local"];
            let meet = !l["pki"].is_null();
            let clients: Option<Vec<String>> = l["clients"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect());
            let local = DeployLocal {
                product: if meet { Product::Meet } else { Product::Spokes },
                flag: s_of(&c["deployFlag"]),
                high: l["profile"] == json!("high"),
                pki: s_of(&l["pki"]),
                host: s_of(&l["host"]),
                turn_host: s_of(&l["turnHost"]),
                clients: clients.as_deref(),
                placed_ca: s_of(&l["placedCa"]),
                placed_cert: !l["placedCa"].is_null(),
                placed_root: s_of(&l["placedRoot"]),
                console_installed: l["consoleInstalled"] == json!(true),
                kept_profile: s_of(&l["keptProfile"]),
            };
            let preview = json!({ "deploy": c["preview"]["deploy"], "policy": { "profile": c["preview"]["policyProfile"] } });
            let lic_ok = |lic: &Value, id: &str| lic.is_object() && lic["root"].as_str() == Some(id);
            let got = deploy_decide(&local, &preview, &lic_ok);
            match c["words"].as_str() {
                None => assert!(got.is_ok(), "{}: {got:?}", c["name"]),
                Some(id) => {
                    let e = got.err().unwrap_or_else(|| panic!("{} must be refused with {id}", c["name"]));
                    assert!(words_are(&e, id), "{}: {e} is not {id}", c["name"]);
                }
            }
        }
    }

    #[test]
    fn the_marker_cases_of_the_deploy_vector() {
        let v = deploy_vector();
        let now = 1_900_000_000i64;
        for c in v["markers"].as_array().unwrap() {
            let m = c["marker"].as_object().map(|m| MarkerFacts {
                uid: m["uid"].as_u64().unwrap_or(u64::from(u32::MAX)) as u32,
                mode: m["mode"].as_u64().unwrap_or(0o777) as u32,
                symlink: m["symlink"] == json!(true),
                regular: m["regular"] != json!(false),
                enrollment: m["enrollment"].as_str().map(str::to_owned),
                sha256: m["sha256"].as_str().map(str::to_owned),
                at: m["ageSeconds"].as_i64().map(|a| now - a),
            });
            // with --binary, or Docker without the enroll image, the script wrote no marker the program could see
            let none = c["binary"] == json!(true) || (c["docker"] == json!(true) && c["dockerImage"] == json!(false));
            let m = if none { None } else { m };
            let (ok, words) = console_installed(m.as_ref(), c["profile"] == json!("high"), c["codeEnrollment"].as_str().unwrap_or_default(), c["exeSha256"].as_str(), c["previewSha256"].as_str(), now);
            assert_eq!(ok, c["consoleInstalled"] == json!(true), "{}", c["name"]);
            match c["words"].as_str() {
                Some(id) => assert!(words.as_deref().is_some_and(|w| words_are(w, id)), "{}", c["name"]),
                None => assert!(words.is_none(), "{}", c["name"]),
            }
        }
    }

    fn good_marker(now: i64) -> MarkerFacts {
        MarkerFacts { uid: 0, mode: 0o600, symlink: false, regular: true, enrollment: Some("en_0123456789abcdef".into()), sha256: Some("ab".repeat(32)), at: Some(now - 60) }
    }

    /// Invariant D14: console-installed rests only on a valid marker.
    #[test]
    fn console_installed_only_with_a_valid_marker() {
        let now = 1_900_000_000i64;
        let e = "en_0123456789abcdef";
        let d = "ab".repeat(32);
        let check = |m: &MarkerFacts, high: bool, exe: &str, prev: &str| console_installed(Some(m), high, e, Some(exe), Some(prev), now);
        assert_eq!(check(&good_marker(now), false, &d, &d), (true, None));
        // Docker's image marker: root-owned, 0444
        assert!(check(&MarkerFacts { mode: 0o444, ..good_marker(now) }, false, &d, &d).0);
        assert_eq!(console_installed(None, false, e, Some(&d), Some(&d), now), (false, None), "no marker (an empty header, --binary)");
        assert!(!check(&good_marker(now), true, &d, &d).0, "never under High");
        assert!(!check(&good_marker(now), false, &"cd".repeat(32), &d).0, "the running program differs");
        assert!(!check(&good_marker(now), false, &d, &"cd".repeat(32)).0, "the preview names another program");
        assert!(!check(&MarkerFacts { at: Some(now - 3600), ..good_marker(now) }, false, &d, &d).0, "an hour old");
        assert!(!check(&MarkerFacts { uid: 1000, ..good_marker(now) }, false, &d, &d).0, "owned by another user");
        assert!(!check(&MarkerFacts { mode: 0o620, ..good_marker(now) }, false, &d, &d).0, "group-writable");
        assert!(!check(&MarkerFacts { mode: 0o602, ..good_marker(now) }, false, &d, &d).0, "writable by others");
        assert!(!check(&MarkerFacts { symlink: true, ..good_marker(now) }, false, &d, &d).0, "a symbolic link");
        assert!(!check(&MarkerFacts { regular: false, ..good_marker(now) }, false, &d, &d).0, "not a regular file");
        let (ok, words) = check(&MarkerFacts { enrollment: Some("en_00000000000000ff".into()), ..good_marker(now) }, false, &d, &d);
        assert!(!ok);
        assert!(words.unwrap().contains("en_00000000000000ff"));
    }

    /// Invariant D14: no command flag claims console source; the host values come only with --deploy.
    #[test]
    fn no_option_claims_console_source() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        for flag in ["--console-installed", "--installed", "--marker", "--binary", "--offered", "--consoleInstalled"] {
            assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "linux", "--profile", "standard", flag])).is_err(), "{flag}");
            assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "linux", "--profile", "standard", flag, "yes"])).is_err(), "{flag} yes");
        }
        assert!(parse_enroll_args(&s(&["https://c.example", "--profile", "high"])).is_err(), "host values without --deploy");
        assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "linux"])).is_err(), "--deploy needs --profile");
        assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "cloud", "--profile", "high"])).is_err());
        assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "linux", "--profile", "high", "--host", "bad host"])).is_err());
        assert!(parse_enroll_args(&s(&["https://c.example", "--deploy", "linux", "--profile", "high", "--admins", "not-an-email"])).is_err());
        let a = parse_enroll_args(&s(&["https://c.example", "--config", "/etc/lucid-meet/relay.json", "--deploy", "docker", "--profile", "standard", "--pki", "console", "--admins", "Ann@X.org,bob@x.org", "--host", "Relay.Example.com", "--turn-host", "203.0.113.5", "--code-file", "/run/code/code"])).unwrap();
        let d = a.deploy.unwrap();
        assert_eq!((d.env.as_str(), d.profile.as_str(), d.pki.as_deref()), ("docker", "standard", Some("console")));
        assert_eq!(d.admins.unwrap(), vec!["ann@x.org".to_owned(), "bob@x.org".to_owned()]);
        assert_eq!(d.host.as_deref(), Some("relay.example.com"));
        assert_eq!(a.config, Some(PathBuf::from("/etc/lucid-meet/relay.json")));
        assert_eq!(a.code, CodeFrom::File(PathBuf::from("/run/code/code")));
        assert!(parse_enroll_args(&s(&["https://c.example", "--yes"])).unwrap().deploy.is_none());
    }

    fn meet_deploy(pki: &str) -> Value {
        json!({ "env": "linux", "host": "relay.example.com", "turnHost": "", "clients": [], "pki": pki, "binarySha256": "ab".repeat(32), "ca": null, "signer": null, "spokesRoot": null, "license": null, "offered": [] })
    }

    fn local_of<'a>(product: Product, high: bool, pki: Option<&'a str>) -> DeployLocal<'a> {
        DeployLocal { product, flag: Some("linux"), high, pki, host: None, turn_host: None, clients: None, placed_ca: Some("m_0123456789abcdef0123456789abcdef"), placed_cert: true, placed_root: Some("n_0123456789abcdef0123456789abcdef"), console_installed: false, kept_profile: None }
    }

    /// 6.3 steps 1 to 5 on local cases: High needs the host values and refuses a differing preview; Standard takes the
    /// preview's; plain enroll refuses a deploy preview; High refuses anything of trust from the console.
    #[test]
    fn the_6_3_rules_on_local_cases() {
        let no = |_: &Value, _: &str| false;
        let preview = |deploy: Value, profile: &str| json!({ "deploy": deploy, "policy": { "profile": profile } });
        let std_p = preview(meet_deploy("own"), "standard");
        // step 1
        let mut l = local_of(Product::Meet, false, Some("own"));
        assert!(words_are(&deploy_decide(&DeployLocal { flag: None, ..local_of(Product::Meet, false, Some("own")) }, &std_p, &no).unwrap_err(), "cli.deploy-needs-deploy"));
        assert!(words_are(&deploy_decide(&l, &json!({ "deploy": null, "policy": { "profile": "standard" } }), &no).unwrap_err(), "cli.deploy-not-deploy"));
        assert_eq!(deploy_decide(&DeployLocal { flag: None, ..local_of(Product::Meet, false, Some("own")) }, &json!({ "deploy": null, "policy": {} }), &no), Ok(None));
        assert!(words_are(&deploy_decide(&DeployLocal { flag: Some("docker"), ..local_of(Product::Meet, false, Some("own")) }, &std_p, &no).unwrap_err(), "cli.deploy-env"));
        let mut prox = meet_deploy("own");
        prox["env"] = json!("proxmox");
        assert!(deploy_decide(&l, &preview(prox, "standard"), &no).is_ok(), "a Proxmox code runs the Linux installer");
        // step 2
        assert!(words_are(&deploy_decide(&DeployLocal { kept_profile: Some("high"), ..local_of(Product::Meet, false, Some("own")) }, &std_p, &no).unwrap_err(), "cli.deploy-profile-changed"));
        assert!(words_are(&deploy_decide(&l, &preview(meet_deploy("own"), "high"), &no).unwrap_err(), "cli.deploy-profile"));
        assert!(words_are(&deploy_decide(&local_of(Product::Meet, true, Some("own")), &std_p, &no).unwrap_err(), "cli.enroll-high-standard"));
        assert!(words_are(&deploy_decide(&local_of(Product::Meet, false, Some("console")), &std_p, &no).unwrap_err(), "cli.deploy-pki"));
        // Standard: an absent value takes the preview's (R2-L3)
        let plan = deploy_decide(&l, &std_p, &no).unwrap().unwrap();
        assert_eq!((plan.host.as_str(), plan.turn_host.as_str()), ("relay.example.com", "relay.example.com"));
        // High: required, and a differing preview is refused
        let high_p = preview(meet_deploy("own"), "high");
        let mut h = local_of(Product::Meet, true, Some("own"));
        assert!(words_are(&deploy_decide(&h, &high_p, &no).unwrap_err(), "cli.deploy-host-differs"), "required under High");
        h.host = Some("other.example.com");
        h.turn_host = Some("");
        assert!(words_are(&deploy_decide(&h, &high_p, &no).unwrap_err(), "cli.deploy-host-differs"));
        h.host = Some("relay.example.com");
        assert!(deploy_decide(&h, &high_p, &no).is_ok());
        let other = vec!["192.0.2.0/24".to_owned()];
        let mut spokes_high = DeployLocal { clients: None, ..local_of(Product::Spokes, true, None) };
        spokes_high.host = Some("relay.example.com");
        let mut sd = meet_deploy("");
        sd["pki"] = Value::Null;
        sd["clients"] = json!(["10.0.0.0/8"]);
        assert!(words_are(&deploy_decide(&spokes_high, &preview(sd.clone(), "high"), &no).unwrap_err(), "cli.deploy-host-differs"));
        spokes_high.clients = Some(other.as_slice());
        assert!(words_are(&deploy_decide(&spokes_high, &preview(sd.clone(), "high"), &no).unwrap_err(), "cli.deploy-host-differs"));
        // step 3: a High relay takes no certificate, root or admin key from the console
        for (k, val) in [("pki", json!("console")), ("offered", json!([{ "fingerprint": "ab".repeat(32) }])), ("ca", json!({ "pem": "", "id": "m_x" })), ("spokesRoot", json!({ "pem": "", "id": "n_x" }))] {
            let mut d = meet_deploy("own");
            d[k] = val;
            let mut hl = local_of(Product::Meet, true, Some(if k == "pki" { "console" } else { "own" }));
            hl.host = Some("relay.example.com");
            hl.turn_host = Some("");
            assert!(words_are(&deploy_decide(&hl, &preview(d, "high"), &no).unwrap_err(), "cli.deploy-high-preview"), "{k}");
        }
        let mut unplaced = local_of(Product::Meet, true, Some("own"));
        unplaced.host = Some("relay.example.com");
        unplaced.turn_host = Some("");
        unplaced.placed_cert = false;
        assert!(words_are(&deploy_decide(&unplaced, &high_p, &no).unwrap_err(), "cli.deploy-anchor"));
        // step 5 and 6.7: a placed root differing from the preview's; a delivered root only when console-installed
        let mut ca = meet_deploy("console");
        ca["ca"] = json!({ "pem": "x", "id": "m_ffffffffffffffffffffffffffffffff" });
        l.pki = Some("console");
        assert!(words_are(&deploy_decide(&l, &preview(ca.clone(), "standard"), &no).unwrap_err(), "cli.deploy-root-differs"));
        l.placed_ca = None;
        assert!(words_are(&deploy_decide(&l, &preview(ca.clone(), "standard"), &no).unwrap_err(), "cli.deploy-anchor"));
        l.console_installed = true;
        let plan = deploy_decide(&l, &preview(ca, "standard"), &no).unwrap().unwrap();
        assert_eq!(plan.root, ("m_ffffffffffffffffffffffffffffffff".to_owned(), RootSource::Delivered));
        // Remote Spokes: a delivered root also needs its license to check out
        let mut sr = sd;
        sr["spokesRoot"] = json!({ "pem": "x", "id": "n_ffffffffffffffffffffffffffffffff" });
        let mut sl = local_of(Product::Spokes, false, None);
        sl.placed_root = None;
        sl.console_installed = true;
        assert!(words_are(&deploy_decide(&sl, &preview(sr.clone(), "standard"), &no).unwrap_err(), "cli.deploy-anchor"));
        let yes = |_: &Value, _: &str| true;
        assert_eq!(deploy_decide(&sl, &preview(sr, "standard"), &yes).unwrap().unwrap().root.1, RootSource::Delivered);
    }

    fn dummy_args() -> EnrollArgs {
        EnrollArgs { url: "https://c.example".into(), code: CodeFrom::Prompt, admin_keys: vec![], yes: false, deploy: None, config: None }
    }

    /// 7.3: the offered key needs a typed yes and, on Meeting Hub, an email in the locally typed admins.
    #[test]
    fn offered_keys_need_a_typed_yes_and_a_local_admin() {
        let code = w::code_parse(&w::code_encode(Product::Meet, &[1; 8], &[2; 20], &[3; 32])).unwrap();
        let args = dummy_args();
        let flags = DeployFlags::default();
        let d = crate::fleet_ca::tests_dir("offered");
        let ann = "a".repeat(64);
        let bob = "b".repeat(64);
        let dv = json!({ "offered": [{ "email": "ann@x.org", "role": "admin", "hint": "h1", "fingerprint": ann }, { "email": "bob@x.org", "role": "admin", "hint": "h2", "fingerprint": bob }] });
        let admins = vec!["ann@x.org".to_owned()];
        let run = |lines: &[&str], eligible: bool| {
            let mut t = Lines { tty: true, lines: lines.iter().map(|s| s.to_string()).collect(), out: String::new() };
            let got = DeployCli { product: Product::Meet, state_dir: &d, config: None, args: &args, flags: &flags, code: &code, term: &mut t, marker: d.join("marker") }.offered(&dv, &admins, eligible);
            (got, t.out)
        };
        let (got, out) = run(&["yes"], true);
        assert_eq!(got, vec![ann.clone()]);
        assert!(out.contains("ann@x.org") && !out.contains("bob@x.org"), "only a local admin's key is offered");
        assert!(out.contains(w::cli_words("cli.deploy-not-offered")), "bob is not a local admin");
        let (got, _) = run(&["y"], true);
        assert!(got.is_empty(), "only a typed yes");
        let (got, _) = run(&[""], true);
        assert!(got.is_empty(), "Enter alone means no");
        let (got, out) = run(&["yes"], false);
        assert!(got.is_empty() && out.contains(w::cli_words("cli.deploy-not-offered")) && !out.contains("ann@x.org"), "not console-installed, not fresh or High: never offered");
    }

    /// 6.5: the requests and the roots are inside T (the MAC and the management key's signature cover them).
    #[test]
    fn the_requests_and_roots_are_inside_t() {
        let relay = json!({ "product": "meet", "profile": "standard", "meetRoots": [], "meetCsr": null, "meetSignerCsr": null });
        let t0 = w::enroll_input("en_0123456789abcdef", &[1; 32], &[2; 65], &relay).unwrap();
        for (k, v) in [("meetCsr", json!("AAAA")), ("meetSignerCsr", json!("BBBB")), ("meetRoots", json!(["m_0123456789abcdef0123456789abcdef"]))] {
            let mut r = relay.clone();
            r[k] = v;
            assert_ne!(w::enroll_input("en_0123456789abcdef", &[1; 32], &[2; 65], &r).unwrap(), t0, "{k}");
        }
    }

    /// 6.5 and D4: the relay draws its keys into a new folder (0600) and sends only the requests; a discarded folder is
    /// wiped.
    #[test]
    fn meet_requests_are_drawn_here() {
        let d = crate::fleet_ca::tests_dir("meetcsr").join(PKI_DIR);
        let names = vec!["relay.example.com".to_owned(), "turn.example.com".to_owned()];
        let r = MeetRequests::draw(&d, names.clone(), true).unwrap();
        let csr = crate::meet_x509::Csr::from_der(r.csr.as_ref().unwrap()).unwrap();
        assert!(csr.signature_valid());
        assert_eq!(csr.names.dns, names);
        assert_eq!(csr.spki, r.key.as_ref().unwrap().spki());
        let s = crate::meet_x509::Csr::from_der(r.signer_csr.as_ref().unwrap()).unwrap();
        assert!(s.signature_valid());
        assert_eq!(s.names.uris, vec![SIGNER_URI.to_owned()]);
        assert_ne!(s.spki, csr.spki);
        for f in ["relay.key", "signer-client.key"] {
            let p = r.dir.join(f);
            assert!(std::fs::read_to_string(&p).unwrap().starts_with("-----BEGIN PRIVATE KEY-----"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        let dir = r.dir.clone();
        drop(r);
        assert!(!dir.exists(), "a discarded folder is wiped");
    }

    #[test]
    fn a_fresh_state_folder_holds_nothing_of_an_earlier_relay() {
        let d = crate::fleet_ca::tests_dir("fresh");
        for f in FRESH_FILES {
            std::fs::write(d.join(f), "x").unwrap();
        }
        std::fs::create_dir_all(d.join(PKI_DIR).join("placed")).unwrap();
        assert!(is_fresh(&d));
        std::fs::write(d.join("fleet-local-journal.json"), "{}").unwrap();
        assert!(!is_fresh(&d), "a relay that was ever enrolled");
        std::fs::remove_file(d.join("fleet-local-journal.json")).unwrap();
        std::fs::write(d.join("state.json"), "{}").unwrap();
        assert!(!is_fresh(&d));
    }

    #[test]
    fn fleet_status_fingerprint_only_once_enrolled() {
        let d = crate::fleet_ca::tests_dir("statusfp");
        assert_eq!(status_fingerprint(&d), None);
        write_link_file(&d, &json!({ "relayId": "r_0000000000000001", "pins": [], "fingerprint": "abcd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01" }).as_object().cloned().unwrap()).unwrap();
        assert_eq!(status_fingerprint(&d), None, "no certificate yet");
        write_link_file(&d, &json!({ "relayId": "r_0000000000000001", "cert": "AA", "fingerprint": "abcd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01" }).as_object().cloned().unwrap()).unwrap();
        assert_eq!(status_fingerprint(&d).as_deref(), Some("abcd ef01 2345 6789 abcd ef01 2345 6789 abcd ef01"));
    }

    /// 6.3: every refusal comes before any file is written; on success the env file and the handoff (with `deploy`)
    /// are written, the marker is deleted, `pki/` is untouched without `fleet_pki`, and the code is in no output.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_deploy_command_writes_only_after_every_check() {
        let (state, desk, _) = port::test_port("deploycli");
        let url = listen(&state).await;
        let code = port::mint_code(&state, &desk, now_ms() + HOUR);
        let code_text = w::code_encode(Product::Spokes, &code.id_bytes, code.secret.expose(), &code.pin);
        *desk.deploy.lock() = json!({ "env": "linux", "host": "relay.example.com", "turnHost": null, "clients": ["0.0.0.0/0", "::/0"], "pki": null, "binarySha256": "ab".repeat(32), "ca": null, "signer": null, "spokesRoot": null, "license": null, "offered": [] });
        let p = preview_async(&url, &code, None).await.unwrap();
        let d = crate::fleet_ca::tests_dir("deploycli-state");
        let root = Key::generate(Curve::P256).unwrap();
        std::fs::create_dir_all(d.join("deploy")).unwrap();
        std::fs::write(d.join("deploy").join("root.pub"), pem_text("PUBLIC KEY", &root.spki())).unwrap();
        let marker = d.join("marker.json");
        std::fs::write(&marker, stringify(&json!({ "enrollment": code.id(), "sha256": "ab".repeat(32), "at": now_ms() / 1000 }))).unwrap();
        let env_out = d.join("deploy.env");
        let args = dummy_args();
        let run = |flags: &DeployFlags, lines: &[&str]| {
            let mut t = Lines { tty: true, lines: lines.iter().map(|s| s.to_string()).collect(), out: String::new() };
            let r = DeployCli { product: Product::Spokes, state_dir: &d, config: None, args: &args, flags, code: &code, term: &mut t, marker: marker.clone() }.run(&code_text, &p);
            (r, t.out)
        };
        // a refusal: a High relay and a Standard console; nothing is written, the marker stays
        let high = DeployFlags { env: "linux".into(), profile: "high".into(), host: Some("relay.example.com".into()), clients: Some(vec!["0.0.0.0/0".into(), "::/0".into()]), env_out: Some(env_out.clone()), ..DeployFlags::default() };
        let (r, _) = run(&high, &["", "yes"]);
        assert!(words_are(&r.unwrap_err(), "cli.enroll-high-standard"));
        assert!(!has_handoff(&d) && !env_out.exists() && marker.exists());
        // Standard: the preview's values; the operator types yes
        let flags = DeployFlags { env: "linux".into(), profile: "standard".into(), env_out: Some(env_out.clone()), ..DeployFlags::default() };
        let (r, out) = run(&flags, &["", "yes"]);
        assert_eq!(r.unwrap(), w::cli_words("cli.deploy-next"));
        assert!(out.contains(&w::fill(w::cli_words("cli.deploy-root-id"), &[("id", &crate::identity::node_id_of(&root.spki()))])));
        assert!(!out.contains(&code_text) && !out.contains(&code_text[5..30]), "the code is in no output");
        let env = std::fs::read_to_string(&env_out).unwrap();
        assert_eq!(env, "HOST=relay.example.com\nTURN_HOST=\nCLIENTS=0.0.0.0/0,::/0\nPKI=\n");
        assert!(!marker.exists(), "the marker is deleted after the handoff");
        assert!(!d.join(PKI_DIR).exists(), "pki/ untouched without fleet_pki");
        let h = take_handoff(&d).unwrap().unwrap();
        let dep = h.deploy.unwrap();
        assert_eq!(dep["env"], "linux");
        // this test does not run as root, so the marker never makes it console-installed
        assert_eq!(dep["consoleInstalled"], Value::Null);
        assert_eq!(dep["offeredAccepted"], json!([]));
        // a plain enroll refuses a deploy preview before anything else (H2)
        assert!(words_are(&deploy_decide(&DeployLocal { flag: None, ..local_of(Product::Spokes, false, None) }, &p, &|_, _| false).unwrap_err(), "cli.deploy-needs-deploy"));
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_agent.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
