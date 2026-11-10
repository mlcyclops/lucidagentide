// HTTP/1.1 over plain TCP (loopback, or behind a platform's TLS front) or TLS (rustls with the AWS-LC provider; its
// FIPS module with the `fips` feature). Each request: /healthz first, then the licence gate, then the body read with
// its limit held while it streams in, then the relay state under one lock.

use crate::codec::{js_number, now_ms, utf8_lossy};
use crate::log::{Fields, Logger};
use crate::relay::{json_reply, refuse, Dialed, HostCheck, Reply, Request, State, BODY_BYTES};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST};
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
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub struct Relay {
    pub state: Mutex<State>,
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

fn internal_error() -> Response<Full<Bytes>> {
    to_response(Reply { status: 500, content_type: "text/plain;charset=utf-8", body: "Internal Server Error".into(), close: false })
}

async fn handle(relay: Arc<Relay>, req: hyper::Request<Incoming>, peer: SocketAddr) -> Response<Full<Bytes>> {
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
    let gate = relay.state.lock().licence_gate(t, &where_);
    match gate {
        Err(_) => return internal_error(),
        Ok(Some(r)) => return to_response(r),
        Ok(None) => {}
    }
    // The body limit holds while the body streams in (RS-RELAY-02): a declared length over it is refused unread, and
    // a chunked body is read frame by frame and cut at the limit, never buffered whole.
    let declared = parts.headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).map(js_number).unwrap_or(0.0);
    let mut over = if declared > BODY_BYTES as f64 { declared as usize } else { 0 };
    let mut text = String::new();
    if over == 0 && method != "GET" {
        let mut body = body;
        let mut buf = Vec::new();
        let mut size = 0usize;
        loop {
            match body.frame().await {
                None => break,
                Some(Err(e)) => {
                    let f = where_.clone().with("bytes", size).with("reason", e.to_string());
                    return to_response(refuse(&relay.logger, 400, "unreadable body", "request.unreadable", &f));
                }
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        size += data.len();
                        if size > BODY_BYTES {
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
        let f = where_.clone().with("bytes", over).with("capBytes", BODY_BYTES);
        let mut r = refuse(&relay.logger, 413, "too large", "request.too-large", &f);
        r.close = true; // the rest of a cut body is never read: the connection goes with it
        return to_response(r);
    }
    let header = |name: hyper::header::HeaderName| parts.headers.get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let host_header = header(HOST).or_else(|| parts.uri.authority().map(|a| a.to_string())).unwrap_or_default();
    let dialed = dialed_of(&host_header, relay.tls);
    let host_ok = relay.hosts.accepts(&dialed);
    let authorization = header(AUTHORIZATION).unwrap_or_default();
    let request = Request { method: &method, pathname: &pathname, path: &path, authorization: &authorization, dialed: &dialed, body: &text, where_: &where_ };
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

/// Accept connections until the process stops.
pub async fn run(listener: TcpListener, relay: Arc<Relay>, acceptor: Option<TlsAcceptor>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(c) => c,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let relay = relay.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let relay = relay.clone();
                async move { Ok::<_, Infallible>(handle(relay, req, peer).await) }
            });
            let mut builder = http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(30));
            match acceptor {
                Some(a) => {
                    if let Ok(s) = a.accept(stream).await {
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
}
