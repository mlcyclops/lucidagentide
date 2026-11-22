// Export wire (API contract 11): the destination presets of 11.1, the bodies of 11.2 (OTLP/HTTP protobuf through
// `otlp_proto`, Splunk HEC events with indexer acknowledgment, Azure Monitor Logs Ingestion rows for `LucidAudit_CL`),
// and Lucid authenticating to the tool with the credentials of 11.3 (vendor tokens, mutual TLS, Entra certificate
// client credentials, a Google service account JWT grant, IAM Roles Anywhere then SigV4).
//
// Every connection follows 8.1: `api_fetch::check_url`, DNS resolved per connection, every address checked with the
// destination's `private_ok` (token endpoints never allow private addresses), the connection made to a checked address
// with SNI = host, redirects never followed, the whole request bounded (60 s exports, 30 s token endpoints) and answers
// read to at most 64 KiB. Credentials go only to the origin they belong to: the destination's configured endpoints
// carry the destination credential; the fixed token endpoints carry only their own assertions.
//
// Bodies are sent uncompressed (no gzip crate; the contract notes it). `syslog_cef` is not built here: the engine calls
// `fleet_syslog::cef_sink` for that kind (today's wire, unchanged).
//
// `Sink::deliver` blocks: every request of every destination runs on one shared export runtime (4 workers) with at
// most 64 requests in flight, and the calling thread waits for its answer, so callers use their own worker threads.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, RsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING, ECDSA_P256_SHA256_FIXED_SIGNING, RSA_PKCS1_SHA256};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Map, Value};

use crate::api_fetch::{self, FetchUrl, Host};
use crate::codec::{b64u, hex, iso_time, now_ms, sha256};
use crate::meet_json::{b64, civil, days_from_civil};
use crate::otlp_proto;

const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(60);
const TOKEN_TIMEOUT: Duration = Duration::from_secs(30);
/// 8.1: export answers are read to at most 64 KiB.
const RESPONSE_MAX: usize = 64 << 10;
/// Client assertions live five minutes; cached access tokens are replaced five minutes before they expire.
const ASSERTION_SECONDS: i64 = 300;
const REFRESH_MARGIN: i64 = 300;
const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const JWT_BEARER_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Cloud Monitoring, Cloud Logging and Cloud Trace writes (the Telemetry API OTLP endpoints take the same scopes).
const GCP_SCOPE: &str = "https://www.googleapis.com/auth/monitoring.write https://www.googleapis.com/auth/logging.write https://www.googleapis.com/auth/trace.append";
/// IAM Roles Anywhere session length asked for.
const SESSION_SECONDS: i64 = 3600;
const LOGS_API_VERSION: &str = "2023-01-01";
const DEFAULT_STREAM: &str = "Custom-LucidAudit_CL";
/// The Logs Ingestion API takes at most 1 MB a call.
const AZURE_CALL_MAX: usize = 1_000_000;
/// 11.1 `sourcetypes` defaults, by position: audit, relay logs, API logs, events (revision 3).
const DEFAULT_SOURCETYPES: [&str; 4] = ["lucid:audit", "lucid:relay", "lucid:api", "lucid:events"];
const ACK_POLL_FIRST: Duration = Duration::from_secs(1);
const ACK_POLL_MAX: Duration = Duration::from_secs(10);
/// How long a HEC batch waits for its indexer acknowledgment before the delivery is retried (at least once, 11.6).
const ACK_TIMEOUT: Duration = Duration::from_secs(120);

// ── Interface ───────────────────────────────────────────────────────────────────────────────────────────────

/// The signals of 11.1. Audit travels as OTLP logs, HEC events or `LucidAudit_CL` rows.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Signal {
    Metrics,
    Logs,
    Traces,
    Audit,
}

impl Signal {
    pub fn name(self) -> &'static str {
        match self {
            Signal::Metrics => "metrics",
            Signal::Logs => "logs",
            Signal::Traces => "traces",
            Signal::Audit => "audit",
        }
    }
}

/// One delivery: records of one signal, already transformed by the engine (allow-list, identities, ceiling), with the
/// 10.2 resource attributes. Record shapes:
/// - metric: `{"name": otel, "prom", "description"?, "kind": "gauge"|"sum", "unit", "temporality": "delta"|"cumulative",
///   "points": [{"t_ms", "start_ms"?, "v", "labels": {..}}]}`
/// - log or audit: `{"t_ms", "severity" (OTel SeverityNumber), "event", "body": {..}, "attributes": {"lucid.action",
///   "lucid.seq", "lucid.chain", "lucid.event_id", ..}}`
/// - span: `{"trace_id" (32 hex), "span_id" (16 hex), "parent_span_id"?, "name", "kind"?, "start_ms", "end_ms",
///   "status": "ok"|"error"|"unset", "status_message"?, "attributes": {..}}`
#[derive(Clone, Debug)]
pub struct Batch {
    pub signal: Signal,
    pub resource: Vec<(String, String)>,
    pub records: Vec<Value>,
}

impl Batch {
    fn resource_attr(&self, k: &str) -> Option<&str> {
        self.resource.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}

/// A destination credential (11.3), unsealed by the engine from `secret:<destination id>`.
#[derive(Clone)]
pub enum Credential {
    None,
    Token(String),
    Mtls { cert_pem: String, key_pem: String, ca_pem: Option<String> },
    EntraCertificate { tenant: String, client_id: String, cloud: String, cert_pem: String, key_pem: String },
    AwsRolesAnywhere { trust_anchor_arn: String, profile_arn: String, role_arn: String, region: String, cert_pem: String, key_pem: String },
    GcpServiceAccountKey(String),
}

impl Credential {
    /// The 11.3 `credential.type` (`none` for a destination without one).
    pub fn type_name(&self) -> &'static str {
        match self {
            Credential::None => "none",
            Credential::Token(_) => "token",
            Credential::Mtls { .. } => "mtls",
            Credential::EntraCertificate { .. } => "entra_certificate",
            Credential::AwsRolesAnywhere { .. } => "aws_roles_anywhere",
            Credential::GcpServiceAccountKey(_) => "gcp_service_account_key",
        }
    }
}

/// Never prints a secret.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::None => f.write_str("Credential::None"),
            Credential::EntraCertificate { tenant, client_id, cloud, .. } => {
                write!(f, "Credential::EntraCertificate {{ tenant: {tenant:?}, client_id: {client_id:?}, cloud: {cloud:?}, key: <sealed> }}")
            }
            Credential::AwsRolesAnywhere { trust_anchor_arn, profile_arn, role_arn, region, .. } => write!(
                f,
                "Credential::AwsRolesAnywhere {{ trust_anchor_arn: {trust_anchor_arn:?}, profile_arn: {profile_arn:?}, role_arn: {role_arn:?}, region: {region:?}, key: <sealed> }}"
            ),
            other => write!(f, "Credential::{} {{ <sealed> }}", other.type_name()),
        }
    }
}

/// Why a delivery failed. `retryable`: timeouts, connect errors, 408, 429, 5xx (the engine backs off and retries);
/// not retryable: other 4xx, an authentication failure after a fresh token, malformed configuration or records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SinkError {
    pub retryable: bool,
    pub code: &'static str,
    pub message: String,
}

impl SinkError {
    fn retry(code: &'static str, message: impl Into<String>) -> SinkError {
        SinkError { retryable: true, code, message: message.into() }
    }

    fn fatal(code: &'static str, message: impl Into<String>) -> SinkError {
        SinkError { retryable: false, code, message: message.into() }
    }
}

impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// A delivery target. `deliver` returns only once the tool accepted the batch (HEC: indexer-acknowledged).
pub trait Sink: Send + Sync {
    fn deliver(&self, batch: &Batch) -> Result<(), SinkError>;
}

// ── Presets (11.1, 11.3) ────────────────────────────────────────────────────────────────────────────────────

/// How a `token` credential is presented.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenStyle {
    /// `<name>: <prefix><token>`.
    Header { name: &'static str, prefix: &'static str },
    /// `Authorization: Basic base64(<token>)` for a token written `<instance id>:<access token>`; a token without `:` is
    /// taken as already encoded.
    Basic,
    /// The token is a path segment after the destination's `endpoint` (Sumo Logic OTLP/HTTP sources carry their
    /// token in the URL; the map holds only the part before it).
    Path,
}

#[derive(Debug)]
pub struct Preset {
    pub name: &'static str,
    /// `otlp`, `splunk_hec`, `azure_logs` or `syslog_cef`.
    pub kind: &'static str,
    /// Default OTLP sum temporality, `delta` or `cumulative` (non-otlp presets: `cumulative`, unused).
    pub temporality: &'static str,
    /// The 11.3 credential types accepted (`none`: no credential).
    pub credentials: &'static [&'static str],
    /// How a `token` credential is sent.
    pub token: Option<TokenStyle>,
    /// Vendor path suffixes appended to the destination's `endpoint` for metrics, logs (and audit), traces; empty: the
    /// signal needs `settings.endpoints.<signal>`. Presets never invent the customer's host.
    pub paths: [&'static str; 3],
    /// The Azure cloud or AWS partition the credential must name: `public`, `usgov`, or empty.
    pub cloud: &'static str,
}

const STD_PATHS: [&str; 3] = ["/v1/metrics", "/v1/logs", "/v1/traces"];
const NO_PATHS: [&str; 3] = ["", "", ""];
const TOKEN: &[&str] = &["token"];
const ENTRA: &[&str] = &["entra_certificate"];

const fn otlp(name: &'static str, temporality: &'static str, credentials: &'static [&'static str], token: Option<TokenStyle>, paths: [&'static str; 3], cloud: &'static str) -> Preset {
    Preset { name, kind: "otlp", temporality, credentials, token, paths, cloud }
}

const fn header(name: &'static str, prefix: &'static str) -> Option<TokenStyle> {
    Some(TokenStyle::Header { name, prefix })
}

/// Every preset of 11.1. Temporality defaults: Azure Monitor, Datadog, Dynatrace and New Relic take delta sums;
/// the others cumulative.
pub static PRESETS: [Preset; 19] = [
    otlp("azure_monitor", "delta", ENTRA, None, STD_PATHS, "public"),
    otlp("azure_monitor_gov", "delta", ENTRA, None, STD_PATHS, "usgov"),
    otlp("splunk_observability", "cumulative", TOKEN, header("X-SF-Token", ""), ["/v2/datapoint/otlp", "", "/v2/trace/otlp"], ""),
    otlp("datadog", "delta", TOKEN, header("DD-API-KEY", ""), STD_PATHS, ""),
    otlp("elastic", "cumulative", TOKEN, header("Authorization", "ApiKey "), STD_PATHS, ""),
    otlp("dynatrace", "delta", TOKEN, header("Authorization", "Api-Token "), STD_PATHS, ""),
    otlp("new_relic", "delta", TOKEN, header("api-key", ""), STD_PATHS, ""),
    otlp("grafana_cloud", "cumulative", TOKEN, Some(TokenStyle::Basic), STD_PATHS, ""),
    otlp("honeycomb", "cumulative", TOKEN, header("x-honeycomb-team", ""), STD_PATHS, ""),
    otlp("sumo_logic", "cumulative", TOKEN, Some(TokenStyle::Path), STD_PATHS, ""),
    otlp("cloudwatch", "cumulative", &["aws_roles_anywhere"], None, STD_PATHS, "public"),
    otlp("cloudwatch_gov", "cumulative", &["aws_roles_anywhere"], None, STD_PATHS, "usgov"),
    otlp("google_cloud", "cumulative", &["gcp_service_account_key"], None, STD_PATHS, ""),
    otlp("otlp_generic", "cumulative", &["mtls", "none"], None, STD_PATHS, ""),
    Preset { name: "splunk_hec", kind: "splunk_hec", temporality: "cumulative", credentials: TOKEN, token: header("Authorization", "Splunk "), paths: NO_PATHS, cloud: "" },
    Preset { name: "splunk_cloud_gov", kind: "splunk_hec", temporality: "cumulative", credentials: TOKEN, token: header("Authorization", "Splunk "), paths: NO_PATHS, cloud: "" },
    Preset { name: "sentinel", kind: "azure_logs", temporality: "cumulative", credentials: ENTRA, token: None, paths: NO_PATHS, cloud: "public" },
    Preset { name: "sentinel_gov", kind: "azure_logs", temporality: "cumulative", credentials: ENTRA, token: None, paths: NO_PATHS, cloud: "usgov" },
    Preset { name: "syslog_cef", kind: "syslog_cef", temporality: "cumulative", credentials: &["mtls", "none"], token: None, paths: NO_PATHS, cloud: "" },
];

pub fn preset(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

/// The sink for a destination map entry (2.2, 11.1) and its unsealed credential. Refuses (not retryable) a preset
/// that does not fit its kind, a credential its preset does not take (11.3), a credential naming the other cloud, a bad
/// endpoint, and `syslog_cef` (built by `fleet_syslog::cef_sink`).
pub fn sink_for(destination: &Value, credential: Credential) -> Result<Box<dyn Sink>, SinkError> {
    let private_ok = destination.get("private_ok").and_then(Value::as_bool).unwrap_or(false);
    let tls = match &credential {
        Credential::Mtls { cert_pem, key_pem, ca_pem } => tls_mtls(cert_pem, key_pem, ca_pem.as_deref())?,
        _ => tls_default()?,
    };
    let net: Arc<dyn Transport> = Arc::new(NetTransport { tls, private_ok, total: EXPORT_TIMEOUT });
    let idp: Arc<dyn Transport> = Arc::new(NetTransport { tls: tls_default()?, private_ok: false, total: TOKEN_TIMEOUT });
    build(destination, credential, net, idp)
}

fn build(dest: &Value, credential: Credential, net: Arc<dyn Transport>, idp: Arc<dyn Transport>) -> Result<Box<dyn Sink>, SinkError> {
    let kind = dest.get("kind").and_then(Value::as_str).unwrap_or_default();
    let name = dest.get("preset").and_then(Value::as_str).unwrap_or_default();
    let p = preset(name).filter(|p| p.kind == kind).ok_or_else(|| SinkError::fatal("config", format!("the preset {name:?} is not one of kind {kind:?}")))?;
    if !p.credentials.contains(&credential.type_name()) {
        return Err(SinkError::fatal("config", format!("the preset {name} does not take a {} credential", credential.type_name())));
    }
    match &credential {
        Credential::EntraCertificate { cloud, .. } if cloud != p.cloud => {
            return Err(SinkError::fatal("config", format!("the preset {name} needs an Entra credential of cloud {}", p.cloud)));
        }
        Credential::AwsRolesAnywhere { region, .. } if region.starts_with("us-gov-") != (p.cloud == "usgov") => {
            return Err(SinkError::fatal("config", format!("the region {region} does not fit the preset {name}")));
        }
        _ => {}
    }
    match kind {
        "otlp" => Ok(Box::new(OtlpSink::new(dest, p, credential, net, idp)?)),
        "splunk_hec" => Ok(Box::new(HecSink::new(dest, credential, net)?)),
        "azure_logs" => Ok(Box::new(AzureLogsSink::new(dest, credential, net, idp)?)),
        _ => Err(SinkError::fatal("config", "syslog_cef destinations are delivered by fleet_syslog::cef_sink")),
    }
}

// ── HTTP under 8.1 ──────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Request {
    method: &'static str,
    url: String,
    headers: Vec<(String, String)>,
    body: Bytes,
}

impl Request {
    fn post(url: impl Into<String>, content_type: &str, body: impl Into<Bytes>) -> Request {
        Request { method: "POST", url: url.into(), headers: vec![("Content-Type".into(), content_type.into())], body: body.into() }
    }

    #[cfg(test)]
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

#[derive(Clone, Debug, Default)]
struct Response {
    status: u16,
    body: Vec<u8>,
}

/// One request and its whole (capped) answer.
trait Transport: Send + Sync {
    fn send(&self, req: &Request) -> Result<Response, SinkError>;
}

/// The network transport: 8.1 on every request.
struct NetTransport {
    tls: Arc<ClientConfig>,
    private_ok: bool,
    total: Duration,
}

impl Transport for NetTransport {
    fn send(&self, req: &Request) -> Result<Response, SinkError> {
        let url = api_fetch::check_url(&req.url).map_err(|e| SinkError::fatal("config", format!("the URL is refused ({e})")))?;
        let (tls, private_ok, total, req) = (self.tls.clone(), self.private_ok, self.total, req.clone());
        pooled(async move {
            tokio::time::timeout(total, exchange(&url, &req, tls, private_ok))
                .await
                .unwrap_or_else(|_| Err(SinkError::retry("timeout", format!("no answer within {} seconds", total.as_secs()))))
        })
    }
}

/// Worker threads of the shared export runtime.
const EXPORT_WORKERS: usize = 4;
/// Export and token requests in flight at once, over all destinations (up to 2048 may be configured).
const EXPORT_IN_FLIGHT: usize = 64;

struct Pool {
    rt: tokio::runtime::Runtime,
    slots: Arc<tokio::sync::Semaphore>,
}

static POOL: LazyLock<Result<Pool, String>> = LazyLock::new(|| {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(EXPORT_WORKERS).thread_name("relay-export").enable_all().build().map_err(|e| e.to_string())?;
    Ok(Pool { rt, slots: Arc::new(tokio::sync::Semaphore::new(EXPORT_IN_FLIGHT)) })
});

/// Run one request on the shared export runtime, at most `EXPORT_IN_FLIGHT` at once (a request waits for a slot
/// before its own timeouts start), and block the caller until it ends. The caller waits on a channel, never
/// `block_on`, so this is safe from any thread; inside an async task it would hold that task's worker, so the
/// engine calls `deliver` from its own worker threads.
fn pooled<T: Send + 'static>(work: impl Future<Output = Result<T, SinkError>> + Send + 'static) -> Result<T, SinkError> {
    let pool = POOL.as_ref().map_err(|e| SinkError::retry("connect", format!("the export runtime did not start ({e})")))?;
    let slots = pool.slots.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    pool.rt.spawn(async move {
        let out = match slots.acquire_owned().await {
            Ok(_slot) => work.await,
            Err(_) => Err(SinkError::retry("connect", "the export runtime is closing")),
        };
        let _ = tx.send(out);
    });
    rx.recv().unwrap_or_else(|_| Err(SinkError::retry("connect", "the export request ended without an answer")))
}

/// The `Host` header value (and SigV4's `host`): the host, with the port when not 443.
fn authority(url: &FetchUrl) -> String {
    let host = match &url.host {
        Host::Name(n) => n.clone(),
        Host::Ip(std::net::IpAddr::V4(a)) => a.to_string(),
        Host::Ip(std::net::IpAddr::V6(a)) => format!("[{a}]"),
    };
    if url.port == 443 {
        host
    } else {
        format!("{host}:{}", url.port)
    }
}

fn checked(url: &str) -> Result<FetchUrl, SinkError> {
    api_fetch::check_url(url).map_err(|e| SinkError::fatal("config", format!("the URL {url} is refused ({e})")))
}

async fn exchange(url: &FetchUrl, req: &Request, tls: Arc<ClientConfig>, private_ok: bool) -> Result<Response, SinkError> {
    let addrs: Vec<SocketAddr> = match &url.host {
        Host::Ip(ip) => vec![SocketAddr::new(*ip, url.port)],
        Host::Name(n) => tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((n.as_str(), url.port)))
            .await
            .map_err(|_| SinkError::retry("timeout", "the DNS lookup timed out"))?
            .map_err(|e| SinkError::retry("dns", format!("the host did not resolve ({e})")))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(SinkError::retry("dns", "the host resolved to no address"));
    }
    if let Some(bad) = addrs.iter().find(|a| !api_fetch::address_allowed(a.ip(), private_ok)) {
        return Err(SinkError::fatal("address", format!("the address {} is not allowed (contract 8.1)", bad.ip())));
    }
    let mut last = SinkError::retry("connect", "no address answered");
    let mut tcp = None;
    for a in &addrs {
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                tcp = Some(s);
                break;
            }
            Ok(Err(e)) => last = SinkError::retry("connect", format!("the connection failed ({e})")),
            Err(_) => last = SinkError::retry("timeout", "the connection timed out"),
        }
    }
    let tcp = tcp.ok_or(last)?;
    let name = match &url.host {
        Host::Name(n) => ServerName::try_from(n.clone()).map_err(|e| SinkError::fatal("config", e.to_string()))?,
        Host::Ip(ip) => ServerName::IpAddress((*ip).into()),
    };
    let stream = tokio_rustls::TlsConnector::from(tls).connect(name, tcp).await.map_err(|e| SinkError::retry("tls", format!("the TLS handshake failed ({e})")))?;
    let (mut send, conn) = hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(stream)).await.map_err(|e| SinkError::retry("connect", e.to_string()))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let mut b = hyper::Request::builder()
        .method(req.method)
        .uri(url.path.as_str())
        .header(hyper::header::HOST, authority(url))
        .header(hyper::header::USER_AGENT, "lucid-relay");
    for (k, v) in &req.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let r = b.body(Full::new(req.body.clone())).map_err(|e| SinkError::fatal("config", format!("the request does not build ({e})")))?;
    let resp = send.send_request(r).await.map_err(|e| SinkError::retry("connect", format!("the request failed ({e})")))?;
    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    let mut buf = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| SinkError::retry("connect", e.to_string()))?;
        if let Ok(data) = frame.into_data() {
            let room = RESPONSE_MAX - buf.len();
            buf.extend_from_slice(&data[..data.len().min(room)]);
            if buf.len() >= RESPONSE_MAX {
                break;
            }
        }
    }
    Ok(Response { status, body: buf })
}

fn tls_default() -> Result<Arc<ClientConfig>, SinkError> {
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
    CFG.clone().map_err(|e| SinkError::fatal("tls", e))
}

fn pem_certs(pem: &str, what: &str) -> Result<Vec<CertificateDer<'static>>, SinkError> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut pem.as_bytes()).collect::<Result<_, _>>().map_err(|_| SinkError::fatal("config", format!("the {what} does not read")))?;
    if certs.is_empty() {
        return Err(SinkError::fatal("config", format!("the {what} holds no PEM certificate")));
    }
    Ok(certs)
}

/// Mutual TLS (`otlp_generic`): the client certificate and key, the collector checked against `ca_pem` or the webpki
/// roots.
fn tls_mtls(cert_pem: &str, key_pem: &str, ca_pem: Option<&str>) -> Result<Arc<ClientConfig>, SinkError> {
    let certs = pem_certs(cert_pem, "client certificate")?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).ok().flatten().ok_or_else(|| SinkError::fatal("config", "the client key is not a PEM private key"))?;
    let mut roots = RootCertStore::empty();
    match ca_pem {
        Some(pem) => {
            for c in pem_certs(pem, "certificate authority")? {
                roots.add(c).map_err(|e| SinkError::fatal("config", format!("the certificate authority cannot be used ({e})")))?;
            }
        }
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
    }
    let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| SinkError::fatal("tls", e.to_string()))?
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| SinkError::fatal("config", format!("the client certificate and key do not fit ({e})")))?;
    Ok(Arc::new(cfg))
}

/// The 2xx check: 3xx is a failure (8.1), 401 and 403 are `auth`, 408, 429 and 5xx retryable, other 4xx not.
fn check_status(status: u16, body: &[u8], what: &str) -> Result<(), SinkError> {
    let said: String = String::from_utf8_lossy(&body[..body.len().min(200)]).chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let said = said.trim();
    let message = if said.is_empty() { format!("{what} answered {status}") } else { format!("{what} answered {status}: {said}") };
    match status {
        200..=299 => Ok(()),
        300..=399 => Err(SinkError::fatal("redirect", format!("{message} (redirects are not followed)"))),
        401 | 403 => Err(SinkError::fatal("auth", message)),
        408 | 429 | 500..=599 => Err(SinkError::retry("status", message)),
        _ => Err(SinkError::fatal("rejected", message)),
    }
}

// ── Encodings and keys ──────────────────────────────────────────────────────────────────────────────────────

/// RFC 3986 percent-encoding of everything but the unreserved characters (SigV4's UriEncode, form values).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs.iter().map(|(k, v)| format!("{}={}", pct(k), pct(v))).collect::<Vec<_>>().join("&").into_bytes()
}

/// A random version 4 UUID (assertion `jti`, HEC channel).
fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = aws_lc_rs::rand::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// `20150830T123600Z` (SigV4 `X-Amz-Date`).
fn amz_date(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` (or `+00:00`) to Unix seconds.
fn parse_iso_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse::<i64>().ok());
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    if !(rest == "Z" || rest == "+00:00") || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    Some(days_from_civil(y, mo as u32, d as u32) * 86_400 + h * 3600 + mi * 60 + se)
}

/// A signing key from PEM (PKCS#8, PKCS#1 RSA or SEC1 P-256), on AWS-LC.
enum SigningKey {
    Rsa(RsaKeyPair),
    P256 { fixed: EcdsaKeyPair, asn1: EcdsaKeyPair },
}

impl SigningKey {
    fn from_pem(pem: &str) -> Result<SigningKey, SinkError> {
        let bad = || SinkError::fatal("config", "the private key is not an RSA (2048 bits or more) or EC P-256 PEM key");
        let key = rustls_pemfile::private_key(&mut pem.as_bytes()).ok().flatten().ok_or_else(bad)?;
        let k = match &key {
            PrivateKeyDer::Pkcs8(k) => match RsaKeyPair::from_pkcs8(k.secret_pkcs8_der()) {
                Ok(r) => SigningKey::Rsa(r),
                Err(_) => SigningKey::P256 {
                    fixed: EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, k.secret_pkcs8_der()).map_err(|_| bad())?,
                    asn1: EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, k.secret_pkcs8_der()).map_err(|_| bad())?,
                },
            },
            PrivateKeyDer::Pkcs1(k) => SigningKey::Rsa(RsaKeyPair::from_der(k.secret_pkcs1_der()).map_err(|_| bad())?),
            PrivateKeyDer::Sec1(k) => SigningKey::P256 {
                fixed: EcdsaKeyPair::from_private_key_der(&ECDSA_P256_SHA256_FIXED_SIGNING, k.secret_sec1_der()).map_err(|_| bad())?,
                asn1: EcdsaKeyPair::from_private_key_der(&ECDSA_P256_SHA256_ASN1_SIGNING, k.secret_sec1_der()).map_err(|_| bad())?,
            },
            _ => return Err(bad()),
        };
        if let SigningKey::Rsa(r) = &k {
            if r.public_modulus_len() < 256 {
                return Err(bad());
            }
        }
        Ok(k)
    }

    /// The JWS `alg`: RS256 (RSASSA-PKCS1-v1_5, as the console's Graph assertion) or ES256.
    fn jwt_alg(&self) -> &'static str {
        match self {
            SigningKey::Rsa(_) => "RS256",
            SigningKey::P256 { .. } => "ES256",
        }
    }

    /// The IAM Roles Anywhere signing algorithm.
    fn x509_alg(&self) -> &'static str {
        match self {
            SigningKey::Rsa(_) => "AWS4-X509-RSA-SHA256",
            SigningKey::P256 { .. } => "AWS4-X509-ECDSA-SHA256",
        }
    }

    fn sign_rsa(r: &RsaKeyPair, msg: &[u8]) -> Result<Vec<u8>, SinkError> {
        let mut sig = vec![0u8; r.public_modulus_len()];
        r.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), msg, &mut sig).map_err(|_| SinkError::fatal("config", "the key could not sign"))?;
        Ok(sig)
    }

    /// JWS signature: RSA PKCS#1 v1.5 SHA-256, or ECDSA P-256 SHA-256 as fixed `r || s`.
    fn sign_jwt(&self, msg: &[u8]) -> Result<Vec<u8>, SinkError> {
        match self {
            SigningKey::Rsa(r) => SigningKey::sign_rsa(r, msg),
            SigningKey::P256 { fixed, .. } => fixed.sign(&SystemRandom::new(), msg).map(|s| s.as_ref().to_vec()).map_err(|_| SinkError::fatal("config", "the key could not sign")),
        }
    }

    /// Roles Anywhere signature: RSA PKCS#1 v1.5 SHA-256, or ECDSA P-256 SHA-256 DER.
    fn sign_x509(&self, msg: &[u8]) -> Result<Vec<u8>, SinkError> {
        match self {
            SigningKey::Rsa(r) => SigningKey::sign_rsa(r, msg),
            SigningKey::P256 { asn1, .. } => asn1.sign(&SystemRandom::new(), msg).map(|s| s.as_ref().to_vec()).map_err(|_| SinkError::fatal("config", "the key could not sign")),
        }
    }
}

fn jwt(key: &SigningKey, header: &Value, claims: &Value) -> Result<String, SinkError> {
    let input = format!("{}.{}", b64u(header.to_string().as_bytes()), b64u(claims.to_string().as_bytes()));
    let sig = key.sign_jwt(input.as_bytes())?;
    Ok(format!("{input}.{}", b64u(&sig)))
}

/// The first certificate of a PEM text, DER.
fn cert_der(pem: &str) -> Result<Vec<u8>, SinkError> {
    Ok(pem_certs(pem, "certificate")?.swap_remove(0).as_ref().to_vec())
}

/// The serial number of a DER certificate, in decimal (Roles Anywhere's `Credential=`).
fn cert_serial_decimal(der: &[u8]) -> Option<String> {
    let cert = crate::der::tlv(der).filter(|t| t.tag == 0x30)?;
    let tbs = crate::der::tlv(cert.value).filter(|t| t.tag == 0x30)?;
    let mut f = crate::der::tlv(tbs.value)?;
    if f.tag == 0xa0 {
        f = crate::der::tlv(f.rest)?;
    }
    if f.tag != 0x02 || f.value.is_empty() {
        return None;
    }
    // Base-10 digits, least significant first.
    let mut digits: Vec<u8> = Vec::new();
    for &byte in f.value {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            let x = *d as u32 * 256 + carry;
            *d = (x % 10) as u8;
            carry = x / 10;
        }
        while carry > 0 {
            digits.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    if digits.is_empty() {
        return Some("0".into());
    }
    Some(digits.iter().rev().map(|d| (b'0' + d) as char).collect())
}

fn ascii_id(s: &str, what: &str) -> Result<(), SinkError> {
    if (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_')) {
        Ok(())
    } else {
        Err(SinkError::fatal("config", format!("the {what} is not a plain identifier")))
    }
}

/// A header value with no control characters (a token never splits a header).
fn header_safe(s: &str, what: &str) -> Result<(), SinkError> {
    if !s.is_empty() && s.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        Ok(())
    } else {
        Err(SinkError::fatal("config", format!("the {what} holds characters a header cannot carry")))
    }
}

// ── OAuth tokens and AWS sessions ───────────────────────────────────────────────────────────────────────────

/// An access token and its expiry (Unix seconds), replaced five minutes before it expires or when asked fresh.
#[derive(Default)]
struct TokenCache(Mutex<Option<(String, i64)>>);

impl TokenCache {
    fn get(&self, fresh: bool, now: i64, fetch: impl FnOnce() -> Result<(String, i64), SinkError>) -> Result<String, SinkError> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !fresh {
            if let Some((t, exp)) = &*g {
                if now < exp - REFRESH_MARGIN {
                    return Ok(t.clone());
                }
            }
        }
        let (t, exp) = fetch()?;
        *g = Some((t.clone(), exp));
        Ok(t)
    }
}

/// POST a token request form; `access_token` and `expires_in` (number or string) from the answer.
fn oauth_token(idp: &dyn Transport, url: &str, body: Vec<u8>, now: i64) -> Result<(String, i64), SinkError> {
    let r = idp.send(&Request::post(url, "application/x-www-form-urlencoded", body))?;
    if let Err(mut e) = check_status(r.status, &r.body, "the token endpoint") {
        if e.code == "rejected" {
            // invalid_client, invalid_grant, unauthorized_client: the credential, not the batch
            e.code = "auth";
        }
        return Err(e);
    }
    let v: Value = serde_json::from_slice(&r.body).map_err(|_| SinkError::retry("token", "the token endpoint answered no JSON"))?;
    let token = v.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_graphic())).ok_or_else(|| SinkError::retry("token", "the token endpoint answered no access_token"))?;
    let life = match v.get("expires_in") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
    .unwrap_or(3600);
    Ok((token.to_owned(), now + life))
}

/// Entra ID client credentials with a certificate assertion (Azure Monitor, Sentinel).
struct EntraAuth {
    tenant: String,
    client_id: String,
    gov: bool,
    key: SigningKey,
    x5t: String,
    idp: Arc<dyn Transport>,
    cache: TokenCache,
}

impl EntraAuth {
    fn new(credential: &Credential, idp: Arc<dyn Transport>) -> Result<EntraAuth, SinkError> {
        let Credential::EntraCertificate { tenant, client_id, cloud, cert_pem, key_pem } = credential else {
            return Err(SinkError::fatal("config", "an Entra certificate credential is needed"));
        };
        ascii_id(tenant, "tenant")?;
        ascii_id(client_id, "client id")?;
        let gov = match cloud.as_str() {
            "public" => false,
            "usgov" => true,
            _ => return Err(SinkError::fatal("config", "the Entra cloud must be public or usgov")),
        };
        Ok(EntraAuth { tenant: tenant.clone(), client_id: client_id.clone(), gov, key: SigningKey::from_pem(key_pem)?, x5t: b64u(&sha256(&cert_der(cert_pem)?)), idp, cache: TokenCache::default() })
    }

    fn token_url(&self) -> String {
        format!("https://{}/{}/oauth2/v2.0/token", if self.gov { "login.microsoftonline.us" } else { "login.microsoftonline.com" }, self.tenant)
    }

    fn scope(&self) -> &'static str {
        if self.gov {
            "https://monitor.azure.us/.default"
        } else {
            "https://monitor.azure.com/.default"
        }
    }

    /// Header {alg, typ, x5t#S256 (SHA-256 of the certificate DER)}; claims {aud (the token endpoint), iss = sub =
    /// client id, jti, nbf, iat, exp (5 minutes)}.
    fn assertion(&self, now: i64) -> Result<String, SinkError> {
        let header = json!({"alg": self.key.jwt_alg(), "typ": "JWT", "x5t#S256": self.x5t});
        let claims = json!({"aud": self.token_url(), "iss": self.client_id, "sub": self.client_id, "jti": uuid(), "nbf": now, "iat": now, "exp": now + ASSERTION_SECONDS});
        jwt(&self.key, &header, &claims)
    }

    fn bearer(&self, fresh: bool) -> Result<String, SinkError> {
        let now = now_ms().div_euclid(1000);
        self.cache.get(fresh, now, || {
            let a = self.assertion(now)?;
            let body = form(&[
                ("client_id", self.client_id.as_str()),
                ("scope", self.scope()),
                ("grant_type", "client_credentials"),
                ("client_assertion_type", ASSERTION_TYPE),
                ("client_assertion", a.as_str()),
            ]);
            oauth_token(&*self.idp, &self.token_url(), body, now)
        })
    }
}

/// Google OAuth 2.0 JWT bearer grant with a service account key (RS256).
struct GcpAuth {
    email: String,
    key_id: String,
    project: Option<String>,
    key: SigningKey,
    idp: Arc<dyn Transport>,
    cache: TokenCache,
}

impl GcpAuth {
    fn new(key_json: &str, idp: Arc<dyn Transport>) -> Result<GcpAuth, SinkError> {
        let bad = |m: &str| SinkError::fatal("config", format!("the service account key {m}"));
        let v: Value = serde_json::from_str(key_json).map_err(|_| bad("is not JSON"))?;
        if v.get("type").and_then(Value::as_str) != Some("service_account") {
            return Err(bad("is not of type service_account"));
        }
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
        let email = s("client_email").ok_or_else(|| bad("has no client_email"))?;
        header_safe(email, "client_email")?;
        let key = SigningKey::from_pem(s("private_key").ok_or_else(|| bad("has no private_key"))?)?;
        if !matches!(key, SigningKey::Rsa(_)) {
            return Err(bad("is not an RSA key"));
        }
        let project = s("project_id").map(str::to_owned);
        if let Some(p) = &project {
            ascii_id(p, "project id")?;
        }
        Ok(GcpAuth { email: email.to_owned(), key_id: s("private_key_id").unwrap_or_default().to_owned(), project, key, idp, cache: TokenCache::default() })
    }

    /// Header {alg RS256, typ, kid}; claims {iss (the account), scope, aud (Google's token endpoint), iat, exp (5
    /// minutes)}. The key's own `token_uri` is not followed: the endpoint is fixed.
    fn assertion(&self, now: i64) -> Result<String, SinkError> {
        let header = json!({"alg": "RS256", "typ": "JWT", "kid": self.key_id});
        let claims = json!({"iss": self.email, "scope": GCP_SCOPE, "aud": GOOGLE_TOKEN_URL, "iat": now, "exp": now + ASSERTION_SECONDS});
        jwt(&self.key, &header, &claims)
    }

    fn bearer(&self, fresh: bool) -> Result<String, SinkError> {
        let now = now_ms().div_euclid(1000);
        self.cache.get(fresh, now, || {
            let a = self.assertion(now)?;
            oauth_token(&*self.idp, GOOGLE_TOKEN_URL, form(&[("grant_type", JWT_BEARER_GRANT), ("assertion", a.as_str())]), now)
        })
    }
}

#[derive(Clone)]
struct AwsCreds {
    access_key: String,
    secret: String,
    token: String,
    exp: i64,
}

/// IAM Roles Anywhere: CreateSession signed with the X.509 key, then SigV4 with the session credentials.
struct AwsAuth {
    region: String,
    trust_anchor_arn: String,
    profile_arn: String,
    role_arn: String,
    cert_der: Vec<u8>,
    serial: String,
    key: SigningKey,
    idp: Arc<dyn Transport>,
    cache: Mutex<Option<AwsCreds>>,
}

impl AwsAuth {
    fn new(credential: &Credential, idp: Arc<dyn Transport>) -> Result<AwsAuth, SinkError> {
        let Credential::AwsRolesAnywhere { trust_anchor_arn, profile_arn, role_arn, region, cert_pem, key_pem } = credential else {
            return Err(SinkError::fatal("config", "a Roles Anywhere credential is needed"));
        };
        if region.is_empty() || region.len() > 32 || !region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(SinkError::fatal("config", "the AWS region is not valid"));
        }
        for (arn, what) in [(trust_anchor_arn, "trust anchor ARN"), (profile_arn, "profile ARN"), (role_arn, "role ARN")] {
            if !arn.starts_with("arn:") {
                return Err(SinkError::fatal("config", format!("the {what} is not an ARN")));
            }
        }
        let cert_der = cert_der(cert_pem)?;
        let serial = cert_serial_decimal(&cert_der).ok_or_else(|| SinkError::fatal("config", "the certificate's serial number does not read"))?;
        Ok(AwsAuth {
            region: region.clone(),
            trust_anchor_arn: trust_anchor_arn.clone(),
            profile_arn: profile_arn.clone(),
            role_arn: role_arn.clone(),
            cert_der,
            serial,
            key: SigningKey::from_pem(key_pem)?,
            idp,
            cache: Mutex::new(None),
        })
    }

    /// `POST https://rolesanywhere.<region>.amazonaws.com/sessions`, signed per the Roles Anywhere signing process:
    /// headers `X-Amz-Date` and `X-Amz-X509` (base64 DER of the certificate), the SigV4 canonical request, the string to
    /// sign under `AWS4-X509-RSA-SHA256` or `AWS4-X509-ECDSA-SHA256` and scope `<date>/<region>/rolesanywhere/aws4_request`,
    /// signed by the certificate's key, `Credential=<serial in decimal>/<scope>`.
    fn session_request(&self, now_ms: i64) -> Result<Request, SinkError> {
        let body = json!({"durationSeconds": SESSION_SECONDS, "profileArn": self.profile_arn, "roleArn": self.role_arn, "trustAnchorArn": self.trust_anchor_arn});
        let mut req = Request::post(format!("https://rolesanywhere.{}.amazonaws.com/sessions", self.region), "application/json", body.to_string());
        let amz = amz_date(now_ms);
        req.headers.push(("X-Amz-Date".into(), amz.clone()));
        req.headers.push(("X-Amz-X509".into(), b64(&self.cert_der)));
        let (creq, signed) = canonical_request(&req)?;
        let alg = self.key.x509_alg();
        let scope = format!("{}/{}/rolesanywhere/aws4_request", &amz[..8], self.region);
        let sig = self.key.sign_x509(string_to_sign(alg, &amz, &scope, &creq).as_bytes())?;
        req.headers.push(("Authorization".into(), format!("{alg} Credential={}/{scope}, SignedHeaders={signed}, Signature={}", self.serial, hex(&sig))));
        Ok(req)
    }

    fn creds(&self, fresh: bool) -> Result<AwsCreds, SinkError> {
        let mut g = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        if !fresh {
            if let Some(c) = &*g {
                if now / 1000 < c.exp - REFRESH_MARGIN {
                    return Ok(c.clone());
                }
            }
        }
        let r = self.idp.send(&self.session_request(now)?)?;
        if let Err(mut e) = check_status(r.status, &r.body, "IAM Roles Anywhere") {
            if e.code == "rejected" {
                e.code = "auth";
            }
            return Err(e);
        }
        let v: Value = serde_json::from_slice(&r.body).map_err(|_| SinkError::retry("token", "IAM Roles Anywhere answered no JSON"))?;
        let c = v.pointer("/credentialSet/0/credentials").ok_or_else(|| SinkError::retry("token", "IAM Roles Anywhere answered no credentials"))?;
        let s = |k: &str| c.get(k).and_then(Value::as_str).filter(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_graphic())).map(str::to_owned);
        let creds = AwsCreds {
            access_key: s("accessKeyId").ok_or_else(|| SinkError::retry("token", "the session has no accessKeyId"))?,
            secret: s("secretAccessKey").ok_or_else(|| SinkError::retry("token", "the session has no secretAccessKey"))?,
            token: s("sessionToken").ok_or_else(|| SinkError::retry("token", "the session has no sessionToken"))?,
            exp: s("expiration").as_deref().and_then(parse_iso_utc).unwrap_or(now / 1000 + SESSION_SECONDS),
        };
        *g = Some(creds.clone());
        Ok(creds)
    }
}

/// The SigV4 canonical request and signed header list. Canonical URI: each path segment URI-encoded (the path as sent
/// is encoded again, the non-S3 rule); query pairs sorted as sent; headers lowercased, values trimmed with inner runs
/// of spaces collapsed, `host` added, sorted; payload SHA-256 in hex.
fn canonical_request(req: &Request) -> Result<(String, String), SinkError> {
    let url = checked(&req.url)?;
    let (path, query) = url.path.split_once('?').unwrap_or((url.path.as_str(), ""));
    let curi = path.split('/').map(pct).collect::<Vec<_>>().join("/");
    let mut q: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    q.sort_unstable();
    let cq = q.iter().map(|p| if p.contains('=') { (*p).to_owned() } else { format!("{p}=") }).collect::<Vec<_>>().join("&");
    let mut h: Vec<(String, String)> = req.headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.split_whitespace().collect::<Vec<_>>().join(" "))).collect();
    h.push(("host".into(), authority(&url)));
    h.sort();
    let headers: String = h.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed = h.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    Ok((format!("{}\n{curi}\n{cq}\n{headers}\n{signed}\n{}", req.method, hex(&sha256(&req.body))), signed))
}

fn string_to_sign(alg: &str, amz: &str, scope: &str, creq: &str) -> String {
    format!("{alg}\n{amz}\n{scope}\n{}", hex(&sha256(creq.as_bytes())))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key);
    aws_lc_rs::hmac::sign(&k, data).as_ref().to_vec()
}

/// SigV4 (`AWS4-HMAC-SHA256`): adds `X-Amz-Date`, `X-Amz-Security-Token` (with a session) and `Authorization`.
fn sigv4(req: &mut Request, access_key: &str, secret: &str, session_token: Option<&str>, region: &str, service: &str, amz: &str) -> Result<(), SinkError> {
    req.headers.push(("X-Amz-Date".into(), amz.into()));
    if let Some(t) = session_token {
        req.headers.push(("X-Amz-Security-Token".into(), t.into()));
    }
    let (creq, signed) = canonical_request(req)?;
    let date = &amz[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let mut k = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    for part in [region, service, "aws4_request"] {
        k = hmac(&k, part.as_bytes());
    }
    let sig = hex(&hmac(&k, string_to_sign("AWS4-HMAC-SHA256", amz, &scope, &creq).as_bytes()));
    req.headers.push(("Authorization".into(), format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={sig}")));
    Ok(())
}

// ── Authorization of destination requests ──────────────────────────────────────────────────────────────────

enum Auth {
    /// Headers fixed at build (tokens), mutual TLS in the transport, or nothing.
    Static,
    Entra(EntraAuth),
    Gcp(GcpAuth),
    Aws(AwsAuth),
}

impl Auth {
    fn apply(&self, req: &mut Request, aws_service: &str, fresh: bool) -> Result<(), SinkError> {
        match self {
            Auth::Static => Ok(()),
            Auth::Entra(e) => {
                req.headers.push(("Authorization".into(), format!("Bearer {}", e.bearer(fresh)?)));
                Ok(())
            }
            Auth::Gcp(g) => {
                req.headers.push(("Authorization".into(), format!("Bearer {}", g.bearer(fresh)?)));
                Ok(())
            }
            Auth::Aws(a) => {
                let c = a.creds(fresh)?;
                sigv4(req, &c.access_key, &c.secret, Some(&c.token), &a.region, aws_service, &amz_date(now_ms()))
            }
        }
    }

    /// Send; an `auth` answer with a cached token or session is retried once with a fresh one, and only an `auth`
    /// answer after a fresh one is final.
    fn send(&self, net: &dyn Transport, base: &Request, aws_service: &str, what: &str) -> Result<Response, SinkError> {
        let attempt = |fresh: bool| -> Result<Response, SinkError> {
            let mut req = base.clone();
            self.apply(&mut req, aws_service, fresh)?;
            let r = net.send(&req)?;
            check_status(r.status, &r.body, what)?;
            Ok(r)
        };
        match attempt(false) {
            Err(e) if e.code == "auth" && !matches!(self, Auth::Static) => attempt(true),
            other => other,
        }
    }
}

// ── OTLP ────────────────────────────────────────────────────────────────────────────────────────────────────

struct OtlpSink {
    /// Metrics, logs (and audit), traces.
    endpoints: [Option<String>; 3],
    headers: Vec<(String, String)>,
    auth: Auth,
    /// Google Cloud: `gcp.project_id` added to the resource when absent.
    gcp_project: Option<String>,
    net: Arc<dyn Transport>,
}

fn token_headers(style: TokenStyle, token: &str, names: &[String]) -> Vec<(String, String)> {
    if !names.is_empty() {
        return names.iter().map(|n| (n.clone(), token.to_owned())).collect();
    }
    match style {
        TokenStyle::Header { name, prefix } => vec![(name.to_owned(), format!("{prefix}{token}"))],
        TokenStyle::Basic if token.contains(':') => vec![("Authorization".into(), format!("Basic {}", b64(token.as_bytes())))],
        TokenStyle::Basic => vec![("Authorization".into(), format!("Basic {token}"))],
        TokenStyle::Path => Vec::new(),
    }
}

/// Each signal's URL: `settings.endpoints.<signal>` as given, else `endpoint` plus the preset's suffix (Sumo Logic:
/// `endpoint/<token>/v1/<signal>`). Every URL passes 8.1.
fn otlp_endpoints(dest: &Value, p: &Preset, path_token: Option<&str>) -> Result<[Option<String>; 3], SinkError> {
    let explicit = dest.get("settings").and_then(|s| s.get("endpoints"));
    let base = dest.get("endpoint").and_then(Value::as_str).map(|e| e.trim_end_matches('/'));
    let mut out: [Option<String>; 3] = Default::default();
    for (i, sig) in ["metrics", "logs", "traces"].into_iter().enumerate() {
        let given = explicit.and_then(|e| e.get(sig)).and_then(Value::as_str).filter(|_| path_token.is_none());
        let url = match (given, base, p.paths[i]) {
            (Some(u), _, _) => Some(u.to_owned()),
            (None, Some(b), suffix) if !suffix.is_empty() => Some(match path_token {
                Some(t) => format!("{b}/{}{suffix}", pct(t)),
                None if b.ends_with(suffix) => b.to_owned(),
                None => format!("{b}{suffix}"),
            }),
            _ => None,
        };
        if let Some(u) = &url {
            api_fetch::check_url(u).map_err(|e| SinkError::fatal("config", format!("the {sig} endpoint is refused ({e})")))?;
        }
        out[i] = url;
    }
    if out.iter().all(Option::is_none) {
        return Err(SinkError::fatal("config", "the destination has no endpoint"));
    }
    Ok(out)
}

impl OtlpSink {
    fn new(dest: &Value, p: &'static Preset, credential: Credential, net: Arc<dyn Transport>, idp: Arc<dyn Transport>) -> Result<OtlpSink, SinkError> {
        let names: Vec<String> = dest.pointer("/settings/headers").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        for n in &names {
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) {
                return Err(SinkError::fatal("config", format!("the header name {n:?} is not valid")));
            }
        }
        let mut headers = vec![("Content-Type".to_owned(), "application/x-protobuf".to_owned())];
        let mut path_token = None;
        let mut gcp_project = None;
        let auth = match credential {
            Credential::Token(t) => {
                header_safe(&t, "token")?;
                let style = p.token.ok_or_else(|| SinkError::fatal("config", format!("the preset {} takes no token", p.name)))?;
                headers.extend(token_headers(style, &t, &names));
                if style == TokenStyle::Path {
                    path_token = Some(t);
                }
                Auth::Static
            }
            c @ Credential::EntraCertificate { .. } => Auth::Entra(EntraAuth::new(&c, idp)?),
            c @ Credential::AwsRolesAnywhere { .. } => Auth::Aws(AwsAuth::new(&c, idp)?),
            Credential::GcpServiceAccountKey(k) => {
                let g = GcpAuth::new(&k, idp)?;
                gcp_project = g.project.clone();
                Auth::Gcp(g)
            }
            Credential::Mtls { .. } | Credential::None => Auth::Static,
        };
        let endpoints = otlp_endpoints(dest, p, path_token.as_deref())?;
        Ok(OtlpSink { endpoints, headers, auth, gcp_project, net })
    }
}

impl Sink for OtlpSink {
    fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
        let (i, aws_service) = match batch.signal {
            Signal::Metrics => (0, "monitoring"),
            Signal::Logs | Signal::Audit => (1, "logs"),
            Signal::Traces => (2, "xray"),
        };
        let url = self.endpoints[i].as_deref().ok_or_else(|| SinkError::fatal("config", format!("the destination has no {} endpoint", batch.signal.name())))?;
        let version = batch.resource_attr("service.version").unwrap_or_default();
        let extra = self.gcp_project.as_ref().filter(|_| batch.resource_attr("gcp.project_id").is_none());
        let with_project;
        let resource: &[(String, String)] = match extra {
            Some(p) => {
                with_project = batch.resource.iter().cloned().chain([("gcp.project_id".to_owned(), p.clone())]).collect::<Vec<_>>();
                &with_project
            }
            None => &batch.resource,
        };
        let body = match i {
            0 => otlp_proto::metrics_request(resource, version, &batch.records),
            1 => otlp_proto::logs_request(resource, version, &batch.records),
            _ => otlp_proto::traces_request(resource, version, &batch.records),
        }
        .map_err(|e| SinkError::fatal("record", e))?;
        let mut req = Request { method: "POST", url: url.to_owned(), headers: self.headers.clone(), body: body.into() };
        if matches!(self.auth, Auth::Aws(_)) && i == 1 {
            // CloudWatch Logs OTLP names its log group and stream in headers: `/lucid/logs` or `/lucid/audit`, one stream
            // per console or relay (created by the admin with the destination).
            req.headers.push(("x-aws-log-group".into(), format!("/lucid/{}", batch.signal.name())));
            req.headers.push(("x-aws-log-stream".into(), batch.resource_attr("service.instance.id").unwrap_or("lucid").to_owned()));
        }
        self.auth.send(&*self.net, &req, aws_service, "the OTLP endpoint").map(|_| ())
    }
}

// ── Splunk HEC ──────────────────────────────────────────────────────────────────────────────────────────────

struct HecSink {
    event_url: String,
    ack_url: String,
    authorization: String,
    index: Option<String>,
    sourcetypes: [String; 4],
    channel: String,
    ack_poll: Duration,
    ack_timeout: Duration,
    net: Arc<dyn Transport>,
}

impl HecSink {
    fn new(dest: &Value, credential: Credential, net: Arc<dyn Transport>) -> Result<HecSink, SinkError> {
        let Credential::Token(token) = credential else {
            return Err(SinkError::fatal("config", "Splunk HEC needs a token"));
        };
        header_safe(&token, "token")?;
        let base = dest.get("endpoint").and_then(Value::as_str).map(|e| e.trim_end_matches('/')).ok_or_else(|| SinkError::fatal("config", "the destination has no endpoint"))?;
        let event_url = if base.ends_with("/services/collector/event") { base.to_owned() } else { format!("{base}/services/collector/event") };
        let origin = format!("https://{}", authority(&checked(&event_url)?));
        let channel = uuid();
        let settings = dest.get("settings");
        let index = settings.and_then(|s| s.get("index")).and_then(Value::as_str).map(str::to_owned);
        let given = settings.and_then(|s| s.get("sourcetypes")).and_then(Value::as_array);
        let sourcetypes: [String; 4] = std::array::from_fn(|i| given.and_then(|a| a.get(i)).and_then(Value::as_str).unwrap_or(DEFAULT_SOURCETYPES[i]).to_owned());
        Ok(HecSink {
            event_url,
            ack_url: format!("{origin}/services/collector/ack?channel={channel}"),
            authorization: format!("Splunk {token}"),
            index,
            sourcetypes,
            channel,
            ack_poll: ACK_POLL_FIRST,
            ack_timeout: ACK_TIMEOUT,
            net,
        })
    }

    fn request(&self, url: &str, body: impl Into<Bytes>) -> Request {
        let mut req = Request::post(url, "application/json", body);
        req.headers.push(("Authorization".into(), self.authorization.clone()));
        req.headers.push(("X-Splunk-Request-Channel".into(), self.channel.clone()));
        req
    }

    /// One 11.2 event: `{"time" (seconds), "host" (console or relay id), "source": "lucid", "sourcetype", "index"?,
    /// "fields": {"lucid_org", "lucid_relay", "lucid_event_id"}, "event": <record>}`.
    fn write_event(&self, out: &mut Vec<u8>, batch: &Batch, rec: &Value) -> Result<(), SinkError> {
        let t_ms = rec.get("t_ms").and_then(Value::as_i64).ok_or_else(|| SinkError::fatal("record", "a record lacks its t_ms"))?;
        let event = rec.get("event").and_then(Value::as_str).unwrap_or_default();
        let sourcetype = match batch.signal {
            Signal::Audit => &self.sourcetypes[0],
            _ if event.starts_with("api.") => &self.sourcetypes[2],
            _ => &self.sourcetypes[1],
        };
        let mut head = Map::new();
        head.insert("time".into(), json!(t_ms as f64 / 1000.0));
        if let Some(h) = batch.resource_attr("service.instance.id") {
            head.insert("host".into(), h.into());
        }
        head.insert("source".into(), "lucid".into());
        head.insert("sourcetype".into(), sourcetype.as_str().into());
        if let Some(i) = &self.index {
            head.insert("index".into(), i.as_str().into());
        }
        let mut fields = Map::new();
        for (name, v) in [
            ("lucid_org", batch.resource_attr("lucid.org")),
            ("lucid_relay", batch.resource_attr("lucid.relay.id")),
            ("lucid_event_id", rec.pointer("/attributes/lucid.event_id").and_then(Value::as_str)),
        ] {
            if let Some(v) = v {
                fields.insert(name.into(), v.into());
            }
        }
        head.insert("fields".into(), Value::Object(fields));
        let head = serde_json::to_vec(&Value::Object(head)).map_err(|e| SinkError::fatal("record", e.to_string()))?;
        out.extend_from_slice(&head[..head.len() - 1]);
        out.extend_from_slice(b",\"event\":");
        serde_json::to_writer(&mut *out, rec).map_err(|e| SinkError::fatal("record", e.to_string()))?;
        out.extend_from_slice(b"}\n");
        Ok(())
    }

    /// Poll `/services/collector/ack` until the indexers acknowledge `id`, or time out (retryable: the batch is sent
    /// again, at least once).
    fn wait_ack(&self, id: u64) -> Result<(), SinkError> {
        let start = Instant::now();
        let body = Bytes::from(format!("{{\"acks\":[{id}]}}"));
        let key = id.to_string();
        let mut pause = self.ack_poll;
        loop {
            std::thread::sleep(pause.min(self.ack_timeout.saturating_sub(start.elapsed())));
            let r = self.net.send(&self.request(&self.ack_url, body.clone()))?;
            check_status(r.status, &r.body, "Splunk HEC acknowledgment")?;
            let acked = serde_json::from_slice::<Value>(&r.body).ok().and_then(|v| v.get("acks")?.get(&key)?.as_bool()) == Some(true);
            if acked {
                return Ok(());
            }
            if start.elapsed() >= self.ack_timeout {
                return Err(SinkError::retry("ack-timeout", format!("Splunk did not acknowledge the batch within {} seconds", self.ack_timeout.as_secs())));
            }
            pause = (pause * 2).min(ACK_POLL_MAX);
        }
    }
}

impl Sink for HecSink {
    fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
        if !matches!(batch.signal, Signal::Logs | Signal::Audit) {
            return Err(SinkError::fatal("signal", "Splunk HEC carries logs and audit only"));
        }
        let mut body = Vec::with_capacity(batch.records.len() * 512);
        for rec in &batch.records {
            self.write_event(&mut body, batch, rec)?;
        }
        let r = self.net.send(&self.request(&self.event_url, body))?;
        check_status(r.status, &r.body, "Splunk HEC")?;
        let id = serde_json::from_slice::<Value>(&r.body)
            .ok()
            .and_then(|v| v.get("ackId").and_then(Value::as_u64))
            .ok_or_else(|| SinkError::fatal("ack", "Splunk HEC answered without an ackId: turn on indexer acknowledgment for this token"))?;
        self.wait_ack(id)
    }
}

// ── Azure Monitor Logs Ingestion (Sentinel) ─────────────────────────────────────────────────────────────────

struct AzureLogsSink {
    url: String,
    auth: Auth,
    net: Arc<dyn Transport>,
}

/// Body fields that have their own `LucidAudit_CL` column (the rest goes to `Detail`).
const COLUMN_FIELDS: [&str; 14] = ["org", "relay", "action", "result", "check", "actor", "client", "scope", "route", "ip", "bytes_out", "count", "seq", "ts"];

/// One `LucidAudit_CL` row (11.2): `TimeGenerated`, `Org`, `Relay`, `Chain`, `Seq`, `EventId`, `Action`, `Result`,
/// `Check`, `Actor`, `Client`, `Scope`, `Route`, `SourceIp`, `BytesOut`, `Count`, `Detail` (the body's other fields).
/// Absent values are left out.
fn azure_row(batch: &Batch, rec: &Value) -> Result<Value, SinkError> {
    let t_ms = rec.get("t_ms").and_then(Value::as_i64).ok_or_else(|| SinkError::fatal("record", "a record lacks its t_ms"))?;
    let body = rec.get("body").and_then(Value::as_object);
    let b = |k: &str| body.and_then(|o| o.get(k)).filter(|v| !v.is_null()).cloned();
    let a = |k: &str| rec.get("attributes").and_then(|o| o.get(k)).filter(|v| !v.is_null()).cloned();
    let r = |k: &str| batch.resource_attr(k).map(Value::from);
    let mut row = Map::new();
    row.insert("TimeGenerated".into(), iso_time(t_ms).into());
    for (col, v) in [
        ("Org", b("org").or_else(|| r("lucid.org"))),
        ("Relay", b("relay").or_else(|| r("lucid.relay.id"))),
        ("Chain", a("lucid.chain")),
        ("Seq", a("lucid.seq").or_else(|| b("seq"))),
        ("EventId", a("lucid.event_id")),
        ("Action", a("lucid.action").or_else(|| b("action")).or_else(|| rec.get("event").cloned())),
        ("Result", b("result")),
        ("Check", b("check")),
        ("Actor", b("actor")),
        ("Client", b("client")),
        ("Scope", b("scope")),
        ("Route", b("route")),
        ("SourceIp", b("ip")),
        ("BytesOut", b("bytes_out")),
        ("Count", b("count")),
    ] {
        if let Some(v) = v {
            row.insert(col.into(), v);
        }
    }
    let detail: Map<String, Value> = body.map(|o| o.iter().filter(|(k, _)| !COLUMN_FIELDS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    if !detail.is_empty() {
        row.insert("Detail".into(), Value::Object(detail));
    } else if let Some(text) = rec.get("body").filter(|v| v.is_string()) {
        row.insert("Detail".into(), text.clone());
    }
    Ok(Value::Object(row))
}

/// The rows as JSON arrays of at most `max` bytes each.
fn azure_bodies(rows: &[Value], max: usize) -> Result<Vec<Vec<u8>>, SinkError> {
    let mut out = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    for row in rows {
        let text = serde_json::to_vec(row).map_err(|e| SinkError::fatal("record", e.to_string()))?;
        if text.len() + 2 > max {
            return Err(SinkError::fatal("record", "a record is larger than one Logs Ingestion call"));
        }
        if !cur.is_empty() && cur.len() + text.len() + 2 > max {
            cur.push(b']');
            out.push(std::mem::take(&mut cur));
        }
        cur.push(if cur.is_empty() { b'[' } else { b',' });
        cur.extend_from_slice(&text);
    }
    if !cur.is_empty() {
        cur.push(b']');
        out.push(cur);
    }
    Ok(out)
}

impl AzureLogsSink {
    fn new(dest: &Value, credential: Credential, net: Arc<dyn Transport>, idp: Arc<dyn Transport>) -> Result<AzureLogsSink, SinkError> {
        let s = |k: &str| dest.pointer(&format!("/settings/{k}")).and_then(Value::as_str).filter(|x| !x.is_empty());
        let dce = s("dce").ok_or_else(|| SinkError::fatal("config", "the destination has no dce"))?.trim_end_matches('/');
        let dcr = s("dcr_immutable_id").ok_or_else(|| SinkError::fatal("config", "the destination has no dcr_immutable_id"))?;
        let stream = s("stream").unwrap_or(DEFAULT_STREAM);
        let url = format!("{dce}/dataCollectionRules/{}/streams/{}?api-version={LOGS_API_VERSION}", pct(dcr), pct(stream));
        checked(&url)?;
        Ok(AzureLogsSink { url, auth: Auth::Entra(EntraAuth::new(&credential, idp)?), net })
    }
}

impl Sink for AzureLogsSink {
    fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
        if !matches!(batch.signal, Signal::Logs | Signal::Audit) {
            return Err(SinkError::fatal("signal", "the Logs Ingestion API carries logs and audit only"));
        }
        let rows = batch.records.iter().map(|r| azure_row(batch, r)).collect::<Result<Vec<_>, _>>()?;
        for body in azure_bodies(&rows, AZURE_CALL_MAX)? {
            self.auth.send(&*self.net, &Request::post(self.url.as_str(), "application/json", body), "", "the Logs Ingestion API")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1, ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256};

    type Handler = Box<dyn FnMut(&Request) -> Response + Send>;

    /// A local fake of the vendor endpoints: records every request and answers from a handler.
    struct Fake {
        seen: Mutex<Vec<Request>>,
        handler: Mutex<Handler>,
    }

    impl Fake {
        fn new(h: impl FnMut(&Request) -> Response + Send + 'static) -> Arc<Fake> {
            Arc::new(Fake { seen: Mutex::new(Vec::new()), handler: Mutex::new(Box::new(h)) })
        }

        fn seen(&self) -> Vec<Request> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Transport for Fake {
        fn send(&self, req: &Request) -> Result<Response, SinkError> {
            self.seen.lock().unwrap().push(req.clone());
            let mut h = self.handler.lock().unwrap();
            let f = &mut *h;
            Ok(f(req))
        }
    }

    fn answer(status: u16, body: &str) -> Response {
        Response { status, body: body.as_bytes().to_vec() }
    }

    fn pem(label: &str, der: &[u8]) -> String {
        let b = b64(der);
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    fn rsa_pkcs8() -> Vec<u8> {
        let pair = RsaKeyPair::generate(KeySize::Rsa2048).unwrap();
        AsDer::<Pkcs8V1Der>::as_der(&pair).unwrap().as_ref().to_vec()
    }

    fn ec_pkcs8() -> Vec<u8> {
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &SystemRandom::new()).unwrap().as_ref().to_vec()
    }

    /// Certificate { tbsCertificate { [0] { INTEGER 2 }, serialNumber, NULL } }: enough DER for the serial reader and
    /// the thumbprint (never verified by these tests).
    fn fake_cert(serial: &[u8]) -> Vec<u8> {
        let mut tbs = vec![0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, serial.len() as u8];
        tbs.extend_from_slice(serial);
        tbs.extend_from_slice(&[0x05, 0x00]);
        let mut inner = vec![0x30, tbs.len() as u8];
        inner.extend(tbs);
        let mut out = vec![0x30, inner.len() as u8];
        out.extend(inner);
        out
    }

    fn jwt_parts(t: &str) -> (Value, Value, Vec<u8>, String) {
        let p: Vec<&str> = t.split('.').collect();
        assert_eq!(p.len(), 3);
        let h = serde_json::from_slice(&crate::codec::unb64u(p[0]).unwrap()).unwrap();
        let c = serde_json::from_slice(&crate::codec::unb64u(p[1]).unwrap()).unwrap();
        (h, c, crate::codec::unb64u(p[2]).unwrap(), format!("{}.{}", p[0], p[1]))
    }

    fn form_of(body: &[u8]) -> Vec<(String, String)> {
        let dec = |s: &str| {
            let b = s.as_bytes();
            let mut out = Vec::new();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' {
                    out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                    i += 3;
                } else {
                    out.push(b[i]);
                    i += 1;
                }
            }
            String::from_utf8(out).unwrap()
        };
        std::str::from_utf8(body).unwrap().split('&').map(|p| p.split_once('=').unwrap()).map(|(k, v)| (dec(k), dec(v))).collect()
    }

    fn get<'a>(f: &'a [(String, String)], k: &str) -> &'a str {
        f.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap()
    }

    fn resource() -> Vec<(String, String)> {
        vec![
            ("service.name".into(), "lucid-relay".into()),
            ("service.version".into(), "1.2.3".into()),
            ("service.instance.id".into(), "r_01".into()),
            ("lucid.org".into(), "acme".into()),
            ("lucid.relay.id".into(), "r_01".into()),
        ]
    }

    fn audit_record() -> Value {
        json!({"t_ms": 1_795_000_123_500i64, "severity": 9, "event": "api.call",
            "body": {"seq": 1042, "ts": 1795000123, "org": "acme", "relay": "r_01", "action": "api.call", "client": "c_5f1a2b3c4d5e6f70",
                     "scope": "audit.read", "route": "GET /api/orgs/acme/v1/audit", "resource": "r_01", "result": "ok", "check": "none",
                     "ip": "203.0.113.7", "bytes_out": 5123, "count": 1, "hash": "ab"},
            "attributes": {"lucid.action": "api.call", "lucid.seq": 1042, "lucid.chain": "lucid-api-audit-as-is-v1:acme", "lucid.event_id": "lucid-api-audit-as-is-v1:acme:1042"}})
    }

    fn batch(signal: Signal, records: Vec<Value>) -> Batch {
        Batch { signal, resource: resource(), records }
    }

    fn dest(kind: &str, preset: &str, extra: Value) -> Value {
        let mut d = json!({"id": "d_0123456789abcdef", "name": "t", "kind": kind, "preset": preset, "signals": ["audit"], "ceiling": "internal",
            "identities": "as_is", "failover": false, "private_ok": false, "credential": {"type": "token", "ref": "secret:d_0123456789abcdef"},
            "queue": {"max_bytes": 1 << 30, "max_age_s": 259200}});
        for (k, v) in extra.as_object().unwrap() {
            d[k] = v.clone();
        }
        d
    }

    fn entra(cloud: &str) -> (Credential, Vec<u8>, Vec<u8>) {
        let key = rsa_pkcs8();
        let cert = fake_cert(&[0x01, 0x02]);
        let c = Credential::EntraCertificate { tenant: "contoso.onmicrosoft.com".into(), client_id: "11111111-2222-3333-4444-555555555555".into(), cloud: cloud.into(), cert_pem: pem("CERTIFICATE", &cert), key_pem: pem("PRIVATE KEY", &key) };
        (c, key, cert)
    }

    #[test]
    fn preset_table_matches_contract_11_1() {
        let want = [
            ("azure_monitor", "otlp"),
            ("azure_monitor_gov", "otlp"),
            ("splunk_observability", "otlp"),
            ("datadog", "otlp"),
            ("elastic", "otlp"),
            ("dynatrace", "otlp"),
            ("new_relic", "otlp"),
            ("grafana_cloud", "otlp"),
            ("honeycomb", "otlp"),
            ("sumo_logic", "otlp"),
            ("cloudwatch", "otlp"),
            ("cloudwatch_gov", "otlp"),
            ("google_cloud", "otlp"),
            ("otlp_generic", "otlp"),
            ("splunk_hec", "splunk_hec"),
            ("splunk_cloud_gov", "splunk_hec"),
            ("sentinel", "azure_logs"),
            ("sentinel_gov", "azure_logs"),
            ("syslog_cef", "syslog_cef"),
        ];
        assert_eq!(PRESETS.len(), want.len());
        for (name, kind) in want {
            let p = preset(name).unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(p.kind, kind, "{name}");
            assert!(matches!(p.temporality, "delta" | "cumulative"));
        }
        // 11.3: who takes which credential
        for name in ["splunk_hec", "datadog", "new_relic", "dynatrace", "elastic", "grafana_cloud", "honeycomb", "sumo_logic", "splunk_observability", "splunk_cloud_gov"] {
            assert_eq!(preset(name).unwrap().credentials, &["token"], "{name}");
            assert!(preset(name).unwrap().token.is_some(), "{name}");
        }
        for name in ["azure_monitor", "azure_monitor_gov", "sentinel", "sentinel_gov"] {
            assert_eq!(preset(name).unwrap().credentials, &["entra_certificate"]);
        }
        assert_eq!(preset("cloudwatch_gov").unwrap().credentials, &["aws_roles_anywhere"]);
        assert_eq!(preset("google_cloud").unwrap().credentials, &["gcp_service_account_key"]);
        assert!(preset("otlp_generic").unwrap().credentials.contains(&"mtls"));
        assert!(preset("syslog_cef").unwrap().credentials.contains(&"mtls"));
        assert_eq!(preset("azure_monitor").unwrap().temporality, "delta");
        assert_eq!(preset("datadog").unwrap().token, Some(TokenStyle::Header { name: "DD-API-KEY", prefix: "" }));
        assert_eq!(preset("dynatrace").unwrap().token, Some(TokenStyle::Header { name: "Authorization", prefix: "Api-Token " }));
        assert!(preset("nope").is_none());
    }

    #[test]
    fn sink_for_refuses_misfits() {
        let net = Fake::new(|_| answer(200, ""));
        let b = |d: &Value, c: Credential| build(d, c, net.clone(), net.clone()).err().map(|e| (e.retryable, e.code));
        let d = dest("otlp", "datadog", json!({"endpoint": "https://api.datadoghq.com"}));
        assert_eq!(b(&d, Credential::None), Some((false, "config")));
        assert_eq!(b(&dest("splunk_hec", "datadog", json!({})), Credential::Token("t".into())), Some((false, "config")));
        assert_eq!(b(&dest("syslog_cef", "syslog_cef", json!({})), Credential::None), Some((false, "config")));
        let (gov, _, _) = entra("usgov");
        assert_eq!(b(&dest("azure_logs", "sentinel", json!({"settings": {"dce": "https://x.ingest.monitor.azure.com", "dcr_immutable_id": "dcr-1"}})), gov), Some((false, "config")));
        assert_eq!(b(&dest("otlp", "datadog", json!({"endpoint": "http://api.datadoghq.com"})), Credential::Token("t".into())), Some((false, "config")));
        assert_eq!(b(&d, Credential::Token("a\r\nb".into())), Some((false, "config")));
        assert!(b(&d, Credential::Token("k".into())).is_none());
    }

    #[test]
    fn status_classification() {
        let c = |s: u16| check_status(s, b"", "x").err().map(|e| (e.retryable, e.code));
        assert_eq!(c(200), None);
        assert_eq!(c(204), None);
        assert_eq!(c(301), Some((false, "redirect")));
        assert_eq!(c(400), Some((false, "rejected")));
        assert_eq!(c(401), Some((false, "auth")));
        assert_eq!(c(403), Some((false, "auth")));
        assert_eq!(c(408), Some((true, "status")));
        assert_eq!(c(413), Some((false, "rejected")));
        assert_eq!(c(429), Some((true, "status")));
        assert_eq!(c(500), Some((true, "status")));
        assert_eq!(c(503), Some((true, "status")));
        assert!(check_status(400, b"{\"text\":\"Invalid data format\",\"code\":6}", "Splunk HEC").unwrap_err().message.contains("Invalid data format"));
    }

    #[test]
    fn shared_export_runtime_bounds_in_flight_requests() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let start = Instant::now();
        let callers: Vec<_> = (0..200)
            .map(|_| {
                let (live, peak) = (live.clone(), peak.clone());
                std::thread::spawn(move || {
                    pooled(async move {
                        let n = live.fetch_add(1, SeqCst) + 1;
                        peak.fetch_max(n, SeqCst);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        live.fetch_sub(1, SeqCst);
                        Ok(())
                    })
                })
            })
            .collect();
        for c in callers {
            c.join().unwrap().unwrap();
        }
        let peak = peak.load(SeqCst);
        assert!(peak <= EXPORT_IN_FLIGHT, "{peak} requests were in flight at once");
        assert!(peak > 1, "requests ran one at a time");
        // 200 requests of 100 ms through 64 slots take at least four rounds
        assert!(start.elapsed() >= Duration::from_millis(400), "{:?}", start.elapsed());
        assert_eq!(live.load(SeqCst), 0);
    }

    #[test]
    fn net_transport_refuses_loopback_before_connecting() {
        let t = NetTransport { tls: tls_default().unwrap(), private_ok: true, total: Duration::from_secs(5) };
        let e = t.send(&Request::post("https://127.0.0.1:9/v1/logs", "application/x-protobuf", Vec::new())).unwrap_err();
        assert_eq!((e.retryable, e.code), (false, "address"));
        let e = t.send(&Request::post("http://example.com/v1/logs", "application/x-protobuf", Vec::new())).unwrap_err();
        assert_eq!((e.retryable, e.code), (false, "config"));
    }

    #[test]
    fn sigv4_get_vanilla_vector() {
        // aws-sig-v4-test-suite/get-vanilla
        let mut req = Request { method: "GET", url: "https://example.amazonaws.com/".into(), headers: Vec::new(), body: Bytes::new() };
        let mut probe = req.clone();
        probe.headers.push(("X-Amz-Date".into(), "20150830T123600Z".into()));
        let (creq, signed) = canonical_request(&probe).unwrap();
        assert_eq!(creq, "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(signed, "host;x-amz-date");
        assert_eq!(
            string_to_sign("AWS4-HMAC-SHA256", "20150830T123600Z", "20150830/us-east-1/service/aws4_request", &creq),
            "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"
        );
        sigv4(&mut req, "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", None, "us-east-1", "service", "20150830T123600Z").unwrap();
        assert_eq!(
            req.header("authorization").unwrap(),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn amz_date_and_iso_parse() {
        // 2015-08-30T12:36:00Z
        assert_eq!(amz_date(1_440_938_160_000), "20150830T123600Z");
        assert_eq!(parse_iso_utc("2015-08-30T12:36:00Z"), Some(1_440_938_160));
        assert_eq!(parse_iso_utc("2015-08-30T12:36:00.123Z"), Some(1_440_938_160));
        assert_eq!(parse_iso_utc("2015-08-30T12:36:00+00:00"), Some(1_440_938_160));
        assert_eq!(parse_iso_utc("2015-08-30 12:36:00Z"), None);
    }

    #[test]
    fn cert_serial_in_decimal() {
        assert_eq!(cert_serial_decimal(&fake_cert(&[0x01, 0x00])).as_deref(), Some("256"));
        assert_eq!(cert_serial_decimal(&fake_cert(&[0x00, 0xff])).as_deref(), Some("255"));
        // 2^64 = 18446744073709551616
        assert_eq!(cert_serial_decimal(&fake_cert(&[1, 0, 0, 0, 0, 0, 0, 0, 0])).as_deref(), Some("18446744073709551616"));
        assert_eq!(cert_serial_decimal(&[0x30, 0x00]), None);
    }

    fn roles_anywhere_check(key_der: &[u8], rsa: bool) {
        let cert = fake_cert(&[0x01, 0x00]);
        let cred = Credential::AwsRolesAnywhere {
            trust_anchor_arn: "arn:aws:rolesanywhere:us-east-1:111122223333:trust-anchor/ta".into(),
            profile_arn: "arn:aws:rolesanywhere:us-east-1:111122223333:profile/p".into(),
            role_arn: "arn:aws:iam::111122223333:role/lucid-export".into(),
            region: "us-east-1".into(),
            cert_pem: pem("CERTIFICATE", &cert),
            key_pem: pem("PRIVATE KEY", key_der),
        };
        let idp = Fake::new(|_| answer(201, ""));
        let a = AwsAuth::new(&cred, idp).unwrap();
        let req = a.session_request(1_440_938_160_000).unwrap();
        assert_eq!(req.url, "https://rolesanywhere.us-east-1.amazonaws.com/sessions");
        assert_eq!(req.header("x-amz-date"), Some("20150830T123600Z"));
        assert_eq!(req.header("x-amz-x509"), Some(b64(&cert).as_str()));
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["durationSeconds"], 3600);
        assert_eq!(body["roleArn"], "arn:aws:iam::111122223333:role/lucid-export");
        let alg = if rsa { "AWS4-X509-RSA-SHA256" } else { "AWS4-X509-ECDSA-SHA256" };
        let auth = req.header("authorization").unwrap();
        let prefix = format!("{alg} Credential=256/20150830/us-east-1/rolesanywhere/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-x509, Signature=");
        assert!(auth.starts_with(&prefix), "{auth}");
        let sig_hex = &auth[prefix.len()..];
        let sig: Vec<u8> = (0..sig_hex.len()).step_by(2).map(|i| u8::from_str_radix(&sig_hex[i..i + 2], 16).unwrap()).collect();
        let mut unsigned = req.clone();
        unsigned.headers.retain(|(k, _)| k != "Authorization");
        let (creq, _) = canonical_request(&unsigned).unwrap();
        let sts = string_to_sign(alg, "20150830T123600Z", "20150830/us-east-1/rolesanywhere/aws4_request", &creq);
        if rsa {
            let pk = RsaKeyPair::from_pkcs8(key_der).unwrap();
            UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, pk.public_key().as_ref()).verify(sts.as_bytes(), &sig).unwrap();
        } else {
            let pk = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, key_der).unwrap();
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, pk.public_key().as_ref()).verify(sts.as_bytes(), &sig).unwrap();
        }
    }

    #[test]
    fn roles_anywhere_signature_shape_ecdsa() {
        roles_anywhere_check(&ec_pkcs8(), false);
    }

    #[test]
    fn roles_anywhere_signature_shape_rsa() {
        roles_anywhere_check(&rsa_pkcs8(), true);
    }

    #[test]
    fn cloudwatch_session_then_sigv4_on_otlp() {
        let key = ec_pkcs8();
        let cred = Credential::AwsRolesAnywhere {
            trust_anchor_arn: "arn:aws:rolesanywhere:us-east-1:1:trust-anchor/ta".into(),
            profile_arn: "arn:aws:rolesanywhere:us-east-1:1:profile/p".into(),
            role_arn: "arn:aws:iam::1:role/r".into(),
            region: "us-east-1".into(),
            cert_pem: pem("CERTIFICATE", &fake_cert(&[7])),
            key_pem: pem("PRIVATE KEY", &key),
        };
        let idp = Fake::new(|_| answer(201, r#"{"credentialSet":[{"credentials":{"accessKeyId":"ASIAEXAMPLE","secretAccessKey":"s3cr3t","sessionToken":"tok","expiration":"2999-01-01T00:00:00Z"}}],"subjectArn":"x"}"#));
        let net = Fake::new(|_| answer(200, ""));
        let d = dest("otlp", "cloudwatch", json!({"settings": {"endpoints": {"logs": "https://logs.us-east-1.amazonaws.com/v1/logs", "traces": "https://xray.us-east-1.amazonaws.com/v1/traces"}}}));
        let sink = build(&d, cred.clone(), net.clone(), idp.clone()).unwrap();
        sink.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap();
        sink.deliver(&batch(Signal::Logs, vec![audit_record()])).unwrap();
        assert_eq!(idp.seen().len(), 1, "the session is cached");
        let reqs = net.seen();
        let r = &reqs[0];
        assert_eq!(r.url, "https://logs.us-east-1.amazonaws.com/v1/logs");
        assert_eq!(r.header("x-amz-security-token"), Some("tok"));
        assert_eq!(r.header("x-aws-log-group"), Some("/lucid/audit"));
        assert_eq!(r.header("x-aws-log-stream"), Some("r_01"));
        let auth = r.header("authorization").unwrap();
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/"), "{auth}");
        assert!(auth.contains("/us-east-1/logs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-aws-log-group;x-aws-log-stream, Signature="));
        // metrics have no endpoint here; the gov preset refuses a commercial region
        assert_eq!(sink.deliver(&batch(Signal::Metrics, vec![])).unwrap_err().code, "config");
        assert!(build(&dest("otlp", "cloudwatch_gov", json!({"endpoint": "https://x.example"})), cred, net, idp).is_err());
    }

    #[test]
    fn entra_assertion_claims_and_token_cache() {
        let (cred, key, cert) = entra("public");
        let mut issued = 0;
        let idp = Fake::new(move |_| {
            issued += 1;
            answer(200, &format!(r#"{{"token_type":"Bearer","expires_in":3599,"access_token":"at{issued}"}}"#))
        });
        let net_calls = Arc::new(Mutex::new(0));
        let n2 = net_calls.clone();
        let net = Fake::new(move |_| {
            let mut n = n2.lock().unwrap();
            *n += 1;
            // the second call fails auth once: the sink takes a fresh token and retries
            answer(if *n == 2 { 401 } else { 204 }, "")
        });
        let d = dest("azure_logs", "sentinel", json!({"settings": {"dce": "https://lucid-abcd.eastus-1.ingest.monitor.azure.com", "dcr_immutable_id": "dcr-0123456789abcdef0123456789abcdef"}}));
        let sink = build(&d, cred, net.clone(), idp.clone()).unwrap();
        sink.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap();
        sink.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap();
        let toks = idp.seen();
        assert_eq!(toks.len(), 2, "one token, then one fresh after the 401");
        let t = &toks[0];
        let url = "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token";
        assert_eq!(t.url, url);
        assert_eq!(t.header("content-type"), Some("application/x-www-form-urlencoded"));
        let f = form_of(&t.body);
        assert_eq!(get(&f, "grant_type"), "client_credentials");
        assert_eq!(get(&f, "scope"), "https://monitor.azure.com/.default");
        assert_eq!(get(&f, "client_id"), "11111111-2222-3333-4444-555555555555");
        assert_eq!(get(&f, "client_assertion_type"), ASSERTION_TYPE);
        let (h, c, sig, input) = jwt_parts(get(&f, "client_assertion"));
        assert_eq!(h, json!({"alg": "RS256", "typ": "JWT", "x5t#S256": b64u(&sha256(&cert))}));
        assert_eq!(c["aud"], url);
        assert_eq!(c["iss"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(c["sub"], c["iss"]);
        assert_eq!(c["exp"].as_i64().unwrap() - c["iat"].as_i64().unwrap(), 300);
        assert_eq!(c["nbf"], c["iat"]);
        assert_eq!(c["jti"].as_str().unwrap().len(), 36);
        let pk = RsaKeyPair::from_pkcs8(&key).unwrap();
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, pk.public_key().as_ref()).verify(input.as_bytes(), &sig).unwrap();
        let reqs = net.seen();
        assert_eq!(reqs.len(), 3);
        assert_eq!(reqs[0].header("authorization"), Some("Bearer at1"));
        assert_eq!(reqs[1].header("authorization"), Some("Bearer at1"));
        assert_eq!(reqs[2].header("authorization"), Some("Bearer at2"));
        assert_eq!(reqs[0].url, "https://lucid-abcd.eastus-1.ingest.monitor.azure.com/dataCollectionRules/dcr-0123456789abcdef0123456789abcdef/streams/Custom-LucidAudit_CL?api-version=2023-01-01");
    }

    #[test]
    fn entra_usgov_endpoint_scope_and_es256() {
        let key = ec_pkcs8();
        let cred = Credential::EntraCertificate { tenant: "t1".into(), client_id: "c1".into(), cloud: "usgov".into(), cert_pem: pem("CERTIFICATE", &fake_cert(&[9])), key_pem: pem("PRIVATE KEY", &key) };
        let idp = Fake::new(|_| answer(200, r#"{"access_token":"x","expires_in":"3600"}"#));
        let e = EntraAuth::new(&cred, idp.clone()).unwrap();
        assert_eq!(e.bearer(false).unwrap(), "x");
        let t = &idp.seen()[0];
        assert_eq!(t.url, "https://login.microsoftonline.us/t1/oauth2/v2.0/token");
        let f = form_of(&t.body);
        assert_eq!(get(&f, "scope"), "https://monitor.azure.us/.default");
        let (h, c, sig, input) = jwt_parts(get(&f, "client_assertion"));
        assert_eq!(h["alg"], "ES256");
        assert_eq!(c["aud"], "https://login.microsoftonline.us/t1/oauth2/v2.0/token");
        assert_eq!(sig.len(), 64);
        let pk = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &key).unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, pk.public_key().as_ref()).verify(input.as_bytes(), &sig).unwrap();
        // a token inside the five-minute margin is replaced
        let idp = Fake::new(|_| answer(200, r#"{"access_token":"short","expires_in":200}"#));
        let e = EntraAuth::new(&cred, idp.clone()).unwrap();
        e.bearer(false).unwrap();
        e.bearer(false).unwrap();
        assert_eq!(idp.seen().len(), 2);
        // a refused credential is final
        let idp = Fake::new(|_| answer(400, r#"{"error":"invalid_client"}"#));
        let err = EntraAuth::new(&cred, idp).unwrap().bearer(false).unwrap_err();
        assert_eq!((err.retryable, err.code), (false, "auth"));
    }

    #[test]
    fn gcp_assertion_claims_and_resource_project() {
        let key = rsa_pkcs8();
        let sa = json!({"type": "service_account", "project_id": "acme-prod", "private_key_id": "kid1", "private_key": pem("PRIVATE KEY", &key),
            "client_email": "lucid@acme-prod.iam.gserviceaccount.com", "token_uri": "https://evil.example/token"});
        let idp = Fake::new(|_| answer(200, r#"{"access_token":"ya29.x","expires_in":3599,"token_type":"Bearer"}"#));
        let net = Fake::new(|_| answer(200, ""));
        let d = dest("otlp", "google_cloud", json!({"endpoint": "https://telemetry.googleapis.com"}));
        let sink = build(&d, Credential::GcpServiceAccountKey(sa.to_string()), net.clone(), idp.clone()).unwrap();
        sink.deliver(&batch(Signal::Traces, vec![json!({"trace_id": "0102030405060708090a0b0c0d0e0f10", "span_id": "a1a2a3a4a5a6a7a8", "name": "GET /v1/audit", "start_ms": 1, "end_ms": 2, "status": "ok"})])).unwrap();
        let t = &idp.seen()[0];
        assert_eq!(t.url, "https://oauth2.googleapis.com/token");
        let f = form_of(&t.body);
        assert_eq!(get(&f, "grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        let (h, c, sig, input) = jwt_parts(get(&f, "assertion"));
        assert_eq!(h, json!({"alg": "RS256", "typ": "JWT", "kid": "kid1"}));
        assert_eq!(c["iss"], "lucid@acme-prod.iam.gserviceaccount.com");
        assert_eq!(c["aud"], "https://oauth2.googleapis.com/token");
        assert_eq!(c["scope"], GCP_SCOPE);
        assert_eq!(c["exp"].as_i64().unwrap() - c["iat"].as_i64().unwrap(), 300);
        let pk = RsaKeyPair::from_pkcs8(&key).unwrap();
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, pk.public_key().as_ref()).verify(input.as_bytes(), &sig).unwrap();
        let r = &net.seen()[0];
        assert_eq!(r.url, "https://telemetry.googleapis.com/v1/traces");
        assert_eq!(r.header("authorization"), Some("Bearer ya29.x"));
        assert_eq!(r.header("content-type"), Some("application/x-protobuf"));
        assert!(r.body.windows(b"gcp.project_id".len()).any(|w| w == b"gcp.project_id"));
        assert!(r.body.windows(b"acme-prod".len()).any(|w| w == b"acme-prod"));
    }

    #[test]
    fn otlp_token_headers_and_paths() {
        let net = Fake::new(|_| answer(200, ""));
        let send = |preset: &str, extra: Value, token: &str, signal: Signal| -> Request {
            let sink = build(&dest("otlp", preset, extra), Credential::Token(token.into()), net.clone(), net.clone()).unwrap();
            let rec = match signal {
                Signal::Metrics => json!({"name": "lucid.api.requests", "kind": "sum", "unit": "1", "temporality": "delta", "points": [{"t_ms": 1, "v": 2.0, "labels": {"result": "ok"}}]}),
                _ => audit_record(),
            };
            sink.deliver(&batch(signal, vec![rec])).unwrap();
            net.seen().pop().unwrap()
        };
        let r = send("datadog", json!({"endpoint": "https://otlp.datadoghq.com/"}), "dd", Signal::Logs);
        assert_eq!((r.url.as_str(), r.header("dd-api-key")), ("https://otlp.datadoghq.com/v1/logs", Some("dd")));
        let r = send("dynatrace", json!({"endpoint": "https://abc.live.dynatrace.com/api/v2/otlp"}), "dt0c01.x", Signal::Metrics);
        assert_eq!((r.url.as_str(), r.header("authorization")), ("https://abc.live.dynatrace.com/api/v2/otlp/v1/metrics", Some("Api-Token dt0c01.x")));
        let r = send("honeycomb", json!({"endpoint": "https://api.honeycomb.io"}), "hc", Signal::Audit);
        assert_eq!(r.header("x-honeycomb-team"), Some("hc"));
        let r = send("new_relic", json!({"endpoint": "https://otlp.nr-data.net"}), "nr", Signal::Logs);
        assert_eq!(r.header("api-key"), Some("nr"));
        let r = send("elastic", json!({"endpoint": "https://x.apm.us-east-1.aws.elastic.cloud"}), "ek", Signal::Logs);
        assert_eq!(r.header("authorization"), Some("ApiKey ek"));
        let r = send("grafana_cloud", json!({"endpoint": "https://otlp-gateway-prod-us-east-0.grafana.net/otlp"}), "123:glc", Signal::Logs);
        assert_eq!(r.header("authorization"), Some(format!("Basic {}", b64(b"123:glc")).as_str()));
        let r = send("splunk_observability", json!({"endpoint": "https://ingest.us1.signalfx.com"}), "sf", Signal::Metrics);
        assert_eq!((r.url.as_str(), r.header("x-sf-token")), ("https://ingest.us1.signalfx.com/v2/datapoint/otlp", Some("sf")));
        let r = send("sumo_logic", json!({"endpoint": "https://endpoint1.collection.sumologic.com/receiver/v1/otlp"}), "ZaVnC4dhaV2", Signal::Logs);
        assert_eq!(r.url, "https://endpoint1.collection.sumologic.com/receiver/v1/otlp/ZaVnC4dhaV2/v1/logs");
        assert_eq!(r.header("authorization"), None);
        // explicit per-signal endpoints win; settings.headers renames the token header
        let r = send("datadog", json!({"settings": {"endpoints": {"metrics": "https://api.datadoghq.com/api/intake/otlp/v1/metrics"}, "headers": ["dd-api-key"]}}), "k2", Signal::Metrics);
        assert_eq!((r.url.as_str(), r.header("dd-api-key")), ("https://api.datadoghq.com/api/intake/otlp/v1/metrics", Some("k2")));
        // the body is the protobuf of the batch
        let want = otlp_proto::metrics_request(&resource(), "1.2.3", &[json!({"name": "lucid.api.requests", "kind": "sum", "unit": "1", "temporality": "delta", "points": [{"t_ms": 1, "v": 2.0, "labels": {"result": "ok"}}]})]).unwrap();
        assert_eq!(&r.body[..], &want[..]);
        // otlp_generic without a credential sends no authorization
        let sink = build(&dest("otlp", "otlp_generic", json!({"endpoint": "https://collector.example"})), Credential::None, net.clone(), net.clone()).unwrap();
        sink.deliver(&batch(Signal::Logs, vec![audit_record()])).unwrap();
        let r = net.seen().pop().unwrap();
        assert_eq!(r.url, "https://collector.example/v1/logs");
        assert_eq!(r.headers.len(), 1);
    }

    fn hec(handler: impl FnMut(&Request) -> Response + Send + 'static, extra: Value) -> (HecSink, Arc<Fake>) {
        let net = Fake::new(handler);
        let d = dest("splunk_hec", "splunk_hec", extra);
        let mut s = HecSink::new(&d, Credential::Token("tok-1".into()), net.clone()).unwrap();
        s.ack_poll = Duration::from_millis(1);
        s.ack_timeout = Duration::from_millis(200);
        (s, net)
    }

    #[test]
    fn hec_body_and_ack_flow() {
        let mut polls = 0;
        let (s, net) = hec(
            move |r| {
                if r.url.contains("/services/collector/event") {
                    answer(200, r#"{"text":"Success","code":0,"ackId":7}"#)
                } else {
                    polls += 1;
                    answer(200, if polls < 3 { r#"{"acks":{"7":false}}"# } else { r#"{"acks":{"7":true}}"# })
                }
            },
            json!({"endpoint": "https://hec.example.com:8088", "settings": {"index": "lucid", "ack": true}}),
        );
        s.deliver(&batch(Signal::Audit, vec![audit_record(), audit_record()])).unwrap();
        let reqs = net.seen();
        assert_eq!(reqs.len(), 4, "one event post, three ack polls");
        let ev = &reqs[0];
        assert_eq!(ev.url, "https://hec.example.com:8088/services/collector/event");
        assert_eq!(ev.header("authorization"), Some("Splunk tok-1"));
        let channel = ev.header("x-splunk-request-channel").unwrap().to_owned();
        assert_eq!(channel.len(), 36);
        let text = std::str::from_utf8(&ev.body).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(
            first,
            json!({"time": 1_795_000_123.5, "host": "r_01", "source": "lucid", "sourcetype": "lucid:audit", "index": "lucid",
                "fields": {"lucid_org": "acme", "lucid_relay": "r_01", "lucid_event_id": "lucid-api-audit-as-is-v1:acme:1042"}, "event": audit_record()})
        );
        let poll = &reqs[1];
        assert_eq!(poll.url, format!("https://hec.example.com:8088/services/collector/ack?channel={channel}"));
        assert_eq!(poll.header("x-splunk-request-channel"), Some(channel.as_str()));
        assert_eq!(&poll.body[..], b"{\"acks\":[7]}");
        // logs: relay or API sourcetype
        let (s, net) = hec(|r| answer(200, if r.url.contains("/event") { r#"{"ackId":1}"# } else { r#"{"acks":{"1":true}}"# }), json!({"endpoint": "https://hec.example.com/services/collector/event"}));
        let mut log = audit_record();
        log["event"] = json!("relay.started");
        s.deliver(&batch(Signal::Logs, vec![log, audit_record()])).unwrap();
        let body = net.seen()[0].body.clone();
        let lines: Vec<Value> = std::str::from_utf8(&body).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["sourcetype"], "lucid:relay");
        assert_eq!(lines[1]["sourcetype"], "lucid:api");
        assert!(lines[0].get("index").is_none());
        assert_eq!(net.seen()[0].url, "https://hec.example.com/services/collector/event");
    }

    #[test]
    fn hec_ack_timeout_and_refusals() {
        let (s, _) = hec(|r| answer(200, if r.url.contains("/event") { r#"{"ackId":5}"# } else { r#"{"acks":{"5":false}}"# }), json!({"endpoint": "https://hec.example.com"}));
        let e = s.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap_err();
        assert_eq!((e.retryable, e.code), (true, "ack-timeout"));
        let (s, _) = hec(|_| answer(200, r#"{"text":"Success","code":0}"#), json!({"endpoint": "https://hec.example.com"}));
        assert_eq!(s.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap_err().code, "ack");
        let (s, _) = hec(|_| answer(403, r#"{"text":"Invalid token","code":4}"#), json!({"endpoint": "https://hec.example.com"}));
        let e = s.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap_err();
        assert_eq!((e.retryable, e.code), (false, "auth"));
        let (s, _) = hec(|_| answer(503, r#"{"text":"Server is busy","code":9}"#), json!({"endpoint": "https://hec.example.com"}));
        assert!(s.deliver(&batch(Signal::Audit, vec![audit_record()])).unwrap_err().retryable);
        assert_eq!(s.deliver(&batch(Signal::Metrics, vec![])).unwrap_err().code, "signal");
    }

    #[test]
    fn logs_ingestion_rows() {
        let row = azure_row(&batch(Signal::Audit, vec![]), &audit_record()).unwrap();
        assert_eq!(
            row,
            json!({"TimeGenerated": "2026-11-18T11:08:43.500Z", "Org": "acme", "Relay": "r_01", "Chain": "lucid-api-audit-as-is-v1:acme", "Seq": 1042,
                "EventId": "lucid-api-audit-as-is-v1:acme:1042", "Action": "api.call", "Result": "ok", "Check": "none", "Client": "c_5f1a2b3c4d5e6f70",
                "Scope": "audit.read", "Route": "GET /api/orgs/acme/v1/audit", "SourceIp": "203.0.113.7", "BytesOut": 5123, "Count": 1,
                "Detail": {"resource": "r_01", "hash": "ab"}})
        );
        // a removed-identities record keeps its columns absent, never null
        let mut rec = audit_record();
        rec["body"].as_object_mut().unwrap().remove("ip");
        rec["body"].as_object_mut().unwrap().remove("client");
        let row = azure_row(&batch(Signal::Audit, vec![]), &rec).unwrap();
        assert!(row.get("SourceIp").is_none() && row.get("Client").is_none());
        // splitting at the call limit
        let rows = vec![json!({"a": "x".repeat(40)}), json!({"a": "y".repeat(40)}), json!({"a": "z"})];
        let bodies = azure_bodies(&rows, 100).unwrap();
        assert_eq!(bodies.len(), 2);
        for b in &bodies {
            assert!(b.len() <= 100);
            assert!(serde_json::from_slice::<Value>(b).unwrap().is_array());
        }
        assert!(azure_bodies(&[json!({"a": "x".repeat(200)})], 100).is_err());
    }

    #[test]
    fn credential_debug_hides_secrets() {
        let (c, _, _) = entra("public");
        let text = format!("{c:?} {:?} {:?}", Credential::Token("s3cr3t".into()), Credential::GcpServiceAccountKey("{\"private_key\":\"k\"}".into()));
        assert!(!text.contains("PRIVATE KEY") && !text.contains("s3cr3t") && !text.contains("private_key"));
        assert!(text.contains("contoso.onmicrosoft.com"));
    }
}
