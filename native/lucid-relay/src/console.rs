// The Lucid Admin Console (contract AC-1; ADR-A094 and core ADR-0540 D3 before it): one console app served by every
// Lucid relay process for what that process runs, under /console/. This file is its HTTP side: the source check, the
// request checks of 3.5, the dispatcher with its one table of (method, path, role), the headers of 3.10, the core
// routes of 4.2 and 4.5 to 4.7, the page's files, and the product-section interface (I9) the Remote Spokes and Meeting
// Hub sections implement. People, sign-in, sessions and step-up live in console_auth.rs; approvals and requests in
// console_approvals.rs; the audit chain in console_audit.rs; rate limits in console_limits.rs; the source address in
// console_source.rs; the settings book in console_settings.rs; passwords, TOTP and the lockout in console_password.rs;
// attestation and the MDS3 snapshot in console_mds.rs; mail in console_mail.rs; sealed secrets in console_seal.rs.
//
// Remote Spokes relay: OFF unless `--console 1` or LUCID_RELAY_CONSOLE=1 (needs --state, refused on a LAN mailbox),
// with `--console-sources`, `--console-trusted-fronts` (required behind a TLS front), `--console-first-admin`
// (required until the first admin signs in) and `--console-profile` (read only until then, 3.3). It also keeps the
// relay's own recent log lines (a ring fed by the logger's tap) and the spokes' log lines (POST /v1/logs). Never
// message contents.

use crate::codec::{exact_keys, parse_json, sha256_hex, str_of, stringify};
use crate::console_audit::{Audit, Record, RefusalEntry};
use crate::console_auth::{email_of, lock_state, Bind, Book, Inner, KeyKind, PersonRole, PersonState, StateLock, StepOk, Who};
use crate::console_limits::{rate_words, Limit};
use crate::console_mail::{MailConfig, Mailer, Mode};
use crate::console_mds::Mds;
use crate::console_seal::Seal;
use crate::console_settings::{Profile, ProfileAtStart, Rights};
use crate::console_source::{allowed, parse_cidr_list, source_key, source_of, Cidr, DEFAULT_SOURCES, FRONTS_MAX, SOURCES_MAX};
use crate::identity::is_node_id;
use crate::log::{secret_field, Fields, Level, Logger, Tap};
use crate::relay::Dialed;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

pub use crate::console_auth::CONSOLE_ANCHOR;
pub use crate::license::Product;

pub const CONSOLE_FILE: &str = "console.json";
/// What /v1/logs and /v1/console/invite answer (409) on a relay whose console is off.
pub const CONSOLE_OFF: &str = "the Admin Console is turned off on this relay (start it with --console 1 or LUCID_RELAY_CONSOLE=1)";
/// The header every console POST carries (with the console's Origin).
pub const MARKER_HEADER: &str = "x-lucid-console";
/// The header on requests a person caused (3.4): only those count as activity.
pub const ACTIVITY_HEADER: &str = "x-lucid-activity";
pub const COOKIE_SPOKES: &str = "__Host-lrc";
pub const COOKIE_MEET: &str = "__Host-lac";
pub const BODY_MAX: usize = 64 * 1024;
pub const LICENSE_BODY_MAX: usize = 16 * 1024;
/// `settings/mds`: the MDS3 blob (3.5).
pub const MDS_BODY_MAX: usize = crate::console_mds::MDS_MAX;
/// The relay's own lines kept for the console, and the longest one kept.
pub const RELAY_LINES: usize = 2000;
const RELAY_LINE_BYTES: usize = 16 * 1024;
/// Spoke lines: per node, nodes, and bytes across all nodes.
pub const SPOKE_LINES: usize = 500;
pub const SPOKE_NODES: usize = 1000;
pub const SPOKE_BYTES: usize = 32 * 1024 * 1024;
/// POST /v1/logs (src/console-logs.ts states the same): a line, lines a post, a post, posts a minute per node.
pub const LOG_LINE_BYTES: usize = 2048;
pub const LOG_POST_LINES: usize = 100;
pub const LOG_POST_BYTES: usize = 64 * 1024;
pub const LOG_POSTS_PER_MINUTE: usize = 6;
const PAGE_LINES: usize = 500;
pub const SOURCE_REFUSED: &str = "The Admin Console is not open to your network. Ask the person who runs this relay to add it to the console's allowed networks.";
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const SECURITY_HEADERS: [(&str, &str); 9] = [
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)"),
    ("Strict-Transport-Security", "max-age=31536000"),
    ("X-Robots-Tag", "noindex, nofollow"),
];

/// The 8.1 `attention.<kind>` words the relay itself mails (3.11 `mail.attention`); the page holds the same words.
pub const ATTENTION_WORDS: [(&str, &str); 48] = [
    ("license-none", "No license is installed for <product>."),
    ("license-grace", "The license ended. Service stops on <date and time> unless a new license is installed."),
    ("license-expired", "The license and its grace days are over."),
    ("license-expiring", "The license ends in <n> days. Install a new license before <date>."),
    ("seats-high", "<used> of <users> licensed people are in use."),
    ("seats-over", "<used> people use Meeting Hub; the license covers <users>. Day <day> of 14: seats are taken from <n> people on <date>."),
    ("uncounted", "<n> hubs were refused because they have no license seat."),
    ("crl-stale", "The revocation list is out of date. Ask the root holder to refresh it."),
    ("signer-unhealthy", "The certificate signer is not answering."),
    ("signer-expiring", "The signer's certificate ends in <n> days."),
    ("cert-expiring", "<n> certificates end within 7 days."),
    ("tls-expiring", "This console's TLS certificate ends in <n> days."),
    ("spokes-silent", "<n> spokes have not checked in for a day."),
    ("enrollments-waiting", "<n> devices are waiting for approval."),
    ("approvals-mine", "<n> changes are waiting for your approval."),
    ("requests-old", "<n> requests have waited more than 3 days."),
    ("admins-few", "Add another admin so changes that lower security need two people."),
    ("anchor-single", "Every admin's access depends on <label> (<id>). Invite an admin from another hub or device."),
    ("admin-suspended", "<email> is suspended."),
    ("passkey-waiting", "A new passkey for <email> is waiting."),
    ("joiner-waiting", "<email> joined from <hub or device> and is waiting for approval."),
    ("audit-broken", "The audit log does not verify from entry <n>. Changes are paused. Export what you have, then start a new chain."),
    ("audit-rotating", "The audit log will soon drop entries that were never exported. Export it now."),
    ("audit-dropped-unexported", "The audit log dropped entries <from> to <to> before they were exported."),
    ("audit-not-exported", "The audit log has not been exported for 30 days."),
    ("quota-hits", "<n> requests were refused for limits in the last hour."),
    ("blocks-active", "<n> blocks are active on this relay."),
    ("support-waiting", "<n> support tickets from Meeting Hub wait for an answer."),
    ("admins-unproven", "<n> admins have not signed in since the upgrade. Ask them to try now."),
    ("license-stopped", "This relay has stopped serving people: the <product> license is not active. Install a license."),
    ("license-upgrade-period", "Install a Meeting Hub license by <date and time>, or this relay stops serving people."),
    ("seats-unseated", "<n> people have no Meeting Hub seat."),
    ("seats-protected", "Admins alone use more seats than the license covers. Request more seats."),
    ("profile-standard", "This console was moved from the High security profile to Standard, which allows passwords with authenticator apps. Switch back to High if it serves a government deployment."),
    ("two-person-off", "This console has <n> admins. Turn on Require a second admin for sensitive changes."),
    ("break-glass-missing", "There is no break-glass account. The person who runs this relay creates one with lucid-relay console break-glass."),
    ("break-glass-used", "The break-glass account <email> signed in on <time>."),
    ("key-unattested", "<n> admins or user managers have no approved security key, so they have viewer rights."),
    ("mds-old", "The security key metadata is more than 90 days out of date. Update it in Settings."),
    ("signin-locked", "<n> accounts were locked after failed sign-ins in the last hour."),
    ("mail-failing", "Email is failing: <reason>. Check Settings, Email."),
    ("clock-uncertain", "This relay's clock jumped or was off for more than a day, so seat deadlines are on hold. Check the time, then confirm it. If no one confirms it within <n> hours, people over the license are held without service until someone does."),
    ("seats-held", "<n> people over the license have no service because the relay's time was not confirmed for 72 hours. Confirm the relay's time to release them."),
    ("seal-machine-scope", "Secrets are protected by machine-wide Windows DPAPI, which any account on this computer can unlock. Run lucid-relay console seal-setup to use the relay's own service account."),
    ("clock-back", "This relay's clock is behind the last time it trusted. Deadlines still count from that time. Fix the clock."),
    ("aaguids-relaxed", "Some approved security key models have no FIPS certificate in their metadata. Under the High profile they would not count."),
    ("seal-key-file", "Secrets are protected by a key file next to the state. Run lucid-relay console seal-setup to use the relay's service account or a systemd encrypted credential, as the High profile needs."),
    ("seal-lost", "Saved secrets could not be unlocked on this host. Email is off; enter its secrets again. Authenticator apps must be set up again."),
];

/// AC-2a 13.1 (revision 3.4): the fleet console's license items, so `mail.attention` renders them too.
pub const FLEET_ATTENTION_WORDS: [(&str, &str); 3] = [
    ("relay-license-stopped", "<relay> stopped: no active license. It serves no one until a license is installed."),
    ("relay-license-grace", "The license of <relay> has ended. Service stops on <date and time> unless a new license is installed."),
    ("relay-license-expiring", "The license of <relay> ends in <days> days."),
];

/// The attention words of `kind` with its args filled in (`<hub or device>` from `from`; a `<date and time>` given in
/// ms as `2026-11-18 10:00 UTC`, a `<date>` in ms as `2026-11-18`); None for an unknown kind.
pub fn attention_words(kind: &str, args: &Value) -> Option<String> {
    let (_, words) = ATTENTION_WORDS.iter().chain(FLEET_ATTENTION_WORDS.iter()).find(|(k, _)| *k == kind)?;
    let mut out = String::new();
    let mut rest = *words;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else { break };
        let name = &rest[i + 1..i + j];
        let key = if name == "hub or device" { "from" } else { name };
        match args.get(key) {
            Some(Value::Number(n)) if key == "date and time" => out.push_str(&n.as_i64().map(crate::license_reminders::when).unwrap_or_default()),
            Some(Value::Number(n)) if key == "date" => out.push_str(&n.as_i64().map(crate::license_reminders::day).unwrap_or_default()),
            Some(Value::String(s)) => out.push_str(&crate::console_auth::clean(s)),
            Some(Value::Null) | None => {}
            Some(v) => out.push_str(&v.to_string()),
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    Some(out)
}

pub fn level_of(s: &str) -> Option<Level> {
    match s {
        "debug" => Some(Level::Debug),
        "info" => Some(Level::Info),
        "warn" => Some(Level::Warn),
        "error" => Some(Level::Error),
        _ => None,
    }
}

// ── I9: the product section ─────────────────────────────────────────────────────────────────────────────────

/// A route's role (4.1): `None` no session, `Any` any session, `Viewer` active viewers, user managers and admins,
/// `Manager` sessions holding user manager or admin rights, `Admin` sessions holding admin rights (2.3: rights by
/// profile, attestation and anchor).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    None,
    Any,
    Viewer,
    Manager,
    Admin,
}

/// The product license's state as the console uses it (2.4): `None` is none, the wrong product or the wrong root.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LicenseState {
    Valid,
    Grace,
    Expired,
    None,
}

impl LicenseState {
    pub fn as_str(self) -> &'static str {
        match self {
            LicenseState::Valid => "valid",
            LicenseState::Grace => "grace",
            LicenseState::Expired => "expired",
            LicenseState::None => "none",
        }
    }
}

/// What a write needs of the license: any state, or the product license in valid or grace.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Need {
    Any,
    Product,
}

/// One row of the dispatcher's table.
#[derive(Debug)]
pub struct RouteSpec {
    pub method: &'static str,
    /// After /console/api/.
    pub path: &'static str,
    pub role: Role,
    /// The audit event and step-up action ("" for GET routes).
    pub action: &'static str,
    /// The body field that names the target, "-" for none, or "principal+device" for `<principal>/<device>`.
    pub target: &'static str,
    pub stepup: bool,
    pub need: Need,
    /// A 2.4 security action: allowed in every license state and while the audit is broken (`after_torn`).
    pub security: bool,
    /// The body keys allowed ("stepup" not listed; it is allowed when `stepup` is set).
    pub keys: &'static [&'static str],
    pub body_max: usize,
}

/// The signed-in caller a product route sees.
pub struct Caller {
    pub email: String,
    /// Admin rights in this session.
    pub admin: bool,
    /// User manager or admin rights in this session.
    pub manager: bool,
    pub ip: String,
}

pub struct SectionCall<'a> {
    pub spec: &'static RouteSpec,
    pub query: &'a str,
    /// The body without "stepup".
    pub body: &'a Value,
    pub caller: &'a Caller,
    pub license: LicenseState,
    pub t: i64,
}

pub enum SectionAnswer {
    /// A GET answer (with "ok": true).
    Read(Value),
    /// Ran now; audited `ok`.
    Done { answer: Value, target: String, detail: Value },
    /// Needs a second admin: the core runs the sole-admin path (calls `execute` at once) or makes the approval.
    Second { target: String, params: Value, detail: Value },
}

/// An approved (or sole-admin) action to carry out as its requester.
pub struct Approved<'a> {
    pub action: &'a str,
    pub target: &'a str,
    pub params: &'a Value,
    pub requested_by: &'a str,
    /// None on the sole-admin path.
    pub approved_by: Option<&'a str>,
    pub t: i64,
}

pub struct LicenseView {
    /// null, or the 4.7 license object.
    pub license: Value,
    pub problem: Option<String>,
    pub state: LicenseState,
    /// The 4.7 `service` (R42-1).
    pub service: ServiceView,
}

/// Whether the relay serves people (AC-1 2.4, R42-1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ServiceState {
    On,
    Grace,
    UpgradePeriod,
    Stopped,
}

impl ServiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceState::On => "on",
            ServiceState::Grace => "grace",
            ServiceState::UpgradePeriod => "upgrade-period",
            ServiceState::Stopped => "stopped",
        }
    }

    /// The AC-2a 9.1 `license_service` code: 0 stopped, 1 on, 2 grace, 3 upgrade period.
    pub fn code(self) -> u8 {
        match self {
            ServiceState::Stopped => 0,
            ServiceState::On => 1,
            ServiceState::Grace => 2,
            ServiceState::UpgradePeriod => 3,
        }
    }
}

/// The service a product section reports (4.7 `service`, R42-1), judged at `at` (ms; trusted time on Meeting Hub, the
/// license clock on Remote Spokes, R7-M1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceView {
    pub state: ServiceState,
    /// The end of grace or of the upgrade period (ms).
    pub stops_at: Option<i64>,
    /// None, or "none", "wrong-product", "wrong-root", "invalid", "expired".
    pub why: Option<&'static str>,
    /// The verifier's words for a refused token (8.1 `license.why` `<verifier words>`), only with `why` "invalid",
    /// "wrong-product" or "wrong-root"; never the token.
    pub reason: Option<String>,
    pub upgrade_period_ends: Option<i64>,
    /// The fitting license's id (also past its grace); None with none or during an upgrade period alone.
    pub license_id: Option<String>,
    /// The fitting license's `exp` (ms).
    pub exp: Option<i64>,
    pub at: i64,
}

impl ServiceView {
    /// Always on, no license (a fleet console, which holds no product license).
    pub fn on(at: i64) -> ServiceView {
        ServiceView { state: ServiceState::On, stops_at: None, why: None, reason: None, upgrade_period_ends: None, license_id: None, exp: None, at }
    }

    /// Stopped for want of a license.
    pub fn none(at: i64) -> ServiceView {
        ServiceView { state: ServiceState::Stopped, why: Some("none"), ..ServiceView::on(at) }
    }

    /// The 4.7 JSON without `reminders`.
    pub fn to_value(&self) -> Value {
        json!({ "state": self.state.as_str(), "stopsAt": self.stops_at, "why": self.why, "upgradePeriodEnds": self.upgrade_period_ends })
    }
}

/// A license as 4.7 compares it (R6-M1): Meeting Hub keeps the last fitting one as `meet-seats.json` `lastLicense`
/// (`{product, root, id, edition, users, relays, exp}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenseRecord {
    pub product: Product,
    pub root: String,
    pub id: String,
    pub edition: String,
    pub users: i64,
    pub relays: i64,
    pub exp: i64,
}

impl LicenseRecord {
    pub fn of(l: &crate::license::License) -> LicenseRecord {
        LicenseRecord { product: l.product(), root: l.root.clone(), id: l.id.clone(), edition: l.edition.clone(), users: l.users, relays: l.relays, exp: l.exp }
    }
}

/// 4.7 (M1, R6-M1): one admin may install a first license (no reference license) or a renewal of the reference license:
/// valid (not in grace), the same product, root, `id` and edition, a later `exp`, and `users` and `relays` no
/// smaller. Everything else (another `id`, an earlier `exp`, a token in grace, fewer `users` or `relays`, another
/// edition) is a second-admin change.
pub fn one_admin_install(reference: Option<&LicenseRecord>, offered: &LicenseRecord, offered_valid: bool) -> bool {
    let Some(r) = reference else { return true };
    offered_valid
        && offered.product == r.product
        && offered.root == r.root
        && offered.id == r.id
        && offered.edition == r.edition
        && offered.exp > r.exp
        && offered.users >= r.users
        && offered.relays >= r.relays
}

/// What a product section reports about a token offered to `license/install` (4.7); the core decides who may
/// install it (`one_admin_install`).
pub struct LicenseCandidate {
    pub offered: LicenseRecord,
    /// In its valid period (not in grace).
    pub valid: bool,
    /// Past its grace days: refused always.
    pub ended: bool,
    /// The reference license (R6-M1): the current fitting license when one is in force; on Meeting Hub otherwise
    /// `lastLicense`; on Remote Spokes otherwise none. None is a first license.
    pub reference: Option<LicenseRecord>,
    pub view: Value,
}

impl LicenseCandidate {
    pub fn id(&self) -> &str {
        &self.offered.id
    }

    /// A first license or a renewal of the reference license: one admin (4.7).
    pub fn single(&self) -> bool {
        one_admin_install(self.reference.as_ref(), &self.offered, self.valid)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdminRule {
    Admin,
    /// Meeting Hub: signed in with a passkey not anchored to one of the principal's own devices.
    ViewerOnly,
    /// Meeting Hub: the principal is not in relay.json `admins` (suspended with reason `not-relay-admin`).
    NotRelayAdmin,
}

/// The product section of one relay process (I9): Remote Spokes (console_spokes.rs) or Meeting Hub (console_meet.rs).
/// The console never holds its own lock while it calls one of these.
pub trait ProductSection: Send + Sync {
    fn routes(&self) -> &'static [RouteSpec];
    fn sections(&self, license: LicenseState) -> Vec<&'static str>;
    fn relay_info(&self, t: i64) -> Value;
    fn license(&self, t: i64) -> LicenseView;
    fn overview_cards(&self, admin: bool, t: i64) -> Vec<Value>;
    fn attention(&self, admin: bool, t: i64) -> Vec<Value>;
    fn search(&self, q: &str, admin: bool, t: i64) -> Vec<Value>;
    fn security_actions(&self) -> &'static [&'static str];
    fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError>;
    fn execute(&self, run: &Approved) -> Result<Value, ApiError>;
    fn may_approve(&self, _action: &str, _params: &Value, _approver: &str) -> bool {
        true
    }
    fn license_candidate(&self, token: &str, t: i64) -> Result<LicenseCandidate, ApiError>;
    fn license_install(&self, token: &str, t: i64) -> Result<Value, ApiError>;
    fn request_target(&self, kind: &str, target: &Value) -> Result<Value, ApiError>;
    fn admin_rule(&self, _email: &str, _anchor: &str) -> AdminRule {
        AdminRule::Admin
    }
    fn relay_lines(&self, _f: &Filter) -> Option<Vec<String>> {
        None
    }
    /// The console changed who is an admin or active (a promotion, an unsuspension, a removal, a role change): the
    /// product applies what follows from it (Meeting Hub: protected people always hold a seat, R3-M6).
    fn people_changed(&self, _t: i64) {}
}

// ── Refusals (8.3) ──────────────────────────────────────────────────────────────────────────────────────────

/// A refusal: the status, the 8.3 code and its words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<i64>,
}

/// The 8.3 table: status and words (a placeholder filled in generically; `ApiError::with` gives the exact words).
pub fn code_words(code: &str) -> Option<(u16, &'static str)> {
    Some(match code {
        "signin-first" => (401, "Sign in first."),
        "signin-refused" => (403, crate::console_auth::SIGNIN_REFUSED),
        "signin-wait" => (429, "Too many tries. Try again in 10 minutes."),
        "banner-needed" => (400, "Accept the notice before you sign in."),
        "password-length" => (400, "A password here needs 15 to 128 characters."),
        "password-weak" => (400, "Choose a different password: this one is too common or easy to guess."),
        "password-wrong" => (403, "Your current password is not right. Nothing was changed."),
        "totp-wrong" => (403, "That code did not work. Use the newest code from your authenticator app."),
        "profile-high" => (409, "The High security profile does not allow this."),
        "profile-government" => (409, crate::console_settings::PROFILE_GOVERNMENT),
        // AC-2b-D 13.3
        "deploy-product" => (400, "Choose Meeting Hub or Remote Spokes."),
        "deploy-env" => (400, "Choose where the relay runs."),
        "deploy-host" => (400, "Enter a DNS name of letters, digits, dots and dashes, or an IP address where allowed."),
        "deploy-host-taken" => (409, "<relay> already holds a certificate for <host>. Use Replace <relay>."),
        "deploy-clients" => (400, "Enter networks as addresses with a prefix, such as 203.0.113.0/24."),
        "deploy-high" => (403, "Under the High profile this console does not hand out the relay program. Install it from your verified release media."),
        "deploy-unavailable" => (404, "This console cannot hand out the Linux relay program."),
        "deploy-rate" => (429, "Too many downloads from this address. Try again in <minutes> minutes."),
        "deploy-busy" => (503, "The console is sending the relay program to other hosts. Try again in a minute."),
        "deploy-ca-needed" => (409, "Import the Meeting Hub organization CA first, or bring the relay's certificate yourself."),
        "deploy-license-product" => (409, "That license is for <product>."),
        "deploy-license-root" => (409, "That license is for root <root>, not <id>."),
        "deploy-csr" => (400, "The relay's certificate request is not for <names>."),
        "meet-cert-wait" => (429, "This relay renewed its certificate less than a day ago."),
        "fleet-ca-held" => (409, "This console holds the organization CA this High relay trusts, so the relay cannot join it."),
        "meet-ca-high" => (409, "Under the High profile the organization CA stays on its own signer. This console does not hold it."),
        "meet-ca-high-relay" => (409, "A High Meeting Hub relay trusts this CA, may trust it (it has not reported which CAs it trusts), or is still joining, so this console cannot hold it."),
        "meet-ca-confirm" => (400, "Confirm that no High Meeting Hub relay anywhere trusts this CA."),
        "meet-ca-seal" => (409, "Holding the organization CA needs a sealing provider bound to this host (systemd credential or Windows service account). Run lucid-relay console seal-setup --role console."),
        "meet-ca-exists" => (409, "This console already holds an organization CA. Remove it first."),
        "meet-ca-key" => (400, "That key does not belong to that CA certificate, or it is not a P-256 CA valid for 120 more days."),
        "meet-ca-signer" => (400, "Enter the certificate server as https:// and its host name."),
        "meet-ca-in-use" => (409, "<n> relays still use certificates from this CA. Confirm that you will sign its revocation lists elsewhere."),
        "meet-ca-lost" => (503, "The CA key cannot be opened. Import it again."),
        "meet-ca-prune" => (409, "That certificate was not issued by this CA, is not on the list, or has not ended yet. A revocation stays while its certificate can still be used."),
        "spokes-root-key" => (400, "That is not a P-256 public key. Upload root.pub, never the private key."),
        "spokes-root-license" => (409, "No license in the library names root <id>."),
        "not-manageable" => (403, "A user manager can do this only for viewers and user managers."),
        "invite-role" => (403, "A user manager can invite viewers and user managers only."),
        "last-method" => (409, "This would leave you no way to sign in. Add another method before you remove it."),
        "seat-protected" => (409, "This person is a relay admin or console admin and always keeps a seat."),
        "not-over" => (409, "This relay is within its seats, so no one gives up a seat."),
        "mail-off" => (409, "Email is off. Set it up in Settings, Email."),
        "mail-secret-high" => (400, "Under the High security profile, Microsoft Graph needs a certificate, not a client secret."),
        "mail-failed" => (502, "The mail server did not accept the message."),
        "mds-refused" => (400, "This metadata file cannot be used."),
        "break-glass-needed" => (409, "This console needs its break-glass account before it can be administered. The person who runs this relay creates it with lucid-relay console break-glass."),
        "seal-provider-needed" => (409, "Under the High profile, secrets need the relay's own service account on Windows or a systemd encrypted credential set up by lucid-relay console seal-setup, and this relay has neither. Nothing was saved."),
        "bad-mailbox" => (400, "That is not an email address this console can send to or from."),
        "clock-disagree" => (409, "The relay's clock and your browser differ by more than 5 minutes. Fix the relay's clock first."),
        "license-inactive" => (403, "Your organization's Meeting Hub license is not active. Ask your admin."),
        "no-seat" => (403, "Your organization has no Meeting Hub seat for you. Ask your admin."),
        "waiting" => (403, "An admin of this console must approve you before you can sign in."),
        "suspended" => (403, "Your access to this console is suspended. Ask another admin."),
        "anchor-revoked" => (403, crate::console_auth::REVOKED_SPOKES),
        "role" => (403, "Only an admin can do this."),
        "stepup-needed" => (401, "Confirm with your passkey to do this."),
        "stepup-expired" => (410, "The confirmation took too long. Try again."),
        "stepup-failed" => (403, "Your passkey did not confirm this. Nothing was changed."),
        "not-eligible" => (403, "Another admin must approve this. You asked for it, or it is about you."),
        "no-approver" => (409, "Another admin must approve this. Unsuspend or add an admin first."),
        "gone" => (410, "This is no longer waiting."),
        "approval-exists" => (409, "This change is already waiting for approval."),
        "request-exists" => (409, "This request is already waiting."),
        "exists" => (409, "This person already has access to this console."),
        "not-waiting" => (409, "This person is not waiting for approval."),
        "not-relay-admin" => (409, "On a Meeting Hub relay, admins must be relay admins (relay.json admins). Add them there first, or invite them as a viewer."),
        "not-device-anchored" => (409, "This person must first join from their own device in the Meeting Hub app."),
        "last-admin" => (409, "This would leave the console with no active admin."),
        "passkey-limit" => (409, "You have the most passkeys and security keys allowed (10, of which 4 that need your email). Remove one first."),
        "invite-limit" => (429, "You have made 10 invites today. Try again tomorrow."),
        "people-limit" => (409, "This console has 50 people, the most allowed."),
        "joiner-limit" => (409, "20 people are already waiting for approval. Approve or remove some first."),
        "bootstrap-pinned" => (409, "This console waits for its first admin."),
        "bad-url" => (400, "Links must start with https:// and name a host."),
        "license-refused" => (400, "This license cannot be used here."),
        "license-ended" => (400, "This license has already ended. Install a current one."),
        "license-path" => (409, "This relay reads its license from another file. Replace that file and restart the relay."),
        "license-needed" => (402, "This needs a license that includes this product."),
        "license-expired" => (402, "The license and its grace days are over. Install a new license to make this change."),
        "crl-refused" => (400, "This revocation list cannot be used."),
        "directory-refused" => (400, "This relay directory cannot be used."),
        "not-found" => (404, "There is no such page."),
        "rate" => (429, "Too many requests. Try again in 1 minute."),
        "source" => (403, SOURCE_REFUSED),
        "origin" => (403, "Refused: this request did not come from the console's own page."),
        "origin-session" => (409, "This session belongs to another address. Sign in here."),
        "stale" => (409, "Nothing was changed: it no longer applies."),
        "unknown-field" => (400, "Unknown field."),
        "audit-broken" => (503, "The audit log could not be read, so changes are paused. See the Overview."),
        "state-unreadable" => (503, "The console could not read its state; see the relay's log."),
        "write-failed" => (500, "The console could not save its state; see the relay's log."),
        "invalid" => (400, "This request is not valid."),
        "host" => (421, "This relay does not answer for that host name."),
        "method" => (405, "Method not allowed."),
        "too-large" => (413, "Request too large."),
        "json" => (415, "Send JSON."),
        // AC-2a 13.3 (`<placeholders>` filled by `ApiError::with` where they appear).
        "setup-needed" => (409, "Finish the first step of setup first."),
        "setup-code" => (403, "That setup code is not right. It is in setup-code.txt on the console's host."),
        "setup-done" => (409, "This console is already set up. Sign in instead."),
        "fleet-code" => (400, "That enrollment code is not complete. Copy it again from the Admin Console."),
        "fleet-code-expired" => (410, "That enrollment code has ended or was already used. Ask for a new one."),
        "fleet-product" => (409, "This code is for a <product> relay. Run it on a <product> relay."),
        "fleet-pin" => (403, "This console's identity does not match the code. Ask the console's admin for a new code."),
        "fleet-preview-changed" => (409, "The console changed since you checked it. Run the command again."),
        "fleet-profile" => (409, "This console and this relay are not in the same security profile. A High relay works only with a High console, and a High console only with High relays in FIPS mode."),
        "fleet-limit" => (409, "This console already manages 200 relays."),
        "enroll-limit" => (429, "Too many open enrollment codes. Use or cancel one first."),
        "fingerprint" => (409, "That fingerprint does not match this relay. Do not confirm it."),
        "fleet-scope" => (403, "This relay did not give the Admin Console the <scope> scope."),
        "fleet-scope-required" => (409, "Health and status is always given."),
        "fleet-scope-unknown" => (400, "This relay does not know the scope <scope> yet."),
        "fleet-route" => (404, "This page is not available through the Admin Console."),
        "fleet-read-only" => (403, "This relay is set to read only from the Admin Console. Its operator can change that on the relay."),
        "fleet-confirm" => (202, "This relay's operator confirms this change on the relay. It runs when they do."),
        "fleet-stepup" => (403, "The relay could not verify your confirmation. Try again."),
        "fleet-counter" => (403, "The relay saw this security key go backwards and refused it. Tell your security team."),
        "fleet-roster" => (403, "This relay does not know your key yet. An admin must confirm new keys first."),
        "fleet-webauthn" => (403, "Changes on relays need a passkey or security key. Add one in Your account."),
        "fleet-second" => (409, "This change needs a second admin. Ask another admin to approve it in the Admin Console."),
        "fleet-op" => (400, "The relay did not understand the console. Check that both run supported versions."),
        "fleet-bootstrap" => (409, "This relay does not trust any admin key yet. Admins endorse their keys from the IDE plugin or the Hub app."),
        "fleet-roster-duplicate" => (409, "Two admin entries use the same key. The relay trusts none of them."),
        "endorse-refused" => (403, "The relay did not accept this endorsement: <why>."),
        "fleet-not-bootstrapping" => (409, "This relay is not waiting for admin keys."),
        "recovery-refused" => (403, "This relay cannot replace its certificate this way. Enroll it again with a Replace code."),
        "trust-time-refused" => (409, "The time was not reset: the console did not send a newer trust list, signed by its CA and dated within 10 minutes of this host's clock."),
        "fleet-scope-needs-people" => (409, "Logs and audit name people, so they need the People scope too."),
        "relay-offline" => (503, "<relay> is not connected right now."),
        "relay-timeout" => (504, "<relay> did not answer in time."),
        "relay-busy" => (429, "<relay> is busy. Try again in a moment."),
        "relay-unconfirmed" => (409, "Confirm <relay> before making changes on it."),
        "csv-invalid" => (400, "That file is not a CSV with the columns email, name, product, role, relay and days."),
        "csv-limit" => (413, "A CSV can have at most 500 rows and 256 KiB."),
        "csv-changed" => (409, "The list changed since it was checked. Check it again."),
        "request-limit" => (409, "That relay already has 200 waiting requests."),
        "token-limit" => (409, "This console already has 10 scrape tokens. Revoke one first."),
        "siem-failed" => (502, "The test message did not reach the SIEM: <why>. Nothing was changed."),
        "siem-ca-needed" => (409, "The High profile needs the SIEM's certificate authority. Paste its PEM."),
        "fips-needed" => (409, "The High profile needs the FIPS build for this."),
        "rate-limited" => (429, "Too many requests. Try again in 1 minute."),
        _ => return None,
    })
}

/// Every code of the refusal table (AC-1 8.3 and AC-2a 13.3), for codes that arrive as text (a relay's answer).
const CODES: [&str; 145] = [
    "signin-first", "signin-refused", "signin-wait", "banner-needed", "password-length", "password-weak", "password-wrong", "totp-wrong", "profile-high", "not-manageable",
    "invite-role", "last-method", "seat-protected", "not-over", "mail-off", "mail-secret-high", "mail-failed", "mds-refused", "break-glass-needed", "seal-provider-needed",
    "bad-mailbox", "clock-disagree", "license-inactive", "no-seat", "waiting", "suspended", "anchor-revoked", "role", "stepup-needed", "stepup-expired",
    "stepup-failed", "not-eligible", "no-approver", "gone", "approval-exists", "request-exists", "exists", "not-waiting", "not-relay-admin", "not-device-anchored",
    "last-admin", "passkey-limit", "invite-limit", "people-limit", "joiner-limit", "bootstrap-pinned", "bad-url", "license-refused", "license-ended", "license-path",
    "license-needed", "license-expired", "crl-refused", "directory-refused", "not-found", "rate", "source", "origin", "origin-session", "stale",
    "unknown-field", "audit-broken", "state-unreadable", "write-failed", "invalid", "host", "method", "too-large", "json", "setup-needed",
    "setup-code", "setup-done", "fleet-code", "fleet-code-expired", "fleet-product", "fleet-pin", "fleet-preview-changed", "fleet-profile", "fleet-limit", "enroll-limit",
    "fingerprint", "fleet-scope", "fleet-scope-required", "fleet-scope-unknown", "fleet-route", "fleet-read-only", "fleet-confirm", "fleet-stepup", "fleet-counter", "fleet-roster",
    "fleet-webauthn", "fleet-second", "fleet-op", "fleet-bootstrap", "fleet-roster-duplicate", "endorse-refused", "fleet-not-bootstrapping", "recovery-refused", "trust-time-refused", "fleet-scope-needs-people",
    "relay-offline", "relay-timeout", "relay-busy", "relay-unconfirmed", "csv-invalid", "csv-limit", "csv-changed", "request-limit", "token-limit", "siem-failed",
    "siem-ca-needed", "fips-needed", "rate-limited", "csv-email", "csv-role", "csv-relay", "scope", "profile-government",
    // AC-2b-D 13.3
    "deploy-product", "deploy-env", "deploy-host", "deploy-host-taken", "deploy-clients", "deploy-high", "deploy-unavailable", "deploy-rate", "deploy-busy", "deploy-ca-needed",
    "deploy-license-product", "deploy-license-root", "deploy-csr", "meet-cert-wait", "fleet-ca-held", "meet-ca-high", "meet-ca-high-relay", "meet-ca-confirm", "meet-ca-seal", "meet-ca-exists",
    "meet-ca-key", "meet-ca-signer", "meet-ca-in-use", "meet-ca-lost", "meet-ca-prune", "spokes-root-key", "spokes-root-license",
];

/// The static code for a code that arrives as text (a relay's answer, 5.1); None for a code not in the table.
pub fn code_words_static(code: &str) -> Option<&'static str> {
    CODES.iter().copied().find(|c| *c == code)
}

impl ApiError {
    /// The 8.3 refusal `code` with its table words.
    pub fn of(code: &'static str) -> ApiError {
        let (status, words) = code_words(code).unwrap_or((500, "The console could not answer; see the relay's log."));
        ApiError { status, code, message: words.to_owned(), retry_after: None }
    }

    /// The 8.3 refusal `code` with its words filled in.
    pub fn with(code: &'static str, words: impl Into<String>) -> ApiError {
        ApiError { message: words.into(), ..ApiError::of(code) }
    }

    /// A `rate` refusal with Retry-After.
    pub fn rate(retry_secs: i64) -> ApiError {
        ApiError { status: 429, code: "rate", message: rate_words(retry_secs), retry_after: Some(retry_secs.max(1)) }
    }
}

thread_local! {
    /// One extra field of the refusal being answered on this thread (an existing approval or request, 409).
    static EXTRA: RefCell<Option<(&'static str, Value)>> = const { RefCell::new(None) };
}

/// What a handler answers: the status, the JSON body (or a file), a Set-Cookie.
pub struct Out {
    pub status: u16,
    pub body: Value,
    pub cookie: Option<String>,
    /// A download: bytes, content type, Content-Disposition.
    pub file: Option<(Vec<u8>, &'static str, String)>,
}

impl Out {
    pub fn ok(body: Value) -> Out {
        Out { status: 200, body, cookie: None, file: None }
    }
}

/// A write's result with what its audit entry says (`result` "" for a step that changes nothing).
pub struct Done {
    pub out: Out,
    pub target: Option<String>,
    pub result: &'static str,
    pub approval: Option<String>,
    pub detail: Value,
}

impl Done {
    pub(crate) fn plain(out: Out) -> Done {
        Done { out, target: None, result: "", approval: None, detail: Value::Null }
    }

    pub(crate) fn ok(out: Out, target: Option<String>, detail: Value) -> Done {
        Done { out, target, result: "ok", approval: None, detail }
    }
}

// ── Log rings ───────────────────────────────────────────────────────────────────────────────────────────────

struct Line {
    cat: String,
    level: Level,
    json: String,
}

/// Which lines a reader wants: one category or all, the lowest level, and text to match.
pub struct Filter {
    pub cat: Option<String>,
    pub min: Level,
    pub q: Option<String>,
}

impl Filter {
    /// Whether a line (its category, level and JSON text) passes: product sections use it for their own rings.
    pub fn keeps_json(&self, cat: &str, level: Level, json: &str) -> bool {
        level >= self.min && self.cat.as_ref().is_none_or(|c| c == cat) && self.q.as_ref().is_none_or(|q| json.to_lowercase().contains(&q.to_lowercase()))
    }

    fn keeps(&self, l: &Line) -> bool {
        self.keeps_json(&l.cat, l.level, &l.json)
    }
}

#[derive(Default)]
struct RingInner {
    lines: VecDeque<Line>,
    hits: IndexMap<String, u64>,
    hits_at: VecDeque<i64>,
}

/// The relay's own recent log lines, fed by the logger's tap: the newest RELAY_LINES, and the quota refusals counted.
#[derive(Default)]
pub struct LineRing(parking_lot::Mutex<RingInner>);

impl LineRing {
    /// The tap to hand the logger (Logger::with_tap).
    pub fn tap(self: &Arc<Self>) -> Tap {
        let ring = self.clone();
        Arc::new(move |cat: &str, level: Level, event: &str, json: &str| ring.push(cat, level, event, json))
    }

    fn push(&self, cat: &str, level: Level, event: &str, json: &str) {
        let mut r = self.0.lock();
        // Refusals counted for "quotas hit" (seen through the log tap).
        if crate::fleet_probe::QUOTA_EVENTS.contains(&event) {
            // AC-2a 9.1 `quota_hits` (F9).
            crate::fleet_probe::counters().quota_hit();
            *r.hits.entry(event.to_owned()).or_insert(0) += 1;
            let now = crate::codec::now_ms();
            r.hits_at.push_back(now);
            while r.hits_at.front().is_some_and(|at| now - *at > 3_600_000) || r.hits_at.len() > 100_000 {
                r.hits_at.pop_front();
            }
        }
        if json.len() > RELAY_LINE_BYTES {
            return;
        }
        if r.lines.len() >= RELAY_LINES {
            r.lines.pop_front();
        }
        r.lines.push_back(Line { cat: cat.to_owned(), level, json: json.to_owned() });
    }

    /// The matching lines as written, newest first.
    pub fn lines(&self, f: &Filter) -> Vec<String> {
        self.0.lock().lines.iter().rev().filter(|l| f.keeps(l)).map(|l| l.json.clone()).collect()
    }

    fn hits(&self) -> Value {
        let r = self.0.lock();
        Value::Object(r.hits.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect())
    }

    /// Quota refusals in the last hour.
    fn hits_last_hour(&self, t: i64) -> usize {
        self.0.lock().hits_at.iter().filter(|at| t - **at <= 3_600_000).count()
    }
}

#[derive(Default)]
struct SpokeRing {
    lines: VecDeque<Line>,
    bytes: usize,
    last: i64,
}

#[derive(Default)]
pub(crate) struct SpokeLogs {
    /// Least recently posting first.
    nodes: IndexMap<String, SpokeRing>,
    posts: HashMap<String, VecDeque<i64>>,
    bytes: usize,
}

/// Why a signed op was refused: the status, the error the caller sees, the security event.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused {
    pub status: u16,
    pub error: String,
    pub event: &'static str,
}

fn refused(status: u16, error: impl Into<String>, event: &'static str) -> Refused {
    Refused { status, error: error.into(), event }
}

/// The lines of one POST /v1/logs body, checked: `{"lines":[...]}`, 1 to 100 objects, each at most 2048 bytes as
/// JSON, security or ops, with a level and an event; secret-looking fields dropped.
fn parse_log_post(body: &str) -> Result<Vec<Line>, &'static str> {
    const MALFORMED: &str = "malformed log lines: {\"lines\":[...]} of objects with cat, level and event";
    if body.len() > LOG_POST_BYTES {
        return Err("a post carries at most 64 KiB of log lines");
    }
    let parsed = parse_json(body).ok_or(MALFORMED)?;
    let o = parsed.as_object().filter(|o| exact_keys(o, &["lines"], &["lines"])).ok_or(MALFORMED)?;
    let list = o.get("lines").and_then(Value::as_array).ok_or(MALFORMED)?;
    if list.is_empty() || list.len() > LOG_POST_LINES {
        return Err("a post carries 1 to 100 log lines");
    }
    let mut out = Vec::with_capacity(list.len());
    for v in list {
        let mut line = v.as_object().ok_or(MALFORMED)?.clone();
        if stringify(v).len() > LOG_LINE_BYTES {
            return Err("a log line is at most 2048 bytes");
        }
        let cat = str_of(line.get("cat")).ok_or(MALFORMED)?.to_owned();
        if cat != "security" && cat != "ops" {
            return Err("only security and ops log lines are taken");
        }
        let level = str_of(line.get("level")).and_then(level_of).ok_or(MALFORMED)?;
        if !str_of(line.get("event")).is_some_and(|e| (1..=120).contains(&e.len())) {
            return Err(MALFORMED);
        }
        line.retain(|k, _| !secret_field(k));
        out.push(Line { cat, level, json: stringify(&Value::Object(line)) });
    }
    Ok(out)
}

impl SpokeLogs {
    fn take(&mut self, node: &str, body: &str, t: i64) -> Result<usize, Refused> {
        // Every post counts against the rate, a refused one too.
        self.posts.retain(|_, p| p.back().is_some_and(|at| t - *at < 60_000));
        let posts = self.posts.entry(node.to_owned()).or_default();
        while posts.front().is_some_and(|at| t - *at >= 60_000) {
            posts.pop_front();
        }
        if posts.len() >= LOG_POSTS_PER_MINUTE {
            return Err(refused(429, "rate limited: at most 6 log posts a minute", "logs.rate-limited"));
        }
        posts.push_back(t);
        let lines = parse_log_post(body).map_err(|e| refused(400, e, "logs.malformed"))?;
        let n = lines.len();
        let mut ring = self.nodes.shift_remove(node).unwrap_or_default();
        for l in lines {
            if ring.lines.len() >= SPOKE_LINES {
                if let Some(old) = ring.lines.pop_front() {
                    ring.bytes -= old.json.len();
                    self.bytes -= old.json.len();
                }
            }
            ring.bytes += l.json.len();
            self.bytes += l.json.len();
            ring.lines.push_back(l);
        }
        ring.last = t;
        self.nodes.insert(node.to_owned(), ring);
        // Over the bounds: the spoke that posted least recently goes first (one node alone stays within its ring).
        while self.nodes.len() > 1 && (self.nodes.len() > SPOKE_NODES || self.bytes > SPOKE_BYTES) {
            if let Some((_, gone)) = self.nodes.shift_remove_index(0) {
                self.bytes -= gone.bytes;
            }
        }
        Ok(n)
    }

    fn lines(&self, node: &str, f: &Filter) -> Vec<String> {
        self.nodes.get(node).map(|r| r.lines.iter().rev().filter(|l| f.keeps(l)).map(|l| l.json.clone()).collect()).unwrap_or_default()
    }
}

// ── The console ─────────────────────────────────────────────────────────────────────────────────────────────

/// How a relay process runs its console.
pub struct ConsoleConfig {
    pub product: Product,
    pub state_dir: PathBuf,
    /// Meeting Hub: "https://" and console_public. Remote Spokes: None (the first hub invite fixes it, in the book).
    pub origin: Option<String>,
    pub sources: Vec<Cidr>,
    /// Behind a TLS front: the fronts allowed to name the client.
    pub trusted_fronts: Vec<Cidr>,
    pub behind_front: bool,
    /// `--console-first-admin` or `console_first_admin`.
    pub first_admin: Option<String>,
    /// `--console-profile` or `console_profile` (R41-3): None when not given (Standard, `profileFrom: "default"`). Read
    /// only while the console is not bootstrapped (3.3 "Which profile a console starts in").
    pub profile: Option<Profile>,
    /// The relay's host name (export file names; `reset` asks for it).
    pub host: String,
}

/// An invite just minted: the link, when it ends (ms) and the console's origin.
pub struct Invited {
    pub link: String,
    pub expires: i64,
    pub origin: String,
}

/// One refusal for the audit: on a POST or a GET, the route's action, its target, the 8.3 code.
struct Noted<'a> {
    post: bool,
    action: &'a str,
    target: Option<String>,
    code: &'static str,
}

/// The console of one relay process.
pub struct Console {
    pub(crate) cfg: ConsoleConfig,
    pub(crate) file: PathBuf,
    pub(crate) logger: Arc<Logger>,
    pub(crate) ring: Arc<LineRing>,
    pub(crate) inner: Mutex<Inner>,
    pub(crate) audit: Mutex<Audit>,
    pub(crate) spokes: Mutex<SpokeLogs>,
    section: OnceLock<Arc<dyn ProductSection>>,
    /// The MDS3 snapshot in force (3.3). Lock order: `inner` may be held while taking it, never the other way.
    pub(crate) mds: Mutex<Mds>,
    /// Sealed secrets (3.11); None when `console-secrets.json` does not read back (every route answers 503). Same lock
    /// order as `mds`.
    pub(crate) seal: Mutex<Option<Seal>>,
    pub(crate) mailer: Arc<Mailer>,
    _lock: StateLock,
    /// AC-2a 2.1 (F7): a relay's own console, or the fleet console of the console role.
    kind: ConsoleKind,
    /// AC-2a 2.1: an enrolled relay's console with no listener (its book, audit chain and `fleet-key`).
    headless: bool,
    /// AC-2a: the fleet section of a fleet console.
    fleet: OnceLock<Arc<crate::console_fleet::Fleet>>,
    /// R42-3: `license-reminders.json`, read at the first check (None until then).
    reminders: Mutex<Option<crate::license_reminders::Book>>,
}

/// What a console serves (AC-2a 2.1, F7): one product's relay (AC-1), or the fleet of the console role.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConsoleKind {
    Local(Product),
    Fleet,
}

/// The Remote Spokes flags of the console (each also `LUCID_RELAY_CONSOLE_<NAME>`).
#[derive(Default)]
pub struct SpokesFlags<'a> {
    pub console: Option<&'a String>,
    pub sources: Option<&'a String>,
    pub trusted_fronts: Option<&'a String>,
    pub first_admin: Option<&'a String>,
    pub profile: Option<&'a String>,
}

/// The Remote Spokes console from `--console` or LUCID_RELAY_CONSOLE (`1` on, `0` or unset off): the logger, tapped for
/// the console's ring when it is on, and the console. Err is why the relay does not start.
pub fn open(flags: SpokesFlags, env: impl Fn(&str) -> Option<String>, state: Option<&str>, lan: bool, behind_tls: bool, host: &str, logger: Logger) -> Result<(Arc<Logger>, Option<Arc<Console>>), String> {
    let get = |flag: Option<&String>, var: &str| flag.filter(|v| !v.is_empty()).cloned().or_else(|| env(var).filter(|v| !v.is_empty()));
    let on = get(flags.console, "LUCID_RELAY_CONSOLE").unwrap_or_else(|| "0".into());
    if on != "0" && on != "1" {
        return Err("the Admin Console is 1 (on) or 0 (off): --console or LUCID_RELAY_CONSOLE".into());
    }
    if on == "0" {
        return Ok((Arc::new(logger), None));
    }
    if lan {
        return Err("a LAN mailbox (--owner) serves no Admin Console: leave out --console and LUCID_RELAY_CONSOLE".into());
    }
    let Some(dir) = state.filter(|d| !d.is_empty()) else {
        return Err("the Admin Console keeps its people and passkeys in the state folder: give --state or LUCID_RELAY_STATE".into());
    };
    let sources_text = get(flags.sources, "LUCID_RELAY_CONSOLE_SOURCES").unwrap_or_else(|| DEFAULT_SOURCES.into());
    let sources = parse_cidr_list(&sources_text, SOURCES_MAX).map_err(|e| format!("--console-sources: {e}"))?;
    let fronts = match get(flags.trusted_fronts, "LUCID_RELAY_CONSOLE_TRUSTED_FRONTS") {
        Some(text) => parse_cidr_list(&text, FRONTS_MAX).map_err(|e| format!("--console-trusted-fronts: {e}"))?,
        None if behind_tls => return Err("the console behind a TLS front needs --console-trusted-fronts (the front's addresses)".into()),
        None => Vec::new(),
    };
    let first_admin = match get(flags.first_admin, "LUCID_RELAY_CONSOLE_FIRST_ADMIN") {
        Some(e) => Some(email_of(Some(&e)).ok_or_else(|| format!("--console-first-admin {e} is not an email address"))?),
        None => None,
    };
    let profile = match get(flags.profile, "LUCID_RELAY_CONSOLE_PROFILE") {
        Some(p) => Some(Profile::parse(&p).ok_or_else(|| crate::console_settings::PROFILE_FLAG_BAD.to_owned())?),
        None => None,
    };
    let ring = Arc::new(LineRing::default());
    let logger = Arc::new(logger.with_tap(ring.tap()));
    for f in fronts.iter().filter(|f| f.wide()) {
        let words = format!("a trusted front range of {f} lets every host in it name the client; list only the front's addresses");
        logger.security("console.fronts-wide", &Fields::new().with("range", f.to_string()).with("why", words), Level::Warn);
    }
    let cfg = ConsoleConfig { product: Product::Spokes, state_dir: PathBuf::from(dir), origin: None, sources, trusted_fronts: fronts, behind_front: behind_tls, first_admin, profile, host: host.to_owned() };
    let console = Console::open(cfg, logger.clone(), ring)?;
    Ok((logger, Some(console)))
}

/// AC-2a 2.1 (F7): the headless console of an enrolled relay whose own console is off: no listener and no people,
/// its book holding the requests the fleet creates, its audit chain every console request, its `Seal` the relay's
/// `fleet-key`. It takes `console.lock` like any console.
pub fn open_headless(product: Product, state_dir: &std::path::Path, logger: Arc<Logger>) -> Result<Arc<Console>, String> {
    let cfg = ConsoleConfig { product, state_dir: state_dir.to_path_buf(), origin: None, sources: Vec::new(), trusted_fronts: Vec::new(), behind_front: false, first_admin: None, profile: None, host: String::new() };
    Console::open_with(cfg, logger, Arc::new(LineRing::default()), ConsoleKind::Local(product), true, crate::console_seal::SealIdentity::Relay)
}

/// AC-2a 2.1 and 5.2 (F7): the fleet console of the console role (`console serve`, or all-in-one with
/// `seal_id` the relay's): the logger tapped for the console's ring and its security lines for the SIEM (10.2), the
/// console, and its fleet section attached.
pub fn open_fleet(cfg: crate::console_fleet::ServeConfig, logger: Logger, seal_id: crate::console_seal::SealIdentity) -> Result<(Arc<Logger>, Arc<Console>), String> {
    let ring = Arc::new(LineRing::default());
    let fleet_cell: Arc<OnceLock<std::sync::Weak<crate::console_fleet::Fleet>>> = Arc::new(OnceLock::new());
    let tap: Tap = {
        let (ring, cell) = (ring.clone(), fleet_cell.clone());
        Arc::new(move |cat: &str, level: Level, event: &str, json: &str| {
            ring.push(cat, level, event, json);
            if cat == "security" {
                if let Some(f) = cell.get().and_then(std::sync::Weak::upgrade) {
                    if let Some(Value::Object(m)) = parse_json(json) {
                        f.siem.security_line(&m);
                    }
                }
            }
        })
    };
    let logger = Arc::new(logger.with_tap(tap));
    for f in cfg.trusted_fronts.iter().filter(|f| f.wide()) {
        let words = format!("a trusted front range of {f} lets every host in it name the client; list only the front's addresses");
        logger.security("console.fronts-wide", &Fields::new().with("range", f.to_string()).with("why", words), Level::Warn);
    }
    let ccfg = ConsoleConfig {
        product: Product::Spokes,
        state_dir: cfg.state.clone(),
        origin: Some(format!("https://{}", cfg.public)),
        sources: cfg.sources.clone(),
        trusted_fronts: cfg.trusted_fronts.clone(),
        behind_front: cfg.tls.is_none(),
        first_admin: cfg.first_admin.clone(),
        profile: cfg.profile,
        host: cfg.public_host.clone(),
    };
    let console = Console::open_with(ccfg, logger.clone(), ring, ConsoleKind::Fleet, false, seal_id)?;
    let fleet = crate::console_fleet::Fleet::open(&console, cfg.fleet.clone())?;
    let _ = fleet_cell.set(Arc::downgrade(&fleet));
    Ok((logger, console))
}

impl Console {
    /// The console in `cfg.state_dir`: takes `console.lock` for the process's life, reads the book (a book that does not
    /// read back makes every console route answer 503, never a refused start), refuses to start while not bootstrapped
    /// without the first-admin pin, verifies the audit, and appends what offline commands left.
    pub fn open(cfg: ConsoleConfig, logger: Arc<Logger>, ring: Arc<LineRing>) -> Result<Arc<Console>, String> {
        let kind = ConsoleKind::Local(cfg.product);
        Console::open_with(cfg, logger, ring, kind, false, crate::console_seal::SealIdentity::Relay)
    }

    /// `open` for a console kind (AC-2a 2.1, F7): a fleet console needs no first-admin pin (its setup code is the
    /// gate, 12.1) and seals under the console role's identity; a headless console has no people and no listener.
    pub fn open_with(cfg: ConsoleConfig, logger: Arc<Logger>, ring: Arc<LineRing>, kind: ConsoleKind, headless: bool, seal_id: crate::console_seal::SealIdentity) -> Result<Arc<Console>, String> {
        let lock = lock_state(&cfg.state_dir).map_err(|e| if e == crate::console_auth::RUNNING { format!("another relay process holds {} in {}", crate::console_auth::LOCK_FILE, cfg.state_dir.display()) } else { e })?;
        let t = crate::codec::now_ms();
        let file = cfg.state_dir.join(CONSOLE_FILE);
        let (mut book, unreadable) = match Book::read(&file, t) {
            Ok(b) => (b, false),
            Err(e) => {
                logger.ops("console.state-unreadable", &Fields::new().with("reason", e), Level::Error);
                (Book::default(), true)
            }
        };
        if kind == ConsoleKind::Fleet && !unreadable && book.fleet.is_null() {
            // Marks the book as a fleet console's from its first start (the fleet section fills it in).
            book.fleet = json!({});
        }
        if kind != ConsoleKind::Fleet && !headless && !unreadable && !book.bootstrapped && book.first_admin.is_none() && cfg.first_admin.is_none() {
            return Err(match cfg.product {
                Product::Spokes => "the console needs --console-first-admin <email> until its first admin signs in".into(),
                Product::Meet => "set console_first_admin to the relay admin who signs in first".into(),
            });
        }
        let upgraded = !unreadable && book.upgraded_at == Some(t);
        // The profile at setup (3.3, R41-3): written from the flag or field at every start while not bootstrapped, and
        // once at the upgrade start of a book from before AC-1; ignored afterwards.
        let at_start = if unreadable { ProfileAtStart::Ignored(false) } else { book.settings.profile_at_start(cfg.profile, book.bootstrapped && !upgraded) };
        let pending = std::mem::take(&mut book.pending_audit);
        if !unreadable && (upgraded || !pending.is_empty() || at_start == ProfileAtStart::Written(true)) {
            book.save(&file)?;
        }
        let (audit, notes) = Audit::open(&cfg.state_dir, t);
        for n in notes {
            logger.security("console.audit-broken", &Fields::new().with("why", n), Level::Error);
        }
        // Sealed secrets (3.11): an unreadable file answers 503 like the book; a data key that does not unwrap is
        // `seal-lost`: a new decoy key, mail off, every authenticator app unusable.
        let high = book.settings.high();
        let seal = match Seal::open_as(&cfg.state_dir, &|k| std::env::var(k).ok(), high, seal_id) {
            Ok(s) => Some(s),
            Err(e) => {
                logger.ops("console.state-unreadable", &Fields::new().with("file", crate::console_seal::SECRETS_FILE).with("reason", e), Level::Error);
                None
            }
        };
        let unreadable = unreadable || seal.is_none();
        let mds = Mds::open(&cfg.state_dir, t);
        if mds.stored_refused {
            logger.security("console.mds", &Fields::new().with("why", "the stored security key metadata (console-mds.jwt) did not verify; the shipped snapshot is used").with("no", mds.current.as_ref().map(|s| s.no)), Level::Warn);
        }
        let origin_now = cfg.origin.clone().or_else(|| book.origin.clone()).unwrap_or_else(|| format!("https://{}", cfg.host));
        let mailer = Mailer::new(cfg.host.clone(), format!("{origin_now}/console/"), logger.clone());
        mailer.install();
        let mut inner = Inner { book, unreadable, ..Inner::default() };
        inner.book.sweep(t);
        let c = Arc::new(Console {
            cfg,
            file,
            logger,
            ring,
            inner: Mutex::new(inner),
            audit: Mutex::new(audit),
            spokes: Mutex::new(SpokeLogs::default()),
            section: OnceLock::new(),
            mds: Mutex::new(mds),
            seal: Mutex::new(seal),
            mailer,
            _lock: lock,
            kind,
            headless,
            fleet: OnceLock::new(),
            reminders: Mutex::new(None),
        });
        c.open_secrets(t);
        // AC-2a 12.1: a fleet console not yet bootstrapped draws its setup code at every start.
        if kind == ConsoleKind::Fleet {
            c.draw_setup_code("start", t)?;
        }
        for e in pending {
            let mut r = Record::new("operator", str_of(e.get("action")).unwrap_or("operator"), "ok");
            r.target = str_of(e.get("target")).map(str::to_owned);
            r.detail = e.get("detail").cloned().unwrap_or(Value::Null);
            c.record(r, e.get("ts").and_then(Value::as_i64).unwrap_or(t));
        }
        if upgraded {
            let mut r = Record::new("relay", "console.upgrade", "ok");
            r.detail = json!({ "people": c.inner.lock().book.people.len() });
            c.record(r, t);
        }
        let (people, origin) = {
            let inner = c.inner.lock();
            (inner.book.people.len(), inner.book.origin.clone())
        };
        c.logger.ops("console.on", &Fields::new().with("people", people).with("origin", c.origin().or(origin)).with("product", c.cfg.product.as_str()), Level::Info);
        if at_start == ProfileAtStart::Ignored(true) {
            let flag = crate::console_settings::profile_flag(c.cfg.product);
            c.logger.ops("console.profile-ignored", &Fields::new().with("flag", flag).with("why", crate::console_settings::profile_ignored_words(flag)), Level::Info);
        }
        // The High setup gate (R3-M9): logged at every start while the break-glass account is not complete.
        let unreadable = c.inner.lock().unreadable;
        if !unreadable && c.break_glass_gate() {
            c.logger.ops("console.break-glass-missing", &Fields::new().with("why", crate::console_auth::BREAK_GLASS_MISSING), Level::Error);
        }
        // Expiry, attention mail and summaries once a minute, for as long as the console lives.
        let weak = Arc::downgrade(&c);
        let _ = std::thread::Builder::new().name("console-tick".into()).spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            match weak.upgrade() {
                Some(c) => c.tick(crate::codec::now_ms()),
                None => return,
            }
        });
        Ok(c)
    }

    /// At start: the seal provider logged and audited (`console.seal`), the decoy key drawn when there is none, and a
    /// lost data key handled (`seal-lost`: a new decoy key, mail off, every authenticator app unusable); then mail
    /// put in force from the settings and the sealed secrets.
    fn open_secrets(&self, t: i64) {
        let (provider, key_mode, refused, lost, key_refused) = {
            let seal = self.seal.lock();
            let Some(s) = seal.as_ref() else { return };
            let refused: Vec<Value> = s.refused_providers().into_iter().map(|(p, why)| json!({ "provider": p, "why": why })).collect();
            (s.provider().as_str(), s.key_mode().map(str::to_owned), refused, s.lost(), s.refused().map(str::to_owned))
        };
        self.logger.security("console.seal", &Fields::new().with("provider", provider).with("keyMode", key_mode.clone()).with("refused", Value::Array(refused.clone())), Level::Info);
        if let Some(why) = key_refused {
            self.logger.security("console.seal-refused", &Fields::new().with("why", why), Level::Error);
        }
        let mut r = Record::new("relay", "console.seal", "ok");
        r.detail = json!({ "provider": provider, "keyMode": key_mode, "refused": refused });
        self.record(r, t);
        if lost {
            self.logger.security("console.seal-lost", &Fields::new().with("why", "the data key did not unwrap on this host or account"), Level::Error);
            {
                let mut inner = self.inner.lock();
                for p in inner.book.people.values_mut() {
                    if let Some(m) = p.totp.as_mut() {
                        m.unusable = true;
                    }
                }
                inner.book.settings.email = MailConfig::off().to_settings();
                let _ = self.save_book(&mut inner);
            }
            let mut r = Record::new("relay", "console.seal-lost", "ok");
            r.detail = json!({ "provider": provider });
            self.record(r, t);
        }
        if self.seal_get(crate::console_auth::DECOY_SECRET).is_none() {
            if let Ok(key) = crate::console_auth::random_bytes(32) {
                if let Err(e) = self.seal_put(crate::console_auth::DECOY_SECRET, &key) {
                    self.logger.ops("console.seal-failed", &Fields::new().with("why", e.message), Level::Error);
                }
            }
        }
        let settings = self.inner.lock().book.settings.email.clone();
        let cfg = {
            let seal = self.seal.lock();
            MailConfig::from_settings(&settings, &|name| seal.as_ref().and_then(|s| s.get(name)).and_then(|b| String::from_utf8(b).ok()))
        };
        self.mailer.configure(cfg);
    }

    /// Once a minute: expired invites, joiners, approvals and requests swept; due refusal summaries appended; and the
    /// attention mail each admin chose (3.11: at most one mail per kind a day).
    pub fn tick(&self, t: i64) {
        {
            let mut inner = self.inner.lock();
            if inner.unreadable {
                return;
            }
            let (changed, _) = inner.book.sweep(t);
            let expired = !crate::console_approvals::sweep(&mut inner.book, t).is_empty();
            if changed || expired {
                let _ = self.save_book(&mut inner);
            }
        }
        let due = self.audit.lock().flush(t, false);
        for e in &due {
            self.ship(e);
        }
        // AC-2a: the fleet's minute (expiry, summaries, roster, counts).
        if let Some(f) = self.fleet() {
            f.tick(self, t);
        }
        // R42-1, R42-3: the service state audited and the renewal reminders, with email off too (audit, banners).
        self.license_check(t);
        if self.mailer.config().mode == Mode::Off {
            return;
        }
        let admins: Vec<(String, Option<Vec<String>>)> = self.inner.lock().book.people.iter().filter(|(_, p)| p.active_admin()).map(|(e, p)| (e.clone(), p.mail_kinds.clone())).collect();
        if admins.is_empty() {
            return;
        }
        let probe = Who { sid: String::new(), email: String::new(), role: PersonRole::Admin, rights: Rights::Admin, why: None, admin: true, manager: true };
        let items = self.attention_for(&probe, t);
        for (email, kinds) in admins {
            for a in &items {
                let kind = str_of(a.get("kind")).unwrap_or("");
                let wanted = match &kinds {
                    Some(k) => k.iter().any(|x| x == kind),
                    None => str_of(a.get("severity")) == Some("bad"),
                };
                if !wanted || self.inner.lock().limits.hit(Limit::AttentionMail, &format!("{email}|{kind}"), t).is_err() {
                    continue;
                }
                let Some(words) = attention_words(kind, a.get("args").unwrap_or(&Value::Null)) else { continue };
                let args = [("attention words", words), ("go", str_of(a.get("go")).unwrap_or("#/").to_owned())];
                self.mailer.enqueue("mail.attention", &email, &args);
            }
        }
    }

    /// The product section; set once, before serving.
    pub fn attach(&self, section: Arc<dyn ProductSection>) {
        let _ = self.section.set(section);
        // R42-3: a reminder whose moment passed while the relay was down goes out at its start.
        if !self.inner.lock().unreadable {
            self.license_check(crate::codec::now_ms());
        }
    }

    pub(crate) fn section(&self) -> Option<Arc<dyn ProductSection>> {
        self.section.get().cloned()
    }

    /// AC-2a 2.1 (F7).
    pub fn kind(&self) -> ConsoleKind {
        self.kind
    }

    pub fn is_fleet(&self) -> bool {
        self.kind == ConsoleKind::Fleet
    }

    /// The `product` of `me` and `overview`: "spokes", "meet", or "fleet" (5.3).
    pub(crate) fn product_word(&self) -> &'static str {
        if self.is_fleet() {
            "fleet"
        } else {
            self.cfg.product.as_str()
        }
    }

    /// An enrolled relay's console with no listener (2.1).
    pub fn is_headless(&self) -> bool {
        self.headless
    }

    /// The fleet section of a fleet console (F7, F15).
    pub fn fleet(&self) -> Option<Arc<crate::console_fleet::Fleet>> {
        self.fleet.get().cloned()
    }

    /// Attach the fleet section: as `fleet()` and as the console's product section (I9).
    pub(crate) fn attach_fleet(&self, fleet: Arc<crate::console_fleet::Fleet>) {
        let _ = self.fleet.set(fleet.clone());
        let section: Arc<dyn ProductSection> = fleet;
        let _ = self.section.set(section);
    }

    /// Whether the console's profile is High (f-people's non-dumpable start check, F7).
    pub fn high_profile(&self) -> bool {
        self.profile_high()
    }

    /// A refusal naming the relay it came from (5.1: `{"ok": false, "code", "error", "relay"}`).
    pub(crate) fn with_relay(&self, e: ApiError, relay: &str) -> ApiError {
        self.with_extra(e, "relay", Value::from(relay))
    }

    pub fn is_meet(&self) -> bool {
        self.cfg.product == Product::Meet
    }

    pub(crate) fn cookie_name(&self) -> &'static str {
        if self.is_meet() {
            COOKIE_MEET
        } else {
            COOKIE_SPOKES
        }
    }

    pub(crate) fn clear_cookie(&self) -> String {
        format!("{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0", self.cookie_name())
    }

    /// The console's origin: Meeting Hub's configured one, or the one the first Remote Spokes invite fixed.
    pub fn origin(&self) -> Option<String> {
        self.cfg.origin.clone().or_else(|| self.inner.lock().book.origin.clone())
    }

    pub fn source_allowed(&self, ip: IpAddr) -> bool {
        allowed(&self.cfg.sources, ip)
    }

    pub(crate) fn save_book(&self, inner: &mut Inner) -> Result<(), ApiError> {
        if inner.unreadable {
            return Err(ApiError::of("state-unreadable"));
        }
        inner.book.save(&self.file).map_err(|e| {
            self.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
            ApiError::of("write-failed")
        })
    }

    pub(crate) fn admin_rule(&self, email: &str, anchor: &str) -> AdminRule {
        self.section().map_or(AdminRule::Admin, |s| s.admin_rule(email, anchor))
    }

    /// Append an audit entry (after any refusal summaries now due) and ship it to the security log with its seq and
    /// hash. While the chain is broken every entry carries `after_torn`.
    pub(crate) fn record(&self, mut r: Record, t: i64) {
        let mut audit = self.audit.lock();
        let summaries = audit.flush(t, false);
        if audit.broken().is_some() {
            let mut d = r.detail.as_object().cloned().unwrap_or_default();
            d.insert("after_torn".into(), Value::Bool(true));
            r.detail = Value::Object(d);
        }
        let written = audit.append(t, &r);
        drop(audit);
        for e in summaries.iter().chain(written.as_ref().ok()) {
            self.ship(e);
            // AC-2a 10.2: a fleet console forwards its own entries to the SIEM (allow-listed fields only, f-metrics).
            if let (Some(f), Some(m)) = (self.fleet.get(), e.as_object()) {
                f.siem.console_entry(m);
            }
        }
        if let Err(e) = written {
            self.logger.ops("console.audit-failed", &Fields::new().with("reason", e).with("action", r.action.as_str()), Level::Error);
        }
    }

    fn ship(&self, e: &Value) {
        let f = Fields::new()
            .with("seq", e.get("seq").and_then(Value::as_u64).unwrap_or(0))
            .with("hash", str_of(e.get("hash")).unwrap_or(""))
            .with("actor", str_of(e.get("actor")).unwrap_or(""))
            .with("action", str_of(e.get("action")).unwrap_or(""))
            .with("result", str_of(e.get("result")).unwrap_or(""));
        self.logger.security("console.audit", &f, Level::Info);
    }

    /// A refusal for the chain: a signed-in person's own entry (or their summary), else the global summary.
    fn note_refusal(&self, who: Option<&Who>, n: Noted, (ip, source): (&str, &str), t: i64) {
        let Noted { post, action, target, code } = n;
        // Summaries of minutes that have ended go in first, so this refusal counts in its own minute.
        let (due, entry) = {
            let mut audit = self.audit.lock();
            let due = audit.flush(t, false);
            let person = who.map(|w| (w.email.as_str(), w.role.as_str()));
            (due, audit.refusal(person, post, code, source, t))
        };
        for e in &due {
            self.ship(e);
        }
        if let (RefusalEntry::Own, Some(w)) = (entry, who) {
            let mut r = Record::new(&w.email, if action.is_empty() { "console.refused" } else { action }, "refused");
            r.role = Some(w.role.as_str().to_owned());
            r.ip = Some(ip.to_owned());
            r.target = target;
            r.detail = json!({ "code": code });
            self.record(r, t);
        }
    }

    /// A product rate limit (blocks, files/start) for `key`.
    pub fn limit(&self, l: Limit, key: &str, t: i64) -> Result<(), ApiError> {
        let r = self.inner.lock().limits.hit(l, key, t);
        r.map_err(|o| {
            if o.first {
                self.logger.security("console.rate-limited", &Fields::new().with("limit", l.name()).with("key", key), Level::Warn);
            }
            ApiError::rate(o.retry_secs)
        })
    }

    /// Lines held per spoke in the spokes' rings (4.8 `logs: n`).
    pub fn spoke_log_counts(&self) -> HashMap<String, usize> {
        self.spokes.lock().nodes.iter().map(|(n, r)| (n.clone(), r.lines.len())).collect()
    }

    /// An action entry from the relay itself (actor "relay").
    pub fn audit_relay(&self, action: &str, target: &str, detail: Value) {
        let mut r = Record::new("relay", action, "ok");
        r.target = Some(target.to_owned());
        r.detail = detail;
        self.record(r, crate::codec::now_ms());
    }

    pub(crate) fn with_extra(&self, e: ApiError, key: &'static str, v: Value) -> ApiError {
        EXTRA.with(|x| *x.borrow_mut() = Some((key, v)));
        e
    }

    /// The license state of this process's product.
    pub(crate) fn license_view(&self, t: i64) -> LicenseView {
        match self.section() {
            Some(s) => s.license(t),
            None => LicenseView { license: Value::Null, problem: Some("this relay has no product section".into()), state: LicenseState::None, service: ServiceView::none(t) },
        }
    }

    /// The license items of Overview and their banners (7.2, 7.3; R42-1, R42-3), from the service view alone, so they
    /// show with email off and whatever `license-reminders.json` holds.
    fn license_attention(&self, lic: &LicenseView) -> Vec<Value> {
        let s = &lic.service;
        let product = self.cfg.product.name();
        let item = |kind: &str, severity: &str, args: Value, banner: Option<&str>, blocking: bool| {
            let mut v = json!({ "kind": kind, "severity": severity, "args": args, "go": "#/license" });
            if let Some(b) = banner {
                v["banner"] = Value::from(b);
            }
            if blocking {
                v["blocking"] = Value::Bool(true);
            }
            v
        };
        let mut out = Vec::new();
        match s.state {
            ServiceState::Stopped => {
                match s.why {
                    Some("expired") => out.push(item("license-expired", "bad", json!({}), None, false)),
                    _ => out.push(item("license-none", "bad", json!({ "product": product }), None, false)),
                }
                // 8.1 `license.why`: the verifier's words of a refused token (never the token).
                let words = s.reason.as_deref().map(crate::console_auth::clean);
                out.push(item("license-stopped", "bad", json!({ "product": product, "why": s.why, "verifier words": words }), Some("banner.license-stopped"), true));
            }
            ServiceState::Grace => out.push(item("license-grace", "bad", json!({ "product": product, "date": s.exp, "date and time": s.stops_at }), Some("banner.grace"), false)),
            ServiceState::UpgradePeriod => out.push(item("license-upgrade-period", "warn", json!({ "date and time": s.stops_at }), Some("banner.upgrade-period"), false)),
            ServiceState::On => {
                if let Some(exp) = s.exp {
                    let n = (exp - s.at + crate::license_reminders::DAY_MS - 1).div_euclid(crate::license_reminders::DAY_MS);
                    if n <= 30 {
                        out.push(item("license-expiring", "warn", json!({ "product": product, "n": n, "date": exp }), Some("banner.expiring"), false));
                    }
                }
            }
        }
        out
    }

    /// The 4.7 `service.reminders`: the reminders sent on the current schedule.
    fn reminders_view(&self, s: &ServiceView) -> Value {
        let key = crate::license_reminders::key_of(s);
        match self.reminders.lock().as_ref() {
            Some(b) if b.key.as_deref() == Some(key.as_str()) => b.view(),
            _ => json!([]),
        }
    }

    /// R42-1, R42-3 (once a minute and at attach): audits a change of the service state (`license.service`) and sends
    /// the reminder due now to every active console admin (`license.reminder`), kept in `license-reminders.json`.
    pub(crate) fn license_check(&self, t: i64) {
        if self.is_fleet() || self.section().is_none() {
            return;
        }
        let s = self.license_view(t).service;
        self.license_check_with(&s);
    }

    pub(crate) fn license_check_with(&self, s: &ServiceView) {
        use crate::license_reminders::{key_of, mail_of, Book};
        let dir = self.cfg.state_dir.clone();
        let mut guard = self.reminders.lock();
        if guard.is_none() {
            *guard = Some(match Book::read(&dir) {
                Ok(b) => b,
                Err(why) => {
                    // R7-L2: reinitialized from now on, so past steps are not replayed (banners still show).
                    self.logger.security(
                        "license.reminders-unreadable",
                        &Fields::new().with("words", "License reminder records could not be read. Past reminders were not sent again; banners still show.").with("why", why),
                        Level::Warn,
                    );
                    let b = Book::reset_at(s);
                    if let Err(e) = b.write(&dir) {
                        self.logger.ops("license.reminders-failed", &Fields::new().with("why", e), Level::Error);
                    }
                    b
                }
            });
        }
        let Some(book) = guard.as_mut() else { return };
        let mut changed = false;
        let key = key_of(s);
        let state = s.state.as_str();
        if book.service.is_some_and(|prev| prev != state) {
            let mut r = Record::new("relay", "license.service", "ok");
            r.target = s.license_id.clone();
            r.detail = json!({ "state": state, "why": s.why, "licenseId": s.license_id });
            self.record(r, s.at);
        }
        if book.service != Some(state) {
            book.service = Some(state);
            changed = true;
        }
        if book.key.as_deref() != Some(key.as_str()) {
            book.key = Some(key);
            book.sent.clear();
            changed = true;
        }
        let due = crate::license_reminders::due(s, book);
        if let Some((kind, moment)) = due {
            book.sent.push(crate::license_reminders::Sent { kind, moment, at: s.at });
            changed = true;
        }
        if changed {
            if let Err(e) = book.write(&dir) {
                self.logger.ops("license.reminders-failed", &Fields::new().with("why", e), Level::Error);
            }
        }
        drop(guard);
        let Some((kind, _)) = due else { return };
        let (mail, args) = mail_of(kind, s, self.cfg.product);
        let admins = self.active_admin_emails();
        let mailed = if self.mailer.config().mode == Mode::Off { 0 } else { admins.len() };
        for to in &admins {
            self.mailer.enqueue_reminder(mail, to, &args);
        }
        let mut r = Record::new("relay", "license.reminder", "ok");
        r.target = s.license_id.clone();
        r.detail = json!({ "kind": kind, "key": key_of(s), "mailed": mailed });
        self.record(r, s.at);
    }

    /// Writes that need the product license in valid or grace (2.4).
    pub(crate) fn need_product_license(&self, t: i64) -> Result<(), ApiError> {
        match self.license_view(t).state {
            LicenseState::Valid | LicenseState::Grace => Ok(()),
            LicenseState::Expired => Err(ApiError::of("license-expired")),
            LicenseState::None => Err(ApiError::with("license-needed", format!("This needs a license that includes {}.", self.cfg.product.name()))),
        }
    }

    /// Every route of this process: the core's and the product's.
    fn routes(&self) -> Vec<&'static RouteSpec> {
        let mut all: Vec<&'static RouteSpec> = CORE_ROUTES.iter().collect();
        if let Some(s) = self.section.get() {
            all.extend(s.routes().iter());
        }
        // AC-2a 5.7: the relay's own console only; a fleet console has the fleet routes instead (5.3).
        if !self.is_fleet() {
            all.extend(FLEET_LINK_ROUTES.iter());
        } else {
            all.extend(crate::console_wizard::WIZARD_ROUTES.iter());
        }
        all
    }

    /// Every action a step-up may be asked for.
    pub(crate) fn stepup_actions(&self) -> Vec<&'static str> {
        let mut v: Vec<&'static str> = self.routes().into_iter().filter(|r| r.stepup).map(|r| r.action).collect();
        v.extend(["approvals.approve", "admins.remove", "requests.cancel", "audit.export", "license.install"]);
        if self.is_fleet() {
            v.extend(["fleet.license.library", "account.key-record", "fleet.meet-ca.import"]);
        } else {
            v.extend(FLEET_LINK_ROUTES.iter().filter(|r| r.stepup).map(|r| r.action));
        }
        v
    }

    /// POST /v1/logs from an authenticated spoke: the number of lines kept, or why not.
    pub fn take_logs(&self, node: &str, body: &str, t: i64) -> Result<usize, Refused> {
        self.spokes.lock().take(node, body, t)
    }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────

/// A request under /console as the server hands it over.
pub struct ConsoleRequest<'a> {
    pub method: &'a str,
    pub pathname: &'a str,
    pub query: &'a str,
    /// The Cookie header.
    pub cookie: &'a str,
    pub origin: Option<&'a str>,
    /// X-Lucid-Console.
    pub marker: Option<&'a str>,
    /// X-Lucid-Activity: 1 (a person's own action).
    pub activity: bool,
    pub content_type: &'a str,
    pub user_agent: &'a str,
    /// The TCP peer.
    pub peer: IpAddr,
    /// Every X-Forwarded-For value, in order.
    pub forwarded: &'a [String],
    pub body: &'a str,
    pub dialed: &'a Dialed,
    /// The relay's TLS certificate names the host dialed.
    pub host_ok: bool,
}

/// A finished console answer, every header included.
pub struct ConsoleReply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
    pub close: bool,
}

fn reply(status: u16, content_type: &'static str, body: Vec<u8>, cache: &str) -> ConsoleReply {
    let mut headers: Vec<(&'static str, String)> = SECURITY_HEADERS.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
    headers.push(("Cache-Control", cache.to_owned()));
    ConsoleReply { status, content_type, body, headers, close: false }
}

fn json_answer(status: u16, v: &Value) -> ConsoleReply {
    reply(status, "application/json; charset=utf-8", stringify(v).into_bytes(), "no-store")
}

fn fail(e: &ApiError) -> ConsoleReply {
    let mut body = json!({ "ok": false, "code": e.code, "error": e.message });
    if let Some((k, v)) = EXTRA.with(|x| x.borrow_mut().take()) {
        body[k] = v;
    }
    let mut x = json_answer(e.status, &body);
    if let Some(s) = e.retry_after {
        x.headers.push(("Retry-After", s.to_string()));
    }
    x
}

fn closing(mut r: ConsoleReply) -> ConsoleReply {
    r.close = true;
    r
}

/// The origin a browser sees for the host a caller dialed (https, the port left out when it is 443 or was not
/// given); Err for an IP address, where passkeys do not work.
pub fn origin_of(d: &Dialed) -> Result<String, String> {
    let bare = d.hostname.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&d.hostname);
    if bare.parse::<IpAddr>().is_ok() || bare.is_empty() {
        return Err("the Admin Console needs the relay's DNS name: this relay was reached by an IP address, where passkeys do not work".into());
    }
    Ok(if d.host == d.hostname || d.port == 443 { format!("https://{}", d.hostname) } else { format!("https://{}", d.host) })
}

/// The WebAuthn relying party id of an origin: its host name.
pub fn rp_id_of(origin: &str) -> String {
    let host = origin.strip_prefix("https://").unwrap_or(origin);
    host.split(':').next().unwrap_or(host).to_owned()
}

fn cookie_of<'a>(header: &'a str, name: &str) -> &'a str {
    header.split(';').filter_map(|p| p.trim().split_once('=')).find(|(n, _)| *n == name).map(|(_, v)| v.trim()).unwrap_or("")
}

/// A query string's pairs, percent-decoded.
pub(crate) fn query_pairs(q: &str) -> Vec<(String, String)> {
    fn dec(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'+' => out.push(b' '),
                b'%' => match std::str::from_utf8(b.get(i + 1..i + 3).unwrap_or(&[])).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                },
                c => out.push(c),
            }
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    q.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map_or((dec(p), String::new()), |(k, v)| (dec(k), dec(v)))).collect()
}

/// The step-up target of a route for a body (3.6): the named field, "-", or `<principal>/<device>`.
pub fn target_of(spec: &RouteSpec, body: &Value) -> String {
    match spec.target {
        "-" => "-".into(),
        "principal+device" => format!("{}/{}", str_of(body.get("principal")).unwrap_or(""), str_of(body.get("device")).unwrap_or("")),
        field => match body.get(field) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        },
    }
}

const fn route(method: &'static str, path: &'static str, role: Role, action: &'static str, target: &'static str, stepup: bool, security: bool, keys: &'static [&'static str]) -> RouteSpec {
    RouteSpec { method, path, role, action, target, stepup, need: Need::Any, security, keys, body_max: BODY_MAX }
}

const fn get(path: &'static str, role: Role) -> RouteSpec {
    route("GET", path, role, "", "-", false, false, &[])
}

/// The core's routes (4.2 to 4.7). Product routes come from the product section; a route in neither is never served.
pub static CORE_ROUTES: [RouteSpec; 71] = [
    get("me", Role::None),
    get("banner", Role::None),
    route("POST", "join", Role::None, "", "-", false, false, &["token"]),
    route("POST", "register/begin", Role::None, "", "-", false, false, &["token", "kind"]),
    route("POST", "register/finish", Role::None, "", "-", false, false, &["ceremony", "credential", "label", "record"]),
    route("POST", "join/password", Role::None, "", "-", false, false, &["token", "password"]),
    route("POST", "join/totp/begin", Role::None, "", "-", false, false, &["token"]),
    route("POST", "join/totp/finish", Role::None, "", "-", false, false, &["token", "enrollment", "code"]),
    route("POST", "login/begin", Role::None, "", "-", false, false, &["email", "banner"]),
    route("POST", "login/password", Role::None, "", "-", false, false, &["ceremony", "password"]),
    route("POST", "login/set-password", Role::None, "", "-", false, false, &["ceremony", "password"]),
    route("POST", "login/totp", Role::None, "", "-", false, false, &["ceremony", "code"]),
    route("POST", "login/finish", Role::None, "", "-", false, false, &["ceremony", "credential"]),
    route("POST", "recover/begin", Role::None, "", "-", false, false, &["email"]),
    route("POST", "recover/finish", Role::None, "", "-", false, false, &["token", "password"]),
    route("POST", "logout", Role::Any, "", "-", false, false, &[]),
    get("overview", Role::Viewer),
    get("search", Role::Viewer),
    route("POST", "stepup/begin", Role::Viewer, "", "-", false, false, &["action", "target", "params"]),
    get("settings", Role::Admin),
    route("POST", "settings/links", Role::Admin, "settings.links", "-", true, false, &["links"]),
    route("POST", "settings/profile", Role::Admin, "settings.profile", "-", true, false, &["profile", "reason"]),
    route("POST", "settings/two-person", Role::Admin, "settings.two-person", "-", true, false, &["twoPerson", "reason"]),
    route("POST", "settings/sign-in", Role::Admin, "settings.sign-in", "-", true, false, &["requirePassword", "idleMinutes", "maxHours", "reason"]),
    route("POST", "settings/banner", Role::Admin, "settings.banner", "-", true, false, &["text"]),
    route("POST", "settings/aaguids", Role::Admin, "settings.aaguids", "-", true, false, &["aaguids", "reason"]),
    RouteSpec { method: "POST", path: "settings/mds", role: Role::Admin, action: "settings.mds", target: "-", stepup: true, need: Need::Any, security: false, keys: &["blob"], body_max: MDS_BODY_MAX },
    route("POST", "settings/email", Role::Admin, "settings.email", "-", true, false, &["mode", "from", "smtp", "graph", "reason"]),
    route("POST", "settings/email/test", Role::Admin, "settings.email-test", "-", false, false, &[]),
    route("POST", "settings/license-request-to", Role::Admin, "settings.license-request-to", "-", true, false, &["address"]),
    get("admins", Role::Manager),
    route("POST", "admins/invite", Role::Manager, "admins.invite", "email", true, false, &["email", "role"]),
    route("POST", "admins/approve-join", Role::Admin, "admins.approve-join", "email", true, false, &["email"]),
    route("POST", "admins/approve-passkey", Role::Admin, "admins.approve-passkey", "email", true, false, &["email", "hint"]),
    route("POST", "admins/role", Role::Admin, "admins.role", "email", true, false, &["email", "role", "reason"]),
    // Step-up checked by the handler: none to discard a waiting joiner.
    route("POST", "admins/remove", Role::Admin, "admins.remove", "email", false, false, &["email", "reason", "stepup"]),
    route("POST", "admins/suspend", Role::Manager, "admins.suspend", "email", true, true, &["email", "reason"]),
    route("POST", "admins/unsuspend", Role::Manager, "admins.unsuspend", "email", true, false, &["email"]),
    route("POST", "admins/reset-sign-in", Role::Admin, "admins.reset-sign-in", "email", true, false, &["email", "reason"]),
    route("POST", "invites/revoke", Role::Manager, "invites.revoke", "email", false, false, &["email"]),
    route("POST", "invites/resend", Role::Manager, "invites.resend", "email", true, false, &["email"]),
    get("sessions", Role::Viewer),
    route("POST", "sessions/end", Role::Viewer, "sessions.end", "id_hint", false, true, &["id_hint"]),
    route("POST", "sessions/end-all", Role::Admin, "sessions.end-all", "email", true, true, &["email"]),
    route("POST", "passkeys/add/begin", Role::Viewer, "passkeys.add", "-", true, false, &[]),
    route("POST", "passkeys/add/finish", Role::Viewer, "passkeys.add", "-", false, false, &["ceremony", "credential", "label", "record"]),
    route("POST", "passkeys/confirm", Role::Viewer, "passkeys.confirm", "hint", true, false, &["hint"]),
    route("POST", "passkeys/remove", Role::Viewer, "passkeys.remove", "hint", true, false, &["hint"]),
    route("POST", "passkeys/rename", Role::Viewer, "passkeys.rename", "hint", false, false, &["hint", "label"]),
    route("POST", "account/security-key/begin", Role::Viewer, "account.security-key", "-", true, false, &[]),
    route("POST", "account/security-key/finish", Role::Viewer, "account.security-key", "-", false, false, &["ceremony", "credential", "label", "record"]),
    route("POST", "account/password", Role::Viewer, "account.password", "-", true, false, &["current", "password"]),
    route("POST", "account/totp/begin", Role::Viewer, "account.totp", "-", true, false, &[]),
    route("POST", "account/totp/finish", Role::Viewer, "account.totp", "-", false, false, &["enrollment", "code"]),
    route("POST", "account/totp/remove", Role::Viewer, "account.totp-remove", "-", true, false, &[]),
    route("POST", "account/mail", Role::Admin, "account.mail", "-", false, false, &["kinds"]),
    get("approvals", Role::Admin),
    // Step-up checked by the handler against the approval's own params.
    route("POST", "approvals/approve", Role::Admin, "approvals.approve", "id", false, false, &["id", "stepup"]),
    route("POST", "approvals/refuse", Role::Admin, "approvals.refuse", "id", true, false, &["id", "reason"]),
    route("POST", "approvals/cancel", Role::Admin, "approvals.cancel", "id", false, false, &["id"]),
    get("requests", Role::Admin),
    route("POST", "requests/new", Role::Admin, "requests.new", "kind", false, false, &["kind", "target", "reason"]),
    // Step-up checked by the handler: only to cancel another admin's request.
    route("POST", "requests/cancel", Role::Admin, "requests.cancel", "id", false, false, &["id", "stepup"]),
    get("audit", Role::Admin),
    // Step-up checked by the handler (target "<from>-<to>").
    route("POST", "audit/export", Role::Admin, "audit.export", "-", false, false, &["from", "to", "stepup"]),
    get("audit/verify", Role::Admin),
    route("POST", "audit/restart", Role::Admin, "audit.restart", "-", true, false, &[]),
    get("logs", Role::Admin),
    route("POST", "logs/export", Role::Admin, "logs.export", "source", true, false, &["source", "cat", "level"]),
    get("license", Role::Viewer),
    // Step-up checked by the handler (target the token's license id).
    RouteSpec { method: "POST", path: "license/install", role: Role::Admin, action: "license.install", target: "-", stepup: false, need: Need::Any, security: false, keys: &["license", "reason", "stepup"], body_max: LICENSE_BODY_MAX },
];

/// AC-2a 5.7: a relay's own console's "Lucid Admin Console" panel (admin; AC-1 step-up except to refuse a change or a
/// held key). Each runs in process exactly as its `fleet` command (f-trust's `fleet_local`, which audits it).
pub static FLEET_LINK_ROUTES: [RouteSpec; 11] = [
    get("fleet-link", Role::Admin),
    route("POST", "fleet-link/preview", Role::Admin, "", "-", false, false, &["url", "code"]),
    route("POST", "fleet-link/join", Role::Admin, "fleet.join", "url", true, false, &["url", "code", "previewHash", "adminKeys"]),
    route("POST", "fleet-link/read-only", Role::Admin, "fleet.read-only", "-", true, true, &["on"]),
    route("POST", "fleet-link/confirm-scopes", Role::Admin, "fleet.confirm-scopes", "-", true, false, &["scopes"]),
    route("POST", "fleet-link/confirm", Role::Admin, "fleet.confirm", "id", true, false, &["id"]),
    route("POST", "fleet-link/refuse", Role::Admin, "fleet.confirm", "id", false, true, &["id"]),
    route("POST", "fleet-link/accept-scopes", Role::Admin, "fleet.scopes", "requestId", true, false, &["requestId", "hash"]),
    route("POST", "fleet-link/trust-ca", Role::Admin, "fleet.ca.trust", "generation", true, false, &["generation", "fingerprint"]),
    route("POST", "fleet-link/refuse-key", Role::Admin, "fleet.roster", "hint", false, true, &["hint"]),
    route("POST", "fleet-link/leave", Role::Admin, "fleet.left", "-", true, true, &[]),
];

/// Routes a broken audit never pauses (6 "A broken chain"): sign-in and its steps, exports, the restart.
fn exempt_from_broken(spec: &RouteSpec, body: &Value) -> bool {
    spec.role == Role::None
        || spec.security
        || matches!(spec.path, "logout" | "stepup/begin" | "audit/export" | "audit/restart" | "logs/export")
        || (spec.path == "requests/new" && matches!(str_of(body.get("kind")), Some("rs.revoke" | "meet.revoke")))
}

/// What the High setup gate lets through while the break-glass account is not complete (3.3, R3-M9): sign-in, sign-out
/// and the join flow, one's own methods and sessions, approving a waiting passkey, and the security actions of 2.4
/// (with the revocation requests).
fn exempt_from_gate(spec: &RouteSpec, body: &Value) -> bool {
    spec.role == Role::None
        || spec.security
        || matches!(spec.path, "logout" | "stepup/begin" | "admins/approve-passkey")
        || spec.path.starts_with("passkeys/")
        || spec.path.starts_with("account/")
        || (spec.path == "requests/new" && matches!(str_of(body.get("kind")), Some("rs.revoke" | "meet.revoke")))
}

/// The filters each core GET route takes.
fn filters_of(path: &str) -> &'static [&'static str] {
    match path {
        "search" => &["q"],
        "approvals" => &["state"],
        "requests" => &["state", "kind"],
        "audit" => &["after", "limit", "actor", "action", "result", "q"],
        "logs" => &["source", "cat", "level", "limit", "q"],
        _ => &[],
    }
}

impl Console {
    fn refuse_source(&self, r: &ConsoleRequest, why: &str, source: Option<&str>, t: i64) -> ConsoleReply {
        let key = source.map(str::to_owned).unwrap_or_else(|| source_key(r.peer));
        if self.inner.lock().log_source_once(&key, t) {
            let f = Fields::new().with("why", "source").with("detail", why).with("source", source).with("peer", r.peer.to_string());
            self.logger.security("console.refused", &f, Level::Warn);
        }
        self.note_refusal(None, Noted { post: r.method == "POST", action: "", target: None, code: "source" }, ("", &key), t);
        closing(fail(&ApiError::of("source")))
    }

    /// The signed-in caller, the session checked and (with `activity`) touched; Ok(None) when there is none.
    fn who(&self, r: &ConsoleRequest, origin: &str, t: i64) -> Result<Option<Who>, ApiError> {
        let sid = cookie_of(r.cookie, self.cookie_name());
        let Some((hash, _)) = crate::console_auth::sid_hash_of(sid) else { return Ok(None) };
        self.who_of(&hash, origin, r.activity, t)
    }

    /// One request under /console: the page and its files, or the API under /console/api/.
    pub fn http(&self, r: &ConsoleRequest, t: i64) -> ConsoleReply {
        EXTRA.with(|x| x.borrow_mut().take());
        if !r.host_ok {
            return closing(fail(&ApiError::of("host")));
        }
        // The source first (3.1): outside the list, or unreadable behind a front, nothing else is looked at.
        let ip = match source_of(r.peer, r.forwarded, &self.cfg.trusted_fronts, self.cfg.behind_front) {
            Ok(ip) => ip,
            Err(why) => return self.refuse_source(r, why.why(), None, t),
        };
        let key = source_key(ip);
        if !allowed(&self.cfg.sources, ip) {
            return self.refuse_source(r, "outside the console's networks", Some(&key), t);
        }
        let ip_text = crate::console_source::canonical(ip).to_string();
        let Some(path) = r.pathname.strip_prefix("/console/api/") else { return page(r) };
        if self.inner.lock().unreadable {
            return fail(&ApiError::of("state-unreadable"));
        }
        let Some(origin) = self.origin() else {
            let pin = self.inner.lock().book.first_admin.clone().or_else(|| self.cfg.first_admin.clone()).unwrap_or_default();
            return fail(&ApiError::with("bootstrap-pinned", format!("This console waits for its first admin, {pin}.")));
        };
        if origin_of(r.dialed).ok().as_deref() != Some(origin.as_str()) {
            return fail(&ApiError { status: 409, code: "origin", message: format!("Open the Admin Console at {origin}/console/"), retry_after: None });
        }
        let post = r.method == "POST";
        if !post && r.method != "GET" {
            return closing(fail(&ApiError::of("method")));
        }
        let routes = self.routes();
        // AC-2a 5.3: a fleet console's own routes (with the relay detail and the 5.4 proxy matched by prefix); a
        // relay's own console has none of them, and a fleet console none of the product routes of AC-1.
        let fleet_hit = if self.is_fleet() { crate::console_fleet::fleet_route(r.method, path) } else { None };
        let (spec, at) = match fleet_hit {
            Some((s, at)) => (s, Some(at)),
            None => {
                let Some(spec) = routes.iter().copied().find(|s| s.path == path && s.method == r.method) else {
                    let e = if routes.iter().any(|s| s.path == path) { ApiError::of("method") } else { ApiError::of("not-found") };
                    return closing(fail(&e));
                };
                (spec, None)
            }
        };
        // AC-2a 5.3, 12.1: before bootstrap a fleet console answers only the setup and join routes.
        if self.is_fleet() && !crate::console_wizard::BEFORE_BOOTSTRAP.contains(&path) && self.before_bootstrap() {
            return fail(&ApiError::of("setup-needed"));
        }
        let proxied = at.as_ref().and_then(|a| a.as_ref()).is_some_and(|(_, sub)| !sub.is_empty());
        let mut body = Value::Object(Map::new());
        let mut pairs = Vec::new();
        if post {
            if r.marker != Some("1") || r.origin != Some(origin.as_str()) {
                let shown = r.origin.map(|o| o.chars().take(200).collect::<String>());
                let f = Fields::new().with("ip", ip_text.as_str()).with("path", r.pathname).with("origin", shown).with("why", "a POST without this console's Origin and its X-Lucid-Console header");
                self.logger.security("console.refused", &f, Level::Warn);
                self.note_refusal(None, Noted { post: true, action: spec.action, target: None, code: "origin" }, (&ip_text, &key), t);
                return closing(fail(&ApiError::of("origin")));
            }
            if !r.content_type.to_ascii_lowercase().starts_with("application/json") {
                return fail(&ApiError::of("json"));
            }
            if r.body.len() > spec.body_max {
                return closing(fail(&ApiError::of("too-large")));
            }
            match parse_json(r.body) {
                Some(v @ Value::Object(_)) => body = v,
                _ => return fail(&ApiError::with("invalid", "The body must be a JSON object.")),
            }
            // A proxied body's exact keys are the relay's to check (4.8 step 2); `stepup` is the fleet step-up.
            if let Some(k) = body.as_object().filter(|_| !proxied).and_then(|o| o.keys().find(|k| !(spec.keys.contains(&k.as_str()) || (spec.stepup && k.as_str() == "stepup")))) {
                return fail(&ApiError::with("unknown-field", format!("Unknown field: {k}.")));
            }
        } else if CORE_ROUTES.iter().any(|c| std::ptr::eq(c, spec)) {
            pairs = query_pairs(r.query);
            if let Some((k, _)) = pairs.iter().find(|(k, _)| !filters_of(path).contains(&k.as_str())) {
                return fail(&ApiError::with("invalid", format!("Unknown filter: {k}.")));
            }
        }
        // The caller.
        let who = match self.who(r, &origin, t) {
            Ok(w) => w,
            Err(e) => {
                let mut x = fail(&e);
                x.headers.push(("Set-Cookie", self.clear_cookie()));
                return x;
            }
        };
        let refuse = |e: ApiError, who: Option<&Who>| -> ConsoleReply {
            self.note_refusal(who, Noted { post, action: spec.action, target: None, code: e.code }, (&ip_text, &key), t);
            fail(&e)
        };
        match spec.role {
            Role::None => {}
            _ if who.is_none() => return refuse(ApiError::of("signin-first"), None),
            Role::Admin if !who.as_ref().is_some_and(|w| w.admin) => return refuse(ApiError::of("role"), who.as_ref()),
            Role::Manager if !who.as_ref().is_some_and(|w| w.manager) => return refuse(ApiError::with("role", "Only an admin or user manager can do this."), who.as_ref()),
            _ => {}
        }
        if let Some(w) = &who {
            let mut inner = self.inner.lock();
            let over = inner.limits.hit(Limit::Api, &w.sid, t).err().or_else(|| if post { inner.limits.hit(Limit::Post, &w.sid, t).err() } else { None });
            drop(inner);
            if let Some(o) = over {
                if o.first {
                    self.logger.security("console.rate-limited", &Fields::new().with("email", &w.email).with("path", path), Level::Warn);
                }
                return refuse(ApiError::rate(o.retry_secs), Some(w));
            }
        }
        if post && self.audit.lock().broken().is_some() && !exempt_from_broken(spec, &body) {
            return refuse(ApiError::of("audit-broken"), who.as_ref());
        }
        if post && !exempt_from_gate(spec, &body) && self.break_glass_gate() {
            return refuse(ApiError::of("break-glass-needed"), who.as_ref());
        }
        let mut params = body.clone();
        let stepup = params.as_object_mut().and_then(|o| o.remove("stepup"));
        if post && spec.need == Need::Product {
            if let Err(e) = self.need_product_license(t) {
                return refuse(e, who.as_ref());
            }
        }
        // AC-2a 4.5: on a fleet console the profile and two-person settings take a policy step-up, so one confirmation
        // serves the console and every relay.
        let fleet = self.fleet();
        let fleet_policy = post && fleet.is_some() && matches!(path, "settings/profile" | "settings/two-person");
        let mut step: Option<StepOk> = None;
        if spec.stepup && !fleet_policy {
            let Some(w) = &who else { return refuse(ApiError::of("signin-first"), None) };
            let target = target_of(spec, &params);
            match self.verify_stepup(w, stepup.as_ref(), Bind { action: spec.action, target: &target, params: &params }, &origin, t) {
                Ok(k) => step = Some(k),
                Err(e) => return refuse(e, Some(w)),
            }
        }
        let freq = crate::console_fleet::FleetReq { method: r.method, query: r.query, body: &body, params: &params, who: who.as_ref(), step: step.as_ref(), origin: &origin, ip: &ip_text, source: &key, t };
        let mut policy_bind = None;
        if let (true, Some(f)) = (fleet_policy, &fleet) {
            match f.verify_policy(self, &freq, spec.action) {
                Ok(b) => policy_bind = Some(b),
                Err(e) => return refuse(e, who.as_ref()),
            }
        }
        let stepped = step.is_some() || policy_bind.is_some();
        let ctx = Ctx { r, who: who.as_ref(), body: &body, params: &params, pairs: &pairs, origin: &origin, source: &key, ip: &ip_text, step: step.as_ref(), t };
        let fleet_approval = path == "approvals/approve" && fleet.as_ref().is_some_and(|f| f.owns_approval(str_of(params.get("id")).unwrap_or("")));
        let done = match (&fleet, at) {
            (Some(f), Some(at)) => f.dispatch(self, spec, at, &freq),
            (Some(f), None) if fleet_approval => f.approve(self, &freq),
            _ if FLEET_LINK_ROUTES.iter().any(|c| std::ptr::eq(c, spec)) => self.fleet_link(spec, &ctx),
            _ if CORE_ROUTES.iter().any(|c| std::ptr::eq(c, spec)) => self.core(spec, &ctx),
            _ => self.product(spec, &ctx),
        };
        if let (Ok(d), Some(f)) = (&done, &fleet) {
            if post {
                if let Some(b) = policy_bind {
                    f.after_policy(self, d, b, t);
                    f.siem.set_high(self.profile_high());
                }
                if d.result == "ok" {
                    match path {
                        "settings/sign-in" => self.setup_done("signin"),
                        "settings/email" if d.out.body.get("verified") == Some(&Value::Bool(true)) => self.setup_done("email"),
                        _ => {}
                    }
                }
                // 4.4: a suspension, removal, demotion or a method's removal reaches the relays at once.
                if ["admins/", "passkeys/", "account/", "settings/", "approvals/"].iter().any(|p| path.starts_with(p)) {
                    f.sync_roster(self, t);
                }
            }
        }
        match done {
            Ok(d) => {
                if post && !d.result.is_empty() && !spec.action.is_empty() {
                    let mut rec = Record::new(who.as_ref().map_or("relay", |w| w.email.as_str()), spec.action, d.result);
                    rec.role = who.as_ref().map(|w| w.role.as_str().to_owned());
                    rec.ip = Some(ip_text.clone());
                    rec.target = d.target.clone();
                    rec.approval = d.approval.clone();
                    rec.stepup = stepped || stepup.is_some();
                    rec.detail = d.detail;
                    self.record(rec, t);
                }
                let o = d.out;
                let mut x = match o.file {
                    Some((bytes, ct, disposition)) => {
                        let mut x = reply(o.status, ct, bytes, "no-store");
                        x.headers.push(("Content-Disposition", disposition));
                        x
                    }
                    None => json_answer(o.status, &o.body),
                };
                if let Some(c) = o.cookie {
                    x.headers.push(("Set-Cookie", c));
                }
                x
            }
            Err(e) => {
                let target = Some(target_of(spec, &params)).filter(|s| !s.is_empty() && s != "-");
                self.note_refusal(who.as_ref(), Noted { post, action: spec.action, target, code: e.code }, (&ip_text, &key), t);
                fail(&e)
            }
        }
    }

    /// A product route: role and checks done; the answer, a write run now, or a second admin.
    fn product(&self, spec: &'static RouteSpec, c: &Ctx) -> Result<Done, ApiError> {
        let section = self.section().ok_or_else(|| ApiError::of("not-found"))?;
        let caller = c.who.map(|w| Caller { email: w.email.clone(), admin: w.admin, manager: w.manager, ip: c.ip.to_owned() }).unwrap_or(Caller { email: String::new(), admin: false, manager: false, ip: c.ip.to_owned() });
        let license = self.license_view(c.t).state;
        let call = SectionCall { spec, query: c.r.query, body: c.params, caller: &caller, license, t: c.t };
        match section.route(&call)? {
            SectionAnswer::Read(v) => Ok(Done::plain(Out::ok(v))),
            SectionAnswer::Done { answer, target, detail } => Ok(Done::ok(Out::ok(answer), Some(target), detail)),
            SectionAnswer::Second { target, params, detail } => {
                let who = c.who.ok_or_else(|| ApiError::of("signin-first"))?;
                let mut d = self.second_or_run(who, spec.action, &target, &params, c.t, || {
                    section.execute(&Approved { action: spec.action, target: &target, params: &params, requested_by: &who.email, approved_by: None, t: c.t })
                })?;
                d.detail = detail;
                Ok(d)
            }
        }
    }

    /// AC-2a 5.7: the relay's own console's "Lucid Admin Console" panel, run by f-trust's `fleet_local` exactly as its
    /// `fleet` command (which audits it).
    fn fleet_link(&self, spec: &'static RouteSpec, c: &Ctx) -> Result<Done, ApiError> {
        if spec.method == "GET" {
            return Ok(Done::plain(Out::ok(crate::fleet_local::console_view(self, c.t))));
        }
        let who = c.who()?;
        let x = spec.path.strip_prefix("fleet-link/").unwrap_or("");
        let v = crate::fleet_local::console_route(self, x, c.params, &who.email, c.t)?;
        Ok(Done::plain(Out::ok(v)))
    }

    /// AC-2a 4.8 step 7 (F5): the route a verified fleet frame names, on a relay's console (its own or headless),
    /// the role check and step-up already the relay's (f-trust). The core or product route as the local console runs
    /// it: body keys and core filters checked, the growth gate and the product license for writes; a section's
    /// `Second` resolved by the relay's policy. Nothing is audited here (f-trust writes the 7.2 `fleet.call`).
    pub(crate) fn fleet_route_spec(&self, method: &str, path: &str) -> Option<&'static RouteSpec> {
        let routes = self.routes();
        routes
            .into_iter()
            .chain(crate::console_spokes::FLEET_ROUTES.iter())
            .chain(crate::console_meet::FLEET_ROUTES.iter())
            .find(|s| s.method == method && s.path == path && !FLEET_LINK_ROUTES.iter().any(|f| std::ptr::eq(f, *s)))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn fleet_route(&self, method: &str, path: &str, query: &str, body: &Value, caller: &Caller, second: crate::fleet_exec::FleetSecond, t: i64) -> Result<crate::fleet_exec::FleetRan, ApiError> {
        use crate::fleet_exec::{FleetRan, FleetSecond};
        let spec = self.fleet_route_spec(method, path).ok_or_else(|| ApiError::of("not-found"))?;
        let post = method == "POST";
        let core = CORE_ROUTES.iter().any(|c| std::ptr::eq(c, spec));
        let pairs = if post { Vec::new() } else { query_pairs(query) };
        if post {
            if let Some(k) = body.as_object().and_then(|o| o.keys().find(|k| !spec.keys.contains(&k.as_str()) || k.as_str() == "stepup")) {
                return Err(ApiError::with("unknown-field", format!("Unknown field: {k}.")));
            }
            if spec.need == Need::Product {
                self.need_product_license(t)?;
            }
        } else if core {
            if let Some((k, _)) = pairs.iter().find(|(k, _)| !filters_of(path).contains(&k.as_str())) {
                return Err(ApiError::with("invalid", format!("Unknown filter: {k}.")));
            }
        }
        let role = if caller.admin { PersonRole::Admin } else if caller.manager { PersonRole::UserManager } else { PersonRole::Viewer };
        let who = Who { sid: String::new(), email: caller.email.clone(), role, rights: Rights::of_role(role), why: None, admin: caller.admin, manager: caller.manager };
        let ran = |out: Out, target: Option<String>, result: &'static str, approval: Option<String>| FleetRan { status: out.status, body: out.body, target, result, approval };
        let second_run = |run: &dyn Fn(Option<&str>) -> Result<Value, ApiError>| -> Result<(Value, Option<String>), ApiError> {
            match &second {
                FleetSecond::Refuse => Err(ApiError::of("fleet-second")),
                FleetSecond::Single(label) => run(None).map(|v| (v, Some((*label).to_owned()))),
                FleetSecond::Approved { approver, approval_id } => run(Some(*approver)).map(|v| (v, Some((*approval_id).to_owned()))),
            }
        };
        if !core {
            let section = self.section().ok_or_else(|| ApiError::of("not-found"))?;
            let license = self.license_view(t).state;
            let call = SectionCall { spec, query, body, caller, license, t };
            return match section.route(&call)? {
                SectionAnswer::Read(v) => Ok(ran(Out::ok(v), None, "", None)),
                SectionAnswer::Done { answer, target, .. } => Ok(ran(Out::ok(answer), Some(target), "ok", None)),
                SectionAnswer::Second { target, params, .. } => {
                    let (v, approval) = second_run(&|approver| section.execute(&Approved { action: spec.action, target: &target, params: &params, requested_by: &caller.email, approved_by: approver, t }))?;
                    Ok(ran(Out::ok(v), Some(target), "ok", approval))
                }
            };
        }
        match (method, path) {
            ("GET", "requests") => {
                let state = pairs.iter().find(|(k, _)| k == "state").map_or("waiting", |(_, v)| v.as_str());
                let kind = pairs.iter().find(|(k, _)| k == "kind").map_or("", |(_, v)| v.as_str());
                Ok(ran(self.requests_list_fleet(&who, state, kind, t)?, None, "", None))
            }
            ("POST", "requests/new") => {
                let d = self.requests_new_fleet(&who, body, t)?;
                Ok(ran(d.out, d.target, d.result, d.approval))
            }
            ("POST", "requests/cancel") => {
                let d = self.requests_cancel(body, t)?;
                Ok(ran(d.out, d.target, d.result, d.approval))
            }
            ("POST", "license/install") => {
                let section = self.section().ok_or_else(|| ApiError::of("license-refused"))?;
                let token = str_of(body.get("license")).unwrap_or("").to_owned();
                crate::console_auth::reason_of(body.get("reason"))?;
                let cand = section.license_candidate(&token, t)?;
                if cand.ended {
                    return Err(ApiError::of("license-ended"));
                }
                let id = cand.id().to_owned();
                if cand.single() {
                    let v = section.license_install(&token, t)?;
                    return Ok(ran(Out::ok(json!({ "ok": true, "license": v })), Some(id), "ok", None));
                }
                let (v, approval) = second_run(&|_| section.license_install(&token, t).map(|v| json!({ "ok": true, "license": v })))?;
                Ok(ran(Out::ok(v), Some(id), "ok", approval))
            }
            ("POST", "audit/export") => {
                let from = body.get("from").and_then(Value::as_u64).unwrap_or(0);
                let to = body.get("to").and_then(Value::as_u64).unwrap_or(0);
                let text = self.audit.lock().export(from, to, t).map_err(|e| ApiError::with("invalid", e))?;
                Ok(ran(Out::ok(json!({ "ok": true, "file": text })), Some(format!("{from}-{to}")), "ok", None))
            }
            _ => {
                let dialed = Dialed { host: String::new(), hostname: String::new(), port: 443 };
                let r = ConsoleRequest { method, pathname: "", query, cookie: "", origin: None, marker: None, activity: false, content_type: "application/json", user_agent: "", peer: IpAddr::from([127, 0, 0, 1]), forwarded: &[], body: "", dialed: &dialed, host_ok: true };
                let step = StepOk::default();
                let empty = Value::Object(Map::new());
                let params = if post { body } else { &empty };
                let ctx = Ctx { r: &r, who: Some(&who), body: params, params, pairs: &pairs, origin: "", source: "", ip: &caller.ip, step: Some(&step), t };
                let d = self.core(spec, &ctx)?;
                // A download goes back as its text; the console turns it into a file again (5.4).
                let out = match d.out.file {
                    Some((bytes, _, _)) => Out::ok(json!({ "ok": true, "file": String::from_utf8_lossy(&bytes) })),
                    None => d.out,
                };
                Ok(ran(out, d.target, d.result, d.approval))
            }
        }
    }
}

/// What a core handler gets.
struct Ctx<'a> {
    r: &'a ConsoleRequest<'a>,
    who: Option<&'a Who>,
    body: &'a Value,
    /// The body without "stepup".
    params: &'a Value,
    pairs: &'a [(String, String)],
    origin: &'a str,
    source: &'a str,
    ip: &'a str,
    /// The method that made this request's step-up.
    step: Option<&'a StepOk>,
    t: i64,
}

impl Ctx<'_> {
    fn q(&self, k: &str) -> Option<&str> {
        self.pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    fn who(&self) -> Result<&Who, ApiError> {
        self.who.ok_or_else(|| ApiError::of("signin-first"))
    }

    fn step(&self) -> Result<&StepOk, ApiError> {
        self.step.ok_or_else(|| ApiError::of("stepup-needed"))
    }
}

fn with_target((out, detail): (Out, Value), target: Option<String>) -> Done {
    Done::ok(out, target, detail)
}

impl Console {
    fn core(&self, spec: &RouteSpec, c: &Ctx) -> Result<Done, ApiError> {
        let t = c.t;
        let ua = c.r.user_agent;
        match (spec.method, spec.path) {
            ("GET", "me") => Ok(Done::plain(self.me(c.who, t))),
            ("GET", "banner") => Ok(Done::plain(Out::ok(json!({ "ok": true, "banner": self.inner.lock().book.settings.banner })))),
            ("POST", "join") => self.join(c.source, c.body, t).map(Done::plain),
            ("POST", "register/begin") => self.register_begin(c.source, c.body, c.origin, t).map(Done::plain),
            ("POST", "register/finish") => self.register_finish(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "join/password") => self.join_password(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "join/totp/begin") => self.join_totp_begin(c.source, c.body, t).map(Done::plain),
            ("POST", "join/totp/finish") => self.join_totp_finish(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "login/begin") => self.login_begin(c.source, c.body, c.origin, t).map(Done::plain),
            ("POST", "login/password") => self.login_password(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "login/set-password") => self.login_set_password(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "login/totp") => self.login_totp(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "login/finish") => self.login_finish(c.source, c.ip, ua, c.body, c.origin, t).map(Done::plain),
            ("POST", "recover/begin") => self.recover_begin(c.source, c.body, t).map(Done::plain),
            ("POST", "recover/finish") => self.recover_finish(c.source, c.ip, c.body, t).map(Done::plain),
            ("POST", "logout") => Ok(Done::plain(self.logout(c.who()?, c.ip))),
            ("GET", "overview") => Ok(Done::plain(self.overview(c.who()?, t))),
            ("GET", "search") => self.search(c.who()?, c.q("q").unwrap_or(""), t).map(Done::plain),
            ("POST", "stepup/begin") => self.stepup_begin(c.who()?, c.body, c.origin, t).map(Done::plain),
            ("GET", "settings") => Ok(Done::plain(self.settings_view(t))),
            ("POST", "settings/links") => self.settings_links(c.params),
            ("POST", "settings/profile") => self.settings_profile(c.who()?, c.params, t),
            ("POST", "settings/two-person") => self.settings_two_person(c.who()?, c.params, t),
            ("POST", "settings/sign-in") => self.settings_sign_in(c.who()?, c.params, t),
            ("POST", "settings/banner") => self.settings_banner(c.params),
            ("POST", "settings/aaguids") => self.settings_aaguids(c.who()?, c.params, t),
            ("POST", "settings/mds") => self.settings_mds(c.params, t),
            ("POST", "settings/email") => self.settings_email(c.who()?, c.params, t),
            ("POST", "settings/email/test") => self.settings_email_test(c.who()?, t),
            ("POST", "settings/license-request-to") => self.settings_license_request_to(c.params),
            ("GET", "admins") => Ok(Done::plain(self.admins_view(c.who()?, t))),
            ("POST", "admins/invite") => self.admins_invite(c.who()?, c.params, t),
            ("POST", "admins/approve-join") => self.approve_join(c.who()?, c.params),
            ("POST", "admins/approve-passkey") => self.approve_passkey(c.who()?, c.params),
            ("POST", "admins/role") => self.admins_role(c.who()?, c.params, t),
            ("POST", "admins/remove") => self.admins_remove(c.who()?, c.body, c.origin, t),
            ("POST", "admins/suspend") => self.admins_suspend(c.who()?, c.params, t),
            ("POST", "admins/unsuspend") => self.admins_unsuspend(c.who()?, c.params, t),
            ("POST", "admins/reset-sign-in") => self.admins_reset_sign_in(c.who()?, c.params, t),
            ("POST", "invites/revoke") => self.invites_revoke(c.who()?, c.params),
            ("POST", "invites/resend") => self.invites_resend(c.who()?, c.params, t),
            ("GET", "sessions") => Ok(Done::plain(self.sessions_view(c.who()?))),
            ("POST", "sessions/end") => self.session_end(c.who()?, c.params).map(|d| with_target(d, None)),
            ("POST", "sessions/end-all") => {
                let target = str_of(c.params.get("email")).map(str::to_owned);
                self.sessions_end_all(c.who()?, c.params, t).map(|d| with_target(d, target))
            }
            ("POST", "passkeys/add/begin") => self.passkey_add_begin(c.who()?, c.step()?, KeyKind::Passkey, c.origin, t).map(Done::plain),
            ("POST", "passkeys/add/finish") | ("POST", "account/security-key/finish") => self.passkey_add_finish(c.who()?, c.params, c.origin, t).map(|d| with_target(d, None)),
            ("POST", "account/security-key/begin") => self.passkey_add_begin(c.who()?, c.step()?, KeyKind::SecurityKey, c.origin, t).map(Done::plain),
            ("POST", "passkeys/confirm") => self.passkey_confirm(c.who()?, c.params).map(|d| with_target(d, None)),
            ("POST", "passkeys/remove") => self.passkey_remove(c.who()?, c.params).map(|d| with_target(d, None)),
            ("POST", "passkeys/rename") => self.passkey_rename(c.who()?, c.params).map(|d| with_target(d, None)),
            ("POST", "account/password") => self.account_password(c.who()?, c.step()?, c.params, t).map(|d| with_target(d, None)),
            ("POST", "account/totp/begin") => self.account_totp_begin(c.who()?, c.step()?, t).map(Done::plain),
            ("POST", "account/totp/finish") => self.account_totp_finish(c.who()?, c.params, t).map(|d| with_target(d, None)),
            ("POST", "account/totp/remove") => self.account_totp_remove(c.who()?).map(|d| with_target(d, None)),
            ("POST", "account/mail") => self.account_mail(c.who()?, c.params).map(|d| with_target(d, None)),
            ("GET", "approvals") => self.approvals_list(c.who()?, c.q("state").unwrap_or("waiting"), t).map(Done::plain),
            ("POST", "approvals/approve") => self.approve(c.who()?, c.body, c.origin, t),
            ("POST", "approvals/refuse") => self.refuse(c.who()?, c.params, t),
            ("POST", "approvals/cancel") => self.cancel_approval(c.who()?, c.params, t),
            ("GET", "requests") => Ok(Done::plain(self.requests_list(c.q("state").unwrap_or("waiting"), c.q("kind").unwrap_or(""), t))),
            ("POST", "requests/new") => self.requests_new(c.who()?, c.params, t),
            ("POST", "requests/cancel") => {
                let who = c.who()?;
                let id = str_of(c.params.get("id")).unwrap_or("");
                let owner = self.request_owner(id).ok_or_else(|| ApiError::of("gone"))?;
                if owner != who.email {
                    self.verify_stepup(who, c.body.get("stepup"), Bind { action: "requests.cancel", target: id, params: c.params }, c.origin, t)?;
                }
                self.requests_cancel(c.params, t)
            }
            ("GET", "audit") => self.audit_list(c),
            ("POST", "audit/export") => self.audit_export(c),
            ("GET", "audit/verify") => Ok(Done::plain(self.audit_verify())),
            ("POST", "audit/restart") => self.audit_restart(c),
            ("GET", "logs") => self.logs(c),
            ("POST", "logs/export") => self.logs_export(c),
            ("GET", "license") => {
                let v = self.license_view(t);
                let mut service = v.service.to_value();
                service["reminders"] = self.reminders_view(&v.service);
                Ok(Done::plain(Out::ok(json!({ "ok": true, "license": v.license, "problem": v.problem, "service": service }))))
            }
            ("POST", "license/install") => self.license_install(c),
            _ => Err(ApiError::of("not-found")),
        }
    }

    // ── me, overview, search, settings ──────────────────────────────────────────────────────────────────────

    fn sections_for(&self, admin: bool, state: LicenseState) -> (Vec<&'static str>, bool) {
        let locked = state == LicenseState::None;
        let mut s = vec!["overview"];
        if locked {
            s.push("security");
        }
        s.push(self.cfg.product.as_str());
        if admin {
            s.push("approvals");
        }
        s.push("admins");
        (s, locked)
    }

    fn me(&self, who: Option<&Who>, t: i64) -> Out {
        let lic = self.license_view(t);
        let (sections, locked) = self.sections_for(who.is_some_and(|w| w.admin), lic.state);
        let pages = self.section().map(|s| s.sections(lic.state)).unwrap_or_default();
        let security: Vec<&'static str> = self.section().map(|s| s.security_actions().to_vec()).unwrap_or_default();
        let (user, bootstrap, s) = {
            let inner = self.inner.lock();
            let s = inner.book.settings.clone();
            let list = s.aaguid_list();
            let user = who.and_then(|w| {
                let p = inner.book.people.get(&w.email)?;
                let n = inner.sessions.values().filter(|s| s.email == w.email).count();
                let must = s.require_password && !p.has_password();
                Some(json!({
                    "email": w.email, "role": p.role.as_str(), "rights": w.rights.as_str(), "rightsWhy": w.why, "state": p.state_str(),
                    "breakGlass": p.break_glass, "methods": Book::methods_view(p, &list, false, &|k| self.approved_key(k, &list, s.high())), "mustSetPassword": must, "sessions": n,
                    // null: the default (every `bad` item, 3.11).
                    "mail": if w.admin { json!(p.mail_kinds) } else { Value::Null },
                }))
            });
            let pinned = if inner.book.bootstrapped { None } else { inner.book.first_admin.clone().or_else(|| self.cfg.first_admin.clone()) };
            (user.unwrap_or(Value::Null), json!({ "pinned": pinned, "bootstrapped": inner.book.bootstrapped }), s)
        };
        Out::ok(json!({
            "ok": true, "user": user, "origin": self.origin(), "product": self.product_word(), "profile": s.profile.as_str(),
            "relay": { "host": self.cfg.host, "version": env!("CARGO_PKG_VERSION") },
            "sections": sections, "idle": { "minutes": s.idle_minutes_now(), "maxHours": s.max_hours_now() },
            "pages": pages, "locked": locked, "securityActions": security,
            "license": { "state": lic.state.as_str(), "problem": lic.problem }, "bootstrap": bootstrap,
        }))
    }

    /// The core's attention items (7.3); the product adds its own.
    fn core_attention(&self, who: &Who, lic: &LicenseView, t: i64) -> Vec<Value> {
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({ "kind": kind, "severity": severity, "args": args, "go": go });
        let mut out = Vec::new();
        if !self.is_fleet() {
            out.extend(self.license_attention(lic));
        }
        if !who.manager {
            return out;
        }
        {
            let inner = self.inner.lock();
            // Accounts (existing ones only) whose lockout began in the last hour.
            let locked = inner.lockout.locked_since(t - 3_600_000).iter().filter(|k| inner.book.people.contains_key(k.as_str())).count();
            if locked > 0 {
                out.push(item("signin-locked", "warn", json!({ "n": locked }), "#/admins"));
            }
            for (e, p) in &inner.book.people {
                if p.state == PersonState::Waiting {
                    out.push(item("joiner-waiting", "info", json!({ "email": e, "from": p.joined_from }), "#/admins"));
                }
            }
        }
        if !who.admin {
            return out;
        }
        out.extend(self.revision4_attention(t));
        let inner = self.inner.lock();
        let book = &inner.book;
        let mine = book.approvals.iter().filter(|a| a.get("state").and_then(Value::as_str) == Some("waiting") && str_of(a.get("requested_by")) != Some(who.email.as_str()) && str_of(a.get("target")) != Some(who.email.as_str())).count();
        if mine > 0 {
            out.push(item("approvals-mine", "warn", json!({ "n": mine }), "#/approvals"));
        }
        let old = book.requests.iter().filter(|r| r.get("state").and_then(Value::as_str) == Some("waiting") && r.get("requested_at").and_then(Value::as_i64).is_some_and(|at| t - at > 3 * 86_400_000)).count();
        if old > 0 {
            out.push(item("requests-old", "warn", json!({ "n": old }), "#/requests"));
        }
        if book.active_admins() < 3 {
            out.push(item("admins-few", "info", json!({}), "#/admins"));
        }
        let anchors: std::collections::BTreeSet<&str> = book.people.values().filter(|p| p.active_admin()).flat_map(|p| p.passkeys.iter().filter(|k| k.works()).map(|k| k.anchor.as_str())).collect();
        if anchors.len() == 1 && !anchors.contains(CONSOLE_ANCHOR) {
            let id = anchors.iter().next().copied().unwrap_or("");
            out.push(item("anchor-single", "warn", json!({ "label": id, "id": id }), "#/admins"));
        }
        for (e, p) in &book.people {
            if p.admin_role() && p.state == crate::console_auth::PersonState::Suspended {
                out.push(item("admin-suspended", "warn", json!({ "email": e }), "#/admins"));
            }
            if p.state != PersonState::Waiting && p.waiting_keys() > 0 {
                out.push(item("passkey-waiting", "info", json!({ "email": e }), "#/admins"));
            }
        }
        let unproven = book.people.values().filter(|p| p.admin_role() && p.unproven).count();
        if unproven > 0 {
            out.push(item("admins-unproven", "warn", json!({ "n": unproven }), "#/admins"));
        }
        drop(inner);
        for (kind, args) in self.audit.lock().attention(t) {
            let sev = if kind == "audit-broken" || kind == "audit-dropped-unexported" { "bad" } else { "warn" };
            out.push(item(kind, sev, args, "#/admins/audit"));
        }
        if !self.is_meet() {
            let n = self.ring.hits_last_hour(t);
            if n > 0 {
                out.push(item("quota-hits", "info", json!({ "n": n }), "#/spokes/logs"));
            }
        }
        out
    }

    /// The revision 4 attention items of the core (7.3), for admins: profile, two-person, break-glass, keys, MDS, mail
    /// and sealing.
    fn revision4_attention(&self, t: i64) -> Vec<Value> {
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({ "kind": kind, "severity": severity, "args": args, "go": go });
        let mut out = Vec::new();
        let (s, active_admins, bg, used, privileged) = {
            let inner = self.inner.lock();
            let bg = inner.book.people.iter().find(|(_, p)| p.break_glass).map(|(e, p)| (e.clone(), p.clone()));
            let privileged: Vec<crate::console_auth::Person> = inner.book.people.values().filter(|p| p.active() && p.role.privileged() && !p.break_glass).cloned().collect();
            (inner.book.settings.clone(), inner.book.active_admins(), bg, inner.book.break_glass_used_at, privileged)
        };
        if s.profile_standard_item() {
            out.push(item("profile-standard", "warn", json!({}), "#/admins/settings/security"));
        }
        if !s.two_person && active_admins >= 3 {
            out.push(item("two-person-off", "info", json!({ "n": active_admins }), "#/admins/settings/security"));
        }
        let complete = bg.as_ref().is_some_and(|(_, p)| self.break_glass_complete_of(p, &s));
        if !complete {
            let mut a = item("break-glass-missing", "bad", json!({}), "#/admins/settings/security");
            if s.high() {
                a["banner"] = Value::from("breakglass.gate");
                a["blocking"] = Value::Bool(true);
            }
            out.push(a);
        }
        if let (Some((email, _)), Some(at)) = (&bg, used) {
            if t - at < crate::console_auth::BREAK_GLASS_USED_MS {
                out.push(item("break-glass-used", "warn", json!({ "email": email, "time": at }), "#/admins/audit"));
            }
        }
        let list = s.aaguid_list();
        if s.high() {
            let n = privileged.iter().filter(|p| !p.passkeys.iter().any(|k| k.works() && self.attested_now(k, &list))).count();
            if n > 0 {
                out.push(item("key-unattested", "warn", json!({ "n": n }), "#/admins"));
            }
        }
        {
            let mds = self.mds.lock();
            if mds.old(t) {
                out.push(item("mds-old", "warn", json!({}), "#/admins/settings/security"));
            }
            if !s.high() && list.iter().any(|a| mds.current.as_ref().is_none_or(|m| !m.fips_hardware(a))) {
                out.push(item("aaguids-relaxed", "warn", json!({}), "#/admins/settings/security"));
            }
        }
        if let Some(reason) = self.mailer.failing_reason() {
            out.push(item("mail-failing", "bad", json!({ "reason": reason }), "#/admins/settings/email"));
        }
        if let Some(seal) = self.seal.lock().as_ref() {
            match seal.provider() {
                crate::console_seal::Provider::KeyFile if !s.high() => out.push(item("seal-key-file", "warn", json!({}), "#/admins/settings/security")),
                crate::console_seal::Provider::DpapiMachine => out.push(item("seal-machine-scope", "warn", json!({}), "#/admins/settings/security")),
                _ => {}
            }
            if seal.lost() {
                out.push(item("seal-lost", "bad", json!({}), "#/admins/settings/email"));
            }
        }
        out
    }

    /// Every attention item `who` may see (7.3), ordered by severity, at most 20; the banners lifted out of them
    /// (`banner: "<word id>"`, 7.2) and the session's own reduced-rights banner.
    fn attention_for(&self, who: &Who, t: i64) -> Vec<Value> {
        self.attention_and_banners(who, t).0
    }

    fn attention_and_banners(&self, who: &Who, t: i64) -> (Vec<Value>, Vec<Value>) {
        const VIEWER_KINDS: [&str; 11] = ["license-none", "license-grace", "license-expired", "license-expiring", "license-stopped", "license-upgrade-period", "crl-stale", "signer-unhealthy", "signer-expiring", "tls-expiring", "spokes-silent"];
        let lic = self.license_view(t);
        let mut attention = self.core_attention(who, &lic, t);
        if let Some(s) = self.section() {
            attention.extend(s.attention(who.manager, t));
        }
        let manager_kind = |k: &str| k.starts_with("seats-") || k == "joiner-waiting" || k == "signin-locked";
        if !who.admin {
            // AC-2a 8.1: viewers of a fleet console also see `relay-silent` and `relay-cert-*`.
            let fleet_viewer = |k: &str| self.is_fleet() && matches!(k, "relay-silent" | "relay-cert-expiring" | "relay-cert-expired" | "relay-license-stopped" | "relay-license-grace" | "relay-license-expiring");
            attention.retain(|a| str_of(a.get("kind")).is_some_and(|k| VIEWER_KINDS.contains(&k) || fleet_viewer(k) || (who.manager && manager_kind(k))));
        }
        let mut banners: Vec<Value> = Vec::new();
        for a in attention.iter_mut() {
            if let Some(o) = a.as_object_mut() {
                if let Some(Value::String(id)) = o.remove("banner") {
                    banners.push(json!({ "id": id, "args": o.get("args").cloned().unwrap_or(Value::Null) }));
                }
            }
        }
        // The High setup gate shows to everyone, admins or not (7.2).
        if !banners.iter().any(|b| b["id"] == "breakglass.gate") && self.break_glass_gate() {
            banners.push(json!({ "id": "breakglass.gate", "args": {} }));
        }
        match who.why {
            Some("not-attested") => banners.push(json!({ "id": "high.viewer-rights", "args": {} })),
            Some("not-device-anchored") => banners.push(json!({ "id": "meet.viewer-rights", "args": {} })),
            _ => {}
        }
        let rank = |a: &Value| match (a.get("blocking").and_then(Value::as_bool), str_of(a.get("severity"))) {
            (Some(true), _) => 0,
            (_, Some("bad")) => 1,
            (_, Some("warn")) => 2,
            _ => 3,
        };
        attention.sort_by_key(rank);
        attention.truncate(20);
        (attention, banners)
    }

    fn overview(&self, who: &Who, t: i64) -> Out {
        let lic = self.license_view(t);
        let section = self.section();
        let mut relay = section.as_ref().map(|s| s.relay_info(t)).unwrap_or_else(|| json!({ "version": env!("CARGO_PKG_VERSION") }));
        // The console knows the host it answers for; the section may not.
        if relay.get("host").is_none_or(Value::is_null) {
            relay["host"] = Value::from(self.cfg.host.as_str());
        }
        let (attention, banners) = self.attention_and_banners(who, t);
        let mut cards = vec![json!({ "id": "health", "state": "ok", "n": null })];
        let lic_card = match lic.service.state {
            ServiceState::On => "ok",
            ServiceState::Grace | ServiceState::UpgradePeriod => "warn",
            ServiceState::Stopped => "bad",
        };
        cards.push(json!({ "id": "license", "state": lic_card, "n": lic.license.get("daysLeft").cloned().unwrap_or(Value::Null) }));
        if let Some(s) = &section {
            cards.extend(s.overview_cards(who.manager, t));
        }
        let license = json!({
            "state": lic.state.as_str(), "product": self.cfg.product.as_str(),
            "edition": lic.license.get("edition").cloned().unwrap_or(Value::Null), "users": lic.license.get("users").cloned().unwrap_or(Value::Null),
            "used": lic.license.get("used").cloned().unwrap_or(Value::Null), "daysLeft": lic.license.get("daysLeft").cloned().unwrap_or(Value::Null),
            "exp": lic.license.get("exp").cloned().unwrap_or(Value::Null), "service": lic.service.to_value(),
        });
        let mut v = json!({ "ok": true, "product": self.product_word(), "relay": relay, "license": license, "cards": cards, "attention": attention, "banners": banners });
        // AC-2a 5.3, 8.1: the fleet's relays, people and calls, and its KPIs.
        if let Some(f) = self.fleet() {
            v["fleet"] = f.overview(self, t);
            v["license"] = Value::Null;
            if let Some(c) = v["cards"].as_array_mut() {
                c.retain(|x| x["id"] != "health" && x["id"] != "license");
            }
        }
        if who.admin {
            let inner = self.inner.lock();
            let waiting: Vec<&Map<String, Value>> = inner.book.approvals.iter().filter(|a| a.get("state").and_then(Value::as_str) == Some("waiting")).collect();
            let mine = waiting.iter().filter(|a| str_of(a.get("requested_by")) != Some(who.email.as_str()) && str_of(a.get("target")) != Some(who.email.as_str())).count();
            v["approvals"] = json!({ "waiting": waiting.len(), "mine": mine });
            v["requests"] = json!({ "waiting": inner.book.requests.iter().filter(|r| r.get("state").and_then(Value::as_str) == Some("waiting")).count() });
            v["links"] = inner.book.settings.links_value();
            drop(inner);
            if !self.is_meet() {
                v["quotaHits"] = self.ring.hits();
            }
        }
        Out::ok(v)
    }

    fn search(&self, who: &Who, q: &str, t: i64) -> Result<Out, ApiError> {
        let n = q.chars().count();
        if !(2..=100).contains(&n) {
            return Err(ApiError::with("invalid", "Search for 2 to 100 characters."));
        }
        if let Err(o) = self.inner.lock().limits.hit(Limit::Search, &who.sid, t) {
            return Err(ApiError::rate(o.retry_secs));
        }
        let ql = q.to_lowercase();
        let mut hits: Vec<Value> = Vec::new();
        if who.manager {
            let inner = self.inner.lock();
            for (e, p) in inner.book.people.iter().filter(|(e, _)| e.contains(&ql)) {
                hits.push(json!({ "kind": "person", "id": e, "title": e, "detail": p.role.as_str(), "go": "#/admins" }));
            }
        }
        if let Some(s) = self.section() {
            hits.extend(s.search(q, who.manager, t));
        }
        hits.truncate(50);
        Ok(Out::ok(json!({ "ok": true, "hits": hits })))
    }

    // ── License ─────────────────────────────────────────────────────────────────────────────────────────────

    /// POST license/install {license, reason, stepup}: refused past grace; one admin for a first license or a renewal
    /// of the reference license (the current fitting license, else Meeting Hub's `lastLicense`, R6-M1); a second admin
    /// for anything else (4.7).
    fn license_install(&self, c: &Ctx) -> Result<Done, ApiError> {
        let who = c.who()?;
        let section = self.section().ok_or_else(|| ApiError::of("license-refused"))?;
        let token = str_of(c.params.get("license")).unwrap_or("").to_owned();
        let reason = crate::console_auth::reason_of(c.params.get("reason"))?;
        let cand = section.license_candidate(&token, c.t)?;
        let id = cand.id().to_owned();
        self.verify_stepup(who, c.body.get("stepup"), Bind { action: "license.install", target: &id, params: c.params }, c.origin, c.t)?;
        if cand.ended {
            return Err(ApiError::of("license-ended"));
        }
        let single = cand.single();
        let detail = json!({ "license_id": id, "reason": reason, "license": cand.view });
        if single {
            let v = section.license_install(&token, c.t)?;
            return Ok(Done::ok(Out::ok(json!({ "ok": true, "license": v })), Some(id), detail));
        }
        let params = json!({ "license": token, "reason": reason });
        let mut d = self.second_or_run(who, "license.install", &id, &params, c.t, || {
            let v = section.license_install(&token, c.t)?;
            Ok(json!({ "ok": true, "license": v }))
        })?;
        d.detail = detail;
        Ok(d)
    }

    // ── Audit ───────────────────────────────────────────────────────────────────────────────────────────────

    fn audit_list(&self, c: &Ctx) -> Result<Done, ApiError> {
        let after = c.q("after").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let limit = c.q("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).clamp(1, 500);
        let q = c.q("q").map(str::to_lowercase);
        if q.as_ref().is_some_and(|q| !(2..=100).contains(&q.chars().count())) {
            return Err(ApiError::with("invalid", "Search for 2 to 100 characters."));
        }
        let audit = self.audit.lock();
        let entries = audit.entries();
        let matched: Vec<&Map<String, Value>> = entries
            .iter()
            .rev()
            .filter(|e| e.get("seq").and_then(Value::as_u64).unwrap_or(0) > after)
            .filter(|e| c.q("actor").is_none_or(|a| str_of(e.get("actor")) == Some(a)))
            .filter(|e| c.q("action").is_none_or(|a| str_of(e.get("action")).is_some_and(|x| x.starts_with(a))))
            .filter(|e| c.q("result").is_none_or(|r| str_of(e.get("result")) == Some(r)))
            .filter(|e| q.as_ref().is_none_or(|q| str_of(e.get("target")).unwrap_or("").to_lowercase().contains(q) || stringify(e.get("detail").unwrap_or(&Value::Null)).to_lowercase().contains(q)))
            .collect();
        let total = matched.len();
        let shown: Vec<Value> = matched.into_iter().take(limit).map(|e| Value::Object(e.clone())).collect();
        let (seq, hash) = audit.head();
        Ok(Done::plain(Out::ok(json!({ "ok": true, "entries": shown, "head": { "seq": seq, "hash": hash }, "dropped": audit.dropped_value(), "exportedThrough": audit.exported_through(), "total": total }))))
    }

    fn audit_export(&self, c: &Ctx) -> Result<Done, ApiError> {
        let who = c.who()?;
        let from = c.params.get("from").and_then(Value::as_u64).unwrap_or(0);
        let to = c.params.get("to").and_then(Value::as_u64).unwrap_or(0);
        let target = format!("{from}-{to}");
        self.verify_stepup(who, c.body.get("stepup"), Bind { action: "audit.export", target: &target, params: c.params }, c.origin, c.t)?;
        self.limit(Limit::Exports, &who.email, c.t)?;
        let text = self.audit.lock().export(from, to, c.t).map_err(|e| ApiError::with("invalid", e))?;
        let name = format!("attachment; filename=\"lucid-console-audit-{}-{from}-{to}.jsonl\"", self.cfg.host);
        let out = Out { status: 200, body: Value::Null, cookie: None, file: Some((text.into_bytes(), "application/x-ndjson", name)) };
        Ok(Done::ok(out, Some(format!("{from}-{to}")), json!({ "from": from, "to": to })))
    }

    fn audit_verify(&self) -> Out {
        let audit = self.audit.lock();
        let v = audit.verify();
        Out::ok(json!({ "ok": true, "verified": v.verified, "through": v.through, "broken_at": v.broken_at, "dropped": audit.dropped_value() }))
    }

    /// POST audit/restart {stepup}: a new chain onto the verified prefix, naming the torn file.
    fn audit_restart(&self, c: &Ctx) -> Result<Done, ApiError> {
        let who = c.who()?;
        let mut audit = self.audit.lock();
        if audit.broken().is_none() {
            return Err(ApiError::with("stale", "Nothing was changed: the audit log is not broken."));
        }
        let mut r = Record::new(&who.email, "audit.restart", "ok");
        r.role = Some(who.role.as_str().to_owned());
        r.ip = Some(c.ip.to_owned());
        r.stepup = true;
        let e = audit.restart(c.t, r).map_err(|e| ApiError::with("write-failed", e))?;
        drop(audit);
        self.ship(&e);
        // The entry is written: nothing more for the dispatcher to append.
        Ok(Done::plain(Out::ok(json!({ "ok": true, "entry": e }))))
    }

    // ── Logs ────────────────────────────────────────────────────────────────────────────────────────────────

    fn log_filter(cat: Option<&str>, level: Option<&str>, q: Option<&str>) -> Result<Filter, ApiError> {
        let cat = match cat.unwrap_or("all") {
            "all" | "" => None,
            c @ ("security" | "ops" | "perf") => Some(c.to_owned()),
            _ => return Err(ApiError::with("invalid", "cat is all, security, ops or perf")),
        };
        let min = match level.filter(|l| !l.is_empty()) {
            None => Level::Debug,
            Some(l) => level_of(l).ok_or_else(|| ApiError::with("invalid", "level is debug, info, warn or error"))?,
        };
        if q.is_some_and(|q| !(2..=100).contains(&q.chars().count())) {
            return Err(ApiError::with("invalid", "Search for 2 to 100 characters."));
        }
        Ok(Filter { cat, min, q: q.map(str::to_owned) })
    }

    fn log_lines(&self, source: &str, f: &Filter) -> Result<Vec<String>, ApiError> {
        if source == "relay" {
            if let Some(lines) = self.section().and_then(|s| s.relay_lines(f)) {
                return Ok(lines);
            }
            return Ok(self.ring.lines(f));
        }
        if !self.is_meet() && is_node_id(source) {
            return Ok(self.spokes.lock().lines(source, f));
        }
        Err(ApiError::with("invalid", if self.is_meet() { "source is relay" } else { "source is relay or a spoke's node id" }))
    }

    /// GET logs?source=&cat=&level=&limit=&q=: newest first.
    fn logs(&self, c: &Ctx) -> Result<Done, ApiError> {
        let source = c.q("source").filter(|s| !s.is_empty()).unwrap_or("relay");
        let f = Self::log_filter(c.q("cat"), c.q("level"), c.q("q"))?;
        let lines = self.log_lines(source, &f)?;
        let limit = c.q("limit").and_then(|l| l.parse::<usize>().ok()).unwrap_or(200).clamp(1, PAGE_LINES);
        let shown: Vec<Value> = lines.iter().take(limit).filter_map(|l| parse_json(l.as_str())).collect();
        Ok(Done::plain(Out::ok(json!({ "ok": true, "source": source, "total": lines.len(), "lines": shown }))))
    }

    /// POST logs/export {source, cat, level, stepup}: the file, oldest first.
    fn logs_export(&self, c: &Ctx) -> Result<Done, ApiError> {
        let who = c.who()?;
        self.limit(Limit::Exports, &who.email, c.t)?;
        let source = str_of(c.params.get("source")).filter(|s| !s.is_empty()).unwrap_or("relay").to_owned();
        let f = Self::log_filter(str_of(c.params.get("cat")), str_of(c.params.get("level")), None)?;
        let lines = self.log_lines(&source, &f)?;
        let mut text = String::new();
        for l in lines.iter().rev() {
            text.push_str(l);
            text.push('\n');
        }
        let name = format!("attachment; filename=\"lucid-relay-{source}-log.jsonl\"");
        let out = Out { status: 200, body: Value::Null, cookie: None, file: Some((text.into_bytes(), "application/x-ndjson; charset=utf-8", name)) };
        Ok(Done::ok(out, Some(source.clone()), json!({ "source": source, "lines": lines.len() })))
    }
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────────

/// The page's files (7.1), served by the relay itself.
pub const ASSETS: [(&str, &str, &[u8]); 9] = [
    ("index.html", "text/html; charset=utf-8", include_bytes!("../console/index.html")),
    ("theme.js", "text/javascript; charset=utf-8", include_bytes!("../console/theme.js")),
    ("app.js", "text/javascript; charset=utf-8", include_bytes!("../console/app.js")),
    // AC-2a 9.6 (F7): the dependency-free SVG chart builders.
    ("charts.js", "text/javascript; charset=utf-8", include_bytes!("../console/charts.js")),
    ("qr.js", "text/javascript; charset=utf-8", include_bytes!("../console/qr.js")),
    ("app.css", "text/css; charset=utf-8", include_bytes!("../console/app.css")),
    ("icon.svg", "image/svg+xml", include_bytes!("../console/icon.svg")),
    ("favicon.svg", "image/svg+xml", include_bytes!("../console/favicon.svg")),
    ("manifest.webmanifest", "application/manifest+json", include_bytes!("../console/manifest.webmanifest")),
];

/// The page and its files; anything else under /console/ that is not the API is 404.
fn page(r: &ConsoleRequest) -> ConsoleReply {
    if r.method != "GET" {
        return closing(fail(&ApiError::of("method")));
    }
    let name = match r.pathname {
        "/console" => {
            let mut x = reply(308, "text/plain; charset=utf-8", b"/console/\n".to_vec(), "no-cache");
            x.headers.push(("Location", "/console/".into()));
            return x;
        }
        "/console/" => "index.html",
        p => p.strip_prefix("/console/").unwrap_or(""),
    };
    match ASSETS.iter().find(|(n, _, _)| *n == name) {
        Some((_, ct, bytes)) => {
            let mut x = reply(200, ct, bytes.to_vec(), "no-cache");
            x.headers.push(("ETag", format!("\"{}\"", sha256_hex(bytes))));
            x
        }
        None => reply(404, "text/plain; charset=utf-8", b"Not found\n".to_vec(), "no-cache"),
    }
}

#[cfg(test)]
#[path = "console_tests.rs"]
mod tests;
