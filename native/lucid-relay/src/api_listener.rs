// API-1 7.2 and 5.6 (docs/api/contract.md): the relay's API listener. TLS with an OPTIONAL client certificate
// (verified as on the Meet port when presented), HTTP/1.1, one thread per connection under the same connection caps
// as the guest port. For each org this relay serves that has a pinned unexpired api map, a `relay_origins` entry
// for this relay's fleet id and a provisioned pseudonym key (11.4), it serves the relay-local issuer (5.6): its
// RFC 8414 metadata, the protected resource metadata of RR, the local JWKS and `L/oauth/token`, which mints only the
// four read scopes with `aud` = RR, and the 7.2 resource routes (`RR/v1/health`, `v1/audit`, `v1/audit/keys`,
// `v1/metrics`, the last also through the 6.1 scrape pipeline; revision 4 7.3 adds `v1/events` with long poll and
// `v1/events/keys`, served in both modes with console or relay-local tokens) through `api_resource`, whose table the listener
// dispatches from. RR and L always come from the pinned map, never from the request's `Host`. Everything else answers
// 404 `not-found`.
//
// 9.4: every decision about a known org is in this relay's audit chain for that org before its answer leaves; without
// the chain (before enrollment) the org's routes answer 503 `audit-unavailable`.

use crate::api_issue::{self, ClientCert, IssueCtx, IssueState, TokenHttp};
use crate::api_map::ApiMapStore;
use crate::api_resource::{self as res, AuditLog, Call, Data, Matched, RelayInfo, Reply, ResourceState, RouteId, Side, Site};
use crate::fleet_ca::{vault_do, VaultLock};
use crate::license::Product;
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
    /// 9.1: this relay's API audit chains (source = its fleet id); None before enrollment.
    fn audit(&self) -> Option<Arc<dyn AuditLog>>;
    /// 7.2 `v1/health`: the fleet channel to the console is up now.
    fn console_connected(&self) -> bool;
    /// The product whose 9.1 keys `v1/metrics` reports.
    fn product(&self) -> Product;
    /// Revision 4 7.3: this relay's own event chains; None before enrollment.
    fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
        None
    }
    /// API-1d 6.3: `RR/v1/spokes/<view>` for a spokes relay; None on a Meet relay (404).
    fn spokes(&self, _org: &str, _view: &str, _query: &str, _people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
        None
    }
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

    fn audit(&self) -> Option<Arc<dyn AuditLog>> {
        self.relay.upgrade()?.api_audit().map(|a| a as Arc<dyn AuditLog>)
    }

    fn console_connected(&self) -> bool {
        self.relay.upgrade().is_some_and(|r| r.console_connected())
    }

    fn product(&self) -> Product {
        // the API listener is the Meeting Hub relay's
        Product::Meet
    }

    fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
        self.relay.upgrade()?.api_events()
    }
}

/// This relay as the 7.2 resource routes report it: its own values now (`fleet_probe::peek`, which resets nothing),
/// under its fleet id.
struct Own<'a> {
    id: &'a str,
    source: &'a dyn Source,
}

/// This relay's own families for one org now, under its fleet id: what `v1/metrics` reports of it, and what its
/// failover exporter sends (12.2). The console's own info family is the console's.
pub fn own_exposition(id: &str, product: Product, org: &str, now: i64) -> String {
    let p = crate::fleet_probe::peek(product);
    let code = |k: &str| p.m.get(k).and_then(Value::as_i64);
    let row = crate::fleet_export::RelayRow {
        id: id.to_string(),
        // the console's registry name and site are not known on the relay
        name: id.to_string(),
        site: String::new(),
        product,
        // it is answering
        connected: true,
        last_contact_ms: None,
        health: "ok".into(),
        license_state: code("license_state"),
        license_service: code("license_service"),
    };
    let snap = crate::fleet_export::Snap { t: Some(p.ts), latest: p.m, totals: p.totals };
    let console = crate::fleet_export::ConsoleInfo { version: env!("CARGO_PKG_VERSION"), profile: "standard", fips: cfg!(feature = "fips") };
    let text = crate::fleet_export::exposition(&console, &[&row], &[snap], p.ts);
    let mut out = text.lines().filter(|l| !l.contains("lucid_console_info")).fold(String::with_capacity(text.len()), |mut out, l| {
        out.push_str(l);
        out.push('\n');
        out
    });
    // API-1 10.1: this relay's own counters for the org
    out.push_str(&crate::fleet_export::api_families(Some(org), now, true));
    out
}

impl Data for Own<'_> {
    fn relays(&self, _org: &str, _now: i64) -> Vec<RelayInfo> {
        let p = crate::fleet_probe::peek(self.source.product());
        let license = p.m.get("license_state").and_then(Value::as_u64).and_then(|c| crate::fleet_export::LICENSE_STATES.get(c as usize)).copied().unwrap_or_default();
        vec![RelayInfo {
            id: self.id.to_string(),
            name: self.id.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            fips: cfg!(feature = "fips"),
            license_state: license.to_string(),
            up: true,
            health: "ok".into(),
            latest: p.m,
            ..RelayInfo::default()
        }]
    }

    fn ids(&self, _org: &str) -> Vec<String> {
        vec![self.id.to_string()]
    }

    fn exposition(&self, org: &str, ids: &[String], now: i64) -> String {
        if !ids.iter().any(|i| i == self.id) {
            return String::new();
        }
        own_exposition(self.id, self.source.product(), org, now)
    }

    fn console(&self) -> Value {
        json!(if self.source.console_connected() { "connected" } else { "unreachable" })
    }

    fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
        self.source.events()
    }

    /// API-1d 6.3: only this relay's own views.
    fn spokes(&self, org: &str, relay: &str, view: &str, query: &str, people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
        if relay != self.id {
            return None;
        }
        self.source.spokes(org, view, query, people)
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
    pub query: &'a str,
    pub form: &'a [u8],
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
    pub client_cert: Option<&'a ClientCert>,
    pub source: IpAddr,
}

fn not_found() -> Reply {
    res::problem(404, "not-found", "Nothing is here.")
}

fn license_refused() -> Reply {
    res::problem(403, "license", "This relay is not serving under a license right now.")
}

fn public(body: Value) -> Reply {
    Reply { headers: vec![("Cache-Control", "max-age=300".into())], ..Reply::json(200, body) }
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

/// The listener's routes over a `Source`; independent of the socket.
pub struct Api {
    source: Box<dyn Source>,
    keys: KeyRing,
    state: IssueState,
    /// The resource and scrape pipelines' limiters and DPoP cache (6.5).
    resource: ResourceState,
    fetch: crate::api_fetch::FetchCache,
}

impl Api {
    pub fn new(source: Box<dyn Source>, dir: &Path) -> Api {
        Api { source, keys: KeyRing::new(dir), state: IssueState::new(), resource: ResourceState::new(), fetch: crate::api_fetch::FetchCache::new(FETCH_MAX_AGE) }
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

    /// 6.5 source limiter, then the license (6.1): the refusal, if any, in the org's chain first (9.4).
    fn admit(&self, m: &Matched, req: &Req, rid: &str, now: i64) -> Option<Reply> {
        let refused = match self.state.source_ok(req.source, now) {
            Err(retry) => {
                let mut r = res::problem(429, "abuse", "Too many requests from this address; try again later.");
                r.headers.push(("Retry-After", retry.max(1).to_string()));
                r
            }
            Ok(()) if !self.source.licensed() => license_refused(),
            Ok(()) => return None,
        };
        let route = format!("{} {}", m.route.method, m.route.path.replace("{org}", m.org));
        let audit = self.source.audit();
        Some(res::public_refused(audit.as_deref(), m.org, &route, rid, req.source, refused, now))
    }

    /// One request; every answer carries `X-Lucid-Request-Id` (the audit `rid` of its decision).
    pub fn answer(&self, req: &Req, now: i64) -> Reply {
        let rid = res::rid();
        let mut r = self.route(req, &rid, now);
        if !r.headers.iter().any(|(k, _)| *k == "X-Lucid-Request-Id") {
            r.headers.push(("X-Lucid-Request-Id", rid));
        }
        r
    }

    /// A request refused before its route is known (a body this listener does not take, a path or method no route
    /// has). Inside an org namespace the source limiter is charged first (429 `abuse` instead); then a known org's
    /// refusal is in its chain (9.4; 503 when it cannot be), and one about an unknown org is a security line (unless
    /// the limiter refused it, so a flood does not flood the log). Outside every namespace it is answered as is.
    pub fn refuse_early(&self, method: &str, path: &str, source: IpAddr, refused: Reply, rid: &str, now: i64) -> Reply {
        let mut r = match res::org_of(path) {
            None => refused,
            Some(org) => {
                let r = res::charged(self.state.source_ok(source, now), refused);
                if self.view(org, now).is_some() {
                    let audit = self.source.audit();
                    res::public_refused(audit.as_deref(), org, &res::namespace_route(method, org), rid, source, r, now)
                } else {
                    if r.status != 429 {
                        let code = r.body.get("code").and_then(Value::as_str).unwrap_or("refused");
                        let f = crate::log::Fields::new().with("org", org).with("code", code).with("source", crate::console_source::canonical(source).to_string());
                        crate::console_meet::logger().security("api.refusal", &f, crate::log::Level::Warn);
                    }
                    r
                }
            }
        };
        if !r.headers.iter().any(|(k, _)| *k == "X-Lucid-Request-Id") {
            r.headers.push(("X-Lucid-Request-Id", rid.to_string()));
        }
        r
    }

    fn route(&self, req: &Req, rid: &str, now: i64) -> Reply {
        let Some(m) = res::route_of(Side::Relay, req.method, req.path) else { return self.refuse_early(req.method, req.path, req.source, not_found(), rid, now) };
        let org = m.org;
        let view = match self.view(org, now) {
            None => return not_found(),
            // 13: a map the license edition does not allow is set aside: every route of the org, documents included
            Some(Org::SetAside) => {
                return self.admit(&m, req, rid, now).unwrap_or_else(|| res::problem(403, "map-edition", "This organization's API map is not allowed under this relay's license edition."))
            }
            Some(Org::Live(v)) => v,
        };
        match m.route.id {
            // the token pipeline charges the source limiter and checks the license itself
            RouteId::LocalToken => self.token(org, &view, req, rid, now),
            RouteId::LocalAsMetadata | RouteId::ResourceMetadata | RouteId::LocalJwks => {
                // 6.1 Public: org known, then the source limiter
                if let Some(refused) = self.admit(&m, req, rid, now) {
                    return refused;
                }
                match m.route.id {
                    RouteId::LocalAsMetadata => public(api_issue::as_metadata(&view.local, &format!("{}/oauth/token", view.local), None, &format!("{}/jwks.json", view.local))),
                    RouteId::ResourceMetadata => public(api_issue::resource_metadata(&view.resource, &[view.issuer.as_str(), view.local.as_str()], &LOCAL_SCOPES)),
                    _ => match self.signing(org, now) {
                        Ok((_, listed)) => public(api_issue::jwks(&self.local_jwks(&listed))),
                        Err(r) => r,
                    },
                }
            }
            RouteId::Health | RouteId::Audit | RouteId::AuditKeys | RouteId::Metrics | RouteId::Events | RouteId::EventKeys => self.resource(&view, &m, req, rid, now),
            // API-1d 6.3: a spokes relay's own inventory (`Source::spokes`; 404 from the route on a Meet relay)
            RouteId::SpokesNodes | RouteId::SpokesCounts | RouteId::SpokesSeats | RouteId::SpokesRelays if self.source.product() == Product::Spokes => self.resource(&view, &m, req, rid, now),
            RouteId::SpokesNodes | RouteId::SpokesCounts | RouteId::SpokesSeats | RouteId::SpokesRelays => not_found(),
            // front door routes: not served here
            RouteId::AsMetadata
            | RouteId::Jwks
            | RouteId::OpenApi
            | RouteId::Token
            | RouteId::Revoke
            | RouteId::Capacity
            | RouteId::FleetRelays
            | RouteId::FleetRelay
            | RouteId::TelemetryCatalog
            | RouteId::FederationDiscovery
            | RouteId::FederationJwks
            | RouteId::WebhookKeys
            | RouteId::EventTypes
            | RouteId::ComplianceAttendance
            | RouteId::ComplianceMeetings
            | RouteId::ComplianceConversations
            | RouteId::ComplianceFiles
            | RouteId::ComplianceRetention
            | RouteId::ComplianceHolds
            | RouteId::ComplianceHold
            | RouteId::ComplianceHoldPlace
            | RouteId::ComplianceExportRequest
            | RouteId::ComplianceExports
            | RouteId::ComplianceExport
            | RouteId::ComplianceExportSeal
            | RouteId::ComplianceExportPart
            | RouteId::ComplianceExportCancel
            // revision 5: the Authorize pipeline and M are the console's
            | RouteId::Authorize
            | RouteId::SsoReturn
            | RouteId::Consent
            | RouteId::ConsentPost
            | RouteId::McpMetadata
            // API-1d 7.1.5: the Agent Cards are the console's
            | RouteId::A2aAgents
            | RouteId::A2aCard
            | RouteId::A2aJwks => not_found(),
        }
    }

    fn local_jwks(&self, listed: &[Arc<LocalKey>]) -> Vec<Value> {
        listed.iter().map(|k| api_issue::ec_public_jwk(&k.pair, &k.kid)).collect()
    }

    /// 7.2 resource routes: 6.2 (or the 6.1 scrape pipeline) and the route, audited (9.4), in `api_resource`.
    fn resource(&self, view: &OrgView, m: &Matched, req: &Req, rid: &str, now: i64) -> Reply {
        let (Some(audit), Some(id)) = (self.source.audit(), self.source.relay_id()) else { return res::audit_unavailable() };
        // the local profile's keys: none while this relay cannot reach its sealed keys (local tokens then fail)
        let local_keys = self.signing(m.org, now).map(|(_, listed)| self.local_jwks(&listed)).unwrap_or_default();
        let owner_active = |p: &str| self.source.owner_active(p);
        let data = Own { id: &id, source: &*self.source };
        let site = Site {
            side: Side::Relay,
            relay: &id,
            resource: &view.resource,
            local: Some((view.local.as_str(), local_keys.as_slice())),
            store: &view.store,
            owner_active: &owner_active,
            licensed: self.source.licensed(),
            audit: &*audit,
            state: &self.resource,
            data: &data,
            now,
        };
        let call = Call {
            org: m.org,
            route: m.route,
            id: m.id,
            path: req.path,
            query: req.query,
            authorization: req.authorization,
            dpop: req.dpop,
            cert: req.client_cert,
            source: req.source,
            rid,
        };
        res::answer(&site, &call)
    }

    fn signing(&self, org: &str, now: i64) -> Result<(Arc<LocalKey>, Vec<Arc<LocalKey>>), Reply> {
        let unavailable = || res::problem(503, "unavailable", "This relay cannot issue tokens right now.");
        let vault = self.source.vault().ok_or_else(unavailable)?;
        self.keys.keys(org, &*vault, now).map_err(|e| {
            crate::meet::log_error(&format!("api local key org={org}: {e}"));
            unavailable()
        })
    }

    fn token(&self, org: &str, view: &OrgView, req: &Req, rid: &str, now: i64) -> Reply {
        let Some(audit) = self.source.audit() else { return res::audit_unavailable() };
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
            // revision 5 20: the relay-local issuer refuses every delegated grant
            delegated: None,
        };
        let http = TokenHttp { form: req.form, authorization: req.authorization, dpop: req.dpop, client_cert: req.client_cert, source: req.source };
        let a = api_issue::token(&ctx, &http);
        let route = format!("POST /api/orgs/{org}/local/oauth/token");
        Reply::of_answer(res::token_audited(&*audit, org, &route, rid, req.source, a, now))
    }
}

// ── the socket ───────────────────────────────────────────────────────────────────────────────────────────────────

struct Port {
    api: Api,
    /// Where the client CA and the CRL in force are read for each presented certificate (a Meet relay). None on a
    /// spokes relay (API-1d 6.3): no client certificate is taken there, so mTLS clients are not served.
    settings: Option<crate::meet::Settings>,
    tls: Arc<ServerConfig>,
    open: Mutex<HashMap<String, usize>>,
    total: AtomicUsize,
    refusals: crate::meet_tls::RefusalLog,
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
    let source = RelaySource { relay: Arc::downgrade(relay), dir: dir.clone() };
    listen_on(Box::new(source), &dir, &listen, tls, Some(s.clone()))
}

/// API-1d 6.3: the API listener of a spokes relay (its `Source` with `product()` `Product::Spokes`), on `listen` with
/// `tls`, which requests no client certificate: mTLS clients are not served on a spokes relay.
pub fn start_spokes(source: Box<dyn Source>, dir: &Path, listen: &str, tls: Arc<ServerConfig>) -> Result<(), String> {
    listen_on(source, dir, listen, tls, None)
}

/// The port of `start` and `start_spokes`: bound now, then served on its own thread.
fn listen_on(source: Box<dyn Source>, dir: &Path, listen: &str, tls: Arc<ServerConfig>, settings: Option<crate::meet::Settings>) -> Result<(), String> {
    let listener = TcpListener::bind(listen).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    let api = Api::new(source, dir);
    let port = Arc::new(Port { api, settings, tls, open: Mutex::new(HashMap::new()), total: AtomicUsize::new(0), refusals: crate::meet_tls::RefusalLog::new() });
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
    // current CRL was checked for it, otherwise it is treated as not presented (mTLS fails `client-auth`); a spokes
    // relay's port (no Meet settings) takes none
    let now = crate::meet_json::now() as i64;
    let cert = port
        .settings
        .as_ref()
        .and_then(|s| Some((s, conn.peer_certificates()?.split_first()?)))
        .filter(|(s, (leaf, rest))| crate::meet_tls::api_cert_revocation_checked(s, leaf.as_ref(), rest, now))
        .map(|(_, c)| c)
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

fn write(w: &mut Tls, r: &Reply) -> std::io::Result<()> {
    let body = r.bytes();
    let mut head = format!("HTTP/1.1 {} {}\r\nServer: {SERVER_VERSION}\r\nDate: {}\r\n", r.status, reason_phrase(r.status), http_date());
    let mut fixed = vec![
        ("Content-Type", r.ctype.to_string()),
        ("Content-Length", body.len().to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Strict-Transport-Security", "max-age=31536000".to_string()),
    ];
    // 8.2: every answer carries a request id; one before any route (a malformed request) gets its own
    if !r.headers.iter().any(|(k, _)| *k == "X-Lucid-Request-Id") {
        fixed.push(("X-Lucid-Request-Id", res::rid()));
    }
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
    let (path, query) = head.path_query();
    // a body this listener does not take: refused before any route, through the namespace's limiter and chain
    let early = |r: Reply| port.api.refuse_early(&head.method, &path, ip, r, &res::rid(), crate::meet_json::now() as i64);
    if head.header("transfer-encoding").is_some_and(|v| !v.is_empty()) {
        write(reader.get_mut(), &early(res::problem(411, "bad-request", "Send the body with a Content-Length.")))?;
        return Ok(false);
    }
    let length = match head.header("content-length").map(|l| l.trim().parse::<usize>()) {
        None => 0,
        Some(Ok(n)) => n,
        Some(Err(_)) => {
            write(reader.get_mut(), &early(res::problem(400, "bad-request", "The Content-Length is not a number.")))?;
            return Ok(false);
        }
    };
    if length > BODY_MAX {
        write(reader.get_mut(), &early(res::problem(413, "too-large", "The body is larger than 16 KiB.")))?;
        return Ok(false);
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let (authorization, dpop) = (head.header("authorization"), head.header("dpop"));
    let req = Req { method: &head.method, path: &path, query: &query, form: &body, authorization: authorization.as_deref(), dpop: dpop.as_deref(), client_cert: cert, source: ip };
    let resp = port.api.answer(&req, crate::meet_json::now() as i64);
    write(reader.get_mut(), &resp)?;
    Ok(!head.close)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::ApiAudit;
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
        audit: Arc<ApiAudit>,
    }

    struct NoSigner;
    impl crate::api_audit::CheckpointSigner for NoSigner {
        fn kid(&self, _: &str) -> Option<String> {
            None
        }
        fn sign(&self, _: &str, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Keys;
    impl crate::api_audit::PseudonymKeys for Keys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![5; 32]))
        }
    }

    /// The actions in this relay's `as_is` chain for the org.
    fn actions(audit: &ApiAudit) -> Vec<String> {
        let page = audit.read("acme", "r_01", crate::api_audit::Repr::AsIs, 0, 1000).unwrap();
        page["entries"].as_array().into_iter().flatten().filter_map(|e| e["action"].as_str().map(str::to_string)).collect()
    }

    impl Source for TestSource {
        fn audit(&self) -> Option<Arc<dyn AuditLog>> {
            Some(self.audit.clone() as Arc<dyn AuditLog>)
        }
        fn console_connected(&self) -> bool {
            false
        }
        fn product(&self) -> Product {
            Product::Meet
        }
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

    fn api_with(origins: Value, pseudonym: bool, licensed: bool, dir: &Path) -> (Api, EcdsaKeyPair, Arc<ApiAudit>) {
        let key = client_key();
        let audit = Arc::new(ApiAudit::open(Some(dir.join(format!("chains-{}", res::rid())).as_path()), "r_01", Arc::new(NoSigner), Arc::new(Keys), NOW));
        let source = TestSource { store: store(&key, origins), vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym, licensed, audit: audit.clone() };
        (Api::new(Box::new(source), dir), key, audit)
    }

    fn api(dir: &Path) -> (Api, EcdsaKeyPair, Arc<ApiAudit>) {
        api_with(json!({"r_01": ORIGIN}), true, true, dir)
    }

    /// A DPoP proof under `pair` for `htm` and `htu` (and `ath` of `token` when given).
    fn proof_by(pair: &EcdsaKeyPair, htm: &str, htu: &str, token: Option<&str>) -> String {
        let point = pair.public_key().as_ref();
        let jwk = json!({"kty": "EC", "crv": "P-256", "x": crate::codec::b64u(&point[1..33]), "y": crate::codec::b64u(&point[33..65])});
        let mut claims = json!({"jti": res::rid(), "htm": htm, "htu": htu, "iat": NOW});
        if let Some(t) = token {
            claims["ath"] = json!(crate::codec::b64u(&crate::codec::sha256(t.as_bytes())));
        }
        crate::api_token::sign_es256(pair, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": jwk}), &claims).unwrap()
    }

    /// A DPoP proof for the local token endpoint under a fresh key.
    fn dpop_proof() -> String {
        proof_by(&client_key(), "POST", &format!("{L}/oauth/token"), None)
    }

    fn token_req<'a>(form: &'a str, dpop: Option<&'a str>) -> Req<'a> {
        Req { method: "POST", path: "/api/orgs/acme/local/oauth/token", query: "", form: form.as_bytes(), authorization: None, dpop, client_cert: None, source: "10.40.0.7".parse().unwrap() }
    }

    fn get<'a>(path: &'a str) -> Req<'a> {
        Req { method: "GET", path, query: "", form: b"", authorization: None, dpop: None, client_cert: None, source: "10.40.0.7".parse().unwrap() }
    }

    fn enc(s: &str) -> String {
        s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
    }

    fn token_form(key: &EcdsaKeyPair, scope: &str) -> String {
        let header = json!({"alg": "ES256", "typ": "JWT", "kid": "k1"});
        let claims = json!({"iss": "c_mon", "sub": "c_mon", "aud": L, "iat": NOW, "exp": NOW + 60, "jti": res::rid()});
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
        let d = std::env::temp_dir().join(format!("lucid-api-listener-{}", res::rid()));
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
            "/api/orgs/beta/v1/health",
            "/api/orgs/acme/v1/capacity",
            "/api/orgs/acme/v1/openapi.json",
            "/",
            "/.well-known/oauth-protected-resource/api/orgs/acme/extra",
        ] {
            let r = api.answer(&get(path), NOW);
            assert_eq!((r.status, r.body["code"].as_str()), (404, Some("not-found")), "{path}");
        }
    }

    #[test]
    fn refusals_before_the_route_charge_the_limiter_and_reach_the_orgs_chain() {
        let dir = tmp();
        let (api, _, audit) = api(dir.path());
        let ip: IpAddr = "10.40.0.9".parse().unwrap();
        let rid = res::rid();
        // a body the listener does not take, inside a known org's namespace
        let r = api.refuse_early("POST", "/api/orgs/acme/local/oauth/token", ip, res::problem(413, "too-large", "Too large."), &rid, NOW);
        assert_eq!((r.status, r.body["code"].as_str()), (413, Some("too-large")));
        assert!(r.headers.iter().any(|(k, v)| *k == "X-Lucid-Request-Id" && *v == rid));
        // a method no route has
        let wrong = Req { method: "DELETE", path: "/api/orgs/acme/v1/health", query: "", form: b"", authorization: None, dpop: None, client_cert: None, source: ip };
        assert_eq!(api.answer(&wrong, NOW).status, 404);
        // both are in the org's chain (unauthenticated: summarized per source from the first)
        audit.tick(NOW + 120);
        let page = audit.read("acme", "r_01", crate::api_audit::Repr::AsIs, 0, 1000).unwrap();
        let checks: Vec<&str> = page["entries"].as_array().unwrap().iter().filter_map(|e| e["check"].as_str()).collect();
        assert!(checks.contains(&"too-large") && checks.contains(&"not-found"), "{checks:?}");
        // the source limiter is charged first: 120 a minute, every early refusal counted
        for _ in 2..api_issue::SOURCE_PER_MINUTE {
            assert_eq!(api.refuse_early("POST", "/api/orgs/acme/v1/health", ip, res::problem(411, "bad-request", "No."), &res::rid(), NOW).status, 411);
        }
        let r = api.refuse_early("POST", "/api/orgs/acme/v1/health", ip, res::problem(411, "bad-request", "No."), &res::rid(), NOW);
        assert_eq!((r.status, r.body["code"].as_str()), (429, Some("abuse")));
        assert!(r.headers.iter().any(|(k, _)| *k == "Retry-After"));
        // an unknown org's refusal is in no chain; outside every namespace nothing is charged
        let other: IpAddr = "10.40.0.10".parse().unwrap();
        assert_eq!(api.refuse_early("POST", "/api/orgs/beta/v1/health", other, res::problem(411, "bad-request", "No."), &res::rid(), NOW).status, 411);
        assert!(audit.read("beta", "r_01", crate::api_audit::Repr::AsIs, 0, 10).unwrap()["entries"].as_array().unwrap().is_empty());
        for _ in 0..200 {
            assert_eq!(api.refuse_early("GET", "/", ip, res::problem(404, "not-found", "No."), &res::rid(), NOW).status, 404);
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
        let audit = Arc::new(ApiAudit::open(Some(dir.path().join("chains").as_path()), "r_01", Arc::new(NoSigner), Arc::new(Keys), NOW));
        let source = TestSource { store: aside, vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym: true, licensed: true, audit };
        let api = Api::new(Box::new(source), dir.path());
        for path in ["/.well-known/oauth-protected-resource/api/orgs/acme", "/.well-known/oauth-authorization-server/api/orgs/acme/local", "/api/orgs/acme/local/jwks.json", "/api/orgs/acme/v1/health"] {
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
        let (api, key, audit) = api(dir.path());
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
        // 9.4: the token was in the chain before it was released, under the answer's request id
        assert_eq!(actions(&audit), ["api.token"]);
        assert!(r.headers.iter().any(|(k, v)| *k == "X-Lucid-Request-Id" && v.len() == 22));
    }

    #[test]
    fn local_token_reads_this_relays_health_and_audit_chain() {
        let dir = tmp();
        let (api, key, audit) = api(dir.path());
        let holder = client_key();
        let token_endpoint = format!("{L}/oauth/token");
        let form = token_form(&key, "monitor.read audit.read");
        let proof = proof_by(&holder, "POST", &token_endpoint, None);
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!(r.status, 200, "{}", r.body);
        let token = r.body["access_token"].as_str().unwrap().to_string();
        let authorization = format!("DPoP {token}");
        let call = |path: &'static str| {
            let p = proof_by(&holder, "GET", &format!("{ORIGIN}{path}"), Some(&token));
            let req = Req { method: "GET", path, query: "", form: b"", authorization: Some(authorization.as_str()), dpop: Some(p.as_str()), client_cert: None, source: "10.40.0.7".parse().unwrap() };
            api.answer(&req, NOW)
        };
        let health = call("/api/orgs/acme/v1/health");
        assert_eq!(health.status, 200, "{}", health.body);
        assert_eq!((health.body["console"].as_str(), health.body["mode"].as_str()), (Some("unreachable"), Some("normal")));
        assert_eq!(health.body["relays"][0]["id"], "r_01");
        // the local profile: internal ceiling reads the pseudonymized chain of this relay
        let page = call("/api/orgs/acme/v1/audit");
        assert_eq!(page.status, 200, "{}", page.body);
        assert_eq!(page.body["repr"], "pseudonymized");
        let metrics = call("/api/orgs/acme/v1/metrics");
        assert_eq!(metrics.status, 200);
        assert!(metrics.text.as_deref().is_some_and(|t| t.contains("lucid_relay_up{relay=\"r_01\"") && !t.contains("lucid_console_info")));
        assert_eq!(actions(&audit).iter().filter(|a| *a == "api.call").count(), 3);
        // without a token: refused 401 and recorded
        assert_eq!(api.answer(&get("/api/orgs/acme/v1/health"), NOW).status, 401);
    }

    #[test]
    fn local_token_refuses_a_scope_outside_the_four() {
        let dir = tmp();
        let (api, key, audit) = api(dir.path());
        // people.read is in the client's grant but not among the four the local issuer mints
        let (form, proof) = (token_form(&key, "people.read"), dpop_proof());
        let r = api.answer(&token_req(&form, Some(&proof)), NOW);
        assert_eq!(r.status, 400, "{}", r.body);
        assert_eq!(r.body["error"], "invalid_scope");
        assert!(r.body.get("access_token").is_none());
        assert_eq!(actions(&audit), ["api.refusal"]);
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

    /// API-1d 6.3: a spokes relay's source (the test source as a spokes relay that answers its own views).
    struct SpokesSource(TestSource);
    impl Source for SpokesSource {
        fn audit(&self) -> Option<Arc<dyn AuditLog>> {
            self.0.audit()
        }
        fn console_connected(&self) -> bool {
            self.0.console_connected()
        }
        fn product(&self) -> Product {
            Product::Spokes
        }
        fn relay_id(&self) -> Option<String> {
            self.0.relay_id()
        }
        fn snapshot(&self, org: &str) -> Option<ApiMapStore> {
            self.0.snapshot(org)
        }
        fn owner_active(&self, p: &str) -> bool {
            self.0.owner_active(p)
        }
        fn pseudonym_ready(&self, org: &str) -> bool {
            self.0.pseudonym_ready(org)
        }
        fn vault(&self) -> Option<Arc<dyn VaultLock>> {
            self.0.vault()
        }
        fn licensed(&self) -> bool {
            self.0.licensed()
        }
        fn spokes(&self, _org: &str, view: &str, _query: &str, _people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
            Some(Ok(json!({ "view": view })))
        }
    }

    #[test]
    fn spokes_views_are_routes_of_a_spokes_relay_only() {
        let dir = tmp();
        // a Meet relay: 404 before any pipeline, nothing audited
        let (api, _, audit) = api(dir.path());
        for view in ["nodes", "counts", "seats", "relays"] {
            let path = format!("/api/orgs/acme/v1/spokes/{view}");
            let r = api.answer(&get(&path), NOW);
            assert_eq!((r.status, r.body["code"].as_str()), (404, Some("not-found")), "{path}");
        }
        assert!(actions(&audit).is_empty());
        // a spokes relay: the resource pipeline runs (no token: 401, audited as the relay's refusal)
        let key = client_key();
        let audit = Arc::new(ApiAudit::open(Some(dir.path().join("spokes-chains").as_path()), "r_01", Arc::new(NoSigner), Arc::new(Keys), NOW));
        let inner = TestSource { store: store(&key, json!({"r_01": ORIGIN})), vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym: true, licensed: true, audit: audit.clone() };
        let api = Api::new(Box::new(SpokesSource(inner)), dir.path());
        let r = api.answer(&get("/api/orgs/acme/v1/spokes/nodes"), NOW);
        assert_eq!((r.status, r.body["code"].as_str()), (401, Some("token")));
        // the listener's data answers only this relay's own views
        let source = SpokesSource(TestSource { store: store(&key, json!({})), vault: Arc::new(parking_lot::Mutex::new(MemVault::default())), pseudonym: true, licensed: true, audit });
        let own = Own { id: "r_01", source: &source };
        assert_eq!(own.spokes("acme", "r_01", "seats", "", false).and_then(Result::ok), Some(json!({"view": "seats"})));
        assert!(own.spokes("acme", "r_02", "seats", "", false).is_none());
    }
}
