// The fleet console's first run and setup wizard (contract AC-2a 12.1 to 12.3): the setup code drawn at each start
// while the console is not bootstrapped (`setup-code.txt`, owner-only, never logged, audited or shown), `setup/start`
// with its tries, the profile and the first-admin pin, the routes that answer before bootstrap, and the four steps
// kept on the server after it (`console.json` `setup`), with the "Finish setup" checklist.

use crate::codec::str_of;
use crate::console::{ApiError, Console, Done, Out, Role, RouteSpec};
use crate::console_audit::Record;
use crate::console_auth::{email_of, random_bytes, Who};
use crate::console_settings::{Profile, StepState, SETUP_STEPS};
use crate::log::{Fields, Level};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;

pub const SETUP_CODE_FILE: &str = "setup-code.txt";
/// 13.4 `cli.setup-code-file`.
pub const SETUP_CODE_WORDS: &str = "Setup code for the Lucid Admin Console. Enter it on the first page. It changes at every start until setup is done.";
/// Wrong codes from one source in SOURCE_WINDOW_MS, and in all before a new code is drawn (12.1).
pub const TRIES_PER_SOURCE: usize = 5;
pub const SOURCE_WINDOW_MS: i64 = 15 * 60_000;
pub const TRIES_ALL: u32 = 20;

/// The routes that answer before bootstrap on a fleet console (5.3): the banner, setup, the AC-1 join and register
/// routes. The page's files are served before any route is looked at.
pub const BEFORE_BOOTSTRAP: [&str; 9] = ["banner", "setup", "setup/start", "join", "register/begin", "register/finish", "join/password", "join/totp/begin", "join/totp/finish"];

/// The wizard's routes (fleet console only).
pub static WIZARD_ROUTES: [RouteSpec; 4] = [
    RouteSpec { method: "GET", path: "setup", role: Role::None, action: "", target: "-", stepup: false, need: crate::console::Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "setup/start", role: Role::None, action: "setup.start", target: "-", stepup: false, need: crate::console::Need::Any, security: false, keys: &["code", "profile", "email"], body_max: 4096 },
    RouteSpec { method: "POST", path: "setup/step", role: Role::Admin, action: "setup.step", target: "step", stepup: false, need: crate::console::Need::Any, security: false, keys: &["step", "state"], body_max: 1024 },
    RouteSpec { method: "POST", path: "setup/hide", role: Role::Admin, action: "setup.hide", target: "-", stepup: false, need: crate::console::Need::Any, security: false, keys: &[], body_max: 1024 },
];

/// The setup code of this start and its wrong tries (memory only; the file holds the code for the operator).
#[derive(Debug, Default)]
pub struct SetupCode {
    /// 32 base32 characters (20 random bytes), compared without spaces or hyphens, upper case.
    code: String,
    fails_by_source: HashMap<String, VecDeque<i64>>,
    fails: u32,
}

/// RFC 4648 base32 without padding.
fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for b in bytes {
        buf = (buf << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// A code as the page shows it: 4 groups of 8.
pub fn grouped(code: &str) -> String {
    code.as_bytes().chunks(8).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

/// Typed text as compared: spaces and hyphens removed, upper case.
fn normalized(typed: &str) -> String {
    typed.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase()
}

impl SetupCode {
    fn draw() -> Result<SetupCode, ApiError> {
        Ok(SetupCode { code: base32(&random_bytes(20)?), ..SetupCode::default() })
    }

    #[cfg(test)]
    pub fn code(&self) -> &str {
        &self.code
    }

    fn matches(&self, typed: &str) -> bool {
        let t = normalized(typed);
        crate::console_webauthn::same_bytes(t.as_bytes(), self.code.as_bytes())
    }
}

impl Console {
    /// The setup code's file in the state folder.
    pub(crate) fn setup_code_path(&self) -> PathBuf {
        self.cfg.state_dir.join(SETUP_CODE_FILE)
    }

    /// 12.1 at each start (and after 20 wrong tries): a new setup code in `setup-code.txt` (owner-only) and in
    /// memory; every older code and every setup join token is void. Only where it is gets logged. Nothing when the
    /// console is bootstrapped (the file is removed then).
    pub(crate) fn draw_setup_code(&self, why: &str, t: i64) -> Result<(), String> {
        let path = self.setup_code_path();
        let mut inner = self.inner.lock();
        if inner.unreadable {
            return Ok(());
        }
        if inner.book.bootstrapped {
            inner.setup = None;
            drop(inner);
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        let code = SetupCode::draw().map_err(|e| e.message)?;
        crate::store::write_private(&path, format!("{SETUP_CODE_WORDS}\n{}\n", grouped(&code.code)).as_bytes()).map_err(|e| format!("{} could not be written: {e}", path.display()))?;
        inner.setup = Some(code);
        if self.void_setup_invites(&mut inner) {
            let _ = self.save_book(&mut inner);
        }
        drop(inner);
        self.logger.ops("console.setup-code", &Fields::new().with("path", path.display().to_string()), Level::Info);
        let mut r = Record::new("console", "setup.code", "ok");
        r.detail = json!({ "why": why });
        self.record(r, t);
        Ok(())
    }

    /// Whether a fleet console is still before bootstrap (only the setup and join routes answer, 5.3).
    pub(crate) fn before_bootstrap(&self) -> bool {
        !self.inner.lock().book.bootstrapped
    }

    /// GET setup: `{ok, bootstrapped, profileFixed, pinned, steps}`; signed-in admins get `steps`.
    pub(crate) fn setup_view(&self, who: Option<&Who>) -> Out {
        let inner = self.inner.lock();
        let steps = if who.is_some_and(|w| w.admin) && inner.book.bootstrapped { inner.book.setup.steps_value() } else { Value::Null };
        Out::ok(json!({
            "ok": true, "bootstrapped": inner.book.bootstrapped, "profileFixed": self.cfg.profile.map(Profile::as_str),
            "pinned": self.cfg.first_admin.is_some(), "steps": steps, "hidden": inner.book.setup.hidden,
        }))
    }

    /// POST setup/start {code, profile, email} (12.1), under the console's lock: tries first, then the code, the
    /// bootstrap state, the pin and the profile; then the profile is written, the email pinned, the code consumed
    /// and the first admin's join token minted.
    pub(crate) fn setup_start(&self, source: &str, body: &Value, t: i64) -> Result<Done, ApiError> {
        let typed = str_of(body.get("code")).unwrap_or("");
        let mut inner = self.inner.lock();
        if inner.book.bootstrapped {
            return Err(ApiError::of("setup-done"));
        }
        let Some(code) = inner.setup.as_mut() else { return Err(ApiError::of("setup-code")) };
        let right = code.matches(typed);
        let fails = code.fails_by_source.entry(source.to_owned()).or_default();
        while fails.front().is_some_and(|at| t - *at >= SOURCE_WINDOW_MS) {
            fails.pop_front();
        }
        if fails.len() >= TRIES_PER_SOURCE {
            let wait = fails.front().map_or(SOURCE_WINDOW_MS, |at| SOURCE_WINDOW_MS - (t - at));
            let mut e = ApiError::of("signin-wait");
            e.retry_after = Some((wait / 1000).max(1));
            return Err(e);
        }
        if !right {
            fails.push_back(t);
            code.fails += 1;
            let redraw = code.fails >= TRIES_ALL;
            drop(inner);
            self.logger.security("console.setup-refused", &Fields::new().with("source", source).with("why", "setup code"), Level::Warn);
            if redraw {
                if let Err(e) = self.draw_setup_code("tries", t) {
                    self.logger.ops("console.write-failed", &Fields::new().with("reason", e), Level::Error);
                }
            }
            return Err(ApiError::of("setup-code"));
        }
        let email = email_of(str_of(body.get("email"))).ok_or_else(|| ApiError::with("invalid", "Give your email."))?;
        if let Some(pin) = self.cfg.first_admin.as_ref() {
            if *pin != email {
                return Err(ApiError::with("bootstrap-pinned", "This console waits for its first admin."));
            }
        }
        let profile = match (self.cfg.profile, str_of(body.get("profile")).and_then(Profile::parse)) {
            (Some(fixed), Some(p)) if p != fixed => return Err(ApiError::with("invalid", format!("This console was started with the {} profile by its operator.", fixed.as_str()))),
            (Some(fixed), _) => fixed,
            (None, Some(p)) => p,
            (None, None) => return Err(ApiError::with("invalid", "profile is high or standard.")),
        };
        inner.book.settings.profile = profile;
        inner.book.settings.downgraded = false;
        inner.book.first_admin = Some(email.clone());
        inner.setup = None;
        let (token, expires) = self.mint_setup_invite(&mut inner, &email, t)?;
        self.save_book(&mut inner)?;
        drop(inner);
        let _ = std::fs::remove_file(self.setup_code_path());
        // Actor the email given (7.1): no session exists yet, so the entry is written here, not by the dispatcher.
        let mut r = Record::new(&email, "setup.start", "ok");
        r.target = Some(email.clone());
        r.detail = json!({ "profile": profile.as_str(), "pinned": self.cfg.first_admin.is_some() });
        self.record(r, t);
        Ok(Done::plain(Out::ok(json!({ "ok": true, "join": token, "expires": expires }))))
    }

    /// POST setup/step {step, state}.
    pub(crate) fn setup_step(&self, params: &Value) -> Result<Done, ApiError> {
        let step = str_of(params.get("step")).filter(|s| SETUP_STEPS.contains(s)).ok_or_else(|| ApiError::with("invalid", "step is signin, email, license or relay."))?.to_owned();
        let state = str_of(params.get("state")).and_then(StepState::parse).ok_or_else(|| ApiError::with("invalid", "state is done, skipped or open."))?;
        let mut inner = self.inner.lock();
        inner.book.setup.set(&step, state);
        self.save_book(&mut inner)?;
        let steps = inner.book.setup.steps_value();
        Ok(Done::ok(Out::ok(json!({ "ok": true, "steps": steps })), Some(step.clone()), json!({ "step": step, "state": state.as_str() })))
    }

    /// POST setup/hide {}.
    pub(crate) fn setup_hide(&self) -> Result<Done, ApiError> {
        let mut inner = self.inner.lock();
        inner.book.setup.hidden = true;
        self.save_book(&mut inner)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), json!({})))
    }

    /// A step done by its own success (12.3): a saved sign-in setting, a verified email, a library license, an
    /// enrolled relay. Fleet consoles only; nothing when already done.
    pub(crate) fn setup_done(&self, step: &str) {
        if !self.is_fleet() {
            return;
        }
        let mut inner = self.inner.lock();
        if inner.book.setup.done(step) {
            let _ = self.save_book(&mut inner);
        }
    }

    /// The `setup-unfinished` item (12.3), for admins.
    pub(crate) fn setup_attention(&self) -> Option<Value> {
        let inner = self.inner.lock();
        (inner.book.bootstrapped && inner.book.setup.unfinished()).then(|| json!({ "kind": "setup-unfinished", "severity": "info", "args": {}, "go": "#/setup" }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_is_rfc4648_without_padding() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        let code = base32(&[0xa5; 20]);
        assert_eq!(code.len(), 32);
        assert_eq!(grouped(&code).split(' ').count(), 4);
        assert!(grouped(&code).split(' ').all(|g| g.len() == 8));
    }

    #[test]
    fn typed_codes_are_compared_without_spaces_hyphens_or_case() {
        let c = SetupCode { code: "ABCDEFGH23456712ABCDEFGH23456712".into(), ..SetupCode::default() };
        assert!(c.matches("abcdefgh 23456712-ABCDEFGH 23456712"));
        assert!(!c.matches("ABCDEFGH23456712ABCDEFGH2345671"));
        assert!(!c.matches(""));
    }

    #[test]
    fn the_words_carry_no_long_dashes() {
        assert!(!SETUP_CODE_WORDS.contains('\u{2014}') && !SETUP_CODE_WORDS.contains('\u{2013}'));
    }
}
