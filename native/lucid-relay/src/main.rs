// lucid-relay (ADR-0534): the remote-spokes relay in Rust, phase A. A drop-in for the add-on's
// `lucid-spoke relay serve`: the same flags and environment (relayServeConfig in src/relay.ts), so a systemd unit or
// a container swaps only the program. `relay serve` in front of the flags is accepted and ignored, so the existing
// ExecStart and ENTRYPOINT arguments work unchanged.
//
//   lucid-relay [relay serve] --root <root.pub> --license <file> [--host 127.0.0.1] [--port 8787]
//               [--tls-cert f --tls-key f] [--state <dir>] [--sender-mib 16]
//     (or LUCID_RELAY_ROOT_PUB, _LICENSE, _HOST, _PORT/PORT, _TLS_CERT, _TLS_KEY, _STATE, _SENDER_MIB, _BEHIND_TLS=1)
//               [--console 1]   the control panel at /console/ (or LUCID_RELAY_CONSOLE=1; needs --state; src/console.rs)
//   lucid-relay --owner <spoke node id> ...   a spoke's LAN mailbox: carries mail to and from that spoke only, needs
//               no licence; with --state it keeps crl, lan-mailbox-seen.json and lan-mail/ as the spoke agent does.
//   lucid-relay collab [--host=…] [--port=…] …   phase B, the core's collab broker (tools/relay/serve.ts; src/collab.rs).

mod codec;
mod collab;
mod collab_auth;
mod collab_presence;
mod console;
mod console_page;
mod console_webauthn;
mod der;
mod http_client;
mod identity;
mod license;
mod log;
mod relay;
mod server;
mod store;
#[cfg(test)]
mod vectors;

use crate::codec::{js_is_integer, js_number, js_trim_start};
use crate::license::{license_token_of, LICENSE_USERS_FILE};
use crate::log::{Fields, Level, Logger};
use crate::relay::{HostCheck, Options, State, LICENSE_CHECK_MS, SENDER_BYTES, STORE_BYTES};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const FLAGS: [&str; 10] = ["root", "host", "port", "tls-cert", "tls-key", "state", "license", "sender-mib", "owner", "console"];

fn die(msg: &str) -> ! {
    eprintln!("lucid-relay: {msg}");
    std::process::exit(1);
}

/// `--name value` and `--name=value`, the last one winning; `relay serve` in front is accepted.
fn parse_args(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut flags = HashMap::new();
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        let Some(name) = a.strip_prefix("--") else {
            positionals.push(a.as_str());
            continue;
        };
        if name == "version" {
            println!("lucid-relay {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        }
        let (name, value) = match name.split_once('=') {
            Some((n, v)) => (n, v.to_owned()),
            None => {
                let v = args.get(i).ok_or_else(|| format!("option '--{name} <value>' argument missing"))?;
                i += 1;
                (name, v.clone())
            }
        };
        if !FLAGS.contains(&name) {
            return Err(format!("unknown option '--{name}'"));
        }
        flags.insert(name.to_owned(), value);
    }
    if !(positionals.is_empty() || positionals == ["relay", "serve"] || positionals == ["serve"]) {
        return Err(format!("unexpected argument '{}': this program is `relay serve`", positionals.join(" ")));
    }
    Ok(flags)
}

/// A PEM value given inline or as a file path (files.ts pemOrFile).
fn pem_or_file(value: &str) -> Result<String, String> {
    if js_trim_start(value).starts_with("-----BEGIN") {
        return Ok(value.to_owned());
    }
    std::fs::read(value).map(|b| codec::utf8_lossy(&b)).map_err(|e| format!("cannot read {value}: {e}"))
}

struct Config {
    root_pem: String,
    hostname: String,
    port: u16,
    tls: Option<(String, String)>,
    state: Option<String>,
    behind_tls: bool,
    license: Option<String>,
    sender_bytes: Option<i64>,
    owner: Option<String>,
}

/// relay.ts relayServeConfig: flags first, then environment; an empty value is unset.
fn relay_serve_config(flags: &HashMap<String, String>, env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    let get = |flag: &str, vars: &[&str]| -> Option<String> {
        let f = flags.get(flag).filter(|v| !v.is_empty()).cloned();
        f.or_else(|| vars.iter().find_map(|k| env(*k).filter(|v| !v.is_empty())))
    };
    let root = get("root", &["LUCID_RELAY_ROOT_PUB"]).ok_or("the owner root public key is required (--root or LUCID_RELAY_ROOT_PUB, PEM or path)")?;
    let license = get("license", &["LUCID_RELAY_LICENSE"]);
    let (cert, key) = (get("tls-cert", &["LUCID_RELAY_TLS_CERT"]), get("tls-key", &["LUCID_RELAY_TLS_KEY"]));
    if cert.is_none() != key.is_none() {
        return Err("give both the TLS certificate and its key (--tls-cert/--tls-key or LUCID_RELAY_TLS_CERT/LUCID_RELAY_TLS_KEY), or neither".into());
    }
    let behind = env("LUCID_RELAY_BEHIND_TLS").filter(|v| !v.is_empty()).unwrap_or_else(|| "0".into());
    if behind != "0" && behind != "1" {
        return Err("LUCID_RELAY_BEHIND_TLS must be 1 (a platform front terminates TLS) or unset".into());
    }
    let host = get("host", &["LUCID_RELAY_HOST"]);
    let port_text = get("port", &["LUCID_RELAY_PORT", "PORT"]);
    if cert.is_some() && behind == "1" {
        return Err("LUCID_RELAY_BEHIND_TLS=1 and a TLS certificate are both set: the relay terminates TLS itself or sits behind a platform front, not both".into());
    }
    if cert.is_none() && behind != "1" {
        return Err("refusing plain HTTP: give a TLS certificate and key, or set LUCID_RELAY_BEHIND_TLS=1 when a platform front terminates TLS".into());
    }
    if behind == "1" && (host.is_none() || port_text.is_none()) {
        return Err("behind a TLS front the relay binds only the address it is given: set the host (--host or LUCID_RELAY_HOST) and the port (--port, LUCID_RELAY_PORT or PORT)".into());
    }
    let port = js_number(port_text.as_deref().unwrap_or("8787"));
    if !js_is_integer(port) || !(1.0..=65_535.0).contains(&port) {
        return Err(format!("port {} is not 1 to 65535", port_text.as_deref().unwrap_or("undefined")));
    }
    let sender_text = get("sender-mib", &["LUCID_RELAY_SENDER_MIB"]);
    let sender_mib = js_number(sender_text.as_deref().unwrap_or("0"));
    if let Some(text) = &sender_text {
        if !js_is_integer(sender_mib) || !(1.0..=1024.0).contains(&sender_mib) {
            return Err(format!("the per-sender quota {text} is not 1 to 1024 MiB (--sender-mib or LUCID_RELAY_SENDER_MIB)"));
        }
    }
    let owner = flags.get("owner").filter(|v| !v.is_empty()).cloned();
    if let Some(o) = &owner {
        if !identity::is_node_id(o) {
            return Err("--owner must be the spoke's node id (n_ and 32 hex)".into());
        }
        if license.is_some() {
            return Err("a LAN mailbox (--owner) carries no licence: leave out --license and LUCID_RELAY_LICENSE".into());
        }
    }
    let tls = match (cert, key) {
        (Some(c), Some(k)) => Some((pem_or_file(&c)?, pem_or_file(&k)?)),
        _ => None,
    };
    Ok(Config {
        root_pem: pem_or_file(&root)?,
        hostname: host.unwrap_or_else(|| "127.0.0.1".into()),
        port: port as u16,
        tls,
        state: get("state", &["LUCID_RELAY_STATE"]),
        behind_tls: behind == "1",
        license: license.map(|l| pem_or_file(&l).map(|text| license_token_of(&text))).transpose()?,
        sender_bytes: sender_text.map(|_| sender_mib as i64 * 1024 * 1024),
        owner,
    })
}

/// The owner root public key from its PEM (createPublicKey, then TrustStore's P-256 check).
fn root_key(pem: &str) -> Result<p256::ecdsa::VerifyingKey, String> {
    let der = der::pem_blocks(pem, "PUBLIC KEY").into_iter().next().ok_or("the owner root public key is not a PUBLIC KEY PEM")?;
    der::p256_from_spki(&der).ok_or_else(|| "root key must be ECDSA P-256".into())
}

#[cfg(unix)]
async fn stop_signal() -> &'static str {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        std::future::pending::<()>().await;
        return "SIGTERM";
    };
    tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    }
}

#[cfg(not(unix))]
async fn stop_signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "SIGINT"
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Phase B: the collab broker (tools/relay/serve.ts). Everything else is `relay serve` (phase A).
    if args.first().map(String::as_str) == Some("collab") {
        collab::main(&args[1..]);
    }
    let flags = parse_args(&args).unwrap_or_else(|e| die(&e));
    let c = relay_serve_config(&flags, |k| std::env::var(k).ok()).unwrap_or_else(|e| die(&e));
    // A shared relay always runs under the org's relay licence; a spoke's LAN mailbox needs none.
    if c.owner.is_none() && c.license.is_none() {
        die("the relay licence is required (--license or LUCID_RELAY_LICENSE: the licence file or its armoured text)");
    }
    // The control panel (src/console.rs): --console 1 or LUCID_RELAY_CONSOLE=1; when on, the logger feeds its ring.
    let base = Logger::new(if c.owner.is_some() { "lan-mailbox" } else { "relay" });
    let (logger, console) = console::open(flags.get("console"), |k| std::env::var(k).ok(), c.state.as_deref(), c.owner.is_some(), base).unwrap_or_else(|e| die(&e));
    let root = root_key(&c.root_pem).unwrap_or_else(|e| die(&e));
    let state = c.state.as_deref().map(Path::new);
    let at = |name: &str| state.map(|d| d.join(name));
    let lan = c.owner.is_some();
    let opts = Options {
        root,
        owner: c.owner.clone(),
        license: c.license.clone(),
        crl_file: at("crl"),
        store: at(if lan { "lan-mail" } else { "mail" }),
        seen_file: at(if lan { "lan-mailbox-seen.json" } else { "seen.json" }),
        directory_file: if lan { None } else { at("relay-directory") },
        users_file: if lan { None } else { at(LICENSE_USERS_FILE) },
        store_bytes: STORE_BYTES,
        sender_bytes: c.sender_bytes.unwrap_or(SENDER_BYTES),
        console,
    };
    if c.behind_tls {
        logger.ops("plain-http", &Fields::new().with("why", "a platform front terminates TLS (LUCID_RELAY_BEHIND_TLS=1)"), Level::Info);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| die(&e.to_string()));
    runtime.block_on(async move {
        let st = State::new(opts, logger.clone()).unwrap_or_else(|e| die(&e));
        let names = c.tls.as_ref().map(|(cert, _)| der::CertNames::from_pem(cert).unwrap_or_else(|| die("the TLS certificate does not parse")));
        let acceptor = c.tls.as_ref().map(|(cert, key)| server::tls_acceptor(cert, key).unwrap_or_else(|e| die(&e)));
        let listener = tokio::net::TcpListener::bind((c.hostname.as_str(), c.port)).await.unwrap_or_else(|e| die(&format!("cannot listen on {}:{}: {e}", c.hostname, c.port)));
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(c.port);
        let licensed = st.licensed();
        let has_store = c.state.is_some();
        let relay = Arc::new(server::Relay { state: Mutex::new(st), logger: logger.clone(), hosts: HostCheck { names, port }, tls: c.tls.is_some() });
        let shown = if c.hostname.contains(':') { format!("[{}]", c.hostname) } else { c.hostname.clone() };
        let url = format!("{}://{shown}:{port}/", if c.tls.is_some() { "https" } else { "http" });
        logger.ops("listening", &Fields::new().with("url", url).with("licensed", licensed).with("store", has_store).with("owner", c.owner.clone()), Level::Info);
        if licensed {
            // An idle relay must still write its daily licence lines, which an operator's alert is raised from.
            let daily = relay.clone();
            tokio::spawn(async move {
                let mut every = tokio::time::interval(Duration::from_millis(LICENSE_CHECK_MS));
                every.tick().await;
                loop {
                    every.tick().await;
                    let _ = daily.state.lock().check_license(codec::now_ms());
                }
            });
        }
        tokio::spawn(server::run(listener, relay, acceptor));
        let signal = stop_signal().await;
        logger.ops("stopping", &Fields::new().with("signal", signal), Level::Info);
        std::process::exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    const PEM: &str = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";

    #[test]
    fn config_matches_relay_serve() {
        let err = |f: &[(&str, &str)], e: &'static [(&'static str, &'static str)]| relay_serve_config(&flags(f), env(e)).err().unwrap_or_default();
        assert!(err(&[], &[]).contains("root public key is required"));
        assert!(err(&[("root", PEM)], &[]).contains("refusing plain HTTP"));
        assert!(err(&[("root", PEM), ("host", "0.0.0.0"), ("port", "8080")], &[("LUCID_RELAY_BEHIND_TLS", "true")]).contains("must be 1"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_BEHIND_TLS", "1"), ("PORT", "8080")]).contains("binds only the address it is given"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "0.0.0.0"), ("PORT", "70000")]).contains("not 1 to 65535"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_TLS_CERT", PEM)]).contains("both the TLS certificate and its key"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "127.0.0.1"), ("PORT", "8080"), ("LUCID_RELAY_SENDER_MIB", "0")]).contains("per-sender quota"));
        let c = relay_serve_config(&flags(&[("root", PEM), ("sender-mib", "4")]), env(&[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "0.0.0.0"), ("PORT", "8080"), ("LUCID_RELAY_PORT", "8443"), ("LUCID_RELAY_SENDER_MIB", "32")])).ok().unwrap();
        assert_eq!((c.hostname.as_str(), c.port, c.behind_tls, c.sender_bytes), ("0.0.0.0", 8443, true, Some(4 * 1024 * 1024)));
    }

    #[test]
    fn args_take_relay_serve_and_both_flag_forms() {
        let a: Vec<String> = ["relay", "serve", "--root", "r", "--port=9", "--port", "10"].iter().map(|s| s.to_string()).collect();
        let f = parse_args(&a).ok().unwrap();
        assert_eq!(f.get("port").map(String::as_str), Some("10"));
        assert!(parse_args(&["--nope".to_string(), "x".to_string()]).is_err());
        assert!(parse_args(&["status".to_string()]).is_err());
    }
}
