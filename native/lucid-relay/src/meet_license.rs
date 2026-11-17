// The Meeting Hub relay's growth gate (contract AC-1 2.4, 4.10; R41-1 replacing R4-1's service gate, R3-M4,
// decisions 39, 55 and 56; I13).
//
// - The license: relay.json `license` (a path), else `state_dir/license.lic`, re-read at every check so installing
//   a fitting license opens adding at once and removing the file closes it at the next check. A malformed or
//   wrong-root file is logged (`license.refused`) and the relay runs unlicensed.
// - The license limits growth, never service: in every license state every seated person is served on every route.
//   Adding is open with a fitting license in valid or grace, or during the upgrade period; otherwise it is closed and
//   every action that would seat a **new principal** (one of whom the relay knows no device that is not revoked) is
//   refused with 403 `license-inactive`. The gate table names every main-port route `adds` (may seat a principal:
//   the route checks the principal it would seat through `may_add`) or `serves`; a route missing from it is treated
//   as `adds`. The backstop: a never-seen device (or seed) of a new principal is refused at its first request and
//   never counted, however its certificate was issued. Unseated and held people get 403 `no-seat`.
// - The upgrade period: `state_dir/meet-license-state.json` `{firstStart, upgradePeriodEnds}` (seconds; ends null
//   when there is no period or the period is retired), written at the first start of this version before anything
//   is answered, never reset by a restart. During it adding is open with no seat limit. A license does not use the
//   period up (R3-M4): it is retired only when an installed license's grace end is at or after `upgradePeriodEnds`,
//   or when the period runs out.
// - Seats (meet_seats.rs) follow the limit: the fitting license's `users`, else `lastUsers`, else none (a relay
//   that never had a license unseats no one). Every deadline is judged in trusted time (meet_time.rs).

use crate::license::{license_keys, license_standing, license_token_of, meet_roots, verify_meet_license, License, LicenseStanding, LicenseStateName};
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
/// 8.1 `meet.license-inactive`, 8.3 `license-inactive` (R41-1).
pub const LICENSE_INACTIVE: &str = "Your organization's Meeting Hub license is not active, so no one new can be added. Ask your admin.";
pub const NO_LICENSE: &str = "This relay has no Meeting Hub license.";
pub const UPGRADE_DAYS: i64 = 30;
/// The upgrade-period mails go out on these days of the period.
pub const UPGRADE_MAIL_DAYS: [i64; 3] = [0, 23, 29];
/// The AC-1 state files: any of them next to a missing meet-license-state.json means no upgrade period.
const AC1_FILES: [&str; 4] = [LICENSE_STATE_FILE, crate::meet_seats::SEATS_FILE, "console.json", "console-audit-head.json"];
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

/// A main-port route's place in the gate table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// May seat a principal: the route checks the principal it would seat (`may_add`).
    Adds,
    /// Never seats anyone.
    Serves,
}

use Class::{Adds as A, Serves as S};

/// The gate table (2.4, R41-1): every route of the main port. The guest port does not consult the license.
pub static GATE: &[(&str, &str, Class)] = &[
    // GET
    ("GET", "/healthz", S),
    ("GET", "/v1/admin/console/requests", S),
    ("GET", "/v1/crl", S),
    ("GET", "/v1/whoami", S),
    ("GET", "/v1/events", S),
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
    ("GET", "/v1/apps", S),
    ("GET", "/v1/apps/icon", S),
    ("GET", "/v1/apps/c/events", S),
    ("GET", "/v1/admin/holds", S),
    ("GET", "/v1/sso/asks", S),
    ("GET", "/v1/docs/history", S),
    ("GET", "/v1/docs/list", S),
    // POST: the routes that can seat a principal
    ("POST", "/v1/enroll", A),
    ("POST", "/v1/admin/approve", A),
    ("POST", "/v1/admin/enrolled", A),
    ("POST", "/v1/admin/seeded", A),
    ("POST", "/v1/admin/invite", A),
    ("POST", "/v1/admin/organizations", A),
    ("POST", "/v1/devices/add", A),
    ("POST", "/v1/sso/answer", A),
    ("POST", "/v1/sso/c/sign", A),
    ("POST", "/v1/sso/c/org-member", A),
    ("POST", "/v1/sso/c/pending-add", A),
    // POST: everything else
    ("POST", "/v1/admin/crl", S),
    ("POST", "/v1/admin/revoke", S),
    ("POST", "/v1/admin/console/invite", S),
    ("POST", "/v1/admin/console/requests/decline", S),
    ("POST", "/v1/hello", S),
    ("POST", "/v1/bye", S),
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
    ("POST", "/v1/apps/icon", S),
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

/// The route's class; a route missing from the table is treated as `adds` (dispatch: `admits`).
#[cfg(test)]
pub fn class_of(method: &str, path: &str) -> Class {
    GATE.iter().find(|(m, p, _)| *m == method && *p == path).map(|(_, _, c)| *c).unwrap_or(Class::Adds)
}

/// The 403 `license-inactive` refusal of an add-people action (main port shape: `code` and words).
pub fn inactive() -> E {
    E::Held(LICENSE_INACTIVE.into(), obj([("code", Value::from("license-inactive"))]))
}

fn no_seat() -> E {
    E::Held(NO_SEAT.into(), obj([("code", Value::from("no-seat"))]))
}

/// Whether people can be added (I13 `adding()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adding {
    /// A fitting license in valid or grace.
    Open,
    /// The upgrade period with no fitting license in force: open, with no seat limit.
    UpgradePeriod,
    Closed,
}

impl Adding {
    pub fn as_str(self) -> &'static str {
        match self {
            Adding::Open => "open",
            Adding::UpgradePeriod => "upgrade-period",
            Adding::Closed => "closed",
        }
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
    if AC1_FILES.iter().any(|f| dir.join(f).exists()) {
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
    pub adding: Adding,
}

/// Where the gate reads its files.
pub struct GateConfig {
    pub state_dir: Option<PathBuf>,
    /// relay.json `license`, else state_dir/license.lic.
    pub license_file: Option<PathBuf>,
    pub client_ca: PathBuf,
}

/// The growth gate, the upgrade period and the seats of one Meet relay (I13).
pub struct MeetGate {
    cfg: GateConfig,
    hub: Weak<Hub>,
    pub time: TrustedTime,
    licensed: Mutex<Option<Licensed>>,
    problem: Mutex<String>,
    upgrade: Mutex<Upgrade>,
    seats: Mutex<Seats>,
    adding: Mutex<Option<Adding>>,
    checked: Mutex<Option<i64>>,
    logged: Mutex<HashMap<String, i64>>,
    /// Audit entries made before the console's hooks are installed (the first start writes before it answers).
    pending: Mutex<Vec<(String, String, Value)>>,
    upgrade_mailed: Mutex<Vec<i64>>,
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
        let before = dir.as_deref().map(from_before_ac1).unwrap_or(false);
        // R6-L1: an absent meet-seats.json or meet-time.json next to other AC-1 state stops the start (recreating them
        // would forget the seat clock, lastUsers, lastLicense, everSeated or the high-water mark)
        if let Some(d) = dir.as_deref() {
            let has = |f: &str| d.join(f).exists();
            let others = |skip: &str| [LICENSE_STATE_FILE, crate::meet_seats::SEATS_FILE, crate::meet_time::TIME_FILE, "console.json", "console-audit-head.json"].iter().any(|f| *f != skip && has(f));
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
                let s = Seats::migrate(dir.as_deref(), &records, &hub.holders(), t);
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
            adding: Mutex::new(None),
            checked: Mutex::new(None),
            logged: Mutex::new(HashMap::new()),
            pending: Mutex::new(pending),
            upgrade_mailed: Mutex::new(Vec::new()),
            protected_short: Mutex::new(false),
            clock_mailed: Mutex::new(None),
        });
        // a start with a protected principal unseated repairs it (R3-M6); `lastUsers` and the seat clock are written
        // before the first answer
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

    /// Whether this principal was ever seated on this relay (`everSeated`, R6-M2); one that never was is new.
    pub fn ever_seated(&self, principal: &str) -> bool {
        self.seats.lock().ever_seated.contains(&principal.trim().to_lowercase())
    }

    /// `lastUsers` (R41-1): the last fitting license's `users`, None for a relay that never had one.
    pub fn last_users(&self) -> Option<i64> {
        self.seats.lock().last_users
    }

    /// Where the gate stands at effective time `t` (milliseconds).
    pub fn standing_at(&self, t: i64) -> Standing {
        let license = license_standing(self.licensed.lock().as_ref().map(|l| &l.license), t.div_euclid(1000));
        let active = matches!(license.state, Some(LicenseStateName::Valid | LicenseStateName::Grace));
        let period = self.upgrade.lock().ends.is_some_and(|e| t.div_euclid(1000) < e);
        let adding = if active {
            Adding::Open
        } else if period {
            Adding::UpgradePeriod
        } else {
            Adding::Closed
        };
        Standing { license, active, period, adding }
    }

    pub fn standing(&self) -> Standing {
        self.standing_at(self.time.now())
    }

    /// I13 `adding()`.
    pub fn adding(&self) -> Adding {
        self.standing().adding
    }

    /// I13 `may_add(principal)`: false only while adding is closed and the principal is new (the relay knows no
    /// device of theirs that is not revoked).
    pub fn may_add(&self, principal: &str) -> bool {
        if self.adding() != Adding::Closed {
            return true;
        }
        self.ever_seated(principal)
    }

    /// The relay-side refusal of an add-people action for `principal` (enrollment approval, invite, organization
    /// change, SSO provisioning): Ok, or 403 `license-inactive`, logged at most once per principal an hour.
    pub fn check_add(&self, principal: &str) -> Result<(), E> {
        self.check(false);
        if self.may_add(principal) {
            return Ok(());
        }
        self.log_refused(principal);
        Err(inactive())
    }

    /// The limit the seat rules use now: the fitting license's `users`, else `lastUsers` (none during the upgrade
    /// period without a license, and none for a relay that never had a license).
    fn limit_of(&self, s: &Standing) -> Option<i64> {
        if s.period && !s.active {
            None
        } else {
            self.seats.lock().limit(s.active.then_some(s.license.users))
        }
    }

    /// The periodic check: the license file, the upgrade period (retirement and mails), the gate's audit on change,
    /// `lastUsers` and the seats. `force` skips the 10-second spacing.
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
        // R41-1: a fitting license in valid or grace writes its `users` into `lastUsers` before anything is answered
        if s.active {
            let mut seats = self.seats.lock();
            let record = self.licensed.lock().as_ref().map(|l| crate::meet_seats::LastLicense::of(&l.license));
            if seats.last_users != Some(s.license.users) || seats.last_license != record {
                // R41-1 and R6-M1: `lastUsers` and `lastLicense` in one write
                seats.last_users = Some(s.license.users);
                seats.last_license = record;
                if let Err(e) = seats.save() {
                    crate::meet::log_error(&e);
                }
            }
        }
        let open = s.adding != Adding::Closed;
        let changed = {
            let mut last = self.adding.lock();
            let changed = last.is_some_and(|l| (l != Adding::Closed) != open);
            *last = Some(s.adding);
            changed
        };
        if changed {
            let why = if s.active { "license" } else if s.period { "upgrade-period" } else { s.license.state_str() };
            self.audit("meet.license.adding", "-", json!({"state": if open { "open" } else { "closed" }, "why": why, "lastUsers": self.last_users()}));
        }
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
            return;
        }
        let day = (now_s - u.first_start).max(0) / 86_400;
        drop(u);
        let mut mailed = self.upgrade_mailed.lock();
        let latest = UPGRADE_MAIL_DAYS.iter().copied().filter(|d| *d <= day).max();
        for d in UPGRADE_MAIL_DAYS {
            if day >= d && !mailed.contains(&d) {
                mailed.push(d);
                // after a restart late in the period only the latest due mail goes out
                if Some(d) != latest {
                    continue;
                }
                let date = crate::meet_json::iso_date(ends);
                for to in self.admin_emails() {
                    self.mail("mail.upgrade-period", &to, &[("date", date.clone())]);
                }
            }
        }
    }

    fn seats_tick(&self, t: i64, s: &Standing) {
        let Some(hub) = self.hub.upgrade() else { return };
        let live = hub.seat_live(t.div_euclid(1000));
        let protected = |p: &str| self.protected(p);
        let view = self.time.view();
        let limit = self.limit_of(s);
        let from = if s.active { "license" } else { "lastUsers" };
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
                Event::ClockStart { .. } => self.audit("meet.seats.clock", "-", json!({"state": "start", "seated": seated, "users": users, "limit": from})),
                Event::ClockClear => self.audit("meet.seats.clock", "-", json!({"state": "clear", "seated": seated, "users": users, "limit": from})),
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

    /// The gate at main-port dispatch (2.4, 4.10): Ok to go on, 403 `no-seat` to an unseated or held person's
    /// device, or 403 `license-inactive` while adding is closed for a new principal's never-seen device or seed (the
    /// backstop) and for a route missing from the table called by anyone the relay does not hold. Seated people are
    /// served on every route in every license state.
    pub fn admits(&self, method: &str, path: &str, who: Option<&Identity>) -> Result<(), E> {
        let fresh = who.is_some_and(|w| (person(w) || w.seed) && !self.seats.lock().first_seen.contains_key(&w.principal));
        self.check(fresh);
        if let Some(w) = who.filter(|w| person(w)) {
            let seats = self.seats.lock();
            if seats.is_unseated(&w.principal) || seats.is_held(&w.principal) {
                return Err(no_seat());
            }
        }
        // /healthz names no one and seats no one: it answers anyone, as on the Python reference relay
        if self.adding() != Adding::Closed || (method == "GET" && path == "/healthz") {
            return Ok(());
        }
        let held = |w: &Identity| self.ever_seated(&w.principal);
        // the backstop: however its certificate was issued, a new principal's device never gets in while adding is
        // closed (and is never counted, since nothing past this point sees it)
        if let Some(w) = who.filter(|w| person(w) || w.seed) {
            if !held(w) {
                self.log_refused(&w.principal);
                return Err(inactive());
            }
        }
        if GATE.iter().all(|(m, p, _)| !(*m == method && *p == path)) && !who.is_some_and(held) {
            self.log_refused(who.map(|w| w.principal.as_str()).unwrap_or_default());
            return Err(inactive());
        }
        Ok(())
    }

    fn log_refused(&self, principal: &str) {
        let t = self.time.now();
        let mut logged = self.logged.lock();
        if logged.get(principal).is_some_and(|at| t - at < GATE_LOG_MS) {
            return;
        }
        if logged.len() > 10_000 {
            logged.clear();
        }
        logged.insert(principal.to_owned(), t);
        crate::meet::log_warn(&format!("meet.license-gate category=security principal={}", crate::meet::kv(principal)));
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

    /// 4.7 `adding` (Meeting Hub only): `{state, upgradePeriodEnds, lastUsers}`.
    pub fn adding_view(&self) -> Value {
        json!({"state": self.adding().as_str(), "upgradePeriodEnds": self.upgrade().ends.map(|e| e * 1000), "lastUsers": self.last_users()})
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

    /// GET meet/seats (4.9): `users` is the limit in force (`limitFrom` says which: "license", "lastUsers", or null
    /// with no limit, the Seats page then showing `seats.no-license`).
    pub fn seats_view(&self, names: &dyn Fn(&str) -> String, request_to: Option<String>) -> Value {
        self.check(false);
        let Some(hub) = self.hub.upgrade() else { return Value::Null };
        let t = self.time.now();
        let s = self.standing_at(t);
        let limit = self.limit_of(&s);
        let limit_from = match (s.active, limit) {
            (true, _) => Value::from("license"),
            (false, Some(_)) => Value::from("lastUsers"),
            (false, None) => Value::Null,
        };
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
            "limitFrom": limit_from, "lastUsers": seats.last_users, "adding": s.adding.as_str(), "upgradePeriodEnds": self.upgrade().ends.map(|e| e * 1000),
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
        let mut out = Vec::new();
        let t = self.time.now();
        let s = self.standing_at(t);
        match s.adding {
            Adding::UpgradePeriod => {
                let date = self.upgrade.lock().ends.map(crate::meet_json::iso_date).unwrap_or_default();
                out.push(with_banner(item("license-upgrade-period", "warn", json!({"date": date}), "#/license"), "banner.upgrade-period"));
            }
            Adding::Closed => out.push(with_banner(item("license-adding-off", "bad", json!({}), "#/license"), "banner.license-inactive")),
            Adding::Open => {}
        }
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
        GateConfig { state_dir: Some(d.to_path_buf()), license_file: Some(d.join(LICENSE_FILE)), client_ca: d.join("client_ca.pem") }
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
    fn every_tabled_route_is_a_main_port_route_and_a_missing_one_is_treated_as_adds() {
        let mut seen = std::collections::HashSet::new();
        for (m, p, _) in GATE {
            assert!(crate::meet_routes::has_route(m, p), "{m} {p} is not a route of the main port");
            assert!(seen.insert((m, p)), "{m} {p} twice");
        }
        assert_eq!(class_of("POST", "/v1/not-a-route"), Class::Adds);
        for p in ["/v1/enroll", "/v1/admin/approve", "/v1/admin/invite", "/v1/admin/organizations", "/v1/sso/answer", "/v1/sso/c/sign"] {
            assert_eq!(class_of("POST", p), Class::Adds, "{p}");
        }
        // while adding is closed: a missing route is refused for anyone the relay does not hold, served to a seated person
        let d = dir("missing");
        let h = hub(&d);
        seat(&h, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        assert_eq!(refused(g.admits("POST", "/v1/not-a-route", None)), format!("license-inactive {LICENSE_INACTIVE}"));
        assert_eq!(refused(g.admits("POST", "/v1/not-a-route", Some(&device("bob@x.org", "bbbbbbbbbbbbbbbb", "77")))), "ok");
    }

    #[test]
    fn with_adding_closed_a_seated_person_is_served_on_every_route() {
        let d = dir("seated");
        let h = hub(&d);
        seat(&h, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        assert_eq!(g.adding(), Adding::Closed, "a fresh install with no license has no period");
        let bob = device("bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        for (m, p, _) in GATE {
            assert_eq!(refused(g.admits(m, p, Some(&bob))), "ok", "{m} {p}");
        }
        // a seated person's new device and seed are served too (their own devices within the caps)
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&device("bob@x.org", "cccccccccccccccc", "78")))), "ok");
        let seed = Identity { principal: "bob@x.org".into(), seed: true, ..Default::default() };
        assert_eq!(refused(g.admits("POST", "/v1/enroll", Some(&seed))), "ok");
        assert!(g.may_add("bob@x.org"));
    }

    #[test]
    fn with_adding_closed_a_new_principal_is_refused_from_every_path() {
        let d = dir("new");
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        let words = format!("license-inactive {LICENSE_INACTIVE}");
        // an enrollment request (its seed), a never-seen device however its certificate was issued, a relay admin's too
        let seed = Identity { principal: "new@x.org".into(), seed: true, ..Default::default() };
        assert_eq!(refused(g.admits("POST", "/v1/enroll", Some(&seed))), words);
        assert_eq!(refused(g.admits("POST", "/v1/hello", Some(&device("new@x.org", "dddddddddddddddd", "99")))), words);
        assert_eq!(refused(g.admits("POST", "/v1/hello", Some(&device("admin@x.org", "eeeeeeeeeeeeeeee", "98")))), words);
        assert!(h.seat_live(T0 / 1000).is_empty(), "never counted");
        // approval, invite, organization change and SSO answer for a new principal
        assert_eq!(refused(g.check_add("new@x.org")), words);
    }

    #[test]
    fn a_person_whose_every_device_was_revoked_keeps_their_admission() {
        // R6-M2: revoking a seated person's sole device frees the seat but keeps them in everSeated
        let d = dir("revoked");
        let c = FakeClock::new(T0);
        let h = hub(&d);
        seat(&h, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(g.adding(), Adding::Closed);
        assert!(g.ever_seated("bob@x.org"));
        h.st.lock().denied.insert("77".into(), json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb"}));
        assert!(h.seat_live(T0 / 1000).is_empty(), "the seated count falls at once");
        g.check(true);
        assert!(g.may_add("bob@x.org"), "still admitted");
        // their replacement enrollment (seed) and its device get in while adding is closed
        let seed = Identity { principal: "bob@x.org".into(), seed: true, ..Default::default() };
        assert_eq!(refused(g.admits("POST", "/v1/enroll", Some(&seed))), "ok");
        assert_eq!(refused(g.admits("POST", "/v1/hello", Some(&device("bob@x.org", "cccccccccccccccc", "78")))), "ok");
        // a principal never seen here is still refused
        assert_eq!(refused(g.check_add("stranger@x.org")), format!("license-inactive {LICENSE_INACTIVE}"));
        // everSeated survives a restart and an unseat
        g.seats.lock().unseated.push(crate::meet_seats::Unseated { principal: "bob@x.org".into(), at: T0, why: "newest".into() });
        g.seats.lock().save().unwrap();
        drop(g);
        c.restart(1000);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert!(g.ever_seated("bob@x.org"));
    }

    #[test]
    fn an_upgrade_from_before_ac1_opens_adding_for_thirty_days_with_no_seat_limit() {
        let d = dir("upgrade");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        let ends = g.upgrade().ends.unwrap();
        assert_eq!(ends, T0 / 1000 + 30 * 86_400);
        assert!(d.join(LICENSE_STATE_FILE).is_file(), "written before the first answer");
        assert_eq!(g.adding(), Adding::UpgradePeriod);
        assert!(g.may_add("new@x.org"));
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
        // the period runs out: adding closes, seated people keep their service, no one is unseated (never licensed)
        c.run(30 * DAY);
        g.check(true);
        assert_eq!(g.adding(), Adding::Closed);
        assert_eq!(g.upgrade().ends, None, "retired");
        assert_eq!(refused(g.admits("POST", "/v1/dm", Some(&device("p3@x.org", &format!("{:016x}", 3), "67")))), "ok");
        assert!(!g.may_add("new@x.org"));
        c.run(20 * DAY);
        g.check(true);
        assert!(g.seats.lock().clock.is_none() && g.seats.lock().unseated.is_empty(), "a never-licensed relay unseats no one");
        assert_eq!(g.seats_view(&|_| String::new(), None)["limitFrom"], Value::Null, "seats.no-license");
    }

    #[test]
    fn last_users_keeps_the_seat_rules_after_the_license_ends() {
        let d = dir("lastusers");
        let c = FakeClock::new(T0);
        let h = hub(&d);
        for i in 0..4 {
            seat(&h, &format!("p{i}@x.org"), &format!("{i:016x}"), &format!("{:x}", 100 + i));
        }
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        // as a license of 3 users once wrote it; the license is gone now
        g.seats.lock().last_users = Some(3);
        g.check(true);
        assert!(g.seats.lock().clock.is_some(), "one over lastUsers starts the clock");
        assert_eq!(g.seat_counts(), (4, 3));
        assert_eq!(g.seats_view(&|_| String::new(), None)["limitFrom"], "lastUsers");
        c.run(14 * DAY);
        g.check(true);
        assert_eq!(g.seats.lock().unseated.len(), 1, "day 14 unseats the overage against lastUsers");
        assert!(!g.may_add("p9@x.org"), "and nobody new is added");
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
    fn installing_a_fitting_license_opens_adding_at_once_and_writes_last_users_and_last_license() {
        let v = products();
        assert_eq!(v["now"].as_i64().unwrap() * 1000, T0, "the fixtures' clock");
        let d = licensed_dir(&v, "install");
        let h = hub(&d);
        let c = FakeClock::new(T0);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(g.adding(), Adding::Closed);
        assert_eq!((g.last_users(), g.last_license()), (None, None), "lastLicense null: any fitting license is a first license");
        install(&g, &d, &token(&v, "Meeting Hub, root A"));
        assert_eq!(g.adding(), Adding::Open, "at once");
        assert!(g.may_add("new@x.org"));
        assert_eq!(g.last_users(), Some(500));
        let last = g.last_license().unwrap();
        assert_eq!((last.product.as_str(), last.root.as_str(), last.id.as_str(), last.edition.as_str(), last.users, last.relays, last.exp), ("meet", "m_76eb5ad60ebd0f7e5b1aed0f77f107af", "l_00000000000000b1", "enterprise", 500, 2, 1831449600));
        // removing the file closes adding at the next check and keeps both records
        std::fs::remove_file(d.join(LICENSE_FILE)).unwrap();
        g.check(true);
        assert_eq!(g.adding(), Adding::Closed);
        assert_eq!(g.last_users(), Some(500));
        assert_eq!(g.last_license(), Some(last.clone()));
        // a smaller license (20 users, root B) lowers lastUsers; a larger one raises it again
        install(&g, &d, &token(&v, "Meeting Hub, root B"));
        assert_eq!(g.last_users(), Some(20));
        install(&g, &d, &token(&v, "Meeting Hub, root A"));
        assert_eq!(g.last_users(), Some(500));
        // a second run: the license expires past grace; lastUsers and lastLicense stay, adding closes
        c.run(400 * DAY);
        g.check(true);
        assert_eq!(g.adding(), Adding::Closed);
        assert_eq!((g.last_users(), g.last_license()), (Some(500), Some(last)));
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
    fn an_unreadable_state_file_stops_the_start() {
        let d = dir("unreadable");
        std::fs::write(d.join(LICENSE_STATE_FILE), b"{\"firstStart\": 1}").unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err());
        let d = dir("unreadable-seats");
        std::fs::write(d.join(crate::meet_seats::SEATS_FILE), b"[]").unwrap();
        assert!(MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).is_err());
    }

    #[test]
    fn a_forward_jump_closes_adding_early_and_moving_the_clock_back_extends_nothing() {
        let d = dir("jump");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        c.run(29 * DAY);
        c.shift_wall(2 * DAY);
        g.check(true);
        assert_eq!(g.adding(), Adding::Closed, "a forward jump can close adding early");
        c.shift_wall(-10 * DAY);
        g.check(true);
        assert_eq!(g.adding(), Adding::Closed, "moving the clock back extends nothing");
        assert!(g.time.view().back);
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
        let d = dir("noseat");
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
