//! Lucid Meet password accounts (workspace ADR-0343, moved from the Python Meet console by ADR-0347): people accept
//! an emailed invite, choose a username and a password, and sign in from the Meet apps or the web page; every sign-in
//! answers a fresh one-time v3 invite (an `LMJ1:` code) made through the Meet relay's admin routes with the console's
//! own Meet device certificate. The public pages and API under `/meet/` keep the Meet console's wire byte for byte
//! (paths, JSON, status codes, sentences, headers, limits) so Hub, iPhone and Android need no change; admins manage
//! accounts under `/console/api/meet/accounts`. State is `meet-accounts.json` (the old state's account keys), the
//! settings live in console.json (`settings.meetAccounts`) and the device key, the App Store Connect key and the
//! download link secret are sealed. `lucid-relay console meet-accounts import` moves everything from the Meet console.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use aws_lc_rs::{constant_time, hmac, pbkdf2};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::codec::{b64u, sha256_hex};
use crate::console::{ApiError, Console, ConsoleReply, Done, Need, Out, Role, RouteSpec};
use crate::fleet_x509::{der, Curve, Key};
use crate::log::{Fields, Level};
use crate::meet_json::{dumps, dumps_compact, iso_date, iso_utc, printable, squash, str_or, truthy};
use crate::meet_x509::Cert;

type Obj = Map<String, Value>;
/// Unix seconds as a float (Python's time.time()); tests pass a fixed one.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

pub const STATE_FILE: &str = "meet-accounts.json";
/// Sealed values (console_seal): the console's Meet device key (PEM), the App Store Connect key (.p8) and the
/// download link secret (raw bytes).
pub const SECRET_DEVICE_KEY: &str = "meet.accounts.relay-key";
pub const SECRET_ASC_KEY: &str = "meet.accounts.asc-key";
pub const SECRET_FILES: &str = "meet.accounts.files-secret";

const INVITE_TTL: f64 = 7.0 * 86400.0;
const ACCOUNT_BODY_MAX: i64 = 4096;
const ACCOUNT_LIMIT: usize = 10;
const ACCOUNT_WINDOW: f64 = 600.0;
const ACCOUNT_FAILURES: i64 = 5;
const ACCOUNT_LOCK: f64 = 900.0;
const ACCOUNT_DEVICES_MAX: usize = 5;
const ACCOUNT_BY: &str = "account-signin";
const ACCOUNT_REASON: &str = "approved by the console: password sign-in";
const ACCOUNT_LABEL_MAX: usize = 64;
const ACCOUNT_OFF: &str = "Password sign-in is off: import it with lucid-relay console meet-accounts import.";
const ACCOUNT_INVITE_SUBJECT: &str = "You're invited to Lucid Meet";
const ACCOUNT_RESET_SUBJECT: &str = "Lucid Meet: set a new password";
const AUTO_APPROVE_MAX: usize = 5;
const AUTO_APPROVE_EVERY: Duration = Duration::from_secs(20);
const AUTO_APPROVE_KINDS: [&str; 2] = ["enroll", "renew"];
const AUTO_APPROVE_BY: &str = "auto-approve";
const SIGNIN_WRONG: &str = "The username or password is wrong.";
const SIGNIN_SEEDS_KEEP: f64 = 2.0 * 86400.0;
const SIGNIN_PASS_DELAY: Duration = Duration::from_secs(5);
const LIMIT_WORDS: &str = "Too many attempts from this address. Wait a few minutes and try again.";
const PBKDF2_ITERATIONS: u32 = 600_000;
const PBKDF2_SALT: usize = 16;
const PBKDF2_BYTES: usize = 32;
const PASSWORD_MIN: usize = 12;
const PASSWORD_MAX: usize = 256;
/// Common passwords of 12 characters or more, refused outright (compared in lower case).
const PASSWORD_BLOCKLIST: [&str; 40] = [
    "123456789012", "1234567890123", "12345678901234", "123456789abc", "1q2w3e4r5t6y",
    "qwertyuiop12", "qwertyuiopas", "qwerty123456", "qwertyqwerty", "asdfghjkl123",
    "password1234", "password12345", "password123!", "passwordpassword", "password1234!",
    "iloveyou1234", "letmein12345", "welcome12345", "welcome123456", "changeme1234",
    "administrator", "admin1234567", "abc123456789", "abcdefghijkl", "aaaaaaaaaaaa",
    "lucidmeet123", "lucidmeet1234", "lucidmeeting", "trustno1trustno1", "football1234",
    "baseball1234", "superman1234", "sunshine1234", "princess1234", "monkey123456",
    "dragon123456", "starwars1234", "000000000000", "111111111111", "987654321098",
];
const MEET_DEVICE_DAYS: i64 = 30;
const MEET_KINDS: [&str; 3] = ["enroll", "seed", "renew"];
const DOWNLOAD_PLATFORMS: [(&str, &str); 2] = [("windows", "Windows"), ("macos", "Mac")];
const DOWNLOAD_DAYS: i64 = 7;
/// Downloads per link (meet_downloads.CAP).
const DOWNLOAD_CAP: u32 = 3;
const MAIL_WIDTH: usize = 76;
const ASC_HOST: &str = "api.appstoreconnect.apple.com";
const ASC_AUDIENCE: &str = "appstoreconnect-v1";
const ASC_TOKEN_TTL: i64 = 1200;
const NET_TIMEOUT: f64 = 20.0;
/// Bytes of one relay answer, and of one App Store Connect answer, read at most.
const RELAY_MAX: usize = 8 * 1024 * 1024;
const ASC_MAX: usize = 1024 * 1024;
const PROOF_PREFIX: &str = "lucid-meet-proof/1|";
const CODE_PREFIX: &str = "LMJ1:";
const STORED_MAX: usize = 65_535;
/// The Meet console's headers on every public answer (its own CSP, not the Admin Console's).
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PUBLIC_HEADERS: [(&str, &str); 8] = [
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Strict-Transport-Security", "max-age=31536000"),
];
const JSON_TYPE: &str = "application/json; charset=utf-8";
const HTML: &[u8] = include_bytes!("../console/meet-account/account.html");
const JS: &[u8] = include_bytes!("../console/meet-account/account.js");
const CSS: &[u8] = include_bytes!("../console/meet-account/account.css");
/// Exactly these paths, no query string; one page for both, account.js reads the mode from the path.
const PAGES: [(&str, &[u8], &str); 4] = [
    ("/meet/join", HTML, "text/html; charset=utf-8"),
    ("/meet/signin", HTML, "text/html; charset=utf-8"),
    ("/meet/static/account.js", JS, "text/javascript; charset=utf-8"),
    ("/meet/static/account.css", CSS, "text/css; charset=utf-8"),
];
const PUBLIC_ROUTES: [&str; 3] = ["/meet/api/join/info", "/meet/api/join", "/meet/api/signin"];

const fn admin_post(path: &'static str, action: &'static str, target: &'static str, keys: &'static [&'static str]) -> RouteSpec {
    RouteSpec { method: "POST", path, role: Role::Admin, action, target, stepup: false, need: Need::Any, security: false, keys, body_max: crate::console::BODY_MAX }
}

/// TH-1 5, 6: the console's own copy of the organization's brand, which the account pages read.
const BRAND_READ: &str = "/meet/api/brand";
const BRAND_LOGO: &str = "/meet/brand/logo";

/// The admin routes (after /console/api/), fleet console only; admins as the Meet console asked, no step-up. The TH-1
/// brand rows (the console's own copy for the account pages; the Branding page then sends the same change to each
/// Meeting Hub relay through the proxy) take a step-up like the relays' own `meet/brand` rows.
pub static ROUTES: [RouteSpec; 10] = [
    RouteSpec { method: "GET", path: "meet/accounts/brand", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/accounts/brand", role: Role::Admin, action: "meet.brand.set", target: "-", stepup: true, need: Need::Any, security: false, keys: &crate::meet_brand::FIELD_KEYS, body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/accounts/brand/logo", role: Role::Admin, action: "meet.brand.logo", target: "-", stepup: true, need: Need::Any, security: false, keys: &crate::meet_brand::LOGO_KEYS, body_max: crate::meet_brand::LOGO_BODY_MAX },
    RouteSpec { method: "POST", path: "meet/accounts/brand/reset", role: Role::Admin, action: "meet.brand.reset", target: "-", stepup: true, need: Need::Any, security: false, keys: &["reason"], body_max: 1024 },
    RouteSpec { method: "GET", path: "meet/accounts", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    admin_post("meet/accounts/invite", "meet.account.invite", "email", &["name", "email"]),
    admin_post("meet/accounts/reset", "meet.account.reset", "username", &["username"]),
    admin_post("meet/accounts/remove", "meet.account.remove", "username", &["username"]),
    admin_post("meet/accounts/approval", "meet.account.approval", "mode", &["mode"]),
    admin_post("meet/accounts/unlock", "meet.account.unlock", "username", &["username"]),
];

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────

/// A refusal with the Meet console's status and sentence; `state`: the state file failed (the public side then
/// answers its own 500 sentence).
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
    pub retry_after: Option<i64>,
    pub state: bool,
}

fn refuse(status: u16, message: impl Into<String>) -> Refusal {
    Refusal { status, message: message.into(), retry_after: None, state: false }
}

fn state_failed(why: impl Into<String>) -> Refusal {
    Refusal { state: true, ..refuse(500, why) }
}

impl Refusal {
    /// The Admin Console's refusal (its 8.3 code by status, the Meet console's sentence).
    fn api(self) -> ApiError {
        if self.state {
            return ApiError::of("write-failed");
        }
        let code = match self.status {
            400 => "invalid",
            404 => "not-found",
            409 => "exists",
            429 => "rate",
            _ => "relay-offline",
        };
        ApiError { status: self.status, code, message: self.message, retry_after: self.retry_after }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────

/// The App Store Connect ids (the key itself is sealed).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TestFlightIds {
    pub key_id: String,
    pub issuer_id: String,
    pub group_id: String,
}

/// console.json `settings.meetAccounts`: the Meet console's settings this service needs, no secret.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountSettings {
    /// The public origin the download gate forwards `/meet/` from; "" leaves password sign-in off.
    pub account_base: String,
    /// The gate's own address, the only peer whose X-Forwarded-For is believed ("" nobody's).
    pub account_proxy: String,
    pub relay_address: String,
    pub relay_port: u16,
    pub relay_name: String,
    /// The console's Meet device certificate and the Meet root (PEM; the device key is sealed).
    pub relay_cert_pem: String,
    pub relay_ca_pem: String,
    pub invite_server: String,
    pub invite_port: u16,
    pub invite_address: String,
    pub auto_approve: Vec<String>,
    pub testflight: Option<TestFlightIds>,
    pub files_base: String,
}

impl AccountSettings {
    pub fn to_value(&self) -> Value {
        json!({
            "base": self.account_base,
            "proxy": self.account_proxy,
            "relayAddress": self.relay_address,
            "relayPort": self.relay_port,
            "relayName": self.relay_name,
            "relayCertPem": self.relay_cert_pem,
            "relayCaPem": self.relay_ca_pem,
            "inviteServer": self.invite_server,
            "invitePort": self.invite_port,
            "inviteAddress": self.invite_address,
            "autoApprove": self.auto_approve,
            "testflight": self.testflight.as_ref().map(|t| json!({ "keyId": t.key_id, "issuerId": t.issuer_id, "groupId": t.group_id })),
            "filesBase": self.files_base,
        })
    }

    pub fn from_value(v: &Value) -> Option<AccountSettings> {
        let o = v.as_object()?;
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
        let port = |k: &str| o.get(k).and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok());
        let testflight = match o.get("testflight") {
            None | Some(Value::Null) => None,
            Some(t) => Some(TestFlightIds { key_id: t.get("keyId")?.as_str()?.to_owned(), issuer_id: t.get("issuerId")?.as_str()?.to_owned(), group_id: t.get("groupId")?.as_str()?.to_owned() }),
        };
        let auto_approve = o.get("autoApprove")?.as_array()?.iter().map(|x| x.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?;
        Some(AccountSettings {
            account_base: s("base")?,
            account_proxy: s("proxy")?,
            relay_address: s("relayAddress")?,
            relay_port: port("relayPort")?,
            relay_name: s("relayName")?,
            relay_cert_pem: s("relayCertPem")?,
            relay_ca_pem: s("relayCaPem")?,
            invite_server: s("inviteServer")?,
            invite_port: port("invitePort")?,
            invite_address: s("inviteAddress")?,
            auto_approve,
            testflight,
            files_base: s("filesBase")?,
        })
    }

    fn enabled(&self) -> bool {
        !self.account_base.is_empty()
    }

    /// The console's own Meet address, `console@` the relay's name; "" when no relay name is set.
    pub fn console_email(&self) -> String {
        if self.relay_name.is_empty() { String::new() } else { format!("console@{}", self.relay_name.to_lowercase()) }
    }

    /// What a person types as the organization in the app: the public host and port.
    fn org(&self) -> String {
        self.account_base.trim_start_matches("https://").trim_end_matches('/').to_owned()
    }
}

// ── Usernames, passwords, people ────────────────────────────────────────────────────────────────────────────

fn username_ok(u: &str) -> bool {
    let b = u.as_bytes();
    (3..=32).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

pub fn check_username(value: Option<&Value>) -> Result<String, Refusal> {
    let username = str_or(value).trim().to_lowercase();
    if !username_ok(&username) {
        return Err(refuse(400, "Choose a username of 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or a digit."));
    }
    Ok(username)
}

/// A password as typed, NFKC-normalized so the same characters typed on another keyboard match; never stripped.
fn password_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.nfkc().collect(),
        _ => String::new(),
    }
}

/// 12 to 256 characters, not the username or the email's name (nor holding them), not a common password.
pub fn check_password(value: Option<&Value>, username: &str, email: &str) -> Result<String, Refusal> {
    let password = password_text(value);
    if !(PASSWORD_MIN..=PASSWORD_MAX).contains(&password.chars().count()) {
        return Err(refuse(400, format!("Choose a password of {PASSWORD_MIN} to {PASSWORD_MAX} characters.")));
    }
    let low = password.to_lowercase();
    let local = email.split('@').next().unwrap_or("").to_lowercase();
    for part in [username.to_lowercase(), local] {
        if !part.is_empty() && (low == part || (part.chars().count() >= 3 && low.contains(&part))) {
            return Err(refuse(400, "The password must not contain your username or your email address."));
        }
    }
    let mut chars = low.chars();
    let first = chars.next();
    if PASSWORD_BLOCKLIST.contains(&low.as_str()) || chars.all(|c| Some(c) == first) {
        return Err(refuse(400, "That password is too common. Choose another one."));
    }
    Ok(password)
}

/// Standard base64 without padding (the Meet console's `_b64`).
fn b64_bare(data: &[u8]) -> String {
    crate::meet_json::b64(data).trim_end_matches('=').to_owned()
}

/// Strict standard base64, padding optional (`_unb64`).
fn unb64_bare(text: &str) -> Option<Vec<u8>> {
    let pad = (4 - text.len() % 4) % 4;
    crate::meet_json::b64_strict(&format!("{text}{}", "=".repeat(pad)))
}

fn pbkdf2_of(password: &str, salt: &[u8], rounds: NonZeroU32) -> [u8; PBKDF2_BYTES] {
    let mut out = [0u8; PBKDF2_BYTES];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, rounds, salt, password.as_bytes(), &mut out);
    out
}

/// `pbkdf2-sha256$<rounds>$<salt>$<hash>` (standard base64 without padding) of the NFKC password. Not
/// console_password's: that one pads its base64, and the imported hashes do not.
pub fn hash_with(password: &str, salt: &[u8], rounds: NonZeroU32) -> String {
    let text: String = password.nfkc().collect();
    format!("pbkdf2-sha256${}${}${}", rounds.get(), b64_bare(salt), b64_bare(&pbkdf2_of(&text, salt, rounds)))
}

fn hash_password(password: &str) -> Result<String, Refusal> {
    let salt = crate::console_auth::random(PBKDF2_SALT).ok_or_else(|| refuse(500, "The console could not draw random bytes."))?;
    Ok(hash_with(password, &salt, NonZeroU32::new(PBKDF2_ITERATIONS).unwrap_or(NonZeroU32::MIN)))
}

/// Whether `password` matches `stored` (constant-time). A missing or broken hash still costs one PBKDF2, so an
/// unknown username takes as long as a wrong password.
pub fn verify_password(password: Option<&Value>, stored: Option<&str>) -> bool {
    let raw = password_text(password);
    let parsed = stored.and_then(|s| {
        let parts: Vec<&str> = s.split('$').collect();
        let [scheme, rounds, salt, digest] = parts.as_slice() else { return None };
        let rounds: u32 = rounds.parse().ok()?;
        let (salt, digest) = (unb64_bare(salt)?, unb64_bare(digest)?);
        (*scheme == "pbkdf2-sha256" && (1000..=10_000_000).contains(&rounds) && !salt.is_empty() && digest.len() == PBKDF2_BYTES).then_some((NonZeroU32::new(rounds)?, salt, digest))
    });
    match parsed {
        Some((rounds, salt, digest)) => constant_time::verify_slices_are_equal(&pbkdf2_of(&raw, &salt, rounds), &digest).is_ok(),
        None => {
            let _ = pbkdf2_of(&raw, &[0u8; PBKDF2_SALT], NonZeroU32::new(PBKDF2_ITERATIONS).unwrap_or(NonZeroU32::MIN));
            false
        }
    }
}

/// A free username made from the email's name (`john.lopez`), or "" when none fits.
pub fn username_suggestion(email: &str, taken: &Obj) -> String {
    let local = email.split('@').next().unwrap_or("").to_lowercase();
    let mut base = String::new();
    let mut gap = false;
    for c in local.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            if gap {
                base.push('.');
                gap = false;
            }
            base.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        base.push('.');
    }
    let base: String = base.trim_matches(|c| matches!(c, '.' | '_' | '-')).chars().take(28).collect();
    if base.is_empty() {
        return String::new();
    }
    let base = format!("{base:0<3}");
    if !username_ok(&base) {
        return String::new();
    }
    (0..100).map(|n| if n == 0 { base.clone() } else { format!("{base}{}", n + 1) }).find(|name| username_ok(name) && !taken.contains_key(name)).unwrap_or_default()
}

/// `[^@\s]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}` (the Meet console's `_EMAIL`).
fn email_ok(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else { return false };
    let Some((head, tld)) = domain.rsplit_once('.') else { return false };
    (1..=64).contains(&local.chars().count())
        && !local.chars().any(char::is_whitespace)
        && (1..=190).contains(&head.len())
        && head.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && (2..=24).contains(&tld.len())
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
}

fn label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    (1..=63).contains(&b.len()) && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// One plain address: a dot-atom local part and a DNS domain (the Meet console's `_ADDRESS`).
fn address_ok(s: &str) -> bool {
    const ATEXT: &[u8] = b"!#$%&'*+/=?^_`{|}~-";
    let Some((local, domain)) = s.split_once('@') else { return false };
    let Some((labels, tld)) = domain.rsplit_once('.') else { return false };
    local.split('.').all(|a| !a.is_empty() && a.bytes().all(|c| c.is_ascii_alphanumeric() || ATEXT.contains(&c)))
        && labels.split('.').all(label_ok)
        && (2..=24).contains(&tld.len())
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
}

/// The person an invite names: the name squashed (1 to 64 printable), the email lower-case.
pub fn check_person(name: Option<&Value>, email: Option<&Value>) -> Result<(String, String), Refusal> {
    let name = squash(&str_or(name));
    let email = str_or(email).trim().to_lowercase();
    if name.is_empty() || name.chars().count() > 64 || !printable(&name) {
        return Err(refuse(400, "Type the person's name (up to 64 characters)."));
    }
    if !email_ok(&email) {
        return Err(refuse(400, "Type a valid email address."));
    }
    Ok((name, email))
}

/// console.json `account_base` as browsers write an origin: `https://host` or `https://host:port` (lower case, no
/// port 443, no path); "" stays "".
pub fn check_account_base(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let bad = || "account_base must be https://host or https://host:port (no path)".to_owned();
    let rest = text.strip_prefix("https://").ok_or_else(bad)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['/', '?', '#', '@']) {
        return Err(bad());
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, Some(p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(bad)?)),
        None => (rest, None),
    };
    let host = host.to_lowercase();
    if !host.split('.').all(label_ok) {
        return Err(bad());
    }
    Ok(match port {
        Some(p) if p != 443 => format!("https://{host}:{p}"),
        _ => format!("https://{host}"),
    })
}

// ── Invite codes (LMJ1) ─────────────────────────────────────────────────────────────────────────────────────

/// A raw DEFLATE stream of stored blocks (RFC 1951 3.2.4: BFINAL, BTYPE 00, LEN, NLEN, at most 65535 bytes each).
/// Every inflater reads it; no compression crate needed.
pub fn deflate_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 5 * (data.len() / STORED_MAX + 1));
    let mut chunks = data.chunks(STORED_MAX).peekable();
    if chunks.peek().is_none() {
        return vec![0x01, 0x00, 0x00, 0xff, 0xff];
    }
    while let Some(chunk) = chunks.next() {
        let len = chunk.len() as u16;
        out.push(u8::from(chunks.peek().is_none()));
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out
}

/// `LMJ1:` + base64url (no padding) of the raw DEFLATE of the compact JSON (meet_pki.encode_code).
pub fn encode_code(doc: &Value) -> String {
    format!("{CODE_PREFIX}{}", b64u(&deflate_stored(dumps_compact(doc).as_bytes())))
}

// ── PKI: the seed request, proofs, the invite document ──────────────────────────────────────────────────────

const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
const OID_EMAIL: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01];
const OID_EXT_REQ: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e];
const OID_SAN: &[u8] = &[0x55, 0x1d, 0x11];

fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
    der(0x30, &parts.concat())
}

fn oid(o: &[u8]) -> Vec<u8> {
    der(0x06, o)
}

/// meet_pki.seed_csr: subject CN (UTF8String) and emailAddress (IA5String), each its own RDN; the RFC 822 name in
/// a non-critical subjectAltName; ecdsa-with-SHA256 by the seed key.
pub fn seed_csr(key: &Key, name: &str, email: &str) -> Result<Vec<u8>, String> {
    let (name, email) = (name.trim(), email.trim().to_lowercase());
    if name.is_empty() || !email.contains('@') {
        return Err("a participant needs a name and an email address".into());
    }
    let rdn = |o: &[u8], tag: u8, v: &str| der(0x31, &seq(&[oid(o), der(tag, v.as_bytes())]));
    let subject = seq(&[rdn(OID_CN, 0x0c, name), rdn(OID_EMAIL, 0x16, &email)]);
    let san = seq(&[oid(OID_SAN), der(0x04, &seq(&[der(0x81, email.as_bytes())]))]);
    let attrs = der(0xa0, &seq(&[oid(OID_EXT_REQ), der(0x31, &seq(&[san]))]));
    let info = seq(&[der(0x02, &[0]), subject, key.spki(), attrs]);
    Ok(crate::fleet_x509::signed_p256(&info, &key.sign(&info)?))
}

/// `"lucid-meet-proof/1|" + op + "|" + sha256_hex(subject) + "|" + ts`.
pub fn proof_bytes(op: &str, subject: &[u8], ts: i64) -> Vec<u8> {
    format!("{PROOF_PREFIX}{op}|{}|{ts}", sha256_hex(subject)).into_bytes()
}

/// (base64 DER ECDSA signature of `proof_bytes`, ts).
fn make_proof(key: &Key, op: &str, subject: &[u8], ts: i64) -> Result<(String, i64), Refusal> {
    let sig = key.sign(&proof_bytes(op, subject, ts)).map_err(|_| refuse(502, "The console's device key cannot sign."))?;
    Ok((crate::meet_json::b64(&sig), ts))
}

fn approve_subject(kind: &str, id: &str, csr_sha256: &str, decision: &str) -> Vec<u8> {
    [kind, id, &csr_sha256.to_lowercase(), decision].join("|").into_bytes()
}

fn pem(label: &str, der_bytes: &[u8]) -> String {
    let b = crate::meet_json::b64(der_bytes);
    let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
}

/// A certificate as read and as received (DER).
struct Held {
    cert: Cert,
    der: Vec<u8>,
}

fn certs_of(text: &str) -> Option<Vec<Held>> {
    crate::meet_x509::pem_blocks(text.as_bytes(), "CERTIFICATE").into_iter().map(|(_, d)| Cert::from_der(&d).map(|cert| Held { cert, der: d })).collect()
}

/// The device key from its PEM (PKCS#8 or SEC1).
fn device_key_of(pem_text: &str) -> Option<Key> {
    let blocks = crate::der::pem_blocks(pem_text, "PRIVATE KEY").into_iter().chain(crate::der::pem_blocks(pem_text, "EC PRIVATE KEY"));
    blocks.into_iter().find_map(|d| Key::from_private_der(Curve::P256, &d).ok())
}

// ── The Meet relay over mutual TLS ─────────────────────────────────────────────────────────────────────────

/// One request to the relay: (status, the answer's JSON object or {}). Tests put a fake relay here.
pub trait RelayTransport: Send + Sync {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Refusal>;
}

/// The relay at `address:port`, its certificate checked for `name` against the Meet root, the console's device
/// certificate as the client.
struct MtlsRelay {
    tls: Arc<rustls::ClientConfig>,
    address: String,
    port: u16,
    name: String,
}

fn relay_tls(cert_pem: &str, key_pem: &str, ca_pem: &str) -> Result<Arc<rustls::ClientConfig>, String> {
    let mut roots = rustls::RootCertStore::empty();
    for c in rustls_pemfile::certs(&mut ca_pem.as_bytes()) {
        roots.add(c.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).map_err(|e| e.to_string())?.ok_or("no private key")?;
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(cfg))
}

fn json_object(raw: &[u8]) -> Option<Value> {
    let v: Value = if raw.is_empty() { Value::Object(Obj::new()) } else { serde_json::from_slice(raw).ok()? };
    Some(if v.is_object() { v } else { Value::Object(Obj::new()) })
}

impl RelayTransport for MtlsRelay {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Refusal> {
        let payload = body.map(|b| dumps(b).into_bytes());
        let mut headers = vec![("Accept", "application/json".to_owned())];
        if payload.is_some() {
            headers.push(("Content-Type", "application/json".to_owned()));
        }
        let r = crate::meet_tls::https_request_via(&self.tls, &self.address, &self.name, self.port, NET_TIMEOUT, method, path, &headers, payload.as_deref(), &|_| Ok(()), RELAY_MAX);
        let r = r.map_err(|e| refuse(502, format!("The relay cannot be reached ({}).", e.unwrap_or_else(|m| m))))?;
        let data = json_object(&r.body).ok_or_else(|| refuse(502, "The relay did not answer JSON."))?;
        Ok((r.status, data))
    }
}

/// RelayClient.admin: the presence session the admin routes need (hello again on 410).
struct Relay {
    transport: Box<dyn RelayTransport>,
    session: Mutex<String>,
}

fn relay_checked(status: u16, data: Value) -> Result<Value, Refusal> {
    if status == 200 {
        return Ok(data);
    }
    let text: String = match data.get("error") {
        Some(e) if truthy(Some(e)) => crate::meet_json::py_str(e),
        _ => format!("status {status}"),
    }
    .chars()
    .take(300)
    .collect();
    Err(match status {
        400 | 404 | 409 => refuse(status, format!("The relay refused: {text}")),
        501 => refuse(503, format!("The relay says: {text}")),
        _ => refuse(502, format!("The relay refused ({status}): {text}")),
    })
}

/// urllib.parse.quote with `safe`.
fn quote(s: &str, safe: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~".contains(&b) || safe.as_bytes().contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Relay {
    fn hello(&self, warn: &dyn Fn()) -> Result<String, Refusal> {
        let mut session = self.session.lock();
        if session.is_empty() {
            let (status, data) = self.transport.call("POST", "/v1/hello", Some(&json!({})))?;
            let data = relay_checked(status, data)?;
            *session = str_or(data.get("session"));
            if session.is_empty() {
                return Err(refuse(502, "The relay did not open a session."));
            }
            if !truthy(data.get("admin")) {
                warn();
            }
        }
        Ok(session.clone())
    }

    fn admin(&self, method: &str, path: &str, body: Option<Value>, warn: &dyn Fn()) -> Result<Value, Refusal> {
        for attempt in 0..2 {
            let session = self.hello(warn)?;
            let (status, data) = if method == "GET" {
                let sep = if path.contains('?') { '&' } else { '?' };
                self.transport.call("GET", &format!("{path}{sep}session={}", quote(&session, "/")), None)?
            } else {
                let mut b = body.clone().and_then(|b| b.as_object().cloned()).unwrap_or_default();
                b.insert("session".into(), Value::from(session.clone()));
                self.transport.call("POST", path, Some(&Value::Object(b)))?
            };
            if status == 410 && attempt == 0 {
                let mut s = self.session.lock();
                if *s == session {
                    s.clear();
                }
                continue;
            }
            return relay_checked(status, data);
        }
        Err(refuse(502, "The relay keeps ending the console's session."))
    }
}

// ── TestFlight (the App Store Connect API) ──────────────────────────────────────────────────────────────────

/// One request to App Store Connect: (status, body), Err the failure's class name. Tests put a fake here.
pub trait AscTransport: Send + Sync {
    fn send(&self, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> Result<(u16, Vec<u8>), String>;
}

struct AppleHttps {
    tls: Arc<rustls::ClientConfig>,
}

impl AscTransport for AppleHttps {
    fn send(&self, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        let body = (!body.is_empty()).then_some(body);
        crate::meet_tls::https_request_via(&self.tls, ASC_HOST, ASC_HOST, 443, NET_TIMEOUT, method, path, headers, body, &|_| Ok(()), ASC_MAX).map(|r| (r.status, r.body)).map_err(|e| e.unwrap_or_else(|m| m))
    }
}

/// Adds an invitee to the external TestFlight group, so Apple emails them the TestFlight invitation. Each request
/// carries a fresh ES256 token (JOSE r||s signature) made with the sealed `.p8`.
pub struct TestFlight {
    ids: TestFlightIds,
    /// None when the sealed `.p8` is not a P-256 key (every add then says so).
    key: Option<EcdsaKeyPair>,
    transport: Box<dyn AscTransport>,
}

/// urllib.parse.urlencode of pairs (quote_plus, nothing safe).
fn urlencode(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", quote(k, " ").replace(' ', "+"), quote(v, " ").replace(' ', "+"))).collect::<Vec<_>>().join("&")
}

/// One printable line (meet_console.clean_line): controls dropped, whitespace squashed.
fn clean_line(s: &str) -> String {
    squash(&s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>())
}

impl TestFlight {
    pub fn new(ids: TestFlightIds, p8_pem: &[u8], transport: Box<dyn AscTransport>) -> TestFlight {
        let text = String::from_utf8_lossy(p8_pem);
        let key = crate::der::pem_blocks(&text, "PRIVATE KEY").into_iter().find_map(|d| EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &d).ok());
        TestFlight { ids, key, transport }
    }

    /// The API token: header `alg, kid, typ`, claims `iss, iat, exp, aud`.
    fn token(&self, now: i64) -> Result<String, Refusal> {
        let key = self.key.as_ref().ok_or_else(|| refuse(502, "The App Store Connect key (asc.p8) is not a P-256 private key."))?;
        let head = json!({ "alg": "ES256", "kid": self.ids.key_id, "typ": "JWT" });
        let claims = json!({ "iss": self.ids.issuer_id, "iat": now, "exp": now + ASC_TOKEN_TTL, "aud": ASC_AUDIENCE });
        let signing = format!("{}.{}", b64u(dumps_compact(&head).as_bytes()), b64u(dumps_compact(&claims).as_bytes()));
        let sig = key.sign(&SystemRandom::new(), signing.as_bytes()).map_err(|_| refuse(502, "The App Store Connect key cannot sign."))?;
        Ok(format!("{signing}.{}", b64u(sig.as_ref())))
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>, now: i64) -> Result<(u16, Value), Refusal> {
        let mut headers = vec![("Authorization", format!("Bearer {}", self.token(now)?)), ("Accept", "application/json".to_owned())];
        let raw = body.map(|b| dumps_compact(&b).into_bytes()).unwrap_or_default();
        if !raw.is_empty() {
            headers.push(("Content-Type", "application/json".to_owned()));
        }
        let (status, answer) = self.transport.send(method, path, &headers, &raw).map_err(|class| refuse(502, format!("App Store Connect cannot be reached ({class}).")))?;
        Ok((status, json_object(&answer).unwrap_or_else(|| Value::Object(Obj::new()))))
    }

    fn refused(what: &str, status: u16, data: &Value) -> Refusal {
        let detail = data.get("errors").and_then(Value::as_array).and_then(|e| e.first()).and_then(|e| e.get("detail")).map(|d| str_or(Some(d))).unwrap_or_default();
        let detail: String = clean_line(&detail).chars().take(300).collect();
        refuse(502, format!("App Store Connect refused {what} (HTTP {status}){}", if detail.is_empty() { ".".to_owned() } else { format!(": {detail}") }))
    }

    /// The person as an external tester in the group: "added", "exists" (Apple's 409: a tester already, then added
    /// to the group, a no-op when they are in it), or a refusal.
    pub fn add(&self, email: &str, first: &str, last: &str, now: i64) -> Result<&'static str, Refusal> {
        let group = self.ids.group_id.as_str();
        let mut person = json!({ "email": email, "firstName": first });
        if !last.is_empty() {
            person["lastName"] = Value::from(last);
        }
        let body = json!({ "data": { "type": "betaTesters", "attributes": person, "relationships": { "betaGroups": { "data": [{ "type": "betaGroups", "id": group }] } } } });
        let (status, data) = self.call("POST", "/v1/betaTesters", Some(body), now)?;
        if status == 201 {
            return Ok("added");
        }
        if status != 409 {
            return Err(TestFlight::refused("the TestFlight tester", status, &data));
        }
        let conflict = data;
        let (status, data) = self.call("GET", &format!("/v1/betaTesters?{}", urlencode(&[("filter[email]", email), ("limit", "1")])), None, now)?;
        if status != 200 {
            return Err(TestFlight::refused("the TestFlight tester lookup", status, &data));
        }
        let tester = data.get("data").and_then(Value::as_array).and_then(|d| d.first()).and_then(|t| t.get("id")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let Some(tester) = tester else { return Err(TestFlight::refused("the TestFlight tester", 409, &conflict)) };
        let (status, data) = self.call("POST", &format!("/v1/betaGroups/{group}/relationships/betaTesters"), Some(json!({ "data": [{ "type": "betaTesters", "id": tester }] })), now)?;
        if status != 204 {
            return Err(TestFlight::refused("adding the tester to the TestFlight group", status, &data));
        }
        Ok("exists")
    }
}

// ── Download links (meet_downloads' token format) ───────────────────────────────────────────────────────────

fn file_name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    (1..=128).contains(&b.len()) && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-'))
}

/// One link's token: `name` for `who` until `expires`, a fresh nonce unless given.
pub fn mint(secret: &[u8], name: &str, who: &str, expires: i64, nonce: &str) -> Option<String> {
    let who = who.trim();
    if !file_name_ok(name) || who.is_empty() || who.chars().count() > 254 || !printable(who) || nonce.len() != 16 || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let payload = dumps_compact(&json!({ "f": name, "w": who, "e": expires, "n": nonce }));
    let mac = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), payload.as_bytes());
    Some(format!("{}.{}", b64u(payload.as_bytes()), b64u(mac.as_ref())))
}

/// `<base>/d/<token>`.
fn download_link(base: &str, token: &str) -> Option<String> {
    let base = base.trim().trim_end_matches('/');
    let host = base.strip_prefix("https://")?;
    let (h, p) = host.split_once(':').unwrap_or((host, "1"));
    let ok = !h.is_empty() && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') && (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    ok.then(|| format!("{base}/d/{token}"))
}

// ── Email texts ─────────────────────────────────────────────────────────────────────────────────────────────

/// textwrap.wrap(text, 76, initial_indent=first, subsequent_indent=rest, no long-word or hyphen breaks).
fn wrapped(text: &str, first: &str, rest: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let (mut indent, mut cur, mut len) = (first, String::new(), 0usize);
    for word in text.split_whitespace() {
        let n = word.chars().count();
        let width = MAIL_WIDTH.saturating_sub(indent.chars().count());
        if len == 0 {
            cur.push_str(word);
            len = n;
        } else if len + 1 + n <= width {
            cur.push(' ');
            cur.push_str(word);
            len += 1 + n;
        } else {
            lines.push(format!("{indent}{cur}"));
            indent = rest;
            cur = word.to_owned();
            len = n;
        }
    }
    if len > 0 {
        lines.push(format!("{indent}{cur}"));
    }
    lines
}

fn wrap(text: &str) -> Vec<String> {
    wrapped(text, "", "")
}

fn first_name(name: &str) -> &str {
    name.split_whitespace().next().unwrap_or(name)
}

/// One download link of an invite.
#[derive(Clone, Debug)]
pub struct DownloadLink {
    pub platform: &'static str,
    pub label: &'static str,
    pub name: String,
    pub url: String,
    pub expires: i64,
}

fn signin_steps(base: &str, org: &str) -> Vec<String> {
    let mut lines = wrap(&format!("Open Lucid Meet, choose Sign in, enter organization {org}, your username and password."));
    lines.push(String::new());
    lines.extend(wrap("If your Lucid Meet has no Sign in button yet: sign in at the address below and paste the code it shows into Lucid Meet (Join with an invite code)."));
    lines.extend([String::new(), format!("{base}/meet/signin")]);
    lines
}

/// The email of an account invite (the Meet console's `account_invite_text`).
pub fn account_invite_text(name: &str, link: &str, expires: f64, links: &[DownloadLink], testflight: bool, base: &str, org: &str) -> String {
    let mut lines = vec![format!("Hi {},", first_name(name)), String::new()];
    lines.extend(wrap(&format!("You are invited to Lucid Meet. Open this link to accept and choose your username and password. It works once, until {}:", iso_date(expires as i64))));
    lines.extend([String::new(), link.to_owned(), String::new(), String::new(), "YOUR COMPUTER".into(), String::new()]);
    if links.is_empty() {
        lines.extend(wrap("Install Lucid Meeting Hub. Reply to this email and I send you a download link."));
    } else {
        lines.extend(wrap("Download Lucid Meeting Hub with your own link below and install it."));
        for item in links {
            lines.push(String::new());
            lines.extend(wrapped(&format!("{} ({}):", item.label, item.name), "   ", "   "));
            lines.push(item.url.clone());
        }
        let until = iso_date(links.iter().map(|x| x.expires).min().unwrap_or(0));
        lines.push(String::new());
        lines.extend(wrap(&format!("Each link works {DOWNLOAD_CAP} times, until {until}. The first click may show \"Your download is being prepared\" for a minute or two while the download server starts; that page refreshes by itself.")));
    }
    lines.extend([String::new(), String::new(), "YOUR IPHONE".into(), String::new()]);
    if testflight {
        lines.extend(wrap("Apple emails you a separate invitation to test Lucid Meet in TestFlight. Open it on your iPhone, install TestFlight if asked, then install Lucid Meet from it."));
    } else {
        lines.extend(wrap("Install Lucid Meet from TestFlight. If you do not have the TestFlight invitation from Apple yet, reply to this email."));
    }
    lines.extend([String::new(), String::new(), "SIGN IN".into(), String::new()]);
    lines.extend(signin_steps(base, org));
    lines.push(String::new());
    lines.extend(wrap("A new device may wait until an administrator approves it."));
    lines.push(String::new());
    lines.join("\n")
}

/// The email of a password reset (the Meet console's `account_reset_text`).
pub fn account_reset_text(name: &str, username: &str, link: &str, expires: f64, base: &str, org: &str) -> String {
    let mut lines = vec![format!("Hi {},", first_name(name)), String::new()];
    lines.extend(wrap(&format!("Open this link to set a new password for Lucid Meet. Your username stays {username}. The link works once, until {}:", iso_date(expires as i64))));
    lines.extend([String::new(), link.to_owned(), String::new()]);
    lines.extend(wrap("Your old password stops working once you set the new one. If you did not ask for this, reply to this email."));
    lines.extend([String::new(), String::new()]);
    lines.extend(signin_steps(base, org));
    lines.push(String::new());
    lines.join("\n")
}

// ── The state file ──────────────────────────────────────────────────────────────────────────────────────────

const TABLES: [&str; 3] = ["accounts", "account_invites", "signin_seeds"];
static EMPTY: LazyLock<Obj> = LazyLock::new(Obj::new);

fn table<'a>(d: &'a Obj, k: &str) -> &'a Obj {
    d.get(k).and_then(Value::as_object).unwrap_or(&EMPTY)
}

fn table_mut<'a>(d: &'a mut Obj, k: &str) -> &'a mut Obj {
    let slot = d.entry(k.to_owned()).or_insert_with(|| Value::Object(Obj::new()));
    if !slot.is_object() {
        *slot = Value::Object(Obj::new());
    }
    match slot {
        Value::Object(o) => o,
        _ => unreachable!("made an object above"),
    }
}

/// `del d[key]` keeping the others in order (as a Python dict does), with the value taken.
fn take(d: &mut Obj, key: &str) -> Option<Value> {
    let v = d.get(key).cloned();
    if v.is_some() {
        d.retain(|k, _| k != key);
    }
    v
}

/// Python's `(x or 0)` of a number field.
fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn approval_of(d: &Obj) -> &'static str {
    match d.get("account_approval").and_then(Value::as_str) {
        Some("auto") => "auto",
        _ => "queue",
    }
}

/// The username of the account with this email, or "".
fn account_named(d: &Obj, email: &str) -> String {
    table(d, "accounts").iter().find(|(_, a)| a.get("email").and_then(Value::as_str) == Some(email)).map(|(u, _)| u.clone()).unwrap_or_default()
}

/// `meet-accounts.json` (owner-only, written whole), one reader or writer at a time.
struct Store {
    path: PathBuf,
    mu: Mutex<()>,
}

impl Store {
    fn load(&self) -> Result<Obj, Refusal> {
        let mut d = match std::fs::read(&self.path) {
            Ok(raw) => serde_json::from_slice::<Value>(&raw).ok().and_then(|v| v.as_object().cloned()).ok_or_else(|| state_failed(format!("{STATE_FILE} does not read")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Obj::new(),
            Err(e) => return Err(state_failed(format!("{STATE_FILE} does not read: {e}"))),
        };
        for k in TABLES {
            table_mut(&mut d, k);
        }
        Ok(d)
    }

    fn read<R>(&self, f: impl FnOnce(&Obj) -> Result<R, Refusal>) -> Result<R, Refusal> {
        let _g = self.mu.lock();
        f(&self.load()?)
    }

    /// Saved only when `f` succeeds (a refusal changes nothing).
    fn edit<R>(&self, f: impl FnOnce(&mut Obj) -> Result<R, Refusal>) -> Result<R, Refusal> {
        let _g = self.mu.lock();
        let mut d = self.load()?;
        let out = f(&mut d)?;
        write_state(&self.path, &d).map_err(state_failed)?;
        Ok(out)
    }
}

fn write_state(path: &Path, d: &Obj) -> Result<(), String> {
    let text = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
    crate::store::write_private(path, format!("{text}\n").as_bytes()).map_err(|e| format!("{STATE_FILE} could not be written: {e}"))
}

// ── Rate limit ──────────────────────────────────────────────────────────────────────────────────────────────

/// At most `ACCOUNT_LIMIT` attempts per `ACCOUNT_WINDOW` seconds per source address.
#[derive(Default)]
struct Limiter {
    hits: Mutex<HashMap<String, VecDeque<f64>>>,
}

impl Limiter {
    fn hit(&self, key: &str, now: f64) -> Result<(), Refusal> {
        let mut hits = self.hits.lock();
        if hits.len() > 10_000 {
            hits.retain(|_, q| q.back().is_some_and(|t| *t > now - ACCOUNT_WINDOW));
        }
        let q = hits.entry(key.to_owned()).or_default();
        while q.front().is_some_and(|t| *t <= now - ACCOUNT_WINDOW) {
            q.pop_front();
        }
        if q.len() >= ACCOUNT_LIMIT {
            let first = q.front().copied().unwrap_or(now);
            return Err(Refusal { retry_after: Some((first + ACCOUNT_WINDOW - now) as i64 + 1), ..refuse(429, LIMIT_WORDS) });
        }
        q.push_back(now);
        Ok(())
    }
}

// ── What the service needs of the console ───────────────────────────────────────────────────────────────────

/// One audit entry the service writes itself (the public side and the approval passes; admin routes are
/// audited by the console core).
pub struct Entry<'a> {
    pub actor: &'a str,
    pub action: &'static str,
    pub target: &'a str,
    pub result: &'static str,
    pub ip: Option<&'a str>,
    pub detail: Value,
}

/// The console as the service sees it; tests put a recorder here.
pub trait Host: Send + Sync {
    fn audit(&self, e: Entry);
    fn mail_on(&self) -> bool;
    fn send_mail(&self, kind: &str, to: &str, subject: &str, body: &str) -> Result<(), String>;
    fn log(&self, event: &str, why: &str);
}

struct ConsoleHost(Weak<Console>);

impl Host for ConsoleHost {
    fn audit(&self, e: Entry) {
        let Some(c) = self.0.upgrade() else { return };
        let mut r = crate::console_audit::Record::new(e.actor, e.action, e.result);
        r.target = Some(e.target.to_owned());
        r.ip = e.ip.map(str::to_owned);
        r.detail = e.detail;
        c.record(r, crate::codec::now_ms());
    }

    fn mail_on(&self) -> bool {
        self.0.upgrade().is_some_and(|c| c.mailer.config().mode != crate::console_mail::Mode::Off)
    }

    fn send_mail(&self, kind: &str, to: &str, subject: &str, body: &str) -> Result<(), String> {
        let c = self.0.upgrade().ok_or("the console stopped")?;
        c.mailer.send_text_now(kind, to, subject, body)
    }

    fn log(&self, event: &str, why: &str) {
        if let Some(c) = self.0.upgrade() {
            c.logger.ops(event, &Fields::new().with("why", why), Level::Warn);
        }
    }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────────────────

/// What the service is built from (`attach` reads it from the console; tests make it).
#[derive(Default)]
pub struct Parts {
    pub settings: Option<AccountSettings>,
    pub relay: Option<Box<dyn RelayTransport>>,
    pub device_key: Option<Key>,
    pub testflight: Option<TestFlight>,
    pub files_secret: Option<Vec<u8>>,
}

/// One waiting request the relay lists.
#[derive(Clone, Debug)]
struct Pending {
    kind: String,
    id: String,
    principal: String,
    device_label: String,
    csr_sha256: String,
}

/// A seed made through the relay, as a v3 invite code.
struct Seed {
    code: String,
    expires: String,
    serial: String,
}

/// A public request as the browser port reads it.
pub struct PublicRequest<'a> {
    pub method: &'a str,
    /// The request target as sent (path, query, fragment).
    pub target: &'a str,
    pub peer: IpAddr,
    /// The first X-Forwarded-For header.
    pub forwarded: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub content_type: Option<&'a str>,
    pub content_length: Option<&'a str>,
    pub body: &'a [u8],
}

pub struct Accounts {
    host: Arc<dyn Host>,
    settings: Option<AccountSettings>,
    store: Store,
    /// The console's state folder: its own copy of the organization's brand (TH-1 6).
    brand_dir: PathBuf,
    limits: Limiter,
    relay: Option<Relay>,
    device_key: Option<Key>,
    root: Option<Cert>,
    testflight: Option<TestFlight>,
    files_secret: Option<Vec<u8>>,
    approve_mu: Mutex<()>,
    clock: Clock,
    runtime: Option<tokio::runtime::Handle>,
}

/// The fleet console's service: settings from console.json, secrets unsealed, the approval loop started when
/// password sign-in or auto approval is on. Never refuses the console's start: a broken piece is logged and its
/// routes answer why.
pub fn attach(console: &Arc<Console>) {
    let raw = console.inner.lock().book.settings.meet_accounts.clone();
    let settings = if raw.is_null() { None } else { AccountSettings::from_value(&raw) };
    if !raw.is_null() && settings.is_none() {
        console.logger.ops("meet.accounts.settings-unreadable", &Fields::new().with("why", "console.json settings.meetAccounts does not read"), Level::Error);
    }
    let mut parts = Parts { settings, ..Parts::default() };
    if let Some(s) = &parts.settings {
        let key_pem = console.seal_get(SECRET_DEVICE_KEY).map(|b| String::from_utf8_lossy(&b).into_owned());
        if let Some(k) = &key_pem {
            parts.device_key = device_key_of(k);
            match relay_tls(&s.relay_cert_pem, k, &s.relay_ca_pem) {
                Ok(tls) => parts.relay = Some(Box::new(MtlsRelay { tls, address: s.relay_address.clone(), port: s.relay_port, name: s.relay_name.clone() })),
                Err(e) => console.logger.ops("meet.accounts.relay-tls", &Fields::new().with("why", e), Level::Error),
            }
        }
        if let (Some(ids), Some(p8)) = (&s.testflight, console.seal_get(SECRET_ASC_KEY)) {
            match crate::meet_tls::client_config(None, None) {
                Ok(tls) => parts.testflight = Some(TestFlight::new(ids.clone(), &p8, Box::new(AppleHttps { tls }))),
                Err(e) => console.logger.ops("meet.accounts.testflight-tls", &Fields::new().with("why", e), Level::Error),
            }
        }
        parts.files_secret = console.seal_get(SECRET_FILES);
    }
    let host: Arc<dyn Host> = Arc::new(ConsoleHost(Arc::downgrade(console)));
    let clock: Clock = Arc::new(crate::meet_json::now);
    let a = Arc::new(Accounts::new(&console.cfg.state_dir, parts, host, clock, tokio::runtime::Handle::try_current().ok()));
    if let Some(s) = &a.settings {
        if s.enabled() || !s.auto_approve.is_empty() {
            a.start_loop();
            let f = Fields::new().with("base", s.account_base.as_str()).with("autoApprove", s.auto_approve.len());
            console.logger.ops("meet.accounts.on", &f, Level::Info);
        }
    }
    let _ = console.accounts.set(a);
}

impl Accounts {
    pub fn new(state_dir: &Path, parts: Parts, host: Arc<dyn Host>, clock: Clock, runtime: Option<tokio::runtime::Handle>) -> Accounts {
        let root = parts.settings.as_ref().and_then(|s| Cert::from_pem(&s.relay_ca_pem));
        Accounts {
            host,
            settings: parts.settings,
            store: Store { path: state_dir.join(STATE_FILE), mu: Mutex::new(()) },
            brand_dir: state_dir.to_path_buf(),
            limits: Limiter::default(),
            relay: parts.relay.map(|transport| Relay { transport, session: Mutex::new(String::new()) }),
            device_key: parts.device_key,
            root,
            testflight: parts.testflight,
            files_secret: parts.files_secret,
            approve_mu: Mutex::new(()),
            clock,
            runtime,
        }
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn enabled(&self) -> bool {
        self.settings.as_ref().is_some_and(AccountSettings::enabled)
    }

    fn base(&self) -> String {
        self.settings.as_ref().map(|s| s.account_base.clone()).unwrap_or_default()
    }

    fn org(&self) -> String {
        self.settings.as_ref().map(AccountSettings::org).unwrap_or_default()
    }

    /// The gate's address: the browser port lets it in for the public paths alone, inside the console's networks or
    /// not, password sign-in on or off.
    pub fn is_proxy(&self, ip: IpAddr) -> bool {
        let canonical = crate::console_source::canonical(ip);
        self.settings.as_ref().is_some_and(|s| s.account_proxy.parse::<IpAddr>().is_ok_and(|p| crate::console_source::canonical(p) == canonical))
    }

    /// What the browser port answers before the console: the public paths, and for a connection from the gate
    /// (`public_only`) a closing source refusal for everything else.
    pub fn front(self: &Arc<Self>, r: &PublicRequest, public_only: bool) -> Option<ConsoleReply> {
        self.public(r).or_else(|| {
            public_only.then(|| closing(public_json(403, &json!({ "ok": false, "code": "source", "error": crate::console::SOURCE_REFUSED }), None)))
        })
    }

    /// The address a public request comes from: the gate's X-Forwarded-For (its last address) when the connection
    /// comes from `account_proxy`, else the connection's own.
    pub fn account_source(&self, peer: IpAddr, forwarded: Option<&str>) -> String {
        let here = crate::console_source::canonical(peer).to_string();
        let proxy = self.settings.as_ref().map(|s| s.account_proxy.as_str()).unwrap_or("");
        if !proxy.is_empty() && here == proxy {
            if let Some(client) = forwarded.and_then(|f| f.rsplit(',').next()).and_then(|c| c.trim().parse::<IpAddr>().ok()) {
                return crate::console_source::canonical(client).to_string();
            }
        }
        here
    }

    fn warn_not_admin(&self) {
        self.host.log("meet.accounts.relay-not-admin", &format!("the relay does not list {} as an admin", self.console_email()));
    }

    /// The console's own Meet address (see `AccountSettings::console_email`); "" with no settings.
    fn console_email(&self) -> String {
        self.settings.as_ref().map(AccountSettings::console_email).unwrap_or_default()
    }

    fn relay_admin(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, Refusal> {
        let relay = self.relay.as_ref().ok_or_else(|| refuse(502, "The console's relay certificate cannot be read."))?;
        relay.admin(method, path, body, &|| self.warn_not_admin())
    }

    /// The relay's signed relay directory for an invite (MR-1 1.4), verified against the Meet root the invite names.
    /// None when the relay holds none, cannot be asked or holds one that does not verify: an invite never waits on it.
    fn relay_directory(&self, root_der: &[u8], now: i64) -> Option<Value> {
        let (status, answer) = self.relay.as_ref()?.transport.call("GET", "/v1/relays", None).ok()?;
        let wire = answer.get("directory").filter(|w| status == 200 && w.is_object())?;
        match crate::meet_relays::verify(wire, root_der, None, now) {
            Ok(_) => Some(wire.clone()),
            Err(code) => {
                self.host.log("meet.accounts.directory-refused", &format!("the relay's directory is not put in invites ({code})"));
                None
            }
        }
    }

    fn device_key(&self) -> Result<&Key, Refusal> {
        self.device_key.as_ref().ok_or_else(|| refuse(502, "The console's device key cannot be read."))
    }

    // ── Meet administration as the console's device ─────────────────────────────────────────────────────

    /// The relay's answer for the seed key made here: for that key, from the console's root (or a re-issue of it),
    /// chaining to it directly or through the intermediate in the answer. (cert, ca, chain).
    fn issued(&self, answer: &Value, seed_spki: &[u8]) -> Result<(Held, Held, Vec<Held>), Refusal> {
        let trusted = self.root.as_ref().ok_or_else(|| refuse(502, "The Meet root cannot be read."))?;
        let unreadable = || refuse(502, "The relay sent an invite certificate that cannot be read.");
        let cert = certs_of(&str_or(answer.get("cert_pem"))).and_then(|mut v| (!v.is_empty()).then(|| v.swap_remove(0))).ok_or_else(unreadable)?;
        let ca_pem = str_or(answer.get("ca_pem"));
        let ca_text = if ca_pem.is_empty() { self.settings.as_ref().map(|s| s.relay_ca_pem.clone()).unwrap_or_default() } else { ca_pem };
        let ca = certs_of(&ca_text).and_then(|mut v| (!v.is_empty()).then(|| v.swap_remove(0))).ok_or_else(unreadable)?;
        let mut chain = certs_of(str_or(answer.get("chain_pem")).trim()).ok_or_else(unreadable)?;
        if cert.cert.spki != seed_spki {
            return Err(refuse(502, "The relay sent an invite certificate for another key."));
        }
        if ca.cert.spki != trusted.spki || ca.cert.subject != trusted.subject {
            return Err(refuse(502, "The relay sent an invite certificate from a different Meet CA."));
        }
        if chain.iter().any(|c| c.cert.spki == cert.cert.spki) {
            return Err(refuse(502, "The relay sent a broken certificate chain."));
        }
        let certs: Vec<Cert> = chain.iter().map(|c| c.cert.clone()).collect();
        if !cert.cert.verify_chain(&certs, &ca.cert, self.now() as i64) {
            return Err(refuse(502, "The invite certificate is not signed by the Meet CA."));
        }
        if cert.cert.issued_by(&ca.cert) {
            chain.clear();
        }
        Ok((cert, ca, chain))
    }

    /// One seed through the relay and the certificate server, as a v3 invite (origin issuer).
    fn seed(&self, name: &str, email: &str, days: i64) -> Result<Seed, Refusal> {
        let s = self.settings.as_ref().ok_or_else(|| refuse(409, ACCOUNT_OFF))?;
        let device = self.device_key()?;
        let seed_key = Key::generate(Curve::P256).map_err(|e| refuse(502, e))?;
        let csr = seed_csr(&seed_key, name, email).map_err(|e| refuse(502, e))?;
        let now = self.now();
        let (proof, ts) = make_proof(device, "issue_seed", &csr, now as i64)?;
        let body = json!({ "name": name, "email": email, "days": days, "seed_csr_pem": pem("CERTIFICATE REQUEST", &csr), "proof": proof, "ts": ts });
        let answer = self.relay_admin("POST", "/v1/admin/invite", Some(body))?;
        let (cert, ca, chain) = self.issued(&answer, &seed_key.spki())?;
        let b64 = crate::meet_json::b64;
        let mut relay = json!({ "server": s.invite_server, "port": s.invite_port });
        if !s.invite_address.is_empty() && s.invite_address != s.invite_server {
            relay["address"] = Value::from(s.invite_address.as_str());
        }
        let expires = iso_utc(cert.cert.not_after);
        let mut doc = json!({
            "kind": "lucid-meet-invite", "v": 3, "name": name.trim(), "email": email.trim().to_lowercase(), "relay": relay,
            "origin": "issuer", "seed_cert": b64(&cert.der), "seed_key": b64(seed_key.pkcs8()), "ca": b64(&ca.der),
            "issued": iso_utc(now as i64), "expires": expires,
        });
        if !chain.is_empty() {
            doc["chain"] = Value::Array(chain.iter().map(|c| Value::from(b64(&c.der))).collect());
        }
        if let Some(wire) = self.relay_directory(&ca.der, now as i64) {
            doc["directory"] = wire;
        }
        Ok(Seed { code: encode_code(&doc), expires, serial: str_or(answer.get("serial")) })
    }

    fn pending(&self) -> Result<Vec<Pending>, Refusal> {
        let answer = self.relay_admin("GET", "/v1/admin/pending", None)?;
        let items = answer.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(items
            .iter()
            .filter(|r| r.get("kind").and_then(Value::as_str).is_some_and(|k| MEET_KINDS.contains(&k)))
            .map(|r| Pending {
                kind: str_or(r.get("kind")),
                id: str_or(r.get("id")),
                principal: str_or(r.get("principal")).to_lowercase(),
                device_label: if truthy(r.get("device_label")) { str_or(r.get("device_label")) } else { str_or(r.get("label")) },
                csr_sha256: str_or(r.get("csr_sha256")).to_lowercase(),
            })
            .collect())
    }

    /// Devices per person the relay lists (revoked ones and the console's own left out).
    fn device_counts(&self) -> Result<HashMap<String, usize>, Refusal> {
        let answer = self.relay_admin("GET", "/v1/admin/devices", None)?;
        let mut counts = HashMap::new();
        let console = self.console_email();
        for x in answer.get("devices").and_then(Value::as_array).into_iter().flatten() {
            if !x.is_object() || x.get("principal").and_then(Value::as_str) == Some(console.as_str()) || truthy(x.get("revoked")) {
                continue;
            }
            let who = if truthy(x.get("principal")) { str_or(x.get("principal")) } else { str_or(x.get("email")) }.to_lowercase();
            *counts.entry(who).or_insert(0) += 1;
        }
        Ok(counts)
    }

    fn approve(&self, item: &Pending, reason: &str) -> Result<(), Refusal> {
        let csr = item.csr_sha256.trim().to_lowercase();
        let id = item.id.trim();
        if !MEET_KINDS.contains(&item.kind.as_str()) || id.is_empty() || id.chars().count() > 200 {
            return Err(refuse(400, "Choose a waiting request and approve or refuse it."));
        }
        if csr.len() != 64 || !csr.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(refuse(400, "That request is missing its fingerprint; refresh and try again."));
        }
        let (proof, ts) = make_proof(self.device_key()?, "approve", &approve_subject(&item.kind, id, &csr, "approve"), self.now() as i64)?;
        let reason: String = squash(reason).chars().take(200).collect();
        let body = json!({ "kind": item.kind, "id": id, "csr_sha256": csr, "decision": "approve", "reason": reason, "proof": proof, "ts": ts });
        self.relay_admin("POST", "/v1/admin/approve", Some(body)).map(|_| ())
    }

    /// (approval mode, the sign-in seeds of the last 2 days by serial); older ones dropped from the state.
    fn signin_seeds(&self) -> Result<(&'static str, Obj), Refusal> {
        let cutoff = self.now() - SIGNIN_SEEDS_KEEP;
        let fresh = |r: &Value| r.is_object() && num(r.get("ts")) > cutoff;
        let (mode, seeds, stale) = self.store.read(|d| {
            let rows = table(d, "signin_seeds");
            let seeds: Obj = rows.iter().filter(|(_, r)| fresh(r)).map(|(k, r)| (k.clone(), r.clone())).collect();
            Ok((approval_of(d), seeds.clone(), seeds.len() != rows.len()))
        })?;
        if stale {
            self.store.edit(|d| {
                table_mut(d, "signin_seeds").retain(|_, r| fresh(r));
                Ok(())
            })?;
        }
        Ok((mode, seeds))
    }

    fn prune_seeds(&self, d: &mut Obj) {
        let cutoff = self.now() - SIGNIN_SEEDS_KEEP;
        table_mut(d, "signin_seeds").retain(|_, r| r.is_object() && num(r.get("ts")) > cutoff);
    }

    /// Approves, as an admin would, every waiting enrollment or renewal of the people in `auto_approve` (Apple's
    /// TestFlight reviewer), and, in approval mode "auto", every waiting enrollment of a seed a password sign-in made
    /// while its person has fewer than `ACCOUNT_DEVICES_MAX` devices. Audited with `by` the approver word; a refusal of
    /// one item is audited and the rest go on. The relay is not asked when nothing could be approved.
    pub fn auto_approve_once(&self) -> Result<usize, Refusal> {
        let people: Vec<String> = self.settings.as_ref().map(|s| s.auto_approve.clone()).unwrap_or_default();
        let (mode, seeds) = self.signin_seeds()?;
        let signins = if mode == "auto" { seeds } else { Obj::new() };
        if people.is_empty() && signins.is_empty() {
            return Ok(0);
        }
        let _one = self.approve_mu.lock();
        let mut done = 0;
        let mut counts: Option<HashMap<String, usize>> = None;
        for item in self.pending()? {
            let (by, reason, username) = if people.contains(&item.principal) && AUTO_APPROVE_KINDS.contains(&item.kind.as_str()) {
                (AUTO_APPROVE_BY, "approved by the console: auto_approve", String::new())
            } else if item.kind == "enroll" && signins.contains_key(&item.id) {
                if counts.is_none() {
                    counts = Some(self.device_counts()?);
                }
                if counts.as_ref().and_then(|c| c.get(&item.principal)).copied().unwrap_or(0) >= ACCOUNT_DEVICES_MAX {
                    continue;
                }
                (ACCOUNT_BY, ACCOUNT_REASON, str_or(signins.get(&item.id).and_then(|r| r.get("username"))))
            } else {
                continue;
            };
            let target = format!("{}:{}", item.kind, item.id);
            if let Err(e) = self.approve(&item, reason) {
                self.host.audit(Entry { actor: by, action: "meet.account.auto-approve", target: &target, result: "failed", ip: None, detail: json!({ "principal": item.principal, "username": username, "error": e.message }) });
                continue;
            }
            self.host.audit(Entry { actor: by, action: "meet.account.auto-approve", target: &target, result: "ok", ip: None, detail: json!({ "principal": item.principal, "device": item.device_label, "username": username }) });
            if by == ACCOUNT_BY {
                if let Some(c) = counts.as_mut() {
                    *c.entry(item.principal.clone()).or_insert(0) += 1;
                }
            }
            done += 1;
        }
        Ok(done)
    }

    /// One approval pass; never into a request, never fatal.
    fn pass(&self) {
        if let Err(e) = self.auto_approve_once() {
            self.host.log("meet.accounts.auto-approve-failed", &e.message);
        }
    }

    fn after(self: &Arc<Self>, delay: Duration) {
        let me = self.clone();
        match &self.runtime {
            Some(h) => {
                h.spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = tokio::task::spawn_blocking(move || me.pass()).await;
                });
            }
            None => {
                let _ = std::thread::Builder::new().name("meet-accounts-pass".into()).spawn(move || {
                    std::thread::sleep(delay);
                    me.pass();
                });
            }
        }
    }

    /// `auto_approve_once` every `AUTO_APPROVE_EVERY` seconds while the console lives.
    fn start_loop(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        match &self.runtime {
            Some(h) => {
                h.spawn(async move {
                    loop {
                        tokio::time::sleep(AUTO_APPROVE_EVERY).await;
                        let Some(a) = weak.upgrade() else { break };
                        let _ = tokio::task::spawn_blocking(move || a.pass()).await;
                    }
                });
            }
            None => {
                let _ = std::thread::Builder::new().name("meet-accounts-approve".into()).spawn(move || loop {
                    std::thread::sleep(AUTO_APPROVE_EVERY);
                    let Some(a) = weak.upgrade() else { break };
                    a.pass();
                });
            }
        }
    }

    // ── The public side ─────────────────────────────────────────────────────────────────────────────────

    fn invite_row(&self, d: &Obj, token: Option<&Value>) -> Result<(String, Obj), Refusal> {
        let gone = || refuse(404, "This link has expired or was already used. Ask your administrator for a new one.");
        let token = token.and_then(Value::as_str).filter(|t| t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or_else(gone)?;
        let h = sha256_hex(token.as_bytes());
        let row = table(d, "account_invites").get(&h).and_then(Value::as_object).filter(|r| num(r.get("expires")) > self.now()).ok_or_else(gone)?;
        Ok((h, row.clone()))
    }

    /// What the accept page shows: who is invited, a free username (theirs for a reset).
    pub fn join_info(&self, b: &Obj, address: &str) -> Result<Value, Refusal> {
        self.limits.hit(address, self.now())?;
        self.store.read(|d| {
            let (_, row) = self.invite_row(d, b.get("token"))?;
            let email = str_or(row.get("email"));
            let owner = if truthy(row.get("reset")) { account_named(d, &email) } else { String::new() };
            let suggestion = if owner.is_empty() { username_suggestion(&email, table(d, "accounts")) } else { owner.clone() };
            Ok(json!({ "name": row.get("name"), "email": row.get("email"), "username_suggestion": suggestion, "expires": row.get("expires"), "reset": !owner.is_empty() }))
        })
    }

    /// Accept an invite: a new account with the chosen username and password, or, for a reset, the account's new
    /// password (the username stays). The invite is used up only when this succeeds.
    pub fn join(&self, b: &Obj, address: &str) -> Result<Value, Refusal> {
        self.limits.hit(address, self.now())?;
        let (username, email) = self.store.read(|d| {
            let (_, row) = self.invite_row(d, b.get("token"))?;
            let email = str_or(row.get("email"));
            let owner = account_named(d, &email);
            if !owner.is_empty() && !truthy(row.get("reset")) {
                return Err(refuse(409, "You have an account already. Sign in, or ask your administrator to reset your password."));
            }
            let username = if owner.is_empty() { check_username(b.get("username"))? } else { owner.clone() };
            if owner.is_empty() && table(d, "accounts").contains_key(&username) {
                return Err(refuse(409, "That username is taken. Choose another one."));
            }
            Ok((username, email))
        })?;
        let password = check_password(b.get("password"), &username, &email)?;
        let pw = hash_password(&password)?;
        let now = self.now();
        let (out, email, reset) = self.store.edit(|d| {
            let (h, row) = self.invite_row(d, b.get("token"))?;
            take(table_mut(d, "account_invites"), &h);
            let email = str_or(row.get("email"));
            let owner = account_named(d, &email);
            let reset = truthy(row.get("reset"));
            let accounts = table_mut(d, "accounts");
            if !owner.is_empty() && reset && owner == username {
                if let Some(a) = accounts.get_mut(&owner).and_then(Value::as_object_mut) {
                    a.insert("pw".into(), Value::from(pw.as_str()));
                    a.insert("failures".into(), Value::from(0));
                    a.insert("locked_until".into(), Value::from(0));
                }
            } else if !owner.is_empty() || accounts.contains_key(&username) {
                return Err(refuse(409, "That username is taken. Choose another one."));
            } else {
                let by = if truthy(row.get("by")) { str_or(row.get("by")) } else { String::new() };
                accounts.insert(
                    username.clone(),
                    json!({ "username": username, "email": row.get("email"), "name": row.get("name"), "pw": pw, "created": now, "by": by, "last_signin": 0, "failures": 0, "locked_until": 0 }),
                );
            }
            let acct = accounts.get(&username).cloned().unwrap_or(Value::Null);
            Ok((json!({ "ok": true, "username": username, "name": acct.get("name"), "email": acct.get("email"), "org": self.org() }), email, reset))
        })?;
        self.host.audit(Entry { actor: &username, action: "meet.account.join", target: &email, result: "ok", ip: Some(address), detail: json!({ "reset": reset }) });
        Ok(out)
    }

    /// A password sign-in: one fresh v3 invite for the person as its `LMJ1:` code, its seed serial kept so the
    /// approval pass knows it. Every wrong username or password is the same 401; five in a row lock the account for
    /// 15 minutes (423).
    pub fn signin(self: &Arc<Self>, b: &Obj, address: &str) -> Result<Value, Refusal> {
        self.limits.hit(address, self.now())?;
        let platform = str_or(b.get("platform")).trim().to_lowercase();
        let word = match platform.as_str() {
            "computer" => "Computer",
            "iphone" => "iPhone",
            "android" => "Android",
            _ => return Err(refuse(400, "Choose Computer, iPhone or Android.")),
        };
        let label = squash(&str_or(b.get("label")));
        if label.chars().count() > ACCOUNT_LABEL_MAX || !printable(&label) {
            return Err(refuse(400, format!("The device name can have {ACCOUNT_LABEL_MAX} characters at most.")));
        }
        let who: String = str_or(b.get("username")).trim().to_lowercase().chars().take(254).collect();
        let now = self.now();
        let (key, acct) = self.store.read(|d| {
            let key = if who.is_empty() {
                String::new()
            } else if who.contains('@') {
                account_named(d, &who)
            } else if table(d, "accounts").get(&who).is_some_and(Value::is_object) {
                who.clone()
            } else {
                String::new()
            };
            let acct = (!key.is_empty()).then(|| table(d, "accounts").get(&key).cloned()).flatten();
            Ok((key, acct))
        })?;
        let email = acct.as_ref().map(|a| str_or(a.get("email"))).unwrap_or_default();
        if let Some(a) = &acct {
            let until = num(a.get("locked_until"));
            if until > now {
                let wait = (until - now) as i64 + 1;
                self.host.audit(Entry { actor: &key, action: "meet.account.signin", target: &email, result: "refused", ip: Some(address), detail: json!({ "error": "locked", "platform": platform }) });
                return Err(Refusal { retry_after: Some(wait), ..refuse(423, format!("Too many wrong passwords: this account is locked for {} minutes. Try again later.", (wait + 59) / 60)) });
            }
        }
        let stored = acct.as_ref().and_then(|a| a.get("pw")).and_then(Value::as_str).map(str::to_owned);
        let good = verify_password(b.get("password"), stored.as_deref());
        let Some(acct) = acct.filter(|_| good) else {
            self.signin_failed(&key, &platform, address)?;
            return Err(refuse(401, SIGNIN_WRONG));
        };
        let name = str_or(acct.get("name"));
        let seed = match self.seed(&name, &email, MEET_DEVICE_DAYS) {
            Ok(s) => s,
            Err(e) => {
                self.host.audit(Entry { actor: &key, action: "meet.account.signin", target: &email, result: "failed", ip: Some(address), detail: json!({ "error": e.message, "platform": platform }) });
                return Err(refuse(502, "Your password is right, but Lucid Meet cannot set up a device right now. Try again in a few minutes."));
            }
        };
        // As the relay writes a waiting enrollment's id: lower-case hex.
        let serial = u128::from_str_radix(seed.serial.trim(), 16).map(|n| format!("{n:x}")).unwrap_or_default();
        let mode = self.store.edit(|d| {
            if let Some(row) = table_mut(d, "accounts").get_mut(&key).and_then(Value::as_object_mut) {
                row.insert("failures".into(), Value::from(0));
                row.insert("locked_until".into(), Value::from(0));
                row.insert("last_signin".into(), Value::from(now));
            }
            self.prune_seeds(d);
            if !serial.is_empty() {
                let label = if label.is_empty() { word.to_owned() } else { label.clone() };
                table_mut(d, "signin_seeds").insert(serial.clone(), json!({ "username": key, "email": email, "ts": now, "platform": platform, "label": label }));
            }
            Ok(approval_of(d))
        })?;
        self.host.audit(Entry { actor: &key, action: "meet.account.signin", target: &email, result: "ok", ip: Some(address), detail: json!({ "platform": platform, "label": label, "serial": serial }) });
        if mode == "auto" {
            self.after(SIGNIN_PASS_DELAY);
        }
        Ok(json!({ "ok": true, "code": seed.code, "name": acct.get("name"), "email": acct.get("email"), "approval": mode, "expires": seed.expires }))
    }

    /// A wrong password counts against the account (`ACCOUNT_FAILURES` lock it for `ACCOUNT_LOCK` seconds); an
    /// unknown username is audited without what was typed.
    fn signin_failed(&self, key: &str, platform: &str, address: &str) -> Result<(), Refusal> {
        if key.is_empty() {
            self.host.audit(Entry { actor: "", action: "meet.account.signin", target: "", result: "refused", ip: Some(address), detail: json!({ "error": "unknown username or email", "platform": platform }) });
            return Ok(());
        }
        let now = self.now();
        let noted = self.store.edit(|d| {
            let Some(row) = table_mut(d, "accounts").get_mut(key).and_then(Value::as_object_mut) else { return Ok(None) };
            let failures = row.get("failures").and_then(Value::as_i64).unwrap_or(0) + 1;
            let locked = failures >= ACCOUNT_FAILURES;
            if locked {
                row.insert("failures".into(), Value::from(0));
                row.insert("locked_until".into(), Value::from(now + ACCOUNT_LOCK));
            } else {
                row.insert("failures".into(), Value::from(failures));
            }
            Ok(Some((str_or(row.get("email")), locked)))
        })?;
        if let Some((email, locked)) = noted {
            let error = if locked { "wrong password, locked" } else { "wrong password" };
            self.host.audit(Entry { actor: key, action: "meet.account.signin", target: &email, result: "refused", ip: Some(address), detail: json!({ "error": error, "platform": platform }) });
        }
        Ok(())
    }

    /// The public pages and API, or None when the request is not theirs (not under `/meet/`; with password sign-in
    /// off, anything but the public paths, which then answer the Meet console's closing 404). Exactly the Meet
    /// console's paths: a query string, an unknown path or another method is refused.
    pub fn public(self: &Arc<Self>, r: &PublicRequest) -> Option<ConsoleReply> {
        let (rest, fragment) = r.target.split_once('#').unwrap_or((r.target, ""));
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        if !path.starts_with("/meet/") {
            return None;
        }
        let page = PAGES.iter().find(|p| r.method == "GET" && p.0 == path);
        let route = PUBLIC_ROUTES.iter().find(|p| r.method == "POST" && **p == path);
        let brand = r.method == "GET" && (path == BRAND_READ || path == BRAND_LOGO);
        let unknown = || Some(closing(public_json(404, &json!({ "error": "Unknown path." }), None)));
        if !self.enabled() {
            return if page.is_some() || route.is_some() || brand { unknown() } else { None };
        }
        if r.method != "GET" && r.method != "POST" {
            return Some(closing(public_json(405, &json!({ "error": "Method not allowed." }), None)));
        }
        // TH-1 4: the brand the pages wear; only the logo takes a query (`?v=`, its cache key)
        if brand && fragment.is_empty() && (path == BRAND_LOGO || query.is_empty()) {
            return Some(self.brand_public(path, query));
        }
        if (page.is_none() && route.is_none()) || !query.is_empty() || !fragment.is_empty() {
            return unknown();
        }
        if let Some(&(_, bytes, ctype)) = page {
            return Some(public_reply(200, ctype, bytes.to_vec(), "no-cache", None));
        }
        Some(self.public_post(path, r))
    }

    fn public_post(self: &Arc<Self>, path: &str, r: &PublicRequest) -> ConsoleReply {
        if r.origin.is_some_and(|o| o != self.base()) {
            return closing(public_error(&refuse(403, "Refused: this request did not come from the Lucid Meet sign-in page.")));
        }
        let address = self.account_source(r.peer, r.forwarded);
        let body = match body_of(r) {
            Ok(b) => b,
            Err(e) => return closing(public_error(&e)),
        };
        let result = match path {
            "/meet/api/join/info" => self.join_info(&body, &address),
            "/meet/api/join" => self.join(&body, &address),
            _ => self.signin(&body, &address),
        };
        match result {
            Ok(v) => public_json(200, &v, None),
            Err(e) => {
                if e.state {
                    self.host.log("meet.accounts.state", &e.message);
                }
                public_error(&e)
            }
        }
    }

    // ── Admins ──────────────────────────────────────────────────────────────────────────────────────────

    /// One admin route (role, origin, size and keys checked by the console); writes answer `Done` for the core's
    /// audit (never a link or a token in it).
    pub fn admin_route(&self, spec: &RouteSpec, params: &Value, by: &str, t: i64) -> Result<Done, ApiError> {
        let b = params.as_object().cloned().unwrap_or_default();
        if spec.path == "meet/accounts/brand" || spec.path.starts_with("meet/accounts/brand/") {
            return self.brand_route(spec, &b, by, t);
        }
        let done = |(answer, target, detail): (Value, String, Value)| Done::ok(Out::ok(answer), Some(target), detail);
        match spec.path {
            "meet/accounts" => self.view().map(|v| Done::plain(Out::ok(v))),
            "meet/accounts/invite" => self.invite(&b, by).map(done),
            "meet/accounts/reset" => self.reset(&b, by).map(done),
            "meet/accounts/remove" => self.remove(&b).map(done),
            "meet/accounts/approval" => self.set_approval(&b).map(done),
            "meet/accounts/unlock" => self.unlock(&b).map(done),
            _ => Err(refuse(404, "There is no such page.")),
        }
        .map_err(Refusal::api)
    }

    /// TH-1 6: the console's own copy of the organization's brand (`meet-brand.json`, `meet-brand-logo` in its state
    /// folder), read by the account pages. Validated by the relays' rules (meet_brand.rs); `by` and `updated` are the
    /// console's. The Branding page sends the same change to each Meeting Hub relay through the proxy.
    fn brand_route(&self, spec: &RouteSpec, b: &Obj, by: &str, t: i64) -> Result<Done, ApiError> {
        use crate::meet_brand::{self as mb, CONSOLE_FILES};
        let dir = self.brand_dir.as_path();
        let current = mb::load(dir, &CONSOLE_FILES);
        if spec.method == "GET" {
            let public = mb::public(current.as_ref(), "/meet/");
            return Ok(Done::plain(Out::ok(json!({ "ok": true, "brand": current.as_ref().map(mb::to_value), "public": public["brand"] }))));
        }
        let invalid = |words: String| ApiError::with("invalid", words);
        let failed = |why: String| {
            self.host.log("meet.accounts.brand", &why);
            ApiError::of("write-failed")
        };
        if spec.action != "meet.brand.logo" {
            crate::console_auth::reason_of(b.get("reason"))?;
        }
        let saved = match spec.action {
            "meet.brand.reset" => {
                mb::remove(dir, &CONSOLE_FILES).map_err(failed)?;
                None
            }
            "meet.brand.set" => {
                let next = mb::with_fields(current.as_ref(), b, by, t).map_err(invalid)?;
                mb::save(dir, &CONSOLE_FILES, &next, None).map_err(failed)?;
                Some(next)
            }
            _ => {
                let (next, bytes) = mb::with_logo(current.as_ref(), b, by, t).map_err(invalid)?;
                mb::save(dir, &CONSOLE_FILES, &next, bytes.as_deref()).map_err(failed)?;
                Some(next)
            }
        };
        let detail = match &saved {
            Some(n) => json!({ "name": n.name, "accent": n.accent, "mode": n.mode, "logo": n.logo.as_ref().map(|l| l.sha256.clone()) }),
            None => json!({ "reset": true }),
        };
        Ok(Done::ok(Out::ok(json!({ "ok": true, "brand": saved.as_ref().map(mb::to_value) })), Some("-".to_owned()), detail))
    }

    /// TH-1 4: `GET /meet/api/brand` (no query) and `GET /meet/brand/logo[?v=]`, beside the account pages.
    fn brand_public(&self, path: &str, query: &str) -> ConsoleReply {
        use crate::meet_brand::{self as mb, Answer, CONSOLE_FILES};
        let dir = Some(self.brand_dir.as_path());
        let answer = if path == BRAND_READ { Answer::Json(mb::public(dir.and_then(|d| mb::load(d, &CONSOLE_FILES)).as_ref(), "/meet/")) } else { mb::logo_answer(dir, &CONSOLE_FILES, query) };
        match answer {
            Answer::Json(v) => public_reply(200, JSON_TYPE, dumps(&v).into_bytes(), mb::JSON_CACHE, None),
            Answer::Logo { ctype, cache, bytes } => public_reply(200, ctype, bytes, cache, None),
            Answer::NoLogo => public_json(404, &json!({ "error": mb::NO_LOGO }), None),
        }
    }

    /// The accounts, the open invites, the approval mode and what is set up.
    pub fn view(&self) -> Result<Value, Refusal> {
        let now = self.now();
        let (mut accounts, mut invites, mode) = self.store.read(|d| {
            let accounts: Vec<Value> = table(d, "accounts")
                .iter()
                .filter(|(_, a)| a.is_object())
                .map(|(u, a)| {
                    let until = num(a.get("locked_until"));
                    json!({ "username": u, "name": a.get("name").cloned().unwrap_or_else(|| Value::from("")), "email": a.get("email").cloned().unwrap_or_else(|| Value::from("")), "created": a.get("created").cloned().unwrap_or(Value::from(0)), "by": a.get("by").cloned().unwrap_or_else(|| Value::from("")), "last_signin": a.get("last_signin").cloned().unwrap_or(Value::from(0)), "locked": until > now, "locked_until": if truthy(a.get("locked_until")) { a.get("locked_until").cloned().unwrap_or(Value::from(0)) } else { Value::from(0) } })
                })
                .collect();
            let invites: Vec<Value> = table(d, "account_invites")
                .values()
                .filter(|i| i.is_object() && num(i.get("expires")) > now)
                .map(|i| json!({ "name": i.get("name").cloned().unwrap_or_else(|| Value::from("")), "email": i.get("email").cloned().unwrap_or_else(|| Value::from("")), "created": i.get("created").cloned().unwrap_or(Value::from(0)), "expires": i.get("expires").cloned().unwrap_or(Value::from(0)), "by": i.get("by").cloned().unwrap_or_else(|| Value::from("")), "reset": truthy(i.get("reset")) }))
                .collect();
            Ok((accounts, invites, approval_of(d)))
        })?;
        let text = |v: &Value, k: &str| crate::meet_json::py_str(v.get(k).unwrap_or(&Value::Null));
        accounts.sort_by(|a, b| (text(a, "name").to_lowercase(), text(a, "username")).cmp(&(text(b, "name").to_lowercase(), text(b, "username"))));
        invites.sort_by(|a, b| num(a.get("created")).total_cmp(&num(b.get("created"))));
        let s = self.settings.clone().unwrap_or_default();
        Ok(json!({
            "ok": true, "enabled": s.enabled(), "base": s.account_base, "org": if s.enabled() { s.org() } else { String::new() },
            "approval": mode, "accounts": accounts, "invites": invites,
            "relay": { "configured": self.relay.is_some() && self.device_key.is_some() && self.root.is_some(), "name": s.relay_name },
            "testflight": { "on": self.testflight.is_some() }, "autoApprove": s.auto_approve,
        }))
    }

    /// A one-time token (32 random bytes; only its SHA-256 is kept), 7 days; it voids every older one for the same
    /// email and every ended one. (token, expires)
    fn new_invite(&self, d: &mut Obj, name: &str, email: &str, by: &str, reset: bool) -> (String, f64) {
        let token = crate::meet_json::token_urlsafe(32);
        let now = self.now();
        let invites = table_mut(d, "account_invites");
        invites.retain(|_, i| i.is_object() && num(i.get("expires")) > now && i.get("email").and_then(Value::as_str) != Some(email));
        invites.insert(sha256_hex(token.as_bytes()), json!({ "name": name, "email": email, "created": now, "expires": now + INVITE_TTL, "by": by, "reset": reset }));
        (token, now + INVITE_TTL)
    }

    /// {mail: sent | failed | unset, email_error}.
    fn mail_out(&self, kind: &str, to: &str, subject: &str, text: &str) -> (&'static str, String) {
        if !self.host.mail_on() {
            return ("unset", String::new());
        }
        match self.host.send_mail(kind, to, subject, text) {
            Ok(()) => ("sent", String::new()),
            Err(why) => ("failed", format!("The email could not be sent: {why}")),
        }
    }

    /// The invitee as an external TestFlight tester; never refuses (the invite is made already).
    fn testflight_add(&self, name: &str, email: &str, by: &str) -> (&'static str, String) {
        let Some(tf) = &self.testflight else { return ("off", String::new()) };
        let words: Vec<&str> = name.split_whitespace().collect();
        let (first, last) = match words.split_first() {
            Some((f, rest)) => ((*f).to_owned(), rest.join(" ")),
            None => (name.to_owned(), String::new()),
        };
        match tf.add(email, &first, &last, self.now() as i64) {
            Ok(status) => {
                self.host.audit(Entry { actor: by, action: "meet.account.testflight", target: email, result: "ok", ip: None, detail: json!({ "status": status }) });
                (status, String::new())
            }
            Err(e) => {
                self.host.log("meet.accounts.testflight-failed", &e.message);
                self.host.audit(Entry { actor: by, action: "meet.account.testflight", target: email, result: "failed", ip: None, detail: json!({ "error": e.message }) });
                ("failed", e.message)
            }
        }
    }

    /// The person's own links to the Windows and Mac installers of the relay's release (`DOWNLOAD_DAYS`), or none and
    /// why. Never logged or audited (a link is its token).
    fn download_links(&self, email: &str) -> (Vec<DownloadLink>, String) {
        let Some(secret) = &self.files_secret else { return (Vec::new(), "No download links: the console has no link secret.".into()) };
        let base = self.settings.as_ref().map(|s| s.files_base.clone()).unwrap_or_default();
        if base.is_empty() {
            return (Vec::new(), "No download links: the console has no download address (files_base).".into());
        }
        let release = match self.relay_admin("GET", "/v1/version", None) {
            Ok(r) => r,
            Err(e) => return (Vec::new(), format!("No download links: the relay could not be asked. {}", e.message)),
        };
        let files = release.get("files").and_then(Value::as_object).cloned().unwrap_or_default();
        let expires = self.now() as i64 + DOWNLOAD_DAYS * 86400;
        let mut links = Vec::new();
        for (platform, label) in DOWNLOAD_PLATFORMS {
            let name = files.get(platform).filter(|e| e.is_object()).map(|e| str_or(e.get("name"))).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let url = mint(secret, &name, email, expires, &crate::meet_json::token_hex(8)).and_then(|t| download_link(&base, &t));
            if let Some(url) = url {
                links.push(DownloadLink { platform, label, name, url, expires });
            }
        }
        if links.is_empty() {
            return (Vec::new(), "No download links: the relay's release names no Windows or Mac installer.".into());
        }
        (links, String::new())
    }

    /// An account invite: the accept link, the person added to TestFlight, their download links and the email (sent
    /// with the gateway; otherwise `mail` "unset" and the page shows the text to send by hand). The link is in the
    /// answer once, never in the audit.
    pub fn invite(&self, b: &Obj, by: &str) -> Result<(Value, String, Value), Refusal> {
        if !self.enabled() {
            return Err(refuse(409, ACCOUNT_OFF));
        }
        let (name, email) = check_person(b.get("name"), b.get("email"))?;
        if email == self.console_email() {
            return Err(refuse(400, "That address is the console itself."));
        }
        let (token, expires) = self.store.edit(|d| {
            let owner = account_named(d, &email);
            if !owner.is_empty() {
                return Err(refuse(409, format!("{email} has a Lucid Meet account already ({owner}). Use Reset password under Accounts if they forgot it.")));
            }
            Ok(self.new_invite(d, &name, &email, by, false))
        })?;
        let (base, org) = (self.base(), self.org());
        let link = format!("{base}/meet/join#t={token}");
        let (tf_status, tf_error) = self.testflight_add(&name, &email, by);
        let (links, note) = self.download_links(&email);
        let text = account_invite_text(&name, &link, expires, &links, matches!(tf_status, "added" | "exists"), &base, &org);
        let (mail, email_error) = self.mail_out("meet.account.invite", &email, ACCOUNT_INVITE_SUBJECT, &text);
        let answer = json!({
            "ok": true, "kind": "account", "name": name, "email": email, "days": MEET_DEVICE_DAYS, "expires": expires, "link": link, "org": org,
            "testflight": { "status": tf_status, "message": tf_error, "error": tf_error },
            "links": links.iter().map(|x| json!({ "platform": x.platform, "label": x.label, "name": x.name, "url": x.url, "expires": x.expires })).collect::<Vec<_>>(),
            "links_note": note,
            "email_draft": { "to": email, "subject": ACCOUNT_INVITE_SUBJECT, "body": text },
            "mail": mail, "emailed": mail == "sent", "email_error": email_error,
        });
        let detail = json!({ "mail": mail, "testflight": tf_status, "links": links.len() });
        Ok((answer, email, detail))
    }

    /// Email the person a link to set a new password; the username stays and the old password works until then.
    pub fn reset(&self, b: &Obj, by: &str) -> Result<(Value, String, Value), Refusal> {
        if !self.enabled() {
            return Err(refuse(409, ACCOUNT_OFF));
        }
        let username = str_or(b.get("username")).trim().to_lowercase();
        let (name, email, token, expires) = self.store.edit(|d| {
            let acct = table(d, "accounts").get(&username).filter(|a| a.is_object()).cloned().ok_or_else(|| refuse(404, "No such account."))?;
            let name = if truthy(acct.get("name")) { str_or(acct.get("name")) } else { username.clone() };
            let email = str_or(acct.get("email"));
            let (token, expires) = self.new_invite(d, &name, &email, by, true);
            Ok((name, email, token, expires))
        })?;
        let (base, org) = (self.base(), self.org());
        let link = format!("{base}/meet/join#t={token}");
        let text = account_reset_text(&name, &username, &link, expires, &base, &org);
        let (mail, email_error) = self.mail_out("meet.account.reset", &email, ACCOUNT_RESET_SUBJECT, &text);
        let answer = json!({
            "ok": true, "username": username, "name": name, "email": email, "expires": expires, "link": link,
            "email_draft": { "to": email, "subject": ACCOUNT_RESET_SUBJECT, "body": text },
            "mail": mail, "emailed": mail == "sent", "email_error": email_error,
        });
        Ok((answer, username, json!({ "email": email, "mail": mail })))
    }

    /// Delete the account and its open invites; devices it set up stay until revoked.
    pub fn remove(&self, b: &Obj) -> Result<(Value, String, Value), Refusal> {
        let username = str_or(b.get("username")).trim().to_lowercase();
        let email = self.store.edit(|d| {
            let acct = take(table_mut(d, "accounts"), &username).filter(Value::is_object).ok_or_else(|| refuse(404, "No such account."))?;
            let email = acct.get("email").cloned().unwrap_or(Value::Null);
            table_mut(d, "account_invites").retain(|_, i| !(i.is_object() && i.get("email") == Some(&email)));
            Ok(str_or(Some(&email)))
        })?;
        Ok((json!({ "ok": true }), username, json!({ "email": email })))
    }

    pub fn set_approval(&self, b: &Obj) -> Result<(Value, String, Value), Refusal> {
        let mode = str_or(b.get("mode")).trim().to_lowercase();
        if mode != "auto" && mode != "queue" {
            return Err(refuse(400, "The approval mode must be auto or queue."));
        }
        self.store.edit(|d| {
            d.insert("account_approval".into(), Value::from(mode.as_str()));
            Ok(())
        })?;
        Ok((json!({ "ok": true, "approval": mode }), mode.clone(), Value::Null))
    }

    /// Clear an account's failed sign-ins and lock.
    pub fn unlock(&self, b: &Obj) -> Result<(Value, String, Value), Refusal> {
        let username = str_or(b.get("username")).trim().to_lowercase();
        let was = self.store.edit(|d| {
            let row = table_mut(d, "accounts").get_mut(&username).and_then(Value::as_object_mut).ok_or_else(|| refuse(404, "No such account."))?;
            let was = num(row.get("locked_until"));
            row.insert("failures".into(), Value::from(0));
            row.insert("locked_until".into(), Value::from(0));
            Ok(was)
        })?;
        Ok((json!({ "ok": true }), username, json!({ "wasLocked": was > self.now() })))
    }
}

// ── Public answers ──────────────────────────────────────────────────────────────────────────────────────────

fn public_reply(status: u16, content_type: &'static str, body: Vec<u8>, cache: &str, extra: Option<(&'static str, String)>) -> ConsoleReply {
    let mut headers: Vec<(&'static str, String)> = PUBLIC_HEADERS.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
    headers.push(("Cache-Control", cache.to_owned()));
    headers.extend(extra);
    ConsoleReply { status, content_type, body, headers, close: false }
}

/// json.dumps of the answer, `no-store`.
fn public_json(status: u16, v: &Value, extra: Option<(&'static str, String)>) -> ConsoleReply {
    public_reply(status, JSON_TYPE, dumps(v).into_bytes(), "no-store", extra)
}

fn closing(mut r: ConsoleReply) -> ConsoleReply {
    r.close = true;
    r
}

/// `{"error": ...}`; a 423 or 429 with Retry-After (and a 423's `retry_after`); a state failure as the Meet
/// console's own 500.
fn public_error(e: &Refusal) -> ConsoleReply {
    if e.state {
        return public_json(500, &json!({ "error": "Lucid Meet sign-in is not available right now." }), None);
    }
    let mut payload = json!({ "error": e.message });
    let mut extra = None;
    if e.status == 423 || e.status == 429 {
        let wait = e.retry_after.unwrap_or(ACCOUNT_WINDOW as i64);
        extra = Some(("Retry-After", wait.to_string()));
        if e.status == 423 {
            payload["retry_after"] = Value::from(wait);
        }
    }
    public_json(e.status, &payload, extra)
}

/// JSON of at most `ACCOUNT_BODY_MAX` bytes holding an object (the Meet console's `_body`).
fn body_of(r: &PublicRequest) -> Result<Obj, Refusal> {
    if !r.content_type.unwrap_or("").starts_with("application/json") {
        return Err(refuse(415, "Send JSON."));
    }
    let length: i64 = match r.content_length.map(str::trim).filter(|s| !s.is_empty()) {
        None => 0,
        Some(s) => s.parse().map_err(|_| refuse(400, "Bad Content-Length."))?,
    };
    if !(0..=ACCOUNT_BODY_MAX).contains(&length) {
        return Err(refuse(413, "Request too large."));
    }
    let raw = r.body.get(..length as usize).unwrap_or(r.body);
    let v: Value = if raw.is_empty() { Value::Object(Obj::new()) } else { serde_json::from_slice(raw).map_err(|_| refuse(400, "The body must be JSON."))? };
    v.as_object().cloned().ok_or_else(|| refuse(400, "The body must be a JSON object."))
}

// ── Moving from the Meet console (`lucid-relay console meet-accounts`) ───────────────────────────────────────

const CLI_USAGE: &str = "usage: lucid-relay console meet-accounts import --state-dir <console state dir> --old-state <state.json> --old-config <console.json> --relay-cert <pem> --relay-key <pem> --relay-ca <pem> [--asc-key <p8>] [--files-secret <file>] [--replace] | status --state-dir <dir>  (with the console stopped)";

/// Where sealed values go (the console's `Seal`; tests use a map).
pub trait SecretSink {
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String>;
}

impl SecretSink for crate::console_seal::Seal {
    fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
        crate::console_seal::Seal::put(self, name, value)
    }
}

/// The files `import` reads.
pub struct ImportFiles {
    pub old_state: PathBuf,
    pub old_config: PathBuf,
    pub relay_cert: PathBuf,
    pub relay_key: PathBuf,
    pub relay_ca: PathBuf,
    pub asc_key: Option<PathBuf>,
    pub files_secret: Option<PathBuf>,
    pub replace: bool,
}

fn read_text(p: &Path) -> Result<String, String> {
    std::fs::read_to_string(p).map_err(|e| format!("cannot read {}: {e}", p.display()))
}

fn uuid_ok(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn port_of(v: Option<&Value>, default: u16, what: &str) -> Result<u16, String> {
    match v {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).ok_or_else(|| format!("{what} must be 1 to 65535")),
        Some(Value::String(s)) => s.trim().parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("{what} must be 1 to 65535")),
        Some(_) => Err(format!("{what} must be 1 to 65535")),
    }
}

/// The Meet console's console.json as this service's settings (its defaults where a key is missing).
pub fn settings_of_old(cfg: &Obj, cert_pem: String, ca_pem: String) -> Result<AccountSettings, String> {
    let text = |k: &str, default: &str| -> String {
        match cfg.get(k) {
            None | Some(Value::Null) => default.to_owned(),
            Some(v) => str_or(Some(v)).trim().to_owned(),
        }
    };
    let proxy = text("account_proxy", "");
    let proxy = if proxy.is_empty() { proxy } else { proxy.parse::<IpAddr>().map_err(|_| "account_proxy must be an IP address (the download gate's)".to_owned())?.to_string() };
    let people = match cfg.get("auto_approve") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(|p| str_or(Some(p)).trim().to_lowercase()).collect(),
        Some(_) => return Err("auto_approve must list email addresses".into()),
    };
    let relay_name = text("relay_name", "");
    let console_email = if relay_name.is_empty() { String::new() } else { format!("console@{}", relay_name.to_lowercase()) };
    if people.len() > AUTO_APPROVE_MAX || people.iter().any(|p| !address_ok(p) || *p == console_email) {
        return Err(format!("auto_approve must list at most {AUTO_APPROVE_MAX} email addresses (not the console's own)"));
    }
    let testflight = match cfg.get("testflight") {
        None | Some(Value::Null) => None,
        Some(Value::Object(t)) if t.is_empty() => None,
        Some(Value::Object(t)) => {
            if let Some(k) = t.keys().find(|k| !["key_id", "issuer_id", "group_id", "key_file"].contains(&k.as_str())) {
                return Err(format!("unknown testflight settings: {k}"));
            }
            let f = |k: &str| str_or(t.get(k)).trim().to_owned();
            let ids = TestFlightIds { key_id: f("key_id"), issuer_id: f("issuer_id"), group_id: f("group_id") };
            if ids.key_id.len() != 10 || !ids.key_id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
                return Err("testflight key_id must be the API key's 10 letters and digits".into());
            }
            if !uuid_ok(&ids.issuer_id) || !uuid_ok(&ids.group_id) {
                return Err("testflight issuer_id and group_id must be UUIDs".into());
            }
            Some(ids)
        }
        Some(_) => return Err("testflight must be an object with key_id, issuer_id and group_id".into()),
    };
    let files_base = text("files_base", "").trim_end_matches('/').to_owned();
    if !files_base.is_empty() && download_link(&files_base, "x").is_none() {
        return Err("files_base must be https://host or https://host:port".into());
    }
    let s = AccountSettings {
        account_base: check_account_base(&text("account_base", ""))?,
        account_proxy: proxy,
        relay_address: text("relay_address", ""),
        relay_port: port_of(cfg.get("relay_port"), 443, "relay_port")?,
        relay_name,
        relay_cert_pem: cert_pem,
        relay_ca_pem: ca_pem,
        invite_server: text("invite_server", ""),
        invite_port: port_of(cfg.get("invite_port"), 443, "invite_port")?,
        invite_address: text("invite_address", ""),
        auto_approve: people,
        testflight,
        files_base,
    };
    // Password sign-in and auto approval talk to the relay; invites also name it. No lab fallback: say what is missing.
    if s.enabled() || !s.auto_approve.is_empty() {
        let what = if s.enabled() { "Meet accounts (account_base)" } else { "auto approval (auto_approve)" };
        for (key, value, means) in [("relay_name", &s.relay_name, "the Meet relay's name"), ("relay_address", &s.relay_address, "the Meet relay's address")] {
            if value.is_empty() {
                return Err(format!("{what} cannot be turned on: console.json has no {key}. Set it to {means}."));
            }
        }
    }
    if s.enabled() && s.invite_server.is_empty() {
        return Err("Meet accounts (account_base) cannot be turned on: console.json has no invite_server. Set invite_server to the relay name the apps connect to.".into());
    }
    Ok(s)
}

/// The account keys of the Meet console's state.json.
pub fn state_of_old(old: &Obj) -> Result<Obj, String> {
    let mut d = Obj::new();
    for k in TABLES {
        match old.get(k) {
            None | Some(Value::Null) => {
                d.insert(k.into(), Value::Object(Obj::new()));
            }
            Some(Value::Object(o)) => {
                if let Some((name, _)) = o.iter().find(|(_, r)| !r.is_object()) {
                    return Err(format!("state.json {k} holds {name}, which is not an object"));
                }
                d.insert(k.into(), Value::Object(o.clone()));
            }
            Some(_) => return Err(format!("state.json {k} is not an object")),
        }
    }
    if let Some(name) = table(&d, "accounts").keys().find(|u| !username_ok(u)) {
        return Err(format!("state.json accounts holds {name}, which is not a username"));
    }
    d.insert("account_approval".into(), Value::from(approval_of(old)));
    Ok(d)
}

/// The import itself: everything read and checked first, then the secrets sealed, `meet-accounts.json` written and
/// the settings and the audit note put in `book` (the caller saves it). The summary names no secret.
pub fn import_into(state_dir: &Path, files: &ImportFiles, book: &mut crate::console_auth::Book, sink: &mut dyn SecretSink, t_ms: i64) -> Result<String, String> {
    let parse = |p: &Path| -> Result<Obj, String> { serde_json::from_str::<Value>(&read_text(p)?).ok().and_then(|v| v.as_object().cloned()).ok_or_else(|| format!("{} is not a JSON object", p.display())) };
    let cfg = parse(&files.old_config)?;
    let old = parse(&files.old_state)?;
    let cert_pem = read_text(&files.relay_cert)?;
    let key_pem = read_text(&files.relay_key)?;
    let ca_pem = read_text(&files.relay_ca)?;
    let cert = Cert::from_pem(&cert_pem).ok_or("the relay certificate (--relay-cert) does not read")?;
    let key = device_key_of(&key_pem).ok_or("the relay key (--relay-key) is not a P-256 private key")?;
    if key.spki() != cert.spki {
        return Err("the relay key does not belong to the relay certificate".into());
    }
    if Cert::from_pem(&ca_pem).is_none() {
        return Err("the Meet root (--relay-ca) does not read".into());
    }
    relay_tls(&cert_pem, &key_pem, &ca_pem).map_err(|e| format!("the relay certificate, key and root do not make a TLS client: {e}"))?;
    let settings = settings_of_old(&cfg, cert_pem, ca_pem)?;
    let asc = match (&settings.testflight, &files.asc_key) {
        (Some(ids), Some(p)) => {
            let raw = std::fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
            struct Never;
            impl AscTransport for Never {
                fn send(&self, _: &str, _: &str, _: &[(&str, String)], _: &[u8]) -> Result<(u16, Vec<u8>), String> {
                    Err("unused".into())
                }
            }
            TestFlight::new(ids.clone(), &raw, Box::new(Never)).key.ok_or("the App Store Connect key (--asc-key) is not a P-256 private key")?;
            Some(raw)
        }
        (Some(_), None) => return Err("console.json turns TestFlight on: give --asc-key <the .p8>".into()),
        (None, Some(_)) => return Err("--asc-key needs testflight in console.json".into()),
        (None, None) => None,
    };
    let files_secret = match &files.files_secret {
        Some(p) => {
            let text = read_text(p)?;
            let s = crate::meet_json::b64_strict(&text.trim().replace('-', "+").replace('_', "/")).filter(|s| s.len() >= 32).ok_or_else(|| format!("{} does not hold at least 32 bytes of base64", p.display()))?;
            Some(s)
        }
        None => None,
    };
    let state = state_of_old(&old)?;
    let path = state_dir.join(STATE_FILE);
    // Any file there (unreadable or not even a file) is someone's state: only --replace goes over it.
    match std::fs::symlink_metadata(&path) {
        Ok(_) if !files.replace => return Err(format!("{} already exists; add --replace to import over it", path.display())),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot check {}: {e}", path.display())),
    }
    sink.put(SECRET_DEVICE_KEY, key_pem.as_bytes())?;
    if let Some(raw) = &asc {
        sink.put(SECRET_ASC_KEY, raw)?;
    }
    if let Some(s) = &files_secret {
        sink.put(SECRET_FILES, s)?;
    }
    write_state(&path, &state)?;
    let counts = (table(&state, "accounts").len(), table(&state, "account_invites").len(), table(&state, "signin_seeds").len());
    let mode = approval_of(&state);
    book.settings.meet_accounts = settings.to_value();
    book.pending_audit.push(json!({ "ts": t_ms, "actor": "operator", "action": "meet.account.import", "target": "-", "detail": { "accounts": counts.0, "invites": counts.1, "seeds": counts.2, "approval": mode } }));
    let mut out = vec![format!("lucid-relay: imported {} accounts, {} invites and {} sign-in seeds; approval {mode}", counts.0, counts.1, counts.2)];
    out.extend(summary_lines(&settings, asc.is_some(), files_secret.is_some()));
    out.push("Start the console again (lucid-relay console serve); the import is audited at its start.".into());
    Ok(out.join("\n"))
}

fn summary_lines(s: &AccountSettings, asc: bool, files: bool) -> Vec<String> {
    vec![
        if s.enabled() { format!("password sign-in: on at {} (organization {}), proxy {}", s.account_base, s.org(), if s.account_proxy.is_empty() { "none" } else { s.account_proxy.as_str() }) } else { "password sign-in: off (no account_base)".into() },
        format!("relay: {} at {}:{}; invites name {}:{}{}", s.relay_name, s.relay_address, s.relay_port, s.invite_server, s.invite_port, if s.invite_address.is_empty() { String::new() } else { format!(" via {}", s.invite_address) }),
        format!("auto approve: {}", if s.auto_approve.is_empty() { "nobody".into() } else { s.auto_approve.join(", ") }),
        format!("TestFlight: {}", if s.testflight.is_some() && asc { "on" } else { "off" }),
        format!(
            "download links: {}",
            if !files { "off (no link secret)".into() } else if s.files_base.is_empty() { "off (no files_base)".into() } else { format!("on ({})", s.files_base) }
        ),
    ]
}

/// `lucid-relay console meet-accounts import|status ...`.
pub fn cli(args: &[String]) -> Result<String, String> {
    let mut named: HashMap<&str, String> = HashMap::new();
    let mut replace = false;
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        i += 1;
        if a == "--replace" {
            replace = true;
            continue;
        }
        let known = ["state-dir", "old-state", "old-config", "relay-cert", "relay-key", "relay-ca", "asc-key", "files-secret"];
        match a.strip_prefix("--").and_then(|n| known.iter().copied().find(|k| n == *k || n.starts_with(&format!("{k}=")))) {
            Some(k) => {
                let v = match a.split_once('=') {
                    Some((_, v)) => v.to_owned(),
                    None => {
                        i += 1;
                        args.get(i - 1).cloned().ok_or(CLI_USAGE)?
                    }
                };
                named.insert(k, v);
            }
            None => rest.push(a),
        }
    }
    let dir = PathBuf::from(named.get("state-dir").ok_or(CLI_USAGE)?);
    let file = dir.join(crate::console::CONSOLE_FILE);
    match rest.as_slice() {
        ["import"] => {
            let need = |k: &str| named.get(k).map(PathBuf::from).ok_or_else(|| format!("import needs --{k}\n{CLI_USAGE}"));
            let files = ImportFiles {
                old_state: need("old-state")?,
                old_config: need("old-config")?,
                relay_cert: need("relay-cert")?,
                relay_key: need("relay-key")?,
                relay_ca: need("relay-ca")?,
                asc_key: named.get("asc-key").map(PathBuf::from),
                files_secret: named.get("files-secret").map(PathBuf::from),
                replace,
            };
            let _lock = crate::console_auth::lock_state(&dir)?;
            if !file.exists() {
                return Err(format!("{} has no console yet: start lucid-relay console serve there once first", dir.display()));
            }
            let t = crate::codec::now_ms();
            let mut book = crate::console_auth::Book::read(&file, t)?;
            let env = |k: &str| std::env::var(k).ok();
            let mut seal = crate::console_seal::Seal::open_as(&dir, &env, book.settings.high(), crate::console_seal::SealIdentity::Console)?;
            if let Some(why) = seal.refused() {
                return Err(format!("the sealed store cannot be used here: {why}; run lucid-relay console seal-setup --role console first"));
            }
            let done = import_into(&dir, &files, &mut book, &mut seal, t)?;
            book.save(&file)?;
            Ok(done)
        }
        ["status"] => status(&dir),
        _ => Err(CLI_USAGE.into()),
    }
}

/// What is imported, without opening the sealed store (names only).
fn status(dir: &Path) -> Result<String, String> {
    let book = crate::console_auth::Book::read(&dir.join(crate::console::CONSOLE_FILE), crate::codec::now_ms())?;
    let raw = &book.settings.meet_accounts;
    if raw.is_null() {
        return Ok("lucid-relay: no Meet accounts imported (lucid-relay console meet-accounts import)".into());
    }
    let s = AccountSettings::from_value(raw).ok_or("console.json settings.meetAccounts does not read")?;
    let d = Store { path: dir.join(STATE_FILE), mu: Mutex::new(()) }.load().map_err(|e| e.message)?;
    let sealed: Vec<String> = std::fs::read(dir.join(crate::console_seal::SECRETS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("secrets").and_then(Value::as_object).map(|o| o.keys().cloned().collect()))
        .unwrap_or_default();
    let has = |n: &str| sealed.iter().any(|x| x == n);
    let now = crate::meet_json::now();
    let locked = table(&d, "accounts").values().filter(|a| num(a.get("locked_until")) > now).count();
    let open = table(&d, "account_invites").values().filter(|i| num(i.get("expires")) > now).count();
    let mut out = vec![format!("lucid-relay: {} accounts ({locked} locked), {open} open invites, {} sign-in seeds; approval {}", table(&d, "accounts").len(), table(&d, "signin_seeds").len(), approval_of(&d))];
    out.extend(summary_lines(&s, has(SECRET_ASC_KEY), has(SECRET_FILES)));
    out.push(format!("device key sealed: {}", if has(SECRET_DEVICE_KEY) { "yes" } else { "no" }));
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::unb64u;
    use crate::fleet_x509::{meet_issue, meet_test_ca, verify_p256, MeetProfile, MeetSpec};
    use crate::meet_x509::der_to_pem;

    const DAY: f64 = 86400.0;

    // ── Fakes ───────────────────────────────────────────────────────────────────────────────────────────

    #[derive(Default)]
    struct Recorder {
        audits: Mutex<Vec<(String, String, String, String, Value)>>,
        mails: Mutex<Vec<(String, String, String)>>,
        mail_on: bool,
    }

    impl Host for Recorder {
        fn audit(&self, e: Entry) {
            self.audits.lock().push((e.actor.to_owned(), e.action.to_owned(), e.target.to_owned(), e.result.to_owned(), e.detail));
        }
        fn mail_on(&self) -> bool {
            self.mail_on
        }
        fn send_mail(&self, _kind: &str, to: &str, subject: &str, body: &str) -> Result<(), String> {
            self.mails.lock().push((to.to_owned(), subject.to_owned(), body.to_owned()));
            Ok(())
        }
        fn log(&self, _event: &str, _why: &str) {}
    }

    /// The Meet relay's admin routes: a CA that signs seeds, waiting requests and devices to list, approvals noted.
    struct FakeRelay {
        ca_key: Key,
        ca_der: Vec<u8>,
        device_spki: Vec<u8>,
        pending: Mutex<Vec<Value>>,
        devices: Mutex<Vec<Value>>,
        approved: Mutex<Vec<Value>>,
        calls: Mutex<Vec<String>>,
        down: Mutex<bool>,
        /// What `GET /v1/relays` answers: (status, directory wire or null).
        relays: Mutex<(u16, Value)>,
    }

    struct Shared(Arc<FakeRelay>);

    impl RelayTransport for Shared {
        fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Refusal> {
            let f = &self.0;
            f.calls.lock().push(format!("{method} {path}"));
            if *f.down.lock() {
                return Err(refuse(502, "The relay cannot be reached (ConnectionRefusedError)."));
            }
            let b = body.cloned().unwrap_or(Value::Null);
            let route = path.split('?').next().unwrap_or("");
            if route == "/v1/relays" {
                let (status, wire) = f.relays.lock().clone();
                return Ok((status, json!({ "ok": status == 200, "directory": wire })));
            }
            if route != "/v1/hello" {
                let session = if method == "GET" { path.split("session=").nth(1).map(str::to_owned) } else { b.get("session").and_then(Value::as_str).map(str::to_owned) };
                assert_eq!(session.as_deref(), Some("s1"), "every admin call carries the session");
            }
            Ok(match route {
                "/v1/hello" => (200, json!({ "session": "s1", "admin": true })),
                "/v1/admin/invite" => {
                    let csr_pem = b["seed_csr_pem"].as_str().unwrap();
                    let csr_der = crate::der::pem_blocks(csr_pem, "CERTIFICATE REQUEST").remove(0);
                    let ts = b["ts"].as_i64().unwrap();
                    let proof = crate::meet_json::b64_strict(b["proof"].as_str().unwrap()).unwrap();
                    assert!(verify_p256(&f.device_spki, &proof_bytes("issue_seed", &csr_der, ts), &proof), "the proof is the device's");
                    let csr = crate::meet_x509::Csr::from_der(&csr_der).unwrap();
                    assert!(csr.signature_valid());
                    assert_eq!(csr.names.emails, vec![b["email"].as_str().unwrap().to_owned()]);
                    let now = crate::codec::now_ms();
                    let spec = MeetSpec { profile: &MeetProfile::SignerClient, serial: &[0x0a, 0x1b], not_before_ms: now - 60_000, not_after_ms: now + 30 * 86_400_000, spki: &csr.spki, ca_der: &f.ca_der };
                    let cert = meet_issue(&spec, &f.ca_key).unwrap();
                    (200, json!({ "cert_pem": der_to_pem(&cert), "serial": "0A1B" }))
                }
                "/v1/admin/pending" => (200, json!({ "items": f.pending.lock().clone() })),
                "/v1/admin/devices" => (200, json!({ "devices": f.devices.lock().clone() })),
                "/v1/admin/approve" => {
                    let subject = approve_subject(b["kind"].as_str().unwrap(), b["id"].as_str().unwrap(), b["csr_sha256"].as_str().unwrap(), "approve");
                    let proof = crate::meet_json::b64_strict(b["proof"].as_str().unwrap()).unwrap();
                    assert!(verify_p256(&f.device_spki, &proof_bytes("approve", &subject, b["ts"].as_i64().unwrap()), &proof));
                    f.approved.lock().push(b.clone());
                    (200, json!({ "state": "approved" }))
                }
                "/v1/version" => (200, json!({ "files": { "windows": { "name": "LucidMeetingHub-0.98.7.msi" }, "macos": { "name": "LucidMeetingHub-0.98.7.dmg" } } })),
                _ => (404, json!({ "error": "unknown" })),
            })
        }
    }

    struct World {
        a: Arc<Accounts>,
        host: Arc<Recorder>,
        relay: Arc<FakeRelay>,
        clock: Arc<Mutex<f64>>,
        dir: PathBuf,
    }

    fn settings(ca_pem: &str) -> AccountSettings {
        AccountSettings {
            account_base: "https://lucidhubmeeting.emertins.com:8443".into(),
            account_proxy: "10.42.42.10".into(),
            relay_address: "10.42.42.10".into(),
            relay_port: 443,
            relay_name: "meet.emertins.com".into(),
            relay_cert_pem: String::new(),
            relay_ca_pem: ca_pem.into(),
            invite_server: "meet.emertins.com".into(),
            invite_port: 443,
            invite_address: "lucidhubmeeting.emertins.com".into(),
            auto_approve: vec!["enrique.mertins+appreview@gmail.com".into()],
            testflight: None,
            files_base: "https://lucidhubmeeting.emertins.com:8443".into(),
        }
    }

    fn world_with(name: &str, mail_on: bool, enabled: bool) -> World {
        let dir = crate::fleet_ca::tests_dir(name);
        let ca_key = Key::generate(Curve::P256).unwrap();
        let now_ms = crate::codec::now_ms();
        let ca_der = meet_test_ca(&ca_key, "Lucid Meet CA", None, now_ms - 86_400_000, now_ms + 1825 * 86_400_000);
        let device = Key::generate(Curve::P256).unwrap();
        let relay = Arc::new(FakeRelay { ca_key, ca_der: ca_der.clone(), device_spki: device.spki(), pending: Mutex::default(), devices: Mutex::default(), approved: Mutex::default(), calls: Mutex::default(), down: Mutex::new(false), relays: Mutex::new((200, Value::Null)) });
        let host = Arc::new(Recorder { mail_on, ..Recorder::default() });
        let clock = Arc::new(Mutex::new(crate::meet_json::now()));
        let c2 = clock.clone();
        let mut s = settings(&der_to_pem(&ca_der));
        if !enabled {
            s.account_base.clear();
        }
        let parts = Parts { settings: Some(s), relay: Some(Box::new(Shared(relay.clone()))), device_key: Some(device), testflight: None, files_secret: Some(vec![7u8; 32]) };
        let a = Arc::new(Accounts::new(&dir, parts, host.clone(), Arc::new(move || *c2.lock()), None));
        World { a, host, relay, clock, dir }
    }

    fn world(name: &str) -> World {
        world_with(name, true, true)
    }

    fn obj(v: Value) -> Obj {
        v.as_object().cloned().unwrap()
    }

    /// The token of the link an invite answer holds.
    fn token_of(answer: &Value) -> String {
        answer["link"].as_str().unwrap().split("#t=").nth(1).unwrap().to_owned()
    }

    fn invite(w: &World, name: &str, email: &str) -> Value {
        w.a.invite(&obj(json!({ "name": name, "email": email })), "admin@emertins.com").unwrap().0
    }

    fn join(w: &World, token: &str, username: &str, password: &str) -> Result<Value, Refusal> {
        w.a.join(&obj(json!({ "token": token, "username": username, "password": password })), "203.0.113.1")
    }

    fn signin(w: &World, who: &str, password: &str) -> Result<Value, Refusal> {
        w.a.signin(&obj(json!({ "username": who, "password": password, "platform": "computer", "label": "" })), "203.0.113.2")
    }

    /// Inflate a stream of stored blocks (the only kind `deflate_stored` writes).
    fn inflate_stored(mut d: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let head = d[0];
            assert_eq!(head & 0b110, 0, "BTYPE 00");
            let len = u16::from_le_bytes([d[1], d[2]]);
            assert_eq!(!len, u16::from_le_bytes([d[3], d[4]]), "NLEN");
            out.extend_from_slice(&d[5..5 + len as usize]);
            d = &d[5 + len as usize..];
            if head & 1 == 1 {
                assert!(d.is_empty());
                return out;
            }
        }
    }

    // ── Rules ───────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn username_and_password_rules() {
        assert_eq!(check_username(Some(&json!("  John.Lopez "))).unwrap(), "john.lopez");
        for bad in ["jo", "-john", "john lopez", "jöhn", &"a".repeat(33)] {
            assert_eq!(check_username(Some(&json!(bad))).unwrap_err().status, 400, "{bad}");
        }
        let ok = |p: &str| check_password(Some(&json!(p)), "john.lopez", "jlopez@example.com");
        assert!(ok("a long sentence I remember").is_ok());
        assert_eq!(ok("short").unwrap_err().message, "Choose a password of 12 to 256 characters.");
        assert_eq!(ok(&"x".repeat(257)).unwrap_err().status, 400);
        assert_eq!(ok("my John.Lopez secret").unwrap_err().message, "The password must not contain your username or your email address.");
        assert_eq!(ok("JLOPEZ forever and ever").unwrap_err().message, "The password must not contain your username or your email address.");
        assert_eq!(ok("Password1234").unwrap_err().message, "That password is too common. Choose another one.");
        assert_eq!(ok("zzzzzzzzzzzzzz").unwrap_err().message, "That password is too common. Choose another one.");
        assert_eq!(check_password(Some(&json!(5)), "u", "e@x.io").unwrap_err().status, 400);
        // NFKC: a fullwidth password is the same characters
        assert_eq!(ok("ｆｕｌｌｗｉｄｔｈ ｐａｓｓ").unwrap(), "fullwidth pass");
        assert!(email_ok("a.b+c@example.co") && !email_ok("a b@example.co") && !email_ok("a@b") && !email_ok("a@example.c0m"));
        assert!(address_ok("enrique.mertins+appreview@gmail.com") && !address_ok("a..b@x.io") && !address_ok("Name <a@x.io>"));
        assert_eq!(check_account_base("https://LucidHubMeeting.emertins.com:8443/").unwrap(), "https://lucidhubmeeting.emertins.com:8443");
        assert_eq!(check_account_base("https://x.example:443").unwrap(), "https://x.example");
        assert!(check_account_base("http://x.example").is_err() && check_account_base("https://x.example/meet").is_err());
        let taken = obj(json!({ "john.lopez": {} }));
        assert_eq!(username_suggestion("John.Lopez@example.com", &taken), "john.lopez2");
        assert_eq!(username_suggestion("a@example.com", &Obj::new()), "a00");
        assert_eq!(username_suggestion("jo hn@example.com", &Obj::new()), "jo.hn");
    }

    /// The stored format is Python's `hashlib.pbkdf2_hmac('sha256', ...)` with unpadded standard base64.
    #[test]
    fn hashes_match_python() {
        let salt: Vec<u8> = (0u8..16).collect();
        let mut want = [0u8; 32];
        pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(600_000).unwrap(), &salt, b"correct horse battery staple", &mut want);
        let expected = format!("pbkdf2-sha256$600000${}${}", b64_bare(&salt), b64_bare(&want));
        assert!(expected.starts_with("pbkdf2-sha256$600000$AAECAwQFBgcICQoLDA0ODw$"), "{expected}");
        assert!(!expected.contains('='));
        assert_eq!(hash_with("correct horse battery staple", &salt, NonZeroU32::new(600_000).unwrap()), expected);
        let pw = json!("correct horse battery staple");
        assert!(verify_password(Some(&pw), Some(&expected)));
        assert!(!verify_password(Some(&json!("correct horse battery stapler")), Some(&expected)));
        assert!(!verify_password(Some(&pw), None));
        assert!(!verify_password(Some(&pw), Some("pbkdf2-sha256$999$AAAA$AAAA")));
    }

    // ── LMJ1 ────────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn stored_deflate_vector_and_round_trip() {
        assert_eq!(deflate_stored(br#"{"a":1}"#), vec![0x01, 0x07, 0x00, 0xf8, 0xff, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]);
        assert_eq!(deflate_stored(b""), vec![0x01, 0x00, 0x00, 0xff, 0xff]);
        let big: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
        let packed = deflate_stored(&big);
        assert_eq!(packed[0], 0x00, "the first of three blocks is not final");
        assert_eq!(inflate_stored(&packed), big);
        let code = encode_code(&json!({ "a": 1, "name": "Zoë" }));
        let raw = inflate_stored(&unb64u(code.strip_prefix("LMJ1:").unwrap()).unwrap());
        assert_eq!(raw, br#"{"a":1,"name":"Zo\u00eb"}"#, "compact and ensure_ascii, as json.dumps writes it");
        assert_eq!(serde_json::from_slice::<Value>(&raw).unwrap(), json!({ "a": 1, "name": "Zoë" }));
    }

    // ── Invites, joins, resets ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn invite_lifecycle_single_use_expiry_and_reset() {
        let w = world("acct-invite");
        let out = invite(&w, "John  Lopez", "John@Example.com");
        assert_eq!(out["email"], "john@example.com");
        assert_eq!(out["name"], "John Lopez");
        assert_eq!(out["mail"], "sent");
        assert_eq!(out["org"], "lucidhubmeeting.emertins.com:8443");
        assert_eq!(out["testflight"]["status"], "off");
        assert_eq!(out["links"].as_array().unwrap().len(), 2);
        let token = token_of(&out);
        assert!(out["link"].as_str().unwrap().starts_with("https://lucidhubmeeting.emertins.com:8443/meet/join#t="));
        let body = out["email_draft"]["body"].as_str().unwrap();
        assert!(body.starts_with("Hi John,\n\nYou are invited to Lucid Meet."));
        assert!(body.lines().all(|l| l.chars().count() <= 76 || l.starts_with("https://")), "{body}");
        assert!(body.contains("\nhttps://lucidhubmeeting.emertins.com:8443/meet/signin\n"));
        assert_eq!(w.host.mails.lock().len(), 1);
        // only the hash is kept, and nothing of the link is audited
        let raw = std::fs::read_to_string(w.dir.join(STATE_FILE)).unwrap();
        assert!(!raw.contains(&token) && raw.contains(&sha256_hex(token.as_bytes())));
        let info = w.a.join_info(&obj(json!({ "token": token })), "203.0.113.1").unwrap();
        assert_eq!(info["username_suggestion"], "john");
        assert_eq!(info["reset"], false);
        assert!(info.get("ok").is_none(), "the Meet console's shape");
        assert_eq!(join(&w, &token, "john", "john1234567890").unwrap_err().status, 400);
        let done = join(&w, &token, "john", "a long sentence I remember").unwrap();
        assert_eq!(done, json!({ "ok": true, "username": "john", "name": "John Lopez", "email": "john@example.com", "org": "lucidhubmeeting.emertins.com:8443" }));
        // single use
        let again = join(&w, &token, "john2", "a long sentence I remember").unwrap_err();
        assert_eq!((again.status, again.message.as_str()), (404, "This link has expired or was already used. Ask your administrator for a new one."));
        // one account per email
        let e = w.a.invite(&obj(json!({ "name": "John", "email": "john@example.com" })), "admin@emertins.com").unwrap_err();
        assert_eq!(e.message, "john@example.com has a Lucid Meet account already (john). Use Reset password under Accounts if they forgot it.");
        // a reset keeps the username; the old password works until the new one is set
        let (r, target, _) = w.a.reset(&obj(json!({ "username": "John" })), "admin@emertins.com").unwrap();
        assert_eq!(target, "john");
        assert!(squash(r["email_draft"]["body"].as_str().unwrap()).contains("Your username stays john. The link works once, until"));
        let rt = token_of(&r);
        let info = w.a.join_info(&obj(json!({ "token": rt })), "203.0.113.1").unwrap();
        assert_eq!((info["username_suggestion"].as_str(), info["reset"].as_bool()), (Some("john"), Some(true)));
        let done = join(&w, &rt, "ignored", "another long sentence here").unwrap();
        assert_eq!(done["username"], "john");
        assert!(signin_password_ok(&w, "another long sentence here"));
        // expiry: an invite 7 days old is gone
        let later = invite(&w, "Ana Ruiz", "ana@example.com");
        *w.clock.lock() += 7.0 * DAY + 1.0;
        assert_eq!(join(&w, &token_of(&later), "ana", "a long sentence I remember").unwrap_err().status, 404);
        assert!(w.a.view().unwrap()["invites"].as_array().unwrap().is_empty());
        // a newer invite voids the older one for the same email
        let first = invite(&w, "Ana Ruiz", "ana@example.com");
        let second = invite(&w, "Ana Ruiz", "ana@example.com");
        assert_eq!(join(&w, &token_of(&first), "ana", "a long sentence I remember").unwrap_err().status, 404);
        assert!(join(&w, &token_of(&second), "ana", "a long sentence I remember").is_ok());
        let audits = w.host.audits.lock();
        assert!(audits.iter().any(|(actor, action, target, ..)| actor == "john" && action == "meet.account.join" && target == "john@example.com"));
        assert!(audits.iter().all(|a| !a.4.to_string().contains(&token)));
    }

    /// textwrap.wrap at 76 as the Meet console wrote the reset email.
    #[test]
    fn reset_email_matches_the_meet_console() {
        let base = "https://lucidhubmeeting.emertins.com:8443";
        let text = account_reset_text("John Lopez", "john", "https://h/meet/join#t=X", 0.0, base, "lucidhubmeeting.emertins.com:8443");
        let want = "Hi John,\n\n\
Open this link to set a new password for Lucid Meet. Your username stays\n\
john. The link works once, until 1970-01-01:\n\n\
https://h/meet/join#t=X\n\n\
Your old password stops working once you set the new one. If you did not ask\n\
for this, reply to this email.\n\n\n\
Open Lucid Meet, choose Sign in, enter organization\n\
lucidhubmeeting.emertins.com:8443, your username and password.\n\n\
If your Lucid Meet has no Sign in button yet: sign in at the address below\n\
and paste the code it shows into Lucid Meet (Join with an invite code).\n\n\
https://lucidhubmeeting.emertins.com:8443/meet/signin\n";
        assert_eq!(text, want);
    }

    fn signin_password_ok(w: &World, password: &str) -> bool {
        let stored = w.a.store.read(|d| Ok(table(d, "accounts")["john"]["pw"].as_str().unwrap().to_owned())).unwrap();
        verify_password(Some(&json!(password)), Some(&stored))
    }

    #[test]
    fn admin_writes_need_the_service_on() {
        let w = world_with("acct-off", false, false);
        assert_eq!(w.a.invite(&obj(json!({ "name": "A B", "email": "a@b.io" })), "x@y.io").unwrap_err(), refuse(409, ACCOUNT_OFF));
        // the public paths still answer the Meet console's closing 404, with its headers; nothing else is theirs
        for (method, target) in [("GET", "/meet/join"), ("GET", "/meet/static/account.js"), ("POST", "/meet/api/signin"), ("GET", "/meet/signin?x")] {
            let r = call(&w.a, method, target, None, b"{}").unwrap();
            assert_eq!((r.status, r.close, r.body.as_slice()), (404, true, br#"{"error": "Unknown path."}"#.as_slice()), "{method} {target}");
            assert!(r.headers.contains(&("Content-Security-Policy", CSP.into())));
        }
        assert!(call(&w.a, "GET", "/meet/other", None, b"").is_none());
        assert!(call(&w.a, "HEAD", "/meet/join", None, b"").is_none());
        let v = w.a.view().unwrap();
        assert_eq!((v["enabled"].as_bool(), v["base"].as_str(), v["org"].as_str()), (Some(false), Some(""), Some("")));
    }

    // ── Sign-in ─────────────────────────────────────────────────────────────────────────────────────────

    fn with_account(name: &str) -> World {
        let w = world(name);
        let out = invite(&w, "John Lopez", "john@example.com");
        join(&w, &token_of(&out), "john", "a long sentence I remember").unwrap();
        w
    }

    #[test]
    fn lockout_after_five_wrong_and_unknown_users_look_the_same() {
        let w = with_account("acct-lock");
        let unknown = signin(&w, "nobody", "a long sentence I remember").unwrap_err();
        let wrong = signin(&w, "john", "not the password at all").unwrap_err();
        assert_eq!((unknown.status, unknown.message.as_str()), (401, SIGNIN_WRONG));
        assert_eq!(unknown, wrong);
        for _ in 0..4 {
            assert_eq!(signin(&w, "john@example.com", "still not the password").unwrap_err().status, 401);
        }
        let locked = signin(&w, "john", "a long sentence I remember").unwrap_err();
        assert_eq!(locked.status, 423);
        assert_eq!(locked.retry_after, Some(901));
        assert_eq!(locked.message, "Too many wrong passwords: this account is locked for 16 minutes. Try again later.");
        let reply = public_error(&locked);
        assert!(reply.headers.contains(&("Retry-After", "901".into())));
        assert_eq!(serde_json::from_slice::<Value>(&reply.body).unwrap()["retry_after"], 901);
        let v = w.a.view().unwrap();
        assert_eq!(v["accounts"][0]["locked"], true);
        // an admin unlocks it
        w.a.unlock(&obj(json!({ "username": "john" }))).unwrap();
        assert!(signin(&w, "john", "a long sentence I remember").is_ok());
        assert_eq!(w.a.unlock(&obj(json!({ "username": "zed" }))).unwrap_err(), refuse(404, "No such account."));
    }

    #[test]
    fn signin_makes_a_v3_invite_through_the_relay() {
        let w = with_account("acct-signin");
        let out = w.a.signin(&obj(json!({ "username": "JOHN", "password": "a long sentence I remember", "platform": "iPhone", "label": "  My   phone " })), "203.0.113.2").unwrap();
        assert_eq!(out["approval"], "queue");
        assert_eq!(out["name"], "John Lopez");
        let code = out["code"].as_str().unwrap();
        let doc: Value = serde_json::from_slice(&inflate_stored(&unb64u(code.strip_prefix("LMJ1:").unwrap()).unwrap())).unwrap();
        let keys: Vec<&str> = doc.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["kind", "v", "name", "email", "relay", "origin", "seed_cert", "seed_key", "ca", "issued", "expires"]);
        assert_eq!(doc["relay"], json!({ "server": "meet.emertins.com", "port": 443, "address": "lucidhubmeeting.emertins.com" }));
        assert_eq!(doc["origin"], "issuer");
        assert_eq!(doc["expires"], out["expires"]);
        assert!(doc["expires"].as_str().unwrap().ends_with("+00:00"));
        let cert = Cert::from_der(&crate::meet_json::b64_strict(doc["seed_cert"].as_str().unwrap()).unwrap()).unwrap();
        let key = Key::from_pkcs8(Curve::P256, &crate::meet_json::b64_strict(doc["seed_key"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(cert.spki, key.spki(), "the seed key is the certificate's");
        assert_eq!(crate::meet_json::b64_strict(doc["ca"].as_str().unwrap()).unwrap(), w.relay.ca_der);
        let seeds = w.a.store.read(|d| Ok(table(d, "signin_seeds").clone())).unwrap();
        assert_eq!(seeds["a1b"]["username"], "john");
        assert_eq!(seeds["a1b"]["platform"], "iphone");
        assert_eq!(seeds["a1b"]["label"], "My phone");
        // the relay down: a 502 with the Meet console's sentence, nothing kept
        *w.relay.down.lock() = true;
        let e = signin(&w, "john", "a long sentence I remember").unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (502, "Your password is right, but Lucid Meet cannot set up a device right now. Try again in a few minutes."));
        assert_eq!(w.a.signin(&obj(json!({ "username": "john", "password": "x", "platform": "blackberry" })), "203.0.113.2").unwrap_err().message, "Choose Computer, iPhone or Android.");
    }

    #[test]
    fn android_signin_is_recorded_as_android() {
        let w = with_account("acct-signin-android");
        let out = w.a.signin(&obj(json!({ "username": "john", "password": "a long sentence I remember", "platform": "Android", "label": "" })), "203.0.113.2").unwrap();
        assert!(out["code"].as_str().unwrap().starts_with("LMJ1:"));
        let seeds = w.a.store.read(|d| Ok(table(d, "signin_seeds").clone())).unwrap();
        let seed = seeds.values().next().unwrap();
        assert_eq!(seed["platform"], "android");
        assert_eq!(seed["label"], "Android", "the approval queue names the device by its platform word");
        let audits = w.host.audits.lock();
        let signin = audits.iter().find(|a| a.1 == "meet.account.signin").unwrap();
        assert_eq!(signin.4["platform"], "android");
        assert!(!format!("{:?}", *audits).to_lowercase().contains("iphone"));
    }

    #[test]
    fn settings_refuse_to_turn_on_without_relay_values() {
        let on = |extra: Value| {
            let mut cfg = obj(json!({ "account_base": "https://hub.example.com:8443", "relay_name": "meet.example.com", "relay_address": "192.0.2.10", "invite_server": "meet.example.com" }));
            for (k, v) in obj(extra) {
                if v.is_null() {
                    cfg.remove(&k);
                } else {
                    cfg.insert(k, v);
                }
            }
            settings_of_old(&cfg, String::new(), String::new())
        };
        let s = on(json!({})).unwrap();
        assert_eq!((s.account_proxy.as_str(), s.invite_address.as_str(), s.files_base.as_str()), ("", "", ""));
        assert_eq!(s.console_email(), "console@meet.example.com");
        assert_eq!(on(json!({ "relay_name": null })).unwrap_err(), "Meet accounts (account_base) cannot be turned on: console.json has no relay_name. Set it to the Meet relay's name.");
        assert_eq!(on(json!({ "relay_address": null })).unwrap_err(), "Meet accounts (account_base) cannot be turned on: console.json has no relay_address. Set it to the Meet relay's address.");
        assert_eq!(
            on(json!({ "invite_server": null })).unwrap_err(),
            "Meet accounts (account_base) cannot be turned on: console.json has no invite_server. Set invite_server to the relay name the apps connect to."
        );
        assert_eq!(
            on(json!({ "account_base": null, "relay_name": null, "auto_approve": ["ana@example.com"] })).unwrap_err(),
            "auto approval (auto_approve) cannot be turned on: console.json has no relay_name. Set it to the Meet relay's name."
        );
        assert!(on(json!({ "auto_approve": ["console@meet.example.com"] })).is_err(), "the console's own address, derived from relay_name");
        // nothing on: nothing required
        let off = settings_of_old(&Obj::new(), String::new(), String::new()).unwrap();
        assert!(!off.enabled() && off.relay_name.is_empty() && off.console_email().is_empty());
    }

    #[test]
    fn signin_invite_carries_the_relays_verified_directory() {
        let w = with_account("acct-directory");
        let code_doc = |w: &World| -> Value {
            let out = signin(w, "john", "a long sentence I remember").unwrap();
            let code = out["code"].as_str().unwrap();
            serde_json::from_slice(&inflate_stored(&unb64u(code.strip_prefix("LMJ1:").unwrap()).unwrap())).unwrap()
        };
        let t = crate::meet_json::now() as i64;
        let z = |s: i64| iso_utc(s).replace("+00:00", "Z");
        let directory = json!({
            "v": 1, "typ": "lucid-meet-relay-directory", "cluster": "emertins-meet", "version": 3,
            "issued": z(t - 60), "expires": z(t + 365 * 86_400),
            "nodes": [{"id": "lab", "server": "meet.emertins.com", "port": 443, "region": "home", "priority": 10}]
        });
        let sig = w.relay.ca_key.sign(&crate::meet_relays::signed_bytes(&directory).unwrap()).unwrap();
        let wire = json!({ "directory": directory, "sig": crate::meet_json::b64(&sig) });
        *w.relay.relays.lock() = (200, wire.clone());
        let doc = code_doc(&w);
        assert_eq!((doc["v"].clone(), doc["directory"].clone()), (json!(3), wire.clone()));
        // a directory that does not verify, a relay without the route: the invite goes out without one
        let mut forged = wire;
        forged["directory"]["version"] = json!(4);
        *w.relay.relays.lock() = (200, forged);
        assert!(code_doc(&w).get("directory").is_none());
        *w.relay.relays.lock() = (404, Value::Null);
        assert!(code_doc(&w).get("directory").is_none());
    }

    #[test]
    fn the_rate_limit_counts_per_address() {
        let w = with_account("acct-rate");
        for _ in 0..ACCOUNT_LIMIT {
            assert_eq!(signin(&w, "nobody", "whatever whatever").unwrap_err().status, 401);
        }
        let e = signin(&w, "nobody", "whatever whatever").unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (429, LIMIT_WORDS));
        assert!(e.retry_after.is_some_and(|s| (1..=601).contains(&s)));
        assert!(w.a.join_info(&obj(json!({ "token": "x" })), "198.51.100.9").unwrap_err().status == 404, "another address has its own count");
    }

    // ── Approvals ───────────────────────────────────────────────────────────────────────────────────────

    fn item(kind: &str, id: &str, principal: &str) -> Value {
        json!({ "kind": kind, "id": id, "principal": principal, "device_label": "Laptop", "csr_sha256": "AB".repeat(32) })
    }

    #[test]
    fn auto_approve_picks_people_and_signins_under_their_device_cap() {
        let w = with_account("acct-auto");
        signin(&w, "john", "a long sentence I remember").unwrap();
        // queue mode: only the auto_approve people
        *w.relay.pending.lock() = vec![
            item("enroll", "1", "Enrique.Mertins+AppReview@gmail.com"),
            item("seed", "2", "enrique.mertins+appreview@gmail.com"),
            item("enroll", "a1b", "john@example.com"),
            item("renew", "3", "someone@example.com"),
            json!({ "kind": "other", "id": "4", "principal": "enrique.mertins+appreview@gmail.com" }),
        ];
        assert_eq!(w.a.auto_approve_once().unwrap(), 1);
        assert_eq!(w.relay.approved.lock()[0]["id"], "1");
        assert_eq!(w.relay.approved.lock()[0]["csr_sha256"], "ab".repeat(32));
        assert_eq!(w.relay.approved.lock()[0]["reason"], "approved by the console: auto_approve");
        // auto mode: the sign-in seed too, while john has fewer than 5 devices
        w.a.set_approval(&obj(json!({ "mode": "AUTO" }))).unwrap();
        w.relay.approved.lock().clear();
        *w.relay.devices.lock() = (0..4).map(|i| json!({ "principal": "john@example.com", "device": i })).chain([json!({ "principal": "john@example.com", "revoked": true }), json!({ "principal": "console@meet.emertins.com" })]).collect();
        assert_eq!(w.a.auto_approve_once().unwrap(), 2);
        let approved = w.relay.approved.lock().clone();
        assert_eq!(approved[1]["id"], "a1b");
        assert_eq!(approved[1]["reason"], ACCOUNT_REASON);
        let audits = w.host.audits.lock().clone();
        assert!(audits.iter().any(|(actor, action, target, result, d)| actor == ACCOUNT_BY && action == "meet.account.auto-approve" && target == "enroll:a1b" && result == "ok" && d["username"] == "john"));
        assert!(audits.iter().any(|(actor, _, target, ..)| actor == AUTO_APPROVE_BY && target == "enroll:1"));
        // five devices: an admin decides
        w.relay.approved.lock().clear();
        w.relay.devices.lock().push(json!({ "email": "JOHN@example.com" }));
        *w.relay.pending.lock() = vec![item("enroll", "a1b", "john@example.com")];
        assert_eq!(w.a.auto_approve_once().unwrap(), 0);
        // sign-in seeds are kept 2 days
        *w.clock.lock() += 2.0 * DAY + 1.0;
        assert_eq!(w.a.signin_seeds().unwrap().1.len(), 0);
        assert_eq!(w.a.store.read(|d| Ok(table(d, "signin_seeds").len())).unwrap(), 0);
    }

    #[test]
    fn nothing_is_asked_of_the_relay_when_nothing_could_be_approved() {
        let w = with_account("acct-idle");
        let w2 = World { a: Arc::new(Accounts::new(&w.dir, Parts { settings: Some(AccountSettings { auto_approve: Vec::new(), ..settings("") }), ..Parts::default() }, w.host.clone(), Arc::new(crate::meet_json::now), None)), ..w };
        let calls = w2.relay.calls.lock().len();
        assert_eq!(w2.a.auto_approve_once().unwrap(), 0);
        assert_eq!(w2.relay.calls.lock().len(), calls);
    }

    // ── The public paths ────────────────────────────────────────────────────────────────────────────────

    fn req<'a>(method: &'a str, target: &'a str, origin: Option<&'a str>, body: &'a [u8], length: &'a str) -> PublicRequest<'a> {
        PublicRequest { method, target, peer: "10.42.42.10".parse().unwrap(), forwarded: Some("198.51.100.7"), origin, content_type: Some("application/json"), content_length: Some(length), body }
    }

    /// A request through the gate, its Content-Length the body's.
    fn call(a: &Arc<Accounts>, method: &str, target: &str, origin: Option<&str>, body: &[u8]) -> Option<ConsoleReply> {
        let length = body.len().to_string();
        a.public(&req(method, target, origin, body, &length))
    }

    fn answer(r: &ConsoleReply) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    /// TH-1 4 to 6: the console's own brand copy, set through the admin routes (validated, `by` from the console),
    /// served beside the account pages with their headers: `{"brand": null}` without one, never `by` or `updated`,
    /// the logo with its stored type and nosniff, long-cached only for the current `?v=`, 404 without one.
    #[test]
    fn console_accounts_brand_copy_serves_the_account_pages() {
        let w = world("acct-brand");
        let a = &w.a;
        let get = |target: &str| call(a, "GET", target, None, b"").unwrap();
        let spec = |m: &str, p: &str| ROUTES.iter().find(|r| r.method == m && r.path == p).unwrap();
        let admin = "admin@emertins.com";
        let none = get("/meet/api/brand");
        assert_eq!((none.status, answer(&none)), (200, json!({ "brand": null })));
        assert!(none.content_type.starts_with("application/json"));
        assert!(none.headers.contains(&("Cache-Control", "no-cache".into())) && none.headers.contains(&("Content-Security-Policy", CSP.into())));
        let no_logo = get("/meet/brand/logo");
        assert_eq!((no_logo.status, answer(&no_logo)["error"].as_str()), (404, Some("this organization has no logo")));
        // refused whole: an unknown key, a weak accent, no reason
        for body in [json!({ "name": "Contoso", "accent": "#0f6cbd", "reason": "r", "css": "x" }), json!({ "name": "Contoso", "accent": "#777777", "reason": "r" }), json!({ "name": "Contoso", "accent": "#0f6cbd" })] {
            assert_eq!(a.admin_route(spec("POST", "meet/accounts/brand"), &body, admin, 5).err().unwrap().code, "invalid", "{body}");
        }
        let set = json!({ "name": "Contoso", "accent": "#0f6cbd", "welcome": "Welcome.", "reason": "brand" });
        let done = a.admin_route(spec("POST", "meet/accounts/brand"), &set, admin, 5).unwrap();
        assert_eq!((done.out.body["brand"]["by"].as_str(), done.out.body["brand"]["updated"].as_i64()), (Some(admin), Some(5)));
        let png = crate::meet_brand::tests::png(64, 64);
        let logo = json!({ "type": "image/png", "data": crate::meet_json::b64(&png) });
        a.admin_route(spec("POST", "meet/accounts/brand/logo"), &logo, admin, 6).unwrap();
        let read = answer(&get("/meet/api/brand"));
        assert_eq!((read["brand"]["name"].as_str(), read["brand"]["onAccent"].as_str(), read["brand"]["support"].clone()), (Some("Contoso"), Some("#ffffff"), Value::Null));
        assert!(!read.to_string().contains(admin) && !read.to_string().contains("updated"));
        let path = read["brand"]["logo"].as_str().unwrap().to_owned();
        assert!(path.starts_with("/meet/brand/logo?v="), "{path}");
        let image = get(&path);
        assert_eq!((image.status, image.content_type, image.body.as_slice()), (200, "image/png", png.as_slice()));
        assert!(image.headers.contains(&("Cache-Control", "public, max-age=86400".into())) && image.headers.contains(&("X-Content-Type-Options", "nosniff".into())));
        assert!(get("/meet/brand/logo?v=000000000000").headers.contains(&("Cache-Control", "no-cache".into())));
        assert_eq!(get("/meet/api/brand?x=1").status, 404);
        let view = a.admin_route(spec("GET", "meet/accounts/brand"), &Value::Null, admin, 7).unwrap();
        assert_eq!(view.out.body["brand"]["logo"]["w"].as_u64(), Some(64));
        a.admin_route(spec("POST", "meet/accounts/brand/reset"), &json!({ "reason": "back" }), admin, 8).unwrap();
        assert_eq!(answer(&get("/meet/api/brand")), json!({ "brand": null }));
        assert_eq!(get("/meet/brand/logo").status, 404);
        // with password sign-in off the pages are not served, and neither is their brand
        let off = world_with("acct-brand-off", true, false);
        assert_eq!(call(&off.a, "GET", "/meet/api/brand", None, b"").unwrap().status, 404);
    }

    #[test]
    fn public_paths_are_exact() {
        let w = world("acct-gate");
        let a = &w.a;
        let page = call(a, "GET", "/meet/join", None, b"").unwrap();
        assert_eq!((page.status, page.content_type, page.body.as_slice()), (200, "text/html; charset=utf-8", HTML));
        assert!(page.headers.contains(&("Content-Security-Policy", CSP.into())) && page.headers.contains(&("Cache-Control", "no-cache".into())));
        assert_eq!(call(a, "GET", "/meet/signin", None, b"").unwrap().body, HTML);
        assert_eq!(call(a, "GET", "/meet/static/account.css", None, b"").unwrap().content_type, "text/css; charset=utf-8");
        assert_eq!(call(a, "GET", "/meet/static/account.js", None, b"").unwrap().content_type, "text/javascript; charset=utf-8");
        for (method, target, status) in [("GET", "/meet/join?x=1", 404), ("GET", "/meet/api/signin", 404), ("POST", "/meet/join", 404), ("GET", "/meet/static/app.js", 404), ("HEAD", "/meet/join", 405), ("PUT", "/meet/api/join", 405), ("POST", "/meet/api/join?x", 404)] {
            let r = call(a, method, target, None, b"").unwrap();
            assert_eq!(r.status, status, "{method} {target}");
            assert!(r.close);
            assert_eq!(answer(&r)["error"], if status == 404 { "Unknown path." } else { "Method not allowed." });
        }
        assert!(call(a, "GET", "/console/", None, b"").is_none());
        assert!(call(a, "GET", "/meetx", None, b"").is_none());
        let refused = call(a, "POST", "/meet/api/signin", Some("https://evil.example"), b"{}").unwrap();
        assert_eq!((refused.status, answer(&refused)["error"].as_str()), (403, Some("Refused: this request did not come from the Lucid Meet sign-in page.")));
        let base = "https://lucidhubmeeting.emertins.com:8443";
        let mut r = req("POST", "/meet/api/join/info", Some(base), b"{}", "2");
        r.content_type = Some("text/plain");
        assert_eq!(a.public(&r).unwrap().status, 415);
        let big = vec![b' '; 5000];
        let too = a.public(&req("POST", "/meet/api/join/info", None, &big, "5000")).unwrap();
        assert_eq!((too.status, too.close, answer(&too)["error"].as_str()), (413, true, Some("Request too large.")));
        assert_eq!(answer(&a.public(&req("POST", "/meet/api/join/info", None, b"{}", "x")).unwrap())["error"], "Bad Content-Length.");
        assert_eq!(answer(&call(a, "POST", "/meet/api/join/info", None, b"[1]").unwrap())["error"], "The body must be a JSON object.");
        assert_eq!(answer(&call(a, "POST", "/meet/api/join/info", None, b"{").unwrap())["error"], "The body must be JSON.");
        let gone = call(a, "POST", "/meet/api/join/info", Some(base), br#"{"token": "x"}"#).unwrap();
        assert_eq!((gone.status, gone.close), (404, false));
        // json.dumps' separators, as the Meet console wrote its answers
        assert_eq!(gone.body, br#"{"error": "This link has expired or was already used. Ask your administrator for a new one."}"#);
        assert!(gone.headers.contains(&("Cache-Control", "no-store".into())));
    }

    #[test]
    fn the_proxy_names_the_client() {
        let w = world("acct-proxy");
        let proxy: IpAddr = "10.42.42.10".parse().unwrap();
        assert_eq!(w.a.account_source(proxy, Some("203.0.113.9, 198.51.100.7")), "198.51.100.7");
        assert_eq!(w.a.account_source(proxy, Some("not an address")), "10.42.42.10");
        assert_eq!(w.a.account_source(proxy, None), "10.42.42.10");
        assert_eq!(w.a.account_source("192.0.2.4".parse().unwrap(), Some("198.51.100.7")), "192.0.2.4", "only the proxy is believed");
        assert_eq!(w.a.account_source("::ffff:10.42.42.10".parse().unwrap(), Some("198.51.100.7")), "198.51.100.7");
        assert!(w.a.is_proxy(proxy) && w.a.is_proxy("::ffff:10.42.42.10".parse().unwrap()) && !w.a.is_proxy("10.42.42.11".parse().unwrap()));
        let off = world_with("acct-proxy-off", true, false);
        assert!(off.a.is_proxy(proxy), "the gate stays public-only while password sign-in is off");
        let none = Arc::new(Accounts::new(&off.dir, Parts::default(), off.host.clone(), Arc::new(crate::meet_json::now), None));
        assert!(!none.is_proxy(proxy), "nothing imported, no gate");
    }

    /// A connection from the gate (even one inside the console's networks) gets the public paths and nothing else.
    #[test]
    fn the_proxy_reaches_only_the_public_paths() {
        for (name, enabled) in [("acct-front", true), ("acct-front-off", false)] {
            let w = world_with(name, true, enabled);
            let front = |target: &str, public_only: bool| {
                let r = req("GET", target, None, b"", "0");
                w.a.front(&r, public_only)
            };
            for target in ["/console/", "/console/api/me", "/metrics", "/meet/other", "/"] {
                if target == "/meet/other" && enabled {
                    assert_eq!(front(target, true).unwrap().status, 404, "{target}");
                    continue;
                }
                let r = front(target, true).unwrap();
                assert_eq!((r.status, r.close), (403, true), "{target}");
                assert_eq!(answer(&r)["error"], crate::console::SOURCE_REFUSED);
                assert!(front(target, false).is_none_or(|r| r.status == 404), "another peer goes on to the console: {target}");
            }
            assert_eq!(front("/meet/join", true).unwrap().status, if enabled { 200 } else { 404 });
        }
    }

    #[test]
    fn mail_unset_leaves_the_text_to_send_by_hand() {
        let w = world_with("acct-nomail", false, true);
        let out = invite(&w, "Ana Ruiz", "ana@example.com");
        assert_eq!((out["mail"].as_str(), out["emailed"].as_bool()), (Some("unset"), Some(false)));
        assert_eq!(out["email_draft"]["subject"], ACCOUNT_INVITE_SUBJECT);
        assert!(w.host.mails.lock().is_empty());
    }

    // ── TestFlight ──────────────────────────────────────────────────────────────────────────────────────

    struct FakeAsc {
        seen: Arc<Mutex<Vec<(String, String, Vec<(String, String)>)>>>,
        first: u16,
    }

    impl AscTransport for FakeAsc {
        fn send(&self, method: &str, path: &str, headers: &[(&str, String)], _body: &[u8]) -> Result<(u16, Vec<u8>), String> {
            self.seen.lock().push((method.into(), path.into(), headers.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()));
            Ok(match (method, path.split('?').next().unwrap_or("")) {
                ("POST", "/v1/betaTesters") => (self.first, b"{}".to_vec()),
                ("GET", _) => (200, br#"{"data":[{"id":"T1"}]}"#.to_vec()),
                _ => (204, Vec::new()),
            })
        }
    }

    #[test]
    fn testflight_token_and_conflict() {
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        let p8 = pem("PRIVATE KEY", doc.as_ref());
        let ids = TestFlightIds { key_id: "ABCDE12345".into(), issuer_id: "00000000-0000-0000-0000-000000000000".into(), group_id: "11111111-1111-1111-1111-111111111111".into() };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tf = TestFlight::new(ids.clone(), p8.as_bytes(), Box::new(FakeAsc { seen: seen.clone(), first: 201 }));
        assert_eq!(tf.add("ana@example.com", "Ana", "Ruiz", 1_800_000_000).unwrap(), "added");
        let auth = seen.lock()[0].2.iter().find(|(k, _)| k == "Authorization").unwrap().1.clone();
        let jwt = auth.strip_prefix("Bearer ").unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(serde_json::from_slice::<Value>(&unb64u(parts[0]).unwrap()).unwrap(), json!({ "alg": "ES256", "kid": "ABCDE12345", "typ": "JWT" }));
        let claims: Value = serde_json::from_slice(&unb64u(parts[1]).unwrap()).unwrap();
        assert_eq!(claims, json!({ "iss": ids.issuer_id, "iat": 1_800_000_000, "exp": 1_800_001_200, "aud": "appstoreconnect-v1" }));
        let sig = unb64u(parts[2]).unwrap();
        assert_eq!(sig.len(), 64, "JOSE r||s");
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref()).unwrap();
        use aws_lc_rs::signature::KeyPair;
        assert!(aws_lc_rs::signature::UnparsedPublicKey::new(&aws_lc_rs::signature::ECDSA_P256_SHA256_FIXED, pair.public_key().as_ref()).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok());
        let seen2 = Arc::new(Mutex::new(Vec::new()));
        let tf = TestFlight::new(ids, p8.as_bytes(), Box::new(FakeAsc { seen: seen2.clone(), first: 409 }));
        assert_eq!(tf.add("a+b@example.com", "A", "", 1_800_000_000).unwrap(), "exists");
        let paths: Vec<String> = seen2.lock().iter().map(|(m, p, _)| format!("{m} {p}")).collect();
        assert_eq!(paths, ["POST /v1/betaTesters", "GET /v1/betaTesters?filter%5Bemail%5D=a%2Bb%40example.com&limit=1", "POST /v1/betaGroups/11111111-1111-1111-1111-111111111111/relationships/betaTesters"]);
    }

    // ── Import ──────────────────────────────────────────────────────────────────────────────────────────

    #[derive(Default)]
    struct MemSink(HashMap<String, Vec<u8>>);

    impl SecretSink for MemSink {
        fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
            self.0.insert(name.to_owned(), value.to_vec());
            Ok(())
        }
    }

    #[test]
    fn import_from_the_meet_console() {
        let dir = crate::fleet_ca::tests_dir("acct-import");
        let old = dir.join("old");
        std::fs::create_dir_all(&old).unwrap();
        let ca_key = Key::generate(Curve::P256).unwrap();
        let now_ms = crate::codec::now_ms();
        let ca_der = meet_test_ca(&ca_key, "Lucid Meet CA", None, now_ms - 86_400_000, now_ms + 86_400_000 * 1000);
        let device = Key::generate(Curve::P256).unwrap();
        let spec = MeetSpec { profile: &MeetProfile::SignerClient, serial: &[5], not_before_ms: now_ms - 1000, not_after_ms: now_ms + 86_400_000, spki: &device.spki(), ca_der: &ca_der };
        let cert = meet_issue(&spec, &ca_key).unwrap();
        std::fs::write(old.join("relay-client.crt"), der_to_pem(&cert)).unwrap();
        std::fs::write(old.join("relay-client.key"), pem("PRIVATE KEY", device.pkcs8())).unwrap();
        std::fs::write(old.join("ca.crt"), der_to_pem(&ca_der)).unwrap();
        std::fs::write(old.join("files.secret"), crate::meet_json::b64(&[3u8; 32])).unwrap();
        let config = json!({
            "relay_address": "10.42.42.10", "relay_port": 443, "relay_name": "meet.emertins.com",
            "relay_cert": "/etc/lucid-meet-console/relay-client.crt", "invite_server": "meet.emertins.com", "invite_port": 443,
            "invite_address": "lucidhubmeeting.emertins.com", "account_base": "https://lucidhubmeeting.emertins.com:8443",
            "account_proxy": "10.42.42.10", "auto_approve": ["enrique.mertins+appreview@gmail.com"], "sources": ["10.0.0.0/8"],
        });
        std::fs::write(old.join("console.json"), config.to_string()).unwrap();
        let state = json!({
            "users": { "admin@emertins.com": {} },
            "accounts": { "john": { "username": "john", "email": "john@example.com", "name": "John Lopez", "pw": "pbkdf2-sha256$600000$AAECAwQFBgcICQoLDA0ODw$x", "created": 1764000000.25, "by": "admin@emertins.com", "last_signin": 0, "failures": 0, "locked_until": 0 } },
            "account_invites": { "ab": { "name": "Ana", "email": "ana@example.com", "created": 1764000000.5, "expires": 1764604800.5, "by": "admin@emertins.com", "reset": false } },
            "signin_seeds": {}, "account_approval": "auto",
        });
        std::fs::write(old.join("state.json"), state.to_string()).unwrap();
        let files = ImportFiles {
            old_state: old.join("state.json"),
            old_config: old.join("console.json"),
            relay_cert: old.join("relay-client.crt"),
            relay_key: old.join("relay-client.key"),
            relay_ca: old.join("ca.crt"),
            asc_key: None,
            files_secret: Some(old.join("files.secret")),
            replace: false,
        };
        let mut book = crate::console_auth::Book::default();
        let mut sink = MemSink::default();
        let summary = import_into(&dir, &files, &mut book, &mut sink, now_ms).unwrap();
        assert!(summary.contains("imported 1 accounts, 1 invites and 0 sign-in seeds; approval auto"), "{summary}");
        assert!(!summary.contains("PRIVATE") && !summary.contains("pbkdf2"));
        assert_eq!(sink.0[SECRET_FILES], vec![3u8; 32]);
        assert!(device_key_of(&String::from_utf8(sink.0[SECRET_DEVICE_KEY].clone()).unwrap()).is_some_and(|k| k.spki() == device.spki()));
        let s = AccountSettings::from_value(&book.settings.meet_accounts).unwrap();
        assert_eq!((s.account_base.as_str(), s.org().as_str(), s.invite_address.as_str()), ("https://lucidhubmeeting.emertins.com:8443", "lucidhubmeeting.emertins.com:8443", "lucidhubmeeting.emertins.com"));
        assert_eq!(s.files_base, "", "no lab download address by default");
        assert!(summary.contains("download links: off (no files_base)"), "{summary}");
        assert_eq!(book.pending_audit[0]["action"], "meet.account.import");
        let d: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(d["accounts"]["john"]["created"], 1764000000.25);
        assert_eq!(d["account_approval"], "auto");
        assert!(d.get("users").is_none(), "only the account keys move");
        // settings round-trip through console.json
        let back = crate::console_settings::Settings::from_value(&book.settings.to_value()).unwrap();
        assert_eq!(back.meet_accounts, book.settings.meet_accounts);
        // any file there, even one that does not read, is refused without --replace, before anything is sealed
        for existing in ["not json", "{}"] {
            std::fs::write(dir.join(STATE_FILE), existing).unwrap();
            let mut fresh = MemSink::default();
            assert!(import_into(&dir, &files, &mut book, &mut fresh, now_ms).unwrap_err().contains("--replace"));
            assert!(fresh.0.is_empty());
            assert_eq!(std::fs::read_to_string(dir.join(STATE_FILE)).unwrap(), existing);
        }
        // TestFlight on in console.json needs the key
        let mut cfg2 = config.clone();
        cfg2["testflight"] = json!({ "key_id": "ABCDE12345", "issuer_id": "00000000-0000-0000-0000-000000000000", "group_id": "11111111-1111-1111-1111-111111111111", "key_file": "/etc/x/asc.p8" });
        std::fs::write(old.join("console.json"), cfg2.to_string()).unwrap();
        let replace = ImportFiles { replace: true, ..files };
        assert!(import_into(&dir, &replace, &mut book, &mut sink, now_ms).unwrap_err().contains("--asc-key"));
    }
}
