// lucid-relay (ADR-0540): the remote-spokes relay in Rust, phase A. A drop-in for the add-on's
// `lucid-spoke relay serve`: the same flags and environment (relayServeConfig in src/relay.ts), so a systemd unit or
// a container swaps only the program. `relay serve` in front of the flags is accepted and ignored, so the existing
// ExecStart and ENTRYPOINT arguments work unchanged.
//
//   lucid-relay [relay serve] --root <root.pub> --license <file> [--host 127.0.0.1] [--port 8787]
//               [--tls-cert f --tls-key f] [--state <dir>] [--sender-mib 16]
//     (or LUCID_RELAY_ROOT_PUB, _LICENSE, _HOST, _PORT/PORT, _TLS_CERT, _TLS_KEY, _STATE, _SENDER_MIB, _BEHIND_TLS=1;
//      behind a TLS front LUCID_RELAY_PUBLIC_HOST=<host[:port]> is required: the one host the relay answers for)
//               [--console 1]   the Admin Console at /console/ (or LUCID_RELAY_CONSOLE=1; needs --state; src/console.rs)
//               [--console-sources <cidrs>] [--console-trusted-fronts <cidrs>] [--console-first-admin <email>]
//               [--console-profile standard|high]   (high only for a government deployment; read only until the
//                 console's first admin signs in, AC-1 3.3)
//                 (or LUCID_RELAY_CONSOLE_SOURCES, _TRUSTED_FRONTS, _FIRST_ADMIN, _PROFILE; AC-1 3.1)
//   lucid-relay --owner <spoke node id> ...   a spoke's LAN mailbox: carries mail to and from that spoke only, needs
//               no license; with --state it keeps crl, lan-mailbox-seen.json and lan-mail/ as the spoke agent does.
//   lucid-relay collab [--host=…] [--port=…] …   phase B, the core's collab broker (tools/relay/serve.ts; src/collab.rs).
//   lucid-relay console remove-admin <email> | unsuspend <email> | approve-join <email> [--role admin] |
//               reset --first-admin <email>   [--state <dir>]   with the relay stopped (console.lock): the Admin
//               Console's book, offline (AC-1 3.2).
//   lucid-relay console serve --state <dir> --public <host> [--tls-cert f --tls-key f] [flags of AC-2a 5.2]
//               the Lucid Admin Console as its own service (each flag also LUCID_CONSOLE_<NAME> and console-serve.json).
//   lucid-relay console fleet-ca replace --compromised|--lost | fleet-ca status   [--state <dir>]   (console stopped)
//   lucid-relay console seal-setup [--role relay|console] [--service <name>]   (AC-2a 2.2)
//   lucid-relay ... --with-console <console state dir>   (or LUCID_RELAY_WITH_CONSOLE): the console role in this
//               relay's process (Standard only, AC-2a 2.2).
//   lucid-relay enroll <console URL> [--code-file f | --code-fd n] [--fleet-admin-key <fingerprint>]... [--yes]
//   lucid-relay fleet <command>   [--state <dir>]   the relay's link to a Lucid Admin Console (AC-2a 5.7).
//   lucid-relay deploy script <meet-linux | spokes-linux | meet-docker | spokes-docker>   the embedded install script
//               with an empty header, as a High deployment runs it from release media (AC-2b-D 3.5, 5.1, 9.4).
//   lucid-relay console serve ... [--fleet-serve-dev]   a `dev-license` build hands out its own program too (AC-2b-D
//               4.2; default off).

mod codec;
mod collab;
mod collab_auth;
mod collab_presence;
mod console;
mod console_approvals;
mod console_audit;
mod console_auth;
mod console_fleet;
mod console_limits;
mod console_mail;
mod console_mds;
mod console_meet;
mod console_password;
mod console_seal;
mod console_settings;
mod console_source;
mod console_spokes;
mod console_webauthn;
mod console_wizard;
mod license_reminders;
mod der;
mod deploy_scripts;
mod fleet_agent;
mod fleet_ca;
mod fleet_exec;
mod fleet_export;
mod fleet_local;
mod fleet_metrics;
mod fleet_people;
mod fleet_port;
mod fleet_probe;
mod fleet_syslog;
mod fleet_trust;
mod fleet_wire;
mod fleet_x509;
mod http_client;
mod identity;
mod license;
mod log;
mod meet;
mod meet_ca;
mod meet_console;
mod meet_console_identity;
mod meet_console_port;
mod meet_guest_port;
mod meet_hub;
mod meet_json;
mod meet_license;
mod meet_ops;
mod meet_seats;
mod meet_time;
mod meet_org_policy;
mod meet_routes;
mod meet_tls;
mod meet_x509;
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

const FLAGS: [&str; 15] = ["root", "host", "port", "tls-cert", "tls-key", "state", "license", "sender-mib", "owner", "console", "console-sources", "console-trusted-fronts", "console-first-admin", "console-profile", "with-console"];

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
    /// LUCID_RELAY_PUBLIC_HOST: behind a TLS front, the one host this relay answers for.
    public_host: Option<String>,
    license: Option<String>,
    /// The license's file when --license (or LUCID_RELAY_LICENSE) names one rather than giving the armored text.
    license_file: Option<std::path::PathBuf>,
    sender_bytes: Option<i64>,
    owner: Option<String>,
}

/// relay.ts relayServeConfig: flags first, then environment; an empty value is unset.
fn relay_serve_config(flags: &HashMap<String, String>, env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    let get = |flag: &str, vars: &[&str]| -> Option<String> {
        let f = flags.get(flag).filter(|v| !v.is_empty()).cloned();
        f.or_else(|| vars.iter().find_map(|k| env(k).filter(|v| !v.is_empty())))
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
    // Behind a front the relay has no certificate naming it: the public host is the only Host it answers, the
    // audience requests are signed for, and the control panel's origin.
    let public_host = env("LUCID_RELAY_PUBLIC_HOST").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    match (&public_host, behind == "1") {
        (None, true) => return Err("behind a TLS front set LUCID_RELAY_PUBLIC_HOST to the host name callers dial (relay.example.com, or relay.example.com:8443)".into()),
        (Some(_), false) => return Err("LUCID_RELAY_PUBLIC_HOST is for a relay behind a TLS front (LUCID_RELAY_BEHIND_TLS=1); with its own certificate the relay answers for the names on it".into()),
        (Some(p), true) if !public_host_ok(p) => return Err(format!("LUCID_RELAY_PUBLIC_HOST {p} is not a host name with an optional port (no scheme, path or spaces)")),
        _ => {}
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
            return Err("a LAN mailbox (--owner) carries no license: leave out --license and LUCID_RELAY_LICENSE".into());
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
        public_host,
        license_file: license.as_ref().filter(|l| !js_trim_start(l).starts_with("-----BEGIN")).map(std::path::PathBuf::from),
        license: license.map(|l| pem_or_file(&l).map(|text| license_token_of(&text))).transpose()?,
        sender_bytes: sender_text.map(|_| sender_mib as i64 * 1024 * 1024),
        owner,
    })
}

/// LUCID_RELAY_PUBLIC_HOST: a DNS name (letters, digits, hyphens, dots), with an optional port 1 to 65535.
fn public_host_ok(p: &str) -> bool {
    let (name, port) = match p.split_once(':') {
        Some((n, port)) => (n, Some(port)),
        None => (p, None),
    };
    let name_ok = !name.is_empty() && name.split('.').all(|l| !l.is_empty() && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
    name_ok && port.is_none_or(|n| n.parse::<u16>().is_ok_and(|n| n > 0))
}

/// The owner root public key from its PEM (createPublicKey, then TrustStore's P-256 check).
fn root_key(pem: &str) -> Result<der::P256Key, String> {
    let der = der::pem_blocks(pem, "PUBLIC KEY").into_iter().next().ok_or("the owner root public key is not a PUBLIC KEY PEM")?;
    der::p256_from_spki(&der).ok_or_else(|| "root key must be ECDSA P-256".into())
}

/// `lucid-relay console <command> [--state <dir>]` (or LUCID_RELAY_STATE), with the relay stopped (console.lock):
/// `remove-admin <email>`, `unsuspend <email>`, `approve-join <email> [--role admin]`, `reset --first-admin <email>`
/// (which asks for the relay's host name), `break-glass --email <email> [--replace]` (prints the one-time setup link),
/// `two-person off`, and `seal-setup [--service <name>]` (AC-1 3.11, R4-H2, R4-M2). Each but seal-setup is audited
/// at the relay's next start (AC-1 3.2 "Offline").
fn console_cli(args: &[String]) -> ! {
    const USAGE: &str = "usage: lucid-relay console remove-admin <email> | unsuspend <email> | approve-join <email> [--role admin] | reset --first-admin <email> | break-glass --email <email> [--replace] | two-person off | seal-setup [--role relay|console] [--service <name>] | fleet-ca replace --compromised|--lost | fleet-ca status  [--state <dir>] (or LUCID_RELAY_STATE), with the relay or console stopped; or lucid-relay console serve --state <dir> --public <host> ...";
    // AC-2a 5.2: the console role.
    if args.first().map(String::as_str) == Some("serve") {
        console_serve(&args[1..]);
    }
    let mut state = std::env::var("LUCID_RELAY_STATE").ok();
    let mut role = None;
    let mut first_admin = None;
    let mut email = None;
    let mut service = None;
    let mut replace = false;
    let mut ca_why: Option<&'static str> = None;
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        let mut value = |name: &str| -> Option<String> {
            if let Some(v) = a.strip_prefix(&format!("--{name}=")) {
                return Some(v.to_owned());
            }
            (*a == format!("--{name}")).then(|| {
                i += 1;
                args.get(i - 1).cloned().unwrap_or_else(|| die(USAGE))
            })
        };
        if let Some(v) = value("state") {
            state = Some(v);
        } else if let Some(v) = value("role") {
            role = Some(v);
        } else if let Some(v) = value("first-admin") {
            first_admin = Some(v);
        } else if let Some(v) = value("email") {
            email = Some(v);
        } else if let Some(v) = value("service") {
            service = Some(v);
        } else if a == "--replace" {
            replace = true;
        } else if a == "--compromised" {
            ca_why = Some("compromised");
        } else if a == "--lost" {
            ca_why = Some("lost");
        } else {
            rest.push(a.as_str());
        }
    }
    let dir = state.filter(|d| !d.is_empty()).unwrap_or_else(|| die("the Admin Console keeps its people in the state folder: give --state or LUCID_RELAY_STATE"));
    if rest.as_slice() == ["seal-setup"] {
        // AC-2a 2.2: `--role relay` (the default, AC-1) or `--role console`.
        let id = match role.as_deref() {
            None => console_seal::SealIdentity::Relay,
            Some(r) => console_seal::SealIdentity::parse(r).unwrap_or_else(|| die("seal-setup --role is relay or console")),
        };
        match console_seal::seal_setup(Path::new(&dir), service.as_deref().unwrap_or(console_seal::default_service(id)), id) {
            Ok(done) => {
                println!("lucid-relay: {done}");
                std::process::exit(0)
            }
            Err(e) => die(&e),
        }
    }
    // AC-2a 3.11, 3.12, 5.2: the management CA, with the console stopped (console.lock).
    match rest.as_slice() {
        ["fleet-ca", "replace"] => {
            let why = ca_why.unwrap_or_else(|| die("fleet-ca replace needs --compromised or --lost"));
            let _lock = console_auth::lock_state(Path::new(&dir)).unwrap_or_else(|e| die(&e));
            let high = console_auth::Book::read(&Path::new(&dir).join(console::CONSOLE_FILE), codec::now_ms()).map(|b| b.settings.high()).unwrap_or_else(|e| die(&e));
            let t = codec::now_ms();
            match fleet_ca::replace_offline(Path::new(&dir), why, high, t) {
                Ok(done) => {
                    // 3.12: audited at the console's next start (`fleet.ca.replace`, actor `operator`).
                    let file = Path::new(&dir).join(console::CONSOLE_FILE);
                    if let Ok(mut book) = console_auth::Book::read(&file, t) {
                        book.pending_audit.push(serde_json::json!({ "ts": t, "actor": "operator", "action": "fleet.ca.replace", "target": "-", "detail": { "why": why } }));
                        if let Err(e) = book.save(&file) {
                            eprintln!("lucid-relay: the audit note could not be saved: {e}");
                        }
                    }
                    println!("lucid-relay: {done}");
                    std::process::exit(0)
                }
                Err(e) => die(&e),
            }
        }
        ["fleet-ca", "status"] => match fleet_ca::status_offline(Path::new(&dir)) {
            Ok(done) => {
                println!("{done}");
                std::process::exit(0)
            }
            Err(e) => die(&e),
        },
        _ => {}
    }
    let admin = match role.as_deref() {
        None | Some("viewer") => false,
        Some("admin") => true,
        Some(_) => die(USAGE),
    };
    let cmd = match rest.as_slice() {
        ["remove-admin", email] => console_auth::Offline::RemoveAdmin((*email).to_owned()),
        ["unsuspend", email] => console_auth::Offline::Unsuspend((*email).to_owned()),
        ["approve-join", email] => console_auth::Offline::ApproveJoin { email: (*email).to_owned(), admin },
        ["reset"] => {
            let first_admin = first_admin.unwrap_or_else(|| die("reset needs --first-admin <email>: the person who signs in first"));
            let host = console_auth::book_host(Path::new(&dir)).unwrap_or_default();
            eprint!("lucid-relay: this clears every person, passkey, invite and approval of the Admin Console. Type the relay's host name ({}) to go on: ", if host.is_empty() { "none recorded: press Enter" } else { host.as_str() });
            let mut typed = String::new();
            let _ = std::io::stdin().read_line(&mut typed);
            console_auth::Offline::Reset { first_admin, typed_host: typed.trim().to_owned() }
        }
        ["break-glass"] => {
            let email = email.unwrap_or_else(|| die("break-glass needs --email <email>: the break-glass account's own address"));
            console_auth::Offline::BreakGlass { email, replace, origin: serve_origin(Path::new(&dir)) }
        }
        ["two-person", "off"] => console_auth::Offline::TwoPersonOff,
        _ => die(USAGE),
    };
    let host = console_auth::book_host(Path::new(&dir)).unwrap_or_default();
    match console_auth::run_offline(Path::new(&dir), cmd, &host, &|_, _| Ok(())) {
        Ok(done) => {
            println!("lucid-relay: {done}");
            std::process::exit(0)
        }
        Err(e) => die(&e),
    }
}

/// A fleet console's browser origin from the `console-serve.json` its last start wrote (AC-2a 5.2): `public`, with
/// `port` unless 443. None for a relay's own console, whose book records its origin (AC-1 3.2).
fn serve_origin(dir: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("console-serve.json")).ok()?).ok()?;
    let public = v.get("public").and_then(serde_json::Value::as_str).filter(|p| !p.is_empty())?;
    let port = v.get("port").and_then(serde_json::Value::as_str).unwrap_or("443");
    Some(if public.contains(':') || port == "443" { format!("https://{public}") } else { format!("https://{public}:{port}") })
}

/// `lucid-relay license-time reset --state <dir>` (R7-M1, 8.1 `cli.license-time-reset`): with the relay stopped
/// (console.lock), after the operator types the relay's host name, the license clock is set to this host's clock
/// (decision 67: it may give back grace a rollback took; only the host's operator can run it). Audited `license.time-reset` at the next start.
/// A state folder holding `meet-time.json` is a Meeting Hub relay's: its trusted time's `highWater` is reset
/// (`meet_time::reset_offline`, every other key kept); otherwise the Remote Spokes license clock.
fn license_time_cli(args: &[String]) -> ! {
    const USAGE: &str = "usage: lucid-relay license-time reset --state <dir> (or LUCID_RELAY_STATE), with the relay stopped";
    let (cmd, rest) = args.split_first().unwrap_or_else(|| die(USAGE));
    if cmd != "reset" {
        die(USAGE);
    }
    let flags = parse_named(rest, &["state"]).unwrap_or_else(|e| die(&format!("{e}; {USAGE}")));
    let dir = flags.get("state").cloned().or_else(|| std::env::var("LUCID_RELAY_STATE").ok()).filter(|d| !d.is_empty()).unwrap_or_else(|| die(USAGE));
    let dir = Path::new(&dir);
    let _lock = console_auth::lock_state(dir).unwrap_or_else(|e| die(&e));
    let meet = dir.join(meet_time::TIME_FILE).exists();
    // Remote Spokes: the license clock; Meeting Hub: the stored trusted time (fail closed when it does not read back)
    let mut clock = if meet { None } else { Some(console_spokes::LicenseClock::open(Some(dir)).unwrap_or_else(|e| die(&e))) };
    let high_water = match &clock {
        Some(c) => c.high_water(),
        None => meet_time::stored_high_water(dir).unwrap_or_else(|e| die(&e)),
    };
    let wall = codec::now_ms();
    let host = console_auth::book_host(dir).unwrap_or_default();
    let when = license_reminders::when;
    eprint!(
        "lucid-relay: The license clock reads {}; this host's clock reads {}. Type this host's name to set the license clock to the host's clock.\nHost name ({}): ",
        when(high_water),
        when(wall),
        if host.is_empty() { "none recorded: press Enter" } else { host.as_str() }
    );
    let mut typed = String::new();
    let _ = std::io::stdin().read_line(&mut typed);
    if !typed.trim().eq_ignore_ascii_case(&host) {
        die("the host name did not match; nothing was changed");
    }
    let done = match clock.as_mut() {
        Some(c) => c.reset_to(wall),
        None => meet_time::reset_offline(dir, wall),
    };
    match done {
        Ok((_, after)) => {
            println!("lucid-relay: License clock set to {}.", when(after));
            std::process::exit(0)
        }
        Err(e) => die(&e),
    }
}

/// `--name value` and `--name=value` of `names`, the last one winning; nothing else is taken.
fn parse_named(args: &[String], names: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut flags = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        let Some(name) = a.strip_prefix("--") else { return Err(format!("unexpected argument '{a}'")) };
        let (name, value) = match name.split_once('=') {
            Some((n, v)) => (n, v.to_owned()),
            None => {
                let v = args.get(i).ok_or_else(|| format!("option '--{name} <value>' argument missing"))?;
                i += 1;
                (name, v.clone())
            }
        };
        if !names.contains(&name) {
            return Err(format!("unknown option '--{name}'"));
        }
        flags.insert(name.to_owned(), value);
    }
    Ok(flags)
}

/// Whether the console book in `dir` is (or will start) in the High profile: the profile it holds, or `given`
/// while it is not bootstrapped (R41-3).
fn book_high(dir: &Path, given: Option<console_settings::Profile>) -> bool {
    match console_auth::Book::read(&dir.join(console::CONSOLE_FILE), codec::now_ms()) {
        Ok(b) if b.bootstrapped => b.settings.high(),
        Ok(b) => given.map_or(b.settings.high(), |p| p == console_settings::Profile::High),
        // An unreadable book: the stricter reading.
        Err(_) => true,
    }
}

/// AC-2b-D 4.2: `--fleet-serve-dev` alone is `--fleet-serve-dev=1` (every other `console serve` flag takes a value).
fn serve_dev_flag(args: &[String]) -> Vec<String> {
    args.iter().map(|a| if a == "--fleet-serve-dev" { "--fleet-serve-dev=1".to_owned() } else { a.clone() }).collect()
}

const DEPLOY_USAGE: &str = "usage: lucid-relay deploy script <meet-linux | spokes-linux | meet-docker | spokes-docker>";

/// `lucid-relay deploy script <name>` (AC-2b-D 9.4): the embedded script body after the 10 header lines with empty
/// values (5.1), the same bytes the console serves after its header.
fn deploy_script_text(args: &[String]) -> Result<String, &'static str> {
    match args {
        [cmd, name] if cmd == "script" => {
            let bare = name.strip_suffix(".sh").unwrap_or(name);
            if !deploy_scripts::NAMES.contains(&bare) {
                return Err(DEPLOY_USAGE);
            }
            let body = deploy_scripts::by_name(bare).ok_or(DEPLOY_USAGE)?;
            Ok(format!("{}{body}", deploy_scripts::empty_header()))
        }
        _ => Err(DEPLOY_USAGE),
    }
}

fn deploy_cli(args: &[String]) -> ! {
    use std::io::Write;
    let text = deploy_script_text(args).unwrap_or_else(|e| die(e));
    let mut out = std::io::stdout().lock();
    if out.write_all(text.as_bytes()).and_then(|_| out.flush()).is_err() {
        std::process::exit(1);
    }
    std::process::exit(0)
}

/// `lucid-relay console serve` (AC-2a 5.2): the Lucid Admin Console as its own service, holding `console.lock`.
fn console_serve(args: &[String]) -> ! {
    let flags = parse_named(&serve_dev_flag(args), &console_fleet::SERVE_FLAGS).unwrap_or_else(|e| die(&e));
    let cfg = console_fleet::serve_config(&flags, |k| std::env::var(k).ok()).unwrap_or_else(|e| die(&e));
    // 2.2 start checks under High: the console's own identity and a state folder open to it and administrators only.
    if book_high(&cfg.state, cfg.profile) {
        console_seal::check_console_identity().unwrap_or_else(|e| die(&e));
        console_seal::check_state_acl(&cfg.state, console_seal::SealIdentity::Console).unwrap_or_else(|e| die(&e));
    }
    console_fleet::write_serve_file(&cfg).unwrap_or_else(|e| die(&e));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| die(&e.to_string()));
    runtime.block_on(async move {
        let (logger, console) = console::open_fleet(cfg.clone(), Logger::new("console"), console_seal::SealIdentity::Console).unwrap_or_else(|e| die(&e));
        if console.profile_high() {
            fleet_people::make_non_dumpable().unwrap_or_else(|e| die(&e));
        }
        console_fleet::serve_browser(console.clone(), &cfg).unwrap_or_else(|e| die(&e));
        let port = fleet_port::PortConfig { host: cfg.fleet.fleet_host.clone(), port: cfg.fleet.fleet_port, names: cfg.fleet.fleet_names.clone(), sources: cfg.fleet_sources.clone(), public_host: cfg.public.clone(), serve_dev: cfg.fleet.serve_dev };
        fleet_port::start(console.clone(), port, logger.clone()).unwrap_or_else(|e| die(&e));
        let signal = stop_signal().await;
        logger.ops("stopping", &Fields::new().with("signal", signal), Level::Info);
        drop(console);
        std::process::exit(0);
    });
    std::process::exit(0);
}

/// The relay's state folder for the AC-2a commands: `--state <dir>` (or LUCID_RELAY_STATE), and the other arguments.
fn state_and_rest(args: &[String]) -> (String, Vec<String>) {
    let mut state = std::env::var("LUCID_RELAY_STATE").ok();
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if let Some(v) = a.strip_prefix("--state=") {
            state = Some(v.to_owned());
        } else if a == "--state" {
            state = Some(args.get(i).cloned().unwrap_or_else(|| die("option '--state <value>' argument missing")));
            i += 1;
        } else {
            rest.push(a.clone());
        }
    }
    let dir = state.filter(|d| !d.is_empty()).unwrap_or_else(|| die("Joining a console needs the relay's state folder (--state)."));
    (dir, rest)
}

/// `lucid-relay enroll <console URL> ...` (AC-2a 5.7, Remote Spokes): refused while the relay runs (`fleet.lock`).
fn enroll_cli(args: &[String]) -> ! {
    let (dir, rest) = state_and_rest(args);
    let _lock = server::fleet_lock(Path::new(&dir)).unwrap_or_else(|e| die(&e));
    match fleet_agent::enroll_cli(license::Product::Spokes, Path::new(&dir), &rest) {
        Ok(done) => {
            println!("lucid-relay: {done}");
            std::process::exit(0)
        }
        Err(e) => die(&e),
    }
}

/// `lucid-relay fleet <command>` (AC-2a 5.7, Remote Spokes): f-trust's commands, which take `fleet.lock` where needed.
fn fleet_cli(args: &[String]) -> ! {
    let (dir, rest) = state_and_rest(args);
    // AC-2b-D 9.4: only the relay's management fingerprint once enrolled, else nothing; exit 0 either way, also while
    // the relay runs.
    if rest.len() == 2 && rest[0] == "status" && rest[1] == "--fingerprint" {
        if let Some(fp) = fleet_agent::status_fingerprint(Path::new(&dir)) {
            println!("{fp}");
        }
        std::process::exit(0);
    }
    let stdin = std::io::stdin();
    let code = fleet_local::cli(license::Product::Spokes, Path::new(&dir), &rest, &mut stdin.lock(), &mut std::io::stdout());
    std::process::exit(code)
}

/// 2.2: `--with-console` together with `--console 1` is one process running two consoles (13.4
/// `cli.with-console-both`).
fn with_console_conflict(with_console: bool, console_on: bool) -> Result<(), String> {
    if with_console && console_on {
        return Err(server::CLI_WITH_CONSOLE_BOTH.into());
    }
    Ok(())
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
    // A `fips` build serves nothing (relay, collab or meet) unless AWS-LC is in FIPS mode.
    server::fips_check().unwrap_or_else(|e| die(&e));
    // Phase B: the collab broker (tools/relay/serve.ts). Everything else is `relay serve` (phase A).
    if args.first().map(String::as_str) == Some("collab") {
        collab::main(&args[1..]);
    }
    // Phase C: the Meeting Hub rendezvous relay (relay/meet_relay.py; src/meet.rs).
    if args.first().map(String::as_str) == Some("meet") {
        meet::main(&args[1..]);
    }
    // The Admin Console's book, offline (console.lock refuses while a relay runs).
    if args.first().map(String::as_str) == Some("console") {
        console_cli(&args[1..]);
    }
    // AC-2a 5.7: the relay's link to a Lucid Admin Console (Meeting Hub: `meet enroll` and `meet fleet`, meet.rs).
    if args.first().map(String::as_str) == Some("enroll") {
        enroll_cli(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("fleet") {
        fleet_cli(&args[1..]);
    }
    // AC-2b-D 9.4: the embedded install script with an empty header (release media, offline uninstall).
    if args.first().map(String::as_str) == Some("deploy") {
        deploy_cli(&args[1..]);
    }
    // AC-1 2.4 "The license clock" (R7-M1): the offline recovery from a false forward jump (Remote Spokes).
    if args.first().map(String::as_str) == Some("license-time") {
        license_time_cli(&args[1..]);
    }
    let flags = parse_args(&args).unwrap_or_else(|e| die(&e));
    // AC-2b-D 6.4: the profile lock first, then a waiting handoff applied before the relay reads its TLS files, root
    // or license (exit 78 on `cli.profile-locked` or `cli.deploy-no-root`).
    let raw = |flag: &str, var: &str| flags.get(flag).filter(|v| !v.is_empty()).cloned().or_else(|| std::env::var(var).ok().filter(|v| !v.is_empty()));
    let (start_state, start_profile, start_root, start_license) = (raw("state", "LUCID_RELAY_STATE"), raw("console-profile", "LUCID_RELAY_CONSOLE_PROFILE"), raw("root", "LUCID_RELAY_ROOT_PUB"), raw("license", "LUCID_RELAY_LICENSE"));
    let locked = server::spokes_start(server::SpokesStart {
        state_dir: start_state.as_deref().map(Path::new),
        profile: start_profile.as_deref(),
        root: start_root.as_deref(),
        license: start_license.as_deref(),
        logger: Arc::new(Logger::new("relay")),
        lock_path: Path::new(server::SPOKES_PROFILE_LOCK),
    })
    .unwrap_or_else(|r| r.exit());
    let c = relay_serve_config(&flags, |k| std::env::var(k).ok()).unwrap_or_else(|e| die(&e));
    // AC-2a 2.2: the console role in this process, refused next to the relay's own console and under High.
    let with_console = flags.get("with-console").filter(|v| !v.is_empty()).cloned().or_else(|| std::env::var("LUCID_RELAY_WITH_CONSOLE").ok().filter(|v| !v.is_empty()));
    let console_on = flags.get("console").cloned().or_else(|| std::env::var("LUCID_RELAY_CONSOLE").ok()).as_deref() == Some("1");
    with_console_conflict(with_console.is_some(), console_on).unwrap_or_else(|e| die(&e));
    if with_console.is_some() && (c.owner.is_some() || c.state.is_none()) {
        die("--with-console needs the relay's state folder (--state) and is not for a LAN mailbox");
    }
    let given_profile = flags.get("console-profile").cloned().or_else(|| std::env::var("LUCID_RELAY_CONSOLE_PROFILE").ok()).and_then(|p| console_settings::Profile::parse(&p));
    let relay_high = c.state.as_deref().is_some_and(|d| Path::new(d).join(console::CONSOLE_FILE).exists() && book_high(Path::new(d), given_profile)) || given_profile == Some(console_settings::Profile::High) || locked;
    server::high_start_checks(c.state.as_deref().map(Path::new), relay_high, with_console.is_some()).unwrap_or_else(|e| die(&e));
    // A shared relay serves people only under the org's relay license; a spoke's LAN mailbox needs none. With no
    // --license it reads `<state>/license.lic` and, with none there either, starts stopped (R42-1) so an admin can
    // install one in its console; with no state folder there is nowhere to install one.
    let mut c = c;
    if c.owner.is_none() && c.license.is_none() {
        let Some(dir) = c.state.as_deref() else {
            die("the relay license is required (--license or LUCID_RELAY_LICENSE: the license file or its armored text), or a state folder (--state) to install one into");
        };
        let file = Path::new(dir).join(relay::DEFAULT_LICENSE_FILE);
        if file.exists() {
            c.license = Some(license_token_of(&std::fs::read_to_string(&file).unwrap_or_else(|e| die(&format!("{}: {e}", file.display())))));
        }
        c.license_file = Some(file);
    }
    // The Admin Console (src/console.rs): --console 1 or LUCID_RELAY_CONSOLE=1; when on, the logger feeds its ring and
    // the relay holds console.lock in its state folder for its whole life.
    let base = Logger::new(if c.owner.is_some() { "lan-mailbox" } else { "relay" });
    let console_flags = console::SpokesFlags {
        console: flags.get("console"),
        sources: flags.get("console-sources"),
        trusted_fronts: flags.get("console-trusted-fronts"),
        first_admin: flags.get("console-first-admin"),
        profile: flags.get("console-profile"),
    };
    let console_host = c.public_host.as_deref().map(|p| server::dialed_of(p, true).hostname).unwrap_or_else(|| c.hostname.clone());
    let (logger, console) = console::open(console_flags, |k| std::env::var(k).ok(), c.state.as_deref(), c.owner.is_some(), c.behind_tls, &console_host, base).unwrap_or_else(|e| die(&e));
    let console_handle = console.clone();
    // A `dev-license` build says so at every start (R4-H1, 8.1 `cli.dev-license`); None in every other build.
    if let Some(notice) = license::dev_license_notice() {
        logger.ops("relay.dev-license", &Fields::new().with("why", notice), Level::Warn);
    }
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
        state_dir: state.map(Path::to_path_buf),
        license_file: c.license_file.clone(),
    };
    if c.behind_tls {
        let f = Fields::new().with("why", "a platform front terminates TLS (LUCID_RELAY_BEHIND_TLS=1)").with("publicHost", c.public_host.clone());
        logger.ops("plain-http", &f, Level::Info);
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
        let public = c.public_host.as_deref().map(|p| server::dialed_of(p, true));
        let relay = Arc::new(server::Relay { state: Arc::new(Mutex::new(st)), logger: logger.clone(), hosts: HostCheck { names, port, public }, tls: c.tls.is_some() });
        // The console's Remote Spokes section (I9) reads the relay's state, held weakly.
        if let Some(console) = &console_handle {
            console.attach(console_spokes::section(Arc::downgrade(&relay.state)));
        }
        // AC-2a 2.2: the console role in this process first (its same-process enrollment writes the relay's link),
        // then the relay's own link (fleet.lock, the headless console and the agent, F7). Kept for the process's life.
        if let Some(dir) = &with_console {
            let mut hosts = vec![c.hostname.clone()];
            hosts.extend(c.public_host.clone());
            console_fleet::start_with_console(Path::new(dir), license::Product::Spokes, &hosts, c.state.as_deref().map(Path::new), logger.clone()).unwrap_or_else(|e| die(&e));
        }
        let _fleet_link = server::fleet_start(server::FleetStart { state_dir: c.state.as_deref().map(std::path::PathBuf::from), console: console_handle.clone(), relay: relay.clone(), logger: logger.clone() }).unwrap_or_else(|e| die(&e));
        let shown = if c.hostname.contains(':') { format!("[{}]", c.hostname) } else { c.hostname.clone() };
        let url = format!("{}://{shown}:{port}/", if c.tls.is_some() { "https" } else { "http" });
        logger.ops("listening", &Fields::new().with("url", url).with("licensed", licensed).with("store", has_store).with("owner", c.owner.clone()), Level::Info);
        if licensed {
            // An idle relay must still write its daily license lines, which an operator's alert is raised from.
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
        tokio::spawn(server::run(listener, relay, acceptor, server::CONN_LIMITS));
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
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "0.0.0.0"), ("PORT", "70000"), ("LUCID_RELAY_PUBLIC_HOST", "relay.example.com")]).contains("not 1 to 65535"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_TLS_CERT", PEM)]).contains("both the TLS certificate and its key"));
        assert!(err(&[("root", PEM)], &[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "127.0.0.1"), ("PORT", "8080"), ("LUCID_RELAY_PUBLIC_HOST", "relay.example.com"), ("LUCID_RELAY_SENDER_MIB", "0")]).contains("per-sender quota"));
        let c = relay_serve_config(&flags(&[("root", PEM), ("sender-mib", "4")]), env(&[("LUCID_RELAY_BEHIND_TLS", "1"), ("LUCID_RELAY_HOST", "0.0.0.0"), ("PORT", "8080"), ("LUCID_RELAY_PORT", "8443"), ("LUCID_RELAY_PUBLIC_HOST", "relay.example.com"), ("LUCID_RELAY_SENDER_MIB", "32")])).ok().unwrap();
        assert_eq!((c.hostname.as_str(), c.port, c.behind_tls, c.sender_bytes), ("0.0.0.0", 8443, true, Some(4 * 1024 * 1024)));
        assert_eq!(c.public_host.as_deref(), Some("relay.example.com"));
    }

    #[test]
    fn behind_a_tls_front_the_public_host_is_required() {
        // Behind a front, with `public` as LUCID_RELAY_PUBLIC_HOST (None: unset): the error, or "" when it starts.
        let behind = |public: Option<&str>| {
            let public = public.map(str::to_owned);
            let vars = move |k: &str| match k {
                "LUCID_RELAY_BEHIND_TLS" => Some("1".to_owned()),
                "LUCID_RELAY_HOST" => Some("0.0.0.0".to_owned()),
                "PORT" => Some("8080".to_owned()),
                "LUCID_RELAY_PUBLIC_HOST" => public.clone(),
                _ => None,
            };
            relay_serve_config(&flags(&[("root", PEM)]), vars).err().unwrap_or_default()
        };
        assert!(behind(None).contains("set LUCID_RELAY_PUBLIC_HOST"));
        assert_eq!(behind(Some("relay.example.com:8443")), "");
        for bad in ["https://relay.example.com", "relay.example.com/x", "relay..example.com", "relay.example.com:0", "relay.example.com:x", "relay example.com"] {
            assert!(behind(Some(bad)).contains("is not a host name"), "{bad}");
        }
        let own_tls = relay_serve_config(&flags(&[("root", PEM)]), env(&[("LUCID_RELAY_TLS_CERT", PEM), ("LUCID_RELAY_TLS_KEY", PEM), ("LUCID_RELAY_PUBLIC_HOST", "relay.example.com")]));
        assert!(own_tls.err().unwrap_or_default().contains("is for a relay behind a TLS front"));
        assert!(public_host_ok("relay.example.com") && public_host_ok("localhost"));
    }

    #[test]
    fn args_take_relay_serve_and_both_flag_forms() {
        let a: Vec<String> = ["relay", "serve", "--root", "r", "--port=9", "--port", "10"].iter().map(|s| s.to_string()).collect();
        let f = parse_args(&a).ok().unwrap();
        assert_eq!(f.get("port").map(String::as_str), Some("10"));
        assert!(parse_args(&["--nope".to_string(), "x".to_string()]).is_err());
        assert!(parse_args(&["status".to_string()]).is_err());
    }

    /// AC-2a 2.2, 16.1 f-console: `--with-console` together with `--console 1` is refused with 13.4
    /// `cli.with-console-both`; under High `--with-console` is refused with `cli.with-console-high`.
    #[test]
    fn with_console_is_refused_next_to_a_relay_console_and_under_high() {
        assert_eq!(with_console_conflict(true, true).unwrap_err(), server::CLI_WITH_CONSOLE_BOTH);
        assert!(with_console_conflict(true, false).is_ok());
        assert!(with_console_conflict(false, true).is_ok());
        let a: Vec<String> = ["--with-console", "/srv/console", "--root", "r"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_args(&a).unwrap().get("with-console").map(String::as_str), Some("/srv/console"));
        assert_eq!(server::high_start_checks(None, true, true).unwrap_err(), server::CLI_WITH_CONSOLE_HIGH);
        assert!(server::high_start_checks(None, false, true).is_ok());
    }

    #[test]
    fn named_flags_take_only_their_names() {
        let a: Vec<String> = ["--state", "/x", "--public=console.example.org"].iter().map(|s| s.to_string()).collect();
        let f = parse_named(&a, &console_fleet::SERVE_FLAGS).unwrap();
        assert_eq!((f["state"].as_str(), f["public"].as_str()), ("/x", "console.example.org"));
        assert!(parse_named(&["--code".to_string(), "x".to_string()], &console_fleet::SERVE_FLAGS).is_err(), "no code on a command line (A1-M1)");
        assert!(parse_named(&["stray".to_string()], &console_fleet::SERVE_FLAGS).is_err());
    }

    /// AC-2b-D 4.2: `--fleet-serve-dev` alone turns it on; `=0` keeps it off; default off.
    #[test]
    fn fleet_serve_dev_is_a_switch_that_defaults_off() {
        let a: Vec<String> = ["--state", "/x", "--fleet-serve-dev", "--public", "console.example.org"].iter().map(|s| s.to_string()).collect();
        let f = parse_named(&serve_dev_flag(&a), &console_fleet::SERVE_FLAGS).unwrap();
        assert_eq!((f["fleet-serve-dev"].as_str(), f["public"].as_str()), ("1", "console.example.org"));
        let off: Vec<String> = ["--fleet-serve-dev=0"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_named(&serve_dev_flag(&off), &console_fleet::SERVE_FLAGS).unwrap()["fleet-serve-dev"], "0");
        assert!(parse_named(&serve_dev_flag(&[]), &console_fleet::SERVE_FLAGS).unwrap().get("fleet-serve-dev").is_none());
    }

    /// AC-2b-D 9.4, 5.1, D11: `deploy script <name>` prints the 10 empty header lines, then the body that ends with
    /// `{ main "$@"; exit $?; }`; other names are refused.
    #[test]
    fn deploy_script_prints_the_empty_header_and_the_body() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        for name in deploy_scripts::NAMES {
            let text = deploy_script_text(&args(&["script", name])).unwrap();
            let header = deploy_scripts::empty_header();
            assert_eq!(header.lines().count(), deploy_scripts::HEADER_LINES, "{name}");
            assert!(text.starts_with(&header), "{name}");
            assert_eq!(&text[header.len()..], deploy_scripts::by_name(name).unwrap(), "{name}");
            assert_eq!(text.trim_end().lines().last(), Some("{ main \"$@\"; exit $?; }"), "{name}");
            assert!(text.contains("LUCID_ENROLLMENT=''"), "{name}: the header's values are empty");
            assert_eq!(deploy_script_text(&args(&["script", &format!("{name}.sh")])).unwrap(), text);
        }
        for bad in [&["script"][..], &["script", "windows"], &["script", "../meet-linux"], &["print", "meet-linux"], &[]] {
            assert_eq!(deploy_script_text(&args(bad)).unwrap_err(), DEPLOY_USAGE);
        }
    }

    #[test]
    fn the_high_book_check_follows_the_book_after_bootstrap() {
        let d = std::env::temp_dir().join(format!("lucid-main-book-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        // No book yet: the flag decides; an unreadable book is High (the stricter reading).
        assert!(book_high(&d, Some(console_settings::Profile::High)));
        assert!(!book_high(&d, None));
        std::fs::write(d.join(console::CONSOLE_FILE), "not json").unwrap();
        assert!(book_high(&d, None));
        let mut b = console_auth::Book { bootstrapped: true, ..console_auth::Book::default() };
        b.settings.profile = console_settings::Profile::High;
        b.save(&d.join(console::CONSOLE_FILE)).unwrap();
        assert!(book_high(&d, Some(console_settings::Profile::Standard)), "after bootstrap the flag is ignored");
    }
}
