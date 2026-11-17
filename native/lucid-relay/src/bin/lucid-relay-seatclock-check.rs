// lucid-relay-seatclock-check (contract AC-1 2.4 "No test clock in a deployable build", R3-M10, R4-H1, decision 48):
// the Meeting Hub relay with an accelerated seat-clock day, for the live check L-33 only. Built only with the cargo
// feature `live-check-clock` (with --release or `fips` that feature is a compile_error!, src/meet_time.rs), never
// signed or shipped; the release artifact scan (tests/release_artifact_scan.rs) fails on any shipped binary that
// carries this binary's variable name or marker.
//
//   lucid-relay-seatclock-check --dev-pub <license-dev-pub.pem> --config <relay.json>
//     LUCID_LIVE_CHECK_SEAT_DAY_SECONDS=<1 to 86400>   the length of one seat-clock day
//
// It holds only the development public key (no publisher key), so every publisher-signed license is refused, and it
// runs only on a state folder it created itself (the `live-check-state` marker).
//
// The modules are the relay's own (src/main.rs); this list mirrors main.rs's.

#![allow(dead_code)]

#[path = "../codec.rs"]
mod codec;
#[path = "../collab.rs"]
mod collab;
#[path = "../collab_auth.rs"]
mod collab_auth;
#[path = "../collab_presence.rs"]
mod collab_presence;
#[path = "../console.rs"]
mod console;
#[path = "../console_approvals.rs"]
mod console_approvals;
#[path = "../console_audit.rs"]
mod console_audit;
#[path = "../console_auth.rs"]
mod console_auth;
#[path = "../console_fleet.rs"]
mod console_fleet;
#[path = "../console_limits.rs"]
mod console_limits;
#[path = "../console_mail.rs"]
mod console_mail;
#[path = "../console_mds.rs"]
mod console_mds;
#[path = "../console_meet.rs"]
mod console_meet;
#[path = "../console_password.rs"]
mod console_password;
#[path = "../console_seal.rs"]
mod console_seal;
#[path = "../console_settings.rs"]
mod console_settings;
#[path = "../console_source.rs"]
mod console_source;
#[path = "../console_spokes.rs"]
mod console_spokes;
#[path = "../console_webauthn.rs"]
mod console_webauthn;
#[path = "../console_wizard.rs"]
mod console_wizard;
#[path = "../der.rs"]
mod der;
#[path = "../fleet_agent.rs"]
mod fleet_agent;
#[path = "../fleet_ca.rs"]
mod fleet_ca;
#[path = "../fleet_exec.rs"]
mod fleet_exec;
#[path = "../fleet_export.rs"]
mod fleet_export;
#[path = "../fleet_local.rs"]
mod fleet_local;
#[path = "../fleet_metrics.rs"]
mod fleet_metrics;
#[path = "../fleet_people.rs"]
mod fleet_people;
#[path = "../fleet_port.rs"]
mod fleet_port;
#[path = "../fleet_probe.rs"]
mod fleet_probe;
#[path = "../fleet_syslog.rs"]
mod fleet_syslog;
#[path = "../fleet_trust.rs"]
mod fleet_trust;
#[path = "../fleet_wire.rs"]
mod fleet_wire;
#[path = "../fleet_x509.rs"]
mod fleet_x509;
#[path = "../http_client.rs"]
mod http_client;
#[path = "../identity.rs"]
mod identity;
#[path = "../license.rs"]
mod license;
#[path = "../log.rs"]
mod log;
#[path = "../meet.rs"]
mod meet;
#[path = "../meet_console.rs"]
mod meet_console;
#[path = "../meet_console_identity.rs"]
mod meet_console_identity;
#[path = "../meet_console_port.rs"]
mod meet_console_port;
#[path = "../meet_guest_port.rs"]
mod meet_guest_port;
#[path = "../meet_hub.rs"]
mod meet_hub;
#[path = "../meet_json.rs"]
mod meet_json;
#[path = "../meet_license.rs"]
mod meet_license;
#[path = "../meet_ops.rs"]
mod meet_ops;
#[path = "../meet_org_policy.rs"]
mod meet_org_policy;
#[path = "../meet_routes.rs"]
mod meet_routes;
#[path = "../meet_seats.rs"]
mod meet_seats;
#[path = "../meet_time.rs"]
mod meet_time;
#[path = "../meet_tls.rs"]
mod meet_tls;
#[path = "../meet_x509.rs"]
mod meet_x509;
#[path = "../relay.rs"]
mod relay;
#[path = "../server.rs"]
mod server;
#[path = "../store.rs"]
mod store;

use std::sync::Arc;
use std::time::Instant;

const DAY_VAR: &str = "LUCID_LIVE_CHECK_SEAT_DAY_SECONDS";
const USAGE: &str = "usage: LUCID_LIVE_CHECK_SEAT_DAY_SECONDS=<1 to 86400> lucid-relay-seatclock-check --dev-pub <pem> --config <relay.json>";

/// The live check's clock: the system's wall and monotonic clocks, a seat day of the given length.
struct CheckClock {
    origin: Instant,
    day_ms: i64,
}

impl meet_time::Clock for CheckClock {
    fn wall_ms(&self) -> i64 {
        codec::now_ms()
    }
    fn mono_ms(&self) -> i64 {
        self.origin.elapsed().as_millis() as i64
    }
    fn seat_day_ms(&self) -> i64 {
        self.day_ms
    }
    fn live_check(&self) -> bool {
        true
    }
}

fn die(msg: &str) -> ! {
    eprintln!("lucid-relay-seatclock-check: {msg}");
    std::process::exit(1)
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let seconds: i64 = std::env::var(DAY_VAR).ok().and_then(|v| v.trim().parse().ok()).filter(|s| (1..=86_400).contains(s)).unwrap_or_else(|| die(USAGE));
    let at = args.iter().position(|a| a == "--dev-pub").unwrap_or_else(|| die(USAGE));
    let file = args.get(at + 1).cloned().unwrap_or_else(|| die(USAGE));
    args.drain(at..at + 2);
    let pem = std::fs::read_to_string(&file).unwrap_or_else(|e| die(&format!("cannot read {file}: {e}")));
    license::LicenseKeys::development_only(&pem).unwrap_or_else(|e| die(&e));
    let _ = meet_license::LIVE_CHECK_DEV_PUB.set(pem);
    meet_time::install(Arc::new(CheckClock { origin: Instant::now(), day_ms: seconds * 1000 })).unwrap_or_else(|e| die(&e));
    eprintln!("lucid-relay-seatclock-check: a seat-clock day is {seconds} seconds. Not for production.");
    meet::main(&args);
}
