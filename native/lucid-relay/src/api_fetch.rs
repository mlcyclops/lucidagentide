//! Outbound URL fetches (API contract section 8.1): `jwks_uri`, OIDC discovery of federated issuers and export
//! destinations. HTTPS only, every resolved address checked, the connection made to a checked address (never by
//! name, so DNS rebinding between check and connect cannot happen), redirects never followed, bodies capped.
//! TLS follows the crate convention: webpki roots on the AWS-LC provider of `crate::server::provider()`.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};

pub const MAX_URL: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub code: &'static str,
    pub message: String,
}

impl FetchError {
    fn new(code: &'static str, message: impl Into<String>) -> FetchError {
        FetchError { code, message: message.into() }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Host of a checked URL.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Host {
    Name(String),
    Ip(IpAddr),
}

/// A URL that passed `check_url`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FetchUrl {
    pub host: Host,
    pub port: u16,
    /// Path and query, always starting with `/`.
    pub path: String,
    /// The normalized URL (lowercased host), also the cache key.
    pub url: String,
}

impl FetchUrl {
    fn host_text(&self) -> String {
        match &self.host {
            Host::Name(n) => n.clone(),
            Host::Ip(IpAddr::V4(a)) => a.to_string(),
            Host::Ip(IpAddr::V6(a)) => format!("[{a}]"),
        }
    }

    /// Value of the `Host` header.
    fn authority(&self) -> String {
        if self.port == 443 { self.host_text() } else { format!("{}:{}", self.host_text(), self.port) }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub dns: Duration,
    pub connect: Duration,
    pub total: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { dns: Duration::from_secs(5), connect: Duration::from_secs(5), total: Duration::from_secs(30) }
    }
}

fn url_err(m: &str) -> FetchError {
    FetchError::new("url", m)
}

/// Check and normalize an outbound URL.
pub fn check_url(url: &str) -> Result<FetchUrl, FetchError> {
    if url.len() > MAX_URL {
        return Err(url_err("URL longer than 512 characters"));
    }
    if url.bytes().any(|b| b <= b' ' || b >= 0x7f || b == b'\\') {
        return Err(url_err("URL holds spaces, controls, backslashes or non-ASCII"));
    }
    let lower = url.get(..8).map(|s| s.to_ascii_lowercase());
    if lower.as_deref() != Some("https://") {
        return Err(url_err("only https:// URLs are allowed"));
    }
    let rest = &url[8..];
    if rest.contains('#') {
        return Err(url_err("URL holds a fragment"));
    }
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') {
        return Err(url_err("URL holds userinfo"));
    }
    if authority.is_empty() {
        return Err(url_err("URL has no host"));
    }
    let (host_part, port_part) = if let Some(r) = authority.strip_prefix('[') {
        let close = r.find(']').ok_or_else(|| url_err("unclosed IPv6 literal"))?;
        let after = &r[close + 1..];
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':').ok_or_else(|| url_err("junk after IPv6 literal"))?),
        };
        let ip: Ipv6Addr = r[..close].parse().map_err(|_| url_err("bad IPv6 literal"))?;
        (Host::Ip(IpAddr::V6(ip)), port)
    } else {
        let (h, p) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        (parse_host(h)?, p)
    };
    let port = match port_part {
        None => 443,
        Some(p) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(url_err("bad port"));
            }
            match p.parse::<u16>() {
                Ok(n) if n > 0 => n,
                _ => return Err(url_err("bad port")),
            }
        }
    };
    let path = if tail.starts_with('/') { tail.to_string() } else { format!("/{tail}") };
    let mut out = FetchUrl { host: host_part, port, path, url: String::new() };
    out.url = format!("https://{}{}", out.authority(), out.path);
    Ok(out)
}

fn parse_host(h: &str) -> Result<Host, FetchError> {
    if h.is_empty() {
        return Err(url_err("URL has no host"));
    }
    if h.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        // All-numeric hosts must be a clean dotted quad (no octal, short or integer forms).
        let ip: Ipv4Addr = h.parse().map_err(|_| url_err("bad IPv4 literal"))?;
        return Ok(Host::Ip(IpAddr::V4(ip)));
    }
    let h = h.strip_suffix('.').unwrap_or(h).to_ascii_lowercase();
    if h.len() > 253 {
        return Err(url_err("host name too long"));
    }
    for label in h.split('.') {
        let ok = !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !ok {
            return Err(url_err("bad host name"));
        }
    }
    // A name whose last label is numeric (`0x7f.1`, `10.1.0x1`) is an address in disguise: some resolvers read it as
    // one. Real top-level labels are never numeric.
    let last = h.rsplit('.').next().unwrap_or_default();
    let hex = last.strip_prefix("0x").is_some_and(|r| r.bytes().all(|b| b.is_ascii_hexdigit()));
    if hex || last.bytes().all(|b| b.is_ascii_digit()) {
        return Err(url_err("numeric host form"));
    }
    Ok(Host::Name(h))
}

fn v4_refused(a: Ipv4Addr, private_ok: bool) -> bool {
    let o = a.octets();
    if a.is_unspecified() || a.is_loopback() || a.is_multicast() || a.is_broadcast() || a.is_link_local() || o[0] == 0 {
        return true;
    }
    let private = a.is_private() || (o[0] == 100 && (o[1] & 0xc0) == 64);
    private && !private_ok
}

/// Whether an outbound fetch may reach `ip`.
pub fn address_allowed(ip: IpAddr, private_ok: bool) -> bool {
    match ip {
        IpAddr::V4(a) => !v4_refused(a, private_ok),
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return !v4_refused(v4, private_ok);
            }
            let s = a.segments();
            // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks).
            if s[..6] == [0; 6] && !a.is_unspecified() && !a.is_loopback() {
                let o = a.octets();
                return !v4_refused(Ipv4Addr::new(o[12], o[13], o[14], o[15]), private_ok);
            }
            if a.is_unspecified() || a.is_loopback() || a.is_multicast() {
                return false;
            }
            if (s[0] & 0xffc0) == 0xfe80 {
                return false;
            }
            if a == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254) {
                return false;
            }
            if (s[0] & 0xfe00) == 0xfc00 {
                return private_ok;
            }
            true
        }
    }
}

fn tls_config() -> Result<Arc<ClientConfig>, FetchError> {
    static CFG: LazyLock<Result<Arc<ClientConfig>, String>> = LazyLock::new(|| {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Arc::new(cfg))
    });
    CFG.clone().map_err(|e| FetchError::new("tls", e))
}

/// Resolve the URL host; every address must be allowed (with `private_ok` false, a private address only inside one of
/// `within`, API-1d 7.13).
async fn resolve(url: &FetchUrl, private_ok: bool, within: &[crate::console_source::Cidr], limits: &Limits) -> Result<Vec<SocketAddr>, FetchError> {
    let addrs: Vec<SocketAddr> = match &url.host {
        Host::Ip(ip) => vec![SocketAddr::new(*ip, url.port)],
        Host::Name(n) => tokio::time::timeout(limits.dns, tokio::net::lookup_host((n.as_str(), url.port)))
            .await
            .map_err(|_| FetchError::new("timeout", "DNS lookup timed out"))?
            .map_err(|e| FetchError::new("dns", e.to_string()))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(FetchError::new("dns", "host resolved to no address"));
    }
    let allowed = |ip: IpAddr| address_allowed(ip, private_ok) || (address_allowed(ip, true) && within.iter().any(|c| c.contains(ip)));
    if let Some(bad) = addrs.iter().find(|a| !allowed(a.ip())) {
        return Err(FetchError::new("address", format!("address {} is not allowed", bad.ip())));
    }
    Ok(addrs)
}

async fn fetch_inner(url: &FetchUrl, private_ok: bool, within: &[crate::console_source::Cidr], max_bytes: usize, limits: Limits) -> Result<serde_json::Value, FetchError> {
    let addrs = resolve(url, private_ok, within, &limits).await?;
    let tls = tls_config()?;
    let mut last = FetchError::new("connect", "no address");
    let mut tcp = None;
    for a in &addrs {
        match tokio::time::timeout(limits.connect, tokio::net::TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                tcp = Some(s);
                break;
            }
            Ok(Err(e)) => last = FetchError::new("connect", e.to_string()),
            Err(_) => last = FetchError::new("timeout", "connect timed out"),
        }
    }
    let tcp = tcp.ok_or(last)?;
    let name = match &url.host {
        Host::Name(n) => ServerName::try_from(n.clone()).map_err(|e| FetchError::new("tls", e.to_string()))?,
        Host::Ip(ip) => ServerName::IpAddress((*ip).into()),
    };
    let stream = tokio_rustls::TlsConnector::from(tls).connect(name, tcp).await.map_err(|e| FetchError::new("tls", e.to_string()))?;
    let (mut send, conn) = hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(stream)).await.map_err(|e| FetchError::new("connect", e.to_string()))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = hyper::Request::get(url.path.as_str())
        .header(hyper::header::HOST, url.authority())
        .header(hyper::header::ACCEPT, "application/json")
        .header(hyper::header::USER_AGENT, "lucid-relay")
        .body(Empty::<Bytes>::new())
        .map_err(|e| url_err(&e.to_string()))?;
    let resp = send.send_request(req).await.map_err(|e| FetchError::new("connect", e.to_string()))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(FetchError::new("redirect", format!("status {} (redirects are not followed)", status.as_u16())));
    }
    if !status.is_success() {
        return Err(FetchError::new("status", format!("status {}", status.as_u16())));
    }
    if let Some(n) = resp.headers().get(hyper::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
        if n > max_bytes as u64 {
            return Err(FetchError::new("too-large", format!("body of {n} bytes exceeds {max_bytes}")));
        }
    }
    let mut body = resp.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| FetchError::new("connect", e.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > max_bytes {
                return Err(FetchError::new("too-large", format!("body exceeds {max_bytes} bytes")));
            }
            buf.extend_from_slice(&data);
        }
    }
    serde_json::from_slice(&buf).map_err(|e| FetchError::new("json", e.to_string()))
}

/// GET a JSON document under the section 8.1 rules.
pub async fn fetch_json(url: &FetchUrl, private_ok: bool, max_bytes: usize, limits: Limits) -> Result<serde_json::Value, FetchError> {
    tokio::time::timeout(limits.total, fetch_inner(url, private_ok, &[], max_bytes, limits)).await.map_err(|_| FetchError::new("timeout", "fetch timed out"))?
}

/// `fetch_json` for sync callers: runs on its own thread and runtime, so it is safe inside or outside a runtime.
pub fn fetch_json_blocking(url: &FetchUrl, private_ok: bool, max_bytes: usize, limits: Limits) -> Result<serde_json::Value, FetchError> {
    let url = url.clone();
    std::thread::Builder::new()
        .name("relay-fetch".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| FetchError::new("connect", e.to_string()))?;
            rt.block_on(fetch_json(&url, private_ok, max_bytes, limits))
        })
        .map_err(|e| FetchError::new("connect", e.to_string()))?
        .join()
        .unwrap_or_else(|_| Err(FetchError::new("connect", "fetch thread panicked")))
}

/// API-1d 7.13: `fetch_json_blocking` with private addresses refused except inside one of `within` (a partner card
/// under the client's `card.private_cidrs`: the partner, not the admin, controls the host's DNS). TLS name check
/// always on, redirects never followed.
pub fn fetch_json_within_blocking(url: &FetchUrl, within: &[crate::console_source::Cidr], max_bytes: usize, limits: Limits) -> Result<serde_json::Value, FetchError> {
    let (url, within) = (url.clone(), within.to_vec());
    std::thread::Builder::new()
        .name("relay-fetch".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| FetchError::new("connect", e.to_string()))?;
            rt.block_on(async { tokio::time::timeout(limits.total, fetch_inner(&url, false, &within, max_bytes, limits)).await.map_err(|_| FetchError::new("timeout", "fetch timed out"))? })
        })
        .map_err(|e| FetchError::new("connect", e.to_string()))?
        .join()
        .unwrap_or_else(|_| Err(FetchError::new("connect", "fetch thread panicked")))
}

/// Successful fetches keyed by fetch policy and normalized URL, kept for `max_age` (JWKS: one hour). The policy is
/// part of the key: a document fetched with `private_ok` (a private address allowed) is never served to a request
/// that does not allow private addresses, which must resolve and check the URL itself.
pub struct FetchCache {
    max_age: Duration,
    entries: Mutex<HashMap<(bool, String), (Instant, serde_json::Value)>>,
}

impl FetchCache {
    pub fn new(max_age: Duration) -> FetchCache {
        FetchCache { max_age, entries: Mutex::new(HashMap::new()) }
    }

    /// A fresh cached value fetched under the same policy, if any.
    pub fn get(&self, url: &FetchUrl, private_ok: bool) -> Option<serde_json::Value> {
        let m = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        m.get(&(private_ok, url.url.clone())).filter(|(at, _)| at.elapsed() < self.max_age).map(|(_, v)| v.clone())
    }

    /// Record a value fetched under `private_ok`.
    pub fn put(&self, url: &FetchUrl, private_ok: bool, value: serde_json::Value) {
        let mut m = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        m.retain(|_, (at, _)| at.elapsed() < self.max_age);
        m.insert((private_ok, url.url.clone()), (Instant::now(), value));
    }

    /// Cached value, or fetch and cache it (errors are not cached).
    pub fn fetch_json_blocking(&self, url: &FetchUrl, private_ok: bool, max_bytes: usize, limits: Limits) -> Result<serde_json::Value, FetchError> {
        if let Some(v) = self.get(url, private_ok) {
            return Ok(v);
        }
        let v = fetch_json_blocking(url, private_ok, max_bytes, limits)?;
        self.put(url, private_ok, v.clone());
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(u: &str) -> &'static str {
        check_url(u).unwrap_err().code
    }

    #[test]
    fn check_url_accepts() {
        let u = check_url("https://Login.Example.COM/a/b?x=1&y=2").unwrap();
        assert_eq!(u.host, Host::Name("login.example.com".into()));
        assert_eq!(u.port, 443);
        assert_eq!(u.path, "/a/b?x=1&y=2");
        assert_eq!(u.url, "https://login.example.com/a/b?x=1&y=2");
        let u = check_url("https://example.com").unwrap();
        assert_eq!(u.path, "/");
        let u = check_url("https://example.com:8443/jwks").unwrap();
        assert_eq!(u.port, 8443);
        assert_eq!(u.url, "https://example.com:8443/jwks");
        let u = check_url("https://example.com?q=1").unwrap();
        assert_eq!(u.path, "/?q=1");
    }

    #[test]
    fn check_url_ip_literals() {
        let u = check_url("https://8.8.8.8/x").unwrap();
        assert_eq!(u.host, Host::Ip("8.8.8.8".parse().unwrap()));
        let u = check_url("https://[2001:4860::1]:444/x").unwrap();
        assert_eq!(u.host, Host::Ip("2001:4860::1".parse().unwrap()));
        assert_eq!(u.port, 444);
        assert_eq!(u.url, "https://[2001:4860::1]:444/x");
        assert_eq!(code("https://[2001:4860::1/x"), "url");
        assert_eq!(code("https://[nope]/x"), "url");
        assert_eq!(code("https://0x7f.1/"), "url");
        assert_eq!(code("https://2130706433/"), "url");
        assert_eq!(code("https://127.1/"), "url");
    }

    #[test]
    fn check_url_refuses() {
        assert_eq!(code("http://example.com/"), "url");
        assert_eq!(code("ftp://example.com/"), "url");
        assert_eq!(code("https://user:pw@example.com/"), "url");
        assert_eq!(code("https://user@example.com/"), "url");
        assert_eq!(code("https://example.com/#frag"), "url");
        assert_eq!(code(&format!("https://example.com/{}", "a".repeat(600))), "url");
        assert_eq!(code("https://example.com:0/"), "url");
        assert_eq!(code("https://example.com:65536/"), "url");
        assert_eq!(code("https://example.com:abc/"), "url");
        assert_eq!(code("https://example.com:/"), "url");
        assert_eq!(code("https:///path"), "url");
        assert_eq!(code("https://exa mple.com/"), "url");
        assert_eq!(code("https://exa_mple.com/"), "url");
        assert_eq!(code("https://-bad.com/"), "url");
        assert_eq!(code("https://a..com/"), "url");
        assert_eq!(code("https://example.com\\@evil.com/"), "url");
    }

    #[test]
    fn address_allowed_matrix() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for s in ["127.0.0.1", "::1", "0.0.0.0", "::", "169.254.169.254", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "224.0.0.1", "255.255.255.255", "ff02::1"] {
            assert!(!address_allowed(ip(s), false), "{s} private_ok=false");
            assert!(!address_allowed(ip(s), true), "{s} private_ok=true");
        }
        for s in ["10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.1.1", "fd12::1", "::ffff:10.0.0.1"] {
            assert!(!address_allowed(ip(s), false), "{s} private_ok=false");
            assert!(address_allowed(ip(s), true), "{s} private_ok=true");
        }
        for s in ["8.8.8.8", "2001:4860::1", "100.128.0.1", "::ffff:8.8.8.8"] {
            assert!(address_allowed(ip(s), false), "{s}");
            assert!(address_allowed(ip(s), true), "{s}");
        }
    }

    #[test]
    fn fetch_refuses_loopback_before_connect() {
        let u = check_url("https://127.0.0.1:1/").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let e = rt.block_on(fetch_json(&u, true, 1024, Limits::default())).unwrap_err();
        assert_eq!(e.code, "address");
        let e = fetch_json_blocking(&u, false, 1024, Limits::default()).unwrap_err();
        assert_eq!(e.code, "address");
    }

    #[test]
    fn cache_respects_max_age() {
        let u = check_url("https://example.com/jwks").unwrap();
        let c = FetchCache::new(Duration::from_secs(3600));
        assert!(c.get(&u, false).is_none());
        c.put(&u, false, serde_json::json!({"keys": []}));
        assert_eq!(c.get(&u, false), Some(serde_json::json!({"keys": []})));
        let z = FetchCache::new(Duration::ZERO);
        z.put(&u, false, serde_json::json!(1));
        assert!(z.get(&u, false).is_none());
    }

    #[test]
    fn a_document_fetched_with_private_ok_never_serves_a_stricter_request() {
        let u = check_url("https://idp.internal.example/jwks").unwrap();
        let c = FetchCache::new(Duration::from_secs(3600));
        c.put(&u, true, serde_json::json!({"keys": [1]}));
        assert_eq!(c.get(&u, true), Some(serde_json::json!({"keys": [1]})));
        assert!(c.get(&u, false).is_none(), "a credential without private_ok must fetch and check the address itself");
    }
}
