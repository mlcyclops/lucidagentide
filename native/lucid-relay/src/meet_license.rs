// The Meeting Hub relay's service gate (contract AC-1 2.4, 4.10; R42-1, R42-2 and R42-4 replacing revision 4.1's
// growth gate; R3-M4, decisions 39, 62, 63 and 65; I13).
//
// - The license: relay.json `license` (a path), else `state_dir/license.lic`, re-read at every check so installing
//   a fitting license turns service on at once and removing the file stops it at the next check. A malformed or
//   wrong-root file is logged (`license.refused`) and the relay runs unlicensed.
// - No valid license, no service: the service state is `on` (a fitting license before `exp`), `grace` (after `exp`,
//   before `exp` plus min(graceDays, 2) days), `upgrade-period` (no fitting license during the 2-day upgrade period)
//   or `stopped`. While stopped every `service` route of the gate table (main and guest port) refuses with 403
//   `license-inactive`; `exempt` routes (`/healthz`, revocation, CRL, the 4.10 console routes) always answer, and
//   `admin-presence` routes are exempt for a relay admin only (the presence session the 4.10 routes need). A route
//   missing from the table is refused while stopped. The console port and the AC-2a channel never pass here. Unseated
//   and held people get 403 `no-seat` while service runs.
// - The upgrade period: `state_dir/meet-license-state.json` `{firstStart, upgradePeriodEnds}` (seconds; ends null
//   when there is no period or the period is retired), written at the first start of this version before anything
//   is answered, never reset by a restart. During it the relay serves with no seat limit. A license does not use the
//   period up (R3-M4): it is retired only when an installed license's grace end is at or after `upgradePeriodEnds`,
//   or when the period runs out.
// - Seats (meet_seats.rs) run only while a fitting license is in force (`on` or `grace`), against its `users`.
//   While stopped no seat rule runs: the seat clock's days do not count, no notice is sent and no one is unseated.
//   Every deadline is judged in trusted time (meet_time.rs). The renewal reminders (R42-3) are sent by the console
//   (license_reminders.rs) from `service_view`; `license.service` is audited there.

use crate::license::{license_keys, license_standing, license_token_of, meet_roots, service_state, verify_meet_license, License, LicenseStanding, LicenseStateName, ServiceStateName, ServiceWhy};
use crate::meet::{Identity, E};
use crate::meet_hub::Hub;
use crate::meet_json::obj;
use crate::meet_seats::{Event, Level, Now, Seats, NO_SEAT};
use crate::meet_time::{Clock, TrustedTime, DAY_MS};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

pub const LICENSE_STATE_FILE: &str = "meet-license-state.json";
pub const LICENSE_FILE: &str = "license.lic";
/// 8.1 `meet.license-inactive`, 8.3 `license-inactive` (R42-1).
pub const LICENSE_INACTIVE: &str = "Your organization's Meeting Hub license is not active. Ask your admin.";
pub const NO_LICENSE: &str = "This relay has no Meeting Hub license.";
/// R42-4: the one-time upgrade period is 2 days.
pub const UPGRADE_DAYS: i64 = 2;
/// The AC-1 state files: any of them next to a missing meet-license-state.json means no upgrade period.
const AC1_FILES: [&str; 4] = [LICENSE_STATE_FILE, crate::meet_seats::SEATS_FILE, "console.json", AUDIT_HEAD];
const AUDIT_HEAD: &str = crate::console_audit::HEAD_FILE;
/// Checks at most this often (the license file, the seats); a principal never seen before checks at once.
const CHECK_EVERY_MS: i64 = 10_000;
const GATE_LOG_MS: i64 = 3_600_000;

/// The live check binary's development public key (PEM), given with `--dev-pub` before the relay starts.
#[cfg(feature = "live-check-clock")]
pub static LIVE_CHECK_DEV_PUB: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Tests verify the development-signed fixtures of tests/license-v2-products.json with its development key (SPKI,
/// base64); every test sets the same value.
#[cfg(test)]
pub static TEST_DEV_PUB: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// A route's place in the gate table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Serves people: refused while service is stopped.
    Service,
    /// Answers in every service state (health, revocation, CRL, the 4.10 console routes).
    Exempt,
    /// Presence: exempt for a relay admin (the session the exempt admin routes need), service for anyone else.
    AdminPresence,
}

use Class::{AdminPresence as P, Exempt as X, Service as S};

/// The gate table of the main port (2.4, R42-1): every route.
pub static GATE: &[(&str, &str, Class)] = &[
    // GET
    ("GET", "/healthz", X),
    ("GET", "/v1/admin/console/requests", X),
    ("GET", "/v1/crl", X),
    // MR-1 1.4: the signed relay directory, license-exempt like the CRL
    ("GET", "/v1/relays", X),
    ("GET", "/v1/admin/console/where", X),
    ("GET", "/v1/admin/console/fleet-bootstrap", X),
    ("GET", "/v1/whoami", P),
    ("GET", "/v1/events", P),
    ("GET", "/v1/inbox", S),
    ("GET", "/v1/notify/reads", S),
    ("GET", "/v1/dm/history", S),
    ("GET", "/v1/channels", S),
    ("GET", "/v1/channels/history", S),
    ("GET", "/v1/pins", S),
    ("GET", "/v1/search", S),
    ("GET", "/v1/meetings", S),
    ("GET", "/v1/room/history", S),
    ("GET", "/v1/room/captions", S),
    ("GET", "/v1/prefs", S),
    ("GET", "/v1/attendance", S),
    ("GET", "/v1/emoji", S),
    ("GET", "/v1/emoji/file", S),
    ("GET", "/v1/admin/renewals", S),
    ("GET", "/v1/enroll/status", S),
    ("GET", "/v1/admin/enrollments", S),
    ("GET", "/v1/devices/add/status", S),
    ("GET", "/v1/admin/seed-requests", S),
    ("GET", "/v1/admin/devices", S),
    ("GET", "/v1/admin/pending", S),
    ("GET", "/v1/admin/signer", S),
    ("GET", "/v1/admin/organizations", S),
    ("GET", "/v1/version", S),
    ("GET", "/v1/files/get", S),
    ("GET", "/v1/files/list", S),
    ("GET", "/v1/polls/mine", S),
    ("GET", "/v1/board", S),
    ("GET", "/v1/lobby", S),
    ("GET", "/v1/lobby/wait", S),
    ("GET", "/v1/bridge/links", S),
    ("GET", "/v1/admin/bridge", S),
    ("GET", "/v1/admin/bridge/audit", S),
    ("GET", "/v1/bridge/c/outbox", S),
    ("GET", "/v1/bridge/c/file", S),
    ("GET", "/v1/chat/devices", S),
    ("GET", "/v1/chat/keys", S),
    ("GET", "/v1/chat/log", S),
    ("GET", "/v1/org/policy", S),
    ("GET", "/v1/org/ai", S),
    ("GET", "/v1/ai/allowed", S),
    ("GET", "/v1/ai/history", S),
    ("GET", "/v1/admin/ai/audit", S),
    ("GET", "/v1/org/storage", S),
    ("GET", "/v1/apps", S),
    ("GET", "/v1/apps/icon", S),
    ("GET", "/v1/org/background", S),
    ("GET", "/v1/apps/c/events", S),
    ("GET", "/v1/admin/holds", S),
    ("GET", "/v1/sso/asks", S),
    ("GET", "/v1/docs/history", S),
    ("GET", "/v1/docs/list", S),
    // POST
    ("POST", "/v1/enroll", S),
    ("POST", "/v1/admin/approve", S),
    ("POST", "/v1/admin/enrolled", S),
    ("POST", "/v1/admin/seeded", S),
    ("POST", "/v1/admin/invite", S),
    ("POST", "/v1/admin/organizations", S),
    ("POST", "/v1/relays", S),
    ("POST", "/v1/devices/add", S),
    ("POST", "/v1/sso/answer", S),
    ("POST", "/v1/sso/c/sign", S),
    ("POST", "/v1/sso/c/org-member", S),
    ("POST", "/v1/sso/c/pending-add", S),
    ("POST", "/v1/admin/crl", X),
    ("POST", "/v1/admin/revoke", X),
    ("POST", "/v1/admin/console/invite", X),
    ("POST", "/v1/admin/console/requests/decline", X),
    ("POST", "/v1/admin/console/requests/sign", X),
    ("POST", "/v1/admin/console/fleet-endorse", X),
    ("POST", "/v1/hello", P),
    ("POST", "/v1/bye", P),
    ("POST", "/v1/join", S),
    ("POST", "/v1/signal", S),
    ("POST", "/v1/link", S),
    ("POST", "/v1/chat", S),
    ("POST", "/v1/chat/edit", S),
    ("POST", "/v1/chat/delete", S),
    ("POST", "/v1/typing", S),
    ("POST", "/v1/stage", S),
    ("POST", "/v1/status", S),
    ("POST", "/v1/caption", S),
    ("POST", "/v1/captions", S),
    ("POST", "/v1/room/options", S),
    ("POST", "/v1/leave", S),
    ("POST", "/v1/ice", S),
    ("POST", "/v1/dm", S),
    ("POST", "/v1/dm/read", S),
    ("POST", "/v1/react", S),
    ("POST", "/v1/channels", S),
    ("POST", "/v1/channels/join", S),
    ("POST", "/v1/channels/leave", S),
    ("POST", "/v1/channels/archive", S),
    ("POST", "/v1/channels/invite", S),
    ("POST", "/v1/channels/update", S),
    ("POST", "/v1/channels/post", S),
    ("POST", "/v1/channels/read", S),
    ("POST", "/v1/pins", S),
    ("POST", "/v1/meetings", S),
    ("POST", "/v1/meetings/update", S),
    ("POST", "/v1/meetings/cancel", S),
    ("POST", "/v1/meetings/rsvp", S),
    ("POST", "/v1/invite", S),
    ("POST", "/v1/invite/settle", S),
    ("POST", "/v1/phone/call", S),
    ("POST", "/v1/prefs", S),
    ("POST", "/v1/emoji", S),
    ("POST", "/v1/emoji/delete", S),
    ("POST", "/v1/push/register", S),
    ("POST", "/v1/push/unregister", S),
    ("POST", "/v1/recording", S),
    ("POST", "/v1/recording/policy", S),
    ("POST", "/v1/recording/consent", S),
    ("POST", "/v1/renew", S),
    ("POST", "/v1/renew/ack", S),
    ("POST", "/v1/admin/renewed", S),
    ("POST", "/v1/admin/ca", S),
    ("POST", "/v1/admin/signer", S),
    ("POST", "/v1/update/link", S),
    ("POST", "/v1/admin/release", S),
    ("POST", "/v1/files/start", S),
    ("POST", "/v1/files/chunk", S),
    ("POST", "/v1/files/finish", S),
    ("POST", "/v1/files/delete", S),
    ("POST", "/v1/polls", S),
    ("POST", "/v1/polls/vote", S),
    ("POST", "/v1/polls/close", S),
    ("POST", "/v1/board", S),
    ("POST", "/v1/sfu/token", S),
    ("POST", "/v1/e2ee", S),
    ("POST", "/v1/e2ee/keys", S),
    ("POST", "/v1/e2ee/roster", S),
    ("POST", "/v1/guest/link", S),
    ("POST", "/v1/lobby/leave", S),
    ("POST", "/v1/bridge/code", S),
    ("POST", "/v1/bridge/dm-code", S),
    ("POST", "/v1/bridge/unlink", S),
    ("POST", "/v1/bridge/call", S),
    ("POST", "/v1/admin/bridge", S),
    ("POST", "/v1/bridge/c/hello", S),
    ("POST", "/v1/bridge/c/claim", S),
    ("POST", "/v1/bridge/c/claim-dm", S),
    ("POST", "/v1/bridge/c/backfill", S),
    ("POST", "/v1/bridge/c/unlink", S),
    ("POST", "/v1/bridge/c/mode", S),
    ("POST", "/v1/bridge/c/notice", S),
    ("POST", "/v1/bridge/c/ack", S),
    ("POST", "/v1/bridge/c/post", S),
    ("POST", "/v1/bridge/c/edit", S),
    ("POST", "/v1/bridge/c/delete", S),
    ("POST", "/v1/bridge/c/react", S),
    ("POST", "/v1/bridge/c/call", S),
    ("POST", "/v1/bridge/c/file", S),
    ("POST", "/v1/chat/devices", S),
    ("POST", "/v1/chat/keys", S),
    ("POST", "/v1/chat/event", S),
    ("POST", "/v1/chat/log", S),
    ("POST", "/v1/org/policy", S),
    ("POST", "/v1/org/policy/sign", S),
    ("POST", "/v1/org/ai", S),
    ("POST", "/v1/org/ai/sign", S),
    ("POST", "/v1/sso/c/ai-groups", S),
    ("POST", "/v1/ai/audit", S),
    ("POST", "/v1/ai/history", S),
    ("POST", "/v1/ai/history/delete", S),
    ("POST", "/v1/org/storage", S),
    ("POST", "/v1/org/storage/sign", S),
    ("POST", "/v1/apps/icon", S),
    ("POST", "/v1/org/background", S),
    ("POST", "/v1/apps/c/hello", S),
    ("POST", "/v1/apps/c/ack", S),
    ("POST", "/v1/apps/c/renew", S),
    ("POST", "/v1/admin/holds", S),
    ("POST", "/v1/admin/holds/release", S),
    ("POST", "/v1/sso/c/revoke", S),
    ("POST", "/v1/docs/post", S),
    ("POST", "/v1/docs/aware", S),
    ("POST", "/v1/docs/delete", S),
];

/// The gate table of the guest port (2.4, R42-1): every API route; all serve people (guests joining calls).
pub static GUEST_GATE: &[(&str, &str, Class)] = &[
    ("GET", "/g/v1/wait", S),
    ("GET", "/g/v1/events", S),
    ("POST", "/g/v1/knock", S),
    ("POST", "/g/v1/signal", S),
    ("POST", "/g/v1/chat", S),
    ("POST", "/g/v1/stage", S),
    ("POST", "/g/v1/consent", S),
    ("POST", "/g/v1/leave", S),
];

/// A route's class in `table`; None for a route missing from it (refused while stopped).
pub fn class_in(table: &[(&str, &str, Class)], method: &str, path: &str) -> Option<Class> {
    table.iter().find(|(m, p, _)| *m == method && *p == path).map(|(_, _, c)| *c)
}

/// The 403 `license-inactive` refusal while service is stopped (main and guest port shape: `code` and words).
pub fn inactive() -> E {
    E::Held(LICENSE_INACTIVE.into(), obj([("code", Value::from("license-inactive"))]))
}

fn no_seat() -> E {
    E::Held(NO_SEAT.into(), obj([("code", Value::from("no-seat"))]))
}

/// The relay's service state (2.4, R42-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    /// A fitting license before its `exp`.
    On,
    /// A fitting license after `exp`, within its honored grace (at most 2 days).
    Grace,
    /// No fitting license in force, during the 2-day upgrade period: served, with no seat limit.
    UpgradePeriod,
    Stopped,
}

impl Service {
    pub fn as_str(self) -> &'static str {
        match self {
            Service::On => "on",
            Service::Grace => "grace",
            Service::UpgradePeriod => "upgrade-period",
            Service::Stopped => "stopped",
        }
    }

    pub fn serving(self) -> bool {
        self != Service::Stopped
    }
}

/// The upgrade period of `meet-license-state.json` (seconds).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upgrade {
    pub first_start: i64,
    /// None: no period, or retired.
    pub ends: Option<i64>,
    /// Why there is no period (any more): "absent" (created terminal, R6-L1), "license" or "ended"; None while a
    /// period runs.
    pub retired: Option<String>,
}

fn read_upgrade(dir: &Path) -> Result<Option<Upgrade>, String> {
    let Some(o) = crate::meet_time::read_object(&dir.join(LICENSE_STATE_FILE))? else { return Ok(None) };
    let bad = || format!("{LICENSE_STATE_FILE} is not valid; the relay will not start until it is fixed or restored");
    if !(2..=3).contains(&o.len()) || o.keys().any(|k| !["firstStart", "upgradePeriodEnds", "retired"].contains(&k.as_str())) {
        return Err(bad());
    }
    let first_start = o.get("firstStart").and_then(Value::as_i64).ok_or_else(bad)?;
    let ends = match o.get("upgradePeriodEnds") {
        Some(Value::Null) => None,
        Some(v) => Some(v.as_i64().ok_or_else(bad)?),
        None => return Err(bad()),
    };
    let retired = match o.get("retired") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().filter(|r| ["absent", "license", "ended"].contains(r)).ok_or_else(bad)?.to_owned()),
    };
    // a terminal file can never gain a period
    if retired.is_some() && ends.is_some() {
        return Err(bad());
    }
    Ok(Some(Upgrade { first_start, ends, retired }))
}

/// Written atomically (R6-L1): a temporary file, synced, then renamed over the old one, so a crash leaves either the
/// old file (or none) or the new one, never a partial file.
fn write_upgrade(dir: &Path, u: &Upgrade) -> Result<(), String> {
    let mut body = json!({"firstStart": u.first_start, "upgradePeriodEnds": u.ends});
    if let Some(r) = &u.retired {
        body["retired"] = Value::from(r.clone());
    }
    write_atomic(&dir.join(LICENSE_STATE_FILE), format!("{body}\n").as_bytes()).map_err(|e| format!("{LICENSE_STATE_FILE} cannot be written: {e}"))
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// "From before AC-1": the state folder holds Meeting Hub state (a device store with at least one device record) and
/// no AC-1 state file.
pub fn from_before_ac1(dir: &Path) -> bool {
    before_ac1(dir, false)
}

/// Any AC-1 state file in `dir`.
pub fn has_ac1_state(dir: &Path) -> bool {
    AC1_FILES.iter().any(|f| dir.join(f).exists())
}

/// `from_before_ac1`, the audit head not counted when `audit_by_deploy` (GateConfig).
fn before_ac1(dir: &Path, audit_by_deploy: bool) -> bool {
    if AC1_FILES.iter().any(|f| !(audit_by_deploy && *f == AUDIT_HEAD) && dir.join(f).exists()) {
        return false;
    }
    let Ok(raw) = std::fs::read(dir.join("state.json")) else { return false };
    let Ok(v) = serde_json::from_slice::<Value>(&raw) else { return false };
    v.get("directory").and_then(Value::as_object).is_some_and(|d| d.values().any(|e| e.get("devices").and_then(Value::as_object).is_some_and(|d| !d.is_empty())))
}

struct Licensed {
    license: License,
    dev: bool,
    text: String,
}

/// Where the gate stands at one moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Standing {
    pub license: LicenseStanding,
    /// The license is valid or in grace.
    pub active: bool,
    /// The upgrade period runs (not retired, not over).
    pub period: bool,
    pub service: Service,
    /// When service stops (seconds), None while stopped (license::service_state).
    pub stops_at: Option<i64>,
    /// Why service is stopped, None while it runs.
    pub why: Option<ServiceWhy>,
}

/// Where the gate reads its files.
pub struct GateConfig {
    pub state_dir: Option<PathBuf>,
    /// relay.json `license`, else state_dir/license.lic.
    pub license_file: Option<PathBuf>,
    pub client_ca: PathBuf,
    /// AC-2b-D 6.4: this start's apply before the listeners wrote the first AC-1 state (its headless console's audit
    /// log) into a folder that held none, so the audit head is not evidence of earlier AC-1 state.
    pub audit_by_deploy: bool,
}

/// The service gate, the upgrade period and the seats of one Meet relay (I13).
pub struct MeetGate {
    cfg: GateConfig,
    hub: Weak<Hub>,
    pub time: TrustedTime,
    licensed: Mutex<Option<Licensed>>,
    problem: Mutex<String>,
    upgrade: Mutex<Upgrade>,
    seats: Mutex<Seats>,
    checked: Mutex<Option<i64>>,
    logged: Mutex<HashMap<String, i64>>,
    /// Audit entries made before the console's hooks are installed (the first start writes before it answers).
    pending: Mutex<Vec<(String, String, Value)>>,
    /// R7-M1: an offline license clock reset (before, after) to audit with actor operator once the hooks exist.
    pending_reset: Mutex<Option<(i64, i64)>>,
    protected_short: Mutex<bool>,
    clock_mailed: Mutex<Option<i64>>,
}

impl MeetGate {
    /// At start, before the ports listen. Err stops the start (an unreadable state file, or one that cannot be
    /// written).
    pub fn open(cfg: GateConfig, hub: &Arc<Hub>, clock: Arc<dyn Clock>) -> Result<Arc<MeetGate>, String> {
        let dir = cfg.state_dir.clone();
        if clock.live_check() {
            let d = dir.as_deref().ok_or("lucid-relay-seatclock-check needs a state folder")?;
            crate::meet_time::live_check_folder(d)?;
        }
        // decided before this start writes any state file
        let by_deploy = cfg.audit_by_deploy;
        let before = dir.as_deref().is_some_and(|d| before_ac1(d, by_deploy));
        // R6-L1: an absent meet-seats.json or meet-time.json next to other AC-1 state stops the start (recreating them
        // would forget the seat clock, lastLicense or the high-water mark)
        if let Some(d) = dir.as_deref() {
            let has = |f: &str| d.join(f).exists() && !(by_deploy && f == AUDIT_HEAD);
            let others = |skip: &str| [LICENSE_STATE_FILE, crate::meet_seats::SEATS_FILE, crate::meet_time::TIME_FILE, "console.json", AUDIT_HEAD].iter().any(|f| *f != skip && has(f));
            for f in [crate::meet_seats::SEATS_FILE, crate::meet_time::TIME_FILE] {
                if !has(f) && others(f) {
                    return Err(format!("{f} is missing next to this relay's other Admin Console state; the relay will not start until it is restored"));
                }
            }
        }
        let time = TrustedTime::open(dir.as_deref(), clock)?;
        let t = time.now();
        let mut pending = Vec::new();
        let upgrade = match dir.as_deref() {
            None => Upgrade { first_start: t / 1000, ends: None, retired: Some("absent".into()) },
            Some(d) => match read_upgrade(d)? {
                Some(u) => u,
                None => {
                    // R6-L1: created atomically before anything is answered: a period only for a relay from before
                    // AC-1, otherwise terminal (a fresh install, or a file deleted next to AC-1 state)
                    let u = if before {
                        Upgrade { first_start: t / 1000, ends: Some(t / 1000 + UPGRADE_DAYS * 86_400), retired: None }
                    } else {
                        Upgrade { first_start: t / 1000, ends: None, retired: Some("absent".into()) }
                    };
                    write_upgrade(d, &u)?;
                    if before {
                        pending.push(("meet.license.upgrade-period".to_string(), "-".to_string(), json!({"ends": u.ends.map(|e| e * 1000)})));
                    }
                    u
                }
            },
        };
        let seats = match Seats::read(dir.as_deref())? {
            Some(s) => s,
            None => {
                let records = hub.seat_records();
                let s = Seats::migrate(dir.as_deref(), &records, t);
                s.save()?;
                if !s.migrated.is_empty() {
                    let from_records = records.iter().filter(|(_, at)| at.is_some()).count();
                    pending.push(("meet.seats.migrated".to_string(), "-".to_string(), json!({"principals": s.migrated.len(), "fromRecords": from_records, "byOrder": s.migrated.len() - from_records.min(s.migrated.len())})));
                }
                s
            }
        };
        let gate = Arc::new(MeetGate {
            cfg,
            hub: Arc::downgrade(hub),
            time,
            licensed: Mutex::new(None),
            problem: Mutex::new(NO_LICENSE.into()),
            upgrade: Mutex::new(upgrade),
            seats: Mutex::new(seats),
            checked: Mutex::new(None),
            logged: Mutex::new(HashMap::new()),
            pending: Mutex::new(pending),
            pending_reset: Mutex::new(None),
            protected_short: Mutex::new(false),
            clock_mailed: Mutex::new(None),
        });
        // R7-M1: an offline `license-time reset` since the last start is logged and audited once (actor operator)
        if let Some((before, after)) = gate.time.take_reset() {
            crate::meet::log_warn(&format!("license.time-reset category=security before={before} after={after}"));
            *gate.pending_reset.lock() = Some((before, after));
            gate.flush_pending();
        }
        // a start with a protected principal unseated repairs it (R3-M6); `lastLicense` and the seat clock are written
        // before the first answer, and a start without a license in force does not credit the downtime to the seat clock
        gate.check(true);
        // the live check binary does not start with a publisher-signed license (R4-H1)
        if gate.time.clock().live_check() && gate.problem().contains("for tests only") {
            return Err(gate.problem());
        }
        Ok(gate)
    }

    fn audit(&self, action: &str, target: &str, detail: Value) {
        crate::meet::log_info(&format!("{action} actor=relay target={target} detail={detail}"));
        match self.hub.upgrade().and_then(|h| h.console_hooks_installed()) {
            Some(h) => {
                for (a, t, d) in self.pending.lock().drain(..) {
                    h.audit(&a, &t, d);
                }
                h.audit(action, target, detail);
            }
            None => self.pending.lock().push((action.to_string(), target.to_string(), detail)),
        }
    }

    /// The audit entries kept until the console's hooks were installed.
    pub fn flush_pending(&self) {
        let Some(h) = self.hub.upgrade().and_then(|h| h.console_hooks_installed()) else { return };
        for (a, t, d) in self.pending.lock().drain(..) {
            h.audit(&a, &t, d);
        }
        if let Some((before, after)) = self.pending_reset.lock().take() {
            h.audit_operator("license.time-reset", "-", json!({"before": before, "after": after}));
        }
    }

    fn mail(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        if let Some(h) = self.hub.upgrade().and_then(|h| h.console_hooks_installed()) {
            h.mail(kind, to, args);
        }
    }

    fn admin_emails(&self) -> Vec<String> {
        self.hub.upgrade().and_then(|h| h.console_hooks_installed()).map(|h| h.admin_emails()).unwrap_or_default()
    }

    /// A relay admin (relay.json `admins`) or an active console admin.
    pub fn protected(&self, principal: &str) -> bool {
        let Some(hub) = self.hub.upgrade() else { return false };
        hub.is_admin(principal) || hub.console_hooks_installed().is_some_and(|h| h.console_admin(principal))
    }

    fn verify(&self, text: &str, t: i64) -> Result<(License, bool), String> {
        let keys = self.keys()?;
        let roots = meet_roots(&std::fs::read(&self.cfg.client_ca).unwrap_or_default());
        let c = verify_meet_license(&license_token_of(text), &roots, &keys, t.div_euclid(1000))?;
        if self.time.clock().live_check() && !c.dev {
            // 8.1 `python.test-only` with "The seat clock check" in place of "The Python reference relay"
            return Err("The seat clock check is for tests only. Use the Rust relay (lucid-relay meet) with a Meeting Hub license.".into());
        }
        Ok((c.license, c.dev))
    }

    /// The keys this process verifies with: the build's (license_keys), or in the live check binary the development
    /// public key alone (R4-H1: it holds no publisher key, so every publisher-signed license is refused).
    fn keys(&self) -> Result<crate::license::LicenseKeys, String> {
        #[cfg(feature = "live-check-clock")]
        if self.time.clock().live_check() {
            let pem = LIVE_CHECK_DEV_PUB.get().ok_or("the seat clock check needs its development public key (--dev-pub)")?;
            return crate::license::LicenseKeys::development_only(pem);
        }
        #[cfg(test)]
        if let Some(dev) = TEST_DEV_PUB.get() {
            return crate::license::LicenseKeys::with_dev(dev, "devPub");
        }
        license_keys(|k| std::env::var(k).ok())
    }

    /// Re-read the license file: a change takes effect at once; a missing file is no license.
    fn read_license(&self, t: i64) {
        let text = self.cfg.license_file.as_deref().and_then(crate::store::read_text);
        let mut cur = self.licensed.lock();
        let Some(text) = text else {
            *cur = None;
            *self.problem.lock() = NO_LICENSE.into();
            return;
        };
        if cur.as_ref().is_some_and(|l| l.text == text) {
            return;
        }
        match self.verify(&text, t) {
            Ok((license, dev)) => {
                *cur = Some(Licensed { license, dev, text });
                *self.problem.lock() = String::new();
            }
            Err(why) => {
                if self.problem.lock().as_str() != format!("This license cannot be used here: {why}.") {
                    crate::meet::log_warn(&format!("license.refused category=security why={}", crate::meet::kv(&why)));
                }
                *cur = None;
                *self.problem.lock() = format!("This license cannot be used here: {why}.");
            }
        }
    }

    /// The license in force and whether it is a development license.
    pub fn license(&self) -> Option<(License, bool)> {
        self.licensed.lock().as_ref().map(|l| (l.license.clone(), l.dev))
    }

    /// Why there is no license in force ("" when there is one).
    pub fn problem(&self) -> String {
        self.problem.lock().clone()
    }

    pub fn upgrade(&self) -> Upgrade {
        self.upgrade.lock().clone()
    }

    /// `lastLicense` (R6-M1): the last fitting license's comparison record, the 4.7 reference with none in force.
    pub fn last_license(&self) -> Option<crate::meet_seats::LastLicense> {
        self.seats.lock().last_license.clone()
    }

    /// Where the gate stands at effective time `t` (milliseconds). The license standing honors min(graceDays, 2)
    /// (R42-2, license.rs).
    pub fn standing_at(&self, t: i64) -> Standing {
        let license = license_standing(self.licensed.lock().as_ref().map(|l| &l.license), t.div_euclid(1000));
        let active = matches!(license.state, Some(LicenseStateName::Valid | LicenseStateName::Grace));
        let ends = self.upgrade.lock().ends;
        let period = ends.is_some_and(|e| t.div_euclid(1000) < e);
        let state = {
            let cur = self.licensed.lock();
            let given = match cur.as_ref() {
                Some(l) => Ok(&l.license),
                None => Err(self.why_none()),
            };
            service_state(given, ends, t.div_euclid(1000))
        };
        let service = match state.state {
            ServiceStateName::On => Service::On,
            ServiceStateName::Grace => Service::Grace,
            ServiceStateName::UpgradePeriod => Service::UpgradePeriod,
            ServiceStateName::Stopped => Service::Stopped,
        };
        Standing { license, active, period, service, stops_at: state.stops_at, why: state.why }
    }

    pub fn standing(&self) -> Standing {
        self.standing_at(self.time.now())
    }

    /// The service state now (I13).
    pub fn service(&self) -> Service {
        self.standing().service
    }

    /// The service view the console's reminders, banners and attention read (I13, R42-3): the state, when service
    /// stops (ms: the honored grace end, or the upgrade period's end), why it is stopped, the period's end, the
    /// fitting license's id and `exp` (ms), and the trusted time it was judged at.
    pub fn service_view(&self) -> crate::console::ServiceView {
        use crate::console::ServiceState;
        let t = self.time.now();
        let s = self.standing_at(t);
        let ends = self.upgrade.lock().ends.map(|e| e * 1000);
        let lic = self.licensed.lock().as_ref().map(|l| (l.license.id.clone(), l.license.exp));
        let state = match s.service {
            Service::On => ServiceState::On,
            Service::Grace => ServiceState::Grace,
            Service::UpgradePeriod => ServiceState::UpgradePeriod,
            Service::Stopped => ServiceState::Stopped,
        };
        crate::console::ServiceView {
            state,
            stops_at: s.stops_at.map(|e| e * 1000),
            why: s.why.map(ServiceWhy::as_str),
            upgrade_period_ends: ends,
            license_id: lic.as_ref().map(|(id, _)| id.clone()),
            exp: lic.as_ref().map(|(_, exp)| exp * 1000),
            // the verifier's words for a refused file (never the token), only with a refusal why
            reason: match s.why {
                Some(ServiceWhy::WrongProduct | ServiceWhy::WrongRoot | ServiceWhy::Invalid) => self.refusal(),
                _ => None,
            },
            at: t,
        }
    }

    /// The verifier's words for the refused license file, without the "This license cannot be used here: " frame;
    /// None with no file or a fitting one.
    fn refusal(&self) -> Option<String> {
        let p = self.problem.lock();
        if p.as_str() == NO_LICENSE || p.is_empty() {
            return None;
        }
        let reason = p.strip_prefix("This license cannot be used here: ").unwrap_or(&p);
        Some(reason.strip_suffix('.').unwrap_or(reason).to_owned())
    }

    /// Why no fitting license is in force: none, or the verifier's refusal of the file (wrong product or root, or
    /// invalid).
    fn why_none(&self) -> ServiceWhy {
        match self.refusal() {
            None => ServiceWhy::None,
            Some(reason) => ServiceWhy::of_refusal(&reason),
        }
    }

    /// The limit the seat rules use now: the fitting license's `users` while one is in force (`on` or `grace`), else
    /// none (no seat rule runs).
    fn limit_of(&self, s: &Standing) -> Option<i64> {
        s.active.then_some(s.license.users)
    }

    /// The periodic check: the license file, the upgrade period, `lastLicense`, the seat clock's pause and the seats.
    /// `force` skips the 10-second spacing.
    pub fn check(&self, force: bool) {
        let t = self.time.now();
        {
            let mut checked = self.checked.lock();
            if !force && checked.is_some_and(|c| t - c < CHECK_EVERY_MS && t >= c) {
                return;
            }
            *checked = Some(t);
        }
        self.read_license(t);
        self.upgrade_tick(t);
        let s = self.standing_at(t);
        // R6-M1: a fitting license in on or grace writes its comparison record into `lastLicense` before anything is
        // answered (its only use is the 4.7 install comparison)
        if s.active {
            let mut seats = self.seats.lock();
            let record = self.licensed.lock().as_ref().map(|l| crate::meet_seats::LastLicense::of(&l.license));
            if seats.last_license != record {
                seats.last_license = record;
                if let Err(e) = seats.save() {
                    crate::meet::log_error(&e);
                }
            }
        }
        // R42-1: the seat clock's days count only while a fitting license is in force
        self.time.set_seat_paused(!s.active);
        self.seats_tick(t, &s);
    }

    fn upgrade_tick(&self, t: i64) {
        let now_s = t.div_euclid(1000);
        let mut u = self.upgrade.lock();
        let Some(ends) = u.ends else { return };
        let retired = if self.licensed.lock().as_ref().is_some_and(|l| l.license.grace_end() >= ends) {
            Some("license")
        } else if now_s >= ends {
            Some("ended")
        } else {
            None
        };
        if let Some(why) = retired {
            u.ends = None;
            u.retired = Some(why.to_owned());
            let snapshot = u.clone();
            drop(u);
            if let Some(d) = self.cfg.state_dir.as_deref() {
                if let Err(e) = write_upgrade(d, &snapshot) {
                    crate::meet::log_error(&e);
                }
            }
            self.audit("meet.license.upgrade-period", "-", json!({"ends": ends * 1000, "retired": why}));
        }
        // the period's reminders (at its start, every 12 hours, then the stop mail) are the console's (R42-3)
    }

    fn seats_tick(&self, t: i64, s: &Standing) {
        let Some(hub) = self.hub.upgrade() else { return };
        let live = hub.seat_live(t.div_euclid(1000));
        let protected = |p: &str| self.protected(p);
        let view = self.time.view();
        let limit = self.limit_of(s);
        let now = Now { t, seat_elapsed: view.seat_elapsed, day_ms: self.time.seat_day_ms(), uncertain: view.uncertain, hold_due: view.hold_due(), users: limit, protected: &protected };
        let mut seats = self.seats.lock();
        let (changed, events) = seats.reconcile(&live, &now);
        if changed {
            // written before anything else is answered
            if let Err(e) = self.time.save().and_then(|_| seats.save()) {
                crate::meet::log_error(&e);
            }
        }
        let seated = seats.seated(&live).len() as i64;
        let unseat_date = seats.clock.as_ref().map(|c| crate::meet_json::iso_date((c.started_at + 14 * DAY_MS) / 1000)).unwrap_or_default();
        drop(seats);
        let users = limit.unwrap_or(0);
        for e in events {
            match e {
                Event::Unseat { principal, why } => {
                    hub.drop_principal(&principal);
                    self.audit("meet.seats.unseat", &principal, json!({"why": why}));
                    if principal.contains('@') {
                        self.mail("mail.unseated", &principal, &[("date", crate::meet_json::iso_date(t / 1000))]);
                    }
                }
                Event::Reseat { principal, why } => {
                    self.audit("meet.seats.reseat", &principal, json!({"why": why}));
                    if principal.contains('@') {
                        self.mail("mail.reseated", &principal, &[("date", crate::meet_json::iso_date(t / 1000))]);
                    }
                }
                Event::ClockStart { .. } => self.audit("meet.seats.clock", "-", json!({"state": "start", "seated": seated, "users": users})),
                Event::ClockClear => self.audit("meet.seats.clock", "-", json!({"state": "clear", "seated": seated, "users": users})),
                Event::Notice { day } => {
                    let admins = self.admin_emails();
                    for to in &admins {
                        self.mail("mail.seats-over", to, &[("seated", seated.to_string()), ("users", users.to_string()), ("n", (seated - users).max(0).to_string()), ("date", unseat_date.clone())]);
                    }
                    self.audit("meet.seats.notice", "-", json!({"day": day, "mailed": admins.len()}));
                }
                Event::Protected => *self.protected_short.lock() = true,
                Event::Hold { principal } => {
                    hub.drop_principal(&principal);
                    self.audit("meet.seats.hold", &principal, json!({}));
                }
                Event::ReleaseHold { principal } => self.audit("meet.seats.release-hold", &principal, json!({})),
            }
        }
        // R4-M1: while the time is uncertain, every active admin gets `mail.clock-uncertain` once a day
        if view.uncertain {
            let mut last = self.clock_mailed.lock();
            if last.is_none_or(|at| t - at >= DAY_MS) {
                *last = Some(t);
                let since = view.uncertain_since.map(|s| crate::meet_json::iso_utc(s / 1000)).unwrap_or_default();
                let hours = self.time.hold_hours_left().unwrap_or(0).to_string();
                for to in self.admin_emails() {
                    self.mail("mail.clock-uncertain", &to, &[("time", since.clone()), ("n", hours.clone())]);
                }
            }
        } else {
            *self.clock_mailed.lock() = None;
        }
        if limit.is_none_or(|u| seated <= u) {
            *self.protected_short.lock() = false;
        }
    }

    /// The gate at main-port dispatch (2.4, 4.10): `exempt` routes always go on; while service is stopped every
    /// `service` route (and a route missing from the table) answers 403 `license-inactive`, and an `admin-presence`
    /// route goes on only for a relay admin's device; while service runs, an unseated or held person's device gets
    /// 403 `no-seat`.
    pub fn admits(&self, method: &str, path: &str, who: Option<&Identity>) -> Result<(), E> {
        self.gate(GATE, method, path, who)
    }

    /// The gate at guest-port dispatch (2.4, R42-1): every guest route serves people (guests have no seat).
    pub fn admits_guest(&self, method: &str, path: &str) -> Result<(), E> {
        self.gate(GUEST_GATE, method, path, None)
    }

    fn gate(&self, table: &[(&str, &str, Class)], method: &str, path: &str, who: Option<&Identity>) -> Result<(), E> {
        let class = class_in(table, method, path);
        if class == Some(Class::Exempt) {
            return Ok(());
        }
        let fresh = who.is_some_and(|w| person(w) && !self.seats.lock().first_seen.contains_key(&w.principal));
        self.check(fresh);
        if !self.service().serving() {
            let admin = || who.is_some_and(|w| person(w) && self.hub.upgrade().is_some_and(|h| h.is_admin(&w.principal)));
            if class == Some(Class::AdminPresence) && admin() {
                return Ok(());
            }
            self.log_refused(who.map(|w| if w.device.is_empty() { w.principal.as_str() } else { w.device.as_str() }).unwrap_or_default());
            return Err(inactive());
        }
        if let Some(w) = who.filter(|w| person(w)) {
            let seats = self.seats.lock();
            if seats.is_unseated(&w.principal) || seats.is_held(&w.principal) {
                return Err(no_seat());
            }
        }
        Ok(())
    }

    /// `license.gate` (security, warn), at most once per device an hour.
    fn log_refused(&self, device: &str) {
        let t = self.time.now();
        let mut logged = self.logged.lock();
        if logged.get(device).is_some_and(|at| t - at < GATE_LOG_MS) {
            return;
        }
        if logged.len() > 10_000 {
            logged.clear();
        }
        logged.insert(device.to_owned(), t);
        crate::meet::log_warn(&format!("license.gate category=security device={}", crate::meet::kv(device)));
    }

    // ── the console's views and actions (4.7, 4.9) ──

    /// Install a license the console verified: written owner-only, effective at once; the dialog tells whether the
    /// upgrade period stays as a fallback (R3-M4).
    pub fn installed(&self) {
        *self.checked.lock() = None;
        self.check(true);
    }

    /// Whether a license with this grace end (seconds) would keep the upgrade period as a fallback (8.2 `license`).
    pub fn keeps_period(&self, grace_end: i64) -> bool {
        self.upgrade.lock().ends.is_some_and(|e| grace_end < e)
    }

    pub fn verify_candidate(&self, text: &str) -> Result<(License, bool), String> {
        self.verify(text, self.time.now())
    }

    /// `meet.seats.pick`.
    pub fn pick(&self, principal: &str, by: &str, pick: bool) -> Result<(), (&'static str, String)> {
        let Some(hub) = self.hub.upgrade() else { return Err(("not-found", "There is no such person.".into())) };
        let t = self.time.now();
        let live = hub.seat_live(t.div_euclid(1000));
        let protected = self.protected(principal);
        let mut seats = self.seats.lock();
        let seated = live.iter().any(|p| p == principal) && !seats.is_unseated(principal);
        seats.pick(principal, by, t, pick, protected, seated)?;
        seats.save().map_err(|e| {
            crate::meet::log_error(&e);
            ("write-failed", String::new())
        })
    }

    /// GET meet/seats (4.9): `users` is the fitting license's `users` while one is in force, else null (no seat rule
    /// runs); `service` is the service state (the Seats page shows `seats.stopped` while `stopped`).
    pub fn seats_view(&self, names: &dyn Fn(&str) -> String, request_to: Option<String>) -> Value {
        self.check(false);
        let Some(hub) = self.hub.upgrade() else { return Value::Null };
        let t = self.time.now();
        let s = self.standing_at(t);
        let limit = self.limit_of(&s);
        let users = limit.unwrap_or(0);
        let live = hub.seat_live(t.div_euclid(1000));
        let seats = self.seats.lock();
        let seated = seats.seated(&live).len() as i64;
        let day_ms = self.time.seat_day_ms();
        let elapsed = self.time.seat_elapsed();
        let clock = seats.clock.as_ref().map(|c| {
            let day = seats.day(elapsed, day_ms).unwrap_or(0);
            let unseat_at = t + (c.start_elapsed + 14 * day_ms - elapsed).max(0);
            json!({"startedAt": c.started_at, "day": day, "unseatAt": unseat_at, "notices": c.notices.iter().map(|(d, at)| json!({"day": d, "at": at})).collect::<Vec<_>>()})
        });
        let mut everyone: Vec<String> = live.clone();
        for u in &seats.unseated {
            if !everyone.contains(&u.principal) {
                everyone.push(u.principal.clone());
            }
        }
        let people: Vec<Value> = everyone
            .iter()
            .map(|p| {
                json!({
                    "principal": p, "name": names(p), "firstSeenAt": seats.first_seen.get(p), "seated": live.contains(p) && !seats.is_unseated(p),
                    "picked": seats.pick_of(p).map(|k| json!({"by": k.by, "at": k.at})), "protected": self.protected(p), "unseatedAt": seats.unseated_at(p), "heldAt": seats.held_at(p),
                })
            })
            .collect();
        json!({
            "ok": true, "users": limit, "seated": seated, "state": Seats::level(seated, users).as_str(), "clock": clock, "people": people,
            "unseated": seats.unseated.len(), "held": seats.held.len(), "requestTo": request_to, "migrated": seats.migrated_seated(&live),
            "service": s.service.as_str(), "upgradePeriodEnds": self.upgrade().ends.map(|e| e * 1000),
        })
    }

    /// Seats in use and the limit in force (0 with none; `used` is the seated principals).
    pub fn seat_counts(&self) -> (i64, i64) {
        let Some(hub) = self.hub.upgrade() else { return (0, 0) };
        let t = self.time.now();
        let s = self.standing_at(t);
        let limit = self.limit_of(&s);
        let live = hub.seat_live(t.div_euclid(1000));
        let seated = self.seats.lock().seated(&live).len() as i64;
        (seated, limit.unwrap_or(0))
    }

    pub fn is_seated(&self, principal: &str) -> bool {
        let seats = self.seats.lock();
        !seats.is_unseated(principal) && !seats.is_held(principal)
    }

    /// The attention items (and banners) of 2.4 for Overview (I13), in the console's item shape.
    pub fn attention(&self) -> Vec<Value> {
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({"kind": kind, "severity": severity, "args": args, "go": go});
        let with_banner = |mut v: Value, id: &str| {
            v["banner"] = Value::from(id);
            v
        };
        // the license items and banners (license-*, the upgrade period) come from the console's service view (R42-3)
        let mut out = Vec::new();
        let view = self.time.view();
        if view.uncertain {
            out.push(item("clock-uncertain", "bad", json!({"n": self.time.hold_hours_left().unwrap_or(0)}), "#/meet/seats"));
        }
        let held = self.seats.lock().held.len();
        if held > 0 {
            out.push(item("seats-held", "bad", json!({"n": held}), "#/meet/seats"));
        }
        if view.back {
            out.push(item("clock-back", "warn", json!({}), "#/meet/seats"));
        }
        let (seated, users) = self.seat_counts();
        let seats = self.seats.lock();
        match Seats::level(seated, users) {
            Level::Over => {
                let day = seats.day(self.time.seat_elapsed(), self.time.seat_day_ms()).unwrap_or(0);
                let date = seats.clock.as_ref().map(|c| crate::meet_json::iso_date((c.started_at + 14 * DAY_MS) / 1000)).unwrap_or_default();
                let n = seated - users;
                out.push(with_banner(item("seats-over", "warn", json!({"used": seated, "users": users, "day": day, "n": n, "date": date, "seated": seated}), "#/meet/seats"), "banner.seats-over"));
            }
            Level::High => out.push(item("seats-high", "warn", json!({"used": seated, "users": users}), "#/meet/seats")),
            Level::Ok => {}
        }
        if !seats.unseated.is_empty() {
            out.push(item("seats-unseated", "info", json!({"n": seats.unseated.len()}), "#/meet/seats"));
        }
        if *self.protected_short.lock() {
            out.push(item("seats-protected", "warn", json!({}), "#/meet/seats"));
        }
        out
    }

    /// GET meet/clock (4.9).
    pub fn clock_view(&self) -> Value {
        let v = self.time.view();
        json!({
            "ok": true, "wall": v.wall, "effective": v.effective, "highWater": v.high_water, "uncertain": v.uncertain, "back": v.back,
            "heldGapMs": v.held_gap_ms, "uncertainSince": v.uncertain_since, "uncertainRunningMs": v.uncertain_running, "holdAt": self.time.hold_at(), "holdHoursLeft": self.time.hold_hours_left(),
        })
    }

    /// `meet.clock.confirm` (2.4 "Trusted time"): Ok with the old and new times (audited by the console).
    pub fn confirm_clock(&self, browser_ms: i64) -> Result<crate::meet_time::Confirmed, &'static str> {
        let done = self.time.confirm(browser_ms)?;
        self.check(true);
        Ok(done)
    }
}

/// A person's device (not a seed, guest, connector, service or the console): seats apply to it.
fn person(w: &Identity) -> bool {
    !w.principal.is_empty() && !w.guest && !w.connector && !w.is_service() && !w.is_console() && !w.seed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meet_time::testclock::FakeClock;

    const T0: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-meet-license-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn hub(d: &Path) -> Arc<Hub> {
        Arc::new(Hub::new(Some(d.to_path_buf()), &["admin@x.org".to_string()], 1e9, 1e9, 1e9, None, Arc::new(crate::meet_console::LinkStats::new())))
    }

    fn cfg(d: &Path) -> GateConfig {
        GateConfig { state_dir: Some(d.to_path_buf()), license_file: Some(d.join(LICENSE_FILE)), client_ca: d.join("client_ca.pem"), audit_by_deploy: false }
    }

    fn old_state(d: &Path) {
        std::fs::write(d.join("state.json"), r#"{"v": 2, "directory": {"ann@x.org": {"name": "Ann", "devices": {"aaaaaaaaaaaaaaaa": {"label": "PC", "last_seen": 1}}}}}"#).unwrap();
    }

    /// A person the relay holds: a device record with a certificate serial.
    fn seat(h: &Hub, principal: &str, device: &str, serial: &str) {
        h.st.lock().directory.insert(principal.into(), json!({"name": principal, "devices": {device: {"serial": serial, "label": "PC", "not_after": 0}}}));
    }

    fn device(principal: &str, device: &str, serial: &str) -> Identity {
        Identity { principal: principal.into(), device: device.into(), serial: serial.into(), kind: "person".into(), ..Default::default() }
    }

    fn refused(r: Result<(), E>) -> String {
        match r {
            Err(E::Held(words, info)) => format!("{} {words}", info["code"].as_str().unwrap_or_default()),
            Err(other) => format!("{other:?}"),
            Ok(()) => "ok".into(),
        }
    }

    #[test]
    fn every_tabled_route_is_a_route_and_only_the_contract_routes_are_exempt() {
        let mut seen = std::collections::HashSet::new();
        for (m, p, _) in GATE {
            assert!(crate::meet_routes::has_route(m, p), "{m} {p} is not a route of the main port");
            assert!(seen.insert((m, p)), "{m} {p} twice");
        }
        let exempt: Vec<(&str, &str)> = GATE.iter().filter(|(_, _, c)| *c == Class::Exempt).map(|(m, p, _)| (*m, *p)).collect();
        assert_eq!(
            exempt,
            vec![
                ("GET", "/healthz"),
                ("GET", "/v1/admin/console/requests"),
                ("GET", "/v1/crl"),
                ("GET", "/v1/relays"),
                ("GET", "/v1/admin/console/where"),
                ("GET", "/v1/admin/console/fleet-bootstrap"),
                ("POST", "/v1/admin/crl"),
                ("POST", "/v1/admin/revoke"),
                ("POST", "/v1/admin/console/invite"),
                ("POST", "/v1/admin/console/requests/decline"),
                // AI-1 contract 9 and AC-1 3.8: a device's answer to a console request, like requests/decline
                ("POST", "/v1/admin/console/requests/sign"),
                ("POST", "/v1/admin/console/fleet-endorse"),
            ]
        );
        let presence: Vec<&str> = GATE.iter().filter(|(_, _, c)| *c == Class::AdminPresence).map(|(_, p, _)| *p).collect();
        assert_eq!(presence, vec!["/v1/whoami", "/v1/events", "/v1/hello", "/v1/bye"]);
        assert!(GUEST_GATE.iter().all(|(_, _, c)| *c == Class::Service), "the guest port serves people only");
        assert_eq!(class_in(GATE, "POST", "/v1/not-a-route"), None);
    }

    /// Every route of both ports in one service state: `service` routes refused (or served), `exempt` ones always.
    fn every_route(g: &MeetGate, serving: bool, who: &Identity, what: &str) {
        let words = format!("license-inactive {LICENSE_INACTIVE}");
        for (m, p, c) in GATE {
            let want = if serving || *c == Class::Exempt { "ok".to_string() } else { words.clone() };
            assert_eq!(refused(g.admits(m, p, Some(who))), want, "{what}: {m} {p} ({c:?})");
        }
        for (m, p, _) in GUEST_GATE {
            let want = if serving { "ok".to_string() } else { words.clone() };
            assert_eq!(refused(g.admits_guest(m, p)), want, "{what}: guest {m} {p}");
        }
        // a route missing from the table is refused while stopped
        let want = if serving { "ok".to_string() } else { words.clone() };
        assert_eq!(refused(g.admits("POST", "/v1/not-a-route", Some(who))), want, "{what}: a missing route");
    }

    #[test]
    fn the_service_gate_in_every_license_state() {
        let v = products();
        let bob = device("bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        // valid, grace (a 2-day token one day past exp), expired past grace, none, wrong product, wrong root
        for (name, token_name, ca, serving, why) in [
            ("valid", Some("Meeting Hub, root A"), 2, true, None),
            ("grace", Some("Meeting Hub graceDays 2"), 2, true, None),
            ("expired", Some("Meeting Hub expired"), 2, false, Some("expired")),
            ("none", None, 2, false, Some("none")),
            ("wrong product", Some("Remote Spokes"), 2, false, Some("wrong-product")),
            ("wrong root", Some("Meeting Hub, root B"), 1, false, Some("wrong-root")),
        ] {
            let d = dir(&format!("state-{}", name.replace(' ', "-")));
            std::fs::write(d.join("client_ca.pem"), v["clientCas"][ca]["pem"].as_str().unwrap()).unwrap();
            if let Some(t) = token_name {
                std::fs::write(d.join(LICENSE_FILE), format!("{}\n", token(&v, t))).unwrap();
            }
            let h = hub(&d);
            seat(&h, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
            let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
            assert_eq!(g.service().serving(), serving, "{name}");
            assert_eq!(g.service_view().why, why, "{name}");
            // the verifier's words only for a refused file, never the token
            let reason = g.service_view().reason;
            assert_eq!(reason.is_some(), matches!(why, Some("wrong-product" | "wrong-root" | "invalid")), "{name}: {reason:?}");
            assert!(reason.as_deref().is_none_or(|r| !r.contains("eyJ") && !r.starts_with("This license")), "{name}");
            every_route(&g, serving, &bob, name);
        }
    }

    #[test]
    fn a_relay_admin_keeps_the_presence_session_the_exempt_routes_need() {
        let d = dir("admin-presence");
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        assert_eq!(g.service(), Service::Stopped, "a fresh install with no license has no period and no service");
        let admin = device("admin@x.org", "aaaaaaaaaaaaaaaa", "71");
        let other = device("bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        assert_eq!(refused(g.admits("POST", "/v1/hello", Some(&admin))), "ok");
        assert_eq!(refused(g.admits("POST", "/v1/admin/revoke", Some(&admin))), "ok");
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&admin))), format!("license-inactive {LICENSE_INACTIVE}"));
        assert_eq!(refused(g.admits("POST", "/v1/hello", Some(&other))), format!("license-inactive {LICENSE_INACTIVE}"));
        let seed = Identity { principal: "new@x.org".into(), seed: true, ..Default::default() };
        assert_eq!(refused(g.admits("POST", "/v1/enroll", Some(&seed))), format!("license-inactive {LICENSE_INACTIVE}"));
    }

    #[test]
    fn grace_is_at_most_two_days() {
        let v = products();
        let exp = 1_799_913_600_000;
        // tokens with graceDays 0, 1, 2, 14 and 30 stop at exp, exp + 1 day, and exp + 2 days for the last three
        for (i, (name, stops)) in [("Meeting Hub graceDays 0", exp), ("Meeting Hub graceDays 1", exp + DAY), ("Meeting Hub graceDays 2", exp + 2 * DAY), ("Meeting Hub in grace", exp + 2 * DAY), ("Meeting Hub graceDays 30", exp + 2 * DAY)].into_iter().enumerate() {
            let d = licensed_dir(&v, &format!("grace-{i}"));
            let c = FakeClock::new(exp - DAY);
            let g = MeetGate::open(cfg(&d), &hub(&d), c.clone()).unwrap();
            install(&g, &d, &token(&v, name));
            assert_eq!(g.service(), Service::On, "{name}");
            assert_eq!(g.service_view().stops_at, Some(stops), "{name}");
            // the console shows the honored value (2 for the 14 and 30 day tokens)
            assert_eq!(g.license().unwrap().0.effective_grace_days(), (stops - exp) / DAY, "{name}");
            c.run(stops - (exp - DAY) - 1000);
            g.check(true);
            assert!(g.service().serving(), "{name}: served until the stop");
            c.run(1000);
            g.check(true);
            assert_eq!(g.service(), Service::Stopped, "{name}: stopped at {stops}");
            assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&device("bob@x.org", "bbbbbbbbbbbbbbbb", "77")))), format!("license-inactive {LICENSE_INACTIVE}"));
        }
    }

    #[test]
    fn installing_serves_at_once_and_removing_the_file_stops_at_the_next_check() {
        let v = products();
        let d = licensed_dir(&v, "install-serve");
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        let bob = device("bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&bob))), format!("license-inactive {LICENSE_INACTIVE}"));
        install(&g, &d, &token(&v, "Meeting Hub, root A"));
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&bob))), "ok", "at once");
        std::fs::remove_file(d.join(LICENSE_FILE)).unwrap();
        g.check(true);
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&bob))), format!("license-inactive {LICENSE_INACTIVE}"));
    }

    #[test]
    fn no_growth_gate_code_remains() {
        // R42-1: a source scan of the Meeting Hub files
        let words = ["ever_seated", "everSeated", "last_users", "lastUsers", "meet.license.adding", "license-adding-off", "may_add", "check_add", "Adding::"];
        for (file, text) in [
            ("meet_license.rs", include_str!("meet_license.rs")),
            ("meet_seats.rs", include_str!("meet_seats.rs")),
            ("meet_routes.rs", include_str!("meet_routes.rs")),
            ("meet_hub.rs", include_str!("meet_hub.rs")),
            ("console_meet.rs", include_str!("console_meet.rs")),
            ("meet_console.rs", include_str!("meet_console.rs")),
        ] {
            // the code before each file's test module
            let code = text.find("\nmod tests {").map_or(text, |at| &text[..at]);
            for w in words {
                assert!(!code.contains(w), "{file} still names {w}");
            }
            assert!(!code.contains("Class::Adds") && !code.contains("Class::Serves"), "{file} still tags adds or serves");
        }
    }

    #[test]
    fn an_upgrade_from_before_ac1_serves_for_two_days_with_no_seat_limit_then_stops() {
        let d = dir("upgrade");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        let ends = g.upgrade().ends.unwrap();
        assert_eq!(ends, T0 / 1000 + 2 * 86_400);
        assert!(d.join(LICENSE_STATE_FILE).is_file(), "written before the first answer");
        assert_eq!(g.service(), Service::UpgradePeriod);
        let view = g.service_view();
        assert_eq!((view.stops_at, view.upgrade_period_ends, view.license_id), (Some(ends * 1000), Some(ends * 1000), None), "the reminders' inputs");
        every_route(&g, true, &device("p3@x.org", &format!("{:016x}", 3), "67"), "upgrade period");
        // no seat limit: many people, no clock
        for i in 0..30 {
            seat(&h, &format!("p{i}@x.org"), &format!("{i:016x}"), &format!("{:x}", 100 + i));
        }
        g.check(true);
        assert!(g.seats.lock().clock.is_none());
        drop(g);
        c.restart(DAY);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(g.upgrade().ends, Some(ends), "a restart keeps the same end");
        assert_eq!(g.service(), Service::UpgradePeriod);
        // the period runs out: service stops for everyone, and no one is unseated
        c.run(DAY);
        g.check(true);
        assert_eq!(g.service(), Service::Stopped);
        assert_eq!(g.upgrade().ends, None, "retired");
        assert_eq!(g.service_view().why, Some("none"));
        every_route(&g, false, &device("p3@x.org", &format!("{:016x}", 3), "67"), "after the period");
        c.run(20 * DAY);
        g.check(true);
        assert!(g.seats.lock().clock.is_none() && g.seats.lock().unseated.is_empty(), "no seat rule runs without a license");
        let seats = g.seats_view(&|_| String::new(), None);
        assert_eq!((seats["users"].clone(), seats["service"].clone()), (Value::Null, Value::from("stopped")), "seats.stopped");
    }

    #[test]
    fn while_stopped_the_seat_clock_does_not_count_and_no_one_is_unseated() {
        let v = products();
        let d = licensed_dir(&v, "stopped-seats");
        let c = FakeClock::new(T0);
        let h = hub(&d);
        // 21 people against a 20-user license
        for i in 0..21 {
            seat(&h, &format!("p{i}@x.org"), &format!("{i:016x}"), &format!("{:x}", 100 + i));
        }
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        install(&g, &d, &token(&v, "Meeting Hub, root B"));
        assert!(g.seats.lock().clock.is_some(), "one over starts the clock");
        c.run(3 * DAY);
        g.check(true);
        let day = |g: &MeetGate| g.seats.lock().day(g.time.seat_elapsed(), g.time.seat_day_ms());
        assert_eq!(day(&g), Some(3));
        // the license is removed: stopped; 12 days pass, and a restart after 10 hours down
        std::fs::remove_file(d.join(LICENSE_FILE)).unwrap();
        g.check(true);
        assert_eq!(g.service(), Service::Stopped);
        c.run(12 * DAY);
        g.check(true);
        assert_eq!(day(&g), Some(3), "the clock's days do not count while stopped");
        assert!(g.seats.lock().unseated.is_empty(), "no one is unseated");
        assert_eq!(g.seats.lock().clock.as_ref().map(|k| k.notices.len()), Some(1), "only the day 0 notice");
        assert_eq!(g.seat_counts().1, 0, "no seat limit while stopped");
        drop(g);
        c.restart(10 * 3_600_000);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(day(&g), Some(3), "a start while stopped credits no downtime");
        // a license installed after the stopped days finds the clock on the day it had
        install(&g, &d, &token(&v, "Meeting Hub, root B"));
        assert_eq!(day(&g), Some(3));
        c.run(11 * DAY);
        g.check(true);
        assert_eq!(g.seats.lock().unseated.len(), 1, "day 14 unseats the overage");
    }

    #[test]
    fn last_license_is_kept_for_the_install_comparison_only() {
        let v = products();
        let d = licensed_dir(&v, "lastlicense");
        let h = hub(&d);
        let c = FakeClock::new(T0);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(g.last_license(), None, "lastLicense null: any fitting license is a first license");
        install(&g, &d, &token(&v, "Meeting Hub, root A"));
        let last = g.last_license().unwrap();
        assert_eq!((last.product.as_str(), last.root.as_str(), last.id.as_str(), last.edition.as_str(), last.users, last.relays, last.exp), ("meet", "m_ce517b0ccdc38867dd717e1eb95fb88e", "l_00000000000000b1", "enterprise", 500, 2, 1831449600));
        // removed: stopped, lastLicense kept
        std::fs::remove_file(d.join(LICENSE_FILE)).unwrap();
        g.check(true);
        assert_eq!((g.service(), g.last_license()), (Service::Stopped, Some(last.clone())));
        // a second run: expired past grace, lastLicense kept
        install(&g, &d, &token(&v, "Meeting Hub, root A"));
        c.run(400 * DAY);
        g.check(true);
        assert_eq!((g.service(), g.last_license()), (Service::Stopped, Some(last)));
        assert_eq!(g.service_view().why, Some("expired"));
    }

    #[test]
    fn deleting_the_state_file_next_to_the_seats_gives_no_new_period() {
        let d = dir("deleted");
        old_state(&d);
        let h = hub(&d);
        drop(MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap());
        assert!(d.join(crate::meet_seats::SEATS_FILE).is_file());
        std::fs::remove_file(d.join(LICENSE_STATE_FILE)).unwrap();
        // a crash between the temporary write and the rename left only the temporary file: never a period
        std::fs::write(d.join("meet-license-state.json.tmp"), b"{\"firstStart\": 1, \"upgradePeriodEnds\": 99999999999}").unwrap();
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0 + 1000)).unwrap();
        assert_eq!(g.upgrade().ends, None);
        // R6-L1: recreated atomically as terminal, and the relay started
        let back: Value = serde_json::from_slice(&std::fs::read(d.join(LICENSE_STATE_FILE)).unwrap()).unwrap();
        assert_eq!(back["upgradePeriodEnds"], Value::Null);
        assert_eq!(back["retired"], "absent");
        drop(g);
        // a terminal file never gains a period
        std::fs::write(d.join(LICENSE_STATE_FILE), b"{\"firstStart\": 1, \"upgradePeriodEnds\": 99999999999, \"retired\": \"absent\"}").unwrap();
        assert!(MeetGate::open(cfg(&d), &h, FakeClock::new(T0 + 2000)).is_err());
    }

    // ── signed licenses: tests/license-v2-products.json (development-signed, test keys only) ──

    fn products() -> Value {
        let v: Value = serde_json::from_str(include_str!("../tests/license-v2-products.json")).unwrap();
        assert_eq!(v["now"].as_i64().unwrap() * 1000, T0, "the fixtures' clock");
        let _ = TEST_DEV_PUB.set(v["devPub"].as_str().unwrap().to_owned());
        v
    }

    fn token(v: &Value, name: &str) -> String {
        v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["token"].as_str().unwrap().to_owned()
    }

    /// A relay trusting both Meet roots (`clientCas` "two"), at the vectors' `now`.
    fn licensed_dir(v: &Value, name: &str) -> PathBuf {
        let d = dir(name);
        std::fs::write(d.join("client_ca.pem"), v["clientCas"][2]["pem"].as_str().unwrap()).unwrap();
        d
    }

    fn install(g: &MeetGate, d: &Path, tok: &str) {
        std::fs::write(d.join(LICENSE_FILE), format!("{tok}\n")).unwrap();
        g.installed();
    }

    #[test]
    fn a_fresh_folder_gets_a_terminal_file_and_absent_seats_or_time_beside_ac1_state_stop_the_start() {
        let d = dir("fresh");
        drop(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).unwrap());
        let back: Value = serde_json::from_slice(&std::fs::read(d.join(LICENSE_STATE_FILE)).unwrap()).unwrap();
        assert_eq!((back["upgradePeriodEnds"].clone(), back["retired"].clone()), (Value::Null, Value::from("absent")));
        std::fs::remove_file(d.join(crate::meet_seats::SEATS_FILE)).unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err(), "meet-seats.json missing beside AC-1 state");
        let d = dir("fresh-time");
        drop(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).unwrap());
        std::fs::remove_file(d.join(crate::meet_time::TIME_FILE)).unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err(), "meet-time.json missing beside AC-1 state");
    }

    #[test]
    fn an_audit_head_written_by_this_starts_deploy_apply_is_not_earlier_ac1_state() {
        // AC-2b-D 6.4: the apply before the listeners audits into a fresh folder before the gate opens
        let d = dir("deploy-audit");
        std::fs::write(d.join(AUDIT_HEAD), b"{}").unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err(), "an audit head alone is AC-1 state");
        let g = MeetGate::open(GateConfig { audit_by_deploy: true, ..cfg(&d) }, &hub(&d), FakeClock::new(T0)).unwrap();
        assert_eq!(g.upgrade().retired.as_deref(), Some("absent"));
        drop(g);
        // later starts find the gate's own files
        drop(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0 + 1000)).unwrap());
        // a relay from before AC-1 keeps its upgrade period when a deploy apply audited first
        let d = dir("deploy-audit-old");
        old_state(&d);
        std::fs::write(d.join(AUDIT_HEAD), b"{}").unwrap();
        let g = MeetGate::open(GateConfig { audit_by_deploy: true, ..cfg(&d) }, &hub(&d), FakeClock::new(T0)).unwrap();
        assert!(g.upgrade().ends.is_some());
    }

    #[test]
    fn an_unreadable_state_file_stops_the_start() {
        let d = dir("unreadable");
        std::fs::write(d.join(LICENSE_STATE_FILE), b"{\"firstStart\": 1}").unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err());
        let d = dir("unreadable-seats");
        std::fs::write(d.join(crate::meet_seats::SEATS_FILE), b"[]").unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err());
    }

    #[test]
    fn a_forward_jump_stops_service_early_and_moving_the_clock_back_extends_nothing() {
        let d = dir("jump");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        c.run(DAY);
        c.shift_wall(2 * DAY);
        g.check(true);
        assert_eq!(g.service(), Service::Stopped, "a forward jump can stop service early");
        c.shift_wall(-10 * DAY);
        g.check(true);
        assert_eq!(g.service(), Service::Stopped, "moving the clock back extends nothing");
        assert!(g.time.view().back);
    }

    /// R7-M1: the host clock moved back and then confirmed (`meet.clock.confirm` with an agreeing browser), while
    /// running and across a restart, never brings service back or lengthens it: before expiry, during grace and
    /// during the upgrade period.
    #[test]
    fn a_confirmed_rollback_never_extends_expiry_grace_or_the_upgrade_period() {
        let v = products();
        let exp = 1_799_913_600_000;
        // (what, the token, the start, the stop)
        for (what, tok, start, stop) in [
            ("before expiry", Some("Meeting Hub graceDays 0"), exp - DAY, exp),
            ("during grace", Some("Meeting Hub graceDays 2"), exp + DAY, exp + 2 * DAY),
            ("upgrade period", None, T0, T0 + 2 * DAY),
        ] {
            for restart in [false, true] {
                let d = licensed_dir(&v, &format!("rollback-{}-{restart}", what.replace(' ', "-")));
                if tok.is_none() {
                    old_state(&d);
                }
                let c = FakeClock::new(start);
                let h = hub(&d);
                let mut g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
                if let Some(t) = tok {
                    install(&g, &d, &token(&v, t));
                }
                assert!(g.service().serving(), "{what}");
                // run to the stop
                c.run(stop - start);
                g.check(true);
                assert_eq!(g.service(), Service::Stopped, "{what}: stopped at the end");
                // the host clock is set back 3 days
                c.shift_wall(-3 * DAY);
                if restart {
                    drop(g);
                    c.restart(1000);
                    g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
                }
                g.check(true);
                assert_eq!(g.service(), Service::Stopped, "{what}: a rollback extends nothing (restart {restart})");
                // an admin confirms the rolled back time with an agreeing browser
                g.confirm_clock(c.wall_ms()).unwrap();
                assert_eq!(g.service(), Service::Stopped, "{what}: a confirmation never lowers the license clock (restart {restart})");
                assert!(g.time.now() >= stop, "{what}: the effective time stays at or past the stop");
            }
        }
    }

    /// Records audit entries as (actor, action, detail).
    struct Recorder(Mutex<Vec<(String, String, Value)>>);

    impl crate::meet_hub::ConsoleHooks for Recorder {
        fn revoked(&self, _serials: &[String]) {}
        fn observed(&self, _kind: &str, _target: &crate::meet_json::Obj, _by: &str, _link: Option<&str>) {}
        fn audit(&self, action: &str, _target: &str, detail: Value) {
            self.0.lock().push(("relay".into(), action.into(), detail));
        }
        fn audit_operator(&self, action: &str, _target: &str, detail: Value) {
            self.0.lock().push(("operator".into(), action.into(), detail));
        }
    }

    /// R7-M1: the offline `license-time reset` is audited once at the next start (actor operator, {before, after}),
    /// and a start after a reset that gave back grace serves again only by the host clock.
    #[test]
    fn an_offline_license_time_reset_is_audited_once_at_the_next_start() {
        let d = dir("time-reset");
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let rec = Arc::new(Recorder(Mutex::new(Vec::new())));
        h.set_console_hooks(rec.clone());
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        c.shift_wall(3 * DAY);
        g.check(true);
        g.time.save().unwrap();
        let high = crate::meet_time::stored_high_water(&d).unwrap();
        assert!(high >= T0 + 3 * DAY);
        drop(g);
        c.shift_wall(-3 * DAY);
        let wall = c.wall_ms();
        assert_eq!(crate::meet_time::reset_offline(&d, wall), Ok((high, wall)));
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        let resets: Vec<(String, String, Value)> = rec.0.lock().iter().filter(|(_, a, _)| a == "license.time-reset").cloned().collect();
        assert_eq!(resets, vec![("operator".to_string(), "license.time-reset".to_string(), json!({"before": high, "after": wall}))]);
        assert!(g.time.now() < high, "the license clock runs from the host clock again");
        drop(g);
        // a later start audits nothing again
        let _g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(rec.0.lock().iter().filter(|(_, a, _)| a == "license.time-reset").count(), 1);
    }

    #[test]
    fn the_short_first_license_rule_keeps_or_retires_the_period() {
        let d = dir("short");
        old_state(&d);
        let g = MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).unwrap();
        let ends = g.upgrade().ends.unwrap();
        assert!(g.keeps_period(ends - 1), "a license ending first keeps the period as a fallback");
        assert!(!g.keeps_period(ends), "a license lasting to the end retires it");
    }

    #[test]
    fn an_unseated_or_held_device_gets_no_seat() {
        // while service runs (here the upgrade period)
        let d = dir("noseat");
        old_state(&d);
        let h = hub(&d);
        seat(&h, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        g.seats.lock().unseated.push(crate::meet_seats::Unseated { principal: "bob@x.org".into(), at: T0, why: "newest".into() });
        let bob = device("bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&bob))), format!("no-seat {NO_SEAT}"));
        g.seats.lock().unseated.clear();
        g.seats.lock().held.push(("bob@x.org".into(), T0));
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&bob))), format!("no-seat {NO_SEAT}"));
    }
}
