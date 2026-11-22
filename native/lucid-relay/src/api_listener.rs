// API-1 7.2 and 5.6 (docs/api/contract.md): the relay's API listener. TLS with an OPTIONAL client certificate
// (verified as on the Meet port when presented), HTTP/1.1, one thread per connection under the same connection caps
// as the guest port. For each org this relay serves that has a pinned unexpired api map, a `relay_origins` entry
// for this relay's fleet id and a provisioned pseudonym key (11.4), it serves the relay-local issuer (5.6): its
// RFC 8414 metadata, the protected resource metadata of RR, the local JWKS and `L/oauth/token`, which mints only the
// four read scopes with `aud` = RR. RR and L always come from the pinned map, never from the request's `Host`.
// Everything else answers 404 `not-found`. The resource routes (`RR/v1/*`) are the next slice.
//
// Until the 9.4 audit chain arrives (slice 1a3) each `Answer.event` of the issuer is logged as a security line.

use crate::api_issue::{self, ClientCert, IssueCtx, IssueState, TokenHttp};
use crate::api_map::ApiMapStore;
use crate::fleet_ca::{vault_do, VaultLock};
use crate::meet::{address_of, http_date, quiet_end, read_head, reason_phrase, Relay, Tls, SERVER_VERSION};
use crate::meet_hub::guests;
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use parking_lot::Mutex;
use rustls::ServerConfig;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// 7.2: `api_listen: true` listens here.
pub const DEFAULT_LISTEN: &str = "0.0.0.0:9443";
/// 5.6: the only scopes the relay-local issuer mints.
pub const LOCAL_SCOPES: [&str; 4] = ["monitor.read", "fleet.read", "audit.read", "events.subscribe"];
/// The folder of the relay-local token keys' records (`<org>.key`; the PKCS#8 keys themselves are sealed).
pub const LOCAL_KEY_DIR: &str = "api-local";
/// 5.6: a local token key signs for 90 days; the one it replaces stays in the JWKS 10 minutes more.
pub const KEY_ROTATE_S: i64 = 90 * 86_400;
pub const KEY_OVERLAP_S: i64 = 600;

const CONNECTIONS_MAX: usize = 256;
const CONNECTIONS_PER_ADDRESS: usize = 16;
const HANDSHAKE_TIMEOUT: f64 = 10.0;
const WRITE_TIMEOUT: f64 = 30.0;
const BODY_MAX: usize = 16 * 1024;
/// How long a fetched client JWKS or discovery document is reused.
const FETCH_MAX_AGE: Duration = Duration::from_secs(300);

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// relay.json `api_listen`: absent, null or false = off; true = `0.0.0.0:9443`; otherwise a `host:port` string
/// (an IPv6 host in brackets, a port from 1).
pub fn listen_setting(v: Option<&Value>) -> Result<Option<String>, String> {
    let refused = || "api_listen must be true, false or \"host:port\"".to_string();
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some(DEFAULT_LISTEN.to_string())),
        Some(Value::String(s)) => {
            let s = s.trim();
            let (host, port) = s.rsplit_once(':').ok_or_else(refused)?;
            let port_ok = port.parse::<u16>().is_ok_and(|p| p > 0);
            let host_ok = match host.strip_prefix('[') {
                Some(inner) => inner.strip_suffix(']').is_some_and(|h| h.parse::<std::net::Ipv6Addr>().is_ok()),
                None => !host.is_empty() && !host.contains(':') && !host.contains(char::is_whitespace),
            };
            if port_ok && host_ok {
                Ok(Some(s.to_string()))
            } else {
                Err(refused())
            }
        }
        Some(_) => Err(refused()),
    }
}

// ── what the listener reads of the relay ─────────────────────────────────────────────────────────────────────────

/// The relay as the listener sees it (the hub and fleet link in production, fixed values in tests).
pub trait Source: Send + Sync {
    /// This relay's fleet id (`fleet.json` `relayId`), None while not enrolled.
    fn relay_id(&self) -> Option<String>;
    /// A read-only copy of the org's api state, None when this relay does not serve the org.
    fn snapshot(&self, org: &str) -> Option<ApiMapStore>;
    /// The 1a2 owner rule (unknown means active).
    fn owner_active(&self, principal: &str) -> bool;
    /// 11.4: the org's pseudonym key is provisioned on this relay.
    fn pseudonym_ready(&self, org: &str) -> bool;
    /// Where the relay seals secrets (its console's vault), None while there is none.
    fn vault(&self) -> Option<Arc<dyn VaultLock>>;
    /// 6.1: the relay serves people under its license (service `on` or `grace`).
    fn licensed(&self) -> bool;
}

struct RelaySource {
    relay: Weak<Relay>,
    dir: PathBuf,
}

impl Source for RelaySource {
    fn relay_id(&self) -> Option<String> {
        let map = crate::fleet_agent::load_link_json(&self.dir).ok().flatten()?;
        Some(crate::fleet_agent::Link { map }.relay_id().to_string()).filter(|id| !id.is_empty())
    }

    fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
        self.relay.upgrade()?.hub.api_org_snapshot(org)
    }

    fn owner_active(&self, principal: &str) -> bool {
        self.relay.upgrade().is_none_or(|r| r.hub.api_owner_active(principal))
    }

    fn pseudonym_ready(&self, org: &str) -> bool {
        self.dir.join(crate::fleet_agent::API_PSEUDONYM_DIR).join(format!("{org}.json")).is_file()
    }

    fn vault(&self) -> Option<Arc<dyn VaultLock>> {
        let relay = self.relay.upgrade()?;
        let book = relay.fleet.get().map(|f| f.book.clone()).or_else(|| relay.admin_console.get().cloned())?;
        Some(book as Arc<dyn VaultLock>)
    }

    fn licensed(&self) -> bool {
        use crate::meet_license::Service;
        let gate = self.relay.upgrade().and_then(|r| r.hub.gate());
        gate.is_some_and(|g| matches!(g.service(), Service::On | Service::Grace))
    }
}

// ── relay-local token keys (5.6) ─────────────────────────────────────────────────────────────────────────────────

/// One relay-local token key.
pub struct LocalKey {
    pub pair: EcdsaKeyPair,
    pub kid: String,
    pub created: i64,
    gen: u64,
}

impl LocalKey {
    fn of_pkcs8(der: &[u8], gen: u64, created: i64) -> Option<LocalKey> {
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der).ok()?;
        let kid = local_kid(pair.public_key().as_ref());
        Some(LocalKey { pair, kid, created, gen })
    }
}

/// `l-` and the first 16 hex digits of the SHA-256 of the uncompressed public point.
pub fn local_kid(public_point: &[u8]) -> String {
    let digest = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, public_point);
    format!("l-{}", &crate::codec::hex(digest.as_ref())[..16])
}

/// The sealed name of an org's local token key generation.
pub fn local_seal_name(org: &str, gen: u64) -> String {
    format!("api-local-{org}-{gen}")
}

#[derive(Default)]
struct OrgKeys {
    current: Option<Arc<LocalKey>>,
    /// The replaced key and until when it stays in the JWKS.
    previous: Option<(Arc<LocalKey>, i64)>,
}

/// The relay-local keys of every org: drawn with AWS-LC at first use, the PKCS#8 sealed as
/// `api-local-<org>-<gen>` and the owner-only record `api-local/<org>.key` = `{gen, created, previous: {gen, created,
/// until} | null}` flushed to disk, rotated every 90 days.
pub struct KeyRing {
    dir: PathBuf,
    orgs: Mutex<HashMap<String, OrgKeys>>,
}

impl KeyRing {
    pub fn new(dir: &Path) -> KeyRing {
        KeyRing { dir: dir.to_path_buf(), orgs: Mutex::new(HashMap::new()) }
    }

    fn record_path(&self, org: &str) -> PathBuf {
        self.dir.join(LOCAL_KEY_DIR).join(format!("{org}.key"))
    }

    /// The org's signing key and every key its JWKS lists at `now` (signing key first).
    pub fn keys(&self, org: &str, vault: &dyn VaultLock, now: i64) -> Result<(Arc<LocalKey>, Vec<Arc<LocalKey>>), String> {
        let mut orgs = self.orgs.lock();
        let held = orgs.entry(org.to_string()).or_default();
        if held.current.is_none() {
            *held = self.load(org, vault);
        }
        if held.previous.as_ref().is_some_and(|(_, until)| *until <= now) {
            held.previous = None;
        }
        let due = held.current.as_ref().is_none_or(|k| now - k.created >= KEY_ROTATE_S);
        if due {
            let old = held.current.take();
            let gen = old.as_ref().map_or(0, |k| k.gen).max(held.previous.as_ref().map_or(0, |(k, _)| k.gen)) + 1;
            let fresh = self.draw(org, gen, now, vault)?;
            let previous = old.map(|k| (k, now + KEY_OVERLAP_S));
            self.save(org, &fresh, previous.as_ref())?;
            // the generation before the replaced one is no longer listed anywhere
            if let Some((gone, _)) = held.previous.take() {
                vault_do(vault, |v| {
                    let _ = v.remove(&local_seal_name(org, gone.gen));
                });
            }
            held.current = Some(fresh);
            held.previous = previous;
        }
        let current = held.current.clone().expect("a current key");
        let mut listed = vec![current.clone()];
        listed.extend(held.previous.as_ref().map(|(k, _)| k.clone()));
        Ok((current, listed))
    }

    /// The keys on disk (none when the record or a sealed key does not read back).
    fn load(&self, org: &str, vault: &dyn VaultLock) -> OrgKeys {
        let Some(rec) = std::fs::read(self.record_path(org)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return OrgKeys::default() };
        let unseal = |gen: u64, created: i64| -> Option<Arc<LocalKey>> {
            let der = vault_do(vault, |v| v.get(&local_seal_name(org, gen)))?;
            LocalKey::of_pkcs8(&der, gen, created).map(Arc::new)
        };
        let int = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64);
        let current = rec.get("gen").and_then(Value::as_u64).zip(int(&rec, "created")).and_then(|(g, c)| unseal(g, c));
        let previous = rec.get("previous").filter(|p| p.is_object()).and_then(|p| {
            let key = unseal(p.get("gen")?.as_u64()?, int(p, "created")?)?;
            Some((key, int(p, "until")?))
        });
        if current.is_none() {
            crate::meet::log_warn(&format!("api local key unreadable org={org}; a new one is drawn"));
        }
        OrgKeys { current, previous }
    }

    fn draw(&self, org: &str, gen: u64, now: i64, vault: &dyn VaultLock) -> Result<Arc<LocalKey>, String> {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).map_err(|_| "the local token key could not be drawn".to_string())?;
        let der = pair.to_pkcs8v1().map_err(|_| "the local token key could not be encoded".to_string())?;
        let key = LocalKey::of_pkcs8(der.as_ref(), gen, now).ok_or("the local token key does not read back")?;
        vault_do(vault, |v| v.put(&local_seal_name(org, gen), der.as_ref())).map_err(|e| format!("the local token key could not be sealed: {e}"))?;
        Ok(Arc::new(key))
    }

    fn save(&self, org: &str, current: &LocalKey, previous: Option<&(Arc<LocalKey>, i64)>) -> Result<(), String> {
        let previous = previous.map_or(Value::Null, |(k, until)| json!({"gen": k.gen, "created": k.created, "until": until}));
        let record = json!({"gen": current.gen, "created": current.created, "previous": previous});
        crate::store::make_dir(&self.dir.join(LOCAL_KEY_DIR)).map_err(|e| format!("the local key folder could not be made: {e}"))?;
        let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        crate::fleet_local::write_durable(&self.record_path(org), &bytes)
    }
}

// ── requests and answers ─────────────────────────────────────────────────────────────────────────────────────────

/// One request as the routes see it.
pub struct Req<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub form: &'a [u8],
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
    pub client_cert: Option<&'a ClientCert>,
    pub source: IpAddr,
}

/// One answer: status, extra headers and a JSON body.
pub struct Resp {
    pub status: u16,
    pub ctype: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

/// 8.2: a refusal under `/api/orgs/` (problem+json with the console convention's fields).
fn problem(status: u16, code: &str, sentence: &str) -> Resp {
    let body = json!({
        "ok": false, "code": code, "error": sentence,
        "type": format!("https://lucid.emertins.com/problems/{code}"), "title": reason_phrase(status), "status": status, "detail": sentence,
    });
    Resp { status, ctype: "application/problem+json", headers: vec![("Cache-Control", "no-store".into())], body }
}

fn not_found() -> Resp {
    problem(404, "not-found", "Nothing is here.")
}

fn license_refused() -> Resp {
    problem(403, "license", "This relay is not serving under a license right now.")
}

fn public(body: Value) -> Resp {
    Resp { status: 200, ctype: "application/json", headers: vec![("Cache-Control", "max-age=300".into())], body }
}

/// An org id as maps carry it.
fn org_ok(org: &str) -> bool {
    (1..=32).contains(&org.len()) && org.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// What one org's routes need, all from the pinned map.
struct OrgView {
    store: ApiMapStore,
    /// RR.
    resource: String,
    /// L.
    local: String,
    /// I.
    issuer: String,
}

/// A known org: served normally, or with its map set aside by the license edition (403 `map-edition`).
enum Org {
    Live(OrgView),
    SetAside,
}

enum Route<'a> {
    AsMetadata(&'a str),
    ResourceMetadata(&'a str),
    Jwks(&'a str),
    Token(&'a str),
}

fn route_of<'a>(method: &str, path: &'a str) -> Option<Route<'a>> {
    let one = |rest: &'a str| Some(rest).filter(|o| !o.contains('/'));
    if method == "GET" {
        if let Some(org) = path.strip_prefix("/.well-known/oauth-authorization-server/api/orgs/").and_then(|r| r.strip_suffix("/local")) {
            return one(org).map(Route::AsMetadata);
        }
        if let Some(org) = path.strip_prefix("/.well-known/oauth-protected-resource/api/orgs/") {
            return one(org).map(Route::ResourceMetadata);
        }
        if let Some(org) = path.strip_prefix("/api/orgs/").and_then(|r| r.strip_suffix("/local/jwks.json")) {
            return one(org).map(Route::Jwks);
        }
    }
    if method == "POST" {
        if let Some(org) = path.strip_prefix("/api/orgs/").and_then(|r| r.strip_suffix("/local/oauth/token")) {
            return one(org).map(Route::Token);
        }
    }
    None
}

/// The listener's routes over a `Source`; independent of the socket.
pub struct Api {
    source: Box<dyn Source>,
    keys: KeyRing,
    state: IssueState,
    fetch: crate::api_fetch::FetchCache,
    /// The security logger for `Answer.event` (interim until the 9.4 audit chain, slice 1a3).
    log: Box<dyn Fn(&str, &Value) + Send + Sync>,
}

impl Api {
    pub fn new(source: Box<dyn Source>, dir: &Path, log: Box<dyn Fn(&str, &Value) + Send + Sync>) -> Api {
        Api { source, keys: KeyRing::new(dir), state: IssueState::new(), fetch: crate::api_fetch::FetchCache::new(FETCH_MAX_AGE), log }
    }

    /// 5.6: the org's view when it has a pinned unexpired map, this relay's origin in it and a pseudonym key; an org
    /// served with a pseudonym key whose map the license edition set aside is known but `SetAside`.
    fn view(&self, org: &str, now: i64) -> Option<Org> {
        if !org_ok(org) {
            return None;
        }
        let id = self.source.relay_id()?;
        let store = self.source.snapshot(org)?;
        if store.is_set_aside(org) {
            return self.source.pseudonym_ready(org).then_some(Org::SetAside);
        }
        let (origin, issuer) = {
            let vm = store.get(org, "").filter(|m| m.expires > now)?;
            let map = vm.map();
            let origin = map.get("relay_origins").and_then(|r| r.get(&id)).and_then(Value::as_str).filter(|o| !o.is_empty())?.trim_end_matches('/').to_string();
            let issuer = map.get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).unwrap_or_default().to_string();
            (origin, issuer)
        };
        if !self.source.pseudonym_ready(org) {
            return None;
        }
        let resource = format!("{origin}/api/orgs/{org}");
        let local = format!("{resource}/local");
        Some(Org::Live(OrgView { store, resource, local, issuer }))
    }

    /// 6.5 source limiter, then the license (6.1): the refusal, if any.
    fn admit(&self, req: &Req, now: i64) -> Option<Resp> {
        if let Err(retry) = self.state.source_ok(req.source, now) {
            let mut r = problem(429, "abuse", "Too many requests from this address; try again later.");
            r.headers.push(("Retry-After", retry.max(1).to_string()));
            return Some(r);
        }
        (!self.source.licensed()).then(license_refused)
    }

    pub fn answer(&self, req: &Req, now: i64) -> Resp {
        let Some(route) = route_of(req.method, req.path) else { return not_found() };
        let org = match route {
            Route::AsMetadata(o) | Route::ResourceMetadata(o) | Route::Jwks(o) | Route::Token(o) => o,
        };
        let view = match self.view(org, now) {
            None => return not_found(),
            // 13: a map the license edition does not allow is set aside: every route of the org, documents included
            Some(Org::SetAside) => return self.admit(req, now).unwrap_or_else(|| problem(403, "map-edition", "This organization's API map is not allowed under this relay's license edition.")),
            Some(Org::Live(v)) => v,
        };
        if let Route::Token(_) = route {
            // the token pipeline charges the source limiter and checks the license itself
            return self.token(org, &view, req, now);
        }
        // 6.1 Public: org known, then the source limiter
        if let Some(refused) = self.admit(req, now) {
            return refused;
        }
        match route {
            Route::AsMetadata(_) => public(api_issue::as_metadata(&view.local, &format!("{}/oauth/token", view.local), None, &format!("{}/jwks.json", view.local))),
            Route::ResourceMetadata(_) => public(api_issue::resource_metadata(&view.resource, &[view.issuer.as_str(), view.local.as_str()], &LOCAL_SCOPES)),
            _ => match self.signing(org, now) {
                Ok((_, listed)) => public(api_issue::jwks(&listed.iter().map(|k| api_issue::ec_public_jwk(&k.pair, &k.kid)).collect::<Vec<_>>())),
                Err(r) => r,
            },
        }
    }

    fn signing(&self, org: &str, now: i64) -> Result<(Arc<LocalKey>, Vec<Arc<LocalKey>>), Resp> {
        let unavailable = || problem(503, "unavailable", "This relay cannot issue tokens right now.");
        let vault = self.source.vault().ok_or_else(unavailable)?;
        self.keys.keys(org, &*vault, now).map_err(|e| {
            crate::meet::log_error(&format!("api local key org={org}: {e}"));
            unavailable()
        })
    }

    fn token(&self, org: &str, view: &OrgView, req: &Req, now: i64) -> Resp {
        let (key, _) = match self.signing(org, now) {
            Ok(k) => k,
            Err(r) => return r,
        };
        let resources = [view.resource.clone()];
        let endpoint = format!("{}/oauth/token", view.local);
        let owner_active = |p: &str| self.source.owner_active(p);
        let ctx = IssueCtx {
            org,
            issuer: &view.local,
            token_endpoint: &endpoint,
            resources: &resources,
            local_scopes: Some(&LOCAL_SCOPES[..]),
            key: &key.pair,
            kid: &key.kid,
            store: &view.store,
            owner_active: &owner_active,
            fetch: &self.fetch,
            state: &self.state,
            licensed: self.source.licensed(),
            now,
        };
        let http = TokenHttp { form: req.form, authorization: req.authorization, dpop: req.dpop, client_cert: req.client_cert, source: req.source };
        let a = api_issue::token(&ctx, &http);
        if let Some((name, fields)) = &a.event {
            (self.log)(name, fields);
        }
        Resp { status: a.status, ctype: "application/json", headers: a.headers, body: a.body }
    }
}

// ── the socket ───────────────────────────────────────────────────────────────────────────────────────────────────

struct Port {
    api: Api,
    /// Where the client CA and the CRL in force are read for each presented certificate.
    settings: crate::meet::Settings,
    tls: Arc<ServerConfig>,
    open: Mutex<HashMap<String, usize>>,
    total: AtomicUsize,
    refusals: crate::meet_tls::RefusalLog,
}

/// The relay's security logger for an issuer event.
fn security_line(name: &str, fields: &Value) {
    let mut f = crate::log::Fields::new();
    for (k, v) in fields.as_object().into_iter().flatten() {
        f = f.with(k, v.clone());
    }
    let level = if name == "api.refusal" { crate::log::Level::Warn } else { crate::log::Level::Info };
    crate::console_meet::logger().security(name, &f, level);
}

/// Start the API listener on its own thread (nothing when `api_listen` is off).
pub fn start(relay: &Arc<Relay>) -> Result<(), String> {
    let s = &relay.settings;
    let Some(listen) = s.api_listen.clone() else { return Ok(()) };
    if s.state_dir.is_empty() {
        return Err("api_listen needs state_dir".into());
    }
    let dir = PathBuf::from(&s.state_dir);
    let tls = crate::meet_tls::api_tls_config(s)?;
    let listener = TcpListener::bind(listen.as_str()).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    let source = RelaySource { relay: Arc::downgrade(relay), dir: dir.clone() };
    let api = Api::new(Box::new(source), &dir, Box::new(security_line));
    let port = Arc::new(Port { api, settings: s.clone(), tls, open: Mutex::new(HashMap::new()), total: AtomicUsize::new(0), refusals: crate::meet_tls::RefusalLog::new() });
    std::thread::Builder::new()
        .name("relay-api-port".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let address = address_of(&peer);
                let Some(slot) = Slot::take(&port, &address) else {
                    port.refusals.note(&address);
                    continue;
                };
                let _ = std::thread::Builder::new().name("relay-api".into()).spawn(move || {
                    serve(&slot.port, tcp, &address, peer.ip());
                    drop(slot);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    crate::meet::log_info(&format!("API listening on {listen}"));
    Ok(())
}

/// One connection's place under the port's limits, given back when it ends.
struct Slot {
    port: Arc<Port>,
    key: String,
}

impl Slot {
    fn take(port: &Arc<Port>, address: &str) -> Option<Slot> {
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

fn serve(port: &Port, mut tcp: TcpStream, address: &str, ip: IpAddr) {
    let _ = tcp.set_read_timeout(Some(Duration::from_secs_f64(HANDSHAKE_TIMEOUT)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs_f64(WRITE_TIMEOUT)));
    let Ok(mut conn) = rustls::ServerConnection::new(port.tls.clone()) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            port.refusals.note(address);
            return;
        }
    }
    // a presented certificate passed the client CA (and grace) in the handshake; it counts for the API only once a
    // current CRL was checked for it, otherwise it is treated as not presented (mTLS fails `client-auth`)
    let now = crate::meet_json::now() as i64;
    let cert = conn
        .peer_certificates()
        .and_then(|c| c.split_first())
        .filter(|(leaf, rest)| crate::meet_tls::api_cert_revocation_checked(&port.settings, leaf.as_ref(), rest, now))
        .and_then(|(leaf, _)| ClientCert::of_leaf(leaf.as_ref(), true));
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    loop {
        match one(port, &mut reader, ip, cert.as_ref()) {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                if !quiet_end(&e) {
                    port.refusals.note(address);
                }
                break;
            }
        }
    }
    let tls = reader.get_mut();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

fn request_id() -> String {
    let mut b = [0u8; 8];
    let _ = aws_lc_rs::rand::fill(&mut b);
    crate::codec::hex(&b)
}

fn write(w: &mut Tls, r: &Resp) -> std::io::Result<()> {
    let body = serde_json::to_vec(&r.body).unwrap_or_default();
    let mut head = format!("HTTP/1.1 {} {}\r\nServer: {SERVER_VERSION}\r\nDate: {}\r\n", r.status, reason_phrase(r.status), http_date());
    let fixed = [
        ("Content-Type", r.ctype.to_string()),
        ("Content-Length", body.len().to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Strict-Transport-Security", "max-age=31536000".to_string()),
        ("X-Lucid-Request-Id", request_id()),
    ];
    for (k, v) in fixed.iter().map(|(k, v)| (*k, v)).chain(r.headers.iter().map(|(k, v)| (*k, v))) {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    w.write_all(&out)?;
    w.flush()
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>, ip: IpAddr, cert: Option<&ClientCert>) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let (path, _query) = head.path_query();
    if head.header("transfer-encoding").is_some_and(|v| !v.is_empty()) {
        write(reader.get_mut(), &problem(411, "bad-request", "Send the body with a Content-Length."))?;
        return Ok(false);
    }
    let length = match head.header("content-length").map(|l| l.trim().parse::<usize>()) {
        None => 0,
        Some(Ok(n)) => n,
        Some(Err(_)) => {
            write(reader.get_mut(), &problem(400, "bad-request", "The Content-Length is not a number."))?;
            return Ok(false);
        }
    };
    if length > BODY_MAX {
        write(reader.get_mut(), &problem(413, "too-large", "The body is larger than 16 KiB."))?;
        return Ok(false);
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let (authorization, dpop) = (head.header("authorization"), head.header("dpop"));
    let req = Req { method: &head.method, path: &path, form: &body, authorization: authorization.as_deref(), dpop: dpop.as_deref(), client_cert: cert, source: ip };
    let resp = port.api.answer(&req, crate::meet_json::now() as i64);
    write(reader.get_mut(), &resp)?;
    Ok(!head.close)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_map::VerifiedApiMap;
    use crate::fleet_ca::MemVault;

    const NOW: i64 = 1_795_000_000;
    const ORIGIN: &str = "https://relay1.acme.example:9443";
    const RR: &str = "https://relay1.acme.example:9443/api/orgs/acme";
    const L: &str = "https://relay1.acme.example:9443/api/orgs/acme/local";
    const I: &str = "https://console.acme.example/api/orgs/acme";
    /// Past one key rotation plus its overlap, so the rotation tests run under a live map.
    const MAP_EXPIRES: i64 = NOW + 120 * 86_400;

    struct TestSource {
        store: ApiMapStore,
        vault: Arc<parking_lot::Mutex<MemVault>>,
        pseudonym: bool,
        licensed: bool,
    }

    impl Source for TestSource {
        fn relay_id(&self) -> Option<String> {
            Some("r_01".into())
        }
        fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
            (org == "acme").then(|| self.store.org_snapshot(org))
        }
        fn owner_active(&self, _: &str) -> bool {
            true
        }
        fn pseudonym_ready(&self, _: &str) -> bool {
            self.pseudonym
        }
        fn vault(&self) -> Option<Arc<dyn VaultLock>> {
            Some(self.vault.clone() as Arc<dyn VaultLock>)
        }
        fn licensed(&self) -> bool {
            self.licensed
        }
    }

    fn client_key() -> EcdsaKeyPair {
        EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap()
    }

    fn client(key: &EcdsaKeyPair) -> Value {
        let point = key.public_key().as_ref();
        let (x, y) = (crate::codec::b64u(&point[1..33]), crate::codec::b64u(&point[33..65]));
        json!({"id": "c_mon", "name": "monitor", "principal": "monitor@apps.acme.example", "kind": "monitoring",
               "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read", "audit.read", "people.read"], "ceiling": "internal",
               "relays": ["*"], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 120, "per_day_each": 100000},
               "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": x, "y": y}, "expires": NOW + 90 * 86_400}],
               "created": NOW - 86_400, "expires": NOW + 300 * 86_400, "state": "active"})
    }

    fn store(key: &EcdsaKeyPair, origins: Value) -> ApiMapStore {
        let map = json!({"v": 1, "org": "acme", "seq": 1, "issued": NOW - 60, "expires": MAP_EXPIRES,
                         "issuer": {"url": I, "jwks": []}, "relay_origins": origins, "clients": [client(key)], "scrape_tokens": []});
        let hash = crate::api_map::api_map_hash(&map);
        let wire = json!({"map": map}).as_object().unwrap().clone();
        let mut s = ApiMapStore::load(None);
        s.pin(VerifiedApiMap { wire, org: "acme".into(), seq: 1, expires: MAP_EXPIRES, hash, signer: "root".into() }).unwrap();
        s
    }

    fn api_with(origins: Value, pseudonym: bool, licensed: bool, dir: &Path) -> (Api, EcdsaKeyPair, Arc<Mutex<Vec<(String, Value)>>>) {
        let key = client_key();
        let source = TestSource { store: store(&key, origins), vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym, licensed };
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let api = Api::new(Box::new(source), dir, Box::new(move |n: &str, v: &Value| sink.lock().push((n.to_string(), v.clone()))));
        (api, key, lines)
    }

    fn api(dir: &Path) -> (Api, EcdsaKeyPair, Arc<Mutex<Vec<(String, Value)>>>) {
        api_with(json!({"r_01": ORIGIN}), true, true, dir)
    }

    /// A DPoP proof for the local token endpoint under a fresh key.
    fn dpop_proof() -> String {
        let pair = client_key();
        let point = pair.public_key().as_ref();
        let jwk = json!({"kty": "EC", "crv": "P-256", "x": crate::codec::b64u(&point[1..33]), "y": crate::codec::b64u(&point[33..65])});
        let claims = json!({"jti": request_id(), "htm": "POST", "htu": format!("{L}/oauth/token"), "iat": NOW});
        crate::api_token::sign_es256(&pair, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": jwk}), &claims).unwrap()
    }

    fn token_req<'a>(form: &'a str, dpop: Option<&'a str>) -> Req<'a> {
        Req { method: "POST", path: "/api/orgs/acme/local/oauth/token", form: form.as_bytes(), authorization: None, dpop, client_cert: None, source: "10.40.0.7".parse().unwrap() }
    }

    fn get<'a>(path: &'a str) -> Req<'a> {
        Req { method: "GET", path, form: b"", authorization: None, dpop: None, client_cert: None, source: "10.40.0.7".parse().unwrap() }
    }

    fn enc(s: &str) -> String {
        s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
    }

    fn token_form(key: &EcdsaKeyPair, scope: &str) -> String {
        let header = json!({"alg": "ES256", "typ": "JWT", "kid": "k1"});
        let claims = json!({"iss": "c_mon", "sub": "c_mon", "aud": format!("{L}/oauth/token"), "iat": NOW, "exp": NOW + 60, "jti": request_id()});
        let assertion = crate::api_token::sign_es256(key, &header, &claims).unwrap();
        format!(
            "grant_type=client_credentials&client_id=c_mon&client_assertion_type={}&client_assertion={assertion}&scope={}&resource={}",
            enc("urn:ietf:params:oauth:client-assertion-type:jwt-bearer"),
            enc(scope),
            enc(RR)
        )
    }

    struct Tmp(PathBuf);

    impl Tmp {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp() -> Tmp {
        let d = std::env::temp_dir().join(format!("lucid-api-listener-{}", request_id()));
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }

    #[test]
    fn listen_setting_shapes() {
        assert_eq!(listen_setting(None).unwrap(), None);
        assert_eq!(listen_setting(Some(&Value::Null)).unwrap(), None);
        assert_eq!(listen_setting(Some(&json!(false))).unwrap(), None);
        assert_eq!(listen_setting(Some(&json!(true))).unwrap().as_deref(), Some("0.0.0.0:9443"));
        assert_eq!(listen_setting(Some(&json!("127.0.0.1:8443"))).unwrap().as_deref(), Some("127.0.0.1:8443"));
        assert_eq!(listen_setting(Some(&json!("[::]:9443"))).unwrap().as_deref(), Some("[::]:9443"));
        for bad in [json!(9443), json!("9443"), json!("host:0"), json!("host:x"), json!(":9443"), json!("::1:9443"), json!({"host": "a"}), json!([])] {
            assert!(listen_setting(Some(&bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn unknown_org_and_paths_are_not_found() {
        let dir = tmp();
        let (api, ..) = api(dir.path());
        for path in [
            "/.well-known/oauth-protected-resource/api/orgs/beta",
            "/.well-known/oauth-authorization-server/api/orgs/beta/local",
            "/api/orgs/beta/local/jwks.json",
            "/api/orgs/acme/v1/health",
            "/",
            "/.well-known/oauth-protected-resource/api/orgs/acme/extra",
        ] {
            let r = api.answer(&get(path), NOW);
            assert_eq!((r.status, r.body["code"].as_str()), (404, Some("not-found")), "{path}");
        }
    }

    #[test]
    fn org_without_origin_pseudonym_or_live_map_is_not_found() {
        let path = "/.well-known/oauth-protected-resource/api/orgs/acme";
        let dir = tmp();
        let (other, ..) = api_with(json!({"r_02": ORIGIN}), true, true, dir.path());
        assert_eq!(other.answer(&get(path), NOW).status, 404);
        let (no_key, ..) = api_with(json!({"r_01": ORIGIN}), false, true, dir.path());
        assert_eq!(no_key.answer(&get(path), NOW).status, 404);
        let (expired, ..) = api(dir.path());
        assert_eq!(expired.answer(&get(path), MAP_EXPIRES).status, 404);
    }

    #[test]
    fn set_aside_map_answers_map_edition_on_every_route() {
        let dir = tmp();
        let key = client_key();
        let mut aside = store(&key, json!({"r_01": ORIGIN}));
        assert_eq!(aside.revalidate(None), ["acme"]);
        let source = TestSource { store: aside, vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym: true, licensed: true };
        let api = Api::new(Box::new(source), dir.path(), Box::new(|_: &str, _: &Value| {}));
        for path in ["/.well-known/oauth-protected-resource/api/orgs/acme", "/.well-known/oauth-authorization-server/api/orgs/acme/local", "/api/orgs/acme/local/jwks.json"] {
            let r = api.answer(&get(path), NOW);
            assert_eq!((r.status, r.body["code"].as_str()), (403, Some("map-edition")), "{path}");
        }
        let (form, proof) = (token_form(&key, "monitor.read"), dpop_proof());
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!((r.status, r.body["code"].as_str()), (403, Some("map-edition")), "{}", r.body);
        assert_eq!(api.answer(&get("/.well-known/oauth-protected-resource/api/orgs/beta"), NOW).status, 404);
    }

    #[test]
    fn unlicensed_relay_refuses_documents_and_tokens() {
        let dir = tmp();
        let (api, key, _) = api_with(json!({"r_01": ORIGIN}), true, false, dir.path());
        for path in ["/.well-known/oauth-protected-resource/api/orgs/acme", "/.well-known/oauth-authorization-server/api/orgs/acme/local", "/api/orgs/acme/local/jwks.json"] {
            let r = api.answer(&get(path), NOW);
            assert_eq!((r.status, r.body["code"].as_str()), (403, Some("license")), "{path}");
        }
        let (form, proof) = (token_form(&key, "monitor.read"), dpop_proof());
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!((r.status, r.body["code"].as_str()), (403, Some("license")), "{}", r.body);
        assert!(r.body.get("access_token").is_none());
        // an unknown org stays 404 whatever the license
        assert_eq!(api.answer(&get("/.well-known/oauth-protected-resource/api/orgs/beta"), NOW).status, 404);
    }

    #[test]
    fn metadata_uses_the_map_origin_even_when_the_host_differs() {
        // a request's Host never reaches the routes (Req has no such field): whatever name the client dialed, the
        // documents name the map's origin for this relay
        let dir = tmp();
        let (api, ..) = api(dir.path());
        let r = api.answer(&get("/.well-known/oauth-authorization-server/api/orgs/acme/local"), NOW);
        assert_eq!(r.status, 200);
        assert_eq!(r.body["issuer"], L);
        assert_eq!(r.body["token_endpoint"], format!("{L}/oauth/token"));
        assert_eq!(r.body["jwks_uri"], format!("{L}/jwks.json"));
        let r = api.answer(&get("/.well-known/oauth-protected-resource/api/orgs/acme"), NOW);
        assert_eq!(r.status, 200);
        assert_eq!(r.body["resource"], RR);
        assert_eq!(r.body["authorization_servers"], json!([I, L]));
    }

    #[test]
    fn local_token_issued_for_the_read_scopes_only() {
        let dir = tmp();
        let (api, key, lines) = api(dir.path());
        let (form, proof) = (token_form(&key, "monitor.read audit.read"), dpop_proof());
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["token_type"], "DPoP");
        assert!(r.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("cache-control") && v == "no-store"));
        let token = r.body["access_token"].as_str().unwrap();
        let claims: Value = serde_json::from_slice(&crate::api_token::b64u_strict(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["iss"], L);
        assert_eq!(claims["aud"], RR);
        let jwks = api.answer(&get("/api/orgs/acme/local/jwks.json"), NOW);
        let kid = jwks.body["keys"][0]["kid"].as_str().unwrap().to_string();
        assert!(kid.starts_with("l-") && kid.len() == 18);
        let mut scopes: Vec<&str> = r.body["scope"].as_str().unwrap_or_default().split(' ').collect();
        scopes.sort_unstable();
        assert_eq!(scopes, ["audit.read", "monitor.read"]);
        assert!(lines.lock().iter().any(|(n, _)| n == "api.token"));
    }

    #[test]
    fn local_token_refuses_a_scope_outside_the_four() {
        let dir = tmp();
        let (api, key, lines) = api(dir.path());
        // people.read is in the client's grant but not among the four the local issuer mints
        let (form, proof) = (token_form(&key, "people.read"), dpop_proof());
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!(r.status, 400, "{}", r.body);
        assert_eq!(r.body["error"], "invalid_scope");
        assert!(r.body.get("access_token").is_none());
        assert!(lines.lock().iter().any(|(n, _)| n == "api.refusal"));
    }

    #[test]
    fn key_rotation_keeps_the_previous_key_ten_minutes() {
        let dir = tmp();
        let vault = parking_lot::Mutex::new(MemVault::default());
        let ring = KeyRing::new(dir.path());
        let (first, listed) = ring.keys("acme", &vault, NOW).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(first.kid.starts_with("l-") && first.kid.len() == 18);
        // the same key from disk and the vault after a restart
        let again = KeyRing::new(dir.path());
        assert_eq!(again.keys("acme", &vault, NOW + 60).unwrap().0.kid, first.kid);
        let at = NOW + KEY_ROTATE_S;
        let (second, listed) = again.keys("acme", &vault, at).unwrap();
        assert_ne!(second.kid, first.kid);
        assert_eq!(listed.iter().map(|k| k.kid.clone()).collect::<Vec<_>>(), [second.kid.clone(), first.kid.clone()]);
        // a restart inside the overlap still lists both
        let third = KeyRing::new(dir.path());
        assert_eq!(third.keys("acme", &vault, at + 60).unwrap().1.len(), 2);
        let (signing, listed) = third.keys("acme", &vault, at + KEY_OVERLAP_S).unwrap();
        assert_eq!(signing.kid, second.kid);
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn jwks_lists_the_previous_key_after_rotation() {
        let dir = tmp();
        let (api, ..) = api(dir.path());
        let one = api.answer(&get("/api/orgs/acme/local/jwks.json"), NOW);
        assert_eq!(one.body["keys"].as_array().unwrap().len(), 1);
        let two = api.answer(&get("/api/orgs/acme/local/jwks.json"), NOW + KEY_ROTATE_S);
        let kids: Vec<&str> = two.body["keys"].as_array().unwrap().iter().filter_map(|k| k["kid"].as_str()).collect();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[1], one.body["keys"][0]["kid"].as_str().unwrap());
        let three = api.answer(&get("/api/orgs/acme/local/jwks.json"), NOW + KEY_ROTATE_S + KEY_OVERLAP_S);
        assert_eq!(three.body["keys"].as_array().unwrap().len(), 1);
    }
}
