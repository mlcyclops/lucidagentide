// Audit and security events to a SIEM (contract AC-2a 10.2, interface F10): RFC 5424 messages carrying CEF, over TCP
// with TLS (RFC 5425), octet-counting framing (RFC 6587 3.4.1). The settings take effect only after a test message is
// accepted by TLS and written (staged save); the spool is two owner-only partitions (the console's own messages, and
// relay messages with guaranteed shares and revocable excess, A1-M3, A2-L1); relay entries are budgeted per entry and
// byte and must continue their relay's hash chain before they are forwarded.
//
// What leaves: only the 10.2 allow list (time, action, result, actor, address, target, relay, approval, chain hash,
// seq, `detail.code`, and `detail.reason` only with "Include reasons" on). Every value is cleaned (AC-1 0), cut to
// 1,020 characters and "..." when over 1,023, then escaped; a message is at most 8,192 bytes.

use crate::codec::{iso_time, stringify};
use crate::console::ApiError;
use crate::log::{Fields, Level, Logger};
use parking_lot::{Condvar, Mutex};
use rustls::pki_types::ServerName;
use rustls::{CipherSuite, ClientConfig, RootCertStore};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 6514;
pub const FACILITY: u8 = 13;
pub const VENDOR: &str = "TECHLEAD 187";
pub const PRODUCT: &str = "Lucid Admin Console";
pub const APP_NAME: &str = "lucid-console";
pub const MSG_MAX: usize = 8_192;
pub const VALUE_MAX: usize = 1_023;
const VALUE_CUT: usize = 1_020;
/// Each partition: at most 10,000 messages or 16 MiB.
pub const PART_MSGS: usize = 10_000;
pub const PART_BYTES: u64 = 16 << 20;
/// A relay's guaranteed share: `min(200, floor(10000 / activeRelayCount))` messages and
/// `min(320 KiB, floor(16 MiB / activeRelayCount))` bytes.
pub const SHARE_MSGS_MAX: usize = 200;
pub const SHARE_BYTES_MAX: u64 = 320 << 10;
/// 3.8: relay audit entries a minute, per relay and for all relays.
pub const RELAY_ENTRIES_MIN: u64 = 600;
pub const RELAY_BYTES_MIN: u64 = 512 << 10;
pub const ALL_ENTRIES_MIN: u64 = 6_000;
pub const ALL_BYTES_MIN: u64 = 4 << 20;
pub const CONSOLE_SPOOL: &str = "siem-spool-console.jsonl";
pub const RELAYS_SPOOL: &str = "siem-spool-relays.jsonl";
const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_FIRST: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const FIPS_BUILD: bool = cfg!(feature = "fips");

/// The `cef.<action>` names (13.1, the words vector's `cef`): the 13.2 dialog title without its question mark for
/// each AC-2a action with exactly one dialog. Other actions use the action itself.
pub const CEF_NAMES: [(&str, &str); 27] = [
    ("fleet.enroll.code", "Make an enrollment code for <name>"),
    ("fleet.relay.confirm", "Confirm <name>"),
    ("fleet.relay.label", "Rename <name>"),
    ("fleet.relay.remove", "Remove <name> from the console"),
    ("fleet.roster.endorse", "Confirm <n> new keys for <m> relays"),
    ("people.invite", "Ask for <email> to be invited to Meeting Hub on <relay>"),
    ("people.import", "Send <n> invites"),
    ("people.suspend", "Suspend <name> on <relay>"),
    ("people.unsuspend", "Lift the suspension of <name> on <relay>"),
    ("people.remove", "Remove <name> from <relay>"),
    ("exports.token.create", "Create a scrape token for <label>"),
    ("fleet.scopes", "Give the console <scopes>"),
    ("fleet.bootstrap-anchor", "Endorse your Admin Console key for <relay host>"),
    ("fleet.ca.trust", "Trust the new management CA"),
    ("fleet.server-revoke", "Replace the management certificate now"),
    ("fleet.ca.rollover", "Start management CA <generation>"),
    ("fleet.roster.cancel", "Cancel <hint> on <relay>"),
    ("fleet.left", "Leave the Admin Console at <origin>"),
    // AC-2b-D 13
    ("fleet.meet-ca.import", "Import the Meeting Hub organization CA <id>"),
    ("fleet.meet-ca.revoke", "Revoke certificate <serial>"),
    ("fleet.meet-ca.remove", "Remove the Meeting Hub organization CA"),
    ("fleet.meet-ca.crl", "Sign revocation list <number>"),
    ("fleet.meet-ca.crl-merged", "Add revocations seen on <relay>"),
    ("fleet.meet-cert.issue", "Issue a certificate for <relay>"),
    ("fleet.spokes-root.set", "Set the Remote Spokes organization root <id>"),
    ("fleet.meet-ca.prune", "Remove certificate <serial> from the revocation list"),
    ("fleet.meet-ca.signer-enforced", "Mark the certificate server <url> as <checking or not checking> revocation"),
];

pub fn cef_name(action: &str) -> &str {
    CEF_NAMES.iter().find(|(a, _)| *a == action).map_or(action, |(_, n)| *n)
}

/// CEF severity by result (audit) or level (security). `unknown` (a confirmed change interrupted by a relay crash)
/// takes refused's.
pub fn cef_severity(outcome: &str) -> u8 {
    match outcome {
        "ok" | "waiting" => 3,
        "summary" => 2,
        "refused" | "unknown" | "warn" => 6,
        "failed" => 7,
        "error" => 8,
        _ => 3,
    }
}

/// The syslog severity that makes PRI (facility 13 times 8 plus this).
pub fn syslog_severity(outcome: &str) -> u8 {
    match outcome {
        "refused" | "unknown" | "warn" => 4,
        "failed" | "error" => 3,
        _ => 6,
    }
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────────────────────

/// Where a message comes from: the console's audit, a relay's pushed audit, the console's security log.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Audit,
    Relays,
    Security,
}

impl Source {
    pub fn msgid(self) -> &'static str {
        match self {
            Source::Audit => "audit",
            Source::Relays => "relay",
            Source::Security => "security",
        }
    }
}

/// AC-1 section 0 cleaning: C0 and C1 controls (carriage return and line feed included), Bidi_Control and
/// Default_Ignorable_Code_Point characters removed.
pub fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() && !crate::console_auth::ignorable(*c)).collect()
}

/// More than 1,023 characters: the first 1,020 and "...".
pub fn cut(s: &str) -> String {
    if s.chars().count() <= VALUE_MAX {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(VALUE_CUT).collect();
    out.push_str("...");
    out
}

/// A CEF header value: `\` as `\\`, `|` as `\|`.
pub fn esc_header(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|")
}

/// A CEF extension value: `\` as `\\`, `=` as `\=`, carriage return as `\r`, line feed as `\n`.
pub fn esc_ext(s: &str) -> String {
    s.replace('\\', "\\\\").replace('=', "\\=").replace('\r', "\\r").replace('\n', "\\n")
}

fn prep(s: &str) -> String {
    cut(&clean(s))
}

/// A field as text: a string, or an integer; null, absent and anything else is absent.
fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A security log line's time: ms, or the log's ISO text.
fn ms_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => crate::meet_json::from_iso(s).map(|secs| (secs * 1000.0).round() as i64),
        _ => None,
    }
}

/// The full RFC 5424 message with its CEF for one audit entry (`Audit`, `Relays` with the relay's id) or security line
/// (`{ts, level, event, ip, code}`). None when the entry lacks what every message needs (time, action, result).
pub fn message(source: Source, entry: &Map<String, Value>, relay: Option<&str>, host: &str, version: &str, include_reasons: bool) -> Option<String> {
    let (ts, action, outcome, pairs): (i64, String, String, Vec<(&str, Option<String>)>) = if source == Source::Security {
        let ts = ms_of(entry.get("ts"))?;
        let action = entry.get("event")?.as_str()?.to_owned();
        let outcome = entry.get("level")?.as_str()?.to_owned();
        let code = text(entry.get("code"));
        let pairs = vec![
            ("rt", Some(ts.to_string())),
            ("act", Some(action.clone())),
            ("outcome", Some(outcome.clone())),
            ("src", text(entry.get("ip"))),
            ("cs2Label", Some("relay".into())),
            ("cs2", Some("console".into())),
            ("cs5Label", code.as_ref().map(|_| "code".into())),
            ("cs5", code),
        ];
        (ts, action, outcome, pairs)
    } else {
        let ts = entry.get("ts")?.as_i64()?;
        let action = entry.get("action")?.as_str()?.to_owned();
        let outcome = entry.get("result")?.as_str()?.to_owned();
        let detail = entry.get("detail").and_then(Value::as_object);
        let target = text(entry.get("target"));
        let approval = text(entry.get("approval"));
        let code = detail.and_then(|d| d.get("code")).and_then(Value::as_str).map(str::to_owned);
        let reason = if include_reasons { detail.and_then(|d| d.get("reason")).and_then(Value::as_str).map(str::to_owned) } else { None };
        let relay_value = if source == Source::Relays { relay?.to_owned() } else { "console".into() };
        let pairs = vec![
            ("rt", Some(ts.to_string())),
            ("act", Some(action.clone())),
            ("outcome", Some(outcome.clone())),
            ("suser", text(entry.get("actor"))),
            ("src", text(entry.get("ip"))),
            ("cs1Label", target.as_ref().map(|_| "target".into())),
            ("cs1", target),
            ("cs2Label", Some("relay".into())),
            ("cs2", Some(relay_value)),
            ("cs3Label", approval.as_ref().map(|_| "approval".into())),
            ("cs3", approval),
            ("cs4Label", Some("chain".into())),
            ("cs4", text(entry.get("hash"))),
            ("cn1Label", Some("seq".into())),
            ("cn1", text(entry.get("seq"))),
            ("cs5Label", code.as_ref().map(|_| "code".into())),
            ("cs5", code),
            ("cs6Label", reason.as_ref().map(|_| "reason".into())),
            ("cs6", reason),
        ];
        (ts, action, outcome, pairs)
    };
    let header: Vec<String> = [VENDOR, PRODUCT, version, action.as_str(), cef_name(&action)].iter().map(|x| esc_header(&prep(x))).collect();
    let ext: Vec<String> = pairs.into_iter().filter_map(|(k, v)| Some(format!("{k}={}", esc_ext(&prep(&v?))))).collect();
    let cef = format!("CEF:0|{}|{}|{}", header.join("|"), cef_severity(&outcome), ext.join(" "));
    let pri = u16::from(FACILITY) * 8 + u16::from(syslog_severity(&outcome));
    let host = syslog_host(host);
    let mut msg = format!("<{pri}>1 {} {host} {APP_NAME} - {} - {cef}", iso_time(ts), source.msgid());
    if msg.len() > MSG_MAX {
        let mut end = MSG_MAX - 3;
        while !msg.is_char_boundary(end) {
            end -= 1;
        }
        msg.truncate(end);
        msg.push_str("...");
    }
    Some(msg)
}

/// HOSTNAME as RFC 5424 allows it: printable ASCII without spaces, at most 255, `-` when empty.
fn syslog_host(host: &str) -> String {
    let h: String = host.chars().filter(|c| c.is_ascii_graphic()).take(255).collect();
    if h.is_empty() {
        "-".into()
    } else {
        h
    }
}

/// RFC 6587 octet counting: `<UTF-8 byte length> <message>`.
pub fn frame(msg: &str) -> String {
    format!("{} {msg}", msg.len())
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Events {
    pub audit: bool,
    pub security: bool,
    pub relays: bool,
}

impl Events {
    fn to_json(self) -> Value {
        let mut v = Vec::new();
        for (on, name) in [(self.audit, "audit"), (self.security, "security"), (self.relays, "relays")] {
            if on {
                v.push(Value::from(name));
            }
        }
        Value::Array(v)
    }

    fn from_json(v: &Value) -> Option<Events> {
        let a = v.as_array()?;
        let mut e = Events::default();
        for x in a {
            let slot = match x.as_str()? {
                "audit" => &mut e.audit,
                "security" => &mut e.security,
                "relays" => &mut e.relays,
                _ => return None,
            };
            if *slot {
                return None;
            }
            *slot = true;
        }
        (!a.is_empty()).then_some(e)
    }
}

/// The SIEM settings (the client key is never here: it is sealed as `siem-client-key` by the console).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiemSettings {
    pub host: String,
    pub port: u16,
    pub ca_pem: Option<String>,
    pub client_cert_pem: Option<String>,
    pub events: Events,
    pub include_reasons: bool,
}

const BODY_KEYS: [&str; 9] = ["host", "port", "caPem", "clientCertPem", "clientKeyPem", "events", "includeReasons", "reason", "stepup"];

fn host_ok(h: &str) -> bool {
    if h.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    (1..=253).contains(&h.len())
        && h.split('.').all(|l| (1..=63).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-'))
}

fn certs_of(pem: &str) -> Option<Vec<rustls::pki_types::CertificateDer<'static>>> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut pem.as_bytes()).collect::<Result<_, _>>().ok()?;
    (!certs.is_empty()).then_some(certs)
}

impl SiemSettings {
    /// `POST /console/api/settings/exports/siem` (turning on or changing): Err with the 13.3 refusal. Under High the
    /// FIPS build and the SIEM's CA are required. `clientKeyPem` is only checked to come with `clientCertPem`.
    pub fn from_body(body: &Value, high: bool, fips: bool) -> Result<SiemSettings, ApiError> {
        let o = body.as_object().ok_or_else(|| ApiError::of("invalid"))?;
        if o.keys().any(|k| !BODY_KEYS.contains(&k.as_str())) {
            return Err(ApiError::of("unknown-field"));
        }
        if high && !fips {
            return Err(ApiError::of("fips-needed"));
        }
        let host = o.get("host").and_then(Value::as_str).map(|h| h.trim().to_ascii_lowercase()).filter(|h| host_ok(h)).ok_or_else(|| ApiError::with("invalid", "The SIEM host must be a DNS name or an IP address."))?;
        let port = match o.get("port") {
            None | Some(Value::Null) => DEFAULT_PORT,
            Some(v) => v.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).ok_or_else(|| ApiError::with("invalid", "The SIEM port must be 1 to 65535."))?,
        };
        let pem = |k: &str| o.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
        let ca_pem = pem("caPem");
        if let Some(ca) = &ca_pem {
            certs_of(ca).ok_or_else(|| ApiError::with("invalid", "The certificate authority is not a PEM certificate."))?;
        } else if high {
            return Err(ApiError::of("siem-ca-needed"));
        }
        let client_cert_pem = pem("clientCertPem");
        if client_cert_pem.is_some() != pem("clientKeyPem").is_some() {
            return Err(ApiError::with("invalid", "A client certificate needs its key, and a key its certificate."));
        }
        if let Some(c) = &client_cert_pem {
            certs_of(c).ok_or_else(|| ApiError::with("invalid", "The client certificate is not a PEM certificate."))?;
        }
        let events = o.get("events").and_then(Events::from_json).ok_or_else(|| ApiError::with("invalid", "Choose the events to send: audit, security or relays."))?;
        let include_reasons = match o.get("includeReasons") {
            None | Some(Value::Null) => false,
            Some(v) => v.as_bool().ok_or_else(|| ApiError::of("invalid"))?,
        };
        Ok(SiemSettings { host, port, ca_pem, client_cert_pem, events, include_reasons })
    }

    pub fn to_json(&self) -> Value {
        json!({"host": self.host, "port": self.port, "caPem": self.ca_pem, "clientCertPem": self.client_cert_pem, "events": self.events.to_json(), "includeReasons": self.include_reasons})
    }

    pub fn from_json(v: &Value) -> Option<SiemSettings> {
        let o = v.as_object()?;
        let host = o.get("host")?.as_str()?.to_owned();
        if !host_ok(&host) {
            return None;
        }
        let opt = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
        Some(SiemSettings {
            host,
            port: u16::try_from(o.get("port")?.as_u64()?).ok().filter(|p| *p > 0)?,
            ca_pem: opt("caPem"),
            client_cert_pem: opt("clientCertPem"),
            events: Events::from_json(o.get("events")?)?,
            include_reasons: o.get("includeReasons")?.as_bool()?,
        })
    }

    /// The `GET /console/api/settings/exports` view: no PEM bodies.
    pub fn view(&self) -> Value {
        json!({"host": self.host, "port": self.port, "caSet": self.ca_pem.is_some(), "clientCertSet": self.client_cert_pem.is_some(), "events": self.events.to_json(), "includeReasons": self.include_reasons})
    }
}

/// The client TLS config: TLS 1.3 with AES-GCM (3.7's two suites), or TLS 1.2 with ECDHE and AES-GCM only; the server
/// verified against the given CA (or, under Standard with none given, the system roots) and its name checked; the FIPS
/// provider in a `fips` build.
pub fn tls_config(s: &SiemSettings, client_key_pem: Option<&str>) -> Result<Arc<ClientConfig>, String> {
    let mut provider = crate::server::provider();
    provider.cipher_suites.retain(|c| {
        matches!(
            c.suite(),
            CipherSuite::TLS13_AES_256_GCM_SHA384
                | CipherSuite::TLS13_AES_128_GCM_SHA256
                | CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
                | CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
                | CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
                | CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        )
    });
    let mut roots = RootCertStore::empty();
    match &s.ca_pem {
        Some(pem) => {
            for c in certs_of(pem).ok_or("the certificate authority is not a PEM certificate")? {
                roots.add(c).map_err(|e| format!("the certificate authority cannot be used ({e})"))?;
            }
        }
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
    }
    let b = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| format!("no allowed TLS settings ({e})"))?
        .with_root_certificates(roots);
    let cfg = match (&s.client_cert_pem, client_key_pem) {
        (Some(cert), Some(key)) => {
            let key = rustls_pemfile::private_key(&mut key.as_bytes()).ok().flatten().ok_or("the client key is not a PEM private key")?;
            b.with_client_auth_cert(certs_of(cert).ok_or("the client certificate is not a PEM certificate")?, key).map_err(|e| format!("the client certificate and key do not fit ({e})"))?
        }
        (None, _) => b.with_no_client_auth(),
        (Some(_), None) => return Err("the client certificate has no key".into()),
    };
    Ok(Arc::new(cfg))
}

/// Why a send failed, in words for `siem-failed` (`<why>`).
fn why_of(e: &std::io::Error) -> String {
    if let Some(r) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
        return match r {
            rustls::Error::InvalidCertificate(c) => format!("the SIEM's certificate did not verify ({c:?})"),
            rustls::Error::AlertReceived(a) => format!("the SIEM refused the connection ({a:?})"),
            other => format!("the TLS handshake failed ({other})"),
        };
    }
    format!("the connection failed ({})", e.kind())
}

/// One TLS connection to the SIEM.
struct Conn(rustls::StreamOwned<rustls::ClientConnection, TcpStream>);

impl Conn {
    fn open(host: &str, port: u16, cfg: &Arc<ClientConfig>) -> Result<Conn, String> {
        let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|_| "the SIEM's host name did not resolve".to_string())?.collect();
        let mut last = "the SIEM did not answer".to_string();
        for a in addrs {
            match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
                Ok(tcp) => {
                    let _ = tcp.set_read_timeout(Some(IO_TIMEOUT));
                    let _ = tcp.set_write_timeout(Some(IO_TIMEOUT));
                    let name = ServerName::try_from(host.to_owned()).map_err(|_| "the SIEM host is not a valid name".to_string())?;
                    let conn = rustls::ClientConnection::new(cfg.clone(), name).map_err(|e| format!("the TLS handshake failed ({e})"))?;
                    return Ok(Conn(rustls::StreamOwned::new(conn, tcp)));
                }
                Err(e) => last = format!("the SIEM did not answer ({})", e.kind()),
            }
        }
        Err(last)
    }

    /// Write one framed message: the handshake (server verified) runs before the first byte.
    fn send(&mut self, framed: &str) -> Result<(), String> {
        self.0.write_all(framed.as_bytes()).and_then(|_| self.0.flush()).map_err(|e| why_of(&e))
    }

    fn close(mut self) {
        self.0.conn.send_close_notify();
        let _ = self.0.flush();
    }
}

/// The staged-save check and "Send a test message": connect, verify, write one `exports.siem-test` message, close.
fn send_test(s: &SiemSettings, cfg: &Arc<ClientConfig>, host: &str, version: &str) -> Result<(), String> {
    let mut c = Conn::open(&s.host, s.port, cfg)?;
    let mut entry = Map::new();
    entry.insert("seq".into(), Value::from(0));
    entry.insert("ts".into(), Value::from(crate::codec::now_ms()));
    entry.insert("actor".into(), Value::from("console"));
    entry.insert("action".into(), Value::from("exports.siem-test"));
    entry.insert("result".into(), Value::from("ok"));
    entry.insert("hash".into(), Value::from("0".repeat(64)));
    let msg = message(Source::Audit, &entry, None, host, version, false).ok_or("the test message could not be made")?;
    c.send(&frame(&msg))?;
    c.close();
    Ok(())
}

// ── Spool ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Item {
    relay: Option<String>,
    seq: Option<i64>,
    msg: String,
}

/// One owner-only spool file: live items by id (oldest first), pushes and deletions appended, compacted when dead
/// lines outweigh live ones.
struct Partition {
    path: Option<PathBuf>,
    items: BTreeMap<u64, Item>,
    bytes: u64,
    file_bytes: u64,
}

impl Partition {
    fn open(path: Option<PathBuf>, next_id: &mut u64, torn: &mut u64) -> Partition {
        let mut p = Partition { path, items: BTreeMap::new(), bytes: 0, file_bytes: 0 };
        let Some(path) = p.path.clone() else { return p };
        let Ok(f) = std::fs::File::open(&path) else { return p };
        for line in BufReader::new(f).split(b'\n') {
            let Ok(line) = line else { break };
            p.file_bytes += line.len() as u64 + 1;
            let v = std::str::from_utf8(&line).ok().and_then(crate::codec::parse_json);
            match v.as_ref().and_then(Value::as_object) {
                Some(o) if o.contains_key("del") => {
                    if let Some(it) = o["del"].as_u64().and_then(|id| p.items.remove(&id)) {
                        p.bytes -= it.msg.len() as u64;
                    }
                }
                Some(o) => match (o.get("id").and_then(Value::as_u64), o.get("msg").and_then(Value::as_str)) {
                    (Some(id), Some(msg)) => {
                        let it = Item { relay: o.get("relay").and_then(Value::as_str).map(str::to_owned), seq: o.get("seq").and_then(Value::as_i64), msg: msg.to_owned() };
                        p.bytes += it.msg.len() as u64;
                        p.items.insert(id, it);
                        *next_id = (*next_id).max(id + 1);
                    }
                    _ => *torn += 1,
                },
                None => *torn += 1,
            }
        }
        p.compact();
        p
    }

    fn append(&mut self, line: &str) {
        let Some(path) = &self.path else { return };
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        if let Ok(mut f) = o.open(path) {
            if f.write_all(format!("{line}\n").as_bytes()).is_ok() {
                self.file_bytes += line.len() as u64 + 1;
            }
        }
    }

    fn push(&mut self, id: u64, it: Item) {
        let line = stringify(&json!({"id": id, "relay": it.relay, "seq": it.seq, "msg": it.msg}));
        self.append(&line);
        self.bytes += it.msg.len() as u64;
        self.items.insert(id, it);
    }

    fn remove(&mut self, id: u64) -> Option<Item> {
        let it = self.items.remove(&id)?;
        self.bytes -= it.msg.len() as u64;
        self.append(&format!("{{\"del\":{id}}}"));
        if self.file_bytes > 2 * self.bytes + (1 << 20) {
            self.compact();
        }
        Some(it)
    }

    /// Rewrite the file with the live items only (atomically, owner-only).
    fn compact(&mut self) {
        let Some(path) = &self.path else { return };
        let mut out = String::new();
        for (id, it) in &self.items {
            out.push_str(&stringify(&json!({"id": id, "relay": it.relay, "seq": it.seq, "msg": it.msg})));
            out.push('\n');
        }
        if crate::store::write_private(path, out.as_bytes()).is_ok() {
            self.file_bytes = out.len() as u64;
        }
    }
}

/// Dropped messages awaiting their summary: how many and the seq range.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Dropped {
    count: u64,
    from: Option<i64>,
    to: Option<i64>,
}

impl Dropped {
    fn add(&mut self, seq: Option<i64>) {
        self.count += 1;
        if let Some(s) = seq {
            self.from = Some(self.from.map_or(s, |f| f.min(s)));
            self.to = Some(self.to.map_or(s, |t| t.max(s)));
        }
    }
}

#[derive(Default)]
struct RelayUse {
    ids: VecDeque<u64>,
    bytes: u64,
}

/// The two partitions and the relay shares.
pub struct Spool {
    console: Partition,
    relays: Partition,
    by_relay: HashMap<String, RelayUse>,
    next_id: u64,
    /// Relays that pushed an audit entry in the last 24 hours, with when.
    active: HashMap<String, i64>,
    active_count: usize,
    last_recompute: i64,
    console_dropped: Dropped,
    relay_dropped: BTreeMap<String, Dropped>,
    /// Since start: every dropped message (status and Overview).
    dropped_total: u64,
}

/// A relay's guaranteed share (messages, bytes) for `active` active relays.
pub fn share(active: usize) -> (usize, u64) {
    let n = active.max(1);
    (SHARE_MSGS_MAX.min(PART_MSGS / n), SHARE_BYTES_MAX.min(PART_BYTES / n as u64))
}

impl Spool {
    /// The partitions in `dir` (None: memory only, for tests).
    pub fn open(dir: Option<&Path>) -> Spool {
        let (mut next_id, mut torn) = (1, 0);
        let console = Partition::open(dir.map(|d| d.join(CONSOLE_SPOOL)), &mut next_id, &mut torn);
        let relays = Partition::open(dir.map(|d| d.join(RELAYS_SPOOL)), &mut next_id, &mut torn);
        let mut by_relay: HashMap<String, RelayUse> = HashMap::new();
        for (id, it) in &relays.items {
            let u = by_relay.entry(it.relay.clone().unwrap_or_default()).or_default();
            u.ids.push_back(*id);
            u.bytes += it.msg.len() as u64;
        }
        let mut s = Spool {
            console,
            relays,
            by_relay,
            next_id,
            active: HashMap::new(),
            active_count: 1,
            last_recompute: 0,
            console_dropped: Dropped::default(),
            relay_dropped: BTreeMap::new(),
            dropped_total: 0,
        };
        for _ in 0..torn {
            s.console_dropped.add(None);
            s.dropped_total += 1;
        }
        s
    }

    pub fn len(&self) -> usize {
        self.console.items.len() + self.relays.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `activeRelayCount`: relays that pushed in the last 24 hours, never less than 1; recomputed every hour and when a
    /// relay becomes active.
    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.active_count
    }

    pub fn note_active(&mut self, relay: &str, now: i64) {
        let newly = self.active.get(relay).is_none_or(|t| now - t >= DAY);
        self.active.insert(relay.to_owned(), now);
        if newly || now - self.last_recompute >= HOUR {
            self.recompute(now);
        }
    }

    fn recompute(&mut self, now: i64) {
        self.active.retain(|_, t| now - *t < DAY);
        self.active_count = self.active.len().max(1);
        self.last_recompute = now;
    }

    pub fn tick(&mut self, now: i64) {
        if now - self.last_recompute >= HOUR {
            self.recompute(now);
        }
    }

    /// The console's own message: its partition only, the oldest dropped when full.
    pub fn push_console(&mut self, seq: Option<i64>, msg: String) {
        let b = msg.len() as u64;
        while !self.console.items.is_empty() && (self.console.items.len() + 1 > PART_MSGS || self.console.bytes + b > PART_BYTES) {
            let id = *self.console.items.keys().next().unwrap();
            if let Some(it) = self.console.remove(id) {
                self.console_dropped.add(it.seq);
                self.dropped_total += 1;
            }
        }
        let id = self.next_id;
        self.next_id += 1;
        self.console.push(id, Item { relay: None, seq, msg });
    }

    fn usage(&self, relay: &str) -> (usize, u64) {
        self.by_relay.get(relay).map_or((0, 0), |u| (u.ids.len(), u.bytes))
    }

    fn over(&self, relay: &str, sm: usize, sb: u64) -> (usize, u64) {
        let (m, b) = self.usage(relay);
        (m.saturating_sub(sm), b.saturating_sub(sb))
    }

    fn evict_oldest_of(&mut self, relay: &str) {
        let Some(id) = self.by_relay.get_mut(relay).and_then(|u| u.ids.pop_front()) else { return };
        if let Some(it) = self.relays.remove(id) {
            if let Some(u) = self.by_relay.get_mut(relay) {
                u.bytes -= it.msg.len() as u64;
                if u.ids.is_empty() {
                    self.by_relay.remove(relay);
                }
            }
            self.relay_dropped.entry(relay.to_owned()).or_default().add(it.seq);
            self.dropped_total += 1;
        }
    }

    /// A relay's message into the relay partition. When full: if the relay is within its guaranteed share, other
    /// relays' excess goes first, oldest first; otherwise the relay furthest above its share loses its oldest. A
    /// guaranteed share is never evicted; when nothing can make room, the new message is dropped.
    pub fn push_relay(&mut self, relay: &str, seq: Option<i64>, msg: String) {
        let b = msg.len() as u64;
        let (sm, sb) = share(self.active_count);
        loop {
            if self.relays.items.len() < PART_MSGS && self.relays.bytes + b <= PART_BYTES {
                break;
            }
            let (m, mb) = self.usage(relay);
            let within = m < sm && mb + b <= sb;
            let victim = if within {
                // the oldest message held as excess by any relay
                self.by_relay
                    .iter()
                    .filter(|(r, u)| (u.ids.len() > sm || u.bytes > sb) && r.as_str() != relay)
                    .filter_map(|(r, u)| Some((*u.ids.front()?, r.clone())))
                    .min()
                    .map(|(_, r)| r)
            } else {
                // the relay furthest above its share (this one counted with the new message)
                let mut best: Option<((usize, u64), String)> = None;
                for r in self.by_relay.keys() {
                    let mut o = self.over(r, sm, sb);
                    if r == relay {
                        o = ((m + 1).saturating_sub(sm), (mb + b).saturating_sub(sb));
                    }
                    if o != (0, 0) && best.as_ref().is_none_or(|(bo, br)| o > *bo || (o == *bo && r < br)) {
                        best = Some((o, r.clone()));
                    }
                }
                best.map(|(_, r)| r)
            };
            match victim {
                Some(v) if self.by_relay.contains_key(&v) => self.evict_oldest_of(&v),
                _ => {
                    self.relay_dropped.entry(relay.to_owned()).or_default().add(seq);
                    self.dropped_total += 1;
                    return;
                }
            }
        }
        let id = self.next_id;
        self.next_id += 1;
        self.relays.push(id, Item { relay: Some(relay.to_owned()), seq, msg });
        let u = self.by_relay.entry(relay.to_owned()).or_default();
        u.ids.push_back(id);
        u.bytes += b;
    }

    /// The next message to send: the console partition always first, then the oldest relay message.
    fn next(&self) -> Option<(u64, String)> {
        self.console.items.iter().next().or_else(|| self.relays.items.iter().next()).map(|(id, it)| (*id, it.msg.clone()))
    }

    /// A message the SIEM took.
    fn sent(&mut self, id: u64) {
        if self.console.remove(id).is_some() {
            return;
        }
        if let Some(it) = self.relays.remove(id) {
            let r = it.relay.unwrap_or_default();
            if let Some(u) = self.by_relay.get_mut(&r) {
                u.ids.retain(|x| *x != id);
                u.bytes -= it.msg.len() as u64;
                if u.ids.is_empty() {
                    self.by_relay.remove(&r);
                }
            }
        }
    }
}

// ── Relay entries: budgets and chains ───────────────────────────────────────────────────────────────────────

#[derive(Default, Clone, Copy)]
struct Window {
    start: i64,
    entries: u64,
    bytes: u64,
}

impl Window {
    fn fits(&mut self, now: i64, bytes: u64, max_entries: u64, max_bytes: u64) -> bool {
        if now - self.start >= MINUTE {
            *self = Window { start: now, entries: 0, bytes: 0 };
        }
        self.entries < max_entries && self.bytes + bytes <= max_bytes
    }

    fn take(&mut self, bytes: u64) {
        self.entries += 1;
        self.bytes += bytes;
    }
}

#[derive(Default)]
struct Chain {
    /// The last forwarded entry's seq and hash; None at first, and after a refusal (the next entry that recomputes
    /// becomes the new start of the checked chain).
    last: Option<(i64, String)>,
    window: Window,
}

/// A gap in what reached the SIEM, waiting for its hourly summary.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Gap {
    why: &'static str,
    from: i64,
    to: i64,
}

/// The per-relay chains and budgets, and the gaps found.
#[derive(Default)]
pub struct Gate {
    chains: HashMap<String, Chain>,
    all: Window,
    gaps: BTreeMap<String, Gap>,
    last_gap_summary: HashMap<String, i64>,
    last_gap_at: HashMap<String, i64>,
}

impl Gate {
    fn gap(&mut self, relay: &str, why: &'static str, seq: i64, now: i64) {
        let g = self.gaps.entry(relay.to_owned()).or_insert(Gap { why, from: seq, to: seq });
        g.from = g.from.min(seq);
        g.to = g.to.max(seq);
        self.last_gap_at.insert(relay.to_owned(), now);
    }

    /// The entries of one `audit` frame that may be forwarded, in order. Each is counted against the per-relay and
    /// global minute budgets, and must continue the relay's chain (seq one more than the last forwarded, prev equal to
    /// its hash, the hash recomputed as AC-1 6); an entry whose hash does not recompute is never forwarded.
    pub fn check(&mut self, relay: &str, entries: &[Value], now: i64) -> Vec<Map<String, Value>> {
        let mut out = Vec::new();
        for e in entries {
            let o = e.as_object();
            let seq = o.and_then(|o| o.get("seq")).and_then(Value::as_i64).unwrap_or(-1);
            let bytes = stringify(e).len() as u64;
            let chain = self.chains.entry(relay.to_owned()).or_default();
            if !chain.window.fits(now, bytes, RELAY_ENTRIES_MIN, RELAY_BYTES_MIN) || !self.all.fits(now, bytes, ALL_ENTRIES_MIN, ALL_BYTES_MIN) {
                chain.last = None;
                self.gap(relay, "budget", seq, now);
                continue;
            }
            chain.window.take(bytes);
            self.all.take(bytes);
            let Some(o) = o.filter(|o| o.len() == crate::console_audit::ENTRY_KEYS.len() && crate::console_audit::ENTRY_KEYS.iter().all(|k| o.contains_key(*k))) else {
                chain.last = None;
                self.gap(relay, "chain", seq, now);
                continue;
            };
            let (prev, hash) = (o["prev"].as_str().unwrap_or(""), o["hash"].as_str().unwrap_or(""));
            if seq < 1 || crate::console_audit::entry_hash(prev, o).as_deref() != Some(hash) {
                chain.last = None;
                self.gap(relay, "chain", seq, now);
                continue;
            }
            let why = match &chain.last {
                Some((s, _)) if seq != s + 1 => Some("gap"),
                Some((_, h)) if prev != h => Some("chain"),
                _ => None,
            };
            if let Some(why) = why {
                chain.last = None;
                self.gap(relay, why, seq, now);
                continue;
            }
            chain.last = Some((seq, hash.to_owned()));
            out.push(o.clone());
        }
        out
    }
}

// ── The SIEM forwarder ──────────────────────────────────────────────────────────────────────────────────────

struct Active {
    settings: SiemSettings,
    cfg: Arc<ClientConfig>,
}

struct State {
    active: Option<Active>,
    high: bool,
    generation: u64,
    spool: Spool,
    gate: Gate,
    last_error: Option<String>,
    last_dropped_summary: Option<i64>,
    stop: bool,
}

struct Inner {
    state: Mutex<State>,
    wake: Condvar,
    host: String,
    version: String,
    logger: Option<Arc<Logger>>,
}

/// The Overview items: `siem-failing` (with its why), `siem-dropped` (dropped since start), `relay-gap` (relays with a
/// gap in the last 24 hours).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SiemAttention {
    pub failing: Option<String>,
    pub dropped: u64,
    pub gaps: Vec<String>,
}

/// The console's SIEM forwarding.
pub struct Siem {
    inner: Arc<Inner>,
}

impl Drop for Siem {
    fn drop(&mut self) {
        self.inner.state.lock().stop = true;
        self.inner.wake.notify_all();
    }
}

impl Siem {
    /// The spool in `state_dir` and the sender thread (idle until settings are configured).
    pub fn open(state_dir: &Path, host: &str, version: &str, logger: Arc<Logger>) -> Arc<Siem> {
        Siem::start(Some(state_dir), host, version, Some(logger))
    }

    fn start(state_dir: Option<&Path>, host: &str, version: &str, logger: Option<Arc<Logger>>) -> Arc<Siem> {
        let state = State { active: None, high: false, generation: 0, spool: Spool::open(state_dir), gate: Gate::default(), last_error: None, last_dropped_summary: None, stop: false };
        let inner = Arc::new(Inner { state: Mutex::new(state), wake: Condvar::new(), host: host.to_owned(), version: version.to_owned(), logger });
        let i = inner.clone();
        let _ = std::thread::Builder::new().name("fleet-siem".into()).spawn(move || sender(i));
        Arc::new(Siem { inner })
    }

    /// The console's profile: under High only the FIPS build sends, and a new destination needs its CA (4.10, 10.2).
    pub fn set_high(&self, high: bool) {
        self.inner.state.lock().high = high;
        self.inner.wake.notify_all();
    }

    fn activate(&self, active: Option<Active>) {
        let mut st = self.inner.state.lock();
        st.active = active;
        st.last_error = None;
        st.generation += 1;
        drop(st);
        self.inner.wake.notify_all();
    }

    /// The settings at start (from the console's book, the key unsealed), or None when forwarding is off. Settings that
    /// no longer make a TLS configuration (a CA or key that does not read) leave forwarding stopped and failing with the
    /// reason, so Overview raises `siem-failing`.
    pub fn configure(&self, settings: Option<(SiemSettings, Option<String>)>) {
        match settings {
            Some((s, key)) => match tls_config(&s, key.as_deref()) {
                Ok(cfg) => self.activate(Some(Active { settings: s, cfg })),
                Err(why) => {
                    self.activate(None);
                    fail(&self.inner, why);
                }
            },
            None => self.activate(None),
        }
    }

    /// Staged save: a test message under the new settings first; they replace the old ones only when it was accepted by
    /// TLS and written. Err is the `<why>` of `siem-failed`; the old settings stay.
    pub fn stage(&self, settings: SiemSettings, client_key_pem: Option<String>) -> Result<(), String> {
        if self.inner.state.lock().high && (!FIPS_BUILD || settings.ca_pem.is_none()) {
            return Err(if FIPS_BUILD { "the High profile needs the SIEM's certificate authority".into() } else { "the High profile needs the FIPS build".into() });
        }
        let cfg = tls_config(&settings, client_key_pem.as_deref())?;
        send_test(&settings, &cfg, &self.inner.host, &self.inner.version)?;
        self.activate(Some(Active { settings, cfg }));
        Ok(())
    }

    /// Forwarding off (after the second admin when two-person is on); the spool is kept.
    pub fn off(&self) {
        self.activate(None);
    }

    /// "Send a test message" with the current settings.
    pub fn test(&self) -> Result<(), String> {
        let st = self.inner.state.lock();
        let Some(a) = &st.active else { return Err("forwarding is off".into()) };
        let cfg = a.cfg.clone();
        let s = a.settings.clone();
        drop(st);
        send_test(&s, &cfg, &self.inner.host, &self.inner.version)
    }

    fn forwarding(st: &State) -> Option<&SiemSettings> {
        st.active.as_ref().map(|a| &a.settings)
    }

    /// One of the console's own audit entries, after it was appended.
    pub fn console_entry(&self, entry: &Map<String, Value>) {
        let mut st = self.inner.state.lock();
        let Some(s) = Siem::forwarding(&st).filter(|s| s.events.audit) else { return };
        let Some(msg) = message(Source::Audit, entry, None, &self.inner.host, &self.inner.version, s.include_reasons) else { return };
        st.spool.push_console(entry.get("seq").and_then(Value::as_i64), msg);
        drop(st);
        self.inner.wake.notify_all();
    }

    /// One of the console's security log lines (`cat` security), as the logger wrote it.
    pub fn security_line(&self, line: &Map<String, Value>) {
        let mut st = self.inner.state.lock();
        if Siem::forwarding(&st).filter(|s| s.events.security).is_none() {
            return;
        }
        let mut e = Map::new();
        for k in ["ts", "level", "event", "ip", "code"] {
            if let Some(v) = line.get(k) {
                e.insert(k.into(), v.clone());
            }
        }
        let Some(msg) = message(Source::Security, &e, None, &self.inner.host, &self.inner.version, false) else { return };
        st.spool.push_console(None, msg);
        drop(st);
        self.inner.wake.notify_all();
    }

    /// A relay's `audit` frame (the relay holds `read-logs` with `people`): budgets and chain checks, then the
    /// forwarded entries into the relay partition.
    pub fn relay_audit(&self, relay: &str, entries: &[Value], now: i64) {
        let mut st = self.inner.state.lock();
        st.spool.note_active(relay, now);
        let Some(include) = Siem::forwarding(&st).filter(|s| s.events.relays).map(|s| s.include_reasons) else { return };
        let ok = st.gate.check(relay, entries, now);
        for e in ok {
            if let Some(msg) = message(Source::Relays, &e, Some(relay), &self.inner.host, &self.inner.version, include) {
                st.spool.push_relay(relay, e.get("seq").and_then(Value::as_i64), msg);
            }
        }
        drop(st);
        self.inner.wake.notify_all();
    }

    /// The console-written summaries due now (actor `console`): one `exports.siem-dropped` an hour at most, and one
    /// `exports.relay-gap` an hour at most per relay (spool evictions are gaps with `why: "budget"`).
    pub fn take_summaries(&self, now: i64) -> Vec<(&'static str, Value)> {
        let mut st = self.inner.state.lock();
        let st = &mut *st;
        st.spool.tick(now);
        let mut out = Vec::new();
        for (relay, d) in &st.spool.relay_dropped {
            if d.count > 0 {
                let seq = d.from.unwrap_or(-1);
                st.gate.gap(relay, "budget", seq, now);
                if let Some(to) = d.to {
                    st.gate.gap(relay, "budget", to, now);
                }
            }
        }
        let has_drops = st.spool.console_dropped.count > 0 || st.spool.relay_dropped.values().any(|d| d.count > 0);
        if has_drops && st.last_dropped_summary.is_none_or(|t| now - t >= HOUR) {
            let c = std::mem::take(&mut st.spool.console_dropped);
            let relays = std::mem::take(&mut st.spool.relay_dropped);
            let total = c.count + relays.values().map(|d| d.count).sum::<u64>();
            let mut detail = json!({"count": total, "fromSeq": c.from, "toSeq": c.to});
            if !relays.is_empty() {
                let per: Map<String, Value> = relays.iter().map(|(r, d)| (r.clone(), json!({"count": d.count, "fromSeq": d.from, "toSeq": d.to}))).collect();
                detail["relays"] = Value::Object(per);
            }
            st.last_dropped_summary = Some(now);
            out.push(("exports.siem-dropped", detail));
        }
        let due: Vec<String> = st.gate.gaps.keys().filter(|r| st.gate.last_gap_summary.get(*r).is_none_or(|t| now - t >= HOUR)).cloned().collect();
        for relay in due {
            if let Some(g) = st.gate.gaps.remove(&relay) {
                st.gate.last_gap_summary.insert(relay.clone(), now);
                out.push(("exports.relay-gap", json!({"relay": relay, "fromSeq": g.from, "toSeq": g.to, "why": g.why})));
            }
        }
        out
    }

    /// `GET /console/api/settings/exports` `siem` fields beyond the settings: `{state, lastError, spooled, dropped}`.
    pub fn status(&self) -> Value {
        let st = self.inner.state.lock();
        let state = if st.last_error.is_some() {
            "failing"
        } else if st.active.is_none() {
            "off"
        } else {
            "ok"
        };
        json!({"state": state, "lastError": st.last_error, "spooled": st.spool.len(), "dropped": st.spool.dropped_total})
    }

    pub fn attention(&self, now: i64) -> SiemAttention {
        let st = self.inner.state.lock();
        let mut gaps: Vec<String> = st.gate.last_gap_at.iter().filter(|(_, t)| now - **t < DAY).map(|(r, _)| r.clone()).collect();
        gaps.sort();
        SiemAttention { failing: st.last_error.clone(), dropped: st.spool.dropped_total, gaps }
    }
}

fn note(inner: &Inner, event: &str, fields: Fields, level: Level) {
    if let Some(l) = &inner.logger {
        l.ops(event, &fields, level);
    }
}

/// The sender: one connection; the console partition drained first; a message leaves the spool only once written;
/// reconnect at 1 s doubling to 60 s. Under High only the FIPS build sends.
fn sender(inner: Arc<Inner>) {
    let mut conn: Option<(u64, Conn)> = None;
    let mut backoff = BACKOFF_FIRST;
    loop {
        let (generation, id, msg, host, port, cfg) = {
            let mut st = inner.state.lock();
            loop {
                if st.stop {
                    return;
                }
                let ready = st.active.is_some() && !st.spool.is_empty() && !(st.high && !FIPS_BUILD);
                if ready {
                    break;
                }
                inner.wake.wait_for(&mut st, Duration::from_secs(30));
            }
            let a = st.active.as_ref().unwrap();
            let (id, msg) = st.spool.next().unwrap();
            (st.generation, id, msg, a.settings.host.clone(), a.settings.port, a.cfg.clone())
        };
        if conn.as_ref().is_some_and(|(g, _)| *g != generation) {
            if let Some((_, c)) = conn.take() {
                c.close();
            }
        }
        if conn.is_none() {
            match Conn::open(&host, port, &cfg) {
                Ok(c) => conn = Some((generation, c)),
                Err(why) => {
                    fail(&inner, why);
                    sleep_or_stop(&inner, backoff);
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    continue;
                }
            }
        }
        let result = conn.as_mut().map(|(_, c)| c.send(&frame(&msg))).unwrap_or(Err("no connection".into()));
        match result {
            Ok(()) => {
                backoff = BACKOFF_FIRST;
                let mut st = inner.state.lock();
                st.spool.sent(id);
                if st.last_error.take().is_some() {
                    drop(st);
                    note(&inner, "exports.siem-ok", Fields::new(), Level::Info);
                }
            }
            Err(why) => {
                conn = None;
                fail(&inner, why);
                sleep_or_stop(&inner, backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
}

fn fail(inner: &Inner, why: String) {
    let mut st = inner.state.lock();
    let first = st.last_error.is_none();
    st.last_error = Some(why.clone());
    drop(st);
    if first {
        note(inner, "exports.siem-failing", Fields::new().with("why", why), Level::Warn);
    }
}

/// The reconnect wait: the whole backoff (new messages do not shorten it), unless the forwarder stops.
fn sleep_or_stop(inner: &Inner, d: Duration) {
    let until = std::time::Instant::now() + d;
    let mut st = inner.state.lock();
    while !st.stop {
        let now = std::time::Instant::now();
        if now >= until {
            break;
        }
        inner.wake.wait_for(&mut st, until - now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_json;
    use crate::console_audit::entry_hash;
    use std::io::Read;
    use std::net::TcpListener;

    const HOST: &str = "console.acme.example";

    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    /// A chain of relay audit entries from `first`, `n` long, `pad` bytes of detail each.
    fn chain(first: i64, n: usize, pad: usize) -> Vec<Value> {
        let mut prev = "0".repeat(64);
        let mut out = Vec::new();
        for i in 0..n {
            let mut e = Map::new();
            e.insert("seq".into(), Value::from(first + i as i64));
            e.insert("ts".into(), Value::from(1_800_000_000_000i64 + i as i64));
            e.insert("actor".into(), Value::from("alice@acme.example"));
            e.insert("role".into(), Value::from("admin"));
            e.insert("ip".into(), Value::from("console c_0123456789abcdef"));
            e.insert("action".into(), Value::from("fleet.call"));
            e.insert("target".into(), Value::from("n_00"));
            e.insert("result".into(), Value::from("ok"));
            e.insert("approval".into(), Value::Null);
            e.insert("stepup".into(), Value::from(true));
            e.insert("detail".into(), json!({"pad": "p".repeat(pad), "token": "secret-token-value", "code": "x"}));
            e.insert("prev".into(), Value::from(prev.clone()));
            let h = entry_hash(&prev, &e).unwrap();
            e.insert("hash".into(), Value::from(h.clone()));
            prev = h;
            out.push(Value::Object(e));
        }
        out
    }

    fn settings(port: u16, ca: Option<String>) -> SiemSettings {
        SiemSettings { host: "localhost".into(), port, ca_pem: ca, client_cert_pem: None, events: Events { audit: true, security: true, relays: true }, include_reasons: false }
    }

    /// A one-connection TLS syslog receiver: everything it read.
    fn receiver(cert: &str, key: &str) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let certs = certs_of(cert).unwrap();
        let key = rustls_pemfile::private_key(&mut key.as_bytes()).unwrap().unwrap();
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(crate::server::provider())).with_protocol_versions(&[&rustls::version::TLS13]).unwrap().with_no_client_auth().with_single_cert(certs, key).unwrap();
        // No session tickets: the sender closes right after its message, and on Windows the ticket write to a
        // closed socket aborts the read before the message is taken (10053).
        cfg.send_tls13_tickets = 0;
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (tcp, _) = l.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut s = rustls::StreamOwned::new(rustls::ServerConnection::new(Arc::new(cfg)).unwrap(), tcp);
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    // A reset after the close is the end of the stream; anything before data is a test failure
                    // that the assertions below report with what arrived.
                    Err(e) if got.is_empty() => {
                        eprintln!("SIEM test receiver: {e}");
                        break;
                    }
                    Err(_) => break,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                }
            }
            got
        });
        (port, h)
    }

    #[test]
    fn vector_messages_and_frames_exactly() {
        let v = vector("admin_console_fleet_cef_v1.json");
        let host = v["host"].as_str().unwrap();
        let version = v["version_string"].as_str().unwrap();
        assert_eq!(v["vendor"], VENDOR);
        assert_eq!(v["product"], PRODUCT);
        assert_eq!(v["facility"], FACILITY);
        for (k, s) in v["cef_severity"].as_object().unwrap() {
            assert_eq!(s.as_u64(), Some(u64::from(cef_severity(k))), "{k}");
        }
        for (k, s) in v["syslog_severity"].as_object().unwrap() {
            assert_eq!(s.as_u64(), Some(u64::from(syslog_severity(k))), "{k}");
        }
        for c in v["cases"].as_array().unwrap() {
            let source = match c["source"].as_str().unwrap() {
                "audit" => Source::Audit,
                "relays" => Source::Relays,
                _ => Source::Security,
            };
            let got = message(source, c["entry"].as_object().unwrap(), c["relay"].as_str(), host, version, c["include_reasons"].as_bool().unwrap()).unwrap();
            assert_eq!(got, c["message"].as_str().unwrap(), "{}", c["name"]);
            assert_eq!(frame(&got), c["frame"].as_str().unwrap(), "{}", c["name"]);
            assert!(got.len() <= MSG_MAX);
        }
        for c in v["escape"].as_array().unwrap() {
            let input = c["in"].as_str().unwrap();
            let got = if c["where"] == "header" { esc_header(input) } else { esc_ext(input) };
            assert_eq!(got, c["out"].as_str().unwrap(), "{input:?}");
        }
        for c in v["truncate"].as_array().unwrap() {
            assert_eq!(cut(c["in"].as_str().unwrap()), c["out"].as_str().unwrap(), "{}", c["in_length"]);
        }
    }

    #[test]
    fn cef_names_equal_the_words_vector() {
        let w = vector("admin_console_fleet_words_v1.json");
        let cef = w["cef"].as_object().expect("cef in the words vector");
        assert_eq!(cef.len(), CEF_NAMES.len());
        for (action, name) in CEF_NAMES {
            assert_eq!(cef.get(action).and_then(Value::as_str), Some(name), "{action}");
        }
        assert_eq!(cef_name("fleet.call"), "fleet.call");
    }

    #[test]
    fn escaping_cleaning_truncation_allow_list_and_reasons() {
        // every special character, in the header and in extensions; controls are cleaned before escaping
        assert_eq!(esc_header("a\\b|c=d"), "a\\\\b\\|c=d");
        assert_eq!(esc_ext("a\\b|c=d\re\nf"), "a\\\\b|c\\=d\\re\\nf");
        assert_eq!(prep("x\r\ny\u{202e}z\u{0}"), "xyz");
        assert_eq!(cut(&"é".repeat(1023)), "é".repeat(1023));
        assert_eq!(cut(&"é".repeat(1024)), "é".repeat(1020) + "...");
        let e = chain(7, 1, 10).remove(0);
        let mut o = e.as_object().unwrap().clone();
        o.insert("detail".into(), json!({"code": "c=1", "reason": "lost | phone", "password": "hunter2", "token": "lme_abc", "secret": "s", "people": ["ann@acme.example"]}));
        let m = message(Source::Relays, &o, Some("r_3f0a9c2b7d5e1f48"), HOST, "2.5.0", false).unwrap();
        for leak in ["hunter2", "lme_abc", "ann@acme.example", "password", "lost"] {
            assert!(!m.contains(leak), "{leak} in {m}");
        }
        assert!(m.contains("cs5Label=code cs5=c\\=1") && m.contains("cs2=r_3f0a9c2b7d5e1f48"));
        let with = message(Source::Relays, &o, Some("r_3f0a9c2b7d5e1f48"), HOST, "2.5.0", true).unwrap();
        assert!(with.ends_with("cs6Label=reason cs6=lost | phone"), "{with}");
        // a huge entry stays within 8,192 bytes
        for k in ["actor", "target", "ip", "approval"] {
            o.insert(k.into(), Value::from("\u{1F600}".repeat(1100)));
        }
        let big = message(Source::Audit, &o, None, HOST, "2.5.0", true).unwrap();
        assert!(big.len() <= MSG_MAX && big.ends_with("..."));
        assert_eq!(frame("<110>1 x"), "8 <110>1 x");
        assert_eq!(frame("é"), "2 é");
    }

    #[test]
    fn settings_checks_high_without_ca_and_views() {
        let ca = crate::meet_console_port::tests::self_signed("siem.acme.example").0;
        let body = json!({"host": "SIEM.acme.example", "caPem": ca, "events": ["audit", "relays"], "reason": "r", "stepup": {}});
        let s = SiemSettings::from_body(&body, false, false).unwrap();
        assert_eq!((s.host.as_str(), s.port, s.include_reasons), ("siem.acme.example", DEFAULT_PORT, false));
        assert_eq!(SiemSettings::from_json(&s.to_json()), Some(s.clone()));
        assert_eq!(s.view()["caSet"], true);
        assert!(!stringify(&s.view()).contains("BEGIN"));
        let no_ca = json!({"host": "siem.acme.example", "events": ["audit"]});
        assert_eq!(SiemSettings::from_body(&no_ca, true, true).unwrap_err().code, "siem-ca-needed");
        assert_eq!(SiemSettings::from_body(&no_ca, true, false).unwrap_err().code, "fips-needed");
        assert!(SiemSettings::from_body(&no_ca, false, false).is_ok(), "Standard: the system roots");
        for bad in [
            json!({"host": "bad host", "events": ["audit"]}),
            json!({"host": "siem", "port": 0, "events": ["audit"]}),
            json!({"host": "siem", "port": 70000, "events": ["audit"]}),
            json!({"host": "siem", "events": []}),
            json!({"host": "siem", "events": ["audit", "audit"]}),
            json!({"host": "siem", "events": ["metrics"]}),
            json!({"host": "siem", "events": ["audit"], "caPem": "not a pem"}),
            json!({"host": "siem", "events": ["audit"], "clientCertPem": ca}),
            json!({"host": "siem", "events": ["audit"], "includeReasons": "yes"}),
        ] {
            assert_eq!(SiemSettings::from_body(&bad, false, false).unwrap_err().code, "invalid", "{bad}");
        }
        assert_eq!(SiemSettings::from_body(&json!({"host": "siem", "events": ["audit"], "udp": true}), false, false).unwrap_err().code, "unknown-field");
    }

    #[test]
    fn staged_save_over_tls_and_old_settings_kept_on_failure() {
        let (cert, key) = crate::meet_console_port::tests::self_signed("localhost");
        let siem = Siem::start(None, HOST, "2.5.0", None);
        // a good SIEM: the test message arrives framed, and the settings apply
        let (port, rx) = receiver(&cert, &key);
        let good = settings(port, Some(cert.clone()));
        siem.stage(good.clone(), None).unwrap();
        let got = String::from_utf8(rx.join().unwrap()).unwrap();
        let (len, msg) = got.split_once(' ').unwrap_or_else(|| panic!("the SIEM received {got:?}"));
        assert_eq!(len.parse::<usize>().unwrap(), msg.len());
        assert!(msg.starts_with("<110>1 ") && msg.contains(" console.acme.example lucid-console - audit - CEF:0|TECHLEAD 187|Lucid Admin Console|2.5.0|exports.siem-test|"), "{msg}");
        assert_eq!(Siem::forwarding(&siem.inner.state.lock()), Some(&good));
        // a server whose certificate does not verify against the configured CA: refused, old settings kept
        let (other, other_key) = crate::meet_console_port::tests::self_signed("localhost");
        let (port2, rx2) = receiver(&other, &other_key);
        let why = siem.stage(settings(port2, Some(cert.clone())), None).unwrap_err();
        assert!(why.contains("did not verify"), "{why}");
        let _ = rx2.join();
        assert_eq!(Siem::forwarding(&siem.inner.state.lock()), Some(&good));
        // nobody listening: refused, old settings kept
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(siem.stage(settings(closed, Some(cert.clone())), None).is_err());
        assert_eq!(Siem::forwarding(&siem.inner.state.lock()), Some(&good));
        // High without the FIPS build or without a CA: refused before any connection, old settings kept
        siem.set_high(true);
        assert!(siem.stage(settings(closed, None), None).is_err());
        assert_eq!(Siem::forwarding(&siem.inner.state.lock()), Some(&good));
        siem.set_high(false);
        siem.off();
        assert_eq!(siem.status()["state"], "off");
    }

    #[test]
    fn the_sender_drains_the_console_partition_first() {
        let mut s = Spool::open(None);
        s.push_relay("r_00000000000000a1", Some(1), "relay one".into());
        s.push_console(Some(5), "console one".into());
        s.push_relay("r_00000000000000a1", Some(2), "relay two".into());
        s.push_console(Some(6), "console two".into());
        let mut order = Vec::new();
        while let Some((id, msg)) = s.next() {
            order.push(msg);
            s.sent(id);
        }
        assert_eq!(order, ["console one", "console two", "relay one", "relay two"]);
    }

    #[test]
    fn spool_files_survive_a_restart_and_torn_lines_are_counted() {
        let d = std::env::temp_dir().join(format!("lucid-fleet-siem-spool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        {
            let mut s = Spool::open(Some(&d));
            s.push_console(Some(1), "a".into());
            s.push_console(Some(2), "b".into());
            s.push_relay("r_00000000000000a1", Some(9), "c".into());
            let (id, _) = s.next().unwrap();
            s.sent(id);
        }
        let mut f = std::fs::OpenOptions::new().append(true).open(d.join(CONSOLE_SPOOL)).unwrap();
        f.write_all(b"{\"id\":99,\"ms").unwrap();
        drop(f);
        let s = Spool::open(Some(&d));
        assert_eq!(s.console.items.values().map(|i| i.msg.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(s.relays.items.len(), 1);
        assert_eq!(s.usage("r_00000000000000a1"), (1, 1));
        assert_eq!(s.dropped_total, 1);
    }

    #[test]
    fn console_partition_cap_and_drop_count() {
        let mut s = Spool::open(None);
        for i in 0..PART_MSGS as i64 + 25 {
            s.push_console(Some(i), format!("m{i}"));
        }
        assert_eq!(s.console.items.len(), PART_MSGS);
        assert_eq!(s.console_dropped, Dropped { count: 25, from: Some(0), to: Some(24) });
        // bytes: 16 MiB at most
        let mut s = Spool::open(None);
        let big = "x".repeat(1 << 20);
        for i in 0..20 {
            s.push_console(Some(i), big.clone());
        }
        assert!(s.console.bytes <= PART_BYTES && s.console.items.len() == 16);
        // relay messages never take console space
        for i in 0..PART_MSGS as i64 {
            s.push_relay("r_00000000000000a1", Some(i), "r".into());
        }
        assert_eq!(s.console.items.len(), 16);
    }

    #[test]
    fn guaranteed_shares_fit_the_partition() {
        for n in [1usize, 7, 50, 200] {
            let (m, b) = share(n);
            assert!(m * n <= PART_MSGS && b * n as u64 <= PART_BYTES, "{n}");
        }
        assert_eq!(share(1), (200, 320 << 10));
        assert_eq!(share(200), (50, (16 << 20) / 200));
        assert_eq!(share(0), share(1));
    }

    fn relay(i: usize) -> String {
        format!("r_{i:016x}")
    }

    #[test]
    fn excess_is_evicted_before_any_guaranteed_share_and_shrinks_with_more_relays() {
        let mut s = Spool::open(None);
        let now = 1_000;
        // one active relay fills the whole partition: 200 guaranteed, the rest excess
        s.note_active(&relay(1), now);
        for i in 0..PART_MSGS as i64 {
            s.push_relay(&relay(1), Some(i), "a".into());
        }
        assert_eq!(s.relays.items.len(), PART_MSGS);
        // a second relay becomes active: shares are 200 each; its messages evict relay 1's oldest excess
        s.note_active(&relay(2), now + 1);
        assert_eq!(s.active_count(), 2);
        for i in 0..150 {
            s.push_relay(&relay(2), Some(i), "b".into());
        }
        assert_eq!(s.usage(&relay(2)).0, 150);
        assert_eq!(s.usage(&relay(1)).0, PART_MSGS - 150);
        assert_eq!(s.relay_dropped[&relay(1)], Dropped { count: 150, from: Some(0), to: Some(149) }, "relay 1 lost its oldest");
        // 200 relays: shares shrink to 50; a relay over its new share holds excess, evicted first
        for i in 3..=200 {
            s.note_active(&relay(i), now + 2);
        }
        assert_eq!(share(s.active_count()).0, 50);
        for i in 3..=200 {
            for k in 0..50 {
                s.push_relay(&relay(i), Some(k), "c".into());
            }
        }
        for i in 3..=200 {
            assert_eq!(s.usage(&relay(i)).0, 50, "every other relay keeps its 50 guaranteed messages");
        }
        // what is left of relays 1 and 2 fits: neither holds less than its guaranteed 50
        assert!(s.usage(&relay(1)).0 >= 50 && s.usage(&relay(2)).0 >= 50);
        assert!(s.relays.items.len() <= PART_MSGS);
    }

    #[test]
    fn a_flooding_relay_at_200_relays_keeps_its_share_plus_excess_only() {
        let mut s = Spool::open(None);
        for i in 0..200 {
            s.note_active(&relay(i), 10);
        }
        for i in 1..200 {
            for k in 0..50 {
                s.push_relay(&relay(i), Some(k), "g".into());
            }
        }
        // relay 0 floods: it can take only the space nobody's guaranteed share uses
        for k in 0..20_000 {
            s.push_relay(&relay(0), Some(k), "f".into());
        }
        let (sm, _) = share(200);
        let others: usize = (1..200).map(|i| s.usage(&relay(i)).0).sum();
        assert_eq!(others, 199 * sm);
        assert!(s.usage(&relay(0)).0 <= PART_MSGS - others);
        assert!(s.relays.items.len() <= PART_MSGS);
        // the flood lost its oldest, recorded as the console's own summary
        let d = s.relay_dropped[&relay(0)];
        assert_eq!(d.from, Some(0));
        assert!(d.count > 0);
    }

    #[test]
    fn relay_entries_out_of_sequence_off_the_chain_or_with_a_wrong_hash_are_not_forwarded() {
        let mut g = Gate::default();
        let r = "r_00000000000000a1";
        let c = chain(10, 6, 5);
        let seqs = |v: &[Map<String, Value>]| v.iter().map(|e| e["seq"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(seqs(&g.check(r, &c[..2], 0)), [10, 11]);
        // 12 is skipped: 13 is out of sequence and not forwarded; 14 starts the checked chain again
        assert_eq!(seqs(&g.check(r, &c[3..5], 0)), [14]);
        assert_eq!(g.gaps[r], Gap { why: "gap", from: 13, to: 13 });
        // a wrong hash is never forwarded
        let mut bad = c[5].as_object().unwrap().clone();
        bad.insert("target".into(), Value::from("changed"));
        assert!(g.check(r, &[Value::Object(bad)], 0).is_empty());
        // off the chain: a correct entry whose prev is not the last forwarded hash
        let mut g = Gate::default();
        let other = chain(11, 1, 9);
        assert_eq!(seqs(&g.check(r, &c[..1], 0)), [10]);
        assert!(g.check(r, &other, 0).is_empty());
        assert_eq!(g.gaps[r].why, "chain");
        // extra or missing keys
        let mut extra = c[1].as_object().unwrap().clone();
        extra.insert("x".into(), Value::from(1));
        assert!(g.check(r, &[Value::Object(extra)], 0).is_empty());
    }

    #[test]
    fn per_entry_and_per_byte_budgets_hold_for_frames_of_1_and_1000_entries() {
        let r = "r_00000000000000a1";
        // 1,000 small entries in one frame: 600 forwarded, the rest summarized as a budget gap
        let mut g = Gate::default();
        let c = chain(1, 1000, 1);
        assert_eq!(g.check(r, &c, 0).len(), 600);
        assert_eq!(g.gaps[r], Gap { why: "budget", from: 601, to: 1000 });
        // frames of 1 entry: the same minute budget
        let mut g = Gate::default();
        let mut n = 0;
        for e in &c {
            n += g.check(r, std::slice::from_ref(e), 5).len();
        }
        assert_eq!(n, 600);
        // the next minute opens again, and the chain restarts at the first entry forwarded
        assert_eq!(g.check(r, &chain(2000, 1, 1), 5 + MINUTE).len(), 1);
        // bytes: entries of about 4 KiB pass 512 KiB well before 600 entries
        let mut g = Gate::default();
        let big = chain(1, 200, 4096);
        let ok = g.check(r, &big, 0);
        let bytes: usize = ok.iter().map(|e| stringify(&Value::Object(e.clone())).len()).sum();
        assert!(ok.len() < 200 && bytes as u64 <= RELAY_BYTES_MIN, "{} {bytes}", ok.len());
        // all relays together: 6,000 entries a minute
        let mut g = Gate::default();
        let mut total = 0;
        for i in 0..12 {
            total += g.check(&format!("r_{i:016x}"), &chain(1, 600, 1), 0).len();
        }
        assert_eq!(total, 6000);
    }

    #[test]
    fn a_flood_from_200_relays_fills_only_the_relay_partition_with_one_console_summary() {
        let siem = Siem::start(None, HOST, "2.5.0", None);
        // the SIEM is down (nothing listens): everything stays spooled
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let s = SiemSettings { host: "127.0.0.1".into(), port: closed, ca_pem: Some(crate::meet_console_port::tests::self_signed("x").0), client_cert_pem: None, events: Events { audit: true, security: true, relays: true }, include_reasons: false };
        siem.configure(Some((s, None)));
        let now = 1_000_000;
        for k in 0..100 {
            let mut e = chain(k + 1, 1, 0).remove(0).as_object().unwrap().clone();
            e.insert("actor".into(), Value::from("console-admin@acme.example"));
            siem.console_entry(&e);
        }
        // three minutes of multi-entry frames: relay 0 sends 600 a minute, the others 60 (the global 6,000 a minute
        // cuts the tail, recorded as budget gaps)
        let chains: Vec<Vec<Value>> = (0..200).map(|i| chain(1, if i == 0 { 1800 } else { 180 }, 1)).collect();
        for minute in 0..3usize {
            for (i, c) in chains.iter().enumerate() {
                let n = if i == 0 { 600 } else { 60 };
                siem.relay_audit(&relay(i), &c[minute * n..(minute + 1) * n], now + minute as i64 * MINUTE);
            }
        }
        let late = now + 3 * MINUTE;
        {
            let st = siem.inner.state.lock();
            assert_eq!(st.spool.console.items.len(), 100);
            assert_eq!(st.spool.console_dropped.count, 0, "no console message is dropped while its partition has room");
            assert_eq!(st.spool.relays.items.len(), PART_MSGS, "the relay partition is full");
            let (sm, _) = share(st.spool.active_count());
            assert_eq!(st.spool.active_count(), 200);
            for i in 1..200 {
                let (m, _) = st.spool.usage(&relay(i));
                assert!(m == 0 || m >= sm.min(180), "relay {i} kept {m}");
            }
        }
        let now = late;
        // relay 0 (the noisiest) lost its oldest; one siem-dropped summary, and its gap as the console's own
        let sums = siem.take_summaries(now);
        let dropped: Vec<&Value> = sums.iter().filter(|(a, _)| *a == "exports.siem-dropped").map(|(_, d)| d).collect();
        assert_eq!(dropped.len(), 1);
        assert!(dropped[0]["relays"][relay(0)]["count"].as_u64().unwrap() > 0);
        assert!(sums.iter().any(|(a, d)| *a == "exports.relay-gap" && d["relay"] == relay(0) && d["why"] == "budget"));
        assert!(siem.take_summaries(now + 1).is_empty(), "at most one an hour");
        assert!(siem.attention(now).gaps.contains(&relay(0)));
    }
}
