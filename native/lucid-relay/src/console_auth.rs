// The Admin Console's people and access (contract AC-1 revision 4, sections 2.3, 3.2 to 3.4 and 3.6): the book
// (`console.json`, owner-only) with its accounts keyed by email, their sign-in methods (passkeys, security keys, a
// password, an authenticator app) and invites; bootstrap with the required first-admin pin, decided under the
// console's lock at registration; anchors (every method has one, inherited when a method is added, confirmed or
// approved) and latched revocation; waiting joiners and waiting passkeys; the one enrollment policy and the
// enrollment step-up (R3-H1); sign-in by profile with one answer shape, fixed decoy work (R3-L1), the WebAuthn-first
// High password order and its setup session (R3-M1), the per-email lockout and one refusal sentence; the break-glass
// account and its setup gate (R3-M9); the `reset-sign-in` and `reset-password` token kinds (R3-L2); sessions per
// profile (a browser session cookie, bound to their origin, a banner accepted once); step-up per method, bound to an
// action, a target and its parameters; and the offline commands with `console.lock`.

use crate::codec::{b64u, exact_keys, is_int, js_trim, parse_json, sha256, sha256_hex, str_of, stringify, unb64u};
use crate::console::{AdminRule, ApiError, Console, Invited, Out, Refused, CONSOLE_FILE};
use crate::console_audit::{canonical_json, Record};
use crate::console_limits::{Failures, Limit, Limits, DAY, MINUTE};
use crate::console_mds::Verdict;
use crate::console_password::Lockout;
use crate::console_settings::{rights_of, Rights, Settings};
use crate::console_webauthn::{cred_props_rk, credential_id, same_bytes, verify_assertion, verify_registration, verify_stepup_assertion, NewPasskey};
use crate::identity::is_serial;
use crate::log::{Fields, Level};
use crate::meet_org_policy::lp;
use crate::store::write_private;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;

pub const LOCK_FILE: &str = "console.lock";
pub const INVITE_MS: i64 = 24 * 3_600_000;
pub const INVITES_MAX: usize = 50;
pub const SESSIONS_MAX: usize = 200;
pub const SESSIONS_PER_PERSON: usize = 5;
pub const CEREMONY_MS: i64 = 300_000;
pub const CEREMONIES_MAX: usize = 1000;
/// Pending sign-in or registration ceremonies one source holds at once; a newer one replaces its oldest.
pub const CEREMONIES_PER_SOURCE: usize = 4;
pub const STEPUP_MS: i64 = 120_000;
pub const STEPUPS_PER_SESSION: usize = 4;
/// Working WebAuthn methods (passkeys and security keys) per person, of which at most 4 not discoverable.
pub const PASSKEYS_MAX: usize = 10;
pub const NOT_DISCOVERABLE_MAX: usize = 4;
pub const WAITING_PASSKEYS_MAX: usize = 3;
pub const PEOPLE_MAX: usize = 50;
pub const JOINERS_MAX: usize = 20;
pub const WAITING_MS: i64 = 7 * DAY;
pub const HUB_INVITES_PER_DAY: usize = 3;
/// `break-glass-used` stays up this long after each use (3.3).
pub const BREAK_GLASS_USED_MS: i64 = 7 * DAY;
/// The decoy ids of `login/begin` (3.3, decision 41).
pub const LOGIN_IDS: usize = 4;
const LABEL_MAX: usize = 40;
const AGENT_MAX: usize = 120;
const TOTP_ENROLL_MS: i64 = 10 * MINUTE;
pub const STEPUP_LABEL: &str = "lucid-console-stepup-v1";
/// The anchor of a method registered from a console invite or a sign-in reset: not tied to any certificate.
pub const CONSOLE_ANCHOR: &str = "console";
/// The anchor of the break-glass account's methods (3.3).
pub const OPERATOR_ANCHOR: &str = "operator";
/// The sealed name of the decoy key (3.3, 3.11).
pub const DECOY_SECRET: &str = "decoy";
const GONE: &str = "This invite link has expired or was already used. Ask for a new one.";
pub const RUNNING: &str = "The relay is running. Stop it, then run this again.";
/// The one sign-in refusal sentence (3.3, C2).
pub const SIGNIN_REFUSED: &str = "Those details did not sign you in.";
pub const REVOKED_SPOKES: &str = "The hub that invited this admin was revoked: ask for a new invite from a hub that is still trusted.";
pub const REVOKED_MEET: &str = "The device that invited this admin was revoked: ask for a new invite from a device that is still trusted.";
/// 8.1 `cli.break-glass-missing`: the start log under High while the break-glass account is not complete.
pub const BREAK_GLASS_MISSING: &str = "The Admin Console has no break-glass account. Run lucid-relay console break-glass with the relay stopped.";
/// 8.1 `cli.break-glass-link`, `cli.break-glass-exists`, `cli.two-person-off`.
pub const BREAK_GLASS_LINK: &str = "Break-glass setup link (it works once, for 24 hours, and is shown only here):";
pub const BREAK_GLASS_EXISTS: &str = "A break-glass account already exists. Use --replace to replace it.";
pub const TWO_PERSON_OFF: &str = "Two-person control is now off.";

pub fn random(n: usize) -> Option<Vec<u8>> {
    use aws_lc_rs::rand::{SecureRandom, SystemRandom};
    let mut b = vec![0u8; n];
    SystemRandom::new().fill(&mut b).ok()?;
    Some(b)
}

pub fn random_bytes(n: usize) -> Result<Vec<u8>, ApiError> {
    random(n).ok_or_else(|| ApiError::with("write-failed", "The console could not draw random bytes; see the relay's log."))
}

/// A person's email as the book keys it (trimmed, lower case), when it looks like one.
pub fn email_of(v: Option<&str>) -> Option<String> {
    let e = js_trim(v?).to_lowercase();
    let ok = (3..=254).contains(&e.len()) && e.contains('@') && !e.starts_with('@') && !e.ends_with('@') && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(e)
}

/// The first 16 hex of the SHA-256 of a credential id (base64url): the only form of an id an answer or an audit entry
/// carries.
pub fn hint_of(id: &str) -> String {
    let raw = unb64u(id).unwrap_or_else(|| id.as_bytes().to_vec());
    sha256_hex(&raw)[..16].to_owned()
}

/// Untrusted text cleaned for the record (contract section 0): Bidi_Control and Default_Ignorable_Code_Point
/// characters and C0 and C1 controls removed, whitespace runs collapsed.
pub fn clean(s: &str) -> String {
    let kept: String = s.chars().filter(|c| !c.is_control() && !ignorable(*c)).collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Bidi_Control and Default_Ignorable_Code_Point (Unicode 15.1, DerivedCoreProperties and PropList).
pub fn ignorable(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E
        | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

/// A required `reason`: 1 to 500 characters after cleaning.
pub fn reason_of(v: Option<&Value>) -> Result<String, ApiError> {
    let r = clean(str_of(v).unwrap_or(""));
    if r.is_empty() || r.chars().count() > 500 {
        return Err(ApiError::with("invalid", "Give a reason of 1 to 500 characters."));
    }
    Ok(r)
}

fn label_of(v: Option<&Value>, kind: KeyKind) -> String {
    let label: String = clean(str_of(v).unwrap_or("")).chars().take(LABEL_MAX).collect();
    if label.is_empty() {
        match kind {
            KeyKind::Passkey => "Passkey".into(),
            KeyKind::SecurityKey => "Security key".into(),
        }
    } else {
        label
    }
}

/// The step-up challenge (3.6): SHA-256(lp(label, sid_sha256, action, target, canonical_json(params), nonce)).
pub fn stepup_challenge(sid_sha256: &[u8], action: &str, target: &str, params: &Value, nonce: &[u8]) -> Option<[u8; 32]> {
    let p = canonical_json(params).ok()?;
    Some(sha256(&lp(&[STEPUP_LABEL.as_bytes(), sid_sha256, action.as_bytes(), target.as_bytes(), &p, nonce])))
}

/// `signin-wait` with its minutes (10 for a credential from one source, 15 for an account's lockout).
fn wait_refusal(secs: i64) -> ApiError {
    let n = ((secs.max(1) + 59) / 60).max(1);
    let mut e = ApiError::with("signin-wait", format!("Too many tries. Try again in {n} minutes."));
    e.retry_after = Some(secs.max(1));
    e
}

#[cfg(test)]
thread_local! {
    /// Account lookups `login/begin` made (R3-L1: exactly one per request with an email).
    pub static ACCOUNT_LOOKUPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// ── The book ──────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PersonRole {
    Admin,
    UserManager,
    Viewer,
}

impl PersonRole {
    pub fn as_str(self) -> &'static str {
        match self {
            PersonRole::Admin => "admin",
            PersonRole::UserManager => "user-manager",
            PersonRole::Viewer => "viewer",
        }
    }

    pub fn parse(s: &str) -> Option<PersonRole> {
        match s {
            "admin" => Some(PersonRole::Admin),
            "user-manager" => Some(PersonRole::UserManager),
            "viewer" => Some(PersonRole::Viewer),
            _ => None,
        }
    }

    /// Admins and user managers: attested hardware authenticators under High (3.3).
    pub fn privileged(self) -> bool {
        self != PersonRole::Viewer
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PersonState {
    Active,
    Waiting,
    Suspended,
}

impl PersonState {
    fn as_str(self) -> &'static str {
        match self {
            PersonState::Active => "active",
            PersonState::Waiting => "waiting",
            PersonState::Suspended => "suspended",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyState {
    Working,
    Waiting,
}

/// What the client named a WebAuthn method (it never changes the enrollment outcome, R3-H1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyKind {
    Passkey,
    SecurityKey,
}

impl KeyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyKind::Passkey => "passkey",
            KeyKind::SecurityKey => "security-key",
        }
    }

    pub fn parse(s: &str) -> Option<KeyKind> {
        match s {
            "passkey" => Some(KeyKind::Passkey),
            "security-key" => Some(KeyKind::SecurityKey),
            _ => None,
        }
    }
}

/// A WebAuthn method: a passkey or a security key.
#[derive(Clone, Debug)]
pub struct Passkey {
    pub id: String,
    pub cose: String,
    pub count: u32,
    pub label: String,
    pub created: i64,
    pub last_used: i64,
    pub state: KeyState,
    /// A hub or device certificate serial, "console" or "operator" (3.2): never empty.
    pub anchor: String,
    pub invited_by: Option<String>,
    pub revoked_at: Option<i64>,
    /// credProps.rk at registration (null: the browser did not say; a registration before AC-1).
    pub rk: Option<bool>,
    /// Where a waiting passkey came from ("hub <node>", "device <serial>" or "console").
    pub from: Option<String>,
    pub kind: KeyKind,
    /// The attestation verdict at registration (3.3), None when not attested.
    pub verdict: Option<Verdict>,
}

impl Passkey {
    pub fn works(&self) -> bool {
        self.state == KeyState::Working && self.revoked_at.is_none()
    }

    /// Signs in without an email (credProps.rk not false).
    pub fn discoverable(&self) -> bool {
        self.rk != Some(false)
    }
}

/// A password (3.3): its PBKDF2 string and its anchor.
#[derive(Clone, Debug)]
pub struct PasswordMethod {
    pub hash: String,
    pub anchor: String,
    pub invited_by: Option<String>,
    pub created: i64,
    pub revoked_at: Option<i64>,
}

/// An authenticator app (3.3): the secret is sealed apart (`totp:<handle>`).
#[derive(Clone, Debug)]
pub struct TotpMethod {
    pub anchor: String,
    pub invited_by: Option<String>,
    pub created: i64,
    /// The last time step used, at sign-in or step-up: it and every earlier one are refused.
    pub last_step: Option<i64>,
    pub revoked_at: Option<i64>,
    /// The sealed secret was lost (`seal-lost`): the method no longer works.
    pub unusable: bool,
}

impl TotpMethod {
    pub fn works(&self) -> bool {
        self.revoked_at.is_none() && !self.unusable
    }
}

#[derive(Clone, Debug)]
pub struct Person {
    pub handle: String,
    pub role: PersonRole,
    pub state: PersonState,
    pub created: i64,
    pub last_sign_in: i64,
    pub invited_by: Option<String>,
    pub invited_at: i64,
    pub joined_from: Option<String>,
    pub suspended_by: Option<String>,
    pub suspend_reason: Option<String>,
    pub suspended_at: Option<i64>,
    pub unsuspended_at: Option<i64>,
    /// Not signed in since the upgrade to AC-1 (3.3).
    pub unproven: bool,
    /// The account's anchor (the one it was created with; on Meeting Hub its device anchor, 3.2 R4-4).
    pub anchor: String,
    pub passkeys: Vec<Passkey>,
    pub password: Option<PasswordMethod>,
    pub totp: Option<TotpMethod>,
    /// The break-glass account (3.3).
    pub break_glass: bool,
    /// The attention kinds an admin is mailed about (3.11); None: every `bad` item.
    pub mail_kinds: Option<Vec<String>>,
}

impl Person {
    pub(crate) fn new(handle: String, role: PersonRole, state: PersonState, anchor: &str, t: i64) -> Person {
        Person {
            handle,
            role,
            state,
            created: t,
            last_sign_in: 0,
            invited_by: None,
            invited_at: t,
            joined_from: None,
            suspended_by: None,
            suspend_reason: None,
            suspended_at: None,
            unsuspended_at: None,
            unproven: false,
            anchor: anchor.to_owned(),
            passkeys: Vec::new(),
            password: None,
            totp: None,
            break_glass: false,
            mail_kinds: None,
        }
    }

    pub fn has_password(&self) -> bool {
        self.password.as_ref().is_some_and(|p| p.revoked_at.is_none())
    }

    pub fn has_totp(&self) -> bool {
        self.totp.as_ref().is_some_and(TotpMethod::works)
    }

    /// Any working method of any kind.
    fn any_working(&self) -> bool {
        self.passkeys.iter().any(Passkey::works) || self.has_password() || self.has_totp()
    }

    fn any_revoked(&self) -> bool {
        self.passkeys.iter().any(|k| k.revoked_at.is_some()) || self.password.as_ref().is_some_and(|p| p.revoked_at.is_some()) || self.totp.as_ref().is_some_and(|m| m.revoked_at.is_some())
    }

    /// A method revoked and none working (3.2).
    pub fn revoked(&self) -> bool {
        self.any_revoked() && !self.any_working()
    }

    pub fn state_str(&self) -> &'static str {
        if self.state == PersonState::Waiting {
            "waiting"
        } else if self.revoked() {
            "revoked"
        } else {
            self.state.as_str()
        }
    }

    /// Admin-role person (2.3): role admin, not a waiting joiner (a suspended or revoked admin counts).
    pub fn admin_role(&self) -> bool {
        self.role == PersonRole::Admin && self.state != PersonState::Waiting
    }

    pub fn active(&self) -> bool {
        self.state == PersonState::Active && !self.revoked()
    }

    pub fn active_admin(&self) -> bool {
        self.role == PersonRole::Admin && self.active()
    }

    /// Working WebAuthn methods.
    pub fn working(&self) -> usize {
        self.passkeys.iter().filter(|k| k.works()).count()
    }

    pub fn working_not_discoverable(&self) -> usize {
        self.passkeys.iter().filter(|k| k.works() && !k.discoverable()).count()
    }

    pub fn waiting_keys(&self) -> usize {
        self.passkeys.iter().filter(|k| k.state == KeyState::Waiting && k.revoked_at.is_none()).count()
    }

    /// The sealed name of this account's authenticator app secret.
    pub fn totp_secret_name(&self) -> String {
        format!("totp:{}", self.handle)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InviteSource {
    Hub,
    Device,
    Console,
    /// The operator's break-glass setup link (3.3).
    Operator,
}

impl InviteSource {
    fn as_str(self) -> &'static str {
        match self {
            InviteSource::Hub => "hub",
            InviteSource::Device => "device",
            InviteSource::Console => "console",
            InviteSource::Operator => "operator",
        }
    }

    fn parse(s: &str) -> Option<InviteSource> {
        match s {
            "hub" => Some(InviteSource::Hub),
            "device" => Some(InviteSource::Device),
            "console" => Some(InviteSource::Console),
            "operator" => Some(InviteSource::Operator),
            _ => None,
        }
    }
}

/// The token kinds (R3-L2): never accepted for each other.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InviteKind {
    /// The join flow for a new account (or the break-glass setup).
    Join,
    /// The join flow for an existing account after `admins.reset-sign-in` (never mailed).
    ResetSignIn,
    /// A viewer's self-service password reset under Standard (`recover/finish` only).
    ResetPassword,
}

impl InviteKind {
    fn as_str(self) -> &'static str {
        match self {
            InviteKind::Join => "join",
            InviteKind::ResetSignIn => "reset-sign-in",
            InviteKind::ResetPassword => "reset-password",
        }
    }

    fn parse(s: &str) -> Option<InviteKind> {
        match s {
            "join" => Some(InviteKind::Join),
            "reset-sign-in" => Some(InviteKind::ResetSignIn),
            "reset-password" => Some(InviteKind::ResetPassword),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub email: String,
    pub role: PersonRole,
    pub expires: i64,
    /// The hub's node id, the device serial, the inviting person's email, or "operator".
    pub by: String,
    pub source: InviteSource,
    /// The hub or device certificate serial (hub and app invites).
    pub serial: Option<String>,
    pub kind: InviteKind,
    pub mailed: bool,
}

impl Invite {
    /// What the audit and the page call where it came from.
    pub fn from_label(&self) -> String {
        match self.source {
            InviteSource::Hub => format!("hub {}", self.by),
            InviteSource::Device => format!("device {}", self.by),
            InviteSource::Console | InviteSource::Operator => self.by.clone(),
        }
    }

    /// The anchor of a method registered from this invite (3.2).
    pub fn anchor(&self) -> String {
        match self.source {
            InviteSource::Hub | InviteSource::Device => self.serial.clone().unwrap_or_else(|| CONSOLE_ANCHOR.to_owned()),
            InviteSource::Console => CONSOLE_ANCHOR.to_owned(),
            InviteSource::Operator => OPERATOR_ANCHOR.to_owned(),
        }
    }

    /// `invitedBy` of a method registered from this invite.
    fn invited_by(&self) -> Option<String> {
        (self.source == InviteSource::Console).then(|| self.by.clone())
    }
}

/// What console.json keeps (version 3, revision 4; nothing of revision 3 ever shipped, so a version 2 book is not
/// read).
#[derive(Default)]
pub struct Book {
    pub origin: Option<String>,
    pub bootstrapped: bool,
    pub ever_two_admins: bool,
    /// The pin `reset --first-admin` wrote; it overrides the flag or setting until bootstrap.
    pub first_admin: Option<String>,
    pub upgraded_at: Option<i64>,
    pub invites: IndexMap<String, Invite>,
    pub people: IndexMap<String, Person>,
    pub revoked_anchors: BTreeSet<String>,
    /// When admin-role people were removed or demoted (kept 7 days; sole-admin condition 2).
    pub removed_at: Vec<i64>,
    /// Single-admin suspensions by requester (kept 24 hours).
    pub single_suspensions: IndexMap<String, Vec<i64>>,
    /// Hub and app invites by certificate serial (kept 24 hours).
    pub hub_invites: IndexMap<String, Vec<i64>>,
    pub settings: Settings,
    /// The last break-glass sign-in (`break-glass-used` for 7 days).
    pub break_glass_used_at: Option<i64>,
    pub approvals: Vec<Map<String, Value>>,
    pub requests: Vec<Map<String, Value>>,
    /// Offline commands' audit entries, appended at the next start.
    pub pending_audit: Vec<Value>,
}

/// An anchor: "console", "operator", or a certificate serial in lower-case hex, 1 to 128 digits (Remote Spokes serials
/// are 32; Meet device certificates' serials vary in length).
fn anchor_ok(s: &str) -> bool {
    s == CONSOLE_ANCHOR || s == OPERATOR_ANCHOR || serial_ok(s)
}

fn serial_ok(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn opt_int(v: Option<&Value>) -> Option<i64> {
    match v {
        None | Some(Value::Null) => None,
        v => is_int(v),
    }
}

fn times(v: Option<&Value>) -> Vec<i64> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
}

fn times_map(v: Option<&Value>) -> IndexMap<String, Vec<i64>> {
    v.and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.clone(), times(Some(v)))).collect()).unwrap_or_default()
}

fn times_value(m: &IndexMap<String, Vec<i64>>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

impl Book {
    /// The book in `file`: a new one when there is none yet, Err when it does not read (the console then answers 503).
    pub fn read(file: &Path, t: i64) -> Result<Book, String> {
        let Ok(raw) = std::fs::read(file) else { return Ok(Book::default()) };
        let broken = || format!("{} is not an Admin Console book", file.display());
        let text = String::from_utf8(raw).map_err(|_| broken())?;
        let parsed = parse_json(js_trim(&text)).ok_or_else(broken)?;
        let o = parsed.as_object().ok_or_else(broken)?;
        match o.get("v").and_then(Value::as_i64) {
            Some(1) => Book::read_v1(o, t).ok_or_else(broken),
            Some(3) => Book::read_v3(o).ok_or_else(broken),
            _ => Err(broken()),
        }
    }

    fn passkey_of(p: &Map<String, Value>, anchor_default: &str) -> Option<Passkey> {
        let count = u32::try_from(is_int(p.get("count"))?).ok()?;
        let state = match p.get("state").and_then(Value::as_str) {
            None | Some("working") => KeyState::Working,
            Some("waiting") => KeyState::Waiting,
            Some(_) => return None,
        };
        let anchor = opt_str(p.get("anchor")).unwrap_or_else(|| anchor_default.to_owned());
        if !anchor_ok(&anchor) {
            return None;
        }
        let verdict = match p.get("verdict") {
            None | Some(Value::Null) => None,
            Some(v) => Some(Verdict::from_value(v)?),
        };
        Some(Passkey {
            id: opt_str(p.get("id"))?,
            cose: opt_str(p.get("cose"))?,
            count,
            label: opt_str(p.get("label"))?,
            created: is_int(p.get("created"))?,
            last_used: is_int(p.get("lastUsed"))?,
            state,
            anchor,
            invited_by: opt_str(p.get("invitedBy")),
            revoked_at: opt_int(p.get("revokedAt")),
            rk: p.get("rk").and_then(Value::as_bool),
            from: opt_str(p.get("from")),
            kind: str_of(p.get("kind")).map_or(Some(KeyKind::Passkey), KeyKind::parse)?,
            verdict,
        })
    }

    /// A book from before AC-1: every admin active, bootstrapped when it holds one, each passkey anchored to the
    /// serial of the hub that last invited its admin ("console" when none was kept), every admin unproven.
    fn read_v1(o: &Map<String, Value>, t: i64) -> Option<Book> {
        if !exact_keys(o, &["v", "origin", "invites", "admins"], &["v", "invites", "admins"]) {
            return None;
        }
        let mut b = Book { origin: opt_str(o.get("origin")).filter(|s| s.starts_with("https://")), upgraded_at: Some(t), ..Book::default() };
        for (hash, v) in o.get("invites")?.as_object()? {
            let i = v.as_object()?;
            let serial = opt_str(i.get("serial")).filter(|s| is_serial(s));
            let by = opt_str(i.get("by"))?;
            b.invites.insert(hash.clone(), Invite { email: opt_str(i.get("email"))?, role: PersonRole::Admin, expires: is_int(i.get("expires"))?, by, source: InviteSource::Hub, serial, kind: InviteKind::Join, mailed: false });
        }
        for (email, v) in o.get("admins")?.as_object()? {
            let a = v.as_object()?;
            let serial = opt_str(a.get("serial")).filter(|s| is_serial(s)).unwrap_or_else(|| CONSOLE_ANCHOR.to_owned());
            let mut p = Person::new(opt_str(a.get("handle"))?, PersonRole::Admin, PersonState::Active, &serial, is_int(a.get("created"))?);
            for k in a.get("passkeys")?.as_array()? {
                p.passkeys.push(Book::passkey_of(k.as_object()?, &serial)?);
            }
            p.last_sign_in = is_int(a.get("lastSignIn"))?;
            p.unproven = true;
            b.people.insert(email.clone(), p);
        }
        b.bootstrapped = !b.people.is_empty();
        b.ever_two_admins = b.people.len() >= 2;
        Some(b)
    }

    fn read_v3(o: &Map<String, Value>) -> Option<Book> {
        let mut b = Book {
            origin: opt_str(o.get("origin")).filter(|s| s.starts_with("https://")),
            bootstrapped: o.get("bootstrapped")?.as_bool()?,
            ever_two_admins: o.get("everTwoAdmins")?.as_bool()?,
            first_admin: opt_str(o.get("firstAdmin")),
            upgraded_at: opt_int(o.get("upgradedAt")),
            settings: Settings::from_value(o.get("settings")?)?,
            break_glass_used_at: opt_int(o.get("breakGlassUsedAt")),
            ..Book::default()
        };
        for (hash, v) in o.get("invites")?.as_object()? {
            let i = v.as_object()?;
            b.invites.insert(
                hash.clone(),
                Invite {
                    email: opt_str(i.get("email"))?,
                    role: PersonRole::parse(i.get("role")?.as_str()?)?,
                    expires: is_int(i.get("expires"))?,
                    by: opt_str(i.get("by"))?,
                    source: InviteSource::parse(i.get("source")?.as_str()?)?,
                    serial: opt_str(i.get("serial")).filter(|s| serial_ok(s)),
                    kind: InviteKind::parse(i.get("kind")?.as_str()?)?,
                    mailed: i.get("mailed").and_then(Value::as_bool).unwrap_or(false),
                },
            );
        }
        for (email, v) in o.get("people")?.as_object()? {
            let a = v.as_object()?;
            let state = match a.get("state")?.as_str()? {
                "active" => PersonState::Active,
                "waiting" => PersonState::Waiting,
                "suspended" => PersonState::Suspended,
                _ => return None,
            };
            let anchor = opt_str(a.get("anchor")).filter(|s| anchor_ok(s))?;
            let mut p = Person::new(opt_str(a.get("handle"))?, PersonRole::parse(a.get("role")?.as_str()?)?, state, &anchor, is_int(a.get("created"))?);
            for k in a.get("passkeys")?.as_array()? {
                p.passkeys.push(Book::passkey_of(k.as_object()?, "")?);
            }
            p.last_sign_in = is_int(a.get("lastSignIn"))?;
            p.invited_by = opt_str(a.get("invitedBy"));
            p.invited_at = is_int(a.get("invitedAt")).unwrap_or(0);
            p.joined_from = opt_str(a.get("joinedFrom"));
            p.suspended_by = opt_str(a.get("suspendedBy"));
            p.suspend_reason = opt_str(a.get("suspendReason"));
            p.suspended_at = opt_int(a.get("suspendedAt"));
            p.unsuspended_at = opt_int(a.get("unsuspendedAt"));
            p.unproven = a.get("unproven").and_then(Value::as_bool).unwrap_or(false);
            p.break_glass = a.get("breakGlass").and_then(Value::as_bool).unwrap_or(false);
            p.mail_kinds = a.get("mailKinds").and_then(Value::as_array).map(|l| l.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect());
            p.password = match a.get("password") {
                None | Some(Value::Null) => None,
                Some(m) => {
                    let anchor = opt_str(m.get("anchor")).filter(|s| anchor_ok(s))?;
                    Some(PasswordMethod { hash: opt_str(m.get("hash"))?, anchor, invited_by: opt_str(m.get("invitedBy")), created: is_int(m.get("created"))?, revoked_at: opt_int(m.get("revokedAt")) })
                }
            };
            p.totp = match a.get("totp") {
                None | Some(Value::Null) => None,
                Some(m) => {
                    let anchor = opt_str(m.get("anchor")).filter(|s| anchor_ok(s))?;
                    Some(TotpMethod {
                        anchor,
                        invited_by: opt_str(m.get("invitedBy")),
                        created: is_int(m.get("created"))?,
                        last_step: opt_int(m.get("lastStep")),
                        revoked_at: opt_int(m.get("revokedAt")),
                        unusable: m.get("unusable").and_then(Value::as_bool).unwrap_or(false),
                    })
                }
            };
            b.people.insert(email.clone(), p);
        }
        b.revoked_anchors = o.get("revokedAnchors")?.as_array()?.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
        b.removed_at = times(o.get("removedAt"));
        b.single_suspensions = times_map(o.get("singleSuspensions"));
        b.hub_invites = times_map(o.get("hubInvites"));
        b.approvals = o.get("approvals").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_object().cloned()).collect()).unwrap_or_default();
        b.requests = o.get("requests").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_object().cloned()).collect()).unwrap_or_default();
        b.pending_audit = o.get("pendingAudit").and_then(Value::as_array).cloned().unwrap_or_default();
        Some(b)
    }

    pub fn to_value(&self) -> Value {
        let invites: Map<String, Value> = self
            .invites
            .iter()
            .map(|(h, i)| (h.clone(), json!({ "email": i.email, "role": i.role.as_str(), "expires": i.expires, "by": i.by, "source": i.source.as_str(), "serial": i.serial, "kind": i.kind.as_str(), "mailed": i.mailed })))
            .collect();
        let people: Map<String, Value> = self
            .people
            .iter()
            .map(|(e, p)| {
                let keys: Vec<Value> = p
                    .passkeys
                    .iter()
                    .map(|k| {
                        json!({
                            "id": k.id, "cose": k.cose, "count": k.count, "label": k.label, "created": k.created, "lastUsed": k.last_used,
                            "state": if k.state == KeyState::Working { "working" } else { "waiting" }, "anchor": k.anchor,
                            "invitedBy": k.invited_by, "revokedAt": k.revoked_at, "rk": k.rk, "from": k.from, "kind": k.kind.as_str(),
                            "verdict": k.verdict.as_ref().map(Verdict::to_value),
                        })
                    })
                    .collect();
                let password = p.password.as_ref().map(|m| json!({ "hash": m.hash, "anchor": m.anchor, "invitedBy": m.invited_by, "created": m.created, "revokedAt": m.revoked_at }));
                let totp = p.totp.as_ref().map(|m| json!({ "anchor": m.anchor, "invitedBy": m.invited_by, "created": m.created, "lastStep": m.last_step, "revokedAt": m.revoked_at, "unusable": m.unusable }));
                let v = json!({
                    "handle": p.handle, "role": p.role.as_str(), "state": p.state.as_str(), "created": p.created,
                    "lastSignIn": p.last_sign_in, "invitedBy": p.invited_by, "invitedAt": p.invited_at, "joinedFrom": p.joined_from,
                    "suspendedBy": p.suspended_by, "suspendReason": p.suspend_reason, "suspendedAt": p.suspended_at,
                    "unsuspendedAt": p.unsuspended_at, "unproven": p.unproven, "anchor": p.anchor, "passkeys": keys,
                    "password": password, "totp": totp, "breakGlass": p.break_glass, "mailKinds": p.mail_kinds,
                });
                (e.clone(), v)
            })
            .collect();
        json!({
            "v": 3, "origin": self.origin, "bootstrapped": self.bootstrapped, "everTwoAdmins": self.ever_two_admins,
            "firstAdmin": self.first_admin, "upgradedAt": self.upgraded_at, "invites": invites, "people": people,
            "revokedAnchors": self.revoked_anchors.iter().collect::<Vec<_>>(), "removedAt": self.removed_at,
            "singleSuspensions": times_value(&self.single_suspensions), "hubInvites": times_value(&self.hub_invites),
            "settings": self.settings.to_value(), "breakGlassUsedAt": self.break_glass_used_at,
            "approvals": self.approvals, "requests": self.requests, "pendingAudit": self.pending_audit,
        })
    }

    pub fn save(&mut self, file: &Path) -> Result<(), String> {
        self.latch_two();
        write_private(file, format!("{}\n", stringify(&self.to_value())).as_bytes()).map_err(|e| e.to_string())
    }

    /// `everTwoAdmins` latches the first time the book holds two admin-role people (N1).
    pub fn latch_two(&mut self) {
        if self.people.values().filter(|p| p.admin_role()).count() >= 2 {
            self.ever_two_admins = true;
        }
    }

    pub fn active_admins(&self) -> usize {
        self.people.values().filter(|p| p.active_admin()).count()
    }

    pub fn joiners(&self) -> usize {
        self.people.values().filter(|p| p.state == PersonState::Waiting).count()
    }

    pub fn admitted(&self) -> usize {
        self.people.len() - self.joiners()
    }

    /// The person and WebAuthn method with this credential id.
    pub fn find(&self, id: &str) -> Option<(&String, &Person, &Passkey)> {
        self.people.iter().find_map(|(e, p)| p.passkeys.iter().find(|k| k.id == id).map(|k| (e, p, k)))
    }

    /// The byte lengths of every registered credential id that is not discoverable (the decoy lengths, R3-L1).
    pub fn not_discoverable_lengths(&self) -> Vec<usize> {
        let mut v: Vec<usize> = self.people.values().flat_map(|p| p.passkeys.iter().filter(|k| !k.discoverable()).filter_map(|k| unb64u(&k.id).map(|r| r.len()))).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// Latch every method anchored to these serials (3.2): `revoked_at` written, the serial kept. The emails whose
    /// methods were latched now.
    pub fn latch<'a>(&mut self, serials: impl IntoIterator<Item = &'a String>, t: i64) -> Vec<String> {
        let mut hit = Vec::new();
        for s in serials {
            if s == CONSOLE_ANCHOR || s == OPERATOR_ANCHOR || s.is_empty() {
                continue;
            }
            self.revoked_anchors.insert(s.clone());
            for (e, p) in self.people.iter_mut() {
                let mut any = false;
                for k in p.passkeys.iter_mut().filter(|k| k.anchor == *s && k.revoked_at.is_none()) {
                    k.revoked_at = Some(t);
                    any = true;
                }
                if let Some(m) = p.password.as_mut().filter(|m| m.anchor == *s && m.revoked_at.is_none()) {
                    m.revoked_at = Some(t);
                    any = true;
                }
                if let Some(m) = p.totp.as_mut().filter(|m| m.anchor == *s && m.revoked_at.is_none()) {
                    m.revoked_at = Some(t);
                    any = true;
                }
                if any && !hit.contains(e) {
                    hit.push(e.clone());
                }
            }
        }
        hit
    }

    /// Drop what has run out: invites, waiting joiners and waiting passkeys after 7 days, old counters. Whether
    /// anything changed, and the waiting joiners dropped.
    pub fn sweep(&mut self, t: i64) -> (bool, Vec<String>) {
        let before = (self.invites.len(), self.people.len(), self.removed_at.len());
        self.invites.retain(|_, i| i.expires > t);
        let gone: Vec<String> = self.people.iter().filter(|(_, p)| p.state == PersonState::Waiting && t - p.created > WAITING_MS).map(|(e, _)| e.clone()).collect();
        for e in &gone {
            self.people.shift_remove(e);
        }
        let mut keys_changed = false;
        for p in self.people.values_mut() {
            let n = p.passkeys.len();
            if p.state != PersonState::Waiting {
                p.passkeys.retain(|k| !(k.state == KeyState::Waiting && t - k.created > WAITING_MS));
            }
            keys_changed |= n != p.passkeys.len();
        }
        self.removed_at.retain(|at| t - *at < 7 * DAY);
        for v in self.single_suspensions.values_mut() {
            v.retain(|at| t - *at < DAY);
        }
        self.single_suspensions.retain(|_, v| !v.is_empty());
        for v in self.hub_invites.values_mut() {
            v.retain(|at| t - *at < DAY);
        }
        self.hub_invites.retain(|_, v| !v.is_empty());
        let changed = keys_changed || before != (self.invites.len(), self.people.len(), self.removed_at.len());
        (changed, gone)
    }

    /// Remove a person: their methods and open invites. (methods, invites) removed.
    pub fn remove_person(&mut self, email: &str) -> (usize, usize) {
        let methods = self.people.shift_remove(email).map_or(0, |p| p.passkeys.len() + usize::from(p.password.is_some()) + usize::from(p.totp.is_some()));
        let before = self.invites.len();
        self.invites.retain(|_, i| i.email != email);
        (methods, before - self.invites.len())
    }

    /// The open invite a token names, of one of `kinds`, or 410.
    pub fn invite(&self, token: Option<&str>, kinds: &[InviteKind], t: i64) -> Result<(String, &Invite), ApiError> {
        let gone = || ApiError::with("gone", GONE);
        let token = token.filter(|s| s.len() == 43 && unb64u(s).is_some()).ok_or_else(gone)?;
        let hash = sha256_hex(token.as_bytes());
        let i = self.invites.get(&hash).filter(|i| i.expires > t && kinds.contains(&i.kind)).ok_or_else(gone)?;
        Ok((hash, i))
    }

    /// A person's WebAuthn rows for `me` and the Admins page; `full` adds anchors (never for user managers, 4.3);
    /// `approved` marks an approved security key (attested, or under Standard a listed model, 3.3).
    pub fn passkeys_view(p: &Person, list: &[String], full: bool, approved: &dyn Fn(&Passkey) -> bool) -> Vec<Value> {
        p.passkeys
            .iter()
            .map(|k| {
                let state = if k.revoked_at.is_some() {
                    "revoked"
                } else if k.state == KeyState::Working {
                    "working"
                } else {
                    "waiting"
                };
                let mut v = json!({
                    "hint": hint_of(&k.id), "label": k.label, "kind": k.kind.as_str(), "discoverable": k.discoverable(), "state": state,
                    "attested": k.verdict.as_ref().map(|v| v.view(list)), "approved": approved(k), "createdAt": k.created, "lastUsedAt": k.last_used,
                });
                if full {
                    v["anchor"] = Value::from(k.anchor.as_str());
                    v["invitedBy"] = json!(k.invited_by);
                    v["revokedAt"] = json!(k.revoked_at);
                }
                v
            })
            .collect()
    }

    /// The 4.2 and 4.3 `methods` object.
    pub fn methods_view(p: &Person, list: &[String], full: bool, approved: &dyn Fn(&Passkey) -> bool) -> Value {
        json!({ "webauthn": Book::passkeys_view(p, list, full, approved), "password": p.has_password(), "totp": p.has_totp() })
    }
}

// ── console.lock ──────────────────────────────────────────────────────────────────────────────────────────────

/// An exclusive advisory lock on `console.lock`, held by a running relay for its whole life and by every offline
/// command; the operating system lets it go when the process ends, so a crashed relay never blocks the CLI.
pub struct StateLock {
    _file: std::fs::File,
}

#[cfg(unix)]
mod flock {
    use std::os::raw::c_int;
    extern "C" {
        pub fn flock(fd: c_int, operation: c_int) -> c_int;
    }
    pub const LOCK_EX: c_int = 2;
    pub const LOCK_NB: c_int = 4;
}

/// Take `console.lock` in `dir`, or say why not (`RUNNING` when another process holds it).
pub fn lock_state(dir: &Path) -> Result<StateLock, String> {
    let _ = crate::store::make_dir(dir);
    let path = dir.join(LOCK_FILE);
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // No sharing: a second open, by any process, fails while this handle lives.
        o.share_mode(0);
    }
    let file = match o.open(&path) {
        Ok(f) => f,
        Err(e) if e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33) => return Err(RUNNING.into()),
        Err(e) => return Err(format!("cannot open {}: {e}", path.display())),
    };
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: flock on a file descriptor this function owns; no memory is shared with the call.
        let r = unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_EX | flock::LOCK_NB) };
        if r != 0 {
            return Err(RUNNING.into());
        }
    }
    Ok(StateLock { _file: file })
}

// ── Offline commands ──────────────────────────────────────────────────────────────────────────────────────────

/// The operator's commands with the relay stopped (3.2 "Offline").
pub enum Offline {
    RemoveAdmin(String),
    Unsuspend(String),
    ApproveJoin { email: String, admin: bool },
    Reset { first_admin: String, typed_host: String },
    /// `console break-glass --email <email> [--replace]` (3.3). `origin`: the console's origin when the product knows it
    /// (Meeting Hub's console_public); else the book's.
    BreakGlass { email: String, replace: bool, origin: Option<String> },
    /// `console two-person off` (3.7).
    TwoPersonOff,
}

fn pending(book: &mut Book, action: &str, target: &str, detail: Value, t: i64) {
    book.pending_audit.push(json!({ "ts": t, "actor": "operator", "action": action, "target": target, "detail": detail }));
}

/// The host name of the console's origin as the book records it (what `reset` asks the operator to type).
pub fn book_host(state_dir: &Path) -> Option<String> {
    let book = Book::read(&state_dir.join(CONSOLE_FILE), 0).ok()?;
    book.origin.map(|o| crate::console::rp_id_of(&o))
}

/// Run one offline command on `state_dir/console.json`, holding `console.lock`. `admin_ok(email, anchor)` is the
/// product's check for `approve-join --role admin` and `break-glass` (Meeting Hub: the email is in `admins` and, for
/// approve-join, the method made active is anchored to a device of that principal). What was done, or why not.
pub fn run_offline(state_dir: &Path, cmd: Offline, host: &str, admin_ok: &dyn Fn(&str, &str) -> Result<(), String>) -> Result<String, String> {
    let _lock = lock_state(state_dir)?;
    let file = state_dir.join(CONSOLE_FILE);
    let t = crate::codec::now_ms();
    let mut book = Book::read(&file, t)?;
    let norm = |e: &str| email_of(Some(e)).ok_or_else(|| format!("{e} is not an email address"));
    let done = match cmd {
        Offline::RemoveAdmin(email) => {
            let email = norm(&email)?;
            if !book.people.contains_key(&email) {
                let known: Vec<&str> = book.people.keys().map(String::as_str).collect();
                return Err(format!("{} has no admin {email} (people: {})", file.display(), if known.is_empty() { "none".into() } else { known.join(", ") }));
            }
            let was_admin = book.people.get(&email).is_some_and(Person::admin_role);
            let (methods, invites) = book.remove_person(&email);
            if was_admin {
                book.removed_at.push(t);
            }
            crate::console_approvals::cancel_for(&mut book, &email, t);
            pending(&mut book, "admins.remove", &email, json!({ "methods": methods, "invites": invites }), t);
            format!("removed admin {email}: {methods} sign-in method(s), {invites} open invite(s); {} admin(s) left", book.people.values().filter(|p| p.admin_role()).count())
        }
        Offline::Unsuspend(email) => {
            let email = norm(&email)?;
            let p = book.people.get_mut(&email).ok_or_else(|| format!("{email} is not in the book"))?;
            if p.state != PersonState::Suspended {
                return Err(format!("{email} is not suspended"));
            }
            p.state = PersonState::Active;
            p.unsuspended_at = Some(t);
            pending(&mut book, "admins.unsuspend", &email, Value::Null, t);
            format!("{email} is active again")
        }
        Offline::ApproveJoin { email, admin } => {
            let email = norm(&email)?;
            let p = book.people.get(&email).ok_or_else(|| format!("{email} is not in the book"))?;
            let waiting_person = p.state == PersonState::Waiting;
            let key = p.passkeys.iter().filter(|k| k.revoked_at.is_none() && (waiting_person || k.state == KeyState::Waiting)).max_by_key(|k| k.created).map(|k| (k.id.clone(), k.anchor.clone()));
            let Some((id, anchor)) = key else { return Err(format!("{email} has no waiting passkey")) };
            if admin {
                admin_ok(&email, &anchor)?;
            }
            let p = book.people.get_mut(&email).ok_or("gone")?;
            if waiting_person {
                p.state = PersonState::Active;
                for k in p.passkeys.iter_mut() {
                    k.state = KeyState::Working;
                }
            }
            if let Some(k) = p.passkeys.iter_mut().find(|k| k.id == id) {
                k.state = KeyState::Working;
            }
            if admin {
                p.role = PersonRole::Admin;
                p.state = PersonState::Active;
                p.anchor = anchor.clone();
            }
            let role = p.role.as_str();
            book.bootstrapped |= admin;
            pending(&mut book, "admins.approve-join", &email, json!({ "role": role, "credential_hint": hint_of(&id) }), t);
            format!("{email} is active as {role}")
        }
        Offline::Reset { first_admin, typed_host } => {
            let first = norm(&first_admin).map_err(|_| "reset needs --first-admin <email>".to_owned())?;
            if js_trim(&typed_host) != host {
                return Err(format!("type this relay's host name ({host}) to reset the console"));
            }
            let origin = book.origin.clone();
            let settings = std::mem::take(&mut book.settings);
            book = Book { origin, settings, first_admin: Some(first.clone()), ..Book::default() };
            pending(&mut book, "console.reset", &first, json!({ "firstAdmin": first }), t);
            format!("the console is reset; it waits for its first admin, {first}")
        }
        Offline::BreakGlass { email, replace, origin } => {
            let email = norm(&email)?;
            let existing = book.people.iter().find(|(_, p)| p.break_glass).map(|(e, _)| e.clone());
            if let Some(old) = &existing {
                if !replace {
                    return Err(BREAK_GLASS_EXISTS.into());
                }
                book.remove_person(old);
            }
            if book.people.contains_key(&email) {
                return Err(format!("{email} already has access to this console: the break-glass account needs an email of its own"));
            }
            admin_ok(&email, OPERATOR_ANCHOR)?;
            let origin = origin.or_else(|| book.origin.clone()).ok_or("the console has no address yet: give its first admin an invite from a hub first, then run this again")?;
            let token = random(32).map(|b| b64u(&b)).ok_or("the console could not draw random bytes")?;
            let handle = random(16).map(|b| b64u(&b)).ok_or("the console could not draw random bytes")?;
            let mut p = Person::new(handle, PersonRole::Admin, PersonState::Active, OPERATOR_ANCHOR, t);
            p.break_glass = true;
            p.invited_by = Some("operator".into());
            book.people.insert(email.clone(), p);
            book.invites.retain(|_, i| i.email != email);
            book.invites.insert(
                sha256_hex(token.as_bytes()),
                Invite { email: email.clone(), role: PersonRole::Admin, expires: t + INVITE_MS, by: "operator".into(), source: InviteSource::Operator, serial: None, kind: InviteKind::Join, mailed: false },
            );
            pending(&mut book, "break-glass.create", &email, json!({ "replaced": existing }), t);
            format!("{BREAK_GLASS_LINK}\n{origin}/console/#join={token}")
        }
        Offline::TwoPersonOff => {
            if !book.settings.two_person {
                return Ok(TWO_PERSON_OFF.into());
            }
            book.settings.two_person = false;
            pending(&mut book, "two-person.off", "-", Value::Null, t);
            TWO_PERSON_OFF.into()
        }
    };
    book.save(&file)?;
    Ok(done)
}

// ── Sessions, ceremonies, step-up ─────────────────────────────────────────────────────────────────────────────

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum Kind {
    Register,
    Login,
}

/// Where an unauthenticated sign-in ceremony stands (3.3): each stage is used once.
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum Stage {
    /// After `login/begin`.
    Begin,
    /// Standard: the password was right; the second factor is next.
    PasswordOk,
    /// High with `requirePassword` (or the break-glass account): the assertion verified; the password is next.
    WebauthnOk,
    /// The account has no password: the restricted setup session that can only set one (R3-M1).
    SetPassword,
}

pub struct Ceremony {
    pub kind: Kind,
    pub challenge: Vec<u8>,
    pub expires: i64,
    /// Register: the invite's email. Login: the email as typed (normalized; "" for a discoverable sign-in).
    pub email: String,
    pub invite: String,
    pub handle: String,
    /// The source key that asked for it.
    pub source: String,
    /// When it began (a WebAuthn ceremony begun before a lockout's wait still completes).
    pub began: i64,
    pub stage: Stage,
    /// The account a verified factor found.
    pub account: String,
    /// The WebAuthn method a verified assertion used (its credential id).
    pub method: String,
    /// What the client named the method it registers.
    pub key_kind: KeyKind,
    /// `banner: true` at `login/begin`.
    pub banner: bool,
}

impl Ceremony {
    fn new(kind: Kind, challenge: Vec<u8>, email: String, source: &str, t: i64) -> Ceremony {
        Ceremony {
            kind,
            challenge,
            expires: t + CEREMONY_MS,
            email,
            invite: String::new(),
            handle: String::new(),
            source: source.to_owned(),
            began: t,
            stage: Stage::Begin,
            account: String::new(),
            method: String::new(),
            key_kind: KeyKind::Passkey,
            banner: false,
        }
    }
}

pub struct StepCeremony {
    pub id: String,
    pub nonce: Vec<u8>,
    /// The bound challenge (3.6): the TOTP binding is compared against it before the code is checked.
    pub binding: [u8; 32],
    pub action: String,
    pub expires: i64,
    /// The High enrollment step-up (R3-H1).
    pub enrollment: bool,
}

pub struct AddCeremony {
    pub id: String,
    pub challenge: Vec<u8>,
    pub expires: i64,
    pub anchor: String,
    pub invited_by: Option<String>,
    pub kind: KeyKind,
    /// Enrolled through the enrollment step-up: stored `waiting` (R3-H1).
    pub waiting: bool,
}

/// An authenticator app being set up: the secret held in memory until a current code confirms it.
pub struct TotpEnrollment {
    pub id: String,
    pub secret: Vec<u8>,
    pub anchor: String,
    pub invited_by: Option<String>,
    pub expires: i64,
}

pub struct Session {
    pub sid_sha256: Vec<u8>,
    pub email: String,
    /// The method that made the session: a credential id, or "totp" (Standard, password and authenticator app).
    pub method: String,
    /// The anchor of that method.
    pub anchor: String,
    /// Started with a WebAuthn method (High accepts nothing else).
    pub webauthn: bool,
    /// The methods that signed in, as `signin.ok` records them.
    pub methods: Vec<String>,
    pub origin: String,
    pub created: i64,
    pub last: i64,
    pub ip: String,
    pub agent: String,
    /// When the login banner was accepted (3.4).
    pub banner_at: Option<i64>,
    pub stepups: VecDeque<StepCeremony>,
    pub adding: Option<AddCeremony>,
    pub totp: Option<TotpEnrollment>,
}

/// The console's mutable state behind its lock.
#[derive(Default)]
pub struct Inner {
    pub book: Book,
    /// console.json (or console-secrets.json) did not read: every route answers 503.
    pub unreadable: bool,
    /// Sessions by the hex SHA-256 of their id.
    pub sessions: HashMap<String, Session>,
    pub ceremonies: IndexMap<String, Ceremony>,
    pub limits: Limits,
    pub failures: Failures,
    /// The per-email lockout (3.3, AC-7).
    pub lockout: Lockout,
    /// Authenticator apps being set up from an invite, by enrollment id.
    pub join_totp: HashMap<String, (String, TotpEnrollment)>,
    /// The serials the relay's current CRL (or Meet's denied set) revokes.
    pub revoked: HashSet<String>,
    /// Out-of-list sources already logged this minute.
    pub source_logged: HashMap<String, i64>,
    /// Links of approved Remote Spokes admin invites, by approval id, for the requester (never stored).
    pub approved_links: HashMap<String, (String, String, i64)>,
    /// Approvals being carried out now (two approvers at once run it once).
    pub running: HashSet<String>,
}

/// The signed-in caller as a request sees it.
#[derive(Clone, Debug)]
pub struct Who {
    pub sid: String,
    pub email: String,
    pub role: PersonRole,
    /// The rights this session holds now (2.3).
    pub rights: Rights,
    /// Why they are fewer than the role's: "not-attested" or "not-device-anchored".
    pub why: Option<&'static str>,
    /// Admin rights in this session.
    pub admin: bool,
    /// Admin or user manager rights in this session.
    pub manager: bool,
}

impl Who {
    /// The session holds its role's full rights (3.3 "Adding methods").
    pub fn privileged(&self) -> bool {
        self.why.is_none()
    }
}

/// A step-up that verified (3.6): the method that made it and its anchor.
#[derive(Clone, Debug, Default)]
pub struct StepOk {
    /// A credential id, or "totp".
    pub method: String,
    pub anchor: String,
    pub invited_by: Option<String>,
    pub enrollment: bool,
}

/// What a step-up is bound to (3.6): the action, the target and the parameters (the body without `stepup`).
#[derive(Clone, Copy)]
pub struct Bind<'a> {
    pub action: &'a str,
    pub target: &'a str,
    pub params: &'a Value,
}

pub fn sid_hash_of(cookie_value: &str) -> Option<(String, Vec<u8>)> {
    let raw = unb64u(cookie_value).filter(|r| r.len() == 32)?;
    let h = sha256(&raw).to_vec();
    Some((crate::codec::hex(&h), h))
}

impl Inner {
    /// One unauthenticated ceremony; when the table is full the oldest of the source holding the most goes.
    pub fn ceremony(&mut self, c: Ceremony, t: i64) -> Result<String, ApiError> {
        self.ceremonies.retain(|_, c| c.expires > t);
        while self.ceremonies.values().filter(|x| x.source == c.source).count() >= CEREMONIES_PER_SOURCE {
            let Some(i) = self.ceremonies.values().position(|x| x.source == c.source) else { break };
            self.ceremonies.shift_remove_index(i);
        }
        while self.ceremonies.len() >= CEREMONIES_MAX {
            let mut per: HashMap<&str, usize> = HashMap::new();
            for x in self.ceremonies.values() {
                *per.entry(x.source.as_str()).or_insert(0) += 1;
            }
            let Some(big) = per.into_iter().max_by_key(|(_, n)| *n).map(|(s, _)| s.to_owned()) else { break };
            let Some(i) = self.ceremonies.values().position(|x| x.source == big) else { break };
            self.ceremonies.shift_remove_index(i);
        }
        let id = b64u(&random_bytes(16)?);
        self.ceremonies.insert(id.clone(), c);
        Ok(id)
    }

    /// The ceremony `id` of `kind` at one of `stages`, taken out (used once).
    pub fn take(&mut self, id: Option<&str>, kind: Kind, stages: &[Stage], t: i64) -> Option<Ceremony> {
        let id = id.unwrap_or("");
        let ok = self.ceremonies.get(id).is_some_and(|c| c.kind == kind && c.expires > t && stages.contains(&c.stage));
        if !ok {
            self.ceremonies.shift_remove(id);
            return None;
        }
        self.ceremonies.shift_remove(id)
    }

    /// Put a ceremony back at its next stage under the same id.
    fn advance(&mut self, id: &str, c: Ceremony) {
        self.ceremonies.insert(id.to_owned(), c);
    }

    /// End every session of `email` (and, with `method`, only those that method started). How many ended.
    pub fn end_sessions(&mut self, email: &str, method: Option<&str>) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| !(s.email == email && method.is_none_or(|k| s.method == k)));
        before - self.sessions.len()
    }

    /// End the sessions held by a person no longer allowed in, or started with a method that no longer works.
    pub fn end_dead_sessions(&mut self) {
        let book = &self.book;
        self.sessions.retain(|_, s| {
            book.people.get(&s.email).is_some_and(|p| {
                p.active()
                    && if s.method == "totp" {
                        p.has_totp() && p.has_password()
                    } else {
                        p.passkeys.iter().any(|k| k.id == s.method && k.works())
                    }
            })
        });
    }

    /// Note a failed sign-in attempt for the typed email (or the account a discoverable passkey found). The account
    /// whose wait began now, when it exists (`signin.locked`).
    fn lock_fail(&mut self, email: &str, t: i64) -> Option<String> {
        if email.is_empty() {
            return None;
        }
        let key = Lockout::key(email);
        let started = self.lockout.fail(&key, t);
        if started && self.book.people.contains_key(&key) {
            return Some(key);
        }
        None
    }

    /// A new session (a new id at every sign-in): the Set-Cookie value, a browser session cookie with no Max-Age.
    #[allow(clippy::too_many_arguments)]
    pub fn new_session(&mut self, cookie: &str, email: &str, (method, anchor, webauthn): (&str, &str, bool), methods: Vec<String>, origin: &str, (ip, agent): (&str, &str), banner_at: Option<i64>, t: i64) -> Result<String, ApiError> {
        let (idle, max) = (self.book.settings.idle_ms(), self.book.settings.max_ms());
        self.sessions.retain(|_, s| t - s.last <= idle && t - s.created <= max);
        while self.sessions.values().filter(|s| s.email == email).count() >= SESSIONS_PER_PERSON {
            let Some(oldest) = self.sessions.iter().filter(|(_, s)| s.email == email).min_by_key(|(_, s)| s.created).map(|(k, _)| k.clone()) else { break };
            self.sessions.remove(&oldest);
        }
        while self.sessions.len() >= SESSIONS_MAX {
            let Some(oldest) = self.sessions.iter().min_by_key(|(_, s)| s.created).map(|(k, _)| k.clone()) else { break };
            self.sessions.remove(&oldest);
        }
        let raw = random_bytes(32)?;
        let value = b64u(&raw);
        let h = sha256(&raw).to_vec();
        let agent: String = clean(agent).chars().take(AGENT_MAX).collect();
        let s = Session {
            sid_sha256: h.clone(),
            email: email.to_owned(),
            method: method.to_owned(),
            anchor: anchor.to_owned(),
            webauthn,
            methods,
            origin: origin.to_owned(),
            created: t,
            last: t,
            ip: ip.to_owned(),
            agent,
            banner_at,
            stepups: VecDeque::new(),
            adding: None,
            totp: None,
        };
        self.sessions.insert(crate::codec::hex(&h), s);
        Ok(format!("{cookie}={value}; Path=/; Secure; HttpOnly; SameSite=Strict"))
    }

    /// Whether a source holding no live session should be logged for being outside the list (once a minute).
    pub fn log_source_once(&mut self, key: &str, t: i64) -> bool {
        if self.source_logged.len() > 10_000 {
            self.source_logged.retain(|_, at| t - *at < MINUTE);
        }
        match self.source_logged.get(key) {
            Some(at) if t - *at < MINUTE => false,
            _ => {
                self.source_logged.insert(key.to_owned(), t);
                true
            }
        }
    }
}

/// Whether an account has every method its profile asks (3.3), `attested` judging a WebAuthn method under High.
pub fn complete(p: &Person, s: &Settings, attested: &dyn Fn(&Passkey) -> bool) -> bool {
    let webauthn = p.passkeys.iter().any(Passkey::works);
    let needs_password = s.require_password || p.break_glass;
    if s.high() {
        let key_ok = if p.break_glass { p.passkeys.iter().any(|k| k.works() && attested(k)) } else { webauthn };
        key_ok && (!needs_password || p.has_password())
    } else if p.break_glass {
        p.has_password() && p.has_totp()
    } else if s.require_password {
        p.has_password() && (webauthn || p.has_totp())
    } else {
        webauthn || (p.has_password() && p.has_totp())
    }
}

// ── The console's auth routes ─────────────────────────────────────────────────────────────────────────────────

/// The registration options invites, `passkeys/add` and `account/security-key` answer (3.3): ES256 or RS256, user
/// verification required, a discoverable credential preferred, `credProps` asked, attestation `direct` for a security
/// key or for an admin or user manager under High.
fn creation_options(challenge: &[u8], rp_id: &str, handle: &str, email: &str, exclude: &[String], direct: bool, kind: KeyKind) -> Value {
    let exclude: Vec<Value> = exclude.iter().map(|id| json!({ "type": "public-key", "id": id })).collect();
    let mut selection = json!({ "residentKey": "preferred", "requireResidentKey": false, "userVerification": "required" });
    if kind == KeyKind::SecurityKey {
        selection["authenticatorAttachment"] = Value::from("cross-platform");
    }
    json!({
        "challenge": b64u(challenge),
        "rp": { "id": rp_id, "name": "Lucid Admin Console" },
        "user": { "id": handle, "name": email, "displayName": email },
        "pubKeyCredParams": crate::console_webauthn::pub_key_params(),
        "timeout": CEREMONY_MS,
        "attestation": if direct { "direct" } else { "none" },
        "authenticatorSelection": selection,
        "excludeCredentials": exclude,
        "extensions": { "credProps": true },
    })
}

fn assertion_options(challenge: &[u8], rp_id: &str, allow: &[String], timeout: i64) -> Value {
    let allow: Vec<Value> = allow.iter().map(|id| json!({ "type": "public-key", "id": id })).collect();
    json!({ "challenge": b64u(challenge), "rpId": rp_id, "timeout": timeout, "userVerification": "required", "allowCredentials": allow })
}

impl Console {
    fn revoked_words(&self) -> &'static str {
        if self.is_meet() {
            REVOKED_MEET
        } else {
            REVOKED_SPOKES
        }
    }

    fn anchor_refusal(&self) -> ApiError {
        ApiError::with("anchor-revoked", self.revoked_words())
    }

    fn rp(&self, origin: &str) -> String {
        crate::console::rp_id_of(origin)
    }

    /// Whether a WebAuthn method is an attested hardware authenticator now (3.3 steps 3 to 5) against the snapshot in
    /// force and the approved list. Takes the MDS lock; never call while holding it.
    pub(crate) fn attested_now(&self, k: &Passkey, list: &[String]) -> bool {
        let Some(v) = &k.verdict else { return false };
        let mds = self.mds.lock();
        crate::console_mds::attested(v, mds.current.as_ref(), list)
    }

    /// An approved security key (3.3): attested now, or under Standard a model on the list without FIPS evidence
    /// (`console_mds::relaxed`, never under High). Takes the MDS lock; the book's lock may be held.
    pub(crate) fn approved_key(&self, k: &Passkey, list: &[String], high: bool) -> bool {
        let Some(v) = &k.verdict else { return false };
        let mds = self.mds.lock();
        crate::console_mds::attested(v, mds.current.as_ref(), list) || crate::console_mds::relaxed(v, mds.current.as_ref(), list, high)
    }

    /// Whether a WebAuthn method carries the account's anchor (3.3, R3-H1): on Meeting Hub, for an admin, a device
    /// anchor of that principal; otherwise the anchor the account was created with.
    fn carries_account_anchor(&self, email: &str, p: &Person, k: &Passkey) -> bool {
        if self.is_meet() && p.role == PersonRole::Admin && !p.break_glass {
            return self.admin_rule(email, &k.anchor) == AdminRule::Admin;
        }
        k.anchor == p.anchor
    }

    /// The break-glass account has both of its required methods working (3.3).
    pub(crate) fn break_glass_complete_of(&self, p: &Person, s: &Settings) -> bool {
        let list = s.aaguid_list();
        complete(p, s, &|k| self.attested_now(k, &list))
    }

    /// The High setup gate (R3-M9): on while the break-glass account is missing or not complete.
    pub(crate) fn break_glass_gate(&self) -> bool {
        let (s, bg) = {
            let inner = self.inner.lock();
            (inner.book.settings.clone(), inner.book.people.values().find(|p| p.break_glass).cloned())
        };
        s.high() && !bg.is_some_and(|p| self.break_glass_complete_of(&p, &s))
    }

    /// The serials the relay's CRL (Remote Spokes) or denied set and CRLs (Meeting Hub) revoke now: every method
    /// anchored to one is latched before anything else is answered, and its sessions end.
    pub fn set_revoked(&self, serials: &HashSet<String>) {
        let t = crate::codec::now_ms();
        let hit = {
            let mut inner = self.inner.lock();
            inner.revoked.extend(serials.iter().cloned());
            let hit = inner.book.latch(serials.iter(), t);
            if !hit.is_empty() {
                inner.end_dead_sessions();
                let _ = self.save_book(&mut inner);
            }
            hit
        };
        for email in hit {
            let f = Fields::new().with("email", &email).with("why", "the certificate that anchors this person's sign-in methods is revoked");
            self.logger.security("console.admin-revoked", &f, Level::Warn);
            let mut r = Record::new("relay", "passkeys.revoked", "ok");
            r.target = Some(email);
            self.record(r, t);
        }
    }

    /// POST /v1/console/invite from a hub with the drive scope, for the user its certificate names. The first invite
    /// fixes a Remote Spokes console's origin.
    pub fn invite(&self, email: &str, by: &str, serial: &str, dialed: &crate::relay::Dialed, t: i64) -> Result<Invited, Refused> {
        let origin = crate::console::origin_of(dialed).map_err(|e| Refused { status: 409, error: e, event: "console.invite-refused" })?;
        let fixed = self.cfg.origin.clone().or_else(|| self.inner.lock().book.origin.clone());
        if let Some(o) = fixed.filter(|o| *o != origin) {
            let why = format!("this relay's Admin Console is at {o}: ask for the invite through that address (to move it, stop the relay and run lucid-relay console reset)");
            return Err(Refused { status: 409, error: why, event: "console.invite-refused" });
        }
        self.mint_cert_invite(email, InviteSource::Hub, by, serial, &origin, t)
    }

    /// POST /v1/admin/console/invite on a Meeting Hub relay's main port: the calling principal's own invite, from the
    /// device whose certificate has `serial`.
    pub fn invite_device(&self, principal: &str, serial: &str, t: i64) -> Result<Invited, Refused> {
        let Some(origin) = self.cfg.origin.clone() else {
            return Err(Refused { status: 409, error: "The Admin Console is turned off on this relay. Set console_port in relay.json.".into(), event: "console.invite-refused" });
        };
        self.mint_cert_invite(principal, InviteSource::Device, serial, serial, &origin, t)
    }

    fn mint_cert_invite(&self, email: &str, source: InviteSource, by: &str, serial: &str, origin: &str, t: i64) -> Result<Invited, Refused> {
        let refuse = |status: u16, error: String| Refused { status, error, event: "console.invite-refused" };
        let email = email_of(Some(email)).ok_or_else(|| refuse(400, "an invite is for a person's email".into()))?;
        let mut inner = self.inner.lock();
        if inner.unreadable {
            return Err(refuse(503, ApiError::of("state-unreadable").message));
        }
        inner.book.sweep(t);
        if inner.book.revoked_anchors.contains(serial) || inner.revoked.contains(serial) {
            return Err(refuse(403, self.revoked_words().into()));
        }
        if !inner.book.bootstrapped {
            let pin = inner.book.first_admin.clone().or_else(|| self.cfg.first_admin.clone());
            if pin.as_deref() != Some(email.as_str()) {
                let words = format!("This console waits for its first admin, {}.", pin.unwrap_or_default());
                return Err(refuse(409, words));
            }
        } else {
            let used = inner.book.hub_invites.get(serial).map_or(0, Vec::len);
            if used >= HUB_INVITES_PER_DAY {
                return Err(Refused { status: 429, error: "This hub or device has asked for 3 invites today. Try again tomorrow.".into(), event: "console.invite-limit" });
            }
        }
        let token = random(32).map(|b| b64u(&b)).ok_or_else(|| refuse(500, "the console could not draw random bytes".into()))?;
        let book = &mut inner.book;
        // A newer invite from the same certificate for the same person replaces the older one.
        book.invites.retain(|_, i| !(i.email == email && i.source == source && i.serial.as_deref() == Some(serial)));
        while book.invites.len() >= INVITES_MAX {
            book.invites.shift_remove_index(0);
        }
        let expires = t + INVITE_MS;
        book.invites.insert(sha256_hex(token.as_bytes()), Invite { email: email.clone(), role: PersonRole::Admin, expires, by: by.to_owned(), source, serial: Some(serial.to_owned()), kind: InviteKind::Join, mailed: false });
        if book.bootstrapped {
            book.hub_invites.entry(serial.to_owned()).or_default().push(t);
        }
        if self.cfg.origin.is_none() {
            book.origin = Some(origin.to_owned());
        }
        if self.save_book(&mut inner).is_err() {
            return Err(refuse(500, "the console could not save its state".into()));
        }
        drop(inner);
        let actor = match source {
            InviteSource::Hub => format!("hub {by}"),
            _ => format!("device {serial}"),
        };
        let mut r = Record::new(&actor, "invites.new", "ok");
        r.target = Some(email);
        r.detail = json!({ "from": source.as_str(), "serial": serial, "expires": expires });
        self.record(r, t);
        Ok(Invited { link: format!("{origin}/console/#join={token}"), expires, origin: origin.to_owned() })
    }

    /// Mint a console token (a viewer or user manager invite, an approved Remote Spokes admin invite, a sign-in reset
    /// or a password reset): the link, shown once, and when it ends. Any open token of the same kind for that email
    /// is replaced (the old one deleted at once).
    pub(crate) fn mint_console_token(&self, email: &str, role: PersonRole, by: &str, kind: InviteKind, mailed: bool, t: i64) -> Result<(String, i64), ApiError> {
        let origin = self.origin().ok_or_else(|| ApiError::with("invalid", "The console has no address yet."))?;
        let token = b64u(&random_bytes(32)?);
        let mut inner = self.inner.lock();
        let book = &mut inner.book;
        book.invites.retain(|_, i| !(i.email == email && i.source == InviteSource::Console && i.kind == kind));
        while book.invites.len() >= INVITES_MAX {
            book.invites.shift_remove_index(0);
        }
        let expires = t + INVITE_MS;
        book.invites.insert(sha256_hex(token.as_bytes()), Invite { email: email.to_owned(), role, expires, by: by.to_owned(), source: InviteSource::Console, serial: None, kind, mailed });
        self.save_book(&mut inner)?;
        let fragment = if kind == InviteKind::ResetPassword { "reset" } else { "join" };
        Ok((format!("{origin}/console/#{fragment}={token}"), expires))
    }

    /// The open invite a token names, of `kinds`, unless what sent it was revoked (403).
    fn open_invite<'a>(&self, inner: &'a Inner, token: Option<&str>, kinds: &[InviteKind], t: i64) -> Result<(String, &'a Invite), ApiError> {
        let (hash, i) = inner.book.invite(token, kinds, t)?;
        if i.serial.as_ref().is_some_and(|s| inner.book.revoked_anchors.contains(s) || inner.revoked.contains(s)) {
            return Err(self.anchor_refusal());
        }
        Ok((hash, i))
    }

    fn signin_limit(&self, inner: &mut Inner, source: &str, t: i64) -> Result<(), ApiError> {
        inner.limits.hit(Limit::SigninBegin, source, t).map_err(|o| {
            if o.first {
                self.logger.security("console.rate-limited", &Fields::new().with("limit", Limit::SigninBegin.name()).with("source", source), Level::Warn);
            }
            ApiError::rate(o.retry_secs)
        })
    }

    /// What the profile asks of a role at join (4.2 `join`).
    fn join_methods(s: &Settings, role: PersonRole, break_glass: bool) -> Vec<&'static str> {
        if s.high() {
            if role.privileged() || break_glass {
                vec!["security-key"]
            } else {
                vec!["passkey"]
            }
        } else if break_glass {
            vec!["password-totp"]
        } else {
            vec!["passkey", "password-totp", "password-passkey"]
        }
    }

    /// POST join {token}: who the invite is for and what the profile asks of their role.
    pub(crate) fn join(&self, source: &str, body: &Value, t: i64) -> Result<Out, ApiError> {
        let mut inner = self.inner.lock();
        self.signin_limit(&mut inner, source, t)?;
        let (_, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::Join, InviteKind::ResetSignIn], t)?;
        let s = &inner.book.settings;
        let break_glass = i.source == InviteSource::Operator;
        let password = if break_glass { "required" } else { s.password_field() };
        Ok(Out::ok(json!({
            "ok": true, "email": i.email, "role": i.role.as_str(), "expires": i.expires, "reset": i.kind == InviteKind::ResetSignIn,
            "methods": Self::join_methods(s, i.role, break_glass), "password": password,
            "minLength": crate::console_password::min_len(s.high()),
        })))
    }

    /// POST register/begin {token, kind}.
    pub(crate) fn register_begin(&self, source: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let kind = str_of(body.get("kind")).map_or(Some(KeyKind::Passkey), KeyKind::parse).ok_or_else(|| ApiError::with("invalid", "kind is passkey or security-key."))?;
        let mut inner = self.inner.lock();
        self.signin_limit(&mut inner, source, t)?;
        let (hash, email, role) = {
            let (h, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::Join, InviteKind::ResetSignIn], t)?;
            (h, i.email.clone(), i.role)
        };
        let existing = inner.book.people.get(&email);
        let handle = match existing {
            Some(p) => p.handle.clone(),
            None => b64u(&random_bytes(16)?),
        };
        let exclude: Vec<String> = existing.map(|p| p.passkeys.iter().map(|k| k.id.clone()).collect()).unwrap_or_default();
        let role = existing.map_or(role, |p| p.role);
        let direct = kind == KeyKind::SecurityKey || (inner.book.settings.high() && role.privileged());
        let challenge = random_bytes(32)?;
        let mut c = Ceremony::new(Kind::Register, challenge.clone(), email.clone(), source, t);
        c.invite = hash;
        c.handle = handle.clone();
        c.key_kind = kind;
        let id = inner.ceremony(c, t)?;
        let public_key = creation_options(&challenge, &self.rp(origin), &handle, &email, &exclude, direct, kind);
        Ok(Out::ok(json!({ "ok": true, "ceremony": id, "publicKey": public_key })))
    }

    /// A WebAuthn method from a verified registration, its verdict judged against the snapshot in force.
    fn new_key(&self, made: &NewPasskey, credential: &Value, label: String, (anchor, invited_by): (&str, Option<String>), state: KeyState, kind: KeyKind, from: Option<String>, t: i64) -> Passkey {
        let list = self.inner.lock().book.settings.aaguid_list();
        let verdict = {
            let mds = self.mds.lock();
            crate::console_mds::verdict(made, mds.current.as_ref(), &list, t)
        };
        Passkey {
            id: b64u(&made.id),
            cose: b64u(&made.cose),
            count: made.sign_count,
            label,
            created: t,
            last_used: t,
            state,
            anchor: anchor.to_owned(),
            invited_by,
            revoked_at: None,
            rk: cred_props_rk(credential),
            from,
            kind,
            verdict,
        }
    }

    /// POST register/finish {ceremony, credential, label}: decided under the console's lock (N3). Only the registration
    /// that bootstraps the console, for the pinned email, makes an active admin from a hub or app invite (under High
    /// with an attested security key); after it every hub or app registration is a waiting joiner or a waiting
    /// passkey. Console invites, sign-in resets and the operator's break-glass link add working methods. The cookie
    /// is set only when the account is complete, active and working; the invite is spent then.
    pub(crate) fn register_finish(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let c = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            inner.take(str_of(body.get("ceremony")), Kind::Register, &[Stage::Begin], t).ok_or_else(|| ApiError::with("gone", "That registration request expired; try again."))?
        };
        let credential = body.get("credential").cloned().unwrap_or(Value::Null);
        let made = verify_registration(&self.rp(origin), origin, &c.challenge, &credential, true).map_err(|e| {
            self.logger.security("console.passkey-refused", &Fields::new().with("email", &c.email).with("ip", ip).with("why", &e.message), Level::Warn);
            ApiError { status: e.status, code: "invalid", message: e.message, retry_after: None }
        })?;
        let invite = {
            let mut inner = self.inner.lock();
            inner.book.sweep(t);
            inner.book.invites.get(&c.invite).filter(|i| i.expires > t).cloned().ok_or_else(|| ApiError::with("gone", GONE))?
        };
        let anchor = invite.anchor();
        let label = label_of(body.get("label"), c.key_kind);
        let from = matches!(invite.source, InviteSource::Hub | InviteSource::Device).then(|| invite.from_label());
        // The verdict is judged before the book's lock is taken (the MDS lock is never taken under it the other way).
        let working = self.new_key(&made, &credential, label.clone(), (&anchor, invite.invited_by()), KeyState::Working, c.key_kind, None, t);
        let list = self.inner.lock().book.settings.aaguid_list();
        let attested = self.attested_now(&working, &list);
        let mut inner = self.inner.lock();
        // Single use: checked again under the lock.
        let invite = inner.book.invites.get(&c.invite).filter(|i| i.expires > t).cloned().ok_or_else(|| ApiError::with("gone", GONE))?;
        if invite.serial.as_ref().is_some_and(|s| inner.book.revoked_anchors.contains(s) || inner.revoked.contains(s)) {
            return Err(self.anchor_refusal());
        }
        let id = working.id.clone();
        if inner.book.find(&id).is_some() {
            return Err(ApiError::with("exists", "That passkey is already registered."));
        }
        let email = invite.email.clone();
        let s = inner.book.settings.clone();
        let mut bootstrap = false;
        let (person_state, key_state) = match invite.source {
            InviteSource::Console | InviteSource::Operator => {
                if invite.kind == InviteKind::Join && invite.source == InviteSource::Console && !inner.book.people.contains_key(&email) {
                    if inner.book.admitted() >= PEOPLE_MAX {
                        return Err(ApiError::of("people-limit"));
                    }
                    let mut p = Person::new(c.handle.clone(), invite.role, PersonState::Active, CONSOLE_ANCHOR, t);
                    p.invited_by = Some(invite.by.clone());
                    inner.book.people.insert(email.clone(), p);
                }
                let p = inner.book.people.get_mut(&email).ok_or_else(|| ApiError::with("gone", GONE))?;
                if p.state == PersonState::Waiting {
                    return Err(ApiError::of("waiting"));
                }
                if p.passkeys.iter().filter(|k| k.works()).count() >= PASSKEYS_MAX || (!working.discoverable() && p.working_not_discoverable() >= NOT_DISCOVERABLE_MAX) {
                    return Err(ApiError::of("passkey-limit"));
                }
                p.passkeys.push(working.clone());
                (p.state_str(), "working")
            }
            InviteSource::Hub | InviteSource::Device if !inner.book.bootstrapped => {
                let pin = inner.book.first_admin.clone().or_else(|| self.cfg.first_admin.clone());
                if pin.as_deref() != Some(email.as_str()) {
                    return Err(ApiError::with("bootstrap-pinned", format!("This console waits for its first admin, {}.", pin.unwrap_or_default())));
                }
                let p = inner.book.people.entry(email.clone()).or_insert_with(|| {
                    let mut p = Person::new(c.handle.clone(), PersonRole::Admin, PersonState::Active, &anchor, t);
                    p.joined_from = Some(invite.from_label());
                    p
                });
                p.passkeys.push(working.clone());
                // Under High the first admin bootstraps the console only with an attested security key; until then
                // the console stays waiting for them (the same link registers the attested key).
                if !s.high() || attested {
                    inner.book.bootstrapped = true;
                    inner.book.first_admin = None;
                    bootstrap = true;
                    // Every other open hub or app invite goes in the same write.
                    let keep = c.invite.clone();
                    inner.book.invites.retain(|h, i| *h != keep && (i.source == InviteSource::Console || i.source == InviteSource::Operator || i.email == email));
                }
                ("active", "working")
            }
            InviteSource::Hub | InviteSource::Device => {
                let waiting = Passkey { state: KeyState::Waiting, from: from.clone(), ..working.clone() };
                match inner.book.people.get_mut(&email) {
                    Some(p) => {
                        // A waiting passkey; a fourth replaces the oldest waiting one.
                        while p.waiting_keys() >= WAITING_PASSKEYS_MAX {
                            let Some(i) = p.passkeys.iter().enumerate().filter(|(_, k)| k.state == KeyState::Waiting && k.revoked_at.is_none()).min_by_key(|(_, k)| k.created).map(|(i, _)| i) else { break };
                            p.passkeys.remove(i);
                        }
                        p.passkeys.push(waiting);
                        let st = if p.state == PersonState::Waiting { "waiting" } else { p.state_str() };
                        (st, "waiting")
                    }
                    None => {
                        if inner.book.joiners() >= JOINERS_MAX {
                            return Err(ApiError::of("joiner-limit"));
                        }
                        let mut p = Person::new(c.handle.clone(), PersonRole::Viewer, PersonState::Waiting, &anchor, t);
                        p.joined_from = Some(invite.from_label());
                        p.passkeys.push(waiting);
                        inner.book.people.insert(email.clone(), p);
                        ("waiting", "waiting")
                    }
                }
            }
        };
        let p = inner.book.people.get(&email).cloned().ok_or_else(|| ApiError::with("gone", GONE))?;
        let done = key_state == "working" && person_state == "active" && complete(&p, &s, &|k| if k.id == id { attested } else { self.attested_now(k, &list) });
        let spent = key_state == "waiting" || (done && (bootstrap || !matches!(invite.source, InviteSource::Hub | InviteSource::Device)));
        if spent {
            inner.book.invites.shift_remove(&c.invite);
        }
        self.save_book(&mut inner)?;
        let view = self.verdict_view_unlocked(&working, &s);
        let mut out = Out::ok(json!({ "ok": true, "state": person_state, "passkey": key_state, "attested": view }));
        if done {
            let methods = vec![working.kind.as_str().to_owned()];
            out.cookie = Some(inner.new_session(self.cookie_name(), &email, (&id, &working.anchor, true), methods, origin, (ip, agent), None, t)?);
            if let Some(p) = inner.book.people.get_mut(&email) {
                p.last_sign_in = t;
            }
        }
        drop(inner);
        self.logger.security("console.passkey-registered", &Fields::new().with("email", &email).with("label", &label).with("ip", ip).with("state", person_state).with("passkey", key_state), Level::Info);
        let actor = match invite.source {
            InviteSource::Console => invite.by.clone(),
            InviteSource::Operator => "operator".to_owned(),
            _ => invite.from_label(),
        };
        let mut r = Record::new(&actor, "passkeys.register", "ok");
        r.target = Some(email.clone());
        r.ip = Some(ip.to_owned());
        r.detail = json!({
            "state": person_state, "passkey": key_state, "anchor": working.anchor, "credential_hint": hint_of(&id), "bootstrap": bootstrap,
            "kind": working.kind.as_str(), "aaguid": working.verdict.as_ref().map(|v| v.aaguid.clone()), "reset": invite.kind == InviteKind::ResetSignIn,
        });
        self.record(r, t);
        if bootstrap {
            self.record_bootstrap(&email, ip, t);
        }
        // Meeting Hub: a principal's own registration from their device completes `meet.console-invite` (3.8).
        if invite.source == InviteSource::Device {
            let principal = email.clone();
            self.observe_requests("meet.console-invite", &email, t, &|target: &Value| target.get("principal").and_then(Value::as_str) == Some(principal.as_str()));
        }
        Ok(out)
    }

    /// The `attested` view of a method with the list given (no lock taken).
    fn verdict_view_unlocked(&self, k: &Passkey, s: &Settings) -> Value {
        k.verdict.as_ref().map(|v| v.view(&s.aaguid_list())).unwrap_or(Value::Null)
    }

    /// The person an invite's join flow adds methods to, created for a new console invite.
    fn join_person<'a>(&self, inner: &'a mut Inner, invite: &Invite, handle: Option<String>, t: i64) -> Result<&'a mut Person, ApiError> {
        if invite.source == InviteSource::Console && invite.kind == InviteKind::Join && !inner.book.people.contains_key(&invite.email) {
            if inner.book.admitted() >= PEOPLE_MAX {
                return Err(ApiError::of("people-limit"));
            }
            let handle = match handle {
                Some(h) => h,
                None => b64u(&random_bytes(16)?),
            };
            let mut p = Person::new(handle, invite.role, PersonState::Active, CONSOLE_ANCHOR, t);
            p.invited_by = Some(invite.by.clone());
            inner.book.people.insert(invite.email.clone(), p);
        }
        match invite.source {
            InviteSource::Console | InviteSource::Operator => inner.book.people.get_mut(&invite.email).filter(|p| p.state != PersonState::Waiting).ok_or_else(|| ApiError::with("gone", GONE)),
            // Hub and app invites register a WebAuthn method only.
            _ => Err(ApiError::of("profile-high")),
        }
    }

    /// After a join step: spend the invite and start the session when the account is complete.
    fn join_done(&self, inner: &mut Inner, hash: &str, email: &str, method: (&str, &str, bool), origin: &str, (ip, agent): (&str, &str), t: i64) -> Result<Option<String>, ApiError> {
        let s = inner.book.settings.clone();
        let Some(p) = inner.book.people.get(email).cloned() else { return Ok(None) };
        let list = s.aaguid_list();
        // Under the book's lock: attestation judged from the stored verdicts with the snapshot read once.
        let snapshot = self.mds.lock().current.clone();
        let done = p.active() && complete(&p, &s, &|k| k.verdict.as_ref().is_some_and(|v| crate::console_mds::attested(v, snapshot.as_ref(), &list)));
        if !done {
            self.save_book(inner)?;
            return Ok(None);
        }
        inner.book.invites.shift_remove(hash);
        if let Some(p) = inner.book.people.get_mut(email) {
            p.last_sign_in = t;
        }
        self.save_book(inner)?;
        let methods = vec![if method.0 == "totp" { "password".to_owned() } else { "webauthn".to_owned() }, if method.0 == "totp" { "totp".to_owned() } else { "password".to_owned() }];
        Ok(Some(inner.new_session(self.cookie_name(), email, method, methods, origin, (ip, agent), None, t)?))
    }

    /// POST join/password {token, password}: the join flow's password (3.3 rules), anchored as the invite's methods.
    pub(crate) fn join_password(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let password = str_of(body.get("password")).unwrap_or("").to_owned();
        let (hash, invite, high) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            let (h, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::Join, InviteKind::ResetSignIn], t)?;
            (h, i.clone(), inner.book.settings.high())
        };
        let break_glass = invite.source == InviteSource::Operator;
        if high && !break_glass && self.settings_now().password_field() == "none" {
            return Err(ApiError::of("profile-high"));
        }
        self.check_password(&password, high, &invite.email)?;
        let hashed = crate::console_password::hash_new(&password).ok_or_else(|| ApiError::with("write-failed", "The console could not draw random bytes; see the relay's log."))?;
        let mut inner = self.inner.lock();
        let p = self.join_person(&mut inner, &invite, None, t)?;
        let anchor = if invite.source == InviteSource::Operator { OPERATOR_ANCHOR.to_owned() } else { p.anchor.clone() };
        p.password = Some(PasswordMethod { hash: hashed, anchor, invited_by: invite.invited_by(), created: t, revoked_at: None });
        let p = p.clone();
        let method = p.passkeys.iter().rev().find(|k| k.works()).map(|k| (k.id.clone(), k.anchor.clone(), true)).or_else(|| p.totp.as_ref().filter(|m| m.works()).map(|m| ("totp".to_owned(), m.anchor.clone(), false)));
        let cookie = match method {
            Some((m, a, w)) => self.join_done(&mut inner, &hash, &invite.email, (&m, &a, w), origin, (ip, agent), t)?,
            None => {
                self.save_book(&mut inner)?;
                None
            }
        };
        drop(inner);
        let mut r = Record::new(&invite.email, "account.password", "ok");
        r.target = Some(invite.email.clone());
        r.ip = Some(ip.to_owned());
        r.detail = json!({ "join": true });
        self.record(r, t);
        let mut out = Out::ok(json!({ "ok": true }));
        out.cookie = cookie;
        Ok(out)
    }

    /// The 3.3 password rules: `password-length` (with the profile's minimum) or `password-weak`.
    fn check_password(&self, password: &str, high: bool, email: &str) -> Result<(), ApiError> {
        crate::console_password::check_new(password, high, &self.cfg.host, email).map_err(|code| match code {
            "password-length" => ApiError::with("password-length", format!("A password here needs {} to 128 characters.", crate::console_password::min_len(high))),
            _ => ApiError::of("password-weak"),
        })
    }

    /// POST join/totp/begin {token}: Standard only; a fresh secret shown once.
    pub(crate) fn join_totp_begin(&self, source: &str, body: &Value, t: i64) -> Result<Out, ApiError> {
        let mut inner = self.inner.lock();
        self.signin_limit(&mut inner, source, t)?;
        if inner.book.settings.high() {
            return Err(ApiError::of("profile-high"));
        }
        let (hash, email) = {
            let (h, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::Join, InviteKind::ResetSignIn], t)?;
            if matches!(i.source, InviteSource::Hub | InviteSource::Device) {
                return Err(ApiError::of("profile-high"));
            }
            (h, i.email.clone())
        };
        let secret = random_bytes(crate::console_password::TOTP_SECRET_LEN)?;
        let id = b64u(&random_bytes(16)?);
        inner.join_totp.retain(|_, (h, e)| e.expires > t && *h != hash);
        let uri = crate::console_password::otpauth_uri(&secret, &self.cfg.host, &email);
        let shown = crate::console_password::base32(&secret);
        inner.join_totp.insert(id.clone(), (hash, TotpEnrollment { id: id.clone(), secret, anchor: String::new(), invited_by: None, expires: t + TOTP_ENROLL_MS }));
        Ok(Out::ok(json!({ "ok": true, "enrollment": id, "secret": shown, "uri": uri })))
    }

    /// POST join/totp/finish {token, enrollment, code}: a current code confirms the app; the secret is sealed.
    pub(crate) fn join_totp_finish(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let (hash, invite, e) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            if inner.book.settings.high() {
                return Err(ApiError::of("profile-high"));
            }
            let (h, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::Join, InviteKind::ResetSignIn], t)?;
            let (h, i) = (h, i.clone());
            let id = str_of(body.get("enrollment")).unwrap_or("");
            let e = inner.join_totp.remove(id).filter(|(eh, e)| *eh == h && e.expires > t).map(|(_, e)| e).ok_or_else(|| ApiError::with("gone", "That setup expired; start again."))?;
            (h, i, e)
        };
        let code = str_of(body.get("code")).unwrap_or("");
        let Some(step) = crate::console_password::totp_match(&e.secret, code, t, None) else {
            // The enrollment stays usable for another try.
            self.inner.lock().join_totp.insert(e.id.clone(), (hash, e));
            return Err(ApiError::of("totp-wrong"));
        };
        let mut inner = self.inner.lock();
        let p = self.join_person(&mut inner, &invite, None, t)?;
        let anchor = if invite.source == InviteSource::Operator { OPERATOR_ANCHOR.to_owned() } else { p.anchor.clone() };
        let name = p.totp_secret_name();
        p.totp = Some(TotpMethod { anchor: anchor.clone(), invited_by: invite.invited_by(), created: t, last_step: Some(step), revoked_at: None, unusable: false });
        self.seal_put(&name, &e.secret)?;
        let cookie = self.join_done(&mut inner, &hash, &invite.email, ("totp", &anchor, false), origin, (ip, agent), t)?;
        let state = inner.book.people.get(&invite.email).map_or("active", Person::state_str);
        drop(inner);
        let mut r = Record::new(&invite.email, "account.totp", "ok");
        r.target = Some(invite.email.clone());
        r.ip = Some(ip.to_owned());
        r.detail = json!({ "join": true });
        self.record(r, t);
        let mut out = Out::ok(json!({ "ok": true, "state": state, "passkey": null, "attested": null }));
        out.cookie = cookie;
        Ok(out)
    }

    /// Seal a value under its name (3.11); 503 when the secrets file did not read.
    pub(crate) fn seal_put(&self, name: &str, value: &[u8]) -> Result<(), ApiError> {
        let mut seal = self.seal.lock();
        let seal = seal.as_mut().ok_or_else(|| ApiError::of("state-unreadable"))?;
        seal.put(name, value).map_err(|e| {
            self.logger.ops("console.write-failed", &Fields::new().with("file", crate::console_seal::SECRETS_FILE).with("reason", e), Level::Error);
            ApiError::of("write-failed")
        })
    }

    pub(crate) fn seal_get(&self, name: &str) -> Option<Vec<u8>> {
        self.seal.lock().as_ref().and_then(|s| s.get(name))
    }

    fn seal_remove(&self, name: &str) {
        if let Some(s) = self.seal.lock().as_mut() {
            let _ = s.remove(name);
        }
    }

    // ── Sign-in (3.3) ───────────────────────────────────────────────────────────────────────────────────────

    /// The one refusal sentence, the real reason logged; a failed attempt counts toward `lock` (the email as typed, or
    /// the account a discoverable passkey found). The account whose wait began now, if any, is audited.
    fn signin_refused(&self, inner: &mut Inner, ip: &str, why: &str, email: Option<&str>, lock: &str, t: i64) -> ApiError {
        self.logger.security("console.signin-refused", &Fields::new().with("email", email).with("ip", ip).with("why", why), Level::Warn);
        if let Some(acct) = inner.lock_fail(lock, t) {
            self.logger.security("console.signin-locked", &Fields::new().with("email", &acct), Level::Warn);
            let mut r = Record::new("relay", "signin.locked", "ok");
            r.target = Some(acct);
            r.detail = json!({ "minutes": 15 });
            self.record(r, t);
        }
        ApiError::with("signin-refused", SIGNIN_REFUSED)
    }

    /// A refusal with no attempt counted (malformed or expired requests).
    fn signin_refused_quiet(&self, ip: &str, why: &str) -> ApiError {
        self.logger.security("console.signin-refused", &Fields::new().with("ip", ip).with("why", why), Level::Warn);
        ApiError::with("signin-refused", SIGNIN_REFUSED)
    }

    /// The wait of an email's lockout (429 `signin-wait`), when one is running.
    fn locked_out(&self, inner: &Inner, email: &str, t: i64) -> Option<ApiError> {
        if email.is_empty() {
            return None;
        }
        inner.lockout.wait(&Lockout::key(email), t).map(wait_refusal)
    }

    /// POST login/begin {email, banner}: one answer shape for every email (3.3, R3-L1). With an email, exactly 4
    /// `allowCredentials` entries: the 4 decoy HMACs are always computed and the account looked up once, then the
    /// account's ids that are not discoverable fill the first slots.
    pub(crate) fn login_begin(&self, source: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let typed = str_of(body.get("email")).map(js_trim).filter(|e| !e.is_empty()).map(Lockout::key).unwrap_or_default();
        let banner = body.get("banner").and_then(Value::as_bool).unwrap_or(false);
        let decoy_key = if typed.is_empty() { Vec::new() } else { self.seal_get(DECOY_SECRET).unwrap_or_default() };
        let mut inner = self.inner.lock();
        self.signin_limit(&mut inner, source, t)?;
        if inner.book.settings.banner.is_some() && !banner {
            return Err(ApiError::of("banner-needed"));
        }
        if let Some(e) = self.locked_out(&inner, &typed, t) {
            self.logger.security("console.signin-refused", &Fields::new().with("why", "the email waits after too many failed tries"), Level::Warn);
            return Err(e);
        }
        let mut allow: Vec<String> = Vec::new();
        if !typed.is_empty() {
            let lengths = inner.book.not_discoverable_lengths();
            let decoys = crate::console_password::decoy_ids(&decoy_key, &typed, &lengths);
            #[cfg(test)]
            ACCOUNT_LOOKUPS.with(|n| n.set(n.get() + 1));
            let real: Vec<String> = inner.book.people.get(&typed).map(|p| p.passkeys.iter().filter(|k| k.works() && !k.discoverable()).take(LOGIN_IDS).map(|k| k.id.clone()).collect()).unwrap_or_default();
            allow = real;
            for d in decoys.iter().skip(allow.len()) {
                allow.push(b64u(d));
            }
            allow.truncate(LOGIN_IDS);
        }
        let challenge = random_bytes(32)?;
        let mut c = Ceremony::new(Kind::Login, challenge.clone(), typed, source, t);
        c.banner = banner;
        let id = inner.ceremony(c, t)?;
        let public_key = assertion_options(&challenge, &self.rp(origin), &allow, CEREMONY_MS);
        Ok(Out::ok(json!({ "ok": true, "ceremony": id, "publicKey": public_key, "password": inner.book.settings.password_field() })))
    }

    /// POST login/password {ceremony, password}: Standard, the first factor (then `next`: the account's second factor);
    /// High with `requirePassword` (and the break-glass account), the second factor after `login/finish`, or the
    /// restricted setup session for an account with no password (R3-M1). Exactly one PBKDF2 per call: the account's
    /// hash or the fixed dummy one, so every answer takes the same time.
    pub(crate) fn login_password(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let password = str_of(body.get("password")).unwrap_or("");
        let id = str_of(body.get("ceremony")).unwrap_or("").to_owned();
        let mut inner = self.inner.lock();
        self.signin_limit(&mut inner, source, t)?;
        let Some(mut c) = inner.take(Some(&id), Kind::Login, &[Stage::Begin, Stage::WebauthnOk], t) else {
            crate::console_password::verify(password, None);
            return Err(self.signin_refused_quiet(ip, "no such sign-in request at this step"));
        };
        let high = inner.book.settings.high();
        if c.stage == Stage::Begin {
            let person = inner.book.people.get(&c.email).cloned();
            let stored = person.as_ref().and_then(|p| p.password.as_ref().filter(|m| m.revoked_at.is_none()).map(|m| m.hash.clone()));
            let right = crate::console_password::verify(password, stored.as_deref());
            if high || c.email.is_empty() {
                let lock = c.email.clone();
                return Err(self.signin_refused(&mut inner, ip, "a password first is not how this profile signs in", None, &lock, t));
            }
            if let Some(e) = self.locked_out(&inner, &c.email, t) {
                return Err(e);
            }
            let lock = c.email.clone();
            let Some(p) = person.filter(|_| right) else {
                return Err(self.signin_refused(&mut inner, ip, "wrong password or no such account", Some(&lock), &lock, t));
            };
            let keys: Vec<String> = if p.break_glass { Vec::new() } else { p.passkeys.iter().filter(|k| k.works()).map(|k| k.id.clone()).collect() };
            let next = if !keys.is_empty() {
                "webauthn"
            } else if p.has_totp() {
                "totp"
            } else {
                return Err(self.signin_refused(&mut inner, ip, "the account has no second factor (no sign-in with a password alone)", Some(&lock), &lock, t));
            };
            let public_key = if next == "webauthn" { assertion_options(&c.challenge, &self.rp(origin), &keys, CEREMONY_MS) } else { Value::Null };
            c.stage = Stage::PasswordOk;
            c.account = c.email.clone();
            inner.advance(&id, c);
            return Ok(Out::ok(json!({ "ok": true, "next": next, "publicKey": public_key })));
        }
        // WebauthnOk: the password after the assertion.
        let account = c.account.clone();
        let stored = inner.book.people.get(&account).and_then(|p| p.password.as_ref().filter(|m| m.revoked_at.is_none()).map(|m| m.hash.clone()));
        let right = crate::console_password::verify(password, stored.as_deref());
        if stored.is_none() {
            c.stage = Stage::SetPassword;
            inner.advance(&id, c);
            return Ok(Out::ok(json!({ "ok": true, "next": "set-password" })));
        }
        if !right {
            return Err(self.signin_refused(&mut inner, ip, "wrong password after the passkey", Some(&account), &account, t));
        }
        let method = c.method.clone();
        drop(inner);
        self.finish_signin(&account, &method, vec!["webauthn".into(), "password".into()], c.banner, origin, (ip, agent), t)
    }

    /// POST login/set-password {ceremony, password}: the restricted setup session's only call (R3-M1); the normal
    /// session starts when the password is set.
    pub(crate) fn login_set_password(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let password = str_of(body.get("password")).unwrap_or("");
        let id = str_of(body.get("ceremony")).unwrap_or("").to_owned();
        let (c, high) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            let c = inner.take(Some(&id), Kind::Login, &[Stage::SetPassword], t).ok_or_else(|| self.signin_refused_quiet(ip, "no setup session"))?;
            (c, inner.book.settings.high())
        };
        if let Err(e) = self.check_password(password, high, &c.account) {
            // The setup session stays for another try.
            self.inner.lock().advance(&id, c);
            return Err(e);
        }
        let hashed = crate::console_password::hash_new(password).ok_or_else(|| ApiError::with("write-failed", "The console could not draw random bytes; see the relay's log."))?;
        {
            let mut inner = self.inner.lock();
            let p = inner.book.people.get_mut(&c.account).ok_or_else(|| self.signin_refused_quiet(ip, "the account is gone"))?;
            let anchor = p.passkeys.iter().find(|k| k.id == c.method).map(|k| k.anchor.clone()).unwrap_or_else(|| p.anchor.clone());
            p.password = Some(PasswordMethod { hash: hashed, anchor, invited_by: None, created: t, revoked_at: None });
            self.save_book(&mut inner)?;
        }
        let mut r = Record::new(&c.account, "account.password", "ok");
        r.target = Some(c.account.clone());
        r.ip = Some(ip.to_owned());
        r.detail = json!({ "setup": true });
        self.record(r, t);
        self.finish_signin(&c.account, &c.method, vec!["webauthn".into(), "password".into()], c.banner, origin, (ip, agent), t)
    }

    /// POST login/totp {ceremony, code}: Standard, the second factor after the password.
    pub(crate) fn login_totp(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let code = str_of(body.get("code")).unwrap_or("");
        let id = str_of(body.get("ceremony")).unwrap_or("").to_owned();
        let (c, secret_name, last, anchor) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            let c = inner.take(Some(&id), Kind::Login, &[Stage::PasswordOk], t).ok_or_else(|| self.signin_refused_quiet(ip, "no sign-in request at this step"))?;
            if let Some(e) = self.locked_out(&inner, &c.account, t) {
                return Err(e);
            }
            let p = inner.book.people.get(&c.account).cloned();
            let usable = p.as_ref().and_then(|p| p.totp.as_ref().filter(|m| m.works()).map(|m| (p.totp_secret_name(), m.last_step, m.anchor.clone())));
            match usable.filter(|_| !inner.book.settings.high()) {
                Some((n, l, a)) => (c, n, l, a),
                None => {
                    let lock = c.account.clone();
                    return Err(self.signin_refused(&mut inner, ip, "no authenticator app this profile allows", Some(&lock), &lock, t));
                }
            }
        };
        let secret = self.seal_get(&secret_name).unwrap_or_default();
        let step = crate::console_password::totp_match(&secret, code, t, last).filter(|_| !secret.is_empty());
        let mut inner = self.inner.lock();
        let Some(step) = step else {
            let lock = c.account.clone();
            return Err(self.signin_refused(&mut inner, ip, "wrong or reused code", Some(&lock), &lock, t));
        };
        if let Some(m) = inner.book.people.get_mut(&c.account).and_then(|p| p.totp.as_mut()) {
            m.last_step = Some(step);
        }
        self.save_book(&mut inner)?;
        drop(inner);
        let _ = anchor;
        self.finish_signin(&c.account, "totp", vec!["password".into(), "totp".into()], c.banner, origin, (ip, agent), t)
    }

    /// POST login/finish {ceremony, credential}. The assertion is verified first; every failure before that answers
    /// the one sentence; only after it may the answer be the anchor words, `waiting` or `suspended` (C2). Under High
    /// with `requirePassword`, and for the break-glass account, it answers `{next: "password"}` with no cookie.
    pub(crate) fn login_finish(&self, source: &str, ip: &str, agent: &str, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let id = str_of(body.get("ceremony")).unwrap_or("").to_owned();
        let credential = body.get("credential").cloned().unwrap_or(Value::Null);
        let (mut c, email, key) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            let Some(c) = inner.take(Some(&id), Kind::Login, &[Stage::Begin, Stage::PasswordOk], t) else { return Err(self.signin_refused_quiet(ip, "no such sign-in request")) };
            let Ok(raw) = credential_id(&credential) else { return Err(self.signin_refused_quiet(ip, "no passkey id")) };
            let cid = b64u(&raw);
            let hint = hint_of(&cid);
            if let Some(wait) = inner.failures.waiting(&hint, source, t) {
                self.logger.security("console.signin-refused", &Fields::new().with("ip", ip).with("why", "too many failed tries with this passkey from here"), Level::Warn);
                return Err(wait_refusal(wait));
            }
            let typed = if c.stage == Stage::PasswordOk { c.account.clone() } else { c.email.clone() };
            // A WebAuthn ceremony begun before a lockout's wait still completes; one begun after it does not.
            if !typed.is_empty() && inner.lockout.wait(&Lockout::key(&typed), t).is_some() && inner.lockout.locked_at(&Lockout::key(&typed), t).is_some_and(|at| c.began >= at) {
                return Err(self.locked_out(&inner, &typed, t).unwrap_or_else(|| wait_refusal(900)));
            }
            let Some((email, person, key)) = inner.book.find(&cid).map(|(e, p, k)| (e.clone(), p.clone(), k.clone())) else {
                inner.failures.fail(&hint, source, t);
                return Err(self.signin_refused(&mut inner, ip, "this passkey is not registered here", None, &typed, t));
            };
            if !typed.is_empty() && typed != email {
                inner.failures.fail(&hint, source, t);
                return Err(self.signin_refused(&mut inner, ip, "the passkey belongs to another account than the email typed", Some(&typed), &typed, t));
            }
            if typed.is_empty() && !key.discoverable() {
                inner.failures.fail(&hint, source, t);
                return Err(self.signin_refused(&mut inner, ip, "a passkey that is not discoverable signs in only with its email", Some(&email), &email, t));
            }
            if inner.lockout.wait(&Lockout::key(&email), t).is_some() && inner.lockout.locked_at(&Lockout::key(&email), t).is_some_and(|at| c.began >= at) {
                return Err(self.locked_out(&inner, &email, t).unwrap_or_else(|| wait_refusal(900)));
            }
            let given = credential.get("response").and_then(|r| r.get("userHandle")).and_then(Value::as_str).unwrap_or("");
            if !given.is_empty() && given != person.handle {
                inner.failures.fail(&hint, source, t);
                return Err(self.signin_refused(&mut inner, ip, "the user handle is not this passkey's", Some(&email), &email, t));
            }
            let cose = unb64u(&key.cose).unwrap_or_default();
            let count = match verify_assertion(&self.rp(origin), origin, &c.challenge, &cose, &credential, true) {
                Ok(n) => n,
                Err(e) => {
                    inner.failures.fail(&hint, source, t);
                    return Err(self.signin_refused(&mut inner, ip, &e.message, Some(&email), &email, t));
                }
            };
            if (count != 0 || key.count != 0) && count <= key.count {
                inner.failures.fail(&hint, source, t);
                return Err(self.signin_refused(&mut inner, ip, &format!("the counter went backwards ({count} after {})", key.count), Some(&email), &email, t));
            }
            // A valid assertion from here on: the sign count is stored so it cannot be replayed.
            inner.failures.clear(&hint, source);
            if let Some(k) = inner.book.people.get_mut(&email).and_then(|p| p.passkeys.iter_mut().find(|k| k.id == cid)) {
                k.count = count;
                k.last_used = t;
            }
            // Latch at every sign-in.
            if inner.revoked.contains(&key.anchor) && key.revoked_at.is_none() {
                let a = key.anchor.clone();
                inner.book.latch([&a], t);
                inner.end_dead_sessions();
            }
            self.save_book(&mut inner)?;
            if c.stage == Stage::PasswordOk && email != c.account {
                return Err(self.signin_refused(&mut inner, ip, "the passkey is not the account's whose password was given", Some(&email), &email, t));
            }
            (c, email, key)
        };
        let (s, break_glass) = {
            let inner = self.inner.lock();
            (inner.book.settings.clone(), inner.book.people.get(&email).is_some_and(|p| p.break_glass))
        };
        if c.stage == Stage::Begin && (s.require_password || break_glass) {
            if !s.high() {
                // Standard: the password comes first; the break-glass account signs in with its password and app.
                let mut inner = self.inner.lock();
                return Err(self.signin_refused(&mut inner, ip, "this profile takes the password first", Some(&email), &email, t));
            }
            c.stage = Stage::WebauthnOk;
            c.account = email;
            c.method = key.id.clone();
            self.inner.lock().advance(&id, c);
            return Ok(Out::ok(json!({ "ok": true, "next": "password" })));
        }
        let methods = if c.stage == Stage::PasswordOk { vec!["password".to_owned(), "webauthn".to_owned()] } else { vec!["webauthn".to_owned()] };
        self.finish_signin(&email, &key.id, methods, c.banner, origin, (ip, agent), t)
    }

    /// Every factor verified: the anchor words, `waiting` or `suspended` only now (C2), then the session, `signin.ok`,
    /// and for the break-glass account the mail to every active admin.
    #[allow(clippy::too_many_arguments)]
    fn finish_signin(&self, email: &str, method: &str, methods: Vec<String>, banner: bool, origin: &str, (ip, agent): (&str, &str), t: i64) -> Result<Out, ApiError> {
        let (p, s) = {
            let inner = self.inner.lock();
            (inner.book.people.get(email).cloned().ok_or_else(|| self.signin_refused_quiet(ip, "the account is gone"))?, inner.book.settings.clone())
        };
        let (anchor, webauthn, latched, waiting_key) = if method == "totp" {
            let m = p.totp.as_ref();
            (m.map(|m| m.anchor.clone()).unwrap_or_default(), false, m.is_none_or(|m| m.revoked_at.is_some()) || p.password.as_ref().is_some_and(|m| m.revoked_at.is_some()), false)
        } else {
            let k = p.passkeys.iter().find(|k| k.id == method);
            (k.map(|k| k.anchor.clone()).unwrap_or_default(), true, k.is_none_or(|k| k.revoked_at.is_some()) || (methods.iter().any(|m| m == "password") && p.password.as_ref().is_some_and(|m| m.revoked_at.is_some())), k.is_some_and(|k| k.state == KeyState::Waiting))
        };
        if latched {
            self.logger.security("console.signin-refused", &Fields::new().with("email", email).with("ip", ip).with("why", "the method's anchor is revoked"), Level::Warn);
            return Err(self.anchor_refusal());
        }
        if p.state == PersonState::Waiting {
            self.logger.security("console.signin-refused", &Fields::new().with("email", email).with("ip", ip).with("why", "waiting for approval"), Level::Warn);
            return Err(ApiError::of("waiting"));
        }
        if p.state == PersonState::Suspended {
            self.logger.security("console.signin-refused", &Fields::new().with("email", email).with("ip", ip).with("why", "suspended"), Level::Warn);
            return Err(ApiError::of("suspended"));
        }
        if waiting_key {
            return Err(self.signin_refused_quiet(ip, "a waiting passkey signs nobody in"));
        }
        // A Meeting Hub admin who left relay.json `admins` is suspended now (2.3).
        if p.role == PersonRole::Admin && self.admin_rule(email, &anchor) == AdminRule::NotRelayAdmin {
            self.suspend_not_relay_admin(email, t);
            return Err(ApiError::of("suspended"));
        }
        let banner_at = (s.banner.is_some() && banner).then_some(t);
        let cookie = {
            let mut inner = self.inner.lock();
            if let Some(p) = inner.book.people.get_mut(email) {
                p.last_sign_in = t;
                p.unproven = false;
            }
            if p.break_glass {
                inner.book.break_glass_used_at = Some(t);
            }
            self.save_book(&mut inner)?;
            inner.new_session(self.cookie_name(), email, (method, &anchor, webauthn), methods.clone(), origin, (ip, agent), banner_at, t)?
        };
        let rights = self.session_rights(email, &p, method, &anchor, webauthn, &s, t)?.0;
        self.logger.security("console.signin", &Fields::new().with("email", email).with("ip", ip), Level::Info);
        let mut r = Record::new(email, "signin.ok", "ok");
        r.role = Some(p.role.as_str().to_owned());
        r.ip = Some(ip.to_owned());
        r.target = Some(email.to_owned());
        r.detail = json!({ "methods": methods, "rights": rights.as_str(), "profile": s.profile.as_str(), "banner": banner_at.is_some(), "breakGlass": p.break_glass });
        self.record(r, t);
        if p.break_glass {
            for to in self.active_admin_emails() {
                let args = [("email", email.to_owned()), ("time", crate::codec::iso_time(t)), ("address", ip.to_owned())];
                self.mailer.enqueue("mail.break-glass", &to, &args);
            }
        }
        let mut out = Out::ok(json!({ "ok": true }));
        out.cookie = Some(cookie);
        Ok(out)
    }

    /// The rights a session holds now (2.3): profile, attestation verdict and anchor, recomputed at every request. Err
    /// `suspended` for a Meeting Hub admin who left `admins`.
    #[allow(clippy::too_many_arguments)]
    fn session_rights(&self, email: &str, p: &Person, method: &str, anchor: &str, webauthn: bool, s: &Settings, t: i64) -> Result<(Rights, Option<&'static str>), ApiError> {
        let list = s.aaguid_list();
        let attested = webauthn && p.passkeys.iter().find(|k| k.id == method).is_some_and(|k| self.attested_now(k, &list));
        let mut device_ok = true;
        if p.role == PersonRole::Admin {
            match self.admin_rule(email, if p.break_glass { OPERATOR_ANCHOR } else { anchor }) {
                AdminRule::Admin => {}
                AdminRule::ViewerOnly => device_ok = false,
                AdminRule::NotRelayAdmin => {
                    self.suspend_not_relay_admin(email, t);
                    return Err(ApiError::of("suspended"));
                }
            }
        }
        Ok(rights_of(p.role, s.high(), attested, device_ok, p.break_glass))
    }

    /// The signed-in caller of a session (its hex SHA-256), the session checked and (with `activity`) touched;
    /// Ok(None) when there is none. Ends a session presented at another origin (`origin-session`).
    pub(crate) fn who_of(&self, hash: &str, origin: &str, activity: bool, t: i64) -> Result<Option<Who>, ApiError> {
        let (email, method, anchor, webauthn, p, s) = {
            let mut inner = self.inner.lock();
            let (idle, max) = (inner.book.settings.idle_ms(), inner.book.settings.max_ms());
            let Some(sess) = inner.sessions.get(hash) else { return Ok(None) };
            if sess.origin != origin {
                inner.sessions.remove(hash);
                return Err(ApiError::of("origin-session"));
            }
            if t - sess.last > idle || t - sess.created > max {
                inner.sessions.remove(hash);
                return Ok(None);
            }
            let (email, method, anchor, webauthn) = (sess.email.clone(), sess.method.clone(), sess.anchor.clone(), sess.webauthn);
            let alive = inner.book.people.get(&email).filter(|p| p.active()).filter(|p| if method == "totp" { p.has_totp() && p.has_password() } else { p.passkeys.iter().any(|k| k.id == method && k.works()) }).cloned();
            let Some(p) = alive else {
                inner.sessions.remove(hash);
                return Ok(None);
            };
            if activity {
                if let Some(sess) = inner.sessions.get_mut(hash) {
                    sess.last = t;
                }
            }
            (email, method, anchor, webauthn, p, inner.book.settings.clone())
        };
        let (rights, why) = self.session_rights(&email, &p, &method, &anchor, webauthn, &s, t)?;
        Ok(Some(Who { sid: hash.to_owned(), email, role: p.role, rights, why, admin: rights == Rights::Admin, manager: rights >= Rights::Manager }))
    }

    /// A Meeting Hub admin whose principal left `admins`: suspended with reason `not-relay-admin`, sessions ended.
    pub(crate) fn suspend_not_relay_admin(&self, email: &str, t: i64) {
        {
            let mut inner = self.inner.lock();
            let Some(p) = inner.book.people.get_mut(email) else { return };
            if p.state == PersonState::Suspended {
                return;
            }
            p.state = PersonState::Suspended;
            p.suspended_by = Some("relay".into());
            p.suspend_reason = Some("not-relay-admin".into());
            p.suspended_at = Some(t);
            inner.end_sessions(email, None);
            crate::console_approvals::cancel_for(&mut inner.book, email, t);
            let _ = self.save_book(&mut inner);
        }
        let mut r = Record::new("relay", "admins.suspend", "ok");
        r.target = Some(email.to_owned());
        r.detail = json!({ "reason": "not-relay-admin" });
        self.record(r, t);
    }

    /// POST recover/begin {email}: always `{ok}`; the reset mail (`reset-password`, 24 h, once) goes only to an active
    /// viewer under Standard with mail on, at most once an hour per email (3.3, R3-L2).
    pub(crate) fn recover_begin(&self, source: &str, body: &Value, t: i64) -> Result<Out, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let send = {
            let mut inner = self.inner.lock();
            inner.limits.hit(Limit::RecoverBegin, source, t).map_err(|o| ApiError::rate(o.retry_secs))?;
            let viewer = inner.book.people.get(&email).is_some_and(|p| p.role == PersonRole::Viewer && p.active() && !p.break_glass);
            let ok = viewer && !inner.book.settings.high() && self.mailer.config().mode != crate::console_mail::Mode::Off;
            ok && inner.limits.hit(Limit::RecoverMail, &email, t).is_ok()
        };
        if send {
            let (link, expires) = self.mint_console_token(&email, PersonRole::Viewer, &email, InviteKind::ResetPassword, true, t)?;
            let args = [("email", email.clone()), ("time", crate::codec::iso_time(expires)), ("link", link)];
            self.mailer.enqueue("mail.reset-password", &email, &args);
        }
        Ok(Out::ok(json!({ "ok": true })))
    }

    /// POST recover/finish {token, password}: a `reset-password` token sets a new password only; the second factor
    /// stays. A `reset-sign-in` or join token is refused here.
    pub(crate) fn recover_finish(&self, source: &str, ip: &str, body: &Value, t: i64) -> Result<Out, ApiError> {
        let password = str_of(body.get("password")).unwrap_or("");
        let (hash, email, high) = {
            let mut inner = self.inner.lock();
            self.signin_limit(&mut inner, source, t)?;
            let (h, i) = self.open_invite(&inner, str_of(body.get("token")), &[InviteKind::ResetPassword], t)?;
            (h, i.email.clone(), inner.book.settings.high())
        };
        if high {
            return Err(ApiError::of("profile-high"));
        }
        self.check_password(password, high, &email)?;
        let hashed = crate::console_password::hash_new(password).ok_or_else(|| ApiError::with("write-failed", "The console could not draw random bytes; see the relay's log."))?;
        {
            let mut inner = self.inner.lock();
            let p = inner.book.people.get_mut(&email).filter(|p| p.active()).ok_or_else(|| ApiError::with("gone", GONE))?;
            let anchor = p.password.as_ref().map(|m| m.anchor.clone()).unwrap_or_else(|| p.anchor.clone());
            p.password = Some(PasswordMethod { hash: hashed, anchor, invited_by: None, created: t, revoked_at: None });
            inner.book.invites.shift_remove(&hash);
            self.save_book(&mut inner)?;
        }
        let mut r = Record::new(&email, "recover.done", "ok");
        r.target = Some(email.clone());
        r.ip = Some(ip.to_owned());
        self.record(r, t);
        Ok(Out::ok(json!({ "ok": true })))
    }

    /// POST logout {}.
    pub(crate) fn logout(&self, who: &Who, ip: &str) -> Out {
        self.inner.lock().sessions.remove(&who.sid);
        self.logger.security("console.signout", &Fields::new().with("email", &who.email).with("ip", ip), Level::Info);
        let mut out = Out::ok(json!({ "ok": true }));
        out.cookie = Some(self.clear_cookie());
        out
    }

    // ── Step-up (3.6) ───────────────────────────────────────────────────────────────────────────────────────

    /// The WebAuthn methods a step-up of `who` may use: under High for an admin or user manager, attested ones; for the
    /// enrollment step-up (R3-H1), working ones carrying the account's anchor; otherwise every working one.
    fn stepup_keys(&self, who: &Who, p: &Person, s: &Settings, enrollment: bool) -> Vec<Passkey> {
        let list = s.aaguid_list();
        p.passkeys
            .iter()
            .filter(|k| k.works())
            .filter(|k| {
                if enrollment {
                    self.carries_account_anchor(&who.email, p, k)
                } else if s.high() && who.role.privileged() {
                    self.attested_now(k, &list)
                } else {
                    true
                }
            })
            .cloned()
            .collect()
    }

    /// POST stepup/begin {action, target, params}: a ceremony held in the session (at most 4; a fifth replaces the
    /// oldest). `totp` is true under Standard when the account has an authenticator app; `enrollment` marks the High
    /// enrollment step-up of an admin or user manager without privileged rights, for `passkeys.add` and
    /// `account.security-key` only.
    pub(crate) fn stepup_begin(&self, who: &Who, body: &Value, origin: &str, t: i64) -> Result<Out, ApiError> {
        let action = str_of(body.get("action")).unwrap_or("");
        let target = str_of(body.get("target")).unwrap_or("");
        let params = body.get("params").cloned().unwrap_or(Value::Null);
        if !self.stepup_actions().contains(&action) || target.is_empty() || !params.is_object() {
            return Err(ApiError::with("invalid", "Say which action, target and parameters to confirm."));
        }
        let (p, s) = {
            let mut inner = self.inner.lock();
            if let Err(o) = inner.limits.hit(Limit::Stepup, &who.sid, t) {
                return Err(ApiError::rate(o.retry_secs));
            }
            (inner.book.people.get(&who.email).cloned().ok_or_else(|| ApiError::of("signin-first"))?, inner.book.settings.clone())
        };
        let enrollment = s.high() && who.role.privileged() && !who.privileged() && matches!(action, "passkeys.add" | "account.security-key");
        let allow: Vec<String> = self.stepup_keys(who, &p, &s, enrollment).into_iter().map(|k| k.id).collect();
        let totp = !s.high() && !enrollment && p.has_totp();
        let nonce = random_bytes(32)?;
        let id = b64u(&random_bytes(16)?);
        let mut inner = self.inner.lock();
        let Some(sess) = inner.sessions.get_mut(&who.sid) else { return Err(ApiError::of("signin-first")) };
        let challenge = stepup_challenge(&sess.sid_sha256, action, target, &params, &nonce).ok_or_else(|| ApiError::with("invalid", "The parameters are not canonical JSON."))?;
        sess.stepups.retain(|c| c.expires > t);
        while sess.stepups.len() >= STEPUPS_PER_SESSION {
            sess.stepups.pop_front();
        }
        sess.stepups.push_back(StepCeremony { id: id.clone(), nonce, binding: challenge, action: action.to_owned(), expires: t + STEPUP_MS, enrollment });
        let public_key = assertion_options(&challenge, &self.rp(origin), &allow, STEPUP_MS);
        Ok(Out::ok(json!({ "ok": true, "ceremony": id, "publicKey": public_key, "totp": totp, "enrollment": enrollment })))
    }

    /// Check a step-up for `action`, `target` and `params` (the body as received, without `stepup`): the method that
    /// made it. The ceremony is used once; the binding is recomputed from the body and compared before a TOTP code is
    /// checked; nothing changes on a failure but the ceremony's use (and a wrong code's count toward the lockout).
    pub(crate) fn verify_stepup(&self, who: &Who, stepup: Option<&Value>, bind: Bind, origin: &str, t: i64) -> Result<StepOk, ApiError> {
        let Bind { action, target, params } = bind;
        let Some(st) = stepup.and_then(Value::as_object) else {
            let totp = {
                let inner = self.inner.lock();
                !inner.book.settings.high() && inner.book.people.get(&who.email).is_some_and(Person::has_totp)
            };
            return Err(if totp { ApiError::with("stepup-needed", "Confirm with your security key, passkey or code to do this.") } else { ApiError::of("stepup-needed") });
        };
        let failed = |why: &str, code: bool| {
            self.logger.security("console.stepup-refused", &Fields::new().with("email", &who.email).with("action", action).with("why", why), Level::Warn);
            if code {
                ApiError::with("stepup-failed", "That code did not confirm this. Nothing was changed.")
            } else {
                ApiError::of("stepup-failed")
            }
        };
        let by_code = st.contains_key("totp");
        if !(exact_keys(st, &["ceremony", "credential"], &["ceremony", "credential"]) || exact_keys(st, &["ceremony", "totp"], &["ceremony", "totp"])) {
            return Err(failed("malformed", by_code));
        }
        let (c, sid_sha256, p, s) = {
            let mut inner = self.inner.lock();
            let ceremony_id = str_of(st.get("ceremony")).unwrap_or("");
            let Some(sess) = inner.sessions.get_mut(&who.sid) else { return Err(ApiError::of("signin-first")) };
            let Some(i) = sess.stepups.iter().position(|c| c.id == ceremony_id) else { return Err(failed("no such ceremony in this session", by_code)) };
            let Some(c) = sess.stepups.remove(i) else { return Err(failed("no such ceremony", by_code)) };
            let sid = sess.sid_sha256.clone();
            if c.expires <= t {
                self.logger.security("console.stepup-refused", &Fields::new().with("email", &who.email).with("action", action).with("why", "expired"), Level::Warn);
                return Err(ApiError::of("stepup-expired"));
            }
            (c, sid, inner.book.people.get(&who.email).cloned().ok_or_else(|| ApiError::of("signin-first"))?, inner.book.settings.clone())
        };
        // The binding first: action, target and parameters exactly as asked (3.6 step 2).
        let Some(challenge) = stepup_challenge(&sid_sha256, action, target, params, &c.nonce) else { return Err(failed("parameters not canonical", by_code)) };
        if c.action != action || !same_bytes(&challenge, &c.binding) {
            return Err(failed("bound to another action, target or parameters", by_code));
        }
        if c.enrollment && !matches!(action, "passkeys.add" | "account.security-key") {
            return Err(failed("an enrollment step-up confirms only adding a method", by_code));
        }
        if by_code {
            let usable = p.totp.as_ref().filter(|m| m.works() && !s.high() && !c.enrollment);
            let Some(m) = usable else { return Err(failed("no authenticator app this profile allows", true)) };
            let secret = self.seal_get(&p.totp_secret_name()).unwrap_or_default();
            let code = str_of(st.get("totp")).unwrap_or("");
            let step = crate::console_password::totp_match(&secret, code, t, m.last_step).filter(|_| !secret.is_empty());
            let mut inner = self.inner.lock();
            let Some(step) = step else {
                if let Some(acct) = inner.lock_fail(&who.email, t) {
                    drop(inner);
                    let mut r = Record::new("relay", "signin.locked", "ok");
                    r.target = Some(acct);
                    self.record(r, t);
                }
                return Err(failed("wrong or reused code", true));
            };
            let anchor = m.anchor.clone();
            let invited_by = m.invited_by.clone();
            if let Some(m) = inner.book.people.get_mut(&who.email).and_then(|p| p.totp.as_mut()) {
                m.last_step = Some(step);
            }
            self.save_book(&mut inner)?;
            return Ok(StepOk { method: "totp".into(), anchor, invited_by, enrollment: false });
        }
        let credential = st.get("credential").cloned().unwrap_or(Value::Null);
        let Ok(raw) = credential_id(&credential) else { return Err(failed("no passkey id", false)) };
        let id = b64u(&raw);
        let Some(key) = self.stepup_keys(who, &p, &s, c.enrollment).into_iter().find(|k| k.id == id) else {
            return Err(failed(if c.enrollment { "not a working method carrying the account's anchor" } else { "not one of this person's methods at the role's level" }, false));
        };
        let cose = unb64u(&key.cose).unwrap_or_default();
        let count = verify_stepup_assertion(&self.rp(origin), origin, &challenge, &cose, &credential).map_err(|e| failed(&e.message, false))?;
        let mut inner = self.inner.lock();
        let stored = inner.book.people.get(&who.email).and_then(|p| p.passkeys.iter().find(|k| k.id == id)).map_or(key.count, |k| k.count);
        if (count != 0 || stored != 0) && count <= stored {
            self.logger.security("console.stepup-refused", &Fields::new().with("email", &who.email).with("action", action).with("why", "counter"), Level::Warn);
            return Err(ApiError::of("stepup-failed"));
        }
        if let Some(k) = inner.book.people.get_mut(&who.email).and_then(|p| p.passkeys.iter_mut().find(|k| k.id == id)) {
            k.count = count;
            k.last_used = t;
        }
        self.save_book(&mut inner)?;
        Ok(StepOk { method: id, anchor: key.anchor.clone(), invited_by: key.invited_by.clone(), enrollment: c.enrollment })
    }

    // ── Own methods and sessions ────────────────────────────────────────────────────────────────────────────

    /// POST passkeys/add/begin {stepup} and account/security-key/begin {stepup}: the one enrollment policy (3.3,
    /// R3-H1). The new method takes the anchor of the step-up's method (N2); made through the enrollment step-up it is
    /// stored `waiting`, whatever its kind or attestation.
    pub(crate) fn passkey_add_begin(&self, who: &Who, step: &StepOk, kind: KeyKind, origin: &str, t: i64) -> Result<Out, ApiError> {
        let mut inner = self.inner.lock();
        let high = inner.book.settings.high();
        let p = inner.book.people.get(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        if !step.enrollment && p.working() >= PASSKEYS_MAX {
            return Err(ApiError::of("passkey-limit"));
        }
        let exclude: Vec<String> = p.passkeys.iter().map(|k| k.id.clone()).collect();
        let handle = p.handle.clone();
        let direct = kind == KeyKind::SecurityKey || (high && p.role.privileged());
        let challenge = random_bytes(32)?;
        let id = b64u(&random_bytes(16)?);
        let sess = inner.sessions.get_mut(&who.sid).ok_or_else(|| ApiError::of("signin-first"))?;
        sess.adding = Some(AddCeremony { id: id.clone(), challenge: challenge.clone(), expires: t + CEREMONY_MS, anchor: step.anchor.clone(), invited_by: step.invited_by.clone(), kind, waiting: step.enrollment });
        let public_key = creation_options(&challenge, &self.rp(origin), &handle, &who.email, &exclude, direct, kind);
        Ok(Out::ok(json!({ "ok": true, "ceremony": id, "publicKey": public_key })))
    }

    /// POST passkeys/add/finish and account/security-key/finish {ceremony, credential, label}.
    pub(crate) fn passkey_add_finish(&self, who: &Who, body: &Value, origin: &str, t: i64) -> Result<(Out, Value), ApiError> {
        let c = {
            let mut inner = self.inner.lock();
            let sess = inner.sessions.get_mut(&who.sid).ok_or_else(|| ApiError::of("signin-first"))?;
            sess.adding.take().filter(|c| Some(c.id.as_str()) == str_of(body.get("ceremony")) && c.expires > t).ok_or_else(|| ApiError::with("gone", "That request expired; try again."))?
        };
        let credential = body.get("credential").cloned().unwrap_or(Value::Null);
        let made = verify_registration(&self.rp(origin), origin, &c.challenge, &credential, true).map_err(|e| ApiError { status: e.status, code: "invalid", message: e.message, retry_after: None })?;
        let state = if c.waiting { KeyState::Waiting } else { KeyState::Working };
        let from = c.waiting.then(|| "enrollment".to_owned());
        let k = self.new_key(&made, &credential, label_of(body.get("label"), c.kind), (&c.anchor, c.invited_by.clone()), state, c.kind, from, t);
        let s = self.settings_now();
        let mut inner = self.inner.lock();
        if inner.book.find(&k.id).is_some() {
            return Err(ApiError::with("exists", "That passkey is already registered."));
        }
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        if c.waiting {
            while p.waiting_keys() >= WAITING_PASSKEYS_MAX {
                let Some(i) = p.passkeys.iter().enumerate().filter(|(_, k)| k.state == KeyState::Waiting && k.revoked_at.is_none()).min_by_key(|(_, k)| k.created).map(|(i, _)| i) else { break };
                p.passkeys.remove(i);
            }
        } else if p.working() >= PASSKEYS_MAX || (!k.discoverable() && p.working_not_discoverable() >= NOT_DISCOVERABLE_MAX) {
            return Err(ApiError::of("passkey-limit"));
        }
        p.passkeys.push(k.clone());
        self.save_book(&mut inner)?;
        drop(inner);
        let view = json!({ "hint": hint_of(&k.id), "label": k.label, "kind": k.kind.as_str(), "state": if c.waiting { "waiting" } else { "working" }, "attested": self.verdict_view_unlocked(&k, &s) });
        let detail = json!({ "credential_hint": hint_of(&k.id), "anchor": k.anchor, "kind": k.kind.as_str(), "state": if c.waiting { "waiting" } else { "working" }, "aaguid": k.verdict.as_ref().map(|v| v.aaguid.clone()) });
        Ok((Out::ok(json!({ "ok": true, "method": view })), detail))
    }

    /// POST passkeys/confirm {hint, stepup}: the caller's waiting passkey becomes working, its anchor kept (N2). The
    /// step-up was made with another working method at the role's level.
    pub(crate) fn passkey_confirm(&self, who: &Who, body: &Value) -> Result<(Out, Value), ApiError> {
        let hint = str_of(body.get("hint")).unwrap_or("");
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        let not_waiting = || ApiError::with("not-waiting", format!("{} is not waiting for approval.", who.email));
        let k = p.passkeys.iter_mut().find(|k| hint_of(&k.id) == hint && k.state == KeyState::Waiting && k.revoked_at.is_none()).ok_or_else(not_waiting)?;
        // A method enrolled through the enrollment step-up waits for another admin or the operator (R3-H1).
        if k.from.as_deref() == Some("enrollment") {
            return Err(ApiError::of("not-eligible"));
        }
        k.state = KeyState::Working;
        let detail = json!({ "credential_hint": hint, "anchor": k.anchor });
        self.save_book(&mut inner)?;
        Ok((Out::ok(json!({ "ok": true })), detail))
    }

    /// Whether `p` after a change still has a way to sign in under the profile (`last-method`).
    fn still_signs_in(&self, p: &Person, s: &Settings) -> bool {
        let list = s.aaguid_list();
        complete(p, s, &|k| self.attested_now(k, &list))
    }

    /// POST passkeys/remove {hint, stepup}: never the last way to sign in; the sessions it started end.
    pub(crate) fn passkey_remove(&self, who: &Who, body: &Value) -> Result<(Out, Value), ApiError> {
        let hint = str_of(body.get("hint")).unwrap_or("");
        let s = self.settings_now();
        let mut after = self.inner.lock().book.people.get(&who.email).cloned().ok_or_else(|| ApiError::of("signin-first"))?;
        let i = after.passkeys.iter().position(|k| hint_of(&k.id) == hint).ok_or_else(|| ApiError::with("not-found", "There is no such passkey."))?;
        let gone = after.passkeys.remove(i);
        if gone.works() && !self.still_signs_in(&after, &s) {
            return Err(ApiError::of("last-method"));
        }
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        p.passkeys.retain(|k| k.id != gone.id);
        inner.end_sessions(&who.email, Some(&gone.id));
        self.save_book(&mut inner)?;
        let ended_here = !inner.sessions.contains_key(&who.sid);
        let mut out = Out::ok(json!({ "ok": true }));
        if ended_here {
            out.cookie = Some(self.clear_cookie());
        }
        Ok((out, json!({ "credential_hint": hint, "kind": gone.kind.as_str() })))
    }

    /// POST passkeys/rename {hint, label}.
    pub(crate) fn passkey_rename(&self, who: &Who, body: &Value) -> Result<(Out, Value), ApiError> {
        let hint = str_of(body.get("hint")).unwrap_or("");
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        let k = p.passkeys.iter_mut().find(|k| hint_of(&k.id) == hint).ok_or_else(|| ApiError::with("not-found", "There is no such passkey."))?;
        let label = label_of(body.get("label"), k.kind);
        k.label = label.clone();
        self.save_book(&mut inner)?;
        Ok((Out::ok(json!({ "ok": true })), json!({ "credential_hint": hint, "label": label })))
    }

    /// POST account/password {current, password, stepup}: set or change one's password; `current` must be right when
    /// there is one (`password-wrong`); the password takes the anchor of the step-up's method.
    pub(crate) fn account_password(&self, who: &Who, step: &StepOk, body: &Value, t: i64) -> Result<(Out, Value), ApiError> {
        let current = str_of(body.get("current")).unwrap_or("");
        let password = str_of(body.get("password")).unwrap_or("");
        let (stored, high) = {
            let inner = self.inner.lock();
            let p = inner.book.people.get(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
            (p.password.as_ref().filter(|m| m.revoked_at.is_none()).map(|m| m.hash.clone()), inner.book.settings.high())
        };
        if stored.is_some() && !crate::console_password::verify(current, stored.as_deref()) {
            return Err(ApiError::of("password-wrong"));
        }
        self.check_password(password, high, &who.email)?;
        let hashed = crate::console_password::hash_new(password).ok_or_else(|| ApiError::with("write-failed", "The console could not draw random bytes; see the relay's log."))?;
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        let changed = p.password.is_some();
        p.password = Some(PasswordMethod { hash: hashed, anchor: step.anchor.clone(), invited_by: step.invited_by.clone(), created: t, revoked_at: None });
        self.save_book(&mut inner)?;
        Ok((Out::ok(json!({ "ok": true })), json!({ "changed": changed, "anchor": step.anchor })))
    }

    /// POST account/totp/begin {stepup}: Standard only; the secret shown once, held in the session until a code.
    pub(crate) fn account_totp_begin(&self, who: &Who, step: &StepOk, t: i64) -> Result<Out, ApiError> {
        if self.profile_high() {
            return Err(ApiError::of("profile-high"));
        }
        let secret = random_bytes(crate::console_password::TOTP_SECRET_LEN)?;
        let id = b64u(&random_bytes(16)?);
        let uri = crate::console_password::otpauth_uri(&secret, &self.cfg.host, &who.email);
        let shown = crate::console_password::base32(&secret);
        let mut inner = self.inner.lock();
        let sess = inner.sessions.get_mut(&who.sid).ok_or_else(|| ApiError::of("signin-first"))?;
        sess.totp = Some(TotpEnrollment { id: id.clone(), secret, anchor: step.anchor.clone(), invited_by: step.invited_by.clone(), expires: t + TOTP_ENROLL_MS });
        Ok(Out::ok(json!({ "ok": true, "enrollment": id, "secret": shown, "uri": uri })))
    }

    /// POST account/totp/finish {enrollment, code}: a current code completes it; the secret is sealed.
    pub(crate) fn account_totp_finish(&self, who: &Who, body: &Value, t: i64) -> Result<(Out, Value), ApiError> {
        if self.profile_high() {
            return Err(ApiError::of("profile-high"));
        }
        let e = {
            let mut inner = self.inner.lock();
            let sess = inner.sessions.get_mut(&who.sid).ok_or_else(|| ApiError::of("signin-first"))?;
            sess.totp.take().filter(|e| Some(e.id.as_str()) == str_of(body.get("enrollment")) && e.expires > t).ok_or_else(|| ApiError::with("gone", "That setup expired; start again."))?
        };
        let Some(step) = crate::console_password::totp_match(&e.secret, str_of(body.get("code")).unwrap_or(""), t, None) else {
            if let Some(sess) = self.inner.lock().sessions.get_mut(&who.sid) {
                sess.totp = Some(e);
            }
            return Err(ApiError::of("totp-wrong"));
        };
        let name = self.inner.lock().book.people.get(&who.email).map(Person::totp_secret_name).ok_or_else(|| ApiError::of("signin-first"))?;
        self.seal_put(&name, &e.secret)?;
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        p.totp = Some(TotpMethod { anchor: e.anchor.clone(), invited_by: e.invited_by.clone(), created: t, last_step: Some(step), revoked_at: None, unusable: false });
        self.save_book(&mut inner)?;
        Ok((Out::ok(json!({ "ok": true })), json!({ "anchor": e.anchor })))
    }

    /// POST account/totp/remove {stepup}: never the last way to sign in; its sessions end.
    pub(crate) fn account_totp_remove(&self, who: &Who) -> Result<(Out, Value), ApiError> {
        let s = self.settings_now();
        let mut after = self.inner.lock().book.people.get(&who.email).cloned().ok_or_else(|| ApiError::of("signin-first"))?;
        if after.totp.take().is_none() {
            return Err(ApiError::with("not-found", "There is no such authenticator app."));
        }
        if !self.still_signs_in(&after, &s) {
            return Err(ApiError::of("last-method"));
        }
        self.seal_remove(&after.totp_secret_name());
        let mut inner = self.inner.lock();
        if let Some(p) = inner.book.people.get_mut(&who.email) {
            p.totp = None;
        }
        inner.end_sessions(&who.email, Some("totp"));
        self.save_book(&mut inner)?;
        let mut out = Out::ok(json!({ "ok": true }));
        if !inner.sessions.contains_key(&who.sid) {
            out.cookie = Some(self.clear_cookie());
        }
        Ok((out, Value::Null))
    }

    /// POST account/mail {kinds}: the attention kinds an admin is mailed about (3.11).
    pub(crate) fn account_mail(&self, who: &Who, body: &Value) -> Result<(Out, Value), ApiError> {
        let list = body.get("kinds").and_then(Value::as_array).ok_or_else(|| ApiError::with("invalid", "kinds is a list of attention kinds."))?;
        let mut kinds: Vec<String> = Vec::new();
        for k in list {
            let k = k.as_str().filter(|k| (1..=40).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')).ok_or_else(|| ApiError::with("invalid", "kinds is a list of attention kinds."))?;
            if !kinds.iter().any(|x| x == k) {
                kinds.push(k.to_owned());
            }
        }
        kinds.truncate(64);
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&who.email).ok_or_else(|| ApiError::of("signin-first"))?;
        p.mail_kinds = Some(kinds.clone());
        self.save_book(&mut inner)?;
        Ok((Out::ok(json!({ "ok": true, "kinds": kinds.clone() })), json!({ "kinds": kinds })))
    }

    /// `admins.reset-sign-in` carried out (3.3 "Recovery", R3-L2): every method of the target and its sessions go; a
    /// `reset-sign-in` link (24 h, once) is shown to the resetting admin and never mailed. Methods set up through it
    /// take the anchor "console".
    pub(crate) fn run_reset_sign_in(&self, email: &str, by: &str, t: i64) -> Result<Value, ApiError> {
        let (role, secret) = {
            let mut inner = self.inner.lock();
            let p = inner.book.people.get_mut(email).filter(|p| p.state != PersonState::Waiting).ok_or_else(|| ApiError::with("stale", format!("Nothing was changed: {email} is no longer in the book.")))?;
            p.passkeys.clear();
            p.password = None;
            p.totp = None;
            p.anchor = CONSOLE_ANCHOR.to_owned();
            let out = (p.role, p.totp_secret_name());
            inner.end_sessions(email, None);
            inner.book.invites.retain(|_, i| i.email != email);
            self.save_book(&mut inner)?;
            out
        };
        self.seal_remove(&secret);
        let (link, expires) = self.mint_console_token(email, role, by, InviteKind::ResetSignIn, false, t)?;
        Ok(json!({ "ok": true, "link": link, "expires": expires }))
    }

    /// GET sessions: every session for an admin, the caller's own otherwise.
    pub(crate) fn sessions_view(&self, who: &Who) -> Out {
        let inner = self.inner.lock();
        let mut rows: Vec<(&String, &Session)> = inner.sessions.iter().filter(|(_, s)| who.admin || s.email == who.email).collect();
        rows.sort_by_key(|(_, s)| -s.last);
        let list: Vec<Value> = rows
            .iter()
            // 3.4: each session keeps the methods that signed in and when the banner was accepted.
            .map(|(k, s)| json!({ "id_hint": &k[..8], "email": s.email, "createdAt": s.created, "lastAt": s.last, "ip": s.ip, "agent": s.agent, "methods": s.methods, "bannerAt": s.banner_at, "current": **k == who.sid }))
            .collect();
        Out::ok(json!({ "ok": true, "sessions": list }))
    }

    /// POST sessions/end {id_hint}: one of the caller's own sessions; a hint matching none or several is refused.
    pub(crate) fn session_end(&self, who: &Who, body: &Value) -> Result<(Out, Value), ApiError> {
        let hint = str_of(body.get("id_hint")).unwrap_or("");
        let mut inner = self.inner.lock();
        let mine: Vec<String> = inner.sessions.iter().filter(|(k, s)| s.email == who.email && hint.len() >= 8 && k.starts_with(hint)).map(|(k, _)| k.clone()).collect();
        if mine.len() != 1 {
            return Err(ApiError::with("not-found", "There is no such session."));
        }
        inner.sessions.remove(&mine[0]);
        let mut out = Out::ok(json!({ "ok": true, "ended": 1 }));
        if mine[0] == who.sid {
            out.cookie = Some(self.clear_cookie());
        }
        Ok((out, Value::Null))
    }

    /// POST sessions/end-all {email, stepup}: every session of that person (10 an hour for someone else's).
    pub(crate) fn sessions_end_all(&self, who: &Who, body: &Value, t: i64) -> Result<(Out, Value), ApiError> {
        let email = email_of(str_of(body.get("email"))).ok_or_else(|| ApiError::with("not-found", "There is no such person."))?;
        let mut inner = self.inner.lock();
        if !inner.book.people.contains_key(&email) {
            return Err(ApiError::with("not-found", "There is no such person."));
        }
        if email != who.email {
            if let Err(o) = inner.limits.hit(Limit::EndSessions, &who.email, t) {
                return Err(ApiError::rate(o.retry_secs));
            }
        }
        let ended = inner.end_sessions(&email, None);
        let mut out = Out::ok(json!({ "ok": true, "ended": ended }));
        if email == who.email {
            out.cookie = Some(self.clear_cookie());
        }
        Ok((out, json!({ "ended": ended })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-console-auth-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ok(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn the_lock_refuses_a_second_holder_and_frees_on_drop() {
        let d = dir("lock");
        let held = lock_state(&d).unwrap();
        assert_eq!(lock_state(&d).err().as_deref(), Some(RUNNING));
        let cmds = || {
            vec![
                Offline::RemoveAdmin("a@acme.example".into()),
                Offline::Unsuspend("a@acme.example".into()),
                Offline::ApproveJoin { email: "a@acme.example".into(), admin: false },
                Offline::Reset { first_admin: "a@acme.example".into(), typed_host: "relay.example.com".into() },
                Offline::BreakGlass { email: "bg@acme.example".into(), replace: false, origin: Some("https://relay.example.com".into()) },
                Offline::TwoPersonOff,
            ]
        };
        for cmd in cmds() {
            assert_eq!(run_offline(&d, cmd, "relay.example.com", &ok).err().as_deref(), Some(RUNNING));
        }
        // The process holding it ends (here: the handle goes): the CLI runs.
        drop(held);
        let done = run_offline(&d, Offline::Reset { first_admin: "a@acme.example".into(), typed_host: "relay.example.com".into() }, "relay.example.com", &ok).unwrap();
        assert!(done.contains("a@acme.example"));
    }

    #[test]
    fn reset_needs_the_first_admin_and_the_host_typed() {
        let d = dir("reset");
        let mut b = Book { bootstrapped: true, ever_two_admins: true, ..Book::default() };
        b.save(&d.join(CONSOLE_FILE)).unwrap();
        assert!(run_offline(&d, Offline::Reset { first_admin: String::new(), typed_host: "relay.example.com".into() }, "relay.example.com", &ok).err().unwrap().contains("--first-admin"));
        assert!(run_offline(&d, Offline::Reset { first_admin: "a@acme.example".into(), typed_host: "other".into() }, "relay.example.com", &ok).err().unwrap().contains("host name"));
        run_offline(&d, Offline::Reset { first_admin: "A@acme.example".into(), typed_host: "relay.example.com".into() }, "relay.example.com", &ok).unwrap();
        let b = Book::read(&d.join(CONSOLE_FILE), 0).unwrap();
        assert!(!b.bootstrapped && !b.ever_two_admins);
        assert_eq!(b.first_admin.as_deref(), Some("a@acme.example"));
        assert_eq!(b.pending_audit.len(), 1);
    }

    #[test]
    fn break_glass_is_created_once_and_replaced_only_with_replace() {
        let d = dir("breakglass");
        let origin = Some("https://relay.example.com".to_owned());
        let out = run_offline(&d, Offline::BreakGlass { email: "bg@acme.example".into(), replace: false, origin: origin.clone() }, "relay.example.com", &ok).unwrap();
        assert!(out.starts_with(BREAK_GLASS_LINK) && out.contains("https://relay.example.com/console/#join="));
        let b = Book::read(&d.join(CONSOLE_FILE), 0).unwrap();
        let p = &b.people["bg@acme.example"];
        assert!(p.break_glass && p.role == PersonRole::Admin && p.anchor == OPERATOR_ANCHOR);
        assert!(b.invites.values().any(|i| i.source == InviteSource::Operator && i.email == "bg@acme.example"));
        assert_eq!(run_offline(&d, Offline::BreakGlass { email: "bg2@acme.example".into(), replace: false, origin: origin.clone() }, "relay.example.com", &ok).err().as_deref(), Some(BREAK_GLASS_EXISTS));
        run_offline(&d, Offline::BreakGlass { email: "bg2@acme.example".into(), replace: true, origin }, "relay.example.com", &ok).unwrap();
        let b = Book::read(&d.join(CONSOLE_FILE), 0).unwrap();
        assert!(!b.people.contains_key("bg@acme.example") && b.people["bg2@acme.example"].break_glass);
        assert_eq!(b.pending_audit.iter().filter(|e| e["action"] == "break-glass.create").count(), 2);
    }

    #[test]
    fn two_person_off_offline() {
        let d = dir("twoperson");
        let mut b = Book::default();
        b.settings.two_person = true;
        b.save(&d.join(CONSOLE_FILE)).unwrap();
        assert_eq!(run_offline(&d, Offline::TwoPersonOff, "relay.example.com", &ok).unwrap(), TWO_PERSON_OFF);
        let b = Book::read(&d.join(CONSOLE_FILE), 0).unwrap();
        assert!(!b.settings.two_person);
        assert_eq!(b.pending_audit[0]["action"], "two-person.off");
    }

    #[test]
    fn a_book_from_before_ac1_is_bootstrapped_and_anchored() {
        let d = dir("upgrade");
        let old = json!({ "v": 1, "origin": "https://relay.example.com", "invites": {}, "admins": {
            "alice@acme.example": { "handle": "h", "created": 1, "lastSignIn": 2, "serial": "0000000000000000000000000000000a", "passkeys": [{ "id": "AQ", "cose": "x", "count": 0, "label": "L", "created": 1, "lastUsed": 2 }] },
            "bob@acme.example": { "handle": "h2", "created": 1, "lastSignIn": 2, "passkeys": [{ "id": "Ag", "cose": "x", "count": 0, "label": "L", "created": 1, "lastUsed": 2 }] } } });
        std::fs::write(d.join(CONSOLE_FILE), stringify(&old)).unwrap();
        let mut b = Book::read(&d.join(CONSOLE_FILE), 99).unwrap();
        assert!(b.bootstrapped && b.ever_two_admins);
        assert_eq!(b.people["alice@acme.example"].passkeys[0].anchor, "0000000000000000000000000000000a");
        assert_eq!(b.people["bob@acme.example"].passkeys[0].anchor, CONSOLE_ANCHOR);
        assert!(b.people.values().all(|p| p.unproven && p.passkeys.iter().all(|k| !k.anchor.is_empty())));
        // Saved as version 3 and read back the same.
        b.save(&d.join(CONSOLE_FILE)).unwrap();
        let again = Book::read(&d.join(CONSOLE_FILE), 100).unwrap();
        assert_eq!(again.to_value(), b.to_value());
    }

    #[test]
    fn latching_reaches_passwords_and_authenticator_apps() {
        let mut b = Book::default();
        let mut p = Person::new("h".into(), PersonRole::Viewer, PersonState::Active, "0a", 1);
        p.password = Some(PasswordMethod { hash: "x".into(), anchor: "0a".into(), invited_by: None, created: 1, revoked_at: None });
        p.totp = Some(TotpMethod { anchor: "0a".into(), invited_by: None, created: 1, last_step: None, revoked_at: None, unusable: false });
        b.people.insert("v@acme.example".into(), p);
        assert_eq!(b.latch([&"0a".to_owned()], 5), vec!["v@acme.example".to_owned()]);
        let p = &b.people["v@acme.example"];
        assert_eq!((p.password.as_ref().unwrap().revoked_at, p.totp.as_ref().unwrap().revoked_at), (Some(5), Some(5)));
        assert!(p.revoked());
    }

    #[test]
    fn completeness_follows_the_profile() {
        let mut s = Settings { profile: crate::console_settings::Profile::High, ..Settings::default() };
        let mut p = Person::new("h".into(), PersonRole::Viewer, PersonState::Active, CONSOLE_ANCHOR, 1);
        let never = |_: &Passkey| false;
        assert!(!complete(&p, &s, &never));
        p.password = Some(PasswordMethod { hash: "x".into(), anchor: CONSOLE_ANCHOR.into(), invited_by: None, created: 1, revoked_at: None });
        p.totp = Some(TotpMethod { anchor: CONSOLE_ANCHOR.into(), invited_by: None, created: 1, last_step: None, revoked_at: None, unusable: false });
        // High never takes a password and an app.
        assert!(!complete(&p, &s, &never));
        s.profile = crate::console_settings::Profile::Standard;
        assert!(complete(&p, &s, &never));
        p.break_glass = true;
        assert!(complete(&p, &s, &never));
        s.profile = crate::console_settings::Profile::High;
        assert!(!complete(&p, &s, &never));
    }

    #[test]
    fn cleaning_removes_controls_and_ignorables() {
        assert_eq!(clean("a\u{202E}b\u{200B}c\u{0007} \u{0085}d"), "abc d");
        assert!(ignorable('\u{FEFF}') && ignorable('\u{2066}') && !ignorable('a'));
    }

    #[test]
    fn the_stepup_challenge_binds_every_part() {
        let sid = [7u8; 32];
        let nonce = [9u8; 32];
        let params = json!({ "email": "bob@acme.example", "reason": "x" });
        let a = stepup_challenge(&sid, "admins.remove", "bob@acme.example", &params, &nonce).unwrap();
        assert_ne!(Some(a), stepup_challenge(&sid, "admins.suspend", "bob@acme.example", &params, &nonce));
        assert_ne!(Some(a), stepup_challenge(&sid, "admins.remove", "eve@acme.example", &params, &nonce));
        assert_ne!(Some(a), stepup_challenge(&sid, "admins.remove", "bob@acme.example", &json!({ "email": "bob@acme.example", "reason": "y" }), &nonce));
        assert_ne!(Some(a), stepup_challenge(&[8u8; 32], "admins.remove", "bob@acme.example", &params, &nonce));
        assert_ne!(Some(a), stepup_challenge(&sid, "admins.remove", "bob@acme.example", &params, &[1u8; 32]));
        // Key order does not matter (canonical JSON).
        assert_eq!(Some(a), stepup_challenge(&sid, "admins.remove", "bob@acme.example", &json!({ "reason": "x", "email": "bob@acme.example" }), &nonce));
    }
}
