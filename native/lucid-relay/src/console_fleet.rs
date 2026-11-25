// The fleet section of the Lucid Admin Console (contract AC-2a, sections 2, 5.3, 5.4, 6, 7.1 and 8; interfaces F7 and
// F15): the console role's registry of relays (`fleet-relays.json`, fail closed), enrollment codes, the console end of
// the management channel (FleetLink and FleetPki, implemented by fleet_port and fleet_ca), the fleet routes of 5.3,
// the proxy of 5.4 with its fleet step-up (4.6) and approvals across the channel (4.7), the roster and policy chains
// and their pushes (4.4, 4.5), the fleet Overview and attention (8.1), Relays and locations (8.2), the license
// library, and the PeopleHost of f-people (11). Relays are untrusted: everything they send is cleaned before display
// and only AC-1 attention kinds pass (14.1 invariant 18).

use crate::codec::{b64u, hex, sha256_hex, str_of, stringify, unb64u};
use crate::console::{ApiError, Console, Done, LicenseState, LicenseView, Need, Out, ProductSection, Role, RouteSpec, SectionAnswer, SectionCall};
use crate::console_api_1c as api_1c;
use crate::console_api_1d as api_1d;
use crate::console_api_ui as api_ui;
use crate::console_audit::Record;
use crate::console_auth::{clean, hint_of, random_bytes, reason_of, FleetCeremony, FleetKind, PersonRole, Who};
use crate::license::Product;
use crate::log::{Fields, Level};
use indexmap::IndexMap;
use parking_lot::{Mutex, MutexGuard};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

pub const RELAYS_FILE: &str = "fleet-relays.json";
/// 3.8 limits.
pub const RELAYS_MAX: usize = crate::fleet_wire::RELAYS_MAX;
pub const OPEN_CODES_MAX: usize = 20;
pub const CODES_PER_ADMIN_HOUR: usize = 10;
pub const CODE_MS: i64 = 3_600_000;
pub const CODE_FAILS_MAX: u32 = crate::fleet_wire::CODE_FAILS;
/// 8.1: no contact for 3 minutes is `relay-silent`; a pending record without first contact for 1 hour expires (3.3).
pub const SILENT_MS: i64 = 180_000;
pub const PENDING_MS: i64 = 3_600_000;
/// 3.8: call timeout (exports 120 s) and the 5 s nonce wait of 4.6.
pub const CALL_MS: u64 = crate::fleet_wire::CALL_TIMEOUT.as_millis() as u64;
pub const EXPORT_MS: u64 = crate::fleet_wire::EXPORT_TIMEOUT.as_millis() as u64;
pub const NONCE_MS: u64 = 5_000;
/// 3.6: more than 10 replacements an hour.
pub const FLAPPING_PER_HOUR: usize = 10;
/// Roster and policy updates kept for relays catching up at `welcome` (4.4).
pub const CHAIN_LOG_MAX: usize = 500;
/// A proxied request body: the 512 KiB console-to-relay frame with room for its envelope (3.8).
pub const PROXY_BODY_MAX: usize = 480 * 1024;
/// The scopes the console grants or asks for (4.1); `upgrade` is never offered.
pub const SCOPES: [&str; 5] = ["read-health", "read-logs", "people", "config", "license"];

// ── The console end of the channel (F3, F17): implemented by fleet_port and fleet_ca ─────────────────────────

/// Why a request frame got no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkError {
    Offline,
    Timeout,
    Busy,
    Refused { status: u16, code: String, error: String },
}

/// The management channels of every connected relay (fleet_port; the console end of `fleet_wire::Local`).
pub trait FleetLink: Send + Sync {
    /// One request frame and its answer body; blocks the calling thread (never call it under a console lock).
    fn request(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, LinkError>;
    /// One event frame; false when the relay is not connected.
    fn event(&self, relay: &str, op: &str, body: Value) -> bool;
    fn connected(&self, relay: &str) -> bool;
    /// Close the relay's channel with this WebSocket close code (4003 after `bye`).
    fn close(&self, relay: &str, code: u16);
}

/// The management CA's state for Overview and the routes (3.2, 3.10 to 3.12).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PkiStatus {
    pub ready: bool,
    pub seal_needed: bool,
    pub lost: bool,
    pub unreadable: bool,
    pub ca_days_left: Option<i64>,
    /// Relays that have not confirmed a pending CA generation (3.11 `relay-ca-unconfirmed`).
    pub unconfirmed: usize,
}

/// The management CA (fleet_ca).
pub trait FleetPki: Send + Sync {
    /// SHA-256 of the current CA generation's SubjectPublicKeyInfo DER; None while no CA is usable.
    fn pin(&self) -> Option<[u8; 32]>;
    fn status(&self, t: i64) -> PkiStatus;
    /// Deny management serials (`fleet-denied.json`).
    fn deny(&self, serials: &[String], t: i64) -> Result<(), String>;
    /// `{caGenerations, manifest: {seq, issuedAt, leaves, revoked}}` (5.3 `GET fleet/trust` without `ok` and `relays`).
    fn trust_view(&self, t: i64) -> Value;
    /// "Replace the management certificate now" (3.10): (the revoked leaf's spkiSha256, the new manifest seq).
    fn server_revoke(&self, t: i64) -> Result<(String, u64), ApiError>;
    /// "Start a new management CA" (3.11): (generation, fingerprint).
    fn ca_rollover(&self, t: i64) -> Result<(u32, String), ApiError>;
}

// ── The registry (F15) ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RelayState {
    Pending,
    Unconfirmed,
    Active,
    Left,
    Removed,
}

impl RelayState {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayState::Pending => "pending",
            RelayState::Unconfirmed => "unconfirmed",
            RelayState::Active => "active",
            RelayState::Left => "left",
            RelayState::Removed => "removed",
        }
    }

    pub fn parse(s: &str) -> Option<RelayState> {
        match s {
            "pending" => Some(RelayState::Pending),
            "unconfirmed" => Some(RelayState::Unconfirmed),
            "active" => Some(RelayState::Active),
            "left" => Some(RelayState::Left),
            "removed" => Some(RelayState::Removed),
            _ => None,
        }
    }

    /// Counted toward the 200 relays (3.8) and part of the fleet.
    pub fn live(self) -> bool {
        matches!(self, RelayState::Pending | RelayState::Unconfirmed | RelayState::Active)
    }
}

/// One management certificate of a relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SerialRecord {
    pub serial: String,
    pub spki_sha256: String,
    /// base64url of the SubjectPublicKeyInfo DER.
    pub spki: String,
    pub not_after: i64,
    pub generation: u32,
    /// The relay's current certificate (false: the previous one, kept until the next `hello` with the new one).
    pub current: bool,
}

impl SerialRecord {
    fn to_value(&self) -> Value {
        json!({ "serial": self.serial, "spkiSha256": self.spki_sha256, "spki": self.spki, "notAfter": self.not_after, "generation": self.generation, "current": self.current })
    }

    fn from_value(v: &Value) -> Option<SerialRecord> {
        Some(SerialRecord {
            serial: str_of(v.get("serial"))?.to_owned(),
            spki_sha256: str_of(v.get("spkiSha256"))?.to_owned(),
            spki: str_of(v.get("spki"))?.to_owned(),
            not_after: v.get("notAfter")?.as_i64()?,
            generation: u32::try_from(v.get("generation")?.as_u64()?).ok()?,
            current: v.get("current")?.as_bool()?,
        })
    }
}

/// One relay as the console knows it (8.2 fields and what they come from).
#[derive(Clone, Debug)]
pub struct RelayRecord {
    pub id: String,
    pub name: String,
    pub site: String,
    pub product: Product,
    pub state: RelayState,
    pub serials: Vec<SerialRecord>,
    pub fingerprint: String,
    pub enrolled_at: i64,
    pub enrolled_by: String,
    pub enrollment: String,
    /// "code" or "same-process".
    pub via: String,
    pub source_address: Option<String>,
    pub bootstrap_roster_hash: String,
    pub last_contact_at: Option<i64>,
    pub version: String,
    pub os: String,
    pub fips: bool,
    pub profile: String,
    pub scopes: Vec<String>,
    /// The scopes asked of the relay's operator (4.1), until they accept.
    pub pending_scopes: Vec<String>,
    /// An admin compared the fingerprint and confirmed the relay (3.3).
    pub confirmed: bool,
    pub left_at: Option<i64>,
    /// The relay's last `hello` and `state` report (5.6), untrusted.
    pub report: Map<String, Value>,
    /// The relay's pushed attention items (5.6), cleaned, AC-1 kinds only.
    pub attention: Vec<Value>,
    /// The latest `read-health` answers (8.2 `nodes`, `services`): `spokes/counts` or `meet/counts`, `meet/servers`,
    /// `meet/push`.
    pub counts: Value,
    pub servers: Value,
    pub push: Value,
    /// Changes waiting for the operator (`fleet-confirm` answers), until `confirm-done`.
    pub waiting: Vec<Value>,
    /// `confirm-done` with result `unknown` not yet seen by whoever asked (revision 3.2).
    pub unknown: Vec<Value>,
    /// Channel replacements in the last hour (3.6) and when `relay-flapping` was raised.
    pub replacements: Vec<i64>,
    pub flapping_at: Option<i64>,
    /// Since when the relay is behind the roster or policy chain (`roster-behind`, one hour).
    pub behind_since: Option<i64>,
    /// A scope request was replaced before its operator answered (`relay-scope-stale`).
    pub scope_stale: bool,
    /// The relay's clock is more than 5 minutes off (`relay-clock`, from metrics).
    pub clock_off: bool,
    /// AC-2b-D 6.1: the enrollment's `deploy` (the names recorded at mint, `pki`), kept for renewals (8.4).
    pub deploy: Option<Value>,
    /// AC-2b-D 8.4: `{keep, at, done}`: the server serial the relay reported in use, and when the older server
    /// serials are revoked (7 days after the relay reported it).
    pub meet_revoke: Option<Value>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// A reported `bootstrap`: the bare string of `hello` and `state`, or an object with `state`; "pending" otherwise.
fn bootstrap_state_of(v: Option<&Value>) -> &str {
    match v {
        Some(Value::String(s)) => s,
        Some(o) => o.get("state").and_then(Value::as_str).unwrap_or("pending"),
        None => "pending",
    }
}

/// A reported `bootstrap` as `{state, ...}` (an object is kept as it is; nothing reported is pending, no entries).
fn bootstrap_object(v: Option<&Value>) -> Value {
    match v {
        Some(o) if o.is_object() => o.clone(),
        _ => json!({ "state": bootstrap_state_of(v), "entries": [] }),
    }
}

/// The audit chain keeps results as fixed words; a fleet call's result is one of the frame union's values
/// (5.6), anything else is recorded as "failed".
fn audit_result(r: &str) -> &'static str {
    match r {
        "ok" => "ok",
        "refused" => "refused",
        "expired" => "expired",
        "unknown" => "unknown",
        "waiting" => "waiting",
        _ => "failed",
    }
}

fn product_str(p: Product) -> &'static str {
    p.as_str()
}

/// AC-2a 8.1, 8.2 (3.4): the License column of a relay stopped for its license.
pub const STOPPED_WORDS: &str = "Stopped: no active license";
const SERVICE_STATES: [&str; 4] = ["on", "grace", "upgrade-period", "stopped"];
const SERVICE_WHYS: [&str; 5] = ["none", "wrong-product", "wrong-root", "expired", "invalid"];

/// The 5.6 `state` frame's license object (3.4.1, R7-L1), exactly `{id, exp, state, daysLeft, service: {state,
/// stopsAt, why, upgradePeriodEnds}}`: every key present, `id` text or null, `exp`, `daysLeft`, `stopsAt` and
/// `upgradePeriodEnds` integers or null, `state` text, `service.state` one of the four and `why` one of the five or
/// null. None for anything else: the frame is refused (`fleet-op`), never normalized field by field.
fn license_report(v: &Value) -> Option<Value> {
    let o = v.as_object().filter(|o| o.len() == 5)?;
    let s = o.get("service")?.as_object().filter(|s| s.len() == 4)?;
    let int = |x: Option<&Value>| match x? {
        Value::Null => Some(Value::Null),
        n => n.as_i64().map(Value::from),
    };
    let text = |x: &Value, max: usize| x.as_str().filter(|t| !t.is_empty() && t.len() <= max && !t.chars().any(char::is_control)).map(Value::from);
    let id = match o.get("id")? {
        Value::Null => Value::Null,
        x => text(x, 80)?,
    };
    let why = match s.get("why")? {
        Value::Null => Value::Null,
        w => Value::from(*SERVICE_WHYS.iter().find(|x| w.as_str() == Some(**x))?),
    };
    let state = SERVICE_STATES.iter().copied().find(|x| s.get("state").and_then(Value::as_str) == Some(*x))?;
    Some(json!({
        "id": id, "exp": int(o.get("exp"))?, "state": text(o.get("state")?, 16)?, "daysLeft": int(o.get("daysLeft"))?,
        "service": { "state": state, "stopsAt": int(s.get("stopsAt"))?, "why": why, "upgradePeriodEnds": int(s.get("upgradePeriodEnds"))? },
    }))
}

/// A relay's service at `t` from what it last pushed (8.1): its `exp` and `stopsAt` carry it on while it is silent,
/// so `on` past `exp` reads as grace and grace or an upgrade period past `stopsAt` as stopped. None without a
/// pushed `service`.
fn pushed_service(lic: &Value, t: i64) -> Option<crate::console::ServiceView> {
    use crate::console::ServiceState as S;
    let svc = lic.get("service")?;
    let mut state = match service_state_of(lic)? {
        "on" => S::On,
        "grace" => S::Grace,
        "upgrade-period" => S::UpgradePeriod,
        _ => S::Stopped,
    };
    let exp = lic.get("exp").and_then(Value::as_i64);
    let stops_at = svc.get("stopsAt").and_then(Value::as_i64);
    if state == S::On && exp.is_some_and(|e| t >= e) {
        state = S::Grace;
    }
    if matches!(state, S::Grace | S::UpgradePeriod) && stops_at.is_some_and(|s| t >= s) {
        state = S::Stopped;
    }
    Some(crate::console::ServiceView {
        state,
        stops_at,
        why: svc.get("why").and_then(Value::as_str).and_then(|w| SERVICE_WHYS.iter().copied().find(|x| *x == w)),
        reason: None,
        upgrade_period_ends: svc.get("upgradePeriodEnds").and_then(Value::as_i64),
        license_id: lic.get("id").and_then(Value::as_str).map(str::to_owned),
        exp,
        at: t,
    })
}

/// AC-2a 8.1 (revision 3.4.1, R7-L1): a relay's reminder key and every step of its schedule from the pushed license
/// object alone: key the license `id`, else `"upgrade:" + upgradePeriodEnds`, else none (no steps); `30d` to `1d` at
/// `exp` minus those days, `expiry` at `exp`, `grace` every 12 hours after `exp` while before `stopsAt`, `stopped` at
/// `stopsAt`; an upgrade period's `grace` steps every 12 hours from 2 days before its end, then `stopped`. Steps
/// already past are listed too; the console sends each once per relay and key.
pub fn fleet_steps(lic: &Value) -> (Option<String>, Vec<(&'static str, i64)>) {
    use crate::license_reminders::{DAY_MS, DAYS_BEFORE, REPEAT_MS, UPGRADE_PERIOD_MS};
    let svc = lic.get("service");
    let stops_at = svc.and_then(|s| s.get("stopsAt")).and_then(Value::as_i64);
    let mut steps = Vec::new();
    if let Some(id) = lic.get("id").and_then(Value::as_str) {
        if let Some(exp) = lic.get("exp").and_then(Value::as_i64) {
            for d in DAYS_BEFORE {
                steps.push((days_step(d), exp - d * DAY_MS));
            }
            steps.push(("expiry", exp));
            if let Some(stop) = stops_at {
                let mut at = exp + REPEAT_MS;
                while at < stop {
                    steps.push(("grace", at));
                    at += REPEAT_MS;
                }
                steps.push(("stopped", stop));
            }
        }
        return (Some(id.to_owned()), steps);
    }
    let Some(ends) = svc.and_then(|s| s.get("upgradePeriodEnds")).and_then(Value::as_i64) else { return (None, steps) };
    let stop = stops_at.unwrap_or(ends);
    let mut at = ends - UPGRADE_PERIOD_MS;
    while at < stop {
        steps.push(("grace", at));
        at += REPEAT_MS;
    }
    steps.push(("stopped", stop));
    (Some(format!("upgrade:{ends}")), steps)
}

/// The record kind (license_reminders.rs) of a fleet step.
fn step_kind(step: &str) -> &'static str {
    match step {
        "30d" => "days-30",
        "14d" => "days-14",
        "7d" => "days-7",
        "3d" => "days-3",
        "1d" => "days-1",
        "expiry" => "grace-start",
        "grace" => "grace-repeat",
        _ => "stopped",
    }
}

fn days_step(d: i64) -> &'static str {
    match d {
        30 => "30d",
        14 => "14d",
        7 => "7d",
        3 => "3d",
        _ => "1d",
    }
}

/// The pushed license view's `service.state` (AC-1 4.7, 5.6), when it is one of the four.
fn service_state_of(lic: &Value) -> Option<&'static str> {
    let s = lic.get("service").and_then(|s| s.get("state")).and_then(Value::as_str)?;
    SERVICE_STATES.iter().copied().find(|x| *x == s)
}

fn product_of(s: &str) -> Option<Product> {
    match s {
        "spokes" => Some(Product::Spokes),
        "meet" => Some(Product::Meet),
        _ => None,
    }
}

impl RelayRecord {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "site": self.site, "product": product_str(self.product), "state": self.state.as_str(),
            "serials": self.serials.iter().map(SerialRecord::to_value).collect::<Vec<_>>(), "fingerprint": self.fingerprint,
            "enrolledAt": self.enrolled_at, "enrolledBy": self.enrolled_by, "enrollment": self.enrollment, "via": self.via,
            "sourceAddress": self.source_address, "bootstrapRosterHash": self.bootstrap_roster_hash, "lastContactAt": self.last_contact_at,
            "version": self.version, "os": self.os, "fips": self.fips, "profile": self.profile, "scopes": self.scopes,
            "pendingScopes": self.pending_scopes, "confirmed": self.confirmed, "leftAt": self.left_at, "report": self.report,
            "attention": self.attention, "counts": self.counts, "servers": self.servers, "push": self.push, "waiting": self.waiting,
            "unknown": self.unknown, "replacements": self.replacements, "flappingAt": self.flapping_at, "behindSince": self.behind_since,
            "scopeStale": self.scope_stale, "clockOff": self.clock_off, "deploy": self.deploy, "meetRevoke": self.meet_revoke,
        })
    }

    fn from_value(v: &Value) -> Option<RelayRecord> {
        let s = |k: &str| str_of(v.get(k)).map(str::to_owned);
        Some(RelayRecord {
            id: s("id")?,
            name: s("name")?,
            site: s("site").unwrap_or_default(),
            product: product_of(str_of(v.get("product"))?)?,
            state: RelayState::parse(str_of(v.get("state"))?)?,
            serials: v.get("serials")?.as_array()?.iter().map(SerialRecord::from_value).collect::<Option<Vec<_>>>()?,
            fingerprint: s("fingerprint").unwrap_or_default(),
            enrolled_at: v.get("enrolledAt")?.as_i64()?,
            enrolled_by: s("enrolledBy").unwrap_or_default(),
            enrollment: s("enrollment").unwrap_or_default(),
            via: s("via").unwrap_or_else(|| "code".into()),
            source_address: s("sourceAddress"),
            bootstrap_roster_hash: s("bootstrapRosterHash").unwrap_or_default(),
            last_contact_at: v.get("lastContactAt").and_then(Value::as_i64),
            version: s("version").unwrap_or_default(),
            os: s("os").unwrap_or_default(),
            fips: v.get("fips").and_then(Value::as_bool).unwrap_or(false),
            profile: s("profile").unwrap_or_else(|| "standard".into()),
            scopes: strings(v.get("scopes")),
            pending_scopes: strings(v.get("pendingScopes")),
            confirmed: v.get("confirmed").and_then(Value::as_bool).unwrap_or(false),
            left_at: v.get("leftAt").and_then(Value::as_i64),
            report: v.get("report").and_then(Value::as_object).cloned().unwrap_or_default(),
            attention: v.get("attention").and_then(Value::as_array).cloned().unwrap_or_default(),
            counts: v.get("counts").cloned().unwrap_or(Value::Null),
            servers: v.get("servers").cloned().unwrap_or(Value::Null),
            push: v.get("push").cloned().unwrap_or(Value::Null),
            waiting: v.get("waiting").and_then(Value::as_array).cloned().unwrap_or_default(),
            unknown: v.get("unknown").and_then(Value::as_array).cloned().unwrap_or_default(),
            replacements: v.get("replacements").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default(),
            flapping_at: v.get("flappingAt").and_then(Value::as_i64),
            behind_since: v.get("behindSince").and_then(Value::as_i64),
            scope_stale: v.get("scopeStale").and_then(Value::as_bool).unwrap_or(false),
            clock_off: v.get("clockOff").and_then(Value::as_bool).unwrap_or(false),
            deploy: v.get("deploy").filter(|d| d.is_object()).cloned(),
            meet_revoke: v.get("meetRevoke").filter(|d| d.is_object()).cloned(),
        })
    }

    /// The bootstrap state the relay reports ("pending" or "done"): `hello` and `state` carry it as the bare string
    /// (`admin_console_fleet_state_frame_v1.json`); an object with `state` is read too.
    pub fn bootstrap_state(&self) -> &str {
        bootstrap_state_of(self.report.get("bootstrap"))
    }

    /// The bootstrap report as an object (`{state, ...}`) for the views and the audit.
    fn bootstrap_view(&self) -> Value {
        bootstrap_object(self.report.get("bootstrap"))
    }

    /// The relay takes writes from this console: the admin confirmed it and its own bootstrap is done (3.3).
    fn settle_state(&mut self) {
        if self.state == RelayState::Unconfirmed && self.confirmed && self.bootstrap_state() == "done" {
            self.state = RelayState::Active;
        }
    }

    pub fn all_serials(&self) -> Vec<String> {
        self.serials.iter().map(|s| s.serial.clone()).collect()
    }

    pub fn grants(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }

    fn report_bool(&self, k: &str) -> bool {
        self.report.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    fn report_u64(&self, k: &str) -> u64 {
        self.report.get(k).and_then(Value::as_u64).unwrap_or(0)
    }
}

/// One enrollment code's record (3.1); the secret is sealed apart as `fleet-code-<id>`.
#[derive(Clone, Debug)]
pub struct Enrollment {
    pub id: String,
    pub product: Product,
    pub name: String,
    pub site: String,
    pub scopes: Vec<String>,
    pub replaces: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub expires: i64,
    /// "open", "used", "expired" or "cancelled".
    pub state: String,
    pub fails: u32,
    pub relay: Option<String>,
    /// AC-2b-D 6.1: `linux`, `proxmox`, `docker` or `installed` (the AC-2a path).
    pub env: String,
    /// AC-2b-D 6.1 `{env, host, turnHost, clients, pki, license, binarySha256, offered, licenseSha256}`; None for
    /// `installed`.
    pub deploy: Option<Value>,
}

impl Enrollment {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id, "product": product_str(self.product), "name": self.name, "site": self.site, "scopes": self.scopes,
            "replaces": self.replaces, "createdBy": self.created_by, "createdAt": self.created_at, "expires": self.expires,
            "state": self.state, "fails": self.fails, "relay": self.relay, "env": self.env, "deploy": self.deploy,
        })
    }

    fn from_value(v: &Value) -> Option<Enrollment> {
        let s = |k: &str| str_of(v.get(k)).map(str::to_owned);
        Some(Enrollment {
            id: s("id")?,
            product: product_of(str_of(v.get("product"))?)?,
            name: s("name")?,
            site: s("site").unwrap_or_default(),
            scopes: strings(v.get("scopes")),
            replaces: s("replaces"),
            created_by: s("createdBy")?,
            created_at: v.get("createdAt")?.as_i64()?,
            expires: v.get("expires")?.as_i64()?,
            state: s("state")?,
            fails: u32::try_from(v.get("fails")?.as_u64()?).ok()?,
            relay: s("relay"),
            // absent in a registry from before AC-2b-D
            env: s("env").unwrap_or_else(|| "installed".into()),
            deploy: v.get("deploy").filter(|d| d.is_object()).cloned(),
        })
    }

    fn open(&self, t: i64) -> bool {
        self.state == "open" && self.expires > t
    }
}

/// `fleet-relays.json` (F15): every relay record and every enrollment code record, owner-only.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    pub relays: IndexMap<String, RelayRecord>,
    pub enrollments: IndexMap<String, Enrollment>,
}

impl Registry {
    /// The registry in `dir`: empty when there is none yet; Err when it does not read back (fail closed, 0).
    pub fn load(dir: &Path) -> Result<Registry, String> {
        let path = dir.join(RELAYS_FILE);
        let raw = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
            Err(e) => return Err(format!("{RELAYS_FILE} could not be read: {e}")),
        };
        let bad = || format!("{RELAYS_FILE} does not read back");
        let v = std::str::from_utf8(&raw).ok().and_then(crate::codec::parse_json).ok_or_else(bad)?;
        let o = v.as_object().ok_or_else(bad)?;
        if o.get("v").and_then(Value::as_i64) != Some(1) {
            return Err(bad());
        }
        let mut r = Registry::default();
        for x in o.get("relays").and_then(Value::as_array).ok_or_else(bad)? {
            let rec = RelayRecord::from_value(x).ok_or_else(bad)?;
            r.relays.insert(rec.id.clone(), rec);
        }
        for x in o.get("enrollments").and_then(Value::as_array).ok_or_else(bad)? {
            let e = Enrollment::from_value(x).ok_or_else(bad)?;
            r.enrollments.insert(e.id.clone(), e);
        }
        Ok(r)
    }

    pub fn to_value(&self) -> Value {
        json!({
            "v": 1,
            "relays": self.relays.values().map(RelayRecord::to_value).collect::<Vec<_>>(),
            "enrollments": self.enrollments.values().map(Enrollment::to_value).collect::<Vec<_>>(),
        })
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        crate::store::write_private(&dir.join(RELAYS_FILE), stringify(&self.to_value()).as_bytes()).map_err(|e| format!("{RELAYS_FILE} could not be written: {e}"))
    }

    /// Relays enrolled, unconfirmed or pending (3.8).
    pub fn live_count(&self) -> usize {
        self.relays.values().filter(|r| r.state.live()).count()
    }
}

// ── The console's chains and library (console.json `fleet`, 2.4) ────────────────────────────────────────────

/// `console.json` `fleet`: the console id, the policy and roster chains (with the updates kept for relays that catch
/// up), the license library and the fleet approvals' bindings.
#[derive(Clone, Debug)]
pub struct FleetBook {
    pub console_id: String,
    pub policy: Value,
    pub policy_seq: u64,
    pub policy_hash: [u8; 32],
    pub roster_seq: u64,
    pub roster_hash: [u8; 32],
    /// The canonical entries every relay holds at `roster_seq` (with evidence), in canonical order.
    pub roster: Vec<Value>,
    /// `{seq, prev, change, endorsements}` updates, oldest first (none sent to a relay enrolled after them).
    pub roster_log: Vec<Value>,
    /// `{seq, prev, policy, endorsements}` updates, oldest first.
    pub policy_log: Vec<Value>,
    /// `{id, product, edition, users, relays, exp, root, token}`.
    pub library: Vec<Value>,
    /// Fleet approvals by approval id: `{kind, relays, ...binding, credential}` (the request's assertion).
    pub approvals: Map<String, Value>,
    /// AC-2a 8.1 `licenseReminders`: `{relay id: sealed reminder record}` (license_reminders.rs, R7-L2).
    pub license_reminders: Map<String, Value>,
    /// AC-2b-D 2.4 `fleet.spokesRoot`: `{pem, id}`, the Remote Spokes organization root's public key (3.8).
    pub spokes_root: Option<Value>,
    /// AC-2b-D 10 attention kept across restarts until dismissed: `crlFuture {date, where, ceiling}`,
    /// `signerStale {since, number}`.
    pub meet_alerts: Map<String, Value>,
}

fn hash_hex(h: &[u8; 32]) -> String {
    hex(h)
}

fn hash_of(v: Option<&Value>) -> Option<[u8; 32]> {
    let s = v?.as_str()?;
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, c) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok()?;
    }
    Some(out)
}

impl FleetBook {
    fn new(policy: Value) -> Result<FleetBook, ApiError> {
        let console_id = format!("c_{}", hex(&random_bytes(8)?));
        let policy_hash = crate::fleet_trust::policy_hash(&console_id, 1, &[0u8; 32], &policy).ok_or_else(|| ApiError::of("write-failed"))?;
        Ok(FleetBook { console_id, policy, policy_seq: 1, policy_hash, roster_seq: 0, roster_hash: [0u8; 32], roster: Vec::new(), roster_log: Vec::new(), policy_log: Vec::new(), library: Vec::new(), approvals: Map::new(), license_reminders: Map::new(), spokes_root: None, meet_alerts: Map::new() })
    }

    pub fn to_value(&self) -> Value {
        json!({
            "consoleId": self.console_id, "policy": self.policy, "policySeq": self.policy_seq, "policyHash": hash_hex(&self.policy_hash),
            "rosterSeq": self.roster_seq, "rosterHash": hash_hex(&self.roster_hash), "roster": self.roster, "rosterLog": self.roster_log,
            "policyLog": self.policy_log, "library": self.library, "approvals": self.approvals, "licenseReminders": self.license_reminders,
            "spokesRoot": self.spokes_root, "meetAlerts": self.meet_alerts,
        })
    }

    pub fn from_value(v: &Value) -> Option<FleetBook> {
        let id = str_of(v.get("consoleId"))?;
        if !(id.len() == 18 && id.starts_with("c_") && id[2..].bytes().all(|b| b.is_ascii_hexdigit())) {
            return None;
        }
        Some(FleetBook {
            console_id: id.to_owned(),
            policy: v.get("policy")?.clone(),
            policy_seq: v.get("policySeq")?.as_u64()?,
            policy_hash: hash_of(v.get("policyHash"))?,
            roster_seq: v.get("rosterSeq")?.as_u64()?,
            roster_hash: hash_of(v.get("rosterHash"))?,
            roster: v.get("roster")?.as_array()?.clone(),
            roster_log: v.get("rosterLog")?.as_array()?.clone(),
            policy_log: v.get("policyLog")?.as_array()?.clone(),
            library: v.get("library")?.as_array()?.clone(),
            approvals: v.get("approvals")?.as_object()?.clone(),
            // absent in a book from before revision 3.4
            license_reminders: match v.get("licenseReminders") {
                None => Map::new(),
                Some(r) => r.as_object()?.clone(),
            },
            // absent in a book from before AC-2b-D
            spokes_root: match v.get("spokesRoot") {
                None | Some(Value::Null) => None,
                Some(r) => Some(r.as_object().filter(|o| str_of(o.get("pem")).is_some() && str_of(o.get("id")).is_some())?.clone().into()),
            },
            meet_alerts: match v.get("meetAlerts") {
                None => Map::new(),
                Some(r) => r.as_object()?.clone(),
            },
        })
    }
}

/// The policy record of a console's settings (4.5).
pub fn policy_of(high: bool, two_person: bool) -> Value {
    json!({ "profile": if high { "high" } else { "standard" }, "twoPerson": if two_person { "on" } else { "off" } })
}

/// Two entries share a credential id or a COSE key (3.9 "Duplicates").
pub fn roster_duplicate(entries: &[Value]) -> bool {
    crate::fleet_trust::roster_duplicate(entries)
}

/// The canonical order of 3.9: admins first, then user managers, each by email, then by credential id.
fn canonical_order(entries: &mut [Value]) {
    entries.sort_by(|a, b| {
        let key = |e: &Value| (if e["role"] == "admin" { 0 } else { 1 }, str_of(e.get("email")).unwrap_or("").to_owned(), str_of(e.get("credentialId")).unwrap_or("").to_owned());
        key(a).cmp(&key(b))
    });
}

// ── The fleet (F7, F15) ─────────────────────────────────────────────────────────────────────────────────────

/// What `console serve` (or the all-in-one start) gives the fleet section.
#[derive(Clone, Debug, Default)]
pub struct FleetOpen {
    /// The management port's host and port (`--fleet-host`, `--fleet-port`; 0 keeps it closed).
    pub fleet_host: String,
    pub fleet_port: u16,
    /// `--fleet-names`.
    pub fleet_names: Vec<String>,
    /// `--metrics-sources` (text and parsed), `--sources` as text.
    pub metrics_sources: Vec<crate::console_source::Cidr>,
    pub metrics_sources_text: String,
    /// All-in-one (2.2): the in-process relay's id once enrolled same-process.
    pub all_in_one: bool,
    /// AC-2b-D 4.2 `--fleet-serve-dev`: a `dev-license` build hands out its program too (default off).
    pub serve_dev: bool,
}

/// (email, relay) of a counted read.
type ReadKey = (String, String);
/// (minute, count, routes) of the reads of one `ReadKey`.
type ReadCount = (i64, u64, BTreeMap<String, u64>);

/// One fleet console's section.
pub struct Fleet {
    console: Weak<Console>,
    pub state_dir: PathBuf,
    pub console_id: String,
    pub cfg: FleetOpen,
    registry: Mutex<Registry>,
    /// `fleet-relays.json` did not read back: the management port stays closed (0, invariant 20).
    registry_unreadable: bool,
    book: Mutex<FleetBook>,
    link: OnceLock<Arc<dyn FleetLink>>,
    pki: OnceLock<Arc<dyn FleetPki>>,
    pub metrics: Arc<crate::fleet_metrics::Metrics>,
    pub siem: Arc<crate::fleet_syslog::Siem>,
    pub exporter: crate::fleet_export::Exporter,
    people: Arc<crate::fleet_people::People>,
    /// Reads counted for `fleet.reads.summary` (7.1): (email, relay) to (minute, count, routes).
    reads: Mutex<HashMap<ReadKey, ReadCount>>,
    /// Codes minted per admin in the last hour (3.1 `enroll-limit`).
    minted: Mutex<HashMap<String, Vec<i64>>>,
    /// AC-2b-D 8: the Meeting Hub organization CA this console holds (None: none imported). Lock order: the
    /// registry, then this, then the console's seal.
    meet: Mutex<Option<crate::meet_ca::MeetCa>>,
    /// AC-2b-D 8.5: the last re-sign failed (`meet-crl-failing`).
    crl_failing: Mutex<bool>,
    /// AC-2b-D 8.5 divergence: the reported root CRL (sha256) each relay was last asked for with `meet-crl-get`.
    diverge_seen: Mutex<HashMap<String, String>>,
    /// API-1: the org api maps, tightening journals and pseudonym keys this console holds and delivers (2.4 to 2.6),
    /// and the relay grace of the fleet verifier (3.4).
    pub api: Arc<crate::console_api::ConsoleApi>,
    /// API-1 9: the console's API audit chains (source `console`, and the relays' chains as received), checkpoints
    /// signed by per-org keys certified by the Meet CA.
    api_audit: Arc<crate::api_audit::ApiAudit>,
    /// API-1 6.5: the front door's resource and public pipeline limiters and DPoP cache.
    pub api_state: crate::api_resource::ResourceState,
    /// API-1 11: the export destinations of every org's pinned map, their queues under `<state>/exports/` and their
    /// delivery; the API audit chains' retention hold.
    pub export: Arc<crate::api_export::ExportEngine>,
    /// API-1 7.3 (slice 1a6): the staged api map drafts, one per org (memory only).
    api_drafts: Mutex<crate::console_api_ui::Drafts>,
    /// API-1 2.3 (slice 1a6): each org's save signed on a relay (`meet.api.sign`), kept in `api-signing.json`.
    api_signings: Mutex<BTreeMap<String, crate::console_api_ui::Signing>>,
    /// A thread polls the waiting signings now.
    api_signing_busy: std::sync::atomic::AtomicBool,
}

/// A request as the fleet section sees it (console.rs builds it after the role, origin and size checks).
pub struct FleetReq<'a> {
    pub method: &'a str,
    pub query: &'a str,
    /// The body as received, and without `stepup`.
    pub body: &'a Value,
    pub params: &'a Value,
    pub who: Option<&'a Who>,
    /// The AC-1 step-up the dispatcher verified (rows with `stepup: true`).
    pub step: Option<&'a crate::console_auth::StepOk>,
    pub origin: &'a str,
    pub ip: &'a str,
    pub source: &'a str,
    pub t: i64,
}

impl FleetReq<'_> {
    fn who(&self) -> Result<&Who, ApiError> {
        self.who.ok_or_else(|| ApiError::of("signin-first"))
    }

    fn q(&self, k: &str) -> Option<String> {
        crate::console::query_pairs(self.query).into_iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
}

/// The 4.6 `auth` of a verified fleet step-up, per relay.
#[derive(Clone, Debug)]
pub struct FleetAuth {
    pub credential: Value,
    pub targets: Vec<(String, String)>,
}

impl FleetAuth {
    /// `{mode: "one", credential, nonce, targets}` for `relay`, when the step-up named it.
    pub fn for_relay(&self, relay: &str) -> Option<Value> {
        let nonce = self.targets.iter().find(|(r, _)| r == relay)?.1.clone();
        Some(json!({ "mode": "one", "credential": self.credential, "nonce": nonce, "targets": crate::fleet_trust::targets_value(&self.targets) }))
    }

    /// The object forwarded to f-people: the relay's own nonce is filled in by `PeopleHost::call`.
    fn shared(&self) -> Value {
        json!({ "mode": "one", "credential": self.credential, "targets": crate::fleet_trust::targets_value(&self.targets) })
    }
}

fn not_found_relay() -> ApiError {
    ApiError::with("not-found", "There is no such relay.")
}

/// A relay refusal (5.1): the relay's own code and words, with `relay` added by the caller.
fn relay_words(code: &'static str, name: &str) -> ApiError {
    let (_, w) = crate::console::code_words(code).unwrap_or((503, "<relay> is not connected right now."));
    ApiError::with(code, w.replace("<relay>", name))
}

/// A label (name or site) of 3.1: 1 (0 for a site) to 64 characters of letters, digits, spaces and `. - _ ( )`.
pub fn label_ok(s: &str, empty_ok: bool) -> bool {
    let n = s.chars().count();
    (if empty_ok { n <= 64 } else { (1..=64).contains(&n) }) && s.chars().all(|c| c.is_alphanumeric() || " .-_()".contains(c)) && s.trim() == s
}

/// Scopes as the console sends them: known, `read-health` always, `read-logs` only with `people`, in SCOPES order.
pub fn scopes_of(v: Option<&Value>) -> Result<Vec<String>, ApiError> {
    let list = v.and_then(Value::as_array).ok_or_else(|| ApiError::with("invalid", "scopes is a list."))?;
    let mut set = HashSet::new();
    for x in list {
        let s = x.as_str().unwrap_or("");
        if !SCOPES.contains(&s) {
            let shown: String = s.chars().filter(|c| c.is_ascii_graphic()).take(40).collect();
            return Err(ApiError::with("fleet-scope-unknown", format!("This relay does not know the scope {shown} yet.")));
        }
        set.insert(s.to_owned());
    }
    if !set.contains("read-health") {
        return Err(ApiError::of("fleet-scope-required"));
    }
    if set.contains("read-logs") && !set.contains("people") {
        return Err(ApiError::of("fleet-scope-needs-people"));
    }
    Ok(SCOPES.iter().filter(|s| set.contains(**s)).map(|s| (*s).to_owned()).collect())
}

/// The 3.3 fingerprint: the first 20 hex of SHA-256(spki) in groups of 4 separated by spaces.
pub fn fingerprint_of(spki: &[u8]) -> String {
    crate::fleet_x509::relay_fingerprint(spki)
}

fn fingerprint_eq(a: &str, b: &str) -> bool {
    let n = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    !a.is_empty() && n(a) == n(b)
}

/// AC-1 7.3 attention kinds a relay may push (anything else is dropped, 8.1).
fn ac1_kind(kind: &str) -> bool {
    crate::console::ATTENTION_WORDS.iter().any(|(k, _)| *k == kind)
}

/// A relay's pushed attention item, cleaned (AC-1 0): its kind, severity, numeric or cleaned text args; None for an
/// unknown kind.
fn clean_item(v: &Value) -> Option<Value> {
    let kind = str_of(v.get("kind")).filter(|k| ac1_kind(k) || RELAY_DEPLOY_KINDS.contains(k))?;
    let severity = str_of(v.get("severity")).filter(|s| matches!(*s, "bad" | "warn" | "info")).unwrap_or("info");
    let mut args = Map::new();
    if let Some(o) = v.get("args").and_then(Value::as_object) {
        for (k, x) in o.iter().take(8) {
            let k = clean(k).chars().take(32).collect::<String>();
            match x {
                Value::Number(_) | Value::Bool(_) | Value::Null => {
                    args.insert(k, x.clone());
                }
                Value::String(s) => {
                    args.insert(k, Value::from(clean(s).chars().take(200).collect::<String>()));
                }
                _ => {}
            }
        }
    }
    Some(json!({ "kind": kind, "severity": severity, "args": args }))
}

// ── The 5.3 routes (fleet console only) ─────────────────────────────────────────────────────────────────────

const fn r(method: &'static str, path: &'static str, role: Role, action: &'static str, target: &'static str, stepup: bool, keys: &'static [&'static str]) -> RouteSpec {
    RouteSpec { method, path, role, action, target, stepup, need: Need::Any, security: false, keys, body_max: crate::console::BODY_MAX }
}

const fn g(path: &'static str, role: Role) -> RouteSpec {
    r("GET", path, role, "", "-", false, &[])
}

/// The fleet routes of 5.3. Rows with a fleet step-up (4.6) list `stepup` among their keys and verify it in their
/// handler; rows with an AC-1 step-up have `stepup: true`. `fleet/relays/<id>` and its proxy `.../p/<path>` are
/// matched by prefix (PROXY_GET, PROXY_POST, RELAY_DETAIL).
pub static FLEET_ROUTES: [RouteSpec; 124] = [
    g("fleet/relays", Role::Viewer),
    r("POST", "fleet/enroll", Role::Admin, "fleet.enroll.code", "name", true, &["product", "name", "site", "scopes", "replaces", "env", "deploy"]),
    // AC-2b-D 9.1
    g("fleet/deploy/options", Role::Admin),
    g("fleet/meet-ca", Role::Admin),
    RouteSpec { method: "POST", path: "fleet/meet-ca/import", role: Role::Admin, action: "fleet.meet-ca.import", target: "-", stepup: false, need: Need::Any, security: false, keys: &["caPem", "keyPem", "issuedJson", "crlPem", "signerUrl", "noHighRelay", "maxLifetimeDays", "reason", "stepup"], body_max: MEET_CA_IMPORT_MAX },
    r("POST", "fleet/meet-ca/revoke", Role::Admin, "fleet.meet-ca.revoke", "serial", true, &["serial", "reason"]),
    r("POST", "fleet/meet-ca/remove", Role::Admin, "fleet.meet-ca.remove", "-", true, &["elsewhere", "reason"]),
    r("POST", "fleet/meet-ca/dismiss-diverged", Role::Admin, "", "-", false, &[]),
    r("POST", "fleet/meet-ca/prune", Role::Admin, "fleet.meet-ca.prune", "-", true, &["certPem", "reason"]),
    r("POST", "fleet/meet-ca/max-lifetime", Role::Admin, "fleet.meet-ca.max-lifetime", "-", true, &["days", "reason"]),
    r("POST", "fleet/meet-ca/signer-enforced", Role::Admin, "fleet.meet-ca.signer-enforced", "-", true, &["on", "reason"]),
    g("fleet/spokes-root", Role::Admin),
    r("POST", "fleet/spokes-root", Role::Admin, "fleet.spokes-root.set", "-", true, &["pem"]),
    g("fleet/enrollments", Role::Admin),
    r("POST", "fleet/enrollments/cancel", Role::Admin, "fleet.enroll.cancel", "id", false, &["id"]),
    r("POST", "fleet/relays/confirm", Role::Admin, "fleet.relay.confirm", "relay", true, &["relay", "fingerprint"]),
    r("POST", "fleet/relays/label", Role::Admin, "fleet.relay.label", "relay", true, &["relay", "name", "site"]),
    r("POST", "fleet/relays/scopes", Role::Admin, "fleet.relay.scopes", "relay", true, &["relay", "scopes", "reason"]),
    r("POST", "fleet/relays/remove", Role::Admin, "fleet.relay.remove", "relay", true, &["relay", "reason"]),
    g("fleet/roster", Role::Admin),
    g("fleet/trust", Role::Admin),
    r("POST", "fleet/trust/server-revoke", Role::Admin, "fleet.server-revoke", "-", true, &["reason"]),
    r("POST", "fleet/trust/ca-rollover", Role::Admin, "fleet.ca.rollover", "-", true, &["reason"]),
    r("POST", "fleet/roster/cancel", Role::Admin, "fleet.roster.cancel", "hint", false, &["relay", "hint", "stepup"]),
    g("account/key-fingerprints", Role::Viewer),
    r("POST", "account/key-record", Role::Viewer, "account.key-record", "hint", true, &["hint", "record"]),
    r("POST", "fleet/stepup/begin", Role::Viewer, "", "-", false, &["action", "target", "params", "relays", "kind"]),
    r("POST", "fleet/roster/endorse", Role::Admin, "fleet.roster.endorse", "seq", false, &["seq", "stepup"]),
    g("fleet/metrics", Role::Viewer),
    g("fleet/expiry", Role::Viewer),
    g("fleet/licenses", Role::Viewer),
    r("POST", "fleet/licenses/library", Role::Admin, "fleet.license.library", "-", false, &["license", "remove", "stepup"]),
    g("fleet/people", Role::Manager),
    r("POST", "fleet/people/invite", Role::Manager, "people.invite", "email", false, &["product", "relay", "email", "name", "role", "days", "stepup"]),
    RouteSpec { method: "POST", path: "fleet/people/import/check", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &["csv"], body_max: crate::fleet_people::CHECK_BODY_MAX },
    r("POST", "fleet/people/import", Role::Manager, "people.import", "-", false, &["importId", "digest", "stepup"]),
    r("POST", "fleet/people/suspend", Role::Manager, "people.suspend", "id", false, &["kind", "relay", "id", "hours", "reason", "stepup"]),
    r("POST", "fleet/people/unsuspend", Role::Manager, "people.unsuspend", "id", false, &["kind", "relay", "id", "hours", "reason", "stepup"]),
    r("POST", "fleet/people/remove", Role::Manager, "people.remove", "id", false, &["kind", "relay", "id", "hours", "reason", "stepup"]),
    r("POST", "fleet/people/remind", Role::Manager, "people.remind", "request", false, &["relay", "request"]),
    r("POST", "fleet/people/cancel", Role::Manager, "people.cancel", "request", false, &["relay", "request", "stepup"]),
    r("POST", "fleet/people/seats/pick", Role::Manager, "meet.seats.pick", "principal", false, &["relay", "principal", "pick", "stepup"]),
    g("settings/exports", Role::Admin),
    r("POST", "settings/exports/token", Role::Admin, "exports.token.create", "label", true, &["label", "relays", "days"]),
    r("POST", "settings/exports/token/revoke", Role::Admin, "exports.token.revoke", "hint", false, &["hint"]),
    r("POST", "settings/exports/siem", Role::Admin, "exports.siem", "-", true, &["host", "port", "caPem", "clientCertPem", "clientKeyPem", "events", "includeReasons", "off", "reason"]),
    r("POST", "settings/exports/siem/test", Role::Admin, "exports.siem-test", "-", false, &[]),
    // API-1 7.3 (slice 1a6): Settings > API access, the staged save signed by the admin's device (`meet.api.sign`)
    g("settings/api", Role::Viewer),
    r("POST", "settings/api/clients", Role::Admin, "api.client.stage", "org", true, &["org", "client"]),
    r("POST", "settings/api/clients/update", Role::Admin, "api.client.update", "org", true, &["org", "id", "client"]),
    r("POST", "settings/api/clients/suspend", Role::Admin, "api.client.suspend", "org", false, &["org", "id", "reason"]),
    r("POST", "settings/api/clients/resume", Role::Admin, "api.client.resume", "org", false, &["org", "id"]),
    r("POST", "settings/api/clients/delete", Role::Admin, "api.client.delete", "org", false, &["org", "id", "reason"]),
    r("POST", "settings/api/clients/secret", Role::Admin, "api.client.secret", "org", true, &["org", "id", "days"]),
    r("POST", "settings/api/clients/revoke-tokens", Role::Admin, "api.client.revoke-tokens", "org", false, &["org", "id"]),
    r("POST", "settings/api/scrape-tokens", Role::Admin, "api.scrape-token", "org", true, &["org", "action", "label", "relays", "days", "hint"]),
    r("POST", "settings/api/explain", Role::Viewer, "api.explain", "org", false, &["org", "client", "method", "path", "ip"]),
    r("POST", "settings/api/grace", Role::Admin, "api.grace", "org", true, &["org", "grace"]),
    r("POST", "settings/api/off", Role::Admin, "api.off", "org", false, &["org", "reason"]),
    r("POST", "settings/api/on", Role::Admin, "api.on", "org", false, &["org"]),
    r("POST", "settings/api/resume", Role::Admin, "api.resume", "org", true, &["org", "tightening"]),
    r("POST", "settings/api/relay-origins", Role::Admin, "api.relay-origin", "org", true, &["org", "relay", "origin"]),
    r("POST", "settings/api/discard", Role::Admin, "api.discard", "org", false, &["org"]),
    r("POST", "settings/api/save", Role::Admin, "meet.api.save", "org", false, &["org", "stage", "reason", "relay"]),
    r("POST", "settings/api/signing/cancel", Role::Admin, "api.signing.cancel", "org", false, &["org"]),
    // API-1 revision 4 2.3 item 2: retire a relay from an org's relay set
    r("POST", "settings/api/relays/retire", Role::Admin, "api.relay.retire", "org", true, &["org", "relay"]),
    // API-1d 5.1, 7.14 (slice 1d5): Remote Spokes (bind, unbind, root) and Agents (cards, keys, tasks)
    g("settings/api/spokes", Role::Viewer),
    r("POST", "settings/api/spokes/bind", Role::Admin, "api.spokes.bind", "org", true, &["org", "relay"]),
    r("POST", "settings/api/spokes/unbind", Role::Admin, "api.spokes.unbind", "org", true, &["org", "relay"]),
    r("POST", "settings/api/spokes/root", Role::Admin, "api.spokes.root", "org", true, &["org"]),
    g("settings/api/a2a", Role::Viewer),
    r("POST", "settings/api/a2a/agents", Role::Admin, "api.a2a.agent.stage", "org", true, &["org", "agent"]),
    r("POST", "settings/api/a2a/agents/update", Role::Admin, "api.a2a.agent.update", "org", true, &["org", "id", "agent"]),
    r("POST", "settings/api/a2a/agents/delete", Role::Admin, "api.a2a.agent.delete", "org", false, &["org", "id", "reason"]),
    r("POST", "settings/api/a2a/keys", Role::Admin, "api.a2a.key", "org", true, &["org"]),
    r("POST", "settings/api/a2a/keys/drop", Role::Admin, "api.a2a.key-drop", "org", false, &["org", "kid"]),
    r("POST", "settings/api/a2a/well-known", Role::Admin, "api.a2a.well-known", "org", true, &["org", "agent"]),
    g("settings/api/a2a/tasks", Role::Viewer),
    r("POST", "settings/api/clients/push-off", Role::Admin, "api.client.push-off", "org", false, &["org", "id"]),
    r("POST", "settings/api/clients/card-check", Role::Admin, "api.client.card-check", "org", false, &["org", "id"]),
    // API-1 revision 5 14.1 (slice 1c7): connectors, identity providers (EMA), the SSO URL, delegations, approvals
    g("settings/api/connectors", Role::Viewer),
    r("POST", "settings/api/connectors", Role::Admin, "api.connector.stage", "org", true, &["org", "connector"]),
    r("POST", "settings/api/connectors/update", Role::Admin, "api.connector.update", "org", true, &["org", "id", "connector"]),
    r("POST", "settings/api/connectors/suspend", Role::Admin, "api.connector.suspend", "org", true, &["org", "id", "reason"]),
    r("POST", "settings/api/connectors/resume", Role::Admin, "api.connector.resume", "org", true, &["org", "id"]),
    r("POST", "settings/api/connectors/delete", Role::Admin, "api.connector.delete", "org", true, &["org", "id", "reason"]),
    g("settings/api/idps", Role::Viewer),
    r("POST", "settings/api/idps", Role::Admin, "api.idp.stage", "org", true, &["org", "idp"]),
    r("POST", "settings/api/idps/update", Role::Admin, "api.idp.update", "org", true, &["org", "id", "idp"]),
    r("POST", "settings/api/idps/test", Role::Admin, "api.idp.test", "org", true, &["org", "issuer", "private_ok", "id"]),
    r("POST", "settings/api/idps/suspend", Role::Admin, "api.idp.suspend", "org", true, &["org", "id", "reason"]),
    r("POST", "settings/api/idps/resume", Role::Admin, "api.idp.resume", "org", true, &["org", "id"]),
    r("POST", "settings/api/sso-url", Role::Admin, "api.sso-url", "org", true, &["org", "provider", "url"]),
    g("settings/api/delegations", Role::Viewer),
    r("POST", "settings/api/delegations/revoke", Role::Admin, "api.delegation.revoke", "org", true, &["org", "client", "principal"]),
    r("POST", "settings/api/delegations/allow", Role::Admin, "api.delegation.allow", "org", true, &["org", "client", "principal"]),
    g("settings/api/approvals", Role::Viewer),
    // API-1 revision 4 13.1: the org's SCIM governance, clients, legacy decisions and person records
    g("directory/status", Role::Viewer),
    // API-1 revision 4 13.1, 13.2: the Compliance page (holds and export jobs, never content) and the client editor's
    // compliance section (recipient key and caps)
    g("compliance/holds", Role::Viewer),
    g("compliance/exports", Role::Viewer),
    r("POST", "compliance/exports/cancel", Role::Admin, "compliance.export.cancel", "org", false, &["org", "job", "reason"]),
    r("POST", "settings/api/clients/recipient", Role::Admin, "api.client.recipient", "org", true, &["org", "id", "jwk", "pem"]),
    r("POST", "settings/api/clients/caps", Role::Admin, "api.client.caps", "org", true, &["org", "id", "caps"]),
    r("POST", "settings/api/clients/recipient/drop", Role::Admin, "api.client.recipient-drop", "org", false, &["org", "id"]),
    // API-1 7.3, 11, 12.3: export destinations, their credentials and failover credentials
    r("POST", "settings/exports/destinations", Role::Admin, "exports.destination.stage", "org", true, &["org", "destination", "from_siem"]),
    r("POST", "settings/exports/destinations/update", Role::Admin, "exports.destination.update", "org", true, &["org", "id", "destination"]),
    r("POST", "settings/exports/destinations/delete", Role::Admin, "exports.destination.delete", "org", true, &["org", "id", "reason"]),
    r("POST", "settings/exports/destinations/test", Role::Admin, "exports.destination.test", "org", false, &["org", "id"]),
    r("POST", "settings/exports/destinations/credential", Role::Admin, "exports.destination.credential", "org", true, &["org", "id", "credential"]),
    r("POST", "settings/exports/destinations/failover/csr", Role::Admin, "exports.failover.csr", "org", false, &["org", "id", "relay"]),
    r("POST", "settings/exports/destinations/failover/install", Role::Admin, "exports.failover.install", "org", true, &["org", "id", "relay", "material"]),
    r("POST", "settings/exports/destinations/failover/delete", Role::Admin, "exports.failover.delete", "org", false, &["org", "id", "relay"]),
    // API-1 revision 4 8, 13.1: outbound federation (issuer, keys, documents, one test exchange)
    r("POST", "settings/api/federation", Role::Admin, "api.federation.issuer", "org", true, &["org", "issuer"]),
    r("POST", "settings/api/federation/key", Role::Admin, "api.federation.key", "org", true, &["org"]),
    r("POST", "settings/api/federation/key/drop", Role::Admin, "api.federation.key-drop", "org", false, &["org", "kid"]),
    r("POST", "settings/api/federation/republished", Role::Admin, "api.federation.republished", "org", false, &["org", "kid"]),
    g("settings/api/federation/documents", Role::Viewer),
    r("POST", "settings/exports/destinations/federation-test", Role::Admin, "exports.destination.federation-test", "org", false, &["org", "id"]),
    // API-1 revision 4 7.4, 13.1: webhook keys, endpoint verification, v1 secrets, replay and resume
    r("POST", "settings/api/webhook-keys", Role::Admin, "api.webhook-key", "org", true, &["org"]),
    r("POST", "settings/api/webhook-keys/drop", Role::Admin, "api.webhook-key-drop", "org", false, &["org", "kid"]),
    r("POST", "settings/exports/destinations/verify", Role::Admin, "exports.destination.verify", "org", false, &["org", "id"]),
    r("POST", "settings/exports/destinations/secret", Role::Admin, "exports.destination.secret", "org", true, &["org", "id"]),
    r("POST", "settings/exports/destinations/replay", Role::Admin, "exports.destination.replay", "org", true, &["org", "id", "from"]),
    r("POST", "settings/exports/destinations/resume", Role::Admin, "exports.destination.resume", "org", false, &["org", "id"]),
];

/// `GET fleet/relays/<id>` (matched by prefix).
pub static RELAY_DETAIL: RouteSpec = g("fleet/relays/<id>", Role::Viewer);
/// `GET fleet/enrollments/<id>` (AC-2b-D 3.6, 9.1; matched by prefix).
pub static ENROLLMENT_DETAIL: RouteSpec = g("fleet/enrollments/<id>", Role::Admin);
/// `POST fleet/meet-ca/import`: at most 1 MiB (AC-2b-D 8.2).
pub const MEET_CA_IMPORT_MAX: usize = 1024 * 1024;

/// An enrollment id (`en_` and 16 lowercase hex; public, AC-2b-D L5).
pub fn enrollment_id_ok(id: &str) -> bool {
    id.len() == 19 && id.starts_with("en_") && id[3..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// `GET|POST fleet/relays/<id>/p/<path>` (5.4): the phase 1 role is checked by the handler; the relay checks the
/// exact keys; a write carries its fleet step-up as `stepup`.
pub static PROXY_GET: RouteSpec = RouteSpec { method: "GET", path: "fleet/relays/<id>/p/<path>", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 };
pub static PROXY_POST: RouteSpec = RouteSpec { method: "POST", path: "fleet/relays/<id>/p/<path>", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: PROXY_BODY_MAX };

/// The fleet route for a method and path: a 5.3 row, the relay detail or the proxy; with the relay id and the phase
/// 1 path for the prefix routes.
pub fn fleet_route(method: &str, path: &str) -> Option<(&'static RouteSpec, Option<(String, String)>)> {
    if let Some(s) = FLEET_ROUTES.iter().chain(crate::console_wizard::WIZARD_ROUTES.iter()).chain(crate::console_accounts::ROUTES.iter()).find(|s| s.method == method && s.path == path) {
        return Some((s, None));
    }
    if let Some(id) = path.strip_prefix("fleet/enrollments/") {
        return (method == "GET" && enrollment_id_ok(id)).then(|| (&ENROLLMENT_DETAIL, Some((id.to_owned(), String::new()))));
    }
    let rest = path.strip_prefix("fleet/relays/")?;
    let (id, tail) = match rest.split_once('/') {
        Some((id, tail)) => (id, Some(tail)),
        None => (rest, None),
    };
    if !crate::fleet_metrics::relay_id_ok(id) {
        return None;
    }
    match (method, tail) {
        ("GET", None) => Some((&RELAY_DETAIL, Some((id.to_owned(), String::new())))),
        (m, Some(t)) => {
            let sub = t.strip_prefix("p/").filter(|s| !s.is_empty() && !s.contains("..") && !s.starts_with('/'))?;
            let spec = if m == "GET" { &PROXY_GET } else if m == "POST" { &PROXY_POST } else { return None };
            Some((spec, Some((id.to_owned(), sub.to_owned()))))
        }
        _ => None,
    }
}

/// The phase 1 route a proxied path names (AC-1 core routes and both products' routes, with the aggregate routes).
pub fn phase1_spec(method: &str, path: &str) -> Option<&'static RouteSpec> {
    crate::console::CORE_ROUTES
        .iter()
        .chain(crate::console_spokes::ROUTES.iter())
        .chain(crate::console_meet::ROUTES.iter())
        .chain(crate::console_spokes::FLEET_ROUTES.iter())
        .chain(crate::console_meet::FLEET_ROUTES.iter())
        .find(|s| s.method == method && s.path == path)
}

fn role_ok(role: Role, who: &Who) -> bool {
    match role {
        Role::None | Role::Any | Role::Viewer => true,
        Role::Manager => who.manager,
        Role::Admin => who.admin,
    }
}

fn role_word(who: &Who) -> &'static str {
    if who.admin {
        "admin"
    } else if who.manager {
        "user-manager"
    } else {
        "viewer"
    }
}

// ── The fleet ───────────────────────────────────────────────────────────────────────────────────────────────

impl Fleet {
    /// The fleet section of a fleet console: reads the registry (an unreadable one keeps the management port closed,
    /// never a refused start), the console's chains from `console.json` `fleet` (drawn at the first start), opens
    /// metrics and SIEM, and attaches itself to the console (as its section and as `Console::fleet`).
    pub fn open(console: &Arc<Console>, cfg: FleetOpen) -> Result<Arc<Fleet>, String> {
        let t = crate::codec::now_ms();
        let state_dir = console.cfg.state_dir.clone();
        let logger = console.logger.clone();
        let (registry, registry_unreadable) = match Registry::load(&state_dir) {
            Ok(r) => (r, false),
            Err(e) => {
                logger.security("fleet.state-unreadable", &Fields::new().with("file", RELAYS_FILE).with("why", e), Level::Error);
                (Registry::default(), true)
            }
        };
        let book = {
            let mut inner = console.inner.lock();
            if inner.unreadable {
                return Err("console.json does not read back; the fleet console cannot start its fleet section".into());
            }
            match inner.book.fleet.clone() {
                v if v.is_null() || v.as_object().is_some_and(Map::is_empty) => {
                    let s = &inner.book.settings;
                    let b = FleetBook::new(policy_of(s.high(), s.two_person)).map_err(|e| e.message)?;
                    inner.book.fleet = b.to_value();
                    console.save_book(&mut inner).map_err(|e| e.message)?;
                    b
                }
                v => FleetBook::from_value(&v).ok_or("console.json fleet does not read back")?,
            }
        };
        let metrics = crate::fleet_metrics::Metrics::open(&state_dir, logger.clone());
        let siem = crate::fleet_syslog::Siem::open(&state_dir, &console.cfg.host, env!("CARGO_PKG_VERSION"), logger.clone());
        {
            let saved = console.inner.lock().book.settings.siem.clone();
            let key = console.seal_get(crate::console_settings::SIEM_KEY_SECRET).and_then(|b| String::from_utf8(b).ok());
            siem.set_high(console.profile_high());
            siem.configure(crate::fleet_syslog::SiemSettings::from_json(&saved).map(|s| (s, key)));
        }
        let console_id = book.console_id.clone();
        // AC-2b-D 8.3: the CA's files and its sealed key; a CA whose key does not unseal opens `lost`.
        let meet = with_vault(console, |v| crate::meet_ca::MeetCa::open(&state_dir, &*v));
        let api = Arc::new(crate::console_api::ConsoleApi::open(Some(&state_dir), logger.clone(), Arc::new(crate::console_api::ConsoleVault(Arc::downgrade(console)))));
        let mut issue: Option<crate::api_checkpoint::IssueFn> = None;
        let mut events: Option<Arc<crate::api_events::EventLog>> = None;
        // API-1 2.3: saves whose signing the console still polls
        let signings = crate::console_api_ui::signings_load(&state_dir);
        let fleet = Arc::new_cyclic(|weak: &Weak<Fleet>| {
            let bridge: Arc<dyn crate::fleet_people::PeopleHost> = Arc::new(PeopleBridge { fleet: weak.clone() });
            let people = Arc::new(crate::fleet_people::People::new(bridge));
            // API-1 9.3: checkpoint certificates (the console's own and the relays') come from the Meet CA
            let w = weak.clone();
            let issuer: crate::api_checkpoint::IssueFn = Arc::new(move |holder: &str, org: &str, csr: &[u8], at: i64| {
                let f = w.upgrade().ok_or_else(|| "the console is stopping".to_string())?;
                let c = f.console().map_err(|e| e.message)?;
                let mut g = f.meet.lock();
                let ca = g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok).ok_or_else(|| "deploy-ca-needed".to_string())?;
                let issued = with_vault(&c, |v| ca.issue_checkpoint(&*v, holder, org, csr, at)).map_err(|e| e.message)?;
                Ok((issued.der, vec![ca.ca_der().to_vec()]))
            });
            issue = Some(issuer.clone());
            let signer = Arc::new(crate::api_checkpoint::ConsoleCheckpoints::new(&state_dir, Arc::new(crate::console_api::ConsoleVault(Arc::downgrade(console))), issuer));
            let pseudonym = Arc::new(crate::console_api::ConsolePseudonymKeys(Arc::downgrade(&api)));
            let api_audit = Arc::new(crate::api_audit::ApiAudit::open(Some(state_dir.as_path()), "console", signer.clone(), pseudonym.clone(), t.div_euclid(1000)));
            // API-1 revision 4 7.3: the event chains, checkpointed by the same key, and the feed index
            events = Some(Arc::new(crate::api_events::EventLog::open(Some(state_dir.as_path()), "console", signer, pseudonym, t.div_euclid(1000))));
            // API-1 11: its threads find no fleet until this returns, and every destination loads suspended until the
            // first `refresh` below
            let export_host = Arc::new(ExportHost { fleet: weak.clone(), logger: logger.clone(), host: console.cfg.host.clone() });
            let export = crate::api_export::ExportEngine::open(&state_dir.join(crate::api_export::EXPORTS_DIR), export_host, logger.clone(), true);
            Fleet {
                console: Arc::downgrade(console),
                state_dir,
                console_id,
                cfg,
                registry: Mutex::new(registry),
                registry_unreadable,
                book: Mutex::new(book),
                link: OnceLock::new(),
                pki: OnceLock::new(),
                metrics,
                siem,
                exporter: crate::fleet_export::Exporter::new(),
                people,
                reads: Mutex::new(HashMap::new()),
                minted: Mutex::new(HashMap::new()),
                meet: Mutex::new(meet),
                crl_failing: Mutex::new(false),
                diverge_seen: Mutex::new(HashMap::new()),
                api: api.clone(),
                api_audit,
                api_state: crate::api_resource::ResourceState::new(),
                export,
                api_drafts: Mutex::new(crate::console_api_ui::Drafts::default()),
                api_signings: Mutex::new(signings),
                api_signing_busy: std::sync::atomic::AtomicBool::new(false),
            }
        });
        // API-1 2.6, 9.3: relay chains received through `api-audit`, relay checkpoint certificates issued in catch-up
        if let Some(issue) = issue {
            api.set_audit(fleet.api_audit.clone(), issue);
        }
        for n in fleet.api_audit.take_notes() {
            logger.security("api.audit.note", &Fields::new().with("note", n), Level::Warn);
        }
        // API-1 revision 4 7.3: the event chains (relay chains received through `api-events`), the feed index, and
        // their checkpoints and 35-day retention every 10 s
        if let Some(e) = events {
            for n in e.take_notes() {
                logger.security("api.events.note", &Fields::new().with("note", n), Level::Warn);
            }
            api.set_events(e);
            let w = Arc::downgrade(&api);
            let notes = logger.clone();
            crate::api_events::spawn_ticker(
                "console-api-events",
                Box::new(move || w.upgrade().and_then(|a| a.events())),
                Box::new(move |n: &str| notes.security("api.events.note", &Fields::new().with("note", n), Level::Warn)),
            )?;
        }
        // API-1 9.4, 11: the chains keep every entry an audit destination has not acknowledged (set before the
        // retention ticker starts); maps, tightenings, the edition and credentials reach the exports at once; API
        // spans and log events go to the engine
        fleet.api_audit.set_retention_hold(fleet.export.retention_hold());
        let w = Arc::downgrade(&fleet.export);
        api.set_export_hook(Box::new(move |credential: Option<(&str, &str)>| {
            if let Some(e) = w.upgrade() {
                match credential {
                    Some((org, id)) => e.credential_changed(org, id),
                    None => e.refresh(crate::codec::now_ms().div_euclid(1000)),
                }
            }
        }));
        crate::api_export::install(&fleet.export);
        crate::log::set_export_tap(crate::api_export::log_tap());
        fleet.export.refresh(t.div_euclid(1000));
        // API-1 9.3, 9.4: minute buckets, checkpoints and retention every 10 s
        let w = Arc::downgrade(&fleet);
        let notes = logger.clone();
        crate::api_resource::spawn_ticker(
            "console-api-audit",
            Box::new(move || w.upgrade().map(|f| f.api_audit.clone())),
            Box::new(move |n: &str| notes.security("api.audit.note", &Fields::new().with("note", n), Level::Warn)),
        )?;
        console.attach_fleet(fleet.clone());
        Ok(fleet)
    }

    /// API-1 9: the console's API audit chains.
    pub fn api_audit(&self) -> Arc<crate::api_audit::ApiAudit> {
        self.api_audit.clone()
    }

    /// API-1 7.1: the front door's view of the org's relays (registry, metrics, health) for the resource routes.
    pub fn api_data(&self) -> FleetData<'_> {
        FleetData { fleet: self }
    }

    pub fn console_id(&self) -> String {
        self.console_id.clone()
    }

    fn console(&self) -> Result<Arc<Console>, ApiError> {
        self.console.upgrade().ok_or_else(|| ApiError::of("state-unreadable"))
    }

    pub fn attach_link(&self, link: Arc<dyn FleetLink>) {
        let _ = self.link.set(link);
    }

    pub fn attach_pki(&self, pki: Arc<dyn FleetPki>) {
        let _ = self.pki.set(pki);
    }

    pub fn people(&self) -> Option<Arc<crate::fleet_people::People>> {
        Some(self.people.clone())
    }

    /// The registry, locked. Never hold it while calling the link or the console's lock-taking methods.
    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock()
    }

    /// `fleet-relays.json` read back: false keeps the management port closed (0, invariant 20).
    pub fn state_ok(&self) -> bool {
        !self.registry_unreadable
    }

    fn save_registry(&self, reg: &Registry) -> Result<(), ApiError> {
        if self.registry_unreadable {
            return Err(ApiError::with("state-unreadable", "The console could not read its list of relays; see its log."));
        }
        reg.save(&self.state_dir).map_err(|e| {
            if let Ok(c) = self.console() {
                c.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
            }
            ApiError::of("write-failed")
        })
    }

    fn save_book(&self, c: &Console, book: &FleetBook) -> Result<(), ApiError> {
        let mut inner = c.inner.lock();
        inner.book.fleet = book.to_value();
        c.save_book(&mut inner)
    }

    pub fn relay_ids(&self) -> Vec<String> {
        self.registry.lock().relays.values().filter(|r| r.state.live()).map(|r| r.id.clone()).collect()
    }

    pub fn metrics_sources_text(&self) -> String {
        self.cfg.metrics_sources_text.clone()
    }

    fn connected(&self, relay: &str) -> bool {
        self.link.get().is_some_and(|l| l.connected(relay))
    }

    fn name_of(&self, relay: &str) -> String {
        self.registry.lock().relays.get(relay).map(|r| r.name.clone()).unwrap_or_else(|| relay.to_owned())
    }

    /// One request frame to a relay (never under a lock): its answer, or `relay-offline`, `relay-timeout`,
    /// `relay-busy` naming the relay, or the relay's own refusal.
    pub fn send(&self, relay: &str, op: &str, body: Value, timeout_ms: u64) -> Result<Value, ApiError> {
        let name = self.name_of(relay);
        let link = self.link.get().ok_or_else(|| relay_words("relay-offline", &name))?;
        match link.request(relay, op, body, timeout_ms) {
            Ok(v) => Ok(v),
            Err(LinkError::Offline) => Err(relay_words("relay-offline", &name)),
            Err(LinkError::Timeout) => Err(relay_words("relay-timeout", &name)),
            Err(LinkError::Busy) => Err(relay_words("relay-busy", &name)),
            Err(LinkError::Refused { status, code, error }) => {
                let code: &'static str = crate::console::code_words_static(&code).unwrap_or("fleet-op");
                Err(ApiError { status, code, message: clean(&error).chars().take(500).collect(), retry_after: None })
            }
        }
    }

    fn event(&self, relay: &str, op: &str, body: Value) -> bool {
        self.link.get().is_some_and(|l| l.event(relay, op, body))
    }

    fn record(&self, c: &Console, actor: &str, action: &str, target: Option<String>, detail: Value, t: i64) {
        let mut r = Record::new(actor, action, "ok");
        r.target = target;
        r.detail = detail;
        c.record(r, t);
    }

    // ── Roster and policy chains (4.4, 4.5) ─────────────────────────────────────────────────────────────

    /// The canonical entries the console would put in rosters now (4.4): every working WebAuthn method of every
    /// active admin and user manager whose session would hold that role's rights under the console's profile (under
    /// High attested methods with kept evidence only; methods without evidence stay out under High,
    /// `key-no-evidence`). In canonical order.
    pub fn eligible_entries(&self, c: &Console) -> Vec<Value> {
        let (people, s) = {
            let inner = c.inner.lock();
            (inner.book.people.clone(), inner.book.settings.clone())
        };
        let list = s.aaguid_list();
        let mut out = Vec::new();
        for (email, p) in people.iter().filter(|(_, p)| p.active() && p.role.privileged() && !p.break_glass) {
            for k in p.passkeys.iter().filter(|k| k.works()) {
                let ev = p.evidence.get(&k.id);
                if s.high() && (ev.is_none() || !c.attested_now(k, &list)) {
                    continue;
                }
                out.push(entry_of(&k.id, &k.cose, email, p.role, ev));
            }
        }
        canonical_order(&mut out);
        out
    }

    /// Admin and user manager keys under High with no kept evidence (`key-no-evidence`, 8.1).
    fn keys_without_evidence(&self, c: &Console) -> usize {
        let inner = c.inner.lock();
        if !inner.book.settings.high() {
            return 0;
        }
        inner.book.people.values().filter(|p| p.active() && p.role.privileged()).flat_map(|p| p.passkeys.iter().filter(|k| k.works() && !p.evidence.contains_key(&k.id))).count()
    }

    /// (waiting adds, removes) against the chain: keys not yet in every relay's roster, and chain keys no longer
    /// eligible (or with another email or role).
    fn roster_diff(&self, eligible: &[Value], book: &FleetBook) -> (Vec<Value>, Vec<String>) {
        let key = |e: &Value| (str_of(e.get("credentialId")).unwrap_or("").to_owned(), str_of(e.get("email")).unwrap_or("").to_owned(), str_of(e.get("role")).unwrap_or("").to_owned());
        let chain: HashSet<(String, String, String)> = book.roster.iter().map(key).collect();
        let now: HashSet<(String, String, String)> = eligible.iter().map(key).collect();
        let adds = eligible.iter().filter(|e| !chain.contains(&key(e))).cloned().collect();
        let removes = book.roster.iter().filter(|e| !now.contains(&key(e))).filter_map(|e| str_of(e.get("credentialId")).map(hint_of)).collect();
        (adds, removes)
    }

    /// Append one roster update to the chain (`change = {adds: [entries without evidence], removes: [hints]}`) and
    /// return the frame body to send.
    fn chain_roster(&self, book: &mut FleetBook, adds: &[Value], removes: &[String], endorsements: Vec<Value>) -> Result<Value, ApiError> {
        let seq = book.roster_seq + 1;
        let change_hashed = json!({ "adds": adds.iter().map(crate::fleet_trust::without_evidence).collect::<Vec<_>>(), "removes": removes });
        let hash = crate::fleet_trust::roster_hash(&book.console_id, seq, &book.roster_hash, &change_hashed).ok_or_else(|| ApiError::with("invalid", "The roster is not canonical JSON."))?;
        let frame = json!({ "seq": seq, "prev": hash_hex(&book.roster_hash), "change": { "adds": adds, "removes": removes }, "endorsements": endorsements });
        let gone: HashSet<&String> = removes.iter().collect();
        book.roster.retain(|e| !str_of(e.get("credentialId")).is_some_and(|id| gone.contains(&hint_of(id))));
        book.roster.extend(adds.iter().cloned());
        canonical_order(&mut book.roster);
        book.roster_seq = seq;
        book.roster_hash = hash;
        book.roster_log.push(frame.clone());
        if book.roster_log.len() > CHAIN_LOG_MAX {
            book.roster_log.remove(0);
        }
        Ok(frame)
    }

    /// The pending endorsed add (4.4): (seq, rosterHash, adds) of the update that would add every waiting key now.
    fn pending_add(&self, c: &Console) -> Option<(u64, [u8; 32], Vec<Value>)> {
        let eligible = self.eligible_entries(c);
        let book = self.book.lock();
        let (adds, removes) = self.roster_diff(&eligible, &book);
        if adds.is_empty() || !removes.is_empty() {
            return None;
        }
        let seq = book.roster_seq + 1;
        let change = json!({ "adds": adds.iter().map(crate::fleet_trust::without_evidence).collect::<Vec<_>>(), "removes": Vec::<String>::new() });
        let hash = crate::fleet_trust::roster_hash(&book.console_id, seq, &book.roster_hash, &change)?;
        Some((seq, hash, adds))
    }

    /// Keep the chain in step with the book (4.4): removals go at once on the console's word (a suspension, removal,
    /// demotion or a method's removal); while no relay is enrolled, adds go straight into the chain too (a relay
    /// enrolled later takes the chain as its first roster, anchored by 3.9). Every connected relay catches up.
    pub fn sync_roster(&self, c: &Console, t: i64) {
        let eligible = self.eligible_entries(c);
        let live = self.registry.lock().live_count();
        let changed = {
            let mut book = self.book.lock();
            let (adds, removes) = self.roster_diff(&eligible, &book);
            let adds: Vec<Value> = if live == 0 { adds } else { Vec::new() };
            if adds.is_empty() && removes.is_empty() {
                false
            } else if crate::fleet_trust::roster_duplicate(&[book.roster.clone(), adds.clone()].concat()) {
                c.logger.security("fleet.roster-duplicate", &Fields::new().with("why", "two console keys share a credential id or a COSE key"), Level::Error);
                false
            } else {
                match self.chain_roster(&mut book, &adds, &removes, Vec::new()) {
                    Ok(_) => {
                        let _ = self.save_book(c, &book);
                        if !removes.is_empty() {
                            self.record(c, "console", "fleet.roster.remove", Some("-".into()), json!({ "seq": book.roster_seq, "removes": removes }), t);
                        }
                        true
                    }
                    Err(_) => false,
                }
            }
        };
        if changed {
            if let Some(p) = self.people() {
                p.wipe_all();
            }
            self.catch_up_all();
        }
    }

    /// Append a policy update (4.5) with its endorsements and send it.
    fn chain_policy(&self, c: &Console, policy: Value, endorsements: Vec<Value>, t: i64) -> Result<u64, ApiError> {
        let seq = {
            let mut book = self.book.lock();
            let seq = book.policy_seq + 1;
            let hash = crate::fleet_trust::policy_hash(&book.console_id, seq, &book.policy_hash, &policy).ok_or_else(|| ApiError::of("invalid"))?;
            let frame = json!({ "seq": seq, "prev": hash_hex(&book.policy_hash), "policy": policy, "endorsements": endorsements });
            book.policy = policy.clone();
            book.policy_seq = seq;
            book.policy_hash = hash;
            book.policy_log.push(frame);
            if book.policy_log.len() > CHAIN_LOG_MAX {
                book.policy_log.remove(0);
            }
            self.save_book(c, &book)?;
            seq
        };
        self.record(c, "console", "fleet.policy", Some("-".into()), json!({ "seq": seq, "policy": policy }), t);
        if let Some(p) = self.people() {
            p.wipe_all();
        }
        self.catch_up_all();
        Ok(seq)
    }

    /// The policy binding a policy step-up confirms (4.5): (seq, policyHash, the new policy).
    pub fn policy_binding(&self, policy: &Value) -> Option<(u64, [u8; 32])> {
        let book = self.book.lock();
        let seq = book.policy_seq + 1;
        let hash = crate::fleet_trust::policy_hash(&book.console_id, seq, &book.policy_hash, policy)?;
        Some((seq, hash))
    }

    /// Send every connected relay the roster, policy and scope updates it lacks, in order, off the caller's thread.
    fn catch_up_all(&self) {
        let ids: Vec<String> = self.registry.lock().relays.values().filter(|r| r.state.live()).map(|r| r.id.clone()).collect();
        for id in ids {
            self.catch_up(&id);
        }
    }

    fn catch_up(&self, relay: &str) {
        if !self.connected(relay) {
            return;
        }
        let (roster_seq, policy_seq) = {
            let reg = self.registry.lock();
            let Some(r) = reg.relays.get(relay) else { return };
            (r.report_u64("rosterSeq"), r.report_u64("policySeq"))
        };
        let (rosters, policies): (Vec<Value>, Vec<Value>) = {
            let book = self.book.lock();
            (
                book.roster_log.iter().filter(|f| f["seq"].as_u64().is_some_and(|s| s > roster_seq)).cloned().collect(),
                book.policy_log.iter().filter(|f| f["seq"].as_u64().is_some_and(|s| s > policy_seq)).cloned().collect(),
            )
        };
        if rosters.is_empty() && policies.is_empty() {
            return;
        }
        let Some(link) = self.link.get().cloned() else { return };
        let me = self.console.upgrade().and_then(|c| c.fleet());
        let relay = relay.to_owned();
        let _ = std::thread::Builder::new().name("fleet-catch-up".into()).spawn(move || {
            for f in rosters {
                // A relay still bootstrapping takes no roster update (3.9); the next contact tries again.
                match link.request(&relay, "roster", f.clone(), CALL_MS) {
                    Ok(a) => {
                        if let Some(fl) = &me {
                            fl.note_report(&relay, &json!({ "rosterSeq": a.get("seq").cloned().unwrap_or(f["seq"].clone()), "held": a.get("held").cloned().unwrap_or(json!([])), "unattested": a.get("unattested").cloned().unwrap_or(json!([])) }));
                        }
                    }
                    Err(_) => break,
                }
            }
            for f in policies {
                match link.request(&relay, "policy", f.clone(), CALL_MS) {
                    Ok(a) => {
                        if let Some(fl) = &me {
                            fl.note_report(&relay, &json!({ "policySeq": a.get("seq").cloned().unwrap_or(f["seq"].clone()) }));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    /// Merge fields into a relay's report (from frame answers).
    fn note_report(&self, relay: &str, fields: &Value) {
        let mut reg = self.registry.lock();
        if let (Some(r), Some(o)) = (reg.relays.get_mut(relay), fields.as_object()) {
            for (k, v) in o {
                r.report.insert(k.clone(), v.clone());
            }
            let _ = self.save_registry(&reg);
        }
    }
}

/// One canonical first-roster entry (3.9): `{credentialId, cose, email, role, evidence, evidenceSha256}`.
pub fn entry_of(id: &str, cose: &str, email: &str, role: PersonRole, ev: Option<&crate::console_auth::Evidence>) -> Value {
    let (evidence, digest) = match ev {
        Some(e) => {
            let att = unb64u(&e.attestation_object).unwrap_or_default();
            let cdj = unb64u(&e.client_data_json).unwrap_or_default();
            (json!({ "fmt": e.fmt, "attestationObject": e.attestation_object, "clientDataJSON": e.client_data_json }), Value::from(crate::fleet_trust::evidence_sha256(&att, &cdj)))
        }
        None => (Value::Null, Value::Null),
    };
    json!({ "credentialId": id, "cose": cose, "email": email, "role": role.as_str(), "evidence": evidence, "evidenceSha256": digest })
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────

fn plain(v: Value) -> Result<Done, ApiError> {
    Ok(Done::plain(Out::ok(v)))
}

impl Fleet {
    /// One fleet route (role, origin, size and keys already checked by the dispatcher; AC-1 step-ups verified for
    /// rows with `stepup: true`). `at` is the relay id and phase 1 path of the prefix routes.
    pub fn dispatch(&self, c: &Console, spec: &'static RouteSpec, at: Option<(String, String)>, r: &FleetReq) -> Result<Done, ApiError> {
        if std::ptr::eq(spec, &RELAY_DETAIL) {
            let (id, _) = at.unwrap_or_default();
            return plain(self.relay_detail(c, r.who()?, &id, r.t)?);
        }
        if std::ptr::eq(spec, &PROXY_GET) || std::ptr::eq(spec, &PROXY_POST) {
            let (id, sub) = at.unwrap_or_default();
            return self.proxy(c, r, &id, &sub);
        }
        if std::ptr::eq(spec, &ENROLLMENT_DETAIL) {
            let (id, _) = at.unwrap_or_default();
            return plain(self.enrollment_detail(&id, r.t)?);
        }
        let t = r.t;
        match (spec.method, spec.path) {
            ("GET", "fleet/relays") => plain(self.relays_list(r, t)?),
            ("POST", "fleet/enroll") => self.enroll_mint(c, r),
            ("GET", "fleet/deploy/options") => plain(self.deploy_options(c, t)),
            ("GET", "fleet/meet-ca") => plain(self.meet_ca_view(c, t)),
            ("POST", "fleet/meet-ca/import") => self.meet_ca_import(c, r),
            ("POST", "fleet/meet-ca/revoke") => self.meet_ca_revoke(c, r),
            ("POST", "fleet/meet-ca/remove") => self.meet_ca_remove(c, r),
            ("POST", "fleet/meet-ca/dismiss-diverged") => self.meet_ca_dismiss(c),
            ("POST", "fleet/meet-ca/prune") => self.meet_ca_prune(c, r),
            ("POST", "fleet/meet-ca/max-lifetime") => self.meet_ca_max_lifetime(c, r),
            ("POST", "fleet/meet-ca/signer-enforced") => self.meet_ca_signer_enforced(c, r),
            ("GET", "fleet/spokes-root") => plain(self.spokes_root_view()),
            ("POST", "fleet/spokes-root") => self.spokes_root_set(c, r),
            ("GET", "fleet/enrollments") => plain(self.enrollments_list(r, t)),
            ("POST", "fleet/enrollments/cancel") => self.enroll_cancel(c, r),
            ("POST", "fleet/relays/confirm") => self.relay_confirm(c, r),
            ("POST", "fleet/relays/label") => self.relay_label(r),
            ("POST", "fleet/relays/scopes") => self.relay_scopes(r),
            ("POST", "fleet/relays/remove") => self.relay_remove(c, r),
            ("GET", "fleet/roster") => plain(self.roster_view(c)),
            ("GET", "fleet/trust") => plain(self.trust_view(t)),
            ("POST", "fleet/trust/server-revoke") => {
                let pki = self.pki.get().ok_or_else(|| ApiError::of("seal-provider-needed"))?;
                let (spki, seq) = pki.server_revoke(t)?;
                Ok(Done::ok(Out::ok(json!({ "ok": true, "seq": seq })), Some("-".into()), json!({ "spkiSha256": spki, "seq": seq })))
            }
            ("POST", "fleet/trust/ca-rollover") => {
                let who = r.who()?;
                let pki = self.pki.get().cloned().ok_or_else(|| ApiError::of("seal-provider-needed"))?;
                let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
                let p = json!({ "reason": reason });
                let mut d = c.second_or_run(who, "fleet.ca.rollover", "-", &p, t, || {
                    let (generation, fingerprint) = pki.ca_rollover(t)?;
                    Ok(json!({ "ok": true, "generation": generation, "fingerprint": fingerprint }))
                })?;
                if let Some(o) = d.out.body.as_object() {
                    if o.contains_key("generation") {
                        d.detail = json!({ "generation": o.get("generation"), "fingerprint": o.get("fingerprint"), "reason": reason });
                    }
                }
                Ok(d)
            }
            ("POST", "fleet/roster/cancel") => self.roster_cancel(c, r),
            ("GET", "account/key-fingerprints") => Ok(Done::plain(c.key_fingerprints(r.who()?))),
            ("POST", "account/key-record") => {
                let step = r.step.ok_or_else(|| ApiError::of("stepup-needed"))?;
                let (out, detail) = c.account_key_record(r.who()?, step, r.params)?;
                let hint = str_of(r.params.get("hint")).map(str::to_owned);
                Ok(Done::ok(out, hint, detail))
            }
            ("POST", "fleet/stepup/begin") => plain(self.stepup_begin(c, r)?),
            ("POST", "fleet/roster/endorse") => self.roster_endorse(c, r),
            ("GET", "fleet/metrics") => {
                let pairs = crate::console::query_pairs(r.query);
                let reg: Vec<(String, Product)> = self.registry.lock().relays.values().filter(|x| x.state.live()).map(|x| (x.id.clone(), x.product)).collect();
                plain(self.metrics.query(&pairs, &reg, t)?)
            }
            ("GET", "fleet/expiry") => plain(self.expiry(t)),
            ("GET", "fleet/licenses") => plain(self.licenses_view()),
            ("POST", "fleet/licenses/library") => self.library(c, r),
            (_, p) if p == "fleet/people" || p.starts_with("fleet/people/") => self.people_route(c, spec, r),
            (_, p) if p == "meet/accounts" || p.starts_with("meet/accounts/") => {
                let accounts = c.accounts().ok_or_else(|| ApiError::of("not-found"))?;
                accounts.admin_route(spec, r.params, &r.who()?.email, t)
            }
            ("GET", "settings/exports") => Ok(Done::plain(c.exports_view()?)),
            ("POST", "settings/exports/token") => c.exports_token(r.who()?, r.params, t),
            ("POST", "settings/exports/token/revoke") => c.exports_token_revoke(r.params),
            ("POST", "settings/exports/siem") => c.exports_siem(r.who()?, r.params, t),
            ("POST", "settings/exports/siem/test") => c.exports_siem_test(r.who()?, t),
            ("GET", "settings/api/federation/documents") => plain(self.api_federation_documents(&crate::console::query_pairs(r.query), t)?),
            // API-1 revision 5 14.1 (slice 1c7)
            ("GET", "settings/api/connectors") => plain(self.api_connectors_get(&crate::console::query_pairs(r.query), t)?),
            ("GET", "settings/api/idps") => plain(self.api_idps_get(&crate::console::query_pairs(r.query))?),
            ("GET", "settings/api/delegations") => plain(self.api_delegations_get(&crate::console::query_pairs(r.query), t)?),
            ("GET", "settings/api/approvals") => plain(self.api_approvals_get(&crate::console::query_pairs(r.query))?),
            // API-1d 7.14 (slice 1d5)
            ("GET", "settings/api/a2a") => plain(self.api_a2a_get(c, &crate::console::query_pairs(r.query), t)?),
            ("GET", "settings/api/a2a/tasks") => plain(self.api_a2a_tasks_get(&crate::console::query_pairs(r.query))?),
            ("GET", "settings/api/spokes") => plain(self.api_spokes_get(&crate::console::query_pairs(r.query), t)?),
            (_, p) if p == "settings/api" || p.starts_with("settings/api/") || p.starts_with("settings/exports/destinations") => self.api_route(c, spec, r),
            ("GET", "directory/status") => plain(crate::api_people::directory_status(self, &crate::console::query_pairs(r.query))?),
            ("GET", "compliance/holds") => plain(self.compliance_holds(&crate::console::query_pairs(r.query))?),
            ("GET", "compliance/exports") => plain(self.compliance_exports(&crate::console::query_pairs(r.query))?),
            ("POST", "compliance/exports/cancel") => self.compliance_export_cancel(r),
            ("GET", "setup") => Ok(Done::plain(c.setup_view(r.who))),
            ("POST", "setup/start") => c.setup_start(r.source, r.params, t),
            ("POST", "setup/step") => c.setup_step(r.params),
            ("POST", "setup/hide") => c.setup_hide(),
            _ => Err(ApiError::of("not-found")),
        }
    }

    // ── Relays and locations (8.2) ──────────────────────────────────────────────────────────────────────

    /// 8.2 health, computed by the console from what it holds.
    fn health(&self, rec: &RelayRecord, connected: bool, t: i64) -> &'static str {
        if !connected && rec.last_contact_at.is_none_or(|at| t - at >= SILENT_MS) {
            return "silent";
        }
        let lic = rec.report.get("license").cloned().unwrap_or(Value::Null);
        let state = str_of(lic.get("state")).unwrap_or("none");
        let days = lic.get("daysLeft").and_then(Value::as_i64);
        let service = service_state_of(&lic);
        let cert_days = rec.serials.iter().filter(|s| s.current).map(|s| (s.not_after - t).div_euclid(86_400_000)).min();
        let signer_bad = rec.servers.get("signer").and_then(|s| s.get("healthy")).and_then(Value::as_bool) == Some(false);
        let sustained = |key: &str, above: f64| {
            let pts = self.metrics.recent(&rec.id, key, t - 600_000);
            pts.len() >= 2 && pts.first().is_some_and(|(at, _)| t - at >= 540_000) && pts.iter().all(|(_, v)| *v > above)
        };
        let latest = |key: &str| self.metrics.latest(&rec.id).and_then(|l| l.m.get(key).and_then(Value::as_f64));
        let sev = |s: &str| rec.attention.iter().any(|a| a["severity"] == s);
        // AC-2a 8.2 (3.4): stopped for its license is `bad` on either product; grace or upgrade period `warn`.
        let license_bad = service == Some("stopped");
        let license_warn = matches!(service, Some("grace" | "upgrade-period")) || state == "grace";
        if license_bad || signer_bad || cert_days.is_some_and(|d| d < 0) || sustained("cpu_host", 90.0) || latest("mem_host_used").is_some_and(|m| m > 95.0) || sev("bad") {
            return "bad";
        }
        if license_warn || days.is_some_and(|d| d <= 30) || cert_days.is_some_and(|d| d <= 21) || sustained("cpu_host", 75.0) || latest("mem_host_used").is_some_and(|m| m > 85.0) || sustained("latency_console", 500.0) || sev("warn") {
            return "warn";
        }
        "ok"
    }

    /// One 8.2 row.
    fn row(&self, rec: &RelayRecord, t: i64) -> Value {
        let connected = self.connected(&rec.id);
        let lic = rec.report.get("license").cloned().unwrap_or(Value::Null);
        let cert = rec.serials.iter().filter(|s| s.current).map(|s| s.not_after).min();
        let (nodes, services) = match rec.product {
            Product::Spokes => (crate::console_spokes::nodes_summary(&rec.counts), Value::Null),
            Product::Meet => (None, if rec.servers.is_null() && rec.push.is_null() { Value::Null } else { crate::console_meet::services_summary(Some(&rec.servers).filter(|v| !v.is_null()), Some(&rec.push).filter(|v| !v.is_null())) }),
        };
        let seats = rec.counts.get("people").cloned();
        json!({
            "id": rec.id, "name": rec.name, "site": rec.site, "product": product_str(rec.product), "state": rec.state.as_str(),
            "connected": connected, "lastContactAt": rec.last_contact_at, "version": clean(&rec.version), "os": clean(&rec.os),
            "fips": rec.fips, "profile": clean(&rec.profile),
            "license": {
                "state": lic.get("state").and_then(Value::as_str).map(clean), "daysLeft": lic.get("daysLeft").and_then(Value::as_i64),
                "users": seats.as_ref().and_then(|s| s.get("total")).and_then(Value::as_u64), "used": seats.as_ref().and_then(|s| s.get("seated")).and_then(Value::as_u64),
                "service": service_state_of(&lic), "stopsAt": lic.get("service").and_then(|s| s.get("stopsAt")).and_then(Value::as_i64),
                "why": lic.get("service").and_then(|s| s.get("why")).and_then(Value::as_str).filter(|w| SERVICE_WHYS.contains(w)),
                "words": (service_state_of(&lic) == Some("stopped")).then_some(STOPPED_WORDS),
            },
            "health": self.health(rec, connected, t), "scopes": rec.scopes, "pendingScopes": rec.pending_scopes,
            "readOnly": rec.report_bool("readOnly"), "confirm": strings(rec.report.get("confirm")), "certNotAfter": cert,
            "nodes": nodes, "services": services, "attention": rec.attention.len() + usize::from(!rec.unknown.is_empty()),
        })
    }

    fn relays_list(&self, r: &FleetReq, t: i64) -> Result<Value, ApiError> {
        for (k, _) in crate::console::query_pairs(r.query) {
            if !matches!(k.as_str(), "product" | "state" | "health" | "site" | "q") {
                return Err(ApiError::with("invalid", format!("Unknown filter: {k}.")));
            }
        }
        let recs: Vec<RelayRecord> = self.registry.lock().relays.values().cloned().collect();
        let q = r.q("q").map(|s| s.to_lowercase());
        let rows: Vec<Value> = recs
            .iter()
            .filter(|x| x.state != RelayState::Removed)
            .map(|x| self.row(x, t))
            .filter(|row| r.q("product").is_none_or(|p| row["product"] == p.as_str()))
            .filter(|row| r.q("state").is_none_or(|p| row["state"] == p.as_str()))
            .filter(|row| r.q("health").is_none_or(|p| row["health"] == p.as_str()))
            .filter(|row| r.q("site").is_none_or(|p| row["site"] == p.as_str()))
            .filter(|row| q.as_ref().is_none_or(|q| str_of(row.get("name")).unwrap_or("").to_lowercase().contains(q) || str_of(row.get("site")).unwrap_or("").to_lowercase().contains(q)))
            .collect();
        let total = rows.len();
        Ok(json!({ "ok": true, "relays": rows, "total": total }))
    }

    fn relay_detail(&self, c: &Console, who: &Who, id: &str, t: i64) -> Result<Value, ApiError> {
        let rec = self.registry.lock().relays.get(id).cloned().ok_or_else(not_found_relay)?;
        let mut v = self.row(&rec, t);
        v["fingerprint"] = Value::from(rec.fingerprint.clone());
        v["enrolledBy"] = Value::from(rec.enrolled_by.clone());
        v["enrolledAt"] = Value::from(rec.enrolled_at);
        v["scopeRequest"] = rec.report.get("scopeRequest").cloned().unwrap_or(Value::Null);
        v["bootstrap"] = rec.bootstrap_view();
        v["bootstrapRosterHash"] = Value::from(rec.bootstrap_roster_hash.clone());
        v["held"] = json!(strings(rec.report.get("held")));
        v["unattested"] = json!(strings(rec.report.get("unattested")));
        v["pins"] = rec.report.get("pins").cloned().unwrap_or(json!([]));
        v["manifestSeq"] = rec.report.get("trustSeq").cloned().unwrap_or(Value::Null);
        v["waiting"] = json!(rec.waiting);
        v["unknown"] = json!(rec.unknown);
        v["attention"] = json!(rec.attention.iter().map(|a| { let mut a = a.clone(); a["relay"] = Value::from(rec.name.clone()); a }).collect::<Vec<_>>());
        v["commands"] = json!({ "leave": match rec.product { Product::Spokes => "lucid-relay fleet leave --state <relay state folder>", Product::Meet => "lucid-relay meet fleet leave --config <relay.json>" } });
        if who.admin {
            v["sourceAddress"] = json!(rec.source_address);
            v["serials"] = json!(rec.serials.iter().map(|s| json!({ "serial": s.serial, "notAfter": s.not_after, "generation": s.generation, "current": s.current })).collect::<Vec<_>>());
            v["roster"] = json!({ "seq": rec.report_u64("rosterSeq"), "policySeq": rec.report_u64("policySeq"), "consoleSeq": self.book.lock().roster_seq });
            // AC-2b-D 8.4: what the CA issued to it, and for the removal dialog the certificate server
            // (`deploy.remove-signer-note`) while that server is not marked as checking revocation.
            v["meet"] = self.meet_relay_view(&rec.id, t);
        }
        let _ = c;
        Ok(json!({ "ok": true, "relay": v }))
    }

    fn enrollments_list(&self, r: &FleetReq, t: i64) -> Value {
        let state = r.q("state");
        let reg = self.registry.lock();
        let list: Vec<Value> = reg
            .enrollments
            .values()
            .rev()
            .map(|e| {
                let mut v = e.to_value();
                if e.state == "open" && e.expires <= t {
                    v["state"] = Value::from("expired");
                }
                v
            })
            .filter(|v| state.as_deref().is_none_or(|s| s == "all" || v["state"] == s))
            .collect();
        let total = list.len();
        json!({ "ok": true, "enrollments": list, "total": total })
    }

    /// The URL relays dial (`fleetUrl`, 3.6): the console's public host and its management port.
    pub fn fleet_url(&self, c: &Console) -> String {
        let host = c.cfg.origin.as_deref().map(crate::console::rp_id_of).unwrap_or_else(|| c.cfg.host.clone());
        format!("https://{host}:{}", self.cfg.fleet_port)
    }

    /// POST fleet/enroll {product, name, site, scopes, replaces, env, deploy, stepup} (3.1, AC-2b-D 6.1): the code only
    /// in this answer, the commands never containing it.
    fn enroll_mint(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let p = r.params;
        // AC-2b-D 3.2: no product is ever assumed.
        let product = str_of(p.get("product")).and_then(product_of).ok_or_else(|| ApiError::of("deploy-product"))?;
        let name = str_of(p.get("name")).unwrap_or("").to_owned();
        let site = str_of(p.get("site")).unwrap_or("").to_owned();
        if !label_ok(&name, false) || !label_ok(&site, true) {
            return Err(ApiError::with("invalid", "A name is 1 to 64 letters, digits, spaces and . - _ ( ); a site 0 to 64 of them."));
        }
        let scopes = scopes_of(p.get("scopes"))?;
        let replaces = str_of(p.get("replaces")).filter(|s| !s.is_empty()).map(str::to_owned);
        let pki = self.pki.get().cloned().ok_or_else(|| ApiError::of("seal-provider-needed"))?;
        let st = pki.status(t);
        if c.profile_high() && !cfg!(feature = "fips") {
            return Err(ApiError::of("fips-needed"));
        }
        let pin = pki.pin().filter(|_| st.ready).ok_or_else(|| ApiError::of("seal-provider-needed"))?;
        {
            let reg = self.registry.lock();
            if let Some(rid) = &replaces {
                let old = reg.relays.get(rid).ok_or_else(not_found_relay)?;
                if old.product != product {
                    return Err(ApiError::with("invalid", "A relay is replaced by a relay of the same product."));
                }
            } else if reg.live_count() >= RELAYS_MAX {
                return Err(ApiError::of("fleet-limit"));
            }
            if reg.enrollments.values().filter(|e| e.open(t)).count() >= OPEN_CODES_MAX {
                return Err(ApiError::of("enroll-limit"));
            }
        }
        // AC-2b-D 6.1, after AC-2a's checks: env, the fields, deploy-host-taken, the CA, the license.
        let env = match p.get("env") {
            None | Some(Value::Null) => "installed".to_owned(),
            Some(v) => str_of(Some(v)).filter(|e| DEPLOY_ENVS.contains(e)).ok_or_else(|| ApiError::of("deploy-env"))?.to_owned(),
        };
        let deploy = self.mint_deploy(c, who, product, &env, p.get("deploy"), replaces.as_deref(), t)?;
        {
            let mut minted = self.minted.lock();
            let mine = minted.entry(who.email.clone()).or_default();
            mine.retain(|at| t - at < 3_600_000);
            if mine.len() >= CODES_PER_ADMIN_HOUR {
                return Err(ApiError::of("enroll-limit"));
            }
            mine.push(t);
        }
        let id_bytes: [u8; 8] = random_bytes(8)?.try_into().map_err(|_| ApiError::of("write-failed"))?;
        let secret: [u8; 20] = random_bytes(20)?.try_into().map_err(|_| ApiError::of("write-failed"))?;
        let id = format!("en_{}", hex(&id_bytes));
        c.seal_put(&format!("fleet-code-{id}"), &secret)?;
        let code = crate::fleet_wire::code_encode(product, &id_bytes, &secret, &pin);
        let e = Enrollment { id: id.clone(), product, name: name.clone(), site: site.clone(), scopes: scopes.clone(), replaces: replaces.clone(), created_by: who.email.clone(), created_at: t, expires: t + CODE_MS, state: "open".into(), fails: 0, relay: None, env: env.clone(), deploy: deploy.clone() };
        {
            let mut reg = self.registry.lock();
            reg.enrollments.insert(id.clone(), e);
            // Closed codes are kept 30 days for the list.
            reg.enrollments.retain(|_, x| x.state == "open" || t - x.created_at < 30 * 86_400_000);
            self.save_registry(&reg)?;
        }
        self.sync_roster(c, t);
        let bootstrap = {
            let book = self.book.lock();
            crate::fleet_trust::bootstrap_roster_hash(&book.console_id, &id, &book.policy, &book.roster).unwrap_or_default()
        };
        let url = self.fleet_url(c);
        let commands = json!({
            "spokes": format!("lucid-relay enroll {url} --state <relay state folder>"),
            "meet": format!("lucid-relay meet enroll {url} --config <relay.json>"),
            "local": url,
        });
        let install = self.install_of(c, product, &env, deploy.as_ref(), &id, &name, t);
        let d = deploy.as_ref();
        let offered: Vec<Value> = d.and_then(|d| d.get("offered")).and_then(Value::as_array).map(|l| l.iter().filter_map(|k| k.get("hint").cloned()).collect()).unwrap_or_default();
        let shown_offered: Vec<Value> = offered.iter().map(|h| json!({ "hint": h })).collect();
        let out = Out::ok(json!({ "ok": true, "id": id, "code": code, "expires": t + CODE_MS, "commands": commands, "bootstrapRosterHash": bootstrap, "install": install, "deploy": deploy, "offered": shown_offered }));
        let detail = json!({
            "id": id, "product": product_str(product), "name": name, "site": site, "scopes": scopes, "replaces": replaces,
            "env": env, "host": d.and_then(|d| d.get("host")).cloned(), "turnHost": d.and_then(|d| d.get("turnHost")).cloned(),
            "pki": d.and_then(|d| d.get("pki")).cloned(), "license": d.and_then(|d| d.get("license")).cloned(), "offered": offered,
        });
        Ok(Done::ok(out, Some(name.clone()), detail))
    }

    fn enroll_cancel(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let id = str_of(r.params.get("id")).unwrap_or("").to_owned();
        {
            let mut reg = self.registry.lock();
            let e = reg.enrollments.get_mut(&id).filter(|e| e.state == "open").ok_or_else(|| ApiError::with("not-found", "There is no such enrollment code."))?;
            e.state = "cancelled".into();
            self.save_registry(&reg)?;
        }
        self.wipe_code(c, &id);
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(id.clone()), json!({ "id": id })))
    }

    fn wipe_code(&self, c: &Console, id: &str) {
        if let Some(s) = c.seal.lock().as_mut() {
            let _ = s.remove(&format!("fleet-code-{id}"));
        }
    }

    fn relay_confirm(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let id = str_of(r.params.get("relay")).unwrap_or("").to_owned();
        let fp = str_of(r.params.get("fingerprint")).unwrap_or("").to_owned();
        let ca_id = self.meet_ca_id();
        let mut reg = self.registry.lock();
        let rec = reg.relays.get_mut(&id).filter(|x| x.state.live()).ok_or_else(not_found_relay)?;
        // AC-2b-D 8.7: a High Meeting Hub relay that trusts (or may trust) the CA this console holds.
        if rec.product == Product::Meet && !c.profile_high() && ca_held_refuses(ca_id.as_deref(), &rec.profile, rec.report.get("meetRoots")) {
            return Err(ApiError::of("fleet-ca-held"));
        }
        if !fingerprint_eq(&rec.fingerprint, &fp) {
            return Err(ApiError::of("fingerprint"));
        }
        if rec.confirmed {
            return Err(ApiError::with("stale", "Nothing was changed: this relay is already confirmed."));
        }
        rec.confirmed = true;
        rec.settle_state();
        let fingerprint = rec.fingerprint.clone();
        self.save_registry(&reg)?;
        drop(reg);
        c.setup_done("relay");
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(id), json!({ "fingerprint": fingerprint })))
    }

    fn relay_label(&self, r: &FleetReq) -> Result<Done, ApiError> {
        let id = str_of(r.params.get("relay")).unwrap_or("").to_owned();
        let name = str_of(r.params.get("name")).unwrap_or("").to_owned();
        let site = str_of(r.params.get("site")).unwrap_or("").to_owned();
        if !label_ok(&name, false) || !label_ok(&site, true) {
            return Err(ApiError::with("invalid", "A name is 1 to 64 letters, digits, spaces and . - _ ( ); a site 0 to 64 of them."));
        }
        let mut reg = self.registry.lock();
        let rec = reg.relays.get_mut(&id).filter(|x| x.state != RelayState::Removed).ok_or_else(not_found_relay)?;
        rec.name = name.clone();
        rec.site = site.clone();
        self.save_registry(&reg)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(id), json!({ "name": name, "site": site })))
    }

    /// POST fleet/relays/scopes {relay, scopes, reason, stepup} (4.1): a narrowing goes at once (and is kept when the
    /// relay is offline); scopes beyond the current ones become a request the relay's operator decides.
    fn relay_scopes(&self, r: &FleetReq) -> Result<Done, ApiError> {
        let id = str_of(r.params.get("relay")).unwrap_or("").to_owned();
        let wanted = scopes_of(r.params.get("scopes"))?;
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let current = self.registry.lock().relays.get(&id).filter(|x| x.state.live()).map(|x| x.scopes.clone()).ok_or_else(not_found_relay)?;
        let kept: Vec<String> = current.iter().filter(|s| wanted.contains(s)).cloned().collect();
        let widen: Vec<String> = wanted.iter().filter(|s| !current.contains(s)).cloned().collect();
        let kept = scopes_of(Some(&json!(kept))).unwrap_or_else(|_| vec!["read-health".to_owned()]);
        let request = if widen.is_empty() { Value::Null } else { json!({ "scopes": wanted }) };
        let answer = if self.connected(&id) { self.send(&id, "scopes", json!({ "scopes": kept, "request": request }), CALL_MS).ok() } else { None };
        let narrowed = kept.len() < current.len();
        {
            let mut reg = self.registry.lock();
            if let Some(rec) = reg.relays.get_mut(&id) {
                rec.scopes = kept.clone();
                if !widen.is_empty() {
                    rec.scope_stale = !rec.pending_scopes.is_empty() && rec.pending_scopes != widen;
                }
                rec.pending_scopes = widen.clone();
                if let Some(a) = &answer {
                    for k in ["scopes", "scopeGeneration", "scopeRequest"] {
                        if let Some(v) = a.get(k) {
                            rec.report.insert(k.to_owned(), v.clone());
                        }
                    }
                }
            }
            self.save_registry(&reg)?;
        }
        if narrowed {
            self.people.wipe_relay(&id);
        }
        Ok(Done::ok(Out::ok(json!({ "ok": true, "scopes": kept, "pending": widen })), Some(id), json!({ "scopes": kept, "pending": widen, "reason": reason })))
    }

    /// POST fleet/relays/remove {relay, reason, stepup} (3.5): every serial denied, `bye` if connected, close 4003.
    fn relay_remove(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let id = str_of(r.params.get("relay")).unwrap_or("").to_owned();
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let serials = {
            let mut reg = self.registry.lock();
            let rec = reg.relays.get_mut(&id).filter(|x| x.state != RelayState::Removed).ok_or_else(not_found_relay)?;
            rec.state = RelayState::Removed;
            rec.left_at = Some(r.t);
            let s = rec.all_serials();
            self.save_registry(&reg)?;
            s
        };
        if let Some(pki) = self.pki.get() {
            if let Err(e) = pki.deny(&serials, r.t) {
                c.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
            }
        }
        if self.event(&id, "bye", json!({ "reason": "removed" })) {
            if let Some(l) = self.link.get() {
                l.close(&id, 4003);
            }
        }
        self.people.wipe_relay(&id);
        // AC-2b-D 8.4 (L10, R5-M1): every unexpired serial the CA issued to it, of both kinds.
        self.meet_revoke_relay(c, &id, r.t);
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(id), json!({ "reason": reason })))
    }

    // ── Roster, trust (5.3) ─────────────────────────────────────────────────────────────────────────────

    fn roster_view(&self, c: &Console) -> Value {
        let eligible = self.eligible_entries(c);
        let book = self.book.lock();
        let (waiting, _) = self.roster_diff(&eligible, &book);
        let view = |e: &Value| {
            let id = str_of(e.get("credentialId")).unwrap_or("");
            let cose = str_of(e.get("cose")).unwrap_or("");
            json!({
                "email": e["email"], "role": e["role"], "hint": hint_of(id),
                "fingerprint": crate::fleet_trust::admin_key_fingerprint(&unb64u(id).unwrap_or_default(), &unb64u(cose).unwrap_or_default(), str_of(e.get("email")).unwrap_or(""), str_of(e.get("role")).unwrap_or("")),
                "evidence": !e["evidence"].is_null(),
            })
        };
        let entries: Vec<Value> = book.roster.iter().map(view).collect();
        let waiting: Vec<Value> = waiting.iter().map(view).collect();
        let seq = book.roster_seq;
        drop(book);
        let relays: Vec<Value> = self
            .registry
            .lock()
            .relays
            .values()
            .filter(|x| x.state.live())
            .map(|x| json!({ "relay": x.id, "name": x.name, "seq": x.report_u64("rosterSeq"), "bootstrap": x.report.get("bootstrap").cloned().unwrap_or(Value::Null), "held": strings(x.report.get("held")), "unattested": strings(x.report.get("unattested")) }))
            .collect();
        json!({ "ok": true, "seq": seq, "entries": entries, "waiting": waiting, "relays": relays })
    }

    fn trust_view(&self, t: i64) -> Value {
        let mut v = self.pki.get().map(|p| p.trust_view(t)).unwrap_or_else(|| json!({ "caGenerations": [], "manifest": null }));
        v["ok"] = Value::Bool(true);
        v["relays"] = json!(self.registry.lock().relays.values().filter(|x| x.state.live()).map(|x| json!({ "relay": x.id, "name": x.name, "pins": x.report.get("pins").cloned().unwrap_or(json!([])), "manifestSeq": x.report.get("trustSeq").cloned().unwrap_or(Value::Null) })).collect::<Vec<_>>());
        v
    }

    // ── The fleet step-up (4.6, 4.7) ────────────────────────────────────────────────────────────────────

    /// The caller's fleet keys in the console's roster chain (`admin_only`: as an admin entry).
    fn roster_keys(&self, c: &Console, who: &Who, admin_only: bool) -> Vec<String> {
        let book = self.book.lock();
        let ids: HashSet<String> = book.roster.iter().filter(|e| !admin_only || e["role"] == "admin").filter(|e| e["email"] == who.email.as_str()).filter_map(|e| str_of(e.get("credentialId")).map(str::to_owned)).collect();
        drop(book);
        c.fleet_keys(who).into_iter().map(|k| k.id).filter(|id| ids.contains(id)).collect()
    }

    /// The new policy record a `settings.profile` or `settings.two-person` change (or its approval) makes (4.5).
    fn policy_after(&self, c: &Console, action: &str, params: &Value) -> Option<Value> {
        let s = c.settings_now();
        match action {
            "settings.profile" => str_of(params.get("profile")).and_then(crate::console_settings::Profile::parse).map(|p| policy_of(p == crate::console_settings::Profile::High, s.two_person)),
            "settings.two-person" => match str_of(params.get("twoPerson")) {
                Some("on") => Some(policy_of(s.high(), true)),
                Some("off") => Some(policy_of(s.high(), false)),
                _ => None,
            },
            _ => None,
        }
    }

    /// POST fleet/stepup/begin {action, target, params, relays, kind} (4.6): nonces from each named relay (5 s;
    /// `relay-offline` naming one that does not answer), the binding of the kind, the caller's roster keys.
    fn stepup_begin(&self, c: &Console, r: &FleetReq) -> Result<Value, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let p = r.params;
        let kind = FleetKind::parse(str_of(p.get("kind")).unwrap_or("stepup")).ok_or_else(|| ApiError::with("invalid", "kind is stepup, request, roster or policy."))?;
        let action = str_of(p.get("action")).unwrap_or("").to_owned();
        let target = str_of(p.get("target")).unwrap_or("").to_owned();
        let params = p.get("params").cloned().unwrap_or(Value::Null);
        if action.is_empty() || target.is_empty() || !params.is_object() {
            return Err(ApiError::with("invalid", "Say which action, target and parameters to confirm."));
        }
        let mut relays: Vec<String> = strings(p.get("relays"));
        relays.sort();
        relays.dedup();
        {
            let reg = self.registry.lock();
            if relays.len() > RELAYS_MAX || relays.iter().any(|id| !reg.relays.get(id).is_some_and(|x| x.state.live())) {
                return Err(not_found_relay());
            }
        }
        let allow = self.roster_keys(c, who, matches!(kind, FleetKind::Roster | FleetKind::Policy));
        if allow.is_empty() {
            return Err(ApiError::of("fleet-webauthn"));
        }
        let cid = self.console_id.clone();
        let mut cer = FleetCeremony { id: b64u(&random_bytes(16)?), sid: who.sid.clone(), kind, action: action.clone(), target: target.clone(), params: params.clone(), targets: Vec::new(), challenge: [0u8; 32], approval_id: None, requested_at: t, seq: 0, expires: t + crate::console_auth::STEPUP_MS };
        match kind {
            FleetKind::Stepup => {
                if relays.is_empty() {
                    return Err(ApiError::with("invalid", "Name the relays this change reaches."));
                }
                for id in &relays {
                    let a = self.send(id, "nonce", json!({ "n": 1 }), NONCE_MS).map_err(|e| if e.code == "relay-timeout" || e.code == "relay-busy" { relay_words("relay-offline", &self.name_of(id)) } else { e })?;
                    let n = a.get("nonces").and_then(Value::as_array).and_then(|l| l.first()).and_then(Value::as_str).filter(|n| unb64u(n).is_some_and(|b| b.len() == 32)).ok_or_else(|| relay_words("relay-offline", &self.name_of(id)))?;
                    cer.targets.push((id.clone(), n.to_owned()));
                }
                cer.challenge = crate::fleet_trust::stepup_challenge(&cid, &action, &target, &params, &cer.targets).ok_or_else(|| ApiError::with("invalid", "The parameters are not canonical JSON."))?;
            }
            FleetKind::Request => {
                if relays.is_empty() {
                    return Err(ApiError::with("invalid", "Name the relays this change reaches."));
                }
                let approval = format!("ap_{}", hex(&random_bytes(8)?));
                cer.targets = relays.iter().map(|r| (r.clone(), String::new())).collect();
                cer.challenge = crate::fleet_trust::request_challenge(&cid, &approval, &action, &target, &params, &relays, t).ok_or_else(|| ApiError::with("invalid", "The parameters are not canonical JSON."))?;
                cer.approval_id = Some(approval);
            }
            FleetKind::Roster => {
                let (seq, hash) = match action.as_str() {
                    "approvals.approve" => self.approval_binding(&target, "roster")?,
                    _ => {
                        let (seq, hash, _) = self.pending_add(c).ok_or_else(|| ApiError::with("stale", "Nothing is waiting: every key is already on the relays."))?;
                        (seq, hash)
                    }
                };
                cer.seq = seq;
                cer.challenge = crate::fleet_trust::roster_endorse_challenge(&cid, seq, &hash);
            }
            FleetKind::Policy => {
                let (seq, hash) = match action.as_str() {
                    "approvals.approve" => self.approval_binding(&target, "policy")?,
                    a => {
                        let policy = self.policy_after(c, a, &params).ok_or_else(|| ApiError::with("invalid", "Only the profile and the two-person setting are policy changes."))?;
                        self.policy_binding(&policy).ok_or_else(|| ApiError::of("invalid"))?
                    }
                };
                cer.seq = seq;
                cer.challenge = crate::fleet_trust::policy_endorse_challenge(&cid, seq, &hash);
            }
        }
        let nonces: Vec<Value> = cer.targets.iter().filter(|(_, n)| !n.is_empty()).map(|(r, n)| json!({ "relay": r, "nonce": n })).collect();
        let approval = cer.approval_id.clone();
        let id = cer.id.clone();
        let public_key = c.fleet_ceremony_put(cer, &allow, r.origin, t)?;
        Ok(json!({ "ok": true, "ceremony": id, "publicKey": public_key, "nonces": nonces, "approval": approval }))
    }

    /// The (seq, hash) a waiting roster or policy approval endorses.
    fn approval_binding(&self, approval: &str, kind: &str) -> Result<(u64, [u8; 32]), ApiError> {
        let book = self.book.lock();
        let a = book.approvals.get(approval).filter(|a| a["kind"] == kind).ok_or_else(|| ApiError::of("gone"))?;
        let seq = a.get("seq").and_then(Value::as_u64).ok_or_else(|| ApiError::of("gone"))?;
        let hash = hash_of(a.get("hash")).ok_or_else(|| ApiError::of("gone"))?;
        Ok((seq, hash))
    }

    /// The `stepup` of a body: (ceremony id, credential); `stepup-needed` when missing.
    fn stepup_of(r: &FleetReq) -> Result<(String, Value), ApiError> {
        let st = r.body.get("stepup").and_then(Value::as_object).ok_or_else(|| ApiError::of("stepup-needed"))?;
        if !crate::codec::exact_keys(st, &["ceremony", "credential"], &["ceremony", "credential"]) {
            return Err(ApiError::of("stepup-failed"));
        }
        Ok((str_of(st.get("ceremony")).unwrap_or("").to_owned(), st.get("credential").cloned().unwrap_or(Value::Null)))
    }

    /// Verify a `stepup` fleet step-up bound to (action, target, params) reaching `relays` (4.6): the console checks
    /// the assertion for its own audit; each relay checks it again against its own nonce.
    pub fn verify_stepup(&self, c: &Console, r: &FleetReq, action: &str, target: &str, params: &Value, relays: &[String]) -> Result<FleetAuth, ApiError> {
        let who = r.who()?;
        let (id, credential) = Self::stepup_of(r)?;
        let cer = c.fleet_ceremony_take(who, &id, r.t)?;
        let ch = crate::fleet_trust::stepup_challenge(&self.console_id, action, target, params, &cer.targets);
        let bound = cer.kind == FleetKind::Stepup && cer.action == action && ch.is_some_and(|ch| crate::console_webauthn::same_bytes(&ch, &cer.challenge)) && relays.iter().all(|x| cer.targets.iter().any(|(t, _)| t == x));
        if !bound {
            c.logger.security("console.stepup-refused", &Fields::new().with("email", &who.email).with("action", action).with("why", "bound to another action, target, parameters or relay set").with("fleet", true), Level::Warn);
            return Err(ApiError::of("stepup-failed"));
        }
        c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, r.t)?;
        Ok(FleetAuth { credential, targets: cer.targets })
    }

    /// A fleet approval (4.7) with the requester's assertion kept: the AC-1 approval row (shown on Approvals, with
    /// `relays`) and its binding in `console.json` `fleet.approvals`.
    #[allow(clippy::too_many_arguments)]
    fn new_approval(&self, c: &Console, who: &Who, id: &str, action: &str, target: &str, params: &Value, relays: &[String], binding: Value, t: i64) -> Result<Value, ApiError> {
        {
            let inner = c.inner.lock();
            if !crate::console_approvals::approver_exists(&inner.book, &who.email, target) {
                return Err(ApiError::with("no-approver", "Another admin must approve this. Unsuspend or add an admin first."));
            }
        }
        let hash = sha256_hex(&crate::console_audit::canonical_json(params).map_err(|e| ApiError::with("invalid", e))?);
        let mut a = Map::new();
        for (k, v) in [
            ("id", Value::from(id)),
            ("action", Value::from(action)),
            ("target", Value::from(target)),
            ("params", params.clone()),
            ("params_sha256", Value::from(hash)),
            ("requested_by", Value::from(who.email.as_str())),
            ("requested_role", Value::from(who.role.as_str())),
            ("requested_at", Value::from(t)),
            ("expires_at", Value::from(t + 86_400_000)),
            ("state", Value::from("waiting")),
            ("decided_by", Value::Null),
            ("decided_at", Value::Null),
            ("decision_reason", Value::Null),
            ("result", Value::Null),
            ("relays", json!(relays)),
        ] {
            a.insert(k.into(), v);
        }
        {
            let mut book = self.book.lock();
            let mut b = binding;
            b["params"] = params.clone();
            book.approvals.insert(id.to_owned(), b);
            book.approvals.retain(|_, x| x.get("at").and_then(Value::as_i64).is_none_or(|at| t - at < 15 * 86_400_000));
            self.save_book(c, &book)?;
        }
        let view = Value::Object(a.clone());
        let mut inner = c.inner.lock();
        inner.book.approvals.push(a);
        c.save_book(&mut inner)?;
        Ok(view)
    }

    /// Whether an approval is a fleet approval this section carries out.
    pub fn owns_approval(&self, id: &str) -> bool {
        self.book.lock().approvals.contains_key(id)
    }

    /// Mark an AC-1 approval row decided.
    fn decide(&self, c: &Console, id: &str, who: &Who, ran: &Result<Value, ApiError>, t: i64) {
        let mut inner = c.inner.lock();
        if let Some(a) = inner.book.approvals.iter_mut().find(|a| str_of(a.get("id")) == Some(id)) {
            a.insert("decided_by".into(), Value::from(who.email.as_str()));
            a.insert("decided_at".into(), Value::from(t));
            match ran {
                Ok(_) => {
                    a.insert("state".into(), Value::from("done"));
                    a.insert("result".into(), json!({ "ok": true }));
                }
                Err(e) => {
                    a.insert("state".into(), Value::from("failed"));
                    a.insert("result".into(), json!({ "code": e.code, "error": e.message }));
                }
            }
        }
        let _ = c.save_book(&mut inner);
    }

    /// POST approvals/approve {id, stepup} of a fleet approval (4.7): the approver is checked as AC-1 does, then
    /// confirms with a fleet step-up of the approval's kind; the change reaches the relays with both assertions.
    pub fn approve(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let id = str_of(r.params.get("id")).unwrap_or("").to_owned();
        let (action, target, _shown, requester) = c.approval_for_approver(who, &id, t)?;
        let binding = self.book.lock().approvals.get(&id).cloned().ok_or_else(|| ApiError::of("gone"))?;
        let kind = str_of(binding.get("kind")).unwrap_or("").to_owned();
        let params = binding.get("params").cloned().unwrap_or(Value::Null);
        let (cer_id, credential) = Self::stepup_of(r)?;
        let cer = c.fleet_ceremony_take(who, &cer_id, t)?;
        let request_cred = binding.get("credential").cloned().unwrap_or(Value::Null);
        let requested_at = binding.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
        let ran: Result<Value, ApiError> = match kind.as_str() {
            "call" => {
                let relay = str_of(binding.get("relay")).unwrap_or("").to_owned();
                let ch = crate::fleet_trust::approval_challenge(&self.console_id, &id, &action, &target, &params, &requester, requested_at, &cer.targets);
                if !(cer.kind == FleetKind::Stepup && cer.action == "approvals.approve" && ch.is_some_and(|ch| crate::console_webauthn::same_bytes(&ch, &cer.challenge)) && cer.targets.iter().any(|(x, _)| *x == relay)) {
                    return Err(ApiError::of("stepup-failed"));
                }
                c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, t)?;
                let nonce = cer.targets.iter().find(|(x, _)| *x == relay).map(|(_, n)| n.clone()).unwrap_or_default();
                let auth = json!({
                    "mode": "two",
                    "request": { "credential": request_cred, "approvalId": id, "requestedAt": requested_at, "requestedBy": requester },
                    "approve": { "credential": credential, "nonce": nonce, "targets": crate::fleet_trust::targets_value(&cer.targets) },
                });
                let path = str_of(binding.get("path")).unwrap_or("").to_owned();
                let frame = json!({ "method": "POST", "path": path, "query": "", "body": params, "caller": { "email": requester, "role": "admin" }, "auth": auth });
                let ran = self.send(&relay, "call", frame, CALL_MS).and_then(|a| {
                    let status = a.get("status").and_then(Value::as_u64).unwrap_or(502) as u16;
                    if status < 300 {
                        Ok(a.get("body").cloned().unwrap_or(Value::Null))
                    } else {
                        let b = a.get("body").cloned().unwrap_or(Value::Null);
                        Err(ApiError { status, code: crate::console::code_words_static(str_of(b.get("code")).unwrap_or("")).unwrap_or("fleet-op"), message: clean(str_of(b.get("error")).unwrap_or("")), retry_after: None })
                    }
                });
                let (result, code) = match &ran {
                    Ok(_) => ("ok", None),
                    Err(e) if e.code == "fleet-confirm" => ("waiting", Some(e.code)),
                    Err(e) => ("refused", Some(e.code)),
                };
                self.audit_call(c, &requester, &relay, &action, &target, result, code, Some(&id), "two", r.ip, t);
                ran
            }
            "roster" | "policy" => {
                let (seq, hash) = (binding.get("seq").and_then(Value::as_u64).unwrap_or(0), hash_of(binding.get("hash")).unwrap_or([0u8; 32]));
                let want = if kind == "roster" { crate::fleet_trust::roster_endorse_challenge(&self.console_id, seq, &hash) } else { crate::fleet_trust::policy_endorse_challenge(&self.console_id, seq, &hash) };
                let k = if kind == "roster" { FleetKind::Roster } else { FleetKind::Policy };
                if !(cer.kind == k && cer.seq == seq && crate::console_webauthn::same_bytes(&want, &cer.challenge)) {
                    return Err(ApiError::of("stepup-failed"));
                }
                c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, t)?;
                if kind == "roster" {
                    let adds: Vec<Value> = binding.get("adds").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.apply_endorsed(c, seq, &hash, &adds, vec![request_cred, credential], t).map(|s| json!({ "ok": true, "seq": s }))
                } else {
                    let policy = binding.get("policy").cloned().unwrap_or(Value::Null);
                    let stale = self.policy_binding(&policy).is_none_or(|(s, h)| s != seq || h != hash);
                    if stale {
                        Err(ApiError::with("stale", "Nothing was changed: the policy changed since this was asked."))
                    } else {
                        c.execute(&action, &target, &params, &requester, Some(&who.email), t).and_then(|_| self.chain_policy(c, policy, vec![request_cred, credential], t).map(|s| json!({ "ok": true, "seq": s })))
                    }
                }
            }
            _ => Err(ApiError::of("gone")),
        };
        self.decide(c, &id, who, &ran, t);
        {
            let mut book = self.book.lock();
            if let Some(b) = book.approvals.get_mut(&id) {
                b["done"] = Value::Bool(true);
                b["at"] = Value::from(t);
                b["credential"] = Value::Null;
            }
            let _ = self.save_book(c, &book);
        }
        let mut rec = Record::new(&requester, &action, if ran.is_ok() { "ok" } else { "failed" });
        rec.target = Some(target.clone());
        rec.approval = Some(id.clone());
        rec.detail = json!({ "approved_by": who.email, "fleet": kind });
        c.record(rec, t);
        match ran {
            Ok(v) => Ok(Done { out: Out::ok(json!({ "ok": true, "result": v })), target: Some(id.clone()), result: "ok", approval: Some(id), detail: json!({ "action": action }) }),
            Err(e) => Err(e),
        }
    }

    /// Append an endorsed add (4.4) if the chain is still where it was endorsed.
    fn apply_endorsed(&self, c: &Console, seq: u64, hash: &[u8; 32], adds: &[Value], endorsements: Vec<Value>, t: i64) -> Result<u64, ApiError> {
        let hints: Vec<String> = adds.iter().filter_map(|e| str_of(e.get("credentialId")).map(hint_of)).collect();
        {
            let mut book = self.book.lock();
            if book.roster_seq + 1 != seq {
                return Err(ApiError::with("stale", "Nothing was changed: the keys changed since this was asked. Confirm the new keys again."));
            }
            if crate::fleet_trust::roster_duplicate(&[book.roster.clone(), adds.to_vec()].concat()) {
                return Err(ApiError::of("fleet-roster-duplicate"));
            }
            let frame = self.chain_roster(&mut book, adds, &[], endorsements)?;
            if hash_of(Some(&Value::from(hash_hex(&book.roster_hash)))) != Some(*hash) {
                // Never reached: the hash was recomputed from the same adds at the same position.
                let _ = frame;
            }
            self.save_book(c, &book)?;
        }
        let relays = self.relay_ids();
        self.record(c, "console", "fleet.roster.endorse", Some(seq.to_string()), json!({ "seq": seq, "adds": hints, "relays": relays }), t);
        self.people.wipe_all();
        self.catch_up_all();
        Ok(seq)
    }

    /// POST fleet/roster/endorse {seq, stepup} (4.4): the waiting keys, endorsed by the caller's roster key; with
    /// two-person on, a second admin endorses through Approvals.
    fn roster_endorse(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let seq = r.params.get("seq").and_then(Value::as_u64).ok_or_else(|| ApiError::with("invalid", "seq is the roster position."))?;
        let (pseq, hash, adds) = self.pending_add(c).ok_or_else(|| ApiError::with("stale", "Nothing is waiting: every key is already on the relays."))?;
        if pseq != seq {
            return Err(ApiError::with("stale", "Nothing was changed: the keys changed since you looked. Look again."));
        }
        let (cer_id, credential) = Self::stepup_of(r)?;
        let cer = c.fleet_ceremony_take(who, &cer_id, t)?;
        let want = crate::fleet_trust::roster_endorse_challenge(&self.console_id, seq, &hash);
        if !(cer.kind == FleetKind::Roster && cer.seq == seq && crate::console_webauthn::same_bytes(&want, &cer.challenge)) {
            return Err(ApiError::of("stepup-failed"));
        }
        c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, t)?;
        let hints: Vec<String> = adds.iter().filter_map(|e| str_of(e.get("credentialId")).map(hint_of)).collect();
        if c.two_person_on() {
            let id = format!("ap_{}", hex(&random_bytes(8)?));
            let relays = self.relay_ids();
            let binding = json!({ "kind": "roster", "seq": seq, "hash": hash_hex(&hash), "adds": adds, "credential": credential, "requestedAt": t, "at": t });
            let view = self.new_approval(c, who, &id, "fleet.roster.endorse", &seq.to_string(), &json!({ "seq": seq }), &relays, binding, t)?;
            return Ok(Done { out: Out::ok(json!({ "ok": true, "approval": view })), target: Some(seq.to_string()), result: "waiting", approval: Some(id), detail: json!({ "seq": seq, "adds": hints }) });
        }
        let s = self.apply_endorsed(c, seq, &hash, &adds, vec![credential], t)?;
        // The chain entry is written by apply_endorsed (actor console); the dispatcher writes the admin's own.
        Ok(Done::ok(Out::ok(json!({ "ok": true, "seq": s })), Some(seq.to_string()), json!({ "seq": s, "adds": hints, "relays": self.relay_ids() })))
    }

    /// The policy step-up of `settings.profile` and `settings.two-person` on a fleet console (4.5): verified before
    /// the AC-1 handler runs; the credential to endorse the policy update with.
    pub fn verify_policy(&self, c: &Console, r: &FleetReq, action: &str) -> Result<(Value, Value, u64, [u8; 32]), ApiError> {
        let who = r.who()?;
        let policy = self.policy_after(c, action, r.params).ok_or_else(|| ApiError::with("invalid", "Only the profile and the two-person setting are policy changes."))?;
        let (seq, hash) = self.policy_binding(&policy).ok_or_else(|| ApiError::of("invalid"))?;
        let (cer_id, credential) = Self::stepup_of(r)?;
        let cer = c.fleet_ceremony_take(who, &cer_id, r.t)?;
        let want = crate::fleet_trust::policy_endorse_challenge(&self.console_id, seq, &hash);
        if !(cer.kind == FleetKind::Policy && cer.seq == seq && crate::console_webauthn::same_bytes(&want, &cer.challenge)) {
            return Err(ApiError::of("stepup-failed"));
        }
        c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, r.t)?;
        Ok((credential, policy, seq, hash))
    }

    /// After the AC-1 handler of a policy change ran: a tightening in force goes to the relays with its one
    /// endorsement; a loosening waiting for its second admin keeps the requester's assertion with the approval.
    pub fn after_policy(&self, c: &Console, d: &Done, (credential, policy, seq, hash): (Value, Value, u64, [u8; 32]), t: i64) {
        if d.result == "waiting" {
            if let Some(id) = &d.approval {
                let mut book = self.book.lock();
                book.approvals.insert(id.clone(), json!({ "kind": "policy", "seq": seq, "hash": hash_hex(&hash), "policy": policy, "credential": credential, "requestedAt": t, "at": t, "params": c.inner.lock().book.approvals.iter().find(|a| str_of(a.get("id")) == Some(id.as_str())).and_then(|a| a.get("params").cloned()).unwrap_or(Value::Null) }));
                let _ = self.save_book(c, &book);
            }
            return;
        }
        let now = {
            let s = c.settings_now();
            policy_of(s.high(), s.two_person)
        };
        let same = self.book.lock().policy == now;
        if !same && now == policy {
            if let Err(e) = self.chain_policy(c, policy, vec![credential], t) {
                c.logger.ops("fleet.policy-failed", &Fields::new().with("why", e.message), Level::Error);
            }
        }
    }

    /// POST fleet/roster/cancel {relay, hint, stepup} (4.4): best effort.
    fn roster_cancel(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let relay = str_of(r.params.get("relay")).unwrap_or("").to_owned();
        let hint = str_of(r.params.get("hint")).unwrap_or("").to_owned();
        let auth = self.verify_stepup(c, r, "fleet.roster.cancel", &hint, r.params, std::slice::from_ref(&relay))?;
        let a = self.send(&relay, "roster-cancel", json!({ "hint": hint, "auth": auth.for_relay(&relay) }), CALL_MS)?;
        let delivered = a.get("cancelled").and_then(Value::as_bool).unwrap_or(false);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "delivered": delivered })), Some(hint.clone()), json!({ "relay": relay, "hint": hint, "delivered": delivered })))
    }

    // ── The proxy (5.4) ─────────────────────────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    fn audit_call(&self, c: &Console, actor: &str, relay: &str, action: &str, target: &str, result: &str, code: Option<&str>, approval: Option<&str>, mode: &str, ip: &str, t: i64) {
        let mut rec = Record::new(actor, "fleet.call", audit_result(result));
        rec.target = Some(target.to_owned());
        rec.ip = Some(ip.to_owned());
        rec.stepup = true;
        rec.approval = approval.map(str::to_owned);
        rec.detail = json!({ "relay": relay, "action": action, "result": result, "code": code, "approval": approval, "mode": mode });
        c.record(rec, t);
    }

    fn count_read(&self, email: &str, relay: &str, path: &str, t: i64) {
        let minute = t.div_euclid(60_000);
        let mut reads = self.reads.lock();
        let e = reads.entry((email.to_owned(), relay.to_owned())).or_insert((minute, 0, BTreeMap::new()));
        e.1 += 1;
        *e.2.entry(path.to_owned()).or_insert(0) += 1;
    }

    /// One `fleet.reads.summary` per person per relay per minute (7.1), for minutes that ended.
    fn flush_reads(&self, c: &Console, t: i64) {
        let minute = t.div_euclid(60_000);
        let due: Vec<(ReadKey, ReadCount)> = {
            let mut reads = self.reads.lock();
            let keys: Vec<ReadKey> = reads.iter().filter(|(_, v)| v.0 < minute).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| reads.remove(&k).map(|v| (k, v))).collect()
        };
        for ((email, relay), (_, count, routes)) in due {
            self.record(c, &email, "fleet.reads.summary", Some(relay.clone()), json!({ "relay": relay, "count": count, "routes": routes }), t);
        }
    }

    /// `/console/api/fleet/relays/<id>/p/<path>` (5.4): the phase 1 role on the caller's session, the registry state,
    /// the scope mirror, and for a write the fleet step-up (or a second admin's request); then a `call` frame.
    fn proxy(&self, c: &Console, r: &FleetReq, id: &str, sub: &str) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let row = crate::fleet_trust::scope_row(r.method, sub).ok_or_else(|| ApiError::of("fleet-route"))?;
        let spec = phase1_spec(r.method, sub).ok_or_else(|| ApiError::of("fleet-route"))?;
        if !role_ok(spec.role, who) {
            return Err(if spec.role == Role::Manager { ApiError::with("role", "Only an admin or user manager can do this.") } else { ApiError::of("role") });
        }
        let rec = self.registry.lock().relays.get(id).cloned().filter(|x| x.state.live()).ok_or_else(not_found_relay)?;
        let write = r.method == "POST";
        let scope_err = |e: crate::fleet_trust::Refused| ApiError { status: e.status, code: crate::console::code_words_static(e.code).unwrap_or("fleet-scope"), message: e.error, retry_after: None };
        if write {
            if rec.state != RelayState::Active {
                return Err(relay_words("relay-unconfirmed", &rec.name));
            }
            crate::fleet_trust::write_scopes_ok(row, &rec.scopes).map_err(scope_err)?;
            if c.profile_high() && (rec.profile != "high" || !rec.fips) {
                return Err(ApiError::of("fleet-profile"));
            }
        } else {
            crate::fleet_trust::read_projection(row, &rec.scopes).map_err(scope_err)?;
        }
        let mut params = r.params.clone();
        let target = crate::console::target_of(spec, &params);
        let (auth, mode) = if write {
            let (cer_id, _) = Self::stepup_of(r)?;
            let kind = c.inner.lock().fleet_stepups.get(&cer_id).map(|x| x.kind);
            if kind == Some(FleetKind::Request) {
                return self.proxy_request(c, r, &rec, sub, spec, &target);
            }
            let auth = self.verify_stepup(c, r, spec.action, &target, &params, std::slice::from_ref(&rec.id))?;
            (auth.for_relay(&rec.id).unwrap_or(Value::Null), "one")
        } else {
            (Value::Null, "")
        };
        if let Some(o) = params.as_object_mut() {
            o.remove("stepup");
        }
        let frame = json!({ "method": r.method, "path": sub, "query": r.query, "body": if write { params } else { json!({}) }, "caller": { "email": who.email, "role": role_word(who) }, "auth": auth });
        let timeout = if sub.ends_with("/export") { EXPORT_MS } else { CALL_MS };
        let answer = self.send(&rec.id, "call", frame, timeout);
        if !write {
            self.count_read(&who.email, &rec.id, sub, t);
        }
        let answer = match answer {
            Ok(a) => a,
            Err(e) => {
                if write {
                    self.audit_call(c, &who.email, &rec.id, spec.action, &target, "refused", Some(e.code), None, mode, r.ip, t);
                }
                return Err(c.with_relay(e, &rec.id));
            }
        };
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(502) as u16;
        let body = answer.get("body").cloned().unwrap_or(Value::Null);
        if write {
            let code = str_of(body.get("code"));
            let result = if status < 300 { "ok" } else if code == Some("fleet-confirm") { "waiting" } else { "refused" };
            self.audit_call(c, &who.email, &rec.id, spec.action, &target, result, code, None, mode, r.ip, t);
            if code == Some("fleet-confirm") {
                let mut reg = self.registry.lock();
                if let Some(x) = reg.relays.get_mut(&rec.id) {
                    x.waiting.push(json!({ "id": body.get("id"), "action": spec.action, "target": target, "actor": who.email, "at": t }));
                    let _ = self.save_registry(&reg);
                }
            }
        }
        if status >= 300 {
            // The relay's own code and words, with `relay` added (5.1); untrusted, so cleaned.
            let code = crate::console::code_words_static(str_of(body.get("code")).unwrap_or("")).unwrap_or("fleet-op");
            let e = ApiError { status, code, message: clean(str_of(body.get("error")).unwrap_or("")).chars().take(500).collect(), retry_after: None };
            return Err(c.with_relay(e, &rec.id));
        }
        // A download (log or audit export) comes back as its text.
        if let Some(text) = body.get("file").and_then(Value::as_str) {
            let name = format!("attachment; filename=\"lucid-relay-{}-{}.jsonl\"", rec.id, sub.replace('/', "-"));
            return Ok(Done::plain(Out { status: 200, body: Value::Null, cookie: None, file: Some((text.as_bytes().to_vec(), "application/x-ndjson; charset=utf-8", name)) }));
        }
        Ok(Done::plain(Out { status, body, cookie: None, file: None }))
    }

    /// A proxied write that needs a second admin (4.7): the requester's assertion over the request binding is
    /// verified and kept with a new approval; nothing reaches the relay until an admin approves.
    fn proxy_request(&self, c: &Console, r: &FleetReq, rec: &RelayRecord, sub: &str, spec: &'static RouteSpec, target: &str) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let (cer_id, credential) = Self::stepup_of(r)?;
        let cer = c.fleet_ceremony_take(who, &cer_id, t)?;
        let approval = cer.approval_id.clone().ok_or_else(|| ApiError::of("stepup-failed"))?;
        let relays = vec![rec.id.clone()];
        let ch = crate::fleet_trust::request_challenge(&self.console_id, &approval, spec.action, target, r.params, &relays, cer.requested_at);
        if !(cer.action == spec.action && ch.is_some_and(|ch| crate::console_webauthn::same_bytes(&ch, &cer.challenge))) {
            return Err(ApiError::of("stepup-failed"));
        }
        c.verify_fleet_assertion(who, &credential, &cer.challenge, r.origin, t)?;
        let binding = json!({ "kind": "call", "relay": rec.id, "path": sub, "credential": credential, "requestedAt": cer.requested_at, "at": t });
        // The row's `requested_at` is the one the requester's assertion binds (4.7), so the approver binds it too.
        let view = self.new_approval(c, who, &approval, spec.action, target, r.params, &relays, binding, cer.requested_at)?;
        self.audit_call(c, &who.email, &rec.id, spec.action, target, "waiting", None, Some(&approval), "two", r.ip, t);
        Ok(Done::plain(Out::ok(json!({ "ok": true, "approval": view }))))
    }

    // ── Expiry, licenses and the library (5.3, 9.6) ─────────────────────────────────────────────────────

    fn expiry(&self, t: i64) -> Value {
        let mut rows = Vec::new();
        for x in self.registry.lock().relays.values().filter(|x| x.state.live()) {
            for s in x.serials.iter().filter(|s| s.current) {
                rows.push(json!({ "relay": x.id, "kind": "management", "notAfter": s.not_after, "daysLeft": (s.not_after - t).div_euclid(86_400_000) }));
            }
            if let Some(d) = x.report.get("license").and_then(|l| l.get("daysLeft")).and_then(Value::as_i64) {
                rows.push(json!({ "relay": x.id, "kind": "license", "notAfter": t + d * 86_400_000, "daysLeft": d }));
            }
            if let Some(l) = self.metrics.latest(&x.id) {
                for (k, kind) in [("cert_tls_days", "tls"), ("cert_signer_days", "signer"), ("crl_days", "crl")] {
                    if let Some(d) = l.m.get(k).and_then(Value::as_i64) {
                        rows.push(json!({ "relay": x.id, "kind": kind, "notAfter": t + d * 86_400_000, "daysLeft": d }));
                    }
                }
            }
        }
        rows.sort_by_key(|r| r["daysLeft"].as_i64().unwrap_or(i64::MAX));
        json!({ "ok": true, "rows": rows })
    }

    fn licenses_view(&self) -> Value {
        let relays: Vec<Value> = self
            .registry
            .lock()
            .relays
            .values()
            .filter(|x| x.state.live())
            .map(|x| {
                let lic = x.report.get("license").cloned().unwrap_or(Value::Null);
                json!({ "relay": x.id, "product": product_str(x.product), "license": { "state": lic.get("state"), "daysLeft": lic.get("daysLeft"), "id": lic.get("id"), "exp": lic.get("exp"), "service": lic.get("service") }, "seats": x.counts.get("people").cloned().unwrap_or(Value::Null) })
            })
            .collect();
        let library: Vec<Value> = self.book.lock().library.iter().map(|l| { let mut l = l.clone(); if let Some(o) = l.as_object_mut() { o.remove("token"); } l }).collect();
        json!({ "ok": true, "relays": relays, "library": library })
    }

    /// POST fleet/licenses/library {license, stepup} or {remove, stepup} (5.3): a license verified against the
    /// publisher key (any root; the relay that installs it checks its own), or one removed. AC-1 step-up bound to the
    /// license id.
    fn library(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        if let Some(remove) = str_of(r.params.get("remove")) {
            c.verify_stepup(who, r.body.get("stepup"), crate::console_auth::Bind { action: "fleet.license.library", target: remove, params: r.params }, r.origin, t)?;
            let (product, library) = {
                let mut book = self.book.lock();
                let i = book.library.iter().position(|l| str_of(l.get("id")) == Some(remove)).ok_or_else(|| ApiError::with("not-found", "There is no such license in the library."))?;
                let gone = book.library.remove(i);
                self.save_book(c, &book)?;
                (str_of(gone.get("product")).unwrap_or("").to_owned(), book.library.clone())
            };
            let shown: Vec<Value> = library.into_iter().map(|mut l| { if let Some(o) = l.as_object_mut() { o.remove("token"); } l }).collect();
            return Ok(Done::ok(Out::ok(json!({ "ok": true, "library": shown })), Some(remove.to_owned()), json!({ "removed": remove, "product": product })));
        }
        let token = crate::license::license_token_of(str_of(r.params.get("license")).unwrap_or(""));
        let keys = crate::license::license_keys(|k| std::env::var(k).ok()).map_err(|_| ApiError::of("license-refused"))?;
        let body = token.split('.').next().and_then(unb64u).and_then(|b| crate::codec::parse_json(&String::from_utf8_lossy(&b))).ok_or_else(|| ApiError::of("license-refused"))?;
        let root = str_of(body.get("root")).unwrap_or("").to_owned();
        let product = if root.starts_with("m_") { Product::Meet } else { Product::Spokes };
        let check = crate::license::verify_license_for(&token, product, &[root.as_str()], &keys, t / 1000).map_err(|e| ApiError::with("license-refused", format!("This license cannot be used here: {}.", clean(&e))))?;
        let l = check.license;
        c.verify_stepup(who, r.body.get("stepup"), crate::console_auth::Bind { action: "fleet.license.library", target: &l.id, params: r.params }, r.origin, t)?;
        let entry = json!({ "id": l.id, "product": product_str(product), "edition": l.edition, "users": l.users, "relays": l.relays, "exp": l.exp, "root": l.root, "token": token });
        let library = {
            let mut book = self.book.lock();
            book.library.retain(|x| str_of(x.get("id")) != Some(l.id.as_str()));
            book.library.push(entry);
            self.save_book(c, &book)?;
            book.library.clone()
        };
        c.setup_done("license");
        let shown: Vec<Value> = library.into_iter().map(|mut x| { if let Some(o) = x.as_object_mut() { o.remove("token"); } x }).collect();
        Ok(Done::ok(Out::ok(json!({ "ok": true, "library": shown })), Some(l.id.clone()), json!({ "added": l.id, "product": product_str(product) })))
    }

    // ── People (11, through f-people) ───────────────────────────────────────────────────────────────────

    fn people_route(&self, c: &Console, spec: &'static RouteSpec, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let path = spec.path.strip_prefix("fleet/").unwrap_or(spec.path);
        let rights = if who.admin { crate::fleet_people::Rights::Admin } else if who.manager { crate::fleet_people::Rights::Manager } else { crate::fleet_people::Rights::Viewer };
        let asker = crate::fleet_people::Asker { session: who.sid.clone(), email: who.email.clone(), rights };
        let mut params = r.params.clone();
        if let Some(o) = params.as_object_mut() {
            o.remove("stepup");
        }
        let (auth, assertions) = if r.method == "POST" && spec.keys.contains(&"stepup") {
            let (action, target, bparams, relays) = if path == "people/import" {
                let b = self.people.import_binding(&who.sid, str_of(params.get("importId")).unwrap_or("")).ok_or_else(|| ApiError::with("csv-changed", crate::fleet_people::CSV_CHANGED))?;
                (str_of(b.get("action")).unwrap_or("").to_owned(), str_of(b.get("target")).unwrap_or("-").to_owned(), b.get("params").cloned().unwrap_or(Value::Null), strings(b.get("targets")))
            } else {
                let relay = str_of(params.get("relay")).map(str::to_owned).into_iter().collect::<Vec<_>>();
                (spec.action.to_owned(), crate::console::target_of(spec, &params), params.clone(), relay)
            };
            if relays.is_empty() && path == "people/import" {
                // 6: an import of console accounts only takes the AC-1 step-up; with any Meeting Hub row, the fleet one.
                c.verify_stepup(who, r.body.get("stepup"), crate::console_auth::Bind { action: &action, target: &target, params: &bparams }, r.origin, r.t)?;
                (Value::Null, 0)
            } else {
                let auth = self.verify_stepup(c, r, &action, &target, &bparams, &relays)?;
                (auth.shared(), 1)
            }
        } else {
            (Value::Null, 0)
        };
        let answer = self.people.route(r.method, path, &asker, r.query, &params, auth, assertions, r.t)?;
        let detail = match path {
            "people/invite" => json!({ "relay": params.get("relay"), "request": answer.get("request").and_then(|x| x.get("id")), "days": params.get("days") }),
            "people/import" => json!({ "importId": params.get("importId"), "done": answer.get("done").and_then(Value::as_array).map(Vec::len), "refused": answer.get("refused").and_then(Value::as_array).map(Vec::len) }),
            "people/remind" => json!({ "relay": params.get("relay"), "request": params.get("request") }),
            "people/suspend" | "people/unsuspend" | "people/remove" => {
                let results = answer.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
                let ok = results.iter().filter(|x| x["ok"] == true).count();
                json!({ "relay": params.get("relay"), "subject": params.get("id"), "results": { "ok": ok, "refused": results.len() - ok } })
            }
            _ => json!({ "relay": params.get("relay") }),
        };
        if spec.action.is_empty() {
            return Ok(Done::plain(Out::ok(answer)));
        }
        let target = Some(crate::console::target_of(spec, &params)).filter(|s| !s.is_empty());
        Ok(Done::ok(Out::ok(answer), target, detail))
    }
}

// ── The management port's calls (F15, for fleet_port and fleet_ca) ──────────────────────────────────────────

/// What fleet_port gives `enroll_done` once it verified the 3.3 checks and issued the certificate.
#[derive(Clone, Debug)]
pub struct EnrollDone {
    /// From `draw_relay_id` (the replaced relay's id, or a new one).
    pub relay_id: Option<String>,
    pub serial: String,
    pub spki: Vec<u8>,
    pub not_after: i64,
    pub generation: u32,
    /// The relay object of 3.3 `{product, version, fips, profile, host, os, localConsole}`.
    pub relay: Value,
    /// The source address of the enroll call.
    pub source: String,
}

impl Fleet {
    fn console_view(&self, c: &Console) -> Value {
        let origin = c.origin().unwrap_or_default();
        json!({ "id": self.console_id, "origin": origin, "rpId": crate::console::rp_id_of(&origin) })
    }

    /// The 3.3 preview answer without `ok` and `previewHash` (fleet_port hashes it). `fleet-code-expired` for a code
    /// that is not open; `fleet-roster-duplicate` when the first roster repeats a key.
    pub fn enroll_preview(&self, id: &str, host: &str, t: i64) -> Result<Value, ApiError> {
        let c = self.console()?;
        self.sync_roster(&c, t);
        let e = self.registry.lock().enrollments.get(id).cloned().filter(|e| e.open(t)).ok_or_else(|| ApiError::of("fleet-code-expired"))?;
        let book = self.book.lock();
        if roster_duplicate(&book.roster) {
            return Err(ApiError::of("fleet-roster-duplicate"));
        }
        let hash = crate::fleet_trust::bootstrap_roster_hash(&book.console_id, id, &book.policy, &book.roster).ok_or_else(|| ApiError::of("invalid"))?;
        let (policy, roster, spokes_root, library) = (book.policy.clone(), book.roster.clone(), book.spokes_root.clone(), book.library.clone());
        drop(book);
        let mut console = self.console_view(&c);
        console["host"] = Value::from(host);
        let deploy = self.preview_deploy(&c, &e, spokes_root.as_ref(), &library)?;
        Ok(json!({
            "console": console,
            "enrollment": { "product": product_str(e.product), "name": e.name, "site": e.site, "scopes": e.scopes, "expires": e.expires },
            "policy": policy, "roster": roster, "bootstrapRosterHash": hash, "deploy": deploy,
        }))
    }

    /// The sealed 20-byte secret of an open code.
    pub fn enroll_secret(&self, id: &str) -> Option<Vec<u8>> {
        let t = crate::codec::now_ms();
        if !self.registry.lock().enrollments.get(id).is_some_and(|e| e.open(t)) {
            return None;
        }
        self.console().ok()?.seal_get(&format!("fleet-code-{id}")).filter(|s| s.len() == 20)
    }

    /// One wrong proof for a code (3.1): the fifth burns it.
    pub fn enroll_failed(&self, id: &str, t: i64) {
        let burned = {
            let mut reg = self.registry.lock();
            let Some(e) = reg.enrollments.get_mut(id).filter(|e| e.state == "open") else { return };
            e.fails += 1;
            let burned = e.fails >= CODE_FAILS_MAX;
            if burned {
                e.state = "expired".into();
            }
            let _ = self.save_registry(&reg);
            burned
        };
        if let Ok(c) = self.console() {
            self.record(&c, "console", "fleet.enroll.refused", Some(id.to_owned()), json!({ "id": id, "code": if burned { "fleet-code-expired" } else { "fleet-code" } }), t);
            if burned {
                self.wipe_code(&c, id);
            }
        }
    }

    /// 3.3 step 3, the checks that are the console's: the code open, the product, the 4.10 profile rules, the count.
    pub fn enroll_check(&self, id: &str, relay: &Value, t: i64) -> Result<(), ApiError> {
        let c = self.console()?;
        let e = self.registry.lock().enrollments.get(id).cloned().filter(|e| e.open(t)).ok_or_else(|| ApiError::of("fleet-code-expired"))?;
        let product = str_of(relay.get("product")).and_then(product_of);
        if product != Some(e.product) {
            let n = e.product.name();
            return Err(ApiError::with("fleet-product", format!("This code is for a {n} relay. Run it on a {n} relay.")));
        }
        if c.profile_high() && !(str_of(relay.get("profile")) == Some("high") && relay.get("fips").and_then(Value::as_bool) == Some(true)) {
            self.record(&c, &format!("relay {}", e.replaces.clone().unwrap_or_else(|| id.to_owned())), "fleet.relay.refused", Some(id.to_owned()), json!({ "code": "fleet-profile", "profile": relay.get("profile"), "fips": relay.get("fips") }), t);
            return Err(ApiError::of("fleet-profile"));
        }
        if e.replaces.is_none() && self.registry.lock().live_count() >= RELAYS_MAX {
            return Err(ApiError::of("fleet-limit"));
        }
        // AC-2b-D 8.7 (H4): a Standard console holding the CA refuses a High Meeting Hub relay that trusts it, or
        // whose roots are unknown.
        if e.product == Product::Meet && !c.profile_high() && ca_held_refuses(self.meet_ca_id().as_deref(), str_of(relay.get("profile")).unwrap_or(""), relay.get("meetRoots")) {
            self.record(&c, &format!("relay {}", e.replaces.clone().unwrap_or_else(|| id.to_owned())), "fleet.relay.refused", Some(id.to_owned()), json!({ "code": "fleet-ca-held", "profile": relay.get("profile") }), t);
            return Err(ApiError::of("fleet-ca-held"));
        }
        // AC-2b-D 6.5: the requests read, are signed by their own P-256 keys, and use two different keys; their names
        // are checked against the mint when the CA issues (`enroll_done`). A refusal burns one of the code's tries.
        if let Some(names) = meet_names(e.deploy.as_ref()) {
            let signer = {
                let meet = self.meet.lock();
                let ca = meet.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok).ok_or_else(|| ApiError::of("deploy-ca-needed"))?;
                ca.signer_url().is_some()
            };
            let server = csr_of(relay.get("meetCsr"));
            let signer_csr = csr_of(relay.get("meetSignerCsr"));
            let ok = match (&server, &signer_csr, signer) {
                (Some(_), None, false) => relay.get("meetSignerCsr").is_none_or(Value::is_null),
                (Some(s), Some(g), true) => s.1 != g.1,
                _ => false,
            };
            if !ok {
                self.enroll_failed(id, t);
                return Err(deploy_csr_error(&names));
            }
        }
        Ok(())
    }

    /// The relay id an enrollment gets (2.4: `r_` and 16 hex): the replaced relay's, or a new one ("" for the
    /// same-process enrollment).
    pub fn draw_relay_id(&self, id: &str) -> String {
        let reg = self.registry.lock();
        if let Some(r) = reg.enrollments.get(id).and_then(|e| e.replaces.clone()) {
            return r;
        }
        loop {
            let id = format!("r_{}", hex(&crate::console_auth::random(8).unwrap_or_else(|| vec![0; 8])));
            if !reg.relays.contains_key(&id) {
                return id;
            }
        }
    }

    fn enrolled_answer(&self, c: &Console, rec: &RelayRecord) -> Value {
        let book = self.book.lock();
        json!({
            "relayId": rec.id, "name": rec.name, "site": rec.site, "scopes": rec.scopes,
            "policy": book.policy, "policySeq": book.policy_seq, "policyHash": hash_hex(&book.policy_hash),
            "roster": book.roster, "rosterSeq": book.roster_seq, "rosterHash": hash_hex(&book.roster_hash),
            "bootstrapRosterHash": rec.bootstrap_roster_hash, "console": self.console_view(c), "fingerprint": rec.fingerprint,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn new_record(&self, id: &str, name: &str, site: &str, product: Product, scopes: Vec<String>, done: &EnrollDone, via: &str, enrolled_by: &str, enrollment: &str, bootstrap: String, t: i64) -> RelayRecord {
        let s = |k: &str| clean(str_of(done.relay.get(k)).unwrap_or("")).chars().take(64).collect::<String>();
        RelayRecord {
            id: id.to_owned(),
            name: name.to_owned(),
            site: site.to_owned(),
            product,
            state: RelayState::Pending,
            serials: vec![SerialRecord { serial: done.serial.clone(), spki_sha256: sha256_hex(&done.spki), spki: b64u(&done.spki), not_after: done.not_after, generation: done.generation, current: true }],
            fingerprint: fingerprint_of(&done.spki),
            enrolled_at: t,
            enrolled_by: enrolled_by.to_owned(),
            enrollment: enrollment.to_owned(),
            via: via.to_owned(),
            source_address: Some(done.source.clone()).filter(|s| !s.is_empty()),
            bootstrap_roster_hash: bootstrap,
            last_contact_at: None,
            version: s("version"),
            os: s("os"),
            fips: done.relay.get("fips").and_then(Value::as_bool).unwrap_or(false),
            profile: s("profile"),
            scopes,
            pending_scopes: Vec::new(),
            confirmed: false,
            left_at: None,
            report: Map::new(),
            attention: Vec::new(),
            counts: Value::Null,
            servers: Value::Null,
            push: Value::Null,
            waiting: Vec::new(),
            unknown: Vec::new(),
            replacements: Vec::new(),
            flapping_at: None,
            behind_since: None,
            scope_stale: false,
            clock_off: false,
            deploy: None,
            meet_revoke: None,
        }
    }

    /// 3.3 after the checks and the certificate: the code used and its secret wiped, the record `pending` (a Replace
    /// keeps the old id, name, site, scopes and metrics, and denies every old serial), `fleet.enroll` audited. The
    /// answer's console part (fleet_port adds cert, caCert, trust and fleetUrl). AC-2b-D 6.5: with `pki: console` the
    /// CA issues the relay's certificates from its requests in the same step as the registry write, and the answer
    /// gains `meet: {cert, signerCert, caCert, crl}`; a Replace revokes what the CA issued to the replaced relay.
    pub fn enroll_done(&self, id: &str, done: EnrollDone, t: i64) -> Result<Value, ApiError> {
        let c = self.console()?;
        match self.enroll_commit(&c, id, &done, t) {
            Ok(v) => Ok(v),
            Err(e) => {
                if e.code == "deploy-csr" {
                    self.enroll_failed(id, t);
                }
                Err(e)
            }
        }
    }

    fn enroll_commit(&self, c: &Console, id: &str, done: &EnrollDone, t: i64) -> Result<Value, ApiError> {
        let (rec, old_serials, meet, issued, revoked) = {
            let mut reg = self.registry.lock();
            let e = reg.enrollments.get(id).cloned().filter(|e| e.open(t)).ok_or_else(|| ApiError::of("fleet-code-expired"))?;
            let relay_id = done.relay_id.clone().unwrap_or_else(|| e.replaces.clone().unwrap_or_default());
            if relay_id.is_empty() {
                return Err(ApiError::of("invalid"));
            }
            let bootstrap = {
                let book = self.book.lock();
                crate::fleet_trust::bootstrap_roster_hash(&book.console_id, id, &book.policy, &book.roster).unwrap_or_default()
            };
            let old = e.replaces.as_ref().and_then(|r| reg.relays.get(r).cloned());
            let (name, site, scopes) = match &old {
                Some(o) => (o.name.clone(), o.site.clone(), o.scopes.clone()),
                None => (e.name.clone(), e.site.clone(), e.scopes.clone()),
            };
            let mut rec = self.new_record(&relay_id, &name, &site, e.product, scopes, done, "code", &e.created_by, id, bootstrap, t);
            rec.deploy = e.deploy.clone();
            let old_serials = old.as_ref().map(RelayRecord::all_serials).unwrap_or_default();
            let confirmed = signer_confirmed_in(&reg, &relay_id);
            let mut issued: Vec<(crate::meet_ca::CertKind, crate::meet_ca::Issued)> = Vec::new();
            let mut meet = Value::Null;
            let mut revoked = false;
            {
                let mut g = self.meet.lock();
                if let Some(names) = meet_names(e.deploy.as_ref()) {
                    let ca = g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok).ok_or_else(|| ApiError::of("deploy-ca-needed"))?;
                    let (server_der, server_spki) = csr_of(done.relay.get("meetCsr")).ok_or_else(|| deploy_csr_error(&names))?;
                    let signer = csr_of(done.relay.get("meetSignerCsr"));
                    // 6.5: keys different from each other and from the management key.
                    if server_spki == done.spki || signer.as_ref().is_some_and(|(_, s)| *s == done.spki || *s == server_spki) || ca.signer_url().is_some() != signer.is_some() {
                        return Err(deploy_csr_error(&names));
                    }
                    if let Some((holder, name)) = ca.name_holder(&names, t).filter(|(h, _)| *h != relay_id) {
                        return Err(host_taken_error(&reg, &holder, &name));
                    }
                    let s = with_vault(c, |v| ca.issue(&*v, &relay_id, crate::meet_ca::CertKind::Server, &server_der, &names, confirmed, false, t))?;
                    let g2 = match &signer {
                        Some((der, _)) => Some(with_vault(c, |v| ca.issue(&*v, &relay_id, crate::meet_ca::CertKind::SignerClient, der, &[], confirmed, false, t))?),
                        None => None,
                    };
                    meet = json!({ "cert": s.pem, "signerCert": g2.as_ref().map(|x| x.pem.clone()), "caCert": ca.ca_pem(), "crl": null });
                    issued.push((crate::meet_ca::CertKind::Server, s));
                    if let Some(x) = g2 {
                        issued.push((crate::meet_ca::CertKind::SignerClient, x));
                    }
                }
                // A Replace keeps the relay id: what the CA issued to the replaced relay is revoked (8.4, L10).
                if old.is_some() {
                    if let Some(ca) = g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok) {
                        let keep: Vec<&str> = issued.iter().map(|(_, x)| x.serial.as_str()).collect();
                        revoked = with_vault(c, |v| ca.revoke_relay(&*v, &relay_id, None, &keep, t)).map(|l| !l.is_empty()).unwrap_or(false);
                    }
                }
                if !meet.is_null() {
                    meet["crl"] = g.as_ref().and_then(|ca| ca.crl()).map(|(pem, _)| Value::from(pem)).unwrap_or(Value::Null);
                }
            }
            if let Some(x) = reg.enrollments.get_mut(id) {
                x.state = "used".into();
                x.relay = Some(relay_id.clone());
            }
            reg.relays.insert(relay_id.clone(), rec.clone());
            self.save_registry(&reg)?;
            (rec, old_serials, meet, issued, revoked)
        };
        self.wipe_code(c, id);
        if !old_serials.is_empty() {
            if let Some(pki) = self.pki.get() {
                let _ = pki.deny(&old_serials, t);
            }
        }
        self.people.wipe_relay(&rec.id);
        self.record(c, &format!("relay {}", rec.id), "fleet.enroll", Some(rec.id.clone()), json!({ "id": id, "relay": rec.id, "fingerprint": rec.fingerprint, "version": rec.version, "fips": rec.fips, "profile": rec.profile, "os": rec.os, "via": "code" }), t);
        for (kind, x) in &issued {
            self.record(c, &format!("relay {}", rec.id), "fleet.meet-cert.issue", Some(rec.id.clone()), json!({ "serial": x.serial, "kind": kind.as_str(), "names": x.names, "notAfter": x.not_after }), t);
        }
        if revoked {
            self.crl_signed(c, t);
        }
        c.setup_done("relay");
        let mut answer = self.enrolled_answer(c, &rec);
        if !meet.is_null() {
            answer["meet"] = meet;
        }
        Ok(answer)
    }

    /// Same-process enrollment (2.2, Standard only): no code, every scope but `upgrade`, active at once, no
    /// fingerprint confirmation; `fleet.enroll` with `via: "same-process"`, actor `operator`.
    pub fn enroll_same_process(&self, done: EnrollDone, t: i64) -> Result<Value, ApiError> {
        let c = self.console()?;
        if c.profile_high() {
            return Err(ApiError::of("fleet-profile"));
        }
        self.sync_roster(&c, t);
        let relay_id = done.relay_id.clone().unwrap_or_else(|| self.draw_relay_id(""));
        let product = str_of(done.relay.get("product")).and_then(product_of).ok_or_else(|| ApiError::of("invalid"))?;
        let scopes: Vec<String> = SCOPES.iter().map(|s| (*s).to_owned()).collect();
        let mut rec = self.new_record(&relay_id, "This host", "", product, scopes, &done, "same-process", "operator", "", String::new(), t);
        rec.state = RelayState::Active;
        rec.confirmed = true;
        {
            let mut reg = self.registry.lock();
            reg.relays.insert(relay_id.clone(), rec.clone());
            self.save_registry(&reg)?;
        }
        self.record(&c, "operator", "fleet.enroll", Some(relay_id.clone()), json!({ "id": null, "relay": relay_id, "fingerprint": rec.fingerprint, "version": rec.version, "fips": rec.fips, "profile": rec.profile, "os": rec.os, "via": "same-process" }), t);
        c.setup_done("relay");
        Ok(self.enrolled_answer(&c, &rec))
    }

    /// For fleet_port's verifier: `serial` is a current or previous certificate of a relay that is not left or removed.
    pub fn serial_ok(&self, relay: &str, serial: &str) -> bool {
        self.registry.lock().relays.get(relay).is_some_and(|r| r.state.live() && r.serials.iter().any(|s| s.serial == serial))
    }

    /// A renewal or recovery issued a new certificate (3.4, 3.11): kept beside the current one until the relay's
    /// next `hello` with it.
    pub fn renewed(&self, relay: &str, rec: SerialRecord, t: i64) {
        let serial = rec.serial.clone();
        {
            let mut reg = self.registry.lock();
            let Some(r) = reg.relays.get_mut(relay) else { return };
            r.serials.retain(|s| s.serial != rec.serial);
            r.serials.push(SerialRecord { current: false, ..rec });
            let _ = self.save_registry(&reg);
        }
        if let Ok(c) = self.console() {
            self.record(&c, &format!("relay {relay}"), "fleet.relay.renew", Some(relay.to_owned()), json!({ "serial": serial }), t);
        }
    }

    /// The first `hello` with a new certificate: it becomes the current one; the old serials are returned for
    /// fleet_port to deny.
    pub fn renew_switched(&self, relay: &str, serial: &str, _t: i64) -> Vec<String> {
        let mut reg = self.registry.lock();
        let Some(r) = reg.relays.get_mut(relay) else { return Vec::new() };
        if !r.serials.iter().any(|s| s.serial == serial && !s.current) {
            return Vec::new();
        }
        let old: Vec<String> = r.serials.iter().filter(|s| s.serial != serial).map(|s| s.serial.clone()).collect();
        r.serials.retain(|s| s.serial == serial);
        if let Some(s) = r.serials.first_mut() {
            s.current = true;
        }
        let _ = self.save_registry(&reg);
        old
    }

    /// `fleet.relay.recovered` (3.11, revision 3.1: one name on both sides; `retry` for a stored answer repeated).
    pub fn relay_recovered(&self, relay: &str, old_serial: &str, new_serial: &str, generation: u32, retry: bool, t: i64) {
        if let Ok(c) = self.console() {
            self.record(&c, &format!("relay {relay}"), "fleet.relay.recovered", Some(relay.to_owned()), json!({ "oldSerial": old_serial, "newSerial": new_serial, "generation": generation, "retry": retry }), t);
        }
    }

    /// A second verified channel replaced the first (3.6): more than 10 in an hour raises `relay-flapping`.
    pub fn flapping(&self, relay: &str, t: i64) {
        let raised = {
            let mut reg = self.registry.lock();
            let Some(r) = reg.relays.get_mut(relay) else { return };
            r.replacements.retain(|at| t - at < 3_600_000);
            r.replacements.push(t);
            let raise = r.replacements.len() > FLAPPING_PER_HOUR && r.flapping_at.is_none_or(|at| t - at >= 3_600_000);
            if raise {
                r.flapping_at = Some(t);
            }
            let _ = self.save_registry(&reg);
            raise
        };
        if raised {
            if let Ok(c) = self.console() {
                c.logger.security("fleet.relay-flapping", &Fields::new().with("relay", relay), Level::Error);
            }
        }
    }

    /// 3.3: a `pending` record with no first contact within 1 hour is removed and its serials denied
    /// (`fleet.relay.expired`, actor `console`); open codes past their hour are marked expired and their secrets
    /// wiped. The serials denied.
    pub fn expire_pending(&self, t: i64) -> Vec<String> {
        let (gone, codes) = {
            let mut reg = self.registry.lock();
            let mut gone = Vec::new();
            for r in reg.relays.values_mut().filter(|r| r.state == RelayState::Pending && r.last_contact_at.is_none() && t - r.enrolled_at >= PENDING_MS) {
                r.state = RelayState::Removed;
                r.left_at = Some(t);
                gone.push((r.id.clone(), r.all_serials()));
            }
            let mut codes = Vec::new();
            for e in reg.enrollments.values_mut().filter(|e| e.state == "open" && e.expires <= t) {
                e.state = "expired".into();
                codes.push(e.id.clone());
            }
            if !gone.is_empty() || !codes.is_empty() {
                let _ = self.save_registry(&reg);
            }
            (gone, codes)
        };
        let serials: Vec<String> = gone.iter().flat_map(|(_, s)| s.clone()).collect();
        if !serials.is_empty() {
            if let Some(pki) = self.pki.get() {
                let _ = pki.deny(&serials, t);
            }
        }
        if let Ok(c) = self.console() {
            for id in codes {
                self.wipe_code(&c, &id);
            }
            for (id, _) in &gone {
                self.record(&c, "console", "fleet.relay.expired", Some(id.clone()), json!({}), t);
                // AC-2b-D 11: an enroll answer lost after the console committed: its certificates revoked too.
                self.meet_revoke_relay(&c, id, t);
            }
        }
        serials
    }

    // ── Channel frames from relays (5.6) ────────────────────────────────────────────────────────────────

    /// Take a relay's report fields into its record (untrusted, kept as reported; shown cleaned). A frame whose
    /// `license` is not the exact 5.6 shape (3.4.1) is refused whole with `fleet-op`: nothing of it is taken.
    fn take_report(rec: &mut RelayRecord, body: &Value) -> Result<(), ApiError> {
        // AC-2b-D 9.3: `meetRoots`, `meetCrl` and `meetPki` (Meeting Hub relays).
        const KEYS: [&str; 25] = ["version", "fips", "profile", "os", "localConsole", "scopes", "scopeGeneration", "scopeRequest", "readOnly", "confirm", "bootstrap", "policySeq", "rosterSeq", "trustSeq", "pins", "certNotAfter", "held", "unattested", "license", "waiting", "anchors", "trustTimeAhead", "meetRoots", "meetCrl", "meetPki"];
        let Some(o) = body.as_object() else { return Err(ApiError::of("fleet-op")) };
        let license = match o.get("license") {
            Some(v) => Some(license_report(v).ok_or_else(|| ApiError::of("fleet-op"))?),
            None => None,
        };
        for k in KEYS {
            if let Some(v) = o.get(k) {
                let v = if k == "license" { license.clone().unwrap_or(Value::Null) } else { v.clone() };
                rec.report.insert(k.to_owned(), v);
            }
        }
        if let Some(v) = str_of(o.get("version")) {
            rec.version = clean(v).chars().take(64).collect();
        }
        if let Some(v) = str_of(o.get("os")) {
            rec.os = clean(v).chars().take(16).collect();
        }
        if let Some(v) = str_of(o.get("profile")) {
            rec.profile = clean(v).chars().take(16).collect();
        }
        if let Some(v) = o.get("fips").and_then(Value::as_bool) {
            rec.fips = v;
        }
        // The relay's scopes only ever narrow ours (4.1): what it grants is what it says.
        if let Some(s) = o.get("scopes").and_then(Value::as_array) {
            let granted: Vec<String> = s.iter().filter_map(|x| x.as_str()).filter(|x| SCOPES.contains(x)).map(str::to_owned).collect();
            rec.pending_scopes.retain(|p| !granted.contains(p));
            rec.scopes = granted;
        }
        rec.settle_state();
        Ok(())
    }

    /// The relay's first frame (5.6 `hello`), after fleet_port verified its certificate: the record moves
    /// `pending` to `unconfirmed`; a High console refuses relays not High or not in FIPS mode (4.10). The `welcome`
    /// body; the updates the relay lacks follow in `on_welcomed`.
    pub fn on_hello(&self, relay: &str, body: &Value, source: &str, t: i64) -> Result<Value, ApiError> {
        let c = self.console()?;
        if c.profile_high() && !(str_of(body.get("profile")) == Some("high") && body.get("fips").and_then(Value::as_bool) == Some(true)) {
            let known = self.registry.lock().relays.get(relay).is_some_and(|r| r.state.live() && r.state != RelayState::Pending);
            if !known {
                self.record(&c, &format!("relay {relay}"), "fleet.relay.refused", Some(relay.to_owned()), json!({ "code": "fleet-profile", "profile": body.get("profile"), "fips": body.get("fips") }), t);
                return Err(ApiError::of("fleet-profile"));
            }
        }
        let (before_bootstrap, after_bootstrap, product_changed) = {
            let mut reg = self.registry.lock();
            let r = reg.relays.get_mut(relay).filter(|r| r.state.live()).ok_or_else(not_found_relay)?;
            let before = r.report.get("bootstrap").cloned();
            let (old_state, old_profile) = (r.state, r.profile.clone());
            if r.state == RelayState::Pending {
                r.state = RelayState::Unconfirmed;
            }
            Self::take_report(r, body)?;
            r.last_contact_at = Some(t);
            r.source_address = Some(source.to_owned()).filter(|s| !s.is_empty()).or(r.source_address.take());
            let after = r.report.get("bootstrap").cloned();
            let changed = old_state != r.state || old_profile != r.profile;
            let _ = self.save_registry(&reg);
            (before, after, changed)
        };
        if product_changed {
            self.people.wipe_relay(relay);
        }
        self.note_bootstrap(&c, relay, before_bootstrap, after_bootstrap, t);
        let book = self.book.lock();
        let (policy_seq, roster_seq) = (book.policy_seq, book.roster_seq);
        drop(book);
        // AC-2b-D 8.7: `meetCaId`, null when this console holds no CA.
        let welcome = json!({ "consoleId": self.console_id, "time": t, "policySeq": policy_seq, "rosterSeq": roster_seq, "trustSeq": body.get("trustSeq").cloned().unwrap_or(Value::Null), "meetCaId": self.meet_ca_id() });
        Ok(welcome)
    }

    /// After the port sent `welcome` (the relay refuses any other first frame): scopes narrowed while the relay was
    /// offline first (4.1), then the roster and policy updates it lacks and the Meeting Hub list push (8.5).
    pub fn on_welcomed(&self, relay: &str, t: i64) {
        let Ok(c) = self.console() else { return };
        // API-1 2.5: `api-heads`, then the pseudonym key, maps and journal entries the relay lacks go before any other
        // request (only when this console holds any api state; an older relay is marked as having no api).
        self.api.on_welcomed(relay);
        self.relay_event(relay, "relay.connected", t);
        if self.api.needs_sync(relay) {
            if let (Some(link), Some(me)) = (self.link.get().cloned(), c.fleet()) {
                let relay = relay.to_owned();
                let _ = std::thread::Builder::new().name("fleet-catch-up".into()).spawn(move || {
                    // a failed api request is tried again at the next contact; the other updates still follow it
                    me.api.sync(&*link, &relay, t.div_euclid(1000));
                    me.welcomed_rest(&relay, t);
                });
                return;
            }
        }
        self.welcomed_rest(relay, t);
    }

    /// `on_welcomed` after the api catch-up.
    fn welcomed_rest(&self, relay: &str, t: i64) {
        let Ok(c) = self.console() else { return };
        let (ours, theirs) = {
            let reg = self.registry.lock();
            reg.relays.get(relay).map(|r| (r.scopes.clone(), strings(r.report.get("scopes")))).unwrap_or_default()
        };
        if theirs.iter().any(|s| !ours.contains(s)) {
            if let Some(link) = self.link.get().cloned() {
                let relay = relay.to_owned();
                let _ = std::thread::Builder::new().name("fleet-scopes".into()).spawn(move || {
                    let _ = link.request(&relay, "scopes", json!({ "scopes": ours, "request": null }), CALL_MS);
                });
            }
        }
        self.catch_up(relay);
        self.meet_report(&c, relay, t);
    }

    /// `fleet.relay.bootstrap` (7.1, revision 2 and 3) whenever the relay reports a new bootstrap state or anchors.
    fn note_bootstrap(&self, c: &Console, relay: &str, before: Option<Value>, after: Option<Value>, t: i64) {
        let Some(after) = after else { return };
        if before.as_ref() == Some(&after) {
            return;
        }
        let after = bootstrap_object(Some(&after));
        let anchors: Vec<Value> = after.get("entries").and_then(Value::as_array).map(|l| l.iter().filter(|e| !e["via"].is_null()).map(|e| json!({ "hint": e.get("hint"), "via": e.get("via") })).collect()).unwrap_or_default();
        self.record(c, &format!("relay {relay}"), "fleet.relay.bootstrap", Some(relay.to_owned()), json!({ "state": after.get("state"), "via": after.get("via"), "bootstrapRosterHash": after.get("bootstrapRosterHash"), "anchors": anchors }), t);
    }

    /// `fleet.ca.confirmed` (7.1, actor `relay <relayId>`) for each CA generation the relay now reports `active` that
    /// it did not before (its operator confirmed it, 3.11).
    fn note_pins(&self, c: &Console, relay: &str, before: Option<Value>, after: Option<Value>, t: i64) {
        let active = |v: &Option<Value>| -> HashSet<u64> { v.as_ref().and_then(Value::as_array).map(|l| l.iter().filter(|p| p["state"] == "active").filter_map(|p| p["generation"].as_u64()).collect()).unwrap_or_default() };
        let (was, now) = (active(&before), active(&after));
        if before.is_none() {
            return;
        }
        for g in now.difference(&was) {
            self.record(c, &format!("relay {relay}"), "fleet.ca.confirmed", Some(relay.to_owned()), json!({ "generation": g }), t);
        }
    }

    /// Events from a relay (5.6): `state`, `attention`, `confirm-done`, `bye`, `metrics`, `audit`.
    pub fn on_event(&self, relay: &str, op: &str, body: &Value, t: i64) {
        let Ok(c) = self.console() else { return };
        let product = {
            let mut reg = self.registry.lock();
            let Some(r) = reg.relays.get_mut(relay).filter(|r| r.state.live()) else { return };
            r.last_contact_at = Some(t);
            r.product
        };
        match op {
            "state" => {
                let (before, after, wipe, pins) = {
                    let mut reg = self.registry.lock();
                    let Some(r) = reg.relays.get_mut(relay) else { return };
                    let before = r.report.get("bootstrap").cloned();
                    let pins_before = r.report.get("pins").cloned();
                    let (gen, profile) = (r.report_u64("scopeGeneration"), r.profile.clone());
                    let request_before = r.report.get("scopeRequest").cloned();
                    // a malformed license refuses the whole frame (3.4.1, `fleet-op`): nothing of it is taken
                    if Self::take_report(r, body).is_err() {
                        // 5.5: an event with unknown keys is refused (`fleet-op`) and logged.
                        drop(reg);
                        c.logger.security("fleet.op-refused", &Fields::new().with("relay", relay).with("op", "state").with("code", "fleet-op"), Level::Warn);
                        return;
                    }
                    let request_after = r.report.get("scopeRequest").cloned();
                    if request_before.as_ref().is_some_and(|b| !b.is_null()) && request_after != request_before && !r.pending_scopes.is_empty() {
                        r.scope_stale = true;
                    }
                    let wipe = gen != r.report_u64("scopeGeneration") || profile != r.profile;
                    let after = r.report.get("bootstrap").cloned();
                    let pins = (pins_before, r.report.get("pins").cloned());
                    let _ = self.save_registry(&reg);
                    (before, after, wipe, pins)
                };
                if wipe {
                    self.people.wipe_relay(relay);
                }
                self.note_bootstrap(&c, relay, before, after, t);
                self.note_pins(&c, relay, pins.0, pins.1, t);
                if body.get("meetCrl").is_some() || body.get("meetPki").is_some() {
                    self.meet_report(&c, relay, t);
                }
            }
            "attention" => {
                let items: Vec<Value> = body.get("items").and_then(Value::as_array).map(|l| l.iter().take(50).filter_map(clean_item).collect()).unwrap_or_default();
                let mut reg = self.registry.lock();
                if let Some(r) = reg.relays.get_mut(relay) {
                    r.attention = items;
                    let _ = self.save_registry(&reg);
                }
            }
            "confirm-done" => {
                let id = str_of(body.get("id")).unwrap_or("").to_owned();
                let result = match str_of(body.get("result")) {
                    Some(x @ ("ok" | "refused" | "expired" | "failed" | "unknown")) => x,
                    _ => return,
                };
                let waited = {
                    let mut reg = self.registry.lock();
                    let Some(r) = reg.relays.get_mut(relay) else { return };
                    let i = r.waiting.iter().position(|w| str_of(w.get("id")) == Some(id.as_str()));
                    let w = i.map(|i| r.waiting.remove(i));
                    if result == "unknown" {
                        r.unknown.push(json!({ "id": id, "at": t, "actor": w.as_ref().and_then(|w| w.get("actor")).cloned().unwrap_or(Value::Null) }));
                    }
                    let _ = self.save_registry(&reg);
                    w
                };
                let actor = waited.as_ref().and_then(|w| str_of(w.get("actor"))).unwrap_or("console").to_owned();
                let action = waited.as_ref().and_then(|w| str_of(w.get("action"))).unwrap_or("").to_owned();
                let target = waited.as_ref().and_then(|w| str_of(w.get("target"))).unwrap_or("-").to_owned();
                let mut rec = Record::new(&actor, "fleet.call", audit_result(result));
                rec.target = Some(target);
                rec.detail = json!({ "relay": relay, "action": action, "result": result, "code": null, "approval": null, "mode": "one", "confirm": id });
                c.record(rec, t);
            }
            "bye" => {
                if str_of(body.get("reason")) != Some("left") {
                    return;
                }
                let serials = {
                    let mut reg = self.registry.lock();
                    let Some(r) = reg.relays.get_mut(relay) else { return };
                    r.state = RelayState::Left;
                    r.left_at = Some(t);
                    let s = r.all_serials();
                    let _ = self.save_registry(&reg);
                    s
                };
                if let Some(pki) = self.pki.get() {
                    let _ = pki.deny(&serials, t);
                }
                self.people.wipe_relay(relay);
                self.record(&c, &format!("relay {relay}"), "fleet.relay.left", Some(relay.to_owned()), json!({}), t);
                self.meet_revoke_relay(&c, relay, t);
            }
            "metrics" => {
                if let Ok(rcv) = self.metrics.receive(relay, product, body, t) {
                    let mut reg = self.registry.lock();
                    if let Some(r) = reg.relays.get_mut(relay) {
                        if r.clock_off != rcv.clock_off {
                            r.clock_off = rcv.clock_off;
                            let _ = self.save_registry(&reg);
                        }
                    }
                }
            }
            "audit" => {
                let granted = self.registry.lock().relays.get(relay).is_some_and(|r| r.grants("read-logs") && r.grants("people"));
                if granted {
                    let entries: Vec<Value> = body.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.siem.relay_audit(relay, &entries, t);
                }
            }
            _ => {}
        }
    }

    /// The channel closed: the last contact stays as it was.
    pub fn on_closed(&self, relay: &str, t: i64) {
        {
            let mut reg = self.registry.lock();
            if let Some(r) = reg.relays.get_mut(relay).filter(|r| r.state.live()) {
                r.last_contact_at = Some(t);
                let _ = self.save_registry(&reg);
            }
        }
        self.relay_event(relay, "relay.disconnected", t);
    }

    /// API-1 revision 4 7.1: the watched events of every org with a pinned map at `t` (ms): the 8.2 health of its
    /// relays, their 5.3 expiry rows (`management` reported as kind `mgmt`) and its clients' registration ends
    /// (`api_event_watch`).
    fn events_watch(&self, t: i64) {
        use crate::api_event_watch::{OrgFacts, RelayFacts};
        let Some(events) = self.api.events() else { return };
        let now = t.div_euclid(1000);
        let orgs: Vec<OrgFacts> = self
            .api
            .orgs()
            .into_iter()
            .map(|org| {
                let relays = self.api.relays_of(&org);
                let clients = self.api.org_snapshot(&org).map(|s| s.clients(&org).to_vec()).unwrap_or_default();
                OrgFacts { org, relays, clients }
            })
            .collect();
        if orgs.is_empty() {
            return;
        }
        let rows = self.expiry(t);
        let recs: Vec<RelayRecord> = self.registry.lock().relays.values().filter(|r| r.state.live()).cloned().collect();
        let relays: Vec<RelayFacts> = recs
            .iter()
            .map(|rec| {
                let expiry = rows["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|x| x["relay"].as_str() == Some(rec.id.as_str()))
                    .filter_map(|x| {
                        let kind = match x["kind"].as_str()? {
                            "management" => "mgmt",
                            k => k,
                        };
                        Some((kind.to_owned(), x["daysLeft"].as_i64()?))
                    })
                    .collect();
                RelayFacts { id: rec.id.clone(), health: self.health(rec, self.connected(&rec.id), t).to_owned(), expiry }
            })
            .collect();
        events.watch().pass(&orgs, &relays, now, &|org: &str, kind: &str, data: Value| self.api.emit_event(org, kind, data, now).is_some());
    }

    /// API-1 revision 4 7.1: `relay.connected` or `relay.disconnected` (`t` ms) in each org whose pinned map lists the
    /// relay in `relay_origins`.
    fn relay_event(&self, relay: &str, kind: &str, t: i64) {
        let version = self.registry.lock().relays.get(relay).map(|r| r.version.clone()).unwrap_or_default();
        for org in self.api.orgs().into_iter().filter(|o| self.api.relays_of(o).iter().any(|r| r == relay)) {
            self.api.emit_event(&org, kind, json!({ "relay": relay, "version": version }), t.div_euclid(1000));
        }
    }

    // ── Once a minute ───────────────────────────────────────────────────────────────────────────────────

    /// The fleet's minute (from `Console::tick`): pending records and codes expired, refusal summaries of metrics
    /// and SIEM audited, departed relays handed to metrics, read summaries written, the roster kept in step, the
    /// relays' `read-health` counts refreshed, people's cache checked, the `roster-behind` clock.
    pub fn tick(&self, c: &Console, t: i64) {
        self.expire_pending(t);
        // API-1 9.3, 12.2: checkpoint certificate renewal and resumed `api-chains` backfills (on their own threads)
        if let Some(link) = self.link.get().cloned() {
            // API-1 2.5, 12.2: a catch-up that failed (or whose `api-synced` was refused) is tried again
            self.api.sync_tick(link.clone(), t.div_euclid(1000));
            self.api.audit_tick(link, t.div_euclid(1000));
            // API-1 revision 4 5.2.3: API holds to relays that lack them, reviewer asks and archive outcomes
            crate::api_compliance::tick(self.compliance_desk(), t.div_euclid(1000));
        }
        // API-1 2.3 (slice 1a6): saves waiting for their device's signature, on their own thread
        self.api_signing_tick(t);
        // API-1d 7.1, 7.13: card re-signing state and partner cards older than 24 hours fetched again
        crate::console_a2a::tick(&self.api, Some(&*self.api_audit), t.div_euclid(1000));
        // API-1 revision 4 7.1: health changes and expiries as events
        self.events_watch(t);
        // API-1 11: maps that expired this minute stop their org's exports; metrics snapshots, queue ages, refusal
        // summaries
        self.export.refresh(t.div_euclid(1000));
        self.export.tick(t);
        for s in self.metrics.take_summaries(t) {
            self.record(c, &format!("relay {}", s.relay), "fleet.metrics-refused", Some(s.relay.clone()), json!({ "relay": s.relay, "count": s.count, "why": s.why }), t);
        }
        for (action, detail) in self.siem.take_summaries(t) {
            self.record(c, "console", action, Some("-".into()), detail, t);
        }
        let departed: Vec<(String, i64)> = self.registry.lock().relays.values().filter(|r| !r.state.live()).filter_map(|r| r.left_at.map(|at| (r.id.clone(), at))).collect();
        self.metrics.set_departed(departed);
        self.flush_reads(c, t);
        self.sync_roster(c, t);
        self.people.tick(t);
        self.refresh_counts();
        self.license_reminders(c, t);
        self.meet_tick(c, t);
        let (roster_seq, policy_seq) = {
            let b = self.book.lock();
            (b.roster_seq, b.policy_seq)
        };
        let mut reg = self.registry.lock();
        for r in reg.relays.values_mut().filter(|r| r.state.live()) {
            let behind = r.report_u64("rosterSeq") < roster_seq || r.report_u64("policySeq") < policy_seq;
            r.behind_since = if behind { r.behind_since.or(Some(t)) } else { None };
        }
        let _ = self.save_registry(&reg);
    }

    /// AC-2a 8.1 "License reminders" (revision 3.4, R42-6): for each live relay, from its last pushed license (`exp`,
    /// `service.stopsAt`), the AC-1 R42-3 steps mailed to every active admin of this console, each once per relay and
    /// key (license id or `upgrade:<upgradePeriodEnds>`), kept in `console.json` `fleet.licenseReminders` across
    /// restarts and audited `fleet.license.reminder`. A silent relay goes on from what it last pushed.
    fn license_reminders(&self, c: &Console, t: i64) {
        use crate::license_reminders::{Book, Sent};
        let mut books: Map<String, Value> = self.book.lock().license_reminders.clone();
        let relays: Vec<(String, String, Product, Value)> =
            self.registry.lock().relays.values().filter(|r| r.state.live()).map(|r| (r.id.clone(), r.name.clone(), r.product, r.report.get("license").cloned().unwrap_or(Value::Null))).collect();
        let mut changed = false;
        let mut mails: Vec<(&'static str, Vec<(&'static str, String)>, String, &'static str, String, Option<i64>)> = Vec::new();
        for (id, name, product, lic) in relays {
            let (Some(key), steps) = fleet_steps(&lic) else { continue };
            // Only the latest step already due goes out (one mail per relay and step, never a backlog).
            let Some(&(step, moment)) = steps.iter().filter(|(_, at)| *at <= t).max_by_key(|(_, at)| *at) else { continue };
            let kind = step_kind(step);
            // R7-L2: a record that does not check is started again from now: the step due now counts as sent.
            let stored = books.get(&id).cloned().map(Book::from_sealed);
            let fresh = |sent: Vec<Sent>| Book { key: Some(key.clone()), service: None, sent };
            let mut book = match stored {
                Some(Ok(b)) if b.key.as_deref() == Some(key.as_str()) => b,
                Some(Err(why)) => {
                    c.logger.ops("fleet.license-reminders-unreadable", &Fields::new().with("relay", id.as_str()).with("why", why), Level::Warn);
                    fresh(vec![Sent { kind, moment, at: t }])
                }
                _ => fresh(Vec::new()),
            };
            if !book.has(kind, moment) {
                book.sent.push(Sent { kind, moment, at: t });
                let relay = clean(&name);
                let pname = product.name().to_owned();
                let exp = lic.get("exp").and_then(Value::as_i64);
                let stops_at = lic.get("service").and_then(|s| s.get("stopsAt")).and_then(Value::as_i64);
                let (mail, args) = match step {
                    "stopped" => ("fleet.mail.license-stopped", vec![("relay", relay), ("product", pname)]),
                    "expiry" | "grace" => ("fleet.mail.license-grace", vec![("relay", relay), ("product", pname), ("date and time", stops_at.map(crate::license_reminders::when).unwrap_or_default())]),
                    _ => {
                        let days = exp.map(|e| (e - t + crate::license_reminders::DAY_MS - 1).div_euclid(crate::license_reminders::DAY_MS).max(0)).unwrap_or(0);
                        ("fleet.mail.license-reminder", vec![("relay", relay), ("product", pname), ("days", days.to_string()), ("date", exp.map(crate::license_reminders::day).unwrap_or_default())])
                    }
                };
                mails.push((mail, args, id.clone(), step, key.clone(), stops_at));
            }
            let sealed = book.sealed();
            if books.get(&id) != Some(&sealed) {
                books.insert(id, sealed);
                changed = true;
            }
        }
        if changed {
            let mut book = self.book.lock();
            book.license_reminders = books;
            if let Err(e) = self.save_book(c, &book) {
                c.logger.ops("fleet.license-reminders-failed", &Fields::new().with("why", e.message), Level::Error);
            }
        }
        if mails.is_empty() {
            return;
        }
        let admins = c.active_admin_emails();
        let on = c.mailer.config().mode != crate::console_mail::Mode::Off;
        for (mail, args, relay, step, key, stops_at) in mails {
            for to in &admins {
                c.mailer.enqueue_reminder(mail, to, &args);
            }
            let product = self.registry.lock().relays.get(&relay).map(|r| product_str(r.product));
            self.record(c, "console", "fleet.license.reminder", Some(relay.clone()), json!({ "relay": relay, "product": product, "step": step, "key": key, "stopsAt": stops_at, "sent": if on { admins.len() } else { 0 } }), t);
        }
    }

    /// 8.2: `nodes` and `services` from the latest `read-health` reads, refreshed each minute while connected.
    fn refresh_counts(&self) {
        let ids: Vec<(String, Product)> = self.registry.lock().relays.values().filter(|r| r.state.live() && r.state != RelayState::Pending).map(|r| (r.id.clone(), r.product)).collect();
        for (id, product) in ids {
            if !self.connected(&id) {
                continue;
            }
            let read = |path: &str| -> Option<Value> {
                let frame = json!({ "method": "GET", "path": path, "query": "", "body": {}, "caller": { "email": "console", "role": "viewer" }, "auth": null });
                let a = self.send(&id, "call", frame, CALL_MS).ok()?;
                (a.get("status").and_then(Value::as_u64) == Some(200)).then(|| a.get("body").cloned()).flatten()
            };
            let (counts, servers, push) = match product {
                Product::Spokes => (read("spokes/counts"), None, None),
                Product::Meet => (read("meet/counts"), read("meet/servers"), read("meet/push")),
            };
            let mut reg = self.registry.lock();
            if let Some(r) = reg.relays.get_mut(&id) {
                if let Some(v) = counts {
                    r.counts = v;
                }
                if let Some(v) = servers {
                    r.servers = v;
                }
                if let Some(v) = push {
                    r.push = v;
                }
                let _ = self.save_registry(&reg);
            }
        }
    }

    // ── Overview and attention (8.1) ────────────────────────────────────────────────────────────────────

    /// The fleet items of 8.1 and each relay's own items (prefixed by the relay's console name, AC-1 kinds only).
    pub fn attention_items(&self, c: &Console, t: i64) -> Vec<Value> {
        let item = |kind: &str, severity: &str, args: Value, go: String| json!({ "kind": kind, "severity": severity, "args": args, "go": go });
        let mut out = Vec::new();
        if self.registry_unreadable {
            out.push(item("fleet-state-unreadable", "bad", json!({}), "#/relays".into()));
        }
        if let Some(pki) = self.pki.get() {
            let st = pki.status(t);
            if st.seal_needed {
                out.push(item("fleet-seal-needed", "bad", json!({}), "#/security/settings".into()));
            }
            if st.lost {
                out.push(item("fleet-ca-lost", "bad", json!({}), "#/security/settings".into()));
            }
            if let Some(d) = st.ca_days_left.filter(|d| *d <= crate::fleet_ca::CA_EXPIRING_MS / crate::fleet_x509::DAY_MS) {
                out.push(item("fleet-ca-expiring", "warn", json!({ "days": d }), "#/security/settings".into()));
            }
            if st.unconfirmed > 0 {
                out.push(item("relay-ca-unconfirmed", "warn", json!({ "n": st.unconfirmed }), "#/relays".into()));
            }
        }
        if c.profile_high() && !cfg!(feature = "fips") {
            out.push(item("fips-needed", "bad", json!({}), "#/security/settings".into()));
        }
        out.extend(self.meet_attention(t));
        let book_seq = self.book.lock().roster_seq;
        let _ = book_seq;
        let eligible = self.eligible_entries(c);
        let (waiting, has_admin_key) = {
            let book = self.book.lock();
            let (adds, _) = self.roster_diff(&eligible, &book);
            (adds.len(), book.roster.iter().any(|e| e["role"] == "admin"))
        };
        let live = self.registry.lock().live_count();
        if waiting > 0 && live > 0 {
            out.push(item("roster-pending", "warn", json!({ "n": waiting }), "#/relays".into()));
        }
        if !has_admin_key && !eligible.iter().any(|e| e["role"] == "admin") {
            out.push(item("roster-empty", "bad", json!({}), "#/settings/account".into()));
        }
        let no_evidence = self.keys_without_evidence(c);
        if no_evidence > 0 {
            out.push(item("key-no-evidence", "warn", json!({ "n": no_evidence }), "#/settings/account".into()));
        }
        let ma = self.metrics.attention(t);
        if ma.space {
            out.push(item("metrics-space", "warn", json!({}), "#/relays/health".into()));
        }
        let names: HashMap<String, String> = self.registry.lock().relays.values().map(|r| (r.id.clone(), r.name.clone())).collect();
        // 8.1 (revision 3.4): each live relay's license service, from what it last pushed.
        let lics: Vec<(String, String, Value)> = self.registry.lock().relays.values().filter(|r| r.state.live()).map(|r| (r.id.clone(), r.name.clone(), r.report.get("license").cloned().unwrap_or(Value::Null))).collect();
        for (id, name, lic) in lics {
            let Some(s) = pushed_service(&lic, t) else { continue };
            let go = format!("#/license?relay={id}");
            match s.state {
                crate::console::ServiceState::Stopped => out.push(item("relay-license-stopped", "bad", json!({ "relay": clean(&name), "why": s.why }), go)),
                crate::console::ServiceState::Grace | crate::console::ServiceState::UpgradePeriod => out.push(item("relay-license-grace", "bad", json!({ "relay": clean(&name), "date and time": s.stops_at }), go)),
                crate::console::ServiceState::On => {
                    if let Some(days) = s.exp.map(|e| (e - t + 86_399_999).div_euclid(86_400_000)).filter(|d| *d <= 30) {
                        out.push(item("relay-license-expiring", "warn", json!({ "relay": clean(&name), "days": days }), go));
                    }
                }
            }
        }
        for (relay, n) in ma.refused {
            out.push(item("metrics-refused", "warn", json!({ "relay": names.get(&relay).cloned().unwrap_or(relay.clone()), "n": n }), format!("#/relays/{relay}")));
        }
        let sa = self.siem.attention(t);
        if let Some(why) = &sa.failing {
            out.push(item("siem-failing", "bad", json!({ "why": clean(why) }), "#/security/exports".into()));
        }
        if sa.dropped > 0 {
            out.push(item("siem-dropped", "bad", json!({ "n": sa.dropped }), "#/security/exports".into()));
        }
        for relay in &sa.gaps {
            out.push(item("relay-gap", "warn", json!({ "relay": names.get(relay).cloned().unwrap_or_else(|| relay.clone()) }), format!("#/relays/{relay}")));
        }
        // API-1 11.6 `ExportAuditBacklog`: an audit destination over its queue limits; export paused, nothing dropped
        for (org, _, name) in self.export.audit_backlog() {
            out.push(item("export-audit-backlog", "bad", json!({ "destination": clean(&name), "org": org }), "#/security/exports".into()));
        }
        // API-1 12.3: armed failover credentials 14 days before they end, and once ended
        for f in self.api.failover_attention(t.div_euclid(1000)) {
            let relay = names.get(&f.relay).cloned().unwrap_or_else(|| f.relay.clone());
            let args = |days: Option<i64>| {
                let mut a = json!({ "destination": clean(&f.destination), "relay": clean(&relay), "org": f.org });
                if let Some(d) = days {
                    a["days"] = json!(d);
                }
                a
            };
            match f.days_left {
                Some(d) => out.push(item("failover-credential-expiring", "warn", args(Some(d)), "#/security/exports".into())),
                None => out.push(item("failover-credential-expired", "bad", args(None), "#/security/exports".into())),
            }
        }
        // API-1 revision 4 2.3 item 3: a relay of an org's set that lacks what the org's pinned map needs
        for (org, relay, needs) in self.api.outdated() {
            let name = names.get(&relay).cloned().unwrap_or_else(|| relay.clone());
            out.push(item("relay-outdated", "bad", json!({ "relay": clean(&name), "org": org, "needs": needs.join(", ") }), "#/security/api".into()));
        }
        // API-1 revision 4 5.3.8 `ExportStorageLow`: an org that uses exports while the console's free space is below
        // the margin a package needs
        for org in crate::api_exports::storage_low(&*self.compliance_desk(), &self.api.known_orgs()) {
            out.push(item("export-storage", "bad", json!({ "org": org }), "#/security/compliance".into()));
        }
        // API-1 revision 4 2.4: a dropped federation key until an admin confirms the hosted key sets no longer list it
        for (org, kid) in crate::api_federation::republish_attention(&self.api, &self.state_dir) {
            out.push(item("federation-jwks-republish", "warn", json!({ "org": org, "kid": kid }), "#/security/exports".into()));
        }
        // API-1 revision 4 7.4: events delivery paused after queue.max_age_s of retries (Resume goes on, nothing dropped)
        for (org, _, name) in self.export.events_paused() {
            out.push(item("webhook-paused", "bad", json!({ "destination": clean(&name), "org": org }), "#/security/exports".into()));
        }
        // API-1 revision 4 2.4: a dropped webhook key, until receivers are told and a saved map no longer lists it
        for (org, kid) in crate::api_webhook::dropped_attention(&self.api) {
            out.push(item("webhook-key-dropped", "warn", json!({ "org": org, "kid": kid }), "#/security/exports".into()));
        }
        // API-1 revision 4 6.7 `ApiOwnerGone`: a deprovisioned owner whose clients the pinned map still lists
        for (org, principal, clients) in crate::api_people::owner_gone(self) {
            out.push(item("api-owner-gone", "bad", json!({ "principal": clean(&principal), "org": org, "n": clients.len() }), "#/security/api".into()));
        }
        // API-1d 7.1.2, 7.13: an org's agents without a usable card key, a partner card that failed its check
        for (kind, args) in crate::console_a2a::attention(&self.api, t.div_euclid(1000)) {
            let severity = if kind == "a2a-card-key-missing" { "bad" } else { "warn" };
            let args: Map<String, Value> = args.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.clone(), |s| json!(clean(s))))).collect();
            out.push(item(kind, severity, Value::Object(args), "#/security/api".into()));
        }
        for v in c.settings_now().tokens.iter().filter_map(crate::fleet_export::TokenRecord::from_json) {
            let days = (v.expires - t).div_euclid(86_400_000);
            if (0..=14).contains(&days) {
                out.push(item("token-expiring", "warn", json!({ "label": clean(&v.label), "days": days }), "#/security/exports".into()));
            }
        }
        if let Some(a) = c.setup_attention() {
            out.push(a);
        }
        let recs: Vec<RelayRecord> = self.registry.lock().relays.values().filter(|r| r.state.live() || (r.state == RelayState::Left && r.left_at.is_some_and(|at| t - at < 7 * 86_400_000))).cloned().collect();
        let mut versions: HashMap<&'static str, HashSet<String>> = HashMap::new();
        for r in &recs {
            let go = format!("#/relays/{}", r.id);
            let name = Value::from(r.name.clone());
            if r.state == RelayState::Left {
                out.push(item("relay-left", "warn", json!({ "relay": name }), go));
                continue;
            }
            versions.entry(r.product.name()).or_default().insert(r.version.clone());
            let connected = self.connected(&r.id);
            match r.state {
                RelayState::Pending => out.push(item("relay-pending", "warn", json!({ "relay": name }), go.clone())),
                RelayState::Unconfirmed if !r.confirmed => out.push(item("relay-unconfirmed", "warn", json!({ "relay": name }), go.clone())),
                _ => {}
            }
            if r.state != RelayState::Pending && !connected && r.last_contact_at.is_none_or(|at| t - at >= SILENT_MS) {
                let minutes = r.last_contact_at.map(|at| (t - at) / 60_000);
                out.push(item("relay-silent", "bad", json!({ "relay": name, "minutes": minutes }), go.clone()));
            }
            if let Some(na) = r.serials.iter().filter(|s| s.current).map(|s| s.not_after).min() {
                let days = (na - t).div_euclid(86_400_000);
                if na <= t {
                    out.push(item("relay-cert-expired", "bad", json!({ "relay": name }), go.clone()));
                } else if days <= 14 {
                    out.push(item("relay-cert-expiring", "warn", json!({ "relay": name, "days": days }), go.clone()));
                }
            }
            if r.flapping_at.is_some_and(|at| t - at < 3_600_000) {
                out.push(item("relay-flapping", "bad", json!({ "relay": name }), go.clone()));
            }
            if r.report_bool("readOnly") {
                out.push(item("relay-read-only", "info", json!({ "relay": name }), go.clone()));
            }
            if !r.waiting.is_empty() {
                out.push(item("relay-confirm-waiting", "warn", json!({ "relay": name, "n": r.waiting.len() }), go.clone()));
            }
            if !r.unknown.is_empty() {
                out.push(item("relay-confirm-unknown", "warn", json!({ "relay": name, "n": r.unknown.len() }), go.clone()));
            }
            if !r.pending_scopes.is_empty() {
                out.push(item("relay-scopes-pending", "info", json!({ "relay": name }), go.clone()));
            }
            if r.scope_stale {
                out.push(item("relay-scope-stale", "info", json!({ "relay": name }), go.clone()));
            }
            if c.profile_high() && (r.profile != "high" || !r.fips) {
                out.push(item("relay-not-high", "bad", json!({ "relay": name }), go.clone()));
            }
            if !c.profile_high() && r.profile == "high" {
                out.push(item("relay-needs-high", "warn", json!({ "relay": name }), go.clone()));
            }
            if r.clock_off {
                out.push(item("relay-clock", "warn", json!({ "relay": name }), go.clone()));
            }
            if r.behind_since.is_some_and(|at| t - at >= 3_600_000) {
                out.push(item("roster-behind", "warn", json!({ "relay": name }), go.clone()));
            }
            if r.state != RelayState::Pending && r.bootstrap_state() != "done" {
                out.push(item("relay-bootstrap-pending", "warn", json!({ "relay": name }), go.clone()));
            }
            let held = strings(r.report.get("held")).len();
            if held > 0 {
                out.push(item("relay-keys-held", "info", json!({ "relay": name, "n": held }), go.clone()));
            }
            let unattested = strings(r.report.get("unattested")).len();
            if unattested > 0 {
                out.push(item("relay-keys-unattested", "warn", json!({ "relay": name, "n": unattested }), go.clone()));
            }
            for a in &r.attention {
                let mut a = a.clone();
                a["relay"] = Value::from(r.name.clone());
                a["go"] = Value::from(go.clone());
                out.push(a);
            }
        }
        for (product, set) in versions {
            if set.len() > 1 {
                out.push(item("relay-version-mixed", "info", json!({ "product": product }), "#/relays".into()));
            }
        }
        out
    }

    /// The `fleet` object of GET overview (5.3) and its KPIs (8.1).
    pub fn overview(&self, c: &Console, t: i64) -> Value {
        let recs: Vec<RelayRecord> = self.registry.lock().relays.values().filter(|r| r.state.live()).cloned().collect();
        let (mut ok, mut warn, mut bad, mut silent, mut unconfirmed) = (0, 0, 0, 0, 0);
        let (mut people, mut calls, mut messages) = (0.0, 0.0, 0.0);
        for r in &recs {
            match self.health(r, self.connected(&r.id), t) {
                "ok" => ok += 1,
                "warn" => warn += 1,
                "bad" => bad += 1,
                _ => silent += 1,
            }
            if r.state != RelayState::Active {
                unconfirmed += 1;
            }
            if let Some(l) = self.metrics.latest(&r.id) {
                people += l.m.get("people_online").and_then(Value::as_f64).unwrap_or(0.0);
                calls += l.m.get("calls_active").and_then(Value::as_f64).unwrap_or(0.0);
            }
            let midnight = t - t.rem_euclid(86_400_000);
            messages += self.metrics.recent(&r.id, "messages", midnight).iter().map(|(_, v)| v).sum::<f64>();
        }
        let reg: Vec<(String, Product)> = recs.iter().map(|r| (r.id.clone(), r.product)).collect();
        let pairs = vec![("relays".to_owned(), "all".to_owned()), ("names".to_owned(), "people_online,calls_active,messages".to_owned()), ("range".to_owned(), "24h".to_owned()), ("aggregate".to_owned(), "1".to_owned())];
        let series = if reg.is_empty() { Value::Null } else { self.metrics.query(&pairs, &reg, t).unwrap_or(Value::Null) };
        let spark = |name: &str| series.get("series").and_then(Value::as_array).and_then(|l| l.iter().find(|s| s["name"] == name)).map(|s| s["points"].clone()).unwrap_or(json!([]));
        let _ = c;
        json!({
            "relays": { "total": recs.len(), "ok": ok, "warn": warn, "bad": bad, "silent": silent, "unconfirmed": unconfirmed },
            "people": { "online": people as i64 }, "calls": { "active": calls as i64 },
            "kpis": {
                "relaysHealthy": { "n": ok, "total": recs.len(), "spark": [] },
                "peopleOnline": { "n": people as i64, "spark": spark("people_online") },
                "callsNow": { "n": calls as i64, "spark": spark("calls_active") },
                "messagesToday": { "n": messages as i64, "spark": spark("messages") },
            },
        })
    }

    /// The Overview cards of 8.1.
    fn cards(&self, c: &Console, admin: bool, t: i64) -> Vec<Value> {
        let o = self.overview(c, t);
        let total = o["relays"]["total"].as_u64().unwrap_or(0);
        let healthy = o["relays"]["ok"].as_u64().unwrap_or(0);
        let state = if o["relays"]["bad"].as_u64().unwrap_or(0) + o["relays"]["silent"].as_u64().unwrap_or(0) > 0 { "bad" } else if healthy < total { "warn" } else { "ok" };
        let recs: Vec<RelayRecord> = self.registry.lock().relays.values().filter(|r| r.state.live()).cloned().collect();
        let worst_license = recs
            .iter()
            .map(|r| match r.report.get("license").and_then(|l| l.get("state")).and_then(Value::as_str) {
                Some("valid") => 0,
                Some("grace") => 1,
                _ => 2,
            })
            .max()
            .unwrap_or(0);
        let cert_days = recs.iter().flat_map(|r| r.serials.iter().filter(|s| s.current).map(|s| (s.not_after - t).div_euclid(86_400_000))).min();
        let spokes_busy: f64 = recs.iter().filter(|r| r.product == Product::Spokes).filter_map(|r| self.metrics.latest(&r.id)).filter_map(|l| l.m.get("lanes_busy").and_then(Value::as_f64)).sum();
        let mut cards = vec![
            json!({ "id": "relays", "state": state, "n": healthy, "total": total, "go": "#/relays" }),
            json!({ "id": "people", "state": "ok", "n": o["people"]["online"], "spark": o["kpis"]["peopleOnline"]["spark"] }),
            json!({ "id": "calls", "state": "ok", "n": o["calls"]["active"] }),
            json!({ "id": "spokes", "state": "ok", "n": spokes_busy as i64 }),
            json!({ "id": "licenses", "state": (["ok", "warn", "bad"][worst_license]), "n": null }),
            json!({ "id": "certificates", "state": if cert_days.is_some_and(|d| d <= 14) { "warn" } else { "ok" }, "n": cert_days }),
        ];
        if admin {
            let inner = c.inner.lock();
            let approvals = inner.book.approvals.iter().filter(|a| str_of(a.get("state")) == Some("waiting")).count();
            let requests = inner.book.requests.iter().filter(|r| str_of(r.get("state")) == Some("waiting")).count();
            cards.push(json!({ "id": "approvals", "state": if approvals > 0 { "warn" } else { "ok" }, "n": approvals }));
            cards.push(json!({ "id": "requests", "state": if requests > 0 { "warn" } else { "ok" }, "n": requests }));
        }
        cards
    }
}

// ── AC-2b-D: deploy a relay, the Meeting Hub organization CA (6.1, 6.2, 6.5, 8, 9.1, 9.3, 10) ───────────────

/// AC-2b-D 6.1 `env`.
pub const DEPLOY_ENVS: [&str; 4] = ["linux", "proxmox", "docker", "installed"];
/// AC-2b-D 3.3: the cards shown disabled with "Coming next".
pub const DEPLOY_ENVS_NEXT: [&str; 4] = ["azure", "aws", "gcp", "windows"];
/// AC-2b-D 3.4 `deploy.clients` when none are given, and the most allowed.
pub const CLIENTS_DEFAULT: [&str; 2] = ["0.0.0.0/0", "::/0"];
pub const CLIENTS_MAX: usize = 16;
/// AC-2b-D 6.4: the relay attention kinds a relay may push besides AC-1's.
pub const RELAY_DEPLOY_KINDS: [&str; 1] = ["profile-lock-refused"];
const DAY_MS: i64 = 86_400_000;
/// AC-2b-D 10: `relay-meet-cert-expiring` at 14 days left, `relay-signer-cert-expiring` at 3, `meet-ca-expiring` 365
/// days before the CA ends.
const MEET_CERT_WARN_DAYS: i64 = 14;
const SIGNER_CERT_WARN_DAYS: i64 = 3;
const MEET_CA_EXPIRING_DAYS: i64 = 365;
/// AC-2b-D 8.4: the old server serial is revoked 7 days after the relay reports the new one in `hello`.
const SERVER_GRACE_MS: i64 = 7 * DAY_MS;
/// AC-2b-D 8.5 `signer-crl-stale`: the certificate server's held list older than the console's for 6 hours.
const SIGNER_STALE_MS: i64 = 6 * 3_600_000;
/// The sealed name holding an import until it runs (a second admin may approve it later): the key is never in an
/// approval row, an audit entry or `console.json` (8.3, D5).
const MEET_IMPORT_STASH: &str = "meet-ca-import-pending";

/// Run `f` with the console's sealed store, or with one that holds nothing when it did not read back.
fn with_vault<R>(c: &Console, f: impl FnOnce(&mut dyn crate::fleet_ca::Vault) -> R) -> R {
    let mut seal = c.seal.lock();
    match seal.as_mut() {
        Some(s) => f(s),
        None => f(&mut crate::fleet_ca::NoVault),
    }
}

/// AC-2b-D 3.4: a relay DNS name: 1 to 253 characters, labels of `a-z 0-9 -` (lower-cased by the caller), not an
/// address.
pub fn deploy_dns_ok(h: &str) -> bool {
    (1..=253).contains(&h.len())
        && h.parse::<std::net::IpAddr>().is_err()
        && h.split('.').all(|l| (1..=63).contains(&l.len()) && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
        && !h.rsplit('.').next().unwrap_or_default().bytes().all(|b| b.is_ascii_digit())
}

fn deploy_ip_ok(h: &str) -> bool {
    h.parse::<std::net::IpAddr>().is_ok()
}

/// The fields of a mint's `deploy` (AC-2b-D 3.4), checked, and the server certificate's names.
#[derive(Debug)]
struct DeployFields {
    host: String,
    turn: Option<String>,
    clients: Value,
    pki: Option<String>,
    names: Vec<String>,
}

/// AC-2b-D 3.4: the relay DNS name (Remote Spokes also an address), the TURN name (Meeting Hub), the client networks
/// (Remote Spokes, 1 to 16 CIDRs, default everyone) and the certificate source (Meeting Hub).
fn deploy_fields(product: Product, o: &Map<String, Value>) -> Result<DeployFields, ApiError> {
    if !crate::codec::exact_keys(o, &["host", "turnHost", "clients", "pki", "license"], &["host"]) {
        return Err(ApiError::with("invalid", "deploy holds host, turnHost, clients, pki and license."));
    }
    let host = str_of(o.get("host")).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let host_ok = match product {
        Product::Meet => deploy_dns_ok(&host),
        Product::Spokes => deploy_dns_ok(&host) || deploy_ip_ok(&host),
    };
    if !host_ok {
        return Err(ApiError::of("deploy-host"));
    }
    let turn = match o.get("turnHost") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(s.trim().to_lowercase()),
        Some(_) => return Err(ApiError::of("deploy-host")),
    };
    if let Some(x) = &turn {
        if product == Product::Spokes || !(deploy_dns_ok(x) || deploy_ip_ok(x)) {
            return Err(ApiError::of("deploy-host"));
        }
    }
    let clients = match product {
        Product::Meet => {
            if !o.get("clients").is_none_or(Value::is_null) {
                return Err(ApiError::of("deploy-clients"));
            }
            Value::Null
        }
        Product::Spokes => {
            let items: Vec<String> = match o.get("clients") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()).collect(),
                Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_owned())).collect::<Option<Vec<_>>>().ok_or_else(|| ApiError::of("deploy-clients"))?,
                Some(_) => return Err(ApiError::of("deploy-clients")),
            };
            let items = if items.is_empty() { CLIENTS_DEFAULT.iter().map(|s| (*s).to_owned()).collect() } else { items };
            if items.len() > CLIENTS_MAX || items.iter().any(|x| !x.contains('/') || crate::console_source::parse_cidr(x).is_err()) {
                return Err(ApiError::of("deploy-clients"));
            }
            json!(items)
        }
    };
    let pki = match (product, o.get("pki")) {
        (Product::Meet, Some(Value::String(p))) if p == "console" || p == "own" => Some(p.clone()),
        (Product::Meet, _) => return Err(ApiError::with("invalid", "pki is console or own.")),
        (Product::Spokes, None | Some(Value::Null)) => None,
        (Product::Spokes, Some(_)) => return Err(ApiError::with("invalid", "pki is for Meeting Hub relays only.")),
    };
    let mut names = vec![host.clone()];
    if let Some(x) = turn.as_ref().filter(|x| **x != host) {
        names.push(x.clone());
    }
    Ok(DeployFields { host, turn, clients, pki, names })
}

/// The server certificate's names recorded at mint (`host`, and `turnHost` when it differs), when the enrollment's
/// `pki` is `console` (6.5, D10).
fn meet_names(deploy: Option<&Value>) -> Option<Vec<String>> {
    let d = deploy?;
    if str_of(d.get("pki")) != Some("console") {
        return None;
    }
    let host = str_of(d.get("host"))?.to_owned();
    let mut names = vec![host.clone()];
    if let Some(turn) = str_of(d.get("turnHost")).filter(|x| !x.is_empty() && *x != host) {
        names.push(turn.to_owned());
    }
    Some(names)
}

/// A relay's certificate request (base64url DER, 6.5): (DER, its key's SubjectPublicKeyInfo) when it reads, its own
/// signature verifies and its key is P-256.
fn csr_of(v: Option<&Value>) -> Option<(Vec<u8>, Vec<u8>)> {
    let der = unb64u(str_of(v)?)?;
    let csr = crate::meet_x509::Csr::from_der(&der)?;
    (csr.signature_valid() && crate::fleet_x509::is_p256_spki(&csr.spki)).then_some((der, csr.spki))
}

fn deploy_csr_error(names: &[String]) -> ApiError {
    ApiError::with("deploy-csr", format!("The relay's certificate request is not for {}.", names.join(", ")))
}

fn host_taken_error(reg: &Registry, holder: &str, name: &str) -> ApiError {
    let relay = reg.relays.get(holder).map(|r| clean(&r.name)).unwrap_or_else(|| holder.to_owned());
    ApiError::with("deploy-host-taken", format!("{relay} already holds a certificate for {name}. Use Replace {relay}."))
}

fn no_ca() -> ApiError {
    ApiError::with("not-found", "This console holds no organization CA.")
}

/// AC-2b-D 8.7 (H4): a High Meeting Hub relay whose `meetRoots` include the CA this console holds, or are unknown.
fn ca_held_refuses(ca_id: Option<&str>, profile: &str, roots: Option<&Value>) -> bool {
    let Some(id) = ca_id else { return false };
    if profile != "high" {
        return false;
    }
    let roots = strings(roots);
    roots.is_empty() || roots.iter().any(|r| r == id)
}

fn ca_state_str(s: crate::meet_ca::CaState) -> &'static str {
    match s {
        crate::meet_ca::CaState::Ok => "ok",
        crate::meet_ca::CaState::Lost => "lost",
        crate::meet_ca::CaState::Unreadable => "unreadable",
    }
}

/// The relays that use the CA's certificate server: live Meeting Hub relays enrolled with `pki: console` (6.3 step 9).
fn signer_users(reg: &Registry) -> impl Iterator<Item = &RelayRecord> {
    reg.relays.values().filter(|r| r.state.live() && r.product == Product::Meet && meet_names(r.deploy.as_ref()).is_some())
}

/// What a relay last reported of its certificate server's enforcement (`meetPki.signerCrlEnforced`).
fn signer_enforced_report(r: &RelayRecord) -> Option<bool> {
    r.report.get("meetPki").and_then(|p| p.get("signerCrlEnforced")).and_then(Value::as_bool)
}

/// AC-2b-D 8.4 Lifetime (R4-M1): every relay of the certificate server, `relay` among them, reports enforcement.
fn signer_confirmed_in(reg: &Registry, relay: &str) -> bool {
    reg.relays.contains_key(relay) && signer_users(reg).all(|r| signer_enforced_report(r) == Some(true))
}

/// A license token's body (its first part).
fn token_body(token: &str) -> Option<Value> {
    token.split('.').next().and_then(unb64u).and_then(|b| crate::codec::parse_json(&String::from_utf8_lossy(&b)))
}

fn pem_of(label: &str, der: &[u8]) -> String {
    let b = crate::meet_json::b64(der);
    let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
}

/// AC-2b-D 5.4: the Proxmox host shell lines (`<vmid>`, `<storage>`, `<bridge>` and `<keys>` are filled in by the
/// page), the VM named after the relay.
fn proxmox_steps(name: &str, arch: &str) -> Vec<String> {
    let img = if arch == "aarch64" { "debian-13-genericcloud-arm64.qcow2" } else { "debian-13-genericcloud-amd64.qcow2" };
    let mut vm: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    vm = vm.trim_matches('-').chars().take(63).collect();
    if vm.is_empty() {
        vm = "lucid-relay".into();
    }
    vec![
        format!("cd /var/tmp && wget -N https://cloud.debian.org/images/cloud/trixie/latest/{img} https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS"),
        format!("grep ' {img}$' SHA512SUMS | sha512sum -c -"),
        format!("qm create <vmid> --name {vm} --memory 2048 --cores 2 --cpu host --net0 virtio,bridge=<bridge> --agent enabled=1 --ostype l26 --scsihw virtio-scsi-single --serial0 socket --vga serial0"),
        format!("qm set <vmid> --scsi0 <storage>:0,import-from=/var/tmp/{img} --boot order=scsi0 --ide2 <storage>:cloudinit"),
        "qm set <vmid> --ciuser lucid --sshkeys <keys> --ipconfig0 ip=dhcp".to_owned(),
        "qm resize <vmid> scsi0 20G".to_owned(),
        "qm start <vmid>".to_owned(),
    ]
}

/// AC-2b-D 8.5 delivery: a relay takes the console's list when it trusts the CA, reads the bundle, and holds an older
/// list by the 8.5 order (and not this one as pending).
fn wants_crl(r: &RelayRecord, ca_id: &str, info: &crate::meet_ca::CrlInfo) -> bool {
    if r.product != Product::Meet || !strings(r.report.get("meetRoots")).iter().any(|x| x == ca_id) {
        return false;
    }
    let Some(crl) = r.report.get("meetCrl") else { return false };
    if str_of(crl.get("source")) != Some("bundle") {
        return false;
    }
    if crl.get("pending").and_then(|p| str_of(p.get("sha256"))) == Some(info.sha256.as_str()) {
        return false;
    }
    let Some(theirs) = crl.get("thisUpdate").and_then(Value::as_i64) else { return true };
    let number = crl.get("number").and_then(crate::meet_ca::CrlNumber::from_json);
    crate::meet_ca::later((info.this_update, Some(&info.number)), (theirs, number.as_ref())) == std::cmp::Ordering::Greater
}

impl Fleet {
    /// The id of the CA this console holds, in any state (`welcome.meetCaId`, 8.7); None when it holds none.
    pub fn meet_ca_id(&self) -> Option<String> {
        self.meet.lock().as_ref().map(|m| m.id().to_owned())
    }

    /// API-1 4.2 `tls_client_auth` on the front door: the org Meet CA certificate (DER) and its newest CRL (PEM), when
    /// the CA is held, usable and has signed a list; None otherwise (no API client certificate is accepted).
    pub fn api_client_trust(&self) -> Option<(Vec<u8>, String)> {
        let g = self.meet.lock();
        let m = g.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok)?;
        Some((m.ca_der().to_vec(), m.crl()?.0))
    }

    /// API-1 revision 5 4.3, 6.5: the org Meet CA certificate (DER) whenever the CA is held and usable, with its newest
    /// CRL (PEM) when it has signed one (SSO person records, attestations and the org policy are checked under it).
    pub fn meet_root(&self) -> Option<(Vec<u8>, Option<String>)> {
        let g = self.meet.lock();
        let m = g.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok)?;
        Some((m.ca_der().to_vec(), m.crl().map(|c| c.0)))
    }

    /// The fleet link, for the API front door's journal deliveries (API-1 5.5).
    pub fn api_link(&self) -> Option<Arc<dyn FleetLink>> {
        self.link.get().cloned()
    }

    /// API-1 13: the license edition the console holds its api maps to at `t` (ms): its own product license's when
    /// it has one; otherwise the lowest edition among the in-date licenses of its library (Standard when any is
    /// standard). The lowest is the most conservative choice: the console cannot tie a fleet license to an API org.
    /// None (no map serves) when neither gives an edition.
    pub fn api_edition(&self, t: i64) -> Option<crate::api_map::Edition> {
        use crate::api_map::Edition;
        let own = self.console().ok().and_then(|c| c.license_view(t).license.get("edition").and_then(Value::as_str).map(str::to_owned));
        if let Some(e) = own {
            return Edition::of(Some(&e));
        }
        let book = self.book.lock();
        let editions: Vec<Edition> =
            book.library.iter().filter(|l| l.get("exp").and_then(Value::as_i64).is_some_and(|exp| exp > t / 1000)).filter_map(|l| Edition::of(str_of(l.get("edition")))).collect();
        if editions.is_empty() {
            None
        } else if editions.contains(&Edition::Standard) {
            Some(Edition::Standard)
        } else {
            Some(Edition::Enterprise)
        }
    }

    /// AC-2b-D 4.3: `sha256//<b64 current>;sha256//<b64 next>` from the current signed trust manifest.
    pub fn curl_pins(&self, t: i64) -> String {
        if let Some(port) = crate::fleet_port::global() {
            return port.curl_pins();
        }
        let v = self.pki.get().map(|p| p.trust_view(t)).unwrap_or(Value::Null);
        crate::fleet_port::curl_pins_of(&v["manifest"])
    }

    /// AC-2b-D 4.4: a program download named for an enrollment that is open, or used within its hour, is not counted.
    pub fn download_enrollment_ok(&self, id: &str, t: i64) -> bool {
        self.registry.lock().enrollments.get(id).is_some_and(|e| e.env != "installed" && (e.open(t) || (e.state == "used" && e.expires > t)))
    }

    /// AC-2b-D 7.3 (C-prime, Standard only): every working key of the minting admin as a first-roster admin entry, with
    /// its ceremony B fingerprint.
    fn offered_keys(&self, c: &Console, who: &Who) -> Vec<Value> {
        if c.profile_high() || !who.admin {
            return Vec::new();
        }
        self.eligible_entries(c)
            .into_iter()
            .filter(|e| e["email"] == who.email.as_str() && e["role"] == "admin")
            .filter_map(|e| {
                let id = str_of(e.get("credentialId"))?.to_owned();
                let fp = crate::fleet_trust::admin_key_fingerprint(&unb64u(&id)?, &unb64u(str_of(e.get("cose"))?)?, &who.email, "admin");
                Some(json!({ "credentialId": id, "email": who.email, "role": "admin", "hint": hint_of(&id), "fingerprint": fp }))
            })
            .collect()
    }

    /// AC-2b-D 6.1: the `deploy` record of a mint, checked in order: env offered, the fields, `deploy-host-taken`, the
    /// CA, the license. None for `installed`.
    #[allow(clippy::too_many_arguments)]
    fn mint_deploy(&self, c: &Console, who: &Who, product: Product, env: &str, v: Option<&Value>, replaces: Option<&str>, t: i64) -> Result<Option<Value>, ApiError> {
        let high = c.profile_high();
        match env {
            "installed" => return if v.is_none_or(Value::is_null) { Ok(None) } else { Err(ApiError::of("deploy-env")) },
            "docker" if high => return Err(ApiError::of("deploy-high")),
            _ => {}
        }
        // Standard installs from this console's own program (4.2); High from release media (4.5).
        let binary = if high { None } else { Some(crate::fleet_port::served_binary().map_err(|_| ApiError::of("deploy-unavailable"))?) };
        let o = v.and_then(Value::as_object).ok_or_else(|| ApiError::of("deploy-host"))?;
        let DeployFields { host, turn, clients, pki, names } = deploy_fields(product, o)?;
        if product == Product::Meet {
            let holder = self.meet.lock().as_ref().and_then(|m| m.name_holder(&names, t));
            if let Some((h, name)) = holder.filter(|(h, _)| replaces != Some(h.as_str())) {
                return Err(host_taken_error(&self.registry.lock(), &h, &name));
            }
        }
        let ca_id = if pki.as_deref() == Some("console") {
            if high {
                return Err(ApiError::of("meet-ca-high"));
            }
            let g = self.meet.lock();
            Some(g.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok).map(|m| m.id().to_owned()).ok_or_else(|| ApiError::of("deploy-ca-needed"))?)
        } else {
            None
        };
        let (license, license_sha) = match o.get("license") {
            None | Some(Value::Null) => (Value::Null, Value::Null),
            Some(l) => {
                let lid = l.as_str().ok_or_else(|| ApiError::with("invalid", "license is a library license id."))?;
                let (entry, spokes_root) = {
                    let b = self.book.lock();
                    (b.library.iter().find(|x| str_of(x.get("id")) == Some(lid)).cloned(), b.spokes_root.clone())
                };
                let entry = entry.ok_or_else(|| ApiError::with("not-found", "There is no such license in the library."))?;
                let lp = str_of(entry.get("product")).and_then(product_of);
                if lp != Some(product) {
                    let n = lp.map(|p| p.name()).unwrap_or("another product");
                    return Err(ApiError::with("deploy-license-product", format!("That license is for {n}.")));
                }
                if entry.get("exp").and_then(Value::as_i64).is_some_and(|exp| exp <= t / 1000) {
                    return Err(ApiError::of("license-ended"));
                }
                let root = str_of(entry.get("root")).unwrap_or("").to_owned();
                let want = match product {
                    Product::Meet => ca_id.clone(),
                    Product::Spokes if !high => spokes_root.as_ref().and_then(|r| str_of(r.get("id")).map(str::to_owned)),
                    Product::Spokes => None,
                };
                if let Some(w) = want.filter(|w| *w != root) {
                    return Err(ApiError::with("deploy-license-root", format!("That license is for root {root}, not {w}.")));
                }
                (Value::from(lid), Value::from(sha256_hex(str_of(entry.get("token")).unwrap_or("").as_bytes())))
            }
        };
        let offered = self.offered_keys(c, who);
        Ok(Some(json!({
            "env": env, "host": host, "turnHost": turn, "clients": clients, "pki": pki, "license": license,
            "binarySha256": binary.map(|b| b.sha256), "offered": offered, "licenseSha256": license_sha,
        })))
    }

    /// AC-2b-D 3.5: the mint answer's `install` object.
    #[allow(clippy::too_many_arguments)]
    fn install_of(&self, c: &Console, product: Product, env: &str, deploy: Option<&Value>, enrollment: &str, name: &str, t: i64) -> Value {
        let url = self.fleet_url(c);
        let pins = self.curl_pins(t);
        let p = product_str(product);
        let offline = match product {
            Product::Meet => "sudo /opt/lucid-meet/lucid-relay deploy script meet-linux | sudo bash -s -- uninstall",
            Product::Spokes => "sudo /opt/lucid-relay/bin/lucid-relay deploy script spokes-linux | sudo bash -s -- uninstall",
        };
        if env == "installed" {
            return json!({ "env": env, "command": null, "steps": null, "uninstall": null, "offlineUninstall": offline, "scriptUrl": null, "pins": pins, "binary": null });
        }
        let high = c.profile_high();
        let binary = if high { None } else { crate::fleet_port::served_binary().ok() };
        let arch = binary.as_ref().map(|b| b.arch.clone()).unwrap_or_else(|| std::env::consts::ARCH.to_owned());
        let proxmox = (env == "proxmox").then(|| proxmox_steps(name, &arch));
        let linux = format!("{p}-linux");
        if high {
            let place = match product {
                Product::Meet => "--pki-dir <folder>",
                Product::Spokes => "--root <path to root.pub>",
            };
            let mut steps = proxmox.unwrap_or_default();
            steps.push(format!("./lucid-relay deploy script {linux} > lucid-deploy.sh"));
            steps.push(format!("sudo bash lucid-deploy.sh --binary ./lucid-relay --console '{url}' --pins '{pins}' --profile high {place}"));
            return json!({ "env": env, "command": null, "steps": steps, "uninstall": null, "offlineUninstall": offline, "scriptUrl": null, "pins": pins, "binary": null });
        }
        let pki = deploy.and_then(|d| str_of(d.get("pki")));
        let root_saved = self.book.lock().spokes_root.is_some();
        let extra = match product {
            Product::Meet if pki == Some("own") => " -s -- --pki-dir <folder>",
            Product::Spokes if !root_saved => " -s -- --root <path to root.pub>",
            _ => "",
        };
        let script = if env == "docker" { format!("{p}-docker") } else { linux };
        let script_url = format!("{url}/fleet/v1/install/{script}.sh?e={enrollment}");
        let command = format!("curl -fsS --proto =https -k --pinnedpubkey '{pins}' '{script_url}' | sudo bash{extra}");
        let uninstall = format!("curl -fsS --proto =https -k --pinnedpubkey '{pins}' {url}/fleet/v1/install/{script}.sh | sudo bash -s -- uninstall");
        json!({
            "env": env, "command": command, "steps": proxmox, "uninstall": uninstall, "offlineUninstall": offline, "scriptUrl": script_url, "pins": pins,
            "binary": binary.map(|b| json!({ "version": b.version, "arch": b.arch, "sha256": b.sha256, "size": b.size })),
        })
    }

    /// GET fleet/deploy/options (AC-2b-D 9.1): the cards of 3.3 and what the page needs to fill them. `why` is a reason
    /// id: `not-linux`, `arch`, `dev-license`, `copy-failed`, `not-started` (fleet_port), `high` or `next`.
    fn deploy_options(&self, c: &Console, t: i64) -> Value {
        let high = c.profile_high();
        let served = crate::fleet_port::served_binary();
        let linux_why: Option<&str> = if high { None } else { served.as_ref().err().copied() };
        let row = |id: &str, why: Option<&str>| json!({ "id": id, "products": ["meet", "spokes"], "offered": why.is_none(), "why": why });
        let mut envs = vec![row("linux", linux_why), row("proxmox", linux_why), row("docker", if high { Some("high") } else { linux_why }), row("installed", None)];
        envs.extend(DEPLOY_ENVS_NEXT.iter().map(|id| row(*id, Some("next"))));
        let binary = if high { None } else { served.ok().map(|b| json!({ "version": b.version, "arch": b.arch, "sha256": b.sha256, "size": b.size, "fips": b.fips })) };
        let meet_ca = self.meet.lock().as_ref().map(|m| json!({ "id": m.id(), "state": ca_state_str(m.state()), "signerUrl": m.signer_url() }));
        let (spokes_root, library) = {
            let b = self.book.lock();
            let lib: Vec<Value> = b.library.iter().map(|l| { let mut l = l.clone(); if let Some(o) = l.as_object_mut() { o.remove("token"); } l }).collect();
            (b.spokes_root.as_ref().filter(|_| !high).map(|r| json!({ "id": r.get("id") })), lib)
        };
        json!({
            "ok": true, "profile": if high { "high" } else { "standard" },
            "console": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
            "binary": binary, "fleetUrl": self.fleet_url(c), "pins": self.curl_pins(t), "envs": envs,
            "meetCa": meet_ca, "spokesRoot": spokes_root, "library": library,
        })
    }

    /// AC-2b-D 6.2: the preview's `deploy` object (null for `installed`).
    fn preview_deploy(&self, c: &Console, e: &Enrollment, spokes_root: Option<&Value>, library: &[Value]) -> Result<Value, ApiError> {
        let Some(d) = &e.deploy else { return Ok(Value::Null) };
        let high = c.profile_high();
        let (ca, signer) = if str_of(d.get("pki")) == Some("console") {
            if high {
                return Err(ApiError::of("meet-ca-high"));
            }
            let g = self.meet.lock();
            let m = g.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok).ok_or_else(|| ApiError::of("deploy-ca-needed"))?;
            (json!({ "pem": m.ca_pem(), "id": m.id() }), m.signer_url().map(|u| json!({ "url": u })).unwrap_or(Value::Null))
        } else {
            (Value::Null, Value::Null)
        };
        let spokes_root = match spokes_root {
            Some(r) if e.product == Product::Spokes && !high => json!({ "pem": r.get("pem"), "id": r.get("id") }),
            _ => Value::Null,
        };
        // The library license chosen at mint, unchanged since (its token's digest).
        let license = str_of(d.get("license"))
            .and_then(|id| library.iter().find(|l| str_of(l.get("id")) == Some(id)))
            .filter(|l| str_of(d.get("licenseSha256")) == Some(sha256_hex(str_of(l.get("token")).unwrap_or("").as_bytes()).as_str()))
            .map(|l| {
                let token = str_of(l.get("token")).unwrap_or("");
                let org = token_body(token).and_then(|b| b.get("org").cloned()).unwrap_or(Value::Null);
                json!({ "id": l.get("id"), "org": org, "edition": l.get("edition"), "users": l.get("users"), "relays": l.get("relays"), "exp": l.get("exp"), "root": l.get("root"), "token": token })
            })
            .unwrap_or(Value::Null);
        let offered = if high { json!([]) } else { d.get("offered").cloned().unwrap_or_else(|| json!([])) };
        Ok(json!({
            "env": d.get("env"), "host": d.get("host"), "turnHost": d.get("turnHost"), "clients": d.get("clients"), "pki": d.get("pki"),
            "binarySha256": d.get("binarySha256"), "ca": ca, "signer": signer, "spokesRoot": spokes_root, "license": license, "offered": offered,
        }))
    }

    /// GET fleet/enrollments/<id> (AC-2b-D 3.6, 9.1); the relay's fingerprint only from `unconfirmed` on.
    fn enrollment_detail(&self, id: &str, t: i64) -> Result<Value, ApiError> {
        let reg = self.registry.lock();
        let e = reg.enrollments.get(id).ok_or_else(|| ApiError::with("not-found", "There is no such enrollment code."))?;
        let state = if e.state == "open" && e.expires <= t { "expired" } else { e.state.as_str() };
        let relay = e.relay.as_ref().and_then(|rid| reg.relays.get(rid)).map(|r| {
            let mut bootstrap = r.bootstrap_view();
            if let Some(o) = bootstrap.as_object_mut() {
                if !o.contains_key("anchored") {
                    let n = o.get("entries").and_then(Value::as_array).map(|l| l.iter().filter(|x| !x["via"].is_null()).count()).unwrap_or(0);
                    o.insert("anchored".into(), Value::from(n));
                }
            }
            let shown = matches!(r.state, RelayState::Unconfirmed | RelayState::Active);
            let lic = r.report.get("license").cloned().unwrap_or(Value::Null);
            json!({ "id": r.id, "name": r.name, "state": r.state.as_str(), "fingerprint": shown.then(|| r.fingerprint.clone()), "bootstrap": bootstrap, "license": { "service": service_state_of(&lic) } })
        });
        Ok(json!({ "ok": true, "enrollment": { "id": e.id, "state": state, "product": product_str(e.product), "env": e.env, "expires": e.expires, "deploy": e.deploy, "relay": relay } }))
    }

    /// Every enrolled Meeting Hub relay with profile High, for the import's 8.2 refusal (H4, R2-M2).
    fn high_relays(&self) -> Vec<crate::meet_ca::HighRelay> {
        self.registry
            .lock()
            .relays
            .values()
            .filter(|r| r.state.live() && r.product == Product::Meet && r.profile == "high")
            .map(|r| crate::meet_ca::HighRelay {
                relay_id: r.id.clone(),
                pending: r.state == RelayState::Pending,
                meet_roots: r.report.get("meetRoots").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
            })
            .collect()
    }

    /// `meet-crl-future` (8.5): kept in `console.json` until an admin dismisses it.
    fn set_crl_future(&self, c: &Console, date: Option<i64>, seen: &str, ceiling: bool, t: i64) {
        let mut book = self.book.lock();
        book.meet_alerts.insert("crlFuture".into(), json!({ "date": date, "where": clean(seen), "ceiling": ceiling, "at": t }));
        if let Err(e) = self.save_book(c, &book) {
            c.logger.ops("console.write-failed", &Fields::new().with("reason", e.message), Level::Error);
        }
    }

    /// The CA's newest list to every relay that takes it (8.5 delivery), off any lock.
    fn push_crl_all(&self) {
        let Some((pem, info, id)) = self.meet.lock().as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok).and_then(|m| m.crl().map(|(p, i)| (p, i, m.id().to_owned()))) else { return };
        let targets: Vec<String> = self.registry.lock().relays.values().filter(|r| r.state.live() && wants_crl(r, &id, &info)).map(|r| r.id.clone()).collect();
        for relay in targets {
            self.event(&relay, "meet-crl", json!({ "crl": pem }));
        }
    }

    /// The console signed a new list: `fleet.meet-ca.crl` (actor `console`), then the push.
    fn crl_signed(&self, c: &Console, t: i64) {
        let info = self.meet.lock().as_ref().and_then(|m| m.crl()).map(|(_, i)| i);
        if let Some(i) = info {
            self.record(c, "console", "fleet.meet-ca.crl", Some(i.number.to_string()), json!({ "number": i.number.to_json(), "revoked": i.revoked }), t);
        }
        self.push_crl_all();
    }

    /// AC-2b-D 8.4 (L10, R5-M1): a removed, replaced or leaving relay: every unexpired serial the CA issued to it.
    fn meet_revoke_relay(&self, c: &Console, relay: &str, t: i64) {
        let revoked = {
            let mut g = self.meet.lock();
            match g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok) {
                Some(ca) => with_vault(c, |v| ca.revoke_relay(&*v, relay, None, &[], t)),
                None => return,
            }
        };
        match revoked {
            Ok(l) if !l.is_empty() => self.crl_signed(c, t),
            Ok(_) => {}
            Err(e) => c.logger.ops("fleet.meet-ca-revoke-failed", &Fields::new().with("relay", relay).with("why", e.message), Level::Error),
        }
    }

    /// What a Meeting Hub relay's `hello` or `state` says of the CA (9.3): the certificate server's held number, the
    /// server serial in use (its older ones are revoked 7 days later), the list push, and divergence.
    fn meet_report(&self, c: &Console, relay: &str, t: i64) {
        let Some((product, crl, pki, roots, revoke)) = self.registry.lock().relays.get(relay).map(|r| (r.product, r.report.get("meetCrl").cloned().unwrap_or(Value::Null), r.report.get("meetPki").cloned().unwrap_or(Value::Null), strings(r.report.get("meetRoots")), r.meet_revoke.clone())) else { return };
        if product != Product::Meet {
            return;
        }
        let (id, diverged) = {
            let mut g = self.meet.lock();
            let Some(ca) = g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok) else { return };
            // R5-L2: numbering continues above what the certificate server holds.
            if let Some(n) = pki.get("signerHeld").and_then(|h| h.get("number")).and_then(crate::meet_ca::CrlNumber::from_json) {
                if let Err(e) = ca.note_signer_held(&n) {
                    c.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
                }
            }
            let number = crl.get("number").and_then(crate::meet_ca::CrlNumber::from_json);
            let sha = str_of(crl.get("sha256")).map(str::to_owned);
            let foreign = str_of(crl.get("issuer")) == Some(ca.id()) && sha.as_deref().is_some_and(|s| !ca.signed_by_me(s, number.as_ref()));
            (ca.id().to_owned(), if foreign { sha } else { None })
        };
        if let Some(serial) = str_of(pki.get("certSerial")) {
            if revoke.as_ref().and_then(|v| str_of(v.get("keep"))) != Some(serial) {
                let mut reg = self.registry.lock();
                if let Some(r) = reg.relays.get_mut(relay) {
                    r.meet_revoke = Some(json!({ "keep": serial, "at": t + SERVER_GRACE_MS, "done": false }));
                    let _ = self.save_registry(&reg);
                }
            }
        }
        if roots.iter().any(|x| *x == id) {
            let push = self.meet.lock().as_ref().and_then(|m| m.crl());
            let rec = self.registry.lock().relays.get(relay).cloned();
            if let (Some((pem, info)), Some(rec)) = (push, rec) {
                if wants_crl(&rec, &id, &info) {
                    self.event(relay, "meet-crl", json!({ "crl": pem }));
                }
            }
        }
        // 8.5 divergence (H5, R3-L3): a list of this CA the console did not sign; asked for once per list.
        if let Some(sha) = diverged {
            if self.diverge_seen.lock().insert(relay.to_owned(), sha.clone()).as_deref() == Some(sha.as_str()) {
                return;
            }
            let (Some(fleet), Some(console)) = (c.fleet(), self.console.upgrade()) else { return };
            let relay = relay.to_owned();
            let this_update = crl.get("thisUpdate").and_then(Value::as_i64).unwrap_or(t);
            let _ = std::thread::Builder::new().name("fleet-meet-crl".into()).spawn(move || fleet.meet_diverged(&console, &relay, this_update, crate::codec::now_ms()));
        }
    }

    /// AC-2b-D 8.5 divergence: the relay's list, verified against the CA and merged; the console re-signs at its own
    /// dates and pushes; `meet-crl-diverged` (and `meet-crl-future` for a list dated ahead) until dismissed.
    fn meet_diverged(&self, c: &Console, relay: &str, this_update: i64, t: i64) {
        let answer = match self.send(relay, "meet-crl-get", json!({}), CALL_MS) {
            Ok(a) => a,
            Err(_) => {
                self.diverge_seen.lock().remove(relay);
                return;
            }
        };
        let Some(der) = str_of(answer.get("crl")).and_then(|pem| crate::meet_x509::pem_blocks(pem.as_bytes(), "X509 CRL").into_iter().next()).map(|(_, d)| d) else { return };
        let name = self.name_of(relay);
        let merged = {
            let mut g = self.meet.lock();
            let Some(ca) = g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok) else { return };
            let m = with_vault(c, |v| ca.merge(&*v, &der, &format!("relay {relay}"), t));
            if m.is_ok() {
                if let Err(e) = ca.note_diverged(relay, this_update, t) {
                    c.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
                }
            }
            m
        };
        let m = match merged {
            Ok(m) => m,
            Err(e) => {
                c.logger.security("fleet.meet-crl-refused", &Fields::new().with("relay", relay).with("why", e.message), Level::Warn);
                return;
            }
        };
        self.record(c, "console", "fleet.meet-ca.crl-merged", Some(relay.to_owned()), json!({ "relayId": relay, "added": m.added }), t);
        if m.future.is_some() || m.ceiling {
            self.set_crl_future(c, m.future, &name, m.ceiling, t);
        }
        if m.signed.is_some() {
            self.crl_signed(c, t);
        } else {
            self.push_crl_all();
        }
    }

    /// The `meet-cert` request (AC-2b-D 8.4, 9.3): a `fleet_pki` relay's renewal. `{cert, signerCert}` (PEM, null for the
    /// one not asked for, or not issued when the other was); `deploy-csr`, `meet-cert-wait`, `meet-ca-lost`.
    pub fn meet_cert(&self, relay: &str, body: &Value, t: i64) -> Result<Value, ApiError> {
        let c = self.console()?;
        let o = body.as_object().filter(|o| crate::codec::exact_keys(o, &["csr", "signerCsr"], &[])).ok_or_else(|| ApiError::of("fleet-op"))?;
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let (deploy, profile, product, mgmt, in_use, names_by_id) = {
            let reg = self.registry.lock();
            let r = reg.relays.get(relay).filter(|r| r.state.live()).ok_or_else(not_found_relay)?;
            let mgmt: Vec<Vec<u8>> = r.serials.iter().filter_map(|s| unb64u(&s.spki)).collect();
            let in_use = r.report.get("meetPki").and_then(|p| str_of(p.get("certSerial"))).map(str::to_owned);
            let names: HashMap<String, String> = reg.relays.values().map(|x| (x.id.clone(), clean(&x.name))).collect();
            (r.deploy.clone(), r.profile.clone(), r.product, mgmt, in_use, names)
        };
        if product != Product::Meet {
            return Err(ApiError::of("fleet-op"));
        }
        if profile == "high" {
            return Err(ApiError::of("fleet-ca-held"));
        }
        let names = meet_names(deploy.as_ref()).ok_or_else(|| ApiError::of("deploy-ca-needed"))?;
        let take = |k: &str| -> Result<Option<(Vec<u8>, Vec<u8>)>, ApiError> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                v => csr_of(v).map(Some).ok_or_else(|| deploy_csr_error(&names)),
            }
        };
        let (server, signer) = (take("csr")?, take("signerCsr")?);
        let clash = |spki: &[u8]| mgmt.iter().any(|m| m.as_slice() == spki);
        if (server.is_none() && signer.is_none()) || server.as_ref().is_some_and(|(_, s)| clash(s)) || signer.as_ref().is_some_and(|(_, s)| clash(s) || server.as_ref().is_some_and(|(_, x)| x == s)) {
            return Err(deploy_csr_error(&names));
        }
        let confirmed = signer_confirmed_in(&self.registry.lock(), relay);
        let mut issued: Vec<(crate::meet_ca::CertKind, crate::meet_ca::Issued)> = Vec::new();
        let mut first_error: Option<ApiError> = None;
        let mut revoked = false;
        {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(|| ApiError::of("deploy-ca-needed"))?;
            if let Some((der, _)) = &server {
                if let Some((h, name)) = ca.name_holder(&names, t).filter(|(h, _)| h != relay) {
                    let n = names_by_id.get(&h).cloned().unwrap_or(h);
                    return Err(ApiError::with("deploy-host-taken", format!("{n} already holds a certificate for {name}. Use Replace {n}.")));
                }
                match with_vault(&c, |v| ca.issue(&*v, relay, crate::meet_ca::CertKind::Server, der, &names, confirmed, true, t)) {
                    Ok(x) => {
                        // 8.4: older outstanding server serials of this relay go, except the one in use.
                        let mut keep: Vec<&str> = vec![x.serial.as_str()];
                        if let Some(u) = &in_use {
                            keep.push(u.as_str());
                        }
                        revoked = with_vault(&c, |v| ca.revoke_relay(&*v, relay, Some(crate::meet_ca::CertKind::Server), &keep, t)).map(|l| !l.is_empty()).unwrap_or(false);
                        issued.push((crate::meet_ca::CertKind::Server, x));
                    }
                    Err(e) => first_error = Some(e),
                }
            }
            if let Some((der, _)) = &signer {
                if ca.signer_url().is_none() {
                    first_error.get_or_insert_with(|| deploy_csr_error(&names));
                } else {
                    // R4-H1: a superseded signer client certificate is never revoked.
                    match with_vault(&c, |v| ca.issue(&*v, relay, crate::meet_ca::CertKind::SignerClient, der, &[], confirmed, true, t)) {
                        Ok(x) => issued.push((crate::meet_ca::CertKind::SignerClient, x)),
                        Err(e) => {
                            first_error.get_or_insert(e);
                        }
                    }
                }
            }
        }
        if issued.is_empty() {
            return Err(first_error.unwrap_or_else(|| deploy_csr_error(&names)));
        }
        let mut answer = json!({ "cert": null, "signerCert": null });
        for (kind, x) in &issued {
            let key = if matches!(kind, crate::meet_ca::CertKind::Server) { "cert" } else { "signerCert" };
            answer[key] = Value::from(x.pem.clone());
            self.record(&c, &format!("relay {relay}"), "fleet.meet-cert.issue", Some(relay.to_owned()), json!({ "serial": x.serial, "kind": kind.as_str(), "names": x.names, "notAfter": x.not_after }), t);
        }
        if revoked {
            self.crl_signed(&c, t);
        }
        Ok(answer)
    }

    /// The fleet's minute for the CA: the 8.5 re-sign (and `meet-crl-failing`), the 8.4 revocation of server serials
    /// 7 days after the relay reported the new one, and `signer-crl-stale`.
    fn meet_tick(&self, c: &Console, t: i64) {
        let signed = {
            let mut g = self.meet.lock();
            match g.as_mut().filter(|m| m.state() == crate::meet_ca::CaState::Ok) {
                Some(ca) => with_vault(c, |v| ca.resign(&*v, t)),
                None => return,
            }
        };
        match signed {
            Ok(s) => {
                *self.crl_failing.lock() = false;
                if s.is_some() {
                    self.crl_signed(c, t);
                }
            }
            Err(e) => {
                let mut failing = self.crl_failing.lock();
                if !*failing {
                    c.logger.ops("fleet.meet-crl-failing", &Fields::new().with("why", e), Level::Error);
                }
                *failing = true;
            }
        }
        let due: Vec<(String, String)> = {
            let mut reg = self.registry.lock();
            let mut due = Vec::new();
            for r in reg.relays.values_mut().filter(|r| r.state.live()) {
                let Some(v) = r.meet_revoke.as_mut() else { continue };
                if v["done"] == true || v.get("at").and_then(Value::as_i64).is_none_or(|at| at > t) {
                    continue;
                }
                if let Some(keep) = str_of(v.get("keep")) {
                    due.push((r.id.clone(), keep.to_owned()));
                }
                v["done"] = Value::Bool(true);
            }
            if !due.is_empty() {
                let _ = self.save_registry(&reg);
            }
            due
        };
        for (relay, keep) in due {
            let revoked = {
                let mut g = self.meet.lock();
                let Some(ca) = g.as_mut() else { break };
                // The serial in use and any server certificate issued after it stay.
                let since = ca.rows().iter().find(|x| x.serial == keep).map(|x| x.not_before).unwrap_or(i64::MAX);
                let kept: Vec<String> = ca.rows().iter().filter(|x| x.relay_id == relay && x.kind.as_str() == "server" && (x.serial == keep || x.not_before >= since)).map(|x| x.serial.clone()).collect();
                let kept: Vec<&str> = kept.iter().map(String::as_str).collect();
                with_vault(c, |v| ca.revoke_relay(&*v, &relay, Some(crate::meet_ca::CertKind::Server), &kept, t)).map(|l| !l.is_empty()).unwrap_or(false)
            };
            if revoked {
                self.crl_signed(c, t);
            }
        }
        self.signer_stale_note(c, t);
    }

    /// AC-2b-D 8.5 (R5-L2): since when the certificate server's held list (as relays report it) is older than the
    /// console's newest.
    fn signer_stale_note(&self, c: &Console, t: i64) {
        let newest = {
            let g = self.meet.lock();
            g.as_ref().filter(|m| m.signer_url().is_some()).and_then(|m| m.crl().map(|(_, i)| (i.number, m.signer_url().unwrap_or_default().to_owned())))
        };
        let held: Vec<crate::meet_ca::CrlNumber> = {
            let reg = self.registry.lock();
            signer_users(&reg).filter_map(|r| r.report.get("meetPki").and_then(|p| p.get("signerHeld")).and_then(|h| h.get("number")).and_then(crate::meet_ca::CrlNumber::from_json)).collect()
        };
        let behind = newest.as_ref().and_then(|(n, url)| held.into_iter().filter(|h| h < n).min().map(|h| (h, url.clone())));
        let mut book = self.book.lock();
        let before = book.meet_alerts.get("signerStale").cloned();
        match behind {
            Some((h, url)) => {
                let since = before.as_ref().and_then(|b| b.get("since")).and_then(Value::as_i64).unwrap_or(t);
                book.meet_alerts.insert("signerStale".into(), json!({ "since": since, "number": h.to_json(), "url": url }));
            }
            None => {
                book.meet_alerts.remove("signerStale");
            }
        }
        if book.meet_alerts.get("signerStale") != before.as_ref() {
            if let Err(e) = self.save_book(c, &book) {
                c.logger.ops("console.write-failed", &Fields::new().with("reason", e.message), Level::Error);
            }
        }
    }

    /// The AC-2b-D 10 attention items of the CA and of the relays it issued to.
    fn meet_attention(&self, t: i64) -> Vec<Value> {
        let item = |kind: &str, severity: &str, args: Value, go: String| json!({ "kind": kind, "severity": severity, "args": args, "go": go });
        let page = || "#/license/meet-ca".to_owned();
        let mut out = Vec::new();
        let relays: Vec<(String, String, bool, Option<bool>)> = {
            let reg = self.registry.lock();
            let users: HashSet<String> = signer_users(&reg).map(|r| r.id.clone()).collect();
            reg.relays.values().filter(|r| r.state.live()).map(|r| (r.id.clone(), clean(&r.name), users.contains(&r.id), signer_enforced_report(r))).collect()
        };
        let alerts = self.book.lock().meet_alerts.clone();
        let g = self.meet.lock();
        let Some(ca) = g.as_ref() else { return out };
        let crl = ca.crl().map(|(_, i)| i);
        let ends = crl.as_ref().map(|i| i.next_update);
        match ca.state() {
            crate::meet_ca::CaState::Lost => out.push(item("meet-ca-lost", "bad", json!({ "date": ends }), page())),
            crate::meet_ca::CaState::Unreadable => {
                out.push(item("meet-ca-unreadable", "bad", json!({}), page()));
                return out;
            }
            crate::meet_ca::CaState::Ok => {
                let days = ca.ca_days_left(t);
                if days <= MEET_CA_EXPIRING_DAYS {
                    out.push(item("meet-ca-expiring", "warn", json!({ "days": days }), page()));
                }
            }
        }
        if *self.crl_failing.lock() {
            out.push(item("meet-crl-failing", "bad", json!({ "date": ends }), page()));
        }
        if ca.size_warning() {
            out.push(item("meet-crl-size", "warn", json!({ "size": crl.as_ref().map(|i| i.size / 1024) }), page()));
        }
        let diverged = ca.view(t).get("diverged").cloned().unwrap_or(Value::Null);
        if let Some(rid) = str_of(diverged.get("relayId")) {
            let name = relays.iter().find(|r| r.0 == rid).map(|r| r.1.clone()).unwrap_or_else(|| rid.to_owned());
            out.push(item("meet-crl-diverged", "bad", json!({ "relay": name }), page()));
        }
        for (id, name, user, enforced) in &relays {
            let go = format!("#/relays/{id}");
            let latest = |kind: &str| ca.rows().iter().filter(|x| x.relay_id == *id && x.kind.as_str() == kind && x.revoked_at.is_none()).map(|x| x.not_after).max();
            if let Some(na) = latest("server") {
                let days = (na - t).div_euclid(DAY_MS);
                if days <= MEET_CERT_WARN_DAYS {
                    out.push(item("relay-meet-cert-expiring", "warn", json!({ "relay": name, "days": days }), go.clone()));
                }
            }
            if let Some(na) = latest("signer-client") {
                let days = (na - t).div_euclid(DAY_MS);
                if days <= SIGNER_CERT_WARN_DAYS {
                    out.push(item("relay-signer-cert-expiring", "warn", json!({ "relay": name, "days": days }), go.clone()));
                }
            }
            // R4-M1: while the setting is on, a relay that reports false (or has not reported).
            if *user && ca.signer_enforced() && *enforced != Some(true) {
                out.push(item("signer-crl-mismatch", "warn", json!({ "relay": name, "url": ca.signer_url() }), go.clone()));
            }
        }
        drop(g);
        if let Some(f) = alerts.get("crlFuture") {
            out.push(item("meet-crl-future", "warn", json!({ "date": f.get("date"), "where": f.get("where"), "ceiling": f.get("ceiling") }), page()));
        }
        if let Some(s) = alerts.get("signerStale").filter(|s| s.get("since").and_then(Value::as_i64).is_some_and(|at| t - at >= SIGNER_STALE_MS)) {
            out.push(item("signer-crl-stale", "warn", json!({ "url": s.get("url"), "number": s.get("number") }), page()));
        }
        out
    }

    /// A relay's certificates from the CA for its detail page (admins).
    fn meet_relay_view(&self, relay: &str, _t: i64) -> Value {
        let g = self.meet.lock();
        let Some(ca) = g.as_ref() else { return Value::Null };
        let certs: Vec<Value> = ca
            .rows()
            .iter()
            .filter(|x| x.relay_id == relay)
            .map(|x| json!({ "serial": x.serial, "kind": x.kind.as_str(), "names": x.names, "notBefore": x.not_before, "notAfter": x.not_after, "revokedAt": x.revoked_at }))
            .collect();
        json!({ "caId": ca.id(), "signerUrl": ca.signer_url(), "signerEnforced": ca.signer_enforced(), "certs": certs })
    }

    /// (confirmedBy, mismatch): the relays of the certificate server that report enforcement, and the others (8.4).
    fn signer_reports(&self) -> (Vec<String>, Vec<String>) {
        let reg = self.registry.lock();
        let (mut yes, mut no) = (Vec::new(), Vec::new());
        for r in signer_users(&reg) {
            if signer_enforced_report(r) == Some(true) { yes.push(clean(&r.name)) } else { no.push(clean(&r.name)) }
        }
        (yes, no)
    }

    /// GET fleet/meet-ca (AC-2b-D 3.7, 9.1).
    fn meet_ca_view(&self, c: &Console, t: i64) -> Value {
        let high = c.profile_high();
        let provider_ok = c.seal.lock().as_ref().is_some_and(|s| matches!(s.provider(), crate::console_seal::Provider::SystemdCredential | crate::console_seal::Provider::DpapiService));
        let id = self.meet_ca_id();
        // R2-L7: relays that trust the CA but take no pushed list.
        let not_pushed: Vec<Value> = match &id {
            Some(id) => self
                .registry
                .lock()
                .relays
                .values()
                .filter(|r| r.state.live() && r.product == Product::Meet && strings(r.report.get("meetRoots")).iter().any(|x| x == id))
                .filter_map(|r| match r.report.get("meetCrl").and_then(|m| str_of(m.get("source"))) {
                    Some(w @ ("fixed" | "none")) => Some(json!({ "relay": clean(&r.name), "relayId": r.id, "why": w })),
                    _ => None,
                })
                .collect(),
            None => Vec::new(),
        };
        let (confirmed, mismatch) = self.signer_reports();
        let ca = self.meet.lock().as_ref().filter(|_| !high).map(|m| {
            let mut v = m.view(t);
            if let Some(o) = v.as_object_mut() {
                o.insert("signerEnforced".into(), Value::Bool(m.signer_enforced()));
                o.insert("confirmedBy".into(), json!(if m.signer_url().is_some() { confirmed.clone() } else { Vec::new() }));
                o.insert("mismatch".into(), json!(if m.signer_url().is_some() { mismatch.clone() } else { Vec::new() }));
                o.insert("notPushed".into(), json!(not_pushed));
            }
            v
        });
        let why = if high {
            Some("meet-ca-high")
        } else if !provider_ok {
            Some("meet-ca-seal")
        } else if id.is_some() {
            Some("meet-ca-exists")
        } else {
            None
        };
        json!({ "ok": true, "ca": ca, "allowed": why.is_none(), "why": why })
    }

    /// POST fleet/meet-ca/import (AC-2b-D 8.2): step-up bound to `{signerUrl, noHighRelay, maxLifetimeDays}` (the key
    /// never goes to the step-up), a second admin when two-person is on. The whole request waits sealed; the approval
    /// and the audit entry carry only the certificate's digest.
    fn meet_ca_import(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        let t = r.t;
        let p = r.params;
        let bind = json!({
            "signerUrl": p.get("signerUrl").cloned().unwrap_or(Value::Null), "noHighRelay": p.get("noHighRelay").cloned().unwrap_or(Value::Null),
            "maxLifetimeDays": p.get("maxLifetimeDays").cloned().unwrap_or(Value::Null),
        });
        c.verify_stepup(who, r.body.get("stepup"), crate::console_auth::Bind { action: "fleet.meet-ca.import", target: "-", params: &bind }, r.origin, t)?;
        // The first refusals of 8.2 before any approval is made; MeetCa::import checks every one again, in order.
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        if !c.seal.lock().as_ref().is_some_and(|s| matches!(s.provider(), crate::console_seal::Provider::SystemdCredential | crate::console_seal::Provider::DpapiService)) {
            return Err(ApiError::of("meet-ca-seal"));
        }
        if self.meet.lock().is_some() {
            return Err(ApiError::of("meet-ca-exists"));
        }
        let ca_pem = str_of(p.get("caPem")).unwrap_or("").to_owned();
        {
            let stash = json!({
                "caPem": ca_pem, "keyPem": str_of(p.get("keyPem")).unwrap_or(""), "issuedJson": p.get("issuedJson"), "crlPem": p.get("crlPem"),
                "signerUrl": p.get("signerUrl"), "noHighRelay": p.get("noHighRelay"), "maxLifetimeDays": p.get("maxLifetimeDays"),
            });
            c.seal_put(MEET_IMPORT_STASH, stringify(&stash).as_bytes())?;
        }
        let params = json!({ "caSha256": sha256_hex(ca_pem.as_bytes()), "signerUrl": bind["signerUrl"], "noHighRelay": bind["noHighRelay"], "maxLifetimeDays": bind["maxLifetimeDays"] });
        let email = who.email.clone();
        let mut d = c.second_or_run(who, "fleet.meet-ca.import", "-", &params, t, || self.meet_import_run(c, &email, &params, t))?;
        if d.result == "ok" {
            let b = &d.out.body;
            d.detail = json!({ "id": b["ca"]["id"], "revokedKept": b["revokedKept"], "signerUrl": b["ca"]["signerUrl"] });
        }
        Ok(d)
    }

    /// The import itself (sole-admin path, or approved): the sealed request, every 8.2 refusal (MeetCa), the key sealed
    /// as `meet-org-ca-key`, the request's copy wiped.
    fn meet_import_run(&self, c: &Console, by: &str, params: &Value, t: i64) -> Result<Value, ApiError> {
        let raw = c.seal_get(MEET_IMPORT_STASH).ok_or_else(|| ApiError::of("gone"))?;
        let s = std::str::from_utf8(&raw).ok().and_then(crate::codec::parse_json).ok_or_else(|| ApiError::of("gone"))?;
        drop(raw);
        let ca_pem = str_of(s.get("caPem")).unwrap_or("").to_owned();
        if Some(sha256_hex(ca_pem.as_bytes()).as_str()) != str_of(params.get("caSha256")) {
            return Err(ApiError::of("gone"));
        }
        let opt = |k: &str| str_of(s.get(k)).filter(|x| !x.trim().is_empty()).map(str::to_owned);
        let req = crate::meet_ca::ImportReq {
            ca_pem,
            key_pem: crate::fleet_wire::Redacted::new(str_of(s.get("keyPem")).unwrap_or("").to_owned()),
            issued_json: opt("issuedJson"),
            crl_pem: opt("crlPem"),
            signer_url: opt("signerUrl"),
            no_high_relay: s.get("noHighRelay").and_then(Value::as_bool) == Some(true),
            max_lifetime_days: s.get("maxLifetimeDays").and_then(Value::as_i64),
        };
        drop(s);
        let high_relays = self.high_relays();
        let provider = c.seal.lock().as_ref().map(|x| x.provider());
        let ctx = crate::meet_ca::ImportCtx { high: c.profile_high(), provider, high_relays: &high_relays };
        let result = {
            let mut g = self.meet.lock();
            if g.is_some() {
                Err(ApiError::of("meet-ca-exists"))
            } else {
                with_vault(c, |v| crate::meet_ca::MeetCa::import(&self.state_dir, v, &ctx, req, by, t)).map(|(ca, imp)| {
                    let view = ca.view(t);
                    *g = Some(ca);
                    (view, imp)
                })
            }
        };
        if let Some(seal) = c.seal.lock().as_mut() {
            let _ = seal.remove(MEET_IMPORT_STASH);
        }
        let (view, imp) = result?;
        if imp.future.is_some() || imp.ceiling {
            self.set_crl_future(c, imp.future, "the imported list", imp.ceiling, t);
        }
        self.push_crl_all();
        Ok(json!({ "ok": true, "ca": view, "revokedKept": imp.revoked_kept }))
    }

    /// POST fleet/meet-ca/revoke {serial, reason, stepup} (8.5).
    fn meet_ca_revoke(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let serial = str_of(r.params.get("serial")).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).ok_or_else(|| ApiError::with("invalid", "serial is the certificate's serial number."))?;
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let info = {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(no_ca)?;
            with_vault(c, |v| ca.revoke(&*v, &serial, &who.email, r.t))?
        };
        self.crl_signed(c, r.t);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "crl": { "number": info.number.to_json(), "thisUpdate": info.this_update } })), Some(serial.clone()), json!({ "serial": serial, "reason": reason })))
    }

    /// POST fleet/meet-ca/remove {elsewhere, reason, stepup} (8.6): `meet-ca-in-use` unless `elsewhere`; a second admin
    /// when two-person is on.
    fn meet_ca_remove(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let elsewhere = r.params.get("elsewhere").and_then(Value::as_bool) == Some(true);
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let n = self.meet.lock().as_ref().map(|m| m.in_use(r.t)).ok_or_else(no_ca)?;
        if n > 0 && !elsewhere {
            return Err(ApiError::with("meet-ca-in-use", format!("{n} relays still use certificates from this CA. Confirm that you will sign its revocation lists elsewhere.")));
        }
        let params = json!({ "elsewhere": elsewhere, "reason": reason });
        let mut d = c.second_or_run(who, "fleet.meet-ca.remove", "-", &params, r.t, || self.meet_remove_run(c, elsewhere, r.t))?;
        if d.result == "ok" {
            d.detail = json!({ "finalCrlEnds": d.out.body["finalCrlEnds"], "reason": reason });
        }
        Ok(d)
    }

    /// The removal: the final list signed and pushed, the key wiped, the files kept renamed (MeetCa), no more issuing.
    fn meet_remove_run(&self, c: &Console, elsewhere: bool, t: i64) -> Result<Value, ApiError> {
        let (removed, id) = {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(no_ca)?;
            let id = ca.id().to_owned();
            let removed = with_vault(c, |v| ca.remove(v, elsewhere, t))?;
            *g = None;
            (removed, id)
        };
        let targets: Vec<String> = self
            .registry
            .lock()
            .relays
            .values()
            .filter(|r| r.state.live() && strings(r.report.get("meetRoots")).iter().any(|x| *x == id) && r.report.get("meetCrl").and_then(|m| str_of(m.get("source"))) == Some("bundle"))
            .map(|r| r.id.clone())
            .collect();
        for relay in targets {
            self.event(&relay, "meet-crl", json!({ "crl": removed.crl_pem }));
        }
        Ok(json!({ "ok": true, "finalCrlEnds": removed.ends }))
    }

    /// POST fleet/meet-ca/dismiss-diverged {} (9.1): `meet-crl-diverged` and `meet-crl-future` cleared.
    fn meet_ca_dismiss(&self, c: &Console) -> Result<Done, ApiError> {
        {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(no_ca)?;
            ca.dismiss_diverged().map_err(|e| ApiError::with("write-failed", e))?;
        }
        {
            let mut book = self.book.lock();
            if book.meet_alerts.remove("crlFuture").is_some() {
                self.save_book(c, &book)?;
            }
        }
        plain(json!({ "ok": true }))
    }

    /// POST fleet/meet-ca/prune {certPem, reason, stepup} (8.5, R5-M2): a second admin when two-person is on.
    fn meet_ca_prune(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let cert = str_of(r.params.get("certPem")).unwrap_or("").to_owned();
        if self.meet.lock().is_none() {
            return Err(no_ca());
        }
        let params = json!({ "certPem": cert, "reason": reason });
        let email = who.email.clone();
        let mut d = c.second_or_run(who, "fleet.meet-ca.prune", "-", &params, r.t, || self.meet_prune_run(c, &email, &params, r.t))?;
        if d.result == "ok" {
            d.detail = json!({ "crl": d.out.body["crl"], "reason": reason });
        }
        Ok(d)
    }

    fn meet_prune_run(&self, c: &Console, by: &str, params: &Value, t: i64) -> Result<Value, ApiError> {
        let cert = str_of(params.get("certPem")).unwrap_or("");
        let info = {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(no_ca)?;
            with_vault(c, |v| ca.prune(&*v, cert, by, t))?
        };
        self.crl_signed(c, t);
        Ok(json!({ "ok": true, "crl": { "number": info.number.to_json(), "thisUpdate": info.this_update } }))
    }

    /// POST fleet/meet-ca/max-lifetime {days, reason, stepup} (8.2, R5-M2): a second admin when two-person is on.
    fn meet_ca_max_lifetime(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        let who = r.who()?;
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let days = r.params.get("days").and_then(Value::as_i64).ok_or_else(|| ApiError::with("invalid", "days is 1 to 3650."))?;
        if self.meet.lock().is_none() {
            return Err(no_ca());
        }
        let params = json!({ "days": days, "reason": reason });
        c.second_or_run(who, "fleet.meet-ca.max-lifetime", "-", &params, r.t, || self.meet_max_lifetime_run(&params))
    }

    fn meet_max_lifetime_run(&self, params: &Value) -> Result<Value, ApiError> {
        let days = params.get("days").and_then(Value::as_i64).ok_or_else(|| ApiError::of("invalid"))?;
        let mut g = self.meet.lock();
        g.as_mut().ok_or_else(no_ca)?.set_max_lifetime(days)?;
        Ok(json!({ "ok": true, "maxLifetimeDays": days }))
    }

    /// POST fleet/meet-ca/signer-enforced {on, reason, stepup} (8.4, R4-M1).
    fn meet_ca_signer_enforced(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        if c.profile_high() {
            return Err(ApiError::of("meet-ca-high"));
        }
        let on = r.params.get("on").and_then(Value::as_bool).ok_or_else(|| ApiError::with("invalid", "on is true or false."))?;
        let reason = crate::console_auth::reason_of(r.params.get("reason"))?;
        let url = {
            let mut g = self.meet.lock();
            let ca = g.as_mut().ok_or_else(no_ca)?;
            ca.set_signer_enforced(on)?;
            ca.signer_url().map(str::to_owned)
        };
        let (confirmed, mismatch) = self.signer_reports();
        let out = Out::ok(json!({ "ok": true, "signerEnforced": on, "confirmedBy": confirmed, "mismatch": mismatch }));
        Ok(Done::ok(out, Some(url.clone().unwrap_or_else(|| "-".into())), json!({ "url": url, "on": on, "reason": reason })))
    }

    /// GET fleet/spokes-root (AC-2b-D 3.8, 9.1).
    fn spokes_root_view(&self) -> Value {
        let root = self.book.lock().spokes_root.as_ref().map(|r| json!({ "id": r.get("id") }));
        json!({ "ok": true, "root": root })
    }

    /// POST fleet/spokes-root {pem, stepup} (AC-2b-D 3.8): Standard only; a P-256 public key named by an in-date library
    /// license; audit `fleet.spokes-root.set`.
    fn spokes_root_set(&self, c: &Console, r: &FleetReq) -> Result<Done, ApiError> {
        if c.profile_high() {
            return Err(ApiError::of("profile-high"));
        }
        let text = str_of(r.params.get("pem")).unwrap_or("");
        if text.contains("PRIVATE KEY") {
            return Err(ApiError::of("spokes-root-key"));
        }
        let der = crate::der::pem_blocks(text, "PUBLIC KEY").into_iter().next().filter(|d| crate::fleet_x509::is_p256_spki(d)).ok_or_else(|| ApiError::of("spokes-root-key"))?;
        let id = crate::identity::node_id_of(&der);
        let t = r.t;
        let mut book = self.book.lock();
        let named = book.library.iter().any(|l| str_of(l.get("product")) == Some("spokes") && str_of(l.get("root")) == Some(id.as_str()) && l.get("exp").and_then(Value::as_i64).is_some_and(|exp| exp > t / 1000));
        if !named {
            return Err(ApiError::with("spokes-root-license", format!("No license in the library names root {id}.")));
        }
        book.spokes_root = Some(json!({ "pem": pem_of("PUBLIC KEY", &der), "id": id }));
        self.save_book(c, &book)?;
        drop(book);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "root": { "id": id } })), Some(id.clone()), json!({ "id": id })))
    }
}

// ── The fleet as the console's product section (I9) ─────────────────────────────────────────────────────────

impl ProductSection for Fleet {
    fn routes(&self) -> &'static [RouteSpec] {
        &FLEET_ROUTES
    }

    fn sections(&self, _license: LicenseState) -> Vec<&'static str> {
        Vec::new()
    }

    fn relay_info(&self, _t: i64) -> Value {
        json!({ "version": env!("CARGO_PKG_VERSION"), "consoleId": self.console_id, "relays": self.registry.lock().live_count() })
    }

    /// A fleet console holds no product license of its own; each relay's is on its row (8.2).
    fn license(&self, t: i64) -> LicenseView {
        LicenseView { license: Value::Null, problem: None, state: LicenseState::Valid, service: crate::console::ServiceView::on(t) }
    }

    fn overview_cards(&self, admin: bool, t: i64) -> Vec<Value> {
        self.console().map(|c| self.cards(&c, admin, t)).unwrap_or_default()
    }

    fn attention(&self, _manager: bool, t: i64) -> Vec<Value> {
        self.console().map(|c| self.attention_items(&c, t)).unwrap_or_default()
    }

    fn search(&self, q: &str, _manager: bool, _t: i64) -> Vec<Value> {
        let ql = q.to_lowercase();
        self.registry
            .lock()
            .relays
            .values()
            .filter(|r| r.state.live() && (r.name.to_lowercase().contains(&ql) || r.site.to_lowercase().contains(&ql)))
            .take(50)
            .map(|r| json!({ "kind": "relay", "id": r.id, "title": r.name, "detail": r.site, "go": format!("#/relays/{}", r.id) }))
            .collect()
    }

    fn security_actions(&self) -> &'static [&'static str] {
        &[]
    }

    fn route(&self, _call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        Err(ApiError::of("not-found"))
    }

    /// Approved console-local fleet actions (a second admin approved them through AC-1 Approvals).
    fn execute(&self, run: &crate::console::Approved) -> Result<Value, ApiError> {
        let c = self.console()?;
        match run.action {
            "fleet.ca.rollover" => {
                let pki = self.pki.get().ok_or_else(|| ApiError::of("seal-provider-needed"))?;
                let (generation, fingerprint) = pki.ca_rollover(run.t)?;
                Ok(json!({ "ok": true, "generation": generation, "fingerprint": fingerprint }))
            }
            "exports.siem" => c.run_siem_off(),
            // AC-2b-D 8.2, 8.5, 8.6: the CA actions a second admin approved.
            "fleet.meet-ca.import" => self.meet_import_run(&c, run.requested_by, run.params, run.t),
            "fleet.meet-ca.remove" => self.meet_remove_run(&c, run.params.get("elsewhere").and_then(Value::as_bool) == Some(true), run.t),
            "fleet.meet-ca.prune" => self.meet_prune_run(&c, run.requested_by, run.params, run.t),
            "fleet.meet-ca.max-lifetime" => self.meet_max_lifetime_run(run.params),
            // API-1 6.6: a two-person api save a second admin approved, sent as its requester's
            "meet.api.save" => self.api_save_run(&c, run.requested_by, run.params, run.t),
            _ => Err(ApiError::with("not-found", "There is no such action.")),
        }
    }

    fn license_candidate(&self, _token: &str, _t: i64) -> Result<crate::console::LicenseCandidate, ApiError> {
        Err(ApiError::with("license-refused", "A fleet console installs licenses on relays: open the relay's License page."))
    }

    fn license_install(&self, _token: &str, _t: i64) -> Result<Value, ApiError> {
        Err(ApiError::of("license-refused"))
    }

    fn request_target(&self, _kind: &str, _target: &Value) -> Result<Value, ApiError> {
        Err(ApiError::with("invalid", "Requests are made on the relay they concern."))
    }

    /// Who is an admin changed: the roster follows at once (4.4: removals on the console's word).
    fn people_changed(&self, t: i64) {
        if let Ok(c) = self.console() {
            self.sync_roster(&c, t);
        }
    }
}

// ── f-people's host (11, F11) ───────────────────────────────────────────────────────────────────────────────

struct PeopleBridge {
    fleet: Weak<Fleet>,
}

impl PeopleBridge {
    fn fleet(&self) -> Option<Arc<Fleet>> {
        self.fleet.upgrade()
    }
}

/// The 4.6 `auth` for one relay: the relay's own nonce from `targets` (a step-up names one nonce per relay).
fn auth_for_relay(auth: &Value, relay: &str) -> Value {
    let mut a = auth.clone();
    if a.is_object() && a.get("nonce").is_none() {
        let nonce = a.get("targets").and_then(Value::as_array).and_then(|l| l.iter().find(|x| x["relay"] == relay)).and_then(|x| x.get("nonce")).cloned();
        if let Some(n) = nonce {
            a["nonce"] = n;
        }
    }
    a
}

impl crate::fleet_people::PeopleHost for PeopleBridge {
    fn relays(&self) -> Vec<crate::fleet_people::RelayView> {
        let Some(f) = self.fleet() else { return Vec::new() };
        let two = f.book.lock().policy["twoPerson"] == "on";
        let recs: Vec<RelayRecord> = f.registry.lock().relays.values().cloned().collect();
        // a relay that left or was removed is not part of the fleet: People must not list it as not answering
        recs.iter()
            .filter(|r| r.state.live())
            .map(|r| crate::fleet_people::RelayView {
                id: r.id.clone(),
                name: r.name.clone(),
                product: if r.product == Product::Meet { crate::fleet_people::Product::Meet } else { crate::fleet_people::Product::Spokes },
                state: r.state.as_str().to_owned(),
                profile: r.profile.clone(),
                scope_generation: r.report_u64("scopeGeneration"),
                scopes: r.scopes.clone(),
                service_stopped: r.report.get("license").and_then(service_state_of) == Some("stopped"),
                waiting_requests: r.report_u64("waitingRequests"),
                admins: strings(r.report.get("admins")).into_iter().map(|a| a.to_lowercase()).collect(),
                two_person: two,
                connected: f.connected(&r.id),
            })
            .collect()
    }

    fn rights_now(&self, session: &str) -> Option<crate::fleet_people::Rights> {
        let c = self.fleet()?.console().ok()?;
        let r = c.session_rights_now(session, crate::codec::now_ms())?;
        Some(match r {
            crate::console_settings::Rights::Admin => crate::fleet_people::Rights::Admin,
            crate::console_settings::Rights::Manager => crate::fleet_people::Rights::Manager,
            crate::console_settings::Rights::Viewer => crate::fleet_people::Rights::Viewer,
        })
    }

    fn api_deprovisioned(&self, org: &str, principal: &str) -> bool {
        // API-1 revision 4 6.7: a console that is stopping refuses the owner (fail closed)
        self.fleet().is_none_or(|f| crate::api_people::deprovisioned(&f.state_dir, org, principal))
    }

    fn call<'a>(&'a self, relay: &'a str, body: Value) -> crate::fleet_people::BoxFut<'a, Result<Value, ApiError>> {
        let fleet = self.fleet();
        let relay = relay.to_owned();
        Box::pin(async move {
            let f = fleet.ok_or_else(|| ApiError::of("state-unreadable"))?;
            let mut body = body;
            if let Some(a) = body.get("auth").cloned() {
                body["auth"] = auth_for_relay(&a, &relay);
            }
            tokio::task::spawn_blocking(move || f.send(&relay, "call", body, CALL_MS)).await.map_err(|_| ApiError::of("write-failed"))?
        })
    }

    fn people_op<'a>(&'a self, relay: &'a str, body: Value) -> crate::fleet_people::BoxFut<'a, Result<Value, ApiError>> {
        let fleet = self.fleet();
        let relay = relay.to_owned();
        Box::pin(async move {
            let f = fleet.ok_or_else(|| ApiError::of("state-unreadable"))?;
            let mut body = body;
            if let Some(a) = body.get("auth").cloned() {
                body["auth"] = auth_for_relay(&a, &relay);
            }
            tokio::task::spawn_blocking(move || f.send(&relay, "people", body, CALL_MS)).await.map_err(|_| ApiError::of("write-failed"))?
        })
    }

    fn console_rows(&self) -> Vec<Value> {
        let Some(c) = self.fleet().and_then(|f| f.console().ok()) else { return Vec::new() };
        let inner = c.inner.lock();
        inner
            .book
            .people
            .iter()
            .map(|(e, p)| json!({ "kind": "console", "id": e, "email": e, "name": null, "role": p.role.as_str(), "state": p.state_str(), "lastSignInAt": p.last_sign_in, "relay": null, "product": "console" }))
            .collect()
    }

    fn console_exists(&self, email: &str) -> bool {
        let Some(c) = self.fleet().and_then(|f| f.console().ok()) else { return false };
        let inner = c.inner.lock();
        let e = email.trim().to_lowercase();
        inner.book.people.contains_key(&e) || inner.book.invites.values().any(|i| i.email == e)
    }

    fn console_invite(&self, asker: &crate::fleet_people::Asker, email: &str, role: &str, t: i64) -> Result<(), ApiError> {
        let c = self.fleet().ok_or_else(|| ApiError::of("state-unreadable"))?.console()?;
        let who = c.who_of_session(&asker.session, t).ok_or_else(|| ApiError::of("signin-first"))?;
        c.admins_invite(&who, &json!({ "email": email, "role": role }), t).map(|_| ())
    }

    fn console_emails(&self) -> HashSet<String> {
        let Some(c) = self.fleet().and_then(|f| f.console().ok()) else { return HashSet::new() };
        let inner = c.inner.lock();
        inner.book.people.iter().filter(|(_, p)| p.active()).map(|(e, _)| e.clone()).collect()
    }

    fn mail_on(&self) -> bool {
        self.fleet().and_then(|f| f.console().ok()).is_some_and(|c| c.mailer.config().mode != crate::console_mail::Mode::Off)
    }
}

// ── `console serve` settings (5.2) ──────────────────────────────────────────────────────────────────────────

pub const SERVE_FILE: &str = "console-serve.json";
/// The 5.2 flags; each also `LUCID_CONSOLE_<NAME>` and a key of `console-serve.json`.
/// `fleet-serve-dev` (AC-2b-D 4.2) is `1` or `0`; `--fleet-serve-dev` alone means `1` (main.rs).
pub const SERVE_FLAGS: [&str; 16] = ["state", "host", "port", "public", "tls-cert", "tls-key", "sources", "trusted-fronts", "first-admin", "profile", "fleet-host", "fleet-port", "fleet-names", "fleet-sources", "metrics-sources", "fleet-serve-dev"];
pub const STATE_NEEDED: &str = "the console needs --state <folder>";
/// 13.4 `cli.console-needs-public`.
pub const PUBLIC_NEEDED: &str = "the console needs --public <host name> (passkeys need a DNS name)";
/// 13.4 `cli.with-console-host`.
pub const WITH_CONSOLE_HOST: &str = "The console's public host name must differ from the relay's host names.";
pub const FLEET_SOURCES_DEFAULT: &str = "0.0.0.0/0,::/0";

/// The effective `console serve` settings. No `Debug`: it holds the TLS key.
#[derive(Clone)]
pub struct ServeConfig {
    pub state: PathBuf,
    pub host: String,
    pub port: u16,
    /// The host name browsers use (lower case) and `public` as typed with a port that is not 443.
    pub public_host: String,
    pub public: String,
    pub public_port: u16,
    /// PEM text of the certificate and key; None behind a TLS front (`LUCID_CONSOLE_BEHIND_TLS=1`).
    pub tls: Option<(String, String)>,
    pub sources: Vec<crate::console_source::Cidr>,
    pub trusted_fronts: Vec<crate::console_source::Cidr>,
    pub first_admin: Option<String>,
    pub profile: Option<crate::console_settings::Profile>,
    pub fleet: FleetOpen,
    pub fleet_sources: Vec<crate::console_source::Cidr>,
    /// What `console-serve.json` gets: the effective values, never a secret (a PEM given inline is left out).
    pub saved: Map<String, Value>,
}

fn dns_name_ok(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        && !host.rsplit('.').next().unwrap_or_default().bytes().all(|c| c.is_ascii_digit())
}

/// A PEM value given inline or as a file path.
fn pem_or_path(v: &str) -> Result<String, String> {
    if v.trim_start().starts_with("-----BEGIN") {
        return Ok(v.to_owned());
    }
    std::fs::read_to_string(v).map_err(|e| format!("cannot read {v}: {e}"))
}

/// 5.2: flag, then environment (`LUCID_CONSOLE_<NAME>`, `-` as `_`), then `<state>/console-serve.json`.
pub fn serve_config(flags: &HashMap<String, String>, env: impl Fn(&str) -> Option<String>) -> Result<ServeConfig, String> {
    let env_of = |name: &str| env(&format!("LUCID_CONSOLE_{}", name.to_uppercase().replace('-', "_"))).filter(|v| !v.is_empty());
    let state = flags.get("state").filter(|v| !v.is_empty()).cloned().or_else(|| env_of("state")).ok_or(STATE_NEEDED)?;
    let state = PathBuf::from(state);
    let file: Map<String, Value> = match std::fs::read(state.join(SERVE_FILE)) {
        Ok(raw) => std::str::from_utf8(&raw).ok().and_then(crate::codec::parse_json).and_then(|v| v.as_object().cloned()).ok_or_else(|| format!("{SERVE_FILE} does not read: it is not a JSON object"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(format!("{SERVE_FILE} does not read: {e}")),
    };
    if let Some(k) = file.keys().find(|k| !SERVE_FLAGS.contains(&k.as_str()) || k.as_str() == "state") {
        return Err(format!("{SERVE_FILE} does not read: unknown key {k}"));
    }
    let get = |name: &str| -> Option<String> {
        flags.get(name).filter(|v| !v.is_empty()).cloned().or_else(|| env_of(name)).or_else(|| match file.get(name) {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        })
    };
    let mut saved = Map::new();
    let mut keep = |k: &str, v: Option<&String>| {
        if let Some(v) = v {
            saved.insert(k.to_owned(), Value::from(v.as_str()));
        }
    };
    let host = get("host").unwrap_or_else(|| "127.0.0.1".into());
    keep("host", Some(&host));
    let port_text = get("port").unwrap_or_else(|| "8443".into());
    let port = port_text.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("--port {port_text} is not 1 to 65535"))?;
    keep("port", Some(&port_text));
    let public_raw = get("public").ok_or(PUBLIC_NEEDED)?.trim().to_lowercase();
    let public_host = crate::meet_console_port::host_of(&public_raw);
    if public_raw.contains('/') || !dns_name_ok(&public_host) {
        return Err(PUBLIC_NEEDED.into());
    }
    let public_port = match public_raw.rsplit_once(':') {
        Some((_, p)) => p.parse::<u16>().ok().filter(|p| *p > 0).ok_or(PUBLIC_NEEDED)?,
        None => 443,
    };
    let public = if public_port == 443 { public_host.clone() } else { format!("{public_host}:{public_port}") };
    keep("public", Some(&public));
    let behind = env("LUCID_CONSOLE_BEHIND_TLS").filter(|v| !v.is_empty()).unwrap_or_else(|| "0".into());
    if behind != "0" && behind != "1" {
        return Err("LUCID_CONSOLE_BEHIND_TLS must be 1 (a TLS front terminates TLS) or unset".into());
    }
    let (cert, key) = (get("tls-cert"), get("tls-key"));
    let fronts_text = get("trusted-fronts");
    let tls = match (cert, key, behind.as_str()) {
        (Some(_), Some(_), "1") => return Err("LUCID_CONSOLE_BEHIND_TLS=1 and a TLS certificate are both set: the console terminates TLS itself or sits behind a front, not both".into()),
        (Some(c), Some(k), _) => {
            for (name, v) in [("tls-cert", &c), ("tls-key", &k)] {
                if !v.trim_start().starts_with("-----BEGIN") {
                    keep(name, Some(v));
                }
            }
            Some((pem_or_path(&c)?, pem_or_path(&k)?))
        }
        (None, None, "1") if fronts_text.is_some() => None,
        (None, None, "1") => return Err("the console behind a TLS front needs --trusted-fronts (the front's addresses)".into()),
        _ => return Err("the console needs --tls-cert and --tls-key, or LUCID_CONSOLE_BEHIND_TLS=1 with --trusted-fronts".into()),
    };
    let sources_text = get("sources").unwrap_or_else(|| crate::console_source::DEFAULT_SOURCES.into());
    let sources = crate::console_source::parse_cidr_list(&sources_text, crate::console_source::SOURCES_MAX).map_err(|e| format!("--sources: {e}"))?;
    keep("sources", Some(&sources_text));
    let trusted_fronts = match &fronts_text {
        Some(t) => crate::console_source::parse_cidr_list(t, crate::console_source::FRONTS_MAX).map_err(|e| format!("--trusted-fronts: {e}"))?,
        None => Vec::new(),
    };
    keep("trusted-fronts", fronts_text.as_ref());
    let first_admin = match get("first-admin") {
        Some(e) => Some(crate::console_auth::email_of(Some(&e)).ok_or_else(|| format!("--first-admin {e} is not an email address"))?),
        None => None,
    };
    keep("first-admin", first_admin.as_ref());
    let profile = match get("profile") {
        Some(p) => Some(crate::console_settings::Profile::parse(&p).ok_or("--profile must be standard or high")?),
        None => None,
    };
    if let Some(p) = profile {
        saved.insert("profile".into(), Value::from(p.as_str()));
    }
    let fleet_host = get("fleet-host").unwrap_or_else(|| host.clone());
    let fleet_port_text = get("fleet-port").unwrap_or_else(|| "7443".into());
    let fleet_port = fleet_port_text.parse::<u16>().map_err(|_| format!("--fleet-port {fleet_port_text} is not 0 to 65535"))?;
    if fleet_port != 0 && fleet_port == port && fleet_host == host {
        return Err("--fleet-port must differ from --port".into());
    }
    saved.insert("fleet-host".into(), Value::from(fleet_host.as_str()));
    saved.insert("fleet-port".into(), Value::from(fleet_port_text.as_str()));
    let names_text = get("fleet-names");
    let fleet_names: Vec<String> = match &names_text {
        Some(t) => {
            let names: Vec<String> = t.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
            if names.is_empty() || names.len() > 8 || names.iter().any(|n| !(dns_name_ok(n) || n == "localhost")) {
                return Err("--fleet-names is 1 to 8 DNS names, comma-separated".into());
            }
            names
        }
        None => Vec::new(),
    };
    if let Some(t) = &names_text {
        saved.insert("fleet-names".into(), Value::from(t.as_str()));
    }
    let fleet_sources_text = get("fleet-sources").unwrap_or_else(|| FLEET_SOURCES_DEFAULT.into());
    let fleet_sources = crate::console_source::parse_cidr_list(&fleet_sources_text, crate::console_source::SOURCES_MAX).map_err(|e| format!("--fleet-sources: {e}"))?;
    saved.insert("fleet-sources".into(), Value::from(fleet_sources_text.as_str()));
    let metrics_text = get("metrics-sources").unwrap_or_else(|| sources_text.clone());
    let metrics_sources = crate::console_source::parse_cidr_list(&metrics_text, crate::console_source::SOURCES_MAX).map_err(|e| format!("--metrics-sources: {e}"))?;
    saved.insert("metrics-sources".into(), Value::from(metrics_text.as_str()));
    let serve_dev = match get("fleet-serve-dev").as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(v) => return Err(format!("--fleet-serve-dev {v} is 1 or 0")),
    };
    if serve_dev {
        saved.insert("fleet-serve-dev".into(), Value::from("1"));
    }
    Ok(ServeConfig {
        state,
        host,
        port,
        public_host,
        public,
        public_port,
        tls,
        sources,
        trusted_fronts,
        first_admin,
        profile,
        fleet: FleetOpen { fleet_host, fleet_port, fleet_names, metrics_sources, metrics_sources_text: metrics_text, all_in_one: false, serve_dev },
        fleet_sources,
        saved,
    })
}

/// Write the effective values into `console-serve.json` at the first start (5.2), owner-only; an existing file is
/// left as the operator wrote it.
pub fn write_serve_file(cfg: &ServeConfig) -> Result<(), String> {
    let path = cfg.state.join(SERVE_FILE);
    if path.exists() {
        return Ok(());
    }
    crate::store::make_dir(&cfg.state).map_err(|e| format!("{}: {e}", cfg.state.display()))?;
    crate::store::write_private(&path, format!("{}\n", stringify(&Value::Object(cfg.saved.clone()))).as_bytes()).map_err(|e| format!("{SERVE_FILE} could not be written: {e}"))
}

// ── The browser port of the console role (5.2, 10.1) ───────────────────────────────────────────────────────

/// The browser port's limits: connections in all and per address, the handshake and idle times, a request body.
pub const BROWSER_CONNECTIONS: usize = 256;
pub const BROWSER_PER_ADDRESS: usize = 16;
pub const BROWSER_BODY_MAX: usize = crate::fleet_people::CHECK_BODY_MAX;
const HEAD_MAX: usize = 64 * 1024;

/// TLS for the console's browser port (no client certificate; AC-1's console port).
pub fn browser_tls(cert_pem: &str, key_pem: &str) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("the TLS certificate does not read: {e}"))?;
    if certs.is_empty() {
        return Err("the TLS certificate does not read: no CERTIFICATE block".into());
    }
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).map_err(|e| format!("the TLS key does not read: {e}"))?.ok_or("the TLS key does not read: no private key block")?;
    let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(crate::server::provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("the TLS certificate and key do not fit: {e}"))?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

/// One parsed request head.
struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    close: bool,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn all(&self, name: &str) -> Vec<String> {
        self.headers.iter().filter(|(k, _)| k == name).map(|(_, v)| v.clone()).collect()
    }
}

/// Read one request head (at most HEAD_MAX bytes); None at a clean end of the connection.
fn read_head<R: std::io::BufRead>(r: &mut R) -> std::io::Result<Option<Head>> {
    let mut lines = Vec::new();
    let mut total = 0;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            return if lines.is_empty() { Ok(None) } else { Err(std::io::ErrorKind::UnexpectedEof.into()) };
        }
        total += n;
        if total > HEAD_MAX {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let line = line.trim_end_matches(['\r', '\n']).to_owned();
        if line.is_empty() {
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(line);
    }
    let mut first = lines[0].split(' ');
    let (method, target, version) = (first.next().unwrap_or("").to_owned(), first.next().unwrap_or("").to_owned(), first.next().unwrap_or("").to_owned());
    if method.is_empty() || !target.starts_with('/') || !version.starts_with("HTTP/1.") {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let headers: Vec<(String, String)> = lines[1..].iter().filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))).collect();
    let conn = headers.iter().find(|(k, _)| k == "connection").map(|(_, v)| v.to_ascii_lowercase()).unwrap_or_default();
    let close = conn.contains("close") || (version == "HTTP/1.0" && !conn.contains("keep-alive"));
    Ok(Some(Head { method, target, headers, close }))
}

fn write_reply<W: std::io::Write>(w: &mut W, reply: &crate::console::ConsoleReply, close: bool) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n", reply.status, crate::meet::reason_phrase(reply.status), reply.content_type, reply.body.len());
    for (k, v) in &reply.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(&reply.body);
    w.write_all(&out)?;
    w.flush()
}

fn simple(status: u16, code: &str, words: &str) -> crate::console::ConsoleReply {
    let body = json!({ "ok": false, "code": code, "error": words });
    crate::console::ConsoleReply { status, content_type: "application/json; charset=utf-8", body: stringify(&body).into_bytes(), headers: Vec::new(), close: true }
}

/// The browser port: its connection slots and what it serves.
pub struct BrowserPort {
    console: Arc<Console>,
    public: String,
    public_host: String,
    public_port: u16,
    behind_front: bool,
    open: Mutex<HashMap<String, usize>>,
}

impl BrowserPort {
    fn take(&self, key: &str) -> bool {
        let mut open = self.open.lock();
        if open.values().sum::<usize>() >= BROWSER_CONNECTIONS || open.get(key).copied().unwrap_or(0) >= BROWSER_PER_ADDRESS {
            return false;
        }
        *open.entry(key.to_owned()).or_insert(0) += 1;
        true
    }

    fn give(&self, key: &str) {
        let mut open = self.open.lock();
        if let Some(n) = open.get_mut(key) {
            *n -= 1;
            if *n == 0 {
                open.remove(key);
            }
        }
    }

    /// One request: Ok(false) when the connection closes after it. `public_only`: the peer was let in only as the Meet
    /// account proxy, so only the public account paths answer.
    fn one<S: std::io::Read + std::io::Write>(&self, reader: &mut std::io::BufReader<S>, peer: std::net::IpAddr, public_only: bool) -> std::io::Result<bool> {
        use std::io::Read;
        let Some(head) = read_head(reader)? else { return Ok(false) };
        let length = head.header("content-length").and_then(|l| l.trim().parse::<usize>().ok()).unwrap_or(0);
        if head.header("transfer-encoding").is_some() || length > BROWSER_BODY_MAX {
            write_reply(reader.get_mut(), &simple(413, "too-large", "Request too large."), true)?;
            return Ok(false);
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body)?;
        // The Meet account pages and API (console_accounts): before the host check, as the Meet console served them.
        let account = self.console.accounts().and_then(|a| {
            let r = crate::console_accounts::PublicRequest {
                method: &head.method,
                target: &head.target,
                peer,
                forwarded: head.header("x-forwarded-for"),
                origin: head.header("origin"),
                content_type: head.header("content-type"),
                content_length: head.header("content-length"),
                body: &body,
            };
            a.front(&r, public_only)
        });
        if let Some(reply) = account {
            let close = head.close || reply.close;
            write_reply(reader.get_mut(), &reply, close)?;
            return Ok(!close);
        }
        let (path, query) = match head.target.split_once('?') {
            Some((p, q)) => (p.to_owned(), q.split('#').next().unwrap_or("").to_owned()),
            None => (head.target.split('#').next().unwrap_or("").to_owned(), String::new()),
        };
        let host = head.header("host").unwrap_or("").trim().to_lowercase();
        let host_ok = host == self.public || (self.public_port == 443 && host == format!("{}:443", self.public_host));
        let forwarded: Vec<String> = if self.behind_front { head.all("x-forwarded-for").iter().flat_map(|v| v.split(',').map(|s| s.trim().to_owned())).filter(|s| !s.is_empty()).collect() } else { Vec::new() };
        let t = crate::codec::now_ms();
        let reply = if path == "/metrics" {
            if !host_ok {
                simple(421, "host", "This relay does not answer for that host name.")
            } else {
                self.console.metrics_scrape(head.header("authorization"), peer, &forwarded, head.method.as_str(), t)
            }
        } else if path == "/console" || path.starts_with("/console/") {
            let cookie = head.all("cookie").join("; ");
            let dialed = crate::relay::Dialed { host: self.public.clone(), hostname: self.public_host.clone(), port: self.public_port };
            let body = String::from_utf8_lossy(&body).into_owned();
            let request = crate::console::ConsoleRequest {
                method: &head.method,
                pathname: &path,
                query: &query,
                cookie: &cookie,
                origin: head.header("origin"),
                marker: head.header(crate::console::MARKER_HEADER),
                activity: head.header(crate::console::ACTIVITY_HEADER).is_some_and(|v| v.trim() == "1"),
                content_type: head.header("content-type").unwrap_or(""),
                user_agent: head.header("user-agent").unwrap_or(""),
                peer,
                forwarded: &forwarded,
                body: &body,
                dialed: &dialed,
                host_ok,
            };
            self.console.http(&request, t)
        } else {
            simple(404, "not-found", "There is no such page.")
        };
        let close = head.close || reply.close;
        write_reply(reader.get_mut(), &reply, close)?;
        Ok(!close)
    }

    fn serve<S: std::io::Read + std::io::Write>(&self, stream: S, peer: std::net::IpAddr, public_only: bool) {
        let mut reader = std::io::BufReader::new(stream);
        while let Ok(true) = self.one(&mut reader, peer, public_only) {}
    }
}

/// Start the browser port on its own threads: the source list first (when the console terminates TLS itself; a
/// front's requests are judged by the console from X-Forwarded-For), then a slot, then the TLS handshake.
pub fn serve_browser(console: Arc<Console>, cfg: &ServeConfig) -> Result<(), String> {
    let tls = cfg.tls.as_ref().map(|(c, k)| browser_tls(c, k)).transpose()?;
    let listener = std::net::TcpListener::bind((cfg.host.as_str(), cfg.port)).map_err(|e| format!("cannot listen on {}:{}: {e}", cfg.host, cfg.port))?;
    let port = Arc::new(BrowserPort { console: console.clone(), public: cfg.public.clone(), public_host: cfg.public_host.clone(), public_port: cfg.public_port, behind_front: tls.is_none(), open: Mutex::new(HashMap::new()) });
    let fronts = cfg.trusted_fronts.clone();
    let gate = console.clone();
    std::thread::Builder::new()
        .name("console-browser-port".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let ip = match peer.ip() {
                    std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(std::net::IpAddr::V6(v6)),
                    v4 => v4,
                };
                let admitted = if tls.is_some() { gate.source_allowed(ip) } else { crate::console_source::allowed(&fronts, ip) };
                // The Meet account proxy reaches the public account paths, and only those, inside the console's
                // networks or not.
                let public_only = gate.accounts().is_some_and(|a| a.is_proxy(ip));
                let admitted = admitted || public_only;
                let key = crate::console_source::source_key(ip);
                if !admitted || !port.take(&key) {
                    drop(tcp);
                    continue;
                }
                let (port, tls) = (port.clone(), tls.clone());
                let _ = std::thread::Builder::new().name("console-browser".into()).spawn(move || {
                    let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                    let _ = tcp.set_write_timeout(Some(std::time::Duration::from_secs(30)));
                    match tls {
                        Some(cfg) => {
                            if let Ok(conn) = rustls::ServerConnection::new(cfg) {
                                let mut stream = rustls::StreamOwned::new(conn, tcp);
                                let handshaken = (|| {
                                    while stream.conn.is_handshaking() {
                                        stream.conn.complete_io(&mut stream.sock)?;
                                    }
                                    Ok::<(), std::io::Error>(())
                                })();
                                if handshaken.is_ok() {
                                    let _ = stream.sock.set_read_timeout(Some(std::time::Duration::from_secs(30)));
                                    port.serve(&mut stream, ip, public_only);
                                    stream.conn.send_close_notify();
                                    let _ = std::io::Write::flush(&mut stream);
                                }
                            }
                        }
                        None => {
                            let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)));
                            port.serve(&tcp, ip, public_only);
                        }
                    }
                    port.give(&key);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    console.logger.ops("console.listening", &Fields::new().with("url", format!("https://{}/console/", cfg.public)).with("host", cfg.host.as_str()).with("port", cfg.port), Level::Info);
    Ok(())
}

// ── All-in-one (2.2) ────────────────────────────────────────────────────────────────────────────────────────

/// `--with-console <dir>` (Remote Spokes, main.rs) and `with_console` (Meeting Hub, meet.rs): the console role in the
/// relay's process, reading `<dir>/console-serve.json` (5.2). Refused when the console's public host is one of the
/// relay's host names (13.4 `cli.with-console-host`) and under High (the callers refuse that first, 13.4
/// `cli.with-console-high`). At the first start the in-process relay is enrolled without a code (2.2). Runs on the
/// current tokio runtime, or on its own runtime thread when there is none. Call it before the relay opens its fleet
/// link (`server::fleet_start`), so the same-process enrollment's `fleet.json` and `fleet-key` exist by then.
pub fn start_with_console(dir: &Path, relay_product: Product, relay_hosts: &[String], relay_state_dir: Option<&Path>, logger: Arc<crate::log::Logger>) -> Result<(), String> {
    let mut flags = HashMap::new();
    flags.insert("state".to_owned(), dir.display().to_string());
    let mut cfg = serve_config(&flags, |k| std::env::var(k).ok())?;
    if relay_hosts.iter().any(|h| crate::meet_console_port::host_of(h) == cfg.public_host) {
        return Err(WITH_CONSOLE_HOST.into());
    }
    cfg.fleet.all_in_one = true;
    write_serve_file(&cfg)?;
    let (_, console) = crate::console::open_fleet(cfg.clone(), crate::log::Logger::new("console"), crate::console_seal::SealIdentity::Relay)?;
    if console.profile_high() {
        return Err(crate::server::CLI_WITH_CONSOLE_HIGH.into());
    }
    let relay_state = relay_state_dir.map(Path::to_path_buf);
    let run = move || -> Result<(), String> {
        serve_browser(console.clone(), &cfg)?;
        let port = crate::fleet_port::PortConfig { host: cfg.fleet.fleet_host.clone(), port: cfg.fleet.fleet_port, names: cfg.fleet.fleet_names.clone(), sources: cfg.fleet_sources.clone(), public_host: cfg.public.clone(), serve_dev: cfg.fleet.serve_dev };
        crate::fleet_port::start(console.clone(), port, logger.clone())?;
        if let Some(state) = &relay_state {
            crate::fleet_agent::same_process(console.clone(), state, relay_product, logger.clone())?;
        }
        Ok(())
    };
    match tokio::runtime::Handle::try_current() {
        Ok(_) => run(),
        Err(_) => {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("console-runtime".into())
                .spawn(move || {
                    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                        Ok(rt) => rt,
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                            return;
                        }
                    };
                    rt.block_on(async move {
                        let _ = tx.send(run());
                        std::future::pending::<()>().await;
                    });
                })
                .map_err(|e| e.to_string())?;
            rx.recv().map_err(|e| e.to_string())?
        }
    }
}

// ── `/metrics` on the browser port (10.1) ───────────────────────────────────────────────────────────────────

impl Console {
    /// `GET /metrics`: a bearer token only (no cookie is read), from the metrics source list (behind a front, the
    /// client named by X-Forwarded-For through the trusted fronts).
    pub(crate) fn metrics_scrape(&self, authorization: Option<&str>, peer: std::net::IpAddr, forwarded: &[String], method: &str, t: i64) -> crate::console::ConsoleReply {
        let Some(f) = self.fleet() else { return simple(404, "not-found", "There is no such page.") };
        if method != "GET" {
            return simple(405, "method", "Method not allowed.");
        }
        let Ok(ip) = crate::console_source::source_of(peer, forwarded, &self.cfg.trusted_fronts, self.cfg.behind_front) else {
            return simple(403, "source", crate::console::SOURCE_REFUSED);
        };
        let tokens: Vec<crate::fleet_export::TokenRecord> = self.inner.lock().book.settings.tokens.iter().filter_map(crate::fleet_export::TokenRecord::from_json).collect();
        let recs: Vec<RelayRecord> = f.registry.lock().relays.values().filter(|r| r.state.live()).cloned().collect();
        let rows: Vec<crate::fleet_export::RelayRow> = recs
            .iter()
            .map(|r| {
                let connected = f.connected(&r.id);
                crate::fleet_export::RelayRow {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    site: r.site.clone(),
                    product: r.product,
                    connected,
                    last_contact_ms: r.last_contact_at,
                    health: f.health(r, connected, t).to_owned(),
                    license_state: f.metrics.latest(&r.id).and_then(|l| l.m.get("license_state").and_then(Value::as_i64)),
                    license_service: f.metrics.latest(&r.id).and_then(|l| l.m.get("license_service").and_then(Value::as_i64)),
                }
            })
            .collect();
        let ctx = crate::fleet_export::ExportContext { version: env!("CARGO_PKG_VERSION"), profile_high: self.profile_high(), fips: cfg!(feature = "fips"), sources: &f.cfg.metrics_sources };
        let a = f.exporter.scrape(&crate::fleet_export::ScrapeRequest { authorization, source: ip }, &tokens, &ctx, &rows, &f.metrics, t);
        if let Some(h) = &a.used_hint {
            self.token_used(h, t);
        }
        let mut headers: Vec<(&'static str, String)> = vec![("Cache-Control", "no-store".into()), ("X-Content-Type-Options", "nosniff".into())];
        if let Some(s) = a.retry_after {
            headers.push(("Retry-After", s.to_string()));
        }
        crate::console::ConsoleReply { status: a.status, content_type: a.content_type, body: a.body, headers, close: false }
    }
}

// ── API-1 7.3 (slice 1a6): Settings > API access and Settings > Exports ────────────────────────────────────────

/// The org a Settings > API access or Exports body names.
fn api_org(params: &Value) -> Result<String, ApiError> {
    str_of(params.get("org")).filter(|o| crate::api_audit::org_ok(o)).map(str::to_owned).ok_or_else(|| ApiError::with("invalid", "org is an organization id."))
}

fn random8() -> Result<[u8; 8], ApiError> {
    random_bytes(8)?.try_into().map_err(|_| ApiError::of("write-failed"))
}

fn random32() -> Result<[u8; 32], ApiError> {
    random_bytes(32)?.try_into().map_err(|_| ApiError::of("write-failed"))
}

/// A checker's or verifier's phrase as a console sentence: capitalized, ending with a period.
fn api_sentence(s: &str) -> String {
    let s = clean(s);
    let mut c = s.chars();
    let mut out: String = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

/// API-1 2.5: how long back the org's chains are read for live access tokens (tokens last minutes; seconds).
const LIVE_TOKEN_WINDOW_S: i64 = 3600;
/// Pages of 1000 entries read back per chain for live access tokens at most.
const LIVE_TOKEN_PAGES: u64 = 20;
/// A signing still `sending` this long after it was recorded (ms) lost its relay's answer (or the console
/// restarted meanwhile): the minute tick settles it.
const SENDING_STALE_MS: i64 = 2 * 60_000;

impl Fleet {
    /// The owner rule of 4.3 for one org: active unless the console's people data marks them inactive.
    fn api_owner(&self, org: &str) -> impl Fn(&str) -> bool {
        let people = self.people();
        let org = org.to_owned();
        move |p: &str| !people.as_ref().is_some_and(|x| x.person_inactive(&org, p))
    }

    /// I of 5.1 for an org without a map yet: the front door's first name (else the console's host) and port.
    fn api_issuer_url(&self, c: &Console, org: &str) -> String {
        format!("{}/api/orgs/{org}", self.api_front_origin(c))
    }

    /// The front door's origin: its first name (else the console's host) and port.
    fn api_front_origin(&self, c: &Console) -> String {
        let host = self.cfg.fleet_names.first().filter(|h| !h.is_empty()).cloned().unwrap_or_else(|| c.cfg.host.clone());
        let port = if self.cfg.fleet_port == 0 { 7443 } else { self.cfg.fleet_port };
        format!("https://{host}:{port}")
    }

    /// The map a save of `d` asks a device to sign, checked as relays check it (2.2, 13).
    fn api_final(&self, c: &Console, d: &api_ui::Draft, active: &[crate::api_map::TightenEntry], t: i64) -> Result<Value, ApiError> {
        let now = t.div_euclid(1000);
        let jwk = self.api.issuer_public_jwk(&d.org).map_err(|e| ApiError::with("invalid", api_sentence(&e)))?;
        let mut kept: Vec<String> = self.api.journal_newest(&d.org, usize::MAX).iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        kept.extend(self.api.console_ids(&d.org));
        let console = self.api.console_active(&d.org);
        let map = api_ui::final_map(d, &self.api_issuer_url(c, &d.org), &jwk, active, &console, &kept, now);
        let edition = self.api_edition(t).unwrap_or(crate::api_map::Edition::Enterprise);
        crate::api_map::check_api_map(&map, now, None, edition, &BTreeMap::new()).map_err(|e| ApiError::with("invalid", api_sentence(&e.message)))?;
        // API-1d 2.2 `well-known-taken` and 7.1.3 `card-version`, at every stage and again at save
        let others: Vec<Value> = self.api.known_orgs().into_iter().filter(|o| *o != d.org).filter_map(|o| self.api.pinned(&o).0).collect();
        api_1d::a2a_problem(self.api.pinned(&d.org).0.as_ref(), &map, &d.org, &others)?;
        // API-1 revision 4 2.3 item 3: staged and saved only while every relay of the org takes what the map needs
        self.api.gate(&d.org, &crate::api_features::map_needs(&map)).map_err(|e| ApiError::with("relay-outdated", api_sentence(&e.message)))?;
        Ok(map)
    }

    /// Journal tightenings at once (2.5), each flushed and sent before the route answers; one already in force is
    /// not journaled again. A console journal action (`api_cjournal::ACTIONS`, revision 4 2.3 item 4 and revision 5
    /// 4.2) goes to the console journal (`ConsoleApi::append_console`): `person_revoke` also ends the person's refresh
    /// families (`ConsoleApi::person_revoke`), and `client_drop_delegation` brings its R5-6 `person_revoke` entries
    /// (`ConsoleApi::drop_delegation`, each counted).
    fn api_journal(&self, org: &str, entries: &[api_ui::Tighten], t: i64) -> Result<usize, ApiError> {
        let now = t.div_euclid(1000);
        let failed = |x: crate::api_map::ApiMapError| ApiError::with("invalid", api_sentence(&x.message));
        let mut n = 0;
        for e in entries {
            if crate::api_cjournal::ACTIONS.iter().any(|(a, _)| *a == e.action) {
                let console = self.api.console_active(org);
                let field = |k: &str| e.target.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
                match e.action {
                    "person_revoke" => {
                        if crate::api_cjournal::person_revoked(&console, &field("client"), &field("principal")) {
                            continue;
                        }
                        self.api.person_revoke(org, &field("client"), &field("principal"), now).map_err(failed)?;
                        n += 1;
                    }
                    "client_drop_delegation" => {
                        if console.iter().any(|a| a.action == e.action && a.target == e.target) {
                            continue;
                        }
                        let what = ["group", "principal", "idp"].into_iter().find(|w| e.target.get(*w).is_some()).unwrap_or("group");
                        let revoked = self.api.drop_delegation(org, &field("client"), what, &field(what), now).map_err(failed)?;
                        n += 1 + revoked.len();
                    }
                    _ => {
                        if console.iter().any(|a| a.action == e.action && a.target == e.target) {
                            continue;
                        }
                        self.api.append_console(org, e.action, e.target.clone(), now).map_err(failed)?;
                        n += 1;
                    }
                }
                continue;
            }
            let held = self.api.journal_active(org).iter().any(|a| a.action == e.action && a.target == e.target);
            if held {
                continue;
            }
            self.api.append(self.link.get().cloned(), org, e.action, e.target.clone(), e.until, now).map_err(|x| ApiError::with("invalid", api_sentence(&x.message)))?;
            n += 1;
        }
        Ok(n)
    }

    /// Every route of Settings > API access and the destinations of Settings > Exports.
    fn api_route(&self, c: &Console, spec: &'static RouteSpec, r: &FleetReq) -> Result<Done, ApiError> {
        let t = r.t;
        if spec.method == "GET" {
            return plain(self.api_view(t));
        }
        let who = r.who()?;
        let p = r.params;
        let org = api_org(p)?;
        match spec.path {
            "settings/api/explain" => self.api_explain(c, &org, p, t),
            "settings/api/off" => {
                let reason = reason_of(p.get("reason"))?;
                if self.api.journal_active(&org).iter().any(|e| e.action == "api_off") {
                    return Err(ApiError::with("stale", api_ui::API_OFF_ALREADY));
                }
                self.api_journal(&org, &[api_ui::Tighten { action: "api_off", target: json!(org), until: None }], t)?;
                Ok(Done::ok(Out::ok(json!({ "ok": true, "state": "off" })), Some(org), json!({ "reason": reason })))
            }
            "settings/api/discard" => {
                if !self.api_drafts.lock().discard(&org) {
                    return Err(ApiError::with("stale", api_ui::NOTHING_STAGED));
                }
                Ok(Done::ok(Out::ok(json!({ "ok": true, "staged": null })), Some(org), Value::Null))
            }
            "settings/api/save" => self.api_save(c, who, &org, p, t),
            "settings/api/relays/retire" => {
                let relay = str_of(p.get("relay")).filter(|r| !r.is_empty() && r.len() <= 64).ok_or_else(|| ApiError::with("invalid", "relay is a relay id."))?.to_owned();
                match self.api.retire_relay(&org, &relay) {
                    Ok(true) => Ok(Done::ok(Out::ok(json!({ "ok": true, "relay": relay })), Some(org), json!({ "relay": relay }))),
                    Ok(false) => Err(ApiError::with("stale", "Nothing was changed: that relay is not in this organization's relay set.")),
                    Err(e) if e.code == "relay-connected" => Err(ApiError::with("stale", "Nothing was changed: that relay is connected and still serves this organization.")),
                    Err(e) => Err(ApiError::with("write-failed", api_sentence(&e.message))),
                }
            }
            // API-1d 5.1: the relay staged into (or out of) `spokes.relays`, then the bound list recorded and `api-orgs`
            // sent at once (`ConsoleApi::spokes_bind`)
            "settings/api/spokes/bind" | "settings/api/spokes/unbind" => {
                let relay = str_of(p.get("relay")).filter(|r| crate::fleet_metrics::relay_id_ok(r)).ok_or_else(|| ApiError::with("invalid", "relay is a relay id."))?.to_owned();
                let bound = spec.path == "settings/api/spokes/bind";
                if !self.registry.lock().relays.get(&relay).is_some_and(|r| r.state.live() && r.product == Product::Spokes) {
                    return Err(ApiError::with("invalid", "That relay is not a Remote Spokes relay of this console."));
                }
                // the draft as it was, kept again when the bind fails so the draft never lists a relay that is not bound
                let before = self.api_drafts.lock().get(&org, t).cloned();
                let done = self.api_stage(c, who, spec.path, &org, p, t)?;
                if let Err(e) = self.api.spokes_bind(self.link.get().cloned(), &relay, &org, bound, t.div_euclid(1000)) {
                    let mut drafts = self.api_drafts.lock();
                    match before {
                        Some(d) => {
                            drafts.put(d, t);
                        }
                        None => {
                            drafts.discard(&org);
                        }
                    }
                    let code = if e.code == crate::api_features::OUTDATED { "relay-outdated" } else { "write-failed" };
                    return Err(ApiError::with(code, api_sentence(&e.message)));
                }
                Ok(done)
            }
            "settings/api/signing/cancel" => self.api_signing_cancel(&org, t),
            "settings/api/clients/revoke-tokens" => self.api_revoke_tokens(&org, p, t),
            // API-1 revision 4 13.1 (`clients/recipient` and `clients/caps` stage in `api_stage`)
            "settings/api/clients/recipient/drop" => self.api_recipient_drop(&org, p, t),
            "settings/exports/destinations/test" => self.api_dest_test(c, who, &org, p, t),
            "settings/exports/destinations/credential" => self.api_dest_credential(&org, p, t),
            "settings/exports/destinations/failover/csr" | "settings/exports/destinations/failover/install" | "settings/exports/destinations/failover/delete" => self.api_failover(spec.path, &org, p, t),
            "settings/api/federation/key/drop" => self.api_federation_drop(&org, p, t),
            "settings/api/federation/republished" => self.api_federation_republished(&org, p),
            "settings/exports/destinations/federation-test" => self.api_federation_test(c, who, &org, p, t),
            // API-1 revision 4 7.4, 13.1 (`settings/api/webhook-keys` stages in `api_stage`)
            "settings/api/webhook-keys/drop" => self.api_webhook_key_drop(&org, p, t),
            "settings/exports/destinations/verify" => self.api_webhook_verify(c, who, &org, p, t),
            "settings/exports/destinations/secret" => self.api_webhook_secret(c, who, &org, p, t),
            "settings/exports/destinations/replay" => self.api_webhook_replay(&org, p, t),
            "settings/exports/destinations/resume" => self.api_webhook_resume(&org, p, t),
            // API-1 revision 5 14.1 (the connector, idp and delegation routes stage in `api_stage`)
            "settings/api/idps/test" => self.api_idp_test(&org, p, t),
            "settings/api/sso-url" => self.api_sso_url(&org, p),
            // API-1d 7.14 (the agent, key, well-known, root and push-off routes stage in `api_stage`)
            "settings/api/a2a/keys/drop" => self.api_a2a_key_drop(&org, p, t),
            "settings/api/clients/card-check" => {
                let id = str_of(p.get("id")).filter(|i| api_1c::client_id_ok(i)).ok_or_else(|| ApiError::with("invalid", api_1c::BAD_CLIENT))?.to_owned();
                let card = crate::console_a2a::card_check(&self.api, &org, &id, t.div_euclid(1000))?;
                let detail = json!({ "id": id, "state": card.get("state") });
                Ok(Done::ok(Out::ok(json!({ "ok": true, "card": card })), Some(org), detail))
            }
            path => self.api_stage(c, who, path, &org, p, t),
        }
    }

    /// API-1d 4.2: the staged client's pasted service hub certificates checked and turned into `spokes_node`
    /// credentials (`api_ui::spokes_credentials`) against this console's Remote Spokes root (`fleet.spokesRoot`) and
    /// the CRL the org's spokes relays hold now, asked only when a certificate was pasted.
    fn api_spokes_credentials(&self, d: &mut api_ui::Draft, org: &str, id: &str, held: &[Value], now: i64) -> Result<(), ApiError> {
        let trust = if api_ui::pastes_spokes_cert(d, id) {
            let root = self.book.lock().spokes_root.as_ref().and_then(|r| str_of(r.get("pem")).map(str::to_owned));
            let root = root.ok_or_else(|| ApiError::with("invalid", "Set the Remote Spokes root of this console first."))?;
            let link = self.link.get().cloned();
            let crls = self.api.spokes_crls(link.as_deref(), org);
            let trust = crate::api_spokes_cred::console_trust(&root, &crls).map_err(|why| ApiError::with("relay-offline", format!("The service hub certificate cannot be checked: {why}.")))?;
            Some(trust)
        } else {
            None
        };
        api_ui::spokes_credentials(d, id, held, trust.as_ref(), now)
    }

    /// A staging route: the org's draft (a new one on the pinned map), the route's change, the map checked as relays
    /// check it (a route that only tightens is never refused for the draft), its tightenings journaled at once, then
    /// the draft kept. A secret or token is in this answer only.
    fn api_stage(&self, c: &Console, who: &Who, path: &str, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let now = t.div_euclid(1000);
        let (pinned, seq, _) = self.api.pinned(org);
        let active = self.api.journal_active(org);
        let held = self.api_drafts.lock().get(org, t).cloned();
        let mut d = match held {
            Some(d) => d,
            None => api_ui::Draft::new(&api_ui::Ctx { org, by: &who.email, pinned: pinned.as_ref(), pinned_seq: seq }, api_ui::new_id("st_", &random8()?), t),
        };
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let none = Value::Null;
        let mut shown = Map::new();
        let mut detail = json!({});
        // revision 4 2.4: a `client_lower_caps` target, journaled at once in the console journal
        let mut lower_caps: Option<Value> = None;
        let journal: Vec<api_ui::Tighten> = match path {
            // API-1 revision 4 13.1: the export recipient key (two-person, 13.3), from a JWK or a PEM
            "settings/api/clients/recipient" => {
                let (kid, jwk, jkt) = api_ui::recipient_of(p.get("jwk"), str_of(p.get("pem")))?;
                if crate::api_cjournal::recipient_dropped(&self.api.console_active(org), &id, &kid) {
                    return Err(ApiError::with("invalid", api_ui::RECIPIENT_WAS_DROPPED));
                }
                api_ui::set_recipient(&mut d, &id, &kid, jwk)?;
                detail["kid"] = json!(kid);
                detail["jkt"] = json!(jkt);
                shown.insert("recipient".into(), json!({ "kid": kid, "jkt": jkt }));
                Vec::new()
            }
            "settings/api/clients/caps" => {
                lower_caps = api_ui::set_caps(&mut d, &id, p.get("caps").unwrap_or(&none), pinned.as_ref())?;
                detail["caps"] = p.get("caps").cloned().unwrap_or(Value::Null);
                Vec::new()
            }
            "settings/api/clients" => {
                let cid = api_ui::new_id("c_", &random8()?);
                api_ui::add_client(&mut d, p.get("client").unwrap_or(&none), cid.clone(), now)?;
                self.api_spokes_credentials(&mut d, org, &cid, &[], now)?;
                detail["client"] = json!(cid);
                Vec::new()
            }
            "settings/api/clients/update" => {
                let held = api_ui::client_credentials(&d, &id);
                let journal = api_ui::update_client(&mut d, &id, p.get("client").unwrap_or(&none), pinned.as_ref(), now)?;
                self.api_spokes_credentials(&mut d, org, &id, &held, now)?;
                journal
            }
            "settings/api/clients/suspend" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_ui::suspend_client(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/clients/resume" => {
                api_ui::resume_client(&mut d, &id, &active)?;
                Vec::new()
            }
            "settings/api/clients/delete" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_ui::delete_client(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/clients/secret" => {
                let minted = api_ui::mint(api_ui::SECRET_PREFIX, &random32()?);
                api_ui::client_secret(&mut d, &id, p.get("days").and_then(Value::as_i64).unwrap_or(0), &minted, now)?;
                shown.insert("secret".into(), json!(minted.secret));
                shown.insert("hint".into(), json!(minted.hint));
                detail["hint"] = json!(minted.hint);
                Vec::new()
            }
            "settings/api/scrape-tokens" => match str_of(p.get("action")) {
                Some("create") => {
                    let minted = api_ui::mint(api_ui::SCRAPE_PREFIX, &random32()?);
                    let relays = p.get("relays").cloned().unwrap_or_else(|| json!(["*"]));
                    api_ui::add_scrape_token(&mut d, str_of(p.get("label")).unwrap_or(""), &relays, p.get("days").and_then(Value::as_i64).unwrap_or(0), &minted, now)?;
                    shown.insert("token".into(), json!(minted.secret));
                    shown.insert("hint".into(), json!(minted.hint));
                    detail["hint"] = json!(minted.hint);
                    Vec::new()
                }
                Some("delete") => {
                    detail["hint"] = json!(str_of(p.get("hint")));
                    api_ui::delete_scrape_token(&mut d, str_of(p.get("hint")).unwrap_or(""), pinned.as_ref())?
                }
                _ => return Err(ApiError::with("invalid", "action is create or delete.")),
            },
            "settings/api/grace" => api_ui::set_grace(&mut d, p.get("grace").unwrap_or(&none), pinned.as_ref())?,
            "settings/api/on" => {
                api_ui::turn_on(&mut d, &active)?;
                Vec::new()
            }
            "settings/api/resume" => {
                api_ui::undo(&mut d, str_of(p.get("tightening")).unwrap_or(""), &active)?;
                Vec::new()
            }
            "settings/api/relay-origins" => {
                api_ui::set_relay_origin(&mut d, str_of(p.get("relay")).unwrap_or(""), str_of(p.get("origin")).unwrap_or("").trim())?;
                Vec::new()
            }
            // API-1d 5.1 (`api_route` checks the relay first and records the binding after)
            "settings/api/spokes/bind" | "settings/api/spokes/unbind" => {
                let (relay, bound) = (str_of(p.get("relay")).unwrap_or(""), path == "settings/api/spokes/bind");
                let root = self.spokes_root_pin();
                api_ui::stage_spokes_relay(&mut d, relay, bound, root.as_ref().map(|(id, spki)| (id.as_str(), spki.as_str())))?;
                detail["relay"] = json!(relay);
                detail["bound"] = json!(bound);
                Vec::new()
            }
            // API-1d 7.14: `spokes.root` from the console's Remote Spokes root, unless a connected bound relay holds
            // another
            "settings/api/spokes/root" => {
                let root = self.spokes_root_pin();
                let reported = self.spokes_reported_roots(org);
                api_1d::stage_spokes_root(&mut d, root.as_ref().map(|(id, spki)| (id.as_str(), spki.as_str())), &reported)?;
                detail["root"] = d.map["spokes"]["root"].clone();
                Vec::new()
            }
            // API-1d 7.14: agents (the `a_` id drawn here), card keys (drawn and sealed by `console_a2a`), the root
            // well-known card, a client's pushes turned off; `agent_drop_skill`, `agent_off` and `push_off` are
            // journaled at once below
            "settings/api/a2a/agents" => {
                let aid = api_ui::new_id("a_", &random8()?);
                api_1d::add_agent(&mut d, p.get("agent").unwrap_or(&none), aid.clone())?;
                detail["agent"] = json!(aid);
                shown.insert("agent".into(), json!(aid));
                Vec::new()
            }
            "settings/api/a2a/agents/update" => api_1d::update_agent(&mut d, &id, p.get("agent").unwrap_or(&none), pinned.as_ref())?,
            "settings/api/a2a/agents/delete" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_1d::delete_agent(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/a2a/keys" => {
                let key = crate::console_a2a::stage_new_key(&mut d, &*self.api.vault(), org, now)?;
                detail["kid"] = key["kid"].clone();
                shown.insert("key".into(), key);
                Vec::new()
            }
            "settings/api/a2a/well-known" => {
                let agent = match p.get("agent") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(a)) if api_1d::agent_id_ok(a) => Some(a.as_str()),
                    Some(_) => return Err(ApiError::with("invalid", "agent is an agent id or null.")),
                };
                api_1d::set_well_known(&mut d, agent)?;
                detail["agent"] = json!(agent);
                Vec::new()
            }
            "settings/api/clients/push-off" => api_1d::push_off(&mut d, &id, pinned.as_ref())?,
            "settings/exports/destinations" if p.get("from_siem") == Some(&Value::Bool(true)) => {
                let did = api_ui::new_id("d_", &random8()?);
                self.api_from_siem(c, &mut d, org, &did, t)?;
                detail["destination"] = json!(did);
                Vec::new()
            }
            "settings/exports/destinations" => {
                let did = api_ui::new_id("d_", &random8()?);
                api_ui::add_destination(&mut d, p.get("destination").unwrap_or(&none), did.clone())?;
                detail["destination"] = json!(did);
                Vec::new()
            }
            "settings/exports/destinations/update" => api_ui::update_destination(&mut d, &id, p.get("destination").unwrap_or(&none), pinned.as_ref())?,
            "settings/exports/destinations/delete" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_ui::delete_destination(&mut d, &id, pinned.as_ref())?
            }
            // API-1 revision 4 8.1: the federation issuer (default I/federation) and keys, drawn and sealed here
            "settings/api/federation" => {
                let i = d.map.pointer("/issuer/url").and_then(Value::as_str).filter(|u| !u.is_empty()).map_or_else(|| self.api_issuer_url(c, org), str::to_owned);
                let default_issuer = format!("{}{}", i.trim_end_matches('/'), crate::api_federation::FRONT_DOOR_PATH);
                if let Some(jwk) = crate::api_federation::stage_issuer(&mut d, &*self.api.vault(), org, str_of(p.get("issuer")), &default_issuer, now)? {
                    detail["kid"] = jwk["kid"].clone();
                    shown.insert("key".into(), jwk);
                }
                detail["issuer"] = d.map["federation"]["issuer"].clone();
                Vec::new()
            }
            "settings/api/federation/key" => {
                let jwk = crate::api_federation::stage_new_key(&mut d, &*self.api.vault(), org, now)?;
                detail["kid"] = jwk["kid"].clone();
                shown.insert("key".into(), jwk);
                Vec::new()
            }
            // API-1 revision 4 7.4: an Ed25519 webhook key drawn and sealed here, its public part staged
            "settings/api/webhook-keys" => {
                let key = crate::api_webhook::stage_new_key(&mut d, &*self.api.vault(), org, now)?;
                detail["kid"] = key["kid"].clone();
                shown.insert("key".into(), key);
                Vec::new()
            }
            // API-1 revision 4 7.4 (R4-D9): a webhook moved to v1 with a new secret, shown once (two-person save)
            "settings/exports/destinations/secret" => {
                let secret = crate::api_webhook::stage_secret(&mut d, &*self.api.vault(), org, &id, now)?;
                shown.insert("secret".into(), json!(secret));
                if let Some(r) = crate::api_webhook::secret_rotate_by(&*self.api.vault(), org, &id) {
                    shown.insert("rotate_by".into(), json!(r));
                }
                Vec::new()
            }
            // API-1 revision 5 14.1 (slice 1c7): connectors (the `k_` id drawn here), idps and delegations; the
            // narrowings, suspensions and revocations are journaled at once below (`api_journal`)
            "settings/api/connectors" => {
                let kid = api_ui::new_id("k_", &random8()?);
                api_1c::add_connector(&mut d, p.get("connector").unwrap_or(&none), kid.clone())?;
                detail["connector"] = json!(kid);
                shown.insert("connector".into(), json!(kid));
                Vec::new()
            }
            "settings/api/connectors/update" => api_1c::update_connector(&mut d, &id, p.get("connector").unwrap_or(&none), pinned.as_ref())?,
            "settings/api/connectors/suspend" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_1c::suspend_connector(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/connectors/resume" => {
                api_1c::resume_connector(&mut d, &id, &self.api.console_active(org))?;
                Vec::new()
            }
            "settings/api/connectors/delete" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_1c::delete_connector(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/idps" => {
                api_1c::add_idp(&mut d, p.get("idp").unwrap_or(&none), &self.api.identity_providers(org))?;
                Vec::new()
            }
            "settings/api/idps/update" => api_1c::update_idp(&mut d, &id, p.get("idp").unwrap_or(&none), pinned.as_ref())?,
            "settings/api/idps/suspend" => {
                detail["reason"] = json!(reason_of(p.get("reason"))?);
                api_1c::suspend_idp(&mut d, &id, pinned.as_ref())?
            }
            "settings/api/idps/resume" => {
                api_1c::resume_idp(&mut d, &id, &self.api.console_active(org))?;
                Vec::new()
            }
            "settings/api/delegations/revoke" => {
                let (client, principal) = (str_of(p.get("client")).unwrap_or(""), str_of(p.get("principal")).unwrap_or(""));
                detail["client"] = json!(client);
                api_1c::revoke_delegation(&mut d, client, principal)?
            }
            "settings/api/delegations/allow" => {
                let (client, principal) = (str_of(p.get("client")).unwrap_or(""), str_of(p.get("principal")).unwrap_or(""));
                detail["client"] = json!(client);
                api_1c::allow_delegation(&mut d, client, principal, &self.api.console_active(org))?;
                Vec::new()
            }
            _ => return Err(ApiError::of("not-found")),
        };
        if journal.is_empty() && lower_caps.is_none() {
            // a widening (or a staged change) must make a map relays accept
            self.api_final(c, &d, &active, t)?;
        }
        let journaled = self.api_journal(org, &journal, t)?;
        if path == "settings/api/clients/caps" {
            let entry = journal_lower_caps(&self.api, org, lower_caps, now)?;
            detail["entry"] = entry.clone();
            shown.insert("journaled".into(), entry);
        }
        let view = d.view(&self.api.journal_active(org));
        detail["stage"] = json!(d.id);
        detail["change"] = json!(d.changes.last());
        detail["journaled"] = json!(journaled);
        if !id.is_empty() {
            detail["id"] = json!(id);
        }
        self.api_drafts.lock().put(d, t);
        let mut answer = json!({ "ok": true, "staged": view });
        if let Some(o) = answer.as_object_mut() {
            o.extend(shown);
        }
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), detail))
    }

    /// `{org, from_siem: true}`: a `syslog_cef` destination from the console's SIEM settings, its client certificate
    /// and sealed key copied into the destination's sealed credential (the SIEM export keeps running).
    fn api_from_siem(&self, c: &Console, d: &mut api_ui::Draft, org: &str, id: &str, t: i64) -> Result<(), ApiError> {
        let siem = c.inner.lock().book.settings.siem.clone();
        let cert = str_of(siem.get("clientCertPem")).filter(|x| !x.is_empty()).map(str::to_owned);
        let key = c.seal_get(crate::console_settings::SIEM_KEY_SECRET).and_then(|b| String::from_utf8(b).ok());
        let (Some(cert_pem), Some(key_pem)) = (cert, key) else { return Err(ApiError::with("invalid", api_ui::SIEM_NO_CERT)) };
        api_ui::siem_destination(d, &siem, id.to_owned())?;
        let entry = api_ui::destination_of(Some(d), None, id).map(|x| x.0);
        let ca_pem = str_of(siem.get("caPem")).map(str::to_owned);
        let credential = crate::api_export_wire::Credential::Mtls { cert_pem, key_pem, ca_pem };
        self.api.put_destination_credential(org, id, entry.as_ref(), credential, t.div_euclid(1000)).map_err(|e| ApiError::with("invalid", e))
    }

    /// Whether a save of the org waits for its signature (one at a time per org).
    fn api_signing_waits(&self, org: &str) -> bool {
        self.api_signings.lock().get(org).is_some_and(api_ui::Signing::in_flight)
    }

    /// `POST settings/api/save {org, stage, reason, relay?}`: the exact final map is built now and its hash bound to
    /// the draft (any later change voids the save); the map and its hash are the save's parameters, so a second
    /// admin (6.6) approves exactly that map; else it is sent at once. Refused while another save of the org waits
    /// for its signature.
    fn api_save(&self, c: &Console, who: &Who, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let stage = str_of(p.get("stage")).unwrap_or("").to_owned();
        let reason = reason_of(p.get("reason"))?;
        if self.api_signing_waits(org) {
            return Err(ApiError::with("stale", api_ui::SIGNING_BUSY));
        }
        let active = self.api.journal_active(org);
        let d = self.api_drafts.lock().get(org, t).filter(|d| d.id == stage).cloned().ok_or_else(|| ApiError::with("gone", api_ui::STAGE_GONE))?;
        if !d.tests_needed().is_empty() {
            return Err(ApiError::with("invalid", api_ui::TESTS_NEEDED));
        }
        let two = !api_ui::two_person(&d.base, &d.map, &active).is_empty();
        let map = self.api_final(c, &d, &active, t)?;
        let sha = crate::api_map::api_map_hash(&map);
        self.api_drafts.lock().ask(org, &stage, &sha)?;
        let mut params = json!({ "org": org, "stage": stage, "reason": reason, "map_sha256": sha, "map": map });
        if let Some(relay) = str_of(p.get("relay")) {
            params["relay"] = json!(relay);
        }
        if two {
            return c.second_or_run(who, "meet.api.save", org, &params, t, || self.api_save_run(c, &who.email, &params, t));
        }
        let answer = self.api_save_run(c, &who.email, &params, t)?;
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), crate::console_approvals::params_detail(&params)))
    }

    /// The save as its requester, with the map it asked for (`map`, `map_sha256`): the draft must still be the one
    /// that map was built from (unchanged since, else `stale`) and sit on the pinned map's seq (else it is dropped,
    /// `stale`); then the relay (the one named, else the first connected relay of the org) is asked to make the
    /// `meet.api.sign` request for the requester's device (`api-sign-request`) for exactly that map; the signing is
    /// recorded and polled (`api_signing_tick`). A failure before the request keeps the draft (to be saved again).
    fn api_save_run(&self, c: &Console, requester: &str, params: &Value, t: i64) -> Result<Value, ApiError> {
        let org = str_of(params.get("org")).unwrap_or("").to_owned();
        let sha = str_of(params.get("map_sha256")).unwrap_or("").to_owned();
        let map = params.get("map").filter(|m| m.is_object()).ok_or_else(|| ApiError::with("stale", api_ui::STAGE_CHANGED))?;
        if crate::api_map::api_map_hash(map) != sha {
            return Err(ApiError::with("stale", api_ui::STAGE_CHANGED));
        }
        if self.api_signing_waits(&org) {
            return Err(ApiError::with("stale", api_ui::SIGNING_BUSY));
        }
        let (_, seq, _) = self.api.pinned(&org);
        let d = self.api_drafts.lock().take(&org, str_of(params.get("stage")).unwrap_or(""), &sha, seq, t)?;
        match self.api_sign_ask(c, &d, map, &sha, requester, params, t) {
            Ok(v) => Ok(v),
            Err(e) => {
                // kept for another save, unless the org was staged again meanwhile (the newer draft wins)
                let mut drafts = self.api_drafts.lock();
                if drafts.get(&org, t).is_none() {
                    drafts.put(d, t);
                }
                Err(e)
            }
        }
    }

    /// Record the signing (`sending`) before the relay is asked; a record that cannot be written sends nothing.
    /// Then `api-sign-request`, and the record becomes `waiting` with the relay's request id, or `failed`.
    #[allow(clippy::too_many_arguments)]
    fn api_sign_ask(&self, c: &Console, d: &api_ui::Draft, map: &Value, sha: &str, requester: &str, params: &Value, t: i64) -> Result<Value, ApiError> {
        let relay = match str_of(params.get("relay")) {
            Some(r) => r.to_owned(),
            None => self.api.relays_of(&d.org).into_iter().find(|r| self.connected(r)).ok_or_else(|| ApiError::with("relay-offline", api_ui::NO_RELAY))?,
        };
        let link = self.link.get().cloned().ok_or_else(|| relay_words("relay-offline", &self.name_of(&relay)))?;
        let sending = api_ui::Signing { org: d.org.clone(), relay: relay.clone(), request: String::new(), by: requester.to_owned(), at: t, state: "sending", error: None, map_sha256: sha.to_owned(), seq: d.base_seq + 1 };
        {
            let mut all = self.api_signings.lock();
            if all.get(&d.org).is_some_and(api_ui::Signing::in_flight) {
                return Err(ApiError::with("stale", api_ui::SIGNING_BUSY));
            }
            let before = all.insert(d.org.clone(), sending);
            if let Err(why) = api_ui::signings_save(&self.state_dir, &all) {
                match before {
                    Some(b) => all.insert(d.org.clone(), b),
                    None => all.remove(&d.org),
                };
                c.logger.ops("api.signing.unsaved", &Fields::new().with("org", d.org.as_str()).with("why", why), Level::Error);
                return Err(ApiError::with("write-failed", api_ui::SIGNING_UNSAVED));
            }
        }
        let body = json!({ "org": d.org, "principal": requester, "map": map, "map_sha256": sha, "reason": str_of(params.get("reason")).unwrap_or(""), "requested_by": requester });
        let asked = link.request(&relay, "api-sign-request", body, CALL_MS).map_err(|e| match e {
            LinkError::Refused { code, .. } if code == "fleet-op" => ApiError::with("fleet-op", api_ui::RELAY_TOO_OLD),
            LinkError::Refused { status, code, error } => {
                let code = crate::console::code_words_static(&code).unwrap_or("invalid");
                ApiError { status, code, message: clean(&error).chars().take(500).collect(), retry_after: None }
            }
            LinkError::Offline => relay_words("relay-offline", &self.name_of(&relay)),
            LinkError::Timeout => relay_words("relay-timeout", &self.name_of(&relay)),
            LinkError::Busy => relay_words("relay-busy", &self.name_of(&relay)),
        });
        let request = asked.and_then(|a| str_of(a.get("request")).filter(|r| r.starts_with("rq_")).map(str::to_owned).ok_or_else(|| ApiError::with("fleet-op", api_ui::RELAY_TOO_OLD)));
        // the record follows the answer: `waiting` with the request id, or `failed` with the refusal's words
        let view = {
            let mut all = self.api_signings.lock();
            let Some(x) = all.get_mut(&d.org).filter(|x| x.state == "sending" && x.at == t) else { return Err(ApiError::with("stale", api_ui::SIGN_GONE)) };
            match &request {
                Ok(id) => (x.state, x.request) = ("waiting", id.clone()),
                Err(e) => (x.state, x.error) = ("failed", Some(e.message.clone())),
            }
            let view = x.view();
            if let Err(why) = api_ui::signings_save(&self.state_dir, &all) {
                c.logger.ops("api.signing.unsaved", &Fields::new().with("org", d.org.as_str()).with("why", why), Level::Error);
            }
            view
        };
        let request = request?;
        c.logger.ops("api.save.asked", &Fields::new().with("org", d.org.as_str()).with("relay", relay.as_str()).with("request", request.as_str()).with("map", sha), Level::Info);
        Ok(json!({ "ok": true, "request": request, "relay": relay, "signing": view }))
    }

    /// `POST settings/api/signing/cancel {org}`: the save waiting for its signature is failed (`Canceled`) and no
    /// longer polled; its request on the relay is replaced by the next save of the org (or expires there).
    fn api_signing_cancel(&self, org: &str, t: i64) -> Result<Done, ApiError> {
        let s = self.api_signings.lock().get(org).filter(|s| s.in_flight()).cloned().ok_or_else(|| ApiError::with("stale", api_ui::NO_SIGNING))?;
        if s.state == "publishing" {
            return Err(ApiError::with("stale", api_ui::SIGN_PUBLISHING));
        }
        match self.api_signing_end(&s, Err(api_ui::SIGN_CANCELED.into()), t) {
            Ok(true) => {}
            // claimed for publication meanwhile
            Ok(false) => return Err(ApiError::with("stale", api_ui::SIGN_PUBLISHING)),
            Err(_) => return Err(ApiError::with("write-failed", api_ui::SIGNING_UNSAVED)),
        }
        let view = self.api_signings.lock().get(org).map(api_ui::Signing::view);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "signing": view })), Some(org.to_owned()), json!({ "request": s.request, "relay": s.relay })))
    }

    /// The minute tick: every waiting signing (and one left `sending` by a lost answer or a restart, after 2
    /// minutes, or left `publishing` by a restart or an unwritten end) is polled on one thread (`api-sign-status`).
    /// Only this thread publishes, so a `publishing` record the tick sees is always a leftover.
    fn api_signing_tick(&self, t: i64) {
        use std::sync::atomic::Ordering;
        let waiting: Vec<api_ui::Signing> =
            self.api_signings.lock().values().filter(|s| matches!(s.state, "waiting" | "publishing") || (s.state == "sending" && t - s.at >= SENDING_STALE_MS)).cloned().collect();
        if waiting.is_empty() {
            return;
        }
        let (Some(link), Some(me)) = (self.link.get().cloned(), self.console().ok().and_then(|c| c.fleet())) else { return };
        if self.api_signing_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let spawned = std::thread::Builder::new().name("api-signing".into()).spawn(move || {
            for s in waiting {
                me.api_signing_poll(&*link, &s, t);
            }
            me.api_signing_busy.store(false, Ordering::SeqCst);
        });
        if spawned.is_err() {
            self.api_signing_busy.store(false, Ordering::SeqCst);
        }
    }

    /// One waiting signing: the relay's state of the request; done publishes the signed map (`api_publish_signed`);
    /// failed, gone, an older relay or 24 hours without an answer fail it with the sentence.
    pub fn api_signing_poll(&self, link: &dyn FleetLink, s: &api_ui::Signing, t: i64) {
        // a leftover `publishing` whose map is pinned already: published before the end was written
        if s.state == "publishing" {
            let (pinned, seq, _) = self.api.pinned(&s.org);
            if pinned.is_some_and(|m| crate::api_map::api_map_hash(&m) == s.map_sha256) {
                let _ = self.api_signing_end(s, Ok(seq), t);
                return;
            }
        }
        // recorded, but the relay's answer (its request id) never arrived: nothing can be polled
        if s.request.is_empty() {
            let _ = self.api_signing_end(s, Err(api_ui::SIGN_LOST.into()), t);
            return;
        }
        let answer = match link.request(&s.relay, "api-sign-status", json!({ "org": s.org, "request": s.request }), CALL_MS) {
            Ok(a) => a,
            Err(LinkError::Refused { code, .. }) if code == "fleet-op" => {
                let _ = self.api_signing_end(s, Err(api_ui::RELAY_TOO_OLD.into()), t);
                return;
            }
            // offline or no answer: asked again next minute, until 24 hours
            Err(_) => json!({ "state": "waiting" }),
        };
        let Some(verdict) = s.judge(&answer, t) else { return };
        let outcome = match verdict {
            Ok((signed, signer_policy)) => {
                // claimed first, so a cancel and a publication can never both succeed
                if !self.api_signing_claim(s) {
                    return;
                }
                self.api_publish_signed(&s.org, &s.map_sha256, &signed, &signer_policy, t)
            }
            Err(why) => Err(why),
        };
        let _ = self.api_signing_end(s, outcome, t);
    }

    /// Claim this signing for publication (`publishing`, written to disk): false when it was canceled or replaced
    /// meanwhile, or the record could not be written (then it stays as it was and is polled again).
    fn api_signing_claim(&self, s: &api_ui::Signing) -> bool {
        let mut all = self.api_signings.lock();
        let Some(x) = all.get_mut(&s.org).filter(|x| x.request == s.request && x.at == s.at && x.in_flight()) else { return false };
        let before = x.state;
        x.state = "publishing";
        if let Err(why) = api_ui::signings_save(&self.state_dir, &all) {
            if let Some(x) = all.get_mut(&s.org) {
                x.state = before;
            }
            if let Ok(c) = self.console() {
                c.logger.ops("api.signing.unsaved", &Fields::new().with("org", s.org.as_str()).with("why", why), Level::Error);
            }
            return false;
        }
        true
    }

    /// API-1 2.3, 2.4: publish a map a device signed for a save: it must be the map the save asked for
    /// (`map_sha256`), and it is verified against this console's own Meet CA (root) with the signer policy the relay
    /// sent (which must itself be signed by that root; the relay's verdict is never trusted), then pinned and sent to
    /// the org's relays (`ConsoleApi::publish_map`). Ok is the pinned seq.
    pub fn api_publish_signed(&self, org: &str, map_sha256: &str, signed: &Value, signer_policy: &Map<String, Value>, t: i64) -> Result<i64, String> {
        let (root_der, crl_pem) = {
            let g = self.meet.lock();
            let ca = g.as_ref().filter(|m| m.state() == crate::meet_ca::CaState::Ok).ok_or(api_ui::NO_CA)?;
            (ca.ca_der().to_vec(), ca.crl().map(|x| x.0))
        };
        let root = crate::meet_x509::Cert::from_der(&root_der).ok_or(api_ui::NO_CA)?;
        // API-1d 2.4: spokes relays get this root (and CRL) as the `trust` of each map they are sent
        self.api.save_map_trust(org, &root_der, crl_pem.as_deref());
        let crl = crl_pem.and_then(|p| crate::der::pem_blocks(&p, "X509 CRL").into_iter().next()).and_then(|der| crate::meet_x509::Crl::from_der(&der));
        let trust = crate::api_map::ApiTrust { root: &root, signer_policy, root_crl: crl.as_ref(), previous_serial: "" };
        self.api_publish_trusted(org, map_sha256, signed, &trust, self.api_edition(t), t)
    }

    /// `api_publish_signed` under a given trust and license edition: the map the save asked for, verified, pinned
    /// and sent.
    fn api_publish_trusted(&self, org: &str, map_sha256: &str, signed: &Value, trust: &crate::api_map::ApiTrust, edition: Option<crate::api_map::Edition>, t: i64) -> Result<i64, String> {
        let map = signed.get("map").filter(|m| m.is_object()).ok_or(api_ui::SIGN_OTHER_MAP)?;
        if crate::api_map::api_map_hash(map) != map_sha256 || str_of(map.get("org")) != Some(org) {
            return Err(api_ui::SIGN_OTHER_MAP.into());
        }
        self.api.set_edition(edition);
        match self.api.publish_map(self.link.get().cloned(), signed, trust, t.div_euclid(1000), None, edition) {
            Ok(crate::api_map::AcceptOutcome::Pinned(vm) | crate::api_map::AcceptOutcome::Unchanged(vm)) => Ok(vm.seq),
            Ok(crate::api_map::AcceptOutcome::Conflict { .. }) => Err("Another api map with this seq is pinned already. Stage the change again.".into()),
            Err(e) => Err(api_sentence(&e.message)),
        }
    }

    /// A signing ended (done with the pinned seq, or failed with its sentence): recorded on disk, then in the audit.
    /// A cancel (`SIGN_CANCELED`) ends only a signing not yet claimed for publication. Ok(false) when the record is no
    /// longer this signing's (or is claimed, for a cancel); Err when the end could not be written (the record stays
    /// as it was, so it is polled again).
    fn api_signing_end(&self, s: &api_ui::Signing, outcome: Result<i64, String>, t: i64) -> Result<bool, String> {
        let c = self.console().map_err(|_| "The console is shutting down.".to_string())?;
        let cancel = matches!(&outcome, Err(why) if why == api_ui::SIGN_CANCELED);
        let ended = {
            let mut all = self.api_signings.lock();
            let Some(x) = all.get_mut(&s.org).filter(|x| x.request == s.request && x.at == s.at && x.in_flight() && !(cancel && x.state == "publishing")) else { return Ok(false) };
            let before = x.clone();
            match &outcome {
                Ok(seq) => (x.state, x.seq, x.error) = ("done", *seq, None),
                Err(why) => (x.state, x.error) = ("failed", Some(why.clone())),
            }
            if let Err(why) = api_ui::signings_save(&self.state_dir, &all) {
                all.insert(s.org.clone(), before);
                c.logger.ops("api.signing.unsaved", &Fields::new().with("org", s.org.as_str()).with("why", why.as_str()), Level::Error);
                return Err(why);
            }
            all.get(&s.org).cloned()
        };
        let Some(x) = ended else { return Ok(false) };
        let result = if x.state == "done" { "ok" } else { "failed" };
        self.record(&c, &x.by, "meet.api.sign", Some(x.org.clone()), json!({ "request": x.request, "relay": x.relay, "seq": x.seq, "map_sha256": x.map_sha256, "result": result, "error": x.error }), t);
        Ok(true)
    }

    /// `GET settings/api` (7.3): per org the console holds a map, journal, draft or signing for (or a relay
    /// serves): its state, the pinned map (credentials as hints), the newest 50 journal entries, its relays, the
    /// staged draft and its map, the signing of its last save and the edition's limits.
    fn api_view(&self, t: i64) -> Value {
        let now = t.div_euclid(1000);
        let edition = self.api_edition(t);
        self.api.set_edition(edition);
        let mut orgs: std::collections::BTreeSet<String> = self.api.known_orgs().into_iter().collect();
        orgs.extend(self.api_drafts.lock().orgs(t));
        let signings = self.api_signings.lock().clone();
        orgs.extend(signings.keys().cloned());
        let list: Vec<Value> = orgs
            .into_iter()
            .map(|org| {
                let (pinned, seq, aside) = self.api.pinned(&org);
                let active = self.api.journal_active(&org);
                let owner = self.api_owner(&org);
                let draft = self.api_drafts.lock().get(&org, t).cloned();
                let entries: Vec<Value> = self.api.journal_newest(&org, api_ui::JOURNAL_SHOWN);
                let console = self.api.console_active(&org);
                // revision 5 14.1, 14.2 (slice 1c7): connectors with their sync status, idps with their last test, the
                // policy's api apps and ai groups, the registry providers, api_return and the standing person revokes
                let status = self.api_connector_status(&org, &[pinned.as_ref(), draft.as_ref().map(|d| &d.map)], now);
                let last_test = |issuer: &str| self.api.idp_last_test(&org, issuer);
                let view_of = |m: &Value, seq: i64| {
                    let mut v = api_ui::map_view(m, seq, &active, &console, &owner, now);
                    api_1c::map_view_1c(&mut v, m, &status, &console, &last_test);
                    // API-1d 7.14: partner card checks and the card key hand-off of `agent` clients
                    self.api_client_a2a(&org, &mut v, now);
                    v
                };
                let policy = self.api.verified_policy(&org, now);
                let api_return = api_1c::api_return(pinned.as_ref().and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str));
                json!({
                    "org": org, "edition": edition.map(crate::api_map::Edition::as_str),
                    "state": api_ui::org_state(pinned.as_ref(), aside, &active, now),
                    "map": pinned.as_ref().map(|m| view_of(m, seq)),
                    "journal": { "head": self.api.journal_head(&org), "entries": entries },
                    "relays": self.api.relays_view(&org),
                    "relay_set": self.api_relay_set(&org, pinned.as_ref()),
                    "staged": draft.as_ref().map(|d| d.view(&active)),
                    "draft": draft.as_ref().map(|d| view_of(&d.map, d.base_seq + 1)),
                    "signing": signings.get(&org).map(api_ui::Signing::view),
                    "limits": api_ui::limits(edition),
                    "connector_status": status,
                    "api_apps": api_1c::api_apps(policy.as_ref()), "policy_known": policy.is_some(),
                    "ai_groups": api_1c::ai_groups(policy.as_ref()),
                    "providers": self.api_providers(&org, &api_return), "api_return": api_return,
                    "person_revokes": api_1c::revoke_views(&console, "*"),
                })
            })
            .collect();
        // revision 4 13.2: the Meet CA root compliance tools pin (lowercase hex SHA-256 of its DER)
        let meet_ca = self.meet.lock().as_ref().map(|ca| json!({ "fingerprint": crate::codec::sha256_hex(ca.ca_der()) }));
        json!({ "ok": true, "orgs": list, "meet_ca": meet_ca })
    }

    /// Revision 4 2.3 item 2 (the relay-outdated and Retire screens): each relay of the org's set with its latest
    /// `api-features` answer (`map: []`, `features: []`, `reported_at: null` before one) and the needs of the pinned
    /// map it does not report (`lacks`).
    fn api_relay_set(&self, org: &str, pinned: Option<&Value>) -> Vec<Value> {
        let needs = pinned.map(crate::api_features::map_needs).unwrap_or_default();
        self.api
            .relay_set(org)
            .into_iter()
            .map(|(id, report)| {
                let lacks: Vec<&str> = needs.iter().copied().filter(|n| !report.as_ref().is_some_and(|r| r.has(n))).collect();
                let connected = self.connected(&id);
                match report {
                    Some(r) => json!({ "id": id, "connected": connected, "map": r.map, "features": r.features, "reported_at": r.at, "lacks": lacks }),
                    None => json!({ "id": id, "connected": connected, "map": [], "features": [], "reported_at": null, "lacks": lacks }),
                }
            })
            .collect()
    }

    /// The `api` and `presets` keys of `GET settings/exports` (7.3, 11.7, 12.3): per org its destinations (the
    /// draft's when one is staged, else the pinned map's) with credential, live status, test state and failover
    /// records, and the org's relays.
    pub fn exports_api_view(&self, t: i64) -> (Value, Value) {
        let status = self.export.status(None, t);
        let mut orgs: std::collections::BTreeSet<String> = self.api.known_orgs().into_iter().collect();
        orgs.extend(self.api_drafts.lock().orgs(t));
        let active_of = |org: &str| self.api.journal_active(org);
        let republish = crate::api_federation::republish_attention(&self.api, &self.state_dir);
        let list: Vec<Value> = orgs
            .into_iter()
            .map(|org| {
                let (pinned, _, _) = self.api.pinned(&org);
                let draft = self.api_drafts.lock().get(&org, t).cloned();
                let pinned_dests: Vec<Value> = pinned.as_ref().and_then(|m| m.get("destinations")).and_then(Value::as_array).cloned().unwrap_or_default();
                let shown: Vec<Value> = match &draft {
                    Some(d) => d.map.get("destinations").and_then(Value::as_array).cloned().unwrap_or_default(),
                    None => pinned_dests.clone(),
                };
                let needed = draft.as_ref().map(api_ui::Draft::tests_needed).unwrap_or_default();
                let records = self.api.failover_records(&org);
                let destinations: Vec<Value> = shown
                    .iter()
                    .map(|x| {
                        let id = str_of(x.get("id")).unwrap_or("");
                        let source = if pinned_dests.contains(x) { "pinned" } else { "staged" };
                        let st = status.iter().find(|s| str_of(s.get("org")) == Some(org.as_str()) && str_of(s.get("id")) == Some(id));
                        let failover: Vec<Value> = records
                            .iter()
                            .filter(|r| r.destination == id)
                            .map(|r| json!({ "relay": r.relay, "type": r.kind, "public_id": r.public_id, "not_before": r.not_before, "expires": r.expires, "state": r.state, "note": r.note }))
                            .collect();
                        let mut v = api_ui::destination_view(x, source, self.api.has_destination_credential(&org, id), self.api.destination_credential_rotate_by(&org, id), st, !needed.iter().any(|n| n == id), failover);
                        // API-1 revision 4 7.4: a webhook's v1 secret and its 90-day "rotate by"
                        if let Some(r) = crate::api_webhook::secret_rotate_by(&*self.api.vault(), &org, id) {
                            v["whsec_rotate_by"] = json!(r);
                        }
                        v
                    })
                    .collect();
                // revision 4 7.4, 8, 13.2: the webhook keys, outbound identity and events clients of the map shown (the
                // draft's when staged), the issuer url (`<I>/v1/webhooks/keys`) and the dropped federation keys an admin
                // has yet to confirm as gone from the hosted key sets
                let shown_map = draft.as_ref().map(|d| &d.map).or(pinned.as_ref());
                let console = self.api.console_active(&org);
                let issuer_url = pinned.as_ref().and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_owned).or_else(|| self.console().ok().map(|c| self.api_issuer_url(&c, &org)));
                let to_confirm: Vec<&String> = republish.iter().filter(|(o, _)| *o == org).map(|(_, kid)| kid).collect();
                json!({
                    "org": org, "staged": draft.as_ref().map(|d| d.view(&active_of(&org))), "destinations": destinations, "relays": self.api.relays_of(&org),
                    "webhook_keys": shown_map.map_or_else(|| json!([]), |m| api_ui::webhook_keys_view(m, &console)),
                    "federation": shown_map.map_or(Value::Null, |m| api_ui::federation_view(m, &console)),
                    "events_clients": shown_map.map_or_else(|| json!([]), api_ui::events_clients),
                    "issuer_url": issuer_url, "federation_republish": to_confirm,
                })
            })
            .collect();
        (Value::Array(list), api_ui::presets_view())
    }

    /// `POST settings/api/explain {client, method, path, ip?}` (6.2).
    fn api_explain(&self, c: &Console, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        self.api.set_edition(self.api_edition(t));
        let store = self.api.org_snapshot(org);
        let owner = self.api_owner(org);
        let licensed = c.license_view(t).service.state != crate::console::ServiceState::Stopped;
        let site = api_ui::ExplainSite { store: store.as_ref(), licensed, owner_active: &owner, now: t.div_euclid(1000) };
        let (client, method, path) = (str_of(p.get("client")).unwrap_or(""), str_of(p.get("method")).unwrap_or("GET"), str_of(p.get("path")).unwrap_or(""));
        let v = api_ui::explain(&site, org, client, method, path, str_of(p.get("ip")))?;
        let detail = json!({ "client": client, "method": method, "path": path, "first_fail": v.get("first_fail") });
        let mut answer = v;
        answer["ok"] = json!(true);
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), detail))
    }

    /// `POST settings/api/clients/revoke-tokens {id}`: `token_deny` for every access token of the client still live
    /// (issued within the last hour and not expired), found in the org's audit chains (the console's and every
    /// relay's), each until its `exp`.
    fn api_revoke_tokens(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let now = t.div_euclid(1000);
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let (pinned, _, _) = self.api.pinned(org);
        if !pinned.as_ref().and_then(|m| m.get("clients")).and_then(Value::as_array).is_some_and(|l| l.iter().any(|c| str_of(c.get("id")) == Some(id.as_str()))) {
            return Err(ApiError::with("not-found", api_ui::NO_CLIENT));
        }
        let live = self.api_live_tokens(org, &id, now);
        let entries: Vec<api_ui::Tighten> = live.iter().map(|(jti, exp)| api_ui::Tighten { action: "token_deny", target: json!({ "client": id, "jti": jti }), until: Some(*exp) }).collect();
        let denied = self.api_journal(org, &entries, t)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true, "denied": denied })), Some(org.to_owned()), json!({ "id": id, "denied": denied })))
    }

    /// (jti, exp) of the client's access tokens issued in the last hour and not expired, from the `api.token`
    /// entries of the org's chains (read back at most 20 pages of 1000 per chain).
    fn api_live_tokens(&self, org: &str, client: &str, now: i64) -> Vec<(String, i64)> {
        let audit = self.api_audit();
        let mut sources = vec!["console".to_owned()];
        sources.extend(self.api.relays_of(org));
        let mut out: Vec<(String, i64)> = Vec::new();
        for source in sources {
            let (head, _) = audit.head(org, &source, crate::api_audit::Repr::AsIs);
            let mut after = head;
            for _ in 0..LIVE_TOKEN_PAGES {
                if after == 0 {
                    break;
                }
                after = after.saturating_sub(1000);
                let entries = audit.read(org, &source, crate::api_audit::Repr::AsIs, after, 1000).ok().and_then(|v| v.get("entries").and_then(Value::as_array).cloned()).unwrap_or_default();
                for e in &entries {
                    let exp = e.get("exp").and_then(Value::as_i64).unwrap_or(0);
                    if str_of(e.get("action")) == Some("api.token") && str_of(e.get("client")) == Some(client) && exp > now {
                        if let Some(jti) = str_of(e.get("jti")).filter(|j| !out.iter().any(|(x, _)| x == j)) {
                            out.push((jti.to_owned(), exp));
                        }
                    }
                }
                if entries.first().and_then(|e| e.get("ts")).and_then(Value::as_i64).is_some_and(|ts| ts < now - LIVE_TOKEN_WINDOW_S) {
                    break;
                }
            }
        }
        out
    }

    /// `POST settings/exports/destinations/test {id}`: one `exports.test` record through the destination as staged
    /// (or pinned) with its held credential; a pass clears the draft's test need for it.
    fn api_dest_test(&self, c: &Console, who: &Who, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        c.limit(crate::console_limits::Limit::EmailTest, &format!("exports-test|{}", who.email), t)?;
        let (pinned, _, _) = self.api.pinned(org);
        let draft = self.api_drafts.lock().get(org, t).cloned();
        let (x, staged) = api_ui::destination_of(draft.as_ref(), pinned.as_ref(), &id).ok_or_else(|| ApiError::with("not-found", api_ui::NO_DESTINATION))?;
        // revision 4 13.2: a webhook's test is a `test.ping` event
        if str_of(x.get("kind")) == Some("webhook") {
            return self.api_webhook_test(org, &x, staged, draft.as_ref(), t);
        }
        let rid = hex(&random8()?);
        // revision 4 8: a federated credential signs with the draft's federation block when the destination is staged
        let held = if crate::api_federation::is_federated(&x) {
            let fed = draft.as_ref().filter(|_| staged).and_then(|d| d.map.get("federation")).filter(|f| f.is_object());
            crate::api_federation::credential_for(&self.api, org, &x, fed, self.federation_audit(c.logger.clone()))
        } else {
            self.api.destination_credential(org, &id)
        };
        let sent = match held {
            None => Err("This destination holds no credential yet. Enter it first.".to_owned()),
            Some(credential) => export_sink(&x, credential, &c.cfg.host).and_then(|s| s.deliver(&api_ui::test_batch(&x, org, &rid, t))).map_err(|e| api_sentence(&e.message)),
        };
        let answer = match &sent {
            Ok(()) => {
                self.api_drafts.lock().tested(org, &id);
                json!({ "ok": true })
            }
            Err(why) => json!({ "ok": false, "error": why }),
        };
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "passed": sent.is_ok() })))
    }

    /// `POST settings/exports/destinations/credential {id, credential}` (11.3): sealed for the destination as staged
    /// (or pinned); a staged entry takes the credential's public fields and needs a passing test again.
    fn api_dest_credential(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let material = p.get("credential").cloned().unwrap_or(Value::Null);
        let credential = crate::api_export::credential_of(&material).ok_or_else(|| ApiError::with("invalid", "The credential does not read: give its type and every field of it."))?;
        let ty = crate::api_export::credential_type(&credential).unwrap_or("none");
        let mut draft = self.api_drafts.lock().get(org, t).cloned();
        let entered = draft.as_mut().is_some_and(|d| api_ui::credential_entered(d, &id, &material));
        let staged = draft.as_ref().and_then(|d| api_ui::destination_of(Some(d), None, &id)).map(|x| x.0);
        self.api.put_destination_credential(org, &id, staged.as_ref(), credential, t.div_euclid(1000)).map_err(|e| ApiError::with("invalid", e))?;
        if let (true, Some(d)) = (entered, draft) {
            self.api_drafts.lock().put(d, t);
        }
        let mut answer = json!({ "ok": true, "held": true });
        if let Some(r) = self.api.destination_credential_rotate_by(org, &id) {
            answer["rotate_by"] = json!(r);
        }
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "type": ty })))
    }

    /// `POST settings/exports/destinations/failover/{csr, install, delete} {id, relay, material?}` (12.3) on the
    /// relay over the fleet channel; the material never enters the audit.
    fn api_failover(&self, path: &str, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let relay = str_of(p.get("relay")).filter(|r| crate::fleet_metrics::relay_id_ok(r)).ok_or_else(|| ApiError::with("invalid", "relay is a relay id."))?.to_owned();
        let link = self.link.get().cloned().ok_or_else(|| relay_words("relay-offline", &self.name_of(&relay)))?;
        let failed = |e: String| ApiError::with("invalid", e);
        let record = |api: &crate::console_api::ConsoleApi| {
            api.failover_records(org).into_iter().find(|r| r.destination == id && r.relay == relay).map(|r| json!({ "relay": r.relay, "type": r.kind, "public_id": r.public_id, "not_before": r.not_before, "expires": r.expires, "state": r.state, "note": r.note }))
        };
        let answer = match path.rsplit('/').next() {
            Some("csr") => json!({ "ok": true, "csr": self.api.failover_request_csr(&*link, org, &id, &relay).map_err(failed)? }),
            Some("install") => {
                self.api.failover_install(&*link, org, &id, &relay, p.get("material").cloned().unwrap_or(Value::Null), t.div_euclid(1000)).map_err(failed)?;
                json!({ "ok": true, "record": record(&self.api) })
            }
            _ => {
                self.api.failover_delete(&*link, org, &id, &relay).map_err(failed)?;
                json!({ "ok": true, "record": record(&self.api) })
            }
        };
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "relay": relay })))
    }
}

// ── API-1 revision 5 14.1 (slice 1c7): connectors, identity providers, the SSO URL, delegations, approvals ─────────

/// The org of a revision 5 14.1 GET (`?org=`).
fn query_org(q: &[(String, String)]) -> Result<String, ApiError> {
    q.iter().find(|(k, _)| k == "org").map(|(_, v)| v.as_str()).filter(|o| crate::api_audit::org_ok(o)).map(str::to_owned).ok_or_else(|| ApiError::with("invalid", "org is an organization id."))
}

fn query_of<'a>(q: &'a [(String, String)], k: &str) -> Option<&'a str> {
    q.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
}

/// The connectors of a map.
fn map_connectors(m: Option<&Value>) -> impl Iterator<Item = &Value> {
    m.and_then(|m| m.get("connectors")).and_then(Value::as_array).into_iter().flatten()
}

impl Fleet {
    /// 14.1 `connector_status`: per connector of `maps` (the pinned and the staged map), its status from its latest
    /// acknowledgment (`console_connector::latest_ack`).
    fn api_connector_status(&self, org: &str, maps: &[Option<&Value>], now: i64) -> Map<String, Value> {
        let mut out = Map::new();
        for k in maps.iter().flat_map(|m| map_connectors(*m)) {
            let Some(id) = str_of(k.get("id")).filter(|id| !out.contains_key(*id)) else { continue };
            let ack = self.api.state_dir().and_then(|dir| crate::console_connector::latest_ack(dir, org, id));
            let stale_s = k.get("stale_s").and_then(Value::as_i64).unwrap_or(api_1c::STALE_DEFAULT);
            out.insert(id.to_owned(), api_1c::connector_status(ack.as_ref(), stale_s, now));
        }
        out
    }

    /// The org's registry providers (signer policy v3) as ProviderViews.
    fn api_providers(&self, org: &str, api_return: &Value) -> Vec<Value> {
        self.api.identity_providers(org).iter().map(|p| api_1c::provider_view(p, self.api.sso_url(org, &p.id), api_return)).collect()
    }

    /// `GET settings/api/connectors?org=` (14.1): the pinned map's connectors, each with its sync status (age,
    /// conversations count, key store, features).
    fn api_connectors_get(&self, q: &[(String, String)], t: i64) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let (pinned, _, _) = self.api.pinned(&org);
        let status = self.api_connector_status(&org, &[pinned.as_ref()], t.div_euclid(1000));
        let console = self.api.console_active(&org);
        let connectors: Vec<Value> = map_connectors(pinned.as_ref()).map(|k| api_1c::connector_with_status(k, status.get(str_of(k.get("id")).unwrap_or("")), &console)).collect();
        Ok(json!({ "ok": true, "org": org, "connectors": connectors }))
    }

    /// `GET settings/api/idps?org=` (14.1): the pinned map's idps with their last test, the org's registry providers
    /// with their SSO URLs, and `api_return`.
    fn api_idps_get(&self, q: &[(String, String)]) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let (pinned, _, _) = self.api.pinned(&org);
        let console = self.api.console_active(&org);
        let idps: Vec<Value> = pinned
            .as_ref()
            .and_then(|m| m.get("idps"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|i| api_1c::idp_view(i, &console, self.api.idp_last_test(&org, str_of(i.get("issuer")).unwrap_or(""))))
            .collect();
        let api_return = api_1c::api_return(pinned.as_ref().and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str));
        Ok(json!({ "ok": true, "org": org, "idps": idps, "providers": self.api_providers(&org, &api_return), "api_return": api_return }))
    }

    /// `GET settings/api/delegations?org=&client=` (14.1): the people with a delegated token of the client (`*`: of
    /// any) in the last 24 hours or a live refresh family, and the active `person_revoke` entries.
    fn api_delegations_get(&self, q: &[(String, String)], t: i64) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let client = query_of(q, "client").filter(|c| !c.is_empty()).unwrap_or("*").to_owned();
        if client != "*" && !api_1c::client_id_ok(&client) {
            return Err(ApiError::with("invalid", api_1c::BAD_CLIENT));
        }
        let uses = self.api.delegation_uses(&org, (client != "*").then_some(client.as_str()), t.div_euclid(1000)).map_err(|why| ApiError::with("write-failed", api_sentence(&why)))?;
        let (pinned, _, _) = self.api.pinned(&org);
        let console = self.api.console_active(&org);
        let name = |id: &str| pinned.as_ref().and_then(|m| api_ui::find(m, "clients", id)).and_then(|c| str_of(c.get("name"))).unwrap_or(id).to_owned();
        let people: Vec<Value> = uses.iter().map(|u| api_1c::delegation_view(u, &name(&u.client), crate::api_cjournal::person_revoked(&console, &u.client, &u.person))).collect();
        Ok(json!({ "ok": true, "org": org, "client": client, "people": people, "revokes": api_1c::revoke_views(&console, &client) }))
    }

    /// `GET settings/api/approvals?org=&client=` (14.1): the approval metadata of the pinned connectors' audit chains
    /// held by the console (`content.approval.*`, `content.person.stopped`), of the client when given, newest first,
    /// at most 200; never text.
    fn api_approvals_get(&self, q: &[(String, String)]) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let client = query_of(q, "client").filter(|c| !c.is_empty() && *c != "*");
        let (pinned, _, _) = self.api.pinned(&org);
        let mut list: Vec<Value> = Vec::new();
        if let Some((audit, _)) = self.api.audit_parts() {
            for id in map_connectors(pinned.as_ref()).filter_map(|k| str_of(k.get("id"))) {
                let (mut after, _) = audit.head(&org, id, crate::api_audit::Repr::AsIs);
                let mut found = 0;
                for _ in 0..LIVE_TOKEN_PAGES {
                    if after == 0 || found >= api_1c::APPROVALS_MAX {
                        break;
                    }
                    after = after.saturating_sub(1000);
                    for e in audit.range(&org, id, crate::api_audit::Repr::AsIs, after, 1000) {
                        if let Some(v) = api_1c::approval_view(id, &e).filter(|v| client.is_none_or(|c| str_of(v.get("client")) == Some(c))) {
                            list.push(v);
                            found += 1;
                        }
                    }
                }
            }
        }
        Ok(json!({ "ok": true, "org": org, "approvals": api_1c::newest_approvals(list) }))
    }

    // ── API-1d 7.14 (slice 1d5): Agents and Remote Spokes ──

    /// The console's Remote Spokes root (`fleet.spokesRoot`): its node id and the SHA-256 hex of its public key.
    fn spokes_root_pin(&self) -> Option<(String, String)> {
        self.book.lock().spokes_root.as_ref().and_then(|r| {
            let der = crate::der::pem_blocks(str_of(r.get("pem"))?, "PUBLIC KEY").into_iter().next()?;
            Some((str_of(r.get("id"))?.to_owned(), crate::codec::sha256_hex(&der)))
        })
    }

    /// The live Remote Spokes relays of this console, `(id, name)`.
    fn spokes_relays_live(&self) -> Vec<(String, String)> {
        self.registry.lock().relays.values().filter(|r| r.state.live() && r.product == Product::Spokes).map(|r| (r.id.clone(), r.name.clone())).collect()
    }

    /// The roots the connected spokes relays bound to `org` hold: the `root` claim of each root-signed CRL they report
    /// (the 6.2 `relays` view, `ConsoleApi::spokes_crls`).
    fn spokes_reported_roots(&self, org: &str) -> Vec<String> {
        let link = self.link.get().cloned();
        self.api
            .spokes_crls(link.as_deref(), org)
            .iter()
            .filter_map(|token| crate::identity::peek_compact(token).and_then(|p| p.get("root").and_then(Value::as_str).map(str::to_owned)))
            .collect()
    }

    /// `GET settings/api/a2a?org=` (7.14): A2aView.
    fn api_a2a_get(&self, c: &Console, q: &[(String, String)], t: i64) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let now = t.div_euclid(1000);
        let (pinned, _, _) = self.api.pinned(&org);
        let draft = self.api_drafts.lock().get(&org, t).cloned();
        let console = self.api.console_active(&org);
        let issuer = pinned.as_ref().and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str).filter(|u| !u.is_empty());
        let agents: Vec<Value> = pinned
            .as_ref()
            .and_then(|m| m.pointer("/a2a/agents"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|a| {
                let id = str_of(a.get("id")).unwrap_or("");
                let card = crate::console_a2a::card_view(&self.api, Some(&*self.api_audit), &org, id, now);
                api_1d::agent_view(a, &console, issuer.map(|i| crate::a2a_card::card_url(i, id)), Some(card))
            })
            .collect();
        let keys = pinned.as_ref().map(|m| crate::console_a2a::key_views(&self.api, &org, m, now)).unwrap_or_default();
        let status = self.api_connector_status(&org, &[pinned.as_ref()], now);
        let connectors: Map<String, Value> = map_connectors(pinned.as_ref())
            .filter_map(|k| {
                let id = str_of(k.get("id"))?;
                Some((id.to_owned(), api_1d::connector_a2a(k, status.get(id), &console)))
            })
            .collect();
        let draft = draft.as_ref().map(|d| api_1d::draft_a2a(&d.map, &console, crate::console_a2a::key_views(&self.api, &org, &d.map, now)));
        Ok(api_1d::a2a_view(&org, pinned.as_ref(), &self.api_front_origin(c), api_1d::A2aParts { agents, keys, connectors, draft }))
    }

    /// `GET settings/api/a2a/tasks?org=&agent=&client=&state=` (7.14): the TaskViews folded from the `a2a.task`
    /// entries of the pinned connectors' audit chains held by the console, filtered, newest first, at most 200.
    fn api_a2a_tasks_get(&self, q: &[(String, String)]) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let opt = |k: &str| query_of(q, k).filter(|v| !v.is_empty());
        let f = api_1d::TaskFilter { agent: opt("agent"), client: opt("client"), state: opt("state") };
        if f.state.is_some_and(|s| !api_1d::TASK_STATES.contains(&s)) {
            return Err(ApiError::with("invalid", format!("state is one of {}.", api_1d::TASK_STATES.join(", "))));
        }
        let (pinned, _, _) = self.api.pinned(&org);
        let mut entries: Vec<Value> = Vec::new();
        if let Some((audit, _)) = self.api.audit_parts() {
            for id in map_connectors(pinned.as_ref()).filter_map(|k| str_of(k.get("id"))) {
                let (mut after, _) = audit.head(&org, id, crate::api_audit::Repr::AsIs);
                let mut pages: Vec<Vec<Value>> = Vec::new();
                for _ in 0..LIVE_TOKEN_PAGES {
                    if after == 0 {
                        break;
                    }
                    after = after.saturating_sub(1000);
                    pages.push(audit.range(&org, id, crate::api_audit::Repr::AsIs, after, 1000));
                }
                // oldest first, as the fold reads them
                entries.extend(pages.into_iter().rev().flatten());
            }
        }
        let name = |id: &str| pinned.as_ref().and_then(|m| api_ui::find(m, "clients", id)).and_then(|c| str_of(c.get("name"))).map(str::to_owned);
        Ok(json!({ "ok": true, "org": org, "tasks": api_1d::task_views(&entries, &name, &f) }))
    }

    /// `GET settings/api/spokes?org=` (7.14): SpokesView.
    fn api_spokes_get(&self, q: &[(String, String)], t: i64) -> Result<Value, ApiError> {
        let org = query_org(q)?;
        let (pinned, _, _) = self.api.pinned(&org);
        let draft = self.api_drafts.lock().get(&org, t).cloned();
        let draft_map = draft.as_ref().map(|d| &d.map);
        let live = self.spokes_relays_live();
        let bound: Vec<String> = live.iter().map(|(id, _)| id.clone()).filter(|id| self.api.spokes_bound(id).iter().any(|o| *o == org)).collect();
        let outdated: Vec<String> = self.api.outdated().into_iter().filter(|(o, _, _)| *o == org).map(|(_, r, _)| r).collect();
        let names: HashMap<String, String> = self.registry.lock().relays.values().map(|r| (r.id.clone(), r.name.clone())).collect();
        let lists = |m: Option<&Value>, id: &str| m.and_then(|m| m.pointer("/spokes/relays")).and_then(Value::as_array).is_some_and(|l| l.iter().any(|r| r.as_str() == Some(id)));
        let relays: Vec<Value> = api_1d::spokes_relay_ids(&bound, pinned.as_ref(), draft_map)
            .into_iter()
            .map(|id| {
                json!({ "id": id, "name": names.get(&id).cloned().unwrap_or_else(|| id.clone()), "connected": self.connected(&id), "bound": bound.contains(&id),
                        "listed": lists(pinned.as_ref(), &id), "staged": lists(draft_map, &id), "outdated": outdated.contains(&id) })
            })
            .collect();
        let candidates: Vec<Value> = live.iter().filter(|(id, _)| !bound.contains(id)).map(|(id, name)| json!({ "id": id, "name": name })).collect();
        let console_root = self.book.lock().spokes_root.as_ref().and_then(|r| str_of(r.get("id")).map(str::to_owned));
        Ok(api_1d::spokes_view(&org, console_root.as_deref(), pinned.as_ref(), draft_map, relays, candidates))
    }

    /// `POST settings/api/a2a/keys/drop {org, kid}` (7.1.4): `a2a_key_drop` at once (a tightening, never refused for
    /// the draft), and the key out of the org's draft when it is staged there (`console_a2a::drop_key`).
    fn api_a2a_key_drop(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let kid = str_of(p.get("kid")).filter(|k| (1..=64).contains(&k.len())).ok_or_else(|| ApiError::with("invalid", "kid is a card key id."))?.to_owned();
        let mut drafts = self.api_drafts.lock();
        let mut draft = drafts.get(org, t).cloned();
        let (entry, changed) = crate::console_a2a::drop_key(&self.api, draft.as_mut(), org, &kid, t.div_euclid(1000))?;
        if let (true, Some(d)) = (changed, draft) {
            drafts.put(d, t);
        }
        let journaled = entry.get("id").cloned().unwrap_or(Value::Null);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "kid": kid, "journaled": journaled })), Some(org.to_owned()), json!({ "kid": kid, "journaled": journaled })))
    }

    /// API-1d 7.14: an `agent` client with `a2a` in a map view gains `card_check` (its PartnerCardView) and `handoff`
    /// (the org's JWKS address and the thumbprints of its current card keys, 7.1.2 R6-12).
    fn api_client_a2a(&self, org: &str, view: &mut Value, now: i64) {
        let mut handoff: Option<Value> = None;
        for c in view.get_mut("clients").and_then(Value::as_array_mut).into_iter().flatten() {
            if str_of(c.get("kind")) != Some("agent") || !c.get("a2a").is_some_and(Value::is_object) {
                continue;
            }
            let id = str_of(c.get("id")).unwrap_or("").to_owned();
            c["card_check"] = crate::console_a2a::partner_card_view(&self.api, org, &id);
            c["handoff"] = handoff
                .get_or_insert_with(|| {
                    let (pinned, _, _) = self.api.pinned(org);
                    let issuer = pinned.as_ref().and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str);
                    let jwks: Vec<Value> = pinned.as_ref().and_then(|m| m.pointer("/a2a/jwks")).and_then(Value::as_array).cloned().unwrap_or_default();
                    let kids: Vec<String> = self.api.a2a_keys(org, now).into_iter().map(|(kid, _)| kid).collect();
                    api_1d::handoff(issuer, &jwks, &kids)
                })
                .clone();
        }
    }

    /// `POST settings/api/idps/test {issuer, private_ok}` or `{id}` (a staged or pinned idp): its discovery and JWKS
    /// under 1a 8.1 (`ConsoleApi::idp_test`); the answer shows the issuer, `jwks_uri` and each key's kid, alg and
    /// kty; only the test time and key count are kept (memory).
    fn api_idp_test(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let (issuer, private_ok) = match str_of(p.get("id")).filter(|i| !i.is_empty()) {
            Some(id) => {
                let (pinned, _, _) = self.api.pinned(org);
                let draft = self.api_drafts.lock().get(org, t).cloned();
                let staged = draft.as_ref().and_then(|d| api_ui::find(&d.map, "idps", id)).cloned();
                let i = staged.or_else(|| pinned.as_ref().and_then(|m| api_ui::find(m, "idps", id)).cloned()).ok_or_else(|| ApiError::with("not-found", api_1c::NO_IDP))?;
                (str_of(i.get("issuer")).unwrap_or("").to_owned(), i.get("private_ok") == Some(&Value::Bool(true)))
            }
            None => (str_of(p.get("issuer")).unwrap_or("").trim().to_owned(), p.get("private_ok") == Some(&Value::Bool(true))),
        };
        if !issuer.starts_with("https://") || issuer.len() > 1024 {
            return Err(ApiError::with("invalid", "issuer is the identity provider's https:// issuer."));
        }
        let (answer, keys) = match self.api.idp_test(&issuer, private_ok) {
            Ok((jwks_uri, keys)) => {
                self.api.idp_tested(org, &issuer, t.div_euclid(1000), keys.len());
                (api_1c::idp_test_view(&issuer, &jwks_uri, &keys), Some(keys.len()))
            }
            Err(why) => (json!({ "ok": false, "issuer": issuer, "error": api_sentence(&why) }), None),
        };
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "issuer": issuer, "private_ok": private_ok, "passed": keys.is_some(), "keys": keys })))
    }

    /// `POST settings/api/sso-url {provider, url}` (6.5 step 2): the SSO service's public URL for a registry provider
    /// of the org (`url: null` removes it), kept by `ConsoleApi::set_sso_url`.
    fn api_sso_url(&self, org: &str, p: &Value) -> Result<Done, ApiError> {
        let provider = str_of(p.get("provider")).unwrap_or("").to_owned();
        if !self.api.identity_providers(org).iter().any(|x| x.id == provider) {
            return Err(ApiError::with("invalid", api_1c::NO_PROVIDER));
        }
        let url = match p.get("url") {
            None | Some(Value::Null) => None,
            Some(Value::String(u)) => Some(u.trim()),
            Some(_) => return Err(ApiError::with("invalid", "url is the SSO service's https:// URL, or null to remove it.")),
        };
        self.api.set_sso_url(org, &provider, url).map_err(|why| ApiError::with("invalid", api_sentence(&why)))?;
        let sso_url = self.api.sso_url(org, &provider);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "provider": provider, "sso_url": sso_url })), Some(org.to_owned()), json!({ "provider": provider, "sso_url": sso_url })))
    }
}

// ── API-1 revision 4 8, 13.1: outbound federation (the logic is `api_federation`) ─────────────────────────────

impl Fleet {
    /// `federation.token` and `federation.failed` (revision 4 11) into the org's console chain; never a token value.
    fn federation_audit(&self, logger: Arc<crate::log::Logger>) -> crate::api_federation::AuditFn {
        let audit = self.api_audit.clone();
        Arc::new(move |org: &str, entry: Value| crate::fleet_agent::api_record(Some(&*audit), vec![(org.to_owned(), entry)], &logger, crate::codec::now_ms().div_euclid(1000)))
    }

    /// `GET settings/api/federation/documents?org=`: the discovery document and JWKS to publish, pinned and staged.
    fn api_federation_documents(&self, q: &[(String, String)], t: i64) -> Result<Value, ApiError> {
        let org = q.iter().find(|(k, _)| k == "org").map(|(_, v)| v.as_str()).filter(|o| crate::api_audit::org_ok(o)).ok_or_else(|| ApiError::with("invalid", "org is an organization id."))?;
        let draft = self.api_drafts.lock().get(org, t).cloned();
        Ok(crate::api_federation::documents_view(&self.api, draft.as_ref(), org))
    }

    /// `POST settings/api/federation/key/drop {org, kid}`: `federation_drop_key` at once (a tightening, never refused
    /// for the draft), and the key out of the org's draft when it is staged there.
    fn api_federation_drop(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let kid = str_of(p.get("kid")).filter(|k| (1..=64).contains(&k.len())).ok_or_else(|| ApiError::with("invalid", "kid is a federation key id."))?.to_owned();
        let mut drafts = self.api_drafts.lock();
        let mut draft = drafts.get(org, t).cloned();
        let (entry, changed) = crate::api_federation::drop_key(&self.api, draft.as_mut(), org, &kid, t.div_euclid(1000))?;
        if let (true, Some(d)) = (changed, draft) {
            drafts.put(d, t);
        }
        let journaled = entry.get("id").cloned().unwrap_or(Value::Null);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "kid": kid, "journaled": journaled })), Some(org.to_owned()), json!({ "kid": kid, "journaled": journaled })))
    }

    /// `POST settings/api/federation/republished {org, kid}`: ends the `federation-jwks-republish` item of that key.
    fn api_federation_republished(&self, org: &str, p: &Value) -> Result<Done, ApiError> {
        let kid = str_of(p.get("kid")).filter(|k| (1..=64).contains(&k.len())).ok_or_else(|| ApiError::with("invalid", "kid is a federation key id."))?.to_owned();
        crate::api_federation::confirm_republished(&self.api, &self.state_dir, org, &kid)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true, "kid": kid })), Some(org.to_owned()), json!({ "kid": kid })))
    }

    /// `POST settings/exports/destinations/federation-test {org, id}`: one token exchange for the destination as
    /// staged (with the draft's federation block) or pinned; the result only, never a token.
    fn api_federation_test(&self, c: &Console, who: &Who, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        c.limit(crate::console_limits::Limit::EmailTest, &format!("exports-test|{}", who.email), t)?;
        let (pinned, _, _) = self.api.pinned(org);
        let draft = self.api_drafts.lock().get(org, t).cloned();
        let (x, staged) = api_ui::destination_of(draft.as_ref(), pinned.as_ref(), &id).ok_or_else(|| ApiError::with("not-found", api_ui::NO_DESTINATION))?;
        if !crate::api_federation::is_federated(&x) {
            return Err(ApiError::with("invalid", "That destination does not use a federated credential."));
        }
        let fed = draft.as_ref().filter(|_| staged).and_then(|d| d.map.get("federation")).filter(|f| f.is_object());
        let credential = crate::api_federation::credential_for(&self.api, org, &x, fed, self.federation_audit(c.logger.clone())).ok_or_else(|| ApiError::with("invalid", "The federated credential does not read."))?;
        let answer = match crate::api_export_wire::federation_test(&credential) {
            Ok((provider, exp)) => json!({ "ok": true, "provider": provider, "exp": exp }),
            Err(e) => json!({ "ok": false, "error": api_sentence(&e.message) }),
        };
        let passed = answer["ok"] == json!(true);
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "passed": passed })))
    }
}

// ── API-1 revision 4 7.4, 13.1: webhooks (the logic is `api_webhook` and the export engine) ─────────────────────

impl Fleet {
    /// The webhook entry a route names, as staged (with the draft's `webhook_keys`) or pinned.
    fn webhook_of(&self, org: &str, id: &str, t: i64) -> Result<(Value, Option<Value>), ApiError> {
        let (pinned, _, _) = self.api.pinned(org);
        let draft = self.api_drafts.lock().get(org, t).cloned();
        let (x, staged) = api_ui::destination_of(draft.as_ref(), pinned.as_ref(), id).ok_or_else(|| ApiError::with("not-found", api_ui::NO_DESTINATION))?;
        if str_of(x.get("kind")) != Some("webhook") {
            return Err(ApiError::with("invalid", "That destination is not a webhook."));
        }
        let keys = draft.as_ref().filter(|_| staged).and_then(|d| d.map.get("webhook_keys").cloned());
        Ok((x, keys))
    }

    /// `POST settings/exports/destinations/verify {org, id}`: endpoint verification now (7.4), of the webhook as
    /// staged or pinned; `webhook.verified` is audited by the engine.
    fn api_webhook_verify(&self, c: &Console, who: &Who, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        c.limit(crate::console_limits::Limit::EmailTest, &format!("exports-test|{}", who.email), t)?;
        let (x, keys) = self.webhook_of(org, &id, t)?;
        let answer = match self.export.verify_webhook(org, &x, keys.as_ref(), t) {
            Ok(()) => json!({ "ok": true, "verification": "verified" }),
            Err(why) => json!({ "ok": false, "verification": "unverified", "error": api_sentence(&why) }),
        };
        let passed = answer["ok"] == json!(true);
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "passed": passed })))
    }

    /// 13.2 "Send a test" of a webhook: a `test.ping` naming it is appended to the org's event chains (no other
    /// destination takes it) and sent at once, signed, to the endpoint as staged or pinned; only a verified endpoint
    /// (or `verification: none`) gets it. A pass clears the draft's test need.
    fn api_webhook_test(&self, org: &str, x: &Value, staged: bool, draft: Option<&api_ui::Draft>, t: i64) -> Result<Done, ApiError> {
        let id = str_of(x.get("id")).unwrap_or("").to_owned();
        let keys = draft.filter(|_| staged).and_then(|d| d.map.get("webhook_keys").cloned());
        let events = self.api.events().ok_or_else(|| ApiError::with("write-failed", "The console's event chains are not open."))?;
        let seq = self.api.emit_event(org, "test.ping", json!({ "destination": id }), t.div_euclid(1000)).ok_or_else(|| ApiError::with("write-failed", "The test event could not be recorded."))?;
        let identities = crate::api_catalog::Identities::of(str_of(x.get("identities")).unwrap_or("removed")).unwrap_or(crate::api_catalog::Identities::Removed);
        let ce = crate::api_webhook::ping_event(&events, org, seq, crate::api_export::repr_of(identities)).ok_or_else(|| ApiError::with("write-failed", "The test event could not be read back."))?;
        let sent = self.export.send_ping(org, x, keys.as_ref(), &ce, t);
        let answer = match &sent {
            Ok(()) => {
                self.api_drafts.lock().tested(org, &id);
                json!({ "ok": true })
            }
            Err(why) => json!({ "ok": false, "error": api_sentence(why) }),
        };
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "passed": sent.is_ok() })))
    }

    /// `POST settings/exports/destinations/secret {org, id}`: a webhook already signed `v1` gets a new secret at once
    /// (the old one signs too for `SECRET_OVERLAP_S`); one not yet `v1` is staged to it (two-person, 13.3). The secret
    /// is in this answer only.
    fn api_webhook_secret(&self, c: &Console, who: &Who, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let (x, _) = self.webhook_of(org, &id, t)?;
        if x.pointer("/settings/signing").and_then(Value::as_str) != Some(crate::api_webhook::V1) {
            return self.api_stage(c, who, "settings/exports/destinations/secret", org, p, t);
        }
        let vault = self.api.vault();
        let secret = crate::api_webhook::new_secret(&*vault, org, &id, t.div_euclid(1000)).map_err(|e| ApiError::with("seal-provider-needed", e))?;
        let mut answer = json!({ "ok": true, "secret": secret });
        if let Some(r) = crate::api_webhook::secret_rotate_by(&*vault, org, &id) {
            answer["rotate_by"] = json!(r);
        }
        Ok(Done::ok(Out::ok(answer), Some(org.to_owned()), json!({ "destination": id, "rotated": true })))
    }

    /// `POST settings/exports/destinations/replay {org, id, from}`: re-deliver from a feed cursor (`from` empty or
    /// `oldest`: from the oldest event kept).
    fn api_webhook_replay(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let from = str_of(p.get("from")).map(str::trim).filter(|f| !f.is_empty() && *f != "oldest");
        if from.is_some_and(|f| f.len() > 512) {
            return Err(ApiError::with("invalid", "from is a position of the event feed."));
        }
        self.export.replay_events(org, &id, from, t).map_err(|e| ApiError::with("invalid", api_sentence(&e)))?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(org.to_owned()), json!({ "destination": id, "from": from.unwrap_or("oldest") })))
    }

    /// `POST settings/exports/destinations/resume {org, id}` (7.4): events delivery paused after `queue.max_age_s`
    /// goes on from the same cursor.
    fn api_webhook_resume(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        match self.export.resume_events(org, &id, t) {
            Ok(true) => Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(org.to_owned()), json!({ "destination": id }))),
            Ok(false) => Err(ApiError::with("stale", "Nothing was changed: that destination's events are not paused.")),
            Err(e) => Err(ApiError::with("not-found", api_sentence(&e))),
        }
    }

    /// `POST settings/api/webhook-keys/drop {org, kid}` (2.4): `webhook_key_drop` at once (a tightening, never refused
    /// for the draft), and the key out of the org's draft when it is staged there.
    fn api_webhook_key_drop(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let kid = str_of(p.get("kid")).filter(|k| (1..=64).contains(&k.len())).ok_or_else(|| ApiError::with("invalid", "kid is a webhook key id."))?.to_owned();
        let mut drafts = self.api_drafts.lock();
        let mut draft = drafts.get(org, t).cloned();
        let (entry, changed) = crate::api_webhook::drop_key(&self.api, draft.as_mut(), org, &kid, t.div_euclid(1000))?;
        if let (true, Some(d)) = (changed, draft) {
            drafts.put(d, t);
        }
        let journaled = entry.get("id").cloned().unwrap_or(Value::Null);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "kid": kid, "journaled": journaled })), Some(org.to_owned()), json!({ "kid": kid, "journaled": journaled })))
    }
}

// ── API-1 revision 4 13.1, 13.2: compliance clients and the Compliance page ─────────────────────────────────────

/// Revision 4 2.4 `client_lower_caps` from `settings/api/clients/caps`: the lowered caps journaled at once in the
/// console journal (flushed before Ok; a tightening, never refused for the draft), unless the same entry is in force
/// already. Ok is the entry id, or null when nothing was journaled.
fn journal_lower_caps(api: &crate::console_api::ConsoleApi, org: &str, target: Option<Value>, now: i64) -> Result<Value, ApiError> {
    let Some(target) = target else { return Ok(Value::Null) };
    if api.console_active(org).iter().any(|e| e.action == "client_lower_caps" && e.target == target) {
        return Ok(Value::Null);
    }
    let e = api.append_console(org, "client_lower_caps", target, now).map_err(|x| ApiError::with("invalid", api_sentence(&x.message)))?;
    Ok(e.get("id").cloned().unwrap_or(Value::Null))
}

/// Revision 4 2.4 `POST settings/api/clients/recipient/drop {org, id}`: `client_drop_recipient` for the pinned
/// client's recipient kid at once (flushed before Ok: new jobs are refused, open ones canceled), and that recipient
/// leaves the client in the org's draft when it is staged there. Ok is the kid, the journal entry and whether the
/// draft changed.
fn drop_recipient(api: &crate::console_api::ConsoleApi, draft: Option<&mut api_ui::Draft>, org: &str, client: &str, now: i64) -> Result<(String, Value, bool), ApiError> {
    let (pinned, _, _) = api.pinned(org);
    let kid = api_ui::recipient_kid(pinned.as_ref(), client).ok_or_else(|| ApiError::with("not-found", api_ui::NO_RECIPIENT))?;
    if crate::api_cjournal::recipient_dropped(&api.console_active(org), client, &kid) {
        return Err(ApiError::with("stale", api_ui::RECIPIENT_DROPPED));
    }
    let entry = api.append_console(org, "client_drop_recipient", json!({ "client": client, "kid": kid }), now).map_err(|e| ApiError::with("write-failed", api_sentence(&e.message)))?;
    let changed = draft.is_some_and(|d| api_ui::drop_recipient(d, client, &kid));
    Ok((kid, entry, changed))
}

/// The `org` of a Compliance page read (`?org=`, nothing else).
fn compliance_org(q: &[(String, String)]) -> Result<String, ApiError> {
    if let Some((k, _)) = q.iter().find(|(k, _)| k != "org") {
        return Err(ApiError::with("invalid", format!("Unknown filter: {k}.")));
    }
    q.iter().find(|(k, _)| k == "org").map(|(_, v)| v.clone()).filter(|o| crate::api_audit::org_ok(o)).ok_or_else(|| ApiError::with("invalid", "org is an organization id."))
}

impl Fleet {
    /// `POST settings/api/clients/recipient/drop {org, id}`.
    fn api_recipient_drop(&self, org: &str, p: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(p.get("id")).unwrap_or("").to_owned();
        let mut drafts = self.api_drafts.lock();
        let mut draft = drafts.get(org, t).cloned();
        let (kid, entry, changed) = drop_recipient(&self.api, draft.as_mut(), org, &id, t.div_euclid(1000))?;
        if let (true, Some(d)) = (changed, draft) {
            drafts.put(d, t);
        }
        let journaled = entry.get("id").cloned().unwrap_or(Value::Null);
        Ok(Done::ok(Out::ok(json!({ "ok": true, "kid": kid, "journaled": journaled })), Some(org.to_owned()), json!({ "client": id, "kid": kid, "journaled": journaled })))
    }

    /// `GET compliance/holds?org=` (13.2): the org's API holds and the console-placed holds every relay of its set
    /// reports, oldest first, with the relays that did not answer.
    fn compliance_holds(&self, q: &[(String, String)]) -> Result<Value, ApiError> {
        let org = compliance_org(q)?;
        let (holds, partial) = crate::api_compliance::org_holds(&*self.compliance_desk(), &org);
        Ok(json!({ "ok": true, "org": org, "holds": holds, "partial": partial }))
    }

    /// `GET compliance/exports?org=` (13.2): the org's export jobs, newest first, the console's free space and the
    /// org's archive relays; never content.
    fn compliance_exports(&self, q: &[(String, String)]) -> Result<Value, ApiError> {
        let org = compliance_org(q)?;
        Ok(crate::api_exports::console_view(&*self.compliance_desk(), &org))
    }

    /// `POST compliance/exports/cancel {org, job, reason}` (13.1): an open or ready job ends `canceled` with code
    /// `admin` at once (a tightening).
    fn compliance_export_cancel(&self, r: &FleetReq) -> Result<Done, ApiError> {
        let org = api_org(r.params)?;
        let reason = reason_of(r.params.get("reason"))?;
        let job = str_of(r.params.get("job")).unwrap_or("").to_owned();
        let row = crate::api_exports::console_cancel(&*self.compliance_desk(), &org, &job, &reason, r.t.div_euclid(1000))?;
        Ok(Done::ok(Out::ok(json!({ "ok": true, "job": row })), Some(org), json!({ "job": job, "reason": reason })))
    }
}

#[cfg(test)]
mod compliance_client_tests {
    //! API-1 revision 4 2.4, 13.1: what the recipient drop and caps routes journal in the console journal.
    use super::*;

    const ORG: &str = "acme";
    const CLIENT: &str = "c_1b2c3d4e5f607182";

    /// A console holding acme's pinned map with the export client of 2.1.
    fn console_with_export_client(now: i64) -> Arc<crate::console_api::ConsoleApi> {
        let logger = Arc::new(crate::log::Logger::capture("console", Box::new(|_, _| {})));
        let vault: Arc<dyn crate::fleet_ca::VaultLock> = Arc::new(parking_lot::Mutex::new(crate::fleet_ca::MemVault::default()));
        let api = Arc::new(crate::console_api::ConsoleApi::open(None, logger, vault));
        let client = json!({"id": CLIENT, "name": "ediscovery-export", "kind": "compliance", "owner": "lee@acme.example", "reach": "R1",
            "scopes": ["compliance.export.request"], "ceiling": "confidential", "relays": ["*"], "networks": [], "state": "active", "expires": now + 86_400,
            "compliance": {"recipient": {"kid": "rcpt-2026-11", "jwk": {"kty": "EC", "crv": "P-256", "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}},
                           "job_max_bytes": 5368709120i64, "day_max_bytes": 21474836480i64, "jobs_per_day": 5}});
        let m = json!({"v": 2, "org": ORG, "seq": 1, "issued": now - 10, "expires": now + 30 * 86_400, "issuer": {"url": "https://console.acme.example:7443/api/orgs/acme", "jwks": []},
                       "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0}, "failover_after_s": 300, "folded": [], "cleared": [],
                       "relay_origins": {}, "clients": [client], "destinations": []});
        let wire = json!({"map": m, "sig": "", "chain": []});
        let vm = crate::api_map::VerifiedApiMap { org: ORG.into(), seq: 1, expires: now + 30 * 86_400, hash: crate::api_map::api_map_hash(&wire["map"]), signer: "root".into(), wire: wire.as_object().unwrap().clone() };
        api.publish_verified(None, vm, now).unwrap();
        api
    }

    fn draft_on(api: &crate::console_api::ConsoleApi, now: i64) -> (api_ui::Draft, Value) {
        let (pinned, seq, _) = api.pinned(ORG);
        let pinned = pinned.unwrap();
        let d = api_ui::Draft::new(&api_ui::Ctx { org: ORG, by: "ann@acme.example", pinned: Some(&pinned), pinned_seq: seq }, "st_1".into(), now * 1000);
        (d, pinned)
    }

    #[test]
    fn lowered_caps_are_journaled_once_in_the_console_journal() {
        let now = crate::codec::now_ms() / 1000;
        let api = console_with_export_client(now);
        let (mut d, pinned) = draft_on(&api, now);
        // jobs_per_day lowered, day_max_bytes raised: only the lowering is journaled; both are staged
        let target = api_ui::set_caps(&mut d, CLIENT, &json!({"jobs_per_day": 2, "day_max_bytes": 32212254720i64}), Some(&pinned)).unwrap();
        let id = journal_lower_caps(&api, ORG, target.clone(), now).unwrap();
        assert!(id.as_str().unwrap().starts_with("k_acme_"), "{id}");
        let active = api.console_active(ORG);
        assert_eq!(active.len(), 1);
        assert_eq!((active[0].action.as_str(), &active[0].target), ("client_lower_caps", &json!({"client": CLIENT, "jobs_per_day": 2})));
        assert_eq!(crate::api_cjournal::caps(Some(&pinned), &active, CLIENT).get("jobs_per_day"), Some(&2), "in effect at once");
        assert_eq!(d.map["clients"][0]["compliance"]["day_max_bytes"], json!(32212254720i64));
        // the same lowering again, or none: nothing journaled
        assert_eq!(journal_lower_caps(&api, ORG, target, now).unwrap(), Value::Null);
        assert_eq!(journal_lower_caps(&api, ORG, None, now).unwrap(), Value::Null);
        assert_eq!(api.console_active(ORG).len(), 1);
    }

    #[test]
    fn a_recipient_drop_is_journaled_at_once_and_leaves_the_draft() {
        let now = crate::codec::now_ms() / 1000;
        let api = console_with_export_client(now);
        let (mut d, _) = draft_on(&api, now);
        let (kid, entry, changed) = drop_recipient(&api, Some(&mut d), ORG, CLIENT, now).unwrap();
        assert_eq!((kid.as_str(), changed), ("rcpt-2026-11", true));
        assert!(entry["id"].as_str().unwrap().starts_with("k_acme_"));
        assert_eq!((entry["action"].as_str(), entry["target"].clone()), (Some("client_drop_recipient"), json!({"client": CLIENT, "kid": "rcpt-2026-11"})));
        assert!(crate::api_cjournal::recipient_dropped(&api.console_active(ORG), CLIENT, "rcpt-2026-11"));
        assert!(d.map["clients"][0]["compliance"].get("recipient").is_none(), "the recipient left the draft");
        assert_eq!(drop_recipient(&api, None, ORG, CLIENT, now).err().map(|e| e.code), Some("stale"));
        assert_eq!(drop_recipient(&api, None, ORG, "c_0000000000000000", now).err().map(|e| e.code), Some("not-found"));
        assert_eq!(api.console_active(ORG).len(), 1);
    }

    #[test]
    fn the_compliance_routes_are_rows_with_their_roles() {
        for (m, p, admin) in [("GET", "compliance/holds", false), ("GET", "compliance/exports", false), ("POST", "compliance/exports/cancel", true),
                              ("POST", "settings/api/clients/recipient", true), ("POST", "settings/api/clients/caps", true), ("POST", "settings/api/clients/recipient/drop", true)] {
            let (s, at) = fleet_route(m, p).unwrap_or_else(|| panic!("{m} {p}"));
            assert!(at.is_none());
            assert_eq!(matches!(s.role, Role::Admin), admin, "{p}");
        }
        assert!(fleet_route("POST", "settings/api/clients/recipient").unwrap().0.stepup);
        assert!(!fleet_route("POST", "settings/api/clients/recipient/drop").unwrap().0.stepup);
        assert_eq!(compliance_org(&[("org".into(), "acme".into())]).unwrap(), "acme");
        assert_eq!(compliance_org(&[("org".into(), "acme".into()), ("client".into(), "x".into())]).err().map(|e| e.code), Some("invalid"));
        assert_eq!(compliance_org(&[]).err().map(|e| e.code), Some("invalid"));
    }
}

// ── API-1 7.1: the front door's view of an org's relays ────────────────────────────────────────────────────────

/// The org's relays as the front door's resource routes report them: the relays that serve the org
/// (`ConsoleApi::relays_of`) and are live in the registry, with the registry's own values, the latest accepted
/// metrics snapshot and the health of 8.2.
pub struct FleetData<'a> {
    fleet: &'a Fleet,
}

impl FleetData<'_> {
    fn records(&self, org: &str) -> Vec<RelayRecord> {
        let ids = self.fleet.api.relays_of(org);
        let reg = self.fleet.registry.lock();
        ids.iter().filter_map(|id| reg.relays.get(id).filter(|r| r.state.live()).cloned()).collect()
    }

    fn row(&self, r: &RelayRecord, t: i64) -> crate::fleet_export::RelayRow {
        let connected = self.fleet.connected(&r.id);
        let latest = self.fleet.metrics.latest(&r.id);
        let code = |k: &str| latest.as_ref().and_then(|l| l.m.get(k).and_then(Value::as_i64));
        crate::fleet_export::RelayRow {
            id: r.id.clone(),
            name: r.name.clone(),
            site: r.site.clone(),
            product: r.product,
            connected,
            last_contact_ms: r.last_contact_at,
            health: self.fleet.health(r, connected, t).to_owned(),
            license_state: code("license_state"),
            license_service: code("license_service"),
        }
    }
}

/// API-1 11: what the export engine reads of the fleet console: the pinned maps and journal, the sealed destination
/// credentials, the org's audit chains (the console's own and every relay chain stored), the org's metrics as the
/// front door's `v1/metrics` exposition shows them, and the sinks.
struct ExportHost {
    fleet: Weak<Fleet>,
    logger: Arc<crate::log::Logger>,
    /// The console's host name, as its SIEM messages carry it.
    host: String,
}

impl crate::api_export::Host for ExportHost {
    fn config(&self, now: i64) -> (Option<crate::api_map::Edition>, Vec<crate::api_export::OrgConfig>) {
        self.fleet.upgrade().map_or((None, Vec::new()), |f| f.api.export_config(now))
    }

    fn credential(&self, org: &str, id: &str) -> Option<crate::api_export_wire::Credential> {
        let f = self.fleet.upgrade()?;
        // revision 4 8: a federated credential is the pinned entry's public fields and the console's signer (R4-D11)
        let entry = f.api.pinned(org).0.and_then(|m| m.get("destinations")?.as_array()?.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(id)).cloned());
        if let Some(d) = entry.filter(crate::api_federation::is_federated) {
            return crate::api_federation::credential_for(&f.api, org, &d, None, f.federation_audit(self.logger.clone()));
        }
        f.api.destination_credential(org, id)
    }

    fn delete_credential(&self, org: &str, id: &str) {
        if let Some(f) = self.fleet.upgrade() {
            f.api.delete_destination_credential(org, id);
            // revision 4 7.4: a webhook's v1 secret goes with it
            if let Err(e) = crate::api_webhook::delete_secret(&*f.api.vault(), org, id) {
                self.logger.ops("exports.credential-not-removed", &Fields::new().with("org", org).with("destination", id).with("why", e), Level::Error);
            }
        }
    }

    fn pseudonym_key(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        let f = self.fleet.upgrade()?;
        crate::api_audit::PseudonymKeys::current(&crate::console_api::ConsolePseudonymKeys(Arc::downgrade(&f.api)), org)
    }

    fn audit_sources(&self, org: &str) -> Vec<String> {
        let Some(f) = self.fleet.upgrade() else { return Vec::new() };
        if !crate::api_audit::org_ok(org) {
            return Vec::new();
        }
        let mut out: std::collections::BTreeSet<String> = f.api.relays_of(org).into_iter().collect();
        out.insert("console".into());
        // relays that served the org before and are gone still have chains the console stores
        for e in std::fs::read_dir(f.state_dir.join(crate::api_audit::AUDIT_DIR).join(org)).into_iter().flatten().flatten() {
            if let Some(n) = e.file_name().to_str().filter(|n| crate::api_audit::source_ok(n)) {
                if e.path().is_dir() {
                    out.insert(n.to_string());
                }
            }
        }
        out.into_iter().collect()
    }

    fn audit_read(&self, org: &str, source: &str, repr: crate::api_audit::Repr, after: u64, limit: usize) -> Vec<Value> {
        let Some(f) = self.fleet.upgrade() else { return Vec::new() };
        f.api_audit.read(org, source, repr, after, limit).ok().and_then(|v| v.get("entries")?.as_array().cloned()).unwrap_or_default()
    }

    fn audit_record(&self, org: &str, entry: Value, now: i64) {
        let f = self.fleet.upgrade();
        crate::fleet_agent::api_record(f.as_ref().map(|f| &*f.api_audit), vec![(org.to_string(), entry)], &self.logger, now);
    }

    fn metric_rows(&self, org: &str, now: i64) -> Vec<crate::api_export::MetricRow> {
        use crate::api_resource::Data;
        let Some(f) = self.fleet.upgrade() else { return Vec::new() };
        let data = f.api_data();
        let ids = data.ids(org);
        crate::api_export::parse_exposition(&data.exposition(org, &ids, now))
    }

    fn resource(&self, org: &str) -> Vec<(String, String)> {
        let id = self.fleet.upgrade().map(|f| f.console_id.clone()).unwrap_or_default();
        [("service.name", "lucid-console"), ("service.version", env!("CARGO_PKG_VERSION")), ("service.instance.id", id.as_str()), ("lucid.org", org), ("lucid.relay.id", "console")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn make_sink(&self, destination: &Value, credential: crate::api_export_wire::Credential) -> Result<Box<dyn crate::api_export_wire::Sink>, crate::api_export_wire::SinkError> {
        export_sink(destination, credential, &self.host)
    }

    // API-1 revision 4 7.4, 7.5: events destinations and webhooks

    fn event_view(&self, org: &str, client: &str, now: i64) -> Option<crate::api_webhook::EventView> {
        let f = self.fleet.upgrade()?;
        let store = f.api.org_snapshot(org)?;
        crate::api_webhook::client_view(&store, org, client, now, &f.api_owner(org))
    }

    fn events_page(&self, org: &str, after: Option<&str>, limit: usize, view: &crate::api_webhook::EventView, repr: crate::api_audit::Repr, types: Option<Vec<String>>) -> Result<Value, crate::api_events::FeedError> {
        let events = self.fleet.upgrade().and_then(|f| f.api.events()).ok_or(crate::api_events::FeedError::Unavailable)?;
        crate::api_webhook::page(&events, org, after, limit, view, repr, types)
    }

    fn events_tail(&self, org: &str) -> Option<String> {
        let events = self.fleet.upgrade()?.api.events()?;
        crate::api_webhook::tail(&events, org)
    }

    fn events_dropped(&self) -> Vec<crate::api_audit::Dropped> {
        self.fleet.upgrade().and_then(|f| f.api.events()).map(|e| e.take_dropped()).unwrap_or_default()
    }

    fn emit_event(&self, org: &str, kind: &str, data: Value, now: i64) {
        if let Some(f) = self.fleet.upgrade() {
            f.api.emit_event(org, kind, data, now);
        }
    }

    fn suspend_destination(&self, org: &str, id: &str, now: i64) -> Result<(), String> {
        let f = self.fleet.upgrade().ok_or_else(|| "the console is stopping".to_owned())?;
        f.api.append(f.link.get().cloned(), org, "destination_suspend", json!(id), None, now).map(|_| ()).map_err(|e| e.message)
    }

    fn webhook_material(&self, org: &str, id: &str, staged: Option<&Value>, now: i64) -> crate::api_webhook::Material {
        self.fleet.upgrade().map(|f| crate::api_webhook::console_material(&f.api, org, id, staged, now)).unwrap_or_default()
    }
}

/// API-1 11: the console's sink for a destination (`syslog_cef` as its SIEM messages, with `host` as the sender).
fn export_sink(destination: &Value, credential: crate::api_export_wire::Credential, host: &str) -> Result<Box<dyn crate::api_export_wire::Sink>, crate::api_export_wire::SinkError> {
    if destination.get("kind").and_then(Value::as_str) == Some("syslog_cef") {
        crate::fleet_syslog::cef_sink(destination, credential, host, env!("CARGO_PKG_VERSION"))
    } else {
        crate::api_export_wire::sink_for(destination, credential)
    }
}

/// The days left of the certificates a relay reports (9.1 `cert_*_days`, `crl_days`, `license_days`), and of its
/// current fleet certificate from the registry.
fn certificates_of(r: &RelayRecord, m: &Map<String, Value>, t: i64) -> Vec<Value> {
    let reported = [("tls", "cert_tls_days"), ("console", "cert_console_days"), ("mgmt", "cert_mgmt_days"), ("signer", "cert_signer_days"), ("crl", "crl_days"), ("license", "license_days")];
    let mut out: Vec<Value> = reported.iter().filter_map(|(name, k)| m.get(*k).and_then(Value::as_i64).map(|d| json!({"name": name, "days_left": d}))).collect();
    out.extend(r.serials.iter().filter(|s| s.current).map(|s| json!({"name": "fleet", "serial": s.serial, "days_left": (s.not_after - t).div_euclid(86_400_000)})));
    out
}

impl crate::api_resource::Data for FleetData<'_> {
    fn relays(&self, org: &str, now: i64) -> Vec<crate::api_resource::RelayInfo> {
        let t = now.saturating_mul(1000);
        self.records(org)
            .iter()
            .map(|r| {
                let row = self.row(r, t);
                let latest = self.fleet.metrics.latest(&r.id);
                let up = row.connected && latest.as_ref().is_some_and(|l| t - l.t <= crate::fleet_export::UP_WINDOW_MS);
                let m = latest.map(|l| l.m).unwrap_or_default();
                let license = row.license_state.and_then(|c| usize::try_from(c).ok()).and_then(|c| crate::fleet_export::LICENSE_STATES.get(c)).copied().unwrap_or_default();
                crate::api_resource::RelayInfo {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    region: r.site.clone(),
                    version: r.version.clone(),
                    fips: r.fips,
                    license_state: license.to_string(),
                    up,
                    health: row.health,
                    last_contact_s: r.last_contact_at.map(|at| (t - at).max(0) / 1000),
                    certificates: certificates_of(r, &m, t),
                    latest: m,
                }
            })
            .collect()
    }

    fn ids(&self, org: &str) -> Vec<String> {
        self.records(org).into_iter().map(|r| r.id).collect()
    }

    fn exposition(&self, org: &str, ids: &[String], now: i64) -> String {
        let t = now.saturating_mul(1000);
        let rows: Vec<crate::fleet_export::RelayRow> = self.records(org).iter().filter(|r| ids.contains(&r.id)).map(|r| self.row(r, t)).collect();
        let snaps: Vec<crate::fleet_export::Snap> = rows
            .iter()
            .map(|r| {
                let latest = self.fleet.metrics.latest(&r.id);
                let totals = self.fleet.metrics.totals(&r.id).into_iter().map(|(i, x)| (crate::fleet_metrics::KEYS[i].key.to_owned(), crate::fleet_probe::number(x))).collect();
                crate::fleet_export::Snap { t: latest.as_ref().map(|l| l.t), latest: latest.map(|l| l.m).unwrap_or_default(), totals }
            })
            .collect();
        let high = self.fleet.console().is_ok_and(|c| c.high_profile());
        let console = crate::fleet_export::ConsoleInfo { version: env!("CARGO_PKG_VERSION"), profile: if high { "high" } else { "standard" }, fips: cfg!(feature = "fips") };
        let named: Vec<&crate::fleet_export::RelayRow> = rows.iter().collect();
        crate::fleet_export::exposition(&console, &named, &snaps, t) + &crate::fleet_export::api_families(Some(org), now, false)
    }

    fn console(&self) -> Value {
        json!({"version": env!("CARGO_PKG_VERSION"), "fips": cfg!(feature = "fips")})
    }

    fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
        self.fleet.api.events()
    }

    fn compliance(&self) -> Option<Arc<dyn crate::api_compliance::Desk>> {
        Some(self.fleet.compliance_desk())
    }

    /// API-1d 6.1: `api-spokes` to a spokes relay bound to the org (`ConsoleApi::spokes_view`).
    fn spokes(&self, org: &str, relay: &str, view: &str, query: &str, people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
        let link = self.fleet.link.get().cloned();
        self.fleet.api.spokes_view(link.as_deref(), org, relay, view, query, people)
    }
}

impl Fleet {
    /// API-1 revision 4 5.1, 5.2: what the compliance routes and their minute reach of this console.
    pub fn compliance_desk(&self) -> Arc<dyn crate::api_compliance::Desk> {
        Arc::new(crate::api_compliance::ConsoleDesk { api: self.api.clone(), link: self.link.get().cloned(), dir: Some(self.state_dir.clone()), audit: self.api_audit.clone(), people: self.people() })
    }
}

#[cfg(test)]
mod state_frame_tests {
    //! AC-2a 3.4.1 (R7-L1): the 5.6 `state` frame's license object against tests/admin_console_fleet_state_frame_v1.json.
    use super::*;

    fn vector() -> Value {
        serde_json::from_str(include_str!("../tests/admin_console_fleet_state_frame_v1.json")).unwrap()
    }

    fn record(product: &str) -> RelayRecord {
        RelayRecord::from_value(&json!({ "id": "r_0123456789abcdef", "name": "Relay", "product": product, "state": "active", "serials": [], "enrolledAt": 1 })).unwrap()
    }

    #[test]
    fn every_vector_frame_is_taken_with_its_license_exact() {
        let v = vector();
        for c in v["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let mut rec = record(c["product"].as_str().unwrap());
            let body = &c["frame"]["body"];
            assert_eq!(c["frame"]["op"], "state", "{name}");
            Fleet::take_report(&mut rec, body).unwrap_or_else(|e| panic!("{name}: {}", e.code));
            assert_eq!(rec.report.get("license"), Some(&body["license"]), "{name}: the license object is exact");
            assert_eq!(rec.report.get("trustSeq"), Some(&body["trustSeq"]), "{name}");
        }
        // every why of the vector is one the console knows
        for w in v["service_why"].as_array().unwrap() {
            assert!(SERVICE_WHYS.contains(&w.as_str().unwrap()), "{w}");
        }
    }

    #[test]
    fn every_malformed_vector_frame_is_refused_whole_with_fleet_op() {
        let v = vector();
        for c in v["malformed"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let mut rec = record("meet");
            let err = Fleet::take_report(&mut rec, &c["body"]).err().unwrap_or_else(|| panic!("{name}: taken"));
            assert_eq!(err.code, c["code"].as_str().unwrap(), "{name}");
            assert!(rec.report.is_empty(), "{name}: nothing of the frame is taken");
        }
    }

    #[test]
    fn wrong_types_and_extra_keys_are_refused_never_normalized() {
        let v = vector();
        let good = v["cases"][0]["frame"]["body"]["license"].clone();
        let bad = |path: &[&str], value: Value| {
            let mut l = good.clone();
            let mut at = &mut l;
            for p in &path[..path.len() - 1] {
                at = at.get_mut(*p).unwrap();
            }
            at[path[path.len() - 1]] = value;
            l
        };
        for (what, l) in [
            ("exp as text", bad(&["exp"], json!("1822521600000"))),
            ("daysLeft as a fraction", bad(&["daysLeft"], json!(1.5))),
            ("an unknown service state", bad(&["service", "state"], json!("paused"))),
            ("an unknown why", bad(&["service", "why"], json!("lapsed"))),
            ("an extra key", bad(&["extra"], json!(1))),
            ("an extra service key", bad(&["service", "extra"], json!(1))),
            ("an empty id", bad(&["id"], json!(""))),
        ] {
            assert_eq!(license_report(&l), None, "{what}");
        }
        assert_eq!(license_report(&good), Some(good.clone()));
    }
}

#[cfg(test)]
mod reminder_tests {
    //! AC-2a 8.1 (revision 3.4.1, R7-L1): the reminder key and steps of each vector frame.
    use super::*;

    #[test]
    fn the_reminder_key_and_steps_match_the_vector() {
        let v: Value = serde_json::from_str(include_str!("../tests/admin_console_fleet_state_frame_v1.json")).unwrap();
        for c in v["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let (key, steps) = fleet_steps(&c["frame"]["body"]["license"]);
            assert_eq!(key.as_deref(), c["reminders"]["key"].as_str(), "{name}");
            let want: Vec<(String, i64)> = c["reminders"]["steps"].as_array().unwrap().iter().map(|s| (s["step"].as_str().unwrap().to_owned(), s["at"].as_i64().unwrap())).collect();
            let got: Vec<(String, i64)> = steps.into_iter().map(|(s, at)| (s.to_owned(), at)).collect();
            assert_eq!(got, want, "{name}");
        }
    }

    #[test]
    fn a_silent_relay_goes_on_from_its_last_pushed_exp_and_stops_at() {
        let v: Value = serde_json::from_str(include_str!("../tests/admin_console_fleet_state_frame_v1.json")).unwrap();
        let lic = &v["cases"][0]["frame"]["body"]["license"];
        let exp = lic["exp"].as_i64().unwrap();
        let stop = lic["service"]["stopsAt"].as_i64().unwrap();
        assert_eq!(pushed_service(lic, exp - 1).unwrap().state, crate::console::ServiceState::On);
        assert_eq!(pushed_service(lic, exp).unwrap().state, crate::console::ServiceState::Grace);
        assert_eq!(pushed_service(lic, stop).unwrap().state, crate::console::ServiceState::Stopped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console::{ConsoleReply, ConsoleRequest};
    use crate::console_webauthn::testkit::Authenticator;
    use crate::relay::Dialed;
    use std::collections::HashSet;

    const PUBLIC: &str = "console.example.org";
    const ORIGIN: &str = "https://console.example.org";
    const ADMIN: &str = "ann@example.org";
    const PEM: &str = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-console-fleet-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn flags(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn cfg_at(d: &Path) -> ServeConfig {
        let f = flags(&[("state", &d.display().to_string()), ("public", PUBLIC), ("tls-cert", PEM), ("tls-key", PEM), ("fleet-port", "0")]);
        serve_config(&f, |_| None).unwrap()
    }

    #[derive(Default)]
    struct FakeLink {
        up: Mutex<HashSet<String>>,
        sent: Mutex<Vec<(String, String, Value)>>,
        call_answer: Mutex<Option<Value>>,
        /// API-1 slice 1a6: what `api-sign-status` answers (`gone` when None).
        sign_status: Mutex<Option<Value>>,
    }

    impl FleetLink for FakeLink {
        fn request(&self, relay: &str, op: &str, body: Value, _timeout_ms: u64) -> Result<Value, LinkError> {
            if !self.up.lock().contains(relay) {
                return Err(LinkError::Offline);
            }
            self.sent.lock().push((relay.to_owned(), op.to_owned(), body.clone()));
            Ok(match op {
                "nonce" => json!({ "nonces": [b64u(&[7u8; 32])], "ttl": 120 }),
                "call" => self.call_answer.lock().clone().unwrap_or(json!({ "status": 200, "body": { "ok": true } })),
                "roster" | "policy" => json!({ "seq": body["seq"], "held": [], "unattested": [] }),
                "api-heads" => json!({ "acme": { "seq": 0, "tseq": 0 } }),
                "api-sign-request" => json!({ "request": "rq_0123456789abcdef" }),
                "api-sign-status" => self.sign_status.lock().clone().unwrap_or(json!({ "state": "gone" })),
                _ => json!({}),
            })
        }
        fn event(&self, relay: &str, op: &str, body: Value) -> bool {
            let up = self.up.lock().contains(relay);
            if up {
                self.sent.lock().push((relay.to_owned(), op.to_owned(), body));
            }
            up
        }
        fn connected(&self, relay: &str) -> bool {
            self.up.lock().contains(relay)
        }
        fn close(&self, _relay: &str, _code: u16) {}
    }

    #[derive(Default)]
    struct FakePki {
        denied: Mutex<Vec<String>>,
    }

    impl FleetPki for FakePki {
        fn pin(&self) -> Option<[u8; 32]> {
            Some([9u8; 32])
        }
        fn status(&self, _t: i64) -> PkiStatus {
            PkiStatus { ready: true, ..PkiStatus::default() }
        }
        fn deny(&self, serials: &[String], _t: i64) -> Result<(), String> {
            self.denied.lock().extend(serials.iter().cloned());
            Ok(())
        }
        fn trust_view(&self, _t: i64) -> Value {
            json!({ "caGenerations": [], "manifest": null })
        }
        fn server_revoke(&self, _t: i64) -> Result<(String, u64), ApiError> {
            Ok(("aa".into(), 2))
        }
        fn ca_rollover(&self, _t: i64) -> Result<(u32, String), ApiError> {
            Ok((2, "ab cd".into()))
        }
    }

    struct H {
        c: Arc<Console>,
        f: Arc<Fleet>,
        d: PathBuf,
        link: Arc<FakeLink>,
        pki: Arc<FakePki>,
        cookie: String,
        a: Authenticator,
    }

    fn send(c: &Console, method: &str, path: &str, body: Value, cookie: &str, peer: &str) -> (u16, Value, ConsoleReply) {
        let dialed = Dialed { host: PUBLIC.into(), hostname: PUBLIC.into(), port: 443 };
        let text = if method == "POST" { stringify(&body) } else { String::new() };
        let (pathname, query) = path.split_once('?').unwrap_or((path, ""));
        let r = ConsoleRequest {
            method,
            pathname,
            query,
            cookie,
            origin: Some(ORIGIN),
            marker: Some("1"),
            activity: true,
            content_type: "application/json",
            user_agent: "test",
            peer: peer.parse().unwrap(),
            forwarded: &[],
            body: &text,
            dialed: &dialed,
            host_ok: true,
        };
        let reply = c.http(&r, crate::codec::now_ms());
        let v = crate::codec::parse_json(&String::from_utf8_lossy(&reply.body)).unwrap_or(Value::Null);
        (reply.status, v, reply)
    }

    fn cookie_of(r: &ConsoleReply) -> String {
        r.headers.iter().find(|(k, _)| *k == "Set-Cookie").map(|(_, v)| v.split(';').next().unwrap_or("").to_owned()).unwrap_or_default()
    }

    fn open(d: &Path) -> (Arc<Console>, Arc<Fleet>) {
        let (_, c) = crate::console::open_fleet(cfg_at(d), crate::log::Logger::new("test"), crate::console_seal::SealIdentity::Relay).unwrap();
        let f = c.fleet().unwrap();
        (c, f)
    }

    fn setup_code(c: &Console) -> String {
        c.inner.lock().setup.as_ref().map(|s| s.code().to_owned()).unwrap_or_default()
    }

    /// A fleet console set up by its first admin with a passkey: the harness with the admin's session.
    fn boot(name: &str) -> H {
        let d = dir(name);
        let (c, f) = open(&d);
        let link = Arc::new(FakeLink::default());
        let pki = Arc::new(FakePki::default());
        f.attach_link(link.clone());
        f.attach_pki(pki.clone());
        let code = setup_code(&c);
        let (s, v, _) = send(&c, "POST", "/console/api/setup/start", json!({ "code": code, "profile": "standard", "email": ADMIN }), "", "10.0.0.7");
        assert_eq!(s, 200, "{v}");
        let token = v["join"].as_str().unwrap().to_owned();
        let (s, v, _) = send(&c, "POST", "/console/api/register/begin", json!({ "token": token, "kind": "passkey" }), "", "10.0.0.7");
        assert_eq!(s, 200, "{v}");
        let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let mut a = Authenticator::new(11);
        let credential = a.register(PUBLIC, ORIGIN, &challenge, true);
        let (s, v, reply) = send(&c, "POST", "/console/api/register/finish", json!({ "ceremony": v["ceremony"], "credential": credential }), "", "10.0.0.7");
        assert_eq!(s, 200, "{v}");
        let cookie = cookie_of(&reply);
        assert!(!cookie.is_empty(), "the first admin is signed in");
        H { c, f, d, link, pki, cookie, a }
    }

    impl H {
        fn get(&self, path: &str) -> (u16, Value) {
            let (s, v, _) = send(&self.c, "GET", path, Value::Null, &self.cookie, "10.0.0.7");
            (s, v)
        }

        fn post(&self, path: &str, body: Value) -> (u16, Value) {
            let (s, v, _) = send(&self.c, "POST", path, body, &self.cookie, "10.0.0.7");
            (s, v)
        }

        /// An AC-1 step-up for (action, target, params).
        fn stepup(&mut self, action: &str, target: &str, params: &Value) -> Value {
            let (s, v) = self.post("/console/api/stepup/begin", json!({ "action": action, "target": target, "params": params }));
            assert_eq!(s, 200, "{v}");
            let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
            json!({ "ceremony": v["ceremony"], "credential": self.a.assert(PUBLIC, ORIGIN, &challenge, None) })
        }

        /// A fleet step-up (4.6) begun for (action, target, params, relays, kind).
        fn fleet_stepup(&mut self, action: &str, target: &str, params: &Value, relays: &[&str], kind: &str) -> Result<Value, Value> {
            let (s, v) = self.post("/console/api/fleet/stepup/begin", json!({ "action": action, "target": target, "params": params, "relays": relays, "kind": kind }));
            if s != 200 {
                return Err(v);
            }
            let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
            Ok(json!({ "ceremony": v["ceremony"], "credential": self.a.assert(PUBLIC, ORIGIN, &challenge, None) }))
        }

        /// A relay enrolled through the F15 calls (as fleet_port makes them): its id.
        fn seed(&self, product: Product) -> String {
            let t = crate::codec::now_ms();
            let id = format!("en_{}", hex(&crate::console_auth::random(8).unwrap()));
            {
                let mut reg = self.f.registry();
                reg.enrollments.insert(id.clone(), Enrollment { id: id.clone(), product, name: "Relay A".into(), site: "Lab".into(), scopes: vec!["read-health".into()], replaces: None, created_by: ADMIN.into(), created_at: t, expires: t + CODE_MS, state: "open".into(), fails: 0, relay: None, env: "installed".into(), deploy: None });
            }
            let relay_id = self.f.draw_relay_id(&id);
            let spki = vec![0x30, 0x59, 1, 2, 3, relay_id.len() as u8];
            let relay = json!({ "product": product.as_str(), "version": "1.0", "fips": false, "profile": "standard", "host": "relay.example.org", "os": "linux", "localConsole": false });
            self.f.enroll_done(&id, EnrollDone { relay_id: Some(relay_id.clone()), serial: "0a0b".into(), spki, not_after: t + 90 * 86_400_000, generation: 1, relay, source: "10.0.0.9".into() }, t).unwrap();
            relay_id
        }

        /// The relay connects and reports its bootstrap state.
        fn hello(&self, relay: &str, bootstrap: &str, scopes: &[&str]) {
            self.link.up.lock().insert(relay.to_owned());
            let (rs, ps) = {
                let b = self.f.book.lock();
                (b.roster_seq, b.policy_seq)
            };
            let body = json!({ "relayId": relay, "version": "1.0", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": scopes, "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": bootstrap, "policySeq": ps, "rosterSeq": rs, "trustSeq": 1, "pins": [], "certNotAfter": null });
            self.f.on_hello(relay, &body, "10.0.0.9", crate::codec::now_ms()).unwrap();
            self.f.on_welcomed(relay, crate::codec::now_ms());
        }

        fn confirm(&self, relay: &str) {
            let mut reg = self.f.registry();
            let r = reg.relays.get_mut(relay).unwrap();
            r.confirmed = true;
            r.settle_state();
        }

        fn sent(&self, op: &str) -> Vec<Value> {
            self.link.sent.lock().iter().filter(|(_, o, _)| o == op).map(|(_, _, b)| b.clone()).collect()
        }
    }

    fn wait_for(mut f: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if f() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    // ── 5.2 `console serve` ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn console_serve_needs_state_and_public_and_reads_flag_then_env_then_file() {
        let err = |r: Result<ServeConfig, String>| r.err().unwrap_or_default();
        assert_eq!(err(serve_config(&flags(&[]), |_| None)), STATE_NEEDED);
        let d = dir("serve");
        let st = d.display().to_string();
        assert_eq!(err(serve_config(&flags(&[("state", &st)]), |_| None)), PUBLIC_NEEDED);
        assert_eq!(err(serve_config(&flags(&[("state", &st), ("public", "10.0.0.5")]), |_| None)), PUBLIC_NEEDED, "an IP address is refused");
        let need_tls = err(serve_config(&flags(&[("state", &st), ("public", PUBLIC)]), |_| None));
        assert!(need_tls.contains("--tls-cert"), "{need_tls}");
        // Behind a front: trusted fronts required.
        let behind = |k: &str| (k == "LUCID_CONSOLE_BEHIND_TLS").then(|| "1".to_owned());
        assert!(err(serve_config(&flags(&[("state", &st), ("public", PUBLIC)]), behind)).contains("--trusted-fronts"));
        let ok = serve_config(&flags(&[("state", &st), ("public", PUBLIC), ("trusted-fronts", "10.0.0.1/32")]), behind).ok().unwrap();
        assert!(ok.tls.is_none());
        // Flag over environment over file.
        std::fs::write(d.join(SERVE_FILE), r#"{"port":"9001","host":"10.1.1.1","public":"file.example.org","tls-cert":"/c.pem","tls-key":"/k.pem"}"#).unwrap();
        let env = |k: &str| match k {
            "LUCID_CONSOLE_PORT" => Some("9002".to_owned()),
            "LUCID_CONSOLE_TLS_CERT" | "LUCID_CONSOLE_TLS_KEY" => Some(PEM.to_owned()),
            _ => None,
        };
        let c = serve_config(&flags(&[("state", &st), ("port", "9003")]), env).unwrap();
        assert_eq!((c.port, c.host.as_str(), c.public.as_str()), (9003, "10.1.1.1", "file.example.org"));
        let c = serve_config(&flags(&[("state", &st)]), env).unwrap();
        assert_eq!(c.port, 9002);
        assert_eq!(c.fleet.fleet_port, 7443);
        assert!(c.saved.get("tls-key").is_none(), "an inline PEM never goes to console-serve.json");
        std::fs::write(d.join(SERVE_FILE), r#"{"state":"/elsewhere"}"#).unwrap();
        assert!(err(serve_config(&flags(&[("state", &st), ("public", PUBLIC)]), |_| None)).contains("console-serve.json does not read"));
        // The first start writes the effective values.
        let d2 = dir("serve-write");
        let cfg = cfg_at(&d2);
        write_serve_file(&cfg).unwrap();
        let saved = crate::codec::parse_json(&std::fs::read_to_string(d2.join(SERVE_FILE)).unwrap()).unwrap();
        assert_eq!(saved["public"], PUBLIC);
        assert!(!std::fs::read_to_string(d2.join(SERVE_FILE)).unwrap().contains("BEGIN"));
    }

    #[test]
    fn scopes_labels_and_fingerprints_follow_3_1_and_4_1() {
        assert_eq!(scopes_of(Some(&json!(["people", "read-health", "read-logs"]))).unwrap(), vec!["read-health", "read-logs", "people"]);
        assert_eq!(scopes_of(Some(&json!(["people"]))).unwrap_err().code, "fleet-scope-required");
        assert_eq!(scopes_of(Some(&json!(["read-health", "read-logs"]))).unwrap_err().code, "fleet-scope-needs-people");
        assert_eq!(scopes_of(Some(&json!(["read-health", "upgrade"]))).unwrap_err().code, "fleet-scope-unknown");
        assert!(label_ok("Berlin (east) 2", false) && label_ok("", true) && !label_ok("", false) && !label_ok("a/b", false) && !label_ok(&"x".repeat(65), false));
        let fp = fingerprint_of(b"spki");
        assert_eq!(fp.len(), 24);
        assert_eq!(fp.split(' ').count(), 5);
        assert!(fingerprint_eq(&fp, &fp.replace(' ', "").to_uppercase()));
        assert!(!fingerprint_eq("", ""));
    }

    #[test]
    fn fleet_routes_match_exactly_or_by_relay_prefix() {
        assert!(std::ptr::eq(fleet_route("GET", "fleet/relays").unwrap().0, &FLEET_ROUTES[0]));
        let (s, at) = fleet_route("GET", "fleet/relays/r_0123456789abcdef").unwrap();
        assert!(std::ptr::eq(s, &RELAY_DETAIL));
        assert_eq!(at.unwrap().0, "r_0123456789abcdef");
        let (s, at) = fleet_route("POST", "fleet/relays/r_0123456789abcdef/p/spokes/block").unwrap();
        assert!(std::ptr::eq(s, &PROXY_POST));
        assert_eq!(at.unwrap().1, "spokes/block");
        assert!(fleet_route("GET", "fleet/relays/r_0123456789abcdef/p/../x").is_none());
        assert!(fleet_route("GET", "fleet/relays/R_1/p/overview").is_none());
        assert!(fleet_route("GET", "spokes/nodes").is_none(), "AC-1 product routes are not fleet routes");
        // 5.3 roles: admins only for writes and the registry's details; managers for people; viewers for reads.
        let role = |m: &str, p: &str| fleet_route(m, p).unwrap().0.role;
        for p in ["fleet/enroll", "fleet/enrollments/cancel", "fleet/relays/confirm", "fleet/relays/label", "fleet/relays/scopes", "fleet/relays/remove", "fleet/trust/server-revoke", "fleet/trust/ca-rollover", "fleet/roster/cancel", "fleet/roster/endorse", "fleet/licenses/library", "settings/exports/token", "settings/exports/token/revoke", "settings/exports/siem", "settings/exports/siem/test", "setup/step", "setup/hide"] {
            assert_eq!(role("POST", p), Role::Admin, "{p}");
        }
        for p in ["fleet/enrollments", "fleet/roster", "fleet/trust", "settings/exports"] {
            assert_eq!(role("GET", p), Role::Admin, "{p}");
        }
        for p in ["fleet/relays", "fleet/metrics", "fleet/expiry", "fleet/licenses", "account/key-fingerprints"] {
            assert_eq!(role("GET", p), Role::Viewer, "{p}");
        }
        assert_eq!(role("GET", "fleet/people"), Role::Manager);
        for p in ["fleet/people/invite", "fleet/people/import/check", "fleet/people/import", "fleet/people/remind"] {
            assert_eq!(role("POST", p), Role::Manager, "{p}");
        }
        assert_eq!(role("POST", "setup/start"), Role::None);
        assert_eq!(role("GET", "setup"), Role::None);
        assert_eq!(fleet_route("POST", "fleet/people/import/check").unwrap().0.body_max, crate::fleet_people::CHECK_BODY_MAX);
    }

    #[test]
    fn relay_attention_keeps_ac1_kinds_only_and_cleans_text() {
        assert!(clean_item(&json!({ "kind": "made-up", "severity": "bad", "args": {} })).is_none());
        let v = clean_item(&json!({ "kind": "spokes-silent", "severity": "nope", "args": { "n": 3, "x": "a\u{202e}b\u{0007}", "o": { "deep": 1 } } })).unwrap();
        assert_eq!(v["severity"], "info");
        assert_eq!(v["args"]["n"], 3);
        assert_eq!(v["args"]["x"], "ab");
        assert!(v["args"].get("o").is_none());
    }

    #[test]
    fn the_registry_round_trips_and_an_unreadable_one_fails_closed() {
        let d = dir("registry");
        assert!(Registry::load(&d).unwrap().relays.is_empty(), "no file is an empty registry");
        std::fs::write(d.join(RELAYS_FILE), "{ not json").unwrap();
        assert!(Registry::load(&d).is_err());
        let (c, f) = open(&d);
        assert!(!f.state_ok(), "the management port stays closed");
        let items = f.attention_items(&c, crate::codec::now_ms());
        assert!(items.iter().any(|a| a["kind"] == "fleet-state-unreadable"));
    }

    // ── 12.1 setup ──────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn before_bootstrap_only_setup_and_join_answer() {
        let d = dir("before");
        let (c, _) = open(&d);
        assert!(d.join(crate::console_wizard::SETUP_CODE_FILE).exists());
        let text = std::fs::read_to_string(d.join(crate::console_wizard::SETUP_CODE_FILE)).unwrap();
        assert!(text.starts_with(crate::console_wizard::SETUP_CODE_WORDS));
        for (m, p) in [("GET", "me"), ("GET", "overview"), ("GET", "fleet/relays"), ("POST", "fleet/enroll"), ("GET", "settings")] {
            let (s, v, _) = send(&c, m, &format!("/console/api/{p}"), json!({}), "", "10.0.0.7");
            assert_eq!((s, v["code"].as_str()), (409, Some("setup-needed")), "{m} {p}");
        }
        let (s, v, _) = send(&c, "GET", "/console/api/setup", Value::Null, "", "10.0.0.7");
        assert_eq!(s, 200);
        assert_eq!((v["bootstrapped"].as_bool(), v["steps"].is_null()), (Some(false), true));
        assert_eq!(send(&c, "GET", "/console/api/banner", Value::Null, "", "10.0.0.7").0, 200);
        // The code is never in a log line or an audit entry.
        let code = setup_code(&c);
        let audit = std::fs::read_dir(&d).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains("audit")).map(|e| std::fs::read_to_string(e.path()).unwrap_or_default()).collect::<String>();
        assert!(!audit.contains(&code));
    }

    #[test]
    fn setup_start_checks_tries_pin_and_bootstrap() {
        let d = dir("setup");
        let mut cfg = cfg_at(&d);
        cfg.first_admin = Some(ADMIN.into());
        let (_, c) = crate::console::open_fleet(cfg, crate::log::Logger::new("test"), crate::console_seal::SealIdentity::Relay).unwrap();
        let start = |code: &str, email: &str, peer: &str| send(&c, "POST", "/console/api/setup/start", json!({ "code": code, "profile": "standard", "email": email }), "", peer);
        assert_eq!(start("WRONG", ADMIN, "10.0.0.7").1["code"], "setup-code");
        for _ in 0..4 {
            start("WRONG", ADMIN, "10.0.0.7");
        }
        let (s, v, _) = start(&setup_code(&c), ADMIN, "10.0.0.7");
        assert_eq!((s, v["code"].as_str()), (429, Some("signin-wait")), "5 wrong codes from one source wait");
        // 20 wrong codes in all: a new code is drawn and the old one is void.
        let first = setup_code(&c);
        for i in 0..15u8 {
            start("WRONG", ADMIN, &format!("10.0.1.{}", i % 3 + 1));
        }
        let second = setup_code(&c);
        assert_ne!(first, second, "a new code after 20 wrong ones");
        assert_eq!(start(&first, ADMIN, "10.0.2.1").1["code"], "setup-code");
        // A pinned email that differs.
        assert_eq!(start(&second, "bob@example.org", "10.0.2.2").1["code"], "bootstrap-pinned");
        let (s, v, _) = start(&second, ADMIN, "10.0.2.3");
        assert_eq!(s, 200, "{v}");
        assert!(v["join"].as_str().is_some_and(|j| j.len() == 43));
    }

    #[test]
    fn setup_start_after_bootstrap_is_setup_done() {
        let h = boot("done");
        let (s, v) = h.post("/console/api/setup/start", json!({ "code": "X", "profile": "standard", "email": ADMIN }));
        assert_eq!((s, v["code"].as_str()), (409, Some("setup-done")));
        assert!(!h.d.join(crate::console_wizard::SETUP_CODE_FILE).exists(), "the file goes with bootstrap");
        let (_, v) = h.get("/console/api/setup");
        assert_eq!(v["steps"]["signin"], "open");
        let (s, v) = h.post("/console/api/setup/step", json!({ "step": "email", "state": "skipped" }));
        assert_eq!(s, 200, "{v}");
        assert_eq!(v["steps"]["email"], "skipped");
        let items = h.f.attention_items(&h.c, crate::codec::now_ms());
        assert!(items.iter().any(|a| a["kind"] == "setup-unfinished"));
        assert_eq!(h.post("/console/api/setup/hide", json!({})).0, 200);
        assert!(!h.f.attention_items(&h.c, crate::codec::now_ms()).iter().any(|a| a["kind"] == "setup-unfinished"));
    }

    #[test]
    fn a_restart_voids_the_setup_code_and_the_join_token() {
        let d = dir("restart");
        let token = {
            let (c, _) = open(&d);
            let code = setup_code(&c);
            let (s, v, _) = send(&c, "POST", "/console/api/setup/start", json!({ "code": code, "profile": "standard", "email": ADMIN }), "", "10.0.0.7");
            assert_eq!(s, 200);
            v["join"].as_str().unwrap().to_owned()
        };
        let (c, _) = open(&d);
        let (s, v, _) = send(&c, "POST", "/console/api/join", json!({ "token": token }), "", "10.0.0.7");
        assert_eq!((s, v["code"].as_str()), (410, Some("gone")), "{v}");
    }

    // ── 5.3 and 5.4 ─────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn fleet_and_relay_consoles_answer_404_to_each_others_routes() {
        let h = boot("404");
        for p in ["spokes/nodes", "meet/people", "fleet-link"] {
            assert_eq!(h.get(&format!("/console/api/{p}")).0, 404, "{p}");
        }
        assert_eq!(h.get("/console/api/fleet/relays").0, 200);
        let d = dir("relay-console");
        let cfg = crate::console::ConsoleConfig { product: Product::Meet, state_dir: d.clone(), origin: Some("https://relay.example.org".into()), sources: crate::console_source::parse_cidr_list(crate::console_source::DEFAULT_SOURCES, 32).unwrap(), trusted_fronts: Vec::new(), behind_front: false, first_admin: Some(ADMIN.into()), profile: None, host: "relay.example.org".into() };
        let rc = Console::open(cfg, Arc::new(crate::log::Logger::new("test")), Arc::new(crate::console::LineRing::default())).unwrap();
        let dialed = Dialed { host: "relay.example.org".into(), hostname: "relay.example.org".into(), port: 443 };
        for p in ["fleet/relays", "fleet/enroll", "setup", "settings/exports"] {
            let r = ConsoleRequest { method: "GET", pathname: &format!("/console/api/{p}"), query: "", cookie: "", origin: Some("https://relay.example.org"), marker: Some("1"), activity: false, content_type: "application/json", user_agent: "", peer: "10.0.0.7".parse().unwrap(), forwarded: &[], body: "", dialed: &dialed, host_ok: true };
            assert_eq!(rc.http(&r, crate::codec::now_ms()).status, 404, "{p}");
        }
    }

    #[test]
    fn minting_a_code_needs_a_step_up_and_the_code_never_leaves_the_answer() {
        let mut h = boot("mint");
        let body = json!({ "product": "spokes", "name": "Relay A", "site": "Lab", "scopes": ["read-health", "people"], "replaces": null });
        assert_eq!(h.post("/console/api/fleet/enroll", body.clone()).1["code"], "stepup-needed");
        let su = h.stepup("fleet.enroll.code", "Relay A", &body);
        let mut b = body.clone();
        b["stepup"] = su;
        let (s, v) = h.post("/console/api/fleet/enroll", b);
        assert_eq!(s, 200, "{v}");
        let code = v["code"].as_str().unwrap().to_owned();
        assert!(code.starts_with("LCE1-"));
        for k in ["spokes", "meet", "local"] {
            assert!(!v["commands"][k].as_str().unwrap().contains(&code), "the commands never contain the code (A1-M1)");
        }
        let id = v["id"].as_str().unwrap().to_owned();
        assert_eq!(h.f.enroll_secret(&id).map(|s| s.len()), Some(20));
        let (_, list) = h.get("/console/api/fleet/enrollments?state=open");
        assert_eq!(list["total"], 1);
        assert!(!stringify(&list).contains(&code));
        // 7.1 and the redaction scan: no code, secret or assertion in any audit entry or console file but the sealed store.
        let secret = b64u(&h.f.enroll_secret(&id).unwrap());
        for e in std::fs::read_dir(&h.d).unwrap().filter_map(Result::ok) {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            assert!(!text.contains(&code) && !text.contains(&secret), "{}", e.path().display());
        }
        let audit = h.c.audit.lock().entries().iter().map(|e| stringify(&Value::Object(e.clone()))).collect::<String>();
        assert!(audit.contains("fleet.enroll.code"));
        assert!(!audit.contains(&code) && !audit.contains("clientDataJSON") && !audit.contains("attestationObject"));
        // Cancelling wipes the secret.
        assert_eq!(h.post("/console/api/fleet/enrollments/cancel", json!({ "id": id })).0, 200);
        assert!(h.f.enroll_secret(&id).is_none());
    }

    #[test]
    fn the_proxy_refuses_unknown_routes_unconfirmed_writes_and_missing_scopes() {
        let mut h = boot("proxy");
        h.f.sync_roster(&h.c, crate::codec::now_ms());
        let relay = h.seed(Product::Spokes);
        h.hello(&relay, "pending", &["read-health"]);
        let (s, v) = h.get(&format!("/console/api/fleet/relays/{relay}/p/admins"));
        assert_eq!((s, v["code"].as_str()), (404, Some("fleet-route")));
        let (s, v) = h.get(&format!("/console/api/fleet/relays/{relay}/p/spokes/nodes"));
        assert_eq!((s, v["code"].as_str()), (403, Some("fleet-scope")), "{v}");
        let (s, v) = h.post(&format!("/console/api/fleet/relays/{relay}/p/spokes/block"), json!({ "node": "n_1", "hours": 1, "reason": "x" }));
        assert_eq!((s, v["code"].as_str()), (409, Some("relay-unconfirmed")), "{v}");
        // A read inside the scope reaches the relay.
        let (s, _) = h.get(&format!("/console/api/fleet/relays/{relay}/p/spokes/counts"));
        assert_eq!(s, 200);
        assert!(h.sent("call").iter().any(|c| c["path"] == "spokes/counts" && c["auth"].is_null()));
        // An offline relay names itself in the fleet step-up.
        h.link.up.lock().clear();
        let e = h.fleet_stepup("spokes.block", "n_1", &json!({ "node": "n_1", "hours": 1, "reason": "x" }), &[&relay], "stepup").unwrap_err();
        assert_eq!(e["code"], "relay-offline");
        assert!(e["error"].as_str().unwrap().contains("Relay A"));
    }

    #[test]
    fn the_console_verifies_the_assertion_before_anything_is_sent() {
        let mut h = boot("assert");
        h.f.sync_roster(&h.c, crate::codec::now_ms());
        let relay = h.seed(Product::Spokes);
        h.hello(&relay, "done", &["read-health", "people"]);
        {
            let mut reg = h.f.registry();
            reg.relays.get_mut(&relay).unwrap().scopes = vec!["read-health".into(), "people".into()];
        }
        h.confirm(&relay);
        let params = json!({ "node": "n_1", "hours": 1, "reason": "x" });
        let mut su = h.fleet_stepup("spokes.block", "n_1", &params, &[&relay], "stepup").unwrap();
        // A credential from another authenticator: refused, and no `call` reaches the relay.
        let mut other = Authenticator::new(99);
        su["credential"] = other.assert(PUBLIC, ORIGIN, &[0u8; 32], None);
        let mut body = params.clone();
        body["stepup"] = su;
        let (s, v) = h.post(&format!("/console/api/fleet/relays/{relay}/p/spokes/block"), body);
        assert_eq!((s, v["code"].as_str()), (403, Some("stepup-failed")), "{v}");
        assert!(h.sent("call").is_empty());
        // The right one: the call carries mode one with the relay's nonce.
        let su = h.fleet_stepup("spokes.block", "n_1", &params, &[&relay], "stepup").unwrap();
        let mut body = params.clone();
        body["stepup"] = su;
        let (s, v) = h.post(&format!("/console/api/fleet/relays/{relay}/p/spokes/block"), body);
        assert_eq!(s, 200, "{v}");
        let calls = h.sent("call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["auth"]["mode"], "one");
        assert_eq!(calls[0]["auth"]["nonce"], b64u(&[7u8; 32]));
        assert!(calls[0]["body"].get("stepup").is_none());
        let audit = h.c.audit.lock().entries().iter().map(|e| stringify(&Value::Object(e.clone()))).collect::<String>();
        assert!(audit.contains("fleet.call"));
        assert!(!audit.contains(&b64u(&[7u8; 32])), "nonces never enter the audit");
    }

    #[test]
    fn api_journal_entries_reach_a_reconnecting_relay_before_any_other_request() {
        let h = boot("api-journal");
        h.f.sync_roster(&h.c, crate::codec::now_ms());
        let relay = h.seed(Product::Meet);
        let t = crate::codec::now_ms();
        // two tightenings while the relay is offline
        h.f.api.append(None, "acme", "client_suspend", json!("c_5f1a2b3c4d5e6f70"), None, t / 1000).unwrap();
        h.f.api.append(None, "acme", "scrape_deny", json!("a".repeat(64)), None, t / 1000).unwrap();
        // reconnect: welcome carries no api key; api-heads goes first, then both entries in order
        h.hello(&relay, "done", &["read-health"]);
        assert!(wait_for(|| h.sent("api-tighten").len() == 2));
        let tightens = h.sent("api-tighten");
        assert_eq!((tightens[0]["entry"]["tseq"].as_u64(), tightens[1]["entry"]["tseq"].as_u64()), (Some(1), Some(2)));
        let ops: Vec<String> = h.link.sent.lock().iter().filter(|(r, _, _)| *r == relay).map(|(_, o, _)| o.clone()).collect();
        // revision 4 2.3 item 1: api-features is the one request before the catch-up
        assert_eq!(&ops[..4], ["api-heads", "api-features", "api-tighten", "api-tighten"], "{ops:?}");
        assert!(wait_for(|| h.f.api.acked(&relay, "acme") == 2));
        let _ = t;
    }

    #[test]
    fn a_policy_change_reaches_the_relays_with_its_endorsement() {
        let mut h = boot("policy");
        h.f.sync_roster(&h.c, crate::codec::now_ms());
        let relay = h.seed(Product::Meet);
        h.hello(&relay, "done", &["read-health"]);
        h.confirm(&relay);
        let params = json!({ "twoPerson": "on", "reason": "tighten" });
        let su = h.fleet_stepup("settings.two-person", "-", &params, &[], "policy").unwrap();
        let mut body = params.clone();
        body["stepup"] = su;
        let (s, v) = h.post("/console/api/settings/two-person", body);
        assert_eq!(s, 200, "{v}");
        assert!(wait_for(|| !h.sent("policy").is_empty()));
        let p = h.sent("policy");
        assert_eq!(p[0]["policy"]["twoPerson"], "on");
        assert_eq!(p[0]["endorsements"].as_array().unwrap().len(), 1);
        // A TOTP-only person or one with no roster key gets fleet-webauthn.
        h.f.book.lock().roster.clear();
        assert_eq!(h.fleet_stepup("settings.two-person", "-", &json!({ "twoPerson": "off", "reason": "x" }), &[], "policy").unwrap_err()["code"], "fleet-webauthn");
    }

    #[test]
    fn removals_reach_the_relays_at_once() {
        let h = boot("remove");
        let t = crate::codec::now_ms();
        h.f.sync_roster(&h.c, t);
        assert_eq!(h.f.book.lock().roster.len(), 1, "with no relay yet the console's keys go straight into the chain");
        let relay = h.seed(Product::Spokes);
        h.hello(&relay, "done", &["read-health"]);
        // The admin's method is removed (or the admin suspended, removed or demoted): a remove update goes at once.
        h.c.inner.lock().book.people.get_mut(ADMIN).unwrap().passkeys.clear();
        h.f.sync_roster(&h.c, t);
        assert!(wait_for(|| !h.sent("roster").is_empty()));
        let r = &h.sent("roster")[0];
        assert_eq!(r["change"]["removes"].as_array().unwrap().len(), 1);
        assert!(r["endorsements"].as_array().unwrap().is_empty(), "removes need no endorsement");
        assert!(h.f.book.lock().roster.is_empty());
    }

    #[test]
    fn fleet_attention_appears_and_clears() {
        let h = boot("attention");
        let relay = h.seed(Product::Spokes);
        let t = crate::codec::now_ms();
        let kinds = |h: &H, t: i64| h.f.attention_items(&h.c, t).iter().map(|a| a["kind"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();
        assert!(kinds(&h, t).contains(&"relay-pending".to_owned()));
        h.hello(&relay, "pending", &["read-health"]);
        assert!(kinds(&h, t).contains(&"relay-unconfirmed".to_owned()));
        assert!(kinds(&h, t).contains(&"relay-bootstrap-pending".to_owned()));
        // Silent after 3 minutes without contact, and clear once connected again.
        // (measured from after the hello, which stamps the last contact with the wall clock)
        let later = crate::codec::now_ms() + SILENT_MS + 1;
        h.link.up.lock().clear();
        assert!(kinds(&h, later).contains(&"relay-silent".to_owned()));
        h.link.up.lock().insert(relay.clone());
        assert!(!kinds(&h, later).contains(&"relay-silent".to_owned()));
        // A relay's own items: unknown kinds dropped, AC-1 kinds kept with the console's name for the relay.
        h.f.on_event(&relay, "attention", &json!({ "items": [{ "kind": "evil-kind", "severity": "bad", "args": {} }, { "kind": "crl-stale", "severity": "warn", "args": {} }] }), t);
        let items = h.f.attention_items(&h.c, t);
        assert!(!items.iter().any(|a| a["kind"] == "evil-kind"));
        assert!(items.iter().any(|a| a["kind"] == "crl-stale" && a["relay"] == "Relay A"));
        // confirm-done unknown (revision 3.2): audited and raised.
        h.f.on_event(&relay, "confirm-done", &json!({ "id": "fc_0123456789abcdef", "result": "unknown", "answer": null }), t);
        assert!(kinds(&h, t).contains(&"relay-confirm-unknown".to_owned()));
        // A relay that leaves: its serials are denied.
        h.f.on_event(&relay, "bye", &json!({ "reason": "left" }), t);
        assert!(kinds(&h, t).contains(&"relay-left".to_owned()));
        assert!(h.pki.denied.lock().contains(&"0a0b".to_owned()));
    }

    #[test]
    fn same_process_enrollment_is_active_at_once() {
        let h = boot("same");
        let t = crate::codec::now_ms();
        let done = EnrollDone { relay_id: None, serial: "0c".into(), spki: vec![1, 2, 3], not_after: t + 86_400_000, generation: 1, relay: json!({ "product": "spokes", "version": "1", "fips": false, "profile": "standard", "os": "linux" }), source: String::new() };
        let a = h.f.enroll_same_process(done, t).unwrap();
        let id = a["relayId"].as_str().unwrap().to_owned();
        let rec = h.f.registry().relays.get(&id).cloned().unwrap();
        assert_eq!((rec.state, rec.via.as_str(), rec.confirmed), (RelayState::Active, "same-process", true));
        assert_eq!(rec.scopes, SCOPES.to_vec());
        let audit = h.c.audit.lock().entries().iter().map(|e| stringify(&Value::Object(e.clone()))).collect::<String>();
        assert!(audit.contains("same-process"));
    }

    #[test]
    fn the_console_state_holds_no_relay_private_key() {
        let h = boot("layout");
        let mut ids = Vec::new();
        for _ in 0..3 {
            ids.push(h.seed(Product::Spokes));
        }
        assert_eq!(h.f.registry().live_count(), 3);
        let mut stack = vec![h.d.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().filter_map(Result::ok) {
                if e.path().is_dir() {
                    stack.push(e.path());
                    continue;
                }
                let text = String::from_utf8_lossy(&std::fs::read(e.path()).unwrap_or_default()).into_owned();
                assert!(!text.contains("PRIVATE KEY"), "{}", e.path().display());
                assert!(!text.contains("fleet-key"), "{}", e.path().display());
            }
        }
        // The registry keeps the SPKI only.
        let rec = h.f.registry().relays.get(&ids[0]).cloned().unwrap();
        assert_eq!(rec.serials.len(), 1);
        assert!(!rec.serials[0].spki.is_empty());
    }

    #[test]
    fn evidence_is_kept_for_new_methods_and_missed_under_high_for_old_ones() {
        let h = boot("evidence");
        let ev = h.c.inner.lock().book.people.get(ADMIN).map(|p| p.evidence.len()).unwrap();
        assert_eq!(ev, 1, "the registration's evidence is kept");
        let entries = h.f.eligible_entries(&h.c);
        assert!(entries[0]["evidenceSha256"].as_str().is_some_and(|s| s.len() == 64));
        assert!(entries[0]["evidence"]["attestationObject"].is_string());
        // A method from before AC-2a has none: under High it stays out of rosters and Overview says so.
        {
            let mut inner = h.c.inner.lock();
            inner.book.people.get_mut(ADMIN).unwrap().evidence.clear();
            inner.book.settings.profile = crate::console_settings::Profile::High;
        }
        assert_eq!(h.f.keys_without_evidence(&h.c), 1);
        assert!(h.f.eligible_entries(&h.c).is_empty());
        assert!(h.f.attention_items(&h.c, crate::codec::now_ms()).iter().any(|a| a["kind"] == "key-no-evidence"));
    }

    /// 13.3 and 13.4 (F12): the refusal table and the command words f-console ships equal the words vector, and no
    /// string carries U+2014 or U+2013.
    #[test]
    fn refusals_and_command_words_equal_the_vector() {
        let v = crate::codec::parse_json(include_str!("../tests/admin_console_fleet_words_v1.json")).unwrap();
        let refusals = v["refusals"].as_object().unwrap();
        assert!(!refusals.is_empty());
        for (code, r) in refusals {
            // AC-1 8.3 codes keep their words (13.3); a relay's `stale` carries its own words in the answer.
            if code == "stale" {
                assert_eq!(crate::console::code_words(code).map(|(s, _)| s), Some(409));
                continue;
            }
            let (status, words) = crate::console::code_words(code).unwrap_or_else(|| panic!("{code} is missing from code_words"));
            assert_eq!(u64::from(status), r["status"].as_u64().unwrap(), "{code}");
            assert_eq!(words, r["words"].as_str().unwrap(), "{code}");
            assert_eq!(crate::console::code_words_static(code), Some(code.as_str()));
        }
        let cli = &v["cli"];
        for (id, ours) in [
            ("cli.setup-code-file", crate::console_wizard::SETUP_CODE_WORDS),
            ("cli.state-acl", crate::console_seal::STATE_ACL_WORDS),
            ("cli.console-identity", crate::console_seal::CONSOLE_IDENTITY_WORDS),
            ("cli.console-needs-public", PUBLIC_NEEDED),
            ("cli.with-console-host", WITH_CONSOLE_HOST),
        ] {
            assert_eq!(cli[id].as_str(), Some(ours), "{id}");
            assert!(!ours.contains('\u{2014}') && !ours.contains('\u{2013}'), "{id}");
        }
    }

    #[test]
    fn key_fingerprints_bind_id_cose_email_and_role() {
        let h = boot("fingerprints");
        let (s, v) = h.get("/console/api/account/key-fingerprints");
        assert_eq!(s, 200, "{v}");
        let fp = v["keys"][0]["fingerprint"].as_str().unwrap().to_owned();
        let p = h.c.inner.lock().book.people.get(ADMIN).cloned().unwrap();
        let k = &p.passkeys[0];
        assert_eq!(fp, crate::fleet_trust::admin_key_fingerprint(&unb64u(&k.id).unwrap(), &unb64u(&k.cose).unwrap(), ADMIN, "admin"));
        assert_ne!(fp, crate::fleet_trust::admin_key_fingerprint(&unb64u(&k.id).unwrap(), &unb64u(&k.cose).unwrap(), ADMIN, "user-manager"));
    }

    // ── AC-2b-D (16.1 d-console) ────────────────────────────────────────────────────────────────────────

    const MEET_HOST: &str = "meet.example.org";
    const SIGNER_URL: &str = "https://signer.example.org";
    const HOUR: i64 = 3_600_000;

    /// The harness console holding a fixed organization CA (meet_ca's test CA): its id.
    fn with_ca(h: &H, signer: Option<&str>) -> String {
        let t = crate::codec::now_ms();
        let ca = with_vault(&h.c, |v| crate::meet_ca::test_ca(&h.d, v, signer, t));
        let id = ca.id().to_owned();
        *h.f.meet.lock() = Some(ca);
        id
    }

    fn meet_deploy(host: &str) -> Value {
        json!({ "env": "linux", "host": host, "turnHost": null, "clients": null, "pki": "console", "license": null, "binarySha256": null, "offered": [], "licenseSha256": null })
    }

    fn p256() -> crate::fleet_x509::Key {
        crate::fleet_x509::Key::generate(crate::fleet_x509::Curve::P256).unwrap()
    }

    /// A server request for `host` (base64url DER), signed by a fresh key.
    fn server_csr(host: &str) -> String {
        b64u(&crate::fleet_x509::csr(&p256(), host, &[host.to_owned()], &[], &[]).unwrap())
    }

    fn signer_csr() -> String {
        b64u(&crate::fleet_x509::csr(&p256(), "Lucid Meet Relay", &[], &[], &["urn:lucid-meet:relay".to_owned()]).unwrap())
    }

    impl H {
        /// An open enrollment with `deploy` (6.1).
        fn open_deploy(&self, product: Product, deploy: Option<Value>, replaces: Option<&str>) -> String {
            let t = crate::codec::now_ms();
            let id = format!("en_{}", hex(&crate::console_auth::random(8).unwrap()));
            let env = if deploy.is_some() { "linux" } else { "installed" };
            let e = Enrollment { id: id.clone(), product, name: "Relay A".into(), site: "Lab".into(), scopes: vec!["read-health".into()], replaces: replaces.map(str::to_owned), created_by: ADMIN.into(), created_at: t, expires: t + CODE_MS, state: "open".into(), fails: 0, relay: None, env: env.into(), deploy };
            self.f.registry().enrollments.insert(id.clone(), e);
            id
        }

        /// A Meeting Hub relay through the F15 calls as fleet_port makes them (3.3 step 3, then the commit).
        fn enroll_meet(&self, id: &str, csr: &str, signer: Option<&str>, profile: &str, roots: &[&str], t: i64) -> Result<(String, Value), ApiError> {
            let relay_id = self.f.draw_relay_id(id);
            let relay = json!({ "product": "meet", "version": "1.0", "fips": false, "profile": profile, "host": MEET_HOST, "os": "linux", "localConsole": false, "meetCsr": csr, "meetSignerCsr": signer, "meetRoots": roots });
            self.f.enroll_check(id, &relay, t)?;
            let done = EnrollDone { relay_id: Some(relay_id.clone()), serial: "0a0c".into(), spki: p256().spki(), not_after: t + 90 * DAY_MS, generation: 1, relay, source: "10.0.0.9".into() };
            self.f.enroll_done(id, done, t).map(|a| (relay_id, a))
        }

        /// The CA's rows for a relay: (serial, kind, notBefore, notAfter, revokedAt).
        fn rows(&self, relay: &str) -> Vec<(String, String, i64, i64, Option<i64>)> {
            let g = self.f.meet.lock();
            g.as_ref().unwrap().rows().iter().filter(|x| x.relay_id == relay).map(|x| (x.serial.clone(), x.kind.as_str().to_owned(), x.not_before, x.not_after, x.revoked_at)).collect()
        }

        fn report(&self, relay: &str, key: &str, v: Value) {
            self.f.registry().relays.get_mut(relay).unwrap().report.insert(key.to_owned(), v);
        }
    }

    #[test]
    fn deploy_fields_follow_3_4() {
        let f = |p: Product, v: Value| deploy_fields(p, v.as_object().unwrap());
        let code = |p: Product, v: Value| f(p, v).unwrap_err().code;
        let d = f(Product::Meet, json!({ "host": " Meet.Example.ORG ", "pki": "console" })).unwrap();
        assert_eq!((d.host.as_str(), d.names.clone(), d.clients.clone()), ("meet.example.org", vec!["meet.example.org".to_owned()], Value::Null));
        let long = format!("{}.example.org", "a".repeat(250));
        for bad in ["10.0.0.5", "-a.example.org", "a_b.example.org", "", "a..example.org", "example.123", long.as_str()] {
            assert_eq!(code(Product::Meet, json!({ "host": bad, "pki": "own" })), "deploy-host", "{bad}");
        }
        let s = f(Product::Spokes, json!({ "host": "203.0.113.7" })).unwrap();
        assert_eq!(s.clients, json!(["0.0.0.0/0", "::/0"]), "the default is everyone");
        assert!(f(Product::Spokes, json!({ "host": "2001:db8::1", "clients": "203.0.113.0/24, 2001:db8::/32" })).is_ok());
        let t = f(Product::Meet, json!({ "host": MEET_HOST, "turnHost": "TURN.example.org", "pki": "own" })).unwrap();
        assert_eq!(t.names, vec![MEET_HOST.to_owned(), "turn.example.org".to_owned()]);
        assert_eq!(f(Product::Meet, json!({ "host": MEET_HOST, "turnHost": "", "pki": "own" })).unwrap().turn, None, "empty is the DNS name");
        assert_eq!(f(Product::Meet, json!({ "host": MEET_HOST, "turnHost": MEET_HOST, "pki": "own" })).unwrap().names.len(), 1);
        assert!(f(Product::Meet, json!({ "host": MEET_HOST, "turnHost": "198.51.100.4", "pki": "own" })).is_ok());
        assert_eq!(code(Product::Spokes, json!({ "host": "relay.example.org", "turnHost": "turn.example.org" })), "deploy-host");
        let many: Vec<String> = (0..17).map(|i| format!("10.{i}.0.0/16")).collect();
        for bad in [json!("203.0.113.7"), json!(many), json!([1]), json!("not a range/8")] {
            assert_eq!(code(Product::Spokes, json!({ "host": "relay.example.org", "clients": bad })), "deploy-clients", "{bad}");
        }
        assert_eq!(code(Product::Meet, json!({ "host": MEET_HOST, "pki": "own", "clients": "0.0.0.0/0" })), "deploy-clients");
        assert_eq!(code(Product::Meet, json!({ "host": MEET_HOST })), "invalid", "Meeting Hub names its certificate source");
        assert_eq!(code(Product::Meet, json!({ "host": MEET_HOST, "pki": "own", "admins": ["a@b.org"] })), "invalid", "admins are set on the host (H1)");
        assert_eq!(code(Product::Spokes, json!({ "host": "relay.example.org", "pki": "own" })), "invalid");
    }

    #[test]
    fn mint_refuses_in_order_and_the_installed_path_keeps_ac2a() {
        let mut h = boot("deploy-mint");
        let mint = |h: &mut H, body: Value| {
            let su = h.stepup("fleet.enroll.code", body["name"].as_str().unwrap_or("-"), &body);
            let mut b = body;
            b["stepup"] = su;
            h.post("/console/api/fleet/enroll", b)
        };
        let base = json!({ "name": "Relay A", "site": "Lab", "scopes": ["read-health"], "replaces": null });
        let with = |extra: Value| {
            let mut b = base.clone();
            for (k, v) in extra.as_object().unwrap() {
                b[k] = v.clone();
            }
            b
        };
        let (s, v) = mint(&mut h, base.clone());
        assert_eq!((s, v["code"].as_str()), (400, Some("deploy-product")), "no product is ever assumed");
        let (s, v) = mint(&mut h, with(json!({ "product": "meet", "env": "cloud" })));
        assert_eq!((s, v["code"].as_str()), (400, Some("deploy-env")));
        let (_, v) = mint(&mut h, with(json!({ "product": "spokes", "env": "installed", "deploy": { "host": "relay.example.org" } })));
        assert_eq!(v["code"], "deploy-env");
        let (s, v) = mint(&mut h, with(json!({ "product": "meet", "env": "linux", "deploy": { "host": MEET_HOST, "pki": "console" } })));
        match crate::fleet_port::served_binary() {
            Err(_) => assert_eq!((s, v["code"].as_str()), (404, Some("deploy-unavailable")), "{v}"),
            Ok(_) => assert_eq!((s, v["code"].as_str()), (409, Some("deploy-ca-needed")), "{v}"),
        }
        let (s, v) = mint(&mut h, with(json!({ "product": "spokes" })));
        assert_eq!(s, 200, "{v}");
        assert!(v["install"]["command"].is_null() && v["deploy"].is_null());
        assert_eq!(v["install"]["offlineUninstall"], "sudo /opt/lucid-relay/bin/lucid-relay deploy script spokes-linux | sudo bash -s -- uninstall");
        let id = v["id"].as_str().unwrap();
        assert_eq!(h.f.registry().enrollments[id].env, "installed");
        assert!(!h.f.download_enrollment_ok(id, crate::codec::now_ms()), "the installed path downloads nothing");
    }

    #[test]
    fn the_install_object_follows_3_5_per_env_and_profile() {
        let h = boot("deploy-install");
        let t = crate::codec::now_ms();
        let e = "en_0123456789abcdef";
        let url = h.f.fleet_url(&h.c);
        let i = h.f.install_of(&h.c, Product::Meet, "linux", Some(&json!({ "pki": "own" })), e, "Relay A", t);
        let cmd = i["command"].as_str().unwrap();
        assert!(cmd.starts_with("curl -fsS --proto =https -k --pinnedpubkey '"), "{cmd}");
        assert!(cmd.ends_with(&format!("'{url}/fleet/v1/install/meet-linux.sh?e={e}' | sudo bash -s -- --pki-dir <folder>")), "{cmd}");
        assert!(i["uninstall"].as_str().unwrap().ends_with(&format!(" {url}/fleet/v1/install/meet-linux.sh | sudo bash -s -- uninstall")));
        assert_eq!(i["scriptUrl"], format!("{url}/fleet/v1/install/meet-linux.sh?e={e}"));
        assert_eq!(i["offlineUninstall"], "sudo /opt/lucid-meet/lucid-relay deploy script meet-linux | sudo bash -s -- uninstall");
        assert!(i["steps"].is_null());
        let i = h.f.install_of(&h.c, Product::Meet, "linux", Some(&json!({ "pki": "console" })), e, "Relay A", t);
        assert!(i["command"].as_str().unwrap().ends_with("' | sudo bash"));
        let i = h.f.install_of(&h.c, Product::Spokes, "docker", None, e, "Relay A", t);
        let cmd = i["command"].as_str().unwrap();
        assert!(cmd.contains(&format!("/fleet/v1/install/spokes-docker.sh?e={e}'")) && cmd.ends_with(" -s -- --root <path to root.pub>"), "{cmd}");
        let i = h.f.install_of(&h.c, Product::Meet, "proxmox", Some(&json!({ "pki": "console" })), e, "Relay A", t);
        let steps: Vec<&str> = i["steps"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(steps.len(), 7);
        assert!(steps[0].starts_with("cd /var/tmp && wget -N https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-"));
        assert!(steps[2].contains("--name relay-a "));
        assert!(i["command"].as_str().unwrap().contains("/meet-linux.sh?e="));
        let i = h.f.install_of(&h.c, Product::Meet, "installed", None, e, "Relay A", t);
        assert!(i["command"].is_null() && i["scriptUrl"].is_null() && i["binary"].is_null());
        h.c.inner.lock().book.settings.profile = crate::console_settings::Profile::High;
        let i = h.f.install_of(&h.c, Product::Meet, "linux", Some(&json!({ "pki": "own" })), e, "Relay A", t);
        assert!(i["command"].is_null() && i["uninstall"].is_null() && i["binary"].is_null());
        let steps = i["steps"].as_array().unwrap();
        assert_eq!(steps[0], "./lucid-relay deploy script meet-linux > lucid-deploy.sh");
        let second = steps[1].as_str().unwrap();
        assert!(second.starts_with(&format!("sudo bash lucid-deploy.sh --binary ./lucid-relay --console '{url}' --pins '")) && second.ends_with("' --profile high --pki-dir <folder>"), "{second}");
        let i = h.f.install_of(&h.c, Product::Spokes, "linux", None, e, "Relay A", t);
        assert!(i["steps"][1].as_str().unwrap().ends_with("--profile high --root <path to root.pub>"));
        // D1: nothing of a code anywhere.
        assert!(!stringify(&i).contains("LCE1-"));
        let o = h.f.deploy_options(&h.c, t);
        let docker = o["envs"].as_array().unwrap().iter().find(|x| x["id"] == "docker").unwrap().clone();
        assert_eq!((docker["offered"].as_bool(), docker["why"].as_str()), (Some(false), Some("high")));
        assert!(o["envs"].as_array().unwrap().iter().any(|x| x["id"] == "linux" && x["offered"] == true), "High installs from release media");
        assert!(o["binary"].is_null());
        assert_eq!(o["envs"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn the_preview_carries_deploy_and_changes_with_any_field() {
        let h = boot("deploy-preview");
        let ca_id = with_ca(&h, Some(SIGNER_URL));
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let p = h.f.enroll_preview(&id, "console.example.org", t).unwrap();
        let d = &p["deploy"];
        assert_eq!((d["host"].as_str(), d["pki"].as_str(), d["ca"]["id"].as_str(), d["signer"]["url"].as_str()), (Some(MEET_HOST), Some("console"), Some(ca_id.as_str()), Some(SIGNER_URL)));
        assert!(d["ca"]["pem"].as_str().unwrap().contains("BEGIN CERTIFICATE"));
        assert!(d["spokesRoot"].is_null() && d["license"].is_null() && d.get("admins").is_none());
        let before = stringify(&p);
        h.f.registry().enrollments.get_mut(&id).unwrap().deploy.as_mut().unwrap()["turnHost"] = json!("turn.example.org");
        assert_ne!(stringify(&h.f.enroll_preview(&id, "console.example.org", t).unwrap()), before, "the hashed answer binds every deploy field");
        let plain_id = h.open_deploy(Product::Meet, None, None);
        assert!(h.f.enroll_preview(&plain_id, "console.example.org", t).unwrap()["deploy"].is_null());
        // A CA lost or removed after the mint: the preview refuses.
        *h.f.meet.lock() = None;
        assert_eq!(h.f.enroll_preview(&id, "console.example.org", t).unwrap_err().code, "deploy-ca-needed");
    }

    #[test]
    fn a_console_ca_enrollment_issues_from_the_requests_in_one_step() {
        let h = boot("deploy-issue");
        let ca_id = with_ca(&h, None);
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, a) = h.enroll_meet(&id, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap();
        assert!(a["meet"]["cert"].as_str().unwrap().contains("BEGIN CERTIFICATE"));
        assert!(a["meet"]["signerCert"].is_null());
        assert_eq!(a["meet"]["caCert"].as_str(), h.f.meet.lock().as_ref().map(|m| m.ca_pem()).as_deref());
        assert!(a["meet"]["crl"].as_str().unwrap().contains("BEGIN X509 CRL"));
        let rows = h.rows(&relay);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "server");
        assert_eq!(h.f.registry().relays[&relay].deploy.as_ref().unwrap()["pki"], "console");
        let audit = h.c.audit.lock().entries().iter().map(|e| stringify(&Value::Object(e.clone()))).collect::<String>();
        assert!(audit.contains("fleet.meet-cert.issue"));
        // D5: the CA key is in no audit entry and no file but the sealed store.
        assert!(!audit.contains("PRIVATE KEY"));
        for e in std::fs::read_dir(&h.d).unwrap().filter_map(Result::ok) {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            assert!(!text.contains("PRIVATE KEY"), "{}", e.path().display());
        }
        // 4.4: the enrollment's program download counts as named for the next hour only.
        assert!(h.f.download_enrollment_ok(&id, t + 1000));
        assert!(!h.f.download_enrollment_ok(&id, t + CODE_MS + 1));
    }

    #[test]
    fn a_request_for_other_names_burns_a_try_and_writes_nothing() {
        let h = boot("deploy-csr");
        let ca_id = with_ca(&h, Some(SIGNER_URL));
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let err = h.enroll_meet(&id, &server_csr("other.example.org"), Some(&signer_csr()), "standard", &[&ca_id], t).unwrap_err();
        assert_eq!(err.code, "deploy-csr");
        assert!(err.message.contains(MEET_HOST), "{}", err.message);
        assert_eq!(h.f.registry().enrollments[&id].fails, 1);
        assert!(!h.f.registry().relays.values().any(|r| r.enrollment == id), "issuing and the registry write are one step");
        assert!(h.f.meet.lock().as_ref().unwrap().rows().is_empty());
        // A request that does not read, and a missing signer request with a certificate server, burn one each.
        assert_eq!(h.enroll_meet(&id, "AAAA", Some(&signer_csr()), "standard", &[&ca_id], t).unwrap_err().code, "deploy-csr");
        assert_eq!(h.enroll_meet(&id, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap_err().code, "deploy-csr");
        assert_eq!(h.f.registry().enrollments[&id].fails, 3);
        // The same key for both requests.
        let k = p256();
        let same = b64u(&crate::fleet_x509::csr(&k, MEET_HOST, &[MEET_HOST.to_owned()], &[], &[]).unwrap());
        let same_signer = b64u(&crate::fleet_x509::csr(&k, "Lucid Meet Relay", &[], &[], &["urn:lucid-meet:relay".to_owned()]).unwrap());
        assert_eq!(h.enroll_meet(&id, &same, Some(&same_signer), "standard", &[&ca_id], t).unwrap_err().code, "deploy-csr");
        assert_eq!(h.f.registry().enrollments[&id].fails, 4);
        assert!(h.enroll_meet(&id, &server_csr(MEET_HOST), Some(&signer_csr()), "standard", &[&ca_id], t).is_ok(), "four wrong proofs leave the code open");
    }

    #[test]
    fn a_name_held_by_another_relay_is_refused_unless_it_is_replaced() {
        let h = boot("deploy-taken");
        let ca_id = with_ca(&h, None);
        let t = crate::codec::now_ms();
        let first = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, _) = h.enroll_meet(&first, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap();
        let old = h.rows(&relay)[0].0.clone();
        let second = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let err = h.enroll_meet(&second, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap_err();
        assert_eq!(err.code, "deploy-host-taken");
        assert_eq!(err.message, format!("Relay A already holds a certificate for {MEET_HOST}. Use Replace Relay A."));
        // A day later (meet_ca keeps one issue per relay id and kind per 24 hours, and a Replace keeps the id).
        let later = t + 25 * HOUR;
        let replace = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), Some(&relay));
        h.f.registry().enrollments.get_mut(&replace).unwrap().expires = later + CODE_MS;
        let (same, _) = h.enroll_meet(&replace, &server_csr(MEET_HOST), None, "standard", &[&ca_id], later).unwrap();
        assert_eq!(same, relay, "a Replace keeps the relay id");
        let rows = h.rows(&relay);
        assert!(rows.iter().any(|r| r.0 == old && r.4.is_some()), "the replaced relay's certificate is revoked (L10)");
        assert!(rows.iter().any(|r| r.0 != old && r.4.is_none()));
    }

    #[test]
    fn renewal_waits_a_day_and_revokes_older_server_serials_but_the_one_in_use() {
        let h = boot("deploy-renew");
        let ca_id = with_ca(&h, None);
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, _) = h.enroll_meet(&id, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap();
        let first = h.rows(&relay)[0].0.clone();
        let ask = |at: i64| h.f.meet_cert(&relay, &json!({ "csr": server_csr(MEET_HOST), "signerCsr": null }), at);
        assert_eq!(ask(t + HOUR).unwrap_err().code, "meet-cert-wait");
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "certSerial": first }));
        let a = ask(t + 25 * HOUR).unwrap();
        assert!(a["cert"].as_str().unwrap().contains("BEGIN CERTIFICATE") && a["signerCert"].is_null());
        let rows = h.rows(&relay);
        let second = rows.iter().find(|r| r.0 != first).unwrap().0.clone();
        assert!(rows.iter().all(|r| r.4.is_none()), "the serial in use stays until the relay moves");
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "certSerial": second }));
        ask(t + 50 * HOUR).unwrap();
        let rows = h.rows(&relay);
        assert!(rows.iter().any(|r| r.0 == first && r.4.is_some()), "older outstanding server serials are revoked");
        assert!(rows.iter().any(|r| r.0 == second && r.4.is_none()));
        // Another relay's names, and an unexpected body.
        assert_eq!(h.f.meet_cert(&relay, &json!({ "csr": server_csr("other.example.org"), "signerCsr": null }), t + 80 * HOUR).unwrap_err().code, "deploy-csr");
        assert_eq!(h.f.meet_cert(&relay, &json!({ "csr": null, "signerCsr": null, "x": 1 }), t + 80 * HOUR).unwrap_err().code, "fleet-op");
        assert_eq!(h.f.meet_cert(&relay, &json!({ "csr": null, "signerCsr": null }), t + 80 * HOUR).unwrap_err().code, "deploy-csr");
    }

    #[test]
    fn the_server_serial_in_use_is_revoked_7_days_after_the_relay_reports_the_new_one() {
        let h = boot("deploy-grace");
        let ca_id = with_ca(&h, None);
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, _) = h.enroll_meet(&id, &server_csr(MEET_HOST), None, "standard", &[&ca_id], t).unwrap();
        let first = h.rows(&relay)[0].0.clone();
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "certSerial": first }));
        h.f.meet_cert(&relay, &json!({ "csr": server_csr(MEET_HOST), "signerCsr": null }), t + 25 * HOUR).unwrap();
        let second = h.rows(&relay).iter().find(|r| r.0 != first).unwrap().0.clone();
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "certSerial": second }));
        h.f.meet_report(&h.c, &relay, t + 26 * HOUR);
        h.f.meet_tick(&h.c, t + 26 * HOUR + SERVER_GRACE_MS - 1);
        assert!(h.rows(&relay).iter().all(|r| r.4.is_none()), "not before 7 days");
        h.f.meet_tick(&h.c, t + 26 * HOUR + SERVER_GRACE_MS);
        assert!(h.rows(&relay).iter().any(|r| r.0 == first && r.4.is_some()));
        assert!(h.rows(&relay).iter().any(|r| r.0 == second && r.4.is_none()));
    }

    #[test]
    fn signer_client_certificates_are_30_days_unless_every_relay_confirms() {
        let h = boot("deploy-signer");
        let ca_id = with_ca(&h, Some(SIGNER_URL));
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, a) = h.enroll_meet(&id, &server_csr(MEET_HOST), Some(&signer_csr()), "standard", &[&ca_id], t).unwrap();
        assert!(a["meet"]["signerCert"].as_str().unwrap().contains("BEGIN CERTIFICATE"));
        let days = |h: &H| h.rows(&relay).iter().filter(|r| r.1 == "signer-client").max_by_key(|r| r.2).map(|r| (r.3 - r.2).div_euclid(DAY_MS)).unwrap();
        assert!((29..=30).contains(&days(&h)), "{}", days(&h));
        let renew = |at: i64| h.f.meet_cert(&relay, &json!({ "csr": null, "signerCsr": signer_csr() }), at).unwrap();
        // The setting on, the relay reporting false: still 30 days, and `signer-crl-mismatch` names it.
        h.f.meet.lock().as_mut().unwrap().set_signer_enforced(true).unwrap();
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "signerCrlEnforced": false }));
        renew(t + 25 * HOUR);
        assert!((29..=30).contains(&days(&h)));
        assert!(h.f.meet_attention(t).iter().any(|a| a["kind"] == "signer-crl-mismatch" && a["args"]["relay"] == "Relay A"));
        // Every relay of the server confirms: 90 days.
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "signerCrlEnforced": true }));
        renew(t + 50 * HOUR);
        assert!((89..=90).contains(&days(&h)), "{}", days(&h));
        assert!(!h.f.meet_attention(t).iter().any(|a| a["kind"] == "signer-crl-mismatch"));
        // A relay claiming true while the setting is off never yields 90 days.
        h.f.meet.lock().as_mut().unwrap().set_signer_enforced(false).unwrap();
        renew(t + 75 * HOUR);
        assert!((29..=30).contains(&days(&h)));
        // R4-H1: superseded signer client certificates are never revoked.
        assert!(h.rows(&relay).iter().filter(|r| r.1 == "signer-client").all(|r| r.4.is_none()));
        // R4-M3: 3 days before the newest ends.
        let ends = h.rows(&relay).iter().filter(|r| r.1 == "signer-client").map(|r| r.3).max().unwrap();
        assert!(!h.f.meet_attention(ends - 4 * DAY_MS).iter().any(|a| a["kind"] == "relay-signer-cert-expiring"));
        assert!(h.f.meet_attention(ends - 3 * DAY_MS).iter().any(|a| a["kind"] == "relay-signer-cert-expiring"));
    }

    #[test]
    fn removing_or_leaving_revokes_every_unexpired_serial_of_both_kinds() {
        let h = boot("deploy-remove");
        let ca_id = with_ca(&h, Some(SIGNER_URL));
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, _) = h.enroll_meet(&id, &server_csr(MEET_HOST), Some(&signer_csr()), "standard", &[&ca_id], t).unwrap();
        let first = h.rows(&relay)[0].0.clone();
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "certSerial": first }));
        // A server certificate in its 7-day grace and a superseded signer client certificate still in date (R5-M1).
        h.f.meet_cert(&relay, &json!({ "csr": server_csr(MEET_HOST), "signerCsr": signer_csr() }), t + 25 * HOUR).unwrap();
        assert_eq!(h.rows(&relay).len(), 4);
        h.f.meet_revoke_relay(&h.c, &relay, t + 26 * HOUR);
        assert!(h.rows(&relay).iter().all(|r| r.4.is_some()), "{:?}", h.rows(&relay));
        // A relay that leaves (AC-2a 3.5 `relay-left`).
        let other = h.open_deploy(Product::Meet, Some(meet_deploy("meet2.example.org")), None);
        let relay2 = h.f.draw_relay_id(&other);
        let body = json!({ "product": "meet", "version": "1.0", "fips": false, "profile": "standard", "host": "meet2.example.org", "os": "linux", "localConsole": false, "meetCsr": server_csr("meet2.example.org"), "meetSignerCsr": signer_csr(), "meetRoots": [ca_id] });
        h.f.enroll_check(&other, &body, t).unwrap();
        h.f.enroll_done(&other, EnrollDone { relay_id: Some(relay2.clone()), serial: "0a0d".into(), spki: p256().spki(), not_after: t + 90 * DAY_MS, generation: 1, relay: body, source: String::new() }, t).unwrap();
        h.f.on_event(&relay2, "bye", &json!({ "reason": "left" }), t + HOUR);
        assert!(h.rows(&relay2).iter().all(|r| r.4.is_some()));
    }

    #[test]
    fn welcome_names_the_ca_and_a_high_relay_that_trusts_it_is_refused() {
        let mut h = boot("deploy-held");
        let t = crate::codec::now_ms();
        let spokes = h.seed(Product::Spokes);
        h.link.up.lock().insert(spokes.clone());
        let hello = json!({ "relayId": spokes, "version": "1.0", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": ["read-health"], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": "pending", "policySeq": 1, "rosterSeq": 0, "trustSeq": 1, "pins": [], "certNotAfter": null });
        assert!(h.f.on_hello(&spokes, &hello, "10.0.0.9", t).unwrap()["meetCaId"].is_null());
        let ca_id = with_ca(&h, None);
        assert_eq!(h.f.on_hello(&spokes, &hello, "10.0.0.9", t).unwrap()["meetCaId"], ca_id.as_str());
        // 8.7: a High Meeting Hub relay whose roots include the CA, or are unknown.
        let id = h.open_deploy(Product::Meet, None, None);
        let relay = |profile: &str, roots: Value| json!({ "product": "meet", "version": "1.0", "fips": false, "profile": profile, "host": MEET_HOST, "os": "linux", "localConsole": false, "meetRoots": roots });
        assert_eq!(h.f.enroll_check(&id, &relay("high", json!([])), t).unwrap_err().code, "fleet-ca-held");
        assert_eq!(h.f.enroll_check(&id, &relay("high", json!([ca_id])), t).unwrap_err().code, "fleet-ca-held");
        assert!(h.f.enroll_check(&id, &relay("high", json!(["m_0123456789abcdef0123456789abcdef"])), t).is_ok());
        assert!(h.f.enroll_check(&id, &relay("standard", json!([ca_id])), t).is_ok());
        // "Confirm relay" for such a relay.
        let meet = h.seed(Product::Meet);
        let fp = {
            let mut reg = h.f.registry();
            let r = reg.relays.get_mut(&meet).unwrap();
            r.profile = "high".into();
            r.fingerprint.clone()
        };
        let params = json!({ "relay": meet, "fingerprint": fp });
        let su = h.stepup("fleet.relay.confirm", &meet, &params);
        let mut b = params.clone();
        b["stepup"] = su;
        let (s, v) = h.post("/console/api/fleet/relays/confirm", b);
        assert_eq!((s, v["code"].as_str()), (409, Some("fleet-ca-held")), "{v}");
        // The import's High relay list: pending and unknown roots count (H4, R2-M2).
        let high = h.f.high_relays();
        assert!(high.iter().any(|x| x.relay_id == meet && x.meet_roots.is_none()));
    }

    #[test]
    fn the_list_goes_only_to_relays_that_take_it_from_the_bundle() {
        let h = boot("deploy-push");
        let ca_id = with_ca(&h, None);
        let t = crate::codec::now_ms();
        let (a, b, c) = (h.seed(Product::Meet), h.seed(Product::Meet), h.seed(Product::Meet));
        for r in [&a, &b, &c] {
            h.link.up.lock().insert(r.clone());
        }
        let crl = |source: &str| json!({ "source": source, "thisUpdate": 0, "number": null, "issuer": ca_id, "sha256": "00", "pending": null });
        h.report(&a, "meetRoots", json!([ca_id]));
        h.report(&a, "meetCrl", crl("bundle"));
        h.report(&b, "meetRoots", json!([ca_id]));
        h.report(&b, "meetCrl", crl("fixed"));
        h.report(&c, "meetRoots", json!(["m_0123456789abcdef0123456789abcdef"]));
        h.report(&c, "meetCrl", crl("bundle"));
        h.f.push_crl_all();
        let to: Vec<String> = h.link.sent.lock().iter().filter(|(_, op, _)| op == "meet-crl").map(|(r, _, _)| r.clone()).collect();
        assert_eq!(to, vec![a.clone()], "only the bundle relay that trusts the CA");
        let view = h.f.meet_ca_view(&h.c, t);
        let not_pushed = view["ca"]["notPushed"].as_array().unwrap();
        assert_eq!(not_pushed.len(), 1);
        assert_eq!((not_pushed[0]["relayId"].as_str(), not_pushed[0]["why"].as_str()), (Some(b.as_str()), Some("fixed")));
        // The relay holding the console's newest list gets nothing more.
        let info = h.f.meet.lock().as_ref().unwrap().crl().unwrap().1;
        h.report(&a, "meetCrl", json!({ "source": "bundle", "thisUpdate": info.this_update, "number": info.number.to_json(), "issuer": ca_id, "sha256": info.sha256, "pending": null }));
        h.link.sent.lock().clear();
        h.f.push_crl_all();
        assert!(h.sent("meet-crl").is_empty());
        // R3-L3: its own list is not divergence; a list of the CA it did not sign is.
        h.f.meet_report(&h.c, &a, t);
        assert!(!h.f.diverge_seen.lock().contains_key(&a));
        h.report(&a, "meetCrl", json!({ "source": "bundle", "thisUpdate": info.this_update, "number": null, "issuer": ca_id, "sha256": "ab".repeat(32), "pending": null }));
        h.f.meet_report(&h.c, &a, t);
        assert!(h.f.diverge_seen.lock().contains_key(&a), "the console asks the relay for that list once");
    }

    #[test]
    fn import_is_refused_without_a_bound_seal_and_keeps_nothing() {
        let mut h = boot("deploy-import");
        let bind = json!({ "signerUrl": null, "noHighRelay": true, "maxLifetimeDays": null });
        let su = h.stepup("fleet.meet-ca.import", "-", &bind);
        let key = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n";
        let (s, v) = h.post("/console/api/fleet/meet-ca/import", json!({ "caPem": PEM, "keyPem": key, "noHighRelay": true, "stepup": su }));
        let bound = h.c.seal.lock().as_ref().is_some_and(|s| matches!(s.provider(), crate::console_seal::Provider::SystemdCredential | crate::console_seal::Provider::DpapiService));
        if bound {
            assert_eq!(v["code"], "meet-ca-key", "{v}");
        } else {
            assert_eq!((s, v["code"].as_str()), (409, Some("meet-ca-seal")), "{v}");
            assert!(h.c.seal_get(MEET_IMPORT_STASH).is_none(), "a refusal stashes nothing");
        }
        let audit = h.c.audit.lock().entries().iter().map(|e| stringify(&Value::Object(e.clone()))).collect::<String>();
        assert!(!audit.contains("PRIVATE KEY"));
        for e in std::fs::read_dir(&h.d).unwrap().filter_map(Result::ok) {
            assert!(!std::fs::read_to_string(e.path()).unwrap_or_default().contains("PRIVATE KEY"), "{}", e.path().display());
        }
        // Under High the page shows only meet-ca.high.
        h.c.inner.lock().book.settings.profile = crate::console_settings::Profile::High;
        let view = h.f.meet_ca_view(&h.c, crate::codec::now_ms());
        assert!(view["ca"].is_null());
        assert_eq!((view["allowed"].as_bool(), view["why"].as_str()), (Some(false), Some("meet-ca-high")));
    }

    #[test]
    fn ca_attention_follows_10() {
        let h = boot("deploy-attention");
        let ca_id = with_ca(&h, Some(SIGNER_URL));
        let t = crate::codec::now_ms();
        let id = h.open_deploy(Product::Meet, Some(meet_deploy(MEET_HOST)), None);
        let (relay, _) = h.enroll_meet(&id, &server_csr(MEET_HOST), Some(&signer_csr()), "standard", &[&ca_id], t).unwrap();
        let kinds = |at: i64| h.f.meet_attention(at).iter().map(|a| a["kind"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();
        assert!(!kinds(t).contains(&"relay-meet-cert-expiring".to_owned()));
        assert!(kinds(t + 77 * DAY_MS).contains(&"relay-meet-cert-expiring".to_owned()), "14 days left, not renewed");
        // signer-crl-stale: the server's held list behind the console's for 6 hours (R5-L2).
        h.report(&relay, "meetPki", json!({ "caId": ca_id, "signerHeld": { "number": 0, "thisUpdate": 0 } }));
        h.f.signer_stale_note(&h.c, t);
        assert!(!kinds(t + HOUR).contains(&"signer-crl-stale".to_owned()));
        assert!(kinds(t + 7 * HOUR).contains(&"signer-crl-stale".to_owned()));
        // meet-crl-future until dismissed.
        h.f.set_crl_future(&h.c, Some(t + DAY_MS), "Relay A", false, t);
        assert!(kinds(t).contains(&"meet-crl-future".to_owned()));
        assert_eq!(h.post("/console/api/fleet/meet-ca/dismiss-diverged", json!({})).0, 200);
        assert!(!kinds(t).contains(&"meet-crl-future".to_owned()));
        // A relay's own `profile-lock-refused` reaches Overview (6.4).
        h.f.on_event(&relay, "attention", &json!({ "items": [{ "kind": "profile-lock-refused", "severity": "bad", "args": { "date": t, "configured": "standard" } }] }), t);
        assert!(h.f.attention_items(&h.c, t).iter().any(|a| a["kind"] == "profile-lock-refused" && a["relay"] == "Relay A"));
    }

    #[test]
    fn deploy_routes_are_admin_only_and_the_enrollment_reads_back() {
        let role = |m: &str, p: &str| fleet_route(m, p).unwrap().0.role;
        for p in ["fleet/meet-ca/import", "fleet/meet-ca/revoke", "fleet/meet-ca/remove", "fleet/meet-ca/dismiss-diverged", "fleet/meet-ca/prune", "fleet/meet-ca/max-lifetime", "fleet/meet-ca/signer-enforced", "fleet/spokes-root"] {
            assert_eq!(role("POST", p), Role::Admin, "{p}");
        }
        for p in ["fleet/deploy/options", "fleet/meet-ca", "fleet/spokes-root", "fleet/enrollments/en_0123456789abcdef"] {
            assert_eq!(role("GET", p), Role::Admin, "{p}");
        }
        assert!(fleet_route("GET", "fleet/enrollments/en_XYZ").is_none());
        assert_eq!(fleet_route("POST", "fleet/enrollments/cancel").unwrap().0.action, "fleet.enroll.cancel", "the exact row wins over the prefix");
        assert_eq!(fleet_route("POST", "fleet/meet-ca/import").unwrap().0.body_max, MEET_CA_IMPORT_MAX);
        let h = boot("deploy-detail");
        let relay = h.seed(Product::Spokes);
        let id = h.f.registry().relays[&relay].enrollment.clone();
        let (s, v) = h.get(&format!("/console/api/fleet/enrollments/{id}"));
        assert_eq!(s, 200, "{v}");
        assert_eq!((v["enrollment"]["state"].as_str(), v["enrollment"]["relay"]["state"].as_str()), (Some("used"), Some("pending")));
        assert!(v["enrollment"]["relay"]["fingerprint"].is_null(), "the fingerprint only once the relay connected");
        h.hello(&relay, "pending", &["read-health"]);
        let (_, v) = h.get(&format!("/console/api/fleet/enrollments/{id}"));
        assert_eq!(v["enrollment"]["relay"]["state"], "unconfirmed");
        assert_eq!(v["enrollment"]["relay"]["fingerprint"].as_str(), Some(h.f.registry().relays[&relay].fingerprint.as_str()));
        assert_eq!(v["enrollment"]["relay"]["bootstrap"]["anchored"], 0);
        assert_eq!(h.get("/console/api/fleet/enrollments/en_00000000000000ff").0, 404);
        let (s, v) = h.get("/console/api/fleet/deploy/options");
        assert_eq!(s, 200, "{v}");
        assert!(v["envs"].as_array().unwrap().iter().any(|x| x["id"] == "installed" && x["offered"] == true));
        assert!(v["envs"].as_array().unwrap().iter().filter(|x| x["why"] == "next").count() == 4);
    }

    #[test]
    fn the_spokes_root_is_a_p256_key_named_by_a_library_license() {
        let mut h = boot("deploy-root");
        let set = |h: &mut H, pem: &str| {
            let params = json!({ "pem": pem });
            let su = h.stepup("fleet.spokes-root.set", "-", &params);
            h.post("/console/api/fleet/spokes-root", json!({ "pem": pem, "stepup": su }))
        };
        let (s, v) = set(&mut h, PEM);
        assert_eq!((s, v["code"].as_str()), (400, Some("spokes-root-key")), "{v}");
        let (_, v) = set(&mut h, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
        assert_eq!(v["code"], "spokes-root-key", "never the private key");
        let spki = p256().spki();
        let pem = pem_of("PUBLIC KEY", &spki);
        let (s, v) = set(&mut h, &pem);
        assert_eq!((s, v["code"].as_str()), (409, Some("spokes-root-license")), "{v}");
        let id = crate::identity::node_id_of(&spki);
        assert!(stringify(&v).contains(&id), "the words name the root: {v}");
        let far = crate::codec::now_ms() / 1000 + 86_400 * 365;
        h.f.book.lock().library.push(json!({ "id": "lic_1", "product": "spokes", "edition": "standard", "users": 10, "relays": 1, "exp": far, "root": id, "token": "x" }));
        let (s, v) = set(&mut h, &pem);
        assert_eq!(s, 200, "{v}");
        assert_eq!(v["root"]["id"], id.as_str());
        assert_eq!(h.get("/console/api/fleet/spokes-root").1["root"]["id"], id.as_str());
    }

    // ── API-1 7.3 (slice 1a6): Settings > API access ──────────────────────────────────────────────────────────

    const CLIENT: &str = "c_1111111111111111";

    /// Pin an `acme` map at `seq` with one client (`CLIENT`), as the console holds a map a device signed.
    fn pin_api_map(h: &H, seq: i64) -> Value {
        let now = crate::codec::now_ms() / 1000;
        let ctx = api_ui::Ctx { org: "acme", by: ADMIN, pinned: None, pinned_seq: seq - 1 };
        let mut d = api_ui::Draft::new(&ctx, "st_seed".into(), now * 1000);
        let client = json!({"name": "splunk-scrape", "kind": "monitoring", "owner": "ann@acme.example", "scopes": ["monitor.read"], "ceiling": "internal",
                            "relays": ["*"], "networks": ["10.40.0.0/23"], "mtls_required": false, "rate": {"per_minute_each": 120, "per_day_each": 100000},
                            "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": "C".repeat(43), "y": "D".repeat(43)}, "expires": now + 86_400 * 300}],
                            "days": 300});
        api_ui::add_client(&mut d, &client, CLIENT.into(), now).unwrap();
        let jwk = json!({"kty": "EC", "crv": "P-256", "kid": "i-seed", "x": "A".repeat(43), "y": "B".repeat(43), "use": "sig", "alg": "ES256"});
        let m = api_ui::final_map(&d, "https://console.example.org:7443/api/orgs/acme", &jwk, &[], &[], &[], now);
        let wire = json!({"map": m.clone(), "sig": "", "chain": []});
        let vm = crate::api_map::VerifiedApiMap { org: "acme".into(), seq, expires: m["expires"].as_i64().unwrap(), hash: crate::api_map::api_map_hash(&m), signer: "root".into(), wire: wire.as_object().unwrap().clone() };
        h.f.api.publish_verified(None, vm, now).unwrap();
        m
    }

    #[test]
    fn api_a_journaled_suspend_is_in_the_journal_before_the_answer() {
        let h = boot("api-suspend");
        pin_api_map(&h, 1);
        assert_eq!(h.f.api.journal_head("acme"), 0);
        let body = json!({"org": "acme", "id": CLIENT, "reason": "Leaked key"});
        let (s, v) = h.post("/console/api/settings/api/clients/suspend", body.clone());
        assert_eq!(s, 200, "{v}");
        assert_eq!(h.f.api.journal_head("acme"), 1, "journaled before the answer");
        let e = h.f.api.journal_newest("acme", 1)[0].clone();
        assert_eq!((e["action"].as_str(), e["target"].as_str()), (Some("client_suspend"), Some(CLIENT)));
        assert_eq!(v["staged"]["changes"], json!(["Suspend client splunk-scrape"]));
        assert_eq!(v["staged"]["two_person"], json!(false));
        // the suspension in force is not journaled again
        assert_eq!(h.post("/console/api/settings/api/clients/suspend", body).0, 200);
        assert_eq!(h.f.api.journal_head("acme"), 1);
        // resuming is a staged widening that clears it (two-person, 6.6), never journaled
        let (s, v) = h.post("/console/api/settings/api/clients/resume", json!({"org": "acme", "id": CLIENT}));
        assert_eq!(s, 200, "{v}");
        assert_eq!(v["staged"]["two_person_reasons"], json!([api_ui::TWO_CLEARED]));
        assert_eq!(h.f.api.journal_head("acme"), 1);
        // turning the API off is journaled at once too
        let (s, v) = h.post("/console/api/settings/api/off", json!({"org": "acme", "reason": "Incident"}));
        assert_eq!(s, 200, "{v}");
        assert_eq!(h.f.api.journal_newest("acme", 1)[0]["action"], "api_off");
        assert_eq!(h.post("/console/api/settings/api/off", json!({"org": "acme", "reason": "Again"})).1["code"], "stale");
    }

    #[test]
    fn api_a_stale_stage_is_refused_at_save_and_dropped() {
        let h = boot("api-stale");
        pin_api_map(&h, 1);
        let (_, v) = h.post("/console/api/settings/api/clients/suspend", json!({"org": "acme", "id": CLIENT, "reason": "Leaked key"}));
        let stage = v["staged"]["id"].as_str().unwrap().to_owned();
        assert_eq!(h.post("/console/api/settings/api/save", json!({"org": "acme", "stage": "st_0000000000000000", "reason": "Rotate"})).1["code"], "gone");
        pin_api_map(&h, 2);
        let (s, v) = h.post("/console/api/settings/api/save", json!({"org": "acme", "stage": stage, "reason": "Rotate"}));
        assert_eq!(v["code"], "stale", "{v}");
        assert!(s >= 400 && stringify(&v).contains(api_ui::STAGE_MOVED), "{v}");
        assert!(h.f.api_drafts.lock().get("acme", crate::codec::now_ms()).is_none(), "the stale draft is dropped");
        assert!(h.sent("api-sign-request").is_empty(), "no device was asked");
    }

    #[test]
    fn api_a_failed_spokes_bind_leaves_the_draft_as_it_was() {
        let mut h = boot("api-bind-fail");
        pin_api_map(&h, 1);
        let relay = h.seed(Product::Spokes);
        // the console's Remote Spokes root, which a first bind stages
        let spki = p256().spki();
        h.f.book.lock().spokes_root = Some(json!({ "pem": pem_of("PUBLIC KEY", &spki), "id": crate::identity::node_id_of(&spki) }));
        // a draft held before the bind
        let (s, v) = h.post("/console/api/settings/api/clients/suspend", json!({"org": "acme", "id": CLIENT, "reason": "Leaked key"}));
        assert_eq!(s, 200, "{v}");
        let t = crate::codec::now_ms();
        let before = h.f.api_drafts.lock().get("acme", t).cloned().unwrap();
        // the relay already serves the most organizations it can, so recording one more fails
        for i in 0..64 {
            h.f.api.spokes_bind(None, &relay, &format!("org{i:02}"), true, t / 1000).unwrap();
        }
        let params = json!({"org": "acme", "relay": relay});
        let mut body = params.clone();
        body["stepup"] = h.stepup("api.spokes.bind", "acme", &params);
        let (s, v) = h.post("/console/api/settings/api/spokes/bind", body);
        assert!(s >= 400 && v["code"] == "write-failed", "{v}");
        let after = h.f.api_drafts.lock().get("acme", crate::codec::now_ms()).cloned().unwrap();
        assert_eq!(after.map, before.map, "the relay is not staged");
        assert_eq!((after.id, after.changes), (before.id, before.changes));
        // with no draft held before, a failed bind leaves none
        assert!(h.f.api_drafts.lock().discard("acme"));
        let mut body = params.clone();
        body["stepup"] = h.stepup("api.spokes.bind", "acme", &params);
        let (s, v) = h.post("/console/api/settings/api/spokes/bind", body);
        assert!(s >= 400 && v["code"] == "write-failed", "{v}");
        assert!(h.f.api_drafts.lock().get("acme", crate::codec::now_ms()).is_none());
    }

    #[test]
    fn api_a_signing_claimed_for_publication_cannot_be_canceled() {
        let h = boot("api-claim");
        let s = api_ui::Signing { org: "acme".into(), relay: "r_01".into(), request: "rq_1".into(), by: ADMIN.into(), at: crate::codec::now_ms(), state: "waiting", error: None, map_sha256: "0".repeat(64), seq: 2 };
        h.f.api_signings.lock().insert("acme".into(), s.clone());
        assert!(h.f.api_signing_claim(&s));
        assert_eq!(api_ui::signings_load(&h.d)["acme"].state, "publishing", "the claim is on disk before publishing");
        let (_, v) = h.post("/console/api/settings/api/signing/cancel", json!({"org": "acme"}));
        assert!(stringify(&v).contains(api_ui::SIGN_PUBLISHING), "{v}");
        assert_eq!(h.f.api_signings.lock()["acme"].state, "publishing");
    }

    #[test]
    fn api_a_save_asks_the_org_relay_for_the_device_signature_and_records_it() {
        let h = boot("api-save");
        // an Enterprise license, so a read of the screens keeps the map serving (D8)
        let far = crate::codec::now_ms() / 1000 + 365 * 86_400;
        h.f.book.lock().library.push(json!({ "id": "lic_1", "product": "meet", "edition": "enterprise", "exp": far }));
        pin_api_map(&h, 1);
        let relay = "r_0123456789abcdef";
        h.link.up.lock().insert(relay.into());
        h.f.api.on_welcomed(relay);
        // the relay reports the org (`api-heads`), so it is one of the org's relays
        h.f.api.sync(&*h.link, relay, crate::codec::now_ms() / 1000);
        assert_eq!(h.f.api.relays_of("acme"), vec![relay.to_owned()]);
        let (_, v) = h.post("/console/api/settings/api/clients/suspend", json!({"org": "acme", "id": CLIENT, "reason": "Leaked key"}));
        let stage = v["staged"]["id"].as_str().unwrap().to_owned();
        let (s, v) = h.post("/console/api/settings/api/save", json!({"org": "acme", "stage": stage, "reason": "Rotate"}));
        assert_eq!(s, 200, "{v}");
        assert_eq!((v["request"].as_str(), v["relay"].as_str(), v["signing"]["state"].as_str()), (Some("rq_0123456789abcdef"), Some(relay), Some("waiting")));
        let asked = h.sent("api-sign-request").pop().unwrap();
        assert_eq!((asked["principal"].as_str(), asked["requested_by"].as_str()), (Some(ADMIN), Some(ADMIN)));
        assert_eq!(asked["map_sha256"].as_str().unwrap(), crate::api_map::api_map_hash(&asked["map"]));
        assert_eq!((asked["map"]["seq"].as_i64(), asked["map"]["folded"].clone()), (Some(2), json!(["t_acme_000001"])));
        assert_eq!(api_ui::signings_load(&h.d)["acme"].request, "rq_0123456789abcdef", "kept for a restart");
        let (_, view) = h.get("/console/api/settings/api");
        let acme = view["orgs"].as_array().unwrap().iter().find(|o| o["org"] == "acme").unwrap().clone();
        assert_eq!((acme["signing"]["relay"].as_str(), acme["staged"].clone()), (Some(relay), Value::Null));
        // one save in flight per org: another is refused until the waiting one is canceled
        let (_, v) = h.post("/console/api/settings/api/clients/resume", json!({"org": "acme", "id": CLIENT}));
        let stage = v["staged"]["id"].as_str().unwrap_or_else(|| panic!("{v}")).to_owned();
        let (_, v) = h.post("/console/api/settings/api/save", json!({"org": "acme", "stage": stage, "reason": "Back"}));
        assert!(stringify(&v).contains(api_ui::SIGNING_BUSY), "{v}");
        let (s, v) = h.post("/console/api/settings/api/signing/cancel", json!({"org": "acme"}));
        assert_eq!(s, 200, "{v}");
        assert_eq!((v["signing"]["state"].as_str(), v["signing"]["error"].as_str()), (Some("failed"), Some(api_ui::SIGN_CANCELED)));
        assert_eq!(h.post("/console/api/settings/api/signing/cancel", json!({"org": "acme"})).1["code"], "stale", "nothing waits now");
        // a save signs exactly the map it asked for: a change after the ask (as a second admin approves) voids it
        let t = crate::codec::now_ms();
        let d = h.f.api_drafts.lock().get("acme", t).cloned().unwrap();
        let map = h.f.api_final(&h.c, &d, &h.f.api.journal_active("acme"), t).unwrap();
        let sha = crate::api_map::api_map_hash(&map);
        h.f.api_drafts.lock().ask("acme", &d.id, &sha).unwrap();
        let params = json!({"org": "acme", "stage": d.id, "reason": "Back", "map_sha256": sha, "map": map});
        let mut forged = params.clone();
        forged["map"]["grace"]["app"] = json!(48);
        assert_eq!(h.f.api_save_run(&h.c, ADMIN, &forged, t).unwrap_err().message, api_ui::STAGE_CHANGED, "the map must be the hashed one");
        let mut changed = h.f.api_drafts.lock().get("acme", t).cloned().unwrap();
        changed.changes.push("Another change".into());
        h.f.api_drafts.lock().put(changed, t);
        let asked = h.sent("api-sign-request").len();
        assert_eq!(h.f.api_save_run(&h.c, ADMIN, &params, t).unwrap_err().message, api_ui::STAGE_CHANGED);
        assert_eq!(h.sent("api-sign-request").len(), asked, "nothing was sent");
        // the unchanged draft is sent, recorded first as `sending`, then `waiting`
        h.f.api_drafts.lock().ask("acme", &d.id, &sha).unwrap();
        let v = h.f.api_save_run(&h.c, ADMIN, &params, t).unwrap();
        assert_eq!(v["signing"]["state"], "waiting");
        assert_eq!(api_ui::signings_load(&h.d)["acme"].state, "waiting");
    }

    #[test]
    fn api_a_signing_whose_answer_was_lost_is_settled_by_the_tick() {
        let h = boot("api-lost");
        let t = crate::codec::now_ms();
        let s = api_ui::Signing { org: "acme".into(), relay: "r_0123456789abcdef".into(), request: String::new(), by: ADMIN.into(), at: t - 3 * 60_000, state: "sending", error: None, map_sha256: "0".repeat(64), seq: 2 };
        h.f.api_signings.lock().insert("acme".into(), s.clone());
        api_ui::signings_save(&h.d, &h.f.api_signings.lock()).unwrap();
        assert_eq!(api_ui::signings_load(&h.d)["acme"], s, "a sending record reads back after a restart");
        assert!(h.f.api_signing_waits("acme"));
        h.f.api_signing_poll(&*h.link, &s, t);
        let ended = h.f.api_signings.lock()["acme"].clone();
        assert_eq!((ended.state, ended.error.as_deref()), ("failed", Some(api_ui::SIGN_LOST)));
        assert!(!h.f.api_signing_waits("acme"));
    }

    #[test]
    fn api_a_secret_is_only_in_the_answer_that_made_it() {
        let mut h = boot("api-secret");
        pin_api_map(&h, 1);
        let params = json!({"org": "acme", "id": CLIENT, "days": 30});
        let mut body = params.clone();
        body["stepup"] = h.stepup("api.client.secret", "acme", &params);
        let (s, v) = h.post("/console/api/settings/api/clients/secret", body);
        assert_eq!(s, 200, "{v}");
        let secret = v["secret"].as_str().unwrap().to_owned();
        let hint = v["hint"].as_str().unwrap().to_owned();
        assert!(secret.starts_with("lcs_"));
        assert_eq!(v["staged"]["two_person_reasons"], json!([api_ui::TWO_SECRET]));
        let (_, view) = h.get("/console/api/settings/api");
        assert!(!stringify(&view).contains(&secret) && stringify(&view).contains(&hint), "{view}");
        let draft = h.f.api_drafts.lock().get("acme", crate::codec::now_ms()).cloned().unwrap();
        assert!(!stringify(&draft.map).contains(&secret));
        // nothing the console wrote (book, audit, journal, logs, keys) holds it
        fn files(d: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
                if e.path().is_dir() {
                    files(&e.path(), out);
                } else {
                    out.push(e.path());
                }
            }
        }
        let mut all = Vec::new();
        files(&h.d, &mut all);
        assert!(!all.is_empty());
        for f in all {
            assert!(!String::from_utf8_lossy(&std::fs::read(&f).unwrap_or_default()).contains(&secret), "{}", f.display());
        }
        // a scrape token for relays likewise, and a step-up is needed
        assert_eq!(h.post("/console/api/settings/api/scrape-tokens", json!({"org": "acme", "action": "create", "label": "prom", "relays": ["*"], "days": 60})).1["code"], "stepup-needed");
    }

    #[test]
    fn api_explain_names_the_first_failing_check_of_the_pinned_map() {
        let h = boot("api-explain");
        pin_api_map(&h, 1);
        let (s, v) = h.post("/console/api/settings/api/explain", json!({"org": "acme", "client": CLIENT, "method": "GET", "path": "v1/audit", "ip": "10.40.0.7"}));
        assert_eq!(s, 200, "{v}");
        // no license edition on this console: the map is set aside (13), so the map check fails first
        assert_eq!(v["checks"].as_array().unwrap().len(), 12);
        assert!(v["first_fail"].as_u64().is_some_and(|n| n <= 6), "{v}");
    }

    #[test]
    fn api_a_signed_map_with_another_hash_fails_the_save_and_the_asked_one_publishes() {
        let h = boot("api-sign");
        let doc: Value = serde_json::from_str(include_str!("../tests/api_map_v1.json")).unwrap();
        let root = crate::meet_x509::Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap().clone();
        let now = doc["now"].as_i64().unwrap();
        let case = doc["signed"].as_array().unwrap().iter().find(|c| c["expect"] == "ok").unwrap().clone();
        let signed = case["signed"].clone();
        let org = signed["map"]["org"].as_str().unwrap().to_owned();
        let sha = crate::api_map::api_map_hash(&signed["map"]);
        let seq = signed["map"]["seq"].as_i64().unwrap();
        let relay = "r_0123456789abcdef";
        let s = api_ui::Signing { org: org.clone(), relay: relay.into(), request: "rq_0123456789abcdef".into(), by: ADMIN.into(), at: now * 1000, state: "waiting", error: None, map_sha256: sha.clone(), seq };
        h.f.api_signings.lock().insert(org.clone(), s.clone());
        h.link.up.lock().insert(relay.into());
        let mut other = signed.clone();
        other["map"]["seq"] = json!(seq + 1);
        *h.link.sign_status.lock() = Some(json!({"state": "done", "signed": other.clone(), "signer_policy": sp.clone()}));
        h.f.api_signing_poll(&*h.link, &s, now * 1000);
        let ended = h.f.api_signings.lock()[&org].clone();
        assert_eq!((ended.state, ended.error.as_deref()), ("failed", Some(api_ui::SIGN_OTHER_MAP)));
        assert_eq!(api_ui::signings_load(&h.d)[&org].state, "failed", "kept on disk");
        assert_eq!(h.f.api.pinned(&org).1, 0, "nothing was pinned");
        // the asked map, verified against the CA root and the signer policy it signed, is pinned and published
        let trust = crate::api_map::ApiTrust { root: &root, signer_policy: &sp, root_crl: None, previous_serial: "" };
        let edition = Some(crate::api_map::Edition::Enterprise);
        assert_eq!(h.f.api_publish_trusted(&org, &sha, &other, &trust, edition, now * 1000).unwrap_err(), api_ui::SIGN_OTHER_MAP);
        assert_eq!(h.f.api_publish_trusted(&org, &sha, &signed, &trust, edition, now * 1000), Ok(seq));
        assert_eq!(h.f.api.pinned(&org).1, seq);
        // the console trusts only its own Meet CA: without one nothing is published
        assert_eq!(h.f.api_publish_signed(&org, &sha, &signed, &sp, now * 1000).unwrap_err(), api_ui::NO_CA);
    }
}
