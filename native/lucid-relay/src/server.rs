// HTTP/1.1 over plain TCP (loopback, or behind a platform's TLS front) or TLS (rustls with the AWS-LC provider; its
// FIPS module with the `fips` feature). Each request: /healthz first, then the license gate, then the body read with
// its limit held while it streams in (and its deadline), then the relay state under one lock. Connections are capped
// (CONN_LIMITS: one past the cap is dropped unread) and a TLS handshake has its own deadline.

use crate::codec::{js_number, now_ms, utf8_lossy};
use crate::console::{Console, ConsoleReply, ConsoleRequest, ACTIVITY_HEADER, MARKER_HEADER};
use std::path::{Path, PathBuf};
use crate::license::SEAT_HEADER;
use crate::log::{Fields, Logger};
use crate::relay::{json_reply, refuse, Dialed, HostCheck, Reply, Request, State, BODY_BYTES};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, ORIGIN, USER_AGENT};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Response;
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::Mutex;
use serde_json::json;
use std::convert::Infallible;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

pub struct Relay {
    /// Shared with the console's Remote Spokes section (console_spokes.rs), which holds it weakly.
    pub state: Arc<Mutex<State>>,
    pub logger: Arc<Logger>,
    pub hosts: HostCheck,
    pub tls: bool,
}

/// An IPv6 address as the WHATWG URL standard serializes it: lower-case hex, the first longest run of two or more
/// zero groups as `::`, never a dotted IPv4 tail.
pub fn whatwg_ipv6(ip: &Ipv6Addr) -> String {
    let s = ip.segments();
    let (mut best, mut best_len, mut i) = (None, 1usize, 0usize);
    while i < 8 {
        if s[i] == 0 {
            let start = i;
            while i < 8 && s[i] == 0 {
                i += 1;
            }
            if i - start > best_len {
                best = Some(start);
                best_len = i - start;
            }
        } else {
            i += 1;
        }
    }
    let mut out = String::new();
    let mut i = 0;
    while i < 8 {
        if Some(i) == best {
            out.push_str(if i == 0 { "::" } else { ":" });
            i += best_len;
            continue;
        }
        out.push_str(&format!("{:x}", s[i]));
        if i < 7 {
            out.push(':');
        }
        i += 1;
    }
    out
}

/// The WHATWG IPv4 parser for a host that ends in a number (decimal, 0x hex, 0 octal, one to four parts).
fn whatwg_ipv4(host: &str) -> Option<Ipv4Addr> {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut nums = Vec::with_capacity(parts.len());
    for p in &parts {
        let (digits, radix) = if let Some(h) = p.strip_prefix("0x").or_else(|| p.strip_prefix("0X")) {
            (h, 16)
        } else if p.len() > 1 && p.starts_with('0') {
            (&p[1..], 8)
        } else {
            (*p, 10)
        };
        if radix == 10 && digits.is_empty() {
            return None;
        }
        let n = if digits.is_empty() { 0 } else { u64::from_str_radix(digits, radix).ok()? };
        nums.push(n);
    }
    let last = nums.pop()?;
    if nums.iter().any(|n| *n > 255) || last >= 256u64.pow(5 - parts.len() as u32) {
        return None;
    }
    let mut v = last;
    for (i, n) in nums.iter().enumerate() {
        v += n << (8 * (3 - i));
    }
    Some(Ipv4Addr::from(v as u32))
}

/// The host a caller dialed, as `new URL(req.url)` reads it from the Host header.
pub fn dialed_of(host_header: &str, tls: bool) -> Dialed {
    let raw = host_header.trim().to_ascii_lowercase();
    let default = if tls { 443 } else { 80 };
    let (name, port_text) = if raw.starts_with('[') {
        match raw.find(']') {
            Some(end) => (raw[..=end].to_owned(), raw[end + 1..].strip_prefix(':').unwrap_or("").to_owned()),
            None => (raw.clone(), String::new()),
        }
    } else {
        match raw.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), p.to_owned()),
            None => (raw.clone(), String::new()),
        }
    };
    let hostname = if let Some(inner) = name.strip_prefix('[').and_then(|n| n.strip_suffix(']')) {
        inner.parse::<Ipv6Addr>().map(|ip| format!("[{}]", whatwg_ipv6(&ip))).unwrap_or(name.clone())
    } else {
        let last = name.trim_end_matches('.').rsplit('.').next().unwrap_or("");
        let numeric = !last.is_empty() && (last.bytes().all(|c| c.is_ascii_digit()) || last.starts_with("0x"));
        if numeric { whatwg_ipv4(&name).map(|ip| ip.to_string()).unwrap_or(name.clone()) } else { name.clone() }
    };
    let port = if port_text.is_empty() { None } else { port_text.parse::<u16>().ok() };
    let port = port.filter(|p| *p != default);
    let host = match port {
        Some(p) => format!("{hostname}:{p}"),
        None => hostname.clone(),
    };
    Dialed { host, hostname, port: port.unwrap_or(default) }
}

const X_FORWARDED_FOR: &str = "x-forwarded-for";

/// A route's place in the Remote Spokes license gate (AC-1 2.4, R42-1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gate {
    /// Refused with 503 `license-inactive` while service is stopped.
    Service,
    /// Answers in every license state, so an admin can fix it.
    Exempt,
}

/// The routes that keep answering while service is stopped: CRL reads and uploads (revocation), the console's request
/// list for admin hubs, and the AC-2a channel's endorsement routes. `/healthz` and `/console/` are let through before
/// the gate. Every other route, a route missing here included, is `service`.
pub const EXEMPT_ROUTES: [(&str, &str); 6] = [
    ("GET", "/v1/crl"),
    ("POST", "/v1/crl"),
    ("GET", "/v1/console/requests"),
    ("GET", "/v1/console/where"),
    ("GET", "/v1/console/fleet-bootstrap"),
    ("POST", "/v1/console/fleet-endorse"),
];

pub fn license_gate_of(method: &str, path: &str) -> Gate {
    if EXEMPT_ROUTES.iter().any(|(m, p)| *m == method && *p == path) {
        Gate::Exempt
    } else {
        Gate::Service
    }
}

fn to_response(r: Reply) -> Response<Full<Bytes>> {
    let mut b = Response::builder().status(r.status).header(CONTENT_TYPE, r.content_type);
    if r.content_type == "application/json" {
        b = b.header(CACHE_CONTROL, "no-store");
    }
    if r.close {
        b = b.header(CONNECTION, "close");
    }
    b.body(Full::new(Bytes::from(r.body))).unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn console_response(r: ConsoleReply) -> Response<Full<Bytes>> {
    let mut b = Response::builder().status(r.status).header(CONTENT_TYPE, r.content_type);
    for (name, value) in &r.headers {
        b = b.header(*name, value.as_str());
    }
    if r.close {
        b = b.header(CONNECTION, "close");
    }
    b.body(Full::new(Bytes::from(r.body))).unwrap_or_else(|_| internal_error())
}

fn internal_error() -> Response<Full<Bytes>> {
    to_response(Reply { status: 500, content_type: "text/plain;charset=utf-8", body: "Internal Server Error".into(), close: false })
}

async fn handle(relay: Arc<Relay>, req: hyper::Request<Incoming>, peer: SocketAddr, body_time: Duration) -> Response<Full<Bytes>> {
    let (parts, body) = req.into_parts();
    let method = parts.method.as_str().to_owned();
    let pathname = parts.uri.path().to_owned();
    let path = match parts.uri.query() {
        Some(q) if !q.is_empty() => format!("{pathname}?{q}"),
        _ => pathname.clone(),
    };
    if pathname == "/healthz" && method == "GET" {
        return to_response(json_reply(200, &json!({ "ok": true })));
    }
    let t = now_ms();
    // Behind a TLS front this is the front's address; the node id in each line is what identifies a caller.
    let where_ = Fields::new().with("method", method.as_str()).with("path", pathname.as_str()).with("ip", peer.ip().to_string());
    // The control panel (src/console.rs, ADR-A094) answers under /console/ when it is on, before the license gate: an
    // admin must see an expired license there. When it is off these paths are relay routes like any other.
    let console = if pathname == "/console" || pathname.starts_with("/console/") { relay.state.lock().console() } else { None };
    if console.is_none() && license_gate_of(&method, &pathname) == Gate::Service {
        let gate = relay.state.lock().license_gate(t, &where_);
        match gate {
            Err(_) => return internal_error(),
            Ok(Some(r)) => return to_response(r),
            Ok(None) => {}
        }
    }
    // The body limit holds while the body streams in (RS-RELAY-02): a declared length over it is refused unread, and
    // a chunked body is read frame by frame and cut at the limit, never buffered whole.
    let declared = parts.headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).map(js_number).unwrap_or(0.0);
    // The console's MDS3 upload takes up to 16 MiB (AC-1 3.5); the console checks each route's own limit after this.
    let cap = if console.is_some() && pathname == "/console/api/settings/mds" { crate::console::MDS_BODY_MAX.max(BODY_BYTES) } else { BODY_BYTES };
    let mut over = if declared > cap as f64 { declared as usize } else { 0 };
    let mut text = String::new();
    if over == 0 && method != "GET" {
        let mut body = body;
        let mut buf = Vec::new();
        let mut size = 0usize;
        // The whole body arrives within body_time, or the connection goes: a stalled sender holds nothing for long.
        let deadline = tokio::time::Instant::now() + body_time;
        loop {
            let Ok(frame) = tokio::time::timeout_at(deadline, body.frame()).await else {
                let f = where_.clone().with("bytes", size).with("limitMs", body_time.as_millis() as u64);
                let mut r = refuse(&relay.logger, 408, "request body timed out", "request.timeout", &f);
                r.close = true;
                return to_response(r);
            };
            match frame {
                None => break,
                Some(Err(e)) => {
                    let f = where_.clone().with("bytes", size).with("reason", e.to_string());
                    return to_response(refuse(&relay.logger, 400, "unreadable body", "request.unreadable", &f));
                }
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        size += data.len();
                        if size > cap {
                            over = size;
                            break;
                        }
                        buf.extend_from_slice(&data);
                    }
                }
            }
        }
        if over == 0 {
            text = utf8_lossy(&buf);
        }
    }
    if over > 0 {
        let f = where_.clone().with("bytes", over).with("capBytes", cap);
        let mut r = refuse(&relay.logger, 413, "too large", "request.too-large", &f);
        r.close = true; // the rest of a cut body is never read: the connection goes with it
        return to_response(r);
    }
    let header = |name: hyper::header::HeaderName| parts.headers.get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let host_header = header(HOST).or_else(|| parts.uri.authority().map(|a| a.to_string())).unwrap_or_default();
    // Behind a TLS front the caller dialed https: its Host reads as an https URL's host does.
    let behind_tls = relay.hosts.public.is_some();
    let dialed = dialed_of(&host_header, relay.tls || behind_tls);
    let host_ok = relay.hosts.accepts(&dialed);
    if let Some(console) = console {
        let cookie = header(COOKIE).unwrap_or_default();
        let origin = header(ORIGIN);
        let marker = parts.headers.get(MARKER_HEADER).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        let content_type = header(CONTENT_TYPE).unwrap_or_default();
        // AC-1 3.1 (H5): the console reads the source itself. Behind a TLS front it reads X-Forwarded-For only from a
        // peer in --console-trusted-fronts; every header value goes over, in order.
        let forwarded: Vec<String> = parts.headers.get_all(X_FORWARDED_FOR).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        let activity = parts.headers.get(ACTIVITY_HEADER).is_some_and(|v| v.as_bytes() == b"1");
        let user_agent = header(USER_AGENT).unwrap_or_default();
        let r = ConsoleRequest {
            method: &method,
            pathname: &pathname,
            query: parts.uri.query().unwrap_or(""),
            cookie: &cookie,
            origin: origin.as_deref(),
            marker: marker.as_deref(),
            activity,
            content_type: &content_type,
            user_agent: &user_agent,
            peer: peer.ip(),
            forwarded: &forwarded,
            body: &text,
            dialed: &dialed,
            host_ok,
        };
        return console_response(console.http(&r, t));
    }
    let authorization = header(AUTHORIZATION).unwrap_or_default();
    // F2 (ADR-A100): a hub's license seat; only a licensed relay reads it.
    let seat = parts.headers.get(SEAT_HEADER).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let request = Request { method: &method, pathname: &pathname, path: &path, authorization: &authorization, seat: seat.as_deref(), dialed: &dialed, body: &text, where_: &where_ };
    let reply = relay.state.lock().serve(&request, t, host_ok);
    match reply {
        Ok(r) => to_response(r),
        Err(_) => internal_error(),
    }
}

/// TLS for the relay's own certificate and key (PEM).
pub fn tls_acceptor(cert_pem: &str, key_pem: &str) -> Result<TlsAcceptor, String> {
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("the TLS certificate does not read: {e}"))?;
    if certs.is_empty() {
        return Err("the TLS certificate does not read: no CERTIFICATE block".into());
    }
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("the TLS key does not read: {e}"))?
        .ok_or("the TLS key does not read: no private key block")?;
    let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("the TLS certificate and key do not fit: {e}"))?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

#[cfg(feature = "fips")]
pub fn provider() -> rustls::crypto::CryptoProvider {
    rustls::crypto::default_fips_provider()
}

#[cfg(not(feature = "fips"))]
pub fn provider() -> rustls::crypto::CryptoProvider {
    rustls::crypto::aws_lc_rs::default_provider()
}

/// A `fips` build refuses to start unless AWS-LC runs its FIPS module in FIPS mode and the TLS provider says so:
/// every signature check, digest and TLS session then goes through the validated module.
#[cfg(feature = "fips")]
pub fn fips_check() -> Result<(), String> {
    aws_lc_rs::try_fips_mode().map_err(|e| format!("this is a FIPS build, but AWS-LC is not in FIPS mode ({e}): refusing to start"))?;
    if !provider().fips() {
        return Err("this is a FIPS build, but the TLS provider does not report FIPS mode: refusing to start".into());
    }
    Ok(())
}

/// Without the `fips` feature there is nothing to check.
#[cfg(not(feature = "fips"))]
pub fn fips_check() -> Result<(), String> {
    Ok(())
}

/// What one listener allows: connections served at once (one more is dropped unread), and how long a TLS handshake
/// and a request body may take.
#[derive(Clone, Copy)]
pub struct ConnLimits {
    pub connections: usize,
    pub handshake: Duration,
    pub body: Duration,
}

pub const CONN_LIMITS: ConnLimits = ConnLimits { connections: 4096, handshake: Duration::from_secs(10), body: Duration::from_secs(10) };

/// The TLS handshake within `limit`, or None (failed or stalled: the connection is dropped).
pub async fn tls_within(acceptor: &TlsAcceptor, stream: TcpStream, limit: Duration) -> Option<TlsStream<TcpStream>> {
    tokio::time::timeout(limit, acceptor.accept(stream)).await.ok()?.ok()
}

// ── AC-2a: the Lucid Admin Console link of a relay (2.1, 2.2, 5.7) ──────────────────────────────────────────────

/// 2.4: held by a running relay for its whole life, so the offline `fleet` commands refuse while it runs.
pub const FLEET_LOCK: &str = "fleet.lock";
/// 13.4 `cli.fleet-running`.
pub const CLI_FLEET_RUNNING: &str = "Stop the relay first, or use its Admin Console.";
/// 13.4 `cli.with-console-both`.
pub const CLI_WITH_CONSOLE_BOTH: &str = "A relay that runs the console role does not also run its own console: drop --console or console_port.";
/// 13.4 `cli.with-console-high`.
pub const CLI_WITH_CONSOLE_HIGH: &str = "Under the High profile the console and the relay must run as two services with separate accounts. Drop --with-console or with_console.";

/// An exclusive advisory lock on `fleet.lock`; the operating system lets it go when the process ends.
pub struct FleetLock {
    _file: std::fs::File,
}

#[cfg(unix)]
mod flock {
    use std::os::raw::c_int;
    extern "C" {
        pub fn flock(fd: c_int, operation: c_int) -> c_int;
    }
    pub const LOCK_EX: c_int = 2;
    pub const LOCK_NB: c_int = 4;
}

/// Take `fleet.lock` in `dir` (creating the folder), or say why not: CLI_FLEET_RUNNING while another process holds it.
pub fn fleet_lock(dir: &Path) -> Result<FleetLock, String> {
    let _ = crate::store::make_dir(dir);
    let path = dir.join(FLEET_LOCK);
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // No sharing: a second open, by any process, fails while this handle lives.
        o.share_mode(0);
    }
    let file = match o.open(&path) {
        Ok(f) => f,
        Err(e) if e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33) => return Err(CLI_FLEET_RUNNING.into()),
        Err(e) => return Err(format!("cannot open {}: {e}", path.display())),
    };
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: flock on a file descriptor this function owns; no memory is shared with the call.
        let r = unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_EX | flock::LOCK_NB) };
        if r != 0 {
            return Err(CLI_FLEET_RUNNING.into());
        }
    }
    Ok(FleetLock { _file: file })
}

/// 2.2 start checks, before anything is opened: `with_console` (the console role in this process) is refused under
/// High; under High the state folder must be open only to this service's account and the administrators (F18).
pub fn high_start_checks(state_dir: Option<&Path>, high: bool, with_console: bool) -> Result<(), String> {
    if !high {
        return Ok(());
    }
    if with_console {
        return Err(CLI_WITH_CONSOLE_HIGH.into());
    }
    match state_dir {
        Some(dir) => crate::console_seal::check_state_acl(dir, crate::console_seal::SealIdentity::Relay),
        None => Ok(()),
    }
}

/// What `fleet_start` needs (main.rs, Remote Spokes).
pub struct FleetStart {
    pub state_dir: Option<PathBuf>,
    /// The relay's own console when `--console 1`.
    pub console: Option<Arc<Console>>,
    pub relay: Arc<Relay>,
    pub logger: Arc<Logger>,
}

/// The running link: keep it for the process's life (it holds `fleet.lock`, the agent and the headless console).
pub struct Fleet {
    _lock: FleetLock,
    _agent: Option<Arc<crate::fleet_agent::Agent>>,
    _headless: Option<Arc<Console>>,
}

/// What a relay of either product opens for the Lucid Admin Console at start (2.1, 5.7, invariant 22): `fleet.lock`
/// always (with a state folder); then, when enrolled (fleet.json) or holding a handoff, the headless console (unless
/// its own console is on) and the agent; with only its own console on, the agent for an in-process Join. With none of
/// these nothing else is opened, written or dialed. `attach` gives the headless console its product section.
pub struct FleetOpen<'a> {
    pub product: crate::license::Product,
    pub state_dir: &'a Path,
    pub console: Option<Arc<Console>>,
    pub logger: Arc<Logger>,
    pub proxy: Option<String>,
    pub attach: &'a dyn Fn(&Arc<Console>),
}

/// The pieces `fleet_open` started, and the closures the main ports read (`where`, requests).
pub struct FleetOpened {
    pub lock: FleetLock,
    pub agent: Option<Arc<crate::fleet_agent::Agent>>,
    pub headless: Option<Arc<Console>>,
}

pub fn fleet_open(o: FleetOpen) -> Result<FleetOpened, String> {
    let lock = fleet_lock(o.state_dir)?;
    let link = crate::fleet_agent::read_link(o.state_dir, &o.logger);
    let handoff = crate::fleet_agent::has_handoff(o.state_dir);
    if link.is_none() && !handoff && o.console.is_none() {
        return Ok(FleetOpened { lock, agent: None, headless: None });
    }
    let headless = match &o.console {
        Some(_) => None,
        None => {
            let c = crate::console::open_headless(o.product, o.state_dir, o.logger.clone())?;
            (o.attach)(&c);
            Some(c)
        }
    };
    let console = o.console.clone().or_else(|| headless.clone()).ok_or("no console for the fleet agent")?;
    let cfg = crate::fleet_agent::AgentConfig {
        product: o.product,
        state_dir: o.state_dir.to_path_buf(),
        link,
        console,
        logger: o.logger.clone(),
        proxy: o.proxy,
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    let agent = crate::fleet_agent::start(cfg)?;
    Ok(FleetOpened { lock, agent: Some(agent), headless })
}

/// Remote Spokes (main.rs, right after attaching the console's section): `fleet_open`, then the relay's main ports
/// learn the link (`/v1/console/where`, `/v1/console/requests`, the 3.9 endorsement routes). None without `--state`.
pub fn fleet_start(cfg: FleetStart) -> Result<Option<Fleet>, String> {
    let Some(dir) = cfg.state_dir.clone() else { return Ok(None) };
    let weak = Arc::downgrade(&cfg.relay.state);
    let attach = move |c: &Arc<Console>| c.attach(crate::console_spokes::section(weak.clone()));
    let opened = fleet_open(FleetOpen {
        product: crate::license::Product::Spokes,
        state_dir: &dir,
        console: cfg.console.clone(),
        logger: cfg.logger.clone(),
        proxy: std::env::var("LUCID_RELAY_FLEET_PROXY").ok().filter(|p| !p.is_empty()),
        attach: &attach,
    })?;
    if let Some(agent) = &opened.agent {
        let book = cfg.console.clone().or_else(|| opened.headless.clone()).ok_or("no console for the fleet link")?;
        cfg.relay.state.lock().set_fleet(fleet_link(agent.clone(), book, &dir));
    }
    // 9.1: the product values of the metrics snapshot.
    let weak = Arc::downgrade(&cfg.relay.state);
    crate::fleet_probe::set_product_source(Box::new(move |t| weak.upgrade().map(|s| s.lock().fleet_metrics(t)).unwrap_or_default()));
    Ok(Some(Fleet { _lock: opened.lock, _agent: opened.agent, _headless: opened.headless }))
}

/// The main ports' view of the link: the console origin while linked, the book, the roster's active admins.
pub fn fleet_link(agent: Arc<crate::fleet_agent::Agent>, book: Arc<Console>, dir: &Path) -> crate::relay::FleetLink {
    let roster_dir = dir.to_path_buf();
    crate::relay::FleetLink {
        managed_by: Box::new(move || agent.managed_by()),
        book,
        admins: Box::new(move || crate::fleet_trust::active_admin_emails(&roster_dir)),
        state_dir: dir.to_path_buf(),
    }
}

/// Accept connections until the process stops.
pub async fn run(listener: TcpListener, relay: Arc<Relay>, acceptor: Option<TlsAcceptor>, limits: ConnLimits) {
    let slots = Arc::new(Semaphore::new(limits.connections));
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(c) => c,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        // Every slot taken: this connection is dropped unread.
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let relay = relay.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _permit = permit;
            // AC-2a 9.1 `conn_open`: counted while the connection lives.
            let _open = crate::fleet_probe::counters().conn_open();
            let svc = service_fn(move |req| {
                let relay = relay.clone();
                async move { Ok::<_, Infallible>(handle(relay, req, peer, limits.body).await) }
            });
            let mut builder = http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(30));
            match acceptor {
                Some(a) => {
                    if let Some(s) = tls_within(&a, stream, limits.handshake).await {
                        let _ = builder.serve_connection(TokioIo::new(s), svc).await;
                    }
                }
                None => {
                    let _ = builder.serve_connection(TokioIo::new(stream), svc).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_license_gate_table_names_every_exempt_route_and_refuses_the_rest() {
        for (m, p) in EXEMPT_ROUTES {
            assert_eq!(license_gate_of(m, p), Gate::Exempt, "{m} {p}");
        }
        for (m, p) in [("POST", "/v1/send"), ("GET", "/v1/inbox"), ("POST", "/v1/ack"), ("GET", "/v1/directory"), ("POST", "/v1/directory"), ("GET", "/v1/presence"), ("GET", "/v1/license"), ("POST", "/v1/logs"), ("POST", "/v1/console/invite"), ("GET", "/v1/not-a-route"), ("DELETE", "/v1/crl")] {
            assert_eq!(license_gate_of(m, p), Gate::Service, "{m} {p}");
        }
    }

    fn fleet_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-server-fleet-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// AC-2a 16.1 f-relay: a running relay holds `fleet.lock`, so the offline commands (which take it) refuse with
    /// `cli.fleet-running`; once it stops they run.
    #[test]
    fn ac2a_fleet_lock_makes_the_offline_commands_refuse_while_running() {
        let dir = fleet_dir("lock");
        let running = fleet_lock(&dir).unwrap();
        assert_eq!(fleet_lock(&dir).err().as_deref(), Some(CLI_FLEET_RUNNING));
        drop(running);
        assert!(fleet_lock(&dir).is_ok());
    }

    /// AC-2a 16.1 f-relay (invariant 22): a relay that is not enrolled, holds no handoff and runs no console of its
    /// own starts no agent (no listener, no connection) and writes only `fleet.lock`.
    #[test]
    fn ac2a_an_unenrolled_relay_writes_only_fleet_lock() {
        let dir = fleet_dir("unenrolled");
        let logger = Arc::new(Logger::capture("relay", Box::new(|_, _| {})));
        let attached = std::sync::atomic::AtomicBool::new(false);
        let attach = |_: &Arc<Console>| attached.store(true, std::sync::atomic::Ordering::SeqCst);
        let opened = fleet_open(FleetOpen { product: crate::license::Product::Spokes, state_dir: &dir, console: None, logger, proxy: None, attach: &attach }).unwrap();
        assert!(opened.agent.is_none() && opened.headless.is_none());
        assert!(!attached.load(std::sync::atomic::Ordering::SeqCst));
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![FLEET_LOCK.to_string()]);
    }

    /// AC-2a 2.2: under High a relay never runs the console role in process.
    #[test]
    fn ac2a_high_refuses_with_console() {
        assert_eq!(high_start_checks(None, true, true).err().as_deref(), Some(CLI_WITH_CONSOLE_HIGH));
        assert!(high_start_checks(None, false, true).is_ok());
    }

    #[test]
    fn hosts_normalize_as_whatwg_urls_do() {
        assert_eq!(whatwg_ipv6(&"::1".parse().unwrap()), "::1");
        assert_eq!(whatwg_ipv6(&"2001:db8:0:0:1:0:0:1".parse().unwrap()), "2001:db8::1:0:0:1");
        assert_eq!(whatwg_ipv6(&"::ffff:1.2.3.4".parse().unwrap()), "::ffff:102:304");
        let d = dialed_of("127.0.0.1:8787", false);
        assert_eq!((d.host.as_str(), d.hostname.as_str(), d.port), ("127.0.0.1:8787", "127.0.0.1", 8787));
        let d = dialed_of("Relay.Example:443", true);
        assert_eq!((d.host.as_str(), d.port), ("relay.example", 443));
        let d = dialed_of("[0:0::1]:9443", true);
        assert_eq!((d.host.as_str(), d.hostname.as_str()), ("[::1]:9443", "[::1]"));
        assert_eq!(whatwg_ipv4("127.1"), Some(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(whatwg_ipv4("0x7f.0.0.1"), Some(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(whatwg_ipv4("256.0.0.1"), None);
    }

    #[test]
    fn behind_a_tls_front_only_the_public_host_is_this_relay() {
        let hosts = HostCheck { names: None, port: 8080, public: Some(dialed_of("Relay.Example.com", true)) };
        assert!(hosts.accepts(&dialed_of("relay.example.com", true)));
        assert!(hosts.accepts(&dialed_of("relay.example.com:443", true)));
        assert!(!hosts.accepts(&dialed_of("relay.example.com:8443", true)));
        assert!(!hosts.accepts(&dialed_of("evil.example", true)));
        assert!(!hosts.accepts(&dialed_of("127.0.0.1:8080", true)));
        // With neither TLS names nor a public host, only loopback on the listening port.
        let bare = HostCheck { names: None, port: 8080, public: None };
        assert!(bare.accepts(&dialed_of("127.0.0.1:8080", false)));
        assert!(!bare.accepts(&dialed_of("relay.example.com", false)));
        // The console's source behind a front: console_source.rs (AC-1 3.1).
    }

    #[test]
    fn a_fips_build_runs_in_fips_mode() {
        // Without the feature there is nothing to check; with it, this test runs on the FIPS module in FIPS mode.
        assert_eq!(fips_check(), Ok(()));
    }

    use crate::log::Logger;
    use crate::relay::{Options, SENDER_BYTES, STORE_BYTES};
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_relay() -> Arc<Relay> {
        let root = p256::ecdsa::SigningKey::from_slice(&[1u8; 32]).unwrap();
        let logger = Arc::new(Logger::capture("relay", Box::new(|_, _| {})));
        let opts = Options {
            root: root.verifying_key().into(),
            owner: None,
            license: None,
            crl_file: None,
            store: None,
            seen_file: None,
            directory_file: None,
            users_file: None,
            store_bytes: STORE_BYTES,
            sender_bytes: SENDER_BYTES,
            console: None,
            state_dir: None,
            license_file: None,
        };
        let state = State::new(opts, logger.clone()).unwrap();
        Arc::new(Relay { state: Arc::new(Mutex::new(state)), logger, hosts: HostCheck { names: None, port: 0, public: None }, tls: false })
    }

    async fn listen(acceptor: Option<TlsAcceptor>, limits: ConnLimits) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(run(listener, test_relay(), acceptor, limits));
        port
    }

    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let n = body.len();
        let mut out = vec![tag];
        match n {
            0..=0x7f => out.push(n as u8),
            0x80..=0xff => out.extend([0x81, n as u8]),
            _ => out.extend([0x82, (n >> 8) as u8, n as u8]),
        }
        out.extend_from_slice(body);
        out
    }

    fn pem(label: &str, data: &[u8]) -> String {
        let b = crate::meet_json::b64(data);
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    /// A self-signed P-256 certificate for relay.test and its PKCS#8 key, as PEM.
    fn self_signed() -> (String, String) {
        use aws_lc_rs::rand::SystemRandom;
        use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref()).unwrap();
        let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
        let alg = der(0x30, &der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        let name = der(0x30, &der(0x31, &der(0x30, &[der(0x06, &[0x55, 0x04, 0x03]), der(0x0c, b"relay.test")].concat())));
        let validity = der(0x30, &[der(0x17, b"250101000000Z"), der(0x17, b"491231235959Z")].concat());
        let tbs = der(0x30, &[der(0xa0, &der(0x02, &[2])), der(0x02, &[1]), alg.clone(), name.clone(), validity, name, spki].concat());
        let sig = pair.sign(&rng, &tbs).unwrap();
        let cert = der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8.as_ref()))
    }

    #[tokio::test]
    async fn a_stalled_request_body_is_cut_at_its_deadline() {
        let limits = ConnLimits { connections: 8, handshake: Duration::from_secs(10), body: Duration::from_millis(300) };
        let port = listen(None, limits).await;
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // Ten bytes of the hundred it declares, then nothing (a CRL upload: the unlicensed test relay still reads it).
        c.write_all(b"POST /v1/crl HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{\"v\":1,\"x\"").await.unwrap();
        let started = Instant::now();
        let mut answer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), c.read_to_end(&mut answer)).await;
        assert!(read.is_ok(), "the relay answered and closed the connection");
        let text = String::from_utf8_lossy(&answer);
        assert!(text.starts_with("HTTP/1.1 408"), "{text}");
        assert!(text.contains("request body timed out") && text.to_ascii_lowercase().contains("connection: close"), "{text}");
        assert!(started.elapsed() >= Duration::from_millis(250));
    }

    #[tokio::test]
    async fn a_stalled_tls_handshake_is_dropped() {
        let (cert, key) = self_signed();
        let acceptor = tls_acceptor(&cert, &key).unwrap();
        let limits = ConnLimits { connections: 8, handshake: Duration::from_millis(300), body: Duration::from_secs(10) };
        let port = listen(Some(acceptor), limits).await;
        // A client that connects and never says hello.
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let started = Instant::now();
        let mut buf = [0u8; 64];
        let read = tokio::time::timeout(Duration::from_secs(5), c.read(&mut buf)).await;
        assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "the relay dropped the stalled connection");
        assert!(started.elapsed() >= Duration::from_millis(250));
    }

    #[tokio::test]
    async fn connections_past_the_cap_are_dropped() {
        let limits = ConnLimits { connections: 1, handshake: Duration::from_secs(10), body: Duration::from_secs(10) };
        let port = listen(None, limits).await;
        // The one slot, held by a client that has sent nothing yet.
        let first = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut second = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut buf = [0u8; 64];
        let read = tokio::time::timeout(Duration::from_secs(5), second.read(&mut buf)).await;
        assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "the connection over the cap was dropped");
        // The slot comes back when its connection goes.
        drop(first);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut third = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        third.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut answer = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), third.read_to_end(&mut answer)).await;
        assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 200"));
    }
}
