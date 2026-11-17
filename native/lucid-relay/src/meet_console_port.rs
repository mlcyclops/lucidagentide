// AC-1 (contract 3.1, M4): the Meeting Hub relay's Admin Console port. Its own listener with the guest port's limits
// (meet_guest_port.rs `Slot`): at most CONNECTIONS_MAX connections and CONNECTIONS_PER_ADDRESS from one address (IPv6
// by /64). At `accept`, in this order: the source list first (a connection from outside it is closed without a
// handshake and never takes a slot; the peer is logged in `console.refused`, `why: "source"`, at most once per
// address per minute), then the slot, then HANDSHAKE_TIMEOUT for the TLS handshake. HTTP/1.1 only, request bodies at
// most BODY_MAX, IDLE_TIMEOUT between requests. The source is always the TCP peer: no proxy may stand in front
// (decision 25). Everything under /console goes to the core console (src/console.rs); nothing else is served here.

use crate::console::{ConsoleReply, ConsoleRequest};
use crate::meet::{address_of, http_date, log_info, quiet_end, read_head, reason_phrase, Settings, Tls, BODY_MAX, SERVER_VERSION};
use crate::meet_hub::guests;
use crate::meet_json::{self as pj};
use crate::relay::Dialed;
use parking_lot::Mutex;
use rustls::ServerConfig;
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The guest port's limits (meet_guest_port.rs), and the console's idle time between requests.
pub const CONNECTIONS_MAX: usize = 256;
pub const CONNECTIONS_PER_ADDRESS: usize = 16;
pub const HANDSHAKE_TIMEOUT: f64 = 10.0;
pub const IDLE_TIMEOUT: f64 = 30.0;
/// One `console.refused` line per refused address per this many seconds; at most SOURCE_LOG_KEEP addresses kept.
const SOURCE_LOG_EVERY: f64 = 60.0;
const SOURCE_LOG_KEEP: usize = 4096;

pub const PORT_WORDS: &str = "relay settings: console_port must be 1 to 65535 and differ from port and guest_port";
pub const PUBLIC_IP: &str = "passkeys need a DNS name: set console_public to a host name";
pub const PUBLIC_SHARED: &str = "the Admin Console needs a host name of its own: console_public may not share a host name with the relay or the guest page";
pub const SOURCES_NEEDED: &str = "set console_sources to the networks admins use, for example the VPN's range";
pub const FIRST_ADMIN: &str = "set console_first_admin to the relay admin who signs in first";
pub const CERT_NEEDED: &str = "console_cert and console_key are required when console_port is set";
/// Contract 3.1: at most 32 networks in a source list.
const SOURCES_MAX: usize = 32;

/// The console's settings once checked (contract 3.1).
#[derive(Clone, Debug, PartialEq)]
pub struct ConsoleConf {
    pub port: u16,
    /// `console_public`'s host, lower case (no port).
    pub host: String,
    /// `console_public` as browsers reach it: the host with a port that is not 443.
    pub public: String,
    /// The port browsers dial (443 unless `console_public` names one).
    pub public_port: u16,
}

impl ConsoleConf {
    /// `https://<public>`: the origin sessions and passkeys are bound to.
    pub fn origin(&self) -> String {
        format!("https://{}", self.public)
    }

    pub fn dialed(&self) -> Dialed {
        Dialed { host: self.public.clone(), hostname: self.host.clone(), port: self.public_port }
    }
}

/// A host name as the console and the guest page name it: the host of `host[:port]` or of an https origin, lower case.
pub fn host_of(text: &str) -> String {
    let t = text.trim();
    let t = t.strip_prefix("https://").or_else(|| t.strip_prefix("http://")).unwrap_or(t);
    let authority = t.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit('@').next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    host.trim_end_matches('.').to_lowercase()
}

fn dns_name_ok(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        && !host.rsplit('.').next().unwrap_or_default().bytes().all(|c| c.is_ascii_digit())
}

/// Contract 3.1's start checks, apart from the certificate files: None when the console is off. `main_dns` are the
/// SAN DNS names of the main port's certificate.
pub fn check_settings(s: &Settings, main_dns: &[String]) -> Result<Option<ConsoleConf>, String> {
    let port = match &s.console_port {
        serde_json::Value::Null => 0,
        v => match pj::as_num(Some(v)) {
            Some(p) if p.fract() == 0.0 && (0.0..=65535.0).contains(&p) => p as i64,
            _ => return Err(PORT_WORDS.into()),
        },
    };
    if port == 0 {
        return Ok(None);
    }
    let guest_port = pj::as_int(Some(&s.guest_port)).unwrap_or(0);
    if port == i64::from(s.port) || (guest_port > 0 && port == guest_port) {
        return Err(PORT_WORDS.into());
    }
    let public = s.console_public.trim().to_lowercase();
    let host = host_of(&public);
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if public.is_empty() || bare.parse::<IpAddr>().is_ok() || !dns_name_ok(&host) || public.contains('/') {
        return Err(PUBLIC_IP.into());
    }
    let public_port = match public.rsplit_once(':') {
        Some((_, p)) => p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| PUBLIC_IP.to_string())?,
        None => 443,
    };
    let shared = host == host_of(&s.host) || (!s.guest_public.trim().is_empty() && host == host_of(&s.guest_public)) || main_dns.iter().any(|d| d.trim().trim_end_matches('.').to_lowercase() == host);
    if shared {
        return Err(PUBLIC_SHARED.into());
    }
    if s.console_cert.trim().is_empty() || s.console_key.trim().is_empty() {
        return Err(CERT_NEEDED.into());
    }
    if s.console_sources.is_empty() || s.console_sources.len() > SOURCES_MAX {
        return Err(SOURCES_NEEDED.into());
    }
    crate::console_source::parse_cidrs(&s.console_sources, SOURCES_MAX).map_err(|e| format!("{SOURCES_NEEDED} ({e})"))?;
    let first = s.console_first_admin.trim().to_lowercase();
    if !first.is_empty() && !s.admins.iter().any(|a| a.trim().to_lowercase() == first) {
        return Err(FIRST_ADMIN.into());
    }
    let public = if public_port == 443 { host.clone() } else { format!("{host}:{public_port}") };
    Ok(Some(ConsoleConf { port: port as u16, host, public, public_port }))
}

/// One refused-source log line per address per minute, at most SOURCE_LOG_KEEP addresses remembered.
#[derive(Default)]
struct SourceLog(Mutex<HashMap<String, f64>>);

impl SourceLog {
    fn note(&self, address: &str) -> bool {
        let now = pj::mono();
        let mut seen = self.0.lock();
        if seen.len() >= SOURCE_LOG_KEEP {
            seen.retain(|_, t| now - *t < SOURCE_LOG_EVERY);
        }
        match seen.get(address) {
            Some(t) if now - t < SOURCE_LOG_EVERY => false,
            _ => {
                if seen.len() < SOURCE_LOG_KEEP {
                    seen.insert(address.to_string(), now);
                }
                true
            }
        }
    }
}

/// What a console request is handed to: the core console in the relay, a stand-in in tests.
pub type Handler = Arc<dyn Fn(&ConsoleRequest, i64) -> ConsoleReply + Send + Sync>;
/// The accept-time source check (the core console's `source_allowed`).
pub type SourceCheck = Arc<dyn Fn(IpAddr) -> bool + Send + Sync>;

pub struct Port {
    conf: ConsoleConf,
    tls: Arc<ServerConfig>,
    handler: Handler,
    source_ok: SourceCheck,
    open: Mutex<HashMap<String, usize>>,
    total: AtomicUsize,
    refused: SourceLog,
}

/// One connection's place under the port's limits, given back when it ends.
pub struct Slot {
    port: Arc<Port>,
    key: String,
}

impl Slot {
    pub fn take(port: &Arc<Port>, address: &str) -> Option<Slot> {
        let key = guests::addr_key(address);
        let mut open = port.open.lock();
        if port.total.load(Ordering::SeqCst) >= CONNECTIONS_MAX || open.get(&key).copied().unwrap_or(0) >= CONNECTIONS_PER_ADDRESS {
            return None;
        }
        port.total.fetch_add(1, Ordering::SeqCst);
        *open.entry(key.clone()).or_insert(0) += 1;
        Some(Slot { port: port.clone(), key })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut open = self.port.open.lock();
        if let Some(n) = open.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                open.remove(&self.key);
            }
        }
        self.port.total.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The TCP peer as an address (an IPv4-mapped IPv6 address as its IPv4).
fn peer_ip(address: &str) -> Option<IpAddr> {
    let ip: IpAddr = address.split('%').next().unwrap_or_default().parse().ok()?;
    Some(match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    })
}

impl Port {
    pub fn new(conf: ConsoleConf, tls: Arc<ServerConfig>, handler: Handler, source_ok: SourceCheck) -> Arc<Port> {
        Arc::new(Port { conf, tls, handler, source_ok, open: Mutex::new(HashMap::new()), total: AtomicUsize::new(0), refused: SourceLog::default() })
    }

    /// Connections open now (tests).
    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.total.load(Ordering::SeqCst)
    }

    /// Contract 3.1 at accept: the source first, then the slot. None closes the connection before any handshake.
    pub fn admit(self: &Arc<Self>, address: &str) -> Option<Slot> {
        let allowed = peer_ip(address).map(|ip| (self.source_ok)(ip)).unwrap_or(false);
        if !allowed {
            if self.refused.note(address) {
                crate::meet::log_warn(&format!("console.refused why=source source={address} peer={address}"));
            }
            return None;
        }
        Slot::take(self, address)
    }

    /// Accept on `listener` forever, each admitted connection on its own thread.
    pub fn run(self: Arc<Self>, listener: TcpListener) {
        for conn in listener.incoming() {
            let Ok(tcp) = conn else { continue };
            let Ok(peer) = tcp.peer_addr() else { continue };
            let address = address_of(&peer);
            let Some(slot) = self.admit(&address) else {
                drop(tcp);
                continue;
            };
            let _ = std::thread::Builder::new().name("relay-console".into()).spawn(move || {
                serve(&slot.port, tcp, &address);
                drop(slot);
            });
        }
    }
}

/// start: the console port on its own thread.
pub fn start(settings: &Settings, conf: ConsoleConf, tls: Arc<ServerConfig>, handler: Handler, source_ok: SourceCheck) -> Result<(), String> {
    let listener = TcpListener::bind((settings.host.as_str(), conf.port)).map_err(|e| format!("cannot listen on {}:{}: {e}", settings.host, conf.port))?;
    let (port_no, public) = (conf.port, conf.public.clone());
    let port = Port::new(conf, tls, handler, source_ok);
    std::thread::Builder::new().name("relay-console-port".into()).spawn(move || port.run(listener)).map_err(|e| e.to_string())?;
    log_info(&format!("Admin Console listening on {}:{port_no} for https://{public}", settings.host));
    Ok(())
}

fn serve(port: &Port, mut tcp: TcpStream, address: &str) {
    let _ = tcp.set_read_timeout(Some(Duration::from_secs_f64(HANDSHAKE_TIMEOUT)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs_f64(IDLE_TIMEOUT)));
    let Ok(mut conn) = rustls::ServerConnection::new(port.tls.clone()) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            return;
        }
    }
    let _ = tcp.set_read_timeout(Some(Duration::from_secs_f64(IDLE_TIMEOUT)));
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    while let Ok(true) = one(port, &mut reader, address) {}
    let tls = reader.get_mut();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

fn write_reply(w: &mut Tls, reply: &ConsoleReply, close: bool) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\nServer: {SERVER_VERSION}\r\nDate: {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n", reply.status, reason_phrase(reply.status), http_date(), reply.content_type, reply.body.len());
    for (k, v) in &reply.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(&reply.body);
    w.write_all(&out)?;
    w.flush()
}

fn plain(status: u16, words: &str) -> ConsoleReply {
    let body = serde_json::json!({"ok": false, "code": if status == 413 { "too-large" } else { "not-found" }, "error": words});
    ConsoleReply { status, content_type: "application/json", body: body.to_string().into_bytes(), headers: Vec::new(), close: status == 413 }
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>, address: &str) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let (path, query) = head.path_query();
    let mut close = head.close;
    let length = head.header("content-length").and_then(|l| l.trim().parse::<usize>().ok()).unwrap_or(0);
    if head.header("transfer-encoding").is_some() || length > BODY_MAX {
        // 413 without reading the body; the connection closes
        write_reply(reader.get_mut(), &plain(413, "The request is too large."), true)?;
        return Ok(false);
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        if let Err(e) = reader.read_exact(&mut body) {
            return if quiet_end(&e) { Ok(false) } else { Err(e) };
        }
    }
    if path != "/console" && !path.starts_with("/console/") {
        write_reply(reader.get_mut(), &plain(404, "unknown path"), close)?;
        return Ok(!close);
    }
    let Some(peer) = peer_ip(address) else { return Ok(false) };
    let host = head.header("host").unwrap_or_default().trim().to_lowercase();
    let host_ok = host == port.conf.public || (port.conf.public_port == 443 && host == format!("{}:443", port.conf.host));
    let cookie = head.headers.iter().filter(|(k, _)| k == "cookie").map(|(_, v)| v.as_str()).collect::<Vec<_>>().join("; ");
    let origin = head.header("origin");
    let marker = head.header(crate::console::MARKER_HEADER);
    let content_type = head.header("content-type").unwrap_or_default();
    let user_agent = head.header("user-agent").unwrap_or_default();
    let activity = head.header("x-lucid-activity").map(|v| v.trim() == "1").unwrap_or(false);
    let body = String::from_utf8_lossy(&body).into_owned();
    let dialed = port.conf.dialed();
    let request = ConsoleRequest {
        method: &head.method,
        pathname: &path,
        query: &query,
        cookie: &cookie,
        origin: origin.as_deref(),
        marker: marker.as_deref(),
        activity,
        content_type: &content_type,
        user_agent: &user_agent,
        peer,
        forwarded: &[],
        body: &body,
        dialed: &dialed,
        host_ok,
    };
    let t = (pj::now() * 1000.0) as i64;
    let reply = (port.handler)(&request, t);
    close |= reply.close;
    write_reply(reader.get_mut(), &reply, close)?;
    Ok(!close)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn settings(extra: serde_json::Value) -> Settings {
        let mut s = Settings { host: "relay.example.org".into(), port: 443, admins: vec!["ann@example.org".into()], guest_public: "https://guest.example.org".into(), ..Settings::default() };
        s.console_port = json!(8443);
        s.console_public = "console.example.org".into();
        s.console_cert = "console.crt".into();
        s.console_key = "console.key".into();
        s.console_sources = vec!["10.0.0.0/8".into()];
        for (k, v) in extra.as_object().unwrap() {
            match k.as_str() {
                "console_port" => s.console_port = v.clone(),
                "guest_port" => s.guest_port = v.clone(),
                "console_public" => s.console_public = v.as_str().unwrap().into(),
                "console_sources" => s.console_sources = v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(),
                "console_first_admin" => s.console_first_admin = v.as_str().unwrap().into(),
                "console_cert" => s.console_cert = v.as_str().unwrap().into(),
                _ => panic!("{k}"),
            }
        }
        s
    }

    #[test]
    fn console_port_is_off_by_default() {
        assert_eq!(check_settings(&Settings::default(), &[]), Ok(None));
    }

    #[test]
    fn start_errors_follow_the_contract() {
        let conf = check_settings(&settings(json!({})), &[]).unwrap().unwrap();
        assert_eq!(conf.origin(), "https://console.example.org");
        assert_eq!(conf.port, 8443);
        assert_eq!(check_settings(&settings(json!({"console_port": 443})), &[]).unwrap_err(), PORT_WORDS);
        assert_eq!(check_settings(&settings(json!({"guest_port": 8443})), &[]).unwrap_err(), PORT_WORDS);
        assert_eq!(check_settings(&settings(json!({"console_port": 70000})), &[]).unwrap_err(), PORT_WORDS);
        assert_eq!(check_settings(&settings(json!({"console_public": "10.0.0.5"})), &[]).unwrap_err(), PUBLIC_IP);
        assert_eq!(check_settings(&settings(json!({"console_public": "[::1]:8443"})), &[]).unwrap_err(), PUBLIC_IP);
        assert_eq!(check_settings(&settings(json!({"console_public": "relay.example.org:8443"})), &[]).unwrap_err(), PUBLIC_SHARED);
        assert_eq!(check_settings(&settings(json!({"console_public": "guest.example.org"})), &[]).unwrap_err(), PUBLIC_SHARED);
        assert_eq!(check_settings(&settings(json!({})), &["Console.Example.org".into()]).unwrap_err(), PUBLIC_SHARED);
        assert_eq!(check_settings(&settings(json!({"console_sources": []})), &[]).unwrap_err(), SOURCES_NEEDED);
        assert_eq!(check_settings(&settings(json!({"console_first_admin": "bob@example.org"})), &[]).unwrap_err(), FIRST_ADMIN);
        assert!(check_settings(&settings(json!({"console_first_admin": "Ann@example.org"})), &[]).unwrap().is_some());
        assert_eq!(check_settings(&settings(json!({"console_cert": ""})), &[]).unwrap_err(), CERT_NEEDED);
        let other = check_settings(&settings(json!({"console_public": "console.example.org:9443"})), &[]).unwrap().unwrap();
        assert_eq!((other.public.as_str(), other.public_port), ("console.example.org:9443", 9443));
    }

    fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = body.len();
        if n < 0x80 {
            out.push(n as u8);
        } else if n < 0x100 {
            out.extend([0x81, n as u8]);
        } else {
            out.extend([0x82, (n >> 8) as u8, n as u8]);
        }
        out.extend_from_slice(body);
        out
    }

    fn pem(label: &str, data: &[u8]) -> String {
        let b = pj::b64(data);
        let lines: Vec<String> = b.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    /// A self-signed P-256 certificate naming `dns` (SAN DNS) and its PKCS#8 key, as PEM.
    pub(crate) fn self_signed(dns: &str) -> (String, String) {
        use aws_lc_rs::rand::SystemRandom;
        use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref()).unwrap();
        let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
        let alg = tlv(0x30, &tlv(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        let name = tlv(0x30, &tlv(0x31, &tlv(0x30, &[tlv(0x06, &[0x55, 0x04, 0x03]), tlv(0x0c, dns.as_bytes())].concat())));
        let validity = tlv(0x30, &[tlv(0x17, b"250101000000Z"), tlv(0x17, b"491231235959Z")].concat());
        let san = tlv(0x30, &[tlv(0x06, &[0x55, 0x1d, 0x11]), tlv(0x04, &tlv(0x30, &tlv(0x82, dns.as_bytes())))].concat());
        let exts = tlv(0xa3, &tlv(0x30, &san));
        let tbs = tlv(0x30, &[tlv(0xa0, &tlv(0x02, &[2])), tlv(0x02, &[1]), alg.clone(), name.clone(), validity, name, spki, exts].concat());
        let sig = pair.sign(&rng, &tbs).unwrap();
        let cert = tlv(0x30, &[tbs, alg, tlv(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8.as_ref()))
    }

    pub(crate) fn temp(name: &str, data: &str) -> String {
        let dir = std::env::temp_dir().join(format!("lucid-console-port-{}-{}", std::process::id(), pj::mono().to_bits()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, data).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn test_port(sources: &[&str]) -> Arc<Port> {
        let mut s = settings(json!({}));
        let (cert, key) = self_signed("console.example.org");
        s.console_cert = temp("console.crt", &cert);
        s.console_key = temp("console.key", &key);
        let conf = check_settings(&s, &[]).unwrap().unwrap();
        let nets = crate::console_source::parse_cidrs(&sources.iter().map(|s| s.to_string()).collect::<Vec<_>>(), 32).unwrap();
        let tls = crate::meet_tls::console_tls_config(&s).unwrap();
        let handler: Handler = Arc::new(|_: &ConsoleRequest<'_>, _: i64| ConsoleReply { status: 200, content_type: "application/json", body: b"{}".to_vec(), headers: Vec::new(), close: false });
        let source_ok: SourceCheck = Arc::new(move |ip: IpAddr| nets.iter().any(|n| n.contains(ip)));
        Port::new(conf, tls, handler, source_ok)
    }

    #[test]
    fn console_cert_must_name_the_host_and_not_come_from_the_meet_ca() {
        let (cert, _) = self_signed("console.example.org");
        let (ca, _) = self_signed("meet-ca.example.org");
        let (cert_path, ca_path) = (temp("c.crt", &cert), temp("ca.crt", &ca));
        assert_eq!(crate::meet_tls::check_console_cert(&cert_path, &ca_path, "console.example.org"), Ok(()));
        let refused = "console_cert must be a certificate browsers trust for other.example.org, not one from the Meet CA";
        assert_eq!(crate::meet_tls::check_console_cert(&cert_path, &ca_path, "other.example.org").unwrap_err(), refused);
        // the Meet CA itself (or anything it issued) is refused even when it names the host
        let (meet, _) = self_signed("console.example.org");
        let both = temp("ca2.crt", &format!("{ca}{meet}"));
        let refused = "console_cert must be a certificate browsers trust for console.example.org, not one from the Meet CA";
        assert_eq!(crate::meet_tls::check_console_cert(&temp("m.crt", &meet), &both, "console.example.org").unwrap_err(), refused);
    }

    #[test]
    fn source_is_refused_before_a_slot() {
        let port = test_port(&["10.0.0.0/8"]);
        // 300 connections from outside the list leave every slot free
        for i in 0..300 {
            assert!(port.admit(&format!("203.0.113.{}", i % 250)).is_none());
        }
        assert_eq!(port.open_count(), 0);
        let inside = port.admit("10.1.2.3");
        assert!(inside.is_some());
        assert_eq!(port.open_count(), 1);
        drop(inside);
        assert_eq!(port.open_count(), 0);
        // an IPv4-mapped IPv6 peer is judged as its IPv4 address
        assert!(port.admit("::ffff:10.9.9.9").is_some());
    }

    #[test]
    fn connection_caps() {
        let port = test_port(&["10.0.0.0/8", "fd00::/8"]);
        let mut held: Vec<Slot> = (0..CONNECTIONS_PER_ADDRESS).map(|_| port.admit("10.0.0.1").unwrap()).collect();
        assert!(port.admit("10.0.0.1").is_none(), "the 17th from one address");
        let v6: Vec<Slot> = (0..CONNECTIONS_PER_ADDRESS).map(|i| port.admit(&format!("fd00:1:2:3::{:x}", i + 1)).unwrap()).collect();
        assert!(port.admit("fd00:1:2:3::ffff").is_none(), "the 17th from one IPv6 /64");
        held.extend(v6);
        let mut n = 2;
        while held.len() < CONNECTIONS_MAX {
            held.push(port.admit(&format!("10.0.{}.{}", n / 200, n % 200 + 1)).unwrap());
            n += 1;
        }
        assert!(port.admit("10.200.0.1").is_none(), "the 257th");
        held.pop();
        assert!(port.admit("10.200.0.1").is_some());
    }

    #[test]
    fn no_client_certificate_is_asked() {
        // a browser with no client certificate completes the handshake (HTTP/1.1 by ALPN)
        let mut s = settings(json!({}));
        let (cert, key) = self_signed("console.example.org");
        s.console_cert = temp("hs.crt", &cert);
        s.console_key = temp("hs.key", &key);
        let server_cfg = crate::meet_tls::console_tls_config(&s).unwrap();
        assert_eq!(server_cfg.alpn_protocols, vec![b"http/1.1".to_vec()]);
        let mut roots = rustls::RootCertStore::empty();
        for c in rustls_pemfile::certs(&mut cert.as_bytes()) {
            roots.add(c.unwrap()).unwrap();
        }
        let client_cfg = rustls::ClientConfig::builder_with_provider(Arc::new(crate::server::provider())).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from("console.example.org").unwrap();
        let mut client = rustls::ClientConnection::new(Arc::new(client_cfg), name).unwrap();
        let mut server = rustls::ServerConnection::new(server_cfg).unwrap();
        for _ in 0..20 {
            let mut buf = Vec::new();
            client.write_tls(&mut buf).unwrap();
            if !buf.is_empty() {
                server.read_tls(&mut buf.as_slice()).unwrap();
                server.process_new_packets().unwrap();
            }
            let mut buf = Vec::new();
            server.write_tls(&mut buf).unwrap();
            if !buf.is_empty() {
                client.read_tls(&mut buf.as_slice()).unwrap();
                client.process_new_packets().unwrap();
            }
            if !client.is_handshaking() && !server.is_handshaking() {
                break;
            }
        }
        assert!(!server.is_handshaking() && !client.is_handshaking());
        assert!(server.peer_certificates().is_none());
    }

    #[test]
    fn handshake_has_ten_seconds() {
        assert_eq!(HANDSHAKE_TIMEOUT, 10.0);
        assert_eq!(IDLE_TIMEOUT, 30.0);
    }

    #[test]
    fn host_names() {
        assert_eq!(host_of("https://Guest.Example.org:8443/g/"), "guest.example.org");
        assert_eq!(host_of("console.example.org:9443"), "console.example.org");
        assert!(!dns_name_ok("10.0.0.1"));
        assert!(dns_name_ok("console.example.org"));
    }
}
