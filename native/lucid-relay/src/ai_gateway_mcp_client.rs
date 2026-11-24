// Contract API-1 revision 6 sections 8.3 to 8.5 (slice API-1d6): the AI gateway's MCP 2026-07-28 client. Every
// request follows the 1a 8.1 URL rules (`api_fetch::check_url` and `address_allowed`): https only, every resolved
// address checked and the connection made to a checked address, private ranges only with the server's `private_ok`,
// no redirects, DNS 5 s, connect 5 s, request 30 s, bodies at most 256 KiB (discovery and `tools/list`) or
// `result_max` plus 16 KiB (`tools/call`). MCP servers are verified with the web PKI roots plus the server's own
// `auth.ca_pem`; the gateway's `backend_ca` does not apply. Issuer pinning (RFC 9728 then RFC 8414), the token request
// (OAuth client credentials with a JWT assertion or `tls_client_auth`), `server/discover` once per hour, `tools/list`
// per its `ttlMs` (at most one hour) and `tools/call`. Access tokens are cached per server until `exp - 60` and at
// most an hour, never shared across servers and never logged. The transport is a trait so tests use a fake server.

use crate::ai_gateway_mcp_cred::{jws, CredStore};
use crate::api_fetch::{address_allowed, check_url, Host};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub const PROTOCOL: &str = "2026-07-28";
pub const DISCOVERY_MAX: usize = 256 * 1024;
pub const RESULT_EXTRA: usize = 16 * 1024;
pub const DISCOVER_EVERY_MS: i64 = 3_600_000;
pub const TTL_MAX_MS: i64 = 3_600_000;
pub const TOKEN_MAX_S: i64 = 3600;
const DNS: Duration = Duration::from_secs(5);
const CONNECT: Duration = Duration::from_secs(5);
pub const REQUEST: Duration = Duration::from_secs(30);
const LIST_PAGES: usize = 8;
const OAUTH_EXTENSION: &str = "io.modelcontextprotocol/oauth-client-credentials";

// ── transport ────────────────────────────────────────────────────────────────────────────────────────────────

/// One outbound request.
#[derive(Clone)]
pub struct HttpReq {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub max_bytes: usize,
    pub private_ok: bool,
    /// Extra roots (PEM) besides the web PKI ("" for none).
    pub ca_pem: String,
    /// A TLS client certificate chain (leaf first, DER) and its PKCS#8 key.
    pub client: Option<(Vec<Vec<u8>>, Vec<u8>)>,
    pub timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct HttpResp {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Why a request failed: `mcp-url` for a 1a 8.1 refusal (URL, address, redirect), `error` otherwise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetError {
    pub code: &'static str,
    pub message: String,
}

impl NetError {
    fn url(m: impl Into<String>) -> NetError {
        NetError { code: "mcp-url", message: m.into() }
    }

    fn other(m: impl Into<String>) -> NetError {
        NetError { code: "error", message: m.into() }
    }
}

pub type Sent<'a> = Pin<Box<dyn Future<Output = Result<HttpResp, NetError>> + Send + 'a>>;

pub trait Transport: Send + Sync {
    fn send(&self, req: HttpReq) -> Sent<'_>;
}

/// The network under the 1a 8.1 rules.
pub struct Net;

impl Transport for Net {
    fn send(&self, req: HttpReq) -> Sent<'_> {
        Box::pin(async move {
            let limit = req.timeout;
            tokio::time::timeout(limit, send_checked(req)).await.map_err(|_| NetError::other("the request timed out"))?
        })
    }
}

fn tls(ca_pem: &str, client: Option<&(Vec<Vec<u8>>, Vec<u8>)>) -> Result<Arc<ClientConfig>, NetError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for (_, der) in crate::meet_x509::pem_blocks(ca_pem.as_bytes(), "CERTIFICATE") {
        roots.add(CertificateDer::from(der)).map_err(|e| NetError::other(format!("the server's ca_pem does not read: {e}")))?;
    }
    let b = ClientConfig::builder_with_provider(Arc::new(crate::server::provider())).with_safe_default_protocol_versions().map_err(|e| NetError::other(e.to_string()))?.with_root_certificates(roots);
    let cfg = match client {
        Some((chain, key)) => b
            .with_client_auth_cert(chain.iter().map(|c| CertificateDer::from(c.clone())).collect(), PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.clone())))
            .map_err(|e| NetError::other(format!("the client certificate cannot be used: {e}")))?,
        None => b.with_no_client_auth(),
    };
    Ok(Arc::new(cfg))
}

async fn send_checked(req: HttpReq) -> Result<HttpResp, NetError> {
    let url = check_url(&req.url).map_err(|e| NetError::url(e.message))?;
    let addrs: Vec<SocketAddr> = match &url.host {
        Host::Ip(ip) => vec![SocketAddr::new(*ip, url.port)],
        Host::Name(n) => tokio::time::timeout(DNS, tokio::net::lookup_host((n.as_str(), url.port)))
            .await
            .map_err(|_| NetError::other("DNS lookup timed out"))?
            .map_err(|e| NetError::other(format!("DNS: {e}")))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(NetError::other("the host resolved to no address"));
    }
    if let Some(bad) = addrs.iter().find(|a| !address_allowed(a.ip(), req.private_ok)) {
        return Err(NetError::url(format!("address {} is not allowed", bad.ip())));
    }
    let cfg = tls(&req.ca_pem, req.client.as_ref())?;
    let mut tcp = None;
    let mut last = NetError::other("no address answered");
    for a in &addrs {
        match tokio::time::timeout(CONNECT, tokio::net::TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                tcp = Some(s);
                break;
            }
            Ok(Err(e)) => last = NetError::other(format!("connect: {e}")),
            Err(_) => last = NetError::other("connect timed out"),
        }
    }
    let tcp = tcp.ok_or(last)?;
    let name = match &url.host {
        Host::Name(n) => ServerName::try_from(n.clone()).map_err(|e| NetError::other(e.to_string()))?,
        Host::Ip(ip) => ServerName::IpAddress((*ip).into()),
    };
    let stream = tokio_rustls::TlsConnector::from(cfg).connect(name, tcp).await.map_err(|e| NetError::other(format!("TLS: {e}")))?;
    let (mut send, conn) = hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(stream)).await.map_err(|e| NetError::other(e.to_string()))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let authority = &url.url["https://".len()..url.url.len() - url.path.len()];
    let mut r = hyper::Request::builder().method(req.method).uri(url.path.as_str()).header(hyper::header::HOST, authority).header(hyper::header::USER_AGENT, "lucid-ai-gateway");
    for (k, v) in &req.headers {
        r = r.header(k.as_str(), v.as_str());
    }
    let r = r.body(Full::new(Bytes::from(req.body))).map_err(|e| NetError::other(e.to_string()))?;
    let resp = send.send_request(r).await.map_err(|e| NetError::other(e.to_string()))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(NetError::url(format!("status {} (redirects are not followed)", status.as_u16())));
    }
    let content_type = resp.headers().get(hyper::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
    let mut body = resp.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| NetError::other(e.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > req.max_bytes {
                return Err(NetError::other(format!("the answer is larger than {} bytes", req.max_bytes)));
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(HttpResp { status: status.as_u16(), content_type, body: buf })
}

// ── one server, as the gateway uses it ──────────────────────────────────────────────────────────────────────

/// What the client needs of a server entry (after the journal).
#[derive(Clone, Debug, PartialEq)]
pub struct Conf {
    pub id: String,
    pub url: String,
    pub private_ok: bool,
    pub auth: Value,
}

impl Conf {
    pub fn auth_type(&self) -> &str {
        self.auth.get("type").and_then(Value::as_str).unwrap_or_default()
    }

    fn s(&self, k: &str) -> String {
        self.auth.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    fn ca(&self) -> String {
        self.s("ca_pem")
    }
}

/// A refusal or failure of one MCP step: `code` is an 8.10 code (`mcp-issuer`, `mcp-version`, `mcp-credential`,
/// `mcp-url`) or `error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

impl Fail {
    pub fn new(code: &'static str, message: impl Into<String>) -> Fail {
        Fail { code, message: message.into() }
    }
}

impl From<NetError> for Fail {
    fn from(e: NetError) -> Fail {
        Fail { code: e.code, message: e.message }
    }
}

/// A tool's result as the model is given it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallResult {
    pub text: String,
    pub error: bool,
    pub bytes: usize,
    pub cut: bool,
}

#[derive(Default)]
struct Cache {
    token_endpoint: Option<(String, i64)>,
    discovered: Option<(Vec<String>, i64)>,
    listing: Option<(Vec<Value>, i64)>,
    token: Option<(String, i64)>,
    next_id: u64,
}

pub struct Client {
    pub net: Arc<dyn Transport>,
    /// This gateway's principal (its `auth.kids` key).
    me: String,
    cache: Mutex<HashMap<String, Cache>>,
}

/// RFC 9728 3.1: the metadata URL of a resource `https://host[:port]/path` is
/// `https://host[:port]/.well-known/oauth-protected-resource/path`; RFC 8414 3.1 likewise for an issuer.
pub fn well_known(url: &str, suffix: &str) -> String {
    let rest = url.strip_prefix("https://").unwrap_or(url);
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let path = path.trim_end_matches('/');
    format!("https://{authority}/.well-known/{suffix}{path}")
}

fn form(pairs: &[(&str, String)]) -> Vec<u8> {
    pairs.iter().map(|(k, v)| format!("{k}={}", crate::ai_gateway_backend::uri_encode(v))).collect::<Vec<_>>().join("&").into_bytes()
}

/// The JSON-RPC response with `id` from a JSON body or a `text/event-stream` body.
fn rpc_answer(resp: &HttpResp, id: u64) -> Result<Value, Fail> {
    let parse = |b: &[u8]| serde_json::from_slice::<Value>(b).ok();
    let found = if resp.content_type.starts_with("text/event-stream") {
        let text = String::from_utf8_lossy(&resp.body);
        let mut data = String::new();
        let mut hit = None;
        for line in text.lines().chain(std::iter::once("")) {
            if let Some(d) = line.strip_prefix("data:") {
                data.push_str(d.strip_prefix(' ').unwrap_or(d));
                data.push('\n');
            } else if line.is_empty() && !data.is_empty() {
                if let Some(v) = parse(data.as_bytes()).filter(|v| v.get("id").and_then(Value::as_u64) == Some(id)) {
                    hit = Some(v);
                    break;
                }
                data.clear();
            }
        }
        hit
    } else {
        parse(&resp.body)
    };
    let v = found.ok_or_else(|| Fail::new("error", "the MCP server's answer is not a JSON-RPC response"))?;
    if let Some(e) = v.get("error") {
        return Err(Fail::new("error", format!("the MCP server answered error {}", e.get("code").and_then(Value::as_i64).unwrap_or(0))));
    }
    v.get("result").cloned().ok_or_else(|| Fail::new("error", "the MCP server's answer has no result"))
}

impl Client {
    pub fn new(net: Arc<dyn Transport>, me: &str) -> Client {
        Client { net, me: me.to_string(), cache: Mutex::new(HashMap::new()) }
    }

    /// Forget everything cached for a server (a new pin changed it, or a credential was dropped).
    pub fn forget(&self, server: &str) {
        self.cache.lock().remove(server);
    }

    #[allow(clippy::too_many_arguments)]
    fn req(&self, c: &Conf, method: &'static str, url: &str, headers: Vec<(String, String)>, body: Vec<u8>, max: usize, client: Option<(Vec<Vec<u8>>, Vec<u8>)>, limit: Duration) -> HttpReq {
        HttpReq { method, url: url.to_string(), headers, body, max_bytes: max, private_ok: c.private_ok, ca_pem: c.ca(), client, timeout: limit.min(REQUEST) }
    }

    async fn get_json(&self, c: &Conf, url: &str) -> Result<Value, Fail> {
        let r = self.net.send(self.req(c, "GET", url, vec![("accept".into(), "application/json".into())], Vec::new(), DISCOVERY_MAX, None, REQUEST)).await?;
        if r.status != 200 {
            return Err(Fail::new("mcp-issuer", format!("{url} answered {}", r.status)));
        }
        serde_json::from_slice(&r.body).map_err(|_| Fail::new("mcp-issuer", format!("{url} is not JSON")))
    }

    /// 8.4 issuer pinning: the server's RFC 9728 metadata names `url` as its resource and `issuer` among its
    /// authorization servers, and the issuer's RFC 8414 metadata carries exactly that issuer. The token endpoint.
    pub async fn token_endpoint(&self, c: &Conf, now_ms: i64) -> Result<String, Fail> {
        if let Some((t, at)) = self.cache.lock().get(&c.id).and_then(|x| x.token_endpoint.clone()) {
            if now_ms - at < DISCOVER_EVERY_MS {
                return Ok(t);
            }
        }
        let issuer = c.s("issuer");
        let prm = self.get_json(c, &well_known(&c.url, "oauth-protected-resource")).await?;
        let names_issuer = prm.get("authorization_servers").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(issuer.as_str())));
        if prm.get("resource").and_then(Value::as_str) != Some(c.url.as_str()) || !names_issuer {
            return Err(Fail::new("mcp-issuer", "the server's metadata does not name this resource and issuer"));
        }
        let asm = self.get_json(c, &well_known(&issuer, "oauth-authorization-server")).await?;
        if asm.get("issuer").and_then(Value::as_str) != Some(issuer.as_str()) {
            return Err(Fail::new("mcp-issuer", "the authorization server's metadata carries another issuer"));
        }
        let endpoint = asm.get("token_endpoint").and_then(Value::as_str).filter(|t| check_url(t).is_ok()).ok_or_else(|| Fail::new("mcp-issuer", "the authorization server names no usable token endpoint"))?;
        self.cache.lock().entry(c.id.clone()).or_default().token_endpoint = Some((endpoint.to_string(), now_ms));
        Ok(endpoint.to_string())
    }

    fn client_cert(&self, c: &Conf, creds: &CredStore) -> Result<Option<(Vec<Vec<u8>>, Vec<u8>)>, Fail> {
        match c.auth_type() {
            "oauth_mtls" | "mtls_only" => creds.client_cert(&c.id).map(|cc| Some((cc.chain, cc.pkcs8))).map_err(|e| Fail::new("mcp-credential", e)),
            _ => Ok(None),
        }
    }

    /// The access token for a server (None for `mtls_only`), from the cache while it lasts.
    pub async fn token(&self, c: &Conf, creds: &CredStore, now_ms: i64) -> Result<Option<String>, Fail> {
        if c.auth_type() == "mtls_only" {
            return Ok(None);
        }
        if let Some((t, until)) = self.cache.lock().get(&c.id).and_then(|x| x.token.clone()) {
            if now_ms < until {
                return Ok(Some(t));
            }
        }
        let endpoint = self.token_endpoint(c, now_ms).await?;
        let (issuer, client_id, scope) = (c.s("issuer"), c.s("client_id"), c.s("scope"));
        let mut fields: Vec<(&str, String)> = Vec::new();
        let mut client = None;
        if c.auth_type() == "oauth_private_key_jwt" {
            let kid = c.auth.get("kids").and_then(|k| k.get(&self.me)).and_then(Value::as_str).ok_or_else(|| Fail::new("mcp-credential", "this gateway has no kid for this server"))?;
            let pair = creds.signer(&c.id).map_err(|e| Fail::new("mcp-credential", e))?;
            let (h, claims) = crate::ai_mcp::assertion_parts(&issuer, &client_id, kid, now_ms / 1000, &crate::meet_json::token_hex(16));
            let assertion = jws(&pair, &h, &claims).map_err(|e| Fail::new("mcp-credential", e))?;
            fields = crate::ai_mcp::token_form(&assertion, &c.url, &scope);
        } else {
            client = self.client_cert(c, creds)?;
            fields.push(("grant_type", "client_credentials".into()));
            fields.push(("client_id", client_id));
            fields.push(("resource", c.url.clone()));
            fields.push(("scope", scope));
        }
        let headers = vec![("content-type".into(), "application/x-www-form-urlencoded".into()), ("accept".into(), "application/json".into())];
        let r = self.net.send(self.req(c, "POST", &endpoint, headers, form(&fields), DISCOVERY_MAX, client, REQUEST)).await?;
        let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        let token = v.get("access_token").and_then(Value::as_str).filter(|_| r.status == 200 && v.get("token_type").and_then(Value::as_str).is_some_and(|t| t.eq_ignore_ascii_case("bearer")));
        let token = token.ok_or_else(|| Fail::new("mcp-credential", format!("the token endpoint answered {}", r.status)))?.to_string();
        let life = v.get("expires_in").and_then(Value::as_i64).map_or(TOKEN_MAX_S, |e| (e - 60).min(TOKEN_MAX_S));
        if life > 0 {
            self.cache.lock().entry(c.id.clone()).or_default().token = Some((token.clone(), now_ms + life * 1000));
        }
        Ok(Some(token))
    }

    fn meta(c: &Conf) -> Value {
        let caps = if c.auth_type().starts_with("oauth_") { json!({"extensions": {OAUTH_EXTENSION: {}}}) } else { json!({}) };
        json!({
            "io.modelcontextprotocol/protocolVersion": PROTOCOL,
            "io.modelcontextprotocol/clientInfo": {"name": "lucid-ai-gateway", "version": env!("CARGO_PKG_VERSION")},
            "io.modelcontextprotocol/clientCapabilities": caps,
        })
    }

    /// One JSON-RPC call over Streamable HTTP (8.5).
    #[allow(clippy::too_many_arguments)]
    async fn rpc(&self, c: &Conf, creds: &CredStore, method: &str, mut params: Map<String, Value>, name: Option<&str>, max: usize, now_ms: i64, limit: Duration) -> Result<Value, Fail> {
        let token = self.token(c, creds, now_ms).await?;
        let client = self.client_cert(c, creds)?;
        let id = {
            let mut cache = self.cache.lock();
            let e = cache.entry(c.id.clone()).or_default();
            e.next_id += 1;
            e.next_id
        };
        params.insert("_meta".into(), Self::meta(c));
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string().into_bytes();
        let mut headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("accept".to_string(), "application/json, text/event-stream".to_string()),
            ("mcp-protocol-version".to_string(), PROTOCOL.to_string()),
            ("mcp-method".to_string(), method.to_string()),
        ];
        if let Some(n) = name {
            headers.push(("mcp-name".into(), n.into()));
        }
        if let Some(t) = &token {
            headers.push(("authorization".into(), format!("Bearer {t}")));
        }
        let r = self.net.send(self.req(c, "POST", &c.url, headers, body, max, client, limit)).await?;
        if r.status == 401 || r.status == 403 {
            if let Some(e) = self.cache.lock().get_mut(&c.id) {
                e.token = None;
            }
            return Err(Fail::new("mcp-credential", format!("the MCP server answered {}", r.status)));
        }
        if r.status != 200 {
            return Err(Fail::new("error", format!("the MCP server answered {}", r.status)));
        }
        rpc_answer(&r, id)
    }

    /// `server/discover`, once per hour: the versions the server supports; without 2026-07-28 it is not used.
    pub async fn discover(&self, c: &Conf, creds: &CredStore, now_ms: i64) -> Result<Vec<String>, Fail> {
        let cached = self.cache.lock().get(&c.id).and_then(|x| x.discovered.clone());
        let versions = match cached {
            Some((v, at)) if now_ms - at < DISCOVER_EVERY_MS => v,
            _ => {
                let r = self.rpc(c, creds, "server/discover", Map::new(), None, DISCOVERY_MAX, now_ms, REQUEST).await?;
                let v: Vec<String> = r.get("supportedVersions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                self.cache.lock().entry(c.id.clone()).or_default().discovered = Some((v.clone(), now_ms));
                v
            }
        };
        if !versions.iter().any(|v| v == PROTOCOL) {
            return Err(Fail::new("mcp-version", "the MCP server does not support 2026-07-28"));
        }
        Ok(versions)
    }

    /// When the server was last discovered (ms, 0 never) and the versions it named.
    pub fn discovered(&self, server: &str) -> (i64, Vec<String>) {
        self.cache.lock().get(server).and_then(|x| x.discovered.clone()).map(|(v, at)| (at, v)).unwrap_or_default()
    }

    /// `tools/list` (every page, at most 8), cached for its `ttlMs` (at most an hour).
    pub async fn list(&self, c: &Conf, creds: &CredStore, now_ms: i64) -> Result<Vec<Value>, Fail> {
        if let Some((tools, until)) = self.cache.lock().get(&c.id).and_then(|x| x.listing.clone()) {
            if now_ms < until {
                return Ok(tools);
            }
        }
        let mut tools: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut ttl = i64::MAX;
        for _ in 0..LIST_PAGES {
            let mut p = Map::new();
            if let Some(cur) = &cursor {
                p.insert("cursor".into(), json!(cur));
            }
            let r = self.rpc(c, creds, "tools/list", p, None, DISCOVERY_MAX, now_ms, REQUEST).await?;
            tools.extend(r.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
            ttl = ttl.min(r.get("ttlMs").and_then(Value::as_i64).unwrap_or(0).clamp(0, TTL_MAX_MS));
            cursor = r.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if ttl > 0 && ttl != i64::MAX {
            self.cache.lock().entry(c.id.clone()).or_default().listing = Some((tools.clone(), now_ms + ttl));
        }
        Ok(tools)
    }

    /// The cached listing, if any (the admin state route).
    pub fn listed(&self, server: &str) -> Vec<Value> {
        self.cache.lock().get(server).and_then(|x| x.listing.clone()).map(|(t, _)| t).unwrap_or_default()
    }

    /// `tools/call`: the result's text parts (structured content when there is no text), cut at `result_max`.
    #[allow(clippy::too_many_arguments)]
    pub async fn call(&self, c: &Conf, creds: &CredStore, tool: &str, args: Value, result_max: usize, now_ms: i64, limit: Duration) -> Result<CallResult, Fail> {
        let mut p = Map::new();
        p.insert("name".into(), json!(tool));
        p.insert("arguments".into(), args);
        let r = self.rpc(c, creds, "tools/call", p, Some(tool), result_max + RESULT_EXTRA, now_ms, limit).await?;
        let mut parts: Vec<String> = Vec::new();
        for item in r.get("content").and_then(Value::as_array).into_iter().flatten() {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => parts.push(item.get("text").and_then(Value::as_str).unwrap_or_default().to_string()),
                _ => parts.push("[content that is not text was left out]".into()),
            }
        }
        if parts.is_empty() {
            if let Some(s) = r.get("structuredContent") {
                parts.push(s.to_string());
            }
        }
        let mut text = parts.join("\n");
        let bytes = text.len();
        let cut = bytes > result_max;
        if cut {
            let mut end = result_max;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        Ok(CallResult { text, error: r.get("isError").and_then(Value::as_bool).unwrap_or(false), bytes, cut })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_urls_insert_the_suffix_before_the_path() {
        assert_eq!(well_known("https://mcp.acme.example/mcp", "oauth-protected-resource"), "https://mcp.acme.example/.well-known/oauth-protected-resource/mcp");
        assert_eq!(well_known("https://auth.acme.example", "oauth-authorization-server"), "https://auth.acme.example/.well-known/oauth-authorization-server");
        assert_eq!(well_known("https://auth.acme.example/", "oauth-authorization-server"), "https://auth.acme.example/.well-known/oauth-authorization-server");
        assert_eq!(well_known("https://h.example:8443/t/1", "oauth-authorization-server"), "https://h.example:8443/.well-known/oauth-authorization-server/t/1");
    }

    #[test]
    fn event_stream_answers_are_read_by_id() {
        let body = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\n\n".to_vec();
        let r = HttpResp { status: 200, content_type: "text/event-stream".into(), body };
        assert!(rpc_answer(&r, 3).is_err());
        let body = b"data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"ok\":true}}\n\n".to_vec();
        let r = HttpResp { status: 200, content_type: "text/event-stream".into(), body };
        assert_eq!(rpc_answer(&r, 3).unwrap(), json!({"ok": true}));
    }

    /// 8.3: a private address without `private_ok`, and a redirect, are refused before anything is sent.
    #[tokio::test]
    async fn the_network_refuses_private_addresses_and_plain_http() {
        let req = |url: &str, private_ok: bool| HttpReq { method: "GET", url: url.into(), headers: vec![], body: vec![], max_bytes: 1024, private_ok, ca_pem: String::new(), client: None, timeout: Duration::from_secs(5) };
        assert_eq!(Net.send(req("https://10.0.0.5/mcp", false)).await.unwrap_err().code, "mcp-url");
        assert_eq!(Net.send(req("https://127.0.0.1/mcp", true)).await.unwrap_err().code, "mcp-url");
        assert_eq!(Net.send(req("http://mcp.acme.example/mcp", false)).await.unwrap_err().code, "mcp-url");
    }
}
