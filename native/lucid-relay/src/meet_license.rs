// The Meeting Hub relay's service gate (contract AC-1 2.4, 4.10; R4-1, R3-M4, decisions 27 and 39; I13).
//
// - The license: relay.json `license` (a path), else `state_dir/license.lic`, re-read at every check so installing
//   a fitting license turns service on at once and removing the file stops it at the next check. A malformed or
//   wrong-root file is logged (`license.refused`) and the relay runs unlicensed.
// - The gate table names every main-port and guest-port route as `service`, `exempt`, or `admin` (exempt for a
//   relay admin's own presence session, `service` for anyone else). A route missing from it is refused. While the
//   license is not valid or in grace and no upgrade period runs, every `service` route answers 403
//   `license-inactive`; an unseated principal's devices get 403 `no-seat`.
// - The upgrade period: `state_dir/meet-license-state.json` `{firstStart, upgradePeriodEnds}` (seconds; ends null
//   when there is no period or the period is retired), written at the first start of this version before anything
//   is answered, never reset by a restart. A license does not use the period up (R3-M4): it is retired only when an
//   installed license's grace end is at or after `upgradePeriodEnds`, or when the period runs out.
// - Every deadline is judged in trusted time (meet_time.rs); seats are meet_seats.rs, driven from here.

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
/// 8.1 `meet.license-inactive`, 8.3 `license-inactive`.
pub const LICENSE_INACTIVE: &str = "Your organization's Meeting Hub license is not active. Ask your admin.";
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

/// A route's place in the gate table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// People's service: refused while the license is not active (and no upgrade period runs), and to unseated people.
    Service,
    /// Served in every state.
    Exempt,
    /// The presence session a relay admin needs for the exempt routes: exempt for a relay admin, service otherwise.
    Admin,
}

use Class::{Admin as A, Exempt as X, Service as S};

/// The gate table (2.4): every route of the main port (`/v1/...`, `/healthz`) and the guest port (`/g...`).
pub static GATE: &[(&str, &str, Class)] = &[
    // main port, GET
    ("GET", "/healthz", X),
    ("GET", "/v1/admin/console/requests", X),
    ("GET", "/v1/crl", X),
    ("GET", "/v1/whoami", A),
    ("GET", "/v1/events", A),
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
    // main port, POST
    ("POST", "/v1/admin/crl", X),
    ("POST", "/v1/admin/revoke", X),
    ("POST", "/v1/admin/console/invite", X),
    ("POST", "/v1/admin/console/requests/decline", X),
    ("POST", "/v1/hello", A),
    ("POST", "/v1/bye", A),
    ("POST", "/v1/join", S),
    ("POST", "/v1/signal", S),
    ("POST", "/v1/link", S),
    ("POST", "/v1/chat", S),
    ("POST", "/v1/chat/edit", S),
    ("POST", "/v1/chat/delete", S),
    ("POST", "/v1/typing", S),
    ("POST", "/v1/stage", S),
    ("POST", "/v1/status", S),
    ("POST", "/v1/admin/organizations", S),
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
    ("POST", "/v1/enroll", S),
    ("POST", "/v1/admin/enrolled", S),
    ("POST", "/v1/devices/add", S),
    ("POST", "/v1/admin/seeded", S),
    ("POST", "/v1/admin/ca", S),
    ("POST", "/v1/admin/approve", S),
    ("POST", "/v1/admin/invite", S),
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
    ("POST", "/v1/sso/answer", S),
    ("POST", "/v1/sso/c/hello", S),
    ("POST", "/v1/sso/c/sign", S),
    ("POST", "/v1/sso/c/revoke", S),
    ("POST", "/v1/sso/c/org-member", S),
    ("POST", "/v1/sso/c/pending-add", S),
    ("POST", "/v1/docs/post", S),
    ("POST", "/v1/docs/aware", S),
    ("POST", "/v1/docs/delete", S),
    // guest port: the page itself loads in every state so it can show the refusal's words (4.10); its routes are
    // service
    ("GET", "/g", X),
    ("GET", "/g/", X),
    ("GET", "/g/index.html", X),
    ("GET", "/g/guest.js", X),
    ("GET", "/g/guest.css", X),
    ("GET", "/g/v1/wait", S),
    ("GET", "/g/v1/events", S),
    ("POST", "/g/v1/knock", S),
    ("POST", "/g/v1/signal", S),
    ("POST", "/g/v1/chat", S),
    ("POST", "/g/v1/stage", S),
    ("POST", "/g/v1/consent", S),
    ("POST", "/g/v1/leave", S),
];

/// The route's class; None for a route missing from the table (refused).
pub fn class_of(method: &str, path: &str) -> Option<Class> {
    GATE.iter().find(|(m, p, _)| *m == method && *p == path).map(|(_, _, c)| *c)
}

fn inactive() -> E {
    E::Held(LICENSE_INACTIVE.into(), obj([("code", Value::from("license-inactive"))]))
}

fn no_seat() -> E {
    E::Held(NO_SEAT.into(), obj([("code", Value::from("no-seat"))]))
}

/// The upgrade period of `meet-license-state.json` (seconds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Upgrade {
    pub first_start: i64,
    /// None: no period, or retired.
    pub ends: Option<i64>,
}

fn read_upgrade(dir: &Path) -> Result<Option<Upgrade>, String> {
    let Some(o) = crate::meet_time::read_object(&dir.join(LICENSE_STATE_FILE))? else { return Ok(None) };
    let bad = || format!("{LICENSE_STATE_FILE} is not valid; the relay will not start until it is fixed or restored");
    if o.len() != 2 {
        return Err(bad());
    }
    let first_start = o.get("firstStart").and_then(Value::as_i64).ok_or_else(bad)?;
    let ends = match o.get("upgradePeriodEnds") {
        Some(Value::Null) => None,
        Some(v) => Some(v.as_i64().ok_or_else(bad)?),
        None => return Err(bad()),
    };
    Ok(Some(Upgrade { first_start, ends }))
}

fn write_upgrade(dir: &Path, u: &Upgrade) -> Result<(), String> {
    let body = json!({"firstStart": u.first_start, "upgradePeriodEnds": u.ends});
    crate::store::write_private(&dir.join(LICENSE_STATE_FILE), format!("{body}\n").as_bytes()).map_err(|e| format!("{LICENSE_STATE_FILE} cannot be written: {e}"))
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
    pub serving: bool,
}

/// Where the gate reads its files.
pub struct GateConfig {
    pub state_dir: Option<PathBuf>,
    /// relay.json `license`, else state_dir/license.lic.
    pub license_file: Option<PathBuf>,
    pub client_ca: PathBuf,
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
    serving: Mutex<Option<bool>>,
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
        let time = TrustedTime::open(dir.as_deref(), clock)?;
        let t = time.now();
        let mut pending = Vec::new();
        let upgrade = match dir.as_deref() {
            None => Upgrade { first_start: t / 1000, ends: None },
            Some(d) => match read_upgrade(d)? {
                Some(u) => u,
                None => {
                    let u = Upgrade { first_start: t / 1000, ends: before.then_some(t / 1000 + UPGRADE_DAYS * 86_400) };
                    write_upgrade(d, &u)?;
                    pending.push(("meet.license.upgrade-period".to_string(), "-".to_string(), json!({"firstStart": u.first_start, "upgradePeriodEnds": u.ends, "period": before})));
                    u
                }
            },
        };
        let seats = match Seats::read(dir.as_deref())? {
            Some(s) => s,
            None => {
                let s = Seats::migrate(dir.as_deref(), &hub.seat_records(), t);
                s.save()?;
                if !s.migrated.is_empty() {
                    pending.push(("meet.seats.migrated".to_string(), "-".to_string(), json!({"principals": s.migrated.len()})));
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
            serving: Mutex::new(None),
            checked: Mutex::new(None),
            logged: Mutex::new(HashMap::new()),
            pending: Mutex::new(pending),
            upgrade_mailed: Mutex::new(Vec::new()),
            protected_short: Mutex::new(false),
            clock_mailed: Mutex::new(None),
        });
        // a start with a protected principal unseated repairs it (R3-M6), and the seat clock is written before the
        // first answer
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
        *self.upgrade.lock()
    }

    /// Where the gate stands at effective time `t` (milliseconds).
    pub fn standing_at(&self, t: i64) -> Standing {
        let license = license_standing(self.licensed.lock().as_ref().map(|l| &l.license), t.div_euclid(1000));
        let active = matches!(license.state, Some(LicenseStateName::Valid | LicenseStateName::Grace));
        let period = self.upgrade.lock().ends.is_some_and(|e| t.div_euclid(1000) < e);
        Standing { license, active, period, serving: active || period }
    }

    pub fn standing(&self) -> Standing {
        self.standing_at(self.time.now())
    }

    /// The periodic check: the license file, the upgrade period (retirement and mails), the gate's audit on change
    /// and the seats. `force` skips the 10-second spacing.
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
        let changed = {
            let mut last = self.serving.lock();
            let changed = last.is_some_and(|l| l != s.serving);
            *last = Some(s.serving);
            changed
        };
        if changed {
            self.audit("meet.license.service", "-", json!({"serving": s.serving, "state": s.license.state_str(), "upgradePeriod": s.period}));
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
            let snapshot = *u;
            drop(u);
            if let Some(d) = self.cfg.state_dir.as_deref() {
                if let Err(e) = write_upgrade(d, &snapshot) {
                    crate::meet::log_error(&e);
                }
            }
            self.audit("meet.license.upgrade-period", "-", json!({"retired": why, "upgradePeriodEnds": ends}));
            return;
        }
        let day = (now_s - u.first_start).max(0) / 86_400;
        drop(u);
        let mut mailed = self.upgrade_mailed.lock();
        for d in UPGRADE_MAIL_DAYS {
            if day >= d && !mailed.contains(&d) {
                mailed.push(d);
                if day > d && d != *UPGRADE_MAIL_DAYS.iter().filter(|x| **x <= day).max().unwrap_or(&0) {
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
        let now = Now { t, seat_elapsed: view.seat_elapsed, day_ms: self.time.seat_day_ms(), uncertain: view.uncertain, hold_due: view.hold_due(), users: s.active.then_some(s.license.users), protected: &protected };
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
                Event::ClockStart { started_at } => self.audit("meet.seats.clock", "-", json!({"state": "started", "startedAt": started_at})),
                Event::ClockClear => self.audit("meet.seats.clock", "-", json!({"state": "cleared"})),
                Event::Notice { day } => {
                    self.audit("meet.seats.notice", "-", json!({"day": day}));
                    let users = s.license.users;
                    for to in self.admin_emails() {
                        self.mail("mail.seats-over", &to, &[("seated", seated.to_string()), ("users", users.to_string()), ("n", (seated - users).max(0).to_string()), ("date", unseat_date.clone())]);
                    }
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
        if seated <= s.license.users {
            *self.protected_short.lock() = false;
        }
    }

    /// The gate at dispatch (2.4, 4.10): Ok to serve, or the 403 `license-inactive` or `no-seat` refusal.
    pub fn serves(&self, method: &str, path: &str, who: Option<&Identity>) -> Result<(), E> {
        let fresh = who.is_some_and(|w| person(w) && !self.seats.lock().first_seen.contains_key(&w.principal));
        self.check(fresh);
        let class = class_of(method, path).ok_or_else(inactive)?;
        let relay_admin = || who.is_some_and(|w| self.hub.upgrade().is_some_and(|h| h.is_admin(&w.principal)));
        match class {
            Class::Exempt => return Ok(()),
            Class::Admin if relay_admin() => return Ok(()),
            _ => {}
        }
        if !self.standing().serving {
            self.log_refused(who);
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

    fn log_refused(&self, who: Option<&Identity>) {
        let key = who.map(|w| format!("{}|{}", w.principal, w.device)).unwrap_or_default();
        let t = self.time.now();
        let mut logged = self.logged.lock();
        if logged.get(&key).is_some_and(|at| t - at < GATE_LOG_MS) {
            return;
        }
        if logged.len() > 10_000 {
            logged.clear();
        }
        logged.insert(key.clone(), t);
        crate::meet::log_warn(&format!("meet.license-gate category=security device={}", crate::meet::kv(&key)));
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

    /// GET meet/seats (4.9).
    pub fn seats_view(&self, names: &dyn Fn(&str) -> String, request_to: Option<String>) -> Value {
        self.check(false);
        let Some(hub) = self.hub.upgrade() else { return Value::Null };
        let t = self.time.now();
        let s = self.standing_at(t);
        let users = if s.active { s.license.users } else { 0 };
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
            "ok": true, "users": users, "seated": seated, "state": Seats::level(seated, users).as_str(), "clock": clock, "people": people,
            "unseated": seats.unseated.len(), "held": seats.held.len(), "requestTo": request_to, "migrated": seats.migrated_seated(&live),
        })
    }

    /// Seats in use and the license's `users` (`used` is the seated principals).
    pub fn seat_counts(&self) -> (i64, i64) {
        let Some(hub) = self.hub.upgrade() else { return (0, 0) };
        let t = self.time.now();
        let s = self.standing_at(t);
        let live = hub.seat_live(t.div_euclid(1000));
        let seated = self.seats.lock().seated(&live).len() as i64;
        (seated, if s.active { s.license.users } else { 0 })
    }

    pub fn is_seated(&self, principal: &str) -> bool {
        !self.seats.lock().is_unseated(principal)
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
        if s.period && !s.active {
            let date = self.upgrade.lock().ends.map(crate::meet_json::iso_date).unwrap_or_default();
            out.push(with_banner(item("license-upgrade-period", "warn", json!({"date": date}), "#/license"), "banner.upgrade-period"));
        } else if !s.serving {
            out.push(with_banner(item("license-service-off", "bad", json!({}), "#/license"), "banner.service-off"));
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

/// A person's device (not a guest, connector, service or the console): seats apply to it.
fn person(w: &Identity) -> bool {
    !w.principal.is_empty() && !w.guest && !w.connector && !w.is_service() && !w.is_console() && !w.seed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meet_time::testclock::FakeClock;

    const T0: i64 = 1_800_000_000_000;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-meet-license-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn hub(d: &Path) -> Arc<Hub> {
        Arc::new(Hub::new(Some(d.to_path_buf()), &[], 1e9, 1e9, 1e9, None, Arc::new(crate::meet_console::LinkStats::new())))
    }

    fn cfg(d: &Path) -> GateConfig {
        GateConfig { state_dir: Some(d.to_path_buf()), license_file: Some(d.join(LICENSE_FILE)), client_ca: d.join("client_ca.pem") }
    }

    fn old_state(d: &Path) {
        std::fs::write(d.join("state.json"), r#"{"v": 2, "directory": {"ann@x.org": {"name": "Ann", "devices": {"aaaaaaaaaaaaaaaa": {"label": "PC", "last_seen": 1}}}}}"#).unwrap();
    }

    fn person_who() -> Identity {
        Identity { principal: "bob@x.org".into(), device: "bbbbbbbbbbbbbbbb".into(), serial: "77".into(), kind: "person".into(), ..Default::default() }
    }

    #[test]
    fn every_route_of_both_ports_is_in_the_table_and_a_missing_one_is_refused() {
        for (m, p, _) in GATE.iter().filter(|(_, p, _)| p.starts_with("/v1/") || *p == "/healthz") {
            assert!(crate::meet_routes::has_route(m, p), "{m} {p} is not a route of the main port");
        }
        let mut seen = std::collections::HashSet::new();
        for (m, p, _) in GATE {
            assert!(seen.insert((m, p)), "{m} {p} twice");
        }
        assert_eq!(class_of("POST", "/v1/not-a-route"), None);
        let d = dir("missing");
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        assert!(matches!(g.serves("POST", "/v1/not-a-route", None), Err(E::Held(..))));
    }

    #[test]
    fn with_no_license_service_routes_refuse_and_exempt_routes_serve() {
        let d = dir("none");
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap();
        assert!(!g.standing().serving, "a fresh install has no period");
        assert_eq!(g.upgrade().ends, None);
        let who = person_who();
        for (m, p, c) in GATE {
            let r = g.serves(m, p, Some(&who));
            match c {
                Class::Exempt => assert!(r.is_ok(), "{m} {p}"),
                _ => match r {
                    Err(E::Held(words, info)) => {
                        assert_eq!(words, LICENSE_INACTIVE);
                        assert_eq!(info["code"], "license-inactive");
                    }
                    other => panic!("{m} {p}: {other:?}"),
                },
            }
        }
    }

    #[test]
    fn an_upgrade_from_before_ac1_gets_thirty_days_kept_across_a_restart() {
        let d = dir("upgrade");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        let ends = g.upgrade().ends.unwrap();
        assert_eq!(ends, T0 / 1000 + 30 * 86_400);
        assert!(d.join(LICENSE_STATE_FILE).is_file(), "written before the first answer");
        assert!(g.serves("POST", "/v1/dm", Some(&person_who())).is_ok());
        drop(g);
        c.restart(86_400_000);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        assert_eq!(g.upgrade().ends, Some(ends), "a restart keeps the same end");
        // the period runs out
        c.run(30 * 86_400_000);
        g.check(true);
        assert!(!g.standing().serving);
        assert_eq!(g.upgrade().ends, None, "retired");
    }

    #[test]
    fn deleting_the_state_file_next_to_the_seats_gives_no_new_period() {
        let d = dir("deleted");
        old_state(&d);
        let h = hub(&d);
        drop(MeetGate::open(cfg(&d), &h, FakeClock::new(T0)).unwrap());
        assert!(d.join(crate::meet_seats::SEATS_FILE).is_file());
        std::fs::remove_file(d.join(LICENSE_STATE_FILE)).unwrap();
        let g = MeetGate::open(cfg(&d), &h, FakeClock::new(T0 + 1000)).unwrap();
        assert_eq!(g.upgrade().ends, None);
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
    fn a_forward_jump_ends_the_period_early_and_moving_the_clock_back_extends_nothing() {
        let d = dir("jump");
        old_state(&d);
        let c = FakeClock::new(T0);
        let h = hub(&d);
        let g = MeetGate::open(cfg(&d), &h, c.clone()).unwrap();
        c.run(29 * 86_400_000);
        c.shift_wall(2 * 86_400_000);
        g.check(true);
        assert!(!g.standing().serving, "a forward jump can end service early");
        c.shift_wall(-10 * 86_400_000);
        g.check(true);
        assert!(!g.standing().serving, "moving the clock back extends nothing");
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
    fn an_unseated_device_gets_no_seat_and_exempt_routes_still_serve() {
        let d = dir("noseat");
        old_state(&d);
        let g = MeetGate::open(cfg(&d), &hub(&d), FakeClock::new(T0)).unwrap();
        g.seats.lock().unseated.push(crate::meet_seats::Unseated { principal: "bob@x.org".into(), at: T0, why: "day-14".into() });
        g.seats.lock().first_seen.insert("bob@x.org".into(), T0);
        match g.serves("POST", "/v1/dm", Some(&person_who())) {
            Err(E::Held(words, info)) => {
                assert_eq!(words, NO_SEAT);
                assert_eq!(info["code"], "no-seat");
            }
            other => panic!("{other:?}"),
        }
        assert!(g.serves("GET", "/v1/crl", Some(&person_who())).is_ok());
    }
}
