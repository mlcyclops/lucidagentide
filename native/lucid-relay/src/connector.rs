// Contract API-1 revision 5 (phase 1c), sections 2.1, 2.2, 2.6 to 2.8, 7 and 12.1: the connector process,
// `lucid-relay connector`.
//
//   lucid-relay connector [serve] --config <connector.json>     (or LUCID_CONNECTOR_CONFIG)
//   lucid-relay connector keygen --app <name> --config f       sealed key and CSR for an API app (2.4)
//   lucid-relay connector install --app <name> --cert <crt> --chain <pem> --config f
//   lucid-relay connector apps --config f                      each API app: certificate end, policy state,
//                                                              conversations, last sync (JSON)
//   lucid-relay connector forget --app <name> --config f       delete the app's content store now (2.7)
//   lucid-relay connector audit-verify --config f              the audit chains, verified (12.1)
//   lucid-relay connector spokes-keygen --config f             revision 6 7.2.3: the service hub's sealed node key and
//                                                              its node request for `root approve --service`
//   lucid-relay connector spokes-install --cert <token|file> [--root <root.pub>] [--seat <file>] --config f
//   lucid-relay connector spokes-add --cert <token|file> --config f   a spoke's certificate (`connector_spokes`)
//
// The config (JSON, unknown keys refused, relative paths from its folder): `org`, `connector_id` (`k_` and 16
// lowercase hex), `state_dir` (made owner-only), `listen` (`host:port`, default 0.0.0.0:9445), `tls_cert`, `tls_key`
// (the listener's key: sealed through the `SealedStore` at the first start, the clear file then removed, 2.6),
// `client_ca` (the Meet CA), `relay`, `relay_ca` (default `client_ca`), `console`, `console_spki`, `seal`, `apps` (1 to
// 16 `{"name"}`), `store_max_bytes` (1 GiB to 1 TiB, default 64 GiB), `enclave`, `enclave_networks`, and `spokes_hub`
// (revision 6 7.2.3, `connector_spokes::HubConfig`: with it `serve` also starts the service hub, never in an enclave).
//
// `serve` runs one session thread per API app (`connector_session::Runner`), the console link (`connector_sync`: the
// signed map, both journals, the keys, the acknowledgment, the audit shipping and checkpoint certificates, the
// freshness watch), the maintenance loop (at least every 5 minutes: due purges, each audited `connector.store.purged`,
// retention from the pinned policy, the size cap, each app's serving state), the approvals' expiry, and the HTTPS
// listener: `GET /healthz` answers `{"ok": true}` for the host's supervisor, and every other request goes to the
// connector resource routes (`connector_api`, 5.3 and 7), except CM (`connector_mcp`) and revision 6's A = C/a2a
// (`connector_a2a`: A2A 1.0 over HTTP+JSON with SSE, wired to the service hub). With `enclave: true` it refuses connections from outside
// `enclave_networks`, and every outbound connection must resolve inside them.
//
// `Hooks` is the sessions' `ContentHooks`: verified content events go to the long poll (`connector_events`), the
// person's approval answers and Stops to `connector_approvals`, and every store purge into the audit chain.

use crate::api_audit::ApiAudit;
use crate::codec::{iso_time, now_ms};
use crate::connector_api::{Answer, ConnectorApi, Request, BODY_MAX};
use crate::connector_approvals::Approvals;
use crate::connector_enroll::{app_name_ok, Enroll, BAD_APP_NAME};
use crate::connector_events::ContentEvents;
use crate::connector_seal::{make_private_dir, names, remove_durable, wipe, SealConfig, SealedStore, Sealer, SEALED_DIR};
use crate::connector_session::{stored_status, AppSession, ContentEvent, ContentHooks, ConversationInfo, OrgTrust, RelayLink, Runner, Shared};
use crate::connector_store::{ContentStore, Purged, STORE_MAX_DEFAULT, STORE_MAX_MAX, STORE_MAX_MIN};
use crate::connector_sync::SyncState;
use crate::console_source::{canonical, parse_cidr, Cidr};
use crate::meet::{log_error, log_info, log_warn};
use bytes::Bytes;
use http_body_util::{BodyExt, Either, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Response;
use hyper_util::rt::TokioIo;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub const USAGE: &str = "usage: lucid-relay connector [serve | keygen --app <name> | install --app <name> --cert <crt> --chain <pem> | apps | forget --app <name> | audit-verify | spokes-keygen | spokes-install --cert <token|file> [--root <root.pub>] [--seat <file>] | spokes-add --cert <token|file>] --config <connector.json>";
pub const CONFIG_ENV: &str = "LUCID_CONNECTOR_CONFIG";
pub const DEFAULT_LISTEN: &str = "0.0.0.0:9445";
pub const APPS_MAX: usize = 16;
pub const NETWORKS_MAX: usize = 64;
/// The maintenance loop runs at least this often.
pub const MAINTENANCE_EVERY: Duration = Duration::from_secs(300);
/// 2.8 ack `features` (revision 5 3.3), and revision 6 2.4 `spokes` (the connector pins maps with `spokes_hub` clients
/// and holds a service hub's key, 7.2.3), and `a2a` (it serves A and applies the A2A journal actions, slice 1d4).
pub const FEATURES: [&str; 7] = [
    crate::api_features::CONNECTORS,
    crate::api_features::IDPS,
    crate::api_features::CONTENT_CLIENTS,
    crate::api_features::DELEGATED,
    crate::api_features::JOURNAL_1C,
    crate::api_features::SPOKES,
    crate::api_features::A2A,
];

const CONFIG_KEYS: [&str; 17] = [
    "org", "connector_id", "state_dir", "listen", "tls_cert", "tls_key", "client_ca", "relay", "relay_ca", "console", "console_spki", "seal", "apps", "store_max_bytes", "enclave", "enclave_networks", "spokes_hub",
];

// The refusals of the config (each one sentence, exact).
pub const NOT_OBJECT: &str = "the connector config must be a JSON object";
pub const ORG_BAD: &str = "org must be the organization's id (1 to 64 of a-z, 0-9, '.', '_' and '-')";
pub const CONNECTOR_ID_BAD: &str = "connector_id must be k_ followed by 16 lowercase hex digits";
pub const LISTEN_BAD: &str = "listen must be host:port (for example 0.0.0.0:9445)";
pub const RELAY_BAD: &str = "relay must be the https:// URL of the organization's relay";
pub const CONSOLE_BAD: &str = "console must be the front door's origin, https://<host>:<port>";
pub const CONSOLE_SPKI_BAD: &str = "console_spki must be the 64 lowercase hex digits of the SHA-256 of the front door certificate's SubjectPublicKeyInfo";
pub const APPS_BAD: &str = "apps must list 1 to 16 API apps, each {\"name\": <app name>}";
pub const STORE_MAX_BAD: &str = "store_max_bytes must be a whole number of bytes from 1073741824 (1 GiB) to 1099511627776 (1 TiB)";
pub const ENCLAVE_BAD: &str = "enclave must be true or false";
pub const NETWORKS_BAD: &str = "enclave_networks must be a list of CIDR ranges";
pub const NETWORKS_NEEDED: &str = "enclave_networks must list the enclave's CIDR ranges (for example [\"10.20.0.0/16\"]) when enclave is true";
// The refusals of the CLI and the listener key.
pub const TLS_KEY_NOT_PKCS8: &str = "tls_key must be an unencrypted PKCS#8 key (-----BEGIN PRIVATE KEY-----); convert it with openssl pkcs8 -topk8 -nocrypt";
pub const TLS_KEY_MISSING: &str = "the listener's TLS key is neither sealed nor at tls_key";
/// 2.6: the key was sealed but its clear copy could not be deleted, so the connector does not start.
pub const TLS_KEY_LEFT_IN_CLEAR: &str = "the listener's TLS key is sealed, but its clear copy at tls_key could not be deleted; delete it, then start the connector again";

/// Every app name of the config is listed; `keygen` and `install` take only those.
pub fn not_configured(app: &str) -> String {
    format!("{app} is not one of this connector's apps (apps in the config)")
}

// ── enclave (PC-1 invariant 4) ──────────────────────────────────────────────────────────────────────────────

/// `enclave` and `enclave_networks`: with `on`, the listener takes connections only from the networks, and every
/// outbound connection's addresses must all be inside them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Enclave {
    pub on: bool,
    pub networks: Vec<Cidr>,
}

impl Enclave {
    pub fn inside(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.networks.iter().any(|n| n.contains(ip))
    }

    /// A connection to the listener from `ip` is taken.
    pub fn peer_allowed(&self, ip: IpAddr) -> bool {
        !self.on || self.inside(ip)
    }

    /// What `host` resolved to may be connected to.
    pub fn check_addresses(&self, host: &str, found: &[IpAddr]) -> Result<(), String> {
        if found.is_empty() {
            return Err(format!("{host} could not be resolved"));
        }
        if self.on {
            if let Some(out) = found.iter().find(|a| !self.inside(**a)) {
                return Err(format!("{host} resolves to {out}, outside the enclave networks"));
            }
        }
        Ok(())
    }

    /// An outbound destination (relay, console): resolved, and in an enclave every address inside the networks.
    pub fn check_host(&self, host: &str, port: u16) -> Result<(), String> {
        if !self.on {
            return Ok(());
        }
        let found: Vec<IpAddr> = (host, port).to_socket_addrs().map_err(|_| format!("{host} could not be resolved"))?.map(|a| a.ip()).collect();
        self.check_addresses(host, &found)
    }

    /// The one start-up line saying what is refused.
    pub fn line(&self) -> String {
        if !self.on {
            return "enclave: off".to_string();
        }
        format!("enclave: on; connections and destinations limited to {}", self.networks.iter().map(Cidr::to_string).collect::<Vec<_>>().join(", "))
    }
}

// ── config (2.2) ────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Config {
    pub org: String,
    pub connector_id: String,
    pub state_dir: PathBuf,
    pub listen: (String, u16),
    pub tls_cert: PathBuf,
    pub tls_key: PathBuf,
    pub client_ca: PathBuf,
    pub relay: String,
    pub relay_ca: PathBuf,
    pub console: String,
    pub console_spki: String,
    pub seal: SealConfig,
    pub apps: Vec<String>,
    pub store_max_bytes: u64,
    pub enclave: Enclave,
    /// Revision 6 7.2.3 (`{"client", "cert", "directory"}`).
    pub spokes_hub: Option<crate::connector_spokes::HubConfig>,
}

fn org_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

fn hex_lower(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `k_` and 16 lowercase hex digits.
pub fn connector_id_ok(s: &str) -> bool {
    s.strip_prefix("k_").is_some_and(|h| hex_lower(h, 16))
}

/// `host:port` or `[v6]:port`, port 1 to 65535.
pub fn parse_listen(s: &str) -> Option<(String, u16)> {
    let (host, port) = match s.strip_prefix('[') {
        Some(rest) => rest.split_once("]:")?,
        None => {
            let (h, p) = s.rsplit_once(':')?;
            if h.contains(':') {
                return None;
            }
            (h, p)
        }
    };
    if host.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
    Some((host.to_string(), port))
}

/// `https://<host>[:<port>]` with nothing after it.
fn https_origin_ok(s: &str) -> bool {
    s.strip_prefix("https://").is_some_and(|rest| !rest.is_empty() && !rest.contains(|c: char| matches!(c, '/' | '?' | '#' | '@'))) && crate::ai_gateway::host_port(s).is_some_and(|(h, p)| !h.is_empty() && p > 0)
}

fn https_url_ok(s: &str) -> bool {
    s.strip_prefix("https://").is_some_and(|rest| !rest.is_empty() && !rest.contains('@')) && crate::ai_gateway::host_port(s).is_some_and(|(h, p)| !h.is_empty() && p > 0)
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, String> {
        let data = std::fs::read(path).map_err(|e| format!("cannot read the connector config {}: {e}", path.display()))?;
        let v: Value = serde_json::from_slice(&data).map_err(|_| format!("the connector config {} is not JSON", path.display()))?;
        let base = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        Config::parse(&v, base)
    }

    /// The config's object; `base` (its folder) resolves relative paths.
    pub fn parse(v: &Value, base: &Path) -> Result<Config, String> {
        let o = v.as_object().ok_or(NOT_OBJECT)?;
        if let Some(k) = o.keys().find(|k| !CONFIG_KEYS.contains(&k.as_str())) {
            return Err(format!("the connector config has no setting {k}"));
        }
        let text = |k: &str| -> Result<Option<String>, String> {
            match o.get(k) {
                None => Ok(None),
                Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim().to_string())),
                Some(_) => Err(format!("{k} must be a non-empty string")),
            }
        };
        let need = |k: &str| -> Result<String, String> { text(k)?.ok_or_else(|| format!("the connector config needs {k}")) };
        let file = |p: String| -> PathBuf {
            let p = PathBuf::from(p);
            if p.is_absolute() {
                p
            } else {
                base.join(p)
            }
        };
        let org = need("org")?;
        if !org_ok(&org) {
            return Err(ORG_BAD.to_string());
        }
        let connector_id = need("connector_id")?;
        if !connector_id_ok(&connector_id) {
            return Err(CONNECTOR_ID_BAD.to_string());
        }
        let listen = parse_listen(&text("listen")?.unwrap_or_else(|| DEFAULT_LISTEN.to_string())).ok_or(LISTEN_BAD)?;
        let relay = need("relay")?;
        if !https_url_ok(&relay) {
            return Err(RELAY_BAD.to_string());
        }
        let console = need("console")?;
        if !https_origin_ok(&console) {
            return Err(CONSOLE_BAD.to_string());
        }
        let console_spki = need("console_spki")?;
        if !hex_lower(&console_spki, 64) {
            return Err(CONSOLE_SPKI_BAD.to_string());
        }
        let seal = SealConfig::parse(o.get("seal").ok_or("the connector config needs seal")?, base)?;
        let list = o.get("apps").and_then(Value::as_array).filter(|a| (1..=APPS_MAX).contains(&a.len())).ok_or(APPS_BAD)?;
        let mut apps: Vec<String> = Vec::with_capacity(list.len());
        for a in list {
            let name = a.as_object().filter(|x| x.len() == 1).and_then(|x| x.get("name")).and_then(Value::as_str).ok_or(APPS_BAD)?;
            if !app_name_ok(name) {
                return Err(format!("apps lists {name:?}: {BAD_APP_NAME}"));
            }
            if apps.iter().any(|x| x == name) {
                return Err(format!("apps lists {name} twice"));
            }
            apps.push(name.to_string());
        }
        let store_max_bytes = match o.get("store_max_bytes") {
            None => STORE_MAX_DEFAULT,
            Some(x) => x.as_u64().filter(|n| (STORE_MAX_MIN..=STORE_MAX_MAX).contains(n)).ok_or(STORE_MAX_BAD)?,
        };
        let on = match o.get("enclave") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(ENCLAVE_BAD.to_string()),
        };
        let mut networks: Vec<Cidr> = Vec::new();
        if let Some(n) = o.get("enclave_networks") {
            let items = n.as_array().filter(|a| a.len() <= NETWORKS_MAX).ok_or(NETWORKS_BAD)?;
            for item in items {
                let s = item.as_str().ok_or(NETWORKS_BAD)?;
                let c = parse_cidr(s).map_err(|_| format!("enclave_networks has a range that is not valid: {s}"))?;
                if !networks.contains(&c) {
                    networks.push(c);
                }
            }
        }
        if on && networks.is_empty() {
            return Err(NETWORKS_NEEDED.to_string());
        }
        let spokes_hub = o.get("spokes_hub").map(|x| crate::connector_spokes::HubConfig::parse(x, base)).transpose()?;
        let client_ca = file(need("client_ca")?);
        Ok(Config {
            org,
            connector_id,
            state_dir: file(need("state_dir")?),
            listen,
            tls_cert: file(need("tls_cert")?),
            tls_key: file(need("tls_key")?),
            relay_ca: text("relay_ca")?.map(file).unwrap_or_else(|| client_ca.clone()),
            client_ca,
            relay,
            console,
            console_spki,
            seal,
            apps,
            store_max_bytes,
            enclave: Enclave { on, networks },
            spokes_hub,
        })
    }
}

fn read_text(p: &Path) -> Result<String, String> {
    std::fs::read_to_string(p).map_err(|e| format!("cannot read {}: {e}", p.display()))
}

/// The sealed store under `state_dir` (made owner-only) and the seal's `key_store` (2.8 `seal`).
pub fn open_sealed(cfg: &Config) -> Result<(Arc<SealedStore>, &'static str), String> {
    make_private_dir(&cfg.state_dir).map_err(|e| format!("cannot make the state folder {}: {e}", cfg.state_dir.display()))?;
    let source = cfg.seal.source();
    let sealer = Sealer::from_source(&*source)?;
    let sealed = SealedStore::open(sealer, cfg.state_dir.join(SEALED_DIR))?;
    Ok((Arc::new(sealed), source.key_store()))
}

// ── CLI (2.1) ───────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Serve,
    Keygen { app: String },
    Install { app: String, cert: PathBuf, chain: PathBuf },
    Apps,
    Forget { app: String },
    AuditVerify,
    /// Revision 6 7.2.3.
    SpokesKeygen,
    SpokesInstall { cert: String, root: Option<PathBuf>, seat: Option<PathBuf> },
    SpokesAdd { cert: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cli {
    pub command: Command,
    pub config: PathBuf,
}

/// The arguments after `connector`; `env_config` is `LUCID_CONNECTOR_CONFIG`.
pub fn parse_cli(args: &[String], env_config: Option<String>) -> Result<Cli, String> {
    let (mut pos, mut flags): (Vec<String>, HashMap<String, String>) = (Vec::new(), HashMap::new());
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(name) = a.strip_prefix("--") {
            match name.split_once('=') {
                Some((k, v)) => {
                    flags.insert(k.to_string(), v.to_string());
                }
                None => {
                    let value = args.get(i + 1).filter(|v| !v.starts_with("--")).cloned().ok_or_else(|| format!("--{name} needs a value"))?;
                    flags.insert(name.to_string(), value);
                    i += 1;
                }
            }
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    let cmd = pos.first().map(String::as_str).unwrap_or("serve");
    if pos.len() > 1 {
        return Err(USAGE.to_string());
    }
    let allowed: &[&str] = match cmd {
        "serve" | "apps" | "audit-verify" => &["config"],
        "keygen" | "forget" => &["config", "app"],
        "install" => &["config", "app", "cert", "chain"],
        "spokes-keygen" => &["config"],
        "spokes-install" => &["config", "cert", "root", "seat"],
        "spokes-add" => &["config", "cert"],
        _ => return Err(USAGE.to_string()),
    };
    if let Some(k) = flags.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!("--{k} is not a flag of connector {cmd}"));
    }
    let need = |k: &str| flags.get(k).filter(|v| !v.is_empty()).cloned().ok_or_else(|| format!("connector {cmd} needs --{k}"));
    let command = match cmd {
        "serve" => Command::Serve,
        "apps" => Command::Apps,
        "audit-verify" => Command::AuditVerify,
        "keygen" => Command::Keygen { app: need("app")? },
        "forget" => Command::Forget { app: need("app")? },
        "spokes-keygen" => Command::SpokesKeygen,
        "spokes-install" => Command::SpokesInstall { cert: need("cert")?, root: flags.get("root").filter(|v| !v.is_empty()).map(PathBuf::from), seat: flags.get("seat").filter(|v| !v.is_empty()).map(PathBuf::from) },
        "spokes-add" => Command::SpokesAdd { cert: need("cert")? },
        _ => Command::Install { app: need("app")?, cert: PathBuf::from(need("cert")?), chain: PathBuf::from(need("chain")?) },
    };
    let config = flags.get("config").cloned().or(env_config).filter(|c| !c.is_empty()).ok_or_else(|| USAGE.to_string())?;
    Ok(Cli { command, config: PathBuf::from(config) })
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| die(&format!("cannot start: {e}")))
}

/// `lucid-relay connector ...`.
pub fn main(args: &[String]) -> ! {
    let cli = parse_cli(args, std::env::var(CONFIG_ENV).ok()).unwrap_or_else(|e| die(&e));
    let cfg = Config::load(&cli.config).unwrap_or_else(|e| die(&e));
    match cli.command {
        Command::Serve => serve_cli(cfg),
        Command::AuditVerify => print(&crate::connector_sync::verify_chains(&cfg.state_dir, &cfg.connector_id).unwrap_or_else(|e| die(&e))),
        Command::Keygen { app } => {
            if !cfg.apps.contains(&app) {
                die(&not_configured(&app));
            }
            let (sealed, _) = open_sealed(&cfg).unwrap_or_else(|e| die(&e));
            let csr = Enroll::new(&cfg.state_dir, sealed).keygen(&app).unwrap_or_else(|e| die(&e));
            println!("{app}: the key is made and sealed on this host; have the CA sign {} as an app certificate, then run connector install", csr.display());
        }
        Command::Install { app, cert, chain } => {
            if !cfg.apps.contains(&app) {
                die(&not_configured(&app));
            }
            let (sealed, _) = open_sealed(&cfg).unwrap_or_else(|e| die(&e));
            let (cert_pem, chain_pem, ca_pem) = (read_text(&cert).unwrap_or_else(|e| die(&e)), read_text(&chain).unwrap_or_else(|e| die(&e)), read_text(&cfg.client_ca).unwrap_or_else(|e| die(&e)));
            let id = Enroll::new(&cfg.state_dir, sealed).install(&app, &cert_pem, &chain_pem, &ca_pem, now_ms()).unwrap_or_else(|e| die(&e));
            println!("{app} is installed: {} device {}, valid until {}", id.principal, id.device, iso_time(id.not_after_ms));
        }
        Command::Apps => print(&apps_report(&cfg).unwrap_or_else(|e| die(&e))),
        Command::Forget { app } => {
            if !app_name_ok(&app) {
                die(BAD_APP_NAME);
            }
            let (sealed, _) = open_sealed(&cfg).unwrap_or_else(|e| die(&e));
            let store = ContentStore::open(&cfg.state_dir, sealed).unwrap_or_else(|e| die(&e));
            let p = store.forget(&app).unwrap_or_else(|e| die(&e.to_string()));
            log_info(&format!("connector.store.purged app={} reason={} records={} bytes={}", p.app, p.reason, p.records, p.bytes));
            print(&json!({"app": p.app, "reason": p.reason, "records": p.records, "bytes": p.bytes}));
        }
        Command::SpokesKeygen => {
            let k = crate::connector_spokes::keygen(&cfg, now_ms().div_euclid(1000)).unwrap_or_else(|e| die(&e));
            print(&json!({
                "node": k.node, "check_code": k.check_code, "key_store": k.key_store, "request": k.request.to_string_lossy(),
                "next": "root approve --dir <root dir> <request> --service <name>@apps.<domain>, then connector spokes-install --cert <file> --root root.pub",
            }));
        }
        Command::SpokesInstall { cert, root, seat } => {
            let c = crate::connector_spokes::install(&cfg, &cert, root.as_deref(), seat.as_deref(), now_ms().div_euclid(1000)).unwrap_or_else(|e| die(&e));
            print(&json!({"node": c.node, "serial": c.serial, "email": c.user.map(|u| u.email), "expires": iso_time(c.exp.saturating_mul(1000))}));
        }
        Command::SpokesAdd { cert } => {
            let c = crate::connector_spokes::add_spoke(&cfg, &cert, now_ms().div_euclid(1000)).unwrap_or_else(|e| die(&e));
            print(&json!({"spoke": c.node, "label": c.label, "classification": c.classification, "expires": iso_time(c.exp.saturating_mul(1000))}));
        }
    }
    std::process::exit(0)
}

/// `connector apps`: per API app its certificate end, its state in the pinned policy, the conversations its
/// verified logs make it a member of, and its last sync.
pub fn apps_report(cfg: &Config) -> Result<Value, String> {
    let (sealed, key_store) = open_sealed(cfg)?;
    let now = now_ms();
    let enroll = Enroll::new(&cfg.state_dir, sealed.clone());
    let trust = OrgTrust::open(&cfg.org, &read_text(&cfg.client_ca)?, Some(cfg.state_dir.clone()), true, now)?;
    let mut out = Vec::new();
    for app in &cfg.apps {
        out.push(match enroll.load(app) {
            Err(e) => json!({"app": app, "error": e}),
            Ok(id) => {
                let (conversations, last_sync) = stored_status(&sealed, app, &id.principal)?;
                json!({
                    "app": app, "principal": id.principal, "device": id.device,
                    "certificate": {"not_after": iso_time(id.not_after_ms), "expired": id.expired(now), "renew_due": id.renew_due(now)},
                    "policy": trust.app_state(&id.principal, &id.device, now).code(),
                    "conversations": conversations, "last_sync": last_sync.map(iso_time),
                })
            }
        });
    }
    let policy = trust.own_pin().map(|p| json!({"seq": p.seq, "hash": p.hash, "expires": p.expires}));
    Ok(json!({"org": cfg.org, "connector_id": cfg.connector_id, "seal": key_store, "policy": policy, "apps": out}))
}

// ── the process ─────────────────────────────────────────────────────────────────────────────────────────────

/// The connector: its config, sealed store, content store, org trust and one session per API app. What slices 1c4
/// and 1c5 read and call.
pub struct Connector {
    pub cfg: Config,
    key_store: &'static str,
    pub shared: Arc<Shared>,
    pub sessions: BTreeMap<String, Arc<AppSession>>,
    links: BTreeMap<String, Arc<RelayLink>>,
    /// Revision 6 7.2.3: the service hub, once `serve` started it (slice 1d4's A2A server calls it).
    spokes_hub: OnceLock<Arc<crate::connector_spokes::ServiceHub>>,
}

impl Connector {
    /// Everything `serve` needs, nothing connected yet. `hooks` receive the sessions' verified content (`Hooks`).
    pub fn open(cfg: Config, hooks: Arc<dyn ContentHooks>) -> Result<Connector, String> {
        let (sealed, key_store) = open_sealed(&cfg)?;
        let ca_pem = read_text(&cfg.client_ca)?;
        let store = Arc::new(ContentStore::open(&cfg.state_dir, sealed.clone())?);
        let trust = OrgTrust::open(&cfg.org, &ca_pem, Some(cfg.state_dir.clone()), true, now_ms())?;
        let shared = Arc::new(Shared { ca_pem, trust, store, sealed, hooks, enclave: cfg.enclave.on });
        let relay_ca = cfg.relay_ca.to_string_lossy().into_owned();
        let mut sessions = BTreeMap::new();
        let mut links = BTreeMap::new();
        for app in &cfg.apps {
            // until the app's certificate loads, its link has no client certificate (the runner sets it)
            let anonymous = crate::meet_tls::client_config(Some(relay_ca.as_str()), None)?;
            let link = Arc::new(RelayLink::new(&cfg.relay, anonymous, cfg.enclave.clone())?);
            sessions.insert(app.clone(), Arc::new(AppSession::new(app, shared.clone(), link.clone())));
            links.insert(app.clone(), link);
        }
        Ok(Connector { cfg, key_store, shared, sessions, links, spokes_hub: OnceLock::new() })
    }

    /// A connector over sessions the tests made (the recorded relay of `connector_session::tests::World`): config
    /// `acme`, connector `k_7a1b2c3d4e5f6a7b`, origin `https://connector.acme.test:9445`, state under `state_dir`.
    #[cfg(test)]
    pub(crate) fn for_test(state_dir: &Path, shared: Arc<Shared>, sessions: BTreeMap<String, Arc<AppSession>>) -> Connector {
        let v = json!({
            "org": "acme", "connector_id": "k_7a1b2c3d4e5f6a7b", "state_dir": state_dir.to_string_lossy(), "tls_cert": "server.crt", "tls_key": "server.key",
            "client_ca": "meet-ca.pem", "relay": "https://relay.acme.test:8443", "console": "https://console.acme.test:9443",
            "console_spki": "ab".repeat(32), "seal": {"source": "systemd-creds", "credential": "lucid-api-seal", "encrypted_file": "seal.cred"},
            "apps": sessions.keys().map(|a| json!({"name": a})).collect::<Vec<_>>(),
        });
        let cfg = Config::parse(&v, state_dir).expect("the test config reads");
        Connector { cfg, key_store: crate::connector_seal::KEY_STORE_OS, shared, sessions, links: BTreeMap::new(), spokes_hub: OnceLock::new() }
    }

    pub fn session(&self, app: &str) -> Option<&Arc<AppSession>> {
        self.sessions.get(app)
    }

    /// The content store (2.7).
    pub fn store(&self) -> &Arc<ContentStore> {
        &self.shared.store
    }

    pub fn trust(&self) -> &OrgTrust {
        &self.shared.trust
    }

    /// 2.8 ack `seal`: revision 6's `key_store` of the configured seal.
    pub fn key_store(&self) -> &'static str {
        self.key_store
    }

    /// 2.8 ack `features`: the revision 5 map shape names it accepts (3.3) and `journal-1c` (it applies the 4b
    /// console journal actions of 4.2). Later revisions add theirs. Revision 6 7.2.1: an enclave connector also lists
    /// `a2a-enclave`, so the console stages no agent on it.
    pub fn features(&self) -> Vec<String> {
        let mut out: Vec<String> = FEATURES.iter().map(|f| f.to_string()).collect();
        if self.cfg.enclave.on {
            out.push(crate::connector_spokes::A2A_ENCLAVE.to_string());
        }
        out
    }

    /// Revision 6 7.2.3: the service hub, while `serve` runs it (None without `spokes_hub`, in an enclave, or when it
    /// did not start).
    pub fn spokes_hub(&self) -> Option<&Arc<crate::connector_spokes::ServiceHub>> {
        self.spokes_hub.get()
    }

    /// 2.8 ack `conversations`: every app's verified group chats and channels, while the app serves.
    pub fn conversations(&self) -> Vec<ConversationInfo> {
        self.sessions.values().flat_map(|s| s.conversations()).collect()
    }

    /// One maintenance round: each app's serving state (marks), then the store's due purges (each handed to the
    /// hooks' `purged`, which audits it), retention from the pinned policy and the size cap.
    pub fn maintain(&self, now_ms: i64) {
        for s in self.sessions.values() {
            s.health(now_ms);
        }
        let report = self.shared.store.maintenance(now_ms, &self.shared.trust.retention_days(), self.cfg.store_max_bytes);
        for p in &report.purged {
            log_info(&format!("connector.store.purged app={} cid={} reason={} records={} bytes={}", p.app, p.cid.as_deref().unwrap_or("*"), p.reason, p.records, p.bytes));
            let principal = self.sessions.get(&p.app).map(|s| s.principal().0).unwrap_or_default();
            self.shared.hooks.purged(&principal, p, now_ms);
        }
        for e in &report.errors {
            log_warn(&format!("connector_maintenance_error error={e}"));
        }
        log_info(&format!(
            "connector_maintenance retention_deleted={} cap_deleted={} files_expired={} lucid_connector_store_bytes={}",
            report.retention_deleted, report.cap_deleted, report.files_expired, report.bytes
        ));
    }
}

/// The listener's TLS key (PKCS#8): a key still at `tls_key` is sealed (2.6) and the clear file removed; after that
/// only the sealed copy is used. The connector does not start while the clear file is still there.
pub fn sealed_tls_key(cfg: &Config, sealed: &SealedStore) -> Result<Vec<u8>, String> {
    sealed_tls_key_with(cfg, sealed, &remove_durable)
}

/// `sealed_tls_key` with the durable removal given (tests make it fail).
fn sealed_tls_key_with(cfg: &Config, sealed: &SealedStore, remove: &dyn Fn(&Path) -> std::io::Result<()>) -> Result<Vec<u8>, String> {
    match std::fs::read(&cfg.tls_key) {
        Ok(mut pem) => {
            let key = rustls_pemfile::private_key(&mut pem.as_slice()).map_err(|e| format!("tls_key does not read: {e}"));
            wipe(&mut pem);
            let der = match key?.ok_or(TLS_KEY_NOT_PKCS8)? {
                PrivateKeyDer::Pkcs8(k) => k.secret_pkcs8_der().to_vec(),
                _ => return Err(TLS_KEY_NOT_PKCS8.to_string()),
            };
            sealed.put_bytes(names::TLS_KEY, &der)?;
            if let Err(e) = remove(&cfg.tls_key) {
                log_error(&format!("connector_tls_key_sealed_left_in_clear path={} error={e}", cfg.tls_key.display()));
                return Err(TLS_KEY_LEFT_IN_CLEAR.to_string());
            }
            if cfg.tls_key.exists() {
                return Err(TLS_KEY_LEFT_IN_CLEAR.to_string());
            }
            log_info(&format!("connector_tls_key_sealed removed={}", cfg.tls_key.display()));
            Ok(der)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => sealed.get_bytes(names::TLS_KEY)?.ok_or_else(|| TLS_KEY_MISSING.to_string()),
        Err(e) => Err(format!("cannot read {}: {e}", cfg.tls_key.display())),
    }
}

/// The listener's server TLS: `tls_cert` and the sealed key, TLS 1.2 or later, HTTP/1.1. API callers authenticate
/// with OAuth tokens (1c4), so no client certificate is asked.
pub fn listener_tls(cfg: &Config, sealed: &SealedStore) -> Result<Arc<ServerConfig>, String> {
    let certs = rustls_pemfile::certs(&mut std::fs::read(&cfg.tls_cert).map_err(|e| format!("cannot read {}: {e}", cfg.tls_cert.display()))?.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("tls_cert does not read: {e}"))?;
    if certs.is_empty() {
        return Err("tls_cert holds no certificate".to_string());
    }
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(sealed_tls_key(cfg, sealed)?));
    let mut tls = ServerConfig::builder_with_provider(Arc::new(crate::server::provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("tls_cert and tls_key do not fit: {e}"))?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(tls))
}

// ── the sessions' hooks (7.5, 7.6, 12.2) ────────────────────────────────────────────────────────────────────

/// The sessions' `ContentHooks`: content events to the long poll, approval answers and Stops to the approvals (set
/// once they are open, before any session starts), and every store purge into the audit chain as
/// `connector.store.purged` (`app` the app's principal, `conv` the cid when one conversation went, `items` the
/// records). A purge the chain cannot take is a security log line, never a reason to keep content.
pub struct Hooks {
    org: String,
    pub events: Arc<ContentEvents>,
    approvals: OnceLock<Arc<Approvals>>,
    audit: OnceLock<Arc<ApiAudit>>,
}

impl Hooks {
    pub fn new(org: &str) -> Hooks {
        Hooks { org: org.to_string(), events: Arc::new(ContentEvents::new()), approvals: OnceLock::new(), audit: OnceLock::new() }
    }

    pub fn set_approvals(&self, approvals: Arc<Approvals>) {
        let _ = self.approvals.set(approvals);
    }

    pub fn set_audit(&self, audit: Arc<ApiAudit>) {
        let _ = self.audit.set(audit);
    }
}

impl ContentHooks for Hooks {
    fn approval_answer(&self, app: &str, person: &str, mid: &str, apra: &Value) {
        match self.approvals.get() {
            Some(a) => a.answer(app, person, mid, apra, now_ms()),
            None => log_warn(&format!("connector_approval_answer_early app={app}")),
        }
    }

    fn person_stop(&self, app: &str, person: &str, client: &str, mid: &str) {
        match self.approvals.get() {
            Some(a) => a.person_stop(app, person, client, mid, now_ms()),
            None => log_error(&format!("connector_person_stop_early app={app}")),
        }
    }

    fn event(&self, app: &str, ev: &ContentEvent) {
        self.events.push(app, ev);
    }

    fn purged(&self, principal: &str, p: &Purged, now_ms: i64) {
        let Some(audit) = self.audit.get() else { return };
        let mut e = json!({"action": "connector.store.purged", "result": "ok", "check": p.reason, "items": p.records});
        if !principal.is_empty() {
            e["app"] = json!(principal);
        }
        if let Some(cid) = &p.cid {
            e["conv"] = json!(cid);
        }
        if let Err(err) = audit.record(&self.org, e, now_ms.div_euclid(1000)) {
            log_error(&format!("api.audit-failed org={} action=connector.store.purged why={}", self.org, err.message));
        }
    }
}

// ── the listener ────────────────────────────────────────────────────────────────────────────────────────────

fn reply(status: u16, v: &Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(v.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn answer_response(a: Answer) -> Response<Full<Bytes>> {
    let mut b = Response::builder().status(a.status);
    for (k, v) in &a.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    b.body(Full::new(Bytes::from(a.body))).unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

/// A request body of at most `BODY_MAX` bytes: Err `too-large` past it, `request` when it could not be read in 30 s.
async fn read_body(req: hyper::Request<Incoming>) -> Result<Vec<u8>, &'static str> {
    match tokio::time::timeout(Duration::from_secs(30), Limited::new(req.into_body(), BODY_MAX).collect()).await {
        Ok(Ok(c)) => Ok(c.to_bytes().to_vec()),
        Ok(Err(e)) if e.is::<http_body_util::LengthLimitError>() => Err("too-large"),
        _ => Err("request"),
    }
}

/// One request: `GET /healthz` here; everything else to the connector resource routes on a blocking thread (audit
/// appends fsync; the content events long poll holds up to 30 s).
async fn handle(api: Arc<ConnectorApi>, ip: IpAddr, req: hyper::Request<Incoming>) -> Response<crate::connector_a2a::Body> {
    if req.method() == hyper::Method::GET && req.uri().path() == "/healthz" {
        return reply(200, &json!({"ok": true})).map(Either::Left);
    }
    // revision 5 8.2: CM, its headers checked before its body is read (slice 1c5)
    if crate::mcp::endpoint_org(req.uri().path()).is_some() {
        return crate::connector_mcp::handle(api, ip, req).await.map(Either::Left);
    }
    // revision 6 7.3: A = C/a2a, its own body limit and SSE answers (slice 1d4)
    if crate::connector_a2a_wire::a2a_org(req.uri().path()).is_some() {
        if let Some(a2a) = api.a2a().cloned() {
            return crate::connector_a2a::handle(a2a, api, ip, req).await;
        }
    }
    let method = req.method().as_str().to_owned();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let header = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (authorization, dpop, idempotency_key) = (header("authorization"), header("dpop"), header("idempotency-key"));
    let body = if matches!(method.as_str(), "GET" | "HEAD") { None } else { Some(read_body(req).await) };
    let answer = tokio::task::spawn_blocking(move || {
        let request = Request {
            method: &method,
            path: &path,
            query: &query,
            authorization: authorization.as_deref(),
            dpop: dpop.as_deref(),
            idempotency_key: idempotency_key.as_deref(),
            body: body.as_ref().map(|b| b.as_deref().map_err(|e| *e)),
            source: ip,
            now_ms: now_ms(),
        };
        api.answer(&request)
    })
    .await;
    match answer {
        Ok(a) => answer_response(a).map(Either::Left),
        Err(_) => reply(503, &json!({"ok": false, "code": "unavailable", "error": "The request failed; try again."})).map(Either::Left),
    }
}

/// Serve the listener until the process stops; in an enclave, connections from outside `enclave_networks` are
/// closed before TLS.
pub async fn serve(enclave: Enclave, listener: TcpListener, acceptor: TlsAcceptor, api: Arc<ConnectorApi>) {
    loop {
        let (tcp, addr) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        if !enclave.peer_allowed(addr.ip()) {
            log_info(&format!("connector_peer_refused address={} (outside the enclave networks)", addr.ip()));
            continue;
        }
        let acceptor = acceptor.clone();
        let api = api.clone();
        let ip = addr.ip();
        tokio::spawn(async move {
            let Some(tls) = crate::server::tls_within(&acceptor, tcp, Duration::from_secs(10)).await else { return };
            let svc = service_fn(move |req: hyper::Request<Incoming>| {
                let api = api.clone();
                async move { Ok::<_, Infallible>(handle(api, ip, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(tls), svc).await;
        });
    }
}

/// How often waiting approvals are checked for expiry (7.5: `exp` is 600 s after the request).
pub const APPROVALS_EVERY: Duration = Duration::from_secs(15);

/// At least every 5 minutes (2.7): `Connector::maintain` off the async workers; and every 15 s the approvals' expiry.
async fn maintenance(conn: Arc<Connector>, approvals: Arc<Approvals>) {
    let mut last = 0i64;
    loop {
        let now = now_ms();
        let a = approvals.clone();
        if tokio::task::spawn_blocking(move || a.tick(now)).await.is_err() {
            log_error("connector_approvals_tick_failed");
        }
        if now - last >= MAINTENANCE_EVERY.as_millis() as i64 {
            last = now;
            let c = conn.clone();
            if tokio::task::spawn_blocking(move || c.maintain(now)).await.is_err() {
                log_error("connector_maintenance_failed");
            }
        }
        tokio::time::sleep(APPROVALS_EVERY).await;
    }
}

fn serve_cli(cfg: Config) -> ! {
    let rt = runtime();
    rt.block_on(async {
        let (host, port) = cfg.listen.clone();
        let client_ca_pem = read_text(&cfg.client_ca).unwrap_or_else(|e| die(&e));
        let relay_ca_pem = read_text(&cfg.relay_ca).unwrap_or_else(|e| die(&e));
        let hooks = Arc::new(Hooks::new(&cfg.org));
        let conn = Arc::new(Connector::open(cfg, hooks.clone()).unwrap_or_else(|e| die(&e)));
        let (org, id, dir, sealed) = (conn.cfg.org.clone(), conn.cfg.connector_id.clone(), conn.cfg.state_dir.clone(), conn.shared.sealed.clone());
        let sync = Arc::new(SyncState::open(&org, &id, &dir, sealed.clone()).unwrap_or_else(|e| die(&e)));
        let audit = crate::connector_sync::open_audit(&dir, &id, sealed, sync.clone(), now_ms().div_euclid(1000));
        hooks.set_audit(audit.clone());
        let approvals = Arc::new(Approvals::open(conn.clone(), sync.clone(), audit.clone()).unwrap_or_else(|e| die(&e)));
        hooks.set_approvals(approvals.clone());
        let api = Arc::new(ConnectorApi::new(conn.clone(), sync.clone(), audit.clone(), approvals.clone(), hooks.events.clone()));
        // revision 5 6.3: delegation notices leave from their own worker; without it the connector serves all the same
        if let Err(e) = api.start_notices(Box::new(now_ms)) {
            log_error(&format!("connector_notices_off reason={e}"));
        }
        let acceptor = TlsAcceptor::from(listener_tls(&conn.cfg, &conn.shared.sealed).unwrap_or_else(|e| die(&e)));
        let listener = TcpListener::bind((host.as_str(), port)).await.unwrap_or_else(|e| die(&format!("cannot listen on {host}:{port}: {e}")));
        // revision 6 7.2.3: the service hub (never in an enclave, 7.2.1); one that does not start leaves the connector
        // serving without A2A
        if conn.cfg.spokes_hub.is_some() {
            let (pinned, map_org) = (sync.clone(), conn.cfg.org.clone());
            let map: crate::connector_spokes::PinnedMap = Arc::new(move || pinned.store().get(&map_org, "").map(|vm| vm.map().clone()));
            match crate::connector_spokes::start(&conn.cfg, map) {
                Ok(hub) => {
                    let _ = conn.spokes_hub.set(hub);
                }
                Err(e) => log_error(&format!("connector_spokes_hub_off reason={e}")),
            }
        }
        // revision 6 7.2 (slice 1d4): the A2A server under A, wired to the service hub (without one, or in an enclave,
        // every A route answers 503)
        let a2a = crate::connector_a2a::A2aServer::start(conn.clone(), sync.clone(), audit.clone(), conn.spokes_hub().cloned()).unwrap_or_else(|e| die(&e));
        api.set_a2a(a2a);
        crate::connector_sync::spawn(conn.clone(), sync, audit).unwrap_or_else(|e| die(&e));
        // the sessions start once every hook is in place, so no answer, Stop or event is dropped
        let enroll = Arc::new(Enroll::new(&conn.cfg.state_dir, conn.shared.sealed.clone()));
        for (app, session) in &conn.sessions {
            let runner = Runner { session: session.clone(), link: conn.links[app].clone(), enroll: enroll.clone(), client_ca_pem: client_ca_pem.clone(), relay_ca_pem: relay_ca_pem.clone() };
            std::thread::Builder::new().name(format!("connector-{app}")).spawn(move || runner.run()).unwrap_or_else(|e| die(&format!("cannot start the {app} session: {e}")));
        }
        tokio::spawn(maintenance(conn.clone(), approvals));
        log_info(&format!(
            "connector listening={host}:{port} org={} connector_id={} apps={} seal={} {}",
            conn.cfg.org,
            conn.cfg.connector_id,
            conn.cfg.apps.join(","),
            conn.key_store(),
            conn.cfg.enclave.line()
        ));
        tokio::select! {
            _ = serve(conn.cfg.enclave.clone(), listener, acceptor, api) => {}
            _ = tokio::signal::ctrl_c() => log_info("connector stopping"),
        }
    });
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> Value {
        json!({
            "org": "acme", "connector_id": "k_7a1b2c3d4e5f6a7b", "state_dir": "state", "tls_cert": "tls/server.crt", "tls_key": "tls/server.key",
            "client_ca": "meet-ca.pem", "relay": "https://relay.acme.example:8443", "console": "https://console.acme.example:9443",
            "console_spki": "ab".repeat(32), "seal": {"source": "systemd-creds", "credential": "lucid-api-seal", "encrypted_file": "seal.cred"},
            "apps": [{"name": "helpdesk-api"}],
        })
    }

    fn parse(v: &Value) -> Result<Config, String> {
        Config::parse(v, Path::new("/etc/lucid-api-connector"))
    }

    fn with(k: &str, x: Value) -> Value {
        let mut v = good();
        v[k] = x;
        v
    }

    #[test]
    fn a_good_config_reads_with_its_defaults_and_relative_paths() {
        let c = parse(&good()).unwrap();
        let base = Path::new("/etc/lucid-api-connector");
        assert_eq!(c.state_dir, base.join("state"));
        assert_eq!(c.tls_key, base.join("tls/server.key"));
        assert_eq!(c.client_ca, base.join("meet-ca.pem"));
        assert_eq!(c.relay_ca, c.client_ca, "relay_ca defaults to client_ca");
        assert_eq!(c.listen, ("0.0.0.0".to_string(), 9445));
        assert_eq!(c.store_max_bytes, 64 << 30);
        assert_eq!(c.apps, vec!["helpdesk-api".to_string()]);
        assert!(!c.enclave.on && c.spokes_hub.is_none());
        assert_eq!(c.seal, SealConfig::SystemdCreds { credential: "lucid-api-seal".into(), encrypted_file: base.join("seal.cred") });
        let absolute = std::env::temp_dir().join("relay-ca.pem");
        let abs = parse(&with("relay_ca", json!(absolute.to_string_lossy()))).unwrap();
        assert_eq!(abs.relay_ca, absolute);
        let hub = parse(&with("spokes_hub", json!({"client": "c_9a8b7c6d5e4f3a2b", "cert": "hub.crt", "directory": "d"}))).unwrap();
        assert_eq!(hub.spokes_hub, Some(crate::connector_spokes::HubConfig { client: "c_9a8b7c6d5e4f3a2b".into(), cert: base.join("hub.crt"), directory: base.join("d") }));
        assert_eq!(parse(&with("listen", json!("[::]:443"))).unwrap().listen, ("::".to_string(), 443));
    }

    #[test]
    fn config_refusals_are_exact() {
        assert_eq!(parse(&with("colour", json!(1))).unwrap_err(), "the connector config has no setting colour");
        for bad in ["k_7A1B2C3D4E5F6A7B", "7a1b2c3d4e5f6a7b", "k_7a1b", "k_7a1b2c3d4e5f6a7bc", "k_7a1b2c3d4e5f6a7g"] {
            assert_eq!(parse(&with("connector_id", json!(bad))).unwrap_err(), CONNECTOR_ID_BAD, "{bad}");
        }
        assert_eq!(parse(&with("apps", json!([]))).unwrap_err(), APPS_BAD);
        let seventeen: Vec<Value> = (0..17).map(|i| json!({"name": format!("app-{i}")})).collect();
        assert_eq!(parse(&with("apps", json!(seventeen))).unwrap_err(), APPS_BAD);
        let sixteen: Vec<Value> = (0..16).map(|i| json!({"name": format!("app-{i}")})).collect();
        assert_eq!(parse(&with("apps", json!(sixteen))).unwrap().apps.len(), 16);
        assert_eq!(parse(&with("apps", json!([{"name": "a"}, {"name": "a"}]))).unwrap_err(), "apps lists a twice");
        assert_eq!(parse(&with("apps", json!([{"name": "a", "x": 1}]))).unwrap_err(), APPS_BAD);
        assert_eq!(parse(&with("apps", json!([{"name": "archive"}]))).unwrap_err(), format!("apps lists \"archive\": {BAD_APP_NAME}"));
        for n in [(1u64 << 30) - 1, (1u64 << 40) + 1] {
            assert_eq!(parse(&with("store_max_bytes", json!(n))).unwrap_err(), STORE_MAX_BAD);
        }
        assert_eq!(parse(&with("store_max_bytes", json!(1.5e9))).unwrap_err(), STORE_MAX_BAD);
        for n in [1u64 << 30, 1u64 << 40] {
            assert_eq!(parse(&with("store_max_bytes", json!(n))).unwrap().store_max_bytes, n);
        }
        assert_eq!(parse(&with("enclave", json!(true))).unwrap_err(), NETWORKS_NEEDED);
        assert_eq!(parse(&with("enclave", json!("yes"))).unwrap_err(), ENCLAVE_BAD);
        assert_eq!(parse(&with("enclave_networks", json!("10.0.0.0/8"))).unwrap_err(), NETWORKS_BAD);
        assert_eq!(parse(&with("enclave_networks", json!(["10.0.0.0/33"]))).unwrap_err(), "enclave_networks has a range that is not valid: 10.0.0.0/33");
        assert_eq!(parse(&with("listen", json!("0.0.0.0"))).unwrap_err(), LISTEN_BAD);
        assert_eq!(parse(&with("listen", json!("0.0.0.0:0"))).unwrap_err(), LISTEN_BAD);
        assert_eq!(parse(&with("relay", json!("http://relay.acme.example"))).unwrap_err(), RELAY_BAD);
        assert_eq!(parse(&with("console", json!("https://console.acme.example/path"))).unwrap_err(), CONSOLE_BAD);
        assert_eq!(parse(&with("console_spki", json!("AB".repeat(32)))).unwrap_err(), CONSOLE_SPKI_BAD);
        assert_eq!(parse(&with("org", json!("Acme Corp"))).unwrap_err(), ORG_BAD);
        assert_eq!(parse(&with("spokes_hub", json!([]))).unwrap_err(), crate::connector_spokes::HUB_KEYS_BAD);
        assert_eq!(parse(&with("spokes_hub", json!({"client": "c1", "cert": "hub.crt", "directory": "d"}))).unwrap_err(), crate::connector_spokes::CLIENT_BAD);
        assert_eq!(parse(&with("spokes_hub", json!({"client": "c_9a8b7c6d5e4f3a2b", "cert": "hub.crt"}))).unwrap_err(), crate::connector_spokes::HUB_KEYS_BAD);
        let mut v = good();
        v.as_object_mut().unwrap().remove("tls_cert");
        assert_eq!(parse(&v).unwrap_err(), "the connector config needs tls_cert");
        assert_eq!(parse(&json!([])).unwrap_err(), NOT_OBJECT);
    }

    #[test]
    fn a_config_file_reads_relative_to_its_folder() {
        let dir = crate::meet_tls::testpki::dir("connector-config");
        let path = dir.join("connector.json");
        std::fs::write(&path, good().to_string()).unwrap();
        let c = Config::load(&path).unwrap();
        assert_eq!(c.state_dir, dir.join("state"));
        std::fs::write(&path, "{").unwrap();
        assert_eq!(Config::load(&path).unwrap_err(), format!("the connector config {} is not JSON", path.display()));
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cli_arguments() {
        let cli = |a: &[&str], env: Option<&str>| parse_cli(&args(a), env.map(str::to_string));
        assert_eq!(cli(&["--config", "c.json"], None).unwrap(), Cli { command: Command::Serve, config: PathBuf::from("c.json") });
        assert_eq!(cli(&["serve"], Some("/etc/c.json")).unwrap().config, PathBuf::from("/etc/c.json"));
        assert_eq!(cli(&["apps", "--config=c.json"], Some("other.json")).unwrap(), Cli { command: Command::Apps, config: PathBuf::from("c.json") });
        assert_eq!(cli(&["keygen", "--app", "helpdesk", "--config", "c.json"], None).unwrap().command, Command::Keygen { app: "helpdesk".into() });
        assert_eq!(
            cli(&["install", "--app", "helpdesk", "--cert", "h.crt", "--chain", "ch.pem", "--config", "c.json"], None).unwrap().command,
            Command::Install { app: "helpdesk".into(), cert: PathBuf::from("h.crt"), chain: PathBuf::from("ch.pem") }
        );
        assert_eq!(cli(&["forget", "--app", "helpdesk", "--config", "c.json"], None).unwrap().command, Command::Forget { app: "helpdesk".into() });
        assert_eq!(cli(&["audit-verify", "--config", "c.json"], None).unwrap().command, Command::AuditVerify);
        assert_eq!(cli(&["keygen", "--config", "c.json"], None).unwrap_err(), "connector keygen needs --app");
        assert_eq!(cli(&["install", "--app", "h", "--cert", "h.crt", "--config", "c.json"], None).unwrap_err(), "connector install needs --chain");
        assert_eq!(cli(&["apps", "--app", "h", "--config", "c.json"], None).unwrap_err(), "--app is not a flag of connector apps");
        assert_eq!(cli(&["rotate", "--config", "c.json"], None).unwrap_err(), USAGE);
        assert_eq!(cli(&["apps", "extra", "--config", "c.json"], None).unwrap_err(), USAGE);
        assert_eq!(cli(&["apps"], None).unwrap_err(), USAGE);
        assert_eq!(cli(&["keygen", "--app"], None).unwrap_err(), "--app needs a value");
        // revision 6 7.2.3
        assert_eq!(cli(&["spokes-keygen", "--config", "c.json"], None).unwrap().command, Command::SpokesKeygen);
        assert_eq!(
            cli(&["spokes-install", "--cert", "hub.cert", "--root", "root.pub", "--config", "c.json"], None).unwrap().command,
            Command::SpokesInstall { cert: "hub.cert".into(), root: Some(PathBuf::from("root.pub")), seat: None }
        );
        assert_eq!(cli(&["spokes-add", "--cert", "spoke.cert", "--config", "c.json"], None).unwrap().command, Command::SpokesAdd { cert: "spoke.cert".into() });
        assert_eq!(cli(&["spokes-install", "--config", "c.json"], None).unwrap_err(), "connector spokes-install needs --cert");
        assert_eq!(cli(&["spokes-keygen", "--app", "h", "--config", "c.json"], None).unwrap_err(), "--app is not a flag of connector spokes-keygen");
    }

    /// Revision 6 2.4 and 7.2.1: the ack reports `spokes`, and an enclave connector `a2a-enclave` as well.
    #[test]
    fn an_enclave_connector_lists_a2a_enclave() {
        use crate::connector_session::tests::{World, APP};
        let w = World::new();
        let mut conn = Connector::for_test(&w.dir, w.session.shared().clone(), BTreeMap::from([(APP.to_string(), w.session.clone())]));
        let has = |c: &Connector, f: &str| c.features().iter().any(|x| x == f);
        assert!(has(&conn, crate::api_features::SPOKES) && !has(&conn, crate::connector_spokes::A2A_ENCLAVE));
        conn.cfg.enclave = Enclave { on: true, networks: vec![parse_cidr("10.20.0.0/16").unwrap()] };
        assert!(has(&conn, crate::connector_spokes::A2A_ENCLAVE));
        assert!(conn.spokes_hub().is_none());
    }

    #[test]
    fn enclave_addresses() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let e = Enclave { on: true, networks: vec![parse_cidr("10.20.0.0/16").unwrap(), parse_cidr("fd00::/8").unwrap()] };
        assert!(e.peer_allowed(ip("10.20.3.4")));
        assert!(e.peer_allowed(ip("::ffff:10.20.3.4")), "an IPv4-mapped address is read as IPv4");
        assert!(e.peer_allowed(ip("fd12::1")));
        assert!(!e.peer_allowed(ip("10.21.0.1")));
        assert!(!e.peer_allowed(ip("8.8.8.8")));
        assert_eq!(e.check_addresses("relay.acme.example", &[ip("10.20.0.5")]), Ok(()));
        assert_eq!(e.check_addresses("relay.acme.example", &[ip("10.20.0.5"), ip("203.0.113.9")]).unwrap_err(), "relay.acme.example resolves to 203.0.113.9, outside the enclave networks");
        assert_eq!(e.check_addresses("relay.acme.example", &[]).unwrap_err(), "relay.acme.example could not be resolved");
        assert_eq!(e.check_host("127.0.0.1", 443).unwrap_err(), "127.0.0.1 resolves to 127.0.0.1, outside the enclave networks");
        let off = Enclave::default();
        assert!(off.peer_allowed(ip("8.8.8.8")));
        assert_eq!(off.check_addresses("x", &[ip("8.8.8.8")]), Ok(()));
        assert_eq!(off.check_host("never.resolved.invalid", 443), Ok(()));
        let mut v = with("enclave", json!(true));
        v["enclave_networks"] = json!(["10.20.0.0/16", "10.20.1.0/16"]);
        let parsed = parse(&v).unwrap();
        assert!(parsed.enclave.on);
        assert_eq!(parsed.enclave.networks.len(), 1, "the same range is kept once");
    }

    #[test]
    fn the_connector_does_not_start_while_the_clear_tls_key_remains() {
        use aws_lc_rs::rand::SystemRandom;
        use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let dir = crate::meet_tls::testpki::dir("connector-tls-key");
        let cfg = Config::parse(&good(), &dir).unwrap();
        std::fs::create_dir_all(cfg.tls_key.parent().unwrap()).unwrap();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &SystemRandom::new()).unwrap().as_ref().to_vec();
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", crate::meet_json::b64(&pkcs8));
        std::fs::write(&cfg.tls_key, &pem).unwrap();
        let sealed = SealedStore::open(Sealer::from_source(&crate::connector_seal::FixedSource([7; 32])).unwrap(), dir.join("sealed")).unwrap();
        // the clear copy cannot be deleted: refused, the file is still there
        let refuse = |_: &Path| -> std::io::Result<()> { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "test")) };
        assert_eq!(sealed_tls_key_with(&cfg, &sealed, &refuse).unwrap_err(), TLS_KEY_LEFT_IN_CLEAR);
        assert!(cfg.tls_key.exists());
        // a removal that reports success but leaves the file is refused too
        let keep = |_: &Path| -> std::io::Result<()> { Ok(()) };
        assert_eq!(sealed_tls_key_with(&cfg, &sealed, &keep).unwrap_err(), TLS_KEY_LEFT_IN_CLEAR);
        // the real removal: the key comes back from the sealed copy and the clear file is gone
        assert_eq!(sealed_tls_key(&cfg, &sealed).unwrap(), pkcs8);
        assert!(!cfg.tls_key.exists());
        assert_eq!(sealed_tls_key(&cfg, &sealed).unwrap(), pkcs8, "later starts use the sealed copy");
    }
}
