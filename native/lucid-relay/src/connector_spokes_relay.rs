// Contract API-1 revision 6 (phase 1d), 5.3, 5.8 and 7.2.3 (slice 1d3): the connector's service hub talking to the
// org's API relays, as the add-on's `src/relay.ts` `RelayClient` does.
//
// Rule M (5.4) and 7.2.3: the service hub reaches spokes only through the relays of the held root-signed relay
// directory whose entries carry `"api": true` (Rust spokes relays bound to the org that enforce 5.3); `api_relays`
// reads them from the verified token while it is in date, and `granted` keeps those whose `relay` id is in the hub
// client's `relays` grant of the pinned map (`relay_grant`, 5.8 as amended); nothing else is ever dialed. Each entry's `ca` (the only
// trust anchor when set) and `spki` (the server key's SHA-256, base64url) pin its TLS as `pinnedTls` does; plain
// `http` only on loopback (the directory reader already refuses it elsewhere).
//
// Every request is signed for its one mailbox (`relay:<host>`, RS-RELAY-03) by the node key: the legacy header
// carrying the certificate, or, for a certificate longer than the legacy header allows, the hash form after
// `POST /v1/node/cert` (registered before its first use, and once more after a 401).
// The service hub's license seat, when it has one, rides in `lucid-seat`. No answer larger than REPLY_CAP_BYTES is
// taken.

use crate::api_map::spokes_relays;
use crate::codec::{b64u, is_int, sha256, sha256_hex, str_of, stringify};
use crate::connector_spokes_wire::{authorization, audience_of, random_hex, Envelope, NodeKey, REPLY_CAP_BYTES};
use crate::identity::{is_node_id, is_renewed_leaf, parse_bundle, peek_compact, Bundle, LEGACY_HEADER_CERT_MAX, LOOPBACK_HOSTS};
use crate::meet::log_warn;
use crate::meet_org_policy::Obj;
use parking_lot::Mutex;
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// relay.ts RELAY_LIMITS.presencePage.
pub const PRESENCE_PAGE: usize = 4_000;
/// The most presence a service hub reads from one relay: 16 pages and 64,000 spokes (a client's targets are at most
/// 256, or `*`), so a relay cannot keep it paging or growing.
pub const PRESENCE_PAGES_MAX: usize = 16;
pub const PRESENCE_ROWS_MAX: usize = 64_000;
/// The add-on's per-request timeout.
pub const TIMEOUT_S: f64 = 15.0;
const REGISTER_PATH: &str = "/v1/node/cert";

/// A relay call that did not answer 200: `status` 0 when the relay could not be reached or its answer was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayError {
    pub status: u16,
    pub message: String,
}

impl RelayError {
    pub fn new(status: u16, message: impl Into<String>) -> RelayError {
        RelayError { status, message: message.into() }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            f.write_str(&self.message)
        } else {
            write!(f, "the relay answered {}: {}", self.status, self.message)
        }
    }
}

// ── the API relays of the held directory (5.8) ──────────────────────────────────────────────────────────────

/// One directory relay marked `api: true`: its relay id (5.8 as amended), and its TLS pins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiRelay {
    pub relay: String,
    pub url: String,
    pub ca: Option<String>,
    pub spki: Option<String>,
}

/// The entries marked `"api": true` of a relay directory token `DirectoryHolder::accept` already verified, lowest
/// `priority` first (node.ts `mailboxesFor`; the connector names no region); none once the directory's `exp` has passed
/// (`now_s`), as the spoke judges rule M.
pub fn api_relays(token: &str, now_s: i64) -> Vec<ApiRelay> {
    let Some(p) = peek_compact(token) else { return Vec::new() };
    if is_int(p.get("exp")).is_none_or(|exp| exp <= now_s) {
        return Vec::new();
    }
    let mut marked: Vec<&Value> = p.get("relays").and_then(Value::as_array).into_iter().flatten().filter(|e| e.get("api") == Some(&Value::Bool(true))).collect();
    marked.sort_by_key(|e| is_int(e.get("priority")).unwrap_or(i64::MAX));
    marked
        .into_iter()
        .filter_map(|e| {
            Some(ApiRelay {
                relay: str_of(e.get("relay"))?.to_owned(),
                url: str_of(e.get("url"))?.to_owned(),
                ca: str_of(e.get("ca")).map(str::to_owned),
                spki: str_of(e.get("spki")).map(str::to_owned),
            })
        })
        .collect()
}

/// 4.1 and 5.8 as amended (review W5b finding 7): the relay ids the pinned map grants spokes_hub client `client`, its
/// `relays` (`["*"]`: the map's `spokes.relays`); none when the map does not list the client.
pub fn relay_grant(map: &Obj, client: &str) -> Vec<String> {
    let Some(c) = map.get("clients").and_then(Value::as_array).into_iter().flatten().find(|c| str_of(c.get("id")) == Some(client)) else { return Vec::new() };
    let relays: Vec<&str> = c.get("relays").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if relays == ["*"] {
        return spokes_relays(map).into_iter().map(str::to_owned).collect();
    }
    relays.into_iter().map(str::to_owned).collect()
}

/// The API relays a service hub dials: those of `marked` (in date, lowest `priority` first) whose relay id is in
/// `grant`, in that order.
pub fn granted(marked: Vec<ApiRelay>, grant: &[String]) -> Vec<ApiRelay> {
    marked.into_iter().filter(|r| grant.contains(&r.relay)).collect()
}

// ── the transport ───────────────────────────────────────────────────────────────────────────────────────────

/// One mailbox's HTTP exchange (blocking, off the async workers). Tests put an in-process relay behind it.
pub trait Mailbox: Send + Sync {
    /// The relay URL (origin), as the directory names it.
    fn url(&self) -> &str;
    /// One request; Ok is the status and the answer's bytes.
    fn exchange(&self, method: &str, path: &str, headers: &[(&'static str, String)], body: Option<&[u8]>) -> Result<(u16, Vec<u8>), String>;
}

/// `scheme`, host (IPv6 without brackets) and port of an origin URL.
fn origin_parts(url: &str) -> Option<(bool, String, u16)> {
    let (tls, rest) = match url.split_once("://")? {
        ("https", r) => (true, r),
        ("http", r) => (false, r),
        _ => return None,
    };
    let authority = rest.split(&['/', '?', '#'][..]).next()?;
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h.to_owned(), after.strip_prefix(':').map(str::to_owned))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p.to_owned())),
            None => (authority.to_owned(), None),
        }
    };
    let port = match port {
        Some(p) => p.parse::<u16>().ok().filter(|p| *p > 0)?,
        None if tls => 443,
        None => 80,
    };
    (!host.is_empty()).then_some((tls, host.to_ascii_lowercase(), port))
}

/// The real mailbox: HTTPS with the entry's pins (plain HTTP on loopback only), a fresh connection per request.
pub struct HttpsMailbox {
    url: String,
    host: String,
    port: u16,
    tls: Option<Arc<ClientConfig>>,
    spki: Option<String>,
}

impl HttpsMailbox {
    pub fn new(relay: &ApiRelay) -> Result<HttpsMailbox, String> {
        let (https, host, port) = origin_parts(&relay.url).ok_or_else(|| format!("{} is not a relay URL", relay.url))?;
        if !https && !LOOPBACK_HOSTS.contains(&host.as_str()) && host != "::1" {
            return Err(format!("{}: a relay must be https unless it is on loopback", relay.url));
        }
        let tls = if https {
            let mut roots = RootCertStore::empty();
            match &relay.ca {
                Some(pem) => {
                    for c in rustls_pemfile::certs(&mut pem.as_bytes()) {
                        roots.add(c.map_err(|e| format!("{}: its pinned certificate does not read: {e}", relay.url))?).map_err(|e| format!("{}: its pinned certificate is not usable: {e}", relay.url))?;
                    }
                }
                None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
            }
            let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .with_root_certificates(roots)
                .with_no_client_auth();
            Some(Arc::new(cfg))
        } else {
            None
        };
        Ok(HttpsMailbox { url: relay.url.clone(), host, port, tls, spki: relay.spki.clone() })
    }
}

impl Mailbox for HttpsMailbox {
    fn url(&self) -> &str {
        &self.url
    }

    fn exchange(&self, method: &str, path: &str, headers: &[(&'static str, String)], body: Option<&[u8]>) -> Result<(u16, Vec<u8>), String> {
        let answer = match &self.tls {
            Some(cfg) => {
                let pin = self.spki.clone();
                let check = move |peer: &[u8]| -> Result<(), String> {
                    let Some(pin) = &pin else { return Ok(()) };
                    // a runtime that hands over no certificate fails the pin: closed, never open
                    let got = crate::meet_x509::Cert::from_der(peer).map(|c| b64u(&sha256(&c.spki))).unwrap_or_default();
                    if got == *pin {
                        Ok(())
                    } else {
                        Err("the relay's TLS key does not match the pinned spki".to_string())
                    }
                };
                crate::meet_tls::https_request_capped(cfg, &self.host, self.port, TIMEOUT_S, method, path, headers, body, &check, REPLY_CAP_BYTES)
            }
            None => crate::meet_tls::http_request_capped(&self.host, self.port, TIMEOUT_S, method, path, headers, body, REPLY_CAP_BYTES),
        };
        match answer {
            Ok(r) => Ok((r.status, r.body)),
            // the pin's refusal, or the cap's ("reply too large")
            Err(Ok(m)) => Err(format!("{}: {m}", self.url)),
            Err(Err(m)) => Err(format!("{} cannot be reached ({m})", self.url)),
        }
    }
}

// ── the signed client (relay.ts RelayClient) ────────────────────────────────────────────────────────────────

/// One relay, every request signed for it by the service hub's node key.
pub struct RelayClient {
    mailbox: Arc<dyn Mailbox>,
    audience: String,
    key: Arc<NodeKey>,
    /// The service hub's certificate (a renewed one is installed with `spokes-install` and taken at the next start).
    cert: String,
    seat: Option<String>,
    /// The `cert_sha256` this relay has registered for the certificate, once it answered 200.
    registered: Mutex<Option<String>>,
}

impl RelayClient {
    pub fn new(mailbox: Arc<dyn Mailbox>, key: Arc<NodeKey>, cert: &str, seat: Option<String>) -> Result<RelayClient, String> {
        let audience = audience_of(mailbox.url()).ok_or_else(|| format!("{} is not a relay URL", mailbox.url()))?;
        Ok(RelayClient { mailbox, audience, key, cert: cert.to_owned(), seat, registered: Mutex::new(None) })
    }

    pub fn url(&self) -> &str {
        self.mailbox.url()
    }

    fn raw(&self, method: &str, path: &str, text: &[u8], cert: &str, hashed: bool, now_ms: i64) -> Result<(u16, Option<Map<String, Value>>), RelayError> {
        let nonce = random_hex(16).map_err(|m| RelayError::new(0, m))?;
        let auth = authorization(&self.key, cert, hashed, &self.audience, method, path, text, now_ms, &nonce).map_err(|m| RelayError::new(0, m))?;
        let mut headers: Vec<(&'static str, String)> = vec![("Authorization", auth)];
        if let Some(seat) = &self.seat {
            headers.push((crate::license::SEAT_HEADER, seat.clone()));
        }
        if !text.is_empty() {
            headers.push(("Content-Type", "application/json".to_string()));
        }
        let (status, body) = self.mailbox.exchange(method, path, &headers, (!text.is_empty()).then_some(text)).map_err(|m| RelayError::new(0, m))?;
        if body.len() > REPLY_CAP_BYTES {
            return Err(RelayError::new(0, format!("{}: reply too large", self.url())));
        }
        let data = serde_json::from_slice::<Value>(&body).ok().and_then(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        });
        Ok((status, data))
    }

    /// `POST /v1/node/cert {cert}`: None once the relay holds `cert`, else its answer.
    fn register(&self, cert: &str, sha: &str, now_ms: i64) -> Result<Option<(u16, Option<Map<String, Value>>)>, RelayError> {
        let body = stringify(&json!({ "cert": cert }));
        let r = self.raw("POST", REGISTER_PATH, body.as_bytes(), cert, true, now_ms)?;
        if r.0 != 200 || r.1.as_ref().and_then(|d| str_of(d.get("cert_sha256"))) != Some(sha) {
            return Ok(Some(r));
        }
        *self.registered.lock() = Some(sha.to_owned());
        Ok(None)
    }

    /// Every request: the legacy header, or the hash form for a certificate too long for it (contract 5.5).
    fn call(&self, method: &str, path: &str, body: Option<&Value>, now_ms: i64) -> Result<(u16, Option<Map<String, Value>>), RelayError> {
        let text = body.map(stringify).unwrap_or_default();
        let cert = self.cert.as_str();
        if cert.len() <= LEGACY_HEADER_CERT_MAX && !is_renewed_leaf(cert) {
            return self.raw(method, path, text.as_bytes(), cert, false, now_ms);
        }
        let sha = sha256_hex(cert.as_bytes());
        if self.registered.lock().as_deref() != Some(sha.as_str()) {
            if let Some(refused) = self.register(&cert, &sha, now_ms)? {
                return Ok(refused);
            }
        }
        let r = self.raw(method, path, text.as_bytes(), &cert, true, now_ms)?;
        if r.0 != 401 {
            return Ok(r);
        }
        *self.registered.lock() = None;
        match self.register(&cert, &sha, now_ms)? {
            Some(refused) => Ok(refused),
            None => self.raw(method, path, text.as_bytes(), &cert, true, now_ms),
        }
    }

    fn refused(status: u16, data: &Option<Map<String, Value>>, what: &str) -> RelayError {
        RelayError::new(status, data.as_ref().and_then(|d| str_of(d.get("error"))).map(str::to_owned).unwrap_or_else(|| format!("{what} failed")))
    }

    /// `POST /v1/send`.
    pub fn send(&self, env: &Envelope, now_ms: i64) -> Result<(), RelayError> {
        let (status, data) = self.call("POST", "/v1/send", Some(&env.to_json()), now_ms)?;
        if status != 200 {
            return Err(Self::refused(status, &data, "send"));
        }
        Ok(())
    }

    /// `GET /v1/inbox`: one batch of waiting envelopes, oldest first (malformed ones dropped), and whether more wait.
    pub fn inbox(&self, now_ms: i64) -> Result<(Vec<Envelope>, bool), RelayError> {
        let (status, data) = self.call("GET", "/v1/inbox", None, now_ms)?;
        let messages = data.as_ref().and_then(|d| d.get("messages")).and_then(Value::as_array).filter(|_| status == 200).ok_or_else(|| Self::refused(status, &data, "inbox"))?;
        let envs = messages.iter().filter_map(Envelope::parse).collect();
        Ok((envs, data.as_ref().and_then(|d| d.get("more")) == Some(&Value::Bool(true))))
    }

    /// `POST /v1/ack {ids}`.
    pub fn ack(&self, ids: &[String], now_ms: i64) -> Result<(), RelayError> {
        if ids.is_empty() {
            return Ok(());
        }
        let (status, data) = self.call("POST", "/v1/ack", Some(&json!({ "ids": ids })), now_ms)?;
        if status != 200 {
            return Err(Self::refused(status, &data, "ack"));
        }
        Ok(())
    }

    /// `GET /v1/crl`: the relay's CRL with the items it anchors, or None when it holds no CRL.
    pub fn bundle(&self, now_ms: i64) -> Result<Option<Bundle>, RelayError> {
        let (status, data) = self.call("GET", "/v1/crl", None, now_ms)?;
        let Some(mut rest) = data.filter(|_| status == 200) else { return Err(RelayError::new(status, "crl failed")) };
        rest.remove("ok");
        if rest.get("crl").is_none_or(Value::is_null) {
            return Ok(None);
        }
        parse_bundle(Some(&Value::Object(rest))).map(Some).ok_or_else(|| RelayError::new(0, "crl failed: not a well-formed bundle"))
    }

    /// `GET /v1/directory`: the relay's root-signed directory token, if it holds one.
    pub fn directory(&self, now_ms: i64) -> Result<Option<String>, RelayError> {
        let (status, data) = self.call("GET", "/v1/directory", None, now_ms)?;
        if status != 200 {
            return Err(Self::refused(status, &data, "directory"));
        }
        Ok(data.as_ref().and_then(|d| str_of(d.get("directory"))).map(str::to_owned))
    }

    /// `GET /v1/presence`, every page up to PRESENCE_PAGES_MAX pages and PRESENCE_ROWS_MAX rows (a relay past either is
    /// refused, nothing taken): the spokes that polled this relay and each one's last poll (ms). A service hub sees
    /// only its targets (5.3 rule 10); malformed rows are dropped.
    pub fn presence(&self, now_ms: i64) -> Result<Vec<(String, i64)>, RelayError> {
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..PRESENCE_PAGES_MAX {
            let path = match &after {
                Some(a) => format!("/v1/presence?after={a}&limit={PRESENCE_PAGE}"),
                None => format!("/v1/presence?limit={PRESENCE_PAGE}"),
            };
            let (status, data) = self.call("GET", &path, None, now_ms)?;
            let rows = data.as_ref().and_then(|d| d.get("nodes")).and_then(Value::as_array).filter(|_| status == 200).ok_or_else(|| Self::refused(status, &data, "presence"))?;
            if out.len() + rows.len() > PRESENCE_ROWS_MAX {
                return Err(RelayError::new(0, format!("{}: presence lists more than {PRESENCE_ROWS_MAX} spokes", self.url())));
            }
            for row in rows {
                if let (Some(node), Some(at)) = (str_of(row.get("node")).filter(|n| is_node_id(n)), crate::codec::safe_int(row.get("lastPollAt"))) {
                    out.push((node.to_owned(), at));
                }
            }
            // pages only move forward: a `next` that does not would loop forever
            match data.as_ref().and_then(|d| str_of(d.get("next"))).filter(|n| is_node_id(n)) {
                Some(next) if after.as_deref().is_none_or(|a| next > a) => after = Some(next.to_owned()),
                _ => return Ok(out),
            }
        }
        Err(RelayError::new(0, format!("{}: presence runs past {PRESENCE_PAGES_MAX} pages", self.url())))
    }
}

/// Log one relay failure (no token, no envelope).
pub fn warn_relay(url: &str, what: &str, e: &RelayError) {
    log_warn(&format!("connector_spokes_relay_failed relay={url} call={what} status={} error={}", e.status, e.message));
}
